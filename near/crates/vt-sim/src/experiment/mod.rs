//! Phase 5: experiments and the balance report.
//!
//! `vt-sim run <experiment.json> [--out DIR] [--fresh]` runs the configured
//! stages in order; `vt-sim report DIR` (also run at the end) renders
//! `DIR/report.md` from whatever stages have finished.
//!
//! Everything is written as it goes and a stopped run resumes where it left
//! off. A stage is a list of independent units (one scenario, one node
//! attempt, one run...), each seeded only by (experiment seed, stage, unit
//! index), so a unit's result never depends on when or in what order it was
//! computed. Finished units are appended to `DIR/<stage>.units.jsonl` in
//! chunks; on resume, units already there are skipped (a half-written last
//! line is trimmed). The economy stage uses the economy's own checkpoints.
//! When a stage's units are all done its aggregate is written to
//! `DIR/<stage>.json`, which is what the report reads.

pub mod report;
pub mod stages;
pub mod stats;

use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};

use rayon::prelude::*;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EconomyStage {
    pub days: u32,
    pub players_per_archetype: usize,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MatrixStage {
    /// Paired scenarios (2 games, sides swapped) per archetype pair.
    pub scenarios_per_pair: u32,
    pub brackets: Vec<u64>,
}

/// One assumption about how far apart players' tactics skill is.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct GapVariant {
    pub name: String,
    /// Poor's noise dial (None = calibrated value).
    pub poor_noise: Option<f32>,
    /// Excellent's leaf look-ahead (None = calibrated value).
    pub excellent_plies: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct FactorialStage {
    pub scenarios: u32,
    pub variants: Vec<GapVariant>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PveStage {
    pub pools_per_node: u32,
    pub pool_size: usize,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RoguelikeStage {
    /// Runs per level where the player picks every branch.
    pub runs_per_level: u32,
    pub pool_size: usize,
    /// Extra runs per level per root-to-end path, with the branches forced
    /// onto that path, so every path is measured whatever players prefer.
    #[serde(default)]
    pub runs_per_path: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ComponentsStage {
    /// Average-vs-Average games for the per-entry value fit.
    pub fit_games: u32,
    /// Excellent compositions sampled for pick rates.
    pub pick_composes: u32,
}

/// Report thresholds.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Flags {
    /// Flag if a higher spender beats a lower spender of equal skill more
    /// than this (every pair of spend tiers).
    pub pay_to_win_max: f64,
    /// Flag if Excellent beats Poor at equal spend less than this.
    pub skill_min: f64,
    /// Flag a campaign node Average players clear less often than this.
    pub node_average_clear_min: f64,
    /// Flag a campaign node whose Average clear rate drops by more than this
    /// from the previous node (a difficulty spike).
    pub node_spike: f64,
    /// Flag a cost-table entry whose fair price differs from its price by
    /// more than this share (and 5 points, and 2 standard errors).
    pub component_mispricing: f64,
    /// Flag an AI config with at least this many appearances that never
    /// dealt damage or was never destroyed.
    pub ai_config_min_appearances: u32,
    /// Flag an archetype that ends the economy stage with fewer ships than
    /// this (about one full fleet).
    #[serde(default = "default_min_final_ships")]
    pub min_final_ships: f64,
    /// Flag a PvP matrix cell where fewer than this share of its games
    /// could be played.
    #[serde(default = "default_matrix_min_played")]
    pub matrix_min_played: f64,
}

fn default_min_final_ships() -> f64 {
    8.0
}

fn default_matrix_min_played() -> f64 {
    0.5
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ExperimentConfig {
    pub name: String,
    pub seed: u64,
    /// Smoke runs only: Excellent tactics with a tiny search, so the whole
    /// pipeline runs in minutes. Never use for results (the report says so).
    #[serde(default)]
    pub smoke: bool,
    /// Stages in run order: components, pve, roguelike, factorial, economy,
    /// matrix (matrix needs economy).
    pub stages: Vec<String>,
    pub components: ComponentsStage,
    pub pve: PveStage,
    pub roguelike: RoguelikeStage,
    pub factorial: FactorialStage,
    pub economy: EconomyStage,
    pub matrix: MatrixStage,
    pub flags: Flags,
}

impl ExperimentConfig {
    pub fn load(path: &Path) -> std::io::Result<ExperimentConfig> {
        Ok(serde_json::from_str(&std::fs::read_to_string(path)?)?)
    }
}

#[derive(Serialize, Deserialize)]
struct Unit<T> {
    unit: usize,
    data: T,
}

/// Computes units `0..n` with `f`, streaming them to `path`: units already
/// in the file are reused, the rest are computed `chunk` at a time in
/// parallel and appended (each chunk flushed to disk) in unit order.
/// Returns all `n` results in unit order.
pub fn units<T, F>(
    path: &Path,
    n: usize,
    chunk: usize,
    f: F,
    progress: &mut dyn FnMut(usize, usize),
) -> std::io::Result<Vec<T>>
where
    T: Serialize + DeserializeOwned + Send,
    F: Fn(usize) -> T + Sync + Send,
{
    let mut done: BTreeMap<usize, T> = BTreeMap::new();
    if path.exists() {
        let text = std::fs::read_to_string(path)?;
        let mut good = 0usize;
        for line in text.split_inclusive('\n') {
            if !line.ends_with('\n') {
                break; // half-written
            }
            match serde_json::from_str::<Unit<T>>(line) {
                Ok(u) if u.unit < n => {
                    done.insert(u.unit, u.data);
                    good += line.len();
                }
                _ => break,
            }
        }
        if good < text.len() {
            std::fs::OpenOptions::new()
                .write(true)
                .open(path)?
                .set_len(good as u64)?;
        }
    }
    let todo: Vec<usize> = (0..n).filter(|u| !done.contains_key(u)).collect();
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    progress(done.len(), n);
    for c in todo.chunks(chunk.max(1)) {
        let res: Vec<(usize, T)> = c.par_iter().map(|&u| (u, f(u))).collect();
        let mut buf = String::new();
        for (u, d) in &res {
            buf.push_str(&serde_json::to_string(&Unit { unit: *u, data: d })?);
            buf.push('\n');
        }
        file.write_all(buf.as_bytes())?;
        file.sync_data()?;
        for (u, d) in res {
            done.insert(u, d);
        }
        progress(done.len(), n);
    }
    Ok((0..n).map(|u| done.remove(&u).unwrap()).collect())
}

/// What a run directory was made with (refuses to mix inputs on resume).
#[derive(Serialize, Deserialize, PartialEq)]
pub struct Manifest {
    pub config: ExperimentConfig,
    pub fingerprint: String,
}

pub fn check_manifest(dir: &Path, m: &Manifest, fresh: bool) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let path = dir.join("manifest.json");
    if path.exists() && !fresh {
        let old: Manifest = serde_json::from_str(&std::fs::read_to_string(&path)?)?;
        if old.fingerprint != m.fingerprint || old.config != m.config {
            return Err(std::io::Error::other(format!(
                "{}: made with a different config or inputs; pass --fresh to start over (or use another --out)",
                dir.display()
            )));
        }
        return Ok(());
    }
    if fresh {
        // Start over: empty every file this runner owns (never directories).
        for e in std::fs::read_dir(dir)?.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if e.path().is_file()
                && (name.ends_with(".units.jsonl")
                    || name.ends_with(".json")
                    || name == "report.md")
            {
                std::fs::write(e.path(), b"")?;
            }
        }
    }
    std::fs::write(&path, serde_json::to_string_pretty(m)?)?;
    Ok(())
}

pub fn stage_path(dir: &Path, stage: &str) -> PathBuf {
    dir.join(format!("{stage}.json"))
}

/// A stable fingerprint (FNV-1a 64) of every input a run depends on: the
/// weights, tactics, ship values, profiles, rules and content files, plus
/// `extra` (search settings and any overrides). Resuming requires a match.
pub fn input_fingerprint(weights: &Path, tactics: &Path, profiles: &Path, extra: &str) -> String {
    let root = crate::rules::repo_root();
    let mut files = vec![
        weights.to_path_buf(),
        tactics.to_path_buf(),
        root.join("near/sim/weights/ship_value.json"),
        profiles.to_path_buf(),
        root.join("near/seed/config.json"),
    ];
    for f in [
        "singlePlayerStarterContent",
        "roguelikeStarterContent",
        "pvpStarterContent",
    ] {
        files.push(root.join(format!("ignition/data/{f}.json")));
    }
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    let mut eat = |bytes: &[u8]| {
        for &b in bytes {
            h ^= b as u64;
            h = h.wrapping_mul(0x0100_0000_01b3);
        }
    };
    for f in &files {
        eat(&std::fs::read(f).unwrap_or_default());
        eat(&[0xff]);
    }
    eat(extra.as_bytes());
    format!("{h:016x}")
}

/// Loads everything, checks the run directory's manifest, and runs the
/// experiment's stages (resuming whatever is already done), then renders
/// the report. `weights` / `tactics` default to the committed files.
pub fn run_experiment(
    exp: &ExperimentConfig,
    out: &Path,
    fresh: bool,
    weights: Option<&Path>,
    tactics: Option<&Path>,
    log: &mut dyn FnMut(&str),
) -> std::io::Result<()> {
    use crate::composition::{compose::SearchParams, value::ShipValueModel};
    use crate::economy::{Profiles, World};
    use crate::eval::Eval;
    use crate::tactics::TacticsConfig;
    let root = crate::rules::repo_root();
    let wp = weights
        .map(Path::to_path_buf)
        .unwrap_or_else(|| root.join("near/sim/weights/eval.json"));
    let tp = tactics
        .map(Path::to_path_buf)
        .unwrap_or_else(|| root.join("near/sim/tactics.json"));
    let (content, cfg) = (
        crate::content::Content::load(),
        crate::rules::Config::load(),
    );
    let eval = Eval::load(&wp)?;
    let mut tc = TacticsConfig::load(&tp)?;
    let mut sp = SearchParams::default();
    if exp.smoke {
        tc.excellent = stages::smoke_mcts();
        sp = SearchParams {
            parents: 2,
            offspring: 2,
            generations: 1,
            opponents: 1,
            validation_opponents: 1,
        };
    }
    let values = ShipValueModel::load(&root.join("near/sim/weights/ship_value.json"))?;
    let pp = root.join("near/sim/profiles.json");
    let profiles = Profiles::load(&pp)?;
    let fingerprint = input_fingerprint(
        &wp,
        &tp,
        &pp,
        &format!(
            "{}{}",
            serde_json::to_string(&sp)?,
            serde_json::to_string(&tc)?
        ),
    );
    check_manifest(
        out,
        &Manifest {
            config: exp.clone(),
            fingerprint: fingerprint.clone(),
        },
        fresh,
    )?;
    let world = World::new(&content, &cfg, &profiles, &values, &eval, &tc, &sp);
    let ctx = stages::Ctx {
        world: &world,
        eval: &eval,
        tc: &tc,
        sp: &sp,
        exp,
        dir: out,
        fingerprint: &fingerprint,
        fresh,
    };
    stages::run_all(&ctx, log)?;
    report::render(out, exp)
}

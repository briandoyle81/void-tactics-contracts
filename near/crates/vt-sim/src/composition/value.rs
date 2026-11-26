//! Ship value model: how much a ship adds to its fleet's chance of winning,
//! as a function of its battle stats. Fitted (not hand-set) from Average vs
//! Average PvP games between random fleets:
//!
//!   P(creator wins) = sigmoid(b0 + beta . (sum phi(creator ships) - sum phi(joiner ships)))
//!
//! (a Bradley–Terry model over fleets). A ship's value is beta . phi(ship).
//! Average composers pick ships by value per cost; the same fit is the
//! starting point for Phase 5's cost-efficiency analysis.

use std::path::Path;

use rand::{Rng, SeedableRng};
use rand_chacha::ChaCha8Rng;
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use vt_core::types::Ship;

use crate::arena::{creator_points, mix};
use crate::content::Content;
use crate::eval::Eval;
use crate::experiments::roll_pool;
use crate::fleet;
use crate::rules::Config;
use crate::runner::{play_match, Controller, Limits, SideSetup};
use crate::tactics::GreedyTactician;

pub const N_SHIP_FEATURES: usize = 13;
pub const SHIP_FEATURE_NAMES: [&str; N_SHIP_FEATURES] = [
    "count",     // 1 per ship (an extra body: one more move per round)
    "hp",        // max HP / 100
    "ehp",       // max HP / (1 - damage reduction) / 100
    "damage",    // gun damage / 100
    "range",     // range / 5
    "dmg_range", // damage * range / 500
    "movement",  // movement / 5
    "v1_special1",
    "v1_special2",
    "v1_special3",
    "v2_special1",
    "v2_special2",
    "v2_special3",
];

pub fn ship_features(cfg: &Config, s: &Ship) -> [f64; N_SHIP_FEATURES] {
    let a = cfg.attributes(s).expect("attributes");
    let dr = a.damage_reduction.min(95) as f64 / 100.0;
    let mut f = [0.0; N_SHIP_FEATURES];
    f[0] = 1.0;
    f[1] = a.max_hull_points as f64 / 100.0;
    f[2] = a.max_hull_points as f64 / (1.0 - dr) / 100.0;
    f[3] = a.gun_damage as f64 / 100.0;
    f[4] = a.range as f64 / 5.0;
    f[5] = a.gun_damage as f64 * a.range as f64 / 500.0;
    f[6] = a.movement as f64 / 5.0;
    let sp = s.equipment.special.index();
    if (1..=3).contains(&sp) {
        let base = if s.traits.variant == 2 { 10 } else { 7 };
        f[base + sp - 1] = 1.0;
    }
    f
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ShipValueModel {
    pub features: Vec<String>,
    pub beta: Vec<f64>,
    /// Creator-side intercept (first-move / zone advantage).
    pub intercept: f64,
    #[serde(default)]
    pub provenance: serde_json::Value,
}

impl Default for ShipValueModel {
    /// Untrained: every ship is worth its effective HP and damage.
    fn default() -> Self {
        let mut beta = vec![0.0; N_SHIP_FEATURES];
        beta[0] = 0.5;
        beta[2] = 0.5;
        beta[3] = 1.0;
        ShipValueModel {
            features: SHIP_FEATURE_NAMES.iter().map(|s| s.to_string()).collect(),
            beta,
            intercept: 0.0,
            provenance: serde_json::json!("default (unfitted)"),
        }
    }
}

impl ShipValueModel {
    pub fn load(path: &Path) -> std::io::Result<ShipValueModel> {
        let m: ShipValueModel = serde_json::from_str(&std::fs::read_to_string(path)?)?;
        assert_eq!(
            m.features,
            SHIP_FEATURE_NAMES,
            "{}: feature list differs from this build; refit",
            path.display()
        );
        Ok(m)
    }
    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        if let Some(d) = path.parent() {
            std::fs::create_dir_all(d)?;
        }
        std::fs::write(path, serde_json::to_string_pretty(self)? + "\n")
    }
    /// The ship's contribution to its fleet's win log-odds.
    pub fn value(&self, cfg: &Config, s: &Ship) -> f64 {
        ship_features(cfg, s)
            .iter()
            .zip(&self.beta)
            .map(|(a, b)| a * b)
            .sum()
    }
}

/// One training example: feature-sum difference (creator - joiner), points.
pub struct Example {
    pub diff: [f64; N_SHIP_FEATURES],
    pub y: f64,
}

/// Plays `games` Average-vs-Average PvP games between random fleets (random
/// caps, variants, pools; heuristic placement) for fitting.
pub fn generate(
    content: &Content,
    cfg: &Config,
    eval: &Eval,
    games: u32,
    seed: u64,
) -> Vec<Example> {
    let t = GreedyTactician {
        label: "average".into(),
        eval: eval.clone(),
        temperature: 0.0,
        epsilon: 0.0,
    };
    (0..games)
        .into_par_iter()
        .map(|i| {
            let mut rng = ChaCha8Rng::seed_from_u64(mix(seed, i as u64, 41));
            let map = &content.pvp_maps[rng.gen_range(0..content.pvp_maps.len())];
            let cap = crate::arena::STANDARD_PVP_CAPS[rng.gen_range(0..2)];
            let tiles = [
                content.deployment_tiles(Some(map), true),
                content.deployment_tiles(Some(map), false),
            ];
            let n = tiles[0].len().min(tiles[1].len());
            let pools: Vec<Vec<Ship>> = (0..2)
                .map(|k| {
                    roll_pool(
                        cfg,
                        if rng.gen_bool(0.3) { 2 } else { 1 },
                        30,
                        1 + k * 100_000,
                        &mut rng,
                    )
                })
                .collect();
            let fleets: Vec<Vec<&Ship>> = pools
                .iter()
                .map(|p| fleet::random_fleet(p, cap, n, Some(p[0].traits.variant), &mut rng))
                .collect();
            // The creator deploys first (blind); the joiner sees it.
            use crate::composition::place::heuristic_cells;
            let c0 = heuristic_cells(content, cfg, map, true, &fleets[0], None);
            let c1 = heuristic_cells(content, cfg, map, false, &fleets[1], Some((&fleets[0], &c0)));
            let cells = [c0, c1];
            let side = |k: usize| SideSetup {
                label: format!("p{k}"),
                ships: fleets[k].clone(),
                cells: cells[k].clone(),
                controller: Controller::Agent(&t),
                ai_keys: Default::default(),
            };
            let log = play_match(
                cfg,
                "pvp",
                seed,
                map,
                None,
                &content.maps[map],
                side(0),
                side(1),
                true,
                crate::arena::STANDARD_PVP_MAX_SCORE,
                &[],
                Limits::default(),
                &mut rng,
            )
            .log;
            let mut diff = [0.0; N_SHIP_FEATURES];
            for (k, sign) in [(0usize, 1.0), (1, -1.0)] {
                for s in &fleets[k] {
                    for (d, f) in diff.iter_mut().zip(ship_features(cfg, s)) {
                        *d += sign * f;
                    }
                }
            }
            Example {
                diff,
                y: creator_points(&log),
            }
        })
        .collect()
}

/// Solves A x = b (small dense, partial pivoting).
fn solve(mut a: Vec<Vec<f64>>, mut b: Vec<f64>) -> Vec<f64> {
    let n = b.len();
    for c in 0..n {
        let p = (c..n)
            .max_by(|&i, &j| a[i][c].abs().partial_cmp(&a[j][c].abs()).unwrap())
            .unwrap();
        a.swap(c, p);
        b.swap(c, p);
        for r in c + 1..n {
            let f = a[r][c] / a[c][c];
            for k in c..n {
                a[r][k] -= f * a[c][k];
            }
            b[r] -= f * b[c];
        }
    }
    let mut x = vec![0.0; n];
    for c in (0..n).rev() {
        x[c] = (b[c] - (c + 1..n).map(|k| a[c][k] * x[k]).sum::<f64>()) / a[c][c];
    }
    x
}

/// L2-regularized logistic regression by Newton's method. Returns
/// (intercept, beta, log-loss).
pub fn fit(examples: &[Example], l2: f64) -> (f64, Vec<f64>, f64) {
    let k = N_SHIP_FEATURES + 1;
    let row =
        |e: &Example| -> Vec<f64> { std::iter::once(1.0).chain(e.diff.iter().copied()).collect() };
    let mut w = vec![0.0; k];
    for _ in 0..50 {
        let mut g = vec![0.0; k];
        let mut h = vec![vec![0.0; k]; k];
        for e in examples {
            let x = row(e);
            let z: f64 = x.iter().zip(&w).map(|(a, b)| a * b).sum();
            let p = 1.0 / (1.0 + (-z).exp());
            for i in 0..k {
                g[i] += (p - e.y) * x[i];
                for j in 0..k {
                    h[i][j] += p * (1.0 - p) * x[i] * x[j];
                }
            }
        }
        for i in 1..k {
            g[i] += l2 * w[i];
            h[i][i] += l2;
        }
        h[0][0] += 1e-9;
        let step = solve(h, g);
        for i in 0..k {
            w[i] -= step[i];
        }
        if step.iter().map(|s| s.abs()).fold(0.0, f64::max) < 1e-8 {
            break;
        }
    }
    let loss = examples
        .iter()
        .map(|e| {
            let z: f64 = row(e).iter().zip(&w).map(|(a, b)| a * b).sum();
            let p = (1.0 / (1.0 + (-z).exp())).clamp(1e-9, 1.0 - 1e-9);
            -(e.y * p.ln() + (1.0 - e.y) * (1.0 - p).ln())
        })
        .sum::<f64>()
        / examples.len().max(1) as f64;
    (w[0], w[1..].to_vec(), loss)
}

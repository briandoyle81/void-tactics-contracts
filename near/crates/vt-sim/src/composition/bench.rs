//! `vt-sim compose-bench`: what composition skill is worth.
//!
//! PvP comparisons give both players the same ship pool (copies with
//! different ids), the same map and cap, and play each scenario twice with
//! sides swapped, so only the measured skill differs. PvP Excellent
//! composers search against a meta of Average-composed fleets from other
//! random pools (they don't see the actual opponent).

use std::collections::{BTreeSet, HashMap};

use rand::{Rng, SeedableRng};
use rand_chacha::ChaCha8Rng;
use rayon::prelude::*;
use serde::Serialize;
use vt_core::types::Ship;

use super::compose::{make, ComposeCtx, Composer, Foe, SearchParams};
use super::planner::LevelPlanner;
use super::value::ShipValueModel;
use crate::arena::{creator_points, mix, summarize, HeadToHead};
use crate::content::Content;
use crate::eval::Eval;
use crate::experiments::roll_pool;
use crate::log::MatchLog;
use crate::rules::Config;
use crate::runner::{
    play_match, run_roguelike, AiSide, BasicPlanner, Controller, Limits, RunPlanner, SideSetup,
};
use crate::tactics::{Level, Tactician, TacticsConfig};

/// Cost caps the composition benches and PvP stages draw from: the standard
/// match's (2026-11-24; was 500/1000/1500).
pub const CAPS: [u64; 2] = crate::arena::STANDARD_PVP_CAPS;

/// A player for these comparisons: a composer and a tactician.
pub struct Player<'a> {
    pub label: String,
    pub composer: &'a dyn Composer,
    pub tactician: &'a dyn Tactician,
}

/// A mixed pool (mostly variant 1, some variant 2) with ids from `first_id`.
pub fn mixed_pool(cfg: &Config, first_id: u64, rng: &mut ChaCha8Rng) -> Vec<Ship> {
    let mut p = roll_pool(cfg, 1, 30, first_id, rng);
    p.extend(roll_pool(cfg, 2, 10, first_id + 30, rng));
    p
}

/// The PvP meta: per cap, Average-composed fleets from independent pools.
pub fn build_meta(
    content: &Content,
    cfg: &Config,
    values: &ShipValueModel,
    per_cap: usize,
    seed: u64,
) -> HashMap<u64, Vec<Vec<Ship>>> {
    build_meta_for(content, cfg, values, &CAPS, per_cap, seed)
}

/// `build_meta` for any set of caps.
pub fn build_meta_for(
    content: &Content,
    cfg: &Config,
    values: &ShipValueModel,
    caps: &[u64],
    per_cap: usize,
    seed: u64,
) -> HashMap<u64, Vec<Vec<Ship>>> {
    let avg = super::compose::AverageComposer {
        values: values.clone(),
    };
    let mut out = HashMap::new();
    for &cap in caps {
        let fleets = (0..per_cap)
            .map(|k| {
                let mut rng = ChaCha8Rng::seed_from_u64(mix(seed, cap, k as u64));
                let pool = mixed_pool(cfg, 500_000 + 100 * k as u64, &mut rng);
                let map = &content.pvp_maps[k % content.pvp_maps.len()];
                let ctx = ComposeCtx {
                    content,
                    cfg,
                    map,
                    is_creator: true,
                    cap,
                    max_score: crate::arena::STANDARD_PVP_MAX_SCORE,
                    creator_goes_first: true,
                    variant: None,
                    carried: &[],
                    foe: Foe::Meta(&[]),
                    survival_weight: 0.0,
                    repair_ships: 0,
                };
                let l = avg.compose(&ctx, &pool, &mut rng);
                l.ids
                    .iter()
                    .map(|id| pool.iter().find(|s| s.id == *id).unwrap().clone())
                    .collect()
            })
            .collect();
        out.insert(cap, fleets);
    }
    out
}

/// One PvP game: `a` (creator) vs `b` (joiner), each composing from its pool.
#[allow(clippy::too_many_arguments)]
pub fn pvp_game(
    content: &Content,
    cfg: &Config,
    a: &Player,
    b: &Player,
    pools: [&[Ship]; 2],
    map: &str,
    cap: u64,
    meta: &[Vec<Ship>],
    seed: u64,
) -> MatchLog {
    let mut rng = ChaCha8Rng::seed_from_u64(seed);
    let ctx_a = ComposeCtx {
        content,
        cfg,
        map,
        is_creator: true,
        cap,
        max_score: crate::arena::STANDARD_PVP_MAX_SCORE,
        creator_goes_first: true,
        variant: None,
        carried: &[],
        foe: Foe::Meta(meta),
        survival_weight: 0.0,
        repair_ships: 0,
    };
    let ships = |pool: &[Ship], ids: &[u64]| -> Vec<Ship> {
        ids.iter()
            .map(|id| pool.iter().find(|s| s.id == *id).unwrap().clone())
            .collect()
    };
    // A (creator) submits first; B deploys second, seeing A's fleet.
    let la = a.composer.compose(&ctx_a, pools[0], &mut rng);
    let sa = ships(pools[0], &la.ids);
    let ctx_b = ComposeCtx {
        is_creator: false,
        foe: Foe::Known {
            ships: &sa,
            cells: &la.cells,
        },
        ..ctx_a
    };
    let lb = b.composer.compose(&ctx_b, pools[1], &mut rng);
    let sb = ships(pools[1], &lb.ids);
    let ca = SideSetup {
        label: a.label.clone(),
        ships: sa.iter().collect(),
        cells: la.cells.clone(),
        controller: Controller::Agent(a.tactician),
        ai_keys: HashMap::new(),
    };
    let cb = SideSetup {
        label: b.label.clone(),
        ships: sb.iter().collect(),
        cells: lb.cells.clone(),
        controller: Controller::Agent(b.tactician),
        ai_keys: HashMap::new(),
    };
    play_match(
        cfg,
        "pvp",
        seed,
        map,
        None,
        &content.maps[map],
        ca,
        cb,
        true,
        crate::arena::STANDARD_PVP_MAX_SCORE,
        &[],
        Limits::default(),
        &mut rng,
    )
    .log
}

/// A vs B over paired shared-pool scenarios.
pub fn pvp_compare(
    content: &Content,
    cfg: &Config,
    a: &Player,
    b: &Player,
    scenarios: u32,
    seed: u64,
    meta: &HashMap<u64, Vec<Vec<Ship>>>,
) -> HeadToHead {
    let pts: Vec<f64> = (0..scenarios)
        .into_par_iter()
        .flat_map_iter(|i| {
            let s = mix(seed, i as u64, 61);
            let mut rng = ChaCha8Rng::seed_from_u64(s);
            let map = content.pvp_maps[rng.gen_range(0..content.pvp_maps.len())].clone();
            let cap = CAPS[rng.gen_range(0..CAPS.len())];
            let pool_a = mixed_pool(cfg, 1, &mut rng);
            let pool_b: Vec<Ship> = pool_a
                .iter()
                .map(|x| Ship {
                    id: x.id + 100_000,
                    ..x.clone()
                })
                .collect();
            let m = &meta[&cap];
            let g1 = pvp_game(
                content,
                cfg,
                a,
                b,
                [&pool_a, &pool_b],
                &map,
                cap,
                m,
                mix(s, 1, 0),
            );
            let g2 = pvp_game(
                content,
                cfg,
                b,
                a,
                [&pool_a, &pool_b],
                &map,
                cap,
                m,
                mix(s, 2, 0),
            );
            [creator_points(&g1), 1.0 - creator_points(&g2)]
        })
        .collect();
    summarize(&pts)
}

/// Campaign clear rate for a player: every node × `per_node` random pools.
pub fn pve_clear(content: &Content, cfg: &Config, p: &Player, per_node: u32, seed: u64) -> f64 {
    let jobs: Vec<(usize, u32)> = (0..content.sp_nodes.len())
        .flat_map(|n| (0..per_node).map(move |k| (n, k)))
        .collect();
    let wins: usize = jobs
        .par_iter()
        .map(|&(n, k)| {
            let node = &content.sp_nodes[n];
            let mut rng = ChaCha8Rng::seed_from_u64(mix(seed, n as u64, k as u64));
            let pool = roll_pool(cfg, 1, 30, 1, &mut rng);
            let ai = AiSide::for_map(content, cfg, &node.map);
            let ctx = ComposeCtx {
                content,
                cfg,
                map: &node.map,
                is_creator: true,
                cap: node.cost_limit,
                max_score: node.max_score,
                creator_goes_first: node.creator_goes_first,
                variant: Some(1),
                carried: &[],
                foe: Foe::Ai(&ai),
                survival_weight: 0.0,
                repair_ships: 0,
            };
            let l = p.composer.compose(&ctx, &pool, &mut rng);
            let ships: Vec<&Ship> = l
                .ids
                .iter()
                .map(|id| pool.iter().find(|s| s.id == *id).unwrap())
                .collect();
            let me = SideSetup {
                label: p.label.clone(),
                ships,
                cells: l.cells,
                controller: Controller::Agent(p.tactician),
                ai_keys: HashMap::new(),
            };
            let log = play_match(
                cfg,
                "campaign",
                0,
                &node.map,
                Some(&node.key),
                &content.maps[&node.map],
                me,
                ai.side(),
                node.creator_goes_first,
                node.max_score,
                &[],
                Limits::default(),
                &mut rng,
            )
            .log;
            (log.winner == "creator") as usize
        })
        .sum();
    wins as f64 / jobs.len().max(1) as f64
}

#[derive(Debug, Serialize)]
pub struct RunStats {
    pub runs: u32,
    pub mean_combats_won: f64,
    pub runs_won: u32,
    pub mean_ships_lost: f64,
}

/// Roguelike runs: the planner's composer also picks the starting roster.
pub fn roguelike(
    content: &Content,
    cfg: &Config,
    composer: &dyn Composer,
    planner: &dyn RunPlanner,
    t: &dyn Tactician,
    runs: u32,
    seed: u64,
) -> RunStats {
    let rl = &content.roguelike;
    let res: Vec<(u32, bool, usize)> = (0..runs)
        .into_par_iter()
        .map(|i| {
            let mut rng = ChaCha8Rng::seed_from_u64(mix(seed, i as u64, 71));
            let pool = roll_pool(cfg, rl.required_variant.max(1), 30, 1, &mut rng);
            let root = &rl.nodes[&rl.root];
            let map = root.map.as_deref().unwrap();
            let ai = AiSide::for_map(content, cfg, map);
            let ctx = ComposeCtx {
                content,
                cfg,
                map,
                is_creator: true,
                cap: rl.initial_cost_cap,
                max_score: root.max_score,
                creator_goes_first: root.creator_goes_first,
                variant: Some(rl.required_variant),
                carried: &[],
                foe: Foe::Ai(&ai),
                survival_weight: 1.0,
                repair_ships: crate::composition::compose::ROGUELIKE_REPAIR_SHIPS,
            };
            let roster = composer.compose(&ctx, &pool, &mut rng).ids;
            let r = run_roguelike(
                content,
                cfg,
                i as u64,
                "bench",
                &pool,
                &roster,
                planner,
                t,
                &BTreeSet::new(),
                u64::MAX,
                Limits::default(),
                &mut rng,
            );
            (r.log.combats_won, r.log.won, r.lost.len())
        })
        .collect();
    let n = res.len().max(1) as f64;
    RunStats {
        runs: res.len() as u32,
        mean_combats_won: res.iter().map(|r| r.0 as f64).sum::<f64>() / n,
        runs_won: res.iter().filter(|r| r.1).count() as u32,
        mean_ships_lost: res.iter().map(|r| r.2 as f64).sum::<f64>() / n,
    }
}

#[derive(Debug, Serialize)]
pub struct Factorial {
    /// score[composition][tactics] vs the Average/Average reference.
    pub score: [[f64; 3]; 3],
    pub ci95: [[f64; 3]; 3],
    /// Share of between-cell variance: (composition, tactics, interaction).
    pub shares: (f64, f64, f64),
    /// Excellent minus Poor, averaged over the other axis.
    pub composition_range: f64,
    pub tactics_range: f64,
}

pub fn factorial(
    content: &Content,
    cfg: &Config,
    composers: &[Box<dyn Composer>],
    tacticians: &[Box<dyn Tactician>],
    scenarios: u32,
    seed: u64,
    meta: &HashMap<u64, Vec<Vec<Ship>>>,
    log: &mut dyn FnMut(&str),
) -> Factorial {
    let reference = Player {
        label: "ref".into(),
        composer: composers[1].as_ref(),
        tactician: tacticians[1].as_ref(),
    };
    let mut score = [[0.0; 3]; 3];
    let mut ci95 = [[0.0; 3]; 3];
    for c in 0..3 {
        for t in 0..3 {
            let p = Player {
                label: format!("c{c}t{t}"),
                composer: composers[c].as_ref(),
                tactician: tacticians[t].as_ref(),
            };
            let h = pvp_compare(content, cfg, &p, &reference, scenarios, seed, meta);
            log(&format!(
                "composition {} × tactics {}: {:.3} ±{:.3} vs average/average",
                Level::ALL[c].name(),
                Level::ALL[t].name(),
                h.a_score,
                h.ci95
            ));
            score[c][t] = h.a_score;
            ci95[c][t] = h.ci95;
        }
    }
    let grand = score.iter().flatten().sum::<f64>() / 9.0;
    let row = |c: usize| score[c].iter().sum::<f64>() / 3.0;
    let col = |t: usize| (0..3).map(|c| score[c][t]).sum::<f64>() / 3.0;
    let ss_c: f64 = (0..3).map(|c| 3.0 * (row(c) - grand).powi(2)).sum();
    let ss_t: f64 = (0..3).map(|t| 3.0 * (col(t) - grand).powi(2)).sum();
    let ss_total: f64 = score.iter().flatten().map(|x| (x - grand).powi(2)).sum();
    let ss_i = (ss_total - ss_c - ss_t).max(0.0);
    let tot = (ss_c + ss_t + ss_i).max(1e-12);
    Factorial {
        score,
        ci95,
        shares: (ss_c / tot, ss_t / tot, ss_i / tot),
        composition_range: row(2) - row(0),
        tactics_range: col(2) - col(0),
    }
}

#[derive(Debug, Serialize)]
pub struct ComposeReport {
    pub pvp: Vec<(String, String, HeadToHead)>,
    pub pve_clear_rate: Vec<(String, f64)>,
    pub roguelike: Vec<(String, RunStats)>,
    pub factorial: Option<Factorial>,
}

#[allow(clippy::too_many_arguments)]
pub fn run(
    content: &Content,
    cfg: &Config,
    eval: &Eval,
    tc: &TacticsConfig,
    values: &ShipValueModel,
    sp: &SearchParams,
    scenarios: u32,
    factorial_scenarios: u32,
    seed: u64,
    log: &mut dyn FnMut(&str),
) -> ComposeReport {
    let composers: Vec<Box<dyn Composer>> = Level::ALL
        .iter()
        .map(|&l| make(l, values, eval, sp))
        .collect();
    let tacticians: Vec<Box<dyn Tactician>> =
        Level::ALL.iter().map(|&l| tc.make(l, eval)).collect();
    let avg_t = tacticians[1].as_ref();
    let meta = build_meta(content, cfg, values, 12, seed);
    let player = |c: usize| Player {
        label: Level::ALL[c].name().into(),
        composer: composers[c].as_ref(),
        tactician: avg_t,
    };
    let mut report = ComposeReport {
        pvp: Vec::new(),
        pve_clear_rate: Vec::new(),
        roguelike: Vec::new(),
        factorial: None,
    };
    for (a, b) in [(1, 0), (2, 1), (2, 0)] {
        let t = std::time::Instant::now();
        let h = pvp_compare(content, cfg, &player(a), &player(b), scenarios, seed, &meta);
        log(&format!(
            "PvP composition {} vs {} (average tactics): {:.3} ±{:.3} ({:.0?})",
            Level::ALL[a].name(),
            Level::ALL[b].name(),
            h.a_score,
            h.ci95,
            t.elapsed()
        ));
        report
            .pvp
            .push((Level::ALL[a].name().into(), Level::ALL[b].name().into(), h));
    }
    for c in 0..3 {
        let t = std::time::Instant::now();
        let r = pve_clear(content, cfg, &player(c), 4, seed);
        log(&format!(
            "campaign clear rate, {} composition (average tactics): {r:.3} ({:.0?})",
            Level::ALL[c].name(),
            t.elapsed()
        ));
        report.pve_clear_rate.push((Level::ALL[c].name().into(), r));
    }
    for c in 0..3 {
        let t = std::time::Instant::now();
        let planner: Box<dyn RunPlanner> = if c == 0 {
            Box::new(BasicPlanner)
        } else {
            Box::new(LevelPlanner {
                level: Level::ALL[c],
                composer: make(Level::ALL[c], values, eval, sp),
                values: values.clone(),
                eval: eval.clone(),
            })
        };
        let r = roguelike(
            content,
            cfg,
            composers[c].as_ref(),
            planner.as_ref(),
            avg_t,
            40,
            seed,
        );
        log(&format!("roguelike, {} composition/planning (average tactics): {:.2} combats won/run, {}/{} runs won, {:.1} ships lost ({:.0?})", Level::ALL[c].name(), r.mean_combats_won, r.runs_won, r.runs, r.mean_ships_lost, t.elapsed()));
        report.roguelike.push((Level::ALL[c].name().into(), r));
    }
    if factorial_scenarios > 0 {
        let f = factorial(
            content,
            cfg,
            &composers,
            &tacticians,
            factorial_scenarios,
            seed + 1,
            &meta,
            log,
        );
        log(&format!(
            "factorial: variance share composition {:.0}%, tactics {:.0}%, interaction {:.0}%; Excellent-Poor range composition {:+.3}, tactics {:+.3}",
            f.shares.0 * 100.0,
            f.shares.1 * 100.0,
            f.shares.2 * 100.0,
            f.composition_range,
            f.tactics_range
        ));
        report.factorial = Some(f);
    }
    report
}

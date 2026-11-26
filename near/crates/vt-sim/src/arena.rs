//! Head-to-head and benchmark harness shared by training, calibration and
//! experiments. Games run in parallel (rayon); each game seeds its own RNG
//! and results are collected in index order, so output is reproducible.
//!
//! PvP comparisons are paired: a scenario is two random fleets on a PvP map,
//! played twice with the players swapping both fleet and side, which removes
//! fleet luck and first-move advantage from the comparison.

use std::collections::HashMap;

use rand::{Rng, SeedableRng};
use rand_chacha::ChaCha8Rng;
use rayon::prelude::*;
use vt_core::types::{Position, Ship};

use crate::content::Content;
use crate::experiments::roll_pool;
use crate::fleet;
use crate::log::MatchLog;
use crate::rules::Config;
use crate::runner::{play_match, AiSide, Controller, Limits, SideSetup};
use crate::tactics::Tactician;

pub fn mix(seed: u64, a: u64, b: u64) -> u64 {
    // SplitMix64 over the combined value: independent per-game seeds.
    let mut z =
        seed ^ a.wrapping_mul(0x9E37_79B9_7F4A_7C15) ^ b.wrapping_mul(0xC2B2_AE3D_27D4_EB4F);
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

/// A PvP setup: map, two fleets (with cells for either side), settings.
pub struct PvpScenario {
    pub seed: u64,
    pub map: String,
    pub pools: [Vec<Ship>; 2],
    /// Indices into the pool for each fleet.
    pub fleets: [Vec<usize>; 2],
    /// Cells for fleet k as creator ([k][0]) and as joiner ([k][1]).
    pub cells: [[Vec<Position>; 2]; 2],
    pub max_score: u64,
}

/// The standard PvP match (human, 2026-11-24): map id 70 on chain (`pvp04`,
/// the 67th–72nd map ids are the PvP maps in pvpStarterContent.json order),
/// first to 100 points, at a threat (cost) cap of 1000 or 2000. Every PvP game
/// the simulator plays (training, calibration, price fit, matrix, economy)
/// uses it; `Content::pvp_maps` holds only this map.
pub const STANDARD_PVP_MAP: &str = "pvp04";
pub const STANDARD_PVP_MAX_SCORE: u64 = 100;
pub const STANDARD_PVP_CAPS: [u64; 2] = [1000, 2000];

#[derive(Clone, Debug)]
pub struct ScenarioOpts {
    /// One is drawn per scenario.
    pub cost_caps: Vec<u64>,
    pub max_score: u64,
    /// Chance a fleet is variant 2 (drones) instead of variant 1.
    pub variant2_share: f64,
}

impl Default for ScenarioOpts {
    fn default() -> Self {
        ScenarioOpts {
            cost_caps: STANDARD_PVP_CAPS.to_vec(),
            max_score: STANDARD_PVP_MAX_SCORE,
            variant2_share: 0.25,
        }
    }
}

impl PvpScenario {
    pub fn random(content: &Content, cfg: &Config, seed: u64, opts: &ScenarioOpts) -> PvpScenario {
        let mut rng = ChaCha8Rng::seed_from_u64(seed);
        let map = content.pvp_maps[rng.gen_range(0..content.pvp_maps.len())].clone();
        let cost_cap = opts.cost_caps[rng.gen_range(0..opts.cost_caps.len())];
        let mut pools: [Vec<Ship>; 2] = Default::default();
        let mut fleets: [Vec<usize>; 2] = Default::default();
        let mut cells: [[Vec<Position>; 2]; 2] = Default::default();
        let tiles = [
            content.deployment_tiles(Some(&map), true),
            content.deployment_tiles(Some(&map), false),
        ];
        let max_ships = tiles[0].len().min(tiles[1].len());
        for k in 0..2 {
            let variant = if rng.gen_bool(opts.variant2_share) {
                2
            } else {
                1
            };
            pools[k] = roll_pool(cfg, variant, 30, 1 + k as u64 * 100_000, &mut rng);
            let chosen: Vec<u64> =
                fleet::random_fleet(&pools[k], cost_cap, max_ships, Some(variant), &mut rng)
                    .iter()
                    .map(|s| s.id)
                    .collect();
            fleets[k] = chosen
                .iter()
                .map(|id| pools[k].iter().position(|s| s.id == *id).unwrap())
                .collect();
            for side in 0..2 {
                cells[k][side] = fleet::random_cells(&tiles[side], fleets[k].len(), &mut rng);
            }
        }
        PvpScenario {
            seed,
            map,
            pools,
            fleets,
            cells,
            max_score: opts.max_score,
        }
    }

    /// Re-deploys fleets `ks` by purpose (`purpose::cells`) in place of
    /// their random cells (added 2026-11-25). As creator a fleet deploys
    /// first, blind; as joiner it deploys second and sees the other fleet's
    /// creator cells (whatever they are by then), as on chain where the
    /// first-submitted fleet is readable before the second goes in.
    pub fn deploy_by_purpose(&mut self, content: &Content, cfg: &Config, ks: &[usize]) {
        let ships = |sc: &PvpScenario, k: usize| -> Vec<Ship> {
            sc.fleets[k].iter().map(|&i| sc.pools[k][i].clone()).collect()
        };
        for &k in ks {
            let s = ships(self, k);
            let r: Vec<&Ship> = s.iter().collect();
            self.cells[k][0] = crate::purpose::cells(content, cfg, &self.map, true, &r, None);
        }
        for &k in ks {
            let (s, e) = (ships(self, k), ships(self, 1 - k));
            let (r, er): (Vec<&Ship>, Vec<&Ship>) = (s.iter().collect(), e.iter().collect());
            let ec = self.cells[1 - k][0].clone();
            self.cells[k][1] =
                crate::purpose::cells(content, cfg, &self.map, false, &r, Some((&er, &ec)));
        }
    }

    /// The starting position with fleet `fa` as creator.
    pub fn start(&self, cfg: &Config, content: &Content, fa: usize) -> vt_core::engine::GameState {
        let ships = |k: usize| {
            self.fleets[k]
                .iter()
                .map(|&i| &self.pools[k][i])
                .collect::<Vec<_>>()
        };
        let ce = fleet::entries(cfg, &ships(fa), &self.cells[fa][0]);
        let je = fleet::entries(cfg, &ships(1 - fa), &self.cells[1 - fa][1]);
        vt_core::engine::GameState::start(
            1,
            &ce,
            &je,
            true,
            600,
            self.max_score,
            cfg.heal_cap_percent,
            vt_core::maps::GameMap::from_preset(&content.maps[&self.map]),
            0,
        )
        .expect("game starts")
    }

    /// Plays fleet `fa` (as creator, controlled by `a`) against fleet `1 - fa`
    /// (as joiner, controlled by `b`).
    pub fn play(
        &self,
        content: &Content,
        cfg: &Config,
        a: (&str, &dyn Tactician),
        b: (&str, &dyn Tactician),
        fa: usize,
        limits: Limits,
    ) -> MatchLog {
        let fb = 1 - fa;
        let mut rng = ChaCha8Rng::seed_from_u64(mix(self.seed, fa as u64, 77));
        let ships = |k: usize| {
            self.fleets[k]
                .iter()
                .map(|&i| &self.pools[k][i])
                .collect::<Vec<_>>()
        };
        let creator = SideSetup {
            label: a.0.into(),
            ships: ships(fa),
            cells: self.cells[fa][0].clone(),
            controller: Controller::Agent(a.1),
            ai_keys: HashMap::new(),
        };
        let joiner = SideSetup {
            label: b.0.into(),
            ships: ships(fb),
            cells: self.cells[fb][1].clone(),
            controller: Controller::Agent(b.1),
            ai_keys: HashMap::new(),
        };
        play_match(
            cfg,
            "pvp",
            self.seed,
            &self.map,
            None,
            &content.maps[&self.map],
            creator,
            joiner,
            true,
            self.max_score,
            &[],
            limits,
            &mut rng,
        )
        .log
    }
}

/// Points for the creator: 1 win, 0.5 draw, 0 loss.
pub fn creator_points(m: &MatchLog) -> f64 {
    match m.winner {
        "creator" => 1.0,
        "draw" => 0.5,
        _ => 0.0,
    }
}

#[derive(Clone, Debug, Default, serde::Serialize)]
pub struct HeadToHead {
    pub games: u32,
    /// A's points / games (win 1, draw 0.5).
    pub a_score: f64,
    pub a_wins: u32,
    pub draws: u32,
    /// 95% half-width of a_score (normal approximation).
    pub ci95: f64,
}

/// A vs B over `scenarios` paired scenarios (2 games each).
pub fn head_to_head(
    content: &Content,
    cfg: &Config,
    a: &dyn Tactician,
    b: &dyn Tactician,
    scenarios: u32,
    seed: u64,
    opts: &ScenarioOpts,
    limits: Limits,
) -> (HeadToHead, Vec<MatchLog>) {
    let logs: Vec<(f64, MatchLog)> = (0..scenarios)
        .into_par_iter()
        .flat_map_iter(|i| {
            let sc = PvpScenario::random(content, cfg, mix(seed, i as u64, 1), opts);
            // A takes fleet 0 as creator, then B takes fleet 0 as creator.
            let g1 = sc.play(content, cfg, ("a", a), ("b", b), 0, limits);
            let g2 = sc.play(content, cfg, ("b", b), ("a", a), 0, limits);
            let p1 = creator_points(&g1);
            let p2 = 1.0 - creator_points(&g2);
            [(p1, g1), (p2, g2)]
        })
        .collect();
    let pts: Vec<f64> = logs.iter().map(|x| x.0).collect();
    (summarize(&pts), logs.into_iter().map(|x| x.1).collect())
}

pub fn summarize(pts: &[f64]) -> HeadToHead {
    let n = pts.len() as f64;
    let mean = pts.iter().sum::<f64>() / n.max(1.0);
    let var = pts.iter().map(|p| (p - mean).powi(2)).sum::<f64>() / (n - 1.0).max(1.0);
    HeadToHead {
        games: pts.len() as u32,
        a_score: mean,
        a_wins: pts.iter().filter(|&&p| p == 1.0).count() as u32,
        draws: pts.iter().filter(|&&p| p == 0.5).count() as u32,
        ci95: 1.96 * (var / n.max(1.0)).sqrt(),
    }
}

/// One PvE campaign game: a random fleet (seeded) under the node's cap.
pub fn pve_game(
    content: &Content,
    cfg: &Config,
    t: &dyn Tactician,
    node_idx: usize,
    seed: u64,
    limits: Limits,
) -> MatchLog {
    let node = &content.sp_nodes[node_idx];
    pve_fight(
        content,
        cfg,
        t,
        "campaign",
        &node.key,
        &node.map,
        node.cost_limit,
        node.max_score,
        node.creator_goes_first,
        seed,
        limits,
    )
}

/// Roguelike combat nodes, as single fights (for training and benches).
pub fn roguelike_combat_nodes(content: &Content) -> Vec<String> {
    content
        .roguelike
        .nodes
        .values()
        .filter(|n| n.map.is_some())
        .map(|n| n.key.clone())
        .collect()
}

/// One roguelike combat node as a single fight at full HP: a random
/// variant-1 fleet (seeded) under `cap`.
pub fn roguelike_fight(
    content: &Content,
    cfg: &Config,
    t: &dyn Tactician,
    key: &str,
    cap: u64,
    seed: u64,
    limits: Limits,
) -> MatchLog {
    let n = &content.roguelike.nodes[key];
    let map = n.map.as_deref().expect("combat node");
    pve_fight(content, cfg, t, "roguelike", key, map, cap, n.max_score, n.creator_goes_first, seed, limits)
}

/// A PvE fight on `map` against its AI fleet, with a random fleet.
fn pve_fight(
    content: &Content,
    cfg: &Config,
    t: &dyn Tactician,
    kind: &'static str,
    key: &str,
    map: &str,
    cap: u64,
    max_score: u64,
    creator_goes_first: bool,
    seed: u64,
    limits: Limits,
) -> MatchLog {
    struct N<'a> {
        key: &'a str,
        map: String,
        cost_limit: u64,
        max_score: u64,
        creator_goes_first: bool,
    }
    let node = N {
        key,
        map: map.to_string(),
        cost_limit: cap,
        max_score,
        creator_goes_first,
    };
    let mut rng = ChaCha8Rng::seed_from_u64(seed);
    let pool = roll_pool(cfg, 1, 30, 1, &mut rng);
    let tiles = content.deployment_tiles(Some(&node.map), true);
    let ships = fleet::random_fleet(&pool, node.cost_limit, tiles.len(), Some(1), &mut rng);
    let cells = fleet::random_cells(&tiles, ships.len(), &mut rng);
    let ai = AiSide::for_map(content, cfg, &node.map);
    let me = SideSetup {
        label: t.name(),
        ships,
        cells,
        controller: Controller::Agent(t),
        ai_keys: HashMap::new(),
    };
    play_match(
        cfg,
        kind,
        seed,
        &node.map,
        Some(node.key),
        &content.maps[&node.map],
        me,
        ai.side(),
        node.creator_goes_first,
        node.max_score,
        &[],
        limits,
        &mut rng,
    )
    .log
}

/// Campaign clear rate: every node × `fleets_per_node` seeded random fleets.
/// The same seeds give every tactician the same fleets.
pub fn pve_benchmark(
    content: &Content,
    cfg: &Config,
    t: &dyn Tactician,
    fleets_per_node: u32,
    seed: u64,
    limits: Limits,
) -> (f64, Vec<MatchLog>) {
    let jobs: Vec<(usize, u32)> = (0..content.sp_nodes.len())
        .flat_map(|n| (0..fleets_per_node).map(move |k| (n, k)))
        .collect();
    let logs: Vec<MatchLog> = jobs
        .par_iter()
        .map(|&(n, k)| pve_game(content, cfg, t, n, mix(seed, n as u64, k as u64), limits))
        .collect();
    let wins = logs.iter().filter(|m| m.winner == "creator").count();
    (wins as f64 / logs.len().max(1) as f64, logs)
}

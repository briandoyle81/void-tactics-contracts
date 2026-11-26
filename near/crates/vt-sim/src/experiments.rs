//! Experiments. Phase 1 has `smoke`: every campaign node once, a batch of PvP
//! games and a few roguelike runs, all with Poor (random) composition and
//! random tactics. It exercises every runner end to end and is the
//! reproducibility check (same seed, same bytes).

use std::collections::{BTreeMap, BTreeSet, HashMap};

use rand::{Rng, SeedableRng};
use rand_chacha::ChaCha8Rng;
use vt_core::types::Ship;

use crate::content::Content;
use crate::fleet;
use crate::rules::Config;
use crate::runner::{
    play_match, run_roguelike, AiSide, BasicPlanner, Controller, Limits, SideSetup,
};
use crate::tactics::{RandomTactician, Tactician};

/// A pool of freshly rolled ships with ids `first_id..`.
pub fn roll_pool(
    cfg: &Config,
    variant: u16,
    n: usize,
    first_id: u64,
    rng: &mut ChaCha8Rng,
) -> Vec<Ship> {
    (0..n as u64)
        .map(|i| fleet::roll_ship(cfg, first_id + i, variant, rng.gen(), 0))
        .collect()
}

#[derive(Default, Debug)]
pub struct SmokeOutput {
    /// JSONL lines (matches, then runs), in a fixed order.
    pub match_lines: Vec<String>,
    pub run_lines: Vec<String>,
    /// Counts by kind and result, for a printed summary.
    pub summary: BTreeMap<String, u32>,
}

pub fn smoke(
    content: &Content,
    cfg: &Config,
    seed: u64,
    pvp_games: usize,
    runs: usize,
) -> SmokeOutput {
    let mut out = SmokeOutput::default();
    let limits = Limits::default();
    let random = RandomTactician;
    let tactician: &dyn Tactician = &random;
    let mut bump = |k: String| *out.summary.entry(k).or_default() += 1;

    // Campaign: every node once, player vs the on-chain AI.
    for (i, node) in content.sp_nodes.iter().enumerate() {
        let s = seed ^ (0x5000 + i as u64);
        let mut rng = ChaCha8Rng::seed_from_u64(s);
        let pool = roll_pool(cfg, 1, 30, 1, &mut rng);
        let tiles = content.deployment_tiles(Some(&node.map), true);
        let ships = fleet::random_fleet(&pool, node.cost_limit, tiles.len(), Some(1), &mut rng);
        let cells = fleet::random_cells(&tiles, ships.len(), &mut rng);
        let ai = AiSide::for_map(content, cfg, &node.map);
        let me = SideSetup {
            label: "smoke".into(),
            ships,
            cells,
            controller: Controller::Agent(tactician),
            ai_keys: HashMap::new(),
        };
        let p = play_match(
            cfg,
            "campaign",
            s,
            &node.map,
            Some(&node.key),
            &content.maps[&node.map],
            me,
            ai.side(),
            node.creator_goes_first,
            node.max_score,
            &[],
            limits,
            &mut rng,
        );
        bump(format!("campaign {} ({})", p.log.winner, p.log.end));
        out.match_lines.push(serde_json::to_string(&p.log).unwrap());
    }

    // PvP: random fleets on the PvP maps.
    for i in 0..pvp_games {
        let s = seed ^ (0x6000 + i as u64);
        let mut rng = ChaCha8Rng::seed_from_u64(s);
        let map = &content.pvp_maps[i % content.pvp_maps.len()];
        let a = roll_pool(cfg, 1, 30, 1, &mut rng);
        let b = roll_pool(cfg, 1, 30, 100_001, &mut rng);
        let ta = content.deployment_tiles(Some(map), true);
        let sa = fleet::random_fleet(&a, 1000, ta.len(), Some(1), &mut rng);
        let ca = fleet::random_cells(&ta, sa.len(), &mut rng);
        let tb = content.deployment_tiles(Some(map), false);
        let sb = fleet::random_fleet(&b, 1000, tb.len(), Some(1), &mut rng);
        let cb = fleet::random_cells(&tb, sb.len(), &mut rng);
        let first = rng.gen_bool(0.5);
        let p = play_match(
            cfg,
            "pvp",
            s,
            map,
            None,
            &content.maps[map],
            SideSetup {
                label: "smoke_a".into(),
                ships: sa,
                cells: ca,
                controller: Controller::Agent(tactician),
                ai_keys: HashMap::new(),
            },
            SideSetup {
                label: "smoke_b".into(),
                ships: sb,
                cells: cb,
                controller: Controller::Agent(tactician),
                ai_keys: HashMap::new(),
            },
            first,
            15,
            &[],
            limits,
            &mut rng,
        );
        bump(format!("pvp {} ({})", p.log.winner, p.log.end));
        out.match_lines.push(serde_json::to_string(&p.log).unwrap());
    }

    // Roguelike: whole runs with a starting roster under the initial cap.
    for i in 0..runs {
        let s = seed ^ (0x7000 + i as u64);
        let mut rng = ChaCha8Rng::seed_from_u64(s);
        let pool = roll_pool(
            cfg,
            content.roguelike.required_variant.max(1),
            30,
            1,
            &mut rng,
        );
        let root_map = content.roguelike.nodes[&content.roguelike.root].map.clone();
        let zone = content.deployment_tiles(root_map.as_deref(), true).len();
        let roster: Vec<u64> = fleet::random_fleet(
            &pool,
            content.roguelike.initial_cost_cap,
            zone,
            None,
            &mut rng,
        )
        .iter()
        .map(|s| s.id)
        .collect();
        let r = run_roguelike(
            content,
            cfg,
            s,
            "smoke",
            &pool,
            &roster,
            &BasicPlanner,
            tactician,
            &BTreeSet::new(),
            u64::MAX,
            limits,
            &mut rng,
        );
        bump(format!(
            "roguelike {} after {} wins",
            r.log.end, r.log.combats_won
        ));
        for m in &r.matches {
            out.match_lines.push(serde_json::to_string(m).unwrap());
        }
        out.run_lines.push(serde_json::to_string(&r.log).unwrap());
    }
    out
}

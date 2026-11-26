//! Move-generator throughput (sizes the Phase 2 search budget).
//!   cargo run -p vt-sim --profile sim --example movegen_bench
use std::time::Instant;

use rand::{Rng, SeedableRng};
use rand_chacha::ChaCha8Rng;
use vt_core::engine::GameState;
use vt_core::maps::GameMap;
use vt_core::types::ActionType;
use vt_sim::content::Content;
use vt_sim::experiments::roll_pool;
use vt_sim::fleet;
use vt_sim::movegen::{legal_moves, Targets};
use vt_sim::rules::Config;

fn main() {
    let (content, cfg) = (Content::load(), Config::load());
    let (mut positions, mut candidates, mut games) = (0u64, 0u64, 0u64);
    let t = Instant::now();
    for i in 0..40u64 {
        let mut rng = ChaCha8Rng::seed_from_u64(i);
        let map = &content.pvp_maps_all[i as usize % content.pvp_maps_all.len()];
        let (a, b) = (
            roll_pool(&cfg, 1, 30, 1, &mut rng),
            roll_pool(&cfg, 1, 30, 1001, &mut rng),
        );
        let (ta, tb) = (
            content.deployment_tiles(Some(map), true),
            content.deployment_tiles(Some(map), false),
        );
        let (sa, sb) = (
            fleet::random_fleet(&a, 1000, ta.len(), Some(1), &mut rng),
            fleet::random_fleet(&b, 1000, tb.len(), Some(1), &mut rng),
        );
        let (ca, cb) = (
            fleet::random_cells(&ta, sa.len(), &mut rng),
            fleet::random_cells(&tb, sb.len(), &mut rng),
        );
        let mut g = GameState::start(
            1,
            &fleet::entries(&cfg, &sa, &ca),
            &fleet::entries(&cfg, &sb, &cb),
            true,
            600,
            0,
            cfg.heal_cap_percent,
            GameMap::from_preset(&content.maps[map]),
            0,
        )
        .unwrap();
        games += 1;
        for _ in 0..300 {
            if g.ended {
                break;
            }
            let moves = legal_moves(&g, &cfg.rules, g.current_turn, Targets::Pruned);
            positions += 1;
            candidates += moves.len() as u64;
            let main: Vec<_> = moves
                .iter()
                .filter(|c| c.mv.action != ActionType::Retreat)
                .collect();
            if main.is_empty() {
                break;
            }
            g = main[rng.gen_range(0..main.len())].next.clone();
        }
    }
    let s = t.elapsed().as_secs_f64();
    println!(
        "{games} games, {positions} positions, {:.0} legal moves/position",
        candidates as f64 / positions as f64
    );
    println!(
        "{:.0} positions/s, {:.0} candidate moves/s (single thread)",
        positions as f64 / s,
        candidates as f64 / s
    );
}

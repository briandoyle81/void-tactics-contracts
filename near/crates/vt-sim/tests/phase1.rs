//! Phase 1 checks: content loads, the move generator is sound and complete,
//! and experiments are reproducible.

use std::collections::BTreeSet;

use rand::{Rng, SeedableRng};
use rand_chacha::ChaCha8Rng;
use vt_core::engine::{GameState, MoveInput, Side};
use vt_core::grid::{GRID_HEIGHT, GRID_WIDTH};
use vt_core::maps::GameMap;
use vt_core::types::ActionType;
use vt_sim::content::Content;
use vt_sim::experiments::{roll_pool, smoke};
use vt_sim::fleet;
use vt_sim::movegen::{actors, legal_moves, same_outcome, ship_moves, Targets};
use vt_sim::rules::Config;

type Key = (u64, i16, i16, usize, u64);

fn key(m: &MoveInput) -> Key {
    (
        m.ship_id,
        m.new_row,
        m.new_col,
        m.action.index(),
        m.target_ship_id,
    )
}

#[test]
fn content_loads_and_every_ai_fleet_builds() {
    let (content, cfg) = (Content::load(), Config::load());
    // The 15 combat missions reachable from the roguelike root (the stub
    // single-player campaign isn't loaded, and unreachable nodes are
    // dropped; 2026-11-20).
    assert_eq!(content.sp_nodes.len(), 15);
    assert_eq!(content.ai_configs.len(), 64);
    assert_eq!(content.roguelike.nodes.len(), 18);
    assert_eq!(content.roguelike.paths().len(), 8, "three two-way branches");
    for p in content.roguelike.paths() {
        assert!(content.roguelike.nodes[p.last().unwrap()].children.is_empty());
    }
    // Each mission's single-fight cap is the run's cap on arriving there.
    let cap = |k: &str| content.sp_nodes.iter().find(|n| n.key == k).unwrap().cost_limit;
    // Raised 25% with the 2026-11-26 repricing (were 600/800/1000/1200).
    assert_eq!((cap("m01"), cap("m05"), cap("m08"), cap("m11")), (750, 1000, 1250, 1500));
    assert_eq!(content.mission_name("m06"), "6. Counterattack");
    assert_eq!(content.pvp_maps_all.len(), 6);
    assert_eq!(content.pvp_maps, vec![vt_sim::arena::STANDARD_PVP_MAP.to_string()]);
    assert!(content
        .roguelike
        .nodes
        .contains_key(&content.roguelike.root));
    for node in &content.sp_nodes {
        let (fleet, info) = content.ai_fleet(&cfg, &node.map);
        assert!(!fleet.is_empty(), "node {} has an AI fleet", node.key);
        assert_eq!(fleet.len(), info.len());
        for p in &node.prerequisites {
            assert!(
                content.sp_nodes.iter().any(|n| &n.key == p),
                "prerequisite {p} exists"
            );
        }
    }
    for n in content.roguelike.nodes.values() {
        for c in &n.children {
            assert!(content.roguelike.nodes.contains_key(c), "edge to {c}");
        }
        if let Some(m) = &n.map {
            assert!(
                !content.ai_fleet(&cfg, m).0.is_empty(),
                "rl node {} has an AI fleet",
                n.key
            );
        }
    }
}

/// Positions from random play on PvP and campaign maps.
fn sample_states(content: &Content, cfg: &Config, games: u64, every: usize) -> Vec<GameState> {
    let mut out = Vec::new();
    for i in 0..games {
        let mut rng = ChaCha8Rng::seed_from_u64(1000 + i);
        let pvp = i % 2 == 0;
        let map = if pvp {
            content.pvp_maps_all[i as usize % content.pvp_maps_all.len()].clone()
        } else {
            content.sp_nodes[i as usize % content.sp_nodes.len()].map.clone()
        };
        let variant = if i % 4 == 1 { 2 } else { 1 };
        let a = roll_pool(cfg, variant, 20, 1, &mut rng);
        let b = roll_pool(cfg, 3 - variant, 20, 1001, &mut rng);
        let ta = content.deployment_tiles(Some(&map), true);
        let tb = content.deployment_tiles(Some(&map), false);
        let sa = fleet::random_fleet(&a, 900, ta.len(), None, &mut rng);
        let sb = fleet::random_fleet(&b, 900, tb.len(), None, &mut rng);
        let ca = fleet::random_cells(&ta, sa.len(), &mut rng);
        let cb = fleet::random_cells(&tb, sb.len(), &mut rng);
        let mut g = GameState::start(
            1,
            &fleet::entries(cfg, &sa, &ca),
            &fleet::entries(cfg, &sb, &cb),
            true,
            600,
            0,
            cfg.heal_cap_percent,
            GameMap::from_preset(&content.maps[&map]),
            0,
        )
        .unwrap();
        for step in 0..400 {
            if g.ended {
                break;
            }
            if step % every == 0 {
                out.push(g.clone());
            }
            let side = g.current_turn;
            let moves = legal_moves(&g, &cfg.rules, side, Targets::Pruned);
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
    out
}

#[test]
fn every_generated_move_is_legal() {
    let (content, cfg) = (Content::load(), Config::load());
    let states = sample_states(&content, &cfg, 8, 5);
    assert!(states.len() > 50, "{} states", states.len());
    for g in &states {
        let side = g.current_turn;
        for c in legal_moves(g, &cfg.rules, side, Targets::Pruned) {
            let mut h = g.clone();
            assert!(
                h.move_ship(side, &c.mv, &cfg.rules, 0).is_ok(),
                "generated {:?} is illegal",
                c.mv
            );
        }
    }
}

/// Brute force: every (cell, action, target) for one actor per state. The
/// engine-accepted set must equal the generator's, with and without pruning.
#[test]
fn generator_misses_no_legal_move() {
    let (content, cfg) = (Content::load(), Config::load());
    let states = sample_states(&content, &cfg, 10, 9);
    let mut rng = ChaCha8Rng::seed_from_u64(7);
    let mut checked = 0;
    for g in &states {
        let side = g.current_turn;
        let acts = actors(g, side);
        if acts.is_empty() {
            continue;
        }
        let id = acts[rng.gen_range(0..acts.len())];
        let targets: Vec<u64> = std::iter::once(0).chain(g.board.keys().copied()).collect();
        let mut brute: Vec<(Key, GameState)> = Vec::new();
        for row in 0..GRID_HEIGHT {
            for col in 0..GRID_WIDTH {
                for action in [
                    ActionType::Pass,
                    ActionType::Shoot,
                    ActionType::Assist,
                    ActionType::Special,
                    ActionType::FactionAbility,
                ] {
                    for &t in &targets {
                        if action == ActionType::Pass && t != 0 {
                            continue; // Pass ignores the target; one is enough
                        }
                        let m = MoveInput {
                            ship_id: id,
                            new_row: row,
                            new_col: col,
                            action,
                            target_ship_id: t,
                        };
                        let mut h = g.clone();
                        if h.move_ship(side, &m, &cfg.rules, 0).is_ok() {
                            brute.push((key(&m), h));
                        }
                    }
                }
            }
        }
        let legal: BTreeSet<Key> = brute.iter().map(|b| b.0).collect();
        for mode in [Targets::Pruned, Targets::Exhaustive] {
            let mut generated = ship_moves(g, &cfg.rules, side, id, mode);
            for c in &generated {
                assert!(
                    legal.contains(&key(&c.mv)),
                    "{mode:?} generated {:?}, which the engine rejects",
                    c.mv
                );
            }
            for (k, h) in brute.iter_mut() {
                assert!(
                    generated.iter_mut().any(|c| same_outcome(&mut c.next, h)),
                    "{mode:?} misses the outcome of legal move {k:?}"
                );
            }
            // Distinct by outcome: no two generated moves lead to the same position.
            for i in 0..generated.len() {
                let (a, b) = generated.split_at_mut(i + 1);
                for c in b.iter_mut() {
                    assert!(
                        !same_outcome(&mut a[i].next, &mut c.next),
                        "{mode:?}: {:?} and {:?} are duplicates",
                        a[i].mv,
                        c.mv
                    );
                }
            }
        }
        checked += 1;
    }
    assert!(checked >= 20, "checked {checked} positions");
}

#[test]
fn smoke_is_reproducible() {
    let (content, cfg) = (Content::load(), Config::load());
    let a = smoke(&content, &cfg, 42, 6, 3);
    let b = smoke(&content, &cfg, 42, 6, 3);
    assert_eq!(a.match_lines, b.match_lines);
    assert_eq!(a.run_lines, b.run_lines);
    let c = smoke(&content, &cfg, 43, 6, 3);
    assert_ne!(a.match_lines, c.match_lines, "the seed matters");
    assert_eq!(a.run_lines.len(), 3);
    // 15 missions + 6 PvP games, plus one line per roguelike combat.
    assert!(
        a.match_lines.len() >= 21 + 3,
        "{} match lines",
        a.match_lines.len()
    );
}

#[test]
fn rolled_ships_are_constructed_and_priced() {
    let cfg = Config::load();
    let mut rng = ChaCha8Rng::seed_from_u64(3);
    for variant in [1u16, 2] {
        for s in roll_pool(&cfg, variant, 50, 1, &mut rng) {
            assert!(s.ship_data.constructed);
            assert_eq!(s.traits.variant, variant);
            assert!(s.ship_data.cost > 0);
            assert_eq!(s.ship_data.cost, cfg.cost(&s).unwrap());
        }
    }
    let ranked = fleet::roll_ship(&cfg, 1, 1, 12345, 9);
    assert_eq!(ranked.ship_data.ships_destroyed, 9, "preset rank kept");
    let _ = Side::Creator;
}

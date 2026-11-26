//! Phase 2 checks: the evaluation is antisymmetric, the tacticians pick legal
//! moves reproducibly, the committed weights and calibration load and keep
//! the level ordering, and roguelike runs that win follow the contract's
//! post-win rules.

use std::collections::{BTreeSet, HashMap};

use rand::SeedableRng;
use rand_chacha::ChaCha8Rng;
use vt_core::engine::Side;
use vt_sim::arena::{head_to_head, PvpScenario, ScenarioOpts};
use vt_sim::content::{Content, WinEffect};
use vt_sim::eval::Eval;
use vt_sim::experiments::roll_pool;
use vt_sim::fleet;
use vt_sim::movegen::{legal_moves, Targets};
use vt_sim::rules::{repo_root, Config};
use vt_sim::runner::{run_roguelike, BasicPlanner, Limits};
use vt_sim::tactics::{Level, RandomTactician, TacticsConfig};

fn committed() -> (Eval, TacticsConfig) {
    let eval = Eval::load(&repo_root().join("near/sim/weights/eval.json"))
        .expect("trained weights are committed");
    let tc = TacticsConfig::load(&repo_root().join("near/sim/tactics.json"))
        .expect("calibrated tactics are committed");
    (eval, tc)
}

/// Positions along an Average-vs-Average game.
fn positions(
    content: &Content,
    cfg: &Config,
    eval: &Eval,
    seed: u64,
) -> Vec<vt_core::engine::GameState> {
    let sc = PvpScenario::random(content, cfg, seed, &ScenarioOpts::default());
    let t = TacticsConfig::default().make(Level::Average, eval);
    let mut g = sc.start(cfg, content, 0);
    let mut rng = ChaCha8Rng::seed_from_u64(seed);
    let mut out = vec![g.clone()];
    while !g.ended && out.len() < 120 {
        let side = g.current_turn;
        let Some(mv) = t.choose(&g, &cfg.rules, side, &mut rng) else {
            break;
        };
        g.move_ship(side, &mv, &cfg.rules, 0).unwrap();
        out.push(g.clone());
    }
    out
}

#[test]
fn evaluation_is_antisymmetric() {
    let (content, cfg) = (Content::load(), Config::load());
    let (eval, _) = committed();
    for seed in 0..4 {
        for g in positions(&content, &cfg, &eval, seed) {
            let (c, j) = (
                eval.evaluate(&g, Side::Creator),
                eval.evaluate(&g, Side::Joiner),
            );
            assert!(
                (c + j).abs() < 1e-3,
                "evaluate(creator) {c} != -evaluate(joiner) {j}"
            );
            let (vc, vj) = (eval.value(&g, Side::Creator), eval.value(&g, Side::Joiner));
            assert!((vc + vj - 1.0).abs() < 1e-4);
        }
    }
}

#[test]
fn every_level_picks_legal_moves_reproducibly() {
    let (content, cfg) = (Content::load(), Config::load());
    let (eval, tc) = committed();
    let states = positions(&content, &cfg, &eval, 9);
    for level in Level::ALL {
        let t = tc.make(level, &eval);
        for g in states.iter().step_by(15).filter(|g| !g.ended) {
            let side = g.current_turn;
            let legal: Vec<String> = legal_moves(g, &cfg.rules, side, Targets::Pruned)
                .into_iter()
                .map(|c| format!("{:?}", c.mv))
                .collect();
            let a = t
                .choose(g, &cfg.rules, side, &mut ChaCha8Rng::seed_from_u64(1))
                .expect("a move");
            let b = t
                .choose(g, &cfg.rules, side, &mut ChaCha8Rng::seed_from_u64(1))
                .expect("a move");
            assert!(
                legal.contains(&format!("{a:?}")),
                "{} chose an illegal move",
                t.name()
            );
            assert_eq!(
                format!("{a:?}"),
                format!("{b:?}"),
                "{} is not reproducible",
                t.name()
            );
        }
    }
}

/// The committed calibration keeps the ordering (fixed seeds: deterministic,
/// so this can't flake). The full measurement is in near/sim/calibration.json.
#[test]
fn level_ordering_holds() {
    let (content, cfg) = (Content::load(), Config::load());
    let (eval, tc) = committed();
    let t: Vec<_> = Level::ALL.iter().map(|&l| tc.make(l, &eval)).collect();
    let o = ScenarioOpts::default();
    let l = Limits::default();
    let (avg_vs_random, _) = head_to_head(
        &content,
        &cfg,
        t[1].as_ref(),
        &RandomTactician,
        10,
        3,
        &o,
        l,
    );
    assert!(
        avg_vs_random.a_score > 0.9,
        "average vs random {:.3}",
        avg_vs_random.a_score
    );
    let (avg_vs_poor, logs) =
        head_to_head(&content, &cfg, t[1].as_ref(), t[0].as_ref(), 20, 3, &o, l);
    assert!(
        avg_vs_poor.a_score > 0.55,
        "average vs poor {:.3}",
        avg_vs_poor.a_score
    );
    let (ex_vs_avg, _) = head_to_head(&content, &cfg, t[2].as_ref(), t[1].as_ref(), 10, 3, &o, l);
    assert!(
        ex_vs_avg.a_score > 0.55,
        "excellent vs average {:.3}",
        ex_vs_avg.a_score
    );
    // Parallel play is reproducible.
    let (_, again) = head_to_head(&content, &cfg, t[1].as_ref(), t[0].as_ref(), 20, 3, &o, l);
    assert_eq!(
        serde_json::to_string(&logs).unwrap(),
        serde_json::to_string(&again).unwrap()
    );
}

/// Runs with the Average tactician win combats; after each win the roster
/// follows the contract: every ship at or above the heal floor (stored 0 =
/// full), full HP after a HealAboveFloor node, the path follows edges, and
/// grants come only from grant nodes.
#[test]
fn roguelike_wins_follow_the_post_win_rules() {
    let (content, cfg) = (Content::load(), Config::load());
    let (eval, tc) = committed();
    let t = tc.make(Level::Average, &eval);
    let rl = &content.roguelike;
    let mut wins = 0;
    for seed in 0..24u64 {
        let mut rng = ChaCha8Rng::seed_from_u64(seed);
        let pool = roll_pool(&cfg, rl.required_variant.max(1), 30, 1, &mut rng);
        let zone = content
            .deployment_tiles(rl.nodes[&rl.root].map.as_deref(), true)
            .len();
        let roster: Vec<u64> =
            fleet::random_fleet(&pool, rl.initial_cost_cap, zone, None, &mut rng)
                .iter()
                .map(|s| s.id)
                .collect();
        let r = run_roguelike(
            &content,
            &cfg,
            seed,
            "t",
            &pool,
            &roster,
            &BasicPlanner,
            t.as_ref(),
            &BTreeSet::new(),
            u64::MAX,
            Limits::default(),
            &mut rng,
        );
        for w in r.log.path.windows(2) {
            assert!(
                rl.nodes[&w[0]].children.contains(&w[1]),
                "path {} -> {} is not an edge",
                w[0],
                w[1]
            );
        }
        assert_eq!(r.after_wins.len() as u32, r.log.combats_won);
        for (node, roster) in &r.after_wins {
            let heals_to_full = rl.nodes[node]
                .win_effects
                .iter()
                .any(|e| matches!(e, WinEffect::HealAboveFloor(100)));
            for &(id, hp, max) in roster {
                let floor = (max as u16 * rl.auto_heal_percent as u16 / 100) as u8;
                assert!(
                    hp == 0 || hp >= floor.max(1),
                    "ship {id} at {hp}/{max} below the {floor} floor after {node}"
                );
                if heals_to_full {
                    assert!(
                        hp == 0 || hp == max,
                        "ship {id} at {hp}/{max} after a heal-to-full node"
                    );
                }
            }
        }
        let grant_nodes: HashMap<&str, usize> = r
            .log
            .path
            .iter()
            .filter(|k| {
                rl.nodes[*k]
                    .win_effects
                    .iter()
                    .any(|e| matches!(e, WinEffect::ShipGrant(..)))
            })
            .map(|k| (k.as_str(), 1))
            .collect();
        assert!(r.grants.len() <= grant_nodes.len());
        wins += r.log.combats_won;
    }
    assert!(
        wins >= 5,
        "only {wins} combat wins across 24 runs: the win path is barely exercised"
    );
}

/// `exposed_dmg` (2026-11-24) weights an exposed ship by how much of its HP
/// the damage reaching it takes after damage reduction: raising an exposed
/// ship's damage reduction (more armor/shields) never makes it look worse,
/// and at least once makes it look better, while the flat `exposed` count
/// doesn't change.
#[test]
fn exposed_damage_accounts_for_damage_reduction() {
    use vt_sim::eval::{features, FEATURE_NAMES};
    let idx = |n: &str| FEATURE_NAMES.iter().position(|f| *f == n).unwrap();
    let (exposed, exposed_dmg) = (idx("exposed"), idx("exposed_dmg"));
    let (content, cfg) = (Content::load(), Config::load());
    let (eval, _) = committed();
    let mut improved = 0;
    for seed in 0..4 {
        for g in positions(&content, &cfg, &eval, seed) {
            for side in [Side::Creator, Side::Joiner] {
                let before = features(&g, side);
                let ids: Vec<u64> = g
                    .board
                    .iter()
                    .filter(|(_, b)| b.placed && b.hull_points > 0 && b.is_creator == (side == Side::Creator))
                    .map(|(&id, _)| id)
                    .collect();
                for id in ids {
                    let mut h = g.clone();
                    h.board.get_mut(&id).unwrap().damage_reduction = 90;
                    let after = features(&h, side);
                    assert_eq!(after[exposed], before[exposed]);
                    assert!(after[exposed_dmg] >= before[exposed_dmg] - 1e-6);
                    if after[exposed_dmg] > before[exposed_dmg] + 1e-6 {
                        improved += 1;
                    }
                }
            }
        }
    }
    assert!(improved > 0, "no exposed ship in the sampled positions");
}

/// Roles (2026-11-24): on the standard map each side has one home and one
/// enemy-side tile, so each side gets an anchor and a raider, different
/// ships; the anchor is the most durable operational ship and the raider
/// the fastest other one; and the role features are zero-sum between the
/// sides (covered by `evaluation_is_antisymmetric` too).
#[test]
fn role_ships_pick_the_most_durable_anchor_and_fastest_raider() {
    use vt_sim::eval::{role_ships, zone_of, Zone};
    let (content, cfg) = (Content::load(), Config::load());
    let (eval, _) = committed();
    assert_eq!(zone_of(3, true), Zone::Home);
    assert_eq!(zone_of(3, false), Zone::Enemy);
    assert_eq!(zone_of(8, true), Zone::Center);
    for seed in 0..4 {
        for g in positions(&content, &cfg, &eval, seed).iter().step_by(10) {
            for creator in [true, false] {
                let (anchor, raider) = role_ships(g, creator);
                let live: Vec<_> = g
                    .board
                    .iter()
                    .filter(|(_, b)| b.placed && b.status == vt_core::engine::STATUS_ALIVE && b.hull_points > 0 && b.is_creator == creator)
                    .collect();
                if live.len() < 2 {
                    continue;
                }
                let (a, r) = (anchor.expect("anchor"), raider.expect("raider"));
                assert_ne!(a, r);
                let dur = |b: &vt_core::engine::ShipBoard| {
                    b.max_hull_points as u32 * 100 / (100 - b.damage_reduction.min(99) as u32)
                };
                let best = live.iter().map(|(_, b)| dur(b)).max().unwrap();
                assert_eq!(dur(&g.board[&a]), best);
                let fastest = live.iter().filter(|(&id, _)| id != a).map(|(_, b)| b.movement).max().unwrap();
                assert_eq!(g.board[&r].movement, fastest);
            }
        }
    }
}

/// Purposes (2026-11-25): every ship of speed <= 2 is Home, Supports never
/// outnumber Center + Rush ships and each pairs with one of them, at most one
/// Rush; and purpose deployment gives distinct cells in the deployment zone
/// with a Home ship on pvp04's home tile (it lies inside the zone) when
/// deploying blind (creator), and within 3 steps of it when deploying
/// second (joiner), which avoids cells the first fleet can disable it on.
#[test]
fn purposes_follow_the_rules_and_deploy_inside_the_zone() {
    use vt_sim::purpose::{assign, cells, PShip, Purpose, HOME_MAX_SPEED};
    let (content, cfg) = (Content::load(), Config::load());
    let map = vt_sim::arena::STANDARD_PVP_MAP;
    for seed in 0..40 {
        let sc = PvpScenario::random(&content, &cfg, 500 + seed, &ScenarioOpts::default());
        for k in 0..2 {
            let ships: Vec<_> = sc.fleets[k].iter().map(|&i| &sc.pools[k][i]).collect();
            let ps: Vec<PShip> = ships.iter().map(|s| PShip::from_ship(&cfg, s)).collect();
            let asg = assign(&ps, true, true);
            let n = |p: Purpose| asg.iter().filter(|a| a.purpose == p).count();
            for (a, x) in asg.iter().zip({
                let mut v = ps.clone();
                v.sort_by_key(|x| x.id);
                v
            }) {
                assert_eq!(a.id, x.id);
                if x.movement <= HOME_MAX_SPEED {
                    assert_eq!(a.purpose, Purpose::Home);
                }
                if a.purpose == Purpose::Support {
                    let p = asg.iter().find(|b| Some(b.id) == a.partner).expect("partner");
                    assert!(matches!(p.purpose, Purpose::Center | Purpose::Rush));
                }
            }
            assert!(n(Purpose::Rush) <= 1);
            assert!(n(Purpose::Support) <= n(Purpose::Center) + n(Purpose::Rush));
            // The joiner deploys second, seeing the other fleet's creator cells.
            let other: Vec<_> = sc.fleets[1 - k].iter().map(|&i| &sc.pools[1 - k][i]).collect();
            let other_cells = cells(&content, &cfg, map, true, &other, None);
            for creator in [true, false] {
                let enemy = (!creator).then_some((other.as_slice(), other_cells.as_slice()));
                let c = cells(&content, &cfg, map, creator, &ships, enemy);
                let zone = content.deployment_tiles(Some(map), creator);
                assert_eq!(c.len(), ships.len());
                assert!(c.iter().all(|p| zone.contains(p)));
                let distinct: BTreeSet<_> = c.iter().map(|p| (p.row, p.col)).collect();
                assert_eq!(distinct.len(), c.len());
                let home = if creator { (1, 3) } else { (9, 13) };
                if n(Purpose::Home) > 0 {
                    // Blind (creator): a Home ship stands on the home tile.
                    // Seeing the first fleet (joiner): a cell the enemy can
                    // disable it on costs as much as 3 extra steps, so it
                    // may stand up to 3 steps off and step on in round 1.
                    let d = c
                        .iter()
                        .map(|p| vt_core::grid::manhattan((p.row, p.col), home))
                        .min()
                        .unwrap();
                    let max = if creator { 0 } else { 3 };
                    assert!(d <= max, "seed {seed}: nearest ship {d} steps from the home tile");
                }
            }
        }
    }
}

//! Do simulated players use ships by role? (2026-11-24)
//!
//! Plays PvP games on the standard match (random fleets) and, at every round
//! boundary, records where each operational ship stands: on a home, center
//! or enemy-side scoring tile (`eval::zone_of`), or on none.
//!
//! Ships are grouped two ways:
//! - by build, the roles a human described:
//!     raider     fast (top third by movement), short range, high damage:
//!                "pip an enemy-side tile from a weak enemy ship"
//!     fast tank  movement at or above the median, damage reduction >= 30:
//!                "race to and hold the center"
//!     heavy      slow (bottom third), damage reduction >= 30:
//!                "sit on home objectives"
//! - by the role the evaluation assigns (`eval::role_ships`): anchor,
//!   raider, or none.
//!
//! With a style, player A plays the styled weights (`eval::styled_weights`)
//! and player B the plain ones; each scenario is played with A as creator
//! and as joiner, and A's score is reported.
//!
//!   cargo run -p vt-sim --profile sim --example ship_roles -- \
//!     [level] [games] [max_score] [weights] [style] [weights_b]
//! level: poor | average | excellent (default average); games default 200;
//! max_score default: the standard match's; weights default the committed
//! eval.json ("-" for the default); style: none | raider | anchor;
//! weights_b: player B's weights (default: the same as A's).
use rand::SeedableRng;
use rand_chacha::ChaCha8Rng;
use rayon::prelude::*;
use vt_core::engine::{GameState, Side, STATUS_ALIVE};
use vt_sim::arena::{PvpScenario, ScenarioOpts};
use vt_sim::content::Content;
use vt_sim::eval::{role_ships, styled_weights, zone_of, Eval, Style, Zone};
use vt_sim::rules::{repo_root, Config};
use vt_sim::runner::Limits;
use vt_sim::tactics::{Level, TacticsConfig};

#[derive(Clone, Copy)]
struct Obs {
    player: usize, // 0 = A, 1 = B
    movement: u8,
    dr: u8,
    range: u8,
    gun: u8,
    assigned: usize, // 0 anchor, 1 raider, 2 none
    zone: usize,     // 0 home, 1 center, 2 enemy, 3 none
    /// Assigned raiders only: distance to the nearest live enemy-side tile,
    /// and whether every such tile is occupied by an enemy ship.
    raid: Option<(u8, bool)>,
}

fn snapshot(g: &GameState, a_is_creator: bool, out: &mut Vec<Obs>) {
    let roles = [role_ships(g, true), role_ships(g, false)];
    for (&id, b) in &g.board {
        if !b.placed || b.status != STATUS_ALIVE || b.hull_points == 0 {
            continue;
        }
        let (anchor, raider) = roles[if b.is_creator { 0 } else { 1 }];
        let zone = g
            .map
            .scoring
            .iter()
            .find(|t| t.points != 0 && t.row == b.row && t.col == b.col)
            .map_or(3, |t| match zone_of(t.col, b.is_creator) {
                Zone::Home => 0,
                Zone::Center => 1,
                Zone::Enemy => 2,
            });
        let raid = (Some(id) == raider).then(|| {
            let tiles: Vec<_> = g
                .map
                .scoring
                .iter()
                .filter(|t| t.points != 0 && zone_of(t.col, b.is_creator) == Zone::Enemy)
                .collect();
            let d = tiles
                .iter()
                .map(|t| vt_core::grid::manhattan((b.row, b.col), (t.row, t.col)))
                .min()
                .unwrap_or(0);
            let blocked = !tiles.is_empty()
                && tiles.iter().all(|t| {
                    g.board.values().any(|e| {
                        e.placed
                            && e.status == STATUS_ALIVE
                            && e.is_creator != b.is_creator
                            && e.row == t.row
                            && e.col == t.col
                    })
                });
            (d, blocked)
        });
        out.push(Obs {
            raid,
            player: if b.is_creator == a_is_creator { 0 } else { 1 },
            movement: b.movement,
            dr: b.damage_reduction,
            range: b.range,
            gun: b.gun_damage,
            assigned: if Some(id) == anchor {
                0
            } else if Some(id) == raider {
                1
            } else {
                2
            },
            zone,
        });
    }
}

/// Experiment (`DEPLOY_SLOW_HOME=1`, 2026-11-25): player A deploys its
/// slowest ship (most durable among equals) directly on its live home tile
/// (inside its deployment zone on pvp04), swapping cells with whichever of
/// its ships had that cell. Fleet A is the creator in game `a_creator`.
fn deploy_slowest_on_home(sc: &mut PvpScenario, cfg: &Config, content: &Content, a_creator: bool) {
    // `start(.., 0)` makes fleet 0 the creator (cells[0][0]) and fleet 1 the
    // joiner (cells[1][1]); A controls the creator when `a_creator`.
    let (k, side) = if a_creator { (0, 0) } else { (1, 1) };
    let map = vt_core::maps::GameMap::from_preset(&content.maps[&sc.map]);
    let Some(home) = map
        .scoring
        .iter()
        .find(|t| t.points != 0 && zone_of(t.col, side == 0) == Zone::Home)
        .map(|t| vt_core::types::Position { row: t.row, col: t.col })
    else {
        return;
    };
    if !content.deployment_tiles(Some(&sc.map), side == 0).contains(&home) {
        return;
    }
    let ships: Vec<_> = sc.fleets[k].iter().map(|&i| sc.pools[k][i].clone()).collect();
    let slow = (0..ships.len())
        .min_by_key(|&i| {
            let a = cfg.attributes(&ships[i]).unwrap();
            let dur = a.max_hull_points as u32 * 100 / (100 - a.damage_reduction.min(99) as u32);
            if std::env::var("DEPLOY_HOME_PICK").as_deref() == Ok("fast") {
                // Control: the fastest ship instead.
                (u8::MAX - a.movement, std::cmp::Reverse(dur))
            } else {
                (a.movement, std::cmp::Reverse(dur))
            }
        })
        .unwrap();
    let cells = &mut sc.cells[k][side];
    if let Some(j) = cells.iter().position(|c| *c == home) {
        cells.swap(slow, j);
    } else {
        cells[slow] = home;
    }
}

fn pct(v: &[usize; 4]) -> String {
    let n: usize = v.iter().sum();
    let on = n - v[3];
    let q = |i: usize| 100.0 * v[i] as f64 / on.max(1) as f64;
    format!(
        "{:>7} | {:>5.1}% | {:>5.1}% {:>5.1}% {:>5.1}%",
        n,
        100.0 * on as f64 / n.max(1) as f64,
        q(0),
        q(1),
        q(2)
    )
}

fn quantile(mut v: Vec<u8>, q: f64) -> u8 {
    v.sort();
    v[((v.len() - 1) as f64 * q) as usize]
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let level = match a.get(1).map(String::as_str).unwrap_or("average") {
        "poor" => Level::Poor,
        "excellent" => Level::Excellent,
        _ => Level::Average,
    };
    let games: u64 = a.get(2).map_or(200, |s| s.parse().unwrap());
    let max_score: u64 =
        a.get(3).map_or(vt_sim::arena::STANDARD_PVP_MAX_SCORE, |s| s.parse().unwrap());
    let load = |p: Option<&String>| {
        let wp = p
            .filter(|s| s.as_str() != "-")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| repo_root().join("near/sim/weights/eval.json"));
        Eval::load_mapped(&wp).unwrap()
    };
    let eval_a = load(a.get(4));
    let eval_b = if a.get(6).is_some() { load(a.get(6)) } else { eval_a.clone() };
    let style = match a.get(5).map(String::as_str) {
        Some("raider") => Some(Style::Raider),
        Some("anchor") => Some(Style::Anchor),
        _ => None,
    };
    if let Ok(k) = std::env::var("STYLE_STRENGTH") {
        *vt_sim::eval::STYLE_STRENGTH.write().unwrap() = k.parse().unwrap();
    }
    let eval_a = match style {
        Some(s) => {
            let w: Vec<f64> = eval_a.weights.iter().map(|&x| x as f64).collect();
            Eval {
                weights: styled_weights(&w, s).iter().map(|&x| x as f32).collect(),
                ..eval_a
            }
        }
        None => eval_a,
    };
    let (content, cfg) = (Content::load(), Config::load());
    let deploy_slow_home = std::env::var("DEPLOY_SLOW_HOME").is_ok();
    let tc = TacticsConfig::load(&repo_root().join("near/sim/tactics.json")).unwrap();
    let (ta, tb) = (tc.make(level, &eval_a), tc.make(level, &eval_b));
    let opts = ScenarioOpts {
        max_score,
        ..ScenarioOpts::default()
    };
    let per_game: Vec<(Vec<Obs>, u64, u8, f64)> = (0..games)
        .into_par_iter()
        .map(|i| {
            let (seed, a_creator) = (i / 2, i % 2 == 0);
            let mut sc = PvpScenario::random(&content, &cfg, 10_000 + seed, &opts);
            if deploy_slow_home {
                deploy_slowest_on_home(&mut sc, &cfg, &content, a_creator);
            }
            let mut g = sc.start(&cfg, &content, 0);
            let mut rng = ChaCha8Rng::seed_from_u64(i);
            let mut out = Vec::new();
            let mut round = g.current_round;
            let mut moves = 0;
            while !g.ended && g.current_round <= Limits::default().max_rounds && moves < 2000 {
                let side: Side = g.current_turn;
                let t = if (side == Side::Creator) == a_creator { &ta } else { &tb };
                let Some(mv) = t.choose(&g, &cfg.rules, side, &mut rng) else {
                    break;
                };
                if g.move_ship(side, &mv, &cfg.rules, 0).is_err() {
                    break;
                }
                moves += 1;
                if g.current_round != round {
                    round = g.current_round;
                    snapshot(&g, a_creator, &mut out);
                }
            }
            // 0 score win, 1 elimination, 2 unfinished (round/move limit)
            let how = if !g.ended {
                2
            } else if g.creator_score >= g.max_score || g.joiner_score >= g.max_score {
                0
            } else {
                1
            };
            let cp = match g.winner {
                Some(Side::Creator) => 1.0,
                Some(Side::Joiner) => 0.0,
                None => 0.5,
            };
            (out, g.current_round, how, if a_creator { cp } else { 1.0 - cp })
        })
        .collect();
    let n = per_game.len() as f64;
    let rounds = per_game.iter().map(|x| x.1 as f64).sum::<f64>() / n;
    let how = |k: u8| 100.0 * per_game.iter().filter(|x| x.2 == k).count() as f64 / n;
    let a_score = per_game.iter().map(|x| x.3).sum::<f64>() / n;
    println!(
        "{} PvP, max score {max_score}, {games} games, style {style:?} on A: A scores {a_score:.3}; mean rounds {rounds:.1}; ended by score {:.0}%, elimination {:.0}%, unfinished {:.0}%",
        ta.name(),
        how(0),
        how(1),
        how(2)
    );
    let obs: Vec<Obs> = per_game.into_iter().flat_map(|x| x.0).collect();
    let mv = obs.iter().map(|o| o.movement).collect::<Vec<_>>();
    let (m1, m_med, m2) =
        (quantile(mv.clone(), 1.0 / 3.0), quantile(mv.clone(), 0.5), quantile(mv, 2.0 / 3.0));
    let r_med = quantile(obs.iter().map(|o| o.range).collect(), 0.5);
    let g_med = quantile(obs.iter().map(|o| o.gun).collect(), 0.5);
    let head = "ship-rounds | on tile | home  center enemy (of rounds on a tile)";
    for p in 0..2 {
        let mut build = [[0usize; 4]; 4];
        let mut assigned = [[0usize; 4]; 3];
        for o in obs.iter().filter(|o| o.player == p) {
            let s = if o.movement <= m1 {
                0
            } else if o.movement > m2 {
                2
            } else {
                1
            };
            let role = if s == 2 && o.range <= r_med && o.gun >= g_med {
                0
            } else if o.movement >= m_med && o.dr >= 30 {
                1
            } else if s == 0 && o.dr >= 30 {
                2
            } else {
                3
            };
            build[role][o.zone] += 1;
            assigned[o.assigned][o.zone] += 1;
        }
        println!("\nPlayer {} by build\nrole       | {head}", ["A", "B"][p]);
        for (i, nm) in ["raider", "fast tank", "heavy", "other"].iter().enumerate() {
            println!("{nm:<10} | {}", pct(&build[i]));
        }
        let rr: Vec<(u8, bool)> = obs.iter().filter(|o| o.player == p).filter_map(|o| o.raid).collect();
        println!(
            "Player {} raider: mean distance to enemy-side tile {:.1}; tile held by an enemy ship {:.0}% of rounds",
            ["A", "B"][p],
            rr.iter().map(|x| x.0 as f64).sum::<f64>() / rr.len().max(1) as f64,
            100.0 * rr.iter().filter(|x| x.1).count() as f64 / rr.len().max(1) as f64
        );
        println!("Player {} by assigned role\nrole       | {head}", ["A", "B"][p]);
        for (i, nm) in ["anchor", "raider", "none"].iter().enumerate() {
            println!("{nm:<10} | {}", pct(&assigned[i]));
        }
    }
}

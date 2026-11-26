//! Purpose deployment check (2026-11-25).
//!
//! Plays the standard PvP match (random fleets) between players A and B and
//! reports A's score, then for each player and purpose (`purpose::assign`)
//! where its operational ships stand at each round boundary: on a home,
//! center or enemy-side scoring tile, or none; plus how often Support ships
//! cover their partner.
//!
//!   cargo run -p vt-sim --profile sim --example purpose_play -- \
//!     [level] [games] [weights_a] [weights_b] [style_a]
//! level: poor | average | excellent (default average); games default 200;
//! weights "-" = the committed eval.json; style_a: none | home | center |
//! rush | support.
//! Env: DEPLOY_A / DEPLOY_B = random (default) | purpose | range (the
//! pre-2026-11-25 range-based placement, `place::range_cells`). The joiner
//! side of each placement sees the creator's cells.
use rand::SeedableRng;
use rand_chacha::ChaCha8Rng;
use rayon::prelude::*;
use vt_core::engine::{GameState, Side, STATUS_ALIVE};
use vt_core::grid::manhattan;
use vt_sim::arena::{PvpScenario, ScenarioOpts};
use vt_sim::content::Content;
use vt_sim::eval::{styled_weights, zone_of, Eval, Style, Zone};
use vt_sim::purpose::{assign_in_game, Purpose};
use vt_sim::rules::{repo_root, Config};
use vt_sim::runner::Limits;
use vt_sim::tactics::{Level, TacticsConfig};

const PURPOSES: [Purpose; 4] = [Purpose::Home, Purpose::Center, Purpose::Rush, Purpose::Support];

#[derive(Default, Clone)]
struct Tally {
    /// [player][purpose][zone: home, center, enemy, none]
    zone: [[[usize; 4]; 4]; 2],
    /// [player]: (support ship-rounds with a live partner, covered)
    cover: [(usize, usize); 2],
}

fn snapshot(g: &GameState, a_creator: bool, t: &mut Tally) {
    for creator in [true, false] {
        let p = if creator == a_creator { 0 } else { 1 };
        let asg = assign_in_game(g, creator);
        let op = |id: u64| {
            g.board
                .get(&id)
                .filter(|b| b.placed && b.status == STATUS_ALIVE && b.hull_points > 0)
        };
        for a in &asg {
            let Some(b) = op(a.id) else { continue };
            let k = PURPOSES.iter().position(|x| *x == a.purpose).unwrap();
            let z = g
                .map
                .scoring
                .iter()
                .find(|s| s.points != 0 && s.row == b.row && s.col == b.col)
                .map_or(3, |s| match zone_of(s.col, creator) {
                    Zone::Home => 0,
                    Zone::Center => 1,
                    Zone::Enemy => 2,
                });
            t.zone[p][k][z] += 1;
            if a.purpose == Purpose::Support {
                if let Some(q) = a.partner.and_then(op) {
                    t.cover[p].0 += 1;
                    // Repair ships cover within 1 (repair range), others within gun range.
                    let r = if vt_sim::eval::can_repair_special(b.variant, b.special as u8) {
                        1
                    } else {
                        b.range.max(1)
                    };
                    if manhattan((b.row, b.col), (q.row, q.col)) <= r {
                        t.cover[p].1 += 1;
                    }
                }
            }
        }
    }
}

/// The pre-2026-11-25 range-based placement (`place::range_cells`) for
/// fleet `k`: blind as creator, against the other fleet's creator cells as
/// joiner.
fn deploy_range(sc: &mut PvpScenario, content: &Content, cfg: &Config, k: usize) {
    let ships: Vec<_> = sc.fleets[k].iter().map(|&i| sc.pools[k][i].clone()).collect();
    let r: Vec<_> = ships.iter().collect();
    let zone = content.deployment_tiles(Some(&sc.map), false);
    sc.cells[k][0] = vt_sim::composition::place::range_cells(content, cfg, &sc.map, true, &r, &zone);
    let seen = sc.cells[1 - k][0].clone();
    sc.cells[k][1] = vt_sim::composition::place::range_cells(content, cfg, &sc.map, false, &r, &seen);
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let level = match a.get(1).map(String::as_str).unwrap_or("average") {
        "poor" => Level::Poor,
        "excellent" => Level::Excellent,
        _ => Level::Average,
    };
    let games: u64 = a.get(2).map_or(200, |s| s.parse().unwrap());
    let load = |p: Option<&String>| {
        let wp = p
            .filter(|s| s.as_str() != "-")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| repo_root().join("near/sim/weights/eval.json"));
        Eval::load_mapped(&wp).unwrap()
    };
    let eval_a = load(a.get(3));
    let eval_b = load(a.get(4));
    let style = match a.get(5).map(String::as_str) {
        Some("home") => Some(Style::Home),
        Some("center") => Some(Style::Center),
        Some("rush") => Some(Style::Rush),
        Some("support") => Some(Style::Support),
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
    let dep = |k: &str| std::env::var(k).unwrap_or_else(|_| "random".into());
    let (dep_a, dep_b) = (dep("DEPLOY_A"), dep("DEPLOY_B"));
    let (content, cfg) = (Content::load(), Config::load());
    let tc = TacticsConfig::load(&repo_root().join("near/sim/tactics.json")).unwrap();
    let (ta, tb) = (tc.make(level, &eval_a), tc.make(level, &eval_b));
    let opts = ScenarioOpts::default();
    let per_game: Vec<(Tally, f64, u64)> = (0..games)
        .into_par_iter()
        .map(|i| {
            let (seed, a_creator) = (i / 2, i % 2 == 0);
            let mut sc = PvpScenario::random(&content, &cfg, 10_000 + seed, &opts);
            // start(.., 0): fleet 0 is the creator. A plays the creator in
            // even games, so A's fleet is 0 then and 1 otherwise.
            let (fa, fb) = if a_creator { (0, 1) } else { (1, 0) };
            // Range placement first (it reads the other fleet's creator
            // cells as given), then purpose placement for both at once.
            let mut purpose = Vec::new();
            for (k, how) in [(fa, &dep_a), (fb, &dep_b)] {
                match how.as_str() {
                    "purpose" => purpose.push(k),
                    "range" => deploy_range(&mut sc, &content, &cfg, k),
                    _ => {}
                }
            }
            sc.deploy_by_purpose(&content, &cfg, &purpose);
            let mut g = sc.start(&cfg, &content, 0);
            let mut rng = ChaCha8Rng::seed_from_u64(i);
            let mut t = Tally::default();
            snapshot(&g, a_creator, &mut t);
            let mut round = g.current_round;
            let mut moves = 0;
            while !g.ended && g.current_round <= Limits::default().max_rounds && moves < 2000 {
                let side: Side = g.current_turn;
                let tac = if (side == Side::Creator) == a_creator { &ta } else { &tb };
                let Some(mv) = tac.choose(&g, &cfg.rules, side, &mut rng) else {
                    break;
                };
                if g.move_ship(side, &mv, &cfg.rules, 0).is_err() {
                    break;
                }
                moves += 1;
                if g.current_round != round {
                    round = g.current_round;
                    snapshot(&g, a_creator, &mut t);
                }
            }
            let cp = match g.winner {
                Some(Side::Creator) => 1.0,
                Some(Side::Joiner) => 0.0,
                None => 0.5,
            };
            (t, if a_creator { cp } else { 1.0 - cp }, g.current_round)
        })
        .collect();
    let n = per_game.len() as f64;
    let score = per_game.iter().map(|x| x.1).sum::<f64>() / n;
    let se = (score * (1.0 - score) / n).sqrt();
    let rounds = per_game.iter().map(|x| x.2 as f64).sum::<f64>() / n;
    println!(
        "{} PvP, {games} games, deploy A {} / B {}, style {style:?} on A: A scores {score:.3} ± {se:.3}; mean rounds {rounds:.1}",
        ta.name(),
        dep_a,
        dep_b,
    );
    let mut t = Tally::default();
    for (x, _, _) in &per_game {
        for p in 0..2 {
            for k in 0..4 {
                for z in 0..4 {
                    t.zone[p][k][z] += x.zone[p][k][z];
                }
            }
            t.cover[p].0 += x.cover[p].0;
            t.cover[p].1 += x.cover[p].1;
        }
    }
    for p in 0..2 {
        println!(
            "\nPlayer {}  ship-rounds | home tile  center tile  enemy tile  no tile",
            ["A", "B"][p]
        );
        for (k, nm) in ["Home", "Center", "Rush", "Support"].iter().enumerate() {
            let v = t.zone[p][k];
            let tot: usize = v.iter().sum();
            let q = |z: usize| 100.0 * v[z] as f64 / tot.max(1) as f64;
            println!(
                "{nm:<8} {tot:>8}    | {:>8.1}% {:>10.1}% {:>10.1}% {:>7.1}%",
                q(0),
                q(1),
                q(2),
                q(3)
            );
        }
        let (c0, c1) = t.cover[p];
        println!(
            "Support covers its partner (within gun range; repair specials within 1) {:.0}% of ship-rounds",
            100.0 * c1 as f64 / c0.max(1) as f64
        );
    }
}

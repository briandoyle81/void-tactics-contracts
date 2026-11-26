//! Iteration 2 checks (2026-11-17): Excellent's model of the on-chain AI
//! predicts its real replies exactly; loss preferences are one-sided and
//! make careful players lose fewer ships; players stop attempting campaign
//! nodes that keep costing them ships.

use std::collections::BTreeSet;
use std::sync::{Arc, Mutex};

use rand::SeedableRng;
use rand_chacha::ChaCha8Rng;
use vt_core::engine::{GameState, MoveInput, Side, STATUS_DESTROYED};
use vt_core::replay::{compact_board, CompactBoard};
use vt_sim::arena::{pve_benchmark, pve_game};
use vt_sim::composition::compose::SearchParams;
use vt_sim::composition::value::ShipValueModel;
use vt_sim::content::Content;
use vt_sim::economy::{Player, Profiles, World};
use vt_sim::eval::{Eval, LossPrefs};
use vt_sim::rules::{repo_root, Config, LocalRules};
use vt_sim::runner::{AiSide, Limits};
use vt_sim::tactics::{ai_reply, AiInfo, GreedyTactician, Level, Tactician, TacticsConfig};


fn eval() -> Eval {
    Eval::load(&repo_root().join("near/sim/weights/eval.json")).unwrap()
}

/// Plays Average for the creator, and before handing the turn to the AI,
/// predicts the AI's replies with `ai_reply`; the next time it's asked to
/// move it checks the board it's given against the prediction.
struct Spy {
    inner: GreedyTactician,
    predicted: Mutex<Option<CompactBoard>>,
    checked: Arc<Mutex<(u32, u32)>>, // (checked, matched)
}

impl Tactician for Spy {
    fn name(&self) -> String {
        "spy".into()
    }
    fn choose(&self, g: &GameState, r: &LocalRules, s: Side, rng: &mut ChaCha8Rng) -> Option<MoveInput> {
        self.inner.choose(g, r, s, rng)
    }
    fn choose_vs(
        &self,
        g: &GameState,
        rules: &LocalRules,
        side: Side,
        rng: &mut ChaCha8Rng,
        ai: Option<&AiInfo>,
    ) -> Option<MoveInput> {
        if let Some(p) = self.predicted.lock().unwrap().take() {
            let mut c = self.checked.lock().unwrap();
            c.0 += 1;
            c.1 += (p == compact_board(g)) as u32;
        }
        let mv = self.inner.choose(g, rules, side, rng)?;
        let mut next = g.clone();
        next.move_ship(side, &mv, rules, 0).ok()?;
        let ai = ai.expect("PvE games tell the agent about the AI");
        while !next.ended && next.current_turn == Side::Joiner {
            match ai_reply(&next, rules, ai) {
                Some(c) => next = c.next,
                None => return Some(mv), // AI stuck: the game ends here
            }
        }
        if !next.ended {
            *self.predicted.lock().unwrap() = Some(compact_board(&next));
        }
        Some(mv)
    }
}

#[test]
fn modelled_ai_replies_match_the_real_ai() {
    let (content, cfg, e) = (Content::load(), Config::load(), eval());
    let checked = Arc::new(Mutex::new((0, 0)));
    let spy = Spy {
        inner: GreedyTactician {
            label: "average".into(),
            eval: e,
            temperature: 0.0,
            epsilon: 0.0,
        },
        predicted: Mutex::new(None),
        checked: checked.clone(),
    };
    for node in [0usize, 3, 6, 9, 12, 14] {
        pve_game(&content, &cfg, &spy, node, 5 + node as u64, Limits::default());
        *spy.predicted.lock().unwrap() = None;
    }
    let (n, ok) = *checked.lock().unwrap();
    assert!(n >= 30, "too few AI turns checked: {n}");
    assert_eq!(ok, n, "{} of {n} predicted AI replies differ from the real AI", n - ok);
}

#[test]
fn loss_preferences_are_one_sided() {
    let (content, cfg) = (Content::load(), Config::load());
    // A campaign start position (node m01, a seeded random fleet).
    let (node, seed) = (0usize, 1u64);
    let ai = AiSide::for_map(&content, &cfg, &content.sp_nodes[node].map);
    let mut g = {
        let mut rng = ChaCha8Rng::seed_from_u64(seed);
        let pool = vt_sim::experiments::roll_pool(&cfg, 1, 30, 1, &mut rng);
        let n = &content.sp_nodes[node];
        let tiles = content.deployment_tiles(Some(&n.map), true);
        let ships = vt_sim::fleet::random_fleet(&pool, n.cost_limit, tiles.len(), Some(1), &mut rng);
        let cells = vt_sim::fleet::random_cells(&tiles, ships.len(), &mut rng);
        let ce = vt_sim::fleet::entries(&cfg, &ships, &cells);
        let side = ai.side();
        let je = vt_sim::fleet::entries(&cfg, &side.ships, &side.cells);
        GameState::start(
            1,
            &ce,
            &je,
            n.creator_goes_first,
            600,
            n.max_score,
            cfg.heal_cap_percent,
            vt_core::maps::GameMap::from_preset(&content.maps[&n.map]),
            0,
        )
        .unwrap()
    };
    // Mark one ship on each side destroyed by hand: utility must drop by our
    // own weight for ours and rise only by the bounty for theirs.
    let ours = *g.creator_active.first().unwrap();
    let theirs = *g.joiner_active.first().unwrap();
    let base_prefs = LossPrefs {
        own_default: 0.3,
        bounty_default: 0.01,
        ..LossPrefs::default()
    };
    let e = Eval {
        loss: Some(Arc::new(base_prefs)),
        ..eval()
    };
    let before = e.utility(&g, Side::Creator) - e.value(&g, Side::Creator);
    g.board.get_mut(&ours).unwrap().status = STATUS_DESTROYED;
    let after_ours = e.utility(&g, Side::Creator) - e.value(&g, Side::Creator);
    g.board.get_mut(&theirs).unwrap().status = STATUS_DESTROYED;
    let after_both = e.utility(&g, Side::Creator) - e.value(&g, Side::Creator);
    assert!((after_ours - before + 0.3).abs() < 1e-5, "own loss costs its weight: {before} -> {after_ours}");
    assert!((after_both - after_ours - 0.01).abs() < 1e-5, "enemy loss pays only the bounty: {after_ours} -> {after_both}");
    // Without preferences, utility is the win probability.
    let plain = eval();
    assert_eq!(plain.utility(&g, Side::Creator), plain.value(&g, Side::Creator));
}

#[test]
fn careful_players_lose_fewer_ships() {
    let (content, cfg, e) = (Content::load(), Config::load(), eval());
    let tc = TacticsConfig::default();
    let careless = tc.make_with(Level::Average, &e, None);
    let careful = tc.make_with(Level::Average, &e, Some(LossPrefs::uniform(0.3)));
    let destroyed = |t: &dyn Tactician| {
        let (_, logs) = pve_benchmark(&content, &cfg, t, 2, 11, Limits::default());
        logs.iter()
            .map(|m| m.ship_logs.iter().filter(|s| s.side == 0 && s.outcome == "destroyed").count())
            .sum::<usize>()
    };
    let (a, b) = (destroyed(careless.as_ref()), destroyed(careful.as_ref()));
    assert!(b * 2 < a, "careful players should lose far fewer ships: {b} vs careless {a}");
}

#[test]
fn players_stop_attempting_nodes_that_cost_ships() {
    let content = Content::load();
    let cfg = Config::load();
    let profiles = Profiles::load(&repo_root().join("near/sim/profiles.json")).unwrap();
    let values = ShipValueModel::load(&repo_root().join("near/sim/weights/ship_value.json")).unwrap();
    let e = eval();
    let tc = TacticsConfig::default();
    let w = World::new(&content, &cfg, &profiles, &values, &e, &tc, &SearchParams::default());
    let mut p = Player::new(0, "ftp", Level::Excellent, 0, 1200.0);
    // m01 done; m02 is open and has cost 6 ships over 5 failed attempts.
    p.completed = BTreeSet::from(["m01".to_string()]);
    let m02 = content.sp_nodes.iter().position(|n| n.key == "m02").unwrap();
    let open_before: Vec<usize> = (0..10)
        .map(|s| w.pick_node(&p, &mut ChaCha8Rng::seed_from_u64(s)))
        .collect();
    assert!(open_before.contains(&m02), "m02 is attempted before it has a bad record");
    for n in &content.sp_nodes {
        if n.prerequisites.iter().all(|q| p.completed.contains(q)) && !p.completed.contains(&n.key) {
            p.node_record.insert(n.key.clone(), (5, 0, 6));
        }
    }
    let m01 = content.sp_nodes.iter().position(|n| n.key == "m01").unwrap();
    for s in 0..10 {
        assert_eq!(
            w.pick_node(&p, &mut ChaCha8Rng::seed_from_u64(s)),
            m01,
            "with every open node costing ships, the player farms a completed node"
        );
    }
    // A whale shrugs the same record off and keeps trying.
    let mut whale = Player::new(1, "whale", Level::Excellent, 0, 1200.0);
    whale.completed = p.completed.clone();
    whale.node_record = p.node_record.clone();
    whale.ships = (0..200)
        .map(|i| vt_sim::fleet::roll_ship(&cfg, 1 + i, 1, i, 0))
        .collect();
    assert_ne!(w.pick_node(&whale, &mut ChaCha8Rng::seed_from_u64(0)), m01);
}

#[test]
fn veterans_weigh_more_than_fresh_ships() {
    let cfg = Config::load();
    // Rolled ships come with random rank kills: set them explicitly.
    let mut fresh = vt_sim::fleet::roll_ship(&cfg, 1, 1, 7, 0);
    fresh.ship_data.ships_destroyed = 0;
    let mut vet = fresh.clone();
    vet.id = 2;
    vet.ship_data.ships_destroyed = vt_core::attributes::kills_for_rank(3);
    assert_eq!(cfg.rank(&fresh), 1);
    assert_eq!(cfg.rank(&vet), 3);
    let mean = fresh.ship_data.cost as f64;
    let (wf, wv) = (
        vt_sim::economy::ship_loss_weight(&cfg, &fresh, mean),
        vt_sim::economy::ship_loss_weight(&cfg, &vet, mean),
    );
    assert!((wf - 1.0).abs() < 1e-9, "a fresh ship at the mean cost weighs 1: {wf}");
    assert!(
        (wv - (1.0 + 2.0 * vt_sim::economy::VETERAN_WEIGHT_PER_RANK)).abs() < 1e-9,
        "a rank-3 ship weighs 1 + 2 x the per-rank bonus: {wv}"
    );
}

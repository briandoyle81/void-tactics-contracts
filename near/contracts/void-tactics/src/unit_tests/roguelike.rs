//! Phase 4 ports: RoguelikeMatch.test.ts, RoguelikeRun.test.ts. Game ends are
//! driven through the engine's own force_end + the roguelike event handler
//! (the same path a real win/loss takes); retreats go through move_ship.
//! Architecture-only cases have no NEAR counterpart (deploy wiring,
//! orchestrator registry UA-09, engine-live setter locks HA6-13, AI registry
//! pin UA-08: there are no repointable contracts), nor do the GameLens views
//! (replaced by direct views).

use super::*;
use crate::roguelike::{RlNodeKind, RunStatus, ShipGrant, WinEffect};
use near_sdk::json_types::{U128, U64};
use vt_core::engine::{EngineEvent, Side};
use vt_core::types::*;

const P: &str = "player.near";
const AI_ID: u64 = (1 << 40) + 1;

/// Campaign 1:  root(1, combat) -> [2 combat, 3 resupply];  2 -> [4 final combat];  3 -> [4].
fn setup(ai_variant: u16) -> (H, Vec<u64>) {
    let mut h = H::new();
    h.ctx(OWNER, 0);
    let map = h.c.create_preset_map(vec![], vec![], vec![], MapMode::PvE);
    let cfg = h.c.create_ai_ship_config(crate::single_player::AiShipConfig {
        name: "Drone".into(),
        equipment: Equipment::default(),
        traits: Traits { variant: ai_variant, ..Default::default() },
        archetype: Archetype::Grunt,
        shiny: true,
        ships_destroyed: 30,
    });
    h.c.set_map_placements(map, vec![Position { row: 5, col: 16 }], vec![cfg]);
    let c = h.c.create_rl_campaign();
    let n: Vec<U64> = [RlNodeKind::Combat, RlNodeKind::Combat, RlNodeKind::Resupply, RlNodeKind::Combat]
        .into_iter()
        .map(|k| h.c.create_rl_node(c, k, map, 300, 1000, true, if k == RlNodeKind::Resupply { 5000 } else { 0 }))
        .collect();
    h.c.add_rl_child(n[0], n[1]);
    h.c.add_rl_child(n[0], n[2]);
    h.c.add_rl_child(n[1], n[3]);
    h.c.add_rl_child(n[2], n[3]);
    h.c.set_rl_campaign(c, n[0], 80, 1, 1000);
    h.register(P, 5);
    let ids = h.buy_and_build(P, 0, 2); // 10 purchased ships
    (h, ids)
}

fn cheapest(h: &H, n: usize) -> Vec<u64> {
    let mut v: Vec<(u16, u64)> = h.owned(P).into_iter().filter(|&id| !h.ship(id).ship.ship_data.in_fleet).map(|id| (h.ship(id).ship.ship_data.cost, id)).collect();
    v.sort();
    v.into_iter().take(n).map(|x| x.1).collect()
}

fn start(h: &mut H, n: usize) -> Vec<u64> {
    let roster = cheapest(h, n);
    h.ctx(P, 0);
    h.c.start_run(U64(1), roster.iter().map(|&i| U64(i)).collect());
    roster
}

fn enter(h: &mut H, node: u64) -> u64 {
    let n = h.c.get_run(acc(P)).roster.len();
    h.ctx(P, 0);
    h.c.enter_combat_node(U64(node), (0..n).map(|i| Position { row: i as i16 * 2, col: 1 }).collect()).0
}

/// Ends `game` through the engine; `tweak` edits the board first.
fn finish(h: &mut H, game: u64, winner: Side, tweak: impl FnOnce(&mut vt_core::engine::GameState)) {
    h.ctx(P, 0);
    let (mut g, mut m) = h.c.load_rl(game);
    tweak(&mut g);
    let evs = g.force_end(Some(winner)).unwrap();
    h.c.apply_rl_events(game, &mut m, &g, &evs);
    h.c.save_rl(game, g, m);
}

fn win(h: &mut H, game: u64) {
    finish(h, game, Side::Creator, |_| {});
}

fn run(h: &H) -> crate::roguelike::Run {
    h.c.get_run(acc(P))
}

// ---------------------------------------------------------------- startRun

#[test]
#[should_panic(expected = "EmptyRoster")]
fn start_run_rejects_empty_roster() {
    let (mut h, _) = setup(1);
    h.ctx(P, 0);
    h.c.start_run(U64(1), vec![]);
}

#[test]
#[should_panic(expected = "CampaignNotFound")]
fn start_run_rejects_unknown_campaign() {
    let (mut h, ids) = setup(1);
    h.ctx(P, 0);
    h.c.start_run(U64(9), vec![U64(ids[0])]);
}

#[test]
#[should_panic(expected = "CampaignHasNoRoot")]
fn start_run_rejects_campaign_without_root() {
    let (mut h, ids) = setup(1);
    h.ctx(OWNER, 0);
    let c = h.c.create_rl_campaign();
    h.ctx(P, 0);
    h.c.start_run(c, vec![U64(ids[0])]);
}

#[test]
#[should_panic(expected = "WrongCampaignVariant")]
fn start_run_rejects_wrong_variant() {
    let (mut h, ids) = setup(1);
    h.ctx(OWNER, 0);
    h.c.set_rl_campaign(U64(1), U64(1), 80, 2, 1000);
    h.ctx(P, 0);
    h.c.start_run(U64(1), vec![U64(ids[0])]);
}

#[test]
fn start_run_reserves_roster_and_stands_on_root() {
    let (mut h, _) = setup(1);
    let roster = start(&mut h, 3);
    let r = run(&h);
    assert_eq!((r.status, r.current_node, r.generation), (RunStatus::Active, 1, 1));
    assert_eq!(r.reservation, roster);
    assert!(roster.iter().all(|&s| h.ship(s).ship.ship_data.in_fleet));
    assert_eq!(h.c.get_active_runs_at_node(U64(1)).0, 1);
}

#[test]
#[should_panic(expected = "RunAlreadyActive")]
fn start_run_twice_reverts() {
    let (mut h, _) = setup(1);
    start(&mut h, 2);
    start(&mut h, 2);
}

#[test]
#[should_panic(expected = "ShipCostVersionMismatch")]
fn start_run_requires_current_prices_ha6_09() {
    let (mut h, _) = setup(1);
    h.ctx(OWNER, 0);
    let c = h.c.get_costs(1).unwrap();
    h.c.set_costs(1, c);
    start(&mut h, 2);
}

// ------------------------------------------------------------ graph lockout

#[test]
fn one_way_commit_locks_siblings_and_parent() {
    let (mut h, _) = setup(1);
    start(&mut h, 2);
    let g = enter(&mut h, 1);
    win(&mut h, g);
    enter(&mut h, 2);
    assert!(h.c.is_rl_node_locked(acc(P), U64(3)));
    assert!(h.c.is_rl_node_locked(acc(P), U64(1)));
    assert_eq!(h.c.get_active_runs_at_node(U64(1)).0, 0);
    assert_eq!(h.c.get_active_runs_at_node(U64(2)).0, 1);
}

#[test]
#[should_panic(expected = "CannotAdvance")]
fn never_walks_back_to_a_parent() {
    let (mut h, _) = setup(1);
    start(&mut h, 2);
    let g = enter(&mut h, 1);
    win(&mut h, g);
    let g2 = enter(&mut h, 2);
    win(&mut h, g2);
    enter(&mut h, 1);
}

#[test]
#[should_panic(expected = "CannotAdvance")]
fn cannot_advance_to_a_non_child() {
    let (mut h, _) = setup(1);
    start(&mut h, 2);
    let g = enter(&mut h, 1);
    win(&mut h, g);
    enter(&mut h, 4);
}

#[test]
#[should_panic(expected = "CurrentNodeNotCleared")]
fn cannot_leave_a_combat_node_before_winning_it() {
    let (mut h, _) = setup(1);
    start(&mut h, 2);
    enter(&mut h, 2);
}

#[test]
fn winning_the_root_credits_the_root_not_the_child() {
    let (mut h, _) = setup(1);
    start(&mut h, 2);
    let g = enter(&mut h, 1);
    win(&mut h, g);
    assert!(h.c.is_rl_node_defeated(acc(P), U64(1)));
    assert!(!h.c.is_rl_node_defeated(acc(P), U64(2)));
}

#[test]
#[should_panic(expected = "NodeAlreadyDefeated")]
fn re_entering_a_won_combat_node_reverts_sp05() {
    let (mut h, _) = setup(1);
    start(&mut h, 2);
    let g = enter(&mut h, 1);
    win(&mut h, g);
    enter(&mut h, 1);
}

// ------------------------------------------------------ stranding guard (UA-05)

#[test]
fn remove_child_guard_tracks_the_run() {
    let (mut h, _) = setup(1);
    start(&mut h, 2);
    h.ctx(OWNER, 0);
    h.c.remove_rl_child(U64(1), U64(3)); // not the last child: fine
    let g = enter(&mut h, 1);
    win(&mut h, g);
    enter(&mut h, 2); // run moves to node 2 (child: 4)
    h.ctx(OWNER, 0);
    h.c.remove_rl_child(U64(1), U64(2)); // root's last child, but nobody stands on root now
}

#[test]
#[should_panic(expected = "WouldStrandActiveRun")]
fn cannot_remove_last_child_under_a_standing_run() {
    let (mut h, _) = setup(1);
    start(&mut h, 2);
    let g = enter(&mut h, 1);
    win(&mut h, g);
    enter(&mut h, 2);
    h.ctx(OWNER, 0);
    h.c.remove_rl_child(U64(2), U64(4));
}

// ------------------------------------------- HP persistence and completion

#[test]
fn survivor_damage_carries_forward_with_auto_heal_floor() {
    let (mut h, _) = setup(1);
    let roster = start(&mut h, 2);
    let g = enter(&mut h, 1);
    let max = h.c.get_game(U64(g)).unwrap().ship(roster[0]).max_hull_points;
    finish(&mut h, g, Side::Creator, |g| g.board.get_mut(&roster[0]).unwrap().hull_points = 10);
    let floor = (max as u16 * 80 / 100) as u8;
    assert_eq!(h.c.get_run_ship_hp(acc(P), U64(roster[0])), floor.max(10));
    let g2 = enter(&mut h, 2);
    assert_eq!(h.c.get_game(U64(g2)).unwrap().ship(roster[0]).hull_points, floor.max(10), "carried into the next fight");
}

#[test]
fn disabled_survivor_carries_at_one_hp_under_zero_floor() {
    let (mut h, _) = setup(1);
    h.ctx(OWNER, 0);
    h.c.set_rl_campaign(U64(1), U64(1), 0, 1, 1000);
    let roster = start(&mut h, 2);
    let g = enter(&mut h, 1);
    finish(&mut h, g, Side::Creator, |g| g.board.get_mut(&roster[0]).unwrap().hull_points = 0);
    assert_eq!(h.c.get_run_ship_hp(acc(P), U64(roster[0])), 1, "not the 0 = full sentinel");
}

#[test]
fn final_node_win_ends_run_won_and_releases_roster() {
    let (mut h, _) = setup(1);
    let roster = start(&mut h, 2);
    for node in [1, 2, 4] {
        let g = enter(&mut h, node);
        win(&mut h, g);
    }
    assert_eq!(run(&h).status, RunStatus::Won);
    assert!(roster.iter().all(|&s| !h.ship(s).ship.ship_data.in_fleet));
}

#[test]
fn node_final_at_entry_stays_final_even_if_child_added_mid_fight_ua11() {
    let (mut h, _) = setup(1);
    start(&mut h, 2);
    for node in [1, 2] {
        let g = enter(&mut h, node);
        win(&mut h, g);
    }
    let g = enter(&mut h, 4);
    h.ctx(OWNER, 0);
    h.c.add_rl_child(U64(4), U64(3));
    win(&mut h, g);
    assert_eq!(run(&h).status, RunStatus::Won);
}

#[test]
fn heal_floor_pinned_at_entry_ua11() {
    let (mut h, _) = setup(1);
    let roster = start(&mut h, 2);
    let g = enter(&mut h, 1);
    h.ctx(OWNER, 0);
    h.c.set_rl_campaign(U64(1), U64(1), 0, 1, 1000);
    let max = h.c.get_game(U64(g)).unwrap().ship(roster[0]).max_hull_points;
    finish(&mut h, g, Side::Creator, |g| g.board.get_mut(&roster[0]).unwrap().hull_points = 1);
    assert_eq!(h.c.get_run_ship_hp(acc(P), U64(roster[0])), (max as u16 * 80 / 100) as u8);
}

// ---------------------------------------------------------------- fled ships

fn retreat_ship(h: &mut H, game: u64, ship: u64) {
    let b = h.c.get_game(U64(game)).unwrap().ship(ship);
    h.ctx(P, 0);
    h.c.move_ship(U64(game), U64(ship), b.row, b.col, ActionType::Retreat, U64(0));
}

#[test]
fn retreated_ship_rejoins_at_heal_floor() {
    let (mut h, _) = setup(1);
    let roster = start(&mut h, 3);
    let g = enter(&mut h, 1);
    let max = h.c.get_game(U64(g)).unwrap().ship(roster[1]).max_hull_points;
    retreat_ship(&mut h, g, roster[1]);
    assert!(!h.ship(roster[1]).ship.ship_data.in_fleet, "fled ships leave the fleet");
    win(&mut h, g);
    let r = run(&h);
    assert!(r.reservation.contains(&roster[1]) && h.ship(roster[1]).ship.ship_data.in_fleet);
    assert_eq!(h.c.get_run_ship_hp(acc(P), U64(roster[1])), (max as u16 * 80 / 100) as u8);
}

#[test]
fn fled_ship_transferred_away_is_dropped_without_reverting() {
    let (mut h, _) = setup(1);
    h.register("bob.near", 5);
    h.buy_and_build("bob.near", 0, 2);
    let roster = start(&mut h, 3);
    let g = enter(&mut h, 1);
    retreat_ship(&mut h, g, roster[1]);
    h.ctx(P, 1);
    h.c.nft_transfer(acc("bob.near"), roster[1].to_string(), None, None);
    win(&mut h, g);
    let r = run(&h);
    assert!(!r.roster.iter().any(|e| e.0 == roster[1]));
    assert_eq!(r.roster.len(), 2);
}

#[test]
fn falls_back_to_survivors_when_rejoiner_breaks_cost_cap() {
    let (mut h, _) = setup(1);
    let roster = start(&mut h, 3);
    let g = enter(&mut h, 1);
    retreat_ship(&mut h, g, roster[1]);
    // Tighten the cap to exactly what the survivors cost.
    let survivors_cost: u64 = [roster[0], roster[2]].iter().map(|&s| h.ship(s).ship.ship_data.cost as u64).sum();
    let mut r = run(&h);
    r.current_cost_cap = survivors_cost;
    h.c.rl.runs.insert(acc(P), r);
    win(&mut h, g);
    let r = run(&h);
    assert_eq!(r.reservation.len(), 2);
    assert!(!r.reservation.contains(&roster[1]));
    assert!(!h.ship(roster[1]).ship.ship_data.in_fleet);
}

// -------------------------------------------------------------- win effects

#[test]
fn dec_bonus_win_effect_mints_to_player() {
    let (mut h, _) = setup(1);
    h.ctx(OWNER, 0);
    h.c.set_rl_node_win_effects(U64(1), vec![WinEffect::DecBonus { amount: U128(7) }]);
    start(&mut h, 2);
    let g = enter(&mut h, 1);
    win(&mut h, g);
    assert_eq!(h.c.mt_balance_of(acc(P), "dec".into()).0, 7);
}

fn grant(variant: u16, once: bool) -> ShipGrant {
    ShipGrant {
        name: "Prize".into(),
        equipment: Equipment { main_weapon: MainWeapon::Sniper, ..Default::default() },
        colors: Colors { h1: 10, s1: 20, l1: 30, h2: 0, s2: 0, l2: 0 },
        variant,
        accuracy: 2,
        hull: 1,
        speed: 0,
        ships_destroyed: 100,
        shiny: true,
        is_free_ship: true,
        once_per_address: once,
    }
}

#[test]
fn ship_grant_mints_every_property_without_the_gate_nft() {
    let (mut h, _) = setup(1);
    h.ctx(OWNER, 0);
    h.c.set_rl_node_win_effects(U64(1), vec![WinEffect::ShipGrant(grant(2, false))]); // variant 2 is medal-gated
    start(&mut h, 2);
    let before = h.owned(P).len();
    let g = enter(&mut h, 1);
    win(&mut h, g);
    let ids = h.owned(P);
    assert_eq!(ids.len(), before + 1);
    let s = h.ship(*ids.last().unwrap()).ship;
    assert_eq!((s.name.as_str(), s.traits.variant, s.traits.accuracy, s.ship_data.ships_destroyed, s.ship_data.shiny, s.ship_data.is_free_ship), ("Prize", 2, 2, 100, true, true));
    assert!(s.ship_data.constructed);
}

#[test]
fn once_per_address_grant_only_once_across_runs() {
    let (mut h, _) = setup(1);
    h.ctx(OWNER, 0);
    h.c.set_rl_node_win_effects(U64(1), vec![WinEffect::ShipGrant(grant(1, true))]);
    let before = h.owned(P).len();
    for _ in 0..2 {
        start(&mut h, 2);
        let g = enter(&mut h, 1);
        win(&mut h, g);
        h.ctx(P, 0);
        h.c.retreat_run(U64(0));
    }
    assert_eq!(h.owned(P).len(), before + 1);
}

#[test]
fn heal_above_floor_and_grant_apply_on_the_same_win() {
    let (mut h, _) = setup(1);
    h.ctx(OWNER, 0);
    h.c.set_rl_campaign(U64(1), U64(1), 10, 1, 1000);
    h.c.set_rl_node_win_effects(U64(1), vec![WinEffect::HealAboveFloor { percent: 90 }, WinEffect::ShipGrant(grant(1, false))]);
    let roster = start(&mut h, 2);
    let before = h.owned(P).len();
    let g = enter(&mut h, 1);
    let max = h.c.get_game(U64(g)).unwrap().ship(roster[0]).max_hull_points;
    finish(&mut h, g, Side::Creator, |g| g.board.get_mut(&roster[0]).unwrap().hull_points = 1);
    assert_eq!(h.c.get_run_ship_hp(acc(P), U64(roster[0])), (max as u16 * 90 / 100) as u8);
    assert_eq!(h.owned(P).len(), before + 1);
}

#[test]
fn failing_win_effect_still_completes_the_win() {
    let (mut h, _) = setup(1);
    h.ctx(OWNER, 0);
    h.c.set_rl_node_win_effects(U64(1), vec![WinEffect::ShipGrant(grant(1, false)), WinEffect::DecBonus { amount: U128(3) }]);
    start(&mut h, 2);
    let g = enter(&mut h, 1);
    // Drain the player's spare storage so the grant can't be covered.
    let mut a = h.c.accounts.get(&acc(P)).cloned().unwrap();
    a.deposit = a.locked();
    h.c.accounts.insert(acc(P), a);
    let before = h.owned(P).len();
    win(&mut h, g);
    assert!(h.c.is_rl_node_defeated(acc(P), U64(1)), "win recorded");
    assert_eq!(h.owned(P).len(), before, "grant skipped");
    assert_eq!(h.c.mt_balance_of(acc(P), "dec".into()).0, 3, "later effects still run");
}

#[test]
#[should_panic(expected = "NotOwner")]
fn win_effects_are_owner_only() {
    let (mut h, _) = setup(1);
    h.ctx("mallory.near", 0);
    h.c.set_rl_node_win_effects(U64(1), vec![WinEffect::DecBonus { amount: U128(1_000_000) }]);
}

#[test]
#[should_panic(expected = "NodeNotFound")]
fn win_effects_need_an_existing_node() {
    let (mut h, _) = setup(1);
    h.ctx(OWNER, 0);
    h.c.set_rl_node_win_effects(U64(99), vec![]);
}

#[test]
#[should_panic(expected = "InvalidTraitValue")]
fn grants_are_validated() {
    let (mut h, _) = setup(1);
    let mut g = grant(1, false);
    g.speed = 3;
    h.ctx(OWNER, 0);
    h.c.set_rl_node_win_effects(U64(1), vec![WinEffect::ShipGrant(g)]);
}

#[test]
fn killing_a_variant2_roguelike_ai_ship_pays_dec_not_utc() {
    let (mut h, _) = setup(2);
    let roster = start(&mut h, 2);
    let g = enter(&mut h, 1);
    h.ctx(P, 0);
    let (gs, mut m) = h.c.load_rl(g);
    h.c.apply_rl_events(g, &mut m, &gs, &[EngineEvent::ShipDestroyed { ship_id: AI_ID, last_damager: roster[0] }]);
    assert_eq!(h.c.mt_balance_of(acc(P), "dec".into()).0, 1);
    assert_eq!(h.utc(P), 0);
}

#[test]
fn ai_ships_carry_config_shiny_and_kills() {
    let (mut h, _) = setup(1);
    start(&mut h, 2);
    let g = enter(&mut h, 1);
    let m = h.c.get_rl_match(U64(g)).unwrap();
    let ai = &m.ai_ships[0].1;
    assert_eq!((ai.ship_data.shiny, ai.ship_data.ships_destroyed), (true, 30));
}

// ------------------------------------------------------------------ retreat

#[test]
fn retreat_between_nodes_ends_run_and_releases_roster() {
    let (mut h, _) = setup(1);
    let roster = start(&mut h, 2);
    h.ctx(P, 0);
    h.c.retreat_run(U64(0));
    assert_eq!(run(&h).status, RunStatus::Ended);
    assert!(roster.iter().all(|&s| !h.ship(s).ship.ship_data.in_fleet));
    assert_eq!(h.c.get_active_runs_at_node(U64(1)).0, 0);
}

#[test]
fn retreat_mid_combat_ends_run_like_a_loss() {
    let (mut h, _) = setup(1);
    let roster = start(&mut h, 2);
    let g = enter(&mut h, 1);
    h.ctx(P, 0);
    h.c.retreat_run(U64(g));
    let r = run(&h);
    assert_eq!((r.status, r.active_game_id), (RunStatus::Ended, 0));
    assert!(roster.iter().all(|&s| !h.ship(s).ship.ship_data.in_fleet));
}

#[test]
#[should_panic(expected = "NotYourGame")]
fn cannot_retreat_someone_elses_game() {
    let (mut h, _) = setup(1);
    start(&mut h, 2);
    let g = enter(&mut h, 1);
    h.register("bob.near", 5);
    h.buy_and_build("bob.near", 0, 1);
    let bob_ship = h.owned("bob.near")[0];
    h.ctx("bob.near", 0);
    h.c.start_run(U64(1), vec![U64(bob_ship)]);
    h.c.retreat_run(U64(g));
}

#[test]
#[should_panic(expected = "ActiveGameInProgress")]
fn retreat_zero_reverts_while_combat_is_live_sp04() {
    let (mut h, _) = setup(1);
    start(&mut h, 2);
    enter(&mut h, 1);
    h.ctx(P, 0);
    h.c.retreat_run(U64(0));
}

#[test]
fn active_game_cleared_after_a_win_sp04() {
    let (mut h, _) = setup(1);
    start(&mut h, 2);
    let g = enter(&mut h, 1);
    win(&mut h, g);
    assert_eq!(run(&h).active_game_id, 0);
}

#[test]
#[should_panic(expected = "ActiveGameInProgress")]
fn enter_resupply_reverts_during_combat_ha2_04() {
    let (mut h, _) = setup(1);
    start(&mut h, 2);
    enter(&mut h, 1);
    h.ctx(P, 0);
    h.c.enter_resupply_node(U64(3));
}

// ------------------------------------------------------------------ resupply

fn at_resupply(h: &mut H) -> Vec<u64> {
    let roster = start(h, 2);
    let g = enter(h, 1);
    finish(h, g, Side::Creator, |g| g.board.get_mut(&roster[0]).unwrap().hull_points = 1);
    h.ctx(P, 0);
    h.c.enter_resupply_node(U64(3));
    roster
}

#[test]
fn resupply_node_applies_cost_cap_override_and_can_always_be_left() {
    let (mut h, _) = setup(1);
    at_resupply(&mut h);
    assert_eq!(run(&h).current_cost_cap, 5000);
    enter(&mut h, 4);
}

#[test]
fn repair_full_heals_and_charges_per_missing_hp() {
    let (mut h, _) = setup(1);
    let roster = at_resupply(&mut h);
    let hp = h.c.get_run_ship_hp(acc(P), U64(roster[0]));
    let max = h.c.current_attrs(roster[0]).unwrap().max_hull_points;
    h.mint(P, TokenKind::Utc, 100 * E18);
    h.ctx(P, 0);
    h.c.resupply_repair(vec![U64(roster[0])]);
    assert_eq!(h.c.get_run_ship_hp(acc(P), U64(roster[0])), max);
    assert_eq!(100 * E18 - h.utc(P), (max - hp) as u128 * E18 / 100);
}

#[test]
#[should_panic(expected = "InsufficientFunds")]
fn repair_without_utc_reverts() {
    let (mut h, _) = setup(1);
    let roster = at_resupply(&mut h);
    h.ctx(P, 0);
    h.c.resupply_repair(vec![U64(roster[0])]);
}

#[test]
#[should_panic(expected = "NotResupplyNode")]
fn repair_away_from_resupply_reverts() {
    let (mut h, _) = setup(1);
    let roster = start(&mut h, 2);
    h.ctx(P, 0);
    h.c.resupply_repair(vec![U64(roster[0])]);
}

#[test]
fn modify_roster_adds_and_removes_and_rereserves() {
    let (mut h, _) = setup(1);
    let roster = at_resupply(&mut h);
    let extra = cheapest(&h, 1)[0];
    h.ctx(P, 0);
    h.c.resupply_modify_roster(vec![U64(extra)], vec![U64(roster[1])]);
    let r = run(&h);
    assert_eq!(r.reservation, vec![roster[0], extra]);
    assert!(h.ship(extra).ship.ship_data.in_fleet && !h.ship(roster[1]).ship.ship_data.in_fleet);
    // The removed ship's HP is stashed and comes back if it rejoins (RoguelikeRun).
    assert_eq!(h.c.get_run_ship_hp(acc(P), U64(roster[0])) != 0, true);
}

#[test]
#[should_panic(expected = "ShipNotOwned")]
fn modify_roster_rejects_others_ships() {
    let (mut h, _) = setup(1);
    h.buy_and_build("bob.near", 0, 1);
    at_resupply(&mut h);
    let bobs = h.owned("bob.near")[0];
    h.ctx(P, 0);
    h.c.resupply_modify_roster(vec![U64(bobs)], vec![]);
}

#[test]
#[should_panic(expected = "ShipCostVersionMismatch")]
fn resupply_requires_current_prices_for_added_ships_ha6_09() {
    let (mut h, _) = setup(1);
    at_resupply(&mut h);
    h.ctx(OWNER, 0);
    let c = h.c.get_costs(1).unwrap();
    h.c.set_costs(1, c);
    let extra = cheapest(&h, 1)[0];
    h.ctx(P, 0);
    h.c.resupply_modify_roster(vec![U64(extra)], vec![]);
}

#[test]
fn price_change_mid_run_doesnt_block_the_next_fight_ha6_09() {
    let (mut h, _) = setup(1);
    start(&mut h, 2);
    let g = enter(&mut h, 1);
    h.ctx(OWNER, 0);
    let c = h.c.get_costs(1).unwrap();
    h.c.set_costs(1, c);
    win(&mut h, g);
    enter(&mut h, 2);
}

#[test]
#[should_panic(expected = "WrongCampaignVariant")]
fn required_variant_pinned_at_start_ua16() {
    let (mut h, _) = setup(1);
    at_resupply(&mut h);
    h.ctx(OWNER, 0);
    h.c.set_rl_campaign(U64(1), U64(1), 80, 0, 1000); // admin relaxes the rule mid-run
    h.c.owner_mint_medal(acc(P));
    h.ctx(P, 0);
    let v2 = h.c.claim_free_ships(2);
    h.resolve_all();
    h.ctx(P, 0);
    h.c.resupply_modify_roster(vec![v2[0]], vec![]);
}

#[test]
fn ai_that_cannot_decide_passes_ha6_12() {
    let (mut h, _) = setup(1);
    h.ctx(OWNER, 0);
    h.c.set_rl_campaign(U64(1), U64(1), 80, 1, 1000);
    h.c.set_faction_resolver(1, None); // Variant1AI needs the Ram range: decide fails
    let roster = start(&mut h, 2);
    let g = enter(&mut h, 1);
    let b = h.c.get_game(U64(g)).unwrap().ship(roster[0]);
    h.ctx(P, 0);
    h.c.move_ship(U64(g), U64(roster[0]), b.row, b.col, ActionType::Pass, U64(0));
    h.ctx("anyone.near", 0);
    assert!(h.c.take_ai_turns(U64(g), 1) >= 1);
}

// ------------------------------------------------------- run ledger (RoguelikeRun)

#[test]
fn ledger_keeps_hp_for_a_ship_that_leaves_and_returns_and_resets_per_generation() {
    let (mut h, _) = setup(1);
    let p = acc(P);
    let mut r = h.c.get_run(p.clone());
    r.generation = 1;
    r.roster = vec![(1, 40), (2, 0)];
    h.c.rl.set_roster(&p, &mut r, &[2], None); // ship 1 leaves with 40 HP
    assert_eq!(h.c.rl.ship_hp(&p, &r, 1), 40);
    h.c.rl.set_roster(&p, &mut r, &[2, 1], None); // returns with it
    assert_eq!(r.roster, vec![(2, 0), (1, 40)]);
    h.c.rl.set_roster(&p, &mut r, &[2, 1], Some(&[7, 8]));
    assert_eq!(r.roster, vec![(2, 7), (1, 8)]);
    h.c.rl.set_ship_hp(&p, &mut r, 3, 55); // outside the roster: stashed
    assert_eq!(h.c.rl.ship_hp(&p, &r, 3), 55);
    r.generation = 2; // a new run starts clean
    assert_eq!(h.c.rl.ship_hp(&p, &r, 3), 0);
}

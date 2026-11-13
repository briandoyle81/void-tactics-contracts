//! Phase 3 ports: Lobbies.test.ts and PvPMatch.test.ts. Architecture-only
//! cases have no NEAR counterpart (single contract: no allowlisted Lobbies ->
//! Fleets call, no repointable engine addresses (UA-02/UA-10), no external
//! results recorder to revoke (UA-03)); PvP never had win effects (HA6-27).

use super::*;
use crate::pvp::LobbyStatus;
use near_sdk::json_types::{U128, U64};
use vt_core::engine::{MoveInput, Side};
use vt_core::types::{ActionType, MapMode, Position};

const UTC: u128 = E18;
const DAY: u64 = 24 * 3600;

fn pos(row: i16, col: i16) -> Position {
    Position { row, col }
}

/// Owner-created PvP maps: 1 = PvP, 2 = PvE, 3 = Both.
fn with_maps(h: &mut H) {
    h.ctx(OWNER, 0);
    for mode in [MapMode::PvP, MapMode::PvE, MapMode::Both] {
        h.c.create_preset_map(vec![], vec![], vec![], mode);
    }
}

fn setup(players: &[&str]) -> H {
    let mut h = H::new();
    with_maps(&mut h);
    for p in players {
        h.register(p, 5);
        h.buy_and_build(p, 0, 1);
    }
    h
}

fn create(h: &mut H, who: &str, reserved: Option<&str>) -> u64 {
    h.ctx(who, 0);
    h.c.create_lobby(1000, 300, true, U64(0), 100, reserved.map(acc)).0
}

fn join(h: &mut H, who: &str, id: u64) {
    h.ctx(who, 0);
    h.c.join_lobby(U64(id));
}

/// Cheapest ships first, under the cap, max 3.
fn fleet(h: &H, who: &str, cap: u64) -> Vec<u64> {
    let mut v: Vec<(u16, u64)> = h.owned(who).into_iter().map(|id| (h.ship(id).ship.ship_data.cost, id)).filter(|_| true).collect();
    v.sort();
    let mut out = vec![];
    let mut total = 0u64;
    for (c, id) in v {
        if out.len() < 3 && total + c as u64 <= cap && !h.ship(id).ship.ship_data.in_fleet && h.ship(id).ship.ship_data.timestamp_destroyed == 0 {
            out.push(id);
            total += c as u64;
        }
    }
    out
}

fn submit(h: &mut H, who: &str, id: u64, is_creator: bool) -> Option<u64> {
    let ships = fleet(h, who, 1000);
    let col = if is_creator { 3 } else { 13 };
    let positions = (0..ships.len()).map(|i| pos(2 + 3 * i as i16, col)).collect();
    h.ctx(who, 0);
    h.c.create_lobby_fleet(U64(id), ships.into_iter().map(U64).collect(), positions).map(|g| g.0)
}

fn account(h: &H, who: &str) -> crate::storage_ledger::Account {
    h.c.accounts.get(&acc(who)).cloned().unwrap()
}

// ------------------------------------------------------------ creation

#[test]
fn creates_lobby_with_correct_initial_values() {
    let mut h = setup(&["alice.near"]);
    let id = create(&mut h, "alice.near", None);
    let l = h.c.get_lobby(U64(id)).unwrap();
    assert_eq!((l.creator, l.cost_limit, l.turn_time, l.status), (acc("alice.near"), 1000, 300, LobbyStatus::Open));
    assert!(h.c.is_lobby_open(U64(id)));
    assert_eq!(h.c.get_player_lobbies(acc("alice.near")), vec![U64(id)]);
    let st = h.c.get_player_lobby_state(acc("alice.near"));
    assert!(st.has_active_lobby && st.active_lobbies_count == 1 && st.active_lobby_id.0 == id);
}

#[test]
#[should_panic(expected = "InvalidTurnTime")]
fn rejects_59_second_turn_time() {
    let mut h = setup(&["alice.near"]);
    h.ctx("alice.near", 0);
    h.c.create_lobby(1000, 59, true, U64(0), 100, None);
}

#[test]
fn accepts_60_second_turn_time() {
    let mut h = setup(&["alice.near"]);
    h.ctx("alice.near", 0);
    h.c.create_lobby(1000, 60, true, U64(0), 100, None);
}

#[test]
#[should_panic(expected = "InvalidMapId")]
fn rejects_pve_only_map() {
    let mut h = setup(&["alice.near"]);
    h.ctx("alice.near", 0);
    h.c.create_lobby(1000, 300, true, U64(2), 100, None);
}

#[test]
fn accepts_pvp_and_both_maps() {
    let mut h = setup(&["alice.near"]);
    h.mint("alice.near", TokenKind::Utc, 10 * UTC);
    h.ctx("alice.near", 0);
    h.c.create_lobby(1000, 300, true, U64(1), 100, None);
    h.c.create_lobby(1000, 300, true, U64(3), 100, None);
}

#[test]
#[should_panic(expected = "MaxFleetCostExceeded")]
fn rejects_cost_limit_above_max() {
    let mut h = setup(&["alice.near"]);
    h.ctx("alice.near", 0);
    h.c.create_lobby(2001, 300, true, U64(0), 100, None);
}

#[test]
fn additional_lobbies_cost_a_fee() {
    let mut h = setup(&["alice.near"]);
    create(&mut h, "alice.near", None); // free
    h.mint("alice.near", TokenKind::Utc, UTC);
    create(&mut h, "alice.near", None); // 1 UTC
    assert_eq!(h.utc("alice.near"), 0);
    assert_eq!(h.c.config.treasury_utc, UTC);
}

#[test]
#[should_panic(expected = "InsufficientUTC")]
fn second_lobby_without_utc_reverts() {
    let mut h = setup(&["alice.near"]);
    create(&mut h, "alice.near", None);
    create(&mut h, "alice.near", None);
}

#[test]
fn active_lobbies_decrement_on_start_and_on_leave() {
    let mut h = setup(&["alice.near", "bob.near", "carol.near"]);
    let id = create(&mut h, "alice.near", None);
    join(&mut h, "bob.near", id);
    submit(&mut h, "alice.near", id, true);
    let game = submit(&mut h, "bob.near", id, false);
    assert!(game.is_some());
    assert_eq!(account(&h, "alice.near").active_lobbies_count, 0);
    assert_eq!(account(&h, "bob.near").active_lobbies_count, 0);
    let id2 = create(&mut h, "carol.near", None);
    h.ctx("carol.near", 0);
    h.c.leave_lobby(U64(id2));
    assert_eq!(account(&h, "carol.near").active_lobbies_count, 0);
}

#[test]
fn owner_creates_lobby_for_two_addresses_and_they_start_a_game() {
    let mut h = setup(&["alice.near", "bob.near"]);
    h.ctx(OWNER, 0);
    let id = h.c.create_lobby_for_addresses(acc("alice.near"), acc("bob.near"), 1000, 300, U64(0), 100).0;
    assert_eq!(h.c.get_lobby(U64(id)).unwrap().status, LobbyStatus::FleetSelection);
    submit(&mut h, "bob.near", id, false); // joiner first => joiner moves first
    let game = submit(&mut h, "alice.near", id, true).unwrap();
    assert_eq!(h.c.get_game(U64(game)).unwrap().current_turn, Side::Joiner);
}

#[test]
fn next_lobby_works_after_a_lobby_is_cancelled() {
    let mut h = setup(&["alice.near"]);
    let id = create(&mut h, "alice.near", None);
    h.ctx("alice.near", 0);
    h.c.leave_lobby(U64(id));
    create(&mut h, "alice.near", None); // free again
    assert_eq!(h.utc("alice.near"), 0);
}

// -------------------------------------------------------------- joining

#[test]
fn joins_an_open_lobby() {
    let mut h = setup(&["alice.near", "bob.near"]);
    let id = create(&mut h, "alice.near", None);
    join(&mut h, "bob.near", id);
    let l = h.c.get_lobby(U64(id)).unwrap();
    assert_eq!((l.joiner, l.status), (Some(acc("bob.near")), LobbyStatus::FleetSelection));
    assert!(!h.c.is_lobby_open(U64(id)));
}

#[test]
#[should_panic(expected = "LobbyNotFound")]
fn join_nonexistent_lobby() {
    let mut h = setup(&["bob.near"]);
    join(&mut h, "bob.near", 9);
}

#[test]
#[should_panic(expected = "LobbyNotOpen")]
fn join_full_lobby() {
    let mut h = setup(&["alice.near", "bob.near", "carol.near"]);
    let id = create(&mut h, "alice.near", None);
    join(&mut h, "bob.near", id);
    join(&mut h, "carol.near", id);
}

#[test]
#[should_panic(expected = "PlayerAlreadyInLobby")]
fn creator_cannot_join_own_lobby() {
    let mut h = setup(&["alice.near"]);
    let id = create(&mut h, "alice.near", None);
    join(&mut h, "alice.near", id);
}

#[test]
fn joining_several_lobbies_costs_a_fee_after_the_first() {
    let mut h = setup(&["alice.near", "bob.near", "carol.near"]);
    let a = create(&mut h, "alice.near", None);
    let c = create(&mut h, "carol.near", None);
    join(&mut h, "bob.near", a);
    h.mint("bob.near", TokenKind::Utc, UTC);
    join(&mut h, "bob.near", c);
    assert_eq!(h.utc("bob.near"), 0);
    assert_eq!(h.c.get_player_lobbies(acc("bob.near")).len(), 2);
}

// ------------------------------------------------------- leave / kick / quit

#[test]
fn creator_leaving_promotes_joiner_and_clears_their_fleet_sp03() {
    let mut h = setup(&["alice.near", "bob.near"]);
    let id = create(&mut h, "alice.near", None);
    join(&mut h, "bob.near", id);
    submit(&mut h, "bob.near", id, false);
    let bob_ships = h.c.get_lobby_fleet(U64(id), false).unwrap().ship_ids;
    h.ctx("alice.near", 0);
    h.c.leave_lobby(U64(id));
    let l = h.c.get_lobby(U64(id)).unwrap();
    assert_eq!((l.creator.clone(), l.joiner.clone(), l.status), (acc("bob.near"), None, LobbyStatus::Open));
    assert!(!l.joiner_fleet && h.c.get_lobby_fleet(U64(id), false).is_none());
    assert!(bob_ships.iter().all(|&s| !h.ship(s).ship.ship_data.in_fleet), "promoted creator's ships unlocked");
    assert!(h.c.is_lobby_open(U64(id)));
    assert!(h.c.get_player_lobbies(acc("alice.near")).is_empty());
}

#[test]
fn creator_leaving_alone_abandons() {
    let mut h = setup(&["alice.near"]);
    let id = create(&mut h, "alice.near", None);
    h.ctx("alice.near", 0);
    h.c.leave_lobby(U64(id));
    assert!(!h.c.is_lobby_open(U64(id)));
    assert!(h.c.get_player_lobbies(acc("alice.near")).is_empty());
}

#[test]
fn joiner_leaving_reopens() {
    let mut h = setup(&["alice.near", "bob.near"]);
    let id = create(&mut h, "alice.near", None);
    join(&mut h, "bob.near", id);
    h.ctx("bob.near", 0);
    h.c.leave_lobby(U64(id));
    let l = h.c.get_lobby(U64(id)).unwrap();
    assert_eq!((l.joiner, l.status), (None, LobbyStatus::Open));
    assert!(h.c.is_lobby_open(U64(id)));
}

#[test]
fn timing_out_a_joiner_frees_creator_ships_and_penalizes_only_if_creator_committed() {
    let mut h = setup(&["alice.near", "bob.near"]);
    let id = create(&mut h, "alice.near", None);
    join(&mut h, "bob.near", id);
    submit(&mut h, "alice.near", id, true);
    let alice_ships = h.c.get_lobby_fleet(U64(id), true).unwrap().ship_ids;
    h.now_s += 300;
    h.ctx("alice.near", 0);
    h.c.timeout_joiner(U64(id));
    assert!(alice_ships.iter().all(|&s| !h.ship(s).ship.ship_data.in_fleet));
    assert_eq!(account(&h, "bob.near").kick_count, 1);
    assert!(h.c.is_lobby_open(U64(id)));
}

#[test]
fn no_kick_penalty_when_creator_never_committed_ha4_03() {
    let mut h = setup(&["alice.near", "bob.near"]);
    let id = create(&mut h, "alice.near", None);
    join(&mut h, "bob.near", id);
    h.now_s += 300;
    h.ctx("alice.near", 0);
    h.c.timeout_joiner(U64(id));
    assert_eq!(account(&h, "bob.near").kick_count, 0);
}

#[test]
#[should_panic(expected = "TimeoutNotReached")]
fn timeout_joiner_too_early() {
    let mut h = setup(&["alice.near", "bob.near"]);
    let id = create(&mut h, "alice.near", None);
    join(&mut h, "bob.near", id);
    h.now_s += 299;
    h.ctx("alice.near", 0);
    h.c.timeout_joiner(U64(id));
}

#[test]
#[should_panic(expected = "KickedFromLobby")]
fn kicked_joiner_cannot_rejoin_that_lobby_ha6_29() {
    let mut h = setup(&["alice.near", "bob.near"]);
    let id = create(&mut h, "alice.near", None);
    join(&mut h, "bob.near", id);
    h.now_s += 300;
    h.ctx("alice.near", 0);
    h.c.timeout_joiner(U64(id));
    join(&mut h, "bob.near", id);
}

#[test]
fn kicked_joiner_can_join_other_lobbies_after_penalty() {
    let mut h = setup(&["alice.near", "bob.near", "carol.near"]);
    let id = create(&mut h, "alice.near", None);
    join(&mut h, "bob.near", id);
    submit(&mut h, "alice.near", id, true);
    h.now_s += 300;
    h.ctx("alice.near", 0);
    h.c.timeout_joiner(U64(id));
    let other = create(&mut h, "carol.near", None);
    h.now_s += 3600; // 1 kick = 1 hour
    join(&mut h, "bob.near", other);
}

#[test]
#[should_panic(expected = "PlayerInTimeout")]
fn kicked_player_in_timeout_cannot_create() {
    let mut h = setup(&["alice.near", "bob.near"]);
    let id = create(&mut h, "alice.near", None);
    join(&mut h, "bob.near", id);
    submit(&mut h, "alice.near", id, true);
    h.now_s += 300;
    h.ctx("alice.near", 0);
    h.c.timeout_joiner(U64(id));
    create(&mut h, "bob.near", None);
}

#[test]
fn joiner_quits_with_penalty_against_absent_creator() {
    let mut h = setup(&["alice.near", "bob.near"]);
    let id = create(&mut h, "alice.near", None);
    join(&mut h, "bob.near", id);
    submit(&mut h, "bob.near", id, false);
    let bob_ships = h.c.get_lobby_fleet(U64(id), false).unwrap().ship_ids;
    h.now_s += 300;
    h.ctx("bob.near", 0);
    h.c.quit_with_penalty(U64(id));
    assert_eq!(account(&h, "alice.near").kick_count, 1);
    assert!(bob_ships.iter().all(|&s| !h.ship(s).ship.ship_data.in_fleet));
    assert_eq!(h.c.get_lobby(U64(id)).unwrap().joiner, None);
}

#[test]
fn player_in_several_lobbies_can_leave_any_ha6_10() {
    let mut h = setup(&["alice.near", "bob.near", "carol.near"]);
    let a = create(&mut h, "alice.near", None);
    let c = create(&mut h, "carol.near", None);
    join(&mut h, "bob.near", a);
    h.mint("bob.near", TokenKind::Utc, UTC);
    join(&mut h, "bob.near", c);
    h.ctx("bob.near", 0);
    h.c.leave_lobby(U64(a)); // not the last one recorded
    assert_eq!(h.c.get_player_lobbies(acc("bob.near")), vec![U64(c)]);
}

// --------------------------------------------------------------- fleets

#[test]
#[should_panic(expected = "DuplicatePosition")]
fn fleet_rejects_duplicate_positions() {
    let mut h = setup(&["alice.near", "bob.near"]);
    let id = create(&mut h, "alice.near", None);
    join(&mut h, "bob.near", id);
    let ships = fleet(&h, "alice.near", 1000);
    h.ctx("alice.near", 0);
    h.c.create_lobby_fleet(U64(id), ships[..2].iter().map(|&s| U64(s)).collect(), vec![pos(1, 1), pos(1, 1)]);
}

#[test]
#[should_panic(expected = "InvalidPosition")]
fn fleet_rejects_creator_outside_zone() {
    let mut h = setup(&["alice.near", "bob.near"]);
    let id = create(&mut h, "alice.near", None);
    join(&mut h, "bob.near", id);
    let ships = fleet(&h, "alice.near", 1000);
    h.ctx("alice.near", 0);
    h.c.create_lobby_fleet(U64(id), vec![U64(ships[0])], vec![pos(1, 4)]);
}

#[test]
#[should_panic(expected = "InvalidPosition")]
fn fleet_rejects_joiner_outside_zone() {
    let mut h = setup(&["alice.near", "bob.near"]);
    let id = create(&mut h, "alice.near", None);
    join(&mut h, "bob.near", id);
    let ships = fleet(&h, "bob.near", 1000);
    h.ctx("bob.near", 0);
    h.c.create_lobby_fleet(U64(id), vec![U64(ships[0])], vec![pos(1, 12)]);
}

#[test]
#[should_panic(expected = "ShipNotOwned")]
fn fleet_rejects_someone_elses_ship() {
    let mut h = setup(&["alice.near", "bob.near"]);
    let id = create(&mut h, "alice.near", None);
    join(&mut h, "bob.near", id);
    let bobs = fleet(&h, "bob.near", 1000);
    h.ctx("alice.near", 0);
    h.c.create_lobby_fleet(U64(id), vec![U64(bobs[0])], vec![pos(1, 1)]);
}

#[test]
#[should_panic(expected = "FleetAlreadyCreated")]
fn fleet_only_once_per_side() {
    let mut h = setup(&["alice.near", "bob.near"]);
    let id = create(&mut h, "alice.near", None);
    join(&mut h, "bob.near", id);
    submit(&mut h, "alice.near", id, true);
    submit(&mut h, "alice.near", id, true);
}

// ------------------------------------------------------------- tracking

#[test]
fn tracks_open_lobbies_with_pagination() {
    let mut h = setup(&["alice.near", "bob.near", "carol.near"]);
    let ids: Vec<u64> = ["alice.near", "bob.near", "carol.near"].iter().map(|p| create(&mut h, p, None)).collect();
    assert_eq!(h.c.get_open_lobby_count(), 3);
    let mut pages: Vec<U64> = h.c.get_open_lobbies(Some(0), Some(2));
    pages.extend(h.c.get_open_lobbies(Some(2), Some(2)));
    assert_eq!(pages, h.c.get_open_lobbies(None, None));
    assert_eq!(pages.iter().map(|x| x.0).collect::<Vec<_>>(), ids);
}

#[test]
fn game_start_cleans_up_lobby_tracking() {
    let mut h = setup(&["alice.near", "bob.near"]);
    let id = create(&mut h, "alice.near", None);
    join(&mut h, "bob.near", id);
    submit(&mut h, "alice.near", id, true);
    submit(&mut h, "bob.near", id, false).unwrap();
    assert!(h.c.get_player_lobbies(acc("alice.near")).is_empty());
    assert!(h.c.get_player_lobbies(acc("bob.near")).is_empty());
    assert_eq!(h.c.get_lobby(U64(id)).unwrap().status, LobbyStatus::InGame);
    assert!(!h.c.is_lobby_open(U64(id)));
}

// ---------------------------------------------------------- reservation

#[test]
fn reserved_lobby_charges_one_utc_and_owner_can_withdraw_it_ha3_01() {
    let mut h = setup(&["alice.near", "bob.near"]);
    h.mint("alice.near", TokenKind::Utc, UTC);
    create(&mut h, "alice.near", Some("bob.near"));
    assert_eq!(h.utc("alice.near"), 0);
    h.ctx(OWNER, 0);
    h.c.withdraw_utc(U128(UTC), acc("bob.near"));
    assert_eq!(h.utc("bob.near"), UTC);
}

#[test]
#[should_panic(expected = "NotReservedJoiner")]
fn non_reserved_player_cannot_join_reserved_lobby() {
    let mut h = setup(&["alice.near", "bob.near", "carol.near"]);
    h.mint("alice.near", TokenKind::Utc, UTC);
    let id = create(&mut h, "alice.near", Some("bob.near"));
    join(&mut h, "carol.near", id);
}

#[test]
fn reserved_player_accepts() {
    let mut h = setup(&["alice.near", "bob.near"]);
    h.mint("alice.near", TokenKind::Utc, UTC);
    let id = create(&mut h, "alice.near", Some("bob.near"));
    h.ctx("bob.near", 0);
    h.c.accept_game(U64(id));
    let l = h.c.get_lobby(U64(id)).unwrap();
    assert_eq!((l.joiner, l.reserved_joiner, l.status), (Some(acc("bob.near")), None, LobbyStatus::FleetSelection));
}

#[test]
fn reserved_player_rejects_and_lobby_opens_to_anyone() {
    let mut h = setup(&["alice.near", "bob.near", "carol.near"]);
    h.mint("alice.near", TokenKind::Utc, UTC);
    let id = create(&mut h, "alice.near", Some("bob.near"));
    h.ctx("bob.near", 0);
    h.c.reject_game(U64(id));
    join(&mut h, "carol.near", id);
}

#[test]
#[should_panic(expected = "NotReservedJoiner")]
fn non_reserved_player_cannot_accept() {
    let mut h = setup(&["alice.near", "bob.near", "carol.near"]);
    h.mint("alice.near", TokenKind::Utc, UTC);
    let id = create(&mut h, "alice.near", Some("bob.near"));
    h.ctx("carol.near", 0);
    h.c.accept_game(U64(id));
}

#[test]
#[should_panic(expected = "NotReservedJoiner")]
fn non_reserved_player_cannot_reject() {
    let mut h = setup(&["alice.near", "bob.near", "carol.near"]);
    h.mint("alice.near", TokenKind::Utc, UTC);
    let id = create(&mut h, "alice.near", Some("bob.near"));
    h.ctx("carol.near", 0);
    h.c.reject_game(U64(id));
}

#[test]
#[should_panic(expected = "PlayerAlreadyInLobby")]
fn cannot_reserve_for_self() {
    let mut h = setup(&["alice.near"]);
    h.mint("alice.near", TokenKind::Utc, UTC);
    create(&mut h, "alice.near", Some("alice.near"));
}

#[test]
#[should_panic(expected = "InsufficientUTC")]
fn reserving_without_utc_reverts() {
    let mut h = setup(&["alice.near", "bob.near"]);
    create(&mut h, "alice.near", Some("bob.near"));
}

#[test]
fn reservation_cleared_when_reserved_player_joins_then_leaves_ha2_05() {
    let mut h = setup(&["alice.near", "bob.near", "carol.near"]);
    h.mint("alice.near", TokenKind::Utc, UTC);
    let id = create(&mut h, "alice.near", Some("bob.near"));
    join(&mut h, "bob.near", id);
    h.ctx("bob.near", 0);
    h.c.leave_lobby(U64(id));
    join(&mut h, "carol.near", id);
}

#[test]
fn reservation_cleared_when_reserved_player_is_promoted_ha2_05() {
    let mut h = setup(&["alice.near", "bob.near", "carol.near"]);
    h.mint("alice.near", TokenKind::Utc, UTC);
    let id = create(&mut h, "alice.near", Some("bob.near"));
    h.ctx("bob.near", 0);
    h.c.accept_game(U64(id));
    h.ctx("alice.near", 0);
    h.c.leave_lobby(U64(id));
    assert_eq!(h.c.get_lobby(U64(id)).unwrap().reserved_joiner, None);
    join(&mut h, "carol.near", id);
}

// -------------------------------------------------------------- pruning

#[test]
fn stale_threshold_defaults_to_seven_days() {
    let h = setup(&[]);
    assert_eq!(h.c.pvp.stale_threshold_s, 7 * DAY);
}

#[test]
#[should_panic(expected = "LobbyNotStaleYet")]
fn prune_before_threshold_reverts() {
    let mut h = setup(&["alice.near"]);
    let id = create(&mut h, "alice.near", None);
    h.now_s += 7 * DAY - 1;
    h.ctx("mallory.near", 0);
    h.c.prune_stale_lobby(U64(id));
}

#[test]
fn anyone_prunes_a_stale_lobby_and_the_refund_goes_to_the_creator() {
    let mut h = setup(&["alice.near", "mallory.near"]);
    let id = create(&mut h, "alice.near", None);
    let (alice0, mallory0) = (account(&h, "alice.near").used_bytes, account(&h, "mallory.near").used_bytes);
    h.now_s += 7 * DAY;
    h.ctx("mallory.near", 0);
    h.c.prune_stale_lobby(U64(id));
    assert!(!h.c.is_lobby_open(U64(id)));
    assert!(account(&h, "alice.near").used_bytes < alice0, "creator refunded");
    assert_eq!(account(&h, "mallory.near").used_bytes, mallory0, "pruner gains nothing");
}

#[test]
#[should_panic(expected = "LobbyNotOpen")]
fn prune_joined_lobby_reverts() {
    let mut h = setup(&["alice.near", "bob.near"]);
    let id = create(&mut h, "alice.near", None);
    join(&mut h, "bob.near", id);
    h.now_s += 7 * DAY;
    h.ctx("mallory.near", 0);
    h.c.prune_stale_lobby(U64(id));
}

#[test]
#[should_panic(expected = "LobbyNotStaleYet")]
fn staleness_measured_from_last_reopen() {
    let mut h = setup(&["alice.near", "bob.near"]);
    let id = create(&mut h, "alice.near", None);
    h.now_s += 6 * DAY;
    join(&mut h, "bob.near", id);
    h.ctx("bob.near", 0);
    h.c.leave_lobby(U64(id)); // reopens now
    h.now_s += 2 * DAY; // 8 days since creation, 2 since reopening
    h.ctx("mallory.near", 0);
    h.c.prune_stale_lobby(U64(id));
}

#[test]
fn owner_changes_stale_threshold() {
    let mut h = setup(&["alice.near"]);
    h.ctx(OWNER, 0);
    h.c.set_lobby_config(1, U128(UTC), U128(UTC), 2000, DAY);
    let id = create(&mut h, "alice.near", None);
    h.now_s += DAY;
    h.ctx("mallory.near", 0);
    h.c.prune_stale_lobby(U64(id));
}

#[test]
#[should_panic(expected = "NotOwner")]
fn non_owner_cannot_change_lobby_config() {
    let mut h = setup(&[]);
    h.ctx("mallory.near", 0);
    h.c.set_lobby_config(1, U128(UTC), U128(UTC), 2000, DAY);
}

// ----------------------------------------------------------------- match

fn start_game(h: &mut H) -> (u64, u64) {
    let id = create(h, "alice.near", None);
    join(h, "bob.near", id);
    submit(h, "alice.near", id, true);
    let g = submit(h, "bob.near", id, false).unwrap();
    (id, g)
}

#[test]
fn flee_ends_the_game_for_the_opponent_and_records_stats() {
    let mut h = setup(&["alice.near", "bob.near"]);
    let (lobby, g) = start_game(&mut h);
    let ships = h.c.get_lobby_fleet(U64(lobby), true).unwrap().ship_ids;
    h.ctx("bob.near", 0);
    h.c.flee(U64(g));
    let r = h.c.get_game_result(U64(g)).unwrap();
    assert_eq!((r.winner, r.loser), (acc("alice.near"), acc("bob.near")));
    assert_eq!((account(&h, "alice.near").wins, account(&h, "bob.near").losses), (1, 1));
    assert!(ships.iter().all(|&s| !h.ship(s).ship.ship_data.in_fleet), "fleets released");
    assert!(h.c.get_lobby_fleet(U64(lobby), true).is_none());
}

#[test]
#[should_panic(expected = "NotInGame")]
fn outsider_cannot_flee() {
    let mut h = setup(&["alice.near", "bob.near"]);
    let (_, g) = start_game(&mut h);
    h.ctx("mallory.near", 0);
    h.c.flee(U64(g));
}

#[test]
#[should_panic(expected = "TurnTimeoutNotReached")]
fn timeout_claim_too_early() {
    let mut h = setup(&["alice.near", "bob.near"]);
    let (_, g) = start_game(&mut h);
    h.now_s += 300; // must be strictly greater
    h.ctx("alice.near", 0);
    h.c.end_game_on_timeout(U64(g));
}

#[test]
#[should_panic(expected = "InvalidMove")]
fn player_to_move_cannot_claim_timeout() {
    let mut h = setup(&["alice.near", "bob.near"]);
    let (_, g) = start_game(&mut h);
    let turn = h.c.get_game(U64(g)).unwrap().current_turn;
    h.now_s += 301;
    h.ctx(if turn == Side::Creator { "alice.near" } else { "bob.near" }, 0);
    h.c.end_game_on_timeout(U64(g));
}

#[test]
fn waiting_player_wins_on_timeout() {
    let mut h = setup(&["alice.near", "bob.near"]);
    let (_, g) = start_game(&mut h);
    let turn = h.c.get_game(U64(g)).unwrap().current_turn;
    let waiting = if turn == Side::Creator { "bob.near" } else { "alice.near" };
    h.now_s += 301;
    h.ctx(waiting, 0);
    h.c.end_game_on_timeout(U64(g));
    assert_eq!(h.c.get_game_result(U64(g)).unwrap().winner, acc(waiting));
}

/// Scripted play: the side to move shoots if it legally can, else advances
/// toward the nearest enemy, else passes. Legality is checked on a clone.
fn play_out(h: &mut H, g: u64) {
    for _ in 0..600 {
        let state = h.c.get_game(U64(g)).unwrap();
        if state.ended {
            return;
        }
        let side = state.current_turn;
        let who = if side == Side::Creator { "alice.near" } else { "bob.near" };
        let mine: Vec<u64> = state.active(side).iter().copied().filter(|&id| state.ship(id).hull_points > 0 && !state.has_moved(id)).collect();
        let enemies: Vec<u64> = state.active(side.other()).clone();
        let me = mine[0];
        let b = state.ship(me);
        let legal = |m: &MoveInput| state.clone().move_ship(side, m, &h.c.config, 0).is_ok();
        let mut choice = None;
        'outer: for k in (0..=b.movement as i16).rev() {
            let t = enemies.iter().map(|&e| state.ship(e)).min_by_key(|t| (t.row - b.row).abs() + (t.col - b.col).abs()).unwrap();
            let (dr, dc) = (t.row - b.row, t.col - b.col);
            let uc = dc.abs().min(k);
            let ur = dr.abs().min(k - uc);
            let (r, c) = (b.row + dr.signum() * ur, b.col + dc.signum() * uc);
            for &e in &enemies {
                let m = MoveInput { ship_id: me, new_row: r, new_col: c, action: ActionType::Shoot, target_ship_id: e };
                if legal(&m) {
                    choice = Some(m);
                    break 'outer;
                }
            }
            let m = MoveInput { ship_id: me, new_row: r, new_col: c, action: ActionType::Pass, target_ship_id: 0 };
            if k > 0 && legal(&m) && choice.is_none() {
                choice = Some(m);
            }
        }
        let m = choice.unwrap_or(MoveInput { ship_id: me, new_row: b.row, new_col: b.col, action: ActionType::Pass, target_ship_id: 0 });
        h.now_s += 1;
        h.ctx(who, 0);
        h.c.move_ship(U64(g), U64(m.ship_id), m.new_row, m.new_col, m.action, U64(m.target_ship_id));
    }
    panic!("game did not end");
}

#[test]
fn full_pvp_game_pays_kill_rewards_credits_kills_and_records_result() {
    let mut h = setup(&["alice.near", "bob.near"]);
    let (lobby, g) = start_game(&mut h);
    let a_fleet = h.c.get_lobby_fleet(U64(lobby), true).unwrap().ship_ids;
    let b_fleet = h.c.get_lobby_fleet(U64(lobby), false).unwrap().ship_ids;
    let kills_before: Vec<u32> = a_fleet.iter().chain(&b_fleet).map(|&s| h.ship(s).ship.ship_data.ships_destroyed).collect();
    play_out(&mut h, g);
    let state = h.c.get_game(U64(g)).unwrap();
    // Every destroyed ship with a credited destroyer paid that ship's owner
    // recycle/4 UTC and gave the destroyer one kill.
    let mut expected_utc = [0u128; 2];
    let mut expected_kills = std::collections::HashMap::<u64, u32>::new();
    for &id in &state.gone_ship_ids {
        let b = state.ship(id);
        if b.status == 1 {
            assert_ne!(h.ship(id).ship.ship_data.timestamp_destroyed, 0, "ship {id} marked destroyed");
            if b.last_damager != 0 {
                let owner = if a_fleet.contains(&b.last_damager) { 0 } else { 1 };
                expected_utc[owner] += crate::config::ConfigState::new().recycle_reward >> 2;
                *expected_kills.entry(b.last_damager).or_default() += 1;
            }
        }
    }
    assert!(!state.gone_ship_ids.is_empty(), "the scripted game should destroy something");
    assert_eq!(h.utc("alice.near"), expected_utc[0]);
    assert_eq!(h.utc("bob.near"), expected_utc[1]);
    for (i, &s) in a_fleet.iter().chain(&b_fleet).enumerate() {
        assert_eq!(h.ship(s).ship.ship_data.ships_destroyed, kills_before[i] + expected_kills.get(&s).copied().unwrap_or(0), "kills for {s}");
        assert!(!h.ship(s).ship.ship_data.in_fleet);
    }
    if let Some(w) = state.winner {
        let r = h.c.get_game_result(U64(g)).unwrap();
        assert_eq!(r.winner, acc(if w == Side::Creator { "alice.near" } else { "bob.near" }));
    }
}

#[test]
fn participants_and_blob_writer_record_replay_blobs() {
    let mut h = setup(&["alice.near", "bob.near", "writer.near"]);
    let (_, g) = start_game(&mut h);
    h.ctx("bob.near", 0);
    h.c.flee(U64(g));
    let blob = "0x".to_string() + &"ab".repeat(32);
    h.ctx("alice.near", 0);
    h.c.record_blob(U64(g), acc("alice.near"), blob.clone());
    h.ctx(OWNER, 0);
    h.c.set_role(acc("writer.near"), crate::roles::BLOB_WRITER);
    h.ctx("writer.near", 0);
    h.c.record_blob(U64(g), acc("bob.near"), blob.clone());
    assert_eq!(h.c.get_blob(U64(g), acc("bob.near")), Some(blob));
}

#[test]
#[should_panic(expected = "NotAuthorized")]
fn strangers_cannot_record_blobs_for_players() {
    let mut h = setup(&["alice.near", "bob.near", "mallory.near"]);
    let (_, g) = start_game(&mut h);
    h.ctx("bob.near", 0);
    h.c.flee(U64(g));
    h.ctx("mallory.near", 0);
    h.c.record_blob(U64(g), acc("alice.near"), "0x".to_string() + &"ab".repeat(32));
}

#[test]
#[should_panic(expected = "GameNotComplete")]
fn blob_requires_finished_game() {
    let mut h = setup(&["alice.near", "bob.near"]);
    let (_, g) = start_game(&mut h);
    h.ctx("alice.near", 0);
    h.c.record_blob(U64(g), acc("alice.near"), "0x".to_string() + &"ab".repeat(32));
}

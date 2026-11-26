//! EVM-parity additions (2026-11-14): Ships.syncShipCosts / setCostOfShip,
//! the server minter (Ships.createShips via isAllowedToCreateShips), the
//! Maps / NodeMap / AIEncounters / RoguelikeNodeMap update paths,
//! Game.getGamesForPlayer, and views for state Base exposed through public
//! getters. Test names follow the Hardhat cases they port where one exists.

use super::*;
use crate::history::GameMode;
use crate::roguelike::{RlNodeKind, WinEffect};
use crate::single_player::{AiShipConfig, CampaignNode};
use near_sdk::json_types::{U128, U64};
use vt_core::types::{Archetype, Equipment, MapMode, Position, ScoringPosition, Traits};

const P: &str = "player.near";
const Q: &str = "other.near";
const SERVER: &str = "server.near";

fn pos(row: i16, col: i16) -> Position {
    Position { row, col }
}

fn drone(variant: u16) -> AiShipConfig {
    AiShipConfig { name: "Drone".into(), equipment: Equipment::default(), traits: Traits { variant, ..Default::default() }, archetype: Archetype::Grunt, shiny: false, ships_destroyed: 0 }
}

fn node(campaign_id: u64, map_id: u64, prerequisites: Vec<u64>) -> CampaignNode {
    CampaignNode { campaign_id, map_id, prerequisites, cost_limit: 1000, turn_time: 300, max_score: 100, creator_goes_first: true }
}

/// Map 1 (PvE, one AI drone), campaign 1, node 1; P owns 5 constructed ships.
fn sp_setup() -> H {
    let mut h = H::new();
    h.ctx(OWNER, 0);
    let map = h.c.create_preset_map(vec![], vec![], vec![], MapMode::PvE);
    let cfg = h.c.create_ai_ship_config(drone(1));
    h.c.set_map_placements(map, vec![pos(5, 16)], vec![cfg]);
    let camp = h.c.create_campaign(1);
    h.c.create_node(node(camp.0, map.0, vec![]));
    h.register(P, 5);
    h.buy_and_build(P, 0, 1);
    h
}

fn start_sp(h: &mut H, ships: &[u64]) -> u64 {
    h.ctx(P, 0);
    h.c.start_node_match(U64(1), ships.iter().map(|&i| U64(i)).collect(), (0..ships.len()).map(|i| pos(i as i16 * 2, 1)).collect()).0
}

/// Owner republishes variant 1's costs (bumping its costs version),
/// optionally raising the base cost.
fn republish_costs(h: &mut H, base_delta: u8) {
    h.ctx(OWNER, 0);
    let mut c = h.c.get_costs(1).unwrap();
    c.base_cost += base_delta;
    h.c.set_costs(1, c);
}

// ------------------------------------------------- Ships.syncShipCosts

#[test]
#[should_panic(expected = "ShipCostVersionMismatch")]
fn reverts_create_fleet_with_ship_cost_version_mismatch_when_ship_lags_global_costs_version() {
    let mut h = sp_setup();
    let ships = h.owned(P);
    republish_costs(&mut h, 0);
    start_sp(&mut h, &ships[..2]);
}

#[test]
fn after_set_costs_owner_syncs_ship_cost_and_costs_version_to_match_live_tables() {
    let mut h = sp_setup();
    let ships = h.owned(P);
    let before: Vec<u16> = ships.iter().map(|&i| h.ship(i).ship.ship_data.cost).collect();
    republish_costs(&mut h, 5);
    let live = h.c.get_costs(1).unwrap().version;
    h.ctx(P, 0);
    h.c.sync_ship_costs(ships.iter().map(|&i| U64(i)).collect());
    for (k, &id) in ships.iter().enumerate() {
        let d = &h.ship(id).ship.ship_data;
        assert_eq!(d.costs_version, live);
        assert_eq!(d.cost, before[k] + 5, "base cost +5 re-prices every ship by 5");
    }
    // ...and the fleet check accepts them again.
    start_sp(&mut h, &ships[..2]);
}

#[test]
#[should_panic(expected = "NotYourShip")]
fn sync_ship_costs_rejects_someone_elses_ship() {
    let mut h = sp_setup();
    let ships = h.owned(P);
    h.register(Q, 1);
    h.ctx(Q, 0);
    h.c.sync_ship_costs(vec![U64(ships[0])]);
}

#[test]
#[should_panic(expected = "ShipInFleet")]
fn sync_ship_costs_reverts_ship_in_fleet_while_ship_is_in_a_fleet() {
    let mut h = sp_setup();
    let ships = h.owned(P);
    start_sp(&mut h, &ships[..1]);
    republish_costs(&mut h, 0);
    h.ctx(P, 0);
    h.c.sync_ship_costs(vec![U64(ships[0])]);
}

#[test]
fn sync_ship_costs_does_not_change_storage() {
    let mut h = sp_setup();
    let ships = h.owned(P);
    let used = h.c.accounts.get(&acc(P)).unwrap().used_bytes;
    republish_costs(&mut h, 3);
    h.ctx(P, 0);
    h.c.sync_ship_costs(ships.iter().map(|&i| U64(i)).collect());
    assert_eq!(h.c.accounts.get(&acc(P)).unwrap().used_bytes, used);
}

#[test]
fn owner_can_set_cost_of_any_ship() {
    let mut h = sp_setup();
    let id = h.owned(P)[0];
    republish_costs(&mut h, 2);
    h.ctx(OWNER, 0);
    h.c.set_cost_of_ship(U64(id));
    assert_eq!(h.ship(id).ship.ship_data.costs_version, h.c.get_costs(1).unwrap().version);
}

#[test]
#[should_panic(expected = "NotOwner")]
fn set_cost_of_ship_rejects_non_owner() {
    let mut h = sp_setup();
    let id = h.owned(P)[0];
    h.ctx(P, 0);
    h.c.set_cost_of_ship(U64(id));
}

// ------------------------------------------ server minter (card checkout)

fn with_minter(h: &mut H) {
    h.ctx(OWNER, 0);
    h.c.set_role(acc(SERVER), crate::roles::MINTER);
}

#[test]
#[should_panic(expected = "NotAuthorized")]
fn create_ships_for_rejects_a_caller_without_the_minter_role() {
    let mut h = H::new();
    h.ctx(P, ONE_NEAR / 10);
    h.c.create_ships_for(acc(Q), 5, 1, 0, false);
}

#[test]
fn minter_mints_a_paid_pack_to_an_unregistered_buyer_and_funds_its_storage() {
    let mut h = H::new();
    with_minter(&mut h);
    h.ctx(SERVER, ONE_NEAR / 5);
    let ids: Vec<u64> = h.c.create_ships_for(acc(Q), 11, 1, 2, false).into_iter().map(|i| i.0).collect();
    assert_eq!(ids.len(), 11);
    let a = h.c.accounts.get(&acc(Q)).cloned().expect("buyer registered");
    assert_eq!(a.amount_purchased, 11);
    assert_eq!(a.sponsored.as_yoctonear(), ONE_NEAR / 5);
    assert!(a.deposit >= a.locked());
    // createShips rank presets: the first tier+1 ships get ranks 3, 2, 1.
    let kills: Vec<u32> = ids.iter().map(|&i| h.ship(i).ship.ship_data.ships_destroyed).collect();
    assert_eq!(&kills[..4], &[30, 10, 1, 0]);
    assert!(ids.iter().all(|&i| !h.ship(i).ship.ship_data.is_free_ship));
    h.resolve_all();
    assert!(ids.iter().all(|&i| h.ship(i).ship.ship_data.constructed));
    assert_eq!(h.owned(Q), ids);
}

#[test]
fn minter_funded_storage_is_not_withdrawable() {
    let mut h = H::new();
    with_minter(&mut h);
    h.ctx(SERVER, ONE_NEAR / 5);
    h.c.create_ships_for(acc(Q), 5, 1, 0, false);
    let bal = h.c.storage_balance_of(acc(Q)).unwrap();
    assert_eq!(bal.available.as_yoctonear(), 0, "NEP-145 available = withdrawable");
    h.ctx(Q, 1);
    let after = h.c.storage_withdraw(None);
    assert_eq!(after.total, bal.total, "nothing paid out");
}

#[test]
fn minter_free_ships_are_flagged_free_and_not_counted_as_purchases() {
    let mut h = H::new();
    with_minter(&mut h);
    h.ctx(SERVER, ONE_NEAR / 10);
    let ids: Vec<u64> = h.c.create_ships_for(acc(Q), 3, 1, 4, true).into_iter().map(|i| i.0).collect();
    assert!(ids.iter().all(|&i| h.ship(i).ship.ship_data.is_free_ship && h.ship(i).ship.ship_data.ships_destroyed == 0));
    assert_eq!(h.c.accounts.get(&acc(Q)).unwrap().amount_purchased, 0);
}

#[test]
#[should_panic(expected = "InsufficientStorageBalance")]
fn minter_call_without_storage_funding_reverts() {
    let mut h = H::new();
    with_minter(&mut h);
    h.ctx(SERVER, 0);
    h.c.create_ships_for(acc(Q), 5, 1, 0, false);
}

// ------------------------------------------------------- content edits

#[test]
fn update_preset_map_replaces_tiles_and_keeps_deployment_zones() {
    let mut h = H::new();
    h.ctx(OWNER, 0);
    let id = h.c.create_preset_map(vec![pos(1, 1)], vec![pos(2, 2)], vec![ScoringPosition { row: 3, col: 3, points: 1, only_once: false }], MapMode::PvE);
    h.c.set_deployment_zones(id, vec![pos(0, 0)], vec![pos(0, 16)]);
    let zones = h.c.get_preset_map(id).unwrap().creator_zone;
    h.c.update_preset_map(id, vec![pos(4, 4), pos(5, 5)]);
    h.c.update_preset_map_impassable(id, vec![]);
    h.c.update_preset_scoring_map(id, vec![ScoringPosition { row: 6, col: 6, points: 3, only_once: true }]);
    h.c.set_map_mode(id, MapMode::Both);
    let m = h.c.get_preset_map(id).unwrap();
    assert!(m.blocked.get(vt_core::grid::bit_index(4, 4)) && m.blocked.get(vt_core::grid::bit_index(5, 5)));
    assert!(!m.blocked.get(vt_core::grid::bit_index(1, 1)), "full replace, not merge");
    assert!(!m.impassable.get(vt_core::grid::bit_index(2, 2)));
    assert_eq!(m.scoring.len(), 1);
    assert_eq!((m.scoring[0].row, m.scoring[0].points, m.scoring[0].only_once), (6, 3, true));
    assert_eq!(m.mode, MapMode::Both);
    assert_eq!(m.creator_zone, zones);

    h.c.update_full_preset_map(id, vec![], vec![pos(7, 7)], vec![], MapMode::PvP);
    let m = h.c.get_preset_map(id).unwrap();
    assert!(m.impassable.get(vt_core::grid::bit_index(7, 7)) && m.scoring.is_empty() && m.mode == MapMode::PvP);
    assert_eq!(m.creator_zone, zones, "full update keeps zones too");
}

#[test]
#[should_panic(expected = "NotAuthorized")]
fn update_preset_map_rejects_non_editor() {
    let mut h = H::new();
    h.ctx(OWNER, 0);
    let id = h.c.create_preset_map(vec![], vec![], vec![], MapMode::PvE);
    h.ctx(P, 0);
    h.c.update_preset_map(id, vec![]);
}

#[test]
#[should_panic(expected = "MapNotFound")]
fn update_preset_map_reverts_for_unknown_map() {
    let mut h = H::new();
    h.ctx(OWNER, 0);
    h.c.update_preset_map(U64(9), vec![]);
}

#[test]
#[should_panic(expected = "InvalidPosition")]
fn update_preset_map_rejects_out_of_bounds_tiles() {
    let mut h = H::new();
    h.ctx(OWNER, 0);
    let id = h.c.create_preset_map(vec![], vec![], vec![], MapMode::PvE);
    h.c.update_preset_map(id, vec![pos(99, 0)]);
}

#[test]
fn edits_do_not_touch_a_live_game() {
    let mut h = sp_setup();
    let ships = h.owned(P);
    let g = start_sp(&mut h, &ships[..1]);
    let before = h.c.get_game(U64(g)).unwrap().map;
    h.ctx(OWNER, 0);
    h.c.update_preset_map(U64(1), vec![pos(4, 8)]);
    assert_eq!(h.c.get_game(U64(g)).unwrap().map, before);
}

#[test]
fn update_node_rewrites_fields_and_moves_between_campaigns() {
    let mut h = sp_setup();
    h.ctx(OWNER, 0);
    let c2 = h.c.create_campaign(2);
    let n2 = h.c.create_node(node(1, 1, vec![1]));
    let mut upd = node(c2.0, 1, vec![]);
    upd.cost_limit = 77;
    h.c.update_node(n2, upd);
    let n = h.c.get_node(n2).unwrap();
    assert_eq!((n.campaign_id, n.cost_limit, n.prerequisites.len()), (c2.0, 77, 0));
    assert_eq!(h.c.get_campaign(U64(1)).unwrap().node_ids, vec![1]);
    assert_eq!(h.c.get_campaign(c2).unwrap().node_ids, vec![n2.0]);
    h.c.set_campaign_required_variant(c2, 1);
    assert_eq!(h.c.get_campaign(c2).unwrap().required_variant, 1);
}

#[test]
#[should_panic(expected = "NodeNotFound")]
fn update_node_reverts_for_unknown_node() {
    let mut h = sp_setup();
    h.ctx(OWNER, 0);
    h.c.update_node(U64(9), node(1, 1, vec![]));
}

#[test]
#[should_panic(expected = "SelfPrerequisite")]
fn update_node_rejects_itself_as_prerequisite() {
    let mut h = sp_setup();
    h.ctx(OWNER, 0);
    h.c.update_node(U64(1), node(1, 1, vec![1]));
}

#[test]
fn add_and_remove_prerequisites() {
    let mut h = sp_setup();
    h.ctx(OWNER, 0);
    let n2 = h.c.create_node(node(1, 1, vec![]));
    let n3 = h.c.create_node(node(1, 1, vec![]));
    h.c.add_prerequisite(n3, U64(1));
    h.c.add_prerequisite(n3, n2);
    assert_eq!(h.c.get_node(n3).unwrap().prerequisites, vec![1, n2.0]);
    h.c.remove_prerequisite(n3, U64(1));
    assert_eq!(h.c.get_node(n3).unwrap().prerequisites, vec![n2.0]);
}

#[test]
#[should_panic(expected = "PrerequisiteNotInNode")]
fn remove_prerequisite_reverts_when_not_present() {
    let mut h = sp_setup();
    h.ctx(OWNER, 0);
    h.c.remove_prerequisite(U64(1), U64(1));
}

#[test]
#[should_panic(expected = "PrerequisiteNotFound")]
fn add_prerequisite_reverts_for_unknown_node() {
    let mut h = sp_setup();
    h.ctx(OWNER, 0);
    h.c.add_prerequisite(U64(1), U64(42));
}

#[test]
fn update_ai_ship_config_overwrites_the_config() {
    let mut h = H::new();
    h.ctx(OWNER, 0);
    let id = h.c.create_ai_ship_config(drone(1));
    let mut c = drone(2);
    c.name = "Hive Warden".into();
    c.ships_destroyed = 100;
    h.c.update_ai_ship_config(id, c);
    let got = h.c.get_ai_ship_config(id).unwrap();
    assert_eq!((got.name.as_str(), got.traits.variant, got.ships_destroyed), ("Hive Warden", 2, 100));
}

#[test]
#[should_panic(expected = "ConfigNotFound")]
fn update_ai_ship_config_reverts_for_unknown_config() {
    let mut h = H::new();
    h.ctx(OWNER, 0);
    h.c.update_ai_ship_config(U64(1), drone(1));
}

#[test]
#[should_panic(expected = "InvalidTier")]
fn update_ai_ship_config_validates_traits() {
    let mut h = H::new();
    h.ctx(OWNER, 0);
    let id = h.c.create_ai_ship_config(drone(1));
    let mut c = drone(1);
    c.traits.hull = 3;
    h.c.update_ai_ship_config(id, c);
}

#[test]
fn update_rl_node_rewrites_fields_but_keeps_children_and_win_effects() {
    let mut h = H::new();
    h.ctx(OWNER, 0);
    let map = h.c.create_preset_map(vec![], vec![], vec![], MapMode::PvE);
    let c = h.c.create_rl_campaign();
    let a = h.c.create_rl_node(c, RlNodeKind::Combat, map, 300, 100, true, 0);
    let b = h.c.create_rl_node(c, RlNodeKind::Combat, map, 300, 100, true, 0);
    h.c.add_rl_child(a, b);
    h.c.set_rl_node_win_effects(a, vec![WinEffect::DecBonus { amount: U128(5) }]);
    h.c.update_rl_node(a, c, RlNodeKind::Resupply, U64(0), 0, 0, false, 900);
    let n = h.c.get_rl_node(a).unwrap();
    assert_eq!((n.kind, n.cost_cap_override, n.children.clone()), (RlNodeKind::Resupply, 900, vec![b.0]));
    assert_eq!(n.win_effects.len(), 1);
}

#[test]
#[should_panic(expected = "InvalidMapMode")]
fn update_rl_node_rejects_a_pvp_only_map_for_combat() {
    let mut h = H::new();
    h.ctx(OWNER, 0);
    let pve = h.c.create_preset_map(vec![], vec![], vec![], MapMode::PvE);
    let pvp = h.c.create_preset_map(vec![], vec![], vec![], MapMode::PvP);
    let c = h.c.create_rl_campaign();
    let a = h.c.create_rl_node(c, RlNodeKind::Combat, pve, 300, 100, true, 0);
    h.c.update_rl_node(a, c, RlNodeKind::Combat, pvp, 300, 100, true, 0);
}

// ------------------------------------------------- Game.getGamesForPlayer

#[test]
fn games_for_player_lists_single_player_games_including_finished_ones() {
    let mut h = sp_setup();
    let ships = h.owned(P);
    let g1 = start_sp(&mut h, &ships[..1]);
    h.ctx(P, 0);
    h.c.forfeit(U64(g1));
    let g2 = start_sp(&mut h, &ships[1..2]);
    let list = h.c.get_games_for_player(acc(P), None, None);
    assert_eq!(list.iter().map(|s| s.game_id.0).collect::<Vec<_>>(), vec![g1, g2]);
    assert!(list[0].ended && !list[1].ended);
    assert!(list.iter().all(|s| s.mode == GameMode::SinglePlayer && s.node_or_lobby_id.0 == 1));
    assert_eq!(h.c.get_player_game_count(acc(P)), 2);
    assert!(h.c.get_games_for_player(acc(Q), None, None).is_empty());
}

#[test]
fn games_for_player_paginates() {
    let mut h = sp_setup();
    let ships = h.owned(P);
    let mut ids = vec![];
    for s in &ships[..3] {
        let g = start_sp(&mut h, &[*s]);
        h.ctx(P, 0);
        h.c.forfeit(U64(g));
        ids.push(g);
    }
    let page = |from, limit| h.c.get_games_for_player(acc(P), Some(from), Some(limit)).iter().map(|s| s.game_id.0).collect::<Vec<_>>();
    assert_eq!(page(0, 2), ids[..2].to_vec());
    assert_eq!(page(2, 2), ids[2..].to_vec());
    assert!(page(5, 2).is_empty());
}

#[test]
fn the_history_row_is_charged_to_the_player() {
    let mut h = sp_setup();
    let ships = h.owned(P);
    start_sp(&mut h, &ships[..1]);
    h.c.flush_all();
    // Ledger invariant: P's used bytes cover everything P's calls wrote.
    let a = h.c.accounts.get(&acc(P)).unwrap();
    assert!(a.deposit >= a.locked());
    assert!(h.c.player_games.count.get(&acc(P)).is_some());
}

// ------------------------------------------------------------------ views

#[test]
fn settings_and_lobby_config_reflect_their_setters() {
    let mut h = H::new();
    h.ctx(OWNER, 0);
    h.c.set_heal_cap_percent(40);
    h.c.set_recycle_reward(U128(7));
    h.c.set_medal_final_node(U64(12));
    h.c.set_repair_cost_per_hp(U128(9));
    h.c.set_lobby_config(2, U128(3), U128(4), 500, 600);
    h.c.set_lobbies_paused(true);
    let s = h.c.get_settings();
    assert_eq!((s.heal_cap_percent, s.recycle_reward.0, s.medal_final_node.0, s.repair_cost_per_hp.0), (40, 7, 12, 9));
    assert_eq!(s.gated_variants, vec![2]);
    assert_eq!(s.reward_tokens, vec![(2, "dec".to_string())]);
    let l = h.c.get_lobby_config();
    assert_eq!((l.free_games_per_address, l.additional_lobby_fee.0, l.reserved_lobby_fee.0, l.max_fleet_cost_limit, l.stale_threshold_s, l.paused), (2, 3, 4, 500, 600, true));
}

#[test]
fn player_summary_and_tutorial_flag() {
    let mut h = H::new();
    h.register(P, 1);
    assert!(!h.c.is_tutorial_completed(acc(P)));
    h.ctx(P, 0);
    h.c.complete_tutorial(true);
    assert!(h.c.is_tutorial_completed(acc(P)));
    let s = h.c.get_player_summary(acc(P)).unwrap();
    assert!(s.tutorial_completed && !s.hive_medal);
    assert_eq!(s.ship_count as usize, h.owned(P).len());
    assert!(h.c.get_player_summary(acc(Q)).is_none());
}

#[test]
fn ships_by_ids_skips_unknown_ids() {
    let h = sp_setup();
    let ships = h.owned(P);
    let got = h.c.get_ships_by_ids(vec![U64(ships[1]), U64(9999), U64(ships[0])]);
    assert_eq!(got.iter().map(|v| v.ship.id).collect::<Vec<_>>(), vec![ships[1], ships[0]]);
}

#[test]
fn content_counts_and_paginated_lists() {
    let mut h = sp_setup();
    h.ctx(OWNER, 0);
    h.c.create_preset_map(vec![], vec![], vec![], MapMode::PvP);
    h.c.create_ai_ship_config(drone(2));
    assert_eq!(h.c.get_preset_maps(None, None).iter().map(|(id, _)| id.0).collect::<Vec<_>>(), vec![1, 2]);
    assert_eq!(h.c.get_preset_maps(Some(1), Some(5)).len(), 1);
    assert_eq!(h.c.get_ai_ship_configs(None, None).len(), 2);
    assert_eq!((h.c.get_campaign_count().0, h.c.get_node_count().0), (1, 1));
    assert_eq!(h.c.get_max_placements_per_map(), 8);
}

// =====================================================================
// Second parity pass (2026-11-14): ownership, mint switch, burn, metadata,
// ship stats, previews, batch/count views, single-cell and live-map edits.

const NEW_OWNER: &str = "multisig.near";

// ---------------------------------------------- Ownable.transferOwnership

#[test]
fn two_step_ownership_transfer_hands_over_admin_and_keeps_roles() {
    let mut h = H::new();
    with_minter(&mut h);
    h.ctx(OWNER, 0);
    h.c.transfer_ownership(acc(NEW_OWNER));
    assert_eq!(h.c.get_pending_owner(), Some(acc(NEW_OWNER)));
    assert_eq!(h.c.owner_id(), acc(OWNER), "nothing changes until accepted");
    h.ctx(NEW_OWNER, 0);
    h.c.accept_ownership();
    assert_eq!(h.c.owner_id(), acc(NEW_OWNER));
    assert_eq!(h.c.get_pending_owner(), None);
    assert_eq!(h.c.get_roles(acc(SERVER)), crate::roles::MINTER, "roles survive the handover");
    h.ctx(NEW_OWNER, 0);
    h.c.set_heal_cap_percent(50); // the new owner administers
}

#[test]
#[should_panic(expected = "NotOwner")]
fn the_old_owner_loses_admin_after_the_transfer() {
    let mut h = H::new();
    h.ctx(OWNER, 0);
    h.c.transfer_ownership(acc(NEW_OWNER));
    h.ctx(NEW_OWNER, 0);
    h.c.accept_ownership();
    h.ctx(OWNER, 0);
    h.c.set_heal_cap_percent(50);
}

#[test]
#[should_panic(expected = "NotPendingOwner")]
fn only_the_nominee_can_accept() {
    let mut h = H::new();
    h.ctx(OWNER, 0);
    h.c.transfer_ownership(acc(NEW_OWNER));
    h.ctx(P, 0);
    h.c.accept_ownership();
}

#[test]
#[should_panic(expected = "NotOwner")]
fn only_the_owner_can_nominate() {
    let mut h = H::new();
    h.ctx(P, 0);
    h.c.transfer_ownership(acc(P));
}

#[test]
#[should_panic(expected = "NotPendingOwner")]
fn a_cancelled_nomination_cannot_be_accepted() {
    let mut h = H::new();
    h.ctx(OWNER, 0);
    h.c.transfer_ownership(acc(NEW_OWNER));
    h.c.cancel_ownership_transfer();
    h.ctx(NEW_OWNER, 0);
    h.c.accept_ownership();
}

// ------------------------------------------------ mintIsActive kill switch

#[test]
fn switching_a_token_off_stops_every_mint_of_it_only() {
    let mut h = H::new();
    h.register(P, 1);
    h.ctx(OWNER, 0);
    h.c.set_token_mint_active("dec".into(), false);
    assert!(!h.c.is_token_mint_active("dec".into()) && h.c.is_token_mint_active("utc".into()));
    assert!(!h.c.try_mint(&acc(P), TokenKind::Dec, 5), "DEC mints fail (kill rewards are then skipped)");
    assert!(h.c.try_mint(&acc(P), TokenKind::Utc, 5), "UTC unaffected");
    h.ctx(OWNER, 0);
    h.c.set_token_mint_active("dec".into(), true);
    assert!(h.c.try_mint(&acc(P), TokenKind::Dec, 5));
}

#[test]
#[should_panic(expected = "MintFailed")]
fn buying_utc_reverts_while_utc_minting_is_off() {
    let mut h = H::new();
    h.register(P, 1);
    h.ctx(OWNER, 0);
    h.c.set_token_mint_active("utc".into(), false);
    let price = h.c.get_price_tiers()[0].near_utc_price.0;
    h.ctx(P, price);
    h.c.buy_utc_with_near(0);
}

#[test]
fn a_pauser_can_flip_the_mint_switch() {
    let mut h = H::new();
    h.ctx(OWNER, 0);
    h.c.set_role(acc(Q), crate::roles::PAUSER);
    h.ctx(Q, 0);
    h.c.set_token_mint_active("utc".into(), false);
    assert!(!h.c.is_token_mint_active("utc".into()));
}

#[test]
#[should_panic(expected = "NotAuthorized")]
fn a_stranger_cannot_flip_the_mint_switch() {
    let mut h = H::new();
    h.ctx(P, 0);
    h.c.set_token_mint_active("utc".into(), false);
}

// ------------------------------------------------- ERC20Burnable.burn

#[test]
fn players_burn_their_own_tokens() {
    let mut h = H::new();
    h.register(P, 1);
    h.mint(P, TokenKind::Utc, 10 * E18);
    h.ctx(P, 1);
    h.c.mt_burn("utc".into(), U128(4 * E18));
    assert_eq!(h.utc(P), 6 * E18);
    assert_eq!(h.c.mt_supply("utc".into()).unwrap().0, 6 * E18);
}

#[test]
#[should_panic(expected = "InsufficientBalance")]
fn burning_more_than_the_balance_reverts() {
    let mut h = H::new();
    h.register(P, 1);
    h.ctx(P, 1);
    h.c.mt_burn("dec".into(), U128(1));
}

#[test]
#[should_panic(expected = "Soulbound")]
fn the_medal_cannot_be_burned() {
    let mut h = H::new();
    h.register(P, 1);
    h.ctx(P, 1);
    h.c.mt_burn("hive_medal".into(), U128(1));
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn burning_needs_one_yocto() {
    let mut h = H::new();
    h.register(P, 1);
    h.ctx(P, 0);
    h.c.mt_burn("utc".into(), U128(1));
}

// ------------------------------------------------ NEP-245 metadata

#[test]
fn token_metadata_follows_nep245() {
    let h = H::new();
    let c = h.c.mt_metadata_contract();
    assert_eq!(c.spec, "mt-1.0.0");
    let all = h.c.mt_metadata_token_all(vec!["utc".into(), "dec".into(), "hive_medal".into(), "nope".into()]);
    let utc = all[0].as_ref().unwrap();
    assert_eq!((utc.base.symbol.as_deref(), utc.base.decimals.as_deref(), utc.base.id.as_str()), (Some("UTC"), Some("18"), "utc"));
    assert_eq!(all[1].as_ref().unwrap().base.decimals.as_deref(), Some("0"));
    assert_eq!(all[2].as_ref().unwrap().base.symbol.as_deref(), Some("HIVEMEDAL"));
    assert!(all[3].is_none());
    assert_eq!(h.c.mt_metadata_base_by_metadata_id(vec!["dec".into()])[0].as_ref().unwrap().name, h.c.mt_metadata_base_by_token_id(vec!["dec".into()])[0].as_ref().unwrap().name);
}

// ------------------------------------------- ShipAttributes views

#[test]
fn ship_stats_match_what_a_fleet_puts_on_the_board() {
    let mut h = sp_setup();
    let ships = h.owned(P);
    let stats = h.c.get_ship_attributes(ships.iter().map(|&i| U64(i)).chain([U64(9999)]).collect());
    assert_eq!(stats.len(), ships.len(), "unknown id skipped");
    let g = start_sp(&mut h, &ships[..1]);
    let b = h.c.get_game(U64(g)).unwrap().ship(ships[0]);
    let s = &stats[0];
    assert_eq!((s.attributes.range, s.attributes.gun_damage, s.attributes.hull_points, s.attributes.movement), (b.range, b.gun_damage, b.max_hull_points, b.movement));
    assert!(s.costs_current);
    assert_eq!(s.rank, h.c.get_rank(1, h.ship(ships[0]).ship.ship_data.ships_destroyed as u64));
    assert!(h.c.get_latest_attributes_version(1) >= h.c.get_current_attributes_version(1));
}

#[test]
fn ship_stats_flag_stale_prices() {
    let mut h = sp_setup();
    let id = h.owned(P)[0];
    republish_costs(&mut h, 1);
    assert!(!h.c.get_ship_attributes(vec![U64(id)])[0].costs_current);
}

// ------------------------------------------------ Maps previews

#[test]
fn previews_answer_on_the_games_own_map() {
    let mut h = H::new();
    h.ctx(OWNER, 0);
    // A wall of blocked + impassable tiles at column 8, rows 0-10, except row 10.
    let wall: Vec<Position> = (0..10).map(|r| pos(r, 8)).collect();
    let map = h.c.create_preset_map(wall.clone(), wall, vec![ScoringPosition { row: 5, col: 5, points: 3, only_once: false }], MapMode::PvE);
    let cfg = h.c.create_ai_ship_config(drone(1));
    h.c.set_map_placements(map, vec![pos(5, 16)], vec![cfg]);
    let camp = h.c.create_campaign(1);
    h.c.create_node(node(camp.0, map.0, vec![]));
    h.register(P, 5);
    h.buy_and_build(P, 0, 1);
    let ships = h.owned(P);
    let g = U64(start_sp(&mut h, &ships[..1]));
    assert!(h.c.is_tile_blocked(g, 3, 8) && h.c.is_tile_impassable(g, 3, 8) && !h.c.is_tile_blocked(g, 10, 8));
    assert!(!h.c.has_line_of_sight(g, pos(3, 6), pos(3, 10), None), "the wall blocks sight");
    assert!(h.c.has_line_of_sight(g, pos(10, 6), pos(10, 10), None));
    // Maps.hasMovementPath is a straight-line check (permissive corners),
    // not pathfinding: through the wall fails, through the gap succeeds.
    assert!(!h.c.has_movement_path(g, pos(3, 6), pos(3, 10), None), "straight through the wall");
    assert!(h.c.has_movement_path(g, pos(10, 6), pos(10, 10), None), "straight through the gap");
    assert!(!h.c.has_movement_path(g, pos(10, 6), pos(10, 10), Some(vec![pos(10, 8)])), "gap occupied");
    assert_eq!((h.c.get_tile_points(g, 5, 5), h.c.get_tile_points(g, -1, 5)), (3, 0));
    assert!(h.c.is_valid_deployment_tile(U64(0), 4, 2, true) && !h.c.is_valid_deployment_tile(U64(0), 4, 9, true));
}

// --------------------------------------------- batch / count views

#[test]
fn batch_and_count_views() {
    let mut h = sp_setup();
    let ships = h.owned(P);
    let g = start_sp(&mut h, &ships[..1]);
    assert_eq!(h.c.get_game_count().0, g);
    assert_eq!(h.c.get_games(vec![U64(g), U64(999)]).len(), 1);
    assert_eq!(h.c.get_campaign_completion(acc(P), U64(1)), vec![(U64(1), false)]);
    assert!(!h.c.is_campaign_fully_completed(acc(P), U64(1)));
    assert!(!h.c.is_campaign_fully_completed(acc(P), U64(77)), "empty campaign is not completed, as on Base");
    let ladder = h.c.get_referral_ladder();
    assert_eq!(ladder.iter().map(|x| x.1).collect::<Vec<_>>(), vec![0, 10, 20, 35, 50]);
    assert_eq!(h.c.get_player_timeout_end(acc(P)).0, 0);
    assert_eq!(h.c.get_lobby_count().0, 0);
}

#[test]
fn nullifier_owner_view() {
    let mut h = H::new();
    h.register(P, 1);
    h.ctx(OWNER, 0);
    let hash = "11".repeat(32);
    h.c.mark_verified(acc(P), hash.clone());
    assert_eq!(h.c.get_nullifier_owner(hash), Some(acc(P)));
    assert_eq!(h.c.get_nullifier_owner("22".repeat(32)), None);
}

#[test]
fn construct_ships_builds_ships_the_callback_had_to_skip() {
    let mut h = H::new();
    // Variant 3 is mintable but has no cost table yet, so the randomness
    // callback resolves the values and skips construction (InvalidCostsVersion).
    h.ctx(OWNER, 0);
    h.c.set_max_variant(3);
    h.register(P, 1);
    h.ctx(P, 0);
    let ids: Vec<U64> = h.c.claim_free_ships(3);
    h.resolve_all();
    assert!(ids.iter().all(|i| !h.ship(i.0).ship.ship_data.constructed), "callback skipped them");
    // The owner publishes variant 3's costs; the player finishes all ships at once.
    h.ctx(OWNER, 0);
    let c = h.c.get_costs(1).unwrap();
    h.c.set_costs(3, c);
    h.ctx(P, 0);
    h.c.construct_ships(ids.clone());
    assert!(ids.iter().all(|i| h.ship(i.0).ship.ship_data.constructed));
}

#[test]
#[should_panic(expected = "TooManyShips")]
fn construct_ships_caps_the_batch() {
    let mut h = H::new();
    h.register(P, 1);
    h.ctx(P, 0);
    h.c.construct_ships((1..=51).map(U64).collect());
}

// ------------------------------------- single-cell + live-map edits

#[test]
fn set_map_placement_edits_one_cell() {
    let mut h = sp_setup();
    h.ctx(OWNER, 0);
    let cfg2 = h.c.create_ai_ship_config(drone(1));
    h.c.set_map_placement(U64(1), pos(6, 16), cfg2);
    assert_eq!(h.c.get_map_placements(U64(1)).len(), 2);
    h.c.set_map_placement(U64(1), pos(6, 16), U64(0));
    assert_eq!(h.c.get_map_placements(U64(1)).len(), 1, "config 0 clears the cell");
}

#[test]
fn live_map_edits_change_only_that_game() {
    let mut h = sp_setup();
    let ships = h.owned(P);
    let g = U64(start_sp(&mut h, &ships[..1]));
    h.ctx(OWNER, 0);
    h.c.set_game_blocked_tile(g, 4, 8, true);
    h.c.set_game_impassable_tile(g, 4, 9, true);
    h.c.set_game_scoring_tile(g, 2, 2, 4);
    assert!(h.c.is_tile_blocked(g, 4, 8) && h.c.is_tile_impassable(g, 4, 9));
    assert_eq!(h.c.get_tile_points(g, 2, 2), 4);
    assert!(!h.c.get_preset_map(U64(1)).unwrap().blocked.has_cell(4, 8), "the preset is untouched");
}

#[test]
#[should_panic(expected = "GameAlreadyEnded")]
fn live_map_edits_reject_ended_games() {
    let mut h = sp_setup();
    let ships = h.owned(P);
    let g = start_sp(&mut h, &ships[..1]);
    h.ctx(P, 0);
    h.c.forfeit(U64(g));
    h.ctx(OWNER, 0);
    h.c.set_game_blocked_tile(U64(g), 4, 8, true);
}

#[test]
#[should_panic(expected = "NotAuthorized")]
fn live_map_edits_are_editor_only() {
    let mut h = sp_setup();
    let ships = h.owned(P);
    let g = start_sp(&mut h, &ships[..1]);
    h.ctx(P, 0);
    h.c.set_game_blocked_tile(U64(g), 4, 8, true);
}

// =====================================================================
// Change detection for pollers: GameState::version, Account::nonce.

fn nonce(h: &H, who: &str) -> u64 {
    h.c.get_player_nonce(acc(who)).map_or(0, |n| n.0)
}

#[test]
fn game_version_bumps_on_every_write() {
    let mut h = sp_setup();
    let ships = h.owned(P);
    let g = U64(start_sp(&mut h, &ships[..1]));
    let v0 = h.c.get_game_version(g).unwrap().0;
    assert_eq!(v0, 1, "start writes the game once");
    h.ctx(OWNER, 0);
    h.c.set_game_blocked_tile(g, 4, 8, true);
    assert_eq!(h.c.get_game_version(g).unwrap().0, v0 + 1, "a map edit");
    h.ctx(P, 0);
    h.c.forfeit(g);
    assert_eq!(h.c.get_game_version(g).unwrap().0, v0 + 2, "a forfeit");
    assert_eq!(h.c.get_game(g).unwrap().version, v0 + 2, "the same number as on the full board");
    assert!(h.c.get_game_version(U64(999)).is_none());
}

#[test]
fn player_nonce_bumps_on_their_own_changes_only() {
    let mut h = H::new();
    h.register(P, 1);
    h.register(Q, 1);
    let (p0, q0) = (nonce(&h, P), nonce(&h, Q));
    h.ctx(P, 0);
    h.c.claim_free_ships(1);
    let p1 = nonce(&h, P);
    assert!(p1 > p0, "a claim (account + new ships)");
    assert_eq!(nonce(&h, Q), q0, "another player's claim doesn't touch Q");
    h.resolve_all();
    assert!(nonce(&h, P) > p1, "construction by the randomness callback");
    let p2 = nonce(&h, P);
    h.mint(P, TokenKind::Utc, E18);
    assert!(nonce(&h, P) > p2, "a balance change");
    assert_eq!(nonce(&h, Q), q0);
    assert!(h.c.get_player_nonce(acc("nobody.near")).is_none());
}

#[test]
fn player_nonce_bumps_when_someone_else_changes_their_data() {
    let mut h = H::new();
    with_minter(&mut h);
    h.register(Q, 1);
    let q0 = nonce(&h, Q);
    h.ctx(SERVER, ONE_NEAR / 10);
    h.c.create_ships_for(acc(Q), 5, 1, 0, false);
    assert!(nonce(&h, Q) > q0, "ships minted to Q by the server");
    let q1 = nonce(&h, Q);
    h.mint(Q, TokenKind::Utc, 0);
    assert_eq!(nonce(&h, Q), q1, "a zero mint writes nothing");
}

#[test]
fn ship_writes_bump_the_owner() {
    let mut h = sp_setup();
    let ships = h.owned(P);
    let n0 = nonce(&h, P);
    republish_costs(&mut h, 1);
    h.ctx(P, 0);
    h.c.sync_ship_costs(vec![U64(ships[0])]);
    assert!(nonce(&h, P) > n0, "re-pricing a ship");
}

/// AIShips.allocateShip: AI ships are constructed, carry the template's
/// shiny and kills, and are unpriced. (A ship with constructed=false renders
/// with the unconstructed art.)
#[test]
fn ai_ships_are_constructed_like_on_base() {
    let mut h = sp_setup();
    let ships = h.owned(P);
    let g = start_sp(&mut h, &ships[..1]);
    let m = h.c.get_sp_match(U64(g)).unwrap();
    assert!(!m.ai_ships.is_empty());
    for (_, s, _) in &m.ai_ships {
        assert!(s.ship_data.constructed, "AI ship {} must be constructed", s.id);
        assert_eq!((s.ship_data.cost, s.ship_data.costs_version, s.traits.serial_number), (0, 0, 0));
    }
}

/// Audit 2026-11-14: recycling a ship before its randomness resolves must not
/// leave the pending request behind (it could never be used and would lock
/// its bytes on the payer forever).
#[test]
fn recycling_an_unconstructed_ship_drops_its_pending_request() {
    let mut h = H::new();
    h.register(P, 5);
    let price = h.c.get_price_tiers()[0].near_ship_price.0;
    h.ctx(P, price);
    let ids: Vec<U64> = h.c.purchase_ships_with_near(0, None, 1);
    let requests: Vec<u64> = ids.iter().map(|i| h.ship(i.0).ship.traits.serial_number).collect();
    h.ctx(P, 0);
    h.c.recycle_ships(ids.clone());
    for r in &requests {
        assert!(h.c.random_requests.get(r).is_none(), "request {r} dropped with its ship");
    }
    // A late callback for those ids is a no-op.
    h.resolve_all();
    for r in &requests {
        assert!(h.c.random_requests.get(r).is_none());
    }
    let a = h.c.accounts.get(&acc(P)).unwrap();
    assert!(a.deposit >= a.locked());
}

/// Mirrors ShipCostsVersions.test.ts "floors a ship's final range at 1 and
/// movement at 3" (2026-11-26): movement modifiers that sum below zero and an
/// inert range-0 gun floor at movement 3 and range 1, at rank 0 and top rank.
#[test]
fn floors_final_range_at_1_and_movement_at_3() {
    let cfg = read_config();
    let mut t = attribute_table(&cfg["variants"]["1"]["attributeVersions"][0]);
    t.base_speed = 0;
    t.engine_speeds = vec![0; t.engine_speeds.len()];
    for g in &mut t.guns {
        g.range = 0;
        g.movement = -1;
    }
    for a in &mut t.armors {
        a.movement = -2;
    }
    for s in &mut t.shields {
        s.movement = -2;
    }
    for s in &mut t.specials {
        s.movement = 0;
    }
    let ship = |destroyed: u32| ShipStatsInput { id: 1, variant: 1, ships_destroyed: destroyed, ..Default::default() };
    for destroyed in [0, 1_000_000] {
        let a = vt_core::attributes::calculate(&t, 1, &ship(destroyed)).unwrap();
        assert_eq!((a.movement, a.range), (vt_core::attributes::MIN_MOVEMENT, 1));
        assert_eq!(a.movement, 3);
    }
}

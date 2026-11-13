//! PvP: Lobbies (matchmaking, fees, reservations, kicks, timeouts, stale
//! pruning), PvPMatch (game start, flee, turn timeout), GameResults (results
//! and win/loss stats) and GameBlobRegistry (replay blob ids), on the shared
//! vt-core engine.
//!
//! STORAGE ATTRIBUTION: lobby state is touched by several accounts (creator,
//! joiner, a stranger pruning). Every write is charged/refunded to the
//! account that owns the item, never simply the caller:
//!   - lobby record, its open-list entry, kick marks -> the lobby's creator
//!   - a player's lobby-list entries, a submitted fleet -> that player
//!   - game state, results, blobs -> the account whose call wrote them
//! (otherwise e.g. a pruner would be refunded for the creator's bytes).

use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::json;
use near_sdk::store::{IterableSet, LookupMap};
use near_sdk::{env, near, require, AccountId};
use vt_core::engine::{EngineEvent, GameState, MoveInput, Side};
use vt_core::maps::{GameMap, PresetMap};
use vt_core::types::{MapMode, Position};

use crate::config::TokenKind;
use crate::events;
use crate::{roles, Contract, ContractExt, OrPanic, StorageKey};

pub const MIN_TURN_TIME: u64 = 60;
pub const MAX_TURN_TIME: u64 = 86_400;
pub const KICK_PENALTY_PER_KICK_S: u64 = 3_600;
const E18: u128 = 1_000_000_000_000_000_000;

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LobbyStatus {
    Open,
    FleetSelection,
    InGame,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Lobby {
    pub id: u64,
    pub creator: AccountId,
    pub cost_limit: u64,
    pub created_at: u64,
    pub joiner: Option<AccountId>,
    pub reserved_joiner: Option<AccountId>,
    pub creator_fleet: bool,
    pub joiner_fleet: bool,
    pub joined_at: u64,
    pub joiner_fleet_set_at: u64,
    pub creator_goes_first: bool,
    pub turn_time: u64,
    pub map_id: u64,
    pub max_score: u64,
    pub status: LobbyStatus,
    pub game_started_at: u64,
    /// Engine game id once started (0 before).
    pub game_id: u64,
    /// Lobbies.lobbyOpenedAt.
    pub opened_at: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct PvpFleet {
    pub owner: AccountId,
    pub ship_ids: Vec<u64>,
    pub positions: Vec<Position>,
    pub total_cost: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct PvpGame {
    pub lobby_id: u64,
    pub creator: AccountId,
    pub joiner: AccountId,
    pub ended: bool,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct GameResult {
    pub game_id: u64,
    pub winner: AccountId,
    pub loser: AccountId,
    pub timestamp: u64,
}

#[near(serializers = [borsh])]
pub struct PvpState {
    pub lobbies: LookupMap<u64, Lobby>,
    pub lobby_count: u64,
    pub open: IterableSet<u64>,
    pub player_lobby_at: LookupMap<(AccountId, u32), u64>,
    /// 1-based position in the player's lobby list.
    pub player_lobby_pos: LookupMap<(AccountId, u64), u32>,
    pub kicked: LookupMap<(u64, AccountId), bool>,
    /// (lobby id, is_creator) -> fleet.
    pub fleets: LookupMap<(u64, bool), PvpFleet>,
    pub games: LookupMap<u64, PvpGame>,
    pub results: LookupMap<u64, GameResult>,
    pub blobs: LookupMap<(u64, AccountId), [u8; 32]>,
    // Lobbies config
    pub free_games_per_address: u32,
    pub additional_lobby_fee: u128,
    pub reserved_lobby_fee: u128,
    pub max_fleet_cost_limit: u64,
    pub paused: bool,
    pub stale_threshold_s: u64,
}

impl PvpState {
    pub fn new() -> Self {
        Self {
            lobbies: LookupMap::new(StorageKey::Lobbies),
            lobby_count: 0,
            open: IterableSet::new(StorageKey::OpenLobbies),
            player_lobby_at: LookupMap::new(StorageKey::PlayerLobbyAt),
            player_lobby_pos: LookupMap::new(StorageKey::PlayerLobbyPos),
            kicked: LookupMap::new(StorageKey::Kicked),
            fleets: LookupMap::new(StorageKey::PvpFleets),
            games: LookupMap::new(StorageKey::PvpGames),
            results: LookupMap::new(StorageKey::GameResults),
            blobs: LookupMap::new(StorageKey::Blobs),
            free_games_per_address: 1,
            additional_lobby_fee: E18,
            reserved_lobby_fee: E18,
            max_fleet_cost_limit: 2000,
            paused: false,
            stale_threshold_s: 7 * 24 * 3600,
        }
    }

    pub fn flush(&mut self) {
        self.lobbies.flush();
        self.open.flush();
        self.player_lobby_at.flush();
        self.player_lobby_pos.flush();
        self.kicked.flush();
        self.fleets.flush();
        self.games.flush();
        self.results.flush();
        self.blobs.flush();
    }
}

impl Default for PvpState {
    fn default() -> Self {
        Self::new()
    }
}

#[near(serializers = [json])]
pub struct PlayerLobbyState {
    pub active_lobby_id: U64,
    pub active_lobbies_count: u32,
    pub has_active_lobby: bool,
    pub kick_count: u32,
    pub last_kick_time_s: U64,
    pub timeout_end_s: U64,
}

impl Contract {
    fn lobby(&self, id: u64) -> Lobby {
        self.pvp.lobbies.get(&id).cloned().unwrap_or_else(|| env::panic_str("LobbyNotFound"))
    }

    fn save_lobby(&mut self, l: Lobby) {
        let creator = l.creator.clone();
        self.charged(&creator, |c| {
            c.pvp.lobbies.insert(l.id, l);
        });
    }

    fn player_in_lobby(&self, p: &AccountId, id: u64) -> bool {
        self.pvp.player_lobby_pos.contains_key(&(p.clone(), id))
    }

    /// EnumerableSet.add on the player's lobby list.
    fn player_lobby_add(&mut self, p: &AccountId, id: u64) {
        if self.player_in_lobby(p, id) {
            return;
        }
        self.charged(p, |c| {
            let mut a = c.account(p);
            c.pvp.player_lobby_at.insert((p.clone(), a.lobby_count), id);
            a.lobby_count += 1;
            c.pvp.player_lobby_pos.insert((p.clone(), id), a.lobby_count);
            c.put_account(p, a);
        });
    }

    /// EnumerableSet.remove (swap the last entry into the hole).
    fn player_lobby_remove(&mut self, p: &AccountId, id: u64) {
        let Some(pos) = self.pvp.player_lobby_pos.get(&(p.clone(), id)).copied() else { return };
        self.charged(p, |c| {
            let mut a = c.account(p);
            let last = a.lobby_count - 1;
            let idx = pos - 1;
            if idx != last {
                let moved = *c.pvp.player_lobby_at.get(&(p.clone(), last)).unwrap();
                c.pvp.player_lobby_at.insert((p.clone(), idx), moved);
                c.pvp.player_lobby_pos.insert((p.clone(), moved), pos);
            }
            c.pvp.player_lobby_at.remove(&(p.clone(), last));
            c.pvp.player_lobby_pos.remove(&(p.clone(), id));
            a.lobby_count = last;
            c.put_account(p, a);
        });
    }

    /// _addLobbyToOpenSet (stamps opened_at on the caller's copy).
    fn open_add(&mut self, l: &mut Lobby) {
        l.opened_at = Self::now_s();
        let (id, creator) = (l.id, l.creator.clone());
        self.charged(&creator, |c| {
            c.pvp.open.insert(id);
        });
    }

    fn open_remove(&mut self, id: u64, creator: &AccountId) {
        if !self.pvp.open.contains(&id) {
            return;
        }
        self.charged(creator, |c| {
            c.pvp.open.remove(&id);
        });
    }

    /// _releasePlayerSlot.
    fn release_slot(&mut self, p: &AccountId, id: u64) {
        let mut a = self.account(p);
        if a.active_lobbies_count > 0 {
            a.active_lobbies_count -= 1;
        }
        if a.active_lobby_id == id {
            a.has_active_lobby = false;
            a.active_lobby_id = 0;
        }
        self.put_account(p, a);
    }

    /// Lobbies.getPlayerTimeoutEnd.
    fn timeout_end(&self, p: &AccountId) -> u64 {
        let a = self.accounts.get(p).cloned().unwrap_or_default();
        if a.kick_count == 0 { 0 } else { a.last_kick_time_s + a.kick_count as u64 * KICK_PENALTY_PER_KICK_S }
    }

    fn charge_lobby_fee(&mut self, p: &AccountId, amount: u128) {
        let mut a = self.account(p);
        require!(a.utc >= amount, "InsufficientUTC");
        a.utc -= amount;
        self.put_account(p, a);
        self.config.treasury_utc += amount;
    }

    fn pvp_map(&self, map_id: u64) -> PresetMap {
        if map_id == 0 {
            return PresetMap::default();
        }
        self.sp.maps.get(&map_id).cloned().unwrap_or_else(|| env::panic_str("InvalidMapId"))
    }

    fn require_map_usable_for_pvp(&self, map_id: u64) {
        let m = self.sp.maps.get(&map_id).unwrap_or_else(|| env::panic_str("InvalidMapId"));
        require!(m.mode == MapMode::PvP || m.mode == MapMode::Both, "InvalidMapId");
    }

    /// Clears a submitted fleet: unlocks its ships, refunds its owner.
    fn fleet_clear(&mut self, lobby_id: u64, is_creator: bool) {
        let Some(f) = self.pvp.fleets.get(&(lobby_id, is_creator)).cloned() else { return };
        for &id in &f.ship_ids {
            self.set_in_fleet(id, false);
        }
        self.charged(&f.owner, |c| {
            c.pvp.fleets.remove(&(lobby_id, is_creator));
        });
    }

    fn mark_kick(&mut self, p: &AccountId) {
        let mut a = self.account(p);
        a.kick_count += 1;
        a.last_kick_time_s = Self::now_s();
        self.put_account(p, a);
    }

    /// Applies the engine's side effects for a PvP game. Returns the result to
    /// record (winner, loser) if the game ended with a winner. Never panics on
    /// the reward path.
    fn apply_pvp_events(&mut self, game_id: u64, pg: &mut PvpGame, evs: &[EngineEvent]) -> Option<(AccountId, AccountId)> {
        let now = Self::now_s();
        let mut result = None;
        for e in evs {
            match *e {
                EngineEvent::ShipLeftFleet { ship_id, side } => {
                    let key = (pg.lobby_id, side == Side::Creator);
                    if let Some(mut f) = self.pvp.fleets.get(&key).cloned() {
                        if let Some(i) = f.ship_ids.iter().position(|&s| s == ship_id) {
                            f.ship_ids.swap_remove(i);
                            f.positions.swap_remove(i);
                            if let Some(r) = self.ships.get(&ship_id) {
                                f.total_cost = f.total_cost.saturating_sub(r.ship.ship_data.cost as u64);
                            }
                            let owner = f.owner.clone();
                            self.charged(&owner, |c| {
                                c.pvp.fleets.insert(key, f);
                            });
                        }
                    }
                    self.set_in_fleet(ship_id, false);
                }
                EngineEvent::ShipDestroyed { ship_id, last_damager } => {
                    let free_victim = self.ships.get(&ship_id).is_some_and(|r| r.ship.ship_data.is_free_ship);
                    self.mark_destroyed(ship_id, now);
                    if last_damager == 0 || free_victim {
                        continue; // HA6-16: free-ship kills pay nothing and earn no rank
                    }
                    // ShipsRouter: recordKill + DestroyRewardLib (human victim -> UTC).
                    let Some(mut killer) = self.ships.get(&last_damager).cloned() else { continue };
                    killer.ship.ship_data.ships_destroyed = killer.ship.ship_data.ships_destroyed.saturating_add(1);
                    let owner = killer.owner.clone();
                    self.ships.insert(last_damager, killer);
                    let reward = self.config.recycle_reward >> 2;
                    if !self.try_mint(&owner, TokenKind::Utc, reward) {
                        events::emit("reward_skipped", json!({ "game_id": U64(game_id), "destroyer_owner": owner }));
                    }
                }
                EngineEvent::GameEnded { winner } => {
                    pg.ended = true;
                    if let Some(w) = winner {
                        let (win, lose) = if w == Side::Creator { (pg.creator.clone(), pg.joiner.clone()) } else { (pg.joiner.clone(), pg.creator.clone()) };
                        let mut a = self.account(&win);
                        a.wins += 1;
                        self.put_account(&win, a);
                        let mut b = self.account(&lose);
                        b.losses += 1;
                        self.put_account(&lose, b);
                        result = Some((win, lose));
                    }
                    self.fleet_clear(pg.lobby_id, true);
                    self.fleet_clear(pg.lobby_id, false);
                    events::emit("game_ended", json!({ "game_id": U64(game_id), "winner": winner }));
                }
            }
        }
        result
    }

    /// Saves game + PvP record (+ result) charged to `payer`.
    fn save_pvp(&mut self, payer: &AccountId, game_id: u64, g: GameState, pg: PvpGame, result: Option<(AccountId, AccountId)>) {
        let now = Self::now_s();
        self.charged(payer, |c| {
            c.sp.games.insert(game_id, g);
            c.pvp.games.insert(game_id, pg);
            if let Some((winner, loser)) = result {
                events::emit("game_result_recorded", json!({ "game_id": U64(game_id), "winner": winner, "loser": loser }));
                c.pvp.results.insert(game_id, GameResult { game_id, winner, loser, timestamp: now });
            }
        });
    }

    fn load_pvp(&self, game_id: u64) -> (GameState, PvpGame) {
        let g = self.sp.games.get(&game_id).cloned().unwrap_or_else(|| env::panic_str("GameNotFound"));
        let pg = self.pvp.games.get(&game_id).cloned().unwrap_or_else(|| env::panic_str("GameNotFound"));
        (g, pg)
    }

    /// Game.moveShip for a PvP game (called from `move_ship`'s dispatch).
    pub(crate) fn pvp_move(&mut self, game_id: u64, input: MoveInput) {
        let caller = env::predecessor_account_id();
        let (mut g, mut pg) = self.load_pvp(game_id);
        let side = if caller == pg.creator {
            Side::Creator
        } else if caller == pg.joiner {
            Side::Joiner
        } else {
            env::panic_str("InvalidMove")
        };
        let evs = g.move_ship(side, &input, &self.config, Self::now_s()).or_panic();
        let last = g.last_move.clone();
        let result = self.apply_pvp_events(game_id, &mut pg, &evs);
        self.save_pvp(&caller, game_id, g, pg, result);
        events::emit("move", json!({ "game_id": U64(game_id), "last_move": last }));
    }

    fn force_end_pvp(&mut self, game_id: u64, winner: Side) {
        let caller = env::predecessor_account_id();
        let (mut g, mut pg) = self.load_pvp(game_id);
        let evs = g.force_end(Some(winner)).or_panic();
        let result = self.apply_pvp_events(game_id, &mut pg, &evs);
        self.save_pvp(&caller, game_id, g, pg, result);
    }

    fn start_pvp_game(&mut self, payer: &AccountId, l: &mut Lobby) {
        let creator_f = self.pvp.fleets.get(&(l.id, true)).cloned().unwrap();
        let joiner_f = self.pvp.fleets.get(&(l.id, false)).cloned().unwrap();
        let map = self.pvp_map(l.map_id);
        self.sp.game_count += 1;
        let game_id = self.sp.game_count;
        let g = GameState::start(
            game_id,
            &self.fleet_entries(&creator_f.ship_ids, &creator_f.positions),
            &self.fleet_entries(&joiner_f.ship_ids, &joiner_f.positions),
            l.creator_goes_first,
            l.turn_time,
            l.max_score,
            self.config.heal_cap_percent,
            GameMap::from_preset(&map),
            Self::now_s(),
        )
        .or_panic();
        l.game_id = game_id;
        let joiner = l.joiner.clone().unwrap();
        let pg = PvpGame { lobby_id: l.id, creator: l.creator.clone(), joiner: joiner.clone(), ended: false };
        self.save_pvp(payer, game_id, g, pg, None);
        events::emit("game_started", json!({ "game_id": U64(game_id), "lobby_id": U64(l.id), "creator": l.creator, "joiner": joiner }));
    }
}

#[near]
impl Contract {
    // ================================================================ lobbies

    /// Lobbies.createLobby. The first concurrent lobby is free; more cost
    /// `additional_lobby_fee` UTC; a lobby reserved for a named opponent costs
    /// `reserved_lobby_fee` UTC.
    pub fn create_lobby(
        &mut self,
        cost_limit: u64,
        turn_time: u64,
        creator_goes_first: bool,
        map_id: U64,
        max_score: u64,
        reserved_joiner: Option<AccountId>,
    ) -> U64 {
        let caller = env::predecessor_account_id();
        require!(!self.pvp.paused, "LobbyCreationPaused");
        require!((MIN_TURN_TIME..=MAX_TURN_TIME).contains(&turn_time), "InvalidTurnTime");
        require!(cost_limit <= self.pvp.max_fleet_cost_limit, "MaxFleetCostExceeded");
        require!(reserved_joiner.as_ref() != Some(&caller), "PlayerAlreadyInLobby");
        if map_id.0 > 0 {
            self.require_map_usable_for_pvp(map_id.0);
        }
        let a = self.account(&caller);
        require!(Self::now_s() >= self.timeout_end(&caller), "PlayerInTimeout");
        if reserved_joiner.is_some() {
            self.charge_lobby_fee(&caller, self.pvp.reserved_lobby_fee);
        } else if a.active_lobbies_count >= self.pvp.free_games_per_address {
            self.charge_lobby_fee(&caller, self.pvp.additional_lobby_fee);
        }
        self.pvp.lobby_count += 1;
        let id = self.pvp.lobby_count;
        let now = Self::now_s();
        let mut l = Lobby {
            id,
            creator: caller.clone(),
            cost_limit,
            created_at: now,
            joiner: None,
            reserved_joiner: reserved_joiner.clone(),
            creator_fleet: false,
            joiner_fleet: false,
            joined_at: 0,
            joiner_fleet_set_at: 0,
            creator_goes_first,
            turn_time,
            map_id: map_id.0,
            max_score,
            status: LobbyStatus::Open,
            game_started_at: 0,
            game_id: 0,
            opened_at: now,
        };
        let mut a = self.account(&caller);
        a.has_active_lobby = true;
        a.active_lobby_id = id;
        a.active_lobbies_count += 1;
        self.put_account(&caller, a);
        self.player_lobby_add(&caller, id);
        self.open_add(&mut l);
        self.save_lobby(l);
        events::emit("lobby_created", json!({ "lobby_id": U64(id), "creator": caller, "reserved_joiner": reserved_joiner }));
        U64(id)
    }

    /// Lobbies.joinLobby.
    pub fn join_lobby(&mut self, lobby_id: U64) {
        let caller = env::predecessor_account_id();
        let mut l = self.lobby(lobby_id.0);
        require!(l.status == LobbyStatus::Open, "LobbyNotOpen");
        require!(l.creator != caller, "PlayerAlreadyInLobby");
        require!(l.joiner.is_none(), "LobbyFull");
        require!(!self.pvp.kicked.contains_key(&(l.id, caller.clone())), "KickedFromLobby");
        if let Some(r) = &l.reserved_joiner {
            require!(r == &caller, "NotReservedJoiner");
        }
        let a = self.account(&caller);
        require!(Self::now_s() >= self.timeout_end(&caller), "PlayerInTimeout");
        if l.reserved_joiner.is_none() && a.active_lobbies_count >= self.pvp.free_games_per_address {
            self.charge_lobby_fee(&caller, self.pvp.additional_lobby_fee);
        }
        self.seat_joiner(&mut l, &caller);
        self.save_lobby(l);
        events::emit("player_joined_lobby", json!({ "lobby_id": lobby_id, "joiner": caller }));
    }

    /// Lobbies.acceptGame: the reserved opponent takes the seat (no fee).
    pub fn accept_game(&mut self, lobby_id: U64) {
        let caller = env::predecessor_account_id();
        let mut l = self.lobby(lobby_id.0);
        let reserved = l.reserved_joiner.clone().unwrap_or_else(|| env::panic_str("LobbyNotReserved"));
        require!(reserved == caller, "NotReservedJoiner");
        require!(l.status == LobbyStatus::Open, "LobbyNotOpen");
        require!(l.joiner.is_none(), "LobbyFull");
        require!(!self.pvp.kicked.contains_key(&(l.id, caller.clone())), "KickedFromLobby");
        self.assert_registered(&caller);
        require!(Self::now_s() >= self.timeout_end(&caller), "PlayerInTimeout");
        self.seat_joiner(&mut l, &caller);
        self.save_lobby(l);
        events::emit("game_accepted", json!({ "lobby_id": lobby_id, "joiner": caller }));
    }

    /// Lobbies.rejectGame: the reserved opponent declines; the lobby stays
    /// open to anyone.
    pub fn reject_game(&mut self, lobby_id: U64) {
        let caller = env::predecessor_account_id();
        let mut l = self.lobby(lobby_id.0);
        let reserved = l.reserved_joiner.clone().unwrap_or_else(|| env::panic_str("LobbyNotReserved"));
        require!(reserved == caller, "NotReservedJoiner");
        require!(l.status == LobbyStatus::Open, "LobbyNotOpen");
        require!(l.joiner.is_none(), "LobbyFull");
        l.reserved_joiner = None;
        self.save_lobby(l);
        events::emit("game_rejected", json!({ "lobby_id": lobby_id, "joiner": caller }));
    }

    /// Lobbies.leaveLobby. A leaving creator hands the lobby to the joiner if
    /// there is one (it reopens), else abandons it.
    pub fn leave_lobby(&mut self, lobby_id: U64) {
        let caller = env::predecessor_account_id();
        let mut l = self.lobby(lobby_id.0);
        require!(caller == l.creator || l.joiner.as_ref() == Some(&caller), "NotInLobby");
        require!(l.status != LobbyStatus::InGame, "CannotLeaveStartedGame");
        require!(self.player_in_lobby(&caller, l.id), "NotInLobby");
        if caller == l.creator {
            if l.creator_fleet {
                self.fleet_clear(l.id, true);
                l.creator_fleet = false;
            }
            if let Some(new_creator) = l.joiner.clone() {
                // Move the lobby record's attribution to its new creator.
                self.charged(&caller, |c| {
                    c.pvp.lobbies.remove(&l.id);
                });
                l.creator = new_creator.clone();
                l.joiner = None;
                l.status = LobbyStatus::Open;
                l.reserved_joiner = None;
                if l.joiner_fleet {
                    self.fleet_clear(l.id, false);
                    l.joiner_fleet = false;
                }
                let mut a = self.account(&new_creator);
                a.has_active_lobby = true;
                a.active_lobby_id = l.id;
                self.put_account(&new_creator, a);
                self.player_lobby_remove(&caller, l.id);
                self.open_add(&mut l);
                events::emit("lobby_reset", json!({ "lobby_id": lobby_id, "new_creator": new_creator }));
            } else {
                self.player_lobby_remove(&caller, l.id);
                self.open_remove(l.id, &caller);
                l.status = LobbyStatus::Open;
                l.reserved_joiner = None;
                events::emit("lobby_abandoned", json!({ "lobby_id": lobby_id, "player": caller }));
            }
        } else {
            if l.joiner_fleet {
                self.fleet_clear(l.id, false);
                l.joiner_fleet = false;
            }
            l.joiner = None;
            l.status = LobbyStatus::Open;
            l.reserved_joiner = None;
            self.player_lobby_remove(&caller, l.id);
            self.open_add(&mut l);
            events::emit("lobby_abandoned", json!({ "lobby_id": lobby_id, "player": caller }));
        }
        self.release_slot(&caller, l.id);
        self.save_lobby(l);
    }

    /// Lobbies.pruneStaleLobby: anyone may drop a lobby that has sat open past
    /// the threshold from the open list. The freed bytes go back to the
    /// lobby's creator, never to the pruner.
    pub fn prune_stale_lobby(&mut self, lobby_id: U64) {
        require!(self.pvp.open.contains(&lobby_id.0), "LobbyNotOpen");
        let l = self.lobby(lobby_id.0);
        require!(Self::now_s() >= l.opened_at + self.pvp.stale_threshold_s, "LobbyNotStaleYet");
        self.open_remove(l.id, &l.creator);
        events::emit("lobby_pruned", json!({ "lobby_id": lobby_id, "pruner": env::predecessor_account_id() }));
    }

    /// Lobbies.timeoutJoiner: the creator kicks a joiner who hasn't submitted
    /// a fleet within one turn time (a kick penalty applies if the creator had
    /// already committed theirs).
    pub fn timeout_joiner(&mut self, lobby_id: U64) {
        let caller = env::predecessor_account_id();
        let mut l = self.lobby(lobby_id.0);
        require!(caller == l.creator, "NotLobbyCreator");
        require!(l.status == LobbyStatus::FleetSelection, "LobbyNotOpen");
        let joiner = l.joiner.clone().unwrap_or_else(|| env::panic_str("LobbyNotFound"));
        require!(!l.joiner_fleet, "FleetAlreadyCreated");
        require!(Self::now_s() >= l.joined_at + l.turn_time, "TimeoutNotReached");
        if l.creator_fleet {
            self.mark_kick(&joiner);
        }
        self.release_slot(&joiner, l.id);
        let key = (l.id, joiner.clone());
        self.charged(&caller, |c| {
            c.pvp.kicked.insert(key, true);
        });
        self.player_lobby_remove(&joiner, l.id);
        self.open_add(&mut l);
        if l.creator_fleet {
            self.fleet_clear(l.id, true);
        }
        l.joiner = None;
        l.status = LobbyStatus::Open;
        l.creator_fleet = false;
        l.joiner_fleet = false;
        l.reserved_joiner = None;
        self.save_lobby(l);
        events::emit("lobby_reset", json!({ "lobby_id": lobby_id, "new_creator": caller }));
    }

    /// Lobbies.createFleet: submit a fleet; whoever commits first moves first.
    /// When both fleets are in, the game starts (paid for by this caller).
    pub fn create_lobby_fleet(&mut self, lobby_id: U64, ship_ids: Vec<U64>, positions: Vec<Position>) -> Option<U64> {
        let caller = env::predecessor_account_id();
        let mut l = self.lobby(lobby_id.0);
        require!(l.status == LobbyStatus::FleetSelection, "LobbyNotOpen");
        let is_creator = caller == l.creator;
        require!(is_creator || l.joiner.as_ref() == Some(&caller), "NotInLobby");
        require!(!(is_creator && l.creator_fleet) && !(!is_creator && l.joiner_fleet), "FleetAlreadyCreated");
        let ids: Vec<u64> = ship_ids.into_iter().map(|s| s.0).collect();
        let map = self.pvp_map(l.map_id);
        let total_cost = self.validate_and_lock_fleet(&caller, &ids, &positions, l.cost_limit, &map, is_creator, false);
        let fleet = PvpFleet { owner: caller.clone(), ship_ids: ids, positions, total_cost };
        self.charged(&caller, |c| {
            c.pvp.fleets.insert((l.id, is_creator), fleet);
        });
        if is_creator {
            l.creator_fleet = true;
            if !l.joiner_fleet {
                l.creator_goes_first = true;
            }
        } else {
            l.joiner_fleet = true;
            if !l.creator_fleet {
                l.creator_goes_first = false;
            }
            l.joiner_fleet_set_at = Self::now_s();
        }
        events::emit("fleet_created", json!({ "lobby_id": lobby_id, "player": caller }));
        let mut started = None;
        if l.creator_fleet && l.joiner_fleet {
            l.status = LobbyStatus::InGame;
            l.game_started_at = Self::now_s();
            let (creator, joiner) = (l.creator.clone(), l.joiner.clone().unwrap());
            self.player_lobby_remove(&creator, l.id);
            self.player_lobby_remove(&joiner, l.id);
            self.open_remove(l.id, &creator);
            self.release_slot(&creator, l.id);
            self.release_slot(&joiner, l.id);
            self.start_pvp_game(&caller, &mut l);
            started = Some(U64(l.game_id));
        }
        self.save_lobby(l);
        started
    }

    /// Lobbies.quitWithPenalty: a joiner whose fleet has waited a full turn
    /// time for the creator's can leave; the creator takes a kick.
    pub fn quit_with_penalty(&mut self, lobby_id: U64) {
        let caller = env::predecessor_account_id();
        let mut l = self.lobby(lobby_id.0);
        require!(l.joiner.as_ref() == Some(&caller), "NotLobbyJoiner");
        require!(l.status == LobbyStatus::FleetSelection, "LobbyNotOpen");
        require!(l.joiner_fleet, "NotInLobby");
        require!(!l.creator_fleet, "FleetAlreadyCreated");
        require!(Self::now_s() >= l.joiner_fleet_set_at + l.turn_time, "CreatorTimeoutNotReached");
        self.fleet_clear(l.id, false);
        let creator = l.creator.clone();
        self.mark_kick(&creator);
        self.release_slot(&caller, l.id);
        self.player_lobby_remove(&caller, l.id);
        self.open_add(&mut l);
        l.joiner = None;
        l.status = LobbyStatus::Open;
        l.creator_fleet = false;
        l.joiner_fleet = false;
        l.reserved_joiner = None;
        self.save_lobby(l);
        events::emit("lobby_terminated", json!({ "lobby_id": lobby_id }));
    }

    /// Lobbies.createLobbyForAddresses (owner): a lobby already seated with
    /// both players (e.g. organized matches). Both must be registered; the
    /// creator's storage pays for the lobby.
    pub fn create_lobby_for_addresses(&mut self, creator: AccountId, joiner: AccountId, cost_limit: u64, turn_time: u64, map_id: U64, max_score: u64) -> U64 {
        self.assert_owner();
        require!((MIN_TURN_TIME..=MAX_TURN_TIME).contains(&turn_time), "InvalidTurnTime");
        require!(creator != joiner, "PlayerAlreadyInLobby");
        require!(cost_limit <= self.pvp.max_fleet_cost_limit, "MaxFleetCostExceeded");
        if map_id.0 > 0 {
            self.require_map_usable_for_pvp(map_id.0);
        }
        self.assert_registered(&creator);
        self.assert_registered(&joiner);
        self.pvp.lobby_count += 1;
        let id = self.pvp.lobby_count;
        let now = Self::now_s();
        let l = Lobby {
            id,
            creator: creator.clone(),
            cost_limit,
            created_at: now,
            joiner: Some(joiner.clone()),
            reserved_joiner: None,
            creator_fleet: false,
            joiner_fleet: false,
            joined_at: now,
            joiner_fleet_set_at: 0,
            creator_goes_first: false,
            turn_time,
            map_id: map_id.0,
            max_score,
            status: LobbyStatus::FleetSelection,
            game_started_at: 0,
            game_id: 0,
            opened_at: 0,
        };
        for p in [&creator, &joiner] {
            let mut a = self.account(p);
            a.has_active_lobby = true;
            a.active_lobby_id = id;
            a.active_lobbies_count += 1;
            self.put_account(p, a);
            self.player_lobby_add(p, id);
        }
        self.save_lobby(l);
        events::emit("lobby_created", json!({ "lobby_id": U64(id), "creator": creator, "joiner": joiner }));
        U64(id)
    }

    pub fn set_lobby_config(&mut self, free_games_per_address: u32, additional_lobby_fee: U128, reserved_lobby_fee: U128, max_fleet_cost_limit: u64, stale_threshold_s: u64) {
        self.assert_owner();
        let p = &mut self.pvp;
        p.free_games_per_address = free_games_per_address;
        p.additional_lobby_fee = additional_lobby_fee.0;
        p.reserved_lobby_fee = reserved_lobby_fee.0;
        p.max_fleet_cost_limit = max_fleet_cost_limit;
        p.stale_threshold_s = stale_threshold_s;
    }

    pub fn set_lobbies_paused(&mut self, paused: bool) {
        self.assert_role(roles::PAUSER);
        self.pvp.paused = paused;
    }

    // =================================================================== match

    /// PvPMatch.flee: concede; the opponent wins.
    pub fn flee(&mut self, game_id: U64) {
        let caller = env::predecessor_account_id();
        let (g, pg) = self.load_pvp(game_id.0);
        require!(!g.ended, "InvalidMove");
        let winner = if caller == pg.creator {
            Side::Joiner
        } else if caller == pg.joiner {
            Side::Creator
        } else {
            env::panic_str("NotInGame")
        };
        self.force_end_pvp(game_id.0, winner);
    }

    /// PvPMatch.endGameOnTimeout: the waiting player wins once the player to
    /// move has exceeded the turn time.
    pub fn end_game_on_timeout(&mut self, game_id: U64) {
        let caller = env::predecessor_account_id();
        let (g, pg) = self.load_pvp(game_id.0);
        require!(Self::now_s() > g.turn_start_time + g.turn_time, "TurnTimeoutNotReached");
        let current = if g.current_turn == Side::Creator { &pg.creator } else { &pg.joiner };
        require!(&caller != current, "InvalidMove");
        let side = if caller == pg.creator {
            Side::Creator
        } else if caller == pg.joiner {
            Side::Joiner
        } else {
            env::panic_str("NotInGame")
        };
        self.force_end_pvp(game_id.0, side);
    }

    // ============================================================ blob registry

    /// GameBlobRegistry.record: a participant (or the BLOB_WRITER backend)
    /// stores a replay blob id for a finished game. Storage: the caller.
    pub fn record_blob(&mut self, game_id: U64, player: AccountId, blob_id: String) {
        let caller = env::predecessor_account_id();
        let r = self.pvp.results.get(&game_id.0).cloned().unwrap_or_else(|| env::panic_str("GameNotComplete"));
        require!(player == r.winner || player == r.loser, "NotParticipant");
        if caller != player {
            self.assert_role(roles::BLOB_WRITER);
        }
        let blob = crate::shop::parse_hash_pub(&blob_id);
        self.charged(&caller, |c| {
            c.pvp.blobs.insert((game_id.0, player.clone()), blob);
        });
        events::emit("blob_recorded", json!({ "game_id": game_id, "player": player, "blob_id": blob_id }));
    }

    // =================================================================== views

    pub fn get_lobby(&self, lobby_id: U64) -> Option<Lobby> {
        self.pvp.lobbies.get(&lobby_id.0).cloned()
    }

    pub fn get_open_lobbies(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<U64> {
        self.pvp.open.iter().skip(from_index.unwrap_or(0) as usize).take(limit.unwrap_or(50).min(100) as usize).map(|&i| U64(i)).collect()
    }

    pub fn get_open_lobby_count(&self) -> u32 {
        self.pvp.open.len()
    }

    pub fn is_lobby_open(&self, lobby_id: U64) -> bool {
        self.pvp.open.contains(&lobby_id.0)
    }

    pub fn get_player_lobbies(&self, account_id: AccountId) -> Vec<U64> {
        let n = self.accounts.get(&account_id).map_or(0, |a| a.lobby_count);
        (0..n).filter_map(|i| self.pvp.player_lobby_at.get(&(account_id.clone(), i)).map(|&id| U64(id))).collect()
    }

    pub fn get_player_lobby_state(&self, account_id: AccountId) -> PlayerLobbyState {
        let a = self.accounts.get(&account_id).cloned().unwrap_or_default();
        PlayerLobbyState {
            active_lobby_id: U64(a.active_lobby_id),
            active_lobbies_count: a.active_lobbies_count,
            has_active_lobby: a.has_active_lobby,
            kick_count: a.kick_count,
            last_kick_time_s: U64(a.last_kick_time_s),
            timeout_end_s: U64(self.timeout_end(&account_id)),
        }
    }

    pub fn get_lobby_fleet(&self, lobby_id: U64, is_creator: bool) -> Option<PvpFleet> {
        self.pvp.fleets.get(&(lobby_id.0, is_creator)).cloned()
    }

    pub fn get_pvp_game(&self, game_id: U64) -> Option<PvpGame> {
        self.pvp.games.get(&game_id.0).cloned()
    }

    pub fn get_game_result(&self, game_id: U64) -> Option<GameResult> {
        self.pvp.results.get(&game_id.0).cloned()
    }

    /// GameResults.getPlayerStats (PvP + tutorial).
    pub fn get_player_stats(&self, account_id: AccountId) -> near_sdk::serde_json::Value {
        let a = self.accounts.get(&account_id).cloned().unwrap_or_default();
        json!({ "wins": a.wins, "losses": a.losses })
    }

    pub fn get_blob(&self, game_id: U64, player: AccountId) -> Option<String> {
        self.pvp.blobs.get(&(game_id.0, player)).map(|b| format!("0x{}", b.iter().map(|x| format!("{x:02x}")).collect::<String>()))
    }
}

impl Contract {
    /// Shared tail of joinLobby / acceptGame.
    fn seat_joiner(&mut self, l: &mut Lobby, joiner: &AccountId) {
        l.reserved_joiner = None;
        l.joiner = Some(joiner.clone());
        l.status = LobbyStatus::FleetSelection;
        l.joined_at = Self::now_s();
        let mut a = self.account(joiner);
        if !a.has_active_lobby {
            a.has_active_lobby = true;
            a.active_lobby_id = l.id;
        }
        a.active_lobbies_count += 1;
        self.put_account(joiner, a);
        self.player_lobby_add(joiner, l.id);
        self.open_remove(l.id, &l.creator.clone());
    }
}

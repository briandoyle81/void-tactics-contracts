//! Roguelike runs: RoguelikeNodeMap (campaign graph), RoguelikeRun (the per-
//! player ledger: generations, locked/defeated nodes, roster HP),
//! RoguelikeMatch (start/advance/retreat, combat nodes, post-win roster),
//! RoguelikeResupply (repair, roster changes) and the three win effects
//! (DEC bonus, heal above floor, ship grant) -- all internal calls.
//!
//! Storage: everything a run writes belongs to the run's player, so every
//! roguelike call charges the player (including someone else advancing the
//! AI). Win effects never revert the game-ending move: each pre-checks and
//! logs `win_effect_failed` instead (a ship grant the player's storage can't
//! cover is skipped).

use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::json;
use near_sdk::store::LookupMap;
use near_sdk::{env, near, require, AccountId};
use vt_core::ai::{take_ai_turns as run_ai_turns, AiLog, AiShipInfo};
use vt_core::attributes::calculate;
use vt_core::engine::{EngineEvent, GameState, MoveInput, Side};
use vt_core::maps::{GameMap, PresetMap};
use vt_core::types::*;

use crate::config::TokenKind;
use crate::events;
use crate::ships::AI_SHIP_ID_OFFSET;
use crate::single_player::MAX_AI_MOVES_PER_CALL;
use crate::{roles, Contract, ContractExt, OrPanic, StorageKey};

/// Bytes a ship grant needs from the player's spare storage (record + index,
/// with headroom). Below this the grant is skipped rather than reverting.
const GRANT_STORAGE_BYTES: u64 = 1_000;

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RlNodeKind {
    Combat,
    Resupply,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RunStatus {
    None,
    Active,
    Won,
    Ended,
}

/// ShipGrantWinEffect.ShipGrant.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct ShipGrant {
    pub name: String,
    pub equipment: Equipment,
    pub colors: Colors,
    pub variant: u16,
    pub accuracy: u8,
    pub hull: u8,
    pub speed: u8,
    pub ships_destroyed: u32,
    pub shiny: bool,
    pub is_free_ship: bool,
    pub once_per_address: bool,
}

/// The win-effect contracts, as values configured per node.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub enum WinEffect {
    DecBonus { amount: U128 },
    HealAboveFloor { percent: u8 },
    ShipGrant(ShipGrant),
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, Default)]
pub struct RlCampaign {
    pub root_node: u64,
    pub auto_heal_percent: u8,
    pub required_variant: u16,
    pub initial_cost_cap: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct RlNode {
    pub campaign_id: u64,
    pub kind: RlNodeKind,
    pub map_id: u64,
    pub turn_time: u64,
    pub max_score: u64,
    pub creator_goes_first: bool,
    /// 0 = no change to the run's cost cap (resupply nodes).
    pub cost_cap_override: u64,
    pub children: Vec<u64>,
    pub win_effects: Vec<WinEffect>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Run {
    pub status: RunStatus,
    pub required_variant_at_start: u16,
    pub generation: u64,
    pub campaign_id: u64,
    pub current_node: u64,
    pub current_cost_cap: u64,
    /// Reservation fleet (ships locked between combats), in roster order.
    pub reservation: Vec<u64>,
    pub reservation_cost: u64,
    pub active_game_id: u64,
    /// (ship id, carried hp); hp 0 = full.
    pub roster: Vec<(u64, u8)>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct RlMatch {
    pub player: AccountId,
    pub node_id: u64,
    pub heal_percent_at_start: u8,
    pub is_final_at_start: bool,
    pub win_effects_at_start: Vec<WinEffect>,
    pub ai_ships: Vec<(u64, Ship, AiShipInfo)>,
    /// Human combat fleet, kept in Fleets' swap-remove order.
    pub combat_fleet: Vec<u64>,
    pub combat_fleet_cost: u64,
}

#[near(serializers = [borsh])]
pub struct RlState {
    pub campaigns: LookupMap<u64, RlCampaign>,
    pub campaign_count: u64,
    pub nodes: LookupMap<u64, RlNode>,
    pub node_count: u64,
    pub runs: LookupMap<AccountId, Run>,
    /// RoguelikeRun.shipHPByGen: HP of ships dropped from the roster.
    pub dropped_hp: LookupMap<(AccountId, u64, u64), u8>,
    pub locked: LookupMap<(AccountId, u64, u64), bool>,
    pub defeated: LookupMap<(AccountId, u64, u64), bool>,
    pub active_runs_at_node: LookupMap<u64, u64>,
    pub runs_started: u64,
    pub matches: LookupMap<u64, RlMatch>,
    pub grant_claimed: LookupMap<(u64, AccountId), bool>,
    /// RoguelikeResupply.repairCostPerHP (UTC).
    pub repair_cost_per_hp: u128,
}

impl RlState {
    pub fn new() -> Self {
        Self {
            campaigns: LookupMap::new(StorageKey::RlCampaigns),
            campaign_count: 0,
            nodes: LookupMap::new(StorageKey::RlNodes),
            node_count: 0,
            runs: LookupMap::new(StorageKey::RlRuns),
            dropped_hp: LookupMap::new(StorageKey::RlDroppedHp),
            locked: LookupMap::new(StorageKey::RlLocked),
            defeated: LookupMap::new(StorageKey::RlDefeated),
            active_runs_at_node: LookupMap::new(StorageKey::RlActiveRunsAtNode),
            runs_started: 0,
            matches: LookupMap::new(StorageKey::RlMatches),
            grant_claimed: LookupMap::new(StorageKey::RlGrantClaimed),
            repair_cost_per_hp: 10_000_000_000_000_000, // 1 UTC per 100 HP
        }
    }

    pub fn flush(&mut self) {
        self.campaigns.flush();
        self.nodes.flush();
        self.runs.flush();
        self.dropped_hp.flush();
        self.locked.flush();
        self.defeated.flush();
        self.active_runs_at_node.flush();
        self.matches.flush();
        self.grant_claimed.flush();
    }

    fn node(&self, id: u64) -> &RlNode {
        self.nodes.get(&id).unwrap_or_else(|| env::panic_str("NodeNotFound"))
    }

    fn is_locked(&self, p: &AccountId, generation: u64, node: u64) -> bool {
        self.locked.get(&(p.clone(), generation, node)).copied().unwrap_or(false)
    }

    fn is_defeated(&self, p: &AccountId, generation: u64, node: u64) -> bool {
        self.defeated.get(&(p.clone(), generation, node)).copied().unwrap_or(false)
    }

    fn bump_node(&mut self, node: u64, up: bool) {
        let n = self.active_runs_at_node.get(&node).copied().unwrap_or(0);
        self.active_runs_at_node.insert(node, if up { n + 1 } else { n.saturating_sub(1) });
    }

    /// RoguelikeRun.getShipHP.
    pub(crate) fn ship_hp(&self, p: &AccountId, run: &Run, ship: u64) -> u8 {
        run.roster
            .iter()
            .find(|e| e.0 == ship)
            .map(|e| e.1)
            .unwrap_or_else(|| self.dropped_hp.get(&(p.clone(), run.generation, ship)).copied().unwrap_or(0))
    }

    /// RoguelikeRun.setShipHP.
    pub(crate) fn set_ship_hp(&mut self, p: &AccountId, run: &mut Run, ship: u64, hp: u8) {
        if let Some(e) = run.roster.iter_mut().find(|e| e.0 == ship) {
            e.1 = hp;
            return;
        }
        self.dropped_hp.insert((p.clone(), run.generation, ship), hp);
    }

    /// RoguelikeRun._setRoster: kept ships keep their HP, returning ships
    /// recover their dropped HP, dropped ships stash theirs; `hps` (if given)
    /// overrides.
    pub(crate) fn set_roster(&mut self, p: &AccountId, run: &mut Run, ids: &[u64], hps: Option<&[u8]>) {
        let old = run.roster.clone();
        let mut old_kept = vec![false; old.len()];
        let mut roster = Vec::with_capacity(ids.len());
        for (i, &id) in ids.iter().enumerate() {
            let mut hp = 0u8;
            let mut found = false;
            for (j, e) in old.iter().enumerate() {
                if e.0 == id {
                    old_kept[j] = true;
                    found = true;
                    hp = e.1;
                    break;
                }
            }
            if !found {
                let key = (p.clone(), run.generation, id);
                hp = self.dropped_hp.get(&key).copied().unwrap_or(0);
                if hp != 0 {
                    self.dropped_hp.remove(&key);
                }
            }
            if let Some(h) = hps {
                hp = h[i];
            }
            roster.push((id, hp));
        }
        for (j, e) in old.iter().enumerate() {
            if !old_kept[j] && e.1 != 0 {
                self.dropped_hp.insert((p.clone(), run.generation, e.0), e.1);
            }
        }
        run.roster = roster;
    }

    fn end_run(&mut self, run: &mut Run, won: bool) {
        if run.current_node != 0 {
            self.bump_node(run.current_node, false);
        }
        run.status = if won { RunStatus::Won } else { RunStatus::Ended };
    }
}

impl Default for RlState {
    fn default() -> Self {
        Self::new()
    }
}

/// RoguelikeMatch._rosterPositions: rows of 4 in the creator band.
fn roster_positions(n: usize) -> Vec<Position> {
    (0..n).map(|i| Position { row: (i / 4) as i16, col: (i % 4) as i16 }).collect()
}

fn healed_hp(heal_pct: u8, hp: u8, max: u8) -> u8 {
    let floor = (max as u16 * heal_pct as u16) / 100;
    let mut h = (hp as u16).max(floor);
    if h > max as u16 {
        h = max as u16;
    }
    if h == 0 {
        h = 1;
    }
    h as u8
}

impl Contract {
    fn run_of(&self, p: &AccountId) -> Run {
        self.rl.runs.get(p).cloned().unwrap_or(Run {
            status: RunStatus::None,
            required_variant_at_start: 0,
            generation: 0,
            campaign_id: 0,
            current_node: 0,
            current_cost_cap: 0,
            reservation: vec![],
            reservation_cost: 0,
            active_game_id: 0,
            roster: vec![],
        })
    }

    pub(crate) fn current_attrs(&self, ship: u64) -> vt_core::Result<Attributes> {
        let s = self.ships.get(&ship).ok_or(vt_core::Error::ShipNotFound)?.ship.clone();
        let (version, table) = self.config.current_table(s.traits.variant)?;
        calculate(table, version, &s.stats_input())
    }

    fn unlock_all(&mut self, ids: &[u64]) {
        for &id in ids {
            self.set_in_fleet(id, false);
        }
    }

    /// RoguelikeMatch._commitToNode.
    fn commit_to_node(&mut self, p: &AccountId, run: &mut Run, target: u64) -> RlNode {
        require!(run.active_game_id == 0, "ActiveGameInProgress");
        let node = self.rl.node(target).clone();
        if target == run.current_node {
            return node;
        }
        let current = self.rl.node(run.current_node).clone();
        if current.kind == RlNodeKind::Combat {
            require!(self.rl.is_defeated(p, run.generation, run.current_node), "CurrentNodeNotCleared");
        }
        require!(!self.rl.is_locked(p, run.generation, target), "CannotAdvance");
        require!(current.children.contains(&target), "CannotAdvance");
        for &c in &current.children {
            if c != target {
                self.rl.locked.insert((p.clone(), run.generation, c), true);
            }
        }
        self.rl.locked.insert((p.clone(), run.generation, run.current_node), true);
        self.rl.bump_node(run.current_node, false);
        self.rl.bump_node(target, true);
        run.current_node = target;
        node
    }

    /// Fleets.reserveFleet validation for (survivors + rejoiners), without
    /// side effects: true if it would succeed.
    fn check_reserve(&self, p: &AccountId, kept: &[u64], kept_cost: u64, rejoiners: &[u64], cap: u64) -> bool {
        let n = kept.len() + rejoiners.len();
        if n > 44 {
            return false; // roster positions run off the creator band
        }
        let mut cost = kept_cost;
        let mut variant = None;
        for (i, &id) in rejoiners.iter().enumerate() {
            if rejoiners[..i].contains(&id) || kept.contains(&id) {
                return false;
            }
            let Some(r) = self.ships.get(&id) else { return false };
            let s = &r.ship;
            if &r.owner != p || s.ship_data.in_fleet || !s.ship_data.constructed || s.ship_data.timestamp_destroyed != 0 {
                return false;
            }
            match variant {
                None => variant = Some(s.traits.variant),
                Some(v) if v != s.traits.variant => return false,
                _ => {}
            }
            cost += s.ship_data.cost as u64;
        }
        if let (Some(first_kept), Some(v)) = (kept.first(), variant) {
            if self.ships.get(first_kept).map(|r| r.ship.traits.variant) != Some(v) {
                return false;
            }
        }
        cost <= cap
    }

    /// Applies a roguelike game's engine side effects. Never panics on the
    /// reward / win-effect path.
    pub(crate) fn apply_rl_events(&mut self, game_id: u64, m: &mut RlMatch, g: &GameState, evs: &[EngineEvent]) {
        let now = Self::now_s();
        for e in evs {
            match *e {
                EngineEvent::ShipLeftFleet { ship_id, side } => {
                    if side == Side::Creator {
                        if let Some(i) = m.combat_fleet.iter().position(|&s| s == ship_id) {
                            m.combat_fleet.swap_remove(i);
                            if let Some(r) = self.ships.get(&ship_id) {
                                m.combat_fleet_cost = m.combat_fleet_cost.saturating_sub(r.ship.ship_data.cost as u64);
                            }
                        }
                        self.set_in_fleet(ship_id, false);
                    }
                }
                EngineEvent::ShipDestroyed { ship_id, last_damager } => {
                    if ship_id < AI_SHIP_ID_OFFSET {
                        self.mark_destroyed(ship_id, now);
                        continue;
                    }
                    if last_damager == 0 || last_damager >= AI_SHIP_ID_OFFSET {
                        continue;
                    }
                    let variant = m.ai_ships.iter().find(|a| a.0 == ship_id).map_or(0, |a| a.1.traits.variant);
                    let Some(owner) = self.ships.get(&last_damager).map(|r| r.owner.clone()) else { continue };
                    let paid = match self.config.reward_token.get(&variant).copied() {
                        Some(t) => self.try_mint(&owner, t, self.config.faction_kill_reward),
                        None => false,
                    };
                    if !paid {
                        events::emit("reward_skipped", json!({ "game_id": U64(game_id), "variant": variant, "destroyer_owner": owner }));
                    }
                }
                EngineEvent::GameEnded { winner } => {
                    self.on_rl_game_ended(game_id, m, g, winner);
                    // Game._endGame: clear what's left of the human fleet.
                    let rest = core::mem::take(&mut m.combat_fleet);
                    self.unlock_all(&rest);
                    m.combat_fleet_cost = 0;
                    events::emit("game_ended", json!({ "game_id": U64(game_id), "winner": winner }));
                }
            }
        }
    }

    /// RoguelikeMatch.onGameEnded.
    fn on_rl_game_ended(&mut self, game_id: u64, m: &mut RlMatch, g: &GameState, winner: Option<Side>) {
        let p = m.player.clone();
        let mut run = self.run_of(&p);
        if run.status != RunStatus::Active || run.active_game_id != game_id {
            return;
        }
        run.active_game_id = 0;
        if winner != Some(Side::Creator) {
            self.rl.end_run(&mut run, false);
            self.rl.runs.insert(p.clone(), run);
            events::emit("run_ended", json!({ "player": p, "won": false }));
            return;
        }
        self.rl.defeated.insert((p.clone(), run.generation, run.current_node), true);

        // _postWinRoster: survivors (combat-fleet order) then fled ships that
        // can rejoin, all healed to the campaign floor.
        let old_ids: Vec<u64> = run.roster.iter().map(|e| e.0).collect();
        let survivors = m.combat_fleet.clone();
        let mut roster = Vec::new();
        let mut hps = Vec::new();
        for &s in &survivors {
            let a = g.ship_attributes(s).unwrap_or_default();
            roster.push(s);
            hps.push(healed_hp(m.heal_percent_at_start, a.hull_points, a.max_hull_points));
        }
        for &s in &old_ids {
            if survivors.contains(&s) || !self.can_rejoin(g, &p, s) {
                continue;
            }
            let Ok(a) = self.current_attrs(s) else { continue };
            roster.push(s);
            hps.push(healed_hp(m.heal_percent_at_start, 0, a.max_hull_points));
        }
        self.rl.set_roster(&p, &mut run, &roster, Some(&hps));
        // _stashFledHP: fled ships that didn't rejoin keep a healed HP.
        for &s in &old_ids {
            if roster.contains(&s) || g.ship(s).status != 2 {
                continue;
            }
            if let Ok(a) = self.current_attrs(s) {
                self.rl.set_ship_hp(&p, &mut run, s, healed_hp(m.heal_percent_at_start, 0, a.max_hull_points));
            }
        }
        for eff in m.win_effects_at_start.clone() {
            if let Err(reason) = self.apply_win_effect(&p, &mut run, m.node_id, &eff) {
                events::emit("win_effect_failed", json!({ "player": p, "node_id": U64(m.node_id), "reason": reason }));
            }
        }
        if m.is_final_at_start {
            self.rl.end_run(&mut run, true);
            events::emit("run_ended", json!({ "player": p, "won": true }));
        } else {
            // Fleets.reserveFleet(survivors + rejoiners), falling back to
            // survivors only (validated first, so no partial application).
            let rejoiners: Vec<u64> = roster[survivors.len()..].to_vec();
            let kept_cost = m.combat_fleet_cost;
            if !self.check_reserve(&p, &survivors, kept_cost, &rejoiners, run.current_cost_cap) {
                self.rl.set_roster(&p, &mut run, &survivors, None);
                run.reservation = survivors.clone();
                run.reservation_cost = kept_cost;
            } else {
                for &s in &rejoiners {
                    self.set_in_fleet(s, true);
                }
                let rejoin_cost: u64 = rejoiners.iter().map(|s| self.ships.get(s).map_or(0, |r| r.ship.ship_data.cost as u64)).sum();
                run.reservation = roster.clone();
                run.reservation_cost = kept_cost + rejoin_cost;
            }
            // Survivors move into the reservation (still locked); the combat
            // fleet is now empty, so Game._endGame's clear unlocks nothing.
            m.combat_fleet.clear();
            m.combat_fleet_cost = 0;
        }
        self.rl.runs.insert(p, run);
    }

    /// RoguelikeMatch._canRejoin.
    fn can_rejoin(&self, g: &GameState, p: &AccountId, ship: u64) -> bool {
        if g.ship(ship).status != 2 {
            return false;
        }
        self.ships.get(&ship).is_some_and(|r| &r.owner == p && !r.ship.ship_data.in_fleet && r.ship.ship_data.timestamp_destroyed == 0)
    }

    fn apply_win_effect(&mut self, p: &AccountId, run: &mut Run, node_id: u64, eff: &WinEffect) -> Result<(), &'static str> {
        match eff {
            WinEffect::DecBonus { amount } => {
                if amount.0 > 0 && !self.try_mint(p, TokenKind::Dec, amount.0) {
                    return Err("MintFailed");
                }
                Ok(())
            }
            WinEffect::HealAboveFloor { percent } => {
                // Computed fully first: a failure applies nothing (try/catch).
                let mut updates = Vec::new();
                for &(id, _) in &run.roster {
                    let stored = self.rl.ship_hp(p, run, id);
                    let a = self.current_attrs(id).map_err(|e| e.name())?;
                    let current = if stored == 0 { a.max_hull_points } else { stored };
                    let target = (a.max_hull_points as u16 * *percent as u16) / 100;
                    if target > current as u16 {
                        updates.push((id, target as u8));
                    }
                }
                for (id, hp) in updates {
                    self.rl.set_ship_hp(p, run, id, hp);
                }
                Ok(())
            }
            WinEffect::ShipGrant(gr) => {
                let key = (node_id, p.clone());
                if gr.once_per_address && self.rl.grant_claimed.get(&key).copied().unwrap_or(false) {
                    return Ok(());
                }
                if self.config.mint_paused {
                    return Err("MintPaused");
                }
                if gr.variant == 0 || gr.variant > self.config.max_variant || self.config.costs.get(&gr.variant).is_none() {
                    return Err("InvalidVariant");
                }
                if self.accounts.get(p).is_none_or(|a| a.spare_bytes() < GRANT_STORAGE_BYTES) {
                    return Err("InsufficientStorageBalance");
                }
                if gr.once_per_address {
                    self.rl.grant_claimed.insert(key, true);
                }
                let mut ship = Ship { name: gr.name.clone(), equipment: gr.equipment.clone(), ..Default::default() };
                ship.traits = Traits { serial_number: 0, colors: gr.colors.clone(), variant: gr.variant, accuracy: gr.accuracy, hull: gr.hull, speed: gr.speed };
                ship.ship_data.ships_destroyed = gr.ships_destroyed;
                ship.ship_data.shiny = gr.shiny;
                ship.ship_data.is_free_ship = gr.is_free_ship;
                let id = self.internal_create_specific_ship_ex(p, &ship, true);
                events::emit("ship_granted", json!({ "node_id": U64(node_id), "player": p, "ship_id": U64(id) }));
                Ok(())
            }
        }
    }

    pub(crate) fn load_rl(&self, game_id: u64) -> (GameState, RlMatch) {
        let g = self.sp.games.get(&game_id).cloned().unwrap_or_else(|| env::panic_str("GameNotFound"));
        let m = self.rl.matches.get(&game_id).cloned().unwrap_or_else(|| env::panic_str("GameNotFound"));
        (g, m)
    }

    pub(crate) fn save_rl(&mut self, game_id: u64, g: GameState, m: RlMatch) {
        self.sp.games.insert(game_id, g);
        self.rl.matches.insert(game_id, m);
    }

    /// move_ship dispatch target for roguelike games (human = creator).
    pub(crate) fn rl_move(&mut self, game_id: u64, input: MoveInput) {
        let caller = env::predecessor_account_id();
        let (mut g, mut m) = self.load_rl(game_id);
        require!(caller == m.player, "InvalidMove");
        let initial = env::storage_usage();
        let evs = g.move_ship(Side::Creator, &input, &self.config, Self::now_s()).or_panic();
        let last = g.last_move.clone();
        self.apply_rl_events(game_id, &mut m, &g, &evs);
        self.save_rl(game_id, g, m);
        self.charge_storage_since(&caller, initial);
        events::emit("move", json!({ "game_id": U64(game_id), "last_move": last }));
    }

    /// take_ai_turns dispatch target for roguelike games.
    pub(crate) fn rl_ai_turns(&mut self, game_id: u64, max_moves: u32) -> u32 {
        let (mut g, mut m) = self.load_rl(game_id);
        let initial = env::storage_usage();
        let info = |id: u64| m.ai_ships.iter().find(|a| a.0 == id).map(|a| a.2.clone());
        let res = run_ai_turns(&mut g, &self.config, &info, max_moves.clamp(1, MAX_AI_MOVES_PER_CALL), Self::now_s())
            .unwrap_or_else(|e| env::panic_str(e));
        self.apply_rl_events(game_id, &mut m, &g, &res.events);
        let player = m.player.clone();
        self.save_rl(game_id, g, m);
        self.charge_storage_since(&player, initial);
        let logs: Vec<_> = res
            .logs
            .iter()
            .map(|l| match l {
                AiLog::DecisionFailed { ship_id } => json!({ "decision_failed": U64(*ship_id) }),
                AiLog::TurnTaken { ship_id, action, target } => json!({ "ship_id": U64(*ship_id), "action": action, "target": U64(*target) }),
            })
            .collect();
        events::emit("ai_turns", json!({ "game_id": U64(game_id), "turns": logs }));
        res.moves
    }
}

#[near]
impl Contract {
    // ============================================================ graph admin

    pub fn create_rl_campaign(&mut self) -> U64 {
        self.assert_role(roles::NODE_EDITOR);
        self.rl.campaign_count += 1;
        let id = self.rl.campaign_count;
        self.rl.campaigns.insert(id, RlCampaign::default());
        U64(id)
    }

    /// Root, auto-heal floor (%), required variant (0 = any), initial cost cap.
    pub fn set_rl_campaign(&mut self, campaign_id: U64, root_node: U64, auto_heal_percent: u8, required_variant: u16, initial_cost_cap: u64) {
        self.assert_role(roles::NODE_EDITOR);
        require!(self.rl.campaigns.contains_key(&campaign_id.0), "CampaignNotFound");
        require!(root_node.0 == 0 || self.rl.nodes.contains_key(&root_node.0), "NodeNotFound");
        require!(auto_heal_percent <= 100, "InvalidHealPercent");
        self.rl.campaigns.insert(
            campaign_id.0,
            RlCampaign { root_node: root_node.0, auto_heal_percent, required_variant, initial_cost_cap },
        );
    }

    #[allow(clippy::too_many_arguments)]
    pub fn create_rl_node(
        &mut self,
        campaign_id: U64,
        kind: RlNodeKind,
        map_id: U64,
        turn_time: u64,
        max_score: u64,
        creator_goes_first: bool,
        cost_cap_override: u64,
    ) -> U64 {
        self.assert_role(roles::NODE_EDITOR);
        require!(self.rl.campaigns.contains_key(&campaign_id.0), "CampaignNotFound");
        if kind == RlNodeKind::Combat {
            let m = self.sp.maps.get(&map_id.0).unwrap_or_else(|| env::panic_str("MapNotFound"));
            require!(m.mode == MapMode::PvE || m.mode == MapMode::Both, "InvalidMapMode");
        }
        self.rl.node_count += 1;
        let id = self.rl.node_count;
        self.rl.nodes.insert(
            id,
            RlNode { campaign_id: campaign_id.0, kind, map_id: map_id.0, turn_time, max_score, creator_goes_first, cost_cap_override, children: vec![], win_effects: vec![] },
        );
        U64(id)
    }

    pub fn add_rl_child(&mut self, parent_id: U64, child_id: U64) {
        self.assert_role(roles::NODE_EDITOR);
        let mut parent = self.rl.nodes.get(&parent_id.0).cloned().unwrap_or_else(|| env::panic_str("NodeNotFound"));
        require!(self.rl.nodes.contains_key(&child_id.0), "ChildNotFound");
        require!(child_id != parent_id, "SelfChild");
        require!(!parent.children.contains(&child_id.0), "ChildAlreadyExists");
        parent.children.push(child_id.0);
        self.rl.nodes.insert(parent_id.0, parent);
    }

    /// Refuses to remove a node's last child while runs sit on it
    /// (WouldStrandActiveRun).
    pub fn remove_rl_child(&mut self, parent_id: U64, child_id: U64) {
        self.assert_role(roles::NODE_EDITOR);
        let mut parent = self.rl.nodes.get(&parent_id.0).cloned().unwrap_or_else(|| env::panic_str("NodeNotFound"));
        let i = parent.children.iter().position(|&c| c == child_id.0).unwrap_or_else(|| env::panic_str("ChildNotInNode"));
        require!(
            !(parent.children.len() == 1 && self.rl.active_runs_at_node.get(&parent_id.0).copied().unwrap_or(0) > 0),
            "WouldStrandActiveRun"
        );
        parent.children.swap_remove(i);
        self.rl.nodes.insert(parent_id.0, parent);
    }

    /// Win effects mint ships/DEC, so they're owner-only (as the effect
    /// contracts' own config was).
    pub fn set_rl_node_win_effects(&mut self, node_id: U64, effects: Vec<WinEffect>) {
        self.assert_owner();
        let mut n = self.rl.nodes.get(&node_id.0).cloned().unwrap_or_else(|| env::panic_str("NodeNotFound"));
        for e in &effects {
            match e {
                WinEffect::HealAboveFloor { percent } => require!(*percent <= 100, "InvalidHealPercent"),
                WinEffect::ShipGrant(g) => {
                    for t in [g.accuracy, g.hull, g.speed] {
                        require!(t <= 2, "InvalidTraitValue");
                    }
                    require!(g.variant != 0 && g.variant <= self.config.max_variant, "InvalidVariant");
                    require!(g.equipment.armor == Armor::None || g.equipment.shields == Shields::None, "ArmorAndShieldsBothSet");
                }
                WinEffect::DecBonus { .. } => {}
            }
        }
        n.win_effects = effects;
        self.rl.nodes.insert(node_id.0, n);
    }

    pub fn reset_rl_grant_claim(&mut self, node_id: U64, account_id: AccountId) {
        self.assert_owner();
        self.rl.grant_claimed.remove(&(node_id.0, account_id));
    }

    pub fn set_repair_cost_per_hp(&mut self, cost: U128) {
        self.assert_owner();
        self.rl.repair_cost_per_hp = cost.0;
    }

    // ================================================================= runs

    /// RoguelikeMatch.startRun: reserve a roster under the campaign's initial
    /// cost cap and stand on the root node.
    pub fn start_run(&mut self, campaign_id: U64, ship_ids: Vec<U64>) -> U64 {
        let p = env::predecessor_account_id();
        self.assert_registered(&p);
        let ids: Vec<u64> = ship_ids.into_iter().map(|s| s.0).collect();
        require!(!ids.is_empty(), "EmptyRoster");
        let c = self.rl.campaigns.get(&campaign_id.0).cloned().unwrap_or_else(|| env::panic_str("CampaignNotFound"));
        require!(c.root_node != 0, "CampaignHasNoRoot");
        if c.required_variant != 0 {
            require!(self.ship_record(ids[0]).ship.traits.variant == c.required_variant, "WrongCampaignVariant");
        }
        let mut run = self.run_of(&p);
        require!(run.status != RunStatus::Active, "RunAlreadyActive");
        let initial = env::storage_usage();
        let cost = self.validate_and_lock_fleet(&p, &ids, &roster_positions(ids.len()), c.initial_cost_cap, &PresetMap::default(), true, false);
        run.status = RunStatus::Active;
        run.generation += 1;
        run.campaign_id = campaign_id.0;
        run.current_node = c.root_node;
        run.current_cost_cap = c.initial_cost_cap;
        run.reservation = ids.clone();
        run.reservation_cost = cost;
        run.active_game_id = 0;
        run.roster = ids.iter().map(|&i| (i, 0)).collect();
        run.required_variant_at_start = c.required_variant;
        self.rl.bump_node(c.root_node, true);
        self.rl.runs_started += 1;
        self.rl.runs.insert(p.clone(), run);
        self.charge_storage_since(&p, initial);
        events::emit("run_started", json!({ "player": p, "campaign_id": campaign_id, "root_node": U64(c.root_node) }));
        U64(c.root_node)
    }

    /// RoguelikeMatch.enterCombatNode: advance (or stay) and fight with the
    /// whole roster, at its carried HP.
    pub fn enter_combat_node(&mut self, node_id: U64, positions: Vec<Position>) -> U64 {
        let p = env::predecessor_account_id();
        let mut run = self.run_of(&p);
        require!(run.status == RunStatus::Active, "NoActiveRun");
        let initial = env::storage_usage();
        let node = self.commit_to_node(&p, &mut run, node_id.0);
        require!(node.kind == RlNodeKind::Combat, "WrongNodeKind");
        require!(!self.rl.is_defeated(&p, run.generation, node_id.0), "NodeAlreadyDefeated");
        let campaign = self.rl.campaigns.get(&run.campaign_id).cloned().unwrap_or_default();
        let map = self.sp.maps.get(&node.map_id).cloned().unwrap_or_else(|| env::panic_str("MapNotFound"));

        // Fleets.transferFleet(reservation -> combat fleet).
        let ids: Vec<u64> = run.roster.iter().map(|e| e.0).collect();
        require!(positions.len() == ids.len(), "ArrayLengthMismatch");
        require!(!ids.is_empty() && ids == run.reservation, "FleetShipsMismatch");
        crate::single_player::validate_positions(&map, &positions, true);
        require!(run.reservation_cost <= run.current_cost_cap, "InvalidFleetCost");
        let combat_cost = run.reservation_cost;
        run.reservation.clear();
        run.reservation_cost = 0;

        let (joiner_fleet, ai_ships) = self.build_ai_fleet(node.map_id);
        self.sp.game_count += 1;
        let game_id = self.sp.game_count;
        let mut g = GameState::start(
            game_id,
            &self.fleet_entries(&ids, &positions),
            &joiner_fleet,
            node.creator_goes_first,
            node.turn_time,
            node.max_score,
            self.config.heal_cap_percent,
            GameMap::from_preset(&map),
            Self::now_s(),
        )
        .or_panic();
        for &(id, hp) in &run.roster {
            if hp != 0 && hp < g.ship(id).max_hull_points {
                g.set_initial_hull_points(id, hp).or_panic();
            }
        }
        run.active_game_id = game_id;
        let m = RlMatch {
            player: p.clone(),
            node_id: node_id.0,
            heal_percent_at_start: campaign.auto_heal_percent,
            is_final_at_start: node.children.is_empty(),
            win_effects_at_start: node.win_effects.clone(),
            ai_ships,
            combat_fleet: ids,
            combat_fleet_cost: combat_cost,
        };
        self.rl.runs.insert(p.clone(), run);
        self.save_rl(game_id, g, m);
        self.charge_storage_since(&p, initial);
        events::emit("combat_node_entered", json!({ "game_id": U64(game_id), "node_id": node_id, "player": p }));
        U64(game_id)
    }

    /// RoguelikeMatch.enterResupplyNode (applies the node's cost-cap change).
    pub fn enter_resupply_node(&mut self, node_id: U64) {
        let p = env::predecessor_account_id();
        let mut run = self.run_of(&p);
        require!(run.status == RunStatus::Active, "NoActiveRun");
        let initial = env::storage_usage();
        let node = self.commit_to_node(&p, &mut run, node_id.0);
        require!(node.kind == RlNodeKind::Resupply, "WrongNodeKind");
        if node.cost_cap_override != 0 {
            run.current_cost_cap = node.cost_cap_override;
        }
        self.rl.runs.insert(p.clone(), run);
        self.charge_storage_since(&p, initial);
        events::emit("resupply_node_entered", json!({ "node_id": node_id, "player": p }));
    }

    /// RoguelikeMatch.retreatRun: with a game id, concede that game (which
    /// ends the run); with 0, abandon the run between fights.
    pub fn retreat_run(&mut self, game_id: U64) {
        let p = env::predecessor_account_id();
        let mut run = self.run_of(&p);
        require!(run.status == RunStatus::Active, "NoActiveRun");
        let initial = env::storage_usage();
        if game_id.0 != 0 {
            let (mut g, mut m) = self.load_rl(game_id.0);
            require!(m.player == p, "NotYourGame");
            let evs = g.force_end(Some(Side::Joiner)).or_panic();
            self.apply_rl_events(game_id.0, &mut m, &g, &evs);
            self.save_rl(game_id.0, g, m);
        } else {
            require!(run.active_game_id == 0, "ActiveGameInProgress");
            let res = core::mem::take(&mut run.reservation);
            self.unlock_all(&res);
            run.reservation_cost = 0;
            self.rl.end_run(&mut run, false);
            self.rl.runs.insert(p.clone(), run);
            events::emit("run_ended", json!({ "player": p, "won": false }));
        }
        self.charge_storage_since(&p, initial);
    }

    // ============================================================= resupply

    fn require_at_resupply(&self, run: &Run) {
        require!(run.status == RunStatus::Active, "NoActiveRun");
        require!(run.active_game_id == 0, "ActiveGameInProgress");
        require!(self.rl.node(run.current_node).kind == RlNodeKind::Resupply, "NotResupplyNode");
    }

    /// RoguelikeResupply.resupplyRepair: restore listed roster ships to full
    /// for `repair_cost_per_hp` UTC per missing HP.
    pub fn resupply_repair(&mut self, ship_ids: Vec<U64>) {
        let p = env::predecessor_account_id();
        let mut run = self.run_of(&p);
        self.require_at_resupply(&run);
        let initial = env::storage_usage();
        let mut missing: u128 = 0;
        for U64(id) in ship_ids {
            require!(run.roster.iter().any(|e| e.0 == id), "ShipNotInRoster");
            let a = self.current_attrs(id).or_panic();
            let hp = self.rl.ship_hp(&p, &run, id);
            let effective = if hp == 0 { a.max_hull_points } else { hp };
            missing += a.max_hull_points.saturating_sub(effective) as u128;
            self.rl.set_ship_hp(&p, &mut run, id, a.max_hull_points);
        }
        let cost = missing * self.rl.repair_cost_per_hp;
        if cost > 0 {
            let mut a = self.account(&p);
            require!(a.utc >= cost, "InsufficientFunds");
            a.utc -= cost;
            self.put_account(&p, a);
            self.config.treasury_utc += cost;
        }
        self.rl.runs.insert(p.clone(), run);
        self.charge_storage_since(&p, initial);
        events::emit("resupply_repaired", json!({ "player": p, "cost": U128(cost) }));
    }

    /// RoguelikeResupply.resupplyModifyRoster: drop and add ships (adds must
    /// be owned, unlocked, of the run's variant and current-priced), then
    /// re-reserve under the cost cap.
    pub fn resupply_modify_roster(&mut self, add: Vec<U64>, remove: Vec<U64>) {
        let p = env::predecessor_account_id();
        let mut run = self.run_of(&p);
        self.require_at_resupply(&run);
        let initial = env::storage_usage();
        let remove: Vec<u64> = remove.into_iter().map(|s| s.0).collect();
        let add: Vec<u64> = add.into_iter().map(|s| s.0).collect();
        let mut new_roster: Vec<u64> = run.roster.iter().map(|e| e.0).filter(|id| !remove.contains(id)).collect();
        for &id in &add {
            let r = self.ship_record(id);
            require!(r.owner == p, "ShipNotOwned");
            require!(!r.ship.ship_data.in_fleet, "ShipAlreadyInFleet");
            if run.required_variant_at_start != 0 {
                require!(r.ship.traits.variant == run.required_variant_at_start, "WrongCampaignVariant");
            }
            let current = self.config.costs.get(&r.ship.traits.variant).map_or(0, |c| c.version);
            require!(r.ship.ship_data.costs_version == current, "ShipCostVersionMismatch");
        }
        new_roster.extend(&add);
        let old = core::mem::take(&mut run.reservation);
        self.unlock_all(&old);
        let cost = self.validate_and_lock_fleet(&p, &new_roster, &roster_positions(new_roster.len()), run.current_cost_cap, &PresetMap::default(), true, true);
        self.rl.set_roster(&p, &mut run, &new_roster, None);
        run.reservation = new_roster;
        run.reservation_cost = cost;
        self.rl.runs.insert(p.clone(), run);
        self.charge_storage_since(&p, initial);
        events::emit("roster_modified", json!({ "player": p, "added": add.len(), "removed": remove.len() }));
    }

    // ================================================================ views

    pub fn get_run(&self, account_id: AccountId) -> Run {
        self.run_of(&account_id)
    }

    pub fn get_rl_campaign(&self, campaign_id: U64) -> Option<RlCampaign> {
        self.rl.campaigns.get(&campaign_id.0).cloned()
    }

    pub fn get_rl_node(&self, node_id: U64) -> Option<RlNode> {
        self.rl.nodes.get(&node_id.0).cloned()
    }

    pub fn get_rl_match(&self, game_id: U64) -> Option<RlMatch> {
        self.rl.matches.get(&game_id.0).cloned()
    }

    pub fn is_rl_node_locked(&self, account_id: AccountId, node_id: U64) -> bool {
        let r = self.run_of(&account_id);
        self.rl.is_locked(&account_id, r.generation, node_id.0)
    }

    pub fn is_rl_node_defeated(&self, account_id: AccountId, node_id: U64) -> bool {
        let r = self.run_of(&account_id);
        self.rl.is_defeated(&account_id, r.generation, node_id.0)
    }

    pub fn get_run_ship_hp(&self, account_id: AccountId, ship_id: U64) -> u8 {
        let r = self.run_of(&account_id);
        self.rl.ship_hp(&account_id, &r, ship_id.0)
    }

    pub fn get_active_runs_at_node(&self, node_id: U64) -> U64 {
        U64(self.rl.active_runs_at_node.get(&node_id.0).copied().unwrap_or(0))
    }
}

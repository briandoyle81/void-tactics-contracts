//! Single-player campaign: preset maps (Maps), AI ship configs and placements
//! (AIEncounters), campaigns and nodes (NodeMap), and node matches
//! (SinglePlayerMatch + Fleets + ShipsRouter's kill bookkeeping), all as
//! internal calls into the vt-core engine and AI.
//!
//! The AI always plays the joiner side; the human is the creator.

use near_sdk::json_types::U64;
use near_sdk::serde_json::json;
use near_sdk::store::LookupMap;
use near_sdk::{env, near, require, AccountId};
use vt_core::ai::{take_ai_turns as run_ai_turns, AiLog, AiShipInfo};
use vt_core::attributes::calculate;
use vt_core::engine::{EngineEvent, FleetEntry, GameState, MoveInput, Side};
use vt_core::grid::{bit_index, in_bounds, GRID_WIDTH};
use vt_core::maps::{GameMap, PresetMap};
use vt_core::types::*;

use crate::events;
use crate::ships::AI_SHIP_ID_OFFSET;
use crate::{roles, Contract, ContractExt, OrPanic, StorageKey};

/// AIEncounters.maxPlacementsPerMap default (the deploy raises it to 14).
pub const DEFAULT_MAX_PLACEMENTS_PER_MAP: u32 = 8;
pub const MAX_AI_KILLS: u32 = 1_000_000;
/// Per call; keeps the receipt well inside NEAR's 100-log / 16 KB limits.
pub const MAX_AI_MOVES_PER_CALL: u32 = 8;

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct AiShipConfig {
    pub name: String,
    pub equipment: Equipment,
    pub traits: Traits,
    pub archetype: Archetype,
    pub shiny: bool,
    pub ships_destroyed: u32,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, Default)]
pub struct Campaign {
    /// 0 = any variant.
    pub required_variant: u16,
    pub node_ids: Vec<u64>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct CampaignNode {
    pub campaign_id: u64,
    pub map_id: u64,
    pub prerequisites: Vec<u64>,
    /// Human fleet cost cap.
    pub cost_limit: u64,
    pub turn_time: u64,
    pub max_score: u64,
    pub creator_goes_first: bool,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct SpMatch {
    pub human: AccountId,
    pub node_id: u64,
    /// Human ships still in the fleet (Fleets record).
    pub human_fleet: Vec<u64>,
    pub ai_ships: Vec<(u64, Ship, AiShipInfo)>,
    pub ended: bool,
}

#[near(serializers = [borsh])]
pub struct SpState {
    pub maps: LookupMap<u64, PresetMap>,
    pub map_count: u64,
    pub ai_configs: LookupMap<u64, AiShipConfig>,
    pub ai_config_count: u64,
    /// mapId -> (cell index, config id), any order (sorted on read).
    pub placements: LookupMap<u64, Vec<(u16, u64)>>,
    pub campaigns: LookupMap<u64, Campaign>,
    pub campaign_count: u64,
    pub nodes: LookupMap<u64, CampaignNode>,
    pub node_count: u64,
    pub completed: LookupMap<(AccountId, u64), bool>,
    pub games: LookupMap<u64, GameState>,
    pub matches: LookupMap<u64, SpMatch>,
    pub game_count: u64,
    pub max_placements_per_map: u32,
}

impl SpState {
    pub fn new() -> Self {
        Self {
            maps: LookupMap::new(StorageKey::Maps),
            map_count: 0,
            ai_configs: LookupMap::new(StorageKey::AiConfigs),
            ai_config_count: 0,
            placements: LookupMap::new(StorageKey::MapPlacements),
            campaigns: LookupMap::new(StorageKey::Campaigns),
            campaign_count: 0,
            nodes: LookupMap::new(StorageKey::Nodes),
            node_count: 0,
            completed: LookupMap::new(StorageKey::CompletedNodes),
            games: LookupMap::new(StorageKey::Games),
            matches: LookupMap::new(StorageKey::SpMatches),
            game_count: 0,
            max_placements_per_map: DEFAULT_MAX_PLACEMENTS_PER_MAP,
        }
    }

    pub fn flush(&mut self) {
        self.maps.flush();
        self.ai_configs.flush();
        self.placements.flush();
        self.campaigns.flush();
        self.nodes.flush();
        self.completed.flush();
        self.games.flush();
        self.matches.flush();
    }

    pub(crate) fn map(&self, id: u64) -> &PresetMap {
        self.maps.get(&id).unwrap_or_else(|| env::panic_str("MapNotFound"))
    }

    fn node(&self, id: u64) -> &CampaignNode {
        self.nodes.get(&id).unwrap_or_else(|| env::panic_str("NodeNotFound"))
    }

    /// NodeMap.isNodeUnlocked: roots are open; otherwise ANY prerequisite.
    pub fn is_unlocked(&self, player: &AccountId, node_id: u64) -> bool {
        let n = self.node(node_id);
        n.prerequisites.is_empty() || n.prerequisites.iter().any(|p| self.completed.get(&(player.clone(), *p)).copied().unwrap_or(false))
    }

    /// AIEncounters.getMapPlacements: ascending by cell index.
    fn sorted_placements(&self, map_id: u64) -> Vec<(u16, u64)> {
        let mut v = self.placements.get(&map_id).cloned().unwrap_or_default();
        v.sort_by_key(|p| p.0);
        v
    }
}

impl Default for SpState {
    fn default() -> Self {
        Self::new()
    }
}

/// Fleets._validateStartingPositions.
pub(crate) fn validate_positions(map: &PresetMap, positions: &[Position], is_creator: bool) {
    let mut seen = vt_core::grid::Bitmap::EMPTY;
    for p in positions {
        require!(in_bounds(p.row, p.col) && map.is_valid_deployment_tile(p.row, p.col, is_creator), "InvalidPosition");
        let idx = bit_index(p.row, p.col);
        require!(!seen.get(idx), "DuplicatePosition");
        seen.set(idx);
    }
}

impl Contract {
    /// Fleets.createFleet for a human fleet: shape, positions, ownership,
    /// lock state, construction, cost version, single variant and cost cap;
    /// then locks the ships. Returns the total cost.
    pub(crate) fn validate_and_lock_fleet(
        &mut self,
        owner: &AccountId,
        ship_ids: &[u64],
        positions: &[Position],
        cost_limit: u64,
        map: &PresetMap,
        is_creator: bool,
        frozen_prices: bool,
    ) -> u64 {
        require!(ship_ids.len() == positions.len(), "ArrayLengthMismatch");
        for i in 0..ship_ids.len() {
            for j in i + 1..ship_ids.len() {
                require!(ship_ids[i] != ship_ids[j], "DuplicateShipId");
            }
        }
        validate_positions(map, positions, is_creator);
        let mut total_cost = 0u64;
        let mut fleet_variant = 0u16;
        for (i, &id) in ship_ids.iter().enumerate() {
            let r = self.ship_record(id);
            let s = &r.ship;
            require!(&r.owner == owner, "ShipNotOwned");
            require!(!s.ship_data.in_fleet, "ShipAlreadyInFleet");
            require!(s.ship_data.constructed, "ShipNotConstructed");
            if !frozen_prices {
                let current_costs = self.config.costs.get(&s.traits.variant).map_or(0, |c| c.version);
                require!(s.ship_data.costs_version == current_costs, "ShipCostVersionMismatch");
            }
            if i == 0 {
                fleet_variant = s.traits.variant;
            } else {
                require!(s.traits.variant == fleet_variant, "MixedVariantFleet");
            }
            total_cost += s.ship_data.cost as u64;
        }
        require!(total_cost <= cost_limit, "InvalidFleetCost");
        for &id in ship_ids {
            self.set_in_fleet(id, true);
        }
        total_cost
    }

    /// ShipAttributes.calculateBoardStatsByIds at game start.
    pub(crate) fn fleet_entries(&self, ship_ids: &[u64], positions: &[Position]) -> Vec<FleetEntry> {
        ship_ids
            .iter()
            .zip(positions)
            .map(|(&id, p)| {
                let s = self.ship_record(id).ship;
                let (version, table) = self.config.current_table(s.traits.variant).or_panic();
                let attributes = calculate(table, version, &s.stats_input()).or_panic();
                FleetEntry { ship_id: id, row: p.row, col: p.col, attributes, variant: s.traits.variant, special: s.equipment.special }
            })
            .collect()
    }

    /// SinglePlayerMatch/RoguelikeMatch._mintAIFleet: the map's AI placements
    /// (ascending cell order) as fleet entries plus per-ship AI info. AI ship
    /// ids are 2^40 + 1.. within the game.
    pub(crate) fn build_ai_fleet(&self, map_id: u64) -> (Vec<FleetEntry>, Vec<(u64, Ship, AiShipInfo)>) {
        let placements = self.sp.sorted_placements(map_id);
        require!(!placements.is_empty(), "NoAIPlacementsConfigured");
        let mut ai_ships = Vec::new();
        let mut joiner_fleet = Vec::new();
        for (k, (cell, config_id)) in placements.iter().enumerate() {
            let c = self.sp.ai_configs.get(config_id).cloned().unwrap_or_else(|| env::panic_str("ConfigNotFound"));
            let id = AI_SHIP_ID_OFFSET + k as u64 + 1;
            let ship = Ship {
                name: c.name.clone(),
                id,
                equipment: c.equipment.clone(),
                traits: c.traits.clone(),
                // AIShips.allocateShip: constructed (AI ships never go through
                // randomness), template shiny and kills, unpriced.
                ship_data: ShipData { shiny: c.shiny, ships_destroyed: c.ships_destroyed, constructed: true, ..Default::default() },
            };
            let (version, table) = self.config.current_table(c.traits.variant).or_panic();
            let attributes = calculate(table, version, &ship.stats_input()).or_panic();
            let (row, col) = ((*cell as i16) / GRID_WIDTH, (*cell as i16) % GRID_WIDTH);
            joiner_fleet.push(FleetEntry { ship_id: id, row, col, attributes, variant: c.traits.variant, special: c.equipment.special });
            let info = AiShipInfo { archetype: c.archetype, variant: c.traits.variant, special: c.equipment.special };
            ai_ships.push((id, ship, info));
        }
        (joiner_fleet, ai_ships)
    }

    fn load_game(&self, game_id: u64) -> (GameState, SpMatch) {
        let g = self.sp.games.get(&game_id).cloned().unwrap_or_else(|| env::panic_str("GameNotFound"));
        let m = self.sp.matches.get(&game_id).cloned().unwrap_or_else(|| env::panic_str("GameNotFound"));
        (g, m)
    }

    /// Applies the engine's cross-contract side effects in Solidity call order.
    /// Never panics on the reward path (HA6-22: a lethal shot must not revert).
    fn apply_engine_events(&mut self, game_id: u64, m: &mut SpMatch, evs: &[EngineEvent], now: u64) {
        for e in evs {
            match *e {
                EngineEvent::ShipLeftFleet { ship_id, side } => {
                    if side == Side::Creator {
                        self.set_in_fleet(ship_id, false);
                        m.human_fleet.retain(|&s| s != ship_id);
                    }
                }
                EngineEvent::ShipDestroyed { ship_id, last_damager } => {
                    if ship_id < AI_SHIP_ID_OFFSET {
                        self.mark_destroyed(ship_id, now);
                        continue; // only the AI can destroy a human ship here: no reward
                    }
                    if last_damager == 0 || last_damager >= AI_SHIP_ID_OFFSET {
                        continue;
                    }
                    self.pay_ai_kill_reward(game_id, m, ship_id, last_damager);
                }
                EngineEvent::GameEnded { winner } => {
                    m.ended = true;
                    if winner == Some(Side::Creator) {
                        self.sp.completed.insert((m.human.clone(), m.node_id), true);
                        events::emit("node_completed", json!({ "player": m.human, "node_id": U64(m.node_id) }));
                    }
                    for id in core::mem::take(&mut m.human_fleet) {
                        self.set_in_fleet(id, false);
                    }
                    events::emit("game_ended", json!({ "game_id": U64(game_id), "winner": winner }));
                }
            }
        }
    }

    /// DestroyRewardLib for a human destroying an AI ship: the destroyed
    /// ship's faction token (DEC for variant 2; none registered for 1).
    fn pay_ai_kill_reward(&mut self, game_id: u64, m: &SpMatch, victim: u64, destroyer: u64) {
        let variant = m.ai_ships.iter().find(|a| a.0 == victim).map_or(0, |a| a.1.traits.variant);
        let Some(owner) = self.ships.get(&destroyer).map(|r| r.owner.clone()) else { return };
        let token = self.config.reward_token.get(&variant).copied();
        let amount = self.config.faction_kill_reward;
        let paid = match token {
            Some(t) => self.try_mint(&owner, t, amount),
            None => false,
        };
        if !paid {
            events::emit("reward_skipped", json!({ "game_id": U64(game_id), "variant": variant, "destroyer_owner": owner }));
        }
    }

    /// `edit`: what changed, for the `game_map_edited` event (replay frames
    /// carry ships, not terrain, so indexers need this to keep the map).
    fn edit_live_map(&mut self, game_id: u64, row: i16, col: i16, edit: near_sdk::serde_json::Value, f: impl FnOnce(&mut vt_core::maps::GameMap)) {
        self.assert_role(roles::MAP_EDITOR);
        require!(in_bounds(row, col), "InvalidPosition");
        let mut g = self.sp.games.get(&game_id).cloned().unwrap_or_else(|| env::panic_str("GameNotFound"));
        require!(!g.ended, "GameAlreadyEnded");
        f(&mut g.map);
        events::emit("game_map_edited", json!({ "game_id": U64(game_id), "row": row, "col": col, "edit": edit }));
        self.put_game(game_id, g);
    }

    fn save_game(&mut self, game_id: u64, g: GameState, m: SpMatch) {
        self.put_game(game_id, g);
        self.sp.matches.insert(game_id, m);
    }
}

#[near]
impl Contract {
    // ============================================================ content admin

    /// Maps.createFullPresetMap.
    pub fn create_preset_map(&mut self, blocked: Vec<Position>, impassable: Vec<Position>, scoring: Vec<ScoringPosition>, mode: MapMode) -> U64 {
        self.assert_role(roles::MAP_EDITOR);
        let m = PresetMap::new(&blocked, &impassable, &scoring, mode).or_panic();
        self.sp.map_count += 1;
        let id = self.sp.map_count;
        self.sp.maps.insert(id, m);
        U64(id)
    }

    /// Maps.setCreatorZone / setJoinerZone (empty = default column band).
    pub fn set_deployment_zones(&mut self, map_id: U64, creator_zone: Vec<Position>, joiner_zone: Vec<Position>) {
        self.assert_role(roles::MAP_EDITOR);
        let mut m = self.sp.map(map_id.0).clone();
        m.set_creator_zone(&creator_zone).or_panic();
        m.set_joiner_zone(&joiner_zone).or_panic();
        self.sp.maps.insert(map_id.0, m);
    }

    /// AIEncounters.createAIShipConfig.
    pub fn create_ai_ship_config(&mut self, config: AiShipConfig) -> U64 {
        self.assert_role(roles::MAP_EDITOR);
        let t = &config.traits;
        require!(t.accuracy <= 2 && t.hull <= 2 && t.speed <= 2, "InvalidTier");
        require!(t.variant != 0, "InvalidVariant");
        require!(config.ships_destroyed <= MAX_AI_KILLS, "InvalidKillCount");
        self.sp.ai_config_count += 1;
        let id = self.sp.ai_config_count;
        self.sp.ai_configs.insert(id, config);
        U64(id)
    }

    /// AIEncounters.setMapPlacements (full replace).
    pub fn set_map_placements(&mut self, map_id: U64, positions: Vec<Position>, config_ids: Vec<U64>) {
        self.assert_role(roles::MAP_EDITOR);
        require!(positions.len() == config_ids.len(), "ArrayLengthMismatch");
        let map = self.sp.map(map_id.0).clone();
        let mut out: Vec<(u16, u64)> = Vec::new();
        for (p, c) in positions.iter().zip(config_ids) {
            require!(in_bounds(p.row, p.col), "InvalidPosition");
            let cell = (p.row * GRID_WIDTH + p.col) as u16;
            out.retain(|e| e.0 != cell);
            if c.0 == 0 {
                continue;
            }
            require!(map.is_valid_deployment_tile(p.row, p.col, false), "InvalidPosition");
            require!(c.0 <= self.sp.ai_config_count, "ConfigNotFound");
            out.push((cell, c.0));
        }
        require!(out.len() <= self.sp.max_placements_per_map as usize, "TooManyPlacements");
        self.sp.placements.insert(map_id.0, out);
    }

    /// AIEncounters.setMapPlacement: one cell of a map's AI fleet (config 0
    /// clears it). Same checks as the batch setter.
    pub fn set_map_placement(&mut self, map_id: U64, position: Position, config_id: U64) {
        self.assert_role(roles::MAP_EDITOR);
        require!(in_bounds(position.row, position.col), "InvalidPosition");
        let map = self.sp.map(map_id.0).clone();
        let cell = (position.row * GRID_WIDTH + position.col) as u16;
        let mut v = self.sp.placements.get(&map_id.0).cloned().unwrap_or_default();
        v.retain(|e| e.0 != cell);
        if config_id.0 != 0 {
            require!(map.is_valid_deployment_tile(position.row, position.col, false), "InvalidPosition");
            require!(config_id.0 <= self.sp.ai_config_count, "ConfigNotFound");
            v.push((cell, config_id.0));
        }
        require!(v.len() <= self.sp.max_placements_per_map as usize, "TooManyPlacements");
        self.sp.placements.insert(map_id.0, v);
    }

    /// Maps.setBlockedTile / setImpassableTile / setScoringTile: a map
    /// editor's hotfix to a LIVE game's own map copy (not the preset).
    /// Rejected once the game has ended. The few bytes a scoring tile adds
    /// are contract-paid, like other editor content.
    pub fn set_game_blocked_tile(&mut self, game_id: U64, row: i16, col: i16, blocked: bool) {
        self.edit_live_map(game_id.0, row, col, json!({ "blocked": blocked }), |m| if blocked { m.blocked.set(bit_index(row, col)) } else { m.blocked.clear(bit_index(row, col)) });
    }

    pub fn set_game_impassable_tile(&mut self, game_id: U64, row: i16, col: i16, impassable: bool) {
        self.edit_live_map(game_id.0, row, col, json!({ "impassable": impassable }), |m| if impassable { m.impassable.set(bit_index(row, col)) } else { m.impassable.clear(bit_index(row, col)) });
    }

    /// Points 0 makes the tile non-scoring; the tile's only-once flag is kept.
    pub fn set_game_scoring_tile(&mut self, game_id: U64, row: i16, col: i16, points: u8) {
        self.edit_live_map(game_id.0, row, col, json!({ "points": points }), |m| m.set_scoring(row, col, points, false, true));
    }

    /// AIEncounters.setMaxPlacementsPerMap.
    pub fn set_max_placements_per_map(&mut self, max: u32) {
        self.assert_owner();
        self.sp.max_placements_per_map = max;
    }

    pub fn create_campaign(&mut self, required_variant: u16) -> U64 {
        self.assert_role(roles::NODE_EDITOR);
        self.sp.campaign_count += 1;
        let id = self.sp.campaign_count;
        self.sp.campaigns.insert(id, Campaign { required_variant, node_ids: vec![] });
        U64(id)
    }

    /// NodeMap.createNode.
    pub fn create_node(&mut self, node: CampaignNode) -> U64 {
        self.assert_role(roles::NODE_EDITOR);
        let mut campaign = self.sp.campaigns.get(&node.campaign_id).cloned().unwrap_or_else(|| env::panic_str("CampaignNotFound"));
        let mode = self.sp.map(node.map_id).mode;
        require!(mode == MapMode::PvE || mode == MapMode::Both, "InvalidMapMode");
        let id = self.sp.node_count + 1;
        for &p in &node.prerequisites {
            require!(p != id, "SelfPrerequisite");
            require!(self.sp.nodes.contains_key(&p), "PrerequisiteNotFound");
        }
        self.sp.node_count = id;
        campaign.node_ids.push(id);
        self.sp.campaigns.insert(node.campaign_id, campaign);
        self.sp.nodes.insert(id, node);
        U64(id)
    }

    // ---- edits (Maps / AIEncounters / NodeMap update paths) ----
    // Live games keep their own copy of the map and AI fleet, so edits only
    // affect matches started afterwards (as on Base, where the map is copied
    // into the game at start).

    /// Maps.updatePresetMap: full replace of the blocked (LOS) tiles.
    pub fn update_preset_map(&mut self, map_id: U64, blocked: Vec<Position>) {
        self.assert_role(roles::MAP_EDITOR);
        let mut m = self.sp.map(map_id.0).clone();
        m.blocked = PresetMap::new(&blocked, &[], &[], m.mode).or_panic().blocked;
        self.sp.maps.insert(map_id.0, m);
    }

    /// Maps.updatePresetMapImpassable: full replace of the impassable tiles.
    pub fn update_preset_map_impassable(&mut self, map_id: U64, impassable: Vec<Position>) {
        self.assert_role(roles::MAP_EDITOR);
        let mut m = self.sp.map(map_id.0).clone();
        m.impassable = PresetMap::new(&[], &impassable, &[], m.mode).or_panic().impassable;
        self.sp.maps.insert(map_id.0, m);
    }

    /// Maps.updatePresetScoringMap: full replace of the scoring tiles.
    pub fn update_preset_scoring_map(&mut self, map_id: U64, scoring: Vec<ScoringPosition>) {
        self.assert_role(roles::MAP_EDITOR);
        let mut m = self.sp.map(map_id.0).clone();
        m.scoring = PresetMap::new(&[], &[], &scoring, m.mode).or_panic().scoring;
        self.sp.maps.insert(map_id.0, m);
    }

    /// Maps.setMapMode.
    pub fn set_map_mode(&mut self, map_id: U64, mode: MapMode) {
        self.assert_role(roles::MAP_EDITOR);
        let mut m = self.sp.map(map_id.0).clone();
        m.mode = mode;
        self.sp.maps.insert(map_id.0, m);
    }

    /// The three replaces plus the mode in one call (what the map editor
    /// saves). Deployment zones are kept.
    pub fn update_full_preset_map(&mut self, map_id: U64, blocked: Vec<Position>, impassable: Vec<Position>, scoring: Vec<ScoringPosition>, mode: MapMode) {
        self.assert_role(roles::MAP_EDITOR);
        let old = self.sp.map(map_id.0).clone();
        let mut m = PresetMap::new(&blocked, &impassable, &scoring, mode).or_panic();
        m.creator_zone = old.creator_zone;
        m.joiner_zone = old.joiner_zone;
        self.sp.maps.insert(map_id.0, m);
    }

    /// AIEncounters.updateAIShipConfig.
    pub fn update_ai_ship_config(&mut self, config_id: U64, config: AiShipConfig) {
        self.assert_role(roles::MAP_EDITOR);
        require!(config_id.0 != 0 && config_id.0 <= self.sp.ai_config_count, "ConfigNotFound");
        let t = &config.traits;
        require!(t.accuracy <= 2 && t.hull <= 2 && t.speed <= 2, "InvalidTier");
        require!(t.variant != 0, "InvalidVariant");
        require!(config.ships_destroyed <= MAX_AI_KILLS, "InvalidKillCount");
        self.sp.ai_configs.insert(config_id.0, config);
    }

    /// NodeMap.updateNode. Moving a node to another campaign moves its id
    /// between the campaigns' node lists (swap-and-pop, as on Base).
    pub fn update_node(&mut self, node_id: U64, node: CampaignNode) {
        self.assert_role(roles::NODE_EDITOR);
        let id = node_id.0;
        let old = self.sp.nodes.get(&id).cloned().unwrap_or_else(|| env::panic_str("NodeNotFound"));
        require!(self.sp.campaigns.contains_key(&node.campaign_id), "CampaignNotFound");
        let mode = self.sp.map(node.map_id).mode;
        require!(mode == MapMode::PvE || mode == MapMode::Both, "InvalidMapMode");
        for &p in &node.prerequisites {
            require!(p != id, "SelfPrerequisite");
            require!(self.sp.nodes.contains_key(&p), "PrerequisiteNotFound");
        }
        if node.campaign_id != old.campaign_id {
            let mut from = self.sp.campaigns.get(&old.campaign_id).cloned().unwrap_or_default();
            if let Some(i) = from.node_ids.iter().position(|&n| n == id) {
                from.node_ids.swap_remove(i);
            }
            self.sp.campaigns.insert(old.campaign_id, from);
            let mut to = self.sp.campaigns.get(&node.campaign_id).cloned().unwrap_or_default();
            to.node_ids.push(id);
            self.sp.campaigns.insert(node.campaign_id, to);
        }
        self.sp.nodes.insert(id, node);
    }

    /// NodeMap.addPrerequisite.
    pub fn add_prerequisite(&mut self, node_id: U64, prerequisite_id: U64) {
        self.assert_role(roles::NODE_EDITOR);
        let mut node = self.sp.nodes.get(&node_id.0).cloned().unwrap_or_else(|| env::panic_str("NodeNotFound"));
        require!(prerequisite_id != node_id, "SelfPrerequisite");
        require!(self.sp.nodes.contains_key(&prerequisite_id.0), "PrerequisiteNotFound");
        node.prerequisites.push(prerequisite_id.0);
        self.sp.nodes.insert(node_id.0, node);
    }

    /// NodeMap.removePrerequisite (swap-and-pop).
    pub fn remove_prerequisite(&mut self, node_id: U64, prerequisite_id: U64) {
        self.assert_role(roles::NODE_EDITOR);
        let mut node = self.sp.nodes.get(&node_id.0).cloned().unwrap_or_else(|| env::panic_str("NodeNotFound"));
        let i = node.prerequisites.iter().position(|&p| p == prerequisite_id.0).unwrap_or_else(|| env::panic_str("PrerequisiteNotInNode"));
        node.prerequisites.swap_remove(i);
        self.sp.nodes.insert(node_id.0, node);
    }

    /// NodeMap.setCampaignRequiredVariant.
    pub fn set_campaign_required_variant(&mut self, campaign_id: U64, variant: u16) {
        self.assert_role(roles::NODE_EDITOR);
        let mut c = self.sp.campaigns.get(&campaign_id.0).cloned().unwrap_or_else(|| env::panic_str("CampaignNotFound"));
        c.required_variant = variant;
        self.sp.campaigns.insert(campaign_id.0, c);
    }

    // ================================================================ play

    /// SinglePlayerMatch.startNodeMatch.
    pub fn start_node_match(&mut self, node_id: U64, ship_ids: Vec<U64>, positions: Vec<Position>) -> U64 {
        let human = env::predecessor_account_id();
        self.assert_registered(&human);
        let initial = env::storage_usage();
        require!(self.sp.is_unlocked(&human, node_id.0), "NodeNotUnlocked");
        let node = self.sp.node(node_id.0).clone();
        let campaign = self.sp.campaigns.get(&node.campaign_id).cloned().unwrap_or_default();
        let ship_ids: Vec<u64> = ship_ids.into_iter().map(|s| s.0).collect();
        require!(!ship_ids.is_empty(), "EmptyFleet");
        if campaign.required_variant != 0 {
            require!(self.ship_record(ship_ids[0]).ship.traits.variant == campaign.required_variant, "WrongCampaignVariant");
        }
        let map = self.sp.map(node.map_id).clone();

        // ---- Fleets.createFleet (human side) ----
        self.validate_and_lock_fleet(&human, &ship_ids, &positions, node.cost_limit, &map, true, false);
        let creator_fleet = self.fleet_entries(&ship_ids, &positions);

        // ---- _mintAIFleet ----
        let (joiner_fleet, ai_ships) = self.build_ai_fleet(node.map_id);

        // ---- Game.startGame ----
        self.sp.game_count += 1;
        let game_id = self.sp.game_count;
        let now = Self::now_s();
        let g = GameState::start(
            game_id,
            &creator_fleet,
            &joiner_fleet,
            node.creator_goes_first,
            node.turn_time,
            node.max_score,
            self.config.heal_cap_percent,
            GameMap::from_preset(&map),
            now,
        )
        .or_panic();
        let m = SpMatch { human: human.clone(), node_id: node_id.0, human_fleet: ship_ids, ai_ships, ended: false };
        events::emit_board(game_id, "start", &g);
        self.save_game(game_id, g, m);
        self.index_player_game(&human, game_id);
        self.charge_storage_since(&human, initial);
        events::emit("node_match_started", json!({ "game_id": U64(game_id), "node_id": node_id, "player": human }));
        U64(game_id)
    }

    /// Game.moveShip: the human (creator) side of a single-player match, or
    /// either player of a PvP game.
    pub fn move_ship(&mut self, game_id: U64, ship_id: U64, new_row: i16, new_col: i16, action: ActionType, target_ship_id: U64) {
        let input = MoveInput { ship_id: ship_id.0, new_row, new_col, action, target_ship_id: target_ship_id.0 };
        if self.pvp.games.contains_key(&game_id.0) {
            return self.pvp_move(game_id.0, input);
        }
        if self.rl.matches.contains_key(&game_id.0) {
            return self.rl_move(game_id.0, input);
        }
        let caller = env::predecessor_account_id();
        let (mut g, mut m) = self.load_game(game_id.0);
        require!(caller == m.human, "InvalidMove");
        let initial = env::storage_usage();
        let now = Self::now_s();
        let input = MoveInput { ship_id: ship_id.0, new_row, new_col, action, target_ship_id: target_ship_id.0 };
        let evs = g.move_ship(Side::Creator, &input, &self.config, now).or_panic();
        let last = g.last_move.clone();
        self.apply_engine_events(game_id.0, &mut m, &evs, now);
        let board = events::board_frame(&g);
        self.save_game(game_id.0, g, m);
        self.charge_storage_since(&caller, initial);
        events::emit("move", json!({ "game_id": game_id, "last_move": last, "board": board }));
    }

    /// SinglePlayerMatch.takeAITurns: permissionless (anyone may advance the
    /// AI). The AI is deterministic, so a caller can't steer it; storage growth
    /// is charged to the match's human (their game, their bytes).
    pub fn take_ai_turns(&mut self, game_id: U64, max_moves: u32) -> u32 {
        if self.rl.matches.contains_key(&game_id.0) {
            return self.rl_ai_turns(game_id.0, max_moves);
        }
        let (mut g, mut m) = self.load_game(game_id.0);
        let initial = env::storage_usage();
        let now = Self::now_s();
        let info = |id: u64| m.ai_ships.iter().find(|a| a.0 == id).map(|a| a.2.clone());
        let res = run_ai_turns(&mut g, &self.config, &info, max_moves.clamp(1, MAX_AI_MOVES_PER_CALL), now)
            .unwrap_or_else(|e| env::panic_str(e));
        self.apply_engine_events(game_id.0, &mut m, &res.events, now);
        let human = m.human.clone();
        let final_board = events::board_frame(&g);
        self.save_game(game_id.0, g, m);
        self.charge_storage_since(&human, initial);
        let logs: Vec<_> = res
            .logs
            .iter()
            .map(|l| match l {
                AiLog::DecisionFailed { ship_id } => json!({ "decision_failed": U64(*ship_id) }),
                AiLog::TurnTaken { ship_id, action, target, board } => json!({ "ship_id": U64(*ship_id), "action": action, "target": U64(*target), "board": board }),
            })
            .collect();
        // `board`: after the whole call (also covers the AI conceding with no
        // move, which logs no turn).
        events::emit("ai_turns", json!({ "game_id": game_id, "turns": logs, "board": final_board }));
        res.moves
    }

    /// SinglePlayerMatch.forfeit.
    pub fn forfeit(&mut self, game_id: U64) {
        let caller = env::predecessor_account_id();
        let (mut g, mut m) = self.load_game(game_id.0);
        require!(caller == m.human, "NotYourGame");
        let initial = env::storage_usage();
        let evs = g.force_end(Some(Side::Joiner)).or_panic();
        self.apply_engine_events(game_id.0, &mut m, &evs, Self::now_s());
        events::emit_board(game_id.0, "forfeit", &g);
        self.save_game(game_id.0, g, m);
        self.charge_storage_since(&caller, initial);
    }

    // =============================================================== views

    pub fn get_game(&self, game_id: U64) -> Option<GameState> {
        self.sp.games.get(&game_id.0).cloned()
    }

    pub fn get_sp_match(&self, game_id: U64) -> Option<SpMatch> {
        self.sp.matches.get(&game_id.0).cloned()
    }

    pub fn get_preset_map(&self, map_id: U64) -> Option<PresetMap> {
        self.sp.maps.get(&map_id.0).cloned()
    }

    pub fn get_map_count(&self) -> U64 {
        U64(self.sp.map_count)
    }

    /// Maps.getAllPresetMaps, paginated: (map id, map) from id `from_index + 1`.
    pub fn get_preset_maps(&self, from_index: Option<u64>, limit: Option<u64>) -> Vec<(U64, PresetMap)> {
        let start = from_index.unwrap_or(0) + 1;
        let end = (start + limit.unwrap_or(20).min(100)).min(self.sp.map_count + 1);
        (start..end).filter_map(|id| self.sp.maps.get(&id).map(|m| (U64(id), m.clone()))).collect()
    }

    /// AIEncounters.getAIShipConfigsPaginated.
    pub fn get_ai_ship_configs(&self, from_index: Option<u64>, limit: Option<u64>) -> Vec<(U64, AiShipConfig)> {
        let start = from_index.unwrap_or(0) + 1;
        let end = (start + limit.unwrap_or(20).min(100)).min(self.sp.ai_config_count + 1);
        (start..end).filter_map(|id| self.sp.ai_configs.get(&id).map(|c| (U64(id), c.clone()))).collect()
    }

    pub fn get_campaign_count(&self) -> U64 {
        U64(self.sp.campaign_count)
    }

    pub fn get_node_count(&self) -> U64 {
        U64(self.sp.node_count)
    }

    pub fn get_max_placements_per_map(&self) -> u32 {
        self.sp.max_placements_per_map
    }

    pub fn get_ai_config_count(&self) -> U64 {
        U64(self.sp.ai_config_count)
    }

    pub fn get_ai_ship_config(&self, config_id: U64) -> Option<AiShipConfig> {
        self.sp.ai_configs.get(&config_id.0).cloned()
    }

    pub fn get_map_placements(&self, map_id: U64) -> Vec<(Position, U64)> {
        self.sp
            .sorted_placements(map_id.0)
            .into_iter()
            .map(|(cell, c)| (Position { row: cell as i16 / GRID_WIDTH, col: cell as i16 % GRID_WIDTH }, U64(c)))
            .collect()
    }

    pub fn get_campaign(&self, campaign_id: U64) -> Option<Campaign> {
        self.sp.campaigns.get(&campaign_id.0).cloned()
    }

    pub fn get_node(&self, node_id: U64) -> Option<CampaignNode> {
        self.sp.nodes.get(&node_id.0).cloned()
    }

    pub fn is_node_unlocked(&self, account_id: AccountId, node_id: U64) -> bool {
        self.sp.is_unlocked(&account_id, node_id.0)
    }

    pub fn is_node_completed(&self, account_id: AccountId, node_id: U64) -> bool {
        self.sp.completed.get(&(account_id, node_id.0)).copied().unwrap_or(false)
    }
}

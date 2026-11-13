//! The turn-based combat engine (Game.sol + SpecialEffectsLib.sol).
//!
//! Pure state machine: `GameState` holds everything Game.sol kept per game
//! (including its own copy of the map's terrain and scoring). Anything Game.sol
//! did in OTHER contracts mid-move (Fleets.removeShipFromFleet,
//! ShipsRouter.setTimestampDestroyed, the orchestrator's onGameEnded,
//! Fleets.clearFleet) is returned as `EngineEvent`s, in the exact order the
//! Solidity code made those calls, for the contract to apply after the move.

use std::collections::BTreeMap;

use borsh::{BorshDeserialize, BorshSerialize};
use serde::{Deserialize, Serialize};

use crate::effects::{Resolver, ResolveCtx, SpecialEffect, NO_RELOCATE};
use crate::error::{Error, Result};
use crate::grid::{in_bounds, Bitmap, GRID_HEIGHT, GRID_WIDTH};
use crate::maps::GameMap;
use crate::types::{ActionType, Attributes, Special, SpecialData};

macro_rules! derive_all {
    ($item:item) => {
        #[derive(Clone, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize, Serialize, Deserialize)]
        #[cfg_attr(not(target_arch = "wasm32"), derive(schemars::JsonSchema, borsh::BorshSchema))]
        $item
    };
}

derive_all! {
    #[derive(Copy, Default)]
    pub enum Side {
        #[default]
        Creator,
        Joiner,
    }
}

impl Side {
    pub fn other(self) -> Side {
        match self {
            Side::Creator => Side::Joiner,
            Side::Joiner => Side::Creator,
        }
    }
    fn idx(self) -> usize {
        self as usize
    }
    pub fn of(is_creator: bool) -> Side {
        if is_creator { Side::Creator } else { Side::Joiner }
    }
}

/// Ship status on the board.
pub const STATUS_ALIVE: u8 = 0;
pub const STATUS_DESTROYED: u8 = 1;
pub const STATUS_FLED: u8 = 2;

derive_all! {
    #[derive(Default)]
    /// Types.sol ShipBoardState.
    pub struct ShipBoard {
        pub row: i16,
        pub col: i16,
        pub is_creator: bool,
        pub status: u8,
        pub placed: bool,
        /// Attributes version (0 = no stats); also the game's pin.
        pub version: u16,
        pub range: u8,
        pub gun_damage: u8,
        pub hull_points: u8,
        pub max_hull_points: u8,
        pub movement: u8,
        pub damage_reduction: u8,
        pub reactor_critical_timer: u8,
        pub moved_in_round: u64,
        pub zeroed_after_moving_round: u64,
        /// 1-based index in its side's active list; 0 = not active.
        pub active_index: u8,
        pub variant: u16,
        pub special: Special,
        pub last_damager: u64,
    }
}

impl ShipBoard {
    pub fn attributes(&self) -> Attributes {
        Attributes {
            version: self.version,
            range: self.range,
            gun_damage: self.gun_damage,
            hull_points: self.hull_points,
            max_hull_points: self.max_hull_points,
            movement: self.movement,
            damage_reduction: self.damage_reduction,
            reactor_critical_timer: self.reactor_critical_timer,
        }
    }
}

derive_all! {
    pub struct LastMove {
        pub ship_id: u64,
        pub old_row: i16,
        pub old_col: i16,
        pub new_row: i16,
        pub new_col: i16,
        pub action_type: ActionType,
        pub target_ship_id: u64,
        pub timestamp: u64,
    }
}

derive_all! {
    /// Types.sol ShipPosition.
    pub struct ShipPosition {
        /// 0 for a ship never placed in this game.
        pub ship_id: u64,
        pub row: i16,
        pub col: i16,
        pub is_creator: bool,
        pub status: u8,
    }
}

derive_all! {
    /// A side effect Game.sol performed in another contract during a move.
    pub enum EngineEvent {
        /// Fleets.removeShipFromFleet (retreat or destruction).
        ShipLeftFleet { ship_id: u64, side: Side },
        /// ShipsRouter.setTimestampDestroyed: marks destroyed, kill credit,
        /// kill reward. `last_damager` 0 = no credit.
        ShipDestroyed { ship_id: u64, last_damager: u64 },
        /// _endGame: orchestrator.onGameEnded, then clear both fleets.
        /// `winner` None = draw.
        GameEnded { winner: Option<Side> },
    }
}

derive_all! {
    /// One ship entering the game, with stats already calculated by the caller
    /// (ShipAttributes.calculateBoardStatsByIds).
    pub struct FleetEntry {
        pub ship_id: u64,
        pub row: i16,
        pub col: i16,
        pub attributes: Attributes,
        pub variant: u16,
        pub special: Special,
    }
}

/// Read-only rules the engine consults mid-move (Game.sol's resolver mappings
/// and ShipAttributes' versioned special tables).
pub trait Rules {
    fn faction_resolver(&self, variant: u16) -> Option<Resolver>;
    fn special_resolver(&self, variant: u16, slot: Special) -> Option<Resolver>;
    /// ShipAttributes.getSpecial{Range,Strength}At: InvalidAttributesVersion
    /// for an unpublished version.
    fn special_data_at(&self, variant: u16, version: u16, slot: Special) -> Result<SpecialData>;
}

derive_all! {
    #[derive(Default)]
    pub struct GameState {
        pub game_id: u64,
        pub creator_goes_first: bool,
        pub started_at: u64,
        pub ended: bool,
        /// None while running or on a draw; `ended` disambiguates.
        pub winner: Option<Side>,
        pub current_turn: Side,
        pub turn_time: u64,
        pub turn_start_time: u64,
        pub current_round: u64,
        pub max_score: u64,
        pub creator_score: u64,
        pub joiner_score: u64,
        pub last_move: Option<LastMove>,
        pub occupied: Bitmap,
        /// Per side: cells holding an on-board ship with HP > 0.
        pub live: [Bitmap; 2],
        pub board: BTreeMap<u64, ShipBoard>,
        pub moved_total: u64,
        pub moved_at_round_start: u64,
        /// OpenZeppelin EnumerableSet semantics (append; swap-remove).
        pub ships_with_zero_hp: Vec<u64>,
        pub creator_active: Vec<u64>,
        pub joiner_active: Vec<u64>,
        pub gone_ship_ids: Vec<u64>,
        pub total_active_at_round_start: u64,
        pub ships_removed_total: u64,
        pub removed_at_round_start: u64,
        pub heal_cap_percent_at_start: u8,
        pub map: GameMap,
    }
}

fn set_add(set: &mut Vec<u64>, v: u64) {
    if !set.contains(&v) {
        set.push(v);
    }
}
fn set_remove(set: &mut Vec<u64>, v: u64) {
    if let Some(i) = set.iter().position(|&x| x == v) {
        set.swap_remove(i);
    }
}

/// Game._manhattanDistance with Solidity's int16 checked subtraction and
/// truncating uint8 casts, then a checked uint8 sum.
pub fn manhattan_checked(a: (i16, i16), b: (i16, i16)) -> Result<u8> {
    let diff = |x: i16, y: i16| -> Result<u8> {
        let d = (x as i32 - y as i32).abs();
        if d > i16::MAX as i32 {
            return Err(Error::ArithmeticOverflow);
        }
        Ok(d as u16 as u8)
    };
    diff(a.0, b.0)?.checked_add(diff(a.1, b.1)?).ok_or(Error::ArithmeticOverflow)
}

pub struct MoveInput {
    pub ship_id: u64,
    pub new_row: i16,
    pub new_col: i16,
    pub action: ActionType,
    pub target_ship_id: u64,
}

impl GameState {
    /// Game.startGame + fleet registration and placement. Creator ships are
    /// registered then placed before the joiner's, as in Solidity.
    #[allow(clippy::too_many_arguments)]
    pub fn start(
        game_id: u64,
        creator_fleet: &[FleetEntry],
        joiner_fleet: &[FleetEntry],
        creator_goes_first: bool,
        turn_time: u64,
        max_score: u64,
        heal_cap_percent: u8,
        map: GameMap,
        now: u64,
    ) -> Result<GameState> {
        let mut g = GameState {
            game_id,
            creator_goes_first,
            started_at: now,
            current_turn: if creator_goes_first { Side::Creator } else { Side::Joiner },
            turn_time,
            turn_start_time: now,
            current_round: 1,
            max_score,
            heal_cap_percent_at_start: heal_cap_percent,
            map,
            ..Default::default()
        };
        // _initializeFleetAttributes: both sides registered first...
        for (fleet, side) in [(creator_fleet, Side::Creator), (joiner_fleet, Side::Joiner)] {
            for e in fleet {
                let list = g.active_mut(side);
                list.push(e.ship_id);
                let idx = list.len();
                if idx > u8::MAX as usize {
                    return Err(Error::InvalidMove);
                }
                let b = g.board.entry(e.ship_id).or_default();
                b.active_index = idx as u8;
                b.is_creator = side == Side::Creator;
                if b.version != 0 {
                    return Err(Error::InvalidMove); // already registered (dup ship)
                }
                b.variant = e.variant;
                b.special = e.special;
                b.version = e.attributes.version;
                b.range = e.attributes.range;
                b.gun_damage = e.attributes.gun_damage;
                b.hull_points = e.attributes.hull_points;
                b.max_hull_points = e.attributes.max_hull_points;
                b.movement = e.attributes.movement;
                b.damage_reduction = e.attributes.damage_reduction;
            }
        }
        // ...then placed (_placeShipsOnGrid).
        for e in creator_fleet.iter().chain(joiner_fleet) {
            if !in_bounds(e.row, e.col) || g.occupied.has_cell(e.row, e.col) {
                return Err(Error::InvalidMove);
            }
            let cell = Bitmap::cell(e.row, e.col);
            g.occupied |= cell;
            let b = g.board.get_mut(&e.ship_id).expect("registered above");
            b.row = e.row;
            b.col = e.col;
            b.placed = true;
            let side = Side::of(b.is_creator);
            g.live[side.idx()] |= cell;
        }
        g.total_active_at_round_start = (g.creator_active.len() + g.joiner_active.len()) as u64;
        Ok(g)
    }

    /// Game.setInitialHullPointsOverride (roguelike carry-over HP).
    pub fn set_initial_hull_points(&mut self, ship_id: u64, hp: u8) -> Result<()> {
        let b = self.board.get_mut(&ship_id).filter(|b| b.version != 0).ok_or(Error::ShipNotFound)?;
        if hp == 0 || hp > b.max_hull_points {
            return Err(Error::InvalidMove);
        }
        b.hull_points = hp;
        Ok(())
    }

    // ---------------------------------------------------------------- views

    pub fn active(&self, side: Side) -> &Vec<u64> {
        match side {
            Side::Creator => &self.creator_active,
            Side::Joiner => &self.joiner_active,
        }
    }
    fn active_mut(&mut self, side: Side) -> &mut Vec<u64> {
        match side {
            Side::Creator => &mut self.creator_active,
            Side::Joiner => &mut self.joiner_active,
        }
    }

    pub fn ship(&self, id: u64) -> ShipBoard {
        self.board.get(&id).cloned().unwrap_or_default()
    }

    /// Game.getShipPosition.
    pub fn ship_position(&self, id: u64) -> ShipPosition {
        let b = self.ship(id);
        ShipPosition { ship_id: if b.placed { id } else { 0 }, row: b.row, col: b.col, is_creator: b.is_creator, status: b.status }
    }

    /// Game.getShipAttributes.
    pub fn ship_attributes(&self, id: u64) -> Result<Attributes> {
        let b = self.ship(id);
        if b.version == 0 {
            return Err(Error::ShipNotFound);
        }
        Ok(b.attributes())
    }

    /// Game.getAllShipPositions: creator actives, joiner actives, then gone.
    pub fn all_ship_positions(&self) -> Vec<ShipPosition> {
        let mut out = Vec::new();
        for (list, is_creator) in [(&self.creator_active, true), (&self.joiner_active, false)] {
            for &id in list {
                let b = self.ship(id);
                out.push(ShipPosition { ship_id: id, row: b.row, col: b.col, is_creator, status: STATUS_ALIVE });
            }
        }
        for &id in &self.gone_ship_ids {
            let b = self.ship(id);
            out.push(ShipPosition { ship_id: id, row: b.row, col: b.col, is_creator: b.is_creator, status: b.status });
        }
        out
    }

    pub fn has_moved(&self, id: u64) -> bool {
        self.ship(id).moved_in_round == self.current_round
    }

    /// Game._getMovedShipIds.
    pub fn moved_ship_ids(&self, side: Side) -> Vec<u64> {
        self.active(side).iter().copied().filter(|&id| self.has_moved(id)).collect()
    }

    pub fn side_has_live_ships(&self, side: Side) -> bool {
        !self.live[side.idx()].is_empty()
    }

    // ---------------------------------------------------------------- moves

    /// Game.moveShip for `side` (the caller already mapped the account to a
    /// side). Returns the cross-contract side effects in call order.
    pub fn move_ship(&mut self, side: Side, m: &MoveInput, rules: &dyn Rules, now: u64) -> Result<Vec<EngineEvent>> {
        let mut ev = Vec::new();
        if self.ended || side != self.current_turn {
            return Err(Error::InvalidMove);
        }
        let b = self.ship(m.ship_id);
        require_on_board(&b)?;
        if b.is_creator != (side == Side::Creator) {
            return Err(Error::ShipNotOwned);
        }
        if m.action != ActionType::Retreat && b.hull_points == 0 {
            return Err(Error::ShipDestroyed);
        }
        if m.action != ActionType::Retreat && self.has_moved(m.ship_id) {
            return Err(Error::ShipAlreadyMoved);
        }
        let (old_row, old_col) = (b.row, b.col);

        if m.action != ActionType::Retreat {
            if !(old_row == m.new_row && old_col == m.new_col) {
                self.validate_and_apply_movement(m.ship_id, old_row, old_col, m.new_row, m.new_col)?;
            }
            let round = self.current_round;
            self.board.get_mut(&m.ship_id).unwrap().moved_in_round = round;
            self.moved_total += 1;
        }

        self.perform_action(m, rules, &mut ev)?;

        if !self.ended {
            if self.round_complete()? {
                self.handle_end_of_round(&mut ev)?;
            } else {
                self.switch_turn_if_other_player_has_ships();
            }
        }

        self.turn_start_time = now;
        let retreat = m.action == ActionType::Retreat;
        self.last_move = Some(LastMove {
            ship_id: m.ship_id,
            old_row,
            old_col,
            new_row: if retreat { -1 } else { m.new_row },
            new_col: if retreat { -1 } else { m.new_col },
            action_type: m.action,
            target_ship_id: m.target_ship_id,
            timestamp: now,
        });
        Ok(ev)
    }

    fn validate_and_apply_movement(&mut self, id: u64, r0: i16, c0: i16, r1: i16, c1: i16) -> Result<()> {
        let b = self.ship(id);
        if manhattan_checked((r0, c0), (r1, c1))? > b.movement {
            return Err(Error::InvalidMove);
        }
        if !in_bounds(r1, c1) || self.occupied.has_cell(r1, c1) {
            return Err(Error::InvalidMove);
        }
        let own = Side::of(b.is_creator);
        if !self.map.has_movement_path_avoiding(r0, c0, r1, c1, self.live[own.other().idx()])? {
            return Err(Error::InvalidMove);
        }
        let bits = Bitmap::cell(r0, c0) | Bitmap::cell(r1, c1);
        self.occupied ^= bits;
        self.live[own.idx()] ^= bits;
        let p = self.board.get_mut(&id).unwrap();
        p.row = r1;
        p.col = c1;
        Ok(())
    }

    fn perform_action(&mut self, m: &MoveInput, rules: &dyn Rules, ev: &mut Vec<EngineEvent>) -> Result<()> {
        match m.action {
            ActionType::Pass => Ok(()),
            ActionType::Shoot => self.perform_shoot(m.ship_id, m.new_row, m.new_col, m.target_ship_id, ev),
            ActionType::Retreat => self.remove_ship(m.ship_id, true, true, ev),
            ActionType::Assist => Err(Error::InvalidMove),
            ActionType::Special => {
                let b = self.ship(m.ship_id);
                let r = rules.special_resolver(b.variant, b.special).ok_or(Error::InvalidMove)?;
                self.dispatch_effects(r, b.variant, m, rules, ev)
            }
            ActionType::FactionAbility => {
                let variant = self.ship(m.ship_id).variant;
                let r = rules.faction_resolver(variant).ok_or(Error::InvalidMove)?;
                self.dispatch_effects(r, variant, m, rules, ev)
            }
        }
    }

    fn perform_shoot(&mut self, shooter: u64, row: i16, col: i16, target_id: u64, ev: &mut Vec<EngineEvent>) -> Result<()> {
        let target = self.ship(target_id);
        let s = self.ship(shooter);
        if target.status == STATUS_DESTROYED {
            return Err(Error::ShipDestroyed);
        }
        if target.placed && target.is_creator == s.is_creator {
            return Err(Error::InvalidMove);
        }
        // _validateShootTarget
        let dist = manhattan_checked((row, col), (target.row, target.col))?;
        if !target.placed || target.status != STATUS_ALIVE || dist > s.range {
            return Err(Error::InvalidMove);
        }
        if dist > 1 {
            let enemy_side = Side::of(s.is_creator).other();
            let enemy = self.live[enemy_side.idx()] & !Bitmap::cell(target.row, target.col);
            if !self.map.has_los_avoiding(row, col, target.row, target.col, enemy)? {
                return Err(Error::InvalidMove);
            }
        }

        if target.hull_points == 0 {
            let t = self.board.get_mut(&target_id).unwrap();
            t.reactor_critical_timer = t.reactor_critical_timer.checked_add(1).ok_or(Error::ArithmeticOverflow)?;
            if t.reactor_critical_timer >= 3 {
                self.remove_ship(target_id, false, true, ev)?;
            }
            return Ok(());
        }

        let base = s.gun_damage as u16;
        let reduced = base
            .checked_sub((base * target.damage_reduction as u16) / 100)
            .ok_or(Error::ArithmeticOverflow)?;
        if reduced >= target.hull_points as u16 {
            self.set_hp_to_zero(target_id);
            self.board.get_mut(&target_id).unwrap().last_damager = shooter;
        } else {
            self.board.get_mut(&target_id).unwrap().hull_points -= reduced as u8;
        }
        Ok(())
    }

    /// Game._setShipHPToZero.
    fn set_hp_to_zero(&mut self, id: u64) {
        let round = self.current_round;
        let b = self.board.get_mut(&id).unwrap();
        b.hull_points = 0;
        let (side, cell) = (Side::of(b.is_creator), Bitmap::cell(b.row, b.col));
        self.live[side.idx()] &= !cell;
        if self.clear_moved(id) {
            self.board.get_mut(&id).unwrap().zeroed_after_moving_round = round;
        }
        set_add(&mut self.ships_with_zero_hp, id);
    }

    fn clear_moved(&mut self, id: u64) -> bool {
        if !self.has_moved(id) {
            return false;
        }
        self.board.get_mut(&id).unwrap().moved_in_round = 0;
        self.moved_total -= 1;
        true
    }

    /// Game._removeShipFromGame.
    fn remove_ship(&mut self, id: u64, is_retreat: bool, check_end: bool, ev: &mut Vec<EngineEvent>) -> Result<()> {
        let b = self.ship(id);
        require_on_board(&b)?;
        let side = Side::of(b.is_creator);
        let keep = !Bitmap::cell(b.row, b.col);
        self.occupied &= keep;
        self.live[side.idx()] &= keep;
        self.clear_moved(id);
        set_remove(&mut self.ships_with_zero_hp, id);
        self.ships_removed_total += 1;
        self.gone_ship_ids.push(id);
        ev.push(EngineEvent::ShipLeftFleet { ship_id: id, side });

        let b = self.board.get_mut(&id).unwrap();
        *b = ShipBoard {
            row: b.row,
            col: b.col,
            is_creator: b.is_creator,
            status: if is_retreat { STATUS_FLED } else { STATUS_DESTROYED },
            placed: true,
            active_index: b.active_index,
            variant: b.variant,
            special: b.special,
            last_damager: b.last_damager,
            ..Default::default()
        };
        let last_damager = b.last_damager;
        if !is_retreat {
            ev.push(EngineEvent::ShipDestroyed { ship_id: id, last_damager });
        }
        self.remove_from_active(id);
        if check_end {
            self.check_game_end(ev);
        }
        Ok(())
    }

    fn remove_from_active(&mut self, id: u64) {
        let b = self.ship(id);
        let index = b.active_index as usize;
        if index == 0 {
            return;
        }
        let side = Side::of(b.is_creator);
        let list = self.active_mut(side);
        let last = *list.last().unwrap();
        let len = list.len();
        if index != len {
            list[index - 1] = last;
            self.board.get_mut(&last).unwrap().active_index = index as u8;
        }
        self.active_mut(side).pop();
        self.board.get_mut(&id).unwrap().active_index = 0;
    }

    /// Game._checkGameEndCondition.
    fn check_game_end(&mut self, ev: &mut Vec<EngineEvent>) {
        let c = self.side_has_live_ships(Side::Creator);
        let j = self.side_has_live_ships(Side::Joiner);
        if !c && !j {
            self.end_by_score(ev);
        } else if !c {
            self.end_game(Some(Side::Joiner), ev);
        } else if !j {
            self.end_game(Some(Side::Creator), ev);
        }
    }

    fn end_by_score(&mut self, ev: &mut Vec<EngineEvent>) {
        let w = match self.creator_score.cmp(&self.joiner_score) {
            core::cmp::Ordering::Equal => None,
            core::cmp::Ordering::Greater => Some(Side::Creator),
            core::cmp::Ordering::Less => Some(Side::Joiner),
        };
        self.end_game(w, ev);
    }

    /// Game._endGame (no-op if already ended, L-08).
    pub fn end_game(&mut self, winner: Option<Side>, ev: &mut Vec<EngineEvent>) {
        if self.ended {
            return;
        }
        self.winner = winner;
        self.ended = true;
        ev.push(EngineEvent::GameEnded { winner });
    }

    /// Game.forceEndSession (orchestrator-only; caller checks auth).
    pub fn force_end(&mut self, winner: Option<Side>) -> Result<Vec<EngineEvent>> {
        if self.ended {
            return Err(Error::InvalidMove);
        }
        let mut ev = Vec::new();
        self.end_game(winner, &mut ev);
        Ok(ev)
    }

    fn round_complete(&self) -> Result<bool> {
        let moved = self.moved_total.checked_sub(self.moved_at_round_start).ok_or(Error::ArithmeticOverflow)?;
        let total = (moved + self.ships_with_zero_hp.len() as u64 + self.ships_removed_total)
            .checked_sub(self.removed_at_round_start)
            .ok_or(Error::ArithmeticOverflow)?;
        Ok(total >= self.total_active_at_round_start)
    }

    fn has_unmoved_ships(&self, side: Side) -> bool {
        self.active(side).iter().any(|&id| self.ship(id).hull_points != 0 && !self.has_moved(id))
    }

    fn switch_turn_if_other_player_has_ships(&mut self) {
        let cur = self.current_turn;
        let other_unmoved = self.has_unmoved_ships(cur.other());
        let cur_movable = self.side_has_live_ships(cur);
        if other_unmoved || !cur_movable {
            self.current_turn = cur.other();
        }
    }

    fn handle_end_of_round(&mut self, ev: &mut Vec<EngineEvent>) -> Result<()> {
        let tiles = self.map.scoring_positions();
        let (c_live, j_live) = (self.live[0], self.live[1]);
        let (mut c_pts, mut j_pts) = (0u64, 0u64);
        for t in tiles {
            let c_on = c_live.has_cell(t.row, t.col);
            if !c_on && !j_live.has_cell(t.row, t.col) {
                continue;
            }
            let p = self.map.score_and_zero_out(t.row, t.col) as u64;
            if p == 0 {
                continue;
            }
            if c_on { c_pts += p } else { j_pts += p }
        }
        if c_pts > 0 || j_pts > 0 {
            self.creator_score += c_pts;
            self.joiner_score += j_pts;
            if self.creator_score >= self.max_score || self.joiner_score >= self.max_score {
                self.end_by_score(ev);
                return Ok(());
            }
        }
        self.current_round += 1;
        self.moved_at_round_start = self.moved_total;
        self.removed_at_round_start = self.ships_removed_total;
        self.total_active_at_round_start = (self.creator_active.len() + self.joiner_active.len()) as u64;
        self.tick_reactor_timers(ev)?;
        let first = if self.creator_goes_first { Side::Creator } else { Side::Joiner };
        self.current_turn = if self.current_round & 1 == 1 { first } else { first.other() };
        Ok(())
    }

    /// Game._incrementReactorCriticalTimerForZeroHPShips.
    fn tick_reactor_timers(&mut self, ev: &mut Vec<EngineEvent>) -> Result<()> {
        let mut count = self.ships_with_zero_hp.len();
        let mut i = 0;
        while i < count {
            let id = self.ships_with_zero_hp[i];
            let b = self.ship(id);
            if b.status == STATUS_ALIVE && b.hull_points == 0 {
                let t = self.board.get_mut(&id).unwrap();
                t.reactor_critical_timer = t.reactor_critical_timer.checked_add(1).ok_or(Error::ArithmeticOverflow)?;
                if t.reactor_critical_timer >= 3 {
                    self.remove_ship(id, false, true, ev)?;
                    if self.ended {
                        return Ok(());
                    }
                    count = self.ships_with_zero_hp.len();
                    continue;
                }
            }
            i += 1;
        }
        Ok(())
    }

    // ------------------------------------------------------------- effects

    /// Game._dispatchEffects + SpecialEffectsLib.resolveAndApply.
    fn dispatch_effects(&mut self, resolver: Resolver, variant: u16, m: &MoveInput, rules: &dyn Rules, ev: &mut Vec<EngineEvent>) -> Result<()> {
        if m.target_ship_id != 0 {
            let t = self.ship(m.target_ship_id);
            if !t.placed {
                return Err(Error::ShipNotFound);
            }
            if t.status == STATUS_DESTROYED {
                return Err(Error::ShipDestroyed);
            }
        }
        let ctx = ResolveCtx { ship_id: m.ship_id, variant, target_ship_id: m.target_ship_id, acting_row: m.new_row, acting_col: m.new_col };
        let effects = resolver.resolve(self, rules, &ctx)?;

        let mut removals: Vec<(u64, u8)> = Vec::new();
        let mut relocations: Vec<(u64, i16, i16)> = Vec::new();
        for e in &effects {
            let (removed, kind) = self.apply_effect(m.ship_id, e);
            if removed {
                removals.push((e.ship_id, kind));
            } else if e.new_row != NO_RELOCATE {
                relocations.push((e.ship_id, e.new_row, e.new_col));
            }
        }
        for &(id, kind) in &removals {
            self.remove_ship(id, kind == 1, false, ev)?;
        }
        self.apply_relocations(&relocations)?;
        if !removals.is_empty() {
            self.check_game_end(ev);
        }
        Ok(())
    }

    fn apply_effect(&mut self, acting: u64, e: &SpecialEffect) -> (bool, u8) {
        if e.removal_kind != 0 {
            return (true, e.removal_kind);
        }
        let acting_is_creator = self.ship(acting).is_creator;
        self.board.entry(e.ship_id).or_default();
        if e.reactor_timer_delta != 0 {
            let a = self.board.get_mut(&e.ship_id).unwrap();
            if acting_is_creator != a.is_creator {
                a.last_damager = acting;
            }
            let mut t = a.reactor_critical_timer as i16 + e.reactor_timer_delta as i16;
            if t < 0 {
                t = 0;
            }
            if t >= 3 {
                return (true, 2);
            }
            a.reactor_critical_timer = t as u8;
        }
        if e.hull_delta != 0 {
            self.apply_hull_delta(e.ship_id, e.hull_delta, acting, acting_is_creator);
        }
        (false, 0)
    }

    fn set_live(&mut self, id: u64, live: bool) {
        let b = self.ship(id);
        if b.status != STATUS_ALIVE {
            return;
        }
        let (side, cell) = (Side::of(b.is_creator).idx(), Bitmap::cell(b.row, b.col));
        if live {
            self.live[side] |= cell;
        } else {
            self.live[side] &= !cell;
        }
    }

    fn apply_hull_delta(&mut self, id: u64, delta: i16, acting: u64, acting_is_creator: bool) {
        let round = self.current_round;
        let cap_pct = self.heal_cap_percent_at_start as u16;
        if delta < 0 {
            let damage = (-(delta as i32)) as u16;
            let hp = self.ship(id).hull_points as u16;
            if damage >= hp {
                self.board.get_mut(&id).unwrap().hull_points = 0;
                self.set_live(id, false);
                let a = self.board.get_mut(&id).unwrap();
                if a.moved_in_round == round {
                    a.moved_in_round = 0;
                    a.zeroed_after_moving_round = round;
                    self.moved_total -= 1;
                }
                set_add(&mut self.ships_with_zero_hp, id);
                let a = self.board.get_mut(&id).unwrap();
                if acting_is_creator != a.is_creator {
                    a.last_damager = acting;
                }
            } else {
                self.board.get_mut(&id).unwrap().hull_points -= damage as u8;
            }
        } else {
            let a = self.board.get_mut(&id).unwrap();
            let cur = a.hull_points;
            let new_hp = cur as u16 + delta as u16;
            let cap = (a.max_hull_points as u16 * cap_pct) / 100;
            let capped = new_hp.min(cap);
            a.hull_points = if capped > cur as u16 { capped as u8 } else { cur };
            if cur == 0 && a.hull_points > 0 {
                set_remove(&mut self.ships_with_zero_hp, id);
                self.set_live(id, true);
                let a = self.board.get_mut(&id).unwrap();
                if a.zeroed_after_moving_round == round && a.moved_in_round != round {
                    a.moved_in_round = round;
                    self.moved_total += 1;
                }
            }
        }
    }

    /// SpecialEffectsLib.applyRelocations.
    fn apply_relocations(&mut self, relocs: &[(u64, i16, i16)]) -> Result<()> {
        for &(id, r, c) in relocs {
            if r < 0 || c < 0 || r >= GRID_HEIGHT || c >= GRID_WIDTH {
                return Err(Error::RelocationOutOfBounds);
            }
            let p = self.ship(id);
            let old = Bitmap::cell(p.row, p.col);
            let occupied = self.occupied & !old;
            let new = Bitmap::cell(r, c);
            if !(occupied & new).is_empty() {
                return Err(Error::RelocationDestinationOccupied);
            }
            self.occupied = occupied | new;
            if p.status == STATUS_ALIVE && p.hull_points > 0 {
                let mut bits = old;
                bits |= new;
                self.live[Side::of(p.is_creator).idx()] ^= bits;
            }
            let p = self.board.get_mut(&id).unwrap();
            p.row = r;
            p.col = c;
        }
        Ok(())
    }
}

fn require_on_board(b: &ShipBoard) -> Result<()> {
    if b.active_index == 0 {
        if b.status == STATUS_DESTROYED {
            return Err(Error::ShipDestroyed);
        }
        return Err(Error::ShipNotFound);
    }
    Ok(())
}

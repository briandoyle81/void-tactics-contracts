//! Single-player AI: AIBehavior.sol (shared heuristics), Variant1AI.sol (the
//! faction-1 decision tree), and SinglePlayerMatch's turn driver
//! (`take_ai_turns`). The AI always plays the joiner side.
//!
//! Every helper keeps the Solidity iteration order and tie-break rules (first
//! strict improvement wins), since those decide which ship/tile/target is
//! picked. Calls that could revert in Solidity (LOS/movement lookups with an
//! off-board coordinate, checked arithmetic) return `Err`; the driver treats a
//! failed decision exactly like SinglePlayerMatch's try/catch: fall back to a
//! Pass in place.

use borsh::{BorshDeserialize, BorshSerialize};
use serde::{Deserialize, Serialize};

use crate::effects::Resolver;
use crate::engine::{EngineEvent, GameState, MoveInput, Rules, Side};
use crate::error::{Error, Result};
use crate::grid::{bit_index, in_bounds, Bitmap, GRID_HEIGHT, GRID_WIDTH};
use crate::maps::GameMap;
use crate::types::{ActionType, Archetype, Attributes, ScoringPosition, Special};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Pos {
    pub row: i16,
    pub col: i16,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize, Serialize, Deserialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(schemars::JsonSchema, borsh::BorshSchema))]
pub struct Decision {
    pub dest_row: i16,
    pub dest_col: i16,
    pub action: ActionType,
    pub target: u64,
}

impl Default for Decision {
    fn default() -> Self {
        Decision { dest_row: 0, dest_col: 0, action: ActionType::Pass, target: 0 }
    }
}

fn decision(dest: Pos, action: ActionType, target: u64) -> Decision {
    Decision { dest_row: dest.row, dest_col: dest.col, action, target }
}

/// Per-AI-ship info kept by the orchestrator (SinglePlayerMatch.AIShipInfo).
#[derive(Clone, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize, Serialize, Deserialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(schemars::JsonSchema, borsh::BorshSchema))]
pub struct AiShipInfo {
    pub archetype: Archetype,
    pub variant: u16,
    pub special: Special,
}

#[derive(Clone, Debug)]
struct ViewShip {
    id: u64,
    pos: Pos,
    is_creator: bool,
    status: u8,
    a: Attributes,
}

fn manhattan(a: Pos, b: Pos) -> u16 {
    ((a.row as i32 - b.row as i32).unsigned_abs() + (a.col as i32 - b.col as i32).unsigned_abs()) as u16
}

/// AIBehavior._cellBit: 0 for an off-board cell.
fn cell_bit(p: Pos) -> Bitmap {
    if !in_bounds(p.row, p.col) {
        return Bitmap::EMPTY;
    }
    Bitmap::cell(p.row, p.col)
}

fn cell_pos(idx: usize) -> Pos {
    Pos { row: (idx / GRID_WIDTH as usize) as i16, col: (idx % GRID_WIDTH as usize) as i16 }
}

fn min8(a: u16, b: u8) -> u8 {
    if a < b as u16 { a as u8 } else { b }
}

/// AIBehavior.shotDamage (checked like Solidity).
pub fn shot_damage(gun: u8, dr: u8) -> Result<u64> {
    (gun as u64).checked_sub((gun as u64 * dr as u64) / 100).ok_or(Error::ArithmeticOverflow)
}

/// AIBehavior._dilate: grow a cell set by `n` orthogonal steps within `mask`.
pub fn dilate(mut x: Bitmap, n: u32, mask: Bitmap) -> Bitmap {
    let not_first = !Bitmap::col_mask(0);
    let not_last = !Bitmap::col_mask(GRID_WIDTH - 1);
    for _ in 0..n {
        x = (x | (x.shl(1) & not_first) | (x.shr(1) & not_last) | x.shl(17) | x.shr(17)) & mask;
    }
    x
}

fn turns_to_reach(dist: u16, movement: u8) -> u64 {
    if dist == 0 {
        return 0;
    }
    if movement == 0 {
        return u64::MAX;
    }
    (dist as u64 + movement as u64 - 1) / movement as u64
}

/// AIBehavior._stepToward: greedy step along the longer axis first.
fn step_toward(from: Pos, to: Pos, movement: u8) -> Pos {
    let rd = to.row - from.row;
    let cd = to.col - from.col;
    let (r_dist, c_dist) = (rd.unsigned_abs(), cd.unsigned_abs());
    let mut budget = movement as u16;
    let (row_step, col_step);
    if r_dist >= c_dist {
        let use_row = r_dist.min(budget);
        row_step = if rd < 0 { -(use_row as i16) } else { use_row as i16 };
        budget -= use_row;
        let use_col = c_dist.min(budget);
        col_step = if cd < 0 { -(use_col as i16) } else { use_col as i16 };
    } else {
        let use_col = c_dist.min(budget);
        col_step = if cd < 0 { -(use_col as i16) } else { use_col as i16 };
        budget -= use_col;
        let use_row = r_dist.min(budget);
        row_step = if rd < 0 { -(use_row as i16) } else { use_row as i16 };
    }
    Pos { row: from.row + row_step, col: from.col + col_step }
}

const PATH_CHECKS_MAX: u32 = 12;
const SHOT_SEARCH_MAX: u32 = 16;

#[derive(Default, Clone, Copy)]
struct TileChoice {
    pos: Pos,
    ok: bool,
    tier: u64,
    turns: u64,
    points: u64,
    dist: u16,
}

fn better_tile(a: &TileChoice, b: &TileChoice) -> bool {
    if a.tier != b.tier {
        return a.tier < b.tier;
    }
    // u128: Solidity would overflow-revert only for an immobile ship.
    let av = a.points as u128 * (b.turns as u128 + 1);
    let bv = b.points as u128 * (a.turns as u128 + 1);
    if av != bv {
        return av > bv;
    }
    a.dist < b.dist
}

#[derive(Default, Clone, Copy)]
struct Stand {
    pos: Pos,
    found: bool,
    scoring: bool,
    dist: u16,
}

#[derive(Default)]
pub struct Sweep {
    pub enemies: u32,
    pub finishable_enemies: u32,
    pub allies: u32,
    pub allies_at_risk: u32,
}

/// AIBehavior.Ctx after loadView.
pub struct Ctx<'a> {
    view: Vec<ViewShip>,
    map: &'a GameMap,
    ship_id: u64,
    pos: Pos,
    attrs: Attributes,
    scoring: Vec<ScoringPosition>,
    occupied: Bitmap,
    creator_live: Bitmap,
    joiner_live: Bitmap,
    self_bit: Bitmap,
    impassable: Bitmap,
}

impl<'a> Ctx<'a> {
    /// AIBehavior.loadView from the live game.
    pub fn load(g: &'a GameState, ship_id: u64) -> Result<Ctx<'a>> {
        let view: Vec<ViewShip> = g
            .creator_active
            .iter()
            .chain(g.joiner_active.iter())
            .map(|&id| {
                let b = g.ship(id);
                ViewShip { id, pos: Pos { row: b.row, col: b.col }, is_creator: b.is_creator, status: b.status, a: b.attributes() }
            })
            .collect();
        let me = view.iter().find(|s| s.id == ship_id).ok_or(Error::ShipNotFound)?; // ShipNotInView
        let (pos, attrs) = (me.pos, me.a.clone());
        Ok(Ctx {
            map: &g.map,
            ship_id,
            pos,
            attrs,
            scoring: g.map.scoring_positions(),
            occupied: g.occupied,
            creator_live: g.live[0],
            joiner_live: g.live[1],
            self_bit: cell_bit(pos),
            impassable: g.map.impassable,
            view,
        })
    }

    fn enemies(&self) -> impl Iterator<Item = &ViewShip> {
        self.view.iter().filter(|s| s.status == 0 && s.is_creator)
    }

    fn is_scoring(&self, p: Pos) -> bool {
        self.scoring.iter().any(|s| s.row == p.row && s.col == p.col)
    }

    fn find_position(&self, id: u64) -> Option<Pos> {
        self.view.iter().find(|s| s.id == id).map(|s| s.pos)
    }

    fn los_excluding_target(&self, from: Pos, target: Pos, side: Bitmap) -> Result<bool> {
        let bm = side & !Bitmap::single(bit_index(target.row, target.col));
        self.map.has_los_avoiding(from.row, from.col, target.row, target.col, bm)
    }

    fn target_key(&self, a: &Attributes, p: Pos, gun: bool) -> Result<u64> {
        let on_tile = self.is_scoring(p);
        if a.hull_points == 0 {
            return Ok(on_tile as u64);
        }
        let mut key = 1u64 << 30;
        let dmg = if gun { shot_damage(self.attrs.gun_damage, a.damage_reduction)? } else { 0 };
        if gun && dmg >= a.hull_points as u64 {
            key |= 1 << 29;
        }
        if on_tile {
            key |= 1 << 28;
        }
        key |= dmg << 8;
        key |= 255 - a.hull_points as u64;
        Ok(key)
    }

    pub fn best_enemy_within(&self, from: Pos, range: u8, needs_los: bool) -> Result<Option<u64>> {
        let enemy_bm = if needs_los { self.creator_live } else { Bitmap::EMPTY };
        let mut best: Option<(u64, u64)> = None;
        for sp in &self.view {
            if sp.id == self.ship_id || sp.status != 0 || !sp.is_creator {
                continue;
            }
            let dist = manhattan(from, sp.pos);
            if dist > range as u16 {
                continue;
            }
            if needs_los && dist > 1 && !self.los_excluding_target(from, sp.pos, enemy_bm)? {
                continue;
            }
            let key = self.target_key(&sp.a, sp.pos, needs_los)?;
            if best.is_none_or(|(_, k)| key > k) {
                best = Some((sp.id, key));
            }
        }
        Ok(best.map(|(id, _)| id))
    }

    fn best_ally_to_heal(&self, range: u8) -> Option<u64> {
        let mut best: Option<(u64, u8, bool)> = None;
        for sp in &self.view {
            if sp.id == self.ship_id || sp.status != 0 || sp.is_creator {
                continue;
            }
            if manhattan(self.pos, sp.pos) > range as u16 {
                continue;
            }
            let a = &sp.a;
            if a.hull_points >= a.max_hull_points {
                continue;
            }
            let is_zero = a.hull_points == 0;
            match best {
                None => best = Some((sp.id, a.hull_points, is_zero)),
                Some((_, hp, bz)) => {
                    if (is_zero && !bz) || (is_zero == bz && a.hull_points < hp) {
                        best = Some((sp.id, a.hull_points, is_zero));
                    }
                }
            }
        }
        best.map(|b| b.0)
    }

    fn nearest_enemy_position(&self, prefer_zero: bool) -> Option<Pos> {
        let nearest = |filter: &dyn Fn(&ViewShip) -> bool| -> Option<Pos> {
            let mut best: Option<(Pos, u16)> = None;
            for sp in &self.view {
                if sp.id == self.ship_id || sp.status != 0 || !sp.is_creator || !filter(sp) {
                    continue;
                }
                let d = manhattan(self.pos, sp.pos);
                if best.is_none_or(|(_, bd)| d < bd) {
                    best = Some((sp.pos, d));
                }
            }
            best.map(|b| b.0)
        };
        if prefer_zero {
            if let Some(p) = nearest(&|s| s.a.hull_points == 0) {
                return Some(p);
            }
        }
        nearest(&|s| s.a.hull_points != 0).or_else(|| nearest(&|_| true))
    }

    fn occupied_by_other(&self, p: Pos) -> bool {
        !(self.occupied & !self.self_bit & cell_bit(p)).is_empty()
    }

    fn unclaimable_tile(&self, p: Pos) -> bool {
        self.occupied_by_other(p) && (self.creator_live & cell_bit(p)).is_empty()
    }

    fn reachable(&self, dest: Pos, enemy: Bitmap) -> Result<bool> {
        if dest == self.pos {
            return Ok(true);
        }
        if self.occupied_by_other(dest) {
            return Ok(false);
        }
        self.map.has_movement_path_avoiding(self.pos.row, self.pos.col, dest.row, dest.col, enemy)
    }

    fn backoff_toward(&self, target: Pos, max_steps: u8, enemy: Bitmap) -> Result<Option<Pos>> {
        for steps in (1..=max_steps).rev() {
            let dest = step_toward(self.pos, target, steps);
            if self.reachable(dest, enemy)? {
                return Ok(Some(dest));
            }
        }
        Ok(None)
    }

    /// AIBehavior._stepTowardReachable.
    pub fn step_toward_reachable(&self, target: Pos, max_steps: u8, stop_short_by: u8) -> Result<Pos> {
        let enemy = self.creator_live;
        if manhattan(self.pos, target) <= stop_short_by as u16 {
            return Ok(self.pos);
        }
        if let Some(d) = self.path_step(target, max_steps, stop_short_by, enemy)? {
            return Ok(d);
        }
        if let Some(d) = self.primary_attempt(target, max_steps, stop_short_by, enemy)? {
            return Ok(d);
        }
        for (ro, co) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
            if let Some(d) = self.try_detour(target, ro, co, max_steps, stop_short_by, enemy)? {
                return Ok(d);
            }
        }
        if manhattan(self.pos, target) <= stop_short_by as u16 + 1 {
            return Ok(self.pos);
        }
        if let Some(d) = self.try_sidestep(target, max_steps, enemy)? {
            return Ok(d);
        }
        Ok(self.pos)
    }

    fn path_step(&self, target: Pos, max_steps: u8, stop: u8, enemy: Bitmap) -> Result<Option<Pos>> {
        let board = Bitmap::board_mask();
        let passable = board & !(self.impassable | enemy);
        let reach = dilate(self.self_bit, max_steps as u32, board) & !(self.occupied | self.impassable);
        let greedy = cell_bit(step_toward(self.pos, target, min8(manhattan(self.pos, target) - stop as u16, max_steps)));
        let mut frontier = dilate(cell_bit(target), stop as u32, board);
        let mut visited = frontier;
        let mut checks = 0u32;
        while !frontier.is_empty() {
            if !(frontier & self.self_bit).is_empty() {
                break;
            }
            // _tryRing
            let mut cands = frontier & reach;
            if !(cands & greedy).is_empty() {
                cands &= !greedy;
                let dest = cell_pos(greedy.lowest());
                checks += 1;
                if self.reachable(dest, enemy)? {
                    return Ok(Some(dest));
                }
            }
            while !cands.is_empty() && checks < PATH_CHECKS_MAX {
                let bit = self.nearest_cell(cands);
                cands &= !bit;
                let dest = cell_pos(bit.lowest());
                checks += 1;
                if self.reachable(dest, enemy)? {
                    return Ok(Some(dest));
                }
            }
            if checks >= PATH_CHECKS_MAX {
                break;
            }
            let next = dilate(frontier, 1, passable) & !visited;
            visited |= next;
            frontier = next;
        }
        Ok(None)
    }

    /// AIBehavior._nearestCell: lowest-index cell at minimum distance.
    fn nearest_cell(&self, cells: Bitmap) -> Bitmap {
        let mut best = Bitmap::EMPTY;
        let mut best_d = u16::MAX;
        let mut rest = cells;
        while !rest.is_empty() {
            let idx = rest.lowest();
            rest.clear(idx);
            let d = manhattan(self.pos, cell_pos(idx));
            if d < best_d {
                best_d = d;
                best = Bitmap::single(idx);
            }
        }
        best
    }

    fn try_sidestep(&self, target: Pos, max_steps: u8, enemy: Bitmap) -> Result<Option<Pos>> {
        let rd = target.row - self.pos.row;
        let cd = target.col - self.pos.col;
        let side_is_col = rd.abs() >= cd.abs();
        let first: i16 = if (if side_is_col { cd } else { rd }) < 0 { -1 } else { 1 };
        if let Some(p) = self.sidestep_dir(side_is_col, first, max_steps, enemy)? {
            return Ok(Some(p));
        }
        self.sidestep_dir(side_is_col, -first, max_steps, enemy)
    }

    fn sidestep_dir(&self, along_col: bool, dir: i16, max_steps: u8, enemy: Bitmap) -> Result<Option<Pos>> {
        for steps in (1..=max_steps).rev() {
            let off = dir * steps as i16;
            let p = if along_col { Pos { row: self.pos.row, col: self.pos.col + off } } else { Pos { row: self.pos.row + off, col: self.pos.col } };
            if in_bounds(p.row, p.col) && self.reachable(p, enemy)? {
                return Ok(Some(p));
            }
        }
        Ok(None)
    }

    fn primary_attempt(&self, target: Pos, max_steps: u8, stop: u8, enemy: Bitmap) -> Result<Option<Pos>> {
        let dist = manhattan(self.pos, target);
        if dist <= stop as u16 {
            return Ok(Some(self.pos));
        }
        self.backoff_toward(target, min8(dist - stop as u16, max_steps), enemy)
    }

    fn try_detour(&self, target: Pos, ro: i16, co: i16, max_steps: u8, stop: u8, enemy: Bitmap) -> Result<Option<Pos>> {
        let t = Pos { row: target.row + ro, col: target.col + co };
        if !in_bounds(t.row, t.col) {
            return Ok(None);
        }
        let d = manhattan(self.pos, t);
        if d <= stop as u16 {
            return Ok(None);
        }
        self.backoff_toward(t, min8(d - stop as u16, max_steps), enemy)
    }

    fn tile_race(&self, t: Pos, points: u8) -> TileChoice {
        let mut c = TileChoice { pos: t, points: points as u64, ..Default::default() };
        c.dist = manhattan(self.pos, t);
        c.turns = turns_to_reach(c.dist, self.attrs.movement);
        if !(self.creator_live & cell_bit(t)).is_empty() {
            c.tier = 3;
            c.ok = true;
            return c;
        }
        if self.occupied_by_other(t) {
            return c;
        }
        let mut enemy_turns = u64::MAX;
        for sp in self.enemies() {
            if sp.a.hull_points == 0 {
                continue;
            }
            enemy_turns = enemy_turns.min(turns_to_reach(manhattan(sp.pos, t), sp.a.movement));
        }
        c.tier = if c.turns < enemy_turns { 0 } else if c.turns == enemy_turns { 1 } else { 2 };
        c.ok = true;
        c
    }

    fn best_scoring_tile(&self) -> Option<Pos> {
        let mut best = TileChoice::default();
        for sp in &self.scoring {
            let c = self.tile_race(Pos { row: sp.row, col: sp.col }, sp.points);
            if c.ok && (!best.ok || better_tile(&c, &best)) {
                best = c;
            }
        }
        best.ok.then_some(best.pos)
    }

    fn should_hold_scoring_tile(&self) -> Result<bool> {
        if !self.is_scoring(self.pos) {
            return Ok(false);
        }
        if let Some(enemy_pos) = self.nearest_enemy_position(false) {
            let stepped = step_toward(self.pos, enemy_pos, self.attrs.movement);
            let could_shoot = self.best_enemy_within(stepped, self.attrs.range, true)?.is_some();
            if could_shoot && self.ally_can_cover_tile() && !self.enemy_threatens_tile(self.pos)? {
                return Ok(false);
            }
        }
        Ok(true)
    }

    fn ally_can_cover_tile(&self) -> bool {
        self.view.iter().any(|sp| {
            sp.id != self.ship_id && sp.status == 0 && !sp.is_creator && manhattan(sp.pos, self.pos) <= sp.a.movement as u16
        })
    }

    fn enemy_threatens_tile(&self, tile: Pos) -> Result<bool> {
        for sp in self.enemies() {
            let d = manhattan(sp.pos, tile);
            if d > sp.a.range as u16 {
                continue;
            }
            if d > 1 && !self.los_excluding_target(sp.pos, tile, self.joiner_live)? {
                continue;
            }
            return Ok(true);
        }
        Ok(false)
    }

    fn hold(&self) -> Decision {
        decision(self.pos, ActionType::Pass, 0)
    }

    fn approach_or_seek_tile(&self, enemy_pos: Pos, enemy_found: bool) -> Result<Decision> {
        let mut d = self.hold();
        let mut toward_enemy = self.pos;
        if enemy_found {
            toward_enemy = self.step_toward_reachable(enemy_pos, self.attrs.movement, 0)?;
            if let Some(t) = self.best_enemy_within(toward_enemy, self.attrs.range, true)? {
                return Ok(decision(toward_enemy, ActionType::Shoot, t));
            }
        }
        if let Some(tile) = self.best_scoring_tile() {
            if !self.unclaimable_tile(tile) {
                let tt = self.step_toward_reachable(tile, self.attrs.movement, 0)?;
                d.dest_row = tt.row;
                d.dest_col = tt.col;
                return Ok(d);
            }
        }
        if enemy_found {
            d.dest_row = toward_enemy.row;
            d.dest_col = toward_enemy.col;
        }
        Ok(d)
    }

    fn tile_income(&self) -> (u64, u64) {
        let (mut enemy, mut own) = (0, 0);
        for t in &self.scoring {
            let bit = cell_bit(Pos { row: t.row, col: t.col });
            if !(self.creator_live & bit).is_empty() {
                enemy += t.points as u64;
            } else if !(self.joiner_live & bit).is_empty() {
                own += t.points as u64;
            }
        }
        (enemy, own)
    }

    fn nearest_enemy_on_tile(&self) -> Option<Pos> {
        let mut best: Option<(Pos, u16)> = None;
        for t in &self.scoring {
            let p = Pos { row: t.row, col: t.col };
            if (self.creator_live & cell_bit(p)).is_empty() {
                continue;
            }
            let d = manhattan(self.pos, p);
            if d < best.map_or(u16::MAX, |b| b.1) {
                best = Some((p, d));
            }
        }
        best.map(|b| b.0)
    }

    pub fn nearest_enemy(&self) -> Option<Pos> {
        let (enemy, own) = self.tile_income();
        if enemy > own {
            if let Some(p) = self.nearest_enemy_on_tile() {
                return Some(p);
            }
        }
        self.nearest_enemy_position(false)
    }

    fn on_scoring_tile(&self) -> bool {
        self.is_scoring(self.pos)
    }

    fn idle_or_seek_tile(&self) -> Result<Decision> {
        if self.should_hold_scoring_tile()? {
            return Ok(self.hold());
        }
        self.approach_or_seek_tile(self.pos, false)
    }

    fn threatened(&self, p: Pos) -> bool {
        self.enemies().any(|sp| sp.a.hull_points != 0 && manhattan(p, sp.pos) <= sp.a.range as u16)
    }

    fn enemy_within(&self, p: Pos, range: u8) -> bool {
        self.enemies().any(|sp| sp.a.hull_points != 0 && manhattan(p, sp.pos) <= range as u16)
    }

    /// Ring offsets in AIBehavior's order: d, dr ascending, side +1 then -1
    /// (one cell when rem == 0).
    fn ring(&self, d: i16) -> Vec<Pos> {
        let mut out = Vec::new();
        for dr in -d..=d {
            let rem = d - dr.abs();
            for side in [1i16, -1] {
                out.push(Pos { row: self.pos.row + dr, col: self.pos.col + side * rem });
                if rem == 0 {
                    break;
                }
            }
        }
        out
    }

    fn shot_within_reach(&self, safe_only: bool) -> Result<Option<(Pos, u64)>> {
        let enemy = self.creator_live;
        let mut checks = 0u32;
        for d in 0..=(self.attrs.movement as i16) {
            for t in self.ring(d) {
                // _shotFrom
                if in_bounds(t.row, t.col) && self.enemy_within(t, self.attrs.range) && !(safe_only && self.threatened(t)) {
                    checks += 1;
                    if self.reachable(t, enemy)? {
                        if let Some(target) = self.best_enemy_within(t, self.attrs.range, true)? {
                            return Ok(Some((t, target)));
                        }
                    }
                }
                if checks >= SHOT_SEARCH_MAX {
                    return Ok(None);
                }
            }
        }
        Ok(None)
    }

    fn low_hp_evade(&self) -> Result<Option<Decision>> {
        let a = &self.attrs;
        if a.hull_points == 0 || a.hull_points as u32 * 4 >= a.max_hull_points as u32 || self.is_scoring(self.pos) {
            return Ok(None);
        }
        if let Some((p, t)) = self.shot_within_reach(true)? {
            return Ok(Some(decision(p, ActionType::Shoot, t)));
        }
        if !self.threatened(self.pos) {
            return Ok(None);
        }
        Ok(self.safe_tile_within_reach()?.map(|p| decision(p, ActionType::Pass, 0)))
    }

    fn safe_tile_within_reach(&self) -> Result<Option<Pos>> {
        let enemy = self.creator_live;
        let mut checks = 0u32;
        for d in 1..=(self.attrs.movement as i16) {
            for t in self.ring(d) {
                if in_bounds(t.row, t.col) && !self.threatened(t) {
                    if self.reachable(t, enemy)? {
                        return Ok(Some(t));
                    }
                    checks += 1;
                    if checks >= SHOT_SEARCH_MAX {
                        return Ok(None);
                    }
                }
            }
        }
        Ok(None)
    }

    fn within_range_of(&self, target: Pos, range: u8) -> Result<Pos> {
        self.step_toward_reachable(target, self.attrs.movement, range)
    }

    fn can_shoot_from(&self, from: Pos, target: Pos, enemy: Bitmap) -> Result<bool> {
        let d = manhattan(from, target);
        if d > self.attrs.range as u16 {
            return Ok(false);
        }
        Ok(d <= 1 || self.los_excluding_target(from, target, enemy)?)
    }

    fn holder_first_within(&self, from: Pos) -> Result<Option<u64>> {
        let enemy = self.creator_live;
        let mut best: Option<(u64, u8)> = None;
        for sp in self.enemies() {
            let hp = sp.a.hull_points;
            if hp == 0 || best.is_some_and(|(_, bh)| hp >= bh) {
                continue;
            }
            if !self.is_scoring(sp.pos) || !self.can_shoot_from(from, sp.pos, enemy)? {
                continue;
            }
            best = Some((sp.id, hp));
        }
        if let Some((id, _)) = best {
            return Ok(Some(id));
        }
        self.best_enemy_within(from, self.attrs.range, true)
    }

    fn hunt_target(&self) -> Result<Option<(u64, Pos)>> {
        // (id, pos, cost, on_tile, dist)
        let mut best: Option<(u64, Pos, u64, bool, u16)> = None;
        for sp in self.enemies() {
            let a = &sp.a;
            if a.hull_points == 0 {
                continue;
            }
            let dmg = shot_damage(self.attrs.gun_damage, a.damage_reduction)?;
            if dmg == 0 {
                continue;
            }
            let dist = manhattan(self.pos, sp.pos);
            let travel = if dist > self.attrs.range as u16 { turns_to_reach(dist - self.attrs.range as u16, self.attrs.movement) } else { 0 };
            if travel == u64::MAX {
                continue;
            }
            let cost = travel + (a.hull_points as u64 + dmg - 1) / dmg;
            let on_tile = self.is_scoring(sp.pos);
            let take = match best {
                None => true,
                Some((_, _, bc, bt, bd)) => cost < bc || (cost == bc && ((on_tile && !bt) || (on_tile == bt && dist < bd))),
            };
            if take {
                best = Some((sp.id, sp.pos, cost, on_tile, dist));
            }
        }
        Ok(best.map(|b| (b.0, b.1)))
    }

    fn standoff_position(&self, enemy_pos: Pos, allow_retreat: bool) -> Result<Pos> {
        let d = manhattan(self.pos, enemy_pos);
        let range = self.attrs.range;
        if d > range as u16 {
            return self.step_toward_reachable(enemy_pos, self.attrs.movement, range);
        }
        if !allow_retreat {
            return Ok(self.pos);
        }
        let budget = min8(range as u16 - d, self.attrs.movement);
        if budget == 0 {
            return Ok(self.pos);
        }
        let stand = self.retreat_step(enemy_pos, budget);
        if !self.reachable(stand, self.creator_live)? {
            return Ok(self.pos);
        }
        Ok(stand)
    }

    fn retreat_step(&self, threat: Pos, mut budget: u8) -> Pos {
        let mut p = self.pos;
        let d_row = p.row - threat.row;
        let d_col = p.col - threat.col;
        let row_first = d_row.abs() >= d_col.abs();
        for pass in 0..2 {
            if budget == 0 {
                break;
            }
            let use_row = (pass == 0) == row_first;
            let at = if use_row { p.row } else { p.col };
            let delta = if use_row { d_row } else { d_col };
            let limit = if use_row { GRID_HEIGHT } else { GRID_WIDTH };
            let dir: i16 = if delta > 0 { 1 } else if delta < 0 { -1 } else if at < limit / 2 { 1 } else { -1 };
            let room = if dir > 0 { limit - 1 - at } else { at };
            let use_ = (room as u16 as u8).min(budget);
            if use_ == 0 {
                continue;
            }
            if use_row {
                p.row += dir * use_ as i16;
            } else {
                p.col += dir * use_ as i16;
            }
            budget -= use_;
        }
        p
    }

    pub fn sweep(&self, center: Pos, range: u8) -> Sweep {
        let mut s = Sweep::default();
        for sp in &self.view {
            if sp.id == self.ship_id || sp.status != 0 || manhattan(center, sp.pos) > range as u16 {
                continue;
            }
            if sp.is_creator {
                s.enemies += 1;
                if sp.a.hull_points == 0 || sp.a.reactor_critical_timer >= 2 {
                    s.finishable_enemies += 1;
                }
            } else {
                s.allies += 1;
                if sp.a.reactor_critical_timer >= 2 {
                    s.allies_at_risk += 1;
                }
            }
        }
        s
    }

    fn nearest_downed_enemy(&self) -> Option<(u64, Pos)> {
        let mut best: Option<(u64, Pos, u16)> = None;
        for sp in self.enemies() {
            if sp.a.hull_points != 0 {
                continue;
            }
            let d = manhattan(self.pos, sp.pos);
            if best.is_none_or(|b| d < b.2) {
                best = Some((sp.id, sp.pos, d));
            }
        }
        best.map(|b| (b.0, b.1))
    }

    fn doomed_enemy_within(&self, from: Pos, range: u8) -> Option<u64> {
        self.enemies()
            .find(|sp| manhattan(from, sp.pos) <= range as u16 && sp.a.reactor_critical_timer >= 2)
            .map(|sp| sp.id)
    }

    fn heal_with_reach(&self, range: u8, action: ActionType) -> Result<Option<Decision>> {
        let reach = (range as u16 + self.attrs.movement as u16).min(u8::MAX as u16) as u8;
        let Some(ally) = self.best_ally_to_heal(reach) else { return Ok(None) };
        let Some(ally_pos) = self.find_position(ally) else { return Ok(None) };
        Ok(self.reach_within(ally_pos, range)?.map(|dest| decision(dest, action, ally)))
    }

    fn reach_within(&self, target: Pos, range: u8) -> Result<Option<Pos>> {
        if manhattan(self.pos, target) <= range as u16 {
            return Ok(Some(self.pos));
        }
        let dest = self.within_range_of(target, range)?;
        if manhattan(dest, target) <= range as u16 {
            return Ok(Some(dest));
        }
        let s = self.stand_tile(target, range)?;
        Ok(s.found.then_some(s.pos))
    }

    fn decide_support_fallback(&self) -> Result<Decision> {
        let mut d = self.hold();
        if let Some(t) = self.best_enemy_within(self.pos, self.attrs.range, true)? {
            d.action = ActionType::Shoot;
            d.target = t;
            return Ok(d);
        }
        if self.should_hold_scoring_tile()? {
            return Ok(d);
        }
        let dest = match self.best_scoring_tile() {
            Some(p) => p,
            None => {
                let Some(ally) = self.best_ally_to_heal(u8::MAX) else { return Ok(d) };
                let Some(p) = self.find_position(ally) else { return Ok(d) };
                p
            }
        };
        let np = self.step_toward_reachable(dest, self.attrs.movement, 0)?;
        d.dest_row = np.row;
        d.dest_col = np.col;
        if let Some(t) = self.best_enemy_within(np, self.attrs.range, true)? {
            d.action = ActionType::Shoot;
            d.target = t;
        }
        Ok(d)
    }

    fn decide_turtle(&self) -> Result<Decision> {
        let mut d = self.hold();
        if let Some(t) = self.best_enemy_within(self.pos, self.attrs.range, true)? {
            d.action = ActionType::Shoot;
            d.target = t;
            return Ok(d);
        }
        if self.should_hold_scoring_tile()? {
            return Ok(d);
        }
        let Some(tile) = self.best_scoring_tile() else { return Ok(d) };
        if self.occupied_by_other(tile) && manhattan(self.pos, tile) <= 1 {
            return Ok(d);
        }
        let np = self.step_toward_reachable(tile, self.attrs.movement, 0)?;
        d.dest_row = np.row;
        d.dest_col = np.col;
        if let Some(t) = self.best_enemy_within(np, self.attrs.range, true)? {
            d.action = ActionType::Shoot;
            d.target = t;
        }
        Ok(d)
    }

    fn stand_tile(&self, target: Pos, range: u8) -> Result<Stand> {
        let enemy = self.creator_live;
        let mut s = Stand::default();
        let r = range as i16;
        for dr in -r..=r {
            let rem = r - dr.abs();
            for dc in -rem..=rem {
                let t = Pos { row: target.row + dr, col: target.col + dc };
                if !in_bounds(t.row, t.col) {
                    continue;
                }
                let dist = manhattan(self.pos, t);
                if dist > self.attrs.movement as u16 || !self.reachable(t, enemy)? {
                    continue;
                }
                let scoring = self.is_scoring(t);
                if !s.found || (scoring && !s.scoring) || (scoring == s.scoring && dist < s.dist) {
                    s = Stand { pos: t, found: true, scoring, dist };
                }
            }
        }
        Ok(s)
    }

    fn ram_on_scoring_tile(&self, ram_range: u8) -> Result<Option<Decision>> {
        let mut best: Option<(Decision, u16)> = None;
        for sp in self.enemies() {
            if sp.a.hull_points != 0 || !self.is_scoring(sp.pos) {
                continue;
            }
            let d = manhattan(self.pos, sp.pos);
            if best.is_some_and(|b| d >= b.1) {
                continue;
            }
            let s = self.stand_tile(sp.pos, ram_range)?;
            if !s.found {
                continue;
            }
            best = Some((decision(s.pos, ActionType::FactionAbility, sp.id), d));
        }
        Ok(best.map(|b| b.0))
    }

    fn claim_scoring_tile(&self) -> Result<(Pos, bool)> {
        if self.is_scoring(self.pos) {
            return Ok((self.pos, true));
        }
        match self.best_scoring_tile() {
            Some(tile) if !self.occupied_by_other(tile) => Ok((self.step_toward_reachable(tile, self.attrs.movement, 0)?, true)),
            _ => Ok((self.pos, false)),
        }
    }

    fn nearest_tile_holder(&self) -> Option<Pos> {
        self.nearest_enemy_on_tile()
    }

    /// AIBehavior.advanceToward.
    fn advance_toward(&self, target: Pos, max_steps: u8) -> Result<Pos> {
        self.step_toward_reachable(target, max_steps, 1)
    }

    /// AIBehavior.isDisabled.
    fn is_disabled(&self, id: u64) -> bool {
        self.view.iter().find(|s| s.id == id).is_some_and(|s| s.a.hull_points == 0)
    }

    /// AIBehavior.healIsUrgent.
    fn heal_is_urgent(&self, ally_id: u64) -> Result<bool> {
        let Some(me) = self.view.iter().find(|s| s.id == ally_id) else { return Ok(false) };
        let (at, ally) = (me.pos, &me.a);
        if ally.hull_points == 0 {
            return Ok(true);
        }
        for e in self.enemies() {
            if e.a.hull_points == 0 {
                continue;
            }
            if manhattan(e.pos, at) > e.a.range as u16 + e.a.movement as u16 {
                continue;
            }
            if shot_damage(e.a.gun_damage, ally.damage_reduction)? >= ally.hull_points as u64 {
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// AIBehavior._healCandidate.
    fn heal_candidate(&self, sp: &ViewShip, from: Pos, range: u8, f: HealFilter) -> Result<Option<Pos>> {
        if sp.status != 0 || sp.is_creator {
            return Ok(None);
        }
        let is_self = sp.id == self.ship_id;
        if is_self && !f.include_self {
            return Ok(None);
        }
        let a = &sp.a;
        if a.hull_points >= a.max_hull_points {
            return Ok(None);
        }
        if f.disabled_only && a.hull_points != 0 {
            return Ok(None);
        }
        if f.scoring_only && !self.is_scoring(sp.pos) {
            return Ok(None);
        }
        if f.can_move {
            let s = self.stand_tile(sp.pos, range)?;
            return Ok(s.found.then_some(s.pos));
        }
        if !is_self && manhattan(from, sp.pos) > range as u16 {
            return Ok(None);
        }
        Ok(Some(from))
    }

    /// AIBehavior._planHeal: most urgent ally (disabled first, then lowest HP).
    fn plan_heal(&self, from: Pos, range: u8, f: HealFilter) -> Result<Option<(u64, Pos)>> {
        let mut best: Option<(u64, Pos, u8, bool)> = None;
        for sp in &self.view {
            let Some(at) = self.heal_candidate(sp, from, range, f)? else { continue };
            let hp = sp.a.hull_points;
            let disabled = hp == 0;
            if let Some((_, _, bh, bd)) = best {
                if !((disabled && !bd) || (disabled == bd && hp < bh)) {
                    continue;
                }
            }
            best = Some((sp.id, at, hp, disabled));
        }
        Ok(best.map(|b| (b.0, b.1)))
    }

    fn heal_decision(&self, from: Pos, range: u8, action: ActionType, f: HealFilter) -> Result<Option<Decision>> {
        Ok(self.plan_heal(from, range, f)?.map(|(id, stand)| decision(stand, action, id)))
    }
}

#[derive(Clone, Copy)]
struct HealFilter {
    scoring_only: bool,
    disabled_only: bool,
    include_self: bool,
    can_move: bool,
}

impl Ctx<'_> {
    fn heal_on_scoring_tile(&self, range: u8, action: ActionType) -> Result<Option<Decision>> {
        self.heal_decision(self.pos, range, action, HealFilter { scoring_only: true, disabled_only: false, include_self: false, can_move: true })
    }
    fn heal_disabled_from(&self, from: Pos, range: u8, action: ActionType) -> Result<Option<Decision>> {
        self.heal_decision(from, range, action, HealFilter { scoring_only: false, disabled_only: true, include_self: false, can_move: false })
    }
    fn heal_disabled_with_reach(&self, range: u8, action: ActionType) -> Result<Option<Decision>> {
        self.heal_decision(self.pos, range, action, HealFilter { scoring_only: false, disabled_only: true, include_self: false, can_move: true })
    }
    fn heal_any_from(&self, from: Pos, range: u8, action: ActionType) -> Result<Option<Decision>> {
        self.heal_decision(from, range, action, HealFilter { scoring_only: false, disabled_only: false, include_self: true, can_move: false })
    }

    fn can_shoot(&self, from: Pos, target: Pos) -> Result<bool> {
        self.can_shoot_from(from, target, self.creator_live)
    }
}

// ------------------------------------------------------------ Variant1AI

const V1_EMP: Special = Special::Slot1;
const V1_HEAL: Special = Special::Slot2;
const V1_FLAK: Special = Special::Slot3;

struct V1<'a, 'b> {
    ctx: &'b Ctx<'a>,
    rules: &'b dyn Rules,
    special: Special,
}

impl V1<'_, '_> {
    fn special_range(&self, slot: Special) -> Result<u8> {
        Ok(self.rules.special_data_at(1, self.ctx.attrs.version, slot)?.range)
    }

    fn ram_range(&self) -> Result<u8> {
        match self.rules.faction_resolver(1) {
            Some(Resolver::Ram { range }) => Ok(range),
            _ => Err(Error::InvalidMove), // ramAbility unset: the call reverts
        }
    }

    fn decide(&self, archetype: Archetype) -> Result<Decision> {
        let ctx = self.ctx;
        if ctx.attrs.reactor_critical_timer <= 1 {
            if let Some(r) = ctx.ram_on_scoring_tile(self.ram_range()?)? {
                return Ok(r);
            }
        }
        if let Some(e) = ctx.low_hp_evade()? {
            return Ok(e);
        }
        match archetype {
            Archetype::Support => self.support(),
            Archetype::Turtle => self.turtle(),
            Archetype::Rammer => self.rammer(),
            Archetype::Runner => self.runner(),
            Archetype::Hunter => self.hunter(),
            Archetype::Sniper => self.skirmish(true, true),
            Archetype::Aggressor => self.skirmish(false, false),
            Archetype::Grunt => self.claim_or_skirmish(),
        }
    }

    fn claim_or_skirmish(&self) -> Result<Decision> {
        let (stand, objective) = self.ctx.claim_scoring_tile()?;
        if objective {
            return self.fight_from(stand);
        }
        self.skirmish(true, false)
    }

    fn fight_from(&self, dest: Pos) -> Result<Decision> {
        if let Some(d) = self.special_from(dest)? {
            return Ok(d);
        }
        if let Some(t) = self.ctx.best_enemy_within(dest, self.ctx.attrs.range, true)? {
            return Ok(decision(dest, ActionType::Shoot, t));
        }
        Ok(decision(dest, ActionType::Pass, 0))
    }

    fn skirmish(&self, retreat: bool, leave_tiles: bool) -> Result<Decision> {
        let ctx = self.ctx;
        let Some(enemy_pos) = ctx.nearest_enemy() else { return ctx.idle_or_seek_tile() };
        if !leave_tiles && ctx.on_scoring_tile() && ctx.should_hold_scoring_tile()? {
            return self.fight_from(ctx.pos);
        }
        let kite = retreat && (leave_tiles || !ctx.on_scoring_tile());
        let stand = ctx.standoff_position(enemy_pos, kite)?;
        if let Some(d) = self.special_from(stand)? {
            return Ok(d);
        }
        if kite && !ctx.on_scoring_tile() {
            if let Some((safe, t)) = ctx.shot_within_reach(true)? {
                return Ok(decision(safe, ActionType::Shoot, t));
            }
        }
        if let Some(t) = ctx.best_enemy_within(stand, ctx.attrs.range, true)? {
            return Ok(decision(stand, ActionType::Shoot, t));
        }
        if ctx.on_scoring_tile() && ctx.should_hold_scoring_tile()? {
            return Ok(ctx.hold());
        }
        if let Some((p, t)) = ctx.shot_within_reach(false)? {
            return Ok(decision(p, ActionType::Shoot, t));
        }
        ctx.approach_or_seek_tile(enemy_pos, true)
    }

    fn support(&self) -> Result<Decision> {
        if self.special == V1_HEAL {
            let r = self.special_range(V1_HEAL)?;
            if let Some(d) = self.ctx.heal_with_reach(r, ActionType::Special)? {
                return Ok(d);
            }
        }
        let (stand, objective) = self.ctx.claim_scoring_tile()?;
        if objective {
            return self.fight_from(stand);
        }
        self.ctx.decide_support_fallback()
    }

    fn turtle(&self) -> Result<Decision> {
        if let Some(d) = self.special_from(self.ctx.pos)? {
            return Ok(d);
        }
        self.ctx.decide_turtle()
    }

    fn rammer(&self) -> Result<Decision> {
        let ctx = self.ctx;
        if ctx.attrs.reactor_critical_timer <= 1 {
            if let Some((victim, victim_pos)) = ctx.nearest_downed_enemy() {
                let ram_range = self.ram_range()?;
                let reach = ram_range as u16 + ctx.attrs.movement as u16;
                if manhattan(ctx.pos, victim_pos) <= reach {
                    if let Some(dest) = ctx.reach_within(victim_pos, ram_range)? {
                        return Ok(decision(dest, ActionType::FactionAbility, victim));
                    }
                }
            }
        }
        self.claim_or_skirmish()
    }

    fn runner(&self) -> Result<Decision> {
        let ctx = self.ctx;
        let (mut stand, objective) = ctx.claim_scoring_tile()?;
        if !objective {
            let Some(holder) = ctx.nearest_tile_holder() else { return self.skirmish(true, false) };
            stand = ctx.within_range_of(holder, ctx.attrs.range)?;
        }
        if let Some(d) = self.special_from(stand)? {
            return Ok(d);
        }
        if let Some(t) = ctx.holder_first_within(stand)? {
            return Ok(decision(stand, ActionType::Shoot, t));
        }
        Ok(decision(stand, ActionType::Pass, 0))
    }

    fn hunter(&self) -> Result<Decision> {
        let ctx = self.ctx;
        let Some((quarry, at)) = ctx.hunt_target()? else { return ctx.idle_or_seek_tile() };
        let dest = ctx.within_range_of(at, ctx.attrs.range)?;
        if let Some(d) = self.special_from(dest)? {
            return Ok(d);
        }
        if ctx.can_shoot(dest, at)? {
            return Ok(decision(dest, ActionType::Shoot, quarry));
        }
        self.fight_from(dest)
    }

    fn special_from(&self, from: Pos) -> Result<Option<Decision>> {
        let ctx = self.ctx;
        if self.special == V1_FLAK {
            let r = self.special_range(V1_FLAK)?;
            let s = ctx.sweep(from, r);
            if s.allies == 0 && s.enemies > 0 {
                let worth = s.enemies >= 2 || ctx.best_enemy_within(from, ctx.attrs.range, true)?.is_none();
                if worth {
                    return Ok(Some(decision(from, ActionType::Special, 0)));
                }
            }
        } else if self.special == V1_EMP {
            let r = self.special_range(V1_EMP)?;
            if let Some(doomed) = ctx.doomed_enemy_within(from, r) {
                return Ok(Some(decision(from, ActionType::Special, doomed)));
            }
        }
        Ok(None)
    }
}

// ------------------------------------------------------------ Variant2AI

const V2_STORM: Special = Special::Slot1;
const V2_SWARM: Special = Special::Slot2;

struct V2<'a, 'b> {
    ctx: &'b Ctx<'a>,
    rules: &'b dyn Rules,
    special: Special,
    heal_range: u8,
}

impl V2<'_, '_> {
    fn special_range(&self, slot: Special) -> Result<u8> {
        Ok(self.rules.special_data_at(2, self.ctx.attrs.version, slot)?.range)
    }

    fn decide(&self, archetype: Archetype) -> Result<Decision> {
        let ctx = self.ctx;
        let hr = self.heal_range;
        let on_tile_heal = ctx.heal_on_scoring_tile(hr, ActionType::FactionAbility)?;
        if let Some(h) = on_tile_heal {
            if ctx.heal_is_urgent(h.target)? {
                return Ok(h);
            }
        }
        if let Some(d) = ctx.low_hp_evade()? {
            return if d.action == ActionType::Pass { self.repair_from(d) } else { Ok(d) };
        }
        let d = self.claim_or_fight(archetype)?;
        if let Some(h) = on_tile_heal {
            if d.action == ActionType::Pass || ctx.is_disabled(d.target) {
                return Ok(h);
            }
        }
        if d.action != ActionType::Pass {
            return Ok(d);
        }
        self.repair_from(d)
    }

    fn repair_from(&self, d: Decision) -> Result<Decision> {
        let from = Pos { row: d.dest_row, col: d.dest_col };
        Ok(self.ctx.heal_any_from(from, self.heal_range, ActionType::FactionAbility)?.unwrap_or(d))
    }

    fn claim_or_fight(&self, archetype: Archetype) -> Result<Decision> {
        let ctx = self.ctx;
        let (stand, objective) = if archetype == Archetype::Hunter { (ctx.pos, false) } else { ctx.claim_scoring_tile()? };
        if objective {
            if let Some(d) = ctx.heal_disabled_from(stand, self.heal_range, ActionType::FactionAbility)? {
                return Ok(d);
            }
            return self.fight_from(stand);
        }
        if let Some(d) = ctx.heal_disabled_with_reach(self.heal_range, ActionType::FactionAbility)? {
            return Ok(d);
        }
        match archetype {
            Archetype::Support => self.support(),
            Archetype::Turtle => self.turtle(),
            Archetype::Runner => self.runner(),
            Archetype::Hunter => self.hunter(),
            Archetype::Sniper => self.fire_support(),
            a => self.brawl(a != Archetype::Aggressor),
        }
    }

    fn brawl(&self, hold_tiles: bool) -> Result<Decision> {
        let ctx = self.ctx;
        let Some(enemy_pos) = ctx.nearest_enemy() else { return ctx.idle_or_seek_tile() };
        if let Some(d) = self.storm_from(ctx.pos)? {
            return Ok(d);
        }
        if let Some(t) = ctx.best_enemy_within(ctx.pos, ctx.attrs.range, true)? {
            return Ok(decision(ctx.pos, ActionType::Shoot, t));
        }
        if hold_tiles && ctx.on_scoring_tile() && ctx.should_hold_scoring_tile()? {
            return Ok(ctx.hold());
        }
        if let Some((p, t)) = ctx.shot_within_reach(false)? {
            return Ok(decision(p, ActionType::Shoot, t));
        }
        let dest = ctx.advance_toward(enemy_pos, ctx.attrs.movement)?;
        self.fight_from(dest)
    }

    fn fire_support(&self) -> Result<Decision> {
        let ctx = self.ctx;
        let Some(enemy_pos) = ctx.nearest_enemy() else { return ctx.idle_or_seek_tile() };
        let stand = ctx.standoff_position(enemy_pos, false)?;
        if let Some(d) = self.storm_from(stand)? {
            return Ok(d);
        }
        if let Some(t) = ctx.best_enemy_within(stand, ctx.attrs.range, true)? {
            return Ok(decision(stand, ActionType::Shoot, t));
        }
        if let Some(d) = self.swarm_from(stand)? {
            return Ok(d);
        }
        if ctx.on_scoring_tile() && ctx.should_hold_scoring_tile()? {
            return Ok(ctx.hold());
        }
        if let Some((p, t)) = ctx.shot_within_reach(false)? {
            return Ok(decision(p, ActionType::Shoot, t));
        }
        ctx.approach_or_seek_tile(enemy_pos, true)
    }

    fn support(&self) -> Result<Decision> {
        let ctx = self.ctx;
        if let Some(d) = self.storm_from(ctx.pos)? {
            return Ok(d);
        }
        if let Some(t) = ctx.best_enemy_within(ctx.pos, ctx.attrs.range, true)? {
            return Ok(decision(ctx.pos, ActionType::Shoot, t));
        }
        if let Some(d) = ctx.heal_with_reach(self.heal_range, ActionType::FactionAbility)? {
            return Ok(d);
        }
        ctx.decide_support_fallback()
    }

    fn turtle(&self) -> Result<Decision> {
        let ctx = self.ctx;
        if let Some(d) = self.storm_from(ctx.pos)? {
            return Ok(d);
        }
        if ctx.best_enemy_within(ctx.pos, ctx.attrs.range, true)?.is_none() {
            if let Some(d) = self.swarm_from(ctx.pos)? {
                return Ok(d);
            }
        }
        ctx.decide_turtle()
    }

    fn runner(&self) -> Result<Decision> {
        let ctx = self.ctx;
        let Some(holder) = ctx.nearest_tile_holder() else { return self.brawl(true) };
        let dest = ctx.within_range_of(holder, ctx.attrs.range)?;
        if let Some(d) = self.storm_from(dest)? {
            return Ok(d);
        }
        if let Some(t) = ctx.holder_first_within(dest)? {
            return Ok(decision(dest, ActionType::Shoot, t));
        }
        if let Some(d) = self.swarm_from(dest)? {
            return Ok(d);
        }
        Ok(decision(dest, ActionType::Pass, 0))
    }

    fn hunter(&self) -> Result<Decision> {
        let ctx = self.ctx;
        let Some((quarry, at)) = ctx.hunt_target()? else { return ctx.idle_or_seek_tile() };
        let dest = ctx.within_range_of(at, ctx.attrs.range)?;
        if let Some(d) = self.storm_from(dest)? {
            return Ok(d);
        }
        if ctx.can_shoot(dest, at)? {
            return Ok(decision(dest, ActionType::Shoot, quarry));
        }
        self.fight_from(dest)
    }

    fn fight_from(&self, dest: Pos) -> Result<Decision> {
        let ctx = self.ctx;
        if let Some(d) = self.storm_from(dest)? {
            return Ok(d);
        }
        if let Some(t) = ctx.best_enemy_within(dest, ctx.attrs.range, true)? {
            return Ok(decision(dest, ActionType::Shoot, t));
        }
        if let Some(d) = self.swarm_from(dest)? {
            return Ok(d);
        }
        Ok(decision(dest, ActionType::Pass, 0))
    }

    fn swarm_from(&self, from: Pos) -> Result<Option<Decision>> {
        if self.special != V2_SWARM {
            return Ok(None);
        }
        let r = self.special_range(V2_SWARM)?;
        Ok(self.ctx.best_enemy_within(from, r, false)?.map(|t| decision(from, ActionType::Special, t)))
    }

    fn storm_from(&self, from: Pos) -> Result<Option<Decision>> {
        let ctx = self.ctx;
        if self.special != V2_STORM || ctx.attrs.reactor_critical_timer >= 2 {
            return Ok(None);
        }
        let r = self.special_range(V2_STORM)?;
        let s = ctx.sweep(from, r);
        if s.finishable_enemies == 0 || s.allies_at_risk != 0 || s.allies > s.finishable_enemies {
            return Ok(None);
        }
        let worth = s.finishable_enemies >= 2 || ctx.best_enemy_within(from, ctx.attrs.range, true)?.is_none();
        Ok(worth.then(|| decision(from, ActionType::Special, 0)))
    }
}

/// IVariantAI.decide for `ship_id` (an AI ship on the joiner side).
pub fn decide(g: &GameState, rules: &dyn Rules, ship_id: u64, info: &AiShipInfo) -> Result<Decision> {
    let ctx = Ctx::load(g, ship_id)?;
    match info.variant {
        1 => V1 { ctx: &ctx, rules, special: info.special }.decide(info.archetype),
        2 => {
            let heal_range = match rules.faction_resolver(2) {
                Some(Resolver::Repair { range, .. }) => range,
                _ => return Err(Error::InvalidMove), // healAbility unset: reverts
            };
            V2 { ctx: &ctx, rules, special: info.special, heal_range }.decide(info.archetype)
        }
        // No AI registered for the variant: SinglePlayerMatch's
        // code.length == 0 path (decision fails, ship passes).
        _ => Err(Error::InvalidMove),
    }
}

// ------------------------------------------------------------- the driver

/// AIBehavior._pickShip: which AI ship moves next. Ranks: 4 = can kill an
/// enemy it can reach by range, 3 = an enemy in range, 2 = none, 1 = Support
/// archetype. First ship with the strictly best rank wins.
pub fn pick_ship(g: &GameState, is_support: &dyn Fn(u64) -> bool) -> Result<Option<u64>> {
    let board = Bitmap::board_mask();
    let creator_live = g.live[0];
    let mut enemies: Vec<(usize, u8, u8)> = Vec::new(); // (cell, hp, dr)
    let mut best = 0u32;
    let mut pick = None;
    for &id in g.creator_active.iter().chain(g.joiner_active.iter()) {
        let b = g.ship(id);
        if b.hull_points == 0 {
            continue;
        }
        if b.is_creator {
            enemies.push((bit_index(b.row, b.col), b.hull_points, b.damage_reduction));
            continue;
        }
        if (b.moved_in_round & 0xFF_FFFF) == (g.current_round & 0xFF_FFFF) {
            continue;
        }
        let in_range = dilate(Bitmap::cell(b.row, b.col), b.range as u32, board) & creator_live;
        let mut rank = if in_range.is_empty() {
            2
        } else {
            let mut kill = Bitmap::EMPTY;
            for &(cell, hp, dr) in &enemies {
                if shot_damage(b.gun_damage, dr)? >= hp as u64 {
                    kill.set(cell);
                }
            }
            if (in_range & kill).is_empty() { 3 } else { 4 }
        };
        if rank <= best {
            continue;
        }
        if is_support(id) {
            rank = 1;
        }
        if rank <= best {
            continue;
        }
        best = rank;
        pick = Some(id);
        if rank == 4 {
            break;
        }
    }
    Ok(pick)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AiLog {
    DecisionFailed { ship_id: u64 },
    TurnTaken { ship_id: u64, action: ActionType, target: u64 },
}

#[derive(Default, Debug)]
pub struct AiTurnsResult {
    pub moves: u32,
    pub logs: Vec<AiLog>,
    pub events: Vec<EngineEvent>,
}

/// SinglePlayerMatch.takeAITurn / takeAITurns. `strict` applies to the first
/// iteration only (GameEnded / NotAITurn errors), as in Solidity.
pub fn take_ai_turns(
    g: &mut GameState,
    rules: &dyn Rules,
    info: &dyn Fn(u64) -> Option<AiShipInfo>,
    max_moves: u32,
    now: u64,
) -> core::result::Result<AiTurnsResult, &'static str> {
    let mut out = AiTurnsResult::default();
    for i in 0..max_moves {
        let strict = i == 0;
        if g.ended {
            if strict {
                return Err("GameEnded");
            }
            break;
        }
        if g.current_turn != Side::Joiner {
            if strict {
                return Err("NotAITurn");
            }
            break;
        }
        if !g.side_has_live_ships(Side::Joiner) {
            // AI has nothing left that can act: concede to the human.
            if let Ok(ev) = g.force_end(Some(Side::Creator)) {
                out.events.extend(ev);
            }
            break;
        }
        let is_support = |id: u64| info(id).is_some_and(|x| x.archetype == Archetype::Support);
        let Some(ship_id) = pick_ship(g, &is_support).map_err(|e| e.name())? else { break };
        let b = g.ship(ship_id);
        let (row, col) = (b.row, b.col);

        let decided = info(ship_id).ok_or(Error::InvalidMove).and_then(|inf| decide(g, rules, ship_id, &inf));
        let d = match decided {
            Ok(d) => d,
            Err(_) => {
                out.logs.push(AiLog::DecisionFailed { ship_id });
                Decision { dest_row: row, dest_col: col, action: ActionType::Pass, target: 0 }
            }
        };

        // try { moveShip(decision) } catch { try { moveShip(pass in place) } catch {} }
        let attempt = |g: &mut GameState, m: MoveInput| -> Option<Vec<EngineEvent>> {
            let snapshot = g.clone();
            match g.move_ship(Side::Joiner, &m, rules, now) {
                Ok(ev) => Some(ev),
                Err(_) => {
                    *g = snapshot;
                    None
                }
            }
        };
        let primary = MoveInput { ship_id, new_row: d.dest_row, new_col: d.dest_col, action: d.action, target_ship_id: d.target };
        if let Some(ev) = attempt(g, primary) {
            out.events.extend(ev);
            out.logs.push(AiLog::TurnTaken { ship_id, action: d.action, target: d.target });
        } else {
            let pass = MoveInput { ship_id, new_row: row, new_col: col, action: ActionType::Pass, target_ship_id: 0 };
            match attempt(g, pass) {
                Some(ev) => {
                    out.events.extend(ev);
                    out.logs.push(AiLog::TurnTaken { ship_id, action: ActionType::Pass, target: 0 });
                }
                None => break,
            }
        }
        out.moves += 1;
    }
    Ok(out)
}

//! Terrain, line of sight, movement paths, scoring tiles and deployment zones
//! (Maps.sol). A game carries its own copy of the terrain and scoring list
//! (`GameMap`), so the engine never reads shared map storage mid-game.

use borsh::{BorshDeserialize, BorshSerialize};
use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::grid::{bit_index, in_bounds, Bitmap};
use crate::types::{MapMode, Position, ScoringPosition};

/// Default deployment column bands when a map has no custom zone.
pub const DEFAULT_CREATOR_MIN_COL: i16 = 0;
pub const DEFAULT_CREATOR_MAX_COL: i16 = 3;
pub const DEFAULT_JOINER_MIN_COL: i16 = 13;
pub const DEFAULT_JOINER_MAX_COL: i16 = 16;

/// A preset map as created by a map editor.
#[derive(Clone, Debug, Default, PartialEq, Eq, BorshSerialize, BorshDeserialize, Serialize, Deserialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(schemars::JsonSchema, borsh::BorshSchema))]
pub struct PresetMap {
    pub mode: MapMode,
    /// LOS-blocking ("blocked") cells.
    pub blocked: Bitmap,
    /// Movement-blocking cells.
    pub impassable: Bitmap,
    /// Empty = default column band.
    pub creator_zone: Bitmap,
    pub joiner_zone: Bitmap,
    /// Scoring tiles in first-insertion order (EnumerableSet order); a repeated
    /// cell overwrites points/onlyOnce in place.
    pub scoring: Vec<ScoringPosition>,
}

fn bitmap_from(positions: &[Position]) -> Result<Bitmap> {
    let mut b = Bitmap::EMPTY;
    for p in positions {
        if !in_bounds(p.row, p.col) {
            return Err(Error::InvalidPosition);
        }
        b.set(bit_index(p.row, p.col));
    }
    Ok(b)
}

impl PresetMap {
    /// Maps._createPresetMapInternal.
    pub fn new(
        blocked: &[Position],
        impassable: &[Position],
        scoring: &[ScoringPosition],
        mode: MapMode,
    ) -> Result<PresetMap> {
        let mut m = PresetMap { mode, blocked: bitmap_from(blocked)?, impassable: bitmap_from(impassable)?, ..Default::default() };
        for s in scoring {
            if !in_bounds(s.row, s.col) {
                return Err(Error::InvalidPosition);
            }
            match m.scoring.iter_mut().find(|e| e.row == s.row && e.col == s.col) {
                Some(e) => {
                    e.points = s.points;
                    e.only_once = s.only_once;
                }
                None => m.scoring.push(s.clone()),
            }
        }
        Ok(m)
    }

    pub fn set_creator_zone(&mut self, tiles: &[Position]) -> Result<()> {
        self.creator_zone = bitmap_from(tiles)?;
        Ok(())
    }
    pub fn set_joiner_zone(&mut self, tiles: &[Position]) -> Result<()> {
        self.joiner_zone = bitmap_from(tiles)?;
        Ok(())
    }

    /// Maps.isValidDeploymentTile.
    pub fn is_valid_deployment_tile(&self, row: i16, col: i16, is_creator: bool) -> bool {
        if !in_bounds(row, col) {
            return false;
        }
        let zone = if is_creator { self.creator_zone } else { self.joiner_zone };
        if !zone.is_empty() {
            return zone.has_cell(row, col);
        }
        if is_creator {
            (DEFAULT_CREATOR_MIN_COL..=DEFAULT_CREATOR_MAX_COL).contains(&col)
        } else {
            (DEFAULT_JOINER_MIN_COL..=DEFAULT_JOINER_MAX_COL).contains(&col)
        }
    }
}

/// Per-game terrain and scoring, copied from a preset at game start.
#[derive(Clone, Debug, Default, PartialEq, Eq, BorshSerialize, BorshDeserialize, Serialize, Deserialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(schemars::JsonSchema, borsh::BorshSchema))]
pub struct GameMap {
    pub blocked: Bitmap,
    pub impassable: Bitmap,
    /// Maps.gameScoring: entries keep their slot when points drop to 0.
    pub scoring: Vec<ScoringPosition>,
}

impl GameMap {
    /// Maps.applyPresetMapToGame (+ _setGameScoring for each preset tile).
    pub fn from_preset(p: &PresetMap) -> GameMap {
        let mut g = GameMap { blocked: p.blocked, impassable: p.impassable, scoring: Vec::new() };
        for s in &p.scoring {
            g.set_scoring(s.row, s.col, s.points, s.only_once, false);
        }
        g
    }

    fn find(&self, row: i16, col: i16) -> Option<usize> {
        if !in_bounds(row, col) {
            return None;
        }
        self.scoring.iter().position(|e| e.row == row && e.col == col)
    }

    /// Maps._setGameScoring.
    pub fn set_scoring(&mut self, row: i16, col: i16, points: u8, only_once: bool, keep_only_once: bool) {
        match self.find(row, col) {
            None => {
                if points == 0 {
                    return;
                }
                let only_once = if keep_only_once { false } else { only_once };
                self.scoring.push(ScoringPosition { row, col, points, only_once });
            }
            Some(i) => {
                let e = &mut self.scoring[i];
                if !keep_only_once {
                    e.only_once = only_once;
                }
                e.points = points;
            }
        }
    }

    /// Maps.getScoreAndZeroOut.
    pub fn score_and_zero_out(&mut self, row: i16, col: i16) -> u8 {
        let Some(i) = self.find(row, col) else { return 0 };
        let e = &mut self.scoring[i];
        let points = e.points;
        if points != 0 && e.only_once {
            e.points = 0;
        }
        points
    }

    /// Maps._getGameScoringPositions (live tiles only, list order).
    pub fn scoring_positions(&self) -> Vec<ScoringPosition> {
        self.scoring.iter().filter(|e| e.points != 0).cloned().collect()
    }

    pub fn tile_points(&self, row: i16, col: i16) -> u8 {
        self.find(row, col).map(|i| self.scoring[i].points).unwrap_or(0)
    }

    /// Maps.hasMaps (terrain-only LOS).
    pub fn has_los(&self, r0: i16, c0: i16, r1: i16, c1: i16) -> Result<bool> {
        los(self.blocked, r0, c0, r1, c1)
    }

    /// Maps.hasMapsAvoidingShips: caller must exclude the target's own tile
    /// from `enemy`.
    pub fn has_los_avoiding(&self, r0: i16, c0: i16, r1: i16, c1: i16, enemy: Bitmap) -> Result<bool> {
        los(self.blocked | enemy, r0, c0, r1, c1)
    }

    /// Maps.hasMovementPath.
    pub fn has_movement_path(&self, r0: i16, c0: i16, r1: i16, c1: i16) -> Result<bool> {
        movement_path(self.impassable, r0, c0, r1, c1)
    }

    /// Maps.hasMovementPathAvoidingShips.
    pub fn has_movement_path_avoiding(&self, r0: i16, c0: i16, r1: i16, c1: i16, enemy: Bitmap) -> Result<bool> {
        movement_path(self.impassable | enemy, r0, c0, r1, c1)
    }
}

fn check_bounds(r0: i16, c0: i16, r1: i16, c1: i16) -> Result<()> {
    if in_bounds(r0, c0) && in_bounds(r1, c1) { Ok(()) } else { Err(Error::InvalidPosition) }
}

fn los(bitmap: Bitmap, r0: i16, c0: i16, r1: i16, c1: i16) -> Result<bool> {
    check_bounds(r0, c0, r1, c1)?;
    if blocked_safe(bitmap, r0, c0) {
        return Ok(false);
    }
    if r0 == r1 && c0 == c1 {
        return Ok(!blocked_safe(bitmap, r1, c1));
    }
    Ok(bresenham(bitmap, r0, c0, r1, c1))
}

fn movement_path(bitmap: Bitmap, r0: i16, c0: i16, r1: i16, c1: i16) -> Result<bool> {
    check_bounds(r0, c0, r1, c1)?;
    if r0 == r1 && c0 == c1 {
        return Ok(true);
    }
    Ok(bresenham(bitmap, r0, c0, r1, c1))
}

/// Maps._isTileBlockedSafe: out of bounds counts as blocked.
#[inline]
pub fn blocked_safe(bitmap: Bitmap, row: i16, col: i16) -> bool {
    !in_bounds(row, col) || bitmap.has_cell(row, col)
}

/// Maps._bresenhamMaps: permissive corners (a diagonal step is blocked only
/// when BOTH flanking cells are blocked); start cell not checked; the
/// destination's own blocked state decides the final answer.
pub fn bresenham(bitmap: Bitmap, r0: i16, c0: i16, r1: i16, c1: i16) -> bool {
    let d_row = (r1 - r0).abs();
    let d_col = (c1 - c0).abs();
    let s_row = (r1 - r0).signum();
    let s_col = (c1 - c0).signum();
    let mut err = d_col - d_row;
    let (mut row, mut col) = (r0, c0);
    loop {
        if row == r1 && col == c1 {
            return !blocked_safe(bitmap, row, col);
        }
        let e2 = err << 1;
        if e2 == 0 {
            if blocked_safe(bitmap, row, col + s_col) && blocked_safe(bitmap, row + s_row, col) {
                return false;
            }
            col += s_col;
            err -= d_row;
            row += s_row;
            err += d_col;
            if (row != r1 || col != c1) && blocked_safe(bitmap, row, col) {
                return false;
            }
            continue;
        }
        if e2 > -d_row {
            err -= d_row;
            col += s_col;
            if (row != r1 || col != c1) && blocked_safe(bitmap, row, col) {
                return false;
            }
        }
        if e2 < d_col {
            err += d_col;
            row += s_row;
            if (row != r1 || col != c1) && blocked_safe(bitmap, row, col) {
                return false;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pos(row: i16, col: i16) -> Position {
        Position { row, col }
    }

    #[test]
    fn straight_line_blocked_by_middle_tile() {
        let m = GameMap { blocked: Bitmap::cell(5, 5), ..Default::default() };
        assert!(!m.has_los(5, 3, 5, 7).unwrap());
        assert!(m.has_los(4, 3, 4, 7).unwrap());
    }

    #[test]
    fn permissive_corner_needs_both_flankers() {
        // Pure diagonal step from (0,0) to (1,1): flankers (0,1) and (1,0).
        let one = GameMap { blocked: Bitmap::cell(0, 1), ..Default::default() };
        assert!(one.has_los(0, 0, 1, 1).unwrap());
        let both = GameMap { blocked: Bitmap::cell(0, 1) | Bitmap::cell(1, 0), ..Default::default() };
        assert!(!both.has_los(0, 0, 1, 1).unwrap());
    }

    #[test]
    fn blocked_start_or_destination_denies_los_but_start_ok_for_movement() {
        let m = GameMap { blocked: Bitmap::cell(2, 2), impassable: Bitmap::cell(2, 2), ..Default::default() };
        assert!(!m.has_los(2, 2, 2, 5).unwrap());
        assert!(!m.has_los(2, 5, 2, 2).unwrap());
        assert!(m.has_movement_path(2, 2, 2, 5).unwrap());
        assert!(!m.has_movement_path(2, 5, 2, 2).unwrap());
    }

    #[test]
    fn out_of_bounds_is_invalid_position() {
        let m = GameMap::default();
        assert_eq!(m.has_los(-1, 0, 0, 0), Err(Error::InvalidPosition));
        assert_eq!(m.has_movement_path(0, 0, 11, 0), Err(Error::InvalidPosition));
    }

    #[test]
    fn only_once_tiles_zero_out_after_scoring() {
        let p = PresetMap::new(
            &[],
            &[],
            &[
                ScoringPosition { row: 1, col: 1, points: 3, only_once: true },
                ScoringPosition { row: 2, col: 2, points: 1, only_once: false },
            ],
            MapMode::Both,
        )
        .unwrap();
        let mut g = GameMap::from_preset(&p);
        assert_eq!(g.score_and_zero_out(1, 1), 3);
        assert_eq!(g.score_and_zero_out(1, 1), 0);
        assert_eq!(g.score_and_zero_out(2, 2), 1);
        assert_eq!(g.score_and_zero_out(2, 2), 1);
        assert_eq!(g.scoring_positions().len(), 1);
    }

    #[test]
    fn deployment_zone_default_and_custom() {
        let mut p = PresetMap::default();
        assert!(p.is_valid_deployment_tile(4, 3, true));
        assert!(!p.is_valid_deployment_tile(4, 4, true));
        assert!(p.is_valid_deployment_tile(4, 13, false));
        p.set_creator_zone(&[pos(0, 8)]).unwrap();
        assert!(p.is_valid_deployment_tile(0, 8, true));
        assert!(!p.is_valid_deployment_tile(4, 3, true));
    }
}

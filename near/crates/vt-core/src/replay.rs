//! Compact boards for replay indexers (2026-11-14).
//!
//! NEAR RPC can't search logs or serve past state, so every event that
//! changes a game carries the whole board in this compact form. An indexer
//! that stores the events has a complete replay: each board stands alone, so
//! a missed or reordered event never corrupts later frames.
//!
//! Sizing: ~25-30 bytes of JSON per ship, so the largest seeded board (22
//! ships) is ~0.7 KB. `take_ai_turns(8)` emits up to 8 of them, well inside
//! NEAR's 16 KB per-receipt log cap (asserted in the sandbox gas test).

use serde::{Deserialize, Serialize};

use crate::engine::{GameState, Side};

/// One frame of a game. `ships` rows are `[id, side, row, col, hp, status]`:
/// side 0 = creator (the human in single-player/roguelike), 1 = joiner;
/// status 0 = alive, 1 = destroyed, 2 = fled. Ids are below 2^53, so they
/// are exact as JSON numbers. Every ship that entered the game is listed,
/// in id order, including removed ones.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CompactBoard {
    pub turn: Side,
    pub round: u64,
    /// [creator, joiner]
    pub scores: [u64; 2],
    pub ended: bool,
    pub winner: Option<Side>,
    pub ships: Vec<[i64; 6]>,
}

pub fn compact_board(g: &GameState) -> CompactBoard {
    CompactBoard {
        turn: g.current_turn,
        round: g.current_round,
        scores: [g.creator_score, g.joiner_score],
        ended: g.ended,
        winner: g.winner,
        ships: g
            .board
            .iter()
            .filter(|(_, b)| b.version != 0)
            .map(|(&id, b)| [id as i64, if b.is_creator { 0 } else { 1 }, b.row as i64, b.col as i64, b.hull_points as i64, b.status as i64])
            .collect(),
    }
}

/// Per-ship facts that don't change during a game, for the start event:
/// `[id, side, variant, max_hp]`.
pub fn fleet_info(g: &GameState) -> Vec<[i64; 4]> {
    g.board
        .iter()
        .filter(|(_, b)| b.version != 0)
        .map(|(&id, b)| [id as i64, if b.is_creator { 0 } else { 1 }, b.variant as i64, b.max_hull_points as i64])
        .collect()
}

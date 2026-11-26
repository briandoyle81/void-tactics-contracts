//! Legal-move generation. Every candidate is confirmed by applying it to a
//! clone with the real engine (`GameState::move_ship`), so the set never holds
//! an illegal move. Destinations are computed directly (the engine's own
//! distance, occupancy and path rules); targets are pruned by reach.
//!
//! Moves are distinct by outcome: area specials (Flak Array) only check that
//! the named target exists, so aiming one at any ship gives the same position
//! as aiming at none. Only the first of such duplicates is kept. Tests check,
//! by brute force over every cell/action/target, that every position the
//! engine can reach in one move is reachable from a generated move.

use vt_core::effects::Resolver;
use vt_core::engine::{
    EngineEvent, GameState, MoveInput, Rules, Side, STATUS_ALIVE, STATUS_DESTROYED,
};
use vt_core::grid::{manhattan, GRID_HEIGHT, GRID_WIDTH};
use vt_core::types::ActionType;

/// One legal move and the position it leads to.
#[derive(Clone, Debug)]
pub struct Candidate {
    pub mv: MoveInput,
    pub next: GameState,
    pub events: Vec<EngineEvent>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Targets {
    /// Skip targets beyond the action's reach (the normal mode).
    Pruned,
    /// Try every target on the board (for tests).
    Exhaustive,
}

/// Cells a ship could move to this turn, its own cell first. Mirrors
/// `validate_and_apply_movement`: distance, bounds, occupancy, and a path
/// that avoids live enemies.
pub fn destinations(g: &GameState, ship_id: u64) -> Vec<(i16, i16)> {
    let b = g.ship(ship_id);
    let mut out = vec![(b.row, b.col)];
    // live[0] = creator ships, live[1] = joiner ships.
    let enemy = g.live[if b.is_creator { 1 } else { 0 }];
    let m = b.movement as i16;
    for row in (b.row - m).max(0)..=(b.row + m).min(GRID_HEIGHT - 1) {
        for col in (b.col - m).max(0)..=(b.col + m).min(GRID_WIDTH - 1) {
            if (row, col) == (b.row, b.col)
                || manhattan((b.row, b.col), (row, col)) > b.movement
                || g.occupied.has_cell(row, col)
            {
                continue;
            }
            if g.map
                .has_movement_path_avoiding(b.row, b.col, row, col, enemy)
                .unwrap_or(false)
            {
                out.push((row, col));
            }
        }
    }
    out
}

fn try_move(g: &GameState, side: Side, mv: MoveInput, rules: &dyn Rules) -> Option<Candidate> {
    let mut next = g.clone();
    next.move_ship(side, &mv, rules, 0)
        .ok()
        .map(|events| Candidate { mv, next, events })
}

/// Ships on the board (alive or disabled), in id order.
fn on_board(g: &GameState) -> Vec<u64> {
    g.board
        .iter()
        .filter(|(_, b)| {
            b.placed && b.status != STATUS_DESTROYED && b.status != vt_core::engine::STATUS_FLED
        })
        .map(|(&id, _)| id)
        .collect()
}

/// Ships `side` may act with: on board, alive, not yet moved this round.
pub fn actors(g: &GameState, side: Side) -> Vec<u64> {
    let mut v: Vec<u64> = g
        .active(side)
        .iter()
        .copied()
        .filter(|&id| {
            let b = g.ship(id);
            b.placed && b.status == STATUS_ALIVE && b.hull_points > 0 && !g.has_moved(id)
        })
        .collect();
    v.sort_unstable();
    v
}

/// The farthest a ship's special or faction ability reaches (for pruning).
fn ability_reach(g: &GameState, rules: &dyn Rules, ship_id: u64) -> (Option<u8>, Option<u8>) {
    let b = g.ship(ship_id);
    let special = rules.special_resolver(b.variant, b.special).map(|_| {
        rules
            .special_data_at(b.variant, b.version, b.special)
            .map(|d| d.range)
            .unwrap_or(u8::MAX)
    });
    let faction = rules.faction_resolver(b.variant).map(|r| match r {
        Resolver::Ram { range } => range,
        Resolver::Repair { range, .. } => range,
        _ => u8::MAX,
    });
    (special, faction)
}

/// All legal non-retreat moves for one ship.
pub fn ship_moves(
    g: &GameState,
    rules: &dyn Rules,
    side: Side,
    ship_id: u64,
    mode: Targets,
) -> Vec<Candidate> {
    let b = g.ship(ship_id);
    let board = on_board(g);
    let (special_reach, faction_reach) = ability_reach(g, rules, ship_id);
    let reach = |dest: (i16, i16), t: u64, r: u8| {
        // Self-targeted: the ship is at `dest` by the time it acts.
        if mode == Targets::Exhaustive || t == 0 || t == ship_id || r == u8::MAX {
            return true;
        }
        let tb = g.ship(t);
        manhattan(dest, (tb.row, tb.col)) <= r
    };
    let mut out = Vec::new();
    for dest in destinations(g, ship_id) {
        let mv = |action, target| MoveInput {
            ship_id,
            new_row: dest.0,
            new_col: dest.1,
            action,
            target_ship_id: target,
        };
        // Candidates for one destination are deduplicated against each other.
        let group_start = out.len();
        out.extend(try_move(g, side, mv(ActionType::Pass, 0), rules));
        for &t in &board {
            let tb = g.ship(t);
            if tb.is_creator != b.is_creator
                && (mode == Targets::Exhaustive
                    || (tb.status == STATUS_ALIVE && manhattan(dest, (tb.row, tb.col)) <= b.range))
            {
                if let Some(c) = try_move(g, side, mv(ActionType::Shoot, t), rules) {
                    push_distinct(&mut out, group_start, c);
                }
            }
        }
        for (action, r) in [
            (ActionType::Special, special_reach),
            (ActionType::FactionAbility, faction_reach),
        ] {
            let Some(r) = r else { continue };
            // A ram can end the ship in the same place whichever cell it
            // moved to first, so faction abilities are deduplicated against
            // all of this ship's moves, not just this destination's.
            let from = if action == ActionType::FactionAbility { 0 } else { group_start };
            for t in std::iter::once(0).chain(board.iter().copied()) {
                if reach(dest, t, r) {
                    if let Some(c) = try_move(g, side, mv(action, t), rules) {
                        push_distinct(&mut out, from, c);
                    }
                }
            }
        }
    }
    out
}

/// Whether two positions are the same apart from `last_move` (which records
/// the move's target id but is never read by the rules or the AI).
pub fn same_outcome(a: &mut GameState, b: &mut GameState) -> bool {
    let (la, lb) = (a.last_move.take(), b.last_move.take());
    let eq = a == b;
    a.last_move = la;
    b.last_move = lb;
    eq
}

/// Adds `c` unless a candidate from `from` on already leads to the same
/// position.
fn push_distinct(out: &mut Vec<Candidate>, from: usize, mut c: Candidate) {
    if !out[from..]
        .iter_mut()
        .any(|k| same_outcome(&mut k.next, &mut c.next))
    {
        out.push(c);
    }
}

/// Every legal move for the side to move: each actor's moves, then a retreat
/// for each of the side's ships still on the board (retreat is legal for
/// disabled or already-moved ships too).
pub fn legal_moves(
    g: &GameState,
    rules: &(dyn Rules + Sync),
    side: Side,
    mode: Targets,
) -> Vec<Candidate> {
    if g.ended || g.current_turn != side {
        return Vec::new();
    }
    let mut out = Vec::new();
    // Ships in parallel (collected in actor order: deterministic).
    use rayon::prelude::*;
    let per_ship: Vec<Vec<Candidate>> = actors(g, side)
        .into_par_iter()
        .map(|id| ship_moves(g, rules, side, id, mode))
        .collect();
    out.extend(per_ship.into_iter().flatten());
    out.extend(retreats(g, rules, side));
    out
}

/// Retreat moves for every ship of `side` still on the board.
pub fn retreats(g: &GameState, rules: &dyn Rules, side: Side) -> Vec<Candidate> {
    let mut ids: Vec<u64> = g.active(side).to_vec();
    ids.sort_unstable();
    ids.into_iter()
        .filter_map(|id| {
            let b = g.ship(id);
            try_move(
                g,
                side,
                MoveInput {
                    ship_id: id,
                    new_row: b.row,
                    new_col: b.col,
                    action: ActionType::Retreat,
                    target_ship_id: 0,
                },
                rules,
            )
        })
        .collect()
}

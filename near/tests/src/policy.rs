//! A simple scripted "human" for sandbox games, using vt-core locally to pick
//! only legal moves (so tests never burn blocks on rejected transactions).

use vt_core::engine::{GameState, MoveInput, Side};
use vt_core::types::ActionType;

/// The rules loaded from near/seed/config.json; shared with the balance
/// simulator so both use one implementation.
pub use vt_sim::rules::LocalRules;

/// The scripted human playing the creator side (single-player).
pub fn choose_human_move(g: &GameState, rules: &LocalRules) -> Option<MoveInput> {
    choose_move(g, rules, Side::Creator)
}

/// Ram downed enemies, else shoot, else advance-and-shoot, else advance,
/// else pass, for `side`. Returns None if that side has no ship that can act.
pub fn choose_move(g: &GameState, rules: &LocalRules, side: Side) -> Option<MoveInput> {
    let legal = |g: &GameState, _r: &LocalRules, m: &MoveInput| g.clone().move_ship(side, m, rules, 0).is_ok();
    let Some(me) = g.active(side).iter().copied().find(|&id| g.ship(id).hull_points > 0 && !g.has_moved(id)) else {
        // Only disabled (0 HP) ships left to act with: the one legal move is
        // to retreat one (the engine, like Game.sol, doesn't end the game
        // until a ship is actually removed).
        let disabled = g.active(side).iter().copied().find(|&id| g.ship(id).hull_points == 0)?;
        let b = g.ship(disabled);
        return Some(MoveInput { ship_id: disabled, new_row: b.row, new_col: b.col, action: ActionType::Retreat, target_ship_id: 0 });
    };
    let b = g.ship(me);
    let mut enemies: Vec<u64> = g.active(side.other()).clone();
    enemies.sort_by_key(|&e| g.ship(e).hull_points);
    let mv = |row: i16, col: i16, action: ActionType, target: u64| MoveInput { ship_id: me, new_row: row, new_col: col, action, target_ship_id: target };

    for &e in &enemies {
        if g.ship(e).hull_points == 0 {
            let m = mv(b.row, b.col, ActionType::FactionAbility, e);
            if legal(g, rules, &m) {
                return Some(m);
            }
        }
    }
    for &e in &enemies {
        let m = mv(b.row, b.col, ActionType::Shoot, e);
        if legal(g, rules, &m) {
            return Some(m);
        }
    }
    let nearest = enemies.iter().copied().min_by_key(|&e| {
        let t = g.ship(e);
        (t.row - b.row).abs() + (t.col - b.col).abs()
    });
    if let Some(t) = nearest.map(|e| g.ship(e)) {
        for k in (1..=b.movement as i16).rev() {
            let (dr, dc) = (t.row - b.row, t.col - b.col);
            let use_c = dc.abs().min(k);
            let use_r = dr.abs().min(k - use_c);
            let (r, c) = (b.row + dr.signum() * use_r, b.col + dc.signum() * use_c);
            if (r, c) == (b.row, b.col) {
                continue;
            }
            for &e in &enemies {
                let m = mv(r, c, ActionType::Shoot, e);
                if legal(g, rules, &m) {
                    return Some(m);
                }
            }
            let m = mv(r, c, ActionType::Pass, 0);
            if legal(g, rules, &m) {
                return Some(m);
            }
        }
    }
    Some(mv(b.row, b.col, ActionType::Pass, 0))
}

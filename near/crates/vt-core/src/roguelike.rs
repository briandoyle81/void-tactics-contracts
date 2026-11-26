//! Pure roguelike run rules (RoguelikeMatch / RoguelikeRun / RoguelikeResupply),
//! shared by the contract and the balance simulator so they can't drift.
//! Storage, locking and accounting stay in the contract.
//!
//! HP convention: a stored roster HP of 0 means "full" (never damaged in this
//! run); a ship carried at 0 HP is stored as 1 (see `healed_hp`).

use crate::types::Position;

/// Roster ship i's slot when a run starts or re-reserves: row-major in the
/// creator's default deployment band (4 columns wide).
pub fn roster_positions(n: usize) -> Vec<Position> {
    (0..n).map(|i| Position { row: (i / 4) as i16, col: (i % 4) as i16 }).collect()
}

/// HP a ship keeps after a won node: at least `heal_pct`% of max, at most
/// max, and never 0 (0 is the "full HP" sentinel).
pub fn healed_hp(heal_pct: u8, hp: u8, max: u8) -> u8 {
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

/// A stored roster HP read as actual HP (0 = full).
pub fn effective_hp(stored: u8, max: u8) -> u8 {
    if stored == 0 { max } else { stored }
}

/// HealAboveFloorWinEffect: the HP to raise a ship to, if above its current
/// HP (None = leave it).
pub fn heal_above_floor(stored: u8, max: u8, percent: u8) -> Option<u8> {
    let current = effective_hp(stored, max);
    let target = (max as u16 * percent as u16) / 100;
    (target > current as u16).then_some(target as u8)
}

/// RoguelikeResupply.resupplyRepair: hit points a full repair restores (the
/// UTC charged is this times the repair cost per HP).
pub fn repair_missing_hp(stored: u8, max: u8) -> u8 {
    max.saturating_sub(effective_hp(stored, max))
}

/// RoguelikeMatch._commitToNode: whether a run standing on `current` may
/// move to `target`. Staying put is always allowed.
pub fn check_advance(target: u64, current: u64, current_is_combat: bool, current_defeated: bool, target_locked: bool, current_children: &[u64]) -> Result<(), &'static str> {
    if target == current {
        return Ok(());
    }
    if current_is_combat && !current_defeated {
        return Err("CurrentNodeNotCleared");
    }
    if target_locked || !current_children.contains(&target) {
        return Err("CannotAdvance");
    }
    Ok(())
}

/// Nodes a one-way commit from `current` to `target` locks: every sibling and
/// the node being left.
pub fn locked_by_advance<T: Clone + PartialEq>(current: &T, target: &T, current_children: &[T]) -> Vec<T> {
    let mut v: Vec<T> = current_children.iter().filter(|&c| c != target).cloned().collect();
    v.push(current.clone());
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn healing_and_repair_follow_the_contract_rules() {
        assert_eq!(healed_hp(80, 10, 100), 80, "raised to the floor");
        assert_eq!(healed_hp(80, 95, 100), 95, "kept above the floor");
        assert_eq!(healed_hp(0, 0, 100), 1, "never the 0 sentinel");
        assert_eq!(effective_hp(0, 120), 120);
        assert_eq!(heal_above_floor(50, 100, 100), Some(100));
        assert_eq!(heal_above_floor(0, 100, 100), None, "already full");
        assert_eq!(repair_missing_hp(30, 100), 70);
        assert_eq!(repair_missing_hp(0, 100), 0);
        assert_eq!(roster_positions(5)[4], Position { row: 1, col: 0 });
    }

    #[test]
    fn advance_rules() {
        assert_eq!(check_advance(2, 1, true, false, false, &[2, 3]), Err("CurrentNodeNotCleared"));
        assert_eq!(check_advance(2, 1, true, true, false, &[2, 3]), Ok(()));
        assert_eq!(check_advance(4, 1, true, true, false, &[2, 3]), Err("CannotAdvance"));
        assert_eq!(check_advance(2, 1, false, false, true, &[2, 3]), Err("CannotAdvance"));
        assert_eq!(check_advance(1, 1, true, false, true, &[]), Ok(()));
        assert_eq!(locked_by_advance(&1u64, &2, &[2, 3]), vec![3, 1]);
    }
}

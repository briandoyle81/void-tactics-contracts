//! Stat and cost calculation (ShipAttributes.sol), ported line-for-line.
//!
//! Solidity 0.8 checked uint8/int8 arithmetic reverts on overflow; every such
//! step here returns `Error::ArithmeticOverflow` instead of wrapping.

use crate::error::{add_u8, Error, Result};
use crate::types::*;

pub const TIER_COUNT: usize = 3;
pub const RANK_COUNT: usize = 6;
pub const MAX_RANK_BONUS_PCT: u8 = 100;
pub const MIN_RANGE: u8 = 1;
pub const MIN_MOVEMENT: u8 = 1;

/// rank = 1 + number of (strictly ascending) thresholds reached.
pub fn rank_of(data: &VariantAttributeData, ships_destroyed: u64) -> u8 {
    let mut rank = 1u8;
    for &t in &data.rank_thresholds {
        if ships_destroyed < t as u64 {
            break;
        }
        rank += 1;
    }
    rank
}

fn idx<T>(v: &[T], i: usize) -> Result<&T> {
    // Solidity array OOB panics (0x32); configs are validated at publish so this
    // only trips on hand-built bad data.
    v.get(i).ok_or(Error::InvalidArrayLength)
}

/// `value += uint8(value * pct / 100)`: the explicit uint8 cast truncates
/// (no revert), then the `+=` is checked.
fn add_pct(value: u8, pct: u8) -> Result<u8> {
    let bonus = ((value as u64 * pct as u64) / 100) as u8;
    add_u8(value, bonus)
}

/// ShipAttributes._calculate. `version` is the variant's current attributes
/// version, stamped into the result (the game's pin).
pub fn calculate(data: &VariantAttributeData, version: u16, ship: &ShipStatsInput) -> Result<Attributes> {
    if ship.id == 0 {
        return Err(Error::ShipNotFound);
    }
    let rank = rank_of(data, ship.ships_destroyed as u64);
    let rank_pct = *idx(&data.rank_bonus_pct, (rank - 1) as usize)?;
    let gun = idx(&data.guns, ship.equipment.main_weapon.index())?;

    let mut a = Attributes { version, ..Default::default() };

    a.range = add_pct(gun.range, rank_pct)?;
    let fore = *idx(&data.fore_accuracy, ship.accuracy as usize)?;
    a.range = add_pct(a.range, fore)?;
    if a.range < MIN_RANGE {
        a.range = MIN_RANGE;
    }

    a.gun_damage = add_pct(gun.damage, rank_pct)?;

    a.hull_points = add_u8(data.base_hull, *idx(&data.hull, ship.hull as usize)?)?;
    a.hull_points = add_pct(a.hull_points, rank_pct)?;
    a.max_hull_points = a.hull_points;

    a.movement = movement(data, ship)?;
    a.movement = add_pct(a.movement, rank_pct)?;
    if a.movement < MIN_MOVEMENT {
        a.movement = MIN_MOVEMENT;
    }

    let dr = add_u8(
        idx(&data.armors, ship.equipment.armor.index())?.damage_reduction,
        idx(&data.shields, ship.equipment.shields.index())?.damage_reduction,
    )?;
    a.damage_reduction = add_pct(dr, rank_pct)?;
    // HA3-02: cap at 100%.
    if a.damage_reduction > 100 {
        a.damage_reduction = 100;
    }
    Ok(a)
}

fn add_i8(a: i8, b: i8) -> Result<i8> {
    a.checked_add(b).ok_or(Error::ArithmeticOverflow)
}

/// ShipAttributes._calculateMovement (int8 checked math, floored at 0).
fn movement(data: &VariantAttributeData, ship: &ShipStatsInput) -> Result<u8> {
    // int8(uint8) reinterprets (no revert) in Solidity.
    let mut base = data.base_speed as i8;
    base = add_i8(base, *idx(&data.engine_speeds, ship.speed as usize)? as i8)?;

    let gun_mv = idx(&data.guns, ship.equipment.main_weapon.index())?.movement;
    let mut armor_mv = 0i8;
    let mut shield_mv = 0i8;
    if ship.equipment.armor != Armor::None {
        armor_mv = idx(&data.armors, ship.equipment.armor.index())?.movement;
    }
    if ship.equipment.shields != Shields::None {
        shield_mv = idx(&data.shields, ship.equipment.shields.index())?.movement;
    }
    if ship.equipment.armor == Armor::None && ship.equipment.shields == Shields::None {
        armor_mv = idx(&data.armors, 0)?.movement;
    }
    let special_mv = idx(&data.specials, ship.equipment.special.index())?.movement;

    // Solidity evaluates `gun + armor + shield + special` left to right, then
    // adds it to base; each step is checked.
    let sum = add_i8(add_i8(add_i8(gun_mv, armor_mv)?, shield_mv)?, special_mv)?;
    base = add_i8(base, sum)?;
    Ok(if base > 0 { base as u8 } else { 0 })
}

/// ShipAttributes.calculateShipCost (u16 sum, checked).
pub fn ship_cost(costs: &Costs, ship: &Ship) -> Result<u16> {
    if costs.version == 0 {
        return Err(Error::InvalidCostsVersion);
    }
    let parts = [
        *idx(&costs.accuracy, ship.traits.accuracy as usize)?,
        *idx(&costs.hull, ship.traits.hull as usize)?,
        *idx(&costs.speed, ship.traits.speed as usize)?,
        *idx(&costs.main_weapon, ship.equipment.main_weapon.index())?,
        *idx(&costs.armor, ship.equipment.armor.index())?,
        *idx(&costs.shields, ship.equipment.shields.index())?,
        *idx(&costs.special, ship.equipment.special.index())?,
    ];
    let mut total = costs.base_cost as u16;
    for p in parts {
        total = total.checked_add(p as u16).ok_or(Error::ArithmeticOverflow)?;
    }
    Ok(total)
}

/// ShipAttributes.setCosts length validation.
pub fn validate_costs(c: &Costs) -> Result<()> {
    let ok = c.accuracy.len() == TIER_COUNT
        && c.hull.len() == TIER_COUNT
        && c.speed.len() == TIER_COUNT
        && c.main_weapon.len() == MainWeapon::COUNT
        && c.armor.len() == Armor::COUNT
        && c.shields.len() == Shields::COUNT
        && c.special.len() == Special::COUNT;
    if ok { Ok(()) } else { Err(Error::InvalidArrayLength) }
}

/// ShipAttributes._validateAttributes.
pub fn validate_attributes(d: &VariantAttributeData) -> Result<()> {
    let lengths_ok = d.fore_accuracy.len() == TIER_COUNT
        && d.hull.len() == TIER_COUNT
        && d.engine_speeds.len() == TIER_COUNT
        && d.guns.len() == MainWeapon::COUNT
        && d.armors.len() == Armor::COUNT
        && d.shields.len() == Shields::COUNT
        && d.specials.len() == Special::COUNT
        && d.rank_thresholds.len() == RANK_COUNT - 1
        && d.rank_bonus_pct.len() == RANK_COUNT;
    if !lengths_ok {
        return Err(Error::InvalidArrayLength);
    }
    if d.rank_thresholds[0] == 0 {
        return Err(Error::InvalidRankConfig);
    }
    if d.rank_thresholds.windows(2).any(|w| w[1] <= w[0]) {
        return Err(Error::InvalidRankConfig);
    }
    if d.rank_bonus_pct.iter().any(|&p| p > MAX_RANK_BONUS_PCT) {
        return Err(Error::InvalidRankConfig);
    }
    Ok(())
}

/// Ships._getKillsForRank.
pub fn kills_for_rank(rank: u8) -> u32 {
    match rank {
        r if r >= 6 => 1000,
        5 => 300,
        4 => 100,
        3 => 30,
        2 => 10,
        _ => 1,
    }
}

/// GenerateNewShip.getTierOfTrait.
pub fn tier_of_trait(roll: u64) -> u8 {
    if roll < 50 {
        0
    } else if roll < 80 {
        1
    } else {
        2
    }
}

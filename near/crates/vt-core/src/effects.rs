//! Faction abilities and equipped specials (the seven IEffectResolver
//! contracts). Each was a stateless view that read the game back through
//! `IGameView(msg.sender)`; here they read `&GameState` directly. Resolvers
//! only validate and describe effects; `GameState::dispatch_effects` applies
//! them (SpecialEffectsLib).

use borsh::{BorshDeserialize, BorshSerialize};
use serde::{Deserialize, Serialize};

use crate::engine::{GameState, Rules, ShipPosition, STATUS_ALIVE};
use crate::error::{Error, Result};
use crate::types::Special;

/// `type(int16).min`: "don't relocate".
pub const NO_RELOCATE: i16 = i16::MIN;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SpecialEffect {
    pub ship_id: u64,
    /// Negative = damage, positive = heal (capped).
    pub hull_delta: i16,
    pub reactor_timer_delta: i8,
    pub new_row: i16,
    pub new_col: i16,
    /// 0 none, 1 retreat, 2 destroy.
    pub removal_kind: u8,
}

impl SpecialEffect {
    fn on(ship_id: u64) -> SpecialEffect {
        SpecialEffect { ship_id, hull_delta: 0, reactor_timer_delta: 0, new_row: NO_RELOCATE, new_col: 0, removal_kind: 0 }
    }
}

pub struct ResolveCtx {
    pub ship_id: u64,
    pub variant: u16,
    pub target_ship_id: u64,
    /// The acting ship's position after this move's movement step.
    pub acting_row: i16,
    pub acting_col: i16,
}

/// Which resolver a (variant) faction ability or (variant, slot) special uses.
/// `slot` is the special-data slot read from ShipAttributes for range/strength.
#[derive(Clone, Copy, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize, Serialize, Deserialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(schemars::JsonSchema, borsh::BorshSchema))]
pub enum Resolver {
    /// Faction 1: destroy-adjacent-0HP-enemy ram (own range/strength config).
    Ram { range: u8 },
    /// Faction 2: heal a friendly ship.
    Repair { range: u8, strength: u8 },
    Emp { slot: Special },
    RepairDrones { slot: Special },
    FlakArray { slot: Special },
    ElectricStorm { slot: Special },
    DroneSwarm { slot: Special },
}

fn dist(r1: i16, c1: i16, p: &ShipPosition) -> Result<u8> {
    crate::engine::manhattan_checked((r1, c1), (p.row, p.col))
}

/// `acting`/`target` lookups shared by the single-target resolvers.
fn pair(g: &GameState, ctx: &ResolveCtx, not_found: Error) -> Result<(ShipPosition, ShipPosition)> {
    let acting = g.ship_position(ctx.ship_id);
    let target = g.ship_position(ctx.target_ship_id);
    if acting.ship_id == 0 || target.ship_id == 0 || target.status != STATUS_ALIVE {
        return Err(not_found);
    }
    Ok((acting, target))
}

fn reduced(strength: u8, damage_reduction: u8) -> Result<u8> {
    let s = strength as u16;
    let d = s.checked_sub((s * damage_reduction as u16) / 100).ok_or(Error::ArithmeticOverflow)?;
    Ok(d as u8)
}

impl Resolver {
    pub fn resolve(&self, g: &GameState, rules: &dyn Rules, ctx: &ResolveCtx) -> Result<Vec<SpecialEffect>> {
        let pinned = || -> Result<u16> { Ok(g.ship_attributes(ctx.ship_id)?.version) };
        match *self {
            Resolver::Ram { range } => {
                let acting = g.ship_position(ctx.ship_id);
                let target = g.ship_position(ctx.target_ship_id);
                if acting.ship_id == 0 || target.ship_id == 0 || target.status != STATUS_ALIVE || acting.is_creator == target.is_creator {
                    return Err(Error::InvalidRamTarget);
                }
                if g.ship_attributes(ctx.target_ship_id)?.hull_points != 0 {
                    return Err(Error::InvalidRamTarget);
                }
                if dist(ctx.acting_row, ctx.acting_col, &target)? > range {
                    return Err(Error::OutOfRange);
                }
                Ok(vec![
                    SpecialEffect { new_row: 0, removal_kind: 1, ..SpecialEffect::on(ctx.target_ship_id) },
                    SpecialEffect { reactor_timer_delta: 1, new_row: target.row, new_col: target.col, ..SpecialEffect::on(ctx.ship_id) },
                ])
            }
            Resolver::Repair { range, strength } => {
                let (acting, target) = pair(g, ctx, Error::TargetNotFound)?;
                if acting.is_creator != target.is_creator {
                    return Err(Error::TargetNotFriendly);
                }
                if dist(ctx.acting_row, ctx.acting_col, &target)? > range {
                    return Err(Error::OutOfRange);
                }
                Ok(vec![SpecialEffect { hull_delta: strength as i16, ..SpecialEffect::on(ctx.target_ship_id) }])
            }
            Resolver::Emp { slot } => {
                let (acting, target) = pair(g, ctx, Error::TargetNotFound)?;
                if acting.is_creator == target.is_creator {
                    return Err(Error::TargetNotEnemy);
                }
                let data = rules.special_data_at(ctx.variant, pinned()?, slot)?;
                if dist(ctx.acting_row, ctx.acting_col, &target)? > data.range {
                    return Err(Error::OutOfRange);
                }
                let delta = data.strength.min(127) as i8;
                Ok(vec![SpecialEffect { reactor_timer_delta: delta, ..SpecialEffect::on(ctx.target_ship_id) }])
            }
            Resolver::RepairDrones { slot } => {
                let (acting, target) = pair(g, ctx, Error::TargetNotFound)?;
                if acting.is_creator != target.is_creator {
                    return Err(Error::TargetNotFriendly);
                }
                let data = rules.special_data_at(ctx.variant, pinned()?, slot)?;
                if dist(ctx.acting_row, ctx.acting_col, &target)? > data.range {
                    return Err(Error::OutOfRange);
                }
                Ok(vec![SpecialEffect { hull_delta: data.strength as i16, ..SpecialEffect::on(ctx.target_ship_id) }])
            }
            Resolver::DroneSwarm { slot } => {
                let (acting, target) = pair(g, ctx, Error::TargetNotFound)?;
                if acting.is_creator == target.is_creator {
                    return Err(Error::TargetNotEnemy);
                }
                let data = rules.special_data_at(ctx.variant, pinned()?, slot)?;
                if dist(ctx.acting_row, ctx.acting_col, &target)? > data.range {
                    return Err(Error::OutOfRange);
                }
                let dr = g.ship_attributes(ctx.target_ship_id)?.damage_reduction;
                let damage = reduced(data.strength, dr)?;
                Ok(vec![SpecialEffect { hull_delta: -(damage as i16), ..SpecialEffect::on(ctx.target_ship_id) }])
            }
            Resolver::FlakArray { slot } => {
                // Area damage to every live ship in range except the actor
                // (allies included), in getAllShipPositions order.
                let data = rules.special_data_at(ctx.variant, pinned()?, slot)?;
                let mut out = Vec::new();
                for p in g.all_ship_positions() {
                    if p.status != STATUS_ALIVE || p.ship_id == ctx.ship_id {
                        continue;
                    }
                    if dist(ctx.acting_row, ctx.acting_col, &p)? > data.range {
                        continue;
                    }
                    let dr = g.ship_attributes(p.ship_id)?.damage_reduction;
                    let damage = reduced(data.strength, dr)?;
                    out.push(SpecialEffect { hull_delta: -(damage as i16), ..SpecialEffect::on(p.ship_id) });
                }
                Ok(out)
            }
            Resolver::ElectricStorm { slot } => {
                // Reactor-timer hit on every live ship in range, the actor
                // and allies included.
                let data = rules.special_data_at(ctx.variant, pinned()?, slot)?;
                let delta = data.strength.min(127) as i8;
                let mut out = Vec::new();
                for p in g.all_ship_positions() {
                    if p.status != STATUS_ALIVE {
                        continue;
                    }
                    if dist(ctx.acting_row, ctx.acting_col, &p)? > data.range {
                        continue;
                    }
                    out.push(SpecialEffect { reactor_timer_delta: delta, ..SpecialEffect::on(p.ship_id) });
                }
                Ok(out)
            }
        }
    }
}

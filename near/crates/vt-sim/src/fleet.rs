//! Ships and fleets: rolling ships exactly as the contract constructs them,
//! turning a chosen fleet into engine entries, and baseline (Poor-level)
//! selection and placement. Phase 3 adds the Average/Excellent composers.

use rand::seq::SliceRandom;
use rand::Rng;
use vt_core::engine::FleetEntry;
use vt_core::generation::generate_ship;
use vt_core::ship_names::OnchainShipNames;
use vt_core::types::{Position, Ship};

use crate::rules::Config;

/// Ships.constructShip: roll a ship from a random value, keep a preset rank
/// (paid packs) if one was set, mark it constructed and price it.
pub fn roll_ship(
    cfg: &Config,
    id: u64,
    variant: u16,
    random_value: u64,
    preset_kills: u32,
) -> Ship {
    let mut ship = generate_ship(
        id,
        id,
        random_value,
        variant,
        cfg.max_special_slot[&variant],
        &OnchainShipNames,
    );
    if preset_kills != 0 {
        ship.ship_data.ships_destroyed = preset_kills;
    }
    ship.ship_data.constructed = true;
    price(cfg, &mut ship);
    ship
}

/// Ships._setCostOfShip under the variant's current cost table.
pub fn price(cfg: &Config, ship: &mut Ship) {
    let costs = &cfg.costs[&ship.traits.variant];
    ship.ship_data.costs_version = costs.version;
    ship.ship_data.cost = cfg.cost(ship).expect("priced");
}

/// Engine fleet entries for ships at the given cells (current attributes).
pub fn entries(cfg: &Config, ships: &[&Ship], cells: &[Position]) -> Vec<FleetEntry> {
    ships
        .iter()
        .zip(cells)
        .map(|(s, p)| FleetEntry {
            ship_id: s.id,
            row: p.row,
            col: p.col,
            attributes: cfg.attributes(s).expect("attributes"),
            variant: s.traits.variant,
            special: s.equipment.special,
        })
        .collect()
}

/// Total fleet cost.
pub fn cost(ships: &[&Ship]) -> u64 {
    ships.iter().map(|s| s.ship_data.cost as u64).sum()
}

/// Poor composition: shuffle the pool and take ships while they fit the cap
/// (and the per-fleet limit), one variant only, as fleets require.
pub fn random_fleet<'a, R: Rng>(
    pool: &'a [Ship],
    cap: u64,
    max_ships: usize,
    variant: Option<u16>,
    rng: &mut R,
) -> Vec<&'a Ship> {
    let mut order: Vec<&Ship> = pool
        .iter()
        .filter(|s| variant.is_none_or(|v| s.traits.variant == v))
        .collect();
    order.shuffle(rng);
    let variant = variant.or_else(|| order.first().map(|s| s.traits.variant));
    let mut out = Vec::new();
    let mut total = 0;
    for s in order {
        if out.len() >= max_ships || Some(s.traits.variant) != variant {
            continue;
        }
        if total + s.ship_data.cost as u64 <= cap {
            total += s.ship_data.cost as u64;
            out.push(s);
        }
    }
    out
}

/// Poor placement: distinct random tiles from the deployment zone.
pub fn random_cells<R: Rng>(tiles: &[Position], n: usize, rng: &mut R) -> Vec<Position> {
    let mut t = tiles.to_vec();
    t.shuffle(rng);
    t.truncate(n);
    t
}

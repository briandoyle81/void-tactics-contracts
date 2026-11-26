//! DroneYard choices: which modification to buy for a ship. How much to
//! spend (and on which ships) is the economy's call (Phase 4); this picks
//! the build.
//!
//! Valid builds follow DroneYard.modifyShip: weapon/armor/shields/special
//! from the real types (Generic..Close, None..Heavy; specials up to the
//! variant's max slot), armor and shields not both set, trait tiers 0..=2,
//! the variant unchanged. (The contracts also accept the unused `Future`
//! enum slots; they have 0 stats, so no composer picks them.)
//!
//! - Poor: a random build within the change budget.
//! - Average: the highest-value build (value model) within the budget.
//! - Excellent: the build with the best value per fleet cost (the cost cap
//!   is what binds fleets), within the budget.

use rand::seq::SliceRandom;
use rand_chacha::ChaCha8Rng;
use vt_core::attributes::count_modifications;
use vt_core::types::{Armor, Equipment, MainWeapon, Shields, Ship, Special};

use super::value::ShipValueModel;
use crate::fleet::price;
use crate::rules::Config;
use crate::tactics::Level;

/// Every valid build of `ship` (same ship, other loadout/traits), priced.
pub fn builds(cfg: &Config, ship: &Ship) -> Vec<Ship> {
    let max_special = cfg.max_special_slot[&ship.traits.variant] as usize;
    let mut out = Vec::new();
    for w in 0..4 {
        for (a, sh) in [(0, 0), (1, 0), (2, 0), (3, 0), (0, 1), (0, 2), (0, 3)] {
            for sp in 0..=max_special {
                for acc in 0..3u8 {
                    for hull in 0..3u8 {
                        for speed in 0..3u8 {
                            let mut s = ship.clone();
                            s.equipment = Equipment {
                                main_weapon: MainWeapon::from_index(w).unwrap(),
                                armor: Armor::from_index(a).unwrap(),
                                shields: Shields::from_index(sh).unwrap(),
                                special: Special::from_index(sp).unwrap(),
                            };
                            s.traits.accuracy = acc;
                            s.traits.hull = hull;
                            s.traits.speed = speed;
                            price(cfg, &mut s);
                            out.push(s);
                        }
                    }
                }
            }
        }
    }
    out
}

/// The build a player of `level` would buy for `ship` with at most
/// `max_changes` modifications (None = keep the ship as is).
pub fn choose_build(
    level: Level,
    cfg: &Config,
    values: &ShipValueModel,
    ship: &Ship,
    max_changes: u32,
    rng: &mut ChaCha8Rng,
) -> Option<Ship> {
    let options: Vec<Ship> = builds(cfg, ship)
        .into_iter()
        .filter(|b| (1..=max_changes).contains(&count_modifications(ship, b)))
        .collect();
    match level {
        Level::Poor => options.choose(rng).cloned(),
        Level::Average => {
            let current = values.value(cfg, ship);
            options
                .into_iter()
                .map(|b| (values.value(cfg, &b), b))
                .filter(|x| x.0 > current)
                .max_by(|a, b| a.0.partial_cmp(&b.0).unwrap())
                .map(|x| x.1)
        }
        Level::Excellent => {
            let density = |s: &Ship| values.value(cfg, s) / s.ship_data.cost.max(1) as f64;
            let current = density(ship);
            options
                .into_iter()
                .map(|b| (density(&b), b))
                .filter(|x| x.0 > current)
                .max_by(|a, b| a.0.partial_cmp(&b.0).unwrap())
                .map(|x| x.1)
        }
    }
}

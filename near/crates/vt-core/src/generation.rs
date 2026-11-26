//! Ship generation (GenerateNewShip.sol) and variant-2 drone names
//! (DroneNames.sol), bit-identical to Solidity for the same inputs.
//!
//! `keccak256(abi.encodePacked(uint64 x))` hashes the 8 big-endian bytes of x;
//! `uint(hash) % n` is a 256-bit modulo, computed exactly by `mod_u256`.

use crate::attributes::tier_of_trait;
use crate::random::keccak256;
use crate::types::*;

/// `uint256(be_bytes) % n`.
pub fn mod_u256(h: &[u8; 32], n: u64) -> u64 {
    let n = n as u128;
    h.iter().fold(0u128, |r, &b| (r * 256 + b as u128) % n) as u64
}

fn roll(base: u64, n: u64) -> u64 {
    mod_u256(&keccak256(&[&base.to_be_bytes()]), n)
}

/// Variant-1 ship names (Solidity: the external OnchainRandomShipNames
/// contract). Production uses `crate::ship_names::OnchainShipNames`; tests can
/// pass a mock, as the Hardhat suite does.
pub trait ShipNamer {
    fn ship_name(&self, seed: &[u8; 32]) -> String;
}

/// GenerateNewShip.generateShip. `max_special_slot` is Game.maxSpecialSlot for
/// the variant (0 = always roll None).
///
/// Divergence: Solidity's `randomBase++` is checked uint64 math and would
/// revert for a base within ~16 of u64::MAX (a ~1e-18 chance that bricks the
/// ship forever); here it wraps.
pub fn generate_ship(
    id: u64,
    serial_number: u64,
    random_base: u64,
    variant: u16,
    max_special_slot: u8,
    namer: &dyn ShipNamer,
) -> Ship {
    let mut s = Ship { id, ..Default::default() };
    s.traits.serial_number = serial_number;
    let mut b = random_base;
    let mut next = || {
        b = b.wrapping_add(1);
        b
    };

    // Weapon before name: drone names are themed on the weapon.
    s.equipment.main_weapon = MainWeapon::from_index(roll(next(), 4) as usize).unwrap();

    let name_seed = keccak256(&[&next().to_be_bytes()]);
    s.name = if variant == 2 {
        drone_name(&name_seed, s.equipment.main_weapon)
    } else {
        namer.ship_name(&name_seed)
    };

    s.traits.colors.h1 = roll(next(), 360) as u16;
    s.traits.colors.s1 = roll(next(), 100) as u8;
    s.traits.colors.l1 = roll(next(), 100) as u8;
    s.traits.colors.h2 = roll(next(), 360) as u16;
    s.traits.colors.s2 = roll(next(), 100) as u8;
    s.traits.colors.l2 = roll(next(), 100) as u8;

    s.traits.accuracy = tier_of_trait(roll(next(), 100));
    s.traits.hull = tier_of_trait(roll(next(), 100));
    s.traits.speed = tier_of_trait(roll(next(), 100));

    next();
    s.traits.variant = variant;

    let has_armor = roll(next(), 2) == 0;
    let eq = roll(next(), 4) as usize;
    if has_armor {
        s.equipment.armor = Armor::from_index(eq).unwrap();
    } else {
        s.equipment.shields = Shields::from_index(eq).unwrap();
    }

    let special_base = next();
    s.equipment.special = Special::from_index(roll(special_base, max_special_slot as u64 + 1) as usize)
        .unwrap_or(Special::None);
    // Shiny reuses the special roll's base (no increment), as in Solidity.
    if roll(special_base, 100) <= 8 {
        s.ship_data.shiny = true;
    }

    let k = roll(next(), 100) as u32;
    s.ship_data.ships_destroyed = if k < 75 {
        1 + (k % 9)
    } else if k < 90 {
        10 + (k % 20)
    } else if k < 95 {
        30 + (k % 70)
    } else if k < 99 {
        100 + (k % 200)
    } else {
        300 + (k % 700)
    };
    s
}

// ---------------- DroneNames.sol ----------------

const CONSONANTS: &[u8] = b"BCDFGHJKLMNPQRSTVWXZ";

fn letter(h: &[u8; 32], i: usize) -> char {
    CONSONANTS[h[i] as usize % CONSONANTS.len()] as char
}
fn digit(h: &[u8; 32], i: usize) -> char {
    (b'0' + h[i] % 10) as char
}
fn digits(h: &[u8; 32], start: usize, count: usize) -> String {
    (0..count).map(|i| digit(h, start + i)).collect()
}

pub fn drone_name(seed: &[u8; 32], weapon: MainWeapon) -> String {
    let template = keccak256(&[seed, b"template"])[0] % 6;
    let h = keccak256(&[seed, b"chars"]);
    let (model, serial): (String, String) = match template {
        0 => ([letter(&h, 0), letter(&h, 1)].iter().collect(), digits(&h, 2, 2)),
        1 => ([letter(&h, 0), digit(&h, 1)].iter().collect(), digits(&h, 2, 3)),
        2 => ([digit(&h, 0), letter(&h, 1)].iter().collect(), digits(&h, 2, 2)),
        3 => ([letter(&h, 0), letter(&h, 1)].iter().collect(), digits(&h, 2, 3)),
        4 => (letter(&h, 0).to_string(), digits(&h, 1, 3)),
        _ => ([letter(&h, 0), letter(&h, 1), digit(&h, 2)].iter().collect(), digits(&h, 3, 2)),
    };
    let pool: [&str; 10] = match weapon {
        MainWeapon::Sniper => ["Comet", "Nova", "Pulsar", "Helix", "Vector", "Zenith", "Corona", "Umbra", "Nadir", "Orbit"],
        MainWeapon::Missile => ["Wasp", "Viper", "Shrike", "Rook", "Hornet", "Jackal", "Mantis", "Kestrel", "Raven", "Moth"],
        _ => ["Flint", "Auger", "Slate", "Cinder", "Rime", "Grit", "Onyx", "Ash", "Basalt", "Shale"],
    };
    let cw = keccak256(&[seed, b"codeword"]);
    format!("{model}-{serial} {}", pool[mod_u256(&cw, 10) as usize])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mod_u256_small_values() {
        let mut h = [0u8; 32];
        h[31] = 200;
        assert_eq!(mod_u256(&h, 7), 200 % 7);
        h[30] = 1; // 456
        assert_eq!(mod_u256(&h, 100), 56);
    }

    #[test]
    fn generation_is_deterministic_and_in_range() {
        for base in [0u64, 1, 12345, u64::MAX - 3] {
            let a = generate_ship(1, 9, base, 1, 3, &crate::ship_names::OnchainShipNames);
            let b = generate_ship(1, 9, base, 1, 3, &crate::ship_names::OnchainShipNames);
            assert_eq!(a, b);
            assert!(a.traits.colors.h1 < 360 && a.traits.colors.s1 < 100);
            assert!(a.traits.accuracy <= 2 && a.traits.hull <= 2 && a.traits.speed <= 2);
            assert!(a.equipment.special.index() <= 3);
            assert!((1..=999).contains(&a.ship_data.ships_destroyed));
            assert!(a.equipment.armor == Armor::None || a.equipment.shields == Shields::None);
        }
    }

    #[test]
    fn drone_names_have_expected_shape() {
        let g = generate_ship(1, 1, 42, 2, 3, &crate::ship_names::OnchainShipNames);
        let (code, word) = g.name.split_once(' ').unwrap();
        assert!(code.contains('-'));
        assert!(!word.is_empty());
    }
}

//! Shared game types, mirroring contracts/Types.sol.
//!
//! Enum discriminants match Solidity's (borsh encodes them as the same u8), so
//! values exported from the Hardhat oracle map 1:1. JSON uses variant names.

use borsh::{BorshDeserialize, BorshSerialize};
use serde::{Deserialize, Serialize};

macro_rules! game_enum {
    ($(#[$m:meta])* $name:ident { $($variant:ident),+ $(,)? }) => {
        $(#[$m])*
        #[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, PartialOrd, Ord,
                 BorshSerialize, BorshDeserialize, Serialize, Deserialize)]
        #[cfg_attr(not(target_arch = "wasm32"), derive(schemars::JsonSchema, borsh::BorshSchema))]
        #[borsh(use_discriminant = true)]
        #[repr(u8)]
        pub enum $name {
            #[default]
            $($variant),+
        }

        impl $name {
            pub const ALL: &'static [$name] = &[$($name::$variant),+];
            pub const COUNT: usize = Self::ALL.len();

            /// Solidity `Enum(x)` conversion; None when out of range (Solidity
            /// would panic 0x21).
            pub fn from_index(i: usize) -> Option<$name> {
                Self::ALL.get(i).copied()
            }
            pub fn index(self) -> usize {
                self as usize
            }
        }
    };
}

// `game_enum!` puts #[default] on the first variant.
game_enum!(MainWeapon { Generic, Sniper, Missile, Close, Future1, Future2, Future3, Future4 });
game_enum!(Armor { None, Light, Medium, Heavy, Future1, Future2, Future3, Future4 });
game_enum!(Shields { None, Light, Medium, Heavy, Future1, Future2, Future3, Future4 });
game_enum!(
    /// Per-faction LOCAL slot index (see Types.sol). Fixed at 8 members forever.
    Special { None, Slot1, Slot2, Slot3, Slot4, Slot5, Slot6, Slot7 }
);
game_enum!(Archetype { Grunt, Aggressor, Sniper, Support, Turtle, Rammer, Runner, Hunter });
game_enum!(MapMode { PvP, PvE, Both });
game_enum!(ActionType { Pass, Shoot, Retreat, Assist, Special, FactionAbility });

macro_rules! game_struct {
    ($(#[$m:meta])* pub struct $name:ident { $($(#[$fm:meta])* pub $field:ident : $ty:ty),* $(,)? }) => {
        $(#[$m])*
        #[derive(Clone, Debug, Default, PartialEq, Eq, BorshSerialize, BorshDeserialize, Serialize, Deserialize)]
        #[cfg_attr(not(target_arch = "wasm32"), derive(schemars::JsonSchema, borsh::BorshSchema))]
        pub struct $name { $($(#[$fm])* pub $field: $ty),* }
    };
}

game_struct!(
    /// HSL colors rolled at mint. h2/s2/l2 have no reader yet but are reserved
    /// for a planned feature: keep rolling them.
    pub struct Colors { pub h1: u16, pub s1: u8, pub l1: u8, pub h2: u16, pub s2: u8, pub l2: u8 }
);

game_struct!(
    pub struct Traits {
        /// Randomness request id the ship was built from.
        pub serial_number: u64,
        pub colors: Colors,
        pub variant: u16,
        pub accuracy: u8,
        pub hull: u8,
        pub speed: u8,
    }
);

game_struct!(
    pub struct Equipment { pub main_weapon: MainWeapon, pub armor: Armor, pub shields: Shields, pub special: Special }
);

game_struct!(
    pub struct Attributes {
        pub version: u16,
        pub range: u8,
        pub gun_damage: u8,
        pub hull_points: u8,
        pub max_hull_points: u8,
        pub movement: u8,
        pub damage_reduction: u8,
        pub reactor_critical_timer: u8,
    }
);

game_struct!(pub struct Position { pub row: i16, pub col: i16 });

game_struct!(pub struct ScoringPosition { pub row: i16, pub col: i16, pub points: u8, pub only_once: bool });

game_struct!(
    pub struct ShipData {
        pub ships_destroyed: u32,
        pub costs_version: u16,
        pub cost: u16,
        pub modified: u16,
        pub shiny: bool,
        pub constructed: bool,
        pub in_fleet: bool,
        pub is_free_ship: bool,
        /// Seconds; 0 = not destroyed.
        pub timestamp_destroyed: u64,
    }
);

game_struct!(
    /// The rules-relevant part of a ship (Types.sol `Ship` minus `owner`,
    /// which the contract keeps beside it).
    pub struct Ship {
        pub name: String,
        pub id: u64,
        pub equipment: Equipment,
        pub traits: Traits,
        pub ship_data: ShipData,
    }
);

game_struct!(
    /// Inputs to the stat calculation (Types.sol `ShipStatsInput`).
    pub struct ShipStatsInput {
        pub id: u64,
        pub equipment: Equipment,
        pub variant: u16,
        pub accuracy: u8,
        pub hull: u8,
        pub speed: u8,
        pub ships_destroyed: u32,
    }
);

impl Ship {
    pub fn stats_input(&self) -> ShipStatsInput {
        ShipStatsInput {
            id: self.id,
            equipment: self.equipment.clone(),
            variant: self.traits.variant,
            accuracy: self.traits.accuracy,
            hull: self.traits.hull,
            speed: self.traits.speed,
            ships_destroyed: self.ship_data.ships_destroyed,
        }
    }
}

game_struct!(
    /// accuracy/hull/speed indexed by trait tier (len 3); equipment arrays by
    /// enum value (len 8).
    pub struct Costs {
        pub version: u16,
        pub base_cost: u8,
        pub accuracy: Vec<u8>,
        pub hull: Vec<u8>,
        pub speed: Vec<u8>,
        pub main_weapon: Vec<u8>,
        pub armor: Vec<u8>,
        pub shields: Vec<u8>,
        pub special: Vec<u8>,
    }
);

game_struct!(pub struct GunData { pub range: u8, pub damage: u8, pub movement: i8 });
game_struct!(pub struct ArmorData { pub damage_reduction: u8, pub movement: i8 });
game_struct!(pub struct ShieldData { pub damage_reduction: u8, pub movement: i8 });
game_struct!(pub struct SpecialData { pub range: u8, pub strength: u8, pub movement: i8 });

game_struct!(
    /// One immutable published (variant, version) attribute table.
    pub struct VariantAttributeData {
        pub base_hull: u8,
        pub base_speed: u8,
        pub fore_accuracy: Vec<u8>,
        pub hull: Vec<u8>,
        pub engine_speeds: Vec<u8>,
        pub guns: Vec<GunData>,
        pub armors: Vec<ArmorData>,
        pub shields: Vec<ShieldData>,
        pub specials: Vec<SpecialData>,
        pub rank_thresholds: Vec<u32>,
        pub rank_bonus_pct: Vec<u8>,
    }
);

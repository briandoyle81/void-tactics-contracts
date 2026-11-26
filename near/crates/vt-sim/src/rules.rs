//! Game rules for off-chain play, loaded from near/seed/config.json (the
//! rules the Solidity deploy publishes and the NEAR seeder mirrors).
//!
//! `LocalRules` implements vt-core's `Rules` (resolvers and versioned special
//! data); `Config` adds the attribute and cost tables and economy settings
//! needed to build ships and fleets.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde_json::Value;
use vt_core::attributes::{calculate, ship_cost};
use vt_core::effects::Resolver;
use vt_core::engine::Rules;
use vt_core::types::{
    ArmorData, Attributes, Costs, GunData, ShieldData, Ship, Special, SpecialData,
    VariantAttributeData,
};
use vt_core::{Error, Result};

/// The repository root (this crate lives at near/crates/vt-sim).
pub fn repo_root() -> PathBuf {
    let p = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    p.canonicalize().unwrap_or(p)
}

pub fn read_json(rel: &str) -> Value {
    // Simulator-only (2026-11-26): VT_SIM_OVERRIDE="rel=path;rel=path"
    // replaces a data file (e.g. near/seed/config.json) for A/B runs.
    let p = std::env::var("VT_SIM_OVERRIDE")
        .ok()
        .and_then(|v| {
            v.split(';')
                .filter_map(|kv| kv.split_once('='))
                .find(|(k, _)| *k == rel)
                .map(|(_, path)| std::path::PathBuf::from(path))
        })
        .unwrap_or_else(|| repo_root().join(rel));
    serde_json::from_str(
        &std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("{}: {e}", p.display())),
    )
    .unwrap_or_else(|e| panic!("{}: {e}", p.display()))
}

fn n(v: &Value) -> u64 {
    match v {
        Value::String(s) => s.parse().unwrap_or_else(|_| panic!("not a number: {s}")),
        other => other
            .as_u64()
            .unwrap_or_else(|| panic!("not a u64: {other}")),
    }
}

fn i(v: &Value) -> i64 {
    match v {
        Value::String(s) => s.parse().unwrap_or_else(|_| panic!("not a number: {s}")),
        other => other
            .as_i64()
            .unwrap_or_else(|| panic!("not an i64: {other}")),
    }
}

fn u8s(v: &Value) -> Vec<u8> {
    v.as_array().unwrap().iter().map(|x| n(x) as u8).collect()
}

/// near/seed/config.json attribute table (camelCase) to the vt-core type.
pub fn attribute_table(v: &Value) -> VariantAttributeData {
    VariantAttributeData {
        base_hull: n(&v["baseHull"]) as u8,
        base_speed: n(&v["baseSpeed"]) as u8,
        fore_accuracy: u8s(&v["foreAccuracy"]),
        hull: u8s(&v["hull"]),
        engine_speeds: u8s(&v["engineSpeeds"]),
        guns: v["guns"]
            .as_array()
            .unwrap()
            .iter()
            .map(|g| GunData {
                range: n(&g["range"]) as u8,
                damage: n(&g["damage"]) as u8,
                movement: i(&g["movement"]) as i8,
            })
            .collect(),
        armors: v["armors"]
            .as_array()
            .unwrap()
            .iter()
            .map(|a| ArmorData {
                damage_reduction: n(&a["damageReduction"]) as u8,
                movement: i(&a["movement"]) as i8,
            })
            .collect(),
        shields: v["shields"]
            .as_array()
            .unwrap()
            .iter()
            .map(|a| ShieldData {
                damage_reduction: n(&a["damageReduction"]) as u8,
                movement: i(&a["movement"]) as i8,
            })
            .collect(),
        specials: v["specials"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| SpecialData {
                range: n(&s["range"]) as u8,
                strength: n(&s["strength"]) as u8,
                movement: i(&s["movement"]) as i8,
            })
            .collect(),
        rank_thresholds: v["rankThresholds"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| n(x) as u32)
            .collect(),
        rank_bonus_pct: u8s(&v["rankBonusPct"]),
    }
}

fn costs(v: &Value) -> Costs {
    Costs {
        version: 1,
        base_cost: n(&v["baseCost"]) as u8,
        accuracy: u8s(&v["accuracy"]),
        hull: u8s(&v["hull"]),
        speed: u8s(&v["speed"]),
        main_weapon: u8s(&v["mainWeapon"]),
        armor: u8s(&v["armor"]),
        shields: u8s(&v["shields"]),
        special: u8s(&v["special"]),
    }
}

/// vt-core `Rules`: faction and special resolvers, versioned special data.
#[derive(Clone)]
pub struct LocalRules {
    tables: HashMap<(u16, u16), VariantAttributeData>,
    latest: HashMap<u16, u16>,
    faction: HashMap<u16, Resolver>,
    special: HashMap<(u16, u8), Resolver>,
}

impl LocalRules {
    /// Built from the same near/seed/config.json the seeder publishes.
    pub fn from_seed_config() -> LocalRules {
        Self::from_config_json(&read_json("near/seed/config.json"))
    }

    pub fn from_config_json(cfg: &Value) -> LocalRules {
        let mut r = LocalRules {
            tables: HashMap::new(),
            latest: HashMap::new(),
            faction: HashMap::new(),
            special: HashMap::new(),
        };
        for (variant, v) in cfg["variants"].as_object().unwrap() {
            let variant: u16 = variant.parse().unwrap();
            for (k, t) in v["attributeVersions"]
                .as_array()
                .unwrap()
                .iter()
                .enumerate()
            {
                r.tables.insert((variant, k as u16 + 1), attribute_table(t));
                r.latest.insert(variant, k as u16 + 1);
            }
        }
        r.faction.insert(
            1,
            Resolver::Ram {
                range: n(&cfg["ram"]["range"]) as u8,
            },
        );
        r.faction.insert(
            2,
            Resolver::Repair {
                range: n(&cfg["repair"]["range"]) as u8,
                strength: n(&cfg["repair"]["strength"]) as u8,
            },
        );
        for e in cfg["specialResolvers"].as_array().unwrap() {
            let (v, s) = (n(&e[0]) as u16, n(&e[1]) as u8);
            let slot = Special::from_index(s as usize).unwrap();
            let res = match e[2].as_str().unwrap() {
                "Emp" => Resolver::Emp { slot },
                "RepairDrones" => Resolver::RepairDrones { slot },
                "FlakArray" => Resolver::FlakArray { slot },
                "ElectricStorm" => Resolver::ElectricStorm { slot },
                _ => Resolver::DroneSwarm { slot },
            };
            r.special.insert((v, s), res);
        }
        r
    }

    pub fn table(&self, variant: u16, version: u16) -> Option<&VariantAttributeData> {
        self.tables.get(&(variant, version))
    }
}

impl Rules for LocalRules {
    fn faction_resolver(&self, variant: u16) -> Option<Resolver> {
        self.faction.get(&variant).copied()
    }
    fn special_resolver(&self, variant: u16, slot: Special) -> Option<Resolver> {
        self.special.get(&(variant, slot as u8)).copied()
    }
    fn special_data_at(&self, variant: u16, version: u16, slot: Special) -> Result<SpecialData> {
        if version == 0 || version > *self.latest.get(&variant).unwrap_or(&0) {
            return Err(Error::InvalidAttributesVersion);
        }
        Ok(self.tables[&(variant, version)].specials[slot.index()].clone())
    }
}

/// Everything rule-like a simulated game needs.
#[derive(Clone)]
pub struct Config {
    pub rules: LocalRules,
    pub current_version: HashMap<u16, u16>,
    pub costs: HashMap<u16, Costs>,
    pub max_special_slot: HashMap<u16, u8>,
    pub heal_cap_percent: u8,
    pub storefront_tiers: Vec<u32>,
    pub claim_cooldown_s: u64,
    pub max_variant: u16,
}

impl Config {
    pub fn load() -> Config {
        let cfg = read_json("near/seed/config.json");
        let rules = LocalRules::from_config_json(&cfg);
        let mut current_version = HashMap::new();
        let mut cost_tables = HashMap::new();
        let mut max_special_slot = HashMap::new();
        for (variant, v) in cfg["variants"].as_object().unwrap() {
            let variant: u16 = variant.parse().unwrap();
            current_version.insert(variant, n(&v["currentAttributesVersion"]) as u16);
            cost_tables.insert(variant, costs(&v["costs"]));
            max_special_slot.insert(variant, n(&v["maxSpecialSlot"]) as u8);
        }
        crate::eval::set_repair_kinds(&rules, &max_special_slot);
        Config {
            rules,
            current_version,
            costs: cost_tables,
            max_special_slot,
            heal_cap_percent: n(&cfg["healCapPercent"]) as u8,
            storefront_tiers: cfg["storefrontTiers"]
                .as_array()
                .unwrap()
                .iter()
                .map(|t| n(t) as u32)
                .collect(),
            claim_cooldown_s: n(&cfg["claimCooldownSeconds"]),
            max_variant: n(&cfg["maxVariant"]) as u16,
        }
    }

    /// The variant's current attribute table (the contract's `current_table`).
    pub fn current_table(&self, variant: u16) -> (u16, &VariantAttributeData) {
        let v = self.current_version[&variant];
        (v, self.rules.table(variant, v).expect("published"))
    }

    /// A ship's rank (1 = no stars earned yet) under the current table.
    pub fn rank(&self, ship: &Ship) -> u8 {
        let (_, table) = self.current_table(ship.traits.variant);
        vt_core::attributes::rank_of(table, ship.ship_data.ships_destroyed as u64)
    }

    /// A ship's battle stats under the current table (as fleets use them).
    pub fn attributes(&self, ship: &Ship) -> Result<Attributes> {
        let (version, table) = self.current_table(ship.traits.variant);
        let mut a = calculate(table, version, &ship.stats_input())?;
        if let Some((lo, hi)) = movement_clamp() {
            a.movement = a.movement.clamp(lo, hi);
        }
        Ok(a)
    }

    /// A ship's fleet cost under the variant's current cost table.
    pub fn cost(&self, ship: &Ship) -> Result<u16> {
        ship_cost(&self.costs[&ship.traits.variant], ship)
    }
}

/// Simulator-only experiment (2026-11-25): `VT_SIM_MOVE_CLAMP=lo,hi` clamps
/// every ship's final movement, to test whether the movement range (1-7 v1,
/// 1-9 v2 on chain) rather than the equipment's damage reduction is what
/// makes slow, heavily protected ships weak. Unset: the on-chain rules.
pub fn movement_clamp() -> Option<(u8, u8)> {
    static C: std::sync::OnceLock<Option<(u8, u8)>> = std::sync::OnceLock::new();
    *C.get_or_init(|| {
        let v = std::env::var("VT_SIM_MOVE_CLAMP").ok()?;
        let (lo, hi) = v.split_once(',').expect("VT_SIM_MOVE_CLAMP=lo,hi");
        Some((lo.trim().parse().expect("lo"), hi.trim().parse().expect("hi")))
    })
}

//! A simple scripted "human" for sandbox games, using vt-core locally to pick
//! only legal moves (so tests never burn blocks on rejected transactions).

use std::collections::HashMap;

use serde_json::Value;
use vt_core::effects::Resolver;
use vt_core::engine::{GameState, MoveInput, Rules, Side};
use vt_core::types::{ActionType, Special, SpecialData, VariantAttributeData};
use vt_core::{Error, Result};

pub struct LocalRules {
    tables: HashMap<(u16, u16), VariantAttributeData>,
    latest: HashMap<u16, u16>,
    faction: HashMap<u16, Resolver>,
    special: HashMap<(u16, u8), Resolver>,
}

impl LocalRules {
    /// Built from the same near/seed/config.json the seeder publishes.
    pub fn from_seed_config() -> LocalRules {
        let cfg: Value = serde_json::from_str(&std::fs::read_to_string(crate::seed::repo_path("near/seed/config.json")).unwrap()).unwrap();
        let mut r = LocalRules { tables: HashMap::new(), latest: HashMap::new(), faction: HashMap::new(), special: HashMap::new() };
        for (variant, v) in cfg["variants"].as_object().unwrap() {
            let variant: u16 = variant.parse().unwrap();
            for (i, t) in v["attributeVersions"].as_array().unwrap().iter().enumerate() {
                let table: VariantAttributeData = serde_json::from_value(crate::seed::attribute_table_json(t)).unwrap();
                r.tables.insert((variant, i as u16 + 1), table);
                r.latest.insert(variant, i as u16 + 1);
            }
        }
        r.faction.insert(1, Resolver::Ram { range: cfg["ram"]["range"].as_u64().unwrap() as u8 });
        r.faction.insert(
            2,
            Resolver::Repair { range: cfg["repair"]["range"].as_u64().unwrap() as u8, strength: cfg["repair"]["strength"].as_u64().unwrap() as u8 },
        );
        for e in cfg["specialResolvers"].as_array().unwrap() {
            let (v, s) = (e[0].as_u64().unwrap() as u16, e[1].as_u64().unwrap() as u8);
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

fn legal(g: &GameState, rules: &LocalRules, m: &MoveInput) -> bool {
    g.clone().move_ship(Side::Creator, m, rules, 0).is_ok()
}

/// Ram downed enemies, else shoot, else advance-and-shoot, else advance,
/// else pass. Returns None if the human has no ship that can act.
pub fn choose_human_move(g: &GameState, rules: &LocalRules) -> Option<MoveInput> {
    let me = g.creator_active.iter().copied().find(|&id| g.ship(id).hull_points > 0 && !g.has_moved(id))?;
    let b = g.ship(me);
    let mut enemies: Vec<u64> = g.joiner_active.clone();
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

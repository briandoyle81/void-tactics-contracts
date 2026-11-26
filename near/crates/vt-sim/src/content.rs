//! Game content from ignition/data/*.json (the files Base's deploy module and
//! the NEAR seeder publish): maps, AI ship configs and placements, the
//! roguelike campaign, PvP maps. Everything is keyed by the content key;
//! reports name missions by node id and title ("6. Counterattack").
//!
//! The single-player campaign in singlePlayerStarterContent.json is a stub
//! (2026-11-20) and is not loaded: only its maps, AI configs and placements
//! are (some roguelike missions fight on them). `sp_nodes` is instead the
//! roguelike's combat missions reachable from the root, as single fights
//! under the cost cap a run has when it gets there. Roguelike nodes that
//! can't be reached from the root are dropped.

use std::collections::{BTreeMap, HashMap};

use serde_json::Value;
use vt_core::ai::AiShipInfo;
use vt_core::engine::FleetEntry;
use vt_core::maps::PresetMap;
use vt_core::types::*;

use crate::rules::{read_json, Config};

/// AI ship ids start here (AIShips.AI_SHIP_ID_OFFSET); human ids are below.
pub const AI_SHIP_ID_OFFSET: u64 = 1 << 40;
/// Deploy-module values for the roguelike win effects.
pub const DEC_BONUS_AMOUNT: u64 = 20;
pub const HEAL_TO_PERCENT: u8 = 100;

fn n(v: &Value) -> u64 {
    match v {
        Value::String(s) => s.parse().unwrap(),
        other => other.as_u64().unwrap_or(0),
    }
}

fn positions(v: &Value) -> Vec<Position> {
    v.as_array()
        .map(|a| {
            a.iter()
                .map(|p| Position {
                    row: p["row"].as_i64().unwrap() as i16,
                    col: p["col"].as_i64().unwrap() as i16,
                })
                .collect()
        })
        .unwrap_or_default()
}

fn equipment(e: &Value) -> Equipment {
    Equipment {
        main_weapon: MainWeapon::from_index(n(&e["mainWeapon"]) as usize).unwrap(),
        armor: Armor::from_index(n(&e["armor"]) as usize).unwrap(),
        shields: Shields::from_index(n(&e["shields"]) as usize).unwrap(),
        special: Special::from_index(n(&e["special"]) as usize).unwrap(),
    }
}

fn colors(c: &Value) -> Colors {
    Colors {
        h1: n(&c["h1"]) as u16,
        s1: n(&c["s1"]) as u8,
        l1: n(&c["l1"]) as u8,
        h2: n(&c["h2"]) as u16,
        s2: n(&c["s2"]) as u8,
        l2: n(&c["l2"]) as u8,
    }
}

#[derive(Clone, Debug)]
pub struct AiConfig {
    pub key: String,
    pub ship: Ship,
    pub archetype: Archetype,
}

/// A roguelike combat mission played as a single fight (see the module doc).
#[derive(Clone, Debug)]
pub struct SpNode {
    pub key: String,
    /// Node id: 1-based position in roguelikeStarterContent.json's `nodes`
    /// (the on-chain id a fresh deploy assigns).
    pub number: u32,
    pub title: String,
    pub map: String,
    pub prerequisites: Vec<String>,
    pub cost_limit: u64,
    pub turn_time: u64,
    pub max_score: u64,
    pub creator_goes_first: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RlKind {
    Combat,
    Resupply,
}

#[derive(Clone, Debug)]
pub enum WinEffect {
    DecBonus(u64),
    HealAboveFloor(u8),
    /// The granted ship template, and whether it's once per player.
    ShipGrant(Ship, bool),
}

#[derive(Clone, Debug)]
pub struct RlNode {
    pub key: String,
    /// Node id (see `SpNode::number`).
    pub number: u32,
    pub title: String,
    pub kind: RlKind,
    pub map: Option<String>,
    pub turn_time: u64,
    pub max_score: u64,
    pub creator_goes_first: bool,
    pub cost_cap_override: u64,
    pub children: Vec<String>,
    pub win_effects: Vec<WinEffect>,
}

#[derive(Clone, Debug)]
pub struct RlCampaign {
    pub root: String,
    pub auto_heal_percent: u8,
    pub required_variant: u16,
    pub initial_cost_cap: u64,
    pub nodes: BTreeMap<String, RlNode>,
}

#[derive(Clone, Debug)]
pub struct Content {
    pub maps: HashMap<String, PresetMap>,
    pub ai_configs: HashMap<String, AiConfig>,
    /// map key -> [(cell, AI config key)], as authored.
    pub placements: HashMap<String, Vec<(Position, String)>>,
    pub sp_nodes: Vec<SpNode>,
    pub roguelike: RlCampaign,
    /// PvP maps the simulator plays: only the standard match's map
    /// (`arena::STANDARD_PVP_MAP`).
    pub pvp_maps: Vec<String>,
    /// Every PvP map in pvpStarterContent.json (move-generator coverage).
    pub pvp_maps_all: Vec<String>,
}

fn load_map(m: &Value) -> PresetMap {
    let scoring: Vec<ScoringPosition> = m["scoringTiles"]
        .as_array()
        .map(|a| {
            a.iter()
                .map(|s| ScoringPosition {
                    row: s["row"].as_i64().unwrap() as i16,
                    col: s["col"].as_i64().unwrap() as i16,
                    points: n(&s["points"]) as u8,
                    only_once: s["onlyOnce"].as_bool().unwrap_or(false),
                })
                .collect()
        })
        .unwrap_or_default();
    let mode: MapMode = serde_json::from_value(m["mode"].clone()).unwrap();
    let mut p = PresetMap::new(
        &positions(&m["blockedTiles"]),
        &positions(&m["impassableTiles"]),
        &scoring,
        mode,
    )
    .expect("valid map");
    p.set_creator_zone(&positions(&m["creatorZone"]))
        .expect("zone");
    p.set_joiner_zone(&positions(&m["joinerZone"]))
        .expect("zone");
    p
}

impl RlCampaign {
    /// Drops nodes the root can't reach, and returns the cost cap a run has
    /// on arriving at each remaining node (the initial cap, as overridden by
    /// resupply nodes on the way). Panics if two paths reach a node with
    /// different caps (the single-fight cap would be ambiguous).
    fn prune_unreachable(&mut self) -> BTreeMap<String, u64> {
        let mut caps = BTreeMap::from([(self.root.clone(), self.initial_cost_cap)]);
        let mut queue = std::collections::VecDeque::from([self.root.clone()]);
        while let Some(k) = queue.pop_front() {
            let n = &self.nodes[&k];
            let out = if n.cost_cap_override > 0 { n.cost_cap_override } else { caps[&k] };
            for c in &n.children {
                match caps.get(c) {
                    Some(&cap) => assert_eq!(cap, out, "node {c} is reached with cost caps {cap} and {out}"),
                    None => {
                        caps.insert(c.clone(), out);
                        queue.push_back(c.clone());
                    }
                }
            }
        }
        self.nodes.retain(|k, _| caps.contains_key(k));
        caps
    }

    /// Reachable combat nodes as single-fight missions, in node-id order.
    fn missions(&self, caps: &BTreeMap<String, u64>) -> Vec<SpNode> {
        let mut parents: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
        for n in self.nodes.values() {
            for c in &n.children {
                parents.entry(c.as_str()).or_default().push(n.key.as_str());
            }
        }
        let mut out: Vec<SpNode> = self
            .nodes
            .values()
            .filter(|n| n.kind == RlKind::Combat)
            .map(|n| {
                // The nearest combat node before this one (through resupply
                // nodes), for the economy's unlock order.
                let mut prev = parents.get(n.key.as_str()).and_then(|p| p.first().copied());
                while let Some(p) = prev.filter(|p| self.nodes[*p].kind != RlKind::Combat) {
                    prev = parents.get(p).and_then(|q| q.first().copied());
                }
                SpNode {
                    key: n.key.clone(),
                    number: n.number,
                    title: n.title.clone(),
                    map: n.map.clone().unwrap(),
                    prerequisites: prev.map(|p| vec![p.to_string()]).unwrap_or_default(),
                    cost_limit: caps[&n.key],
                    turn_time: n.turn_time,
                    max_score: n.max_score,
                    creator_goes_first: n.creator_goes_first,
                }
            })
            .collect();
        out.sort_by_key(|n| n.number);
        out
    }

    /// Every route from the root to a node with no children.
    pub fn paths(&self) -> Vec<Vec<String>> {
        fn walk(c: &RlCampaign, k: &str, cur: &mut Vec<String>, out: &mut Vec<Vec<String>>) {
            cur.push(k.to_string());
            let n = &c.nodes[k];
            if n.children.is_empty() {
                out.push(cur.clone());
            }
            for ch in &n.children {
                walk(c, ch, cur, out);
            }
            cur.pop();
        }
        let mut out = Vec::new();
        walk(self, &self.root, &mut Vec::new(), &mut out);
        out
    }

    /// "6. Counterattack" (node id and title; the key if untitled).
    pub fn name(&self, key: &str) -> String {
        match self.nodes.get(key) {
            Some(n) if !n.title.is_empty() => format!("{}. {}", n.number, n.title),
            Some(n) => format!("{}. {}", n.number, n.key),
            None => key.to_string(),
        }
    }

    /// A path's branch choices, for labels: the titles picked wherever the
    /// path had more than one child to choose from.
    pub fn path_label(&self, path: &[String]) -> String {
        let picks: Vec<String> = path
            .windows(2)
            .filter(|w| self.nodes[&w[0]].children.len() > 1)
            .map(|w| self.name(&w[1]))
            .collect();
        picks.join(" / ")
    }
}

impl Content {
    /// "6. Counterattack" for a mission key.
    pub fn mission_name(&self, key: &str) -> String {
        self.roguelike.name(key)
    }

    pub fn load() -> Content {
        let sp = read_json("ignition/data/singlePlayerStarterContent.json");
        let rl = read_json("ignition/data/roguelikeStarterContent.json");
        let pvp = read_json("ignition/data/pvpStarterContent.json");
        let mut maps = HashMap::new();
        for src in [&sp, &rl, &pvp] {
            for m in src["maps"].as_array().unwrap() {
                maps.insert(m["key"].as_str().unwrap().to_string(), load_map(m));
            }
        }
        let ai_colors = colors(&sp["aiShipColors"]);
        let ai_configs = sp["aiShipConfigs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| {
                let t = &c["traits"];
                let ship = Ship {
                    name: c["name"].as_str().unwrap().to_string(),
                    id: 0,
                    equipment: equipment(&c["equipment"]),
                    traits: Traits {
                        serial_number: 0,
                        colors: ai_colors.clone(),
                        variant: n(&t["variant"]) as u16,
                        accuracy: n(&t["accuracy"]) as u8,
                        hull: n(&t["hull"]) as u8,
                        speed: n(&t["speed"]) as u8,
                    },
                    // AIShips.allocateShip: constructed, template shiny/kills, unpriced.
                    ship_data: ShipData {
                        shiny: c["shiny"].as_bool().unwrap_or(false),
                        ships_destroyed: n(&c["shipsDestroyed"]) as u32,
                        constructed: true,
                        ..Default::default()
                    },
                };
                let key = c["key"].as_str().unwrap().to_string();
                (
                    key.clone(),
                    AiConfig {
                        key,
                        ship,
                        archetype: Archetype::from_index(n(&c["archetype"]) as usize).unwrap(),
                    },
                )
            })
            .collect();
        let mut placements = HashMap::new();
        for src in [&sp, &rl] {
            for p in src["mapPlacements"].as_array().unwrap() {
                let cells: Vec<(Position, String)> = positions(&p["positions"])
                    .into_iter()
                    .zip(
                        p["configKeys"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .map(|k| k.as_str().unwrap().to_string()),
                    )
                    .collect();
                placements.insert(p["mapKey"].as_str().unwrap().to_string(), cells);
            }
        }
        let mut children: HashMap<String, Vec<String>> = HashMap::new();
        for e in rl["edges"].as_array().unwrap() {
            children
                .entry(e["from"].as_str().unwrap().to_string())
                .or_default()
                .push(e["to"].as_str().unwrap().to_string());
        }
        let nodes = rl["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .enumerate()
            .map(|(i, nd)| {
                let key = nd["key"].as_str().unwrap().to_string();
                let kind = if nd["kind"] == "Combat" {
                    RlKind::Combat
                } else {
                    RlKind::Resupply
                };
                let combat = kind == RlKind::Combat;
                let win_effects = nd["winEffects"]
                    .as_array()
                    .map(|a| {
                        a.iter()
                            .filter_map(|w| match w.as_str().unwrap() {
                                "DEC_BONUS_WIN_EFFECT" => {
                                    Some(WinEffect::DecBonus(DEC_BONUS_AMOUNT))
                                }
                                "HEAL_ABOVE_FLOOR_WIN_EFFECT" => {
                                    Some(WinEffect::HealAboveFloor(HEAL_TO_PERCENT))
                                }
                                "SHIP_GRANT_WIN_EFFECT" => nd.get("shipGrant").map(|g| {
                                    let ship = Ship {
                                        name: g["name"].as_str().unwrap_or("").to_string(),
                                        id: 0,
                                        equipment: equipment(&g["equipment"]),
                                        traits: Traits {
                                            serial_number: 0,
                                            colors: colors(&g["colors"]),
                                            variant: n(&g["variant"]) as u16,
                                            accuracy: n(&g["accuracy"]) as u8,
                                            hull: n(&g["hull"]) as u8,
                                            speed: n(&g["speed"]) as u8,
                                        },
                                        ship_data: ShipData {
                                            ships_destroyed: n(&g["shipsDestroyed"]) as u32,
                                            shiny: g["shiny"].as_bool().unwrap_or(false),
                                            is_free_ship: g["isFreeShip"]
                                                .as_bool()
                                                .unwrap_or(false),
                                            constructed: true,
                                            ..Default::default()
                                        },
                                    };
                                    WinEffect::ShipGrant(
                                        ship,
                                        g["oncePerAddress"].as_bool().unwrap_or(false),
                                    )
                                }),
                                _ => None,
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                let node = RlNode {
                    key: key.clone(),
                    number: i as u32 + 1,
                    title: nd["title"].as_str().unwrap_or("").to_string(),
                    kind,
                    map: if combat {
                        Some(nd["mapKey"].as_str().unwrap().to_string())
                    } else {
                        None
                    },
                    turn_time: if combat { n(&nd["turnTime"]) } else { 0 },
                    max_score: if combat { n(&nd["maxScore"]) } else { 0 },
                    creator_goes_first: nd["creatorGoesFirst"].as_bool().unwrap_or(false),
                    cost_cap_override: if combat { 0 } else { n(&nd["costCapOverride"]) },
                    children: children.remove(&key).unwrap_or_default(),
                    win_effects,
                };
                (key, node)
            })
            .collect();
        let c = &rl["campaign"];
        let mut roguelike = RlCampaign {
            root: rl["root"].as_str().unwrap().to_string(),
            auto_heal_percent: n(&c["autoHealPercent"]) as u8,
            required_variant: n(&c["requiredVariant"]) as u16,
            initial_cost_cap: n(&c["initialCostCap"]),
            nodes,
        };
        let caps = roguelike.prune_unreachable();
        let sp_nodes = roguelike.missions(&caps);
        let pvp_maps_all: Vec<String> = pvp["maps"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| m["key"].as_str().unwrap().to_string())
            .collect();
        let std_map = crate::arena::STANDARD_PVP_MAP;
        assert!(
            pvp_maps_all.iter().any(|k| k == std_map),
            "standard PvP map {std_map} missing from pvpStarterContent.json"
        );
        let pvp_maps = vec![std_map.to_string()];
        Content {
            maps,
            ai_configs,
            placements,
            sp_nodes,
            roguelike,
            pvp_maps,
            pvp_maps_all,
        }
    }

    /// SinglePlayerMatch/RoguelikeMatch._mintAIFleet: the map's AI fleet as
    /// fleet entries (ascending cell order, ids 2^40 + 1..) plus the AI info
    /// the on-chain AI needs for each ship.
    pub fn ai_fleet(&self, cfg: &Config, map: &str) -> (Vec<FleetEntry>, HashMap<u64, AiShipInfo>) {
        let mut cells: Vec<(u16, &String)> = self
            .placements
            .get(map)
            .map(|v| {
                v.iter()
                    .map(|(p, k)| ((p.row * vt_core::grid::GRID_WIDTH + p.col) as u16, k))
                    .collect()
            })
            .unwrap_or_default();
        cells.sort_by_key(|c| c.0);
        let mut fleet = Vec::new();
        let mut info = HashMap::new();
        for (k, (cell, key)) in cells.iter().enumerate() {
            let c = &self.ai_configs[*key];
            let id = AI_SHIP_ID_OFFSET + k as u64 + 1;
            let ship = Ship {
                id,
                ..c.ship.clone()
            };
            let attributes = cfg.attributes(&ship).expect("AI ship attributes");
            let (row, col) = (
                (*cell as i16) / vt_core::grid::GRID_WIDTH,
                (*cell as i16) % vt_core::grid::GRID_WIDTH,
            );
            fleet.push(FleetEntry {
                ship_id: id,
                row,
                col,
                attributes,
                variant: ship.traits.variant,
                special: ship.equipment.special,
            });
            info.insert(
                id,
                AiShipInfo {
                    archetype: c.archetype,
                    variant: ship.traits.variant,
                    special: ship.equipment.special,
                },
            );
        }
        (fleet, info)
    }

    /// Valid deployment tiles for a side on a map (custom zone, or the
    /// default column band).
    pub fn deployment_tiles(&self, map: Option<&str>, is_creator: bool) -> Vec<Position> {
        let default = PresetMap::default();
        let m = map.and_then(|k| self.maps.get(k)).unwrap_or(&default);
        let mut out = Vec::new();
        for row in 0..vt_core::grid::GRID_HEIGHT {
            for col in 0..vt_core::grid::GRID_WIDTH {
                if m.is_valid_deployment_tile(row, col, is_creator) {
                    out.push(Position { row, col });
                }
            }
        }
        out
    }
}

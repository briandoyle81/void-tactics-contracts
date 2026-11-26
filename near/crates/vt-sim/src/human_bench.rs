//! `vt-sim human-bench`: plays a human's recorded campaign fleets with the
//! Excellent player, so its strength can be compared with a real strong
//! player fleet for fleet (`docs/sim-human-benchmark-2026-11-17.md`).
//!
//! Input (`near/sim/human/bench.json`):
//! ```json
//! {"attempts": [{"node": "m13", "network": "base", "result": "win",
//!   "destroyed": 0, "retreated": 1, "notes": "...",
//!   "ships": [{"variant": 1, "weapon": "Sniper", "armor": "None",
//!     "shields": "Light", "special": "None", "accuracy": 1, "hull": 0,
//!     "speed": 2, "kills": 0}]}]}
//! ```
//! Each attempt's fleet is rebuilt exactly (traits, equipment, rank), priced
//! with the current cost table, placed by the Excellent composer against the
//! node's AI fleet, and played `seeds` times by Excellent tactics.

use std::collections::HashMap;

use rand::SeedableRng;
use rand_chacha::ChaCha8Rng;
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use vt_core::types::{Armor, MainWeapon, Shields, Ship, Special};

use crate::composition::compose::{ComposeCtx, Composer, Foe};
use crate::content::Content;
use crate::eval::LossPrefs;
use crate::fleet;
use crate::log::MatchLog;
use crate::rules::Config;
use crate::runner::{play_match, AiSide, Controller, Limits, SideSetup};
use crate::tactics::{Level, Tactician, TacticsConfig};

#[derive(Clone, Debug, Deserialize)]
pub struct BenchFile {
    pub attempts: Vec<Attempt>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Attempt {
    pub node: String,
    /// "campaign" (default) or "roguelike". Roguelike attempts are played
    /// as single fights at full HP (the human's carried damage isn't
    /// modelled), under no cost cap beyond the fleet itself.
    #[serde(default)]
    pub mode: String,
    #[serde(default)]
    pub network: String,
    /// "win" | "loss" | "draw".
    pub result: String,
    #[serde(default)]
    pub destroyed: u32,
    #[serde(default)]
    pub retreated: u32,
    #[serde(default)]
    pub notes: String,
    pub ships: Vec<ShipSpec>,
    /// HP each ship starts the fight with, aligned with `ships` (0 or
    /// missing = full). For roguelike fights, the damage carried in.
    #[serde(default)]
    pub start_hp: Vec<u8>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct ShipSpec {
    pub variant: u16,
    pub weapon: MainWeapon,
    pub armor: Armor,
    pub shields: Shields,
    pub special: Special,
    pub accuracy: u8,
    pub hull: u8,
    pub speed: u8,
    /// Rank kills (ships destroyed).
    #[serde(default)]
    pub kills: u32,
}

impl ShipSpec {
    /// This exact ship, priced under the current cost table.
    pub fn build(&self, cfg: &Config, id: u64) -> Ship {
        let mut s = fleet::roll_ship(cfg, id, self.variant, id, 0);
        s.equipment.main_weapon = self.weapon;
        s.equipment.armor = self.armor;
        s.equipment.shields = self.shields;
        s.equipment.special = self.special;
        s.traits.accuracy = self.accuracy;
        s.traits.hull = self.hull;
        s.traits.speed = self.speed;
        s.ship_data.ships_destroyed = self.kills;
        fleet::price(cfg, &mut s);
        s
    }
}

/// The parts of a campaign or roguelike node a fight needs.
struct NodeSpec {
    key: String,
    map: String,
    cost_limit: u64,
    max_score: u64,
    creator_goes_first: bool,
    kind: &'static str,
}

#[derive(Clone, Debug, Serialize)]
pub struct AttemptResult {
    pub node: String,
    pub human_result: String,
    pub human_destroyed: u32,
    pub human_retreated: u32,
    pub fleet_cost: u64,
    pub cost_cap: u64,
    pub games: u32,
    pub sim_clear_rate: f64,
    pub sim_destroyed_per_game: f64,
    pub sim_retreated_per_game: f64,
}

/// Plays every attempt `seeds` times with Excellent tactics (loss aversion
/// `aversion` per average ship, as a careful player). Returns per-attempt
/// results and every game's log.
pub fn run(
    content: &Content,
    cfg: &Config,
    composer: &dyn Composer,
    tc: &TacticsConfig,
    eval: &crate::eval::Eval,
    file: &BenchFile,
    seeds: u32,
    aversion: f32,
) -> Result<(Vec<AttemptResult>, Vec<MatchLog>), String> {
    let mut results = Vec::new();
    let mut logs = Vec::new();
    for (k, a) in file.attempts.iter().enumerate() {
        let roguelike = a.mode == "roguelike";
        let node = if roguelike {
            let n = content
                .roguelike
                .nodes
                .get(&a.node)
                .ok_or_else(|| format!("attempt {k}: unknown roguelike node {}", a.node))?;
            let map = n
                .map
                .clone()
                .ok_or_else(|| format!("attempt {k}: roguelike node {} has no combat", a.node))?;
            NodeSpec {
                key: n.key.clone(),
                map,
                cost_limit: u64::MAX,
                max_score: n.max_score,
                creator_goes_first: n.creator_goes_first,
                kind: "roguelike",
            }
        } else {
            let n = content
                .sp_nodes
                .iter()
                .find(|n| n.key == a.node)
                .ok_or_else(|| format!("attempt {k}: unknown node {}", a.node))?;
            NodeSpec {
                key: n.key.clone(),
                map: n.map.clone(),
                cost_limit: n.cost_limit,
                max_score: n.max_score,
                creator_goes_first: n.creator_goes_first,
                kind: "campaign",
            }
        };
        let node = &node;
        let ships: Vec<Ship> = a
            .ships
            .iter()
            .enumerate()
            .map(|(i, s)| s.build(cfg, (k as u64 + 1) * 1000 + i as u64 + 1))
            .collect();
        let refs: Vec<&Ship> = ships.iter().collect();
        let carried: Vec<(u64, u8)> = ships
            .iter()
            .zip(a.start_hp.iter().chain(std::iter::repeat(&0)))
            .map(|(s, &hp)| (s.id, hp))
            .collect();
        let cost = fleet::cost(&refs);
        if cost > node.cost_limit {
            eprintln!(
                "warning: attempt {k} ({}): fleet costs {cost} under the current cost table, over the cap {}",
                a.node, node.cost_limit
            );
        }
        let ai = AiSide::for_map(content, cfg, &node.map);
        let mean = cost as f64 / refs.len().max(1) as f64;
        let prefs = LossPrefs {
            own: refs
                .iter()
                .map(|s| (s.id, aversion * crate::economy::ship_loss_weight(cfg, s, mean) as f32))
                .collect::<HashMap<_, _>>(),
            ..LossPrefs::uniform(aversion)
        };
        let t: Box<dyn Tactician> = tc.make_with(Level::Excellent, eval, Some(prefs));
        let games: Vec<MatchLog> = (0..seeds)
            .into_par_iter()
            .map(|seed| {
                let mut rng = ChaCha8Rng::seed_from_u64(crate::arena::mix(k as u64, seed as u64, 77));
                let ctx = ComposeCtx {
                    content,
                    cfg,
                    map: &node.map,
                    is_creator: true,
                    cap: node.cost_limit,
                    max_score: node.max_score,
                    creator_goes_first: node.creator_goes_first,
                    variant: None,
                    carried: &carried,
                    foe: Foe::Ai(&ai),
                    survival_weight: 0.5,
                    repair_ships: 0,
                };
                let cells = composer.place(&ctx, &refs, &mut rng);
                let me = SideSetup {
                    label: format!("human-bench#{k}"),
                    ships: refs.clone(),
                    cells,
                    controller: Controller::Agent(t.as_ref()),
                    ai_keys: HashMap::new(),
                };
                play_match(
                    cfg,
                    node.kind,
                    seed as u64,
                    &node.map,
                    Some(&node.key),
                    &content.maps[&node.map],
                    me,
                    ai.side(),
                    node.creator_goes_first,
                    node.max_score,
                    &carried,
                    Limits::default(),
                    &mut rng,
                )
                .log
            })
            .collect();
        let n = games.len().max(1) as f64;
        let count = |outcome: &str| {
            games
                .iter()
                .map(|m| {
                    m.ship_logs
                        .iter()
                        .filter(|s| s.side == 0 && s.outcome == outcome)
                        .count()
                })
                .sum::<usize>() as f64
                / n
        };
        results.push(AttemptResult {
            node: a.node.clone(),
            human_result: a.result.clone(),
            human_destroyed: a.destroyed,
            human_retreated: a.retreated,
            fleet_cost: cost,
            cost_cap: if roguelike { cost } else { node.cost_limit },
            games: games.len() as u32,
            sim_clear_rate: games.iter().filter(|m| m.winner == "creator").count() as f64 / n,
            sim_destroyed_per_game: count("destroyed"),
            sim_retreated_per_game: count("fled"),
        });
        logs.extend(games);
    }
    Ok((results, logs))
}

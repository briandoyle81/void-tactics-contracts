//! The experiment stages. Each computes its units (streamed, resumable; see
//! `units`) and writes its aggregate to `DIR/<stage>.json` for the report.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::Path;

use rand::{Rng, SeedableRng};
use rand_chacha::ChaCha8Rng;
use serde::{Deserialize, Serialize};
use serde_json::json;
use vt_core::attributes::rank_of;
use vt_core::types::Ship;

use super::stats::{bradley_terry_elo, logistic, mean_ci};
use super::{stage_path, units, ExperimentConfig};
use crate::arena::mix;
use crate::composition::bench::{
    build_meta, mixed_pool, pvp_game as shared_pool_game, Player as PoolPlayer,
};
use crate::composition::compose::{ComposeCtx, Foe, SearchParams};
use crate::composition::place::heuristic_cells;
use crate::economy::{
    load_state, pvp_game_sided, run_to_dir, summarize, Player, SimOpts, Start, World,
};
use crate::eval::Eval;
use crate::experiments::roll_pool;
use crate::fleet;
use crate::runner::{play_match, run_roguelike, AiSide, Controller, Limits, SideSetup};
use crate::tactics::{Level, Tactician, TacticsConfig};

pub struct Ctx<'a> {
    pub world: &'a World<'a>,
    pub eval: &'a Eval,
    pub tc: &'a TacticsConfig,
    pub sp: &'a SearchParams,
    pub exp: &'a ExperimentConfig,
    pub dir: &'a Path,
    pub fingerprint: &'a str,
    pub fresh: bool,
}

/// Stage numbers for seeding (stable: never reorder).
const S_COMPONENTS_FIT: u64 = 1;
const S_COMPONENTS_PICK: u64 = 2;
const S_PVE: u64 = 3;
const S_RL: u64 = 4;
const S_FACTORIAL: u64 = 5;
const S_MATRIX: u64 = 6;

fn write(ctx: &Ctx, stage: &str, v: &serde_json::Value) -> std::io::Result<()> {
    std::fs::write(
        stage_path(ctx.dir, stage),
        serde_json::to_string_pretty(v)? + "\n",
    )
}

fn chunk(ctx: &Ctx) -> usize {
    // Enough parallel work per flush; small enough to lose little on a stop.
    let _ = ctx;
    rayon::current_num_threads() * 2
}

/// The nine archetypes in report order (FTP, Casual, Whale × skill).
pub fn archetypes(ctx: &Ctx) -> Vec<(String, Level)> {
    let order = ["ftp", "casual", "whale"];
    let mut spends: Vec<&String> = ctx.world.profiles.spend.keys().collect();
    spends.sort_by_key(|s| order.iter().position(|o| o == s).unwrap_or(99));
    spends
        .into_iter()
        .flat_map(|s| Level::ALL.iter().map(move |&l| (s.clone(), l)))
        .collect()
}

pub fn label(a: &(String, Level)) -> String {
    format!("{}/{}", a.0, a.1.name())
}

// ============================================================ components

/// Cost-table entries as features (per variant; baselines folded into
/// `count`): count, rank, weapon/armor/shields/special/trait tiers.
pub fn feature_names(ctx: &Ctx) -> Vec<String> {
    let cfg = ctx.world.cfg;
    let mut v = Vec::new();
    for variant in [1u16, 2] {
        let p = format!("v{variant}");
        v.push(format!("{p}.count"));
        v.push(format!("{p}.rank"));
        for w in ["Sniper", "Missile", "Close"] {
            v.push(format!("{p}.weapon.{w}"));
        }
        for a in ["Light", "Medium", "Heavy"] {
            v.push(format!("{p}.armor.{a}"));
        }
        for a in ["Light", "Medium", "Heavy"] {
            v.push(format!("{p}.shields.{a}"));
        }
        for s in 1..=cfg.max_special_slot[&variant] {
            v.push(format!("{p}.special.{s}"));
        }
        for t in ["accuracy", "hull", "speed"] {
            for tier in 1..=2 {
                v.push(format!("{p}.{t}.{tier}"));
            }
        }
    }
    v
}

fn enum_name<T: Serialize>(v: &T) -> String {
    serde_json::to_value(v)
        .ok()
        .and_then(|x| x.as_str().map(str::to_string))
        .unwrap_or_default()
}

/// Every cost-table entry a ship uses, baselines included (for pick rates).
pub fn ship_entries(s: &Ship) -> Vec<String> {
    let p = format!("v{}", s.traits.variant);
    let e = &s.equipment;
    vec![
        format!("{p}.weapon.{}", enum_name(&e.main_weapon)),
        format!("{p}.armor.{}", enum_name(&e.armor)),
        format!("{p}.shields.{}", enum_name(&e.shields)),
        format!("{p}.special.{}", e.special.index()),
        format!("{p}.accuracy.{}", s.traits.accuracy),
        format!("{p}.hull.{}", s.traits.hull),
        format!("{p}.speed.{}", s.traits.speed),
    ]
}

fn phi(ctx: &Ctx, names: &HashMap<String, usize>, s: &Ship) -> Vec<(usize, f64)> {
    let cfg = ctx.world.cfg;
    let p = format!("v{}", s.traits.variant);
    let mut out = vec![(names[&format!("{p}.count")], 1.0)];
    let (_, table) = cfg.current_table(s.traits.variant);
    let rank = rank_of(table, s.ship_data.ships_destroyed as u64) as f64 - 1.0;
    if rank > 0.0 {
        out.push((names[&format!("{p}.rank")], rank));
    }
    for e in ship_entries(s) {
        if let Some(&i) = names.get(&e) {
            out.push((i, 1.0));
        }
    }
    out
}

/// The cost-table price of a feature relative to its baseline (count: the
/// cheapest possible ship; rank: free).
fn feature_cost(ctx: &Ctx, name: &str) -> f64 {
    let parts: Vec<&str> = name.split('.').collect();
    let variant: u16 = parts[0][1..].parse().unwrap();
    let c = &ctx.world.cfg.costs[&variant];
    let delta = |t: &[u8], i: usize| t[i] as f64 - t[0] as f64;
    match parts[1] {
        "count" => {
            (c.base_cost as u16
                + c.main_weapon[0] as u16
                + c.armor[0] as u16
                + c.shields[0] as u16
                + c.special[0] as u16
                + c.accuracy[0] as u16
                + c.hull[0] as u16
                + c.speed[0] as u16) as f64
        }
        "rank" => 0.0,
        "weapon" => delta(
            &c.main_weapon,
            ["Generic", "Sniper", "Missile", "Close"]
                .iter()
                .position(|w| *w == parts[2])
                .unwrap(),
        ),
        "armor" => delta(
            &c.armor,
            ["None", "Light", "Medium", "Heavy"]
                .iter()
                .position(|w| *w == parts[2])
                .unwrap(),
        ),
        "shields" => delta(
            &c.shields,
            ["None", "Light", "Medium", "Heavy"]
                .iter()
                .position(|w| *w == parts[2])
                .unwrap(),
        ),
        "special" => delta(&c.special, parts[2].parse().unwrap()),
        "accuracy" => delta(&c.accuracy, parts[2].parse().unwrap()),
        "hull" => delta(&c.hull, parts[2].parse().unwrap()),
        "speed" => delta(&c.speed, parts[2].parse().unwrap()),
        _ => 0.0,
    }
}

pub fn components(ctx: &Ctx, log: &mut dyn FnMut(&str)) -> std::io::Result<()> {
    let w = ctx.world;
    let (content, cfg) = (w.content, w.cfg);
    let names = feature_names(ctx);
    let index: HashMap<String, usize> = names
        .iter()
        .enumerate()
        .map(|(i, n)| (n.clone(), i))
        .collect();
    let k = names.len();
    let avg = w.tacticians[Level::Average as usize].as_ref();
    const BATCH: u32 = 25;
    let batches = ctx.exp.components.fit_games.div_ceil(BATCH) as usize;
    let seed = ctx.exp.seed;
    let fit_units: Vec<Vec<(Vec<f32>, f32)>> = units(
        &ctx.dir.join("components_fit.units.jsonl"),
        batches,
        chunk(ctx),
        |b| {
            (0..BATCH)
                .map(|g| {
                    let mut rng = ChaCha8Rng::seed_from_u64(mix(
                        seed,
                        S_COMPONENTS_FIT,
                        (b as u64) * 1000 + g as u64,
                    ));
                    let map = &content.pvp_maps[rng.gen_range(0..content.pvp_maps.len())];
                    let cap = crate::arena::STANDARD_PVP_CAPS[rng.gen_range(0..2)];
                    let tiles = [
                        content.deployment_tiles(Some(map), true),
                        content.deployment_tiles(Some(map), false),
                    ];
                    let n = tiles[0].len().min(tiles[1].len());
                    let pools: Vec<Vec<Ship>> = (0..2)
                        .map(|s| {
                            roll_pool(
                                cfg,
                                if rng.gen_bool(0.3) { 2 } else { 1 },
                                30,
                                1 + s * 100_000,
                                &mut rng,
                            )
                        })
                        .collect();
                    let fleets: Vec<Vec<&Ship>> = pools
                        .iter()
                        .map(|p| {
                            fleet::random_fleet(p, cap, n, Some(p[0].traits.variant), &mut rng)
                        })
                        .collect();
                    // The creator deploys first (blind); the joiner sees it.
                    let c0 = heuristic_cells(content, cfg, map, true, &fleets[0], None);
                    let c1 = heuristic_cells(
                        content,
                        cfg,
                        map,
                        false,
                        &fleets[1],
                        Some((&fleets[0], &c0)),
                    );
                    let cells = [c0, c1];
                    let side = |s: usize| SideSetup {
                        label: format!("p{s}"),
                        ships: fleets[s].clone(),
                        cells: cells[s].clone(),
                        controller: Controller::Agent(avg),
                        ai_keys: HashMap::new(),
                    };
                    let log = play_match(
                        cfg,
                        "pvp",
                        0,
                        map,
                        None,
                        &content.maps[map],
                        side(0),
                        side(1),
                        true,
                        crate::arena::STANDARD_PVP_MAX_SCORE,
                        &[],
                        Limits::default(),
                        &mut rng,
                    )
                    .log;
                    let mut diff = vec![0f32; k];
                    for (s, sign) in [(0usize, 1.0f32), (1, -1.0)] {
                        for ship in &fleets[s] {
                            for (i, v) in phi(ctx, &index, ship) {
                                diff[i] += sign * v as f32;
                            }
                        }
                    }
                    (diff, crate::arena::creator_points(&log) as f32)
                })
                .collect()
        },
        &mut |d, n| log(&format!("components: fit batches {d}/{n}")),
    )?;
    let rows: Vec<(Vec<f64>, f64)> = fit_units
        .into_iter()
        .flatten()
        .map(|(x, y)| {
            (
                std::iter::once(1.0)
                    .chain(x.iter().map(|&v| v as f64))
                    .collect(),
                y as f64,
            )
        })
        .collect();
    let fit = logistic(&rows, 1.0);
    // Value per cost point, weighted by precision, over priced entries.
    let (mut num, mut den) = (0.0, 0.0);
    let feats: Vec<(String, f64, f64, f64)> = names
        .iter()
        .enumerate()
        .map(|(i, n)| (n.clone(), fit.w[i + 1], fit.se[i + 1], feature_cost(ctx, n)))
        .collect();
    for (_, b, se, c) in &feats {
        if *c != 0.0 && *se > 0.0 {
            num += b * c / (se * se);
            den += c * c / (se * se);
        }
    }
    let lambda = if den > 0.0 { num / den } else { 0.0 };
    let rel = ctx.exp.flags.component_mispricing;
    let entries: Vec<serde_json::Value> = feats
        .iter()
        .map(|(n, b, se, c)| {
            let fair = if lambda != 0.0 { b / lambda } else { f64::NAN };
            let z = (b - lambda * c) / se.max(1e-12);
            let off = (fair - c).abs();
            let verdict = if n.ends_with(".rank") {
                "unpriced (earned)"
            } else if z.abs() > 2.0 && off > 5.0f64.max(rel * c.abs()) {
                if b > &(lambda * c) {
                    "underpriced"
                } else {
                    "overpriced"
                }
            } else {
                "fair"
            };
            json!({"entry": n, "cost": c, "value": b, "se": se, "fair_cost": fair, "z": z, "verdict": verdict})
        })
        .collect();

    // Pick rates: what Excellent composers field, relative to what they had.
    let meta = build_meta(content, cfg, w.values, 12, seed);
    let ex = w.composers[Level::Excellent as usize].as_ref();
    let picks: Vec<BTreeMap<String, (u32, u32)>> = units(
        &ctx.dir.join("components_pick.units.jsonl"),
        ctx.exp.components.pick_composes as usize,
        chunk(ctx),
        |u| {
            let mut rng = ChaCha8Rng::seed_from_u64(mix(seed, S_COMPONENTS_PICK, u as u64));
            let map = &content.pvp_maps[rng.gen_range(0..content.pvp_maps.len())];
            let cap = crate::composition::bench::CAPS[rng.gen_range(0..crate::composition::bench::CAPS.len())];
            let pool = mixed_pool(cfg, 1, &mut rng);
            let creator = rng.gen_bool(0.5);
            let c = ComposeCtx {
                content,
                cfg,
                map,
                is_creator: creator,
                cap,
                max_score: crate::arena::STANDARD_PVP_MAX_SCORE,
                creator_goes_first: true,
                variant: None,
                carried: &[],
                foe: Foe::Meta(&meta[&cap]),
                survival_weight: 0.0,
                repair_ships: 0,
            };
            let l = ex.compose(&c, &pool, &mut rng);
            let mut m: BTreeMap<String, (u32, u32)> = BTreeMap::new();
            for s in &pool {
                let picked = l.ids.contains(&s.id) as u32;
                for e in ship_entries(s) {
                    let x = m.entry(e).or_default();
                    x.0 += 1;
                    x.1 += picked;
                }
            }
            m
        },
        &mut |d, n| log(&format!("components: pick samples {d}/{n}")),
    )?;
    let mut tot: BTreeMap<String, (u64, u64)> = BTreeMap::new();
    for m in picks {
        for (e, (a, p)) in m {
            let x = tot.entry(e).or_default();
            x.0 += a as u64;
            x.1 += p as u64;
        }
    }
    let all_av: u64 = tot.values().map(|x| x.0).sum();
    let all_pk: u64 = tot.values().map(|x| x.1).sum::<u64>().max(1);
    let pick: Vec<serde_json::Value> = tot
        .iter()
        .map(|(e, (a, p))| {
            let ratio = (*p as f64 / all_pk as f64) / (*a as f64 / all_av as f64).max(1e-12);
            json!({"entry": e, "available": a, "picked": p, "pick_rate": *p as f64 / (*a).max(1) as f64, "relative": ratio})
        })
        .collect();
    write(
        ctx,
        "components",
        &json!({"games": rows.len(), "logloss": fit.logloss, "intercept": fit.w[0], "value_per_cost_point": lambda, "entries": entries, "pick_rates": pick}),
    )
}

// ================================================================== pve

#[derive(Serialize, Deserialize)]
pub struct PveUnit {
    pub node: usize,
    pub level: usize,
    pub points: f64,
    pub rounds: u64,
    pub own_destroyed: u32,
    pub own_fled: u32,
    /// Per AI ship: (config key, damage dealt, kills, destroyed, list cost).
    pub ai: Vec<(String, u32, u32, bool, u16)>,
}

pub fn pve(ctx: &Ctx, log: &mut dyn FnMut(&str)) -> std::io::Result<()> {
    let w = ctx.world;
    let (content, cfg) = (w.content, w.cfg);
    let p = ctx.exp.pve.pools_per_node as usize;
    let nodes = content.sp_nodes.len();
    let seed = ctx.exp.seed;
    let res: Vec<PveUnit> = units(
        &ctx.dir.join("pve.units.jsonl"),
        nodes * 3 * p,
        chunk(ctx),
        |u| {
            let (node, level, k) = (u / (3 * p), (u / p) % 3, u % p);
            let n = &content.sp_nodes[node];
            let mut rng = ChaCha8Rng::seed_from_u64(mix(seed, S_PVE, (node * p + k) as u64));
            // The same pool for every level (paired comparison).
            let pool = roll_pool(cfg, 1, ctx.exp.pve.pool_size, 1, &mut rng);
            let mut rng = ChaCha8Rng::seed_from_u64(mix(seed, S_PVE, u as u64 + 1_000_000));
            let ai = AiSide::for_map(content, cfg, &n.map);
            let c = ComposeCtx {
                content,
                cfg,
                map: &n.map,
                is_creator: true,
                cap: n.cost_limit,
                max_score: n.max_score,
                creator_goes_first: n.creator_goes_first,
                variant: Some(1),
                carried: &[],
                foe: Foe::Ai(&ai),
                survival_weight: 0.5,
                repair_ships: 0,
            };
            let l = w.composers[level].compose(&c, &pool, &mut rng);
            let ships: Vec<&Ship> = l
                .ids
                .iter()
                .map(|id| pool.iter().find(|s| s.id == *id).unwrap())
                .collect();
            let me = SideSetup {
                label: "player".into(),
                ships,
                cells: l.cells,
                controller: Controller::Agent(w.tacticians[level].as_ref()),
                ai_keys: HashMap::new(),
            };
            let played = play_match(
                cfg,
                "campaign",
                0,
                &n.map,
                Some(&n.key),
                &content.maps[&n.map],
                me,
                ai.side(),
                n.creator_goes_first,
                n.max_score,
                &[],
                Limits::default(),
                &mut rng,
            );
            let lg = &played.log;
            PveUnit {
                node,
                level,
                points: crate::arena::creator_points(lg),
                rounds: lg.rounds,
                own_destroyed: lg
                    .ship_logs
                    .iter()
                    .filter(|s| s.side == 0 && s.outcome == "destroyed")
                    .count() as u32,
                own_fled: lg
                    .ship_logs
                    .iter()
                    .filter(|s| s.side == 0 && s.outcome == "fled")
                    .count() as u32,
                ai: lg
                    .ship_logs
                    .iter()
                    .filter(|s| s.side == 1)
                    .map(|s| {
                        (
                            s.ai_config.clone().unwrap_or_default(),
                            s.damage_dealt,
                            s.kills,
                            s.outcome == "destroyed",
                            s.list_cost,
                        )
                    })
                    .collect(),
            }
        },
        &mut |d, n| log(&format!("pve: {d}/{n}")),
    )?;
    let mut by: BTreeMap<(usize, usize), Vec<&PveUnit>> = BTreeMap::new();
    for r in &res {
        by.entry((r.node, r.level)).or_default().push(r);
    }
    let node_rows: Vec<serde_json::Value> = (0..nodes)
        .map(|n| {
            let lv: Vec<serde_json::Value> = (0..3)
                .map(|l| {
                    let rs = &by[&(n, l)];
                    let (m, ci) = mean_ci(&rs.iter().map(|r| r.points).collect::<Vec<_>>());
                    json!({"level": Level::ALL[l].name(), "clear": m, "ci95": ci, "rounds": rs.iter().map(|r| r.rounds as f64).sum::<f64>() / rs.len() as f64,
                           "own_destroyed": rs.iter().map(|r| r.own_destroyed as f64).sum::<f64>() / rs.len() as f64})
                })
                .collect();
            json!({"node": content.sp_nodes[n].key, "name": content.mission_name(&content.sp_nodes[n].key), "cost_limit": content.sp_nodes[n].cost_limit, "levels": lv})
        })
        .collect();
    let mut ai: BTreeMap<String, (u32, u64, u32, u32, u16)> = BTreeMap::new();
    for r in &res {
        for (key, dealt, kills, destroyed, cost) in &r.ai {
            let x = ai.entry(key.clone()).or_default();
            x.0 += 1;
            x.1 += *dealt as u64;
            x.2 += kills;
            x.3 += *destroyed as u32;
            x.4 = *cost;
        }
    }
    let ai_rows: Vec<serde_json::Value> = ai
        .iter()
        .map(|(k, (n, dealt, kills, destroyed, cost))| json!({"config": k, "appearances": n, "damage_per_game": *dealt as f64 / *n as f64, "kills_per_game": *kills as f64 / *n as f64, "destroyed_rate": *destroyed as f64 / *n as f64, "list_cost": cost}))
        .collect();
    write(
        ctx,
        "pve",
        &json!({"pools_per_node": p, "nodes": node_rows, "ai_configs": ai_rows}),
    )
}

// ============================================================ roguelike

#[derive(Serialize, Deserialize)]
pub struct RlUnit {
    pub level: usize,
    pub combats_won: u32,
    pub won: bool,
    pub end: String,
    pub ships_lost: usize,
    /// (node key, won) for every combat fought.
    pub combats: Vec<(String, bool)>,
    /// Every node the run visited, in order.
    #[serde(default)]
    pub path: Vec<String>,
    /// The path index the branches were forced onto (None: player's choice).
    #[serde(default)]
    pub forced: Option<usize>,
}

/// Follows `path` at every branch; everything else is `inner`'s call.
struct ForcedPath<'a> {
    inner: &'a dyn crate::runner::RunPlanner,
    path: &'a [String],
}

impl crate::runner::RunPlanner for ForcedPath<'_> {
    fn next_node(&self, v: &crate::runner::RunView, choices: &[&str], rng: &mut ChaCha8Rng) -> usize {
        match choices.iter().position(|c| self.path.iter().any(|p| p == c)) {
            Some(i) => i,
            None => self.inner.next_node(v, choices, rng),
        }
    }
    fn resupply(&self, v: &crate::runner::RunView, rng: &mut ChaCha8Rng) -> crate::runner::ResupplyPlan {
        self.inner.resupply(v, rng)
    }
    fn place(
        &self,
        v: &crate::runner::RunView,
        node: &str,
        ships: &[&Ship],
        rng: &mut ChaCha8Rng,
    ) -> Vec<vt_core::types::Position> {
        self.inner.place(v, node, ships, rng)
    }
}

pub fn roguelike(ctx: &Ctx, log: &mut dyn FnMut(&str)) -> std::io::Result<()> {
    let w = ctx.world;
    let (content, cfg) = (w.content, w.cfg);
    let rl = &content.roguelike;
    let r = ctx.exp.roguelike.runs_per_level as usize;
    let f = ctx.exp.roguelike.runs_per_path as usize;
    let paths = rl.paths();
    let np = paths.len();
    let seed = ctx.exp.seed;
    let free_units = 3 * r;
    let res: Vec<RlUnit> = units(
        &ctx.dir.join("roguelike.units.jsonl"),
        free_units + 3 * np * f,
        chunk(ctx),
        |u| {
            // Free runs: (level, k). Forced runs: (level, path, k), with the
            // same pool for every level on a given (path, k).
            let (level, k, forced) = if u < free_units {
                (u / r, u % r, None)
            } else {
                let i = u - free_units;
                (i / (np * f), 2_000_000 + (i % (np * f)), Some((i / f) % np))
            };
            let mut rng = ChaCha8Rng::seed_from_u64(mix(seed, S_RL, k as u64));
            let pool = roll_pool(
                cfg,
                rl.required_variant.max(1),
                ctx.exp.roguelike.pool_size,
                1,
                &mut rng,
            );
            let mut rng = ChaCha8Rng::seed_from_u64(mix(seed, S_RL, u as u64 + 1_000_000));
            let root = &rl.nodes[&rl.root];
            let map = root.map.as_deref().unwrap();
            let ai = AiSide::for_map(content, cfg, map);
            let c = ComposeCtx {
                content,
                cfg,
                map,
                is_creator: true,
                cap: rl.initial_cost_cap,
                max_score: root.max_score,
                creator_goes_first: root.creator_goes_first,
                variant: Some(rl.required_variant),
                carried: &[],
                foe: Foe::Ai(&ai),
                survival_weight: 1.0,
                repair_ships: crate::composition::compose::ROGUELIKE_REPAIR_SHIPS,
            };
            let roster = w.composers[level].compose(&c, &pool, &mut rng).ids;
            let planner = w.planners[level].as_ref();
            let forced_planner = forced.map(|pi| ForcedPath { inner: planner, path: &paths[pi] });
            let planner: &dyn crate::runner::RunPlanner = match &forced_planner {
                Some(fp) => fp,
                None => planner,
            };
            // Repairs unlimited here: this measures play, not the wallet (the
            // economy stage covers what players can afford).
            let run = run_roguelike(
                content,
                cfg,
                k as u64,
                "rl",
                &pool,
                &roster,
                planner,
                w.tacticians[level].as_ref(),
                &BTreeSet::new(),
                u64::MAX,
                Limits::default(),
                &mut rng,
            );
            RlUnit {
                level,
                combats_won: run.log.combats_won,
                won: run.log.won,
                end: run.log.end.into(),
                ships_lost: run.lost.len(),
                combats: run
                    .matches
                    .iter()
                    .map(|m| (m.node.clone().unwrap_or_default(), m.winner == "creator"))
                    .collect(),
                path: run.log.path.clone(),
                forced,
            }
        },
        &mut |d, n| log(&format!("roguelike: {d}/{n}")),
    )?;
    let summary = |rs: &[&RlUnit]| {
        let n = rs.len().max(1) as f64;
        let mut hist: BTreeMap<u32, u32> = BTreeMap::new();
        for x in rs {
            *hist.entry(x.combats_won).or_default() += 1;
        }
        json!({"runs": rs.len(), "mean_combats_won": rs.iter().map(|x| x.combats_won as f64).sum::<f64>() / n,
               "runs_won": rs.iter().filter(|x| x.won).count(), "mean_ships_lost": rs.iter().map(|x| x.ships_lost as f64).sum::<f64>() / n,
               "combats_won_histogram": hist})
    };
    // Player's-choice runs only: the forced runs would skew the totals.
    let levels: Vec<serde_json::Value> = (0..3)
        .map(|l| {
            let rs: Vec<&RlUnit> = res.iter().filter(|x| x.level == l && x.forced.is_none()).collect();
            let mut v = summary(&rs);
            v["level"] = json!(Level::ALL[l].name());
            v
        })
        .collect();
    // Branch choices in player's-choice runs: at each node with several
    // children, how often each level went to each.
    let mut choices: BTreeMap<(String, String, usize), u32> = BTreeMap::new();
    for x in res.iter().filter(|x| x.forced.is_none()) {
        for wdw in x.path.windows(2) {
            if rl.nodes.get(&wdw[0]).is_some_and(|n| n.children.len() > 1) {
                *choices.entry((wdw[0].clone(), wdw[1].clone(), x.level)).or_default() += 1;
            }
        }
    }
    let branch_rows: Vec<serde_json::Value> = rl
        .nodes
        .values()
        .filter(|n| n.children.len() > 1)
        .flat_map(|n| {
            let choices = &choices;
            n.children.iter().map(move |c| {
                let by: Vec<u32> = (0..3).map(|l| choices.get(&(n.key.clone(), c.clone(), l)).copied().unwrap_or(0)).collect();
                json!({"at": rl.name(&n.key), "to": rl.name(c), "to_key": c, "chosen": by})
            })
        })
        .collect();
    // Every path, from its forced runs.
    let path_rows: Vec<serde_json::Value> = paths
        .iter()
        .enumerate()
        .map(|(pi, p)| {
            let lv: Vec<serde_json::Value> = (0..3)
                .map(|l| {
                    let rs: Vec<&RlUnit> = res.iter().filter(|x| x.level == l && x.forced == Some(pi)).collect();
                    let mut v = summary(&rs);
                    v["level"] = json!(Level::ALL[l].name());
                    v
                })
                .collect();
            json!({"path": pi + 1, "label": rl.path_label(p), "keys": p,
                   "combats": p.iter().filter(|k| rl.nodes[*k].map.is_some()).count(), "levels": lv})
        })
        .collect();
    // Every mission, over all runs (player's choice and forced), by level.
    let mut nodes: BTreeMap<(String, usize), (u32, u32)> = BTreeMap::new();
    for x in &res {
        for (n, won) in &x.combats {
            let e = nodes.entry((n.clone(), x.level)).or_default();
            e.0 += 1;
            e.1 += *won as u32;
        }
    }
    let node_rows: Vec<serde_json::Value> = content
        .sp_nodes
        .iter()
        .map(|m| {
            let lv: Vec<serde_json::Value> = (0..3)
                .map(|l| {
                    let (a, wn) = nodes.get(&(m.key.clone(), l)).copied().unwrap_or_default();
                    json!({"level": Level::ALL[l].name(), "attempts": a, "won": wn,
                           "win_rate": if a > 0 { wn as f64 / a as f64 } else { f64::NAN }})
                })
                .collect();
            json!({"node": m.key, "name": rl.name(&m.key), "levels": lv})
        })
        .collect();
    write(
        ctx,
        "roguelike",
        &json!({"levels": levels, "branches": branch_rows, "paths": path_rows, "runs_per_path": f,
                "nodes": node_rows, "total_nodes": rl.nodes.len()}),
    )
}

// ============================================================ factorial

pub fn factorial(ctx: &Ctx, log: &mut dyn FnMut(&str)) -> std::io::Result<()> {
    let w = ctx.world;
    let (content, cfg) = (w.content, w.cfg);
    let f = &ctx.exp.factorial;
    let s = f.scenarios as usize;
    let seed = ctx.exp.seed;
    let meta = build_meta(content, cfg, w.values, 12, seed);
    // Each variant's tacticians (Average is the same in all of them).
    let variants: Vec<(TacticsConfig, Vec<Box<dyn Tactician>>)> = f
        .variants
        .iter()
        .map(|v| {
            let mut tc = ctx.tc.clone();
            if let Some(n) = v.poor_noise {
                let (t, e) = crate::calibrate::poor_knobs(n);
                tc.poor_noise = n;
                tc.poor_temperature = t;
                tc.poor_epsilon = e;
            }
            if let Some(p) = v.excellent_plies {
                tc.excellent.rollout_plies = p;
            }
            if ctx.exp.smoke {
                tc.excellent = smoke_mcts();
            }
            let ts = Level::ALL.iter().map(|&l| tc.make(l, ctx.eval)).collect();
            (tc, ts)
        })
        .collect();
    let res: Vec<[f64; 2]> = units(
        &ctx.dir.join("factorial.units.jsonl"),
        f.variants.len() * 9 * s,
        chunk(ctx),
        |u| {
            let (v, cell, k) = (u / (9 * s), (u / s) % 9, u % s);
            let (c, t) = (cell / 3, cell % 3);
            let ts = &variants[v].1;
            let mut rng = ChaCha8Rng::seed_from_u64(mix(seed, S_FACTORIAL, k as u64));
            let map = content.pvp_maps[rng.gen_range(0..content.pvp_maps.len())].clone();
            let cap = crate::composition::bench::CAPS[rng.gen_range(0..crate::composition::bench::CAPS.len())];
            let pool_a = mixed_pool(cfg, 1, &mut rng);
            let pool_b: Vec<Ship> = pool_a
                .iter()
                .map(|x| Ship {
                    id: x.id + 100_000,
                    ..x.clone()
                })
                .collect();
            let me = PoolPlayer {
                label: "cell".into(),
                composer: w.composers[c].as_ref(),
                tactician: ts[t].as_ref(),
            };
            let reference = PoolPlayer {
                label: "ref".into(),
                composer: w.composers[1].as_ref(),
                tactician: ts[1].as_ref(),
            };
            let sd = mix(seed, S_FACTORIAL, u as u64 + 1_000_000);
            let g1 = shared_pool_game(
                content,
                cfg,
                &me,
                &reference,
                [&pool_a, &pool_b],
                &map,
                cap,
                &meta[&cap],
                mix(sd, 1, 0),
            );
            let g2 = shared_pool_game(
                content,
                cfg,
                &reference,
                &me,
                [&pool_a, &pool_b],
                &map,
                cap,
                &meta[&cap],
                mix(sd, 2, 0),
            );
            [
                crate::arena::creator_points(&g1),
                1.0 - crate::arena::creator_points(&g2),
            ]
        },
        &mut |d, n| log(&format!("factorial: {d}/{n}")),
    )?;
    let out: Vec<serde_json::Value> = f
        .variants
        .iter()
        .enumerate()
        .map(|(v, var)| {
            let mut score = [[0.0; 3]; 3];
            let mut ci = [[0.0; 3]; 3];
            for cell in 0..9 {
                let pts: Vec<f64> = (0..s).flat_map(|k| res[v * 9 * s + cell * s + k]).collect();
                let (m, h) = mean_ci(&pts);
                score[cell / 3][cell % 3] = m;
                ci[cell / 3][cell % 3] = h;
            }
            let grand = score.iter().flatten().sum::<f64>() / 9.0;
            let row = |c: usize| score[c].iter().sum::<f64>() / 3.0;
            let col = |t: usize| (0..3).map(|c| score[c][t]).sum::<f64>() / 3.0;
            let ss_c: f64 = (0..3).map(|c| 3.0 * (row(c) - grand).powi(2)).sum();
            let ss_t: f64 = (0..3).map(|t| 3.0 * (col(t) - grand).powi(2)).sum();
            let ss_all: f64 = score.iter().flatten().map(|x| (x - grand).powi(2)).sum();
            let ss_i = (ss_all - ss_c - ss_t).max(0.0);
            let tot = (ss_c + ss_t + ss_i).max(1e-12);
            let tc = &variants[v].0;
            json!({"variant": var.name, "poor_noise": tc.poor_noise, "excellent_plies": tc.excellent.rollout_plies, "score": score, "ci95": ci,
                   "share_composition": ss_c / tot, "share_tactics": ss_t / tot, "share_interaction": ss_i / tot,
                   "composition_range": row(2) - row(0), "tactics_range": col(2) - col(0)})
        })
        .collect();
    write(ctx, "factorial", &json!({"scenarios": s, "variants": out}))
}

/// Smoke-run Excellent: a tiny search (pipeline checks only, never results).
pub fn smoke_mcts() -> crate::tactics::MctsParams {
    crate::tactics::MctsParams {
        simulations: 8,
        rollout_plies: 0,
        ..crate::tactics::MctsParams::default()
    }
}

// ============================================================== economy

pub fn economy(ctx: &Ctx, log: &mut dyn FnMut(&str)) -> std::io::Result<()> {
    let w = ctx.world;
    let dir = ctx.dir.join("economy");
    let o = SimOpts {
        days: ctx.exp.economy.days,
        players_per_archetype: ctx.exp.economy.players_per_archetype,
        seed: ctx.exp.seed,
        snapshot_every: 7,
    };
    let start = if ctx.fresh || !dir.join("checkpoint.json").exists() {
        Start::Fresh
    } else {
        Start::Resume
    };
    let t = std::time::Instant::now();
    let st = run_to_dir(w, &o, &dir, start, ctx.fingerprint, |day, _| {
        log(&format!(
            "economy: day {}/{} ({:.0?})",
            day + 1,
            o.days,
            t.elapsed()
        ))
    })?;
    // Curves: per archetype per snapshot day, from players.jsonl.
    let text = std::fs::read_to_string(dir.join("players.jsonl"))?;
    let mut curves: BTreeMap<(String, String), BTreeMap<u64, Vec<serde_json::Value>>> =
        BTreeMap::new();
    for line in text.lines().filter(|l| !l.is_empty()) {
        let v: serde_json::Value = serde_json::from_str(line)?;
        curves
            .entry((
                v["spend"].as_str().unwrap().into(),
                v["skill"].as_str().unwrap().into(),
            ))
            .or_default()
            .entry(v["day"].as_u64().unwrap())
            .or_default()
            .push(v);
    }
    let fields = [
        "ships",
        "fleet_power_1000",
        "usd_spent",
        "storefront_tier",
        "nodes_completed",
        "elo",
        "dec",
    ];
    let curve_rows: Vec<serde_json::Value> = curves
        .iter()
        .map(|((sp, sk), days)| {
            let pts: Vec<serde_json::Value> = days
                .iter()
                .map(|(d, vs)| {
                    let mut m = serde_json::Map::new();
                    m.insert("day".into(), json!(d));
                    for f in fields {
                        m.insert(
                            f.into(),
                            json!(
                                vs.iter().map(|v| v[f].as_f64().unwrap_or(0.0)).sum::<f64>()
                                    / vs.len() as f64
                            ),
                        );
                    }
                    m.insert(
                        "medal_share".into(),
                        json!(
                            vs.iter().filter(|v| !v["medal_day"].is_null()).count() as f64
                                / vs.len() as f64
                        ),
                    );
                    serde_json::Value::Object(m)
                })
                .collect();
            json!({"spend": sp, "skill": sk, "points": pts})
        })
        .collect();
    write(
        ctx,
        "economy",
        &json!({"days": o.days, "players_per_archetype": o.players_per_archetype, "summary": summarize(w, &st.players, o.days - 1), "curves": curve_rows}),
    )
}

// =============================================================== matrix

#[derive(Serialize, Deserialize)]
pub struct MatrixUnit {
    pub i: usize,
    pub j: usize,
    /// Points for archetype i in each game (None: someone had no fleet).
    pub points: Vec<Option<f64>>,
    /// Games played with peak hangars because a final hangar couldn't
    /// field a fleet.
    #[serde(default)]
    pub peak_games: u32,
}

/// `p` with its peak hangar (if it had one), for the matrix fallback.
fn at_peak(p: &Player) -> Player {
    let mut q = p.clone();
    if let Some((_, ships)) = &p.peak_hangar {
        q.ships = ships.clone();
    }
    q
}

/// A copy of a player whose ships can't collide with the original's ids
/// (an archetype with one player meeting itself).
fn mirror(p: &Player) -> Player {
    let mut q = p.clone();
    q.label = format!("{}*", p.label);
    for s in q.ships.iter_mut() {
        s.id += 600_000_000_000;
    }
    if let Some((_, peak)) = q.peak_hangar.as_mut() {
        for s in peak.iter_mut() {
            s.id += 600_000_000_000;
        }
    }
    q
}

pub fn matrix(ctx: &Ctx, log: &mut dyn FnMut(&str)) -> std::io::Result<()> {
    let w = ctx.world;
    let edir = ctx.dir.join("economy");
    let st = load_state(&edir)
        .map_err(|e| std::io::Error::other(format!("matrix needs the economy stage: {e}")))?;
    if st.next_day < ctx.exp.economy.days {
        return Err(std::io::Error::other(
            "matrix needs the economy stage to finish first",
        ));
    }
    let arch = archetypes(ctx);
    let members: Vec<Vec<&Player>> = arch
        .iter()
        .map(|(sp, l)| {
            st.players
                .iter()
                .filter(|p| &p.spend == sp && p.level == *l)
                .collect()
        })
        .collect();
    let pairs: Vec<(usize, usize)> = (0..arch.len())
        .flat_map(|i| (i..arch.len()).map(move |j| (i, j)))
        .collect();
    let s = ctx.exp.matrix.scenarios_per_pair as usize;
    let seed = ctx.exp.seed;
    let brackets = &ctx.exp.matrix.brackets;
    let empty: Vec<Vec<Ship>> = Vec::new();
    let res: Vec<MatrixUnit> = units(
        &ctx.dir.join("matrix.units.jsonl"),
        pairs.len() * s,
        chunk(ctx),
        |u| {
            let (i, j) = pairs[u / s];
            let mut rng = ChaCha8Rng::seed_from_u64(mix(seed, S_MATRIX, u as u64));
            let a = members[i][rng.gen_range(0..members[i].len())];
            let others: Vec<&&Player> = members[j].iter().filter(|p| p.index != a.index).collect();
            let b_owned;
            let b: &Player = if others.is_empty() {
                b_owned = mirror(a);
                &b_owned
            } else {
                others[rng.gen_range(0..others.len())]
            };
            let br = brackets[rng.gen_range(0..brackets.len())];
            let meta = st.meta.get(&br).unwrap_or(&empty);
            let mut peak_games = 0;
            let points = [true, false]
                .iter()
                .map(|&a_creates| {
                    let game_seed: u64 = rng.gen();
                    let play = |a: &Player, b: &Player| {
                        pvp_game_sided(
                            w,
                            a,
                            b,
                            br,
                            meta,
                            ctx.exp.economy.days,
                            game_seed,
                            Some(a_creates),
                        )
                    };
                    play(a, b)
                        .or_else(|| {
                            // A final hangar can't field a fleet: replay with
                            // the peak hangars (same labels, so the cell
                            // still belongs to the archetypes).
                            let r = play(&at_peak(a), &at_peak(b));
                            peak_games += r.is_some() as u32;
                            r
                        })
                    .map(|r| {
                        let lg = &r.log;
                        let a_side_creator = lg.creator.label == a.label;
                        match lg.winner {
                            "draw" => 0.5,
                            "creator" => a_side_creator as u8 as f64,
                            _ => (!a_side_creator) as u8 as f64,
                        }
                    })
                })
                .collect();
            MatrixUnit {
                i,
                j,
                points,
                peak_games,
            }
        },
        &mut |d, n| log(&format!("matrix: {d}/{n}")),
    )?;
    let n = arch.len();
    let mut pts: Vec<Vec<Vec<f64>>> = vec![vec![Vec::new(); n]; n];
    let mut games: Vec<(usize, usize, f64)> = Vec::new();
    let mut unplayed = 0;
    let peak_games: u32 = res.iter().map(|r| r.peak_games).sum();
    for r in &res {
        for p in &r.points {
            match p {
                Some(x) => {
                    pts[r.i][r.j].push(*x);
                    if r.i != r.j {
                        pts[r.j][r.i].push(1.0 - x);
                    }
                    games.push((r.i, r.j, *x));
                }
                None => unplayed += 1,
            }
        }
    }
    let score: Vec<Vec<serde_json::Value>> = (0..n)
        .map(|i| {
            (0..n)
                .map(|j| {
                    let (m, ci) = mean_ci(&pts[i][j]);
                    json!({"score": m, "ci95": ci, "games": pts[i][j].len()})
                })
                .collect()
        })
        .collect();
    let elo = bradley_terry_elo(n, &games);
    let idx = |sp: &str, l: Level| arch.iter().position(|a| a.0 == sp && a.1 == l);
    let get = |a: Option<usize>, b: Option<usize>| -> serde_json::Value {
        match (a, b) {
            (Some(a), Some(b)) => {
                let (m, ci) = mean_ci(&pts[a][b]);
                json!({"score": m, "ci95": ci, "games": pts[a][b].len()})
            }
            _ => serde_json::Value::Null,
        }
    };
    let ptw: Vec<serde_json::Value> = Level::ALL
        .iter()
        .map(|&l| json!({"skill": l.name(), "whale_vs_ftp": get(idx("whale", l), idx("ftp", l)), "casual_vs_ftp": get(idx("casual", l), idx("ftp", l)), "whale_vs_casual": get(idx("whale", l), idx("casual", l))}))
        .collect();
    let skill: Vec<serde_json::Value> = ["ftp", "casual", "whale"]
        .iter()
        .map(|sp| json!({"spend": sp, "excellent_vs_poor": get(idx(sp, Level::Excellent), idx(sp, Level::Poor)), "average_vs_poor": get(idx(sp, Level::Average), idx(sp, Level::Poor)), "excellent_vs_average": get(idx(sp, Level::Excellent), idx(sp, Level::Average))}))
        .collect();
    write(
        ctx,
        "matrix",
        &json!({"archetypes": arch.iter().map(label).collect::<Vec<_>>(), "score": score, "elo": elo, "pay_to_win": ptw, "skill": skill, "unplayed_games": unplayed, "peak_hangar_games": peak_games, "scenarios_per_pair": s}),
    )
}

/// Runs the configured stages in order.
pub fn run_all(ctx: &Ctx, log: &mut dyn FnMut(&str)) -> std::io::Result<()> {
    for stage in &ctx.exp.stages {
        let t = std::time::Instant::now();
        log(&format!("== stage {stage}"));
        match stage.as_str() {
            "components" => components(ctx, log)?,
            "pve" => pve(ctx, log)?,
            "roguelike" => roguelike(ctx, log)?,
            "factorial" => factorial(ctx, log)?,
            "economy" => economy(ctx, log)?,
            "matrix" => matrix(ctx, log)?,
            other => return Err(std::io::Error::other(format!("unknown stage {other}"))),
        }
        log(&format!("== stage {stage} done ({:.0?})", t.elapsed()));
        super::report::render(ctx.dir, ctx.exp)?;
    }
    Ok(())
}

//! Fleet composers: choosing which ships to bring (under the cost cap, one
//! variant, at most one per deployment tile) and where to deploy them.
//!
//! - Poor: random ships that fit, random tiles.
//! - Average: greedy by value per cost (the fitted ship value model) with a
//!   role check (at least one front-liner and one long-range ship when the
//!   pool allows), heuristic placement.
//! - Excellent: (mu + lambda) evolutionary search over (ships, tiles), seeded
//!   with the Average lineup; each candidate is scored by playing it with
//!   Average tactics against the expected opponent (the node's actual AI
//!   fleet in PvE; a sample of the meta in PvP).

use std::collections::HashMap;

use rand::seq::SliceRandom;
use rand::{Rng, SeedableRng};
use rand_chacha::ChaCha8Rng;
use serde::{Deserialize, Serialize};
use vt_core::engine::Side;
use vt_core::types::{Position, Ship};

use super::place::heuristic_cells;
use super::value::ShipValueModel;
use crate::content::Content;
use crate::eval::Eval;
use crate::fleet;
use crate::rules::Config;
use crate::runner::{play_match, AiSide, Controller, Limits, SideSetup};
use crate::tactics::{GreedyTactician, Level};

/// A chosen fleet: ship ids and their deployment cells (same order).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Lineup {
    pub ids: Vec<u64>,
    pub cells: Vec<Position>,
}

/// Who the fleet will face.
pub enum Foe<'a> {
    /// PvE: the node's AI fleet (known exactly).
    Ai(&'a AiSide),
    /// PvP: plausible opponent fleets (unplaced; placed by the heuristic).
    Meta(&'a [Vec<Ship>]),
    /// PvP, deploying second: the fleet already submitted (on chain it's
    /// readable from contract state before the second fleet goes in).
    Known {
        ships: &'a [Ship],
        cells: &'a [Position],
    },
}

pub struct ComposeCtx<'a> {
    pub content: &'a Content,
    pub cfg: &'a Config,
    pub map: &'a str,
    pub is_creator: bool,
    pub cap: u64,
    pub max_score: u64,
    pub creator_goes_first: bool,
    /// Only this variant may be used (roguelike campaigns), if set.
    pub variant: Option<u16>,
    /// Carried HP (roguelike): (ship id, stored HP; 0 = full).
    pub carried: &'a [(u64, u8)],
    pub foe: Foe<'a>,
    /// Weight on the fleet's surviving HP in search fitness (roguelike runs
    /// carry damage forward, so survival matters beyond winning).
    pub survival_weight: f64,
    /// Bring at least this many ships with a repair special when the pool
    /// has them (roguelike: damage carries forward, and ships can't be
    /// replaced mid-run).
    pub repair_ships: usize,
}

/// Repair ships a roguelike roster should include (human benchmark notes,
/// 2026-11-18: "select at least 1 repair ship for the roguelike, 2 is
/// better. We can't afford to lose ships during the run").
pub const ROGUELIKE_REPAIR_SHIPS: usize = 2;

/// Whether `s` carries a repair special (a Repair resolver in its slot).
pub fn is_repair(cfg: &Config, s: &Ship) -> bool {
    use vt_core::effects::Resolver;
    use vt_core::engine::Rules;
    matches!(
        cfg.rules.special_resolver(s.traits.variant, s.equipment.special),
        Some(Resolver::Repair { .. })
    )
}

/// Swaps ships in `ids` for repair ships from `pool` until it has
/// `want` of them (or the pool runs out), keeping under `cap`. Replaces the
/// lowest-`value` non-repair ship each time, and returns the swaps
/// (removed, added) so a caller can reuse cells.
pub fn ensure_repair(
    cfg: &Config,
    pool: &[&Ship],
    ids: &mut Vec<u64>,
    cap: u64,
    want: usize,
    value: &dyn Fn(&Ship) -> f64,
) -> Vec<(u64, u64)> {
    let by_id: HashMap<u64, &Ship> = pool.iter().map(|s| (s.id, *s)).collect();
    let mut swaps = Vec::new();
    loop {
        let have = ids.iter().filter(|id| by_id.get(id).is_some_and(|s| is_repair(cfg, s))).count();
        if have >= want || ids.is_empty() {
            return swaps;
        }
        let cost: u64 = ids.iter().filter_map(|id| by_id.get(id)).map(|s| s.ship_data.cost as u64).sum();
        let mut out: Vec<usize> = (0..ids.len())
            .filter(|&i| by_id.get(&ids[i]).is_some_and(|s| !is_repair(cfg, s)))
            .collect();
        out.sort_by(|&a, &b| {
            value(by_id[&ids[a]]).partial_cmp(&value(by_id[&ids[b]])).unwrap().then(a.cmp(&b))
        });
        let mut cands: Vec<&Ship> = pool
            .iter()
            .copied()
            .filter(|s| is_repair(cfg, s) && !ids.contains(&s.id))
            .collect();
        cands.sort_by(|a, b| value(b).partial_cmp(&value(a)).unwrap().then(a.id.cmp(&b.id)));
        let swap = out.iter().find_map(|&i| {
            let old = by_id[&ids[i]].ship_data.cost as u64;
            cands
                .iter()
                .find(|c| cost - old + c.ship_data.cost as u64 <= cap)
                .map(|c| (i, c.id))
        });
        let Some((i, add)) = swap else {
            return swaps;
        };
        swaps.push((ids[i], add));
        ids[i] = add;
    }
}

impl ComposeCtx<'_> {
    fn tiles(&self) -> Vec<Position> {
        self.content
            .deployment_tiles(Some(self.map), self.is_creator)
    }
    /// The enemy's ships and cells when they're known before we deploy
    /// (a fixed AI fleet, or a PvP fleet submitted first).
    pub fn known_enemy(&self) -> Option<(Vec<&Ship>, Vec<Position>)> {
        match &self.foe {
            Foe::Ai(ai) => Some((ai.ships.iter().collect(), ai.cells.clone())),
            Foe::Known { ships, cells } => Some((ships.iter().collect(), cells.to_vec())),
            Foe::Meta(_) => None,
        }
    }
    /// Purpose placement for `ships`, against the known enemy if any.
    pub fn purpose_cells(&self, ships: &[&Ship]) -> Vec<Position> {
        let known = self.known_enemy();
        heuristic_cells(
            self.content,
            self.cfg,
            self.map,
            self.is_creator,
            ships,
            known.as_ref().map(|(s, c)| (s.as_slice(), c.as_slice())),
        )
    }
}

pub trait Composer: Send + Sync {
    fn name(&self) -> String;
    /// Choose ships from `pool` and place them.
    fn compose(&self, ctx: &ComposeCtx, pool: &[Ship], rng: &mut ChaCha8Rng) -> Lineup;
    /// Place a fixed set of ships (roguelike rosters).
    fn place(&self, ctx: &ComposeCtx, ships: &[&Ship], rng: &mut ChaCha8Rng) -> Vec<Position>;
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SearchParams {
    pub parents: usize,
    pub offspring: usize,
    pub generations: usize,
    /// Meta opponents sampled per PvP evaluation.
    pub opponents: usize,
    /// Held-out check: the final parents and the starting lineup are
    /// re-scored on `validation_opponents` fresh meta fleets (PvP) or a fresh
    /// seed (PvE), and the best is kept. Guards against overfitting the few
    /// opponents the search saw; the result is never worse than the start
    /// on held-out games.
    #[serde(default = "default_validation")]
    pub validation_opponents: usize,
}

fn default_validation() -> usize {
    6
}

impl Default for SearchParams {
    fn default() -> Self {
        SearchParams {
            parents: 6,
            offspring: 8,
            generations: 6,
            opponents: 3,
            validation_opponents: 6,
        }
    }
}

pub struct PoorComposer;
pub struct AverageComposer {
    pub values: ShipValueModel,
}
pub struct ExcellentComposer {
    pub values: ShipValueModel,
    /// The evaluation the search plays its candidate lineups with (Average).
    pub eval: Eval,
    pub params: SearchParams,
}

pub fn make(
    level: Level,
    values: &ShipValueModel,
    eval: &Eval,
    params: &SearchParams,
) -> Box<dyn Composer> {
    match level {
        Level::Poor => Box::new(PoorComposer),
        Level::Average => Box::new(AverageComposer {
            values: values.clone(),
        }),
        Level::Excellent => Box::new(ExcellentComposer {
            values: values.clone(),
            eval: eval.clone(),
            params: params.clone(),
        }),
    }
}

impl Composer for PoorComposer {
    fn name(&self) -> String {
        "poor".into()
    }
    fn compose(&self, ctx: &ComposeCtx, pool: &[Ship], rng: &mut ChaCha8Rng) -> Lineup {
        let tiles = ctx.tiles();
        let ships = fleet::random_fleet(pool, ctx.cap, tiles.len(), ctx.variant, rng);
        let cells = fleet::random_cells(&tiles, ships.len(), rng);
        Lineup {
            ids: ships.iter().map(|s| s.id).collect(),
            cells,
        }
    }
    fn place(&self, ctx: &ComposeCtx, ships: &[&Ship], rng: &mut ChaCha8Rng) -> Vec<Position> {
        fleet::random_cells(&ctx.tiles(), ships.len(), rng)
    }
}

fn is_front(cfg: &Config, s: &Ship) -> bool {
    cfg.attributes(s).map(|a| a.range <= 3).unwrap_or(false)
}
fn is_long(cfg: &Config, s: &Ship) -> bool {
    cfg.attributes(s).map(|a| a.range >= 5).unwrap_or(false)
}

impl AverageComposer {
    /// Greedy by value per cost for one variant, then the role check.
    fn select<'a>(
        &self,
        ctx: &ComposeCtx,
        pool: &'a [Ship],
        variant: u16,
        max_ships: usize,
    ) -> Vec<&'a Ship> {
        let cfg = ctx.cfg;
        let mut cands: Vec<(&Ship, f64)> = pool
            .iter()
            .filter(|s| s.traits.variant == variant)
            .map(|s| (s, self.values.value(cfg, s)))
            .filter(|x| x.1 > 0.0)
            .collect();
        cands.sort_by(|a, b| {
            (b.1 / b.0.ship_data.cost as f64)
                .partial_cmp(&(a.1 / a.0.ship_data.cost as f64))
                .unwrap()
                .then(a.0.id.cmp(&b.0.id))
        });
        let mut chosen: Vec<&Ship> = Vec::new();
        let mut cost = 0u64;
        for (s, _) in &cands {
            if chosen.len() < max_ships && cost + s.ship_data.cost as u64 <= ctx.cap {
                cost += s.ship_data.cost as u64;
                chosen.push(s);
            }
        }
        // Role check: swap the lowest-density ship for the best missing role.
        for role in [is_front as fn(&Config, &Ship) -> bool, is_long] {
            if chosen.is_empty() || chosen.iter().any(|s| role(cfg, s)) {
                continue;
            }
            let Some((add, _)) = cands
                .iter()
                .find(|(s, _)| role(cfg, s) && !chosen.iter().any(|c| c.id == s.id))
            else {
                continue;
            };
            let worst = (0..chosen.len()).min_by(|&a, &b| {
                let d = |s: &Ship| self.values.value(cfg, s) / s.ship_data.cost as f64;
                d(chosen[a]).partial_cmp(&d(chosen[b])).unwrap()
            });
            if let Some(w) = worst {
                if cost - chosen[w].ship_data.cost as u64 + add.ship_data.cost as u64 <= ctx.cap {
                    cost = cost - chosen[w].ship_data.cost as u64 + add.ship_data.cost as u64;
                    chosen[w] = add;
                }
            }
        }
        if ctx.repair_ships > 0 {
            let vp: Vec<&Ship> = cands.iter().map(|x| x.0).collect();
            let mut ids: Vec<u64> = chosen.iter().map(|s| s.id).collect();
            let d = |s: &Ship| self.values.value(cfg, s) / s.ship_data.cost as f64;
            ensure_repair(cfg, &vp, &mut ids, ctx.cap, ctx.repair_ships, &d);
            let by_id: HashMap<u64, &'a Ship> = cands.iter().map(|x| (x.0.id, x.0)).collect();
            chosen = ids.iter().map(|id| by_id[id]).collect();
        }
        chosen
    }

    fn best_lineup(&self, ctx: &ComposeCtx, pool: &[Ship]) -> Vec<(u16, Vec<u64>, f64)> {
        let max_ships = ctx.tiles().len();
        let mut variants: Vec<u16> = pool
            .iter()
            .map(|s| s.traits.variant)
            .filter(|v| ctx.variant.is_none_or(|x| x == *v))
            .collect();
        variants.sort_unstable();
        variants.dedup();
        variants
            .into_iter()
            .map(|v| {
                let ships = self.select(ctx, pool, v, max_ships);
                let total: f64 = ships.iter().map(|s| self.values.value(ctx.cfg, s)).sum();
                (v, ships.iter().map(|s| s.id).collect(), total)
            })
            .collect()
    }
}

impl Composer for AverageComposer {
    fn name(&self) -> String {
        "average".into()
    }
    fn compose(&self, ctx: &ComposeCtx, pool: &[Ship], rng: &mut ChaCha8Rng) -> Lineup {
        let options = self.best_lineup(ctx, pool);
        let Some(best) = options
            .into_iter()
            .max_by(|a, b| a.2.partial_cmp(&b.2).unwrap())
        else {
            return Lineup {
                ids: vec![],
                cells: vec![],
            };
        };
        let ships: Vec<&Ship> = best
            .1
            .iter()
            .map(|id| pool.iter().find(|s| s.id == *id).unwrap())
            .collect();
        let cells = self.place(ctx, &ships, rng);
        Lineup { ids: best.1, cells }
    }
    fn place(&self, ctx: &ComposeCtx, ships: &[&Ship], _rng: &mut ChaCha8Rng) -> Vec<Position> {
        ctx.purpose_cells(ships)
    }
}

// ============================================================== Excellent

impl ExcellentComposer {
    fn tactician(&self) -> GreedyTactician {
        GreedyTactician {
            label: "average".into(),
            eval: self.eval.clone(),
            temperature: 0.0,
            epsilon: 0.0,
        }
    }

    /// Fitness of a lineup: mean points (win 1, draw 0.5) over the evaluation
    /// games, plus small margins for HP kept and HP removed (tie-breakers
    /// that also reward survival), scaled by `survival_weight` for our HP.
    fn fitness(
        &self,
        ctx: &ComposeCtx,
        by_id: &HashMap<u64, &Ship>,
        l: &Lineup,
        foes: &[(Vec<&Ship>, Vec<Position>)],
        seed: u64,
    ) -> f64 {
        if l.ids.is_empty() {
            return -1.0;
        }
        let t = self.tactician();
        let ships: Vec<&Ship> = l.ids.iter().map(|id| by_id[id]).collect();
        let me_side = if ctx.is_creator {
            Side::Creator
        } else {
            Side::Joiner
        };
        let limits = Limits {
            max_rounds: 25,
            max_moves: 2000,
        };
        let mut total = 0.0;
        let games: Vec<(Vec<&Ship>, Vec<Position>, Option<&AiSide>)> = match &ctx.foe {
            Foe::Ai(ai) => vec![(ai.ships.iter().collect(), ai.cells.clone(), Some(*ai))],
            Foe::Meta(_) | Foe::Known { .. } => foes
                .iter()
                .map(|(s, c)| (s.clone(), c.clone(), None))
                .collect(),
        };
        for (k, (fs, fc, ai)) in games.iter().enumerate() {
            let mut rng = ChaCha8Rng::seed_from_u64(seed ^ k as u64);
            let me = SideSetup {
                label: "me".into(),
                ships: ships.clone(),
                cells: l.cells.clone(),
                controller: Controller::Agent(&t),
                ai_keys: HashMap::new(),
            };
            let foe = match ai {
                Some(ai) => ai.side(),
                None => SideSetup {
                    label: "foe".into(),
                    ships: fs.clone(),
                    cells: fc.clone(),
                    controller: Controller::Agent(&t),
                    ai_keys: HashMap::new(),
                },
            };
            let (c, j) = if ctx.is_creator { (me, foe) } else { (foe, me) };
            let p = play_match(
                ctx.cfg,
                "search",
                0,
                ctx.map,
                None,
                &ctx.content.maps[ctx.map],
                c,
                j,
                ctx.creator_goes_first,
                ctx.max_score,
                ctx.carried,
                limits,
                &mut rng,
            );
            let g = &p.game;
            let points = match g.winner {
                Some(w) if w == me_side => 1.0,
                Some(_) => 0.0,
                None => 0.5,
            };
            let hp = |creator: bool| -> (f64, f64) {
                p.log
                    .ship_logs
                    .iter()
                    .filter(|s| (s.side == 0) == creator)
                    .fold((0.0, 0.0), |a, s| {
                        (a.0 + s.end_hp as f64, a.1 + s.max_hp as f64)
                    })
            };
            let (mine, mine_max) = hp(ctx.is_creator);
            let (theirs, theirs_max) = hp(!ctx.is_creator);
            total += points + 0.1 * (1.0 + ctx.survival_weight) * mine / mine_max.max(1.0)
                - 0.1 * theirs / theirs_max.max(1.0);
        }
        total / games.len().max(1) as f64
    }

    /// One random edit that keeps the lineup valid (cap, variant, tiles).
    fn mutate(
        &self,
        ctx: &ComposeCtx,
        pool: &[&Ship],
        tiles: &[Position],
        l: &Lineup,
        rng: &mut ChaCha8Rng,
        fixed_ships: bool,
    ) -> Lineup {
        let mut l = l.clone();
        let cost = |ids: &[u64]| {
            ids.iter()
                .map(|id| pool.iter().find(|s| s.id == *id).unwrap().ship_data.cost as u64)
                .sum::<u64>()
        };
        let free: Vec<&Position> = tiles.iter().filter(|t| !l.cells.contains(t)).collect();
        let outside: Vec<&&Ship> = pool.iter().filter(|s| !l.ids.contains(&s.id)).collect();
        for _ in 0..8 {
            match rng.gen_range(0..if fixed_ships { 2 } else { 5 }) {
                0 if !free.is_empty() && !l.ids.is_empty() => {
                    let i = rng.gen_range(0..l.ids.len());
                    l.cells[i] = (*free.choose(rng).unwrap()).clone();
                    return l;
                }
                1 if l.ids.len() >= 2 => {
                    let (i, j) = (rng.gen_range(0..l.ids.len()), rng.gen_range(0..l.ids.len()));
                    l.cells.swap(i, j);
                    return l;
                }
                2 if !outside.is_empty() && !l.ids.is_empty() => {
                    let i = rng.gen_range(0..l.ids.len());
                    let s = outside.choose(rng).unwrap();
                    let mut ids = l.ids.clone();
                    ids[i] = s.id;
                    if cost(&ids) <= ctx.cap {
                        l.ids = ids;
                        return l;
                    }
                }
                3 if !outside.is_empty() && !free.is_empty() => {
                    let s = outside.choose(rng).unwrap();
                    let mut ids = l.ids.clone();
                    ids.push(s.id);
                    if cost(&ids) <= ctx.cap {
                        l.ids = ids;
                        l.cells.push((*free.choose(rng).unwrap()).clone());
                        return l;
                    }
                }
                4 if l.ids.len() >= 2 => {
                    let i = rng.gen_range(0..l.ids.len());
                    l.ids.remove(i);
                    l.cells.remove(i);
                    return l;
                }
                _ => {}
            }
        }
        l
    }

    /// PvP: sample and place the meta opponents once (common to every
    /// candidate the search compares).
    fn sample_foes<'a>(
        &self,
        ctx: &ComposeCtx<'a>,
        rng: &mut ChaCha8Rng,
    ) -> Vec<(Vec<&'a Ship>, Vec<Position>)> {
        match &ctx.foe {
            Foe::Meta(meta) if !meta.is_empty() => (0..self.params.opponents)
                .map(|_| {
                    // Only fleets that could deploy on this map's opponent
                    // zone (meta fleets come from all maps; zones differ in
                    // size). If none fit, keep the most expensive ships that do.
                    let room = ctx
                        .content
                        .deployment_tiles(Some(ctx.map), !ctx.is_creator)
                        .len();
                    let fitting: Vec<&Vec<Ship>> =
                        meta.iter().filter(|f| f.len() <= room).collect();
                    let ships: Vec<&Ship> = if !fitting.is_empty() {
                        fitting[rng.gen_range(0..fitting.len())].iter().collect()
                    } else {
                        let mut all: Vec<&Ship> =
                            meta[rng.gen_range(0..meta.len())].iter().collect();
                        all.sort_by(|a, b| {
                            b.ship_data
                                .cost
                                .cmp(&a.ship_data.cost)
                                .then(a.id.cmp(&b.id))
                        });
                        all.truncate(room);
                        all
                    };
                    // Meta opponents deploy blind (by purpose).
                    let cells =
                        heuristic_cells(ctx.content, ctx.cfg, ctx.map, !ctx.is_creator, &ships, None);
                    (ships, cells)
                })
                .collect(),
            // Deploying second: the one real opponent, as submitted.
            Foe::Known { ships, cells } => vec![((*ships).iter().collect(), cells.to_vec())],
            _ => Vec::new(),
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn search(
        &self,
        ctx: &ComposeCtx,
        pool: &[&Ship],
        start: Lineup,
        fixed_ships: bool,
        foes: &[(Vec<&Ship>, Vec<Position>)],
        seed: u64,
        rng: &mut ChaCha8Rng,
    ) -> Lineup {
        let p = &self.params;
        let tiles = ctx.tiles();
        let by_id: HashMap<u64, &Ship> = pool.iter().map(|s| (s.id, *s)).collect();
        type Key = Vec<(u64, i16, i16)>;
        let key = |l: &Lineup| -> Key {
            l.ids
                .iter()
                .zip(&l.cells)
                .map(|(i, c)| (*i, c.row, c.col))
                .collect()
        };
        let mut cache: HashMap<Key, f64> = HashMap::new();
        let score = |l: &Lineup, cache: &mut HashMap<Key, f64>| -> f64 {
            *cache
                .entry(key(l))
                .or_insert_with(|| self.fitness(ctx, &by_id, l, foes, seed))
        };
        let mut pop: Vec<(f64, Lineup)> = vec![(score(&start, &mut cache), start.clone())];
        while pop.len() < p.parents {
            let m = self.mutate(ctx, pool, &tiles, &start, rng, fixed_ships);
            pop.push((score(&m, &mut cache), m));
        }
        for _ in 0..p.generations {
            let mut next = pop.clone();
            let children: Vec<Lineup> = (0..p.offspring)
                .map(|_| {
                    let parent = &pop[rng.gen_range(0..pop.len())].1;
                    let child = self.mutate(ctx, pool, &tiles, parent, rng, fixed_ships);
                    if rng.gen_bool(0.5) {
                        self.mutate(ctx, pool, &tiles, &child, rng, fixed_ships)
                    } else {
                        child
                    }
                })
                .collect();
            // Score new children in parallel (order-preserving: deterministic).
            {
                use rayon::prelude::*;
                let fresh: Vec<(Key, f64)> = children
                    .par_iter()
                    .filter(|c| !cache.contains_key(&key(c)))
                    .map(|c| (key(c), self.fitness(ctx, &by_id, c, foes, seed)))
                    .collect();
                cache.extend(fresh);
            }
            for child in children {
                next.push((score(&child, &mut cache), child));
            }
            next.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap());
            next.dedup_by(|a, b| a.1 == b.1);
            next.truncate(p.parents);
            pop = next;
        }
        // Held-out validation (fresh opponents / seed).
        let val_foes = {
            let mut v = Vec::new();
            for _ in 0..p.validation_opponents.div_ceil(p.opponents.max(1)) {
                v.extend(self.sample_foes(ctx, rng));
            }
            v.truncate(p.validation_opponents.max(1));
            v
        };
        let val_seed: u64 = rng.gen();
        let mut finalists: Vec<Lineup> = pop.into_iter().map(|x| x.1).collect();
        if !finalists.contains(&start) {
            finalists.push(start);
        }
        finalists
            .into_iter()
            .map(|l| (self.fitness(ctx, &by_id, &l, &val_foes, val_seed), l))
            .fold(None, |acc: Option<(f64, Lineup)>, x| match acc {
                Some(a) if a.0 >= x.0 => Some(a),
                _ => Some(x),
            })
            .unwrap()
            .1
    }
}

impl Composer for ExcellentComposer {
    fn name(&self) -> String {
        "excellent".into()
    }
    fn compose(&self, ctx: &ComposeCtx, pool: &[Ship], rng: &mut ChaCha8Rng) -> Lineup {
        let avg = AverageComposer {
            values: self.values.clone(),
        };
        // Search the variant whose Average lineup scores best when played.
        let by_id_all: HashMap<u64, &Ship> = pool.iter().map(|s| (s.id, s)).collect();
        let foes = self.sample_foes(ctx, rng);
        let seed: u64 = rng.gen();
        let mut best: Option<(f64, u16, Lineup)> = None;
        for (v, ids, _) in avg.best_lineup(ctx, pool) {
            if ids.is_empty() {
                continue;
            }
            let ships: Vec<&Ship> = ids.iter().map(|id| by_id_all[id]).collect();
            let cells = avg.place(ctx, &ships, rng);
            let l = Lineup { ids, cells };
            let f = self.fitness(ctx, &by_id_all, &l, &foes, seed);
            if best.as_ref().is_none_or(|b| f > b.0) {
                best = Some((f, v, l));
            }
        }
        let Some((_, v, start)) = best else {
            return Lineup {
                ids: vec![],
                cells: vec![],
            };
        };
        let variant_pool: Vec<&Ship> = pool.iter().filter(|s| s.traits.variant == v).collect();
        let mut l = self.search(ctx, &variant_pool, start, false, &foes, seed, rng);
        if ctx.repair_ships > 0 {
            // The search scores single fights, where a repair ship rarely
            // pays; across a run it does. Swapped-in ships take the cell of
            // the ship they replace.
            let d = |s: &Ship| self.values.value(ctx.cfg, s) / s.ship_data.cost as f64;
            let before = l.ids.clone();
            ensure_repair(ctx.cfg, &variant_pool, &mut l.ids, ctx.cap, ctx.repair_ships, &d);
            debug_assert_eq!(before.len(), l.ids.len());
        }
        l
    }
    fn place(&self, ctx: &ComposeCtx, ships: &[&Ship], rng: &mut ChaCha8Rng) -> Vec<Position> {
        let avg = AverageComposer {
            values: self.values.clone(),
        };
        let start = Lineup {
            ids: ships.iter().map(|s| s.id).collect(),
            cells: avg.place(ctx, ships, rng),
        };
        let foes = self.sample_foes(ctx, rng);
        let seed: u64 = rng.gen();
        self.search(ctx, ships, start, true, &foes, seed, rng).cells
    }
}

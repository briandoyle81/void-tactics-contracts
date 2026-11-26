//! Roguelike run decisions at each composition level: the path through the
//! graph, resupply (repairs and roster changes under the new cap), and
//! deployment at each combat node. (Poor is `runner::BasicPlanner`.)

use std::collections::HashMap;

use rand::{Rng, SeedableRng};
use rand_chacha::ChaCha8Rng;
use vt_core::types::{Position, Ship};

use super::compose::{ComposeCtx, Composer, Foe};
use super::value::ShipValueModel;
use crate::content::RlKind;
use crate::eval::Eval;
use crate::runner::{
    play_match, AiSide, Controller, Limits, ResupplyPlan, RunPlanner, RunView, SideSetup,
};
use crate::tactics::{GreedyTactician, Level};

pub struct LevelPlanner {
    pub level: Level,
    pub composer: Box<dyn Composer>,
    pub values: ShipValueModel,
    /// Average tactics, for Excellent's look-ahead at path choices.
    pub eval: Eval,
}

/// Fraction of the roster's max HP it currently has.
fn health(v: &RunView) -> f64 {
    let (mut hp, mut max) = (0.0, 0.0);
    for &(id, stored) in v.roster {
        let s = v.pool.iter().find(|s| s.id == id).unwrap();
        let m = v.cfg.attributes(s).unwrap().max_hull_points as f64;
        hp += if stored == 0 { m } else { stored as f64 };
        max += m;
    }
    if max == 0.0 {
        1.0
    } else {
        hp / max
    }
}

impl LevelPlanner {
    fn roster_ships<'a>(&self, v: &RunView<'a>) -> Vec<&'a Ship> {
        v.roster
            .iter()
            .map(|(id, _)| v.pool.iter().find(|s| s.id == *id).unwrap())
            .collect()
    }

    /// Excellent: play the node once with Average tactics and heuristic
    /// placement; score = win + surviving HP.
    fn preview(&self, v: &RunView, node: &str, rng: &mut ChaCha8Rng) -> f64 {
        let n = &v.content.roguelike.nodes[node];
        let map = n.map.as_deref().unwrap();
        let ai = AiSide::for_map(v.content, v.cfg, map);
        let ships = self.roster_ships(v);
        // A roster bigger than the node's zone can't enter it (the run would
        // end with `roster_exceeds_zone`): score it as a loss.
        if ships.len() > v.content.deployment_tiles(Some(map), true).len() {
            return -1.0;
        }
        let ctx = self.ctx(v, node, &ai);
        let cells = ctx.purpose_cells(&ships);
        let t = GreedyTactician {
            label: "average".into(),
            eval: self.eval.clone(),
            temperature: 0.0,
            epsilon: 0.0,
        };
        let me = SideSetup {
            label: "me".into(),
            ships,
            cells,
            controller: Controller::Agent(&t),
            ai_keys: HashMap::new(),
        };
        let mut r = ChaCha8Rng::seed_from_u64(rng.gen());
        let p = play_match(
            v.cfg,
            "search",
            0,
            map,
            Some(node),
            &v.content.maps[map],
            me,
            ai.side(),
            n.creator_goes_first,
            n.max_score,
            v.roster,
            Limits {
                max_rounds: 25,
                max_moves: 2000,
            },
            &mut r,
        );
        let won = (p.log.winner == "creator") as u8 as f64;
        let (hp, max) = p
            .log
            .ship_logs
            .iter()
            .filter(|s| s.side == 0)
            .fold((0.0, 0.0), |a, s| {
                (a.0 + s.end_hp as f64, a.1 + s.max_hp as f64)
            });
        won + 0.5 * hp / max.max(1.0)
    }

    fn ctx<'a>(&self, v: &RunView<'a>, node: &'a str, ai: &'a AiSide) -> ComposeCtx<'a> {
        let n = &v.content.roguelike.nodes[node];
        ComposeCtx {
            content: v.content,
            cfg: v.cfg,
            map: n.map.as_deref().unwrap(),
            is_creator: true,
            cap: v.cap,
            max_score: n.max_score,
            creator_goes_first: n.creator_goes_first,
            variant: Some(v.content.roguelike.required_variant),
            carried: v.roster,
            foe: Foe::Ai(ai),
            survival_weight: 1.0,
            repair_ships: crate::composition::compose::ROGUELIKE_REPAIR_SHIPS,
        }
    }
}

impl RunPlanner for LevelPlanner {
    fn next_node(&self, v: &RunView, choices: &[&str], rng: &mut ChaCha8Rng) -> usize {
        if self.level == Level::Poor {
            return rng.gen_range(0..choices.len());
        }
        let damaged = 1.0 - health(v);
        let scores: Vec<f64> = choices
            .iter()
            .map(|k| {
                let n = &v.content.roguelike.nodes[*k];
                match n.kind {
                    // Resupply is worth more the more damaged the roster is.
                    RlKind::Resupply => match self.level {
                        Level::Excellent => 0.6 + damaged,
                        _ => -1.0 + 4.0 * damaged,
                    },
                    RlKind::Combat => match self.level {
                        Level::Excellent => self.preview(v, k, rng),
                        // Average: the weakest-looking enemy fleet.
                        _ => {
                            let ai = AiSide::for_map(v.content, v.cfg, n.map.as_deref().unwrap());
                            -ai.ships
                                .iter()
                                .map(|s| self.values.value(v.cfg, s))
                                .sum::<f64>()
                        }
                    },
                }
            })
            .collect();
        (0..choices.len())
            .max_by(|&a, &b| scores[a].partial_cmp(&scores[b]).unwrap().then(b.cmp(&a)))
            .unwrap()
    }

    fn resupply(&self, v: &RunView, _rng: &mut ChaCha8Rng) -> ResupplyPlan {
        let mut plan = ResupplyPlan::default();
        if self.level == Level::Poor {
            return plan;
        }
        let threshold = if self.level == Level::Excellent {
            0.999
        } else {
            0.6
        };
        for &(id, stored) in v.roster {
            let s = v.pool.iter().find(|s| s.id == id).unwrap();
            let max = v.cfg.attributes(s).unwrap().max_hull_points as f64;
            if stored != 0 && (stored as f64) < threshold * max {
                plan.repair.push(id);
            }
        }
        // Spend the raised cap on the best value-per-cost reserves.
        let density = |s: &Ship| self.values.value(v.cfg, s) / s.ship_data.cost.max(1) as f64;
        let in_roster = |id: u64| v.roster.iter().any(|e| e.0 == id);
        let mut cost: u64 = v
            .roster
            .iter()
            .map(|(id, _)| v.pool.iter().find(|s| s.id == *id).unwrap().ship_data.cost as u64)
            .sum();
        let variant = v.content.roguelike.required_variant;
        let mut reserves: Vec<&Ship> = v
            .pool
            .iter()
            .filter(|s| {
                !in_roster(s.id)
                    && !v.destroyed.contains(&s.id)
                    && (variant == 0 || s.traits.variant == variant)
            })
            .collect();
        reserves.sort_by(|a, b| {
            density(b)
                .partial_cmp(&density(a))
                .unwrap()
                .then(a.id.cmp(&b.id))
        });
        if self.level == Level::Excellent {
            // Drop the weakest roster ship if a reserve is clearly better per cost.
            if let (Some(worst), Some(best)) = (
                v.roster
                    .iter()
                    .map(|(id, _)| v.pool.iter().find(|s| s.id == *id).unwrap())
                    .min_by(|a, b| density(a).partial_cmp(&density(b)).unwrap()),
                reserves.first(),
            ) {
                if density(best) > 1.2 * density(worst) && v.roster.len() > 1 {
                    plan.remove.push(worst.id);
                    cost -= worst.ship_data.cost as u64;
                }
            }
        }
        let max_ships = 12usize;
        for s in reserves {
            if v.roster.len() - plan.remove.len() + plan.add.len() >= max_ships {
                break;
            }
            if cost + s.ship_data.cost as u64 <= v.cap && self.values.value(v.cfg, s) > 0.0 {
                cost += s.ship_data.cost as u64;
                plan.add.push(s.id);
            }
        }
        plan
    }

    fn place(
        &self,
        v: &RunView,
        node: &str,
        ships: &[&Ship],
        rng: &mut ChaCha8Rng,
    ) -> Vec<Position> {
        let map = v.content.roguelike.nodes[node].map.as_deref().unwrap();
        let ai = AiSide::for_map(v.content, v.cfg, map);
        let ctx = self.ctx(v, node, &ai);
        self.composer.place(&ctx, ships, rng)
    }
}

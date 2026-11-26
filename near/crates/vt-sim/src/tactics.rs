//! Tactical agents: who picks each move. Simulated players implement
//! `Tactician`. The on-chain AI is not a `Tactician`: it only plays the PvE AI
//! side (as on chain), through `vt_core::ai::take_ai_turns`.
//!
//! Three skill levels share one move generator and one trained evaluation:
//! - Poor: one-ply greedy on material and score only, softmax-noisy, with an
//!   ε chance of a random move.
//! - Average: one-ply greedy on the full evaluation.
//! - Excellent: Monte Carlo tree search (progressive widening ordered by the
//!   one-ply evaluation; leaves scored after a short greedy look-ahead).
//!
//! Knobs live in `TacticsConfig` (near/sim/tactics.json), set by calibration.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use rand::Rng;
use rand_chacha::ChaCha8Rng;
use serde::{Deserialize, Serialize};
use vt_core::engine::{GameState, MoveInput, Side};
use vt_core::ai::{take_ai_turns, AiShipInfo};
use vt_core::types::ActionType;

use crate::eval::{Eval, LossPrefs};
use crate::movegen::{legal_moves, Candidate, Targets};
use crate::rules::LocalRules;

pub trait Tactician: Send + Sync {
    /// Short label for logs.
    fn name(&self) -> String;
    /// The move to make for `side` (which is to move). None = no legal move.
    fn choose(
        &self,
        g: &GameState,
        rules: &LocalRules,
        side: Side,
        rng: &mut ChaCha8Rng,
    ) -> Option<MoveInput>;
    /// Like `choose`, told who the opponent is: `Some` when it's the
    /// on-chain AI (PvE) with its ships' AI configs. The AI is deterministic,
    /// so a player who searches can predict its replies exactly, as a player
    /// who has learned its behaviour does. Defaults to `choose`.
    fn choose_vs(
        &self,
        g: &GameState,
        rules: &LocalRules,
        side: Side,
        rng: &mut ChaCha8Rng,
        _ai: Option<&AiInfo>,
    ) -> Option<MoveInput> {
        self.choose(g, rules, side, rng)
    }
}

/// AI config per AI ship id (the on-chain AI's view of its fleet).
pub type AiInfo = HashMap<u64, AiShipInfo>;

/// The on-chain AI's next move from `g` (it's the AI's turn), applied to a
/// copy, exactly as `take_ai_turns` plays it. None if it can't move.
pub fn ai_reply(g: &GameState, rules: &LocalRules, ai: &AiInfo) -> Option<Candidate> {
    let mut next = g.clone();
    let r = take_ai_turns(&mut next, rules, &|id| ai.get(&id).cloned(), 1, 0).ok()?;
    if r.moves == 0 {
        // Conceded (no live ships) ends the game; otherwise it's stuck.
        return next.ended.then(|| Candidate {
            mv: MoveInput {
                ship_id: 0,
                new_row: 0,
                new_col: 0,
                action: ActionType::Pass,
                target_ship_id: 0,
            },
            next,
            events: r.events,
        });
    }
    let lm = next.last_move.clone()?;
    Some(Candidate {
        mv: MoveInput {
            ship_id: lm.ship_id,
            new_row: lm.new_row,
            new_col: lm.new_col,
            action: lm.action_type,
            target_ship_id: lm.target_ship_id,
        },
        next,
        events: r.events,
    })
}

/// Uniform over legal non-retreat moves, retreating only when nothing else is
/// legal. The strength floor and the smoke-test player.
pub struct RandomTactician;

fn random_move(moves: &[Candidate], rng: &mut ChaCha8Rng) -> Option<MoveInput> {
    let main: Vec<_> = moves
        .iter()
        .filter(|c| c.mv.action != ActionType::Retreat)
        .collect();
    let pool: Vec<_> = if main.is_empty() {
        moves.iter().collect()
    } else {
        main
    };
    (!pool.is_empty()).then(|| pool[rng.gen_range(0..pool.len())].mv.clone())
}

impl Tactician for RandomTactician {
    fn name(&self) -> String {
        "random".into()
    }
    fn choose(
        &self,
        g: &GameState,
        rules: &LocalRules,
        side: Side,
        rng: &mut ChaCha8Rng,
    ) -> Option<MoveInput> {
        random_move(&legal_moves(g, rules, side, Targets::Pruned), rng)
    }
}

/// One-ply greedy: evaluate every legal move's resulting position.
pub struct GreedyTactician {
    pub label: String,
    pub eval: Eval,
    /// Softmax temperature over evaluations (0 = argmax, random tie-break).
    pub temperature: f32,
    /// Chance of a uniformly random legal move.
    pub epsilon: f32,
}

/// Index of the chosen score: argmax (random among ties) or a softmax draw.
fn pick(scores: &[f32], temperature: f32, rng: &mut ChaCha8Rng) -> usize {
    let max = scores.iter().cloned().fold(f32::NEG_INFINITY, f32::max);
    if temperature <= 0.0 {
        let best: Vec<usize> = (0..scores.len())
            .filter(|&i| scores[i] >= max - 1e-6)
            .collect();
        return best[rng.gen_range(0..best.len())];
    }
    let w: Vec<f64> = scores
        .iter()
        .map(|s| (((s - max) / temperature) as f64).exp())
        .collect();
    let mut r = rng.gen::<f64>() * w.iter().sum::<f64>();
    for (i, x) in w.iter().enumerate() {
        r -= x;
        if r <= 0.0 {
            return i;
        }
    }
    w.len() - 1
}

impl Tactician for GreedyTactician {
    fn name(&self) -> String {
        self.label.clone()
    }
    fn choose(
        &self,
        g: &GameState,
        rules: &LocalRules,
        side: Side,
        rng: &mut ChaCha8Rng,
    ) -> Option<MoveInput> {
        let moves = legal_moves(g, rules, side, Targets::Pruned);
        if moves.is_empty() {
            return None;
        }
        if self.epsilon > 0.0 && rng.gen::<f32>() < self.epsilon {
            return random_move(&moves, rng);
        }
        let scores: Vec<f32> = {
            // Parallel, order-preserving: identical to the sequential map.
            // With loss preferences, moves are compared by the player's
            // utility (win probability plus ships kept).
            use rayon::prelude::*;
            let prefs = self.eval.loss.is_some();
            moves
                .par_iter()
                .map(|c| {
                    if prefs {
                        self.eval.utility(&c.next, side)
                    } else {
                        self.eval.evaluate(&c.next, side)
                    }
                })
                .collect()
        };
        Some(moves[pick(&scores, self.temperature, rng)].mv.clone())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct MctsParams {
    /// Simulations per move (fixed count, so results are reproducible).
    pub simulations: u32,
    /// UCT exploration constant.
    pub c_uct: f32,
    /// Progressive widening: a node visited N times may have
    /// ceil(widen_base + widen_rate * sqrt(N)) children.
    pub widen_base: f32,
    pub widen_rate: f32,
    /// Leaf look-ahead: plies of Average (greedy) play before evaluating.
    #[serde(default)]
    pub rollout_plies: u32,
    /// In PvE, predict the on-chain AI's replies by running it (it's
    /// deterministic) instead of searching them. Off = treat it like an
    /// unknown opponent (the first run's behaviour).
    #[serde(default = "yes")]
    pub model_onchain_ai: bool,
}

fn yes() -> bool {
    true
}

impl Default for MctsParams {
    fn default() -> Self {
        MctsParams {
            simulations: 200,
            c_uct: 1.0,
            widen_base: 2.0,
            widen_rate: 1.0,
            rollout_plies: 0,
            model_onchain_ai: true,
        }
    }
}

/// Monte Carlo tree search with the evaluation at the leaves.
pub struct MctsTactician {
    pub label: String,
    pub eval: Eval,
    pub params: MctsParams,
}

struct Node {
    g: GameState,
    /// Legal moves not yet expanded, best one-ply evaluation (for the mover) first.
    pending: Option<Vec<Candidate>>,
    children: Vec<(MoveInput, usize)>,
    n: u32,
    /// Sum of values from the root side's perspective.
    w: f64,
    terminal: bool,
}

/// One search: the root side, and the on-chain AI's configs when the
/// opponent is that AI and it's being modelled.
#[derive(Clone, Copy)]
struct Search<'a> {
    root: Side,
    ai: Option<&'a AiInfo>,
}

impl MctsTactician {
    /// Legal moves with a one-ply score for the mover, in generation order
    /// (scored in parallel; order-preserving). With loss preferences the
    /// score is the root player's utility (negated for the opponent);
    /// otherwise the evaluation for the mover. When the mover is the
    /// modelled on-chain AI, its one actual reply is the only move.
    fn scored(&self, g: &GameState, rules: &LocalRules, s: Search) -> Vec<(f32, Candidate)> {
        use rayon::prelude::*;
        let mover = g.current_turn;
        if let (Some(ai), true) = (s.ai, mover != s.root) {
            return ai_reply(g, rules, ai).map(|c| (0.0, c)).into_iter().collect();
        }
        let prefs = self.eval.loss.is_some();
        legal_moves(g, rules, mover, Targets::Pruned)
            .into_par_iter()
            .map(|c| {
                let v = if !prefs {
                    self.eval.evaluate(&c.next, mover)
                } else if mover == s.root {
                    self.eval.utility(&c.next, s.root)
                } else {
                    -self.eval.utility(&c.next, s.root)
                };
                (v, c)
            })
            .collect()
    }

    fn ordered_moves(&self, g: &GameState, rules: &LocalRules, s: Search) -> Vec<Candidate> {
        let mut c = self.scored(g, rules, s);
        // Stable sort: ties keep generation order (deterministic).
        c.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
        c.into_iter().map(|x| x.1).collect()
    }

    /// Leaf value for the root side: optionally play `rollout_plies` greedy
    /// plies first (deterministic: the first best move in generation order),
    /// then evaluate. Also returns the leaf's ordered move list when it was
    /// computed (the first look-ahead ply needs exactly that list, and its
    /// first entry is that ply's pick), so the node never recomputes it.
    fn leaf_value(
        &self,
        g: &GameState,
        rules: &LocalRules,
        s: Search,
    ) -> (f64, Option<Vec<Candidate>>) {
        if self.params.rollout_plies == 0 || g.ended {
            return (self.eval.utility(g, s.root) as f64, None);
        }
        let ordered = self.ordered_moves(g, rules, s);
        let Some(first) = ordered.first() else {
            return (self.eval.utility(g, s.root) as f64, Some(ordered));
        };
        let mut g = first.next.clone();
        for _ in 1..self.params.rollout_plies {
            if g.ended {
                break;
            }
            let Some(best) = self.scored(&g, rules, s).into_iter().fold(
                None,
                |acc: Option<(f32, Candidate)>, x| match acc {
                    Some(a) if a.0 >= x.0 => Some(a),
                    _ => Some(x),
                },
            ) else {
                break;
            };
            g = best.1.next;
        }
        (self.eval.utility(&g, s.root) as f64, Some(ordered))
    }
}

impl Tactician for MctsTactician {
    fn name(&self) -> String {
        self.label.clone()
    }
    fn choose(
        &self,
        g: &GameState,
        rules: &LocalRules,
        side: Side,
        rng: &mut ChaCha8Rng,
    ) -> Option<MoveInput> {
        self.choose_vs(g, rules, side, rng, None)
    }
    fn choose_vs(
        &self,
        g: &GameState,
        rules: &LocalRules,
        side: Side,
        _rng: &mut ChaCha8Rng,
        ai: Option<&AiInfo>,
    ) -> Option<MoveInput> {
        let s = Search {
            root: side,
            ai: ai.filter(|_| self.params.model_onchain_ai),
        };
        let root_moves = self.ordered_moves(g, rules, s);
        if root_moves.len() <= 1 {
            return root_moves.first().map(|c| c.mv.clone());
        }
        let p = &self.params;
        let mut nodes = vec![Node {
            g: g.clone(),
            pending: Some(root_moves),
            children: Vec::new(),
            n: 0,
            w: 0.0,
            terminal: false,
        }];
        // Values seen so far, to normalize Q into [0, 1] (as MuZero does):
        // win probabilities of sibling moves differ by little, and unscaled
        // they'd be swamped by the exploration term.
        let (mut vmin, mut vmax) = (f64::INFINITY, f64::NEG_INFINITY);
        for _ in 0..p.simulations {
            let mut path = vec![0usize];
            let mut cur = 0usize;
            let value: f64 = loop {
                if nodes[cur].terminal {
                    break nodes[cur].w / nodes[cur].n.max(1) as f64;
                }
                if nodes[cur].pending.is_none() {
                    let m = self.ordered_moves(&nodes[cur].g, rules, s);
                    nodes[cur].pending = Some(m);
                }
                let allowed =
                    (p.widen_base + p.widen_rate * (nodes[cur].n as f32).sqrt()).ceil() as usize;
                let can_expand = nodes[cur].pending.as_ref().is_some_and(|v| !v.is_empty());
                if can_expand && nodes[cur].children.len() < allowed {
                    // Expand the best not-yet-expanded move and evaluate it.
                    let c = nodes[cur].pending.as_mut().unwrap().remove(0);
                    let (v, pending) = self.leaf_value(&c.next, rules, s);
                    let terminal = c.next.ended;
                    nodes.push(Node {
                        g: c.next,
                        pending,
                        children: Vec::new(),
                        n: 1,
                        w: v,
                        terminal,
                    });
                    let id = nodes.len() - 1;
                    nodes[cur].children.push((c.mv, id));
                    break v;
                }
                if nodes[cur].children.is_empty() {
                    // No legal move here: score the position as it stands.
                    break self.eval.utility(&nodes[cur].g, side) as f64;
                }
                // UCT, from the perspective of whoever moves at this node.
                let ours = nodes[cur].g.current_turn == side;
                let ln_n = (nodes[cur].n.max(1) as f64).ln();
                let mut best = (f64::NEG_INFINITY, 0usize);
                for &(_, id) in &nodes[cur].children {
                    let ch = &nodes[id];
                    let q = ch.w / ch.n as f64;
                    let q = if vmax > vmin {
                        (q - vmin) / (vmax - vmin)
                    } else {
                        0.5
                    };
                    let q = if ours { q } else { 1.0 - q };
                    let u = q + p.c_uct as f64 * (ln_n / ch.n as f64).sqrt();
                    if u > best.0 {
                        best = (u, id);
                    }
                }
                cur = best.1;
                path.push(cur);
            };
            vmin = vmin.min(value);
            vmax = vmax.max(value);
            for &i in &path {
                nodes[i].n += 1;
                nodes[i].w += value;
            }
        }
        nodes[0]
            .children
            .iter()
            .max_by(|a, b| {
                let (x, y) = (&nodes[a.1], &nodes[b.1]);
                x.n.cmp(&y.n)
                    .then(
                        (x.w / x.n as f64)
                            .partial_cmp(&(y.w / y.n as f64))
                            .unwrap_or(std::cmp::Ordering::Equal),
                    )
                    .then(b.1.cmp(&a.1))
            })
            .map(|c| c.0.clone())
    }
}

fn one() -> f32 {
    1.0
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, PartialOrd, Ord)]
pub enum Level {
    Poor,
    Average,
    Excellent,
}

impl Level {
    pub const ALL: [Level; 3] = [Level::Poor, Level::Average, Level::Excellent];
    pub fn name(self) -> &'static str {
        match self {
            Level::Poor => "poor",
            Level::Average => "average",
            Level::Excellent => "excellent",
        }
    }
}

/// Knobs for each skill level (near/sim/tactics.json, written by calibration).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TacticsConfig {
    /// Poor's calibrated noise dial (see `calibrate::poor_eval`).
    #[serde(default = "one")]
    pub poor_noise: f32,
    pub poor_temperature: f32,
    pub poor_epsilon: f32,
    pub average_temperature: f32,
    pub excellent: MctsParams,
    /// Default ship-loss aversion per level [poor, average, excellent], in
    /// win-probability units per ship (see `eval::LossPrefs`), for games
    /// with no player profile (training, calibration, benches). The economy
    /// sets it per player from the spend profile and hangar instead
    /// (`make_with`). A preference, not calibrated; Poor players don't
    /// think about it.
    #[serde(default = "default_loss_aversion")]
    pub loss_aversion: [f32; 3],
    #[serde(default)]
    pub provenance: serde_json::Value,
}

fn default_loss_aversion() -> [f32; 3] {
    [0.0, 0.05, 0.05]
}

impl Default for TacticsConfig {
    fn default() -> Self {
        TacticsConfig {
            poor_noise: 1.0,
            poor_temperature: 0.5,
            poor_epsilon: 0.3,
            average_temperature: 0.0,
            excellent: MctsParams::default(),
            loss_aversion: default_loss_aversion(),
            provenance: serde_json::json!("defaults (uncalibrated)"),
        }
    }
}

impl TacticsConfig {
    pub fn load(path: &Path) -> std::io::Result<TacticsConfig> {
        Ok(serde_json::from_str(&std::fs::read_to_string(path)?)?)
    }
    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        if let Some(d) = path.parent() {
            std::fs::create_dir_all(d)?;
        }
        std::fs::write(path, serde_json::to_string_pretty(self)? + "\n")
    }

    /// A tactician with this level's default loss aversion.
    pub fn make(&self, level: Level, eval: &Eval) -> Box<dyn Tactician> {
        let a = self.loss_aversion[level as usize];
        self.make_with(level, eval, (a > 0.0).then(|| LossPrefs::uniform(a)))
    }

    /// A tactician with a specific player's loss preferences (ignored for
    /// Poor, who doesn't think about ship losses).
    pub fn make_with(&self, level: Level, eval: &Eval, prefs: Option<LossPrefs>) -> Box<dyn Tactician> {
        let eval = &Eval {
            loss: if level == Level::Poor {
                None
            } else {
                prefs.map(Arc::new)
            },
            ..eval.clone()
        };
        match level {
            Level::Poor => Box::new(GreedyTactician {
                label: "poor".into(),
                eval: crate::calibrate::poor_eval(eval, self.poor_noise),
                temperature: self.poor_temperature,
                epsilon: self.poor_epsilon,
            }),
            Level::Average => Box::new(GreedyTactician {
                label: "average".into(),
                eval: eval.clone(),
                temperature: self.average_temperature,
                epsilon: 0.0,
            }),
            Level::Excellent => Box::new(MctsTactician {
                label: "excellent".into(),
                eval: eval.clone(),
                params: self.excellent.clone(),
            }),
        }
    }
}

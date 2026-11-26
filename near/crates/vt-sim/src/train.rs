//! Training the evaluation weights by self-play with separable CMA-ES
//! (Ros & Hansen 2008: CMA-ES with a diagonal covariance, suited to a small
//! weight vector and noisy fitness).
//!
//! Fitness of a candidate weight vector, played by the Average (greedy)
//! policy: half its score against the generation's incumbent (the current
//! mean) over paired PvP scenarios, half its campaign clear rate against the
//! on-chain AI, half of those games on the hardest campaign nodes (`hard_nodes`;
//! added 2026-11-17 after the first full run showed play was weakest there).
//! All candidates in a generation face the same scenarios
//! (common random numbers). With `style_opponents` (added 2026-11-24) the
//! PvP scenarios rotate between the incumbent and two styled versions of it
//! (`eval::styled_weights`: one that pushes a raider onto enemy-side tiles,
//! one that parks an anchor on home tiles), so defending home and
//! contesting a raid can pay. Afterwards, `fit_value_scale` calibrates the
//! evaluation to a win probability on self-play positions.

use rand::SeedableRng;
use rand_chacha::ChaCha8Rng;
use rand_distr_free::standard_normal;
use rayon::prelude::*;
use serde::Serialize;

use crate::arena::{creator_points, mix, pve_game, PvpScenario, ScenarioOpts};
use crate::content::Content;
use crate::eval::{sigmoid, Eval, N_FEATURES};
use crate::rules::Config;
use crate::runner::Limits;
use crate::tactics::{GreedyTactician, Tactician};

/// Box–Muller normal sampling (keeps the dependency list short).
mod rand_distr_free {
    use rand::Rng;
    pub fn standard_normal<R: Rng>(rng: &mut R) -> f64 {
        let u1: f64 = rng.gen::<f64>().max(1e-300);
        let u2: f64 = rng.gen();
        (-2.0 * u1.ln()).sqrt() * (2.0 * std::f64::consts::PI * u2).cos()
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct TrainOpts {
    pub generations: u32,
    pub lambda: usize,
    pub sigma0: f64,
    pub pvp_scenarios: u32,
    pub pve_games: u32,
    pub value_fit_scenarios: u32,
    pub seed: u64,
    /// Share of the campaign fitness games played on `hard_nodes`.
    pub hard_share: f64,
    /// Campaign nodes where play was weakest in the first full run.
    pub hard_nodes: Vec<String>,
    /// Share of the PvE fitness games that are roguelike combat nodes
    /// (single fights, random variant-1 fleets under `roguelike_cap`). Added
    /// 2026-11-18: some roguelike maps (Interference, Interception) have
    /// scoring tiles worth almost nothing against their max score, which
    /// the campaign never shows.
    #[serde(default)]
    pub roguelike_share: f64,
    #[serde(default)]
    pub roguelike_cap: u64,
    /// PvP scenario i faces the incumbent (i % 3 == 0), its raider style
    /// (1) or its anchor style (2). False: always the incumbent.
    #[serde(default)]
    pub style_opponents: bool,
    /// Added 2026-11-25: PvP scenario i faces the incumbent (i % 5 == 0) or
    /// one of its purpose styles (Home, Center, Rush, Support), in place of
    /// the raider/anchor rotation.
    #[serde(default)]
    pub purpose_styles: bool,
    /// Added 2026-11-25: both fleets deploy by purpose (`purpose::cells`)
    /// instead of at random cells.
    #[serde(default)]
    pub purpose_deploy: bool,
}

impl Default for TrainOpts {
    fn default() -> Self {
        TrainOpts {
            generations: 40,
            lambda: 12,
            sigma0: 0.3,
            pvp_scenarios: 16,
            pve_games: 16,
            value_fit_scenarios: 200,
            seed: 1,
            hard_share: 0.5,
            // The later roguelike missions (2026-11-20: the missions are the
            // roguelike's reachable combat nodes; see content.rs).
            hard_nodes: ["m09", "m10", "m13", "m14", "m11", "m15"]
                .iter()
                .map(|s| s.to_string())
                .collect(),
            // The missions already are roguelike fights (at their real caps).
            roguelike_share: 0.0,
            roguelike_cap: 1000,
            style_opponents: true,
            purpose_styles: false,
            purpose_deploy: false,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct GenerationLog {
    pub generation: u32,
    pub best_fitness: f64,
    pub mean_fitness: f64,
    pub sigma: f64,
    pub mean: Vec<f32>,
}

fn greedy(weights: &[f64]) -> GreedyTactician {
    let e = Eval {
        weights: weights.iter().map(|&w| w as f32).collect(),
        ..Eval::default()
    };
    GreedyTactician {
        label: "cand".into(),
        eval: e,
        temperature: 0.0,
        epsilon: 0.0,
    }
}

/// Fitness of each candidate against `incumbent` on this generation's
/// scenarios (deterministic for a given seed and generation).
fn fitness(
    content: &Content,
    cfg: &Config,
    cands: &[Vec<f64>],
    incumbent: &[f64],
    gen_seed: u64,
    o: &TrainOpts,
) -> Vec<f64> {
    let limits = Limits::default();
    let sopts = ScenarioOpts::default();
    let inc = greedy(incumbent);
    let raider = greedy(&crate::eval::styled_weights(incumbent, crate::eval::Style::Raider));
    let anchor = greedy(&crate::eval::styled_weights(incumbent, crate::eval::Style::Anchor));
    use crate::eval::Style;
    let purpose: Vec<GreedyTactician> = [Style::Home, Style::Center, Style::Rush, Style::Support]
        .iter()
        .map(|&s| greedy(&crate::eval::styled_weights(incumbent, s)))
        .collect();
    let opponent = |i: usize| -> &GreedyTactician {
        if !o.style_opponents {
            return &inc;
        }
        if o.purpose_styles {
            return match i % 5 {
                0 => &inc,
                j => &purpose[j - 1],
            };
        }
        match i % 3 {
            0 => &inc,
            1 => &raider,
            _ => &anchor,
        }
    };
    let scenarios: Vec<PvpScenario> = (0..o.pvp_scenarios)
        .map(|i| {
            let mut sc = PvpScenario::random(content, cfg, mix(gen_seed, i as u64, 11), &sopts);
            if o.purpose_deploy {
                sc.deploy_by_purpose(content, cfg, &[0, 1]);
            }
            sc
        })
        .collect();
    let nodes = content.sp_nodes.len();
    let hard: Vec<usize> = o
        .hard_nodes
        .iter()
        .filter_map(|k| content.sp_nodes.iter().position(|n| &n.key == k))
        .collect();
    let rl_nodes = crate::arena::roguelike_combat_nodes(content);
    // This generation's PvE games (the same for every candidate): Ok(node
    // index) for a campaign node, Err(key) for a roguelike fight.
    let pve_nodes: Vec<Result<usize, String>> = (0..o.pve_games)
        .map(|k| {
            let r = mix(gen_seed, k as u64, 21);
            let u = (r >> 32) as f64 / u32::MAX as f64;
            if !rl_nodes.is_empty() && u < o.roguelike_share {
                Err(rl_nodes[(r % rl_nodes.len() as u64) as usize].clone())
            } else if !hard.is_empty() && u < o.roguelike_share + o.hard_share * (1.0 - o.roguelike_share) {
                Ok(hard[(r % hard.len() as u64) as usize])
            } else {
                Ok((r % nodes as u64) as usize)
            }
        })
        .collect();
    cands
        .par_iter()
        .map(|w| {
            let c = greedy(w);
            let mut pvp = 0.0;
            for (i, sc) in scenarios.iter().enumerate() {
                let opp = opponent(i);
                pvp += creator_points(&sc.play(content, cfg, ("c", &c), ("i", opp), 0, limits));
                pvp +=
                    1.0 - creator_points(&sc.play(content, cfg, ("i", opp), ("c", &c), 0, limits));
            }
            let pvp = pvp / (2.0 * o.pvp_scenarios as f64);
            let mut wins = 0.0;
            for (k, node) in pve_nodes.iter().enumerate() {
                let seed = mix(gen_seed, k as u64, 22);
                let log = match node {
                    Ok(i) => pve_game(content, cfg, &c, *i, seed, limits),
                    Err(key) => crate::arena::roguelike_fight(content, cfg, &c, key, o.roguelike_cap, seed, limits),
                };
                if log.winner == "creator" {
                    wins += 1.0;
                }
            }
            0.5 * pvp + 0.5 * wins / o.pve_games.max(1) as f64
        })
        .collect()
}

/// sep-CMA-ES over the weight vector, starting from `start`.
pub fn train(
    content: &Content,
    cfg: &Config,
    start: &[f32],
    o: &TrainOpts,
    mut on_gen: impl FnMut(&GenerationLog),
) -> (Vec<f32>, Vec<GenerationLog>) {
    let n = N_FEATURES;
    let nf = n as f64;
    let lambda = o.lambda;
    let mu = lambda / 2;
    let raw: Vec<f64> = (0..mu)
        .map(|i| (mu as f64 + 0.5).ln() - ((i + 1) as f64).ln())
        .collect();
    let sw: f64 = raw.iter().sum();
    let w: Vec<f64> = raw.iter().map(|x| x / sw).collect();
    let mu_eff = 1.0 / w.iter().map(|x| x * x).sum::<f64>();
    let c_sigma = (mu_eff + 2.0) / (nf + mu_eff + 5.0);
    let d_sigma = 1.0 + 2.0 * (((mu_eff - 1.0) / (nf + 1.0)).sqrt() - 1.0).max(0.0) + c_sigma;
    let cc = (4.0 + mu_eff / nf) / (nf + 4.0 + 2.0 * mu_eff / nf);
    let c1 = 2.0 / ((nf + 1.3).powi(2) + mu_eff);
    let cmu = (1.0 - c1).min(2.0 * (mu_eff - 2.0 + 1.0 / mu_eff) / ((nf + 2.0).powi(2) + mu_eff));
    // Separable variant: larger learning rates for the diagonal.
    let (c1, cmu) = (
        (c1 * (nf + 2.0) / 3.0).min(0.9),
        (cmu * (nf + 2.0) / 3.0).min(0.9),
    );
    let (c1, cmu) = if c1 + cmu > 1.0 {
        (c1 / (c1 + cmu), cmu / (c1 + cmu))
    } else {
        (c1, cmu)
    };
    let chi_n = nf.sqrt() * (1.0 - 1.0 / (4.0 * nf) + 1.0 / (21.0 * nf * nf));

    let mut m: Vec<f64> = start.iter().map(|&x| x as f64).collect();
    let mut sigma = o.sigma0;
    let mut c = vec![1.0f64; n];
    let mut ps = vec![0.0f64; n];
    let mut pc = vec![0.0f64; n];
    let mut rng = ChaCha8Rng::seed_from_u64(o.seed);
    let mut history = Vec::new();
    for g in 0..o.generations {
        let ys: Vec<Vec<f64>> = (0..lambda)
            .map(|_| {
                (0..n)
                    .map(|i| c[i].sqrt() * standard_normal(&mut rng))
                    .collect()
            })
            .collect();
        let xs: Vec<Vec<f64>> = ys
            .iter()
            .map(|y| (0..n).map(|i| m[i] + sigma * y[i]).collect())
            .collect();
        let f = fitness(content, cfg, &xs, &m, mix(o.seed, g as u64, 5), o);
        let mut order: Vec<usize> = (0..lambda).collect();
        order.sort_by(|&a, &b| f[b].partial_cmp(&f[a]).unwrap().then(a.cmp(&b)));
        let yw: Vec<f64> = (0..n)
            .map(|i| (0..mu).map(|k| w[k] * ys[order[k]][i]).sum())
            .collect();
        for i in 0..n {
            m[i] += sigma * yw[i];
        }
        let k_sigma = (c_sigma * (2.0 - c_sigma) * mu_eff).sqrt();
        for i in 0..n {
            ps[i] = (1.0 - c_sigma) * ps[i] + k_sigma * yw[i] / c[i].sqrt();
        }
        let ps_norm = ps.iter().map(|x| x * x).sum::<f64>().sqrt();
        sigma *= ((c_sigma / d_sigma) * (ps_norm / chi_n - 1.0)).exp();
        let h_sigma = ps_norm / (1.0 - (1.0 - c_sigma).powi(2 * (g as i32 + 1))).sqrt()
            < (1.4 + 2.0 / (nf + 1.0)) * chi_n;
        let kc = (cc * (2.0 - cc) * mu_eff).sqrt();
        for i in 0..n {
            pc[i] = (1.0 - cc) * pc[i] + if h_sigma { kc * yw[i] } else { 0.0 };
            let rank_mu: f64 = (0..mu).map(|k| w[k] * ys[order[k]][i].powi(2)).sum();
            let correction = if h_sigma { 0.0 } else { cc * (2.0 - cc) * c[i] };
            c[i] = (1.0 - c1 - cmu) * c[i] + c1 * (pc[i] * pc[i] + correction) + cmu * rank_mu;
        }
        let log = GenerationLog {
            generation: g,
            best_fitness: f[order[0]],
            mean_fitness: f.iter().sum::<f64>() / lambda as f64,
            sigma,
            mean: m.iter().map(|&x| x as f32).collect(),
        };
        on_gen(&log);
        history.push(log);
    }
    (m.iter().map(|&x| x as f32).collect(), history)
}

/// Fits P(win) = sigmoid(k * evaluate) by logistic regression (Newton) on
/// every position of Average self-play over paired PvP scenarios.
pub fn fit_value_scale(
    content: &Content,
    cfg: &Config,
    eval: &Eval,
    scenarios: u32,
    seed: u64,
) -> f32 {
    let limits = Limits::default();
    let t = GreedyTactician {
        label: "fit".into(),
        eval: eval.clone(),
        temperature: 0.0,
        epsilon: 0.0,
    };
    let samples: Vec<(f64, f64)> = (0..scenarios)
        .into_par_iter()
        .flat_map_iter(|i| {
            let sc = PvpScenario::random(
                content,
                cfg,
                mix(seed, i as u64, 31),
                &ScenarioOpts::default(),
            );
            let mut out = Vec::new();
            for fa in 0..2 {
                let mut g = sc.start(cfg, content, fa);
                let mut rng = ChaCha8Rng::seed_from_u64(mix(seed, i as u64, 32 + fa as u64));
                let mut evals = Vec::new();
                let mut moves = 0;
                while !g.ended && g.current_round <= limits.max_rounds && moves < limits.max_moves {
                    evals.push(eval.evaluate(&g, vt_core::engine::Side::Creator) as f64);
                    let side = g.current_turn;
                    let Some(mv) = t.choose(&g, &cfg.rules, side, &mut rng) else {
                        break;
                    };
                    g.move_ship(side, &mv, &cfg.rules, 0).expect("legal");
                    moves += 1;
                }
                if !g.ended {
                    continue; // capped or stalled: no clean label
                }
                let y =
                    (crate::eval::terminal(&g, vt_core::engine::Side::Creator) as f64 + 1.0) / 2.0;
                out.extend(evals.into_iter().map(|e| (e, y)));
            }
            out
        })
        .collect();
    let mut k = 0.1f64;
    for _ in 0..100 {
        let (mut grad, mut hess) = (0.0, 1e-9);
        for &(e, y) in &samples {
            let p = sigmoid((k * e) as f32) as f64;
            grad += (p - y) * e;
            hess += p * (1.0 - p) * e * e;
        }
        let step = grad / hess;
        k -= step;
        if step.abs() < 1e-7 {
            break;
        }
    }
    k as f32
}

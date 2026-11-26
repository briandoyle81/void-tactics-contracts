//! Calibration: set each tactics level's knobs, then measure every level
//! against the on-chain AI so the labels mean something concrete.
//!
//! Since 2026-11-17 (iteration 2), Excellent is anchored to a strong human
//! rather than to a fixed gap over Average: it gets the strongest search we
//! can afford (the shortest leaf look-ahead whose campaign clear rate is
//! within `excellent_tolerance` of the best on the ladder), checked against
//! the human benchmark (`vt-sim human-bench`). Average (greedy, no knob) is
//! measured, and Poor's noise is set below Average (Average beats Poor
//! `target` head to head). The Excellent-vs-Average gap lands wherever it
//! lands, and is reported.

use serde::Serialize;

use crate::arena::{head_to_head, pve_benchmark, HeadToHead, ScenarioOpts};
use crate::content::Content;
use crate::eval::{Eval, POOR_MASK};
use crate::rules::Config;
use crate::runner::Limits;
use crate::tactics::{GreedyTactician, Level, MctsParams, MctsTactician, TacticsConfig};

#[derive(Clone, Debug, Serialize)]
pub struct CalibrateOpts {
    pub target: f64,
    pub scenarios: u32,
    pub bisection_steps: u32,
    /// Excellent's strength ladder: leaf look-ahead plies at `simulations`
    /// (a sweep showed look-ahead, not simulation count, is what scales).
    pub rollout_ladder: Vec<u32>,
    /// Excellent takes the shortest look-ahead whose campaign clear rate is
    /// within this of the ladder's best.
    pub excellent_tolerance: f64,
    pub simulations: u32,
    pub pve_fleets_per_node: u32,
    pub seed: u64,
}

impl Default for CalibrateOpts {
    fn default() -> Self {
        CalibrateOpts {
            target: 0.75,
            scenarios: 100,
            bisection_steps: 7,
            rollout_ladder: vec![4, 6, 8],
            excellent_tolerance: 0.02,
            simulations: 100,
            pve_fleets_per_node: 4,
            seed: 7,
        }
    }
}

/// Poor's single noise dial t in [0, 1]: at 0 Poor is Average; as t rises
/// it fades out the positional features (keeping material and score), gets
/// noisier (softmax temperature) and makes more random moves.
pub fn poor_knobs(t: f32) -> (f32, f32) {
    (0.5 * t, 0.3 * t) // (temperature, epsilon)
}

/// Poor's evaluation at noise t: features outside POOR_MASK scaled by 1 - t.
pub fn poor_eval(eval: &Eval, t: f32) -> Eval {
    let mut e = eval.clone();
    for (w, &keep) in e.weights.iter_mut().zip(&POOR_MASK) {
        if !keep {
            *w *= 1.0 - t;
        }
    }
    e
}

#[derive(Debug, Serialize)]
pub struct Calibration {
    pub opts: CalibrateOpts,
    pub poor_noise: f32,
    pub poor_trace: Vec<(f32, HeadToHead)>,
    /// (rollout plies, result vs Average, campaign clear rate, seconds)
    pub excellent_trace: Vec<(u32, HeadToHead, f64, f64)>,
    pub warnings: Vec<String>,
    pub pve_clear_rate: Vec<(String, f64)>,
    pub ladder: Vec<(String, String, HeadToHead)>,
}

pub fn calibrate(
    content: &Content,
    cfg: &Config,
    eval: &Eval,
    o: &CalibrateOpts,
    log: &mut dyn FnMut(&str),
) -> (TacticsConfig, Calibration) {
    let limits = Limits::default();
    let sopts = ScenarioOpts::default();
    // Each level plays with its loss aversion, exactly as `TacticsConfig::make`
    // builds it, so the calibrated gaps are the ones games actually see.
    let la = TacticsConfig::default().loss_aversion;
    let with_la = |level: usize| Eval {
        loss: (level > 0 && la[level] > 0.0)
            .then(|| std::sync::Arc::new(crate::eval::LossPrefs::uniform(la[level]))),
        ..eval.clone()
    };
    let (eval_poor, eval_avg, eval_ex) = (with_la(0), with_la(1), with_la(2));
    let average = GreedyTactician {
        label: "average".into(),
        eval: eval_avg.clone(),
        temperature: 0.0,
        epsilon: 0.0,
    };
    let poor = |t: f32| {
        let (temperature, epsilon) = poor_knobs(t);
        GreedyTactician {
            label: "poor".into(),
            eval: poor_eval(&eval_poor, t),
            temperature,
            epsilon,
        }
    };
    let mut warnings = Vec::new();

    // Poor: Average's score vs Poor rises with Poor's noise; bisect to target.
    let mut trace = Vec::new();
    let vs = |t: f32| {
        head_to_head(
            content,
            cfg,
            &average,
            &poor(t),
            o.scenarios,
            o.seed,
            &sopts,
            limits,
        )
        .0
    };
    let at1 = vs(1.0);
    log(&format!(
        "poor noise 1.000: average scores {:.3} ±{:.3}",
        at1.a_score, at1.ci95
    ));
    if at1.a_score < o.target {
        warnings.push(format!(
            "Poor at full noise only loses {:.0}% to Average (target {:.0}%)",
            at1.a_score * 100.0,
            o.target * 100.0
        ));
    }
    trace.push((1.0, at1));
    let noise = {
        let (mut lo, mut hi) = (0.0f32, 1.0f32);
        for _ in 0..o.bisection_steps {
            let mid = (lo + hi) / 2.0;
            let h = vs(mid);
            log(&format!(
                "poor noise {mid:.3}: average scores {:.3} ±{:.3}",
                h.a_score, h.ci95
            ));
            if h.a_score < o.target {
                lo = mid;
            } else {
                hi = mid;
            }
            trace.push((mid, h));
        }
        (lo + hi) / 2.0
    };

    // Excellent: as strong as we can afford. For each look-ahead on the
    // ladder, its campaign clear rate (modelling the on-chain AI, as games
    // do) and its score vs Average; keep the shortest look-ahead within
    // tolerance of the best clear rate.
    let mut etrace = Vec::new();
    let params = |plies: u32| MctsParams {
        simulations: o.simulations,
        rollout_plies: plies,
        ..MctsParams::default()
    };
    for &plies in &o.rollout_ladder {
        let ex = MctsTactician {
            label: "excellent".into(),
            eval: eval_ex.clone(),
            params: params(plies),
        };
        let t = std::time::Instant::now();
        let (clear, _) = pve_benchmark(content, cfg, &ex, o.pve_fleets_per_node, o.seed, limits);
        let h = head_to_head(
            content,
            cfg,
            &ex,
            &average,
            o.scenarios,
            o.seed,
            &sopts,
            limits,
        )
        .0;
        let secs = t.elapsed().as_secs_f64();
        log(&format!(
            "excellent look-ahead {plies} plies: campaign clear {clear:.3}, scores {:.3} ±{:.3} vs average ({secs:.0}s)",
            h.a_score, h.ci95
        ));
        etrace.push((plies, h, clear, secs));
    }
    let best_clear = etrace.iter().map(|e| e.2).fold(0.0f64, f64::max);
    let sims = etrace
        .iter()
        .find(|e| e.2 >= best_clear - o.excellent_tolerance)
        .map_or(4, |e| e.0);

    let (temperature, epsilon) = poor_knobs(noise);
    let mut tc = TacticsConfig {
        poor_noise: noise,
        poor_temperature: temperature,
        poor_epsilon: epsilon,
        average_temperature: 0.0,
        excellent: params(sims),
        loss_aversion: TacticsConfig::default().loss_aversion,
        provenance: serde_json::Value::Null,
    };

    // Final ladder with the chosen knobs, and the on-chain AI yardstick.
    let t: Vec<_> = Level::ALL.iter().map(|&l| tc.make(l, eval)).collect();
    let mut ladder = Vec::new();
    for (a, b) in [(1usize, 0usize), (2, 1), (2, 0)] {
        let h = head_to_head(
            content,
            cfg,
            t[a].as_ref(),
            t[b].as_ref(),
            o.scenarios,
            o.seed + 1,
            &sopts,
            limits,
        )
        .0;
        log(&format!(
            "final: {} vs {}: {:.3} ±{:.3}",
            t[a].name(),
            t[b].name(),
            h.a_score,
            h.ci95
        ));
        ladder.push((t[a].name(), t[b].name(), h));
    }
    let mut pve = Vec::new();
    for (i, l) in Level::ALL.iter().enumerate() {
        let (rate, _) = pve_benchmark(
            content,
            cfg,
            t[i].as_ref(),
            o.pve_fleets_per_node,
            o.seed,
            limits,
        );
        log(&format!(
            "{} campaign clear rate vs on-chain AI: {:.3}",
            l.name(),
            rate
        ));
        pve.push((l.name().to_string(), rate));
    }
    for w in pve.windows(2) {
        if w[1].1 < w[0].1 {
            warnings.push(format!(
                "PvE clear rate is not monotone: {} {:.3} < {} {:.3}",
                w[1].0, w[1].1, w[0].0, w[0].1
            ));
        }
    }
    let cal = Calibration {
        opts: o.clone(),
        poor_noise: noise,
        poor_trace: trace,
        excellent_trace: etrace,
        warnings,
        pve_clear_rate: pve,
        ladder,
    };
    tc.provenance = serde_json::json!({
        "poor_noise": cal.poor_noise,
        "ladder": cal.ladder.iter().map(|(a, b, h)| serde_json::json!({"a": a, "b": b, "a_score": h.a_score, "ci95": h.ci95, "games": h.games})).collect::<Vec<_>>(),
        "pve_clear_rate": cal.pve_clear_rate,
        "warnings": cal.warnings,
    });
    (tc, cal)
}

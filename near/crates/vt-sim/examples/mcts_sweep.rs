//! Sweep MCTS settings against Average (sizes the Excellent level).
//!   cargo run -p vt-sim --profile sim --example mcts_sweep -- [scenarios]
use std::time::Instant;

use vt_sim::arena::{head_to_head, ScenarioOpts};
use vt_sim::content::Content;
use vt_sim::eval::Eval;
use vt_sim::rules::{repo_root, Config};
use vt_sim::tactics::{GreedyTactician, MctsParams, MctsTactician};

fn main() {
    let scenarios: u32 = std::env::args().nth(1).map_or(60, |s| s.parse().unwrap());
    let (content, cfg) = (Content::load(), Config::load());
    let eval = Eval::load(&repo_root().join("near/sim/weights/eval.json")).unwrap_or_default();
    let average = GreedyTactician {
        label: "average".into(),
        eval: eval.clone(),
        temperature: 0.0,
        epsilon: 0.0,
    };
    for (sims, c, rollout) in [
        (100, 1.0, 0),
        (400, 1.0, 0),
        (100, 0.3, 0),
        (400, 0.3, 0),
        (100, 1.0, 4),
        (100, 1.0, 8),
        (300, 1.0, 8),
    ] {
        let ex = MctsTactician {
            label: "ex".into(),
            eval: eval.clone(),
            params: MctsParams {
                simulations: sims,
                c_uct: c,
                rollout_plies: rollout,
                ..MctsParams::default()
            },
        };
        let t = Instant::now();
        let (h, _) = head_to_head(
            &content,
            &cfg,
            &ex,
            &average,
            scenarios,
            7,
            &ScenarioOpts::default(),
            Default::default(),
        );
        println!(
            "sims {sims:>4} c {c:.1} rollout {rollout}: {:.3} ±{:.3}  ({:.0?})",
            h.a_score,
            h.ci95,
            t.elapsed()
        );
    }
}

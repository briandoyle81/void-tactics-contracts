//! Times Excellent-vs-Average games (for profiling; output also checks that
//! optimizations leave results unchanged: it prints a digest of the logs).
//!   RAYON_NUM_THREADS=1 cargo run -p vt-sim --profile sim --example excellent_profile -- [scenarios]
use std::hash::{Hash, Hasher};
use std::time::Instant;

use vt_sim::arena::{head_to_head, ScenarioOpts};
use vt_sim::content::Content;
use vt_sim::eval::Eval;
use vt_sim::rules::{repo_root, Config};
use vt_sim::tactics::{Level, TacticsConfig};

fn main() {
    let n: u32 = std::env::args().nth(1).map_or(4, |s| s.parse().unwrap());
    let (content, cfg) = (Content::load(), Config::load());
    let eval = Eval::load(&repo_root().join("near/sim/weights/eval.json")).unwrap();
    let tc = TacticsConfig::load(&repo_root().join("near/sim/tactics.json")).unwrap();
    let (ex, avg) = (
        tc.make(Level::Excellent, &eval),
        tc.make(Level::Average, &eval),
    );
    let t = Instant::now();
    let (h, logs) = head_to_head(
        &content,
        &cfg,
        ex.as_ref(),
        avg.as_ref(),
        n,
        21,
        &ScenarioOpts::default(),
        Default::default(),
    );
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    serde_json::to_string(&logs).unwrap().hash(&mut hasher);
    println!(
        "{} games in {:.2?}; score {:.3}; digest {:016x}",
        h.games,
        t.elapsed(),
        h.a_score,
        hasher.finish()
    );
}

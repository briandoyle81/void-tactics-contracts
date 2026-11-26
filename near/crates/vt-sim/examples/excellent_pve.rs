//! Excellent tactics against the on-chain AI, with and without modelling the
//! AI's replies in search: campaign clear rate per node (random fleets, the
//! same fleets for every setting), own ships destroyed and retreated, time.
//!   cargo run -p vt-sim --profile sim --example excellent_pve -- [fleets_per_node] [plies] [sims] [aversion] [models] [killable_risk] [weights.json]
//! `models`: "both" (default), "on" or "off".
use std::time::Instant;

use vt_sim::arena::pve_benchmark;
use vt_sim::content::Content;
use vt_sim::eval::Eval;
use vt_sim::rules::{repo_root, Config};
use vt_sim::tactics::{Level, TacticsConfig};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let n: u32 = args.get(1).map_or(4, |s| s.parse().unwrap());
    let plies: Option<u32> = args.get(2).map(|s| s.parse().unwrap());
    let sims: Option<u32> = args.get(3).map(|s| s.parse().unwrap());
    let aversion: Option<f32> = args.get(4).map(|s| s.parse().unwrap());
    let killable: f32 = args
        .get(6)
        .map_or(vt_sim::eval::KILLABLE_RISK, |s| s.parse().unwrap());
    let models: Vec<bool> = match args.get(5).map(String::as_str) {
        Some("on") => vec![true],
        Some("off") => vec![false],
        _ => vec![false, true],
    };
    let (content, cfg) = (Content::load(), Config::load());
    let root = repo_root().join("near/sim");
    let eval = Eval::load_mapped(
        &args
            .get(7)
            .map_or(root.join("weights/eval.json"), std::path::PathBuf::from),
    )
    .unwrap();
    let base = TacticsConfig::load(&root.join("tactics.json")).unwrap();
    for model in models {
        let mut tc = base.clone();
        if let Some(a) = aversion {
            tc.loss_aversion = [0.0, a, a];
        }
        tc.excellent.model_onchain_ai = model;
        if let Some(p) = plies {
            tc.excellent.rollout_plies = p;
        }
        if let Some(s) = sims {
            tc.excellent.simulations = s;
        }
        let a = tc.loss_aversion[2];
        let prefs = (a > 0.0).then(|| vt_sim::eval::LossPrefs {
            killable_risk: killable,
            ..vt_sim::eval::LossPrefs::uniform(a)
        });
        let t = tc.make_with(Level::Excellent, &eval, prefs);
        let start = Instant::now();
        let (rate, logs) = pve_benchmark(&content, &cfg, t.as_ref(), n, 3, Default::default());
        let secs = start.elapsed().as_secs_f64();
        let per = |outcome: &str| {
            logs.iter()
                .map(|m| {
                    m.ship_logs
                        .iter()
                        .filter(|s| s.side == 0 && s.outcome == outcome)
                        .count() as f64
                })
                .sum::<f64>()
                / logs.len() as f64
        };
        println!(
            "model_onchain_ai={model} plies={} sims={} aversion={} killable_risk={killable}: clear {rate:.3}, own destroyed/game {:.2}, retreated/game {:.2}, {secs:.0}s",
            tc.excellent.rollout_plies,
            tc.excellent.simulations,
            tc.loss_aversion[2],
            per("destroyed"),
            per("fled"),
        );
        let mut line = String::new();
        for node in &content.sp_nodes {
            let (w, g) = logs
                .iter()
                .filter(|m| m.node.as_deref() == Some(node.key.as_str()))
                .fold((0, 0), |(w, g), m| (w + (m.winner == "creator") as u32, g + 1));
            line += &format!("{}:{w}/{g} ", node.key);
        }
        println!("  {line}");
    }
}

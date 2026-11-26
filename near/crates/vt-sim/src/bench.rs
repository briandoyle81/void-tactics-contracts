//! `vt-sim bench`: strength ladder and PvE yardstick for the current
//! evaluation weights and tactics config.

use std::time::Instant;

use serde::Serialize;

use crate::arena::{head_to_head, pve_benchmark, HeadToHead, ScenarioOpts};
use crate::content::Content;
use crate::eval::Eval;
use crate::rules::Config;
use crate::runner::Limits;
use crate::tactics::{Level, RandomTactician, TacticsConfig};

#[derive(Serialize, Debug)]
pub struct BenchReport {
    pub pairings: Vec<(String, String, HeadToHead, f64)>,
    /// (level, campaign clear rate vs the on-chain AI, seconds)
    pub pve: Vec<(String, f64, f64)>,
}

pub fn run(
    content: &Content,
    cfg: &Config,
    eval: &Eval,
    tc: &TacticsConfig,
    scenarios: u32,
    fleets_per_node: u32,
    seed: u64,
    levels: &[Level],
) -> BenchReport {
    let limits = Limits::default();
    let opts = ScenarioOpts::default();
    let random = RandomTactician;
    let t: Vec<_> = Level::ALL.iter().map(|&l| tc.make(l, eval)).collect();
    let mut report = BenchReport {
        pairings: Vec::new(),
        pve: Vec::new(),
    };
    let has = |l: Level| levels.contains(&l);
    let mut pair = |an: &str,
                    a: &dyn crate::tactics::Tactician,
                    bn: &str,
                    b: &dyn crate::tactics::Tactician| {
        let s = Instant::now();
        let (h, _) = head_to_head(content, cfg, a, b, scenarios, seed, &opts, limits);
        let secs = s.elapsed().as_secs_f64();
        println!(
            "{an:>9} vs {bn:<9} {:.3} ±{:.3}  ({} games, {} draws, {secs:.1}s)",
            h.a_score, h.ci95, h.games, h.draws
        );
        report.pairings.push((an.into(), bn.into(), h, secs));
    };
    if has(Level::Poor) {
        pair("poor", t[0].as_ref(), "random", &random);
    }
    if has(Level::Average) {
        pair("average", t[1].as_ref(), "random", &random);
    }
    if has(Level::Poor) && has(Level::Average) {
        pair("average", t[1].as_ref(), "poor", t[0].as_ref());
    }
    if has(Level::Excellent) && has(Level::Average) {
        pair("excellent", t[2].as_ref(), "average", t[1].as_ref());
    }
    for &l in levels {
        let s = Instant::now();
        let (rate, _) = pve_benchmark(
            content,
            cfg,
            t[l as usize].as_ref(),
            fleets_per_node,
            seed,
            limits,
        );
        let secs = s.elapsed().as_secs_f64();
        println!(
            "{:>9} campaign clear rate vs on-chain AI: {:.3}  ({secs:.1}s)",
            l.name(),
            rate
        );
        report.pve.push((l.name().into(), rate, secs));
    }
    report
}

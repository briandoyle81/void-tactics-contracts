//! Average tactics' campaign clear rate with and without loss preferences
//! (random fleets, the same fleets each time).
//!   cargo run -p vt-sim --profile sim --example average_pve -- [fleets_per_node] [aversion]
use vt_sim::arena::pve_benchmark;
use vt_sim::content::Content;
use vt_sim::eval::{Eval, LossPrefs};
use vt_sim::rules::{repo_root, Config};
use vt_sim::tactics::{Level, TacticsConfig};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let n: u32 = args.get(1).map_or(4, |s| s.parse().unwrap());
    let a: f32 = args.get(2).map_or(0.2, |s| s.parse().unwrap());
    let (content, cfg) = (Content::load(), Config::load());
    let eval = Eval::load(&repo_root().join("near/sim/weights/eval.json")).unwrap();
    let tc = TacticsConfig::default();
    for prefs in [None, Some(0.0), Some(a)] {
        let t = tc.make_with(Level::Average, &eval, prefs.map(LossPrefs::uniform));
        let (rate, logs) = pve_benchmark(&content, &cfg, t.as_ref(), n, 3, Default::default());
        let per = |o: &str| {
            logs.iter()
                .map(|m| m.ship_logs.iter().filter(|s| s.side == 0 && s.outcome == o).count())
                .sum::<usize>() as f64
                / logs.len() as f64
        };
        println!("aversion {prefs:?}: clear {rate:.3}, destroyed/game {:.2}, retreated/game {:.2}", per("destroyed"), per("fled"));
    }
}

//! What loss aversion costs and saves: Average with it vs without, head to
//! head (score) and ships destroyed per game on each side; also vs the AI.
//!   cargo run -p vt-sim --profile sim --example loss_aversion -- [lambda] [scenarios]
use vt_sim::arena::{head_to_head, pve_benchmark, ScenarioOpts};
use vt_sim::content::Content;
use vt_sim::eval::Eval;
use vt_sim::rules::{repo_root, Config};
use vt_sim::tactics::GreedyTactician;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let lambda: f32 = args.get(1).map_or(0.1, |s| s.parse().unwrap());
    let n: u32 = args.get(2).map_or(150, |s| s.parse().unwrap());
    let (content, cfg) = (Content::load(), Config::load());
    let eval = Eval::load(&repo_root().join("near/sim/weights/eval.json")).unwrap();
    let mk = |l: f32| GreedyTactician {
        label: "x".into(),
        eval: Eval {
            loss: (l > 0.0).then(|| std::sync::Arc::new(vt_sim::eval::LossPrefs::uniform(l))),
            ..eval.clone()
        },
        temperature: 0.0,
        epsilon: 0.0,
    };
    let (h, logs) = head_to_head(
        &content,
        &cfg,
        &mk(lambda),
        &mk(0.0),
        n,
        3,
        &ScenarioOpts::default(),
        Default::default(),
    );
    let lost = |label: &str| -> f64 {
        logs.iter()
            .map(|m| {
                let side = if m.creator.label == label { 0 } else { 1 };
                m.ship_logs
                    .iter()
                    .filter(|s| s.side == side && s.outcome == "destroyed")
                    .count() as f64
            })
            .sum::<f64>()
            / logs.len() as f64
    };
    println!("loss aversion {lambda} vs 0: score {:.3} ±{:.3}; ships destroyed per game: averse {:.2}, not {:.2}", h.a_score, h.ci95, lost("a"), lost("b"));
    for l in [0.0, lambda] {
        let (rate, logs) = pve_benchmark(&content, &cfg, &mk(l), 4, 3, Default::default());
        let lost = logs
            .iter()
            .map(|m| {
                m.ship_logs
                    .iter()
                    .filter(|s| s.side == 0 && s.outcome == "destroyed")
                    .count() as f64
            })
            .sum::<f64>()
            / logs.len() as f64;
        let fled = logs
            .iter()
            .map(|m| {
                m.ship_logs
                    .iter()
                    .filter(|s| s.side == 0 && s.outcome == "fled")
                    .count() as f64
            })
            .sum::<f64>()
            / logs.len() as f64;
        println!("campaign, loss aversion {l}: clear rate {rate:.3}, own ships destroyed/game {lost:.2}, retreated/game {fled:.2}");
    }
}

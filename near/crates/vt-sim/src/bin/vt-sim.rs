//! vt-sim: the balance simulator CLI.
//!
//!   cargo run -p vt-sim --profile sim -- smoke [--seed N] [--pvp N] [--runs N] [--out DIR]
//!
//! Writes <out>/matches.jsonl and <out>/runs.jsonl (default out: near/sim/out/smoke).

use std::path::PathBuf;
use std::time::Instant;

use vt_sim::content::Content;
use vt_sim::eval::Eval;
use vt_sim::experiments::smoke;
use vt_sim::rules::{repo_root, Config};
use vt_sim::tactics::{Level, TacticsConfig};

fn arg(args: &[String], name: &str) -> Option<String> {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1))
        .cloned()
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "--log-moves") {
        // Every command: record each move and board in match logs (big
        // files; for `vt-sim replay`).
        vt_sim::runner::LOG_MOVES.store(true, std::sync::atomic::Ordering::Relaxed);
    }
    match args.first().map(String::as_str) {
        Some("smoke") => {
            let seed: u64 = arg(&args, "--seed").map_or(1, |s| s.parse().expect("--seed"));
            let pvp: usize = arg(&args, "--pvp").map_or(24, |s| s.parse().expect("--pvp"));
            let runs: usize = arg(&args, "--runs").map_or(8, |s| s.parse().expect("--runs"));
            let out = arg(&args, "--out")
                .map(PathBuf::from)
                .unwrap_or_else(|| repo_root().join("near/sim/out/smoke"));
            let t = Instant::now();
            let (content, cfg) = (Content::load(), Config::load());
            let o = smoke(&content, &cfg, seed, pvp, runs);
            std::fs::create_dir_all(&out).expect("out dir");
            std::fs::write(out.join("matches.jsonl"), o.match_lines.join("\n") + "\n")
                .expect("write");
            std::fs::write(out.join("runs.jsonl"), o.run_lines.join("\n") + "\n").expect("write");
            for (k, v) in &o.summary {
                println!("{v:>4}  {k}");
            }
            println!(
                "{} matches, {} runs in {:.2?} -> {}",
                o.match_lines.len(),
                o.run_lines.len(),
                t.elapsed(),
                out.display()
            );
        }
        Some("train") => {
            let (content, cfg) = (Content::load(), Config::load());
            let mut o = vt_sim::train::TrainOpts::default();
            if let Some(v) = arg(&args, "--generations") {
                o.generations = v.parse().expect("--generations");
            }
            if let Some(v) = arg(&args, "--seed") {
                o.seed = v.parse().expect("--seed");
            }
            if let Some(v) = arg(&args, "--pvp") {
                o.pvp_scenarios = v.parse().expect("--pvp");
            }
            if let Some(v) = arg(&args, "--pve") {
                o.pve_games = v.parse().expect("--pve");
            }
            // 2026-11-25: purpose styles and purpose deployment.
            if args.iter().any(|x| x == "--purpose") {
                o.purpose_styles = true;
                o.purpose_deploy = true;
            }
            let out = arg(&args, "--out")
                .map(PathBuf::from)
                .unwrap_or_else(|| repo_root().join("near/sim/weights/eval.json"));
            // --from PATH: warm start from saved weights (else the seed weights).
            let from = arg(&args, "--from").map(PathBuf::from);
            let start = match &from {
                Some(p) => Eval::load_mapped(p).unwrap_or_else(|e| panic!("{}: {e}", p.display())),
                None => Eval::default(),
            };
            let t = Instant::now();
            let (w, history) = vt_sim::train::train(&content, &cfg, &start.weights, &o, |g| {
                println!(
                    "gen {:>3}  best {:.3}  mean {:.3}  sigma {:.3}",
                    g.generation, g.best_fitness, g.mean_fitness, g.sigma
                );
            });
            let finish = |w: &[f32]| {
                let norm = w.iter().map(|x| x * x).sum::<f32>().sqrt();
                let mut e = Eval {
                    weights: w.iter().map(|x| x / norm).collect(),
                    ..Eval::default()
                };
                e.value_scale = vt_sim::train::fit_value_scale(
                    &content,
                    &cfg,
                    &e,
                    o.value_fit_scenarios,
                    o.seed,
                );
                e
            };
            // Excellent-in-the-loop selection (added 2026-11-17): training
            // plays the cheap greedy policy, but the weights also drive
            // Excellent's search. Candidates (the means a third and two
            // thirds of the way through, the final mean, and the starting
            // weights) are each played as Excellent on the campaign and as
            // Average in PvP against the starting weights; the best
            // combined score is kept.
            let mut cands: Vec<(String, Vec<f32>)> = Vec::new();
            let g = history.len();
            for (name, i) in [("gen_1/3", g / 3), ("gen_2/3", 2 * g / 3)] {
                if i > 0 && i < g {
                    cands.push((name.into(), history[i - 1].mean.clone()));
                }
            }
            cands.push(("final".into(), w.clone()));
            if from.is_some() {
                cands.push(("start".into(), start.weights.clone()));
            }
            let skip_select = args.iter().any(|a| a == "--no-select");
            let tc = vt_sim::tactics::TacticsConfig::load(&repo_root().join("near/sim/tactics.json"))
                .unwrap_or_default();
            let start_eval = if from.is_some() { start.clone() } else { finish(&start.weights) };
            let greedy = |e: &Eval| vt_sim::tactics::GreedyTactician {
                label: "x".into(),
                eval: e.clone(),
                temperature: 0.0,
                epsilon: 0.0,
            };
            let mut selection = Vec::new();
            let mut eval = finish(&w);
            if !skip_select {
                let mut best = (f64::NEG_INFINITY, eval.clone());
                for (name, cw) in &cands {
                    let e = if name == "start" { start_eval.clone() } else { finish(cw) };
                    let ex = tc.make(vt_sim::tactics::Level::Excellent, &e);
                    let (clear, _) = vt_sim::arena::pve_benchmark(
                        &content,
                        &cfg,
                        ex.as_ref(),
                        3,
                        o.seed + 2000,
                        Default::default(),
                    );
                    let (h, _) = vt_sim::arena::head_to_head(
                        &content,
                        &cfg,
                        &greedy(&e),
                        &greedy(&start_eval),
                        100,
                        o.seed + 3000,
                        &Default::default(),
                        Default::default(),
                    );
                    let score = 0.5 * clear + 0.5 * h.a_score;
                    println!("candidate {name}: Excellent campaign clear {clear:.3}, Average PvP vs start {:.3} ±{:.3} -> {score:.3}", h.a_score, h.ci95);
                    selection.push(serde_json::json!({"candidate": name, "excellent_clear": clear, "pvp_vs_start": h.a_score, "score": score}));
                    if score > best.0 {
                        best = (score, e);
                    }
                }
                eval = best.1;
            }
            // How much training helped: trained vs seed weights (Average policy).
            let mk = |e: &Eval| vt_sim::tactics::GreedyTactician {
                label: "x".into(),
                eval: e.clone(),
                temperature: 0.0,
                epsilon: 0.0,
            };
            let (h, _) = vt_sim::arena::head_to_head(
                &content,
                &cfg,
                &mk(&eval),
                &mk(&Eval::default()),
                200,
                o.seed + 1000,
                &Default::default(),
                Default::default(),
            );
            let (pve_new, _) = vt_sim::arena::pve_benchmark(
                &content,
                &cfg,
                &mk(&eval),
                4,
                o.seed + 1000,
                Default::default(),
            );
            let (pve_old, _) = vt_sim::arena::pve_benchmark(
                &content,
                &cfg,
                &mk(&Eval::default()),
                4,
                o.seed + 1000,
                Default::default(),
            );
            println!("trained vs seed weights: {:.3} ±{:.3}; campaign clear rate {:.3} (seed weights {:.3}); value scale {:.3}; {:.0?}", h.a_score, h.ci95, pve_new, pve_old, eval.value_scale, t.elapsed());
            eval.provenance = serde_json::json!({
                "method": "sep-CMA-ES self-play (vt-sim train)",
                "warm_start": from.as_ref().map(|p| p.display().to_string()),
                "excellent_selection": selection,
                "opts": o,
                "trained_vs_seed_weights": h,
                "campaign_clear_rate": {"trained": pve_new, "seed_weights": pve_old},
                "final_generation": history.last(),
            });
            eval.save(&out).expect("save weights");
            let log_path = out.with_file_name("train_log.json");
            std::fs::write(&log_path, serde_json::to_string_pretty(&history).unwrap())
                .expect("write log");
            println!("-> {} (+ {})", out.display(), log_path.display());
        }
        Some("calibrate") => {
            let (content, cfg) = (Content::load(), Config::load());
            let (eval, _) = load_tactics(&args);
            let mut o = vt_sim::calibrate::CalibrateOpts::default();
            if let Some(v) = arg(&args, "--scenarios") {
                o.scenarios = v.parse().expect("--scenarios");
            }
            if let Some(v) = arg(&args, "--target") {
                o.target = v.parse().expect("--target");
            }
            if let Some(v) = arg(&args, "--seed") {
                o.seed = v.parse().expect("--seed");
            }
            let out = arg(&args, "--out")
                .map(PathBuf::from)
                .unwrap_or_else(|| repo_root().join("near/sim/tactics.json"));
            let t = Instant::now();
            let (tc, cal) =
                vt_sim::calibrate::calibrate(&content, &cfg, &eval, &o, &mut |s| println!("{s}"));
            for w in &cal.warnings {
                println!("WARNING: {w}");
            }
            tc.save(&out).expect("save tactics");
            std::fs::write(
                out.with_file_name("calibration.json"),
                serde_json::to_string_pretty(&cal).unwrap(),
            )
            .expect("write");
            println!("-> {} ({:.0?})", out.display(), t.elapsed());
        }
        Some("fit-values") => {
            use vt_sim::composition::value::{fit, generate, ShipValueModel, SHIP_FEATURE_NAMES};
            let (content, cfg) = (Content::load(), Config::load());
            let (eval, _) = load_tactics(&args);
            let games: u32 = arg(&args, "--games").map_or(8000, |s| s.parse().expect("--games"));
            let seed: u64 = arg(&args, "--seed").map_or(3, |s| s.parse().expect("--seed"));
            let out = arg(&args, "--out")
                .map(PathBuf::from)
                .unwrap_or_else(|| repo_root().join("near/sim/weights/ship_value.json"));
            let t = Instant::now();
            let data = generate(&content, &cfg, &eval, games, seed);
            // Hold out 20% to check the fit predicts unseen games.
            let split = data.len() * 4 / 5;
            let (train, test) = data.split_at(split);
            let (b0, beta, train_loss) = fit(train, 1.0);
            let test_loss = {
                let m = vt_sim::composition::value::Example {
                    diff: [0.0; vt_sim::composition::value::N_SHIP_FEATURES],
                    y: 0.5,
                };
                let _ = m;
                let mut l = 0.0;
                let mut correct = 0.0;
                for e in test {
                    let z = b0 + e.diff.iter().zip(&beta).map(|(a, b)| a * b).sum::<f64>();
                    let p = (1.0 / (1.0 + (-z).exp())).clamp(1e-9, 1.0 - 1e-9);
                    l -= e.y * p.ln() + (1.0 - e.y) * (1.0 - p).ln();
                    if e.y != 0.5 && (p > 0.5) == (e.y > 0.5) {
                        correct += 1.0;
                    }
                }
                let decided = test.iter().filter(|e| e.y != 0.5).count() as f64;
                (l / test.len() as f64, correct / decided)
            };
            let (b0, beta, _) = fit(&data, 1.0);
            for (n, b) in SHIP_FEATURE_NAMES.iter().zip(&beta) {
                println!("{n:>12} {b:+.3}");
            }
            println!("intercept {b0:+.3}; train log-loss {train_loss:.3}; held-out log-loss {:.3}, accuracy {:.3} (coin flip: 0.693, 0.5); {:.0?}", test_loss.0, test_loss.1, t.elapsed());
            let m = ShipValueModel {
                beta,
                intercept: b0,
                provenance: serde_json::json!({"method": "Bradley-Terry logistic fit on Average-vs-Average PvP (vt-sim fit-values)", "games": games, "seed": seed, "heldout_logloss": test_loss.0, "heldout_accuracy": test_loss.1}),
                ..ShipValueModel::default()
            };
            m.save(&out).expect("save");
            println!("-> {}", out.display());
        }
        Some("compose-bench") => {
            use vt_sim::composition::{compose::SearchParams, value::ShipValueModel};
            let (content, cfg) = (Content::load(), Config::load());
            let (eval, tc) = load_tactics(&args);
            let values =
                ShipValueModel::load(&repo_root().join("near/sim/weights/ship_value.json"))
                    .unwrap_or_else(|_| {
                        eprintln!(
                    "note: ship_value.json not found; run fit-values (using the unfitted default)"
                );
                        ShipValueModel::default()
                    });
            let scenarios: u32 =
                arg(&args, "--scenarios").map_or(60, |s| s.parse().expect("--scenarios"));
            let fac: u32 =
                arg(&args, "--factorial").map_or(30, |s| s.parse().expect("--factorial"));
            let seed: u64 = arg(&args, "--seed").map_or(5, |s| s.parse().expect("--seed"));
            let t = Instant::now();
            let r = vt_sim::composition::bench::run(
                &content,
                &cfg,
                &eval,
                &tc,
                &values,
                &SearchParams::default(),
                scenarios,
                fac,
                seed,
                &mut |s| println!("{s}"),
            );
            let out = arg(&args, "--out")
                .map(PathBuf::from)
                .unwrap_or_else(|| repo_root().join("near/sim/composition_bench.json"));
            std::fs::write(&out, serde_json::to_string_pretty(&r).unwrap()).expect("write");
            println!("-> {} ({:.0?})", out.display(), t.elapsed());
        }
        Some("economy") => {
            use vt_sim::composition::{compose::SearchParams, value::ShipValueModel};
            use vt_sim::economy::{run_to_dir, summarize, Profiles, SimOpts, Start, World};
            let (content, cfg) = (Content::load(), Config::load());
            let (eval, tc) = load_tactics(&args);
            let values =
                ShipValueModel::load(&repo_root().join("near/sim/weights/ship_value.json"))
                    .expect("run fit-values first");
            let pp = arg(&args, "--profiles")
                .map(PathBuf::from)
                .unwrap_or_else(|| repo_root().join("near/sim/profiles.json"));
            let profiles = Profiles::load(&pp).expect("profiles");
            let mut o = SimOpts::default();
            if let Some(v) = arg(&args, "--days") {
                o.days = v.parse().expect("--days");
            }
            if let Some(v) = arg(&args, "--players") {
                o.players_per_archetype = v.parse().expect("--players");
            }
            if let Some(v) = arg(&args, "--seed") {
                o.seed = v.parse().expect("--seed");
            }
            let out = arg(&args, "--out")
                .map(PathBuf::from)
                .unwrap_or_else(|| repo_root().join("near/sim/out/economy"));
            let has = |f: &str| args.iter().any(|a| a == f);
            let start = if has("--resume") {
                Start::Resume
            } else if has("--fresh") || !out.join("checkpoint.json").exists() {
                Start::Fresh
            } else {
                eprintln!(
                    "{} has a checkpoint: pass --resume to continue it or --fresh to start over",
                    out.display()
                );
                std::process::exit(2);
            };
            let sp = SearchParams::default();
            let fingerprint = input_fingerprint(&args, &pp, &serde_json::to_string(&sp).unwrap());
            let world = World::new(&content, &cfg, &profiles, &values, &eval, &tc, &sp);
            let t = Instant::now();
            let st = run_to_dir(&world, &o, &out, start, &fingerprint, |day, _| {
                eprintln!(
                    "day {} done ({:.0?}); results so far in {}",
                    day + 1,
                    t.elapsed(),
                    out.display()
                );
            })
            .unwrap_or_else(|e| {
                eprintln!("{e}");
                std::process::exit(1);
            });
            let summary = summarize(&world, &st.players, o.days - 1);
            std::fs::write(
                out.join("summary.json"),
                serde_json::to_string_pretty(
                    &serde_json::json!({"opts": o, "profiles": profiles, "archetypes": summary}),
                )
                .unwrap(),
            )
            .expect("write");
            println!(
                "{:<8} {:<9} {:>7} {:>6} {:>6} {:>5} {:>6} {:>6} {:>6} {:>6} {:>6} {:>7} {:>6}",
                "spend",
                "skill",
                "usd",
                "ships",
                "power",
                "tier",
                "nodes",
                "medal",
                "camp%",
                "rl/run",
                "pvp%",
                "elo",
                "lost"
            );
            for a in &summary {
                let f = |k: &str| a[k].as_f64().unwrap_or(f64::NAN);
                println!("{:<8} {:<9} {:>7.0} {:>6.0} {:>6.2} {:>5.1} {:>6.1} {:>6.2} {:>6.2} {:>6.2} {:>6.2} {:>7.0} {:>6.1}",
                    a["spend"].as_str().unwrap(), a["skill"].as_str().unwrap(), f("usd_spent"), f("ships"), f("fleet_power_1000"), f("storefront_tier"),
                    f("nodes_completed"), f("medal_share"), f("campaign_win_rate"), f("run_combats_won"), f("pvp_score"), f("elo"), f("ships_lost"));
            }
            println!("-> {} ({:.0?})", out.display(), t.elapsed());
        }
        Some("run") => {
            use vt_sim::experiment::{run_experiment, ExperimentConfig};
            let path = args
                .get(1)
                .map(PathBuf::from)
                .unwrap_or_else(|| repo_root().join("near/sim/experiments/default.json"));
            let exp =
                ExperimentConfig::load(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
            let out = arg(&args, "--out")
                .map(PathBuf::from)
                .unwrap_or_else(|| repo_root().join("near/sim/out").join(&exp.name));
            let fresh = args.iter().any(|a| a == "--fresh");
            let weights = arg(&args, "--weights").map(PathBuf::from);
            let tactics = arg(&args, "--tactics").map(PathBuf::from);
            let t = Instant::now();
            let mut last = Instant::now();
            run_experiment(
                &exp,
                &out,
                fresh,
                weights.as_deref(),
                tactics.as_deref(),
                &mut |s| {
                    // Progress at most every 30 s (stage boundaries always).
                    if s.starts_with("==") || last.elapsed().as_secs() >= 30 {
                        eprintln!("[{:>6.0?}] {s}", t.elapsed());
                        last = Instant::now();
                    }
                },
            )
            .unwrap_or_else(|e| {
                eprintln!("{e}");
                std::process::exit(1);
            });
            println!(
                "-> {} ({:.0?})",
                out.join("report.md").display(),
                t.elapsed()
            );
        }
        Some("report") => {
            use vt_sim::experiment::{report, Manifest};
            let dir = args
                .get(1)
                .map(PathBuf::from)
                .expect("vt-sim report <run dir>");
            let m: Manifest = serde_json::from_str(
                &std::fs::read_to_string(dir.join("manifest.json")).expect("manifest.json"),
            )
            .expect("manifest");
            report::render(&dir, &m.config).expect("render");
            println!("-> {}", dir.join("report.md").display());
        }
        Some("bench") => {
            let (content, cfg) = (Content::load(), Config::load());
            let (eval, tc) = load_tactics(&args);
            let scenarios: u32 =
                arg(&args, "--scenarios").map_or(50, |s| s.parse().expect("--scenarios"));
            let fleets: u32 = arg(&args, "--fleets").map_or(4, |s| s.parse().expect("--fleets"));
            let seed: u64 = arg(&args, "--seed").map_or(1, |s| s.parse().expect("--seed"));
            let levels = levels(&args);
            let r =
                vt_sim::bench::run(&content, &cfg, &eval, &tc, scenarios, fleets, seed, &levels);
            if let Some(out) = arg(&args, "--out") {
                std::fs::write(&out, serde_json::to_string_pretty(&r).unwrap()).expect("write");
            }
        }
        Some("human-bench") => {
            // vt-sim human-bench [file] [--seeds 20] [--aversion 0.05] [--out DIR]
            use vt_sim::composition::compose::{make as make_composer, SearchParams};
            use vt_sim::composition::value::ShipValueModel;
            let path = args
                .get(1)
                .filter(|a| !a.starts_with("--"))
                .map(PathBuf::from)
                .unwrap_or_else(|| repo_root().join("near/sim/human/bench.json"));
            let file: vt_sim::human_bench::BenchFile = serde_json::from_str(
                &std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display())),
            )
            .unwrap_or_else(|e| panic!("{}: {e}", path.display()));
            let seeds: u32 = arg(&args, "--seeds").map_or(20, |s| s.parse().expect("--seeds"));
            let aversion: f32 =
                arg(&args, "--aversion").map_or(0.05, |s| s.parse().expect("--aversion"));
            let out = arg(&args, "--out")
                .map(PathBuf::from)
                .unwrap_or_else(|| repo_root().join("near/sim/out/human-bench"));
            let (content, cfg) = (Content::load(), Config::load());
            let (eval, tc) = load_tactics(&args);
            let values = ShipValueModel::load(&repo_root().join("near/sim/weights/ship_value.json"))
                .expect("ship_value.json (run fit-values)");
            let composer = make_composer(
                vt_sim::tactics::Level::Excellent,
                &values,
                &eval,
                &SearchParams::default(),
            );
            let t = Instant::now();
            let (res, logs) = vt_sim::human_bench::run(
                &content,
                &cfg,
                composer.as_ref(),
                &tc,
                &eval,
                &file,
                seeds,
                aversion,
            )
            .unwrap_or_else(|e| {
                eprintln!("{e}");
                std::process::exit(1);
            });
            println!("| Node | Fleet cost / cap | You | Your ships destroyed / retreated | Excellent clear rate | Excellent destroyed / retreated per game |");
            println!("|---|---|---|---|---|---|");
            for r in &res {
                println!(
                    "| {} | {} / {} | {} | {} / {} | {:.0}% ({} games) | {:.2} / {:.2} |",
                    r.node,
                    r.fleet_cost,
                    r.cost_cap,
                    r.human_result,
                    r.human_destroyed,
                    r.human_retreated,
                    r.sim_clear_rate * 100.0,
                    r.games,
                    r.sim_destroyed_per_game,
                    r.sim_retreated_per_game
                );
            }
            std::fs::create_dir_all(&out).expect("out dir");
            std::fs::write(out.join("results.json"), serde_json::to_string_pretty(&res).unwrap())
                .expect("write");
            let lines: Vec<String> = logs.iter().map(|l| serde_json::to_string(l).unwrap()).collect();
            std::fs::write(out.join("matches.jsonl"), lines.join("\n") + "\n").expect("write");
            println!("-> {} ({:.0?}); replay a game with: vt-sim replay {} --node <key> [--losses] (games need --log-moves)", out.display(), t.elapsed(), out.join("matches.jsonl").display());
        }
        Some("play") => {
            // vt-sim play [--level poor|average|excellent] [--side creator|joiner] [--seed N] [--cap 1000|2000] [--weights P]
            if args.iter().any(|a| a == "--help") {
                println!("vt-sim play [--level poor|average|excellent (default excellent)] [--side creator|joiner (default creator)] [--seed N] [--cap 1000|2000] [--weights PATH]\n\n{}", vt_sim::play::HELP);
                return;
            }
            let (eval, tc) = load_tactics(&args);
            let level = match arg(&args, "--level").as_deref() {
                Some("poor") => Level::Poor,
                Some("average") => Level::Average,
                _ => Level::Excellent,
            };
            let seed = arg(&args, "--seed").map_or_else(
                || std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() % 1_000_000,
                |s| s.parse().expect("--seed"),
            );
            let o = vt_sim::play::PlayOpts {
                level,
                human_creator: arg(&args, "--side").as_deref() != Some("joiner"),
                seed,
                cap: arg(&args, "--cap").map(|s| s.parse().expect("--cap")),
            };
            vt_sim::play::run(&Content::load(), &Config::load(), &eval, &tc, &o).unwrap();
        }
        Some("replay") => {
            // vt-sim replay <matches.jsonl> (--game N | --node KEY [--losses]) [--every-move]
            use vt_sim::replay::{find, render, Pick};
            let path = args.get(1).expect("vt-sim replay <matches.jsonl> --game N | --node KEY [--losses] [--every-move]");
            let text = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("{path}: {e}"));
            let lines: Vec<String> = text.lines().map(str::to_string).collect();
            let pick = match (arg(&args, "--game"), arg(&args, "--node")) {
                (Some(n), _) => Pick::Index(n.parse().expect("--game")),
                (None, Some(k)) => Pick::Node {
                    key: k,
                    losses_only: args.iter().any(|a| a == "--losses"),
                },
                _ => Pick::Index(0),
            };
            let Some(m) = find(&lines, &pick) else {
                eprintln!("no matching game (logged games need --log-moves)");
                std::process::exit(1);
            };
            let content = Content::load();
            print!("{}", render(&m, &content.maps, args.iter().any(|a| a == "--every-move")));
        }
        _ => {
            eprintln!("usage: vt-sim play|smoke|train|calibrate|fit-values|compose-bench|economy|run|report|bench|replay|human-bench [options] [--log-moves] (see docs/balance-simulator.md)");
            std::process::exit(2);
        }
    }
}

/// Evaluation weights and tactics config: --weights / --tactics, else the
/// committed near/sim/{weights/eval.json,tactics.json}, else defaults.
fn load_tactics(args: &[String]) -> (Eval, TacticsConfig) {
    let wp = arg(args, "--weights")
        .map(PathBuf::from)
        .unwrap_or_else(|| repo_root().join("near/sim/weights/eval.json"));
    let tp = arg(args, "--tactics")
        .map(PathBuf::from)
        .unwrap_or_else(|| repo_root().join("near/sim/tactics.json"));
    let eval = Eval::load_mapped(&wp).unwrap_or_else(|_| {
        eprintln!(
            "note: {} not found; using untrained seed weights",
            wp.display()
        );
        Eval::default()
    });
    let tc = TacticsConfig::load(&tp).unwrap_or_else(|_| {
        eprintln!(
            "note: {} not found; using default tactics knobs",
            tp.display()
        );
        TacticsConfig::default()
    });
    (eval, tc)
}

/// --levels poor,average,excellent (default: all).
fn levels(args: &[String]) -> Vec<Level> {
    arg(args, "--levels").map_or(Level::ALL.to_vec(), |s| {
        s.split(',')
            .map(|x| match x {
                "poor" => Level::Poor,
                "average" => Level::Average,
                "excellent" => Level::Excellent,
                other => panic!("unknown level {other}"),
            })
            .collect()
    })
}

/// A stable fingerprint (FNV-1a 64) of every input a run depends on: the
/// weights, tactics, ship values, profiles, rules and content files, and the
/// search settings. Resuming a checkpoint requires the same fingerprint.
fn input_fingerprint(args: &[String], profiles: &std::path::Path, extra: &str) -> String {
    let root = repo_root();
    let mut files = vec![
        arg(args, "--weights")
            .map(PathBuf::from)
            .unwrap_or_else(|| root.join("near/sim/weights/eval.json")),
        arg(args, "--tactics")
            .map(PathBuf::from)
            .unwrap_or_else(|| root.join("near/sim/tactics.json")),
        root.join("near/sim/weights/ship_value.json"),
        profiles.to_path_buf(),
        root.join("near/seed/config.json"),
    ];
    for f in [
        "singlePlayerStarterContent",
        "roguelikeStarterContent",
        "pvpStarterContent",
    ] {
        files.push(root.join(format!("ignition/data/{f}.json")));
    }
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    let mut eat = |bytes: &[u8]| {
        for &b in bytes {
            h ^= b as u64;
            h = h.wrapping_mul(0x0100_0000_01b3);
        }
    };
    for f in &files {
        eat(&std::fs::read(f).unwrap_or_default());
        eat(&[0xff]);
    }
    eat(extra.as_bytes());
    format!("{h:016x}")
}

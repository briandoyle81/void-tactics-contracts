//! Phase 5 checks: the experiment pipeline runs every stage and renders the
//! report; a run interrupted mid-stage (a half-written units file) resumes
//! to byte-identical results; changed configs are refused without --fresh.

use std::io::Write;

use vt_sim::experiment::{run_experiment, ExperimentConfig};
use vt_sim::rules::repo_root;

fn smoke() -> ExperimentConfig {
    ExperimentConfig::load(&repo_root().join("near/sim/experiments/smoke.json")).unwrap()
}

fn tmp(name: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!(
        "vt-sim-{name}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ))
}

#[test]
fn smoke_experiment_runs_and_resumes_identically() {
    let exp = smoke();
    let dir = tmp("exp");
    run_experiment(&exp, &dir, false, None, None, &mut |_| {}).unwrap();
    let report = std::fs::read_to_string(dir.join("report.md")).unwrap();
    for section in [
        "## Flags",
        "## PvP between archetypes",
        "## Composition vs tactics",
        "## Mission difficulty (single fights)",
        "### AI ship configs",
        "## Roguelike",
        "## Ship parts and prices",
        "## Economy and progression",
    ] {
        assert!(report.contains(section), "report lacks {section}");
    }
    assert!(!report.contains("_Pending"), "a stage didn't finish");
    assert!(
        report.contains("Smoke run"),
        "smoke runs must say they aren't results"
    );
    let pve = std::fs::read_to_string(dir.join("pve.json")).unwrap();

    // Interrupt the pve stage: keep half its units plus a half-written line,
    // and lose its aggregate.
    let units_path = dir.join("pve.units.jsonl");
    let text = std::fs::read_to_string(&units_path).unwrap();
    let lines: Vec<&str> = text.lines().collect();
    let keep: String = lines[..lines.len() / 2]
        .iter()
        .map(|l| format!("{l}\n"))
        .collect();
    std::fs::write(&units_path, keep + &lines[lines.len() / 2][..20]).unwrap();
    std::fs::File::create(dir.join("pve.json"))
        .unwrap()
        .flush()
        .unwrap();

    run_experiment(&exp, &dir, false, None, None, &mut |_| {}).unwrap();
    assert_eq!(
        std::fs::read_to_string(dir.join("pve.json")).unwrap(),
        pve,
        "resumed pve aggregate differs"
    );
    assert_eq!(
        std::fs::read_to_string(dir.join("report.md")).unwrap(),
        report,
        "resumed report differs"
    );
    assert_eq!(
        std::fs::read_to_string(&units_path)
            .unwrap()
            .lines()
            .count(),
        lines.len(),
        "units recomputed or duplicated"
    );

    // A different config in the same directory is refused unless fresh.
    let other = ExperimentConfig {
        seed: exp.seed + 1,
        ..exp.clone()
    };
    assert!(
        run_experiment(&other, &dir, false, None, None, &mut |_| {}).is_err(),
        "mixed configs must be refused"
    );
}

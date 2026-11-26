//! Phase 4 checks: the economy follows the contract's rules (claims,
//! storefront, packs with rank presets, medal gate, spend), and runs are
//! reproducible with sound inventories.

use std::collections::BTreeSet;

use vt_core::attributes::kills_for_rank;
use vt_sim::composition::compose::SearchParams;
use vt_sim::composition::value::ShipValueModel;
use vt_sim::content::Content;
use vt_sim::economy::{simulate, Profiles, SimOpts, World};
use vt_sim::eval::Eval;
use vt_sim::rules::{repo_root, Config};
use vt_sim::tactics::{MctsParams, TacticsConfig};

fn load() -> (
    Content,
    Config,
    Profiles,
    ShipValueModel,
    Eval,
    TacticsConfig,
) {
    let mut tc = TacticsConfig::load(&repo_root().join("near/sim/tactics.json")).unwrap();
    // Cheap Excellent for test speed (the rules under test don't depend on it).
    tc.excellent = MctsParams {
        simulations: 8,
        rollout_plies: 0,
        ..MctsParams::default()
    };
    (
        Content::load(),
        Config::load(),
        Profiles::load(&repo_root().join("near/sim/profiles.json")).unwrap(),
        ShipValueModel::load(&repo_root().join("near/sim/weights/ship_value.json")).unwrap(),
        Eval::load(&repo_root().join("near/sim/weights/eval.json")).unwrap(),
        tc,
    )
}

fn tiny_search() -> SearchParams {
    SearchParams {
        parents: 2,
        offspring: 2,
        generations: 1,
        opponents: 1,
        validation_opponents: 1,
    }
}

/// No play: only claims and spending. Every count follows the rules exactly.
#[test]
fn spending_and_claims_follow_the_contract() {
    let (content, cfg, mut profiles, values, eval, tc) = load();
    for p in profiles.spend.values_mut() {
        p.sessions_per_week = 0.0;
        p.modify_share = 0.0;
    }
    let w = World::new(
        &content,
        &cfg,
        &profiles,
        &values,
        &eval,
        &tc,
        &tiny_search(),
    );
    let days = 60;
    let out = simulate(
        &w,
        &SimOpts {
            days,
            players_per_archetype: 1,
            seed: 4,
            snapshot_every: 30,
        },
        |_, _| {},
    );
    let e = &profiles.economy;
    let claims = days.div_ceil(e.claim_cooldown_days); // days 0, 28, 56
    for p in &out.players {
        let prof = &profiles.spend[&p.spend];
        assert_eq!(
            p.stats.ships_claimed,
            claims * e.free_claim_base,
            "{}: tier 0 claims",
            p.label
        );
        assert!(
            (p.usd_spent - prof.usd_per_month / 30.0 * days as f64).abs() < 1e-6,
            "{}: spend",
            p.label
        );
        let packs = match prof.pack_tier {
            Some(t) => (p.usd_spent / e.pack_usd[t]).floor() as u32 * e.pack_ships[t],
            None => 0,
        };
        assert_eq!(p.stats.ships_bought, packs, "{}: packs bought", p.label);
        assert_eq!(
            p.ships.len() as u32,
            p.stats.ships_claimed + p.stats.ships_topped_up + p.stats.ships_bought - p.stats.ships_recycled,
            "{}: inventory",
            p.label
        );
        // Medal gate: nobody has won f06, so everything is variant 1.
        assert!(
            p.ships.iter().all(|s| s.traits.variant == 1),
            "{}: variant 2 before the medal",
            p.label
        );
        // Paid packs preset the first tier+1 ships' ranks.
        if let Some(t) = prof.pack_tier {
            // (Skipped where live ships were recycled: that reorders the hangar.)
            if p.stats.ships_bought > 0 && p.stats.ships_recycled == 0 {
                let ranked: Vec<u32> = p
                    .ships
                    .iter()
                    .filter(|s| !s.ship_data.is_free_ship)
                    .take(t + 1)
                    .map(|s| s.ship_data.ships_destroyed)
                    .collect();
                let want: Vec<u32> = (1..=t as u32 + 1)
                    .rev()
                    .map(|r| kills_for_rank(r as u8))
                    .collect();
                assert_eq!(ranked, want, "{}: rank presets of the first pack", p.label);
            }
        }
        assert!(p
            .ships
            .iter()
            .all(|s| s.ship_data.constructed && s.ship_data.cost == cfg.cost(s).unwrap()));
    }
}

/// With play: reproducible, unique ids, no inventory below zero, DEC turned
/// in only at the storefront's prices.
#[test]
fn short_runs_are_reproducible_and_sound() {
    let (content, cfg, profiles, values, eval, tc) = load();
    let w = World::new(
        &content,
        &cfg,
        &profiles,
        &values,
        &eval,
        &tc,
        &tiny_search(),
    );
    let o = SimOpts {
        days: 3,
        players_per_archetype: 1,
        seed: 9,
        snapshot_every: 1,
    };
    let a = simulate(&w, &o, |_, _| {});
    let b = simulate(&w, &o, |_, _| {});
    assert_eq!(
        a.match_lines, b.match_lines,
        "matches differ between identical runs"
    );
    assert_eq!(a.snapshot_lines, b.snapshot_lines);
    assert!(!a.match_lines.is_empty(), "nobody played");
    let mut ids = BTreeSet::new();
    for p in &a.players {
        for s in &p.ships {
            assert!(ids.insert(s.id), "ship id {} owned twice", s.id);
            assert!(s.id < vt_sim::content::AI_SHIP_ID_OFFSET);
        }
        assert!(p.utc >= -1e-9, "{}: negative UTC", p.label);
        let spent: u64 = cfg
            .storefront_tiers
            .iter()
            .take(p.storefront_tier as usize)
            .map(|&t| t as u64)
            .sum();
        assert_eq!(
            p.stats.dec_earned,
            spent + p.dec,
            "{}: DEC earned = turned in + held",
            p.label
        );
        assert_eq!(
            p.ships.len() as u32,
            p.stats.ships_claimed + p.stats.ships_topped_up + p.stats.ships_bought + p.stats.ships_granted
                - p.stats.ships_lost
                - p.stats.ships_recycled,
            "{}: inventory accounting",
            p.label
        );
    }
}

/// Streaming runs: a run stopped part-way (with a half-written day after its
/// last checkpoint) and resumed produces exactly the files of an
/// uninterrupted run; resuming with other inputs or options is refused.
#[test]
fn resumed_runs_match_uninterrupted_runs() {
    use std::io::Write;
    use vt_sim::economy::{run_to_dir, Start};
    let (content, cfg, profiles, values, eval, tc) = load();
    let w = World::new(
        &content,
        &cfg,
        &profiles,
        &values,
        &eval,
        &tc,
        &tiny_search(),
    );
    let base = std::env::temp_dir().join(format!(
        "vt-sim-resume-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let (a, b) = (base.join("straight"), base.join("resumed"));
    let o4 = SimOpts {
        days: 4,
        players_per_archetype: 1,
        seed: 13,
        snapshot_every: 2,
    };
    let o2 = SimOpts {
        days: 2,
        ..o4.clone()
    };

    run_to_dir(&w, &o4, &a, Start::Fresh, "fp", |_, _| {}).unwrap();
    run_to_dir(&w, &o2, &b, Start::Fresh, "fp", |_, _| {}).unwrap();
    // A day in progress when the run was stopped: written, not checkpointed.
    std::fs::OpenOptions::new()
        .append(true)
        .open(b.join("matches.jsonl"))
        .unwrap()
        .write_all(b"{\"partial\": true\n")
        .unwrap();
    assert!(
        run_to_dir(&w, &o4, &b, Start::Resume, "other inputs", |_, _| {}).is_err(),
        "resume with different inputs must be refused"
    );
    assert!(
        run_to_dir(
            &w,
            &SimOpts {
                seed: 14,
                ..o4.clone()
            },
            &b,
            Start::Resume,
            "fp",
            |_, _| {}
        )
        .is_err(),
        "resume with a different seed must be refused"
    );
    run_to_dir(&w, &o4, &b, Start::Resume, "fp", |_, _| {}).unwrap();

    let mem = simulate(&w, &o4, |_, _| {});
    for (f, lines) in [
        ("matches.jsonl", &mem.match_lines),
        ("runs.jsonl", &mem.run_lines),
        ("players.jsonl", &mem.snapshot_lines),
    ] {
        let sa = std::fs::read_to_string(a.join(f)).unwrap();
        let sb = std::fs::read_to_string(b.join(f)).unwrap();
        assert_eq!(
            sa, sb,
            "{f}: resumed run differs from the uninterrupted one"
        );
        let joined: String = lines.iter().map(|l| format!("{l}\n")).collect();
        assert_eq!(
            sa, joined,
            "{f}: streamed output differs from the in-memory run"
        );
    }
    assert!(
        std::fs::read_to_string(a.join("matches.jsonl"))
            .unwrap()
            .lines()
            .count()
            > 0
    );
}

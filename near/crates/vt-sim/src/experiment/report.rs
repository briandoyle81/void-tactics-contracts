//! Renders `DIR/report.md` from the stage aggregates present in DIR. Stages
//! not yet finished are listed as pending, so the report can be read at any
//! point in a long run.

use std::fmt::Write as _;
use std::path::Path;

use serde_json::Value;

use super::{stage_path, ExperimentConfig};

fn load(dir: &Path, stage: &str) -> Option<Value> {
    let t = std::fs::read_to_string(stage_path(dir, stage)).ok()?;
    serde_json::from_str(&t).ok()
}

fn f(v: &Value) -> f64 {
    v.as_f64().unwrap_or(f64::NAN)
}

fn pct(v: f64) -> String {
    if v.is_nan() {
        "–".into()
    } else {
        format!("{:.0}%", v * 100.0)
    }
}

fn sc(v: &Value) -> String {
    if v.is_null() || v["score"].is_null() {
        return "–".into();
    }
    format!(
        "{:.2} ±{:.2} (n={})",
        f(&v["score"]),
        f(&v["ci95"]),
        v["games"]
    )
}

pub fn render(dir: &Path, exp: &ExperimentConfig) -> std::io::Result<()> {
    let mut md = String::new();
    let mut flags: Vec<String> = Vec::new();
    let mut body = String::new();
    let fl = &exp.flags;
    let w = |s: &mut String, t: String| s.push_str(&t);

    // ------------------------------------------------------------ matrix
    w(&mut body, "## PvP between archetypes\n\n".into());
    if let Some(m) = load(dir, "matrix") {
        let names: Vec<String> = m["archetypes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| x.as_str().unwrap().to_string())
            .collect();
        w(&mut body, format!(
            "Each archetype's own hangar after the economy stage. Every pair plays {} paired scenarios (2 games, sides swapped) in random brackets. Each cell is the row archetype's score against the column archetype (win 1, draw 0.5).\n\n",
            m["scenarios_per_pair"]
        ));
        w(
            &mut body,
            format!(
                "| | {} |\n|---|{}\n",
                names.join(" | "),
                "---|".repeat(names.len())
            ),
        );
        let per_cell = 2 * m["scenarios_per_pair"].as_u64().unwrap_or(0);
        for (i, n) in names.iter().enumerate() {
            let cells: Vec<String> = (0..names.len())
                .map(|j| pct(f(&m["score"][i][j]["score"])))
                .collect();
            w(&mut body, format!("| **{n}** | {} |\n", cells.join(" | ")));
            for j in i..names.len() {
                let played = m["score"][i][j]["games"].as_u64().unwrap_or(0);
                if per_cell > 0 && (played as f64) < fl.matrix_min_played * per_cell as f64 {
                    flags.push(format!(
                        "**Unplayable PvP:** {n} vs {} played only {played} of {per_cell} games (a side had no fleet that fit).",
                        names[j]
                    ));
                }
            }
        }
        w(&mut body, "\n**Elo** (Bradley–Terry over all matrix games, mean 1500):\n\n| Archetype | Elo |\n|---|---|\n".into());
        let mut order: Vec<usize> = (0..names.len()).collect();
        order.sort_by(|&a, &b| f(&m["elo"][b]).partial_cmp(&f(&m["elo"][a])).unwrap());
        for i in order {
            w(
                &mut body,
                format!("| {} | {:.0} |\n", names[i], f(&m["elo"][i])),
            );
        }
        w(&mut body, "\n**Pay-to-win index:** score of the higher spender at equal skill.\n\n| Skill | Whale vs FTP | Casual vs FTP | Whale vs Casual |\n|---|---|---|---|\n".into());
        for r in m["pay_to_win"].as_array().unwrap() {
            w(
                &mut body,
                format!(
                    "| {} | {} | {} | {} |\n",
                    r["skill"].as_str().unwrap(),
                    sc(&r["whale_vs_ftp"]),
                    sc(&r["casual_vs_ftp"]),
                    sc(&r["whale_vs_casual"])
                ),
            );
            for (key, hi, lo) in [
                ("whale_vs_ftp", "whales", "FTP players"),
                ("casual_vs_ftp", "casual players", "FTP players"),
                ("whale_vs_casual", "whales", "casual players"),
            ] {
                let x = f(&r[key]["score"]);
                if x > fl.pay_to_win_max {
                    flags.push(format!(
                        "**Pay-to-win:** at {} skill, {hi} beat {lo} {} (threshold {}).",
                        r["skill"].as_str().unwrap(),
                        pct(x),
                        pct(fl.pay_to_win_max)
                    ));
                }
            }
        }
        w(&mut body, "\n**Skill index:** score of the more skilled player at equal spend.\n\n| Spend | Excellent vs Poor | Average vs Poor | Excellent vs Average |\n|---|---|---|---|\n".into());
        for r in m["skill"].as_array().unwrap() {
            w(
                &mut body,
                format!(
                    "| {} | {} | {} | {} |\n",
                    r["spend"].as_str().unwrap(),
                    sc(&r["excellent_vs_poor"]),
                    sc(&r["average_vs_poor"]),
                    sc(&r["excellent_vs_average"])
                ),
            );
            let x = f(&r["excellent_vs_poor"]["score"]);
            if x < fl.skill_min {
                flags.push(format!("**Skill matters too little:** among {} players, Excellent beats Poor only {} (threshold {}).", r["spend"].as_str().unwrap(), pct(x), pct(fl.skill_min)));
            }
        }
        if m["peak_hangar_games"].as_u64().unwrap_or(0) > 0 {
            w(
                &mut body,
                format!(
                    "\n{} games were played with peak hangars (the strongest hangar a player had at the start of any day's play) because a final hangar couldn't field a fleet.\n",
                    m["peak_hangar_games"]
                ),
            );
        }
        if m["unplayed_games"].as_u64().unwrap_or(0) > 0 {
            w(
                &mut body,
                format!(
                    "\n{} games couldn't be played: a side had no fleet that fit the bracket.\n",
                    m["unplayed_games"]
                ),
            );
        }
    } else {
        w(&mut body, "_Pending (needs the economy stage)._\n".into());
    }

    // ---------------------------------------------------------- factorial
    w(&mut body, "\n## Composition vs tactics\n\n".into());
    if let Some(fa) = load(dir, "factorial") {
        w(&mut body, format!(
            "Each cell (composition level × tactics level) plays {} shared-pool PvP scenarios against an Average/Average player. The variants change how far apart the tactics levels are. The calibrated variant puts about 75% between adjacent levels; the others narrow or widen that gap. So the split below is shown together with the assumption it depends on.\n\n",
            fa["scenarios"]
        ));
        w(&mut body, "| Variant | Poor noise | Excellent look-ahead | Measured: Average beats Poor tactics | Measured: Excellent beats Average tactics | Composition share | Tactics share | Interaction | Composition range | Tactics range |\n|---|---|---|---|---|---|---|---|---|---|\n".into());
        for v in fa["variants"].as_array().unwrap() {
            // Gaps read off the cells with Average composition.
            let avg_vs_poor = 1.0 - f(&v["score"][1][0]);
            let ex_vs_avg = f(&v["score"][1][2]);
            w(
                &mut body,
                format!(
                    "| {} | {:.3} | {} | {} | {} | {} | {} | {} | {:+.2} | {:+.2} |\n",
                    v["variant"].as_str().unwrap(),
                    f(&v["poor_noise"]),
                    v["excellent_plies"],
                    pct(avg_vs_poor),
                    pct(ex_vs_avg),
                    pct(f(&v["share_composition"])),
                    pct(f(&v["share_tactics"])),
                    pct(f(&v["share_interaction"])),
                    f(&v["composition_range"]),
                    f(&v["tactics_range"])
                ),
            );
        }
        for v in fa["variants"].as_array().unwrap() {
            w(&mut body, format!("\n**{}**: score vs Average/Average (rows: composition, columns: tactics).\n\n| | Poor | Average | Excellent |\n|---|---|---|---|\n", v["variant"].as_str().unwrap()));
            for (c, name) in ["Poor", "Average", "Excellent"].iter().enumerate() {
                let cells: Vec<String> = (0..3)
                    .map(|t| format!("{:.2} ±{:.2}", f(&v["score"][c][t]), f(&v["ci95"][c][t])))
                    .collect();
                w(
                    &mut body,
                    format!("| **{name}** | {} |\n", cells.join(" | ")),
                );
            }
        }
    } else {
        w(&mut body, "_Pending._\n".into());
    }

    // ---------------------------------------------------------------- pve
    w(&mut body, "\n## Mission difficulty (single fights)\n\n".into());
    if let Some(p) = load(dir, "pve") {
        w(&mut body, format!(
            "Every roguelike combat mission reachable from mission 1, played as a single fight at full HP under the cost cap a run has on arriving there, against the on-chain AI. Each cell is {} random 30-ship pools per mission; every level gets the same pools. Composition and tactics are at the same level. Missions are in node-id order, so branches sit side by side: a drop from one row to the next is only a spike when the second mission follows the first.\n\n| Mission | Cost cap | Poor | Average | Excellent | Average rounds |\n|---|---|---|---|---|---|\n",
            p["pools_per_node"]
        ));
        let mut prev: Option<f64> = None;
        for n in p["nodes"].as_array().unwrap() {
            let lv = n["levels"].as_array().unwrap();
            let avg = f(&lv[1]["clear"]);
            w(
                &mut body,
                format!(
                    "| {} | {} | {} | {} | {} | {:.1} |\n",
                    n["name"].as_str().or(n["node"].as_str()).unwrap(),
                    n["cost_limit"],
                    pct(f(&lv[0]["clear"])),
                    pct(avg),
                    pct(f(&lv[2]["clear"])),
                    f(&lv[1]["rounds"])
                ),
            );
            let key = n["name"].as_str().or(n["node"].as_str()).unwrap();
            if avg < fl.node_average_clear_min {
                flags.push(format!(
                    "**Hard mission:** Average players clear {key} {} of the time as a single fight (threshold {}).",
                    pct(avg),
                    pct(fl.node_average_clear_min)
                ));
            }
            if let Some(pv) = prev {
                if pv - avg > fl.node_spike {
                    flags.push(format!(
                        "**Difficulty spike:** Average clear rate drops from {} to {} at {key}.",
                        pct(pv),
                        pct(avg)
                    ));
                }
            }
            if f(&lv[2]["clear"]) + 0.15 < f(&lv[0]["clear"]) {
                flags.push(format!("**Skill inversion:** at {key}, Poor players clear more often than Excellent ({} vs {}).", pct(f(&lv[0]["clear"])), pct(f(&lv[2]["clear"]))));
            }
            prev = Some(avg);
        }
        w(&mut body, "\n### AI ship configs\n\nAcross all single-fight mission games: how much each AI config contributes.\n\n| Config | Appearances | Damage per game | Kills per game | Destroyed | List cost |\n|---|---|---|---|---|---|\n".into());
        let mut rows: Vec<&Value> = p["ai_configs"].as_array().unwrap().iter().collect();
        rows.sort_by(|a, b| {
            f(&b["damage_per_game"])
                .partial_cmp(&f(&a["damage_per_game"]))
                .unwrap()
        });
        for r in rows {
            let n = r["appearances"].as_u64().unwrap_or(0);
            w(
                &mut body,
                format!(
                    "| {} | {} | {:.1} | {:.2} | {} | {} |\n",
                    r["config"].as_str().unwrap(),
                    n,
                    f(&r["damage_per_game"]),
                    f(&r["kills_per_game"]),
                    pct(f(&r["destroyed_rate"])),
                    r["list_cost"]
                ),
            );
            if n >= fl.ai_config_min_appearances as u64 {
                if f(&r["damage_per_game"]) == 0.0 {
                    flags.push(format!(
                        "**Inert AI config:** {} dealt no damage in {} appearances.",
                        r["config"].as_str().unwrap(),
                        n
                    ));
                }
                if f(&r["destroyed_rate"]) == 0.0 {
                    flags.push(format!(
                        "**Unkillable AI config:** {} was never destroyed in {} appearances.",
                        r["config"].as_str().unwrap(),
                        n
                    ));
                }
            }
        }
    } else {
        w(&mut body, "_Pending._\n".into());
    }

    // ---------------------------------------------------------- roguelike
    w(&mut body, "\n## Roguelike\n\n".into());
    if let Some(r) = load(dir, "roguelike") {
        w(&mut body, format!(
            "Full runs from mission 1 ({} nodes reachable). Repairs are unlimited here, to measure play rather than the wallet; the economy stage covers affordability. Composition, planning and tactics are at the same level. This table is the player's-choice runs: each level picks its own branches.\n\n| Level | Runs | Combats won per run | Runs won | Ships lost per run |\n|---|---|---|---|---|\n",
            r["total_nodes"]
        ));
        for l in r["levels"].as_array().unwrap() {
            w(
                &mut body,
                format!(
                    "| {} | {} | {:.2} | {} | {:.1} |\n",
                    l["level"].as_str().unwrap(),
                    l["runs"],
                    f(&l["mean_combats_won"]),
                    l["runs_won"],
                    f(&l["mean_ships_lost"])
                ),
            );
        }
        if let Some(ex) = r["levels"]
            .as_array()
            .unwrap()
            .iter()
            .find(|l| l["level"] == "excellent")
        {
            if ex["runs_won"].as_u64() == Some(0) {
                flags.push(format!("**Roguelike:** no run completes even with Excellent composition, planning and tactics ({} runs, {:.1} combats won on average).", ex["runs"], f(&ex["mean_combats_won"])));
            }
        }
        if let Some(b) = r["branches"].as_array().filter(|b| !b.is_empty()) {
            w(&mut body, "\n### Branch choices\n\nIn player's-choice runs that reached each branch: how many went each way.\n\n| At | Went to | Poor | Average | Excellent |\n|---|---|---|---|---|\n".into());
            for x in b {
                let c = x["chosen"].as_array().unwrap();
                w(&mut body, format!("| {} | {} | {} | {} | {} |\n", x["at"].as_str().unwrap(), x["to"].as_str().unwrap(), c[0], c[1], c[2]));
            }
        }
        if let Some(ps) = r["paths"].as_array().filter(|_| r["runs_per_path"].as_u64().unwrap_or(0) > 0) {
            w(&mut body, format!("\n### Every path\n\n{} runs per level on each path from mission 1 to an ending, with the branches forced onto that path (everything else is the player's call). Cells: runs won / runs (mean combats won).\n\n| Path | Branches taken | Combats | Poor | Average | Excellent |\n|---|---|---|---|---|---|\n", r["runs_per_path"]));
            for p in ps {
                let lv = p["levels"].as_array().unwrap();
                let cell = |l: &Value| format!("{}/{} ({:.1})", l["runs_won"], l["runs"], f(&l["mean_combats_won"]));
                w(&mut body, format!("| {} | {} | {} | {} | {} | {} |\n", p["path"], p["label"].as_str().unwrap(), p["combats"], cell(&lv[0]), cell(&lv[1]), cell(&lv[2])));
            }
        }
        w(&mut body, "\n### Missions in runs\n\nWin rate per attempt at each mission, over all runs (player's choice and forced paths), with damage carried in from earlier missions. Attempts in brackets.\n\n| Mission | Poor | Average | Excellent |\n|---|---|---|---|\n".into());
        for n in r["nodes"].as_array().unwrap() {
            let lv = n["levels"].as_array().unwrap();
            let cell = |l: &Value| {
                let a = l["attempts"].as_u64().unwrap_or(0);
                if a == 0 { "–".to_string() } else { format!("{} ({a})", pct(f(&l["win_rate"]))) }
            };
            w(&mut body, format!("| {} | {} | {} | {} |\n", n["name"].as_str().or(n["node"].as_str()).unwrap(), cell(&lv[0]), cell(&lv[1]), cell(&lv[2])));
        }
    } else {
        w(&mut body, "_Pending._\n".into());
    }

    // --------------------------------------------------------- components
    w(&mut body, "\n## Ship parts and prices\n\n".into());
    if let Some(c) = load(dir, "components") {
        w(&mut body, format!(
            "Every cost-table entry's effect on winning, fitted by Bradley–Terry over {} Average-vs-Average games between random fleets (log-loss {:.3}). Each value is measured against the entry's baseline (Generic weapon, no armor or shields, no special, tier 0). The fit implies **{:.4} win log-odds per cost point**. An entry's fair price is its value divided by that; it's flagged when its price is off by more than {} and 5 points, at 2 standard errors.\n\n| Entry | Price | Value ± se | Fair price | Verdict |\n|---|---|---|---|---|\n",
            c["games"], f(&c["logloss"]), f(&c["value_per_cost_point"]), pct(fl.component_mispricing)
        ));
        for e in c["entries"].as_array().unwrap() {
            let v = e["verdict"].as_str().unwrap();
            w(
                &mut body,
                format!(
                    "| {} | {} | {:+.3} ± {:.3} | {:.0} | {} |\n",
                    e["entry"].as_str().unwrap(),
                    e["cost"],
                    f(&e["value"]),
                    f(&e["se"]),
                    f(&e["fair_cost"]),
                    v
                ),
            );
            if v == "underpriced" || v == "overpriced" {
                flags.push(format!(
                    "**{}:** {} costs {} but plays like {:.0}.",
                    if v == "underpriced" {
                        "Underpriced"
                    } else {
                        "Overpriced"
                    },
                    e["entry"].as_str().unwrap(),
                    e["cost"],
                    f(&e["fair_cost"])
                ));
            }
        }
        w(&mut body, "\n**What Excellent composers field.** \"Relative\" is an entry's share of picked ships divided by its share of available ships: above 1 means it's favoured.\n\n| Entry | Available | Picked | Pick rate | Relative |\n|---|---|---|---|---|\n".into());
        let mut picks: Vec<&Value> = c["pick_rates"].as_array().unwrap().iter().collect();
        picks.sort_by(|a, b| f(&b["relative"]).partial_cmp(&f(&a["relative"])).unwrap());
        for p in &picks {
            w(
                &mut body,
                format!(
                    "| {} | {} | {} | {} | {:.2} |\n",
                    p["entry"].as_str().unwrap(),
                    p["available"],
                    p["picked"],
                    pct(f(&p["pick_rate"])),
                    f(&p["relative"])
                ),
            );
            if p["available"].as_u64().unwrap_or(0) >= 30 && p["picked"].as_u64() == Some(0) {
                flags.push(format!(
                    "**Never picked:** Excellent composers never fielded {} ({} available).",
                    p["entry"].as_str().unwrap(),
                    p["available"]
                ));
            }
        }
    } else {
        w(&mut body, "_Pending._\n".into());
    }

    // ------------------------------------------------------------ economy
    w(&mut body, "\n## Economy and progression\n\n".into());
    if let Some(e) = load(dir, "economy") {
        w(&mut body, format!(
            "{} simulated days, {} players per archetype. Final state:\n\n| Spend | Skill | $ spent | Ships | Fleet power (1000 cap) | Storefront tier | Runs | Runs won | Medal | Combats won/run | PvP score | Elo | Ships lost | Free top-ups |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|---|\n",
            e["days"], e["players_per_archetype"]
        ));
        for a in e["summary"].as_array().unwrap() {
            if f(&a["ships"]) < fl.min_final_ships {
                flags.push(format!(
                    "**Hangar ran out:** {}/{} players end with {:.1} ships on average (fewer than {:.0}, about one fleet).",
                    a["spend"].as_str().unwrap(),
                    a["skill"].as_str().unwrap(),
                    f(&a["ships"]),
                    fl.min_final_ships
                ));
            }
            w(&mut body, format!(
                "| {} | {} | {:.0} | {:.0} | {:.2} | {:.1} | {:.1} | {} | {} | {:.2} | {} | {:.0} | {:.1} | {:.1} |\n",
                a["spend"].as_str().unwrap(), a["skill"].as_str().unwrap(), f(&a["usd_spent"]), f(&a["ships"]), f(&a["fleet_power_1000"]), f(&a["storefront_tier"]),
                f(&a["runs"]), pct(f(&a["run_win_rate"])), pct(f(&a["medal_share"])), f(&a["run_combats_won"]), pct(f(&a["pvp_score"])), f(&a["elo"]), f(&a["ships_lost"]), f(&a["ships_topped_up"])
            ));
        }
        w(&mut body, losses_table(&dir.join("economy").join("matches.jsonl")));
        w(
            &mut body,
            "\n**Progression:** fleet power (1000 cap) by week.\n\n".into(),
        );
        let curves = e["curves"].as_array().unwrap();
        if let Some(first) = curves.first() {
            let days: Vec<String> = first["points"]
                .as_array()
                .unwrap()
                .iter()
                .map(|p| format!("day {}", f(&p["day"]) as u64 + 1))
                .collect();
            w(
                &mut body,
                format!(
                    "| Archetype | {} |\n|---|{}\n",
                    days.join(" | "),
                    "---|".repeat(days.len())
                ),
            );
            for c in curves {
                let vals: Vec<String> = c["points"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|p| format!("{:.2}", f(&p["fleet_power_1000"])))
                    .collect();
                w(
                    &mut body,
                    format!(
                        "| {}/{} | {} |\n",
                        c["spend"].as_str().unwrap(),
                        c["skill"].as_str().unwrap(),
                        vals.join(" | ")
                    ),
                );
            }
        }
    } else {
        w(&mut body, "_Pending._\n".into());
    }

    // ------------------------------------------------------------ header
    let _ = writeln!(md, "# Balance report: {}\n", exp.name);
    if exp.smoke {
        md.push_str("> **Smoke run:** Excellent tactics use a tiny search here. These numbers check the pipeline and are **not** balance results.\n\n");
    }
    let stages: Vec<String> = exp
        .stages
        .iter()
        .map(|s| {
            format!(
                "{s}: {}",
                if load(dir, s).is_some() {
                    "done"
                } else {
                    "pending"
                }
            )
        })
        .collect();
    let _ = writeln!(md, "Seed {}. Stages: {}.\n", exp.seed, stages.join(", "));
    md.push_str("Method and caveats: `docs/balance-simulator.md`.\n\n## Flags\n\n");
    if flags.is_empty() {
        md.push_str("_None from the finished stages._\n\n");
    } else {
        for x in &flags {
            let _ = writeln!(md, "- {x}");
        }
        md.push('\n');
    }
    md.push_str(&body);
    std::fs::write(dir.join("report.md"), md)
}

/// Ships destroyed vs retreated per game, by archetype and mode, from the
/// economy stage's match log (streamed; it can be large).
fn losses_table(path: &Path) -> String {
    use std::collections::BTreeMap;
    use std::io::BufRead;
    let Ok(file) = std::fs::File::open(path) else {
        return String::new();
    };
    // (archetype, kind) -> [games, destroyed, retreated, disabled at end]
    let mut t: BTreeMap<(String, String), [u64; 4]> = BTreeMap::new();
    for line in std::io::BufReader::new(file).lines().map_while(Result::ok) {
        let Ok(m) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if m["record"] != "match" {
            continue;
        }
        let kind = m["kind"].as_str().unwrap_or("").to_string();
        for (side, key) in [(0u64, "creator"), (1, "joiner")] {
            let label = m[key]["label"].as_str().unwrap_or("");
            if !label.contains('/') {
                continue; // the on-chain AI
            }
            let arch = label.split('#').next().unwrap_or(label).to_string();
            let e = t.entry((arch, kind.clone())).or_default();
            e[0] += 1;
            for s in m["ship_logs"].as_array().into_iter().flatten() {
                if s["side"].as_u64() != Some(side) {
                    continue;
                }
                match s["outcome"].as_str() {
                    Some("destroyed") => e[1] += 1,
                    Some("fled") => e[2] += 1,
                    Some("disabled") => e[3] += 1,
                    _ => {}
                }
            }
        }
    }
    if t.is_empty() {
        return String::new();
    }
    let mut s = String::from("\n**Ship losses:** own ships destroyed (lost for good) and retreated (kept), per game, by mode.\n\n| Archetype | Mode | Games | Destroyed/game | Retreated/game | Disabled at end/game |\n|---|---|---|---|---|---|\n");
    for ((arch, kind), [g, d, r, x]) in &t {
        let per = |v: u64| v as f64 / (*g).max(1) as f64;
        let _ = writeln!(
            s,
            "| {arch} | {kind} | {g} | {:.2} | {:.2} | {:.2} |",
            per(*d),
            per(*r),
            per(*x)
        );
    }
    s
}

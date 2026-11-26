//! `vt-sim replay`: prints a logged game move by move with ASCII boards, so a
//! person can see where a simulated player plays badly. Needs match records
//! written with `--log-moves` (they carry `start_board` and `transcript`).
//!
//! Board legend: `.` open, `#` blocks line of sight, `X` impassable, `*`
//! scoring tile; creator ships are `A`..`Z`, joiner ships `a`..`z`, lowercase
//! or uppercase by side (a disabled ship prints as `!`). Ids, names and
//! builds are listed once at the top.

use std::collections::BTreeMap;
use std::fmt::Write as _;

use serde_json::Value;
use vt_core::grid::{GRID_HEIGHT, GRID_WIDTH};
use vt_core::maps::PresetMap;

/// Which logged game to print.
pub enum Pick {
    /// The n-th match line (0-based) in the file.
    Index(usize),
    /// The first match with move logs on this node (campaign/roguelike) or
    /// map, optionally only one the creator lost.
    Node { key: String, losses_only: bool },
}

pub fn find(lines: &[String], pick: &Pick) -> Option<Value> {
    let matches = lines
        .iter()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .filter(|v| v["record"] == "match");
    match pick {
        Pick::Index(n) => matches.into_iter().nth(*n),
        Pick::Node { key, losses_only } => matches.into_iter().find(|v| {
            v.get("transcript").is_some()
                && (v["node"] == key.as_str() || v["map"] == key.as_str())
                && (!losses_only || v["winner"] != "creator")
        }),
    }
}

/// Renders a match record. `every_move`: a board after every move instead
/// of once per round.
pub fn render(m: &Value, maps: &std::collections::HashMap<String, PresetMap>, every_move: bool) -> String {
    let mut out = String::new();
    let map_key = m["map"].as_str().unwrap_or("");
    let _ = writeln!(
        out,
        "{} {} (map {map_key}, seed {}): {} vs {} -> winner {}, {} ({} rounds, {} moves), score {}",
        m["kind"].as_str().unwrap_or(""),
        m["node"].as_str().unwrap_or("-"),
        m["seed"],
        m["creator"]["label"].as_str().unwrap_or(""),
        m["joiner"]["label"].as_str().unwrap_or(""),
        m["winner"].as_str().unwrap_or(""),
        m["end"].as_str().unwrap_or(""),
        m["rounds"],
        m["moves"],
        m["scores"],
    );
    // Letters per ship, by side, in id order.
    let mut letter: BTreeMap<u64, char> = BTreeMap::new();
    let mut counts = [0u8; 2];
    let ships = m["ship_logs"].as_array().cloned().unwrap_or_default();
    for s in &ships {
        let side = s["side"].as_u64().unwrap_or(0) as usize;
        let base = if side == 0 { b'A' } else { b'a' };
        let c = (base + counts[side] % 26) as char;
        counts[side] += 1;
        letter.insert(s["id"].as_u64().unwrap_or(0), c);
    }
    let _ = writeln!(out, "\nShips:");
    for s in &ships {
        let id = s["id"].as_u64().unwrap_or(0);
        let _ = writeln!(
            out,
            "  {} {:>14} {:<22} v{} {:<7} armor {:<6} shields {:<6} special {:<6} acc/hull/spd {}/{}/{} hp {}/{} cost {} {} -> {} (dealt {}, taken {}, kills {})",
            letter[&id],
            id,
            s["name"].as_str().unwrap_or(""),
            s["variant"],
            s["weapon"].as_str().unwrap_or(""),
            s["armor"].as_str().unwrap_or(""),
            s["shields"].as_str().unwrap_or(""),
            s["special"].as_str().unwrap_or(""),
            s["accuracy"],
            s["hull"],
            s["speed"],
            s["start_hp"],
            s["max_hp"],
            s["list_cost"],
            s["ai_config"].as_str().map(|k| format!("[{k}]")).unwrap_or_default(),
            s["outcome"].as_str().unwrap_or(""),
            s["damage_dealt"],
            s["damage_taken"],
            s["kills"],
        );
    }
    let Some(start) = m.get("start_board") else {
        let _ = writeln!(out, "\n(no transcript: rerun with --log-moves)");
        return out;
    };
    let map = maps.get(map_key);
    let _ = writeln!(out, "\nStart:");
    out += &board(start, map, &letter);
    let moves = m["transcript"].as_array().cloned().unwrap_or_default();
    let mut prev = start.clone();
    let mut round = start["round"].as_u64().unwrap_or(1);
    for mv in &moves {
        let b = &mv["board"];
        let id = mv["ship"].as_u64().unwrap_or(0);
        let who = letter.get(&id).copied().unwrap_or('?');
        let target = mv["target"].as_u64().unwrap_or(0);
        let tgt = if target != 0 {
            format!(" -> {}", letter.get(&target).copied().unwrap_or('?'))
        } else {
            String::new()
        };
        let _ = writeln!(
            out,
            "R{} {} {} {} to ({},{}){} | {}",
            round,
            if mv["side"] == 0 { "creator" } else { "joiner " },
            who,
            mv["action"].as_str().unwrap_or(""),
            mv["to"][0],
            mv["to"][1],
            tgt,
            changes(&prev, b, &letter),
        );
        let r = b["round"].as_u64().unwrap_or(round);
        if every_move || r != round || b["ended"] == true {
            let _ = writeln!(out, "score {} after round {}:", b["scores"], round);
            out += &board(b, map, &letter);
        }
        round = r;
        prev = b.clone();
    }
    out
}

/// HP, status and score changes between two boards.
fn changes(a: &Value, b: &Value, letter: &BTreeMap<u64, char>) -> String {
    let rows = |v: &Value| -> BTreeMap<u64, Vec<i64>> {
        v["ships"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|r| {
                let r: Vec<i64> = r.as_array().unwrap().iter().map(|x| x.as_i64().unwrap()).collect();
                (r[0] as u64, r)
            })
            .collect()
    };
    let (ra, rb) = (rows(a), rows(b));
    let mut parts = Vec::new();
    for (id, y) in &rb {
        let Some(x) = ra.get(id) else { continue };
        let l = letter.get(id).copied().unwrap_or('?');
        if x[4] != y[4] {
            parts.push(format!("{l} hp {}->{}", x[4], y[4]));
        }
        if x[5] != y[5] {
            parts.push(format!(
                "{l} {}",
                match y[5] {
                    1 => "DESTROYED",
                    2 => "retreated",
                    _ => "status?",
                }
            ));
        }
    }
    if a["scores"] != b["scores"] {
        parts.push(format!("score {}->{}", a["scores"], b["scores"]));
    }
    parts.join(", ")
}

fn board(b: &Value, map: Option<&PresetMap>, letter: &BTreeMap<u64, char>) -> String {
    let (h, w) = (GRID_HEIGHT as usize, GRID_WIDTH as usize);
    let mut grid = vec![vec!['.'; w]; h];
    if let Some(m) = map {
        for (r, c) in m.blocked.cells() {
            grid[r as usize][c as usize] = '#';
        }
        for (r, c) in m.impassable.cells() {
            grid[r as usize][c as usize] = 'X';
        }
        for s in &m.scoring {
            if s.points > 0 {
                grid[s.row as usize][s.col as usize] = '*';
            }
        }
    }
    let mut legend = Vec::new();
    for r in b["ships"].as_array().into_iter().flatten() {
        let v: Vec<i64> = r.as_array().unwrap().iter().map(|x| x.as_i64().unwrap()).collect();
        let (id, row, col, hp, status) = (v[0] as u64, v[2], v[3], v[4], v[5]);
        if status != 0 || row < 0 || col < 0 {
            continue;
        }
        let l = letter.get(&id).copied().unwrap_or('?');
        grid[row as usize][col as usize] = if hp == 0 { '!' } else { l };
        legend.push(format!("{l}{}", if hp == 0 { "(disabled)".to_string() } else { format!(":{hp}") }));
    }
    let mut s = String::from("     ");
    for c in 0..w {
        let _ = write!(s, "{}", c % 10);
    }
    s.push('\n');
    for (r, row) in grid.iter().enumerate() {
        let _ = writeln!(s, "  {r:>2} {}", row.iter().collect::<String>());
    }
    let _ = writeln!(s, "  hp: {}", legend.join(" "));
    s
}

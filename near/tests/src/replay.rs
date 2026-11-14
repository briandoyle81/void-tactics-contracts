//! What a replay indexer sees: the `void_tactics` events in a transaction's
//! logs, reduced to the boards they carry (vt_core::replay::CompactBoard).

use near_workspaces::result::ExecutionFinalResult;
use serde_json::Value;
use vt_core::replay::CompactBoard;

/// Every board for `game_id` in `out`'s logs, in emission order: `game_board`
/// frames, each `move`'s board, and each AI turn's board followed by the
/// `ai_turns` call's closing board.
pub fn boards(out: &ExecutionFinalResult, game_id: &str) -> Vec<CompactBoard> {
    let mut v = Vec::new();
    for log in out.logs() {
        let Some(json) = log.strip_prefix("EVENT_JSON:") else { continue };
        let e: Value = serde_json::from_str(json).expect("event JSON");
        if e["standard"] != "void_tactics" {
            continue;
        }
        let d = &e["data"][0];
        if d["game_id"].as_str() != Some(game_id) {
            continue;
        }
        let parse = |b: &Value| serde_json::from_value::<CompactBoard>(b.clone()).expect("board");
        match e["event"].as_str().unwrap_or("") {
            "game_board" | "move" => v.push(parse(&d["board"])),
            "ai_turns" => {
                for t in d["turns"].as_array().into_iter().flatten() {
                    if !t["board"].is_null() {
                        v.push(parse(&t["board"]));
                    }
                }
                v.push(parse(&d["board"]));
            }
            _ => {}
        }
    }
    v
}

/// Largest total log size of any single receipt in `out` (NEAR caps it at
/// 16,384 bytes).
pub fn max_receipt_log_bytes(out: &ExecutionFinalResult) -> usize {
    out.outcomes().iter().map(|o| o.logs.iter().map(|l| l.len()).sum::<usize>()).max().unwrap_or(0)
}

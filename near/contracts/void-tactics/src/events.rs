//! NEP-297 events (`EVENT_JSON:` logs) for the `void_tactics` standard.
//!
//! NEAR has no `eth_getLogs`; anything the frontend needs must ALSO be readable
//! through a view method. Events are for indexers and UX notifications.

use near_sdk::env;
use near_sdk::serde_json::{json, Value};

pub const STANDARD: &str = "void_tactics";
pub const VERSION: &str = "1.0.0";

pub fn emit(event: &str, data: Value) {
    let payload = json!({
        "standard": STANDARD,
        "version": VERSION,
        "event": event,
        "data": [data],
    });
    env::log_str(&format!("EVENT_JSON:{payload}"));
}

/// The compact board of `g` as JSON (vt_core::replay::CompactBoard).
pub fn board_frame(g: &vt_core::engine::GameState) -> Value {
    near_sdk::serde_json::to_value(vt_core::replay::compact_board(g)).unwrap_or(Value::Null)
}

/// `game_board`: a standalone frame for replay indexers. `reason` is
/// "start" (with `fleet` rows `[id, side, variant, max_hp]`) or the way a
/// game was ended outside a move ("forfeit", "flee", "timeout", "retreat").
pub fn emit_board(game_id: u64, reason: &str, g: &vt_core::engine::GameState) {
    let mut data = json!({ "game_id": near_sdk::json_types::U64(game_id), "reason": reason, "board": board_frame(g) });
    if reason == "start" {
        data["fleet"] = near_sdk::serde_json::to_value(vt_core::replay::fleet_info(g)).unwrap_or(Value::Null);
    }
    emit("game_board", data);
}

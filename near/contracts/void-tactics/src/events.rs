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

//! Test-only NEP-171 receiver. `msg` picks its behavior:
//!   "keep"   -> false (keep the token)
//!   "return" -> true  (ask for it back)
//!   "panic"  -> panics
//!   "junk"   -> returns a large non-bool payload
//!   "gas"    -> burns all its gas
use near_sdk::{env, near, AccountId, PanicOnDefault};

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Receiver {}

#[near]
impl Receiver {
    #[init]
    pub fn new() -> Self {
        Self {}
    }

    pub fn nft_on_transfer(&mut self, sender_id: AccountId, previous_owner_id: AccountId, token_id: String, msg: String) -> near_sdk::serde_json::Value {
        let _ = (sender_id, previous_owner_id, token_id);
        match msg.as_str() {
            "keep" => near_sdk::serde_json::json!(false),
            "return" => near_sdk::serde_json::json!(true),
            "panic" => env::panic_str("hostile receiver"),
            "junk" => near_sdk::serde_json::json!("x".repeat(10_000)),
            "gas" => {
                let mut x: u64 = 1;
                loop {
                    x = x.wrapping_mul(6364136223846793005).wrapping_add(1);
                    env::log_str(if x == 0 { "never" } else { "" });
                }
            }
            _ => near_sdk::serde_json::json!(false),
        }
    }
}

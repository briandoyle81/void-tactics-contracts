//! Free ship claims (FreeShipClaim) and the drone-core storefront
//! (DroneStorefront). Paid purchases, recycling, DroneYard and tutorial
//! claims are Phase 2.

use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::json;
use near_sdk::{env, near, require};

use crate::config::TokenKind;
use crate::events;
use crate::{Contract, ContractExt};

#[near(serializers = [json])]
pub struct ClaimStatus {
    pub next_claim_at_s: U64,
    pub ships_per_claim: u32,
    pub drone_core_tier: u8,
    /// Cores needed for the next tier (None at max tier).
    pub next_tier_cost: Option<u32>,
}

#[near]
impl Contract {
    /// FreeShipClaim.claimFreeShips: `free_claim_base + drone_core_tier` free
    /// ships every cooldown. Free ships can't be recycled, and destroying one
    /// pays no reward. Storage is charged to the caller (a Sybil swarm pays for
    /// its own bytes).
    pub fn claim_free_ships(&mut self, variant: u16) -> Vec<U64> {
        let caller = env::predecessor_account_id();
        let mut acct = self.account(&caller);
        let now = Self::now_s();
        if self.config.free_claim_requires_verification {
            require!(self.is_verified(&caller), "NotEligible");
        }
        require!(
            acct.last_free_claim_s == 0 || now >= acct.last_free_claim_s + self.config.claim_cooldown_s,
            "ClaimCooldownNotPassed"
        );
        acct.last_free_claim_s = now;
        let amount = self.config.free_claim_base + acct.drone_core_tier as u32;
        self.put_account(&caller, acct);

        let initial = env::storage_usage();
        let (ship_ids, random_ids) = self.internal_create_ships(&caller, amount, variant, 0, true);
        self.charge_storage_since(&caller, initial);
        Self::schedule_resolution(random_ids).detach();

        near_contract_standards::non_fungible_token::events::NftMint {
            owner_id: &caller,
            token_ids: &ship_ids.iter().map(|i| i.to_string()).collect::<Vec<_>>().iter().map(String::as_str).collect::<Vec<_>>(),
            memo: Some("free_claim"),
        }
        .emit();
        events::emit("free_ships_claimed", json!({ "player": caller, "amount": amount }));
        ship_ids.into_iter().map(U64).collect()
    }

    /// DroneStorefront.turnInCores: burn exactly the next tier's DEC cost for
    /// +1 permanent free ship per claim.
    pub fn turn_in_cores(&mut self, amount: U128) {
        let caller = env::predecessor_account_id();
        let mut acct = self.account(&caller);
        let tier = acct.drone_core_tier;
        require!(tier < self.config.storefront_tier_count, "MaxTierReached");
        let required = *self.config.storefront_tiers.get(&tier).unwrap() as u128;
        require!(amount.0 == required, "WrongAmount");
        acct.drone_core_tier = tier + 1;
        self.put_account(&caller, acct);
        self.burn(&caller, TokenKind::Dec, required);
        events::emit("cores_turned_in", json!({ "player": caller, "tier": tier + 1, "amount": amount }));
    }

    pub fn get_claim_status(&self, account_id: near_sdk::AccountId) -> Option<ClaimStatus> {
        let a = self.accounts.get(&account_id)?;
        let next = if a.last_free_claim_s == 0 { 0 } else { a.last_free_claim_s + self.config.claim_cooldown_s };
        Some(ClaimStatus {
            next_claim_at_s: U64(next),
            ships_per_claim: self.config.free_claim_base + a.drone_core_tier as u32,
            drone_core_tier: a.drone_core_tier,
            next_tier_cost: self.config.storefront_tiers.get(&a.drone_core_tier).copied(),
        })
    }
}

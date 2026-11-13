//! Phase 2 economy: purchases (Ships.purchaseWithFlow, ShipPurchaser),
//! recycling (Ships.shipBreaker), DroneYard, TutorialClaim, the Shattered Hive
//! medal + VariantPurchaseGate, SelfieCheck eligibility, game-sponsored
//! storage, and the owner treasury.
//!
//! Economy invariants kept (docs/tokenomics-audit.md):
//!   - native ship prices, UTC ship prices and the native->UTC peg are three
//!     separate fields (2026-10-23 bug);
//!   - `buy_utc_with_near` mints exactly the tier's UTC price (the peg);
//!   - free ships can't be recycled; recycling a destroyed ship pays half, so
//!     kill reward (25%) + destroyed recycle (50%) < clean recycle (ECON-01);
//!   - collected UTC sits in the treasury for owner burns (ECON-07).

use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::json;
use near_sdk::{env, near, require, AccountId, NearToken, Promise};
use vt_core::attributes::{count_modifications, modification_cost, referral_pct};
use vt_core::types::*;

use crate::config::TokenKind;
use crate::events;
use crate::{roles, Contract, ContractExt};

pub const VERIFICATION_VALIDITY_S: u64 = 90 * 24 * 60 * 60;

fn mint_event(owner: &AccountId, ids: &[u64], memo: &str) {
    let strs: Vec<String> = ids.iter().map(|i| i.to_string()).collect();
    let refs: Vec<&str> = strs.iter().map(String::as_str).collect();
    near_contract_standards::non_fungible_token::events::NftMint { owner_id: owner, token_ids: &refs, memo: Some(memo) }.emit();
}

fn template(name: &str, weapon: MainWeapon, armor: Armor, shields: Shields, special: Special, colors: (u16, u8, u8, u16, u8, u8), tiers: (u8, u8, u8)) -> Ship {
    let mut s = Ship { name: name.to_string(), ..Default::default() };
    s.equipment = Equipment { main_weapon: weapon, armor, shields, special };
    s.traits = Traits {
        serial_number: 0,
        colors: Colors { h1: colors.0, s1: colors.1, l1: colors.2, h2: colors.3, s2: colors.4, l2: colors.5 },
        variant: 1,
        accuracy: tiers.0,
        hull: tiers.1,
        speed: tiers.2,
    };
    s.ship_data.is_free_ship = true;
    s
}

/// TutorialClaim templates.
fn resolute() -> Ship {
    let mut s = template("Resolute", MainWeapon::Close, Armor::None, Shields::Medium, Special::Slot1, (200, 80, 50, 220, 70, 40), (2, 2, 2));
    s.ship_data.ships_destroyed = 10;
    s.ship_data.shiny = true;
    s
}
fn vigilant() -> Ship {
    template("Vigilant", MainWeapon::Sniper, Armor::None, Shields::Light, Special::Slot2, (250, 90, 60, 270, 80, 50), (1, 0, 0))
}
fn sentinel() -> Ship {
    template("Sentinel", MainWeapon::Generic, Armor::Medium, Shields::None, Special::None, (150, 70, 55, 170, 60, 45), (1, 0, 0))
}

impl Contract {
    pub(crate) fn is_verified(&self, account: &AccountId) -> bool {
        self.accounts.get(account).is_some_and(|a| a.verified_until_s > Self::now_s())
    }

    fn debit_utc_to_treasury(&mut self, from: &AccountId, amount: u128) {
        let mut a = self.account(from);
        require!(a.utc >= amount, "InsufficientFunds");
        a.utc -= amount;
        self.put_account(from, a);
        self.config.treasury_utc += amount;
    }

    fn pay_from_treasury(&mut self, to: &AccountId, amount: u128) {
        if amount == 0 {
            return;
        }
        require!(self.config.treasury_utc >= amount, "TreasuryInsufficient");
        let mut a = self.accounts.get(to).cloned().unwrap_or_else(|| env::panic_str("ReferrerNotRegistered"));
        a.utc += amount;
        self.put_account(to, a);
        self.config.treasury_utc -= amount;
    }
}

#[near]
impl Contract {
    // ================================================================ buying

    /// Ships.purchaseWithFlow with NEAR. The pack pays for its own storage out
    /// of the price (registering the buyer if needed), so a paid pack never
    /// fails for lack of prepaid storage. Referral pays NEAR.
    #[payable]
    pub fn purchase_ships_with_near(&mut self, tier: u8, referral: Option<AccountId>, variant: u16) -> Vec<U64> {
        let buyer = env::predecessor_account_id();
        let t = self.config.price_tier(tier).clone();
        let paid = env::attached_deposit().as_yoctonear();
        require!(paid == t.near_ship_price.0, "InvalidPurchase");
        let reg_bytes = if self.accounts.contains_key(&buyer) { 0 } else { self.register_without_deposit(&buyer) };
        self.flush_all();
        let initial = env::storage_usage();
        let (ships, randoms) = self.internal_create_ships(&buyer, t.ships as u32, variant, tier, false);
        let mut referral_amount = 0u128;
        if let Some(r) = &referral {
            let count = self.ship_referrals.get(r).copied().unwrap_or(0) + t.ships as u64;
            self.ship_referrals.insert(r.clone(), count);
            referral_amount = paid * referral_pct(count) / 100;
        }
        self.flush_all();
        let bytes = env::storage_usage() - initial + reg_bytes;
        let storage_cost = bytes as u128 * env::storage_byte_cost().as_yoctonear();
        require!(paid >= storage_cost + referral_amount, "PriceBelowStorageCost");
        let mut a = self.account(&buyer);
        a.deposit = a.deposit.saturating_add(NearToken::from_yoctonear(storage_cost));
        self.put_account(&buyer, a);
        self.charge_storage_since(&buyer, initial);
        self.config.revenue_near += paid - storage_cost - referral_amount;
        if let (Some(r), true) = (referral, referral_amount > 0) {
            Promise::new(r).transfer(NearToken::from_yoctonear(referral_amount)).detach();
        }
        Self::schedule_resolution(randoms).detach();
        mint_event(&buyer, &ships, "purchase_near");
        ships.into_iter().map(U64).collect()
    }

    /// ShipPurchaser.purchaseWithUTC. Storage comes from the buyer's prepaid
    /// balance. Referral pays UTC from the collected price on ShipPurchaser's
    /// same ladder as NEAR purchases (referrer must be registered).
    pub fn purchase_ships_with_utc(&mut self, tier: u8, referral: Option<AccountId>, variant: u16) -> Vec<U64> {
        let buyer = env::predecessor_account_id();
        let t = self.config.price_tier(tier).clone();
        let initial = env::storage_usage();
        self.debit_utc_to_treasury(&buyer, t.utc_price.0);
        let (ships, randoms) = self.internal_create_ships(&buyer, t.ships as u32, variant, tier, false);
        if let Some(r) = referral {
            let count = self.utc_referrals.get(&r).copied().unwrap_or(0) + t.ships as u64;
            self.utc_referrals.insert(r.clone(), count);
            self.pay_from_treasury(&r, t.utc_price.0 * referral_pct(count) / 100);
        }
        self.charge_storage_since(&buyer, initial);
        Self::schedule_resolution(randoms).detach();
        mint_event(&buyer, &ships, "purchase_utc");
        ships.into_iter().map(U64).collect()
    }

    /// ShipPurchaser.purchaseUTCWithFlow: pay the tier's NEAR peg price, get
    /// exactly the tier's UTC price.
    #[payable]
    pub fn buy_utc_with_near(&mut self, tier: u8) -> U128 {
        let buyer = env::predecessor_account_id();
        let t = self.config.price_tier(tier).clone();
        let paid = env::attached_deposit().as_yoctonear();
        require!(paid == t.near_utc_price.0, "InvalidPurchase");
        self.assert_registered(&buyer);
        require!(self.try_mint(&buyer, TokenKind::Utc, t.utc_price.0), "MintFailed");
        self.config.revenue_near += paid;
        t.utc_price
    }

    // =========================================================== recycling

    /// Ships.shipBreaker: burn owned, unlocked, non-free ships for UTC
    /// (half for an already-destroyed ship). Storage is refunded.
    pub fn recycle_ships(&mut self, ship_ids: Vec<U64>) -> U128 {
        let caller = env::predecessor_account_id();
        let initial = env::storage_usage();
        let mut total = 0u128;
        let mut burned = Vec::new();
        for U64(id) in ship_ids {
            let rec = self.ship_record(id);
            require!(rec.owner == caller, "NotYourShip");
            require!(!rec.ship.ship_data.in_fleet, "ShipInFleet");
            require!(!rec.ship.ship_data.is_free_ship, "CannotRecycleFreeShip");
            let r = self.config.recycle_reward;
            total += if rec.ship.ship_data.timestamp_destroyed != 0 { r >> 1 } else { r };
            self.internal_burn_ship(id);
            burned.push(id.to_string());
        }
        self.charge_storage_since(&caller, initial);
        if total > 0 {
            require!(self.try_mint(&caller, TokenKind::Utc, total), "MintFailed");
        }
        let refs: Vec<&str> = burned.iter().map(String::as_str).collect();
        near_contract_standards::non_fungible_token::events::NftBurn { owner_id: &caller, token_ids: &refs, authorized_id: None, memo: Some("recycle") }.emit();
        U128(total)
    }

    // ============================================================ DroneYard

    /// DroneYard.calculateCostToModify (view).
    pub fn get_modification_cost(&self, ship_id: U64, equipment: Equipment, accuracy: u8, hull: u8, speed: u8, variant: u16, shiny: bool) -> U128 {
        let cur = self.ship_record(ship_id.0).ship;
        let new = Self::modified(&cur, equipment, accuracy, hull, speed, variant, shiny);
        U128(self.cost_to_modify(&cur, &new))
    }

    /// DroneYard.modifyShip: re-equip / re-tier a ship for UTC. Name, colors,
    /// kills and free status are preserved; the price doubles per lifetime
    /// modification.
    #[allow(clippy::too_many_arguments)]
    pub fn modify_ship(&mut self, ship_id: U64, equipment: Equipment, accuracy: u8, hull: u8, speed: u8, variant: u16, shiny: bool) {
        let caller = env::predecessor_account_id();
        let cur = self.ship_record(ship_id.0);
        require!(cur.owner == caller, "NotShipOwner");
        require!(cur.ship.ship_data.constructed, "ShipNotConstructed");
        require!(!cur.ship.ship_data.in_fleet, "ShipInFleet");
        for t in [accuracy, hull, speed] {
            require!(t <= 2, "InvalidTraitValue");
        }
        require!(variant != 0 && variant <= self.config.max_variant, "InvalidVariant");
        require!(variant == cur.ship.traits.variant, "InvalidVariant");
        require!(equipment.armor == Armor::None || equipment.shields == Shields::None, "ArmorAndShieldsBothSet");
        require!(equipment.special as u8 <= self.config.max_special_slot_of(variant), "InvalidSpecial");
        let new = Self::modified(&cur.ship, equipment, accuracy, hull, speed, variant, shiny);
        let cost = self.cost_to_modify(&cur.ship, &new);
        let initial = env::storage_usage();
        self.debit_utc_to_treasury(&caller, cost);
        self.apply_customization(ship_id.0, &new);
        self.charge_storage_since(&caller, initial);
    }

    // ============================================================= tutorial

    /// TutorialClaim.completeTutorialWinPath / LossPath: one-time template
    /// ships (2 on a win, 3 on a loss) plus a win/loss on the record.
    pub fn complete_tutorial(&mut self, win_path: bool) -> Vec<U64> {
        let caller = env::predecessor_account_id();
        let mut a = self.account(&caller);
        if self.config.tutorial_requires_verification {
            require!(self.is_verified(&caller), "NotEligible");
        }
        require!(!a.tutorial_completed, "TutorialAlreadyCompleted");
        a.tutorial_completed = true;
        if win_path { a.wins += 1 } else { a.losses += 1 }
        self.put_account(&caller, a);
        let initial = env::storage_usage();
        let templates = if win_path { vec![vigilant(), sentinel()] } else { vec![resolute(), vigilant(), sentinel()] };
        let ids: Vec<u64> = templates.iter().map(|t| self.internal_create_specific_ship(&caller, t)).collect();
        self.charge_storage_since(&caller, initial);
        mint_event(&caller, &ids, "tutorial");
        events::emit("tutorial_completed", json!({ "player": caller, "win_path": win_path, "ships": ids.len() }));
        ids.into_iter().map(U64).collect()
    }

    // ================================================================ medal

    /// ShatteredHiveMedal.claimMedal: soulbound, one per account, for
    /// completing the campaign's final node. Gates variant-2 mints.
    pub fn claim_medal(&mut self) {
        let caller = env::predecessor_account_id();
        let final_node = self.config.medal_final_node;
        require!(final_node != 0 && self.sp.completed.get(&(caller.clone(), final_node)).copied().unwrap_or(false), "CampaignNotCompleted");
        self.internal_award_medal(&caller);
    }

    pub fn owner_mint_medal(&mut self, account_id: AccountId) {
        self.assert_owner();
        self.internal_award_medal(&account_id);
    }

    // ========================================================== eligibility

    /// SelfieCheckEligibilityProvider.markVerified (VERIFIER backend only).
    /// With the nullifier check on, one verified human (nullifier) is bound to
    /// one account forever; that account can renew.
    pub fn mark_verified(&mut self, account_id: AccountId, nullifier_hash: String) {
        self.assert_role(roles::VERIFIER);
        let n = parse_hash(&nullifier_hash);
        if self.config.nullifier_check_enabled {
            match self.nullifiers.get(&n) {
                None => {
                    self.nullifiers.insert(n, account_id.clone());
                }
                Some(bound) => require!(bound == &account_id, "NullifierAlreadyUsed"),
            }
        }
        let mut a = self.account(&account_id);
        a.verified_until_s = Self::now_s() + VERIFICATION_VALIDITY_S;
        self.put_account(&account_id, a);
        events::emit("player_verified", json!({ "player": account_id, "nullifier_hash": nullifier_hash }));
    }

    pub fn release_nullifier(&mut self, nullifier_hash: String) {
        self.assert_owner();
        let n = parse_hash(&nullifier_hash);
        if let Some(prev) = self.nullifiers.remove(&n) {
            if let Some(mut a) = self.accounts.get(&prev).cloned() {
                a.verified_until_s = 0;
                self.put_account(&prev, a);
            }
        }
    }

    pub fn is_eligible(&self, account_id: AccountId) -> bool {
        self.is_verified(&account_id)
    }

    // ===================================================== storage sponsoring

    /// Owner funds the pool the SPONSOR role draws from.
    #[payable]
    pub fn fund_sponsor_pool(&mut self) {
        self.assert_owner();
        self.config.sponsor_pool += env::attached_deposit().as_yoctonear();
    }

    /// SPONSOR (backend, after verification/onboarding) credits storage to an
    /// account, registering it if needed. Capped per account; sponsored NEAR
    /// can only be spent on storage, never withdrawn (see storage_withdraw),
    /// so the drain is bounded by human verification, not account count.
    pub fn sponsor_storage(&mut self, account_id: AccountId, amount: U128) {
        self.assert_role(roles::SPONSOR);
        let amount = amount.0;
        require!(amount <= self.config.sponsor_pool, "SponsorPoolEmpty");
        if !self.accounts.contains_key(&account_id) {
            self.register_without_deposit(&account_id);
        }
        let mut a = self.account(&account_id);
        let total = a.sponsored.as_yoctonear() + amount;
        require!(total <= self.config.sponsor_cap_per_account, "SponsorCapReached");
        a.sponsored = NearToken::from_yoctonear(total);
        a.deposit = a.deposit.saturating_add(NearToken::from_yoctonear(amount));
        require!(a.deposit >= a.locked(), "InsufficientStorageBalance");
        self.put_account(&account_id, a);
        self.config.sponsor_pool -= amount;
    }

    // ============================================================= treasury

    pub fn withdraw_near(&mut self, amount: U128, to: AccountId) -> Promise {
        self.assert_owner();
        require!(amount.0 <= self.config.revenue_near, "ExceedsRevenue");
        self.config.revenue_near -= amount.0;
        Promise::new(to).transfer(NearToken::from_yoctonear(amount.0))
    }

    pub fn withdraw_utc(&mut self, amount: U128, to: AccountId) {
        self.assert_owner();
        self.pay_from_treasury(&to, amount.0);
    }

    /// ECON-07 sink: burn collected UTC.
    pub fn burn_collected_utc(&mut self, amount: U128) {
        self.assert_owner();
        require!(amount.0 <= self.config.treasury_utc, "TreasuryInsufficient");
        self.config.treasury_utc -= amount.0;
        self.token_supply[TokenKind::Utc as usize] -= amount.0;
    }

    pub fn get_treasury(&self) -> near_sdk::serde_json::Value {
        json!({
            "revenue_near": U128(self.config.revenue_near),
            "treasury_utc": U128(self.config.treasury_utc),
            "sponsor_pool": U128(self.config.sponsor_pool),
        })
    }
}

impl Contract {
    fn modified(cur: &Ship, equipment: Equipment, accuracy: u8, hull: u8, speed: u8, variant: u16, shiny: bool) -> Ship {
        let mut n = cur.clone();
        n.equipment = equipment;
        n.traits.accuracy = accuracy;
        n.traits.hull = hull;
        n.traits.speed = speed;
        n.traits.variant = variant;
        n.ship_data.shiny = shiny;
        n
    }

    fn cost_to_modify(&self, cur: &Ship, new: &Ship) -> u128 {
        let base = self.config.price_tier(0).utc_price.0 / 5;
        modification_cost(base, cur.ship_data.modified, count_modifications(cur, new)).unwrap_or_else(|| env::panic_str("ArithmeticOverflow"))
    }

    pub(crate) fn internal_award_medal(&mut self, account: &AccountId) {
        let mut a = self.account(account);
        require!(!a.hive_medal, "AlreadyClaimed");
        a.hive_medal = true;
        self.put_account(account, a);
        self.config.medal_supply += 1;
        let payload = json!({ "standard": "nep245", "version": "1.0.0", "event": "mt_mint",
            "data": [{ "owner_id": account, "token_ids": [crate::tokens::HIVE_MEDAL], "amounts": ["1"] }] });
        env::log_str(&format!("EVENT_JSON:{payload}"));
    }
}

/// 32-byte hex ("0x" optional), e.g. nullifiers and blob ids.
pub(crate) fn parse_hash_pub(h: &str) -> [u8; 32] {
    parse_hash(h)
}

fn parse_hash(h: &str) -> [u8; 32] {
    let h = h.trim_start_matches("0x");
    require!(h.len() == 64, "InvalidNullifier");
    let mut out = [0u8; 32];
    for i in 0..32 {
        out[i] = u8::from_str_radix(&h[2 * i..2 * i + 2], 16).unwrap_or_else(|_| env::panic_str("InvalidNullifier"));
    }
    out
}

/// Test-only: set an account's purchased-ship count (e.g. so a receiver
/// contract passes the >= 10 transfer gate in sandbox tests).
#[cfg(feature = "test-hooks")]
#[near]
impl Contract {
    pub fn test_set_purchased(&mut self, account_id: AccountId, amount: U64) {
        self.assert_owner();
        let mut a = self.account(&account_id);
        a.amount_purchased = amount.0;
        self.put_account(&account_id, a);
    }
}

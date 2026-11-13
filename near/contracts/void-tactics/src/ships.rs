//! Human ships (Ships.sol) as NEP-171 tokens.
//!
//! Minting records an unconstructed ship plus a randomness request; the
//! resolution callback fixes the random value and constructs the ship
//! deterministically from it (GenerateNewShip). If construction can't finish
//! in the callback (e.g. the owner's storage balance can't cover the generated
//! name), the ship stays unconstructed and the owner calls `construct_ship`
//! later. The value never changes, so there is nothing to re-roll.
//!
//! Per-owner enumeration is a flat (owner, index) -> id map plus a count in
//! the owner's fixed-size `Account`, so no nested lazy collections can escape
//! storage measurement.

use std::collections::HashMap;

use near_contract_standards::non_fungible_token::metadata::{NFTContractMetadata, TokenMetadata, NFT_METADATA_SPEC};
use near_contract_standards::non_fungible_token::events::NftTransfer;
use near_contract_standards::non_fungible_token::Token;
use near_sdk::json_types::U64;
use near_sdk::serde_json::json;
use near_sdk::{env, near, require, AccountId, NearToken};
use vt_core::attributes::{count_modifications, kills_for_rank, ship_cost};
use vt_core::generation::generate_ship;
use vt_core::ship_names::OnchainShipNames;
use vt_core::types::Ship;

use crate::events;
use crate::{Contract, ContractExt};

/// AI ships use ids at and above this (AIShips.AI_SHIP_ID_OFFSET); human ship
/// ids are always below it.
pub const AI_SHIP_ID_OFFSET: u64 = 1 << 40;

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct ShipRecord {
    pub ship: Ship,
    pub owner: AccountId,
    /// Position in the owner's index.
    pub owner_index: u32,
}

#[near(serializers = [json])]
pub struct ShipView {
    pub ship: Ship,
    pub owner: AccountId,
}

impl Contract {
    pub(crate) fn ship_record(&self, id: u64) -> ShipRecord {
        self.ships.get(&id).cloned().unwrap_or_else(|| env::panic_str("ShipNotFound"))
    }

    fn index_add(&mut self, owner: &AccountId, id: u64) -> u32 {
        let mut a = self.account(owner);
        let idx = a.ship_count;
        a.ship_count += 1;
        self.put_account(owner, a);
        self.owner_ship_at.insert((owner.clone(), idx), id);
        idx
    }

    fn index_remove(&mut self, owner: &AccountId, idx: u32) {
        let mut a = self.account(owner);
        let last = a.ship_count - 1;
        if idx != last {
            let moved = *self.owner_ship_at.get(&(owner.clone(), last)).unwrap();
            self.owner_ship_at.insert((owner.clone(), idx), moved);
            let mut r = self.ship_record(moved);
            r.owner_index = idx;
            self.ships.insert(moved, r);
        }
        self.owner_ship_at.remove(&(owner.clone(), last));
        a.ship_count = last;
        self.put_account(owner, a);
    }

    /// VariantPurchaseGate.checkGate: gated variants need the medal.
    pub(crate) fn check_gate(&self, variant: u16, to: &AccountId) {
        if self.config.gated_variants.get(&variant).copied().unwrap_or(false) {
            require!(self.accounts.get(to).is_some_and(|a| a.hive_medal), "GateRequirementNotMet");
        }
    }

    /// Ships._mintShip (+ createShips' isFreeShip flag): an unconstructed ship.
    /// With `random_id`, construction is driven by that randomness request
    /// (caller schedules resolution); without, the caller customizes it
    /// immediately (createSpecificShip). Caller charges storage.
    pub(crate) fn internal_mint_ship(&mut self, to: &AccountId, variant: u16, kills: u32, is_free: bool, random_id: Option<u64>) -> u64 {
        self.internal_mint_ship_ex(to, variant, kills, is_free, random_id, false)
    }

    /// `gate_exempt`: VariantPurchaseGate.exemptMinter (roguelike ship grants).
    pub(crate) fn internal_mint_ship_ex(&mut self, to: &AccountId, variant: u16, kills: u32, is_free: bool, random_id: Option<u64>, gate_exempt: bool) -> u64 {
        require!(!self.config.mint_paused, "MintPaused");
        require!(variant != 0 && variant <= self.config.max_variant, "InvalidVariant");
        if !gate_exempt {
            self.check_gate(variant, to);
        }
        self.ship_count += 1;
        let id = self.ship_count;
        let mut ship = Ship { id, ..Default::default() };
        ship.traits.serial_number = random_id.unwrap_or(0);
        ship.traits.variant = variant;
        ship.ship_data.ships_destroyed = kills;
        ship.ship_data.is_free_ship = is_free;
        let owner_index = self.index_add(to, id);
        self.ships.insert(id, ShipRecord { ship, owner: to.clone(), owner_index });
        if let Some(r) = random_id {
            self.random_to_ship.insert(r, id);
        }
        id
    }

    /// Ships.createShips: `amount` ships with randomness; paid packs preset
    /// the first tier+1 ships' kills to ranks tier+1 down to 1. Returns
    /// (ship ids, random ids to schedule).
    pub(crate) fn internal_create_ships(&mut self, to: &AccountId, amount: u32, variant: u16, tier: u8, is_free: bool) -> (Vec<u64>, Vec<u64>) {
        let random_ids = self.internal_request_randomness(to, amount as usize);
        let rank_count = tier as u32 + 1;
        let ships = random_ids
            .iter()
            .enumerate()
            .map(|(i, &r)| {
                let kills = if !is_free && (i as u32) < rank_count { kills_for_rank((rank_count - i as u32) as u8) } else { 0 };
                self.internal_mint_ship(to, variant, kills, is_free, Some(r))
            })
            .collect();
        if !is_free {
            let mut a = self.account(to);
            a.amount_purchased += amount as u64;
            self.put_account(to, a);
        }
        (ships, random_ids)
    }

    /// Ships._applyShipCustomization: overwrite mutable fields from `new`,
    /// count modifications, mark constructed, re-price.
    pub(crate) fn apply_customization(&mut self, ship_id: u64, new: &Ship) {
        let mut rec = self.ship_record(ship_id);
        let s = &mut rec.ship;
        require!(s.ship_data.timestamp_destroyed == 0, "ShipDestroyed");
        require!(!s.ship_data.in_fleet, "ShipInFleet");
        let mods = count_modifications(s, new) as u16;
        s.name = new.name.clone();
        s.traits.accuracy = new.traits.accuracy;
        s.traits.hull = new.traits.hull;
        s.traits.speed = new.traits.speed;
        s.traits.variant = new.traits.variant;
        s.traits.colors = new.traits.colors.clone();
        s.equipment = new.equipment.clone();
        s.ship_data.ships_destroyed = new.ship_data.ships_destroyed;
        s.ship_data.is_free_ship = new.ship_data.is_free_ship;
        s.ship_data.shiny = new.ship_data.shiny;
        if s.ship_data.constructed {
            s.ship_data.modified = s.ship_data.modified.checked_add(mods).unwrap_or_else(|| env::panic_str("ArithmeticOverflow"));
        } else {
            s.ship_data.modified = mods;
            s.ship_data.constructed = true;
        }
        let costs = self.config.costs.get(&s.traits.variant).unwrap_or_else(|| env::panic_str("InvalidCostsVersion"));
        s.ship_data.costs_version = costs.version;
        s.ship_data.cost = ship_cost(costs, s).unwrap_or_else(|e| env::panic_str(e.name()));
        self.ships.insert(ship_id, rec);
        events::emit("metadata_update", json!({ "ship_id": U64(ship_id) }));
    }

    /// Ships.createSpecificShip: mint and customize atomically (no window for
    /// an outsider to grab a predicted id).
    pub(crate) fn internal_create_specific_ship(&mut self, to: &AccountId, template: &Ship) -> u64 {
        self.internal_create_specific_ship_ex(to, template, false)
    }

    pub(crate) fn internal_create_specific_ship_ex(&mut self, to: &AccountId, template: &Ship, gate_exempt: bool) -> u64 {
        let id = self.internal_mint_ship_ex(to, template.traits.variant, 0, template.ship_data.is_free_ship, None, gate_exempt);
        self.apply_customization(id, template);
        id
    }

    /// Removes a ship entirely (recycling burn). Caller refunds storage.
    pub(crate) fn internal_burn_ship(&mut self, ship_id: u64) {
        let rec = self.ship_record(ship_id);
        self.index_remove(&rec.owner, rec.owner_index);
        self.ships.remove(&ship_id);
    }

    /// Moves a ship and the prepaid deposit for its bytes from `from` to
    /// `to`. The sender pays: the receiver's available storage balance is
    /// unchanged, so nobody can fill a player's storage by spamming ships at
    /// them. Panics if the sender can't cover any growth (longer account id).
    pub(crate) fn internal_transfer_ship(&mut self, from: &AccountId, to: &AccountId, ship_id: u64, check_gates: bool) {
        let rec = self.ship_record(ship_id);
        require!(&rec.owner == from, "NotYourShip");
        require!(from != to, "SelfTransfer");
        self.assert_registered(to);
        require!(!rec.ship.ship_data.in_fleet, "ShipInFleet");
        if check_gates {
            require!(rec.ship.ship_data.timestamp_destroyed == 0, "ShipDestroyed");
            require!(self.account(from).amount_purchased >= 10, "InsufficientPurchases");
            require!(self.account(to).amount_purchased >= 10, "InsufficientPurchases");
        }
        let byte_cost = env::storage_byte_cost().as_yoctonear();

        self.flush_all();
        let before = env::storage_usage();
        self.index_remove(from, rec.owner_index);
        self.ships.remove(&ship_id);
        self.flush_all();
        let freed = before - env::storage_usage();

        let mut moved = rec.clone();
        moved.owner = to.clone();
        moved.owner_index = self.account(to).ship_count;
        self.index_add(to, ship_id);
        self.ships.insert(ship_id, moved);
        self.flush_all();
        let added = env::storage_usage() - (before - freed);

        let mut src = self.account(from);
        src.used_bytes -= freed;
        let pay = NearToken::from_yoctonear(added as u128 * byte_cost);
        // The sender's freed bytes unlock their deposit; the moved bytes' cost
        // leaves with the ship. Their remaining storage must stay covered.
        require!(src.deposit >= pay, "InsufficientStorageBalance");
        src.deposit = src.deposit.saturating_sub(pay);
        require!(src.deposit >= src.locked(), "InsufficientStorageBalance");
        self.put_account(from, src);
        let mut dst = self.account(to);
        dst.used_bytes += added;
        dst.deposit = dst.deposit.saturating_add(pay);
        self.put_account(to, dst);
        NftTransfer { old_owner_id: from, new_owner_id: to, token_ids: &[&ship_id.to_string()], authorized_id: None, memo: None }.emit();
    }

    /// Ships.constructShip from a resolved random value. Never panics: returns
    /// the reason construction was skipped.
    pub(crate) fn try_construct(&mut self, ship_id: u64, random_value: u64, charge: bool) -> Result<(), &'static str> {
        let Some(mut rec) = self.ships.get(&ship_id).cloned() else { return Err("ShipNotFound") };
        if rec.ship.ship_data.constructed {
            return Err("ShipConstructed");
        }
        let s = &rec.ship;
        let variant = s.traits.variant;
        let generated = generate_ship(ship_id, s.traits.serial_number, random_value, variant, self.config.max_special_slot_of(variant), &OnchainShipNames);
        let mut ship = rec.ship.clone();
        ship.name = generated.name;
        ship.traits = generated.traits;
        ship.equipment = generated.equipment;
        ship.ship_data.shiny = generated.ship_data.shiny;
        if ship.ship_data.ships_destroyed == 0 {
            ship.ship_data.ships_destroyed = generated.ship_data.ships_destroyed;
        }
        ship.ship_data.constructed = true;
        // _setCostOfShip
        let Some(costs) = self.config.costs.get(&variant) else { return Err("InvalidCostsVersion") };
        ship.ship_data.costs_version = costs.version;
        ship.ship_data.cost = ship_cost(costs, &ship).map_err(|e| e.name())?;

        if charge {
            let old_len = near_sdk::borsh::to_vec(&rec).unwrap().len() as u64;
            let new_rec = ShipRecord { ship: ship.clone(), ..rec.clone() };
            let new_len = near_sdk::borsh::to_vec(&new_rec).unwrap().len() as u64;
            if new_len > old_len && !self.try_reserve_bytes(&rec.owner, new_len - old_len) {
                return Err("InsufficientStorageBalance");
            }
        }
        rec.ship = ship;
        self.ships.insert(ship_id, rec);
        Ok(())
    }

    pub(crate) fn mark_destroyed(&mut self, ship_id: u64, now: u64) {
        if let Some(mut r) = self.ships.get(&ship_id).cloned() {
            if r.ship.ship_data.timestamp_destroyed == 0 {
                r.ship.ship_data.timestamp_destroyed = now.max(1);
                self.ships.insert(ship_id, r);
            }
        }
    }

    pub(crate) fn set_in_fleet(&mut self, ship_id: u64, in_fleet: bool) {
        let mut r = self.ship_record(ship_id);
        if in_fleet {
            require!(r.ship.ship_data.timestamp_destroyed == 0, "ShipDestroyed");
        }
        r.ship.ship_data.in_fleet = in_fleet;
        self.ships.insert(ship_id, r);
    }

    fn to_token(&self, id: u64, r: &ShipRecord) -> Token {
        let ship_json = near_sdk::serde_json::to_string(&r.ship).unwrap();
        Token {
            token_id: id.to_string(),
            owner_id: r.owner.clone(),
            metadata: Some(TokenMetadata {
                title: Some(if r.ship.name.is_empty() { format!("Unconstructed ship #{id}") } else { r.ship.name.clone() }),
                description: None,
                // Relative to nft_metadata().base_uri when one is set.
                media: self.config.settings.get(&crate::config::SETTING_NFT_BASE_URI).map(|_| id.to_string()),
                media_hash: None,
                copies: Some(1),
                issued_at: None,
                expires_at: None,
                starts_at: None,
                updated_at: None,
                extra: Some(ship_json),
                reference: None,
                reference_hash: None,
            }),
            approved_account_ids: Some(HashMap::new()),
        }
    }
}

#[near]
impl Contract {
    /// Builds an unconstructed ship whose randomness is resolved but whose
    /// callback couldn't finish (see module docs). Owner only.
    pub fn construct_ship(&mut self, ship_id: U64) {
        let caller = env::predecessor_account_id();
        let rec = self.ship_record(ship_id.0);
        require!(rec.owner == caller, "NotYourShip");
        let req = self
            .random_requests
            .get(&rec.ship.traits.serial_number)
            .cloned()
            .unwrap_or_else(|| env::panic_str("RandomRequestNotFound"));
        require!(req.is_resolved(), "TooSoonToReveal");
        let initial = env::storage_usage();
        if let Err(e) = self.try_construct(ship_id.0, req.value, false) {
            env::panic_str(e);
        }
        self.charge_storage_since(&caller, initial);
        events::emit("ship_constructed", json!({ "ship_id": ship_id }));
    }

    // ---- NEP-171 core transfers ----

    /// Ship transfer. Ships in a fleet or destroyed can't move, and both sides
    /// need >= 10 purchased ships (Ships._update). Approvals (NEP-178) are not
    /// supported. The receiver must be registered; the sender pays for the
    /// moved bytes (see internal_transfer_ship).
    #[payable]
    pub fn nft_transfer(&mut self, receiver_id: AccountId, token_id: String, approval_id: Option<u64>, memo: Option<String>) {
        near_sdk::assert_one_yocto();
        require!(approval_id.is_none(), "ApprovalsUnsupported");
        let _ = memo;
        let id: u64 = token_id.parse().unwrap_or_else(|_| env::panic_str("ShipNotFound"));
        self.internal_transfer_ship(&env::predecessor_account_id(), &receiver_id, id, true);
    }

    /// NEP-171 transfer_call: the receiver's `nft_on_transfer` may ask for the
    /// ship back (returns true); `nft_resolve_transfer` then returns it if it
    /// still can. A hostile receiver (panics, burns gas, returns junk) leaves
    /// the ship with the receiver, never lost or duplicated.
    #[payable]
    pub fn nft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        token_id: String,
        approval_id: Option<u64>,
        memo: Option<String>,
        msg: String,
    ) -> near_sdk::PromiseOrValue<bool> {
        near_sdk::assert_one_yocto();
        require!(approval_id.is_none(), "ApprovalsUnsupported");
        let _ = memo;
        require!(env::prepaid_gas().as_tgas() >= 50, "NotEnoughGas");
        let sender = env::predecessor_account_id();
        let id: u64 = token_id.parse().unwrap_or_else(|_| env::panic_str("ShipNotFound"));
        self.internal_transfer_ship(&sender, &receiver_id, id, true);
        near_sdk::Promise::new(receiver_id.clone())
            .function_call(
                "nft_on_transfer".to_string(),
                json!({ "sender_id": sender, "previous_owner_id": sender, "token_id": token_id, "msg": msg }).to_string().into_bytes(),
                NearToken::from_yoctonear(0),
                near_sdk::Gas::from_tgas(env::prepaid_gas().as_tgas().saturating_sub(30).min(200)),
            )
            .then(
                near_sdk::Promise::new(env::current_account_id()).function_call(
                    "nft_resolve_transfer".to_string(),
                    json!({ "previous_owner_id": sender, "receiver_id": receiver_id, "token_id": token_id }).to_string().into_bytes(),
                    NearToken::from_yoctonear(0),
                    near_sdk::Gas::from_tgas(15),
                ),
            )
            .into()
    }

    /// Returns true if the ship stays with the receiver. Never panics.
    #[private]
    pub fn nft_resolve_transfer(&mut self, previous_owner_id: AccountId, receiver_id: AccountId, token_id: String) -> bool {
        // Read at most 16 bytes: a hostile receiver can't make us pay to load
        // a huge return value.
        let wants_return = match env::promise_result_checked(0, 16) {
            Ok(bytes) => near_sdk::serde_json::from_slice::<bool>(&bytes).unwrap_or(false),
            // Receiver panicked, ran out of gas, or returned junk too long to
            // read: NEP-171 returns the token.
            Err(_) => true,
        };
        if !wants_return {
            return true;
        }
        let Ok(id) = token_id.parse::<u64>() else { return true };
        let Some(rec) = self.ships.get(&id).cloned() else { return true };
        // Only undo if the receiver still holds it, unlocked, and the
        // previous owner can still receive it.
        if rec.owner != receiver_id || rec.ship.ship_data.in_fleet || !self.accounts.contains_key(&previous_owner_id) {
            return true;
        }
        let rec_bytes = near_sdk::borsh::to_vec(&rec).unwrap().len() as u64 + 128;
        if self.accounts.get(&receiver_id).is_none_or(|a| a.deposit.as_yoctonear() < (a.used_bytes + rec_bytes) as u128 * env::storage_byte_cost().as_yoctonear()) {
            return true;
        }
        self.internal_transfer_ship(&receiver_id, &previous_owner_id, id, false);
        false
    }

    // ------------------------------------------------------------- views

    pub fn get_ship(&self, ship_id: U64) -> Option<ShipView> {
        self.ships.get(&ship_id.0).map(|r| ShipView { ship: r.ship.clone(), owner: r.owner.clone() })
    }

    pub fn get_ships_for_owner(&self, account_id: AccountId, from_index: Option<u32>, limit: Option<u32>) -> Vec<ShipView> {
        let count = self.accounts.get(&account_id).map_or(0, |a| a.ship_count);
        let from = from_index.unwrap_or(0);
        let limit = limit.unwrap_or(50).min(100);
        (from..count.min(from.saturating_add(limit)))
            .filter_map(|i| self.owner_ship_at.get(&(account_id.clone(), i)))
            .filter_map(|id| self.ships.get(id))
            .map(|r| ShipView { ship: r.ship.clone(), owner: r.owner.clone() })
            .collect()
    }

    // ---- NEP-171 core / enumeration / metadata (views) ----

    pub fn nft_token(&self, token_id: String) -> Option<Token> {
        let id: u64 = token_id.parse().ok()?;
        self.ships.get(&id).map(|r| self.to_token(id, r))
    }

    pub fn nft_total_supply(&self) -> near_sdk::json_types::U128 {
        (self.ship_count as u128).into()
    }

    pub fn nft_tokens(&self, from_index: Option<near_sdk::json_types::U128>, limit: Option<u64>) -> Vec<Token> {
        let from = from_index.map_or(1, |f| f.0 as u64 + 1);
        let limit = limit.unwrap_or(50).min(100);
        (from..=self.ship_count.min(from.saturating_add(limit) - 1))
            .filter_map(|id| self.ships.get(&id).map(|r| self.to_token(id, r)))
            .collect()
    }

    pub fn nft_supply_for_owner(&self, account_id: AccountId) -> near_sdk::json_types::U128 {
        (self.accounts.get(&account_id).map_or(0, |a| a.ship_count) as u128).into()
    }

    pub fn nft_tokens_for_owner(&self, account_id: AccountId, from_index: Option<near_sdk::json_types::U128>, limit: Option<u64>) -> Vec<Token> {
        let count = self.accounts.get(&account_id).map_or(0, |a| a.ship_count);
        let from = from_index.map_or(0, |f| f.0 as u32);
        let limit = limit.unwrap_or(50).min(100) as u32;
        (from..count.min(from.saturating_add(limit)))
            .filter_map(|i| self.owner_ship_at.get(&(account_id.clone(), i)).copied())
            .filter_map(|id| self.ships.get(&id).map(|r| self.to_token(id, r)))
            .collect()
    }

    pub fn nft_metadata(&self) -> NFTContractMetadata {
        NFTContractMetadata {
            spec: NFT_METADATA_SPEC.to_string(),
            name: "Void Tactics Ships".to_string(),
            symbol: "SHIP".to_string(),
            icon: None,
            base_uri: self.config.settings.get(&crate::config::SETTING_NFT_BASE_URI).cloned(),
            reference: None,
            reference_hash: None,
        }
    }
}

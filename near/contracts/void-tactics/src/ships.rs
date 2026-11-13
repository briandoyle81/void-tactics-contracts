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
use near_contract_standards::non_fungible_token::Token;
use near_sdk::json_types::U64;
use near_sdk::serde_json::json;
use near_sdk::{env, near, require, AccountId};
use vt_core::attributes::ship_cost;
use vt_core::generation::{generate_ship, StubShipNamer};
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

    #[allow(dead_code)] // used by transfers/recycling (Phase 2)
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

    /// Ships._mintShip (+ createShips' isFreeShip flag): an unconstructed ship
    /// whose randomness is request `random_id`. Caller schedules resolution and
    /// charges storage.
    pub(crate) fn internal_mint_ship(&mut self, to: &AccountId, variant: u16, kills: u32, is_free: bool, random_id: u64) -> u64 {
        require!(!self.config.mint_paused, "MintPaused");
        require!(variant != 0 && variant <= self.config.max_variant, "InvalidVariant");
        self.ship_count += 1;
        let id = self.ship_count;
        let mut ship = Ship { id, ..Default::default() };
        ship.traits.serial_number = random_id;
        ship.traits.variant = variant;
        ship.ship_data.ships_destroyed = kills;
        ship.ship_data.is_free_ship = is_free;
        let owner_index = self.index_add(to, id);
        self.ships.insert(id, ShipRecord { ship, owner: to.clone(), owner_index });
        self.random_to_ship.insert(random_id, id);
        id
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
        let generated = generate_ship(ship_id, s.traits.serial_number, random_value, variant, self.config.max_special_slot_of(variant), &StubShipNamer);
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
                media: None,
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
            base_uri: None,
            reference: None,
            reference_hash: None,
        }
    }
}

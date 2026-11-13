//! Rules configuration: versioned attribute tables and costs (ShipAttributes),
//! resolver wiring and heal cap (Game), reward tokens (FactionRewardToken-
//! Registry), and economy knobs. Implements vt-core's `Rules` so the engine and
//! AI read it directly.

use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{near, require};
use vt_core::attributes::{validate_attributes, validate_costs};
use vt_core::effects::Resolver;
use vt_core::engine::Rules;
use vt_core::types::{Costs, Special, SpecialData, VariantAttributeData};
use vt_core::Error;

use crate::{Contract, ContractExt, OrPanic, StorageKey};

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TokenKind {
    Utc,
    Dec,
}

#[near(serializers = [borsh])]
pub struct ConfigState {
    pub attr_tables: LookupMap<(u16, u16), VariantAttributeData>,
    pub attr_current: LookupMap<u16, u16>,
    pub attr_latest: LookupMap<u16, u16>,
    pub costs: LookupMap<u16, Costs>,
    pub max_special_slot: LookupMap<u16, u8>,
    pub faction_resolvers: LookupMap<u16, Resolver>,
    pub special_resolvers: LookupMap<(u16, u8), Resolver>,
    pub reward_token: LookupMap<u16, TokenKind>,
    /// DroneStorefront.tierCoreCost, indexed by tier.
    pub storefront_tiers: LookupMap<u8, u32>,
    pub storefront_tier_count: u8,
    pub heal_cap_percent: u8,
    /// ShipsRouter.factionKillReward (whole cores; DEC has 0 decimals).
    pub faction_kill_reward: u128,
    pub max_variant: u16,
    pub mint_paused: bool,
    /// FreeShipClaim.claimCooldownPeriod (seconds).
    pub claim_cooldown_s: u64,
    pub free_claim_base: u32,
}

impl ConfigState {
    pub fn new() -> Self {
        Self {
            attr_tables: LookupMap::new(StorageKey::AttrTables),
            attr_current: LookupMap::new(StorageKey::AttrCurrent),
            attr_latest: LookupMap::new(StorageKey::AttrLatest),
            costs: LookupMap::new(StorageKey::Costs),
            max_special_slot: LookupMap::new(StorageKey::MaxSpecialSlot),
            faction_resolvers: LookupMap::new(StorageKey::FactionResolvers),
            special_resolvers: LookupMap::new(StorageKey::SpecialResolvers),
            reward_token: LookupMap::new(StorageKey::RewardToken),
            storefront_tiers: LookupMap::new(StorageKey::StorefrontTiers),
            storefront_tier_count: 0,
            heal_cap_percent: 80,
            faction_kill_reward: 1,
            max_variant: 1,
            mint_paused: false,
            claim_cooldown_s: 28 * 24 * 60 * 60,
            free_claim_base: 10,
        }
    }

    pub fn flush(&mut self) {
        self.attr_tables.flush();
        self.attr_current.flush();
        self.attr_latest.flush();
        self.costs.flush();
        self.max_special_slot.flush();
        self.faction_resolvers.flush();
        self.special_resolvers.flush();
        self.reward_token.flush();
        self.storefront_tiers.flush();
    }

    /// Current (version, table) for a variant: VariantNotConfigured if never
    /// published.
    pub fn current_table(&self, variant: u16) -> vt_core::Result<(u16, &VariantAttributeData)> {
        let v = self.attr_current.get(&variant).copied().unwrap_or(0);
        if v == 0 {
            return Err(Error::VariantNotConfigured);
        }
        Ok((v, self.attr_tables.get(&(variant, v)).expect("published")))
    }

    pub fn max_special_slot_of(&self, variant: u16) -> u8 {
        self.max_special_slot.get(&variant).copied().unwrap_or(0)
    }
}

impl Default for ConfigState {
    fn default() -> Self {
        Self::new()
    }
}

impl Rules for ConfigState {
    fn faction_resolver(&self, variant: u16) -> Option<Resolver> {
        self.faction_resolvers.get(&variant).copied()
    }
    fn special_resolver(&self, variant: u16, slot: Special) -> Option<Resolver> {
        self.special_resolvers.get(&(variant, slot as u8)).copied()
    }
    fn special_data_at(&self, variant: u16, version: u16, slot: Special) -> vt_core::Result<SpecialData> {
        let latest = self.attr_latest.get(&variant).copied().unwrap_or(0);
        if version == 0 || version > latest {
            return Err(Error::InvalidAttributesVersion);
        }
        Ok(self.attr_tables.get(&(variant, version)).expect("published").specials[slot.index()].clone())
    }
}

#[near]
impl Contract {
    /// ShipAttributes.setVariantAttributes: publishes latest + 1 and makes it
    /// live. Published versions are immutable (games pin them).
    pub fn publish_variant_attributes(&mut self, variant: u16, data: VariantAttributeData) -> u16 {
        self.assert_owner();
        validate_attributes(&data).or_panic();
        let c = &mut self.config;
        let v = c.attr_latest.get(&variant).copied().unwrap_or(0) + 1;
        c.attr_tables.insert((variant, v), data);
        c.attr_latest.insert(variant, v);
        c.attr_current.insert(variant, v);
        v
    }

    pub fn set_current_attributes_version(&mut self, variant: u16, version: u16) {
        self.assert_owner();
        let latest = self.config.attr_latest.get(&variant).copied().unwrap_or(0);
        require!(version != 0 && version <= latest, "InvalidAttributesVersion");
        self.config.attr_current.insert(variant, version);
    }

    /// ShipAttributes.setCosts: version is always previous + 1.
    pub fn set_costs(&mut self, variant: u16, costs: Costs) -> u16 {
        let mut costs = costs;
        self.assert_owner();
        validate_costs(&costs).or_panic();
        costs.version = self.config.costs.get(&variant).map_or(0, |c| c.version) + 1;
        let v = costs.version;
        self.config.costs.insert(variant, costs);
        v
    }

    pub fn set_max_special_slot(&mut self, variant: u16, slot: u8) {
        self.assert_owner();
        require!(slot <= 7, "InvalidSlot");
        self.config.max_special_slot.insert(variant, slot);
    }

    pub fn set_faction_resolver(&mut self, variant: u16, resolver: Option<Resolver>) {
        self.assert_owner();
        match resolver {
            Some(r) => self.config.faction_resolvers.insert(variant, r),
            None => self.config.faction_resolvers.remove(&variant),
        };
    }

    pub fn set_special_resolver(&mut self, variant: u16, slot: Special, resolver: Option<Resolver>) {
        self.assert_owner();
        match resolver {
            Some(r) => self.config.special_resolvers.insert((variant, slot as u8), r),
            None => self.config.special_resolvers.remove(&(variant, slot as u8)),
        };
    }

    pub fn set_heal_cap_percent(&mut self, percent: u8) {
        self.assert_owner();
        require!(percent <= 100, "InvalidHealCapPercent");
        self.config.heal_cap_percent = percent;
    }

    pub fn set_reward_token(&mut self, variant: u16, token: Option<TokenKind>) {
        self.assert_owner();
        match token {
            Some(t) => self.config.reward_token.insert(variant, t),
            None => self.config.reward_token.remove(&variant),
        };
    }

    pub fn set_faction_kill_reward(&mut self, amount: U128) {
        self.assert_owner();
        self.config.faction_kill_reward = amount.0;
    }

    pub fn set_max_variant(&mut self, max_variant: u16) {
        self.assert_owner();
        self.config.max_variant = max_variant;
    }

    pub fn set_mint_paused(&mut self, paused: bool) {
        self.assert_role(crate::roles::PAUSER);
        self.config.mint_paused = paused;
    }

    pub fn set_claim_config(&mut self, cooldown_s: u64, base_ships: u32) {
        self.assert_owner();
        self.config.claim_cooldown_s = cooldown_s;
        self.config.free_claim_base = base_ships;
    }

    /// DroneStorefront.addTier (append-only).
    pub fn add_storefront_tier(&mut self, core_cost: u32) {
        self.assert_owner();
        let c = &mut self.config;
        require!(c.storefront_tier_count < u8::MAX, "TooManyTiers");
        c.storefront_tiers.insert(c.storefront_tier_count, core_cost);
        c.storefront_tier_count += 1;
    }

    // ---------------------------------------------------------------- views

    /// version 0 = the variant's current version.
    pub fn get_variant_attributes(&self, variant: u16, version: u16) -> Option<VariantAttributeData> {
        let v = if version == 0 { self.config.attr_current.get(&variant).copied().unwrap_or(0) } else { version };
        self.config.attr_tables.get(&(variant, v)).cloned()
    }

    pub fn get_current_attributes_version(&self, variant: u16) -> u16 {
        self.config.attr_current.get(&variant).copied().unwrap_or(0)
    }

    pub fn get_costs(&self, variant: u16) -> Option<Costs> {
        self.config.costs.get(&variant).cloned()
    }

    pub fn get_max_special_slot(&self, variant: u16) -> u8 {
        self.config.max_special_slot_of(variant)
    }

    pub fn get_faction_resolver(&self, variant: u16) -> Option<Resolver> {
        self.config.faction_resolver(variant)
    }

    pub fn get_special_resolver(&self, variant: u16, slot: Special) -> Option<Resolver> {
        self.config.special_resolver(variant, slot)
    }

    pub fn get_storefront_tiers(&self) -> Vec<u32> {
        (0..self.config.storefront_tier_count).map(|i| *self.config.storefront_tiers.get(&i).unwrap()).collect()
    }
}

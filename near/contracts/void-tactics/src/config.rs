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

/// One purchase tier. The three prices are DIFFERENT currencies and must
/// never share a field (the 2026-10-23 exploit: one array served both).
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct PriceTier {
    pub ships: u8,
    /// ShipPurchaser.tierPrices: UTC (18 dec) for a pack.
    pub utc_price: U128,
    /// Ships.tierPrices: yoctoNEAR for a pack bought directly.
    pub near_ship_price: U128,
    /// ShipPurchaser.flowTierPrices: yoctoNEAR to buy `utc_price` UTC.
    pub near_utc_price: U128,
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
    // ---- Phase 2 ----
    pub price_tiers: LookupMap<u8, PriceTier>,
    pub price_tier_count: u8,
    /// Ships.recycleReward (UTC, 18 dec).
    pub recycle_reward: u128,
    /// VariantPurchaseGate: variants that require the Shattered Hive medal.
    pub gated_variants: LookupMap<u16, bool>,
    /// ShatteredHiveMedal.finalNodeId (0 = unset).
    pub medal_final_node: u64,
    pub free_claim_requires_verification: bool,
    pub tutorial_requires_verification: bool,
    pub nullifier_check_enabled: bool,
    /// Owner-funded pool the SPONSOR role draws from.
    pub sponsor_pool: u128,
    pub sponsor_cap_per_account: u128,
    /// UTC collected by purchases and DroneYard (ECON-07: owner burns/withdraws).
    pub treasury_utc: u128,
    /// NEAR revenue withdrawable by the owner (never storage-staked funds).
    pub revenue_near: u128,
    pub medal_supply: u64,
    /// Owner-set strings (renderer account, NFT base URI); kept out of the
    /// root struct so it stays fixed-size.
    pub settings: LookupMap<u8, String>,
}

pub const SETTING_RENDERER: u8 = 0;
pub const SETTING_NFT_BASE_URI: u8 = 1;

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
            price_tiers: LookupMap::new(StorageKey::PriceTiers),
            price_tier_count: 0,
            recycle_reward: 100_000_000_000_000_000, // 0.1 UTC
            gated_variants: LookupMap::new(StorageKey::GatedVariants),
            medal_final_node: 0,
            free_claim_requires_verification: false,
            tutorial_requires_verification: false,
            nullifier_check_enabled: true,
            sponsor_pool: 0,
            sponsor_cap_per_account: 100_000_000_000_000_000_000_000, // 0.1 NEAR
            treasury_utc: 0,
            revenue_near: 0,
            medal_supply: 0,
            settings: LookupMap::new(StorageKey::Settings),
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
        self.price_tiers.flush();
        self.gated_variants.flush();
        self.settings.flush();
    }

    pub fn price_tier(&self, tier: u8) -> &PriceTier {
        self.price_tiers.get(&tier).unwrap_or_else(|| near_sdk::env::panic_str("InvalidTier"))
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

    /// Ships.setPurchaseInfo + ShipPurchaser.setPurchaseInfo/setFlowTierPrices
    /// in one call (full replace).
    pub fn set_price_tiers(&mut self, tiers: Vec<PriceTier>) {
        self.assert_owner();
        require!(tiers.len() <= u8::MAX as usize, "TooManyTiers");
        for (i, t) in tiers.iter().enumerate() {
            self.config.price_tiers.insert(i as u8, t.clone());
        }
        for i in tiers.len()..self.config.price_tier_count as usize {
            self.config.price_tiers.remove(&(i as u8));
        }
        self.config.price_tier_count = tiers.len() as u8;
    }

    pub fn set_recycle_reward(&mut self, amount: U128) {
        self.assert_owner();
        self.config.recycle_reward = amount.0;
    }

    /// VariantPurchaseGate.setRequiredNft (the only gate NFT is the medal).
    pub fn set_variant_gated(&mut self, variant: u16, requires_medal: bool) {
        self.assert_owner();
        if requires_medal {
            self.config.gated_variants.insert(variant, true);
        } else {
            self.config.gated_variants.remove(&variant);
        }
    }

    pub fn set_medal_final_node(&mut self, node_id: near_sdk::json_types::U64) {
        self.assert_owner();
        self.config.medal_final_node = node_id.0;
    }

    pub fn set_verification_requirements(&mut self, free_claim: bool, tutorial: bool, nullifier_check: bool) {
        self.assert_owner();
        self.config.free_claim_requires_verification = free_claim;
        self.config.tutorial_requires_verification = tutorial;
        self.config.nullifier_check_enabled = nullifier_check;
    }

    pub fn set_sponsor_cap_per_account(&mut self, amount: U128) {
        self.assert_owner();
        self.config.sponsor_cap_per_account = amount.0;
    }

    /// The void-renderer contract clients call for ship art/metadata, and the
    /// NEP-177 base_uri (a gateway serving `<base_uri>/<token_id>` by calling
    /// `nft_token` here and `token_uri` on the renderer).
    pub fn set_render_config(&mut self, renderer: Option<near_sdk::AccountId>, nft_base_uri: Option<String>) {
        self.assert_owner();
        for (k, v) in [(SETTING_RENDERER, renderer.map(|a| a.to_string())), (SETTING_NFT_BASE_URI, nft_base_uri)] {
            match v {
                Some(v) => self.config.settings.insert(k, v),
                None => self.config.settings.remove(&k),
            };
        }
    }

    pub fn get_renderer(&self) -> Option<String> {
        self.config.settings.get(&SETTING_RENDERER).cloned()
    }

    // ---------------------------------------------------------------- views

    pub fn get_price_tiers(&self) -> Vec<PriceTier> {
        (0..self.config.price_tier_count).map(|i| self.config.price_tier(i).clone()).collect()
    }

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

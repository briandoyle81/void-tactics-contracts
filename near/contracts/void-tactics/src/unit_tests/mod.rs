//! Contract unit tests (near-sdk `testing_env!`): fast, single-process,
//! ported from the Hardhat suite where the behavior carries over.
//!
//! Note: unlike the real runtime, a panic here does NOT roll back storage
//! writes, so every expected-failure case is its own `#[should_panic]` test.

mod phase2;
mod pvp;
mod roguelike;

use near_sdk::json_types::U64;
use near_sdk::serde_json::{self, Value};
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{testing_env, AccountId, NearToken};
use near_contract_standards::storage_management::StorageManagement;
use vt_core::effects::Resolver;
use vt_core::types::*;

use crate::config::{PriceTier, TokenKind};
use crate::Contract;

pub const GAME: &str = "game.near";
pub const OWNER: &str = "owner.near";
pub const E18: u128 = 1_000_000_000_000_000_000;
pub const ONE_NEAR: u128 = 1_000_000_000_000_000_000_000_000;

pub fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn read_config() -> Value {
    let p = concat!(env!("CARGO_MANIFEST_DIR"), "/../../seed/config.json");
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

fn attribute_table(v: &Value) -> VariantAttributeData {
    let n = |x: &Value| x.as_i64().unwrap_or_else(|| x.as_str().unwrap().parse().unwrap());
    let u8s = |k: &str| v[k].as_array().unwrap().iter().map(|x| n(x) as u8).collect::<Vec<_>>();
    VariantAttributeData {
        base_hull: n(&v["baseHull"]) as u8,
        base_speed: n(&v["baseSpeed"]) as u8,
        fore_accuracy: u8s("foreAccuracy"),
        hull: u8s("hull"),
        engine_speeds: u8s("engineSpeeds"),
        guns: v["guns"].as_array().unwrap().iter().map(|g| GunData { range: n(&g["range"]) as u8, damage: n(&g["damage"]) as u8, movement: n(&g["movement"]) as i8 }).collect(),
        armors: v["armors"].as_array().unwrap().iter().map(|a| ArmorData { damage_reduction: n(&a["damageReduction"]) as u8, movement: n(&a["movement"]) as i8 }).collect(),
        shields: v["shields"].as_array().unwrap().iter().map(|a| ShieldData { damage_reduction: n(&a["damageReduction"]) as u8, movement: n(&a["movement"]) as i8 }).collect(),
        specials: v["specials"].as_array().unwrap().iter().map(|s| SpecialData { range: n(&s["range"]) as u8, strength: n(&s["strength"]) as u8, movement: n(&s["movement"]) as i8 }).collect(),
        rank_thresholds: v["rankThresholds"].as_array().unwrap().iter().map(|x| n(x) as u32).collect(),
        rank_bonus_pct: u8s("rankBonusPct"),
    }
}

fn costs(v: &Value) -> Costs {
    let u8s = |k: &str| v[k].as_array().unwrap().iter().map(|x| x.as_u64().unwrap() as u8).collect::<Vec<_>>();
    Costs {
        version: 0,
        base_cost: v["baseCost"].as_u64().unwrap() as u8,
        accuracy: u8s("accuracy"),
        hull: u8s("hull"),
        speed: u8s("speed"),
        main_weapon: u8s("mainWeapon"),
        armor: u8s("armor"),
        shields: u8s("shields"),
        special: u8s("special"),
    }
}

/// Default tiers: Solidity's pack sizes and UTC prices; native prices use the
/// same numbers in NEAR (the Flow deploy priced 1:1 too).
pub fn default_tiers() -> Vec<PriceTier> {
    let prices = [499u128, 999, 1999, 3499, 4999]; // hundredths
    [5u8, 11, 22, 40, 60]
        .iter()
        .zip(prices)
        .map(|(&ships, p)| PriceTier {
            ships,
            utc_price: (p * E18 / 100).into(),
            near_ship_price: (p * ONE_NEAR / 100).into(),
            near_utc_price: (p * ONE_NEAR / 100).into(),
        })
        .collect()
}

pub struct H {
    pub c: Contract,
    pub now_s: u64,
    seed: u8,
}

fn set_ctx(who: &str, deposit: u128, now_s: u64, seed: u8) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(acc(GAME))
        .predecessor_account_id(acc(who))
        .signer_account_id(acc(who))
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .block_timestamp(now_s * 1_000_000_000)
        .block_height(now_s)
        .random_seed([seed; 32])
        .prepaid_gas(near_sdk::Gas::from_tgas(300))
        .build());
}

impl H {
    pub fn ctx(&mut self, who: &str, deposit: u128) {
        self.seed = self.seed.wrapping_add(1);
        set_ctx(who, deposit, self.now_s, self.seed);
    }

    /// Deployed + rules seeded from near/seed/config.json.
    pub fn new() -> H {
        let now_s = 1_800_000_000;
        set_ctx(OWNER, 0, now_s, 0);
        let mut h = H { c: Contract::new(acc(OWNER)), now_s, seed: 0 };
        let cfg = read_config();
        for (variant, v) in cfg["variants"].as_object().unwrap() {
            let variant: u16 = variant.parse().unwrap();
            for t in v["attributeVersions"].as_array().unwrap() {
                h.c.publish_variant_attributes(variant, attribute_table(t));
            }
            h.c.set_costs(variant, costs(&v["costs"]));
            h.c.set_max_special_slot(variant, v["maxSpecialSlot"].as_u64().unwrap() as u8);
        }
        h.c.set_faction_resolver(1, Some(Resolver::Ram { range: 1 }));
        h.c.set_faction_resolver(2, Some(Resolver::Repair { range: 1, strength: 50 }));
        h.c.set_reward_token(2, Some(TokenKind::Dec));
        h.c.set_max_variant(2);
        h.c.set_variant_gated(2, true);
        h.c.set_price_tiers(default_tiers());
        for t in cfg["storefrontTiers"].as_array().unwrap() {
            h.c.add_storefront_tier(t.as_u64().unwrap() as u32);
        }
        h
    }

    pub fn register(&mut self, who: &str, near: u128) {
        self.ctx(who, near * ONE_NEAR);
        self.c.storage_deposit(None, None);
    }

    /// Runs the randomness self-callback for every pending request.
    pub fn resolve_all(&mut self) {
        self.now_s += 1;
        self.ctx(GAME, 0);
        let ids: Vec<U64> = (1..self.c.next_random_id).filter(|i| self.c.random_requests.get(i).is_some_and(|r| !r.is_resolved())).map(U64).collect();
        self.c.resolve_randomness(ids);
    }

    pub fn mint(&mut self, who: &str, kind: TokenKind, amount: u128) {
        assert!(self.c.try_mint(&acc(who), kind, amount));
    }

    pub fn utc(&self, who: &str) -> u128 {
        self.c.accounts.get(&acc(who)).map_or(0, |a| a.utc)
    }

    pub fn ship(&self, id: u64) -> crate::ships::ShipRecord {
        self.c.ships.get(&id).cloned().unwrap()
    }

    pub fn owned(&self, who: &str) -> Vec<u64> {
        self.c.get_ships_for_owner(acc(who), None, Some(100)).iter().map(|v| v.ship.id).collect()
    }

    /// Buys `packs` tier-0 packs with NEAR (5 ships each) and constructs them.
    pub fn buy_and_build(&mut self, who: &str, tier: u8, packs: u32) -> Vec<u64> {
        let price = self.c.get_price_tiers()[tier as usize].near_ship_price.0;
        let mut ids = vec![];
        for _ in 0..packs {
            self.ctx(who, price);
            ids.extend(self.c.purchase_ships_with_near(tier, None, 1).into_iter().map(|i| i.0));
        }
        self.resolve_all();
        ids
    }
}


//! Void Tactics renderer: on-chain ship art (SVG) and NFT metadata, as pure
//! views over a ship passed in by the caller. A NEAR view can't call another
//! contract, so clients (or a `base_uri` gateway) read the ship from the game
//! contract (`nft_token` / `get_ship`) and pass it here; anyone can reproduce
//! any ship's art fully on-chain.
//!
//! State: only the owner-set equipment display names (RenderMetadata).

use near_sdk::json_types::U64;
use near_sdk::store::LookupMap;
use near_sdk::{env, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise};
use vt_core::types::{Armor, MainWeapon, Shields, Ship, Special};

pub mod art;
pub mod render;

use render::Names;

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Names,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NameKind {
    MainWeapon,
    Armor,
    Shields,
    Special,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Renderer {
    owner_id: AccountId,
    /// (variant, kind, enum index) -> display name.
    names: LookupMap<(u16, u8, u8), String>,
}

impl Names for Renderer {
    fn main_weapon(&self, variant: u16, w: MainWeapon) -> Option<String> {
        self.names.get(&(variant, NameKind::MainWeapon as u8, w as u8)).cloned()
    }
    fn armor(&self, variant: u16, a: Armor) -> Option<String> {
        self.names.get(&(variant, NameKind::Armor as u8, a as u8)).cloned()
    }
    fn shields(&self, variant: u16, s: Shields) -> Option<String> {
        self.names.get(&(variant, NameKind::Shields as u8, s as u8)).cloned()
    }
    fn special(&self, variant: u16, s: Special) -> Option<String> {
        self.names.get(&(variant, NameKind::Special as u8, s as u8)).cloned()
    }
}

#[near]
impl Renderer {
    #[init]
    pub fn new(owner_id: AccountId) -> Self {
        Self { owner_id, names: LookupMap::new(StorageKey::Names) }
    }

    /// RenderMetadata.set{MainWeapon,Armor,Shields,Special}Name, batched.
    /// Entries: (variant, kind, enum index, name); empty name clears.
    pub fn set_names(&mut self, entries: Vec<(u16, NameKind, u8, String)>) {
        require!(env::predecessor_account_id() == self.owner_id, "NotOwner");
        for (variant, kind, idx, name) in entries {
            require!(idx < 8, "InvalidIndex");
            let key = (variant, kind as u8, idx);
            if name.is_empty() {
                self.names.remove(&key);
            } else {
                self.names.insert(key, name);
            }
        }
    }

    /// Owner-only code upgrade (new WASM as raw input), e.g. new art. Same
    /// pattern as the game contract.
    pub fn upgrade(&mut self) -> Promise {
        require!(env::predecessor_account_id() == self.owner_id, "NotOwner");
        let code = env::input().unwrap_or_else(|| env::panic_str("NoCode"));
        require!(!code.is_empty(), "NoCode");
        Promise::new(env::current_account_id()).deploy_contract(code).function_call(
            "migrate".to_string(),
            vec![],
            NearToken::from_yoctonear(0),
            Gas::from_tgas(30),
        )
    }

    #[private]
    #[init(ignore_state)]
    pub fn migrate() -> Self {
        env::state_read().unwrap_or_else(|| env::panic_str("NoState"))
    }

    pub fn get_name(&self, variant: u16, kind: NameKind, index: u8) -> Option<String> {
        self.names.get(&(variant, kind as u8, index)).cloned()
    }

    /// ImageRenderer(V2).renderShip: `data:image/svg+xml;base64,...`.
    pub fn render_ship_image(&self, ship: Ship) -> String {
        render::render_ship_image(&ship)
    }

    /// RenderMetadata.tokenURI: `data:application/json;base64,...`.
    pub fn token_uri(&self, ship: Ship) -> String {
        require!(ship.id != 0, "InvalidId");
        render::token_uri(&ship, self)
    }

    /// ShatteredHiveMedal.tokenURI.
    pub fn medal_token_uri(&self, token_id: U64) -> String {
        render::medal_token_uri(token_id.0)
    }

    pub fn medal_svg(&self) -> String {
        art::MEDAL_SVG.to_string()
    }
}

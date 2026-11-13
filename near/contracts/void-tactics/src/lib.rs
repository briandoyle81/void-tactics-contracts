//! Void Tactics game contract.
//!
//! Every gameplay feature lives in this one contract so former cross-contract
//! calls (Game -> Ships -> RandomManager -> ...) are plain internal calls, with
//! no async receipts or callback state hazards. The only intended self-receipt
//! is the randomness resolution callback (see `randomness`), which is
//! deliberately asynchronous.
//!
//! STATE-SIZE RULE: the root struct must stay fixed-size (collection handles and
//! scalar counters only). Storage charging (`storage_ledger`) measures
//! `env::storage_usage()` after flushing collections; the root `STATE` record
//! is only written when the method returns, so a growing root struct would go
//! uncharged.

use near_sdk::store::LookupMap;
use near_sdk::{env, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise};

pub mod config;
pub mod economy;
pub mod events;
pub mod pvp;
pub mod randomness;
pub mod roguelike;
pub mod ships;
pub mod shop;
pub mod single_player;
pub mod storage_ledger;
pub mod tokens;
#[cfg(test)]
mod unit_tests;

use config::ConfigState;
use randomness::RandomRequest;
use ships::ShipRecord;
use single_player::SpState;
use storage_ledger::Account;

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
pub(crate) enum StorageKey {
    Accounts,
    RandomRequests,
    RandomToShip,
    Roles,
    // config
    AttrTables,
    AttrCurrent,
    AttrLatest,
    Costs,
    MaxSpecialSlot,
    FactionResolvers,
    SpecialResolvers,
    RewardToken,
    StorefrontTiers,
    PriceTiers,
    Settings,
    GatedVariants,
    ShipReferrals,
    UtcReferrals,
    Nullifiers,
    Lobbies,
    OpenLobbies,
    PlayerLobbyAt,
    PlayerLobbyPos,
    Kicked,
    PvpFleets,
    PvpGames,
    GameResults,
    Blobs,
    RlCampaigns,
    RlNodes,
    RlRuns,
    RlDroppedHp,
    RlLocked,
    RlDefeated,
    RlActiveRunsAtNode,
    RlMatches,
    RlGrantClaimed,
    // ships
    Ships,
    OwnerShipAt,
    // single player
    Maps,
    AiConfigs,
    MapPlacements,
    Campaigns,
    Nodes,
    CompletedNodes,
    Games,
    SpMatches,
}

/// Role bits (owner has all of them implicitly).
pub mod roles {
    pub const MAP_EDITOR: u8 = 1 << 0;
    pub const NODE_EDITOR: u8 = 1 << 1;
    pub const MINTER: u8 = 1 << 2;
    pub const VERIFIER: u8 = 1 << 3;
    pub const PAUSER: u8 = 1 << 4;
    pub const SPONSOR: u8 = 1 << 5;
    /// GameBlobRegistry.authorizedWriter (replay backend).
    pub const BLOB_WRITER: u8 = 1 << 6;
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    pub(crate) owner_id: AccountId,
    pub(crate) roles: LookupMap<AccountId, u8>,

    // --- accounts: storage ledger + balances + per-player scalars ---
    pub(crate) accounts: LookupMap<AccountId, Account>,

    // --- randomness ---
    pub(crate) random_requests: LookupMap<u64, RandomRequest>,
    pub(crate) random_to_ship: LookupMap<u64, u64>,
    pub(crate) next_random_id: u64,
    pub(crate) random_nonce: u64,

    // --- rules / config ---
    pub(crate) config: ConfigState,

    // --- ships (NEP-171) ---
    pub(crate) ships: LookupMap<u64, ShipRecord>,
    /// (owner, index) -> ship id; per-owner count lives in `Account`.
    pub(crate) owner_ship_at: LookupMap<(AccountId, u32), u64>,
    pub(crate) ship_count: u64,

    // --- tokens (NEP-245): total supply indexed by TokenKind ---
    pub(crate) token_supply: [u128; 2],

    // --- referrals (Ships native ladder / ShipPurchaser UTC ladder) ---
    pub(crate) ship_referrals: LookupMap<AccountId, u64>,
    pub(crate) utc_referrals: LookupMap<AccountId, u64>,
    // --- SelfieCheck nullifier bindings ---
    pub(crate) nullifiers: LookupMap<[u8; 32], AccountId>,

    // --- PvP (Lobbies, PvPMatch, GameResults, GameBlobRegistry) ---
    pub(crate) pvp: pvp::PvpState,

    // --- Roguelike runs ---
    pub(crate) rl: roguelike::RlState,

    // --- single player ---
    pub(crate) sp: SpState,
}

#[near]
impl Contract {
    #[init]
    pub fn new(owner_id: AccountId) -> Self {
        Self {
            owner_id,
            roles: LookupMap::new(StorageKey::Roles),
            accounts: LookupMap::new(StorageKey::Accounts),
            random_requests: LookupMap::new(StorageKey::RandomRequests),
            random_to_ship: LookupMap::new(StorageKey::RandomToShip),
            next_random_id: 1,
            random_nonce: 0,
            config: ConfigState::new(),
            ships: LookupMap::new(StorageKey::Ships),
            owner_ship_at: LookupMap::new(StorageKey::OwnerShipAt),
            ship_count: 0,
            token_supply: [0, 0],
            ship_referrals: LookupMap::new(StorageKey::ShipReferrals),
            utc_referrals: LookupMap::new(StorageKey::UtcReferrals),
            nullifiers: LookupMap::new(StorageKey::Nullifiers),
            pvp: pvp::PvpState::new(),
            rl: roguelike::RlState::new(),
            sp: SpState::new(),
        }
    }

    pub fn owner_id(&self) -> AccountId {
        self.owner_id.clone()
    }

    pub fn set_role(&mut self, account_id: AccountId, role_bits: u8) {
        self.assert_owner();
        if role_bits == 0 {
            self.roles.remove(&account_id);
        } else {
            self.roles.insert(account_id, role_bits);
        }
    }

    pub fn get_roles(&self, account_id: AccountId) -> u8 {
        self.roles.get(&account_id).copied().unwrap_or(0)
    }

    /// Owner-only code upgrade. The new WASM is the raw call input (not
    /// JSON). After a real deploy the account's full-access keys are deleted,
    /// so this is the only way to change the code. Deploys, then runs
    /// `migrate` in the same follow-up receipt; if migrate fails, the deploy
    /// action fails with it and the old code stays.
    pub fn upgrade(&mut self) -> Promise {
        self.assert_owner();
        let code = env::input().unwrap_or_else(|| env::panic_str("NoCode"));
        require!(!code.is_empty(), "NoCode");
        events::emit("upgrade", near_sdk::serde_json::json!({ "code_bytes": code.len() }));
        Promise::new(env::current_account_id()).deploy_contract(code).function_call(
            "migrate".to_string(),
            vec![],
            NearToken::from_yoctonear(0),
            Gas::from_tgas(50),
        )
    }

    /// State migration hook, run by `upgrade`. Today's layout is unchanged,
    /// so it re-reads the state as-is. A layout change adds a versioned old
    /// struct here and converts it (see docs/near-pre-audit.md).
    #[private]
    #[init(ignore_state)]
    pub fn migrate() -> Self {
        env::state_read().unwrap_or_else(|| env::panic_str("NoState"))
    }

    /// Code-identity probe for the upgrade drill (test builds only).
    #[cfg(feature = "upgrade-probe")]
    pub fn upgrade_probe(&self) -> String {
        "v2".to_string()
    }
}

impl Contract {
    /// Flushes every lazily-written collection so `env::storage_usage()`
    /// reflects pending writes. EVERY collection added to `Contract` must be
    /// flushed here, or storage charging will under-count it (caught by the
    /// sandbox ledger-invariant test).
    pub(crate) fn flush_all(&mut self) {
        self.roles.flush();
        self.accounts.flush();
        self.random_requests.flush();
        self.random_to_ship.flush();
        self.config.flush();
        self.ships.flush();
        self.owner_ship_at.flush();
        self.sp.flush();
        self.ship_referrals.flush();
        self.utc_referrals.flush();
        self.nullifiers.flush();
        self.pvp.flush();
        self.rl.flush();
    }

    pub(crate) fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner_id, "NotOwner");
    }

    /// Owner, or an account holding any of `role_bits`.
    pub(crate) fn assert_role(&self, role_bits: u8) {
        let caller = env::predecessor_account_id();
        if caller == self.owner_id {
            return;
        }
        require!(self.roles.get(&caller).is_some_and(|r| r & role_bits != 0), "NotAuthorized");
    }

    pub(crate) fn now_s() -> u64 {
        env::block_timestamp() / 1_000_000_000
    }
}

/// Panics with a vt-core rule error's Solidity-compatible name.
pub(crate) trait OrPanic<T> {
    fn or_panic(self) -> T;
}
impl<T> OrPanic<T> for vt_core::Result<T> {
    fn or_panic(self) -> T {
        self.unwrap_or_else(|e| env::panic_str(e.name()))
    }
}

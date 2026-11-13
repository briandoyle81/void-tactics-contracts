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
use near_sdk::{env, near, require, AccountId, BorshStorageKey, PanicOnDefault};

pub mod config;
pub mod economy;
pub mod events;
pub mod randomness;
pub mod ships;
pub mod single_player;
pub mod storage_ledger;
pub mod tokens;

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

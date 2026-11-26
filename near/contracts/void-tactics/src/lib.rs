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
pub mod history;
pub mod views;
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
    // history. New keys only ever go at the end: a key's position is its
    // storage prefix, so reordering would point collections at other data.
    PlayerGameAt,
    PlayerGameCount,
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

    // --- per-player game history ---
    pub(crate) player_games: history::PlayerGames,
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
            player_games: history::PlayerGames::new(),
        }
    }

    pub fn owner_id(&self) -> AccountId {
        self.owner_id.clone()
    }

    /// Ownable.transferOwnership, made two-step: the owner nominates, the
    /// nominee calls `accept_ownership`. A typo'd or unreachable account can
    /// therefore never take admin away (nominate again to replace it, or
    /// `cancel_ownership_transfer`). Roles are kept. Ownable's
    /// `renounceOwnership` is deliberately not offered: with no owner, code
    /// and rules could never change again.
    pub fn transfer_ownership(&mut self, new_owner: AccountId) {
        self.assert_owner();
        self.config.pending_owner = Some(new_owner.clone());
        events::emit("ownership_transfer_started", near_sdk::serde_json::json!({ "owner": self.owner_id, "pending_owner": new_owner }));
    }

    pub fn cancel_ownership_transfer(&mut self) {
        self.assert_owner();
        self.config.pending_owner = None;
    }

    pub fn accept_ownership(&mut self) {
        let caller = env::predecessor_account_id();
        require!(self.config.pending_owner.as_ref() == Some(&caller), "NotPendingOwner");
        self.config.pending_owner = None;
        let previous = std::mem::replace(&mut self.owner_id, caller.clone());
        events::emit("ownership_transferred", near_sdk::serde_json::json!({ "previous_owner": previous, "new_owner": caller }));
    }

    pub fn get_pending_owner(&self) -> Option<AccountId> {
        self.config.pending_owner.clone()
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

    /// State migration hook, run by `upgrade`. The current layout re-reads
    /// as-is. Once there is live state, a layout change must migrate it here
    /// (see docs/near-pre-audit.md §2): new root fields go at the end (Borsh
    /// encodes fields in order, so the old bytes plus the new fields' encoding
    /// decode as the new struct); changes to records stored in collections
    /// (accounts, ships, games) need a versioned record type, because NEAR
    /// can't rewrite every entry of a map in one call.
    #[private]
    #[init(ignore_state)]
    pub fn migrate() -> Self {
        env::state_read().unwrap_or_else(|| env::panic_str("NoState"))
    }
}

// Code-identity probe for the upgrade drill (test builds only). In its own
// gated impl block: a #[cfg] on one method inside a #[near] impl still leaks
// into the generated ABI.
#[cfg(feature = "upgrade-probe")]
#[near]
impl Contract {
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
        self.player_games.flush();
    }

    /// Every game write goes through here and bumps `GameState::version`.
    pub(crate) fn put_game(&mut self, game_id: u64, mut g: vt_core::engine::GameState) {
        g.version = g.version.wrapping_add(1);
        self.sp.games.insert(game_id, g);
    }

    /// Every ship write goes through here and bumps the owner's nonce.
    pub(crate) fn put_ship(&mut self, ship_id: u64, rec: ships::ShipRecord) {
        let owner = rec.owner.clone();
        self.ships.insert(ship_id, rec);
        self.touch_player(&owner);
    }

    /// Every roguelike run write goes through here and bumps the player's nonce.
    pub(crate) fn put_run(&mut self, player: AccountId, run: roguelike::Run) {
        self.rl.runs.insert(player.clone(), run);
        self.touch_player(&player);
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

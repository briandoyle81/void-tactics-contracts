//! Player-funded storage ledger (NEP-145) and the per-account record.
//!
//! Each account prepays a storage balance with `storage_deposit`. Every
//! state-changing method that can grow storage wraps its work in
//! `charge_storage_since`, which charges (or refunds) the payer's ledger by the
//! exact byte delta. Gameplay calls therefore never need an attached deposit,
//! so they work with function-call access keys and relayed meta-transactions.
//!
//! Why players and not the game pay: any permissionless, storage-growing path
//! paid from the contract balance is a treasury-drain / total-DoS vector for a
//! Sybil swarm (accounts are nearly free). See the plan, section 3.
//!
//! The `Account` record is FIXED-SIZE and created at registration: token
//! balances and per-player scalars live in it, so minting, burning and
//! transferring tokens never change storage usage and never need charging
//! (kill rewards can be paid from inside someone else's call without risk).

use near_contract_standards::storage_management::{StorageBalance, StorageBalanceBounds, StorageManagement};
use near_sdk::serde_json::json;
use near_sdk::{assert_one_yocto, env, near, require, AccountId, NearToken, Promise};

use crate::events;
use crate::{Contract, ContractExt};

/// Minimum prepaid balance to register: 0.0125 NEAR (~1.25 KB): the account
/// record plus a little headroom. A free claim of 10+ ships needs ~0.1 NEAR.
pub const MIN_STORAGE_DEPOSIT: NearToken = NearToken::from_yoctonear(12_500_000_000_000_000_000_000);

#[near(serializers = [borsh])]
#[derive(Clone, Debug, Default)]
pub struct Account {
    /// Total NEAR prepaid by (or sponsored for) this account.
    pub deposit: NearToken,
    /// Bytes of contract storage attributed to this account, including this
    /// record.
    pub used_bytes: u64,
    /// NEP-245 balances (fixed slots; see module docs).
    pub utc: u128,
    pub dec: u128,
    /// Ships.amountPurchased (paid ships only; gates transfers).
    pub amount_purchased: u64,
    /// FreeShipClaim.lastClaimTimestamp (seconds).
    pub last_free_claim_s: u64,
    /// DroneStorefront.droneCoreTier.
    pub drone_core_tier: u8,
    /// Number of ships owned (owner index length).
    pub ship_count: u32,
}

impl Account {
    pub fn locked(&self) -> NearToken {
        env::storage_byte_cost().saturating_mul(self.used_bytes as u128)
    }

    pub fn available(&self) -> NearToken {
        self.deposit.saturating_sub(self.locked())
    }

    fn to_balance(&self) -> StorageBalance {
        StorageBalance { total: self.deposit, available: self.available() }
    }

    /// Bytes this account can still pay for.
    pub fn spare_bytes(&self) -> u64 {
        (self.available().as_yoctonear() / env::storage_byte_cost().as_yoctonear()) as u64
    }
}

impl Contract {
    pub(crate) fn account(&self, id: &AccountId) -> Account {
        self.accounts.get(id).cloned().unwrap_or_else(|| env::panic_str("StorageNotRegistered"))
    }

    /// Writes back a record that already exists (same size: no storage change).
    pub(crate) fn put_account(&mut self, id: &AccountId, a: Account) {
        self.accounts.insert(id.clone(), a);
    }

    /// Charges `account_id` for the storage delta since `initial_usage`
    /// (`env::storage_usage()` captured before the work). Negative deltas
    /// refund bytes. Panics `InsufficientStorageBalance` if the account can't
    /// cover its new total, which reverts the whole call cleanly.
    pub(crate) fn charge_storage_since(&mut self, account_id: &AccountId, initial_usage: u64) {
        self.flush_all();
        let now = env::storage_usage();
        let mut acct = self.account(account_id);
        if now >= initial_usage {
            acct.used_bytes += now - initial_usage;
        } else {
            acct.used_bytes = acct.used_bytes.saturating_sub(initial_usage - now);
        }
        require!(acct.deposit >= acct.locked(), "InsufficientStorageBalance");
        self.put_account(account_id, acct);
    }

    /// Non-panicking variant for callbacks: reserves `bytes` against
    /// `account_id` if affordable. The caller then performs a write that grows
    /// storage by exactly `bytes`.
    pub(crate) fn try_reserve_bytes(&mut self, account_id: &AccountId, bytes: u64) -> bool {
        let Some(mut acct) = self.accounts.get(account_id).cloned() else { return false };
        if acct.spare_bytes() < bytes {
            return false;
        }
        acct.used_bytes += bytes;
        self.put_account(account_id, acct);
        true
    }

    pub(crate) fn assert_registered(&self, account_id: &AccountId) {
        require!(self.accounts.contains_key(account_id), "StorageNotRegistered");
    }

    fn internal_register(&mut self, account_id: &AccountId, deposit: NearToken) -> Account {
        self.flush_all();
        let before = env::storage_usage();
        self.accounts.insert(account_id.clone(), Account { deposit, ..Default::default() });
        self.flush_all();
        let record_bytes = env::storage_usage() - before;
        let acct = Account { deposit, used_bytes: record_bytes, ..Default::default() };
        self.accounts.insert(account_id.clone(), acct.clone());
        acct
    }
}

#[near]
impl StorageManagement for Contract {
    #[payable]
    fn storage_deposit(&mut self, account_id: Option<AccountId>, registration_only: Option<bool>) -> StorageBalance {
        let amount = env::attached_deposit();
        let account_id = account_id.unwrap_or_else(env::predecessor_account_id);
        let registration_only = registration_only.unwrap_or(false);

        match self.accounts.get(&account_id).cloned() {
            Some(mut acct) => {
                if registration_only {
                    if !amount.is_zero() {
                        Promise::new(env::predecessor_account_id()).transfer(amount).detach();
                    }
                } else {
                    acct.deposit = acct.deposit.saturating_add(amount);
                    self.put_account(&account_id, acct.clone());
                }
                self.account(&account_id).to_balance()
            }
            None => {
                require!(amount >= MIN_STORAGE_DEPOSIT, "DepositBelowMinimum");
                let (kept, refund) = if registration_only {
                    (MIN_STORAGE_DEPOSIT, amount.saturating_sub(MIN_STORAGE_DEPOSIT))
                } else {
                    (amount, NearToken::from_yoctonear(0))
                };
                let acct = self.internal_register(&account_id, kept);
                if !refund.is_zero() {
                    Promise::new(env::predecessor_account_id()).transfer(refund).detach();
                }
                events::emit("storage_registered", json!({ "account_id": account_id, "deposit": kept }));
                acct.to_balance()
            }
        }
    }

    #[payable]
    fn storage_withdraw(&mut self, amount: Option<NearToken>) -> StorageBalance {
        assert_one_yocto();
        let account_id = env::predecessor_account_id();
        let mut acct = self.account(&account_id);
        let available = acct.available();
        let amount = amount.unwrap_or(available);
        require!(amount <= available, "WithdrawExceedsAvailable");
        acct.deposit = acct.deposit.saturating_sub(amount);
        self.put_account(&account_id, acct.clone());
        if !amount.is_zero() {
            Promise::new(account_id).transfer(amount).detach();
        }
        acct.to_balance()
    }

    #[payable]
    fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        assert_one_yocto();
        require!(!force.unwrap_or(false), "ForceUnregisterUnsupported");
        let account_id = env::predecessor_account_id();
        let Some(acct) = self.accounts.get(&account_id).cloned() else {
            return false;
        };
        // Tokens would be destroyed with the record.
        require!(acct.utc == 0 && acct.dec == 0, "AccountHasTokens");
        // Only the bare record may remain; any game state (ships, pending
        // requests, ...) must be released first.
        self.flush_all();
        let before = env::storage_usage();
        self.accounts.remove(&account_id);
        self.flush_all();
        let freed = before - env::storage_usage();
        require!(acct.used_bytes == freed, "AccountHasState");
        Promise::new(account_id).transfer(acct.deposit).detach();
        true
    }

    fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        StorageBalanceBounds { min: MIN_STORAGE_DEPOSIT, max: None }
    }

    fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.accounts.get(&account_id).map(|a| a.to_balance())
    }
}

#[near]
impl Contract {
    /// Bytes currently attributed to `account_id` (for tests and the frontend).
    pub fn storage_used_bytes(&self, account_id: AccountId) -> Option<u64> {
        self.accounts.get(&account_id).map(|a| a.used_bytes)
    }
}

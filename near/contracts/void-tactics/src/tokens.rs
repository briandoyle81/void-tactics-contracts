//! NEP-245 multi-token: "utc" (Universal Time Credits, 18 decimals) and "dec"
//! (Drone Computation Cores, 0 decimals). Both are freely transferable (DEC is
//! deliberately not soulbound: grinders can sell cores). Balances live in the
//! holder's fixed-size `Account`, so mint/burn/transfer never change storage
//! usage. Receivers must be registered (NEP-145 convention).
//!
//! Supply control is mint-side only (kill rewards, storefront burns).

use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::{assert_one_yocto, env, near, require, AccountId};

use crate::config::TokenKind;
use crate::{Contract, ContractExt};

pub const UTC: &str = "utc";
pub const DEC: &str = "dec";
/// Soulbound Shattered Hive campaign medal (balance 0 or 1, not transferable).
pub const HIVE_MEDAL: &str = "hive_medal";

impl TokenKind {
    pub fn id(self) -> &'static str {
        match self {
            TokenKind::Utc => UTC,
            TokenKind::Dec => DEC,
        }
    }
    pub fn parse(token_id: &str) -> TokenKind {
        match token_id {
            UTC => TokenKind::Utc,
            DEC => TokenKind::Dec,
            HIVE_MEDAL => env::panic_str("Soulbound"),
            _ => env::panic_str("UnknownToken"),
        }
    }
}

fn emit_nep245(event: &str, data: near_sdk::serde_json::Value) {
    let payload = json!({ "standard": "nep245", "version": "1.0.0", "event": event, "data": [data] });
    env::log_str(&format!("EVENT_JSON:{payload}"));
}

impl Contract {
    fn balance_slot(a: &mut crate::storage_ledger::Account, kind: TokenKind) -> &mut u128 {
        match kind {
            TokenKind::Utc => &mut a.utc,
            TokenKind::Dec => &mut a.dec,
        }
    }

    /// Mints to a registered account. Never panics (reward paths rely on
    /// that); returns false if it couldn't mint.
    pub(crate) fn try_mint(&mut self, to: &AccountId, kind: TokenKind, amount: u128) -> bool {
        if amount == 0 {
            return true;
        }
        let Some(mut a) = self.accounts.get(to).cloned() else { return false };
        let slot = Self::balance_slot(&mut a, kind);
        let Some(next) = slot.checked_add(amount) else { return false };
        *slot = next;
        let idx = kind as usize;
        let Some(supply) = self.token_supply[idx].checked_add(amount) else { return false };
        self.token_supply[idx] = supply;
        self.put_account(to, a);
        emit_nep245("mt_mint", json!({ "owner_id": to, "token_ids": [kind.id()], "amounts": [U128(amount)] }));
        true
    }

    /// User-initiated burn: panics if the balance is insufficient.
    pub(crate) fn burn(&mut self, from: &AccountId, kind: TokenKind, amount: u128) {
        let mut a = self.account(from);
        let slot = Self::balance_slot(&mut a, kind);
        require!(*slot >= amount, "InsufficientBalance");
        *slot -= amount;
        self.token_supply[kind as usize] -= amount;
        self.put_account(from, a);
        emit_nep245("mt_burn", json!({ "owner_id": from, "token_ids": [kind.id()], "amounts": [U128(amount)] }));
    }

    fn internal_transfer(&mut self, from: &AccountId, to: &AccountId, kind: TokenKind, amount: u128) {
        require!(from != to, "SelfTransfer");
        require!(amount > 0, "ZeroAmount");
        let mut src = self.account(from);
        let s = Self::balance_slot(&mut src, kind);
        require!(*s >= amount, "InsufficientBalance");
        *s -= amount;
        let mut dst = self.accounts.get(to).cloned().unwrap_or_else(|| env::panic_str("ReceiverNotRegistered"));
        let d = Self::balance_slot(&mut dst, kind);
        *d = d.checked_add(amount).unwrap_or_else(|| env::panic_str("BalanceOverflow"));
        self.put_account(from, src);
        self.put_account(to, dst);
    }
}

#[near]
impl Contract {
    #[payable]
    pub fn mt_transfer(
        &mut self,
        receiver_id: AccountId,
        token_id: String,
        amount: U128,
        approval: Option<(AccountId, u64)>,
        memo: Option<String>,
    ) {
        assert_one_yocto();
        require!(approval.is_none(), "ApprovalsUnsupported");
        let from = env::predecessor_account_id();
        let kind = TokenKind::parse(&token_id);
        self.internal_transfer(&from, &receiver_id, kind, amount.0);
        emit_nep245(
            "mt_transfer",
            json!({ "old_owner_id": from, "new_owner_id": receiver_id, "token_ids": [token_id], "amounts": [amount], "memo": memo }),
        );
    }

    #[payable]
    pub fn mt_batch_transfer(
        &mut self,
        receiver_id: AccountId,
        token_ids: Vec<String>,
        amounts: Vec<U128>,
        approvals: Option<Vec<Option<(AccountId, u64)>>>,
        memo: Option<String>,
    ) {
        assert_one_yocto();
        require!(token_ids.len() == amounts.len(), "ArrayLengthMismatch");
        require!(approvals.is_none_or(|a| a.iter().all(Option::is_none)), "ApprovalsUnsupported");
        let from = env::predecessor_account_id();
        for (t, a) in token_ids.iter().zip(&amounts) {
            self.internal_transfer(&from, &receiver_id, TokenKind::parse(t), a.0);
        }
        emit_nep245(
            "mt_transfer",
            json!({ "old_owner_id": from, "new_owner_id": receiver_id, "token_ids": token_ids, "amounts": amounts, "memo": memo }),
        );
    }

    pub fn mt_balance_of(&self, account_id: AccountId, token_id: String) -> U128 {
        if token_id == HIVE_MEDAL {
            return U128(self.accounts.get(&account_id).is_some_and(|a| a.hive_medal) as u128);
        }
        let kind = TokenKind::parse(&token_id);
        U128(self.accounts.get(&account_id).map_or(0, |a| match kind {
            TokenKind::Utc => a.utc,
            TokenKind::Dec => a.dec,
        }))
    }

    pub fn mt_batch_balance_of(&self, account_id: AccountId, token_ids: Vec<String>) -> Vec<U128> {
        token_ids.into_iter().map(|t| self.mt_balance_of(account_id.clone(), t)).collect()
    }

    pub fn mt_supply(&self, token_id: String) -> Option<U128> {
        if token_id == HIVE_MEDAL {
            return Some(U128(self.config.medal_supply as u128));
        }
        Some(U128(self.token_supply[TokenKind::parse(&token_id) as usize]))
    }

    pub fn mt_batch_supply(&self, token_ids: Vec<String>) -> Vec<Option<U128>> {
        token_ids.into_iter().map(|t| self.mt_supply(t)).collect()
    }
}

/// Test-only: owner mints tokens directly (deterministic storefront tests).
#[cfg(feature = "test-hooks")]
#[near]
impl Contract {
    pub fn test_mint(&mut self, account_id: AccountId, token_id: String, amount: U128) {
        self.assert_owner();
        require!(self.try_mint(&account_id, TokenKind::parse(&token_id), amount.0), "MintFailed");
    }
}

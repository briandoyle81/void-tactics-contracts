//! NEP-245 multi-token: "utc" (Universal Time Credits, 18 decimals) and "dec"
//! (Drone Computation Cores, DCC; 0 decimals). Both are freely transferable (DEC is
//! deliberately not soulbound: grinders can sell cores). Balances live in the
//! holder's fixed-size `Account`, so mint/burn/transfer never change storage
//! usage. Receivers must be registered (NEP-145 convention).
//!
//! Supply control: mint sources (kill rewards, purchases, recycling, win
//! effects) with an owner/PAUSER kill switch per token, plus burns
//! (storefront, treasury, and players' own `mt_burn`).

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
        // UniversalCredits/DroneEnergyCores.mintIsActive: with minting off,
        // every mint fails, so callers behave as on Base: kill rewards and
        // win effects are skipped (logged), paid UTC mints revert.
        if !self.token_mint_active(kind) {
            return false;
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

    pub(crate) fn token_mint_active(&self, kind: TokenKind) -> bool {
        let key = match kind {
            TokenKind::Utc => crate::config::SETTING_UTC_MINT_OFF,
            TokenKind::Dec => crate::config::SETTING_DEC_MINT_OFF,
        };
        !self.config.settings.contains_key(&key)
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

/// NEP-245 metadata extension types (spec "mt-1.0.0").
#[near(serializers = [json])]
pub struct MtContractMetadata {
    pub spec: String,
    pub name: String,
}

#[near(serializers = [json])]
#[derive(Clone)]
pub struct MtBaseTokenMetadata {
    pub name: String,
    pub id: String,
    pub symbol: Option<String>,
    pub icon: Option<String>,
    pub decimals: Option<String>,
    pub base_uri: Option<String>,
    pub reference: Option<String>,
    pub copies: Option<u64>,
    pub reference_hash: Option<String>,
}

#[near(serializers = [json])]
#[derive(Clone, Default)]
pub struct MtTokenMetadata {
    pub title: Option<String>,
    pub description: Option<String>,
    pub media: Option<String>,
    pub media_hash: Option<String>,
    pub issued_at: Option<String>,
    pub expires_at: Option<String>,
    pub starts_at: Option<String>,
    pub updated_at: Option<String>,
    pub extra: Option<String>,
    pub reference: Option<String>,
    pub reference_hash: Option<String>,
}

#[near(serializers = [json])]
pub struct MtTokenMetadataAll {
    pub base: MtBaseTokenMetadata,
    pub token: MtTokenMetadata,
}

/// Wallet-facing names. UTC and the medal as on Base; DEC uses the
/// 2026-11-11 rename (Drone Computation Cores, DCC) since the NEAR tokens are
/// a fresh deployment. Token ids are unchanged ("dec"). The base metadata id
/// is the token id.
fn base_metadata(token_id: &str) -> Option<MtBaseTokenMetadata> {
    let (name, symbol, decimals) = match token_id {
        UTC => ("Universal Time Credits", "UTC", "18"),
        DEC => ("Drone Computation Cores", "DCC", "0"),
        HIVE_MEDAL => ("Shattered Hive Campaign Medal", "HIVEMEDAL", "0"),
        _ => return None,
    };
    Some(MtBaseTokenMetadata {
        name: name.into(),
        id: token_id.into(),
        symbol: Some(symbol.into()),
        icon: None,
        decimals: Some(decimals.into()),
        base_uri: None,
        reference: None,
        copies: None,
        reference_hash: None,
    })
}

fn token_metadata(token_id: &str) -> Option<MtTokenMetadata> {
    let description = match token_id {
        UTC => "Void Tactics currency: buys ships, lobby slots, repairs and ship modifications.",
        DEC => "Void Tactics drone cores, earned by destroying AI ships and turned in for larger free-ship claims. Indivisible.",
        HIVE_MEDAL => "Awarded for completing the Shattered Hive campaign. Soulbound.",
        _ => return None,
    };
    Some(MtTokenMetadata { title: base_metadata(token_id).map(|b| b.name), description: Some(description.into()), ..Default::default() })
}

#[near]
impl Contract {
    // ---- NEP-245 metadata extension (2026-11-14; ERC-20/721 name, symbol,
    // decimals on Base). Unknown ids give null entries. ----

    pub fn mt_metadata_contract(&self) -> MtContractMetadata {
        MtContractMetadata { spec: "mt-1.0.0".into(), name: "Void Tactics".into() }
    }

    pub fn mt_metadata_token_all(&self, token_ids: Vec<String>) -> Vec<Option<MtTokenMetadataAll>> {
        token_ids.iter().map(|t| Some(MtTokenMetadataAll { base: base_metadata(t)?, token: token_metadata(t)? })).collect()
    }

    pub fn mt_metadata_token_by_token_id(&self, token_ids: Vec<String>) -> Vec<Option<MtTokenMetadata>> {
        token_ids.iter().map(|t| token_metadata(t)).collect()
    }

    pub fn mt_metadata_base_by_token_id(&self, token_ids: Vec<String>) -> Vec<Option<MtBaseTokenMetadata>> {
        token_ids.iter().map(|t| base_metadata(t)).collect()
    }

    pub fn mt_metadata_base_by_metadata_id(&self, base_metadata_ids: Vec<String>) -> Vec<Option<MtBaseTokenMetadata>> {
        base_metadata_ids.iter().map(|t| base_metadata(t)).collect()
    }

    // ---- ERC20Burnable.burn (players) and the mint kill switch ----

    /// Burns the caller's own UTC or DEC (ERC20Burnable.burn). 1 yocto, like
    /// every token-moving call. The medal is soulbound and can't be burned.
    #[payable]
    pub fn mt_burn(&mut self, token_id: String, amount: U128) {
        assert_one_yocto();
        require!(amount.0 > 0, "ZeroAmount");
        let kind = TokenKind::parse(&token_id);
        self.burn(&env::predecessor_account_id(), kind, amount.0);
    }

    /// UniversalCredits/DroneEnergyCores.setMintIsActive. Owner or PAUSER
    /// (an emergency switch, like the other pauses).
    pub fn set_token_mint_active(&mut self, token_id: String, active: bool) {
        self.assert_role(crate::roles::PAUSER);
        let key = match TokenKind::parse(&token_id) {
            TokenKind::Utc => crate::config::SETTING_UTC_MINT_OFF,
            TokenKind::Dec => crate::config::SETTING_DEC_MINT_OFF,
        };
        if active {
            self.config.settings.remove(&key);
        } else {
            self.config.settings.insert(key, "1".into());
        }
        crate::events::emit("token_mint_active", json!({ "token_id": token_id, "active": active }));
    }

    pub fn is_token_mint_active(&self, token_id: String) -> bool {
        self.token_mint_active(TokenKind::parse(&token_id))
    }

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

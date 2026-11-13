//! Self-callback randomness.
//!
//! NEAR exposes only the CURRENT block's VRF seed (`env::random_seed_array()`),
//! with no historical `blockhash(n)`. Reading it inside a user's own receipt is
//! unsafe: a transaction may batch several FunctionCall actions to this
//! contract, and if any later action panics the whole receipt reverts, so a
//! player could batch `[mint, call-that-panics-on-a-bad-roll]` and retry until
//! they like the result.
//!
//! Instead, requesting code records a fixed-size request and schedules a
//! receipt back to this contract (`resolve_randomness`). That receipt runs in a
//! later block whose seed the requester could not know, it cannot be part of
//! the requester's batch, and its success or failure cannot roll back the
//! requester's receipt. `resolve_randomness` is `#[private]`
//! (predecessor == current account).
//!
//! RULE: never call `env::random_seed*` outside `resolve_randomness`.

use near_sdk::json_types::U64;
use near_sdk::serde_json::json;
use near_sdk::{env, near, AccountId, Gas, NearToken, Promise};
use vt_core::random::derive_random_base;

use crate::events;
use crate::{Contract, ContractExt};

/// Max ids resolved by one callback receipt (largest ship pack is 60).
pub const MAX_IDS_PER_RESOLVE: usize = 64;
const RESOLVE_BASE_GAS: Gas = Gas::from_tgas(10);
/// Covers resolving one request plus constructing its ship (keccak-heavy).
const RESOLVE_GAS_PER_ID: Gas = Gas::from_tgas(3);

/// Fixed-size record: resolving it overwrites in place and never grows
/// storage, so the callback never needs to charge anyone's storage ledger and
/// cannot fail for lack of storage balance.
#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct RandomRequest {
    pub owner: AccountId,
    pub requested_at_height: u64,
    /// 0 while unresolved (block height 0 never executes contract code).
    pub resolved_at_height: u64,
    pub value: u64,
}

impl RandomRequest {
    pub fn is_resolved(&self) -> bool {
        self.resolved_at_height != 0
    }
}

#[near(serializers = [json])]
pub struct RandomRequestView {
    pub id: U64,
    pub owner: AccountId,
    pub requested_at_height: U64,
    pub resolved_at_height: Option<U64>,
    pub value: Option<U64>,
}

pub(crate) fn resolve_gas(n: usize) -> Gas {
    Gas::from_gas(RESOLVE_BASE_GAS.as_gas() + RESOLVE_GAS_PER_ID.as_gas() * n as u64)
}

impl Contract {
    /// Records `count` new requests for `owner` and returns their ids. Caller
    /// is responsible for storage charging and for scheduling resolution with
    /// `schedule_resolution` in the same receipt.
    pub(crate) fn internal_request_randomness(&mut self, owner: &AccountId, count: usize) -> Vec<u64> {
        assert!(count > 0 && count <= MAX_IDS_PER_RESOLVE, "BadRandomCount");
        let height = env::block_height();
        let ids: Vec<u64> = (0..count)
            .map(|_| {
                let id = self.next_random_id;
                self.next_random_id += 1;
                self.random_requests.insert(
                    id,
                    RandomRequest {
                        owner: owner.clone(),
                        requested_at_height: height,
                        resolved_at_height: 0,
                        value: 0,
                    },
                );
                id
            })
            .collect();
        // One event per batch: NEAR caps a receipt at 100 logs / 16 KB.
        events::emit(
            "randomness_requested",
            json!({ "owner": owner, "ids": ids.iter().map(|&i| U64(i)).collect::<Vec<_>>() }),
        );
        ids
    }

    pub(crate) fn schedule_resolution(ids: Vec<u64>) -> Promise {
        let n = ids.len();
        let ids: Vec<U64> = ids.into_iter().map(U64).collect();
        Promise::new(env::current_account_id()).function_call(
            "resolve_randomness".to_string(),
            json!({ "ids": ids }).to_string().into_bytes(),
            NearToken::from_yoctonear(0),
            resolve_gas(n),
        )
    }

    /// Consumer hook: constructs the ship minted with this request. Must not
    /// panic (see Ships module docs); a skipped construction is retried by the
    /// owner with `construct_ship`.
    fn on_random_resolved(&mut self, id: u64, req: &RandomRequest) -> Option<(u64, Result<(), &'static str>)> {
        let ship_id = *self.random_to_ship.get(&id)?;
        // Drop the spent request first and refund its bytes to whoever paid
        // for it: they (~190 bytes) cover the ship's growth on construction
        // (its generated name), so construction never fails for storage just
        // because the payer had no spare balance (e.g. a NEAR-bought pack,
        // which prepays exactly its mint-time bytes).
        self.flush_all();
        let before = env::storage_usage();
        self.random_requests.remove(&id);
        self.random_to_ship.remove(&id);
        self.flush_all();
        let freed = before - env::storage_usage();
        self.adjust_used_bytes(&req.owner, -(freed as i64));

        let result = self.try_construct(ship_id, req.value, true);
        if result.is_err() {
            // Keep the resolved value for a later `construct_ship`: restore
            // the request (same bytes the payer just got back).
            self.random_requests.insert(id, req.clone());
            self.random_to_ship.insert(id, ship_id);
            self.adjust_used_bytes(&req.owner, freed as i64);
        }
        Some((ship_id, result))
    }
}

#[near]
impl Contract {
    /// Self-callback only. Idempotent: unknown or already-resolved ids are
    /// skipped, never panic.
    #[private]
    pub fn resolve_randomness(&mut self, ids: Vec<U64>) {
        let seed = env::random_seed_array();
        let height = env::block_height();
        let mut resolved = Vec::new();
        let mut constructed = Vec::new();
        let mut skipped = Vec::new();
        for U64(id) in ids.into_iter().take(MAX_IDS_PER_RESOLVE) {
            let Some(mut req) = self.random_requests.get(&id).cloned() else { continue };
            if req.is_resolved() {
                continue;
            }
            req.value = derive_random_base(&seed, id, self.random_nonce);
            self.random_nonce += 1;
            req.resolved_at_height = height;
            self.random_requests.insert(id, req.clone());
            // (removed again below if its ship gets constructed)
            resolved.push(U64(id));
            match self.on_random_resolved(id, &req) {
                Some((ship, Ok(()))) => constructed.push(U64(ship)),
                Some((ship, Err(reason))) => skipped.push(json!({ "ship_id": U64(ship), "reason": reason })),
                None => {}
            }
        }
        events::emit(
            "randomness_resolved",
            json!({ "height": U64(height), "ids": resolved, "ships_constructed": constructed, "ships_skipped": skipped }),
        );
    }

    /// Permissionless recovery if a resolution receipt failed (e.g. ran out of
    /// gas). Schedules a NEW self-callback, so the seed still comes from a later
    /// block the caller can't predict. Ids that are unknown, already resolved,
    /// or requested in this same block are silently dropped (a griefer racing
    /// this call can't make it revert). Returns how many ids were scheduled.
    pub fn retry_resolve(&mut self, ids: Vec<U64>) -> u32 {
        let height = env::block_height();
        let pending: Vec<u64> = ids
            .into_iter()
            .map(|U64(id)| id)
            .filter(|id| {
                self.random_requests
                    .get(id)
                    .is_some_and(|r| !r.is_resolved() && r.requested_at_height < height)
            })
            .take(MAX_IDS_PER_RESOLVE)
            .collect();
        let n = pending.len() as u32;
        if n > 0 {
            Self::schedule_resolution(pending).detach();
        }
        n
    }

    pub fn get_random_request(&self, id: U64) -> Option<RandomRequestView> {
        self.random_requests.get(&id.0).map(|r| RandomRequestView {
            id,
            owner: r.owner.clone(),
            requested_at_height: U64(r.requested_at_height),
            resolved_at_height: r.is_resolved().then_some(U64(r.resolved_at_height)),
            value: r.is_resolved().then_some(U64(r.value)),
        })
    }

    pub fn next_random_id(&self) -> U64 {
        U64(self.next_random_id)
    }
}

/// Test-only entrypoint: a raw randomness request, charged to the caller's
/// storage ledger. Real requests come from minting (Phase 1).
#[cfg(feature = "test-hooks")]
#[near]
impl Contract {
    pub fn test_request_randomness(&mut self, count: u32) -> Vec<U64> {
        let caller = env::predecessor_account_id();
        self.assert_registered(&caller);
        let initial = env::storage_usage();
        let ids = self.internal_request_randomness(&caller, count as usize);
        self.charge_storage_since(&caller, initial);
        Self::schedule_resolution(ids.clone()).detach();
        ids.into_iter().map(U64).collect()
    }
}

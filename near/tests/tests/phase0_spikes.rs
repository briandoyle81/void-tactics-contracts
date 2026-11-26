//! Phase 0 spikes: prove the two riskiest NEAR design assumptions on a real
//! sandbox runtime before building gameplay on top of them.
//!   (a) self-callback randomness resolves in a later block and can't be
//!       re-rolled by a batched, reverting transaction;
//!   (b) the per-account storage ledger charges exactly the real storage delta,
//!       and gameplay works from a deposit-less function-call (session) key.

use integration_tests::setup;
use near_workspaces::operations::Function;
use near_workspaces::types::{AccessKey, Gas, KeyType, NearToken, SecretKey};
use near_workspaces::Account;
use serde_json::{json, Value};

fn tgas(n: u64) -> Gas {
    Gas::from_tgas(n)
}

async fn request(user: &Account, contract: &near_workspaces::Contract, count: u32) -> anyhow::Result<Vec<String>> {
    let out = user
        .call(contract.id(), "test_request_randomness")
        .args_json(json!({ "count": count }))
        .gas(tgas(150))
        .transact()
        .await?
        .into_result()?;
    Ok(out.json::<Vec<String>>()?)
}

async fn get_request(contract: &near_workspaces::Contract, id: &str) -> anyhow::Result<Value> {
    Ok(contract.view("get_random_request").args_json(json!({ "id": id })).await?.json::<Value>()?)
}

#[tokio::test]
async fn randomness_resolves_in_a_later_block_with_independent_values() -> anyhow::Result<()> {
    let env = setup().await?;
    let alice = env.registered_user(NearToken::from_millinear(100)).await?;

    let ids = request(&alice, &env.contract, 3).await?;
    assert_eq!(ids, vec!["1", "2", "3"]); // request ids start at 1

    let mut values = Vec::new();
    for id in &ids {
        let r = get_request(&env.contract, id).await?;
        let requested: u64 = r["requested_at_height"].as_str().unwrap().parse()?;
        let resolved: u64 = r["resolved_at_height"]
            .as_str()
            .expect("callback should have resolved the request")
            .parse()?;
        assert!(resolved > requested, "resolution must happen in a later block ({resolved} > {requested})");
        values.push(r["value"].as_str().unwrap().to_string());
    }
    values.sort();
    values.dedup();
    assert_eq!(values.len(), 3, "ships minted together must get independent values");
    Ok(())
}

#[tokio::test]
async fn batched_failing_action_reverts_the_request_entirely() -> anyhow::Result<()> {
    let env = setup().await?;
    let alice = env.registered_user(NearToken::from_millinear(100)).await?;
    let used_before = env.used_bytes(&alice).await?;

    // Attack shape: [request randomness, action-that-panics]. The whole receipt
    // reverts, and nothing about the outcome was observable inside it.
    let outcome = alice
        .batch(env.contract.id())
        .call(Function::new("test_request_randomness").args_json(json!({ "count": 1 })).gas(tgas(100)))
        .call(Function::new("no_such_method").gas(tgas(10)))
        .transact()
        .await?;
    assert!(outcome.is_failure());

    let next: String = env.contract.view("next_random_id").await?.json()?;
    assert_eq!(next, "1", "reverted batch must not leave a request behind");
    assert!(get_request(&env.contract, "1").await?.is_null());
    assert_eq!(env.used_bytes(&alice).await?, used_before);
    Ok(())
}

#[tokio::test]
async fn resolve_randomness_rejects_external_callers() -> anyhow::Result<()> {
    let env = setup().await?;
    let alice = env.registered_user(NearToken::from_millinear(100)).await?;
    let outcome = alice
        .call(env.contract.id(), "resolve_randomness")
        .args_json(json!({ "ids": ["0"] }))
        .transact()
        .await?;
    assert!(outcome.is_failure(), "only the contract itself may resolve randomness");
    Ok(())
}

#[tokio::test]
async fn retry_resolve_is_a_noop_for_resolved_and_unknown_ids() -> anyhow::Result<()> {
    let env = setup().await?;
    let alice = env.registered_user(NearToken::from_millinear(100)).await?;
    let ids = request(&alice, &env.contract, 2).await?;
    let before = get_request(&env.contract, &ids[0]).await?;

    // A griefer racing / spamming retry must never make it revert.
    let bob = env.worker.dev_create_account().await?;
    let scheduled: u32 = bob
        .call(env.contract.id(), "retry_resolve")
        .args_json(json!({ "ids": ["1", "2", "999"] }))
        .gas(tgas(100))
        .transact()
        .await?
        .into_result()?
        .json()?;
    assert_eq!(scheduled, 0);
    assert_eq!(get_request(&env.contract, &ids[0]).await?, before, "resolved value must never change");
    Ok(())
}

#[tokio::test]
async fn ledger_charges_exactly_the_real_storage_delta() -> anyhow::Result<()> {
    let env = setup().await?;
    let alice = env.registered_user(NearToken::from_millinear(100)).await?;

    let storage_before = env.contract_storage_usage().await?;
    let used_before = env.used_bytes(&alice).await?;
    request(&alice, &env.contract, 5).await?; // includes the resolution callback
    let storage_after = env.contract_storage_usage().await?;
    let used_after = env.used_bytes(&alice).await?;

    assert!(storage_after > storage_before);
    assert_eq!(
        used_after - used_before,
        storage_after - storage_before,
        "ledger must charge the exact on-chain byte delta (incl. after the callback)"
    );
    Ok(())
}

#[tokio::test]
async fn insufficient_storage_balance_fails_cleanly() -> anyhow::Result<()> {
    let env = setup().await?;
    // Exactly the minimum (0.0125 NEAR = 1250 bytes).
    let alice = env.registered_user(NearToken::from_yoctonear(12_500_000_000_000_000_000_000)).await?;
    let used_before = env.used_bytes(&alice).await?;
    let storage_before = env.contract_storage_usage().await?;

    let outcome = alice
        .call(env.contract.id(), "test_request_randomness")
        .args_json(json!({ "count": 64 }))
        .gas(tgas(150))
        .transact()
        .await?;
    assert!(outcome.is_failure());
    assert!(format!("{:?}", outcome.into_result().unwrap_err()).contains("InsufficientStorageBalance"));

    let next: String = env.contract.view("next_random_id").await?.json()?;
    assert_eq!(next, "1");
    assert_eq!(env.used_bytes(&alice).await?, used_before);
    assert_eq!(env.contract_storage_usage().await?, storage_before);
    Ok(())
}

#[tokio::test]
async fn unregistered_accounts_cannot_grow_storage() -> anyhow::Result<()> {
    let env = setup().await?;
    let mallory = env.worker.dev_create_account().await?;
    let outcome = mallory
        .call(env.contract.id(), "test_request_randomness")
        .args_json(json!({ "count": 1 }))
        .gas(tgas(100))
        .transact()
        .await?;
    assert!(outcome.is_failure());
    assert!(format!("{:?}", outcome.into_result().unwrap_err()).contains("StorageNotRegistered"));
    Ok(())
}

#[tokio::test]
async fn unregister_refuses_while_account_owns_state() -> anyhow::Result<()> {
    let env = setup().await?;
    let alice = env.registered_user(NearToken::from_millinear(100)).await?;
    request(&alice, &env.contract, 1).await?;
    let outcome = alice
        .call(env.contract.id(), "storage_unregister")
        .args_json(json!({}))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?;
    assert!(outcome.is_failure());
    assert!(format!("{:?}", outcome.into_result().unwrap_err()).contains("AccountHasState"));
    Ok(())
}

#[tokio::test]
async fn gameplay_works_from_a_depositless_function_call_key() -> anyhow::Result<()> {
    let env = setup().await?;
    let alice = env.registered_user(NearToken::from_millinear(100)).await?;

    // Session key: may only call the game contract, can't attach deposit.
    let session_sk = SecretKey::from_random(KeyType::ED25519);
    alice
        .batch(alice.id())
        .add_key(
            session_sk.public_key(),
            AccessKey::function_call_access(env.contract.id(), &[], Some(NearToken::from_millinear(250))),
        )
        .transact()
        .await?
        .into_result()?;
    let alice_session = Account::from_secret_key(alice.id().clone(), session_sk, &env.worker);

    let ids = request(&alice_session, &env.contract, 2).await?;
    assert_eq!(ids.len(), 2);
    let r = get_request(&env.contract, &ids[1]).await?;
    assert!(!r["resolved_at_height"].is_null());
    Ok(())
}

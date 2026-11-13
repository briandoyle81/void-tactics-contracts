//! Phase 2 on a real sandbox node: NEAR purchases (self-funded storage,
//! construction via the callback), ship transfers (storage deposit moves with
//! the ship), and nft_transfer_call against hostile receivers.

use integration_tests::pricing::{usd_to_yocto, TEST_NEAR_USD_PRICE};
use integration_tests::seed::seed_rules;
use integration_tests::{setup, Env};
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::Account;
use serde_json::{json, Value};

/// Tier 1 ($9.99) at the seeder's fixed test NEAR/USD price.
fn tier1_near() -> u128 {
    usd_to_yocto(9.99, TEST_NEAR_USD_PRICE)
}

async fn buy_tier1(env: &Env, who: &Account) -> anyhow::Result<Vec<String>> {
    Ok(who
        .call(env.contract.id(), "purchase_ships_with_near")
        .args_json(json!({"tier": 1, "variant": 1}))
        .deposit(NearToken::from_yoctonear(tier1_near()))
        .gas(Gas::from_tgas(250))
        .transact()
        .await?
        .into_result()?
        .json()?)
}

async fn owner_of(env: &Env, id: &str) -> anyhow::Result<String> {
    let v: Value = env.contract.view("get_ship").args_json(json!({"ship_id": id})).await?.json()?;
    Ok(v["owner"].as_str().unwrap().to_string())
}

async fn used(env: &Env, who: &near_workspaces::AccountId) -> anyhow::Result<u64> {
    Ok(env.contract.view("storage_used_bytes").args_json(json!({"account_id": who})).await?.json::<Option<u64>>()?.unwrap_or(0))
}

#[tokio::test]
async fn near_purchase_registers_pays_own_storage_and_constructs() -> anyhow::Result<()> {
    let env = setup().await?;
    seed_rules(env.contract.as_account(), &env.contract).await?;
    let alice = env.worker.dev_create_account().await?; // never registered
    let storage0 = env.contract_storage_usage().await?;

    let ids = buy_tier1(&env, &alice).await?;
    assert_eq!(ids.len(), 11);
    for id in &ids {
        let v: Value = env.contract.view("get_ship").args_json(json!({"ship_id": id})).await?.json()?;
        assert_eq!(v["ship"]["ship_data"]["constructed"], true, "{v}");
    }
    let storage1 = env.contract_storage_usage().await?;
    assert_eq!(used(&env, alice.id()).await?, storage1 - storage0, "every byte (registration included) is alice's");
    let bal: Value = env.contract.view("storage_balance_of").args_json(json!({"account_id": alice.id()})).await?.json()?;
    let t: Value = env.contract.view("get_treasury").await?.json()?;
    let deposit: u128 = bal["total"].as_str().unwrap().parse()?;
    let revenue: u128 = t["revenue_near"].as_str().unwrap().parse()?;
    assert_eq!(deposit + revenue, tier1_near(), "price = prepaid storage + revenue");
    Ok(())
}

#[tokio::test]
async fn transfer_moves_ship_and_its_storage_deposit() -> anyhow::Result<()> {
    let env = setup().await?;
    seed_rules(env.contract.as_account(), &env.contract).await?;
    let alice = env.worker.dev_create_account().await?;
    let bob = env.worker.dev_create_account().await?;
    let ids = buy_tier1(&env, &alice).await?;
    buy_tier1(&env, &bob).await?;

    let storage0 = env.contract_storage_usage().await?;
    let (a0, b0) = (used(&env, alice.id()).await?, used(&env, bob.id()).await?);
    let bob_bal0: Value = env.contract.view("storage_balance_of").args_json(json!({"account_id": bob.id()})).await?.json()?;
    alice
        .call(env.contract.id(), "nft_transfer")
        .args_json(json!({"receiver_id": bob.id(), "token_id": ids[4]}))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?
        .into_result()?;
    assert_eq!(owner_of(&env, &ids[4]).await?, bob.id().to_string());
    let storage1 = env.contract_storage_usage().await?;
    let (a1, b1) = (used(&env, alice.id()).await?, used(&env, bob.id()).await?);
    assert_eq!((a1 + b1) as i64 - (a0 + b0) as i64, storage1 as i64 - storage0 as i64, "ledger tracks the real delta");
    let bob_bal1: Value = env.contract.view("storage_balance_of").args_json(json!({"account_id": bob.id()})).await?.json()?;
    assert_eq!(bob_bal0["available"], bob_bal1["available"], "receiver's spendable storage untouched");
    Ok(())
}

#[tokio::test]
async fn transfer_call_survives_hostile_receivers() -> anyhow::Result<()> {
    let env = setup().await?;
    seed_rules(env.contract.as_account(), &env.contract).await?;
    let alice = env.worker.dev_create_account().await?;
    let ids = buy_tier1(&env, &alice).await?;

    let wasm = std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/../target/near/test-hooks/test_receiver.wasm"))?;
    let receiver = env.worker.dev_deploy(&wasm).await?;
    receiver.call("new").transact().await?.into_result()?;
    alice
        .call(env.contract.id(), "storage_deposit")
        .args_json(json!({"account_id": receiver.id()}))
        .deposit(NearToken::from_millinear(100))
        .transact()
        .await?
        .into_result()?;
    env.contract
        .call("test_set_purchased")
        .args_json(json!({"account_id": receiver.id(), "amount": "10"}))
        .transact()
        .await?
        .into_result()?;

    let storage0 = env.contract_storage_usage().await?;
    let (a0, r0) = (used(&env, alice.id()).await?, used(&env, receiver.id()).await?);
    // (msg, ship stays with receiver?)
    let cases = [("keep", true), ("return", false), ("panic", false), ("junk", false), ("gas", false)];
    for (i, (msg, kept)) in cases.iter().enumerate() {
        let id = &ids[i + 2];
        let out = alice
            .call(env.contract.id(), "nft_transfer_call")
            .args_json(json!({"receiver_id": receiver.id(), "token_id": id, "msg": msg}))
            .deposit(NearToken::from_yoctonear(1))
            .gas(Gas::from_tgas(300))
            .transact()
            .await?;
        assert!(out.is_success(), "{msg}: outer call must succeed: {:?}", out.failures());
        let want = if *kept { receiver.id().to_string() } else { alice.id().to_string() };
        assert_eq!(owner_of(&env, id).await?, want, "{msg}");
    }
    let storage1 = env.contract_storage_usage().await?;
    let (a1, r1) = (used(&env, alice.id()).await?, used(&env, receiver.id()).await?);
    assert_eq!((a1 + r1) as i64 - (a0 + r0) as i64, storage1 as i64 - storage0 as i64, "no bytes lost across returns");
    Ok(())
}

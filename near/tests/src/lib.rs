//! Shared sandbox helpers for near-workspaces integration tests.

pub mod policy;
pub mod seed;

use anyhow::{Context, Result};
use near_workspaces::network::Sandbox;
use near_workspaces::types::NearToken;
use near_workspaces::{Account, Contract, Worker};
use serde_json::json;

pub const TEST_WASM: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../target/near/test-hooks/void_tactics.wasm"
);

pub struct Env {
    pub worker: Worker<Sandbox>,
    pub contract: Contract,
}

/// Deploys a fresh, initialized contract built with `test-hooks`
/// (run `near/scripts/build-test-wasm.sh` first).
pub async fn setup() -> Result<Env> {
    let wasm = std::fs::read(TEST_WASM)
        .with_context(|| format!("missing {TEST_WASM}; run near/scripts/build-test-wasm.sh"))?;
    let worker = near_workspaces::sandbox().await?;
    let contract = worker.dev_deploy(&wasm).await?;
    contract
        .call("new")
        .args_json(json!({ "owner_id": contract.id() }))
        .transact()
        .await?
        .into_result()?;
    Ok(Env { worker, contract })
}

impl Env {
    pub async fn registered_user(&self, deposit: NearToken) -> Result<Account> {
        let user = self.worker.dev_create_account().await?;
        user.call(self.contract.id(), "storage_deposit")
            .args_json(json!({}))
            .deposit(deposit)
            .transact()
            .await?
            .into_result()?;
        Ok(user)
    }

    pub async fn contract_storage_usage(&self) -> Result<u64> {
        Ok(self.contract.view_account().await?.storage_usage)
    }

    pub async fn used_bytes(&self, account: &Account) -> Result<u64> {
        Ok(self
            .contract
            .view("storage_used_bytes")
            .args_json(json!({ "account_id": account.id() }))
            .await?
            .json::<Option<u64>>()?
            .context("account not registered")?)
    }
}

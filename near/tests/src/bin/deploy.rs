//! Deploys and seeds Void Tactics on a real NEAR network (testnet/mainnet),
//! like ignition/modules/DeployAndConfig.ts with PRODUCTION = true:
//!   1. deploy the game + renderer release WASM to existing accounts,
//!   2. init with the owner (a separate account: multisig/DAO in production),
//!   3. seed rules (ship prices from the LIVE NEAR/USD price, cached 24h),
//!      the single-player and roguelike campaigns, PvP maps, renderer names,
//!   4. point the game at the renderer and NFT base URI,
//!   5. optionally delete both accounts' full-access keys, leaving the owner's
//!      `upgrade` as the only way to change code.
//!
//! Build the release WASM first:
//!   cargo near build non-reproducible-wasm --manifest-path contracts/void-tactics/Cargo.toml --out-dir target/near/release
//!   cargo near build non-reproducible-wasm --manifest-path contracts/void-renderer/Cargo.toml --out-dir target/near/release
//! Then (keys from ~/.near-credentials/<network>/<account>.json):
//!   cargo run -p integration-tests --bin deploy -- --network testnet \
//!     --game game.example.testnet --renderer art.example.testnet --owner admin.example.testnet \
//!     --base-uri https://www.voidtactics.xyz/api/ship [--delete-keys]
//! Mainnet additionally requires --i-understand-this-is-mainnet.
//!
//! Written 2026-11-13. Never run against a live network without the project
//! owner's explicit go-ahead for that specific deploy.

use std::path::PathBuf;

use anyhow::{bail, Context, Result};
use integration_tests::pricing::NearUsd;
use integration_tests::seed::seed_all;
use near_workspaces::{Account, Worker};
use serde_json::json;

struct Args {
    network: String,
    game: String,
    renderer: String,
    owner: String,
    base_uri: Option<String>,
    delete_keys: bool,
    mainnet_ok: bool,
    credentials: Option<PathBuf>,
}

fn parse() -> Result<Args> {
    let mut a = Args { network: String::new(), game: String::new(), renderer: String::new(), owner: String::new(), base_uri: None, delete_keys: false, mainnet_ok: false, credentials: None };
    let mut it = std::env::args().skip(1);
    while let Some(k) = it.next() {
        let mut val = || it.next().context(format!("{k} needs a value"));
        match k.as_str() {
            "--network" => a.network = val()?,
            "--game" => a.game = val()?,
            "--renderer" => a.renderer = val()?,
            "--owner" => a.owner = val()?,
            "--base-uri" => a.base_uri = Some(val()?),
            "--credentials-dir" => a.credentials = Some(PathBuf::from(val()?)),
            "--delete-keys" => a.delete_keys = true,
            "--i-understand-this-is-mainnet" => a.mainnet_ok = true,
            other => bail!("unknown argument {other}"),
        }
    }
    if a.game.is_empty() || a.renderer.is_empty() || a.owner.is_empty() {
        bail!("--game, --renderer and --owner are required");
    }
    if a.delete_keys && (a.owner == a.game || a.owner == a.renderer) {
        bail!("--delete-keys with the owner == a contract account would freeze the code forever; use a separate owner");
    }
    Ok(a)
}

fn key_file(a: &Args, account: &str) -> PathBuf {
    let dir = a.credentials.clone().unwrap_or_else(|| {
        PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".near-credentials").join(&a.network)
    });
    dir.join(format!("{account}.json"))
}

fn release_wasm(name: &str) -> Result<Vec<u8>> {
    let p = format!("{}/../target/near/release/{name}.wasm", env!("CARGO_MANIFEST_DIR"));
    std::fs::read(&p).with_context(|| format!("missing {p}: build the release WASM first"))
}

async fn run<T: near_workspaces::Network + Send + Sync + 'static>(worker: Worker<T>, a: Args) -> Result<()> {
    // near-cli-rs legacy keychain files carry `private_key` (older near-cli:
    // `secret_key`) but not always `account_id`, so read the key ourselves.
    let load = |id: &str| -> Result<Account> {
        let path = key_file(&a, id);
        let raw = std::fs::read_to_string(&path).with_context(|| format!("missing key file {}", path.display()))?;
        let v: serde_json::Value = serde_json::from_str(&raw).with_context(|| format!("bad key file {}", path.display()))?;
        let sk = v["private_key"].as_str().or(v["secret_key"].as_str()).with_context(|| format!("no private_key in {}", path.display()))?;
        Ok(Account::from_secret_key(id.parse()?, sk.parse()?, &worker))
    };
    let (game_acc, renderer_acc, owner) = (load(&a.game)?, load(&a.renderer)?, load(&a.owner)?);

    eprintln!("deploying game to {} and renderer to {}", a.game, a.renderer);
    let game = game_acc.deploy(&release_wasm("void_tactics")?).await?.into_result()?;
    let renderer = renderer_acc.deploy(&release_wasm("void_renderer")?).await?.into_result()?;
    game.call("new").args_json(json!({"owner_id": a.owner})).transact().await?.into_result()?;
    renderer.call("new").args_json(json!({"owner_id": a.owner})).transact().await?.into_result()?;

    // Seeding is owner-gated; contract handles are only used for their ids.
    let seed = seed_all(&owner, &game, Some(&renderer), NearUsd::Live).await?;
    owner
        .call(game.id(), "set_render_config")
        .args_json(json!({"renderer": a.renderer, "nft_base_uri": a.base_uri}))
        .transact()
        .await?
        .into_result()?;

    if a.delete_keys {
        for acc in [&game_acc, &renderer_acc] {
            let pk = acc.secret_key().public_key();
            acc.batch(acc.id()).delete_key(pk).transact().await?.into_result()?;
            eprintln!("deleted full-access key of {}", acc.id());
        }
    }
    eprintln!(
        "done: {} campaign nodes, roguelike campaign {}, {} PvP maps; owner {}",
        seed.single_player.node_ids.len(),
        seed.roguelike_campaign,
        seed.pvp_maps.len(),
        a.owner
    );
    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    let a = parse()?;
    match a.network.as_str() {
        "testnet" => run(near_workspaces::testnet().await?, a).await,
        "mainnet" => {
            if !a.mainnet_ok {
                bail!("mainnet deploy requires --i-understand-this-is-mainnet");
            }
            run(near_workspaces::mainnet().await?, a).await
        }
        other => bail!("--network must be testnet or mainnet, not {other:?}"),
    }
}

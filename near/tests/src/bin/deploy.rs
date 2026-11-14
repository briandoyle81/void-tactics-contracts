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
//! Modes: default = fresh deploy + seed; `--upgrade` = owner `upgrade` with
//! the new game WASM (state migrated, nothing reseeded); `--record-only` =
//! just verify ids and write the record. Every mode checks each seeded id on
//! chain and writes near/deployments/<network>.json for the frontend.
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
use integration_tests::deployment;
use integration_tests::seed::{plan_all, seed_all};
use near_workspaces::types::Gas;
use near_workspaces::Contract;
use sha2::{Digest, Sha256};
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
    mode: Mode,
    /// RPC endpoint override (the default public endpoints rate-limit).
    rpc: Option<String>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    /// Fresh deploy + init + seed (accounts must hold no contract state).
    Deploy,
    /// Owner calls `upgrade` with the new game WASM; `migrate` keeps state.
    Upgrade,
    /// Only verify the seeded ids against the chain and write the record.
    RecordOnly,
}

fn parse() -> Result<Args> {
    let mut a = Args { network: String::new(), game: String::new(), renderer: String::new(), owner: String::new(), base_uri: None, delete_keys: false, mainnet_ok: false, credentials: None, mode: Mode::Deploy, rpc: None };
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
            "--upgrade" => a.mode = Mode::Upgrade,
            "--record-only" => a.mode = Mode::RecordOnly,
            "--rpc" => a.rpc = Some(val()?),
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

    let (game, seed) = match a.mode {
        Mode::Deploy => {
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
            (game, seed)
        }
        Mode::Upgrade | Mode::RecordOnly => {
            let game = Contract::from_secret_key(game_acc.id().clone(), game_acc.secret_key().clone(), &worker);
            if a.mode == Mode::Upgrade {
                let wasm = release_wasm("void_tactics")?;
                eprintln!("upgrading {} ({} bytes) through the owner's `upgrade`", a.game, wasm.len());
                let out = owner.call(game.id(), "upgrade").args(wasm).gas(Gas::from_tgas(300)).transact().await?;
                if !out.is_success() {
                    bail!("upgrade failed: {:?}", out.failures());
                }
                // The renderer too, when its on-chain code differs from the build.
                let new_art = release_wasm("void_renderer")?;
                let live_art = worker.view_code(renderer_acc.id()).await?;
                if Sha256::digest(&live_art) != Sha256::digest(&new_art) {
                    eprintln!("upgrading {} ({} bytes) through the owner's `upgrade`", a.renderer, new_art.len());
                    let out = owner.call(renderer_acc.id(), "upgrade").args(new_art).gas(Gas::from_tgas(300)).transact().await?;
                    if !out.is_success() {
                        bail!("renderer upgrade failed: {:?}", out.failures());
                    }
                } else {
                    eprintln!("renderer code unchanged; not upgrading it");
                }
            }
            eprintln!("planning the seed ids");
            let seed = plan_all(&owner, &game).await?;
            (game, seed)
        }
    };

    eprintln!("verifying {} seeded ids on chain", seed.single_player.node_ids.len() + seed.roguelike.node_ids.len());
    let checked = deployment::verify(&game, &seed).await?;
    let mut hashes = std::collections::BTreeMap::new();
    for id in [&a.game, &a.renderer] {
        let code = worker.view_code(&id.parse()?).await?;
        hashes.insert(id.clone(), format!("{:x}", Sha256::digest(&code)));
    }
    let record = deployment::Record::new(&a.network, &a.game, &a.renderer, &a.owner, hashes, &seed);
    let out = format!("{}/../deployments/{}.json", env!("CARGO_MANIFEST_DIR"), a.network);
    std::fs::create_dir_all(format!("{}/../deployments", env!("CARGO_MANIFEST_DIR")))?;
    std::fs::write(&out, serde_json::to_string_pretty(&record)? + "\n")?;
    eprintln!("verified {checked} seeded ids on chain; wrote {out}");

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
        "testnet" => {
            let w = match &a.rpc {
                Some(url) => near_workspaces::testnet().rpc_addr(url).await?,
                None => near_workspaces::testnet().await?,
            };
            run(w, a).await
        }
        "mainnet" => {
            if !a.mainnet_ok {
                bail!("mainnet deploy requires --i-understand-this-is-mainnet");
            }
            let w = match &a.rpc {
                Some(url) => near_workspaces::mainnet().rpc_addr(url).await?,
                None => near_workspaces::mainnet().await?,
            };
            run(w, a).await
        }
        other => bail!("--network must be testnet or mainnet, not {other:?}"),
    }
}

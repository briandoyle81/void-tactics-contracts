//! Phase 5 on a real sandbox node: deploy the renderer (checks it fits the
//! deploy transaction), seed names, and render a ship minted on the game
//! contract through views only, the way a frontend or base_uri gateway does.

use base64::Engine;
use integration_tests::seed::{seed_renderer, seed_rules};
use integration_tests::setup;
use near_workspaces::types::{Gas, NearToken};
use serde_json::{json, Value};

fn decode_data_uri(uri: &str, prefix: &str) -> Vec<u8> {
    assert!(uri.starts_with(prefix), "{}", &uri[..40.min(uri.len())]);
    base64::engine::general_purpose::STANDARD.decode(&uri[prefix.len()..]).unwrap()
}

#[tokio::test]
async fn renders_a_minted_ship_through_views() -> anyhow::Result<()> {
    let env = setup().await?;
    seed_rules(env.contract.as_account(), &env.contract).await?;
    let wasm = std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/../target/near/test-hooks/void_renderer.wasm"))?;
    eprintln!("renderer wasm: {} KB", wasm.len() / 1024);
    let renderer = env.worker.dev_deploy(&wasm).await?;
    renderer.call("new").args_json(json!({"owner_id": renderer.id()})).transact().await?.into_result()?;
    seed_renderer(renderer.as_account(), &renderer).await?;
    env.contract
        .call("set_render_config")
        .args_json(json!({"renderer": renderer.id(), "nft_base_uri": "https://www.voidtactics.xyz/api/ship"}))
        .transact()
        .await?
        .into_result()?;

    let alice = env.registered_user(NearToken::from_near(1)).await?;
    alice.call(env.contract.id(), "claim_free_ships").args_json(json!({"variant": 1})).gas(Gas::from_tgas(200)).transact().await?.into_result()?;

    // Frontend / gateway path: ship from the game contract -> renderer views.
    let view: Value = env.contract.view("get_ship").args_json(json!({"ship_id": "1"})).await?.json()?;
    let ship = &view["ship"];
    let uri: String = renderer.view("token_uri").args_json(json!({"ship": ship})).await?.json()?;
    let meta: Value = serde_json::from_slice(&decode_data_uri(&uri, "data:application/json;base64,"))?;
    assert_eq!(meta["name"], format!("{} #1", ship["name"].as_str().unwrap()));
    let svg = decode_data_uri(meta["image"].as_str().unwrap(), "data:image/svg+xml;base64,");
    let svg = String::from_utf8(svg)?;
    assert!(svg.starts_with("<svg") && svg.ends_with("</svg>"));
    let weapon = meta["attributes"].as_array().unwrap().iter().find(|a| a["trait_type"] == "Main Weapon").unwrap();
    assert_ne!(weapon["value"], "Unknown", "names seeded");

    // NEP-177 wiring for marketplaces.
    let md: Value = env.contract.view("nft_metadata").await?.json()?;
    assert_eq!(md["base_uri"], "https://www.voidtactics.xyz/api/ship");
    let tok: Value = env.contract.view("nft_token").args_json(json!({"token_id": "1"})).await?.json()?;
    assert_eq!(tok["metadata"]["media"], "1");

    let medal: String = renderer.view("medal_token_uri").args_json(json!({"token_id": "1"})).await?.json()?;
    let m: Value = serde_json::from_slice(&decode_data_uri(&medal, "data:application/json;base64,"))?;
    assert_eq!(m["name"], "Shattered Hive Campaign Medal #1");
    eprintln!("rendered ship #1: {} bytes of SVG", svg.len());
    Ok(())
}

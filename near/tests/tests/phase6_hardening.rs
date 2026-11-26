//! Phase 6 hardening on a real sandbox node:
//!   - full seed (everything the Solidity deploy seeds) fits in batched txs;
//!   - upgrade drill: owner-only, state survives, works with the contract
//!     account's full-access keys deleted (the production key posture);
//!   - gas budgets for the heaviest calls and views.

use integration_tests::policy::{choose_human_move, LocalRules};
use integration_tests::pricing::NearUsd;
use integration_tests::deployment;
use integration_tests::seed::{plan_all, seed_all, seed_rules};
use integration_tests::TEST_WASM;
use near_workspaces::types::{Gas, NearToken};
use serde_json::{json, Value};
use vt_core::engine::{GameState, Side};

const PROBE_WASM: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../target/near/upgrade-probe/void_tactics.wasm");

#[tokio::test]
async fn full_seed_matches_the_solidity_deploy() -> anyhow::Result<()> {
    let env = integration_tests::setup().await?;
    let before = env.contract_storage_usage().await?;
    let seed = seed_all(env.contract.as_account(), &env.contract, None, NearUsd::Test).await?;
    let after = env.contract_storage_usage().await?;
    eprintln!("contract storage: code+init {before} bytes, after full seed {after} bytes (seed = {} bytes = {:.2} NEAR)", after - before, (after - before) as f64 / 100_000.0);
    let maps: String = env.contract.view("get_map_count").await?.json()?;
    let configs: String = env.contract.view("get_ai_config_count").await?.json()?;
    // 30 campaign + 36 roguelike + 6 PvP maps; the deploy's 64 AI configs.
    assert_eq!(maps, "72");
    assert_eq!(configs, "64");
    assert_eq!(seed.single_player.node_ids.len(), 30);
    assert_eq!(seed.pvp_maps.len(), 6);
    let root: Value = env.contract.view("get_rl_campaign").args_json(json!({"campaign_id": seed.roguelike_campaign.to_string()})).await?.json()?;
    assert_ne!(root["root_node"], 0);

    // The deployment record: the dry-run plan reproduces every id the real
    // seed assigned, and the on-chain check accepts it...
    let plan = plan_all(env.contract.as_account(), &env.contract).await?;
    assert_eq!(plan.single_player.map_ids, seed.single_player.map_ids);
    assert_eq!(plan.single_player.config_ids, seed.single_player.config_ids);
    assert_eq!(plan.single_player.node_ids, seed.single_player.node_ids);
    assert_eq!(plan.roguelike.map_ids, seed.roguelike.map_ids);
    assert_eq!(plan.roguelike.config_ids, seed.roguelike.config_ids);
    assert_eq!(plan.roguelike.node_ids, seed.roguelike.node_ids);
    assert_eq!(plan.roguelike.campaign_id, seed.roguelike.campaign_id);
    assert_eq!(plan.pvp_maps, seed.pvp_maps);
    let s: Value = env.contract.view("get_settings").await?.json()?;
    assert_eq!(s["medal_final_node"], json!(seed.single_player.node_ids["f06"].to_string()), "medal final node seeded as on Base");
    // The medal for winning a run (2026-11-21): both roguelike endings, and
    // no other node, carry the HiveMedal win effect.
    let rl_content = vt_integration_seed_json();
    let endings = integration_tests::seed::rl_ending_keys(&rl_content);
    assert_eq!(endings.len(), 2, "two Hive endings");
    for (key, id) in &seed.roguelike.node_ids {
        let node: Value = env.contract.view("get_rl_node").args_json(json!({"node_id": id.to_string()})).await?.json()?;
        let has_medal = node["win_effects"].as_array().unwrap().iter().any(|e| e == "HiveMedal");
        assert_eq!(has_medal, endings.contains(key), "node {key}");
    }
    let checked = deployment::verify(&env.contract, &seed).await?;
    eprintln!("deployment record: {checked} ids verified on chain");
    // ...and rejects a record with two ids swapped.
    let mut bad = plan;
    let (a, b) = (bad.single_player.node_ids["m01"], bad.single_player.node_ids["m05"]);
    bad.single_player.node_ids.insert("m01".into(), b);
    bad.single_player.node_ids.insert("m05".into(), a);
    assert!(deployment::verify(&env.contract, &bad).await.is_err(), "a swapped id must fail verification");
    Ok(())
}

#[tokio::test]
async fn upgrade_drill_with_full_access_keys_deleted() -> anyhow::Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let admin = worker.dev_create_account().await?; // production: a multisig/DAO
    let game = worker.dev_deploy(&std::fs::read(TEST_WASM)?).await?;
    game.call("new").args_json(json!({"owner_id": admin.id()})).transact().await?.into_result()?;
    let env = integration_tests::Env { worker: worker.clone(), contract: game.clone() };
    // Rules are owner-gated: seed as admin.
    seed_rules(&admin, &game).await?;
    let alice = env.registered_user(NearToken::from_near(1)).await?;
    alice.call(game.id(), "claim_free_ships").args_json(json!({"variant": 1})).gas(Gas::from_tgas(200)).transact().await?.into_result()?;
    let ship_before: Value = game.view("get_ship").args_json(json!({"ship_id": "3"})).await?.json()?;
    let bal_before: Value = game.view("storage_balance_of").args_json(json!({"account_id": alice.id()})).await?.json()?;

    // Production key posture: delete the contract account's full-access key.
    let pk = game.as_account().secret_key().public_key();
    game.as_account().batch(game.id()).delete_key(pk).transact().await?.into_result()?;
    let direct = game.as_account().deploy(&std::fs::read(TEST_WASM)?).await;
    assert!(direct.is_err() || direct.unwrap().is_failure(), "no key: direct redeploy impossible");

    let probe = std::fs::read(PROBE_WASM)?;
    let denied = alice.call(game.id(), "upgrade").args(probe.clone()).gas(Gas::from_tgas(300)).transact().await?;
    assert!(denied.is_failure(), "only the owner upgrades");
    admin.call(game.id(), "upgrade").args(probe).gas(Gas::from_tgas(300)).transact().await?.into_result()?;

    let v: String = game.view("upgrade_probe").await?.json()?;
    assert_eq!(v, "v2", "new code live");
    let ship_after: Value = game.view("get_ship").args_json(json!({"ship_id": "3"})).await?.json()?;
    let bal_after: Value = game.view("storage_balance_of").args_json(json!({"account_id": alice.id()})).await?.json()?;
    assert_eq!(ship_before, ship_after, "state survives the upgrade");
    assert_eq!(bal_before, bal_after);
    // And gameplay still works on the upgraded contract.
    // Fails cleanly (no DEC), proving calls still dispatch on the new code.
    let r = alice.call(game.id(), "turn_in_cores").args_json(json!({"amount": "10"})).transact().await?;
    assert!(r.is_failure());
    let ships: Vec<Value> = game.view("get_ships_for_owner").args_json(json!({"account_id": alice.id()})).await?.json()?;
    assert_eq!(ships.len(), 10);
    Ok(())
}

#[tokio::test]
async fn gas_budgets_on_the_heaviest_encounter() -> anyhow::Result<()> {
    let env = integration_tests::setup().await?;
    let owner = env.contract.as_account();
    let seed = seed_all(owner, &env.contract, None, NearUsd::Test).await?;

    // The map with the most AI placements (14), as a fresh unlocked node.
    let mut best = (0u64, 0usize);
    for &map in seed.single_player.map_ids.values() {
        let p: Vec<Value> = env.contract.view("get_map_placements").args_json(json!({"map_id": map.to_string()})).await?.json()?;
        if p.len() > best.1 {
            best = (map, p.len());
        }
    }
    assert_eq!(best.1, 14);
    let node: String = owner
        .call(env.contract.id(), "create_node")
        .args_json(json!({"node": {"campaign_id": 1, "map_id": best.0, "prerequisites": [], "cost_limit": 2000, "turn_time": 600,
                                   "max_score": 1000, "creator_goes_first": true}}))
        .transact()
        .await?
        .into_result()?
        .json()?;

    let alice = env.registered_user(NearToken::from_near(5)).await?;
    let bob = env.registered_user(NearToken::from_near(1)).await?;
    let price: Vec<Value> = env.contract.view("get_price_tiers").await?.json()?;
    let buy = alice
        .call(env.contract.id(), "purchase_ships_with_near")
        .args_json(json!({"tier": 4, "variant": 1}))
        .deposit(NearToken::from_yoctonear(price[4]["near_ship_price"].as_str().unwrap().parse()?))
        .gas(Gas::from_tgas(300))
        .transact()
        .await?;
    let buy_gas = buy.total_gas_burnt;
    buy.into_result()?;

    // Widest legal human fleet: cheapest ships under the 2000 cap, max 8,
    // inside the map's creator zone.
    let ships: Vec<Value> = env.contract.view("get_ships_for_owner").args_json(json!({"account_id": alice.id(), "limit": 100})).await?.json()?;
    let mut v: Vec<(u64, u64)> = ships.iter().map(|s| (s["ship"]["ship_data"]["cost"].as_u64().unwrap(), s["ship"]["id"].as_u64().unwrap())).collect();
    v.sort();
    let (mut fleet, mut total) = (vec![], 0);
    for (c, id) in v {
        if fleet.len() < 8 && total + c <= 2000 {
            fleet.push(id.to_string());
            total += c;
        }
    }
    let map: Value = env.contract.view("get_preset_map").args_json(json!({"map_id": best.0.to_string()})).await?.json()?;
    let zone: Vec<u64> = map["creator_zone"].as_array().unwrap().iter().map(|l| l.as_u64().unwrap()).collect();
    let mut cells: Vec<(i64, i64)> = (0..187).filter(|&i| (zone[i / 64] >> (i % 64)) & 1 == 1).map(|i| ((i / 17) as i64, (i % 17) as i64)).collect();
    if cells.is_empty() {
        cells = (0..11).flat_map(|r| (0..4).map(move |c| (r, c))).collect();
    }
    let step = (cells.len() / fleet.len()).max(1);
    let positions: Vec<Value> = (0..fleet.len()).map(|i| json!({"row": cells[i * step].0, "col": cells[i * step].1})).collect();
    let start = alice
        .call(env.contract.id(), "start_node_match")
        .args_json(json!({"node_id": node, "ship_ids": fleet, "positions": positions}))
        .gas(Gas::from_tgas(300))
        .transact()
        .await?;
    let start_gas = start.total_gas_burnt;
    let game: String = start.into_result()?.json()?;

    let rules = LocalRules::from_seed_config();
    let (mut max_ai, mut max_move) = (Gas::from_gas(0), Gas::from_gas(0));
    for _ in 0..60 {
        let g: GameState = env.contract.view("get_game").args_json(json!({"game_id": game})).await?.json()?;
        if g.ended {
            break;
        }
        if g.current_turn == Side::Creator {
            let m = choose_human_move(&g, &rules).unwrap();
            let out = alice
                .call(env.contract.id(), "move_ship")
                .args_json(json!({"game_id": game, "ship_id": m.ship_id.to_string(), "new_row": m.new_row, "new_col": m.new_col,
                                  "action": m.action, "target_ship_id": m.target_ship_id.to_string()}))
                .gas(Gas::from_tgas(300))
                .transact()
                .await?;
            max_move = max_move.max(out.total_gas_burnt);
            out.into_result()?;
        } else {
            let out = bob
                .call(env.contract.id(), "take_ai_turns")
                .args_json(json!({"game_id": game, "max_moves": 8}))
                .gas(Gas::from_tgas(300))
                .transact()
                .await?;
            max_ai = max_ai.max(out.total_gas_burnt);
            out.into_result()?;
        }
    }

    // Heaviest views must stay under the view gas limit (they error if not).
    let _: Value = env.contract.view("get_game").args_json(json!({"game_id": game})).await?.json()?;
    let _: Vec<Value> = env.contract.view("get_ships_for_owner").args_json(json!({"account_id": alice.id(), "limit": 100})).await?.json()?;
    let _: Vec<Value> = env.contract.view("nft_tokens_for_owner").args_json(json!({"account_id": alice.id(), "limit": 100})).await?.json()?;

    eprintln!(
        "gas: buy 60 ships + construct {} Tgas | start 14-AI match {} Tgas | max move {} Tgas | max take_ai_turns(8) {} Tgas",
        buy_gas.as_tgas(),
        start_gas.as_tgas(),
        max_move.as_tgas(),
        max_ai.as_tgas()
    );
    // Budgets: well under the 1 PGas per-receipt limit, and under the 300 Tgas
    // clients attach by default.
    assert!(buy_gas.as_tgas() < 300 && start_gas.as_tgas() < 150);
    assert!(max_move.as_tgas() < 100 && max_ai.as_tgas() < 150);
    Ok(())
}

const RENDERER_WASM: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../target/near/test-hooks/void_renderer.wasm");

#[tokio::test]
async fn renderer_ownership_moves_in_two_steps_and_upgrades_keep_its_names() -> anyhow::Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let admin = worker.dev_create_account().await?;
    let multisig = worker.dev_create_account().await?;
    let renderer = worker.dev_deploy(&std::fs::read(RENDERER_WASM)?).await?;
    renderer.call("new").args_json(json!({"owner_id": admin.id()})).transact().await?.into_result()?;
    integration_tests::seed::seed_renderer(&admin, &renderer).await?;
    let args = json!({"variant": 1, "kind": "MainWeapon", "index": 0});
    let before: Option<String> = renderer.view("get_name").args_json(args.clone()).await?.json()?;
    assert!(before.is_some());

    admin.call(renderer.id(), "upgrade").args(std::fs::read(RENDERER_WASM)?).gas(Gas::from_tgas(300)).transact().await?.into_result()?;
    let after: Option<String> = renderer.view("get_name").args_json(args.clone()).await?.json()?;
    assert_eq!(after, before, "names survive an upgrade");

    admin.call(renderer.id(), "transfer_ownership").args_json(json!({"new_owner": multisig.id()})).transact().await?.into_result()?;
    let stranger = worker.dev_create_account().await?;
    assert!(stranger.call(renderer.id(), "accept_ownership").transact().await?.is_failure(), "only the nominee accepts");
    multisig.call(renderer.id(), "accept_ownership").transact().await?.into_result()?;
    let owner: String = renderer.view("owner_id").await?.json()?;
    assert_eq!(owner, multisig.id().as_str());
    let denied = admin.call(renderer.id(), "set_names").args_json(json!({"entries": []})).transact().await?;
    assert!(denied.is_failure(), "the old owner is out");
    multisig.call(renderer.id(), "upgrade").args(std::fs::read(RENDERER_WASM)?).gas(Gas::from_tgas(300)).transact().await?.into_result()?;
    let still: Option<String> = renderer.view("get_name").args_json(args).await?.json()?;
    assert_eq!(still, before);
    Ok(())
}

fn vt_integration_seed_json() -> Value {
    let path = integration_tests::seed::repo_path("ignition/data/roguelikeStarterContent.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

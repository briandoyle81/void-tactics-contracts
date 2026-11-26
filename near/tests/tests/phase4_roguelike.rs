//! Phase 4 on a real sandbox node: the seeded roguelike campaign
//! (ignition/data/roguelikeStarterContent.json): start a run, fight the root
//! node against the on-chain AI (a second account drives the AI), and check
//! the run outcome plus storage attribution (everything to the player).

use integration_tests::policy::{choose_move, LocalRules};
use integration_tests::seed::{seed_roguelike, seed_rules, seed_single_player};
use integration_tests::setup;
use near_workspaces::types::{Gas, NearToken};
use serde_json::{json, Value};
use vt_core::engine::{GameState, Side};

#[tokio::test]
async fn seeded_roguelike_root_fight() -> anyhow::Result<()> {
    let env = setup().await?;
    let owner = env.contract.as_account();
    seed_rules(owner, &env.contract).await?;
    let sp = seed_single_player(owner, &env.contract, 30).await?; // shared maps/configs
    let campaign = seed_roguelike(owner, &env.contract, Some(&sp)).await?;
    let c: Value = env.contract.view("get_rl_campaign").args_json(json!({"campaign_id": campaign.to_string()})).await?.json()?;
    let cap = c["initial_cost_cap"].as_u64().unwrap();

    let p = env.registered_user(NearToken::from_near(2)).await?;
    let bob = env.registered_user(NearToken::from_near(1)).await?;
    p.call(env.contract.id(), "claim_free_ships").args_json(json!({"variant": 1})).gas(Gas::from_tgas(200)).transact().await?.into_result()?;
    let ships: Vec<Value> = env.contract.view("get_ships_for_owner").args_json(json!({"account_id": p.id()})).await?.json()?;
    let mut v: Vec<(u64, u64)> = ships.iter().map(|s| (s["ship"]["ship_data"]["cost"].as_u64().unwrap(), s["ship"]["id"].as_u64().unwrap())).collect();
    v.sort();
    let (mut roster, mut total) = (vec![], 0);
    for (cost, id) in v {
        if roster.len() < 4 && total + cost <= cap {
            roster.push(id.to_string());
            total += cost;
        }
    }
    let storage0 = env.contract_storage_usage().await?;
    let (p0, b0) = (env.used_bytes(&p).await?, env.used_bytes(&bob).await?);

    let root: String = p
        .call(env.contract.id(), "start_run")
        .args_json(json!({"campaign_id": campaign.to_string(), "ship_ids": roster}))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?
        .json()?;
    // Deploy inside the root map's creator zone (default band if unset).
    let node: Value = env.contract.view("get_rl_node").args_json(json!({"node_id": root})).await?.json()?;
    let map: Value = env.contract.view("get_preset_map").args_json(json!({"map_id": node["map_id"].as_u64().unwrap().to_string()})).await?.json()?;
    let zone: Vec<u64> = map["creator_zone"].as_array().unwrap().iter().map(|l| l.as_u64().unwrap()).collect();
    let mut cells: Vec<(i64, i64)> = (0..187).filter(|&i| (zone[i / 64] >> (i % 64)) & 1 == 1).map(|i| ((i / 17) as i64, (i % 17) as i64)).collect();
    if cells.is_empty() {
        cells = (0..11).flat_map(|r| (0..4).map(move |c| (r, c))).collect();
    }
    let step = cells.len() / roster.len();
    let positions: Vec<Value> = (0..roster.len()).map(|i| json!({"row": cells[i * step].0, "col": cells[i * step].1})).collect();
    let game: String = p
        .call(env.contract.id(), "enter_combat_node")
        .args_json(json!({"node_id": root, "positions": positions}))
        .gas(Gas::from_tgas(300))
        .transact()
        .await?
        .into_result()?
        .json()?;

    let rules = LocalRules::from_seed_config();
    let mut g: GameState;
    let mut turns = 0;
    loop {
        g = env.contract.view("get_game").args_json(json!({"game_id": game})).await?.json()?;
        if g.ended || turns > 400 {
            break;
        }
        turns += 1;
        if g.current_turn == Side::Creator {
            let m = choose_move(&g, &rules, Side::Creator).expect("player can act");
            p.call(env.contract.id(), "move_ship")
                .args_json(json!({"game_id": game, "ship_id": m.ship_id.to_string(), "new_row": m.new_row, "new_col": m.new_col,
                                  "action": m.action, "target_ship_id": m.target_ship_id.to_string()}))
                .gas(Gas::from_tgas(100))
                .transact()
                .await?
                .into_result()?;
        } else {
            bob.call(env.contract.id(), "take_ai_turns")
                .args_json(json!({"game_id": game, "max_moves": 8}))
                .gas(Gas::from_tgas(300))
                .transact()
                .await?
                .into_result()?;
        }
    }
    assert!(g.ended, "fight should finish");

    let run: Value = env.contract.view("get_run").args_json(json!({"account_id": p.id()})).await?.json()?;
    let won = g.winner == Some(Side::Creator);
    if won {
        assert_eq!(run["status"], "Active");
        assert_eq!(run["active_game_id"], 0);
        let defeated: bool = env.contract.view("is_rl_node_defeated").args_json(json!({"account_id": p.id(), "node_id": root})).await?.json()?;
        assert!(defeated);
        assert!(!run["reservation"].as_array().unwrap().is_empty(), "survivors reserved for the next node");
    } else {
        assert_eq!(run["status"], "Ended");
        for id in &roster {
            let s: Value = env.contract.view("get_ship").args_json(json!({"ship_id": id})).await?.json()?;
            assert_eq!(s["ship"]["ship_data"]["in_fleet"], false, "roster released after a lost run");
        }
    }
    let storage1 = env.contract_storage_usage().await?;
    let (p1, b1) = (env.used_bytes(&p).await?, env.used_bytes(&bob).await?);
    assert_eq!(b1, b0, "the account driving the AI pays nothing");
    assert_eq!(p1 as i64 - p0 as i64, storage1 as i64 - storage0 as i64, "every byte is the player's");
    eprintln!("roguelike root fight: {turns} turns, won={won}");
    Ok(())
}

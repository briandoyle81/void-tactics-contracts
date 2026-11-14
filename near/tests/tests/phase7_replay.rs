//! Replay through an indexer (decided 2026-11-14): every event that changes a
//! game carries the whole compact board, so a full replay can be rebuilt
//! from logs alone. These tests play whole games using only what an indexer
//! would see, and check after every transaction that the latest logged board
//! equals the contract's state, on the heaviest seeded encounter (14 AI ships
//! against 8) where the boards are largest.

use integration_tests::policy::{choose_human_move, LocalRules};
use integration_tests::pricing::NearUsd;
use integration_tests::replay::{boards, max_receipt_log_bytes};
use integration_tests::seed::seed_all;
use near_workspaces::types::{Gas, NearToken};
use serde_json::{json, Value};
use vt_core::engine::{GameState, Side};
use vt_core::replay::compact_board;

async fn state(env: &integration_tests::Env, game_id: &str) -> anyhow::Result<GameState> {
    Ok(env.contract.view("get_game").args_json(json!({"game_id": game_id})).await?.json()?)
}

#[tokio::test]
async fn a_whole_game_replays_from_logs_alone() -> anyhow::Result<()> {
    let env = integration_tests::setup().await?;
    let owner = env.contract.as_account();
    let seed = seed_all(owner, &env.contract, None, NearUsd::Test).await?;

    // The map with the most AI placements, as a fresh unlocked node.
    let mut best = (0u64, 0usize);
    for &map in seed.single_player.map_ids.values() {
        let p: Vec<Value> = env.contract.view("get_map_placements").args_json(json!({"map_id": map.to_string()})).await?.json()?;
        if p.len() > best.1 {
            best = (map, p.len());
        }
    }
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
    alice
        .call(env.contract.id(), "purchase_ships_with_near")
        .args_json(json!({"tier": 4, "variant": 1}))
        .deposit(NearToken::from_yoctonear(price[4]["near_ship_price"].as_str().unwrap().parse()?))
        .gas(Gas::from_tgas(300))
        .transact()
        .await?
        .into_result()?;
    let ships: Vec<Value> = env.contract.view("get_ships_for_owner").args_json(json!({"account_id": alice.id(), "limit": 100})).await?.json()?;
    let mut by_cost: Vec<(u64, u64)> = ships.iter().map(|s| (s["ship"]["ship_data"]["cost"].as_u64().unwrap(), s["ship"]["id"].as_u64().unwrap())).collect();
    by_cost.sort();
    let fleet: Vec<String> = by_cost.iter().take(8).map(|x| x.1.to_string()).collect();
    let positions: Vec<Value> = (0..fleet.len()).map(|i| json!({"row": i as i64, "col": 1})).collect();

    let start = alice
        .call(env.contract.id(), "start_node_match")
        .args_json(json!({"node_id": node, "ship_ids": fleet, "positions": positions}))
        .gas(Gas::from_tgas(300))
        .transact()
        .await?;
    let game_id: String = start.clone().into_result()?.json()?;
    let mut frames = boards(&start, &game_id);
    assert_eq!(frames.len(), 1, "one start frame");
    let start_event = start.logs().into_iter().find(|l| l.contains("\"game_board\"")).unwrap().to_string();
    assert!(start_event.contains("\"fleet\""), "the start frame carries the fleet facts");
    let mut g = state(&env, &game_id).await?;
    assert_eq!(frames[0], compact_board(&g));
    assert_eq!(frames[0].ships.len(), 8 + best.1);

    let rules = LocalRules::from_seed_config();
    let (mut max_log, mut txs, mut ai_moves, mut ai_frames) = (max_receipt_log_bytes(&start), 1, 0u32, 0usize);
    for _ in 0..400 {
        if g.ended {
            break;
        }
        let out = if g.current_turn == Side::Creator {
            let Some(m) = choose_human_move(&g, &rules) else { break };
            alice
                .call(env.contract.id(), "move_ship")
                .args_json(json!({"game_id": game_id, "ship_id": m.ship_id.to_string(), "new_row": m.new_row, "new_col": m.new_col,
                                  "action": m.action, "target_ship_id": m.target_ship_id.to_string()}))
                .gas(Gas::from_tgas(300))
                .transact()
                .await?
        } else {
            let out = bob
                .call(env.contract.id(), "take_ai_turns")
                .args_json(json!({"game_id": game_id, "max_moves": 8}))
                .gas(Gas::from_tgas(300))
                .transact()
                .await?;
            let n: u32 = out.clone().into_result()?.json()?;
            let f = boards(&out, &game_id);
            assert_eq!(f.len(), n as usize + 1, "one frame per AI move plus the closing frame");
            ai_moves += n;
            ai_frames += f.len();
            out
        };
        max_log = max_log.max(max_receipt_log_bytes(&out));
        let f = boards(&out.clone(), &game_id);
        out.into_result()?;
        assert!(!f.is_empty(), "every game-changing call carries a board");
        frames.extend(f);
        txs += 1;
        g = state(&env, &game_id).await?;
        assert_eq!(frames.last().unwrap(), &compact_board(&g), "logged board = contract state after tx {txs}");
    }
    assert!(g.ended, "game finished");
    assert!(frames.last().unwrap().ended);
    let frame_bytes = serde_json::to_string(&frames[0])?.len();
    eprintln!(
        "replay: {} frames over {txs} txs ({ai_moves} AI moves in {ai_frames} AI frames); {} ships, {frame_bytes} bytes per frame; max receipt logs {max_log} bytes",
        frames.len(),
        frames[0].ships.len()
    );
    assert!(max_log < 16_384, "log cap per receipt");
    Ok(())
}

#[tokio::test]
async fn start_and_forfeit_frames_match_state() -> anyhow::Result<()> {
    let env = integration_tests::setup().await?;
    let owner = env.contract.as_account();
    integration_tests::seed::seed_rules(owner, &env.contract).await?;
    integration_tests::seed::seed_single_player(owner, &env.contract, 1).await?;
    let alice = env.registered_user(NearToken::from_near(1)).await?;
    alice.call(env.contract.id(), "claim_free_ships").args_json(json!({"variant": 1})).gas(Gas::from_tgas(200)).transact().await?.into_result()?;
    let ships: Vec<Value> = env.contract.view("get_ships_for_owner").args_json(json!({"account_id": alice.id()})).await?.json()?;
    let id = ships.iter().map(|s| (s["ship"]["ship_data"]["cost"].as_u64().unwrap(), s["ship"]["id"].as_u64().unwrap())).min().unwrap().1;
    let start = alice
        .call(env.contract.id(), "start_node_match")
        .args_json(json!({"node_id": "1", "ship_ids": [id.to_string()], "positions": [{"row": 1, "col": 1}]}))
        .gas(Gas::from_tgas(300))
        .transact()
        .await?;
    let game_id: String = start.clone().into_result()?.json()?;
    assert_eq!(boards(&start, &game_id), vec![compact_board(&state(&env, &game_id).await?)]);
    let ff = alice.call(env.contract.id(), "forfeit").args_json(json!({"game_id": game_id})).transact().await?;
    let f = boards(&ff, &game_id);
    ff.into_result()?;
    let g = state(&env, &game_id).await?;
    assert!(g.ended);
    assert_eq!(f, vec![compact_board(&g)], "forfeit frame = final state");
    assert_eq!(f[0].winner, Some(Side::Joiner));
    Ok(())
}

//! Phase 1 end-to-end loop on a real sandbox node:
//! claim free ships -> ships auto-construct via self-callback randomness ->
//! fleet -> play a campaign node against the AI (human moves + permissionless
//! AI turns) -> variant-2 AI kills pay DEC -> DEC buys a storefront tier ->
//! the next claim grows.

use integration_tests::policy::{choose_human_move, LocalRules};
use integration_tests::seed::{seed_rules, seed_single_player};
use integration_tests::setup;
use near_workspaces::types::{Gas, NearToken};
use serde_json::{json, Value};
use vt_core::engine::{GameState, Side};

const AI_OFFSET: u64 = 1 << 40;

#[tokio::test]
async fn claim_play_earn_and_upgrade() -> anyhow::Result<()> {
    let env = setup().await?;
    let owner = env.contract.as_account();
    seed_rules(owner, &env.contract).await?;
    seed_single_player(owner, &env.contract, 3).await?;

    let alice = env.registered_user(NearToken::from_near(1)).await?;
    let used0 = env.used_bytes(&alice).await?;
    let storage0 = env.contract_storage_usage().await?;

    // ---- claim: 10 free ships, constructed by the randomness callback ----
    let claim = alice.call(env.contract.id(), "claim_free_ships").args_json(json!({"variant": 1})).gas(Gas::from_tgas(200)).transact().await?;
    let claim_gas = claim.total_gas_burnt;
    let ids: Vec<String> = claim.into_result()?.json()?;
    assert_eq!(ids.len(), 10);
    let ships: Vec<Value> = env.contract.view("get_ships_for_owner").args_json(json!({"account_id": alice.id()})).await?.json()?;
    assert_eq!(ships.len(), 10);
    for s in &ships {
        assert_eq!(s["ship"]["ship_data"]["constructed"], true, "callback must construct every claimed ship: {s}");
        assert!(s["ship"]["ship_data"]["is_free_ship"].as_bool().unwrap());
        assert!(s["ship"]["ship_data"]["cost"].as_u64().unwrap() > 0);
    }
    // A second claim inside the cooldown fails.
    let again = alice.call(env.contract.id(), "claim_free_ships").args_json(json!({"variant": 1})).gas(Gas::from_tgas(200)).transact().await?;
    assert!(format!("{:?}", again.into_result().unwrap_err()).contains("ClaimCooldownNotPassed"));

    // ---- fleet: cheapest ships under node 1's cost cap, max 4 ----
    let node: Value = env.contract.view("get_node").args_json(json!({"node_id": "1"})).await?.json()?;
    let cap = node["cost_limit"].as_u64().unwrap();
    let mut by_cost: Vec<(u64, u64)> = ships.iter().map(|s| (s["ship"]["ship_data"]["cost"].as_u64().unwrap(), s["ship"]["id"].as_u64().unwrap())).collect();
    by_cost.sort();
    let (mut fleet, mut total) = (vec![], 0);
    for (cost, id) in by_cost {
        if fleet.len() < 4 && total + cost <= cap {
            fleet.push(id);
            total += cost;
        }
    }
    assert!(!fleet.is_empty());
    let positions: Vec<Value> = (0..fleet.len()).map(|i| json!({"row": 1 + 3 * i as i64, "col": 1})).collect();
    let start = alice
        .call(env.contract.id(), "start_node_match")
        .args_json(json!({"node_id": "1", "ship_ids": fleet.iter().map(|i| i.to_string()).collect::<Vec<_>>(), "positions": positions}))
        .gas(Gas::from_tgas(300))
        .transact()
        .await?;
    let start_gas = start.total_gas_burnt;
    let game_id: String = start.into_result()?.json()?;

    // ---- play: alice moves, bob (anyone) advances the AI ----
    let bob = env.worker.dev_create_account().await?;
    let rules = LocalRules::from_seed_config();
    let mut max_move_gas = Gas::from_gas(0);
    let mut max_ai_gas = Gas::from_gas(0);
    let mut g: GameState;
    let mut turns = 0;
    loop {
        g = env.contract.view("get_game").args_json(json!({"game_id": game_id})).await?.json()?;
        if g.ended || turns > 400 {
            break;
        }
        turns += 1;
        if g.current_turn == Side::Creator {
            let Some(m) = choose_human_move(&g, &rules) else { break };
            let out = alice
                .call(env.contract.id(), "move_ship")
                .args_json(json!({
                    "game_id": game_id, "ship_id": m.ship_id.to_string(), "new_row": m.new_row, "new_col": m.new_col,
                    "action": m.action, "target_ship_id": m.target_ship_id.to_string(),
                }))
                .gas(Gas::from_tgas(300))
                .transact()
                .await?;
            max_move_gas = max_move_gas.max(out.total_gas_burnt);
            out.into_result()?;
        } else {
            let out = bob
                .call(env.contract.id(), "take_ai_turns")
                .args_json(json!({"game_id": game_id, "max_moves": 8}))
                .gas(Gas::from_tgas(300))
                .transact()
                .await?;
            max_ai_gas = max_ai_gas.max(out.total_gas_burnt);
            out.into_result()?;
        }
    }
    assert!(g.ended, "game should finish within the turn budget");

    // ---- rewards: DEC == variant-2 AI ships alice's ships destroyed ----
    let m: Value = env.contract.view("get_sp_match").args_json(json!({"game_id": game_id})).await?.json()?;
    let ai_variant = |id: u64| {
        m["ai_ships"].as_array().unwrap().iter().find(|a| a[0].as_u64() == Some(id)).map(|a| a[1]["traits"]["variant"].as_u64().unwrap())
    };
    let expected_dec = g
        .gone_ship_ids
        .iter()
        .filter(|&&id| {
            let b = g.ship(id);
            id >= AI_OFFSET && b.status == 1 && b.last_damager != 0 && b.last_damager < AI_OFFSET && ai_variant(id) == Some(2)
        })
        .count() as u128;
    let dec: String = env.contract.view("mt_balance_of").args_json(json!({"account_id": alice.id(), "token_id": "dec"})).await?.json()?;
    assert_eq!(dec.parse::<u128>()?, expected_dec, "DEC paid must match variant-2 AI kills");

    // Fleet released at game end; destroyed human ships marked destroyed.
    for id in &fleet {
        let s: Value = env.contract.view("get_ship").args_json(json!({"ship_id": id.to_string()})).await?.json()?;
        assert_eq!(s["ship"]["ship_data"]["in_fleet"], false);
        let destroyed = g.ship(*id).status == 1;
        assert_eq!(s["ship"]["ship_data"]["timestamp_destroyed"].as_u64().unwrap() != 0, destroyed);
    }
    let won = g.winner == Some(Side::Creator);
    let completed: bool = env.contract.view("is_node_completed").args_json(json!({"account_id": alice.id(), "node_id": "1"})).await?.json()?;
    assert_eq!(completed, won);

    // ---- storage ledger invariant over alice's whole session ----
    let used1 = env.used_bytes(&alice).await?;
    let storage1 = env.contract_storage_usage().await?;
    assert_eq!(used1 - used0, storage1 - storage0, "every byte alice caused (incl. callbacks and bob's AI calls) is charged to alice");

    // ---- storefront: top up to 10 DEC (test hook), buy tier 1 ----
    let top_up = 10u128.saturating_sub(dec.parse::<u128>()?);
    if top_up > 0 {
        owner
            .call(env.contract.id(), "test_mint")
            .args_json(json!({"account_id": alice.id(), "token_id": "dec", "amount": top_up.to_string()}))
            .transact()
            .await?
            .into_result()?;
    }
    alice.call(env.contract.id(), "turn_in_cores").args_json(json!({"amount": "10"})).transact().await?.into_result()?;
    let status: Value = env.contract.view("get_claim_status").args_json(json!({"account_id": alice.id()})).await?.json()?;
    assert_eq!(status["drone_core_tier"], 1);
    assert_eq!(status["ships_per_claim"], 11);

    eprintln!(
        "turns={turns} winner={:?} dec_earned={expected_dec} | gas: claim+callback={} Tgas, start={} Tgas, max move={} Tgas, max ai(8)={} Tgas",
        g.winner,
        claim_gas.as_tgas(),
        start_gas.as_tgas(),
        max_move_gas.as_tgas(),
        max_ai_gas.as_tgas()
    );
    Ok(())
}

//! Phase 3 on a real sandbox node: a full PvP game (lobby, both fleets,
//! scripted play to the end) with the storage-ledger invariant across both
//! players and a third-party pruner.

use integration_tests::policy::{choose_move, LocalRules};
use integration_tests::seed::seed_rules;
use integration_tests::setup;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::Account;
use serde_json::{json, Value};
use vt_core::engine::{GameState, Side};

async fn ships_under(env: &integration_tests::Env, who: &Account, cap: u64) -> anyhow::Result<Vec<String>> {
    let ships: Vec<Value> = env.contract.view("get_ships_for_owner").args_json(json!({"account_id": who.id()})).await?.json()?;
    let mut v: Vec<(u64, u64)> = ships.iter().map(|s| (s["ship"]["ship_data"]["cost"].as_u64().unwrap(), s["ship"]["id"].as_u64().unwrap())).collect();
    v.sort();
    let (mut out, mut total) = (vec![], 0);
    for (c, id) in v {
        if out.len() < 3 && total + c <= cap {
            out.push(id.to_string());
            total += c;
        }
    }
    Ok(out)
}

async fn used_all(env: &integration_tests::Env, who: &[&Account]) -> anyhow::Result<u64> {
    let mut total = 0;
    for a in who {
        total += env.used_bytes(a).await?;
    }
    Ok(total)
}

#[tokio::test]
async fn full_pvp_game_with_exact_storage_attribution() -> anyhow::Result<()> {
    let env = setup().await?;
    seed_rules(env.contract.as_account(), &env.contract).await?;
    let alice = env.registered_user(NearToken::from_near(2)).await?;
    let bob = env.registered_user(NearToken::from_near(2)).await?;
    let mallory = env.registered_user(NearToken::from_near(1)).await?;
    let carol = env.registered_user(NearToken::from_near(1)).await?;
    for p in [&alice, &bob] {
        p.call(env.contract.id(), "claim_free_ships").args_json(json!({"variant": 1})).gas(Gas::from_tgas(200)).transact().await?.into_result()?;
    }
    let storage0 = env.contract_storage_usage().await?;
    let used0 = used_all(&env, &[&alice, &bob, &mallory, &carol]).await?;

    // A lobby nobody joins (later pruned by mallory) plus the real one.
    let lobby_args = json!({"cost_limit": 1000, "turn_time": 300, "creator_goes_first": true, "map_id": "0", "max_score": 100});
    let stale: String = carol.call(env.contract.id(), "create_lobby").args_json(&lobby_args).transact().await?.into_result()?.json()?;
    let lobby: String = alice.call(env.contract.id(), "create_lobby").args_json(&lobby_args).transact().await?.into_result()?.json()?;
    bob.call(env.contract.id(), "join_lobby").args_json(json!({"lobby_id": lobby})).transact().await?.into_result()?;
    let mut game_id = None;
    for (p, col) in [(&alice, 3), (&bob, 13)] {
        let ships = ships_under(&env, p, 1000).await?;
        let positions: Vec<Value> = (0..ships.len()).map(|i| json!({"row": 2 + 3 * i, "col": col})).collect();
        let out: Option<String> = p
            .call(env.contract.id(), "create_lobby_fleet")
            .args_json(json!({"lobby_id": lobby, "ship_ids": ships, "positions": positions}))
            .gas(Gas::from_tgas(200))
            .transact()
            .await?
            .into_result()?
            .json()?;
        game_id = out.or(game_id);
    }
    let game_id = game_id.expect("second fleet starts the game");

    let rules = LocalRules::from_seed_config();
    let mut g: GameState;
    let mut turns = 0;
    loop {
        g = env.contract.view("get_game").args_json(json!({"game_id": game_id})).await?.json()?;
        if g.ended || turns > 400 {
            break;
        }
        turns += 1;
        let side = g.current_turn;
        let who = if side == Side::Creator { &alice } else { &bob };
        let Some(m) = choose_move(&g, &rules, side) else {
            let dump: Vec<String> = g
                .creator_active
                .iter()
                .chain(g.joiner_active.iter())
                .map(|&id| {
                    let b = g.ship(id);
                    format!("{id}: creator={} hp={} moved_in={} zeroed_after={} status={}", b.is_creator, b.hull_points, b.moved_in_round, b.zeroed_after_moving_round, b.status)
                })
                .collect();
            panic!(
                "no move for {side:?}: round={} moved_total={} at_start={} zero={:?} removed={} removed_at_start={} total_at_start={} ships:\n{}",
                g.current_round, g.moved_total, g.moved_at_round_start, g.ships_with_zero_hp, g.ships_removed_total, g.removed_at_round_start,
                g.total_active_at_round_start, dump.join("\n")
            );
        };
        who.call(env.contract.id(), "move_ship")
            .args_json(json!({"game_id": game_id, "ship_id": m.ship_id.to_string(), "new_row": m.new_row, "new_col": m.new_col,
                              "action": m.action, "target_ship_id": m.target_ship_id.to_string()}))
            .gas(Gas::from_tgas(100))
            .transact()
            .await?
            .into_result()?;
    }
    assert!(g.ended, "game should finish");

    // Stale lobby pruned by a stranger after 7 days.
    env.worker.fast_forward(1).await?;
    let pruned = mallory.call(env.contract.id(), "prune_stale_lobby").args_json(json!({"lobby_id": stale})).transact().await?;
    assert!(pruned.is_failure(), "not stale yet");

    let storage1 = env.contract_storage_usage().await?;
    let used1 = used_all(&env, &[&alice, &bob, &mallory, &carol]).await?;
    assert_eq!(used1 as i64 - used0 as i64, storage1 as i64 - storage0 as i64, "every byte attributed to someone");
    if let Some(w) = g.winner {
        let r: Value = env.contract.view("get_game_result").args_json(json!({"game_id": game_id})).await?.json()?;
        let want = if w == Side::Creator { alice.id() } else { bob.id() };
        assert_eq!(r["winner"].as_str().unwrap(), want.as_str());
    }
    eprintln!("pvp game {game_id}: {turns} turns, winner {:?}", g.winner);
    Ok(())
}

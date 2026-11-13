//! Seeds a deployed void-tactics contract with the same rules and starter
//! content the Solidity deploy module uses:
//!   - near/seed/config.json (exported from the real deploy by
//!     scripts/near-golden/exportConfig.ts)
//!   - ignition/data/singlePlayerStarterContent.json (maps, AI ship configs,
//!     placements, campaign graph)
//!
//! Admin calls are sent as batched FunctionCall actions: one batch is one
//! receipt executing sequentially, and the seeder is the only writer, so
//! content ids are deterministic (n-th map created = map id n, ...).

use std::collections::HashMap;

use anyhow::{Context, Result};
use near_workspaces::operations::Function;
use near_workspaces::types::Gas;
use near_workspaces::{Account, Contract};
use serde_json::{json, Value};

const BATCH: usize = 20;

pub fn repo_path(rel: &str) -> String {
    format!("{}/../../{rel}", env!("CARGO_MANIFEST_DIR"))
}

fn read_json(rel: &str) -> Result<Value> {
    let p = repo_path(rel);
    Ok(serde_json::from_str(&std::fs::read_to_string(&p).with_context(|| p.clone())?)?)
}

const MAIN_WEAPON: [&str; 8] = ["Generic", "Sniper", "Missile", "Close", "Future1", "Future2", "Future3", "Future4"];
const ARMOR: [&str; 8] = ["None", "Light", "Medium", "Heavy", "Future1", "Future2", "Future3", "Future4"];
const SPECIAL: [&str; 8] = ["None", "Slot1", "Slot2", "Slot3", "Slot4", "Slot5", "Slot6", "Slot7"];
const ARCHETYPE: [&str; 8] = ["Grunt", "Aggressor", "Sniper", "Support", "Turtle", "Rammer", "Runner", "Hunter"];

fn u(v: &Value) -> u64 {
    match v {
        Value::String(s) => s.parse().unwrap(),
        other => other.as_u64().unwrap_or_else(|| panic!("not a u64: {other}")),
    }
}

pub fn attribute_table_json(v: &Value) -> Value {
    let arr = |k: &str| v[k].clone();
    json!({
        "base_hull": v["baseHull"], "base_speed": v["baseSpeed"],
        "fore_accuracy": arr("foreAccuracy"), "hull": arr("hull"), "engine_speeds": arr("engineSpeeds"),
        "guns": v["guns"].as_array().unwrap().iter().map(|g| json!({"range": g["range"], "damage": g["damage"], "movement": g["movement"]})).collect::<Vec<_>>(),
        "armors": v["armors"].as_array().unwrap().iter().map(|a| json!({"damage_reduction": a["damageReduction"], "movement": a["movement"]})).collect::<Vec<_>>(),
        "shields": v["shields"].as_array().unwrap().iter().map(|a| json!({"damage_reduction": a["damageReduction"], "movement": a["movement"]})).collect::<Vec<_>>(),
        "specials": v["specials"].as_array().unwrap().iter().map(|s| json!({"range": s["range"], "strength": s["strength"], "movement": s["movement"]})).collect::<Vec<_>>(),
        "rank_thresholds": v["rankThresholds"].as_array().unwrap().iter().map(u).collect::<Vec<_>>(),
        "rank_bonus_pct": arr("rankBonusPct"),
    })
}

fn costs(v: &Value) -> Value {
    json!({
        "version": 0, "base_cost": v["baseCost"], "accuracy": v["accuracy"], "hull": v["hull"], "speed": v["speed"],
        "main_weapon": v["mainWeapon"], "armor": v["armor"], "shields": v["shields"], "special": v["special"],
    })
}

fn positions(v: &Value) -> Value {
    json!(v.as_array().unwrap().iter().map(|p| json!({"row": p["row"], "col": p["col"]})).collect::<Vec<_>>())
}

/// Sends `calls` as batches of FunctionCall actions from `owner`.
async fn send_batched(owner: &Account, contract: &Contract, calls: Vec<(&'static str, Value)>) -> Result<()> {
    for chunk in calls.chunks(BATCH) {
        let mut tx = owner.batch(contract.id());
        for (method, args) in chunk {
            tx = tx.call(Function::new(method).args_json(args.clone()).gas(Gas::from_tgas(40)));
        }
        tx.transact().await?.into_result().with_context(|| format!("batch starting with {}", chunk[0].0))?;
    }
    Ok(())
}

pub struct SeedSummary {
    pub map_ids: HashMap<String, u64>,
    pub node_ids: HashMap<String, u64>,
    pub campaign_id: u64,
}

/// Publishes rules from near/seed/config.json.
pub async fn seed_rules(owner: &Account, contract: &Contract) -> Result<()> {
    let cfg = read_json("near/seed/config.json")?;
    let mut calls: Vec<(&'static str, Value)> = Vec::new();
    for (variant, v) in cfg["variants"].as_object().unwrap() {
        let variant: u16 = variant.parse()?;
        for table in v["attributeVersions"].as_array().unwrap() {
            calls.push(("publish_variant_attributes", json!({"variant": variant, "data": attribute_table_json(table)})));
        }
        calls.push(("set_current_attributes_version", json!({"variant": variant, "version": v["currentAttributesVersion"]})));
        calls.push(("set_costs", json!({"variant": variant, "costs": costs(&v["costs"])})));
        calls.push(("set_max_special_slot", json!({"variant": variant, "slot": v["maxSpecialSlot"]})));
    }
    calls.push(("set_faction_resolver", json!({"variant": 1, "resolver": {"Ram": {"range": cfg["ram"]["range"]}}})));
    calls.push((
        "set_faction_resolver",
        json!({"variant": 2, "resolver": {"Repair": {"range": cfg["repair"]["range"], "strength": cfg["repair"]["strength"]}}}),
    ));
    for r in cfg["specialResolvers"].as_array().unwrap() {
        let slot = SPECIAL[u(&r[1]) as usize];
        calls.push(("set_special_resolver", json!({"variant": r[0], "slot": slot, "resolver": {r[2].as_str().unwrap(): {"slot": slot}}})));
    }
    for (variant, token) in cfg["rewardTokens"].as_object().unwrap() {
        calls.push(("set_reward_token", json!({"variant": variant.parse::<u16>()?, "token": token})));
    }
    calls.push(("set_heal_cap_percent", json!({"percent": cfg["healCapPercent"]})));
    calls.push(("set_faction_kill_reward", json!({"amount": cfg["factionKillReward"]})));
    calls.push(("set_max_variant", json!({"max_variant": cfg["maxVariant"]})));
    calls.push(("set_claim_config", json!({"cooldown_s": cfg["claimCooldownSeconds"], "base_ships": 10})));
    for t in cfg["storefrontTiers"].as_array().unwrap() {
        calls.push(("add_storefront_tier", json!({"core_cost": t})));
    }
    send_batched(owner, contract, calls).await
}

/// Seeds the single-player starter content. `max_nodes` limits the campaign
/// to its first N nodes (and only the maps/configs they use).
pub async fn seed_single_player(owner: &Account, contract: &Contract, max_nodes: usize) -> Result<SeedSummary> {
    let content = read_json("ignition/data/singlePlayerStarterContent.json")?;
    let nodes: Vec<&Value> = content["campaignNodes"].as_array().unwrap().iter().take(max_nodes).collect();
    let wanted_maps: Vec<&str> = nodes.iter().map(|n| n["mapKey"].as_str().unwrap()).collect();
    let colors = &content["aiShipColors"];
    let mut calls: Vec<(&'static str, Value)> = Vec::new();

    // Maps (ids 1..).
    let mut map_ids = HashMap::new();
    for m in content["maps"].as_array().unwrap().iter().filter(|m| wanted_maps.contains(&m["key"].as_str().unwrap())) {
        let id = map_ids.len() as u64 + 1;
        map_ids.insert(m["key"].as_str().unwrap().to_string(), id);
        let scoring: Vec<Value> = m["scoringTiles"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| json!({"row": s["row"], "col": s["col"], "points": s["points"], "only_once": s["onlyOnce"]}))
            .collect();
        calls.push((
            "create_preset_map",
            json!({"blocked": positions(&m["blockedTiles"]), "impassable": positions(&m["impassableTiles"]), "scoring": scoring, "mode": m["mode"]}),
        ));
        let (cz, jz) = (&m["creatorZone"], &m["joinerZone"]);
        if !cz.as_array().unwrap().is_empty() || !jz.as_array().unwrap().is_empty() {
            calls.push(("set_deployment_zones", json!({"map_id": id.to_string(), "creator_zone": positions(cz), "joiner_zone": positions(jz)})));
        }
    }

    // AI ship configs (ids 1..), only those placed on wanted maps.
    let placements: Vec<&Value> =
        content["mapPlacements"].as_array().unwrap().iter().filter(|p| map_ids.contains_key(p["mapKey"].as_str().unwrap())).collect();
    let mut config_ids: HashMap<String, u64> = HashMap::new();
    for c in content["aiShipConfigs"].as_array().unwrap() {
        let key = c["key"].as_str().unwrap();
        let used = placements.iter().any(|p| p["configKeys"].as_array().unwrap().iter().any(|k| k == key));
        if !used {
            continue;
        }
        config_ids.insert(key.to_string(), config_ids.len() as u64 + 1);
        let e = &c["equipment"];
        let t = &c["traits"];
        calls.push((
            "create_ai_ship_config",
            json!({"config": {
                "name": c["name"],
                "equipment": {
                    "main_weapon": MAIN_WEAPON[u(&e["mainWeapon"]) as usize], "armor": ARMOR[u(&e["armor"]) as usize],
                    "shields": ARMOR[u(&e["shields"]) as usize], "special": SPECIAL[u(&e["special"]) as usize],
                },
                "traits": {
                    "serial_number": 0,
                    "colors": {"h1": colors["h1"], "s1": colors["s1"], "l1": colors["l1"], "h2": colors["h2"], "s2": colors["s2"], "l2": colors["l2"]},
                    "variant": t["variant"], "accuracy": t["accuracy"], "hull": t["hull"], "speed": t["speed"],
                },
                "archetype": ARCHETYPE[u(&c["archetype"]) as usize],
                "shiny": c.get("shiny").cloned().unwrap_or(json!(false)),
                "ships_destroyed": c.get("shipsDestroyed").cloned().unwrap_or(json!(0)),
            }}),
        ));
    }
    for p in &placements {
        let ids: Vec<String> = p["configKeys"].as_array().unwrap().iter().map(|k| config_ids[k.as_str().unwrap()].to_string()).collect();
        calls.push((
            "set_map_placements",
            json!({"map_id": map_ids[p["mapKey"].as_str().unwrap()].to_string(), "positions": positions(&p["positions"]), "config_ids": ids}),
        ));
    }

    // Campaign 1 (the Shattered Hive main campaign: variant-1 human fleets).
    calls.push(("create_campaign", json!({"required_variant": 1})));
    let campaign_id = 1;
    let mut node_ids = HashMap::new();
    for n in &nodes {
        let id = node_ids.len() as u64 + 1;
        node_ids.insert(n["key"].as_str().unwrap().to_string(), id);
        let prereqs: Vec<u64> = n["prerequisites"].as_array().unwrap().iter().filter_map(|k| node_ids.get(k.as_str().unwrap()).copied()).collect();
        calls.push((
            "create_node",
            json!({"node": {
                "campaign_id": campaign_id, "map_id": map_ids[n["mapKey"].as_str().unwrap()], "prerequisites": prereqs,
                "cost_limit": n["costLimit"], "turn_time": n["turnTime"], "max_score": n["maxScore"], "creator_goes_first": n["creatorGoesFirst"],
            }}),
        ));
    }
    send_batched(owner, contract, calls).await?;
    Ok(SeedSummary { map_ids, node_ids, campaign_id })
}

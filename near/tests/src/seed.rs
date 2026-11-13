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

use crate::pricing::{price_tiers, NearUsd};

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

pub const ONE_NEAR: u128 = 1_000_000_000_000_000_000_000_000;

pub struct SeedSummary {
    pub map_ids: HashMap<String, u64>,
    pub config_ids: HashMap<String, u64>,
    pub node_ids: HashMap<String, u64>,
    pub campaign_id: u64,
}

/// Publishes rules from near/seed/config.json, with ship packs priced at the
/// fixed test NEAR/USD price.
pub async fn seed_rules(owner: &Account, contract: &Contract) -> Result<()> {
    seed_rules_priced(owner, contract, NearUsd::Test).await
}

/// `seed_rules` with an explicit NEAR/USD source (`NearUsd::Live` for a real
/// deploy, like the EVM deploy module's getEthUsdPrice).
pub async fn seed_rules_priced(owner: &Account, contract: &Contract, near_usd: NearUsd) -> Result<()> {
    let tiers = price_tiers(near_usd.resolve()?)?;
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
    // DeployAndConfig: aiEncounters.setMaxPlacementsPerMap(14).
    calls.push(("set_max_placements_per_map", json!({"max": 14})));
    calls.push(("set_faction_kill_reward", json!({"amount": cfg["factionKillReward"]})));
    calls.push(("set_max_variant", json!({"max_variant": cfg["maxVariant"]})));
    calls.push(("set_claim_config", json!({"cooldown_s": cfg["claimCooldownSeconds"], "base_ships": 10})));
    for t in cfg["storefrontTiers"].as_array().unwrap() {
        calls.push(("add_storefront_tier", json!({"core_cost": t})));
    }
    calls.push(("set_price_tiers", json!({"tiers": tiers})));
    // VariantPurchaseGate: variant 2 requires the Shattered Hive medal.
    calls.push(("set_variant_gated", json!({"variant": 2, "requires_medal": true})));
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

    // AI ship configs: ALL of them, in file order, so config ids match the
    // Solidity deploy's (ids 1..64), whether or not a seeded map uses them.
    let placements: Vec<&Value> =
        content["mapPlacements"].as_array().unwrap().iter().filter(|p| map_ids.contains_key(p["mapKey"].as_str().unwrap())).collect();
    let mut config_ids: HashMap<String, u64> = HashMap::new();
    for c in content["aiShipConfigs"].as_array().unwrap() {
        let key = c["key"].as_str().unwrap();
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
    Ok(SeedSummary { map_ids, config_ids, node_ids, campaign_id })
}

/// Placeholder win-effect values from the deploy module (DECBonusWinEffect
/// bonusAmount, HealAboveFloorWinEffect healToPercent).
pub const DEC_BONUS_AMOUNT: u64 = 20;
pub const HEAL_TO_PERCENT: u8 = 100;

async fn view_u64(contract: &Contract, method: &str) -> Result<u64> {
    let s: String = contract.view(method).args_json(json!({})).await?.json()?;
    Ok(s.parse()?)
}

/// Seeds the roguelike campaign from ignition/data/roguelikeStarterContent.json
/// (its AI ship configs come from the single-player content, by key). Like the
/// deploy module, maps and AI configs share one namespace with single-player:
/// pass the single-player seed so shared keys (e.g. a roguelike node on a
/// campaign map) reuse those ids. Returns the campaign id.
pub async fn seed_roguelike(owner: &Account, contract: &Contract, sp_seed: Option<&SeedSummary>) -> Result<u64> {
    let rl = read_json("ignition/data/roguelikeStarterContent.json")?;
    let sp = read_json("ignition/data/singlePlayerStarterContent.json")?;
    let map_base = view_u64(contract, "get_map_count").await?;
    let config_base = view_u64(contract, "get_ai_config_count").await?;
    let colors = &sp["aiShipColors"];
    let mut calls: Vec<(&'static str, Value)> = Vec::new();

    let mut map_ids: HashMap<String, u64> = sp_seed.map(|s| s.map_ids.clone()).unwrap_or_default();
    let mut created_maps = 0u64;
    for m in rl["maps"].as_array().unwrap() {
        created_maps += 1;
        let id = map_base + created_maps;
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

    let needed: Vec<String> = rl["mapPlacements"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|p| p["configKeys"].as_array().unwrap().iter().map(|k| k.as_str().unwrap().to_string()))
        .collect();
    let mut config_ids: HashMap<String, u64> = sp_seed.map(|s| s.config_ids.clone()).unwrap_or_default();
    let mut created_configs = 0u64;
    for c in sp["aiShipConfigs"].as_array().unwrap() {
        let key = c["key"].as_str().unwrap();
        if !needed.iter().any(|k| k == key) || config_ids.contains_key(key) {
            continue;
        }
        created_configs += 1;
        config_ids.insert(key.to_string(), config_base + created_configs);
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
    for p in rl["mapPlacements"].as_array().unwrap() {
        let ids: Vec<String> = p["configKeys"].as_array().unwrap().iter().map(|k| config_ids[k.as_str().unwrap()].to_string()).collect();
        calls.push((
            "set_map_placements",
            json!({"map_id": map_ids[p["mapKey"].as_str().unwrap()].to_string(), "positions": positions(&p["positions"]), "config_ids": ids}),
        ));
    }
    send_batched(owner, contract, std::mem::take(&mut calls)).await?;

    // Campaign graph.
    let campaign: String = owner.call(contract.id(), "create_rl_campaign").transact().await?.into_result()?.json()?;
    let node_base = {
        let mut n = 0u64;
        while contract.view("get_rl_node").args_json(json!({"node_id": (n + 1).to_string()})).await?.json::<Option<Value>>()?.is_some() {
            n += 1;
        }
        n
    };
    let mut node_ids = HashMap::new();
    for n in rl["nodes"].as_array().unwrap() {
        let id = node_base + node_ids.len() as u64 + 1;
        node_ids.insert(n["key"].as_str().unwrap().to_string(), id);
        // DeployAndConfig: combat nodes get map/turnTime/maxScore; resupply
        // nodes get 0s.
        let is_combat = n["kind"] == "Combat";
        let map = if is_combat {
            let k = n["mapKey"].as_str().unwrap();
            *map_ids.get(k).unwrap_or_else(|| panic!("roguelike node map {k} not seeded (seed single-player first and pass its summary)"))
        } else {
            0
        };
        calls.push((
            "create_rl_node",
            json!({"campaign_id": campaign, "kind": n["kind"], "map_id": map.to_string(),
                   // Resupply nodes omit the combat-only fields.
                   "turn_time": if is_combat { n["turnTime"].clone() } else { json!(0) },
                   "max_score": if is_combat { n["maxScore"].clone() } else { json!(0) },
                   "creator_goes_first": n.get("creatorGoesFirst").cloned().unwrap_or(json!(false)),
                   "cost_cap_override": if is_combat { json!(0) } else { n["costCapOverride"].clone() }}),
        ));
    }
    for e in rl["edges"].as_array().unwrap() {
        calls.push((
            "add_rl_child",
            json!({"parent_id": node_ids[e["from"].as_str().unwrap()].to_string(), "child_id": node_ids[e["to"].as_str().unwrap()].to_string()}),
        ));
    }
    let c = &rl["campaign"];
    calls.push((
        "set_rl_campaign",
        json!({"campaign_id": campaign, "root_node": node_ids[rl["root"].as_str().unwrap()].to_string(),
               "auto_heal_percent": c["autoHealPercent"], "required_variant": c["requiredVariant"], "initial_cost_cap": c["initialCostCap"]}),
    ));
    for n in rl["nodes"].as_array().unwrap() {
        let keys: Vec<&str> = n.get("winEffects").and_then(|w| w.as_array()).map(|a| a.iter().filter_map(|k| k.as_str()).collect()).unwrap_or_default();
        let effects: Vec<Value> = keys
            .iter()
            .filter_map(|k| match *k {
                "DEC_BONUS_WIN_EFFECT" => Some(json!({"DecBonus": {"amount": DEC_BONUS_AMOUNT.to_string()}})),
                "HEAL_ABOVE_FLOOR_WIN_EFFECT" => Some(json!({"HealAboveFloor": {"percent": HEAL_TO_PERCENT}})),
                "SHIP_GRANT_WIN_EFFECT" => n.get("shipGrant").map(|g| {
                    let e = &g["equipment"];
                    json!({"ShipGrant": {
                        "name": g["name"],
                        "equipment": {"main_weapon": MAIN_WEAPON[u(&e["mainWeapon"]) as usize], "armor": ARMOR[u(&e["armor"]) as usize],
                                      "shields": ARMOR[u(&e["shields"]) as usize], "special": SPECIAL[u(&e["special"]) as usize]},
                        "colors": g["colors"], "variant": g["variant"], "accuracy": g["accuracy"], "hull": g["hull"], "speed": g["speed"],
                        "ships_destroyed": g["shipsDestroyed"], "shiny": g["shiny"], "is_free_ship": g["isFreeShip"], "once_per_address": g["oncePerAddress"],
                    }})
                }),
                other => panic!("unknown win effect {other}"),
            })
            .collect();
        if !effects.is_empty() {
            calls.push(("set_rl_node_win_effects", json!({"node_id": node_ids[n["key"].as_str().unwrap()].to_string(), "effects": effects})));
        }
    }
    send_batched(owner, contract, calls).await?;
    Ok(campaign.parse()?)
}

/// Sets the renderer's equipment display names from near/seed/config.json
/// (RenderMetadata's names in the Solidity deploy).
pub async fn seed_renderer(owner: &Account, renderer: &Contract) -> Result<()> {
    let cfg = read_json("near/seed/config.json")?;
    owner
        .call(renderer.id(), "set_names")
        .args_json(json!({"entries": cfg["rendererNames"]}))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

/// Seeds the PvP maps from ignition/data/pvpStarterContent.json (ids continue
/// after existing maps). Returns key -> map id.
pub async fn seed_pvp_maps(owner: &Account, contract: &Contract) -> Result<HashMap<String, u64>> {
    let pvp = read_json("ignition/data/pvpStarterContent.json")?;
    let base = view_u64(contract, "get_map_count").await?;
    let mut ids = HashMap::new();
    let mut calls: Vec<(&'static str, Value)> = Vec::new();
    for (i, m) in pvp["maps"].as_array().unwrap().iter().enumerate() {
        let id = base + i as u64 + 1;
        ids.insert(m["key"].as_str().unwrap().to_string(), id);
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
    send_batched(owner, contract, calls).await?;
    Ok(ids)
}

pub struct FullSeed {
    pub single_player: SeedSummary,
    pub roguelike_campaign: u64,
    pub pvp_maps: HashMap<String, u64>,
}

/// Everything the Solidity deploy module seeds: rules (priced from
/// `near_usd`), the single-player campaign (all nodes), the roguelike
/// campaign, the PvP maps, and (if given) the renderer's names.
pub async fn seed_all(owner: &Account, contract: &Contract, renderer: Option<&Contract>, near_usd: NearUsd) -> Result<FullSeed> {
    seed_rules_priced(owner, contract, near_usd).await?;
    let single_player = seed_single_player(owner, contract, usize::MAX).await?;
    let roguelike_campaign = seed_roguelike(owner, contract, Some(&single_player)).await?;
    let pvp_maps = seed_pvp_maps(owner, contract).await?;
    if let Some(r) = renderer {
        seed_renderer(owner, r).await?;
    }
    Ok(FullSeed { single_player, roguelike_campaign, pvp_maps })
}

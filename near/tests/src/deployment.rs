//! NEAR deployment record (the counterpart of Ignition's
//! `deployed_addresses.json` + seed ids): which accounts hold the contracts,
//! and which on-chain id every seeded content key got. The frontend's seed
//! export reads it to number maps, nodes and AI configs.
//!
//! Written to near/deployments/<network>.json by the deploy tool, only after
//! `verify` has checked every id against the chain. Written 2026-11-14.

use std::collections::{BTreeMap, HashMap};

use anyhow::{bail, Result};
use near_workspaces::Contract;
use serde::Serialize;
use serde_json::{json, Value};

use crate::seed::read_json;
use crate::seed::FullSeed;

#[derive(Serialize)]
pub struct Section {
    /// content key (ignition/data/*.json) -> on-chain id
    pub maps: BTreeMap<String, u64>,
    pub ai_configs: BTreeMap<String, u64>,
    pub nodes: BTreeMap<String, u64>,
    pub campaign_id: u64,
}

#[derive(Serialize)]
pub struct Record {
    pub written_at: String,
    pub network: String,
    pub game: String,
    pub renderer: String,
    pub owner: String,
    pub code_sha256: BTreeMap<String, String>,
    pub single_player: Section,
    pub roguelike: Section,
    pub pvp_maps: BTreeMap<String, u64>,
}

fn sorted(m: &HashMap<String, u64>) -> BTreeMap<String, u64> {
    m.iter().map(|(k, v)| (k.clone(), *v)).collect()
}

impl Record {
    pub fn new(network: &str, game: &str, renderer: &str, owner: &str, code_sha256: BTreeMap<String, String>, seed: &FullSeed) -> Self {
        let sp = &seed.single_player;
        let rl = &seed.roguelike;
        Record {
            written_at: chrono_like_now(),
            network: network.into(),
            game: game.into(),
            renderer: renderer.into(),
            owner: owner.into(),
            code_sha256,
            single_player: Section { maps: sorted(&sp.map_ids), ai_configs: sorted(&sp.config_ids), nodes: sorted(&sp.node_ids), campaign_id: sp.campaign_id },
            roguelike: Section { maps: sorted(&rl.map_ids), ai_configs: sorted(&rl.config_ids), nodes: sorted(&rl.node_ids), campaign_id: rl.campaign_id },
            pvp_maps: sorted(&seed.pvp_maps),
        }
    }
}

/// Current UTC time as `YYYY-MM-DDTHH:MM:SSZ` (no date crate).
fn chrono_like_now() -> String {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Civil-from-days (Howard Hinnant).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

#[cfg(test)]
mod tests {
    #[test]
    fn formats_a_utc_date() {
        let s = super::chrono_like_now();
        assert_eq!(s.len(), 20);
        assert!(s.starts_with("20") && s.ends_with('Z'));
    }
}

/// A view with retry and backoff: public RPC endpoints rate-limit the ~200
/// reads `verify` makes.
async fn view(c: &Contract, method: &str, args: Value) -> Result<Value> {
    // Pace reads; public endpoints allow only a few per second.
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    let mut delay = std::time::Duration::from_millis(500);
    for attempt in 0..8 {
        match c.view(method).args_json(args.clone()).await {
            Ok(r) => return Ok(r.json()?),
            Err(e) if attempt < 7 && { let d = format!("{e:?} {e}"); d.contains("rate limit") || d.contains("TooManyRequests") } => {
                eprintln!("[verify] rate-limited on {method}; retrying in {delay:?}");
                tokio::time::sleep(delay).await;
                delay = (delay * 2).min(std::time::Duration::from_secs(20));
            }
            Err(e) => return Err(e.into()),
        }
    }
    unreachable!()
}

fn scoring_cells(tiles: &Value) -> usize {
    let mut cells: Vec<(i64, i64)> = tiles.as_array().into_iter().flatten().map(|t| (t["row"].as_i64().unwrap_or(-1), t["col"].as_i64().unwrap_or(-1))).collect();
    cells.sort();
    cells.dedup();
    cells.len()
}

/// Checks every id in the seed against the chain: each map's mode and
/// scoring-tile count, each AI config's name and variant, each campaign
/// node's map and cost/turn settings, each roguelike node's kind and map,
/// and the campaigns' wiring. Fails on the first mismatch.
pub async fn verify(game: &Contract, seed: &FullSeed) -> Result<usize> {
    let sp = read_json("ignition/data/singlePlayerStarterContent.json")?;
    let rl = read_json("ignition/data/roguelikeStarterContent.json")?;
    let pvp = read_json("ignition/data/pvpStarterContent.json")?;
    let mut checked = 0usize;

    let mut maps: Vec<(&Value, u64)> = Vec::new();
    for m in sp["maps"].as_array().unwrap() {
        if let Some(&id) = seed.single_player.map_ids.get(m["key"].as_str().unwrap()) {
            maps.push((m, id));
        }
    }
    for m in rl["maps"].as_array().unwrap() {
        maps.push((m, seed.roguelike.map_ids[m["key"].as_str().unwrap()]));
    }
    for m in pvp["maps"].as_array().unwrap() {
        maps.push((m, seed.pvp_maps[m["key"].as_str().unwrap()]));
    }
    for (m, id) in maps {
        let on = view(game, "get_preset_map", json!({"map_id": id.to_string()})).await?;
        let key = m["key"].as_str().unwrap();
        if on.is_null() || on["mode"] != m["mode"] || on["scoring"].as_array().map_or(0, |a| a.len()) != scoring_cells(&m["scoringTiles"]) {
            bail!("map {key} -> id {id}: on-chain map doesn't match the content (mode {} vs {})", on["mode"], m["mode"]);
        }
        checked += 1;
    }

    let configs: HashMap<&str, &Value> = sp["aiShipConfigs"].as_array().unwrap().iter().map(|c| (c["key"].as_str().unwrap(), c)).collect();
    let mut all_configs = seed.single_player.config_ids.clone();
    all_configs.extend(seed.roguelike.config_ids.clone());
    for (key, &id) in &all_configs {
        let c = configs[key.as_str()];
        let on = view(game, "get_ai_ship_config", json!({"config_id": id.to_string()})).await?;
        if on["name"] != c["name"] || on["traits"]["variant"] != c["traits"]["variant"] {
            bail!("AI config {key} -> id {id}: on-chain {} / variant {} vs content {} / {}", on["name"], on["traits"]["variant"], c["name"], c["traits"]["variant"]);
        }
        checked += 1;
    }

    for n in sp["campaignNodes"].as_array().unwrap() {
        let key = n["key"].as_str().unwrap();
        let id = seed.single_player.node_ids[key];
        let on = view(game, "get_node", json!({"node_id": id.to_string()})).await?;
        let map = seed.single_player.map_ids[n["mapKey"].as_str().unwrap()];
        if on["map_id"].as_u64() != Some(map) || on["cost_limit"] != n["costLimit"] || on["turn_time"] != n["turnTime"] || on["campaign_id"].as_u64() != Some(seed.single_player.campaign_id) {
            bail!("campaign node {key} -> id {id}: on-chain node doesn't match the content");
        }
        checked += 1;
    }

    for n in rl["nodes"].as_array().unwrap() {
        let key = n["key"].as_str().unwrap();
        let id = seed.roguelike.node_ids[key];
        let on = view(game, "get_rl_node", json!({"node_id": id.to_string()})).await?;
        let map_ok = if n["kind"] == "Combat" { on["map_id"].as_u64() == Some(seed.roguelike.map_ids[n["mapKey"].as_str().unwrap()]) } else { true };
        if on["kind"] != n["kind"] || !map_ok || on["campaign_id"].as_u64() != Some(seed.roguelike.campaign_id) {
            bail!("roguelike node {key} -> id {id}: on-chain node doesn't match the content");
        }
        checked += 1;
    }
    let c = view(game, "get_rl_campaign", json!({"campaign_id": seed.roguelike.campaign_id.to_string()})).await?;
    if c["root_node"].as_u64() != Some(seed.roguelike.node_ids[rl["root"].as_str().unwrap()]) {
        bail!("roguelike campaign {} has the wrong root node", seed.roguelike.campaign_id);
    }
    let settings = view(game, "get_settings", json!({})).await?;
    let medal = seed.single_player.node_ids[crate::seed::MEDAL_FINAL_NODE_KEY];
    if settings["medal_final_node"].as_str() != Some(medal.to_string().as_str()) {
        bail!("medal final node is {} on chain, expected node {medal} ({})", settings["medal_final_node"], crate::seed::MEDAL_FINAL_NODE_KEY);
    }
    let camp = view(game, "get_campaign", json!({"campaign_id": seed.single_player.campaign_id.to_string()})).await?;
    if camp["node_ids"].as_array().map_or(0, |a| a.len()) != seed.single_player.node_ids.len() {
        bail!("campaign {} node list doesn't match the seed", seed.single_player.campaign_id);
    }
    Ok(checked + 2)
}

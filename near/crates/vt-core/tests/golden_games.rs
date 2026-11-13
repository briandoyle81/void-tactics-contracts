//! Engine + AI differential test: replays single-player campaign matches that
//! were played on the Solidity stack (scripts/near-golden/
//! exportSinglePlayerGames.ts). Human moves are re-applied through
//! `GameState::move_ship`; AI turns are re-decided by the Rust AI via
//! `take_ai_turns`. After every step the full board (including hidden
//! per-ship fields), scores, gone ships, scoring tiles and last move must
//! match the Solidity snapshot exactly.

mod common;

use std::collections::HashMap;

use common::*;
use serde_json::Value;
use vt_core::ai::{take_ai_turns, AiLog, AiShipInfo};
use vt_core::effects::Resolver;
use vt_core::engine::{GameState, MoveInput, Rules, ShipBoard, Side};
use vt_core::grid::Bitmap;
use vt_core::maps::GameMap;
use vt_core::types::*;
use vt_core::{Error, Result};

struct GoldenRules {
    tables: HashMap<(u16, u16), VariantAttributeData>,
    latest: HashMap<u16, u16>,
    ram_range: u8,
    repair_range: u8,
    repair_strength: u8,
}

impl Rules for GoldenRules {
    fn faction_resolver(&self, variant: u16) -> Option<Resolver> {
        match variant {
            1 => Some(Resolver::Ram { range: self.ram_range }),
            2 => Some(Resolver::Repair { range: self.repair_range, strength: self.repair_strength }),
            _ => None,
        }
    }
    fn special_resolver(&self, variant: u16, slot: Special) -> Option<Resolver> {
        match (variant, slot) {
            (1, Special::Slot1) => Some(Resolver::Emp { slot }),
            (1, Special::Slot2) => Some(Resolver::RepairDrones { slot }),
            (1, Special::Slot3) => Some(Resolver::FlakArray { slot }),
            (2, Special::Slot1) => Some(Resolver::ElectricStorm { slot }),
            (2, Special::Slot2) => Some(Resolver::DroneSwarm { slot }),
            _ => None,
        }
    }
    fn special_data_at(&self, variant: u16, version: u16, slot: Special) -> Result<SpecialData> {
        if version == 0 || version > *self.latest.get(&variant).unwrap_or(&0) {
            return Err(Error::InvalidAttributesVersion);
        }
        Ok(self.tables[&(variant, version)].specials[slot.index()].clone())
    }
}

fn rules(v: &Value) -> GoldenRules {
    let mut tables = HashMap::new();
    let mut latest = HashMap::new();
    for (variant, list) in v["variantTables"].as_object().unwrap() {
        let variant: u16 = variant.parse().unwrap();
        for e in list.as_array().unwrap() {
            let ver = n(&e["version"]) as u16;
            tables.insert((variant, ver), attributes_table(&e["data"]));
            latest.insert(variant, ver.max(*latest.get(&variant).unwrap_or(&0)));
        }
    }
    GoldenRules {
        tables,
        latest,
        ram_range: n(&v["ramRange"]) as u8,
        repair_range: n(&v["repairRange"]) as u8,
        repair_strength: n(&v["repairStrength"]) as u8,
    }
}

fn decode_word(w: &[u8; 32]) -> ShipBoard {
    ShipBoard {
        row: bits(w, 0, 16) as u16 as i16,
        col: bits(w, 16, 16) as u16 as i16,
        is_creator: bits(w, 32, 8) != 0,
        status: bits(w, 40, 8) as u8,
        placed: bits(w, 48, 8) != 0,
        version: bits(w, 56, 16) as u16,
        range: bits(w, 72, 8) as u8,
        gun_damage: bits(w, 80, 8) as u8,
        hull_points: bits(w, 88, 8) as u8,
        max_hull_points: bits(w, 96, 8) as u8,
        movement: bits(w, 104, 8) as u8,
        damage_reduction: bits(w, 112, 8) as u8,
        reactor_critical_timer: bits(w, 120, 8) as u8,
        moved_in_round: bits(w, 128, 24),
        zeroed_after_moving_round: bits(w, 152, 24),
        active_index: bits(w, 176, 8) as u8,
        variant: bits(w, 184, 16) as u16,
        special: Special::from_index(bits(w, 200, 8) as usize).unwrap(),
        last_damager: bits(w, 208, 48),
    }
}

fn positions(v: &Value) -> Vec<Position> {
    v.as_array().unwrap().iter().map(|p| Position { row: i(&p["row"]) as i16, col: i(&p["col"]) as i16 }).collect()
}

fn initial_state(game: &Value) -> GameState {
    let snap = &game["initial"];
    let board = snap["board"].as_array().unwrap();
    let mut g = GameState {
        game_id: n(&game["gameId"]),
        creator_goes_first: game["creatorGoesFirst"].as_bool().unwrap(),
        current_turn: if snap["humanTurn"].as_bool().unwrap() { Side::Creator } else { Side::Joiner },
        current_round: 1,
        max_score: n(&game["maxScore"]),
        heal_cap_percent_at_start: 80,
        occupied: Bitmap::from_u256_be(&u256(&board[0])),
        live: [Bitmap::from_u256_be(&u256(&board[1])), Bitmap::from_u256_be(&u256(&board[2]))],
        ..Default::default()
    };
    let mut i_ = 7;
    while i_ + 1 < board.len() {
        let id = n(&Value::String(u64::from_str_radix(board[i_].as_str().unwrap().trim_start_matches("0x"), 16).unwrap().to_string()));
        let b = decode_word(&u256(&board[i_ + 1]));
        if b.is_creator { g.creator_active.push(id) } else { g.joiner_active.push(id) }
        g.board.insert(id, b);
        i_ += 2;
    }
    g.total_active_at_round_start = (g.creator_active.len() + g.joiner_active.len()) as u64;
    let preset = vt_core::maps::PresetMap::new(
        &positions(&game["map"]["blocked"]),
        &positions(&game["map"]["impassable"]),
        &snap["scoring"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| ScoringPosition { row: i(&s[0]) as i16, col: i(&s[1]) as i16, points: n(&s[2]) as u8, only_once: s[3].as_bool().unwrap() })
            .collect::<Vec<_>>(),
        MapMode::Both,
    )
    .unwrap();
    g.map = GameMap::from_preset(&preset);
    g
}

fn hex_id(v: &Value) -> u64 {
    u64::from_str_radix(v.as_str().unwrap().trim_start_matches("0x"), 16).unwrap()
}

/// Asserts the Rust state equals a Solidity snapshot.
fn check(g: &GameState, snap: &Value, ctx: &str) {
    let board = snap["board"].as_array().unwrap();
    assert_eq!(g.occupied, Bitmap::from_u256_be(&u256(&board[0])), "{ctx}: occupied");
    assert_eq!(g.live[0], Bitmap::from_u256_be(&u256(&board[1])), "{ctx}: creator live");
    assert_eq!(g.live[1], Bitmap::from_u256_be(&u256(&board[2])), "{ctx}: joiner live");
    assert_eq!(g.current_round, hex_id(&board[3]), "{ctx}: round");
    assert_eq!(g.ended as u64, hex_id(&board[4]), "{ctx}: ended");
    assert_eq!(g.current_turn == Side::Creator, snap["humanTurn"].as_bool().unwrap(), "{ctx}: current turn");

    let mut want_ids = Vec::new();
    let mut k = 7;
    while k + 1 < board.len() {
        let id = hex_id(&board[k]);
        let mut want = decode_word(&u256(&board[k + 1]));
        let mut got = g.ship(id);
        // Stored as uint24 on chain.
        got.moved_in_round &= 0xFF_FFFF;
        got.zeroed_after_moving_round &= 0xFF_FFFF;
        want.moved_in_round &= 0xFF_FFFF;
        assert_eq!(got, want, "{ctx}: ship {id}");
        want_ids.push(id);
        k += 2;
    }
    let got_ids: Vec<u64> = g.creator_active.iter().chain(g.joiner_active.iter()).copied().collect();
    assert_eq!(got_ids, want_ids, "{ctx}: active ship order");

    assert_eq!(g.creator_score, n(&snap["creatorScore"]), "{ctx}: creator score");
    assert_eq!(g.joiner_score, n(&snap["joinerScore"]), "{ctx}: joiner score");
    if g.ended {
        assert_eq!(g.winner == Some(Side::Creator), snap["winnerIsHuman"].as_bool().unwrap(), "{ctx}: winner human");
        assert_eq!(g.winner == Some(Side::Joiner), snap["winnerIsAI"].as_bool().unwrap(), "{ctx}: winner AI");
    }

    let want_pos: Vec<(u64, i64, i64, bool, u64)> = snap["positions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| (n(&p[0]), i(&p[1]), i(&p[2]), p[3].as_bool().unwrap(), n(&p[4])))
        .collect();
    let got_pos: Vec<(u64, i64, i64, bool, u64)> =
        g.all_ship_positions().iter().map(|p| (p.ship_id, p.row as i64, p.col as i64, p.is_creator, p.status as u64)).collect();
    assert_eq!(got_pos, want_pos, "{ctx}: positions (active + gone)");

    let want_scoring: Vec<(i64, i64, u64, bool)> =
        snap["scoring"].as_array().unwrap().iter().map(|s| (i(&s[0]), i(&s[1]), n(&s[2]), s[3].as_bool().unwrap())).collect();
    let got_scoring: Vec<(i64, i64, u64, bool)> =
        g.map.scoring_positions().iter().map(|s| (s.row as i64, s.col as i64, s.points as u64, s.only_once)).collect();
    assert_eq!(got_scoring, want_scoring, "{ctx}: scoring tiles");

    let lm = &snap["lastMove"];
    if let Some(m) = &g.last_move {
        let want = (n(&lm["shipId"]), i(&lm["oldRow"]), i(&lm["oldCol"]), i(&lm["newRow"]), i(&lm["newCol"]), n(&lm["actionType"]), n(&lm["targetShipId"]));
        let got = (m.ship_id, m.old_row as i64, m.old_col as i64, m.new_row as i64, m.new_col as i64, m.action_type as u64, m.target_ship_id);
        assert_eq!(got, want, "{ctx}: last move");
    }
}

#[test]
fn single_player_games_match_solidity() {
    let golden = load("single_player_games.json");
    let rules = rules(&golden["rules"]);
    let games = golden["games"].as_array().unwrap();
    assert!(!games.is_empty());
    let mut total_steps = 0;

    for game in games {
        let node = n(&game["nodeId"]);
        let infos: HashMap<u64, AiShipInfo> = game["aiInfo"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(id, v)| {
                (
                    id.parse().unwrap(),
                    AiShipInfo {
                        archetype: Archetype::from_index(n(&v["archetype"]) as usize).unwrap(),
                        variant: n(&v["variant"]) as u16,
                        special: Special::from_index(n(&v["special"]) as usize).unwrap(),
                    },
                )
            })
            .collect();
        let mut g = initial_state(game);
        check(&g, &game["initial"], &format!("node {node} initial"));

        for (s, step) in game["steps"].as_array().unwrap().iter().enumerate() {
            let ctx = format!("node {node} step {s} ({})", step["kind"]);
            match step["kind"].as_str().unwrap() {
                "human" => {
                    let m = &step["move"];
                    let input = MoveInput {
                        ship_id: n(&m["shipId"]),
                        new_row: i(&m["row"]) as i16,
                        new_col: i(&m["col"]) as i16,
                        action: ActionType::from_index(n(&m["action"]) as usize).unwrap(),
                        target_ship_id: n(&m["target"]),
                    };
                    g.move_ship(Side::Creator, &input, &rules, 0).unwrap_or_else(|e| panic!("{ctx}: human move rejected: {e}"));
                }
                "ai" => {
                    let out = take_ai_turns(&mut g, &rules, &|id| infos.get(&id).cloned(), 1, 0)
                        .unwrap_or_else(|e| panic!("{ctx}: ai turn failed: {e}"));
                    let want_logs: Vec<AiLog> = step["aiLogs"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|l| match l["event"].as_str().unwrap() {
                            "AIDecisionFailed" => AiLog::DecisionFailed { ship_id: n(&l["shipId"]) },
                            _ => AiLog::TurnTaken {
                                ship_id: n(&l["shipId"]),
                                action: ActionType::from_index(n(&l["action"]) as usize).unwrap(),
                                target: n(&l["target"]),
                            },
                        })
                        .collect();
                    assert_eq!(out.logs, want_logs, "{ctx}: AI decision");
                }
                k => panic!("unknown step kind {k}"),
            }
            check(&g, &step["snapshot"], &ctx);
            total_steps += 1;
        }
    }
    eprintln!("replayed {} games / {total_steps} steps", games.len());
}

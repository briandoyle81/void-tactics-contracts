//! Match and run drivers: campaign nodes (player vs on-chain AI), PvP
//! (player vs player), and whole roguelike runs. All randomness comes from
//! the seeded RNG passed in; the engine itself is deterministic.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use rand::Rng;
use rand_chacha::ChaCha8Rng;
use vt_core::ai::{take_ai_turns, AiShipInfo};
use vt_core::engine::{
    EngineEvent, FleetEntry, GameState, Side, STATUS_ALIVE, STATUS_DESTROYED, STATUS_FLED,
};
use vt_core::maps::GameMap;
use vt_core::roguelike::{heal_above_floor, healed_hp, repair_missing_hp};
use vt_core::types::{Position, Ship};

use crate::content::{Content, RlKind, WinEffect, AI_SHIP_ID_OFFSET};
use crate::fleet;
use crate::log::{MatchLog, MoveLog, RunLog, ShipLog, SideLog};

/// Record every move and board in match logs (`--log-moves`; off by
/// default to keep output small). Read by `vt-sim replay`.
pub static LOG_MOVES: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn log_moves() -> bool {
    LOG_MOVES.load(std::sync::atomic::Ordering::Relaxed)
}
use crate::rules::Config;
use crate::tactics::Tactician;

/// Hard stops so a stalemate can't run forever.
#[derive(Clone, Copy, Debug)]
pub struct Limits {
    pub max_rounds: u64,
    pub max_moves: u32,
}

impl Default for Limits {
    fn default() -> Self {
        Limits {
            max_rounds: 40,
            max_moves: 4000,
        }
    }
}

/// Who plays a side.
pub enum Controller<'a> {
    Agent(&'a dyn Tactician),
    /// The on-chain AI (joiner side only, as on chain).
    OnChainAi(&'a HashMap<u64, AiShipInfo>),
}

impl Controller<'_> {
    fn name(&self) -> String {
        match self {
            Controller::Agent(t) => t.name(),
            Controller::OnChainAi(_) => "onchain_ai".into(),
        }
    }
}

/// One side's fleet as it entered the game.
pub struct SideSetup<'a> {
    pub label: String,
    pub ships: Vec<&'a Ship>,
    pub cells: Vec<Position>,
    pub controller: Controller<'a>,
    /// AI config key per ship id (PvE AI fleets).
    pub ai_keys: HashMap<u64, String>,
}

/// What a played game produced, before it's turned into a log line.
pub struct Played {
    pub game: GameState,
    pub log: MatchLog,
}

fn enum_name<T: serde::Serialize>(v: &T) -> String {
    serde_json::to_value(v)
        .ok()
        .and_then(|x| x.as_str().map(str::to_string))
        .unwrap_or_default()
}

fn hp_map(g: &GameState) -> BTreeMap<u64, u8> {
    g.board.iter().map(|(&id, b)| (id, b.hull_points)).collect()
}

/// Plays a game to the end (or a limit). Returns the end reason.
#[allow(clippy::too_many_arguments)]
fn play_out(
    g: &mut GameState,
    cfg: &Config,
    creator: &Controller,
    joiner: &Controller,
    limits: Limits,
    rng: &mut ChaCha8Rng,
    stats: &mut BTreeMap<u64, ShipLog>,
    actions: &mut [[u32; 6]; 2],
    transcript: &mut Vec<MoveLog>,
) -> (&'static str, u32) {
    let mut moves = 0u32;
    let logging = log_moves();
    while !g.ended {
        if g.current_round > limits.max_rounds || moves >= limits.max_moves {
            let _ = g.force_end(None);
            return ("round_cap", moves);
        }
        let side = g.current_turn;
        let ctl = if side == Side::Creator {
            creator
        } else {
            joiner
        };
        let before = hp_map(g);
        let now = moves as u64 + 1;
        let foe = if side == Side::Creator { joiner } else { creator };
        let foe_ai = match foe {
            Controller::OnChainAi(info) => Some(*info),
            Controller::Agent(_) => None,
        };
        let (actor, action, events) = match ctl {
            Controller::Agent(t) => {
                let Some(mv) = t.choose_vs(g, &cfg.rules, side, rng, foe_ai) else {
                    let _ = g.force_end(None);
                    return ("stalled", moves);
                };
                let events = g
                    .move_ship(side, &mv, &cfg.rules, now)
                    .unwrap_or_else(|e| panic!("{} chose an illegal move {mv:?}: {e:?}", t.name()));
                (mv.ship_id, mv.action, events)
            }
            Controller::OnChainAi(info) => {
                assert_eq!(
                    side,
                    Side::Joiner,
                    "the on-chain AI only plays the joiner side"
                );
                let r = take_ai_turns(g, &cfg.rules, &|id| info.get(&id).cloned(), 1, now)
                    .unwrap_or_else(|e| panic!("take_ai_turns: {e}"));
                if r.moves == 0 {
                    if !g.ended {
                        let _ = g.force_end(None);
                        return ("stalled", moves);
                    }
                    // The AI conceded (no live ships left).
                    record(g, &before, 0, None, &r.events, stats, actions);
                    break;
                }
                let lm = g.last_move.clone().expect("AI moved");
                (lm.ship_id, lm.action_type, r.events)
            }
        };
        moves += 1;
        record(g, &before, actor, Some(action), &events, stats, actions);
        if logging {
            let (to, target) = match &g.last_move {
                Some(lm) => ([lm.new_row, lm.new_col], lm.target_ship_id),
                None => ([-1, -1], 0),
            };
            transcript.push(MoveLog {
                side: if side == Side::Creator { 0 } else { 1 },
                ship: actor,
                action: format!("{action:?}"),
                to,
                target,
                board: vt_core::replay::compact_board(g),
            });
        }
    }
    ("decided", moves)
}

/// Attributes one move's HP changes and kills.
fn record(
    g: &GameState,
    before: &BTreeMap<u64, u8>,
    actor: u64,
    action: Option<vt_core::types::ActionType>,
    events: &[EngineEvent],
    stats: &mut BTreeMap<u64, ShipLog>,
    actions: &mut [[u32; 6]; 2],
) {
    let actor_side = if actor == 0 {
        None
    } else {
        Some(g.ship(actor).is_creator)
    };
    if let (Some(a), Some(creator)) = (action, actor_side) {
        actions[if creator { 0 } else { 1 }][a.index()] += 1;
        if let Some(s) = stats.get_mut(&actor) {
            s.moves += 1;
        }
    }
    for (&id, &hp0) in before {
        let hp1 = g.ship(id).hull_points;
        let victim_creator = g.ship(id).is_creator;
        if hp1 < hp0 {
            let d = (hp0 - hp1) as u32;
            if let Some(s) = stats.get_mut(&id) {
                s.damage_taken += d;
            }
            if actor_side.is_some_and(|c| c != victim_creator) {
                if let Some(s) = stats.get_mut(&actor) {
                    s.damage_dealt += d;
                }
            }
        } else if hp1 > hp0 && actor_side == Some(victim_creator) {
            if let Some(s) = stats.get_mut(&actor) {
                s.healed += (hp1 - hp0) as u32;
            }
        }
    }
    for e in events {
        if let EngineEvent::ShipDestroyed { last_damager, .. } = *e {
            if let Some(s) = stats.get_mut(&last_damager) {
                s.kills += 1;
            }
        }
    }
}

fn ship_log(
    cfg: &Config,
    s: &Ship,
    side: u8,
    cell: Position,
    ai_config: Option<String>,
) -> ShipLog {
    let a = cfg.attributes(s).expect("attributes");
    ShipLog {
        id: s.id,
        side,
        name: s.name.clone(),
        variant: s.traits.variant,
        weapon: enum_name(&s.equipment.main_weapon),
        armor: enum_name(&s.equipment.armor),
        shields: enum_name(&s.equipment.shields),
        special: enum_name(&s.equipment.special),
        accuracy: s.traits.accuracy,
        hull: s.traits.hull,
        speed: s.traits.speed,
        kills_rank: s.ship_data.ships_destroyed,
        cost: s.ship_data.cost,
        list_cost: cfg.cost(s).unwrap_or(0),
        ai_config,
        row: cell.row,
        col: cell.col,
        max_hp: a.max_hull_points,
        ..Default::default()
    }
}

/// Starts and plays a game between two set-up sides.
#[allow(clippy::too_many_arguments)]
pub fn play_match(
    cfg: &Config,
    kind: &'static str,
    seed: u64,
    map_key: &str,
    node: Option<&str>,
    map: &vt_core::maps::PresetMap,
    creator: SideSetup,
    joiner: SideSetup,
    creator_goes_first: bool,
    max_score: u64,
    carried_hp: &[(u64, u8)],
    limits: Limits,
    rng: &mut ChaCha8Rng,
) -> Played {
    let ce: Vec<FleetEntry> = fleet::entries(cfg, &creator.ships, &creator.cells);
    let je: Vec<FleetEntry> = fleet::entries(cfg, &joiner.ships, &joiner.cells);
    let mut g = GameState::start(
        1,
        &ce,
        &je,
        creator_goes_first,
        600,
        max_score,
        cfg.heal_cap_percent,
        GameMap::from_preset(map),
        0,
    )
    .expect("game starts");
    for &(id, hp) in carried_hp {
        if hp != 0 && hp < g.ship(id).max_hull_points {
            g.set_initial_hull_points(id, hp).expect("carried HP");
        }
    }
    let mut stats: BTreeMap<u64, ShipLog> = BTreeMap::new();
    for (side, s) in [(0u8, &creator), (1u8, &joiner)] {
        for (ship, cell) in s.ships.iter().zip(&s.cells) {
            let mut l = ship_log(
                cfg,
                ship,
                side,
                cell.clone(),
                s.ai_keys.get(&ship.id).cloned(),
            );
            l.start_hp = g.ship(ship.id).hull_points;
            stats.insert(ship.id, l);
        }
    }
    let mut actions = [[0u32; 6]; 2];
    let start_board = log_moves().then(|| vt_core::replay::compact_board(&g));
    let mut transcript = Vec::new();
    let (end, moves) = play_out(
        &mut g,
        cfg,
        &creator.controller,
        &joiner.controller,
        limits,
        rng,
        &mut stats,
        &mut actions,
        &mut transcript,
    );
    for (id, l) in stats.iter_mut() {
        let b = g.ship(*id);
        l.end_hp = b.hull_points;
        l.outcome = match b.status {
            STATUS_DESTROYED => "destroyed",
            STATUS_FLED => "fled",
            STATUS_ALIVE if b.hull_points == 0 => "disabled",
            _ => "alive",
        }
        .into();
    }
    let side_log = |s: &SideSetup| SideLog {
        label: s.label.clone(),
        tactician: s.controller.name(),
        fleet_cost: fleet::cost(&s.ships),
        fleet_list_cost: s
            .ships
            .iter()
            .map(|x| cfg.cost(x).unwrap_or(0) as u64)
            .sum(),
        ships: s.ships.len(),
    };
    let log = MatchLog {
        record: "match",
        kind,
        seed,
        map: map_key.to_string(),
        node: node.map(str::to_string),
        creator: side_log(&creator),
        joiner: side_log(&joiner),
        winner: match g.winner {
            Some(Side::Creator) => "creator",
            Some(Side::Joiner) => "joiner",
            None => "draw",
        },
        end,
        rounds: g.current_round,
        moves,
        scores: [g.creator_score, g.joiner_score],
        actions,
        ship_logs: stats.into_values().collect(),
        start_board,
        transcript,
    };
    Played { game: g, log }
}

/// The on-chain AI fleet for a PvE map, as a joiner side.
pub struct AiSide {
    pub ships: Vec<Ship>,
    pub cells: Vec<Position>,
    pub info: HashMap<u64, AiShipInfo>,
    pub keys: HashMap<u64, String>,
}

impl AiSide {
    pub fn for_map(content: &Content, cfg: &Config, map: &str) -> AiSide {
        let (entries, info) = content.ai_fleet(cfg, map);
        let mut cells: Vec<(u16, &String)> = content
            .placements
            .get(map)
            .map(|v| {
                v.iter()
                    .map(|(p, k)| ((p.row * vt_core::grid::GRID_WIDTH + p.col) as u16, k))
                    .collect()
            })
            .unwrap_or_default();
        cells.sort_by_key(|c| c.0);
        let mut ships = Vec::new();
        let mut keys = HashMap::new();
        for (e, (_, key)) in entries.iter().zip(&cells) {
            ships.push(Ship {
                id: e.ship_id,
                ..content.ai_configs[*key].ship.clone()
            });
            keys.insert(e.ship_id, (*key).clone());
        }
        AiSide {
            cells: entries
                .iter()
                .map(|e| Position {
                    row: e.row,
                    col: e.col,
                })
                .collect(),
            ships,
            info,
            keys,
        }
    }

    pub fn side(&self) -> SideSetup<'_> {
        SideSetup {
            label: "onchain_ai".into(),
            ships: self.ships.iter().collect(),
            cells: self.cells.clone(),
            controller: Controller::OnChainAi(&self.info),
            ai_keys: self.keys.clone(),
        }
    }
}

/// DEC the player earns from a finished PvE game: faction_kill_reward per AI
/// ship of a rewarded variant (only variant 2 pays, in DEC) that one of the
/// player's ships destroyed.
pub fn pve_dec_reward(g: &GameState, ai: &AiSide, reward_variants: &[u16], per_kill: u64) -> u64 {
    ai_kills(g, ai, reward_variants) * per_kill
}

fn ai_kills(g: &GameState, ai: &AiSide, reward_variants: &[u16]) -> u64 {
    ai.ships
        .iter()
        .filter(|s| reward_variants.contains(&s.traits.variant))
        .filter(|s| {
            let b = g.ship(s.id);
            b.status == STATUS_DESTROYED
                && b.last_damager != 0
                && b.last_damager < AI_SHIP_ID_OFFSET
        })
        .count() as u64
}

// ================================================================ roguelike

/// The decisions a player makes during a roguelike run (Phase 3 gives these
/// skill levels; `BasicPlanner` is the Poor baseline).
pub trait RunPlanner: Sync {
    /// Which of the open children to go to next (index into `choices`).
    fn next_node(&self, v: &RunView, choices: &[&str], rng: &mut ChaCha8Rng) -> usize;
    /// At a resupply node: ships to repair (UTC per HP) and roster changes.
    fn resupply(&self, v: &RunView, rng: &mut ChaCha8Rng) -> ResupplyPlan;
    /// Deployment cells for the roster at combat node `node`.
    fn place(
        &self,
        v: &RunView,
        node: &str,
        ships: &[&Ship],
        rng: &mut ChaCha8Rng,
    ) -> Vec<Position>;
}

/// What a planner can see mid-run.
pub struct RunView<'a> {
    pub content: &'a Content,
    pub cfg: &'a Config,
    /// Every ship the player owns (roster and reserves).
    pub pool: &'a [Ship],
    /// (ship id, stored HP; 0 = full).
    pub roster: &'a [(u64, u8)],
    pub cap: u64,
    /// Ships destroyed earlier in this run (can't be added back).
    pub destroyed: &'a BTreeSet<u64>,
}

#[derive(Default)]
pub struct ResupplyPlan {
    pub repair: Vec<u64>,
    pub add: Vec<u64>,
    pub remove: Vec<u64>,
}

/// Random path, no repairs or roster changes, random placement.
pub struct BasicPlanner;

impl RunPlanner for BasicPlanner {
    fn next_node(&self, _: &RunView, choices: &[&str], rng: &mut ChaCha8Rng) -> usize {
        rng.gen_range(0..choices.len())
    }
    fn resupply(&self, _: &RunView, _: &mut ChaCha8Rng) -> ResupplyPlan {
        ResupplyPlan::default()
    }
    fn place(
        &self,
        v: &RunView,
        node: &str,
        ships: &[&Ship],
        rng: &mut ChaCha8Rng,
    ) -> Vec<Position> {
        let map = v.content.roguelike.nodes[node].map.as_deref();
        fleet::random_cells(&v.content.deployment_tiles(map, true), ships.len(), rng)
    }
}

/// A finished roguelike run: its log line, each combat's match log, and the
/// inventory changes the economy must apply.
pub struct RunResult {
    pub log: RunLog,
    pub matches: Vec<MatchLog>,
    pub lost: Vec<u64>,
    pub grants: Vec<Ship>,
    pub dec: u64,
    /// After each won combat: (node key, roster as (ship id, stored HP; 0 =
    /// full), each ship's max HP). For tests and analysis.
    pub after_wins: Vec<(String, Vec<(u64, u8, u8)>)>,
    /// Once-per-player grant nodes claimed, including earlier runs'.
    pub grants_claimed: BTreeSet<String>,
}

/// Plays a whole roguelike run with the contract's rules (vt-core::roguelike):
/// carried HP, the heal floor after wins, rejoining fled ships under the cost
/// cap, one-way graph locking, resupply cap changes, win effects.
#[allow(clippy::too_many_arguments)]
pub fn run_roguelike(
    content: &Content,
    cfg: &Config,
    seed: u64,
    label: &str,
    pool: &[Ship],
    roster_ids: &[u64],
    planner: &dyn RunPlanner,
    tactician: &dyn Tactician,
    grants_claimed: &BTreeSet<String>,
    // Most HP the player can pay to repair (UTC / repair cost per HP);
    // u64::MAX = unlimited. Resupply repairs are all-or-nothing per ship.
    repair_budget_hp: u64,
    limits: Limits,
    rng: &mut ChaCha8Rng,
) -> RunResult {
    let c = &content.roguelike;
    let by_id: HashMap<u64, &Ship> = pool.iter().map(|s| (s.id, s)).collect();
    let max_hp = |id: u64| cfg.attributes(by_id[&id]).expect("attrs").max_hull_points;
    let mut roster: Vec<(u64, u8)> = roster_ids.iter().map(|&id| (id, 0)).collect();
    let mut dropped: HashMap<u64, u8> = HashMap::new();
    let mut destroyed: BTreeSet<u64> = BTreeSet::new();
    let mut cap = c.initial_cost_cap;
    let mut current = c.root.clone();
    let mut defeated: BTreeSet<String> = BTreeSet::new();
    let mut locked: BTreeSet<String> = BTreeSet::new();
    let mut path = vec![current.clone()];
    let (mut combats_won, mut dec, mut repair_hp) = (0u32, 0u64, 0u64);
    let mut matches = Vec::new();
    let mut grants = Vec::new();
    let mut after_wins: Vec<(String, Vec<(u64, u8, u8)>)> = Vec::new();
    let mut granted_once: BTreeSet<String> = grants_claimed.clone();
    let reward_variants = [2u16];

    // set_roster: kept ships keep their HP; returning ships get their dropped
    // HP back; ships leaving stash theirs.
    fn set_roster(
        roster: &mut Vec<(u64, u8)>,
        dropped: &mut HashMap<u64, u8>,
        ids: &[u64],
        hps: Option<&[u8]>,
    ) {
        let old = std::mem::take(roster);
        for (i, &id) in ids.iter().enumerate() {
            let mut hp = old
                .iter()
                .find(|e| e.0 == id)
                .map(|e| e.1)
                .unwrap_or_else(|| dropped.remove(&id).unwrap_or(0));
            if let Some(h) = hps {
                hp = h[i];
            }
            roster.push((id, hp));
        }
        for (id, hp) in old {
            if !ids.contains(&id) && hp != 0 {
                dropped.insert(id, hp);
            }
        }
    }

    let end: &'static str = loop {
        let node = &c.nodes[&current];
        if node.kind == RlKind::Combat && !defeated.contains(&current) {
            let map_key = node.map.as_deref().expect("combat map");
            let map = &content.maps[map_key];
            let ids: Vec<u64> = roster.iter().map(|e| e.0).collect();
            let ships: Vec<&Ship> = ids.iter().map(|id| by_id[id]).collect();
            let tiles = content.deployment_tiles(Some(map_key), true);
            if tiles.len() < ships.len() {
                break "roster_exceeds_zone";
            }
            let view = RunView {
                content,
                cfg,
                pool,
                roster: &roster,
                cap,
                destroyed: &destroyed,
            };
            let cells = planner.place(&view, &current, &ships, rng);
            let ai = AiSide::for_map(content, cfg, map_key);
            let me = SideSetup {
                label: label.into(),
                ships,
                cells,
                controller: Controller::Agent(tactician),
                ai_keys: HashMap::new(),
            };
            let played = play_match(
                cfg,
                "roguelike",
                seed,
                map_key,
                Some(&current),
                map,
                me,
                ai.side(),
                node.creator_goes_first,
                node.max_score,
                &roster,
                limits,
                rng,
            );
            let g = &played.game;
            dec += pve_dec_reward(g, &ai, &reward_variants, 1);
            for &id in &ids {
                if g.ship(id).status == STATUS_DESTROYED {
                    destroyed.insert(id);
                }
            }
            matches.push(played.log);
            if g.winner != Some(Side::Creator) {
                break "lost";
            }
            combats_won += 1;
            defeated.insert(current.clone());
            // _postWinRoster: survivors, then fled ships that can rejoin.
            let heal = c.auto_heal_percent;
            let survivors: Vec<u64> = ids
                .iter()
                .copied()
                .filter(|&id| g.ship(id).status == STATUS_ALIVE)
                .collect();
            let mut new_ids = survivors.clone();
            let mut hps: Vec<u8> = survivors
                .iter()
                .map(|&id| healed_hp(heal, g.ship(id).hull_points, g.ship(id).max_hull_points))
                .collect();
            for &id in &ids {
                if g.ship(id).status == STATUS_FLED {
                    new_ids.push(id);
                    hps.push(healed_hp(heal, 0, max_hp(id)));
                }
            }
            set_roster(&mut roster, &mut dropped, &new_ids, Some(&hps));
            for eff in &node.win_effects {
                match eff {
                    WinEffect::DecBonus(n) => dec += n,
                    WinEffect::HealAboveFloor(pct) => {
                        for e in roster.iter_mut() {
                            if let Some(hp) = heal_above_floor(e.1, max_hp(e.0), *pct) {
                                e.1 = hp;
                            }
                        }
                    }
                    WinEffect::ShipGrant(ship, once) => {
                        if !*once || granted_once.insert(current.clone()) {
                            grants.push(ship.clone());
                        }
                    }
                }
            }
            after_wins.push((
                current.clone(),
                roster
                    .iter()
                    .map(|&(id, hp)| (id, hp, max_hp(id)))
                    .collect(),
            ));
            if node.children.is_empty() {
                break "won";
            }
            // reserveFleet(survivors + rejoiners) under the cap, else survivors.
            let total: u64 = new_ids
                .iter()
                .map(|id| by_id[id].ship_data.cost as u64)
                .sum();
            if new_ids.len() > 44 || total > cap {
                set_roster(&mut roster, &mut dropped, &survivors, None);
            }
        }
        // Advance: an open child of the current node.
        let open: Vec<&str> = node
            .children
            .iter()
            .filter(|k| !locked.contains(*k))
            .map(String::as_str)
            .collect();
        if open.is_empty() {
            break "no_path";
        }
        let view = RunView {
            content,
            cfg,
            pool,
            roster: &roster,
            cap,
            destroyed: &destroyed,
        };
        let next = open[planner.next_node(&view, &open, rng).min(open.len() - 1)].to_string();
        for k in vt_core::roguelike::locked_by_advance(&current, &next, &node.children) {
            locked.insert(k);
        }
        current = next;
        path.push(current.clone());
        let node = &c.nodes[&current];
        if node.kind == RlKind::Resupply {
            if node.cost_cap_override != 0 {
                cap = node.cost_cap_override;
            }
            let view = RunView {
                content,
                cfg,
                pool,
                roster: &roster,
                cap,
                destroyed: &destroyed,
            };
            let plan = planner.resupply(&view, rng);
            for id in &plan.repair {
                if let Some(e) = roster.iter_mut().find(|e| e.0 == *id) {
                    let m = max_hp(*id);
                    let need = repair_missing_hp(e.1, m) as u64;
                    if repair_hp + need > repair_budget_hp {
                        continue; // can't afford this one
                    }
                    repair_hp += need;
                    e.1 = m;
                }
            }
            if !plan.add.is_empty() || !plan.remove.is_empty() {
                let mut ids: Vec<u64> = roster
                    .iter()
                    .map(|e| e.0)
                    .filter(|id| !plan.remove.contains(id))
                    .collect();
                for id in &plan.add {
                    let ok = by_id.get(id).is_some_and(|s| {
                        s.traits.variant == c.required_variant || c.required_variant == 0
                    }) && !ids.contains(id)
                        && !destroyed.contains(id);
                    if ok {
                        ids.push(*id);
                    }
                }
                let total: u64 = ids.iter().map(|id| by_id[id].ship_data.cost as u64).sum();
                if !ids.is_empty() && total <= cap {
                    set_roster(&mut roster, &mut dropped, &ids, None);
                }
            }
        }
    };
    let log = RunLog {
        record: "run",
        seed,
        label: label.into(),
        path,
        combats_won,
        won: end == "won",
        end,
        dec_earned: dec,
        repair_utc_hp: repair_hp,
        ships_lost: destroyed.iter().copied().collect(),
        granted: grants.iter().map(|s| s.name.clone()).collect(),
    };
    RunResult {
        log,
        matches,
        lost: destroyed.into_iter().collect(),
        grants,
        dec,
        after_wins,
        grants_claimed: granted_once,
    }
}

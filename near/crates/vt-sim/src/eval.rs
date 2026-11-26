//! Position evaluation: a weighted sum of hand-designed features whose weights
//! are learned by self-play (`train.rs`), not hand-set.
//!
//! Every feature is "us minus them", so the evaluation is antisymmetric:
//! `evaluate(g, side) == -evaluate(g, side.other())`. Search relies on that.
//!
//! The rules the features encode (vt-core engine): damage is deterministic
//! (gun damage reduced by damage reduction %); a ship at 0 HP is disabled and
//! its reactor timer ticks each round and each time it is shot, destroying it
//! at 3; at the end of each round every live ship on a scoring tile scores;
//! reaching max score or eliminating the enemy's live ships ends the game.

use std::path::Path;

use serde::{Deserialize, Serialize};
use vt_core::engine::{GameState, ShipBoard, Side, STATUS_ALIVE};
use vt_core::grid::{manhattan, Bitmap};

pub const N_FEATURES: usize = 34;

pub const FEATURE_NAMES: [&str; N_FEATURES] = [
    "hp",         // operational HP / 100
    "live",       // operational ships
    "disabled",   // disabled (0 HP) ships still on the board
    "firepower",  // operational gun damage / 100
    "score",      // score / 10
    "score_race", // (score / max_score)^2: closeness to a points win
    "tile_hold",  // points on live scoring tiles our live ships stand on / 10
    "tile_reach", // points weighted by 1/(1 + nearest ship distance) / 10
    "threat",     // damage the enemy can deal next round (negated) / 100
    "killable",   // our ships the enemy can disable next round (negated)
    "shots_now",  // (our ship, enemy) pairs we can shoot from where we stand
    "tempo",      // operational ships yet to move this round
    "to_move",    // 1 if it is our turn
    "reactor",    // reactor timers on our disabled ships
    // Added 2026-11-18 (iteration 2) from the human benchmark notes: "avoid
    // places they can't shoot an enemy but can be shot", "locally unfair
    // fights", "repairing a ship on a scoring tile matters more than
    // damage", "focus enemy repair ships first", "protect the healers".
    "exposed",        // our ships an enemy can reach next round that have no shot now (negated)
    "outgun",         // (enemy, our ship) reach pairs: theirs on us minus ours on them (negated)
    "held_hp",        // HP of our live ships on live scoring tiles / 100, times each tile's pace (see below)
    "repair_live",    // our operational repair ships
    "repair_exposed", // our operational repair ships an enemy can reach next round (negated)
    // Added 2026-11-18: tile value measured against the score still needed
    // to win. A tile's "pace" for a side is min(1, points / (max score -
    // that side's score)): the share of the remaining win one round of
    // holding it earns. A 1-point tile on a 100-point map is worth almost
    // nothing (Interference, Interception: the human's exceptions to "hold
    // scoring tiles at all cost"); a 6-point tile on a 15-point map is worth
    // a lot. tile_hold and tile_reach stay in absolute points so older
    // weights keep playing exactly as before.
    "tile_pace",  // pace of live scoring tiles our live ships stand on
    "reach_pace", // pace weighted by 1/(1 + nearest ship distance)
    // Added 2026-11-24: `exposed` counts every reachable no-shot ship the
    // same, so a heavily armored ship standing in reach looked as bad as an
    // unprotected one. This weights each such ship by the share of its HP
    // the enemies that reach it would take after its damage reduction
    // (armor/shields), capped at 1. Lets the search learn to put protected
    // ships forward; checks whether armor's negative fitted value was the
    // players or the rules.
    "exposed_dmg", // exposed ships, each weighted by min(1, reduced incoming damage / HP) (negated)
    // Added 2026-11-24: roles (human: "a slow heavy ship with high damage
    // reduction is great for sitting on home objectives"; "a fast ship ...
    // pips a scoring tile on the enemy side"). Search only sees part of a
    // round, so plans that pay off over a game need terms of their own. Each
    // side's anchor and raider are chosen by `role_ships` from fixed ship
    // stats; tiles are home / center / enemy by column (`zone_of`).
    "anchor_hold",   // our anchor stands on a live home tile
    "anchor_reach",  // 1 - anchor's distance to the nearest live home tile / 26 (the board's max)
    "raider_hold",   // our raider stands on a live enemy-side tile
    "raider_reach",  // 1 - raider's distance to the nearest live enemy-side tile / 26
    // (Linear, not 1/(1 + d): enemy-side tiles sit ~12 columns away, where
    // 1/(1 + d) barely changes per step and a styled raider never set out.)
    "home_pressure", // enemy ships that can reach one of our live home tiles next round (negated)
    // Added 2026-11-25: purposes (`purpose.rs`; human: "each ship needs to
    // be placed with a purpose in mind": stay on home objectives, push and
    // hold the center, rush poorly defended enemy scoring tiles, support one
    // of those with firepower or healing). Purposes come from fixed ship
    // stats via `purpose::assign`, the same function deployment uses.
    // Reach terms are linear (1 - distance / 26), averaged over the ships.
    "home_hold",     // live home tiles held by our Home ships
    "home_reach",    // Home ships' mean reach to the nearest live home tile
    "center_hold",   // live center tiles held by our Center ships
    "center_reach",  // Center ships' mean reach to the nearest live center tile
    "rush_hold",     // our Rush ship stands on a live enemy-side tile
    "rush_reach",    // Rush ship's reach to the nearest poorly defended live enemy-side tile
    "support_cover", // Support ships' mean cover of their partner (1 within gun range; within 1 for repair specials)
];

/// Features Poor tactics can see: material and score only.
pub const POOR_MASK: [bool; N_FEATURES] = [
    true, true, true, true, true, false, false, false, false, false, false, false, false, false,
    false, false, false, false, false, false, false, false, false, false, false, false, false,
    false, false, false, false, false, false, false,
];

/// Untrained starting point (signs from the rules; magnitudes are guesses
/// that training replaces).
pub const SEED_WEIGHTS: [f32; N_FEATURES] = [
    1.0, 0.5, -0.2, 0.5, 1.0, 2.0, 1.0, 0.5, 0.5, 0.3, 0.2, 0.1, 0.1, -0.2, 0.2, 0.1, 0.5, 0.3,
    0.2, 1.0, 0.5, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1,
];

/// A scoring tile's zone for one side, by column (every map deploys the
/// creator on the left and the joiner on the right; checked by
/// `--example zone_orientation`): the side's own share of the board's width
/// below 0.4 is home, above 0.6 enemy, otherwise center.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Zone {
    Home,
    Center,
    Enemy,
}

pub fn zone_of(col: i16, is_creator: bool) -> Zone {
    let f = col as f32 / (vt_core::grid::GRID_WIDTH - 1) as f32;
    let own = if is_creator { f } else { 1.0 - f };
    if own < 0.4 {
        Zone::Home
    } else if own > 0.6 {
        Zone::Enemy
    } else {
        Zone::Center
    }
}

/// A side's (anchor, raider) among its operational ships, from fixed stats
/// so the choice is stable through a game:
/// - anchor (only if the side has a live home tile): the most durable ship,
///   max HP / (1 - damage reduction), slower first, then lower id;
/// - raider (only if there's a live enemy-side tile): the fastest other
///   ship, more gun damage first, then shorter range, then lower id.
/// Experiment switch (env ANCHOR_SLOWEST): rank anchors by slowness first.
static ANCHOR_SLOWEST: std::sync::OnceLock<bool> = std::sync::OnceLock::new();

pub fn role_ships(g: &GameState, is_creator: bool) -> (Option<u64>, Option<u64>) {
    let live = || g.map.scoring.iter().filter(|t| t.points != 0);
    let has_home = live().any(|t| zone_of(t.col, is_creator) == Zone::Home);
    let has_enemy = live().any(|t| zone_of(t.col, is_creator) == Zone::Enemy);
    let ships = || {
        g.board
            .iter()
            .filter(move |(_, b)| on_board(b) && b.hull_points > 0 && b.is_creator == is_creator)
    };
    let anchor = if has_home {
        ships()
            .max_by_key(|(&id, b)| {
                let dur = b.max_hull_points as u32 * 100 / (100 - b.damage_reduction.min(99) as u32);
                if *ANCHOR_SLOWEST.get_or_init(|| std::env::var("ANCHOR_SLOWEST").is_ok()) {
                    // Experiment: the slowest ship, most durable among those.
                    (u32::from(u8::MAX - b.movement), dur, std::cmp::Reverse(id))
                } else {
                    (dur, u32::from(u8::MAX - b.movement), std::cmp::Reverse(id))
                }
            })
            .map(|(&id, _)| id)
    } else {
        None
    };
    let raider = if has_enemy {
        ships()
            .filter(|(&id, _)| Some(id) != anchor)
            .max_by_key(|(&id, b)| {
                (b.movement, b.gun_damage, std::cmp::Reverse(b.range), std::cmp::Reverse(id))
            })
            .map(|(&id, _)| id)
    } else {
        None
    };
    (anchor, raider)
}

/// Opponent styles for training (2026-11-24): the incumbent's weights with
/// one role pushed hard, so candidates meet players who raid or anchor and
/// defending home or contesting a raid can pay. Self-play alone settles on
/// everyone rushing the center, where neither ever matters.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Style {
    Raider,
    Anchor,
    // Purpose styles (2026-11-25): push one purpose's hold and reach.
    Home,
    Center,
    Rush,
    Support,
}

/// The board's largest Manhattan distance (role reach features).
const MAX_DIST: f32 = ((vt_core::grid::GRID_WIDTH - 1) + (vt_core::grid::GRID_HEIGHT - 1)) as f32;

/// How hard a style pushes its role, as a share of the weights' norm.
pub static STYLE_STRENGTH: std::sync::RwLock<f64> = std::sync::RwLock::new(1.0);

pub fn styled_weights(w: &[f64], style: Style) -> Vec<f64> {
    let norm = w.iter().map(|x| x * x).sum::<f64>().sqrt().max(1e-9);
    let idx = |n: &str| FEATURE_NAMES.iter().position(|f| *f == n).unwrap();
    let (hold, reach) = match style {
        Style::Raider => (idx("raider_hold"), idx("raider_reach")),
        Style::Anchor => (idx("anchor_hold"), idx("anchor_reach")),
        Style::Home => (idx("home_hold"), idx("home_reach")),
        Style::Center => (idx("center_hold"), idx("center_reach")),
        Style::Rush => (idx("rush_hold"), idx("rush_reach")),
        Style::Support => (idx("support_cover"), idx("support_cover")),
    };
    let mut out = w.to_vec();
    let k = *STYLE_STRENGTH.read().unwrap();
    out[hold] += k * norm;
    out[reach] += k * norm;
    out
}

/// Which ships can repair, from the rules: (variant, special slot) pairs
/// whose special is a Repair resolver, and variants whose faction ability
/// is Repair (any special). Set once when the config loads.
static REPAIR_KINDS: std::sync::OnceLock<(Vec<(u16, u8)>, Vec<u16>)> = std::sync::OnceLock::new();

pub fn set_repair_kinds(rules: &crate::rules::LocalRules, max_slot: &std::collections::HashMap<u16, u8>) {
    use vt_core::effects::Resolver;
    use vt_core::engine::Rules;
    use vt_core::types::Special;
    let mut specials = Vec::new();
    let mut factions = Vec::new();
    for (&v, &m) in max_slot {
        for slot in 1..=m {
            let sp = match slot {
                1 => Special::Slot1,
                2 => Special::Slot2,
                3 => Special::Slot3,
                _ => continue,
            };
            if matches!(rules.special_resolver(v, sp), Some(Resolver::Repair { .. })) {
                specials.push((v, slot));
            }
        }
        if matches!(rules.faction_resolver(v), Some(Resolver::Repair { .. })) {
            factions.push(v);
        }
    }
    specials.sort_unstable();
    factions.sort_unstable();
    let _ = REPAIR_KINDS.set((specials, factions));
}

fn can_repair(b: &ShipBoard) -> bool {
    can_repair_kind(b.variant, b.special as u8)
}

/// Whether a ship's special (not its faction ability) is a repair.
pub fn can_repair_special(variant: u16, special: u8) -> bool {
    REPAIR_KINDS.get().is_some_and(|(sp, _)| sp.contains(&(variant, special)))
}

/// Whether a ship of `variant` with special `special` can repair.
pub fn can_repair_kind(variant: u16, special: u8) -> bool {
    REPAIR_KINDS
        .get()
        .is_some_and(|(sp, fa)| fa.contains(&variant) || sp.contains(&(variant, special)))
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Eval {
    pub features: Vec<String>,
    pub weights: Vec<f32>,
    /// Logistic scale: P(win) = sigmoid(value_scale * evaluate).
    pub value_scale: f32,
    /// How the weights were produced (free-form, for the record).
    #[serde(default)]
    pub provenance: serde_json::Value,
    /// The player's ship-loss preferences (not trained, not saved): losing
    /// a ship doesn't lose the game, but destruction is permanent, and how
    /// much that matters depends on the player. None = cares only about
    /// winning. See `LossPrefs` and `utility`.
    #[serde(skip)]
    pub loss: Option<std::sync::Arc<LossPrefs>>,
}

/// How much a player minds losing ships, in win-probability units: an own
/// ship weighted 0.3 means losing it for good is as bad as 30% of a win.
/// Asymmetric on purpose: an enemy ship destroyed is worth only what it
/// actually pays (`bounty`), since the AI loses nothing and a PvP kill
/// pays a token reward.
#[derive(Clone, Debug, Default)]
pub struct LossPrefs {
    /// Weight for own ships not in `own`.
    pub own_default: f32,
    /// Per-ship weights (aversion scaled by the ship's cost).
    pub own: std::collections::HashMap<u64, f32>,
    /// Weight for enemy ships not in `bounty` (variant 1).
    pub bounty_default: f32,
    /// Weight for variant-2 enemy ships not in `bounty`: a roguelike run
    /// meets a different AI fleet at every node, so its bounty is set by
    /// variant (variant-2 AI kills pay DEC) rather than per ship id.
    pub bounty_variant2: f32,
    pub bounty: std::collections::HashMap<u64, f32>,
    /// Chance that an operational ship the enemy can disable next round is
    /// then lost for good (see `KILLABLE_RISK`).
    pub killable_risk: f32,
}

/// Default chance that an operational ship the enemy can disable next round
/// is then lost for good (it can still retreat once disabled, but shots on a
/// disabled ship advance its reactor timer). Makes retreats happen before
/// the damage rather than after.
pub const KILLABLE_RISK: f32 = 0.0;

impl LossPrefs {
    pub fn uniform(own: f32) -> LossPrefs {
        LossPrefs {
            own_default: own,
            killable_risk: KILLABLE_RISK,
            ..Default::default()
        }
    }
    fn own_w(&self, id: u64) -> f32 {
        *self.own.get(&id).unwrap_or(&self.own_default)
    }
    fn bounty_w(&self, id: u64, variant: u16) -> f32 {
        match self.bounty.get(&id) {
            Some(&w) => w,
            None if variant == 2 => self.bounty_variant2,
            None => self.bounty_default,
        }
    }
}

impl Default for Eval {
    fn default() -> Self {
        Eval {
            features: FEATURE_NAMES.iter().map(|s| s.to_string()).collect(),
            weights: SEED_WEIGHTS.to_vec(),
            value_scale: 1.0,
            provenance: serde_json::json!("seed weights (untrained)"),
            loss: None,
        }
    }
}

impl Eval {
    pub fn load(path: &Path) -> std::io::Result<Eval> {
        let e: Eval = serde_json::from_str(&std::fs::read_to_string(path)?)?;
        assert_eq!(
            e.features,
            FEATURE_NAMES,
            "{}: feature list differs from this build; retrain",
            path.display()
        );
        Ok(e)
    }

    /// Loads weights saved under an older feature list, matching weights by
    /// feature name; features the file lacks get weight 0, so the result
    /// plays exactly as the saved weights did. For warm starts and
    /// before/after comparisons when features are added.
    pub fn load_mapped(path: &Path) -> std::io::Result<Eval> {
        let mut e: Eval = serde_json::from_str(&std::fs::read_to_string(path)?)?;
        let old: std::collections::HashMap<String, f32> =
            e.features.iter().cloned().zip(e.weights.iter().copied()).collect();
        e.features = FEATURE_NAMES.iter().map(|s| s.to_string()).collect();
        e.weights = FEATURE_NAMES.iter().map(|n| *old.get(*n).unwrap_or(&0.0)).collect();
        Ok(e)
    }

    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        if let Some(d) = path.parent() {
            std::fs::create_dir_all(d)?;
        }
        std::fs::write(path, serde_json::to_string_pretty(self)? + "\n")
    }

    /// The same weights with masked-out features zeroed.
    pub fn masked(&self, mask: &[bool; N_FEATURES]) -> Eval {
        let mut e = self.clone();
        for (w, &m) in e.weights.iter_mut().zip(mask) {
            if !m {
                *w = 0.0;
            }
        }
        e
    }

    /// Evaluation of `g` for `side` (terminal positions: ±1e4 or 0).
    /// Trained features only: antisymmetric between the sides.
    pub fn evaluate(&self, g: &GameState, side: Side) -> f32 {
        if g.ended {
            return terminal(g, side) * 1e4;
        }
        let f = features(g, side);
        f.iter().zip(&self.weights).map(|(a, b)| a * b).sum::<f32>()
    }

    /// Estimated probability that `side` wins.
    pub fn value(&self, g: &GameState, side: Side) -> f32 {
        if g.ended {
            return (terminal(g, side) + 1.0) / 2.0;
        }
        sigmoid(self.value_scale * self.evaluate(g, side))
    }

    /// What `side`'s player wants: win probability plus their ship-loss
    /// preference, at full weight in finished games too (a win that costs
    /// three ships can be worse than a draw where everyone retreats).
    /// Equal to `value` without preferences.
    pub fn utility(&self, g: &GameState, side: Side) -> f32 {
        match &self.loss {
            None => self.value(g, side),
            Some(p) => self.value(g, side) + loss_util(g, side, p),
        }
    }
}

/// `side`'s ship-loss utility: minus own weights times the risk each ship
/// is lost, plus bounties times the same risk for enemy ships. Risk is 1 for
/// a destroyed ship; (1 + timer) / 3 for a disabled ship still on the board
/// (retreating removes it); KILLABLE_RISK for an operational ship the enemy
/// can disable next round. Fled ships are kept; disabled ships at the end of
/// a game survive.
pub fn loss_util(g: &GameState, side: Side, p: &LossPrefs) -> f32 {
    let killable = if g.ended || p.killable_risk == 0.0 {
        Vec::new()
    } else {
        killable_ids(g)
    };
    let mut t = 0.0;
    for (&id, b) in g.board.iter().filter(|(_, b)| b.placed) {
        let risk = if b.status == vt_core::engine::STATUS_DESTROYED {
            1.0
        } else if b.status != STATUS_ALIVE || g.ended {
            0.0
        } else if b.hull_points == 0 {
            (1.0 + b.reactor_critical_timer as f32) / 3.0
        } else if killable.contains(&id) {
            p.killable_risk
        } else {
            0.0
        };
        if risk == 0.0 {
            continue;
        }
        let ours = b.is_creator == (side == Side::Creator);
        t += if ours {
            -p.own_w(id) * risk
        } else {
            p.bounty_w(id, b.variant) * risk
        };
    }
    t
}

/// Operational ships (either side) the enemy could disable next round:
/// everything that reaches them (move + range) together covers their HP.
/// The same rule as the `killable` feature.
pub fn killable_ids(g: &GameState) -> Vec<u64> {
    let ships: Vec<(u64, &ShipBoard)> = g
        .board
        .iter()
        .filter(|(_, b)| on_board(b) && b.hull_points > 0)
        .map(|(&id, b)| (id, b))
        .collect();
    let mut out = Vec::new();
    for (id, t) in &ships {
        let mut incoming = 0u16;
        for (_, e) in &ships {
            if e.is_creator == t.is_creator {
                continue;
            }
            let reach = e.movement as u16 + e.range as u16;
            if manhattan((e.row, e.col), (t.row, t.col)) as u16 <= reach {
                incoming += effective(e.gun_damage, t.damage_reduction);
            }
        }
        if incoming >= t.hull_points as u16 {
            out.push(*id);
        }
    }
    out
}

pub fn sigmoid(x: f32) -> f32 {
    1.0 / (1.0 + (-x).exp())
}

/// +1 win, -1 loss, 0 draw (for an ended game).
pub fn terminal(g: &GameState, side: Side) -> f32 {
    match g.winner {
        Some(w) if w == side => 1.0,
        Some(_) => -1.0,
        None => 0.0,
    }
}

fn on_board(b: &ShipBoard) -> bool {
    b.placed && b.status == STATUS_ALIVE
}

fn effective(gun: u8, dr: u8) -> u16 {
    let g = gun as u16;
    g - (g * dr as u16) / 100
}

/// Per-side raw quantities; features are `us - them` of these.
#[derive(Default, Clone, Copy)]
struct SideStats {
    hp: f32,
    live: f32,
    disabled: f32,
    firepower: f32,
    tile_hold: f32,
    tile_reach: f32,
    threat_on: f32,
    killable: f32,
    shots: f32,
    unmoved: f32,
    reactor: f32,
    exposed: f32,
    exposed_dmg: f32,
    guns_on: f32,
    held_hp: f32,
    repair_live: f32,
    repair_exposed: f32,
    tile_pace: f32,
    reach_pace: f32,
    anchor_hold: f32,
    anchor_reach: f32,
    raider_hold: f32,
    raider_reach: f32,
    home_pressure: f32,
    home_hold: f32,
    home_reach: f32,
    center_hold: f32,
    center_reach: f32,
    rush_hold: f32,
    rush_reach: f32,
    support_cover: f32,
}

pub fn features(g: &GameState, side: Side) -> [f32; N_FEATURES] {
    // [0] = creator, [1] = joiner.
    // Hot path (called for every candidate move in search): borrow, don't
    // clone. Iteration and arithmetic order are unchanged, so results are
    // bit-identical to the cloning version.
    let ships: Vec<(u64, &ShipBoard)> = g
        .board
        .iter()
        .filter(|(_, b)| on_board(b))
        .map(|(&id, b)| (id, b))
        .collect();
    let mut st = [SideStats::default(); 2];
    let si = |b: &ShipBoard| if b.is_creator { 0 } else { 1 };
    for (id, b) in &ships {
        let s = &mut st[si(b)];
        if b.hull_points > 0 {
            s.hp += b.hull_points as f32 / 100.0;
            s.live += 1.0;
            s.firepower += b.gun_damage as f32 / 100.0;
            // GameState::has_moved, without its clone of the record.
            let _ = id;
            if b.moved_in_round != g.current_round {
                s.unmoved += 1.0;
            }
        } else {
            s.disabled += 1.0;
            s.reactor += b.reactor_critical_timer as f32;
        }
    }
    // Threat: each operational enemy hits its best reachable target once
    // (move + range); a ship is killable if everything that reaches it
    // together covers its HP.
    let mut incoming_buf = [0u16; 128];
    let mut incoming_vec;
    let incoming: &mut [u16] = if ships.len() <= incoming_buf.len() {
        &mut incoming_buf[..ships.len()]
    } else {
        incoming_vec = vec![0u16; ships.len()];
        &mut incoming_vec[..]
    };
    let mut reached = vec![false; ships.len()];
    for (_, e) in ships.iter().filter(|(_, b)| b.hull_points > 0) {
        let reach = e.movement as u16 + e.range as u16;
        let mut best = 0u16;
        for (j, (_, t)) in ships.iter().enumerate() {
            if t.is_creator == e.is_creator
                || manhattan((e.row, e.col), (t.row, t.col)) as u16 > reach
            {
                continue;
            }
            if t.hull_points == 0 {
                continue;
            }
            let d = effective(e.gun_damage, t.damage_reduction);
            incoming[j] += d;
            reached[j] = true;
            st[si(t)].guns_on += 1.0;
            best = best.max(d.min(t.hull_points as u16));
        }
        st[1 - si(e)].threat_on += best as f32 / 100.0;
    }
    for (j, (_, t)) in ships.iter().enumerate() {
        if t.hull_points > 0 && incoming[j] >= t.hull_points as u16 {
            st[si(t)].killable += 1.0;
        }
    }
    // Shots available from current cells (the engine's range and LOS rules).
    for (i, (_, s)) in ships.iter().enumerate() {
        if s.hull_points == 0 {
            continue;
        }
        let mut mine = 0.0;
        let enemy_live = g.live[1 - si(s)];
        for (_, t) in ships.iter() {
            if t.is_creator == s.is_creator || t.hull_points == 0 {
                continue;
            }
            let d = manhattan((s.row, s.col), (t.row, t.col));
            if d > s.range {
                continue;
            }
            let clear = d <= 1
                || g.map
                    .has_los_avoiding(
                        s.row,
                        s.col,
                        t.row,
                        t.col,
                        enemy_live & !Bitmap::cell(t.row, t.col),
                    )
                    .unwrap_or(false);
            if clear {
                st[si(s)].shots += 1.0;
                mine += 1.0;
            }
        }
        if reached[i] && mine == 0.0 {
            st[si(s)].exposed += 1.0;
            st[si(s)].exposed_dmg += (incoming[i] as f32 / s.hull_points as f32).min(1.0);
        }
        if can_repair(s) {
            st[si(s)].repair_live += 1.0;
            if reached[i] {
                st[si(s)].repair_exposed += 1.0;
            }
        }
    }
    // Scoring tiles.
    // GameMap::scoring_positions (live tiles, list order), without the copy.
    let scores = [g.creator_score, g.joiner_score];
    for tile in g.map.scoring.iter().filter(|e| e.points != 0) {
        let pts = tile.points as f32 / 10.0;
        for k in 0..2 {
            let pace = if g.max_score == 0 {
                0.0
            } else {
                let need = g.max_score.saturating_sub(scores[k]).max(1) as f32;
                (tile.points as f32 / need).min(1.0)
            };
            if g.live[k].has_cell(tile.row, tile.col) {
                st[k].tile_hold += pts;
                st[k].tile_pace += pace;
                if let Some((_, b)) = ships
                    .iter()
                    .find(|(_, b)| b.hull_points > 0 && si(b) == k && b.row == tile.row && b.col == tile.col)
                {
                    st[k].held_hp += b.hull_points as f32 / 100.0 * pace;
                }
            }
            let nearest = ships
                .iter()
                .filter(|(_, b)| b.hull_points > 0 && si(b) == k)
                .map(|(_, b)| manhattan((b.row, b.col), (tile.row, tile.col)))
                .min();
            if let Some(d) = nearest {
                st[k].tile_reach += pts / (1.0 + d as f32);
                st[k].reach_pace += pace / (1.0 + d as f32);
            }
        }
    }
    // Roles (see `role_ships`).
    let live_tiles: Vec<(i16, i16)> = g
        .map
        .scoring
        .iter()
        .filter(|t| t.points != 0)
        .map(|t| (t.row, t.col))
        .collect();
    for k in 0..2 {
        let creator = k == 0;
        let in_zone = |z: Zone| live_tiles.iter().filter(move |t| zone_of(t.1, creator) == z);
        let (anchor, raider) = role_ships(g, creator);
        let role = |id: Option<u64>, z: Zone| -> (f32, f32) {
            let Some(b) = id.and_then(|id| g.board.get(&id)) else {
                return (0.0, 0.0);
            };
            let d = in_zone(z).map(|t| manhattan((b.row, b.col), *t)).min();
            match d {
                Some(0) => (1.0, 1.0),
                Some(d) => (0.0, 1.0 - d as f32 / MAX_DIST),
                None => (0.0, 0.0),
            }
        };
        let (ah, ar) = role(anchor, Zone::Home);
        let (rh, rr) = role(raider, Zone::Enemy);
        st[k].anchor_hold = ah;
        st[k].anchor_reach = ar;
        st[k].raider_hold = rh;
        st[k].raider_reach = rr;
        st[k].home_pressure = ships
            .iter()
            .filter(|(_, e)| e.hull_points > 0 && e.is_creator != creator)
            .filter(|(_, e)| {
                let reach = e.movement as u16 + e.range as u16;
                in_zone(Zone::Home).any(|t| manhattan((e.row, e.col), *t) as u16 <= reach)
            })
            .count() as f32;
        purpose_stats(g, creator, &live_tiles, &mut st[k]);
    }
    let (u, t) = if side == Side::Creator {
        (0, 1)
    } else {
        (1, 0)
    };
    let (su, ss) = if side == Side::Creator {
        (g.creator_score, g.joiner_score)
    } else {
        (g.joiner_score, g.creator_score)
    };
    let race = |s: u64| {
        if g.max_score > 0 {
            (s.min(g.max_score) as f32 / g.max_score as f32).powi(2)
        } else {
            0.0
        }
    };
    let to_move = if g.current_turn == side { 1.0 } else { -1.0 };
    let (a, b) = (st[u], st[t]);
    [
        a.hp - b.hp,
        a.live - b.live,
        a.disabled - b.disabled,
        a.firepower - b.firepower,
        (su as f32 - ss as f32) / 10.0,
        race(su) - race(ss),
        a.tile_hold - b.tile_hold,
        a.tile_reach - b.tile_reach,
        b.threat_on - a.threat_on,
        b.killable - a.killable,
        a.shots - b.shots,
        a.unmoved - b.unmoved,
        to_move,
        a.reactor - b.reactor,
        b.exposed - a.exposed,
        b.guns_on - a.guns_on,
        a.held_hp - b.held_hp,
        a.repair_live - b.repair_live,
        b.repair_exposed - a.repair_exposed,
        a.tile_pace - b.tile_pace,
        a.reach_pace - b.reach_pace,
        b.exposed_dmg - a.exposed_dmg,
        a.anchor_hold - b.anchor_hold,
        a.anchor_reach - b.anchor_reach,
        a.raider_hold - b.raider_hold,
        a.raider_reach - b.raider_reach,
        b.home_pressure - a.home_pressure,
        a.home_hold - b.home_hold,
        a.home_reach - b.home_reach,
        a.center_hold - b.center_hold,
        a.center_reach - b.center_reach,
        a.rush_hold - b.rush_hold,
        a.rush_reach - b.rush_reach,
        a.support_cover - b.support_cover,
    ]
}

/// The purpose features for one side (see `purpose.rs`).
fn purpose_stats(g: &GameState, creator: bool, live_tiles: &[(i16, i16)], s: &mut SideStats) {
    use crate::purpose::{assign_in_game, Purpose};
    let asg = assign_in_game(g, creator);
    let op = |id: u64| g.board.get(&id).filter(|b| on_board(b) && b.hull_points > 0);
    let tiles = |z: Zone| -> Vec<(i16, i16)> {
        live_tiles.iter().copied().filter(|t| zone_of(t.1, creator) == z).collect()
    };
    let reach = |b: &ShipBoard, ts: &[(i16, i16)]| {
        ts.iter()
            .map(|t| manhattan((b.row, b.col), *t))
            .min()
            .map(|d| 1.0 - d as f32 / MAX_DIST)
    };
    // (hold count, mean reach) for one purpose and zone.
    let zone_terms = |p: Purpose, ts: &[(i16, i16)]| -> (f32, f32) {
        let ships: Vec<&ShipBoard> = asg
            .iter()
            .filter(|a| a.purpose == p)
            .filter_map(|a| op(a.id))
            .collect();
        if ships.is_empty() || ts.is_empty() {
            return (0.0, 0.0);
        }
        let hold = ts
            .iter()
            .filter(|t| ships.iter().any(|b| (b.row, b.col) == **t))
            .count() as f32;
        let r = ships.iter().filter_map(|b| reach(b, ts)).sum::<f32>() / ships.len() as f32;
        (hold, r)
    };
    (s.home_hold, s.home_reach) = zone_terms(Purpose::Home, &tiles(Zone::Home));
    (s.center_hold, s.center_reach) = zone_terms(Purpose::Center, &tiles(Zone::Center));
    // Rush: only poorly defended tiles count, i.e. where the enemies that
    // can reach the tile next round can't together disable the rusher.
    let enemy = tiles(Zone::Enemy);
    if let Some(r) = asg.iter().find(|a| a.purpose == Purpose::Rush).and_then(|a| op(a.id)) {
        if enemy.contains(&(r.row, r.col)) {
            s.rush_hold = 1.0;
        }
        let open: Vec<(i16, i16)> = enemy
            .iter()
            .copied()
            .filter(|t| {
                let dmg: u16 = g
                    .board
                    .values()
                    .filter(|e| on_board(e) && e.hull_points > 0 && e.is_creator != creator)
                    .filter(|e| {
                        manhattan((e.row, e.col), *t) as u16 <= e.movement as u16 + e.range as u16
                    })
                    .map(|e| effective(e.gun_damage, r.damage_reduction))
                    .sum();
                dmg < r.hull_points as u16
            })
            .collect();
        s.rush_reach = reach(r, &open).unwrap_or(0.0);
    }
    // Support: cover of the partner.
    let mut n = 0.0;
    let mut cover = 0.0;
    for a in asg.iter().filter(|a| a.purpose == Purpose::Support) {
        let (Some(b), Some(p)) = (op(a.id), a.partner.and_then(op)) else {
            continue;
        };
        let r = if can_repair_special(b.variant, b.special as u8) { 1 } else { b.range.max(1) } as i32;
        let d = manhattan((b.row, b.col), (p.row, p.col)) as i32;
        n += 1.0;
        cover += if d <= r {
            1.0
        } else {
            (1.0 - (d - r) as f32 / MAX_DIST).max(0.0)
        };
    }
    if n > 0.0 {
        s.support_cover = cover / n;
    }
}

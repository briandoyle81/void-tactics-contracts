//! The economy and progression simulation: a population of players, each a
//! spend profile (FTP / Casual / Whale: money and play time) and a skill
//! level (Poor / Average / Excellent, applied to both composition and
//! tactics), living through simulated days on the contract's rules.
//!
//! Each day, per player:
//! 1. economy actions: the free claim (every 28 days, `free_claim_base` +
//!    storefront tier ships), DEC turn-ins, the spend budget (packs, and UTC
//!    for DroneYard modifications), modifications, recycling;
//! 2. PvE sessions (parallel across players): roguelike runs from mission 1,
//!    the player choosing each branch; a run uses one game slot per fight.
//!    (Single campaign games are still modelled but off in profiles.json:
//!    the single-player campaign is a stub, 2026-11-20);
//! 3. PvP rounds: Elo matchmaking within cost brackets, against a meta built
//!    from fleets players actually fielded recently.
//!
//! Contract rules modelled: destroyed ships are gone for good (PvE and PvP);
//! variant-2 AI kills pay 1 DEC; PvP kills of non-free ships pay 0.025 UTC
//! and a rank kill; free ships can't be recycled; the medal (winning a run
//! at either Hive ending, `medal_nodes`) unlocks variant 2 for claims and
//! purchases; paid packs preset the
//! first tier+1 ships' ranks; roguelike repairs cost UTC (an unaffordable
//! repair is skipped); once-per-player ship grants.
//!
//! Every player's randomness is seeded from (seed, player, day), players act
//! in parallel only where they don't interact, and results are applied in a
//! fixed order, so a run is reproducible.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::Path;

use rand::{Rng, SeedableRng};
use rand_chacha::ChaCha8Rng;
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use vt_core::attributes::{count_modifications, kills_for_rank, modification_cost};
use vt_core::engine::{Side, STATUS_DESTROYED};
use vt_core::types::Ship;

use crate::arena::mix;
use crate::composition::compose::{make as make_composer, ComposeCtx, Composer, Foe, SearchParams};
use crate::composition::modify::choose_build;
use crate::composition::planner::LevelPlanner;
use crate::composition::value::ShipValueModel;
use crate::content::Content;
use crate::eval::{Eval, LossPrefs};
use crate::fleet;
use crate::log::{MatchLog, RunLog};
use crate::rules::Config;
use crate::runner::{
    play_match, pve_dec_reward, run_roguelike, AiSide, BasicPlanner, Controller, Limits,
    RunPlanner, SideSetup,
};
use crate::tactics::{Level, Tactician, TacticsConfig};

// ================================================================ profiles

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Mix {
    pub campaign: f64,
    pub roguelike: f64,
    pub pvp: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SpendProfile {
    pub usd_per_month: f64,
    pub sessions_per_week: f64,
    pub games_per_session: u32,
    pub mix: Mix,
    /// Pack tier bought (0..=4), or none.
    pub pack_tier: Option<usize>,
    /// Share of spend converted to UTC for DroneYard modifications.
    pub modify_share: f64,
    /// How much this kind of player minds losing an average ship for good,
    /// in win-probability units (see `eval::LossPrefs`), before scarcity:
    /// ships are scarce for a free player and cheap for a whale.
    #[serde(default = "default_loss_aversion")]
    pub loss_aversion: f64,
}

fn default_loss_aversion() -> f64 {
    0.05
}

/// A hangar with fewer playable ships than this many full rosters makes its
/// owner proportionally more careful (see `World::loss_prefs`).
const SCARCITY_ROSTERS: f64 = 2.0;
/// Ships in a typical fleet (for scarcity).
const TYPICAL_ROSTER: f64 = 8.0;
/// Most that scarcity multiplies aversion by.
const MAX_SCARCITY: f64 = 3.0;
/// Extra loss weight per rank above 1: players protect veterans ("ships
/// over 1 star should be preserved at a higher rate"; human benchmark notes,
/// 2026-11-18). Rank is earned, not bought, so cost alone misses it.
pub const VETERAN_WEIGHT_PER_RANK: f64 = 0.5;

/// How much losing `s` matters relative to an average ship of the fleet:
/// its cost over the fleet's mean cost, times the veteran bonus.
pub fn ship_loss_weight(cfg: &Config, s: &Ship, mean_cost: f64) -> f64 {
    let rel = if mean_cost > 0.0 {
        s.ship_data.cost as f64 / mean_cost
    } else {
        1.0
    };
    rel * (1.0 + VETERAN_WEIGHT_PER_RANK * (cfg.rank(s) as f64 - 1.0))
}

/// What one DEC (a variant-2 AI kill) or one UTC is worth to a player, in
/// win-probability units: bounties for destroying enemy ships.
const DEC_UTILITY: f64 = 0.01;
const UTC_UTILITY: f64 = 0.2;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct EconomyRules {
    pub pack_ships: Vec<u32>,
    pub pack_usd: Vec<f64>,
    pub free_claim_base: u32,
    pub claim_cooldown_days: u32,
    /// Free top-up floor (FreeShipClaim.topUpFreeShips / NEAR
    /// top_up_free_ships, 2026-11-19): a player with fewer live ships tops
    /// back up to this many free ships, any time. 0 = no top-ups (the rules
    /// before 2026-11-19).
    #[serde(default)]
    pub free_topup_floor: u32,
    pub recycle_reward_utc: f64,
    pub pvp_kill_reward_utc: f64,
    pub repair_utc_per_hp: f64,
    pub modification_base_utc: f64,
    /// Winning a run that ends at one of these nodes earns the medal
    /// (2026-11-20: either Hive ending. On Base Sepolia the medal is still
    /// tied to the stub campaign's last node.)
    pub medal_nodes: Vec<String>,
    pub variant2_requires_medal: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PvpRules {
    pub brackets: Vec<u64>,
    pub max_score: u64,
    pub elo_k: f64,
    pub elo_start: f64,
    pub matchmaking_noise: f64,
    pub meta_window: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Profiles {
    pub spend: BTreeMap<String, SpendProfile>,
    pub economy: EconomyRules,
    pub pvp: PvpRules,
}

impl Profiles {
    pub fn load(path: &Path) -> std::io::Result<Profiles> {
        Ok(serde_json::from_str(&std::fs::read_to_string(path)?)?)
    }
}

// ================================================================== player

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct PlayerStats {
    pub campaign_played: u32,
    pub campaign_won: u32,
    pub runs: u32,
    pub run_combats_won: u32,
    pub runs_won: u32,
    pub pvp_played: u32,
    pub pvp_won: u32,
    pub pvp_drawn: u32,
    pub pvp_unmatched: u32,
    pub ships_lost: u32,
    pub ships_bought: u32,
    pub ships_claimed: u32,
    /// Free ships from top-ups (see `EconomyRules::free_topup_floor`).
    #[serde(default)]
    pub ships_topped_up: u32,
    pub ships_granted: u32,
    /// Live ships recycled.
    pub ships_recycled: u32,
    /// Destroyed (paid) hulks recycled for half the reward.
    pub destroyed_recycled: u32,
    pub modifications: u32,
    pub dec_earned: u64,
    pub utc_earned: f64,
    pub utc_on_mods: f64,
    pub utc_on_repairs: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Player {
    pub index: usize,
    pub label: String,
    pub spend: String,
    pub level: Level,
    pub ships: Vec<Ship>,
    next_id: u64,
    pub dec: u64,
    pub utc: f64,
    pub usd_spent: f64,
    pack_budget: f64,
    pub storefront_tier: u8,
    pub medal_day: Option<u32>,
    pub completed: BTreeSet<String>,
    pub grants_claimed: BTreeSet<String>,
    pub elo: f64,
    /// Destroyed paid ships still owned (recyclable for half the reward).
    destroyed_paid: u32,
    claims: u32,
    pub stats: PlayerStats,
    /// Campaign attempts per node: (games, wins, own ships destroyed). What
    /// a player remembers when deciding whether a node is worth another try.
    #[serde(default)]
    pub node_record: BTreeMap<String, (u32, u32, u32)>,
    /// The strongest hangar the player had at the start of any day's play
    /// (after claims and purchases; fleet power at the 1000 cap, ships): the
    /// PvP matrix falls back to it when the final hangar can't field a fleet.
    #[serde(default)]
    pub peak_hangar: Option<(f64, Vec<Ship>)>,
    /// Roguelike game slots already spent by the last run: a run uses one
    /// slot per fight, so a 10-fight run takes the next 9 roguelike slots
    /// too (carried across days).
    #[serde(default)]
    pub run_slots_owed: u32,
}

impl Player {
    pub fn new(index: usize, spend: &str, level: Level, k: usize, elo: f64) -> Player {
        Player {
            index,
            label: format!("{spend}/{}#{k}", level.name()),
            spend: spend.into(),
            level,
            ships: Vec::new(),
            // Disjoint id ranges per player (below the AI id offset).
            next_id: index as u64 * 10_000_000 + 1,
            dec: 0,
            utc: 0.0,
            usd_spent: 0.0,
            pack_budget: 0.0,
            storefront_tier: 0,
            medal_day: None,
            completed: BTreeSet::new(),
            grants_claimed: BTreeSet::new(),
            elo,
            destroyed_paid: 0,
            claims: 0,
            stats: PlayerStats::default(),
            node_record: BTreeMap::new(),
            peak_hangar: None,
            run_slots_owed: 0,
        }
    }

    pub fn has_medal(&self) -> bool {
        self.medal_day.is_some()
    }

    fn new_ship(
        &mut self,
        cfg: &Config,
        variant: u16,
        kills: u32,
        is_free: bool,
        rng: &mut ChaCha8Rng,
    ) {
        let id = self.next_id;
        self.next_id += 1;
        let mut s = fleet::roll_ship(cfg, id, variant, rng.gen(), kills);
        s.ship_data.is_free_ship = is_free;
        self.ships.push(s);
    }

    fn lose(&mut self, ids: &BTreeSet<u64>) {
        for s in self.ships.iter().filter(|s| ids.contains(&s.id)) {
            self.stats.ships_lost += 1;
            if !s.ship_data.is_free_ship {
                self.destroyed_paid += 1;
            }
        }
        self.ships.retain(|s| !ids.contains(&s.id));
    }
}

/// Expected value per cost of a freshly rolled ship of each variant (for
/// Excellent purchase decisions).
fn variant_density(cfg: &Config, values: &ShipValueModel) -> HashMap<u16, f64> {
    let mut rng = ChaCha8Rng::seed_from_u64(99);
    [1u16, 2]
        .iter()
        .map(|&v| {
            let d: f64 = (0..400)
                .map(|i| fleet::roll_ship(cfg, i + 1, v, rng.gen(), 0))
                .map(|s| values.value(cfg, &s) / s.ship_data.cost.max(1) as f64)
                .sum::<f64>()
                / 400.0;
            (v, d)
        })
        .collect()
}

/// Value of the best fleet under `cap` (greedy by value per cost, one
/// variant, at most 12 ships): a fleet-strength measure for reports.
pub fn fleet_power(cfg: &Config, values: &ShipValueModel, ships: &[Ship], cap: u64) -> f64 {
    [1u16, 2]
        .iter()
        .map(|&v| {
            let mut c: Vec<(&Ship, f64)> = ships
                .iter()
                .filter(|s| s.traits.variant == v)
                .map(|s| (s, values.value(cfg, s)))
                .filter(|x| x.1 > 0.0)
                .collect();
            c.sort_by(|a, b| {
                (b.1 / b.0.ship_data.cost as f64)
                    .partial_cmp(&(a.1 / a.0.ship_data.cost as f64))
                    .unwrap()
            });
            let (mut cost, mut total, mut n) = (0u64, 0.0, 0);
            for (s, val) in c {
                if n < 12 && cost + s.ship_data.cost as u64 <= cap {
                    cost += s.ship_data.cost as u64;
                    total += val;
                    n += 1;
                }
            }
            total
        })
        .fold(0.0, f64::max)
}

// ==================================================================== sim

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SimOpts {
    pub days: u32,
    pub players_per_archetype: usize,
    pub seed: u64,
    /// Days between player snapshots (and on the last day).
    pub snapshot_every: u32,
}

impl Default for SimOpts {
    fn default() -> Self {
        SimOpts {
            days: 56,
            players_per_archetype: 2,
            seed: 1,
            snapshot_every: 7,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Activity {
    Campaign,
    Roguelike,
    Pvp,
}

/// Shared, read-only simulation context.
pub struct World<'a> {
    pub content: &'a Content,
    pub cfg: &'a Config,
    pub profiles: &'a Profiles,
    pub values: &'a ShipValueModel,
    pub composers: Vec<Box<dyn Composer>>,
    pub tacticians: Vec<Box<dyn Tactician>>,
    pub planners: Vec<Box<dyn RunPlanner>>,
    tc: TacticsConfig,
    eval: Eval,
    density: HashMap<u16, f64>,
    /// AI fleet value and variant-2 AI ship count per campaign node.
    node_ai: HashMap<String, (f64, usize)>,
}

impl<'a> World<'a> {
    pub fn new(
        content: &'a Content,
        cfg: &'a Config,
        profiles: &'a Profiles,
        values: &'a ShipValueModel,
        eval: &Eval,
        tc: &TacticsConfig,
        sp: &SearchParams,
    ) -> World<'a> {
        let composers: Vec<Box<dyn Composer>> = Level::ALL
            .iter()
            .map(|&l| make_composer(l, values, eval, sp))
            .collect();
        let tacticians: Vec<Box<dyn Tactician>> =
            Level::ALL.iter().map(|&l| tc.make(l, eval)).collect();
        let planners: Vec<Box<dyn RunPlanner>> = Level::ALL
            .iter()
            .map(|&l| -> Box<dyn RunPlanner> {
                if l == Level::Poor {
                    Box::new(BasicPlanner)
                } else {
                    Box::new(LevelPlanner {
                        level: l,
                        composer: make_composer(l, values, eval, sp),
                        values: values.clone(),
                        eval: eval.clone(),
                    })
                }
            })
            .collect();
        let node_ai = content
            .sp_nodes
            .iter()
            .map(|n| {
                let ai = AiSide::for_map(content, cfg, &n.map);
                let v: f64 = ai.ships.iter().map(|s| values.value(cfg, s)).sum();
                let v2 = ai.ships.iter().filter(|s| s.traits.variant == 2).count();
                (n.key.clone(), (v, v2))
            })
            .collect();
        World {
            content,
            cfg,
            profiles,
            values,
            composers,
            tacticians,
            planners,
            tc: tc.clone(),
            eval: eval.clone(),
            density: variant_density(cfg, values),
            node_ai,
        }
    }

    fn eligible_variants(&self, p: &Player) -> Vec<u16> {
        if p.has_medal() || !self.profiles.economy.variant2_requires_medal {
            vec![1, 2]
        } else {
            vec![1]
        }
    }

    /// Which variant to claim free ships in.
    fn claim_variant(&self, p: &Player) -> u16 {
        let el = self.eligible_variants(p);
        match p.level {
            Level::Poor => 1,
            // Alternate once both are open.
            Level::Average => el[p.claims as usize % el.len()],
            // Free claims stay variant 1: the roguelike needs it.
            Level::Excellent => 1,
        }
    }

    /// Which variant to buy packs in.
    fn buy_variant(&self, p: &Player, purchases: u32) -> u16 {
        let el = self.eligible_variants(p);
        match p.level {
            Level::Poor => 1,
            Level::Average => el[purchases as usize % el.len()],
            Level::Excellent => *el
                .iter()
                .max_by(|a, b| self.density[a].partial_cmp(&self.density[b]).unwrap())
                .unwrap(),
        }
    }

    // ------------------------------------------------- daily economy

    /// Tops `p` back up to the free floor (live ships only: the simulated
    /// hangar holds no wrecks). Players top up whenever they're short, so
    /// this runs at the start of each day and before each PvE game.
    fn top_up(&self, p: &mut Player, rng: &mut ChaCha8Rng) {
        let floor = self.profiles.economy.free_topup_floor as usize;
        if p.ships.len() >= floor {
            return;
        }
        let v = self.claim_variant(p);
        let n = floor - p.ships.len();
        for _ in 0..n {
            p.new_ship(self.cfg, v, 0, true, rng);
        }
        p.stats.ships_topped_up += n as u32;
    }

    fn economy_day(&self, p: &mut Player, day: u32, rng: &mut ChaCha8Rng) {
        let e = &self.profiles.economy;
        let prof = &self.profiles.spend[&p.spend];
        let cfg = self.cfg;
        // Free claim.
        if day.is_multiple_of(e.claim_cooldown_days) {
            let v = self.claim_variant(p);
            let n = e.free_claim_base + p.storefront_tier as u32;
            for _ in 0..n {
                p.new_ship(cfg, v, 0, true, rng);
            }
            p.claims += 1;
            p.stats.ships_claimed += n;
        }
        self.top_up(p, rng);
        // Spend: a daily accrual split between packs and modification UTC.
        let daily = prof.usd_per_month / 30.0;
        if daily > 0.0 {
            p.usd_spent += daily;
            p.utc += daily * prof.modify_share;
            p.pack_budget += daily * (1.0 - prof.modify_share);
            if let Some(t) = prof.pack_tier {
                while p.pack_budget >= e.pack_usd[t] {
                    p.pack_budget -= e.pack_usd[t];
                    let v = self.buy_variant(p, p.stats.ships_bought / e.pack_ships[t].max(1));
                    let ranked = t as u32 + 1;
                    for i in 0..e.pack_ships[t] {
                        let kills = if i < ranked {
                            kills_for_rank((ranked - i) as u8)
                        } else {
                            0
                        };
                        p.new_ship(cfg, v, kills, false, rng);
                    }
                    p.stats.ships_bought += e.pack_ships[t];
                }
            }
        }
        // DEC turn-ins.
        let tiers = &cfg.storefront_tiers;
        while (p.storefront_tier as usize) < tiers.len()
            && p.dec >= tiers[p.storefront_tier as usize] as u64
        {
            p.dec -= tiers[p.storefront_tier as usize] as u64;
            p.storefront_tier += 1;
        }
        // Recycling (Average and Excellent): destroyed paid ships for half
        // the reward; Excellent also clears its weakest paid ships once the
        // hangar is large.
        if p.level != Level::Poor && p.destroyed_paid > 0 {
            let r = p.destroyed_paid as f64 * e.recycle_reward_utc / 2.0;
            p.utc += r;
            p.stats.utc_earned += r;
            p.stats.destroyed_recycled += p.destroyed_paid;
            p.destroyed_paid = 0;
        }
        if p.level == Level::Excellent && p.ships.len() > 120 {
            let d = |s: &Ship| self.values.value(cfg, s) / s.ship_data.cost.max(1) as f64;
            let mut paid: Vec<(f64, u64)> = p
                .ships
                .iter()
                .filter(|s| !s.ship_data.is_free_ship)
                .map(|s| (d(s), s.id))
                .collect();
            paid.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
            let drop: BTreeSet<u64> = paid.iter().take(p.ships.len() - 120).map(|x| x.1).collect();
            p.ships.retain(|s| !drop.contains(&s.id));
            p.utc += drop.len() as f64 * e.recycle_reward_utc;
            p.stats.utc_earned += drop.len() as f64 * e.recycle_reward_utc;
            p.stats.ships_recycled += drop.len() as u32;
        }
        // DroneYard: improve the best ships while UTC (above a repair reserve)
        // covers the next modification.
        if prof.modify_share > 0.0 {
            let reserve = 5.0;
            let max_changes = if p.level == Level::Excellent { 2 } else { 1 };
            for _ in 0..20 {
                let mut cands: Vec<(f64, usize)> = p
                    .ships
                    .iter()
                    .enumerate()
                    .map(|(i, s)| (self.values.value(cfg, s), i))
                    .collect();
                cands.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap().then(a.1.cmp(&b.1)));
                // The strongest ship with the fewest modifications so far.
                let Some(&(_, i)) = cands
                    .iter()
                    .take(10)
                    .min_by_key(|(_, i)| p.ships[*i].ship_data.modified)
                else {
                    break;
                };
                let ship = p.ships[i].clone();
                let Some(build) = choose_build(p.level, cfg, self.values, &ship, max_changes, rng)
                else {
                    break;
                };
                let changes = count_modifications(&ship, &build);
                let base = (e.modification_base_utc * 1e6) as u128;
                let Some(cost) = modification_cost(base, ship.ship_data.modified, changes) else {
                    break;
                };
                let cost = cost as f64 / 1e6;
                if p.utc - reserve < cost {
                    break;
                }
                p.utc -= cost;
                p.stats.utc_on_mods += cost;
                p.stats.modifications += changes;
                let mut b = build;
                b.ship_data.modified = ship.ship_data.modified + changes as u16;
                p.ships[i] = b;
            }
        }
    }

    // ------------------------------------------------- activities

    fn plan_day(&self, p: &Player, rng: &mut ChaCha8Rng) -> Vec<Activity> {
        let prof = &self.profiles.spend[&p.spend];
        let per_day = prof.sessions_per_week / 7.0;
        let sessions = per_day.floor() as u32 + rng.gen_bool(per_day.fract()) as u32;
        let total = prof.mix.campaign + prof.mix.roguelike + prof.mix.pvp;
        (0..sessions * prof.games_per_session)
            .map(|_| {
                let r = rng.gen::<f64>() * total;
                if r < prof.mix.campaign {
                    Activity::Campaign
                } else if r < prof.mix.campaign + prof.mix.roguelike {
                    Activity::Roguelike
                } else {
                    Activity::Pvp
                }
            })
            .collect()
    }

    /// The campaign node to play: the next one unlocked (Poor: a random
    /// unlocked one; Excellent: the easiest unlocked one); once everything is
    /// done, farm the node with the most variant-2 AI ships (DEC).
    pub fn pick_node(&self, p: &Player, rng: &mut ChaCha8Rng) -> usize {
        let nodes = &self.content.sp_nodes;
        let open: Vec<usize> = (0..nodes.len())
            .filter(|&i| {
                !p.completed.contains(&nodes[i].key)
                    && nodes[i]
                        .prerequisites
                        .iter()
                        .all(|q| p.completed.contains(q))
            })
            .collect();
        // Average and Excellent skip nodes that have been costing ships
        // without wins: estimated clear chance (Laplace) against expected
        // ships lost times how much this player minds a loss right now.
        let open: Vec<usize> = if p.level == Level::Poor {
            open
        } else {
            let a = self.aversion(p);
            let worth = |i: usize| {
                let (n, w, l) = p.node_record.get(&nodes[i].key).copied().unwrap_or_default();
                let clear = (w as f64 + 1.0) / (n as f64 + 2.0);
                let lost = (l as f64 + 0.25) / (n as f64 + 1.0);
                clear - a * lost > 0.0
            };
            let keep: Vec<usize> = open.iter().copied().filter(|&i| worth(i)).collect();
            if keep.is_empty() && !p.completed.is_empty() {
                // Nothing open is worth it: farm a completed node instead.
                return self.farm_node(p);
            }
            if keep.is_empty() { open } else { keep }
        };
        if !open.is_empty() {
            return match p.level {
                Level::Poor => open[rng.gen_range(0..open.len())],
                Level::Average => open[0],
                Level::Excellent => *open
                    .iter()
                    .min_by(|&&a, &&b| {
                        self.node_ai[&nodes[a].key]
                            .0
                            .partial_cmp(&self.node_ai[&nodes[b].key].0)
                            .unwrap()
                    })
                    .unwrap(),
            };
        }
        match p.level {
            Level::Poor => rng.gen_range(0..nodes.len()),
            _ => self.farm_node(p),
        }
    }

    /// `p`'s current per-ship loss aversion (spend profile × scarcity).
    fn aversion(&self, p: &Player) -> f64 {
        let base = self.profiles.spend[&p.spend].loss_aversion;
        base * (SCARCITY_ROSTERS * TYPICAL_ROSTER / (p.ships.len() as f64).max(1.0)).clamp(1.0, MAX_SCARCITY)
    }

    /// The completed node with the most variant-2 AI ships per AI strength
    /// (DEC farming); any node if none is completed.
    fn farm_node(&self, p: &Player) -> usize {
        let nodes = &self.content.sp_nodes;
        let done = |i: usize| p.completed.is_empty() || p.completed.contains(&nodes[i].key);
        (0..nodes.len())
            .filter(|&i| done(i))
            .max_by(|&a, &b| {
                let s = |i: usize| {
                    let (v, n2) = self.node_ai[&nodes[i].key];
                    n2 as f64 / v.max(0.1)
                };
                s(a).partial_cmp(&s(b)).unwrap().then(b.cmp(&a))
            })
            .unwrap()
    }

    fn campaign(&self, p: &mut Player, day: u32, rng: &mut ChaCha8Rng) -> Option<MatchLog> {
        let ni = self.pick_node(p, rng);
        let node = &self.content.sp_nodes[ni];
        let ai = AiSide::for_map(self.content, self.cfg, &node.map);
        let ctx = ComposeCtx {
            content: self.content,
            cfg: self.cfg,
            map: &node.map,
            is_creator: true,
            cap: node.cost_limit,
            max_score: node.max_score,
            creator_goes_first: node.creator_goes_first,
            variant: None,
            carried: &[],
            foe: Foe::Ai(&ai),
            survival_weight: 0.5,
            repair_ships: 0,
        };
        let lv = p.level as usize;
        let lineup = self.composers[lv].compose(&ctx, &p.ships, rng);
        if lineup.ids.is_empty() {
            return None;
        }
        let ships: Vec<&Ship> = lineup
            .ids
            .iter()
            .map(|id| p.ships.iter().find(|s| s.id == *id).unwrap())
            .collect();
        let tactician = self.tactician_for(p, &ships, &ai.ships.iter().collect::<Vec<_>>(), false);
        let me = SideSetup {
            label: p.label.clone(),
            ships,
            cells: lineup.cells,
            controller: Controller::Agent(tactician.as_ref()),
            ai_keys: HashMap::new(),
        };
        let played = play_match(
            self.cfg,
            "campaign",
            day as u64,
            &node.map,
            Some(&node.key),
            &self.content.maps[&node.map],
            me,
            ai.side(),
            node.creator_goes_first,
            node.max_score,
            &[],
            Limits::default(),
            rng,
        );
        let g = &played.game;
        p.stats.campaign_played += 1;
        let dec = pve_dec_reward(g, &ai, &[2], 1);
        p.dec += dec;
        p.stats.dec_earned += dec;
        if g.winner == Some(Side::Creator) {
            p.stats.campaign_won += 1;
            p.completed.insert(node.key.clone());
            if self.profiles.economy.medal_nodes.contains(&node.key) && p.medal_day.is_none() {
                p.medal_day = Some(day);
            }
        }
        let lost: BTreeSet<u64> = lineup
            .ids
            .iter()
            .copied()
            .filter(|&id| g.ship(id).status == STATUS_DESTROYED)
            .collect();
        let rec = p.node_record.entry(node.key.clone()).or_default();
        rec.0 += 1;
        rec.1 += (g.winner == Some(Side::Creator)) as u32;
        rec.2 += lost.len() as u32;
        p.lose(&lost);
        Some(played.log)
    }

    fn roguelike(
        &self,
        p: &mut Player,
        day: u32,
        rng: &mut ChaCha8Rng,
    ) -> Option<(RunLog, Vec<MatchLog>)> {
        let rl = &self.content.roguelike;
        let root = &rl.nodes[&rl.root];
        let map = root.map.as_deref()?;
        let ai = AiSide::for_map(self.content, self.cfg, map);
        let ctx = ComposeCtx {
            content: self.content,
            cfg: self.cfg,
            map,
            is_creator: true,
            cap: rl.initial_cost_cap,
            max_score: root.max_score,
            creator_goes_first: root.creator_goes_first,
            variant: Some(rl.required_variant),
            carried: &[],
            foe: Foe::Ai(&ai),
            survival_weight: 1.0,
            repair_ships: crate::composition::compose::ROGUELIKE_REPAIR_SHIPS,
        };
        let lv = p.level as usize;
        let roster = self.composers[lv].compose(&ctx, &p.ships, rng).ids;
        if roster.is_empty() {
            return None;
        }
        let e = &self.profiles.economy;
        let budget_hp = (p.utc / e.repair_utc_per_hp).floor().max(0.0) as u64;
        // Preferences over the variant-1 ships the run can field (the
        // roster and anything that joins it). The AI fleet changes every
        // node, so bounties go by variant: most missions field variant-2
        // AI, whose kills pay DEC.
        let pool: Vec<&Ship> = p
            .ships
            .iter()
            .filter(|s| s.traits.variant == rl.required_variant)
            .collect();
        let mut prefs = self.loss_prefs(p, &pool, &[], false);
        prefs.bounty_variant2 = DEC_UTILITY as f32;
        let tactician = self.tc.make_with(p.level, &self.eval, Some(prefs));
        let r = run_roguelike(
            self.content,
            self.cfg,
            day as u64,
            &p.label,
            &p.ships,
            &roster,
            self.planners[lv].as_ref(),
            tactician.as_ref(),
            &p.grants_claimed,
            budget_hp,
            Limits::default(),
            rng,
        );
        let repair = r.log.repair_utc_hp as f64 * e.repair_utc_per_hp;
        p.utc -= repair;
        p.stats.utc_on_repairs += repair;
        p.dec += r.dec;
        p.stats.dec_earned += r.dec;
        p.stats.runs += 1;
        p.stats.run_combats_won += r.log.combats_won;
        p.stats.runs_won += r.log.won as u32;
        if r.log.won
            && p.medal_day.is_none()
            && r.log.path.last().is_some_and(|k| e.medal_nodes.contains(k))
        {
            p.medal_day = Some(day);
        }
        p.lose(&r.lost.iter().copied().collect());
        for g in r.grants {
            let id = p.next_id;
            p.next_id += 1;
            let mut s = Ship { id, ..g };
            fleet::price(self.cfg, &mut s);
            p.ships.push(s);
            p.stats.ships_granted += 1;
        }
        p.grants_claimed = r.grants_claimed;
        Some((r.log, r.matches))
    }

    /// `p`'s ship-loss preferences for a game fielding `fleet` against
    /// `enemies`: the spend profile's aversion, scaled up as the hangar runs
    /// low (scarcity) and per ship by its cost relative to the fleet's
    /// average; enemy bounties are what each kill actually pays (variant-2
    /// AI kills 1 DEC; PvP kills of paid ships `pvp_kill_reward_utc`).
    pub fn loss_prefs(&self, p: &Player, fleet: &[&Ship], enemies: &[&Ship], pvp: bool) -> LossPrefs {
        let base = self.profiles.spend[&p.spend].loss_aversion;
        let playable = p.ships.len() as f64;
        let scarcity = (SCARCITY_ROSTERS * TYPICAL_ROSTER / playable.max(1.0)).clamp(1.0, MAX_SCARCITY);
        let mean = fleet.iter().map(|s| s.ship_data.cost as f64).sum::<f64>() / fleet.len().max(1) as f64;
        let own = fleet
            .iter()
            .map(|s| (s.id, (base * scarcity * ship_loss_weight(self.cfg, s, mean)) as f32))
            .collect();
        let bounty = enemies
            .iter()
            .map(|s| {
                let b = if pvp {
                    if s.ship_data.is_free_ship {
                        0.0
                    } else {
                        self.profiles.economy.pvp_kill_reward_utc * UTC_UTILITY
                    }
                } else if s.traits.variant == 2 {
                    DEC_UTILITY
                } else {
                    0.0
                };
                (s.id, b as f32)
            })
            .collect();
        LossPrefs {
            own_default: (base * scarcity) as f32,
            own,
            bounty_default: 0.0,
            bounty_variant2: 0.0,
            bounty,
            killable_risk: crate::eval::KILLABLE_RISK,
        }
    }

    /// A tactician for `p` with their loss preferences for this game.
    pub fn tactician_for(&self, p: &Player, fleet: &[&Ship], enemies: &[&Ship], pvp: bool) -> Box<dyn Tactician> {
        self.tc.make_with(p.level, &self.eval, Some(self.loss_prefs(p, fleet, enemies, pvp)))
    }

    /// The largest bracket the player's best fleet can mostly fill.
    fn bracket(&self, p: &Player) -> u64 {
        let b = &self.profiles.pvp.brackets;
        let mut costs: Vec<u64> = p.ships.iter().map(|s| s.ship_data.cost as u64).collect();
        costs.sort_unstable_by(|a, b| b.cmp(a));
        let top: u64 = costs.iter().take(12).sum();
        *b.iter()
            .rev()
            .find(|&&c| top as f64 >= 0.8 * c as f64)
            .unwrap_or(&b[0])
    }
}

/// Ids for meta copies of fielded fleets (player ids are index * 1e7 + n,
/// far below this; AI ids start at 2^40, above it).
const META_ID_OFFSET: u64 = 500_000_000_000;

/// One PvP game's consequences, applied after a round.
pub(crate) struct PvpResult {
    a: usize,
    b: usize,
    pub(crate) log: MatchLog,
    /// Destroyed ships by owner (player index).
    destroyed: Vec<(usize, u64)>,
    /// Kill credits (owner, killer ship id) for non-free victims.
    kills: Vec<(usize, u64)>,
    /// Both fleets as fielded (they join the bracket's meta).
    fleets: [Vec<Ship>; 2],
}

#[allow(clippy::too_many_arguments)]
fn pvp_game(
    w: &World,
    pa: &Player,
    pb: &Player,
    bracket: u64,
    meta: &[Vec<Ship>],
    day: u32,
    seed: u64,
) -> Option<PvpResult> {
    pvp_game_sided(w, pa, pb, bracket, meta, day, seed, None)
}

/// A PvP game between two players' hangars on a seeded random PvP map.
/// `a_creates`: whether `pa` deploys on the creator side (None = random, as
/// in the economy). Returns None if either side has no fleet that fits.
#[allow(clippy::too_many_arguments)]
pub(crate) fn pvp_game_sided(
    w: &World,
    pa: &Player,
    pb: &Player,
    bracket: u64,
    meta: &[Vec<Ship>],
    day: u32,
    seed: u64,
    a_creates: Option<bool>,
) -> Option<PvpResult> {
    let mut rng = ChaCha8Rng::seed_from_u64(seed);
    let map = &w.content.pvp_maps[rng.gen_range(0..w.content.pvp_maps.len())];
    // Who creates the lobby (and so deploys on the creator side) is random
    // unless fixed. (The draw is always made, so the rng stream is the same.)
    let random_side = rng.gen_bool(0.5);
    let (c, j) = if a_creates.unwrap_or(random_side) {
        (pa, pb)
    } else {
        (pb, pa)
    };
    let ms = w.profiles.pvp.max_score;
    let ctx_c = ComposeCtx {
        content: w.content,
        cfg: w.cfg,
        map,
        is_creator: true,
        cap: bracket,
        max_score: ms,
        creator_goes_first: true,
        variant: None,
        carried: &[],
        foe: Foe::Meta(meta),
        survival_weight: 0.2,
        repair_ships: 0,
    };
    let get = |p: &Player, ids: &[u64]| -> Vec<Ship> {
        ids.iter()
            .map(|id| p.ships.iter().find(|s| s.id == *id).unwrap().clone())
            .collect()
    };
    // The creator submits first (and so moves first); the joiner deploys
    // second and can read the creator's fleet and cells from chain state.
    let lc = w.composers[c.level as usize].compose(&ctx_c, &c.ships, &mut rng);
    let sc = get(c, &lc.ids);
    let ctx_j = ComposeCtx {
        is_creator: false,
        foe: Foe::Known {
            ships: &sc,
            cells: &lc.cells,
        },
        ..ctx_c
    };
    let lj = w.composers[j.level as usize].compose(&ctx_j, &j.ships, &mut rng);
    let sj = get(j, &lj.ids);
    if sc.is_empty() || sj.is_empty() {
        return None; // someone has no fleet that fits: no game
    }
    let (rc, rj): (Vec<&Ship>, Vec<&Ship>) = (sc.iter().collect(), sj.iter().collect());
    let tc_ = w.tactician_for(c, &rc, &rj, true);
    let tj_ = w.tactician_for(j, &rj, &rc, true);
    let side_c = SideSetup {
        label: c.label.clone(),
        ships: rc.clone(),
        cells: lc.cells.clone(),
        controller: Controller::Agent(tc_.as_ref()),
        ai_keys: HashMap::new(),
    };
    let side_j = SideSetup {
        label: j.label.clone(),
        ships: rj.clone(),
        cells: lj.cells.clone(),
        controller: Controller::Agent(tj_.as_ref()),
        ai_keys: HashMap::new(),
    };
    let played = play_match(
        w.cfg,
        "pvp",
        day as u64,
        map,
        None,
        &w.content.maps[map],
        side_c,
        side_j,
        true,
        ms,
        &[],
        Limits::default(),
        &mut rng,
    );
    let g = &played.game;
    let mut destroyed = Vec::new();
    let mut kills = Vec::new();
    let owner_of = |id: u64| {
        if sc.iter().any(|s| s.id == id) {
            Some(c.index)
        } else if sj.iter().any(|s| s.id == id) {
            Some(j.index)
        } else {
            None
        }
    };
    for s in sc.iter().chain(&sj) {
        if g.ship(s.id).status == STATUS_DESTROYED {
            destroyed.push((owner_of(s.id).unwrap(), s.id));
            let killer = g.ship(s.id).last_damager;
            if killer != 0 && !s.ship_data.is_free_ship {
                if let Some(o) = owner_of(killer) {
                    kills.push((o, killer));
                }
            }
        }
    }
    // Report from A's perspective regardless of who created.
    Some(PvpResult {
        a: pa.index,
        b: pb.index,
        log: played.log,
        destroyed,
        kills,
        fleets: [sc, sj],
    })
}

#[derive(Debug, Serialize)]
pub struct Snapshot {
    pub record: &'static str,
    pub day: u32,
    pub player: String,
    pub spend: String,
    pub skill: String,
    pub ships: usize,
    pub ships_v2: usize,
    pub fleet_power_1000: f64,
    pub usd_spent: f64,
    pub utc: f64,
    pub dec: u64,
    pub storefront_tier: u8,
    pub medal_day: Option<u32>,
    pub nodes_completed: usize,
    pub elo: f64,
    pub stats: PlayerStats,
}

fn snapshot(w: &World, p: &Player, day: u32) -> Snapshot {
    Snapshot {
        record: "player",
        day,
        player: p.label.clone(),
        spend: p.spend.clone(),
        skill: p.level.name().into(),
        ships: p.ships.len(),
        ships_v2: p.ships.iter().filter(|s| s.traits.variant == 2).count(),
        fleet_power_1000: fleet_power(w.cfg, w.values, &p.ships, 1000),
        usd_spent: p.usd_spent,
        utc: p.utc,
        dec: p.dec,
        storefront_tier: p.storefront_tier,
        medal_day: p.medal_day,
        nodes_completed: p.completed.len(),
        elo: p.elo,
        stats: p.stats.clone(),
    }
}

pub struct SimOutput {
    pub players: Vec<Player>,
    /// JSONL lines: matches (PvE, roguelike combats, PvP), runs, snapshots.
    pub match_lines: Vec<String>,
    pub run_lines: Vec<String>,
    pub snapshot_lines: Vec<String>,
}

/// Runs the population for `opts.days` days.
/// Everything a run carries from one day to the next: the checkpoint.
/// (All randomness is seeded per (seed, player, day), so nothing random
/// carries over: resuming from this state reproduces an uninterrupted run.)
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SimState {
    pub next_day: u32,
    pub players: Vec<Player>,
    pub meta: BTreeMap<u64, Vec<Vec<Ship>>>,
}

/// One day's JSONL lines.
#[derive(Default)]
pub struct DayLines {
    pub match_lines: Vec<String>,
    pub run_lines: Vec<String>,
    pub snapshot_lines: Vec<String>,
}

impl SimState {
    pub fn new(w: &World, opts: &SimOpts) -> SimState {
        let pv = &w.profiles.pvp;
        let mut players: Vec<Player> = Vec::new();
        for spend in w.profiles.spend.keys() {
            for level in Level::ALL {
                for k in 0..opts.players_per_archetype {
                    let i = players.len();
                    players.push(Player::new(i, spend, level, k, pv.elo_start));
                }
            }
        }
        let meta = crate::composition::bench::build_meta_for(
            w.content,
            w.cfg,
            w.values,
            &pv.brackets,
            8,
            opts.seed,
        )
        .into_iter()
        .collect();
        SimState {
            next_day: 0,
            players,
            meta,
        }
    }

    /// Simulates day `next_day` and advances.
    pub fn step(&mut self, w: &World, opts: &SimOpts) -> DayLines {
        let day = self.next_day;
        let pv = &w.profiles.pvp;
        let players = &mut self.players;
        let meta = &mut self.meta;
        let mut out = DayLines::default();
        // 1-2. Economy and PvE, in parallel across players.
        let results: Vec<(Vec<Activity>, Vec<String>, Vec<String>)> = players
            .par_iter_mut()
            .map(|p| {
                let mut rng = ChaCha8Rng::seed_from_u64(mix(opts.seed, p.index as u64, day as u64));
                w.economy_day(p, day, &mut rng);
                // Peak hangar: after the day's claims and purchases, before
                // any game can lose ships.
                let power = fleet_power(w.cfg, w.values, &p.ships, 1000);
                if p.peak_hangar.as_ref().is_none_or(|(best, _)| power > *best) {
                    p.peak_hangar = Some((power, p.ships.clone()));
                }
                let acts = w.plan_day(p, &mut rng);
                let (mut ml, mut rl) = (Vec::new(), Vec::new());
                for a in &acts {
                    if *a != Activity::Pvp {
                        w.top_up(p, &mut rng);
                    }
                    match a {
                        Activity::Campaign => {
                            if let Some(l) = w.campaign(p, day, &mut rng) {
                                ml.push(serde_json::to_string(&l).unwrap());
                            }
                        }
                        Activity::Roguelike if p.run_slots_owed > 0 => p.run_slots_owed -= 1,
                        Activity::Roguelike => {
                            if let Some((r, ms)) = w.roguelike(p, day, &mut rng) {
                                p.run_slots_owed = (ms.len() as u32).saturating_sub(1);
                                ml.extend(ms.iter().map(|m| serde_json::to_string(m).unwrap()));
                                rl.push(serde_json::to_string(&r).unwrap());
                            }
                        }
                        Activity::Pvp => {}
                    }
                }
                (acts, ml, rl)
            })
            .collect();
        let mut pvp_left: Vec<u32> = Vec::new();
        for (acts, ml, rl) in results {
            pvp_left.push(acts.iter().filter(|a| **a == Activity::Pvp).count() as u32);
            out.match_lines.extend(ml);
            out.run_lines.extend(rl);
        }

        // 3. PvP rounds.
        let mut round = 0u64;
        while pvp_left.iter().any(|&n| n > 0) {
            let mut mm = ChaCha8Rng::seed_from_u64(mix(opts.seed, day as u64, 1_000_000 + round));
            let mut by_bracket: BTreeMap<u64, Vec<(f64, usize)>> = BTreeMap::new();
            for (i, n) in pvp_left.iter_mut().enumerate() {
                if *n > 0 {
                    *n -= 1;
                    let noise = (mm.gen::<f64>() - 0.5) * 2.0 * pv.matchmaking_noise;
                    by_bracket
                        .entry(w.bracket(&players[i]))
                        .or_default()
                        .push((players[i].elo + noise, i));
                }
            }
            let mut pairs: Vec<(usize, usize, u64)> = Vec::new();
            for (b, mut q) in by_bracket {
                q.sort_by(|x, y| x.0.partial_cmp(&y.0).unwrap().then(x.1.cmp(&y.1)));
                for ch in q.chunks(2) {
                    if ch.len() == 2 {
                        pairs.push((ch[0].1, ch[1].1, b));
                    } else {
                        players[ch[0].1].stats.pvp_unmatched += 1;
                    }
                }
            }
            let results: Vec<Option<PvpResult>> = pairs
                .par_iter()
                .enumerate()
                .map(|(k, &(a, b, br))| {
                    pvp_game(
                        w,
                        &players[a],
                        &players[b],
                        br,
                        &meta[&br],
                        day,
                        mix(opts.seed, day as u64 * 1000 + round, k as u64),
                    )
                })
                .collect();
            for (r, &(a_i, b_i, br)) in results.into_iter().zip(&pairs) {
                let Some(r) = r else {
                    players[a_i].stats.pvp_unmatched += 1;
                    players[b_i].stats.pvp_unmatched += 1;
                    continue;
                };
                let (pa_label, pb_label) = (players[r.a].label.clone(), players[r.b].label.clone());
                // Winner from the log's sides.
                let winner_label = match r.log.winner {
                    "creator" => Some(r.log.creator.label.clone()),
                    "joiner" => Some(r.log.joiner.label.clone()),
                    _ => None,
                };
                let score_a = match &winner_label {
                    Some(l) if *l == pa_label => 1.0,
                    Some(l) if *l == pb_label => 0.0,
                    _ => 0.5,
                };
                let expected =
                    1.0 / (1.0 + 10f64.powf((players[r.b].elo - players[r.a].elo) / 400.0));
                let delta = pv.elo_k * (score_a - expected);
                players[r.a].elo += delta;
                players[r.b].elo -= delta;
                for (i, s) in [(r.a, score_a), (r.b, 1.0 - score_a)] {
                    let p = &mut players[i];
                    p.stats.pvp_played += 1;
                    if s == 1.0 {
                        p.stats.pvp_won += 1;
                    } else if s == 0.5 {
                        p.stats.pvp_drawn += 1;
                    }
                }
                for &(owner, killer) in &r.kills {
                    let p = &mut players[owner];
                    if let Some(s) = p.ships.iter_mut().find(|s| s.id == killer) {
                        s.ship_data.ships_destroyed += 1;
                    }
                    p.utc += w.profiles.economy.pvp_kill_reward_utc;
                    p.stats.utc_earned += w.profiles.economy.pvp_kill_reward_utc;
                }
                for &(owner, id) in &r.destroyed {
                    players[owner].lose(&[id].into_iter().collect());
                }
                // Both fleets join the bracket's meta (most recent kept).
                let m = meta.entry(br).or_default();
                for f in r.fleets.into_iter().filter(|f| !f.is_empty()) {
                    // Meta copies get ids no player uses, so a player meeting
                    // its own past fleet in search never duplicates an id.
                    m.push(
                        f.into_iter()
                            .map(|s| Ship {
                                id: META_ID_OFFSET + s.id,
                                ..s
                            })
                            .collect(),
                    );
                }
                let excess = m.len().saturating_sub(pv.meta_window);
                m.drain(..excess);
                out.match_lines.push(serde_json::to_string(&r.log).unwrap());
            }
            round += 1;
        }

        if day % opts.snapshot_every == opts.snapshot_every - 1 || day + 1 == opts.days {
            for p in players.iter() {
                out.snapshot_lines
                    .push(serde_json::to_string(&snapshot(w, p, day)).unwrap());
            }
        }
        self.next_day += 1;
        out
    }
}

pub fn simulate(w: &World, opts: &SimOpts, mut progress: impl FnMut(u32, &[Player])) -> SimOutput {
    let mut st = SimState::new(w, opts);
    let mut out = SimOutput {
        players: Vec::new(),
        match_lines: Vec::new(),
        run_lines: Vec::new(),
        snapshot_lines: Vec::new(),
    };
    while st.next_day < opts.days {
        let d = st.step(w, opts);
        out.match_lines.extend(d.match_lines);
        out.run_lines.extend(d.run_lines);
        out.snapshot_lines.extend(d.snapshot_lines);
        progress(st.next_day - 1, &st.players);
    }
    out.players = st.players;
    out
}

/// Per-archetype means of the final snapshots.
pub fn summarize(w: &World, players: &[Player], day: u32) -> Vec<serde_json::Value> {
    let mut groups: BTreeMap<(String, Level), Vec<&Player>> = BTreeMap::new();
    for p in players {
        groups
            .entry((p.spend.clone(), p.level))
            .or_default()
            .push(p);
    }
    groups
        .into_iter()
        .map(|((spend, level), ps)| {
            let n = ps.len() as f64;
            let mean = |f: &dyn Fn(&Player) -> f64| ps.iter().map(|p| f(p)).sum::<f64>() / n;
            let rate = |num: &dyn Fn(&Player) -> f64, den: &dyn Fn(&Player) -> f64| {
                let d: f64 = ps.iter().map(|p| den(p)).sum();
                if d > 0.0 { ps.iter().map(|p| num(p)).sum::<f64>() / d } else { f64::NAN }
            };
            // Mean day the medal was won, among players who have it (null if none).
            let medal_days: Vec<f64> = ps.iter().filter_map(|p| p.medal_day).map(|d| d as f64).collect();
            let medal_day = if medal_days.is_empty() { None } else { Some(medal_days.iter().sum::<f64>() / medal_days.len() as f64) };
            serde_json::json!({
                "spend": spend,
                "skill": level.name(),
                "players": ps.len(),
                "days": day + 1,
                "usd_spent": mean(&|p| p.usd_spent),
                "ships": mean(&|p| p.ships.len() as f64),
                "fleet_power_1000": mean(&|p| fleet_power(w.cfg, w.values, &p.ships, 1000)),
                "storefront_tier": mean(&|p| p.storefront_tier as f64),
                "nodes_completed": mean(&|p| p.completed.len() as f64),
                "medal_share": mean(&|p| p.has_medal() as u8 as f64),
                "medal_day": medal_day,
                "campaign_win_rate": rate(&|p| p.stats.campaign_won as f64, &|p| p.stats.campaign_played as f64),
                "campaign_games": mean(&|p| p.stats.campaign_played as f64),
                "run_combats_won": rate(&|p| p.stats.run_combats_won as f64, &|p| p.stats.runs as f64),
                "runs": mean(&|p| p.stats.runs as f64),
                "runs_won": mean(&|p| p.stats.runs_won as f64),
                "run_win_rate": rate(&|p| p.stats.runs_won as f64, &|p| p.stats.runs as f64),
                "pvp_score": rate(&|p| p.stats.pvp_won as f64 + 0.5 * p.stats.pvp_drawn as f64, &|p| p.stats.pvp_played as f64),
                "pvp_games": mean(&|p| p.stats.pvp_played as f64),
                "elo": mean(&|p| p.elo),
                "ships_lost": mean(&|p| p.stats.ships_lost as f64),
                "ships_topped_up": mean(&|p| p.stats.ships_topped_up as f64),
                "dec_earned": mean(&|p| p.stats.dec_earned as f64),
                "modifications": mean(&|p| p.stats.modifications as f64),
                "utc_on_mods": mean(&|p| p.stats.utc_on_mods),
                "utc_on_repairs": mean(&|p| p.stats.utc_on_repairs),
            })
        })
        .collect()
}

// ============================================================ streaming

/// How a streamed run starts.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Start {
    /// Start over (any previous output in the directory is replaced).
    Fresh,
    /// Continue from the directory's checkpoint.
    Resume,
}

const OUTPUTS: [&str; 3] = ["matches.jsonl", "runs.jsonl", "players.jsonl"];

/// The checkpoint file: the state after the last completed day, the output
/// files' lengths at that point, and what the run was made with.
#[derive(Serialize, Deserialize)]
struct Checkpoint {
    opts: SimOpts,
    /// Identifies the inputs (weights, tactics, values, profiles, rules); a
    /// resume with different inputs is refused.
    fingerprint: String,
    lengths: BTreeMap<String, u64>,
    state: SimState,
}

fn io_err(msg: String) -> std::io::Error {
    std::io::Error::other(msg)
}

/// Runs the simulation writing as it goes: each day's lines are appended to
/// `dir/{matches,runs,players}.jsonl` and flushed, then `dir/checkpoint.json`
/// is replaced atomically (write temp, fsync, rename) with the state and the
/// files' lengths, and `dir/summary_partial.json` is refreshed. A run stopped
/// at any point loses at most the day in progress; `Start::Resume` trims any
/// lines written after the last checkpoint and continues, producing exactly
/// the files an uninterrupted run would. `opts.days` may be raised on resume
/// to extend a finished run.
pub fn run_to_dir(
    w: &World,
    opts: &SimOpts,
    dir: &Path,
    start: Start,
    fingerprint: &str,
    mut progress: impl FnMut(u32, &[Player]),
) -> std::io::Result<SimState> {
    use std::fs::{File, OpenOptions};
    use std::io::Write;
    std::fs::create_dir_all(dir)?;
    let cp_path = dir.join("checkpoint.json");
    let mut st = match start {
        Start::Fresh => {
            for f in OUTPUTS {
                File::create(dir.join(f))?;
            }
            SimState::new(w, opts)
        }
        Start::Resume => {
            let cp: Checkpoint =
                serde_json::from_str(&std::fs::read_to_string(&cp_path).map_err(|e| {
                    io_err(format!("no checkpoint to resume in {}: {e}", dir.display()))
                })?)?;
            if cp.fingerprint != fingerprint {
                return Err(io_err(format!("{}: the checkpoint was made with different inputs (weights, tactics, values, profiles or rules); start fresh", dir.display())));
            }
            let same = SimOpts {
                days: opts.days,
                ..cp.opts.clone()
            };
            if &same != opts {
                return Err(io_err(format!(
                    "{}: options differ from the checkpoint's {:?} (only --days may change)",
                    dir.display(),
                    cp.opts
                )));
            }
            if opts.days < cp.state.next_day {
                return Err(io_err(format!(
                    "{}: already ran {} days",
                    dir.display(),
                    cp.state.next_day
                )));
            }
            // Drop anything written after the checkpoint (a day in progress).
            for f in OUTPUTS {
                let len = *cp.lengths.get(f).unwrap_or(&0);
                OpenOptions::new()
                    .write(true)
                    .open(dir.join(f))?
                    .set_len(len)?;
            }
            cp.state
        }
    };
    let mut files: Vec<File> = OUTPUTS
        .iter()
        .map(|f| OpenOptions::new().append(true).open(dir.join(f)))
        .collect::<std::io::Result<_>>()?;
    while st.next_day < opts.days {
        let day = st.next_day;
        let d = st.step(w, opts);
        for (f, lines) in files
            .iter_mut()
            .zip([&d.match_lines, &d.run_lines, &d.snapshot_lines])
        {
            let mut buf = String::new();
            for l in lines {
                buf.push_str(l);
                buf.push('\n');
            }
            f.write_all(buf.as_bytes())?;
            f.sync_data()?;
        }
        let lengths = OUTPUTS
            .iter()
            .map(|f| Ok((f.to_string(), std::fs::metadata(dir.join(f))?.len())))
            .collect::<std::io::Result<_>>()?;
        let cp = Checkpoint {
            opts: opts.clone(),
            fingerprint: fingerprint.into(),
            lengths,
            state: st,
        };
        let tmp = dir.join("checkpoint.json.tmp");
        {
            let mut f = File::create(&tmp)?;
            f.write_all(serde_json::to_string(&cp)?.as_bytes())?;
            f.sync_all()?;
        }
        std::fs::rename(&tmp, &cp_path)?;
        st = cp.state;
        let partial =
            serde_json::json!({ "through_day": day, "archetypes": summarize(w, &st.players, day) });
        std::fs::write(
            dir.join("summary_partial.json"),
            serde_json::to_string_pretty(&partial)?,
        )?;
        progress(day, &st.players);
    }
    Ok(st)
}

/// The state saved in a run directory's checkpoint (after its last day).
pub fn load_state(dir: &Path) -> std::io::Result<SimState> {
    let cp: Checkpoint =
        serde_json::from_str(&std::fs::read_to_string(dir.join("checkpoint.json"))?)?;
    Ok(cp.state)
}

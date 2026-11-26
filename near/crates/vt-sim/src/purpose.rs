//! Ship purposes (2026-11-25, from the human: "during deployment, each ship
//! needs to be placed with a purpose in mind"):
//! 1. Home: stay on home scoring tiles.
//! 2. Center: push to and hold the center tiles.
//! 3. Rush: run at poorly defended enemy-side scoring tiles.
//! 4. Support: back up a Center or Rush ship with firepower or healing.
//!
//! A side's purposes come from fixed ship stats only (`assign`). Deployment
//! (`cells`) and the evaluation's purpose features (`eval.rs`) call the same
//! function, so they always agree on who does what.

use vt_core::engine::{GameState, ShipBoard};
use vt_core::grid::manhattan;
use vt_core::types::{Position, Ship};

use crate::content::Content;
use crate::eval::{zone_of, Zone};
use crate::rules::Config;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Purpose {
    Home,
    Center,
    Rush,
    Support,
}

/// Ships this slow or slower only ever go Home (human: "speed 1 or 2 ships
/// should be used exclusively for home or near-home objectives").
pub const HOME_MAX_SPEED: u8 = 2;
/// The slowest a Rush ship can be.
pub const RUSH_MIN_SPEED: u8 = 5;
/// Guns this long-ranged make a ship Support (v1 Sniper 6, v2 Sniper 5).
pub const SUPPORT_MIN_RANGE: u8 = 5;

/// The stats purposes are assigned from.
#[derive(Clone, Copy, Debug)]
pub struct PShip {
    pub id: u64,
    pub movement: u8,
    pub range: u8,
    pub gun_damage: u8,
    pub max_hp: u8,
    pub dr: u8,
    pub repair: bool,
}

impl PShip {
    pub fn from_board(id: u64, b: &ShipBoard) -> PShip {
        PShip {
            id,
            movement: b.movement,
            range: b.range,
            gun_damage: b.gun_damage,
            max_hp: b.max_hull_points,
            dr: b.damage_reduction,
            repair: crate::eval::can_repair_special(b.variant, b.special as u8),
        }
    }
    pub fn from_ship(cfg: &Config, s: &Ship) -> PShip {
        let a = cfg.attributes(s).expect("attributes");
        PShip {
            id: s.id,
            movement: a.movement,
            range: a.range,
            gun_damage: a.gun_damage,
            max_hp: a.max_hull_points,
            dr: a.damage_reduction,
            repair: crate::eval::can_repair_special(s.traits.variant, s.equipment.special as u8),
        }
    }
    /// Effective HP: max HP / (1 - damage reduction).
    pub fn durability(&self) -> u32 {
        self.max_hp as u32 * 100 / (100 - self.dr.min(99) as u32)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Assignment {
    pub id: u64,
    pub purpose: Purpose,
    /// Support only: the Center or Rush ship it backs up.
    pub partner: Option<u64>,
}

/// Purposes for one side's ships (deterministic; order of `ships` doesn't
/// matter). `has_home` / `has_enemy`: the map has live home / enemy-side
/// scoring tiles for this side.
/// 1. Every ship of speed <= HOME_MAX_SPEED is Home. With a home tile and
///    none that slow, the slowest ship (most durable first) is Home anyway,
///    if the fleet has at least 3 ships.
/// 2. Repair ships and long-range guns (>= SUPPORT_MIN_RANGE) are Support,
///    at most one per Center or Rush ship (the most durable spare ones are
///    Center). Repair here means a repair special: every v2 ship has the
///    faction repair, so that alone doesn't make one a healer.
/// 3. With an enemy-side tile and at least two ships left, the fastest one
///    (speed >= RUSH_MIN_SPEED; more damage, then shorter range first) is
///    Rush.
/// 4. The rest are Center.
/// 5. Supports pair with Center ships, most durable first, round robin
///    (the Rush ship if there's no Center ship).
pub fn assign(ships: &[PShip], has_home: bool, has_enemy: bool) -> Vec<Assignment> {
    let mut s: Vec<PShip> = ships.to_vec();
    s.sort_by_key(|x| x.id);
    let mut purpose: Vec<Option<Purpose>> = vec![None; s.len()];
    // 1. Home.
    for (i, x) in s.iter().enumerate() {
        if x.movement <= HOME_MAX_SPEED {
            purpose[i] = Some(Purpose::Home);
        }
    }
    if has_home && s.len() >= 3 && !purpose.contains(&Some(Purpose::Home)) {
        let i = (0..s.len())
            .min_by_key(|&i| (s[i].movement, std::cmp::Reverse(s[i].durability()), s[i].id))
            .unwrap();
        purpose[i] = Some(Purpose::Home);
    }
    // 2. Support.
    for (i, x) in s.iter().enumerate() {
        if purpose[i].is_none() && (x.repair || x.range >= SUPPORT_MIN_RANGE) {
            purpose[i] = Some(Purpose::Support);
        }
    }
    let free = |p: &[Option<Purpose>]| (0..s.len()).filter(|&i| p[i].is_none()).count();
    // 3. Rush.
    if has_enemy && free(&purpose) >= 2 {
        let r = (0..s.len())
            .filter(|&i| purpose[i].is_none() && s[i].movement >= RUSH_MIN_SPEED)
            .max_by_key(|&i| {
                (
                    s[i].movement,
                    s[i].gun_damage,
                    std::cmp::Reverse(s[i].range),
                    std::cmp::Reverse(s[i].id),
                )
            });
        if let Some(i) = r {
            purpose[i] = Some(Purpose::Rush);
        }
    }
    // 4. Center.
    for p in purpose.iter_mut().filter(|p| p.is_none()) {
        *p = Some(Purpose::Center);
    }
    // At most one Support per Center or Rush ship: the most durable spare
    // Supports become Center.
    let count = |p: &[Option<Purpose>], q| p.iter().filter(|x| **x == Some(q)).count();
    while count(&purpose, Purpose::Support)
        > count(&purpose, Purpose::Center) + count(&purpose, Purpose::Rush)
    {
        let i = (0..s.len())
            .filter(|&i| purpose[i] == Some(Purpose::Support))
            .max_by_key(|&i| (s[i].durability(), std::cmp::Reverse(s[i].id)))
            .unwrap();
        purpose[i] = Some(Purpose::Center);
    }
    // 5. Partners.
    let mut leads: Vec<usize> = (0..s.len())
        .filter(|&i| purpose[i] == Some(Purpose::Center))
        .collect();
    if leads.is_empty() {
        leads = (0..s.len())
            .filter(|&i| purpose[i] == Some(Purpose::Rush))
            .collect();
    }
    leads.sort_by_key(|&i| (std::cmp::Reverse(s[i].durability()), s[i].id));
    let mut next = 0;
    s.iter()
        .enumerate()
        .map(|(i, x)| {
            let p = purpose[i].unwrap();
            let partner = if p == Purpose::Support && !leads.is_empty() {
                let l = leads[next % leads.len()];
                next += 1;
                Some(s[l].id)
            } else {
                None
            };
            Assignment {
                id: x.id,
                purpose: p,
                partner,
            }
        })
        .collect()
}

/// Live scoring tiles in `zone` for a side.
fn zone_tiles(scoring: &[(i16, i16, u64)], is_creator: bool, z: Zone) -> Vec<(i16, i16)> {
    scoring
        .iter()
        .filter(|t| t.2 != 0 && zone_of(t.1, is_creator) == z)
        .map(|t| (t.0, t.1))
        .collect()
}

/// A side's purposes in a game (all its placed ships, so the assignment
/// doesn't change when one is disabled or destroyed).
pub fn assign_in_game(g: &GameState, is_creator: bool) -> Vec<Assignment> {
    let ships: Vec<PShip> = g
        .board
        .iter()
        .filter(|(_, b)| b.placed && b.is_creator == is_creator)
        .map(|(&id, b)| PShip::from_board(id, b))
        .collect();
    let live = || g.map.scoring.iter().filter(|t| t.points != 0);
    let has_home = live().any(|t| zone_of(t.col, is_creator) == Zone::Home);
    let has_enemy = live().any(|t| zone_of(t.col, is_creator) == Zone::Enemy);
    assign(&ships, has_home, has_enemy)
}

/// Purpose deployment: cells for `ships` (in order) on `map`.
/// - Home ships take the tiles nearest the home scoring tiles.
/// - Center ships spread over the center tiles (one per tile while tiles
///   last, the most durable to the nearest tile) and take the free tile
///   nearest theirs.
/// - The Rush ship takes the free tile nearest an enemy-side tile (with the
///   enemy known: the least defended one).
/// - Support ships take a free tile 1-2 steps from their partner, furthest
///   back of those.
/// Without tiles of a zone, its ships fall back to Center placement.
///
/// `enemy`: the other fleet's ships and cells when they're known, i.e. we
/// deploy second (on chain, a lobby's second fleet is submitted after the
/// first one is readable from contract state; the first fleet moves
/// first). Then every ship also avoids cells the enemy can hit in its
/// first move: a cell where everything that reaches it (move + range)
/// would disable the ship costs as much as 3 extra steps from the target;
/// partial damage costs proportionally less.
pub fn cells(
    content: &Content,
    cfg: &Config,
    map: &str,
    is_creator: bool,
    ships: &[&Ship],
    enemy: Option<(&[&Ship], &[Position])>,
) -> Vec<Position> {
    let tiles = content.deployment_tiles(Some(map), is_creator);
    let scoring: Vec<(i16, i16, u64)> = content
        .maps
        .get(map)
        .map(|m| m.scoring.iter().map(|s| (s.row, s.col, s.points as u64)).collect())
        .unwrap_or_default();
    let ps: Vec<PShip> = ships.iter().map(|s| PShip::from_ship(cfg, s)).collect();
    let home = zone_tiles(&scoring, is_creator, Zone::Home);
    let center = zone_tiles(&scoring, is_creator, Zone::Center);
    let enemy_t = zone_tiles(&scoring, is_creator, Zone::Enemy);
    let asg = assign(&ps, !home.is_empty(), !enemy_t.is_empty());
    let purpose_of = |id: u64| *asg.iter().find(|a| a.id == id).unwrap();
    // The known enemy: (stats, cell).
    let foes: Vec<(PShip, (i16, i16))> = enemy
        .map(|(es, ec)| {
            es.iter()
                .zip(ec)
                .map(|(s, c)| (PShip::from_ship(cfg, s), (c.row, c.col)))
                .collect()
        })
        .unwrap_or_default();
    // Damage the known enemy can put on cell `t` in one move, against
    // damage reduction `dr`.
    let incoming = |t: (i16, i16), dr: u8| -> u32 {
        foes.iter()
            .filter(|(e, c)| manhattan(*c, t) as u32 <= e.movement as u32 + e.range as u32)
            .map(|(e, _)| {
                let g = e.gun_damage as u32;
                g - g * dr as u32 / 100
            })
            .sum()
    };
    let threat = |i: usize, p: &Position| -> i32 {
        if foes.is_empty() {
            return 0;
        }
        let dmg = incoming((p.row, p.col), ps[i].dr);
        let hp = ps[i].max_hp.max(1) as u32;
        if dmg >= hp {
            30
        } else {
            (10 * dmg / hp) as i32
        }
    };

    let d = |p: &Position, t: (i16, i16)| manhattan((p.row, p.col), t) as i32;
    let near = |p: &Position, ts: &[(i16, i16)]| ts.iter().map(|&t| d(p, t)).min().unwrap_or(0);
    // How far back a tile is: distance to the nearest enemy-side tile, or
    // the column for maps without one.
    let back = |p: &Position| {
        if enemy_t.is_empty() {
            if is_creator { -(p.col as i32) } else { p.col as i32 }
        } else {
            near(p, &enemy_t)
        }
    };

    let mut out: Vec<Option<Position>> = vec![None; ships.len()];
    let mut used: Vec<Position> = Vec::new();
    // Takes the free tile minimising (10 * steps(tile) + threat, tiebreak).
    let take = |i: usize,
                key: &dyn Fn(&Position) -> (i32, i32),
                used: &mut Vec<Position>,
                out: &mut Vec<Option<Position>>| {
        let t = tiles
            .iter()
            .filter(|t| !used.contains(t))
            .min_by_key(|t| {
                let (steps, tie) = key(t);
                (10 * steps + threat(i, t), tie, t.row, t.col)
            })
            .cloned();
        if let Some(t) = t {
            used.push(t.clone());
            out[i] = Some(t);
        }
    };
    let idx_of = |p: Purpose| -> Vec<usize> {
        let mut v: Vec<usize> = (0..ships.len())
            .filter(|&i| purpose_of(ps[i].id).purpose == p)
            .collect();
        v.sort_by_key(|&i| (std::cmp::Reverse(ps[i].durability()), ps[i].id));
        v
    };
    let center_or = |z: &Vec<(i16, i16)>| if z.is_empty() { center.clone() } else { z.clone() };
    // Home.
    let home_t = center_or(&home);
    for i in idx_of(Purpose::Home) {
        take(i, &|p| (near(p, &home_t), 0), &mut used, &mut out);
    }
    // Center: spread over the center tiles, nearest tile to the most durable.
    let mut ctiles = if center.is_empty() { enemy_t.clone() } else { center.clone() };
    let dzone = |t: (i16, i16)| tiles.iter().map(|p| d(p, t)).min().unwrap_or(0);
    ctiles.sort_by_key(|&t| (dzone(t), t));
    for (n, i) in idx_of(Purpose::Center).into_iter().enumerate() {
        if ctiles.is_empty() {
            take(i, &|p| (back(p), 0), &mut used, &mut out);
        } else {
            let t = ctiles[n % ctiles.len()];
            take(i, &|p| (d(p, t), 0), &mut used, &mut out);
        }
    }
    // Rush: toward the least defended enemy-side tile when the enemy is
    // known, else the nearest.
    for i in idx_of(Purpose::Rush) {
        let mut rush_t = center_or(&enemy_t);
        if !foes.is_empty() && !enemy_t.is_empty() {
            let least = rush_t.iter().map(|&t| incoming(t, ps[i].dr)).min().unwrap();
            rush_t.retain(|&t| incoming(t, ps[i].dr) == least);
        }
        take(i, &|p| (near(p, &rush_t), 0), &mut used, &mut out);
    }
    // Support: 1-2 steps from the partner, furthest back.
    for i in idx_of(Purpose::Support) {
        let partner = purpose_of(ps[i].id)
            .partner
            .and_then(|pid| ps.iter().position(|x| x.id == pid))
            .and_then(|j| out[j].clone());
        match partner {
            Some(pc) => take(
                i,
                &|p| {
                    let dd = manhattan((p.row, p.col), (pc.row, pc.col)) as i32;
                    (if (1..=2).contains(&dd) { 0 } else { (dd - 2).abs() }, -back(p))
                },
                &mut used,
                &mut out,
            ),
            None => take(i, &|p| (-back(p), 0), &mut used, &mut out),
        }
    }
    out.into_iter()
        .map(|c| c.expect("enough deployment tiles"))
        .collect()
}

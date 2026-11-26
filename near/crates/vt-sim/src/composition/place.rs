//! Deployment placement (Average composition; also the starting point
//! Excellent's search mutates).
//!
//! Since 2026-11-25 `heuristic_cells` is purpose deployment
//! (`purpose::cells`): the range-based heuristic below (`range_cells`) lost
//! 0.410 to random placement on the standard PvP match (Average, 600
//! games), and purpose deployment beat it 0.713. `range_cells` is kept for
//! comparison. Its description:
//!
//! Each ship wants to stand at a distance from the enemy matching its range:
//! the shortest-ranged ships take the most forward tiles, longer-ranged ships
//! stand back by the difference in range. Ships avoid clumping (area
//! specials hit neighbours) and fast ships lean toward scoring tiles.
//! Toughest, shortest-ranged ships are placed first (the front line).

use vt_core::grid::manhattan;
use vt_core::types::{Position, Ship};

use crate::content::Content;
use crate::rules::Config;

/// Cells for `ships` (in order) on `map` for the given side: purpose
/// deployment. `enemy`: the other side's ships and cells when known (we
/// deploy second, or face a fixed AI fleet); None when we deploy blind.
pub fn heuristic_cells(
    content: &Content,
    cfg: &Config,
    map: &str,
    is_creator: bool,
    ships: &[&Ship],
    enemy: Option<(&[&Ship], &[Position])>,
) -> Vec<Position> {
    crate::purpose::cells(content, cfg, map, is_creator, ships, enemy)
}

/// The pre-2026-11-25 range-based placement. `enemy` is where the enemy is
/// or may be (its ships, or its deployment zone).
pub fn range_cells(
    content: &Content,
    cfg: &Config,
    map: &str,
    is_creator: bool,
    ships: &[&Ship],
    enemy: &[Position],
) -> Vec<Position> {
    let tiles = content.deployment_tiles(Some(map), is_creator);
    let scoring = content
        .maps
        .get(map)
        .map(|m| m.scoring.clone())
        .unwrap_or_default();
    let attrs: Vec<_> = ships
        .iter()
        .map(|s| cfg.attributes(s).expect("attributes"))
        .collect();
    let dist = |p: &Position| {
        enemy
            .iter()
            .map(|e| manhattan((p.row, p.col), (e.row, e.col)))
            .min()
            .unwrap_or(0) as f64
    };
    let dmin = tiles.iter().map(dist).fold(f64::INFINITY, f64::min);
    let rmin = attrs.iter().map(|a| a.range).min().unwrap_or(0) as f64;
    let score_pull = |p: &Position| {
        scoring
            .iter()
            .map(|s| s.points as f64 / (1.0 + manhattan((p.row, p.col), (s.row, s.col)) as f64))
            .sum::<f64>()
            / 10.0
    };

    // Front line first: shortest range, then most effective HP.
    let mut order: Vec<usize> = (0..ships.len()).collect();
    let ehp = |i: usize| {
        attrs[i].max_hull_points as f64 / (1.0 - attrs[i].damage_reduction.min(95) as f64 / 100.0)
    };
    order.sort_by(|&a, &b| {
        attrs[a]
            .range
            .cmp(&attrs[b].range)
            .then(ehp(b).partial_cmp(&ehp(a)).unwrap())
            .then(a.cmp(&b))
    });

    let mut cells: Vec<Option<Position>> = vec![None; ships.len()];
    let mut used: Vec<Position> = Vec::new();
    for i in order {
        let target = dmin + (attrs[i].range as f64 - rmin);
        let best = tiles
            .iter()
            .filter(|t| !used.contains(t))
            .map(|t| {
                let adjacent = used
                    .iter()
                    .filter(|u| manhattan((u.row, u.col), (t.row, t.col)) == 1)
                    .count() as f64;
                let s = -(dist(t) - target).abs() - 1.5 * adjacent
                    + 0.2 * attrs[i].movement as f64 * score_pull(t);
                (s, t)
            })
            .fold(None, |acc: Option<(f64, &Position)>, x| match acc {
                Some(a) if a.0 >= x.0 => Some(a),
                _ => Some(x),
            });
        let Some((_, t)) = best else { break };
        used.push(t.clone());
        cells[i] = Some(t.clone());
    }
    cells
        .into_iter()
        .map(|c| c.expect("enough deployment tiles"))
        .collect()
}

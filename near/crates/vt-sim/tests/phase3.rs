//! Phase 3 checks: composers return valid fleets (cap, one variant, owned
//! ships, distinct valid tiles), placement and builds follow the contract's
//! rules, the value model loads, and composition skill orders as expected.

use std::collections::BTreeSet;

use rand::SeedableRng;
use rand_chacha::ChaCha8Rng;
use vt_core::attributes::count_modifications;
use vt_sim::composition::bench::{build_meta, mixed_pool, pve_clear, Player};
use vt_sim::composition::compose::{make, ComposeCtx, Composer, Foe, Lineup, SearchParams};
use vt_sim::composition::modify::{builds, choose_build};
use vt_sim::composition::value::ShipValueModel;
use vt_sim::content::Content;
use vt_sim::eval::Eval;
use vt_sim::rules::{repo_root, Config};
use vt_sim::runner::AiSide;
use vt_sim::tactics::{Level, TacticsConfig};

fn committed() -> (Eval, TacticsConfig, ShipValueModel) {
    (
        Eval::load(&repo_root().join("near/sim/weights/eval.json")).unwrap(),
        TacticsConfig::load(&repo_root().join("near/sim/tactics.json")).unwrap(),
        ShipValueModel::load(&repo_root().join("near/sim/weights/ship_value.json"))
            .expect("fitted ship values are committed"),
    )
}

fn small_search() -> SearchParams {
    SearchParams {
        parents: 3,
        offspring: 3,
        generations: 2,
        opponents: 2,
        validation_opponents: 2,
    }
}

fn assert_valid(
    content: &Content,
    ctx: &ComposeCtx,
    pool: &[vt_core::types::Ship],
    l: &Lineup,
    who: &str,
) {
    assert!(!l.ids.is_empty(), "{who}: empty fleet");
    assert_eq!(l.ids.len(), l.cells.len(), "{who}: ids/cells");
    let ships: Vec<_> = l
        .ids
        .iter()
        .map(|id| {
            pool.iter()
                .find(|s| s.id == *id)
                .unwrap_or_else(|| panic!("{who}: ship {id} not in pool"))
        })
        .collect();
    let cost: u64 = ships.iter().map(|s| s.ship_data.cost as u64).sum();
    assert!(cost <= ctx.cap, "{who}: cost {cost} over cap {}", ctx.cap);
    let variants: BTreeSet<u16> = ships.iter().map(|s| s.traits.variant).collect();
    assert_eq!(variants.len(), 1, "{who}: mixed variants");
    if let Some(v) = ctx.variant {
        assert!(variants.contains(&v), "{who}: wrong variant");
    }
    let ids: BTreeSet<u64> = l.ids.iter().copied().collect();
    assert_eq!(ids.len(), l.ids.len(), "{who}: duplicate ship");
    let tiles = content.deployment_tiles(Some(ctx.map), ctx.is_creator);
    let mut seen = Vec::new();
    for c in &l.cells {
        assert!(tiles.contains(c), "{who}: {c:?} is not a deployment tile");
        assert!(!seen.contains(c), "{who}: duplicate tile");
        seen.push(c.clone());
    }
}

#[test]
fn composers_return_valid_fleets() {
    let (content, cfg) = (Content::load(), Config::load());
    let (eval, _, values) = committed();
    let composers: Vec<Box<dyn Composer>> = Level::ALL
        .iter()
        .map(|&l| make(l, &values, &eval, &small_search()))
        .collect();
    let meta = build_meta(&content, &cfg, &values, 3, 1);
    for seed in 0..3u64 {
        let mut rng = ChaCha8Rng::seed_from_u64(seed);
        let pool = mixed_pool(&cfg, 1, &mut rng);
        // PvP, both sides.
        for (i, map) in content.pvp_maps_all.iter().take(2).enumerate() {
            for creator in [true, false] {
                let cap = vt_sim::composition::bench::CAPS[(seed as usize + i) % 2];
                let ctx = ComposeCtx {
                    content: &content,
                    cfg: &cfg,
                    map,
                    is_creator: creator,
                    cap,
                    max_score: 30,
                    creator_goes_first: true,
                    variant: None,
                    carried: &[],
                    foe: Foe::Meta(&meta[&cap]),
                    survival_weight: 0.0,
                    repair_ships: 0,
                };
                for c in &composers {
                    let l = c.compose(&ctx, &pool, &mut rng);
                    assert_valid(&content, &ctx, &pool, &l, &c.name());
                }
            }
        }
        // PvE against a node's AI fleet, variant fixed.
        let node = &content.sp_nodes[(seed * 7) as usize % content.sp_nodes.len()];
        let ai = AiSide::for_map(&content, &cfg, &node.map);
        let ctx = ComposeCtx {
            content: &content,
            cfg: &cfg,
            map: &node.map,
            is_creator: true,
            cap: node.cost_limit,
            max_score: node.max_score,
            creator_goes_first: true,
            variant: Some(1),
            carried: &[],
            foe: Foe::Ai(&ai),
            survival_weight: 1.0,
            repair_ships: vt_sim::composition::compose::ROGUELIKE_REPAIR_SHIPS,
        };
        for c in &composers {
            let l = c.compose(&ctx, &pool, &mut rng);
            assert_valid(&content, &ctx, &pool, &l, &c.name());
            // Roguelike-style rosters bring repair ships when the pool has
            // them (iteration 2; Poor composition doesn't think about it).
            if c.name() != "poor" {
                use vt_sim::composition::compose::is_repair;
                let available = pool.iter().filter(|s| s.traits.variant == 1 && is_repair(&cfg, s)).count();
                let have = l
                    .ids
                    .iter()
                    .filter(|id| is_repair(&cfg, pool.iter().find(|s| s.id == **id).unwrap()))
                    .count();
                assert!(
                    have >= ctx.repair_ships.min(available).min(l.ids.len()),
                    "{}: {have} repair ships in the roster, {available} available",
                    c.name()
                );
            }
            // Placing a fixed roster keeps exactly those ships on valid tiles.
            let ships: Vec<_> = l
                .ids
                .iter()
                .map(|id| pool.iter().find(|s| s.id == *id).unwrap())
                .collect();
            let cells = c.place(&ctx, &ships, &mut rng);
            assert_valid(
                &content,
                &ctx,
                &pool,
                &Lineup {
                    ids: l.ids.clone(),
                    cells,
                },
                &format!("{} place", c.name()),
            );
        }
    }
}

#[test]
fn builds_follow_drone_yard_rules() {
    let cfg = Config::load();
    let mut rng = ChaCha8Rng::seed_from_u64(4);
    let (_, _, values) = committed();
    for variant in [1u16, 2] {
        let ship = vt_sim::fleet::roll_ship(&cfg, 1, variant, 99, 0);
        let all = builds(&cfg, &ship);
        assert_eq!(
            all.len(),
            4 * 7 * (cfg.max_special_slot[&variant] as usize + 1) * 27
        );
        for b in &all {
            let e = &b.equipment;
            assert!(
                e.armor.index() == 0 || e.shields.index() == 0,
                "armor and shields both set"
            );
            assert!(
                e.main_weapon.index() < 4 && e.armor.index() < 4 && e.shields.index() < 4,
                "unused Future slot"
            );
            assert!(e.special.index() <= cfg.max_special_slot[&variant] as usize);
            assert_eq!(b.traits.variant, variant);
            assert_eq!(b.ship_data.cost, cfg.cost(b).unwrap(), "re-priced");
        }
        for level in Level::ALL {
            if let Some(b) = choose_build(level, &cfg, &values, &ship, 2, &mut rng) {
                let n = count_modifications(&ship, &b);
                assert!((1..=2).contains(&n), "{level:?}: {n} changes");
                if level == Level::Average {
                    assert!(values.value(&cfg, &b) > values.value(&cfg, &ship));
                }
            }
        }
    }
}

/// Composition skill helps against the on-chain AI (Average tactics; fixed
/// seeds, so deterministic). Full numbers: near/sim/composition_bench.json.
#[test]
fn better_composition_clears_more_campaign() {
    let (content, cfg) = (Content::load(), Config::load());
    let (eval, tc, values) = committed();
    let t = tc.make(Level::Average, &eval);
    let poor = make(Level::Poor, &values, &eval, &small_search());
    let avg = make(Level::Average, &values, &eval, &small_search());
    let pp = Player {
        label: "poor".into(),
        composer: poor.as_ref(),
        tactician: t.as_ref(),
    };
    let pa = Player {
        label: "average".into(),
        composer: avg.as_ref(),
        tactician: t.as_ref(),
    };
    let r_poor = pve_clear(&content, &cfg, &pp, 1, 11);
    let r_avg = pve_clear(&content, &cfg, &pa, 1, 11);
    assert!(
        r_avg > r_poor,
        "average composition {r_avg:.3} vs poor {r_poor:.3}"
    );
}

/// Meta fleets come from every PvP map, and zones differ (pvp03 has 16
/// tiles, the default band 44): a fleet too big for this map's opponent
/// zone must never be placed there. Regression: an economy run crashed on it.
#[test]
fn oversized_meta_fleets_are_never_placed() {
    let (content, cfg) = (Content::load(), Config::load());
    let (eval, _, values) = committed();
    let mut rng = ChaCha8Rng::seed_from_u64(5);
    let pool = mixed_pool(&cfg, 1, &mut rng);
    // A 30-ship meta fleet (cheapest ships of a big pool) and one that fits.
    let big: Vec<_> = mixed_pool(&cfg, 700_000, &mut rng)
        .into_iter()
        .filter(|s| s.traits.variant == 1)
        .take(30)
        .collect();
    let small: Vec<_> = big.iter().take(5).cloned().collect();
    let ex = make(Level::Excellent, &values, &eval, &small_search());
    for meta in [vec![big.clone()], vec![big, small]] {
        for creator in [true, false] {
            let ctx = ComposeCtx {
                content: &content,
                cfg: &cfg,
                map: "pvp03",
                is_creator: creator,
                cap: 2000,
                max_score: 30,
                creator_goes_first: true,
                variant: None,
                carried: &[],
                foe: Foe::Meta(&meta),
                survival_weight: 0.0,
                repair_ships: 0,
            };
            let l = ex.compose(&ctx, &pool, &mut rng);
            assert_valid(&content, &ctx, &pool, &l, "excellent vs oversized meta");
        }
    }
}

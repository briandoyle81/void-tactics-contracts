//! Differential test against fixtures exported from the Solidity contracts by
//! scripts/near-golden/exportGolden.ts (GenerateNewShip, DroneNames,
//! ShipAttributes on the ephemeral hardhat network).

use serde_json::Value;
use vt_core::attributes::{calculate, ship_cost};
use vt_core::generation::{generate_ship, ShipNamer};

/// The fixtures were exported with MockOnchainRandomShipNames ("Mock Ship").
/// The real namer is checked against the live contract in golden_ship_names.rs;
/// the name seed it receives is the same one variant-2 drone names use, which
/// these fixtures do verify.
struct MockShipNames;
impl ShipNamer for MockShipNames {
    fn ship_name(&self, _seed: &[u8; 32]) -> String {
        "Mock Ship".into()
    }
}
use vt_core::types::*;

fn golden() -> Value {
    let p = concat!(env!("CARGO_MANIFEST_DIR"), "/../../golden/generation.json");
    serde_json::from_str(&std::fs::read_to_string(p).expect("run scripts/near-golden/exportGolden.ts")).unwrap()
}

fn n(v: &Value) -> u64 {
    match v {
        Value::Number(x) => x.as_u64().unwrap(),
        Value::String(s) => s.parse().unwrap(),
        Value::Bool(b) => *b as u64,
        other => panic!("not a number: {other}"),
    }
}
fn i(v: &Value) -> i64 {
    match v {
        Value::Number(x) => x.as_i64().unwrap(),
        Value::String(s) => s.parse().unwrap(),
        other => panic!("not a number: {other}"),
    }
}
fn u8s(v: &Value) -> Vec<u8> {
    v.as_array().unwrap().iter().map(|x| n(x) as u8).collect()
}

fn attributes_table(v: &Value) -> VariantAttributeData {
    let arr = |k: &str| v[k].as_array().unwrap().clone();
    VariantAttributeData {
        base_hull: n(&v["baseHull"]) as u8,
        base_speed: n(&v["baseSpeed"]) as u8,
        fore_accuracy: u8s(&v["foreAccuracy"]),
        hull: u8s(&v["hull"]),
        engine_speeds: u8s(&v["engineSpeeds"]),
        guns: arr("guns")
            .iter()
            .map(|g| GunData { range: n(&g["range"]) as u8, damage: n(&g["damage"]) as u8, movement: i(&g["movement"]) as i8 })
            .collect(),
        armors: arr("armors")
            .iter()
            .map(|a| ArmorData { damage_reduction: n(&a["damageReduction"]) as u8, movement: i(&a["movement"]) as i8 })
            .collect(),
        shields: arr("shields")
            .iter()
            .map(|a| ShieldData { damage_reduction: n(&a["damageReduction"]) as u8, movement: i(&a["movement"]) as i8 })
            .collect(),
        specials: arr("specials")
            .iter()
            .map(|s| SpecialData { range: n(&s["range"]) as u8, strength: n(&s["strength"]) as u8, movement: i(&s["movement"]) as i8 })
            .collect(),
        rank_thresholds: v["rankThresholds"].as_array().unwrap().iter().map(|x| n(x) as u32).collect(),
        rank_bonus_pct: u8s(&v["rankBonusPct"]),
    }
}

fn costs_table(v: &Value) -> Costs {
    Costs {
        version: n(&v["version"]) as u16,
        base_cost: n(&v["baseCost"]) as u8,
        accuracy: u8s(&v["accuracy"]),
        hull: u8s(&v["hull"]),
        speed: u8s(&v["speed"]),
        main_weapon: u8s(&v["mainWeapon"]),
        armor: u8s(&v["armor"]),
        shields: u8s(&v["shields"]),
        special: u8s(&v["special"]),
    }
}

fn expected_ship(v: &Value) -> Ship {
    let t = &v["traits"];
    let c = &t["colors"];
    let e = &v["equipment"];
    let d = &v["shipData"];
    Ship {
        name: v["name"].as_str().unwrap().to_string(),
        id: n(&v["id"]),
        equipment: Equipment {
            main_weapon: MainWeapon::from_index(n(&e["mainWeapon"]) as usize).unwrap(),
            armor: Armor::from_index(n(&e["armor"]) as usize).unwrap(),
            shields: Shields::from_index(n(&e["shields"]) as usize).unwrap(),
            special: Special::from_index(n(&e["special"]) as usize).unwrap(),
        },
        traits: Traits {
            serial_number: n(&t["serialNumber"]),
            colors: Colors {
                h1: n(&c["h1"]) as u16,
                s1: n(&c["s1"]) as u8,
                l1: n(&c["l1"]) as u8,
                h2: n(&c["h2"]) as u16,
                s2: n(&c["s2"]) as u8,
                l2: n(&c["l2"]) as u8,
            },
            variant: n(&t["variant"]) as u16,
            accuracy: n(&t["accuracy"]) as u8,
            hull: n(&t["hull"]) as u8,
            speed: n(&t["speed"]) as u8,
        },
        ship_data: ShipData {
            ships_destroyed: n(&d["shipsDestroyed"]) as u32,
            shiny: d["shiny"].as_bool().unwrap(),
            ..Default::default()
        },
    }
}

#[test]
fn generation_attributes_and_cost_match_solidity() {
    let g = golden();
    let table = attributes_table(&g["variant1Attributes"]);
    let costs = costs_table(&g["variant1Costs"]);
    let fixtures = g["ships"].as_array().unwrap();
    assert!(fixtures.len() > 600);

    for f in fixtures {
        let variant = n(&f["variant"]) as u16;
        let base = n(&f["randomBase"]);
        let got = generate_ship(n(&f["id"]), n(&f["serial"]), base, variant, 3, &MockShipNames);
        let want = expected_ship(&f["ship"]);
        assert_eq!(got, want, "randomBase {base} variant {variant}");

        if variant == 1 {
            let a = &f["attributes"];
            let want_attrs = Attributes {
                version: n(&a["version"]) as u16,
                range: n(&a["range"]) as u8,
                gun_damage: n(&a["gunDamage"]) as u8,
                hull_points: n(&a["hullPoints"]) as u8,
                max_hull_points: n(&a["maxHullPoints"]) as u8,
                movement: n(&a["movement"]) as u8,
                damage_reduction: n(&a["damageReduction"]) as u8,
                reactor_critical_timer: n(&a["reactorCriticalTimer"]) as u8,
            };
            let got_attrs = calculate(&table, want_attrs.version, &got.stats_input()).unwrap();
            assert_eq!(got_attrs, want_attrs, "attributes for randomBase {base}");
            assert_eq!(ship_cost(&costs, &got).unwrap() as u64, n(&f["cost"]), "cost for randomBase {base}");
        }
    }
}

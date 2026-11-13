//! Shared parsing for golden fixtures exported by scripts/near-golden/*.
#![allow(dead_code)]

use serde_json::Value;
use vt_core::types::*;

pub fn load(name: &str) -> Value {
    let p = format!("{}/../../golden/{name}", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(&p).unwrap_or_else(|_| panic!("missing {p}; run scripts/near-golden exporters")))
        .unwrap()
}

pub fn n(v: &Value) -> u64 {
    match v {
        Value::Number(x) => x.as_u64().unwrap(),
        Value::String(s) => s.parse().unwrap(),
        Value::Bool(b) => *b as u64,
        other => panic!("not a number: {other}"),
    }
}

pub fn i(v: &Value) -> i64 {
    match v {
        Value::Number(x) => x.as_i64().unwrap(),
        Value::String(s) => s.parse().unwrap(),
        other => panic!("not a number: {other}"),
    }
}

pub fn u8s(v: &Value) -> Vec<u8> {
    v.as_array().unwrap().iter().map(|x| n(x) as u8).collect()
}

pub fn attributes_table(v: &Value) -> VariantAttributeData {
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

/// A uint256 given as "0x..." hex, as 32 big-endian bytes.
pub fn u256(v: &Value) -> [u8; 32] {
    let s = v.as_str().unwrap().trim_start_matches("0x");
    let s = format!("{s:0>64}");
    let mut out = [0u8; 32];
    for k in 0..32 {
        out[k] = u8::from_str_radix(&s[2 * k..2 * k + 2], 16).unwrap();
    }
    out
}

/// Bits [offset, offset + width) of a big-endian uint256 (width <= 64).
pub fn bits(w: &[u8; 32], offset: usize, width: usize) -> u64 {
    let mut out = 0u64;
    for b in 0..width {
        let idx = offset + b;
        let byte = w[31 - idx / 8];
        if (byte >> (idx % 8)) & 1 == 1 {
            out |= 1 << b;
        }
    }
    out
}

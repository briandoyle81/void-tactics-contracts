//! Byte-for-byte parity with the Solidity renderer stack: every exported
//! RenderMetadata.tokenURI (and the medal tokenURI) must hash identically.
//! Fixtures: scripts/near-golden/exportRender.ts.

use serde_json::Value;
use sha2::{Digest, Sha256};
use void_renderer::render::{medal_token_uri, token_uri, Names};
use vt_core::types::*;

struct GoldenNames(Vec<(u16, String, u8, String)>);

impl GoldenNames {
    fn get(&self, v: u16, kind: &str, i: u8) -> Option<String> {
        self.0.iter().find(|n| n.0 == v && n.1 == kind && n.2 == i).map(|n| n.3.clone())
    }
}

impl Names for GoldenNames {
    fn main_weapon(&self, v: u16, w: MainWeapon) -> Option<String> {
        self.get(v, "MainWeapon", w as u8)
    }
    fn armor(&self, v: u16, a: Armor) -> Option<String> {
        self.get(v, "Armor", a as u8)
    }
    fn shields(&self, v: u16, s: Shields) -> Option<String> {
        self.get(v, "Shields", s as u8)
    }
    fn special(&self, v: u16, s: Special) -> Option<String> {
        self.get(v, "Special", s as u8)
    }
}

fn n(v: &Value) -> u64 {
    match v {
        Value::Number(x) => x.as_u64().unwrap(),
        Value::String(s) => s.parse().unwrap(),
        Value::Bool(b) => *b as u64,
        o => panic!("{o}"),
    }
}

fn ship(v: &Value) -> Ship {
    let e = &v["equipment"];
    let t = &v["traits"];
    let c = &t["colors"];
    let d = &v["shipData"];
    Ship {
        name: v["name"].as_str().unwrap().into(),
        id: n(&v["id"]),
        equipment: Equipment {
            main_weapon: MainWeapon::from_index(n(&e["mainWeapon"]) as usize).unwrap(),
            armor: Armor::from_index(n(&e["armor"]) as usize).unwrap(),
            shields: Shields::from_index(n(&e["shields"]) as usize).unwrap(),
            special: Special::from_index(n(&e["special"]) as usize).unwrap(),
        },
        traits: Traits {
            serial_number: n(&t["serialNumber"]),
            colors: Colors { h1: n(&c["h1"]) as u16, s1: n(&c["s1"]) as u8, l1: n(&c["l1"]) as u8, h2: n(&c["h2"]) as u16, s2: n(&c["s2"]) as u8, l2: n(&c["l2"]) as u8 },
            variant: n(&t["variant"]) as u16,
            accuracy: n(&t["accuracy"]) as u8,
            hull: n(&t["hull"]) as u8,
            speed: n(&t["speed"]) as u8,
        },
        ship_data: ShipData {
            ships_destroyed: n(&d["shipsDestroyed"]) as u32,
            costs_version: n(&d["costsVersion"]) as u16,
            cost: n(&d["cost"]) as u16,
            modified: n(&d["modified"]) as u16,
            shiny: d["shiny"].as_bool().unwrap(),
            constructed: d["constructed"].as_bool().unwrap(),
            in_fleet: d["inFleet"].as_bool().unwrap(),
            is_free_ship: d["isFreeShip"].as_bool().unwrap(),
            timestamp_destroyed: n(&d["timestampDestroyed"]),
        },
    }
}

fn sha(s: &str) -> String {
    Sha256::digest(s.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

#[test]
fn token_uris_match_solidity_byte_for_byte() {
    let p = concat!(env!("CARGO_MANIFEST_DIR"), "/../../golden/render.json");
    let g: Value = serde_json::from_str(&std::fs::read_to_string(p).expect("run scripts/near-golden/exportRender.ts")).unwrap();
    let names = GoldenNames(
        g["names"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| (n(&x["variant"]) as u16, x["kind"].as_str().unwrap().into(), n(&x["index"]) as u8, x["name"].as_str().unwrap().into()))
            .collect(),
    );
    let cases = g["ships"].as_array().unwrap();
    for (k, c) in cases.iter().enumerate() {
        let got = token_uri(&ship(&c["ship"]), &names);
        if let Some(full) = c["full"].as_str() {
            if got != full {
                let at = got.bytes().zip(full.bytes()).position(|(a, b)| a != b).unwrap_or(got.len().min(full.len()));
                panic!("case {k}: first difference at byte {at}: got ..{}.. want ..{}..", &got[at.saturating_sub(20)..(at + 40).min(got.len())], &full[at.saturating_sub(20)..(at + 40).min(full.len())]);
            }
        }
        assert_eq!(got.len() as u64, n(&c["length"]), "case {k}: length");
        assert_eq!(sha(&got), c["sha256"].as_str().unwrap(), "case {k}: content hash");
    }
    let m = &g["medal"];
    let medal = medal_token_uri(n(&m["tokenId"]));
    assert_eq!(sha(&medal), m["sha256"].as_str().unwrap(), "medal tokenURI");
    eprintln!("{} token URIs + medal byte-identical", cases.len());
}

//! Variant-1 names against vectors read from the live OnchainShipNames
//! contract (near/golden/ship_names.json), including the repo README example.

use vt_core::ship_names::onchain_ship_name;

#[test]
fn matches_the_deployed_contract() {
    let raw = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../golden/ship_names.json")).unwrap();
    let g: serde_json::Value = serde_json::from_str(&raw).unwrap();
    let vectors = g["vectors"].as_array().unwrap();
    assert!(vectors.len() > 100);
    for v in vectors {
        let hex = v["seed"].as_str().unwrap().trim_start_matches("0x");
        let mut seed = [0u8; 32];
        for (i, b) in seed.iter_mut().enumerate() {
            *b = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).unwrap();
        }
        assert_eq!(onchain_ship_name(&seed), v["name"].as_str().unwrap(), "seed {hex}");
    }
}

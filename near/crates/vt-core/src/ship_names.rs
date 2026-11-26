//! Variant-1 ship names: OnchainShipNames + NamesSubset
//! (github.com/briandoyle81/onchain_names), bit-identical to the deployed
//! contract the Solidity game calls (Base Sepolia
//! 0x2b6C2e73D7D8B9dd49aF848B7A19FF003ED0d779; see tests/golden_ship_names.rs).
//!
//! ```solidity
//! newSeed = keccak256(abi.encodePacked(_seed));            // pick a subset
//! subset  = shipNameSubsets[uint256(newSeed) % length];
//! newSeed = keccak256(abi.encodePacked(newSeed));          // pick a name
//! return subset.names[uint256(newSeed) % names.length];
//! ```
//!
//! Inherited quirk, kept for parity: the first entry of subset 0 is the empty
//! string, so about 1 in 22,000 variant-1 ships is named "".

use crate::generation::{mod_u256, ShipNamer};
use crate::random::keccak256;
use crate::ship_names_data::SUBSETS;

pub fn onchain_ship_name(seed: &[u8; 32]) -> &'static str {
    let s1 = keccak256(&[seed]);
    let subset = SUBSETS[mod_u256(&s1, SUBSETS.len() as u64) as usize];
    let s2 = keccak256(&[&s1]);
    subset[mod_u256(&s2, subset.len() as u64) as usize]
}

/// The production namer.
pub struct OnchainShipNames;
impl ShipNamer for OnchainShipNames {
    fn ship_name(&self, seed: &[u8; 32]) -> String {
        onchain_ship_name(seed).to_string()
    }
}

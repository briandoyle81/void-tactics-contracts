//! Randomness derivation.
//!
//! The contract supplies the block VRF seed (`env::random_seed_array()`) read
//! inside a *self-callback receipt* (see `void-tactics::randomness`), never
//! inside the user's own receipt. This module only turns that seed into
//! independent per-request values.

use tiny_keccak::{Hasher, Keccak};

/// keccak256 over the concatenation of `parts`.
pub fn keccak256(parts: &[&[u8]]) -> [u8; 32] {
    let mut k = Keccak::v256();
    for p in parts {
        k.update(p);
    }
    let mut out = [0u8; 32];
    k.finalize(&mut out);
    out
}

/// Derives the 64-bit random base for one request.
///
/// `seed` is the block seed observed by the resolving receipt, `request_id`
/// makes ships minted together in one pack independent, and `nonce` is a
/// contract-wide counter so two resolutions in the same block (same seed) for
/// the same id space still differ.
pub fn derive_random_base(seed: &[u8; 32], request_id: u64, nonce: u64) -> u64 {
    let h = keccak256(&[seed, &request_id.to_be_bytes(), &nonce.to_be_bytes()]);
    // Low 8 bytes, matching Solidity's uint64(uint256(keccak256(...))).
    u64::from_be_bytes(h[24..32].try_into().expect("slice is 8 bytes"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keccak_matches_known_vector() {
        // keccak256("") = c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470
        let h = keccak256(&[]);
        assert_eq!(h[0], 0xc5);
        assert_eq!(h[31], 0x70);
    }

    #[test]
    fn same_inputs_same_output() {
        let seed = [7u8; 32];
        assert_eq!(derive_random_base(&seed, 1, 0), derive_random_base(&seed, 1, 0));
    }

    #[test]
    fn request_id_and_nonce_separate_outputs() {
        let seed = [7u8; 32];
        let a = derive_random_base(&seed, 1, 0);
        assert_ne!(a, derive_random_base(&seed, 2, 0));
        assert_ne!(a, derive_random_base(&seed, 1, 1));
        assert_ne!(a, derive_random_base(&[8u8; 32], 1, 0));
    }
}

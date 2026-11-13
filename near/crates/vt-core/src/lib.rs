//! Pure Void Tactics game rules.
//!
//! Everything in this crate is deterministic and free of any NEAR runtime
//! dependency, so it can be unit-tested with plain `cargo test` and later
//! compiled to WASM for client-side move previews. The `void-tactics`
//! contract is a thin state/auth layer on top of it.
//!
//! Parity rule: each module mirrors a Solidity contract named in its header
//! and must reproduce its behavior exactly (including revert conditions,
//! returned as `Error` variants with the same names), so the Hardhat suite
//! can act as a differential oracle.

pub mod ai;
pub mod attributes;
pub mod effects;
pub mod engine;
pub mod error;
pub mod generation;
pub mod grid;
pub mod maps;
pub mod random;
pub mod ship_names;
mod ship_names_data;
pub mod types;

pub use error::{Error, Result};

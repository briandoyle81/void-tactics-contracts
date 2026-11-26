//! Void Tactics balance simulator. Simulated players (fleet composition and
//! on-board tactics, each at Poor/Average/Excellent) play campaign nodes,
//! roguelike runs and PvP on the real rules (vt-core), and the results are
//! logged for balance analysis. See docs/balance-simulator.md.

// Experiment drivers take many plain parameters by design.
#![allow(
    clippy::too_many_arguments,
    clippy::type_complexity,
    clippy::needless_range_loop
)]

pub mod arena;
pub mod bench;
pub mod calibrate;
pub mod composition;
pub mod content;
pub mod economy;
pub mod eval;
pub mod experiment;
pub mod experiments;
pub mod fleet;
pub mod human_bench;
pub mod log;
pub mod movegen;
pub mod play;
pub mod purpose;
pub mod replay;
pub mod rules;
pub mod runner;
pub mod tactics;
pub mod train;

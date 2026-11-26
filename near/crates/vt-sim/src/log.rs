//! Per-match and per-run records, written as JSONL (one record per line).
//! Records hold only deterministic data (no wall-clock timing), so the same
//! seed and config give byte-identical output.

use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::Path;

use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
pub struct SideLog {
    /// Player label (archetype, or "onchain_ai").
    pub label: String,
    pub tactician: String,
    pub fleet_cost: u64,
    /// Fleet cost at list price (comparable across human and AI fleets).
    pub fleet_list_cost: u64,
    pub ships: usize,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct ShipLog {
    pub id: u64,
    /// 0 = creator, 1 = joiner.
    pub side: u8,
    pub name: String,
    pub variant: u16,
    pub weapon: String,
    pub armor: String,
    pub shields: String,
    pub special: String,
    pub accuracy: u8,
    pub hull: u8,
    pub speed: u8,
    pub kills_rank: u32,
    /// The ship's recorded fleet cost (0 for AI ships, which are unpriced).
    pub cost: u16,
    /// What the ship would cost under the current cost table (AI ships too).
    pub list_cost: u16,
    pub ai_config: Option<String>,
    pub row: i16,
    pub col: i16,
    pub max_hp: u8,
    pub start_hp: u8,
    pub end_hp: u8,
    pub damage_dealt: u32,
    pub damage_taken: u32,
    pub healed: u32,
    pub kills: u32,
    pub moves: u32,
    /// "alive" | "disabled" | "destroyed" | "fled".
    pub outcome: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct MatchLog {
    pub record: &'static str,
    /// "campaign" | "roguelike" | "pvp".
    pub kind: &'static str,
    pub seed: u64,
    pub map: String,
    pub node: Option<String>,
    pub creator: SideLog,
    pub joiner: SideLog,
    /// "creator" | "joiner" | "draw".
    pub winner: &'static str,
    /// "decided" | "round_cap" | "stalled".
    pub end: &'static str,
    pub rounds: u64,
    pub moves: u32,
    pub scores: [u64; 2],
    /// Per side: [pass, shoot, retreat, assist, special, faction].
    pub actions: [[u32; 6]; 2],
    pub ship_logs: Vec<ShipLog>,
    /// The board before the first move (only with move logging on; see
    /// `runner::LOG_MOVES`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_board: Option<vt_core::replay::CompactBoard>,
    /// Every move and the board after it (only with move logging on).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub transcript: Vec<MoveLog>,
}

/// One move of a logged game (`vt-sim replay` prints these).
#[derive(Clone, Debug, Serialize)]
pub struct MoveLog {
    /// 0 = creator, 1 = joiner.
    pub side: u8,
    pub ship: u64,
    /// Pass | Shoot | Retreat | Assist | Special | ... (engine ActionType).
    pub action: String,
    pub to: [i16; 2],
    pub target: u64,
    pub board: vt_core::replay::CompactBoard,
}

#[derive(Clone, Debug, Serialize)]
pub struct RunLog {
    pub record: &'static str,
    pub seed: u64,
    pub label: String,
    pub path: Vec<String>,
    pub combats_won: u32,
    pub won: bool,
    /// Why the run ended: "won" | "lost" | "no_path" | "roster_exceeds_zone".
    pub end: &'static str,
    pub dec_earned: u64,
    pub repair_utc_hp: u64,
    pub ships_lost: Vec<u64>,
    pub granted: Vec<String>,
}

/// Appends serializable records to a JSONL file.
pub struct Jsonl {
    out: BufWriter<File>,
}

impl Jsonl {
    pub fn create(path: &Path) -> std::io::Result<Jsonl> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        Ok(Jsonl {
            out: BufWriter::new(File::create(path)?),
        })
    }

    pub fn write<T: Serialize>(&mut self, rec: &T) -> std::io::Result<()> {
        serde_json::to_writer(&mut self.out, rec)?;
        self.out.write_all(b"\n")
    }

    pub fn flush(&mut self) -> std::io::Result<()> {
        self.out.flush()
    }
}

//! Per-player game history (Game.playerGames / getGamesForPlayer): every
//! game a player took part in, in start order, kept after the game ends so a
//! frontend on any device can list past battles without an indexer.
//!
//! Each entry is a fixed-size (player, index) -> game id row plus a per-player
//! count, charged to that player's storage when the game starts.
//!
//! Added 2026-11-14 as the last root field; `migrate` appends it to state
//! written by earlier code (see lib.rs).

use near_sdk::json_types::U64;
use near_sdk::store::LookupMap;
use near_sdk::{near, AccountId};
use vt_core::engine::Side;

use crate::{Contract, ContractExt, StorageKey};

#[near(serializers = [borsh])]
pub struct PlayerGames {
    pub at: LookupMap<(AccountId, u32), u64>,
    pub count: LookupMap<AccountId, u32>,
}

impl PlayerGames {
    pub fn new() -> Self {
        Self { at: LookupMap::new(StorageKey::PlayerGameAt), count: LookupMap::new(StorageKey::PlayerGameCount) }
    }

    pub fn flush(&mut self) {
        self.at.flush();
        self.count.flush();
    }
}

impl Default for PlayerGames {
    fn default() -> Self {
        Self::new()
    }
}

#[near(serializers = [json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GameMode {
    SinglePlayer,
    PvP,
    Roguelike,
}

#[near(serializers = [json])]
pub struct GameSummary {
    pub game_id: U64,
    pub mode: GameMode,
    pub started_at: u64,
    pub ended: bool,
    pub winner: Option<Side>,
    /// Single-player / roguelike: the campaign node. PvP: the lobby id.
    pub node_or_lobby_id: U64,
}

impl Contract {
    /// Appends `game_id` to `player`'s history. The caller's storage
    /// measurement must cover `player` (use `charged(player, ..)` when the
    /// surrounding call charges someone else).
    pub(crate) fn index_player_game(&mut self, player: &AccountId, game_id: u64) {
        let n = self.player_games.count.get(player).copied().unwrap_or(0);
        self.player_games.at.insert((player.clone(), n), game_id);
        self.player_games.count.insert(player.clone(), n + 1);
    }

    fn summary(&self, game_id: u64) -> Option<GameSummary> {
        let g = self.sp.games.get(&game_id)?;
        let (mode, id) = if let Some(m) = self.sp.matches.get(&game_id) {
            (GameMode::SinglePlayer, m.node_id)
        } else if let Some(m) = self.rl.matches.get(&game_id) {
            (GameMode::Roguelike, m.node_id)
        } else if let Some(p) = self.pvp.games.get(&game_id) {
            (GameMode::PvP, p.lobby_id)
        } else {
            return None;
        };
        Some(GameSummary { game_id: U64(game_id), mode, started_at: g.started_at, ended: g.ended, winner: g.winner, node_or_lobby_id: U64(id) })
    }
}

#[near]
impl Contract {
    /// Game.getGamesForPlayer, paginated in start order (oldest first).
    /// `limit` defaults to 20, max 100. Full boards: `get_game`.
    pub fn get_games_for_player(&self, account_id: AccountId, from_index: Option<u32>, limit: Option<u32>) -> Vec<GameSummary> {
        let n = self.player_games.count.get(&account_id).copied().unwrap_or(0);
        let start = from_index.unwrap_or(0).min(n);
        let end = start.saturating_add(limit.unwrap_or(20).min(100)).min(n);
        (start..end)
            .filter_map(|i| self.player_games.at.get(&(account_id.clone(), i)).and_then(|&id| self.summary(id)))
            .collect()
    }

    pub fn get_player_game_count(&self, account_id: AccountId) -> u32 {
        self.player_games.count.get(&account_id).copied().unwrap_or(0)
    }
}

//! Read-only views for state that Base exposed through public getters
//! (Solidity `public` variables) but the port didn't yet: admin settings,
//! per-player flags and counters, and batch ship reads. Added 2026-11-14.

use near_sdk::json_types::{U128, U64};
use near_sdk::{near, AccountId};

use crate::ships::ShipView;
use crate::{Contract, ContractExt};

/// Every scalar rules/economy setting, one call for the admin screens.
#[near(serializers = [json])]
pub struct GameSettings {
    /// Game.healCapPercent
    pub heal_cap_percent: u8,
    /// ShipsRouter.factionKillReward
    pub faction_kill_reward: U128,
    /// Ships.maxVariant
    pub max_variant: u16,
    /// Ships.paused
    pub mint_paused: bool,
    /// FreeShipClaim.claimCooldownPeriod (seconds) and the base claim size
    pub claim_cooldown_s: U64,
    pub free_claim_base: u32,
    /// Ships.recycleReward (UTC, 18 decimals)
    pub recycle_reward: U128,
    /// ShatteredHiveMedal.finalNodeId
    pub medal_final_node: U64,
    /// Selfie verification gates (FreeShipClaim / TutorialClaim eligibility
    /// providers) and SelfieCheck.nullifierCheckEnabled
    pub free_claim_requires_verification: bool,
    pub tutorial_requires_verification: bool,
    pub nullifier_check_enabled: bool,
    /// Storage sponsorship cap per account (yoctoNEAR)
    pub sponsor_cap_per_account: U128,
    /// RoguelikeResupply.repairCostPerHP (UTC, 18 decimals)
    pub repair_cost_per_hp: U128,
    /// AIEncounters.maxPlacementsPerMap
    pub max_placements_per_map: u32,
    /// Variants whose ships need the hive medal (VariantPurchaseGate)
    pub gated_variants: Vec<u16>,
    /// FactionRewardTokenRegistry: (variant, "utc" | "dec")
    pub reward_tokens: Vec<(u16, String)>,
}

/// Lobbies' public settings.
#[near(serializers = [json])]
pub struct LobbyConfig {
    pub free_games_per_address: u32,
    pub additional_lobby_fee: U128,
    pub reserved_lobby_fee: U128,
    pub max_fleet_cost_limit: u64,
    pub stale_threshold_s: u64,
    pub paused: bool,
}

/// Per-player flags and counters (Base: public mappings on several contracts).
#[near(serializers = [json])]
pub struct PlayerSummary {
    /// Ships.amountPurchased (paid ships; transfers need >= 10)
    pub amount_purchased: U64,
    /// TutorialClaim.tutorialCompleted
    pub tutorial_completed: bool,
    /// SelfieCheck.verifiedUntil (seconds; 0 = never)
    pub verified_until_s: U64,
    /// ShatteredHiveMedal ownership
    pub hive_medal: bool,
    /// Ships.referralCount / ShipPurchaser.referralCount (ships referred)
    pub near_referral_count: U64,
    pub utc_referral_count: U64,
    /// Number of ships owned
    pub ship_count: u32,
}

#[near]
impl Contract {
    pub fn get_settings(&self) -> GameSettings {
        let c = &self.config;
        let variants = 1..=c.max_variant.max(2);
        GameSettings {
            heal_cap_percent: c.heal_cap_percent,
            faction_kill_reward: U128(c.faction_kill_reward),
            max_variant: c.max_variant,
            mint_paused: c.mint_paused,
            claim_cooldown_s: U64(c.claim_cooldown_s),
            free_claim_base: c.free_claim_base,
            recycle_reward: U128(c.recycle_reward),
            medal_final_node: U64(c.medal_final_node),
            free_claim_requires_verification: c.free_claim_requires_verification,
            tutorial_requires_verification: c.tutorial_requires_verification,
            nullifier_check_enabled: c.nullifier_check_enabled,
            sponsor_cap_per_account: U128(c.sponsor_cap_per_account),
            repair_cost_per_hp: U128(self.rl.repair_cost_per_hp),
            max_placements_per_map: self.sp.max_placements_per_map,
            gated_variants: variants.clone().filter(|v| c.gated_variants.get(v).copied().unwrap_or(false)).collect(),
            reward_tokens: variants.filter_map(|v| c.reward_token.get(&v).map(|t| (v, t.id().to_string()))).collect(),
        }
    }

    pub fn get_lobby_config(&self) -> LobbyConfig {
        let p = &self.pvp;
        LobbyConfig {
            free_games_per_address: p.free_games_per_address,
            additional_lobby_fee: U128(p.additional_lobby_fee),
            reserved_lobby_fee: U128(p.reserved_lobby_fee),
            max_fleet_cost_limit: p.max_fleet_cost_limit,
            stale_threshold_s: p.stale_threshold_s,
            paused: p.paused,
        }
    }

    /// None for an unregistered account.
    pub fn get_player_summary(&self, account_id: AccountId) -> Option<PlayerSummary> {
        let a = self.accounts.get(&account_id)?;
        Some(PlayerSummary {
            amount_purchased: U64(a.amount_purchased),
            tutorial_completed: a.tutorial_completed,
            verified_until_s: U64(a.verified_until_s),
            hive_medal: a.hive_medal,
            near_referral_count: U64(self.ship_referrals.get(&account_id).copied().unwrap_or(0)),
            utc_referral_count: U64(self.utc_referrals.get(&account_id).copied().unwrap_or(0)),
            ship_count: a.ship_count,
        })
    }

    /// TutorialClaim.tutorialCompleted.
    pub fn is_tutorial_completed(&self, account_id: AccountId) -> bool {
        self.accounts.get(&account_id).is_some_and(|a| a.tutorial_completed)
    }

    /// ShipGrantWinEffect.hasClaimed: a once-per-address roguelike ship grant
    /// on `node_id` was already paid to `account_id`.
    pub fn is_rl_grant_claimed(&self, node_id: U64, account_id: AccountId) -> bool {
        self.rl.grant_claimed.get(&(node_id.0, account_id)).copied().unwrap_or(false)
    }

    /// Ships.getShipsByIds (unknown ids are skipped; at most 100).
    pub fn get_ships_by_ids(&self, ship_ids: Vec<U64>) -> Vec<ShipView> {
        ship_ids
            .iter()
            .take(100)
            .filter_map(|id| self.ships.get(&id.0).map(|r| ShipView { ship: r.ship.clone(), owner: r.owner.clone() }))
            .collect()
    }
}

// ---------------------------------------------------------------------------
// 2026-11-14, second parity pass: ship stats, previews, batch/count views.

use near_sdk::require;
use vt_core::attributes::{calculate, rank_of};
use vt_core::engine::GameState;
use vt_core::grid::{in_bounds, Bitmap};
use vt_core::types::{Attributes, Position};

/// ShipAttributes.calculateShipAttributesByIds (+ getRank, cost).
#[near(serializers = [json])]
pub struct ShipStats {
    pub ship_id: U64,
    /// Computed with the variant's current attributes version (as fleets do).
    pub attributes: Attributes,
    pub rank: u8,
    pub cost: u16,
    pub costs_version: u16,
    /// False = re-price with `sync_ship_costs` before fleet selection.
    pub costs_current: bool,
}

fn enemy_bitmap(enemy: &[Position]) -> Bitmap {
    let mut b = Bitmap::default();
    for p in enemy {
        require!(in_bounds(p.row, p.col), "InvalidPosition");
        b.set(vt_core::grid::bit_index(p.row, p.col));
    }
    b
}

impl Contract {
    fn live_map(&self, game_id: u64) -> vt_core::maps::GameMap {
        self.sp.games.get(&game_id).map(|g| g.map.clone()).unwrap_or_else(|| near_sdk::env::panic_str("GameNotFound"))
    }
}

#[near]
impl Contract {
    /// Stats for up to 100 human ships (unknown ids skipped).
    pub fn get_ship_attributes(&self, ship_ids: Vec<U64>) -> Vec<ShipStats> {
        ship_ids
            .iter()
            .take(100)
            .filter_map(|id| {
                let s = &self.ships.get(&id.0)?.ship;
                let (version, table) = self.config.current_table(s.traits.variant).ok()?;
                let attributes = calculate(table, version, &s.stats_input()).ok()?;
                let live = self.config.costs.get(&s.traits.variant).map_or(0, |c| c.version);
                Some(ShipStats {
                    ship_id: *id,
                    attributes,
                    rank: rank_of(table, s.ship_data.ships_destroyed as u64),
                    cost: s.ship_data.cost,
                    costs_version: s.ship_data.costs_version,
                    costs_current: s.ship_data.costs_version == live,
                })
            })
            .collect()
    }

    /// ShipAttributes.getRank for a kill count, under the variant's current
    /// attributes version (1-based).
    pub fn get_rank(&self, variant: u16, ships_destroyed: u64) -> u8 {
        let (_, table) = self.config.current_table(variant).unwrap_or_else(|e| near_sdk::env::panic_str(e.name()));
        rank_of(table, ships_destroyed)
    }

    /// ShipAttributes.getLatestAttributesVersion (current may be rolled back
    /// below latest).
    pub fn get_latest_attributes_version(&self, variant: u16) -> u16 {
        self.config.attr_latest.get(&variant).copied().unwrap_or(0)
    }

    // ---- Maps game-scoped previews (Maps.hasMaps, hasMovementPath, ...) ----
    // Same rules the engine applies; `enemy` lists occupied tiles to avoid
    // (exclude the target's own tile for line of sight).

    pub fn has_line_of_sight(&self, game_id: U64, from: Position, to: Position, enemy: Option<Vec<Position>>) -> bool {
        let m = self.live_map(game_id.0);
        let r = match enemy {
            Some(e) => m.has_los_avoiding(from.row, from.col, to.row, to.col, enemy_bitmap(&e)),
            None => m.has_los(from.row, from.col, to.row, to.col),
        };
        r.unwrap_or_else(|e| near_sdk::env::panic_str(e.name()))
    }

    pub fn has_movement_path(&self, game_id: U64, from: Position, to: Position, enemy: Option<Vec<Position>>) -> bool {
        let m = self.live_map(game_id.0);
        let r = match enemy {
            Some(e) => m.has_movement_path_avoiding(from.row, from.col, to.row, to.col, enemy_bitmap(&e)),
            None => m.has_movement_path(from.row, from.col, to.row, to.col),
        };
        r.unwrap_or_else(|e| near_sdk::env::panic_str(e.name()))
    }

    pub fn is_tile_blocked(&self, game_id: U64, row: i16, col: i16) -> bool {
        require!(in_bounds(row, col), "InvalidPosition");
        self.live_map(game_id.0).blocked.has_cell(row, col)
    }

    pub fn is_tile_impassable(&self, game_id: U64, row: i16, col: i16) -> bool {
        require!(in_bounds(row, col), "InvalidPosition");
        self.live_map(game_id.0).impassable.has_cell(row, col)
    }

    /// Maps.isTileScoringSafe: points left on the tile, 0 when out of bounds.
    pub fn get_tile_points(&self, game_id: U64, row: i16, col: i16) -> u8 {
        self.live_map(game_id.0).tile_points(row, col)
    }

    /// Maps.isValidDeploymentTile (preset map; map 0 = default bands).
    pub fn is_valid_deployment_tile(&self, map_id: U64, row: i16, col: i16, is_creator: bool) -> bool {
        let m = if map_id.0 == 0 { vt_core::maps::PresetMap::default() } else { self.sp.map(map_id.0).clone() };
        m.is_valid_deployment_tile(row, col, is_creator)
    }

    // ---- batch and count views ----

    /// Game.getGamesFromIds (up to 10 full boards; unknown ids skipped).
    pub fn get_games(&self, game_ids: Vec<U64>) -> Vec<(U64, GameState)> {
        game_ids.iter().take(10).filter_map(|id| self.sp.games.get(&id.0).map(|g| (*id, g.clone()))).collect()
    }

    /// Game.gameCount: games of every mode share one id space.
    pub fn get_game_count(&self) -> U64 {
        U64(self.sp.game_count)
    }

    /// Lobbies.getLobbiesFromIds (up to 50).
    pub fn get_lobbies(&self, lobby_ids: Vec<U64>) -> Vec<crate::pvp::Lobby> {
        lobby_ids.iter().take(50).filter_map(|id| self.pvp.lobbies.get(&id.0).cloned()).collect()
    }

    pub fn get_lobby_count(&self) -> U64 {
        U64(self.pvp.lobby_count)
    }

    /// Lobbies.isPlayerInLobby.
    pub fn is_player_in_lobby(&self, account_id: AccountId, lobby_id: U64) -> bool {
        self.pvp.player_lobby_pos.contains_key(&(account_id, lobby_id.0))
    }

    /// Lobbies.kickedFromLobby.
    pub fn is_kicked_from_lobby(&self, lobby_id: U64, account_id: AccountId) -> bool {
        self.pvp.kicked.get(&(lobby_id.0, account_id)).copied().unwrap_or(false)
    }

    /// Lobbies.getPlayerTimeoutEnd (seconds; 0 = never kicked).
    pub fn get_player_timeout_end(&self, account_id: AccountId) -> U64 {
        U64(self.timeout_end(&account_id))
    }

    /// NodeMap.getCampaignCompletion: (node id, completed) for each node.
    pub fn get_campaign_completion(&self, account_id: AccountId, campaign_id: U64) -> Vec<(U64, bool)> {
        let c = self.sp.campaigns.get(&campaign_id.0).cloned().unwrap_or_default();
        c.node_ids.iter().map(|&n| (U64(n), self.sp.completed.get(&(account_id.clone(), n)).copied().unwrap_or(false))).collect()
    }

    /// NodeMap.isCampaignFullyCompleted (false for an empty campaign, as on Base).
    pub fn is_campaign_fully_completed(&self, account_id: AccountId, campaign_id: U64) -> bool {
        let v = self.get_campaign_completion(account_id, campaign_id);
        !v.is_empty() && v.iter().all(|x| x.1)
    }

    /// ShipPurchaser.referralStages / referralPercentages: (ships referred,
    /// percent paid) for every stage, shared by NEAR and UTC purchases.
    pub fn get_referral_ladder(&self) -> Vec<(U64, u8)> {
        [0u64, 1_000, 10_000, 50_000, 100_000].iter().map(|&n| (U64(n), vt_core::attributes::referral_pct(n) as u8)).collect()
    }

    /// SelfieCheck.nullifierOwner (hex nullifier hash): the wallet it's bound to.
    pub fn get_nullifier_owner(&self, nullifier_hash: String) -> Option<AccountId> {
        self.nullifiers.get(&crate::shop::parse_hash_pub(&nullifier_hash)).cloned()
    }
}

# EVM → NEAR feature-parity audit

_Written 2026-11-14 (updated the same day: findings 1–10 fixed, see the table). Compares the Solidity contracts in `contracts/` (branch `near-migration-experiment`) with the NEAR port in `near/` as of that date, including the 2026-11-14 parity fixes and replay frames (`near/abi/void_tactics_abi.json`, 182 methods). Both sides change; check the date._

This is the second pass. The first, the same morning, compared method names and found the gaps fixed in `docs/near-pre-audit.md` §10. This pass:
- scans every contract, including renderers, resolvers, win effects and AIs;
- includes functions inherited from OpenZeppelin, which the first pass missed;
- checks behavior constants and defaults;
- checks how far the NEAR tests cover the Hardhat behaviors.

Excluded by decision: Tournament, UTCLotteryHook, World ID. Also excluded because one contract makes them unnecessary: GameEngineRegistry, SinglePlayerOrchestratorRegistry, Create2Deployer.

## Summary

- **Function inventory:** 810 external or public functions and public getters in 96 contracts were each assigned to one of these:

  | Category | Count | Meaning |
  |---|---|---|
  | Same name on NEAR | 123 | |
  | Wiring | 216 | Address setters and getters, allowlists, editor grants. With one contract there's nothing to wire; roles replace the allowlists. |
  | Internal | 89 | One contract calling another (`onGameEnded`, `recordKill`, `setInFleet`, `mint` by an authorized contract, resolvers' `resolveEffect`, AIs' `decide`, …). Now internal Rust calls. |
  | Renderer leaves | 120 | Covered by the byte-identical renderer golden test (192 token URIs plus the medal) |
  | Constants | 26 | Checked below |
  | Randomness redesign | 13 | `RandomManager`, `BlockHashLib`: replaced by self-callback randomness (pre-audit §4) |
  | Reviewed by hand | 223 | **179 are covered.** Most have a NEAR equivalent under another name or as a field of a struct view (list below). A few don't apply: `Ships.locked` is commented-out code the scan picked up, `UniversalCredits.withdrawAll` recovers native tokens sent to the token contract by mistake, and `constructAllMyShips` is replaced by automatic construction. **44 are gaps**, grouped into findings 2, 4, 5 and 7–10 below. |

- **Inherited functions** (OpenZeppelin `Ownable`, `ERC20Burnable`, `ERC20` and `ERC721` metadata): three gaps, findings 1, 3 and 4.
- **Constants and defaults:** all ported values match Base (list below).
- **Test coverage:** the engine, AI and map edge cases that Hardhat tests on purpose are only covered on NEAR where the 16 golden games happen to reach them (finding 6).

## Findings

| # | Gap | Base | NEAR today | Severity | Proposed fix |
|---|---|---|---|---|---|
| 1 | ~~**Ownership can't be transferred**~~ | Every core contract is `Ownable`. The production deploy calls `transferOwnership` (to the map-editor account). | `owner_id` is fixed at `new`. The only way to change it is an `upgrade`, which the current owner must sign. You can't hand the contract to a multisig or rotate a lost or compromised owner key. | **High** | `transfer_ownership(new_owner)` with a two-step accept (`accept_ownership` by the new owner), so a typo can't brick admin. Event: `ownership_transferred`. Fixed 2026-11-14: `transfer_ownership` / `accept_ownership` / `cancel_ownership_transfer` / `get_pending_owner` on both the game and the renderer. Events `ownership_transfer_started` and `ownership_transferred` (game). Roles are kept. `renounceOwnership` is deliberately not offered. The renderer's pending owner is a state field appended with a migration (tested from the exact testnet WASM). |
| 2 | ~~**No mint kill switch for UTC/DEC**~~ | `UniversalCredits` and `DroneEnergyCores` have `setMintIsActive`. With minting off, kill rewards are skipped and UTC purchases revert. | No switch. `set_mint_paused` pauses ship mints only. | Medium | `set_token_mint_active(token, bool)`. While off, `try_mint` returns false, so kill rewards log `reward_skipped` as on Base, and paid UTC mints revert. Fixed 2026-11-14: `set_token_mint_active(token_id, active)` (owner or `PAUSER`), `is_token_mint_active`, event `token_mint_active`. `try_mint` fails while off, so every mint source behaves as on Base. |
| 3 | ~~**Players can't burn their own UTC/DEC**~~ | `ERC20Burnable.burn` / `burnFrom` | Only internal burns (storefront, treasury). There's no player `mt_burn`. | Low | `mt_burn(token_id, amount)` (1 yocto, own balance only), emitting NEP-245 `mt_burn`. Fixed 2026-11-14: `mt_burn(token_id, amount)`. |
| 4 | ~~**No token metadata for UTC/DEC/medal**~~ | ERC-20 `name`/`symbol`/`decimals`; medal ERC-721 `name`/`symbol` | NEP-245 has no metadata view, so wallets and explorers can't show names or decimals. Ships have `nft_metadata`. | Low–medium | The NEP-245 metadata extension: `mt_metadata_contract()`, `mt_metadata_token_all(token_ids)`. Fixed 2026-11-14: the full NEP-245 metadata extension (`mt_metadata_contract`, `mt_metadata_token_all`, `_token_by_token_id`, `_base_by_token_id`, `_base_by_metadata_id`; spec `mt-1.0.0`). DEC shows the 2026-11-11 rename, Drone Computation Cores (DCC); the token id stays `dec`. |
| 5 | ~~**No ship stats view**~~ | `ShipAttributes.calculateShipAttributes(ById/ByIds)`, `calculateShipCost`, `getRank` | A ship's computed range, damage, HP, movement and rank are only visible inside a game board. A fleet builder would have to recompute them client-side from `get_variant_attributes`. | Medium | `get_ship_attributes(ship_ids)` (batch, up to 100) returning the engine's `Attributes` plus rank. Fixed 2026-11-14: `get_ship_attributes(ship_ids)` (attributes, rank, cost, `costs_current`), `get_rank`, `get_latest_attributes_version`. Tested equal to what a fleet puts on the board. |
| 6 | ~~**Engine edge-case coverage**~~ | Game (95), Maps (119), VariantAITrees (68), EffectResolverTargetStatus (12), SpecialVersionPinning (5): about 300 targeted cases | Engine and AI parity rests on 16 golden games (743 steps). Those match Solidity exactly but only on the paths the games happen to take. vt-core has 16 direct unit tests. | Medium (verification, not features) | Differential fuzzing: a Hardhat script generates random boards and moves (specials, rams, LOS corners, disabled targets, scoring, reactor timers) and exports the results; a vt-core test replays them. Cheaper than porting about 300 cases and covers more. Fixed 2026-11-14:
- `scripts/near-golden/exportEngineFuzz.ts` plays 60 randomized games on the Solidity stack: random terrain and scoring maps, 4–8 random AI ships of both factions, 2–6 random human ships, and a random human policy.
- `golden_games.rs::engine_fuzz_matches_solidity` replays them in Rust. All 4,149 steps match the full Solidity state. All 117 moves Solidity rejected are rejected in Rust with the same custom error (`InvalidMove`, `ShipNotOwned`, `ShipAlreadyMoved`, `ShipDestroyed`) and leave the state unchanged.
- **Coverage gap:** the random human never found a legal Assist or human faction-ability move (AI turns exercise both on the AI side). |
| 7 | ~~**Movement/LOS preview views**~~ | `Maps.hasMovementPath(AvoidingShips)`, `hasMaps(AvoidingShips)`, `isTileBlocked/Impassable/Scoring(Safe)`, `isValidDeploymentTile` | None | Low | Either add views, or build vt-core to WASM for the frontend. The plan's preferred route: exact same rules, no RPC round trips. Fixed 2026-11-14 as views on a game's own map: `has_line_of_sight`, `has_movement_path` (each with optional `enemy` tiles to avoid), `is_tile_blocked`, `is_tile_impassable`, `get_tile_points`, `is_valid_deployment_tile`. |
| 8 | ~~**Batch and count views**~~ | `Game.getGamesFromIds`, `gameCount`; `Lobbies.getLobbiesFromIds`, `lobbyCount`, `isPlayerInLobby`, `kickedFromLobby`, `getPlayerTimeoutEnd`; `PvPMatch.gamesStarted`, `RoguelikeRun.runsStarted`, `RoguelikeMatch.matchCount`, `SinglePlayerMatch.nodeMatchCount`; `NodeMap.getCampaignCompletion`, `isCampaignFullyCompleted`; `ShipAttributes.getLatestAttributesVersion`; `ShipPurchaser.referralPercentages/Stages`; `SelfieCheck.nullifierOwner/usedNullifiers`; `Ships.constructShips` (batch) | Each can be derived from existing views with more calls, or is constant. `getPlayerTimeoutEnd` is computed internally but not exposed. | Low | A small batch of views: `get_games(ids)`, `get_lobbies(ids)`, counts, `get_campaign_completion(account, campaign)`, `get_player_timeout_end`, `get_referral_ladder`, `is_kicked(lobby, account)`. Fixed 2026-11-14: `get_games`, `get_game_count`, `get_lobbies`, `get_lobby_count`, `is_player_in_lobby`, `is_kicked_from_lobby`, `get_player_timeout_end`, `get_campaign_completion`, `is_campaign_fully_completed`, `get_referral_ladder`, `get_nullifier_owner` (covers `usedNullifiers` too), `construct_ships`. **Not added:** separate per-mode counters (`gamesStarted`, `runsStarted`, `matchCount`, `nodeMatchCount`). All modes share one game-id space (`get_game_count`), and per-mode totals need new state for analytics only; the replay indexer can count them. |
| 9 | ~~**GameLens one-call views**~~ | `GameLens.getCampaignGraph` (reachable roguelike graph in one call), `getRunView` (run + roster HP + lock/defeat flags) | Possible with several calls (`get_rl_campaign` + `get_rl_node`…, `get_run` + `is_rl_node_*`). | Low | `get_rl_campaign_graph(campaign_id)` and `get_run_view(account)`. Base added these to cut RPC cost; the same reason applies on NEAR. Fixed 2026-11-14: `get_rl_campaign_graph`, `get_run_view`. |
| 10 | ~~**Single-tile edits**~~ | `Maps.setBlockedTile`, `setImpassableTile`, `setScoringTile`; `AIEncounters.setMapPlacement` (one cell) | Only full replaces (`update_preset_map…`, `set_map_placements`) | Low | Optional. The editor already saves whole maps. Fixed 2026-11-14. **Correction:** Base's `setBlockedTile`/`setImpassableTile`/`setScoringTile` edit a **live game's** map (by game id, map editor only, rejected once the game ends), not a preset. Ported as `set_game_blocked_tile`, `set_game_impassable_tile`, `set_game_scoring_tile`, emitting `game_map_edited` so replay indexers keep the terrain. `set_map_placement` edits one AI-placement cell of a preset. |
| 11 | **Variant gate is medal-only** | `VariantPurchaseGate.setRequiredNft` (any NFT contract) and `setExemptMinter` | `set_variant_gated(variant, requires_medal)`: the gate can only be the hive medal. Roguelike grants are exempt, as on Base. | Low (deliberate) | None unless another gate token is planned. |

Not gaps, by design (pre-audit §7):
- ERC-721/ERC-20 approvals (`approve`, `setApprovalForAll`, `transferFrom`, `allowance`): spends are internal debits on NEAR, and ship transfers are owner-only.
- `constructAllMyShips`: ships construct automatically.
- The Uniswap lottery and tournaments.
- Variable AI-ship slots (`AIShips.allocateShip`/`releaseShips`): AI ships live inside each game.

## Constants and defaults (match)

| Item | Base | NEAR |
|---|---|---|
| Grid | 17 × 11 | 17 × 11 |
| Default deployment columns | creator 0–3, joiner 13–16 | same |
| PvP turn time | 60 s – 24 h | same |
| Kick penalty | 1 h per kick | same |
| Selfie verification validity | 90 days | same |
| AI kill-count cap | 1,000,000 | same |
| AI ship id offset | 2^40 | same |
| Heal cap | 80% | 80% |
| Free claim | 10 ships, 28-day cooldown | same |
| Recycle reward | 0.1 UTC | same |
| Faction kill reward | 1 | 1 (seeded from Base's config) |
| Lobby defaults | 1 free lobby; 1 UTC additional / reserved fee; 2000 max fleet cost; 7-day stale | same |
| Repair cost | 0.01 UTC per HP | same |
| `Lobbies.MIN_TIMEOUT` | 300 s, declared but never used | not ported (dead code on Base) |
| `ENGINE_ID_BLOCK_SIZE`, game-id offsets, `CAPTURE_PER_CALL` | | not needed (one contract; no blockhash capture) |

## Reviewed by hand: renamed or folded into struct views (179 covered)

Every target below was checked against the NEAR ABI.

- **AIEncounters:**
  - `aiShipConfigCount` → `get_ai_config_count`
  - `getAIShipConfigsPaginated` / `getAllAIShipConfigs` → `get_ai_ship_configs`
  - `mapHasPlacements` / `mapPlacementCount` → `get_map_placements`
- **Win effects:**
  - `DECBonusWinEffect.bonusAmount`, `HealAboveFloorWinEffect.healToPercent` → per-node `WinEffect` values in `get_rl_node(..).win_effects`, set by `set_rl_node_win_effects`
  - `ShipGrantWinEffect.getGrant` / `hasGrant` / `setGrant` / `clearGrant` → the same; `hasClaimed` → `is_rl_grant_claimed`; `resetClaim` → `reset_rl_grant_claim`
- **DroneStorefront:**
  - `addTier` → `add_storefront_tier`
  - `tierCoreCost` → `get_storefront_tiers`
  - `droneCoreTier` → `get_claim_status`
- **Resolvers:** `range` / `strength` / `setRange` / `setStrength` / `slot` → `get_faction_resolver` / `get_special_resolver` / `set_faction_resolver` / `set_special_resolver` (resolver values carry their parameters)
- **DroneYard:**
  - `calculateCostToModify` → `get_modification_cost`
  - `burnCollected` / `withdraw` → `burn_collected_utc` / `withdraw_utc` (one treasury)
- **Fleets:** `getFleet` / `getFleetShipIdsAndPositions` / `isShipInFleet` / `fleetCount` → `get_lobby_fleet`, `get_sp_match.human_fleet`, `get_run.reservation`, `get_ship(..).ship_data.in_fleet`
- **FreeShipClaim:** `claimCooldownPeriod` / `lastClaimTimestamp` / `setClaimCooldownPeriod` → `get_settings`, `get_claim_status`, `set_claim_config`
- **Game:**
  - `getGameMetadataAndTurnState` / `getAllShipPositions` / `getAIBoard` / `getShipPosition` / `getShipAttributes` (in-game) → `get_game`
  - `playerGames` → `get_games_for_player`
  - `factionAbilityResolvers` / `specialResolvers` / `setFactionAbilityResolver` → resolver views and setters
- **GameBlobRegistry / GameResults:** `blobs` → `get_blob`; `isGameResultRecorded` → `get_game_result`
- **GameLens:** `getShipsOwned` → `get_ships_for_owner`
- **Lobbies:**
  - fee, cost-cap, stale and pause getters and setters → `get_lobby_config` / `set_lobby_config` / `set_lobbies_paused`
  - `getOpenLobbiesPaginated` → `get_open_lobbies`
  - `getPlayerState` → `get_player_lobby_state`
  - `lobbies` / `lobbyOpenedAt` → `get_lobby`
  - `getPlayerLobbyCount` → `get_player_lobbies`
  - `isLobbyOpenForJoining` → `is_lobby_open` + `get_lobby`
  - `withdraw` → `withdraw_utc`
- **Maps:**
  - `createFullPresetMap` / `createPresetScoringMap` → `create_preset_map`
  - `getAllPresetMaps(Ids)` → `get_preset_maps`
  - zone, impassable and scoring getters plus `presetScoringMaps` / `presetOnlyOnceMaps` → `get_preset_map` fields
  - `mapExists` → `get_preset_map` (null)
  - `setCreatorZone` / `setJoinerZone` → `set_deployment_zones`
- **NodeMap:**
  - `campaignExists` / `getNodesInCampaign` → `get_campaign`
  - `getPrerequisites` → `get_node`
  - `completedNodes` → `is_node_completed`
- **RenderMetadata:** name getters and setters → renderer `get_name` / `set_names`
- **Roguelike:**
  - `RoguelikeMatch` per-game getters → `get_rl_match`
  - `RoguelikeNodeMap` campaign getters and setters → `get_rl_campaign` / `set_rl_campaign`
  - `addChild` / `removeChild` → `add_rl_child` / `remove_rl_child`
  - `getChildren` / `getNodeWinEffects` → `get_rl_node`
  - `RoguelikeRun.getRosterHP` / `hasActiveRun` → `get_run`; `getShipHP` → `get_run_ship_hp`
  - `RoguelikeResupply.withdraw` → `withdraw_utc`
- **SelfieCheck:** `verifiedUntil` → `get_player_summary`; `nullifierCheckEnabled` / `setNullifierCheckEnabled` → `get_settings` / `set_verification_requirements`
- **ShatteredHiveMedal:**
  - `finalNodeId` / `setFinalNodeId` → `get_settings` / `set_medal_final_node`
  - `nextTokenId` → `mt_supply("hive_medal")`
  - `ownerMint` → `owner_mint_medal`
- **ShipAttributes:**
  - `costsByVariant` / `getCurrentCostsVersion` → `get_costs`
  - gun, armor, shield and special data, `getSpecialRange/Strength(At)` → `get_variant_attributes`
  - `setVariantAttributes` → `publish_variant_attributes`
- **ShipPurchaser / Ships:**
  - `purchaseWithFlow` → `purchase_ships_with_near`
  - `purchaseWithUTC` → `purchase_ships_with_utc`
  - `purchaseUTCWithFlow` → `buy_utc_with_near`
  - price getters and setters → `get_price_tiers` / `set_price_tiers`
  - `referralCount` / `amountPurchased` → `get_player_summary`
  - `withdrawFlow` / `withdraw` → `withdraw_near`; `burnCollected` → `burn_collected_utc`
  - `shipBreaker` → `recycle_ships`
  - `createShips` → `create_ships_for`
  - `getShipIdsOwned` / `shipIdOwnedAt` / `shipsOwnedCount` → `get_ships_for_owner` / `nft_supply_for_owner`
  - `isShipDestroyed` → `get_ship`
  - `paused` / `setPaused` → `get_settings` / `set_mint_paused`
  - `setConfig` → `set_render_config` and the rule setters
  - `shipCount` → `nft_total_supply`
- **TutorialClaim:** `completeTutorialWinPath` / `LossPath` → `complete_tutorial(win_path)`

## Coverage: why case-by-case test parity couldn't be checked mechanically

Plan §5.2 said ported Hardhat cases would keep their names 1:1, so coverage could be diffed. The port shortened the names instead, and a name match finds 1 of 854 non-dropped cases.

NEAR has about 260 tests against Hardhat's 854:
- Contract flows (economy, lobbies, roguelike, tutorial, medal, verification, storefront) are ported case by case under shorter names: 224 contract unit tests.
- Engine, map and AI behavior relies on the golden differential suites (finding 6).

Spot check: campaign unlocking ("unlocks when ANY prerequisite is completed") matches Base in the code, but no NEAR test exercises it.

## Recommended order

1. Finding 1 (ownership transfer), before any mainnet deploy.
2. Findings 2 and 5 (mint kill switch; ship stats view).
3. Finding 6 (differential fuzz of the engine), the main remaining verification risk.
4. Findings 3, 4, 8 and 9 together as one batch of small views and methods.
5. Findings 7, 10 and 11 only if the frontend or design needs them.

Size budget: the game WASM is 1.345 MB, about 155 KB under the 1.5 MB transaction cap that `upgrade` uses (pre-audit §3). Items 1–5 are small, but the staged-upload plan for upgrades should land before the contract grows much more.

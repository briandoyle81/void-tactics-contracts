# Frontend handoff: NEAR parity additions

_Written 2026-11-14 for the frontend agent (updated the same day: replay through an indexer, §7; second parity pass, §8). It answers the "known gaps until the contract adds methods" list and describes `game.void-tactics.testnet` as upgraded on 2026-11-14 (code SHA-256 `9c2266118e7b7eafa649c57cbf0c6ef74bbcd431202824bd4a9783a9dd145e48`; upgraded again at 16:41 UTC to `e1ead8a222d09350778c55ba4eb1ad42334b9616f76670a09345001545483521`, with replay frames and the second parity pass, §7–8). Read it alongside [`near-frontend-handoff-2026-11-13.md`](near-frontend-handoff-2026-11-13.md), which covers everything else. Contracts change; check the date._

**What changed on testnet**
- The game contract was upgraded in place through the owner's `upgrade`. Its state was migrated, not wiped: accounts, ships, balances and seeded content are unchanged, and ids didn't move.
- The renderer is unchanged.
- The exact types for every method below are in `near/abi/void_tactics_abi.json`, which has been regenerated.

**Switch RPC endpoints.** `https://rpc.testnet.near.org` is deprecated and now rate-limits hard (HTTP 429, "this endpoint is deprecated"). Use `https://test.rpc.fastnear.com` or another provider.

## Changes since the first version of this doc (2026-11-14)

Everything below is **live on testnet** since 16:41 UTC: game `e1ead8a2…`, renderer `bcd705aa…`. State was migrated in place, so ids and test accounts are unchanged.

| When | What | Where |
|---|---|---|
| Morning | Parity additions: card-checkout minter, admin edits, battles list, player and settings views, deployment record, `sync_ship_costs` | §1–6 |
| Midday | Replay through an indexer: every event that changes a game carries the whole board | §7 |
| Afternoon | Second parity pass: ship stats, token metadata (DEC now shows as **DCC**), `mt_burn`, mint switches, move previews, batch/count/lens views, two-step ownership, live-game map edits (indexers must apply `game_map_edited`) | §8 |
| 16:41 UTC | The **hive medal is claimable**: its final campaign node (`f06`, id 30) was missing from the NEAR seed and is now set, as on Base | — |
| 16:41 UTC | Regenerated ABIs: `near/abi/void_tactics_abi.json` (221 methods), `near/abi/void_renderer_abi.json` (15) | — |

**Content note (same on Base):** only 18 of the roguelike campaign's 35 nodes are reachable from its root. `get_rl_campaign_graph` returns those 18. The other 17 have no incoming edges in `roguelikeStarterContent.json`.

## Your gap list, item by item

| Your gap | Status |
|---|---|
| Card checkout: no mint method for the server | **Added:** `create_ships_for`. See §1. |
| Admin: saved maps can't change terrain; campaign nodes can't be edited; AI configs are create-only | **Added:** update methods for maps, nodes, prerequisites, AI configs and roguelike nodes. See §2. |
| Battles list can't show finished games from another device | **Added:** `get_games_for_player`. See §3. |
| Replay only covers moves this device saw | **Decided: an indexer** (2026-11-14). Every event that changes a game now carries the whole board, so an indexer that stores the events has full replays. See §7. Live on testnet since the 2026-11-14 16:41 UTC upgrade. |
| Tutorial and reward-ship "claimed" tracked per device | **Added:** `is_tutorial_completed`, `is_rl_grant_claimed`, `get_player_summary`. See §4. |
| Admin settings with no getter | **Added:** `get_settings`, `get_lobby_config`, plus counts and lists. See §4. |
| Map and node ids come from the Base Sepolia record | **Added:** `near/deployments/testnet.json`. See §5. |

**New requirement: re-pricing ships after a cost update.** It isn't on your list, but you need to handle it: see §6.

## 1. Card checkout: `create_ships_for`

```
create_ships_for({ to, amount, variant, tier, is_free }) -> U64[]   // payable
```

- **Who can call it:** the server account that holds the `MINTER` role (`role_bits` 4; the owner grants it with `set_role({account_id, role_bits: 4})`), or the owner. This replaces Base's `Ships.createShips` called by `FIREBASE_FLOW_MINTER`.
- **What it mints:** the same as Base. `amount` ships of `variant` go to `to`.
  - A paid mint (`is_free: false`) gives the first `tier + 1` ships ranks `tier + 1` down to 1, and adds `amount` to the buyer's purchase count. The purchase count gates ship transfers.
  - `is_free: true` marks the ships free.
- **Storage:**
  - Attach NEAR to pay for the buyer's storage. About 0.003 NEAR per ship is a safe rule of thumb, e.g. 0.2 NEAR for 60 ships. The buyer needs no NEAR and doesn't even need to be registered; the call registers them.
  - The attached NEAR is credited as **sponsored**: it can be spent on storage but never withdrawn by the player.
  - If the deposit plus any existing balance can't cover the new bytes, the call fails with `InsufficientStorageBalance`. Nothing is minted.
- **Afterwards:** ships construct automatically within a block or two, as with every other mint. Watch for `nft_mint` with memo `"minter"`.
- **Testnet:** no server account has the role yet. Tell the owner which account your server signs with.

## 2. Admin editing

All of these need the owner or an editor role: `MAP_EDITOR` (`role_bits` 1) for maps and AI configs, `NODE_EDITOR` (`role_bits` 2) for nodes and campaigns.

**Editing never changes a match in progress.** Each game keeps its own copy of its map and AI fleet, as on Base.

| Method | Base equivalent | Notes |
|---|---|---|
| `update_preset_map({map_id, blocked})` | `Maps.updatePresetMap` | Full replace of line-of-sight-blocking tiles |
| `update_preset_map_impassable({map_id, impassable})` | `updatePresetMapImpassable` | Full replace |
| `update_preset_scoring_map({map_id, scoring})` | `updatePresetScoringMap` | Full replace |
| `set_map_mode({map_id, mode})` | `setMapMode` | `"PvP"`, `"PvE"` or `"Both"` |
| `update_full_preset_map({map_id, blocked, impassable, scoring, mode})` | (NEAR only) | One call for a whole map-editor save. Deployment zones are kept; change them with `set_deployment_zones`. |
| `update_ai_ship_config({config_id, config})` | `AIEncounters.updateAIShipConfig` | Same validation as create |
| `update_node({node_id, node})` | `NodeMap.updateNode` | `node` has the same shape as `create_node`'s. Changing `campaign_id` moves the node between campaigns. |
| `add_prerequisite({node_id, prerequisite_id})`, `remove_prerequisite(...)` | same | |
| `set_campaign_required_variant({campaign_id, variant})` | same | |
| `update_rl_node({node_id, campaign_id, kind, map_id, turn_time, max_score, creator_goes_first, cost_cap_override})` | `RoguelikeNodeMap.updateNode` | Children and win effects are kept; they have their own setters. |

**Lists for the admin screens:**
- `get_preset_maps({from_index, limit})` and `get_ai_ship_configs({from_index, limit})` return `[id, item]` pairs. `limit` defaults to 20, with a maximum of 100.
- `get_campaign_count()`, `get_node_count()`, `get_max_placements_per_map()`.

## 3. Battles list: `get_games_for_player`

```
get_games_for_player({ account_id, from_index, limit }) -> GameSummary[]
GameSummary = { game_id, mode: "SinglePlayer" | "PvP" | "Roguelike", started_at, ended, winner: "Creator" | "Joiner" | null, node_or_lobby_id }
```

- Every game the player took part in, oldest first, **including finished ones**. This is Base's `Game.getGamesForPlayer`.
- `get_player_game_count({account_id})` gives the total, for paging.
- For the full board, call `get_game({game_id})`.
- The human player is always `Creator` in single-player and roguelike games.
- **Not listed:** games started before the 2026-11-14 upgrade. On testnet that's none: p1's test match was started after it.
- **Storage:** each player pays for their own history row, about 100 bytes per game, from their storage balance.

## 4. Player flags and settings

- **`get_player_summary({account_id})`** returns `null` for an unregistered account. Otherwise:

  | Field | What it is |
  |---|---|
  | `amount_purchased` | paid ships; transfers need at least 10 |
  | `tutorial_completed` | |
  | `verified_until_s` | Selfie verification expiry, in seconds |
  | `hive_medal` | |
  | `near_referral_count`, `utc_referral_count` | |
  | `ship_count` | |

- **`is_tutorial_completed({account_id})`** is Base's `TutorialClaim.tutorialCompleted`.
- **`is_rl_grant_claimed({node_id, account_id})`** is Base's `ShipGrantWinEffect.hasClaimed`: whether a once-per-player ship grant on a roguelike node has been paid out.
- **`get_settings()`** returns every rules and economy setting in one call:

  | Setting | Field |
  |---|---|
  | Heal cap, kill reward, max variant | `heal_cap_percent`, `faction_kill_reward`, `max_variant` |
  | Minting paused | `mint_paused` |
  | Free claims | `claim_cooldown_s`, `free_claim_base` |
  | Recycling | `recycle_reward` |
  | Medal | `medal_final_node` |
  | Verification switches | `free_claim_requires_verification`, `tutorial_requires_verification`, `nullifier_check_enabled` |
  | Sponsorship | `sponsor_cap_per_account` |
  | Roguelike repairs | `repair_cost_per_hp` |
  | AI placements | `max_placements_per_map` |
  | Gated variants | `gated_variants` |
  | Reward token per variant | `reward_tokens` (pairs) |

- **`get_lobby_config()`** returns `free_games_per_address`, `additional_lobby_fee`, `reserved_lobby_fee`, `max_fleet_cost_limit`, `stale_threshold_s` and `paused`.
- **`get_ships_by_ids({ship_ids})`** is a batch `get_ship` for up to 100 ids. Unknown ids are skipped.
- **Changed: `storage_balance_of(...).available`** now means withdrawable. It excludes sponsored or minter-funded NEAR, which can be spent on storage but not withdrawn. Show it as "withdrawable", not as "can afford N more ships".

## 5. Deployment record: `near/deployments/testnet.json`

This is the NEAR counterpart of Ignition's deployment record plus the seed ids. Point the seed export here instead of the Base Sepolia record.

```jsonc
{
  "written_at": "2026-11-14T15:28:15Z",
  "network": "testnet",
  "game": "game.void-tactics.testnet", "renderer": "art.void-tactics.testnet", "owner": "void-tactics.testnet",
  "code_sha256": { "<account>": "<hash read from chain>" },
  "single_player": { "maps": {"m01": 1, ...}, "ai_configs": {"grunt": 1, ...}, "nodes": {"m01": 1, ...}, "campaign_id": 1 },
  "roguelike":     { "maps": {"rlM01": 31, ...}, "ai_configs": {...}, "nodes": {"m01": 1, ...}, "campaign_id": 1 },
  "pvp_maps": { "pvp01": 67, ... }
}
```

- **Keys** are the content keys from `ignition/data/*.json`.
- **Namespaces:** maps and AI configs share one id space across single-player and roguelike, as on Base. The roguelike section includes the single-player maps and configs it reuses. Node ids are separate per mode.
- **Checked against chain:** the deploy tool writes the file only after reading each id back. It checks each map's mode and scoring tiles, each AI config's name and variant, each node's map and settings, and the campaigns' wiring (203 checks on testnet).
- **Regenerating** after any deploy or upgrade:
  ```
  cargo run -p integration-tests --bin deploy -- --network testnet --rpc https://test.rpc.fastnear.com \
    --game game.void-tactics.testnet --renderer art.void-tactics.testnet --owner void-tactics.testnet --record-only
  ```
  Run it from `near/`.

## 6. New requirement: re-pricing ships after a cost update

When the owner publishes a new cost table, existing ships keep their old price and cost version. Fleets reject them with `ShipCostVersionMismatch` until they're re-priced. This is the same as Base.

- **`sync_ship_costs({ship_ids})`** re-prices the caller's own ships (Base's `syncShipCosts`).
  - It needs no deposit and works with a session key.
  - It rejects ships that aren't the caller's (`NotYourShip`) and ships currently in a fleet (`ShipInFleet`).
- **Suggested UX:**
  1. Compare each ship's `ship_data.costs_version` with `get_costs({variant}).version`.
  2. If any differ, offer "update ship prices", which calls `sync_ship_costs` with those ids.
  3. Do this before fleet selection.
- **Owner fallback:** the owner can re-price any single ship with `set_cost_of_ship({ship_id})`.

No cost update has been published on testnet yet, so nothing is affected today.

## 7. Replay through an indexer (2026-11-14)

The owner chose an indexer over an on-chain move log. Base had no on-chain move list either; it read event logs, and NEAR RPC can't search logs or serve past state.

**What the contract guarantees:** every event that changes a game carries the whole board after the change, in a compact form. A replay is the list of these frames in order. Each frame stands alone, so you never re-run game rules, and a missed or reordered event can't corrupt later frames.

**The frame** (`vt_core::replay::CompactBoard`):

```jsonc
{ "turn": "Creator" | "Joiner", "round": 3, "scores": [creatorScore, joinerScore],
  "ended": false, "winner": null | "Creator" | "Joiner",
  "ships": [[id, side, row, col, hp, status], ...] }
```

- **`side`:** 0 is the creator (the human in single-player and roguelike), 1 is the joiner.
- **`status`:** 0 alive, 1 destroyed, 2 fled.
- **Which ships:** every ship that entered the game, in id order, including removed ones.
- **Ids** are below 2^53, so they're exact as JS numbers. They're also plain numbers here, unlike the string ids elsewhere.
- **Size:** about 620 bytes for the largest seeded board (22 ships).

**Where frames appear** (all standard `void_tactics` events):

| Event | Frames |
|---|---|
| `game_board` with `reason: "start"` | The initial board, plus `fleet: [[id, side, variant, max_hp], ...]` (facts that don't change during the game) |
| `move` | `board` after the move (alongside `last_move`) |
| `ai_turns` | Each entry in `turns` has a `board` after that AI move; the event's own `board` is the state after the whole call. That last one also covers the AI conceding without moving. |
| `game_board` with `reason: "forfeit"`, `"flee"`, `"timeout"` or `"retreat"` | The final board of a game ended outside a move |

**Indexer sketch:**
1. Follow blocks from a block API (e.g. FastNEAR's `neardata.xyz`, or NEAR Lake).
2. Keep receipts whose receiver is `game.void-tactics.testnet`.
3. Read `EVENT_JSON:` logs with `standard == "void_tactics"`.
4. For the events above, append `{block_height, receipt_id, game_id, frame}` to a per-game list.
5. Serve `GET /replay/<game_id>`.

Frames for one game arrive in order, because each comes from one contract's receipts and a game changes one transaction at a time. For metadata, use the `move` event's `last_move` (ship, from and to, action, target) to animate between frames.

**Verified:** `near/tests/tests/phase7_replay.rs` plays a whole 22-ship game (58 transactions) using only the logs, and checks after every transaction that the latest logged frame equals `get_game`. The golden-game suite also checks that after every AI move across 743 steps, the logged frame equals the state verified against Solidity. The largest receipt in that game logged 6.2 KB; NEAR's cap is 16 KB.

**Gas:** frames add about 4 Tgas to `take_ai_turns(8)` on the heaviest board (10 to 14 Tgas). Moves and starts each go up by 1–2 Tgas. Use the same gas limits as before.

## 8. Second parity pass (2026-11-14)

From `docs/near-evm-parity-audit-2026-11-14.md`. **Live on testnet** since the 2026-11-14 16:41 UTC upgrade (game `e1ead8a2…`, renderer `bcd705aa…`). Exact types are in the regenerated ABI.

**Ship stats (fleet builder):**
- `get_ship_attributes({ship_ids})` covers up to 100 ships. Each entry is `{ ship_id, attributes: { range, gun_damage, hull_points, movement, damage_reduction, … }, rank, cost, costs_version, costs_current }`.
  - These are the numbers a fleet puts on the board, computed with the current attributes version.
  - `costs_current: false` means call `sync_ship_costs` before fleet selection (§6).
- `get_rank({variant, ships_destroyed})` and `get_latest_attributes_version({variant})`.

**Tokens:**
- NEP-245 metadata for wallets and explorers: `mt_metadata_contract()` and `mt_metadata_token_all({token_ids})`, plus the `_by_token_id` and `_base_` variants.
  - UTC: "Universal Time Credits", 18 decimals.
  - DEC: "Drone Computation Cores", symbol **DCC**, 0 decimals. The token id stays `"dec"`.
  - Medal: "Shattered Hive Campaign Medal".
- `mt_burn({token_id, amount})` burns the caller's own UTC or DEC; attach 1 yocto.
- `is_token_mint_active({token_id})`. When it's false, purchases of UTC with NEAR and recycling fail with `MintFailed`, and kill rewards are skipped, as on Base.

**Move previews**, on a live game's own map. These are Base's `Maps` previews: straight-line checks with permissive corners, not pathfinding.
- `has_line_of_sight({game_id, from, to, enemy?})`
- `has_movement_path({game_id, from, to, enemy?})`. `enemy` is an optional list of occupied tiles to avoid.
- `is_tile_blocked`, `is_tile_impassable`, `get_tile_points({game_id, row, col})`
- `is_valid_deployment_tile({map_id, row, col, is_creator})`, where `map_id: "0"` means the default deployment bands.

**One-call views:**
- `get_run_view({account_id})` returns `{ run, roster_hp: [[ship_id, hp]], nodes: [{node_id, locked, defeated}] }`.
- `get_rl_campaign_graph({campaign_id})` returns every reachable node, root first.
- `get_games({game_ids})` (up to 10 full boards) and `get_lobbies({lobby_ids})` (up to 50).
- `get_campaign_completion({account_id, campaign_id})` and `is_campaign_fully_completed`.

**Small views:**
- `get_game_count`, `get_lobby_count`
- `is_player_in_lobby`, `is_kicked_from_lobby`, `get_player_timeout_end`
- `get_referral_ladder`, which returns `[[ships_referred, percent], …]`
- `get_nullifier_owner({nullifier_hash})`

**Ships:** `construct_ships({ship_ids})` (up to 50) finishes several ships the randomness callback had to skip.

**Admin:**
- Ownership: `transfer_ownership({new_owner})`, then the nominee calls `accept_ownership()`. Also `cancel_ownership_transfer`, `get_pending_owner`. The renderer has the same methods.
- `set_token_mint_active({token_id, active})` (owner or `PAUSER`).
- `set_map_placement({map_id, position, config_id})` edits one AI cell; `config_id: "0"` clears it.
- Live-game hotfixes, as on Base (map editor only, rejected once the game ends): `set_game_blocked_tile`, `set_game_impassable_tile` and `set_game_scoring_tile({game_id, row, col, …})`.
  - These emit **`game_map_edited`** `{game_id, row, col, edit}`.
  - **Replay indexers must apply it.** Frames carry ships, not terrain.

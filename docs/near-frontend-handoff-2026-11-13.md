# Frontend handoff: native NEAR contracts

_Written 2026-11-13 for the frontend agent (updated the same day: real ship names, testnet deploy, quick start, ABI files). Describes `near/` on branch `near-migration-experiment` as of that date. Contracts change; check the date and `near/README.md` before relying on details. Deployed to **testnet** on 2026-11-13 (see §0); not on mainnet._

## 0. Testnet deployment (2026-11-13)

| Contract | Account | Code SHA-256 |
|---|---|---|
| Game | `game.void-tactics.testnet` | `0f4cf914c2097406005e16fdcd16e922bf03fbd38ab523f98185771a405c4b9e` |
| Renderer | `art.void-tactics.testnet` | `f3243d0427ce6eac0cece187582a138dcd3f3c137a4372924a826039c18b51eb` |
| Owner | `void-tactics.testnet` | (plain account) |

- RPC: `https://rpc.testnet.near.org`.
- Full content is seeded: 72 maps, 64 AI configs, the 30-node campaign, the roguelike campaign (id `1`) and 6 PvP maps.
- Ship prices were set from NEAR/USD $3.51. For example, 5 ships cost 1.42 NEAR.
- `nft_metadata().base_uri` is unset until the frontend image route exists. Rendering works through the renderer views.
- The contract accounts still have their full-access keys, so they can be redeployed while we iterate. **State may be wiped by a redeploy.**
- Smoke-tested on testnet after the deploy: register storage, claim 10 free ships (all constructed with real names within the same transaction's receipts), render ship #1 through `art.void-tactics.testnet`.

### Exact types: ABI files

- `near/abi/void_tactics_abi.json` lists all 155 game methods (including admin methods the frontend won't call): names, argument names, JSON schemas for every struct and enum, and view or call plus payable markers.
- `near/abi/void_renderer_abi.json` covers the renderer.
- Every method and argument named in this doc was checked against these files.
- Generate TypeScript types from them rather than copying shapes from this doc. To regenerate: `cd near && cargo near abi --manifest-path contracts/<crate>/Cargo.toml --out-dir abi`, then drop the test-only `upgrade_probe` entry.

### Quick start (testnet)

```ts
const RPC = "https://rpc.testnet.near.org";
const GAME = "game.void-tactics.testnet";
const RENDERER = "art.void-tactics.testnet";

// Views: plain JSON-RPC, no wallet needed.
async function view<T>(contract: string, method: string, args: object = {}): Promise<T> {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "query",
      params: { request_type: "call_function", finality: "optimistic", account_id: contract,
                method_name: method, args_base64: btoa(JSON.stringify(args)) },
    }),
  }).then((r) => r.json());
  if (res.error || res.result?.error) throw new Error(JSON.stringify(res.error ?? res.result.error));
  return JSON.parse(new TextDecoder().decode(new Uint8Array(res.result.result)));
}

// Calls: NEAR Wallet Selector (@near-wallet-selector/core), standard action shape.
const TGAS = "1000000000000";
async function call(wallet: any, method: string, args: object, gasTgas = 50, depositYocto = "0") {
  return wallet.signAndSendTransaction({
    receiverId: GAME,
    actions: [{ type: "FunctionCall", params: { methodName: method, args,
      gas: (BigInt(gasTgas) * BigInt(TGAS)).toString(), deposit: depositYocto } }],
  });
}

// First session: register, claim, wait for construction, render.
if (!(await view(GAME, "storage_balance_of", { account_id: me })))
  await call(wallet, "storage_deposit", { account_id: null, registration_only: false }, 30, "100000000000000000000000"); // 0.1 NEAR
await call(wallet, "claim_free_ships", { variant: 1 }, 300);
const ships = await view<any[]>(GAME, "get_ships_for_owner", { account_id: me, from_index: 0, limit: 50 });
// Each entry is { ship, owner }. Poll until ship.ship_data.constructed is true.
const uri = await view<string>(RENDERER, "token_uri", { ship: ships[0].ship });
```

- **Session keys (no popups during play).** Sign in with `contractId: GAME` and an empty `methodNames` list. The wallet then adds a function-call access key for the game contract.
  - Calls with **zero deposit** are signed with that key, without a popup. That covers every gameplay method (§3).
  - Anything with a deposit, or the 1-yocto transfers, still goes through the wallet.
- **Rule of thumb:** 50 Tgas for gameplay calls, 300 Tgas for claims, purchases and `take_ai_turns`.

## 1. What changed from the Base frontend

| Base (viem) | NEAR |
|---|---|
| About 99 contract addresses | **Two accounts**: the game contract and the renderer |
| ERC-721 `Ships` | NEP-171 (`nft_*`) on the game contract |
| ERC-20 UTC / DEC, approve then `transferFrom` | NEP-245 multi-token ids `"utc"`, `"dec"`, `"hive_medal"` on the game contract. **No approvals**: spends are internal debits. |
| Reveal, then `constructAllMyShips` | **Nothing to do.** Ships construct automatically one or two blocks after minting (self-callback randomness). |
| Gas paid in ETH | Gas, plus a **prepaid storage balance** (NEP-145) per player |
| `eth_getLogs` / event scans | **Views** (below). NEP-297 `EVENT_JSON:` logs exist for indexers and toasts only. |
| `tokenURI` from the contract | Two view calls: `get_ship` on the game, then `token_uri(ship)` on the renderer |
| Dynamic wallet | NEAR Wallet Selector (or another NEAR wallet). Check Dynamic's NEAR support separately. |

Tournament and the UTC lottery hook don't exist on NEAR.

## 2. Encoding conventions

- **Numbers:** u64 ids and all token amounts are JSON **strings** (`U64` / `U128`). Small numbers (`u8`, `u16`, `u32`, `i16`) are JSON numbers.
- **Field names** are `snake_case`, e.g. `ship_data.timestamp_destroyed` instead of `shipData.timestampDestroyed`.
- **Enums** are their variant names as strings: `"Shoot"`, `"Light"`, `"PvE"`. `ActionType` is one of `Pass`, `Shoot`, `Retreat`, `Assist`, `Special`, `FactionAbility`.
- **Positions** are `{ "row": i16, "col": i16 }`.
- **Time:** every timestamp and duration is in **seconds**, as on Base.
- **NFT token ids** in `nft_*` methods are decimal strings, e.g. `"42"`.
- **UTC** has 18 decimals, as on Base. DEC has 0.
- **ABI:** `cargo near abi` produces a full JSON ABI. Prefer generating TypeScript types from it over hand-typing them.

## 3. Onboarding: storage

Every player needs a storage balance before doing anything that writes state.

1. Check `storage_balance_of({account_id})`. `null` means the player isn't registered.
2. If not registered, call `storage_deposit({account_id: null, registration_only: false})` with attached NEAR. The minimum is `storage_balance_bounds().min` (0.0125 NEAR).
   - About 0.003 NEAR per ship is a useful rule of thumb.
   - Recommend 0.1 NEAR for a new player, about 30 ships.
3. Show `storage_balance_of` as `{ total, available }` and `storage_used_bytes({account_id})`.
4. Failures:
   - `InsufficientStorageBalance`: prompt a top-up with `storage_deposit` (any amount, no `registration_only`).
   - `StorageNotRegistered`: run step 2.
5. Unused balance can be withdrawn with `storage_withdraw({amount})`, which needs a 1 yocto deposit.

Rules the UI should know:
- **Purchases with NEAR pay for their own storage** from the price. A buyer needs only to be registered.
- **Gameplay calls attach no deposit.** They charge the prepaid balance, so a function-call (session) key for the game contract can play without wallet popups. Calls that move money still need the full-access key or a wallet confirmation:
  - methods that need a deposit: `purchase_ships_with_near`, `buy_utc_with_near`, `storage_deposit`;
  - methods that need 1 yocto: `nft_transfer`, `nft_transfer_call`, `mt_transfer`, `mt_batch_transfer`, `storage_withdraw`, `storage_unregister`.
- **Sponsorship:** `sponsor_storage` lets the backend fund verified players from a pool. Sponsored NEAR shows in the balance but can't be withdrawn.
- **Transfers:** sending a ship moves its storage cost from the sender to the receiver. The receiver must be registered.

## 4. Ships

### Minting
| Call | Deposit | Returns |
|---|---|---|
| `claim_free_ships({variant})` | 0 | `U64[]` ship ids |
| `purchase_ships_with_near({tier, referral, variant})` | Exactly `get_price_tiers()[tier].near_ship_price` | ids |
| `purchase_ships_with_utc({tier, referral, variant})` | 0 (debits UTC) | ids |
| `buy_utc_with_near({tier})` | Exactly `near_utc_price` | UTC minted |
| `complete_tutorial({win_path})` | 0 | ids (template ships, construct immediately) |

New ships exist straight away, with `ship_data.constructed == false`. Poll `get_ship` (or watch for `ship_constructed` events) until `constructed` is true, usually one or two blocks. Two edge cases:
- If a ship stays unconstructed because storage ran out, call `construct_ship({ship_id})` after a top-up.
- If the callback never ran (rare gas failure), anyone can call `retry_resolve({ids})`.

Recover ship ids with `get_ships_for_owner`; don't rely on the return value surviving a page reload.

### Reading ships
- `get_ship({ship_id})` returns `{ ship, owner } | null`. The `ship` struct matches Base's `Ship`, in snake_case.
- `get_ships_for_owner({account_id, from_index, limit})` is paginated, in ownership-index order.
- Standard NEP-171 views: `nft_token`, `nft_tokens_for_owner`, `nft_supply_for_owner`, `nft_total_supply`, `nft_metadata`.

### Other ship actions
- `recycle_ships({ship_ids})` returns UTC. Free ships can't be recycled.
- `get_modification_cost({ship_id, equipment, accuracy, hull, speed, variant, shiny})` (the ship's full desired end state), then `modify_ship` with the same arguments (DroneYard). Pays in UTC.
- `nft_transfer({receiver_id, token_id, approval_id: null, memo: null})` with 1 yocto (`approval_id` must be null; approvals aren't supported). Ships in a fleet can't be sent, and sending needs ≥10 purchased ships.

### Images and metadata (renderer contract)
```ts
const { ship } = await view(game, "get_ship", { ship_id });
const uri = await view(renderer, "token_uri", { ship });         // data:application/json;base64,...
const img = await view(renderer, "render_ship_image", { ship }); // data:image/svg+xml;base64,...
```
- The renderer account comes from `get_renderer()` on the game contract.
- Medal: `medal_token_uri({token_id})`, `medal_svg()`.
- Marketplaces read NEP-177 `media` = `<id>` relative to `nft_metadata().base_uri`. That base URI should be a frontend route (e.g. `/api/ship/<id>`) that does the two calls above and returns JSON or the image. **The route has to be built.**

## 5. Tokens (NEP-245)

- **Balances:** `mt_balance_of({account_id, token_id: "utc" | "dec" | "hive_medal"})`, `mt_batch_balance_of`, `mt_supply`.
- **Transfers:** `mt_transfer({receiver_id, token_id, amount, approval: null, memo: null})` with 1 yocto. The receiver must be registered. `hive_medal` is soulbound.
- **No approval step.** Purchases, lobby fees, repairs and modifications debit the player's balance directly. Delete the approve flows.
- **DEC:**
  - `turn_in_cores({amount})` raises the storefront tier;
  - `get_storefront_tiers()` returns the tier list;
  - `get_claim_status({account_id})` returns the cooldown, the next claim time and the drone-core tier.
- **Medal:**
  - `claim_medal()` mints the medal after the final campaign node is cleared;
  - `is_eligible({account_id})` reports Selfie verification eligibility.

## 6. Single-player campaign

**Content views:**
- `get_campaign`, `get_node({node_id})`
- `is_node_unlocked` / `is_node_completed({account_id, node_id})`
- `get_preset_map({map_id})`, `get_map_placements({map_id})`, `get_ai_ship_config`
- `get_map_count`, `get_ai_config_count`

**Play loop:**
1. `start_node_match({node_id, ship_ids, positions})` returns the game id. Positions must be inside the map's creator zone.
2. Player move: `move_ship({game_id, ship_id, new_row, new_col, action, target_ship_id})`. Use `target_ship_id: "0"` when there is no target. The same method serves PvP and roguelike games.
3. AI turns: `take_ai_turns({game_id, max_moves: 8})`. Call it whenever it's the AI's turn, until it returns 0. It is permissionless, so a backend relayer can call it too.
4. `forfeit({game_id})`.
5. State: `get_game({game_id})` returns the full board, and `get_sp_match({game_id})` returns the node, player and status. Re-read after each call; there is no need to replay `move` events.

Gas: 50 Tgas is plenty for every gameplay call. The heaviest measured are `take_ai_turns(8)` at 10 Tgas and `move_ship` at 4 Tgas. Use 300 Tgas for purchases of 60 ships (measured 106).

## 7. PvP

**Lobby calls:**
- `create_lobby({cost_limit, turn_time, creator_goes_first, map_id, max_score, reserved_joiner})` (`reserved_joiner` may be `null`)
- `join_lobby`, `accept_game`, `reject_game`
- `leave_lobby`, `timeout_joiner`, `quit_with_penalty`
- `create_lobby_fleet({lobby_id, ship_ids, positions})`. The game starts when both fleets exist.
- `prune_stale_lobby`, which anyone can call.

Fees are in UTC (debited directly) after the free lobby.

**Lobby views:**
- `get_open_lobbies({from_index, limit})`, `get_open_lobby_count`
- `get_lobby`, `get_player_lobbies`, `get_player_lobby_state`
- `get_lobby_fleet({lobby_id, is_creator})`

**Match calls:** `move_ship` as above, `flee({game_id})`, `end_game_on_timeout({game_id})`.

**Match views:**
- `get_pvp_game`, `get_game`
- `get_game_result`, `get_player_stats({account_id})` (wins/losses)
- `record_blob` / `get_blob`

## 8. Roguelike

**Calls:**
- `start_run({campaign_id, ship_ids})`
- `enter_combat_node({node_id, positions})` returns the game id. Then use `move_ship` / `take_ai_turns` as in single-player.
- `retreat_run({game_id})`
- `enter_resupply_node({node_id})`, `resupply_repair({ship_ids})`, `resupply_modify_roster({add, remove})`

**Views:**
- `get_run({account_id})`, which includes the roster, generation and current node
- `get_rl_campaign`, `get_rl_node`, `get_rl_match`
- `is_rl_node_locked` / `is_rl_node_defeated`
- `get_run_ship_hp({account_id, ship_id})`, `get_active_runs_at_node`

## 9. Events (`EVENT_JSON:`, standard `void_tactics` v1.0.0)

`data` is always a one-element array. Events in this version:
- **Randomness:** `randomness_requested`, `randomness_resolved` (the callback ran; ships then construct in the same receipt)
- **Ships and economy:** `ship_constructed`, `free_ships_claimed`, `cores_turned_in`, `tutorial_completed`, `player_verified`, `storage_registered`, `metadata_update`
- **Single-player:** `node_match_started`, `move`, `ai_turns`, `game_ended`, `node_completed`, `reward_skipped`
- **PvP:**
  - lobbies: `lobby_created`, `player_joined_lobby`, `game_accepted`, `game_rejected`, `lobby_reset`, `lobby_abandoned`, `lobby_terminated`, `lobby_pruned`
  - matches: `fleet_created`, `game_started`, `game_result_recorded`, `blob_recorded`
- **Roguelike:** `run_started`, `combat_node_entered`, `resupply_node_entered`, `resupply_repaired`, `roster_modified`, `run_ended`, `ship_granted`, `win_effect_failed`
- **Admin:** `upgrade`

Standard `nft_mint` / `nft_transfer` / `mt_mint` / `mt_transfer` / `mt_burn` events are also emitted.

To get them, read `receipts_outcome[].outcome.logs` from the transaction result. For history, use an indexer (FastNEAR, NEAR Lake, Pikespeak); RPC can't search logs.

## 10. Errors

Panics come back as `FunctionCallError` with the same error names as the Solidity custom errors where they exist, e.g. `ShipAlreadyMoved`, `InvalidMove`, `InsufficientUTC`, `ShipInFleet`. Match on the substring. NEAR-specific errors:
- `StorageNotRegistered`
- `InsufficientStorageBalance`
- `DepositBelowMinimum`
- `ReceiverNotRegistered` / `ReferrerNotRegistered`
- `InvalidPurchase` (attached deposit is not the exact price)
- `PriceBelowStorageCost`

## 11. Not done yet

- ~~Real variant-1 ship names; names are stubbed until the OnchainRandomShipNames port.~~ Done 2026-11-13: names match the Base contract. One name in about 22,000 is an empty string, so render a fallback (e.g. `Ship #<id>`) when `name` is `""`.
- ~~Testnet and mainnet deploys. The deploy tool exists (`near/README.md`); account names come with the deploy.~~ Testnet done 2026-11-13 (§0). Mainnet not done.
- The `base_uri` gateway route (§4).

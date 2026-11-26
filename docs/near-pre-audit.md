# NEAR port: pre-audit notes

_Written 2026-11-13 (updated the same day: ship names ported; decisions on §8 recorded; updated 2026-11-14: EVM parity audit and fixes, §10), describing `near/` on branch `near-migration-experiment` as of that date. Contract behavior changes over time; check the date before relying on details._

## 1. Scope

| Contract | Source | Size (release WASM) |
|---|---|---|
| Game (`void-tactics`): ships (NEP-171), UTC/DEC/medal (NEP-245), storage ledger (NEP-145), randomness, single-player campaign, PvP, roguelike, economy, admin | `near/contracts/void-tactics/` + rules in `near/crates/vt-core/` | ~1.42 MB as of the 2026-11-14 afternoon build (about 380 KB of it is the 21,826-entry ship-name table) |
| Renderer (`void-renderer`): ship art, NFT metadata JSON, medal art (views) | `near/contracts/void-renderer/` (`src/art.rs` generated) | ~997 KB |

Out of scope: Tournament and the Uniswap v4 lottery hook (dropped for NEAR). The variant-1 ship-name generator (`OnchainShipNames` from the separate `onchain_names` repo) is compiled into the game contract instead of being an external contract.

Parity with the audited Solidity code is checked mechanically. These checks are the main evidence that the port preserves the Solidity behavior:
- 614 ship generations, stats and costs are bit-identical.
- 16 full campaign matches (743 steps), with the Rust AI re-deciding every AI turn, match the full board after every step.
- 192 NFT token URIs and the medal URI are byte-identical.
- 121 variant-1 ship names match `getRandomShipName` read from the live Base Sepolia contract (`0x2b6C…d779`), including the example in that repo's README.

All of these use fixtures exported from the unmodified Solidity contracts (`scripts/near-golden/`). The name list (`near/seed/ship_names.json`) is the exact set of subsets passed to the deployed contract, taken from its Ignition journal. It is the committed `ships.json`, not the uncommitted cleanup in the `onchain_names` working tree.

## 2. Trust model and keys

- **Owner** (an account set at `new`; a multisig or DAO in production) can do the following, as the Solidity owners could:
  - publish attribute and cost tables;
  - set resolvers, prices and reward tokens;
  - edit content;
  - withdraw revenue or collected UTC and burn collected UTC;
  - mint medals;
  - upgrade code.
- **Roles** (`set_role`, owner-only bitmask):
  - `MAP_EDITOR`: maps and AI encounters.
  - `NODE_EDITOR`: campaigns and nodes. Roguelike win effects are owner-only because they mint.
  - `PAUSER`: mint and lobby pauses.
  - `VERIFIER`: Selfie verification.
  - `SPONSOR`: storage sponsorship from the owner-funded pool.
  - `BLOB_WRITER`: replay blobs.
  - `MINTER` (2026-11-14): `create_ships_for`, the card-checkout server mint (Base: `FIREBASE_FLOW_MINTER` on `Ships.createShips`). A compromised minter key can mint unlimited ships, as on Base. Keep that key on the server only, and revoke it with `set_role(account, 0)`.
- **Code changes:**
  - **Upgrades.** `upgrade` (owner-only, raw WASM input) redeploys and then calls `#[private] migrate`. If the migration fails, the deploy fails too.
  - **Key posture.** After deploy, both contract accounts' full-access keys are deleted (`deploy --delete-keys`), so the owner's `upgrade` is the only way to change code. The deploy tool refuses this if the owner is a contract account, because that would freeze the code.
  - **Drill.** `phase6_hardening::upgrade_drill_with_full_access_keys_deleted` checks that only the owner can upgrade, that a direct redeploy is impossible once the key is deleted, and that state survives the upgrade.
  - **State migrations.** There is no live state yet (2026-11-14), so record layouts change freely, and testnet is redeployed fresh when they do. Once there's live state, `migrate` must convert it:
    - New root fields go at the end. Borsh encodes a struct as its fields in order, so the old bytes plus the new fields' encoding decode as the new struct.
    - Storage-key enum variants are append-only, because a variant's position is its storage prefix.
    - Records stored in collections (accounts, ships, games, runs) can't be rewritten in bulk on NEAR. Changing their layout needs a versioned record type that decodes old entries lazily.
    - Every migration needs a sandbox test that starts from the exact WASM it upgrades.
- **Ownership transfer** (2026-11-14; Base: `Ownable.transferOwnership`). Both contracts use two steps: the owner nominates with `transfer_ownership`, and the nominee calls `accept_ownership`. A typo or an unreachable account can't take admin away. Roles are kept. `renounceOwnership` isn't offered, because without an owner, code and rules could never change again. This is how the deploy account hands over to a multisig.
- **Live-game map edits** (2026-11-14; Base: `Maps.setBlockedTile`/`setImpassableTile`/`setScoringTile`). A `MAP_EDITOR` can change terrain and scoring in a game **in progress**, as on Base, until it ends. That's a real power over live matches: give `MAP_EDITOR` only to trusted operators. Each edit emits `game_map_edited`.
- **Recommendation:** put the owner behind a multisig with a timelock. An upgrade can change any rule.

## 3. Storage model (solvency)

- **Who pays.** Players prepay storage (NEP-145). Every state-changing call measures `env::storage_usage()` and charges or refunds the byte delta to the account that owns the state.
  - Gameplay therefore needs no attached deposit, and session (function-call) keys work.
  - A Sybil swarm pays for its own bytes, so it can't drain the contract.
- **Invariant:** total `used_bytes` across accounts equals real storage, excluding contract-paid content. This is tested byte-exactly in every sandbox suite: claims, the randomness callback, purchases, transfers, PvP with a third-party pruner, roguelike runs with a third party driving the AI.
- **Attribution** goes to the owner of each item, not to the caller.
  - Lobby record and open-list entry: the creator.
  - Fleets and lobby-list entries: that player.
  - Game state and results: whoever's call wrote them.
  - Single-player and roguelike games: the player.
  - Game-history rows (2026-11-14): each participant. In PvP, the second fleet's call writes both players' rows.
    - The other player's row is charged to them only if their balance covers it; otherwise the caller covers it (`charged_or_fallback`).
    - The fallback exists so a hostile player who empties their balance can't make the other player's call revert.
    - Today the joiner's lobby-list refund at game start covers their row anyway; the fallback makes that safety independent of entry sizes.
  - Without this, a stranger pruning a stale lobby would be refunded the creator's bytes.
- **Transfers** move the ship's prepaid bytes with it; the sender pays. Nobody can fill another player's storage by sending ships.
- **Fixed-size records.** Account records and randomness requests never grow, so token mints, kill rewards and the randomness callback never need to charge anyone and can't fail for storage.
- **Paid purchases.** A NEAR purchase prepays its own bytes out of the price; a price below a pack's storage cost is rejected.
- **Sponsorship.** Sponsored NEAR can be spent on storage but never withdrawn, and unspent sponsorship returns to the pool on unregister. NEAR the minter attaches to `create_ships_for` is credited the same way, so a card buyer can't cash out the server's deposit. Since 2026-11-14 the NEP-145 `available` field reports the withdrawable amount (deposit minus the larger of locked and sponsored). Before, it showed sponsored NEAR as available even though `storage_withdraw` refused it.
- **Contract-paid storage.** Code plus owner-seeded content is about 1.5 MB on the game account (about 15 NEAR, as of the 2026-11-14 afternoon build) and about 1 MB on the renderer (10 NEAR). Fund each with a buffer on top. Every upgrade that grows the code needs spare balance for the extra bytes, or it fails with `LackBalanceForState` (it did once on testnet and rolled back cleanly).
- **Upgrade transaction size.** `upgrade` carries the new WASM as call input, and a transaction is capped at 1.5 MB. As of the 2026-11-14 afternoon build the game WASM is 1.42 MB, so **about 148 KB** of growth remains before upgrades need a staged upload (e.g. chunked writes, or a global contract). This is now a near-term constraint.

## 4. Randomness

Minting records a fixed-size request and schedules a self-callback (`#[private] resolve_randomness`) that reads `env::random_seed_array()` in a later block.

- A player can't predict that seed.
- A player can't batch an action that panics on a bad roll, because the callback is a separate receipt.
- A player can't revert the result.

Construction from the stored value is deterministic. A construction the callback skips (e.g. storage) is finished later with `construct_ship`, from the same value. `retry_resolve` is permissionless and idempotent; it only reschedules a callback.

Trust assumption: validators produce the VRF seed. This is comparable to the Solidity version's trust in the Base sequencer.

Project rule (CLAUDE.md, `.cursor/rules`): never read `random_seed` outside this callback.

## 5. Permissionless methods: hostile-caller review

Each method below has no access control beyond "must be registered" or "must be a participant". The question asked of each: what is the worst a zero-profit griefer can do?

| Method | Worst case | Why it's acceptable |
|---|---|---|
| `storage_deposit` (for any account) | Registers someone else with the minimum | They pay. NEP-145 standard. |
| `claim_free_ships` | Sybil farms free ships | Each account pays its own storage. Free ships can't be recycled, pay no kill rewards and can't be transferred without 10 purchases. Optional Selfie gate (`set_verification_requirements`). |
| `retry_resolve` | Spams reschedules | Idempotent; already-resolved or unknown ids are dropped; the caller pays gas; the seed is never taken from the caller's receipt. |
| `take_ai_turns` | Advances someone's AI | The AI is deterministic and moves only on its turn, so the outcome is the same whoever calls. Storage is charged to the match's player (their game). Capped at 8 moves per call (log limits). |
| `prune_stale_lobby` | Prunes a stale lobby | Time-gated. The refund goes to the creator; the pruner gains nothing (unit test). |
| `create_lobby` / `join_lobby` | Spams lobbies or joins | Storage paid; fees after the free slot; views paginated. **Inherited, accepted (decided 2026-11-13):** Sybil accounts can each use their free join on a victim's lobby and stall it until the creator's `timeout_joiner` (a kick blocks only that account). Each Sybil must hold a funded storage balance, and after testnet the game won't fund wallets directly, so every stalling account costs the griefer real NEAR. Reserved lobbies remain the escape hatch. |
| `nft_transfer_call` | Hostile receiver | Tested: keep, return, panic, oversized junk and gas-burn receivers never lose or duplicate a ship. The resolve reads at most 16 bytes of return value and won't return a ship that is now in a fleet. |
| `mt_transfer` / `mt_batch_transfer` | Sends tokens to an unregistered account | Rejected (`ReceiverNotRegistered`). Balances are fixed slots, so no storage growth. |
| `end_game_on_timeout`, `flee` | — | Participant-only. Timeout is strictly greater than the turn time. |
| `record_blob` | — | Participant or `BLOB_WRITER` only; storage paid by the caller. |
| `buy_utc_with_near` | — | Exact price; mints the pegged UTC amount. |
| `sync_ship_costs` (2026-11-14) | Re-prices someone else's ships to push their roster over a cost cap | Owner of every id only (`NotYourShip`); ships in a fleet are rejected. Same rule as Base (HA7-08). No storage change. |
| `get_games_for_player` rows (2026-11-14) | A hostile PvP opponent empties their balance so the game start reverts | `charged_or_fallback`: the caller covers that row instead. Tested in `charged_or_fallback_bills_the_fallback_when_owner_cant_cover`. |
| `create_ships_for` (2026-11-14) | — | `MINTER` role or owner only. Its deposit is non-withdrawable sponsorship. |
| `mt_burn` (2026-11-14) | — | Burns the caller's own balance only (1 yocto). The medal can't be burned (soulbound). |
| `construct_ships` (2026-11-14) | — | Each id goes through `construct_ship` (owner of the ship only, deterministic from the stored value). At most 50 per call. |
| Preview and batch views (2026-11-14) | Expensive views | Bounded: `get_games` ≤ 10, `get_lobbies` ≤ 50, `get_ships_by_ids`/`get_ship_attributes` ≤ 100, `get_rl_campaign_graph` ≤ 512 nodes. Views cost the caller's RPC, not the contract. |

Private callbacks (`resolve_randomness`, `nft_resolve_transfer`, `migrate`) reject external callers (tested). `new` cannot re-initialize, because near-sdk's `#[init]` refuses when state exists.

## 6. Paths that must not revert

In Solidity these were try/catch wrapped. In the port they are written not to panic, and failures are logged as events.
- **Kill rewards** (`reward_skipped`). These run inside a lethal move, possibly during someone else's AI turn. HA6-22.
- **Roguelike win effects** (`win_effect_failed`): each is pre-checked and applied atomically. Failure cases are an unpaid mint, an unconfigured variant, and a ship grant the player's storage can't cover.
- **Roguelike post-win reservation:** survivors plus rejoiners are validated first, falling back to survivors only. There is no partial application.
- **AI decisions:** a decision failure falls back to Pass in place (`decision_failed`). A failed AI move is rolled back by cloning the game state and restoring it on error, which replaces try/catch.
- **The randomness callback:** it never panics; a construction it skips is retried later.

## 7. Deliberate differences from the Solidity contracts

- **Architecture:** one contract instead of about 99. The allowlists between contracts, engine registries, the router, CREATE2 helpers, and setters that lock once an engine is live are gone, because there is nothing to re-point.
- **Randomness:** a self-callback replaces the deferred blockhash. Ships construct automatically; there is no expiry and no fallback "baseline" ship.
- **Referral ladder:** both purchase paths now pay 10/20/35/50%. ShipPurchaser's off-by-one 0/10/20/35% table was a bug; ~~still to fix on EVM~~ fixed on EVM 2026-11-25 (`ShipPurchaser._processReferral`; not yet deployed to Base Sepolia).
- **UTC purchases** always mint to the buyer.
- **Template ships** (tutorial, grants) skip randomness. Their `serial_number` is 0.
- **DroneYard cost** overflows at 68 lifetime modifications instead of about 196. Both are far above any UTC supply.
- **`randomBase` increments** wrap instead of reverting (Solidity's revert near `u64::MAX` would brick a ship forever).
- **Fleets:** ~~a single-player fleet can't be empty (Solidity allowed it, which created a game that could never be played).~~ No longer a difference (2026-11-25): empty fleets are rejected on both chains, in single-player and PvP (`EmptyFleet`). Not yet deployed to Base Sepolia.
- **Approvals:** NEP-178 approvals are not supported; transfers are owner-only. `mt_transfer_call` is not implemented.
- **Rendering:** the game contract can't call the renderer from a view. Clients compose `get_ship` → `token_uri`; marketplaces use `base_uri/<id>` through a gateway.

## 8. Inherited behavior, kept by decision

Both the Solidity engine and the port behave this way. Each was reviewed and **kept as is** (project owner, 2026-11-13).
- **A side can be left with only disabled ships.** A round can start on the turn of a side whose only ships are at 0 HP. That side can only retreat one or let the opponent claim the turn timeout, because a ship at 0 HP doesn't end the game until it is removed. Kept: the outcome is still decided (retreat or timeout), and it matches the Solidity game. The sandbox play policy (`near/tests/src/policy.rs`) retreats a disabled ship in this state.
- **Self-referral is allowed.** This is a deliberate choice: it can't be blocked when addresses are free. ECON-01 (`econ01_referral_plus_recycle_is_unprofitable_at_the_peg`) shows referral plus recycling still loses UTC even at the 50% tier.
- **Free lobby joins can be farmed** (see §5). Kept: the game won't fund wallets directly after testnet, so each griefing account is paid for by the griefer.
- **One variant-1 ship name is the empty string.** The deployed name list's first entry is `""`, so about 1 in 22,000 variant-1 ships has no name. Kept for parity; fixing it means changing `near/seed/ship_names.json`, regenerating the table and refreshing `near/golden/ship_names.json`, which would then differ from Base.

## 9. Tests

| Layer | Count | What |
|---|---|---|
| `vt-core` | 17 | Rules, plus the generation, ship-name and full-game golden-parity suites |
| `void-tactics` unit | 224 (as of 2026-11-14) | Ported Hardhat cases (same names) for ships, economy, claims, medal, eligibility, storefront, PvP lobbies and matches, roguelike |
| `void-renderer` | 2 | Color math; byte-for-byte golden parity (192 ships + medal) |
| Sandbox (`near-workspaces`) | 22 (as of 2026-11-14, incl. `phase7_replay`) | Randomness (later block, batch-revert immunity, private callback), storage ledger exactness, session keys, hostile NEP-171 receivers, full SP/PvP/roguelike games, renderer via views, full seed, upgrade drill with keys deleted, gas budgets |

**Gas budget**, measured on the heaviest seeded encounter (14 AI ships against 8):
- AI turns peak at 14 Tgas per `take_ai_turns(8)` (10 before replay frames were added, 2026-11-14).
- Moves peak at 5 Tgas (2026-11-14, with replay frames).
- Starting the match costs 8 Tgas (2026-11-14, with replay frames).
- Buying and constructing 60 ships costs 107 Tgas.

The per-receipt limit is 1 PGas.

CI: `.github/workflows/near.yml` runs every layer, plus a check that the generated art matches the Solidity leaves.

## 10. EVM parity audit (2026-11-14)

Every external function of the in-scope Solidity contracts was compared against the NEAR ABI. Most names without a match are wiring between contracts that one contract doesn't need, or have a renamed equivalent. These real gaps were found, and all but the last are fixed:

1. ~~No `syncShipCosts`.~~ **Bug:** after any `set_costs`, every existing ship failed `ShipCostVersionMismatch` in every fleet, permanently. Fixed: `sync_ship_costs` (owner of each ship) and `set_cost_of_ship` (owner).
2. ~~No server mint for card checkout (`Ships.createShips` via `isAllowedToCreateShips`).~~ Fixed: `create_ships_for` under the `MINTER` role.
3. ~~Create-only content.~~ Fixed:
   - `update_preset_map`, `update_preset_map_impassable`, `update_preset_scoring_map`, `set_map_mode`, and `update_full_preset_map` (NEAR only);
   - `update_ai_ship_config`;
   - `update_node`, `add_prerequisite`, `remove_prerequisite`, `set_campaign_required_variant`;
   - `update_rl_node`.

   Live games keep their own copy of their map and AI fleet, so edits never change a match in progress (tested).
4. ~~No `Game.getGamesForPlayer`.~~ Fixed: `get_games_for_player`, a per-player history that keeps finished games. It added the first new root field, migrated as described in §2.
5. ~~Public getters with no view:~~
   - ~~`tutorialCompleted`, `ShipGrantWinEffect.hasClaimed`;~~
   - ~~lobby settings and every scalar rules setting;~~
   - ~~referral counts, `getShipsByIds`;~~
   - ~~paginated map and AI-config lists, and counts.~~

   Fixed: `is_tutorial_completed`, `is_rl_grant_claimed`, `get_settings`, `get_lobby_config`, `get_player_summary`, `get_ships_by_ids`, `get_preset_maps`, `get_ai_ship_configs` and the count views.
6. ~~No NEAR deployment record (content key → id).~~ Fixed:
   - the deploy tool writes `near/deployments/<network>.json`, only after checking every id against the chain (203 checks on testnet);
   - `--upgrade` and `--record-only` modes;
   - `seed::plan_all`, a dry-run plan of the ids.

   The full-seed test checks that the plan equals the real seed and that a record with swapped ids is rejected.
7. ~~**Still open: cross-device replay.** Base had no on-chain move list either; frontends read event logs, and NEAR RPC can't search logs. The `move` events exist. The options are an indexer (recommended; no on-chain cost) or an on-chain move log charged to each mover (very roughly 0.02 NEAR for a 60-move game). The project owner is deciding.~~ Decided 2026-11-14: an indexer.
   - Every event that changes a game now carries the whole compact board (`vt_core::replay`): about 620 bytes for the largest seeded board. That covers game starts, each human move, each AI move inside `ai_turns`, and games ended outside a move.
   - Logs aren't state, so this has no storage cost. Gas on the heaviest board: `take_ai_turns(8)` went from 10 to 14 Tgas.
   - **Per-receipt cap:** 16,384 bytes of logs and 100 entries. The heaviest measured receipt logs 6.2 KB (8 AI moves on 22 ships). `phase7_replay` asserts the cap; a future feature that adds logs to AI turns must keep that margin.
   - Verified by rebuilding a whole game from logs alone (`phase7_replay`) and by the golden-game suite (743 steps).

Tests: 40 new contract unit tests (`unit_tests/parity.rs`, plus the history and hostile-joiner cases in `pvp.rs` and `roguelike.rs`) and 1 new sandbox test (the migration).

## 11. Internal security review (2026-11-14)

The scope was the contract layer: storage ledger, tokens, randomness, ships, shop and treasury, PvP lobbies and matches, roguelike, single-player, and admin/roles. `vt-core` engine and AI behavior is covered by the golden and fuzz differential suites (§9, parity audit §10). The method was every external method against a hostile caller with no profit motive, with special attention to calls that write state owned by someone else.

| # | Finding | Severity | Status |
|---|---|---|---|
| 1 | ~~A lobby creator could trap a joiner's ships. After the joiner commits a fleet, the creator empties its storage balance. The joiner's `leave_lobby` and `quit_with_penalty` both re-add the lobby to the open list, charged to the creator, so both reverted with `InsufficientStorageBalance`, and the joiner's ships stayed locked for as long as the creator liked. In the mirror case, a joiner emptying its balance blocked the creator's `leave_lobby` handover (the lobby record is charged to the new creator).~~ | **High** (a no-cost griefer locks another player's assets) | Fixed 2026-11-14. `open_add` and `save_lobby` charge the lobby's creator when it can cover the bytes, otherwise the caller (`charged_or_fallback`). Tests: `a_creator_draining_storage_cannot_trap_the_joiner_in_the_lobby`, `…cannot_block_quit_with_penalty`, `a_joiner_draining_storage_cannot_stop_the_creator_leaving`. Every other `charged(other, …)` call was reviewed: each is a refund, a same-size rewrite, a charge to the caller, or admin-only. |
| 2 | ~~Recycling a ship before its randomness resolved left the pending request behind. The callback then failed with `ShipNotFound` and *restored* the request for a retry that could never succeed, so about 190 bytes stayed locked on the payer forever and blocked `storage_unregister`.~~ | Low (self-inflicted) | Fixed 2026-11-14. `recycle_ships` drops the pending request first (refunding its payer), and the callback no longer restores a request whose ship is gone. Test: `recycling_an_unconstructed_ship_drops_its_pending_request`. |
| 3 | ~~An empty PvP fleet is accepted, as on Base. The game starts with one side empty. If the empty side moves first, the other player must wait the lobby's turn time (up to 24 h) and claim `end_game_on_timeout`, with their ships locked meanwhile. It also lets alt accounts feed someone free wins.~~ | Low | ~~**Open (decision).** Reject empty PvP fleets as single-player already does (`EmptyFleet`; a deliberate divergence from Base), or keep parity.~~ Fixed 2026-11-25 on both chains: `create_lobby_fleet` rejects `EmptyFleet` (tests `fleet_rejects_an_empty_creator_fleet` / `…joiner_fleet`), and Base's `Lobbies.createFleet` and `SinglePlayerMatch.startNodeMatch` revert `EmptyFleet`. |
| 4 | `storage_unregister` requires that no state besides the account record remains. Game-history rows and completed-node records are permanent, so anyone who has played can never unregister. Their unlocked deposit stays withdrawable through `storage_withdraw`. | Informational | By design (safe). Revisit if finished-game compaction is added. |
| 5 | Single-player and roguelike AI turns are charged to the human, whoever calls them. A player who empties their balance can stall the AI in their own game, which harms no one else. | Informational | Accepted. |
| 6 | Role-gated admin writes are contract-paid: seed content, map edits, nullifier bindings, sponsored registrations. If the contract's own buffer runs out, every write fails with `LackBalanceForState`. | Operational | Keep the contract account funded above its code plus content. The owner can't withdraw players' storage deposits, only `revenue_near`. |

**Checked and found sound:**
- **Randomness:** the seed is read only in the private callback. The callback has no player-controlled failure, so `retry_resolve` can't be used to re-roll, and values are stored before use.
- **Storage ledger:** exact per-call attribution, sponsored NEAR can't be withdrawn, and the contract owner can never withdraw players' deposits.
- **Tokens:** overflow-checked, mints never panic, self-transfers rejected, receivers must be registered, the medal is soulbound.
- **`nft_transfer_call`:** the receiver's return value is read capped at 16 bytes, and a ship only comes back if the receiver still holds it unlocked and can afford the move.
- **Purchases:** exact prices, storage paid out of the price, referral paid from the amount just collected.
- **Treasury:** UTC treasury and NEAR revenue are accounted separately.
- **Lobbies:** time-gated timeouts, kicks and prunes; `end_game_on_timeout` on a finished game reverts in the engine (parity with Base).
- **Fleet validation:** duplicates, positions, ownership, locks, construction, price version, single variant and the cost cap are all checked.
- **Roguelike:** win effects are pre-checked and atomic, once-per-player grants are tracked, repairs are priced on missing HP.
- **Remaining `unwrap`s** are internal invariants that untrusted input can't reach.

## 12. Open items before mainnet

1. ~~Port OnchainRandomShipNames (source pending) and refresh the generation goldens with real names.~~ Done 2026-11-13: ported, verified against the live contract; the generation goldens now check the mock name, as the Hardhat export used it.
2. Set real NEAR pricing (`seed_rules_priced(.., NearUsd::Live)` prices from the live NEAR/USD rate).
3. Owner multisig and timelock; delete the contracts' full-access keys at deploy.
4. ~~Decide on the lobby join-griefing mitigation and on the disabled-side rule.~~ Decided 2026-11-13: keep both (§8).
5. Frontend gateway for `base_uri`, plus an indexer for history (NEAR has no `eth_getLogs`).
6. External audit, which is calendar-bound.
7. ~~Decide how replays work across devices: an indexer or an on-chain move log (§10).~~ Decided 2026-11-14: an indexer, with full boards in events (§10). The indexer service itself still needs building.
8. Plan a staged upload before the game WASM grows past the 1.5 MB transaction limit (about 160 KB left, §3).

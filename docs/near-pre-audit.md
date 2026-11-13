# NEAR port: pre-audit notes

_Written 2026-11-13 (updated the same day: ship names ported; decisions on §8 recorded), describing `near/` on branch `near-migration-experiment` as of that date. Contract behavior changes over time; check the date before relying on details._

## 1. Scope

| Contract | Source | Size (release WASM) |
|---|---|---|
| Game (`void-tactics`): ships (NEP-171), UTC/DEC/medal (NEP-245), storage ledger (NEP-145), randomness, single-player campaign, PvP, roguelike, economy, admin | `near/contracts/void-tactics/` + rules in `near/crates/vt-core/` | ~1.28 MB (about 380 KB of it is the 21,826-entry ship-name table) |
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
- **Code changes:**
  - **Upgrades.** `upgrade` (owner-only, raw WASM input) redeploys and then calls `#[private] migrate`. If the migration fails, the deploy fails too.
  - **Key posture.** After deploy, both contract accounts' full-access keys are deleted (`deploy --delete-keys`), so the owner's `upgrade` is the only way to change code. The deploy tool refuses this if the owner is a contract account, because that would freeze the code.
  - **Drill.** `phase6_hardening::upgrade_drill_with_full_access_keys_deleted` checks that only the owner can upgrade, that a direct redeploy is impossible once the key is deleted, and that state survives the upgrade.
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
  - Without this, a stranger pruning a stale lobby would be refunded the creator's bytes.
- **Transfers** move the ship's prepaid bytes with it; the sender pays. Nobody can fill another player's storage by sending ships.
- **Fixed-size records.** Account records and randomness requests never grow, so token mints, kill rewards and the randomness callback never need to charge anyone and can't fail for storage.
- **Paid purchases.** A NEAR purchase prepays its own bytes out of the price; a price below a pack's storage cost is rejected.
- **Sponsorship.** Sponsored NEAR can be spent on storage but never withdrawn, and unspent sponsorship returns to the pool on unregister.
- **Contract-paid storage.** Code plus owner-seeded content is about 1.32 MB on the game account (13.2 NEAR) and about 1 MB on the renderer (10 NEAR). Fund each with a buffer on top.
- **Upgrade transaction size.** `upgrade` carries the new WASM as call input, and a transaction is capped at 1.5 MB. The game WASM is 1.28 MB, so about 220 KB of growth remains before upgrades need a staged upload (e.g. chunked writes, or a global contract).

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
- **Referral ladder:** both purchase paths now pay 10/20/35/50%. ShipPurchaser's off-by-one 0/10/20/35% table was a bug; still to fix on EVM.
- **UTC purchases** always mint to the buyer.
- **Template ships** (tutorial, grants) skip randomness. Their `serial_number` is 0.
- **DroneYard cost** overflows at 68 lifetime modifications instead of about 196. Both are far above any UTC supply.
- **`randomBase` increments** wrap instead of reverting (Solidity's revert near `u64::MAX` would brick a ship forever).
- **Fleets:** a single-player fleet can't be empty (Solidity allowed it, which created a game that could never be played).
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
| `void-tactics` unit | 184 | Ported Hardhat cases (same names) for ships, economy, claims, medal, eligibility, storefront, PvP lobbies and matches, roguelike |
| `void-renderer` | 2 | Color math; byte-for-byte golden parity (192 ships + medal) |
| Sandbox (`near-workspaces`) | 19 | Randomness (later block, batch-revert immunity, private callback), storage ledger exactness, session keys, hostile NEP-171 receivers, full SP/PvP/roguelike games, renderer via views, full seed, upgrade drill with keys deleted, gas budgets |

**Gas budget**, measured on the heaviest seeded encounter (14 AI ships against 8):
- AI turns peak at 10 Tgas per `take_ai_turns(8)`.
- Moves peak at 4 Tgas.
- Starting the match costs 6 Tgas.
- Buying and constructing 60 ships costs 106 Tgas.

The per-receipt limit is 1 PGas.

CI: `.github/workflows/near.yml` runs every layer, plus a check that the generated art matches the Solidity leaves.

## 10. Open items before mainnet

1. ~~Port OnchainRandomShipNames (source pending) and refresh the generation goldens with real names.~~ Done 2026-11-13: ported, verified against the live contract; the generation goldens now check the mock name, as the Hardhat export used it.
2. Set real NEAR pricing (`seed_rules_priced(.., NearUsd::Live)` prices from the live NEAR/USD rate).
3. Owner multisig and timelock; delete the contracts' full-access keys at deploy.
4. ~~Decide on the lobby join-griefing mitigation and on the disabled-side rule.~~ Decided 2026-11-13: keep both (§8).
5. Frontend gateway for `base_uri`, plus an indexer for history (NEAR has no `eth_getLogs`).
6. External audit, which is calendar-bound.

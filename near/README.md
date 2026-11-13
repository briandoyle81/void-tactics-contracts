# Void Tactics on NEAR

_Written 2026-11-13. Describes the state of the `near-migration-experiment` branch on that date._

Void Tactics is an on-chain tactics game: fleets of NFT ships fight turn-based battles on a 17×11 grid against other players or a campaign AI, and destroying AI ships earns Drone Computation Cores (DEC), a freely tradable token that permanently upgrades your free-ship claims. The game originally ran as ~99 Solidity contracts on Base. This directory is its native NEAR port.

## What was built for the NEAR Hackathon (Games With Real Economies track)

Everything in `near/` was written during the hackathon window. The Solidity project in the rest of the repo is pre-existing and is used here only as a **reference oracle** (see "Proving parity" below). Only the NEAR work is submitted for judging.

**The playable loop, live on one contract:**

1. Register storage once (`storage_deposit`). After that, every game action works from a deposit-less function-call key, so play needs no wallet popups.
2. `claim_free_ships`: 10 free ships (plus 1 per storefront tier). Their stats are rolled by **self-callback randomness** (below) and the ships are constructed automatically, with no separate reveal transaction.
3. `start_node_match`: pick ships under the node's cost cap; the contract builds the AI fleet from the campaign's encounter config.
4. Play: `move_ship` for your turns; **anyone** can call `take_ai_turns` to advance the AI, which runs entirely on-chain (two faction decision trees, pathfinding, line of sight, specials).
5. Destroying variant-2 AI ships pays **DEC** (NEP-245). Winning a node unlocks the next ones in the campaign graph.
6. `turn_in_cores` burns DEC for a storefront tier: **+1 free ship on every future claim**. DEC is transferable, so cores can be farmed and traded peer to peer, and the economy evolves without a dev patch.

## Architecture

```
near/
  crates/vt-core/          pure, deterministic rules (no near-sdk): engine, maps/LOS,
                           AI, effects, ship generation, attributes
  contracts/void-tactics/  the single game contract: state, auth, NEP-145/171/245,
                           storage ledger, randomness, single-player campaign
  tests/                   near-workspaces sandbox tests + seeder + scripted player
  golden/                  differential fixtures exported from the Solidity contracts
  seed/config.json         rules exported from the Solidity deploy module
```

- **One contract for everything** (rendering will be a second, view-only contract). On NEAR, cross-contract calls are asynchronous, so the Solidity call graph (Game → Ships → RandomManager → …) became internal function calls: no callback state hazards and no partial failures.
- **Self-callback randomness.** NEAR only exposes the current block's VRF seed, and a transaction can batch several actions that revert together. Reading the seed in the player's own receipt would let them batch `[mint, action-that-fails-on-a-bad-roll]` and retry. Instead, minting schedules a receipt back to the contract that resolves the value in a later block, which the player can neither predict nor revert.
- **Player-funded storage ledger (NEP-145).** Players prepay storage once, and each call charges the caller exactly the bytes it adds, measured against real `storage_usage()`. Having the game pay instead would let a swarm of free accounts drain the contract's balance. Prepaying keeps gameplay deposit-free, so session keys work.
- **Tokens:** ships are NEP-171; UTC and DEC are NEP-245 token ids inside the same contract.

## Proving parity with the Solidity game

The Rust port is checked against the original contracts, not just against its own tests:

- `scripts/near-golden/exportGolden.ts` runs `GenerateNewShip`/`DroneNames`/`ShipAttributes` on Hardhat for 600+ random seeds. `vt-core` must reproduce every trait, name, stat and cost **bit-for-bit**.
- `scripts/near-golden/exportSinglePlayerGames.ts` plays 16 full campaign matches on the Solidity stack (743 steps: shooting, Ram, Repair, EMP, Flak, Electric Storm, Drone Swarm, retreats, destruction, reactor meltdowns, score and wipe-out endings). `vt-core` replays the human moves, **re-decides every AI turn itself**, and must match the full board after every step, including hidden fields like moved-this-round and last damager.

Both pass. A deliberate one-point damage change fails the replay at the first affected step.

## Build and test

Requirements: Rust (stable), `wasm32-unknown-unknown`, [cargo-near](https://github.com/near/cargo-near) 0.23.

```bash
cd near
cargo test -p vt-core                      # rules + golden parity (fast)
./scripts/build-test-wasm.sh               # contract WASM with test hooks
cargo test -p integration-tests            # sandbox: randomness, storage ledger, full game loop
cargo near build non-reproducible-wasm --manifest-path contracts/void-tactics/Cargo.toml   # release WASM
```

The sandbox suite downloads a local NEAR node on first run. `tests/tests/phase1_loop.rs` is the end-to-end demo:
1. It seeds the real campaign (`ignition/data/singlePlayerStarterContent.json`).
2. It claims ships, then plays a match with a scripted human against the on-chain AI, while a second account drives the AI.
3. It checks the DEC payout against the final board and runs the storefront.
4. It asserts the storage-ledger invariant: every byte the player caused is charged to the player.

Regenerating fixtures from the Solidity side (from the repo root, ephemeral Hardhat network only):

```bash
npx hardhat run scripts/near-golden/exportGolden.ts
npx hardhat run scripts/near-golden/exportSinglePlayerGames.ts
npx hardhat run scripts/near-golden/exportConfig.ts
```

## Status

| Area | State |
|---|---|
| Engine, maps/LOS, all 7 effect resolvers, both faction AIs | Done, golden-verified |
| Ship generation, stats, costs | Done, golden-verified (variant-1 ship names stubbed until the external name generator is ported) |
| Storage ledger, randomness, NEP-171 views, NEP-245 UTC/DEC | Done, sandbox-tested |
| Single-player campaign, free claims, storefront | Done, sandbox-tested |
| Paid purchases, recycling, DroneYard, tutorial, eligibility, medal | Next phase |
| PvP lobbies, roguelike runs | Later phases |
| On-chain SVG renderer contract | Later phase |
| Tournaments, Uniswap v4 lottery hook | Dropped for the NEAR version |

## Libraries and AI-generated code

- Libraries: `near-sdk` and `near-contract-standards` 5.30, `near-workspaces` 0.24, `tiny-keccak`, `borsh`, `serde`, `schemars`, `tokio`, `anyhow`.
- AI assistance: the NEAR port (Rust code, tests, golden-fixture exporters, this README) was written with Claude Code (Anthropic), directed and reviewed by the project author. The game design and the Solidity reference implementation are the author's pre-existing work.

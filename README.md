# Void Tactics Contracts

> **Note for judges:** This is the original Void Tactics contracts repository, submitted with its full commit history. The frontend is submitted the same way ([briandoyle81/void-tactics-fe](https://github.com/briandoyle81/void-tactics-fe)). Everything described under "What's New" below was committed on or after **2026-09-14**, the hackathon start date. The first commit in the hackathon window is `415abd5` ("Refactor game.sol", 2026-09-15); everything up to and including `566362c` (2026-09-13) predates it. Run `git log --since=2026-09-14` to see exactly what was built during the event. Merge commit `3543dec` makes no file changes; it only records the ancestry of a short-lived intermediate copy of this repo (`void-tactics-contracts-eth-ny-26`) so the history stays connected.

Live Deployment: https://www.voidtactics.xyz
Contracts Repo: https://github.com/briandoyle81/void-tactics-contracts
Frontend Repo: https://github.com/briandoyle81/void-tactics-fe

Smart contracts for Void Tactics, an onchain tactical strategy game with NFT ships, configurable fleets, map/lobby flow, and battle outcomes recorded on-chain.

Players build fleets of NFT ships, enter lobbies, compete on a 17×11 grid using movement, weapons, and special abilities, — all resolved trustlessly on-chain. This repository contains the Solidity contracts, Hardhat configuration, and Ignition deployment modules for the full game system.

## Design Philosophy

Void Tactics is built to be **unkillable and composable**. Every rule, every game result, every ship, and every tournament lives on-chain with no proprietary backend required to play. The contracts are the game.

If the original team stops supporting it tomorrow, the game keeps running. Anyone can build a new frontend, a new tournament organizer, a new ship marketplace, or an entirely new game mode on top of the same deployed contracts — without asking permission and without paying platform fees to a middleman. Revenue flows automatically through the protocol to whoever is building on it, including the original deployer.

This extends to the assets themselves. Every ship's art is generated and stored 100% on-chain — no IPFS links, no hosted image servers, no CDN that can go dark. The NFTs are self-contained: the metadata and artwork live in the contracts permanently, regardless of what happens to any external service.

This is the practical difference between a game that is _on-chain_ and one that merely _uses_ a chain. Void Tactics is designed so that the community can own and extend it long after any single team has moved on.

## What's New (Colosseum 9/14-10/12)

Between 2026-09-14 and 2026-10-12 the contracts received about 20 commits (~17.6k lines added across contracts, deploy modules, scripts and docs), and Base Sepolia got several full redeploys. The work focused on making the single-player roguelike campaign deep enough to play for real, and on making the whole system safe to operate live.

### Combat & Rules Overhaul

- **Enemy ships block movement and line of sight.** Before, only terrain did. Now ships screen each other, flank around blockers, and take cover behind allies. A disabled (0 HP) ship stays on the board but no longer blocks fly-past or shots; nothing can land on its tile.
- **Impassable terrain**, separate from the existing LOS-blocking tiles, plus **custom deployment-zone shapes** per map.
- **Map redesign:** the preset map set grew from 35 to 65, including the first 5 PvP preset maps. Maps were authored and validated with a new offline toolkit in `scripts/map-design/` (archetypes, formations, LOS self-checks, difficulty tables, an HTML gallery).
- **No more dead specials.** Ship generation only rolls specials that work for the ship's faction, and `DroneYard.modifyShip` rejects equipping a special that does nothing.
- **Duplicate-ship guard:** `Fleets.createFleet` now reverts `DuplicateShipId` if one ship appears twice in a fleet.

### Ship Attributes, Costs & Variant Balance

- **Attributes are versioned per variant, the same way costs are.** One `setVariantAttributes` call publishes a complete new version and makes it live. Specials are pinned per game, so a retune never changes a match already in progress.
- **Variant 2 rebalance.** Its specials were remapped to slots 1–3, with matching V2 renderers. The numbers came from a balance simulator (`scripts/balance-sim/`) and are documented in `docs/variant-balance.md`.

### AI & Roguelike Campaign

- **Per-variant AI:** new `Variant1AI` and `Variant2AI` contracts behind an `AIBehaviorRegistry`, with a large rework of `AIBehavior.sol`. This replaces the old `RoguelikeAIController`.
- **Batched AI turns:** `takeAITurns(gameId, maxMoves)` on both `SinglePlayerMatch` and `RoguelikeMatch` runs several AI moves in one transaction.
- **Roguelike progression:** reworked campaign content and node map, carry-forward ship HP fixes, and run state that records the variant required at run start. As of 2026-10-12, ships that retreat from a mission stay in the run's fleet instead of being dropped.
- **Per-faction kill rewards:** ships owned by the AI now pay out a per-faction reward token through `FactionRewardTokenRegistry`, instead of always paying DEC.

### Upgradeable-by-Design Infrastructure

- **`GameEngineRegistry`** lets anyone trustlessly look up which `Game` engine serves a given `gameId`. A future rules upgrade can ship as a new engine that only applies to new games, without breaking matches already in progress.
- **`GameLens`** is a read-only aggregator (owned ships, campaign graph, run view) that cuts frontend RPC calls and their cost.
- **RPC cost reductions:** player topics on events are indexed, and map names and node text moved off-chain, which saved bytecode in contracts that sit right at the 24 KiB limit.

### Economy & Launch Readiness

- **USD-denominated ship pricing:** a real deploy converts a fixed USD tier curve (`$4.99`–`$49.99`) to wei using the live ETH/USD price, rather than hard-coding wei amounts.
- **Uniswap v4 UTC lottery:** deploy and config refinements, a capped entry weight, draws that can resolve with no winner, and liquidity-withdrawal and ownership-transfer scripts.
- **Ops tooling:** a testnet ETH sweeper, claim-eligibility toggles, a medal-grant script, and a sturdier Ignition retry helper.

### Audits Completed During the Hackathon

Each audit is a live tracker; resolved items are struck through with a dated note.

- `docs/audit-2.md`: security review, with the remaining findings fixed
- `docs/gas-audit.md`: gas efficiency, followed by a full `Game.sol` refactor
- `docs/tokenomics-audit.md`: value-extraction review that assumes a hostile, profit-seeking actor
- `docs/upgrade-safety-audit-2026-09-29.md`: checks whether any owner/admin action could corrupt a lobby, game, run or tournament already in progress. All fixes were deployed on 2026-09-30.

Dated frontend handoff docs (`docs/frontend-handoff-*.md`) record each step of this work as it shipped.

### Previously Built (before 2026-09-14)

The tournament system with World ID registration (`Tournament.sol`), Walrus match records (`GameBlobRegistry`), the `gameId == lobbyId` unification, the original DEC economy, and the Uniswap v4 lottery hook's core mechanics all came before this hackathon. This hackathon hardened them; it did not introduce them.

---

## Deployed Contracts (Base Sepolia, chain 84532 — deployed 2026-10-12)

These are the contracts behind https://www.voidtactics.xyz.

| Contract                     | Address                                      |
| ---------------------------- | -------------------------------------------- |
| `Game`                       | `0xeA7AA5c9cbfC3DcBD32385f489352Ad405d1B5Ad` |
| `GameEngineRegistry`         | `0x7d29c7054a58EFda1AF1fDE9C1938771966860a8` |
| `GameLens`                   | `0x0E8e714097d9636fED48fdeA8FB858Eb7D4F9Fa1` |
| `GameResults`                | `0x7C5590e685c9241d3eBfBc97700cee5176DDEC75` |
| `Lobbies`                    | `0xD28938F07e18c6D1bB390c16706102Dc9961CEF9` |
| `Fleets`                     | `0x02DE6e5535A58F11d949Dbd2E5d381B503895A6c` |
| `Ships`                      | `0xFca4B4eFEe42DFfDeF4A9483F6a3d810326CfA8c` |
| `ShipAttributes`             | `0xcccD3968b2E6f64d9E80C6354441D969Af1C7d02` |
| `Maps`                       | `0xb3d36AA415D609A7AF48cfA7328F0524E8AA7427` |
| `PvPMatch`                   | `0xB4e0f2b66B0E449755CEEB9c9AA7b52293E64290` |
| `SinglePlayerMatch`          | `0xC1913a15E5f53013Ad03A5Ec1246Cb05c9D5975E` |
| `RoguelikeMatch`             | `0x1d4dbb2f166E0138b6933efacf2C9A4e27B035ad` |
| `RoguelikeRun`               | `0x24E8a5B15C83E0E263922534c87B4677F27143d1` |
| `AIBehaviorRegistry`         | `0x4d5f84F8e6b88e984C3f70d5D0C976E936dEa219` |
| `FactionRewardTokenRegistry` | `0xf7Bcb16CA69eA7dD5c6DC359152A1aB2C4C9a905` |
| `Tournament`                 | `0x629EB032FB0316Fa09A0519E03d3337f389b1817` |
| `GameBlobRegistry`           | `0x79566360474fdd09977ea97dDb845fd94db414E7` |
| `UniversalCredits`           | `0x777Bee9332148782448D0e4F49AB35C39CE6c3f2` |

Full address list: `ignition/deployments/chain-84532/deployed_addresses.json`

---

## Tech Stack

- Solidity `0.8.28`
- Hardhat + Ignition
- Viem tooling via `@nomicfoundation/hardhat-toolbox-viem`
- OpenZeppelin Contracts
- World ID on-chain verification (`IWorldID.verifyProof`, Base Sepolia testnet router)
- Walrus decentralized storage (blob references committed on-chain via `GameBlobRegistry`)
- Uniswap v4 (UTC lottery hook)
- Dynamic wallet/auth (frontend, separate repo)

## Quick Start

### 1) Install dependencies

```bash
npm install
```

### 2) Configure environment

Create a `.env` file in the repository root:

```env
METAMASK_WALLET_1=0xYOUR_PRIVATE_KEY
```

### 3) Compile contracts

```bash
npx hardhat compile
```

### 4) Run tests

```bash
npx hardhat test
```

## Deployment

### Full suite

```bash
npx hardhat ignition deploy ignition/modules/DeployAndConfig.ts --network base-sepolia
```

### Authorize the backend minter

```bash
npx hardhat run scripts/allowFirebaseMinter.ts --network base-sepolia
```

Retry helper for interrupted Ignition deploys:

```bash
./scripts/ignition-deploy-retry.sh --network base-sepolia --deploy-script ignition/modules/DeployAndConfig.ts
```

## Repository Structure

- `contracts/` — core game contracts and token/NFT logic
  - `Tournament.sol` — single-elimination tournament with World ID gate and Walrus match records
  - `GameBlobRegistry.sol` — on-chain index of Walrus blob IDs per completed game
  - `Game.sol`, `Lobbies.sol`, `Fleets.sol` — core game loop
  - `GameEngineRegistry.sol` — maps each `gameId` to the `Game` engine that serves it
  - `GameLens.sol` — read-only aggregated views for the frontend
  - `SinglePlayerMatch.sol`, `RoguelikeMatch.sol`, `RoguelikeRun.sol`, `PvPMatch.sol` — match orchestrators
  - `AIBehavior.sol`, `AIBehaviorRegistry.sol`, `Variant1AI.sol`, `Variant2AI.sol` — on-chain AI opponents
  - `Ships.sol`, `ShipAttributes.sol` — NFT ships and attribute system
  - `GameResults.sol` — canonical on-chain win/loss record
  - `Maps.sol` — configurable game maps with scoring objectives
- `ignition/modules/` — Hardhat Ignition deployment modules
- `test/` — contract tests
- `scripts/` — deployment and maintenance scripts, plus offline design tooling (`map-design/`, `balance-sim/`, `renderer-pipeline/`)
- `docs/` — design docs, tournament spec, and audit notes

## Notes for Reviewers

- Contract size is enforced at compile time via `hardhat-contract-sizer`; the "ignore contract size" flag is never set (see `.cursor/rules/` and `CLAUDE.md`)
- World ID integration uses on-chain `verifyProof` (not a backend check), so sybil resistance is enforced at the contract level with no trusted intermediary
- Walrus blob integrity: the on-chain `blobId` is an opaque `bytes32` pointer; prize outcomes always derive from `GameResults`, never from blob content
- Every rule, including AI turns, is resolved on-chain. The frontend only submits moves and reads state.
- `Game` and `Ships` sit within a few dozen bytes of the 24 KiB limit, so new features ship as separate contracts (engine registry, lens, per-variant AI, orchestrators) instead of growing those two
- Audit trackers written during the hackathon: `docs/audit-2.md`, `docs/gas-audit.md`, `docs/tokenomics-audit.md`, `docs/upgrade-safety-audit-2026-09-29.md`. `docs/pre-audit.md` is the earlier internal review.
- Multiple testnets are configured in `hardhat.config.ts` (Base Sepolia, Flow Testnet, Ronin Saigon, XAI); the live deployment targets Base Sepolia

## License / Usage

All rights reserved unless otherwise stated.
This repository is shared for evaluation and learning; reuse in production or derivative commercial projects requires explicit permission.

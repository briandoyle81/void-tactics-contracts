# ETH Global Remote — Live Plan (v2)

_Written 2026-09-10. This is the current, actionable plan only — not the reasoning that produced
it. That reasoning (rejected designs, eligibility investigations, pitches) lives in
`docs/eth-global-remote-strategy.md`, kept as historical record; this document supersedes it for
day-to-day reference. Re-check this plan's assumptions against the live prize sheet
(`docs/eth-global-remote.md`) if read much later — sponsors sometimes edit prize sheets mid-event._

## Overview

Void Tactics is entering ETH Global Remote as a **Continuity** team. Three sponsor picks:

1. **The Graph** — locked in.
2. **World (Selfie Check)** — locked in.
3. **Third slot** — **Uniswap** is the primary choice; **Ledger** is the fallback / 4th priority.

All contract-side work follows this repo's standing rules: `npx hardhat test` after confirming
`PRODUCTION` is `false` in `ignition/modules/DeployAndConfig.ts`; any real deploy targets **Base
Sepolia only**, never mainnet or another testnet, and never without explicit direction for that
specific deploy; contract size is re-checked after any change to `Ships.sol`/`Tournament.sol`
(both near the 24 KiB limit) — new logic goes in standalone contracts wired through the existing
authorized-minter/allowlist pattern, not grown in place.

---

## Pick 1 — The Graph: "Best Use of Composable or Standardized Graph Products"

$5,000 pool (1st $2,500 / 2nd $1,500 / 3rd $1,000). Not Continuity-restricted — open to both
pools. "Live data" just means not mocked/local/static per the track's own text — testnet data via
Subgraph Studio genuinely qualifies.

**Hard dependency on Pick 3 (accepted, not hedged):** the track requires either composing 2+
Graph products or building meaningfully on a standardized schema (`docs/eth-global-remote.md`
lines 25-27) — plain "query one Subgraph with no standardization" explicitly does not qualify,
and the fallback the track names for that case is the AI track, which is deliberately not being
pursued. This plan uses exactly one Graph product (a Subgraph) and gets its only standardization
story from the Messari DEX-AMM schema applied to the Uniswap pool in Pick 3 — every other data
source below is plain custom entities with no standards story of its own. **If Pick 3 (Uniswap)
doesn't ship, Pick 1 loses its eligibility path for this track entirely** — there is no budgeted
fallback (e.g. a real Substreams composition) if that happens. Treat Pick 3 shipping, with a
genuinely complete DEX-AMM implementation (the real protocol-wide aggregation entities, not just a
`Swap` listener), as a hard prerequisite for Pick 1, not a nice-to-have.

**Tooling, confirmed current:** `@graphprotocol/graph-cli@0.98.1`,
`@graphprotocol/graph-ts@0.38.2`, manifest `specVersion: 1.3.0`, mapping `apiVersion: 0.0.9`,
network string `base-sepolia` (chain id 84532 — confirmed indexable via Subgraph Studio). Studio's
free tier (100,000 queries/month) covers a demo dashboard with no billing setup needed.

**Contracts to index, with real event surfaces (verified by reading the source, not assumed) and
real deployment block numbers (from `ignition/deployments/chain-84532/journal.jsonl`, use as each
data source's `startBlock`):**

- **`UniversalCredits.sol`** (UTC) — block 46381910. Plain ERC-20, standard `Transfer` only, no
  custom mint/burn events, no `_update` override. Custom entities, straightforward.
- **`DroneEnergyCores.sol`** (DEC) — block 46381267. Same as UTC — plain ERC-20, no surprises.
- **`Ships.sol`** — block 46381843. **Not plain ERC-721 — implements ERC-5192 (lockable).**
  `_update` emits `Locked`/`Unlocked` alongside `Transfer`, and transfers **revert unless both
  sender and receiver have `amountPurchased >= 10`** (a real, previously-undocumented gate). The
  schema must model lock state and this transfer restriction — a naive "index Transfer" design
  would misrepresent actual ship movement, since most addresses can't receive/send ships at all
  until they've bought 10.
- **`ShatteredHiveMedal.sol`** — block 46381965. **Unconditionally soulbound** — `_update` reverts
  on any post-mint transfer. There is no provenance to show, ever, beyond the single mint event.
- **`GameResults.sol`** — block 46381268. Real events: `GameResultRecorded(gameId, winner, loser,
  timestamp)`, `PlayerStatsUpdated(player, wins, losses, totalGames)`.
- **`Tournament.sol`** — block 46382113. **16 events**, richer than originally scoped:
  `TournamentCreated`, `SponsorAdded`, `Registered` (carries `nullifierHash` — direct input for
  the abuse-detection panel), `TournamentClosing`/`TournamentStarted` (the two-step randomness
  reveal), `MatchGameAssigned`, `MatchResolved` (carries a `walrusBlobId` field — a dead reference
  to the now-permanently-disabled Walrus system; index it but don't present it as working replay
  data), `NextRoundMatchCreated`, `TournamentFinalized`, `PrizeClaimed`, `TournamentCancelled`,
  `Refunded`, `MatchForfeited`, `MatchStalled`, `WinEffectsSet`, `WinEffectFailed`.
- **`FreeShipClaim.sol`** — block 46381854. Emits `FreeShipsClaimed(player, amount)` **in source
  only** — confirmed not yet in the live Base Sepolia deployment or the frontend's compiled ABI.
  Cannot be indexed until a real redeploy happens (blocked on explicit deploy authorization, not
  an open task).
- **`TutorialClaim.sol`** — block 46381909. Already emits `TutorialCompleted(player, winPath,
  shipsCreated)` — indexable as-is.

**Standardized schema, scoped correctly:** Messari's schemas are organized by DeFi protocol
category (DEX/AMM, lending, yield, NFT marketplace) — not a generic token schema, and a poor,
forced fit for plain game tokens. Use Messari's **DEX-AMM schema**
(`schema-dex-amm.graphql`, MIT-licensed, confirmed to exist in `messari/subgraphs`) **only for the
Uniswap v4 pool from Pick 3.** Note it's protocol-shaped, not single-swap-shaped — using it
"meaningfully" per the track's own language means populating its protocol-wide aggregation
entities (`DexAmmProtocol`, daily usage/financial snapshots), not just listening for `Swap`
events; budget real effort here, not a drop-in listener. UTC/DEC/Ships/Medal/GameResults/
Tournament/claims are all plain custom entities alongside it — that's fine, the track's
qualification is "compose 2+ products OR build on a standardized schema," not "everything must be
standardized."

**Dashboard** (frontend deliverable, lives in the separate frontend repo, not this one — depends
on the subgraph being deployed first): one panel per real use case —

1. **Player history** — per-wallet win/loss, tournament, and claim history. Replaces the
   frontend's current raw-event-log scanning.
2. **Abuse detection** — flags same-block-funded wallet clusters and repeat-claim attempts against
   `FreeShipClaim`/`TutorialClaim`, using `Tournament.Registered`'s `nullifierHash` as a
   cross-reference signal. Ops-facing, not player-facing; doubles as before/after evidence for the
   Selfie Check gating in Pick 2.
3. **Economy transparency** — UTC/DEC supply, mint/burn rate, top holders. Public-facing.
4. **Ship lock/ownership panel** (replaces "ship/medal provenance" — dropped, see above). Ships:
   lock state and real transfer history subject to the `amountPurchased >= 10` gate. Medal:
   one-time mint ownership record only, not a transfer history — it can never have one.

Deliverable: public repo, README pointing at the relevant contracts/lines, demo showing the
dashboard against live Base Sepolia data.

---

## Pick 2 — World: Selfie Check

$3,500 pool, up to 3 teams at $1,166 each. Not Continuity-restricted.

**Architecture corrected from the original plan, and built.** Selfie Check has **no on-chain
verification path** — confirmed directly against World's own docs (`docs.world.org`, checked
three separate pages): verification is an off-chain REST call to World's verify endpoint, unlike
Orb-level World ID, which `Tournament.sol` already correctly uses on-chain via `IWorldID`
(`groupId = 1`, "Orb-verified, on-chain only" per `IWorldID.sol`'s own doc comment). So "reuse
`Tournament.sol`'s `ByteHasher`/nullifier/on-chain-proof pattern," the original plan for this
pick, isn't executable — there's no proof for a contract to verify. Rebuilt around the pattern
already used elsewhere in this project for exactly this shape of problem (the frontend repo's
Fireblocks Flow fulfillment: a backend verifies something off-chain, then an authorized backend
address relays the result on-chain):

- **`contracts/IEligibilityProvider.sol`** — a new interface, same swappable-provider shape as
  `Ships.sol`/`Tournament.sol`'s existing `IRandomManager`: the consuming contract doesn't know or
  care *how* eligibility is established, only whether `isEligible(player)` says yes.
- **`contracts/SelfieCheckEligibilityProvider.sol`** — the real implementation. A backend
  (holding an address on its own `authorizedVerifiers` allowlist — same authorized-caller shape as
  `Ships.isAllowedToCreateShips`) calls `markVerified(player, nullifierHash)` after confirming a
  Selfie Check pass against World's off-chain API; `verifiedUntil[player]` is then set to `now +
  90 days`, matching Selfie Check's own real validity window (confirmed via World's docs: "Selfie
  Check has a 90-day inactivity window"). Nullifier reuse is blocked (with an owner kill switch,
  `nullifierCheckEnabled`, for just that check) so the same verified human can't back multiple
  wallets.
- **`contracts/MockAlwaysEligible.sol`** — local/test stand-in wired by `DeployAndConfig.ts` for
  non-production deploys, mirroring the existing `shipNames`/`MockOnchainRandomShipNames` pattern.
- **Decided: one shared `eligibilityProvider` instance for both consumers, not two.** Verifying
  once makes a player eligible for both `FreeShipClaim` and `TutorialClaim` for the same 90-day
  window — `DeployAndConfig.ts` already wires one shared `MockAlwaysEligible` instance to both for
  non-production; the real `SelfieCheckEligibilityProvider` gets deployed and wired the same way
  when production is ready.
- **`FreeShipClaim.sol` and `TutorialClaim.sol` — each has exactly one claim/complete entry
  point, and it's the gated one.** There is no separate "verified" function coexisting with an
  unrestricted original — that was `FreeShipClaimSelfie.sol`'s shape (deleted; see
  `docs/eth-global-remote-strategy.md`'s addendum for that history). The eligibility check is
  built directly into `FreeShipClaim.claimFreeShips` and into `TutorialClaim._markTutorialCompleted`
  (the shared internal helper both `completeTutorialWinPath`/`completeTutorialLossPath` call).
  Unset (`address(0)`, today's default) means claiming/completing stays fully open — the same
  "not configured yet" pattern as `FreeShipClaim.droneStorefront == address(0)` elsewhere in this
  repo, not a gate with a bypass door. Once a real provider is wired, both are genuinely, fully
  gated with no alternate path. `TutorialClaim.sol` needed `Ownable` added first — it previously
  had no admin surface at all. 9 dedicated tests across the two contracts (default-permissive,
  owner-only setter, blocked-when-unverified, succeeds-once-verified). Sizes: `FreeShipClaim`
  1.631 → 1.959 KiB, `TutorialClaim` 3.088 → 3.834 KiB deployed — no pressure on either.
- Deliverable also requires a feedback document (World ID docs, Developer Portal, Sandbox App
  experience) — not yet written.

**Production deploy wiring — built 2026-09-11.** `DeployAndConfig.ts`'s `PRODUCTION` branch now
deploys the real `SelfieCheckEligibilityProvider` (one shared instance, per the decision above),
owned by the deployer initially and handed to `MAP_EDITOR` in the same end-of-module
ownership-handover block every other `Ownable` contract goes through, then wires it to both
`FreeShipClaim` and `TutorialClaim` via the existing shared `setEligibilityProvider` calls (no new
wiring code needed there — they already accepted whatever `eligibilityProvider` resolved to).
Also calls `setAuthorizedVerifier(FIREBASE_FLOW_MINTER, true)` — the same backend wallet already
trusted to mint ships directly now also relays Selfie Check verification, per explicit direction,
rather than provisioning a second backend signer for it. Confirmed with `npx tsc --noEmit` (catches
the untested `PRODUCTION` branch, since local/test runs only ever exercise the `!PRODUCTION` mock
path) and a full test run (650/650 passing).

**Known placeholder, not final:** `FIREBASE_FLOW_MINTER` and `MAP_EDITOR` are today's dev-time
addresses reused across several independent trust roles (ship minting, Selfie Check verification,
map/content editing, and general contract ownership). Before a real production deploy, all
admin/backend keys get separated into distinct, purpose-specific keys — see `docs/pre-audit.md`'s
"Addendum — Admin/Backend Key Separation for Production Deploy" for the plan. Not yet done.

---

## Pick 3 — Third slot

Chainlink VRF is **explicitly declined** by the project owner — not under consideration.
**Primary choice: Uniswap. Fallback / 4th priority: Ledger.**

### Primary — Uniswap: "Best Uniswap Stack Contribution" (Continuity), $2,000 (1st $1,000 / 2nd $1,000)

Confirmed as real, independent product value (a genuine UTC secondary market), not just a
hackathon target. **Also now a hard prerequisite for Pick 1's eligibility** — see Pick 1 above:
Pick 1's only standardized-schema story is the Messari DEX-AMM schema applied to this pool, with
no budgeted fallback if this pick doesn't ship.

**Build:**

1. Deploy a UTC/ETH Uniswap v4 pool.
2. Seed initial liquidity from the UTC/ETH already sitting in `ShipPurchaser` (withdrawable via the
   existing `withdrawUTC()`/`withdrawFlow()`) — an allocation decision between committing to an LP
   position and keeping funds spendable for giveaways/prizes, not a new revenue mechanism.
3. **Price ceiling:** relies entirely on the existing passive arbitrage — anyone can mint UTC at
   `ShipPurchaser`'s fixed tier price and sell into the pool for profit whenever pool price rises
   above it. Zero new code. Deliberately not pinned tight; occasional excursions above the mint
   rate are accepted by design.
4. **Sell-side lottery hook — built and tested** (`contracts/UTCLotteryHook.sol`, 643/643 repo
   tests passing, including 20 dedicated to this contract):
   - Only UTC→native (`sell`) trades earn entries — reinforces the ceiling arbitrage above (that
     arbitrage trade *is* a sell) rather than competing with it, and adds no floor.
   - One entry per address per draw, sized to that address's **single best (highest) qualifying
     sell in the period — not a sum** across all their trades: a newer, higher-value sell replaces
     the recorded ticket; a newer but lower one leaves it alone. Deliberate — summing would let an
     address inflate its odds by splitting one large sell into many small ones. Winner selection:
     a linear cumulative-weight scan over that draw's unique participants (not binary search —
     simpler, fully sufficient at this scale).
   - **Per-entry weight cap + max win probability — resolved (2026-09-12, docs/audit-2.md HA2-06).**
     A single sell's *credited weight* is capped at `maxWeightPerEntryWei` (default 1 ETH),
     independent of its real, uncapped proceeds — bounds how much one trade (flash-loaned or
     genuinely funded) can inflate one address's odds. Combined with `maxWinProbabilityDenominator`
     (default 10), `resolveDraw`'s random pick is floored at `maxWinProbabilityDenominator *
     maxWeightPerEntryWei` — guaranteeing no address can ever exceed a
     `1/maxWinProbabilityDenominator` share of a draw, not just a bounded absolute weight (which
     alone would still let a whale claim close to 100% of a thinly-participated draw). A pick
     landing beyond real participants' cumulative weight means nobody wins that draw
     (`DrawResolvedNoWinner(drawId)`) — the next qualifying sell just starts accumulating toward the
     next draw, no rollover bookkeeping needed. Reasoning: a flash-loan round-trip here was never a
     fund-theft risk (both legs are real, fee-paying swaps against the real pool) — the actual
     concern was draw fairness, resolved by bounding *share*, not by trying to detect or block the
     flash-loan technique itself.
   - Minimum qualifying trade size **denominated in ETH, not UTC** (`minEntryThresholdWei`) —
     insulates entry cost from UTC's own price swings. **Set to 0.01 ETH.**
   - **Draw eligibility — resolved, and more than just a timer.** A draw only starts once *all*
     of the following hold: `drawInterval` has elapsed since the last draw started (default 24h),
     the draw has **≥ `minParticipants` distinct qualifying sellers (default 3)**, and **≥
     `minTotalWeightWei` total qualifying volume (default 0)**. All three are owner-configurable.
     Time alone is deliberately not sufficient — if a draw hasn't reached eligibility once
     `drawInterval` has passed, it simply keeps running (no state change, no reset) until it does,
     re-checked on every subsequent qualifying swap. A hard `totalWeight == 0` floor always
     applies regardless of configuration, so a degenerate admin setting (both minimums at 0)
     still can't start a draw with literally nothing in it. Triggering itself remains
     permissionless and incidental (checked inside `afterSwap`, not a dedicated standalone
     function) — deliberately fine given eligibility is now activity-gated: if nobody's trading,
     the draw isn't eligible to start anyway, so nothing is lost by not having an explicit
     "start next" call independent of trade activity.
   - Draw resolution reuses the existing `RandomManager` (request-now/reveal-later, the same
     two-step pattern `Ships.constructShip`/`Tournament.buildBracket` already use) — no Chainlink
     VRF dependency. `resolveDraw` itself **is** a dedicated, permissionless function anyone can
     call once ready.
   - **Prize mechanism — resolved.** The owner queues up to 5 hand-crafted `PrizeTemplate`s
     (`queuePrizeTemplate`/`clearPrizeQueue`/`queueLength`) — each resolved draw dequeues the
     oldest (FIFO) and mints it via `Ships.createSpecificShip` (not the generic random-rolled
     path), with the ship's name embedding the draw id ("Legendary Draw #N") so winners are
     provably distinct from each other. Validated at queue-time: variant within
     `Ships.maxVariant()`, armor/shields mutual exclusivity (neither is enforced by
     `createSpecificShip` itself), stat tiers ≤ 2. **If the queue is empty, falls back to a random
     "4-star" ship** — `Ships.createShips(winner, 1, fallbackVariant, 4, false)`, which (via
     `Ships.sol`'s own existing tier-based rank logic) gives that single mint the tier-4 rank
     count's first slot — rank 5, the same top rank a real tier-4 pack's first ship gets — through
     the ordinary random-generation path (winner still calls `constructShip` themselves to reveal
     it, same as any other purchased ship). No new generation logic — reuses `Ships.sol`'s
     existing, already-authorized mechanism exactly as `purchaseWithFlow` does for a tier-4 pack's
     best slot.
   - Real Uniswap v4 hook mechanics confirmed along the way, not assumed: hook addresses are
     permission-encoded (low 14 bits must match declared permissions), so deployment needs a mined
     CREATE2 salt — `contracts/Create2Deployer.sol` + `scripts/hookMiner.ts` (a TypeScript port of
     Uniswap's own `HookMiner.sol`, since this is Hardhat/viem, not Foundry) handle this. The
     trader identity a hook receives from `PoolManager` is the calling *router*, not the end user —
     `sender`/`tx.origin` were both rejected (see `CLAUDE.md`'s "Never Use `tx.origin`" rule, added
     from this exact finding); the hook decodes the real trader from `hookData`
     (`abi.encode(address)`) instead, which the frontend/router must populate.
5. `FEEDBACK.md` + Uniswap Developer Feedback Form submission, per the track's qualification
   requirements.

**Still open / not yet done:**

1. `minEntryThresholdWei` (0.01 ETH), `drawInterval` (24h), `minParticipants` (3),
   `minTotalWeightWei` (0), `maxWeightPerEntryWei` (1 ETH), and `maxWinProbabilityDenominator`
   (10, i.e. never better than a 1-in-10 chance) are all live, sensible-but-not-yet-validated
   defaults — worth confirming against real expected trading volume once there's live data to
   check them against, not left as permanent assumptions.
2. **No pool has actually been deployed yet, but a concrete deploy plan is written (2026-09-12).**
   `UTCLotteryHook.sol` itself is built and tested against a real local `PoolManager`, but isn't
   live anywhere. A new standalone script, `scripts/deployUTCLotteryPool.ts` (not yet written —
   see the plan), will mine a CREATE2 salt, deploy the hook, initialize the real pool, seed
   initial liquidity, grant the hook ship-minting rights, and run a real smoke-test swap on Base
   Sepolia, following exactly this repo's already-proven local test recipe
   (`test/UTCLotteryHookSwap.test.ts`) against real infrastructure instead of local test doubles.
   - **Real Base Sepolia addresses confirmed this session** (independently verified via live
     `eth_getCode`, not assumed): `PoolManager` `0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408`;
     `PoolSwapTest` `0x8b5bcc363dde2614281ad875bad385e0a785d3b9`; `PoolModifyLiquidityTest`
     `0x37429cd17cb1454c34e7f50b09725202fd533039` (Uniswap's own official testnet routers, real
     deployed contracts, not something this repo compiles/deploys itself); canonical CREATE2
     "deterministic deployment proxy" `0x4e59b44847b379578588920cA78FbF26c0B4956C`.
   - **Bug found and fixed:** `contracts/Create2Deployer.sol`'s own header comment had the
     canonical CREATE2 proxy address truncated by one trailing character (39 hex digits, not a
     valid address) — corrected to the address above.
   - **Risk framing, deliberately re-scoped:** the hook's pool-lock mechanic
     (`PoolManager.initialize`'s first successful call against a hook address permanently binds
     it to one pool — `PoolAlreadyLocked()` on any later call, no on-chain fix) is real, but is
     **not currently high-stakes**: there's no canonical `UniversalCredits` token or accumulated
     pool history yet, and this repo already expects repeated full test redeploys. If a hook
     gets locked to the wrong pool, the fix is just mining and deploying a fresh hook address —
     cheap, a few minutes, free testnet gas. So the deploy script favors low-friction,
     non-interactive safety checks (state re-reads, `simulateContract` dry-runs, loud aborts on
     genuine anomalies) over manual confirmation ceremony for now, with an explicit note on
     where to add heavier ceremony back in once a pool is meant to be long-lived (production, or
     a testnet iteration the team decides to stop churning).
   - **Key-custody decision:** a separate `SHIP_MINTER_PRIVATE_KEY` has been added to `.env`
     specifically for the one owner-gated call this whole flow needs
     (`Ships.setIsAllowedToCreateShips(hookAddress, true)`, since `Ships` ownership transfers to
     `MAP_EDITOR` at the end of the main game redeploy) — the script verifies this key's address
     against `Ships.owner()` at runtime rather than assuming it matches.
   - **LP seed sizing decision:** not precision-critical, per explicit direction ("we can mint at
     will and we'll likely redeploy several times in testing") — defaults to a live-computed
     ~$10-equivalent of UTC, sourced through `ShipPurchaser.purchaseUTCWithFlow` (not a direct
     authorized mint) so the pool's initial price is automatically consistent with the real
     mint-rate ceiling this design already relies on.
   - Full step-by-step plan: `/Users/briandoyle/.claude/plans/gentle-launching-naur.md` (local
     plan file, not checked into this repo).
3. The prize queue starts empty — no `PrizeTemplate`s have actually been curated/queued yet; until
   the owner does, every draw uses the random-4-star fallback.
4. `fallbackVariant` defaults to `1` (owner-configurable) — worth confirming that's actually the
   intended variant for the fallback prize before going live.

### Fallback / 4th priority — Ledger: "Continuity" track, $1,500 (1st $1,000 / 2nd $500)

Only pursue if Uniswap falls through.

**Confirmed inventory** (checked against the repo, not assumed): `METAMASK_WALLET_1` (a plaintext
key from `.env`) is the sole signer for five networks in `hardhat.config.ts` — `base-sepolia`,
`flow-testnet`, `ronin-saigon`, `polygon-amoy`, `xai-testnet`. It signs exactly two kinds of real
transaction: (1) every Ignition deploy against those networks, and (2)
`scripts/allowFirebaseMinter.ts`'s `setIsAllowedToCreateShips` call — the only post-deploy
owner-gated write script that exists today. `scripts/healthcheck.ts` also uses a wallet client but
only for a read-only `simulateContract` — out of scope, nothing to gate there.

**Build:**

1. Move `METAMASK_WALLET_1`'s role to Ledger's Key Ring CLI (`wallet-cli ring`) as the signer
   backend for `hardhat.config.ts`'s network `accounts` — covers both real uses (deploys and
   `allowFirebaseMinter.ts`) in one change.
2. **Open question:** does Key Ring CLI support enrollment from a headless CI/VPS deploy path, or
   does it require a physical device attached to whatever machine runs deploys/scripts? Resolve
   before committing to an approach.
3. Demo: a real Base Sepolia transaction (an `allowFirebaseMinter.ts` grant/revoke run, or a
   redeploy) signed via the Key Ring CLI instead of the plaintext key — video, five minutes or
   less.

**Important clarification for anyone building this:** the hardware-confirmation gate sits on the
*owner's* rare grant/revoke admin action only. It never touches the Firebase backend's own
automated per-ship minting, which signs with its own separate key
(`DEFAULT_MINTER = 0x7f9dc2D68FF842EC79DA722B68E3ca7e5aa31CCb` in the script) and must stay fully
automated.

**Eligibility — check before building:** Ledger's sponsor blurb frames the whole $5,000 pool as
"Build AI agents and AI-powered products that use Ledger as the trust layer," but the Continuity
sub-prize's own example directions (hardware signer for a shipped app, Key Ring as `.env` backend,
device confirmation on an existing action) don't mention AI at all — leans toward "eligible,"
but confirm with the track's own organizers/Discord
(`https://developers.ledger.com/ethonline`) before investing build time.

---

## Deploy/build safety reminders

- Test suite: `npx hardhat test`, after confirming `PRODUCTION = false` in
  `ignition/modules/DeployAndConfig.ts`.
- Any real deploy (new World ID gate, Ledger signer swap, live Uniswap pool) targets **Base
  Sepolia only** — no mainnet or other testnet without explicit direction for that specific
  deploy.
- New contracts get their own test file, following this repo's existing per-contract pattern.
- The Graph subgraph is verified against live Base Sepolia data through Subgraph Studio once
  deployed — mocked/local data does not satisfy that track's qualification requirement.

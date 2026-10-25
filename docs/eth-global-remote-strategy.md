# ETH Global Remote — Continuity Track Prize Strategy

_Written 2026-09-08. Describes `docs/eth-global-remote.md` (the ETHGlobal Remote sponsor prize
sheet) as it read on that date — re-check line numbers/amounts if this doc is read much later,
sponsors sometimes edit prize sheets mid-event._

## Context

Void Tactics is entering ETH Global Remote as a **Continuity** team — the game already shipped
(pre-hackathon repo, plus a prior ETH NY 2026 hackathon round that added World ID Tournament
gating, Walrus match records, and Dynamic wallet auth). `docs/eth-global-remote.md` lists this
event's sponsor prize tracks; the goal is to pick 3 sponsors and build real, Continuity-eligible
extensions — not cosmetic integrations bolted on to qualify.

A first pass at this analysis was too shallow: it proposed a "verify AI ship ownership with
World AgentKit" pitch without checking whether the game's "AI ownership" concept was actually a
real agent identity. Three research passes were sent to verify every load-bearing claim against
the actual contracts before recommending anything again. Two claims from the first pass turned
out to be wrong or weak, and one new, much stronger opportunity surfaced that wasn't in the
first pass at all:

- **Wrong:** "AI-owned ships" is not an autonomous agent concept. `SinglePlayerMatch._mintAIFleet`
  just mints ships to the match contract's own address; `AIShips`/`AIBehavior`/`RoguelikeAIController`
  are deterministic, hardcoded priority-list PvE enemies with id ≥ `2**40`. There is no wallet,
  no off-chain decision-maker, no delegate/operator concept anywhere in the repo. A "verify this
  AI agent" pitch built on this would have been dishonest framing of a PvE labeling convention.
- **Weak:** ENS's natural pairing point (`DroneNames.sol`) turned out to be a pure deterministic
  string generator, not a stored registry — there's nothing to "swap for ENS," so any ENS
  integration would be closer to a cosmetic add-on than the ENSv2 track wants ("central to the
  product, not a cosmetic add-on"). Dropped from the top picks.
- **New and strong:** `FreeShipClaim.sol` (10 free ships / 28-day cooldown, address-keyed only)
  and `TutorialClaim.sol` (one-time ship grant + a `GameResults.addWin`/`addLoss` write, also
  address-keyed only) have **zero human-uniqueness protection** — unlike `Tournament.sol`, which
  already gates entry behind Orb-level World ID (`ByteHasher` + nullifier tracking). Any script
  can mint unlimited fresh wallets and drain free ships or inflate win/loss stats forever. This
  is a real, currently-exploitable gap in a shipped product, not a hackathon strawman.
- **Confirmed real:** `docs/pre-audit.md` and `RandomManager.sol`'s own comments already name
  **Chainlink VRF** as "the only way to remove [a documented residual randomness risk]
  entirely." `IRandomManager` was kept deliberately stable so a provider swap needs no changes
  to `Ships.sol`/`Tournament.sol` beyond their existing owner-gated config setters.
- **Needs your confirmation — flagged, not asserted:** `ShipPurchaser.purchaseUTCWithFlow()` is
  a `payable` direct mint-sale — whatever native currency the deployed chain uses as
  `msg.value` (ETH on the live Base Sepolia deployment; "Flow" in the function name does not
  mean the Flow blockchain is actually in play) buys newly-minted UTC at a fixed admin-set
  price per tier. This is one-directional and already solves "buy UTC with native currency" —
  it needs no DEX. Separately, `docs/UTC_Price_Prediction_10k_Players.md` models an "external
  market price" for UTC and arbitrage against that fixed mint rate, which only means something
  if UTC actually trades somewhere with a price that can diverge from the mint rate — no such
  secondary market exists today. The Uniswap idea below was: deploy a real UTC/ETH pool so that
  external market actually exists, not to replace `purchaseUTCWithFlow`. **Note (2026-09-08):
  `docs/UTC_Price_Prediction_10k_Players.md` explicitly models a "0.95 - 1.0 FLOW per UTC"
  target price, i.e. it assumes Flow blockchain was the actual deploy target — but the live
  deployment is Base Sepolia (ETH-denominated). That doc needs to be re-examined against the
  current deploy target before anything here leans on its numbers.** ~~Unconfirmed whether a
  real secondary market was ever an actual goal here vs. a modeling assumption in that doc —
  if it's the latter, this pitch loses its grounding and should be dropped.~~ **Resolved
  2026-09-10, confirmed by the project owner directly (not inferred): a real UTC secondary
  market is "a real and necessary goal, not just for the hackathon."** This pitch keeps its
  grounding — see the ceiling-over-floor design decision and tightened proposal under pick C
  below, developed once this was confirmed. The FLOW-vs-Base-Sepolia denomination mismatch in
  `docs/UTC_Price_Prediction_10k_Players.md`'s specific numbers is a separate, still-open loose
  end — the *goal* is confirmed real, but that doc's actual price targets still need
  re-examining against the live ETH-denominated deployment before anything leans on them.
- **Confirmed real, low-risk:** the deploy/ops tooling (`scripts/allowFirebaseMinter.ts`, the
  `METAMASK_WALLET_1` hot key pattern in `.env`) is exactly the kind of leaked-secret risk
  Ledger's Key Ring track targets, and fixing it touches ops scripts, not contract bytecode — no
  pressure on the 24 KiB contract-size limit at all.

Every dollar figure, prize-pool split, and Continuity-eligibility tag below was checked
line-by-line against `docs/eth-global-remote.md`. One inaccuracy from an earlier draft of this
analysis was caught in that pass — see the Chainlink section's correction note.

## Tracks deprioritized after review

Kept out of the final picks; noted here for completeness, each checked against
`docs/eth-global-remote.md`:

- **Hedera** ($15,000 total pool) — its only pool-restricted prize, "♻️ Continuity — $1,000"
  (lines 306-322), explicitly requires the project to have "already exist[ed] in some form on
  Hedera" — Void Tactics has never touched Hedera, so we're not eligible for that specific prize
  regardless of our overall Continuity status. Its other three prizes (AI & Agentic Payments
  $6,000, Open Source Harness $2,000, Tokenization of Anything $6,000, lines 147-305) carry no
  pool restriction and we could technically submit, but none have a natural seam with the
  existing FLOW/Base-denominated game.
- **Arc/Circle** ($10,000 total) — has two Continuity-tagged prizes: "Best DeFi or Agentic
  Application — $1,666" (lines 399-435) and "Launch on Arc Testnet & Push to Mainnet — $1,500"
  (lines 466-491, requires deploy-or-deploy-ready on **Arc mainnet by September 30**). Both are
  eligible in principle, but the game's economy is FLOW/UTC-denominated with no USDC/stablecoin
  surface today, and a mainnet-deploy requirement needs deliberate sign-off per this repo's
  deploy-safety rules — large lift, weak narrative fit.
- **Privy** ($5,000 total) — neither prize (lines 860-901) carries a Continuity tag, but more
  importantly Void Tactics already ships Dynamic for wallet/auth; adding Privy would duplicate
  that shipped integration rather than extend it.
- **1inch** — "Build an Aqua App - Continuity Track — $2,000, 1st $1,500 / 2nd $500" (lines
  627-654) is Continuity-eligible, but there's no existing swap/AMM code in the repo to build on
  (confirmed via grep — zero hits for swap/DEX/AMM/router-as-DEX), a bigger novel lift than the
  Uniswap v4 hook option for a comparable prize size.
- **Bazantic** — "Help an Agent Use Your Hackathon Project — $1,000, up to 2 teams at $500"
  (lines 1049-1069) is Continuity-eligible, but it requires wrapping an internal queryable API
  in an x402/MCP gateway — Void Tactics has no backend API of its own to wrap (the "backend" is
  just a minter-authorization script), so this would mean building net-new API surface just to
  have something to agentify.
- **ENS** — "Best Integration of ENSv2 into an Existing Project — $500" (lines 708-718) is
  Continuity-eligible and cheap, but the natural pairing point we hoped for (`DroneNames.sol`)
  turned out to be a pure deterministic string generator with no stored registry to swap out —
  any ENS integration would land closer to the "cosmetic add-on" the track explicitly warns
  against than to something "central to the product."

## Locked-in picks (2 of 3 sponsors)

### 1. The Graph — ~~"Best AI Tooling or AI Use Case with The Graph (Continuity)" — $5,000 pool~~

**Pivoted 2026-09-10 — dropped the AI-Continuity track, switched to "Best Use of Composable or
Standardized Graph Products" (lines 11-44 of `docs/eth-global-remote.md`), same $5,000 pool (1st
$2,500 / 2nd $1,500 / 3rd $1,000).** Reasoning: the game's own AI (`AIShips`/`AIBehavior`/
`RoguelikeAIController`) is deterministic, hardcoded priority-list PvE — not an autonomous agent
concept (see the "Wrong" bullet under Context above) — so leaning on "AI" framing for this pick
would have been the same dishonest-framing mistake already caught and rejected once for the
AgentKit pitch. The AI-Continuity track's own eligibility only worked if we actually built a
Subgraph MCP server as new AI-facing tooling; we decided that's not worth doing. Note this new
track carries **no Continuity-only tag** (unlike the AI-Continuity track) — open to both pools,
so no protected smaller field, same as the World/Selfie Check pick.

The Composable/Standardized track explicitly rules out a single ad-hoc custom subgraph:
"Simply querying one Subgraph with no composition or standardization does not qualify" (line 27).
It qualifies two other ways instead (line 25): compose 2+ Graph products, or build meaningfully
on a standardized schema. Going with the standardized-schema path — confirmed via
`grep -n "is ERC20\|is ERC721" contracts/*.sol`: `UniversalCredits.sol` (UTC) and
`DroneEnergyCores.sol` (DEC) are `ERC20`; `Ships.sol` and `ShatteredHiveMedal.sol` are `ERC721`.

No indexer exists anywhere in this repo (or, as far as the contracts repo shows, the separate
frontend repo) — `GameResults`, `Tournament`, `Fleets`, and claim events, plus all UTC/DEC/Ships/
medal transfer activity, are only readable by walking raw chain events today. Build:

- A Subgraph indexing UTC, DEC, Ships, and `ShatteredHiveMedal` transfer/mint/burn activity using
  Messari's **Standardized Subgraph** schema for ERC-20/ERC-721 (authoring/extending a
  Standardized Subgraph is explicitly in scope per line 28) instead of ad-hoc custom entity
  types for that part.
- Custom entities layered on top, in the same subgraph, for the game-specific data that has no
  standard schema to map to: `GameResults` (wins/losses), `Tournament` (registrations, brackets,
  match results — `contracts/Tournament.sol`), and `FreeShipClaim`/`TutorialClaim` claim events.
- Consume live data via an API key from Subgraph Studio (mocked/local data does not qualify per
  the track's own rules, line 26).
- Submit under this track (lines 11-44), documenting the standards leverage per its own
  requirement (line 29: "show what became easier because a shared schema or composed product was
  used").

**Why this is worth building independent of the prize** (all four uses discussed and confirmed
2026-09-10):

1. **Replaces raw event-scanning the frontend already has to do.** No indexer exists today for
   `GameResults`/`Tournament`/claim events — any UI showing win/loss history, tournament results,
   or claim history currently means custom log-scanning outside this repo. A subgraph turns that
   into a GraphQL query.
2. **Sybil/abuse detection for a live, unpatched gap.** `FreeShipClaim`/`TutorialClaim` have zero
   human-uniqueness protection (address-keyed only) — already a real, currently-exploitable issue
   independent of the hackathon (see the "New and strong" bullet under Context above). Once claim
   events are indexed, the abuse pattern (same-block-funded fresh wallets, repeat-claim attempts)
   becomes queryable instead of requiring manual log inspection. Pairs directly with the World/
   Selfie Check pick below — this becomes the tool that demonstrates the gap and later verifies
   the gating works.
3. **Economy transparency**, continuing the direction of the "Update burnable for
   economy/transparency" commit — a public, queryable ledger of UTC/DEC supply, burn rate, and
   top holders via the standardized ERC-20 schema, without custom aggregation code. Gives
   `docs/UTC_Price_Prediction_10k_Players.md`'s modeling something real to check against later.
4. **Ship/medal provenance** — free transfer history for Ships and `ShatteredHiveMedal` via the
   standardized ERC-721 schema, useful for any future marketplace or ship-history feature.

(1) and (2) are the load-bearing reasons — real gaps that exist independent of the prize. (3) and
(4) are byproducts of the same build. None of this requires the PvE bots to be "real AI."

**Dashboard, added to the plan 2026-09-10.** One dashboard, one panel per use case above, each
querying the subgraph via GraphQL — this is the concrete "what became easier" artifact the track
itself asks for (line 29) and doubles as the demo-video content:

1. **Player history panel** — per-wallet lookup: win/loss record (`GameResults`), tournament
   registrations/results (`Tournament`), and free-ship/tutorial claim history. Replaces the
   frontend's current raw-log-scanning for this data.
2. **Abuse-detection panel** — flags wallet clusters funded in the same block that then claim,
   and repeat-claim attempts against `FreeShipClaim`/`TutorialClaim`. This is an ops/admin view,
   not player-facing; it's the concrete evidence piece for the still-open human-uniqueness gap,
   and later the before/after proof once the World/Selfie Check gating (pick #2) ships.
3. **Economy panel** — UTC/DEC supply over time, mint vs. burn rate, top holders, using the
   standardized ERC-20 transfer/mint/burn entities. Public-facing, continuing the "economy/
   transparency" direction already underway.
4. **Ship/medal provenance panel** — per-token lookup for any `Ships`/`ShatteredHiveMedal` id
   showing its full ownership/transfer history via the standardized ERC-721 entities.

Scope note: this is a frontend deliverable (a small standalone page or app consuming the subgraph
over GraphQL), not a contracts change — it belongs wherever the existing frontend work lives, not
in this repo. No contract-size or deploy-safety implications here; the only dependency is the
subgraph itself being deployed and queryable first.

**Re-examined 2026-09-09 — could this subgraph replace Walrus for match replay?** No, not
cheaply, as the contracts stand. `Game.sol`'s only combat event —
`Move(gameId, shipId, oldRow, oldCol, newRow, newCol, actionType, targetShipId)`
(`contracts/Game.sol:88`) — covers ship movement + coarse action-type + target, which is enough
for a real (if partial) "tactical trace" subgraph feature with **zero contract changes**. But
damage dealt, resulting hull points, ship-destroyed-vs-fled status, which specific
weapon/special/faction-ability actually resolved, and round number/running score are never
emitted anywhere — `_performShoot`, `_removeShipFromGame` (`Game.sol`), `ShipsRouter.sol`,
`SpecialEffectsLib.sol`, and `DestroyRewardLib.sol` are all event-less for this data; it exists
only in storage or inside the Walrus `MatchRecord.turns` blob. Reaching full replay parity with
that blob would mean adding several new, richer events to `Game.sol` — real per-action gas cost,
and real risk given `Game.sol` is already within a few hundred bytes of the 24 KiB limit.
**Recommendation: don't pitch this as a Walrus replacement.** The free "tactical trace" version
(zero contract changes) is a legitimate *complementary* subgraph feature, not a substitute for
full replay.

**Flagged — needs confirmation, not asserted:** the live product may have already stopped
writing to Walrus after the ETH NY 2026 hackathon it was built for — unconfirmed from this
contracts repo (`GameBlobRegistry` is still deployed and wired in `DeployAndConfig.ts`, but the
write path is entirely client-driven from the separate frontend repo, which isn't visible here).
If Walrus is genuinely inactive in production today, "add a few richer combat events + a
subgraph" stops being a redundant rebuild of a working feature and becomes restoring lost replay
capability from scratch — which changes whether the `Game.sol` size/gas cost above is worth
paying. Check the live frontend/backend's actual Walrus-write status before deciding either way.

- **Correction:** the FreeShipClaim/TutorialClaim abuse-detection subgraph idea above only half
  works as written. `TutorialClaim.sol` emits `TutorialCompleted(player, winPath, shipsCreated)`,
  but `FreeShipClaim.sol` emits **no events at all**, so its claims aren't indexable yet. Adding
  one event there is cheap (it's already a standalone contract, no size pressure) if this angle
  is still wanted.

**Follow-up, 2026-09-09 — Walrus confirmed permanently disabled; scoped a full-replay plan.**
The "flagged, needs confirmation" item directly above is resolved: Walrus is confirmed off and
not coming back, so there is currently **no replay capability at all** in the live product. That
changes the calculus from the note above — this is no longer "rebuild a redundant feature," it's
"restore lost capability from scratch." The goal, per direction: full step-by-step client replay
— round number, running score, ship variant, exactly which special/faction ability fired
(including its faction/slot identity), damage dealt, and destruction — reconstructable purely
from on-chain events.

Researched the exact data model and call graph needed (`Types.sol` enums/structs,
`Game.sol`'s `_performShoot`/`_performSpecial`/`_performFactionAbility`/`_removeShipFromGame`/
`_handleEndOfRound`/`startGame`, `SpecialEffectsLib.sol`) and confirmed the binding constraint:
`Game.sol` is deployed at **23.993 KiB** against the 24 KiB (24,576-byte) EIP-170 limit —
effectively zero headroom, confirmed via `npx hardhat compile --force` +
`hardhat-contract-sizer`. Per `CLAUDE.md`, the size check is never disabled — this has to
actually fit via refactoring, not a workaround.

*Architecture (the escape valve):* `SpecialEffectsLib.sol`'s functions are `external` and take
`GameData storage` — Solidity compiles calls to it as a DELEGATECALL stub at `Game.sol`'s call
sites (confirmed by the file's own header comment) instead of inlining the logic, so code living
inside it — including new events, ABI encoding, and `LOG` opcodes — is charged against *that
library's own* budget (5.272 KiB deployed, lots of room), not `Game.sol`'s, while the emitted
event still shows on-chain as coming from `Game.sol`'s address (delegatecall preserves
`ADDRESS()`). Plan: one new library, `contracts/GameReplayLib.sol`, built the same way, plus a
small extension to `SpecialEffectsLib.sol` itself for ability identity:

1. **Round number** — add a `round` param to the *existing* `Move` event/emit site
   (`Game.sol:88`, `:706`) rather than a new event; cheapest possible way to get it in.
2. **Damage** — extract `_performShoot`'s damage formula (`Game.sol:824-836`) into
   `GameReplayLib.resolveShotAndLog(...)`, emitting `Damage(gameId, shooterId, targetId, amount,
   resultingHullPoints, round)`. Replaces inline arithmetic with a call, so likely
   size-neutral-to-negative for `Game.sol` — do this one first and measure.
3. **Ship removal** — `_removeShipFromGame` has 5 call sites, each already unambiguous about why
   (`Retreat`, `ShotDestroyed`, `SpecialEffect`, `ReactorCritical`, `Debug`); thread a
   `RemovalReason` enum through and call `GameReplayLib.logRemoval(gameId, shipId, reason,
   round)`.
4. **Round end** — one call in `_handleEndOfRound` after the score-increment block:
   `GameReplayLib.logRoundEnd(gameId, round, creatorScore, joinerScore)`.
5. **Ship loadout snapshot** — equipment (`mainWeapon`/`armor`/`shields`/`special`) is fully
   mutable between matches via `DroneYard.modifyShip` (only `variant` is guarded), and nothing
   per-game stores which loadout was active during a specific historical match — so one call at
   `startGame` time, `GameReplayLib.logRoster(gameId, creatorShipIds, joinerShipIds, ships)`,
   emitting one `ShipLoadout` event per ship.
6. **Which ability fired** — `SpecialEffectsLib.resolveAndApply` already knows `variant` but not
   the `Special` slot; add that field to its existing `ResolveContext` struct (cheap — the value
   is already loaded in memory at both call sites) and emit `AbilityUsed(gameId, shipId, variant,
   special, targetShipId)` from inside the library, which already has room.

No new allowlist/auth is needed: a hostile direct (non-delegatecall) call to the library's own
address would execute with `address(this)` == the library, not `Game.sol` — any forged event
would be tagged as coming from the wrong address and a subgraph watching `Game.sol` specifically
would never see it.

*Alternative considered and rejected: Diamond proxy pattern (EIP-2535).* Would remove the 24 KiB
ceiling on `Game.sol` permanently (not just for this feature) by making it a thin proxy over
per-facet contracts. Rejected for this task: it's a full storage-layout rewrite of the entire
game loop (not just 5-6 hook points), adds a permanent `fallback()` selector-lookup + delegatecall
gas cost to *every* player action forever, carries real regression risk to a live game with 616
passing tests, introduces a new audit surface (facet clashes, `diamondCut` permissions), and
doesn't match this repo's already-established answer to "a core contract needs more room" —
splitting logic into standalone authorized contracts (`FreeShipClaim.sol`, `TutorialClaim.sol`,
`DroneYard.sol`, `ShipPurchaser.sol`, `SpecialEffectsLib.sol`), which is what the plan above
already does. If the team wants to solve the *recurring* "core contracts keep hitting 24 KiB"
problem structurally, Diamond is worth its own dedicated evaluation later, decoupled from this
feature.

*Build order:* extract shoot-damage first and measure `Game.sol`'s size before proceeding to the
smaller additive stubs (round-on-Move, round-end, removal-reason, `ResolveContext` extension),
with the roster/loadout snapshot last (least urgent, easiest to defer if room runs out). Existing
tests asserting the old `Move`/`_removeShipFromGame` signatures will need updating; new tests
needed per new event. This is contracts-only — the subgraph that actually consumes these events
for client replay is separate follow-on work under the Graph pick above.

### 2. World — Selfie Check — $3,500 pool, up to 3 teams at $1,166 each

**Eligibility check:** unlike AgentKit ("🆕 This prize is only available to Continuity Track
participants", line 517), Selfie Check carries no pool-restriction tag at all (lines 540-561) —
it's open to both Start-Fresh and Continuity submissions. Being a Continuity team does not
exclude us from it; it just means we won't get a smaller, protected competing field the way we
would on AgentKit or the other explicitly-tagged tracks below.

Gate `FreeShipClaim.claimFreeShips` and `TutorialClaim.completeTutorialWinPath` /
`completeTutorialLossPath` behind a Selfie Check proof, as a lower-friction complement to
Tournament's existing full-Orb World ID gate — matches the track's own framing almost verbatim
("risk, eligibility, fairness, continuity, or abuse prevention").

- Reuse the pattern `Tournament.sol` already established for World ID: `ByteHasher` for signal
  hashing, a nullifier mapping to prevent proof reuse, proof validation on-chain (not in a
  backend) — see `contracts/Tournament.sol` lines 1-80 and `contracts/IWorldID.sol`.
- `FreeShipClaim.sol` currently only tracks `lastClaimTimestamp[msg.sender]`
  (`contracts/FreeShipClaim.sol:18`) — add a per-nullifier claim record alongside the existing
  per-address cooldown so a proof can't be reused across wallets, without removing the existing
  cooldown logic.
- `TutorialClaim.sol` currently only tracks `tutorialCompleted[player]`
  (`contracts/TutorialClaim.sol:13`) — same nullifier-alongside-address pattern.
- Both are already split-out standalone contracts (per the "Ships.sol size fix pattern" this
  repo already follows, since `Ships.sol`/`Game.sol` are near the 24 KiB limit), so adding World
  ID verification here doesn't pressure the core contracts at all.
- Deliverable also requires a feedback document (World ID docs, Developer Portal, Sandbox App
  experience) per the track's qualification requirements — write this alongside the code, not
  after.

## Third slot — needs further scoping before committing

Kept open per direction: keep Ledger and Uniswap both live for exploration, with Chainlink VRF
as the low-risk fallback. All three are real, grounded, Continuity-eligible, and technically
compatible with each other (they touch different contracts), so more than one could plausibly be
built even if only one is ultimately submitted as the "official" third sponsor.

**A. Chainlink VRF — "Best Chainlink-Powered Upgrade" (Continuity) — $500**

- Lowest effort, lowest risk, lowest prize. New `ChainlinkRandomManager` implementing the
  existing `IRandomManager` interface (`contracts/IRandomManager.sol`); repoint via
  `Ships.setConfig` and `Tournament`'s constructor/config (both owner-gated, no proxy needed). No
  changes to any consuming contract's logic.
- Directly cites a real, documented finding: `docs/pre-audit.md`'s randomness remediation entry
  names Chainlink VRF as the real fix for the residual timing-choice risk in the current
  commit-reveal (`block.prevrandao`) scheme.
- **Correction from an earlier draft of this analysis:** VRF does *not* need to be routed
  through CRE. The track lists five independently-eligible technologies — "Chainlink Runtime
  Environment (CRE) - including Confidential Workflows, Price Feeds, Data Streams, Proof of
  Reserve (PoR), VRF (Verifiable Random Function)" (lines 974-980). The doc's "Important: Please
  use CRE instead of Chainlink Functions or Automation" note (line 984) is a warning about two
  specific *deprecated* products (Functions, Automation), not a requirement that every
  integration go through CRE. Plain VRF (subscription model) is directly eligible on its own —
  scope against that, not a CRE wrapper, unless CRE genuinely simplifies the integration.

**Pitch (2026-09-10):** Chainlink VRF is the smallest prize of the three we're weighing ($500 for
"Best Chainlink-Powered Upgrade," versus $1,500 for Ledger and $2,000 for Uniswap), but it's also
the cheapest and safest to actually ship: `IRandomManager` is a 3-function interface
(`requestRandomness`, `revealRandomness`, `fulfillRandomRequest`), so the work is writing one new
`ChainlinkRandomManager` contract that satisfies it and calling the existing owner-gated
`Ships.setConfig` plus `Tournament`'s constructor/config to point at it — no proxy, no changes to
any consumer, since `Ships.sol` was deliberately written to know nothing about how reveal works.
It's plain VRF (subscription model), not CRE. And it isn't hackathon busywork: `docs/pre-audit.md`
already documents the residual risk in our current `block.prevrandao` commit-reveal scheme — a
patient caller can preview an epoch's entropy for free and simply decline to submit until it's
favorable — and names real VRF as the actual fix, not a hypothetical one. Low effort, low risk,
real remediation, small prize.

**Verified architecture fit (2026-09-10).** The claim "no changes to any consuming contract's
logic" was previously an assumption — checked it against the actual call sites and it holds.
`Ships.constructShip` (`Ships.sol:330-352`) and `Tournament.buildBracket`
(`Tournament.sol:340-354`) already split `requestRandomness()` and `fulfillRandomRequest()` into
two separate transactions, and both are already written to tolerate a revert
(`RandomManager.TooSoonToReveal`) when called before the result is ready —
`Tournament.buildBracket` is explicitly documented as permissionless/retryable for exactly this
reason ("no single party staying offline can block every registrant"). That's precisely the
request-now/fulfill-or-revert-later shape Chainlink VRF's subscription model needs:
`ChainlinkRandomManager.requestRandomness()` calls the VRF Coordinator and stores the returned
request id; the Coordinator's `fulfillRandomWords` callback (a separate, later transaction) stores
the delivered word; `fulfillRandomRequest`/`revealRandomness` return the stored result if the
callback has already landed, or revert (reusing the same `TooSoonToReveal`-style semantics callers
already expect) if it hasn't. No behavioral change to `Ships.sol`/`Tournament.sol`/`Game.sol` is
needed — the existing revert-and-retry UX already covers the VRF wait.

**Re-evaluated against the track's own requirements (2026-09-10).** Qualification text
(`docs/eth-global-remote.md`, Chainlink section) requires: (1) integrate at least one Chainlink
service directly within smart contract logic/onchain workflows, not just display data — satisfied,
`ChainlinkRandomManager` directly replaces the entropy source `Ships.constructShip`/
`Tournament.buildBracket` consume; (2) the integration must contribute to a real state change on
a blockchain — satisfied, ship trait generation and bracket construction are genuine on-chain
writes driven by the revealed value; (3) clearly demonstrate how the upgrade improves the existing
project — satisfied by citing `docs/pre-audit.md`'s own documented residual-risk finding as the
concrete "why this is better" narrative. Plain VRF (not CRE) remains directly eligible per the
correction above.

**Tightened proposal (2026-09-10):**

1. Confirm the current recommended Chainlink VRF subscription-model integration path (base
   contract, coordinator address for Base Sepolia) against Chainlink's own docs before writing —
   don't assume a specific version/base-contract name, their SDK surface moves.
2. Write `ChainlinkRandomManager.sol` implementing `IRandomManager` exactly as specified above —
   request stores the VRF request id, the Coordinator's callback stores the delivered word,
   `fulfillRandomRequest`/`revealRandomness` return-or-revert per the verified architecture fit.
3. Repoint `Ships.setConfig` and `Tournament`'s constructor/config (both owner-gated) to the new
   manager — no changes to `Ships.sol`, `Tournament.sol`, or `Game.sol` themselves, per the
   verified fit above.
4. A real, LINK-funded VRF subscription, deployed and demoed on Base Sepolia only, per this repo's
   deploy-safety rule — this is a live testnet deploy, not just `hardhat test`, and needs explicit
   deploy authorization at build time.
5. Demo: a real request → VRF-callback → reveal cycle on Base Sepolia (e.g. minting + constructing
   a ship, or closing + building a tournament bracket), showing the on-chain state change, plus the
   `docs/pre-audit.md` finding as the required improvement narrative.

No contract-size pressure — this is a new standalone contract; `Ships.sol`/`Tournament.sol` stay
untouched.

**B. Ledger — "Continuity" track — $1,500 (1st $1,000 / 2nd $500)**

- Almost entirely an ops/tooling change: move the hot key used by
  `scripts/allowFirebaseMinter.ts` (and other owner-gated admin actions — RandomManager repoint,
  mint-authorization changes) onto Ledger's Key Ring CLI (`wallet-cli ring`), or add a
  device-confirmation step in front of one of those actions.
- Matches the track's own example almost exactly: "Make wallet-cli ring the key backend for the
  .env... files your repo already has" / "Put a device confirmation in front of an action your
  product already performs."
- ~~Needs scoping: which specific admin action(s) get the device-confirmation treatment~~ —
  resolved 2026-09-10, see tightened proposal below (inventory confirmed against the actual repo,
  not speculative). Whether the Key Ring CLI supports headless CI/VPS enrollment is still open.

**Confirmed inventory (2026-09-10).** Checked `hardhat.config.ts` and every script in `scripts/`
rather than guessing. `METAMASK_WALLET_1` (a plaintext key from `.env`) is the sole signer for
five networks — `base-sepolia`, `flow-testnet`, `ronin-saigon`, `polygon-amoy`, `xai-testnet` — and
it signs exactly two kinds of real transaction today: (1) every Ignition deploy run against those
networks, and (2) `scripts/allowFirebaseMinter.ts`'s `setIsAllowedToCreateShips` call, the only
post-deploy owner-gated *write* script in the repo. `scripts/healthcheck.ts` also uses
`getWalletClients`, but only for `simulateContract` (a read-only dry run, no `writeContract`) — it
never broadcasts, so it's out of scope; there is no separate "RandomManager repoint" or
"mint-authorization" script today, those were speculative future actions, not present ones.

**Re-evaluated against the track's own requirements (2026-09-10).** The Continuity sub-prize's
qualification text (`docs/eth-global-remote.md`, Ledger section) asks for: a meaningful
contribution to, or extension of, an existing shipped app using the Ledger Agent Stack; a public
repo or PR with a README/description explaining the problem and how to run it; and a demo video
(five minutes or less) showing the improvement working. The confirmed inventory above satisfies
this directly — an existing, real, currently-unprotected hot key on a shipped product is exactly
the "action that previously had none" the track's own example language describes. This doesn't
change the eligibility flag already recorded above (whether the parent track's "AI agents and
AI-powered products" framing binds the Continuity sub-prize) — that remains genuinely unconfirmed
and still needs checking with the track's organizers before committing build time.

**Tightened proposal (2026-09-10):**

1. Move `METAMASK_WALLET_1`'s role to Ledger's Key Ring CLI (`wallet-cli ring`) as the signer
   backend for `hardhat.config.ts`'s network `accounts`, covering both real uses at once (deploys
   and `allowFirebaseMinter.ts`) rather than gating one script in isolation.
2. Open scoping question, still unresolved: does Key Ring CLI support enrollment from a headless
   CI/VPS deploy path, or does it require a physical Ledger device attached to whatever machine
   runs the deploy/script — this determines whether the change is a straightforward local-dev
   signer swap or a bigger workflow change if deploys ever move to CI.
3. Demo: a real Base Sepolia transaction (e.g. an `allowFirebaseMinter.ts` grant/revoke run, or a
   redeploy) signed via the Key Ring CLI instead of the plaintext `.env` key, recorded as the
   required five-minute-or-less video.
4. Eligibility flag above still stands and gates whether to proceed at all — check with Ledger's
   track organizers before committing real engineering time.

**Pitch (2026-09-10):** Ledger's Continuity track fits this repo almost exactly as written: right
now every owner-gated admin action — `scripts/allowFirebaseMinter.ts` calling
`setIsAllowedToCreateShips`, plus any future RandomManager repoint or mint-authorization change —
signs with a plaintext `METAMASK_WALLET_1` private key pulled straight out of `.env` in
`hardhat.config.ts`, with no hardware confirmation between "run the script" and "owner-privileged
state changes on-chain." Swapping that for `wallet-cli ring` as the key backend, or at minimum
putting a device-confirmation prompt in front of the minter-allowlist call, is close to pure ops
work — no new Solidity, no size budget spent, just moving where the signature comes from. The
real payoff outlasts the $1,500 prize: it closes the actual worst-case in this repo, a leaked or
malicious-laptop `.env` silently granting ship-minting rights to an attacker's address. The
honest gap is scoping: which admin action(s) get gated first, and whether Key Ring CLI supports
enrollment from a headless CI/VPS deploy path rather than a developer's laptop with a Ledger
plugged in — that needs to be checked before committing to it as the pick.

**Clarification (2026-09-10):** the pitch above was unclear and read as if it proposed gating the
Firebase backend's actual ship-minting calls, which must stay fully automated. It doesn't.
`scripts/allowFirebaseMinter.ts` is the Ships contract *owner* calling
`setIsAllowedToCreateShips(minter, allowed)` — a rare, manual admin action that grants/revokes the
Firebase backend's address permission to mint. Once granted, the Firebase backend mints using its
own separate key (`DEFAULT_MINTER` in the script), untouched by this. A hardware-confirmation gate
would sit on the owner's infrequent grant/revoke action only, never on the automated per-ship
mints themselves.

**Flagged — eligibility genuinely unconfirmed (2026-09-10):** Ledger's sponsor blurb for the whole
$5,000 pool frames it as "Build AI agents and AI-powered products that use Ledger as the trust
layer" (`docs/eth-global-remote.md` line ~789-797). The Continuity sub-prize's own example
directions (hardware signer for a shipped app, Key Ring as `.env` key backend, device confirmation
on an existing action) don't literally require an AI agent, but it's unconfirmed whether judges
will hold the Continuity sub-prize to the parent track's AI framing regardless — same shape of
risk already caught once on the Graph pick. Not asserting an answer either way; this needs
checking against the track's own Discord/organizers (`https://developers.ledger.com/ethonline`)
before committing real engineering time to it.

**C. Uniswap — "Best Uniswap Stack Contribution" (Continuity) — $2,000 (1st $1,000 / 2nd $1,000)**

- Biggest lift of the three. Deploy a real UTC/ETH (or UTC/USDC) Uniswap v4 pool with a custom
  hook enforcing the burn/arbitrage mechanic `docs/UTC_Price_Prediction_10k_Players.md` already
  assumes exists (a small fee-on-swap routed into the existing UTC burn/treasury flow, closing
  the loop between the 1:1 `purchaseUTCWithFlow` mint rate and the assumed external market
  price).
- ~~Needs scoping: exact hook logic (fee capture + where it's routed — does it feed the existing
  `owner()` treasury withdrawal path in `ShipPurchaser.sol`, or a new burn sink?)~~ — resolved
  2026-09-10, see design decision below: routes to a dedicated giveaway/fundraising treasury, not
  burn, not the existing `owner()` path. Whether a v4 pool needs its own liquidity seeding plan
  for a believable demo is still open.
- Requires a `FEEDBACK.md` + Uniswap Developer Feedback Form submission per the track's
  qualification requirements.

**Design decision — ceiling over floor, by design (2026-09-10).** Two actual goals drove this,
stated by the project owner, not inferred: (1) a pool of UTC for giveaways, events, prizes, or
sale-for-fundraising, created from real economic activity rather than minted by fiat; (2) keep
UTC's price stable relative to the native token — but explicitly prioritizing the **ceiling**
over the floor, because the intent is for UTC to be a **utility asset, not a speculative one**.

- **Ceiling is already free, confirmed via the contract.** `ShipPurchaser.sol`'s `tierPrices` is a
  plain owner-set array (`setPurchaseInfo`, line 138) — no bonding curve, no cap on mint volume,
  no cost-per-unit increase with scale. So the arbitrage ceiling is unconditional: whenever pool
  price rises above the current tier price, anyone can mint UTC at that fixed price and sell into
  the pool for profit, pushing price back down. Zero new code needed for this half.
- **Floor is deliberately not defended.** A defended floor (symmetric redeem function, or a
  treasury-funded buyback) was considered and rejected: it creates a predictable arbitrage spread
  that attracts the exact mercenary/speculative capital the "utility asset" goal is trying to
  avoid, and — per this repo's standing rule to assume hostile actors will exploit any exploitable
  mechanism for free — it opens a real treasury-drain surface (sustained dumping to trigger
  buybacks, sandwiching the buyback trades) that would need serious adversarial hardening neither
  scoped nor wanted here.
- **A soft, passive floor exists anyway, for free.** Once pool price drops meaningfully below the
  mint tier price, buying off the pool becomes cheaper than minting, so organic gameplay demand
  naturally supports price without the protocol promising or capitalizing anything.
- **Monitor, don't defend.** Sustained below-mint drift is a signal to watch on the Graph
  economy-transparency panel (already planned in pick #1), not a condition to actively correct.

*(See the sell-side lottery hook below, added 2026-09-10 — it reinforces this ceiling mechanic
with a real incentive on top of the passive arbitrage described here, without adding a floor or
any capital-at-risk defense.)*

~~**Re-evaluated against the track's own requirements (2026-09-10).** The track's description asks
for "new v4 hooks, extensions or improvements... tooling or solutions built for the broader
ecosystem" (`docs/eth-global-remote.md` Uniswap section) — a single, focused fee-to-treasury hook
satisfies this directly, and arguably makes a *cleaner* submission than a hook also trying to
defend a peg (easier for a judge to read and verify per the qualification requirement that the
README "clearly point[] to the relevant contracts and lines of code"). Nothing in the track's
qualification requirements (public repo, `FEEDBACK.md`, Developer Feedback Form, README pointing
at the code) asks for price-stability guarantees, liquidity depth, or TVL — dropping floor-defense
costs no eligibility, it only removes scope that was never required.~~

~~**Tightened proposal (2026-09-10):**

1. Deploy a UTC/ETH (or UTC/USDC) Uniswap v4 pool.
2. One hook, one job: capture a fee on swap, route it to a **new, dedicated treasury contract**
   scoped to giveaways/events/prizes/fundraising — not the existing `owner()` withdrawal path in
   `ShipPurchaser.sol` (that path is general-purpose owner funds; this pool's fees have a distinct,
   stated purpose and should stay separately trackable/spendable). Confirm this contract shape
   before building.
3. No symmetric redeem function. No buyback bot or keeper. No price-band logic. Explicitly out of
   scope by the design decision above, not deferred for later.
4. Liquidity seeding plan for a believable demo — still open, needs scoping (how much UTC/ETH,
   sourced from where).
5. `FEEDBACK.md` + Uniswap Developer Feedback Form submission, per the track's qualification
   requirements.

This is a materially smaller build than the original three-bullet version above (no peg-defense
logic, no redeem function) — worth revisiting the "biggest lift of the three" comparison against
Chainlink VRF and Ledger once liquidity seeding is scoped.~~

**Superseded 2026-09-10 — the fee-to-treasury hook above is dropped entirely, not just
re-routed.** Checked `ShipPurchaser.sol:157-178` directly: it already has `withdrawUTC()` (pulls
the UTC balance the contract has accumulated from real `purchaseWithUTC` sales, net of referrals) and
`withdrawFlow()` (same, for ETH from `purchaseUTCWithFlow` sales). Both owner-gated, both already
shipped, both already economy-sourced. Goal 1 (a UTC/fundraising reserve built from real activity,
not fiat minting) is already fully met by existing code — a swap-fee hook would have duplicated it.
It also would have worked directly against goal 2: an added fee on top of the pool's own LP fee
makes every trade costlier, discouraging exactly the arbitrage trading the ceiling depends on. And
it reads as exactly the kind of protocol-level toll on ordinary trading this project doesn't want
UTC to represent.

**Also considered and rejected — an active ceiling-enforcement hook (2026-09-10).** Explored
whether a hook could *automate* the ceiling instead of relying on passive external arbitrage: on a
swap that would push pool price above the cheapest implied `ShipPurchaser` tier rate, either (A)
revert the trade, or (B) have the hook itself mint fresh UTC (via `UniversalCredits.sol`'s existing
`authorizedToMint` allowlist, the same pattern already used for `ShipPurchaser`) and sell it into
the pool to correct price in the same transaction. Rejected, for real reasons, not just because it
was extra scope:

- It doesn't add capability beyond the existing passive arbitrage — it only removes the natural
  friction (gas cost, needing a human to notice) that currently gives the ceiling some slack.
- The reference price isn't a single number — `ShipPurchaser` has five independently owner-set
  tiers, so the true ceiling is whichever tier currently implies the cheapest UTC-per-ETH rate,
  computed live; getting this wrong enforces the wrong ceiling.
- (B) specifically is a real security concern, not a hypothetical one: minting and selling supply
  *inside* a swap, atomically, is a known hard-to-secure pattern (elastic-supply-on-price-pressure
  designs have a real history of exploits) — imprecise correction math creates a round-trip
  extraction target for a sufficiently careful attacker, exactly the kind of permissionless,
  cost-free-to-probe surface this repo's threat model says to assume will be attacked, not one to
  wave through as "no one would bother."
- Confirmed directly by the project owner: a tight peg isn't even wanted — occasional upward
  price excursions are fine, and considered unlikely to matter in practice anyway. Given that,
  there is no goal left for an active hook (either variant) to serve.

~~**Final design (resolved 2026-09-10): no hook at all.**

1. Deploy a UTC/ETH Uniswap v4 pool — no custom hook, vanilla pool.
2. Seed initial liquidity from the UTC/ETH already sitting in `ShipPurchaser`, withdrawable today
   via `withdrawUTC()`/`withdrawFlow()` — an allocation decision (how much of the existing,
   already-economy-sourced treasury becomes an LP position vs. stays spendable for
   giveaways/events/prizes/fundraising), not a new revenue mechanism.
3. Ceiling relies entirely on the existing passive `purchaseUTCWithFlow` arbitrage — zero new
   code. Deliberately not pinned tight; occasional excursions above the mint rate are accepted by
   design, not a defect to correct.
4. Goal 1 (economy-sourced reserve for giveaways/fundraising) needs no new mechanism — already
   served by `withdrawUTC()`/`withdrawFlow()`.
5. `FEEDBACK.md` + Uniswap Developer Feedback Form submission, per the track's qualification
   requirements — unchanged.

**Honest note on competitiveness.** The track's description is satisfied by this scope — "Build on
or integrate any part of the Uniswap stack, including the Uniswap AMM (v2, v3, or v4)"
(`docs/eth-global-remote.md`) doesn't require a custom hook, and the liquidity-seeding tooling
(drawing from the existing treasury) is real, open-source code for a judge to read. But this is now
the smallest, least differentiated version of this pick across every draft in this doc — no custom
hook at all. That's a deliberate trade favoring safety and product fit over how impressive the
submission looks to judges, consistent with this project's stance against building complexity that
isn't earning its keep. Worth being aware of, not worth reversing.

**Addendum 2026-09-10 — the last candidate hook (event emission for the Graph dashboard) is also
redundant, confirmed.** V4's `PoolManager` is a singleton: it emits its own `Swap` event (and the
liquidity-action equivalents) for every pool on every swap, natively, whether or not a hook is
attached at all — this is core protocol behavior, not something a hook adds. So the Graph
subgraph from pick #1 needs no custom hook either; it indexes `PoolManager`'s native `Swap` events
filtered to this pool's id, and price/volume for the dashboard's economy panel comes from that for
free. Likely already covered by an existing standardized Uniswap v4 subgraph schema too, matching
the same "build on a standardized schema" approach already used for the UTC/DEC/Ships indexing in
pick #1. This closes out the last open "maybe we need a hook" thread — the Uniswap pick needs
zero custom hook code, for any of the reasons considered across this whole section.~~

**Superseded again, 2026-09-10 — a fourth hook idea surfaced that's different in kind from the
first three, and survived scrutiny: a sell-side lottery for a unique ship.** Unlike the
fee-to-treasury hook (redundant, worked against goal 2, read as a toll) and the active
ceiling-enforcement hook (real round-trip exploit risk, unwanted anyway), this one doesn't move
funds or enforce an invariant — it's a promotional mechanic tied to real game content, and it
reinforces the existing passive ceiling rather than competing with it or replacing it.

**Design: sell-side, size-weighted, address-capped, minimum-gated, rate-limited lottery.**

- **Direction: sell-only.** Only UTC→native (`sell`) trades earn entries, not the reverse. This
  is deliberate, not arbitrary: the ceiling-defending arbitrage trade (mint UTC at the fixed tier
  rate, sell it into the pool when pool price exceeds that rate) *is* a UTC→native trade — making
  only that direction earn entries gives the people already incentivized to defend the ceiling an
  extra reason to actually act on smaller deviations, reinforcing the existing free mechanic
  described above rather than adding a new one. It does nothing for the (intentionally
  undefended) floor, and doesn't need to.
- **One entry per address per draw, weighted by size.** Concretely: sum each address's qualifying
  sell volume over the draw period, reset per draw; one weighted entry per address from that sum.
  This avoids ambiguity about which trade counts if an address sells more than once in a period.
- **Sybil resistance beyond the weighting.** Because only sells count, every entry-earning trade
  must be preceded by actually acquiring UTC first (mint, buy, or earn through gameplay) — there
  is no free round-trip the way a bidirectional "any trade" scheme would allow; a wash-trading
  attacker pays real cost (fees plus having to first acquire what they sell) per entry, not just
  gas.
- **Minimum qualifying trade size, denominated in the native token (ETH), not in UTC.** Flagged
  by the project owner as necessary, not optional: without this, a period of low UTC price makes
  entries cheap in real terms even though the weighting is nominally "by size" — a large
  UTC-denominated sell can still be a trivial real-dollar cost if UTC itself is cheap. Pricing the
  floor in ETH insulates it from UTC's own price swings: no matter how low UTC trades, entering
  still costs a real, fixed floor of actual value. Exact ETH figure still needs to be set —
  scoping item, not resolved here.
- **One drawing per 24 hours, permissionless trigger.** Rate-limits how often a unique ship gets
  given away (preserving scarcity over time) and bounds how often a single depressed-price window
  can matter, though it doesn't by itself fix a single draw being under-priced — that's what the
  ETH-denominated minimum above is for; the two guards address different failure modes and are
  both needed. Implementation-wise, this doesn't need a keeper: the hook checks elapsed time on
  `afterSwap` and triggers the draw once 24h have passed since the last one, the same
  permissionless "whoever's transaction happens to cross the threshold triggers it" pattern
  `Tournament.buildBracket` already uses.
- **Draw mechanism reuses existing infrastructure — no Chainlink VRF needed.** The draw is a
  request-now/reveal-later cycle through the existing `RandomManager` (the same two-step pattern
  `Ships.constructShip` and `Tournament.buildBracket` already use) — the triggering swap requests
  randomness, and the winner reveal happens permissionlessly once the entropy window opens. This
  keeps the pick fully independent of the dropped Chainlink VRF pick, using infrastructure this
  repo already has.
- **Prize minting reuses the existing authorized-minter pattern.** A small contract gets granted
  minting rights via `isAllowedToCreateShips` (the same allowlist `ShipPurchaser`/`FreeShipClaim`/
  `AIShips` already use) and mints the winning ship once the draw resolves, guarded so it can only
  fire once per draw's prize.

**Open questions, not yet resolved:**

1. **What "1-of-a-kind" means across repeated draws.** A single ship that's fought over forever
   only makes sense for one draw ever — but the 24h cadence implies a *recurring* mechanic. Most
   likely intent: each draw period mints its own newly-generated unique variant as that period's
   prize (a rotating "one unique ship per drawing," each individually one-of-a-kind), not a single
   eternal prize — needs explicit confirmation before defining the mint path.
2. **Weighted random selection is real implementation work, not trivial.** Picking a winner
   fairly from an unknown number of addresses, weighted by their summed sell volume, needs an
   on-chain data structure that supports a cheap, fair weighted pick (a cumulative-weight array
   with binary search is the standard approach) — a genuine engineering task, larger than any
   earlier version of this pick, though still far more scoped than the mint-and-sell ceiling hook
   that was rejected for real exploit risk.
3. **Whale dominance is inherent to size-weighting**, not a bug to fix by default — someone
   selling a large stash in one draw period gets proportionally better odds, the same way
   raffle-tickets-per-dollar promotions work elsewhere. Worth deciding whether to cap max weight
   per entry, or accept it as-is.
4. **Exact ETH-denominated minimum entry threshold** — needs an actual number, informed by
   `docs/UTC_Price_Prediction_10k_Players.md`'s (re-examined, ETH-denominated) figures once that
   doc is updated, not invented independently of it.

**Competitiveness, revised.** This reverses the "least differentiated version of this pick"
assessment from the earlier draft above — a sell-side lottery tied to unique game content is a
genuinely novel, demoable hook, not a generic DeFi pattern every other submission in this track
will also have. That comes at the cost of real, nontrivial implementation work (weighted
selection, the two-step draw, the minter guard) — a bigger lift than the vanilla-pool version, but
smaller and much lower-risk than the rejected ceiling-defense hook, since nothing here moves funds
or enforces a price invariant that could be gamed for direct extraction.

**Addendum — built, tested, and materially revised from the design above (2026-09-11).**
`contracts/UTCLotteryHook.sol` exists now; 643/643 repo tests pass, 20 dedicated to this contract.
The live, current spec lives in `docs/eth-global-remote-strategy-v2.md` (Pick 3, item 4) — this
note is the historical record of what changed between the design above and what actually got
built, not a restatement of the current design.

- **Weighting reworked from sum to max.** The design above said "summed qualifying sell volume" —
  built and shipped that way first, then corrected on direction from the project owner: an
  address's entry is now its single best (highest) qualifying sell in the draw, not a sum, so
  splitting one large sell into many small ones can't inflate odds.
- **Prize mechanism went through three real iterations, not one.** First built as owner-configured
  `prizeVariant`/`prizeTier` through the generic `createShips` — genuinely not "1-of-a-kind" in any
  enforced sense, just a labeling convention. Corrected to a single hand-crafted `PrizeTemplate`
  minted via `Ships.createSpecificShip` (per direction), which also surfaced a real invariant this
  design would have silently violated — `Ships.sol` doesn't itself stop a ship from having both
  armor and shields, `DroneYard.sol`'s `ArmorAndShieldsBothSet` check does, and this hook calls
  `Ships.sol` directly, bypassing that check entirely unless re-validated here. Then corrected
  again to a full 5-slot FIFO queue (`queuePrizeTemplate`) with a random-4-star fallback
  (`Ships.createShips(winner, 1, fallbackVariant, 4, false)`, reusing `Ships.sol`'s existing
  tier-4/rank-5 logic — no new generation code) for when the queue is empty, per direction.
- **A real correctness bug caught before it shipped: `tx.origin`.** The first draft of
  `_afterSwap` used `tx.origin` to attribute a sell to a player. Wrong on two counts — the `sender`
  PoolManager passes is the calling router, not the trader, and `tx.origin` misattributes any
  trade routed through a smart-contract wallet (this project already uses Dynamic for wallet
  auth). Fixed to decode the real trader from `hookData` instead. This is now a standing project
  rule (`CLAUDE.md`, "Never Use `tx.origin`"), not just a one-off fix.
- **Draw eligibility became genuinely activity-gated, not just time-gated**, per direction: a draw
  now also needs `minParticipants` (default 3) distinct sellers and `minTotalWeightWei` (default
  0) total volume before it can start, alongside `drawInterval` (default 24h, no longer a hardcoded
  constant) — all three owner-configurable. If eligibility isn't reached by the interval mark, the
  same draw keeps accumulating rather than starting or resetting.
- **The real-swap integration test turned into real infrastructure work**, not just a test file:
  Uniswap's actual `PoolManager` needs a CREATE2-mined address (hook permissions are encoded in
  the low bits of the deployed address), which needed `contracts/Create2Deployer.sol` and a
  TypeScript port of Uniswap's own `HookMiner.sol` (`scripts/hookMiner.ts`, since this is
  Hardhat/viem, not Foundry) — real, reusable deployment tooling, not disposable test scaffolding.
  Getting `PoolManager.sol` to compile at all also needed isolating a ~50-file transient-storage
  dependency closure into its own Cancun/viaIR compiler job in `hardhat.config.ts`, kept separate
  from the main compiler pass specifically to avoid risking `Game.sol`'s already-razor-thin 24 KiB
  budget — confirmed byte-for-byte unaffected before and after.

~~**Pitch (2026-09-10):** Uniswap is the biggest bet of the three picks, and that's an honest way
to frame it rather than a sales point. `purchaseUTCWithFlow` mints UTC at a fixed rate
(`tierShips[_tier] * ships.recycleReward()`, e.g. 0.5–6.0 UTC per tier) with no burn and no
secondary market — `docs/UTC_Price_Prediction_10k_Players.md` already assumes an external UTC
market price exists to arbitrage against, and today it doesn't. Deploying a real UTC/ETH v4 pool
with a fee-on-swap hook feeding the burn/treasury flow would actually build that missing piece
and close the loop the doc only models on paper. But it's a real economic mechanism, not a
wrapper integration: we don't yet know if hook fees should route into `ShipPurchaser.sol`'s
existing `owner()` treasury withdrawal or a new burn sink, and we haven't scoped liquidity
seeding for a pool that needs to look believable in a demo, not just deploy successfully. It also
requires a `FEEDBACK.md` and Uniswap Developer Feedback Form submission on top of the contract
work. Compared to Chainlink VRF ($500, low-risk) and Ledger ($1,500, moderate), this is the
largest prize and the most genuinely useful new feature — and the most likely to eat the clock or
ship half-finished if we're not disciplined about scope.~~ — describes the fee-to-treasury design,
superseded above; kept for the record, not current.

~~**Third-slot status (2026-09-10):** Chainlink VRF is explicitly declined by the project owner —
down to Ledger and Uniswap. Current lean is **Ledger**, with its eligibility flag (whether the
Continuity sub-prize is bound by the parent track's "AI agents" framing) needing a quick check
against the track's own organizers before committing build time — the sub-prize's own qualification
text doesn't mention AI at all, so this leans toward "probably fine, worth confirming" rather than
genuinely open. Uniswap remains a live fallback with real independent product value (the sell-side
lottery hook design above), just a bigger build with no unresolved eligibility risk of its own.
Not yet finalized.~~ — **superseded (2026-09-10, same day):** direction flipped this to **Uniswap
primary, Ledger fallback / 4th priority** — see `docs/eth-global-remote-strategy-v2.md`, which is
the current live plan for this. Uniswap has since been substantially built out (see the addendum
above); Ledger remains fully unbuilt, only-if-Uniswap-falls-through.

## Implementation notes (for whenever this moves from strategy to build)

- Contract-side work (World/Selfie Check nullifier gating, Chainlink VRF `RandomManager` swap,
  any Uniswap hook) is testable the normal way: `npx hardhat test`, after confirming `PRODUCTION`
  is `false` in `ignition/modules/DeployAndConfig.ts` per `CLAUDE.md`. New contracts get their
  own test file following the existing per-contract pattern in `test/`.
- Contract size must be re-checked after any addition to `Ships.sol`/`Tournament.sol` (both are
  near the 24 KiB limit) — prefer the existing pattern of splitting new logic into standalone
  contracts wired through an authorized-minter/allowlist, as `FreeShipClaim.sol` and
  `TutorialClaim.sol` already do, rather than growing the core contracts in place.
- The Graph subgraph is verified by querying it against live Base Sepolia data through Subgraph
  Studio once deployed — mocked/local data does not satisfy the track's own qualification
  requirement.
- Any real deploy (new World ID gate, new RandomManager, a live Uniswap pool) targets Base
  Sepolia only, per `CLAUDE.md`'s deployment-safety rules — no mainnet or other testnet deploy
  without the user explicitly directing that specific deploy.

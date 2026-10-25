# Frontend/Backend Update Guide — Everything Since the Hackathon Fork (2026-09-09 → 2026-09-17)

**Written 2026-09-17.** This repo's actual git history starts at a single "Naked fork for
hackathon" commit on 2026-09-09 — everything below is every frontend/backend-relevant contract
behavior change across the ~20 commits between that fork and today. Pre-fork history (World ID
registration, Walrus match records, the original faction-2/DEC economy, Selfie Check gating, the
Uniswap v4 lottery hook's core mechanics, etc.) is unchanged and not repeated here — this doc is
additive, not a replacement reference.

**Contract addresses and ABIs are not included here on purpose.** The project owner handles every
deploy and hands off current addresses/ABIs to the frontend/backend directly after each one. This
doc — and every other doc in this repo — is scoped to *behavior*: new call sequences, new states,
new revert reasons, new events. Treat any address you already have as possibly stale after a
redeploy until it's reconfirmed by the project owner, never by re-deriving it yourself from this
repo.

---

## 1. Ship tier prices are no longer a fixed constant on a real deploy

**The most important item in this doc if your frontend has any hardcoded wei tier prices
anywhere.** On a real (`PRODUCTION=true`) deploy, `ignition/modules/DeployAndConfig.ts` fetches a
live ETH/USD price at deploy time and converts a fixed USD price curve —
`TIER_USD_PRICES = [4.99, 9.99, 19.99, 34.99, 49.99]` (unchanged, these are the same tier prices
you already know, just now USD-denominated rather than a fixed wei amount) — into wei at that
day's rate, then overwrites both `Ships.sol`'s and `ShipPurchaser.sol`'s tier prices via
`setPurchaseInfo`. This means:

- **Tier prices in wei can differ between deploys**, and change again any time the owner re-runs
  `setPurchaseInfo` (e.g. after a large ETH price move). Never hardcode a wei amount for a tier
  price — always read it live:
  ```js
  const [tierShips, tierPrices] = await ships.read.getPurchaseInfo();
  // or per-tier: await ships.read.tierPrices([tierIndex]);
  ```
- **This only applies to real deploys.** On a local/test deploy (`PRODUCTION=false`), the
  constructor's raw hardcoded ether literals apply instead (no USD conversion at all) — don't
  mistake a testnet deploy's tier prices for what a real deploy will actually charge.
- The fetched price is sanity-checked server-side (rejected if implausible) before being used, and
  is cached for 24 hours as of 2026-09-17 to avoid re-hitting the price API (and its rate limits)
  on repeated deploy attempts — neither of these change anything about what your frontend needs to
  do, just worth knowing the number you read is a real, validated market price, not something a
  frontend needs to double-check independently.

## 2. AI-owned kills now pay a per-faction reward token, not always DEC

**File:** new contract `FactionRewardTokenRegistry`, plus changes to `ShipsRouter`/`DestroyRewardLib`.

Recycling and any kill where the *destroyed* ship is human-owned are completely unaffected —
always UTC, regardless of variant, exactly as before. What changed is the **AI-owned-ship-destroyed**
case: instead of always paying DEC, `ShipsRouter`/`DestroyRewardLib` now look up a new contract,
**`FactionRewardTokenRegistry`** (available in the deploy output as `factionRewardTokenRegistry`),
keyed by the destroyed ship's `traits.variant`:

```js
// address(0) means no reward token is registered for that variant yet.
const token = await factionRewardTokenRegistry.read.rewardToken([variant]);
```

| Event | Who gets paid | Currency |
|---|---|---|
| Player recycles their own ship, any variant (`Ships.shipBreaker`) | The recycler | UTC (`Ships.recycleReward()`, halved if previously destroyed) — unchanged for all variants |
| A human destroys an **AI-owned** ship (single-player) | The human destroyer | Whatever `factionRewardTokenRegistry.rewardToken(destroyedShipVariant)` returns — **DEC for variant 2 today**, no reward if the variant has nothing registered (currently variant 1) |
| A human destroys **another human's** ship, any variant (PvP) | The destroyer only | UTC — same as it's always been, no dual-payout |
| An AI destroys a human's ship, any variant (single-player loss) | The AI's owner (`SinglePlayerMatch`, withdrawable) | UTC — unchanged, variant never enters into this direction |

**Today's actual configuration** (read live, don't hardcode — this mapping is designed to grow
over time): variant 2 → `DroneEnergyCores` (DEC), variant 1 → unregistered (no reward paid
currently). If a frontend kill-reward toast/history feed only knows how to show DEC or UTC, it now
needs a third state: "no reward this time" for an unregistered variant's AI kill.
`DestroyRewardLib` emits `RewardSkipped(uint16 variant, address destroyerOwner)` in that case
(instead of the normal ERC20 `Transfer` event a real payout produces) — listen for it if you want
to distinguish "AI kill, no reward configured yet" from "AI kill paid out" in a feed rather than
inferring it from an absent balance change.

**Why this doesn't reopen the problems that killed an earlier, similar idea (2026-08-15, pre-fork):**
that earlier version made *recycling* variant-2 ships pay DEC (a cheap-DEC farming loop) and let an
AI-owned *destroyer* pay DEC to the orchestrator contract (stranded, no way to spend it). Neither
applies here — recycling never touches the registry at all (still unconditionally UTC, every
variant), and the registry is only ever consulted when the *destroyed* ship is AI-owned, never when
the AI is the destroyer.

**Contract/ABI note:** `ShipsRouter` no longer exposes a public `droneEnergyCores` getter — if your
frontend reads `shipsRouter.read.droneEnergyCores()` directly for any reason, that call will now
fail. DEC's own address/ABI (the top-level `droneEnergyCores` deploy output entry) is unchanged for
balance/transfer purposes; only `ShipsRouter`'s *internal* reference to it moved behind the new
registry.

## 3. Tournament: `start()` no longer builds the bracket by itself

**Changed 2026-09-12 (HA2-07 fix).** `start()` used to build the bracket, auto-resolve byes, and set
state `Active`, all in one transaction. It no longer does — this closed a real issue where whoever
called `start()` could preview the random shuffle outcome before committing to it. **If your
frontend/backend currently expects `start()` to leave a tournament `Active` with a built bracket in
the same transaction, that's now wrong.** The flow is now:

**Step 1 — `start()`:**
```solidity
function start(uint256 tournamentId) external;
```
Allowed when **either** `registrants == maxPlayers`, **or**
`block.timestamp > lastStartTime && registrants >= minPlayers`. Reverts `StartConditionsNotMet`
otherwise. Effects: requests round-1 pairing randomness (does **not** build the bracket yet), sets
`state = Starting` (a new state, inserted between `Registration` and `Active` — see below), emits
`TournamentClosing(tournamentId, randomRequestId)`.

**Step 2 — `buildBracket()`, once the reveal window has opened:**
```solidity
function buildBracket(uint256 tournamentId) external; // permissionless
```
Reveals the requested randomness, actually builds the bracket, auto-resolves byes, sets
`state = Active`, emits `TournamentStarted` (same event/shape as before). Reverts `NotStarting` if
called outside the `Starting` state, or `ShuffleWindowExpired` if called more than
`SHUFFLE_REVEAL_WINDOW` (10 minutes) after `start()` without ever being called in time.

**Escape hatch — `rerollBracketShuffle()`, only needed if `buildBracket()`'s window expired:**
```solidity
function rerollBracketShuffle(uint256 tournamentId) external; // permissionless
```
Requests a fresh randomness value and resets the reveal window, emitting
`BracketShuffleRerolled(tournamentId, newRandomRequestId)`. Reverts `NotStarting` if not in the
`Starting` state, or `ShuffleWindowNotExpired` if the current window hasn't lapsed yet (i.e. you
should be calling `buildBracket()` instead, not this). Anyone can call it — no single party staying
offline (deliberately or not) should be able to block the tournament from progressing.

**`TournamentState` enum changed:**
```solidity
// Starting is new, inserted between Registration and Active -- Active/Complete/Cancelled's
// ordinal values all shifted up by one. Compare against the named value, never a hardcoded integer.
enum TournamentState { Registration, Starting, Active, Complete, Cancelled }
```

**New events:** `TournamentClosing(tournamentId, randomRequestId)` (emitted by `start()`, before the
bracket exists) and `BracketShuffleRerolled(tournamentId, newRandomRequestId)` (only fires if the
reveal window was missed). `TournamentStarted` keeps its exact old shape but is now emitted by
`buildBracket()`, not `start()`.

**Practical UI implication:** once `start()` succeeds, poll/watch for `TournamentStarted` as before,
but now also handle the tournament sitting in `Starting` for a while first. If it's been sitting
there past the reveal window with no `TournamentStarted`, offer a "reroll" action rather than
treating it as stuck — there is no way to `cancel()` a tournament once `start()` has been called
(`cancel()` still requires `state == Registration`), so reroll+build is the only recovery path if
the original `buildBracket()` call is ever missed.

## 4. UTC Lottery Hook: entry weight is now capped, and a draw can resolve with no winner

**Changed 2026-09-12 (HA2-06 fix), to `UTCLotteryHook`.** Two new owner-configurable values:

```solidity
// The *weight* credited toward one address's odds on a qualifying sell is capped at this value,
// independent of the real (uncapped) ethProceeds -- bounds how much one trade (flash-loaned or
// genuinely funded) can inflate a single address's odds. The qualifying-threshold check still
// uses real, uncapped proceeds -- only the recorded weight is capped. Defaults to 1 ether.
uint256 public maxWeightPerEntryWei;

// Floors resolveDraw's random-pick denominator so no single (already-capped) address's weight can
// ever exceed a 1/maxWinProbabilityDenominator share of a draw, even with thin real participation.
// This is *why* a draw can now resolve with no winner (see below). Defaults to 10 (never better
// than a 1-in-10 chance).
uint256 public maxWinProbabilityDenominator;
```

**A resolved draw does not always have a winner.** If real participation is thin relative to the
`maxWinProbabilityDenominator` floor, the random pick can land on "nobody," in which case
`resolveDraw` emits a new event, `DrawResolvedNoWinner(uint256 indexed drawId)`, instead of
`DrawResolved`, and mints no ship. `drawResolved[drawId]` still flips to `true` either way — **don't
use that mapping alone to infer a winner exists; check which event actually fired.** If your UI
assumed `resolveDraw` always produces a prize-ship winner, that assumption is no longer safe.
Nothing special needs to happen afterward: the next qualifying sell just starts accumulating toward
the next draw normally, no "rollover" prize to track.

Also note: `SellRecorded`'s `playerWeightInDraw` is the *capped* weight actually credited, not
necessarily the sell's raw `ethProceeds` — the event still reports the real `ethProceeds` alongside
it, so you can show both "you sold $X" and "that earned you Y entry-weight" if the two differ.

## 5. Targeting a fled/destroyed ship now reverts for *every* targeted action, including plain `Shoot`

**Extends existing guidance — this now covers the most common action in the game, not just special
abilities.** If you already handle "already-fled/destroyed ship" reverts for `DroneSwarmResolver`/
`EMPResolver`/`RamResolver`, the same check (2026-09-12, HA2-01/HA2-08 fixes) now also applies to:

| Contract/action | Error |
|---|---|
| `Game.moveShip(..., ActionType.Shoot, targetShipId)` — the base attack action | `InvalidMove` |
| `RepairResolver` (variant 2's faction ability) | `TargetNotFound` |
| `RepairDronesResolver` | `TargetNotFound` |

`Shoot` previously had *no* check that a target was still a live participant in this specific game
(only a range/line-of-sight check) — a target that had already fled or been destroyed since your
last snapshot would previously let the transaction through into a state that could permanently
break round completion. **Refresh live ship status immediately before submitting any targeted
action** (`Shoot`, `Repair`, `RepairDrones`, `Drone Swarm`, `EMP`, `Ram`) rather than trusting a
snapshot from earlier in the turn, and treat a revert on any of them as "target is stale, re-prompt
selection," not a generic failure.

## 6. `Ships.setInFleet` now rejects adding an already-destroyed ship to a fleet

**File:** `contracts/Ships.sol` (2026-09-12, HA2-03 fix). Calling `setInFleet(shipId, true)` for a
ship whose `timestampDestroyed != 0` now reverts `ShipDestroyed()` — previously a destroyed ship
could be silently re-added to a fresh fleet and fight normally, then permanently break fleet
removal later. Only the "add to fleet" direction is guarded; removing a (possibly destroyed) ship
from a fleet during cleanup still works as before. Shouldn't be reachable from a correct UI flow,
but worth knowing the revert exists as a backstop if your fleet-builder ever works from stale ship
data.

## 7. Roguelike campaign: a new place `ActiveGameInProgress` can fire

You may already know this error name from `retreatRun(0)`. As of 2026-09-12 (HA2-04 fix), it also
fires from:

| Call | Meaning |
|---|---|
| `RoguelikeMatch.enterResupplyNode` | Can't enter a resupply node while a combat game from a *previous* node is still active/unresolved — finish or forfeit that match first. |
| Any `RoguelikeResupply` action (repair, roster change) | Same underlying guard — you shouldn't be able to reach a resupply action's UI at all with a live game still open, but the contract now rejects it either way if you do. |

If your error-handling already has a generic message for `ActiveGameInProgress`, no change needed
beyond knowing it can now surface from these two spots too, not just `retreatRun`.

## 8. `Lobbies` gained a UTC withdrawal function (owner/admin-only)

**File:** `contracts/Lobbies.sol`. Not player-facing — relevant only if you have (or plan) an admin
dashboard for this project's own team, not the player-facing app.

```solidity
function withdrawUTC(address _to) external onlyOwner;
event Withdrawn(address indexed to, uint amount);
```

Fixes a real bug where UTC collected from lobby reservation fees had no withdrawal path at all and
was permanently stuck in the contract. If you're building any kind of admin/ops panel for this
project, this is a function it should expose; otherwise no action needed.

## 9. `Game.sol`'s debug functions are gone

`debugDestroyShip`, `debugSetHullPointsToZero`, `debugSetShipPosition` (all `onlyOwner`) were
removed entirely on 2026-09-16 as a centralization cleanup — they were never documented for
frontend use in the first place (owner-only test/debug shortcuts), so this shouldn't affect any
integration, but flagging in case any internal QA/testing tool called them directly against a real
deployment.

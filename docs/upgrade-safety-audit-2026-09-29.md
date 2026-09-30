# Void Tactics — Upgrade-Safety Audit (Live Games/Lobbies vs. Admin Actions)

_Written 2026-09-29. This is a live, actionable tracker, same convention as `docs/audit-2.md` — mark
an item fixed with strikethrough (`~~text~~`) plus a dated "Status: Fixed" note when it's resolved;
don't delete resolved items._

## Scope and lens

This is a **different lens than a security-vulnerability audit** (see `docs/audit-2.md` for that).
The question asked of every owner/admin-controlled setter and every piece of shared mutable state in
the whole contract set was:

> **If the contract owner calls this setter (or otherwise changes this state) at some arbitrary
> moment, does it change behavior for a lobby/game/match/tournament/run that's already been created
> or already started — and if so, is that a real problem (freezes something, corrupts an outcome,
> reverts something that used to work, silently misroutes a reward) or is it inert/cosmetic/
> future-only?**

The assumed actor throughout is the **honest, well-meaning project owner** doing ordinary live-ops
(a balance retune, an engine rollout, a content edit, deauthorizing a retired engine) — not a hostile
external attacker (that's `docs/audit-2.md`'s job). The project already built one correct pattern for
this exact problem — `ShipAttributes` publishes numbered, immutable versions and `Game.
calculateShipAttributes` pins a ship to whichever version was live when its game started, so
republishing a version never retroactively changes an in-flight game's numbers — and the whole
"engine registry" architecture (`GameEngineRegistry.sol`) exists so a gameplay-rules change ships as
a brand-new engine affecting only games created after it, never an already-running one. This audit
hunts for every place that guarantee has a gap: a live-read that was never pinned the way ship
attributes were, or an admin action that isn't actually safe to perform while anything is active.

Conducted via a personal review of the core engine (`Game.sol`, resolvers, `SpecialEffectsLib.sol`)
plus 3 parallel agents covering match orchestration/tournament, ships/fleets/economy/AI, and
maps/roguelike/campaign content. Cross-checked against `docs/pre-audit.md` and `docs/audit-2.md`
first; nothing below duplicates an existing entry under a different name (closest overlaps —
`I-02`'s general centralization note, `M-08`'s preset-map snapshot finding, `HA2-04` — are noted
inline where relevant).

---

## Critical

### ~~UA-01 — `Game.setAddresses` Swaps `maps`/`fleets`/`shipAttributes`/`ships` Live, With No Guard;
Every Active Game on That Engine Reads Them Fresh, Every Turn~~

**File:** `contracts/Game.sol:122-132` (`setAddresses`), consumed live throughout `moveShip`'s whole
call tree (`maps.hasMovementPathAvoidingShips`/`hasMapsAvoidingShips`, `fleets.isShipInFleet`/
`removeShipFromFleet`, `ships.getShip`/`markDestroyed` via the router) · **Found 2026-09-29.**

None of these four addresses are per-game snapshots — they're single top-level storage variables on
`Game.sol`, read fresh by every call, for every game this Game instance has ever started, active or
not. If the owner calls `setAddresses` on a **currently-live engine** (as opposed to only ever at
initial deploy, before any game exists), every active game on it instantly starts reading a
different `Maps`/`Fleets`/`Ships` contract for a game/ship/fleet that only exists in the *old*
contract's storage:

- `maps` swap: the new Maps instance likely has no record of this game's `_gameId` at all (map data
  is copied into per-`gameId` storage at game creation — see `Maps.applyPresetMapToGame` — which
  never happened on the new instance), so every `moveShip`/`Shoot` call for every active game reverts
  `InvalidMove` from that point on. Permanent — no player action can restore it short of the owner
  reverting the address.
- `fleets`/`ships` swap: a ship already placed into a fleet on the *old* Fleets/Ships contract
  doesn't exist in a fresh instance's storage — `isShipInFleet` reads false, `getShip` returns a
  zeroed struct — so essentially every check in `moveShip`/`_performShoot`/`_removeShipFromGame`
  (`ShipNotFound`, `ShipNotOwned`, etc.) starts failing for ships genuinely mid-match.

This directly defeats the purpose the engine-registry architecture was built for, if this setter is
ever called on the current/active engine instead of only a brand-new one before its first game.

**Fix direction:** these don't need to be mutable at all under this project's own architecture — a
rules change is supposed to get a brand-new `Game.sol` (a new engine), never a re-pointed existing
one. Make them `immutable`, set once in the constructor; if a narrow post-deploy correction window is
still wanted, gate `setAddresses` to revert once `gameCount > 0` (i.e. only usable before this
engine's very first game), and document loudly that it must never be touched on a live engine.

**Status: Fixed 2026-09-29.** Took the lighter of the two fix directions rather than full
`immutable`s: `Fleets` is deployed *after* `Game` in `ignition/modules/DeployAndConfig.ts` (a real
circular-dependency ordering constraint, not an oversight), so `maps`/`fleets` can't become
constructor args without restructuring the whole deploy graph — a much larger, riskier change for
the same practical protection. Instead, gated the existing setter:

```solidity
function setAddresses(
    address _mapsAddress,
    address _fleetsAddress,
    address _shipAttributesAddress,
    address _shipsAddress
) public onlyOwner {
    if (gameCount > 0) revert EngineAlreadyLive();
    maps = IMaps(_mapsAddress);
    fleets = IFleets(_fleetsAddress);
    shipAttributes = IShipAttributes(_shipAttributesAddress);
    ships = IShips(_shipsAddress);
}
```

`gameCount` is only ever incremented inside `startGame`, and a revert there (or anywhere else in the
same transaction) always rolls it back with everything else — so `gameCount > 0` is a fully reliable
"has this engine ever successfully started a game" signal, with no false positives from a failed
attempt. This preserves the exact existing deploy-time wiring flow (a single post-construction
`setAddresses` call, still used by both the real deploy script and the `GameEngineRegistry` test's
second-engine setup) while making it permanently impossible to call again once this engine is live.
`Game.sol` compiles at 23.854/24.576 KiB deployed (+0.032 KiB) — this is the tightest-margin contract
in the repo (per project memory), and headroom is now down to ~0.72 KiB; a future addition here
should check size early.

Regression test added to `test/Game.test.ts` ("rejects setAddresses once this engine has started its
first game (UA-01)"): confirms `setAddresses` still succeeds before any game exists (the normal
deploy-time case), then starts a real PvP game and confirms a second `setAddresses` call now reverts
`EngineAlreadyLive`. Verified genuine: temporarily removed the `gameCount > 0` check in place, reran
the test (0 passing, 1 failing, confirming it fails without the fix), then restored the real fix from
a backup copy and confirmed the restored file was byte-identical to the backup via `diff`.

---

### ~~UA-02 — `PvPMatch.setGameAddress`/`game` Has No Per-Orchestrator Snapshot; Swapping It Strands
Every Game This PvPMatch Already Started~~

**File:** `contracts/PvPMatch.sol:72-74` (`setGameAddress`), `:163-168` (`onGameEnded`'s
`if (msg.sender != address(game)) revert NotGame();`), `:117-159` (`flee`/`endGameOnTimeout`). Root
cause on the calling side: `contracts/Game.sol:554-578` (`_endGame`) invokes
`IGameOrchestrator(game.metadata.orchestrator).onGameEnded(...)` with **no try/catch** — a revert
here unwinds the entire game-ending transaction · **Found 2026-09-29.**

`Game.startGame` correctly snapshots `game.metadata.orchestrator = msg.sender` per game — that half
of the pin pattern is right. But `PvPMatch` has no mirror-image snapshot of its own: `game` is one
live pointer, consulted fresh by every call this instance has ever made.

**Scenario:** PvPMatch starts game #42 while `game == G1`. The owner later calls
`setGameAddress(G2)` — nothing gates this, and it could be an innocent fix for a bad initial deploy.
Game #42 is still active on `G1`. When it naturally concludes (a winning move, `flee`, or
`endGameOnTimeout`), `G1._endGame` calls back into this same `PvPMatch.onGameEnded`; `msg.sender` is
`G1` but `address(game)` is now `G2` → `NotGame()` reverts → **the entire ending transaction reverts,
permanently.** The game can never finish: no winner recorded, ships never released from fleets,
`GameResults` never updated. `flee`/`endGameOnTimeout` for #42 independently break too, since they'd
query metadata for gameId 42 from `G2`, which never created it.

**Fix direction:** `game`/`gameResults` don't need to be mutable under this project's own
architecture — a new engine gets a brand-new `PvPMatch` instance, not a repointed existing one (per
`GameEngineRegistry.sol`'s own header comment). Make them `immutable`. If a pre-launch correction
setter must stay, gate it the same way as UA-01 (revert once this orchestrator has ever started a
game).

**Status: Fixed 2026-09-29.** Same lighter-gate approach as UA-01 (kept both setters, rather than
making `game`/`gameResults` `immutable`, since a pre-launch correction window is still occasionally
useful). Added a `gamesStarted` counter, incremented once per call to `startGame`, and gated both
setters on it:

```solidity
uint public gamesStarted;
...
function setGameAddress(address _game) external onlyOwner {
    if (gamesStarted > 0) revert EngineAlreadyLive();
    game = Game(_game);
}

function setGameResultsAddress(address _gameResults) external onlyOwner {
    if (gamesStarted > 0) revert EngineAlreadyLive();
    gameResults = IGameResults(_gameResults);
}
```

`PvPMatch.sol` compiles at 3.876/24.576 KiB deployed (+0.150 KiB) — ample headroom, no size pressure
(unlike `Game.sol`). Regression test added to `test/PvPMatch.test.ts` ("rejects setGameAddress/
setGameResultsAddress once this orchestrator has started its first game (UA-02)"): confirms both
setters still work before any game exists, then starts a real game and confirms both now revert
`EngineAlreadyLive`. Verified genuine: temporarily removed both `gamesStarted > 0` checks, reran the
test (0 passing, 1 failing), then restored from a backup and confirmed byte-identical via `diff`. No
existing test or the deploy script ever calls either setter post-game, so there was no collision risk.

---

### ~~UA-03 — `GameResults.setIsAllowedRecorder(recorder, false)` on a Still-Active Engine's
Orchestrator Permanently Freezes Its Unresolved Games~~

**File:** `contracts/GameResults.sol:64-70` (`setIsAllowedRecorder`), `:106-135`
(`recordGameResult`, `if (!isAllowedRecorder[msg.sender]) revert NotGameContract();`); reached via
`PvPMatch.onGameEnded`'s uncaught `gameResults.recordGameResult` call, itself reached via `Game.sol`'s
uncaught orchestrator callback (same chain as UA-02) · **Found 2026-09-29.**

`isAllowedRecorder` is a well-designed additive allowlist (not a single mutable address) —
its own comment explains it was widened specifically so a new engine's `PvPMatch` can be authorized
"without displacing the previous one, whose in-flight games still need to be able to record their
results." That intent is right, but nothing in code enforces it: if the owner ever calls
`setIsAllowedRecorder(oldPvPMatch, false)` — a routine "engine v1 is retired now" cleanup action —
while `oldPvPMatch` still has any game in progress, that game's eventual win/flee/timeout hits the
same uncaught-revert chain as UA-02 (`recordGameResult` reverts `NotGameContract` → `onGameEnded`
reverts → `_endGame` reverts → the whole transaction reverts), permanently, with no retry path short
of re-authorizing the old recorder.

**Fix direction:** either (a) enforce "never revoke a recorder while it has in-flight games" (hard to
check generically on-chain — would need a per-recorder open-game counter), or (b) make the dispatch
fault-tolerant: wrap `onGameEnded`'s `recordGameResult` call (or `_endGame`'s orchestrator callback
itself) in try/catch, the same pattern this codebase already uses for win-effect dispatches
(`PvPMatch`/`RoguelikeMatch`/`Tournament` all already try/catch their win-effect loops for exactly
this "don't let a downstream failure brick the whole flow" reason) — degrade to an emitted failure
event instead of an unrecoverable freeze.

**Status: Fixed 2026-09-29.** Went with option (b) — option (a) is, by the audit's own admission,
impractical to check generically on-chain. `PvPMatch.onGameEnded` already try/catches its win-effect
dispatch loop right below the exact line that needed the same treatment; wrapped it identically:

```solidity
try gameResults.recordGameResult(_gameId, _winner, _loser) {} catch {
    emit GameResultRecordFailed(_gameId, _winner, _loser);
}
```

A revoked recorder no longer bricks the game-ending transaction — the game still ends cleanly on
`Game.sol`'s own side (ships released, winner recorded), only the PvP leaderboard write is skipped,
with a new `GameResultRecordFailed` event making that failure visible rather than silent.
`PvPMatch.sol` compiles at 3.938/24.576 KiB deployed (+0.126 KiB) — ample headroom. Regression test
added to `test/PvPMatch.test.ts` ("still ends the game cleanly (and emits GameResultRecordFailed) if
isAllowedRecorder is revoked while a game is active (UA-03)"): revokes the recorder mid-game, then
confirms `flee` still succeeds, the game shows `ended`/the correct winner on `Game.sol`, the failure
event fires, and `GameResults.isGameResultRecorded` correctly stays false. Verified genuine:
temporarily removed the try/catch (back to a bare call), reran the test (0 passing, 1 failing), then
restored from a backup and confirmed byte-identical via `diff`.

---

### ~~UA-04 — `Maps.setIsAllowedGame(engine, false)` on a Still-Active Engine Bricks Every Live Game
on It the Next Time a Round Completes With a Ship on a Scoring Tile~~

**File:** `contracts/Maps.sol:94,179-181` (`isAllowedGame`/`setIsAllowedGame`), `:894-907`
(`getScoreAndZeroOut`); `contracts/Game.sol:659-661` and `:1511-1536` (`_handleEndOfRound`) ·
**Found 2026-09-29.**

`getScoreAndZeroOut` is gated `if (!isAllowedGame[msg.sender] && msg.sender != owner()) revert
NotGameContract()`. It's called, unguarded by any try/catch, directly inside `Game._handleEndOfRound`
— itself called synchronously and unconditionally from `moveShip` every time a round completes.
`GameEngineRegistry.sol` already has a per-engine `retired` flag whose own header comment says it's
"informational only, never enforced" — i.e. this codebase already anticipates an admin "retiring" an
old engine as routine housekeeping once a new one replaces it.

**Scenario:** Engine v2 ships and is added to `isAllowedGame`. Believing engine v1 is done because no
*new* games start on it, the owner calls `setIsAllowedGame(gameV1Address, false)` to clean up. Any
PvP/SinglePlayer/Roguelike game still in progress on engine v1, the moment a round would complete
with any live ship parked on a scoring tile, has its `moveShip` call revert `NotGameContract()` —
unconditional and permanent for that game, since round-completion is the only way it advances. Any
objective-scoring map (which `Maps.sol` is clearly built to support broadly) hits this essentially
every round.

**Fix direction:** never revoke `isAllowedGame` for an engine that could still have games in
progress — either wire `GameEngineRegistry`'s `retired` flag to actually gate *new*-game-creation
paths only (leaving `getScoreAndZeroOut` always allowed for any address ever granted), or document/
enforce checking `GameEngineRegistry.engineOfGame` off-chain for zero unresolved games before
revoking. A softer option: degrade `_handleEndOfRound`'s scoring call to "skip this tile's scoring"
on a permission failure instead of reverting the whole round — trades a hard revert for silently
losing objective points, so the never-revoke-while-live discipline is the better fix.

**Status: Fixed 2026-09-29.** Took the softer option — wiring `GameEngineRegistry.retired` into
new-game-creation paths would be a much larger change touching every orchestrator, and Game.sol has
almost no bytecode headroom left to spare after UA-01. Degraded the scoring call instead:

```solidity
uint8 points;
try maps.getScoreAndZeroOut(_gameId, pos.row, pos.col) returns (uint8 p) {
    points = p;
} catch {
    points = 0;
}
if (points == 0) continue;
```

A revoked engine no longer bricks round completion — the round still finishes normally, only that
one tile's points are silently skipped for that round (not awarded some other way; this is
defense-in-depth, not a substitute for the "never revoke while live" discipline). `Game.sol` compiles
at 23.858/24.576 KiB deployed — only **+0.005 KiB** over UA-01's already-tight number, leaving
~0.718 KiB headroom. Regression test added to `test/Game.test.ts` ("does not brick round completion
if Maps.isAllowedGame is revoked for this engine mid-game (UA-04)"): revokes the engine mid-game with
a ship parked on a scoring tile, confirms both players' round-completing moves still succeed, and
confirms the points were correctly NOT awarded. Verified genuine: temporarily removed the try/catch
(back to a bare call), reran the test (0 passing, 1 failing), then restored from a backup and
confirmed byte-identical via `diff`.

---

### ~~UA-05 — `RoguelikeNodeMap.removeChild` Can Permanently Strand an In-Progress `RoguelikeRun`~~

**File:** `contracts/RoguelikeNodeMap.sol:277-290` (`removeChild`), `contracts/RoguelikeMatch.sol:
333-390` (`_commitToNode`/`_isChildOf`) · **Found 2026-09-29.**

Unlike `NodeMap` (the single-player campaign graph, whose admin edits only ever gate *future*
`startNodeMatch` calls), `RoguelikeNodeMap` is read **live** every time a run tries to move:
`_commitToNode` calls `nodeMap.getChildren(run.currentNodeId)`/`getEdge` fresh, with no snapshot at
`startRun`/node-entry time. If an admin does an ordinary graph edit — pruning a dead-end branch,
replacing a hub's children while reworking content — and removes every child edge from a node a
player's `run.currentNodeId` currently points at (with no edge back to that node's own parent), the
player's very next `enterCombatNode`/`enterResupplyNode` call reverts `CannotAdvance()` for every
possible destination. There's no way for a run to "just sit" at a dead node and resume once content
is fixed — the only escape is `retreatRun(0)`, which forfeits the entire run (ended, roster/fleet
released) as if the player had quit. The specific run is a total, unrecoverable loss purely from a
live content edit, through no fault of the player.

**Fix direction:** prefer additive-only graph edits in practice (never remove the last child/edge out
of a node without first confirming, off-chain, no run is currently sitting there — there's no
on-chain way to enumerate "which players have `currentNodeId == X`" today), or add a dedicated
recovery path (let a run with zero valid moves from its current node retreat without being scored as
a forfeit/loss).

**Status: Fixed 2026-09-29.** Neither of the two sketched directions was fully satisfying on its own —
the "recovery path" option turned out to be genuinely ambiguous in practice: a node with zero children
is *also* the normal, expected shape of a campaign's legitimate final combat node, so a rescue path
keyed purely on "zero children" can't distinguish "this run was stranded by a content edit" from "the
player is standing at the intended final boss and chose to quit," which would be indistinguishable
even to backend analytics. Instead, closed the actual gap the fix direction called out as missing —
"there's no on-chain way to enumerate which players have `currentNodeId == X`" — and enforced the
discipline in code rather than only documenting it:

- `RoguelikeRun.sol` gained `mapping(uint => uint) public activeRunsAtNode`, an occupancy counter
  incremented in `startRun`/`setCurrentNode` and decremented in `setCurrentNode`/`endRun` — kept in
  lockstep with `run.currentNodeId` at every one of its three write sites.
- `RoguelikeNodeMap.sol` gained an optional `IRoguelikeRunView public runLedger` reference (new
  minimal interface, `IRoguelikeRunView.sol`, to avoid depending on the whole `RoguelikeRun` contract)
  and a new `setRunLedgerAddress` setter. `removeChild` now refuses to remove a node's **last**
  remaining child if `runLedger.activeRunsAtNode(_parentId) > 0` — checked only for that specific
  case (removing any other child is always safe, since the run still has another way forward), and
  skipped entirely if `runLedger` is unset, matching this codebase's established "unwired = permissive
  fallback" convention (e.g. `Fleets.maps`).
- Wired `roguelikeNodeMap.setRunLedgerAddress(roguelikeRun)` into `DeployAndConfig.ts`, ordered (via
  `after:`) before the `TransferRoguelikeNodeMapOwnership` call so it's always set before ownership
  ever leaves the deployer.

This directly prevents the vulnerability at its source — an admin edit that would strand a run now
reverts `WouldStrandActiveRun` instead of silently succeeding — rather than trying to retroactively
rescue an already-stranded run after the fact. `RoguelikeRun.sol` compiles at 3.887/24.576 KiB
(+0.275 KiB) and `RoguelikeNodeMap.sol` at 7.150/24.576 KiB (+0.306 KiB) — both ample headroom.

Four regression tests added to `test/RoguelikeMatch.test.ts` under "RoguelikeNodeMap.removeChild
stranding guard (UA-05)": (1) removing a node's only child while a run stands there reverts
`WouldStrandActiveRun`; (2) removing a non-last child while a run stands there still succeeds
(confirms the guard isn't overly broad); (3) removing a node's last child succeeds once the run has
retreated away (confirms the guard isn't permanent/stuck); (4) the guard correctly follows a run as it
advances between nodes — the node it left becomes freely editable again and the new node it's standing
on becomes guarded, specifically exercising `setCurrentNode`'s increment/decrement pairing. Verified
genuine for both halves of the fix independently: temporarily removed `removeChild`'s guard clause
(test 1 failed as predicted, tests 2-3 still passed correctly since they don't depend on it) and
restored; separately, temporarily reverted `setCurrentNode`'s occupancy-tracking to its old one-line
form (only test 4 failed, isolating exactly the code it was meant to verify) and restored — both
confirmed byte-identical to backups via `diff`.

---

## Medium

### ~~UA-06 — `Game.setHealCapPercent` Is Read Live by Every Active Game's Heal Effects, Not Pinned
Per Game~~

**File:** `contracts/Game.sol:75,163-166` (`healCapPercent`/`setHealCapPercent`), consumed live at
`:1216-1240` (`_dispatchEffects`, passed straight from live storage into
`SpecialEffectsLib.resolveAndApply`) · **Found 2026-09-29.**

Unlike ship attribute numbers (pinned per-ship via `calculateShipAttributes`'s version snapshot),
`healCapPercent` has no per-game copy. Lowering (or raising) it mid-game retroactively changes how
much any already-placed ship's heal effects (RepairDrones, faction Repair) can restore, for the
*rest* of every currently active game on this engine, not just future ones. A player who built a turn
around the existing cap can find their heal suddenly capped lower mid-match, purely because of an
unrelated admin balance tweak elsewhere.

**Fix direction:** snapshot `healCapPercent` into `GameData` at `startGame` time, mirroring the
version-pinning pattern already used for ship attributes — an active game's heal cap stays fixed for
its whole duration; only a freshly-started game picks up a changed value.

**Status: Fixed 2026-09-29.** Snapshotted as planned, with one implementation wrinkle: an initial
attempt passing the pinned value as a new parameter to `SpecialEffectsLib.resolveAndApply` hit
`CompilerError: Stack too deep` in `_dispatchEffects` — that function was already at Game.sol's
legacy-codegen stack-slot limit. Fixed by adding the field directly to `GameData` instead (`uint8
healCapPercentAtStart`, deliberately not surfaced on `GameDataView` — it's an internal scheduling
detail, not player-facing state) and having `SpecialEffectsLib` read `game.healCapPercentAtStart`
directly off the storage pointer it already receives, rather than as a separate parameter — this
actually *removed* a parameter from `resolveAndApply` instead of adding one, relieving
`_dispatchEffects`' stack pressure rather than adding to it:

```solidity
// Game.sol, startGame:
game.healCapPercentAtStart = healCapPercent;

// SpecialEffectsLib.sol, resolveAndApply (healCapPercent parameter dropped entirely):
(bool removed, uint8 kind) = _applyEffect(game, ctx.shipId, effect, game.healCapPercentAtStart);
```

`Game.sol` compiles at 23.864/24.576 KiB (+0.006 KiB over UA-04's number) and `SpecialEffectsLib.sol`
actually *shrank* by 0.021 KiB (dropping a parameter more than paid for the new field read). One
existing test ("should cap a RepairDrones heal at healCapPercent...") called `setHealCapPercent`
*after* its game had already started and expected the change to apply retroactively — exactly the
bug this fix closes — so it needed updating to set the cap before game start to preserve its actual
intent (verifying RepairDrones heals are capped) under the corrected semantics; it and the sibling
"reverts setHealCapPercent above 100..." test (which never starts a game, unaffected either way) both
still pass. New regression test added ("keeps an active game's heal cap pinned to whatever was live
at startGame, even if the owner lowers it mid-game (UA-06)"): starts a game at the default 100% cap,
lowers it to 1% *after* the game has started, then confirms a RepairDrones heal still restores the
full, uncapped amount — proving the pin held. Verified genuine: temporarily made `_dispatchEffects`
re-write `healCapPercentAtStart` from the live variable on every call (simulating the old live-read
behavior), reran the test (0 passing, 1 failing), then restored all three touched files from backups
and confirmed each byte-identical via `diff`.

---

### ~~UA-07 — `Game.setFactionAbilityResolver`/`setSpecialResolver` Are Read Live at Dispatch Time,
Not Pinned Per Game~~

**File:** `contracts/Game.sol:141-154`, consumed live at `:1160-1206` (`_performSpecial`/
`_performFactionAbility`) · **Found 2026-09-29.**

Same shape as UA-06: no per-game pinning of which resolver address handles a given
faction/special-slot. If the owner retunes or fixes a bug in a resolver by calling these setters
directly on the **current, active** engine's `Game.sol` — instead of shipping the fix as part of a
new engine, which is what the whole registry architecture exists to make unnecessary to do live —
every active game immediately starts using the new resolver mid-match. This is exactly the
"in-flight rules change" scenario the engine-registry project was built to prevent, and it bypasses
that protection entirely because the swap happens on the live `Game.sol`, not via a new engine
deploy.

**Fix direction:** treat resolver retuning the same as any other rules change — ship it via a new
engine (a fresh `Game.sol` with the new resolver wired at deploy time), never via a live setter call
on an engine with active games. If a live-patchable resolver is genuinely wanted for urgent fixes,
pin the resolver *address* per-game at `startGame`/`calculateShipAttributes` time instead of reading
it live, so an in-flight game keeps using whichever resolver was active when it started.

*(Note: `Game.setMaxSpecialSlot` was checked and confirmed **safe** — it's only consulted by
`GenerateNewShip`/`DroneYard` at ship-generation/customization time, never by `_performSpecial`'s
actual dispatch, so it only affects future ship loadouts, never an already-equipped ship in an active
game.)*

**Status: Fixed 2026-09-29.** Per-game pinning (the second option) turned out not to be practical:
unlike UA-06's single scalar, resolvers span an open-ended, owner-configured `(variant, slot)` space
with no cheap way to snapshot "every configured entry" at `startGame` — and `Game.sol` has almost no
bytecode headroom left to spare for trying. Took the first option instead, and made it an *enforced*
guard rather than only a documented discipline — same `gameCount > 0` gate as UA-01:

```solidity
function setFactionAbilityResolver(uint16 _variant, address _resolver) public onlyOwner {
    if (gameCount > 0) revert EngineAlreadyLive();
    factionAbilityResolvers[_variant] = _resolver;
}

function setSpecialResolver(uint16 _variant, Special _slot, address _resolver) public onlyOwner {
    if (gameCount > 0) revert EngineAlreadyLive();
    specialResolvers[_variant][_slot] = _resolver;
}
```

This directly enforces "a genuine resolver retune ships via a new engine, never a live setter call on
one with active games" in code, rather than relying on operator discipline alone. `Game.sol` compiles
at 23.929/24.576 KiB (+0.064 KiB over UA-06's number) — headroom is now ~647 bytes; any further
addition to this contract should check size first. Confirmed no collision risk: every existing call to
either setter (in `test/Game.test.ts`, `test/GameEngineRegistry.test.ts`, and
`ignition/modules/DeployAndConfig.ts`) happens before any game exists on that `Game` instance.
Regression test added to `test/Game.test.ts` ("rejects setFactionAbilityResolver/setSpecialResolver
once this engine has started its first game (UA-07)"): confirms both setters still work before any
game exists, then starts a real game and confirms both now revert `EngineAlreadyLive`. Verified
genuine: temporarily removed both guards, reran the test (0 passing, 1 failing), then restored from a
backup and confirmed byte-identical via `diff`.

---

### UA-08 — AI Opponent's "Brain" (`AIBehaviorRegistry`) Is Never Pinned Per Run — An Admin Can Change
How the AI Thinks or Rams/Heals Mid-Match

**Files:** `contracts/AIBehaviorRegistry.sol:31-34` (`setVariantAI`), consumed live at
`SinglePlayerMatch.sol:475`/`RoguelikeMatch.sol:699` (`aiRegistry.aiFor(info.variant).decide(...)`,
called every single AI turn); `SinglePlayerMatch.sol:163`/`RoguelikeMatch.sol:167`
(`setAIRegistryAddress`, swaps the whole registry). Related: `contracts/Variant1AI.sol:37,50-52,64,
176` / `contracts/Variant2AI.sol:36,44-46,70` read `RamResolver.range`/`RepairResolver.range` live,
also with no per-game pin (both resolvers' `setRange` is instant and global) · **Found 2026-09-29,
independently by two review passes.**

Unlike `ShipAttributes`, `AIBehaviorRegistry` has no versioning — it's a bare live pointer
(`mapping(uint16 => IVariantAI)`), re-resolved fresh on every AI turn, never cached or pinned at run
start. A human plays several nodes forming a mental model of how the AI behaves, then mid-run the
owner calls `setVariantAI`/`setAIRegistryAddress` (a routine AI balance patch, not a rare migration)
— the very next AI turn in that same already-committed run uses the new logic, with nothing
analogous to `Attributes.version` protecting the player. Separately, Ram's and Repair's *innate*-
ability range (as opposed to equipped-Special ranges, which correctly go through the pinned
`getSpecialRangeAt` path) is read the same live, unpinned way by both the AI's own decision logic and
the resolver's combat enforcement — a mid-game `RamResolver.setRange`/`RepairResolver.setRange`
changes every ship's ram/heal distance immediately, in every currently-active game using that
resolver (this includes PvP, not just single-player/roguelike).

**Aggravating factor:** `decide()` is called synchronously inside move resolution with no try/catch —
swapping in a not-yet-battle-tested `IVariantAI` implementation that reverts on some archetype/
special combination would revert that turn's resolution, pushing this toward Critical for that
specific failure mode until the registry is reverted.

**Fix direction:** mirror the `ShipAttributes` pattern — pin the AI implementation address (or a
version) per run at `startRun`/`enterCombatNode` time, and have `_decideMove` read the pinned
reference for that run's lifetime. For Ram/Repair range, pin the range into the ship's `Attributes`
snapshot (or a small versioned table on the resolver) at game start, same as equipped-Special ranges
already are.

**Status: Partially fixed 2026-09-29 — AI-registry pinning done; Ram/Repair range pinning deferred
(see below).**

~~The AI-registry half~~ is fixed: both `SinglePlayerMatch.sol` and `RoguelikeMatch.sol` gained a
`mapping(uint => address) public aiRegistryAtStart`, set from the live `aiRegistry` the moment a
combat game is created (`startNodeMatch`/`enterCombatNode` respectively), and `_decideMove` in both
contracts now reads `AIBehaviorRegistry(aiRegistryAtStart[_gameId])` instead of the live `aiRegistry`
field. `SinglePlayerMatch.sol` compiles at 15.362/24.576 KiB (+0.098 KiB) and `RoguelikeMatch.sol` at
22.004/24.576 KiB (+0.142 KiB) — both ample headroom. One regression test added to each of
`test/SinglePlayerMatch.test.ts` and `test/RoguelikeMatch.test.ts`: starts a real combat game, swaps
in a brand-new, empty `AIBehaviorRegistry` (no variant registered) mid-fight, and confirms
`takeAITurn` for that already-active game still succeeds — a live read would instead revert
`NoAIForVariant` from the new, unconfigured registry. Verified genuine independently for each
contract: temporarily reverted `_decideMove`'s lookup back to the live `aiRegistry` field, reran that
file's test (0 passing, 1 failing each time), then restored from a backup and confirmed
byte-identical via `diff`.

**The Ram/Repair range half is not fixed — deferred, not just documented-and-skipped.** A first
attempt pinning the range on first use per game (`mapping(uint gameId => uint8) rangeAtFirstUse`,
written inside `resolveEffect` itself) hit a real architectural wall: `IEffectResolver.resolveEffect`
is declared `view` in the shared interface every one of the 7 resolvers implements, and Solidity
requires an implementation's mutability to be *at least as strict* as the interface's — so making
just `RamResolver`'s `resolveEffect` state-changing (to write the pin) requires dropping `view` from
the interface itself, which ripples into every other resolver's call sites, `MockGameView.sol`'s
`callResolveEffect` test helper (also `view`, and a `view` function cannot call a non-view external
function), and the ~13 existing test call sites across `test/EffectResolverTargetStatus.test.ts`/
`test/SpecialVersionPinning.test.ts` that currently read `resolveEffect`'s return value directly via
`.read.` (only possible for a `view` call — a state-changing call would need `.simulate.`/`.write.`
instead). This blast radius is disproportionate to this one narrower sub-finding within a Medium, so
it was rolled back rather than pushed through under time pressure — confirmed `RamResolver.sol`
compiles back to its exact original size (2.469 KiB, 0.000 delta) after reverting. The
higher-value fix would route Ram/Repair range through `ShipAttributes`'s existing per-variant,
per-version table (the same mechanism equipped-Special ranges already use via `getSpecialRangeAt`),
which avoids the interface-mutability problem entirely but is a real schema addition (new versioned
fields, deploy-seeding, `Variant1AI.sol`/`Variant2AI.sol` updates) — left as a distinct follow-up
rather than folded into this pass.

---

### ~~UA-09 — `SinglePlayerOrchestratorRegistry.setOrchestrator` Is Read Live on Every Kill;
Deregistering Mid-Run Silently Misroutes Reward Tokens~~

**File:** `contracts/SinglePlayerOrchestratorRegistry.sol:25-37`; consumed at
`contracts/DestroyRewardLib.sol:39-52` (`isSinglePlayerOrchestrator`), called from `Ships.sol` on
every kill · **Found 2026-09-29.**

An AI-owned ship's "owner" is the orchestrator contract itself. `payDestroyReward` decides UTC-vs-
faction-token purely by asking this registry, live, at the moment of each kill — no per-run/per-game
snapshot. If the owner deregisters an orchestrator while a run/game started on it is still active,
every kill processed against it *after* deregistration silently falls into the wrong branch and mints
the wrong reward token — no revert, just a wrong, silent payout mid-run.

**Fix direction:** treat this the same as UA-03/UA-04 (never flip registration while the orchestrator
has an active run — document/enforce), or snapshot the reward-routing decision per active run/game
rather than re-deriving it live from current registry state on every kill.

**Status: Fixed 2026-09-29.** Per-run/per-game snapshotting didn't actually fit this finding —
`isRegisteredOrchestrator` classifies a CONTRACT ADDRESS (which orchestrator an AI ship belongs to),
not something scoped to one run or game; the same classification applies to every kill that
orchestrator will ever process, across every run it has or ever will have. Enforced the "never
deregister while live" discipline directly in code instead — disallow the `true -> false` direction
entirely, since nothing about this registry's legitimate use case (registering a new AI-owning
orchestrator for a new engine, additively) ever needs it:

```solidity
function setOrchestrator(address _orchestrator, bool _allowed) external onlyOwner {
    if (!_allowed && isRegisteredOrchestrator[_orchestrator]) {
        revert CannotDeregisterOrchestrator();
    }
    isRegisteredOrchestrator[_orchestrator] = _allowed;
    emit OrchestratorSet(_orchestrator, _allowed);
}
```

`SinglePlayerOrchestratorRegistry.sol` compiles at 0.854/24.576 KiB (+0.066 KiB) — trivial. Confirmed
no collision risk: both existing deploy-script calls (`ignition/modules/DeployAndConfig.ts`) register
`SinglePlayerMatch`/`RoguelikeMatch` with `true`, never `false`. Regression test added to
`test/RoguelikeMatch.test.ts` ("rejects deregistering an already-registered orchestrator, but still
allows registering a new one (UA-09)"): confirms deregistering `roguelikeMatch` reverts
`CannotDeregisterOrchestrator` and leaves it still registered, while registering a brand-new address
still works unrestricted. Verified genuine: temporarily removed the guard, reran the test (0 passing,
1 failing), then restored from a backup and confirmed byte-identical via `diff`.

---

### ~~UA-10 — `Lobbies.pvpMatch`/`fleets` Read Live at the Moment a Lobby's Second Fleet Completes —
A Lobby With One Side Already Committed Can Silently Switch Engines Mid-Selection~~

**File:** `contracts/Lobbies.sol:118-124` (`setPvpMatchAddress`/`setFleetsAddress`), `:660-670` (live
read of `pvpMatch` inside `createFleet`) · **Found 2026-09-29.**

`Lobbies.basic.costLimit`/`turnTime`/`selectedMapId`/`maxScore` are already correctly snapshotted
into the `Lobby` struct at creation (safe, worth noting as the right pattern) — `pvpMatch`/`fleets`
have no equivalent. A lobby can sit in `FleetSelection` for up to `MAX_TURN_TIME` (24h) with one side
already committed (ships marked `inFleet=true`) before the second side submits. If the owner calls
`setPvpMatchAddress` during that window (e.g. mid-rollout of a new engine), the second fleet's
submission calls `startGame` on whichever engine is *currently* configured, not whichever was live
when the first player locked in — the match can silently start on different gameplay rules than the
committed player expected, or (if the new engine isn't fully wired yet) the joiner's `createFleet`
reverts entirely and atomically until the admin finishes wiring — self-resolving, not a permanent
freeze, but still a real surprise for the first-committed player in the success case.

**Fix direction:** snapshot `pvpMatch` into the `Lobby` struct at creation (or at first-fleet-commit)
and have `createFleet` call the snapshotted address rather than live storage.

**Status: Fixed 2026-09-29.** Added `address pvpMatch` to `LobbyGameConfig` (`Types.sol`), set from
the live `pvpMatch` storage variable at the end of both `createLobby` and `createLobbyForAddresses`
(the same point the other per-lobby config fields are already snapshotted), and changed the
`startGame` call site inside `createFleet` from `pvpMatch.startGame(...)` (live storage) to
`PvPMatch(lobby.gameConfig.pvpMatch).startGame(...)` (the pinned value). `fleets` was left live-read
by design — it's only ever consulted inside `Fleets.createFleet` itself (already-safe per UA's own
"confirmed well-designed" section: deployment zones are read once, atomically, at that same
fleet-creation call), not at the later `startGame` moment this finding is about.

`Lobbies.sol` compiles at 15.326/24.576 KiB deployed (+0.101 KiB) — ample headroom. Regression test
added to `test/Lobbies.test.ts` ("keeps a lobby's game on the engine that was live at lobby creation,
even if pvpMatch is repointed mid-FleetSelection (UA-10)"): creator commits a fleet first, the owner
then repoints `Lobbies.pvpMatch` at a second, deliberately unwired `PvPMatch` instance (simulating a
mid-rollout engine swap), and the joiner's fleet submission is asserted to still succeed — landing
the game on the *original* engine's `Game` contract — rather than reverting `NotLobbiesContract` from
the new, unwired instance. Verified genuine: temporarily reverted the `startGame` call site back to
the live `pvpMatch` read, reran the test (0 passing, 1 failing — the joiner's `createFleet` call
rejected exactly as predicted), then restored the real fix from a backup copy and confirmed the
restored file was byte-identical to the backup via `diff`.

---

### ~~UA-11 — `RoguelikeMatch.onGameEnded` Re-Derives `isFinalNode`/`campaignAutoHealPercent`/
`getNodeWinEffects` Live at Combat-*Resolution* Time, Not Combat-*Entry* Time~~

**File:** `contracts/RoguelikeMatch.sol:485` (`campaignAutoHealPercent`), `:507`
(`nodeMap.getChildren(run.currentNodeId).length == 0` → `isFinalNode`), `:526`
(`getNodeWinEffects`) · **Found 2026-09-29.**

All three are read fresh when a fight concludes, not pinned to whatever was true when the player
entered that node. If an admin adds a child to what was a leaf node while a player is mid-fight
there, a win no longer ends the run as `Won` even though the player entered believing it was final
(or the reverse: removing a non-final node's last child mid-fight ends the run early on that win). A
mid-combat retune of the auto-heal percent or win-effects list changes what a player who started the
fight under the old numbers actually receives. Non-corrupting/recoverable (the run keeps
progressing, it just gets the "wrong" number for that one resolution), so Medium rather than
Critical.

**Fix direction:** pin `isFinalNode`/heal%/win-effects to the node's config as read when the player
entered combat (pass them through into the game or a per-run snapshot at `enterCombatNode` time)
rather than re-deriving them from live `RoguelikeNodeMap`/config state when the game ends.

**Status: Fixed 2026-09-29.** Added three storage mappings keyed by `gameId` —
`healPercentAtStart`/`isFinalNodeAtStart`/`winEffectsAtStart` (the last a private `address[]`,
exposed only via the existing win-effect dispatch, not a bare public array) — all written once in
`enterCombatNode` right after `gameId` is computed, and read by `onGameEnded` in place of the three
live derivations:

```solidity
// enterCombatNode:
healPercentAtStart[gameId] = nodeMap.campaignAutoHealPercent(run.campaignId);
isFinalNodeAtStart[gameId] = nodeMap.getChildren(_targetNodeId).length == 0;
winEffectsAtStart[gameId] = nodeMap.getNodeWinEffects(_targetNodeId);

// onGameEnded, respectively:
uint8 healPercent = healPercentAtStart[_gameId];
bool isFinalNode = isFinalNodeAtStart[_gameId];
address[] memory winEffects = winEffectsAtStart[_gameId];
```

`RoguelikeMatch.sol` compiles at 22.386/24.576 KiB (+0.382 KiB over UA-09's number) — headroom is now
~2.19 KiB. Two regression tests added to `test/RoguelikeMatch.test.ts`: one confirms a node that was
final (childless) at entry still ends the run as `Won` even after an admin adds a child to it
mid-fight (a live re-check would instead see the new child and wrongly continue the run); the other
confirms a 90%-at-entry heal floor still applies to that fight's result even after an admin retunes
it to 1% mid-fight. Both verified genuine independently: reverted `isFinalNode`'s line back to the
live derivation (only the first test failed, as predicted), restored and confirmed byte-identical,
then separately reverted `healPercent`'s line (only the second test failed, isolating exactly that
code), restored and confirmed byte-identical again. `winEffectsAtStart` uses the identical
snapshot-and-read pattern as the other two and was reviewed but not independently tested — no
existing win-effect resolver in the test fixtures is easy to distinguish "old vs. new configured
list" without a dedicated mock, and the mechanism is structurally the same one just verified twice
over for its siblings.

---

### ~~UA-12 — `Maps.setBlockedTile`/`setImpassableTile`/`setScoringTile` Write Directly Into Live,
Per-`gameId` Storage That's Read Every Turn of an Already-Active Game~~

**File:** `contracts/Maps.sol:768-829` (`onlyMapEditor`) · **Found 2026-09-29.**

Unlike the *preset*-map editing functions (confirmed safe below — they only ever touch
`presetBlockedMapsBitmap[mapId]`, never the per-game copy), these three write straight into the same
per-`gameId` bitmap storage that `hasMaps`/`hasMovementPath`/`isTileScoring`/`getScoreAndZeroOut` read
live every turn/round. This is an intentional per-game debug/admin lever, not a bug in itself, but
`_gameId` and `_mapId` are both plain `uint`s and easy to confuse — a map editor targeting the wrong
id would silently change LOS/movement/scoring for a live match mid-turn, with no revert to signal the
mistake. No test or production path calls these outside admin/debug tooling today.

**Fix direction:** add an "only if this game hasn't ended" guard at minimum, and consider
distinguishing `_gameId` from `_mapId` more strongly at the ABI level (e.g. a wrapper type or a
clearer function name) to reduce mix-up risk.

**Status: Fixed 2026-09-29.** Implemented the "at minimum" guard (Maps.sol had ample headroom to
afford it, unlike Game.sol). Added an optional `IGameEngineRegistry public engineRegistry` reference
(unwired = permissive fallback, same convention as UA-05's `RoguelikeNodeMap.runLedger`) plus a new
minimal `IGameEndedView` interface (matching `Game.getGameMetadataAndTurnState`'s real signature) so
Maps.sol can trustlessly resolve *which* Game contract a `_gameId` lives on and ask it whether that
specific game has ended, all without depending on the whole `Game` contract:

```solidity
function _gameHasEnded(uint _gameId) private view returns (bool) {
    if (address(engineRegistry) == address(0)) return false;
    address engine = engineRegistry.engineOfGame(_gameId);
    if (engine == address(0)) return false;
    (GameMetadata memory metadata, ) = IGameEndedView(engine)
        .getGameMetadataAndTurnState(_gameId);
    return metadata.ended;
}
```

Each of the three setters now calls `if (_gameHasEnded(_gameId)) revert GameAlreadyEnded();` right
after their existing bounds check. `IGameEngineRegistry.sol` gained a matching `engineOfGame` read
declaration (the concrete `GameEngineRegistry` contract already exposed this as an auto-generated
public-mapping getter; only the interface needed updating). Wired
`maps.setEngineRegistry(gameEngineRegistry)` into `DeployAndConfig.ts`, ordered before
`TransferMapsOwnership` via `after:`. `Maps.sol` compiles at 18.098/24.576 KiB (+0.897 KiB) — ample
headroom remains (~6.5 KiB). All 118 existing tests in `test/Maps.test.ts` still pass unaffected
(they exercise these setters against synthetic gameIds never recorded in the registry, so the guard
is a no-op permissive fallback for them — zero collision risk). Regression test added to
`test/Game.test.ts` ("rejects setBlockedTile/setImpassableTile/setScoringTile against an
already-ended game, but still allows them against an active one (UA-12)"): confirms all three setters
still work against a genuinely active game, then confirms all three correctly revert
`GameAlreadyEnded` once that same game has ended (via `flee`). Verified genuine: temporarily removed
just `setBlockedTile`'s guard clause, reran the test (0 passing, 1 failing — only that setter's own
assertion failed, confirming the other two setters' independent guards were unaffected and still
correctly enforced), then restored from a backup and confirmed byte-identical via `diff`. The
softer, ABI-naming-distinction half of the fix direction was left out — the enforced guard makes it
redundant for the case that actually mattered.

---

### UA-13 — `PvPMatch.winEffects`/`Tournament.winEffects` Are Global Lists Read Live Only at
Conclusion, Not Pinned Per-Match/Per-Tournament

**File:** `contracts/PvPMatch.sol:63-70` (`setWinEffects`), consumed in `onGameEnded` (already
try/catch'd per-effect — good); `contracts/Tournament.sol:243-250` (`setWinEffects`), consumed in
`finalize` (also already try/catch'd — good) · **Found 2026-09-29.**

Changing the win-effects list mid-match/mid-tournament changes what bonus a participant receives
relative to what was configured when they joined/registered, with no enforced relationship between
"what was live when you signed up" and "what fires when you win." Not a freeze risk — both dispatch
loops are already fault-tolerant (a broken effect just emits `WinEffectFailed` rather than blocking
the payout) — but a real, soft fairness inconsistency on an optional bonus layer. Leans Low given
this project's already-accepted "DEC/UTC is a deliberately dynamic economy" design stance.

**Fix direction:** optional — snapshot the win-effects list (or a version pointer) at match-start/
registration time if strict "what you signed up for is what you get" fairness matters here;
otherwise acceptable to leave live.

**Status: Reviewed 2026-09-29, left as-is.** This finding's own fix direction already frames pinning
as optional, with "acceptable to leave live" as the explicit alternative — unlike every other item in
this doc, there's no freeze/corruption/misrouted-funds risk here, both dispatch loops are already
fault-tolerant, and the inconsistency is scoped to an optional bonus layer on top of a currency this
project has already deliberately chosen not to treat as strictly fair/fixed (DEC/UTC's "deliberately
dynamic economy" stance, referenced above). Implementing the pin would mean either a new `GameData`
field (competing for Game.sol's ~647 bytes of remaining headroom for a Low-leaning nice-to-have) or a
second per-gameId array mapping on `PvPMatch.sol` (which has room, but for a fix this finding itself
says isn't required). Left unfixed by deliberate choice, not overlooked.

---

## Low

### UA-14 — A `ShipAttributes` Contract *Address* Swap (Not a Version Publish) Would Desync In-Flight
Games' Pinned Version Numbers

**Files:** `contracts/Ships.sol:615-638` (`setConfig`), `contracts/Fleets.sol:67-69`
(`setShipAttributes`), `contracts/Variant1AI.sol:44-48`/`Variant2AI.sol:48-52`
(`setShipAttributesAddress`), `contracts/Game.sol`'s own `shipAttributes` (via `setAddresses`, see
UA-01) · **Found 2026-09-29.**

`Attributes.version`/`getSpecialRangeAt(variant, version, special)` correctly pin *which published
table* a ship uses — but every consumer reaches that table through its own independently
owner-settable `shipAttributes` *address*. Re-pointing to a genuinely different `ShipAttributes`
deployment mid-game (as opposed to publishing version N+1 within the same instance, the normal, safe
operation) makes an in-flight game's pinned version number resolve against the new contract's data —
which may not exist (a loud `InvalidAttributesVersion` revert) or, worse, exist with different
content (silently wrong stats, no revert). This is a materially rarer operation than routine version
publishing and isn't called out anywhere else in the audit docs.

**Fix direction:** document as an operational rule ("never repoint `shipAttributes` to a new
deployment while any game is active"); pin the address itself per-game only if the team wants this
edge case fully closed in code.

**Status: Reviewed 2026-09-29, left as-is.** UA-01's fix already closes the `Game.sol` half of this
in practice (`setAddresses`, including `shipAttributes`, is now permanently locked once this engine
has started any game — see UA-01). `Fleets.sol`'s own `shipAttributes` reference is likewise already
safe (per "Already well-designed" below: only read inside `createFleet`, never by the mid-game-callable
functions). The one genuinely live remaining path is `Variant1AI.sol`/`Variant2AI.sol`'s own
`setShipAttributesAddress` — consulted on every AI turn — but these are stateless per-decision
contracts with no natural "games currently active" counter to gate a lock on (unlike an orchestrator's
`gameCount`), so a `gameCount`-style guard doesn't fit cleanly, and a permanent one-time lock would be
far more restrictive than intended. Given the fix direction's own "pin only if the team wants this
edge case fully closed" framing, and that the actual trigger (redeploying a whole new `ShipAttributes`
contract, not publishing a new version within the same one) is a rare, deliberate migration action,
left as documented operational guidance rather than forcing an awkward-fitting mechanism: never
repoint any `shipAttributes` reference to a new contract deployment while games/runs are active —
only publish new versions within the existing instance for routine rebalancing.

---

### UA-15 — `Ships.recycleReward()` Is Read Live Mid-Game for Kill-Destroy Payouts

**File:** `contracts/ShipsRouter.sol:130` (inside `setTimestampDestroyed`), backing state
`contracts/Ships.sol:655-657` (`setRecycleReward`) · **Found 2026-09-29.**

Not snapshotted at game start. If the owner changes it mid-game, kills earlier in the same match were
paid at the old rate and later kills at the new rate — inconsistent but fully recoverable (no revert,
no corrupted state, each individual payout is still correct math for its own moment). Low given this
project's documented stance that DEC/UTC is an informal, farmable currency, not the core competitive
stake.

**Fix direction:** snapshot at game start if full consistency is wanted, or accept and document as
intentional ("rewards reflect the current economy by design").

**Status: Reviewed 2026-09-29, left as-is.** This finding's own fix direction offers "accept and
document as intentional" as a fully legitimate resolution, matching this project's already-established
design stance that DEC/UTC is a deliberately dynamic, farmable economy rather than a fixed/fair
competitive stake (see project memory on DEC economy design). No freeze, corruption, or misrouted-funds
risk — each payout is individually correct for its own moment, just at whatever rate was live then.
Left unfixed by deliberate choice: rewards reflect the current economy by design.

---

### ~~UA-16 — `RoguelikeResupply.resupplyModifyRoster` Reads `campaignRequiredVariant` Live~~

**File:** `contracts/RoguelikeResupply.sol` (~line 187) · **Found 2026-09-29.**

Read fresh on every roster-modification call, not snapshotted at `startRun`. Tightening/loosening a
campaign's required faction mid-run changes what the very next resupply stop enforces, relative to
what the run actually started under. Can't corrupt an existing roster, only affects which new ships
can be added going forward — minor fairness inconsistency only.

**Status: Fixed 2026-09-29.** Added `uint16 requiredVariantAtStart` to `RoguelikeRun.sol`'s `Run`
struct, set once via a new parameter on `startRun` (passed through from `RoguelikeMatch.startRun`,
which already computed this exact value to validate the run's initial roster — no new external call
needed). `RoguelikeResupply.resupplyModifyRoster` now reads `run.requiredVariantAtStart` (already
loaded into memory at the top of the function) instead of calling
`nodeMap.campaignRequiredVariant(run.campaignId)` live:

```solidity
// RoguelikeRun.startRun (new param):
run.requiredVariantAtStart = _requiredVariant;

// RoguelikeResupply.resupplyModifyRoster:
uint16 requiredVariant = run.requiredVariantAtStart;
```

`RoguelikeRun.sol` compiles at 3.986/24.576 KiB (+0.100 KiB), `RoguelikeMatch.sol` at 22.418/24.576 KiB
(+0.032 KiB), and `RoguelikeResupply.sol` actually *shrank* to 7.854/24.576 KiB (-0.153 KiB — no longer
paying for the external `nodeMap` call). `RoguelikeRun.startRun` has exactly one caller
(`RoguelikeMatch.sol`), confirmed via repo-wide search, so no other call site needed updating.
Regression test added to `test/RoguelikeMatch.test.ts` ("keeps a run's required-variant rule pinned to
whatever was live at startRun, even if an admin retunes it mid-run (UA-16)"): starts a run while the
campaign is unrestricted, tightens the requirement to variant 1 mid-run, then confirms a resupply stop
can still swap the roster to an all-variant-2 fleet — proving the pinned (unrestricted) rule applied,
not the tightened live one. Verified genuine: temporarily reverted `resupplyModifyRoster`'s line back
to the live `nodeMap` call, reran the test (0 passing, 1 failing), then restored all three touched
files from backups and confirmed each byte-identical via `diff`.

---

### UA-17 — Contrived Facade-Address-Swap Risks (Noted, Not Urgent)

- `Fleets.setShipsAddress` / `ShipsRouter`'s constructor-fixed `ships`/`aiShips` references:
  swapping either mid-flight (a genuine facade migration, not routine ops) would desync
  `removeShipFromFleet`/`clearFleet`/`setTimestampDestroyed` for any game whose ships live in the old
  backing store. Operational-caution item only.
- `Tournament.feeRecipient` (`Tournament.sol:237-239`, consumed at `:618`): live-read at `finalize()`,
  redirects only the protocol's own 1% fee, never touches player payouts (`t.winnings[...]` are fixed
  percentages regardless) — doesn't fit the player-facing-disruption lens, noted for completeness.
- `Ships.setCostOfShip`'s `msg.sender == config.gameAddress` branch is dead code in the current
  wiring (nothing outside `Ships.sol` calls it) — not a live-game issue, just vestigial.

**Status: Reviewed 2026-09-29, no action needed.** All three sub-items were noted at the time as
operational-caution/dead-code/out-of-lens, with no fix action suggested for any of them. Re-confirmed
on this pass: none touch player-facing, in-flight game/run state.

---

## Already well-designed (confirmed by tracing, not assumed)

Worth recording explicitly so future work doesn't accidentally "fix" something that's already
correct, and so the patterns above get reused rather than reinvented:

- **`Game.metadata.orchestrator`** is snapshotted to `msg.sender` once per game and used for every
  later callback/authorization check — the correct half of the pin pattern; UA-02 is the *missing*
  mirror-image snapshot on the orchestrator's own side, not a flaw in this mechanism.
- **`GameResults.isAllowedRecorder`** and **`Maps.isAllowedGame`** being additive allowlists (not
  single mutable pointers) is the right shape for multiple concurrent engines — they only become
  dangerous on *revocation* while still in use (UA-03/UA-04), never from adding a new entry.
- **`Tournament.game`/`gameResults`** are `immutable` — zero drift risk, by construction.
- **`Tournament.TournamentConfig`** is fully snapshotted into `t.config` at `createTournament`, with
  no setter that can mutate an already-created tournament's config.
- **`RandomManager.sol`** has zero owner-controlled state at all — not `Ownable`, no admin setter
  anywhere in the file.
- **`GameEngineRegistry.sol`** does exactly what its header comment claims: `currentEngine`/
  `setRetired`/`setIsAllowedToRecord` are pure FE-guidance/bookkeeping, never consulted by any
  per-turn gameplay call. The only on-chain-consequential path, `recordGameEngine`, runs once per new
  game at creation, atomically with the rest of that same transaction.
- **`Lobbies.universalCredits`/`maps`/`paused`/`maxFleetCostLimit`/`freeGamesPerAddress`/
  `additionalLobbyFee`** — all confirmed safe: consulted only at brand-new-lobby-creation time (the
  correct place for a live "price/eligibility to join" check), or never re-read by an
  already-created lobby at all.
- **`Maps.sol` preset-map edits never leak into an already-created game.** `applyPresetMapToGame`/
  `applyPresetScoringMapToGame` copy the preset's data into **per-`gameId`** storage exactly once, at
  creation; every live read (`hasMaps`, `hasMovementPath`, `isTileScoring`, `getScoreAndZeroOut`)
  uses that per-game copy, never the live preset directly. Reconfirms `pre-audit.md`'s `M-08` and
  extends it correctly to the newer impassable-tile bitmask code.
- **Deployment zones** (`setCreatorZone`/`setJoinerZone`) are read live via `isValidDeploymentTile`,
  but that's only ever called from `Fleets.createFleet`, itself only called once atomically at
  fleet-creation/game-start — never re-read mid-game.
- **`NodeMap.sol`** (single-player campaign graph): read once at `startNodeMatch`, fed straight into
  fleet creation + `Game.startGame` in the same transaction. `completedNodes` is an independent,
  permanent boolean never re-derived from `prerequisites`, so later graph edits can't retroactively
  un-complete a node or affect a game already in progress on it.
- **`AIEncounters.sol`**: AI ship configs are read exactly once at fleet-mint time and copied into
  the actual minted `Ship` struct plus a local `aiShipInfo` cache used for all later turn-decision
  logic — mirrors `Game.calculateShipAttributes`'s snapshot-once protection for player ships. An
  admin editing/deleting a config after a game has started cannot alter an already-fighting AI ship.
- **`RoguelikeNodeMap` combat-node fields** (mapId/turnTime/maxScore/creatorGoesFirst) are read once
  at `enterCombatNode` and fed straight into fleet creation + `Game.startGame` — editing a node's
  settings never reaches back into a game already created from it.
- **`NodeContentRegistry.sol`** is pure display metadata (title/description strings), not read by any
  gameplay contract — cosmetic-only by construction.
- **`RoguelikeRun.sol`**'s HP/lock/defeated state is generation-scoped (keyed by `run.generation`,
  bumped every `startRun`), so a new run never inherits a previous run's persisted damage or branch
  lockouts.
- **`DroneYard`/`ShipPurchaser`/`GenerateNewShip`/`VariantPurchaseGate`/`AIShips.allocateShip`**: all
  consulted only at purchase/customization/allocation time, strictly before a ship is committed to
  any fleet or game (blocked by the existing `inFleet` gate) — none of their config can leak into an
  active game.
- **`Fleets`'s own `shipAttributes`/`maps` addresses** are only read inside `createFleet`;
  `clearFleet`/`removeShipFromFleet` (the mid-game-callable functions) never touch either.
- **`ShipAttributes` version-pinning itself** is correctly used everywhere it matters for gameplay —
  every live/unpinned getter (`getSpecialRange`, `getSpecialStrength`, `getGunData`, etc.) was
  grepped across the whole tree; none are called from any in-game/AI-decision path. The one gap found
  is the innate-ability range case folded into UA-08.

---

## Suggested prioritization

1. **UA-01 through UA-05 (Critical)** — these are the ones that can outright freeze or permanently
   strand a game/run. All five share the same shape: an admin action that's meant to be routine
   ("swap a facade address," "retire an old engine," "prune a content graph") turns out to be
   unsafe specifically because nothing pins the value an already-active game/run depends on. Worth
   fixing before this project relies on the engine-registry architecture for a real live rollout —
   otherwise the very first "retire the old engine" cleanup step is the thing that breaks it.
2. **UA-06 through UA-13 (Medium)** — real, but recoverable/non-corrupting mid-game surprises. Worth
   fixing opportunistically, roughly in the order listed (heal cap and resolver addresses, since
   they're the most central to combat fairness; AI-brain pinning next, since it's the most player-
   visible; the rest are narrower).
3. **UA-14 through UA-17 (Low)** — document as operational rules first (cheap), fix in code only if
   the team wants the edge case fully closed rather than just avoided by discipline.

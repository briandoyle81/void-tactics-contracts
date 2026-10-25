# Void Tactics — Open Security/Audit Items

> **2026-10-13:** `docs/audit-3.md` (pass HA6) is now the live tracker for new findings. Still-open
> items below are listed there under "Carried forward".

_Created 2026-09-12. This is the live, actionable tracker — every item below is currently open
(not fixed, not accepted-as-a-non-issue). `docs/pre-audit.md` is the full historical audit record
(every finding ever made, including everything already fixed or resolved) and is kept exactly as
it stands as of this date — going forward, **new findings and status changes belong here, not
there.** Where useful, an item below links back to its original write-up in `docs/pre-audit.md`
(searchable by the finding code, e.g. `H-07`) for the full original investigation notes; this doc
gives the concise, current version._

**When an item here gets fixed:** mark it with strikethrough (`~~text~~`), same convention
`pre-audit.md` already uses — keep the original text intact, add a short "Fixed <date>" note.
Don't delete resolved items from this doc; move on to a `docs/audit-3.md` only if this one grows
unwieldy the same way `pre-audit.md` did.

---

## High

### ~~H-07 — `Game.flee` Is Missing a `_requireGameExists` Check~~

**File:** `contracts/Game.sol`, lines 1358–1380 · **Full history:** `pre-audit.md`, search `H-07`

A dead, commented-out check means `flee` operates on a default-zeroed `GameData` reference for a
non-existent `_gameId`. A call with `address(0)` as the player would pass the owner-mismatch guard
(since `address(0) == address(0)`) and write garbage winner state into game slot 0. Live
exploitability is low (`msg.sender == address(0)` has no known private key), but the guard should
exist as defense-in-depth.

**Fix:** replace the dead check with a real call to the existing `_requireGameExists(_gameId)`
helper, already shared by 6 other call sites in this file.

**Why still open:** `Game.sol` was at 23.879 KiB against the 24 KiB limit as of the original
finding (~124 bytes headroom) — deferred until there's confirmed room to absorb it alongside other
pending fixes. **Re-check current headroom before landing this** — it may have shrunk or grown
since.

**Status: Resolved 2026-09-16, as a side effect of an unrelated refactor — found during the HA3
audit pass, not deliberately fixed.** `flee` no longer lives in `Game.sol` at all — it moved to
`PvPMatch.sol` in the orchestrator split, and the G-04 gas fix changed it to call
`game.getGameMetadataAndTurnState(_gameId)`, which itself calls `_requireGameExists` and reverts
`GameNotFound()` for a nonexistent game (confirmed by direct trace of both functions). The original
dead-code gap no longer exists; no further action needed.

---

### ~~HA3-01 — `Lobbies.sol` Has No Withdrawal Function for UTC Reservation Fees; Funds Permanently Locked~~

**File:** `contracts/Lobbies.sol`, lines 333-344 (fee collection), 798-803 (`withdraw`, ETH-only)

`createLobby`'s reserved-joiner path charges a 1 UTC reservation fee via
`universalCredits.transferFrom(msg.sender, address(this), reservationFee)`, unconditionally, on
every reserved lobby created. No refund exists on `rejectGame`/`timeoutJoiner`/`leaveLobby`, and
`Lobbies.sol`'s only fund-recovery function, `withdraw()`, sweeps `address(this).balance` —
**native ETH only**. Confirmed via a full-file grep: `universalCredits` is referenced exactly
twice in the entire contract — the balance check and the `transferFrom` that pulls funds in.
Nothing ever moves UTC back out. Every reserved lobby ever created permanently locks 1 UTC with
zero recovery path, for anyone, including the owner. Identical bug class to the already-fixed
**H-04** (`DroneYard` had the same gap; fixed by adding an `onlyOwner withdraw(address)` for UTC).

**Fix:** add the same pattern `DroneYard`/`SinglePlayerMatch` already use — an
`onlyOwner withdrawUTC(address _to)` sweeping `universalCredits.balanceOf(address(this))`.

**Status: Fixed 2026-09-16.** Added `withdrawUTC(address _to)` to `Lobbies.sol`, matching
`DroneYard.withdraw`'s exact shape (`onlyOwner`, sweeps `universalCredits.balanceOf(address(this))`
via `transfer`, reverts `"UTC transfer failed"` on a falsy return, emits a new `Withdrawn(address
indexed to, uint amount)` event — this contract didn't have one). `Lobbies.sol` has ample bytecode
headroom (15.202/24.576 KiB deployed after this fix), so no size pressure.

New test in `test/Lobbies.test.ts` (`"Game Reservation"` describe block):
`"lets the owner withdraw locked UTC reservation fees (HA3-01)"` — creates a reserved lobby
(locking 1 UTC exactly as the finding describes), confirms a non-owner call reverts
`OwnableUnauthorizedAccount`, then confirms the owner can withdraw the full locked balance to an
arbitrary recipient and the contract's UTC balance drops to zero. Verified genuine: temporarily
neutralized the fix (zeroed out the withdrawn `amount` before restoring the real
`balanceOf`-sourced version), confirmed the new test went red, then restored the real fix from a
backup and reconfirmed byte-identical. Full suite re-run afterward: exit code 0, no regressions
(`PRODUCTION` confirmed `false` beforehand).

---

### ~~HA3-03 — `Tournament.assignMatchGame` Lets a Match's Own Losing Player Permanently Freeze the Entire Tournament's Prize Pool~~

**File:** `contracts/Tournament.sol` — `assignMatchGame` (444-457), `recordResult` (461-490),
`resolveDraw` (501-530), `claimForfeitWin` (537-553), `resolveStalledMatch` (564-...), `_advance`
(747-769), `finalize` (582-...), `cancel`/`claimRefund` (404-430)

**Severity escalated from Medium to High after a deeper pass, explicitly assuming one of the two
match players themselves is hostile, not just an uninvolved third party** (per direction) — this
changes the threat model materially: a random griefer has no reason to keep paying gas forever for
no benefit, but the *losing* player in a match has a direct, standing incentive to prevent that
loss from ever being recorded, for as long as they're willing to keep transacting.

**The mechanism, traced end to end:**
- `recordResult` takes no `gameId` parameter — it reads `t.bracket[matchId].gameId` from storage
  at call time.
- `assignMatchGame` has no "already assigned" guard and no caller restriction, and stays fully
  reassignable by anyone until `m.resolved` becomes `true`.
- Both fallback paths — `claimForfeitWin` and `resolveStalledMatch` — require `m.gameId == 0` to
  even be callable. **Nothing ever resets `m.gameId` back to 0** once any value has been assigned.

**The attack:** the losing player calls `assignMatchGame(tournamentId, matchId, garbage)` at any
point before `recordResult` would succeed against the real game. This makes `recordResult` revert
(`GameNotFound`/`WinnerNotInMatch`/`GamePredatesAssignment` depending on what "garbage" resolves
to) and simultaneously permanently blocks both escape hatches, since `m.gameId` can never return
to `0` again. If the honest winner (or anyone) re-assigns the correct `gameId`, the loser simply
re-clobbers it again — there's no cost asymmetry protecting the honest side, and no rate limit.

**Why this is High, not Medium — traced the full blast radius, not just "one match stuck":**
`_advance` only populates a match's parent bracket slot when that match resolves, so a
permanently-stuck match permanently blocks every match above it, all the way to the final.
`finalize()` (which distributes the *entire* prize pool — every registrant's entry fee plus any
sponsor contribution) requires `t.champion != address(0)`, which is only ever set when the final
match resolves. **`cancel()`/`claimRefund()` only work while the tournament is still in
`Registration`** — once `Active` (which happens before any match is even played), there is no
cancellation path and no owner override of any kind. **One hostile loser, in one single match,
anywhere in the bracket, can permanently freeze every registrant's and any sponsor's funds, with
zero on-chain recovery path for anyone, including the tournament owner.**

**Secondary, harder-to-execute residual risk, noted but not the primary fix target:** even with
assignment-time validation (below), a hostile loser could in principle arrange a *second*, distinct
real game against the same opponent (started after `readyAt`) and try to swap the match's record to
point at whichever of the two games favors them — but this requires the honest opponent's active
cooperation in creating/joining that second game, which they'd have no reason to give. Worth being
aware of, not worth engineering around given it needs victim participation.

**Fix (two changes, both required — one alone isn't sufficient):**
1. **Validate at assignment time**, not just at resolution time: reuse the exact checks
   `recordResult`/`resolveDraw` already perform independently — the game's participants must match
   `m.player1`/`m.player2` (either order) via `game.getGameMetadataAndTurnState`, and
   `gameMetadata.startedAt > m.readyAt` (the existing T-02 anti-replay check). This makes it
   impossible to ever assign a garbage or mismatched `gameId` in the first place.
2. **Make assignment sticky**: once `m.gameId != 0`, reject further `assignMatchGame` calls for
   that match (reuse the existing `GameAlreadyAssigned` error, already used for the same concept in
   `claimForfeitWin`/`resolveStalledMatch`). Combined with (1), this closes both the DoS-via-
   reassignment vector and the result-substitution-via-reassignment vector, since the *only* value
   that can ever be assigned is already a genuinely valid, correctly-paired, correctly-timed game —
   there's no legitimate case left needing a correction. This also matches the design this
   contract's own comments already assume: `claimForfeitWin`'s doc comment says a stalled *assigned*
   game should be resolved via `Game.endGameOnTimeout` + `recordResult`, not by reassigning to a
   different game — "assign once" simply makes the code match the already-documented intent.

Permissionless-ness itself is fine to keep (the documented "no single point of failure" rationale
still holds, and is actually strengthened once assignment is validated+immutable — anyone stepping
in to correctly assign a stalled match's real `gameId` is purely helpful, never harmful).

**Status: Fixed 2026-09-16.** Implemented exactly the two-part fix above, in `assignMatchGame`
itself: `if (m.gameId != 0) revert GameAlreadyAssigned();` first (sticky assignment), then
`game.getGameMetadataAndTurnState(gameId)` (naturally reverts `GameNotFound` for a nonexistent
game — no separate existence check needed), the same participant-matching check
`resolveDraw` already uses (reusing `WinnerNotInMatch` for "this game isn't for these two
players," consistent with how `recordResult` already reuses that same error for the analogous
check), and the same `GamePredatesAssignment` T-02 timing check `recordResult`/`resolveDraw` both
already perform independently — now enforced at assignment time instead of only at resolution
time. `Tournament.sol` has ample bytecode headroom (16.644/24.576 KiB deployed after this fix, up
from 16.259 KiB), no size pressure.

Three existing tests needed updating, not just new ones added — this fix changes *when* certain
reverts fire, which is a real behavioral change existing coverage had to be re-verified against,
not just supplemented:
- `"rejects reusing a game that predates this match becoming ready (T-02)"` — the
  `GamePredatesAssignment` revert now fires at `assignMatchGame` itself, not at the later
  `recordResult` call. Updated the assertion to match.
- Two tests (`"rejects claimForfeitWin once a game has already been assigned"`,
  `"rejects resolveStalledMatch once a game has already been assigned"`) previously used a fake
  `999n` gameId purely to make `m.gameId != 0` true — that assignment now correctly fails
  validation itself (as it should), so both needed a genuinely real game instead. Added a shared
  `createRealGameBetween(deployed, playerA, playerB)` test helper (purchase+construct ships,
  `Lobbies.createLobbyForAddresses`, both fleets — no moves needed, since `Game.startGame` sets
  `metadata.startedAt` as soon as both fleets exist) rather than duplicating that setup a third
  time inline.

Verified genuine: temporarily removed the entire new validation block (sticky guard +
participant/timing checks) from `assignMatchGame`, recompiled, and confirmed the T-02 test — the
one whose assertion now depends specifically on the new fix's timing — went red, while the other
28 tests in the file (including the two `GameAlreadyAssigned` tests, which test a *different*,
pre-existing guard inside `claimForfeitWin`/`resolveStalledMatch` themselves) correctly stayed
green, confirming the revert change was isolated to exactly where intended. Restored the real fix
from a backup and reconfirmed byte-identical. Full suite re-run afterward: exit code 0, no
regressions (`PRODUCTION` confirmed `false` beforehand).

---

### ~~HA4-01 — `GameEngineRegistry`/`SinglePlayerMatch`/`RoguelikeMatch`: a Second Engine's Single-Player or Roguelike Orchestrator Can Never Start Its First Game~~

**File:** `contracts/GameEngineRegistry.sol` (`recordGameEngine`, lines 124-129); `contracts/SinglePlayerMatch.sol` (gameId computed at lines 57, 211-212); `contracts/RoguelikeMatch.sol` (gameId computed at lines 52, 215-216) · **Status: found 2026-09-28, during the "full audit" pass, in this session's own new (uncommitted, not yet deployed) engine-registry work — not a pre-existing/live bug.**

`SinglePlayerMatch.NODE_MATCH_ID_OFFSET` (`2**40`) and `RoguelikeMatch.ROGUELIKE_GAME_ID_OFFSET`
(`2**41`) are fixed constants, identical across every deployment of these contracts. Each
contract computes its gameId from its **own** storage counter (`nodeMatchCount`/`matchCount`),
which always starts at 0 on a fresh deploy — so a **second** `SinglePlayerMatch` (or
`RoguelikeMatch`) instance's very first game computes the exact same gameId as the **first**
instance's very first game (`OFFSET + 1`, identical either way).

`GameEngineRegistry.recordGameEngine`, which both orchestrators now call unconditionally right
after `game.startGame(...)` succeeds (added this session), reverts `GameAlreadyRecorded()` the
moment a gameId it already has an entry for is recorded again:
```solidity
if (engineOfGame[_gameId] != address(0)) revert GameAlreadyRecorded();
```
Since this call has no `try/catch`, that revert unwinds the entire enclosing transaction —
including the `game.startGame(...)` call that already succeeded moments earlier in the same
transaction. **Concretely: the moment a second engine's `SinglePlayerMatch`/`RoguelikeMatch` is
registered and used, its very first `startNodeMatch`/`enterCombatNode` call reverts, unconditionally,
every time** — not a rare edge case, the guaranteed first-use outcome. `PvPMatch` is unaffected:
its gameId is `lobbyId`, sourced from the single **shared** `Lobbies` contract's ever-incrementing
`lobbyCount`, which stays globally unique across every engine since `Lobbies` itself is never
re-deployed, only re-pointed at whichever `PvPMatch` is current.

**Why this wasn't caught by the full test suite (811/811 passing) before this audit:** the new
`test/GameEngineRegistry.test.ts` only exercises a second `PvPMatch`, never a second
`SinglePlayerMatch`/`RoguelikeMatch` — so the collision path was never on any tested code path.

**Status: Fixed 2026-09-28.** Folded an immutable per-instance `engineIndex` into each
orchestrator's gameId computation instead of touching `GameEngineRegistry.sol` (kept
self-contained to the two orchestrators, no new coupling): `gameId = OFFSET + engineIndex *
ENGINE_ID_BLOCK_SIZE + counter`, with `ENGINE_ID_BLOCK_SIZE = 2**64` — a block per engine large
enough that no realistic `nodeMatchCount`/`matchCount` could ever grow into the next engine's
range. `engineIndex` is a new, final constructor parameter on both `SinglePlayerMatch.sol` and
`RoguelikeMatch.sol`; the current (and, as of this fix, only) deploy passes `0`, which reproduces
today's exact `OFFSET + counter` numbering unchanged — confirmed by the full test suite (every
existing hardcoded `NODE_MATCH_ID_OFFSET`/`ROGUELIKE_GAME_ID_OFFSET`-based gameId assertion in
`test/SinglePlayerMatch.test.ts`, `test/RoguelikeMatch.test.ts`, `test/AIShipConfigs.test.ts`, and
`test/VariantAITrees.test.ts` still passes unmodified). A future second engine deploys its
orchestrators with `engineIndex = 1`, `2`, etc.

Bytecode: `SinglePlayerMatch.sol` +148 bytes (15.265/24.576 KiB deployed), `RoguelikeMatch.sol`
+147 bytes (21.862/24.576 KiB deployed, still ~2.1 KB headroom) — both comfortably clear of the
limit.

**Regression test:** `test/GameEngineRegistry.test.ts`, `"HA4-01: two SinglePlayerMatch instances
never collide"` — deploys a second `SinglePlayerMatch` (`engineIndex = 1`) reusing every other
shared contract verbatim (deliberately isolating the test to the gameId-uniqueness mechanism
itself, not a full second engine stack), starts a real node match on each instance against the
same campaign node, and confirms both gameIds are distinct and both record correctly in
`GameEngineRegistry.engineOfGame`. Verified genuine: temporarily reverted the gameId computation
back to `OFFSET + counter` (no `engineIndex` term), confirmed the test failed with the exact
predicted `GameAlreadyRecorded()` collision, then restored the real fix from a backup and
reconfirmed byte-identical. Full suite re-run afterward (`PRODUCTION` confirmed `false`
beforehand).

---

### H-08 — `Ships.purchaseWithFlow` Referral Transfer Occurs Before State Finality

**File:** `contracts/Ships.sol`, lines 163–165 · **Full history:** `pre-audit.md`, search `H-08`

`_processReferral`'s raw `.call{value: referralAmount}("")` can be made to revert by a malicious
contract named as `_referral`, which reverts the entire `purchaseWithFlow` transaction. Confirmed
this is pure griefing/DoS, not fund loss — a reverted transaction takes no `msg.value` and mints no
ships, so the buyer only loses gas on the failed attempt, then can retry without that referral.

**Self-referral half:** accepted as intended behavior, not a bug — no fix needed for that part.

**Fix (revert-on-receive half only), designed 2026-09-12, not yet implemented — no bytecode
headroom in `Ships.sol` right now:** decouple the referral payout from the mint via a pull-payment/
credit-balance model, so a hostile referrer can only forfeit their own payout, not block the
buyer's purchase. This is the same shape `ShipPurchaser.withdrawUTC()`/`withdrawFlow()` and the
`DroneYard` H-04 fix already use elsewhere in this repo, not a new pattern.

```solidity
mapping(address => uint256) public referralBalance;
uint256 public totalReferralLiability;

function _processReferral(address _referrer, uint _shipsSold, uint _salePrice) internal {
    referralCount[_referrer] += _shipsSold;
    // ... same tier math as today ...
    uint referralAmount = (_salePrice * referralPercentage) / 100;
    referralBalance[_referrer] += referralAmount;       // credit, not send
    totalReferralLiability += referralAmount;
}

function withdrawReferralBalance() external nonReentrant {
    uint256 amount = referralBalance[msg.sender];
    referralBalance[msg.sender] = 0;                    // zero before the external call (CEI)
    totalReferralLiability -= amount;
    (bool success, ) = payable(msg.sender).call{value: amount}("");
    if (!success) revert ReferralTransferFailed();
}
```

**Risk this design must account for, found while working out the fix (2026-09-12):** the plain
version of this fix (mapping + withdrawal function only, no `totalReferralLiability`) would
introduce a real, adjacent problem — `Ships.sol` already has an owner-only `withdraw()`:
```solidity
function withdraw() external onlyOwner {
    (bool success, ) = payable(owner()).call{value: address(this).balance}("");
    if (!success) revert WithdrawalFailed();
}
```
Today this is safe because referral ETH is paid out immediately (same transaction as the
purchase), so it never sits in the contract long enough for `withdraw()` to reach it. Once
referral payouts become deferred balances sitting *inside* `address(this).balance` with nothing
distinguishing them from the owner's legitimate proceeds, `withdraw()` would sweep them right
along with everything else — draining the very balance `withdrawReferralBalance()` needs to pay
out, even though each referrer's mapping entry still (correctly) shows them as owed. Not
exploitable by an outside attacker (`withdraw()` is `onlyOwner`), but a real foot-gun for an
honest owner who doesn't think about it, and it hands the single owner key (already flagged as a
centralization risk in **I-02** above) a new way to strand real value even by accident, not just
by design.

**Confirmed fix for that adjacent risk:** track `totalReferralLiability` (shown above) and change
`withdraw()` to only sweep the surplus:
```solidity
function withdraw() external onlyOwner {
    uint256 available = address(this).balance - totalReferralLiability;
    (bool success, ) = payable(owner()).call{value: available}("");
    if (!success) revert WithdrawalFailed();
}
```
This makes `withdraw()` structurally incapable of touching money earmarked to referrers, whether
the owner is careless or actively hostile.

**Why not implemented yet:** `Ships.sol` is chronically near the 24 KiB contract-size limit (the
same constraint `H-07` above is deferred for) — this fix needs a new mapping, a new uint256, a new
external function, and a modified `withdraw()`, which is a nontrivial amount of bytecode for a
contract that's already tight. Revisit once there's confirmed headroom, or once a size-reduction
pass creates room — this repo's established pattern for a `Ships.sol` feature that won't fit in
place is to extract it into its own standalone contract wired through the existing
`isAllowedToCreateShips`-style authorized-caller allowlist, rather than trimming unrelated code to
make space (see e.g. how `FreeShipClaim.sol`/`TutorialClaim.sol` were split out).

---

### ~~HA4-02 — `UTCLotteryHook.resolveDraw` Can Be Permanently Bricked for a Specific Draw by a Hostile Participant Using a Non-Receiving Contract as Their Credited Address~~

**File:** `contracts/UTCLotteryHook.sol:290-298` (`_extractPlayer`), `:371-431` (`resolveDraw`);
`contracts/Ships.sol:495-524` (`_mintShip`, uses OpenZeppelin `_safeMint`) · **Found 2026-09-28.**

`_extractPlayer` decodes the address credited for a qualifying sell entirely from caller-supplied
`hookData` (`abi.decode(hookData, (address))`), with only a non-zero check — **no verification
that this address has any relationship to the actual swap signer.** Any address performing a real
qualifying sell (≥ `minEntryThresholdWei`, weight capped at `maxWeightPerEntryWei` per the already-fixed
HA2-06) can attribute that entry's weight to *any* address, including a purpose-built contract that
always reverts in `onERC721Received`.

Once a draw resolves, the prize mints directly and unconditionally to the picked winner —
```solidity
ships.createSpecificShip(winner, _buildPrizeShip(_drawId, t));   // or
ships.createShips(winner, 1, fallbackVariant, 4, false);
```
— both routes go through `Ships._mintShip`'s `_safeMint`, confirmed via direct grep. Neither call
is wrapped in `try/catch`. Since `randomManager.fulfillRandomRequest(requestId)` (called earlier in
the same function) reads back an already-revealed, permanently-fixed value, **retrying
`resolveDraw(_drawId)` later produces the identical winner every time** — if that winner is the
hostile non-receiving contract, `resolveDraw` for that specific `_drawId` reverts forever, with no
owner override and no alternate resolution path anywhere in the call chain.

**Concrete attack:** attacker deploys a contract that always reverts on `onERC721Received`,
performs one real qualifying sell crediting that contract's address via `hookData`, and — if
selected as winner (bounded odds per HA2-06, but real and repeatable across every future draw at
will) — permanently denies that draw's prize to every honest participant, for the cost of one
swap's slippage/fees.

**Why this matters:** the exact "permanently-lockable state via a single failing external call"
bug class already found and fixed three times elsewhere in this project (HA2-01, HA2-04, HA3-03) —
and the correct pattern already exists in this same repo for exactly this shape of problem
(`RoguelikeMatch.onGameEnded`'s and `Tournament.finalize`'s win-effect dispatches both wrap the
risky external call in `try/catch` for precisely this reason). `resolveDraw` is the one place that
mints directly, unguarded, to a caller-influenced address.

**Status: Fixed 2026-09-28.** Wrapped both mint calls in `try/catch`; on failure, emits a new
`PrizeMintFailed(drawId, winner)` event instead of `DrawResolved` — the draw still resolves
(`drawResolved[_drawId]` was already set `true` earlier in the function, and now nothing after it
can unwind that). Went one step past the baseline fix direction without the full "separate claim"
redesign: a **queued curated template is only dequeued on success** (`delete prizeQueue[queueHead];
queueHead++;` moved inside the `try` block, after the mint succeeds) — a failed mint no longer
burns it, it stays queued for the next draw. The random 4-star fallback path has no equivalent
state to preserve, so it's a bare `try/catch` around the same `ships.createShips` call.

Bytecode: `UTCLotteryHook.sol` +156 bytes (11.949/24.576 KiB deployed) — ample headroom.

**Regression test:** `test/UTCLotteryHookSwap.test.ts`, `"resolves a draw instead of permanently
reverting when the picked winner can't receive the prize NFT (HA4-02)"` — deploys a new
`MockNonReceivingContract` (`contracts/mocks/MockNonReceivingContract.sol`, reverts in
`onERC721Received`), attributes two real sellers' qualifying sells to it via `hookData` (both
sells credit the same address so it's the draw's sole distinct participant — with
`minParticipants` lowered to 1 — and wins with certainty, not just high probability), and confirms
`resolveDraw` succeeds, `PrizeMintFailed` fires naming the poison contract, and no `DrawResolved`
is emitted for that draw. Verified genuine: temporarily reverted both `try/catch` wrappers back to
bare calls, confirmed the test failed with the exact predicted revert, then restored the real fix
from a backup and reconfirmed byte-identical. Full suite re-run afterward (`PRODUCTION` confirmed
`false` beforehand).

---

### ~~HA4-03 — `Lobbies.timeoutJoiner` Lets a Hostile Lobby Creator Repeatedly Penalize Innocent Joiners for Near-Zero, Reusable Cost~~

**File:** `contracts/Lobbies.sol:507-550` · **Found 2026-09-28.**

`timeoutJoiner` only checks that the **joiner** hasn't submitted a fleet
(`joinerFleetId != 0 → revert`) and that `turnTime` has elapsed since they joined — it never checks
whether the **creator** (the caller, and the party being protected from an absent counterpart) has
submitted a fleet either. Contrast with the symmetric escape hatch `quitWithPenalty` (line 661),
confirmed to correctly require the *penalizing* party (the joiner) has already committed a real
fleet (`joinerFleetId == 0 → revert NotInLobby`) **and** the party being penalized (the creator)
has not (`creatorFleetId != 0 → revert FleetAlreadyCreated`) before applying any penalty.
`timeoutJoiner` has no equivalent "the creator held up their own end" check.

**Concrete attack:** Mallory creates a cheap/free public lobby (`MIN_TIMEOUT` = 5 minutes, the
minimum allowed `turnTime`; `createLobby` is free up to `freeGamesPerAddress`). Alice joins,
expecting a real match. Mallory never creates a fleet. After 5 minutes, Mallory calls
`timeoutJoiner(lobbyId)` — it succeeds, since it only checks Alice's state, not her own. This
increments Alice's `kickCount` (a penalty meant for players who abandon games) and locks her out of
creating/joining any lobby for `kickCount * KICK_PENALTY_PER_HOUR` (1 hour, multiplying with every
additional kick). The lobby resets to `Open`, not deleted, and Mallory's own state is untouched —
she can repeat this against the next innocent joiner on the same lobby id immediately, indefinitely,
at gas-only cost. A `reservedJoiner`-targeted variant can escalate one specific victim's lockout
without bound.

**Why this matters:** a zero/near-zero-cost, repeatable griefing vector against the core
matchmaking flow — the exact "no profit needed, only needs to cost the attacker nothing" attack
class this project's own CLAUDE.md standing rule calls out. Undermines "joining an open lobby" as a
safe action.

**Status: Fixed 2026-09-28.** Implemented exactly the fix direction above: the `kickCount`/
`lastKickTime` penalty is now conditional on `lobby.players.creatorFleetId != 0`. The lobby-reclaim
path (reset to `Open`, clear tracking) is unconditional either way — the creator can always
reclaim their own lobby, they just can't punish the joiner for it unless they held up their own end
first.

Bytecode: `Lobbies.sol` +61 bytes (15.226/24.576 KiB deployed) — ample headroom.

**Two pre-existing tests needed updating, not just a new one added** — both had (unintentionally)
encoded the buggy behavior as expected: `"should prevent creating lobby when in timeout"` and
`"should revert when joining while in timeout"` both timed out a joiner via a creator who never
created a fleet, then asserted the joiner *was* penalized (`PlayerInTimeout` on their next
`joinLobby`). Both were about the timeout mechanism generally, not this fairness rule specifically,
so both were updated to have the creator legitimately commit a fleet first — preserving their
original intent under the corrected behavior rather than treating them as collateral damage.

**New regression test:** `test/Lobbies.test.ts`, `"should NOT penalize the joiner via timeoutJoiner
when the creator never created a fleet (HA4-03)"` — reproduces the exact scenario from the finding
(creator times out a joiner without ever creating a fleet), confirms the lobby still resets to
`Open`, confirms the joiner's `kickCount` stays `0`, and confirms they can immediately join another
lobby without hitting `PlayerInTimeout`. Verified genuine: temporarily reverted the fix (penalty
applied unconditionally again), confirmed the two updated pre-existing tests and the new test all
correctly reflected the change (new test fails without the fix, as expected), then restored the
real fix and reconfirmed. Full suite re-run afterward (`PRODUCTION` confirmed `false` beforehand).

---

### ~~HA2-01 — `Game._performShoot`/`calculateShipAttributes` Let Any Player Permanently Freeze a Live PvP Match~~

**File:** `contracts/Game.sol` — `calculateShipAttributes` (338-356), `_performShoot` (770-837),
`_removeShipFromGame` (1138-1200), `_incrementReactorCriticalTimerForZeroHPShips` (1223+)
**Status:** Fixed 2026-09-12 (see below). **Full write-up:** `pre-audit.md`, search `HA2-01` (also
**reopened and superseded `L-01`**, whose "won't fix, nothing ever reads a stray entry" resolution
was disproven — see that entry).

`calculateShipAttributes` is public and permissionless with no check that `_shipId` actually
belongs to `_gameId`; `_performShoot` never checks the target's per-game status (alive/fled/
destroyed) or fleet membership. An attacker can "revive" a fled/absent enemy ship's attributes for
free, shoot it to 0 HP, and once its reactor-critical timer would hit 3, the mandatory
`_removeShipFromGame` call reverts `ShipNotFound()` (it's in neither fleet) — which rolls back the
timer increment too, so **every future attempt to complete that round hits the identical revert,
forever.** The only escape is `PvPMatch.flee`, which forces the fleeing player to eat an unfair
loss.

**Originally proposed fix:** mirror the existing SP-02 fix already applied to `RamResolver`/
`EMPResolver`/`DroneSwarmResolver` — add a target-status check to `_performShoot`, and an
active-participant check to `calculateShipAttributes` itself (closes `L-01` fully too).

**Fixed 2026-09-12 — narrower than originally proposed, and confirmed necessary this way.**
Traced the exploit further before implementing: the "never placed in this game at all" variant
doesn't even need `calculateShipAttributes` — a never-touched `game.shipAttributes[X]` already
defaults to `hullPoints == 0`, which `_performShoot`'s existing 0-HP branch happily walks into the
same reactor-timer/`_removeShipFromGame` freeze regardless. So gating `calculateShipAttributes`
alone would **not** have closed this — the fix had to live in `_performShoot` itself. Added one
check there (`targetShipPos.shipId == 0 || targetShipPos.status != 0`, mirroring the exact SP-02
pattern), merged into the block's existing range/line-of-sight `if` to avoid three separate
`if/revert` blocks — purely a bytecode-size move, `Game.sol` had zero room for a fourth branch.
Also inlined a single-use local (`shooterPos`) for the same reason. Net result: `Game.sol` sits
at **exactly** 24,576/24,576 bytes (0 headroom) — any future change to this file will need to find
savings elsewhere first. `calculateShipAttributes`/`calculateFleetAttributes` were deliberately
**not** touched — with `_performShoot` now rejecting non-participant targets, a stray populated
entry is harmless again, restoring `L-01`'s original (now-accurate-again) reasoning. Regression
test: `test/Game.test.ts`, `"rejects shooting a ship that was never placed in this game (HA2-01)"`
— verified to actually fail without the fix (temporarily reverted, confirmed red, restored) before
being trusted. Full suite: 655/655 passing.

---

### ~~HA2-02 — `UTCLotteryHook._beforeInitialize` Has No Caller Check — Any Third Party Can Permanently Hijack the Pool Lock~~

**File:** `contracts/UTCLotteryHook.sol`, lines 194-211 · **Status:** Fixed 2026-09-12 (see below)
· **Full write-up:** `pre-audit.md`, search `HA2-02`

**Was the most time-sensitive item in this document.** `_beforeInitialize` discarded the real
caller (`sender`) entirely and only checked the currency pair. `PoolManager.initialize` is fully
permissionless on the real Uniswap v4 contract (independently confirmed against
`node_modules/@uniswap/v4-core`). `scripts/deployUTCLotteryPool.ts` deploys the hook and calls
`initialize` as **two separate transactions** — any third party who noticed the hook deployed in
that window could have called `initialize` first with the correct currency pair but a bogus
fee/price, permanently locking the hook to their empty pool, with no owner reset for `poolLocked`.

**Fixed 2026-09-12.** Added `if (sender != owner()) revert OwnableUnauthorizedAccount(sender);` as
the first check in `_beforeInitialize` — reuses `Ownable`'s own error rather than a new one, for
consistency with every other access-control revert on this contract. `sender` is the parameter
Uniswap's `Hooks.beforeInitialize` forwards (the real, original caller of `PoolManager.initialize`,
confirmed against `@uniswap/v4-core` source), not this contract's own `msg.sender` — that
distinction is why a plain `onlyOwner` modifier couldn't be used directly here. `UTCLotteryHook.sol`
has plenty of bytecode headroom (11.535 → 12.886 KiB deployed, nowhere near its own limit), so no
size pressure.

**`scripts/deployUTCLotteryPool.ts` updated to match:** step 11's `PoolManager.initialize` call now
sends from `shipMinterClient` (the same wallet already used for the `Ships.setIsAllowedToCreateShips`
grant) instead of the general deploy wallet, with an explicit check that it actually matches
`hookOwnerAddress` before use — they default to the same `MAP_EDITOR` address but aren't guaranteed
to, so the script verifies rather than assumes. If no matching wallet is available, the script now
prints the calldata for manual submission and halts (this step is a hard prerequisite for
everything after it, unlike the ship-minting grant, which is safely skippable) rather than
continuing in a broken state.

**Regression test:** `test/UTCLotteryHookSwap.test.ts`, `"rejects a non-owner calling
PoolManager.initialize on this hook's pool (HA2-02)"` — verified to actually fail without the fix
before being trusted. One wrinkle worth documenting: Uniswap wraps a reverting hook's error in its
own `WrappedError(...)` (`@uniswap/v4-core`'s `CustomRevert`/`Hooks.sol`), so a plain string match
against `"OwnableUnauthorizedAccount"` doesn't find it in the bubbled-up message — the test asserts
on the actual encoded error selector instead, confirmed present in the wrapped revert data. All 21
pre-existing tests in that file still passed unmodified — their `poolManager.write.initialize(...)`
calls already happened to be signed by the fixture's default account, which coincidentally is the
hook's owner (no `PRODUCTION`-style ownership handover runs in tests). Full suite: 656/656 passing.

---

### ~~HA2-03 — `Ships.setInFleet` Doesn't Check `timestampDestroyed`, Letting a Destroyed Ship Re-Enter a Fleet as an Unkillable Ghost~~

**File:** `contracts/Ships.sol`, `setInFleet` (410-424) · **Status:** Fixed 2026-09-12 (see below) ·
**Full write-up:** `pre-audit.md`, search `HA2-03`

A ship destroyed in a past game (NFT never burned, still owned by the player) could be freely
resubmitted into a fresh fleet — `setInFleet` never checked `timestampDestroyed`, and neither did
`Fleets.createFleet`/`Game.startGame` (re-confirmed directly against current source before fixing —
`createFleet`'s five checks are ownership, `inFleet`, cost version, variant match, and cost limit;
none of them touch `timestampDestroyed`). It fought normally with full HP in the new game until
anyone tried to finish or retreat it, at which point `_removeShipFromGame` reverted
`ShipDestroyed()` — permanently, since the flag is never cleared. Froze that specific ship's
resolution in the new match; confirmed this does *not* enable reward double-farming.

**Fixed 2026-09-12.** Added `if (_inFleet && ships[_id].shipData.timestampDestroyed != 0) revert
ShipDestroyed();` to `setInFleet`, guarded to only block the "add to fleet" direction — removing a
destroyed ship from a fleet (e.g. game cleanup) still works. Reused the existing `ShipDestroyed`
error (already used for the same concept elsewhere in this contract) rather than adding a new one.
`Ships.sol` only had 73 bytes of headroom before this fix (same chronic tightness as `Game.sol`) —
this fix fit with 14 bytes to spare, no bytecode-saving restructuring needed this time.

**Regression test:** `test/Ships.test.ts`, `"rejects adding a destroyed ship to a fleet (HA2-03)"`
— verified to actually fail without the fix (temporarily reverted, confirmed red, restored) before
being trusted; also confirms the "remove" direction still works post-destruction. Full suite:
657/657 passing.

**Not bundled into this pass, still open:** the related, lower-severity bug found alongside this
one — `Ships._update` never resets `ship.owner` to `address(0)` on burn (`getShip(id).owner` for a
burned ship still shows the pre-burn owner). Not independently exploitable today, but a footgun for
any future code trusting `ship.owner` over `ownerOf()`. Severity: Low/Informational — left as a
separate, still-open item rather than assumed-fixed alongside HA2-03.

**Re-confirmed 2026-09-16 (HA3 audit pass):** independently re-derived the same finding and traced
every current consumer of `.owner` for authorization — `Fleets.createFleet`'s ownership check has
no accompanying `timestampDestroyed` check, but its later `ships.setInFleet` call reverts
`ShipDestroyed` (this HA2-03 fix); `DroneYard.modifyShip` likewise has no destroyed check on its
own, but `ships.customizeShip` reverts `ShipDestroyed` too. Still not exploitable via any path
found — still open, still worth fixing as defense-in-depth, severity assessment unchanged.

---

### ~~HA2-04 — `RoguelikeMatch.enterResupplyNode` Doesn't Check for an In-Flight Combat Game~~

**File:** `contracts/RoguelikeMatch.sol`, `enterResupplyNode` (246-257); also
`RoguelikeResupply.sol`'s `resupplyRepair`/`resupplyModifyRoster` · **Status:** Fixed 2026-09-12
(see below) · **Full write-up:** `pre-audit.md`, search `HA2-04`

Unlike `retreatRun(0)` (hardened under SP-05 with an `ActiveGameInProgress` check),
`enterResupplyNode` never checked `run.activeGameId`. A player could enter a resupply node while a
combat game was still open, then win that game — `onGameEnded`'s stale-callback guard only checks
*which game*, not *which node*, so the wrong node got `defeated`/win-effects credit. Verified
against the actual seeded campaign content (`ignition/data/roguelikeStarterContent.json`): the two
most severe variants (instant full-campaign win; reopening the already-fixed SP-05 farming exploit)
weren't reachable with *that* specific content shape, but the wrong-node-credited bug fired
unconditionally, and both aggravated variants would have become live the moment a `twoWay` edge or
a leaf Resupply node was added — both content shapes this codebase's own design already treats as
normal.

**Fixed 2026-09-12.** Added `if (run.activeGameId != 0) revert ActiveGameInProgress();` to
`enterResupplyNode`, mirroring `retreatRun(0)`'s existing guard exactly (same error, same
reasoning). Also added the equivalent check to `RoguelikeResupply._requireAtResupplyNode` (the
shared chokepoint both `resupplyRepair` and `resupplyModifyRoster` call), plus a new
`ActiveGameInProgress` error declaration there (the two contracts don't share error definitions).

**Correction made while implementing, worth recording:** the original finding described the
`RoguelikeResupply` gap as an equally live, independent exploit path. Tracing it more carefully
while fixing: `run.currentNodeId` can only ever change via `RoguelikeMatch._commitToNode`, called
from exactly two places — `enterCombatNode` (which always moves `currentNodeId` to the *combat*
node in the same call that sets `activeGameId`) and `enterResupplyNode`. With `enterResupplyNode`
now blocked while `activeGameId != 0`, there is no longer any reachable state where
`currentNodeId` points at a Resupply node *and* `activeGameId != 0` simultaneously — so
`RoguelikeResupply`'s check, while correct and cheap to keep, is genuinely unreachable
defense-in-depth given the primary fix, not a second independently-exploitable hole. Kept it
anyway (matches this repo's own defense-in-depth philosophy, and costs nothing), but didn't write
a test for it — there's no way to reach that state through the public API to test against, so a
test would only be exercising the check via direct internal-state manipulation, not a real
scenario.

Both files had ample bytecode headroom (2.4 KB / 16.4 KB respectively) — no size pressure.

**Regression test:** `test/RoguelikeMatch.test.ts`, `"reverts enterResupplyNode while a combat
match is still active at the current node"` — verified to actually fail without the fix
(temporarily reverted, confirmed red, restored) before being trusted; also asserts
`run.currentNodeId` is unchanged (still the combat node) after the reverted attempt. Full suite:
658/658 passing.

---

### HA5-01 — `Tournament.claimForfeitWin`/`resolveStalledMatch` Can Award a Walkover (or Let a Third
Party Sabotage) a Match That's Genuinely In Progress, Not Actually Abandoned

**File:** `contracts/Tournament.sol:561-577` (`claimForfeitWin`), `:588-603` (`resolveStalledMatch`);
root cause interacts with `assignMatchGame` (`:452-481`) · **Found 2026-09-29.**

Both functions gate purely on `m.gameId == 0` (nothing has been assigned to this *tournament
match* yet) plus `block.timestamp > m.readyAt + t.config.matchTimeout` (`matchTimeout` is
creator-configurable but bounded only to `[MIN_MATCH_TIMEOUT, MAX_MATCH_TIMEOUT]` =
`[1 hour, 1 week]`). Neither checks whether a real game between the two players actually exists,
is in progress, or has already concluded — there is no on-chain way to tell, because
`assignMatchGame` is (by this codebase's own documented, tested workflow — see `pre-audit.md`
T-02's note that "the real, working usage pattern in this codebase is 'play the game first, then
assign + record it after the fact'") normally called only *after* a match finishes, not when it
starts. So `m.gameId` reads `0` for the entire real-time duration of an honestly-played match, not
just for an opponent who genuinely never showed up — `assignMatchGame` requires only
`gameMetadata.startedAt > m.readyAt`, not that the game has ended, so nothing stops it from being
called the instant a game starts, but nothing requires that either, and the documented/tested
pattern doesn't do it.

**Concrete scenario:** Alice and Bob are paired (`readyAt = T0`) with `matchTimeout` left at the
protocol-enforced minimum, 3600s — an entirely normal creator choice, not an edge case. They pair
via `Lobbies`, build fleets, and play a real match that takes over an hour of wall-clock time (easy
for any human-paced, turn-based match with a generous `turnTime`). Bob wins fairly at T0+55min.
Nobody has called `assignMatchGame` yet — nothing requires it to happen immediately. At T0+61min,
Alice (the loser) calls `claimForfeitWin`: `m.gameId` is still `0`, the timeout has elapsed, so it
succeeds — Alice is recorded as the winner. `m.resolved = true` then permanently blocks
`assignMatchGame` (`GameAlreadyAssigned`... `MatchAlreadyResolved`) forever, so Bob has no way to
ever correct the record. Alice advances in the bracket and can go on to claim real ETH prize money
she didn't earn.

`resolveStalledMatch` is worse in one respect: it's fully **permissionless** (callable by anyone,
not just the two players), so a zero-stake third party can sabotage an ongoing or freshly-finished
legitimate match purely to disrupt the tournament — satisfying this project's own "assume hostile
outside actors" rule directly, no profit motive required, only the cost of one transaction once the
timeout window (as low as 1 hour) has elapsed.

Confirmed via `test/Tournament.test.ts`: every existing `claimForfeitWin`/`resolveStalledMatch` test
models "the opponent never shows up at all" (no lobby, no game, ever) — there is no test covering "a
real game exists/concluded but wasn't assigned yet," which is exactly the gap.

**Fix direction (a design decision, not a one-line patch):**
- Don't award a walkover on ambiguous silence — default to voiding/refunding the match (or requiring
  a bye-style resolution) when the timeout elapses with no assigned game, removing the incentive to
  race a false claim against an opponent who's honestly mid-match; and/or
- Add an explicit "engagement" signal — a permissionless function either player (or anyone) can call,
  validated against `Lobbies`/`Game` showing a real, correctly-paired, in-progress game started after
  `readyAt` — that blocks or resets the forfeit/stall timeout once real activity is detected, so the
  timeout only ever fires for a genuinely absent opponent. Raising `MIN_MATCH_TIMEOUT` alone is only
  a partial mitigation — a real match can still exceed any fixed floor.

---

## Medium

### M-04 — `ShipAttributes` Attribute Version Arrays Can Be Out-of-Bounds Indexed

**File:** `contracts/ShipAttributes.sol`, lines 120-155; `contracts/GenerateNewShip.sol`, lines
88-109 · **Full history:** `pre-audit.md`, search `M-04`

`calculateShipAttributes` indexes `attributesVersions[version].guns[...]` etc. without a length
check. If a version is deployed with only 4 gun entries (today's default) and a ship has an
equipment enum value 4-7 (the `future*` placeholders), the call panics with an out-of-bounds
access. Accepted as-is (2026-07-16) — no fix planned, but genuinely not fixed, so tracked here
rather than silently dropped.

---

### ~~HA3-02 — `damageReduction` Above 100% Makes a Ship Permanently Unshootable via `Shoot`/`FlakArray`/`DroneSwarm` (Checked-Arithmetic Revert, Not a Damage Floor)~~

**File:** `contracts/ShipAttributes.sol:211-224` (`_calculateDamageReduction`, no cap on the summed
`armors[x].damageReduction + shields[y].damageReduction`); consumed at `contracts/Game.sol:824-828`,
independently re-implemented the identical way at `contracts/FlakArrayResolver.sol:104-108` and
`contracts/DroneSwarmResolver.sol:86-89`

**Verified directly, not just trusted:** `_calculateDamageReduction` sums two `uint8` values with
no cap at 100 (only Solidity's default 255 overflow ceiling applies, e.g. 60+60=120 fits fine).
The damage formula everywhere it's consumed is
`uint16 reducedDamage = baseDamage - ((uint16(baseDamage) * reduction) / 100);` — for
`baseDamage=60, reduction=120`: `(60*120)/100 = 72`, then `60 - 72` underflows a `uint16` under
Solidity 0.8's default checked arithmetic and **reverts**, every time, for every `Shoot`,
`FlakArray`, or `DroneSwarm` action against that ship. Any configured armor+shield pair whose
`damageReduction` values sum above 100 turns "very resistant" into "permanently immune to three of
the game's damage sources" (Ram/EMP/reactor-timer removal still work, so not a full soft-lock) —
silently, via a revert, not a graceful floor. Owner-config-reachable only (not a zero-privilege
player exploit), but this project's own I-02 finding already treats a malicious/compromised owner
key as a live threat, and a careless (non-malicious) admin content update could trigger this by
accident just as easily.

**Fix:** clamp at all three consuming sites — `reduction > 100 ? 0 : baseDamage - (...)` — or cap
the sum itself inside `_calculateDamageReduction`, so 100% is a real floor rather than an
unenforced convention three separate call sites all assume holds.

**Status: Fixed 2026-09-16.** Went with capping the value at its single source of truth rather
than patching three consuming call sites — all three (`Game.sol`'s `Shoot` handler,
`FlakArrayResolver`, `DroneSwarmResolver`) read `damageReduction` from the already-calculated,
*stored* `Attributes` (via `game.getShipAttributes`/`targetAttributes`), never recomputing it
themselves, so capping once where it's written covers all three automatically — confirmed this by
re-reading all three consumers directly before implementing.

**Found and fixed a second, related gap while implementing, not just the one `_calculateDamageReduction`
originally flagged:** capping only inside `_calculateDamageReduction` would *not* have been
sufficient — `calculateShipAttributes` (`ShipAttributes.sol`) applies a rank-multiplier bonus
(0-50%, scaling with `shipsDestroyed`) to `damageReduction` *after* calling that helper, so even a
value correctly capped at 100 going in could come back out above 100 (e.g. 100 + 50% rank bonus =
150). The real fix clamps `attributes.damageReduction` to 100 as the very last step in
`calculateShipAttributes`, after the rank bonus is added — the true final value, not an
intermediate one.

Bytecode: `ShipAttributes.sol` +26 bytes (12.801/24.576 KiB deployed) — negligible, ample headroom.

Two new tests in `test/Ships.test.ts` (`"ShipAttributes Update Functions"` describe block), calling
`calculateShipAttributes` directly with a synthetic `Ship` (no game/mint setup needed, since it's a
plain view function taking a `Ship memory` argument): `"caps damageReduction at 100 when
armor+shield alone sum above it"` (70% armor + 60% shield = 130 → 100) and `"caps damageReduction
at 100 even when a sub-100 base is pushed over by the rank-multiplier bonus"` (70% base + a
max-rank 50% bonus = 105 → 100) — the second test specifically proves the fix is at the right
location, not just the naively-expected one. Verified genuine: temporarily neutralized the cap
(`if (false && ...)`), confirmed both new tests went red, then restored the real fix from a backup
and reconfirmed byte-identical. Full suite re-run afterward: exit code 0, no regressions
(`PRODUCTION` confirmed `false` beforehand).

---

### ~~HA2-05 — `Lobbies`: `reservedJoiner` Is Never Cleared Outside `acceptGame`/`rejectGame`~~

**File:** `contracts/Lobbies.sol` — `joinLobby`, `leaveLobby` (all 3 branches), `timeoutJoiner`,
`quitWithPenalty` · **Status:** Fixed 2026-09-12 (see below) · **Full write-up:** `pre-audit.md`,
search `HA2-05`

A reserved player could join via plain `joinLobby` (not just `acceptGame`) without the reservation
ever clearing. If they then left/timed out, the lobby reopened but stayed permanently locked to
them — nobody else could join, at zero further cost to them. **Worse:** if the *creator* left
after the reserved player joined, that player got promoted to creator while still being
`reservedJoiner` — since `joinLobby` also blocks `creator == msg.sender`, the lobby became
permanently unjoinable by anyone.

**Fixed 2026-09-12.** Added `lobby.players.reservedJoiner = address(0);` (harmless no-op when
already unset) to every path identified: `joinLobby` (right after the reservation is consumed,
mirroring `acceptGame`'s existing clear), and all three ways a lobby resets back to genuinely
public "open" — `leaveLobby`'s creator-leaves-with-joiner-promoted branch, its
creator-leaves-abandoned branch, its joiner-leaves branch, `timeoutJoiner`, and
`quitWithPenalty`. Six new clear sites total, alongside the two pre-existing ones in
`acceptGame`/`rejectGame`. `Lobbies.sol` had ample headroom (14.8/24 KiB) — no size pressure.

**Regression tests:** `test/Lobbies.test.ts`'s `"Game Reservation"` block — two new tests, both
confirmed to actually fail without the fix (temporarily disabled all six new clear sites at once,
confirmed both went red, restored) before being trusted: one reproduces the base scenario (reserved
player joins then leaves, then a third party can join), one reproduces the worse variant (creator
leaves, reserved player is promoted to creator, then a third party can still join — proving the
lobby isn't permanently bricked). Notably, this feature had **zero** prior test coverage for the
plain-`joinLobby`-then-leave path at all (every existing reservation test used `acceptGame`, which
was already correct) — confirmed by grep before writing these. Full suite: 660/660 passing.

---

### ~~HA2-06 — `UTCLotteryHook` Entry Weight Is Gameable via a Flash-Loan Round-Trip~~

**File:** `contracts/UTCLotteryHook.sol` — `_recordSell`, `resolveDraw` · **Status:** Addressed
2026-09-12 (see below) · **Full write-up:** `pre-audit.md`, search `HA2-06`

Weight = a single sell's realized ETH proceeds, no retention requirement. An attacker could
flash-borrow UTC, sell it (registering a large weight to any address via `hookData`), then buy it
back to repay the loan — paying only round-trip slippage/fee rather than the real economic cost of
holding that capital.

**Design discussion, not a pure security fix.** No funds were ever at risk here (both legs are real
swaps against the real pool, paying real fees) — the actual question was fairness of the periodic
prize drawing, weighed directly against the project's stated priority that on-chain activity/volume
is a good thing in itself. Conclusion reached: a flash-loan round-trip is bounded-cost, fee-generating
activity; the real risk was a single well-funded (flash-loaned or genuine) address dominating a
draw's odds when few others participate, not the flash-loan technique specifically.

**Fixed 2026-09-12, two additions:**
1. **`maxWeightPerEntryWei`** (default `1 ether`) caps the *weight* a single sell can credit,
   independent of real (uncapped) proceeds — added to `_recordSell`. The qualifying-threshold check
   still uses real, uncapped proceeds; only the recorded weight is clamped.
2. **`maxWinProbabilityDenominator`** (default `10`) floors `resolveDraw`'s random-pick denominator
   at `maxWinProbabilityDenominator * maxWeightPerEntryWei`. Combined with the cap above, this
   guarantees no single address can ever exceed a `1/maxWinProbabilityDenominator` share of a draw
   — not just a bounded *absolute* weight, which alone would still let a whale claim close to 100%
   of a thinly-participated draw. A random pick landing beyond the real participants' cumulative
   weight now means **nobody wins that draw** (`DrawResolvedNoWinner(drawId)`, new event) — no
   special rollover logic needed, the next qualifying sell just starts accumulating toward the next
   draw as usual.

Both are owner-configurable, same pattern as the existing thresholds, and both defaults are
explicitly flagged (matching every other threshold on this contract) as sensible-but-unvalidated
starting points, not final tuned values.

**Regression tests**, `test/UTCLotteryHookSwap.test.ts`:
- Deterministic: defaults, owner-only setters, and a direct test that a sell far exceeding the cap
  is clamped to exactly `maxWeightPerEntryWei` in `weightInDraw`/`totalWeightInDraw`.
- Probabilistic: a test that deliberately floors the denominator far above real weight and asserts
  `DrawResolvedNoWinner` fires (cross-checked against ship-count non-mint) within two independent
  attempts — each attempt individually ~99.8%+ likely to land in the no-winner zone (bounded by
  RandomManager's `uint64` randomness range, not by how extreme the parameters get), so the chance
  *both* attempts land on a real winner is ~4e-6. A small, disclosed, standard residual flake
  probability for a genuinely random on-chain outcome — run 4 times during development with no
  failures.
- Both the cap and the no-winner mechanism confirmed to actually fail without their respective
  code (temporarily reverted, confirmed red, restored) before being trusted.
- Fixing this also required updating three pre-existing tests whose fixed sell amounts predated the
  cap (`runFullDrawCycle`'s shared helper, and the `minTotalWeightWei` gating test) to explicitly
  neutralize or account for the new cap, since they test unrelated mechanics (prize-minting,
  volume-gating) and shouldn't flake on the new probability-cap behavior.

Full suite: 664/664 passing.

---

### ~~HA2-07 — `Tournament.buildBracket()`'s Shuffle Inherits `RandomManager`'s Known "Patient Caller" Risk, Now Exposed to Real Prize Money~~

**File:** `contracts/Tournament.sol`, `buildBracket`/`_shuffleSeeds` (340-354, 588-606) · **Full
write-up:** `pre-audit.md`, search `HA2-07`

Not a new bug — a re-evaluation of an already-accepted `RandomManager` risk (a patient caller can
simulate `block.prevrandao`-derived outcomes off-chain for the current epoch and choose whether to
submit) in a context the original acceptance never considered: Tournament prize pools (entry fees
× N + uncapped sponsor contributions), versus the original reasoning's "99.9% of ships worth under
$1." **Action:** project owner should explicitly re-confirm whether the existing acceptance still
holds now that real prize money is gated by it — not a code change by default.

**Status: Fixed 2026-09-12 (bounded, not eliminated — see below).** Traced the exact exploit
window before fixing: `start()` freezes `t.registrants` and commits `RandomManager`'s
`prevRandaoAtCommit` in the same transaction, so the entire shuffle input is public before any
waiting begins. `TournamentState.Starting` had no timeout and no path back to
`Registration`/`Cancelled`, so a patient outside observer — not necessarily a registrant — could
poll the public `block.prevrandao` every ~12s (one Base RANDAO epoch), simulate `_shuffleSeeds`
off-chain for free, and simply decline to call `buildBracket()` until a favorable epoch appeared,
with no time limit forcing their hand.

Added a bounded reveal window instead of an unbounded one: `SHUFFLE_REVEAL_WINDOW = 10 minutes`
(new constant). `start()` now also sets `t.shuffleDeadline = block.timestamp +
SHUFFLE_REVEAL_WINDOW`. `buildBracket()` reverts `ShuffleWindowExpired()` once that deadline
passes instead of still honoring a stale request. A new permissionless function,
`rerollBracketShuffle(tournamentId)`, becomes callable by anyone (same "no single party staying
offline should block progress" reasoning as `buildBracket`/`assignMatchGame`/`recordResult`) once
the deadline has passed — it requests a fresh `RandomManager` id, overwrites
`t.randomRequestId`, and resets the deadline, orphaning whatever epochs were being ground through
against the old request (`buildBracket` calls `fulfillRandomRequest` on `t.randomRequestId`, which
now points at the new, un-preview-able request). Reroll itself reverts `ShuffleWindowNotExpired()`
before the deadline, so it can't be spammed to grief progress or used to dodge an about-to-land
honest `buildBracket()` call.

**This bounds the exploit, it does not eliminate the underlying preview-and-decline ability** —
that requires either a real multi-party committed-secret scheme or an external VRF (see the
"option 3" discussion below, not yet decided). What it does change: an attacker's free look-ahead
against any single request is capped at ~50 epochs (10 minutes) instead of unlimited, and past
that window any bystander with zero stake in the outcome (the tournament creator wanting their
event to start, an impatient registrant, a keeper) can force a reroll that discards the attacker's
accumulated preview data. Since `buildBracket()` has always been safe to call the instant the
window opens (no reason for an honest party to wait), the realistic exposure is now bounded by how
long it takes *some* honest actor to notice and call `buildBracket()` or `rerollBracketShuffle` —
not by how long an attacker is willing to wait.

`Tournament.sol` has ample bytecode headroom (17.839 → 17.839 KiB deployed size-report baseline,
18.332 KiB deployed after this fix, vs. the 24.576 KiB limit), so no restructuring was needed.

New tests in `test/Tournament.test.ts` (`"Bracket shuffle expiry (HA2-07)"` describe block):
- `"rejects buildBracket once the reveal window has expired"` — starts a tournament, lets
  `SHUFFLE_REVEAL_WINDOW` lapse with `evm_increaseTime`, asserts `buildBracket` reverts
  `ShuffleWindowExpired`.
- `"lets anyone reroll an expired shuffle request and build normally afterward"` — asserts
  `rerollBracketShuffle` reverts `ShuffleWindowNotExpired` before expiry, succeeds when called by
  a non-creator (alice) after expiry, and confirms `buildBracket` then succeeds immediately
  against the fresh request.

Both new tests were verified to fail (red) when the fix's two `if` checks were neutralized via
`if (false && ...)`, then the real fix was restored from a backup and reconfirmed clean. Full
suite re-run afterward: exit code 0, no regressions (`PRODUCTION` confirmed `false` beforehand).

**Deferred follow-up (not yet decided): a genuine cryptographic fix, not just a bound.** Discussed
three options for actually removing the preview-and-decline ability (rather than just bounding
how long any one request can be ground against):

1. **External VRF (e.g. Chainlink VRF).** Removes caller-timing power entirely — randomness
   arrives via an oracle callback, not by whoever chooses to poll a public value. The only option
   that eliminates the attack rather than bounding it; adds a real external dependency this
   project doesn't otherwise have.
2. **The reroll/expiry bound above.** Cheap, already shipped. Does not remove the preview
   ability, only caps how many free look-aheads a single request offers before it's invalidated.
3. **Real multi-party commit-reveal, Tournament-specific.** Each registrant submits
   `keccak256(secret)` at registration; after `start()`, a short reveal window requires each
   registrant to submit their `secret`; the shuffle entropy becomes
   `keccak256(prevrandao, requestId, XOR-of-all-revealed-secrets)` (or similar) instead of
   `prevrandao` alone. No single outside observer — including the last revealer — can preview the
   full result before all secrets are in, since no one but each registrant knows their own secret
   pre-reveal. Residual: classic **last-revealer bias** (whoever reveals last can choose to
   reveal-or-withhold based on what the combined result would be) — mitigated by a hard reveal
   deadline with a fixed, unappealing consequence for non-reveal (e.g. forfeiting seed placement
   entirely, seeded last, or excluded from the bracket), so a withholding registrant only ever
   gets to choose between "reveal" and a bad default, not between two outcomes they'd prefer.
   Real added complexity: a new registration-time input, a new per-tournament reveal step/
   deadline, and non-reveal handling — and it's Tournament-specific, since `RandomManager`'s other
   consumers (ship construction) don't want this friction for low-stakes randomness.

**User decision (2026-09-12): defer option 3 for later.** The bounded fix above ships now;
building the real per-tournament secret-reveal scheme is explicitly parked, not rejected — revisit
if/when tournament prize pools are large enough, or frequent enough, to justify the added
registration/reveal UX cost. No further design work has been done beyond the sketch above.

---

### ~~HA5-02 — `UTCLotteryHook.resolveDraw`'s Unbounded `drawParticipants` Array Can Be Sybil-Inflated
to Make a Draw Permanently Gas-Unresolvable~~

**Status: Fixed 2026-10-15** (see `docs/audit-3.md`, Carried forward). Each weight increase now appends one packed ticket segment (cumulative end and owner), and `resolveDraw` finds the winner by binary search. Resolution gas no longer grows with participant count: about 591k gas at 300 participants, the same as at 3.

**File:** `contracts/UTCLotteryHook.sol:103` (`drawParticipants` — no size cap), `:304-346`
(`_recordSell`, pushes any new qualifying seller with no per-draw participant ceiling), `:375-421`
(`resolveDraw`'s single-transaction loop over the full participant array) · **Found 2026-09-29.**

Any address whose UTC→ETH sell clears `minEntryThresholdWei` (default 0.01 ETH, owner-configurable)
is pushed into `drawParticipants[currentDrawId]` — once per distinct address — with no maximum on
how many distinct addresses one draw can accumulate. A draw only becomes eligible to resolve once
`drawInterval` (default 24h) has elapsed and thresholds are met — until then, the accumulation
window stays open regardless of participant count. `resolveDraw` then iterates the *entire*
participant array in one transaction to pick a winner by cumulative weight, with no
batching/pagination.

An attacker can cheaply add many Sybil participants during the (up to 24-hour) accumulation window:
each entry only requires one qualifying sell, and the capital is recyclable (buy UTC back, sell
again from a fresh address — costing only AMM fees + gas per round trip, not the notional amount).
Pushed far enough (on the order of a few thousand participants, depending on per-iteration gas),
`resolveDraw`'s loop exceeds the block gas limit and can never succeed for that specific `_drawId` —
permanently denying every honest participant in that draw their shot at the prize. A queued curated
`PrizeTemplate`, if any, simply stays queued for a future draw rather than being lost, but that
specific draw's outcome is dead forever. Matches this project's own "assume hostile, zero/low-profit
-seeking actors" rule directly — this is pure disruption of other participants' draw, not fund theft,
and there's no cap or escape hatch anywhere in the current design.

**Fix direction:** cap `drawParticipants[drawId].length` (reject or ignore additions past some
maximum), and/or make `resolveDraw` resumable/batchable (e.g. a running cumulative-weight
accumulator updated incrementally as participants are added, rather than recomputed from scratch
over the full array at resolution time), so resolution cost no longer scales with an
attacker-inflatable count.

---

## Low

### ~~HA4-04 — `Tournament.addSponsorPrize` Lets Any Address Claim the Sponsor Slot for Free, Blocking the Real Sponsor~~

**File:** `contracts/Tournament.sol:286-302` · **Found 2026-09-28.**

```solidity
function addSponsorPrize(uint256 tournamentId) external payable {
    ...
    if (t.sponsor == address(0)) {
        t.sponsor = msg.sender;
    } else if (t.sponsor != msg.sender) {
        revert SponsorAlreadySet();
    }
    t.sponsorAmount += msg.value;
    ...
}
```
No `msg.value > 0` requirement before `t.sponsor` is claimed — contrast with `createTournament`,
which only sets `t.sponsor` when `msg.value > 0`. Any address can call `addSponsorPrize` with 0 ETH
the instant a tournament is created, permanently claiming the single sponsor slot; `SponsorAlreadySet`
then blocks every other address — including the tournament's intended real backer — from
contributing sponsor funds via this function. No entry fees or prize funds already in the pool are
at risk; this only blocks *additional* sponsor top-ups from anyone but the squatter.

**Fix:** require `msg.value > 0` before assigning `t.sponsor = msg.sender`, matching
`createTournament`'s existing logic for the same field.

**Status: Fixed 2026-09-29.** Added a new `NoSponsorContribution` error and require
`msg.value > 0` on the first claim of `t.sponsor`, exactly mirroring `createTournament`'s existing
gate on the same field:

```solidity
if (t.sponsor == address(0)) {
    if (msg.value == 0) revert NoSponsorContribution();
    t.sponsor = msg.sender;
} else if (t.sponsor != msg.sender) {
    revert SponsorAlreadySet();
}
```

A real (non-zero) contribution from anyone else still claims the slot normally once it's open, and
`SponsorAlreadySet` still fires correctly for a zero-value call from a non-owner once a real sponsor
is set. `Tournament.sol` compiles at 16.676/24.576 KiB deployed — ample headroom, negligible size
cost. Regression test added to `test/Tournament.test.ts` ("rejects claiming the sponsor slot with a
zero-value call (HA4-04)"): a zero-value call reverts `NoSponsorContribution` while the slot is
still open, a real contribution then claims it, and a subsequent zero-value call from someone else
correctly falls through to `SponsorAlreadySet` instead. Verified genuine: temporarily reverted the
`msg.value == 0` check in place, reran the test (0 passing, 1 failing, confirming it fails without
the fix), then restored the real fix from a backup copy and confirmed the restored file was
byte-identical to the backup via `diff`. Full local run (`Tournament.test.ts` +
`Fleets.test.ts` + `DroneStorefront.test.ts`): 44/44 passing.

---

### ~~HA4-05 — Roguelike Roster Reservation Has No Duplicate-ShipId Check (Self-Limiting Dead End, Not Exploitable Against Others)~~

**File:** `contracts/RoguelikeMatch.sol:162-190` (`startRun`), `:393-408` (`_reserveRoster`);
`contracts/RoguelikeResupply.sol:163-215` (`resupplyModifyRoster`); root cause in
`contracts/Fleets.sol:87-165` (`createFleet` validates duplicate *positions* but never duplicate
*shipIds* — each id's `inFleet` flag is read fresh per index in the validation loop, but not flipped
until a separate, later loop, so two occurrences of the same id both pass validation) ·
**Found 2026-09-28.**

A caller-supplied `_shipIds` array with a repeated id can be accepted into
`run.rosterShipIds` via the Roguelike "reservation" fleet path (`mapId=0`, never passed through
`Game.startGame`). **Does not escalate:** any real combat entry (`enterCombatNode` →
`Game.startGame` → `calculateShipAttributes`) always reverts on the second occurrence of the
duplicate id, via that function's pre-existing snapshot-once guard (`if (attributes.version != 0)
revert`) — the same general `Game.sol` guard that protects the ordinary PvP path too. The affected
run becomes permanently unable to enter combat, but `retreatRun(0)` still works regardless and
cleanly abandons it — no funds/NFTs at risk, no other player affected. A confusing UX dead end for
the caller only, not a security vulnerability against a third party.

**Fix direction:** validate shipId uniqueness up front in `startRun`/`resupplyModifyRoster` with a
clear revert, rather than relying on an incidental revert three calls deep the first time the
player tries to actually fight. Optionally generalize `Fleets._validateStartingPositions`'s
existing duplicate-*position* bitset check to also cover duplicate shipIds, as defense-in-depth for
the shared `createFleet` entry point itself.

**Status: Fixed 2026-09-29.** Fixed at the shared root cause, `Fleets.createFleet` itself, rather
than in each individual caller — this covers every current caller (Lobbies, SinglePlayerMatch,
RoguelikeMatch, RoguelikeResupply) and any future one uniformly, not just the Roguelike path this
finding traced. Added a new `DuplicateShipId` error and an O(n²) in-memory duplicate check over
`_shipIds`, run once up front before the more expensive per-ship validation loop:

```solidity
for (uint i = 0; i < _shipIds.length; i++) {
    for (uint j = i + 1; j < _shipIds.length; j++) {
        if (_shipIds[i] == _shipIds[j]) revert DuplicateShipId();
    }
}
```

O(n²) is acceptable at this game's realistic fleet sizes (topping out around a dozen ships).
`Fleets.sol` compiles at 7.652/24.576 KiB deployed — ample headroom. Regression test added to
`test/Fleets.test.ts` ("rejects a duplicate shipId across two slots in the same fleet (HA4-05)"):
a `createFleet` call with the same shipId in two starting-position slots reverts `DuplicateShipId`.
Verified genuine: temporarily removed the duplicate-check loop in place, reran the test (0 passing,
1 failing, confirming it fails without the fix), then restored the real fix from a backup copy and
confirmed the restored file was byte-identical to the backup via `diff`.

---

### HA5-03 — `ShipAttributes._calculateMovement` Casts `baseSpeed`/`engineSpeeds` (`uint8`) to `int8`
With No Range Check, Silently Wrapping Negative

**File:** `contracts/ShipAttributes.sol:245,248` · **Found 2026-09-29.**

```solidity
int8 baseMovement = int8(variantData.baseSpeed);                    // line 245
...
baseMovement += int8(variantData.engineSpeeds[_ship.traits.speed]); // line 248
```

`VariantAttributeData.baseSpeed` and `.engineSpeeds[]` are declared `uint8` in `Types.sol` (full
range 0-255) and are owner-supplied verbatim via `setVariantAttributes`, with no upper-bound
validation in `_validateAttributes` (which only checks array lengths and rank-threshold ordering).
A same-size `uint8`→`int8` explicit cast in Solidity is a bit-reinterpretation, not a checked
conversion — it never reverts, it just silently produces a negative value for any input ≥ 128
(e.g. `200` → `-56`). This is the identical mechanism already found and fixed in
`EMPResolver.sol`/`ElectricStormResolver.sol` under `HA3-06`, just in a different file/field that
fix never touched.

**Failure scenario:** the owner (or a careless content-pipeline script) publishes a new attributes
version with `baseSpeed` or an `engineSpeeds[tier]` entry ≥ 128 — plausible if someone treats the
field as "0-255, bigger = faster" without knowing about the internal `int8` cast. The result isn't
a loud revert but a silently wrong, usually near-zero, `movement` for every ship of that
variant/tier (the function's own floor clamps a negative result to 0), degrading gameplay for an
entire faction until someone notices and republishes a corrected version. Not attacker-reachable —
`setVariantAttributes` is `onlyOwner` — but this project's own precedent (`HA3-02`, `HA3-06`) treats
a careless, non-malicious admin content update as worth closing, not just a malicious owner.

**Fix:** clamp `baseSpeed`/each `engineSpeeds[i]` to `int8`'s max (127), the same way `HA3-06`'s fix
did for `strength` — either in `_validateAttributes` (reject > 127 outright, consistent with that
function's existing "reject a malformed table before it goes live" role) or at the two cast sites.

---

### HA5-04 — Several More Void-Returning External Calls Have No Zero-Address/Code-Length Check on
Their Target (Same Class as `HA4-06`, Different Call Sites)

**Files:**
- `contracts/ShipPurchaser.sol:38-40` (constructor sets `ships`) → consumed at `:76`
  (`ships.createShips(...)`, void)
- `contracts/DroneYard.sol:36-46` (constructor sets `ships`) → consumed at `:239`
  (`ships.customizeShip(...)`, void)
- `contracts/FreeShipClaim.sol:39-41` (constructor sets `ships`) → consumed at `:94`
  (`ships.createShips(...)`, void)
- `contracts/Ships.sol:615-638` (`setConfig`, sets `universalCredits`) → consumed at `:781`
  (`universalCredits.mint(...)`, void, inside `shipBreaker`)

**Found 2026-09-29.**

This is the exact mechanism already identified and fixed once in this codebase under `HA4-06`
(`DroneStorefront.turnInCores` → `droneEnergyCores.burnFrom`), just left unfixed at these four other
call sites: `IShips.createShips`/`customizeShip` and `IUniversalCredits.mint` are all declared with
no return value. A call to a void-returning external function against an address with no deployed
code (a misconfigured/zero/wrong-network address passed to a constructor, or a future re-wiring)
succeeds silently rather than reverting — there's no return data for the ABI decoder to fail on.

**Failure scenario (per site, if the relevant address were ever misconfigured):**
- `ShipPurchaser.purchaseWithUTC`: `universalCredits.transferFrom` succeeds (real, correctly-wired
  token) and pulls the buyer's real UTC; the subsequent `ships.createShips` silently no-ops — buyer
  pays real UTC and receives nothing, with no revert to warn them.
- `DroneYard.modifyShip`: same shape — the UTC fee is really collected via `transferFrom`, then
  `ships.customizeShip` silently no-ops, so the paid-for customization never applies.
- `FreeShipClaim.claimFreeShips`: `lastClaimTimestamp` is already recorded (correct CEI ordering,
  per the existing `SP-01` fix) before the void `ships.createShips` call; a silent no-op here burns
  the player's entire 28-day cooldown window for zero ships, with no revert to signal the problem.
- `Ships.shipBreaker` → `universalCredits.mint`: the most severe instance — the ship(s) are already
  irreversibly `_burn`'d (state committed earlier in the same loop) before the trailing
  `universalCredits.mint(msg.sender, totalReward)` call; if `universalCredits` were ever
  misconfigured, the player's ships are gone permanently with silently zero compensation and no
  revert.

None of these are reachable today — every constructor is correctly wired per
`ignition/modules/DeployAndConfig.ts`, and none of the four addresses has a live setter that could
drift post-deploy except `Ships.setConfig`, which is `onlyOwner`. Same "latent footgun, not a live
exploit" framing `HA4-06` used before it was fixed.

**Fix:** apply the same pattern `DroneStorefront._setDroneEnergyCoresAddress` already established
for `HA4-06` — reject `address(0)` and `.code.length == 0` — at each of these four assignment
points (the three constructors, and inside `Ships.setConfig` for at least `universalCredits`, the
one actually consumed via a void call).

---

### L-03 — `Ships.syncShipCosts` Is Fully Permissionless and Can Corrupt Storage for ID 0

**File:** `contracts/Ships.sol`, lines 354-358 · **Full history:** `pre-audit.md`, search `L-03`

Calling on ship ID 0 silently writes `.costsVersion`/`.cost` into the always-empty `ships[0]` slot.
Traced fully: every on-chain existence check (`ship.id == 0`, `ship.owner != _owner`,
`ownerOf(0)`) still correctly identifies "doesn't exist" and reverts before anything could act on
the corrupted fields — inert on-chain. The one real residual risk is off-chain: a naive indexer/
bot that reads `getShip(0)` without checking `.id == 0` first could display/act on meaningless
data, and looping `syncShipCosts` from index 0 instead of 1 triggers this by accident, no attacker
needed. Accepted as-is — not worth an on-chain guard for a purely off-chain-consumer hygiene
concern.

---

## Informational / Centralization

### ~~I-01 — Multiple Debug Functions Left in Production `Game` Contract~~

**File:** `contracts/Game.sol`, lines 1204-1252 · **Full history:** `pre-audit.md`, search `I-01`

`debugDestroyShip`, `debugSetHullPointsToZero`, `debugSetShipPosition` — all `external onlyOwner`.
Blast radius is limited by `onlyOwner`, but their presence in production is a centralization signal
and may confuse auditors/players about contract finality. Same three functions as I-02's
"debug-named" category below.

**Status: Fixed 2026-09-16.** Fully eliminated, not shrunk or narrowed — zero bytecode and zero
on-chain capability remain for any of the three. This was explicitly the bar: an earlier draft
plan considered keeping `debugDestroyShip` as a "narrower" exception (it's a thin wrapper around
the already-existing `_removeShipFromGame`), but the direction was full removal, no exceptions.

All three were genuinely load-bearing for the test suite (79 call sites across
`test/Game.test.ts`, `test/SinglePlayerMatch.test.ts`, `test/RoguelikeMatch.test.ts`), so removal
required replacing what they did, not just deleting them. New test-only infrastructure:
`test/helpers/gameStorage.ts` writes directly to the Hardhat test blockchain's EVM storage slots
(via `hardhat-network-helpers`' `setStorageAt`/`getStorageAt` — an official Hardhat testing
primitive, the same class of technique as Foundry's `vm.store`) to reproduce the same test setup
with **no contract-side code at all** — nothing here has any on-chain footprint. Every slot number
was cross-checked against the Solidity compiler's own authoritative `storageLayout` output (added
to `hardhat.config.ts`, dev-only) rather than trusted from hand-derivation alone — that check
caught a real bug before any helper was written: `games` is storage slot 10, not the hand-derived
9, because `Game is Ownable` and `Ownable`'s own `_owner` occupies slot 0, shifting every one of
`Game.sol`'s own declared variables up by one.

The three debug functions were not equally hard to replace:
- `setShipPosition`/`setShipHullPointsToZero` are direct storage-poke replacements (the latter
  required a faithful reimplementation of OpenZeppelin `EnumerableSet`'s exact `add`/`remove`
  algorithm, since `_setShipHPToZero` moves a ship between two `EnumerableSet`s).
- `debugDestroyShip` was NOT hand-replicated — its real effect (`_removeShipFromGame`) is too
  cross-cutting (3 `EnumerableSet`s, a dynamic array push, cross-contract calls into `Fleets`/
  `Ships`, a conditional orchestrator callback) to safely reproduce by hand without risking a
  replica that silently diverges from reality. Instead, `primeShipForRealDestruction` sets a
  ship's HP to 0 and its reactor-critical-timer to 2 (both packed into the same storage word, one
  write) and adds it to `shipsWithZeroHP`; the caller then drives one real round to completion,
  which triggers `Game.sol`'s own existing reactor-critical-timer logic to call the real
  `_removeShipFromGame` — fully correct cross-contract cleanup through the actual production code
  path, not a hand-rolled stand-in.

Correctness was proven twice over: (1) `test/GameDebugHelpers.test.ts` exercises each new helper
side-by-side with the still-present real debug function and asserts identical resulting state
(4/4 passing, first attempt — the storage-layout cross-check paid off) — written and passing
*before* any of the 79 real call sites were touched; (2) all 79 call sites were then migrated
(mechanical for `setShipPosition`/`setShipHullPointsToZero`; each of the 12 `debugDestroyShip`
sites individually reviewed and restructured, since "destroyed instantly" became "destroyed once
a round completes" — several needed real judgment calls, e.g. a single-ship-fleet deadlock fix
(a 0-HP ship can only legally Retreat, never Pass, so its owner must move it once while still
healthy before priming), two mid-round-destruction tests swapped to `setShipHullPointsToZero`
instead (the reactor-timer mechanism can't destroy mid-round, but the actual invariant under test
— round-completion accounting — is equally well exercised that way), and the "prevent destroying
an already-destroyed ship" test reframed from a revert-check to an idempotency check (verified by
tracing `ships.isShipDestroyed`'s gating in `_incrementReactorCriticalTimerForZeroHPShips`
directly, not just trusted). Full suite: 0 regressions both before and after the three functions
were actually deleted from `Game.sol` (exit code 0 both times, `PRODUCTION` confirmed `false`).

Bytecode: `Game.sol` shrank by exactly 522 bytes (23,807/24,576 deployed, up from 769 bytes of
headroom pre-deletion to comfortable margin), matching the earlier gas-audit measurement exactly.

---

### I-02 — Severe Centralization: Owner Can Alter Any Live Game, Cost, or Attribute

**File:** `contracts/Game.sol`, `ShipAttributes.sol`, `Maps.sol`, `Ships.sol`, `Lobbies.sol` ·
**Full history:** `pre-audit.md`, search `I-02`

The deployer key can: modify any ship's position/HP/destroy it in any live game; change all ship
attributes/costs globally; pause minting/lobby creation; grant/revoke minting rights; apply any
preset map to any game. No timelock, multisig, or governance gates any of it. Split into
debug-named (I-01's three functions) vs. ordinary-admin-config categories — same underlying gap
either way: a single compromised or malicious deployer key acts immediately and unilaterally.

**Partial update 2026-09-16:** the debug-named category (I-01) is fully resolved — those three
functions are deleted, not just narrowed. This finding's ordinary-admin-config half (global
attribute/cost changes, pause controls, preset-map application, etc.) is untouched and still open;
this was never in scope for the debug-function removal work.

---

### ~~HA3-04 — `AIShips.releaseShips` Has No Double-Release Guard (Defense-in-Depth; Not Currently Reachable)~~

**File:** `contracts/AIShips.sol:107-112`

`releaseShips` unconditionally pushes each id's `localId` onto `freeSlots` with no check that the
slot isn't already free. If the same AI ship id were ever released twice, the duplicate `freeSlots`
entry would let a later `allocateShip` pop and reassign that slot a second time while a still-live
context believes it owns that ship — silently overwriting its owner/traits mid-match, no revert.

**Traced reachability directly, not just noted as a concern:** both real callers
(`SinglePlayerMatch.sol:519`, `RoguelikeMatch.sol:399`) call `releaseShips` only from their
`onGameEnded` implementation, gated by `if (msg.sender != address(game)) revert NotGame();`, and
`Game._endGame` (the only thing that can trigger `onGameEnded`) has had
`if (game.metadata.ended) return;` as its first line since the already-fixed `L-08`
(`pre-audit.md`) — confirmed still present. That guard is storage-persistent and checked before
the orchestrator callback fires, so `onGameEnded` — and therefore `releaseShips` — cannot fire
twice for the same `_gameId`, in the same transaction or across separate ones. **Not currently
exploitable via any live code path.** Recommended anyway as defense-in-depth, matching this
project's own "assume hostile/buggy callers" standing rule (CLAUDE.md) — a future third caller of
`releaseShips`, or a regression in `_endGame`'s guard, would have no independent backstop here.

**Fix (low priority, no urgency):** track per-slot in-use state (e.g. a `bool[] inUse` or checking
`freeSlots` membership) and no-op or revert on a redundant release, matching `Fleets.clearFleet`'s
existing idempotent-redundant-call pattern rather than corrupting state silently.

**Status: Fixed 2026-09-16.** Added `mapping(uint => bool) private isFreeSlot`, keyed by local id
(correctly defaults `false` for both "currently allocated" and "never yet allocated" slots — only
set `true` while a slot genuinely sits in `freeSlots`). `allocateShip` clears it when popping a
slot back out; `releaseShips` skips (rather than reverts the whole batch over) an already-free id,
matching the griefing-resistant idempotent-batch pattern this repo already uses in
`RandomManager.revealRandomnessBatch` and `Fleets.clearFleet`. Bytecode: +110 bytes
(6.920/24.576 KiB deployed), ample headroom.

New test in `test/AIShips.test.ts` (`"releaseShips double-release guard (HA3-04)"`): releases the
same ship id twice and confirms `freeSlotCount()` doesn't grow from the redundant call, then
confirms draining the pool afterward yields exactly one reused id followed by real growth past
`slotCount`, never handing the same id out twice. Verified genuine: temporarily removed the guard
(back to unconditionally pushing), confirmed the new test went red, then restored the real fix
from a backup and reconfirmed byte-identical. Full suite re-run afterward (alongside HA3-05/HA3-06
below, verified together in one clean run to rule out any ambiguity from earlier concurrent
foreground/background test runs): exit code 0, no regressions (`PRODUCTION` confirmed `false`
beforehand).

---

### ~~HA3-05 — `SpecialEffectsLib.applyRelocations` Has No Destination-Occupancy Check (Inert Today)~~

**File:** `contracts/SpecialEffectsLib.sol:233-247`

Every other grid-write path in this codebase explicitly rejects an occupied destination
(`_placeShipOnGrid`, `Game.sol:299-305`; the move branch of `moveShip`, `Game.sol:638`) —
`applyRelocations` unconditionally overwrites `game.grid[...]` instead. **Currently inert**: of
every resolver in this codebase, only `RamResolver` ever returns a relocation, and its destination
is always exactly the same-batch-removed target's own now-vacated cell (`RamResolver.sol:101-102`,
paired with a same-batch removal), so no live third-party ship can currently occupy that cell.
Worth a defensive occupancy check before any future resolver adds a second relocation source —
a collision here would desync `grid` from `shipPositions` permanently with no code path to detect
or repair it, a worse failure mode than a clean revert.

**Status: Fixed 2026-09-16.** Added a new `RelocationDestinationOccupied` error and a
`game.grid[newRow][newCol] != 0` check, positioned after the source cell is cleared (so a
relocation landing back on its own current cell, or onto a cell a same-batch removal just cleared,
stays valid) but before the write. `SpecialEffectsLib` is a separately-deployed library — this
adds +49 bytes to its own small budget (5.321/24.576 KiB deployed) and has zero effect on
`Game.sol`'s own tight budget (confirmed unchanged: 23,807 bytes deployed, same as before this
fix).

**No new dedicated test added — documented explicitly, not silently skipped.** This finding is
provably unreachable via any current public code path (only `RamResolver` ever relocates, always
onto its own same-batch-removed target's cell), and `SpecialEffectsLib.applyRelocations` takes a
`GameData storage` parameter that only `Game.sol` can supply — it can't be called directly from a
test with synthetic state the way a standalone contract can. Same reasoning already applied to
HA2-04's second, non-independently-reachable fix earlier this session. Instead: ran the existing
Ram-eviction-relocation test (`test/Game.test.ts`, `"evicts a 0 HP enemy, applies 1 reactor damage
to the rammer, and relocates it onto the victim's tile"`) to confirm the new occupancy check
doesn't cause a false-positive revert on the one legitimate, real relocation path — passes. Full
suite re-run (alongside HA3-04/HA3-06): exit code 0, no regressions.

---

### ~~HA3-06 — `EMPResolver`/`ElectricStormResolver` Cast `uint8` Strength to `int8` With No Range Check~~

**File:** `contracts/EMPResolver.sol:88`, `contracts/ElectricStormResolver.sol:75`

`int8(uint8(strength))` silently wraps to negative for any configured `strength >= 128` (e.g. 150
→ -106), inverting "add to reactor timer" into "subtract from it" for every ship the effect
touches. Admin-config-only (not attacker-reachable at normal player privilege), and current
configured values are presumably well under 128, but there's no code-level guard preventing it —
same "malicious/careless owner" threat model already accepted for I-02 and HA3-02 above.

**Status: Fixed 2026-09-16.** Clamped `strength` to `int8`'s max (127) instead of letting a
misconfigured value flip sign, in both resolvers: `EMPResolver.sol`
(`strength > 127 ? int8(127) : int8(strength)`) and `ElectricStormResolver.sol` (same pattern,
computed once into a local before the `StormContext` struct literal). Both are separately-deployed
resolver contracts — tiny bytecode additions (+21/+25 bytes respectively), no effect on `Game.sol`.

New tests in `test/EffectResolverTargetStatus.test.ts` (`"Reactor-timer strength clamping
(HA3-06)"` describe block), using the existing `MockGameView`/`MockShipAttributesSpecial`
isolated-unit-test pattern with `strength=200` configured, asserting `effects[0].reactorTimerDelta
=== 127` for both resolvers. **Found and fixed a real gap in shared test infrastructure while
writing the `ElectricStormResolver` test:** `MockGameView.getAllShipPositions` was a hardcoded stub
always returning an empty array (never wired up, since no existing test needed it) —
`ElectricStormResolver` is the first resolver in this test file that needs it (it scans ALL ship
positions for its AoE, unlike the single-target resolvers already covered here). Implemented it
properly: track every shipId ever passed to `setShipPosition` per game, return their current
positions. Confirmed this fix didn't change behavior for any of the file's 10 pre-existing tests
(all still pass) before trusting the new tests built on top of it.

Verified genuine: temporarily reverted both resolvers' clamp back to a bare `int8(uint8(...))`
cast, confirmed both new tests went red, then restored the real fixes from backups and reconfirmed
byte-identical. Full suite re-run (alongside HA3-04/HA3-05, one clean run covering all three): exit
code 0, no regressions (`PRODUCTION` confirmed `false` beforehand).

All findings from the third audit pass (HA3-01 through HA3-06) are now fixed.

---

### I-08 — `Ships._update` Modifies Internal State Before `super._update` Call

**File:** `contracts/Ships.sol`, lines 395-439 · **Full history:** `pre-audit.md`, search `I-08`

`shipsOwned` storage is updated before the `super._update` ERC-721 call. Currently safe with
OpenZeppelin's actual implementation, but fragile — if a future base-class change let
`super._update` revert after partially executing, internal and ERC-721 state could desync.

---

### ~~HA2-08 — `RepairResolver`/`RepairDronesResolver` Missing the SP-02 Target-Status Check~~

**File:** `contracts/RepairResolver.sol` (51-83), `contracts/RepairDronesResolver.sol` (51-86) ·
**Status:** Fixed 2026-09-12 (see below). **Full write-up:** `pre-audit.md`, search `HA2-08`

Unlike their three sibling resolvers (patched under SP-02), these two never check
`target.status`. Currently inert — healing a stale target computes a heal cap from `maxHullPoints`,
which is `0` for a deleted ghost, so the write never actually changes anything. **But `HA2-01`
demonstrates `maxHullPoints == 0` isn't a reliable assumption** (it can be revived via
`calculateShipAttributes`), so this should be closed as defense-in-depth alongside `HA2-01`'s fix,
not left relying on that assumption.

**Fixed 2026-09-12.** Added `if (target.status != 0) revert TargetNotFound();` to both resolvers,
placed right after the existing `shipId == 0` check and before the friendliness check — same
position/pattern as `RamResolver`/`EMPResolver`/`DroneSwarmResolver`'s SP-02 fix. Neither resolver
is on `Game.sol`'s own bytecode budget (each is its own separately-deployed contract), so no size
pressure here. Regression tests added to `test/EffectResolverTargetStatus.test.ts` (the file
already built for exactly this purpose under SP-02) — a "rejects fled/destroyed friendly target"
case and an "accepts live friendly target" control for each resolver, reusing `MockGameView`
rather than a full game. Full suite: 655/655 passing.

---

### ~~HA4-06 — `DroneStorefront.turnInCores` Silently No-Ops If `droneEnergyCores` Is Ever Misconfigured to a Non-Contract Address~~

**File:** `contracts/DroneStorefront.sol:61` (`turnInCores`, calls `droneEnergyCores.burnFrom`) ·
**Found 2026-09-28.**

`IDroneEnergyCores.burnFrom` has no return value. A call to a void-returning function against an
address with no bytecode (e.g. an accidentally-unset or typo'd address) **succeeds silently**
rather than reverting, since there's no return data to fail decoding on. If `droneEnergyCores` were
ever misconfigured (neither the constructor nor `setDroneEnergyCoresAddress` checks for a
zero/non-contract address), `turnInCores` would still advance `droneCoreTier[msg.sender]` — which
`FreeShipClaim` reads directly as a permanent +1-free-ship-per-tier bonus — without any DEC
actually being burned. **Not reachable via the current deploy path**: the constructor is correctly
wired to the just-deployed `DroneEnergyCores` address (`ignition/modules/DeployAndConfig.ts:384-392`).
A latent footgun for any future re-wiring, and the worst kind of failure mode — silent success, not
a loud revert.

**Fix:** require `_droneEnergyCores != address(0)` (ideally `.code.length > 0`) in both the
constructor and the setter.

**Status: Fixed 2026-09-29.** Factored both the constructor and the setter through a shared private
`_setDroneEnergyCoresAddress`, which now rejects both a zero address and any address with no
deployed code:

```solidity
function _setDroneEnergyCoresAddress(address _droneEnergyCores) private {
    if (
        _droneEnergyCores == address(0) ||
        _droneEnergyCores.code.length == 0
    ) revert InvalidDroneEnergyCoresAddress();
    droneEnergyCores = _droneEnergyCores;
}
```

`DroneStorefront.sol` compiles at 1.434/24.576 KiB deployed — ample headroom. Regression test added
to `test/DroneStorefront.test.ts` ("Should reject a zero or non-contract droneEnergyCores address at
construction and via the setter (HA4-06)"): both a zero address and a real-but-non-contract EOA
address are rejected at construction and via the setter, while a real deployed contract is still
accepted. Verified genuine: temporarily removed the check from `_setDroneEnergyCoresAddress` in
place, reran the test (0 passing, 1 failing, confirming it fails without the fix), then restored the
real fix from a backup copy and confirmed the restored file was byte-identical to the backup via
`diff`.

---

### ~~HA4-07 — `DroneStorefront.turnInCores` External Call Precedes State Write (CEI Ordering)~~

**File:** `contracts/DroneStorefront.sol:61` (same function as HA4-06) · **Found 2026-09-28.**

`burnFrom` (external) executes before `droneCoreTier[msg.sender]` is incremented, with no
`nonReentrant` guard. **Not currently exploitable**: `DroneEnergyCores` is a stock OpenZeppelin
`ERC20`/`ERC20Burnable` with no transfer/burn hooks, so there's no live callback surface today —
this would only become a real reentrancy vector under the same owner-controlled precondition as
HA4-06 (an intentionally or accidentally non-standard token wired in), already covered by this
project's accepted I-02 centralization risk. Worth reordering (increment tier, then burn) as free
defense-in-depth, same spirit as the already-applied `L-02` fix in `pre-audit.md`.

**Status: Fixed 2026-09-29.** Reordered `turnInCores` to checks-effects-interactions: the
`droneCoreTier[msg.sender]` state write now happens before the external `burnFrom` call, not after.
Pure defense-in-depth, matching the `HA3-05` precedent in this same document — there is no live
exploit today (`DroneEnergyCores` is a stock OpenZeppelin `ERC20Burnable` with no hooks, so no
reentrancy surface currently exists), and no malicious-token test double exists in this project to
independently exercise the reordering, so no dedicated regression test was added for this finding
specifically. Confirmed via the existing `turnInCores` test coverage in `test/DroneStorefront.test.ts`
continuing to pass unchanged with the new ordering (tier progression, exact-amount enforcement, and
max-tier rejection all still behave identically).

---

## Process / Deploy Readiness (not a code vulnerability)

### Admin/Backend Key Separation for Production Deploy

**Full write-up:** `pre-audit.md`, search "Admin/Backend Key Separation"

`ignition/modules/DeployAndConfig.ts`'s `PRODUCTION` branch currently reuses two hardcoded
addresses across several unrelated trust roles: `MAP_EDITOR` (owner of every `Ownable` contract in
the module — map editing, node-graph editing, content publishing, general ownership, all one key)
and `FIREBASE_FLOW_MINTER` (both the ship-minting backend *and* the Selfie-Check verification relay
— two independent trust roles on one key). Known, deliberate dev-time placeholders, not final. Plan
(per explicit direction): separate and replace all admin/backend keys with distinct,
purpose-specific keys before a real production deploy — at minimum a cold owner key (Ledger
hardware signer candidate) separate from any hot backend-relay key, and each hot backend role
either on its own key or deliberately consolidated with an explicit, written acknowledgment of the
combined blast radius. **Not yet done.**

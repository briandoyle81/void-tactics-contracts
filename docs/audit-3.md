# Void Tactics — Open Security/Audit Items (Pass HA6)

_Written 2026-10-13. Live tracker, replacing `docs/audit-2.md` as the place for new findings and status changes. `audit-2.md` stays as written; its still-open items are listed under **Carried forward** below and are not duplicated here._

**Scope:** every non-mock contract in `contracts/` at `0949a65`, plus the uncommitted Roguelike node-clear-guard diff (`GameLens`, `RoguelikeMatch`, `RoguelikeNodeMap`, `RoguelikeRun`, `DeployAndConfig.ts`). `Renderers/` and `RenderersV2/` got a light pass only (tokenURI reverts, gas, string injection).

**Method:** five parallel subsystem reviews: core engine, orchestrators/modes, economy/tokens/hook, ships/NFTs/drones, and AI. Every finding was re-checked against the code before it went in this doc, and checked against `pre-audit.md` / `audit-2.md` so fixed or accepted items aren't raised again. Findings that were re-traced end to end are marked **Confirmed**. Findings whose code facts are confirmed but whose exploit precondition is not fully proven are marked **Plausible**. All fixes are pending, to be taken one finding at a time. Baseline: `npx hardhat test`, 841 passing, 0 failing (`PRODUCTION = false`), including the uncommitted diff.

**When an item gets fixed:** strike it through (`~~text~~`) and add a short "Fixed <date>" note. Don't delete it.

| Severity | Count |
|---|---|
| High | 6 |
| Medium | 13 |
| Low | 12 |
| Info | see list |

### Contract size headroom (runtime, 24 KiB = 24.000 limit), measured 2026-10-13

| Contract | Runtime KiB | Headroom |
|---|---|---|
| Ships | 23.920 (after HA6-04/06 fixes) | **~82 bytes** |
| Game | 23.979 (after HA6-01/02/24/26 fixes) | **~21 bytes** |
| RoguelikeMatch | 23.881 (after HA6-09/12/13/18 fixes) | ~119 bytes |
| Tournament | 16.534 (after HA6-08/17/27 fixes) | ~7.5 KiB |
| SinglePlayerMatch | 15.959 (after HA6-12/13/18 fixes) | ~8 KiB |
| Lobbies | 15.496 (after HA6-10/29 fixes) | ~8.5 KiB |
| UTCLotteryHook | 12.137 (after HA6-05/06/07 and HA5-02 fixes) | ~11.9 KiB |
| Fleets / DroneYard | 7.82 / 7.59 | ample |

Any fix that touches Ships.sol or Game.sol has to be byte-neutral or byte-negative, or be moved into another contract. Several fixes below are chosen with that in mind.

---

## High

### ~~HA6-01 — `Game.calculateShipAttributes` Is Public; Pre-Start Poisoning Permanently Bricks `startGame`~~

**Status: Fixed 2026-10-13.** Renamed to `_calculateShipAttributes` and made `private` (only `_registerFleetShips` calls it). The snapshot-once guard stays as defense in depth. Game.sol runtime went from 23.924 to 23.898 KiB (−25 bytes). `test/Game.test.ts` now asserts the function is absent from Game's ABI instead of calling it. Admin attribute updates are unaffected: `ShipAttributes` computes attributes live from the current version, and each new game snapshots at `startGame`.

**File:** `contracts/Game.sol:387-405`, reached from `startGame` via `_registerFleetShips` (`:316`) · **Confirmed**

- **What's wrong:** the function's only guard is `if (attributes.version != 0) revert InvalidMove();`. There's no check that the game exists or that the ship belongs to it.
- **Why it's exploitable:** game ids are predictable before start:
  - PvP: `gameId == lobbyId`.
  - Single-player / Roguelike: offset + engine block + `count+1`.
- **Attack:** a third party writes `(nextGameId, shipId)` first. `startGame` then hits the guard and reverts.
- **Global DoS on single-player/roguelike:** AI ships come from `AIShips.freeSlots` LIFO, so the next AI ship id is known in advance.
  - Every player's `startNodeMatch` / `enterCombatNode` reverts.
  - The revert also rolls back the counter and `freeSlots.pop()`, so the same id stays poisoned.
  - The block lasts until some other game frees a slot. Re-poisoning costs about 100k gas.
- **PvP:** the attacker poisons a lobby's (lobbyId, shipId) pairs, and the second `createFleet` always reverts. This can also make the honest side eat a `quitWithPenalty`, a third-party version of HA4-03.
- **Why HA2-01 missed it:** HA2-01 kept the function permissionless on the basis that "a stray entry is harmless". That only holds after start.

**Frontend impact (checked 2026-10-13):** none. `void-tactics-fe-eth-ny-26` never calls `Game.calculateShipAttributes`. It reads `ShipAttributes.calculateShipAttributesByIds`, a view on a different contract (`app/hooks/useShipAttributesByIds.ts`, `app/utils/shipAttributesLocalCache.ts`). The other frontend mentions are comments about `ShipAttributes`' math. The one external caller is `test/Game.test.ts:1019` (a re-snapshot-guard assertion), which would need rewriting.

**Fix:** make it `private`, since only `startGame` calls it. That shrinks Game.sol. A fallback is `_requireGameExists(_gameId)`: `startGame` sets `metadata.gameId` before registering ships.

### ~~HA6-02 — Removing a Ship After `_endGame` Reverts `ShipNotFound`; Round Can Never Complete and the Mover Loses on Timeout~~

**Status: Fixed 2026-10-13.** Three `metadata.ended` checks in `Game.sol`:
- `moveShip` skips round handling if the move's action already ended the game.
- The reactor tick loop `return`s after a game-ending removal.
- The `_dispatchEffects` removal loop `break`s, so relocations still apply and the Ram victim's tile is still taken.

The redundant `_requireGameExists` in `_removeShipFromGame` was dropped to offset the bytes. Game.sol runtime is now 23.955 KiB. Regression test: `test/Game.test.ts`, "ends the game cleanly when two 0-HP ships hit timer 3 on the same tick (HA6-02)". It reverted `ShipNotFound` before the fix and passes after.

**Files:** `contracts/Game.sol:601-625` (`_endGame`), `:1309-1371` (`_removeShipFromGame`), `:1394-1421` (reactor tick loop), `_dispatchEffects` removal loop · **Confirmed**

- **Root cause:** `_endGame` ends with `_removeShipsFromFleet` (`Fleets.clearFleet`, which does `delete fleet.shipIds`). Nothing after that checks `metadata.ended`. So any later `_removeShipFromGame` in the same tx fails `isShipInFleet` and reverts `ShipNotFound`, unwinding the whole `moveShip`.
- **Normal-play trigger:**
  1. A disables B's last two ships in the same round.
  2. Both reactor timers reach 3 on the same tick.
  3. The first removal ends the game and clears fleets.
  4. The second removal reverts.
- **Effect:** that tick runs on A's round-ending move every time, so A can never finish the round. B wins via `PvPMatch.endGameOnTimeout`. B can also arrange this deliberately.
- **Same root cause, other paths:** Ram self-destruct after a game-ending ram; ElectricStorm multi-removal; a game-ending kill/retreat followed by the end-of-round tick.

**Fix:**
- In the tick loop, `return` after a removal if `game.metadata.ended`.
- Do the same inside the `_dispatchEffects` removal loop.
- Optionally skip round handling in `moveShip` once ended.
- **Don't** early-return inside `_removeShipFromGame` itself unless it also removes the id from `shipsWithZeroHP`. The tick loop `continue`s without `i++` and would spin to OOG.
- `_requireGameExists` at the top of `_removeShipFromGame` is redundant (every caller has already validated), so dropping it can pay for the new bytes.
- Add a regression test with two simultaneous timer-3 ships.

### ~~HA6-03 — `DroneYard.modifyShip` Passes Caller-Chosen `shipData.shipsDestroyed`/`isFreeShip` Into Storage~~

**Status: Fixed 2026-10-13.** `DroneYard.modifyShip` now overwrites `_newShip.shipData.shipsDestroyed` and `isFreeShip` with the current ship's values before `customizeShip`. These are the only caller-supplied `shipData` fields `_applyShipCustomization` stores besides `shiny`, which DroneYard prices and still takes from the caller. There are no Ships.sol changes, and DroneYard is the only `customizeShip` caller. DroneYard grows by 38 bytes, to 7.588 KiB. Regression test: `test/Ships.test.ts`, "ignores caller-supplied shipsDestroyed/isFreeShip on modify (HA6-03)". It stored the forged `uint32.max` before the fix and passes after.

**Files:** `contracts/DroneYard.sol:189-240`, `contracts/Ships.sol:264-266` (`_applyShipCustomization`), `Ships.recordKill:596-602` · **Confirmed**

- **What's wrong:** `modifyShip` overwrites serial, colors, name, id and owner from the current ship. It leaves `_newShip.shipData` exactly as the caller sent it. `_applyShipCustomization` then writes `shipsDestroyed` and `isFreeShip` from it unchecked. Neither field is validated or priced.
- **Pay-to-win:** an otherwise-unchanged modify costs the ~1 UTC base fee and sets `shipsDestroyed = 1000`. That makes the ship rank 6, with +50% range/damage/hull/movement/DR in PvP and Tournaments. This includes free-claim ships, and fleet cost ignores rank.
- **Game freeze:** set `shipsDestroyed = type(uint32).max`. When that ship gets kill credit, `recordKill`'s `shipsDestroyed++` panics, reverting the round-ending `moveShip`. This feeds the same timeout-loss outcome as HA6-02.
- **Plausible part:** whether the attacker can reliably make the opponent the one who makes that move.
- **Also:** clearing `isFreeShip` defeats `CannotRecycleFreeShip`. That path runs at a loss today.

**Fix (DroneYard only, no Ships.sol bytes):** keep the caller's `shiny`, set `_newShip.shipData = currentShip.shipData`, then restore `shiny`. Shiny is the only shipData field DroneYard prices.

### ~~HA6-04 — `Ships._mintShip` Writes a Stale `owner` After `_safeMint`'s Callback; Struct/ERC-721 Owner Desync~~

**Status: Fixed 2026-10-14.** `_mintShip` now calls `_mint` instead of `_safeMint`, so there's no `onERC721Received` callback mid-mint. The stale `newShip.owner = _to;` line is deleted; `_update` already sets the owner. Everything else in `_mintShip` is unchanged. Ships.sol shrank by 72 bytes, from 23.986 to 23.914 KiB.

Two tests were rewritten because they relied on the callback:
- `test/Ships.test.ts` SP-01: the claim from a contract now succeeds once, struct owner == `ownerOf`, and a second claim hits the cooldown.
- `test/UTCLotteryHookSwap.test.ts` HA4-02: a winner contract that rejects ERC-721 receipt now receives the prize; no `PrizeMintFailed` is emitted.

**File:** `contracts/Ships.sol:523-526` · **Confirmed** (desync) / **Plausible** (marketplace monetisation path)

- **The code:** `_safeMint(_to, id); newShip.owner = _to;`. `_update` already sets `ship.owner = to` at mint, so the second write is redundant.
- **Attack:** inside `onERC721Received`, a recipient that has ≥10 purchases transfers the new token to B. `_update` sets the owner to B, then the line above resets the struct owner to the attacker.
- **Result:** `ownerOf == B`, `shipsOwned[B]` contains the id, but every game-side check reads `ships[id].owner == attacker`. That includes `shipBreaker`, `DroneYard`, `Fleets.createFleet`, `constructShip` and reward payouts.
- **Damage to B:** the attacker can `shipBreaker` (burn) B's NFT and collect `recycleReward`, or lock it into their own fleet or roguelike roster.

**Fix:** delete `newShip.owner = _to;` (saves bytes). Consider `_mint` instead of `_safeMint`, which also closes HA6-11, the ShipGrantWinEffect callback in `_endGame` (Info) and the gas-burn receiver.

### ~~HA6-05 — Lottery Winner Pick Uses a 64-bit Random Modulo a ~1e19+ Weight Space: Biased, and Late Entrants Can Have Zero Chance~~

**Status: Fixed 2026-10-14 by the lottery randomness redesign:**
- **Seed:** the winner now comes from the hash of the block in which the draw **closes**, i.e. the block of the swap that met the 24h + entrant conditions. Entries freeze at close, and that block's hash is unknowable until it's sealed, so nobody can preview or choose the outcome. Who resolves, and when, can't change the result.
- **Resolution:** happens automatically in the next swap in a later block. It runs as a try/catch'd self-call gated on `autoResolveMinGas`, so it never reverts the trader's swap. A permissionless `resolveDraw` is the fallback, and past the 256-block `blockhash` window the draw re-targets to the current block.
- **Full-width hash:** `keccak256(abi.encode(closeHash, drawId))` modulo the denominator.
- **Snapshot:** the denominator is snapshotted at close.
- **RandomManager dependency removed from the hook**, along with its constructor argument.
- **Tests (`test/UTCLotteryHookSwap.test.ts`, "close-block randomness and automatic resolution"):**
  - the winner matches an off-chain computation from the close block's hash, ignoring owner parameter changes made after close;
  - resolving in the close block reverts;
  - the next swap auto-resolves;
  - a failing auto-resolve (Ships paused) doesn't revert the swap;
  - an under-gassed swap skips auto-resolution;
  - past 256 blocks the draw re-targets, then resolves.

**Files:** `contracts/UTCLotteryHook.sol` `resolveDraw` (`target = uint256(randomness) % effectiveTotalWeight`), `RandomManager._revealRandomness` (truncates to `uint64`) · **Confirmed**

- **The mismatch:** `randomness ≤ 2^64−1 ≈ 18.45e18` wei. With defaults, `effectiveTotalWeight ≥ 10e18`.
- **Total weight above ~18.45 ETH:** every participant whose cumulative range starts beyond 2^64 **can never win**. Ranges follow first-entry order.
- **Below the 10e18 floor:** `[0, 8.45e18)` is twice as likely as the rest. Early entrants get about 2x odds, and a 1-ETH entrant reaches ~10.8%, which breaks HA2-06's 1/10 cap.
- **Exploit:** in one PoolManager unlock, trigger `_maybeStartDraw`, then do ~19 max-weight sells with fresh `hookData` addresses, then buy back. Every honest later entrant to that draw then has 0% chance. This repeats each draw. It shares the Sybil cheapness of HA5-02 but has a different root cause.

**Fix:** `target = uint256(keccak256(abi.encode(randomness, _drawId))) % effectiveTotalWeight`, the same as Tournament's shuffle. Add a test with more than 19 maxed entrants where the last entrant can win.

### ~~HA6-06 — `resolveDraw` Can Be Forced Into `PrizeMintFailed` by a Short-Gas Caller (Variant of HA4-02)~~

**Status: Fixed 2026-10-14 (retry-on-failure, chosen over pull-claim).**
- **Prize mint called bare:** `resolveDraw` calls the prize mint with no try/catch. Any mint failure (short gas, Ships paused, anything else) reverts the whole call, including `drawResolved = true`. The draw stays open and anyone can retry. The winner is fixed by the locked randomness, so a retry can't change who wins.
- **`PrizeMintFailed` removed.**
- **Template dequeue:** the queued template is now dequeued before the mint (CEI); a revert undoes that too.
- **Why HA4-02's original brick risk doesn't apply:** HA6-04's `_mint` removed the receiver callback, and `_extractPlayer` rejects `address(0)`.
- **Gate exemption ("any address can win any ship"):**
  - `IVariantPurchaseGate.checkGate` now also takes the minter (`msg.sender` into Ships), adding 6 bytes to Ships.sol.
  - `VariantPurchaseGate` has an owner-set `exemptMinter` list. The lottery hook is exempted by `scripts/deployUTCLotteryPool.ts` Step 13b and by the test fixture.
  - Purchases and free claims stay gated.
- **Tests (`test/UTCLotteryHookSwap.test.ts`):**
  - Paused Ships makes `resolveDraw` revert; it succeeds after unpause.
  - A medal-less winner receives a gated variant-2 prize. The control: with the exemption removed, the draw reverts `GateRequirementNotMet` and stays open.

**File:** `contracts/UTCLotteryHook.sol` `resolveDraw` (try/catch mint after `drawResolved = true`) · **Confirmed** (EIP-150 mechanics)

- **Note (2026-10-14):** after HA6-04, a non-receiving winner no longer fails the mint. The short-gas route below, plus pause and gated-variant failures (HA6-20), still lead to `PrizeMintFailed`.
- **How:** `resolveDraw` is permissionless. A caller sizes the tx gas so the expensive inner mint (`requestRandomness`, `_safeMint`, struct writes, likely 250k+ gas) runs out of gas. The retained 1/64 is enough for the `catch` to emit `PrizeMintFailed` and return.
- **Result:** the draw is finalised and the honest winner gets nothing, with no retry.
- **Same silent loss, owner-side:** `Ships.setPaused(true)` or a gated prize variant (HA6-20) also produce it.

**Fix:** pull-claim. Record `pendingPrize[drawId] = winner` and add a retryable `claimPrize(drawId)` that reverts on failure. Minimum fix: require `gasleft() >= MIN_PRIZE_GAS` before the `try`, and revert in `catch` on an empty-reason OOG.

---

## Medium

### ~~HA6-07 — Lottery Has No Reveal Window: a Patient Caller Can Choose the Winning Epoch (HA2-07 Never Ported to the Hook)~~

**Status: Fixed 2026-10-14 by the lottery randomness redesign:**
- **Seed:** the winner now comes from the hash of the block in which the draw **closes**, i.e. the block of the swap that met the 24h + entrant conditions. Entries freeze at close, and that block's hash is unknowable until it's sealed, so nobody can preview or choose the outcome. Who resolves, and when, can't change the result.
- **Resolution:** happens automatically in the next swap in a later block. It runs as a try/catch'd self-call gated on `autoResolveMinGas`, so it never reverts the trader's swap. A permissionless `resolveDraw` is the fallback, and past the 256-block `blockhash` window the draw re-targets to the current block.
- **Full-width hash:** `keccak256(abi.encode(closeHash, drawId))` modulo the denominator.
- **Snapshot:** the denominator is snapshotted at close.
- **RandomManager dependency removed from the hook**, along with its constructor argument.
- **Tests (`test/UTCLotteryHookSwap.test.ts`, "close-block randomness and automatic resolution"):**
  - the winner matches an off-chain computation from the close block's hash, ignoring owner parameter changes made after close;
  - resolving in the close block reverts;
  - the next swap auto-resolves;
  - a failing auto-resolve (Ships paused) doesn't revert the swap;
  - an under-gassed swap skips auto-resolution;
  - past 256 blocks the draw re-targets, then resolves.

**Residual:** Base's sequencer builds the close block and could in theory reorder transactions to influence its hash. That's a trust assumption on Coinbase, not something an ordinary player can exploit.

**Still open and related:**
- **Sybil weight across addresses, made near-free by JIT liquidity: accepted by design (2026-10-15).** Each `hookData` address gets its own capped weight, and an attacker can recapture most of the swap fees by adding liquidity around their own trades.
  - **Why it's accepted:** the lottery exists to generate swap volume, and entries spread across addresses add to that. Buying weight is open to everyone at the same price, and the odds stay proportional to weight.
  - **Known effects:** wash volume may not produce LP fee income if JIT recaptures it. Power users dominate the odds, but casual players are unlikely to use the feature anyway.
  - **Consequence:** the per-address cap and the 1/10 floor (HA2-06) only bind a single address.
- ~~**HA5-02's participant loop gas limit.**~~ _(Fixed 2026-10-15.)_
- **Very valuable prizes:** for these, an auction or fixed-price sale is the safer mechanism than a raffle.

**Files:** `UTCLotteryHook.resolveDraw`; `RandomManager.revealRandomness`/`fulfillRandomRequest` (permissionless, any id) · **Confirmed**

- **Why it works:** after `DrawStarted`, all inputs are public. Any address can compute `keccak256(prevrandao, requestId)` per ~12s epoch. It can then call `resolveDraw`, or lock the request directly via `RandomManager.revealRandomness`, only in an epoch where it wins, or where nobody wins.
- **No deadline:** nothing forces resolution, so a participant turns a 1/N chance into near-certainty.
- **Severity:** High if no keeper reliably resolves in the first eligible epoch.

**Fix:** port Tournament's `SHUFFLE_REVEAL_WINDOW` and reroll (deadline, then a permissionless reroll). Pair with HA6-19's requester-only reveal so outsiders can't lock the request directly.

### ~~HA6-08 — Tournament: an Assigned-Then-Abandoned Game Freezes the Bracket and Prize Pool~~

**Status: Fixed 2026-10-14.**
- **New path:** `resolveStalledMatch` now also handles a match whose assigned game never ended. Once the game's current turn timeout plus a further `matchTimeout` has passed, anyone can resolve it, and the player whose turn it is loses. That's the same outcome `PvPMatch.endGameOnTimeout` gives. The grace period leaves the waiting player time to end the game normally first.
- **Before that point:** it reverts with the new `GameNotStalled`, which also covers already-ended games; those still go through `recordResult`/`resolveDraw`.
- **Unchanged:** the unassigned path keeps its seed tiebreak, and HA5-01 is still open.
- **Size:** Tournament grew by 362 bytes, to 17.038 KiB.
- **Tests (`test/Tournament.test.ts`):** the old "rejects once a game has been assigned" test became "rejects until turn timeout + matchTimeout". New: "resolves an assigned game both players abandoned against the player whose turn it was (HA6-08)", which also checks that `finalize` then works.
- **Not fixed here:** the abandoned game itself stays unended in Game, so the two players' ships stay in their fleets until one of them calls `PvPMatch.endGameOnTimeout` or `flee`.

**Files:** `contracts/Tournament.sol:569,595` (`if (m.gameId != 0) revert GameAlreadyAssigned();`), `contracts/PvPMatch.sol:185-197` (`endGameOnTimeout` is players-only) · **Confirmed**

- **Setup:** two registrants start a real game. Anyone calls the permissionless `assignMatchGame`. Both players go silent.
- **Every exit is closed:**
  - `recordResult` has no result to record.
  - `resolveDraw` reverts `GameNotComplete`.
  - `claimForfeitWin` / `resolveStalledMatch` revert `GameAlreadyAssigned`.
  - Only the absent players can time the game out.
- **Result:** the rest of the bracket and the prize pool are frozen forever. This bypasses the protection `resolveStalledMatch` was added for. It's adjacent to HA5-01, but a different path.

**Fix:** allow `resolveStalledMatch` when the assigned game has exceeded its turn timeout (or `startedAt + matchTimeout`) without ending. Or let anyone call `PvPMatch.endGameOnTimeout` after a longer grace period. Coordinate with the HA5-01 fix.

### ~~HA6-09 — A Routine `ShipAttributes.setCosts` Bricks Every In-Progress Roguelike Run~~

**Status: Fixed 2026-10-15 (option C: a run keeps the prices it started with).** Costs are overwritten, not versioned, but each ship's stored `cost` is the snapshot a run needs.
- **`Fleets.createFleetFrozenPrices`:** same checks as `createFleet` except the cost-version check, restricted to the same fleet-manager allowlist. It uses an ordinary storage flag that's set and cleared within the call. `createFleet`'s frame is at the stack limit, so a parameter wasn't possible, and the main compiler targets Paris, so transient storage isn't available.
- **RoguelikeMatch:** `startRun` keeps the checked `createFleet`, so a run starts at current prices. Combat entry, post-win re-reservation and its fallback use frozen prices.
- **RoguelikeResupply:** kept roster ships stay frozen, and newly added ships must be at current prices (checked in `resupplyModifyRoster`).
- **Option B (try/catch ending the run) was not added.** With frozen prices, the only remaining failure causes are admin misconfiguration (HA6-13) or unknown bugs, and `retreatRun` already releases the ships in that case.
- **Sizes:** Fleets 7.753 KiB, RoguelikeMatch 23.522 KiB, RoguelikeResupply 7.872 KiB.
- **Tests (`test/RoguelikeMatch.test.ts`, "Cost changes during a run (HA6-09)"):**
  - a price increase mid-combat, enough to break the cap if the roster were re-priced, doesn't stop the win or the next fight;
  - `startRun` still requires current prices;
  - resupply keeps frozen prices but requires current prices for added ships.

**Files:** `contracts/RoguelikeMatch.sol:650-669` (`onGameEnded` re-reservation), `_reserveRoster:420-434`, `enterCombatNode`; `contracts/Fleets.sol:148-152` · **Confirmed**

- **Mid-combat:** a cost bump changes `costsVersion`. In `onGameEnded`, both the `try fleets.createFleet` and the `catch` fallback `_reserveRoster` (also `createFleet`, unguarded) revert `ShipCostVersionMismatch`. The comment says this path should never revert, but it does. Since `Game._endGame` calls this unguarded, the human's winning move reverts.
- **Between nodes:** the roster is `inFleet`, so the player can't `syncShipCosts`. `enterCombatNode` and `resupplyModifyRoster` revert.
- **Only exit:** `retreatRun`, which counts as a loss.
- **Why L-02 missed it:** pre-audit L-02 assumed one fleet per game. Roguelike re-creates fleets across matches.

**Fix:** re-sync roster costs before re-reserving. This needs a router/IShips path to `syncShipCosts`. Alternatively, wrap `_reserveRoster` in try/catch and `endRun(player, false)` cleanly instead of reverting. RoguelikeMatch has ~0.66 KiB headroom.

### ~~HA6-10 — Lobbies `activeLobbiesCount` Leaks in `timeoutJoiner`/`quitWithPenalty` (HA4-03 Fix Incomplete)~~

**Status: Fixed 2026-10-15.**
- **New helper `_releasePlayerSlot`:** decrements the count (floored at zero) and clears `activeLobbyId` only when it points at this lobby. It's used by every exit from a not-yet-started lobby: `leaveLobby`, `timeoutJoiner` (the joiner), `quitWithPenalty` (the joiner) and game start (both players).
- **`leaveLobby`:** now authorizes by membership (`playerLobbies[msg.sender].contains`) instead of the single slot, so a player in several lobbies can leave any of them.
- **`quitWithPenalty`:** now keeps the penalized creator in their reopened lobby, like `timeoutJoiner`. Previously it untracked them, leaving an open lobby its creator could never leave.
- **Size:** Lobbies is 97 bytes smaller, at 15.229 KiB.
- **Tests (`test/Lobbies.test.ts`):**
  - The HA4-03 test had encoded the leak: the joiner paid the fee for a second lobby. It now asserts the free slot is restored.
  - The quit-with-penalty test now asserts the creator stays and can leave, with both counts back to 0.
  - New: a player in several lobbies can leave a lobby other than the one `activeLobbyId` points at.

**Files:** `contracts/Lobbies.sol:525-550` (`timeoutJoiner`), `:695-720` (`quitWithPenalty`); increments at `:379,:449`; only `leaveLobby` (`:277`) and game start (`:646-651`) decrement · **Confirmed**

- **Attack:** a hostile creator with a 300s `turnTime` never commits a fleet. Each joiner gets `timeoutJoiner`'d, and their `activeLobbiesCount` is never decremented.
- **Cost to the victim:** with `freeGamesPerAddress = 1`, they pay `additionalLobbyFee` on every future create/join, permanently. That's worse than the `kickCount` HA4-03 removed. `quitWithPenalty` leaks the same way.
- **Related:** the single `activeLobbyId` slot gets zeroed or overwritten even when it pointed at a different lobby. A third party can then make a player unable to `leaveLobby` their own other lobby.

**Fix:** decrement (floored at 0) both affected players in both paths. Only clear `activeLobbyId` when it equals `_lobbyId`. Ideally authorise `leaveLobby` via `playerLobbies[msg.sender].contains(_lobbyId)`.

### ~~HA6-11 — Free Ships Can Be Recycled Inside the Mint Callback (`isFreeShip` Set After `_safeMint`)~~

**Status: Fixed 2026-10-14 by the HA6-04 fix.** With `_mint` there's no callback between the mint and the `isFreeShip` write, so a free ship can't be recycled, or the flag mis-assigned, mid-mint. The DroneYard path to clearing `isFreeShip` was closed by HA6-03.

**Files:** `contracts/Ships.sol:130-140` (`createShips`), `FreeShipClaim.sol`, `ShipGrantWinEffect.sol` · **Confirmed**

- **Attack:** `isFreeShip = true` is written after `_mintShip`, so after `onERC721Received`. A contract claimant (≥10 purchases) calls `shipBreaker([newId])` in the callback and collects `recycleReward` per free ship.
- **Variant:** minting a paid ship inside the callback shifts `shipCount`, so the flag lands on the wrong ship.
- **Scale:** Sybil-scalable while eligibility is off, and it defeats the guard `tokenomics-audit.md` relies on.

**Fix:** use `_mint`, or set the flag before minting by passing it into `_mintShip`. Both are size-neutral or negative.

### ~~HA6-12 — AI `decide()` Runs Outside try/catch, and SinglePlayerMatch Has No Human Forfeit~~

**Status: Fixed 2026-10-15.**
- **Decision fallback:** in both `SinglePlayerMatch` and `RoguelikeMatch`, `_decideMove` now falls back to passing in place when the pinned registry or the variant's AI isn't a contract, `aiFor` reverts, or `decide` reverts or runs out of gas. The code-length checks are there because a call to an address with no code fails while decoding its empty return data, which try/catch can't catch.
- **Visibility:** the turn emits `AIDecisionFailed(gameId, shipId)` whenever it falls back, so a broken AI still fails loudly.
- **Forfeit:** `SinglePlayerMatch.forfeit(gameId)` lets the match's human end it as a loss (the same as roguelike's `retreatRun(gameId)`), so a single-player match can never trap their ships.
- **Sizes:** SinglePlayerMatch 15.902 KiB, RoguelikeMatch 23.722 KiB (about 0.28 KiB left).
- **Tests:**
  - `test/SinglePlayerMatch.test.ts`: the old "reverts NoAIForVariant" test, which encoded the freeze, now asserts Pass plus `AIDecisionFailed`. New: forfeit is human-only, ends the game and releases the ships.
  - `test/RoguelikeMatch.test.ts`: the AI falls back to Pass with the event instead of freezing.
- **Not covered:** a `maps` swap mid-game can still fail the scoring-position read before `decide`; that's HA6-18's per-game pinning.

**Files:** `contracts/SinglePlayerMatch.sol:435-440` and `RoguelikeMatch` `_takeShipTurn` (`_decideMove` before the `try`) · **Confirmed**

- **What's wrong:** a revert in decision-making makes `takeAITurn` revert forever. In SinglePlayerMatch the human has no flee or timeout. The only `forceEndSession` caller is AI surrender, so the human's ships stay `inFleet` indefinitely. Roguelike can escape only via `retreatRun`, which forfeits the run.
- **Triggers:**
  - `setVariantAI(v, address(0))` (the documented "take offline" path).
  - An encounter config with a variant that has no registered AI (`_mintAIFleet` doesn't check `aiFor`).
  - `aiRegistry` unset at start.
  - A bad address in `Variant1AI`/`Variant2AI` setters.
  - **Plausible:** `_standTile` loop gas at huge admin-set ranges.

**Fix:** call `decide` via try and fall back to Pass. Validate `aiFor` per placement and a non-zero registry at match start. Add a human forfeit to SinglePlayerMatch (`forceEndSession(gameId, address(this), human)`), a few hundred bytes with headroom available.

### ~~HA6-13 — UA-02 Engine-Live Guard Never Applied to SinglePlayerMatch / RoguelikeMatch / RoguelikeResupply~~

**Status: Fixed 2026-10-15.** These setters now revert `EngineAlreadyLive`, the same rule as PvPMatch's UA-02 fix:
- **SinglePlayerMatch:** `game`, `ships` (the AI pool), `maps`, `nodeMap`, once `nodeMatchCount > 0`.
- **RoguelikeMatch:** `game`, `aiShips`, `humanShips`, `fleets`, `maps`, `nodeMap`, `runLedger`.
- **RoguelikeResupply:** `humanShips`, `fleets`, `nodeMap`, `runLedger`.

Both roguelike contracts lock once any run has started, using a new `RoguelikeRun.runsStarted` counter. A run can be live before any match starts, so a match counter wouldn't do. Setters only used when a game starts (encounters, registries, UTC, ship attributes) stay free. A new engine goes through `GameEngineRegistry`.
- **Sizes:** RoguelikeMatch 23.914 KiB, **86 bytes left**. RoguelikeResupply 8.041 KiB, RoguelikeRun 4.051 KiB, SinglePlayerMatch 15.966 KiB.
- **Tests:** single-player and roguelike "locks the live-state address setters" tests: configurable before, reverts after.

**Files:** `SinglePlayerMatch.sol:149-155,183`; `RoguelikeMatch.sol:146-188`; `RoguelikeResupply.sol:68-90` · **Confirmed** (owner-only)

- **`setGameAddress` mid-match:** in-flight `onGameEnded` reverts `NotGame`, so games can never end and roster NFTs stay `inFleet` forever. Roguelike's `retreatRun` also reverts.
- **`setRunLedgerAddress`:** orphans every active run's reservation.
- **`setShipsAddress`/`setAIShipsAddress`:**
  - Higher-offset pool: `releaseShips` underflows.
  - Same-offset pool: old local ids are pushed onto a pool where those ids are live. That makes HA3-04's double-allocation reachable. `ShipsRouter.aiShips` is constructor-fixed, so it desyncs regardless.
- **Severity:** owner-only, but the same class as UA-02, which was fixed only for PvPMatch.

**Fix:** copy PvPMatch's `gamesStarted`/`EngineAlreadyLive` gate onto these setters. Better still, pin `game` per gameId, the way `aiRegistryAtStart` already is.

### ~~HA6-14 — Selfie Check Verification Can Never Be Renewed (Nullifier Reuse Reverts)~~

**Status: Fixed 2026-10-15.**
- **New mapping:** `nullifierOwner[nullifier]` binds a nullifier to its first wallet.
- **`markVerified`:** the same wallet can renew, and a different wallet with that nullifier still reverts `NullifierAlreadyUsed`. `usedNullifiers` is still written, so existing reads keep working.
- **New owner-only `releaseNullifier`:** for wallet moves. It ends the old wallet's eligibility and frees the nullifier.
- **Tests (`test/SelfieCheckEligibilityProvider.test.ts`):** renewal after expiry, second-wallet rejection, and release then re-verify on a new wallet.
- **Integration doc:** given a dated note.

**File:** `contracts/SelfieCheckEligibilityProvider.sol:73-89` · **Confirmed** (assuming a stable per-action nullifier, which is World ID's design)

- **What's wrong:** a second `markVerified` for the same human, even the same wallet, reverts `NullifierAlreadyUsed`.
- **Consequence:** after 90 days every verified player permanently loses `FreeShipClaim`/`TutorialClaim` eligibility. The only workaround, disabling `nullifierCheckEnabled`, removes Sybil protection for everyone.
- **Conflict with docs:** the integration doc promises a rolling 90-day window.

**Fix:** store `nullifierOwner[nullifier] = player` and allow re-marking when it matches. Rebinding to a different wallet goes through an owner path that clears the old wallet.

### ~~HA6-15 — Specials Ignore Line of Sight; Handoff Doc Says They Require It~~

**Status: Not a bug, closed 2026-10-15.** Specials are intended to ignore line of sight. The 2026-09-26 handoff doc's claim was wrong, and it now has a dated correction. No contract change.

**Files:** all `*Resolver.sol`, `SpecialEffectsLib`; LoS is only enforced in `Game._validateShootTarget` (`:1001-1015`) · **Confirmed**

- **What's wrong:** EMP, DroneSwarm, Repair/RepairDrones, Flak and ElectricStorm check Manhattan range only, so they work through blocked terrain and through intervening enemy ships.
- **Doc conflict:** `frontend-handoff-combat-blocking-and-ship-specials-2026-09-26.md:44` says Special at range >1 needs clear LoS.
- **Effect:** the frontend preview and the AI assume rules the chain doesn't enforce.

**Fix:** decide which is intended. If LoS is intended, enforce it in the targeted resolvers (they can call `maps.hasMapsAvoidingShips`; Game.sol has no room). Otherwise correct the doc.

### ~~HA6-16 — Rank Farming: Kills on Free, Replayable AI Ships Give Human NFTs Permanent PvP Stat Bonuses~~

**Status: Fixed 2026-10-16.**
- **Decision:** rank stays grindable by design. Two rules changed in `ShipsRouter.setTimestampDestroyed`:
  - only a PvP kill (no AI ship on either side) of a non-free ship increments the destroyer's kill count;
  - destroying a free ship pays no UTC.
- **Unchanged:** PvE DEC rewards. Free ships still can't be recycled at all.
- **ECON-05:** the note in `tokenomics-audit.md` is corrected. Repeat self-play games were never charged a lobby fee.
- **Tests (`test/ShipsRouter.test.ts`):** PvE kills give no kill credit, a free-ship kill pays nothing and credits nothing, and a PvP kill credits a kill.

**Files:** `ShipsRouter.setTimestampDestroyed:115-136` (unconditional `recordKill`), `ShipAttributes.sol:97-141` (rank bonus), `RoguelikeMatch.startNodeMatch` (replayable unlocked nodes) · **Confirmed** (code) / **Needs design decision**

- **Mechanism:** replaying the weakest node for roughly 125 matches, paid in gas only, takes a ship to rank 6 (+50% stats). The rank carries into PvP and Tournaments and travels with the NFT on sale.
- **Intent unclear:** DEC farming is intentional. Nothing documents that PvP stat progression from AI kills is intended.

**Fix (if not intended):** skip `recordKill` when the destroyed ship is AI (`_isAI(_id)` already exists in the router), or keep a separate AI-kill counter.

### ~~HA6-17 — Tournament `maxPlayers` Uncapped: `buildBracket` Can OOG With No Exit From `Starting`~~

**Status: Fixed 2026-10-16.** `Tournament.MAX_PLAYERS = 128`, enforced in `createTournament`.
- **Measured `buildBracket` gas:** about 107k per player. 16 players: 1.74M; 32: 3.45M; 64: 6.86M; 128: 13.69M. 128 players stays under a 2^24 per-transaction gas cap.
- **Test:** 129 is rejected and 128 is accepted.

**File:** `contracts/Tournament.sol:256-262` (no upper bound), `buildBracket` (O(n) storage pushes), `cancel` (Registration-only) · **Plausible**

- **What would happen:** a large tournament reaches `Starting`, and then `buildBracket` exceeds the per-tx gas cap. `rerollBracketShuffle` doesn't help, so entry fees and the sponsor pot are locked.
- **To confirm:** measure gas at n = 256 / 512 / 1024.

**Fix:** cap `maxPlayers` in `createTournament`, and/or allow `cancel` from `Starting` after N failed attempts.

### ~~HA6-18 — UA-08 Fix Is Partial: Pinning the Registry Address Doesn't Pin AI Behaviour~~

**Status: Fixed 2026-10-16.**
- **AI pinned per ship:** each AI ship's AI contract is stored in `AIShipInfo.ai` at mint, in the same storage slot, and called directly. `aiRegistryAtStart` is removed (the frontend never read it).
- **Fails loudly at start:** a variant with no registered AI now makes match start revert `NoAIForVariant`, instead of failing mid-match.
- **Maps:** already covered by HA6-13's setter locks.
- **Tests:**
  - a registry change mid-match doesn't affect the pinned AI;
  - match start fails with no registered AI;
  - the HA6-12 fallback tests now pin a broken AI before the match.

**Files:** `AIBehaviorRegistry.setVariantAI:31`, `SinglePlayerMatch.sol:242,518-521`, `RoguelikeMatch` equivalent; live `maps` read · **Confirmed**

- **Contents still mutable:** `setVariantAI` changes what the pinned registry returns, and that's the documented upgrade path. A balance patch still changes the opponent mid-match.
- **Maps swap:** `setMapsAddress` mid-game makes the AI reason against an empty map.

**Fix:** pin the AI contract address per AI ship at mint. It packs into the existing `AIShipInfo` slot. Pin `maps` per game, or read it from Game.

### ~~HA6-19 — Any Third Party Can Choose Which Epoch Locks Another Player's Ship Roll~~

**Status: Fixed 2026-10-16** (built per the 2026-10-15 decision below). `RandomManager` now derives each result from `keccak256(blockhash(request block), requestId)`.
- **Reveal timing no longer matters.** Revealing stays permissionless, but it only captures a value that's already fixed, so neither third parties nor owners can choose an outcome.
- **Expiry:** past the 256-block window, a request reverts `RequestExpired` until the owner calls `retargetExpired` (batch, owner-only). That skips revealed and still-valid ids, so it can't re-roll a valid request.
- **Ownership:** `RandomManager` is now `Ownable`. Ownership goes to MAP_EDITOR in the production deploy.
- **Tournament:** `rerollBracketShuffle` also opens once the request expires, closing the gap between the ~8.5-minute expiry and the 10-minute deadline.
- **Window extended 2026-10-16:** `BlockHashLib` reads hashes through the EIP-2935 history contract (live on Base), so requests now last 8191 blocks (~4.5 hours) instead of 256. Expiry is defined as "the hash can't be read", which keeps it consistent on chains without a working EIP-2935, including Hardhat 2.27's always-reverting stub. `UTCLotteryHook` uses the same library for its close block. Tests: `test/fixtures/eip2935.ts` installs Base's real bytecode.
- **Unchanged:** `Ships` (0 bytes) and the consumer interface.
- **Tests (`test/RandomManager.test.ts`, block-hash section):**
  - the result matches the request block's hash however late, and by whomever, it's revealed;
  - same-block requests get independent results;
  - revealing in the same block reverts;
  - the 256-block boundary and expiry;
  - owner-only re-targeting, which skips revealed and valid ids.
  - `test/Tournament.test.ts`: reroll on expiry.
- **Frontend handoff:** `docs/frontend-handoff-block-hash-randomness-2026-10-16.md`.

_Note 2026-10-14: the lottery no longer uses RandomManager, so this now affects only ship rolls and the Tournament shuffle._

**Decision 2026-10-15 (implemented 2026-10-16):** replace caller-timed reveal with mint-block-hash randomness, so the reveal can't choose the outcome.
- **Value:** `keccak256(blockhash(mintBlock), requestId)`. The permissionless `revealRandomness`/`revealRandomnessBatch` just capture it, and `fulfillRandomRequest` captures it if that hasn't happened yet.
- **No capture job.** The frontend constructs right after mint, replacing today's reveal-at-construct-click step.
- **Past the 256-block window:** an **admin-only** re-target to the admin's own (unknowable) block. Players request it through support.
- **Known gaps:**
  - Ships minted outside the player's own transaction, especially lottery fallback prizes minted during someone else's swap, will often miss the window.
  - Admin re-targets are trusted not to be used for rerolls (I-02 class).
  - Sequencer influence on block hashes.
  - The Tournament shuffle's window/reroll needs adapting.
- **This also removes owner self-timing.** Today an owner scripting reveals can get a rank-4+ ship in ~4 minutes on average.

**Files:** `contracts/RandomManager.sol:105-168` (no requester binding), `GenerateNewShip.generateShip` (public preview) · **Confirmed**

- **What's new here:** the accepted "patient caller" residual (pre-audit, C-01/C-02 addendum) assumed the person timing the reveal is the ship's own owner. Anyone can call `revealRandomness(serial)` for someone else's unconstructed ship. A griefer previews each epoch and locks in the worst roll. That's zero-profit griefing, which the CLAUDE.md hostile-actor rule says to treat as real.
- **Severity:** Medium on stakes. Most ships are low value, but tier-4 / rank-5 / lottery-fallback ships aren't.

**Fix:** store `requester = msg.sender` in `Request` and require it in all three reveal paths. Ships, the Hook and Tournament each request their own ids. This also closes the direct-lock route in HA6-07.

---

## Low

### ~~HA6-20 — Ships Pause or a Gated Prize Variant Silently Burns Lottery Prizes; Runbook Is Stale~~

**Status: Fixed 2026-10-14 by the HA6-06 fix.** A paused Ships now makes `resolveDraw` revert, with the draw kept open, so `deploy-runbook-uniswap-lottery.md`'s "will revert while paused" is accurate again. Gated prize variants are deliverable to any winner via the hook's gate exemption.
- **Files:** `UTCLotteryHook.resolveDraw`, `_validatePrizeTemplate`/`setFallbackVariant`; `docs/deploy-runbook-uniswap-lottery.md:114-118` · **Confirmed**
- **Pause:** since HA4-02 the mint is caught, so `Ships.paused` causes `PrizeMintFailed`, not a revert. The runbook still says it reverts.
- **Gated variant:** a variant-2 template or fallback (gated by `VariantPurchaseGate` on ShatteredHiveMedal) fails for every medal-less winner. The template stays queued, so this repeats every draw.
- **Fix:** pull-claim (HA6-06), or reject gated variants in the validators. Update the runbook.

### ~~HA6-21 — UTC Minted to RoguelikeMatch on AI Kills Is Permanently Stuck~~

**Status: Fixed 2026-10-16.** AI destroyers no longer trigger any reward; the only recipient was an orchestrator contract. The SinglePlayerMatch withdraw-UTC test is replaced by "mints no UTC when the AI destroys a human ship".
- **Files:** `DestroyRewardLib.sol:39-52`, `ShipsRouter.sol:121-134` · **Confirmed**
- **What happens:** roguelike AI ships are owned by `RoguelikeMatch`. When one kills a human ship, UTC is minted to `RoguelikeMatch`, which has no `withdrawUTC` (SinglePlayerMatch does). That inflates `totalSupply`.
- **Fix:** skip the mint when the destroyer's owner is a registered orchestrator, or add `withdrawUTC`.

### ~~HA6-22 — Owner Footguns That Freeze Live Games or Draws~~

**Status: Fixed 2026-10-16.**
- **`DestroyRewardLib.payDestroyReward` never reverts.** Every external call is try/catch'd and non-contract addresses are skipped. A failure emits `RewardSkipped` and the kill still processes.
- **The other sub-items were already resolved by the lottery redesign:** the hook's RandomManager dependency is gone, and its odds are snapshotted at close.
- **Test:** with UTC minting off, a lethal kill still processes.
- `UniversalCredits`/`DroneEnergyCores.setMintIsActive(false)`, or a faction reward token where ShipsRouter isn't an authorised minter: `payDestroyReward` reverts, so **every lethal shot in every live game reverts**. That's the HA2-01 failure class. Wrap the payout in try/catch in the router, or document "never while games are live". **Confirmed**
- ~~`UTCLotteryHook.setRandomManager` while a draw is open: `resolveDraw` reverts `RequestNotFound`, or reads an unrelated, possibly already-public request. Pin the manager per draw.~~ _(Gone 2026-10-14: the hook no longer uses RandomManager.)_
- ~~`setMaxWeightPerEntryWei`/`setMaxWinProbabilityDenominator` mid-draw change live odds. Snapshot them at `DrawStarted`.~~ _(Fixed 2026-10-14: snapshotted at close in `drawEffectiveTotalWeight`.)_
- A broken `randomManager` makes every eligible swap in the pool revert (`_afterSwap` calls `requestRandomness`).

### ~~HA6-23 — Unconstructed Ship Can Enter a Fleet (L-03 Consequence)~~

**Status: Fixed 2026-10-16.** `Fleets.createFleet` reverts `ShipNotConstructed`. AI ships are marked constructed at allocation, so AI fleets aren't affected.
- **Test:** an unconstructed ship is rejected even after `syncShipCosts`.
- **Files:** `Fleets.createFleet:136-163` (no `constructed` check), `Ships.syncShipCosts` (permissionless, L-03) · **Confirmed**
- **What happens:** a zero-trait ship with a current `costsVersion` can join a fleet. It then can't be constructed while `inFleet`, but it carries tier-purchase rank kills.
- **Fix:** `if (!ship.shipData.constructed) revert` in Fleets. This doesn't touch Ships.

### ~~HA6-24 — Healing a 0-HP Ship Lets It Act Twice in One Round~~

**Status: Fixed 2026-10-16.**
- **New field:** `GameData.zeroedAfterMovingInRound` records the round in which a ship that had already moved was knocked to 0 HP. It's set in both `Game._setShipHPToZero` and the library's damage path.
- **Revive rule:** a revive in that same round marks the ship as moved again.
- **Unchanged:** a ship downed *before* moving keeps its move when repaired; that's an existing intended rule with an existing test.
- **Test:** move, then knocked to 0 by a real shot, then revived means the round ends instead of the ship getting a second turn.
- **Files:** `Game._setShipHPToZero` removes the ship from `shipMovedThisRound`; the heal in `SpecialEffectsLib._applyHullDelta` removes it from `shipsWithZeroHP` · **Plausible**
- **What happens:** the ship ends up in neither set, so `moveShip` accepts a second move.
- **Fix:** on a heal out of zero HP, add the ship to `shipMovedThisRound` (library-only).

### ~~HA6-25 — `setHealCapPercent(0)` Lets a Disabled Ship's Owner Stall the Round~~

**Status: Fixed 2026-10-16.** A heal only removes a ship from the zero-HP set when it ends above 0 HP.
- **Test:** with a heal cap of 0, the round completes and the downed ship's reactor timer ticks.
- **Files:** `Game.setHealCapPercent:199-202` accepts 0; `_applyHullDelta` removes the ship from `shipsWithZeroHP` even when HP stays 0.
- **What happens:** the ship is never ticked or destroyed, so the opponent times out.
- **Fix:** require `> 0`, or only remove the ship when the resulting HP is above 0.

### ~~HA6-26 — Mutual Full Disable: Creator Always Loses~~

**Status: Fixed 2026-10-16.** When neither side has an active ship, the game ends by score: higher score wins, a tie is a draw. This uses the same `_endGameByScore` helper as the score threshold.
- **Size:** byte-neutral, from passing the storage pointer and caching the player addresses.
- **Test:** a retreat that leaves both sides fully disabled at 0–0 ends in a draw.
- **File:** `Game._checkGameEndCondition:584-598`
- **What happens:** the creator side is checked first. If both sides are at 0 HP (Flak friendly fire, DroneSwarm), the first removal hands the joiner the win, even when it was the joiner's own ship that was removed.
- **Related:** AI `_hasAnyLiveShip` surrender has the mirror issue in vs-AI play.
- **Fix:** if neither side is active, end as a draw or decide by score.

### ~~HA6-27 — PvP Win Effects Farmable via Self-Play + Immediate `flee` (Latent)~~

**Status: Fixed 2026-10-16.** Win effects are PvE-only.
- **Removed:** the `PvPMatch` and `Tournament` win-effect lists, setters and dispatch, and the deploy module's PvPMatch/Tournament trigger grants.
- **Sizes:** PvPMatch −789 bytes, Tournament −743 bytes.
- **Tests:** both contracts' tests now assert there's no win-effect API.
- **Files:** `PvPMatch.onGameEnded:204-228`; `DeployAndConfig.ts:716-733` authorises DEC, ShipGrant and HealAboveFloor effects for PvPMatch.
- **What happens:** effects fire on forced ends too. Two accounts can farm DEC or free ships. This is inert while `winEffects` is empty.
- **Fix:** don't fire effects on forced ends. Revoke HealAboveFloor's PvP trigger.

### ~~HA6-28 — Forward-Only Graphs Can Strand a Run After a Win (Uncommitted Diff Makes This Reachable)~~

**Status: Not a bug, closed 2026-10-16.** Graph shape is a content-design concern, handled when authoring campaigns: don't create edges that can strand a run. The existing escape route (fleeing or retreating out of the run) is an acceptable emergency exit. No contract change.
- **Files:** `RoguelikeMatch._commitToNode`, `isFinalNodeAtStart = children.length == 0`; `RoguelikeNodeMap.addChild` (no DAG validation)
- **What happens:** with A→{B,C}, B→C, entering B locks C. Winning B isn't final, and the player can't advance. The only exit is `retreatRun`. Two-way edges used to be the escape. The seeded 34-edge campaign is unaffected, so this only matters for admin edits.
- **Fix:** treat "no unlocked child" as final, or reject such edges in `addChild`.

### ~~HA6-29 — Zero-Cost Sybil Lobby Squatting~~

**Status: Fixed 2026-10-16 (same-address part).**
- **Rejoin ban:** `timeoutJoiner` records the kicked address in `kickedFromLobby[lobbyId]`, and `joinLobby`/`acceptGame` revert `KickedFromLobby` for it in that lobby. Previously, if the creator hadn't committed a fleet, the kicked address could rejoin immediately and stall the creator again.
- **Existing deadline:** the lobby's `turnTime` (5 minutes to 24 hours), the same value as the in-game turn timer, already limits each stall.
- **Remaining:** fresh throwaway addresses can each still stall once per lobby, at the cost of a new address and a join transaction.
- **Size:** Lobbies 15.496 KiB.
- **Test (`test/Lobbies.test.ts`):** a kicked address can't rejoin that lobby but can join others.
- **Files:** `Lobbies.sol:396-456, 510-566`
- **What happens:** throwaway addresses join an open lobby and never commit, costing the creator up to `turnTime` (≤24h) per cycle. `kickCount` means nothing to throwaway addresses. `reservedJoiner` (1 UTC) is the only defence.
- **Fix:** a short fleet deadline for a joiner once the creator has committed, or deny re-joins by kicked addresses per lobby.

### ~~HA6-30 — AIEncounters Validates Placements Only at Write Time~~

**Status: Resolved 2026-10-16, by allowing mixed fleets rather than forbidding them.** The original suggestion (reject mixed-variant placements) was reversed by design.
- **Mixed AI fleets are now supported.** `Fleets.createFleet` enforces one-faction-per-fleet only for **player** fleets (`newFleet.owner != msg.sender`). AI fleets are the ones an orchestrator creates with itself as owner.
- **Why that's safe:** Game dispatches specials and faction abilities per ship variant, ShipAttributes works per ship, and AI decisions are pinned per ship (HA6-18).
- **Accepted:** the rest of this item (placements not checked against map zones or blocked tiles, configs edited after placement). Those fail loudly at match start and are admin-fixable.
- **Size:** Fleets 7.816 KiB.
- **Test (`test/SinglePlayerMatch.test.ts`):** a variant 1 + variant 2 AI fleet starts, each AI ship is pinned to its own faction's AI, and both take turns. `ShipCostsVersions.test.ts` still checks that mixed player fleets revert.
- **Frontend:** check it doesn't assume an enemy fleet is a single faction.
- **What's checked:** `_setMapPlacementInternal` checks only `mapExists`, hardcoded columns 13-16 and the config id.
- **What isn't:** the map's real zone bitmap, blocked tiles, single-variant-per-map, or later Maps/config edits.
- **Effect:** a node can become unstartable. It fails loudly, except the no-AI-variant case in HA6-12.
- **Fix:** at minimum, reject mixed-variant placements per map.

### ~~HA6-31 — `Renderers/RenderBody.sol` Wires Armor3 to the Armor2 Renderer~~ _(Fixed 2026-10-16: now `renderers[6]`.)_
- **File:** `contracts/Renderers/RenderBody.sol:25`: `renderArmor3 = IReturnSVG(renderers[5]);` should be `renderers[6]` · **Confirmed**
- **Effect:** heavy-armor V1 ships render as medium. V2 is correct. Cosmetic.

---

## Info

- ~~**`ShipGrantWinEffect` `_safeMint` re-enters mid-`_endGame`:**~~ _(Closed 2026-10-14 by the HA6-04 `_mint` switch.)_ the winner's callback runs before fleets are cleared, and inside `RoguelikeMatch.onGameEnded`. Neither has `nonReentrant`. Re-entering `enterCombatNode` looks self-defeating, but it isn't fully traced. A gas-burning receiver can also eat the settler's gas. `_mint` (HA6-04) closes both.
- **`RenderMetadata.tokenURI` doesn't escape names:** today every name source is fixed-charset or owner-controlled. Escape before any user-renaming feature ships.
- **Shiny is correlated with the special roll:** both use the same `randomBase` (`GenerateNewShip:146-152`). Balance/cosmetic.
- **`DroneStorefront.droneCoreTier` is `uint8`:** reverts beyond 255 tiers. Owner footgun.
- **AI slot reuse rewrites history:** `getShip(id)` for an ended game shows the slot's new occupant. This affects replay and lens views.
- **AI `_takeShipTurn` catch swallows all reverts:** persistent misconfiguration looks like silent Passing. Emit the reason.
- **`Game.setInitialHullPointsOverride`:** callable by the orchestrator at any time and doesn't sync `shipsWithZeroHP`. Trusted, start-only in practice.
- **Root Resupply node's `costCapOverride`:** can be skipped by walking straight to its child. The node kind is read live, so an admin `updateNode` changes the leave-gating of a node a run is standing on.
- **Tournament World ID:** a fixed `externalNullifier` makes a human's participation linkable across tournaments (privacy). The signal is correctly bound to `msg.sender`.
- **`Create2Deployer.deploy` is permissionless:** squatting deploys identical code. The deploy script should treat "code already at address" as success.
- **Dead or unused code:** `CadenceArchCaller` is unused, and `UniversalCredits.withdrawAll` is dead (no payable path).
- **`TutorialClaim`:** Sybil-able while `eligibilityProvider` is unset. Intentional for now.
- **`tx.origin`:** no uses anywhere, only comments in `UTCLotteryHook`.

---

## Uncommitted Diff Review (Roguelike Node-Clear Guard, 2026-10-13)

**Verdict: correct, and a real improvement. No new exploitable surface found.**

- **What it fixes:** it closes three bugs in the committed code, where `enterCombatNode` had no `activeGameId` check:
  - skipping a node, including the root right after `startRun`;
  - moving mid-match so the callback credits the wrong node;
  - starting a duplicate match on the current node.
- **Guard placement is correct:** the `activeGameId` check runs before the `target == current` early-return. Sibling-lock writes before the `isChild` revert are rolled back.
- **Caveats:**
  - Removing two-way edges removes the only escape from dead-end graphs (HA6-28).
  - It's an ABI break for `RoguelikeNodeMap`, `GameLens` and `RoguelikeMatch`. `GameLens` decodes `RoguelikeNode` from the map address fixed at construction, so the two must be redeployed together.
  - Web2 routes must drop backward moves.

---

## Carried Forward From `audit-2.md` (Still Open)

Full write-ups are in `docs/audit-2.md`. Search for the code.

- **H-08:** `Ships.purchaseWithFlow` referral transfer before state finality
- **HA5-01:** `Tournament.claimForfeitWin`/`resolveStalledMatch` walkover (see also HA6-08)
- ~~**HA5-02:** `UTCLotteryHook` unbounded `drawParticipants` (see also HA6-05)~~ _(Fixed 2026-10-15: ticket segments plus binary-search winner. Test: `test/UTCLotteryHookSwap.test.ts` "ticket segments and binary-search winner (HA5-02)", which resolves 300 participants in under 700k gas.)_
- **HA5-03:** `ShipAttributes._calculateMovement` `uint8`→`int8` casts
- **HA5-04:** void external calls without code-length checks
- **M-04:** `ShipAttributes` version arrays out-of-bounds
- **L-03:** `Ships.syncShipCosts` permissionless (see also HA6-23)
- **I-02:** owner centralisation (HA6-13 and HA6-22 are concrete instances)
- **I-08:** `Ships._update` state before `super._update`
- Admin/backend key separation for production deploy

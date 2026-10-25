# Void Tactics Smart Contract Security & Code Quality Audit

> **Status:** Pre-audit internal review  
> **Date:** 2026-06-12  
> **Auditor:** Internal (Claude Code)  
> **Scope:** All contracts in `contracts/`

---

## Executive Summary

This audit covers 20 production Solidity contracts plus supporting interfaces, mocks, and renderer contracts in the Void Tactics on-chain turn-based strategy game. The contracts implement ship NFTs (ERC-721), a game loop (Lobbies → Fleets → Game), a scoring map system, an ERC-20 token (UTC), a ship-modification marketplace (DroneYard), and an NFT renderer.

**Overall Risk Level: HIGH** — Several high-severity issues exist that can affect game integrity, NFT security, or funds. The most urgent are: insecure on-chain randomness, multiple unguarded public functions that let anyone overwrite game state, a fee/version overwrite bug in `ShipAttributes.setCosts`, permanently locked UTC in `DroneYard`, a flak damage mutation bug, missing negative-coordinate validation, and multiple debug functions left in production.

| Severity | Count |
|---|---|
| Critical | 4 |
| High | 8 |
| Medium | 8 |
| Low | 8 |
| Informational | 9 |

*(Counts updated 2026-07-16: H-07 was reclassified to Critical (see C-01 above), shifting the original 2/9 Critical/High split to 3/8; I-07 was later also reclassified to Critical (see C-04 above), moving Critical to 4 and Informational from 10 to 9. Does not include the Tournament/Maps addendum findings (T-01–T-05) added below, which post-date this snapshot.)*

---

## Critical Findings

### ~~C-01 — `RandomManager.fulfillRandomRequest` Does Not Verify the Request Exists~~

**File:** `contracts/RandomManager.sol`, lines 20–29  
**Severity:** Critical  
**Status:** Fixed 2026-08-26 (see Addendum below)

`fulfillRandomRequest(uint _requestId)` accepts any `_requestId` value and returns a `block.prevrandao`-derived value. There is no mapping of outstanding requests, no check that the ID was ever issued by `requestRandomness()`, and no single-use prevention. Any caller (including MEV bots or validators) can call `fulfillRandomRequest` with a forged ID to front-run ship construction and predict or manipulate the random outcome before `constructShip` is called.

**Why it matters:** Combined with C-02 below, this means randomness has no commit-reveal protection whatsoever. An attacker can observe the mempool for a `constructShip` call, front-run with `fulfillRandomRequest` using the same serial number to learn the output, and selectively abort their own construction if the result is unfavourable.

---

### ~~C-02 — Insecure On-Chain Randomness via `block.prevrandao`~~

**File:** `contracts/RandomManager.sol`, lines 14–28  
**Severity:** Critical  
**Status:** Fixed 2026-08-26 (see Addendum below — mitigated, not eliminated; residual risk documented there)

`requestRandomness()` and `fulfillRandomRequest()` both derive their output exclusively from `block.prevrandao` (formerly `DIFFICULTY`) and a simple incrementing counter. On PoS Ethereum and EVM-compatible chains using a similar mechanism, the block proposer knows `block.prevrandao` before committing the block, making it manipulable. A validator who is also a player (or colluding with one) can re-roll the random seed by skipping block proposals until a favorable value appears.

**Why it matters:** All ship trait randomness (accuracy, hull, speed, weapon, armor/shields, special ability, shiny flag, starting kill count, and ship name) flows through this function. An attacker can grind for max-stat ships, creating severe pay-to-win or cheat-to-win advantages. The comment `// TODO: Update to CadenceRandomConsumer` confirms this is a known placeholder, but the current contract is deployed.

---

### ~~C-03 — `Game.calculateShipAttributes` and `Game.calculateFleetAttributes` Are Unguarded Public State-Writing Functions~~

**File:** `contracts/Game.sol`, lines 247–274  
**Severity:** Critical  
**Status:** Fixed 2026-07-16 (see Addendum below)

`calculateShipAttributes(uint _gameId, uint _shipId)` is `public` with no access control and no check that the ship actually belongs to the specified game. Anyone can call it for any `(_gameId, _shipId)` pair and overwrite the in-game ship attributes (range, damage, hull points, movement, damage reduction) with freshly recalculated values from `ShipAttributes`.

**Why it matters:**
1. If a `ShipAttributes` version upgrade occurs mid-game, any player can re-roll their own ships' stats upward, breaking the game's snapshot model.
2. Attributes are intentionally snapshotted at game start so the `costsVersion` lock prevents in-flight changes; this function bypasses that snapshot entirely.
3. `calculateFleetAttributes(uint _gameId, uint[] memory _shipIds)` (line 267) has the same visibility and has no check that `_shipIds` belong to that game.

**Note (2026-07-16):** `games[_gameId].shipAttributes` (`Types.sol:154`) is scoped per-game, not global — so this finding was never about cross-game contamination (that part of the original concern was overstated; see L-01 note below). The real bug, confirmed and fixed, is that the write was unconditionally repeatable: nothing stopped this `public` function from being called again after the one-time snapshot `_initializeFleetAttributes` takes at game start, letting a live game's attributes be re-pulled from `ShipAttributes` mid-match if the admin changes its current version/costs. Visibility was intentionally left `public` (players are expected to self-serve this during fleet setup) — the fix is a snapshot-once guard, not access control. See the Addendum for the implementation.

---

### ~~C-04 — `Game.getGamesForPlayer` Has Unbounded Array Iteration~~

**File:** `contracts/Game.sol`, lines 1504–1508  
**Severity:** Critical  
**Status:** Already solved 2026-07-16 (was I-07, Informational — elevated to Critical per project owner). A bounded alternative already exists in the contract; no code change needed.

`getGamesForPlayer` calls `getGamesFromIds(playerGames[_player])`. `playerGames` is a dynamic array that grows without bound for every game a player participates in. A player with thousands of games will cause the view to run out of gas. There is no pagination.

**Note on classification (2026-07-16):** For the record — `getGamesFromIds`/`getGamesForPlayer` are `public view`, and neither is called internally by any state-changing function (checked: no other contract or function in `Game.sol` calls either). That means this can never block a real transaction — no fleet creation, move, or game-ending action depends on it — only the read-only "list my games" convenience getter itself degrades for high-activity accounts. From a pure exploitability standpoint this reads as Informational/Low. Recategorized to Critical per explicit instruction regardless — treating "the primary way the app surfaces a player's game history eventually stops working for veteran players" as a business-critical UX failure, a legitimate basis for severity even without a funds/access-control angle.

**Resolution (2026-07-16):** Initially built a new `getGamesForPlayerPaginated` (+`getPlayerGameCount`) getter to bound cost via `_offset`/`_limit` — but the project owner correctly pointed out this was solving an already-solved problem. `getGamesFromIds(uint[] memory _gameIds)` (the function `getGamesForPlayer` itself calls internally) takes a **caller-supplied** array, not one derived from unboundedly-growing storage — its cost is already bounded by whatever the caller chooses to pass. `getGamesForPlayer` is the only genuinely unbounded piece (it forces the contract to read a player's *entire* stored `playerGames` array), and it was never the only way to fetch a player's games.

The real fix requires no new contract code at all: pagination lives entirely off-chain. The frontend determines which/how many game ids to fetch per page — via the public `playerGames(address, uint)` index getter one at a time, via `GameStarted` event logs, or via a backend indexer — and calls the existing `getGamesFromIds` with just that bounded batch. `getGamesForPlayer` remains in the contract for convenience/smaller-scale callers; high-activity accounts (or any frontend that wants a hard cost ceiling) should use `getGamesFromIds` with a caller-chosen id subset instead. The paginated-getter addition was reverted in full (contract and test changes both backed out); `Game.sol` is back to its prior size (23.890 KiB) and the full suite (301 tests) passes unchanged.

---

## High Severity Findings

### ~~H-01 — `ShipAttributes.setCosts` Increments Version Then Overwrites It~~

**File:** `contracts/ShipAttributes.sol`, lines 342–345  
**Severity:** High  
**Status:** Fixed 2026-07-16

```solidity
function setCosts(Costs memory _costs) external onlyOwner {
    costs.version++;
    costs = _costs;  // ← overwrites costs.version with whatever _costs.version is
}
```

The function increments `costs.version`, then replaces the entire struct with the caller-supplied `_costs`. If the caller passes a `_costs.version` that is stale, zero, or matches the previous version, the version field will be wrong. All ships use `costsVersion` to detect staleness; a wrong version will either permanently lock all ships out of fleets (`ShipCostVersionMismatch`) or allow ships with outdated cost calculations to enter fleets silently.

**Fix:** `newVersion` is now computed from storage (`costs.version + 1`) *before* the struct is overwritten, and reasserted onto `costs.version` after `costs = _costs`, so the caller-supplied `_costs.version` is discarded entirely — it's no longer possible to corrupt the version by passing a stale/zero/duplicate value. This also resolves M-01 below, which is the same bug. `test/ShipCostsVersions.test.ts` and `test/Ships.test.ts` (104 tests) pass unchanged.

**Why it matters:** The costs-version system is the primary guard preventing ships with old (potentially underpriced) stats from entering competitive games. Corrupting it breaks fleet validation for all subsequent lobbies.

---

### ~~H-02 — `Game.moveShip` Does Not Validate Negative Grid Coordinates~~

**File:** `contracts/Game.sol`, lines 527–530  
**Severity:** High  
**Status:** Fixed 2026-07-16 (fixed together with M-06 below, same root cause)

```solidity
if (_newRow >= GRID_HEIGHT || _newCol >= GRID_WIDTH)
    revert InvalidMove();
```

Because `_newRow` and `_newCol` are `int16`, a player can pass negative values (e.g., `_newRow = -1`). The comparison `int16(-1) >= int16(11)` is `false`, so the bounds check passes. The ship is then placed in `game.grid[-1][-1]`, which in Solidity maps to a valid but unintended storage slot (a mapping with key `type(int16).max` for two's-complement). Similarly, `_placeShipOnGrid` (line 229) only checks `>= GRID_HEIGHT` and `>= GRID_WIDTH`, missing the lower-bound check.

**Why it matters:** A player can teleport ships to invisible negative-coordinate cells, escaping opponent fire while still being able to shoot, effectively making them invincible for the rest of the game.

**Fix:** Added `_newRow < 0 || _newCol < 0` to `moveShip`'s bounds check and `_row < 0 || _column < 0` to `_placeShipOnGrid`'s (M-06), alongside the existing upper-bound checks. Full test suite (301 tests) passes unchanged; no contract-size regression.

---

### ~~H-03 — FlakArray Mutates `flakStrength` Across Targets, Nerfing Subsequent Hits~~

**File:** `contracts/Game.sol`, lines 1069–1083  
**Severity:** High  
**Status:** Fixed 2026-07-16

```solidity
flakStrength = uint8(
    flakStrength -
        ((uint16(flakStrength) * damageReduction) / 100)
);
```

`flakStrength` is a value parameter passed into `_processFlakArrayForFleet`. The damage reduction is applied to `flakStrength` and the result is written back into the same variable. Each subsequent target in the loop therefore receives progressively reduced damage rather than the original `flakStrength` minus that target's own damage reduction. The second fleet call in `_performFlakArray` further inherits the already-reduced value.

**Why it matters:** The intended behaviour is "apply each target's damage reduction to the base flak strength." The actual behaviour penalises later targets (and the second fleet) with cumulative reductions. In edge cases where all targets have high damage reduction, the effective damage approaches zero for anything hit after the first target.

**Fix:** The per-target reduced damage is no longer written back into the `flakStrength` parameter. A naive fix (a new `uint8 damage` local) hit `CompilerError: Stack too deep` — this function is already at the stack-depth limit under `viaIR: false` (see `hardhat.config.ts`). Instead, the already-in-scope `damageReduction` variable's slot is reused to hold the computed damage once it's no longer needed for the reduction calculation itself, so the fix adds zero new stack slots and zero bytecode-size risk. `flakStrength` (the base value) is now read-only for the rest of the loop, so every target's damage is computed independently from the true base value, matching the intended behaviour. Full suite (301 tests) passes; no contract-size regression.

---

### ~~H-04 — `DroneYard` Has No Withdrawal Function; UTC Accumulates and Is Permanently Locked~~

**File:** `contracts/DroneYard.sol`, lines 113–163  
**Severity:** High  
**Status:** Fixed 2026-07-16

`modifyShip` transfers UTC tokens from the caller to `address(this)`, but `DroneYard` has no `withdraw`, no owner, no `Ownable`, and no rescue function. All modification fees are permanently locked in the contract with no mechanism to recover them.

**Why it matters:** Every ship modification permanently burns UTC tokens from the economy. If this is unintentional, it is a financial loss; if it was intended as a burn mechanism, the effect is undocumented and constitutes an undisclosed economic parameter.

**Fix:** `DroneYard` now inherits `Ownable` (deployer becomes owner via the existing Ignition deploy flow, same pattern as `Maps`/`ShipAttributes`/`GameResults`), and a new `onlyOwner` `withdraw(address _to)` sweeps the contract's full UTC balance to `_to`, emitting `Withdrawn(to, amount)`. Contract is tiny (6.6 KiB vs. the 24 KiB limit) so this carried no size risk. Full suite (301 tests) passes unchanged.

---

### ~~H-05 — `shipBreaker` Does Not Check `inFleet` Before Burning~~

**File:** `contracts/Ships.sol`, lines 701–739  
**Severity:** High  
**Status:** Fixed 2026-07-16

`shipBreaker` checks ownership (`s.owner != msg.sender`) but does **not** check `s.shipData.inFleet` before marking the ship destroyed and calling `_burn`. The `_update` override does check `inFleet` and would revert on the burn, so normally this is blocked — but only because the ERC-721 override is the last line of defence. If a ship is in a game, calling `shipBreaker` with its ID will revert at `_burn`, which is correct, but `s.shipData.timestampDestroyed = block.timestamp` writes before `_burn`. Because `_burn` reverts, the timestamp write is also reverted; however, this pattern is fragile and relying on the EVM revert cascade from `_burn` as the guard is a design smell flagged in the code itself (line 711 TODO).

**Why it matters:** Any future change to burn logic (e.g., moving the inFleet check) could leave ships permanently marked as `timestampDestroyed` while still in a live fleet/game, breaking the game for both players.

**Fix:** `shipBreaker` now checks `s.shipData.inFleet` itself (reusing the existing `ShipInFleet` error `_update` already throws) right after the ownership check, before `timestampDestroyed` is ever written — so the guard no longer depends on `_burn`'s revert to undo a state write that shouldn't have happened in the first place. Ships.sol was already tight (23.749 KiB); this added 47 bytes, landing at 23.796 KiB, still under the 24 KiB limit. Full suite (301 tests) passes unchanged.

---

### ~~H-06 — `Maps.getScoreAndZeroOut` Is `public` With No Access Control~~

**File:** `contracts/Maps.sol`, lines 602–612  
**Severity:** High  
**Status:** Fixed 2026-07-16

```solidity
function getScoreAndZeroOut(
    uint _gameId, int16 _row, int16 _col
) public returns (uint8) {
```

This function zeros out a `onlyOnce` scoring tile for the given game. Any external caller can call it to drain scoring tiles from any live game, preventing both players from earning objective points.

**Why it matters:** An attacker (or losing player) can zero out all scoring tiles immediately after a game starts, ensuring the game can only end by ship destruction, bypassing the map-objective victory condition entirely.

**Fix:** Added the same `msg.sender != gameAddress && msg.sender != owner()` guard (reverting `NotGameContract()`) already used by `applyPresetMapToGame`/`applyPresetScoringMapToGame` in this same contract. `getScoreAndZeroOut` is only ever called from `Game._handleEndOfRound`, and no test calls it directly, so this is a drop-in restriction with no behavioral change for legitimate callers. Maps.sol has plenty of headroom (12.967 KiB vs. the 24 KiB limit). Full suite (301 tests) passes unchanged.

---

### H-07 — `Game.flee` Is Missing a `_requireGameExists` Check

**File:** `contracts/Game.sol`, lines 1358–1380  
**Severity:** High  
**Status:** Deferred 2026-07-16 — `Game.sol` is too close to the 24 KiB contract-size limit to take the fix right now; see note below. Not struck through — still open, revisit when there's headroom.

The commented-out check (lines 1360–1361 with "TODO: I think this is fine") means `flee` operates on a default-zeroed `GameData` storage reference when called with a non-existent `_gameId`. When `game.metadata.winner == address(0)` and `game.metadata.creator == address(0)`, the second guard (`msg.sender != creator && msg.sender != joiner`) will revert with `NotInGame` for any non-zero address. However, a call with a non-existent game ID and `address(0)` as a player would pass (since `address(0) == address(0)`) and trigger `_endGame(0, address(0), address(0))`, writing garbage winner state to game slot 0.

**Why it matters:** Silent execution on non-existent game IDs can corrupt game slot 0, emit misleading `GameUpdate` events, and interfere with `gameResults.recordGameResult` if the draw path is ever altered. In practice, exploiting this specific path requires `msg.sender == address(0)` (no known private key can transact from there), so live exploitability is low — but the guard should still exist as defense-in-depth and to remove the dead TODO comment.

**Deferral note (2026-07-16):** Proposed fix, not yet applied: replace the commented-out dead check with a real call to the existing `_requireGameExists(_gameId)` helper (already shared by 6 other call sites in this file — `getGame`, `getAllShipPositions`, `moveShip`, `endGameOnTimeout`, etc.), which should cost only the small per-call-site overhead rather than duplicating the check body. As of this note, `Game.sol` is at 23.879 KiB against the 24 KiB (24,576-byte) limit — roughly 124 bytes of headroom. Deliberately holding off on spending any of that margin on this fix until we've either found more size savings elsewhere or confirmed the margin can absorb it safely alongside other pending fixes.

---

### H-08 — `Ships.purchaseWithFlow` Referral Transfer Occurs Before State Finality

**File:** `contracts/Ships.sol`, lines 163–165  
**Severity:** High  
**Status:** Deferred 2026-07-16 — self-referral half is accepted as intended behavior; the revert-on-receive half is confirmed pure griefing/DoS (no funds at risk), deferring a fix. Not struck through — still open, revisit later.

In `purchaseWithFlow`, `_processReferral` executes a raw ETH transfer via `.call{value: referralAmount}("")` inside the same function after minting. If the referrer is a contract and reverts on receive, the entire `purchaseWithFlow` transaction reverts, meaning the buyer loses their ships. There is also no prevention of a buyer naming themselves as `_referral`, allowing them to reclaim a portion of their own payment (self-referral).

**Why it matters:** A malicious referral address can grief buyers by refusing ETH. Any buyer can self-refer to get a discount once their referralCount crosses a tier threshold. Both are exploitable with zero cost.

**Deferral note (2026-07-16):**
- **Self-referral:** accepted as acceptable/intended — not a bug to fix. Buyers being able to reclaim a portion of their own payment via self-referral once their `referralCount` crosses a tier threshold is fine as-is.
- **Revert-on-receive griefing:** confirmed the actual blast radius is narrower than "the buyer loses their ships" suggests. `purchaseWithFlow` is a single `external payable nonReentrant` call; if `_processReferral`'s `.call{value: referralAmount}("")` fails, `_processReferral` reverts, which unwinds the *entire* transaction — the ship mints, the `amountPurchased` update, and the ETH transfer all roll back atomically (EVM revert semantics mean the buyer's `msg.value` is never actually taken on a reverted call). Net effect: no ships created, no funds charged, buyer only loses the gas spent on the failed attempt. So this is pure griefing/DoS, not a fund-loss bug — a malicious referral address can be handed out (e.g. via a referral link) to make every purchase through it fail, with no way for the buyer to know in advance. Deferred rather than fixed for now; a future fix would decouple the referral payout from the mint (e.g. pull-payment/credit balance for referrers instead of a synchronous push transfer) so a hostile referrer can only forfeit their own payout, not block the buyer's purchase.

---

## Medium Severity Findings

### ~~M-01 — `ShipAttributes.setCosts` Version Increment Is Silently Overwritten~~

**File:** `contracts/ShipAttributes.sol`, lines 342–344  
**Severity:** Medium  
**Status:** Fixed 2026-07-16 — same bug as H-01, fixed together (see H-01 above).

`costs = _costs` copies the entire `Costs` struct including its `version` field from the caller. The `costs.version++` on line 343 is therefore meaningless unless the caller passes `_costs.version == (old_version + 1)`. The intended auto-increment is silently defeated.

---

### ~~M-02 — `Game._performRepairDrones` Has a `uint8` Addition Overflow Risk~~

**File:** `contracts/Game.sol`, lines 974–978  
**Severity:** Medium  
**Status:** Fixed 2026-07-16

```solidity
uint8 newHullPoints = targetAttributes.hullPoints + repairStrength;
```

If `hullPoints` is close to 255 and `repairStrength` is large, this addition will wrap around. Because both operands are `uint8`, the addition is done in `uint8` arithmetic by the compiler. Solidity ≥0.8 will catch this and revert, but the revert error is opaque (`Panic(0x11)` arithmetic overflow) and there is an acknowledged comment at line 982 warning of fragility.

**Why it matters:** A RepairDrones use on a ship with 250/255 HP and a repairStrength of 40 will revert the entire `moveShip` transaction, effectively locking the player out of their turn if they attempt the repair. The maxHullPoints cap (lines 975–977) is checked **after** the overflowing addition.

**Fix:** Considered "reorder the cap check to happen before the addition" (compute `headroom = maxHullPoints - hullPoints`, compare, then add) but rejected it — that trades one checked `uint8` addition for a checked subtraction *plus* a checked addition in the safe branch, since Solidity inserts overflow-check machinery for every checked arithmetic op regardless of whether it can prove the op safe; that reorder would have cost more bytecode, not less. Instead, the sum is now computed in `uint16` (max 255+255=510, which always fits) inside an `unchecked` block — since the addition provably cannot overflow at that width, `unchecked` just strips out dead-weight revert machinery the compiler couldn't prove unreachable on its own, rather than skipping a real safety check. The final `uint8(newHullPoints)` truncation only happens in the branch where we've already confirmed it fits under `maxHullPoints`. Net effect: bug fixed *and* `Game.sol` shrank by 15 bytes (23.879 → 23.864 KiB). Full suite (301 tests) passes unchanged.

---

### ~~M-03 — `UniversalCredits` Has `hardhat/console.sol` in Production~~

**File:** `contracts/UniversalCredits.sol`, line 4  
**Severity:** Medium  
**Status:** Fixed 2026-07-16

```solidity
import "hardhat/console.sol";
```

This is not commented out (unlike `Ships.sol` where it is commented). On a non-Hardhat network the import resolves to a no-op library, but it adds unnecessary bytecode weight and signals the contract was not prepared for production deployment. If the `console.sol` contract is not deployed on the target chain, all calls to `UniversalCredits` could fail at deployment.

**Fix:** Removed the import (confirmed zero `console.*` calls anywhere in the file, so it was pure dead weight). Contract size unchanged (2.787 KiB before and after) — an unused `console.sol` import doesn't add runtime bytecode when nothing calls it — but this closes the production-readiness signal and the (theoretical) deployment-risk concern outright. Full suite (301 tests) passes unchanged.

---

### ~~M-04 — `ShipAttributes` Attribute Version Arrays Can Be Out-of-Bounds Indexed~~

**File:** `contracts/ShipAttributes.sol`, lines 120–155; `contracts/GenerateNewShip.sol`, lines 88–109  
**Severity:** Medium  
**Status:** Fixed 2026-09-20 (previously marked Won't fix on 2026-07-16 — reopened by explicit decision during the per-variant attributes redesign).

**Fix:** `ShipAttributes.setVariantAttributes` and `setCosts` now validate array lengths on publish and revert `InvalidArrayLength()` otherwise: `guns`/`armors`/`shields`/`specials` (and the cost tables `mainWeapon`/`armor`/`shields`/`special`) must have all 8 enum slots, and the trait-tier arrays (`foreAccuracy`/`hull`/`engineSpeeds`, cost `accuracy`/`hull`/`speed`) must have 3. A malformed table can therefore never go live. Reads for a never-configured variant now revert the named error `VariantNotConfigured(variant)` instead of an array-out-of-bounds panic. See `docs/ship-costs-and-attributes-runbook.md`. Original finding text follows.

`calculateShipAttributes` indexes `attributesVersions[version].guns[uint8(_ship.equipment.mainWeapon)]` without checking array length. `MainWeapon`, `Armor`, `Shields`, and `Special` enums each have 8 values (including 4 `future*` placeholders). The `setAllAttributes` function takes arbitrary-length arrays. If a version is deployed with only 4 gun entries (current default) and a ship has equipment enum value 4–7 (`future1–future4`), the call panics with an out-of-bounds access. `GenerateNewShip` uses `% 4` for weapon generation, but `customizeShip` accepts arbitrary `Equipment` values.

---

### ~~M-05 — `Lobbies.createLobby` and `joinLobby` Accept Excess ETH With No Refund~~

**File:** `contracts/Lobbies.sol`, lines 262–264, 329–331  
**Severity:** Medium  
**Status:** Fixed 2026-07-16

The fee check is `if (msg.value < additionalLobbyFee) revert InsufficientFee()`. Any ETH sent over `additionalLobbyFee` is silently retained by the contract. Players who over-pay (by mistake or via frontend error) permanently lose the difference.

**Fix:** Both checks now require an exact fee (`msg.value != additionalLobbyFee`) instead of a minimum, so overpayment reverts up front with `InsufficientFee()` rather than being silently kept. All existing tests already pay the exact fee (`parseEther("1")` matching `additionalLobbyFee`), so this is a drop-in tightening with no behavior change for legitimate callers.

Also closed two related gaps in the same functions where the fee branch is skipped entirely and `msg.value` wasn't validated at all: the UTC-reservation path in `createLobby` (`_reservedJoiner != address(0)`, which pays via UTC and needs no ETH) and the free-lobby path in both `createLobby` and `joinLobby` (`activeLobbiesCount < freeGamesPerAddress`), plus `joinLobby`'s reserved-lobby path (joiner owes no ETH fee — the creator already paid the UTC reservation fee). All four now revert `InsufficientFee()` on any nonzero `msg.value` when no fee is actually owed. Full suite (301 tests) passes unchanged; Lobbies.sol has plenty of headroom (14.677 KiB vs. the 24 KiB limit).

---

### ~~M-06 — `Game._placeShipOnGrid` Does Not Validate Negative Coordinates~~

**File:** `contracts/Game.sol`, lines 229–233  
**Severity:** Medium  
**Status:** Fixed 2026-07-16 — see H-02 above.

```solidity
if (
    _row >= GRID_HEIGHT ||
    _column >= GRID_WIDTH ||
    game.grid[_row][_column] != 0
) revert InvalidMove();
```

`int16` row/column values are not lower-bound-checked. Ships could be initially placed at negative coordinates if the `Fleets.createFleet` position validation is bypassed or if there is a future code path that calls `_placeShipOnGrid` directly.

---

### ~~M-07 — `Game.endGameOnTimeout` Winner-Determination Is Biased~~

**File:** `contracts/Game.sol`, lines 1335–1354  
**Severity:** Medium  
**Status:** Not a bug (2026-07-16) — confirmed working as designed, no fix needed.

```solidity
_endGame(_gameId, msg.sender, game.turnState.currentTurn);
```

The caller of `endGameOnTimeout` receives the win. This creates a front-running opportunity: if both players notice the timeout simultaneously, whoever broadcasts first wins. On high-latency chains or during congestion, the losing player of a close game can time their `endGameOnTimeout` call to arrive slightly after the opponent's turn starts, then immediately invoke timeout at the block after the turn time expires.

**Resolution (2026-07-16):** Re-examined the actual guard at line 1374 — `if (msg.sender == game.turnState.currentTurn) revert InvalidMove();` — which means the player whose turn timed out can *never* call this function to declare themselves the winner; only the other (waiting) player can call it, and doing so is exactly how they're meant to claim victory over an unresponsive opponent. That's the intended design (confirmed with the project owner), not a bug: "if player 1 has run out of time, player 2 can seize victory by calling this function" is the feature working correctly, not a winner-determination flaw.

The narrower residual case the original write-up was gesturing at — transaction-ordering nondeterminism right at the exact timeout boundary (a legitimate in-time move and an opponent's timeout call landing in the same block/close succession) — is an inherent property of any block-time-based turn timer, not something specific to this contract's logic, and isn't being tracked as a separate issue.

---

### ~~M-08 — `Maps.updatePresetMap` Cannot Fully Clear Old Tiles~~

**File:** `contracts/Maps.sol`, lines 135–198  
**Severity:** Medium  
**Status:** Not a bug (2026-07-16) — confirmed working as designed, no fix needed.

`updatePresetMap` calls `_getPresetMap(_mapId)` to get current blocked positions, then clears them before setting new ones. However, if a prior update only set a subset of tiles and those mappings have been manually altered via `setBlockedTile`, the "clear old positions" step may be incomplete, leaving stale blocked positions for games that use that preset.

**Resolution (2026-07-16):** Re-examined `_getPresetMap` (`Maps.sol:380-408`) and `_getPresetScoringMap` (`Maps.sol:457-492`) — neither reads a remembered/cached list of positions. Both do a full brute-force scan of all 187 grid cells (`GRID_HEIGHT * GRID_WIDTH`), checking `presetBlockedMaps[_mapId][row][col]` / `presetScoringMaps[_mapId][row][col]` directly for every cell. That means `updatePresetMap`'s "clear old positions" step always finds and clears *every* tile currently `true` for that map ID at call time, live — it can't go stale because it isn't relying on history in the first place.

The finding's second claim — that `setBlockedTile` can desync this — doesn't hold up either: `setBlockedTile(_gameId, ...)` writes to `blockedTiles[_gameId][row][col]`, a completely separate mapping from `presetBlockedMaps[_mapId][row][col]`. It mutates per-*game* live-tile state, not preset-map storage, so it structurally cannot affect a preset map's blocked tiles at all. The "clear" step is provably complete by construction; no fix needed.

---

## Low Severity Findings

### L-01 — `Game.calculateShipAttributes` Does Not Validate Ship-to-Game Membership

**File:** `contracts/Game.sol`, lines 247–274  
**Severity:** Low  
**Status:** Won't fix (2026-07-16) — confirmed no impact beyond wasted gas; accepted as-is, not planned. Not struck through — left open for visibility, but no further action intended.

There is no check that the `_shipId` belongs to the game identified by `_gameId`.

**Note (2026-07-16):** Since `games[_gameId].shipAttributes` (`Types.sol:154`) is a mapping scoped inside that game's own storage struct (not a global `shipId => Attributes` mapping), calling this with an unrelated `_shipId` only ever writes into that game's own unused slot for that id — it cannot reach into or corrupt a *different* live game's data. The practical risk is narrower than "rewritten into a live game" implies. Still worth adding the membership check as defense in depth, but it is not required for the C-03 fix (see Addendum), which closes the actual exploit path (re-rolling a ship's own attributes mid-match) via a snapshot-once guard instead.

**Resolution (2026-07-16):** Confirmed with the project owner this is accepted as gas-waste-only, not a security risk. Since the C-03 fix added a snapshot-once guard (`if (attributes.version != 0) revert`), a stray call against a `_shipId` not actually in `_gameId` can only ever write into that ship's still-empty (`version == 0`) slot in that game's storage. Nothing in the game's logic ever reads `game.shipAttributes[x]` for an `x` that isn't an actual participant of that game (mappings aren't enumerable, so there's no iteration path that could pick up the stray entry either), so the write is permanently inert — it just costs the caller an SSTORE for no effect. No fix planned.

**Reopened 2026-09-12 — the "nothing ever reads a stray entry" premise is false.** `Game._performShoot` (lines 770-837) reads `game.shipAttributes[targetShipId]` and `game.shipPositions[targetShipId]` for an attacker-chosen `targetShipId` with no check that it belongs to either fleet in `_gameId` — directly contradicting this finding's own resolution text. Combined with this same function's missing target-status check, this is no longer inert: see the new **Addendum — Hostile-Actor Full Audit Sweep (2026-09-12)**, finding **HA2-01**, for the full exploit chain (a live match can be permanently frozen). Do not treat this finding's "won't fix" status as current.

---

### ~~L-02 — `Fleets.removeShipFromFleet` Reads Cost After Clearing `inFleet`~~

**File:** `contracts/Fleets.sol`, lines 194–198  
**Severity:** Low  
**Status:** Not a bug, hardened anyway (2026-07-16) — see below.

```solidity
ships.setInFleet(_shipId, false);

Ship memory ship = ships.getShip(_shipId);
fleet.totalCost -= ship.shipData.cost;
```

`setInFleet(false)` is called first. Then `getShip` is called to read `ship.shipData.cost`. If the cost changed between fleet entry and removal, `fleet.totalCost` will underflow or become incorrect. In Solidity ≥0.8 this will revert.

**Resolution (2026-07-16):** Traced this in the context of a related question — whether bumping `ShipAttributes.setCosts` while lobbies are open/players are selecting fleets could cause problems. It can't, for two reasons: (1) fleet selection is atomic — `Fleets.createFleet` validates every ship's `costsVersion` and computes `totalCost` in one transaction, so there's no on-chain "in-progress" fleet state that could straddle a costs-version change; a stale-versioned `createFleet` call just reverts cleanly with `ShipCostVersionMismatch`. (2) A ship's cost is only ever writable while `inFleet == false` — both `Ships._setCostOfShip` and `DroneYard.modifyShip` explicitly revert with `ShipInFleet` if the ship is currently in a fleet. So a ship's cost is frozen for its *entire* fleet membership, in lobby or in-game.

That means L-02's premise — "if the cost changed between fleet entry and removal" — can't occur: `removeShipFromFleet` is only ever called from `Game.sol` (ship destroyed/retreated mid-game; pre-game lobby cancellation uses `clearFleet`, which doesn't touch cost at all), and by that point the ship has been continuously `inFleet` since it joined, so its cost is guaranteed unchanged.

Reordered anyway as free insurance: the cost is now read *before* `setInFleet(false)` rather than after, so this code no longer depends on an invariant enforced elsewhere in the codebase — if a future change ever allowed cost mutation while `inFleet`, this function wouldn't silently break. Contract size unaffected (Fleets.sol: 7.140 KiB, unchanged). Full suite (301 tests) passes unchanged.

---

### L-03 — `Ships.syncShipCosts` Is Fully Permissionless and Can Corrupt Storage for ID 0

**File:** `contracts/Ships.sol`, lines 354–358  
**Severity:** Low  
**Status:** Won't fix (2026-07-16) — confirmed inert on-chain, residual risk is off-chain-only; accepted as-is, not planned. Not struck through — left open for visibility, but no further action intended.

The NatSpec warns "invalid ids corrupt storage." Calling `syncShipCosts` on ship ID 0 will silently write to the default ship struct without any token existing.

**Resolution (2026-07-16):** Traced the actual blast radius. `ships[0]` is a real, addressable storage slot (an all-zero `Ship` struct) even though no ship is ever minted with ID 0 (`shipCount` is incremented *before* first use, so the first real ship is ID 1). `syncShipCosts([0])` runs `_setCostOfShip(0)`, which doesn't revert — it writes `ships[0].shipData.costsVersion` and `.cost`, computed from an all-default/zeroed ship, with no other side effects.

Checked every place in the codebase that treats a ship ID as possibly nonexistent: `DroneYard` and `ShipAttributes` both check `ship.id == 0` → revert; `Game.sol` does the same; `Fleets.createFleet` checks `ship.owner != _owner` → revert (`ships[0].owner` is `address(0)`, never a real caller). `_setCostOfShip` never writes `.id` or `.owner` — only `.costsVersion`/`.cost` — so every one of those existence checks still correctly identifies "ship 0 doesn't exist" and reverts *before* any code would act on the corrupted fields. ERC721's own `ownerOf(0)` is backed by a separate OpenZeppelin-internal mapping, also untouched, so it still correctly reverts as a nonexistent token. No funds at risk, no access-control bypass, no way to actually use "ship 0" for anything on-chain.

The one real (if modest) residual risk is off-chain: `getShip(0)` is a plain view function with no existence check, so a naive indexer/frontend/bot that reads `.cost`/`.costsVersion` without first checking `.id == 0` could display or act on meaningless data. It's also an easy accidental footgun — automation that loops `syncShipCosts([0, 1, 2, ...])` starting from 0 instead of 1 triggers this for free, no attacker required. Accepted as-is: not worth an on-chain guard for a purely off-chain-consumer hygiene concern, but worth this write-up so it isn't rediscovered as "corrupts storage" without the full context of why that's inert on-chain.

---

### ~~L-04 — `Game.flee` Allows Calling After a Draw (Winner Is `address(0)`)~~

**File:** `contracts/Game.sol`, lines 1358–1380  
**Severity:** Low  
**Status:** Fixed 2026-07-16 — and found to be more serious than originally scoped; see below.

After a draw, `game.metadata.winner` is set to `address(0)`. The guard `if (game.metadata.winner != address(0))` then passes on a finished drawn game, allowing `flee` to trigger a second `_endGame` call. The `GameResults` contract will revert on `GameAlreadyRecorded`, but fleet-removal code may still execute on already-cleared fleets.

**Root cause (2026-07-16):** `game.metadata.winner`'s doc comment claims "zero address if game is not over," but `_endGame` sets `winner = address(0)` for a draw too (`_endGame(_gameId, address(0), address(0))` in `_handleEndOfRound`'s scoring logic). So `winner == address(0)` is genuinely ambiguous between "never ended" and "ended in a draw" — there's no way to fix `flee`'s guard by only touching `flee`, since the field it reads can't carry the information needed.

**Wider impact found while fixing this:** `moveShip`'s own "game has ended" gate (`Game.sol:497`, `if (game.metadata.winner != address(0)) revert InvalidMove();`) has the exact same bug — meaning after a draw, players could keep making real moves (attacking, moving ships) in a game that had already ended, not just retrigger `flee`. This is a more serious version of the same root cause than the original finding scoped.

**Fix:** Added `bool ended` to `GameMetadata` (`Types.sol:119-129`), set unconditionally in `_endGame` alongside `winner`. It packs into the same 32-byte storage slot as `address winner` (20 + 1 bytes), so it doesn't cost a new storage slot. Both `flee` and `moveShip` now check `game.metadata.ended` instead of `winner != address(0)` for "has this game ended," leaving `winner` to mean only "who won" (still `address(0)` for an ongoing game or a draw, which is fine now that `ended` carries the disambiguating bit). Considered a zero-new-storage alternative (checking `creatorScore == joinerScore && creatorScore >= maxScore` as a proxy for "the draw path ran") but rejected it as too fragile — it would silently break if the scoring logic ever changed shape, whereas `ended` is self-explanatory at every call site. Cost: `Game.sol` grew by 70 bytes (23.864 → 23.935 KiB), leaving ~65 bytes of headroom under the 24 KiB limit. Full suite (301 tests) passes unchanged.

---

### ~~L-05 — `ShipAttributes` Has No Events for Version or Cost Changes~~

**File:** `contracts/ShipAttributes.sol`  
**Severity:** Low  
**Status:** Fixed 2026-07-16

`setCosts`, `setCurrentAttributesVersion`, and `setAllAttributes` change critical game parameters with no emitted events. Off-chain clients and indexers have no way to learn when attributes or costs changed without polling.

**Fix:** Added three events — `CostsSet(uint16 version)`, `CurrentAttributesVersionSet(uint16 version)`, `AttributesVersionCreated(uint16 version)` — emitted at the end of `setCosts`, `setCurrentAttributesVersion`, and `setAllAttributes` respectively. `ShipAttributes.sol` has ample headroom (12.031 → 12.194 KiB against the 24 KiB limit), so no bytecode-budget concerns here. Full suite (301 tests) passes unchanged.

---

### ~~L-06 — `Ships.claimFreeShips` Does Not Increment `amountPurchased`~~

**File:** `contracts/Ships.sol`, lines 611–631  
**Severity:** Low  
**Status:** Not a bug (2026-07-16) — confirmed intentional: free ships are soulbound until the player has purchased at least 10 ships. No fix needed.

`amountPurchased[msg.sender]` is never incremented in `claimFreeShips`. The transfer guard in `_update` requires `amountPurchased[oldOwner] >= 10`. A player who only ever used `claimFreeShips` can never transfer their ships. This may be intentional (free ships are soulbound) but is not documented and differs from ships obtained via `purchaseWithFlow` or `createShips`.

**Resolution (2026-07-16):** Confirmed with the project owner — this is intended design, not a bug. Free ships are meant to stay soulbound (non-transferable) until the player has purchased at least 10 ships via `purchaseWithFlow`/`createShips`, at which point `amountPurchased` crosses the `_update` threshold and *all* their ships (free and purchased) become transferable together. `claimFreeShips` correctly leaving `amountPurchased` untouched is exactly what enforces that.

---

### ~~L-07 — `ShipPurchaser._processReferral` Does Not Prevent Self-Referral~~

**File:** `contracts/ShipPurchaser.sol`, lines 54–80  
**Severity:** Low  
**Status:** Not a bug (2026-07-16) — self-referral confirmed acceptable by design; no separate UTC-drain vector found. No fix needed.

`purchaseWithUTC` does not check `_referral != msg.sender` or `_referral != _to`. A buyer can pass their own address as referral and — once `referralCount[self] >= 1000` — receive a 10% discount on all future purchases funded from the protocol's own UTC balance.

**Resolution (2026-07-16):** Self-referral itself is accepted as intended (same conclusion as H-08's self-referral half). Separately traced whether the referral mechanism allows draining UTC beyond what's deposited — it doesn't:

- `_processReferral` is `internal`, reachable only from `purchaseWithUTC`, and only *after* `universalCredits.transferFrom(msg.sender, address(this), price)` has already succeeded (`ShipPurchaser.sol:70-73`) — every payout is preceded by a real, full-price deposit in the same transaction.
- The payout percentage is capped at `referralPercentages = [0, 10, 20, 35, 50]` — 50% maximum, at the top volume tier. There's no path to exceed 50% of that transaction's own price back.
- The payout is plain OpenZeppelin `ERC20.transfer` (no recipient hook), so no reentrancy vector via a malicious `_referral` contract; `purchaseWithUTC` is also `nonReentrant`.
- `referralCount` only increments inside `_processReferral`, i.e., only alongside a real paid purchase — no way to inflate it for free.
- If the contract's live UTC balance is ever too thin for a pending payout, `transfer` returns `false` and the whole purchase reverts cleanly (no partial state, no overpayment).

Net effect of self-referral: a high-volume buyer can eventually pay as little as 50% of sticker price per purchase, funded from the shared UTC pool — a margin/tokenomics tradeoff, not a drain path. No sequence of calls extracts more UTC than has been deposited.

---

### ~~L-08 — `Game._endGame` Can Be Double-Invoked, Causing Revert on Fleet Removal~~

**File:** `contracts/Game.sol`, lines 546–564 (moved since original write-up)  
**Severity:** Low  
**Status:** Fixed 2026-08-26

**Re-checked against current code before fixing, since the original description no longer matched it exactly.** The originally-described failure mode — `_removeShipsFromFleet` calling `Fleets.removeShipFromFleet` on an already-empty fleet and reverting `ShipNotFound` — no longer applies: `_removeShipsFromFleet` now calls `Fleets.clearFleet`, which is idempotent (a no-op loop on an already-empty fleet, confirmed by reading it), so that specific "trapped, un-finishable game" outcome was already closed as a side effect of an unrelated refactor.

`_endGame` still had no guard against double-invocation within one transaction, though, and the actual reachable consequence turned out to be different from — and in one path worse than — a revert. `moveShip` can trigger `_endGame` twice in a single call: once via `_checkGameEndCondition` (fired from `_performAction`, when a kill empties a player's active-ship set) and again via `_handleEndOfRound`'s score-threshold check immediately after, if that same move also happens to complete the round. Checked all three `IGameOrchestrator` implementations for how they'd handle being called twice:
- `RoguelikeMatch.onGameEnded` — accidentally idempotent (early-returns once `gameIdToPlayer[_gameId]` is deleted on the first call).
- `SinglePlayerMatch.onGameEnded` — accidentally idempotent (`nodeMap.recordCompletion` is itself idempotent by design).
- `PvPMatch.onGameEnded` — **not** idempotent: the second call reaches `GameResults.recordGameResult`, which reverts `GameAlreadyRecorded` — reverting the entire `moveShip` transaction. A legitimate, non-malicious winning move in a PvP match could hit this and fail unexpectedly.

Independent of any revert, `game.metadata.winner` was also silently overwritten by whichever of the two calls ran second — and the two paths compute the winner independently (kill-based vs. score-based), so they aren't guaranteed to agree in a contrived-but-legitimate tie scenario.

**Fix:** added `if (game.metadata.ended) return;` as the first line of `_endGame` — whichever path reaches it first wins; the same-transaction second call becomes a no-op instead of overwriting the winner or double-firing the orchestrator callback. `Game.sol` deployed size: 23.812 KiB (well within the 24.576 KiB limit). Full suite: 546 passing; the one failure (`ShipCostsVersions.test.ts`) is the same pre-existing, unrelated flake noted elsewhere in this doc.

---

## Informational Findings

### I-01 — Multiple Debug Functions Left in Production `Game` Contract

**File:** `contracts/Game.sol`, lines 1204–1252  
**Severity:** Informational  
**Status:** Open, not fixed — cross-referenced with I-02 (2026-07-16) but no code change.

`debugDestroyShip`, `debugSetHullPointsToZero`, and `debugSetShipPosition` are all `external onlyOwner`. While `onlyOwner` limits their blast radius, their presence in production is a centralisation risk and will confuse auditors and players about whether the contract is final.

**Note (2026-07-16):** These three `debug*`-named functions are also the entire "debug-named" half of I-02's centralization list below (I-02 was split into debug-named vs. non-debug-named owner powers) — see I-02 for the split and the non-debug-named half of the picture.

---

### I-02 — Severe Centralisation: Owner Can Alter Any Live Game, Cost, or Attribute

**File:** `contracts/Game.sol`, `contracts/ShipAttributes.sol`, `contracts/Maps.sol`, `contracts/Ships.sol`, `contracts/Lobbies.sol`  
**Severity:** Informational  
**Status:** Open, not fixed — split into sub-groups for clarity (2026-07-16), no code change; no timelock/multisig/governance added.

The deployer key controls: modifying any ship's position in any live game; destroying any ship in any game; zeroing any ship's HP; changing all ship attributes and costs globally; pausing all minting and lobby creation; setting/removing minting authorization; and applying custom maps to any game ID. There are no timelocks, multisig requirements, or governance mechanisms.

**Split (2026-07-16):** Divided the centralization surface below by whether the function name signals "debug/testing tool" or reads as ordinary production admin config — the two categories carry different risk profiles (one is arguably leftover test tooling that shouldn't ship at all; the other is intentional, documented owner configuration whose risk is "no timelock/multisig," not "shouldn't exist").

**A. Debug-named functions** (`contracts/Game.sol`, all `external onlyOwner`) — same three functions as I-01, listed here for the centralization angle specifically:
- `debugDestroyShip` — destroy any ship in any live game
- `debugSetHullPointsToZero` — zero any ship's HP
- `debugSetShipPosition` — move any ship's position in any live game

**B. Non-debug-named functions** — ordinary admin/config entry points, not named or presented as debug tooling:
- `ShipAttributes.setAllAttributes`, `setCosts`, `setCurrentAttributesVersion` — change ship attributes and costs globally, affecting every ship and every future fleet-cost calculation
- `Ships.setPaused` — pause all ship minting
- `Ships.setIsAllowedToCreateShips` — grant/revoke the ability to mint ships
- `Lobbies.setPaused` — pause all lobby creation
- `Maps.applyPresetMapToGame`, `applyPresetScoringMapToGame` — apply any preset map to any game ID

Both lists share the same underlying gap: no timelock, multisig, or governance mechanism gates any of it — a single compromised or malicious deployer key can act immediately and unilaterally through either category. The split is about *why* each function exists, not about reducing the severity of either.

---

### ~~I-03 — `UniversalCredits.mintedAmount` Mapping Is Declared But Never Updated~~

**File:** `contracts/UniversalCredits.sol`, line 16  
**Severity:** Informational  
**Status:** Fixed 2026-07-16

`mapping(address => uint) public mintedAmount` is stored but the `mint` function never writes to it. It is dead storage.

**Fix:** Removed the mapping outright rather than wiring it up. Confirmed it's referenced nowhere else in the codebase (no interface, no consumer, no test) — and it wasn't redundant with an ERC20 builtin either (`balanceOf` tracks *current* balance, which drops on spend, not lifetime-minted total), it was simply unused by anything. `UniversalCredits.sol` shrank by 42 bytes (removing the unused mapping's auto-generated getter). Full suite (301 tests) passes unchanged.

---

### ~~I-04 — `RandomManager` Is a Permanent Placeholder With No Upgrade Path~~

**File:** `contracts/RandomManager.sol`  
**Severity:** Informational  
**Status:** Resolved 2026-08-26 (both remaining premises are now stale — see below). Originally corrected 2026-07-16 re: upgrade path; that correction's own text is retained as-is beneath since it's still accurate.

**Resolved 2026-08-26:** the finding's other premise — "the randomness is a single-step hash with no commit-reveal" — is no longer true. `RandomManager.sol` was rewritten as part of the C-01/C-02 remediation (see that addendum) into a genuine two-step commit-reveal scheme (`requestRandomness` commits, `revealRandomness` can only reveal once the entropy source has actually refreshed, `fulfillRandomRequest` reads the locked-in result). The `// TODO: Update to CadenceRandomConsumer` comment this finding quoted is also gone entirely — Flow's Cadence Arch was never used (deploy target confirmed to be Base, not Flow), so that specific TODO was superseded rather than completed. Nothing in this finding describes the current contract anymore; closing it rather than re-correcting it further.

~~The comment `// TODO: Update to CadenceRandomConsumer` indicates intent to replace this with Flow's Cadence random oracle. Currently deployed as-is, there is no mechanism to upgrade it, and the randomness is a single-step hash with no commit-reveal.~~

**Correction (2026-07-16):** "No mechanism to upgrade it" is inaccurate. `Ships.setConfig(...)` (`Ships.sol:557-575`) is `onlyOwner` and takes `_randomManager` as one of its parameters, writing `config.randomManager = IRandomManager(_randomManager)`. The owner can deploy a new `RandomManager` (e.g. one that actually implements `CadenceRandomConsumer`) and repoint `Ships` at it at any time — that's the real upgrade path, and it works today. What's *not* upgradeable is the deployed `RandomManager` contract's own bytecode in place (no proxy pattern) — but that's true of every non-proxy contract in this codebase, not something specific to `RandomManager`.

`setConfig` intentionally sets all eight config addresses (`gameAddress`, `lobbyAddress`, `fleetsAddress`, `shipGenerator`, `randomManager`, `metadataRenderer`, `shipAttributes`, `universalCredits`) in one call rather than exposing eight separate one-off setters — a deliberate bytecode-size tradeoff (one function's dispatcher entry instead of eight) rather than an oversight. The tradeoff: swapping just `RandomManager` means re-supplying the other seven addresses correctly in the same call, which is a minor operational footgun (get one wrong and you've silently repointed something else), but not a blocker to the upgrade path existing.

---

### ~~I-05 — Inconsistent Solidity Pragma Versions Across Contracts~~

**File:** Multiple  
**Severity:** Informational  
**Status:** Partially fixed 2026-07-16 — see below. `CadenceArchCaller` intentionally left alone per instruction.

- `^0.8.28`: `Game`, `Fleets`, `Lobbies`, `Maps`, `GameResults`, `ShipAttributes`, `Types`, `UniversalCredits`
- `^0.8.24`: `Ships`, `ShipPurchaser`, `DroneYard`, `GenerateNewShip`, `RenderMetadata`
- `>=0.7.0 <0.9.0`: `CadenceArchCaller`

`CadenceArchCaller`'s wide pragma range allows compilation with 0.7.x, which lacks checked arithmetic.

**Fix (2026-07-16):** Bumped all twelve `^0.8.24`-pinned files (`Ships`, `ShipPurchaser`, `DroneYard`, `GenerateNewShip`, `RenderMetadata`, and their interfaces/mocks) to `^0.8.28`, matching the rest of the codebase. `CadenceArchCaller` was deliberately left at `>=0.7.0 <0.9.0` per explicit instruction — not addressed here.

Before making this change, also investigated bumping everything (except `CadenceArchCaller`) further, to the newer 0.8.36 compiler. Verified 0.8.36 downloads and compiles cleanly (no language/API breaking changes), but it increases deployed bytecode size across every non-trivial contract — `Game.sol` +163 bytes (pushing it *over* the 24 KiB limit), `Ships.sol` +204 bytes (landing exactly at the limit, zero headroom), `ShipPurchaser` +224 B, `ShipAttributes` +151 B, `Fleets` +77 B. Given how tight this project already runs against the 24 KiB ceiling, that bump was rejected for now.

The `^0.8.24` → `^0.8.28` change actually applied here is different: `hardhat.config.ts` already pins the compiler to a single exact version (`0.8.28`), so these files were already being compiled with 0.8.28 regardless of their pragma's lower bound — the pragma only declares the *allowed range*, not which binary actually runs. Confirmed empirically: full before/after diff of the contract-sizer output across all ~70 contracts showed **zero byte difference** anywhere. Purely a documentation/consistency fix. Full suite (301 tests) passes unchanged.

---

### ~~I-06 — `Game.lastDamage` Is a Global Mapping Not Scoped Per-Game~~

**File:** `contracts/Game.sol`, line 27  
**Severity:** Informational  
**Status:** Fixed 2026-07-16 — and it turned out to also save bytecode, not cost it.

`mapping(uint target => uint lastDamager) public lastDamage` is keyed by `targetShipId` globally, not per-game. If ship ID 5 is targeted in game 1 and later in game 2, the entry for game 1 is overwritten by game 2. This cross-game contamination is a logic concern for future features involving multi-game ships.

**Fix:** Moved `lastDamage` from a top-level contract mapping into a field of the `GameData` struct itself (`Types.sol`), the same pattern already used for `shipAttributes`, `shipPositions`, and `grid` — so it's now `game.lastDamage[shipId]`, scoped per game like everything else in that struct, with zero cross-game bleed. All four call sites already had a `GameData storage game` reference in scope, so this was a pure `lastDamage[x]` → `game.lastDamage[x]` swap, no new plumbing needed. Confirmed `lastDamage` had no external consumers (no interface, no test reads it), so the mapping was made non-public rather than re-exposing it, which also seemed like the right call regardless of the size effect.

One of the four call sites (`_performShoot`) was already right at its stack-depth ceiling, and a struct-nested mapping access needs one more transient stack slot than a flat top-level mapping does — first compile attempt hit `CompilerError: Stack too deep`. Fixed by scoping the range/line-of-sight check's locals (`shooterPos`, `targetPos`, `manhattan`) to an explicit `{ }` block, since they're never needed after that check — legacy (non-IR) codegen frees a block-scoped variable's stack slot at the end of its block, unlike function-scoped locals which stay live until the function returns. That freed enough room for the new access.

Net effect on size: removing the old mapping's auto-generated `public` getter more than paid for the slightly pricier nested access at the four call sites — `Game.sol` **shrank** by 45 bytes (23.935 → 23.890 KiB), rather than costing anything. Full suite (301 tests) passes unchanged.

---

### ~~I-07 — `Lobbies.getAllLobbiesForPlayerWithDupes` Returns Duplicates~~

**File:** `contracts/Lobbies.sol` (removed)  
**Severity:** Informational  
**Status:** Superseded 2026-08-27 — function removed entirely (see GR-04 below); this finding no longer applies to anything.

The function comment said "This function will have dupes that must be filtered on the client side." Returning duplicates from an on-chain function is an unusual pattern that may cause confusion and double-processing bugs in client applications.

**Original resolution (2026-07-16):** Traced the exact mechanism. The function concatenated two independent `EnumerableSet.UintSet`s — `playerLobbies[_player]` (lobbies this player created/joined) and `openLobbyIds` (every currently-open lobby, any player) — rather than taking their union. If the player's own lobby was still open (waiting for a joiner), its id was a member of both sets simultaneously, so it was copied into the result twice. Each set is individually dedupe-safe (that's what `EnumerableSet` guarantees) — nothing deduped *across* the two, which is exactly what the function's own comment already flagged. At the time this was accepted as a deliberate gas/bytecode tradeoff (dedupe pushed to the client) rather than a bug worth fixing.

**Superseded 2026-08-27:** re-examined during the growth audit (see GR-04) — confirmed the function had zero on-chain callers, zero test coverage, and zero frontend documentation referencing it anywhere, unlike its sibling `getPlayerLobbies` (16+ test call sites, clearly a real function). Removed entirely rather than fixed, since nothing was actually using it.

---

### I-08 — `Ships._update` Modifies Internal State Before `super._update` Call

**File:** `contracts/Ships.sol`, lines 395–439  
**Severity:** Informational  
**Status:** Deferred 2026-07-16 — not fixed. Not struck through — still open, revisit later.

The custom `_update` override modifies `shipsOwned` storage before the `super._update` call. If the base class were changed so that `super._update` could revert after partially executing (e.g., a new hook), the internal state and ERC-721 state could become inconsistent. Currently safe with OpenZeppelin's implementation, but fragile.

---

### ~~I-09 — `Fleets.createFleet` Validates Positions Twice, Wasting Gas~~

**File:** `contracts/Fleets.sol`, lines 68–147  
**Severity:** Informational  
**Status:** Fixed 2026-07-16

Positions are first validated for column bounds (creator: 0–3, joiner: 13–16) in lines 68–81, then a bitset duplicate check runs in lines 126–147. The two-pass approach means row/column validation is effectively done twice for each position. This is a gas inefficiency, not a safety issue.

**Fix:** Merged the two loops (bounds check + bitset duplicate check) into one — they iterate the same `_startingPositions` array with no dependency between them, so there was no reason to keep them separate. The merged loop now sits where the bounds-check loop used to be (right at the top of the function, before `fleetCount++` and any storage writes), so a duplicate-position submission now reverts before any fleet-struct state is created rather than after — a small additional gas saving on the revert path, on top of halving the normal-path iteration count. `Fleets.sol` shrank by 64 bytes (7.140 → 7.075 KiB) as a side effect. No dedicated Fleets test file exists (it's exercised via `Lobbies.test.ts`/`Game.test.ts`); full suite (301 tests) passes unchanged.

---

## Summary Table

| ID | Contract | Function | Severity | Category |
|---|---|---|---|---|
| ~~C-01~~ | RandomManager | `fulfillRandomRequest` | Critical | ~~Improper Randomness~~ (Fixed) |
| ~~C-02~~ | RandomManager | `requestRandomness`, `fulfillRandomRequest` | Critical | ~~Improper Randomness~~ (Mitigated) |
| ~~C-03~~ | Game | `calculateShipAttributes`, `calculateFleetAttributes` | Critical | ~~Access Control~~ (Fixed) |
| ~~C-04~~ | Game | `getGamesForPlayer` | Critical | ~~Gas / DoS~~ (reclassified from I-07, already solved) |
| ~~H-01~~ | ShipAttributes | `setCosts` | High | ~~Logic Bug~~ (Fixed) |
| ~~H-02~~ | Game | `moveShip` | High | ~~Bounds Check~~ (Fixed) |
| ~~H-03~~ | Game | `_processFlakArrayForFleet` | High | ~~Logic Bug~~ (Fixed) |
| ~~H-04~~ | DroneYard | `modifyShip` | High | ~~Locked Funds~~ (Fixed) |
| ~~H-05~~ | Ships | `shipBreaker` | High | ~~State Management~~ (Fixed) |
| ~~H-06~~ | Maps | `getScoreAndZeroOut` | High | ~~Access Control~~ (Fixed) |
| H-07 | Game | `flee` | High | Missing Validation |
| H-08 | Ships | `purchaseWithFlow` | High | DoS / Self-Referral |
| ~~M-01~~ | ShipAttributes | `setCosts` | Medium | ~~Logic Bug~~ (Fixed) |
| ~~M-02~~ | Game | `_performRepairDrones` | Medium | ~~Integer Overflow~~ (Fixed) |
| ~~M-03~~ | UniversalCredits | import | Medium | ~~Production Readiness~~ (Fixed) |
| ~~M-04~~ | ShipAttributes | `calculateShipAttributes` | Medium | ~~Array OOB~~ (Fixed) |
| ~~M-05~~ | Lobbies | `createLobby`, `joinLobby` | Medium | ~~Fee Handling~~ (Fixed) |
| ~~M-06~~ | Game | `_placeShipOnGrid` | Medium | ~~Bounds Check~~ (Fixed) |
| ~~M-07~~ | Game | `endGameOnTimeout` | Medium | ~~Front-Running~~ (Not a bug) |
| ~~M-08~~ | Maps | `updatePresetMap` | Medium | ~~Logic Bug~~ (Not a bug) |
| L-01 | Game | `calculateShipAttributes` | Low | Missing Validation (Won't Fix) |
| ~~L-02~~ | Fleets | `removeShipFromFleet` | Low | ~~State Ordering~~ (Not a bug, hardened) |
| L-03 | Ships | `syncShipCosts` | Low | Access Control (Won't Fix) |
| ~~L-04~~ | Game | `flee` | Low | ~~Edge Case~~ (Fixed) |
| ~~L-05~~ | ShipAttributes | Multiple setters | Low | ~~Missing Events~~ (Fixed) |
| ~~L-06~~ | Ships | `claimFreeShips` | Low | ~~Logic / Documentation~~ (Not a bug) |
| ~~L-07~~ | ShipPurchaser | `purchaseWithUTC` | Low | ~~Missing Validation~~ (Not a bug) |
| ~~L-08~~ | Game | `_endGame` | Low | ~~Double-Invocation~~ (Fixed) |
| I-01 | Game | debug functions | Info | Production Readiness |
| I-02 | Multiple | Owner functions | Info | Centralisation |
| ~~I-03~~ | UniversalCredits | `mintedAmount` | Info | ~~Dead Code~~ (Fixed) |
| ~~I-04~~ | RandomManager | (all) | Info | ~~Architecture~~ (Resolved) |
| ~~I-05~~ | Multiple | pragma | Info | ~~Code Quality~~ (Partially fixed) |
| ~~I-06~~ | Game | `lastDamage` | Info | ~~Data Isolation~~ (Fixed) |
| I-07 | Lobbies | `getAllLobbiesForPlayerWithDupes` | Info | Superseded — function removed (see GR-04) |
| I-08 | Ships | `_update` | Info | ERC-721 Safety |
| ~~I-09~~ | Fleets | `createFleet` | Info | ~~Gas Efficiency~~ (Fixed) |
| ~~T-01~~ | Tournament | `resolveDraw` | High | ~~Missing Validation~~ (Fixed) |
| ~~T-02~~ | Tournament | `assignMatchGame`, `recordResult` | High | ~~Result Replay~~ (Fixed) |
| ~~T-03~~ | Tournament | `assignMatchGame`, `resolveDraw` | High | ~~Locked Funds~~ (Fixed) |
| ~~T-04~~ | Maps | `setMapEditor` | Informational | ~~Widened Blast Radius~~ (Moot) |
| ~~T-05~~ | Tournament | `claimForfeitWin` (new) | High | ~~Locked Funds (player inactivity)~~ (Fixed) |
| ~~SP-01~~ | FreeShipClaim | `claimFreeShips` | High | ~~Reentrancy~~ (Fixed) |
| ~~SP-02~~ | DroneSwarmResolver, EMPResolver, RamResolver | `resolveEffect` | High | ~~Missing Target-Status Validation~~ (Fixed) |
| ~~SP-03~~ | Lobbies | `leaveLobby`, `createFleet` | High | ~~Stale State / Authorization~~ (Fixed) |
| ~~SP-04~~ | RoguelikeMatch | `retreatRun`, `onGameEnded` | High | ~~Stale Callback / Reward Integrity~~ (Fixed) |
| ~~SP-05~~ | RoguelikeMatch, RoguelikeNodeMap | `_commitToNode` | Medium | ~~Reward Farming~~ (Fixed) |

---

## Addendum — Post-Audit Findings in `Tournament.sol` (2026-07-16)

> **Status:** Follow-up review  
> **Date:** 2026-07-16  
> **Scope:** Changes merged after the baseline audit commit (`9a9a049`): `contracts/Tournament.sol`, `contracts/GameBlobRegistry.sol`, `contracts/ByteHasher.sol`, `contracts/IWorldID.sol`, `contracts/mocks/MockWorldID.sol`, and access-control changes to `contracts/Maps.sol`.

*(As originally written on 2026-07-16, before any of the fixes in this document existed: "None of the findings above have been remediated in the current tree. The only change to a previously-audited file is `Maps.sol` gaining an `isMapEditor` role (see T-04 below); the underlying bugs it touches (H-06, M-08) are unchanged." That's no longer true — see the individual C/H/M/L/I findings above for current status, most of which are now fixed, not-a-bug, or explicitly deferred/won't-fix. This addendum's own scope is unaffected: it covers `Tournament.sol` and the small set of files listed above, which genuinely were new/changed at the time this addendum was written.)*

`Tournament.sol` is new since the audit and holds real funds (entry fees + sponsor prize pools). It introduced five findings of its own (T-01–T-05; T-05 was added after the original four, once T-03's fix surfaced a distinct, unfixed gap — see T-05 below).

---

### ~~T-01 — `resolveDraw` Does Not Verify a Draw (or Any Game) Occurred~~

**File:** `contracts/Tournament.sol`, lines 332–349  
**Severity:** High  
**Status:** Fixed 2026-07-16

```solidity
function resolveDraw(
    uint256 tournamentId,
    uint256 matchId,
    bytes32 walrusBlobId
) external {
    TournamentData storage t = _get(tournamentId);
    if (msg.sender != t.creator) revert NotCreator();
    if (t.state != TournamentState.Active) revert NotActive();
    if (matchId >= t.bracket.length) revert MatchNotFound();
    Match storage m = t.bracket[matchId];
    if (m.resolved) revert MatchAlreadyResolved();
    if (m.player1 == address(0) || m.player2 == address(0)) revert MatchNotReady();

    address winner = t.seed[m.player1] <= t.seed[m.player2]
        ? m.player1
        : m.player2;
    _resolve(t, matchId, winner, walrusBlobId);
}
```

The function never reads `m.gameId`, never calls into `GameResults` or `Game`, and never checks that a game was even assigned to the match, let alone that it ended in a draw. It only checks that `msg.sender` is the tournament creator and that both bracket slots are filled. The comment above it frames this as a stopgap for the one case where `GameResults` can't represent an outcome (draws are never recorded there), but nothing in the code restricts its use to that case.

**Why it matters:** The tournament creator can call `resolveDraw` on any active, unresolved match at any time — including matches where no game has been played at all — and it will deterministically resolve to whichever player registered first (lower seed). This lets a creator fast-forward or force the outcome of the entire bracket without any of the underlying games being played, defeating the contract's stated design goal that "winners are read trustlessly from GameResults on the same chain."

**Fix:** `resolveDraw` now reads the actual game state directly from `Game` (a new `IGameReader`/`game` immutable added to `Tournament.sol`, wired via a new constructor parameter — `DeployAndConfig.ts` updated to pass the already-deployed `game` address) instead of trusting the caller's claim:

```solidity
if (m.gameId == 0) revert GameNotAssigned();
GameDataView memory gd = game.getGame(m.gameId);
if (!gd.metadata.ended) revert GameNotComplete();
if (gd.metadata.winner != address(0)) revert NotADraw();
bool ok = (gd.metadata.creator == m.player1 && gd.metadata.joiner == m.player2) ||
    (gd.metadata.creator == m.player2 && gd.metadata.joiner == m.player1);
if (!ok) revert WinnerNotInMatch();
```

This is only possible now because of the C-03-adjacent L-04 fix earlier in this session, which added `GameMetadata.ended` — before that, `winner == address(0)` was ambiguous between "not over" and "ended in a draw," so there was no reliable way to verify a draw actually happened at all. With `ended` available, `resolveDraw` can verify: a game was assigned, it actually finished, it genuinely drew (not a decisive win that should have gone through `recordResult` instead), and its two participants match this match's two players — the same participant-matching check `recordResult` already does against `GameResults`.

Since the draw is now verified on-chain rather than taken on the creator's word, the `NotCreator` gate was removed — `resolveDraw` is now permissionless, matching the trustless design `recordResult` already followed. Added a negative test (`rejects resolveDraw when the assigned game actually has a winner`) alongside a rewrite of the existing draw test to drive a real game to a genuine draw via matched scoring tiles (mirroring `Game.test.ts`'s existing draw-mechanics test) before resolving it. `Tournament.sol` grew by ~2.4 KiB (11.254 → 13.625 KiB, mostly from handling the `GameDataView` return type) — still far under the 24 KiB limit. Full suite (302 tests, +1 new) passes.

---

### ~~T-02 — `assignMatchGame` / `recordResult` Accept Any Historical `gameId`, Enabling Result Replay~~

**File:** `contracts/Tournament.sol`, lines 288–325  
**Severity:** High  
**Status:** Fixed 2026-07-16

`assignMatchGame` (creator-only) sets `m.gameId` to an arbitrary caller-supplied value with no check that the referenced game is new, that it was created after the match was scheduled, or that it has any relationship to the tournament at all:

```solidity
function assignMatchGame(
    uint256 tournamentId,
    uint256 matchId,
    uint256 gameId
) external {
    ...
    m.gameId = gameId;
    emit MatchGameAssigned(tournamentId, matchId, gameId);
}
```

`recordResult` then only validates that the stored `GameResult`'s winner/loser pair matches the match's two seeded players:

```solidity
GameResult memory gr = gameResults.getGameResult(m.gameId);
bool ok = (gr.winner == m.player1 && gr.loser == m.player2) ||
    (gr.winner == m.player2 && gr.loser == m.player1);
if (!ok) revert WinnerNotInMatch();
```

Since `gameId` is the same global ID space used by ordinary (non-tournament) games (per the `game == lobbyId` change in `Game.sol`/`Lobbies.sol`), and `GameResults` records are permanent and never expire, any game the two matched players have ever played against each other — before the tournament existed, before the match was scheduled, or played casually outside the bracket UI — is a valid candidate for `assignMatchGame`.

**Why it matters:** The creator can resolve a scheduled match using an old, unrelated result between the same two players instead of requiring them to actually play the current tournament match. This requires no cooperation from the players themselves (only from the creator), and breaks the "trustless from GameResults" guarantee the contract claims, since linkage between a `gameId` and a specific tournament match is entirely creator-asserted with no on-chain freshness or provenance check.

**Fix:** Added a `uint256 readyAt` field to `Match`, set the moment both `player1` and `player2` become known for that match — either in `_buildBracket` (round-0 matches, both seeds real) or in `_advance` (later rounds, when the second child's winner fills the parent's remaining slot). `recordResult` now requires `gr.timestamp > m.readyAt` (new error `GamePredatesAssignment`), and `resolveDraw` requires `gd.metadata.startedAt > m.readyAt` (reusing the same error) — a candidate game must postdate the moment this specific pairing was actually determined, not merely predate `assignMatchGame`'s own call.

That distinction mattered in practice: my first attempt anchored freshness to `assignMatchGame`'s own call time instead, which broke both existing tests — the real, working usage pattern in this codebase is "play the game first, then assign + record it after the fact," not "assign first, then play." Anchoring to `readyAt` (when the pairing itself came into existence) supports that real workflow while still closing the actual exploit: a game that concluded *before* this match's two players were even paired together can never satisfy the check, regardless of when `assignMatchGame` happens to be called relative to it.

Residual risk, noted directly in the code comments: this can't prove the game was *specifically* the intended bracket match, only that it happened after the pairing existed — the two players could still collude to play a fresh, off-bracket game post-pairing and feed that in instead. Closing that fully would need the game itself to carry a tournament/match tag at creation time, which is a larger change than this fix's scope; what's closed here is the original, cooperation-free "creator alone picks any historical result" attack the finding described.

Added a dedicated test (`rejects reusing a game that predates this match becoming ready`) that plays a real game between the same two players *before* the tournament/match exists, then verifies `assignMatchGame` + `recordResult` on that old game reverts with `GamePredatesAssignment`. `Tournament.sol` grew ~0.17 KiB (13.769 → 13.943 KiB), still far under the 24 KiB limit. Full suite (303 tests, +1 new) passes.

---

### ~~T-03 — No Recovery Path for an Active Tournament With an Unresponsive Creator~~

**File:** `contracts/Tournament.sol`, lines 288–349 (`assignMatchGame`, `resolveDraw`); no corresponding admin/timeout function exists  
**Severity:** High  
**Status:** Fixed 2026-07-16 — see below. A distinct, separate gap (an unresponsive *player*, not creator) is now tracked as T-05.

Once `start()` moves a tournament to `TournamentState.Active`, the only two functions that can move a match toward resolution (`assignMatchGame`, `resolveDraw`) are gated with `if (msg.sender != t.creator) revert NotCreator();`. `recordResult` is permissionless but requires `m.gameId != 0`, which only the creator can set. There is no timeout, no owner override, and no forfeit-by-inactivity path anywhere in the contract for an `Active` tournament — `cancel()` only works while `state == Registration`.

**Why it matters:** If the creator stops participating after `start()` (abandons the tournament, loses their key, or simply never calls `assignMatchGame`), every match is permanently stuck, `finalize()` can never be reached (`t.champion` never gets set), and `t.prizePool` — entry fees from every registrant plus any sponsor contribution — is locked in the contract with no rescue mechanism. This is the same failure mode as the audit's `DroneYard` H-04 finding (permanently locked funds), applied to a contract that pools money from many independent players rather than one.

**Fix:** `resolveDraw` was already made permissionless in the T-01 fix, and `Lobbies.createLobby(..., _reservedJoiner)` was already a standard, permissionless function the two match players can use to pair themselves up without any creator involvement (`createLobbyForAddresses`, which *is* owner-gated, is only a test-convenience shortcut, not the production pairing path). That left `assignMatchGame`'s `NotCreator` gate as the single remaining dependency on the creator staying active — removed it, since `assignMatchGame` alone never resolves anything: `recordResult`/`resolveDraw` independently re-verify participant matching, freshness (`readyAt`, from the T-02 fix), and win/draw state before any payout, and an incorrect assignment can simply be overwritten by anyone before the match resolves (no lock-in).

With that change, grepping the whole contract confirms `t.creator` no longer gates *anything* — `register`/`start`/`cancel`/`claimRefund`/`finalize`/`claim`/`addSponsorPrize` never did, and now neither does `assignMatchGame` or `resolveDraw`. `error NotCreator()` became fully dead code (declared, never reverted anywhere) and was removed. `t.creator` remains purely informational (who called `createTournament`, surfaced via `getTournamentSummary`) with zero on-chain authority attached.

Added a dedicated test (`assignMatchGame is permissionless — not gated to the tournament creator`) where neither `assignMatchGame` nor `recordResult` is called by the tournament creator. `Tournament.sol` shrank slightly (13.943 → 13.898 KiB, removing a check). Full suite (304 tests, +1 new) passes.

**Scope note:** This closes the "creator abandons the tournament" gap specifically. It does *not* address a *player* ghosting (never creating/joining a lobby to actually play their match at all) — there's no game to assign in that case regardless of who's permitted to call what. That's a distinct problem, newly documented as T-05.

---

### ~~T-04 — `Maps.setMapEditor` Widens the Blast Radius of Unfixed M-08~~

**File:** `contracts/Maps.sol`, lines 42–75 (added), interacting with existing M-08  
**Severity:** Informational  
**Status:** Moot (2026-07-16) — both underlying concerns (H-06, M-08) are now resolved; nothing left for this finding to track.

The new `onlyMapEditor` modifier (owner or any address flagged via `setMapEditor`) now gates `createPresetMap`, `updatePresetMap`, `updatePresetScoringMap`, `setBlockedTile`, and `setScoringTile`. This is a legitimate access-control improvement over the previous `onlyOwner`-only surface, but it does not fix `updatePresetMap`'s incomplete-tile-clearing bug (M-08). It does mean that whatever set of addresses `setMapEditor` is granted to going forward will each be able to trigger the still-unresolved M-08 behavior, where previously only the single owner key could.

**Update 2026-07-16:** H-06 (`getScoreAndZeroOut` unguarded) was fixed — see H-06 above. M-08 itself turned out not to be a bug at all (see M-08 above — `_getPresetMap`/`_getPresetScoringMap` do a full live grid re-scan on every call, so the "clear" step can't go stale, and `setBlockedTile` writes to a structurally separate mapping). With both of the concerns this finding was tracking resolved, there's no remaining blast radius to worry about — widening who can call `updatePresetMap` etc. via `setMapEditor` is fine as-is.

---

### ~~T-05 — No Recovery Path for an Active Tournament With an Unresponsive Player~~

**File:** `contracts/Tournament.sol` — no game to assign; not a specific function bug  
**Severity:** High  
**Status:** Fixed 2026-07-16 — implemented Option 1 (per-match forfeit timeout).

T-03's fix removed every remaining dependency on the tournament creator staying active after `start()` — the two players in any match can now pair themselves up (`Lobbies.createLobby`/`joinLobby`, permissionless), play, and resolve the result (`assignMatchGame`/`recordResult`/`resolveDraw`, all now permissionless) without the creator doing anything. But that only helps if *both* players are willing to show up and play.

If one of the two players in an active match simply never creates or joins a lobby — ghosts entirely, loses interest, loses their key, whatever — there is no game for anyone to assign. `m.gameId` stays `0` forever for that match, `recordResult`/`resolveDraw`/`assignMatchGame` all require `m.gameId != 0` (or, for `resolveDraw`, a real completed game), and none of them have any concept of "one player didn't show up, forfeit the match to the other." The match is stuck exactly the same way an unresponsive-creator match used to be stuck — it just now takes an unresponsive *player* instead of an unresponsive creator to trigger it. `finalize()` can never be reached, and the full `t.prizePool` (every registrant's entry fee plus any sponsor contribution) is locked with no rescue path, same failure mode as T-03 and `DroneYard`'s H-04.

**Why this wasn't just folded into the T-03 fix:** T-03's fix works by removing *permission* barriers — anyone can already call the relevant functions, they just need a real game to point at. There's no permission barrier here; the barrier is that no on-chain event ever occurred (no lobby, no game) for either player to act on. Solving it requires new behavior, not a removed check: some notion of a per-match deadline and a way to award the match to a present player when the other never shows, or to void/refund the match, or to void/refund the whole tournament from the `Active` state. That's a meaningfully bigger design decision (timeout duration? forfeit vs. void? does a walkover advance the present player without them playing at all?) than any single-line permission fix, so it's being tracked separately rather than bundled in.

**Fix (Option 1 — per-match forfeit timeout):**

- Added `uint256 matchTimeout` to `TournamentConfig`, set by the tournament creator at `createTournament` time, bounded to `[MIN_MATCH_TIMEOUT, MAX_MATCH_TIMEOUT]` = `[1 hour, 1 week]` (new constants, enforced via the existing `InvalidConfig` check).
- New function `claimForfeitWin(tournamentId, matchId)`: callable only by one of the match's two players (`NotAMatchPlayer` otherwise), only once `block.timestamp > m.readyAt + t.config.matchTimeout` (`MatchTimeoutNotReached` otherwise — reuses `readyAt` from the T-02 fix, i.e. the moment both players were actually determined for this match), and only if no game was ever assigned (`m.gameId == 0`; `GameAlreadyAssigned` otherwise). The caller becomes the winner, the other player the loser; it emits a dedicated `MatchForfeited` event (so a forfeit is distinguishable from a real result off-chain) and then calls the existing `_resolve` internal helper, so it advances the bracket exactly like any other resolution path.
- Deliberately scoped to "no game was ever assigned" only. If a game *was* assigned but stalls mid-play (one player joined the lobby, built a fleet, then went quiet), that's already covered by `Game.endGameOnTimeout` (confirmed working as designed under M-07) followed by the normal `recordResult` path — `claimForfeitWin` isn't meant to duplicate that.

Considered options 2 (tournament-level abandonment escape hatch) and 3 (both) but went with 1 alone per instruction — it directly targets the actual failure mode (a specific match with no game) without the added complexity of a coarser, tournament-wide mechanism.

Added 5 new tests: config-bounds validation (`matchTimeout` outside `[MIN, MAX]` rejected), timeout-not-yet-elapsed rejection, non-participant rejection, already-assigned-game rejection, and the success path (a present player claims a walkover after the timeout). `Tournament.sol` grew ~0.79 KiB (13.898 → 14.684 KiB), still comfortably under the 24 KiB limit. Full suite (309 tests, +5 new) passes.

---

## Addendum — C-03 Remediation (2026-07-16)

**File:** `contracts/Game.sol`, `calculateShipAttributes` (line ~258)

Fixed by adding a snapshot-once guard rather than access control, since `calculateShipAttributes` is intentionally `public` so players can self-serve recalculating their own ships during fleet setup (there is no `msg.sender` restriction to begin with — it was never really "callable only by the owning player," just callable by anyone for any ship). The change:

```solidity
function calculateShipAttributes(uint _gameId, uint _shipId) public {
    GameData storage game = games[_gameId];
    Attributes storage attributes = game.shipAttributes[_shipId];
    if (attributes.version != 0) revert InvalidMove(); // already calculated for this game
    ...
}
```

`attributes.version` is 0 only before the first calculation for that `(gameId, shipId)` pair — `ShipAttributes.currentAttributesVersion` is seeded to `1` in its constructor and only ever increases, so a non-zero `version` reliably means "already snapshotted for this game." This closes the actual exploit path (re-pulling a newer `ShipAttributes` version/cost update into an already-started game) while leaving the one legitimate call, from `_initializeFleetAttributes` at game start, unaffected. Reuses the existing `InvalidMove` error rather than adding a new one, to avoid growing the contract's bytecode further (see size note below).

**Ship-to-game membership (L-01):** left unaddressed — confirmed lower risk than originally stated since `shipAttributes` is scoped per-game storage (see the L-01 note above), not a cross-game hazard. Can be added later as defense in depth.

**Contract size:** `Game.sol` was already within ~20 bytes of the 24 KiB (24,576-byte) Spurious Dragon limit before this change (`hardhat.config.ts` even has a comment noting `runs: 1` "keeps Game under 24 KiB"). The new guard added 34 bytes, pushing it over. Rather than touch the optimizer settings (disallowed by `CLAUDE.md` regardless — no ignoring size limits), `getAllShipPositions` (same file) was rewritten to drop its redundant first pass: it used to scan the full grid once just to count live ships (to size the `positions` memory array) and a second time to populate it. It now allocates for the theoretical worst case (`GRID_HEIGHT * GRID_WIDTH + goneShipIds.length`), fills in one pass, and shrinks the array's length word in place via `assembly { mstore(positions, index) }` once the actual count is known — same return value, one grid scan instead of two. Net effect: `Game.sol` dropped from 24.014 KiB to 23.824 KiB, restoring headroom. `Game.test.ts` passes unchanged.

---

## Addendum — Singleplayer/Roguelike & Lobby Findings (2026-08-26)

**Scope:** The contracts directory has grown from the ~20 contracts covered above to 76, driven by the singleplayer/PvE refactor (`singleplayer-refactor` branch): `SinglePlayerMatch`, `RoguelikeMatch`/`RoguelikeRun`/`RoguelikeResupply`/`RoguelikeNodeMap`/`RoguelikeAIController`, `AIBehavior`/`AIEncounters`/`AIShips`, per-effect combat resolvers (`RamResolver`, `EMPResolver`, `ElectricStormResolver`, `FlakArrayResolver`, `DroneSwarmResolver`, `RepairResolver`, `RepairDronesResolver`, `SpecialEffectsLib`), and new economy contracts (`FreeShipClaim`, `TutorialClaim`, `DroneStorefront`, `DroneEnergyCores`, `VariantPurchaseGate`). This addendum covers findings from a full re-audit of that expanded scope, plus `Lobbies.sol`/`Tournament.sol`/`Fleets.sol` re-checked against the new orchestrator contracts that now call into them. All findings below were confirmed by direct code read, not just sub-agent report.

~~**Re-confirmation of C-01/C-02 (`RandomManager`):** Still open, and now also confirmed to control ship *trait* generation, not just the originally-audited path. `Ships.constructShip` → `RandomManager.fulfillRandomRequest` → `GenerateNewShip.generateShip` derives weapon/hull/speed/accuracy tier and the 8% "shiny" roll entirely from `keccak256(block.prevrandao, requestId)`. Since `purchaseWithFlow` never requires `_to == msg.sender`, a caller can mint into a helper contract and wrap `constructShip` in a call that reverts on an unfavorable roll, at the cost of gas only — see SP details below for the general pattern; no new ID assigned since this is the same root cause as C-01/C-02.~~

**Resolved 2026-08-26 — re-checked against the current `RandomManager`/`Ships.constructShip`, this specific path no longer works, independent of `_to`.** The mint-into-a-helper-contract mechanic described above still exists (`purchaseWithFlow` still doesn't require `_to == msg.sender`), but it no longer enables the exploit: `constructShip` now calls `fulfillRandomRequest`, which is a `view` that reverts `NotYetRevealed` unless `revealRandomness` was already called for that id in a **separate, earlier transaction** (see the C-01/C-02 remediation addendum). The helper contract's wrapped "construct, inspect, revert if unfavorable" attempt can't get a fresh value to discard anymore — either the reveal hasn't happened yet (in which case `constructShip` reverts immediately, before any roll exists to inspect), or it already has, in which case the result is permanently locked in from that earlier, already-mined transaction and a later `constructShip` revert can't touch it. Retrying just reads back the same fixed value every time. `_to != msg.sender` is no longer a security-relevant parameter for this finding; whether to restrict it is a separate product question (gifting/sponsored-mint flows vs. simplicity), not a fix for this.

### ~~SP-01 — `FreeShipClaim.claimFreeShips` Reentrancy Bypasses the 28-Day Cooldown~~

**File:** `contracts/FreeShipClaim.sol`, lines 38–58 (pre-fix)
**Severity:** High
**Category:** Reentrancy
**Status:** Fixed 2026-08-26

`claimFreeShips` checks `lastClaimTimestamp[msg.sender]`, calls `ships.createShips(msg.sender, ...)` (which `_safeMint`s ERC-721 ships — `Ships.sol:504`), and only writes `lastClaimTimestamp[msg.sender] = currentTime` **after** that call returns. `Ships.createShips` has no reentrancy guard. Every sibling claim path in the codebase (`TutorialClaim`, `ShipPurchaser.purchaseWithUTC`, `DroneYard.modifyShip`) either sets its claimed-flag before the external call or carries `nonReentrant` (or both); `FreeShipClaim` is the one outlier missing both.

**Exploit:** A contract implementing `onERC721Received` calls `claimFreeShips`. The first `_safeMint` inside `createShips`'s loop invokes the caller's `onERC721Received` callback before `lastClaimTimestamp` is written, letting it call `claimFreeShips` again with the cooldown check still reading stale state — recursing until gas limits, netting many multiples of the intended 10(+bonus)-ship batch in a single transaction.

**Fix applied:** moved the `lastClaimTimestamp` write before the call to `ships.createShips(...)` (checks-effects-interactions), and added `ReentrancyGuard`/`nonReentrant`, matching `TutorialClaim`'s existing pattern.

**Verification:** added `contracts/mocks/MockFreeShipClaimReentrant.sol` (an `IERC721Receiver` that reenters `claimFreeShips` from its own mint callback) and a test in `test/Ships.test.ts`. Confirmed the test methodology itself before trusting it: the mock's first version hardcoded an invalid variant (`0`) for its reentrant call, which reverted for an unrelated reason (`InvalidVariant`) and made the test pass regardless of whether the real fix was present — a false-positive-passing test. Fixed the mock to reuse the same valid variant as the outer call, then re-verified both directions by temporarily reverting just `FreeShipClaim.sol` to its pre-fix state: against the vulnerable version the reentrant call **succeeds silently** (confirming the double-claim is real), and against the fixed version it reverts `ReentrancyGuardReentrantCall()` (confirming the guard is what actually stops it, not an incidental error). Full suite: 548 passing.

---

### ~~SP-02 — Effect Resolvers Missing Target-Status Validation (DroneSwarm Permanently Bricks Matches)~~

**Files:** `contracts/DroneSwarmResolver.sol:61-65`, `contracts/EMPResolver.sol:62-66`, `contracts/RamResolver.sol:55-62`, `contracts/Game.sol:1200-1225`, `contracts/SpecialEffectsLib.sol:178-204`
**Severity:** High
**Category:** Missing Validation / State Corruption
**Status:** Fixed 2026-08-26

None of these single-target resolvers check `target.status` (0=alive/1=destroyed/2=fled) — only `target.shipId == 0` and friend/enemy. `Game._removeShipFromGame` never deletes a ship's `shipPositions` entry on removal (only flips `status`), while unconditionally `delete`-ing `shipAttributes`. The only defense-in-depth check, in `SpecialEffectsLib.resolveAndApply` (`timestampDestroyed != 0`), only catches globally-destroyed ships, not fled ones.

`DroneSwarmResolver`'s hull-damage path is the dangerous one: hitting an already-fled ship's stale position sees `damage >= attrs.hullPoints` (0, post-deletion) and re-adds the ghost shipId to `game.shipsWithZeroHP`. That set is iterated unconditionally on every round transition by `_incrementReactorCriticalTimerForZeroHPShips`; once the ghost's (deleted) `reactorCriticalTimer` hits 3, it calls `_removeShipFromGame` again on a ship no longer in either fleet, which reverts `ShipNotFound()`. The revert undoes only that round's increment, so the ghost is permanently stuck one tick below the threshold — **every subsequent round-completion transaction for that game reverts, forever**, freezing both players' ship NFTs in an unresolvable match.

`EMPResolver`/`RamResolver` have the same missing check, but their effects resolve within the same transaction (reactor-timer-triggered removal or ram removal), so hitting an already-gone target just reverts the acting player's own move — self-limiting, not persistent, but confirms the gap is systemic.

**Fix applied:** added `if (target.status != 0) revert ...;` right after the existing `shipId == 0` check in all three resolvers (`TargetNotFound` for DroneSwarm/EMP, `InvalidRamTarget` for Ram — reusing each resolver's existing error rather than adding new ones), matching the pattern `ElectricStormResolver`/`FlakArrayResolver` already use in their AoE loops. Did **not** apply the doc's secondary suggestion (hardening `_incrementReactorCriticalTimerForZeroHPShips` to skip rather than revert on a missing shipId) — `Game.sol` is already the tightest contract in the repo on bytecode, and the primary fix already prevents a ghost from ever being re-added to `shipsWithZeroHP` in the first place, so that path is now structurally unreachable rather than merely tolerated. Can revisit if a different path is ever found to reach it.

**Verification:** added `contracts/mocks/MockGameView.sol` (a settable stand-in for the small `IGameView` surface every resolver reads) and `contracts/mocks/MockShipAttributesSpecial.sol`, plus `test/EffectResolverTargetStatus.test.ts` — unit-level tests per resolver rather than a full game setup, since `IGameView` is only 3 functions. Each resolver gets a "rejects a fled/destroyed target" case and a "accepts a live target" control (learned from SP-01's false-positive-passing test — confirmed the controls actually exercise a successful path, not just any revert). Then, per the same SP-01-taught methodology, temporarily reverted just the three resolver files to their pre-fix state and reran: exactly the 3 "rejects" tests failed (proving the vulnerability is real) while the 3 controls still passed (proving the mocks aren't the reason). Restored the fix and confirmed all 6 pass. Full suite: 553 passing; the one failure (`ShipCostsVersions.test.ts`) is the same pre-existing, unrelated, intermittent flake noted elsewhere in this doc.

---

### ~~SP-03 — `Lobbies.leaveLobby` Leaves a Stale `joinerFleetId`, Letting a Creator Force a Stranger Into a Rigged Fleet~~

**File:** `contracts/Lobbies.sol:189-212` (leave), `486-489, 522-524` (create/auto-start)
**Severity:** High
**Category:** Authorization / Stale State
**Status:** Fixed 2026-08-26

When the creator leaves a lobby that already has a joiner, the joiner is promoted to creator and the lobby reopens — but unlike the symmetric "joiner leaves" branch, `lobby.players.joinerFleetId` is never reset. If the promoted player had already submitted a fleet before the original creator left, that fleet id survives into the reopened lobby.

**Exploit:** Alice creates lobby L; Bob joins and submits a fleet (`joinerFleetId = 100`). Alice leaves before submitting hers → Bob is promoted to creator, lobby reopens, `joinerFleetId` stays `100`. Carol joins as the new joiner and calls `createFleet` — it reverts `FleetAlreadyCreated` against the stale id, permanently blocking her. Bob (now creator) submits a new fleet; since `creatorFleetId != 0 && joinerFleetId != 0` (still the stale value) is now satisfied, the game auto-starts with Carol bound as "joiner" but fleet `#100` — Bob's own old fleet — used as the joiner's fleet. `Game.startGame` never re-validates that the joiner fleet's owner matches the joiner address.

**Fix applied:** in the "joiner becomes new creator" branch of `leaveLobby`, added the same `if (lobby.players.joinerFleetId != 0) { fleets.clearFleet(...); lobby.players.joinerFleetId = 0; }` the joiner-leaves branch already does, applied while promoting rather than after. `Lobbies.sol` deployed size: 14.886 KiB, well within the 24.576 KiB limit.

**Verification:** added a test to `test/Lobbies.test.ts` reproducing the exact three-party exploit scenario (Alice creates, Bob joins and submits a fleet, Alice leaves promoting Bob, Carol joins and must be able to submit her own fleet, Bob submits a new fleet reusing his now-freed ship, game auto-starts). Asserts `joinerFleetId` resets to `0` on promotion, Carol's `createFleet` succeeds with a fresh fleet id distinct from the stale one, and the auto-started game binds to *Carol's* fleet, not Bob's old one. Per the SP-01/SP-02-established methodology, temporarily reverted just `Lobbies.sol` to its pre-fix state and reran: failed exactly at the `joinerFleetId == 0` assertion (got the stale `1n`), confirming the vulnerability is real; restored the fix and confirmed it passes. Full suite: 554 passing; the one failure (`ShipCostsVersions.test.ts`) is the same pre-existing, unrelated, intermittent flake noted elsewhere in this doc.

---

### ~~SP-04 — `RoguelikeMatch.onGameEnded` Credits a Run as Won From a Stale Game Callback~~

**File:** `contracts/RoguelikeMatch.sol:246-258` (`retreatRun`), `364-431` (`onGameEnded`)
**Severity:** High
**Category:** Reward Integrity / Stale Callback
**Status:** Fixed 2026-08-26

`retreatRun(0)` ends the caller's run whenever `run.status == Active`, without checking whether the player still has a live, unresolved `gameId` tracked in `gameIdToPlayer`. `onGameEnded` resolves purely by `address` (`runLedger.getRun(player)`), with no check that `run.status == Active` and no binding between the resolving `_gameId` and the run/generation that actually started it.

**Exploit:** Player starts Run R1, reaches a non-final combat node, calls `enterCombatNode` → game G1 is created and tracked. Instead of finishing G1, the player calls `retreatRun(0)`, ending R1 — G1 stays live and still mapped to the player. The player starts Run R2, rushes it to its final combat node Z, calls `enterCombatNode` there to create G2 (left unfinished). The player then finishes the still-live G1 to a win. `onGameEnded(G1, player, ...)` fires, reads `run = runLedger.getRun(player)` — now **R2's** data, parked at final node Z — and since `isFinalNode` is true, calls `runLedger.endRun(player, true)`, crediting R2 as fully won even though its real final encounter (G2) was never completed.

**Fix applied:** exactly the recommendation above, implemented in full (not just one half). Added `activeGameId` to `RoguelikeRun.Run` (plus a `setActiveGameId` setter), set to the new `gameId` in `enterCombatNode`. `retreatRun(0)` now reverts `ActiveGameInProgress` if `run.activeGameId != 0` — this alone closes the exploit's first step, since the player can no longer abandon a run "between nodes" while a combat match is still genuinely unresolved; they must forfeit it explicitly via `retreatRun(activeGameId)` first, which resolves it as a real loss through the normal callback path. `onGameEnded` additionally verifies `run.status == RunStatus.Active && run.activeGameId == _gameId` before mutating roster/status (returning early, a no-op, otherwise) and clears `activeGameId` back to `0` once a game is genuinely resolved — kept as defense in depth even though the `retreatRun(0)` guard already makes the described stale-callback path unreachable through any currently-known legitimate flow. `RoguelikeMatch.sol` deployed size: 20.908 KiB; `RoguelikeRun.sol`: 3.384 KiB — both well within the 24.576 KiB limit.

**Related, out-of-scope observation (not fixed here):** `enterResupplyNode` never checks `activeGameId` either, so a player can currently call it (to move `currentNodeId` forward, e.g. to a resupply node that's a legitimate child of the in-progress combat node) *while* a combat match is still unresolved. If that combat game later resolves as a win, `onGameEnded`'s `isFinalNode`/reward logic runs against `run.currentNodeId` as of *that moment* (the resupply node the player already moved to), not the node the win actually happened at — a state-consistency gap, not obviously a free-reward exploit, but related enough to flag. Left alone since it's not part of this finding and needs its own look.

**Verification:** added tests to `test/RoguelikeMatch.test.ts`: `retreatRun(0)` reverts `ActiveGameInProgress` while a combat match is active; `activeGameId` is set correctly on `enterCombatNode` and clears to `0` on both resolution paths (win, and forfeit-loss via `retreatRun(activeGameId)`). Reconstructing the full original multi-run exploit chain end-to-end wasn't attempted as a test — the `retreatRun(0)` guard closes its first step, so there's no longer a legitimate path to reach it. Per the established methodology, temporarily reverted both `RoguelikeMatch.sol` and `RoguelikeRun.sol` to their pre-fix state and reran: all 3 new tests failed for the expected reasons (the `retreatRun(0)` call that should revert instead succeeded; `run.activeGameId` read back `undefined` since the field didn't exist yet). Restored the fix and confirmed all 3 pass. Full suite: 558 passing, no failures this run (the usual pre-existing `ShipCostsVersions.test.ts` flake is intermittent, not present every run).

---

### ~~SP-05 — Two-Way Edge Into a Combat Node Permits Unbounded Reward Farming~~

**File:** `contracts/RoguelikeMatch.sol:272-329` (`_commitToNode`), `contracts/RoguelikeNodeMap.sol` (`twoWay` edges)
**Severity:** Medium
**Category:** Economic Logic (content-configuration-dependent)
**Status:** Fixed 2026-08-26

`_commitToNode` only locks sibling nodes (and the departed node, unless the traversed edge is `twoWay`) on a forward move. Nothing stops a `twoWay` edge from terminating at a `Combat` node, and a Combat node is never flagged "already paid out" once defeated. This requires an admin/content choice (marking an edge into a Combat node `twoWay`), but the contract enforces nothing preventing it.

**Exploit:** An edge hub A ↔ Combat node B is marked `twoWay` (a plausible content choice, e.g. "return to the hub after this fight"). Clearing B once, walking back to A (never locked, two-way), then re-entering B (never locked — only siblings of a forward move get locked) repeats the fight and its kill-based DEC/UTC reward indefinitely.

**Fix applied:** the second option — an explicit "already defeated this run-generation" flag — not the first (disallowing `twoWay` into Combat nodes), which would have removed legitimate replayable-hub graph designs entirely rather than just closing the farming loophole. Added `defeatedByGen[player][generation][nodeId]` to `RoguelikeRun` (keyed by generation, same reasoning as the existing `lockedByGen`, so a new run doesn't inherit a previous one's defeats), plus `setNodeDefeated`/`isNodeDefeated`. `RoguelikeMatch.onGameEnded` marks the just-won node defeated; `enterCombatNode` reverts `NodeAlreadyDefeated` if the target is already marked, before any fleet/game side effects run. A different combat node reachable from the same hub is unaffected — only re-entering the *same* already-cleared one is blocked, preserving the "hub with routes to more than one fight" design intent the `twoWay` comment describes.

Considered (per a question from the user) whether to also vary the *reward amount* for a first vs. subsequent clear, rather than just gating access — decided against it for this fix. The kill reward (`Ships.recycleReward() >> 2`) is a single flat global constant applied identically to every kill in every game mode via `Game._removeShipFromGame` → `ShipsRouter.setTimestampDestroyed` → `DestroyRewardLib`, with zero per-node/per-game context today. Making it context-aware would require new plumbing reaching into `Game.sol` specifically — the tightest-budget contract in the repo (23.8/24.576 KiB) — for a product feature (tiered rewards) the user confirmed wasn't actually intended; blocking re-entry outright fully closes the security issue without touching `Game.sol` at all.

**Verification:** added `test/RoguelikeMatch.test.ts` coverage: a custom two-node graph (Resupply hub, root) `<->twoWay<->` (Combat node) `->` (dummy Resupply child, so winning the Combat node doesn't immediately end the run) — win the Combat node, walk back to the hub, attempt to re-enter, confirm `NodeAlreadyDefeated`. Per the established methodology, temporarily stripped just the `enterCombatNode`/`onGameEnded` integration (leaving `RoguelikeRun`'s new functions defined but unused) and reran: the re-entry attempt succeeded instead of reverting, confirming the farming path is real and the test catches it. Restored the fix and confirmed it passes. `RoguelikeMatch.sol` deployed size: 21.149 KiB; `RoguelikeRun.sol`: 3.611 KiB — both within the 24.576 KiB limit. Full suite: 558 passing; the one failure (`ShipCostsVersions.test.ts`) is the same pre-existing, unrelated, intermittent flake noted elsewhere in this doc.

**All five SP findings from the 2026-08-26 addendum are now resolved.**

---

## Addendum — C-01/C-02 Remediation: `RandomManager` Commit-Reveal Rewrite (2026-08-26)

**Context:** The deploy target is confirmed to be Base (chain 84532), not Flow — so the originally-considered fix (wiring up `@onflow/flow-sol-utils`'s `CadenceRandomConsumer`, which calls a Flow-only precompile) was not applicable. `contracts/RandomManager.sol` was rewritten from scratch as a commit-reveal scheme over `block.prevrandao`/`block.timestamp`, since Base has no on-chain unpredictable-randomness precompile to call instead.

**What changed:**
- `requestRandomness()` now records the commit block and returns a sequential `requestId` (previously a hash, now just a counter — cosmetic only, `Ships.traits.serialNumber` still just needs to be a unique handle).
- New `revealRandomness(requestId)` — the **reveal** step — now: (1) reverts `RequestNotFound` for any id that was never actually issued (closes C-01's forged-id gap), (2) reverts `AlreadyRevealed` on a repeat call (closes C-01's replay gap), and (3) reverts `TooSoonToReveal` unless `block.prevrandao` has genuinely *changed* since the request's commit block (not merely "a later block number was reached" — see next paragraph for why that distinction is load-bearing on this specific chain). Once revealed, the result is permanently locked into storage.

**Correction made same day, before this was ever deployed:** the first version of this fix checked `block.number > commitBlock` rather than "prevrandao changed." That's wrong on Base specifically — pulled live Base Sepolia blocks and confirmed `prevrandao` there is relayed from Ethereum L1's own RANDAO output, so it only updates roughly every 6 L2 blocks (~12s, matching L1's block time), not every L2 block:

```
block 45999196-45999201  (6 blocks, ~12s)  → same prevrandao: 0x661129...
block 45999202-45999207  (6 blocks, ~12s)  → same prevrandao: 0xc4cd9b...
block 45999208-45999213  (6 blocks, ~12s)  → same prevrandao: 0x846354...
```

A "later block number" reveal could easily land inside the *same* ~12-second window as the request — a window whose `prevrandao` becomes public the instant it starts. That means anyone (not just a block producer) could watch for a window they like and time a normal, non-reverting `revealRandomness` call to land inside it — free, no wasted gas, no special access — which is a materially easier version of the exact grinding exploit this fix exists to close. Checking that `block.prevrandao` has actually changed since commit (`Request.prevRandaoAtCommit`, stored at request time) closes this regardless of how many L2 blocks a chain happens to share one prevrandao value across, present or future — it targets the real entropy-refresh boundary instead of assuming it lines up with block numbers.

Practical consequence: the wait between commit and a successful reveal isn't a fixed number — it's "however long until the epoch you landed in rolls over," which on the measured ~12s/~6-block cadence works out to roughly 1–6 L2 blocks (best case: commit lands right before rollover; worst case: right after). New `canReveal(requestId) view returns (bool)` lets a caller (the frontend, a keeper) poll for "is it ready yet" instead of guessing a block count or eating a revert.
- `fulfillRandomRequest(requestId)` — **the same name/shape `Ships.sol` has always called** — is now a view that reads back the already-locked-in result, reverting `NotYetRevealed` if `revealRandomness` hasn't been called yet. Deliberately kept as the stable consumer-facing entry point (rather than renamed to something like `getRandomResult`) specifically so a future provider swap — e.g. a real VRF — only needs to satisfy this one signature; `Ships.sol` doesn't need to change again, and doesn't need to know anything about how reveal actually works.
- `Ships.constructShip` still calls `fulfillRandomRequest`, unchanged from before this whole rewrite — it just now requires `revealRandomness` to have already been called separately. **This separation is the load-bearing part of the fix**, not a side detail: if `constructShip` revealed inline (as the old contract effectively let it do), an attacker could still wrap it, inspect the resulting ship, and revert on an unfavorable roll — the delay-one-block check alone doesn't stop that, since the revert would undo the reveal too and the same request could just be retried in yet another later block, indefinitely, for the cost of gas only (this is exactly the grinding exploit C-02 originally described). Requiring `revealRandomness` to have already happened in a **separate, prior, already-mined transaction** — which by construction can't be undone by a later `constructShip` call reverting — is what actually closes it.

**Residual risk (by design, not an oversight):** this is a mitigation, not a cryptographic guarantee, and it's narrower than originally described above. `block.prevrandao` on Base is *not* something Base's sequencer chooses directly — it's relayed from L1 Ethereum's own RANDAO, so biasing it requires the much more limited, more decentralized options an L1 validator has (proposer-known-in-advance, skip-to-regrind), not anything Base-specific.

What Base's sequencer *does* retain is broader than just "picking a timestamp": since `revealRandomness` is permissionless, anyone can submit it, but only the sequencer decides which block a given submitted transaction actually lands in. A sequencer motivated to bias one specific high-value reveal could simply decline to include that transaction for a while, let several future prevrandao epochs (each individually still legitimate/unpredictable to everyone else) go by, and only include it once one of those epochs — combined with whatever timestamp they assign that block — happens to produce a result they like. Timestamp choice is one small knob on top of that; selective delay of inclusion across many future epochs is the bigger one. Both require actually being the block producer, though — no external caller (requester or bystander) retains any of this. That's a fundamentally different (and much narrower) threat than the original C-01/C-02 findings, which any external caller — not just a chain operator — could exploit for free. Closing it completely would require a real external randomness source (Chainlink VRF is the standard option on Base); flagged as a follow-up, not blocking.

**Test suite impact:** every ship-construction test in the suite already called the reveal step manually before `constructShip`/`constructAllMyShips` (apparently anticipating this exact separation, even though the old contract didn't enforce it) — those calls were renamed from `fulfillRandomRequest` to `revealRandomness` to match. Five test setups had reveal loops that under-covered the ships actually minted (assuming 1 ship per `purchaseWithFlow` call, when tier 0 mints 5) — invisible before since the old contract accepted a reveal for any id unconditionally, now surfaced as `NotYetRevealed`/`AlreadyRevealed` reverts and fixed in `test/Game.test.ts` (4 spots) and `test/Lobbies.test.ts` (2 spots) to read the real `shipCount()` instead of a hardcoded bound. Full suite: 547 passing (occasionally 546/1 — `ShipCostsVersions.test.ts`'s ship-variant hull-tier lookup is a pre-existing, intermittent, unrelated flake confirmed to reproduce identically on the pre-fix code).

**With this fix, all four originally-listed Critical findings (C-01 through C-04) are now resolved** (C-01/C-02 here; C-03/C-04 were already fixed per the entries above) — though see the residual-risk note above before treating randomness as fully trustless.

---

## Addendum — `RandomManager` Batch Reveal (2026-08-26, same day as the rewrite above)

**Not a new finding — a usability follow-up to the C-01/C-02 remediation above, caught before the frontend doc for it went out.** The commit-reveal rewrite added a `revealRandomness(uint requestId)` step between minting and constructing a ship, callable only one request id at a time. That's fine for a single ship, but `Ships.createShips`/`purchaseWithFlow` mint N ships (up to 60, at the top tier) in one transaction, each with its own `requestId` — the one-at-a-time reveal would have forced N separate reveal transactions to unblock construction of a single purchase, wrecking the "mint in one tx" UX the rest of the purchase flow provides.

**Fix:** `RandomManager.sol` gained `revealRandomnessBatch(uint[] calldata requestIds) external returns (uint64[] memory)` and `canRevealBatch(uint[] calldata requestIds) external view returns (bool)`, alongside (not replacing) the original single-id `revealRandomness`/`canReveal`. Since every request minted in the same transaction shares that transaction's block (and therefore its `prevRandaoAtCommit`), all of them become revealable at exactly the same moment — there's no per-request staggering for the batch to account for. Net effect: minting N ships and revealing all N is exactly 2 transactions, regardless of N, matching the original (pre-rewrite) UX shape.

**Correction, same day, before this shipped to the frontend doc:** the first version of `revealRandomnessBatch` reverted the entire batch if even one id in it was already revealed (looping the same internal logic `revealRandomness` uses, unconditionally). This was flagged as a real griefing vector, not a benign edge case: `revealRandomness` is deliberately permissionless (anyone can call it, by design — see the C-01/C-02 remediation above), so any outside address can watch for a pending mint and front-run a single id out of the victim's batch with their own `revealRandomness` call, for the cost of gas only. Reverting the whole batch on that would let an attacker force any player back to one-at-a-time reveals for free, with zero funds gained — pure griefing, and exactly the kind of "no one has a reason to do this" reasoning this project has now written a standing rule against (see `CLAUDE.md`'s "Assume Hostile Outside Actors"). Fixed by making `revealRandomnessBatch` skip an already-revealed id (returning its already-locked-in result) instead of reverting; `RequestNotFound`/`TooSoonToReveal` still revert the whole batch, since neither depends on anything a third party can selectively trigger against a specific victim's array — a bad id or a too-early call is a caller-side bug/timing issue, not an attack surface. `canRevealBatch` was updated to match: it now answers "would `revealRandomnessBatch` succeed on this exact array," so an already-revealed id no longer makes it return `false`.

`IRandomManager.sol` and `Ships.sol` are untouched — `Ships.constructShip` only ever called `fulfillRandomRequest`, never `revealRandomness` directly, so this whole addendum is purely additive on the consumer-facing (frontend/keeper) side of `RandomManager`.

`test/RandomManager.test.ts` (standalone fixture, no dependency on `Ships`) covers: batch reveal matching individual reveals, `canRevealBatch` reverting-check semantics for a genuinely invalid id, and — the key regression test — a batch reveal succeeding and returning the correct result even when a simulated hostile third party has already revealed one of the batch's ids first. `RandomManager.sol` has no meaningful size constraint (well under 2 KiB of the 24 KiB limit), so this carried no contract-size risk.

---

## Addendum — Hostile-Actor Sweep (2026-08-26)

**Context:** Prompted by a new standing rule (see `CLAUDE.md`'s "Assume Hostile Outside Actors", added the same day after the `RandomManager.revealRandomnessBatch` griefing vector above was caught and fixed). This is a targeted re-sweep of every `external`/`public` state-mutating function across all 49 non-interface/non-mock contracts, specifically asking: "what's the worst a purely malicious, zero-profit-seeking caller could do to someone else, and does the code tolerate it?" — not a full re-audit of every function's business logic. One new finding; everything else checked is documented below as reviewed-and-clear so this sweep isn't silently re-litigated later.

### ~~HA-01 — `ShipsRouter.createShips`/`createSpecificShip`/`customizeShip` Have No Caller Check At All~~

**File:** `contracts/ShipsRouter.sol`, lines 128–147
**Severity:** High (currently **not exploitable** — see below — but zero defense-in-depth against a plausible future config change)
**Status:** Fixed 2026-08-26

`ShipsRouter` is a facade Game.sol/Fleets.sol/ShipAttributes.sol call instead of `Ships.sol` directly (see the contract's own header comment). Two of its other proxied functions, `setInFleet` and `setTimestampDestroyed`, explicitly re-implement the same caller check `Ships.sol` would apply directly — with a comment spelling out exactly why:

> "Ships.sol/AIShips.sol both whitelist this router as a caller, so this router must enforce the same caller check Ships.sol used to apply directly — otherwise any account could call through the router and silently unlock/lock a ship it doesn't control, since the backing contracts see the trusted router as msg.sender regardless of who called the router itself."

`createShips`, `createSpecificShip`, and `customizeShip` do not get this treatment — they are bare passthroughs with no check of their own:

```solidity
function createShips(address _to, uint _amount, uint16 _variant, uint8 _tier, bool _isFreeShip) external {
    ships.createShips(_to, _amount, _variant, _tier, _isFreeShip);
}
function createSpecificShip(address _to, Ship calldata _ship) external returns (uint) {
    return ships.createSpecificShip(_to, _ship);
}
function customizeShip(uint _id, Ship memory _ship) external {
    ships.customizeShip(_id, _ship);
}
```

`Ships.createShips`/`createSpecificShip`/`customizeShip` are each gated by `isAllowedToCreateShips[msg.sender]` — but as seen from `Ships.sol`, `msg.sender` is `ShipsRouter`'s own address, not whoever called the router. The exact same reasoning the header comment above applies to `setInFleet`/`setTimestampDestroyed` applies here: if `ShipsRouter` is ever added to `Ships.isAllowedToCreateShips`, these three functions become a **completely open, unlimited, free ship-minting/customization backdoor** — any address could mint arbitrary quantities of ships (any variant/tier, flagged free or not) to any address, or rewrite any existing ship's traits/equipment/kill count via `customizeShip`, for the cost of gas alone.

**Why it matters:** Under the new standing assumption (assume every permissionless surface will be hit by a maximally hostile, zero-cost-seeking caller), a function with zero access control sitting one config change away from being a full economic exploit is a real finding, not a hypothetical — especially in a file where the *exact same author, in the same file*, already identified and closed this precise class of bug for two sibling functions.

**Current exploitability: none, verified.** Checked `ignition/modules/DeployAndConfig.ts`'s every `setIsAllowedToCreateShips` call against `ships` (there are five: `ShipPurchaser`, `DroneYard`, `TutorialClaim`, the Firebase Flow backend minter, `FreeShipClaim`) — `shipsRouter` is not among them. Per `ShipsRouter.sol`'s own comment, these three functions exist purely so the contract satisfies the `IShips` interface `Game.sol`'s constructor expects; nothing routes through them in production today. Calling any of the three right now reverts `NotAuthorized(shipsRouterAddress)` inside `Ships.sol`. This is a latent gap, not a live one.

**Fix:** `createShips`/`createSpecificShip`/`customizeShip` now revert unconditionally with a new `NotSupported()` error (each is `external pure`, parameter names commented out to silence unused-parameter warnings) instead of forwarding to `Ships.sol` at all — satisfying the `IShips` interface's shape without ever forwarding a real call, so no future `isAllowedToCreateShips` config change can silently reactivate this regardless of intent. `test/ShipsRouter.test.ts`'s existing `createSpecificShip` test (previously asserting the old passthrough's incidental `NotAuthorized` revert) was updated to assert `NotSupported`, plus two new tests for `createShips`/`customizeShip`; all 11 tests in that file pass. `ShipsRouter.sol` shrank by ~1.1 KiB (dead forwarding logic removed) — no size risk anywhere.

### Reviewed, no issue found

Every other `external`/`public` state-mutating function across the following was checked for the same "permissionless + affects another party's state or funds" shape and found properly gated (owner/allowlist/`msg.sender`-identity check, or genuinely self-scoped so a hostile caller can only affect their own state): `AIEncounters`, `AIShips` (`releaseShips`/`markDestroyed`/`recordKill` all allowlist- or router-gated), `DroneEnergyCores`/`UniversalCredits` (`mint` gated by `authorizedToMint`), `DroneStorefront`, `DroneYard`, `Fleets` (`clearFleet`/`removeShipFromFleet` gated by `isAllowedToManageFleets`/`gameAddress`), `FreeShipClaim`, `Game` (`forceEndSession` gated to `game.metadata.orchestrator`; the six `setXAddress`/`debug*` functions are `onlyOwner`), `GameBlobRegistry.record` (must be the player themselves or the configured `authorizedWriter`), `GameResults` (`recordGameResult`/`addWin`/`addLoss` each gated to a specific configured contract address), `Lobbies`, `Maps` (`setBlockedTile`/`setScoringTile`/`applyPresetMapToGame` all `onlyMapEditor` or game-address-gated, per H-06/T-04 above), `NodeMap.recordCompletion` (gated by `isAllowedToCompleteNodes`), `PvPMatch`, `RoguelikeMatch.takeAITurn` (permissionless by design, same as `RandomManager.revealRandomness` — but deterministic and gated by `currentTurn == address(this)`, so a hostile caller can only advance the AI's own turn correctly, never act out of turn or on someone else's behalf), `RoguelikeResupply` (`resupplyRepair`/`resupplyModifyRoster` both keyed to `msg.sender`'s own run/roster via `runLedger.getRun(msg.sender)`, ownership-checked for any ship added), `RoguelikeRun` (all mutators `onlyAllowed`), `ShatteredHiveMedal.claimMedal` (self-claim, one-per-address, self-verifying), `ShipPurchaser`, `Ships` (`createShips`/`createSpecificShip`/`customizeShip` all allowlist-gated; `markDestroyed`/`recordKill` gated to `owner()`/`gameAddress`; `setInFleet` gated to lobby/game/fleets addresses; `syncShipCosts`'s permissionless-but-inert id-0 case already covered by L-03), `Tournament` (post T-01–T-05 fixes), `TutorialClaim`, `VariantPurchaseGate` (view-only gate check, owner-configured).

**Not yet re-verified against the full test suite as of this writing** — a full `npx hardhat test` run was still in progress when this addendum was written; results (and whether HA-01's proposed fix gets applied) to follow once that lands and the user has weighed in on the fix approach.

---

## Addendum — Design Note: Future Token-Gated Claim/Kill-Bonus Mechanics (2026-08-26)

**Not a security finding.** This is a sizing/feasibility note for two mechanics discussed but explicitly **not yet being built**: (1) a turn-in that reduces `FreeShipClaim.claimCooldownPeriod` per player, and (2) a turn-in that gives a bonus to a ship's starting `shipsDestroyed` roll. Both are planned to be funded by a **new token distinct from DEC and UTC** — most likely a future reward for defeating AI ships from factions 3/4, which don't exist yet (see project memory `project_future_faction_kill_token`). Recorded here so the constraint is visible before either mechanic is actually implemented.

**Headroom at time of writing** (`npx hardhat size-contracts`, 2026-08-26): `Ships.sol` 23.715 / 24 KiB deployed (~292 bytes free); `Game.sol` 23.812 / 24 KiB (~192 bytes free). Neither mechanic touches `Game.sol`.

**Cooldown-reduction mechanic:** No `Ships.sol` changes of any kind. Fully contained to `FreeShipClaim.sol` (1.3/24 KiB, ample room) plus a new turn-in contract mirroring `DroneStorefront.turnInCores`, once the funding token exists.

**Kill-roll-bonus mechanic:** This is the one with `Ships.sol` exposure. The starting `shipsDestroyed` roll happens in `GenerateNewShip.generateShip`, called only from `Ships.constructShip` (`Ships.sol:350`), which has no notion of the ship's owner today. Three implementation paths, in order of `Ships.sol` cost:

1. **Reuse `customizeShip` — zero new `Ships.sol` code.** It's already gated by the `isAllowedToCreateShips` allowlist, and `_applyShipCustomization` (`Ships.sol:263`) already does `ship.shipData.shipsDestroyed = _ship.shipData.shipsDestroyed`. A future turn-in contract could read a ship via `getShip`, bump `shipsDestroyed`, and call `customizeShip` with the full struct back — no PR to `Ships.sol` required. **Caveat:** the same call also force-sets `constructed = true` and increments the `modified` counter (`Ships.sol:268-274`), which feeds `calculateShipCost` — so this path also marks the ship "modified" and shifts its cost, a side effect that has nothing to do with the intended bonus.
2. **A new minimal function** (e.g. `addBonusKills(uint _id, uint16 _amount)`) reusing the existing `isAllowedToCreateShips` mapping and `NotAuthorized` error (no new storage, no new error type). Clean semantics, no `modified`/`constructed` side effects, but it is new bytecode against a ~292-byte budget.
3. **True "bonus layered on the roll,"** by threading the player through the `generateShip` call itself — requires changing `IGenerateNewShip`, `GenerateNewShip.sol`, and the `Ships.sol:350` call site. Adds an extra ABI-encoded argument to `Ships.sol`'s single tightest external call; real risk of not fitting in the remaining headroom without trimming something else first (see the `Ships.sol` size-extraction pattern used elsewhere in this codebase, e.g. `FreeShipClaim`'s own extraction from `Ships.sol`).

**Conclusion:** No `Ships.sol` or `Game.sol` changes are required today for either mechanic to become buildable later. Option 1 already works with zero new code, if the cost/`modified` side effect is acceptable (arguably even desirable). Option 2 is the smallest deliberate addition if clean semantics are wanted instead. Option 3 should be avoided unless `Ships.sol` regains headroom from unrelated work first.

**Added consideration (2026-08-27) — pre-reveal tradeability creates a marketplace information asymmetry for any "known before reveal" trait, including a future kill-bonus.** Confirmed `Ships._update` (the ERC721 transfer hook, `Ships.sol:427-470`) has no check on `shipData.constructed` or reveal status at all — only `!destroyed`, `!inFleet`, and `amountPurchased >= 10` for both parties gate a transfer. So an unrevealed, unconstructed ship is freely tradeable today, same as any other. Separately, `_mintShip` (`Ships.sol:481-511`) already demonstrates the exact shape of the concern for the existing tier-purchase rank mechanic: `shipsDestroyed` for a ranked ship is written directly into public storage **at mint time**, before reveal, before construction — anyone can read it immediately, no waiting required. Whichever implementation path above gets chosen for a future campaign-win kill bonus, if it similarly writes `shipsDestroyed` (or any other trait) as an immediately-public, pre-reveal value on the ship, that specific field becomes visible/verifiable before reveal while every other trait (weapon, hull, speed, accuracy, colors, armor/shields, special, shiny) stays hidden until someone actually reveals+previews it. That combination — one guaranteed-good, publicly-verifiable trait plus several still-hidden ones, on a token that's freely tradeable in that state — lets a seller who has privately revealed (via the free `GenerateNewShip.generateShip` view-call preview, see `docs/singleplayer-frontend-integration.md`-adjacent frontend docs) offload a campaign-bonus ship with bad remaining rolls onto a buyer who can only verify the guaranteed kill floor, while keeping the good rolls for themselves. Not a reason to avoid the bonus mechanic — just something to weigh when choosing *how* it's applied (e.g., whether campaign-bonus ships should be non-transferable until constructed, mirroring the existing free-ship soulbound-until-`amountPurchased>=10` pattern, if this asymmetry is judged worth closing).

---

## Addendum — `RandomManager`: Drop `block.timestamp` From the Hash, Collapse Reveal Into `fulfillRandomRequest` (2026-08-27)

**Context:** While comparing the commit-reveal design against a proposed simpler alternative, pulled live data from Base Sepolia to settle an empirical question rather than argue it in the abstract (same method as the original C-01/C-02 fix's prevrandao-cadence measurement). Method: `eth_getBlockByNumber` over three separate 150–300 block windows (most recent ~10 minutes, ~2 hours prior, ~24 hours prior), computing every consecutive-block timestamp delta.

**Result: 597 consecutive block-pairs, 100% exactly `2` seconds, zero exceptions, zero variance, across a full day of real chain activity.** Base Sepolia's block timestamps are not "approximately 2 seconds with jitter" — they are a rigid, deterministic 2-second grid: `block(N+1).timestamp = block(N).timestamp + 2`, always.

**Why this mattered:** `revealRandomness`'s result was `keccak256(block.prevrandao, block.timestamp, _requestId)`. `block.prevrandao` is stable for ~6 consecutive L2 blocks (one L1 epoch, per the original C-01/C-02 addendum). Given the timestamp grid above, every block's timestamp *within* that stable epoch is a fully deterministic function of when the epoch started — so all 6 possible `(prevrandao, timestamp)` outputs for an entire epoch become computable the instant the epoch begins, with no simulation or estimation needed. Mixing in `block.timestamp` therefore contributed no real entropy; it just handed anyone 6 exactly-known candidate outcomes per epoch instead of 1 — a ~6x weakening of the "must wait for a fresh epoch" protection this scheme depends on, in the already-deployed C-01/C-02 remediation.

**Separately identified while working through this: the reveal-once-and-lock property doesn't actually block grinding via a wrapper.** A contract can call `revealRandomness`, immediately feed the returned `randomBase` into `GenerateNewShip.generateShip` (an unrestricted public view) to preview the resulting ship, and `revert()` if unsatisfied — unwinding the reveal too, since it's all one transaction. `AlreadyRevealed` only blocks a *second* attempt after a *successful* one; a reverted attempt leaves nothing behind to block anything, so the same wrapper can retry every ~12s epoch until a favorable roll appears. This exposure exists identically whether reveal is a separate call or merged into consumption — separating them never actually closed it.

**Fix, two parts:**

1. **Drop `block.timestamp` from the hash.** `_revealRandomness` now computes `keccak256(block.prevrandao, _requestId)` only. This restores the intended ~1-candidate-per-epoch density (removing the accidental 6x amplification) — a real improvement independent of anything else in this addendum.
2. **Collapse reveal into `fulfillRandomRequest`.** Given (a) the wrapper-revert exposure exists in exactly the same shape whether reveal is separate or not, and (b) the low practical stakes already established for this game (99.9% of ships worth under $1, construction itself free — see the conversation history this addendum summarizes), there's no remaining reason to require a separate mandatory reveal transaction. `fulfillRandomRequest` — the function `Ships.constructShip` has always called — now reveals-and-locks on first call (if the entropy window has opened) and simply returns the cached result on every call after. **Mint → construct is now exactly 2 transactions**, with no separate reveal step required. `revealRandomness`/`revealRandomnessBatch` remain as an *optional* pre-warming path (e.g. a keeper wanting to front-load the first-reveal SSTORE cost ahead of a large batched construct call) — nothing requires calling them, and existing tests that do (all of `Game.test.ts`, `Lobbies.test.ts`, etc.) continue to work unchanged, since `fulfillRandomRequest` just returns the already-locked value in that case.

**API changes:** `IRandomManager.fulfillRandomRequest` is no longer declared `view` (it now writes state on first call) — this is load-bearing, not cosmetic: had the interface still declared it `view`, `Ships.sol`'s call through that interface type would compile to a `STATICCALL`, which reverts on any attempted state write. `canReveal`/`_canReveal` (old semantics: false once already revealed) were replaced with `canFulfill`/`canFulfillBatch` (true once `fulfillRandomRequest` would succeed, including when already revealed) — the question a caller actually needs answered before calling `constructShip` now. `NotYetRevealed`/`AlreadyRevealed` errors were removed as dead code — neither can be triggered through the new consumer-facing entry point. `requests` (the per-id `Request` struct mapping) changed from `private` to `public`, so a read-only caller (frontend, test) can inspect an already-locked result via `requests(id)` without needing a state-changing call — the same data was already emitted via `RandomnessRevealed`, so this exposes nothing new, just makes lookup by id direct.

**Residual risk, updated:** unchanged in kind from the original C-01/C-02 remediation's own residual-risk section — a patient caller can still choose *when* to trigger the one-time lock-in, previewing the current, already-public epoch's `prevrandao` for free and declining to act until a favorable one appears. This is inherent to any scheme built on caller-timed reveal rather than an external oracle (Chainlink VRF is the only way to remove it entirely) and applies identically whether reveal is a separate step or inline — collapsing the steps doesn't add to it. Given the ship-value distribution already discussed (99.9% under $1) and free construction removing any incentive to selectively abandon a bad roll, this residual is accepted as low-stakes, same conclusion as before, now resting on a design with fewer moving parts.

**Test/doc impact:** `test/RandomManager.test.ts` rewritten for the new API (`fulfillRandomRequest` reveal-on-first-call and idempotency, `canFulfill`/`canFulfillBatch`, `requests(id)` inspection) plus the existing batch-griefing regression tests, unchanged in intent. `Ships.sol`'s comment above its `fulfillRandomRequest` call updated to describe the new behavior. No other test files needed changes — every existing test that calls `revealRandomness` before constructing continues to pass, since that path is still fully supported. `docs/update/Frontend_Updates_2026-08-26.md`'s RandomManager section needs a rewrite to reflect the simpler flow (separate follow-up).

---

## Addendum — Growth Audit at Scale (2026-08-27)

**Assumed scale for this pass:** 100,000,000 total ships, 100 factions, a single player owning 1,000,000+ ships, 1,000,000 total games+lobbies. Method: enumerated every function across all contracts that returns a dynamic array or loops over a `EnumerableSet`/counter-indexed collection, then classified each by which of these four axes (if any) its size scales with, and whether growth is caller-bounded (safe) or tied to unbounded global/per-account state (not safe at this scale). This is a *view-function/off-chain-usability* audit, not an on-chain-safety one — every finding below was verified to have **no on-chain caller** (nothing in the contracts themselves invokes these functions), so none of this threatens a real transaction; it threatens the ability of a frontend, indexer, or wallet to ever successfully call these functions once the underlying collection is large, since standard RPC providers (Infura/Alchemy-style) commonly cap `eth_call` gas/response size well below what a very large ABI-encoded array requires.

### ~~GR-01 — `Ships.getShipIdsOwned` Has No Bounded Alternative, Unlike Every Other Per-Owner Getter in This Codebase~~

**File:** `contracts/Ships.sol:689-692`
**Severity:** High at the stated scale (1,000,000+ ships for one owner)
**Status:** Fixed 2026-08-27

```solidity
function getShipIdsOwned(address _owner) external view returns (uint[] memory) {
    return shipsOwned[_owner].values();
}
```

Returns the caller's *entire* lifetime ship holdings in one call. At 1M+ ships, the ABI-encoded response is tens of megabytes — this will fail against essentially every production RPC provider's response-size/gas cap, long before any theoretical block-gas-limit concern. Unlike the analogous per-player collections elsewhere in this codebase (see GR-05 below, and the already-resolved C-04 finding for `Game.getGamesForPlayer`), **there is no caller-bounded alternative for ships** — no `getShipsByIdRange`/paginated equivalent exists. `getShipsByIds(uint[] calldata)` exists but requires the caller to already know which ids to ask for, which is exactly what `getShipIdsOwned` was supposed to answer in the first place; a whale-scale owner has no on-chain path to enumerate their own holdings at all once this call stops working.

Notably, the *commented-out* `getShipsOwned` (Ship-struct version, `Ships.sol:696-703`) carries a `// TODO CRITICAL: This almost certainly needs to be paginated` note — the developer flagged this exact concern for that variant, but the **live, uncommented** `getShipIdsOwned` has the identical unaddressed risk with no such flag anywhere near it.

**Fix:** `Ships.sol` was already at ~297 bytes of headroom under the 24 KiB limit — not enough margin to safely assume a full bounds-checked paginated function (loop, offset/limit math, an extra memory array) would fit. Rather than guess, tried the smallest possible primitives first and measured: `shipsOwnedCount(address) view returns (uint)` (→ `shipsOwned[_owner].length()`) and `shipIdOwnedAt(address, uint) view returns (uint)` (→ `shipsOwned[_owner].at(_index)`), each a single storage read with no loop. Compiled cost: **+217 bytes** (23.717 → 23.929 KiB), leaving ~73 bytes to spare — fits, where a heavier paginated-array function likely would not have. Pagination now happens entirely caller-side: read `shipsOwnedCount`, then call `shipIdOwnedAt` for each index in the desired page (a JSON-RPC batch request handles this in one round trip, same technique used elsewhere in this doc to pull live chain data). `getShipIdsOwned` is untouched and still the right call for the common (small/medium collector) case. New test in `test/Ships.test.ts` confirms paging via the two primitives reconstructs the same set `getShipIdsOwned` returns. If a heavier one-call paginated getter is ever wanted, it belongs in a separate satellite contract calling these two primitives in a loop, not in `Ships.sol` itself, given the remaining margin.

### `NodeMap.getAllNodes` — ~~Grew With Total Content Across All Factions, Not Per-Faction~~ — Removed

**File:** `contracts/NodeMap.sol` (was lines 349-354)
**Severity:** Confirmed High via measurement (was estimated Medium) — see below
**Status:** Fixed 2026-08-27 — function removed entirely

**Measured, not estimated:** wrote `scratch/measure-getallnodes-gas.ts`, created real nodes at increasing scale, measured `getAllNodes()`'s actual gas via `estimateContractGas`. Cost is cleanly linear at **~19,000 gas/node** (10 nodes → 208,893 gas; 400 nodes → 7,704,848 gas — no quadratic blowup in this range, SLOAD cost dominates over memory expansion at these sizes). Extrapolating: **`getAllNodes()` exceeds Base's 30,000,000 block gas limit at roughly 1,580 total nodes across all campaigns combined.** At the scale this audit assumes (e.g. 100 campaigns × 30 nodes, or 30 × 100 — both are 3,000 nodes total, and the split between them is irrelevant since this function was never scoped by campaign) it needed **~57,000,000 gas — nearly double the block limit**, meaning it wasn't just expensive, it would flatly fail against any RPC provider capping `eth_call` at or near the block gas limit (the common default).

**Resolution:** confirmed with the project owner that an unscoped "every node in the game" read was never actually a real use case — every real caller already knows which campaign it's asking about. Rather than paginate or scope it, removed `getAllNodes()` entirely; `getNodesInCampaign(campaignId)` (already existed, already properly scoped, unaffected by this) is now the only way to enumerate nodes, paired with `getNode(nodeId)` per id. At the same 3,000-node scale, `getNodesInCampaign` + per-node reads cost ~570,000 gas for a 30-node campaign or ~1,900,000 gas for a 100-node campaign — trivial either way, confirming the campaign-scoped split is what actually matters, not the total node count. Removed the corresponding `getAllNodes` test in `test/NodeMap.test.ts` (coverage for `getNodesInCampaign` already existed independently) and updated `docs/singleplayer-frontend-integration.md` (the active base reference doc) to use the scoped call instead — older, already-superseded dated delta docs mentioning `getAllNodes()` were left as historical snapshots, consistent with how this doc handles doc staleness elsewhere (e.g. `enemyThreat`'s removal).

### ~~GR-02 — `AIEncounters.getAllAIShipConfigs` Grows With Total Content Across All Factions~~

**File:** `contracts/AIEncounters.sol` (original getter at lines 176-184)
**Severity:** Confirmed High via measurement (was estimated Medium) — see below
**Status:** Fixed 2026-08-27 — paginated alternative added

**Measured, not estimated — and it doesn't just get expensive, it fails outright.** Wrote `scratch/measure-getall-gas.ts` and `scratch/measure-getall-gas-extended.ts`, created real configs at increasing scale, measured `getAllAIShipConfigs()`'s actual gas via `estimateContractGas`:

```
configs=10    gas=218,809      (21,881/config)
configs=100   gas=2,069,734    (20,697/config)
configs=400   gas=9,524,887    (23,812/config)
configs=600   gas=15,593,621   (25,989/config)
configs=800   gas=22,541,262   (28,177/config)
configs=1000  → FAILS: "Transaction ran out of gas" — exceeds the 30,000,000
               block gas limit entirely; estimateGas can't produce a number
```

Unlike `getAllNodes()`'s cleanly linear cost, gas/config here climbs steadily (21,881 → 28,177 and rising) — likely `AIShipConfig`'s dynamic `name` string plus nested `Equipment`/`Traits`/`Colors` structs pushing memory-expansion cost into a more visible range sooner. **The break is confirmed empirically between 800 and 1,000 configs** — not a distant hypothetical: at the *already-observed* real growth rate (25 configs added per faction, confirmed in `faction-2.md`'s history — 50 total after just the second faction), this line gets crossed after roughly **32-40 factions**, well under a third of the way to the 100 this audit assumes.

**Resolution:** unlike `NodeMap.getAllNodes()`, this one has a real (if admin-only) documented use case — `docs/singleplayer-frontend-integration.md:125` recommends it for an admin fleet-editor's config picker when authoring new map placements. Rather than remove it, added a bounded alternative: `getAIShipConfigsPaginated(uint _offset, uint _limit)`, 0-indexed into the config sequence, returning fewer than `_limit` entries (down to empty) if the range runs past `aiShipConfigCount` rather than reverting — mirrors the pagination shape already used elsewhere in this codebase (`getGamesFromIds`, `getLobbiesFromIds`). `getAllAIShipConfigs()` itself is untouched and still fine at small/medium scale; admin tooling should move to the paginated form before config count approaches the low hundreds. New tests in `test/AIEncounters.test.ts` confirm paging through in full reassembles the same data `getAllAIShipConfigs()` returns, and that an out-of-range offset returns an empty array rather than reverting.

### ~~GR-02 — `Maps.getAllPresetMapIds` Grows With Total Content Across All Factions~~ — Not Actually a Risk, Confirmed by Measurement

**File:** `contracts/Maps.sol:612-618`
**Severity:** Downgraded to none — measurement showed the original "Medium, worsening" estimate was too pessimistic
**Status:** Reviewed 2026-08-27, no fix needed

Measured the same way (`scratch/measure-getall-gas.ts`): unlike the two `AIShipConfig`/`CampaignNode` full-struct getters above, this one returns bare `uint[]` ids, and its *marginal* cost per additional map stabilizes quickly and stays flat — not increasing:

```
mapCount=10   gas=27,212    (2,721/map, includes fixed overhead)
mapCount=100  gas=57,714    (577/map)
mapCount=400  gas=160,302   (401/map)
```

Marginal cost between samples is consistently ~339-343 gas/map (e.g. `(160302-91754)/(400-200) ≈ 343`), meaning a large fixed base cost (~24,000 gas) amortizing over a genuinely linear, small per-entry cost. Extrapolating that steady-state rate, it would take **~88,000 total preset maps** to approach the 30M block gas limit — even 100 factions authoring 100 maps each (10,000 total) costs only ~3.4M gas, trivial. No realistic content-authoring pace reaches this. Originally flagged as "the mildest of the three, but still unbounded" — the real numbers confirm it's not a practical risk at any scale this game will plausibly reach, so no fix is planned.

### ~~GR-03 — `Lobbies.getOpenLobbies()` Is a Global Set With No Expiry, Growing With Total Abandoned Lobbies~~

**File:** `contracts/Lobbies.sol` (original getter unchanged, at `getOpenLobbies`)
**Severity:** Medium — depends on real-world abandonment rate, but has no ceiling
**Status:** Fixed 2026-08-27 — both recommended fixes applied (plenty of headroom to do both, see below)

```solidity
function getOpenLobbies() public view returns (uint[] memory) {
    return openLobbyIds.values();
}
```

`openLobbyIds` is a single global set shared by every player, not scoped per-player. Traced every path that removes a lobby from it (`_removeLobbyFromOpenSet` — called from `leaveLobby`, `acceptGame`, `rejectGame`, `timeoutJoiner`, `quitWithPenalty`) — all of them require an **active participant** to take an action. A lobby whose creator opens it and simply never returns (no joiner ever arrives, creator never calls `leaveLobby`) has no timeout or permissionless sweep that removes it — it sits in `openLobbyIds` forever. At 1,000,000 total games+lobbies, even a modest abandonment rate (a few percent — free/no-stakes lobbies in particular are cheap to abandon) accumulates into a standing set of tens of thousands of entries that `getOpenLobbies()` must return in full every time, with no way for that number to ever go back down on its own.

**Fix — both recommended options, not just one:** `Lobbies.sol` had ~9 KiB of headroom under the 24 KiB limit (14.886 KiB before this change), so unlike `Ships.sol`'s GR-01 fix there was no need to pick just one approach.

1. **`pruneStaleLobby(uint _lobbyId)` (new, permissionless)** — removes a lobby from `openLobbyIds` once it's been open (unjoined) longer than `staleLobbyThreshold` (new state var, defaults to `7 days`). Deliberately narrow: only touches `openLobbyIds` membership — not `lobby.state.status`, not `playerLobbies`, not the creator's `PlayerLobbyState`. The lobby record itself is untouched and still directly joinable/leaveable exactly as before; this only delists it from the public open-browse list. Requiring current membership in `openLobbyIds` to even attempt a prune is also what guarantees the target has no joiner — `joinLobby` removes a lobby from this set the instant someone joins, so nothing reachable here ever had one.
2. **`setStaleLobbyThreshold(uint)` (new, `onlyOwner`)** — the 7-day default is adjustable without a redeploy.
3. **`getOpenLobbiesPaginated(uint _offset, uint _limit)` (new)** — bounded escape hatch for `getOpenLobbies` itself, same shape as `AIEncounters.getAIShipConfigsPaginated` (0-indexed, returns fewer than `_limit` rather than reverting past the end). `getOpenLobbies()` is untouched for small/medium scale.

Compiled cost: **+643 bytes** (14.886 → 15.514 KiB), leaving ~8.5 KiB of headroom — comfortably affordable to add both fixes together rather than choosing. New tests in `test/Lobbies.test.ts` (7 cases) cover: default threshold value, reverting before the threshold elapses, successful permissionless prune after it elapses (by an unrelated address), reverting `LobbyNotOpen` for an already-joined lobby (confirming the "never has a joiner" invariant), owner-adjustable threshold actually being enforced, non-owner rejection, and `getOpenLobbiesPaginated` reassembling the same data as `getOpenLobbies` when paged in full plus an empty-page-past-the-end case.

### ~~GR-04 — `Lobbies.getAllLobbiesForPlayerWithDupes` Compounds GR-03 With Full-Struct Payloads and Per-Player History~~

**File:** `contracts/Lobbies.sol` (was lines 786-804)
**Severity:** Medium-High — the worst single offender found in this pass
**Status:** Fixed 2026-08-27 — function removed entirely

Already flagged as I-07 in this document for returning duplicates (a correctness note, client-side dedupe required) — this was a *different* axis on the same function. It concatenated `playerLobbies[_player]` (unbounded per-player lifetime lobby count) with `openLobbyIds` (GR-03's unbounded global set), and — unlike GR-03's id-only return — fetched the **full `Lobby` struct** for every entry in both. This was strictly worse than either GR-03 or a hypothetical unbounded `getPlayerLobbies` alone: it inherited both axes of growth simultaneously, at the heavier per-entry payload.

**Resolution:** checked for any real use first, same as `NodeMap.getAllNodes()` (GR-02) — confirmed zero on-chain callers, zero test coverage, and zero mentions in any frontend integration doc, unlike its sibling `getPlayerLobbies` (16+ test call sites, actively used). Nothing was ever built against this function. Removed it entirely rather than paginating it — `getPlayerLobbies` (per-player history) and `getOpenLobbies`/`getOpenLobbiesPaginated` (global open set, now with GR-03's pruning on top) already cover both halves separately, without the accepted-but-awkward duplicate-and-dedupe-yourself contract this function required. `Lobbies.sol` shrank by ~949 bytes as a result (15.514 → 14.565 KiB, after GR-03's fixes were already applied).

### GR-05 — `Lobbies.getPlayerLobbies` Mirrors the Already-Resolved `Game.getGamesForPlayer` Pattern (C-04) — Same Conclusion Applies

**File:** `contracts/Lobbies.sol:786-789` (shifted after GR-03/GR-04's edits to this file; function itself unchanged)
**Severity:** Low — a safe, bounded alternative already exists — no fix planned, intentionally

```solidity
function getPlayerLobbies(address _player) public view returns (uint[] memory) {
    return playerLobbies[_player].values();
}
```

Same shape as `Game.getGamesForPlayer`, addressed in C-04 above: unbounded per-player history, but `getLobbiesFromIds(uint[] calldata)` already exists as the caller-bounded escape hatch (mirroring `Game.getGamesFromIds`). Per C-04's resolution: pagination lives off-chain — a frontend/indexer that wants a hard cost ceiling for a high-activity player should track lobby ids itself (via `LobbyCreated`/`LobbyJoined`-style event logs or a backend indexer) and call `getLobbiesFromIds` with a bounded batch, rather than relying on this convenience getter for whale-scale accounts. No code change needed; noted here only so this doesn't get rediscovered as a new finding.

### Reviewed, no issue found (checked against all four scale axes)

- **`GameResults.getTopPlayersByWins`** — already a non-functional stub (`return new address[](0);`) with an explicit comment acknowledging "this would require iterating over all players which could be gas-intensive." Confirmed not a live risk. It *is* a dead/misleading function today — any leaderboard feature will need real off-chain indexing infrastructure, not this getter, regardless of scale.
- **`SpecialEffectsLib.resolveAndApply`'s worst-case-allocate-then-truncate arrays** (see the hostile-actor-sweep-adjacent question this addendum follows up on) — sized to `game.getAllShipPositions(gameId).length`, hard-capped at 44 ships/side by the 17×11 grid's column restrictions in `Fleets.createFleet` (88/game absolute max) — independent of total ship supply, faction count, or total game count.
- **`AIShips.freeSlots`** — could in principle accumulate many entries over the lifetime of 1,000,000 games (released AI ship slots), but is only ever used as a stack (`push`/`pop` from the end) — every operation is O(1) regardless of array length, so this never becomes a growth risk no matter how large it gets.
- **`Tournament` brackets/registrant arrays** — capped per-tournament by admin-configured `maxPlayers` at creation time (`register` reverts `RegistrationFull` once `registrants.length >= maxPlayers`), not tied to global ship/game/faction counts.
- **`ShipAttributes`'s per-variant admin-config loops** (`setAllAttributes`/`setVariantAttributes`) — bounded by fixed-cardinality trait arrays (guns/armor/shields/specials, each ≤8 by enum size), not by faction count; each variant's attributes are set independently, one owner call per variant, not aggregated into a "loop over all variants" pattern anywhere.
- **`Fleets.createFleet`** — hard-capped at 44 ships/side regardless of total ship supply (see above) — this bound was already load-bearing for the hostile-actor sweep's `SpecialEffectsLib` question and holds equally here.
- **`RoguelikeNodeMap`** — never had a `getAllNodes()`-style global getter at all (unlike `NodeMap`, which had one and has since had it removed — see above), so it never shared this risk; its own `getNode`/`getChildren`/`getEdge` are all single-id or bounded-by-a-node's-own-edge-list lookups.

**Common thread across GR-01 through GR-05:** every finding is a `view` function nobody calls on-chain — the pattern this codebase already uses correctly for genuinely bounded collections (`getGamesFromIds`, `getLobbiesFromIds`, `getShipsByIds`, `getNodesInCampaign`) is the right fix wherever it's missing. None of this requires new access control or economic changes, just adding the caller-bounded-batch escape hatch consistently everywhere an "return the whole collection" getter exists next to a global or per-account counter.

---

## Addendum — Root-Caused and Fixed the Recurring `ShipCostsVersions.test.ts` Flake (2026-08-27)

**Not a contract finding — a test-data gap.** The "pre-existing, intermittent, unrelated flake" referenced throughout this document (first noted in the C-01/C-02 remediation addendum, recurring across several subsequent fixes' verification runs) was never root-caused before now — it was just something every full-suite run had to route around. Traced it down after being asked to fix it rather than keep noting it.

**Root cause:** `GenerateNewShip.sol` rolls `equipment.special` as `uint(keccak256(...)) % 8` — unlike `mainWeapon`/`armor`/`shields`, which all roll `% 4` — deliberately, per that file's own comment, "across the full fixed range, not just the first 4" (`Special` has 8 defined slots per faction, see `Types.sol`). Two tests in `test/ShipCostsVersions.test.ts` ("gives ships of different variants different hull points and special data" and "gives ships of different variants different weapon/armor/shield stats") configure variant 2 via `setVariantAttributes` with only **4** `specials` entries, then construct real ships and call `calculateShipAttributesById` on one of them. Whenever that ship's random roll landed on `special` slot 4-7 (a coin-flip-ish ~50% of the time per affected ship), `ShipAttributes.sol`'s `.specials[uint8(_ship.equipment.special)]` lookup panicked out-of-bounds on the 4-length array — the exact array-bounds shape already documented as M-04 above, except M-04 is about *production* config potentially under-provisioning these arrays; this was the *test's own* config under-provisioning them, unrelated to whether M-04 itself gets fixed.

**Fix:** extended both tests' `specials` arrays from 4 to 8 entries (slots 4-7 filled with the same inert zero values slot 0 already used — neither test's assertions touch those slots, they only ever check slot 1 or a ship's own rolled slot). No contract change — this doesn't reopen or affect the M-04 "won't fix" decision, which is specifically about whether *production* `setVariantAttributes` calls should be validated against the full 0-7 range; that remains a separate, still-open question.

**Verification:** ran the two affected tests in isolation 5 times in a row after the fix (`--grep "different variants"`) — 2/2 passing every time, no failures, where before this would fail roughly every other run. Full suite confirmed clean afterward with no other regressions.

---

## Addendum — Full Security Re-Review of the Session's Diff (2026-08-27)

**Scope:** every file actually changed this session (`RandomManager.sol`, `IRandomManager.sol`, `Ships.sol`, `ShipsRouter.sol`, `NodeMap.sol`, `AIEncounters.sol`, `Lobbies.sol`, `DeployAndConfig.ts`) — not the full historical repo diff. Ran via the `/security-review` skill's methodology: an independent pass to find vulnerabilities *newly introduced* by this session's changes specifically (as opposed to pre-existing issues already covered elsewhere in this document), then verified each candidate directly (read the code, and for the two real ones, reproduced the failure by temporarily reverting the fix and confirming a test catches it — same methodology used throughout this document).

### HA-02 — `RandomManager.revealRandomness` Dropped Its Request-ID Bounds Check

**File:** `contracts/RandomManager.sol` (the standalone `revealRandomness`, not `fulfillRandomRequest` or `revealRandomnessBatch`)
**Severity:** Low-Medium — confirmed real regression, but does not defeat the commit-reveal protection for actual ship construction
**Status:** Fixed 2026-08-27

When reveal was collapsed into `fulfillRandomRequest` (see the 2026-08-27 addendum above), the standalone `revealRandomness` — kept as an optional pre-warming path — lost the `if (_requestId == 0 || _requestId > requestCount) revert RequestNotFound();` guard that both `fulfillRandomRequest` and `revealRandomnessBatch` still have. For any never-issued id, `requests[_requestId]` reads as an all-zero-default struct; `_revealRandomness`'s own checks (`block.number <= 0`, `block.prevrandao == 0`) both trivially pass, so the call proceeds to compute and permanently store a "result" and emit `RandomnessRevealed` for a phantom id — for free, by any permissionless caller — directly contradicting this file's own header comment ("every id must have genuinely been issued by requestRandomness").

**Why it isn't worse than Low-Medium:** `fulfillRandomRequest`, `canFulfill`, and `canFulfillBatch` all independently re-check `requestCount` bounds before ever reading `revealed`, so `Ships.constructShip`'s actual flow can't be tricked by a phantom entry, and if that same id is later legitimately issued by `requestRandomness()`, the resulting full-struct overwrite erases the tampering. Net effect of the bug: junk storage writes and misleading events for an id nobody legitimately owns yet — a real validation regression, not a bypass of ship-construction security.

**Fix:** restored the missing bounds check to `revealRandomness`, identical to its siblings. `test/RandomManager.test.ts` gained a regression test (`revealRandomness` reverts `RequestNotFound` for id `0` and an unissued id); confirmed it fails without the fix and passes with it.

### GR-06 — `Lobbies.pruneStaleLobby` Measured Staleness From Original Creation, Not From Re-Entry Into the Open Set

**File:** `contracts/Lobbies.sol` (new function from the 2026-08-27 GR-03 fix, `pruneStaleLobby`)
**Severity:** Medium — real logic bug, but limited to browse-list discoverability, not fund loss or state corruption
**Status:** Fixed 2026-08-27

`pruneStaleLobby` checked `block.timestamp < lobby.basic.createdAt + staleLobbyThreshold` — but `createdAt` is set exactly once, at lobby creation, and is never refreshed by any of the paths that put a lobby back into `openLobbyIds` after it stops being unjoined (`leaveLobby`'s abandon/reset branches, `timeoutJoiner`, `quitWithPenalty`, `createLobbyForAddresses`). A lobby created 8+ days ago that goes through a completely ordinary join → leave cycle *today* re-enters `openLobbyIds` still carrying its 8-day-old `createdAt` — making it immediately, permissionlessly pruneable by anyone the instant it becomes open again, even though it hasn't sat idle at all. Direct-by-id `joinLobby`/`getLobby` still work regardless (matches the fix's documented "delist only" scope), so this degrades organic-matchmaking visibility rather than breaking anything load-bearing — but it's exactly the kind of pure-griefing, zero-cost-to-the-attacker vector this session's own "Assume Hostile Outside Actors" rule (`CLAUDE.md`) exists to catch, and it was introduced by the GR-03 fix itself, not a pre-existing issue.

**Fix:** added `mapping(uint => uint) public lobbyOpenedAt`, stamped inside `_addLobbyToOpenSet` (the single internal choke point every re-entry path already goes through — `createLobby`, both `leaveLobby` branches, `timeoutJoiner`, `quitWithPenalty`, `createLobbyForAddresses` all route through it, so no call site needed individual updates). `pruneStaleLobby` now checks against `lobbyOpenedAt[_lobbyId]` instead of `lobby.basic.createdAt`. `test/Lobbies.test.ts` gained a regression test that ages a lobby past the threshold, cycles it through join→leave, and confirms it's *not* immediately pruneable (only after the threshold elapses from the re-entry) — confirmed this test fails against the pre-fix code (reverted just the `pruneStaleLobby` check line, reran, got the exact wrong-immediate-success behavior) and passes with the fix restored.

### Reviewed, no issue found

- **`ShipsRouter`'s revert-unconditionally change** — confirmed via repo-wide grep that `DroneYard`/`ShipPurchaser`/`TutorialClaim`/`FreeShipClaim` are all wired directly to `Ships.sol` in `DeployAndConfig.ts`, never through `ShipsRouter`, and nothing calls `createShips`/`createSpecificShip`/`customizeShip` through any `IShips`-typed reference anywhere else in `contracts/`.
- **`IRandomManager`'s `view` → non-view change** — `Ships.sol` is the only consumer; its call site already sits inside a state-mutating function, so this is a pure, necessary signature correction (see the original 2026-08-27 addendum for why the mismatch would otherwise compile to a reverting `STATICCALL`).
- **`AIEncounters.getAIShipConfigsPaginated`, `Ships.shipsOwnedCount`/`shipIdOwnedAt`, `Lobbies.getOpenLobbiesPaginated`** — all thin, bounds-correct wrappers; no issues found.
- **Removal of `NodeMap.getAllNodes()` and `Lobbies.getAllLobbiesForPlayerWithDupes()`** — confirmed zero remaining callers anywhere in `contracts/`, `test/`, or `ignition/`.
- **`DeployAndConfig.ts`'s `PRODUCTION` flag now resting at `false`** — the gating logic itself is unchanged (only the boolean's committed value flipped, fixing the opposite mistake from before); flagged only as a known, already-documented process risk (someone could deploy for real without remembering to flip it back to `true`), not a new code defect. Already covered by this session's new `CLAUDE.md` rule requiring the flag be checked before every deploy.

**Test suite impact:** 2 new regression tests (one in each of `test/RandomManager.test.ts`, `test/Lobbies.test.ts`), both confirmed to fail against the pre-fix code and pass against the fix. Full suite reconfirmed clean afterward.

## Addendum — Selfie Check Verification Gap in `FreeShipClaimSelfie` (2026-09-11)

### ~~SC-01 — Unverified `claimFreeShips` Path Left Open, Making Selfie-Check Gating Non-Enforcing~~

**File:** `contracts/FreeShipClaimSelfie.sol`
**Severity:** Medium — deliberate, known, and explicitly deferred; not an oversight
**Status:** Resolved 2026-09-11 (see below) — was: Open, intentionally deferred, not yet resolved

`FreeShipClaimSelfie.sol` adds a backend-relayed, Selfie-Check-verified claim path (`claimFreeShipsVerified`, gated by an `authorizedVerifiers` allowlist and per-nullifier reuse tracking) alongside the original `claimFreeShips(uint16)`. Selfie Check has no on-chain verification path (confirmed against World's own docs — verification is an off-chain REST call, unlike Orb's on-chain `groupId=1` path `Tournament.sol` already uses), so the verified path necessarily relies on a trusted backend relayer rather than an on-chain proof check.

The original, fully unrestricted `claimFreeShips(uint16)` was deliberately left callable in this version, per explicit direction. That means the new verification machinery is not actually load-bearing yet: any caller can bypass Selfie Check entirely by calling the old function directly, exactly as before this contract existed. `FreeShipClaimSelfie` as it stands is infrastructure for the eventual gate, not the gate itself.

**Not yet decided (as of when this finding was written):** whether to eventually restrict or remove `claimFreeShips(uint16)` once the verified path is live and trusted, and if so, how to handle the resulting blast radius — the existing test suite (`test/Ships.test.ts`) calls `claimFreeShips` directly in numerous places and would need rework, and free-ship claiming would become hard-dependent on backend availability for the first time. Revisit before treating Selfie Check gating as an actual Sybil defense in the live product, not just a documented capability.

**Resolved 2026-09-11 — the architecture this finding describes no longer exists.**
`FreeShipClaimSelfie.sol` (the standalone "V2" contract with a separate `claimFreeShipsVerified`
function coexisting with the original unrestricted one) was deleted entirely, per direction. The
eligibility check was rebuilt directly into the *original* contracts instead — `FreeShipClaim.sol`'s
own `claimFreeShips` and `TutorialClaim.sol`'s shared `_markTutorialCompleted` (called by both
`completeTutorialWinPath`/`completeTutorialLossPath`) each check `eligibilityProvider` inline, with
no separate parallel function. Confirmed by re-reading both files directly: there is exactly one
entry point per claim type, not two. When no provider is wired (`address(0)`, today's default),
both stay open — the same "not configured yet" pattern already used elsewhere in this repo (e.g.
`FreeShipClaim.droneStorefront == address(0)`), not a gate with a bypass door. Once a real provider
is wired, both are genuinely, fully gated with no alternate path — there is nothing left to bypass
to. The "not yet decided" question above no longer applies in the form it was written; the one
remaining real question is purely a deploy-readiness one, tracked in
`docs/eth-global-remote-strategy-v2.md`'s Pick 2 section ("production deploy wiring doesn't exist
yet").

## Addendum — Admin/Backend Key Separation for Production Deploy (2026-09-11)

`ignition/modules/DeployAndConfig.ts` currently reuses a small number of hardcoded addresses across
many unrelated roles in the `PRODUCTION` branch:

- `MAP_EDITOR` — the `transferOwnership` target for every `Ownable` contract in the module (map
  editing, AI-encounter/node-graph editing, node-content publishing, *and* general contract
  ownership for everything else, since there's no separate "owner" wallet from "map editor" today).
- `FIREBASE_FLOW_MINTER` — authorized to mint ships directly (`Ships.setIsAllowedToCreateShips`)
  from the Firebase Flow backend, and, as of this session, also authorized as the
  `SelfieCheckEligibilityProvider` verifier (`setAuthorizedVerifier`) — one backend wallet now
  covers two independent trust roles (minting ships vs. asserting a player passed Selfie Check).

**This is a known, deliberate placeholder, not a final production layout.** Both addresses are
today's dev-time convenience values — reusing one wallet for several roles is fine for testing but
concentrates unrelated blast radii onto the same key once real value is at stake (e.g. the same
compromised key that can relay a false Selfie Check verification could, if it's also
`FIREBASE_FLOW_MINTER`, mint ships directly). The plan (per explicit direction) is to separate and
replace **all** admin/backend keys with distinct, purpose-specific keys before a real production
deploy — at minimum: a cold owner key (candidate: Ledger hardware signer, per the Uniswap-hook
design discussion elsewhere in this repo's docs) separate from any hot backend-relay key, and each
hot backend role (ship-minting, Selfie-Check verification, and any future backend-relayed role)
either on its own key or deliberately consolidated with an explicit acknowledgment of the combined
blast radius — not consolidated by default because no one has provisioned the separate keys yet.
Not yet done; tracked here so it isn't mistaken for a finished decision.

## Addendum — Hostile-Actor Full Audit Sweep (2026-09-12)

**Methodology:** requested explicitly as "a complete and thorough audit of all the contracts,
assuming a maximally hostile actor acting out of spite, malice, or profit — damage and theft both
acceptable outcomes." Four independent, parallel deep-dive passes covered every state-changing
contract in `contracts/` (excluding interfaces, mocks, `Types.sol`, and the `Renderers`/
`RenderersV2` directories — confirmed via `grep` that no renderer file has a single non-`view`/
`pure` external or public function, so they carry zero state-changing attack surface and were
excluded on that basis, not skipped for convenience). Each pass read this entire document first
and was instructed not to re-report already-triaged findings unless a prior resolution turned out
to be wrong. The two highest-severity findings below (**HA2-01**, **HA2-02**) were independently
re-verified line-by-line against the actual contract/library source by the coordinating session
after the fact, not just accepted from the sub-review; the remainder were spot-checked against the
cited lines. All findings are genuinely new — nothing below duplicates an existing entry, though
**HA2-01 reopens L-01** (see that entry above) and **HA2-07** re-evaluates an already-accepted
`RandomManager` risk in a new, higher-stakes context rather than reporting a new bug.

---

### HA2-01 — `Game._performShoot`/`calculateShipAttributes` let any player permanently freeze a live PvP match

**File:** `contracts/Game.sol`, `calculateShipAttributes` (lines 338-356), `_performShoot` (lines
770-837), `_removeShipFromGame` (lines 1138-1200), `_incrementReactorCriticalTimerForZeroHPShips`
(lines 1223+)
**Severity:** High — permanently, deterministically bricks a live match holding real NFT ships,
with only a lossy escape hatch (see below); zero cost to the attacker beyond ordinary play.
**Status:** Open — reopens L-01 above, whose "nothing ever reads a stray entry" resolution is
disproven by this finding.

`calculateShipAttributes(uint _gameId, uint _shipId)` is `public`, permissionless, and its only
guard is `if (attributes.version != 0) revert` — it never checks `_shipId` is actually a
participant of `_gameId`. `_performShoot` independently never checks
`game.shipPositions[targetShipId].status`, and only validates the target globally
(`_validateShipExistsAndNotDestroyed`, an existence/not-globally-destroyed check) plus an
owner-mismatch check — it never checks the target is actually in either fleet for this game.

**Exploit, verified end-to-end against the actual code (independently re-traced, not just taken on
report):**
1. Attacker (either player in active game `G`) picks any ship `X` owned by the opponent that has
   fled `G` earlier (an ordinary `Retreat`, which `delete`s `game.shipAttributes[X]`, resetting
   `version` to 0), or one that was never in `G` at all.
2. Attacker calls the public `calculateShipAttributes(G, X)`. This passes (X's slot is empty) and
   writes a fresh, full, non-zero `hullPoints`/`maxHullPoints` for `X` into `G`'s storage.
3. Attacker moves in range and calls `Shoot` at `targetShipId = X`. `_performShoot` passes every
   check it has (global existence, not globally destroyed, different owner, range/LOS against
   whatever position `X` happens to have in this game — defaults to `(0,0)` if never placed) and
   deals real damage, since `targetAttributes.hullPoints != 0` now.
4. Enough shots bring `X`'s (fictitious) HP to 0 (`_setShipHPToZero`), adding it to
   `game.shipsWithZeroHP`.
5. On the next two round transitions, `_incrementReactorCriticalTimerForZeroHPShips` increments
   `X`'s `reactorCriticalTimer` (0→1→2) — both succeed, since it only calls
   `_removeShipFromGame` once the timer reaches 3.
6. On the third round transition, the timer would go to 3, triggering
   `_removeShipFromGame(G, X, ...)`. That function reverts `ShipNotFound()` because `X` is in
   neither `game.metadata.creatorFleetId` nor `joinerFleetId` (confirmed directly: line 1159,
   `if (!isCreatorShip && !isJoinerShip) revert ShipNotFound();`). Since the revert unwinds the
   whole enclosing transaction, **the timer increment itself is rolled back too** — every future
   attempt to complete this round re-starts from timer==2, re-attempts the identical 2→3
   transition, and reverts identically, forever. The round can never complete again.

**Partial, lossy mitigation:** `PvPMatch.flee` → `Game.forceEndSession` → `_endGame` bypasses the
round-completion path entirely and unconditionally releases both fleets. A victim *can* recover
their ships this way — but `flee` unconditionally makes the fleeing player the **loser**, crediting
the attacker (or an unrelated bystander) with a win regardless of the actual board state. If
neither player accepts that forced loss, both players' ships stay locked indefinitely, including
via the owner's own `debugDestroyShip` (which also routes through `_removeShipFromGame` and hits
the identical revert).

**Recommended fix:** mirror the SP-02 fix already applied to `RamResolver`/`EMPResolver`/
`DroneSwarmResolver` — add a `game.shipPositions[_shipId].status == 0` (and ideally an
actual-fleet-membership) check to `_performShoot`'s target validation, and add an equivalent
active-participant check to `calculateShipAttributes` itself as defense in depth (this also fully
closes L-01, not just this specific chain into it).

---

### HA2-02 — `UTCLotteryHook._beforeInitialize` has no caller check — any third party can permanently hijack the pool lock

**File:** `contracts/UTCLotteryHook.sol`, lines 194-211
**Severity:** High — permanent, irrecoverable loss of the entire lottery feature for the real
pool; zero cost to the attacker; **directly relevant to this project's own imminent deploy.**
**Status:** Open — fix before running Phase 2 of `docs/deploy-runbook-uniswap-lottery.md`.

```solidity
function _beforeInitialize(
    address,                    // <- `sender`, discarded entirely, never checked
    PoolKey calldata key,
    uint160
) internal override returns (bytes4) {
    if (poolLocked) revert PoolAlreadyLocked();
    if (
        Currency.unwrap(key.currency0) != address(0) ||
        Currency.unwrap(key.currency1) != utcToken
    ) revert NotOurPool();
    lockedPoolId = key.toId();
    poolLocked = true;
    return BaseHook.beforeInitialize.selector;
}
```

Independently confirmed against the actual Uniswap v4 source
(`node_modules/@uniswap/v4-core/src/PoolManager.sol:117`): `PoolManager.initialize(PoolKey,
uint160)` is `external` with **no access control whatsoever** beyond `noDelegateCall`, and passes
the *real, original caller* as `sender` into the hook (`node_modules/@uniswap/v4-core/src/
libraries/Hooks.sol:178-182`: `self.callHook(abi.encodeCall(IHooks.beforeInitialize,
(msg.sender, key, sqrtPriceX96)))` — an internal library call, so `msg.sender` here is whoever
called `PoolManager.initialize` externally, not `PoolManager` itself).

**Exploit:** `scripts/deployUTCLotteryPool.ts` deploys the hook (step 7) and calls
`PoolManager.initialize` (step 11) as **two separate transactions**, with UTC-sourcing/approval/
liquidity-math steps in between — a real, multi-transaction window against the live, shared Base
Sepolia `PoolManager`. The hook's address is necessarily mineable/predictable in advance (that's
the whole point of `scripts/hookMiner.ts`), and its deployed bytecode is public the instant the
deploy transaction lands. Any third party — not just someone targeting this project specifically,
but a bot that squats freshly-deployed hook addresses on a public testnet purely to grief for
fun — can call `PoolManager.initialize(key, sqrtPriceX96)` directly with the correct
`currency0 = address(0)` / `currency1 = utcToken` pair (the only thing `_beforeInitialize`
checks) but an attacker-chosen fee tier, tick spacing, and price. This passes every check and
permanently sets `poolLocked = true` / `lockedPoolId` to the attacker's bogus, liquidity-free
pool. **There is no owner reset/unlock function for `poolLocked`/`lockedPoolId`** — this
permanently and irrecoverably bricks the entire lottery feature for the project's real pool. The
deploy script's own header comment ("no on-chain fix for a wrong key... mine and deploy a fresh
hook") only anticipated *accidental* self-misconfiguration by the project's own deploy, not a
hostile third party racing it.

**Recommended fix:** check `sender == owner()` (or an explicit allowlist) in `_beforeInitialize`
before locking — this is a one-line fix and should happen before Phase 2 of the deploy runbook
ever runs for real. Alternatively/additionally, restructure the deploy so hook-deploy and
pool-initialize happen atomically in one transaction (e.g. a multicall, or having the hook itself
call `initialize` from its own constructor/an owner-only function), removing the exposure window
entirely regardless of the access-control fix.

---

### HA2-03 — `Ships.setInFleet` doesn't check `timestampDestroyed`, letting a destroyed ship re-enter a fleet and become an unkillable "ghost" in a new match

**File:** `contracts/Ships.sol`, `setInFleet` (lines 410-424)
**Severity:** High — freezes a *different* live match (not the one the ship died in) via the same
`ShipDestroyed()` revert-wall consequence as HA2-01, through an entirely separate root cause.
**Status:** Open.

```solidity
function setInFleet(uint _id, bool _inFleet) external {
    if (msg.sender != config.lobbyAddress && msg.sender != config.gameAddress && msg.sender != config.fleetsAddress)
        revert NotAuthorized(msg.sender);
    ships[_id].shipData.inFleet = _inFleet;
    ...
}
```
Never checks `ships[_id].shipData.timestampDestroyed`, which is permanent once set (`markDestroyed`/
`recordKill` never clear it). `Ships._update` blocks *transferring* a destroyed ship, but nothing
blocks it being flagged `inFleet = true` and reused by its own owner.

**Exploit:**
1. Player A's ship #100 is destroyed in Game 1. The NFT is never burned; A still owns it.
2. A submits #100 into a fresh fleet for Game 2. `Fleets.createFleet` only checks owner match,
   `inFleet`, cost/version, variant — never `timestampDestroyed` — so it's accepted.
   `Game.startGame` computes fresh, full-health attributes for #100 with no destroyed check
   anywhere in the path. #100 now fights normally in Game 2.
3. The moment anyone triggers `_removeShipFromGame` for #100 in Game 2 (a killing blow, or A
   retreating it), the call reverts `ShipDestroyed()` (`Game.sol:1148`,
   `if (_ship.shipData.timestampDestroyed != 0) revert ShipDestroyed();`) — permanent, since
   nothing ever clears the flag. Every transaction that would finish or retreat #100 in Game 2
   reverts identically, forever, denying the opponent a kill/elimination-based resolution and
   risking the same round-completion freeze as HA2-01 if #100 is queued via the zero-HP timer path.

Confirmed this does **not** enable reward double-farming (a second `markDestroyed`/
`setTimestampDestroyed` call on the same globally-destroyed ship reverts before any reward
payout), so the confirmed consequence is match-freeze/denial, not token theft.

**Recommended fix:** add a `timestampDestroyed == 0` guard to `Ships.setInFleet` when
`_inFleet == true` — the single chokepoint every fleet-entry path already routes through.

**Related, lower-severity data bug found alongside this:** `Ships._update` (lines 431-474) never
resets `ship.owner` to `address(0)` on burn (`ship.owner = to;` only runs `if (to != address(0))`)
— `getShip(id).owner` for a burned ship still shows the pre-burn owner. Not independently
exploitable today (a burned ship's `timestampDestroyed` is always set too, hitting the same
`ShipDestroyed()` wall as above), but any future code trusting `ship.owner` without also checking
`timestampDestroyed`/real ERC-721 existence would treat a burned, non-existent NFT as live.
Severity: Low/Informational — worth closing given how much cross-contract trust in this repo reads
`ship.owner` rather than `ownerOf()`.

---

### HA2-04 — `RoguelikeMatch.enterResupplyNode` doesn't check for an in-flight combat game, letting a player detach `run.currentNodeId` from the node actually being fought

**File:** `contracts/RoguelikeMatch.sol`, `enterResupplyNode` (lines 246-257), compounded by
`onGameEnded` (387-499) and `RoguelikeResupply.sol`'s `_requireAtResupplyNode`/`resupplyRepair`/
`resupplyModifyRoster` (101-208)
**Severity:** High (structural — see caveat) **Status:** Open.

`retreatRun(0)` was hardened under SP-05 to revert `ActiveGameInProgress` if `run.activeGameId !=
0`. `enterResupplyNode` was never given the same guard:
```solidity
function enterResupplyNode(uint _targetNodeId) external {
    Run memory run = runLedger.getRun(msg.sender);
    if (run.status != RunStatus.Active) revert NoActiveRun();
    RoguelikeNode memory node = _commitToNode(msg.sender, run, _targetNodeId);
    ...
}
```
`_commitToNode` only checks graph adjacency/locks, never `run.activeGameId`. `enterCombatNode` is
naturally protected from double-entry because roster ships are still `inFleet == true` in the live
game's fleet (`Fleets.createFleet` reverts `ShipAlreadyInFleet`) — `enterResupplyNode` touches no
fleet/ship state at all, so nothing stops it.

**Exploit, verified against the actual seeded campaign content (`ignition/data/
roguelikeStarterContent.json`):**
1. Player calls `enterCombatNode(m05, …)` → game `G1` created, `run.activeGameId = G1`,
   `run.currentNodeId = m05`.
2. **Without resolving `G1`**, player calls `enterResupplyNode(r01)` — `r01` is `m05`'s real
   forward child in the deployed content, so it succeeds: `run.currentNodeId` becomes `r01` while
   `G1` is still open.
3. Player finishes `G1` (wins it). `onGameEnded(G1, player, …)`'s stale-callback guard checks only
   *which game* (`run.activeGameId == G1`), not *which node* — it still passes.
4. `runLedger.setNodeDefeated(player, run.currentNodeId)` marks **`r01`** (the Resupply node) as
   defeated, not `m05` (the fight actually won). `isFinalNode`/win-effects also evaluate against
   `r01`'s data, not `m05`'s.

In the currently-seeded content every Resupply node has exactly one forward child and no
`twoWay` edges exist, so the two most severe consequences (an instant full-campaign win if the
wrong node happens to have zero children; reopening the SP-05 farming fix if a `twoWay` edge ever
lets the player walk back to the real, still-not-marked-defeated fight) aren't reachable *today* —
but the wrong node's `defeated` flag and win-effects fire unconditionally, every time, regardless
of content shape. `RoguelikeResupply.resupplyRepair`/`resupplyModifyRoster` share the same missing
guard.

**Recommended fix:** add `if (run.activeGameId != 0) revert ActiveGameInProgress();` to
`enterResupplyNode` (and consider the same in `RoguelikeResupply`'s two functions), mirroring
`retreatRun(0)`'s existing guard. Treat as urgent before any campaign content adds a `twoWay` edge
or a leaf Resupply node — both of which this codebase's own design already treats as normal,
expected content shapes.

---

### HA2-05 — `Lobbies`: `reservedJoiner` is never cleared outside `acceptGame`/`rejectGame`, letting an invited player permanently lock — or, after a creator-leave promotion, permanently brick — a lobby

**File:** `contracts/Lobbies.sol`, `joinLobby` (384-436, no reset), contrast `acceptGame` (455-459,
which does reset it). Also `leaveLobby` (187-271), `timeoutJoiner` (490-532), `quitWithPenalty`
(642-688) — none clear it either.
**Severity:** Medium **Status:** Open.

A `reservedJoiner` can join via plain `joinLobby` (permitted when `msg.sender ==
reservedJoiner`) as well as via `acceptGame` — but only `acceptGame` clears the field afterward.
Every path that later reopens the lobby (`leaveLobby`'s branches, `timeoutJoiner`,
`quitWithPenalty`) resets `joiner`/state back to "open" but leaves the stale `reservedJoiner`
value in place.

**Exploit:**
1. Alice `createLobby(..., reservedJoiner: Bob)`, paying the UTC reservation fee.
2. Bob `joinLobby(lobbyId)` (permitted; does not clear `reservedJoiner`).
3. Bob immediately `leaveLobby` (or just never submits a fleet until `timeoutJoiner`). The lobby
   resets to `Open`, but `reservedJoiner` still equals Bob.
4. Any other player who now calls `joinLobby` gets `NotReservedJoiner()` — the lobby is
   permanently locked to Bob, at zero further cost or obligation to him. Only Bob can release it.

Cost to attacker: two cheap transactions, no ETH, repeatable against Alice every time she tries to
invite him again. **Worse variant:** if Alice (the creator) is the one who leaves after Bob has
joined, `leaveLobby` promotes Bob to creator — but `reservedJoiner` still equals Bob, now literally
equal to the lobby's own creator. Since `joinLobby` also blocks `creator == msg.sender`, **no
address can ever join this lobby again** — it's permanently dead.

**Recommended fix:** clear `lobby.players.reservedJoiner = address(0)` in `joinLobby` right after
consuming a reservation, and in every path that resets a lobby back to genuinely public "open."

---

### HA2-06 — `UTCLotteryHook` entry "weight" is gameable via a flash-loan round-trip

**File:** `contracts/UTCLotteryHook.sol`, `_recordSell` (265-297)
**Severity:** Medium (confidence: mechanism is sound; real profitability depends on pool depth
relative to prize value at deploy time, which can't be assessed from the contract alone).
**Status:** Open — informational for now, worth re-checking once real liquidity depth is set.

Weight = a single sell's realized ETH proceeds, with no requirement that the capital be retained
afterward. An attacker can flash-borrow UTC, sell it for ETH in one swap (registering a large
weight to any address via `hookData`), then buy back the borrowed UTC in a following swap
(`zeroForOne = true`, which earns no entry) to repay the loan — paying only the round-trip
fee/slippage rather than the full economic cost of holding that capital. This lets a
well-capitalized-for-one-block (not well-capitalized-in-general) attacker dominate a draw's odds
cheaply if the pool is shallow relative to the flash-loanable UTC/ETH supply. Cost scales with
pool depth (deeper pool → smaller relative slippage cost → cheaper to game), so this is directly
actionable via the real liquidity-seeding decision in `docs/deploy-runbook-uniswap-lottery.md`.

---

### HA2-07 — `Tournament.buildBracket()`'s seed shuffle inherits `RandomManager`'s already-documented "patient caller can preview and choose" risk, now exposed to real prize money

**File:** `contracts/Tournament.sol`, `buildBracket`/`_shuffleSeeds` (340-354, 588-606)
**Severity:** Medium (mechanism confidence: high; real-world severity: depends on prize-pool size
and how quickly a keeper calls `buildBracket`). **Status:** Open — re-evaluation of an existing
accepted risk, not a new bug.

This is new/unaudited territory — the existing T-01–T-05 findings predate `buildBracket()`/
`_shuffleSeeds` entirely. `buildBracket` is permissionless and calls
`randomManager.fulfillRandomRequest()`, whose result is a deterministic function of the
currently-public `block.prevrandao` once the entropy epoch has rolled over — `RandomManager.sol`'s
own header comments already document and accept that a patient caller can simulate outcomes
off-chain for the current epoch and simply decline to submit until a favorable one appears. That
acceptance was reasoned about for near-worthless ship construction ("99.9% of ships worth under
$1"). `Tournament` prize pools (entry fees × N, plus uncapped sponsor contributions) are a
materially different stakes context that was never re-evaluated against this same mechanism.
Recommend the project owner explicitly re-confirm whether the existing `RandomManager` risk
acceptance still holds now that it gates real prize money via `Tournament`, rather than assuming
the original ship-construction reasoning still applies.

---

### HA2-08 — `RepairResolver`/`RepairDronesResolver` missing the SP-02 target-status check (currently inert, but relies on an assumption HA2-01 disproves)

**File:** `contracts/RepairResolver.sol` (51-83), `contracts/RepairDronesResolver.sol` (51-86)
**Severity:** Low/Informational. **Status:** Open.

Unlike `RamResolver`/`EMPResolver`/`DroneSwarmResolver` (all patched under SP-02 with
`if (target.status != 0) revert ...`), these two heal-only resolvers check only `target.shipId ==
0` and friend/enemy, never `target.status`. Today this is inert: healing a stale/ghost target
computes `healCap` from `maxHullPoints`, which is `0` for a `delete`d ghost, so the heal clamp
never actually changes anything. **HA2-01 demonstrates that `maxHullPoints == 0` is not a reliable
assumption** — `calculateShipAttributes` can revive a ghost's `maxHullPoints` to a real, non-zero
value. Recommend adding the same `target.status != 0` check here for consistency and
defense-in-depth, independent of HA2-01's own fix.

---

**Summary for prioritization:** HA2-02 is the most time-sensitive — fix before Phase 2 of
`docs/deploy-runbook-uniswap-lottery.md` ever runs against a real network. HA2-01/HA2-03/HA2-04 are
the most severe for the core game (all three follow the same shape as the already-fixed SP-02: a
missing status/membership check that lets a hostile player permanently freeze or miscredit a live
match) and should be fixed together, likely in one pass given how similar the fix pattern is.
HA2-05/HA2-06/HA2-07 are real but lower urgency. HA2-08 is cheap defense-in-depth to bundle with
HA2-01's fix.

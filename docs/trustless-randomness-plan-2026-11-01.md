# Plan: Ship Randomness With No Privileged Re-Roll (audit-4 HA7-10)

_Written 2026-11-01. **Implemented 2026-11-01** with D1 = the simple baseline (Generic weapon, no armor/shields, no special, name/colors from the serial number), D2 = the lottery hook's `afterSwap`, D3 = 2, D4 = keep Tournament's reroll. RandomManager also lost `Ownable` (no owner function left). Frontend instructions, including the optional 4-hour-idle `capturePending` keeper, are in `frontend-handoff-2026-10-30.md` §11. The rest of this doc is the plan as written. It describes `RandomManager`, `Ships`, `GenerateNewShip`, `Tournament` and `UTCLotteryHook` as of `653a918` plus the uncommitted HA7 fixes._

## 1. Goal

Remove every way to re-roll a ship's randomness. That means the player's "preview, let it expire, get a new roll" option (HA7-10), and also the owner-only `retargetExpired` (the known HA6-19 gap). It has to work without any privileged service: no backend reveal job, no admin action.

## 2. Why the current design has the option

A ship's result is `keccak256(blockhash(mint block), requestId)`. Four things combine into a free option:

1. **Knowable early:** the result can be computed one block after the mint.
2. **Final only later:** it becomes final in a later transaction (`constructShip` or any reveal).
3. **Withholdable:** the owner can simply not send that transaction.
4. **Re-rolled on expiry:** after the 8,191-block window (about 4.5 hours on Base) a request expires, and the only way forward, `retargetExpired`, is a fresh roll.

A rational owner keeps good rolls and lets bad ones expire. Best of two roughly doubles every rare outcome: shiny 9% → 17%, rank 4+ 5% → 10%, all top-tier traits 0.8% → 1.6%. Everyone who cares about value takes the option, so rarity is diluted and the players who don't use it lose out.

A trustless fix has to break point 3 or point 4 inside the contracts. This plan breaks both.

## 3. Design

### 3a. Everyday activity captures block hashes (breaks point 3)

RandomManager keeps a queue of the blocks that have pending requests, and stores each block's hash as soon as any later RandomManager call can read it:

- **New storage:**
  - `mapping(uint => bytes32) blockSeed`: block number to its stored hash.
  - `uint64[] pendingBlocks` plus `uint pendingHead`: a FIFO of blocks with requests, four block numbers per slot.
  - `uint lastRequestBlock`: so a pack of ships minted in one block queues that block once.
- **`requestRandomness`:** if `block.number != lastRequestBlock`, it pushes `block.number` onto `pendingBlocks`.
- **`_capture(maxBlocks)`:** walks the queue from `pendingHead`. For each block number `b < block.number`:
  - if `BlockHashLib.get(b)` is readable, it stores it in `blockSeed[b]`;
  - if it's no longer readable (the block expired before anyone captured it), it skips the block and leaves `blockSeed[b]` at zero.
  - It stops at the first block that isn't sealed yet, or after `maxBlocks` blocks.
- **Who triggers `_capture`:**
  - every `requestRandomness`, which is every mint of every kind: purchases, free claims, lottery prizes, ship grants, tutorial claims;
  - every `fulfillRandomRequest` (each construct, and Tournament's `buildBracket`);
  - `revealRandomness` / `revealRandomnessBatch`;
  - a new permissionless `capturePending(uint maxBlocks)` that anyone can call. It never needs a privileged caller.
- **Extra trigger (decision D2):** `UTCLotteryHook.afterSwap` calls `capturePending(2)` under try/catch with a code-length check, so it can never revert a swap. Swaps are the game's most frequent transactions, and the hook has about 12 KiB of room.
- **Reads use the stored hash first:** `_revealOrGet` uses `blockSeed[b]` if it's set, otherwise `BlockHashLib.get(b)`. Once a block's hash is stored, every request from that block can be fulfilled forever, on its original roll.

**Attacker's view:** to dodge capture, a player needs about 4.5 hours in which nobody mints, constructs, reveals, enters a tournament or swaps on the pool, and the player can't do any of those themselves either. They can't stop other players' transactions. Anyone, including another player or a community bot, can also call `capturePending` at any time, but nothing depends on someone doing so.

### 3b. Expired requests get a baseline ship, not a new roll (breaks point 4)

For the quiet periods 3a can't cover:

- **No more re-rolls:** `retargetExpired` is deleted, so nothing produces a new roll for an existing request.
- **Expired requests stay expired:** `fulfillRandomRequest` keeps reverting `RequestExpired` for an expired, uncaptured request, so Tournament's existing permissionless `rerollBracketShuffle` path still works for tournaments (§5).
- **Ships builds a baseline instead:** before fulfilling, `Ships.constructShip` asks `randomManager.isExpired(serialNumber)`. That now means "uncaptured and past the window". If it's true, Ships builds the ship through a new `GenerateNewShip.generateBaselineShip(id, serialNumber, variant)`, so the baseline code doesn't land in Ships.sol.
- **The baseline is never better than a random roll:** that's what makes the option worthless.
  - **Traits:** accuracy, hull and speed are all tier 0.
  - **Shiny:** never.
  - **Rank:** rank 1 with the minimum kills (1), unless the purchase tier already preset `shipsDestroyed`. A preset is fixed at purchase and doesn't depend on the roll, so keeping it gives no option.
  - **Equipment:** main weapon, armor/shields and special come from decision D1. The default proposal is enum value 0 for each, and `Special.None`.
  - **Name and colors:** derived from `keccak256("baseline", serialNumber)`. They're cosmetic and fixed at mint, and colors don't affect shiny or stats. Decision D1 also covers fixing them to constants instead.

**Game-theoretic result:** abandoning a roll now gives a known outcome that's never better, so withholding is never worth it, and nobody ever has a reason to let a request expire on purpose. An honest player who forgets to construct during a fully quiet 4.5 hours gets a plain ship. That should be rare with 3a in place, and it doesn't depend on anyone acting.

### 3c. What doesn't change

- The roll itself: block hash of the mint block, mixed with the request id.
- Reveal stays permissionless and can't change outcomes.
- The batch functions still tolerate ids that are already revealed.
- Tournament's shuffle request and the lottery's own `drawSeed` (HA7-09) stay separate mechanisms.

## 4. Changes by contract

| Contract | Change | Size impact |
|---|---|---|
| `RandomManager` | Add `blockSeed`, `pendingBlocks`/`pendingHead`/`lastRequestBlock`, `_capture` and `capturePending`. Hook capture into `requestRandomness`, `fulfillRandomRequest` and the reveal functions. `_revealOrGet` reads `blockSeed` first. Delete `retargetExpired` and `RandomnessRetargeted`. `isExpired` becomes "unrevealed, uncaptured, past the window". Update the header comment, which still describes the admin retarget. | Small contract, ample room |
| `IRandomManager` | Add `capturePending`. | — |
| `Ships` | `constructShip`: if `isExpired(serial)`, use `generateBaselineShip`, otherwise the current path. Fix the stale `prevrandao` comment above the fulfill call. | Estimated ~80–150 bytes (22.876 KiB today, ~1.1 KiB headroom) |
| `GenerateNewShip` / `IGenerateNewShip` | Add `generateBaselineShip(id, serialNumber, variant)`, reusing the name and color code with a fixed seed and setting the rarity fields to the baseline. | Ample room |
| `UTCLotteryHook` | In `afterSwap`, after the existing lottery work: `try randomManager.capturePending(2) {} catch {}` with a code-length check. Needs a RandomManager address, set at deploy and locked like its other wiring (decision D2). | ~12.1 KiB, ample |
| `Tournament` | No logic change. Its `rerollBracketShuffle` keys off `isExpired`, which now means uncaptured, so a captured shuffle can always be built. | — |
| `DeployAndConfig.ts` | Wire the hook's RandomManager address (D2). Remove any `retargetExpired` usage in scripts. | — |

## 5. Tournament check

The tournament shuffle request is captured like any other, so `buildBracket` works for as long as `SHUFFLE_REVEAL_WINDOW` allows. `rerollBracketShuffle` still only fires after that deadline, or for an uncaptured expired request. Both are permissionless already, and one registrant withholding `buildBracket` can't stop another registrant from calling it. Behaviour is unchanged, except that capture makes expiry less likely.

## 6. Gas (estimates, to be measured)

Each capture is one history read (~2.6k with EIP-2935) plus one fresh storage write (~22k) per captured block. The queue push is ~22k for the first mint in a block per storage slot, with four blocks per slot (so ~5.5k amortized). With `maxBlocks = 2`:

- **Mint transaction:** about +25–50k on top of a pack mint (today several hundred thousand gas).
- **Construct:** about +0–50k, usually 0 when the block was already captured by someone else.
- **Swap:** about +0–50k, only when something is pending. Measure it against the hook's `autoResolveMinGas` budget and the swap gas the frontend sends.

GasBudget doesn't cover mints or swaps. Add a measurement there, or in the existing Ships/lottery tests.

## 7. Tests to add

1. **Captured on time:** a request captured by a later mint (another player) is fulfilled after the window on its original roll. Do the same with capture by construct, by `capturePending`, and by a lottery swap.
2. **Same-block packs:** a pack minted in one block is captured as one block. Every ship in it is fulfilled on its own `keccak(hash, id)`.
3. **Expired uncaptured:** mine past the window with no triggering transaction. `isExpired` is true, `constructShip` builds the baseline, and `fulfillRandomRequest` still reverts `RequestExpired`.
4. **Baseline dominance:** for every variant, the baseline's traits, rank, shiny and special are at or below every possible random roll. Assert the specific values from D1.
5. **Purchase-tier rank preset:** a preset rank survives baseline construction.
6. **No re-roll entry points:** `retargetExpired` is gone (ABI check). No function produces a second roll for a request.
7. **Bounded capture:** `capturePending` walks at most `maxBlocks` blocks, skips expired blocks and stops at the first unsealed block. A queue backlog from many quiet blocks drains over later calls.
8. **Swaps never revert:** with RandomManager unwired or reverting, swaps still succeed.
9. **Tournament:** `buildBracket` and `rerollBracketShuffle` pass their existing tests unchanged.

## 8. Frontend impact (for the handoff doc)

- **The "awaiting admin" state goes away:** the 2026-10-16 handoff's admin re-target state for expired ships no longer applies. An expired ship can always be constructed, as a baseline ship.
- **Warning:** show a "construct soon" warning while `canFulfill(serial)` is true and the window is running out. For expired ships, show "builds as a basic ship" from `isExpired(serial)`.
- **Removed:** anything that read `retargetExpired` or `RandomnessRetargeted`.

## 9. Decisions needed before implementing

- **D1: the baseline ship.** Confirm traits tier 0, rank 1 (minimum kills, keeping any purchase preset), not shiny, `Special.None`. Choose the weapon and armor/shields: enum 0, or a specific weakest pick per variant. Choose whether the name and colors are deterministic from the serial number or fixed constants.
- **D2: capture triggers beyond RandomManager's own calls.** The lottery hook's `afterSwap` is recommended. Optional: `Fleets.createFleet` or Lobbies actions. Game is excluded for size.
- **D3: `maxBlocks` per call.** 2 is proposed: it keeps up with steady activity and drains a backlog over a few calls.
- **D4: Tournament.** Keep its reroll path as is (proposed), or move it to a baseline-style rule as well.

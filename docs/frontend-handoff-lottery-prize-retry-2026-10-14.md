# Frontend Handoff — Lottery Draw and Prize Delivery Changes

_Written 2026-10-14. These changes are not deployed yet; they take effect at the next redeploy of Ships, VariantPurchaseGate and UTCLotteryHook. Background: `docs/audit-3.md` HA6-04 to HA6-07. This doc supersedes `uniswap-lottery-selfie-check-frontend-integration.md` §4.5–4.6 and the `PrizeMintFailed` note in `frontend-handoff-engine-registry-and-redeploy-2026-09-30.md` §6._

## How a draw works now

1. **Entries:** qualifying UTC→ETH sells enter the current draw (`currentDrawId`), unchanged.
2. **Close:** the first swap after `drawInterval` (24h) with at least `minParticipants` entrants **closes** the draw.
   - It emits `DrawClosed(drawId, closeBlock, totalWeight)`.
   - Entries freeze, and `currentDrawId` moves to the next draw.
   - The winner is already decided by the close block's hash, but nobody can know who it is until that block is sealed.
3. **Resolve:** the draw resolves automatically during the next swap in any later block, which mints the prize and emits `DrawResolved` or `DrawResolvedNoWinner`.
   - If no swap with enough gas comes along, anyone can call `resolveDraw(drawId)`. The result is the same whoever calls and whenever they call.
   - If nothing resolves the draw within 8191 blocks (about 4.5 hours on Base, using EIP-2935; 256 blocks without it), the next attempt re-targets it to a new block and emits `DrawRetargeted(drawId, closeBlock)`. Resolving again after that works normally. _(Window extended 2026-10-16; was 256 blocks.)_

Prize ships are minted directly to the winner, with no claim step. Any address can win any ship, including gated variants, and contract wallets without an ERC-721 receiver hook can receive them.

## Frontend changes needed

- **Events:**
  - Listen for `DrawClosed` instead of `DrawStarted` (`useUtcLotteryHook.ts` `LOTTERY_EVENTS`).
  - Optionally listen for `DrawRetargeted` too.
  - `PrizeMintFailed` no longer exists.
- **Resolve button (`UtcLotteryPanel.tsx`):**
  - It currently passes `currentDrawId`, which is the open draw and is never resolvable.
  - Use `nextDrawToResolve()`. A draw is pending when `nextDrawToResolve() < currentDrawId()` and `!drawResolved(id)`.
  - Show the button while a draw is pending. It's a fallback; normally the next swap resolves the draw.
- **Revert reasons to surface on `resolveDraw`:**
  - `DrawNotClosed(id)`
  - `DrawNotReady(id)`: same block as the close; retry in the next block.
  - `DrawAlreadyResolved(id)`
  - `MintPaused()`: Ships paused; retry later.
  - Out of gas: let the wallet estimate; resolution uses up to about 600k gas.
- **Swap gas when a draw is pending (optional):** automatic resolution only runs in a swap with at least `autoResolveMinGas()` (default 1,000,000) gas left. Wallet gas estimation will normally size a swap below that, so the swap succeeds but skips resolving. If your swap UI wants its swaps to resolve pending draws, set a gas limit of about `autoResolveMinGas + 300,000` while a draw is pending.
- **Removed reads:** `drawRandomRequestId` and `randomManager`. Use `drawCloseBlock(drawId)` instead (0 means not closed).

## ABI summary

- **UTCLotteryHook:**
  - **Added:** `drawCloseBlock`, `drawEffectiveTotalWeight`, `nextDrawToResolve`, `autoResolveMinGas`, `setAutoResolveMinGas`, `DrawClosed`, `DrawRetargeted`, `DrawNotClosed`, `DrawNotReady`, `drawSegmentCount(drawId)`, `getDrawSegment(drawId, i) returns (owner, end)`.
    - _Segments added 2026-10-15:_ each segment is one slice of a draw's ticket range. A player can own several segments, and their slices sum to their `weightInDraw`. The segments are useful for showing or verifying how a winner was picked. Existing reads (`weightInDraw`, `totalWeightInDraw`, `drawParticipants`) are unchanged.
  - **Removed:** `drawRandomRequestId`, `randomManager`, `setRandomManager`, `DrawStarted`, `PrizeMintFailed`, `DrawNotStarted`.
  - **Constructor:** no longer takes a RandomManager address.
- **VariantPurchaseGate:**
  - **Added:** `exemptMinter(address) view returns (bool)` and `setExemptMinter(address,bool)` (owner).
  - **Changed:** `checkGate` now takes a third `address _minter` argument. The frontend doesn't call it.

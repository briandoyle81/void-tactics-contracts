# Frontend Handoff: Ship Randomness Now Comes From the Mint Block's Hash

> **2026-10-17:** merged into `frontend-handoff-2026-10-17.md` with the other current handoffs. Work from that doc; this one is kept for history.

_Written 2026-10-16; updated the same day for the EIP-2935 window (8191 blocks instead of 256). Not deployed yet; takes effect at the next redeploy of RandomManager (and Ships, Tournament). Background: `docs/audit-3.md` HA6-19._

## What changed

A ship's random roll is now `keccak256(blockhash(mint block), requestId)`. It's fixed the moment the mint's block is sealed, so revealing or constructing later can't change it, and nobody can pick a better or worse epoch anymore.

The catch is that a block hash is only readable for **8191 blocks (about 4.5 hours on Base)** after the mint, using the EIP-2935 history contract. On a chain without EIP-2935 it's 256 blocks (about 8.5 minutes). If nothing reveals or constructs a ship within that window, its request **expires**:
- `constructShip(s)` reverts `RequestExpired(requestId)`.
- The ship stays unconstructable until an admin re-targets it with `RandomManager.retargetExpired`, which is done in batches. After that it can be constructed normally.

## Frontend changes needed

1. **Construct right after minting.** As soon as a pack purchase, free claim or tutorial claim confirms, send `constructShips(newIds)` (or `constructAllMyShips`) automatically, as one signature. Constructing captures the hash and reveals the stats in the same transaction.
   - Today the reveal and construct only happen when the player clicks construct, which may be long after the window has closed.
2. **Drop the separate reveal step** (`useRandomManager.ts` `revealRandomnessBatch` before construct). Constructing reveals by itself.
   - `NotYetRevealed` no longer exists. The comments in `useRandomManager.ts` and `components/ShipActionButton.tsx` (lines ~27 and ~240) that describe it are stale.
   - Dropping the step saves a signature, which helps with the Dynamic rate-limit problem.
   - Calling `revealRandomnessBatch` still works if you keep it. It now only captures the hash and can't hurt.
3. **Show an "awaiting admin" state** for expired ships:
   - `RandomManager.isExpired(serialNumber)` → `true` means the ship needs an admin re-target. Show something like "Construction window missed — contact support".
   - `canFulfill(serialNumber)` / `canFulfillBatch(ids)` → `true` means construct will succeed now: already revealed, or still inside the window and at least one block after the mint.
4. **Ships minted outside the player's own transaction** are the most likely to expire:
   - **Lottery fallback prizes:** minted during someone else's swap. A random 4-star ship arrives unconstructed. Curated template prizes arrive already constructed.
   - **`ShipGrantWinEffect` win rewards:** minted at game end. Since HA6-27 these are PvE only (single-player and roguelike); PvP and tournament games have no win effects.

   Where you can detect these (`DrawResolved` naming the user, the game-end screen), prompt or auto-send a construct right away. Otherwise they'll need the admin path.

## Other ABI changes

- **`RandomManager.requests(id)`** now returns `(blockNumber, revealed, result)`. `prevRandaoAtCommit` was removed.
- **Added:**
  - `isExpired(uint)` and `retargetExpired(uint[])` (owner). There's no window-size constant: `isExpired` / `canFulfill` are the source of truth, since they check whether the hash is actually readable;
  - the `RequestExpired(uint requestId)` error and the `RandomnessRetargeted(requestId, blockNumber)` event;
  - `RandomManager` is now `Ownable`.
- **Unchanged:** `canRevealBatch` keeps its name and now means the same as `canFulfillBatch`.
- **Tournament:** `rerollBracketShuffle` also becomes available as soon as the shuffle request expires, not only after the 10-minute deadline. On Base the request lasts about 4.5 hours, so in practice the deadline comes first.

## Admin / ops

The owner (MAP_EDITOR in production) calls `RandomManager.retargetExpired([serialNumbers])` whenever convenient.
- **What it does:** points each expired, unrevealed request at the block of that transaction. Ids that are revealed, still valid or unknown are skipped, so a valid roll can't be re-rolled this way.
- **Follow-up:** players (or the frontend) must then construct within the next ~4.5 hours, or the request expires again.

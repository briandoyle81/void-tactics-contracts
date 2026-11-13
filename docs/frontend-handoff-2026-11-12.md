# Frontend handoff: UTC pricing (2026-11-12)

Written 2026-11-12. It describes the contracts as of that date. Check
`contracts/ShipPurchaser.sol` before relying on it if much time has passed.

**Replaced by `frontend-handoff-2026-11-12-redeploy.md`** (same day, after the
redeploy), which repeats these items and adds the redeploy's changes.

## The rule

Buying UTC and then ships with it costs the same as buying the ships
directly. The ship-pack price list is **$4.99 / $9.99 / $19.99 / $34.99 /
$49.99** for 5 / 11 / 22 / 40 / 60 ships, and 1 UTC is worth about $1.
Recycling a pack returns 0.1 UTC per ship, 10-12% of what it cost.

## Contract change

`ShipPurchaser.purchaseUTCWithFlow(to, tier)` now mints **`tierPrices[tier]`**
UTC, the pack's UTC price, for `flowTierPrices[tier]` native token. It used to
mint `tierShips[tier] * Ships.recycleReward()` (0.5 UTC for tier 0), which made
UTC about 10x dearer than ships.

| Tier | Ships | Pay (`flowTierPrices`) | Mints (`tierPrices`) | Pack price in UTC |
|---|---|---|---|---|
| 0 | 5 | ≈ $4.99 in ETH | 4.99 UTC | 4.99 UTC |
| 1 | 11 | ≈ $9.99 | 9.99 UTC | 9.99 UTC |
| 2 | 22 | ≈ $19.99 | 19.99 UTC | 19.99 UTC |
| 3 | 40 | ≈ $34.99 | 34.99 UTC | 34.99 UTC |
| 4 | 60 | ≈ $49.99 | 49.99 UTC | 49.99 UTC |

The owner can tune both arrays with `setPurchaseInfo` and `setFlowTierPrices`,
with no redeploy. The live deployment still runs the old code until
`ShipPurchaser` is redeployed.

## Redeploy checklist (contracts side)

- **Lottery pool first.** The UTC/ETH pool (`UTCLotteryHook`) was priced at
  the old rate, about $10 per UTC. Once the new `ShipPurchaser` mints UTC at
  about $1, anyone can mint and sell into the pool until it reaches the new
  price, taking its ETH side. Pull the protocol's liquidity before switching,
  then move the price and re-seed. The hook locks to one pool, so re-seed the
  same pool rather than creating a new one. `scripts/deployUTCLotteryPool.ts`
  now prices from `tierPrices` (2026-11-12).
- Allow the new `ShipPurchaser` to mint UTC and create ships, and withdraw the
  old one's ETH and UTC (`withdrawFlow`, `withdrawUTC`).

## Frontend fixes needed

0. **Extra lobbies cost UTC** (`Lobbies`, 2026-11-12). Past the free lobbies
   (`freeGamesPerAddress`), creating or joining a lobby costs
   `additionalLobbyFee` **UTC** (default 1 UTC), taken by `transferFrom`.
   `createLobby` and `joinLobby` are no longer payable, so sending any ETH
   reverts. Approve UTC to `Lobbies` first, and show the fee as UTC, not the
   native token (`Lobbies.tsx` ~1806/1879/1906 still sends and labels it as
   ETH). A missing balance reverts `InsufficientUTC`; `InsufficientFee` is
   gone. Reserved lobbies are unchanged: the creator pays 1 UTC, the joiner
   nothing.

1. **Credits panel (`UTCPurchasePanel`)**: read the price to send from
   `getFlowPurchaseInfo()`, not `getPurchaseInfo()`. Today it sends the UTC
   price (e.g. 4.99 ETH) as `msg.value`, so every purchase reverts
   `InvalidPurchase`.
2. **Credits panel amount**: show `getPurchaseInfo()`'s price for that tier as
   the UTC received. The "1:1 with the price paid" note from
   `docs/update/Frontend_Update_Guide.md` is out of date.
3. **Card checkout labels** (`app/config/flowPayment.ts`): $1.99-$24.99 should
   be $4.99-$49.99, unless card checkout is meant to be a discount.
4. **Checkout "Approx. USD"**: it shows the card price for every payment
   method, including ETH.
5. **Web2 units**: pack prices (499, ...) are hundredths of a UTC, but UTC
   purchases (5, 11, ...) and recycling (1 per ship) are whole numbers. With
   1 credit = 0.01 UTC, `UTC_PURCHASE_TIERS` amounts should be
   499 / 999 / 1999 / 3499 / 4999 and `recycleRewardUtc` should be 10.

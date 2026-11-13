# Frontend handoff: Base Sepolia redeploy (2026-11-12)

Written 2026-11-12, after the full Base Sepolia redeploy (contracts repo commit
`24cb094`). It describes the contracts and the live deployment as of that date.
It replaces `frontend-handoff-2026-11-12.md` (UTC pricing), whose items are
repeated here, and adds what the redeploy changed. Check the contracts and
`ignition/deployments/chain-84532/` before relying on it if much time has
passed.

## 1. Copy the new deployment into the frontend

Every address changed. The frontend still points at the old deployment, and
there's no copy script, so copy these from the contracts repo by hand:

| From (contracts repo) | To (frontend repo) |
|---|---|
| `ignition/deployments/chain-84532/deployed_addresses.json` | `app/contracts/base-sepolia/deployed_addresses.json` |
| `uniswap-lottery-hook.json` | `app/contracts/base-sepolia/uniswap-lottery-hook.json` |
| `ignition/deployments/chain-84532/artifacts/DeployModule#*.json` | `app/contracts/artifacts/` |

A few new addresses, for checking the copy:

| Contract | Address |
|---|---|
| Ships | `0x2fFCB423C4269dD2ac271972032e45Bf65D1a56A` |
| UniversalCredits (UTC) | `0x69531b96061dCDbbBA64782eef9eDfEF3F08d0b3` |
| ShipPurchaser | `0x7D93B24AD64E5A4C7Eab226A37C97863e5776661` |
| Lobbies | `0x946386dE1bA394B52c6eb53169790939cA60FC7D` |
| Maps | `0x3F8Ab1Dd3B38c73d1E10298c60385C5eEacf2b12` |
| UTCLotteryHook | `0x9ffB4b06C5705Eab64D04E145fD7c1ED0223E040` |

UTC is a new token. Balances from the old deployment don't carry over.

## 2. Map ids 63-72 moved

A fresh deploy numbers maps in seed-file order. `map69`-`map72` now come before
the PvP maps, so on the new chain:

| Id | Map |
|---|---|
| 61-62 | New Scapa Shipyard, Repair Facility DS7 (unchanged) |
| 63 | Demolished Mining Outpost |
| 64 | Electromagnetic Tunnel |
| 65 | The Hive: Dominance |
| 66 | The Hive: Alliance |
| 67-72 | PvP: Twin Pillars, Debris Ring, Trench Run, Exemplar Contract, Reactor Core, Spiral Eye |

- **`app/data/content/mapNames.ts`** still has the old numbering, so ids 63-72
  show the wrong names. Renumber them to the table above.
- **Web2:** re-run `prisma/importMissionSeeds.ts` against the new deployment so
  web2's map ids match the chain.
- **Content-sync record:** the frontend reads it from
  `ignition/content-sync/chain-84532.json` in the contracts repo (frontend
  changes made 2026-11-12, not yet committed in the frontend repo). The record
  there still describes the old deployment. Its `mapsAddress` doesn't match the
  new Maps, so the admin export and the web2 import ignore it, which is correct
  until the next content sync writes a new one.

## 3. UTC pricing

**The rule:** buying UTC and then ships with it costs the same as buying the
ships directly. Ship packs cost **$4.99 / $9.99 / $19.99 / $34.99 / $49.99** for
5 / 11 / 22 / 40 / 60 ships, and 1 UTC is worth about $1. Recycling returns
0.1 UTC per ship, 10-12% of what the pack cost.

`ShipPurchaser.purchaseUTCWithFlow(to, tier)` now mints `tierPrices[tier]` UTC
(the pack's UTC price) for `flowTierPrices[tier]` ETH. It used to mint
`tierShips[tier] * Ships.recycleReward()`, 0.5 UTC for tier 0. Live values:

| Tier | Ships | Pay (`getFlowPurchaseInfo`) | Get (`getPurchaseInfo`) |
|---|---|---|---|
| 0 | 5 | 0.002476 ETH | 4.99 UTC |
| 1 | 11 | 0.004956 ETH | 9.99 UTC |
| 2 | 22 | 0.009918 ETH | 19.99 UTC |
| 3 | 40 | 0.017360 ETH | 34.99 UTC |
| 4 | 60 | 0.024802 ETH | 49.99 UTC |

The owner can retune both lists (`setPurchaseInfo`, `setFlowTierPrices`)
without a redeploy, so read them from chain rather than hardcoding them.

Frontend fixes:

1. **Credits panel (`UTCPurchasePanel`) sends the wrong price.** It reads
   `getPurchaseInfo()` (UTC prices) and sends that as ETH, e.g. 4.99 ETH for
   tier 0. The contract requires exactly the `getFlowPurchaseInfo()` price, so
   every purchase reverts `InvalidPurchase`. Read `getFlowPurchaseInfo()` for
   `msg.value`.
2. **Credits panel amount:** show `getPurchaseInfo()`'s price for the tier as
   the UTC received. The "mints 1:1 with the price paid" note from
   `docs/update/Frontend_Update_Guide.md` is out of date.
3. **Card checkout labels** (`app/config/flowPayment.ts`): $1.99-$24.99 should
   be $4.99-$49.99, unless card checkout is meant to be a discount.
4. **Checkout "Approx. USD"** shows the card price for every payment method,
   including ETH.
5. **Web2 units:** pack prices (499, ...) are hundredths of a UTC, but UTC
   purchases (5, 11, ...) and recycling (1 per ship) are whole numbers. With
   1 credit = 0.01 UTC, `UTC_PURCHASE_TIERS` amounts should be
   499 / 999 / 1999 / 3499 / 4999, and `recycleRewardUtc` should be 10.

## 4. Extra lobbies cost 1 UTC

- Past `freeGamesPerAddress` (1) open lobbies, creating or joining a lobby
  costs `additionalLobbyFee` **UTC** (1 UTC live), taken with `transferFrom`.
  It used to be 1 native token, which is 1 ETH on Base.
- `createLobby` and `joinLobby` are no longer payable: sending any ETH reverts.
- Approve UTC to `Lobbies` before the call. A short balance reverts
  `InsufficientUTC`. The `InsufficientFee` error is gone.
- `Lobbies.tsx` (~1806, ~1879, ~1906) still sends the fee as ETH and labels it
  with the native token symbol.
- Reserved lobbies are unchanged: the creator pays 1 UTC and the joiner pays
  nothing.

## 5. Content

- **Silencio** (AI ship config 19 on the new chain) is a **Sniper** with gun 2.
  It's meant to be an **Aggressor**. Change it in the config editor. The
  contracts repo's seed file will follow on the next content export.

## 6. Still open from earlier handoffs

- **Web2 AI port** (`frontend-handoff-2026-10-30.md`): `app/lib/aiBehaviorWeb2.ts`
  still needs re-porting from `AIBehavior.sol`, `Variant1AI.sol` and
  `Variant2AI.sol`. That includes the Runner and Hunter archetypes, the path
  search and the 2026-11-07 change that keeps Variant 1 Aggressors on their
  scoring tile.
- **Special targeting** (2026-11-07): special ranges are Manhattan distance
  (`|dRow| + |dCol|`), checked from the ship's destination tile, using
  `ShipAttributes.getSpecialRangeAt(variant, pinnedVersion, slot)`. A diagonal
  neighbour is 2 away, so it's out of EMP's range of 1. Add the resolvers'
  errors (`OutOfRange` and the others) to the ABI used to decode reverts.
- **`ShipInFleet`:** `DroneYard.modifyShip` reverts for ships in a fleet.
  Disable "Modify" when `shipData.inFleet` is true.

## Checklist

- [ ] Copy addresses, ABIs and the hook file (§1)
- [ ] Renumber `mapNames.ts` ids 63-72 and re-run the web2 mission import (§2)
- [ ] Commit the frontend's content-sync path change (§2)
- [ ] Credits panel: send the `getFlowPurchaseInfo()` price, show the UTC amount (§3.1-3.2)
- [ ] Card labels, checkout "Approx. USD", web2 credit units (§3.3-3.5)
- [ ] Lobby fee in UTC: approve, no ETH, UTC label (§4)
- [ ] Silencio to Aggressor in the editor (§5)
- [ ] Web2 AI re-port, special-range highlighting, `inFleet` Modify guard (§6)

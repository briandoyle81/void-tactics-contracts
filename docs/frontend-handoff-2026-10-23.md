# Frontend Handoff — UTC Ship Pack Prices, Repair Price, UC → UTC Rename

_Written 2026-10-23. Covers every contract change since `frontend-handoff-2026-10-20.md`; read that doc for everything before it. **None of this is deployed yet.** Each change takes effect when the contract it touches is next deployed, as noted in each section._

_Tests: the full suite passed on 2026-10-23 (906 passing, 0 failing)._

---

## 1. `ShipPurchaser` keeps UTC and native-token prices separate (next `ShipPurchaser` deploy)

### The bug (live now)

`ShipPurchaser` used one `tierPrices` array for two purchases in different currencies:

- `purchaseWithUC` read it as a **UTC** price;
- `purchaseUTCWithFlow` read it as a **native-token (ETH)** price.

The production deploy writes ETH prices into it ($4.99 at the deploy-day ETH/USD price, about 0.002 ETH). So on the live Base Sepolia deploy, **a 5-ship pack bought with UTC costs about 0.00208 UTC** instead of 4.99 UTC. Those ships recycle for 0.1 UTC each, so anyone can buy and recycle to mint UTC without limit. This stays true on the live deploy until `ShipPurchaser` is redeployed; don't present the live UTC pack prices as real.

### The fix

| | UTC purchase (`purchaseWithUTC`) | Native-token purchase (`purchaseUTCWithFlow`) |
|---|---|---|
| Price array | `tierPrices` | **new** `flowTierPrices` |
| Read | `getPurchaseInfo()` → `(tierShips, tierPrices)` | **new** `getFlowPurchaseInfo()` → `(tierShips, flowTierPrices)` |
| Owner setter | `setPurchaseInfo(tierShips, tierPrices)` | **new** `setFlowTierPrices(prices)` (one price per tier, else `ArrayLengthMismatch`) |
| Default | 4.99 / 9.99 / 19.99 / 34.99 / 49.99 UTC | Same numbers in the native token; a production deploy overwrites them with ETH prices |

A production deploy now writes its ETH prices only into `flowTierPrices`, so UTC packs cost 4.99 / 9.99 / 19.99 / 34.99 / 49.99 UTC.

### Frontend changes needed

- **UTC pack prices:** keep using `getPurchaseInfo()`. After the redeploy it returns UTC prices only.
- **"Buy UTC with ETH" (`purchaseUTCWithFlow`):** read the price to send as `msg.value` from `getFlowPurchaseInfo()` (or `flowTierPrices(tier)`), **not** `getPurchaseInfo()` / `tierPrices`. Sending the UTC price reverts `InvalidPurchase`.

---

## 2. Roguelike repair costs 1 UTC per 100 HP (next full deploy)

`RoguelikeResupply.resupplyRepair` charges `missingHP × repairCostPerHP` UTC, but `repairCostPerHP` was never set, so **repair is free on the live deploy** and will stay free there (it isn't being changed now). The deploy module now sets it to `0.01 UTC` (`1e16` wei) per hull point: repairing 100 HP costs 1 UTC.

### Frontend changes needed

- **Show the cost** before repairing: the sum of each listed ship's missing HP × `repairCostPerHP()`. Read the price from the contract rather than hardcoding it; on the live deploy it reads 0.
- **Approve first:** the player must `approve` `RoguelikeResupply` for at least the cost on the UTC token before calling `resupplyRepair`, as for other UTC payments. It pulls with `transferFrom`.
- **Errors:** too little UTC reverts `InsufficientFunds(required, available)`. Too little allowance reverts in the token's `transferFrom`.

---

## 3. "UC" is now "UTC" everywhere (next deploy of each contract)

UTC stands for **Universal Time Credits**. Older code and docs called it "UC". All code, tests, scripts and docs now say UTC.

### ABI changes

These function names change when each contract is next deployed. The live contracts keep the old names until then.

| Contract | Old | New |
|---|---|---|
| `ShipPurchaser` | `purchaseWithUC` | `purchaseWithUTC` |
| `ShipPurchaser` | `withdrawUC()` | `withdrawUTC()` |
| `Lobbies` | `withdrawUC(address)` | `withdrawUTC(address)` |
| `SinglePlayerMatch` | `withdrawUC()` | `withdrawUTC()` |

Arguments and behavior are unchanged; only the names (and so the selectors) change. Revert strings change too: `"UC transfer failed"` → `"UTC transfer failed"`, `"UC withdrawal failed"` → `"UTC withdrawal failed"`.

The UTC token's ERC-20 `name()` changes from "Universal Trade Credits" to **"Universal Time Credits"** at the next token deploy. `symbol()` stays `UTC`.

### Frontend changes needed

- **Copy:** use "UTC" and "Universal Time Credits", never "UC" or "Universal Trade Credits".
- **ABIs:** switch to the new names after the redeploy. Until then the live contracts only have the old names.
- **Older docs:** the earlier handoff docs were updated to the new names too. For the live deploy, read `purchaseWithUTC` / `withdrawUTC` there as `purchaseWithUC` / `withdrawUC`.

---

## 4. Checklist

- [ ] Don't treat live UTC pack prices as real until `ShipPurchaser` is redeployed (§1).
- [ ] "Buy UTC with ETH": read `msg.value` from `getFlowPurchaseInfo()`, not `getPurchaseInfo()` (§1).
- [ ] Repair UI: show `missingHP × repairCostPerHP()`, approve `RoguelikeResupply` first, handle `InsufficientFunds` (§2).
- [ ] Copy: "UTC" / "Universal Time Credits" everywhere (§3).
- [ ] After the redeploy: `purchaseWithUTC`, `withdrawUTC` in the ABIs (§3).

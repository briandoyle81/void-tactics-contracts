# UTC Price Analysis: 10,000 Regular Players (Base / ETH)

> **Re-examined 2026-09-09.** This replaces the FLOW-denominated version of this doc (originally
> flagged 2026-09-08 in `docs/eth-global-remote-strategy.md` as needing re-checking). The deploy
> target is Base, native currency is ETH (not the Flow blockchain), and this pass re-derived every
> number directly from the current contracts (`contracts/Ships.sol`, `contracts/ShipPurchaser.sol`,
> `contracts/UniversalCredits.sol`) rather than reusing the old FLOW-era assumptions. ETH/USD used
> below is a live snapshot taken 2026-09-09 (~$2,490/ETH) — **re-check this before using any ETH
> figure below for an actual deploy; ETH/USD moves.**

## TL;DR

1. **There is a live pricing bug, not just a units mismatch.** Both `Ships.sol` and
   `ShipPurchaser.sol` still hardcode their `tierPrices` constructor defaults as
   `4.99 / 9.99 / 19.99 / 34.99 / 49.99 ether`. That literal was written assuming "1 native token
   ≈ $1" (true-ish for FLOW). On Base, `ether` means ETH — at ~$2,490/ETH, tier 0 (5 ships) is
   currently priced at **4.99 ETH ≈ $12,400**, not ~$5. The Base-specific conversion block that
   would fix this already exists in `ignition/modules/DeployAndConfig.ts` (lines ~1720-1747) but
   is **commented out** and never wired into either contract's `setPurchaseInfo`/`setTiers` call.
2. **The old doc's central claim — "`purchaseUTCWithFlow`: 1 FLOW = 1 UTC" — is factually wrong
   against the current contract**, independent of chain. See §3.
3. **The old doc's deflation model (owner burns 50-100% of retained UTC) describes a function that
   does not exist.** `UniversalCredits.sol` is a plain `ERC20 + Ownable` with mint-only logic — no
   `burn`, no `ERC20Burnable`, nothing callable by the owner or anyone else that reduces supply.
4. **No secondary market for UTC exists today** (confirmed in `docs/eth-global-remote-strategy.md`).
   With no market and no burn, most of the old "Price Calculation Models" section (supply/demand
   equilibrium with velocity, referral arbitrage against a market price) has no real thing to
   model yet — there is no "UTC market price" today, only a mint-time anchor rate.

---

## 1. What the original version got wrong

- **Chain/currency:** modeled everything in "FLOW," assumed 1 FLOW ≈ $1 USD. Live target is Base
  (ETH). ETH is not ≈$1 — using FLOW-era literals as ETH amounts overprices every tier by roughly
  2,500x at today's ETH price.
- **"1 FLOW = 1 UTC" (Model 2's foundation):** never true in the contract, on either chain. See §3
  — the real mint rate is `tierShips[tier] × recycleReward`, not `msg.value`.
- **Owner burn strategy (50-100% burn scenarios, deflation math):** no burn capability exists in
  `UniversalCredits.sol`. This section modeled a mechanism that was never built.
- **"UTC is NOT burned during purchases - it accumulates in `ShipPurchaser` contract"** — this part
  was directionally correct (still true, see §4), just built on top of the wrong mint-rate
  assumption above it.

## 2. Target: ~$1 USD per ship, in ETH, on Base

The tier structure (`tierShips = [5, 11, 22, 40, 60]`, identical in both `Ships.sol` and
`ShipPurchaser.sol`) already encodes a "~$1/ship with bulk discount" curve via its USD literals —
keep that curve, just convert it to ETH correctly instead of using the literals as raw ETH:

| Tier | Ships | USD price (existing curve) | USD/ship | ETH price @ $2,490/ETH |
|------|-------|------------------------------|----------|--------------------------|
| 0    | 5     | $4.99                        | $0.998   | 0.002004 ETH             |
| 1    | 11    | $9.99                        | $0.908   | 0.004012 ETH             |
| 2    | 22    | $19.99                       | $0.909   | 0.008024 ETH             |
| 3    | 40    | $34.99                       | $0.875   | 0.014052 ETH             |
| 4    | 60    | $49.99                       | $0.833   | 0.020076 ETH             |

This is the same shape the commented-out block in `DeployAndConfig.ts` was going for
(`TOKEN_PRICE_USD = 3000` there is stale — replace with the current ETH/USD price, or better, read
a live price at deploy time rather than hardcoding a constant that goes stale the next time ETH
moves).

**Action needed on both contracts** — `Ships.sol.setPurchaseInfo`/`setTiers` (ship-pack purchases
paid directly in ETH) **and** `ShipPurchaser.sol.setPurchaseInfo` (UTC-token ship purchases +
`purchaseUTCWithFlow`, which shares the same `tierPrices` array) each need this pushed via their
own owner-gated setter — they are two independent arrays with the same current bug, not one shared
fix.

_**Correction (2026-10-23):** this was wrong for `ShipPurchaser`. Its `tierPrices` array served
both `purchaseWithUTC` (priced in **UTC**) and `purchaseUTCWithFlow` (priced in **ETH**), so pushing
ETH prices into it made UTC ship packs cost ~0.002 UTC for 5 ships, which recycle for 0.5 UTC: an
unlimited UTC mint on the live Base Sepolia deploy. `ShipPurchaser` now has a separate
`flowTierPrices` array for `purchaseUTCWithFlow`, and the production deploy writes ETH prices only
there (`setFlowTierPrices`); `tierPrices` keeps its UTC constructor defaults. See
`frontend-handoff-2026-10-23.md` §1._

## 3. `purchaseUTCWithFlow` was never 1:1 (corrected)

```solidity
uint mintAmount = tierShips[_tier] * ships.recycleReward(); // recycleReward = 0.1 ether (UTC)
universalCreditsMintable.mint(_to, mintAmount);
```

Mint amounts per tier: `[0.5, 1.1, 2.2, 4.0, 6.0]` UTC — for whatever `tierPrices[_tier]` costs in
ETH. Using the §2 target prices:

| Tier | ETH paid   | UTC minted | Implied price / UTC (ETH) | Implied price / UTC (USD @ $2,490) |
|------|------------|------------|-----------------------------|--------------------------------------|
| 0    | 0.002004   | 0.5        | 0.004008 ETH                 | $9.98                                |
| 1    | 0.004012   | 1.1        | 0.003647 ETH                 | $9.08                                |
| 2    | 0.008024   | 2.2        | 0.003647 ETH                 | $9.09                                |
| 3    | 0.014052   | 4.0        | 0.003513 ETH                 | $8.75                                |
| 4    | 0.020076   | 6.0        | 0.003346 ETH                 | $8.33                                |

So the real mint-time anchor for UTC is **~$8.3–$10.0 per UTC**, not ~$1. This is roughly an order
of magnitude off from the old doc's "0.95–1.0 FLOW/UTC" conclusion — that conclusion was built on
the false 1:1 premise, not on this contract's actual math, and would have been just as wrong on
Flow (the mint-rate formula doesn't depend on chain at all, only the false 1:1 assumption did).

## 4. What's still true

- UTC spent on `purchaseWithUTC` ship purchases is transferred, not burned — it accumulates in
  `ShipPurchaser`, withdrawable by the owner via `withdrawUTC()`. Same for ETH paid into
  `Ships.purchaseWithFlow` / `ShipPurchaser.purchaseUTCWithFlow` (`withdrawFlow()`).
  `ShipPurchaser`'s referral payouts (0/10/20/35/50% by cumulative ships-sold tier, up to 50% at
  100k+ ships) draw down that same accumulated balance.
- The demand-side player behavior framing (DAU/WAU/MAU, weekly purchase counts by tier) is
  structurally reusable, but the old doc's dollar figures inside it (e.g. "14,994 UTC/week") were
  denominated in the same broken FLOW≈$1≈UTC unit conflation as everything else — treat those as
  needing a full re-derivation in ETH/USD terms if this demand model is needed again, not as
  currently-correct numbers.

## 5. Is there anything to predict a "market price" for right now?

No. A market price requires a market. Today:

- No burn exists → no deflation mechanism to model.
- No secondary market (DEX pool, CEX listing) exists for UTC → no price that can diverge from the
  mint-time rate to arbitrage against.
- The only "price" that exists is the mint-time anchor in §3 (~$8.3–$10/UTC), which is a sale rate,
  not a market-clearing price.

If a real market gets built later — e.g. the Uniswap v4 pool discussed as a possible third
ETHGlobal sponsor slot in `docs/eth-global-remote-strategy.md` — the correct number to seed initial
liquidity around is the **§3 anchor (~$8.3–$10/UTC)**, not $1/UTC. Until then, this doc's job is
done: there's no market-equilibrium prediction to make, only the mint-price correction above.

## 6. Action items

1. ~~Wire the commented-out Base tier-price block in `ignition/modules/DeployAndConfig.ts`
   (~lines 1720-1747) into real `setPurchaseInfo`/`setTiers` calls against **both** `ships` and
   `shipPurchaser`, using a current ETH/USD price (or an oracle read — Chainlink Price Feed is
   already one of the ETHGlobal candidate integrations in `docs/eth-global-remote-strategy.md`, so
   this could double as that pitch) instead of the stale `TOKEN_PRICE_USD = 3000` literal.~~
   **Done 2026-09-09:** wired in as a live fetch (CoinGecko ETH/USD, `getEthUsdPrice()` in
   `DeployAndConfig.ts`), gated to `PRODUCTION` only, with a sane-range guard against a
   malformed API response. Kept as a plain HTTP fetch rather than an on-chain Chainlink feed —
   couldn't verify a real Base Sepolia Chainlink ETH/USD proxy address without guessing one, so
   didn't want to hardcode an unverified oracle address into a deploy script. If the Chainlink
   ETHGlobal track is still pursued, swapping this fetch for a verified feed read is a clean
   follow-up.
2. ~~Until that's wired in, **any real deploy to Base prices tier 0 at ~4.99 ETH instead of ~$5** —
   confirm this hasn't already happened on a live deploy before treating current on-chain prices as
   intentional.~~ **Superseded 2026-09-09** by item 1 — no real deploy has happened yet on this
   checkout (`node_modules` didn't even exist), so this risk never materialized; the fix above
   covers the next real deploy.
3. Decide whether to build a real `burn`/`burnFrom` on `UniversalCredits.sol` before making any
   future deflation claims in a pitch/doc — right now that capability doesn't exist.
4. ~~Separately, `ignition/modules/DeployAndConfig.ts` currently has `const PRODUCTION = true`
   committed on `main` — per `CLAUDE.md` this must be `false` before trusting `npx hardhat test`
   results, and the exact same silent-failure pattern was already hit once (2026-08-26). Confirm
   this is intentional post-deploy state, not a repeat of that bug, before running the test suite.~~
   **Done 2026-09-09:** confirmed with the user this was the bug pattern recurring (no intentional
   real deploy had happened), flipped back to `false`, and the full suite passes (616 passing).

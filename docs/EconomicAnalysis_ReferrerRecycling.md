# Economic Analysis: Referrer Recycling Attack on UTC Price

## Executive Summary

A referrer at 50% commission can exploit the system by purchasing ships and immediately recycling them, creating a **net UTC inflation** that significantly impacts the UTC token price. This analysis breaks down the mechanics and quantifies the impact.

---

## System Mechanics

### 1. Ship Purchasing - Two Methods

#### Method A: Purchase with UTC (`ShipPurchaser.purchaseWithUTC`)

**Flow:**

1. Buyer transfers UTC tokens to `ShipPurchaser` contract (full purchase price)
2. Ships are minted to buyer
3. Referrer receives a percentage of the purchase price from the contract's UTC balance

**Key Point:** UTC is **NOT burned** during purchase - it accumulates in the `ShipPurchaser` contract.

#### Method B: Purchase with FLOW (`Ships.purchaseWithFlow`)

**Flow:**

1. Buyer sends native FLOW to `Ships` contract (full purchase price)
2. Ships are minted to buyer
3. Referrer receives a percentage of the purchase price in **FLOW** (not UTC)

**Key Point:** FLOW is sent to the contract, then referral is paid back in FLOW. **No UTC is involved in this flow.**

**Purchase Tiers (Same for both methods):**

- Tier 0: 5 ships for 4.99 (UTC or FLOW)
- Tier 1: 11 ships for 9.99
- Tier 2: 28 ships for 24.99
- Tier 3: 60 ships for 49.99
- Tier 4: 125 ships for 99.99

### 2. Referral System

#### UTC Purchases (`ShipPurchaser._processReferral`)

**Referral Tiers:**

- 0% at < 100 ships sold
- 10% at 100+ ships sold
- 20% at 1,000+ ships sold
- 35% at 10,000+ ships sold
- **50% at 100,000+ ships sold**

**Payment:** Referrer receives `(purchasePrice * referralPercentage) / 100` in UTC tokens, transferred from the contract's balance.

#### FLOW Purchases (`Ships._processReferral`)

**Payment:** Referrer receives `(purchasePrice * referralPercentage) / 100` in **FLOW** (native token), sent directly from the contract.

**Referral Tiers (Same for both methods):**

- 0% at < 100 ships sold
- 10% at 100+ ships sold
- 20% at 1,000+ ships sold
- 35% at 10,000+ ships sold
- **50% at 100,000+ ships sold**

### 3. Ship Recycling (`Ships.shipBreaker`)

**Mechanics:**

- Recycles ships and **MINTS new UTC** to the recycler
- Undestroyed ships: `0.1 UTC` per ship
- Destroyed ships: `0.05 UTC` per ship (half reward)

**Key Point:** Recycling **creates new UTC supply** - it does not use existing supply.

---

## Attack Scenarios: 50% Referrer Recycling Loop

### Scenario A: Purchasing with UTC

A referrer at 50% commission tier:

1. Purchases ships using UTC
2. Immediately recycles all ships
3. Receives referral commission (in UTC) + recycling rewards (in UTC)
4. Repeats the cycle

**Impact:** Creates UTC inflation while spending UTC (reduces supply, then increases it)

### Scenario B: Purchasing with FLOW ⚠️ **MORE SEVERE**

A referrer at 50% commission tier:

1. Purchases ships using **FLOW** (native token)
2. Immediately recycles all ships
3. Receives referral commission (in FLOW) + recycling rewards (in UTC)
4. Repeats the cycle

**Impact:** Creates **PURE UTC INFLATION** without spending any UTC at all

### Economic Calculation Per Tier

#### Scenario A: Purchasing with UTC

#### Tier 0: 5 ships for 4.99 UTC

**Initial State:**

- Referrer spends: 4.99 UTC
- Ships received: 5

**After Purchase:**

- Referrer receives referral: 4.99 × 0.5 = **2.495 UTC**
- ShipPurchaser contract balance: 4.99 - 2.495 = **2.495 UTC** (net inflow)

**After Recycling:**

- Recycling reward: 5 × 0.1 = **0.5 UTC** (minted)
- Referrer net position: 2.495 + 0.5 - 4.99 = **-1.995 UTC** (loss)

**UTC Supply Impact:**

- UTC burned: 0 (none - just transferred)
- UTC minted: 0.5 UTC
- **Net UTC inflation: +0.5 UTC per cycle**

#### Tier 1: 11 ships for 9.99 UTC

**After Purchase:**

- Referral: 9.99 × 0.5 = **4.995 UTC**
- Contract balance: 9.99 - 4.995 = **4.995 UTC**

**After Recycling:**

- Recycling: 11 × 0.1 = **1.1 UTC** (minted)
- Referrer net: 4.995 + 1.1 - 9.99 = **-3.895 UTC** (loss)

**UTC Supply Impact:**

- **Net UTC inflation: +1.1 UTC per cycle**

#### Tier 2: 28 ships for 24.99 UTC

**After Purchase:**

- Referral: 24.99 × 0.5 = **12.495 UTC**
- Contract balance: 24.99 - 12.495 = **12.495 UTC**

**After Recycling:**

- Recycling: 28 × 0.1 = **2.8 UTC** (minted)
- Referrer net: 12.495 + 2.8 - 24.99 = **-9.695 UTC** (loss)

**UTC Supply Impact:**

- **Net UTC inflation: +2.8 UTC per cycle**

#### Tier 3: 60 ships for 49.99 UTC

**After Purchase:**

- Referral: 49.99 × 0.5 = **24.995 UTC**
- Contract balance: 49.99 - 24.995 = **24.995 UTC**

**After Recycling:**

- Recycling: 60 × 0.1 = **6.0 UTC** (minted)
- Referrer net: 24.995 + 6.0 - 49.99 = **-18.995 UTC** (loss)

**UTC Supply Impact:**

- **Net UTC inflation: +6.0 UTC per cycle**

#### Tier 4: 125 ships for 99.99 UTC

**After Purchase:**

- Referral: 99.99 × 0.5 = **49.995 UTC**
- Contract balance: 99.99 - 49.995 = **49.995 UTC**

**After Recycling:**

- Recycling: 125 × 0.1 = **12.5 UTC** (minted)
- Referrer net: 49.995 + 12.5 - 99.99 = **-37.495 UTC** (loss)

**UTC Supply Impact:**

- **Net UTC inflation: +12.5 UTC per cycle**

#### Scenario B: Purchasing with FLOW ⚠️ **CRITICAL**

**Tier 4: 125 ships for 99.99 FLOW**

**Initial State:**

- Referrer spends: 99.99 FLOW (not UTC!)
- Ships received: 125

**After Purchase:**

- Referrer receives referral: 99.99 × 0.5 = **49.995 FLOW** (not UTC!)
- Ships contract balance: 99.99 - 49.995 = **49.995 FLOW** retained

**After Recycling:**

- Recycling reward: 125 × 0.1 = **12.5 UTC** (minted - NEW SUPPLY!)
- Referrer net FLOW position: 49.995 - 99.99 = **-49.995 FLOW** (loss)
- Referrer net UTC position: **+12.5 UTC** (pure gain!)

**UTC Supply Impact:**

- UTC spent: **0** (none - they used FLOW!)
- UTC minted: 12.5 UTC
- **Net UTC inflation: +12.5 UTC per cycle (PURE INFLATION)**

**Key Difference from Scenario A:**

- In Scenario A, they spend UTC (reducing supply) then mint UTC (increasing supply)
- In Scenario B, they spend FLOW (no UTC impact) then mint UTC (pure inflation)
- **Scenario B is worse because there's no UTC burn/removal to offset the minting**

---

## Owner Profitability & Burn Requirements

### Key Question: Do you still profit if everyone aggressively recycles?

**YES - You still profit significantly, even if you burn enough UTC to maintain price stability.**

### Burn Requirement to Maintain Price

**To keep supply neutral (maintain price), you need to burn exactly what gets minted:**

- **Burn requirement = Recycling reward minted**

### Profitability Analysis (Tier 4 - Most Efficient)

**Critical Point:** The 50% referrer gets 50% of the purchase price **regardless of payment method**:

- UTC purchases: Referrer gets 50% in UTC
- FLOW purchases: Referrer gets 50% in FLOW

**Owner also gets 50% regardless of payment method:**

- UTC purchases: Owner gets 50% in UTC
- FLOW purchases: Owner gets 50% in FLOW

**Recycling reward is always in UTC** (regardless of how ships were purchased)

#### Scenario A: UTC Purchases

**Per Cycle:**

- Purchase price: 99.99 UTC
- **50% Referrer receives: 49.995 UTC** (50% of purchase price)
- **Owner receives: 49.995 UTC** (50% of purchase price)
- Recycling mints: 12.5 UTC (to the recycler, not owner)
- **Burn needed to maintain price: 12.5 UTC** (owner must burn this)
- **Owner profit: 49.995 - 12.5 = 37.495 UTC per cycle**

**Profit Margin: 37.495 / 99.99 = 37.5% per cycle**

**If 1,000 cycles occur:**

- Owner receives: 49,995 UTC
- Must burn: 12,500 UTC (to maintain price)
- **Net profit: 37,495 UTC**

#### Scenario B: FLOW Purchases

**Per Cycle:**

- Purchase price: 99.99 FLOW
- **50% Referrer receives: 49.995 FLOW** (50% of purchase price)
- **Owner receives: 49.995 FLOW** (50% of purchase price)
- Recycling mints: 12.5 UTC (to the recycler, not owner)
- **Burn needed to maintain price: 12.5 UTC** (owner must buy and burn this)
- **Owner profit: 49.995 FLOW - (cost to buy 12.5 UTC on market)**

**Profit depends on UTC/FLOW exchange rate:**

- If 1 UTC = 1 FLOW: Profit = 49.995 - 12.5 = **37.495 FLOW per cycle**
- If 1 UTC = 2 FLOW: Profit = 49.995 - 25 = **24.995 FLOW per cycle**
- If 1 UTC = 0.5 FLOW: Profit = 49.995 - 6.25 = **43.745 FLOW per cycle**

**Key Point:** The referrer always gets 50% (in the payment currency), and the owner always gets 50% (in the payment currency). The recycling reward is always in UTC, so the owner must account for this when calculating profit.

### Profitability by Tier (UTC Purchases)

| Tier | Purchase Price | Owner Receives | Recycling Mints | Burn Needed | **Owner Profit** | **Profit Margin** |
| ---- | -------------- | -------------- | --------------- | ----------- | ---------------- | ----------------- |
| 0    | 4.99 UTC        | 2.495 UTC       | 0.5 UTC          | 0.5 UTC      | **1.995 UTC**     | **40.0%**         |
| 1    | 9.99 UTC        | 4.995 UTC       | 1.1 UTC          | 1.1 UTC      | **3.895 UTC**     | **39.0%**         |
| 2    | 24.99 UTC       | 12.495 UTC      | 2.8 UTC          | 2.8 UTC      | **9.695 UTC**     | **38.8%**         |
| 3    | 49.99 UTC       | 24.995 UTC      | 6.0 UTC          | 6.0 UTC      | **18.995 UTC**    | **38.0%**         |
| 4    | 99.99 UTC       | 49.995 UTC      | 12.5 UTC         | 12.5 UTC     | **37.495 UTC**    | **37.5%**         |

### Key Insights

1. **You profit on every cycle** - Even after burning enough to maintain price
2. **Profit margin is ~37-40%** across all tiers
3. **Burn requirement is predictable** - Always equals the recycling reward
4. **You receive 4x more UTC than you need to burn** (for Tier 4: 49.995 received vs 12.5 needed to burn)

### Aggressive Recycling Scenario

**If 100% of users collaborate to do this attack:**

**Important Notes:**

- Not everyone can be a 50% referrer (requires 100,000+ ships sold)
- In practice, all users would refer to the same 50% referrer(s)
- The owner still receives 50% of ALL purchases regardless of referrer
- **The math is the same per purchase** - owner gets 50%, must burn recycling reward

**If everyone aggressively recycles using Tier 4 purchases:**

**Per 1,000 cycles:**

- Total purchases: 99,990 UTC
- Owner receives: 49,995 UTC (50% of all purchases - same regardless of referrer)
- Total recycling mints: 12,500 UTC
- **Burn needed to maintain price: 12,500 UTC**
- **Owner profit: 37,495 UTC**

**To maintain price stability:**

- Burn exactly 12,500 UTC (12.5% of what you receive)
- Keep 37,495 UTC as profit (37.5% of purchase volume)

**Key Point:** Even if 100% of users are doing this attack with 50% referrers, **you still profit 37.5%** because:

- **The 50% referrer gets 50% of every purchase** (in the payment currency - UTC or FLOW)
- **You receive 50% of every purchase** (in the payment currency - UTC or FLOW)
- **You only need to burn the recycling reward** (12.5% of purchase price for Tier 4, always in UTC)
- **The difference is your profit** (37.5% for UTC purchases, or equivalent in FLOW for FLOW purchases)

**Important:** The referrer's 50% commission doesn't change your revenue - you always get 50% regardless of the referrer's tier. The referrer's commission comes from the purchase price, not from your share.

### Burn Strategy Options

**Option 1: Maintain Price (Supply Neutral)**

- Burn exactly what gets minted
- Profit: ~37.5% of purchase volume
- Price: Stable

**Option 2: Deflationary (Price Support)**

- Burn more than what gets minted
- Profit: Lower, but price increases
- Example: Burn 20 UTC per cycle → Profit: 29.995 UTC, but price goes up

**Option 3: Allow Some Inflation**

- Burn less than what gets minted
- Profit: Higher, but price decreases
- Example: Burn 10 UTC per cycle → Profit: 39.995 UTC, but price goes down

### Recommendation

**Burn exactly what gets minted** to maintain price stability while maximizing profit:

- **Burn requirement: Recycling reward per cycle**
- **Profit: ~37.5% of purchase volume**
- **Price: Stable**

---

## Impact Analysis

### Owner Control Mechanisms

**Key Point:** The owner controls all UTC from purchases and can:

- Withdraw UTC from `ShipPurchaser` contract via `withdrawUTC()`
- Withdraw FLOW from `Ships` contract via `withdraw()`
- **Burn UTC** to reduce supply and offset inflation
- **Sell UTC on open market** to manage price (though this adds supply to market)

### 1. Direct Economic Impact

**Scenario A (UTC Purchase):**

- Per-Cycle Loss: Referrer loses UTC on each cycle (negative net position)
- **Owner receives:** Purchase price minus referral = 50% of purchase price in UTC
- **Owner can burn this UTC** to offset recycling inflation
- **Net Impact:** If owner burns the received UTC, inflation is partially offset
- Example (Tier 4): Owner gets 49.995 UTC, can burn it. Recycling mints 12.5 UTC. Net: -37.495 UTC supply reduction (good!)

**Scenario B (FLOW Purchase):**

- Per-Cycle Loss: Referrer loses FLOW (real money cost)
- Per-Cycle Gain: Referrer gains UTC (pure minting)
- **Owner receives:** Purchase price minus referral = 50% of purchase price in **FLOW** (not UTC)
- **Owner cannot directly burn FLOW to offset UTC inflation**
- **Owner must:** Use FLOW proceeds to buy back UTC on market, then burn it (requires active management)
- **Net Impact:** Pure UTC inflation occurs until owner actively intervenes

### 2. UTC Supply Inflation Analysis

**Key Finding:** Every recycling cycle creates new UTC supply. Owner control mechanisms can offset this.

**Scenario A (UTC Purchase) - WITH OWNER BURNING:**

- Recycling mints: +12.5 UTC per cycle (Tier 4)
- Owner receives: 49.995 UTC (50% of purchase price)
- **If owner burns received UTC:** Net supply change = +12.5 - 49.995 = **-37.495 UTC** (deflation!)
- **If owner doesn't burn:** Net supply change = +12.5 UTC (inflation)
- **Conclusion:** Owner burning offsets and actually creates deflation

**Scenario A (UTC Purchase) - WITHOUT OWNER BURNING:**

- Recycling mints: +12.5 UTC per cycle
- Owner holds: 49.995 UTC (not burned)
- Net supply change: +12.5 UTC (inflation)
- **Owner can sell on market** to manage price, but this adds supply to market

**Scenario B (FLOW Purchase) - REQUIRES ACTIVE MANAGEMENT:**

- Recycling mints: +12.5 UTC per cycle (Tier 4)
- Owner receives: 49.995 FLOW (not UTC)
- **No automatic UTC burn** - owner must actively intervene
- **Owner options:**
  1. Use FLOW to buy UTC on market, then burn it
  2. Sell UTC on market to maintain price (but adds supply)
  3. Do nothing → pure inflation occurs
- **Net Impact:** +12.5 UTC inflation per cycle until owner intervenes

**Formula:** `Inflation per cycle = (shipsPerTier × recycleReward)`

**Critical:** Scenario B requires **active owner management** to prevent inflation. Scenario A can be self-correcting if owner burns received UTC.

### 3. Contract Balance Management

**ShipPurchaser Contract (UTC Purchases):**

- Inflow: Purchase price from buyers (in UTC)
- Outflow: Referral payments (in UTC)
- Net retained: `purchasePrice × (1 - referralPercentage)` = 50% for 50% referrer
- **Owner can withdraw via `withdrawUTC()`** and burn to offset inflation

**Ships Contract (FLOW Purchases):**

- Inflow: Purchase price from buyers (in FLOW)
- Outflow: Referral payments (in FLOW)
- Net retained: `purchasePrice × (1 - referralPercentage)` = 50% for 50% referrer
- **Owner can withdraw via `withdraw()`** and use FLOW to buy/burn UTC

### 4. Price Impact Mechanism

**With Owner Active Management:**

**Scenario A (UTC Purchase + Owner Burning):**

- Recycling mints: +12,500 UTC (1,000 cycles)
- Owner burns: -49,995 UTC (from purchases)
- **Net supply change: -37,495 UTC** (deflation - price support!)
- **Price impact: Positive** (supply reduction)

**Scenario B (FLOW Purchase + Owner Intervention):**

- Recycling mints: +12,500 UTC (1,000 cycles)
- Owner must buy/burn UTC using FLOW proceeds
- **Requires active market operations**
- **Price impact: Depends on owner's market activity**

**Without Owner Management:**

**Scenario A (UTC Purchase, No Burning):**

- Net supply increase: +12,500 UTC (1,000 cycles)
- Assuming initial supply of 100,000 UTC: **12.5% supply increase**
- Price impact: Potentially **10-15% depreciation**

**Scenario B (FLOW Purchase, No Intervention):**

- Net supply increase: +12,500 UTC (1,000 cycles)
- **Pure inflation** - no offsetting mechanism
- Price impact: Potentially **10-15% depreciation** (or more)

---

## Attack Vectors

### Vector 1: Direct Recycling Loop (FLOW Purchase) ⚠️ **MOST SEVERE**

1. Referrer buys ships with **FLOW** (not UTC)
2. Immediately recycles
3. Receives referral (FLOW) + recycling rewards (UTC)
4. Repeats with remaining FLOW

**Impact:** Creates pure UTC inflation without spending any UTC. Can continue indefinitely as long as they have FLOW.

### Vector 1B: Direct Recycling Loop (UTC Purchase)

1. Referrer buys ships with UTC
2. Immediately recycles
3. Receives referral + recycling rewards
4. Repeats with remaining UTC

**Limitation:** Referrer loses UTC per cycle, but still creates inflation.

### Vector 2: Coordinated Attack

1. Multiple accounts refer to the same 50% referrer
2. All accounts buy and recycle
3. Referrer accumulates referral commissions
4. Massive UTC inflation occurs

**Impact:** Much larger scale inflation possible.

### Vector 3: Contract Balance Drain

1. Referrer accumulates referral commissions
2. Other users' purchases fund the referrer
3. Contract balance depletes over time
4. System becomes unsustainable

---

## Recommendations

### 1. Burn UTC on Purchase

**Change:** Burn UTC tokens instead of transferring to contract

- **Impact:** Eliminates contract balance accumulation
- **Trade-off:** No way to fund referral payments from purchases

### 2. Reduce Recycling Rewards

**Change:** Lower `recycleReward` to make recycling less profitable

- **Current:** 0.1 UTC per ship
- **Suggested:** 0.05 UTC or lower
- **Impact:** Reduces inflation per cycle

### 3. Cap Referral Percentage

**Change:** Limit maximum referral percentage

- **Current:** 50% at 100k+ ships
- **Suggested:** 20-25% maximum
- **Impact:** Reduces referral commission, making attack less attractive

### 4. Add Cooldown on Recycling

**Change:** Require time delay between purchase and recycling

- **Impact:** Prevents immediate recycling loops
- **Trade-off:** Reduces user flexibility

### 5. Burn UTC on Recycling

**Change:** Require UTC burn equal to recycling reward

- **Impact:** Makes recycling supply-neutral
- **Trade-off:** Reduces recycling incentive

### 6. Referral Payment from Treasury

**Change:** Fund referrals from a separate treasury, not purchase revenue

- **Impact:** Prevents contract balance drain
- **Trade-off:** Requires separate funding mechanism

---

## Conclusion

**Severity: MODERATE to HIGH** (depending on owner management)

A 50% referrer can create UTC inflation through recycling loops, but **owner control mechanisms can mitigate or even reverse this impact**.

### Key Findings:

1. **UTC Purchase Path (Scenario A):**

   - **With owner burning:** Creates **deflation** (net -37.495 UTC per Tier 4 cycle)
   - **Without owner burning:** Creates inflation (+12.5 UTC per cycle)
   - **Owner has direct control** via burning received UTC

2. **FLOW Purchase Path (Scenario B):**

   - Creates pure UTC inflation (+12.5 UTC per cycle)
   - **Requires active owner management** to offset
   - Owner must use FLOW proceeds to buy/burn UTC on market
   - **FLOW costs real money** - attacker has real cost

3. **Attack Cost:**
   - Attacker loses FLOW (real money) on each cycle
   - Net FLOW loss: -49.995 FLOW per Tier 4 cycle
   - This is a **real economic cost** that limits attack scale

### Answer to Key Question:

**"Can they do any more than cause inflation by spending FLOW?"**

**They can cause UTC inflation, BUT:**

- They spend real money (FLOW) to do it
- You control all UTC from UTC purchases and can burn it
- You receive FLOW from FLOW purchases and can use it to buy/burn UTC
- **The attack has real cost and you have control mechanisms**

### Recommended Management Strategy:

1. **Automated Burning:** Implement automatic burning of UTC received from purchases
2. **Active Market Management:** Use FLOW proceeds to buy/burn UTC regularly
3. **Monitor Recycling Activity:** Track large-scale recycling patterns
4. **Consider Cooldown:** Add time delay between purchase and recycling to prevent immediate loops
5. **Adjust Recycling Rewards:** If inflation becomes problematic, reduce `recycleReward`

**The system is manageable with active owner intervention, but requires monitoring and management.**

---

## Appendix: Code References

- `ShipPurchaser.purchaseWithUTC()`: Lines 53-82 (UTC purchases)
- `Ships.purchaseWithFlow()`: Lines 139-161 (FLOW purchases)
- `ShipPurchaser._processReferral()`: Lines 84-107 (UTC referral payments)
- `Ships._processReferral()`: Lines 358-378 (FLOW referral payments)
- `Ships.shipBreaker()`: Lines 579-613 (recycling - mints UTC)
- `Ships.recycleReward`: Line 94 (0.1 UTC)
- `ShipPurchaser.withdrawUTC()`: Lines 137-143 (owner can withdraw UTC)
- `Ships.withdraw()`: Lines 469-474 (owner can withdraw FLOW)
- Referral percentages: `ShipPurchaser.sol` Line 20, `Ships.sol` Line 35

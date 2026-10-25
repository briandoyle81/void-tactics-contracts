# Direct UTC Purchase Analysis - Based on Contract Code

## Contract Analysis

### Key Contract Values

**From `Ships.sol`:**

```solidity
tierShips = [5, 11, 28, 60, 125];  // Ships per tier
tierPrices = [
    4.99 ether,   // Tier 0
    9.99 ether,   // Tier 1
    24.99 ether,  // Tier 2
    49.99 ether,  // Tier 3
    99.99 ether   // Tier 4
];
recycleReward = 0.1 ether;  // 0.1 UTC per ship
```

**Referral System:**

- Referral percentages: `[0, 10, 20, 35, 50]`
- Requires 100,000+ ships sold for 50% tier

---

## Current System: Purchase Ships with FLOW + Recycle

### Tier 4 Example (125 ships for 99.99 FLOW)

**Step 1: Purchase (`purchaseWithFlow`)**

```solidity
// Player sends: 99.99 FLOW
// Contract receives: 99.99 FLOW
// Ships minted: 125 ships
// Referral processed: _processReferral(_referral, 125, 99.99)
```

**Referral Payment:**

- If 50% referrer: Gets `(99.99 × 50) / 100 = 49.995 FLOW`
- Owner receives: `99.99 - 49.995 = 49.995 FLOW` (stays in contract, can withdraw)

**Step 2: Recycle (`shipBreaker`)**

```solidity
// For 125 ships:
// Reward = 125 × 0.1 UTC = 12.5 UTC
// universalCredits.mint(msg.sender, 12.5 UTC)
```

**Complete Flow:**

- Player spends: 99.99 FLOW
- 50% Referrer gets: 49.995 FLOW
- Owner gets: 49.995 FLOW (in contract)
- Player gets: 12.5 UTC (minted)
- **Player net: -49.995 FLOW, +12.5 UTC**
- **Effective rate: 49.995 FLOW / 12.5 UTC = 3.9996 FLOW per UTC ≈ 4 FLOW per UTC**

---

## Proposed: Direct UTC Purchase

### Option 1: Match Net Cost to Player (4 FLOW per UTC)

**Offer: 12.5 UTC for 50 FLOW**

**From Owner's Perspective:**

- Receive: 50 FLOW
- Mint: 12.5 UTC (to player)
- Must burn: 12.5 UTC (to maintain price)
- **Net: 50 FLOW, -12.5 UTC**

**Comparison to Recycling:**

- Recycling: Owner gets 49.995 FLOW, must burn 12.5 UTC
- Direct purchase: Owner gets 50 FLOW, must burn 12.5 UTC
- **Result: Economically equivalent!** ✓

### Option 2: Match Gross Cost to Player (8 FLOW per UTC)

**Offer: 12.5 UTC for 100 FLOW**

**From Owner's Perspective:**

- Receive: 100 FLOW
- Mint: 12.5 UTC (to player)
- Must burn: 12.5 UTC (to maintain price)
- **Net: 100 FLOW, -12.5 UTC**

**Comparison to Recycling:**

- Recycling: Owner gets 49.995 FLOW, must burn 12.5 UTC
- Direct purchase: Owner gets 100 FLOW, must burn 12.5 UTC
- **Result: Owner gets 2x FLOW, same UTC burn - BETTER for owner!** ✓

### Option 3: What You Suggested (125 UTC for 100 FLOW)

**Offer: 125 UTC for 100 FLOW**

**From Owner's Perspective:**

- Receive: 100 FLOW
- Mint: 125 UTC (to player)
- Must burn: 125 UTC (to maintain price)
- **Net: 100 FLOW, -125 UTC**

**Comparison to Recycling:**

- Recycling: Owner gets 49.995 FLOW, must burn 12.5 UTC
- Direct purchase: Owner gets 100 FLOW, must burn 125 UTC
- **Result: Owner gets 2x FLOW, but must burn 10x UTC - NOT equivalent!** ✗

**Player gets:**

- Recycling: 12.5 UTC for 49.995 FLOW net = 4 FLOW per UTC
- Direct purchase: 125 UTC for 100 FLOW = 0.8 FLOW per UTC
- **Player gets 5x better rate!**

---

## Economic Impact Analysis

### Scenario: 1,000 Players Do This

#### Current System (Recycling)

**Per player (Tier 4):**

- Player spends: 99.99 FLOW
- Referrer gets: 49.995 FLOW
- Owner gets: 49.995 FLOW
- Recycling mints: 12.5 UTC
- Owner must burn: 12.5 UTC

**1,000 players:**

- Owner receives: 49,995 FLOW
- Total recycling mints: 12,500 UTC
- Owner must burn: 12,500 UTC
- **Owner net: 49,995 FLOW, -12,500 UTC**

#### Direct Purchase Option 1 (12.5 UTC for 50 FLOW)

**Per player:**

- Player spends: 50 FLOW
- Owner gets: 50 FLOW
- Owner mints: 12.5 UTC
- Owner must burn: 12.5 UTC

**1,000 players:**

- Owner receives: 50,000 FLOW
- Total UTC minted: 12,500 UTC
- Owner must burn: 12,500 UTC
- **Owner net: 50,000 FLOW, -12,500 UTC**

**Comparison:** Nearly identical to recycling ✓

#### Direct Purchase Option 2 (12.5 UTC for 100 FLOW)

**Per player:**

- Player spends: 100 FLOW
- Owner gets: 100 FLOW
- Owner mints: 12.5 UTC
- Owner must burn: 12.5 UTC

**1,000 players:**

- Owner receives: 100,000 FLOW
- Total UTC minted: 12,500 UTC
- Owner must burn: 12,500 UTC
- **Owner net: 100,000 FLOW, -12,500 UTC**

**Comparison:** Owner gets 2x FLOW, same UTC burn - MUCH BETTER! ✓✓

#### Direct Purchase Option 3 (125 UTC for 100 FLOW)

**Per player:**

- Player spends: 100 FLOW
- Owner gets: 100 FLOW
- Owner mints: 125 UTC
- Owner must burn: 125 UTC

**1,000 players:**

- Owner receives: 100,000 FLOW
- Total UTC minted: 125,000 UTC
- Owner must burn: 125,000 UTC
- **Owner net: 100,000 FLOW, -125,000 UTC**

**Comparison:** Owner gets 2x FLOW, but must burn 10x UTC - WORSE! ✗

---

## Recommendations

### Best Option: Match Gross Cost (12.5 UTC for 100 FLOW)

**Why:**

- Owner gets 2x FLOW (100 vs 50)
- Same UTC burn requirement (12.5 UTC)
- Player pays same gross amount (100 FLOW)
- **Owner profit increases significantly**

**Implementation:**

- Offer direct purchase at: **12.5 UTC for 100 FLOW**
- Rate: **8 FLOW per UTC** (matches gross cost via recycling)
- This is economically BETTER for owner than recycling

### Alternative: Match Net Cost (12.5 UTC for 50 FLOW)

**Why:**

- Economically equivalent to recycling
- Player pays same net cost (50 FLOW after referral)
- Owner gets same revenue (50 FLOW)
- **No change in economics**

**Implementation:**

- Offer direct purchase at: **12.5 UTC for 50 FLOW**
- Rate: **4 FLOW per UTC** (matches net cost via recycling)
- This is economically EQUIVALENT to recycling

### Avoid: 125 UTC for 100 FLOW

**Why:**

- Player gets 5x better rate (0.8 FLOW per UTC vs 4 FLOW per UTC)
- Owner must burn 10x more UTC (125 vs 12.5)
- **Economically disadvantageous for owner**

---

## Conclusion

**To maintain economic balance:**

1. **Best option:** Offer **12.5 UTC for 100 FLOW** (8 FLOW per UTC)

   - Owner gets 2x FLOW, same UTC burn
   - Better than recycling for owner

2. **Equivalent option:** Offer **12.5 UTC for 50 FLOW** (4 FLOW per UTC)

   - Same economics as recycling
   - Player pays same net cost

3. **Avoid:** Offering **125 UTC for 100 FLOW** (0.8 FLOW per UTC)
   - Gives players 5x better rate
   - Requires 10x more UTC burn
   - Economically disadvantageous

**The key insight:** The effective recycling rate is **4 FLOW per UTC** (net cost to player) or **8 FLOW per UTC** (gross cost). Offering 125 UTC for 100 FLOW is **0.8 FLOW per UTC**, which is 5-10x better for players and requires 10x more UTC burn.

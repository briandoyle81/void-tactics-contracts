# Direct UTC Purchase Implementation

## Summary

Added `purchaseUTCWithFlow()` function to `ShipPurchaser.sol` that allows players to purchase UTC directly for FLOW at the exact same rates they would get by purchasing ships and recycling them.

## Implementation Details

### Function: `purchaseUTCWithFlow(address _to, uint _tier)`

**Location:** `contracts/ShipPurchaser.sol`

**Functionality:**

- Accepts FLOW payment (native token)
- Mints UTC directly to the buyer
- Uses the same tier structure as ship purchases
- Matches the exact economics of ship purchase + recycle

### Tier Rates

The function calculates UTC amounts based on the recycling reward (0.1 UTC per ship):

| Tier | Ships | Price (FLOW) | UTC Amount | Rate (FLOW/UTC) |
| ---- | ----- | ------------ | ---------- | -------------- |
| 0    | 5     | 4.99         | 0.5 UTC     | 9.98           |
| 1    | 11    | 9.99         | 1.1 UTC     | 9.08           |
| 2    | 28    | 24.99        | 2.8 UTC     | 8.93           |
| 3    | 60    | 49.99        | 6.0 UTC     | 8.33           |
| 4    | 125   | 99.99        | 12.5 UTC    | 8.00           |

**Calculation:** `UTC Amount = tierShips[_tier] × 0.1 ether`

### Economic Equivalence

**Ship Purchase + Recycle Path:**

- Player spends: 99.99 FLOW (Tier 4)
- 50% Referrer gets: 49.995 FLOW
- Owner gets: 49.995 FLOW
- Player recycles: Gets 12.5 UTC
- **Player net: -49.995 FLOW, +12.5 UTC**

**Direct Purchase Path:**

- Player spends: 99.99 FLOW (Tier 4)
- Owner gets: 99.99 FLOW (full amount, no referral)
- Player gets: 12.5 UTC (minted directly)
- **Player net: -99.99 FLOW, +12.5 UTC**

**Key Difference:**

- Direct purchase matches the **gross cost** (full purchase price)
- Owner gets **2x more FLOW** (99.99 vs 49.995)
- Same UTC minted (12.5 UTC)
- **Better economics for owner** - no referral commission paid

### Additional Changes

1. **Added import:** `IUniversalCredits` interface for minting
2. **Added field:** `universalCreditsMintable` to access mint function
3. **Added function:** `withdrawFlow()` to allow owner to withdraw FLOW payments

### Authorization

The `ShipPurchaser` contract is already authorized to mint UTC in the deployment script (`DeployAndConfig.ts`), so no additional authorization is needed.

## Usage Example

```solidity
// Purchase 12.5 UTC for 99.99 FLOW (Tier 4)
shipPurchaser.purchaseUTCWithFlow{value: 99.99 ether}(playerAddress, 4);
```

## Benefits

1. **Player Convenience:** No need to purchase ships and recycle
2. **Owner Revenue:** Owner gets full FLOW amount (no referral commission)
3. **Economic Balance:** Matches ship purchase + recycle rates exactly
4. **Simplified Process:** One transaction instead of two

## Notes

- The function uses the same tier structure as ship purchases
- UTC is minted directly (same as recycling would do)
- Owner must still burn the minted UTC to maintain price stability
- FLOW payments accumulate in the contract and can be withdrawn by owner

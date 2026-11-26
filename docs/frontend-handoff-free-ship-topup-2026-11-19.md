# Frontend handoff: free ship top-up (EVM and NEAR)

_Written 2026-11-19. Describes the contracts on the `near-migration-experiment` branch on that date. Not deployed to any network yet. Nothing changes for players until the contracts are redeployed (EVM `FreeShipClaim`) or upgraded (NEAR game contract)._

## What it is

**The rule:** a player with fewer than 10 ships that aren't destroyed can top back up to 10 free ships at any time.
- **No cooldown.**
- **Independent of the 28-day free claim:** the top-up neither needs nor resets the claim's cooldown.
- **No storefront-tier bonus:** the 28-day claim keeps that.

**Why:**
- Any new wallet can already claim 10 free ships at once. So a player who has lost their ships could always start over on a fresh account, at the cost of their campaign progress, medal, storefront tier and veteran ships.
- The top-up lets them keep playing on their own account instead.
- The balance simulator showed free players running out of ships, and free Average players stuck at campaign node m02 on a starter hangar.

**Which ships count:** every ship the player owns that isn't destroyed. That includes ships sitting in a fleet, a lobby or a roguelike run.

**Which don't:** destroyed ships still appear in the player's owned list, because free ones can never be recycled. They don't count.

**What topped-up ships are:**
- ordinary free ships of the chosen variant: random rolls, constructed by randomness exactly like claimed ships;
- marked `isFreeShip`, so they can't be recycled and killing one pays no UTC;
- subject to the same variant rules as a claim (variant 2 needs the medal).

## EVM (`FreeShipClaim`)

| Call | Notes |
|---|---|
| `topUpFreeShips(uint16 variant)` | Mints `topUpFloor - liveShips` free ships. Reverts `NothingToTopUp(uint256 liveShips)` when the player already has `topUpFloor` or more. Reverts `NotEligible(address)` when an eligibility provider is set and the player isn't verified, as for `claimFreeShips`. |
| `liveShipCount(address player, uint256 cap) view` | Ships `player` owns that aren't destroyed, counted up to `cap`. To show "top up N ships", call `liveShipCount(player, topUpFloor())`. N is `topUpFloor() - result` when positive. |
| `topUpFloor() view` | 10 by default. |
| `setTopUpFloor(uint256)` (owner) | 0 turns top-ups off. |

**Events:**
- `FreeShipsToppedUp(address indexed player, uint256 amount)`;
- `TopUpFloorSet(uint256 floor)`;
- the usual ship mint events from `Ships`.

**Gas:** the count walks the player's owned ships newest first and stops at 10 live ones. A player with many old destroyed ships pays a little more gas, but only they pay it.

`FreeShipClaim`'s constructor is unchanged. `Ships.sol` is unchanged.

## NEAR (game contract)

| Method | Notes |
|---|---|
| `top_up_free_ships({ variant })` (call) | Returns the new ship ids (as strings). Panics `NothingToTopUp` when the player already has 10 or more live ships, and `NotEligible` when verification is required and missing. The new ships' storage is charged to the caller's storage balance, as for `claim_free_ships`. 10 ships need about 0.1 NEAR. |
| `get_live_ship_count({ account_id, cap? })` (view) | Live ships, counted up to `cap` (default: the floor). Show "top up N" as `10 - result` when positive. |

- **Floor:** on NEAR the floor is the claim base, `free_claim_base` (10, from `get_config`).
- **No separate switch:** unlike EVM, there's no separate owner floor or off switch. Adding one would change the live testnet contract's state layout.
- **Events:** NEP-171 `nft_mint` with memo `free_topup`, and `free_ships_topped_up { player, amount }`.
- **ABI:** `near/abi/void_tactics_abi.json` is regenerated and includes both methods.

## Suggested UI

- **When to show it:** a "Top up free ships" action, shown when the live count is under 10. For example: "You have 3 ships. Top up 7 free ships". Next to it, show the existing 28-day claim status (`get_claim_status` on NEAR, `lastClaimTimestamp` + `claimCooldownPeriod` on EVM).
- **Variant choice:** the same as the claim.
- **What to explain to players:** free ships can't be recycled, and topped-up ships are random rolls like claimed ships.

## Known trade-off

A player on a progressed account can lose weak free ships on purpose in an easy fight, then top up with fresh random rolls. That's free re-rolling of traits without giving up progress. It isn't blocked today. If it turns out to matter, the options are:
- top up with fixed starter builds instead of random rolls;
- or limit top-ups to a few ships per day.

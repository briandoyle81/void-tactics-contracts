# Frontend Handoff: Enemy-Blocking Combat & Ship Special-Slot Validation

**Written: 2026-09-26.** Everything that changed in the contracts since `docs/frontend-handoff-maps-and-deployment-zones-2026-09-23.md` (including its 2026-09-25 amendment — still the source of truth for maps/impassable-terrain/deployment-zones/map-names; nothing here supersedes it). Describes the contracts **on `main` in the working tree**; only §3 below is actually live anywhere — everything else is not yet deployed. Re-verify against the contracts if they have changed since this date.

**Update (2026-09-28):** §1's enemy-ship blocking now has one exception — **disabled (0 HP) enemy ships do not block movement-through or line of sight.** A disabled ship stays on the board (until its reactor timer destroys it), and nothing can land on its tile (unchanged), but ships can fly past it and shoot past it. So a disabled enemy on the straight line between a ship and its destination, or between a shooter and its target, no longer makes `moveShip` revert `InvalidMove()`. Still not deployed. No ABI change — behavior only. If the FE builds its own client-side move/shot preview (§1.2), it should skip enemy ships with `hullPoints == 0` when building the blocking set; a preview that treats them as walls will now wrongly reject legal moves and shots. The single-player/roguelike AI follows the same rule.

Companion docs: `docs/frontend-handoff-maps-and-deployment-zones-2026-09-23.md` (maps/zones/impassable terrain, unaffected by this doc), `docs/frontend-handoff-attributes-costs-and-ai-2026-09-21.md` (attributes/costs/AI trees, unaffected), `docs/ai-ship-configs.md` (unaffected).

---

## 0. TL;DR — what to do

1. **Regenerate ABIs** for `Game`, `IGameView`, `Maps`, `IMaps`, `DroneYard`, `GenerateNewShip` — all additive this round (new functions/errors), **no existing function signatures changed**.
2. **New gameplay rule: enemy ships now block movement and line of sight**, not just terrain (§1). `moveShip` can revert the same `InvalidMove()` you already handle, for a new reason.
3. **`DroneYard.modifyShip` has a new revert reason**: `InvalidSpecial(Special)` (§2) — thrown if a player tries to equip a special slot that does nothing for their ship's faction.
4. **Ship generation no longer produces dead specials** (§2) — every newly-minted ship's special, if any, is guaranteed to actually do something.
5. **Already live, no redeploy needed**: free-ship and tutorial-ship claims no longer require passing eligibility verification (§3) — a direct state change against the currently-deployed contracts, not a code change.
6. Everything in §1 and §2 is **not yet deployed** — still pending the next full redeploy, same status as the `updatePresetMapImpassable` fix noted in the prior doc's 2026-09-25 amendment.

---

## 1. Enemy ships now block movement and line of sight

### 1.1 The concept

Previously, only terrain mattered for blocking: `impassable` tiles blocked movement, `blocked` tiles blocked line of sight (see the 2026-09-23 doc). Ships themselves only ever blocked **landing directly on their own tile** — a ship could always fly past or shoot through another ship standing in the way.

That's now split by side:
- **Ally ships**: unchanged. Still only block landing on their exact tile; never block movement-through or line of sight.
- **Enemy ships**: now a hard obstacle, like a wall. They block landing on their tile (already true), **and now also block movement passing through their tile, and line of sight shooting through their tile.** *(Exception added 2026-09-28: a disabled, 0 HP enemy ship only blocks landing on its own tile — see the update note at the top.)*

### 1.2 How it's enforced (mostly internal, know this exists)

Two new `Maps.sol` / `IMaps.sol` functions:
```solidity
function hasMovementPathAvoidingShips(uint _gameId, int16 _row0, int16 _col0, int16 _row1, int16 _col1, uint256 _enemyOccupiedBitmap) external view returns (bool)
function hasMapsAvoidingShips(uint _gameId, int16 _row0, int16 _col0, int16 _row1, int16 _col1, uint256 _enemyOccupiedBitmap) external view returns (bool)
```
These are the existing `hasMovementPath`/`hasMaps` straight-line (Bresenham) checks, plus a caller-supplied bitmap of enemy ship tiles OR'd into the blocking mask. `Game.sol` builds this bitmap from live ship positions and calls these automatically inside `moveShip` — **the FE doesn't need to call these directly**, the same way it never needed to call `hasMovementPath`/`hasMaps` directly. They're mentioned here only because they're new public ABI surface, and because if the FE ever builds its own client-side "can I move/shoot here" preview (rather than just trying the move and handling a revert), that preview now needs to account for enemy-ship blocking too, not just terrain, to match on-chain behavior.

### 1.3 Gameplay impact

- `moveShip` can now revert `InvalidMove()` because an enemy ship sits somewhere on the straight-line path — not just because of impassable terrain. **Same error, no new error type** — if the FE already treats `InvalidMove()` generically ("that move isn't legal"), no code change is required. If the FE has specific user-facing copy like "blocked by terrain," it's no longer fully accurate and may want to generalize to "blocked" or "path obstructed."
- Same rule applies to shooting: a `Shoot`/`Special` action at range > 1 already required clear line of sight; now that check also fails if a *different* enemy ship sits between the shooter and the target. You can always shoot the enemy actually standing at the target tile — only other enemies *along the way* can block the shot.
  > **Correction (2026-10-15):** this applies to `Shoot` only. `Special` actions ignore line of sight entirely, by design: they check range only, and neither terrain nor other ships block them. Don't show LoS-blocked previews for specials. See `docs/audit-3.md` HA6-15.
- No change to `ActionType`, targeting parameters, or any existing revert reason's meaning — this is a pure behavior tightening under the same `InvalidMove()`.

### 1.4 AI behavior

Single-player/roguelike AI (`AIBehavior.sol`, `Variant1AI.sol`) was updated to route around a blocking enemy and consider alternate approach tiles when its direct path is obstructed, rather than blindly attempting an illegal move and falling back to `Pass` (which is what would otherwise happen — `SinglePlayerMatch`/`RoguelikeMatch` already wrap AI moves in try/catch). Net effect: AI should be equal-or-better at reaching its objectives around clustered ships than before, not worse — but exact AI paths/timing around enemy clusters may differ slightly from what you've seen previously.

---

## 2. Ship special-slot validation — no more dead specials

### 2.1 Background

Each faction (`traits.variant`) has 8 possible "special" slots (`Special` enum, 0 = None, 1–7). Today, only slots 1–3 do anything for either faction (variant 1: EMP/RepairDrones/FlakArray; variant 2: ElectricStorm/DroneSwarm/AdditionalThruster). Slots 4–7 are unused filler reserved for future content.

Previously, nothing prevented a ship from ending up equipped with one of those unused slots:
- Ship generation (`GenerateNewShip.sol`) rolled a special uniformly across all 8 values, regardless of variant.
- `DroneYard.modifyShip` let a player equip any of the 8 values freely, with no validation at all.

A ship in this state looks completely normal until its Special action is actually used — at which point `moveShip` reverts `InvalidMove()` immediately, before any targeting/range logic even runs, because there's no effect resolver wired up for that (variant, slot) pair. This is exactly the shape of a live issue that was reported and traced back to this gap.

### 2.2 The fix

- **`Game.sol`** gained a per-variant "how many real slots does this faction have" value:
  ```solidity
  mapping(uint16 => uint8) public maxSpecialSlot;
  function setMaxSpecialSlot(uint16 _variant, Special _slot) external onlyOwner;
  ```
  Owner/admin-config only (set once per variant at deploy time, currently `3` for both factions) — not something the FE calls, but `maxSpecialSlot(variant)` is a public getter the FE can read.
- **`GenerateNewShip.sol`**: the random special roll is now constrained to `0..maxSpecialSlot[variant]` instead of `0..7` — a freshly-generated ship can never land on a dead slot.
- **`DroneYard.sol`** (`modifyShip`) has a new revert:
  ```solidity
  error InvalidSpecial(Special _special);
  ```
  Thrown if a player tries to equip a slot beyond `maxSpecialSlot[variant]` for their ship's faction.

### 2.3 What this does *not* cover

- **`Ships.sol`'s own `customizeShip`/`createSpecificShip`** (used by other authorized minting flows — event ships, prize ships, etc. — not the general player-facing DroneYard customization flow) still has **zero** special-slot validation, for the same reason its `traits.variant` bound is also unchecked there: `Ships.sol` has essentially no bytecode headroom left for another check. Any backend/authorized-caller code building a `Ship` struct for one of these calls is responsible for staying within `0..maxSpecialSlot[variant]` itself.
- **Already-minted ships** carrying a dead special from before this fix (including the one that prompted it) are **not retroactively repaired**. This only prevents new dead-special ships going forward, once deployed.

---

## 3. Already live: free/tutorial ship claim verification disabled

Against the **currently-deployed** Base Sepolia contracts (the 2026-09-23 deploy) — no code change, no redeploy:
```
FreeShipClaim.setEligibilityProvider(address(0))
TutorialClaim.setEligibilityProvider(address(0))
```
Both calls have already been made and confirmed. Claiming a free ship or a tutorial ship no longer requires passing whatever eligibility/verification check was previously gated behind the eligibility provider. If the FE has an "ineligible" rejection or verification-prompt flow specifically for these two claims, it should no longer trigger — confirm against the live contract if you were relying on that path.

---

## 4. Frontend checklist

- [ ] Regenerate ABIs: `Game`, `IGameView`, `Maps`, `IMaps`, `DroneYard`, `GenerateNewShip` — all additive, no existing signatures changed.
- [ ] Handle the new `DroneYard.InvalidSpecial(Special)` revert reason in ship customization UI, alongside the existing `ArmorAndShieldsBothSet`/`InvalidVariant`/etc.
- [ ] Ship customization "special" picker: cap offered options at `Game.maxSpecialSlot(variant)` (new public getter) instead of the raw 0–7 enum range — anything above it will always revert.
- [ ] Combat/movement UI: `InvalidMove()` can now also mean "an enemy ship is blocking this path or line of sight," not just terrain. No code change required if `InvalidMove()` is already handled generically; update any specific "blocked by terrain" copy if you have it.
- [ ] Free/tutorial ship claim UI: confirm whether you had an eligibility-check flow for these — it's no longer needed against the live contract (§3, already in effect).
- [ ] Nothing in §1/§2 is deployed yet — treat as "coming in the next full redeploy," same status as the impassable-tile-update fix from the prior doc's 2026-09-25 amendment. §3 is the only change here that's already live.

---

## 5. Not changed / out of scope

- Maps, deployment zones, impassable terrain, map names — unchanged since the 2026-09-23 doc and its 2026-09-25 amendment; that doc is still current for all of it.
- Attributes, costs, variant balance numbers — unchanged since 2026-09-21.
- `Ships.sol` — untouched (see §2.3 for the one caveat that follows from that).
- `ActionType`, targeting parameters, and every other existing revert reason's meaning — unchanged.
- Full test suite: 804 passing (was 778 as of the 2026-09-23 doc) — growth from new test coverage added alongside this work, not from new game content.

# Frontend Handoff — AI Placement Zones, Node Reward Ships

_Written 2026-10-19. Covers every contract change since `frontend-handoff-2026-10-17.md`; read that doc for everything before it. None of this is deployed yet. It takes effect at the next redeploy of `AIEncounters` (§1) and `ShipGrantWinEffect` (§2), plus the `VariantPurchaseGate` wiring the deploy adds for §2._

_Tests: the full suite passed on 2026-10-19 (902 passing, 0 failing)._

---

## 1. AI fleet placements follow the map's joiner zone

`AIEncounters.setMapPlacement(s)` used to accept only the default joiner columns, 13–16. A map with a custom joiner zone couldn't save AI ships on the zone's other tiles: the call reverted `InvalidPosition()` (`0xce7e065e`), as seen on Base Sepolia map 67. Now a placement must be a tile of the map's joiner zone, which is the same `Maps.isValidDeploymentTile(mapId, row, col, false)` check used when the AI fleet is created. A map with no custom joiner zone still uses columns 13–16, so nothing changes for it.

This takes effect at the next redeploy of `AIEncounters`. `SinglePlayerMatch` and `RoguelikeMatch` point at it.

### Frontend changes needed

- **Admin fleet editor:** offer and validate AI placement tiles against `Maps.getJoinerZonePositions(mapId)`. An empty result means the default, columns 13–16 on every row. If the editor hardcodes columns 13–16, switch it to the zone.
- **Editing a zone after placing ships:** clearing a placement (`configId` 0, or a `setMapPlacements` save that leaves it out) always works. A new placement outside the current zone reverts `InvalidPosition`. Placements that end up outside the zone after an edit make that map's match start revert, because `Fleets.createFleet` checks the zone too. Re-save the fleet after changing a map's joiner zone.

### ABI changes

- **Removed:** the `JOINER_COL_MIN` / `JOINER_COL_MAX` constants. Use the map's joiner zone instead.
- **Added:** the `GRID_WIDTH` constant (17).
- **Unchanged:** `mapPlacementCount(mapId)` keeps its signature; it's now a view function instead of a public mapping. `getMapPlacements` still returns placements in row-major order, so the AI ship order is unchanged.

---

## 2. Roguelike node reward ships are fully configurable

`ShipGrantWinEffect` was reworked. It used to mint a random, unconstructed free ship of one variant for every node. Its tier setting did nothing, and variant 2 failed for any player without the Shattered Hive medal. Now each node can have its own fully specified ship, and any winner can receive it, whatever the variant.

This takes effect at the next redeploy of `ShipGrantWinEffect`. The deploy now also exempts it from `VariantPurchaseGate`.

### How it works

- **Setting a reward:** the owner (MAP_EDITOR) calls `setGrant(nodeId, grant)`, and the node's win-effect list must include the `ShipGrantWinEffect` address (`RoguelikeNodeMap.setNodeWinEffects`). Each win at that node then mints the ship to the winner, already constructed. Only roguelike combat wins trigger it.
- **What's configurable:** the `ShipGrant` struct holds:
  - `name`, `equipment` (main weapon, armor, shields, special) and `colors` (three HSL sets);
  - `variant`;
  - `accuracy`, `hull` and `speed`, each 0–2;
  - `shipsDestroyed`, which sets the rank: 1, 10, 30, 100, 300 and 1000 kills are ranks 1–6;
  - `shiny`;
  - `isFreeShip`: a free ship can't be recycled and pays no kill UTC;
  - `oncePerAddress`: if true, each address gets this node's ship at most once, across all runs; if false, every win grants another one.
- **Validation:** `setGrant` rejects:
  - an accuracy, hull or speed above 2 (`InvalidTraitValue`);
  - a variant of 0 or above `Ships.maxVariant()` (`InvalidVariant`);
  - armor and shields both set (`ArmorAndShieldsBothSet`).
- **Other owner calls:**
  - `clearGrant(nodeId)` removes a node's reward;
  - `resetClaim(nodeId, player)` lets an address receive a once-per-address ship again.
- **Results:**
  - A win that mints emits `ShipGranted(nodeId, player, shipId)`.
  - A repeat win on a once-per-address grant mints nothing and isn't an error.
  - If the node has the effect but no grant configured, or the mint fails (for example, Ships is paused), `RoguelikeMatch` emits `WinEffectFailed`. The win still counts, and a failed once-per-address mint doesn't use up the claim.
- **When changes apply:** a node's win-effect list is fixed when the player enters combat. A grant is not: `setGrant` changes apply to the next win.

### Frontend changes needed

- **Admin node editor:** add a form for the reward ship that writes `setGrant`, and show the current one with `hasGrant(nodeId)` and `getGrant(nodeId)`.
- **Player UI:** to show a node's reward, read `getGrant(nodeId)`. For once-per-address grants, `hasClaimed(nodeId, player)` says whether this player already got it.
- **Win screen:** the reward ship is constructed already, so no construct step is needed. Use `ShipGranted` to show it.

### ABI changes

- **Removed:** `shipVariant`, `shipTier`, `setShipConfig` and `ShipConfigSet`.
- **Constructor:** now takes only the `Ships` address.
- **Added:**
  - Reads: `hasGrant`, `getGrant` and `hasClaimed`.
  - Owner: `setGrant`, `clearGrant` and `resetClaim`.
  - Events: `GrantSet`, `GrantCleared`, `ClaimReset` and `ShipGranted`.
  - Errors: `NoGrantForNode`, `InvalidTraitValue`, `InvalidVariant` and `ArmorAndShieldsBothSet`.

---

## 3. Corrections to the 2026-10-17 doc

- **Win effects only run in roguelike combat.** The 10-17 doc (§2, item 4) said `ShipGrantWinEffect` rewards are "PvE only (single-player and roguelike)". Single-player matches never trigger win effects; only `RoguelikeMatch` does. PvP and tournaments don't either (HA6-27).
- **Node reward ships no longer need constructing.** The same item listed them among ships likely to expire because they arrived unconstructed. They now arrive constructed (§2 above), so drop the "prompt a construct on the game-end screen" step for them. Lottery fallback prizes still arrive unconstructed and still need the prompt.

---

## 4. Checklist

- [ ] Admin fleet editor offers and validates AI placements against `Maps.getJoinerZonePositions(mapId)`, not hardcoded columns 13–16 (§1).
- [ ] Remove any use of `AIEncounters.JOINER_COL_MIN` / `JOINER_COL_MAX` (§1).
- [ ] Re-save a map's AI fleet after editing its joiner zone (§1).
- [ ] Admin node editor: a reward-ship form that writes `setGrant`, showing the current one via `hasGrant` / `getGrant` (§2).
- [ ] Player UI: show a node's reward ship with `getGrant`; for once-per-address grants, show `hasClaimed` (§2).
- [ ] Win screen: show the granted ship from `ShipGranted`; no construct step (§2).
- [ ] Remove uses of `shipVariant` / `shipTier` / `setShipConfig` (§2).
- [ ] Drop the construct prompt for node reward ships; keep it for lottery fallback prizes (§3).

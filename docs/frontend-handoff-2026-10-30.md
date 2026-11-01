# Frontend Handoff — Storage Packing, Dead Code Removed, 60-Second Turns

_Written 2026-10-30. Covers contract changes since `frontend-handoff-2026-10-23.md`. **None of this is deployed yet.** Everything here takes effect at the next full deploy; until then the live contracts keep the old shapes and behavior._

---

## 1. `Attributes.statusEffects` is gone (next full deploy)

`Attributes` lost its last field, `uint8[] statusEffects`. It was always an empty list: nothing on chain ever added to it or read it.

### ABI changes

The `Attributes` tuple is now:

```
(uint16 version, uint8 range, uint8 gunDamage, uint8 hullPoints,
 uint8 maxHullPoints, uint8 movement, uint8 damageReduction,
 uint8 reactorCriticalTimer)
```

Every function that returns `Attributes` (alone, in an array, or inside `GameDataView`) changes shape. That includes:

- `Game.getShipAttributes`, `Game.getGame` (its `shipAttributes` array);
- `ShipAttributes.calculateShipAttributes`, `calculateShipAttributesById`, `calculateShipAttributesByIds`.

### Frontend changes needed

- **ABIs:** take the new artifacts after the redeploy. Decoding the new contracts with the old ABI (or the reverse) fails or gives wrong values, so switch them together.
- **Types:** remove `statusEffects` from `Attributes` in `app/types/types.ts`.
- **Local copies:** stop setting it where the frontend builds its own `Attributes`:
  - `app/utils/shipAttributesCalculator.ts` and `shipAttributesCalculatorWeb2.ts`;
  - the offline tutorial and web2 engine (`app/utils/simulatedTutorialRules.ts`, `app/lib/gameEngineWeb2.ts`), which append to it but never read it;
  - the test fixtures that include `statusEffects: []`.

---

## 2. `Fleets` packs its storage (next `Fleets` deploy)

`Fleets` now stores ship ids as 64-bit values and positions packed into 32 bits, which cuts the gas of every fleet creation (about 1M gas off the largest roguelike fight).

### ABI changes

- `getFleet`, `getFleetShipIdsAndPositions` and `isShipInFleet` are unchanged.
- The auto-generated `fleets(uint256)` getter is removed. Use `getFleet` instead. The frontend doesn't call it today.
- New `transferFleet(...)`, called only by `RoguelikeMatch.enterCombatNode`: it moves a run's roster from its reservation fleet into the combat fleet without unlocking the ships (about 0.5M gas off the largest fight). It emits the same `FleetCleared` and `FleetCreated` events the old clear-then-create did, and the ships stay `inFleet` throughout instead of flipping off and on.

### Frontend changes needed

None beyond taking the new ABI.

---

## 3. `PlayerStats.totalGames` is gone (next `GameResults` deploy)

`PlayerStats` is now `(uint wins, uint losses)`. `totalGames` was always `wins + losses`, and storing it cost an extra write for each player on every recorded game. Also removed from `GameResults`:

| Removed | Use instead |
|---|---|
| `PlayerStats.totalGames` (in `getPlayerStats` and the `playerStats(address)` getter) | `wins + losses` |
| `totalGamesTracked()` | Count `GameResultRecorded` events |
| `getPlayerTotalGames(address)` | `wins + losses` |
| `getPlayerWinRate(address)` | `wins * 100 / (wins + losses)` |
| `getTopPlayersByWins(uint)` | Nothing: it was a stub that always returned an empty list |

The `PlayerStatsUpdated(player, wins, losses, totalGames)` event keeps its shape; its last field is now computed as `wins + losses`.

### Frontend changes needed

- `app/hooks/usePlayerStats.ts` and `app/types/types.ts`: drop `totalGames` from the on-chain `PlayerStats` type and compute it as `wins + losses` where it's shown.

---

## 4. Minimum turn time is 60 seconds (next `Lobbies` deploy)

`createLobby` and the owner-only `createLobbyForAddresses` rejected turn times under **300** seconds: the check compared against `MIN_TIMEOUT` (the kick-penalty minimum) instead of `MIN_TURN_TIME`. It now uses `MIN_TURN_TIME`, so the range is **60–86,400 seconds**, matching the frontend's own API validation. On the live deploy, 60–299 still reverts `InvalidTurnTime` until `Lobbies` is redeployed.

---

## 5. Unused functions removed (next full deploy)

Nothing in the frontend calls these:

- `GameEngineRegistry`: `engineCount()`, `getEngines()`, `setRetired()`, the `EngineRetired` event, and the `deployedAt` / `retired` fields of `engineInfo(address)`, which now returns `(bool registered, string label)`. `engineOfGame`, `currentEngine` and the `engines(uint)` getter are unchanged.
- `GenerateNewShip.generateSpecificShip`.
- `Lobbies` errors `LobbyAlreadyStarted` and `InvalidShipCount`, which were never raised.

One getter changes type (added 2026-10-31): `SinglePlayerMatch.gameIdToAiShipIds(gameId, i)` and `RoguelikeMatch.gameIdToAiShipIds(gameId, i)` now return `uint64` instead of `uint256`. viem still decodes it as a `bigint`, and the frontend doesn't call either getter.

---

## 6. AI ships no longer carry a cost (next full deploy)

`AIShips.allocateShip` stopped pricing AI ships: it used to make two `ShipAttributes` calls per AI ship (about 265k gas on the largest roguelike fight) for a value nothing on chain uses. AI fleets have no cost cap, and `Fleets` now skips the costs-version check for them.

After the redeploy, every AI ship (id ≥ `2^40`, `AIShips.AI_SHIP_ID_OFFSET`) returns `shipData.cost = 0` and `shipData.costsVersion = 0`. The in-game ship cards (`ShipCard.tsx`, via `toShipCardData`) show that cost, so they would show 0 for enemy ships.

### Frontend changes needed

- **Compute AI ship cost:** in `app/utils/toShipCardData.ts` (every in-game card goes through it), for a ship with id ≥ `2^40`, use a cost computed from its own equipment and traits instead of `shipData.cost`. The AI ship's record already carries its config's equipment and traits, so no extra lookup is needed.
- **Use the contract's formula:** call `ShipAttributes.calculateShipCost(ship)` as a read-only call (free, and always matches the live cost tables). `calculateTutorialThreatPoints` in `app/utils/tutorialShipBuilder.ts`, which the roguelike previews use, gives the same result only while its hardcoded tables match the chain; it drifts as soon as the owner calls `setCosts`. Use it only as a fallback, and consider moving the previews (`aiConfigToPreviewShip`) to the contract read too, so previews and in-game cards always agree.
- **AI fleet totals:** `Fleets.getFleet(...).totalCost` is now 0 for AI fleets. If anything shows an enemy fleet's total, sum the computed per-ship costs instead.

---

## 7. Destroyed and fled ships keep their side (next `Game` deploy)

`getAllShipPositions` (and so `getGame().shipPositions`) used to report `isCreator = false` for every destroyed or fled ship, including the creator's: it read the side from the active-ship list, which a gone ship has already left. It now reads it from the ship's stored board state, so a gone creator ship reports `isCreator = true`.

### Frontend changes needed

- If anything works around the old value (for example, deciding a wreck's side from fleet membership instead of `isCreator`), it can use `isCreator` directly after the redeploy. On the live deploy, gone ships still report `false`.

`Game` also now stores each ship's board state in one packed slot (about 1M gas off the largest fight). `getShipPosition`, `getAllShipPositions` and `getGame` return the same shapes as before, so that part needs no frontend change. The same goes for `lastMove` (added 2026-10-31): it is now stored in one slot instead of four, and `getGame().lastMove` keeps its shape. Game's internal grid is now a one-word occupancy bitmap instead of one slot per cell (also 2026-10-31). It was never exposed, so nothing changes for the frontend. A resolver relocation off the board now reverts `RelocationOutOfBounds` (a `SpecialEffectsLib` error). Game also stores each side's live-ship bitmap instead of rebuilding it on every move and shot, again with no ABI change.

Moves no longer read the Ships contracts (added 2026-10-31; about 40% off a move's gas). Game copies each ship's faction and special onto its board at match start, through a new batched `ShipAttributes.calculateBoardStatsByIds(ids)`, which reads ships through a new slim `ShipsRouter.getShipStatsInput(id)`. So `Game`, `ShipAttributes` and `ShipsRouter` must be redeployed together. `Fleets` now checks a fleet's starting positions with one call to the new `Maps.getDeploymentZoneBitmap(mapId, isCreator)` instead of one `isValidDeploymentTile` call per ship. All three are new functions; nothing existing changes shape. Kill credit moved onto the board too and works as before. Some revert reasons change for calls the UI shouldn't make:

| Call | Was | Now |
|---|---|---|
| Shoot at an id that isn't a ship | `ShipNotFound` | `InvalidMove` |
| Move a ship that isn't in this game | `ShipNotOwned` or `ShipNotFound` | `ShipNotFound` |
| Special or faction ability targeting a ship not in this game | allowed (the resolver decided) | `ShipNotFound` |

AI turns no longer pass the whole `getGame` view between contracts (added 2026-10-31; about 40% off the worst AI turn). `Game` gained a read-only `getAIBoard(gameId)` that returns the board as one flat `uint[]`: a 7-word header, then each active ship's id and raw packed board word. The AI orchestrators and AI contracts decode it themselves, and the `IVariantAI.decide` context changed shape. The frontend shouldn't use `getAIBoard`, since its layout follows Game's storage; `getGame` is unchanged.

`Fleets` no longer marks AI ships `inFleet`: an AI ship (id ≥ `2^40`) reports `shipData.inFleet = false` during its match. `Fleets.isShipInFleet` still reports its membership.

---

## 8. Ships lose the third color (next full deploy, including a fresh `Ships`)

_Added 2026-10-31._ `Colors` dropped `h3`, `s3` and `l3`. Nothing ever set them (`GenerateNewShip` rolls only the first two colors), and no renderer reads them. Removing them shrank `Ships` by about 1.65 KiB, which made room for a slim stats read that takes about 0.4M gas off the largest roguelike fight.

**This needs a new `Ships` contract.** `Ship`'s storage layout changes, so the existing `Ships` deploy can't be upgraded in place; ships minted on it stay there.

### ABI changes

The `Colors` tuple is now `(uint16 h1, uint8 s1, uint8 l1, uint16 h2, uint8 s2, uint8 l2)`. Everything that takes or returns a `Ship`, `Traits` or `Colors` changes shape, including `Ships.getShip`, `Ships.ships(id)`, `ShipsRouter.getShip`, `AIEncounters` configs and `DroneYard.modifyShip`'s ship argument.

New and unchanged in shape: `Ships.getShipStatsInput(id)` and `ShipsRouter.getShipStatsInput(id)`, which return `(id, equipment, variant, accuracy, hull, speed, shipsDestroyed)`.

### Frontend changes needed

Remove `h3`/`s3`/`l3` wherever the frontend builds or copies colors:
- the `Colors` type in `app/types/types.ts`;
- `app/components/ShipConstructor.tsx`, which defaults them to 0;
- `app/utils/aiFleet.ts`, `app/utils/shipGrant.ts`, `app/hooks/useShipGrants.ts` and `app/components/aiFleet/AIFleetConstructor.tsx`, which copy them.

Note that `h3` in the renderer files is SVG path data, not this field.

---

## 9. Cheaper game ends and game starts (next full deploy)

_Added 2026-10-31._ The transaction that ends a roguelike fight was the second-largest a player sends (about 2.7M gas for the winning move at 15 ships). It's now about 1.4M; the AI's game-ending turn dropped from about 1.3M to 1.0M; and a game start on a map with scoring tiles costs about 0.4M less.

### ABI changes

- **`Maps`:** the auto-generated `scoringTiles(gameId, row, col)` and `onlyOnceTiles(gameId, row, col)` getters are removed; a game's scoring tiles are stored as one packed list now. Use `isTileScoring`, `getGameScoringPositions` or `getGameMapState`, which keep their shapes. `getGameScoringPositions` (and `getGameMapState().scoringPositions`) may list tiles in a different order than before.
- **`AIShips`:** `freeSlotCount()` is unchanged. `freeSlots(i)` is only meaningful for `i < freeSlotCount()`; entries past it are stale.
- **`Fleets`:** new `reserveFleet(fromFleetId, owner, shipIds, positions, costLimit)`, called only by `RoguelikeMatch` after a win. It moves the surviving ships straight into the next reservation fleet without unlocking them, and checks and locks any rejoining ship. It emits `FleetCleared` and `FleetCreated` like `transferFleet`.
- **`RoguelikeRun`:** new `getRosterHP(player)`, which returns every roster ship's stored hull points in one call, parallel to `getRun(player).rosterShipIds` (0 = full). New `setRosterAndHP` (orchestrator only). `getRun` and `getShipHP` keep their shapes.

### Behavior changes

- **Roster order after a win** now follows the combat fleet's order: survivors first, in the order the fleet held them (a destroyed ship's place is taken by the fleet's last ship), then rejoining ships. Read `rosterShipIds` fresh before building `enterCombatNode` positions, which must match it index for index.
- A ship's stored HP still follows it through the whole run: one dropped at a resupply stop and added back keeps its damage.

### Frontend changes needed

- Don't call `Maps.scoringTiles` or `Maps.onlyOnceTiles` (nothing does today).
- Optional: `GameLens` and any roster HP display can use `RoguelikeRun.getRosterHP` instead of one `getShipHP` per ship.

---

## 10. Checklist

- [ ] After the redeploy: new ABIs for `Game`, `ShipAttributes`, `Fleets`, `GameResults`, `Lobbies`, `GameEngineRegistry` and `AIShips` (§1–§6; `AIShips` lost `shipAttributes()` and `setShipAttributesAddress`).
- [ ] Remove `statusEffects` from the `Attributes` type and everywhere the frontend builds one (§1).
- [ ] Don't call `Fleets.fleets(id)`; use `getFleet` (§2).
- [ ] Compute total games as `wins + losses` (§3).
- [ ] Allow 60-second turns in the lobby UI once the new `Lobbies` is live (§4).
- [ ] Compute AI ship cost (id ≥ `2^40`) with `ShipAttributes.calculateShipCost` instead of reading `shipData.cost` (§6).
- [ ] Trust `isCreator` on destroyed/fled ships once the new `Game` is live (§7).
- [ ] Drop `h3`/`s3`/`l3` from `Colors` and every place that builds one, and take the new `Ships` address and ABI (§8).
- [ ] Take the new `Maps`, `AIShips`, `Fleets` and `RoguelikeRun` ABIs; read a run's `rosterShipIds` fresh after each win, since its order can change (§9).

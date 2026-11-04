# Frontend Handoff — Storage Packing, Dead Code Removed, 60-Second Turns

_Written 2026-10-30, last updated 2026-11-02. Covers contract changes since `frontend-handoff-2026-10-23.md`._

**Deployed to Base Sepolia (chain 84532) on 2026-11-01.** Every "next deploy" in §1–§11 is now live; §12 and §13 are not deployed yet. This was a full redeploy: every contract has a new address, including `Ships`, `RandomManager` and the lottery hook.

- **Addresses:** `ignition/deployments/chain-84532/deployed_addresses.json`.
- **ABIs:** `ignition/deployments/chain-84532/artifacts/DeployModule#<Name>.json`. Take all of them together, not only the contracts named below.
- **Lottery:** a new `UTCLotteryHook` and pool. Its address, ABI, `poolKey` and `poolId` are in `uniswap-lottery-hook.json`. The old pool and hook are retired.
- **Old ships stay on the old contract:** ships minted on the old `Ships` (§8) don't carry over to the new one.

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

More removed 2026-10-31, also never set to anything that's read (orphaned):

- `Ships.droneEnergyCores()`, and its argument to the owner-only `Ships.setConfig`, which now takes nine addresses (`..., universalCredits, purchaseGate`).
- `DroneYard.shipNames()` (and its constructor argument) and `DroneYard.validateShip`.
- `Lobbies.ships()` (Lobbies' constructor takes no arguments now).
- `SinglePlayerMatch.lobbies()` and `setLobbiesAddress` (and its constructor argument).
- `ShipPurchaser.isAllowedToCreateShips(address)`.
- `GameBlobRegistry.getBlob(gameId, player)`: use the `blobs(gameId, player)` getter, which returns the same value.
- The `CadenceArchCaller` contract (never deployed).

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
- **Game outcomes and kill credit (added 2026-11-01, audit-4 HA7-03/04/06/07):**
  - A special or faction ability that removes both sides' last ships now ends the game by score (a draw if tied), and every ship it destroyed is destroyed. Before, the side removed second won and its doomed ship survived.
  - Friendly fire (Flak, Electric Storm, a rammer's own reactor tick) never takes kill credit. The kill (rank) and reward go to the enemy ship that last damaged the destroyed ship. A ship that only its own side ever hit is destroyed with no kill credited and no reward paid.
  - AI heal and ram ships no longer Pass when they can't land in range this turn. They shoot or move instead.
  - **Lottery draws no longer expire once anyone swaps (audit-4 HA7-09).** The first swap after a draw's close block stores that block's hash in the new `UTCLotteryHook.drawSeed(drawId)` getter, whatever the swap's gas. From then on `resolveDraw` always resolves on the original roll. `DrawRetargeted` only fires now if nobody swaps or resolves for the whole 8,191-block window. This replaces the retarget rule described in `frontend-handoff-lottery-prize-retry-2026-10-14.md` once anyone has swapped. A UI that warns "resolve within ~4.5 hours or the draw re-rolls" only needs that warning while `drawSeed(drawId)` is zero.
  - `Ships.syncShipCosts(ids)` now accepts only ids the caller owns or is approved for. Anything else reverts `NotYourShip(id)`, including unminted ids. Manage Navy already syncs only the player's own ships, so it keeps working, but the comment at `ManageNavy.tsx:1328` calling it permissionless is now out of date.
  - **Fleet reads stay consistent (added 2026-11-01).** After a ship is destroyed or flees mid-game, `getFleet` and `getFleetShipIdsAndPositions` now return positions still aligned index for index with `shipIds`; before, a removal could leave them misaligned. A fleet that was cleared or handed off (a lobby leave or timeout, a game end, a roguelike reservation moved into a match) now reads back with empty `shipIds`, empty `startingPositions` and `totalCost` 0. Before, it kept its old positions and cost.
  - A roguelike ship that fled and didn't rejoin after a win (for example, put in another fleet mid-match) is stored at the heal floor. That's the HP it comes back with if added at a resupply stop. Before, it kept its pre-fight HP.

### Frontend changes needed

- Don't call `Maps.scoringTiles` or `Maps.onlyOnceTiles` (nothing does today).
- Optional: `GameLens` and any roster HP display can use `RoguelikeRun.getRosterHP` instead of one `getShipHP` per ship.
- **After `takeAITurn`/`takeAITurns` (added 2026-11-01, audit-4 HA7-11),** check the receipt for an `AITurnTaken` event, not just a success status. A transaction sent with too little gas can succeed without the AI acting: the AI's decision and its Pass fallback both run out of gas inside try/catch. If there's no `AITurnTaken`, resend with more gas, for example 1.5× the estimate. It's still the AI's turn, so nothing else changes.

---

## 10. Drone Energy Cores are whole numbers (next full deploy)

_Added 2026-10-31 (fixes `docs/audit-4.md` HA7-01)._ DEC is meant to be indivisible: you'd never hold or spend part of a core. The token didn't match that:
- It had OpenZeppelin's default 18 decimals.
- Each AI kill minted UTC's 18-decimal reward amount (0.025e18). That's 25 quadrillion cores per kill, enough for every DroneStorefront tier in one kill.

Now:
- **`DroneEnergyCores.decimals()` returns `0`.** Every DEC amount on chain is a plain count of cores: balances, `DroneStorefront.tierCoreCost(i)` (10, 20, 30, …, 1,625), and `DECBonusWinEffect.bonusAmount()` (20).
- **An AI kill pays 1 core.** The amount is the new `ShipsRouter.factionKillReward()`, owner-settable via `setFactionKillReward`. Human (PvP) kills still pay UTC as before. Tier 1 takes 10 AI kills.

### Frontend changes needed

- **Stop dividing DEC by 1e18.** Show the raw bigint as the number of cores (or use `formatUnits(x, 0)`, or read `decimals()`). The current divide-by-1e18 call sites are:
  - `app/components/DroneStorefront.tsx:52` and `:54` (next tier cost and balance), which pass `formatEther(...)` into `formatDec`;
  - `app/components/Header.tsx:998` (the DEC balance).
- **Approvals and turn-ins:** pass the tier cost exactly as read from `tierCoreCost`, with no `parseEther`. `turnInCores` requires the exact amount.
- **Copy:** anything describing kill rewards in DEC should say "1 core per AI kill".

---

## 11. Ship rolls can't be re-rolled; expired ones build a basic ship (next full deploy)

_Added 2026-11-01 (fixes `docs/audit-4.md` HA7-10; design in `docs/trustless-randomness-plan-2026-11-01.md`)._ A ship's traits come from the hash of its mint block. That used to be readable for only about 4.5 hours (8,191 blocks on Base). After that the request expired and needed an admin `RandomManager.retargetExpired`, which was a brand-new roll. A player could see a bad roll, let it expire, and get a new one. Now:

- **Everyday activity fixes rolls in place.** Every mint, construct, reveal, tournament start or build, and lottery swap stores the hash of pending mint blocks (`RandomManager.blockSeed(block)`). Once stored, the ship always constructs with its original roll, however late. No transaction is needed from the player.
- **No re-roll exists.** `retargetExpired`, `RandomnessRetargeted` and RandomManager's `owner()` are gone.
- **A ship expires only if nothing at all happened for the whole window.** That means no mint, construct, reveal, tournament call or swap, by anyone, for about 4.5 hours after its mint. Then `isExpired(serialNumber)` is true for good, and `constructShip` still works but builds a **baseline ship**:
  - tier-0 accuracy, hull and speed;
  - not shiny;
  - rank 1 (or the purchase tier's preset rank);
  - Generic weapon, no armor or shields, no special;
  - a name and colors from its serial number.
- **New views:** `capturePending(maxBlocks)` (permissionless) and `hasPendingCapture()`.

### Frontend changes needed

- **Remove the "awaiting admin re-target" state** for expired ships (from `frontend-handoff-block-hash-randomness-2026-10-16.md`). Instead, when `isExpired(serialNumber)` is true, show that constructing it builds a basic ship. Keep encouraging players to construct promptly.
- **Drop** anything that reads `retargetExpired` or `RandomnessRetargeted`.
- **Add a capture keeper to the backend.** It's a convenience, not a security requirement:
  - **What it does:** a service that calls `RandomManager.capturePending(2)` whenever there's been no game activity for **4 hours**. That's well inside the ~4.5-hour window, so a ship minted just before a quiet stretch is still captured.
  - **Activity:** "game activity" means any transaction to RandomManager, Ships, Lobbies/Game, the match contracts, or the lottery pool. The simplest check is the time of the last `RandomnessRequested`/`RandomnessRevealed` event or swap you've indexed, or just `hasPendingCapture()` combined with the time since the oldest pending request.
  - **Who signs:** `capturePending` is permissionless, so any funded wallet works. Use a low-value hot wallet with no other roles, never an admin key. Each call costs about 30–85k gas, a fraction of a cent on Base.
  - **Off by default:** gate it behind an env var such as `CAPTURE_KEEPER_ENABLED`. Leave it **disabled (unset/false) in every environment until mainnet production**, and enable it only there.
  - **Nothing depends on it:** the contracts don't rely on the keeper for correctness. Without it, a fully idle stretch just yields a baseline ship instead of a re-roll.

---

## 12. AI ship configs set shiny and kills (next full deploy)

_Added 2026-11-02. **Not deployed yet**, unlike §1–§11: it needs another full redeploy after the 2026-11-01 one._ An AI ship config can now make its ships shiny and give them a starting kill count, which sets their rank (and its stat bonus) the same way a player ship's kills do.

### ABI changes

- **`AIEncounters.AIShipConfig`** gains two final fields: `(..., uint8 archetype, bool shiny, uint32 shipsDestroyed)`. `getAIShipConfig`, `getAllAIShipConfigs` and the `aiShipConfigs(id)` getter all change shape.
- **`createAIShipConfig` and `updateAIShipConfig`** take `shiny` and `shipsDestroyed` as two new final arguments.
- **New:** `AIEncounters.MAX_AI_KILLS()` (1,000,000). A higher `shipsDestroyed` reverts `InvalidKillCount()`.
- Every AI ship minted from a config starts with its `shiny` and `shipsDestroyed` (in `Ships.getShip`/`ShipsRouter.getShip`, as for any ship), and its kills go up from there during the match.

### Frontend changes needed

- **ABIs:** take the new `AIEncounters`, `AIShips`, `SinglePlayerMatch` and `RoguelikeMatch` artifacts together after the redeploy.
- **Admin editors:** `useAIEncountersAdmin.ts` already passes the two arguments when the synced ABI has them, and `AIShipConfig` in `app/types/types.ts` already has them as optional fields. Limit the kill-count input to `MAX_AI_KILLS`.
- **Ship cards:** AI ships can now be shiny and ranked above 1. Anything that assumed AI ships are never shiny, or always rank 1, should read the ship's own `shiny` and `shipsDestroyed`.

---

## 13. AI behavior changes and two new archetypes (next full deploy)

_Added 2026-11-03. **Not deployed yet**: it ships with §12 in the next full redeploy._ The on-chain AI (`AIBehavior`, `Variant1AI`, `Variant2AI`) was reworked after a review of every live AI game (`docs/ai-evaluation-2026-11-03.md`). No function or event changes shape. The changes are in what the AI decides, plus one enum.

### New archetypes

`Archetype` gains two values, appended so existing configs and ships keep their numbers:

| Value | Name | Plays as |
|---|---|---|
| 6 | `Runner` | Takes the best free scoring tile. With none free, it goes after the nearest enemy holding one, and shoots tile holders ahead of anything else. With no scoring tiles on the map, it plays as a Grunt. |
| 7 | `Hunter` | Goes after the enemy it can destroy soonest (turns to reach plus shots to destroy it), ignoring tiles. |

`createAIShipConfig` and `updateAIShipConfig` accept 6 and 7. No seed config uses them yet.

### Behavior changes, both factions

- **Tile choice:** ships head for the scoring tile they reach before any enemy, preferring more points per turn of travel. Before, short-range ships went for the tiles on the player's half first.
- **Variant 1 Grunt, Rammer and Support** take a free tile before fighting.
- **Contesting:** while the player earns more points per round from tiles than the AI, ships close on the player's tile holders.
- **Line of sight:** a ship whose target is hidden steps to a reachable tile that has a shot.
- **Targets:** in order, a live ship before a wreck, a kill, a ship on a tile, damage after damage reduction, then lower HP.
- **Variant 2 repair:** it comes first only for a disabled ally, or an ally on a tile that one enemy shot would destroy. Otherwise the ship shoots first.
- **Threat:**
  - variant 1 kiters prefer a firing tile outside every enemy's range;
  - ships below a quarter of their HP, and off a tile, step out of range;
  - ships close on live enemies before wrecks.
- **Walls:** ships don't park beside a tile their own ally holds.
- **Pathfinding:** ships approaching a target find a way around walls. They move to the tile within reach that's nearest the target by walking distance, not just the nearest in a straight line. Moves are unchanged: still one clear line within movement, so nothing new is needed to display them.
- **Shooting after a fallback move (2026-11-04):** when every scoring tile is held, Supports and Turtles in both factions step toward a tile. They now shoot an enemy that's in range of where they land. Before, they passed there even with an enemy in range (found in roguelike game 2199023255555).

- **Turn order:** the AI no longer always moves its ships in id order. It moves first a ship that can destroy an enemy with one shot, then a ship with an enemy in range, then the rest, and Supports last. The frontend shouldn't assume which AI ship acts next; read it from `AITurnTaken`.

### New Maps function

`Maps.getImpassableBitmap(uint gameId) returns (uint256)`: the game's impassable tiles as one bit per cell (`row * 17 + col`). The AI uses it. The frontend can use it too, in place of reading the impassable tiles one by one. It ships with this redeploy, so take the new `Maps` ABI.

### Frontend changes needed

- **Archetype lists:** add `Runner = 6` and `Hunter = 7` to `Archetype` in `app/types/types.ts`, add labels in `app/utils/aiShipConfig.ts` (used by `AIShipConfigEditor.tsx`), and update the value comment in `prisma/schema.prisma`.
- **Web2 AI port:** `app/lib/aiBehaviorWeb2.ts` mirrors the on-chain trees for the off-chain game. It doesn't have any of the changes above. Until it's re-ported from the new `AIBehavior.sol`, `Variant1AI.sol` and `Variant2AI.sol`, web2 AI ships will play the old way, and won't recognize archetypes 6 and 7.

---

## 14. Checklist

- [ ] After the redeploy: new ABIs for `Game`, `ShipAttributes`, `Fleets`, `GameResults`, `Lobbies`, `GameEngineRegistry` and `AIShips` (§1–§6; `AIShips` lost `shipAttributes()` and `setShipAttributesAddress`).
- [ ] Remove `statusEffects` from the `Attributes` type and everywhere the frontend builds one (§1).
- [ ] Don't call `Fleets.fleets(id)`; use `getFleet` (§2).
- [ ] Compute total games as `wins + losses` (§3).
- [ ] Allow 60-second turns in the lobby UI once the new `Lobbies` is live (§4).
- [ ] Compute AI ship cost (id ≥ `2^40`) with `ShipAttributes.calculateShipCost` instead of reading `shipData.cost` (§6).
- [ ] Trust `isCreator` on destroyed/fled ships once the new `Game` is live (§7).
- [ ] Drop `h3`/`s3`/`l3` from `Colors` and every place that builds one, and take the new `Ships` address and ABI (§8).
- [ ] Take the new `Maps`, `AIShips`, `Fleets` and `RoguelikeRun` ABIs; read a run's `rosterShipIds` fresh after each win, since its order can change (§9).
- [ ] Treat DEC as a 0-decimal token: remove the divide-by-1e18 (`formatEther`) from every DEC display and amount (§10).
- [ ] Replace the expired-ship "awaiting admin" state with a "builds a basic ship" notice, and drop `retargetExpired`/`RandomnessRetargeted` (§11).
- [ ] Add the 4-hour-idle `capturePending` keeper to the backend behind an env var, disabled until mainnet production (§11).
- [ ] Take every new address and ABI from `ignition/deployments/chain-84532/`, and the new lottery hook and pool key from `uniswap-lottery-hook.json` (added 2026-11-02).
- [ ] After `takeAITurn`/`takeAITurns`, check the receipt for `AITurnTaken` and resend with more gas if it's missing (§9).
- [ ] Show the lottery "resolve soon or it re-rolls" warning only while `UTCLotteryHook.drawSeed(drawId)` is zero (§9).
- [ ] Update the outdated "permissionless" comment on `syncShipCosts` at `ManageNavy.tsx:1328`; it now reverts `NotYourShip` for ships the caller doesn't own (§9).
- [ ] After the next full redeploy: take the new `AIEncounters`, `AIShips` and match ABIs, cap the admin kill-count input at `MAX_AI_KILLS`, and show shiny and rank on AI ships (§12).
- [ ] Add `Runner = 6` and `Hunter = 7` to the frontend `Archetype` enum, the config editor labels and the Prisma comment, and re-port `aiBehaviorWeb2.ts` from the new AI contracts, including the path search (§13).

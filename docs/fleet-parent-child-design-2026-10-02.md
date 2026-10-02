# Design: Parent/Child Fleets (Roguelike Mission Squads)

**Written: 2026-10-02. Status: built, tested, then reverted on the same day by the owner's decision.
It is not in the contracts.** This doc keeps the design and the exact code (appendix) so it can be
restored later. Line references are to the contracts as of commit `5f61c99` plus that day's uncommitted
work.

## Problem it solved

The goal was a roguelike where the player picks a **roster** under a run-wide point cap, then picks a
**squad** for each mission: a subset of the roster under that mission's own cap. Fled and destroyed
ships leave the roster. Damage persists per ship, and repairs apply whether or not a ship flew the last
mission.

The constraint every design has to meet is that `Ship.shipData.inFleet` is a single bool. If benched
ships aren't held by some fleet during a mission, the player can sell, transfer, or PvP them
mid-mission. `RoguelikeMatch.onGameEnded` then fails to re-reserve them and reverts. `Game._endGame`
calls `onGameEnded` without try/catch, so that revert bricks the game-ending transaction.

## The concept

A **child fleet** draws its ships from a **parent fleet** that already holds them, instead of from free
ships.

- **`Fleets.parentFleetOf[childId] → parentId`.** `0` means a root fleet, the only kind that existed
  before this. It's a side mapping rather than a `Fleet` struct field, so `getFleet`'s ABI stays the
  same.
- **`Fleets.createChildFleet(lobbyId, parentFleetId, owner, shipIds, positions, costLimit, isCreator,
  mapId)`.** It's gated by `isAllowedToManageFleets`. `createFleet` and its `IFleets` signature are
  unchanged, so Lobbies, PvP, and SinglePlayerMatch are untouched. Both functions share one internal
  `_createFleet`.
  - The parent must exist, must be a root (no grandchildren), and must have the same owner. Otherwise
    the call reverts with `InvalidParentFleet`.
  - Each ship must be in the parent (`ShipNotInParentFleet`). This replaces the `ShipAlreadyInFleet`
    check, and `inFleet` is not set again.
  - Duplicate ids, positions, cost version, mixed variant, and the child's own cost limit are all still
    checked.
- **`clearFleet(child)`** empties the child's ship list but does **not** release `inFleet`, because the
  parent still holds those ships. `Game._endGame`'s post-match cleanup therefore can't release benched
  or surviving roster ships.
- **`removeShipFromFleet(child, ship)`** removes the ship from the child and **cascades** to the parent.
  That releases `inFleet` and lowers the parent's `totalCost`. A ship that is destroyed or flees a
  mission leaves the roster at that moment. If the parent no longer has the ship (for example, the
  parent was already cleared), the cascade is a silent no-op instead of a revert. It runs inside
  Game's combat resolution, where a revert would brick the match.

## How RoguelikeMatch used it

- **`startRun`:** unchanged. `_reserveRoster` creates the parent (root) fleet, capped by the roster cap.
- **`enterCombatNode(nodeId, shipIds, positions)`:** no longer clears the reservation. It creates a child
  of `run.reservationFleetId`, capped by `RoguelikeNodeMap.nodeMissionCostCap(nodeId)`, falling back to
  `run.currentCostCap` when that is 0. An empty squad reverts with `EmptyRoster`.
- **`onGameEnded`:**
  - On a loss or draw, it clears the parent, which releases the whole roster, then calls `endRun`.
  - On a win, the child's remaining ships are exactly the survivors. It floor-heals them, then sets the
    roster to the parent's current ship list. There's no re-reservation.
  - On a final-node win, it clears the parent, then calls `endRun(won)`.
- **Benched ships needed no auto-heal pass.** HP only drops inside a mission, and every won mission
  floors its survivors, so a benched ship is already at or above the floor.
- **`RoguelikeResupply`:** unchanged. It only acts between nodes, when no child exists.

## Trade-offs recorded at the time

- **Compared with the alternative "bench fleet" design:** that design held unselected ships in a second
  root fleet during each mission and rebuilt it every node. The parent/child design was chosen because
  Fleets enforces "only roster ships can fly," the roster has one source of truth, and fled ships leave
  it automatically.
- **Size:** `RoguelikeMatch` went from 22.42 KiB to 22.61 KiB. `Fleets` was 8.07 KiB.
- **Deploy cost:** changing `Fleets` means deploying a new `Game` engine and repointing every orchestrator.
  `Game.setAddresses` is frozen once a game has started (UA-01). `Game.sol`'s source needed no change.
- **Hostile actors:** every new entry point stayed behind `isAllowedToManageFleets`, so there was no new
  permissionless surface.

## Seeded caps that went with it (also reverted)

These were in `ignition/data/roguelikeStarterContent.json` and `docs/roguelike-progression.md`. The revert restored the original 500 starting cap and resupply caps of 700 / 900 / 750 / 1200 / 1600, with no mission caps. The deploy module read `nodes[].missionCostCap` and called `setNodeMissionCostCap`.

Runs now pick a **roster** under a roster cap, then a **squad** from it for each fight, under that fight's mission cap (see `docs/frontend-handoff-roguelike-mission-squads-2026-10-02.md`). The seeded values:

- **Roster cap:** starts at **1000** (`campaign.initialCostCap`, was 500). Resupply nodes raise it: `r01` 1400, `r02` 2000, `r03` 1500, `r04` 2400, `r05` 3200 (were 700 / 900 / 750 / 1200 / 1600).
- **Mission cap** (`nodes[].missionCostCap`) = the larger of the old run cap on that path and the enemy fleet's cost, rounded up to 50. No fight got harder than before, and the late fights the enemy used to badly outspend are now at parity.

| Path | Missions → mission cap (enemy cost) |
|---|---|
| Main spine | m01 500 (305) · m02 500 (410) · m03 500 (450) · m04 500 (495) · m05 550 (515) · *r01* · m06 700 (565) · m07 700 (615) · m08 700 (665) · m09 750 (730) · m10 800 (765) · *r02* · m11 900 (805) · m12 900 (865) · m13 950 (905) · m14 950 (945) · m15 1050 (1010) |
| Dead end | d01 500 (450) · d02 550 (515) · d03 650 (615) · *r03* · d04 750 (730) · d05 850 (805) · d06 950 (905) |
| Shortcut | s01 500 (500) · *r04* · s02 1250 (1225) · s03 1300 (1300) |
| Finale | f01 1500 (1480) · f02 1750 (1710) · f03 2000 (1955) · *r05* · f04 2200 (2180) · f05 2400 (2395) · f06 2600 (2585) |

Every mission cap fits inside the roster cap in effect on every path that reaches it; `test/RoguelikeProgression.test.ts` checks this on-chain. **The finale is easier than before:** the player used to field 900–1600 points against 1480–2585 and now gets parity. Retune individual `missionCostCap` values if the finale should stay a wall.

## Tests that existed (removed with the revert)

- **`test/Fleets.test.ts`, "Fleets — child fleets":**
  - A child is created without touching `inFleet`.
  - A non-parent ship is rejected.
  - A missing, nested, or differently-owned parent is rejected.
  - The child's cost limit is enforced.
  - Callers without manage-fleets permission are rejected.
  - Clearing a child keeps ships held, while clearing the parent releases them.
  - Removal cascades to the parent.
  - Removal tolerates a parent that was already cleared.
- **`test/RoguelikeMatch.test.ts`, "Mission squads (roster subsets)":**
  - Subset fielding, with the bench staying `inFleet`.
  - An empty or non-roster squad is rejected.
  - The mission cap is enforced.
  - Setter access control.
  - Bench HP is untouched across a win.
  - A fled ship is removed and released.
  - The bench is released on a loss and on a final-node win.
  - A benched ship's damage persists and can be repaired.
  - `HealAboveFloorWinEffect` heals benched ships.

## Appendix: the contract diff

This is the diff against commit `5f61c99` for `Fleets.sol`, `IFleets.sol`, and `RoguelikeMatch.sol`. The
`RoguelikeMatch` hunk also contains the disabled-ship 0 HP fix ("carry it forward at 1 HP"), which is
independent of this design.

```diff
diff --git a/contracts/Fleets.sol b/contracts/Fleets.sol
index 133a5ab..72f8a35 100644
--- a/contracts/Fleets.sol
+++ b/contracts/Fleets.sol
@@ -33,6 +33,16 @@ contract Fleets is Ownable, IFleets {
     mapping(uint => Fleet) public fleets;
     uint public fleetCount;
 
+    // childFleetId => parentFleetId (0 = a root fleet, the only kind that
+    // existed before 2026-10-02). A child fleet draws its ships from a
+    // parent fleet that already holds them (inFleet == true), instead of
+    // from free ships — used by RoguelikeMatch, where the parent is the
+    // run's whole roster and each combat node fields a child subset of it,
+    // so benched ships stay locked for the entire run. One level deep only:
+    // a child's parent must itself be a root fleet. Kept as a side mapping
+    // rather than a Fleet struct field so getFleet's ABI is unchanged.
+    mapping(uint => uint) public parentFleetOf;
+
     event FleetCreated(
         uint indexed fleetId,
         uint indexed lobbyId,
@@ -52,6 +62,8 @@ contract Fleets is Ownable, IFleets {
     error DuplicateShipId();
     error InvalidPosition();
     error MixedVariantFleet();
+    error ShipNotInParentFleet();
+    error InvalidParentFleet();
 
     constructor(address _ships) Ownable(msg.sender) {
         ships = IShips(_ships);
@@ -89,6 +101,65 @@ contract Fleets is Ownable, IFleets {
         bool _isCreator,
         uint _mapId
     ) external returns (uint) {
+        return
+            _createFleet(
+                _lobbyId,
+                0,
+                _owner,
+                _shipIds,
+                _startingPositions,
+                _costLimit,
+                _isCreator,
+                _mapId
+            );
+    }
+
+    // Same as createFleet, but every ship must currently be in
+    // _parentFleetId (see parentFleetOf) instead of being free. The
+    // parent keeps holding them throughout — clearing this child never
+    // releases them, and removing a ship from it (destroyed/fled in
+    // combat) removes it from the parent too. See clearFleet/
+    // removeShipFromFleet.
+    function createChildFleet(
+        uint _lobbyId,
+        uint _parentFleetId,
+        address _owner,
+        uint[] calldata _shipIds,
+        Position[] calldata _startingPositions,
+        uint _costLimit,
+        bool _isCreator,
+        uint _mapId
+    ) external returns (uint) {
+        Fleet storage parent = fleets[_parentFleetId];
+        if (
+            _parentFleetId == 0 ||
+            parent.id == 0 ||
+            parentFleetOf[_parentFleetId] != 0 ||
+            parent.owner != _owner
+        ) revert InvalidParentFleet();
+        return
+            _createFleet(
+                _lobbyId,
+                _parentFleetId,
+                _owner,
+                _shipIds,
+                _startingPositions,
+                _costLimit,
+                _isCreator,
+                _mapId
+            );
+    }
+
+    function _createFleet(
+        uint _lobbyId,
+        uint _parentFleetId,
+        address _owner,
+        uint[] calldata _shipIds,
+        Position[] calldata _startingPositions,
+        uint _costLimit,
+        bool _isCreator,
+        uint _mapId
+    ) internal returns (uint fleetId) {
         if (!isAllowedToManageFleets[msg.sender])
             revert NotAllowedToManageFleets();
 
@@ -118,9 +189,12 @@ contract Fleets is Ownable, IFleets {
         // to stay live for the rest of createFleet once it returns.
         _validateStartingPositions(_startingPositions, _isCreator, _mapId);
 
-        uint totalCost = 0;
+        // Same stack-pressure reasoning as _validateStartingPositions.
+        uint totalCost = _validateShips(_owner, _shipIds, _parentFleetId);
+        if (totalCost > _costLimit) revert InvalidFleetCost();
+
         fleetCount++;
-        uint fleetId = fleetCount;
+        fleetId = fleetCount;
 
         Fleet storage newFleet = fleets[fleetId];
         newFleet.id = fleetId;
@@ -133,7 +207,31 @@ contract Fleets is Ownable, IFleets {
             newFleet.startingPositions.push(_startingPositions[i]);
         }
 
-        // Validate ships and calculate total cost
+        newFleet.totalCost = totalCost;
+        newFleet.isComplete = true;
+
+        if (_parentFleetId != 0) {
+            // Ships stay held by the parent — no inFleet change.
+            parentFleetOf[fleetId] = _parentFleetId;
+        } else {
+            // Mark ships as in fleet
+            for (uint i = 0; i < _shipIds.length; i++) {
+                ships.setInFleet(_shipIds[i], true);
+            }
+        }
+
+        emit FleetCreated(fleetId, _lobbyId, _owner);
+    }
+
+    // Per-ship ownership/availability/cost-version/variant checks; returns
+    // the fleet's total cost. A root fleet (_parentFleetId == 0) needs each
+    // ship free (not inFleet); a child fleet instead needs each ship to be
+    // in its parent — those ships are inFleet by definition, held by it.
+    function _validateShips(
+        address _owner,
+        uint[] calldata _shipIds,
+        uint _parentFleetId
+    ) private view returns (uint totalCost) {
         uint16 fleetVariant;
         for (uint i = 0; i < _shipIds.length; i++) {
             uint shipId = _shipIds[i];
@@ -142,8 +240,13 @@ contract Fleets is Ownable, IFleets {
             // Validate ship ownership
             if (ship.owner != _owner) revert ShipNotOwned();
 
-            // Validate ship is not in another fleet
-            if (ship.shipData.inFleet) revert ShipAlreadyInFleet();
+            if (_parentFleetId != 0) {
+                if (!_contains(fleets[_parentFleetId].shipIds, shipId))
+                    revert ShipNotInParentFleet();
+            } else if (ship.shipData.inFleet) {
+                // Validate ship is not in another fleet
+                revert ShipAlreadyInFleet();
+            }
 
             // Validate cost version
             if (
@@ -163,20 +266,16 @@ contract Fleets is Ownable, IFleets {
 
             totalCost += ship.shipData.cost;
         }
+    }
 
-        // Validate total cost
-        if (totalCost > _costLimit) revert InvalidFleetCost();
-
-        newFleet.totalCost = totalCost;
-        newFleet.isComplete = true;
-
-        // Mark ships as in fleet
-        for (uint i = 0; i < _shipIds.length; i++) {
-            ships.setInFleet(_shipIds[i], true);
+    function _contains(
+        uint[] storage _list,
+        uint _value
+    ) private view returns (bool) {
+        for (uint i = 0; i < _list.length; i++) {
+            if (_list[i] == _value) return true;
         }
-
-        emit FleetCreated(fleetId, _lobbyId, _owner);
-        return fleetId;
+        return false;
     }
 
     // Validates each starting position is (a) legal for this side's
@@ -246,9 +345,14 @@ contract Fleets is Ownable, IFleets {
         Fleet storage fleet = fleets[_fleetId];
         if (fleet.id == 0) revert FleetNotFound();
 
-        // Release ships from fleet
-        for (uint i = 0; i < fleet.shipIds.length; i++) {
-            ships.setInFleet(fleet.shipIds[i], false);
+        // Release ships from fleet — root fleets only. A child fleet's
+        // ships are still held by its parent (see parentFleetOf), so
+        // clearing the child (e.g. Game._endGame's post-match cleanup)
+        // must leave them inFleet.
+        if (parentFleetOf[_fleetId] == 0) {
+            for (uint i = 0; i < fleet.shipIds.length; i++) {
+                ships.setInFleet(fleet.shipIds[i], false);
+            }
         }
 
         // Clear the fleet's shipIds array
@@ -257,39 +361,53 @@ contract Fleets is Ownable, IFleets {
         emit FleetCleared(_fleetId);
     }
 
+    // On a child fleet, also removes the ship from its parent (and only
+    // then releases it): a ship destroyed or fled out of a child's match
+    // leaves the parent's roster too. Tolerates the ship already being
+    // gone from the parent (e.g. the parent was cleared first) rather than
+    // reverting — this is called from inside Game's combat resolution,
+    // where a revert would brick the whole match.
     function removeShipFromFleet(uint _fleetId, uint _shipId) external {
         if (!isAllowedToManageFleets[msg.sender])
             revert NotAllowedToManageFleets();
 
-        Fleet storage fleet = fleets[_fleetId];
-        if (fleet.id == 0) revert FleetNotFound();
+        if (fleets[_fleetId].id == 0) revert FleetNotFound();
+
+        uint parentId = parentFleetOf[_fleetId];
+        // Ship not found in fleet
+        if (!_removeFromList(_fleetId, _shipId)) revert ShipNotFound();
+        if (parentId != 0 && !_removeFromList(parentId, _shipId)) return;
+
+        // Release ship from fleet
+        ships.setInFleet(_shipId, false);
+    }
 
-        // Find and remove the ship from the fleet. Swap-and-pop — order
-        // doesn't matter here (fleet.shipIds is consumed purely as a
-        // membership list once a game has started; nothing indexes into it
-        // positionally) — same pattern as NodeMap._removeFromCampaignNodeIds
-        // and RoguelikeNodeMap.removeChild (G-02).
+    // Find and remove the ship from the fleet. Swap-and-pop — order
+    // doesn't matter here (fleet.shipIds is consumed purely as a
+    // membership list once a game has started; nothing indexes into it
+    // positionally) — same pattern as NodeMap._removeFromCampaignNodeIds
+    // and RoguelikeNodeMap.removeChild (G-02).
+    function _removeFromList(
+        uint _fleetId,
+        uint _shipId
+    ) private returns (bool) {
+        Fleet storage fleet = fleets[_fleetId];
         for (uint i = 0; i < fleet.shipIds.length; i++) {
             if (fleet.shipIds[i] == _shipId) {
                 fleet.shipIds[i] = fleet.shipIds[fleet.shipIds.length - 1];
                 fleet.shipIds.pop();
 
-                // Read cost before releasing the ship from the fleet: a ship's cost
-                // is only ever writable while inFleet is false (see Ships._setCostOfShip
-                // and DroneYard.modifyShip), so this ordering can't change behavior
-                // today, but it stops relying on that invariant holding elsewhere.
+                // Cost is read while the ship is still inFleet: a ship's
+                // cost is only ever writable while inFleet is false (see
+                // Ships._setCostOfShip and DroneYard.modifyShip), so this
+                // ordering can't change behavior today, but it stops
+                // relying on that invariant holding elsewhere.
                 Ship memory ship = ships.getShip(_shipId);
                 fleet.totalCost -= ship.shipData.cost;
-
-                // Release ship from fleet
-                ships.setInFleet(_shipId, false);
-
-                return;
+                return true;
             }
         }
-
-        // Ship not found in fleet
-        revert ShipNotFound();
+        return false;
     }
 
     // View functions
@@ -304,14 +422,7 @@ contract Fleets is Ownable, IFleets {
         uint _shipId
     ) external view returns (bool) {
         if (fleets[_fleetId].id == 0) revert FleetNotFound();
-
-        Fleet memory fleet = fleets[_fleetId];
-        for (uint i = 0; i < fleet.shipIds.length; i++) {
-            if (fleet.shipIds[i] == _shipId) {
-                return true;
-            }
-        }
-        return false;
+        return _contains(fleets[_fleetId].shipIds, _shipId);
     }
 
     function getFleetShipIdsAndPositions(
diff --git a/contracts/IFleets.sol b/contracts/IFleets.sol
index f348145..7154436 100644
--- a/contracts/IFleets.sol
+++ b/contracts/IFleets.sol
@@ -14,6 +14,19 @@ interface IFleets {
         uint _mapId
     ) external returns (uint);
 
+    function createChildFleet(
+        uint _lobbyId,
+        uint _parentFleetId,
+        address _owner,
+        uint[] calldata _shipIds,
+        Position[] calldata _startingPositions,
+        uint _costLimit,
+        bool _isCreator,
+        uint _mapId
+    ) external returns (uint);
+
+    function parentFleetOf(uint _fleetId) external view returns (uint);
+
     function clearFleet(uint _fleetId) external;
 
     function removeShipFromFleet(uint _fleetId, uint _shipId) external;
diff --git a/contracts/RoguelikeMatch.sol b/contracts/RoguelikeMatch.sol
index b1417ec..6d32fd0 100644
--- a/contracts/RoguelikeMatch.sol
+++ b/contracts/RoguelikeMatch.sol
@@ -24,10 +24,14 @@ import "./IGameEngineRegistry.sol";
 // draw, or explicit retreat). This sits entirely alongside the existing
 // NodeMap/SinglePlayerMatch campaign, which is untouched.
 //
-// The roster is never a *permanent* Fleets.Fleet with a matching Game — see
-// _reserveRoster. It's torn down and recreated around every combat node
-// specifically to reuse Fleets' own MixedVariantFleet/cost-cap/ownership
-// checks for free at every roster change, rather than reimplementing them.
+// The roster is held for the whole run in a map-agnostic *parent* fleet
+// (run.reservationFleetId — see _reserveRoster), capped by the run's
+// roster cost cap. Each combat node fields a player-chosen subset of it as
+// a Fleets *child* fleet (Fleets.createChildFleet), capped by that node's
+// mission cost cap — so benched ships stay locked for the whole run, and
+// Fleets itself enforces "only roster ships can fly." A ship destroyed or
+// fled out of a mission is removed from the parent by Fleets automatically
+// (removeShipFromFleet cascades), which is how it leaves the roster.
 contract RoguelikeMatch is Ownable, IGameOrchestrator {
     AIShips public aiShips;
     IShips public humanShips;
@@ -219,13 +223,17 @@ contract RoguelikeMatch is Ownable, IGameOrchestrator {
         emit RunStarted(msg.sender, _campaignId, rootNodeId);
     }
 
-    // Fields the run's ENTIRE current roster — there is no per-node squad
-    // sub-selection; if that's wanted later, this is the extension point.
-    // _positions must be in the same order as the run's roster.
+    // Fields _shipIds — any non-empty subset of the run's roster — at
+    // _positions (same order). The subset's total cost must fit the node's
+    // mission cap (RoguelikeNodeMap.nodeMissionCostCap, falling back to the
+    // run's roster cap when unset); the rest of the roster sits this one
+    // out, still held by the reservation (parent) fleet.
     function enterCombatNode(
         uint _targetNodeId,
+        uint[] calldata _shipIds,
         Position[] calldata _positions
     ) external returns (uint gameId) {
+        if (_shipIds.length == 0) revert EmptyRoster();
         Run memory run = runLedger.getRun(msg.sender);
         if (run.status != RunStatus.Active) revert NoActiveRun();
         RoguelikeNode memory node = _commitToNode(msg.sender, run, _targetNodeId);
@@ -238,10 +246,6 @@ contract RoguelikeMatch is Ownable, IGameOrchestrator {
             revert NodeAlreadyDefeated();
         }
 
-        uint[] memory shipIds = run.rosterShipIds;
-
-        fleets.clearFleet(run.reservationFleetId);
-
         matchCount++;
         gameId =
             ROGUELIKE_GAME_ID_OFFSET +
@@ -260,12 +264,14 @@ contract RoguelikeMatch is Ownable, IGameOrchestrator {
             nodeMap.getChildren(_targetNodeId).length == 0;
         winEffectsAtStart[gameId] = nodeMap.getNodeWinEffects(_targetNodeId);
 
-        uint humanFleetId = fleets.createFleet(
+        uint missionCap = nodeMap.nodeMissionCostCap(_targetNodeId);
+        uint humanFleetId = fleets.createChildFleet(
             gameId,
+            run.reservationFleetId,
             msg.sender,
-            shipIds,
+            _shipIds,
             _positions,
-            run.currentCostCap,
+            missionCap != 0 ? missionCap : run.currentCostCap,
             true,
             node.mapId
         );
@@ -292,10 +298,10 @@ contract RoguelikeMatch is Ownable, IGameOrchestrator {
         // Seed persisted damage from a previous node, if any (0 = never
         // damaged this run — the fresh 100% calculateShipAttributes just
         // set inside startGame is already correct, skip the call).
-        for (uint i = 0; i < shipIds.length; i++) {
-            uint8 hp = runLedger.getShipHP(msg.sender, shipIds[i]);
+        for (uint i = 0; i < _shipIds.length; i++) {
+            uint8 hp = runLedger.getShipHP(msg.sender, _shipIds[i]);
             if (hp != 0) {
-                game.setInitialHullPointsOverride(gameId, shipIds[i], hp);
+                game.setInitialHullPointsOverride(gameId, _shipIds[i], hp);
             }
         }
 
@@ -480,13 +486,12 @@ contract RoguelikeMatch is Ownable, IGameOrchestrator {
         runLedger.setActiveGameId(player, 0);
 
         if (_winner != player) {
-            // Loss or draw ends the run. Nothing to release here ourselves
-            // — run.reservationFleetId was already torn down back in
-            // enterCombatNode (never a real fleet during combat), and the
-            // actual combat fleet's survivors are released to normal
-            // ownership automatically by Game._endGame's own unconditional
-            // post-callback fleet cleanup, which runs right after this
-            // function returns.
+            // Loss or draw ends the run: release the whole roster (benched
+            // ships and the mission's survivors alike — all still held by
+            // the parent). Game._endGame's own post-callback clearFleet of
+            // the combat (child) fleet, right after this returns, leaves
+            // inFleet alone for child fleets, so it can't double-release.
+            fleets.clearFleet(run.reservationFleetId);
             runLedger.endRun(player, false);
             return;
         }
@@ -496,30 +501,29 @@ contract RoguelikeMatch is Ownable, IGameOrchestrator {
         // SP-05; enforced in enterCombatNode).
         runLedger.setNodeDefeated(player, run.currentNodeId);
 
-        // The combat fleet's survivors are still inFleet (Game._endGame
-        // only clears fleets *after* this callback returns — see the
-        // comment above), so they must be released here, before
-        // re-reserving them, or _reserveRoster below would revert
-        // MixedVariantFleet/ShipAlreadyInFleet trying to re-fleet a ship
-        // that's still (nominally) in the just-finished combat fleet.
+        // The combat (child) fleet's remaining ships are exactly this
+        // mission's survivors: Game._removeShipFromGame already removed every
+        // destroyed or individually-retreated ship from it — and, via
+        // Fleets' child->parent cascade, from the roster (parent) fleet too.
         // getGameMetadataAndTurnState instead of getGame() — only
         // .metadata.creatorFleetId is needed here (G-04).
         (GameMetadata memory gameMetadata, ) = game
             .getGameMetadataAndTurnState(_gameId);
-        fleets.clearFleet(gameMetadata.creatorFleetId);
+        (uint[] memory survivors, ) = fleets.getFleetShipIdsAndPositions(
+            gameMetadata.creatorFleetId
+        );
 
-        // Capture survivors' HP (auto-heal floor applied), drop anything
-        // not found (destroyed, or individually retreated — either way
-        // Game._removeShipFromGame already deleted its Attributes, so it
-        // simply isn't found here).
+        // Capture survivors' HP (auto-heal floor applied). Benched ships
+        // need no floor pass: stored HP only ever drops inside a mission,
+        // and every won mission floors its survivors, so a benched ship is
+        // already at or above the floor (or undamaged). try/catch kept only
+        // as a guard against bricking Game._endGame (which calls this
+        // without one) — a survivor's attributes are always present.
         // UA-11 fix: pinned at entry (see healPercentAtStart), not the
         // live campaign config.
         uint8 healPercent = healPercentAtStart[_gameId];
-        uint[] memory oldRoster = run.rosterShipIds;
-        uint[] memory survivors = new uint[](oldRoster.length);
-        uint survivorCount;
-        for (uint i = 0; i < oldRoster.length; i++) {
-            uint shipId = oldRoster[i];
+        for (uint i = 0; i < survivors.length; i++) {
+            uint shipId = survivors[i];
             try game.getShipAttributes(_gameId, shipId) returns (
                 Attributes memory attrs
             ) {
@@ -528,13 +532,20 @@ contract RoguelikeMatch is Ownable, IGameOrchestrator {
                     ? attrs.hullPoints
                     : floor;
                 if (healed > attrs.maxHullPoints) healed = attrs.maxHullPoints;
+                // A disabled (0 HP) ship still on the board at a win, under
+                // a 0% floor, would otherwise store 0 — RoguelikeRun's
+                // "never damaged = full HP" sentinel — and silently re-enter
+                // the next node fully healed. Carry it forward at 1 HP.
+                if (healed == 0) healed = 1;
                 runLedger.setShipHP(player, shipId, uint8(healed));
-                survivors[survivorCount] = shipId;
-                survivorCount++;
             } catch {}
         }
-        uint[] memory newRoster = new uint[](survivorCount);
-        for (uint i = 0; i < survivorCount; i++) newRoster[i] = survivors[i];
+
+        // The roster is whatever the parent fleet still holds — benched
+        // ships plus survivors, minus anything lost this mission.
+        (uint[] memory newRoster, ) = fleets.getFleetShipIdsAndPositions(
+            run.reservationFleetId
+        );
 
         // UA-11 fix: pinned at entry (see isFinalNodeAtStart), not the live
         // node graph.
@@ -568,11 +579,11 @@ contract RoguelikeMatch is Ownable, IGameOrchestrator {
             }
         }
 
+        // Otherwise the parent fleet simply stays reserved into the next
+        // node — nothing to recreate.
         if (isFinalNode) {
+            fleets.clearFleet(run.reservationFleetId);
             runLedger.endRun(player, true);
-        } else {
-            uint newFleetId = _reserveRoster(player, newRoster, run.currentCostCap);
-            runLedger.setReservationFleetId(player, newFleetId);
         }
     }
 
```

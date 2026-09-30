// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./Types.sol";
import "./IShips.sol";
import "./IFleets.sol";
import "./IShipAttributes.sol";
import "./RoguelikeNodeMap.sol";
import "./RoguelikeRun.sol";

// Resupply-node *actions* (repair, roster composition changes) for the
// roguelike campaign — split out of RoguelikeMatch.sol purely for size:
// RoguelikeMatch (combat + AI-turn dispatch + graph traversal) was over
// the 24 KiB limit with these inlined, and neither action here touches
// Game.sol/AIEncounters at all, making this a clean cut. Both contracts
// are granted write access to the same RoguelikeRun ledger and both need
// Fleets access (to tear down/recreate the roster's reservation fleet).
contract RoguelikeResupply is Ownable {
    IShips public humanShips;
    IFleets public fleets;
    IShipAttributes public shipAttributes;
    IERC20 public universalCredits;
    RoguelikeNodeMap public nodeMap;
    RoguelikeRun public runLedger;

    // UTC price per hull point restored.
    uint public repairCostPerHP;

    error NoActiveRun();
    error NotResupplyNode();
    error ShipNotInRoster();
    error ShipNotOwned();
    error ShipAlreadyInFleet();
    error WrongCampaignVariant();
    error InsufficientFunds(uint required, uint available);
    error ActiveGameInProgress();

    event ResupplyRepaired(address indexed player, uint shipCount, uint cost);
    event RosterModified(
        address indexed player,
        uint addedCount,
        uint removedCount
    );
    event Withdrawn(address indexed to, uint amount);

    constructor(
        address _humanShips,
        address _fleets,
        address _shipAttributes,
        address _universalCredits,
        address _nodeMap,
        address _runLedger
    ) Ownable(msg.sender) {
        humanShips = IShips(_humanShips);
        fleets = IFleets(_fleets);
        shipAttributes = IShipAttributes(_shipAttributes);
        universalCredits = IERC20(_universalCredits);
        nodeMap = RoguelikeNodeMap(_nodeMap);
        runLedger = RoguelikeRun(_runLedger);
    }

    function setHumanShipsAddress(address _humanShips) external onlyOwner {
        humanShips = IShips(_humanShips);
    }

    function setFleetsAddress(address _fleets) external onlyOwner {
        fleets = IFleets(_fleets);
    }

    function setShipAttributesAddress(
        address _shipAttributes
    ) external onlyOwner {
        shipAttributes = IShipAttributes(_shipAttributes);
    }

    function setUniversalCreditsAddress(
        address _universalCredits
    ) external onlyOwner {
        universalCredits = IERC20(_universalCredits);
    }

    function setNodeMapAddress(address _nodeMap) external onlyOwner {
        nodeMap = RoguelikeNodeMap(_nodeMap);
    }

    function setRunLedgerAddress(address _runLedger) external onlyOwner {
        runLedger = RoguelikeRun(_runLedger);
    }

    function setRepairCostPerHP(uint _cost) external onlyOwner {
        repairCostPerHP = _cost;
    }

    function withdraw(address _to) external onlyOwner {
        uint amount = universalCredits.balanceOf(address(this));
        require(universalCredits.transfer(_to, amount), "UTC transfer failed");
        emit Withdrawn(_to, amount);
    }

    function _requireAtResupplyNode(
        Run memory _run
    ) internal view returns (RoguelikeNode memory node) {
        if (_run.status != RunStatus.Active) revert NoActiveRun();
        // Same guard as RoguelikeMatch.enterResupplyNode/retreatRun(0) — a
        // combat match still live at the current node means
        // _run.currentNodeId hasn't actually been resolved yet, so acting
        // on "the resupply node" here would be acting on stale/wrong state
        // once that game resolves (see docs/audit-2.md HA2-04).
        if (_run.activeGameId != 0) revert ActiveGameInProgress();
        node = nodeMap.getNode(_run.currentNodeId);
        if (node.kind != RoguelikeNodeKind.Resupply) revert NotResupplyNode();
    }

    function _requireInRoster(uint[] memory _roster, uint _shipId) internal pure {
        for (uint i = 0; i < _roster.length; i++) {
            if (_roster[i] == _shipId) return;
        }
        revert ShipNotInRoster();
    }

    // Full-heals every listed ship; cost is missingHP * repairCostPerHP in
    // UTC (transferFrom — same pull-payment pattern as DroneYard.modifyShip
    // — no burn function exists on any of this project's ERC20s).
    function resupplyRepair(uint[] calldata _shipIds) external {
        Run memory run = runLedger.getRun(msg.sender);
        _requireAtResupplyNode(run);

        uint totalMissingHP;
        for (uint i = 0; i < _shipIds.length; i++) {
            uint shipId = _shipIds[i];
            _requireInRoster(run.rosterShipIds, shipId);

            Attributes memory attrs = shipAttributes
                .calculateShipAttributesById(shipId);
            uint8 currentHP = runLedger.getShipHP(msg.sender, shipId);
            uint8 effectiveCurrent = currentHP == 0
                ? attrs.maxHullPoints
                : currentHP;
            if (effectiveCurrent < attrs.maxHullPoints) {
                totalMissingHP += (attrs.maxHullPoints - effectiveCurrent);
            }
            runLedger.setShipHP(msg.sender, shipId, attrs.maxHullPoints);
        }

        uint cost = totalMissingHP * repairCostPerHP;
        if (cost > 0) {
            uint balance = universalCredits.balanceOf(msg.sender);
            if (balance < cost) revert InsufficientFunds(cost, balance);
            require(
                universalCredits.transferFrom(msg.sender, address(this), cost),
                "UTC transfer failed"
            );
        }

        emit ResupplyRepaired(msg.sender, _shipIds.length, cost);
    }

    // Adds/removes ships from the run's roster. The reservation fleet is
    // torn down and recreated against the run's current cost cap, which
    // gets Fleets' own MixedVariantFleet/InvalidFleetCost checks for free.
    function resupplyModifyRoster(
        uint[] calldata _shipIdsToAdd,
        uint[] calldata _shipIdsToRemove
    ) external {
        Run memory run = runLedger.getRun(msg.sender);
        _requireAtResupplyNode(run);

        uint[] memory oldRoster = run.rosterShipIds;
        uint[] memory kept = new uint[](oldRoster.length);
        uint keepCount;
        for (uint i = 0; i < oldRoster.length; i++) {
            bool removeIt = false;
            for (uint j = 0; j < _shipIdsToRemove.length; j++) {
                if (oldRoster[i] == _shipIdsToRemove[j]) {
                    removeIt = true;
                    break;
                }
            }
            if (!removeIt) {
                kept[keepCount] = oldRoster[i];
                keepCount++;
            }
        }

        // UA-16 fix (2026-09-29): pinned at startRun (run.requiredVariantAtStart),
        // not the live campaign config.
        uint16 requiredVariant = run.requiredVariantAtStart;
        for (uint i = 0; i < _shipIdsToAdd.length; i++) {
            Ship memory ship = humanShips.getShip(_shipIdsToAdd[i]);
            if (ship.owner != msg.sender) revert ShipNotOwned();
            if (ship.shipData.inFleet) revert ShipAlreadyInFleet();
            if (requiredVariant != 0 && ship.traits.variant != requiredVariant)
                revert WrongCampaignVariant();
        }

        uint newLength = keepCount + _shipIdsToAdd.length;
        uint[] memory newRoster = new uint[](newLength);
        for (uint i = 0; i < keepCount; i++) newRoster[i] = kept[i];
        for (uint i = 0; i < _shipIdsToAdd.length; i++)
            newRoster[keepCount + i] = _shipIdsToAdd[i];

        fleets.clearFleet(run.reservationFleetId);
        uint newFleetId = _reserveRoster(msg.sender, newRoster, run.currentCostCap);

        runLedger.setRoster(msg.sender, newRoster);
        runLedger.setReservationFleetId(msg.sender, newFleetId);

        emit RosterModified(
            msg.sender,
            _shipIdsToAdd.length,
            _shipIdsToRemove.length
        );
    }

    // Synthetic grid positions — mirrors RoguelikeMatch._reserveRoster
    // exactly (duplicated rather than shared, since it's a handful of
    // lines and not worth a third contract/library just to dedupe it).
    function _reserveRoster(
        address _player,
        uint[] memory _shipIds,
        uint _costCap
    ) internal returns (uint fleetId) {
        Position[] memory positions = new Position[](_shipIds.length);
        for (uint i = 0; i < _shipIds.length; i++) {
            positions[i] = Position({
                row: int16(int(i / 4)),
                col: int16(int(i % 4))
            });
        }
        // mapId 0: map-agnostic synthetic fleet, see the doc comment above.
        fleetId = fleets.createFleet(0, _player, _shipIds, positions, _costCap, true, 0);
    }
}

// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/access/Ownable.sol";
import "./Types.sol";
import "./IShips.sol";
import "./IFleets.sol";
import "./IShipAttributes.sol";
import "./IMaps.sol";

contract Fleets is Ownable, IFleets {
    IShips public ships;
    IShipAttributes public shipAttributes;
    // Optional: used by createFleet to validate starting positions against a
    // map's own deployment zone (see isValidDeploymentTile). Unset (or
    // _mapId == 0, e.g. the synthetic placeholder fleets RoguelikeMatch/
    // RoguelikeResupply mint) falls back to the historical hardcoded column
    // rule below, unchanged.
    IMaps public maps;
    // Contracts (e.g. Lobbies, SinglePlayerMatch, and — since 2026-09-28 —
    // every Game engine instance) authorized to manage fleets, mirroring
    // Game.isAllowedToStartGames. Widened from a single lobbiesAddress so
    // more than one orchestrator can create/clear fleets (Lobbies-free
    // vs-AI matches via SinglePlayerMatch, alongside PvP via Lobbies).
    // Game.sol's own direct calls (removeShipFromFleet/clearFleet, for
    // ship-destruction/game-end cleanup) used to check a separate single
    // `gameAddress` — folded into this same allowlist instead, so any
    // number of Game instances (one per gameplay-rules "engine") can be
    // authorized without a dedicated single-address slot that only ever
    // fits one of them. See the engine-registry plan.
    mapping(address => bool) public isAllowedToManageFleets;

    mapping(uint => Fleet) public fleets;
    uint public fleetCount;

    event FleetCreated(
        uint indexed fleetId,
        uint indexed lobbyId,
        address indexed owner
    );
    event FleetCleared(uint indexed fleetId);

    error NotAllowedToManageFleets();
    error FleetNotFound();
    error ShipNotOwned();
    error ShipAlreadyInFleet();
    error ShipNotConstructed();
    error ShipCostVersionMismatch();
    error InvalidFleetCost();
    error ShipNotFound();
    error DuplicatePosition();
    error ArrayLengthMismatch();
    error DuplicateShipId();
    error InvalidPosition();
    error MixedVariantFleet();

    constructor(address _ships) Ownable(msg.sender) {
        ships = IShips(_ships);
    }

    function setIsAllowedToManageFleets(
        address _address,
        bool _isAllowed
    ) public onlyOwner {
        isAllowedToManageFleets[_address] = _isAllowed;
    }

    function setShipAttributes(address _shipAttributes) public onlyOwner {
        shipAttributes = IShipAttributes(_shipAttributes);
    }

    function setMapsAddress(address _maps) public onlyOwner {
        maps = IMaps(_maps);
    }

    // Lets a future ShipsRouter (or any other IShips-compatible facade) be
    // swapped in without redeploying this contract — see Game.sol's
    // setAddresses for why this matters (AIShips' id offset has finite
    // headroom against Ships.sol's own growing id space).
    function setShipsAddress(address _ships) public onlyOwner {
        ships = IShips(_ships);
    }

    // True only during a createFleetFrozenPrices call; cleared again before
    // it returns (the set-then-clear is mostly refunded, so it costs a few
    // thousand gas net). A flag rather than a parameter because
    // createFleet's frame is already at the legacy codegen's stack limit;
    // ordinary storage because this compiler job targets Paris (no
    // transient storage).
    bool private _frozenPrices;

    // Same as createFleet, minus the costs-version check: each ship counts
    // at its stored `cost` from when it was last priced, even if
    // ShipAttributes.setCosts has bumped the variant's version since. For
    // orchestrators that hold one roster across many fleets (a roguelike
    // run): prices are checked once when the run starts, then frozen for
    // the run, the same way a ship's cost is frozen for a single fleet's
    // lifetime everywhere else. Without this, a routine setCosts mid-run
    // makes every later fleet for that run revert ShipCostVersionMismatch
    // while the ships are locked and can't be re-synced (docs/audit-3.md
    // HA6-09). Callers must check current prices themselves for any ship
    // entering the roster (run start, resupply adds).
    function createFleetFrozenPrices(
        uint _lobbyId,
        address _owner,
        uint[] calldata _shipIds,
        Position[] calldata _startingPositions,
        uint _costLimit,
        bool _isCreator,
        uint _mapId
    ) external returns (uint fleetId) {
        _frozenPrices = true;
        fleetId = createFleet(
            _lobbyId,
            _owner,
            _shipIds,
            _startingPositions,
            _costLimit,
            _isCreator,
            _mapId
        );
        _frozenPrices = false;
    }

    function createFleet(
        uint _lobbyId,
        address _owner,
        uint[] calldata _shipIds,
        Position[] calldata _startingPositions,
        uint _costLimit,
        bool _isCreator,
        uint _mapId
    ) public returns (uint) {
        if (!isAllowedToManageFleets[msg.sender])
            revert NotAllowedToManageFleets();

        // Validate that shipIds and startingPositions arrays have the same length
        if (_shipIds.length != _startingPositions.length)
            revert ArrayLengthMismatch();

        // HA4-05 fix (2026-09-29): reject a duplicate shipId at this one
        // shared entry point, before the more expensive per-ship validation
        // below even starts. Game.startGame's own calculateShipAttributes
        // already rejects a duplicate via its snapshot-once guard, but
        // RoguelikeMatch's map-agnostic reservation fleets (mapId 0) never
        // reach that check — a duplicate there silently succeeds here and
        // only surfaces as a permanent dead end the first time the player
        // tries to actually enter combat with it. O(n^2) is fine at this
        // game's realistic fleet sizes (topping out around a dozen ships).
        for (uint i = 0; i < _shipIds.length; i++) {
            for (uint j = i + 1; j < _shipIds.length; j++) {
                if (_shipIds[i] == _shipIds[j]) revert DuplicateShipId();
            }
        }

        // Split into its own function purely to relieve legacy-codegen
        // stack pressure — createFleet's own frame was already close to its
        // limit before the _mapId param was added, and this validation
        // step's own locals (the bitset, per-position loop vars) don't need
        // to stay live for the rest of createFleet once it returns.
        _validateStartingPositions(_startingPositions, _isCreator, _mapId);

        uint totalCost = 0;
        fleetCount++;
        uint fleetId = fleetCount;

        Fleet storage newFleet = fleets[fleetId];
        newFleet.id = fleetId;
        newFleet.lobbyId = _lobbyId;
        newFleet.owner = _owner;
        newFleet.shipIds = _shipIds;

        // Copy startingPositions array element by element
        for (uint i = 0; i < _startingPositions.length; i++) {
            newFleet.startingPositions.push(_startingPositions[i]);
        }

        // Validate ships and calculate total cost
        uint16 fleetVariant;
        for (uint i = 0; i < _shipIds.length; i++) {
            uint shipId = _shipIds[i];
            Ship memory ship = ships.getShip(shipId);

            // Validate ship ownership
            if (ship.owner != _owner) revert ShipNotOwned();

            // Validate ship is not in another fleet
            if (ship.shipData.inFleet) revert ShipAlreadyInFleet();

            // docs/audit-3.md HA6-23: an unconstructed ship has all-zero
            // traits, and the permissionless Ships.syncShipCosts can still
            // stamp it with a current costsVersion — without this it could
            // join a fleet (and then never be constructable while inFleet).
            if (!ship.shipData.constructed) revert ShipNotConstructed();

            // Validate cost version (skipped for createFleetFrozenPrices)
            if (
                !_frozenPrices &&
                ship.shipData.costsVersion !=
                shipAttributes.getCurrentCostsVersion(ship.traits.variant)
            ) revert ShipCostVersionMismatch();

            // A PLAYER fleet is one faction's ships only — factions have
            // distinct art, weapon flavor, and (variant 2) a different
            // faction ability. AI enemy fleets may mix factions
            // (docs/audit-3.md HA6-30): Game dispatches specials/abilities
            // and AI decisions per ship, not per fleet. An AI fleet is the
            // one created with the calling orchestrator as its own owner;
            // a player fleet is always created on a player's behalf. (Reads
            // newFleet.owner, already set from _owner above, rather than
            // _owner itself: this frame is at the legacy stack limit.)
            if (i == 0) {
                fleetVariant = ship.traits.variant;
            } else if (
                ship.traits.variant != fleetVariant &&
                newFleet.owner != msg.sender
            ) {
                revert MixedVariantFleet();
            }

            totalCost += ship.shipData.cost;
        }

        // Validate total cost
        if (totalCost > _costLimit) revert InvalidFleetCost();

        newFleet.totalCost = totalCost;
        newFleet.isComplete = true;

        // Mark ships as in fleet
        for (uint i = 0; i < _shipIds.length; i++) {
            ships.setInFleet(_shipIds[i], true);
        }

        emit FleetCreated(fleetId, _lobbyId, _owner);
        return fleetId;
    }

    // Validates each starting position is (a) legal for this side's
    // deployment zone and (b) not a duplicate. Checks for duplicates in the
    // same pass as the zone check (I-09: these used to be two separate
    // loops over the same array with no dependency between them). O(n), all
    // in memory, no storage writes. Bitset for the 17x11 grid (187
    // positions max — 2 * 256 = 512 bits is ample).
    //
    // A real map to validate deployment positions against, or not: 0 is the
    // shared "no map" sentinel (matches Maps.sol's own MapNotFound
    // convention and Lobbies.selectedMapId==0's "no preset map" meaning) —
    // used here for RoguelikeMatch/RoguelikeResupply's synthetic placeholder
    // fleets, which have no real map at all. An unwired `maps` address
    // falls back the same way, so this never becomes a hard dependency on
    // deploy wiring order.
    function _validateStartingPositions(
        Position[] calldata _startingPositions,
        bool _isCreator,
        uint _mapId
    ) private view {
        bool useMapZones = _mapId != 0 && address(maps) != address(0);
        uint256[2] memory positionBitset;
        for (uint i = 0; i < _startingPositions.length; i++) {
            Position memory pos = _startingPositions[i];

            if (useMapZones) {
                // Map-specific deployment zone (falls back to the same
                // default column band internally if this map has no custom
                // zone configured for this side — see isValidDeploymentTile).
                if (
                    !maps.isValidDeploymentTile(
                        _mapId,
                        pos.row,
                        pos.col,
                        _isCreator
                    )
                ) revert InvalidPosition();
            } else if (_isCreator) {
                // Creator ships must be in columns 0-3 (first 4 columns)
                if (pos.col < 0 || pos.col > 3) revert InvalidPosition();
            } else {
                // Joiner ships must be in columns 13-16 (last 4 columns)
                if (pos.col < 13 || pos.col > 16) revert InvalidPosition();
            }

            // Validate row bounds (0-10 for 11 rows)
            if (pos.row < 0 || pos.row > 10) revert InvalidPosition();

            // Convert position to single key: row * GRID_WIDTH + col
            uint256 key = uint256(int256(pos.row)) *
                17 +
                uint256(int256(pos.col));
            uint256 wordIndex = key / 256;
            uint256 bitIndex = key % 256;
            if ((positionBitset[wordIndex] & (1 << bitIndex)) != 0) {
                revert DuplicatePosition();
            }
            positionBitset[wordIndex] |= (1 << bitIndex);
        }
    }

    function clearFleet(uint _fleetId) external {
        if (!isAllowedToManageFleets[msg.sender])
            revert NotAllowedToManageFleets();

        Fleet storage fleet = fleets[_fleetId];
        if (fleet.id == 0) revert FleetNotFound();

        // Release ships from fleet
        for (uint i = 0; i < fleet.shipIds.length; i++) {
            ships.setInFleet(fleet.shipIds[i], false);
        }

        // Clear the fleet's shipIds array
        delete fleet.shipIds;

        emit FleetCleared(_fleetId);
    }

    function removeShipFromFleet(uint _fleetId, uint _shipId) external {
        if (!isAllowedToManageFleets[msg.sender])
            revert NotAllowedToManageFleets();

        Fleet storage fleet = fleets[_fleetId];
        if (fleet.id == 0) revert FleetNotFound();

        // Find and remove the ship from the fleet. Swap-and-pop — order
        // doesn't matter here (fleet.shipIds is consumed purely as a
        // membership list once a game has started; nothing indexes into it
        // positionally) — same pattern as NodeMap._removeFromCampaignNodeIds
        // and RoguelikeNodeMap.removeChild (G-02).
        for (uint i = 0; i < fleet.shipIds.length; i++) {
            if (fleet.shipIds[i] == _shipId) {
                fleet.shipIds[i] = fleet.shipIds[fleet.shipIds.length - 1];
                fleet.shipIds.pop();

                // Read cost before releasing the ship from the fleet: a ship's cost
                // is only ever writable while inFleet is false (see Ships._setCostOfShip
                // and DroneYard.modifyShip), so this ordering can't change behavior
                // today, but it stops relying on that invariant holding elsewhere.
                Ship memory ship = ships.getShip(_shipId);
                fleet.totalCost -= ship.shipData.cost;

                // Release ship from fleet
                ships.setInFleet(_shipId, false);

                return;
            }
        }

        // Ship not found in fleet
        revert ShipNotFound();
    }

    // View functions
    function getFleet(uint _fleetId) external view returns (Fleet memory) {
        if (fleets[_fleetId].id == 0) revert FleetNotFound();
        return fleets[_fleetId];
    }

    // Check if a ship is in a specific fleet
    function isShipInFleet(
        uint _fleetId,
        uint _shipId
    ) external view returns (bool) {
        if (fleets[_fleetId].id == 0) revert FleetNotFound();

        Fleet memory fleet = fleets[_fleetId];
        for (uint i = 0; i < fleet.shipIds.length; i++) {
            if (fleet.shipIds[i] == _shipId) {
                return true;
            }
        }
        return false;
    }

    function getFleetShipIdsAndPositions(
        uint _fleetId
    )
        external
        view
        returns (uint[] memory shipIds, Position[] memory startingPositions)
    {
        if (fleets[_fleetId].id == 0) revert FleetNotFound();
        Fleet memory fleet = fleets[_fleetId];
        return (fleet.shipIds, fleet.startingPositions);
    }
}

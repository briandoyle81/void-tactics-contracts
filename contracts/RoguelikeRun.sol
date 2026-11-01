// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/access/Ownable.sol";

enum RunStatus {
    None,
    Active,
    Won,
    Ended
}

// What getRun returns. Stored as RunRecord (below); the roster's hull
// points are read with getShipHP/getRosterHP.
struct Run {
    RunStatus status;
    // Bumped on every startRun for this player. shipHP/locked below are
    // keyed by (player, generation, ...) rather than living directly in
    // this struct, specifically so a new run doesn't inherit a previous
    // run's locked-node/damage state: `delete`-ing a struct never resets
    // nested mappings in Solidity, so a plain `mapping(uint => bool) locked`
    // member here would silently carry stale locks into a player's second
    // run in the same campaign. Bumping the generation instead makes old
    // entries permanently unreachable (not reset, just orphaned) — cheaper
    // and simpler than actually clearing them.
    uint generation;
    uint campaignId;
    uint currentNodeId;
    uint currentCostCap;
    // The Fleets.Fleet id reserving every roster ship (inFleet == true) so
    // it can't be fielded anywhere else while this run is active. See
    // RoguelikeMatch for how this is created/torn down.
    uint reservationFleetId;
    uint[] rosterShipIds;
    // The gameId of this run's currently in-progress combat match, if any
    // (0 = between nodes, no live game). Set on enterCombatNode, cleared on
    // that game's onGameEnded callback — lets RoguelikeMatch tell an active
    // game apart from a stale/abandoned one calling back late (see
    // docs/pre-audit.md SP-04).
    uint activeGameId;
    // UA-16 fix (2026-09-29): the campaign's required faction, pinned as of
    // startRun — RoguelikeResupply.resupplyModifyRoster reads this instead
    // of re-deriving it live from RoguelikeNodeMap.campaignRequiredVariant,
    // so tightening/loosening a campaign's requirement mid-run doesn't
    // change what a run that already started under the old rule enforces
    // for its own resupply stops. 0 = unrestricted (same convention as the
    // live source).
    uint16 requiredVariantAtStart;
}

// Per-player roguelike run ledger — dumb state only (no Game/Fleets/token
// calls of its own), mutated exclusively by an allowed orchestrator
// (RoguelikeMatch), mirroring NodeMap.isAllowedToCompleteNodes' shape.
// Split out from RoguelikeMatch specifically to keep that contract's own
// bytecode budget centered on orchestration logic.
contract RoguelikeRun is Ownable {
    // Run as stored (2026-10-31): each roster entry packs a ship id with its
    // persisted hull points (id << 8 | hp), four to a slot, so setting the
    // roster and every ship's HP after a win is a few slot writes instead
    // of one first write per ship. Hull points 0 = not yet damaged this run
    // (full); a real roster ship's stored HP is never 0, since a ship that
    // reaches 0 HP is destroyed and dropped from the roster.
    struct RunRecord {
        RunStatus status;
        uint16 requiredVariantAtStart;
        uint generation;
        uint campaignId;
        uint currentNodeId;
        uint currentCostCap;
        uint reservationFleetId;
        uint activeGameId;
        uint64[] roster;
    }

    mapping(address => RunRecord) private runs;

    // player => generation => shipId => hull points of a ship that left
    // the roster this run (0 = full or never stored). A ship's HP follows
    // it for the whole run, as when every ship's HP lived here: one dropped
    // at a resupply stop and added back later comes back with the damage
    // it left with, not healed for free. Written only when a damaged ship
    // leaves the roster, and cleared when it rejoins.
    mapping(address => mapping(uint => mapping(uint => uint8)))
        private shipHPByGen;
    // player => generation => nodeId => locked out for this run.
    mapping(address => mapping(uint => mapping(uint => bool)))
        private lockedByGen;
    // player => generation => nodeId => already won this run — distinct
    // from lockedByGen (access denial from branch exclusivity): this is
    // reward-eligibility. Keyed by generation for the same reason
    // lockedByGen is, so a new run doesn't inherit a previous one's
    // defeats. Prevents farming a Combat node's kill rewards repeatedly via
    // a cycle in the graph back to it (see docs/pre-audit.md SP-05), and
    // gates leaving a Combat node (RoguelikeMatch's CurrentNodeNotCleared).
    mapping(address => mapping(uint => mapping(uint => bool)))
        private defeatedByGen;

    mapping(address => bool) public isAllowedToModifyRuns;

    // UA-05 fix (2026-09-29): how many active runs currently have
    // currentNodeId == this node, across every player. Lets
    // RoguelikeNodeMap.removeChild refuse to remove a node's LAST
    // remaining child while any run is actually standing there right now —
    // without this, an ordinary content edit (pruning a dead-end branch,
    // reworking a hub) can silently strand an in-progress run with zero
    // forward moves and no way back, through no fault of the player. See
    // docs/upgrade-safety-audit-2026-09-29.md UA-05.
    mapping(uint => uint) public activeRunsAtNode;

    // Total runs ever started. RoguelikeMatch and RoguelikeResupply lock the
    // address setters their live runs depend on once this is non-zero
    // (docs/audit-3.md HA6-13), the same rule as PvPMatch.gamesStarted.
    uint public runsStarted;

    error NotAllowedToModifyRuns();
    error RunAlreadyActive();
    error ShipIdTooLarge();
    error ArrayLengthMismatch();

    event RunStarted(address indexed player, uint indexed campaignId);
    event RunEnded(address indexed player, bool won);

    constructor() Ownable(msg.sender) {}

    modifier onlyAllowed() {
        if (!isAllowedToModifyRuns[msg.sender])
            revert NotAllowedToModifyRuns();
        _;
    }

    function setIsAllowedToModifyRuns(
        address _address,
        bool _allowed
    ) external onlyOwner {
        isAllowedToModifyRuns[_address] = _allowed;
    }

    function startRun(
        address _player,
        uint _campaignId,
        uint _rootNodeId,
        uint _initialCostCap,
        uint[] calldata _initialRoster,
        uint _reservationFleetId,
        uint16 _requiredVariant
    ) external onlyAllowed {
        RunRecord storage run = runs[_player];
        if (run.status == RunStatus.Active) revert RunAlreadyActive();

        run.status = RunStatus.Active;
        run.generation += 1;
        run.campaignId = _campaignId;
        run.currentNodeId = _rootNodeId;
        run.currentCostCap = _initialCostCap;
        run.reservationFleetId = _reservationFleetId;
        uint64[] memory roster = new uint64[](_initialRoster.length);
        for (uint i = 0; i < roster.length; i++) {
            roster[i] = _entry(_initialRoster[i], 0);
        }
        run.roster = roster;
        run.requiredVariantAtStart = _requiredVariant;
        activeRunsAtNode[_rootNodeId] += 1;
        runsStarted++;

        emit RunStarted(_player, _campaignId);
    }

    function setCurrentNode(address _player, uint _nodeId) external onlyAllowed {
        RunRecord storage run = runs[_player];
        if (run.currentNodeId != 0) {
            activeRunsAtNode[run.currentNodeId] -= 1;
        }
        activeRunsAtNode[_nodeId] += 1;
        run.currentNodeId = _nodeId;
    }

    function lockNode(address _player, uint _nodeId) external onlyAllowed {
        RunRecord storage run = runs[_player];
        lockedByGen[_player][run.generation][_nodeId] = true;
    }

    function isNodeLocked(
        address _player,
        uint _nodeId
    ) external view returns (bool) {
        RunRecord storage run = runs[_player];
        return lockedByGen[_player][run.generation][_nodeId];
    }

    function setNodeDefeated(address _player, uint _nodeId) external onlyAllowed {
        RunRecord storage run = runs[_player];
        defeatedByGen[_player][run.generation][_nodeId] = true;
    }

    function isNodeDefeated(
        address _player,
        uint _nodeId
    ) external view returns (bool) {
        RunRecord storage run = runs[_player];
        return defeatedByGen[_player][run.generation][_nodeId];
    }

    function setCostCap(address _player, uint _costCap) external onlyAllowed {
        runs[_player].currentCostCap = _costCap;
    }

    // Replaces the roster. Each ship keeps the hull points it already has
    // this run, whether in the old roster or stored when it left.
    function setRoster(
        address _player,
        uint[] calldata _shipIds
    ) external onlyAllowed {
        _setRoster(_player, _shipIds, new uint8[](0));
    }

    // Replaces the roster and sets every ship's hull points (0 = full),
    // parallel to _shipIds: one call for a win's whole roster.
    function setRosterAndHP(
        address _player,
        uint[] calldata _shipIds,
        uint8[] calldata _hullPoints
    ) external onlyAllowed {
        if (_hullPoints.length != _shipIds.length) revert ArrayLengthMismatch();
        _setRoster(_player, _shipIds, _hullPoints);
    }

    // An empty _hullPoints keeps each ship's current hull points.
    function _setRoster(
        address _player,
        uint[] calldata _shipIds,
        uint8[] memory _hullPoints
    ) private {
        RunRecord storage run = runs[_player];
        mapping(uint => uint8) storage dropped = shipHPByGen[_player][
            run.generation
        ];
        uint64[] memory old = run.roster;
        bool[] memory oldKept = new bool[](old.length);
        uint64[] memory roster = new uint64[](_shipIds.length);
        for (uint i = 0; i < _shipIds.length; i++) {
            uint shipId = _shipIds[i];
            bool found = false;
            uint8 hp = 0;
            for (uint j = 0; j < old.length; j++) {
                if (old[j] >> 8 == shipId) {
                    oldKept[j] = true;
                    found = true;
                    hp = uint8(old[j]);
                    break;
                }
            }
            if (!found) {
                hp = dropped[shipId];
                if (hp != 0) dropped[shipId] = 0;
            }
            if (_hullPoints.length != 0) hp = _hullPoints[i];
            roster[i] = _entry(shipId, hp);
        }
        for (uint j = 0; j < old.length; j++) {
            if (!oldKept[j] && uint8(old[j]) != 0) {
                dropped[old[j] >> 8] = uint8(old[j]);
            }
        }
        run.roster = roster;
    }

    function setReservationFleetId(
        address _player,
        uint _fleetId
    ) external onlyAllowed {
        runs[_player].reservationFleetId = _fleetId;
    }

    function setActiveGameId(
        address _player,
        uint _gameId
    ) external onlyAllowed {
        runs[_player].activeGameId = _gameId;
    }

    function setShipHP(
        address _player,
        uint _shipId,
        uint8 _hullPoints
    ) external onlyAllowed {
        RunRecord storage run = runs[_player];
        uint64[] storage roster = run.roster;
        for (uint i = 0; i < roster.length; i++) {
            if (roster[i] >> 8 == _shipId) {
                roster[i] = _entry(_shipId, _hullPoints);
                return;
            }
        }
        shipHPByGen[_player][run.generation][_shipId] = _hullPoints;
    }

    // 0 means "not yet damaged this run" — RoguelikeMatch treats that as
    // "use the fresh 100% ShipAttributes just calculated," never as "enter
    // combat at 0 HP."
    function getShipHP(
        address _player,
        uint _shipId
    ) external view returns (uint8) {
        RunRecord storage run = runs[_player];
        uint64[] storage roster = run.roster;
        for (uint i = 0; i < roster.length; i++) {
            uint64 e = roster[i];
            if (e >> 8 == _shipId) return uint8(e);
        }
        return shipHPByGen[_player][run.generation][_shipId];
    }

    // Every roster ship's hull points, parallel to getRun's rosterShipIds.
    function getRosterHP(
        address _player
    ) external view returns (uint8[] memory hp) {
        uint64[] storage roster = runs[_player].roster;
        hp = new uint8[](roster.length);
        for (uint i = 0; i < hp.length; i++) hp[i] = uint8(roster[i]);
    }

    function endRun(address _player, bool _won) external onlyAllowed {
        RunRecord storage run = runs[_player];
        if (run.currentNodeId != 0) {
            activeRunsAtNode[run.currentNodeId] -= 1;
        }
        run.status = _won ? RunStatus.Won : RunStatus.Ended;
        emit RunEnded(_player, _won);
    }

    function getRun(address _player) external view returns (Run memory r) {
        RunRecord storage run = runs[_player];
        r.status = run.status;
        r.generation = run.generation;
        r.campaignId = run.campaignId;
        r.currentNodeId = run.currentNodeId;
        r.currentCostCap = run.currentCostCap;
        r.reservationFleetId = run.reservationFleetId;
        r.activeGameId = run.activeGameId;
        r.requiredVariantAtStart = run.requiredVariantAtStart;
        uint64[] storage roster = run.roster;
        r.rosterShipIds = new uint[](roster.length);
        for (uint i = 0; i < roster.length; i++) {
            r.rosterShipIds[i] = roster[i] >> 8;
        }
    }

    function _entry(uint _shipId, uint8 _hullPoints) private pure returns (uint64) {
        if (_shipId >= 1 << 56) revert ShipIdTooLarge();
        return uint64(_shipId << 8) | _hullPoints;
    }

    function hasActiveRun(address _player) external view returns (bool) {
        return runs[_player].status == RunStatus.Active;
    }
}

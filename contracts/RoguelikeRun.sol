// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/access/Ownable.sol";

enum RunStatus {
    None,
    Active,
    Won,
    Ended
}

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
    mapping(address => Run) private runs;

    // player => generation => shipId => persisted hull points (0 = not yet
    // damaged this run / unset — a real roster ship's stored HP is never 0,
    // since a ship that reaches 0 HP is destroyed and dropped from the
    // roster entirely, never left in it at 0).
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
    // a twoWay edge back to it (see docs/pre-audit.md SP-05).
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

    error NotAllowedToModifyRuns();
    error RunAlreadyActive();

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
        Run storage run = runs[_player];
        if (run.status == RunStatus.Active) revert RunAlreadyActive();

        run.status = RunStatus.Active;
        run.generation += 1;
        run.campaignId = _campaignId;
        run.currentNodeId = _rootNodeId;
        run.currentCostCap = _initialCostCap;
        run.reservationFleetId = _reservationFleetId;
        run.rosterShipIds = _initialRoster;
        run.requiredVariantAtStart = _requiredVariant;
        activeRunsAtNode[_rootNodeId] += 1;

        emit RunStarted(_player, _campaignId);
    }

    function setCurrentNode(address _player, uint _nodeId) external onlyAllowed {
        Run storage run = runs[_player];
        if (run.currentNodeId != 0) {
            activeRunsAtNode[run.currentNodeId] -= 1;
        }
        activeRunsAtNode[_nodeId] += 1;
        run.currentNodeId = _nodeId;
    }

    function lockNode(address _player, uint _nodeId) external onlyAllowed {
        Run storage run = runs[_player];
        lockedByGen[_player][run.generation][_nodeId] = true;
    }

    function isNodeLocked(
        address _player,
        uint _nodeId
    ) external view returns (bool) {
        Run storage run = runs[_player];
        return lockedByGen[_player][run.generation][_nodeId];
    }

    function setNodeDefeated(address _player, uint _nodeId) external onlyAllowed {
        Run storage run = runs[_player];
        defeatedByGen[_player][run.generation][_nodeId] = true;
    }

    function isNodeDefeated(
        address _player,
        uint _nodeId
    ) external view returns (bool) {
        Run storage run = runs[_player];
        return defeatedByGen[_player][run.generation][_nodeId];
    }

    function setCostCap(address _player, uint _costCap) external onlyAllowed {
        runs[_player].currentCostCap = _costCap;
    }

    function setRoster(
        address _player,
        uint[] calldata _shipIds
    ) external onlyAllowed {
        runs[_player].rosterShipIds = _shipIds;
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
        Run storage run = runs[_player];
        shipHPByGen[_player][run.generation][_shipId] = _hullPoints;
    }

    // 0 means "not yet damaged this run" — RoguelikeMatch treats that as
    // "use the fresh 100% ShipAttributes just calculated," never as "enter
    // combat at 0 HP."
    function getShipHP(
        address _player,
        uint _shipId
    ) external view returns (uint8) {
        Run storage run = runs[_player];
        return shipHPByGen[_player][run.generation][_shipId];
    }

    function endRun(address _player, bool _won) external onlyAllowed {
        Run storage run = runs[_player];
        if (run.currentNodeId != 0) {
            activeRunsAtNode[run.currentNodeId] -= 1;
        }
        run.status = _won ? RunStatus.Won : RunStatus.Ended;
        emit RunEnded(_player, _won);
    }

    function getRun(address _player) external view returns (Run memory) {
        return runs[_player];
    }

    function hasActiveRun(address _player) external view returns (bool) {
        return runs[_player].status == RunStatus.Active;
    }
}

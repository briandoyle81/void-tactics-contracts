// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/access/Ownable.sol";
import "./IMaps.sol";
import "./Types.sol";
import "./IRoguelikeRunView.sol";

// Non-combat nodes have no map/AI encounter — the player repairs, adjusts
// roster composition, and/or gets a new fleet-cost cap instead of fighting.
enum RoguelikeNodeKind {
    Combat,
    Resupply
}

struct RoguelikeNode {
    uint id;
    uint campaignId;
    RoguelikeNodeKind kind;
    // Combat-only (ignored for Resupply nodes):
    uint mapId;
    uint turnTime;
    uint maxScore;
    bool creatorGoesFirst;
    // Resupply-only (ignored for Combat nodes):
    uint costCapOverride; // 0 = no change to the run's current cost cap
    // Edges are forward-only: a run can never walk back to a parent.
    uint[] children;
    bool exists;
}

// Admin-curated mission graph for the roguelike campaign mode — sits
// alongside NodeMap.sol (the existing, replayable, ANY-of-prerequisite
// campaign), not a replacement for it. Deliberately parent-lists-children
// (the reverse of NodeMap's child-lists-prerequisites) because the
// roguelike's branch-lockout rule needs "what are this node's other
// children" at the moment a player commits to one of them — a cheap,
// direct lookup here, which would otherwise require scanning every node in
// the campaign under NodeMap's model.
contract RoguelikeNodeMap is Ownable {
    IMaps public maps;
    // UA-05 fix (2026-09-29): optional (unset falls back to the old,
    // unguarded behavior — same "unwired = permissive" convention this
    // codebase already uses elsewhere, e.g. Fleets' maps address). When
    // set, removeChild refuses to remove a node's LAST remaining child
    // while any run is actually standing there right now, so an ordinary
    // content edit can't silently strand an in-progress run with zero
    // forward moves. See docs/upgrade-safety-audit-2026-09-29.md UA-05.
    IRoguelikeRunView public runLedger;

    mapping(uint => bool) public campaignExists;
    uint public campaignCount;
    // No prerequisites==0 analog exists under a children-model to
    // auto-detect a campaign's entry point, so it's set explicitly.
    mapping(uint => uint) public campaignRootNode;
    // 0-100, applied as a floor (never heals a ship down) to every combat
    // node's survivors on a win. Read by RoguelikeMatch.onGameEnded.
    mapping(uint => uint8) public campaignAutoHealPercent;
    // 0 = unrestricted. Same pattern as NodeMap.campaignRequiredVariant.
    mapping(uint => uint16) public campaignRequiredVariant;
    // The fleet-cost cap a run starts with — admin-curated, not
    // player-chosen (same reasoning as combat nodes' own costLimit).
    // Resupply nodes can raise/lower it from here via costCapOverride.
    mapping(uint => uint) public campaignInitialCostCap;

    mapping(uint => RoguelikeNode) private nodes;
    uint public nodeCount;

    // nodeId => ordered list of pluggable win-effect resolvers
    // (IRoguelikeWinEffect) to run after a combat win at that node, in
    // addition to the fixed campaignAutoHealPercent floor step (which
    // stays hardcoded in RoguelikeMatch, since every node needs it).
    // Additive/optional — a node with nothing configured runs no extra
    // effects. Read by RoguelikeMatch.onGameEnded.
    mapping(uint => address[]) private nodeWinEffects;

    mapping(address => bool) public isNodeEditor;

    error NotNodeEditor();
    error MapNotFound();
    error InvalidMapMode();
    error CampaignNotFound();
    error NodeNotFound();
    error ChildNotFound();
    error SelfChild();
    error ChildAlreadyExists();
    error ChildNotInNode();
    error InvalidHealPercent();
    error WouldStrandActiveRun();

    event NodeEditorSet(address indexed editor, bool allowed);
    event CampaignCreated(uint indexed campaignId);
    event NodeCreated(
        uint indexed nodeId,
        uint indexed campaignId,
        RoguelikeNodeKind kind
    );
    event NodeUpdated(uint indexed nodeId);
    event ChildAdded(uint indexed parentId, uint indexed childId);
    event ChildRemoved(uint indexed parentId, uint indexed childId);
    event NodeWinEffectsSet(uint indexed nodeId, uint effectCount);

    constructor(address _maps) Ownable(msg.sender) {
        maps = IMaps(_maps);
    }

    modifier onlyNodeEditor() {
        if (msg.sender != owner() && !isNodeEditor[msg.sender])
            revert NotNodeEditor();
        _;
    }

    function setMapsAddress(address _maps) external onlyOwner {
        maps = IMaps(_maps);
    }

    function setRunLedgerAddress(address _runLedger) external onlyOwner {
        runLedger = IRoguelikeRunView(_runLedger);
    }

    function setNodeEditor(address _editor, bool _allowed) external onlyOwner {
        isNodeEditor[_editor] = _allowed;
        emit NodeEditorSet(_editor, _allowed);
    }

    function createCampaign()
        external
        onlyNodeEditor
        returns (uint campaignId)
    {
        campaignCount++;
        campaignId = campaignCount;
        campaignExists[campaignId] = true;
        emit CampaignCreated(campaignId);
    }

    function setCampaignRoot(
        uint _campaignId,
        uint _nodeId
    ) external onlyNodeEditor {
        if (!campaignExists[_campaignId]) revert CampaignNotFound();
        if (!nodes[_nodeId].exists) revert NodeNotFound();
        campaignRootNode[_campaignId] = _nodeId;
    }

    function setCampaignAutoHealPercent(
        uint _campaignId,
        uint8 _percent
    ) external onlyNodeEditor {
        if (!campaignExists[_campaignId]) revert CampaignNotFound();
        if (_percent > 100) revert InvalidHealPercent();
        campaignAutoHealPercent[_campaignId] = _percent;
    }

    /**
     * @dev Full-replace the list of win-effect resolvers (IRoguelikeWinEffect)
     * for a node, run in order by RoguelikeMatch.onGameEnded after every
     * combat win there — a bonus/reward/etc. beyond the fixed
     * campaignAutoHealPercent floor. Pass an empty array to clear. No
     * validation of the addresses themselves (e.g. that they implement the
     * interface) — same trust level as the existing resolver-address
     * setters elsewhere in this codebase (Game.setFactionAbilityResolver).
     */
    function setNodeWinEffects(
        uint _nodeId,
        address[] calldata _effects
    ) external onlyNodeEditor {
        if (!nodes[_nodeId].exists) revert NodeNotFound();
        nodeWinEffects[_nodeId] = _effects;
        emit NodeWinEffectsSet(_nodeId, _effects.length);
    }

    function setCampaignRequiredVariant(
        uint _campaignId,
        uint16 _variant
    ) external onlyNodeEditor {
        if (!campaignExists[_campaignId]) revert CampaignNotFound();
        campaignRequiredVariant[_campaignId] = _variant;
    }

    function setCampaignInitialCostCap(
        uint _campaignId,
        uint _costCap
    ) external onlyNodeEditor {
        if (!campaignExists[_campaignId]) revert CampaignNotFound();
        campaignInitialCostCap[_campaignId] = _costCap;
    }

    /// @dev A combat node needs a map that exists and is valid for PvE
    /// (PvE or Both) — mirrors NodeMap._requireMapUsableForCampaign exactly.
    function _requireMapUsableForCampaign(uint _mapId) internal view {
        if (!maps.mapExists(_mapId)) revert MapNotFound();
        MapMode mode = maps.mapMode(_mapId);
        if (mode != MapMode.PvE && mode != MapMode.Both)
            revert InvalidMapMode();
    }

    // _mapId/_turnTime/_maxScore/_creatorGoesFirst are Combat-only (pass
    // 0/false for a Resupply node); _costCapOverride is Resupply-only (pass
    // 0 for a Combat node, meaning "no override"). Enemy threat is not
    // tracked on-chain — the frontend derives it by summing
    // ShipAttributes.calculateShipCost over AIEncounters.getMapPlacements
    // for the node's mapId, so it's always exact and never goes stale if
    // the encounter's placements are edited after this node is created.
    function createNode(
        uint _campaignId,
        RoguelikeNodeKind _kind,
        uint _mapId,
        uint _turnTime,
        uint _maxScore,
        bool _creatorGoesFirst,
        uint _costCapOverride
    ) external onlyNodeEditor returns (uint nodeId) {
        if (!campaignExists[_campaignId]) revert CampaignNotFound();
        if (_kind == RoguelikeNodeKind.Combat) {
            _requireMapUsableForCampaign(_mapId);
        }

        nodeCount++;
        nodeId = nodeCount;

        RoguelikeNode storage node = nodes[nodeId];
        node.id = nodeId;
        node.campaignId = _campaignId;
        node.kind = _kind;
        node.mapId = _mapId;
        node.turnTime = _turnTime;
        node.maxScore = _maxScore;
        node.creatorGoesFirst = _creatorGoesFirst;
        node.costCapOverride = _costCapOverride;
        node.exists = true;

        emit NodeCreated(nodeId, _campaignId, _kind);
    }

    function updateNode(
        uint _nodeId,
        uint _campaignId,
        RoguelikeNodeKind _kind,
        uint _mapId,
        uint _turnTime,
        uint _maxScore,
        bool _creatorGoesFirst,
        uint _costCapOverride
    ) external onlyNodeEditor {
        RoguelikeNode storage node = nodes[_nodeId];
        if (!node.exists) revert NodeNotFound();
        if (!campaignExists[_campaignId]) revert CampaignNotFound();
        if (_kind == RoguelikeNodeKind.Combat) {
            _requireMapUsableForCampaign(_mapId);
        }

        node.campaignId = _campaignId;
        node.kind = _kind;
        node.mapId = _mapId;
        node.turnTime = _turnTime;
        node.maxScore = _maxScore;
        node.creatorGoesFirst = _creatorGoesFirst;
        node.costCapOverride = _costCapOverride;

        emit NodeUpdated(_nodeId);
    }

    function addChild(
        uint _parentId,
        uint _childId
    ) external onlyNodeEditor {
        RoguelikeNode storage parent = nodes[_parentId];
        if (!parent.exists) revert NodeNotFound();
        if (!nodes[_childId].exists) revert ChildNotFound();
        if (_childId == _parentId) revert SelfChild();
        for (uint i = 0; i < parent.children.length; i++) {
            if (parent.children[i] == _childId)
                revert ChildAlreadyExists();
        }
        parent.children.push(_childId);
        emit ChildAdded(_parentId, _childId);
    }

    // Swap-and-pop — order doesn't matter for graph traversal, same pattern
    // NodeMap.removePrerequisite/_removeFromCampaignNodeIds already use.
    function removeChild(uint _parentId, uint _childId) external onlyNodeEditor {
        RoguelikeNode storage parent = nodes[_parentId];
        if (!parent.exists) revert NodeNotFound();
        uint length = parent.children.length;
        for (uint i = 0; i < length; i++) {
            if (parent.children[i] == _childId) {
                // UA-05 fix: removing a node's LAST remaining child is the
                // one edit that can leave an in-progress run with zero
                // forward moves — removing any other child is always safe
                // (the run still has at least one other way forward), so
                // only this specific case needs the occupancy check.
                if (
                    length == 1 &&
                    address(runLedger) != address(0) &&
                    runLedger.activeRunsAtNode(_parentId) > 0
                ) revert WouldStrandActiveRun();
                parent.children[i] = parent.children[length - 1];
                parent.children.pop();
                emit ChildRemoved(_parentId, _childId);
                return;
            }
        }
        revert ChildNotInNode();
    }

    function getNode(
        uint _nodeId
    ) external view returns (RoguelikeNode memory) {
        if (!nodes[_nodeId].exists) revert NodeNotFound();
        return nodes[_nodeId];
    }

    function getChildren(
        uint _nodeId
    ) external view returns (uint[] memory) {
        if (!nodes[_nodeId].exists) revert NodeNotFound();
        return nodes[_nodeId].children;
    }

    function getNodeWinEffects(
        uint _nodeId
    ) external view returns (address[] memory) {
        return nodeWinEffects[_nodeId];
    }
}

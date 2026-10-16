// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "./Types.sol";
import "./Ships.sol";
import "./RoguelikeRun.sol";
import "./RoguelikeNodeMap.sol";

// Read-only aggregation views for the frontend (2026-10-08), so a screen
// that used to need several dependent RPC round trips (ids -> structs,
// nodeCount -> getNode xN, run -> per-ship HP -> per-node flags) gets its
// data in one eth_call. Deliberately a separate, stateless contract rather
// than new functions on Ships/RoguelikeRun/RoguelikeNodeMap: Ships has no
// bytecode headroom left, and keeping every aggregate here means a new
// view the frontend needs later is a redeploy of this contract alone,
// never of anything holding game state. See
// docs/frontend-handoff-rpc-cost-suggestions-2026-10-08.md.
contract GameLens {
    Ships public immutable ships;
    RoguelikeRun public immutable roguelikeRun;
    RoguelikeNodeMap public immutable roguelikeNodeMap;

    struct RunView {
        Run run;
        // Parallel to run.rosterShipIds. 0 = not yet damaged this run (see
        // RoguelikeRun.getShipHP) — i.e. full HP, not destroyed.
        uint8[] rosterHP;
        // Every node reachable from the run's campaign root (same order as
        // getCampaignGraph), with this run's lock/defeat flag for each.
        uint[] nodeIds;
        bool[] nodeLocked;
        bool[] nodeDefeated;
    }

    constructor(
        Ships _ships,
        RoguelikeRun _roguelikeRun,
        RoguelikeNodeMap _roguelikeNodeMap
    ) {
        ships = _ships;
        roguelikeRun = _roguelikeRun;
        roguelikeNodeMap = _roguelikeNodeMap;
    }

    // Paginated, not a full-array return: the GR-01 reason
    // Ships.shipsOwnedCount/shipIdOwnedAt exist at all is that a large
    // holder's full list can blow past an RPC provider's eth_call
    // response/gas cap. Returns the slice [_offset, _offset + _limit)
    // clamped to the owner's count, plus that total so the caller knows
    // whether to fetch another page.
    function getShipsOwned(
        address _owner,
        uint _offset,
        uint _limit
    ) external view returns (Ship[] memory page, uint total) {
        total = ships.shipsOwnedCount(_owner);
        if (_offset >= total) return (new Ship[](0), total);
        // Compared as total - _offset (can't underflow here) rather than
        // computing _offset + _limit, which would overflow-revert on a
        // huge "give me everything" _limit.
        uint end = _limit > total - _offset ? total : _offset + _limit;

        uint[] memory ids = new uint[](end - _offset);
        for (uint i = _offset; i < end; i++) {
            ids[i - _offset] = ships.shipIdOwnedAt(_owner, i);
        }
        page = ships.getShipsByIds(ids);
    }

    // Every node reachable from the campaign's root, breadth-first, root
    // first. Walks children from campaignRootNode rather than scanning
    // 1..nodeCount: node ids are global across all campaigns, so a scan
    // would cost more with every campaign ever created. Each node's
    // child ids come back inside its struct, so this is
    // the whole graph. A node reachable by more than one path appears once;
    // a child edge into a cycle is fine (already-visited nodes are skipped).
    // Returns an empty array for an unknown campaign or one with no root.
    function getCampaignGraph(
        uint _campaignId
    ) public view returns (RoguelikeNode[] memory graph) {
        uint root = roguelikeNodeMap.campaignRootNode(_campaignId);
        if (root == 0) return graph;

        // nodeCount bounds how many distinct nodes can be visited.
        RoguelikeNode[] memory queue = new RoguelikeNode[](
            roguelikeNodeMap.nodeCount()
        );
        uint[] memory visited = new uint[](queue.length);
        queue[0] = roguelikeNodeMap.getNode(root);
        visited[0] = root;
        uint tail = 1;

        for (uint head = 0; head < tail; head++) {
            uint[] memory children = queue[head].children;
            for (uint c = 0; c < children.length; c++) {
                uint childId = children[c];
                bool seen = false;
                for (uint v = 0; v < tail; v++) {
                    if (visited[v] == childId) {
                        seen = true;
                        break;
                    }
                }
                if (seen) continue;
                queue[tail] = roguelikeNodeMap.getNode(childId);
                visited[tail] = childId;
                tail++;
            }
        }

        graph = new RoguelikeNode[](tail);
        for (uint i = 0; i < tail; i++) graph[i] = queue[i];
    }

    // The player's run, each roster ship's persisted HP, and this run's
    // locked/defeated flag for every node in its campaign graph. A player
    // with no run ever started gets a zeroed Run and empty arrays.
    function getRunView(
        address _player
    ) external view returns (RunView memory v) {
        v.run = roguelikeRun.getRun(_player);

        uint[] memory roster = v.run.rosterShipIds;
        v.rosterHP = new uint8[](roster.length);
        for (uint i = 0; i < roster.length; i++) {
            v.rosterHP[i] = roguelikeRun.getShipHP(_player, roster[i]);
        }

        if (v.run.status == RunStatus.None) return v;

        RoguelikeNode[] memory graph = getCampaignGraph(v.run.campaignId);
        v.nodeIds = new uint[](graph.length);
        v.nodeLocked = new bool[](graph.length);
        v.nodeDefeated = new bool[](graph.length);
        for (uint i = 0; i < graph.length; i++) {
            uint id = graph[i].id;
            v.nodeIds[i] = id;
            v.nodeLocked[i] = roguelikeRun.isNodeLocked(_player, id);
            v.nodeDefeated[i] = roguelikeRun.isNodeDefeated(_player, id);
        }
    }
}

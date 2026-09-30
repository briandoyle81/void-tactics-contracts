// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

// Minimal read-only view RoguelikeNodeMap needs into RoguelikeRun, so it can
// refuse to strand an in-progress run (UA-05 fix, 2026-09-29) without
// importing/depending on the whole RoguelikeRun contract.
interface IRoguelikeRunView {
    function activeRunsAtNode(uint _nodeId) external view returns (uint);
}

// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/access/Ownable.sol";
import "./IWinEffect.sol";
import "./INodeMapView.sol";

interface IRoguelikeNodeChildren {
    function getChildren(uint _nodeId) external view returns (uint[] memory);
}

// Pluggable win effect (see IWinEffect.sol) that records which players have
// won a roguelike run: a combat win at one of the campaign's last nodes
// (a node with no children). It also implements INodeMapView, so
// ShatteredHiveMedal can point its `nodeMap` at this contract and award the
// medal for finishing the roguelike instead of the single-player campaign
// (2026-11-21: that campaign is a stub; the medal is earned by winning
// either Hive ending). Repointing the live medal is two owner calls
// (setNodeMapAddress, setFinalNodeId) — no medal redeploy, so existing
// holders keep their tokens.
//
// Which endings count is decided by which nodes this effect is attached to
// (RoguelikeNodeMap.setNodeWinEffects); the deploy module attaches it to
// every reachable node with no children. onWin also re-checks that the
// node it fires for has no children, so attaching it to a mid-run node by
// mistake records nothing.
//
// onWin is gated behind its own isAllowedToTrigger allowlist — see
// DECBonusWinEffect.sol's matching comment on why. Without it, any address
// could mark itself as having finished the campaign and claim the medal.
contract RoguelikeCompletionWinEffect is Ownable, IWinEffect, INodeMapView {
    IRoguelikeNodeChildren public nodeMap;

    mapping(address => bool) public isAllowedToTrigger;
    mapping(address => bool) public hasCompleted;

    error NotAllowedToTrigger();

    event TriggerAllowedSet(address indexed caller, bool allowed);
    event RoguelikeCompleted(address indexed player, uint indexed nodeId);

    constructor(address _nodeMap) Ownable(msg.sender) {
        nodeMap = IRoguelikeNodeChildren(_nodeMap);
    }

    modifier onlyAllowed() {
        if (!isAllowedToTrigger[msg.sender]) revert NotAllowedToTrigger();
        _;
    }

    function setIsAllowedToTrigger(
        address _caller,
        bool _allowed
    ) external onlyOwner {
        isAllowedToTrigger[_caller] = _allowed;
        emit TriggerAllowedSet(_caller, _allowed);
    }

    function setNodeMapAddress(address _nodeMap) external onlyOwner {
        nodeMap = IRoguelikeNodeChildren(_nodeMap);
    }

    function onWin(address _player, uint _nodeId) external override onlyAllowed {
        if (hasCompleted[_player]) return;
        if (nodeMap.getChildren(_nodeId).length != 0) return;
        hasCompleted[_player] = true;
        emit RoguelikeCompleted(_player, _nodeId);
    }

    // INodeMapView, for ShatteredHiveMedal.claimMedal. The node id is
    // ignored: the medal asks about its single finalNodeId, but here any
    // ending counts.
    function isNodeCompleted(
        address _player,
        uint
    ) external view override returns (bool) {
        return hasCompleted[_player];
    }
}

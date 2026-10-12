// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/access/Ownable.sol";
import "./IWinEffect.sol";
import "./IShipAttributes.sol";
import "./RoguelikeRun.sol";
import "./Types.sol";

// Pluggable win effect (see IWinEffect.sol): raises every surviving roster
// ship's HP up to healToPercent% of its max hull points, same "never heal
// a ship down" floor semantics as RoguelikeNodeMap.campaignAutoHealPercent
// (which RoguelikeMatch always applies first, unconditionally, before this
// or any other win effect runs) — this just lets a specific node push that
// floor higher than the campaign-wide default, e.g. a reward node that
// fully heals on top of a campaign's ordinary partial auto-heal. Needs
// RoguelikeRun.setIsAllowedToModifyRuns(address(this), true) — deploy-time
// wiring, not this contract's concern. Roguelike-specific in practice
// (reads RoguelikeRun's roster) even though the interface is generic — if
// triggered from PvP/Tournament, where the player has no active roguelike
// run, getRun returns an empty roster and the loop below is simply a
// harmless no-op, not a revert; it's just not a meaningful effect to
// configure outside roguelike.
//
// onWin is gated behind its own isAllowedToTrigger allowlist — see
// DECBonusWinEffect.sol's matching comment on why.
contract HealAboveFloorWinEffect is Ownable, IWinEffect {
    RoguelikeRun public runLedger;
    IShipAttributes public shipAttributes;
    uint8 public healToPercent;

    mapping(address => bool) public isAllowedToTrigger;

    error NotAllowedToTrigger();
    error InvalidHealPercent();

    event HealToPercentSet(uint8 percent);
    event TriggerAllowedSet(address indexed caller, bool allowed);

    constructor(
        address _runLedger,
        address _shipAttributes,
        uint8 _healToPercent
    ) Ownable(msg.sender) {
        runLedger = RoguelikeRun(_runLedger);
        shipAttributes = IShipAttributes(_shipAttributes);
        if (_healToPercent > 100) revert InvalidHealPercent();
        healToPercent = _healToPercent;
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

    function setRunLedgerAddress(address _runLedger) external onlyOwner {
        runLedger = RoguelikeRun(_runLedger);
    }

    function setShipAttributesAddress(
        address _shipAttributes
    ) external onlyOwner {
        shipAttributes = IShipAttributes(_shipAttributes);
    }

    function setHealToPercent(uint8 _percent) external onlyOwner {
        if (_percent > 100) revert InvalidHealPercent();
        healToPercent = _percent;
        emit HealToPercentSet(_percent);
    }

    function onWin(address _player, uint) external override onlyAllowed {
        // Reads the roster AFTER RoguelikeMatch.onGameEnded has already
        // called runLedger.setRoster with survivors plus rejoining fled
        // ships (destroyed ones dropped), and AFTER its
        // own floor-heal step has already written a real (non-zero)
        // stored HP for each of them — see RoguelikeMatch.sol's dispatch
        // site comment.
        Run memory run = runLedger.getRun(_player);
        for (uint i = 0; i < run.rosterShipIds.length; i++) {
            uint shipId = run.rosterShipIds[i];
            uint8 stored = runLedger.getShipHP(_player, shipId);
            Attributes memory attrs = shipAttributes
                .calculateShipAttributesById(shipId);
            // 0 means "not yet damaged this run" (see RoguelikeRun.
            // getShipHP's doc-comment) — treated as full, same convention
            // used everywhere else this value is read.
            uint8 current = stored == 0 ? attrs.maxHullPoints : stored;
            uint16 target = (uint16(attrs.maxHullPoints) * healToPercent) /
                100;
            if (target > current) {
                runLedger.setShipHP(_player, shipId, uint8(target));
            }
        }
    }
}

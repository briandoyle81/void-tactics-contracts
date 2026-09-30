// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/access/Ownable.sol";
import "./ILobbiesOrchestratorCheck.sol";

// ShipsRouter.lobbyAddress (checked by DestroyRewardLib.payDestroyReward via
// ILobbiesOrchestratorCheck) used to point straight at SinglePlayerMatch,
// whose own isSinglePlayerOrchestrator is a hardcoded `== address(this)`
// check — correct when it was the only AI-owning orchestrator, but that
// meant a second one (RoguelikeMatch) would have its AI kills silently pay
// out the wrong currency (UTC instead of DEC) since it isn't recognized.
// This contract replaces that single-address check with an owner-settable
// registry, so ShipsRouter.setLobbyAddress can point here once, and any
// number of AI-owning single-player orchestrators can be added without
// ever touching Ships.sol/ShipsRouter.sol again (both already have almost
// no size headroom left).
contract SinglePlayerOrchestratorRegistry is Ownable, ILobbiesOrchestratorCheck {
    mapping(address => bool) public isRegisteredOrchestrator;

    event OrchestratorSet(address indexed orchestrator, bool allowed);

    error CannotDeregisterOrchestrator();

    constructor() Ownable(msg.sender) {}

    // UA-09 fix (2026-09-29): an orchestrator's classification here is a
    // permanent property of that CONTRACT ADDRESS (whether it's a
    // single-player-style, AI-ship-owning orchestrator or not), not
    // something scoped to one run/game — every kill ever processed against
    // any of that orchestrator's AI ships, across every run it has ever
    // had or will ever have, reads this live at the moment of the kill (see
    // DestroyRewardLib.payDestroyReward). Deregistering `true -> false`
    // would silently misroute every future kill against that orchestrator
    // to the wrong reward token, with no revert to signal it — so, unlike
    // adding a new orchestrator (unrestricted, additive), that direction is
    // disallowed entirely. See docs/upgrade-safety-audit-2026-09-29.md
    // UA-09.
    function setOrchestrator(
        address _orchestrator,
        bool _allowed
    ) external onlyOwner {
        if (!_allowed && isRegisteredOrchestrator[_orchestrator]) {
            revert CannotDeregisterOrchestrator();
        }
        isRegisteredOrchestrator[_orchestrator] = _allowed;
        emit OrchestratorSet(_orchestrator, _allowed);
    }

    function isSinglePlayerOrchestrator(
        address _address
    ) external view returns (bool) {
        return isRegisteredOrchestrator[_address];
    }
}

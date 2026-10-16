// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "./IUniversalCredits.sol";
import "./IFactionRewardTokenRegistry.sol";
import "./ILobbiesOrchestratorCheck.sol";

// Shared by every AI faction's reward token (DroneEnergyCores today, any
// future faction token later) — they all already implement this same
// authorizedToMint-gated shape, so one minimal interface covers whichever
// token FactionRewardTokenRegistry hands back.
interface IMintableToken {
    function mint(address _to, uint _amount) external;
}

// Decides which token rewards a ship kill in — external (not internal) so
// its bytecode is deployed separately instead of inlined into Ships.sol,
// which has almost no size headroom left (same reasoning as
// SpecialEffectsLib being split out of Game.sol).
library DestroyRewardLib {
    // Emitted instead of minting whenever no reward is paid: the destroyed
    // ship's AI faction (variant) has no reward token registered yet, or a
    // reward lookup/mint failed. Gives off-chain visibility without ever
    // reverting the kill (the ship still gets marked destroyed either way).
    event RewardSkipped(uint16 variant, address destroyerOwner);

    // Never reverts (docs/audit-3.md HA6-22). This runs inside the lethal
    // shot's own transaction (Game -> ShipsRouter.setTimestampDestroyed), so
    // a revert here — minting switched off (setMintIsActive(false)), a
    // faction token that hasn't authorized the router, a misconfigured
    // address — would make every lethal shot in every live game revert,
    // freezing them. Every external call is try/catch'd, and non-contract
    // addresses are skipped first: a call to an address with no code fails
    // while decoding its empty return data, which try/catch can't catch.
    function payDestroyReward(
        address _lobbyAddress,
        address _destroyedShipOwner,
        address _destroyerOwner,
        uint _reward,
        uint16 _destroyedShipVariant,
        IUniversalCredits _universalCredits,
        IFactionRewardTokenRegistry _registry
    ) external {
        // Ownership decides UTC vs. an AI faction token; if AI-owned, the
        // destroyed ship's variant then decides *which* faction token (or
        // none yet, if that faction hasn't had one registered).
        bool aiOwned;
        if (_lobbyAddress.code.length == 0) {
            emit RewardSkipped(_destroyedShipVariant, _destroyerOwner);
            return;
        }
        try
            ILobbiesOrchestratorCheck(_lobbyAddress).isSinglePlayerOrchestrator(
                _destroyedShipOwner
            )
        returns (bool isOrchestrator) {
            aiOwned = isOrchestrator;
        } catch {
            emit RewardSkipped(_destroyedShipVariant, _destroyerOwner);
            return;
        }

        if (aiOwned) {
            address token;
            if (address(_registry).code.length != 0) {
                try _registry.rewardToken(_destroyedShipVariant) returns (
                    address t
                ) {
                    token = t;
                } catch {}
            }
            if (token.code.length == 0) {
                emit RewardSkipped(_destroyedShipVariant, _destroyerOwner);
                return;
            }
            try IMintableToken(token).mint(_destroyerOwner, _reward) {} catch {
                emit RewardSkipped(_destroyedShipVariant, _destroyerOwner);
            }
        } else {
            if (address(_universalCredits).code.length == 0) {
                emit RewardSkipped(_destroyedShipVariant, _destroyerOwner);
                return;
            }
            try _universalCredits.mint(_destroyerOwner, _reward) {} catch {
                emit RewardSkipped(_destroyedShipVariant, _destroyerOwner);
            }
        }
    }
}

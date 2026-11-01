// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "../IEffectResolver.sol";

// Test-only resolver: returns whatever effects were last set, unchanged,
// to drive SpecialEffectsLib and Game's effect dispatch directly
// (removals of several ships at once, damage from a chosen ship).
contract MockEffectsResolver is IEffectResolver {
    SpecialEffect[] private _effects;

    function setEffects(SpecialEffect[] calldata _newEffects) external {
        delete _effects;
        for (uint i = 0; i < _newEffects.length; i++) {
            _effects.push(_newEffects[i]);
        }
    }

    function resolveEffect(
        uint,
        uint,
        uint16,
        uint,
        int16,
        int16
    ) external view returns (SpecialEffect[] memory) {
        return _effects;
    }
}

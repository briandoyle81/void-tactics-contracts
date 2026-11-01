// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "../IEffectResolver.sol";

// Test-only resolver: relocates the acting ship to whatever cell was last
// set, with no bounds checks of its own, to exercise
// SpecialEffectsLib.applyRelocations' own checks.
contract MockRelocateResolver is IEffectResolver {
    int16 public row;
    int16 public col;

    function setTarget(int16 _row, int16 _col) external {
        row = _row;
        col = _col;
    }

    function resolveEffect(
        uint,
        uint shipId,
        uint16,
        uint,
        int16,
        int16
    ) external view returns (SpecialEffect[] memory effects) {
        effects = new SpecialEffect[](1);
        effects[0] = SpecialEffect({
            shipId: shipId,
            hullDelta: 0,
            reactorTimerDelta: 0,
            newRow: row,
            newCol: col,
            removalKind: 0
        });
    }
}

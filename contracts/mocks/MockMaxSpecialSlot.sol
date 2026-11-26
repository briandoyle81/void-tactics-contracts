// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

// Minimal IGameView.maxSpecialSlot stand-in so GenerateNewShip can be
// exercised standalone (used by scripts/near-golden/exportGolden.ts to export
// differential fixtures for the NEAR port).
contract MockMaxSpecialSlot {
    mapping(uint16 => uint8) public maxSpecialSlot;

    function setMaxSpecialSlot(uint16 _variant, uint8 _slot) external {
        maxSpecialSlot[_variant] = _slot;
    }
}

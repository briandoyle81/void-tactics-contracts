// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "./Types.sol";

interface IGenerateNewShip {
    function generateShip(
        uint id,
        uint serialNumber,
        uint64 randomBase,
        uint16 variant
    ) external view returns (Ship memory);

    function generateBaselineShip(
        uint id,
        uint serialNumber,
        uint16 variant
    ) external view returns (Ship memory);

    function getTierOfTrait(uint _trait) external pure returns (uint8);
}

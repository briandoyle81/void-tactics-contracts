// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

interface IRandomManager {
    function requestRandomness() external returns (uint);

    function revealRandomness(uint) external returns (uint64);

    function fulfillRandomRequest(uint) external returns (uint64);

    function isExpired(uint) external view returns (bool);
}

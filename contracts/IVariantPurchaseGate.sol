// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

// Minimal interface Ships.sol calls into — keeps Ships.sol ignorant of
// *which* variants are gated or *what* they're gated on (which NFT, or any
// future gating condition). All of that lives in VariantPurchaseGate.sol,
// which has real headroom, unlike Ships.sol.
interface IVariantPurchaseGate {
    // _minter: the contract/account that called into Ships to mint
    // (msg.sender of createShips/createSpecificShip/purchase*), so the gate
    // can exempt specific mint sources (e.g. the lottery hook).
    function checkGate(
        uint16 _variant,
        address _to,
        address _minter
    ) external view;
}

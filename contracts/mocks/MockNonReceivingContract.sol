// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

// A contract that always reverts on receiving an ERC-721, for testing
// HA4-02 (docs/audit-2.md): UTCLotteryHook.resolveDraw must not be
// permanently blockable by a picked winner that can't actually receive the
// prize NFT.
contract MockNonReceivingContract {
    error AlwaysRejects();

    function onERC721Received(
        address,
        address,
        uint256,
        bytes calldata
    ) external pure returns (bytes4) {
        revert AlwaysRejects();
    }
}

// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "../AIBehavior.sol";

// Test-only: exposes AIBehavior's decoding of Game.getAIBoard (2026-10-31)
// so tests can check it field by field against Game.getGame.
contract AIBoardHarness {
    function unpack(uint[] memory board) external pure returns (AIView memory) {
        return AIBehavior.unpackBoard(board);
    }

    function turnState(
        uint[] memory board
    )
        external
        view
        returns (bool, address, address, bool, uint, Position memory)
    {
        return AIBehavior.turnState(board, _noSupport);
    }

    function _noSupport(uint) internal pure returns (bool) {
        return false;
    }
}

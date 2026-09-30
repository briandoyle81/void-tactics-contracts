// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "./Types.sol";

// Minimal read-only view Maps.sol needs into whichever Game contract a
// gameId actually lives on, so it can refuse a debug tile edit against an
// already-ended game (UA-12 fix, 2026-09-29) without importing/depending on
// the whole Game contract. Matches Game.sol's real
// getGameMetadataAndTurnState signature exactly (same GameMetadata/
// GameTurnState structs every other Game-consuming interface already
// shares), so the ABI decode lines up correctly.
interface IGameEndedView {
    function getGameMetadataAndTurnState(
        uint _gameId
    ) external view returns (GameMetadata memory, GameTurnState memory);
}

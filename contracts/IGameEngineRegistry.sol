// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

// Minimal interface orchestrators (PvPMatch/SinglePlayerMatch/RoguelikeMatch)
// call into to record which Game engine a freshly-started game runs on —
// see GameEngineRegistry.sol for the full contract and rationale.
interface IGameEngineRegistry {
    function recordGameEngine(uint _gameId, address _engine) external;
    // Added for Maps.sol's UA-12 fix (2026-09-29) — lets a consumer look up
    // which Game contract a gameId actually lives on, e.g. to check whether
    // that specific game has ended before allowing a debug tile edit
    // against it.
    function engineOfGame(uint _gameId) external view returns (address);
}

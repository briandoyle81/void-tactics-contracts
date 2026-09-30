// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/access/Ownable.sol";

// Added 2026-09-28 as part of the in-flight gameplay-upgrade capability:
// this project deploys a full replacement "engine" (Game.sol + its
// orchestrators — PvPMatch/SinglePlayerMatch/RoguelikeMatch/
// RoguelikeResupply — and, only if the change needs it, a new AI registry
// or Maps instance) whenever a gameplay-rules change (like this session's
// disabled-ship-blocking fix) can't be shipped by upgrading a mutable
// setter, since Game.sol has no proxy and no spare bytecode headroom to
// safely retrofit one. Everything else (Ships, tokens, Fleets, Maps'
// preset data, the resolvers) stays untouched and shared across every
// engine — see the engine-registry plan for the full rationale.
//
// This registry doesn't gate anything on-chain: moveShip and every other
// per-turn call still goes straight to whichever Game contract the FE
// already knows to call, exactly as before — this is purely a small,
// trustless lookup so a game's engine can be resolved without relying on
// FE-local state (e.g. after clearing storage, or for a block explorer /
// second FE build), and so the FE knows where to send a brand-new game.
contract GameEngineRegistry is Ownable {
    struct EngineInfo {
        bool registered;
        string label;
        uint deployedAt;
        bool retired;
    }

    // Which engine's orchestrators (Lobbies/PvPMatch/SinglePlayerMatch/
    // RoguelikeMatch) a brand-new game should be created against. The FE
    // reads this before starting a game; it is NOT consulted on-chain by
    // any per-turn call.
    address public currentEngine;

    // gameId -> the Game contract that game actually runs on. Written once,
    // at game-creation time, by whichever orchestrator is authorized below
    // (see recordGameEngine). Left unset (address(0)) for a gameId this
    // registry was never told about — e.g. a game created before this
    // registry existed, or on an engine whose orchestrator wasn't wired to
    // call in (see RoguelikeMatch's own note on this, if it applies).
    mapping(uint => address) public engineOfGame;

    // Every engine ever registered, in registration order, plus per-engine
    // metadata for FE display (a version label, when it was added, and
    // whether it's retired — informational only, never enforced here).
    address[] public engines;
    mapping(address => EngineInfo) public engineInfo;

    // Orchestrators (one set per engine, e.g. that engine's own PvPMatch/
    // SinglePlayerMatch/RoguelikeMatch/RoguelikeResupply) authorized to call
    // recordGameEngine — mirrors NodeMap.isAllowedToCompleteNodes'/
    // RoguelikeRun.isAllowedToModifyRuns' shape.
    mapping(address => bool) public isAllowedToRecord;

    error NotAllowedToRecord();
    error EngineAlreadyRegistered();
    error EngineNotRegistered();
    error GameAlreadyRecorded();

    event EngineRegistered(address indexed engine, string label);
    event EngineRetired(address indexed engine, bool retired);
    event CurrentEngineSet(address indexed engine);
    event RecorderSet(address indexed recorder, bool allowed);
    event GameEngineRecorded(uint indexed gameId, address indexed engine);

    constructor() Ownable(msg.sender) {}

    /// @dev Registers a new engine (its Game contract's address) and, unless
    ///      told otherwise, makes it the one new games are created against.
    function registerEngine(
        address _game,
        string calldata _label,
        bool _makeCurrent
    ) external onlyOwner {
        if (engineInfo[_game].registered) revert EngineAlreadyRegistered();
        engineInfo[_game] = EngineInfo({
            registered: true,
            label: _label,
            deployedAt: block.timestamp,
            retired: false
        });
        engines.push(_game);
        emit EngineRegistered(_game, _label);
        if (_makeCurrent) {
            currentEngine = _game;
            emit CurrentEngineSet(_game);
        }
    }

    /// @dev Points new-game creation at a previously-registered engine —
    ///      e.g. to roll `currentEngine` back if a freshly-registered one
    ///      turns out to have a problem.
    function setCurrentEngine(address _game) external onlyOwner {
        if (!engineInfo[_game].registered) revert EngineNotRegistered();
        currentEngine = _game;
        emit CurrentEngineSet(_game);
    }

    /// @dev Marks an engine retired for FE display purposes only — never
    ///      enforced here (an old engine's own contracts are what actually
    ///      stop taking new games, if anything does).
    function setRetired(address _game, bool _retired) external onlyOwner {
        if (!engineInfo[_game].registered) revert EngineNotRegistered();
        engineInfo[_game].retired = _retired;
        emit EngineRetired(_game, _retired);
    }

    function setIsAllowedToRecord(
        address _recorder,
        bool _allowed
    ) external onlyOwner {
        isAllowedToRecord[_recorder] = _allowed;
        emit RecorderSet(_recorder, _allowed);
    }

    /// @dev Called once by an authorized orchestrator right after it starts
    ///      a new game, so engineOfGame can answer "which Game contract is
    ///      this gameId actually on" trustlessly. `_engine` is passed in
    ///      (rather than assumed to be msg.sender) because the caller is an
    ///      orchestrator (PvPMatch/SinglePlayerMatch/RoguelikeMatch), not
    ///      Game itself.
    function recordGameEngine(uint _gameId, address _engine) external {
        if (!isAllowedToRecord[msg.sender]) revert NotAllowedToRecord();
        if (engineOfGame[_gameId] != address(0)) revert GameAlreadyRecorded();
        engineOfGame[_gameId] = _engine;
        emit GameEngineRecorded(_gameId, _engine);
    }

    function engineCount() external view returns (uint) {
        return engines.length;
    }

    function getEngines() external view returns (address[] memory) {
        return engines;
    }
}

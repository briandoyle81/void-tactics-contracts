// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/access/Ownable.sol";
import "./Types.sol";
import "./Game.sol";
import "./IGameResults.sol";
import "./IGameOrchestrator.sol";
import "./IGameEngineRegistry.sol";

// PvP-specific orchestration split out of Game.sol: this is what Lobbies
// talks to for starting a match, and it owns human-forfeit mechanics
// (flee/timeout) and PvP leaderboard recording. Core combat/movement stays
// entirely in Game.sol, unmodified — this contract just drives it, exactly
// like a human wallet or any other authorized orchestrator would.
contract PvPMatch is Ownable, IGameOrchestrator {
    Game public game;
    IGameResults public gameResults;
    address public lobbiesAddress;
    // Optional (2026-09-28): records each new game's engine in a shared
    // registry for trustless FE lookup — see GameEngineRegistry.sol.
    // Skipped entirely if unset, so this contract works unchanged without
    // one wired in (e.g. in tests that don't need it).
    IGameEngineRegistry public engineRegistry;

    // No win effects in PvP (docs/audit-3.md HA6-27): two wallets one
    // person controls can play each other and farm any per-win reward, so
    // win effects (bonus DEC, granted ships, heals) are PvE-only.

    // UA-02 fix (2026-09-29): once this orchestrator has ever started a
    // game, `game`/`gameResults` can never be repointed again — see
    // setGameAddress/setGameResultsAddress below.
    uint public gamesStarted;

    error NotGame();
    error NotLobbiesContract();
    error TurnTimeoutNotReached();
    error NotInGame();
    error InvalidMove();
    error EngineAlreadyLive();

    // UA-03 fix (2026-09-29): recordGameResult can revert if
    // GameResults.isAllowedRecorder is ever revoked for this contract while
    // it still has in-flight games — without a try/catch, that revert
    // (like any revert here) fails the ENTIRE game-ending transaction
    // (Game._endGame calls onGameEnded with no try/catch of its own). This
    // event fires instead, so the game itself still ends cleanly (ships
    // released, winner recorded on Game.sol) even if the PvP leaderboard
    // write is the one thing that failed.
    event GameResultRecordFailed(
        uint indexed gameId,
        address indexed winner,
        address indexed loser
    );

    constructor(address _game, address _gameResults) Ownable(msg.sender) {
        game = Game(_game);
        gameResults = IGameResults(_gameResults);
    }

    function setLobbiesAddress(address _lobbiesAddress) external onlyOwner {
        lobbiesAddress = _lobbiesAddress;
    }

    // UA-02 fix (2026-09-29): `game.metadata.orchestrator` is snapshotted
    // per-game (Game.startGame, msg.sender at that moment) and used for
    // every later callback/authorization check on Game.sol's own side —
    // but this contract had no mirror-image snapshot of its own `game`
    // reference. Every call this PvPMatch has ever made (flee,
    // endGameOnTimeout, and critically Game._endGame's uncaught callback
    // into onGameEnded) reads `game`/`gameResults` fresh from storage, for
    // every game this orchestrator has ever started, not just future ones.
    // Repointing either while a game this orchestrator started is still
    // active permanently strands it: onGameEnded's `msg.sender !=
    // address(game)` check (or recordGameResult's allowlist check on a
    // gameResults instance that never authorized this contract) reverts,
    // and since Game._endGame calls the orchestrator with no try/catch,
    // that revert unwinds the entire game-ending transaction, forever.
    // Under this project's engine-registry architecture a genuine rules
    // change always gets a brand-new PvPMatch instance, never a
    // re-pointed live one — so these never need to move once this
    // orchestrator has started its first game. See
    // docs/upgrade-safety-audit-2026-09-29.md UA-02.
    function setGameAddress(address _game) external onlyOwner {
        if (gamesStarted > 0) revert EngineAlreadyLive();
        game = Game(_game);
    }

    function setGameResultsAddress(address _gameResults) external onlyOwner {
        if (gamesStarted > 0) revert EngineAlreadyLive();
        gameResults = IGameResults(_gameResults);
    }

    function setEngineRegistry(address _registry) external onlyOwner {
        engineRegistry = IGameEngineRegistry(_registry);
    }

    // Called by Lobbies once both sides' fleets are set; forwards straight
    // through to core Game.sol, which resolves the fleets and starts the
    // session. Same parameter shape Game.startGame always had.
    function startGame(
        uint _lobbyId,
        address _creator,
        address _joiner,
        uint _creatorFleetId,
        uint _joinerFleetId,
        bool _creatorGoesFirst,
        uint _turnTime,
        uint _selectedMapId,
        uint _maxScore
    ) external {
        if (msg.sender != lobbiesAddress) revert NotLobbiesContract();
        gamesStarted++;
        game.startGame(
            _lobbyId,
            _creator,
            _joiner,
            _creatorFleetId,
            _joinerFleetId,
            _creatorGoesFirst,
            _turnTime,
            _selectedMapId,
            _maxScore
        );
        // gameId == lobbyId (see Game.sol's own startGame comment).
        if (address(engineRegistry) != address(0)) {
            engineRegistry.recordGameEngine(_lobbyId, address(game));
        }
    }

    // Flee function - either player can end the game at any time
    function flee(uint _gameId) external {
        // Only metadata is touched here — getGameMetadataAndTurnState instead
        // of getGame() avoids paying for a full ship-data walk (G-04).
        (GameMetadata memory metadata, ) = game.getGameMetadataAndTurnState(
            _gameId
        );

        // Check if game has already ended (winner alone can't tell: a draw also
        // leaves winner == address(0), see GameMetadata.ended in Types.sol)
        if (metadata.ended) revert InvalidMove();

        // Must be either the creator or joiner
        if (msg.sender != metadata.creator && msg.sender != metadata.joiner)
            revert NotInGame();

        // Set the other player as the winner
        address winner = msg.sender == metadata.creator
            ? metadata.joiner
            : metadata.creator;
        game.forceEndSession(_gameId, winner, msg.sender);
    }

    // Force a loss when the current turn's player times out (only the other player can call this)
    function endGameOnTimeout(uint _gameId) external {
        // Only metadata/turnState are touched here (G-04, see flee above).
        (
            GameMetadata memory metadata,
            GameTurnState memory turnState
        ) = game.getGameMetadataAndTurnState(_gameId);

        if (block.timestamp <= turnState.turnStartTime + turnState.turnTime)
            revert TurnTimeoutNotReached();

        // Only the other player can force a timeout skip
        if (msg.sender == turnState.currentTurn) revert InvalidMove();

        // Must be either the creator or joiner
        if (msg.sender != metadata.creator && msg.sender != metadata.joiner)
            revert NotInGame();

        // End the game with the timed out player as the loser
        game.forceEndSession(_gameId, msg.sender, turnState.currentTurn);
    }

    // IGameOrchestrator: called by core Game.sol whenever a session this
    // contract started ends (win condition, forceEndSession, or a draw).
    function onGameEnded(
        uint _gameId,
        address _winner,
        address _loser
    ) external {
        if (msg.sender != address(game)) revert NotGame();
        // Only record non-draw results, matching Game._endGame's old guard
        if (_winner != address(0)) {
            // Each call is individually try/catch'd — onGameEnded is
            // invoked by Game.sol as a bare external call with no
            // try/catch of its own (see Game.sol's _endGame), so an
            // unguarded revert here would fail the entire game-ending
            // transaction. Same reasoning as RoguelikeMatch.onGameEnded's
            // matching dispatch loop.
            try gameResults.recordGameResult(_gameId, _winner, _loser) {} catch {
                emit GameResultRecordFailed(_gameId, _winner, _loser);
            }

        }
    }
}

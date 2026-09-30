// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/access/Ownable.sol";
import "./Types.sol";

contract GameResults is Ownable {
    // Mapping from player address to their stats
    mapping(address => PlayerStats) public playerStats;

    // Mapping from game ID to game result
    mapping(uint => GameResult) public gameResults;

    // Total number of games tracked
    uint public totalGamesTracked;

    // Contracts allowed to record game results — in practice each is a
    // PvPMatch instance (PvPMatch.onGameEnded calls recordGameResult, not
    // Game.sol directly — "gameContract" is a legacy name). Was a single
    // address until 2026-09-28; widened to an allowlist so a future
    // gameplay-rules "engine" upgrade's new PvPMatch can be authorized
    // without displacing the previous one, whose in-flight games still
    // need to be able to record their results. See the engine-registry
    // plan.
    mapping(address => bool) public isAllowedRecorder;

    // Tutorial claim contract: may record tutorial win/loss into player stats only
    address public tutorialClaimContract;

    // Events
    event GameResultRecorded(
        uint indexed gameId,
        address indexed winner,
        address indexed loser,
        uint timestamp
    );

    event PlayerStatsUpdated(
        address indexed player,
        uint wins,
        uint losses,
        uint totalGames
    );

    event RecorderSet(address indexed recorder, bool allowed);

    event TutorialClaimContractSet(address indexed tutorialClaimContract);

    // Errors
    error GameAlreadyRecorded();
    error InvalidGameResult();
    error GameNotFound();
    error NotGameContract();
    error NotTutorialClaimContract();

    constructor() Ownable(msg.sender) {}

    /**
     * @dev Authorize (or revoke) a contract (in practice, a PvPMatch
     *      instance) to record game results.
     * @param _recorder The contract's address
     * @param _allowed Whether it's authorized
     */
    function setIsAllowedRecorder(
        address _recorder,
        bool _allowed
    ) external onlyOwner {
        isAllowedRecorder[_recorder] = _allowed;
        emit RecorderSet(_recorder, _allowed);
    }

    /**
     * @dev Set the TutorialClaim contract (only it may call addWin / addLoss)
     */
    function setTutorialClaimContract(
        address _tutorialClaimContract
    ) external onlyOwner {
        tutorialClaimContract = _tutorialClaimContract;
        emit TutorialClaimContractSet(_tutorialClaimContract);
    }

    /**
     * @dev Record a tutorial completion as a win for player stats (no game row / game id)
     */
    function addWin(address _player) external {
        if (msg.sender != tutorialClaimContract) revert NotTutorialClaimContract();
        if (_player == address(0)) revert InvalidGameResult();
        _updatePlayerStats(_player, true);
    }

    /**
     * @dev Record a tutorial completion as a loss for player stats (no game row / game id)
     */
    function addLoss(address _player) external {
        if (msg.sender != tutorialClaimContract) revert NotTutorialClaimContract();
        if (_player == address(0)) revert InvalidGameResult();
        _updatePlayerStats(_player, false);
    }

    /**
     * @dev Record the result of a completed game
     * @param _gameId The ID of the game
     * @param _winner The address of the winning player
     * @param _loser The address of the losing player
     */
    function recordGameResult(
        uint _gameId,
        address _winner,
        address _loser
    ) external {
        if (!isAllowedRecorder[msg.sender]) revert NotGameContract();
        // Validate inputs
        if (_winner == address(0) || _loser == address(0))
            revert InvalidGameResult();
        if (_winner == _loser) revert InvalidGameResult();

        // Check if game result already recorded
        if (gameResults[_gameId].gameId != 0) revert GameAlreadyRecorded();

        // Record the game result
        gameResults[_gameId] = GameResult({
            gameId: _gameId,
            winner: _winner,
            loser: _loser,
            timestamp: block.timestamp
        });

        // Update player statistics
        _updatePlayerStats(_winner, true); // Winner
        _updatePlayerStats(_loser, false); // Loser

        totalGamesTracked++;

        emit GameResultRecorded(_gameId, _winner, _loser, block.timestamp);
    }

    /**
     * @dev Update player statistics when a game result is recorded
     * @param _player The player address
     * @param _won Whether the player won (true) or lost (false)
     */
    function _updatePlayerStats(address _player, bool _won) internal {
        PlayerStats storage stats = playerStats[_player];

        if (_won) {
            stats.wins++;
        } else {
            stats.losses++;
        }

        stats.totalGames++;

        emit PlayerStatsUpdated(
            _player,
            stats.wins,
            stats.losses,
            stats.totalGames
        );
    }

    /**
     * @dev Get the complete statistics for a player
     * @param _player The player address
     * @return The player's statistics
     */
    function getPlayerStats(
        address _player
    ) external view returns (PlayerStats memory) {
        return playerStats[_player];
    }

    /**
     * @dev Get the result of a specific game
     * @param _gameId The ID of the game
     * @return The game result
     */
    function getGameResult(
        uint _gameId
    ) external view returns (GameResult memory) {
        GameResult memory result = gameResults[_gameId];
        if (result.gameId == 0) revert GameNotFound();
        return result;
    }

    /**
     * @dev Check if a game result has been recorded
     * @param _gameId The ID of the game
     * @return True if the game result has been recorded
     */
    function isGameResultRecorded(uint _gameId) external view returns (bool) {
        return gameResults[_gameId].gameId != 0;
    }

    /**
     * @dev Get the total number of games a player has participated in
     * @param _player The player address
     * @return The total number of games
     */
    function getPlayerTotalGames(address _player) external view returns (uint) {
        return playerStats[_player].totalGames;
    }

    /**
     * @dev Get the win rate of a player (wins / total games)
     * @param _player The player address
     * @return The win rate as a percentage (0-100)
     */
    function getPlayerWinRate(address _player) external view returns (uint) {
        PlayerStats memory stats = playerStats[_player];
        if (stats.totalGames == 0) return 0;
        return (stats.wins * 100) / stats.totalGames;
    }

    /**
     * @dev Get the top players by wins (limited to top N)
     * @param _limit The maximum number of players to return
     * @return Array of player addresses sorted by wins (descending)
     */
    function getTopPlayersByWins(
        uint _limit
    ) external view returns (address[] memory) {
        // This is a simplified implementation - in production you might want to use a more sophisticated approach
        // For now, we'll return an empty array as this would require iterating over all players
        // which could be gas-intensive
        return new address[](0);
    }
}

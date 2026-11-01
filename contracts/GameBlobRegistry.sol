// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/access/Ownable.sol";

interface IGameResults {
    struct GameResult {
        uint gameId;
        address winner;
        address loser;
        uint timestamp;
    }
    function isGameResultRecorded(uint256 gameId) external view returns (bool);
    function getGameResult(uint256 gameId) external view returns (GameResult memory);
}

// Stores the archive blobId for every completed regular game.
// Each player owns their own slot and may update it (e.g. after re-upload).
// The authorizedWriter (Firebase backend) may write on behalf of either participant.
contract GameBlobRegistry is Ownable {
    IGameResults public immutable gameResults;

    // Address allowed to write blobs on behalf of any game participant.
    address public authorizedWriter;

    // blobs[gameId][player] = blobId
    mapping(uint256 => mapping(address => bytes32)) public blobs;

    event BlobRecorded(uint256 indexed gameId, address indexed player, bytes32 blobId);
    event AuthorizedWriterUpdated(address indexed previous, address indexed next);

    error GameNotComplete();
    error NotParticipant();
    error Unauthorized();

    constructor(address _gameResults, address _authorizedWriter) Ownable(msg.sender) {
        gameResults = IGameResults(_gameResults);
        authorizedWriter = _authorizedWriter;
    }

    // Update the authorized backend writer address.
    function setAuthorizedWriter(address _writer) external onlyOwner {
        emit AuthorizedWriterUpdated(authorizedWriter, _writer);
        authorizedWriter = _writer;
    }

    // Record a blob for `player` in `gameId`.
    // Caller must be the player themselves or the authorizedWriter.
    // `player` must be the winner or loser of the completed game.
    function record(uint256 gameId, address player, bytes32 blobId) external {
        if (!gameResults.isGameResultRecorded(gameId)) revert GameNotComplete();

        IGameResults.GameResult memory result = gameResults.getGameResult(gameId);
        if (player != result.winner && player != result.loser) revert NotParticipant();
        if (msg.sender != player && msg.sender != authorizedWriter) revert Unauthorized();

        blobs[gameId][player] = blobId;
        emit BlobRecorded(gameId, player, blobId);
    }
}

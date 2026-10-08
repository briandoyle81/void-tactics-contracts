// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

// Import Position struct from Types
import "./Types.sol";

interface IMaps {
    // Grid constants
    function GRID_WIDTH() external view returns (int16);

    function GRID_HEIGHT() external view returns (int16);

    // Set a tile as blocked for line of sight
    function setBlockedTile(
        uint _gameId,
        int16 _row,
        int16 _col,
        bool _blocked
    ) external;

    // Check if a tile is blocked
    function isTileBlocked(
        uint _gameId,
        int16 _row,
        int16 _col
    ) external view returns (bool);

    // Set/check impassable (movement-blocking) tiles — independent of the
    // blocked (LOS-only) flag above.
    function setImpassableTile(
        uint _gameId,
        int16 _row,
        int16 _col,
        bool _impassable
    ) external;

    function isTileImpassable(
        uint _gameId,
        int16 _row,
        int16 _col
    ) external view returns (bool);

    // Main line of sight function using Bresenham's algorithm
    function hasMaps(
        uint _gameId,
        int16 _x0,
        int16 _y0,
        int16 _x1,
        int16 _y1
    ) external view returns (bool);

    // Whether a ship can move between two points without its path crossing
    // an impassable tile (blocks landing on and passing through).
    function hasMovementPath(
        uint _gameId,
        int16 _row0,
        int16 _col0,
        int16 _row1,
        int16 _col1
    ) external view returns (bool);

    // hasMaps/hasMovementPath, but ALSO blocked by any tile in
    // _enemyOccupiedBitmap (a bit-per-cell mask the caller builds from live
    // enemy ship positions -- Maps.sol has no ship-position knowledge of its
    // own). See Maps.sol's own comments for the ally/enemy split and, for
    // hasMapsAvoidingShips, why the shot's own target must be excluded from
    // the bitmap.
    function hasMovementPathAvoidingShips(
        uint _gameId,
        int16 _row0,
        int16 _col0,
        int16 _row1,
        int16 _col1,
        uint256 _enemyOccupiedBitmap
    ) external view returns (bool);

    function hasMapsAvoidingShips(
        uint _gameId,
        int16 _row0,
        int16 _col0,
        int16 _row1,
        int16 _col1,
        uint256 _enemyOccupiedBitmap
    ) external view returns (bool);

    // Preset map functions. Note: createPresetMap/createPresetScoringMap
    // below are overloaded/disambiguated on the Maps.sol implementation side
    // (see that contract's comments) — these declarations match the actual
    // implementation's signatures (no return value; MapMode included).
    function createPresetMap(
        Position[] calldata _blockedPositions,
        ScoringPosition[] calldata _scoringPositions,
        MapMode _mode
    ) external;

    function createPresetMap(
        Position[] calldata _blockedPositions,
        MapMode _mode
    ) external;

    function createFullPresetMap(
        Position[] calldata _blockedPositions,
        Position[] calldata _impassablePositions,
        ScoringPosition[] calldata _scoringPositions,
        MapMode _mode
    ) external;

    function updatePresetMap(
        uint _mapId,
        Position[] calldata _blockedPositions
    ) external;

    function applyPresetMapToGame(uint _gameId, uint _mapId) external;

    function getPresetMap(
        uint _mapId
    ) external view returns (Position[] memory);

    function getPresetMapImpassable(
        uint _mapId
    ) external view returns (Position[] memory);

    function updatePresetMapImpassable(
        uint _mapId,
        Position[] calldata _impassablePositions
    ) external;

    function mapExists(uint _mapId) external view returns (bool);

    function mapCount() external view returns (uint);

    function mapMode(uint _mapId) external view returns (MapMode);

    // Deployment zones
    function setCreatorZone(
        uint _mapId,
        Position[] calldata _tiles
    ) external;

    function setJoinerZone(uint _mapId, Position[] calldata _tiles) external;

    function isValidDeploymentTile(
        uint _mapId,
        int16 _row,
        int16 _col,
        bool _isCreator
    ) external view returns (bool);

    function getCreatorZonePositions(
        uint _mapId
    ) external view returns (Position[] memory);

    function getJoinerZonePositions(
        uint _mapId
    ) external view returns (Position[] memory);

    // Scoring tile functions
    function getGameMapState(
        uint _gameId
    )
        external
        view
        returns (
            Position[] memory blockedPositions,
            ScoringPosition[] memory scoringPositions,
            Position[] memory impassablePositions
        );

    // Scoring positions only — for on-chain callers (round-end scoring,
    // Turtle-archetype AI) that never need blockedPositions and shouldn't
    // pay for computing it. See Maps.sol for why blockedPositions itself
    // still needs a full grid scan while this is O(configured tiles).
    function getGameScoringPositions(
        uint _gameId
    ) external view returns (ScoringPosition[] memory);

    function setScoringTile(
        uint _gameId,
        int16 _row,
        int16 _col,
        uint8 _points
    ) external;

    function isTileScoring(
        uint _gameId,
        int16 _row,
        int16 _col
    ) external view returns (uint8);

    function getScoreAndZeroOut(
        uint _gameId,
        int16 _row,
        int16 _col
    ) external returns (uint8);

    function isTileScoringSafe(
        uint _gameId,
        int16 _row,
        int16 _col
    ) external view returns (uint8);

    // Preset scoring map functions
    function createPresetScoringMap(
        ScoringPosition[] calldata _scoringPositions,
        MapMode _mode
    ) external;

    function updatePresetScoringMap(
        uint _mapId,
        ScoringPosition[] calldata _scoringPositions
    ) external;

    function applyPresetScoringMapToGame(uint _gameId, uint _mapId) external;

    function getPresetScoringMap(
        uint _mapId
    ) external view returns (ScoringPosition[] memory);
}

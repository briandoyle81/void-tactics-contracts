// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import "./Types.sol";
import "./IGameEngineRegistry.sol";
import "./IGameEndedView.sol";

contract Maps is Ownable {
    using EnumerableSet for EnumerableSet.UintSet;

    // Grid dimensions
    int16 public constant GRID_WIDTH = 17; // Number of columns
    int16 public constant GRID_HEIGHT = 11; // Number of rows

    // Blocked-tile presence packed into a single uint256 bit-per-cell mask
    // (bit index = row * GRID_WIDTH + col; 11*17=187 cells fits in one word
    // with room to spare). Replaces a triple-nested mapping that used to
    // cost one cold SSTORE (~22,100 gas) per blocked tile every time a
    // preset was copied into a game — on a half-blocked map that alone
    // could run into the millions of gas. A bitmask copy is a single SSTORE
    // regardless of density. mapping(uint => uint256) is intentionally
    // private, not public: nothing reads these raw words directly anywhere
    // in this codebase (confirmed via repo-wide search before this change),
    // every consumer goes through isTileBlocked/_isTileBlockedSafe/
    // getPresetMap/getGameMapState, whose signatures are unaffected.
    mapping(uint => uint256) private blockedTilesBitmap; // gameId => mask
    mapping(uint => uint256) private presetBlockedMapsBitmap; // mapId => mask

    // Movement-blocking terrain, same bitmask shape as blocked (LOS) above,
    // but an independent bit: blocked affects only shooting line-of-sight,
    // impassable affects only movement (see hasMovementPath) — a cell can be
    // soft cover (blocked, not impassable), a movement hazard (impassable,
    // not blocked), hard cover (both), or open (neither).
    mapping(uint => uint256) private impassableTilesBitmap; // gameId => mask
    mapping(uint => uint256) private presetImpassableMapsBitmap; // mapId => mask

    // Per-map deployment zones: which cells a fleet may start on, keyed by
    // side. An unset (zero) bitmask means "use the engine-wide default"
    // (Fleets.sol's historical creator col 0-3 / joiner col 13-16, row 0-10
    // rule) — see isValidDeploymentTile. A bitmask can never distinguish
    // "unset" from "deliberately empty," which is fine: an empty deployment
    // zone would make the map's fleets uncreatable anyway, so collapsing
    // that case into "use the default" is safe, not a real limitation.
    mapping(uint => uint256) private presetCreatorZoneBitmap; // mapId => mask
    mapping(uint => uint256) private presetJoinerZoneBitmap; // mapId => mask

    // Mapping: gameId => row => column => scoring
    mapping(uint => mapping(int16 => mapping(int16 => uint8)))
        public scoringTiles;

    // Preset maps: mapId => row => column => scoring
    mapping(uint => mapping(int16 => mapping(int16 => uint8)))
        public presetScoringMaps;

    // Mapping: gameId => row => column => onlyOnce
    mapping(uint => mapping(int16 => mapping(int16 => bool)))
        public onlyOnceTiles;

    // Preset maps: mapId => row => column => onlyOnce
    mapping(uint => mapping(int16 => mapping(int16 => bool)))
        public presetOnlyOnceMaps;

    // Bounded companion indexes for the scoring mappings above, so
    // enumerating "which cells are scoring tiles" is O(configured tiles)
    // instead of O(grid size). Positions are packed as (row << 16 | col);
    // points/onlyOnce still live solely in presetScoringMaps/scoringTiles so
    // there's a single source of truth for the actual values — these sets
    // only track which cells to look at. Kept in lockstep with
    // presetScoringMaps/scoringTiles by every function that writes them.
    mapping(uint => EnumerableSet.UintSet) private presetScoringPositionSet; // mapId => packed positions
    mapping(uint => EnumerableSet.UintSet) private gameScoringPositionSet; // gameId => packed positions

    // Counter for preset maps
    uint public mapCount;

    // presetMapId => which game mode(s) it's valid for. Set at creation,
    // editable afterward — see Types.sol's MapMode for what enforces this.
    mapping(uint => MapMode) public mapMode;

    // Game instances allowed to apply preset maps to a game and to read
    // scoring tiles (applyPresetMapToGame/applyPresetScoringMapToGame/
    // getScoreAndZeroOut). Was a single `gameAddress` until 2026-09-28 —
    // widened to an allowlist (mirroring isMapEditor's own shape) so more
    // than one Game "engine" instance can be trusted at once: maps/preset
    // data stay shared across every engine, only the gameplay-rules
    // contracts (Game itself, orchestrators) get redeployed on a rules
    // change. See the engine-registry plan.
    mapping(address => bool) public isAllowedGame;

    // Addresses allowed to create/edit preset maps (in addition to the owner)
    mapping(address => bool) public isMapEditor;

    // UA-12 fix (2026-09-29): optional (unset falls back to the old,
    // unguarded behavior — same "unwired = permissive" convention this
    // codebase already uses elsewhere, e.g. RoguelikeNodeMap.runLedger).
    // When set, lets setBlockedTile/setImpassableTile/setScoringTile look
    // up which Game contract a _gameId actually lives on and refuse the
    // edit if that specific game has already ended — closing the "admin
    // meant to pass a _mapId but passed a live game's _gameId instead"
    // footgun for the most consequential case (an ended game has no reason
    // to ever need a live tile edit). See
    // docs/upgrade-safety-audit-2026-09-29.md UA-12.
    IGameEngineRegistry public engineRegistry;

    // Custom error for invalid positions
    error InvalidPosition();
    error MapNotFound();
    error NotGameContract();
    error NotMapEditor();
    error GameAlreadyEnded();

    event MapEditorSet(address indexed editor, bool allowed);
    event DeploymentZoneSet(uint indexed mapId, bool isCreator);

    constructor() Ownable(msg.sender) {}

    // Packs a grid position into a single uint key for use with
    // EnumerableSet.UintSet. Safe for this grid's bounds (row/col both fit
    // easily in int16, and the sign bit is preserved by the uint16 cast
    // since coordinates here are always >= 0 by the time they're packed).
    function _packPosition(int16 _row, int16 _col) internal pure returns (uint) {
        return (uint(uint16(_row)) << 16) | uint(uint16(_col));
    }

    function _unpackPosition(
        uint _packed
    ) internal pure returns (int16 row, int16 col) {
        row = int16(uint16(_packed >> 16));
        col = int16(uint16(_packed));
    }

    // Total grid cells (11*17=187), used to bound the blocked-tile bitmask
    // scan/reconstruction loops below instead of a bare magic number.
    uint private constant TOTAL_CELLS =
        uint(uint16(GRID_HEIGHT)) * uint(uint16(GRID_WIDTH));

    // Bit index into a blocked-tile bitmask for a given grid cell. Callers
    // MUST have already bounds-checked row/col (0 <= row < GRID_HEIGHT,
    // 0 <= col < GRID_WIDTH) — this does not re-validate, since every call
    // site already has its own bounds check immediately before calling this
    // (duplicating it here would just be a second, redundant revert path).
    // Max index is (GRID_HEIGHT-1)*GRID_WIDTH + (GRID_WIDTH-1) = 186,
    // safely inside 0-255.
    function _bitIndex(int16 _row, int16 _col) internal pure returns (uint) {
        return
            uint(uint16(_row)) *
            uint(uint16(GRID_WIDTH)) +
            uint(uint16(_col));
    }

    function _isBitSet(
        uint256 _bitmap,
        uint _index
    ) internal pure returns (bool) {
        return (_bitmap >> _index) & 1 == 1;
    }

    function _setBit(
        uint256 _bitmap,
        uint _index
    ) internal pure returns (uint256) {
        return _bitmap | (uint256(1) << _index);
    }

    function _clearBit(
        uint256 _bitmap,
        uint _index
    ) internal pure returns (uint256) {
        return _bitmap & ~(uint256(1) << _index);
    }

    /// @dev Restricts to the owner or an allowed map editor.
    modifier onlyMapEditor() {
        if (msg.sender != owner() && !isMapEditor[msg.sender])
            revert NotMapEditor();
        _;
    }

    /**
     * @dev Authorize (or revoke) a Game instance to apply preset maps and
     *      read/zero scoring tiles.
     * @param _game The Game contract's address
     * @param _allowed Whether it's authorized
     */
    function setIsAllowedGame(address _game, bool _allowed) external onlyOwner {
        isAllowedGame[_game] = _allowed;
    }

    function setEngineRegistry(address _engineRegistry) external onlyOwner {
        engineRegistry = IGameEngineRegistry(_engineRegistry);
    }

    // UA-12 fix: shared by the three debug tile setters below. Permissive
    // (returns false, i.e. "not ended") whenever the registry isn't wired,
    // or this gameId was never recorded in it — never blocks a legitimate
    // edit just because the trustless lookup itself isn't available.
    function _gameHasEnded(uint _gameId) private view returns (bool) {
        if (address(engineRegistry) == address(0)) return false;
        address engine = engineRegistry.engineOfGame(_gameId);
        if (engine == address(0)) return false;
        (GameMetadata memory metadata, ) = IGameEndedView(engine)
            .getGameMetadataAndTurnState(_gameId);
        return metadata.ended;
    }

    /**
     * @dev Grant or revoke map-editor rights (create/edit preset maps and tiles).
     * @param _editor The address to update
     * @param _allowed Whether the address may edit maps
     */
    function setMapEditor(address _editor, bool _allowed) external onlyOwner {
        isMapEditor[_editor] = _allowed;
        emit MapEditorSet(_editor, _allowed);
    }

    /**
     * @dev Reclassify an existing preset map's valid game mode(s) — e.g. if
     * a map originally seeded for the campaign should also be selectable
     * for PvP lobbies, or vice versa.
     * @param _mapId The map ID to update
     * @param _mode Which game mode(s) this map should be valid for
     */
    function setMapMode(uint _mapId, MapMode _mode) external onlyMapEditor {
        if (_mapId == 0 || _mapId > mapCount) revert MapNotFound();
        mapMode[_mapId] = _mode;
    }

    /**
     * @dev Create a new preset map with both blocked and scoring tiles
     * @param _blockedPositions Array of blocked positions
     * @param _scoringPositions Array of scoring positions with point values
     * @param _mode Which game mode(s) this map is valid for
     */
    function createPresetMap(
        Position[] memory _blockedPositions,
        ScoringPosition[] memory _scoringPositions,
        MapMode _mode
    ) external onlyMapEditor {
        _createPresetMapInternal(
            _blockedPositions,
            new Position[](0),
            _scoringPositions,
            _mode
        );
    }

    /**
     * @dev Create a new preset map with only blocked positions
     * @param _blockedPositions Array of blocked positions
     * @param _mode Which game mode(s) this map is valid for
     */
    function createPresetMap(
        Position[] memory _blockedPositions,
        MapMode _mode
    ) external onlyMapEditor {
        _createPresetMapInternal(
            _blockedPositions,
            new Position[](0),
            new ScoringPosition[](0),
            _mode
        );
    }

    /**
     * @dev Create a new preset map with only scoring positions
     * @param _scoringPositions Array of scoring positions with point values
     * @param _mode Which game mode(s) this map is valid for
     */
    function createPresetScoringMap(
        ScoringPosition[] memory _scoringPositions,
        MapMode _mode
    ) external onlyMapEditor {
        _createPresetMapInternal(
            new Position[](0),
            new Position[](0),
            _scoringPositions,
            _mode
        );
    }

    /**
     * @dev Create a new preset map with both blocked and scoring tiles, under
     * a name unique in this contract. createPresetMap is overloaded (with a
     * blocked-only variant), and Hardhat Ignition's function-name validator
     * cannot disambiguate an overload whose signature contains a struct/
     * tuple array (same reason createPresetScoringMap exists instead of the
     * scoring-only createPresetMap overload — see DeployAndConfig.ts) — so
     * deploy scripts that need to seed both blocked and scoring tiles in one
     * call must go through this function instead. This is also the only
     * creation entry point that accepts impassable-terrain positions — the
     * other overloads above don't take them (kept untouched deliberately,
     * to avoid ABI churn on entry points Ignition doesn't actually call).
     * @param _blockedPositions Array of blocked (LOS-blocking) positions
     * @param _impassablePositions Array of impassable (movement-blocking)
     *        positions — independent of _blockedPositions, see
     *        hasMovementPath
     * @param _scoringPositions Array of scoring positions with point values
     * @param _mode Which game mode(s) this map is valid for
     */
    function createFullPresetMap(
        Position[] memory _blockedPositions,
        Position[] memory _impassablePositions,
        ScoringPosition[] memory _scoringPositions,
        MapMode _mode
    ) external onlyMapEditor {
        _createPresetMapInternal(
            _blockedPositions,
            _impassablePositions,
            _scoringPositions,
            _mode
        );
    }

    /**
     * @dev Internal function to create a preset map with blocked, impassable,
     * and scoring tiles
     * @param _blockedPositions Array of blocked positions
     * @param _impassablePositions Array of impassable positions
     * @param _scoringPositions Array of scoring positions with point values
     * @param _mode Which game mode(s) this map is valid for
     */
    function _createPresetMapInternal(
        Position[] memory _blockedPositions,
        Position[] memory _impassablePositions,
        ScoringPosition[] memory _scoringPositions,
        MapMode _mode
    ) internal {
        mapCount++;
        mapMode[mapCount] = _mode;

        // Set blocked positions
        uint256 bitmap = presetBlockedMapsBitmap[mapCount];
        for (uint i = 0; i < _blockedPositions.length; i++) {
            Position memory pos = _blockedPositions[i];
            if (
                pos.row < 0 ||
                pos.row >= GRID_HEIGHT ||
                pos.col < 0 ||
                pos.col >= GRID_WIDTH
            ) {
                revert InvalidPosition();
            }
            bitmap = _setBit(bitmap, _bitIndex(pos.row, pos.col));
        }
        presetBlockedMapsBitmap[mapCount] = bitmap;

        // Set impassable positions (independent bitmask, same shape)
        uint256 impassableBitmap = presetImpassableMapsBitmap[mapCount];
        for (uint i = 0; i < _impassablePositions.length; i++) {
            Position memory pos = _impassablePositions[i];
            if (
                pos.row < 0 ||
                pos.row >= GRID_HEIGHT ||
                pos.col < 0 ||
                pos.col >= GRID_WIDTH
            ) {
                revert InvalidPosition();
            }
            impassableBitmap = _setBit(impassableBitmap, _bitIndex(pos.row, pos.col));
        }
        presetImpassableMapsBitmap[mapCount] = impassableBitmap;

        // Set scoring positions
        for (uint i = 0; i < _scoringPositions.length; i++) {
            ScoringPosition memory pos = _scoringPositions[i];
            if (
                pos.row < 0 ||
                pos.row >= GRID_HEIGHT ||
                pos.col < 0 ||
                pos.col >= GRID_WIDTH
            ) {
                revert InvalidPosition();
            }
            presetScoringMaps[mapCount][pos.row][pos.col] = pos.points;
            presetOnlyOnceMaps[mapCount][pos.row][pos.col] = pos.onlyOnce;
            presetScoringPositionSet[mapCount].add(
                _packPosition(pos.row, pos.col)
            );
        }
    }

    /**
     * @dev Update an existing preset map
     * @param _mapId The map ID to update
     * @param _blockedPositions Array of blocked positions
     */
    function updatePresetMap(
        uint _mapId,
        Position[] calldata _blockedPositions
    ) external onlyMapEditor {
        if (_mapId == 0 || _mapId > mapCount) revert MapNotFound();

        // Full replace: compute the new bitmap from scratch rather than
        // reading back the old one to clear it bit-by-bit — either way any
        // old blocked tile not in the new array is gone, so this is
        // behaviorally identical to the old clear-then-rewrite dance.
        uint256 bitmap = 0;
        for (uint i = 0; i < _blockedPositions.length; i++) {
            Position memory pos = _blockedPositions[i];
            if (
                pos.row < 0 ||
                pos.row >= GRID_HEIGHT ||
                pos.col < 0 ||
                pos.col >= GRID_WIDTH
            ) {
                revert InvalidPosition();
            }
            bitmap = _setBit(bitmap, _bitIndex(pos.row, pos.col));
        }
        presetBlockedMapsBitmap[_mapId] = bitmap;
    }

    /**
     * @dev Update an existing preset scoring map
     * @param _mapId The map ID to update
     * @param _scoringPositions Array of scoring positions with point values
     */
    function updatePresetScoringMap(
        uint _mapId,
        ScoringPosition[] calldata _scoringPositions
    ) external onlyMapEditor {
        if (_mapId == 0 || _mapId > mapCount) revert MapNotFound();

        // Get the current scoring positions and clear them
        ScoringPosition[] memory currentPositions = _getPresetScoringMap(
            _mapId
        );
        for (uint i = 0; i < currentPositions.length; i++) {
            ScoringPosition memory pos = currentPositions[i];
            presetScoringMaps[_mapId][pos.row][pos.col] = 0;
            presetOnlyOnceMaps[_mapId][pos.row][pos.col] = false;
            presetScoringPositionSet[_mapId].remove(
                _packPosition(pos.row, pos.col)
            );
        }

        // Set new scoring positions
        for (uint i = 0; i < _scoringPositions.length; i++) {
            ScoringPosition memory pos = _scoringPositions[i];
            if (
                pos.row < 0 ||
                pos.row >= GRID_HEIGHT ||
                pos.col < 0 ||
                pos.col >= GRID_WIDTH
            ) {
                revert InvalidPosition();
            }
            presetScoringMaps[_mapId][pos.row][pos.col] = pos.points;
            presetOnlyOnceMaps[_mapId][pos.row][pos.col] = pos.onlyOnce;
            presetScoringPositionSet[_mapId].add(
                _packPosition(pos.row, pos.col)
            );
        }
    }

    /**
     * @dev Update an existing preset map with both blocked and scoring tiles
     * @param _mapId The map ID to update
     * @param _blockedPositions Array of blocked positions
     * @param _scoringPositions Array of scoring positions with point values
     */
    function updatePresetMap(
        uint _mapId,
        Position[] memory _blockedPositions,
        ScoringPosition[] memory _scoringPositions
    ) external onlyMapEditor {
        if (_mapId == 0 || _mapId > mapCount) revert MapNotFound();

        // Clear existing scoring positions
        ScoringPosition[] memory currentScoringPositions = _getPresetScoringMap(
            _mapId
        );
        for (uint i = 0; i < currentScoringPositions.length; i++) {
            ScoringPosition memory pos = currentScoringPositions[i];
            presetScoringMaps[_mapId][pos.row][pos.col] = 0;
            presetOnlyOnceMaps[_mapId][pos.row][pos.col] = false;
            presetScoringPositionSet[_mapId].remove(
                _packPosition(pos.row, pos.col)
            );
        }

        // Set new blocked positions (full replace, see the blocked-only
        // updatePresetMap overload's comment for why computing fresh is
        // behaviorally identical to clear-then-rewrite)
        uint256 bitmap = 0;
        for (uint i = 0; i < _blockedPositions.length; i++) {
            Position memory pos = _blockedPositions[i];
            if (
                pos.row < 0 ||
                pos.row >= GRID_HEIGHT ||
                pos.col < 0 ||
                pos.col >= GRID_WIDTH
            ) {
                revert InvalidPosition();
            }
            bitmap = _setBit(bitmap, _bitIndex(pos.row, pos.col));
        }
        presetBlockedMapsBitmap[_mapId] = bitmap;

        // Set new scoring positions
        for (uint i = 0; i < _scoringPositions.length; i++) {
            ScoringPosition memory pos = _scoringPositions[i];
            if (
                pos.row < 0 ||
                pos.row >= GRID_HEIGHT ||
                pos.col < 0 ||
                pos.col >= GRID_WIDTH
            ) {
                revert InvalidPosition();
            }
            presetScoringMaps[_mapId][pos.row][pos.col] = pos.points;
            presetOnlyOnceMaps[_mapId][pos.row][pos.col] = pos.onlyOnce;
            presetScoringPositionSet[_mapId].add(
                _packPosition(pos.row, pos.col)
            );
        }
    }

    /**
     * @dev Apply a preset map to a specific game
     * @param _gameId The game ID
     * @param _mapId The preset map ID to apply
     */
    function applyPresetMapToGame(uint _gameId, uint _mapId) external {
        if (!isAllowedGame[msg.sender] && msg.sender != owner())
            revert NotGameContract();
        if (_mapId == 0 || _mapId > mapCount) revert MapNotFound();

        // Copy the preset's blocked-tile bitmask into this game in one
        // SSTORE, regardless of how many tiles are blocked — this used to
        // be one cold SSTORE per blocked tile (~22,100 gas each), which
        // could run into the millions of gas on a dense map.
        blockedTilesBitmap[_gameId] = presetBlockedMapsBitmap[_mapId];

        // Same full-overwrite copy for impassable terrain, independent of
        // (and via the same mechanism as) the blocked-tile copy above.
        impassableTilesBitmap[_gameId] = presetImpassableMapsBitmap[_mapId];

        // Get the preset scoring positions and apply them to the game
        _applyPresetScoringToGame(_gameId, _mapId);
    }

    /**
     * @dev Apply a preset scoring map to a specific game
     * @param _gameId The game ID to apply the map to
     * @param _mapId The preset scoring map ID to apply
     */
    function applyPresetScoringMapToGame(uint _gameId, uint _mapId) external {
        if (!isAllowedGame[msg.sender] && msg.sender != owner())
            revert NotGameContract();
        if (_mapId == 0 || _mapId > mapCount) revert MapNotFound();

        _applyPresetScoringToGame(_gameId, _mapId);
    }

    // Shared by applyPresetMapToGame/applyPresetScoringMapToGame — copies a
    // preset's scoring tiles into a game's per-game state, keeping
    // gameScoringPositionSet in lockstep so getGameMapState's scoring lookup
    // stays O(configured tiles). EnumerableSet.add is a no-op if the position
    // is already present, so calling this more than once for the same
    // gameId is harmless.
    function _applyPresetScoringToGame(uint _gameId, uint _mapId) internal {
        ScoringPosition[] memory scoringPositions = _getPresetScoringMap(
            _mapId
        );
        for (uint i = 0; i < scoringPositions.length; i++) {
            ScoringPosition memory pos = scoringPositions[i];
            scoringTiles[_gameId][pos.row][pos.col] = presetScoringMaps[_mapId][
                pos.row
            ][pos.col];
            onlyOnceTiles[_gameId][pos.row][pos.col] = presetOnlyOnceMaps[
                _mapId
            ][pos.row][pos.col];
            gameScoringPositionSet[_gameId].add(
                _packPosition(pos.row, pos.col)
            );
        }
    }

    /**
     * @dev Get a preset map's blocked tiles (external version)
     * @param _mapId The map ID
     * @return Array of blocked positions
     */
    function getPresetMap(
        uint _mapId
    ) external view returns (Position[] memory) {
        return _getPresetMap(_mapId);
    }

    /**
     * @dev Get a preset map's blocked tiles (internal version)
     * @param _mapId The map ID
     * @return Array of blocked positions
     */
    function _getPresetMap(
        uint _mapId
    ) internal view returns (Position[] memory) {
        if (_mapId == 0 || _mapId > mapCount) revert MapNotFound();
        return _unpackBitmap(presetBlockedMapsBitmap[_mapId]);
    }

    /**
     * @dev Get a preset map's impassable (movement-blocking) tiles
     * @param _mapId The map ID
     * @return Array of impassable positions
     */
    function getPresetMapImpassable(
        uint _mapId
    ) external view returns (Position[] memory) {
        if (_mapId == 0 || _mapId > mapCount) revert MapNotFound();
        return _unpackBitmap(presetImpassableMapsBitmap[_mapId]);
    }

    /**
     * @dev Update an existing preset map's impassable (movement-blocking)
     * tiles. createFullPresetMap is the only creation entry point that sets
     * these, and — unlike blocked/scoring tiles, which updatePresetMap/
     * updatePresetScoringMap can already retune after creation — there was
     * previously no way to change a preset map's impassable tiles once
     * created. This fills that gap, mirroring updatePresetMap's full-replace
     * pattern exactly. Independent of blocked/scoring tiles.
     * @param _mapId The map ID to update
     * @param _impassablePositions Array of impassable positions (full replace)
     */
    function updatePresetMapImpassable(
        uint _mapId,
        Position[] calldata _impassablePositions
    ) external onlyMapEditor {
        if (_mapId == 0 || _mapId > mapCount) revert MapNotFound();

        uint256 bitmap = 0;
        for (uint i = 0; i < _impassablePositions.length; i++) {
            Position calldata pos = _impassablePositions[i];
            if (
                pos.row < 0 ||
                pos.row >= GRID_HEIGHT ||
                pos.col < 0 ||
                pos.col >= GRID_WIDTH
            ) {
                revert InvalidPosition();
            }
            bitmap = _setBit(bitmap, _bitIndex(pos.row, pos.col));
        }
        presetImpassableMapsBitmap[_mapId] = bitmap;
    }

    // Reconstructs a Position[] from a blocked-tile bitmask: one pass to
    // count set bits (so the memory array is allocated at the right size),
    // one pass to fill it. Shared by _getPresetMap and getGameMapState.
    // Only ever reached from view functions with no on-chain caller outside
    // this contract, so the fixed 187-cell scan (cheap now that it's a
    // shift/mask against one cached word instead of 187 nested-mapping
    // SLOADs) isn't worth trading for single-pass bit-scanning complexity.
    function _unpackBitmap(
        uint256 _bitmap
    ) internal pure returns (Position[] memory) {
        uint blockedCount = 0;
        for (uint idx = 0; idx < TOTAL_CELLS; idx++) {
            if (_isBitSet(_bitmap, idx)) blockedCount++;
        }

        Position[] memory blockedPositions = new Position[](blockedCount);
        uint outIdx = 0;
        for (uint idx = 0; idx < TOTAL_CELLS; idx++) {
            if (_isBitSet(_bitmap, idx)) {
                blockedPositions[outIdx] = Position(
                    int16(uint16(idx / uint(uint16(GRID_WIDTH)))),
                    int16(uint16(idx % uint(uint16(GRID_WIDTH))))
                );
                outIdx++;
            }
        }
        return blockedPositions;
    }

    /**
     * @dev Get a preset scoring map's scoring tiles (external version)
     * @param _mapId The map ID
     * @return Array of scoring positions
     */
    function getPresetScoringMap(
        uint _mapId
    ) external view returns (ScoringPosition[] memory) {
        return _getPresetScoringMap(_mapId);
    }

    /**
     * @dev Get a preset scoring map's scoring tiles (internal version).
     * O(configured scoring tiles) via presetScoringPositionSet instead of
     * O(grid size) — see that mapping's declaration for why it's safe to
     * trust as the source of *which* cells to read points/onlyOnce from.
     * @param _mapId The map ID
     * @return Array of scoring positions
     */
    function _getPresetScoringMap(
        uint _mapId
    ) internal view returns (ScoringPosition[] memory) {
        if (_mapId == 0 || _mapId > mapCount) revert MapNotFound();

        EnumerableSet.UintSet storage packedPositions = presetScoringPositionSet[
            _mapId
        ];
        uint count = packedPositions.length();
        ScoringPosition[] memory scoringPositions = new ScoringPosition[](
            count
        );
        for (uint i = 0; i < count; i++) {
            (int16 row, int16 col) = _unpackPosition(packedPositions.at(i));
            scoringPositions[i] = ScoringPosition(
                row,
                col,
                presetScoringMaps[_mapId][row][col],
                presetOnlyOnceMaps[_mapId][row][col]
            );
        }

        return scoringPositions;
    }

    /**
     * @dev Check if a preset map exists
     * @param _mapId The map ID to check
     * @return Whether the map exists
     */
    function mapExists(uint _mapId) external view returns (bool) {
        return _mapId > 0 && _mapId <= mapCount;
    }

    /**
     * @dev Get all preset maps with both blocked and scoring portions
     * @return mapIds Array of map IDs
     * @return blockedPositions Array of blocked positions for each map
     * @return scoringPositions Array of scoring positions for each map
     */
    function getAllPresetMaps()
        external
        view
        returns (
            uint[] memory mapIds,
            Position[][] memory blockedPositions,
            ScoringPosition[][] memory scoringPositions
        )
    {
        uint totalMaps = mapCount;
        mapIds = new uint[](totalMaps);
        blockedPositions = new Position[][](totalMaps);
        scoringPositions = new ScoringPosition[][](totalMaps);

        for (uint i = 1; i <= totalMaps; i++) {
            mapIds[i - 1] = i;
            blockedPositions[i - 1] = _getPresetMap(i);
            scoringPositions[i - 1] = _getPresetScoringMap(i);
        }
    }

    /**
     * @dev Get all preset map IDs only (gas-efficient)
     * @return mapIds Array of map IDs
     */
    function getAllPresetMapIds() external view returns (uint[] memory mapIds) {
        uint totalMaps = mapCount;
        mapIds = new uint[](totalMaps);

        for (uint i = 1; i <= totalMaps; i++) {
            mapIds[i - 1] = i;
        }
    }

    /**
     * @dev Set a tile as blocked or unblocked for a specific game
     * @param _gameId The game ID
     * @param _row The row coordinate (0-19)
     * @param _col The column coordinate (0-39)
     * @param _blocked Whether the tile should be blocked
     */
    function setBlockedTile(
        uint _gameId,
        int16 _row,
        int16 _col,
        bool _blocked
    ) external onlyMapEditor {
        if (_row < 0 || _row >= GRID_HEIGHT || _col < 0 || _col >= GRID_WIDTH) {
            revert InvalidPosition();
        }
        if (_gameHasEnded(_gameId)) revert GameAlreadyEnded();
        uint idx = _bitIndex(_row, _col);
        blockedTilesBitmap[_gameId] = _blocked
            ? _setBit(blockedTilesBitmap[_gameId], idx)
            : _clearBit(blockedTilesBitmap[_gameId], idx);
    }

    /**
     * @dev Set a tile as impassable (movement-blocking) or not, for a
     * specific game. Independent of setBlockedTile's LOS-blocking flag.
     * @param _gameId The game ID
     * @param _row The row coordinate
     * @param _col The column coordinate
     * @param _impassable Whether the tile should block movement
     */
    function setImpassableTile(
        uint _gameId,
        int16 _row,
        int16 _col,
        bool _impassable
    ) external onlyMapEditor {
        if (_row < 0 || _row >= GRID_HEIGHT || _col < 0 || _col >= GRID_WIDTH) {
            revert InvalidPosition();
        }
        if (_gameHasEnded(_gameId)) revert GameAlreadyEnded();
        uint idx = _bitIndex(_row, _col);
        impassableTilesBitmap[_gameId] = _impassable
            ? _setBit(impassableTilesBitmap[_gameId], idx)
            : _clearBit(impassableTilesBitmap[_gameId], idx);
    }

    /**
     * @dev Set a tile as scoring or non-scoring for a specific game
     * @param _gameId The game ID
     * @param _row The row coordinate
     * @param _col The column coordinate
     * @param _points The number of points available on this tile (0 for non-scoring)
     */
    function setScoringTile(
        uint _gameId,
        int16 _row,
        int16 _col,
        uint8 _points
    ) external onlyMapEditor {
        if (_row < 0 || _row >= GRID_HEIGHT || _col < 0 || _col >= GRID_WIDTH) {
            revert InvalidPosition();
        }
        if (_gameHasEnded(_gameId)) revert GameAlreadyEnded();
        scoringTiles[_gameId][_row][_col] = _points;
        uint packed = _packPosition(_row, _col);
        if (_points > 0) {
            gameScoringPositionSet[_gameId].add(packed);
        } else {
            gameScoringPositionSet[_gameId].remove(packed);
        }
    }

    /**
     * @dev Check if a tile is blocked for a specific game
     * @param _gameId The game ID
     * @param _row The row coordinate (0-19)
     * @param _col The column coordinate (0-39)
     * @return Whether the tile is blocked
     */
    function isTileBlocked(
        uint _gameId,
        int16 _row,
        int16 _col
    ) public view returns (bool) {
        if (_row < 0 || _row >= GRID_HEIGHT || _col < 0 || _col >= GRID_WIDTH) {
            revert InvalidPosition();
        }
        return _isBitSet(blockedTilesBitmap[_gameId], _bitIndex(_row, _col));
    }

    /**
     * @dev Check if a tile is impassable (movement-blocking) for a specific
     * game. Independent of isTileBlocked (LOS-only).
     * @param _gameId The game ID
     * @param _row The row coordinate
     * @param _col The column coordinate
     * @return Whether the tile is impassable
     */
    function isTileImpassable(
        uint _gameId,
        int16 _row,
        int16 _col
    ) public view returns (bool) {
        if (_row < 0 || _row >= GRID_HEIGHT || _col < 0 || _col >= GRID_WIDTH) {
            revert InvalidPosition();
        }
        return _isBitSet(impassableTilesBitmap[_gameId], _bitIndex(_row, _col));
    }

    /**
     * @dev Check if a tile is scoring for a specific game
     * @param _gameId The game ID
     * @param _row The row coordinate (0-19)
     * @param _col The column coordinate (0-39)
     * @return Whether the tile is scoring
     */
    function isTileScoring(
        uint _gameId,
        int16 _row,
        int16 _col
    ) public view returns (uint8) {
        if (_row < 0 || _row >= GRID_HEIGHT || _col < 0 || _col >= GRID_WIDTH) {
            revert InvalidPosition();
        }
        return scoringTiles[_gameId][_row][_col];
    }

    /**
     * @dev Check if a tile is scoring and zero it out if it has the onlyOnce flag set
     * @param _gameId The game ID
     * @param _row The row coordinate
     * @param _col The column coordinate
     * @return The points on the tile
     */

    function getScoreAndZeroOut(
        uint _gameId,
        int16 _row,
        int16 _col
    ) public returns (uint8) {
        if (!isAllowedGame[msg.sender] && msg.sender != owner())
            revert NotGameContract();
        uint8 points = scoringTiles[_gameId][_row][_col];
        if (onlyOnceTiles[_gameId][_row][_col]) {
            scoringTiles[_gameId][_row][_col] = 0;
            gameScoringPositionSet[_gameId].remove(_packPosition(_row, _col));
        }
        return points;
    }

    /**
     * @dev Check if a tile is scoring safely (public version that handles OOB gracefully)
     * @param _gameId The game ID
     * @param _row The row coordinate
     * @param _col The column coordinate
     * @return Whether the tile is scoring (treats OOB as non-scoring)
     */
    function isTileScoringSafe(
        uint _gameId,
        int16 _row,
        int16 _col
    ) public view returns (uint8) {
        if (_row < 0 || _row >= GRID_HEIGHT || _col < 0 || _col >= GRID_WIDTH) {
            return 0; // Treat out of bounds as non-scoring
        }
        return scoringTiles[_gameId][_row][_col];
    }

    /**
     * @dev Check if a tile is blocked safely (for internal use in LOS)
     * @param _bitmap The game's blockedTilesBitmap, read once by the caller
     *        (hasMaps) and threaded through — a Bresenham walk calls this
     *        50-80 times per hasMaps call, so re-reading the same storage
     *        slot from every call site is real, avoidable per-shot overhead
     *        (G-03); it never changes within a single hasMaps call.
     * @param _row The row coordinate
     * @param _col The column coordinate
     * @return Whether the tile is blocked (treats OOB as blocked)
     */
    function _isTileBlockedSafe(
        uint256 _bitmap,
        int16 _row,
        int16 _col
    ) internal pure returns (bool) {
        if (_row < 0 || _row >= GRID_HEIGHT || _col < 0 || _col >= GRID_WIDTH) {
            return true; // Treat out of bounds as blocked
        }
        return _isBitSet(_bitmap, _bitIndex(_row, _col));
    }

    /**
     * @dev Check if a tile is scoring safely (for internal use in LOS)
     * @param _gameId The game ID
     * @param _row The row coordinate
     * @param _col The column coordinate
     * @return Whether the tile is scoring (treats OOB as non-scoring)
     */
    function _isTileScoringSafe(
        uint _gameId,
        int16 _row,
        int16 _col
    ) internal view returns (uint8) {
        if (_row < 0 || _row >= GRID_HEIGHT || _col < 0 || _col >= GRID_WIDTH) {
            return 0; // Treat out of bounds as non-scoring
        }
        return scoringTiles[_gameId][_row][_col];
    }

    /**
     * @dev Check if there's a clear line of sight between two points
     * @param _gameId The game ID
     * @param _row0 Starting row coordinate (0-19)
     * @param _col0 Starting column coordinate (0-39)
     * @param _row1 Ending row coordinate (0-19)
     * @param _col1 Ending column coordinate (0-39)
     * @return Whether there's a clear line of sight
     */
    function hasMaps(
        uint _gameId,
        int16 _row0,
        int16 _col0,
        int16 _row1,
        int16 _col1
    ) public view returns (bool) {
        if (
            _row0 < 0 ||
            _row0 >= GRID_HEIGHT ||
            _col0 < 0 ||
            _col0 >= GRID_WIDTH ||
            _row1 < 0 ||
            _row1 >= GRID_HEIGHT ||
            _col1 < 0 ||
            _col1 >= GRID_WIDTH
        ) revert InvalidPosition();

        // Read once, thread through — see _isTileBlockedSafe's comment (G-03).
        uint256 bitmap = blockedTilesBitmap[_gameId];

        // Early checks - always check start and end
        if (_isTileBlockedSafe(bitmap, _row0, _col0)) {
            return false;
        }

        if (_row0 == _row1 && _col0 == _col1) {
            return !_isTileBlockedSafe(bitmap, _row1, _col1);
        }

        // Use Bresenham's algorithm for line of sight (always permissive mode)
        return _bresenhamMaps(bitmap, _row0, _col0, _row1, _col1);
    }

    /**
     * @dev Check if a ship can move from one point to another without its
     * path crossing an impassable tile — blocks landing ON an impassable
     * tile AND passing THROUGH one, via the same straight-line walk hasMaps
     * uses for line of sight (same permissive-corner rule, applied to the
     * impassable bitmap instead of the blocked one — one mental model, "an
     * unobstructed line," used for both shooting and moving). This is a
     * straight-line approximation, not full pathfinding: a ship can be
     * denied a destination a real detour could reach within its movement
     * budget, matching the abstraction level already accepted for LOS.
     *
     * Deliberately does NOT apply hasMaps' "start tile counts" rule — a ship
     * already legitimately standing on a tile must always be able to leave
     * it, even if that tile is later marked impassable (matches how blocked
     * tiles already behave for an already-occupied cell elsewhere).
     * @param _gameId The game ID
     * @param _row0 Starting row coordinate
     * @param _col0 Starting column coordinate
     * @param _row1 Ending row coordinate
     * @param _col1 Ending column coordinate
     * @return Whether the path (including the destination) is clear
     */
    function hasMovementPath(
        uint _gameId,
        int16 _row0,
        int16 _col0,
        int16 _row1,
        int16 _col1
    ) public view returns (bool) {
        if (
            _row0 < 0 ||
            _row0 >= GRID_HEIGHT ||
            _col0 < 0 ||
            _col0 >= GRID_WIDTH ||
            _row1 < 0 ||
            _row1 >= GRID_HEIGHT ||
            _col1 < 0 ||
            _col1 >= GRID_WIDTH
        ) revert InvalidPosition();

        if (_row0 == _row1 && _col0 == _col1) {
            return true; // already there; not a move
        }

        uint256 bitmap = impassableTilesBitmap[_gameId];
        // _isTileBlockedSafe is a generic "is this bit set in this bitmap"
        // helper (see its own comment) — reused here against the impassable
        // bitmap rather than the blocked one it's named for.
        return _bresenhamMaps(bitmap, _row0, _col0, _row1, _col1);
    }

    /**
     * @dev Like hasMovementPath, but ALSO blocks landing on or passing
     * through any tile in `_enemyOccupiedBitmap` — the CURRENT positions of
     * the acting ship's enemies for this game. Maps.sol has no ship-position
     * knowledge of its own (that lives in Game.sol's GameData), so the
     * caller builds this bitmap from live ship data and hands it in; a
     * single OR against the existing impassable bitmap costs nothing extra
     * here versus computing it once and reusing the same Bresenham walker.
     * Ally ships never block movement this way (matches the existing "any
     * ship blocks landing, only enemies block passing through" split) — the
     * caller is responsible for building the bitmap from only the enemy
     * side's ships.
     * @param _gameId The game ID
     * @param _row0 Starting row coordinate
     * @param _col0 Starting column coordinate
     * @param _row1 Ending row coordinate
     * @param _col1 Ending column coordinate
     * @param _enemyOccupiedBitmap Bit-per-cell mask (same packing as every
     *        other bitmap in this contract) of every enemy ship's tile
     * @return Whether the path (including the destination) is clear
     */
    function hasMovementPathAvoidingShips(
        uint _gameId,
        int16 _row0,
        int16 _col0,
        int16 _row1,
        int16 _col1,
        uint256 _enemyOccupiedBitmap
    ) external view returns (bool) {
        if (
            _row0 < 0 ||
            _row0 >= GRID_HEIGHT ||
            _col0 < 0 ||
            _col0 >= GRID_WIDTH ||
            _row1 < 0 ||
            _row1 >= GRID_HEIGHT ||
            _col1 < 0 ||
            _col1 >= GRID_WIDTH
        ) revert InvalidPosition();

        if (_row0 == _row1 && _col0 == _col1) {
            return true; // already there; not a move
        }

        uint256 bitmap = impassableTilesBitmap[_gameId] | _enemyOccupiedBitmap;
        return _bresenhamMaps(bitmap, _row0, _col0, _row1, _col1);
    }

    /**
     * @dev Like hasMaps, but ALSO blocks line of sight through any tile in
     * `_enemyOccupiedBitmap` — see hasMovementPathAvoidingShips for why
     * Maps.sol needs the bitmap handed to it and the ally/enemy split.
     *
     * The caller MUST exclude the shot's own target from this bitmap. Its
     * tile is the destination (_row1,_col1), and _bresenhamMaps' own
     * destination check already gates the return value on the destination
     * tile's blocked status — if the target's tile were included as
     * "blocked," every enemy ship would become unshootable beyond range 1,
     * since the destination would always fail that check. Terrain doesn't
     * have this problem (it's never "the thing being targeted"), which is
     * why hasMaps itself needs no such exclusion.
     * @param _gameId The game ID
     * @param _row0 Starting row coordinate
     * @param _col0 Starting column coordinate
     * @param _row1 Ending row coordinate (the target's own tile)
     * @param _col1 Ending column coordinate (the target's own tile)
     * @param _enemyOccupiedBitmap Bit-per-cell mask of every OTHER enemy
     *        ship's tile (not the one being shot at)
     * @return Whether there's a clear line of sight
     */
    function hasMapsAvoidingShips(
        uint _gameId,
        int16 _row0,
        int16 _col0,
        int16 _row1,
        int16 _col1,
        uint256 _enemyOccupiedBitmap
    ) external view returns (bool) {
        if (
            _row0 < 0 ||
            _row0 >= GRID_HEIGHT ||
            _col0 < 0 ||
            _col0 >= GRID_WIDTH ||
            _row1 < 0 ||
            _row1 >= GRID_HEIGHT ||
            _col1 < 0 ||
            _col1 >= GRID_WIDTH
        ) revert InvalidPosition();

        uint256 bitmap = blockedTilesBitmap[_gameId] | _enemyOccupiedBitmap;

        if (_isTileBlockedSafe(bitmap, _row0, _col0)) {
            return false;
        }

        if (_row0 == _row1 && _col0 == _col1) {
            return !_isTileBlockedSafe(bitmap, _row1, _col1);
        }

        return _bresenhamMaps(bitmap, _row0, _col0, _row1, _col1);
    }

    /**
     * @dev Internal function implementing Bresenham's line of sight algorithm
     * Uses permissive corner mode (only blocks if both flankers are blocked)
     * Optimized to avoid stack too deep errors
     */
    function _bresenhamMaps(
        uint256 _bitmap,
        int16 _row0,
        int16 _col0,
        int16 _row1,
        int16 _col1
    ) internal pure returns (bool) {
        // Calculate deltas and signs - minimize local variables
        int16 dRow = _row1 > _row0 ? _row1 - _row0 : _row0 - _row1;
        int16 dCol = _col1 > _col0 ? _col1 - _col0 : _col0 - _col1;
        int16 sRow = _row1 > _row0
            ? int16(1)
            : (_row1 < _row0 ? int16(-1) : int16(0));
        int16 sCol = _col1 > _col0
            ? int16(1)
            : (_col1 < _col0 ? int16(-1) : int16(0));

        // Initialize error term and current position
        int16 err = dCol - dRow;
        int16 row = _row0;
        int16 col = _col0;

        while (true) {
            // Check if we've reached the target
            if (row == _row1 && col == _col1) {
                return !_isTileBlockedSafe(_bitmap, row, col);
            }

            int16 e2 = err << 1;

            // Handle tie case (corner) - exclusive with other branches
            if (e2 == 0) {
                // Check flankers before moving
                if (
                    _isTileBlockedSafe(_bitmap, row, col + sCol) &&
                    _isTileBlockedSafe(_bitmap, row + sRow, col)
                ) {
                    return false;
                }

                // Advance diagonally
                col += sCol;
                err -= dRow;
                row += sRow;
                err += dCol;

                // Check new cell unless it's the target
                if (
                    (row != _row1 || col != _col1) &&
                    _isTileBlockedSafe(_bitmap, row, col)
                ) {
                    return false;
                }
                continue;
            }

            // Column step
            if (e2 > -dRow) {
                err -= dRow;
                col += sCol;
                if (
                    (row != _row1 || col != _col1) &&
                    _isTileBlockedSafe(_bitmap, row, col)
                ) {
                    return false;
                }
            }

            // Row step
            if (e2 < dCol) {
                err += dCol;
                row += sRow;
                if (
                    (row != _row1 || col != _col1) &&
                    _isTileBlockedSafe(_bitmap, row, col)
                ) {
                    return false;
                }
            }
        }
    }

    /**
     * @dev Get all blocked and scoring tiles for a specific game. Blocked
     * tiles are reconstructed from a single bitmask word (one SLOAD, no
     * per-tile storage reads) via _unpackBitmap's O(grid size) in-memory
     * scan; scoring tiles are O(configured tiles) via gameScoringPositionSet.
     * @param _gameId The game ID
     * @return blockedPositions Array of blocked (LOS-blocking) tile positions
     * @return scoringPositions Array of scoring tile positions
     * @return impassablePositions Array of impassable (movement-blocking)
     *         tile positions
     */
    function getGameMapState(
        uint _gameId
    )
        external
        view
        returns (
            Position[] memory blockedPositions,
            ScoringPosition[] memory scoringPositions,
            Position[] memory impassablePositions
        )
    {
        blockedPositions = _unpackBitmap(blockedTilesBitmap[_gameId]);
        scoringPositions = _getGameScoringPositions(_gameId);
        impassablePositions = _unpackBitmap(impassableTilesBitmap[_gameId]);
    }

    /**
     * @dev Scoring positions only, O(configured tiles) via
     * gameScoringPositionSet. For on-chain callers (round-end scoring,
     * Turtle-archetype AI decisions) that never use blockedPositions — they
     * shouldn't pay for computing it. Frontend/admin callers that also want
     * the blocked tiles should use getGameMapState instead.
     * @param _gameId The game ID
     * @return Array of scoring tile positions
     */
    function getGameScoringPositions(
        uint _gameId
    ) external view returns (ScoringPosition[] memory) {
        return _getGameScoringPositions(_gameId);
    }

    function _getGameScoringPositions(
        uint _gameId
    ) internal view returns (ScoringPosition[] memory scoringPositions) {
        EnumerableSet.UintSet storage packedPositions = gameScoringPositionSet[
            _gameId
        ];
        uint scoringCount = packedPositions.length();
        scoringPositions = new ScoringPosition[](scoringCount);
        for (uint i = 0; i < scoringCount; i++) {
            (int16 row, int16 col) = _unpackPosition(packedPositions.at(i));
            scoringPositions[i] = ScoringPosition(
                row,
                col,
                scoringTiles[_gameId][row][col],
                onlyOnceTiles[_gameId][row][col]
            );
        }
    }

    // ---- Deployment zones ----

    // Mirrors Fleets.sol's historical hardcoded default (creator col 0-3,
    // joiner col 13-16, row 0-10 — row is the whole grid height, so no
    // separate row constant is needed) — duplicated here so
    // isValidDeploymentTile can fall back to it when a map has no custom
    // zone, matching the existing GRID_WIDTH/GRID_HEIGHT duplication
    // precedent already between Maps.sol and Game.sol.
    int16 private constant DEFAULT_CREATOR_MIN_COL = 0;
    int16 private constant DEFAULT_CREATOR_MAX_COL = 3;
    int16 private constant DEFAULT_JOINER_MIN_COL = 13;
    int16 private constant DEFAULT_JOINER_MAX_COL = 16;

    /**
     * @dev Set (or full-replace) a preset map's creator-side deployment
     * zone. An empty array clears it back to "use the default."
     * @param _mapId The map ID
     * @param _tiles The set of tiles the creator's fleet may start on
     */
    function setCreatorZone(
        uint _mapId,
        Position[] calldata _tiles
    ) external onlyMapEditor {
        if (_mapId == 0 || _mapId > mapCount) revert MapNotFound();
        uint256 bitmap = 0;
        for (uint i = 0; i < _tiles.length; i++) {
            Position calldata pos = _tiles[i];
            if (
                pos.row < 0 ||
                pos.row >= GRID_HEIGHT ||
                pos.col < 0 ||
                pos.col >= GRID_WIDTH
            ) {
                revert InvalidPosition();
            }
            bitmap = _setBit(bitmap, _bitIndex(pos.row, pos.col));
        }
        presetCreatorZoneBitmap[_mapId] = bitmap;
        emit DeploymentZoneSet(_mapId, true);
    }

    /**
     * @dev Set (or full-replace) a preset map's joiner-side deployment zone.
     * @param _mapId The map ID
     * @param _tiles The set of tiles the joiner's fleet may start on
     */
    function setJoinerZone(
        uint _mapId,
        Position[] calldata _tiles
    ) external onlyMapEditor {
        if (_mapId == 0 || _mapId > mapCount) revert MapNotFound();
        uint256 bitmap = 0;
        for (uint i = 0; i < _tiles.length; i++) {
            Position calldata pos = _tiles[i];
            if (
                pos.row < 0 ||
                pos.row >= GRID_HEIGHT ||
                pos.col < 0 ||
                pos.col >= GRID_WIDTH
            ) {
                revert InvalidPosition();
            }
            bitmap = _setBit(bitmap, _bitIndex(pos.row, pos.col));
        }
        presetJoinerZoneBitmap[_mapId] = bitmap;
        emit DeploymentZoneSet(_mapId, false);
    }

    /**
     * @dev Whether (row,col) is a legal deployment tile for the given side
     * on the given map — called by Fleets.createFleet. If the map has no
     * custom zone configured for that side (bitmask unset), falls back to
     * the engine-wide default column band (the rule Fleets.sol enforced
     * unconditionally before this existed).
     * @param _mapId The map ID (Fleets.sol never calls this with 0 — that
     *        sentinel is handled entirely on its side, see setMapsAddress)
     * @param _row The row coordinate
     * @param _col The column coordinate
     * @param _isCreator Whether this is the creator's (vs. joiner's) side
     * @return Whether this tile is a legal deployment tile
     */
    function isValidDeploymentTile(
        uint _mapId,
        int16 _row,
        int16 _col,
        bool _isCreator
    ) public view returns (bool) {
        if (_mapId == 0 || _mapId > mapCount) revert MapNotFound();
        if (_row < 0 || _row >= GRID_HEIGHT || _col < 0 || _col >= GRID_WIDTH) {
            return false;
        }
        uint256 bitmap = _isCreator
            ? presetCreatorZoneBitmap[_mapId]
            : presetJoinerZoneBitmap[_mapId];
        if (bitmap != 0) {
            return _isBitSet(bitmap, _bitIndex(_row, _col));
        }
        // No custom zone: fall back to the default column band.
        return
            _isCreator
                ? (_col >= DEFAULT_CREATOR_MIN_COL &&
                    _col <= DEFAULT_CREATOR_MAX_COL)
                : (_col >= DEFAULT_JOINER_MIN_COL &&
                    _col <= DEFAULT_JOINER_MAX_COL);
    }

    /**
     * @dev Get a preset map's custom creator-zone tiles (empty if using the
     * default — see isValidDeploymentTile).
     * @param _mapId The map ID
     * @return Array of creator-zone positions
     */
    function getCreatorZonePositions(
        uint _mapId
    ) external view returns (Position[] memory) {
        if (_mapId == 0 || _mapId > mapCount) revert MapNotFound();
        return _unpackBitmap(presetCreatorZoneBitmap[_mapId]);
    }

    /**
     * @dev Get a preset map's custom joiner-zone tiles (empty if using the
     * default — see isValidDeploymentTile).
     * @param _mapId The map ID
     * @return Array of joiner-zone positions
     */
    function getJoinerZonePositions(
        uint _mapId
    ) external view returns (Position[] memory) {
        if (_mapId == 0 || _mapId > mapCount) revert MapNotFound();
        return _unpackBitmap(presetJoinerZoneBitmap[_mapId]);
    }
}

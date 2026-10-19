// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/access/Ownable.sol";
import "./Types.sol";
import "./Maps.sol";

// Admin-curated single-player AI encounters: a reusable ship-loadout
// registry (AIShipConfig, not tied to any minted NFT) plus a per-preset-map
// row/col -> configId placement mapping, so different Maps.sol preset maps
// can have distinct AI fleets instead of SinglePlayerMatch's old hardcoded
// 3-ship/fixed-column template. Mirrors Maps.sol's own idioms throughout
// (owner-or-editor gate, sequential small-int ids, bounds-checked writes)
// deliberately, since it's conceptually an extension of the map-authoring
// workflow. Does not import Ships/IShips — SinglePlayerMatch (which already
// holds a Ships reference) stays the only thing that mints, keeping this
// contract's dependency footprint minimal.
contract AIEncounters is Ownable {
    // Reusable AI ship loadout template. traits.serialNumber/traits.colors
    // are always ignored downstream (Ships._mintShip regenerates
    // serialNumber; colors only affect rendering) — leave them zero.
    struct AIShipConfig {
        uint id;
        string name;
        Equipment equipment;
        Traits traits; // accuracy/hull/speed must be 0-2; variant must be > 0
        Archetype archetype; // drives SinglePlayerMatch's takeAITurn rules
    }

    Maps public maps;

    mapping(uint => AIShipConfig) public aiShipConfigs;
    uint public aiShipConfigCount;

    // Addresses allowed to create/edit AI configs and placements (in
    // addition to the owner) — same pattern as Maps.isMapEditor.
    mapping(address => bool) public isEncounterEditor;

    // presetMapId => row => col => configId (0 = empty cell). The AI is
    // always the joiner, so a placement must be a tile of the map's joiner
    // deployment zone — the same Maps.isValidDeploymentTile check
    // Fleets.createFleet applies when the AI fleet is created. (Fixed
    // 2026-10-19: this used to hardcode the default joiner columns 13-16,
    // so a map with a custom joiner zone couldn't save placements in the
    // zone's other tiles.)
    mapping(uint => mapping(int16 => mapping(int16 => uint)))
        public mapPlacements;
    // presetMapId => occupied cells (row * GRID_WIDTH + col), and each
    // cell's 1-based index in that list. Lets clears and reads touch only
    // the occupied cells (at most maxPlacementsPerMap) instead of scanning
    // a zone that can now be anywhere on the grid.
    mapping(uint => uint16[]) private placedCells;
    mapping(uint => mapping(uint16 => uint)) private placedCellIndex;

    int16 public constant GRID_HEIGHT = 11;
    int16 public constant GRID_WIDTH = 17;
    // Owner-tunable rather than a fixed constant: this bounds how many AI
    // ships SinglePlayerMatch._mintAIFleet mints in one startNodeMatch
    // transaction (the whole fleet mints in a single loop, unlike
    // takeAITurn which is already one-ship-per-call), so it's a gas/pacing
    // knob, not a value anything else structurally depends on — the
    // default joiner zone (4 cols x 11 rows = 44 cells) supports far more
    // than the default of 8.
    uint public maxPlacementsPerMap = 8;

    error NotEncounterEditor();
    error InvalidTier();
    error InvalidVariant();
    error ConfigNotFound();
    error MapNotFound();
    error InvalidPosition();
    error TooManyPlacements();
    error ArrayLengthMismatch();

    event EncounterEditorSet(address indexed editor, bool allowed);
    event AIShipConfigCreated(uint indexed configId);
    event AIShipConfigUpdated(uint indexed configId);
    event MapPlacementSet(
        uint indexed mapId,
        int16 row,
        int16 col,
        uint configId
    );

    constructor(address _maps) Ownable(msg.sender) {
        maps = Maps(_maps);
    }

    /// @dev Restricts to the owner or an allowed encounter editor.
    modifier onlyEncounterEditor() {
        if (msg.sender != owner() && !isEncounterEditor[msg.sender])
            revert NotEncounterEditor();
        _;
    }

    function setMapsAddress(address _maps) external onlyOwner {
        maps = Maps(_maps);
    }

    /// @dev Tune the per-map AI fleet size cap — see maxPlacementsPerMap's
    /// declaration for why this is a gas/pacing knob, not a structural
    /// limit. Does not retroactively affect maps already at or above the
    /// old cap; only future setMapPlacement(s) calls see the new value.
    function setMaxPlacementsPerMap(uint _maxPlacementsPerMap) external onlyOwner {
        maxPlacementsPerMap = _maxPlacementsPerMap;
    }

    /**
     * @dev Grant or revoke encounter-editor rights (create/edit AI ship
     * configs and their map placements).
     * @param _editor The address to update
     * @param _allowed Whether the address may edit encounters
     */
    function setEncounterEditor(
        address _editor,
        bool _allowed
    ) external onlyOwner {
        isEncounterEditor[_editor] = _allowed;
        emit EncounterEditorSet(_editor, _allowed);
    }

    function createAIShipConfig(
        string calldata _name,
        Equipment calldata _equipment,
        Traits calldata _traits,
        Archetype _archetype
    ) external onlyEncounterEditor returns (uint configId) {
        _validateTraits(_traits);
        aiShipConfigCount++;
        configId = aiShipConfigCount;
        aiShipConfigs[configId] = AIShipConfig({
            id: configId,
            name: _name,
            equipment: _equipment,
            traits: _traits,
            archetype: _archetype
        });
        emit AIShipConfigCreated(configId);
    }

    function updateAIShipConfig(
        uint _configId,
        string calldata _name,
        Equipment calldata _equipment,
        Traits calldata _traits,
        Archetype _archetype
    ) external onlyEncounterEditor {
        if (_configId == 0 || _configId > aiShipConfigCount)
            revert ConfigNotFound();
        _validateTraits(_traits);
        aiShipConfigs[_configId] = AIShipConfig({
            id: _configId,
            name: _name,
            equipment: _equipment,
            traits: _traits,
            archetype: _archetype
        });
        emit AIShipConfigUpdated(_configId);
    }

    function _validateTraits(Traits calldata _traits) internal pure {
        if (_traits.accuracy > 2 || _traits.hull > 2 || _traits.speed > 2)
            revert InvalidTier();
        if (_traits.variant == 0) revert InvalidVariant();
    }

    function getAIShipConfig(
        uint _configId
    ) external view returns (AIShipConfig memory) {
        if (_configId == 0 || _configId > aiShipConfigCount)
            revert ConfigNotFound();
        return aiShipConfigs[_configId];
    }

    function getAllAIShipConfigs()
        external
        view
        returns (AIShipConfig[] memory configs)
    {
        configs = new AIShipConfig[](aiShipConfigCount);
        for (uint i = 0; i < aiShipConfigCount; i++) {
            configs[i] = aiShipConfigs[i + 1];
        }
    }

    // Bounded escape hatch for getAllAIShipConfigs (see docs/pre-audit.md
    // GR-02) — measured empirically to exceed Base's 30M block gas limit
    // somewhere between 800 and 1,000 configs (a real threshold at this
    // game's stated growth scale, not a distant hypothetical one), and
    // estimateGas fails outright past that point rather than merely costing
    // more. _offset is 0-indexed into the logical config sequence (offset 0
    // = configId 1); returns fewer than _limit entries (down to an empty
    // array) if the range runs past aiShipConfigCount, rather than
    // reverting.
    function getAIShipConfigsPaginated(
        uint _offset,
        uint _limit
    ) external view returns (AIShipConfig[] memory configs) {
        if (_offset >= aiShipConfigCount) return new AIShipConfig[](0);
        uint end = _offset + _limit;
        if (end > aiShipConfigCount) end = aiShipConfigCount;
        configs = new AIShipConfig[](end - _offset);
        for (uint i = _offset; i < end; i++) {
            configs[i - _offset] = aiShipConfigs[i + 1];
        }
    }

    /// @dev _configId == 0 clears the cell.
    function setMapPlacement(
        uint _mapId,
        int16 _row,
        int16 _col,
        uint _configId
    ) external onlyEncounterEditor {
        _setMapPlacementInternal(_mapId, _row, _col, _configId);
    }

    /// @dev Replaces the map's ENTIRE fleet deployment — this clears every
    /// existing placement first, then applies _positions/_configIds, so the
    /// caller (e.g. an admin fleet editor) can just send the new desired
    /// deployment wholesale without knowing what was there before or
    /// manually zeroing out removed slots. Pass an empty array to clear a
    /// map's fleet entirely.
    function setMapPlacements(
        uint _mapId,
        Position[] calldata _positions,
        uint[] calldata _configIds
    ) external onlyEncounterEditor {
        if (_positions.length != _configIds.length)
            revert ArrayLengthMismatch();
        _clearMapPlacements(_mapId);
        for (uint i = 0; i < _positions.length; i++) {
            _setMapPlacementInternal(
                _mapId,
                _positions[i].row,
                _positions[i].col,
                _configIds[i]
            );
        }
    }

    /// @dev Empties every placement on _mapId so setMapPlacements can give
    /// its input full-replace semantics.
    function _clearMapPlacements(uint _mapId) internal {
        uint16[] storage cells = placedCells[_mapId];
        for (uint i = 0; i < cells.length; i++) {
            uint16 cell = cells[i];
            int16 row = int16(cell / uint16(GRID_WIDTH));
            int16 col = int16(cell % uint16(GRID_WIDTH));
            mapPlacements[_mapId][row][col] = 0;
            delete placedCellIndex[_mapId][cell];
            emit MapPlacementSet(_mapId, row, col, 0);
        }
        delete placedCells[_mapId];
    }

    function _setMapPlacementInternal(
        uint _mapId,
        int16 _row,
        int16 _col,
        uint _configId
    ) internal {
        if (!maps.mapExists(_mapId)) revert MapNotFound();
        if (_row < 0 || _row >= GRID_HEIGHT || _col < 0 || _col >= GRID_WIDTH)
            revert InvalidPosition();
        // Only new placements need to be in the zone: clearing a cell must
        // still work after the map's zone is edited to exclude it.
        if (
            _configId != 0 &&
            !maps.isValidDeploymentTile(_mapId, _row, _col, false)
        ) revert InvalidPosition();
        if (_configId != 0 && _configId > aiShipConfigCount)
            revert ConfigNotFound();

        uint16 cell = uint16(_row) * uint16(GRID_WIDTH) + uint16(_col);
        uint existing = mapPlacements[_mapId][_row][_col];
        if (existing == 0 && _configId != 0) {
            if (placedCells[_mapId].length >= maxPlacementsPerMap)
                revert TooManyPlacements();
            placedCells[_mapId].push(cell);
            placedCellIndex[_mapId][cell] = placedCells[_mapId].length;
        } else if (existing != 0 && _configId == 0) {
            uint16[] storage cells = placedCells[_mapId];
            uint idx = placedCellIndex[_mapId][cell] - 1;
            uint16 last = cells[cells.length - 1];
            cells[idx] = last;
            placedCellIndex[_mapId][last] = idx + 1;
            cells.pop();
            delete placedCellIndex[_mapId][cell];
        }

        mapPlacements[_mapId][_row][_col] = _configId;
        emit MapPlacementSet(_mapId, _row, _col, _configId);
    }

    /// @dev Returned in row-major order (row, then col), as before the
    /// 2026-10-19 change — the AI fleet's ship order follows it.
    function getMapPlacements(
        uint _mapId
    ) external view returns (Position[] memory positions, uint[] memory configIds) {
        uint16[] memory cells = placedCells[_mapId];
        // Insertion sort: at most maxPlacementsPerMap cells.
        for (uint i = 1; i < cells.length; i++) {
            uint16 c = cells[i];
            uint j = i;
            while (j > 0 && cells[j - 1] > c) {
                cells[j] = cells[j - 1];
                j--;
            }
            cells[j] = c;
        }
        positions = new Position[](cells.length);
        configIds = new uint[](cells.length);
        for (uint i = 0; i < cells.length; i++) {
            int16 row = int16(cells[i] / uint16(GRID_WIDTH));
            int16 col = int16(cells[i] % uint16(GRID_WIDTH));
            positions[i] = Position({row: row, col: col});
            configIds[i] = mapPlacements[_mapId][row][col];
        }
    }

    /// @dev Number of occupied placement cells on _mapId.
    function mapPlacementCount(uint _mapId) public view returns (uint) {
        return placedCells[_mapId].length;
    }

    function mapHasPlacements(uint _mapId) external view returns (bool) {
        return placedCells[_mapId].length > 0;
    }
}

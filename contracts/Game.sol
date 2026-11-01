// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/access/Ownable.sol";
// import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import "./Types.sol";
import "./IShips.sol";
import "./IFleets.sol";
import "./IShipAttributes.sol";
import "./IMaps.sol";
import "./IGameOrchestrator.sol";
import "./SpecialEffectsLib.sol";

contract Game is Ownable {
    IShips public ships;
    IFleets public fleets;
    IShipAttributes public shipAttributes;
    IMaps public maps;

    // Contracts (e.g. PvPMatch) authorized to call startGame/forceEndSession,
    // mirroring Ships.isAllowedToCreateShips. Each session records which
    // authorized contract started it (GameMetadata.orchestrator), which is
    // who this contract calls back into (IGameOrchestrator.onGameEnded) and
    // who alone may force that session to end early (forceEndSession) — this
    // is how PvP-specific concerns (a PvP leaderboard, human forfeit/timeout)
    // stay out of core Game.sol while other modes (e.g. single-player) can
    // each be authorized independently.
    mapping(address => bool) public isAllowedToStartGames;

    // Owner-authorized resolver contract for each faction's (traits.variant)
    // innate ability, dispatched via ActionType.FactionAbility — independent
    // of equipment.special/ActionType.Special entirely. See
    // IEffectResolver — the resolver owns all pre-dispatch checks
    // for its ability and Game.sol just applies whatever it returns. One
    // ability per faction (not per-slot like specialResolvers below) — each
    // new faction gets its own resolver contract and its own entry here,
    // with no upper bound other than uint16's range.
    mapping(uint16 => address) public factionAbilityResolvers;

    // Owner-authorized resolver contract for each equipped Special item,
    // dispatched via ActionType.Special — keyed by BOTH traits.variant and
    // equipment.special, since Special is a per-faction local slot (0-7),
    // not a global item identity: slot 1 means something different for
    // every faction, so the same slot number needs a different resolver
    // per variant. Same IEffectResolver contract and
    // SpecialEffectsLib.resolveAndApply dispatch as factionAbilityResolvers;
    // this is what lets new factions ship a custom Special without touching
    // Game.sol's bytecode.
    mapping(uint16 => mapping(Special => address)) public specialResolvers;

    // Highest Special slot that's real for the variant — set explicitly via
    // setMaxSpecialSlot below, NOT derived from specialResolvers. A slot can
    // be real without a resolver entry (e.g. variant 2's Slot3
    // AdditionalThruster is a passive read straight out of
    // ShipAttributes.calculateShipAttributes, never dispatched through
    // _performSpecial at all), so "has a resolver" is not a safe proxy for
    // "is a real slot" and must not be used to auto-derive this. Read
    // externally (via IGameView) by GenerateNewShip (constrains the random
    // roll to only real slots) and DroneYard (rejects customizing a ship
    // onto an inert slot). ASSUMES every variant's real slots are
    // contiguous from Slot1 upward (matches every faction shipped so far).
    // Whoever adds a new special (active or passive) for a variant MUST
    // also call setMaxSpecialSlot if it raises the variant's max — nothing
    // enforces that automatically.
    mapping(uint16 => uint8) public maxSpecialSlot;

    // Ceiling on how high any heal effect (RepairDrones, faction Repair,
    // etc.) can raise a ship's HP, as a percent of maxHullPoints — applies
    // globally, across every mode (PvP/campaign/roguelike alike), since
    // SpecialEffectsLib's hull-delta application has no per-mode context
    // to key a narrower cap off of. Damage is unaffected; a ship already
    // above this ceiling when it's lowered is left alone, not healed down
    // to it (see SpecialEffectsLib._applyHullDelta). Defaults to 80
    // (2026-10-05 design decision: no heal can raise a ship above 80% of
    // max — matched by the roguelike's campaign auto-heal floor, also 80).
    uint8 public healCapPercent = 80;

    mapping(uint => GameData) games;
    uint public gameCount;

    mapping(address => uint[]) public playerGames;


    // Grid constants
    int16 public constant GRID_WIDTH = 17; // Number of columns
    int16 public constant GRID_HEIGHT = 11; // Number of rows

    // creator/joiner indexed (2026-10-08) so a client can discover its own
    // games with a topic-filtered log query/subscription; lobbyId gave up
    // its index for them (3-indexed-topic limit) — a node-match gameId has
    // no lobby anyway, and a PvP gameId == its lobbyId.
    event GameStarted(
        uint indexed gameId,
        uint lobbyId,
        address indexed creator,
        address indexed joiner
    );

    event GameUpdate(uint indexed gameId);
    event Move(
        uint indexed gameId,
        uint shipId,
        int16 oldRow,
        int16 oldCol,
        int16 newRow,
        int16 newCol,
        ActionType actionType,
        uint targetShipId
    );

    error NotAllowedToStartGames();
    error NotOrchestrator();
    error GameNotFound();
    error ShipNotFound();
    error ShipNotOwned();
    error ShipAlreadyMoved();
    error InvalidMove();
    error InvalidHealCapPercent();
    error ShipDestroyed();
    error GameAlreadyExists();
    error EngineAlreadyLive();

    constructor(address _ships, address _shipAttributes) Ownable(msg.sender) {
        ships = IShips(_ships);
        shipAttributes = IShipAttributes(_shipAttributes);
    }

    // UA-01 fix (2026-09-29): once this engine has ever started a game,
    // maps/fleets/shipAttributes/ships can never be repointed again. These
    // four are read live, fresh from storage, by every active game's every
    // turn (moveShip's whole call tree) — they were never meant to be a
    // live post-launch knob, only deploy-time wiring (Fleets/Maps are
    // deployed AFTER Game in DeployAndConfig.ts, so they can't be
    // constructor args; this setter exists purely to close that ordering
    // gap once, right after deploy). Under this project's engine-registry
    // architecture, a genuine rules/infra change always gets a brand-new
    // engine (a fresh Game.sol), never a re-pointed live one — repointing
    // any of these on a live engine would instantly break every one of its
    // active games (a swapped Maps/Fleets/Ships instance has no record of
    // an already-placed ship, fleet, or map for this engine's games, so
    // moveShip/Shoot start reverting or misbehaving for everyone already
    // mid-match). See docs/upgrade-safety-audit-2026-09-29.md UA-01.
    function setAddresses(
        address _mapsAddress,
        address _fleetsAddress,
        address _shipAttributesAddress,
        address _shipsAddress
    ) public onlyOwner {
        if (gameCount > 0) revert EngineAlreadyLive();
        maps = IMaps(_mapsAddress);
        fleets = IFleets(_fleetsAddress);
        shipAttributes = IShipAttributes(_shipAttributesAddress);
        ships = IShips(_shipsAddress);
    }

    function setIsAllowedToStartGames(
        address _address,
        bool _isAllowed
    ) public onlyOwner {
        isAllowedToStartGames[_address] = _isAllowed;
    }

    // UA-07 fix (2026-09-29): locked once this engine is live, same as
    // setAddresses (UA-01) — both resolver mappings are read live at
    // dispatch time (_performSpecial/_performFactionAbility), with no
    // per-game pin, so retuning either on an already-active engine would
    // change behavior for every game in progress, not just future ones.
    // Per-game pinning (the alternative this project already uses for ship
    // attributes) isn't practical here — resolvers span an open-ended,
    // owner-configured (variant, slot) space with no cheap way to snapshot
    // "every configured entry" at startGame, and Game.sol has almost no
    // bytecode headroom left to spare for trying. A genuine resolver
    // retune belongs in a brand-new engine instead, exactly like any other
    // rules change. See docs/upgrade-safety-audit-2026-09-29.md UA-07.
    function setFactionAbilityResolver(
        uint16 _variant,
        address _resolver
    ) public onlyOwner {
        if (gameCount > 0) revert EngineAlreadyLive();
        factionAbilityResolvers[_variant] = _resolver;
    }

    function setSpecialResolver(
        uint16 _variant,
        Special _slot,
        address _resolver
    ) public onlyOwner {
        if (gameCount > 0) revert EngineAlreadyLive();
        specialResolvers[_variant][_slot] = _resolver;
    }

    // Deliberately separate from setSpecialResolver (see maxSpecialSlot's own
    // comment) — a passive special with no resolver (e.g. variant 2's Slot3)
    // still needs this raised explicitly.
    function setMaxSpecialSlot(uint16 _variant, Special _slot) public onlyOwner {
        maxSpecialSlot[_variant] = uint8(_slot);
    }

    function setHealCapPercent(uint8 _percent) public onlyOwner {
        if (_percent > 100) revert InvalidHealCapPercent();
        healCapPercent = _percent;
    }

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
        if (!isAllowedToStartGames[msg.sender]) revert NotAllowedToStartGames();

        // Game id is the lobby id: each lobby starts at most one game, so the
        // lobby id is a unique key for the game. `gameCount` is kept only as a
        // tally of games started (no longer the id source).
        uint gameId = _lobbyId;
        if (games[gameId].metadata.gameId != 0) revert GameAlreadyExists();
        gameCount++;
        GameData storage game = games[gameId];

        // Initialize metadata
        game.metadata.gameId = gameId;
        game.metadata.lobbyId = _lobbyId;
        game.metadata.orchestrator = msg.sender;
        game.metadata.creator = _creator;
        game.metadata.joiner = _joiner;
        game.metadata.creatorFleetId = _creatorFleetId;
        game.metadata.joinerFleetId = _joinerFleetId;
        game.metadata.creatorGoesFirst = _creatorGoesFirst;
        game.metadata.startedAt = block.timestamp;

        // Initialize turn state
        game.turnState.currentTurn = _creatorGoesFirst ? _creator : _joiner;
        game.turnState.turnTime = _turnTime;
        game.turnState.turnStartTime = block.timestamp;
        game.turnState.currentRound = 1;

        // Initialize grid dimensions
        game.gridDimensions.gridWidth = GRID_WIDTH; // Number of columns
        game.gridDimensions.gridHeight = GRID_HEIGHT; // Number of rows

        // Set max score for the game
        game.maxScore = _maxScore;

        // UA-06 fix (2026-09-29): pin this game's heal cap for its whole
        // duration — mirroring the version-pinning pattern ShipAttributes
        // already uses. Read directly off GameData by SpecialEffectsLib
        // (not passed as a separate parameter — Game.sol's own
        // _dispatchEffects has too little stack headroom left to spare an
        // extra local here, see docs/upgrade-safety-audit-2026-09-29.md
        // UA-06) instead of the live healCapPercent above, so changing the
        // live value mid-game can't retroactively change an already-active
        // game's heal cap.
        game.healCapPercentAtStart = healCapPercent;

        // Apply the selected preset map to this game if a map was selected
        if (_selectedMapId > 0) {
            maps.applyPresetMapToGame(gameId, _selectedMapId);
        }

        // Calculate fleet attributes and place ships on grid
        _initializeFleetAttributes(gameId, _creatorFleetId, _joinerFleetId);
        _placeShipsOnGrid(gameId, _creatorFleetId, _joinerFleetId);

        GameData storage gameAfterPlace = games[gameId];
        gameAfterPlace.totalActiveShipsAtRoundStart =
            gameAfterPlace.creatorActive.length +
            gameAfterPlace.joinerActive.length;

        // Track game for both players
        playerGames[_creator].push(gameId);
        playerGames[_joiner].push(gameId);

        emit GameStarted(gameId, _lobbyId, _creator, _joiner);
    }

    // Internal function to initialize fleet attributes
    function _initializeFleetAttributes(
        uint _gameId,
        uint _creatorFleetId,
        uint _joinerFleetId
    ) internal {
        GameData storage game = games[_gameId];
        // Creator/joiner sides were two copy-pasted loops — merged into one
        // shared helper called per side (G-04 headroom fix), same behavior.
        _registerFleetShips(_gameId, game.metadata.creator, _creatorFleetId);
        _registerFleetShips(_gameId, game.metadata.joiner, _joinerFleetId);
    }

    // Shared body for _initializeFleetAttributes' two per-side loops: store
    // this player's fleet ship IDs and calculate their attributes.
    function _registerFleetShips(
        uint _gameId,
        address _player,
        uint _fleetId
    ) private {
        GameData storage game = games[_gameId];
        (uint[] memory shipIds, ) = fleets.getFleetShipIdsAndPositions(
            _fleetId
        );
        bool isCreator = _player == game.metadata.creator;
        uint64[] storage active = _activeOf(game, _player);
        // The whole fleet's stats, variants and specials in one call
        // (2026-10-31; was one call per ship). Reverts ShipNotFound for a
        // missing ship.
        (
            Attributes[] memory stats,
            uint16[] memory variants,
            Special[] memory specials
        ) = shipAttributes.calculateBoardStatsByIds(shipIds);
        for (uint i = 0; i < shipIds.length; i++) {
            // SafeCast-free: ship ids are far below 2^64 (AIShips' start
            // at 2^40); Fleets already stores them as uint64.
            active.push(uint64(shipIds[i]));
            ShipBoardState storage b = game.shipBoard[shipIds[i]];
            b.activeIndex = uint8(active.length);
            b.isCreator = isCreator;
            _storeShipAttributes(b, stats[i], variants[i], specials[i]);
        }
    }

    // A player's side's active list. Only ever called with the game's
    // creator or joiner.
    function _activeOf(
        GameData storage game,
        address _player
    ) private view returns (uint64[] storage) {
        return
            _player == game.metadata.creator
                ? game.creatorActive
                : game.joinerActive;
    }

    // Internal function to place ships on the grid
    function _placeShipsOnGrid(
        uint _gameId,
        uint _creatorFleetId,
        uint _joinerFleetId
    ) internal {
        // Creator/joiner sides were two copy-pasted loops — merged into one
        // shared helper called per side (G-04 headroom fix), same behavior.
        _placeFleetShipsOnGrid(_gameId, _creatorFleetId);
        _placeFleetShipsOnGrid(_gameId, _joinerFleetId);
    }

    // Shared body for _placeShipsOnGrid's two per-side loops: place this
    // fleet's ships at their specified starting positions.
    function _placeFleetShipsOnGrid(uint _gameId, uint _fleetId) private {
        (
            uint[] memory shipIds,
            Position[] memory positions
        ) = fleets.getFleetShipIdsAndPositions(_fleetId);

        for (uint i = 0; i < shipIds.length; i++) {
            Position memory pos = positions[i];
            _placeShipOnGrid(_gameId, shipIds[i], pos.row, pos.col);
        }
    }

    // Internal function to place a single ship on the grid
    function _placeShipOnGrid(
        uint _gameId,
        uint _shipId,
        int16 _row,
        int16 _column
    ) internal {
        GameData storage game = games[_gameId];

        // Validate bounds and vacancy. Lower-bound checks matter here: _row/_column
        // are int16, and without them a negative value passes the upper-bound-only
        // check and indexes an unintended (but validly-addressable) negative grid slot.
        if (
            _row < 0 ||
            _column < 0 ||
            _row >= GRID_HEIGHT ||
            _column >= GRID_WIDTH ||
            game.occupied & _cellBit(_row, _column) != 0
        ) revert InvalidMove();

        // Place ship on grid at specified row and column
        game.occupied |= _cellBit(_row, _column);
        // Initialize ship board position as alive at this location
        // Field by field: _registerFleetShips has already written this
        // ship's side, list index and stats into the same slot.
        ShipBoardState storage b = game.shipBoard[_shipId];
        b.row = _row;
        b.col = _column;
        b.placed = true;
        game.live[b.isCreator ? 0 : 1] |= _cellBit(_row, _column);
    }

    // Calculate and store attributes for a ship in a game. Private: only
    // startGame (via _registerFleetShips) may snapshot — a public version let
    // anyone pre-write (nextGameId, shipId) before start, making startGame hit
    // the guard below and revert forever (docs/audit-3.md HA6-01). The write is
    // snapshot-once: `attributes.version` is 0 only
    // until the first calculation. ShipAttributes versions are per variant and
    // start at 1 on first publish (a rollback can't reach 0 either), so a
    // non-zero version reliably means "already set for this game." That stored
    // version is also the game's pin: special resolvers read special data at it
    // (ShipAttributes.getSpecialRangeAt/StrengthAt). Now that nothing external
    // can reach this, the guard is defense in depth: a re-snapshot would pull
    // in a newer ShipAttributes version, silently breaking the start-of-game pin.
    function _storeShipAttributes(
        ShipBoardState storage attributes,
        Attributes memory calculatedAttributes,
        uint16 variant,
        Special special
    ) private {
        if (attributes.version != 0) revert InvalidMove(); // already calculated for this game

        // The ship's variant and special go on the board too (see ShipBoardState)
        attributes.variant = variant;
        attributes.special = special;

        // Copy the calculated attributes to game storage
        attributes.version = calculatedAttributes.version;
        attributes.range = calculatedAttributes.range;
        attributes.gunDamage = calculatedAttributes.gunDamage;
        attributes.hullPoints = calculatedAttributes.hullPoints;
        attributes.maxHullPoints = calculatedAttributes.maxHullPoints;
        attributes.movement = calculatedAttributes.movement;
        attributes.damageReduction = calculatedAttributes.damageReduction;
    }

    // Lets a game's orchestrator seed a ship's hull points below the fresh
    // 100% _storeShipAttributes just set, for orchestrators that carry
    // persistent damage across matches (e.g. a roguelike run's fleet).
    // Same orchestrator-identity check forceEndSession already uses — every
    // existing orchestrator (Lobbies/PvPMatch/SinglePlayerMatch/Tournament)
    // simply never calls this, so it changes nothing for them.
    function setInitialHullPointsOverride(
        uint _gameId,
        uint _shipId,
        uint8 _hullPoints
    ) external {
        GameData storage game = games[_gameId];
        if (msg.sender != game.metadata.orchestrator) revert NotOrchestrator();
        ShipBoardState storage attributes = game.shipBoard[_shipId];
        if (attributes.version == 0) revert ShipNotFound();
        // Never 0: a seeded 0 HP ship would skip shipsWithZeroHP and the
        // live bitmaps' bookkeeping (RoguelikeMatch never seeds 0).
        if (_hullPoints == 0 || _hullPoints > attributes.maxHullPoints) revert InvalidMove();
        attributes.hullPoints = _hullPoints;
    }

    // Get ship attributes for a specific game
    function getShipAttributes(
        uint _gameId,
        uint _shipId
    ) public view returns (Attributes memory) {
        _requireGameExists(_gameId);
        ShipBoardState storage attributes = games[_gameId].shipBoard[_shipId];
        if (attributes.version == 0) revert ShipNotFound();
        return _attributesOf(attributes);
    }

    function _attributesOf(
        ShipBoardState storage _b
    ) private view returns (Attributes memory) {
        return
            Attributes(
                _b.version,
                _b.range,
                _b.gunDamage,
                _b.hullPoints,
                _b.maxHullPoints,
                _b.movement,
                _b.damageReduction,
                _b.reactorCriticalTimer
            );
    }

    // Get a single ship's position/side/status in O(1) — unlike
    // getAllShipPositions, this doesn't scan the grid, so resolvers (e.g.
    // RamResolver) that only need one or two ships' positions should use
    // this instead.
    function getShipPosition(
        uint _gameId,
        uint _shipId
    ) external view returns (ShipPosition memory) {
        _requireGameExists(_gameId);
        ShipBoardState storage b = games[_gameId].shipBoard[_shipId];
        // shipId 0 for a ship never placed in this game, as before packing.
        return
            ShipPosition({
                shipId: b.placed ? _shipId : 0,
                position: _boardPosition(b),
                isCreator: b.isCreator,
                status: b.status
            });
    }

    function _boardPosition(
        ShipBoardState storage _b
    ) private view returns (Position memory) {
        return Position(_b.row, _b.col);
    }

    // The board for an AI turn, flat (2026-10-31; two words per ship
    // instead of an AIView's ~14 to encode and decode). A 7-word header,
    // [occupied, creatorLive, joinerLive, currentRound, ended,
    // currentTurn, creator], then an id and raw ShipBoardState word for
    // each active ship, creator side first, matching getGame's order.
    // AIBehavior.turnState and unpackBoard read it; the AI orchestrators
    // fetch it once per AI move.
    function getAIBoard(uint _gameId) external view returns (uint[] memory out) {
        _requireGameExists(_gameId);
        GameData storage game = games[_gameId];
        uint creatorCount = game.creatorActive.length;
        uint total = creatorCount + game.joinerActive.length;
        out = new uint[](7 + 2 * total);
        out[0] = game.occupied;
        out[1] = game.live[0];
        out[2] = game.live[1];
        out[3] = game.turnState.currentRound;
        out[4] = game.metadata.ended ? 1 : 0;
        out[5] = uint160(game.turnState.currentTurn);
        out[6] = uint160(game.metadata.creator);
        for (uint i = 0; i < total; i++) {
            uint id = i < creatorCount
                ? game.creatorActive[i]
                : game.joinerActive[i - creatorCount];
            ShipBoardState storage b = game.shipBoard[id];
            uint word;
            assembly {
                word := sload(b.slot)
            }
            out[7 + 2 * i] = id;
            out[8 + 2 * i] = word;
        }
    }

    // Used by getGame: the active ships' ids, stats and
    // positions, creator side first.
    function _activeView(
        GameData storage game
    ) private view returns (AIView memory v) {
        uint creatorCount = game.creatorActive.length;
        uint total = creatorCount + game.joinerActive.length;
        v.shipIds = new uint[](total);
        v.shipAttributes = new Attributes[](total);
        v.shipPositions = new ShipPosition[](total);
        for (uint i = 0; i < total; i++) {
            uint id = i < creatorCount
                ? game.creatorActive[i]
                : game.joinerActive[i - creatorCount];
            ShipBoardState storage b = game.shipBoard[id];
            v.shipIds[i] = id;
            v.shipAttributes[i] = _attributesOf(b);
            v.shipPositions[i] = ShipPosition(id, _boardPosition(b), b.isCreator, b.status);
        }
    }

    // Get all ship positions for a game
    // External view, memory use ok
    //
    // Reads active ships from the active lists + shipPositions instead of
    // scanning the grid: both are already kept in lockstep with the grid on
    // every move (moveShip) and every removal
    // (_removeShipFromGame atomically clears a ship from the grid AND from
    // the active lists), so a ship in the active lists is guaranteed
    // alive and exactly where shipPositions says it is. That makes an O(grid
    // size) scan with a per-cell ships.isShipDestroyed call redundant — this
    // is now O(active ship count), matching the gone-ships loop below, which
    // already read from shipPositions directly.
    function getAllShipPositions(
        uint _gameId
    ) public view returns (ShipPosition[] memory) {
        _requireGameExists(_gameId);
        GameData storage game = games[_gameId];

        uint64[] storage creatorShipIds = game.creatorActive;
        uint64[] storage joinerShipIds = game.joinerActive;

        ShipPosition[] memory positions = new ShipPosition[](
            creatorShipIds.length +
                joinerShipIds.length +
                game.goneShipIds.length
        );
        uint index = _fillActiveShipPositions(
            game,
            positions,
            0,
            creatorShipIds,
            true
        );
        index = _fillActiveShipPositions(
            game,
            positions,
            index,
            joinerShipIds,
            false
        );

        // Iterate through gone ship ids (destroyed or fled; status from storage)
        for (uint i = 0; i < game.goneShipIds.length; i++) {
            uint shipId = game.goneShipIds[i];
            ShipBoardState storage sp = game.shipBoard[shipId];
            // isCreator from the board slot: a gone ship has left
            // the active lists, so the old set lookup reported false
            // for every gone creator ship (fixed 2026-10-30).
            positions[index] = ShipPosition({
                shipId: shipId,
                position: _boardPosition(sp),
                isCreator: sp.isCreator,
                status: sp.status
            });
            index++;
        }

        return positions;
    }

    // Shared body for getAllShipPositions' two active-side loops (creator
    // and joiner), since they're otherwise identical apart from which set
    // they read and the isCreator flag they stamp on each entry.
    function _fillActiveShipPositions(
        GameData storage game,
        ShipPosition[] memory positions,
        uint startIndex,
        uint64[] storage shipIds,
        bool isCreator
    ) private view returns (uint) {
        uint count = shipIds.length;
        for (uint i = 0; i < count; i++) {
            uint shipId = shipIds[i];
            positions[startIndex] = ShipPosition({
                shipId: shipId,
                position: _boardPosition(game.shipBoard[shipId]),
                isCreator: isCreator,
                status: 0
            });
            startIndex++;
        }
        return startIndex;
    }

    // Helper functions to consolidate fleet iteration logic

    // Whether a player has any ship on the board with HP > 0: a nonempty
    // live bitmap (2026-10-31; was a loop over the active list with a
    // Ships.isShipDestroyed call per ship, which can never be true for a
    // ship still on the board).
    function _playerHasActiveShips(
        uint _gameId,
        address _player
    ) internal view returns (bool) {
        GameData storage game = games[_gameId];
        return game.live[_player == game.metadata.creator ? 0 : 1] != 0;
    }

    // Helper function to check if the game should end due to a player having no active ships
    function _checkGameEndCondition(uint _gameId) internal {
        GameData storage game = games[_gameId];
        address creator = game.metadata.creator;
        address joiner = game.metadata.joiner;
        bool creatorActive = _playerHasActiveShips(_gameId, creator);
        bool joinerActive = _playerHasActiveShips(_gameId, joiner);

        // Neither side has an active ship (e.g. friendly fire or a swarm
        // disabled both at once): decide by score, like the score threshold
        // — the creator used to lose automatically just for being checked
        // first (docs/audit-3.md HA6-26).
        if (!creatorActive && !joinerActive) {
            _endGameByScore(_gameId, game);
        } else if (!creatorActive) {
            _endGame(_gameId, joiner, creator);
        } else if (!joinerActive) {
            _endGame(_gameId, creator, joiner);
        }
    }

    // Higher score wins; a tie is a draw.
    function _endGameByScore(uint _gameId, GameData storage game) private {
        if (game.creatorScore == game.joinerScore) {
            _endGame(_gameId, address(0), address(0));
        } else if (game.creatorScore > game.joinerScore) {
            _endGame(_gameId, game.metadata.creator, game.metadata.joiner);
        } else {
            _endGame(_gameId, game.metadata.joiner, game.metadata.creator);
        }
    }

    // Helper function to end the game and notify the orchestrator
    function _endGame(uint _gameId, address _winner, address _loser) internal {
        GameData storage game = games[_gameId];
        // A single moveShip call can trigger this twice (a kill emptying a
        // player's active ships, then a score threshold at the same round's
        // end) — no-op on the second call rather than overwrite the winner
        // and double-fire the orchestrator callback (see docs/pre-audit.md
        // L-08).
        if (game.metadata.ended) return;
        game.metadata.winner = _winner;
        game.metadata.ended = true;
        // Let whichever contract started this session (e.g. PvPMatch) decide
        // what "ended" means for it (PvP: record to a leaderboard; other
        // modes: whatever they need) — called even on a draw (_winner ==
        // address(0)) so that decision isn't made here in core Game.sol.
        if (game.metadata.orchestrator != address(0)) {
            IGameOrchestrator(game.metadata.orchestrator).onGameEnded(
                _gameId,
                _winner,
                _loser
            );
        }
        // Remove all ships from fleets when game ends
        _removeShipsFromFleet(game.metadata.creatorFleetId);
        _removeShipsFromFleet(game.metadata.joinerFleetId);
    }

    // Move then perform action. Landing on an occupied cell is never valid
    // for a plain move — ramming is now the Ram special (resolver-backed,
    // faction 1 only), not an automatic side effect of movement.
    function moveShip(
        uint _gameId,
        uint _shipId,
        int16 _newRow,
        int16 _newCol,
        ActionType actionType,
        uint targetShipId
    ) external {
        _requireGameExists(_gameId);
        GameData storage game = games[_gameId];

        // Check if game has ended (see GameMetadata.ended in Types.sol for why
        // this can't just check winner != address(0): a draw also leaves winner
        // at address(0), so that check would wrongly allow moves after a draw)
        if (game.metadata.ended) revert InvalidMove();

        // Check if it's the player's turn
        if (msg.sender != game.turnState.currentTurn) revert InvalidMove();

        // In this game and still on the board.
        ShipBoardState storage shipAttrs = game.shipBoard[_shipId];
        _requireOnBoard(shipAttrs);
        // Owned by the current player. No Ships read (2026-10-31): a fleet
        // ship's owner is its side's player for the whole game, since
        // Fleets checks ownership at creation and Ships blocks transfers
        // while a ship is inFleet.
        if (shipAttrs.isCreator != (msg.sender == game.metadata.creator))
            revert ShipNotOwned();

        // Check if ship has 0 hull points (Retreat allowed for 0 HP)
        if (actionType != ActionType.Retreat && shipAttrs.hullPoints == 0)
            revert ShipDestroyed();

        // Check if ship has already moved this round (Retreat allowed even if already moved)
        if (
            actionType != ActionType.Retreat && _hasMoved(game, _shipId)
        ) revert ShipAlreadyMoved();

        // Get current position
        ShipBoardState storage shipPos = game.shipBoard[_shipId];

        // Capture old position values before any updates
        int16 oldRow = shipPos.row;
        int16 oldCol = shipPos.col;

        if (actionType != ActionType.Retreat) {
            // Allow moving to the current position (no-op move), skip movement validation and position occupied check

            if (!(shipPos.row == _newRow && shipPos.col == _newCol)) {
                _validateAndApplyMovement(
                    game,
                    _gameId,
                    _shipId,
                    oldRow,
                    oldCol,
                    _newRow,
                    _newCol
                );
            }

            // Not already moved: checked above for every non-Retreat action.
            shipPos.movedInRound = uint24(game.turnState.currentRound);
            game.movedTotal++;
        }

        _performAction(
            game,
            _gameId,
            _shipId,
            _newRow,
            _newCol,
            actionType,
            targetShipId
        );

        // Skip round handling if this move's action already ended the game:
        // _endGame cleared both fleets, so a round-start reactor tick
        // removing another ship would revert ShipNotFound and unwind the
        // whole (game-ending) move (docs/audit-3.md HA6-02).
        if (!game.metadata.ended) {
            // Check if both players have moved all their ships (round complete)
            if (_checkRoundComplete(_gameId)) {
                _handleEndOfRound(_gameId);
            } else {
                // Switch turns only if the other player has unmoved ships
                _switchTurnIfOtherPlayerHasShips(_gameId);
            }
        }

        // Update turn start time for the new turn
        game.turnState.turnStartTime = block.timestamp;

        // Store the move data in the game struct (Retreat: new position is -1,-1)
        // Ids come from Fleets' 64-bit storage, so the casts are lossless.
        game.lastMove = LastMoveRecord({
            shipId: uint64(_shipId),
            oldRow: oldRow,
            oldCol: oldCol,
            newRow: actionType == ActionType.Retreat ? int16(-1) : _newRow,
            newCol: actionType == ActionType.Retreat ? int16(-1) : _newCol,
            actionType: actionType,
            targetShipId: uint64(targetShipId),
            timestamp: uint40(block.timestamp)
        });

        // Emit event to notify clients of game state change
        emit Move(
            _gameId,
            _shipId,
            oldRow,
            oldCol,
            actionType == ActionType.Retreat ? int16(-1) : _newRow,
            actionType == ActionType.Retreat ? int16(-1) : _newCol,
            actionType,
            targetShipId
        );
        emit GameUpdate(_gameId);
    }

    // Validates a plain (non-Retreat, non-no-op) move's cost/bounds/
    // occupancy/impassable-path and applies it to the grid. Split out of
    // moveShip solely to relieve legacy-codegen stack pressure — moveShip
    // already sits at its ~16-local-slot limit, and this block's own locals
    // (movementCost, the storage pointer to the ship's position) don't need
    // to stay live in moveShip's frame once this call returns.
    function _validateAndApplyMovement(
        GameData storage game,
        uint _gameId,
        uint _shipId,
        int16 _oldRow,
        int16 _oldCol,
        int16 _newRow,
        int16 _newCol
    ) private {
        uint8 movementCost = _manhattanDistance(
            Position(_oldRow, _oldCol),
            Position(_newRow, _newCol)
        );
        if (movementCost > game.shipBoard[_shipId].movement)
            revert InvalidMove();
        // Lower-bound check matters here too, for the same reason as
        // _placeShipOnGrid: int16 coordinates let a negative value slip
        // past an upper-bound-only comparison.
        if (
            _newRow < 0 ||
            _newCol < 0 ||
            _newRow >= GRID_HEIGHT ||
            _newCol >= GRID_WIDTH
        ) revert InvalidMove();
        // Occupied destinations are never reachable by a plain move — see
        // the Ram special for the only way to land on another ship's tile.
        if (game.occupied & _cellBit(_newRow, _newCol) != 0) revert InvalidMove();
        // Impassable terrain AND enemy ships block landing on AND passing
        // through — a single straight-line check (reusing the same
        // Bresenham walk as shooting LOS, against the impassable bitmask OR
        // the enemy side's current positions) covers both, since the walk's
        // own destination check already covers "onto". Ally ships never
        // block this (they already block only the exact destination tile,
        // via the occupied-destination check above) — matches enemy ships
        // being a hard obstacle, allies staying a soft one.
        ShipBoardState storage p = game.shipBoard[_shipId];
        if (
            !maps.hasMovementPathAvoidingShips(
                _gameId,
                _oldRow,
                _oldCol,
                _newRow,
                _newCol,
                game.live[p.isCreator ? 1 : 0]
            )
        ) revert InvalidMove();
        // The mover has HP > 0 (checked in moveShip), so it is live.
        uint256 moveBits = _cellBit(_oldRow, _oldCol) | _cellBit(_newRow, _newCol);
        game.occupied ^= moveBits;
        game.live[p.isCreator ? 0 : 1] ^= moveBits;
        p.row = _newRow;
        p.col = _newCol;
    }

    // A cell's bit in `occupied` and the side bitmaps. Callers bounds-check
    // first: an out-of-range cell would alias another one.
    function _cellBit(int16 _row, int16 _col) private pure returns (uint256) {
        return
            uint256(1) <<
            (uint(uint16(_row)) * uint(uint16(GRID_WIDTH)) + uint(uint16(_col)));
    }

    /// @dev Dispatches moveShip actions. Unknown or removed enum values revert so a ship is never
    ///      marked moved without a defined effect.
    function _performAction(
        GameData storage game,
        uint _gameId,
        uint _shipId,
        int16 _newRow,
        int16 _newCol,
        ActionType actionType,
        uint targetShipId
    ) internal {
        if (actionType == ActionType.Pass) {
            // Pass: do nothing
        } else if (actionType == ActionType.Shoot) {
            _performShoot(
                game,
                _gameId,
                _shipId,
                _newRow,
                _newCol,
                targetShipId
            );
        } else if (actionType == ActionType.Retreat) {
            _removeShipFromGame(_gameId, _shipId, true);
        } else if (actionType == ActionType.Assist) {
            revert InvalidMove(); // Assist removed
        } else if (actionType == ActionType.Special) {
            _performSpecial(
                _gameId,
                _shipId,
                _newRow,
                _newCol,
                targetShipId
            );
        } else if (actionType == ActionType.FactionAbility) {
            _performFactionAbility(
                _gameId,
                _shipId,
                _newRow,
                _newCol,
                targetShipId
            );
        } else {
            revert InvalidMove();
        }
    }

    // Internal function to perform shoot action
    function _performShoot(
        GameData storage game,
        uint _gameId,
        uint _shipId,
        int16 _newRow,
        int16 _newCol,
        uint targetShipId
    ) internal {
        // Validate target: still in this game, and on the other team.
        // Range, line of sight and "never placed" are checked below.
        ShipBoardState storage target = game.shipBoard[targetShipId];
        if (target.status == 1) revert ShipDestroyed();
        if (target.placed && target.isCreator == game.shipBoard[_shipId].isCreator)
            revert InvalidMove();
        // Must be in range (manhattan) and have line of sight. Scoped to a block so
        // these locals are popped off the stack once validated — _performShoot is
        // already tight on stack slots, and this makes room for the later
        // game.lastDamage[...] write (a struct-nested mapping access needs one more
        // transient slot than the flat mapping this replaced — see I-06 fix).
        ShipBoardState storage shooterAttributes = game.shipBoard[_shipId];
        _validateShootTarget(
            game,
            _gameId,
            _shipId,
            _newRow,
            _newCol,
            targetShipId,
            shooterAttributes.range
        );

        // Get target attributes
        ShipBoardState storage targetAttributes = game.shipBoard[targetShipId];

        // Handle ships with 0 hull points - increment reactor critical timer
        if (targetAttributes.hullPoints == 0) {
            targetAttributes.reactorCriticalTimer++;
            if (targetAttributes.reactorCriticalTimer >= 3) {
                _removeShipFromGame(_gameId, targetShipId, false);
            }
            return; // No damage calculation needed for 0 HP ships
        }

        // Calculate damage for ships with > 0 hull points
        uint8 baseDamage = shooterAttributes.gunDamage;
        uint8 reduction = targetAttributes.damageReduction;
        uint16 reducedDamage = baseDamage -
            ((uint16(baseDamage) * reduction) / 100);
        // Truncate division result
        // Reduce hull points
        if (reducedDamage >= targetAttributes.hullPoints) {
            _setShipHPToZero(_gameId, targetShipId);
            targetAttributes.lastDamager = uint48(_shipId);
        } else {
            targetAttributes.hullPoints -= uint8(reducedDamage);
        }
    }

    // Validates a shoot target: exists, not already gone, in range, and
    // (past range 1) has a clear line of sight — now accounting for enemy
    // ships blocking LOS too, not just terrain (ally ships never block,
    // same "enemy is a hard obstacle, ally is a soft one" rule as movement).
    // Split out of _performShoot purely to relieve legacy-codegen stack
    // pressure, same reasoning as _validateAndApplyMovement — _performShoot
    // has no headroom to spare for targetShipPos/manhattan/the enemy bitmap
    // staying live in its own frame.
    //
    // Conditions checked, in original order (combined into one revert
    // purely to save bytecode — Game.sol has no headroom to spare):
    //   1-2. Reject a target that was never placed in this game (!placed,
    //      the default-zeroed state for any id shipBoard was never written
    //      for) or that has since fled/been destroyed (status != 0)
    //      — entries aren't deleted on removal, only status flips, so
    //      placed alone doesn't catch a stale target. Without this, a
    //      hostile caller can target any ship id at all (not just this
    //      game's participants), reach the 0-HP reactor-timer branch below
    //      for it, and permanently brick round completion when
    //      _removeShipFromGame reverts ShipNotFound for a non-participant
    //      (see docs/audit-2.md HA2-01). Mirrors the same check
    //      RamResolver/EMPResolver/DroneSwarmResolver already have (SP-02).
    //   3. Out of range.
    //   4. Out of line of sight (only checked past range 1 — the
    //      short-circuiting && below skips the external maps call entirely
    //      when adjacent, exactly as before). The target's own tile is
    //      excluded from the enemy-occupied bitmap here — see
    //      hasMapsAvoidingShips for why that's required, not optional.
    function _validateShootTarget(
        GameData storage game,
        uint _gameId,
        uint _shipId,
        int16 _newRow,
        int16 _newCol,
        uint _targetShipId,
        uint8 _range
    ) private view {
        ShipBoardState storage targetShipPos = game.shipBoard[_targetShipId];
        uint8 manhattan = _manhattanDistance(
            Position(_newRow, _newCol),
            _boardPosition(targetShipPos)
        );
        bool outOfRangeOrGone = !targetShipPos.placed ||
            targetShipPos.status != 0 ||
            manhattan > _range;
        if (outOfRangeOrGone) revert InvalidMove();
        if (manhattan > 1) {
            // Enemy live ships (a 0 HP wreck never blocks a shot), minus
            // the target's own tile (see hasMapsAvoidingShips).
            uint256 enemyBitmap = game.live[
                game.shipBoard[_shipId].isCreator ? 1 : 0
            ] & ~_cellBit(targetShipPos.row, targetShipPos.col);
            if (
                !maps.hasMapsAvoidingShips(
                    _gameId,
                    _newRow,
                    _newCol,
                    targetShipPos.row,
                    targetShipPos.col,
                    enemyBitmap
                )
            ) revert InvalidMove();
        }
    }

    // Internal pure function to calculate manhattan distance between two positions
    function _manhattanDistance(
        Position memory a,
        Position memory b
    ) internal pure returns (uint8) {
        uint8 rowDiff = a.row > b.row
            ? uint8(uint16(a.row - b.row))
            : uint8(uint16(b.row - a.row));
        uint8 colDiff = a.col > b.col
            ? uint8(uint16(a.col - b.col))
            : uint8(uint16(b.col - a.col));
        return rowDiff + colDiff;
    }

    /// @notice Sets hull to 0 and records the ship in `shipsWithZeroHP` for round completion.
    /// @dev Round math: un-marks `_shipId` as moved before adding it to `shipsWithZeroHP`
    ///      so a ship that moved then was reduced to 0 HP in the same round is counted once, not twice.
    ///      Callers must not leave `shipsWithZeroHP` out of sync with `shipBoard[_shipId].hullPoints`.
    function _setShipHPToZero(uint _gameId, uint _shipId) internal {
        GameData storage game = games[_gameId];
        ShipBoardState storage b = game.shipBoard[_shipId];
        b.hullPoints = 0;
        game.live[b.isCreator ? 0 : 1] &= ~_cellBit(b.row, b.col);
        // HA6-24: remember it had already moved this round (see
        // ShipBoardState.zeroedAfterMovingRound).
        if (_clearMoved(game, _shipId)) {
            game.shipBoard[_shipId].zeroedAfterMovingRound = uint24(
                game.turnState.currentRound
            );
        }
        EnumerableSet.add(game.shipsWithZeroHP, _shipId);
    }

    // Moved this round: see ShipBoardState.movedInRound.
    function _hasMoved(
        GameData storage game,
        uint _shipId
    ) private view returns (bool) {
        return
            game.shipBoard[_shipId].movedInRound ==
            game.turnState.currentRound;
    }

    // Un-marks a ship as moved this round; true if it had moved.
    function _clearMoved(
        GameData storage game,
        uint _shipId
    ) private returns (bool) {
        if (!_hasMoved(game, _shipId)) return false;
        game.shipBoard[_shipId].movedInRound = 0;
        game.movedTotal--;
        return true;
    }

    // Helper function to copy an active list to a uint[] array
    function _copyActiveToArray(
        uint64[] storage list
    ) internal view returns (uint[] memory) {
        uint count = list.length;
        uint[] memory result = new uint[](count);
        for (uint i = 0; i < count; i++) {
            result[i] = list[i];
        }
        return result;
    }

    // Helper function to get ships that have moved this round for a specific player
    // This is used to get the game state for the client
    function _getMovedShipIds(
        uint _gameId,
        address _player
    ) internal view returns (uint[] memory) {
        GameData storage game = games[_gameId];
        uint64[] storage playerShipIds = _activeOf(game, _player);

        // First pass: count how many ships have moved
        uint movedCount = 0;
        uint shipCount = playerShipIds.length;
        for (uint i = 0; i < shipCount; i++) {
            uint shipId = playerShipIds[i];
            if (_hasMoved(game, shipId)) {
                movedCount++;
            }
        }

        // Second pass: collect the moved ship IDs
        uint[] memory movedShipIds = new uint[](movedCount);
        uint index = 0;
        for (uint i = 0; i < shipCount; i++) {
            uint shipId = playerShipIds[i];
            if (_hasMoved(game, shipId)) {
                movedShipIds[index] = shipId;
                index++;
            }
        }

        return movedShipIds;
    }

    // Helper function to require game exists
    function _requireGameExists(uint _gameId) internal view {
        if (games[_gameId].metadata.gameId == 0) revert GameNotFound();
    }

    // Helper function to validate ship exists and is not destroyed
    // A ship in this game and still on the board has a place in its side's
    // active list; a destroyed or fled one has left it.
    function _requireOnBoard(ShipBoardState storage b) private view {
        if (b.activeIndex == 0) {
            if (b.status == 1) revert ShipDestroyed();
            revert ShipNotFound();
        }
    }

    /// @notice Returns true when every ship that counted toward `totalActiveShipsAtRoundStart` has been
    ///         accounted for this round (moved, at 0 HP, or removed).
    /// @dev Invariants required for correct behavior (avoid premature or endless rounds):
    ///      - `totalActiveShipsAtRoundStart` is set when the round begins to the sum of
    ///        `creatorActive` and `joinerActive` at that snapshot.
    ///      - Each id in `shipsWithZeroHP` should be a ship still in the game with `hullPoints == 0`
    ///        until it is removed or repaired off the set.
    ///      - The moved count and `shipsWithZeroHP` must not both count the same ship; `_setShipHPToZero`
    ///        un-marks the ship as moved when adding it to the latter.
    ///      - `shipsRemovedTotal` increments only in `_removeShipFromGame`, which also removes the id
    ///        from the moved count and `shipsWithZeroHP`.
    function _checkRoundComplete(uint _gameId) internal view returns (bool) {
        GameData storage game = games[_gameId];

        uint movedShips = game.movedTotal - game.movedAtRoundStart;
        uint shipsWithZeroHP = EnumerableSet.length(game.shipsWithZeroHP);

        // Round is complete when every ship that was active at round start has either
        // moved, has 0 HP, or has been removed (destroyed or retreated) this round.
        return
            (movedShips +
                shipsWithZeroHP +
                game.shipsRemovedTotal -
                game.removedAtRoundStart) >=
            game.totalActiveShipsAtRoundStart;
    }

    // Switch turns only if the other player has unmoved ships
    function _switchTurnIfOtherPlayerHasShips(uint _gameId) internal {
        GameData storage game = games[_gameId];

        if (game.turnState.currentTurn == game.metadata.creator) {
            // Creator just moved, check if joiner has unmoved ships
            bool joinerHasUnmovedShips = _checkPlayerShips(
                _gameId,
                game.metadata.joiner,
                true
            );
            // Also check if creator has no ships that can move (all 0 HP)
            bool creatorHasMovableShips = _checkPlayerShips(
                _gameId,
                game.metadata.creator,
                false
            );

            if (joinerHasUnmovedShips || !creatorHasMovableShips) {
                game.turnState.currentTurn = game.metadata.joiner;
            }
        } else {
            // Joiner just moved, check if creator has unmoved ships
            bool creatorHasUnmovedShips = _checkPlayerShips(
                _gameId,
                game.metadata.creator,
                true
            );
            // Also check if joiner has no ships that can move (all 0 HP)
            bool joinerHasMovableShips = _checkPlayerShips(
                _gameId,
                game.metadata.joiner,
                false
            );

            if (creatorHasUnmovedShips || !joinerHasMovableShips) {
                game.turnState.currentTurn = game.metadata.creator;
            }
        }
    }

    // Helper function to check if a player has any ships matching the given
    // criterion. `_requireUnmoved` false == "can move" (_checkPlayerHasMovableShips'
    // old behavior: any active ship); true == "has unmoved ships"
    // (_checkPlayerHasUnmovedShips' old behavior: active AND not yet moved
    // this round). Merged from two near-identical loops (G-04 headroom fix)
    // — same external behavior at both call sites, one shared loop body.
    function _checkPlayerShips(
        uint _gameId,
        address _player,
        bool _requireUnmoved
    ) internal view returns (bool) {
        if (!_requireUnmoved) return _playerHasActiveShips(_gameId, _player);
        GameData storage game = games[_gameId];
        uint64[] storage shipIds = _activeOf(game, _player);

        uint shipCount = shipIds.length;
        for (uint i = 0; i < shipCount; i++) {
            uint shipId = shipIds[i];
            if (
                game.shipBoard[shipId].hullPoints != 0 &&
                !_hasMoved(game, shipId)
            ) {
                return true;
            }
        }
        return false;
    }

    // Internal function to perform special action — dispatched by equipped
    // slot (equipment.special) AND faction (traits.variant), since a slot's
    // meaning is per-faction (see specialResolvers' own comment). Resolved
    // entirely by an owner-authorized resolver contract via
    // specialResolvers; see _dispatchEffects.
    function _performSpecial(
        uint _gameId,
        uint _shipId,
        int16 _newRow,
        int16 _newCol,
        uint _targetShipId
    ) internal {
        ShipBoardState storage b = games[_gameId].shipBoard[_shipId];
        address resolver = specialResolvers[b.variant][b.special];
        if (resolver == address(0)) revert InvalidMove();
        _dispatchEffects(
            _gameId,
            resolver,
            b.variant,
            _shipId,
            _newRow,
            _newCol,
            _targetShipId
        );
    }

    // Internal function to perform a faction's innate ability
    // (ActionType.FactionAbility) — dispatched by traits.variant, not by an
    // equipped item, so every ship of that faction has it regardless of
    // loadout. Resolved entirely by an owner-authorized resolver contract
    // via factionAbilityResolvers; see _dispatchEffects.
    function _performFactionAbility(
        uint _gameId,
        uint _shipId,
        int16 _newRow,
        int16 _newCol,
        uint _targetShipId
    ) internal {
        uint16 variant = games[_gameId].shipBoard[_shipId].variant;
        address resolver = factionAbilityResolvers[variant];
        if (resolver == address(0)) revert InvalidMove();
        _dispatchEffects(
            _gameId,
            resolver,
            variant,
            _shipId,
            _newRow,
            _newCol,
            _targetShipId
        );
    }

    // Shared by _performSpecial and _performFactionAbility: it owns all
    // pre-dispatch validation for its effect and returns a declarative
    // effect list. SpecialEffectsLib (a separately-deployed library — see
    // its header comment) owns the resolver call and all
    // hull/reactor/relocate arithmetic against game storage, and hands back
    // only the ships that need removing; Game.sol applies those through its
    // own _removeShipFromGame so fleet cleanup/game-end/orchestrator
    // callback stay correct.
    function _dispatchEffects(
        uint _gameId,
        address _resolver,
        uint16 _variant,
        uint _shipId,
        int16 _newRow,
        int16 _newCol,
        uint _targetShipId
    ) internal {
        GameData storage game = games[_gameId];
        SpecialEffectsLib.EffectResults memory results = SpecialEffectsLib
            .resolveAndApply(
                game,
                _resolver,
                SpecialEffectsLib.ResolveContext({
                    gameId: _gameId,
                    shipId: _shipId,
                    variant: _variant,
                    targetShipId: _targetShipId,
                    newRow: _newRow,
                    newCol: _newCol
                })
            );
        // Removals must be applied before relocations — a relocation that
        // lands on a cell a removal is vacating would otherwise get
        // clobbered (see SpecialEffectsLib.EffectResults).
        for (uint i = 0; i < results.removeShipIds.length; i++) {
            _removeShipFromGame(
                _gameId,
                results.removeShipIds[i],
                results.removeKinds[i] == 1
            );
            // A removal that ended the game cleared both fleets; a further
            // removal would revert ShipNotFound (HA6-02). Relocations below
            // still apply (grid/positions only) so the final board is right.
            if (game.metadata.ended) break;
        }
        SpecialEffectsLib.applyRelocations(
            game,
            results.relocateShipIds,
            results.relocatePositions
        );
    }

    /// @notice Removes a ship from the grid, fleets, and per-player active sets; records it as gone.
    /// @dev Round completion: increments `shipsRemovedTotal` and removes `_shipId` from
    ///      the moved count and `shipsWithZeroHP` so the removed ship contributes exactly once
    ///      toward the round total (via `shipsRemovedTotal`, not via moved/zero counts).
    function _removeShipFromGame(
        uint _gameId,
        uint _shipId,
        bool _isRetreat
    ) internal {
        // No _requireGameExists: every caller is reached only via moveShip,
        // which already checked it.
        GameData storage game = games[_gameId];

        // Check the ship is in the game and still on the board; its side is
        // stored with it.
        _requireOnBoard(game.shipBoard[_shipId]);
        bool isCreatorShip = game.shipBoard[_shipId].isCreator;

        // Remove ship from grid
        ShipBoardState storage shipPosition = game.shipBoard[_shipId];
        uint256 keep = ~_cellBit(shipPosition.row, shipPosition.col);
        game.occupied &= keep;
        game.live[isCreatorShip ? 0 : 1] &= keep;

        // Un-mark it as moved since it's no longer active
        _clearMoved(game, _shipId);

        // Remove ship from zero HP set since it's no longer active
        EnumerableSet.remove(game.shipsWithZeroHP, _shipId);

        // Count for round completion so round does not end early when ships are destroyed/retreated mid-round
        game.shipsRemovedTotal++;

        // Add ship to gone ship ids
        game.goneShipIds.push(_shipId);

        // Remove ship from fleet
        if (isCreatorShip) {
            fleets.removeShipFromFleet(game.metadata.creatorFleetId, _shipId);
        } else {
            fleets.removeShipFromFleet(game.metadata.joinerFleetId, _shipId);
        }

        // Mark ship status (1 = destroyed, 2 = fled) but keep last known
        // position and side for replay/visualization; clear its stats
        // (version 0 = none), all in one write of the packed slot.
        game.shipBoard[_shipId] = ShipBoardState({
            row: shipPosition.row,
            col: shipPosition.col,
            isCreator: shipPosition.isCreator,
            status: _isRetreat ? 2 : 1,
            placed: true,
            version: 0,
            range: 0,
            gunDamage: 0,
            hullPoints: 0,
            maxHullPoints: 0,
            movement: 0,
            damageReduction: 0,
            reactorCriticalTimer: 0,
            movedInRound: 0,
            zeroedAfterMovingRound: 0,
            // Kept so _removeShipFromPlayerActiveShips below can find it.
            activeIndex: shipPosition.activeIndex,
            variant: shipPosition.variant,
            special: shipPosition.special,
            // Kept for the kill credit just below.
            lastDamager: shipPosition.lastDamager
        });

        // If this ship didn't retreat, set the timestamp destroyed
        if (!_isRetreat) {
            ships.setTimestampDestroyed(_shipId, shipPosition.lastDamager);
        }

        // Remove ship from the active lists
        _removeShipFromPlayerActiveShips(_gameId, _shipId);

        // Check if the game should end due to a player having no active ships
        _checkGameEndCondition(_gameId);
    }

    // Removes a ship from its side's active list: swap the last id into
    // its place, then pop.
    function _removeShipFromPlayerActiveShips(
        uint _gameId,
        uint _shipId
    ) internal {
        GameData storage game = games[_gameId];
        ShipBoardState storage b = game.shipBoard[_shipId];
        uint index = b.activeIndex;
        if (index == 0) return;
        uint64[] storage list = b.isCreator
            ? game.creatorActive
            : game.joinerActive;
        uint64 last = list[list.length - 1];
        if (index != list.length) {
            list[index - 1] = last;
            game.shipBoard[last].activeIndex = uint8(index);
        }
        list.pop();
        b.activeIndex = 0;
    }

    // Internal function to increment reactorCriticalTimer for ships with 0 HP
    function _incrementReactorCriticalTimerForZeroHPShips(
        uint _gameId
    ) internal {
        GameData storage game = games[_gameId];

        uint zeroHPShipCount = EnumerableSet.length(game.shipsWithZeroHP);
        for (uint i = 0; i < zeroHPShipCount; ) {
            uint shipId = EnumerableSet.at(game.shipsWithZeroHP, i);
            // Hold the storage reference once instead of re-indexing
            // game.shipBoard[shipId] (a mapping — each index recomputes
            // a keccak256 slot, not just an SLOAD) up to three times per
            // zero-HP ship, every round of every game (G-07).
            ShipBoardState storage attrs = game.shipBoard[shipId];
            // Set members are always still on the board; the status check
            // (same slot as hullPoints, so free) keeps a stale entry inert
            // without the Ships.isShipDestroyed call this used to make.
            if (attrs.status == 0 && attrs.hullPoints == 0) {
                attrs.reactorCriticalTimer++;
                if (attrs.reactorCriticalTimer >= 3) {
                    _removeShipFromGame(_gameId, shipId, false);
                    // This removal ended the game and cleared both fleets;
                    // another removal would revert ShipNotFound (HA6-02).
                    if (game.metadata.ended) return;
                    // Set shrinks; re-check same index
                    zeroHPShipCount = EnumerableSet.length(
                        game.shipsWithZeroHP
                    );
                    continue;
                }
            }
            i++;
        }
    }

    // View functions

    // Lightweight metadata/turn-state-only read (G-04): getGame() below is
    // O(active+gone ships) by design (EnumerableSet walks, ship positions,
    // moved-ship lists) — the right cost for a caller that actually needs
    // ship data, but real overkill for callers (PvPMatch.flee/
    // endGameOnTimeout, RoguelikeMatch's node-completion handler,
    // Tournament.resolveDraw) that only ever touch metadata/turnState
    // scalars. Both structs are plain value types (no nested mappings), so
    // this is just two flat struct copies — O(1).
    function getGameMetadataAndTurnState(
        uint _gameId
    ) external view returns (GameMetadata memory, GameTurnState memory) {
        _requireGameExists(_gameId);
        GameData storage game = games[_gameId];
        return (game.metadata, game.turnState);
    }

    //
    // INVARIANT relied on by AIBehavior.sol/SinglePlayerMatch.sol/
    // RoguelikeMatch.sol (G-01 gas fix): shipIds/shipAttributes and
    // shipPositions (via getAllShipPositions) are both built from
    // creatorActiveShipIds then joinerActiveShipIds, in that exact order —
    // so for any index i with shipPositions[i].status == 0, shipIds[i] ==
    // shipPositions[i].shipId and shipAttributes[i] is that ship's
    // attributes, with no scan needed. Changing this construction order (or
    // interleaving creator/joiner ships) would silently break those
    // callers' direct index reads.
    function getGame(uint _gameId) public view returns (GameDataView memory) {
        _requireGameExists(_gameId);

        GameData storage game = games[_gameId];

        // Get active ship IDs for each player
        // Copy active ship IDs using helper function
        uint[] memory creatorActiveShipIds = _copyActiveToArray(
            game.creatorActive
        );
        uint[] memory joinerActiveShipIds = _copyActiveToArray(
            game.joinerActive
        );

        // All active ships' ids and attributes, creator ships first
        AIView memory active = _activeView(game);

        // Get all ship positions
        ShipPosition[] memory shipPositions = getAllShipPositions(_gameId);

        // Get ships that have moved this round
        uint[] memory creatorMovedShipIds = _getMovedShipIds(
            _gameId,
            game.metadata.creator
        );
        uint[] memory joinerMovedShipIds = _getMovedShipIds(
            _gameId,
            game.metadata.joiner
        );

        return
            GameDataView({
                metadata: game.metadata,
                turnState: game.turnState,
                gridDimensions: game.gridDimensions,
                maxScore: game.maxScore,
                creatorScore: game.creatorScore,
                joinerScore: game.joinerScore,
                lastMove: LastMove({
                    shipId: game.lastMove.shipId,
                    oldRow: game.lastMove.oldRow,
                    oldCol: game.lastMove.oldCol,
                    newRow: game.lastMove.newRow,
                    newCol: game.lastMove.newCol,
                    actionType: game.lastMove.actionType,
                    targetShipId: game.lastMove.targetShipId,
                    timestamp: game.lastMove.timestamp
                }),
                shipAttributes: active.shipAttributes,
                shipPositions: shipPositions,
                shipIds: active.shipIds,
                creatorActiveShipIds: creatorActiveShipIds,
                joinerActiveShipIds: joinerActiveShipIds,
                creatorMovedShipIds: creatorMovedShipIds,
                joinerMovedShipIds: joinerMovedShipIds
            });
    }

    // Lets the orchestrator that started this session (e.g. PvPMatch) end it
    // early with a given winner/loser — this is how mode-specific forfeit
    // mechanics (human flee/timeout, or whatever a future mode needs) drive
    // core Game.sol's win/loss bookkeeping without that logic living here.
    function forceEndSession(
        uint _gameId,
        address _winner,
        address _loser
    ) external {
        _requireGameExists(_gameId);
        GameData storage game = games[_gameId];
        if (msg.sender != game.metadata.orchestrator) revert NotOrchestrator();
        if (game.metadata.ended) revert InvalidMove();

        _endGame(_gameId, _winner, _loser);

        // Emit event to notify clients of game state change
        emit GameUpdate(_gameId);
    }

    // Releases every remaining ship in a fleet at game end. Uses
    // Fleets.clearFleet rather than looping the active lists and calling
    // removeShipFromFleet per ship — the fleet is being fully dissolved
    // here, so there's no need to pay for removeShipFromFleet's per-ship
    // getShip() cost-accounting (fleet.totalCost) or its O(n) find-in-array
    // per removal; clearFleet just unlocks every ship (setInFleet(false))
    // and drops the whole shipIds array in one storage write. Safe because
    // every mid-game removal (_removeShipFromGame) already keeps
    // fleet.shipIds and the active lists in lockstep, so by the time a
    // game ends they contain the same ship ids.
    function _removeShipsFromFleet(uint _fleetId) internal {
        fleets.clearFleet(_fleetId);
    }

    // Helper function to handle end-of-round logic
    function _handleEndOfRound(uint _gameId) internal {
        GameData storage game = games[_gameId];

        // End-of-round scoring: award points for ships on scoring tiles.
        // getGameScoringPositions (not getGameMapState) since blockedTiles
        // isn't needed here — no reason to pay for computing it.
        ScoringPosition[] memory scoringPositions = maps
            .getGameScoringPositions(_gameId);
        uint scoringCount = scoringPositions.length;
        uint creatorRoundPoints = 0;
        uint joinerRoundPoints = 0;
        // Each side's cells holding a live ship (0 HP ships are left out,
        // treated as destroyed/disabled). Maps keeps scoring tiles in bounds.
        uint256 creatorLive = game.live[0];
        uint256 joinerLive = game.live[1];
        for (uint i = 0; i < scoringCount; i++) {
            ScoringPosition memory pos = scoringPositions[i];
            uint256 bit = _cellBit(pos.row, pos.col);
            bool creatorOnTile = creatorLive & bit != 0;
            if (!creatorOnTile && joinerLive & bit == 0) continue;

            // UA-04 fix (2026-09-29): degrade to "skip this tile's scoring"
            // rather than reverting the whole round if this call fails —
            // e.g. Maps.isAllowedGame was revoked for this engine (an
            // admin "retire the old engine" cleanup action) while this
            // game is still active. Without this, every active game with
            // any live ship on a scoring tile would have every future
            // moveShip call revert permanently the moment a round
            // completes, since this is called unconditionally from
            // _handleEndOfRound with no way around it. Never revoke
            // Maps.isAllowedGame for an engine that could still have games
            // in progress — this is defense-in-depth, not a substitute for
            // that discipline (points are silently lost for that tile that
            // round, not awarded some other way).
            uint8 points;
            try maps.getScoreAndZeroOut(_gameId, pos.row, pos.col) returns (
                uint8 p
            ) {
                points = p;
            } catch {
                points = 0;
            }
            if (points == 0) continue;

            // Update the player's score based on which side the ship belongs to
            if (creatorOnTile) {
                creatorRoundPoints += points;
            } else {
                joinerRoundPoints += points;
            }
        }

        // Apply round points simultaneously, then determine winner if any
        if (creatorRoundPoints > 0 || joinerRoundPoints > 0) {
            game.creatorScore += creatorRoundPoints;
            game.joinerScore += joinerRoundPoints;

            if (
                game.creatorScore >= game.maxScore ||
                game.joinerScore >= game.maxScore
            ) {
                _endGameByScore(_gameId, game);
                return;
            }
        }

        game.turnState.currentRound++;

        // No ship has moved in the new round (ShipBoardState.movedInRound
        // values from the old round no longer match currentRound)
        game.movedAtRoundStart = game.movedTotal;
        game.removedAtRoundStart = game.shipsRemovedTotal;

        // Snapshot active ship count BEFORE any round-start destruction, so that when
        // _incrementReactorCriticalTimerForZeroHPShips destroys ships we still require
        // one "count" per ship that was active at round start (moved + zero HP + removed).
        game.totalActiveShipsAtRoundStart =
            game.creatorActive.length +
            game.joinerActive.length;

        // Beginning of new round: increment reactorCriticalTimer for ships with 0 HP (may destroy ships)
        _incrementReactorCriticalTimerForZeroHPShips(_gameId);

        // Alternate who goes first each round. creatorGoesFirst is set by Lobbies from
        // who selected fleet first (true = creator selected first, false = joiner).
        // Odd rounds = that "first" player, even rounds = the other.
        address firstPlayer = game.metadata.creatorGoesFirst
            ? game.metadata.creator
            : game.metadata.joiner;
        address secondPlayer = game.metadata.creatorGoesFirst
            ? game.metadata.joiner
            : game.metadata.creator;
        game.turnState.currentTurn = (game.turnState.currentRound & 1) == 1
            ? firstPlayer
            : secondPlayer;
    }

    // Player game tracking view functions
    function getGamesFromIds(
        uint[] memory _gameIds
    ) public view returns (GameDataView[] memory) {
        GameDataView[] memory result = new GameDataView[](_gameIds.length);
        for (uint i = 0; i < _gameIds.length; i++) {
            result[i] = getGame(_gameIds[i]);
        }
        return result;
    }

    function getGamesForPlayer(
        address _player
    ) public view returns (GameDataView[] memory) {
        return getGamesFromIds(playerGames[_player]);
    }
}

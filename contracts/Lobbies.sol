// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./Types.sol";
import "./Ships.sol";
import "./PvPMatch.sol";
import "./IFleets.sol";
import "./IMaps.sol";

// PvP-only: vs-AI matches now enter through SinglePlayerMatch.startNodeMatch
// directly (see NodeMap.sol), with no lobby involved at all.
contract Lobbies is Ownable, ReentrancyGuard {
    using EnumerableSet for EnumerableSet.UintSet;

    Ships public ships;
    PvPMatch public pvpMatch;
    IFleets public fleets;
    IMaps public maps;

    IERC20 public universalCredits;

    uint public lobbyCount;
    uint public freeGamesPerAddress = 1;
    uint public additionalLobbyFee = 1 ether;
    uint public maxFleetCostLimit = 2000;
    bool public paused;

    // How long an unjoined lobby can sit in openLobbyIds before anyone can
    // permissionlessly prune it (see docs/pre-audit.md GR-03 — with no
    // expiry, openLobbyIds/getOpenLobbies grows forever with lobbies the
    // creator opened and simply never came back to cancel).
    uint public staleLobbyThreshold = 7 days;

    mapping(uint => Lobby) public lobbies;
    mapping(address => PlayerLobbyState) public playerStates;

    // New mappings for lobby tracking
    mapping(address => EnumerableSet.UintSet) private playerLobbies;
    EnumerableSet.UintSet private openLobbyIds;
    // When a lobby most recently entered openLobbyIds — distinct from
    // lobby.basic.createdAt (set once, at creation, never updated). See
    // _addLobbyToOpenSet/pruneStaleLobby.
    mapping(uint => uint) public lobbyOpenedAt;

    event LobbyCreated(
        uint indexed lobbyId,
        address indexed creator,
        uint costLimit,
        uint turnTime,
        bool creatorGoesFirst,
        uint selectedMapId,
        uint maxScore
    );
    event PlayerJoinedLobby(uint indexed lobbyId, address indexed joiner);
    event GameStarted(uint indexed lobbyId);
    event LobbyReset(uint indexed lobbyId, address indexed newCreator);
    event LobbyAbandoned(uint indexed lobbyId, address indexed player);
    event LobbyTerminated(uint indexed lobbyId);
    event LobbyPruned(uint indexed lobbyId, address indexed pruner);
    event StaleLobbyThresholdUpdated(uint newThreshold);
    event FleetCreated(
        uint indexed lobbyId,
        address indexed player,
        uint fleetId
    );
    event MaxFleetCostLimitUpdated(uint newLimit);
    event GameReserved(uint indexed lobbyId, address indexed reservedJoiner);
    event GameAccepted(uint indexed lobbyId, address indexed joiner);
    event GameRejected(uint indexed lobbyId, address indexed joiner);
    event Withdrawn(address indexed to, uint amount);

    error LobbyNotFound();
    error LobbyFull();
    error LobbyNotOpen();
    error LobbyAlreadyStarted();
    error InvalidFleetCost();
    error ShipAlreadyInFleet();
    error ShipNotOwned();
    error ShipCostVersionMismatch();
    error PlayerAlreadyInLobby();
    error InsufficientFee();
    error LobbyCreationPaused();
    error NotInLobby();
    error FleetAlreadyCreated();
    error InvalidShipCount();
    error CannotLeaveStartedGame();
    error InvalidTurnTime();
    error TimeoutNotReached();
    error NotLobbyCreator();
    error PlayerInTimeout();
    error NotLobbyJoiner();
    error CreatorTimeoutNotReached();
    error InvalidMapId();
    error MaxFleetCostExceeded();
    error NotReservedJoiner();
    error KickedFromLobby();
    error LobbyNotReserved();
    error InsufficientUTC();
    error UTCTransferFailed();
    error LobbyNotStaleYet();

    uint public constant MIN_TURN_TIME = 60; // 1 minute in seconds
    uint public constant MAX_TURN_TIME = 86400; // 24 hours in seconds
    uint public constant MIN_TIMEOUT = 300; // 5 minutes in seconds
    uint public constant KICK_PENALTY_PER_HOUR = 3600; // 1 hour in seconds

    // docs/audit-3.md HA6-29: an address timed out of a lobby (timeoutJoiner)
    // can never rejoin that same lobby. kickCount only applies when the
    // creator had committed a fleet, so otherwise the same address could
    // rejoin immediately and stall the creator again, indefinitely.
    mapping(uint lobbyId => mapping(address => bool)) public kickedFromLobby;

    constructor(address _ships) Ownable(msg.sender) {
        ships = Ships(_ships);
    }

    function setUniversalCreditsAddress(address _universalCredits) public onlyOwner {
        universalCredits = IERC20(_universalCredits);
    }

    function setPvpMatchAddress(address _pvpMatchAddress) public onlyOwner {
        pvpMatch = PvPMatch(_pvpMatchAddress);
    }

    function setFleetsAddress(address _fleetsAddress) public onlyOwner {
        fleets = IFleets(_fleetsAddress);
    }

    function setMapsAddress(address _mapsAddress) public onlyOwner {
        maps = IMaps(_mapsAddress);
    }

    /// @dev A PvP lobby needs a map that exists and is valid for PvP (PvP
    /// or Both) — a PvE-only map (e.g. one curated for a specific campaign
    /// encounter) shouldn't be selectable here. _selectedMapId == 0 means
    /// no preset map and is valid, handled by callers before this runs.
    function _requireMapUsableForPvP(uint _selectedMapId) internal view {
        if (address(maps) == address(0)) revert InvalidMapId();
        if (!maps.mapExists(_selectedMapId)) revert InvalidMapId();
        MapMode mode = maps.mapMode(_selectedMapId);
        if (mode != MapMode.PvP && mode != MapMode.Both) revert InvalidMapId();
    }

    function isLobbyOpenForJoining(uint _id) public view returns (bool) {
        Lobby storage l = lobbies[_id];
        return
            l.state.status == LobbyStatus.Open &&
            l.players.joiner == address(0);
    }

    // Helper functions for set management
    function _addPlayerToLobby(address _player, uint _lobbyId) internal {
        playerLobbies[_player].add(_lobbyId);
    }

    function _removePlayerFromLobby(address _player, uint _lobbyId) internal {
        playerLobbies[_player].remove(_lobbyId);
    }

    // A player leaving a not-yet-started lobby by any path (docs/audit-3.md
    // HA6-10): activeLobbiesCount must come back down (it gates the
    // additionalLobbyFee), and activeLobbyId — a single slot for a player
    // who can be in several lobbies — is only cleared when it actually
    // points at this lobby, never clobbered when it points at another one.
    function _releasePlayerSlot(address _player, uint _lobbyId) internal {
        PlayerLobbyState storage state = playerStates[_player];
        if (state.activeLobbiesCount > 0) {
            state.activeLobbiesCount--;
        }
        if (state.activeLobbyId == _lobbyId) {
            state.hasActiveLobby = false;
            state.activeLobbyId = 0;
        }
    }

    function _addLobbyToOpenSet(uint _lobbyId) internal {
        openLobbyIds.add(_lobbyId);
        // Stamped every time a lobby (re-)enters the open set, not just at
        // creation — pruneStaleLobby measures staleness from here, not from
        // lobby.basic.createdAt, which is set once at creation and never
        // updated. Without this, a lobby that's cycled through join/leave
        // (or timeout, or a promoted-joiner reset) days after creation would
        // still carry its original creation timestamp and could be pruned
        // immediately even though it just became open again.
        lobbyOpenedAt[_lobbyId] = block.timestamp;
    }

    function _removeLobbyFromOpenSet(uint _lobbyId) internal {
        openLobbyIds.remove(_lobbyId);
    }

    function _cleanupLobbyFromAllSets(uint _lobbyId) internal {
        Lobby storage lobby = lobbies[_lobbyId];

        // Remove from both players' sets
        if (lobby.basic.creator != address(0)) {
            _removePlayerFromLobby(lobby.basic.creator, _lobbyId);
        }
        if (lobby.players.joiner != address(0)) {
            _removePlayerFromLobby(lobby.players.joiner, _lobbyId);
        }

        // Remove from open set
        _removeLobbyFromOpenSet(_lobbyId);
    }

    function leaveLobby(uint _lobbyId) public nonReentrant {
        Lobby storage lobby = lobbies[_lobbyId];
        if (lobby.basic.id == 0) revert LobbyNotFound();
        if (
            msg.sender != lobby.basic.creator &&
            msg.sender != lobby.players.joiner
        ) revert NotInLobby();
        if (lobby.state.status == LobbyStatus.InGame)
            revert CannotLeaveStartedGame();

        // Membership, not the single activeLobbyId slot: a player can be in
        // several lobbies and must be able to leave any of them (HA6-10).
        if (!playerLobbies[msg.sender].contains(_lobbyId)) revert NotInLobby();

        // If player is creator, delete the lobby
        if (msg.sender == lobby.basic.creator) {
            // Clear creator's fleet if they have one
            if (lobby.players.creatorFleetId != 0) {
                fleets.clearFleet(lobby.players.creatorFleetId);
                lobby.players.creatorFleetId = 0;
            }

            // If a human joiner exists, they become the new creator so the
            // lobby isn't wasted.
            if (lobby.players.joiner != address(0)) {
                address newCreator = lobby.players.joiner;
                lobby.basic.creator = newCreator;
                lobby.players.joiner = address(0);
                lobby.state.status = LobbyStatus.Open;
                // Clear any stale reservation — otherwise it can equal the
                // lobby's own newly-promoted creator, and since joinLobby
                // also blocks creator == msg.sender, that permanently
                // bricks the lobby: no address, including the reserved one,
                // could ever join it again (see docs/audit-2.md HA2-05).
                lobby.players.reservedJoiner = address(0);

                // Clear the promoted player's old joiner-side fleet, same
                // as the joiner-leaves branch below does — otherwise a
                // stale joinerFleetId survives into the reopened lobby,
                // permanently blocking a new joiner from ever creating
                // their own fleet (FleetAlreadyCreated) and letting the
                // promoted creator's next fleet auto-start the game bound
                // to that stale fleet instead of the new joiner's own (see
                // docs/pre-audit.md SP-03).
                if (lobby.players.joinerFleetId != 0) {
                    fleets.clearFleet(lobby.players.joinerFleetId);
                    lobby.players.joinerFleetId = 0;
                }

                // Update joiner's state
                PlayerLobbyState storage joinerState = playerStates[newCreator];
                joinerState.hasActiveLobby = true;
                joinerState.activeLobbyId = _lobbyId;

                // Update tracking sets: remove old creator, joiner becomes creator
                _removePlayerFromLobby(msg.sender, _lobbyId);
                // Joiner stays in the set, just becomes creator
                _addLobbyToOpenSet(_lobbyId); // Lobby is open again

                emit LobbyReset(_lobbyId, newCreator);
            } else {
                // Lobby is completely abandoned: no joiner.
                _cleanupLobbyFromAllSets(_lobbyId);
                lobby.players.joiner = address(0);
                lobby.state.status = LobbyStatus.Open;
                lobby.players.reservedJoiner = address(0);
                emit LobbyAbandoned(_lobbyId, msg.sender);
            }
        } else {
            // If player is joiner, just remove them
            // Clear joiner's fleet if they have one
            if (lobby.players.joinerFleetId != 0) {
                fleets.clearFleet(lobby.players.joinerFleetId);
                lobby.players.joinerFleetId = 0;
            }

            lobby.players.joiner = address(0);
            lobby.state.status = LobbyStatus.Open;
            lobby.players.reservedJoiner = address(0);

            // Remove joiner from tracking and add lobby back to open set
            _removePlayerFromLobby(msg.sender, _lobbyId);
            _addLobbyToOpenSet(_lobbyId);

            emit LobbyAbandoned(_lobbyId, msg.sender);
        }

        _releasePlayerSlot(msg.sender, _lobbyId);
    }

    // Permissionless: removes a lobby from openLobbyIds once it's sat
    // unjoined for longer than staleLobbyThreshold, for a creator who never
    // came back to call leaveLobby themselves (see docs/pre-audit.md GR-03
    // — without this, openLobbyIds/getOpenLobbies grows forever with
    // abandoned listings). Deliberately narrow: only removes the lobby from
    // the open set, nothing else. It does NOT touch lobby.state.status,
    // playerLobbies, or the creator's PlayerLobbyState — the lobby record
    // itself is untouched and still directly joinable/leaveable exactly as
    // before; this only "delists" it from the public open-browse list. The
    // creator can still call leaveLobby at any time afterward (before or
    // after pruning) for their own full cleanup. Requiring the lobby to
    // still be a member of openLobbyIds is also what guarantees it has no
    // joiner — joinLobby removes a lobby from this set the instant someone
    // joins (Lobbies.sol:387), so nothing reachable here has ever had one.
    function pruneStaleLobby(uint _lobbyId) external {
        if (!openLobbyIds.contains(_lobbyId)) revert LobbyNotOpen();
        if (block.timestamp < lobbyOpenedAt[_lobbyId] + staleLobbyThreshold) {
            revert LobbyNotStaleYet();
        }

        _removeLobbyFromOpenSet(_lobbyId);

        emit LobbyPruned(_lobbyId, msg.sender);
    }

    function createLobby(
        uint _costLimit,
        uint _turnTime,
        bool _creatorGoesFirst,
        uint _selectedMapId,
        uint _maxScore,
        address _reservedJoiner
    ) public payable nonReentrant {
        if (paused) revert LobbyCreationPaused();
        if (_turnTime < MIN_TIMEOUT || _turnTime > MAX_TURN_TIME)
            revert InvalidTurnTime();
        if (_costLimit > maxFleetCostLimit) revert MaxFleetCostExceeded();
        if (_reservedJoiner == msg.sender) revert PlayerAlreadyInLobby();

        // Validate mapId: 0 means no preset map (valid), otherwise must
        // exist and be valid for PvP.
        if (_selectedMapId > 0) {
            _requireMapUsableForPvP(_selectedMapId);
        }

        // Check if player is in timeout
        PlayerLobbyState storage state = playerStates[msg.sender];
        if (state.kickCount > 0) {
            uint timeoutEnd = state.lastKickTime +
                (state.kickCount * KICK_PENALTY_PER_HOUR);
            if (block.timestamp < timeoutEnd) revert PlayerInTimeout();
        }

        // If reserving for a specific player, charge 1 UTC (no ETH involved).
        if (_reservedJoiner != address(0)) {
            if (msg.value != 0) revert InsufficientFee();
            if (address(universalCredits) == address(0)) revert UTCTransferFailed();
            uint reservationFee = 1 ether; // 1 UTC
            uint balance = universalCredits.balanceOf(msg.sender);
            if (balance < reservationFee) revert InsufficientUTC();
            require(
                universalCredits.transferFrom(msg.sender, address(this), reservationFee),
                "UTC transfer failed"
            );
        } else {
            // Check if player needs to pay for additional lobbies (FLOW payment)
            if (state.activeLobbiesCount >= freeGamesPerAddress) {
                if (msg.value != additionalLobbyFee) revert InsufficientFee();
            } else if (msg.value != 0) {
                // Free lobby available: no fee is owed, so don't silently keep ETH
                revert InsufficientFee();
            }
        }

        lobbyCount++;
        Lobby storage newLobby = lobbies[lobbyCount];
        newLobby.basic.id = lobbyCount;
        newLobby.basic.creator = msg.sender;
        newLobby.basic.costLimit = _costLimit;
        newLobby.state.status = LobbyStatus.Open;
        newLobby.basic.createdAt = block.timestamp;
        newLobby.gameConfig.creatorGoesFirst = _creatorGoesFirst;
        newLobby.gameConfig.turnTime = _turnTime;
        newLobby.gameConfig.selectedMapId = _selectedMapId;
        newLobby.gameConfig.maxScore = _maxScore;
        // UA-10 fix: pin which PvPMatch/engine this lobby's eventual game
        // starts on, at creation time — see LobbyGameConfig.pvpMatch.
        newLobby.gameConfig.pvpMatch = address(pvpMatch);

        // Set reserved joiner if provided
        if (_reservedJoiner != address(0)) {
            newLobby.players.reservedJoiner = _reservedJoiner;
            emit GameReserved(lobbyCount, _reservedJoiner);
        }

        state.hasActiveLobby = true;
        state.activeLobbyId = lobbyCount;
        state.activeLobbiesCount++;

        // Add to tracking sets
        _addPlayerToLobby(msg.sender, lobbyCount);
        _addLobbyToOpenSet(lobbyCount);

        emit LobbyCreated(
            lobbyCount,
            msg.sender,
            _costLimit,
            _turnTime,
            _creatorGoesFirst,
            _selectedMapId,
            _maxScore
        );
    }

    function joinLobby(uint _lobbyId) public payable nonReentrant {
        Lobby storage lobby = lobbies[_lobbyId];
        if (lobby.basic.id == 0) revert LobbyNotFound();
        if (lobby.state.status != LobbyStatus.Open) revert LobbyNotOpen();
        if (lobby.basic.creator == msg.sender) revert PlayerAlreadyInLobby();
        if (lobby.players.joiner != address(0)) revert LobbyFull();
        if (kickedFromLobby[_lobbyId][msg.sender]) revert KickedFromLobby();

        // Check if lobby is reserved for a specific player
        if (lobby.players.reservedJoiner != address(0)) {
            if (msg.sender != lobby.players.reservedJoiner) {
                revert NotReservedJoiner();
            }
        }

        PlayerLobbyState storage state = playerStates[msg.sender];

        // Check if player is in timeout
        if (state.kickCount > 0) {
            uint timeoutEnd = state.lastKickTime +
                (state.kickCount * KICK_PENALTY_PER_HOUR);
            if (block.timestamp < timeoutEnd) revert PlayerInTimeout();
        }

        // Check if player needs to pay for additional lobbies (only for non-reserved lobbies)
        if (lobby.players.reservedJoiner == address(0)) {
            if (state.activeLobbiesCount >= freeGamesPerAddress) {
                if (msg.value != additionalLobbyFee) revert InsufficientFee();
            } else if (msg.value != 0) {
                // Free lobby available: no fee is owed, so don't silently keep ETH
                revert InsufficientFee();
            }
        } else if (msg.value != 0) {
            // Reserved lobbies don't charge the joiner an ETH fee
            revert InsufficientFee();
        }

        // Clear the reservation once consumed (harmless no-op if it was
        // never reserved) — acceptGame already does this; joinLobby is the
        // other way a reserved joiner can actually join, and leaving it set
        // here let the reservation permanently outlive this join, locking
        // the lobby to this address even after they leave (see
        // docs/audit-2.md HA2-05).
        lobby.players.reservedJoiner = address(0);

        lobby.players.joiner = msg.sender;
        lobby.state.status = LobbyStatus.FleetSelection;
        lobby.players.joinedAt = block.timestamp;

        // Update player state - allow multiple active lobbies
        if (!state.hasActiveLobby) {
            state.hasActiveLobby = true;
            state.activeLobbyId = _lobbyId;
        }
        state.activeLobbiesCount++;

        // Add joiner to lobby tracking and remove from open set
        _addPlayerToLobby(msg.sender, _lobbyId);
        _removeLobbyFromOpenSet(_lobbyId);

        emit PlayerJoinedLobby(_lobbyId, msg.sender);
    }

    function acceptGame(uint _lobbyId) public nonReentrant {
        Lobby storage lobby = lobbies[_lobbyId];
        if (lobby.basic.id == 0) revert LobbyNotFound();
        if (lobby.players.reservedJoiner == address(0)) revert LobbyNotReserved();
        if (msg.sender != lobby.players.reservedJoiner) revert NotReservedJoiner();
        if (lobby.state.status != LobbyStatus.Open) revert LobbyNotOpen();
        if (lobby.players.joiner != address(0)) revert LobbyFull();
        if (kickedFromLobby[_lobbyId][msg.sender]) revert KickedFromLobby();

        PlayerLobbyState storage state = playerStates[msg.sender];

        // Check if player is in timeout
        if (state.kickCount > 0) {
            uint timeoutEnd = state.lastKickTime +
                (state.kickCount * KICK_PENALTY_PER_HOUR);
            if (block.timestamp < timeoutEnd) revert PlayerInTimeout();
        }

        lobby.players.joiner = msg.sender;
        lobby.state.status = LobbyStatus.FleetSelection;
        lobby.players.joinedAt = block.timestamp;
        // Clear reserved joiner since they've accepted
        lobby.players.reservedJoiner = address(0);

        // Update player state - allow multiple active lobbies
        if (!state.hasActiveLobby) {
            state.hasActiveLobby = true;
            state.activeLobbyId = _lobbyId;
        }
        state.activeLobbiesCount++;

        // Add joiner to lobby tracking and remove from open set
        _addPlayerToLobby(msg.sender, _lobbyId);
        _removeLobbyFromOpenSet(_lobbyId);

        emit GameAccepted(_lobbyId, msg.sender);
        emit PlayerJoinedLobby(_lobbyId, msg.sender);
    }

    function rejectGame(uint _lobbyId) public nonReentrant {
        Lobby storage lobby = lobbies[_lobbyId];
        if (lobby.basic.id == 0) revert LobbyNotFound();
        if (lobby.players.reservedJoiner == address(0)) revert LobbyNotReserved();
        if (msg.sender != lobby.players.reservedJoiner) revert NotReservedJoiner();
        if (lobby.state.status != LobbyStatus.Open) revert LobbyNotOpen();
        if (lobby.players.joiner != address(0)) revert LobbyFull();

        // Clear reserved joiner, making lobby open to anyone
        lobby.players.reservedJoiner = address(0);

        emit GameRejected(_lobbyId, msg.sender);
    }

    function timeoutJoiner(uint _lobbyId) public nonReentrant {
        Lobby storage lobby = lobbies[_lobbyId];
        if (lobby.basic.id == 0) revert LobbyNotFound();
        if (msg.sender != lobby.basic.creator) revert NotLobbyCreator();
        if (lobby.state.status != LobbyStatus.FleetSelection)
            revert LobbyNotOpen();
        if (lobby.players.joiner == address(0)) revert LobbyNotFound();
        if (lobby.players.joinerFleetId != 0) revert FleetAlreadyCreated();

        // Check if timeout has been reached
        if (
            block.timestamp < lobby.players.joinedAt + lobby.gameConfig.turnTime
        ) revert TimeoutNotReached();

        // HA4-03 fix (2026-09-28): only penalize the joiner if the creator
        // actually held up their own end (committed a fleet) first —
        // mirrors quitWithPenalty's symmetric check (it requires the
        // penalizing party to have already committed a fleet before it can
        // penalize the other side). Without this, a creator who never
        // creates a fleet could repeatedly call this against any joiner
        // who's simply waiting their turn, penalizing them for the
        // creator's own inaction, at near-zero repeatable cost (the min
        // 5-minute timeout, then immediately reusable against the next
        // victim). The lobby still resets to Open either way — the creator
        // can always reclaim it — just without the punitive kickCount when
        // they haven't proven good faith themselves.
        PlayerLobbyState storage joinerState = playerStates[
            lobby.players.joiner
        ];
        if (lobby.players.creatorFleetId != 0) {
            joinerState.kickCount++;
            joinerState.lastKickTime = block.timestamp;
        }
        _releasePlayerSlot(lobby.players.joiner, _lobbyId);
        kickedFromLobby[_lobbyId][lobby.players.joiner] = true;

        // Remove joiner from tracking and add lobby back to open set
        _removePlayerFromLobby(lobby.players.joiner, _lobbyId);
        _addLobbyToOpenSet(_lobbyId);

        // Reset lobby state. The creator may already have committed a fleet
        // (locking real ship NFTs via inFleet) before the joiner timed out —
        // clear it the same way leaveLobby/quitWithPenalty do, or those
        // ships are stuck inFleet=true forever with no remaining on-chain
        // reference to their fleet id.
        if (lobby.players.creatorFleetId != 0) {
            fleets.clearFleet(lobby.players.creatorFleetId);
        }

        lobby.players.joiner = address(0);
        lobby.state.status = LobbyStatus.Open;
        lobby.players.creatorFleetId = 0;
        lobby.players.joinerFleetId = 0;
        lobby.players.reservedJoiner = address(0);

        emit LobbyReset(_lobbyId, lobby.basic.creator);
    }

    function createFleet(
        uint _lobbyId,
        uint[] calldata _shipIds,
        Position[] calldata _startingPositions
    ) public nonReentrant {
        Lobby storage lobby = lobbies[_lobbyId];
        if (lobby.basic.id == 0) revert LobbyNotFound();
        if (lobby.state.status != LobbyStatus.FleetSelection)
            revert LobbyNotOpen();
        if (
            msg.sender != lobby.basic.creator &&
            msg.sender != lobby.players.joiner
        ) revert NotInLobby();

        // Check if player already has a fleet in this lobby
        if (
            msg.sender == lobby.basic.creator &&
            lobby.players.creatorFleetId != 0
        ) revert FleetAlreadyCreated();
        if (
            msg.sender == lobby.players.joiner &&
            lobby.players.joinerFleetId != 0
        ) revert FleetAlreadyCreated();

        // Create fleet through Fleets contract
        bool isCreator = (msg.sender == lobby.basic.creator);
        uint fleetId = fleets.createFleet(
            _lobbyId,
            msg.sender,
            _shipIds,
            _startingPositions,
            lobby.basic.costLimit,
            isCreator,
            lobby.gameConfig.selectedMapId
        );

        // Assign fleet to the correct player and determine who goes first
        if (msg.sender == lobby.basic.creator) {
            lobby.players.creatorFleetId = fleetId;
            // If creator is setting their fleet first, they go first
            if (lobby.players.joinerFleetId == 0) {
                lobby.gameConfig.creatorGoesFirst = true;
            }
        } else {
            lobby.players.joinerFleetId = fleetId;
            // If joiner is setting their fleet first, creator doesn't go first
            if (lobby.players.creatorFleetId == 0) {
                lobby.gameConfig.creatorGoesFirst = false;
            }
            // Record when joiner set their fleet
            lobby.players.joinerFleetSetAt = block.timestamp;
        }

        emit FleetCreated(_lobbyId, msg.sender, fleetId);

        // Check if both players have created fleets
        if (
            lobby.players.creatorFleetId != 0 &&
            lobby.players.joinerFleetId != 0
        ) {
            lobby.state.status = LobbyStatus.InGame;
            lobby.state.gameStartedAt = block.timestamp;
            emit GameStarted(_lobbyId);

            // Remove lobby from both players' tracking sets
            _removePlayerFromLobby(lobby.basic.creator, _lobbyId);
            _removePlayerFromLobby(lobby.players.joiner, _lobbyId);

            // Remove from open lobbies set
            _removeLobbyFromOpenSet(_lobbyId);

            // Decrement active lobbies count for both players
            _releasePlayerSlot(lobby.basic.creator, _lobbyId);
            _releasePlayerSlot(lobby.players.joiner, _lobbyId);

            // Remove from tracking sets when game starts
            _cleanupLobbyFromAllSets(_lobbyId);

            // Start the game — on whichever engine was pinned to this lobby
            // at creation time (UA-10 fix), not necessarily today's live
            // pvpMatch, so a lobby that's been sitting in FleetSelection
            // can't have its game silently switch engines out from under
            // an already-committed player.
            PvPMatch(lobby.gameConfig.pvpMatch).startGame(
                _lobbyId,
                lobby.basic.creator,
                lobby.players.joiner,
                lobby.players.creatorFleetId,
                lobby.players.joinerFleetId,
                lobby.gameConfig.creatorGoesFirst,
                lobby.gameConfig.turnTime,
                lobby.gameConfig.selectedMapId,
                lobby.gameConfig.maxScore
            );
        }
    }

    function quitWithPenalty(uint _lobbyId) public nonReentrant {
        Lobby storage lobby = lobbies[_lobbyId];
        if (lobby.basic.id == 0) revert LobbyNotFound();
        if (msg.sender != lobby.players.joiner) revert NotLobbyJoiner();
        if (lobby.state.status != LobbyStatus.FleetSelection)
            revert LobbyNotOpen();
        if (lobby.players.joinerFleetId == 0) revert NotInLobby();
        if (lobby.players.creatorFleetId != 0) revert FleetAlreadyCreated();

        // Check if creator's timeout has been reached
        if (
            block.timestamp <
            lobby.players.joinerFleetSetAt + lobby.gameConfig.turnTime
        ) revert CreatorTimeoutNotReached();

        // Clear joiner's fleet through Fleets contract
        fleets.clearFleet(lobby.players.joinerFleetId);

        // Apply penalty to creator
        PlayerLobbyState storage creatorState = playerStates[
            lobby.basic.creator
        ];
        creatorState.kickCount++;
        creatorState.lastKickTime = block.timestamp;

        // The joiner leaves; the lobby reopens with the (penalized) creator
        // still its owner — same as timeoutJoiner's reset. The creator stays
        // tracked in it (count and membership unchanged), so they can still
        // leaveLobby it later; removing them from tracking here used to
        // leave an open lobby whose creator could never leave it (HA6-10).
        _releasePlayerSlot(lobby.players.joiner, _lobbyId);
        _removePlayerFromLobby(lobby.players.joiner, _lobbyId);
        _addLobbyToOpenSet(_lobbyId);

        // Reset lobby state
        lobby.players.joiner = address(0);
        lobby.state.status = LobbyStatus.Open;
        lobby.players.creatorFleetId = 0;
        lobby.players.joinerFleetId = 0;
        lobby.players.reservedJoiner = address(0);

        emit LobbyTerminated(_lobbyId);
    }

    // Owner function to create a lobby with both creator and joiner already set
    // Bypasses paused state, timeout checks, and fee requirements
    // Who goes first is determined by who creates their fleet first (not a lobby setting)
    function createLobbyForAddresses(
        address _creator,
        address _joiner,
        uint _costLimit,
        uint _turnTime,
        uint _selectedMapId,
        uint _maxScore
    ) public onlyOwner {
        if (_turnTime < MIN_TIMEOUT || _turnTime > MAX_TURN_TIME)
            revert InvalidTurnTime();
        if (_creator == _joiner) revert PlayerAlreadyInLobby();
        if (_costLimit > maxFleetCostLimit) revert MaxFleetCostExceeded();

        // Validate mapId: 0 means no preset map (valid), otherwise must
        // exist and be valid for PvP.
        if (_selectedMapId > 0) {
            _requireMapUsableForPvP(_selectedMapId);
        }

        lobbyCount++;
        Lobby storage newLobby = lobbies[lobbyCount];
        newLobby.basic.id = lobbyCount;
        newLobby.basic.creator = _creator;
        newLobby.basic.costLimit = _costLimit;
        newLobby.state.status = LobbyStatus.FleetSelection; // Both players set, ready for fleet selection
        newLobby.basic.createdAt = block.timestamp;
        newLobby.gameConfig.turnTime = _turnTime;
        newLobby.gameConfig.selectedMapId = _selectedMapId;
        newLobby.gameConfig.maxScore = _maxScore;
        // UA-10 fix: pin which PvPMatch/engine this lobby's eventual game
        // starts on, at creation time — see LobbyGameConfig.pvpMatch.
        newLobby.gameConfig.pvpMatch = address(pvpMatch);
        // creatorGoesFirst will be set when fleets are created based on who creates first

        // Set joiner immediately
        newLobby.players.joiner = _joiner;
        newLobby.players.joinedAt = block.timestamp;

        // Update creator's state
        PlayerLobbyState storage creatorState = playerStates[_creator];
        creatorState.hasActiveLobby = true;
        creatorState.activeLobbyId = lobbyCount;
        creatorState.activeLobbiesCount++;

        // Update joiner's state
        PlayerLobbyState storage joinerState = playerStates[_joiner];
        joinerState.hasActiveLobby = true;
        joinerState.activeLobbyId = lobbyCount;
        joinerState.activeLobbiesCount++;

        // Add both players to tracking sets (not open for joining since both players are set)
        _addPlayerToLobby(_creator, lobbyCount);
        _addPlayerToLobby(_joiner, lobbyCount);
        // Don't add to open set since lobby is already full

        emit LobbyCreated(
            lobbyCount,
            _creator,
            _costLimit,
            _turnTime,
            false, // creatorGoesFirst - will be determined by fleet creation order
            _selectedMapId,
            _maxScore
        );
        emit PlayerJoinedLobby(lobbyCount, _joiner);
    }

    // Owner functions
    function setFreeGamesPerAddress(uint _count) public onlyOwner {
        freeGamesPerAddress = _count;
    }

    function setAdditionalLobbyFee(uint _fee) public onlyOwner {
        additionalLobbyFee = _fee;
    }

    function setPaused(bool _paused) public onlyOwner {
        paused = _paused;
    }

    function setMaxFleetCostLimit(uint _maxFleetCostLimit) public onlyOwner {
        maxFleetCostLimit = _maxFleetCostLimit;
        emit MaxFleetCostLimitUpdated(_maxFleetCostLimit);
    }

    function setStaleLobbyThreshold(uint _threshold) public onlyOwner {
        staleLobbyThreshold = _threshold;
        emit StaleLobbyThresholdUpdated(_threshold);
    }

    function withdraw() public onlyOwner {
        (bool success, ) = payable(owner()).call{value: address(this).balance}(
            ""
        );
        require(success, "Withdrawal failed");
    }

    /**
     * @dev Withdraw accumulated UTC reservation fees to `_to`. HA3-01 fix:
     * without this, every reserved-lobby's 1 UTC fee is permanently locked
     * in this contract — the ETH-only withdraw() above never touches it.
     */
    function withdrawUC(address _to) external onlyOwner {
        uint amount = universalCredits.balanceOf(address(this));
        require(universalCredits.transfer(_to, amount), "UTC transfer failed");
        emit Withdrawn(_to, amount);
    }

    // View functions
    function getLobby(uint _lobbyId) public view returns (Lobby memory) {
        return lobbies[_lobbyId];
    }

    function getPlayerState(
        address _player
    ) public view returns (PlayerLobbyState memory) {
        return playerStates[_player];
    }

    function getPlayerTimeoutEnd(address _player) public view returns (uint) {
        PlayerLobbyState storage state = playerStates[_player];
        if (state.kickCount == 0) return 0;
        return state.lastKickTime + (state.kickCount * KICK_PENALTY_PER_HOUR);
    }

    // New view functions for lobby tracking
    function getPlayerLobbies(
        address _player
    ) public view returns (uint[] memory) {
        return playerLobbies[_player].values();
    }

    function getOpenLobbies() public view returns (uint[] memory) {
        return openLobbyIds.values();
    }

    // Bounded escape hatch for getOpenLobbies (see docs/pre-audit.md GR-03)
    // — pruneStaleLobby caps long-run growth, but a "browse open lobbies"
    // UI should page through this rather than assume the full set is ever
    // small. _offset is 0-indexed into the set; returns fewer than _limit
    // entries (down to an empty array) if the range runs past the set's
    // current size, rather than reverting.
    function getOpenLobbiesPaginated(
        uint _offset,
        uint _limit
    ) public view returns (uint[] memory) {
        uint total = openLobbyIds.length();
        if (_offset >= total) return new uint[](0);
        uint end = _offset + _limit;
        if (end > total) end = total;
        uint[] memory result = new uint[](end - _offset);
        for (uint i = _offset; i < end; i++) {
            result[i - _offset] = openLobbyIds.at(i);
        }
        return result;
    }

    function getLobbiesFromIds(
        uint[] calldata _lobbyIds
    ) public view returns (Lobby[] memory) {
        Lobby[] memory result = new Lobby[](_lobbyIds.length);
        for (uint i = 0; i < _lobbyIds.length; i++) {
            result[i] = lobbies[_lobbyIds[i]];
        }
        return result;
    }

    function getPlayerLobbyCount(address _player) public view returns (uint) {
        return playerLobbies[_player].length();
    }

    function getOpenLobbyCount() public view returns (uint) {
        return openLobbyIds.length();
    }

    function isPlayerInLobby(
        address _player,
        uint _lobbyId
    ) public view returns (bool) {
        return playerLobbies[_player].contains(_lobbyId);
    }

    function isLobbyOpen(uint _lobbyId) public view returns (bool) {
        return openLobbyIds.contains(_lobbyId);
    }

}

// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./Types.sol";
import "./IWorldID.sol";
import "./ByteHasher.sol";
import "./IWinEffect.sol";
import "./IRandomManager.sol";

/// @dev Minimal reader for the deployed GameResults contract. `getGameResult`
/// reverts with GameNotFound when no result has been recorded for the id.
interface IGameResultsReader {
    function getGameResult(uint _gameId) external view returns (GameResult memory);
}

/// @dev Minimal reader for the deployed Game contract, used only to verify a
/// draw actually happened (draws are never written to GameResults, so
/// recordResult can't see them). getGame reverts with GameNotFound if the id
/// doesn't exist.
interface IGameReader {
    function getGame(uint _gameId) external view returns (GameDataView memory);
    // G-04: resolveDraw only ever touches metadata fields — this avoids
    // paying for getGame's full ship-data walk.
    function getGameMetadataAndTurnState(
        uint _gameId
    ) external view returns (GameMetadata memory, GameTurnState memory);
}

/// @title Tournament
/// @notice Single-elimination tournaments for Void Tactics. One human (World ID)
///         per registration. Matches are played in the existing Game contract;
///         winners are read trustlessly from GameResults on the same chain.
contract Tournament is Ownable, ReentrancyGuard {
    using ByteHasher for bytes;

    enum TournamentState {
        Registration,
        // Registration has closed and round-1 pairing randomness has been
        // requested (see RandomManager) but not yet revealed/applied —
        // buildBracket() moves a tournament from here to Active. Kept
        // separate from Registration/Active so no comparison site needs to
        // change; every existing state check already uses == / != against
        // named values, never ordinal comparison.
        Starting,
        Active,
        Complete,
        Cancelled
    }

    struct TournamentConfig {
        uint256 entryFee; // native wei; 0 == free entry
        uint32 minPlayers; // >= 2
        uint32 maxPlayers; // cap
        uint64 lastStartTime; // unix seconds; start / cancel gate
        // Fixed per-match game config, applied to every match's lobby:
        uint256 costLimit;
        uint256 turnTime;
        uint256 selectedMapId;
        uint256 maxScore;
        // T-05: seconds after a match becomes ready (both players known) before
        // claimForfeitWin becomes callable if neither player has started a game yet.
        uint256 matchTimeout;
    }

    struct Match {
        uint256 matchId;
        uint8 round; // 0 == first round
        address player1;
        address player2; // address(0) == bye / not-yet-determined
        address winner;
        uint256 gameId; // == lobbyId of the played PvP game (0 until assigned)
        uint256 readyAt; // block.timestamp both player1 and player2 were set
        bytes32 walrusBlobId; // opaque match-record pointer
        bool resolved;
    }

    struct TournamentData {
        uint256 id;
        address creator;
        TournamentState state;
        TournamentConfig config;
        uint256 prizePool; // entry fees + sponsor contribution
        address sponsor; // single sponsor (address(0) if none)
        uint256 sponsorAmount;
        address[] registrants; // registration order; NOT seed order (seed is shuffled in buildBracket)
        mapping(address => bool) registered;
        mapping(address => uint32) seed; // 1-based shuffled seed (0 == not registered / not yet shuffled)
        mapping(uint256 => bool) usedNullifiers;
        uint256 randomRequestId; // RandomManager request backing this tournament's seed shuffle
        // HA2-07: buildBracket() must reveal randomRequestId by this
        // timestamp or it's considered stale — see SHUFFLE_REVEAL_WINDOW.
        uint256 shuffleDeadline;
        Match[] bracket; // flattened single-elim bracket, all slots pre-allocated
        uint32 bracketSize; // N (next power of 2 >= registrants)
        uint8 totalRounds; // log2(N)
        address champion;
        address runnerUp;
        bool prizesDistributed;
        mapping(address => uint256) winnings; // pull-payment balances
        mapping(address => bool) refunded;
    }

    // ---- Config ----
    IWorldID public worldId; // World ID router; mutable so it can be repointed
    uint256 public immutable groupId; // 1 for Orb (on-chain verification)
    IGameResultsReader public immutable gameResults;
    IGameReader public immutable game;
    IRandomManager public immutable randomManager;
    uint256 public externalNullifier; // hash(appId, action)
    address public feeRecipient;
    uint16 public constant PROTOCOL_FEE_BPS = 100; // 1.00%
    uint256 public constant MIN_MATCH_TIMEOUT = 3600; // 1 hour
    uint256 public constant MAX_MATCH_TIMEOUT = 604800; // 1 week
    // HA2-07: a patient outside observer can preview, for free, what
    // buildBracket()'s shuffle would produce for the current RandomManager
    // epoch (the registrant list is already frozen by start()) and simply
    // decline to submit until a favorable epoch appears. Starting had no
    // timeout, so that wait was unbounded. This constant bounds it: once a
    // pending shuffle request outlives this window unused, anyone can force
    // a fresh one via rerollBracketShuffle, discarding whatever epochs were
    // being ground through against the stale request. Doesn't remove the
    // preview-and-decline ability itself (that requires a real multi-party
    // secret or an external VRF — see docs/audit-2.md HA2-07), but bounds
    // how many free looks a single stale request can be checked against
    // before it's invalidated out from under whoever was waiting on it.
    uint256 public constant SHUFFLE_REVEAL_WINDOW = 10 minutes;

    uint256 public tournamentCount;
    mapping(uint256 => TournamentData) internal tournaments;

    // Pluggable win effects (see IWinEffect.sol) — fires for the champion
    // only (not the runner-up) when a tournament finalizes, same mechanism
    // roguelike combat nodes and PvP matches use. One flat list across
    // every tournament run by this contract, not per-tournament — empty by
    // default (opt-in), same as PvPMatch.winEffects.
    // Private + explicit getter (not a bare public array) so callers get a
    // full-array read in one call, matching RoguelikeNodeMap.
    // getNodeWinEffects — a public array only auto-generates an index
    // accessor, not a length/full-array getter.
    address[] private winEffects;

    // ---- Events ----
    event TournamentCreated(
        uint256 indexed tournamentId,
        address indexed creator,
        uint256 entryFee,
        uint32 minPlayers,
        uint32 maxPlayers,
        uint64 lastStartTime
    );
    event SponsorAdded(uint256 indexed tournamentId, address indexed sponsor, uint256 amount);
    event Registered(uint256 indexed tournamentId, address indexed player, uint256 nullifierHash);
    // Fires when start() closes registration and requests the seed-shuffle
    // randomness; buildBracket() must be called afterward (once the
    // RandomManager reveal window opens) to actually build the bracket and
    // move the tournament to Active — see TournamentStarted below.
    event TournamentClosing(uint256 indexed tournamentId, uint256 randomRequestId);
    // HA2-07: fires when a pending shuffle request expired unused (see
    // SHUFFLE_REVEAL_WINDOW) and rerollBracketShuffle replaced it.
    event BracketShuffleRerolled(uint256 indexed tournamentId, uint256 newRandomRequestId);
    event TournamentStarted(uint256 indexed tournamentId, uint8 totalRounds, uint256 matchCount);
    event MatchGameAssigned(uint256 indexed tournamentId, uint256 indexed matchId, uint256 gameId);
    event MatchResolved(uint256 indexed tournamentId, uint256 indexed matchId, address winner, bytes32 walrusBlobId);
    event NextRoundMatchCreated(uint256 indexed tournamentId, uint256 indexed matchId, uint8 round);
    event TournamentFinalized(uint256 indexed tournamentId, address champion, address runnerUp);
    event PrizeClaimed(uint256 indexed tournamentId, address indexed player, uint256 amount);
    event TournamentCancelled(uint256 indexed tournamentId);
    event Refunded(uint256 indexed tournamentId, address indexed player, uint256 amount);
    event MatchForfeited(uint256 indexed tournamentId, uint256 indexed matchId, address winner, address loser);
    event MatchStalled(uint256 indexed tournamentId, uint256 indexed matchId, address winner, address loser);
    event WinEffectsSet(uint effectCount);
    event WinEffectFailed(address indexed player, uint indexed tournamentId, address indexed resolver);

    // ---- Errors ----
    error TournamentNotFound();
    error NotInRegistration();
    error RegistrationClosed();
    error AlreadyRegistered();
    error NullifierUsed();
    error WrongEntryFee();
    error RegistrationFull();
    error StartConditionsNotMet();
    error CancelConditionsNotMet();
    error NotActive();
    error NotCancelled();
    error MatchNotFound();
    error MatchAlreadyResolved();
    error MatchNotReady();
    error GameNotAssigned();
    error WinnerNotInMatch();
    error FinalNotResolved();
    error AlreadyFinalized();
    error NothingToClaim();
    error InvalidConfig();
    error SponsorAlreadySet();
    error NoSponsorContribution();
    error TransferFailed();
    error GameNotComplete();
    error NotADraw();
    error GamePredatesAssignment();
    error MatchTimeoutNotReached();
    error GameAlreadyAssigned();
    error NotAMatchPlayer();
    error NotStarting();
    error ShuffleWindowExpired();
    error ShuffleWindowNotExpired();

    constructor(
        address _worldId,
        uint256 _groupId,
        uint256 _externalNullifier,
        address _gameResults,
        address _game,
        address _feeRecipient,
        address _randomManager
    ) Ownable(msg.sender) {
        worldId = IWorldID(_worldId);
        groupId = _groupId;
        externalNullifier = _externalNullifier;
        gameResults = IGameResultsReader(_gameResults);
        game = IGameReader(_game);
        feeRecipient = _feeRecipient;
        randomManager = IRandomManager(_randomManager);
    }

    // ---- Owner config ----
    function setWorldId(address _worldId) external onlyOwner {
        worldId = IWorldID(_worldId);
    }

    function setExternalNullifier(uint256 _externalNullifier) external onlyOwner {
        externalNullifier = _externalNullifier;
    }

    function setFeeRecipient(address _feeRecipient) external onlyOwner {
        feeRecipient = _feeRecipient;
    }

    /// @dev Full-replace the win-effect list, same "full replace, not
    /// add/remove" shape as RoguelikeNodeMap.setNodeWinEffects.
    function setWinEffects(address[] calldata _effects) external onlyOwner {
        winEffects = _effects;
        emit WinEffectsSet(_effects.length);
    }

    function getWinEffects() external view returns (address[] memory) {
        return winEffects;
    }

    // ---- Creation & funding ----
    function createTournament(
        TournamentConfig calldata cfg
    ) external payable returns (uint256 tournamentId) {
        if (
            cfg.minPlayers < 2 ||
            cfg.maxPlayers < cfg.minPlayers ||
            cfg.lastStartTime <= block.timestamp ||
            cfg.matchTimeout < MIN_MATCH_TIMEOUT ||
            cfg.matchTimeout > MAX_MATCH_TIMEOUT
        ) revert InvalidConfig();

        tournamentId = ++tournamentCount;
        TournamentData storage t = tournaments[tournamentId];
        t.id = tournamentId;
        t.creator = msg.sender;
        t.state = TournamentState.Registration;
        t.config = cfg;

        if (msg.value > 0) {
            t.sponsor = msg.sender;
            t.sponsorAmount = msg.value;
            t.prizePool = msg.value;
        }

        emit TournamentCreated(
            tournamentId,
            msg.sender,
            cfg.entryFee,
            cfg.minPlayers,
            cfg.maxPlayers,
            cfg.lastStartTime
        );
    }

    function addSponsorPrize(uint256 tournamentId) external payable {
        TournamentData storage t = _get(tournamentId);
        if (
            t.state != TournamentState.Registration &&
            t.state != TournamentState.Starting &&
            t.state != TournamentState.Active
        ) revert NotInRegistration();

        // HA4-04 fix (2026-09-29): only a real contribution claims the
        // sponsor slot — matches createTournament's own `msg.value > 0`
        // gate on the same field. Without this, any address could squat
        // the slot for free the instant a tournament is created, then
        // SponsorAlreadySet blocks every later contribution from anyone
        // else, including the tournament's intended real backer.
        if (t.sponsor == address(0)) {
            if (msg.value == 0) revert NoSponsorContribution();
            t.sponsor = msg.sender;
        } else if (t.sponsor != msg.sender) {
            revert SponsorAlreadySet();
        }
        t.sponsorAmount += msg.value;
        t.prizePool += msg.value;
        emit SponsorAdded(tournamentId, msg.sender, msg.value);
    }

    // ---- Registration (World ID gate) ----
    function register(
        uint256 tournamentId,
        uint256 root,
        uint256 nullifierHash,
        uint256[8] calldata proof
    ) external payable {
        TournamentData storage t = _get(tournamentId);
        if (t.state != TournamentState.Registration) revert NotInRegistration();
        if (block.timestamp > t.config.lastStartTime) revert RegistrationClosed();
        if (t.registrants.length >= t.config.maxPlayers) revert RegistrationFull();
        if (msg.value != t.config.entryFee) revert WrongEntryFee();
        if (t.registered[msg.sender]) revert AlreadyRegistered();
        if (t.usedNullifiers[nullifierHash]) revert NullifierUsed();

        worldId.verifyProof(
            root,
            groupId,
            abi.encodePacked(msg.sender).hashToField(),
            nullifierHash,
            externalNullifier,
            proof
        );

        t.usedNullifiers[nullifierHash] = true;
        t.registered[msg.sender] = true;
        t.registrants.push(msg.sender);
        // Seed is intentionally NOT assigned here — it's shuffled from
        // registration order in buildBracket(), after registration closes,
        // so no one (including the registrant themselves) can predict their
        // round-1 opponent by choosing when to register.
        t.prizePool += msg.value;

        emit Registered(tournamentId, msg.sender, nullifierHash);
    }

    // ---- Start / cancel ----
    function start(uint256 tournamentId) external {
        TournamentData storage t = _get(tournamentId);
        if (t.state != TournamentState.Registration) revert NotInRegistration();

        uint256 n = t.registrants.length;
        bool atMax = n == t.config.maxPlayers;
        bool timeUp = block.timestamp > t.config.lastStartTime;
        if (!(atMax || (timeUp && n >= t.config.minPlayers)))
            revert StartConditionsNotMet();

        // Request the round-1 pairing randomness now, before anything about
        // the bracket is decided — buildBracket() (permissionless, callable
        // once the reveal window opens) does the actual shuffle + bracket
        // construction. Splitting this into two steps is what makes the
        // pairing genuinely unknowable at the moment registration closes:
        // RandomManager can't reveal in the same transaction as the
        // request (see its own header comment), so nobody — including
        // whoever calls start() — can preview the shuffle before commiting
        // to it.
        uint256 requestId = randomManager.requestRandomness();
        t.randomRequestId = requestId;
        t.shuffleDeadline = block.timestamp + SHUFFLE_REVEAL_WINDOW;
        t.state = TournamentState.Starting;
        emit TournamentClosing(tournamentId, requestId);
    }

    /// @notice Reveals this tournament's seed-shuffle randomness and builds
    /// the bracket. Permissionless (like assignMatchGame/recordResult) so no
    /// single party staying offline can block every registrant from ever
    /// reaching Active. Reverts with RandomManager's own TooSoonToReveal if
    /// called before the reveal window has opened, or ShuffleWindowExpired
    /// if the pending request outlived SHUFFLE_REVEAL_WINDOW unused (HA2-07)
    /// — call rerollBracketShuffle in that case to get a fresh request.
    function buildBracket(uint256 tournamentId) external {
        TournamentData storage t = _get(tournamentId);
        if (t.state != TournamentState.Starting) revert NotStarting();
        if (block.timestamp > t.shuffleDeadline) revert ShuffleWindowExpired();

        uint64 randomness = randomManager.fulfillRandomRequest(t.randomRequestId);
        address[] memory bySeed = _shuffleSeeds(t, randomness);
        _buildBracket(t, bySeed);
        t.state = TournamentState.Active;
        emit TournamentStarted(tournamentId, t.totalRounds, t.bracket.length);
    }

    /// @notice HA2-07 escape hatch: once a pending shuffle request has sat
    /// unused past SHUFFLE_REVEAL_WINDOW, anyone can force a fresh
    /// RandomManager request, discarding whatever epochs a patient observer
    /// may have been previewing against the stale one. Permissionless, same
    /// reasoning as buildBracket itself — no single (possibly hostile)
    /// party staying offline should be able to block progress, and here
    /// that includes a party deliberately withholding a favorable reveal.
    function rerollBracketShuffle(uint256 tournamentId) external {
        TournamentData storage t = _get(tournamentId);
        if (t.state != TournamentState.Starting) revert NotStarting();
        if (block.timestamp <= t.shuffleDeadline) revert ShuffleWindowNotExpired();

        uint256 requestId = randomManager.requestRandomness();
        t.randomRequestId = requestId;
        t.shuffleDeadline = block.timestamp + SHUFFLE_REVEAL_WINDOW;
        emit BracketShuffleRerolled(tournamentId, requestId);
    }

    function cancel(uint256 tournamentId) external {
        TournamentData storage t = _get(tournamentId);
        if (t.state != TournamentState.Registration) revert NotInRegistration();
        if (
            block.timestamp <= t.config.lastStartTime ||
            t.registrants.length >= t.config.minPlayers
        ) revert CancelConditionsNotMet();
        t.state = TournamentState.Cancelled;
        emit TournamentCancelled(tournamentId);
    }

    function claimRefund(uint256 tournamentId) external nonReentrant {
        TournamentData storage t = _get(tournamentId);
        if (t.state != TournamentState.Cancelled) revert NotCancelled();

        uint256 amount;
        if (t.registered[msg.sender] && !t.refunded[msg.sender]) {
            t.refunded[msg.sender] = true;
            amount += t.config.entryFee;
        }
        if (msg.sender == t.sponsor && t.sponsorAmount > 0) {
            amount += t.sponsorAmount;
            t.sponsorAmount = 0;
        }
        if (amount == 0) revert NothingToClaim();

        _send(msg.sender, amount);
        emit Refunded(tournamentId, msg.sender, amount);
    }

    // ---- Match wiring & results ----
    /// @notice T-03: permissionless, not creator-only. assignMatchGame alone never
    /// resolves anything — recordResult/resolveDraw independently re-verify
    /// participant matching, freshness (readyAt), and win/draw state before any
    /// payout, and a wrong assignment can simply be overwritten by anyone before
    /// the match resolves. Keeping the creator's involvement mandatory here would
    /// mean an unresponsive creator permanently locks every unresolved match (and
    /// the whole prize pool) — the players can already pair themselves up via
    /// Lobbies.createLobby's reservedJoiner with no creator involvement, so this
    /// was the last remaining dependency on the creator staying active.
    function assignMatchGame(
        uint256 tournamentId,
        uint256 matchId,
        uint256 gameId
    ) external {
        TournamentData storage t = _get(tournamentId);
        if (t.state != TournamentState.Active) revert NotActive();
        if (matchId >= t.bracket.length) revert MatchNotFound();
        Match storage m = t.bracket[matchId];
        if (m.resolved) revert MatchAlreadyResolved();
        if (m.player1 == address(0) || m.player2 == address(0)) revert MatchNotReady();
        // HA3-03: assignment is sticky (once set, never reassignable) and
        // validated up front — otherwise a match's own losing player could
        // clobber a correct assignment with garbage forever, blocking both
        // recordResult/resolveDraw AND claimForfeitWin/resolveStalledMatch
        // (both require gameId == 0, which nothing else can ever restore),
        // permanently freezing this match and, transitively, the entire
        // bracket and prize pool above it. Same participant/timing checks
        // recordResult/resolveDraw already re-verify independently, moved
        // up front so a bad gameId can never be accepted in the first place.
        if (m.gameId != 0) revert GameAlreadyAssigned();
        (GameMetadata memory gameMetadata, ) = game
            .getGameMetadataAndTurnState(gameId);
        bool ok = (gameMetadata.creator == m.player1 && gameMetadata.joiner == m.player2) ||
            (gameMetadata.creator == m.player2 && gameMetadata.joiner == m.player1);
        if (!ok) revert WinnerNotInMatch();
        if (gameMetadata.startedAt <= m.readyAt) revert GamePredatesAssignment();
        m.gameId = gameId;
        emit MatchGameAssigned(tournamentId, matchId, gameId);
    }

    /// @notice Resolve a match from the canonical on-chain game result. Permissionless:
    /// the winner is read from GameResults and validated against the match players.
    function recordResult(
        uint256 tournamentId,
        uint256 matchId,
        bytes32 walrusBlobId
    ) external {
        TournamentData storage t = _get(tournamentId);
        if (t.state != TournamentState.Active) revert NotActive();
        if (matchId >= t.bracket.length) revert MatchNotFound();
        Match storage m = t.bracket[matchId];
        if (m.resolved) revert MatchAlreadyResolved();
        if (m.gameId == 0) revert GameNotAssigned();

        // Reverts (GameNotFound) if the game result has not been recorded yet.
        GameResult memory gr = gameResults.getGameResult(m.gameId);
        bool ok = (gr.winner == m.player1 && gr.loser == m.player2) ||
            (gr.winner == m.player2 && gr.loser == m.player1);
        if (!ok) revert WinnerNotInMatch();
        // T-02: participant matching alone isn't enough — gameId is a shared,
        // permanent id space for PvP games (== lobbyId; single-player node
        // matches use a disjoint id range and never appear here), so without
        // this a stale game the same two players happened to play before
        // this specific pairing even existed would otherwise pass. Requiring the result to postdate the
        // moment both players were determined for this match (readyAt) closes the
        // replay-an-old-game path (residual risk: the two players could still
        // collude to play a fresh, off-bracket game after that point — this can't
        // rule that out, only rule out reusing history from before the pairing).
        if (gr.timestamp <= m.readyAt) revert GamePredatesAssignment();

        _resolve(t, matchId, gr.winner, walrusBlobId);
    }

    /// @notice Resolve a match that ended in a draw. A draw sets the game's winner
    /// to address(0) and is never written to GameResults, so it can't flow through
    /// recordResult — this reads the actual game state from Game directly instead,
    /// verifying the game is finished (`ended`), genuinely drew (`winner ==
    /// address(0)`), and its participants match this match's two players, the same
    /// way recordResult validates against GameResults. The winner is still the
    /// deterministic lower-seeded player (draws don't produce a natural winner to
    /// read), but permissionless like recordResult now that the draw itself is
    /// verified on-chain instead of taken on the creator's word.
    function resolveDraw(
        uint256 tournamentId,
        uint256 matchId,
        bytes32 walrusBlobId
    ) external {
        TournamentData storage t = _get(tournamentId);
        if (t.state != TournamentState.Active) revert NotActive();
        if (matchId >= t.bracket.length) revert MatchNotFound();
        Match storage m = t.bracket[matchId];
        if (m.resolved) revert MatchAlreadyResolved();
        if (m.player1 == address(0) || m.player2 == address(0)) revert MatchNotReady();
        if (m.gameId == 0) revert GameNotAssigned();

        (GameMetadata memory gameMetadata, ) = game
            .getGameMetadataAndTurnState(m.gameId);
        if (!gameMetadata.ended) revert GameNotComplete();
        if (gameMetadata.winner != address(0)) revert NotADraw();
        bool ok = (gameMetadata.creator == m.player1 && gameMetadata.joiner == m.player2) ||
            (gameMetadata.creator == m.player2 && gameMetadata.joiner == m.player1);
        if (!ok) revert WinnerNotInMatch();
        // T-02: same reasoning as recordResult — require the game to have started
        // after both players were determined for this match (readyAt), so an old
        // pre-existing draw between the same two players can't be replayed here.
        if (gameMetadata.startedAt <= m.readyAt) revert GamePredatesAssignment();

        address winner = t.seed[m.player1] <= t.seed[m.player2]
            ? m.player1
            : m.player2;
        _resolve(t, matchId, winner, walrusBlobId);
    }

    /// @notice T-05: claim a walkover win when the opponent never showed up to
    /// play at all. Only callable by one of the two match players, only once
    /// matchTimeout has elapsed since both players were determined (readyAt), and
    /// only if no game was ever assigned — if a game exists but stalls mid-play,
    /// use Game.endGameOnTimeout + recordResult instead (M-07), not this.
    function claimForfeitWin(uint256 tournamentId, uint256 matchId) external {
        TournamentData storage t = _get(tournamentId);
        if (t.state != TournamentState.Active) revert NotActive();
        if (matchId >= t.bracket.length) revert MatchNotFound();
        Match storage m = t.bracket[matchId];
        if (m.resolved) revert MatchAlreadyResolved();
        if (m.player1 == address(0) || m.player2 == address(0)) revert MatchNotReady();
        if (msg.sender != m.player1 && msg.sender != m.player2) revert NotAMatchPlayer();
        if (m.gameId != 0) revert GameAlreadyAssigned();
        if (block.timestamp <= m.readyAt + t.config.matchTimeout)
            revert MatchTimeoutNotReached();

        address winner = msg.sender;
        address loser = msg.sender == m.player1 ? m.player2 : m.player1;
        emit MatchForfeited(tournamentId, matchId, winner, loser);
        _resolve(t, matchId, winner, bytes32(0));
    }

    /// @notice Anyone may force-resolve a match that neither player ever
    /// engaged with (no game assigned, no forfeit claimed) once matchTimeout
    /// has elapsed — the same window either player already had via
    /// claimForfeitWin. Prevents two silent/colluding registrants (trivially
    /// achievable with unlimited free accounts, since seed == registration
    /// order and pairing is deterministic) from permanently freezing every
    /// other registrant's and sponsor's prize money with no recovery path.
    /// Winner is decided by the same seed-tiebreak resolveDraw already uses,
    /// so the outcome is deterministic and gameable by no one at this point.
    function resolveStalledMatch(uint256 tournamentId, uint256 matchId) external {
        TournamentData storage t = _get(tournamentId);
        if (t.state != TournamentState.Active) revert NotActive();
        if (matchId >= t.bracket.length) revert MatchNotFound();
        Match storage m = t.bracket[matchId];
        if (m.resolved) revert MatchAlreadyResolved();
        if (m.player1 == address(0) || m.player2 == address(0)) revert MatchNotReady();
        if (m.gameId != 0) revert GameAlreadyAssigned();
        if (block.timestamp <= m.readyAt + t.config.matchTimeout)
            revert MatchTimeoutNotReached();

        address winner = t.seed[m.player1] <= t.seed[m.player2] ? m.player1 : m.player2;
        address loser = winner == m.player1 ? m.player2 : m.player1;
        emit MatchStalled(tournamentId, matchId, winner, loser);
        _resolve(t, matchId, winner, bytes32(0));
    }

    // ---- Finalize & claim ----
    function finalize(uint256 tournamentId) external {
        TournamentData storage t = _get(tournamentId);
        if (t.state != TournamentState.Active) revert NotActive();
        if (t.champion == address(0)) revert FinalNotResolved();
        if (t.prizesDistributed) revert AlreadyFinalized();

        uint256 pool = t.prizePool;
        uint256 fee = (pool * PROTOCOL_FEE_BPS) / 10000;
        uint256 remainder = pool - fee;
        uint256 second = (remainder * 40) / 100;
        uint256 first = remainder - second; // 60% + integer dust

        if (fee > 0) t.winnings[feeRecipient] += fee;
        t.winnings[t.champion] += first;
        t.winnings[t.runnerUp] += second;

        t.prizesDistributed = true;
        t.state = TournamentState.Complete;
        emit TournamentFinalized(tournamentId, t.champion, t.runnerUp);

        // Champion only, not the runner-up — a win effect is for winning,
        // matching PvP (winner only) and roguelike (whoever won the node).
        // Each call is individually try/catch'd so a broken resolver can't
        // block prize distribution, which has already been committed
        // above by this point regardless — same reasoning as
        // RoguelikeMatch/PvPMatch's matching dispatch loops.
        for (uint i = 0; i < winEffects.length; i++) {
            try IWinEffect(winEffects[i]).onWin(t.champion, tournamentId) {} catch {
                emit WinEffectFailed(t.champion, tournamentId, winEffects[i]);
            }
        }
    }

    function claim(uint256 tournamentId) external nonReentrant {
        TournamentData storage t = _get(tournamentId);
        uint256 amount = t.winnings[msg.sender];
        if (amount == 0) revert NothingToClaim();
        t.winnings[msg.sender] = 0;
        _send(msg.sender, amount);
        emit PrizeClaimed(tournamentId, msg.sender, amount);
    }

    // ---- Internal: bracket ----

    /// @dev Fisher-Yates shuffle of registration order into t.seed, driven
    /// by the single revealed randomness value. Each swap draws a fresh
    /// pseudo-random value by re-hashing with an incrementing counter, the
    /// same "expand one seed into many draws" approach GenerateNewShip.sol
    /// already uses for ship traits, rather than trying to stretch one
    /// uint64 across many independent draws directly. _buildBracket's
    /// pairing math (standard 1-vs-N seeding) is completely unaffected by
    /// this — only which registrant lands on which seed number changes.
    /// Returns the shuffled order itself (bySeed[i] is the registrant
    /// holding seed i+1) so _buildBracket can place players without
    /// re-deriving it from t.seed one lookup at a time.
    function _shuffleSeeds(
        TournamentData storage t,
        uint64 randomness
    ) internal returns (address[] memory) {
        uint256 n = t.registrants.length;
        address[] memory order = new address[](n);
        for (uint256 i = 0; i < n; i++) {
            order[i] = t.registrants[i];
        }
        for (uint256 i = n; i > 1; i--) {
            randomness++;
            uint256 j = uint256(keccak256(abi.encodePacked(randomness))) % i;
            (order[i - 1], order[j]) = (order[j], order[i - 1]);
        }
        for (uint256 i = 0; i < n; i++) {
            t.seed[order[i]] = uint32(i + 1);
        }
        return order;
    }

    function _buildBracket(
        TournamentData storage t,
        address[] memory bySeed
    ) internal {
        uint256 count = t.registrants.length;
        uint256 n = 2;
        uint8 rounds = 1;
        while (n < count) {
            n <<= 1;
            rounds++;
        }
        t.bracketSize = uint32(n);
        t.totalRounds = rounds;

        // Pre-allocate every match slot, round by round, tagging each with its round.
        uint256 matchId = 0;
        for (uint8 r = 0; r < rounds; r++) {
            uint256 sizeR = n >> (r + 1);
            for (uint256 i = 0; i < sizeR; i++) {
                Match memory m;
                m.matchId = matchId;
                m.round = r;
                t.bracket.push(m);
                matchId++;
            }
        }

        // Fill round-0 players using standard seeding so byes fall to top seeds.
        uint256[] memory order = _seedOrder(n);
        uint256 firstRoundMatches = n / 2;
        for (uint256 i = 0; i < firstRoundMatches; i++) {
            uint256 sA = order[2 * i];
            uint256 sB = order[2 * i + 1];
            t.bracket[i].player1 = sA <= count ? bySeed[sA - 1] : address(0);
            t.bracket[i].player2 = sB <= count ? bySeed[sB - 1] : address(0);
            // Real (non-bye) round-0 matches have both players known right away.
            if (t.bracket[i].player1 != address(0) && t.bracket[i].player2 != address(0)) {
                t.bracket[i].readyAt = block.timestamp;
            }
        }

        // Auto-advance byes (exactly one side empty; N is the next power of two so
        // there can never be two byes in one match).
        for (uint256 i = 0; i < firstRoundMatches; i++) {
            Match storage m = t.bracket[i];
            if (m.player1 == address(0) && m.player2 == address(0)) continue;
            if (m.player1 == address(0) || m.player2 == address(0)) {
                address w = m.player1 == address(0) ? m.player2 : m.player1;
                m.winner = w;
                m.resolved = true;
                _advance(t, i);
            }
        }
    }

    /// @dev Standard single-elimination seed order for a bracket of size `n`
    /// (power of two). Returns 1-indexed seed positions.
    function _seedOrder(uint256 n) internal pure returns (uint256[] memory) {
        uint256[] memory seeds = new uint256[](1);
        seeds[0] = 1;
        uint256 len = 1;
        while (len < n) {
            uint256[] memory next = new uint256[](len * 2);
            uint256 sum = len * 2 + 1;
            for (uint256 i = 0; i < len; i++) {
                next[2 * i] = seeds[i];
                next[2 * i + 1] = sum - seeds[i];
            }
            seeds = next;
            len *= 2;
        }
        return seeds;
    }

    function _resolve(
        TournamentData storage t,
        uint256 matchId,
        address winner,
        bytes32 walrusBlobId
    ) internal {
        Match storage m = t.bracket[matchId];
        m.winner = winner;
        m.walrusBlobId = walrusBlobId;
        m.resolved = true;
        emit MatchResolved(t.id, matchId, winner, walrusBlobId);
        _advance(t, matchId);
    }

    /// @dev Propagate a resolved match's winner into its parent slot, or record
    /// the champion/runner-up if it was the final.
    function _advance(TournamentData storage t, uint256 matchId) internal {
        Match storage m = t.bracket[matchId];
        uint8 r = m.round;
        if (r + 1 == t.totalRounds) {
            t.champion = m.winner;
            t.runnerUp = m.player1 == m.winner ? m.player2 : m.player1;
            return;
        }
        uint256 n = t.bracketSize;
        uint256 roundStart = n - (n >> r);
        uint256 idxInRound = matchId - roundStart;
        uint256 parentId = (n - (n >> (r + 1))) + idxInRound / 2;
        Match storage p = t.bracket[parentId];
        if (idxInRound % 2 == 0) {
            p.player1 = m.winner;
        } else {
            p.player2 = m.winner;
        }
        if (p.player1 != address(0) && p.player2 != address(0)) {
            p.readyAt = block.timestamp;
            emit NextRoundMatchCreated(t.id, parentId, p.round);
        }
    }

    // ---- Internal: helpers ----
    function _get(uint256 tournamentId) internal view returns (TournamentData storage t) {
        t = tournaments[tournamentId];
        if (t.id == 0) revert TournamentNotFound();
    }

    function _send(address to, uint256 amount) internal {
        (bool ok, ) = payable(to).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    // ---- Views ----
    function getTournamentConfig(
        uint256 tournamentId
    ) external view returns (TournamentConfig memory) {
        return _get(tournamentId).config;
    }

    function getTournamentSummary(
        uint256 tournamentId
    )
        external
        view
        returns (
            TournamentState state,
            address creator,
            uint256 prizePool,
            uint256 registrantCount,
            uint8 totalRounds,
            address champion,
            address runnerUp
        )
    {
        TournamentData storage t = _get(tournamentId);
        return (
            t.state,
            t.creator,
            t.prizePool,
            t.registrants.length,
            t.totalRounds,
            t.champion,
            t.runnerUp
        );
    }

    function getRegistrants(
        uint256 tournamentId
    ) external view returns (address[] memory) {
        return _get(tournamentId).registrants;
    }

    function getMatch(
        uint256 tournamentId,
        uint256 matchId
    ) external view returns (Match memory) {
        TournamentData storage t = _get(tournamentId);
        if (matchId >= t.bracket.length) revert MatchNotFound();
        return t.bracket[matchId];
    }

    function getBracket(
        uint256 tournamentId
    ) external view returns (Match[] memory) {
        return _get(tournamentId).bracket;
    }

    function isRegistered(
        uint256 tournamentId,
        address player
    ) external view returns (bool) {
        return _get(tournamentId).registered[player];
    }

    /// @notice 1-based bracket seed, assigned by buildBracket()'s shuffle
    /// (0 before that has run, or if `player` never registered).
    function getSeed(
        uint256 tournamentId,
        address player
    ) external view returns (uint32) {
        return _get(tournamentId).seed[player];
    }

    function winningsOf(
        uint256 tournamentId,
        address player
    ) external view returns (uint256) {
        return _get(tournamentId).winnings[player];
    }
}

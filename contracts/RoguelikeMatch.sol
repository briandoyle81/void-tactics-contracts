// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/access/Ownable.sol";
import "./Types.sol";
import "./AIShips.sol";
import "./IShips.sol";
import "./Game.sol";
import "./IGameOrchestrator.sol";
import "./AIEncounters.sol";
import "./IMaps.sol";
import "./IShipAttributes.sol";
import "./AIBehavior.sol";
import "./IFleets.sol";
import "./RoguelikeNodeMap.sol";
import "./RoguelikeRun.sol";
import "./AIBehaviorRegistry.sol";
import "./IWinEffect.sol";
import "./IGameEngineRegistry.sol";

// Orchestrates the roguelike campaign mode: a player commits a fleet once
// (startRun), that roster persists — with accumulated damage — across a
// sequence of RoguelikeNodeMap nodes until the run is won or ends (a loss,
// draw, or explicit retreat). This sits entirely alongside the existing
// NodeMap/SinglePlayerMatch campaign, which is untouched.
//
// The roster is never a *permanent* Fleets.Fleet with a matching Game — see
// _reserveRoster. It's torn down and recreated around every combat node
// specifically to reuse Fleets' own MixedVariantFleet/cost-cap/ownership
// checks for free at every roster change, rather than reimplementing them.
contract RoguelikeMatch is Ownable, IGameOrchestrator {
    AIShips public aiShips;
    IShips public humanShips;
    Game public game;
    IFleets public fleets;
    // Optional (2026-09-28): records each new game's engine in a shared
    // registry for trustless FE lookup — see GameEngineRegistry.sol.
    // Skipped entirely if unset.
    IGameEngineRegistry public engineRegistry;
    AIEncounters public aiEncounters;
    IMaps public maps;
    IShipAttributes public shipAttributes;
    RoguelikeNodeMap public nodeMap;
    RoguelikeRun public runLedger;
    // Maps each faction (variant) to its own AI decision contract — see
    // AIBehaviorRegistry/IVariantAI.
    AIBehaviorRegistry public aiRegistry;
    // UA-11 fix (2026-09-29): campaignAutoHealPercent/isFinalNode/
    // node win-effects, all pinned at enterCombatNode time and read by
    // onGameEnded instead of re-deriving them live from current
    // RoguelikeNodeMap state when the fight concludes — so an admin content
    // edit mid-fight (adding a child to what was a leaf node, retuning the
    // heal floor, reconfiguring win effects) can't change what a player who
    // entered under the old config actually gets on that specific win. See
    // docs/upgrade-safety-audit-2026-09-29.md UA-11.
    mapping(uint => uint8) public healPercentAtStart;
    mapping(uint => bool) public isFinalNodeAtStart;
    mapping(uint => address[]) private winEffectsAtStart;

    // Disjoint from Lobbies' gameId space (small ints) and from
    // SinglePlayerMatch.NODE_MATCH_ID_OFFSET (2**40) — see that constant's
    // own comment for the JS-safe-integer reasoning this mirrors.
    uint public constant ROGUELIKE_GAME_ID_OFFSET = 2 ** 41;
    // HA4-01 fix (2026-09-28) — same reasoning as
    // SinglePlayerMatch.ENGINE_ID_BLOCK_SIZE/engineIndex's own comment: a
    // second RoguelikeMatch instance's matchCount starts fresh at 0, so
    // without this its first game would collide with the first instance's
    // first game in the shared GameEngineRegistry.engineOfGame mapping and
    // revert startRun-adjacent calls unconditionally. Index 0 reproduces
    // today's exact numbering unchanged.
    uint public constant ENGINE_ID_BLOCK_SIZE = 2 ** 64;
    uint public immutable engineIndex;
    uint public matchCount;

    mapping(uint gameId => address player) public gameIdToPlayer;
    mapping(uint gameId => uint[] aiShipIds) public gameIdToAiShipIds;

    struct AIShipInfo {
        Archetype archetype;
        uint16 variant;
        Special special;
        MainWeapon mainWeapon;
        // The AI contract this ship plays with, pinned at mint
        // (docs/audit-3.md HA6-18): pinning only the registry address left
        // its contents mutable via setVariantAI, so a mid-match AI patch
        // still changed the opponent. Packs into the same slot.
        IVariantAI ai;
    }
    mapping(uint shipId => AIShipInfo) public aiShipInfo;

    error NoActiveRun();
    error CampaignNotFound();
    error CampaignHasNoRoot();
    error EmptyRoster();
    error WrongCampaignVariant();
    error CannotAdvance();
    error WrongNodeKind();
    error NodeAlreadyDefeated();
    error NotYourGame();
    error EngineAlreadyLive();
    error NotGame();
    error GameEnded();
    error NotAITurn();
    error NoAIPlacementsConfigured();
    error ActiveGameInProgress();
    error CurrentNodeNotCleared();

    event RunStarted(address indexed player, uint indexed campaignId, uint rootNodeId);
    event CombatNodeEntered(uint indexed gameId, uint indexed nodeId, address indexed player);
    event ResupplyNodeEntered(uint indexed nodeId, address indexed player);
    event AIFleetCreated(uint indexed gameId, uint fleetId);
    event AITurnTaken(uint indexed gameId, uint shipId, ActionType actionType, uint targetShipId);
    event AIDecisionFailed(uint indexed gameId, uint shipId);
    event WinEffectFailed(
        address indexed player,
        uint indexed contextId,
        address indexed resolver
    );

    constructor(
        address _aiShips,
        address _humanShips,
        address _game,
        address _fleets,
        address _aiEncounters,
        address _maps,
        address _shipAttributes,
        address _nodeMap,
        address _runLedger,
        address _aiRegistry,
        uint _engineIndex
    ) Ownable(msg.sender) {
        aiShips = AIShips(_aiShips);
        humanShips = IShips(_humanShips);
        game = Game(_game);
        fleets = IFleets(_fleets);
        aiEncounters = AIEncounters(_aiEncounters);
        maps = IMaps(_maps);
        shipAttributes = IShipAttributes(_shipAttributes);
        nodeMap = RoguelikeNodeMap(_nodeMap);
        runLedger = RoguelikeRun(_runLedger);
        aiRegistry = AIBehaviorRegistry(_aiRegistry);
        engineIndex = _engineIndex;
    }

    // docs/audit-3.md HA6-13 (same rule as PvPMatch's UA-02 fix): once a
    // run has started, the dependencies live runs rely on can't be
    // repointed — a swap would orphan in-flight state (a game that can never
    // call back, fleets or a run ledger the old state lives in, an AI pool
    // whose ids don't match). A new engine is deployed fresh instead and
    // registered via GameEngineRegistry.
    function _requireNotLive() internal view {
        if (runLedger.runsStarted() > 0) revert EngineAlreadyLive();
    }

    function setAIShipsAddress(address _aiShips) external onlyOwner {
        _requireNotLive();
        aiShips = AIShips(_aiShips);
    }

    function setHumanShipsAddress(address _humanShips) external onlyOwner {
        _requireNotLive();
        humanShips = IShips(_humanShips);
    }

    function setGameAddress(address _game) external onlyOwner {
        _requireNotLive();
        game = Game(_game);
    }

    function setEngineRegistry(address _registry) external onlyOwner {
        engineRegistry = IGameEngineRegistry(_registry);
    }

    function setFleetsAddress(address _fleets) external onlyOwner {
        _requireNotLive();
        fleets = IFleets(_fleets);
    }

    function setAIEncountersAddress(address _aiEncounters) external onlyOwner {
        aiEncounters = AIEncounters(_aiEncounters);
    }

    function setMapsAddress(address _maps) external onlyOwner {
        _requireNotLive();
        maps = IMaps(_maps);
    }

    function setShipAttributesAddress(address _shipAttributes) external onlyOwner {
        shipAttributes = IShipAttributes(_shipAttributes);
    }

    function setNodeMapAddress(address _nodeMap) external onlyOwner {
        _requireNotLive();
        nodeMap = RoguelikeNodeMap(_nodeMap);
    }

    function setRunLedgerAddress(address _runLedger) external onlyOwner {
        _requireNotLive();
        runLedger = RoguelikeRun(_runLedger);
    }

    function setAIRegistryAddress(address _aiRegistry) external onlyOwner {
        aiRegistry = AIBehaviorRegistry(_aiRegistry);
    }

    // ---- Run lifecycle ----

    function startRun(
        uint _campaignId,
        uint[] calldata _shipIds
    ) external returns (uint rootNodeId) {
        if (_shipIds.length == 0) revert EmptyRoster();
        if (!nodeMap.campaignExists(_campaignId)) revert CampaignNotFound();
        rootNodeId = nodeMap.campaignRootNode(_campaignId);
        if (rootNodeId == 0) revert CampaignHasNoRoot();

        uint16 requiredVariant = nodeMap.campaignRequiredVariant(_campaignId);
        if (
            requiredVariant != 0 &&
            humanShips.getShip(_shipIds[0]).traits.variant != requiredVariant
        ) revert WrongCampaignVariant();

        uint initialCostCap = nodeMap.campaignInitialCostCap(_campaignId);
        // Checked createFleet: a run's prices must be current when it
        // starts. Every later fleet for the run uses frozen prices (see
        // _reserveRoster).
        uint fleetId = fleets.createFleet(
            0,
            msg.sender,
            _shipIds,
            _rosterPositions(_shipIds.length),
            initialCostCap,
            true,
            0
        );

        runLedger.startRun(
            msg.sender,
            _campaignId,
            rootNodeId,
            initialCostCap,
            _shipIds,
            fleetId,
            requiredVariant
        );

        emit RunStarted(msg.sender, _campaignId, rootNodeId);
    }

    // Fields the run's ENTIRE current roster — there is no per-node squad
    // sub-selection; if that's wanted later, this is the extension point.
    // _positions must be in the same order as the run's roster.
    function enterCombatNode(
        uint _targetNodeId,
        Position[] calldata _positions
    ) external returns (uint gameId) {
        Run memory run = runLedger.getRun(msg.sender);
        if (run.status != RunStatus.Active) revert NoActiveRun();
        RoguelikeNode memory node = _commitToNode(msg.sender, run, _targetNodeId);
        if (node.kind != RoguelikeNodeKind.Combat) revert WrongNodeKind();
        // Re-entering the current node skips the lockout in _commitToNode,
        // so a just-won Combat node could otherwise be fought again in
        // place — reject the repeat rather than letting its kill rewards be
        // farmed (see docs/pre-audit.md SP-05). Any node already left is
        // locked, so a cycle in the graph can't reach it either.
        if (runLedger.isNodeDefeated(msg.sender, _targetNodeId)) {
            revert NodeAlreadyDefeated();
        }

        uint[] memory shipIds = run.rosterShipIds;

        fleets.clearFleet(run.reservationFleetId);

        matchCount++;
        gameId =
            ROGUELIKE_GAME_ID_OFFSET +
            engineIndex *
            ENGINE_ID_BLOCK_SIZE +
            matchCount;
        // UA-11 fix: pin this combat node's heal floor, final-node status,
        // and win-effects list, all as of entry — see the fields' own
        // comment above.
        healPercentAtStart[gameId] = nodeMap.campaignAutoHealPercent(
            run.campaignId
        );
        isFinalNodeAtStart[gameId] =
            nodeMap.getChildren(_targetNodeId).length == 0;
        winEffectsAtStart[gameId] = nodeMap.getNodeWinEffects(_targetNodeId);

        uint humanFleetId = fleets.createFleetFrozenPrices(
            gameId,
            msg.sender,
            shipIds,
            _positions,
            run.currentCostCap,
            true,
            node.mapId
        );
        uint aiFleetId = _mintAIFleet(node.mapId, gameId);

        gameIdToPlayer[gameId] = msg.sender;
        runLedger.setActiveGameId(msg.sender, gameId);

        game.startGame(
            gameId,
            msg.sender,
            address(this),
            humanFleetId,
            aiFleetId,
            node.creatorGoesFirst,
            node.turnTime,
            node.mapId,
            node.maxScore
        );
        if (address(engineRegistry) != address(0)) {
            engineRegistry.recordGameEngine(gameId, address(game));
        }

        // Seed persisted damage from a previous node, if any (0 = never
        // damaged this run — the fresh 100% calculateShipAttributes just
        // set inside startGame is already correct, skip the call).
        for (uint i = 0; i < shipIds.length; i++) {
            uint8 hp = runLedger.getShipHP(msg.sender, shipIds[i]);
            if (hp != 0) {
                game.setInitialHullPointsOverride(gameId, shipIds[i], hp);
            }
        }

        emit CombatNodeEntered(gameId, _targetNodeId, msg.sender);
    }

    function enterResupplyNode(uint _targetNodeId) external {
        Run memory run = runLedger.getRun(msg.sender);
        if (run.status != RunStatus.Active) revert NoActiveRun();
        RoguelikeNode memory node = _commitToNode(msg.sender, run, _targetNodeId);
        if (node.kind != RoguelikeNodeKind.Resupply) revert WrongNodeKind();

        if (node.costCapOverride != 0) {
            runLedger.setCostCap(msg.sender, node.costCapOverride);
        }

        emit ResupplyNodeEntered(_targetNodeId, msg.sender);
    }

    // _gameId == 0: abandon the run between nodes (no active match).
    // _gameId != 0: forfeit the in-progress combat node as a loss, which
    // ends the run via the normal onGameEnded(non-win) path.
    function retreatRun(uint _gameId) external {
        Run memory run = runLedger.getRun(msg.sender);
        if (run.status != RunStatus.Active) revert NoActiveRun();

        if (_gameId != 0) {
            if (gameIdToPlayer[_gameId] != msg.sender) revert NotYourGame();
            game.forceEndSession(_gameId, address(this), msg.sender);
            return;
        }

        // Can't abandon "between nodes" while a combat match is actually
        // still live — that would leave it able to resolve later and
        // silently apply its outcome to whatever run is current for this
        // address by then (see docs/pre-audit.md SP-04). Forfeit it via
        // retreatRun(activeGameId) first.
        if (run.activeGameId != 0) revert ActiveGameInProgress();

        fleets.clearFleet(run.reservationFleetId);
        runLedger.endRun(msg.sender, false);
    }

    // Resupply *actions* (repair, roster composition changes) live on the
    // separate RoguelikeResupply contract, not here — see that contract's
    // header comment for why (RoguelikeMatch was over the 24 KiB limit with
    // them inlined). This contract only handles arriving at a resupply
    // node (above) and the cost-cap-override side effect of doing so.

    // ---- Internal: graph traversal / lockout ----

    // Moves are forward-only: the target must be an unlocked child of the
    // current node. Committing to it locks every other sibling and the node
    // being left.
    function _commitToNode(
        address _player,
        Run memory _run,
        uint _targetNodeId
    ) internal returns (RoguelikeNode memory node) {
        // Can't enter any node — another one, or the current one again —
        // while a combat match is still live. Moving would detach
        // run.currentNodeId from the node actually being fought, so the
        // eventual onGameEnded callback (which only checks *which game*,
        // not *which node*) would credit the wrong node as defeated and
        // evaluate win-effects/isFinalNode against it; re-entering would
        // overwrite activeGameId with a duplicate match. Same guard
        // retreatRun(0) already has, for the same underlying reason (see
        // docs/pre-audit.md SP-04, docs/audit-2.md HA2-04).
        if (_run.activeGameId != 0) revert ActiveGameInProgress();

        node = nodeMap.getNode(_targetNodeId);

        // Already standing here — either the very first node right after
        // startRun (a root has no parent, so it can never be "a child of
        // itself" below), or re-entering the current node (e.g. a
        // resupply node visited more than once). No traversal, so no
        // lockout side effects.
        if (_targetNodeId == _run.currentNodeId) {
            return node;
        }

        // Leaving a combat node requires having won it — otherwise a player
        // could skip any mission (including the root, right after startRun)
        // by walking straight to one of its children. A resupply node has
        // no fight, so leaving one is always allowed.
        if (
            nodeMap.getNode(_run.currentNodeId).kind ==
            RoguelikeNodeKind.Combat &&
            !runLedger.isNodeDefeated(_player, _run.currentNodeId)
        ) {
            revert CurrentNodeNotCleared();
        }

        if (runLedger.isNodeLocked(_player, _targetNodeId)) {
            revert CannotAdvance();
        }
        uint[] memory children = nodeMap.getChildren(_run.currentNodeId);
        bool isChild;
        for (uint i = 0; i < children.length; i++) {
            if (children[i] == _targetNodeId) {
                isChild = true;
            } else {
                runLedger.lockNode(_player, children[i]);
            }
        }
        // Reverting rolls back the sibling locks above.
        if (!isChild) revert CannotAdvance();
        runLedger.lockNode(_player, _run.currentNodeId);

        runLedger.setCurrentNode(_player, _targetNodeId);

        // A node with no children is the campaign's end — a combat win
        // here ends the run as Won (see onGameEnded); nothing special
        // happens on simply *entering* it.
    }

    // Synthetic grid positions — this fleet never has a matching Game, so
    // these are never rendered/read by anything except Fleets' own
    // structural validation (bounds, no duplicates, creator-side columns).
    // Frozen prices (docs/audit-3.md HA6-09): the roster was priced at run
    // start (or, for resupply adds, checked by RoguelikeResupply), and a
    // mid-run ShipAttributes.setCosts must not break re-reservation.
    function _reserveRoster(
        address _player,
        uint[] memory _shipIds,
        uint _costCap
    ) internal returns (uint fleetId) {
        // mapId 0: this fleet is map-agnostic (synthetic, see the doc
        // comment above), so Fleets falls back to its default column rule.
        fleetId = fleets.createFleetFrozenPrices(
            0,
            _player,
            _shipIds,
            _rosterPositions(_shipIds.length),
            _costCap,
            true,
            0
        );
    }

    function _rosterPositions(
        uint _count
    ) internal pure returns (Position[] memory positions) {
        positions = new Position[](_count);
        for (uint i = 0; i < _count; i++) {
            positions[i] = Position({
                row: int16(int(i / 4)),
                col: int16(int(i % 4))
            });
        }
    }

    // Post-win roster + stored HP (auto-heal floor applied). A ship that's
    // no longer on the board has no Attributes left to read
    // (Game._removeShipFromGame deletes them): a destroyed one is dropped,
    // but a fled one (rammed or retreated) rejoins the roster at the heal
    // floor — its HP at the moment it left is gone with its Attributes, so
    // it's treated as 0 and the floor applies, against its live max (the
    // same max the next node's Game will compute). On-board survivors come
    // first in the returned roster, rejoiners after, so onGameEnded's
    // reservation fallback can drop rejoiners by truncating to
    // `survivorCount`. Split out of onGameEnded for stack depth.
    function _postWinRoster(
        uint _gameId,
        address _player,
        uint[] memory _oldRoster
    ) internal returns (uint[] memory roster, uint survivorCount) {
        roster = new uint[](_oldRoster.length);
        uint[] memory rejoiners = new uint[](_oldRoster.length);
        uint rejoinerCount;
        for (uint i = 0; i < _oldRoster.length; i++) {
            uint shipId = _oldRoster[i];
            try game.getShipAttributes(_gameId, shipId) returns (
                Attributes memory attrs
            ) {
                _storeHealedHP(
                    _gameId,
                    _player,
                    shipId,
                    attrs.hullPoints,
                    attrs.maxHullPoints
                );
                roster[survivorCount] = shipId;
                survivorCount++;
            } catch {
                if (!_canRejoin(_gameId, _player, shipId)) continue;
                _storeHealedHP(
                    _gameId,
                    _player,
                    shipId,
                    0,
                    shipAttributes.calculateShipAttributesById(shipId).maxHullPoints
                );
                rejoiners[rejoinerCount] = shipId;
                rejoinerCount++;
            }
        }
        for (uint i = 0; i < rejoinerCount; i++) {
            roster[survivorCount + i] = rejoiners[i];
        }
        uint total = survivorCount + rejoinerCount;
        assembly {
            mstore(roster, total)
        }
    }

    function _storeHealedHP(
        uint _gameId,
        address _player,
        uint _shipId,
        uint8 _hullPoints,
        uint8 _maxHullPoints
    ) internal {
        // UA-11 fix: pinned at entry (see healPercentAtStart), not the
        // live campaign config.
        uint16 floor = (uint16(_maxHullPoints) * healPercentAtStart[_gameId]) /
            100;
        uint16 healed = _hullPoints > floor ? _hullPoints : floor;
        if (healed > _maxHullPoints) healed = _maxHullPoints;
        // A disabled (0 HP) ship still on the board at a win, under a 0%
        // floor, would otherwise store 0 — RoguelikeRun's "never damaged =
        // full HP" sentinel — and silently re-enter the next node fully
        // healed. Carry it forward at 1 HP. Same for a rejoiner under a 0%
        // floor.
        if (healed == 0) healed = 1;
        runLedger.setShipHP(_player, _shipId, uint8(healed));
    }

    // A ship that left the board mid-fight (status 2 = fled: rammed by the
    // AI, or retreated by the player) rejoins the roster on a win — but
    // Game._removeShipFromGame already released it from the combat fleet,
    // so it was unlocked (transferable/modifiable/fleetable elsewhere) for
    // the rest of the match. Only take it back if it's still the player's,
    // still free, and still alive. A cost change (modified mid-match) isn't
    // checked here — the reservation in onGameEnded catches that instead.
    function _canRejoin(
        uint _gameId,
        address _player,
        uint _shipId
    ) internal view returns (bool) {
        if (game.getShipPosition(_gameId, _shipId).status != 2) return false;
        Ship memory ship = humanShips.getShip(_shipId);
        return
            ship.owner == _player &&
            !ship.shipData.inFleet &&
            ship.shipData.timestampDestroyed == 0;
    }

    // ---- IGameOrchestrator ----

    function onGameEnded(uint _gameId, address _winner, address) external {
        if (msg.sender != address(game)) revert NotGame();

        aiShips.releaseShips(gameIdToAiShipIds[_gameId]);
        delete gameIdToAiShipIds[_gameId];

        address player = gameIdToPlayer[_gameId];
        if (player == address(0)) return; // defensive: not one of ours

        delete gameIdToPlayer[_gameId];

        Run memory run = runLedger.getRun(player);

        // Stale-callback guard: only mutate the run if this is genuinely
        // still its tracked live game. Defense in depth alongside
        // retreatRun(0)'s own activeGameId check above — a game this run
        // no longer considers active (already abandoned, or belonging to a
        // since-ended/since-replaced run) must not be allowed to apply its
        // outcome to whatever run/generation is current for this address
        // now (see docs/pre-audit.md SP-04).
        if (run.status != RunStatus.Active || run.activeGameId != _gameId) {
            return;
        }
        runLedger.setActiveGameId(player, 0);

        if (_winner != player) {
            // Loss or draw ends the run. Nothing to release here ourselves
            // — run.reservationFleetId was already torn down back in
            // enterCombatNode (never a real fleet during combat), and the
            // actual combat fleet's survivors are released to normal
            // ownership automatically by Game._endGame's own unconditional
            // post-callback fleet cleanup, which runs right after this
            // function returns.
            runLedger.endRun(player, false);
            return;
        }

        // Won this node — mark it defeated, which lets the run leave it
        // (CurrentNodeNotCleared) and stops it being re-fought in place for
        // repeat kill rewards (see docs/pre-audit.md SP-05; enforced in
        // enterCombatNode).
        runLedger.setNodeDefeated(player, run.currentNodeId);

        // The combat fleet's survivors are still inFleet (Game._endGame
        // only clears fleets *after* this callback returns — see the
        // comment above), so they must be released here, before
        // re-reserving them, or _reserveRoster below would revert
        // MixedVariantFleet/ShipAlreadyInFleet trying to re-fleet a ship
        // that's still (nominally) in the just-finished combat fleet.
        // getGameMetadataAndTurnState instead of getGame() — only
        // .metadata.creatorFleetId is needed here (G-04).
        (GameMetadata memory gameMetadata, ) = game
            .getGameMetadataAndTurnState(_gameId);
        fleets.clearFleet(gameMetadata.creatorFleetId);

        (uint[] memory newRoster, uint survivorCount) = _postWinRoster(
            _gameId,
            player,
            run.rosterShipIds
        );

        // UA-11 fix: pinned at entry (see isFinalNodeAtStart), not the live
        // node graph.
        bool isFinalNode = isFinalNodeAtStart[_gameId];
        runLedger.setRoster(player, newRoster);

        // Pluggable win effects (bonus currency, extra heal beyond the
        // floor above, a granted ship, etc.) — run after the roster/HP
        // bookkeeping above so a resolver sees final, consistent state
        // (e.g. a heal-above-floor resolver reading survivors' HP sees the
        // floor already applied). Fires on every combat win, including the
        // one that completes the run — same as the floor heal itself.
        //
        // Each call is individually try/catch'd — onGameEnded is invoked
        // by Game.sol as a bare external call with no try/catch of its own
        // (see Game.sol's _endGame), so an unguarded revert here would
        // bubble all the way up and fail the entire game-ending
        // transaction: the win would never be recorded and fleets would
        // never release. One misconfigured resolver must never be able to
        // brick every future win at a node that references it — same
        // "one bad entry shouldn't take down the whole batch" reasoning as
        // the try/catch already used above for game.getShipAttributes.
        // UA-11 fix: pinned at entry (see winEffectsAtStart), not the live
        // node config.
        address[] memory winEffects = winEffectsAtStart[_gameId];
        for (uint i = 0; i < winEffects.length; i++) {
            try
                IWinEffect(winEffects[i]).onWin(player, run.currentNodeId)
            {} catch {
                emit WinEffectFailed(player, run.currentNodeId, winEffects[i]);
            }
        }

        if (isFinalNode) {
            runLedger.endRun(player, true);
        } else {
            // A rejoiner was unlocked for the rest of the match (see
            // _canRejoin), so it could have been modified into a cost that
            // breaks the cap — and this runs inside Game._endGame's
            // unguarded callback, where a revert would block the winning
            // move itself. Fall back to on-board survivors only (the
            // pre-rejoin behavior) rather than ever reverting here.
            uint newFleetId;
            try
                fleets.createFleetFrozenPrices(
                    0,
                    player,
                    newRoster,
                    _rosterPositions(newRoster.length),
                    run.currentCostCap,
                    true,
                    0
                )
            returns (uint fleetId) {
                newFleetId = fleetId;
            } catch {
                assembly {
                    mstore(newRoster, survivorCount)
                }
                runLedger.setRoster(player, newRoster);
                newFleetId = _reserveRoster(player, newRoster, run.currentCostCap);
            }
            runLedger.setReservationFleetId(player, newFleetId);
        }
    }

    // ---- AI turn dispatch (mirrors SinglePlayerMatch.takeAITurn) ----

    function _mintAIFleet(
        uint _mapId,
        uint _gameId
    ) internal returns (uint fleetId) {
        (Position[] memory positions, uint[] memory configIds) = aiEncounters
            .getMapPlacements(_mapId);
        if (positions.length == 0) revert NoAIPlacementsConfigured();

        uint[] memory shipIds = new uint[](positions.length);
        for (uint i = 0; i < positions.length; i++) {
            AIEncounters.AIShipConfig memory config = aiEncounters
                .getAIShipConfig(configIds[i]);
            shipIds[i] = aiShips.allocateShip(
                address(this),
                _buildAIShipFromConfig(config)
            );
            aiShipInfo[shipIds[i]] = AIShipInfo({
                archetype: config.archetype,
                variant: config.traits.variant,
                special: config.equipment.special,
                mainWeapon: config.equipment.mainWeapon,
                // Reverts NoAIForVariant at match start if the variant has
                // no AI — failing loudly up front instead of mid-match.
                ai: aiRegistry.aiFor(config.traits.variant)
            });
        }
        gameIdToAiShipIds[_gameId] = shipIds;

        fleetId = fleets.createFleet(
            _gameId,
            address(this),
            shipIds,
            positions,
            type(uint).max,
            false,
            _mapId
        );
        emit AIFleetCreated(_gameId, fleetId);
    }

    function _buildAIShipFromConfig(
        AIEncounters.AIShipConfig memory _config
    ) internal view returns (Ship memory s) {
        s.name = _config.name;
        s.owner = address(this); // allocateShip overwrites this with _to anyway
        s.equipment = _config.equipment;
        s.traits = _config.traits;
    }

    function takeAITurn(uint _gameId) external {
        _takeOneAITurn(_gameId, true);
    }

    // Batched form of takeAITurn: keeps moving AI ships for as long as the
    // turn stays with the AI, up to _maxMoves (a caller-chosen gas bound).
    // Turn order alternates ship-by-ship (Game._switchTurnIfOtherPlayerHasShips),
    // so this only moves more than one ship when the human has no unmoved
    // ships left this round — in every other case it's equivalent to a
    // single takeAITurn. Stops early (without reverting) once the turn
    // leaves the AI, the game ends, or a ship's move and its Pass fallback
    // both fail (so a stuck ship can't burn the whole _maxMoves budget
    // retrying itself). Only the first iteration reverts on "not the AI's
    // turn"/"game ended", exactly like takeAITurn.
    function takeAITurns(uint _gameId, uint _maxMoves) external {
        for (uint i = 0; i < _maxMoves; i++) {
            if (!_takeOneAITurn(_gameId, i == 0)) return;
        }
    }

    // Returns whether a ship actually moved (i.e. whether another call
    // might still have something to do). _strict: revert instead of
    // returning false when it isn't the AI's turn / the game has ended.
    function _takeOneAITurn(
        uint _gameId,
        bool _strict
    ) internal returns (bool) {
        GameDataView memory g = game.getGame(_gameId);
        if (g.metadata.ended) {
            if (_strict) revert GameEnded();
            return false;
        }
        if (g.turnState.currentTurn != address(this)) {
            if (_strict) revert NotAITurn();
            return false;
        }

        if (!_hasAnyLiveShip(g)) {
            game.forceEndSession(_gameId, g.metadata.creator, address(this));
            return false;
        }

        uint shipId = _findUnmovedShip(g);
        if (shipId == 0) return false;

        return _takeShipTurn(_gameId, g, shipId);
    }

    function _hasAnyLiveShip(
        GameDataView memory g
    ) internal pure returns (bool) {
        // Joiner ships occupy shipAttributes[creatorActiveShipIds.length ..]
        // in the exact same order as joinerActiveShipIds — see Game.sol's
        // getGame() construction order (G-01) — so this is a direct index
        // read instead of an O(n) findAttributes scan per candidate.
        uint base = g.creatorActiveShipIds.length;
        for (uint i = 0; i < g.joinerActiveShipIds.length; i++) {
            if (g.shipAttributes[base + i].hullPoints > 0) return true;
        }
        return false;
    }

    function _takeShipTurn(
        uint _gameId,
        GameDataView memory g,
        uint _shipId
    ) internal returns (bool) {
        (AIBehavior.Decision memory d, bool decided) = _decideMove(
            _gameId,
            g,
            _shipId
        );
        // HA6-12: _decideMove fell back to Pass; surface it so a broken AI
        // fails loudly instead of silently passing forever.
        if (!decided) emit AIDecisionFailed(_gameId, _shipId);

        try
            game.moveShip(
                _gameId,
                _shipId,
                d.destRow,
                d.destCol,
                d.action,
                d.actionTarget
            )
        {
            emit AITurnTaken(_gameId, _shipId, d.action, d.actionTarget);
            return true;
        } catch {
            (Position memory myPos, bool found) = AIBehavior.findPosition(
                g,
                _shipId
            );
            if (found) {
                try
                    game.moveShip(
                        _gameId,
                        _shipId,
                        myPos.row,
                        myPos.col,
                        ActionType.Pass,
                        0
                    )
                {
                    emit AITurnTaken(_gameId, _shipId, ActionType.Pass, 0);
                    return true;
                } catch {}
            }
        }
        return false;
    }

    function _decideMove(
        uint _gameId,
        GameDataView memory g,
        uint _shipId
    ) internal view returns (AIBehavior.Decision memory d, bool decided) {
        (Position memory myPos, bool posFound) = AIBehavior.findPosition(
            g,
            _shipId
        );
        (Attributes memory myAttrs, bool attrsFound) = AIBehavior
            .findAttributes(g, _shipId);
        if (!posFound || !attrsFound) {
            d.destRow = myPos.row;
            d.destCol = myPos.col;
            d.action = ActionType.Pass;
            return (d, true);
        }

        AIShipInfo memory info = aiShipInfo[_shipId];
        AIBehavior.Ctx memory ctx = AIBehavior.Ctx({
            g: g,
            maps: maps,
            gameId: _gameId,
            shipId: _shipId,
            pos: myPos,
            attrs: myAttrs,
            mainWeapon: info.mainWeapon,
            scoringPositions: maps.getGameScoringPositions(_gameId),
            gridWidth: game.GRID_WIDTH(),
            gridHeight: game.GRID_HEIGHT()
        });

        // Chosen by variant first (each faction's AI is built around its own
        // abilities), then by archetype inside that faction's contract. A
        // variant with no registered AI fails at match start (aiFor at mint).
        // Calls the ship's own AI contract, pinned at mint (AIShipInfo.ai).
        // docs/audit-3.md HA6-12: any failure to decide falls back to
        // passing in place instead of reverting — an non-contract AI,
        // a revert or out-of-gas inside decide.
        // Reverting here would make takeAITurn fail every time, leaving the
        // game stuck on the AI's turn. (The code-length checks matter: a
        // call to an address with no code returns empty data, and the
        // resulting decode failure isn't catchable.)
        d.destRow = myPos.row;
        d.destCol = myPos.col;
        d.action = ActionType.Pass;
        if (address(info.ai).code.length == 0) return (d, false);
        try info.ai.decide(ctx, info.archetype, info.special) returns (
            AIBehavior.Decision memory chosen
        ) {
            return (chosen, true);
        } catch {}
        return (d, false);
    }

    function _findUnmovedShip(
        GameDataView memory g
    ) internal pure returns (uint) {
        uint[] memory active = g.joinerActiveShipIds;
        uint[] memory moved = g.joinerMovedShipIds;

        for (uint i = 0; i < active.length; i++) {
            bool hasMoved = false;
            for (uint j = 0; j < moved.length; j++) {
                if (moved[j] == active[i]) {
                    hasMoved = true;
                    break;
                }
            }
            if (hasMoved) continue;

            (Attributes memory attrs, bool found) = AIBehavior.findAttributes(
                g,
                active[i]
            );
            if (found && attrs.hullPoints == 0) continue;

            return active[i];
        }
        return 0;
    }
}

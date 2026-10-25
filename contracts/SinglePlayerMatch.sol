// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/access/Ownable.sol";
import "./Types.sol";
import "./AIShips.sol";
import "./Lobbies.sol";
import "./Game.sol";
import "./IGameOrchestrator.sol";
import "./AIEncounters.sol";
import "./IMaps.sol";
import "./AIBehavior.sol";
import "./IUniversalCredits.sol";
import "./NodeMap.sol";
import "./IFleets.sol";
import "./AIBehaviorRegistry.sol";
import "./IShips.sol";
import "./IGameEngineRegistry.sol";

// Plays single-player matches as an on-chain opponent. Players enter via a
// node-graph campaign (NodeMap) rather than the Lobbies UI: startNodeMatch
// mints both fleets directly through Fleets and kicks off Game.sol in one
// call, with no lobby involved. gameId is offset into a range disjoint from
// Lobbies-sourced (PvP) game ids so the two id spaces never collide (see
// NODE_MATCH_ID_OFFSET). `lobbies` is kept only as a legacy reference —
// nothing in this flow depends on it.
contract SinglePlayerMatch is Ownable, IGameOrchestrator {
    AIShips public ships;
    Lobbies public lobbies;
    Game public game;
    AIEncounters public aiEncounters;
    IMaps public maps;
    // Maps each faction (variant) to its own AI decision contract — see
    // AIBehaviorRegistry/IVariantAI. Set via setAIRegistryAddress.
    AIBehaviorRegistry public aiRegistry;
    IUniversalCredits public universalCredits;
    NodeMap public nodeMap;
    IFleets public fleets;
    // The HUMAN ships contract — distinct from `ships` above (AIShips, the
    // AI's own ship pool) — needed only to read a human fleet's variant
    // against NodeMap.campaignRequiredVariant before starting a node match.
    IShips public humanShips;
    // Optional (2026-09-28): records each new game's engine in a shared
    // registry for trustless FE lookup — see GameEngineRegistry.sol.
    // Skipped entirely if unset.
    IGameEngineRegistry public engineRegistry;

    // Node-match game ids live in a disjoint range above Lobbies.lobbyCount
    // (PvP's id source), so Game.sol's gameId == lobbyId scheme can never
    // collide between a PvP game and a node-match game. 2**40 (~1.1T) is
    // comfortably past any realistic lobbyCount while staying ~8,192x under
    // Number.MAX_SAFE_INTEGER (2**53-1) — frontend code that treats gameId
    // as a JS number (rather than bigint) needs this to stay exact.
    // Public (unlike before) so the frontend has a documented, contract-
    // read way to tell a node-match gameId from a PvP one if it ever needs
    // that without already knowing from context which flow started it.
    uint public constant NODE_MATCH_ID_OFFSET = 2 ** 40;
    // HA4-01 fix (2026-09-28): NODE_MATCH_ID_OFFSET + nodeMatchCount alone
    // isn't unique across deployed instances — a second SinglePlayerMatch
    // (e.g. a future gameplay-rules "engine" upgrade, see the
    // engine-registry plan) starts nodeMatchCount fresh at 0, so its first
    // game would compute the exact same gameId as the first instance's
    // first game, colliding in GameEngineRegistry.engineOfGame (a single
    // mapping shared across every engine) and reverting that shared call —
    // which reverts this entire startNodeMatch transaction, unconditionally,
    // on the very first game the second instance ever tries to start. Fixed
    // by folding an immutable per-instance engineIndex into the id: index 0
    // (every instance deployed before this fix, and the one instance that
    // exists as of this fix) reproduces today's exact numbering unchanged;
    // any later co-existing instance gets its own disjoint block, sized far
    // beyond any realistic nodeMatchCount.
    uint public constant ENGINE_ID_BLOCK_SIZE = 2 ** 64;
    uint public immutable engineIndex;
    uint public nodeMatchCount;
    mapping(uint => uint) public gameIdToNodeId;
    mapping(uint => address) public gameIdToHuman;
    // Full AI roster minted for a game, recorded at mint time so it can be
    // released back to AIShips' pool as a whole at game end — surviving
    // *and* destroyed ships alike, since destroyed ships are spliced out of
    // Game.sol's playerActiveShipIds mid-match and can't be reconstructed
    // from that set alone.
    mapping(uint => uint[]) public gameIdToAiShipIds;

    // Static per-ship info cached at setupAIFleet mint time (from the same
    // AIShipConfig already fetched there), so takeAITurn's decision engine
    // never needs an extra Ships/AIEncounters call mid-turn to learn what
    // archetype/faction/special a ship has.
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
    mapping(uint => AIShipInfo) public aiShipInfo;

    error NotGame();
    error NotYourGame();
    error EngineAlreadyLive();
    error GameEnded();
    error NotAITurn();
    error NoAIPlacementsConfigured();
    error NodeNotUnlocked();
    error WrongCampaignVariant();

    event AIFleetCreated(uint indexed gameId, uint fleetId);
    event NodeMatchStarted(
        uint indexed gameId,
        uint indexed nodeId,
        address indexed human
    );
    event AIDecisionFailed(uint indexed gameId, uint shipId);
    event AITurnTaken(
        uint indexed gameId,
        uint shipId,
        ActionType actionType,
        uint targetShipId
    );

    constructor(
        address _ships,
        address _lobbies,
        address _game,
        address _aiEncounters,
        address _maps,
        address _nodeMap,
        address _fleets,
        uint _engineIndex
    ) Ownable(msg.sender) {
        ships = AIShips(_ships);
        lobbies = Lobbies(_lobbies);
        game = Game(_game);
        aiEncounters = AIEncounters(_aiEncounters);
        maps = IMaps(_maps);
        nodeMap = NodeMap(_nodeMap);
        engineIndex = _engineIndex;
        fleets = IFleets(_fleets);
    }

    // docs/audit-3.md HA6-13 (same rule as PvPMatch's UA-02 fix): once a
    // match has started, the dependencies live matchs rely on can't be
    // repointed — a swap would orphan in-flight state (a game that can never
    // call back, fleets or a run ledger the old state lives in, an AI pool
    // whose ids don't match). A new engine is deployed fresh instead and
    // registered via GameEngineRegistry.
    function _requireNotLive() internal view {
        if (nodeMatchCount > 0) revert EngineAlreadyLive();
    }

    function setLobbiesAddress(address _lobbies) external onlyOwner {
        lobbies = Lobbies(_lobbies);
    }

    // Lets a future AIShips pool (with a higher AI_SHIP_ID_OFFSET) be
    // swapped in without redeploying this contract — see Game.setAddresses
    // for why this matters.
    function setShipsAddress(address _ships) external onlyOwner {
        _requireNotLive();
        ships = AIShips(_ships);
    }

    function setGameAddress(address _game) external onlyOwner {
        _requireNotLive();
        game = Game(_game);
    }

    function setEngineRegistry(address _registry) external onlyOwner {
        engineRegistry = IGameEngineRegistry(_registry);
    }

    function setAIEncountersAddress(address _aiEncounters) external onlyOwner {
        aiEncounters = AIEncounters(_aiEncounters);
    }

    function setMapsAddress(address _maps) external onlyOwner {
        _requireNotLive();
        maps = IMaps(_maps);
    }

    function setAIRegistryAddress(address _aiRegistry) external onlyOwner {
        aiRegistry = AIBehaviorRegistry(_aiRegistry);
    }

    function setUniversalCreditsAddress(
        address _universalCredits
    ) external onlyOwner {
        universalCredits = IUniversalCredits(_universalCredits);
    }

    function setNodeMapAddress(address _nodeMap) external onlyOwner {
        _requireNotLive();
        nodeMap = NodeMap(_nodeMap);
    }

    function setFleetsAddress(address _fleets) external onlyOwner {
        fleets = IFleets(_fleets);
    }

    function setHumanShipsAddress(address _humanShips) external onlyOwner {
        humanShips = IShips(_humanShips);
    }

    // The AI's own ships are owned by address(this), so whenever the AI
    // destroys a human ship, ShipsRouter.setTimestampDestroyed's kill reward
    // mints UTC here (unlike a human destroying an AI ship, which now pays
    // out in DEC instead — see DestroyRewardLib) with no way for this
    // contract to otherwise spend or move it. Lets the owner claim it out.
    function withdrawUTC() external onlyOwner {
        uint balance = universalCredits.balanceOf(address(this));
        require(
            universalCredits.transfer(owner(), balance),
            "UTC withdrawal failed"
        );
    }

    // Entry point into a vs-AI match: no Lobbies involved. _nodeId must be
    // unlocked for msg.sender (NodeMap.isNodeUnlocked — a root node, or any
    // one of its prerequisites already completed by this player). Every
    // other parameter of the match (map, fleet cost ceiling, turn time, max
    // score, who goes first) is curated on the node itself rather than
    // player-supplied, matching how AIEncounters already curates AI
    // loadouts per map — a campaign node is a fixed, pre-designed encounter.
    function startNodeMatch(
        uint _nodeId,
        uint[] calldata _shipIds,
        Position[] calldata _positions
    ) external returns (uint gameId) {
        if (!nodeMap.isNodeUnlocked(msg.sender, _nodeId))
            revert NodeNotUnlocked();

        NodeMap.CampaignNode memory node = nodeMap.getNode(_nodeId);

        // Fleets.createFleet already rejects a fleet mixing variants, so
        // checking the first ship's variant against the campaign's
        // requirement (if any) is sufficient to cover the whole fleet.
        // Checked before creating the fleet purely to fail fast/cheap on a
        // wrong-faction fleet rather than paying for fleet creation first.
        uint16 requiredVariant = nodeMap.campaignRequiredVariant(
            node.campaignId
        );
        if (
            requiredVariant != 0 &&
            _shipIds.length > 0 &&
            humanShips.getShip(_shipIds[0]).traits.variant != requiredVariant
        ) revert WrongCampaignVariant();

        nodeMatchCount++;
        gameId =
            NODE_MATCH_ID_OFFSET +
            engineIndex *
            ENGINE_ID_BLOCK_SIZE +
            nodeMatchCount;

        uint humanFleetId = fleets.createFleet(
            gameId,
            msg.sender,
            _shipIds,
            _positions,
            node.costLimit,
            true,
            node.mapId
        );

        uint aiFleetId = _mintAIFleet(node.mapId, gameId);

        gameIdToNodeId[gameId] = _nodeId;
        gameIdToHuman[gameId] = msg.sender;

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

        emit NodeMatchStarted(gameId, _nodeId, msg.sender);
    }

    // Allocates a fleet from AIShips' pool for this contract and registers
    // it with Fleets directly. Ships come from AIShips.allocateShip, which
    // reuses a slot released by a previously-finished match (see
    // onGameEnded/releaseShips below) when one is available, rather than
    // minting a fresh token every match.
    //
    // Fleet composition/placement is driven entirely by AIEncounters: an
    // admin-curated row/col -> AIShipConfig mapping for the node's map
    // (contracts/AIEncounters.sol), rather than a hardcoded template. Fleet
    // size is therefore dynamic (1-8 ships, whatever the map's admin
    // configured) instead of always exactly 3. A map with no configured
    // placements reverts rather than silently falling back to a default
    // fleet, matching this codebase's established "fail loud on
    // unconfigured admin data" precedent (see ShipAttributes' unconfigured-
    // variant reverts).
    //
    // Deliberately NOT capped by node.costLimit (or anything else) — that
    // limit exists to constrain the human's own fleet-building choices, not
    // to second-guess what an admin curated for an encounter. An admin
    // should be free to place a fleet that's arbitrarily expensive relative
    // to the node's costLimit; "enemy threat" for curation purposes is
    // derived off-chain (frontend sums ShipAttributes.calculateShipCost
    // over the node's AIEncounters placements), not tracked or enforced
    // here.
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
            shipIds[i] = ships.allocateShip(
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
        s.owner = address(this);
        s.equipment = _config.equipment;
        s.traits = _config.traits;
    }

    // Moves exactly one of the AI's currently-unmoved ships. Permissionless:
    // a frontend fires this right after the human's moveShip confirms. When
    // the AI has more ships left to move than the human this round (turn
    // order alternates ship-by-ship, but stays with whichever side still has
    // unmoved ships once the other side runs out), the turn stays with the
    // AI after this call returns — the caller is expected to call
    // takeAITurn again, once per remaining AI ship, exactly like the human
    // fires one moveShip transaction per ship (or use takeAITurns below to
    // move that whole tail in one transaction). This keeps every call's gas
    // cost to "decide and move one ship" instead of scaling with fleet size.
    //
    // Decision-making is delegated to the ship's own faction's AI contract
    // (looked up by variant in aiRegistry, see _decideMove below), which
    // picks a decision tree from the ship's cached archetype.
    // docs/audit-3.md HA6-12: the human can always end their own match, as
    // a loss, so their ships are never stuck in a game that can't progress
    // (e.g. the AI unable to move). Same as RoguelikeMatch.retreatRun(gameId).
    function forfeit(uint _gameId) external {
        if (gameIdToHuman[_gameId] != msg.sender) revert NotYourGame();
        game.forceEndSession(_gameId, address(this), msg.sender);
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

        // If every one of the AI's remaining ships is at 0 HP (destroyed in
        // combat but still mid the 3-round reactor-critical grace period —
        // see Game.sol's shipsWithZeroHP), it has nothing left it can
        // meaningfully do. Moving on would just repeat the deadlock this
        // whole function used to hit: round-completion/turn-switching only
        // run inside a *successful* moveShip call, and nothing else can
        // trigger one while it's still the AI's turn — a human can always
        // manually Retreat their own last 0-HP ship, but the AI has no
        // decision to make there, so just surrender instead. Same mechanism
        // PvPMatch uses for a human flee/timeout — SinglePlayerMatch is the
        // orchestrator of its own games (Game.startGame set it at kickoff),
        // so it's equally entitled to call forceEndSession.
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

        // Defense in depth: a heuristic bug or an edge case the rules
        // didn't anticipate should degrade to "this ship does nothing this
        // turn," not abort every other ship's move in this same call.
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

        // Each faction has its own AI built around its own abilities (e.g.
        // healing is an equipped special for variant 1 but a faction ability
        // for variant 2), so the tree is chosen by variant first, then by the
        // ship's archetype inside that faction's contract. A variant with no
        // registered AI fails at match start (aiFor at mint).
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

            // A 0-HP ship's only legal moveShip action is Retreat (see
            // Game.sol's hullPoints==0 guard) — _takeShipTurn never
            // attempts that, so picking it here would revert every time
            // and this ship would never enter joinerMovedShipIds. Since
            // this loop always returns the *first* unmoved ship, that
            // would permanently block every other ship behind it too,
            // and — because currentTurn only advances inside a
            // successful moveShip — deadlock the whole match. Game.sol's
            // own round-completion math already treats a 0-HP ship as
            // accounted for without requiring it to move (shipsWithZeroHP
            // / _setShipHPToZero), so mirror that here: skip it and keep
            // looking for a ship that can actually act.
            (Attributes memory attrs, bool found) = AIBehavior.findAttributes(
                g,
                active[i]
            );
            if (found && attrs.hullPoints == 0) continue;

            return active[i];
        }
        return 0;
    }

    // IGameOrchestrator: called by core Game.sol whenever a session this
    // contract started ends. Fleet cleanup already happens unconditionally
    // inside core Game._endGame. Releases this game's full AI roster back
    // to AIShips' pool exactly once here — win, loss, or draw — rather than
    // per-ship-destroyed mid-match, so a slot is never touched while its
    // game might still reference it. If this was a node match and the
    // human won, also records the node as completed so it counts as a
    // prerequisite for unlocking other nodes — never on an AI win or draw.
    function onGameEnded(uint _gameId, address _winner, address) external {
        if (msg.sender != address(game)) revert NotGame();

        ships.releaseShips(gameIdToAiShipIds[_gameId]);
        delete gameIdToAiShipIds[_gameId];

        uint nodeId = gameIdToNodeId[_gameId];
        if (nodeId != 0 && _winner == gameIdToHuman[_gameId]) {
            nodeMap.recordCompletion(_winner, nodeId);
        }
    }

    // ILobbiesOrchestratorCheck: ShipsRouter.setTimestampDestroyed (via
    // DestroyRewardLib) calls this — through config.lobbyAddress, now
    // pointed at this contract instead of Lobbies — to tell an AI-owned
    // ship from a player-owned one. AI ships are always allocated to
    // address(this) (see _mintAIFleet), so a plain identity check replaces
    // Lobbies' old address=>bool mapping exactly.
    function isSinglePlayerOrchestrator(
        address _address
    ) external view returns (bool) {
        return _address == address(this);
    }
}

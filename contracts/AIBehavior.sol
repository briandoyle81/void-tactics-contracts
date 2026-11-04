// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "./Types.sol";
import "./IMaps.sol";

// Shared toolbox for the AI turn-decision engine: targeting, stepping,
// scoring-tile and per-archetype rule primitives. Every function here is
// internal/pure/view (no storage writes), so this compiles as a plain
// internal Solidity library — inlined into each contract that uses it, no
// separate deployment/delegatecall needed (unlike SpecialEffectsLib.sol,
// which needs external+storage because it writes game state; this only
// ever reads and returns a decision).
//
// Which tree a ship actually follows is NOT decided here. Each variant
// (faction) has its own AI contract (Variant1AI, Variant2AI, ...) that
// composes its decision trees from these primitives using what it knows
// about its own faction — e.g. that healing is an equipped special, or that
// every ship has a repair action but no ram. AIBehaviorRegistry maps
// variant -> that contract, so a faction's AI can be replaced or upgraded
// without redeploying the match contracts that call it.
//
// Design constraint: every decision here is paid for in gas by the human
// player triggering takeAITurn, and Solidity has no real search/pathfinding
// primitives. So this is deliberately a cheap ordered priority-list per
// archetype (check a primitive, act or fall through) rather than anything
// resembling enumerate-and-score optimization. Movement ("step toward"/
// "step away") was greedy axis-priority stepping toward/away from a single
// target point. Stepping toward a target now uses a bitboard pathfinding
// search (_pathStep, 2026-11-03), with the greedy step as its fallback. SinglePlayerMatch
// wraps each ship's actual moveShip call in try/catch specifically to
// absorb the rare case this produces an illegal move (e.g. stepping onto an
// occupied cell) rather than reverting the whole turn.
library AIBehavior {
    struct Decision {
        int16 destRow;
        int16 destCol;
        ActionType action;
        uint actionTarget;
    }

    // Bundles the values almost every function here needs, to keep
    // individual function signatures short — Solidity's legacy codegen
    // runs out of stack slots quickly once a view function has ~6+
    // parameters plus a handful of locals, the same issue SpecialEffectsLib
    // hit earlier for the same reason.
    // The orchestrator fills board, maps, gameId, shipId and mainWeapon;
    // the AI contract fills the rest from `board` with loadView
    // (2026-10-31). `board` is Game.getAIBoard's flat array, cheap to pass
    // on compared with the decoded AIView.
    struct Ctx {
        AIView g;
        uint[] board;
        IMaps maps;
        uint gameId;
        uint shipId;
        Position pos;
        Attributes attrs;
        MainWeapon mainWeapon;
        ScoringPosition[] scoringPositions;
        int16 gridWidth;
        int16 gridHeight;
        // From Game (GameData.occupied / live), filled by loadView.
        uint256 occupied;
        uint256 creatorLive;
        uint256 joinerLive;
        // This ship's own cell, for excluding it from `occupied`.
        uint256 selfBit;
        // Maps' impassable tiles, for _pathStep.
        uint256 impassable;
    }

    // Game.GRID_WIDTH / GRID_HEIGHT.
    int16 constant GRID_WIDTH = 17;
    int16 constant GRID_HEIGHT = 11;

    error ShipNotInView();

    // Fills in the board data from the game: the view, this ship's own
    // position and stats, the scoring tiles and the grid size. Called first
    // by every IVariantAI.decide. Reverts if the ship isn't active; the
    // orchestrator's try/catch turns that into a pass.
    function loadView(Ctx memory ctx) internal view {
        uint[] memory board = ctx.board;
        ctx.g = unpackBoard(board);
        ctx.occupied = board[0];
        ctx.creatorLive = board[1];
        ctx.joinerLive = board[2];
        bool found;
        (ctx.pos, found) = findPosition(ctx.g, ctx.shipId);
        if (!found) revert ShipNotInView();
        (ctx.attrs, ) = findAttributes(ctx.g, ctx.shipId);
        ctx.selfBit = _cellBit(ctx.pos);
        ctx.scoringPositions = ctx.maps.getGameScoringPositions(ctx.gameId);
        ctx.impassable = ctx.maps.getImpassableBitmap(ctx.gameId);
        ctx.gridWidth = GRID_WIDTH;
        ctx.gridHeight = GRID_HEIGHT;
    }

    // Game.getAIBoard's header length, before the per-ship pairs.
    uint constant BOARD_HEADER = 7;

    // What an AI orchestrator (always the joiner) needs before an AI move,
    // from Game.getAIBoard's array: whether the joiner has a live ship, and
    // the next joiner ship to move (0 if none), with its position. Game
    // lets any unmoved ship go next, so the AI picks (2026-11-03), from
    // the board alone: a ship that can destroy a live enemy with one shot
    // first, then one with a live enemy in range, then the rest, and
    // Supports (`isSupport`, the orchestrator's archetype lookup) last, so
    // they repair after the ships they would repair have acted. Ties go to
    // the first in the active list. Before, it was always the first.
    function turnState(
        uint[] memory board,
        function(uint) view returns (bool) isSupport
    )
        internal
        view
        returns (
            bool ended,
            address currentTurn,
            address creator,
            bool hasLiveShip,
            uint nextShipId,
            Position memory nextPosition
        )
    {
        ended = board[4] != 0;
        currentTurn = address(uint160(board[5]));
        creator = address(uint160(board[6]));
        hasLiveShip = board[2] != 0;
        uint w;
        (nextShipId, w) = _pickShip(board, isSupport);
        nextPosition = Position(int16(uint16(w)), int16(uint16(w >> 16)));
    }

    struct Pick {
        uint[] enemies;
        uint n;
        uint best;
        uint8 gun;
        bool cached;
        uint256 killMask;
    }

    // turnState's pick: the unmoved live joiner ship with the highest
    // _turnRank, the first on a tie. One pass: Game.getAIBoard lists the
    // creator's ships before the joiner's, so the live creator ships are
    // gathered before any joiner ship is ranked.
    function _pickShip(
        uint[] memory board,
        function(uint) view returns (bool) isSupport
    ) private view returns (uint id, uint word) {
        Pick memory p;
        p.enemies = new uint[]((board.length - BOARD_HEADER) / 2);
        uint round = board[3];
        for (uint i = BOARD_HEADER; i + 1 < board.length; i += 2) {
            uint w = board[i + 1];
            // 0 HP (hullPoints @11): never picked, never a target.
            if (uint8(w >> 88) == 0) continue;
            // A creator ship (isCreator @4).
            if (uint8(w >> 32) != 0) {
                p.enemies[p.n++] = w;
                continue;
            }
            // Moved this round (movedInRound u24 @16).
            if (uint24(w >> 128) == round) continue;
            uint rank = _turnRank(board[1], p, w);
            if (rank <= p.best) continue;
            // Looked up only when this ship would be picked.
            if (isSupport(board[i])) rank = 1;
            if (rank <= p.best) continue;
            (p.best, id, word) = (rank, board[i], w);
            if (rank == 4) break;
        }
    }

    // 4: a live creator ship within gun range (Manhattan, line of sight not
    // checked) that one shot destroys; 3: one within range; 2: neither.
    // The range check is one bitboard: this ship's cell grown by its range,
    // against the live creator bitmap. Which creator ships one shot
    // destroys is a bitmap per gun damage, reused while the gun repeats.
    function _turnRank(
        uint256 creatorLive,
        Pick memory p,
        uint w
    ) private pure returns (uint) {
        uint256 inRange = _dilate(
            uint256(1) << _wordCell(w),
            uint8(w >> 72),
            BOARD_MASK
        ) & creatorLive;
        if (inRange == 0) return 2;
        uint8 gun = uint8(w >> 80);
        if (!p.cached || p.gun != gun) {
            p.killMask = _killMask(p, gun);
            (p.gun, p.cached) = (gun, true);
        }
        return inRange & p.killMask != 0 ? 4 : 3;
    }

    function _killMask(
        Pick memory p,
        uint8 gun
    ) private pure returns (uint256 mask) {
        for (uint i = 0; i < p.n; i++) {
            uint e = p.enemies[i];
            if (shotDamage(gun, uint8(e >> 112)) >= uint8(e >> 88))
                mask |= uint256(1) << _wordCell(e);
        }
    }

    // A board word's cell index (row @0, col @2), row * GRID_WIDTH + col.
    function _wordCell(uint w) private pure returns (uint) {
        return
            uint(uint16(w)) * uint(uint16(GRID_WIDTH)) + uint(uint16(w >> 16));
    }

    // Rebuilds the AIView from Game.getAIBoard's flat array (2026-10-31):
    // the header, then an id and a raw board word per ship. Byte
    // offsets follow ShipBoardState in Types.sol, from the word's lowest
    // byte: row i16 @0, col i16 @2, isCreator @4, status @5, version u16
    // @7, range @9, gunDamage @10, hullPoints @11, maxHullPoints @12,
    // movement @13, damageReduction @14, reactorCriticalTimer @15.
    function unpackBoard(
        uint[] memory board
    ) internal pure returns (AIView memory v) {
        uint n = (board.length - BOARD_HEADER) / 2;
        v.shipIds = new uint[](n);
        v.shipAttributes = new Attributes[](n);
        v.shipPositions = new ShipPosition[](n);
        for (uint i = 0; i < n; i++) {
            uint id = board[BOARD_HEADER + 2 * i];
            uint w = board[BOARD_HEADER + 1 + 2 * i];
            v.shipIds[i] = id;
            v.shipPositions[i] = ShipPosition(
                id,
                Position(int16(uint16(w)), int16(uint16(w >> 16))),
                uint8(w >> 32) != 0,
                uint8(w >> 40)
            );
            v.shipAttributes[i] = Attributes(
                uint16(w >> 56),
                uint8(w >> 72),
                uint8(w >> 80),
                uint8(w >> 88),
                uint8(w >> 96),
                uint8(w >> 104),
                uint8(w >> 112),
                uint8(w >> 120)
            );
        }
    }

    // A cell's bit in Game's bitmaps; 0 for a cell off the board, so an
    // off-board cell never aliases a real one.
    function _cellBit(Position memory p) private pure returns (uint256) {
        if (p.row < 0 || p.col < 0 || p.row >= GRID_HEIGHT || p.col >= GRID_WIDTH) {
            return 0;
        }
        return
            uint256(1) <<
            (uint(uint16(p.row)) * uint(uint16(GRID_WIDTH)) + uint(uint16(p.col)));
    }

    // ---- shared lookups over the AIView (fetched once per decision by
    // loadView — these never make a new Game call) ----

    function findPosition(
        AIView memory g,
        uint shipId
    ) internal pure returns (Position memory pos, bool found) {
        for (uint i = 0; i < g.shipPositions.length; i++) {
            if (g.shipPositions[i].shipId == shipId) {
                return (g.shipPositions[i].position, true);
            }
        }
    }

    // O(n) scan — only use this for a single specific shipId (e.g. the one
    // ship whose turn is being decided this call). Do NOT call this inside a
    // loop over ctx.g.shipPositions/joinerActiveShipIds: Game.getGame()
    // builds shipIds/shipAttributes and shipPositions from the exact same
    // creatorActiveShipIds-then-joinerActiveShipIds ordering (see
    // Game.sol's getGame/getAllShipPositions), so for any index i where
    // shipPositions[i].status == 0 (the only case any candidate-scan helper
    // below ever needs), shipAttributes[i] is already that exact ship's
    // attributes — read it directly instead of re-scanning for it (G-01).
    function findAttributes(
        AIView memory g,
        uint shipId
    ) internal pure returns (Attributes memory attrs, bool found) {
        for (uint i = 0; i < g.shipIds.length; i++) {
            if (g.shipIds[i] == shipId) {
                return (g.shipAttributes[i], true);
            }
        }
    }

    // Bit-per-cell mask (same packing Maps.sol's own bitmaps use: row *
    // gridWidth + col) of every currently-alive, non-disabled ship on the
    // given side, for
    // hasMapsAvoidingShips — ships don't block their own side's shots, only
    // the opposing side's, so the caller picks isCreatorSide based on whose
    // shot is being checked (not always "the enemy from the AI's own point
    // of view" — _enemyThreatensTile below asks "can THIS enemy hit that
    // tile," which flips the roles). `excludeShipId` (0 = exclude nothing)
    // keeps one specific ship's own tile out of the mask — required when
    // it's the exact ship being shot at (see hasMapsAvoidingShips's own
    // comment for why that's not optional).
    function _shipOccupiedBitmap(
        Ctx memory ctx,
        bool isCreatorSide
    ) private pure returns (uint256) {
        // Game's live bitmap for that side (2026-10-31; was a loop over
        // every ship): on the board with HP > 0, the same set this used to
        // build.
        return isCreatorSide ? ctx.creatorLive : ctx.joinerLive;
    }

    // Shared by _bestEnemyWithin/_enemyThreatensTile: LOS from `fromPos` to
    // `targetPos`, blocked by terrain plus every ship in `sideBitmap` EXCEPT
    // targetPos's own tile (cleared here via a single bit-index calc) — see
    // hasMapsAvoidingShips for why the destination's own occupant can never
    // count as blocking a shot at it. Split into its own function purely to
    // relieve legacy-codegen stack pressure in both callers, which already
    // sit on a lot of locals of their own (bestHp/bestIsZero/bestOnTile in
    // one case, the outer loop's sp/attrs in the other).
    function _hasLosExcludingTarget(
        Ctx memory ctx,
        Position memory fromPos,
        Position memory targetPos,
        uint256 sideBitmap
    ) private view returns (bool) {
        uint256 bitIndex = uint(uint16(targetPos.row)) *
            uint(uint16(ctx.gridWidth)) +
            uint(uint16(targetPos.col));
        return
            ctx.maps.hasMapsAvoidingShips(
                ctx.gameId,
                fromPos.row,
                fromPos.col,
                targetPos.row,
                targetPos.col,
                sideBitmap & ~(uint256(1) << bitIndex)
            );
    }

    function _manhattan(
        Position memory a,
        Position memory b
    ) private pure returns (uint16) {
        uint16 rowDiff = a.row > b.row
            ? uint16(a.row - b.row)
            : uint16(b.row - a.row);
        uint16 colDiff = a.col > b.col
            ? uint16(a.col - b.col)
            : uint16(b.col - a.col);
        return rowDiff + colDiff;
    }

    // The enemy in manhattan range (with line of sight past range 1) to
    // shoot, ranked by _targetKey.
    function _bestEnemyInRange(
        Ctx memory ctx,
        Position memory fromPos,
        uint8 range
    ) private view returns (uint targetId, bool found) {
        return _bestEnemyWithin(ctx, fromPos, range, true);
    }

    // Same search, with line of sight optional: guns need it past range 1,
    // but some specials (e.g. Drone Swarm) only care about range.
    function _bestEnemyWithin(
        Ctx memory ctx,
        Position memory fromPos,
        uint8 range,
        bool needsLineOfSight
    ) private view returns (uint targetId, bool found) {
        uint bestKey;
        // Every OTHER enemy ship blocks LOS to a given candidate — computed
        // once (O(fleet size)), then per-candidate a single bit is cleared
        // to exclude that candidate's own tile (see hasMapsAvoidingShips for
        // why the shot's own target can never count as blocking itself).
        uint256 enemyBitmap = needsLineOfSight
            ? _shipOccupiedBitmap(ctx, true)
            : 0;
        for (uint i = 0; i < ctx.g.shipPositions.length; i++) {
            ShipPosition memory sp = ctx.g.shipPositions[i];
            if (sp.shipId == ctx.shipId || sp.status != 0 || !sp.isCreator)
                continue; // AI is always joiner, so enemies are isCreator
            uint16 dist = _manhattan(fromPos, sp.position);
            if (dist > range) continue;
            if (
                needsLineOfSight &&
                dist > 1 &&
                !_hasLosExcludingTarget(ctx, fromPos, sp.position, enemyBitmap)
            ) continue;
            // sp.status == 0 already checked above, so index i is in the
            // active range and shipAttributes[i] is guaranteed to be this
            // exact ship's attributes (G-01) — no scan needed.
            uint key = _targetKey(
                ctx,
                ctx.g.shipAttributes[i],
                sp.position,
                needsLineOfSight
            );
            // Strictly greater: on a tie the first candidate found stays.
            if (!found || key > bestKey) {
                targetId = sp.shipId;
                bestKey = key;
                found = true;
            }
        }
    }

    // A target's rank, higher first (2026-11-03; was: on a scoring tile,
    // then lowest HP): a live ship before a disabled one (a 0-HP ship can
    // neither shoot nor score), then a shot that destroys it, then standing
    // on a scoring tile, then more damage after its damage reduction, then
    // lower HP. `gun` is false for a no-line-of-sight special (Drone Swarm),
    // whose damage isn't the gun's, so the two damage keys are left out.
    function _targetKey(
        Ctx memory ctx,
        Attributes memory a,
        Position memory p,
        bool gun
    ) private pure returns (uint key) {
        bool onTile = _isScoringTile(ctx.scoringPositions, p);
        if (a.hullPoints == 0) return onTile ? 1 : 0;
        key = 1 << 30;
        uint dmg = gun ? shotDamage(ctx.attrs.gunDamage, a.damageReduction) : 0;
        if (gun && dmg >= a.hullPoints) key |= 1 << 29;
        if (onTile) key |= 1 << 28;
        key |= dmg << 8;
        key |= 255 - a.hullPoints;
    }

    // A gun shot's damage as Game applies it: gunDamage less
    // damageReduction percent, rounded down.
    function shotDamage(
        uint8 gunDamage,
        uint8 damageReduction
    ) internal pure returns (uint) {
        return gunDamage - (uint(gunDamage) * damageReduction) / 100;
    }

    function _isScoringTile(
        ScoringPosition[] memory scoringPositions,
        Position memory p
    ) private pure returns (bool) {
        for (uint i = 0; i < scoringPositions.length; i++) {
            if (
                scoringPositions[i].row == p.row &&
                scoringPositions[i].col == p.col
            ) return true;
        }
        return false;
    }

    // Same shape as _bestEnemyInRange but for the AI's own side, preferring
    // a 0-HP ally (a RepairDrones hit revives it) over the most-injured
    // alive ally.
    function _bestAllyToHeal(
        Ctx memory ctx,
        uint8 range
    ) private pure returns (uint targetId, bool found) {
        uint8 bestHp = type(uint8).max;
        bool bestIsZero = false;
        for (uint i = 0; i < ctx.g.shipPositions.length; i++) {
            ShipPosition memory sp = ctx.g.shipPositions[i];
            if (sp.shipId == ctx.shipId || sp.status != 0 || sp.isCreator)
                continue; // own side only, not self
            if (_manhattan(ctx.pos, sp.position) > range) continue;

            // sp.status == 0 already checked above (G-01) — direct index read.
            Attributes memory attrs = ctx.g.shipAttributes[i];
            if (attrs.hullPoints >= attrs.maxHullPoints)
                continue; // not actually injured

            bool isZero = attrs.hullPoints == 0;
            if (!found) {
                targetId = sp.shipId;
                found = true;
                bestHp = attrs.hullPoints;
                bestIsZero = isZero;
                continue;
            }
            if (isZero && !bestIsZero) {
                targetId = sp.shipId;
                bestHp = attrs.hullPoints;
                bestIsZero = true;
            } else if (isZero == bestIsZero && attrs.hullPoints < bestHp) {
                targetId = sp.shipId;
                bestHp = attrs.hullPoints;
            }
        }
    }

    // Nearest enemy position, anywhere on the board (live ones first, see
    // below). preferZeroHP
    // makes this look only at 0-HP enemies first, falling back to any enemy
    // if none exist — kept as a general targeting option even though no
    // archetype currently passes true (Rammer, the only caller that did,
    // was removed) — e.g. a future assassin-style archetype beelining for
    // a finishing blow would want this exact behavior.
    function _nearestEnemyPosition(
        Ctx memory ctx,
        bool preferZeroHP
    ) private pure returns (Position memory pos, bool found) {
        uint16 bestDist = type(uint16).max;
        if (preferZeroHP) {
            for (uint i = 0; i < ctx.g.shipPositions.length; i++) {
                ShipPosition memory sp = ctx.g.shipPositions[i];
                if (sp.shipId == ctx.shipId || sp.status != 0 || !sp.isCreator)
                    continue;
                // sp.status == 0 already checked above (G-01) — direct index read.
                if (ctx.g.shipAttributes[i].hullPoints != 0) continue;
                uint16 dist = _manhattan(ctx.pos, sp.position);
                if (!found || dist < bestDist) {
                    pos = sp.position;
                    found = true;
                    bestDist = dist;
                }
            }
            if (found) return (pos, found);
        }
        // Live ships first (2026-11-03): a wreck can't shoot or score, so
        // closing on one ahead of a live ship wastes moves. Wrecks only when
        // nothing else is left.
        for (uint pass = 0; pass < 2 && !found; pass++) {
            for (uint i = 0; i < ctx.g.shipPositions.length; i++) {
                ShipPosition memory sp = ctx.g.shipPositions[i];
                if (sp.shipId == ctx.shipId || sp.status != 0 || !sp.isCreator)
                    continue;
                // sp.status == 0 already checked above (G-01) — direct index read.
                if (pass == 0 && ctx.g.shipAttributes[i].hullPoints == 0) continue;
                uint16 dist = _manhattan(ctx.pos, sp.position);
                if (!found || dist < bestDist) {
                    pos = sp.position;
                    found = true;
                    bestDist = dist;
                }
            }
        }
    }

    // Another ship stands on `p` and it isn't a live enemy: an ally, or a
    // disabled ship of either side. The AI is always the joiner, so live
    // enemies are creatorLive (as in every _shipOccupiedBitmap(ctx, true) call).
    function _unclaimableTile(
        Ctx memory ctx,
        Position memory p
    ) private pure returns (bool) {
        return _isOccupiedByOther(ctx, p) && (ctx.creatorLive & _cellBit(p)) == 0;
    }

    function _isOccupiedByOther(
        Ctx memory ctx,
        Position memory p
    ) private pure returns (bool) {
        // Game's occupied bitmap minus this ship's own cell (2026-10-31; was
        // a loop over every ship). Off-board cells are never occupied.
        return (ctx.occupied & ~ctx.selfBit & _cellBit(p)) != 0;
    }

    // True if `dest` is actually reachable from ctx.pos this turn: not
    // occupied by any other ship (ally or enemy — landing is never allowed
    // on either), and the straight-line path doesn't cross an enemy ship
    // (AI is always joiner, so enemies are isCreator — see
    // _shipOccupiedBitmap). Centralizes "is this destination legal" so every
    // stepping helper below shares one rule instead of only checking
    // destination-occupancy, which is all that was needed before enemy
    // ships could also block a path partway through (2026-09-26) — found via
    // a real scenario breaking: a repair approach whose only path ran
    // straight through an enemy ship it wasn't targeting.
    // `enemyBitmap` is precomputed and passed in rather than built here —
    // callers that check several candidates (the backoff/detour loops
    // below) would otherwise rebuild the same O(fleet size) bitmap on every
    // single candidate.
    function _isReachable(
        Ctx memory ctx,
        Position memory dest,
        uint256 enemyBitmap
    ) private view returns (bool) {
        if (dest.row == ctx.pos.row && dest.col == ctx.pos.col) return true;
        if (_isOccupiedByOther(ctx, dest)) return false;
        return
            ctx.maps.hasMovementPathAvoidingShips(
                ctx.gameId,
                ctx.pos.row,
                ctx.pos.col,
                dest.row,
                dest.col,
                enemyBitmap
            );
    }

    // Tries the direct line toward `target` at successively shorter
    // distances, returning the first reachable point — or `ctx.pos`
    // (moved == false) if every distance along that exact line is blocked.
    function _backoffToward(
        Ctx memory ctx,
        Position memory target,
        uint8 maxSteps,
        uint256 enemyBitmap
    ) private view returns (Position memory dest, bool moved) {
        uint8 steps = maxSteps;
        while (steps > 0) {
            dest = _stepToward(ctx.pos, target, steps);
            if (_isReachable(ctx, dest, enemyBitmap)) return (dest, true);
            steps--;
        }
        return (ctx.pos, false);
    }

    // Like _stepToward, but guarantees the result is actually reachable
    // this turn instead of just geometrically closer. First tries the
    // direct line toward `target` at successively shorter distances (the
    // backoff above); if an obstruction sits exactly on that whole line —
    // the common case this was built for: an enemy ship positioned directly
    // between this ship and where it wants to go — tries a small
    // perpendicular detour off the same target before giving up and staying
    // put. Not full pathfinding (this game has none, see Maps.sol's
    // hasMovementPath comment on why): a cheap, bounded "try going around,"
    // not a search. Found via a real scenario breaking: a repair approach
    // whose only direct line ran straight through the enemy it wasn't
    // targeting, and every shorter distance on that same line was equally
    // blocked (2026-09-26).
    //
    // `stopShortBy` is 0 for "land on/adjacent to it" (_moveToward), 1 for
    // "stop adjacent" (advanceToward), or a weapon/heal range for "get
    // within range" callers (_withinRangeOf, standoffPosition).
    function _stepTowardReachable(
        Ctx memory ctx,
        Position memory target,
        uint8 maxSteps,
        uint8 stopShortBy
    ) private view returns (Position memory dest) {
        uint256 enemyBitmap = _shipOccupiedBitmap(ctx, true);
        if (_manhattan(ctx.pos, target) <= stopShortBy) return ctx.pos;
        bool moved;
        (dest, moved) = _pathStep(ctx, target, maxSteps, stopShortBy, enemyBitmap);
        if (moved) return dest;
        // No tile within reach is closer by the path search (or the line
        // checks ran out): the older greedy step, detours and sidestep.
        (dest, moved) = _primaryAttempt(
            ctx,
            target,
            maxSteps,
            stopShortBy,
            enemyBitmap
        );
        if (moved) return dest;

        // Direct line fully blocked its whole useful length — offset the
        // approach by one tile on each axis and retry. Four fixed offsets,
        // not a search: unrolled (not a loop over an offset array) and each
        // attempt its own call, purely to relieve legacy-codegen stack
        // pressure — this function was already tight.
        (dest, moved) = _tryDetour(ctx, target, 1, 0, maxSteps, stopShortBy, enemyBitmap);
        if (moved) return dest;
        (dest, moved) = _tryDetour(ctx, target, -1, 0, maxSteps, stopShortBy, enemyBitmap);
        if (moved) return dest;
        (dest, moved) = _tryDetour(ctx, target, 0, 1, maxSteps, stopShortBy, enemyBitmap);
        if (moved) return dest;
        (dest, moved) = _tryDetour(ctx, target, 0, -1, maxSteps, stopShortBy, enemyBitmap);
        if (moved) return dest;
        // Within one tile of where it wants to be, only the ship on that tile
        // is in the way, not a wall: stepping aside would just pull it away.
        if (_manhattan(ctx.pos, target) <= uint16(stopShortBy) + 1) return ctx.pos;
        (dest, moved) = _trySidestep(ctx, target, maxSteps, enemyBitmap);
        if (moved) return dest;
        return ctx.pos;
    }

    // Board masks for the bitboard search: every cell, and the first and
    // last columns (a one-bit shift wraps between them across rows).
    uint256 constant BOARD_MASK = 0x7ffffffffffffffffffffffffffffffffffffffffffffff;
    uint256 constant COL_FIRST = 0x4000200010000800040002000100008000400020001;
    uint256 constant COL_LAST = 0x40002000100008000400020001000080004000200010000;
    // Line checks (Maps calls) one _pathStep may spend before giving up.
    uint constant PATH_CHECKS_MAX = 12;

    struct PathSearch {
        uint256 passable;
        uint256 frontier;
        uint256 visited;
        uint256 reach;
        uint256 greedyBit;
        uint256 enemyBitmap;
        uint checks;
    }

    // Pathfinding toward `target` (2026-11-03). A breadth-first search grows
    // out from the goal, every tile within `stopShortBy` of the target, one
    // ring of walking distance at a time. Impassable tiles and live enemies
    // stop it; allies and wrecks don't, since ships can pass them. The board
    // is 187 cells, so each ring is a few shifts on one word. The first ring
    // holding a tile this ship can land on with a clear line this turn gives
    // the move: the tile closest to the goal by walking distance, around
    // walls. Ties go to the greedy step's tile, then the shortest move. Gives
    // up (moved == false) on reaching this ship's own ring, since nothing
    // reachable is closer, or after PATH_CHECKS_MAX line checks.
    function _pathStep(
        Ctx memory ctx,
        Position memory target,
        uint8 maxSteps,
        uint8 stopShortBy,
        uint256 enemyBitmap
    ) private view returns (Position memory, bool) {
        PathSearch memory p;
        p.enemyBitmap = enemyBitmap;
        p.passable = BOARD_MASK & ~(ctx.impassable | enemyBitmap);
        p.reach =
            _dilate(ctx.selfBit, maxSteps, BOARD_MASK) &
            ~(ctx.occupied | ctx.impassable);
        p.greedyBit = _cellBit(
            _stepToward(
                ctx.pos,
                target,
                _min8(_manhattan(ctx.pos, target) - stopShortBy, maxSteps)
            )
        );
        p.frontier = _dilate(_cellBit(target), stopShortBy, BOARD_MASK);
        p.visited = p.frontier;
        while (p.frontier != 0) {
            if (p.frontier & ctx.selfBit != 0) break;
            (Position memory dest, bool found) = _tryRing(ctx, p);
            if (found) return (dest, true);
            if (p.checks >= PATH_CHECKS_MAX) break;
            uint256 next = _dilate(p.frontier, 1, p.passable) & ~p.visited;
            p.visited |= next;
            p.frontier = next;
        }
        return (ctx.pos, false);
    }

    // The tiles of one ring that this ship can land on: the greedy step's
    // tile first, then the shortest move first (the lowest cell on a tie),
    // each checked for a clear line.
    function _tryRing(
        Ctx memory ctx,
        PathSearch memory p
    ) private view returns (Position memory dest, bool) {
        uint256 cands = p.frontier & p.reach;
        if (cands & p.greedyBit != 0) {
            cands &= ~p.greedyBit;
            dest = _cellPos(_lowestBit(p.greedyBit));
            p.checks++;
            if (_isReachable(ctx, dest, p.enemyBitmap)) return (dest, true);
        }
        while (cands != 0 && p.checks < PATH_CHECKS_MAX) {
            uint256 bit = _nearestCell(ctx.pos, cands);
            cands &= ~bit;
            dest = _cellPos(_lowestBit(bit));
            p.checks++;
            if (_isReachable(ctx, dest, p.enemyBitmap)) return (dest, true);
        }
        return (ctx.pos, false);
    }

    // The bit of the cell in `cells` nearest `from`, the lowest on a tie.
    function _nearestCell(
        Position memory from,
        uint256 cells
    ) private pure returns (uint256 best) {
        uint16 bestDist = type(uint16).max;
        while (cells != 0) {
            uint256 bit = cells & (~cells + 1);
            cells &= cells - 1;
            uint16 d = _manhattan(from, _cellPos(_lowestBit(bit)));
            if (d < bestDist) (bestDist, best) = (d, bit);
        }
    }

    // `x` grown by `n` tiles in the four directions, kept within `mask`.
    function _dilate(
        uint256 x,
        uint n,
        uint256 mask
    ) private pure returns (uint256) {
        for (; n > 0; n--) {
            x =
                (x |
                    ((x << 1) & ~COL_FIRST) |
                    ((x >> 1) & ~COL_LAST) |
                    (x << 17) |
                    (x >> 17)) &
                mask;
        }
        return x;
    }

    function _lowestBit(uint256 x) private pure returns (uint i) {
        if (x & type(uint128).max == 0) { x >>= 128; i += 128; }
        if (x & type(uint64).max == 0) { x >>= 64; i += 64; }
        if (x & type(uint32).max == 0) { x >>= 32; i += 32; }
        if (x & type(uint16).max == 0) { x >>= 16; i += 16; }
        if (x & type(uint8).max == 0) { x >>= 8; i += 8; }
        if (x & 0xf == 0) { x >>= 4; i += 4; }
        if (x & 0x3 == 0) { x >>= 2; i += 2; }
        if (x & 0x1 == 0) i += 1;
    }

    function _cellPos(uint idx) private pure returns (Position memory) {
        return
            Position({
                row: int16(uint16(idx / uint(uint16(GRID_WIDTH)))),
                col: int16(uint16(idx % uint(uint16(GRID_WIDTH))))
            });
    }

    // Last resort for _stepTowardReachable, when the direct line and every
    // detour hit the same obstacle. That happens when a wall lies across the
    // long axis toward the target: _stepToward spends the whole move on that
    // axis first, so every candidate runs into it. Movement is straight-line
    // only (Maps.hasMovementPath), so getting around takes a sideways step:
    // along the short axis, toward the target's side first and then the
    // other, as far as movement allows (shorter if that isn't reachable).
    // The next turn's line toward the target then starts clear of the wall.
    // Found live 2026-11-03: two Grunts stood behind impassable tiles for
    // several turns while every enemy was on the far side.
    function _trySidestep(
        Ctx memory ctx,
        Position memory target,
        uint8 maxSteps,
        uint256 enemyBitmap
    ) private view returns (Position memory dest, bool moved) {
        int16 rowDelta = target.row - ctx.pos.row;
        int16 colDelta = target.col - ctx.pos.col;
        // Same tie-break as _stepToward: rows are the long axis on a tie.
        bool sideIsCol = (rowDelta < 0 ? -rowDelta : rowDelta) >=
            (colDelta < 0 ? -colDelta : colDelta);
        int16 first = (sideIsCol ? colDelta : rowDelta) < 0 ? int16(-1) : int16(1);
        (dest, moved) = _sidestepDir(ctx, sideIsCol, first, maxSteps, enemyBitmap);
        if (moved) return (dest, true);
        return _sidestepDir(ctx, sideIsCol, -first, maxSteps, enemyBitmap);
    }

    // One direction of _trySidestep: the farthest reachable tile up to
    // `maxSteps` along that axis. Split out for stack pressure, like _tryDetour.
    function _sidestepDir(
        Ctx memory ctx,
        bool alongCol,
        int16 dir,
        uint8 maxSteps,
        uint256 enemyBitmap
    ) private view returns (Position memory p, bool) {
        for (uint8 steps = maxSteps; steps > 0; steps--) {
            int16 off = dir * int16(uint16(steps));
            p = alongCol
                ? Position({row: ctx.pos.row, col: ctx.pos.col + off})
                : Position({row: ctx.pos.row + off, col: ctx.pos.col});
            if (
                p.row >= 0 &&
                p.row < ctx.gridHeight &&
                p.col >= 0 &&
                p.col < ctx.gridWidth &&
                _isReachable(ctx, p, enemyBitmap)
            ) return (p, true);
        }
        return (ctx.pos, false);
    }

    // The un-detoured attempt: dist<=stopShortBy counts as "already there"
    // (moved=true, dest=ctx.pos — the caller shouldn't try a detour when
    // nothing was needed in the first place), otherwise the direct-line
    // backoff. Split out purely to relieve _stepTowardReachable's own stack
    // pressure (same reasoning as _tryDetour below).
    function _primaryAttempt(
        Ctx memory ctx,
        Position memory target,
        uint8 maxSteps,
        uint8 stopShortBy,
        uint256 enemyBitmap
    ) private view returns (Position memory, bool) {
        uint16 dist = _manhattan(ctx.pos, target);
        if (dist <= stopShortBy) return (ctx.pos, true);
        uint8 steps = _min8(dist - stopShortBy, maxSteps);
        return _backoffToward(ctx, target, steps, enemyBitmap);
    }

    // One perpendicular-offset attempt for _stepTowardReachable's detour
    // loop — see that function's own comment for why this exists.
    function _tryDetour(
        Ctx memory ctx,
        Position memory target,
        int16 rowOffset,
        int16 colOffset,
        uint8 maxSteps,
        uint8 stopShortBy,
        uint256 enemyBitmap
    ) private view returns (Position memory, bool) {
        int16 detourRow = target.row + rowOffset;
        int16 detourCol = target.col + colOffset;
        if (
            detourRow < 0 ||
            detourRow >= ctx.gridHeight ||
            detourCol < 0 ||
            detourCol >= ctx.gridWidth
        ) return (ctx.pos, false);
        Position memory detourTarget = Position({
            row: detourRow,
            col: detourCol
        });
        uint16 detourDist = _manhattan(ctx.pos, detourTarget);
        if (detourDist <= stopShortBy) return (ctx.pos, false);
        uint8 detourSteps = _min8(detourDist - stopShortBy, maxSteps);
        return _backoffToward(ctx, detourTarget, detourSteps, enemyBitmap);
    }

    // Picks a scoring-tile movement target: the tile this ship is best
    // placed to take. Tiers, best first:
    //   0. free, and this ship gets there in fewer turns than any live enemy;
    //   1. free, and it's a tie;
    //   2. free, but an enemy gets there first;
    //   3. held by a live enemy (worth contesting).
    // A tile held by another of its own ships, or by a wreck, is never
    // picked. Within a tier: the most points per turn of travel, then the
    // nearest. Replaced a weapon-range side bias (2026-11-03) that sent
    // short-range ships to the tiles on the enemy's half first, which the
    // enemy, moving first from that side, always reached first.
    function _bestScoringTile(
        Ctx memory ctx
    ) private pure returns (Position memory pos, bool found) {
        TileChoice memory best;
        for (uint i = 0; i < ctx.scoringPositions.length; i++) {
            ScoringPosition memory sp = ctx.scoringPositions[i];
            TileChoice memory c = _tileRace(
                ctx,
                Position({row: sp.row, col: sp.col}),
                sp.points
            );
            if (c.ok && (!best.ok || _betterTile(c, best))) best = c;
        }
        return (best.pos, best.ok);
    }

    // One scoring tile as _bestScoringTile sees it.
    struct TileChoice {
        Position pos;
        bool ok; // a tile this ship could take or contest
        uint tier;
        uint turns; // this ship's turns to reach it
        uint points;
        uint16 dist;
    }

    function _tileRace(
        Ctx memory ctx,
        Position memory t,
        uint8 points
    ) private pure returns (TileChoice memory c) {
        c.pos = t;
        c.points = points;
        c.dist = _manhattan(ctx.pos, t);
        c.turns = _turnsToReach(c.dist, ctx.attrs.movement);
        if (ctx.creatorLive & _cellBit(t) != 0) {
            c.tier = 3;
            c.ok = true;
            return c;
        }
        if (_isOccupiedByOther(ctx, t)) return c; // own ship or a wreck
        uint enemyTurns = type(uint).max;
        for (uint i = 0; i < ctx.g.shipPositions.length; i++) {
            ShipPosition memory sp = ctx.g.shipPositions[i];
            if (sp.status != 0 || !sp.isCreator) continue;
            // sp.status == 0 already checked above (G-01) — direct index read.
            Attributes memory a = ctx.g.shipAttributes[i];
            if (a.hullPoints == 0) continue;
            uint n = _turnsToReach(_manhattan(sp.position, t), a.movement);
            if (n < enemyTurns) enemyTurns = n;
        }
        c.tier = c.turns < enemyTurns ? 0 : c.turns == enemyTurns ? 1 : 2;
        c.ok = true;
    }

    // Lower tier, then more points per turn of travel (points / (turns + 1),
    // compared by cross-multiplying), then the shorter distance.
    function _betterTile(
        TileChoice memory a,
        TileChoice memory b
    ) private pure returns (bool) {
        if (a.tier != b.tier) return a.tier < b.tier;
        uint av = a.points * (b.turns + 1);
        uint bv = b.points * (a.turns + 1);
        if (av != bv) return av > bv;
        return a.dist < b.dist;
    }

    function _turnsToReach(
        uint16 dist,
        uint8 movement
    ) private pure returns (uint) {
        if (dist == 0) return 0;
        if (movement == 0) return type(uint).max;
        return (uint(dist) + movement - 1) / movement;
    }

    // True when this ship is already standing on a scoring tile with no
    // enemy in range from here (caller guarantees the latter — the
    // free-shoot check already failed) and should therefore just hold
    // position instead of being lured away by "seek a scoring tile"/
    // "approach the enemy" movement logic. Overridden only when ALL of:
    // this ship could actually reach a shot by moving anyway, another
    // living ally could reach this tile itself if this ship leaves, and no
    // enemy is currently positioned to threaten the tile — i.e. leaving is
    // genuinely free. Any one of those failing means hold.
    function _shouldHoldScoringTile(Ctx memory ctx) private view returns (bool) {
        if (!_isScoringTile(ctx.scoringPositions, ctx.pos)) return false;

        (Position memory enemyPos, bool enemyFound) = _nearestEnemyPosition(
            ctx,
            false
        );
        if (enemyFound) {
            Position memory stepped = _stepToward(
                ctx.pos,
                enemyPos,
                ctx.attrs.movement
            );
            (, bool couldShoot) = _bestEnemyInRange(
                ctx,
                stepped,
                ctx.attrs.range
            );
            if (
                couldShoot &&
                _allyCanCoverTile(ctx) &&
                !_enemyThreatensTile(ctx, ctx.pos)
            ) {
                return false;
            }
        }
        return true;
    }

    // Any other living ally that could reach this position under its own
    // movement stat this turn — used to decide whether it's safe for the
    // ship currently on the tile to leave it uncovered.
    function _allyCanCoverTile(
        Ctx memory ctx
    ) private view returns (bool) {
        for (uint i = 0; i < ctx.g.shipPositions.length; i++) {
            ShipPosition memory sp = ctx.g.shipPositions[i];
            if (sp.shipId == ctx.shipId || sp.status != 0 || sp.isCreator)
                continue; // own side only, not self
            // sp.status == 0 already checked above (G-01) — direct index read.
            Attributes memory attrs = ctx.g.shipAttributes[i];
            if (_manhattan(sp.position, ctx.pos) <= attrs.movement)
                return true;
        }
        return false;
    }

    // Any living enemy whose weapon range (with LOS) already reaches the
    // given tile from its current position — used to decide whether a tile
    // is actually safe to leave uncovered.
    function _enemyThreatensTile(
        Ctx memory ctx,
        Position memory tilePos
    ) private view returns (bool) {
        // Role-reversed from _bestEnemyWithin: `sp` (creator) is the
        // hypothetical shooter here, so what blocks ITS shot is the
        // opposing (joiner) side — the AI's own fleet, from this function's
        // caller's point of view. Computed once, reused for every creator
        // candidate below (tilePos and the blocking side don't change
        // per-candidate).
        uint256 joinerBitmap = _shipOccupiedBitmap(ctx, false);
        for (uint i = 0; i < ctx.g.shipPositions.length; i++) {
            ShipPosition memory sp = ctx.g.shipPositions[i];
            if (sp.status != 0 || !sp.isCreator) continue;
            // sp.status == 0 already checked above (G-01) — direct index read.
            Attributes memory attrs = ctx.g.shipAttributes[i];
            uint16 dist = _manhattan(sp.position, tilePos);
            if (dist > attrs.range) continue;
            if (
                dist > 1 &&
                !_hasLosExcludingTarget(ctx, sp.position, tilePos, joinerBitmap)
            ) continue;
            return true;
        }
        return false;
    }

    function _holdDecision(
        Ctx memory ctx
    ) private pure returns (Decision memory d) {
        d.destRow = ctx.pos.row;
        d.destCol = ctx.pos.col;
        d.action = ActionType.Pass;
    }

    // Shared fallback movement step used by every archetype whose primary
    // directive (shoot, heal, retreat) didn't produce a decision this turn:
    // close on the nearest enemy, but only follow through on that step if it
    // would actually bring an enemy into range this turn — otherwise
    // redirect the move toward a scoring tile instead, since walking toward
    // an enemy that stays out of reach anyway makes no more progress than
    // walking toward the objective. Falls back to the enemy-directed step if
    // no scoring tile exists on the map at all (or enemyFound is false and
    // there's no tile either, in which case this just holds position).
    function _approachOrSeekTile(
        Ctx memory ctx,
        Position memory enemyPos,
        bool enemyFound
    ) private view returns (Decision memory d) {
        d.destRow = ctx.pos.row;
        d.destCol = ctx.pos.col;
        d.action = ActionType.Pass;

        Position memory towardEnemy = ctx.pos;
        if (enemyFound) {
            towardEnemy = _stepTowardReachable(ctx, enemyPos, ctx.attrs.movement, 0);
            (uint target, bool found) = _bestEnemyInRange(
                ctx,
                towardEnemy,
                ctx.attrs.range
            );
            if (found) {
                d.destRow = towardEnemy.row;
                d.destCol = towardEnemy.col;
                d.action = ActionType.Shoot;
                d.actionTarget = target;
                return d;
            }
        }

        (Position memory tilePos, bool tileFound) = _bestScoringTile(ctx);
        // A tile another of its own ships already holds (or a wreck sits on)
        // can't be claimed, and heading there parks the ship beside it for as
        // long as the holder stays: close on the enemy instead. One held by a
        // live enemy is still worth contesting. Found live 2026-11-03: a
        // variant 1 Aggressor sat next to its ally's tile, the map's only one.
        if (tileFound && !_unclaimableTile(ctx, tilePos)) {
            Position memory towardTile = _stepTowardReachable(
                ctx,
                tilePos,
                ctx.attrs.movement,
                0
            );
            d.destRow = towardTile.row;
            d.destCol = towardTile.col;
            return d;
        }

        if (enemyFound) {
            d.destRow = towardEnemy.row;
            d.destCol = towardEnemy.col;
        }
    }

    // Greedy axis-priority step toward target, clamped to movement budget.
    // Covers as much of the larger-delta axis as the budget allows first,
    // then spends any remainder on the other axis — the resulting point is
    // always within movement of `from` (a legal moveShip destination) and
    // strictly closer to `to`. Does not check grid bounds or occupancy
    // (see this file's header comment) — `to` is always an existing,
    // in-bounds ship/tile position, and moving partway toward an in-bounds
    // point from an in-bounds point stays in bounds.
    function _stepToward(
        Position memory from,
        Position memory to,
        uint8 movement
    ) private pure returns (Position memory) {
        int16 rowDelta = to.row - from.row;
        int16 colDelta = to.col - from.col;
        // Grid coordinates are tiny (rows 0-10, cols 0-16), so these deltas
        // are always well within int16 range — negating them can't overflow.
        uint16 rowDist = rowDelta < 0 ? uint16(-rowDelta) : uint16(rowDelta);
        uint16 colDist = colDelta < 0 ? uint16(-colDelta) : uint16(colDelta);

        uint16 budget = movement;
        int16 rowStep;
        int16 colStep;
        if (rowDist >= colDist) {
            uint16 useRow = rowDist < budget ? rowDist : budget;
            rowStep = rowDelta < 0 ? -int16(useRow) : int16(useRow);
            budget -= useRow;
            uint16 useCol = colDist < budget ? colDist : budget;
            colStep = colDelta < 0 ? -int16(useCol) : int16(useCol);
        } else {
            uint16 useCol = colDist < budget ? colDist : budget;
            colStep = colDelta < 0 ? -int16(useCol) : int16(useCol);
            budget -= useCol;
            uint16 useRow = rowDist < budget ? rowDist : budget;
            rowStep = rowDelta < 0 ? -int16(useRow) : int16(useRow);
        }
        return Position({row: from.row + rowStep, col: from.col + colStep});
    }

    // Same idea, opposite direction, clamped to the grid (retreating can
    // run off the board, unlike stepping toward an existing in-bounds
    // target).
    function _stepAway(
        Position memory from,
        Position memory threat,
        uint8 movement,
        int16 gridHeight,
        int16 gridWidth
    ) private pure returns (Position memory) {
        // Mirror threat through `from` to get an "away" target point, then
        // reuse _stepToward's budget-allocation logic toward that point.
        int16 awayRow = from.row + (from.row - threat.row);
        int16 awayCol = from.col + (from.col - threat.col);
        if (awayRow < 0) awayRow = 0;
        if (awayRow >= gridHeight) awayRow = gridHeight - 1;
        if (awayCol < 0) awayCol = 0;
        if (awayCol >= gridWidth) awayCol = gridWidth - 1;
        return
            _stepToward(from, Position({row: awayRow, col: awayCol}), movement);
    }

    // ---- per-archetype rule lists ----

    // ---- toolbox for the per-variant trees (Variant1AI / Variant2AI) ----
    // Small, cheap primitives each faction's tree composes; what a faction
    // DOES with them (kite vs brawl, which special is a heal, whether it can
    // ram) is that faction's own knowledge and lives in its contract.

    function decision(
        Position memory dest,
        ActionType action,
        uint target
    ) internal pure returns (Decision memory d) {
        d.destRow = dest.row;
        d.destCol = dest.col;
        d.action = action;
        d.actionTarget = target;
    }

    function hold(Ctx memory ctx) internal pure returns (Decision memory) {
        return _holdDecision(ctx);
    }

    // The enemy to close on. While the enemy side is taking more points per
    // round from scoring tiles than this side, that's the nearest enemy
    // standing on one: knocking it off is how the AI stops losing on points
    // (2026-11-03). Otherwise the nearest enemy.
    function nearestEnemy(
        Ctx memory ctx
    ) internal pure returns (Position memory pos, bool found) {
        (uint enemyIncome, uint ownIncome) = _tileIncome(ctx);
        if (enemyIncome > ownIncome) {
            (pos, found) = _nearestEnemyOnTile(ctx);
            if (found) return (pos, true);
        }
        return _nearestEnemyPosition(ctx, false);
    }

    // Points per round each side's live ships stand on, as Game's round
    // scoring counts them (live ships only; a spent once-only tile isn't
    // listed).
    function _tileIncome(
        Ctx memory ctx
    ) private pure returns (uint enemy, uint own) {
        for (uint i = 0; i < ctx.scoringPositions.length; i++) {
            ScoringPosition memory t = ctx.scoringPositions[i];
            uint256 bit = _cellBit(Position({row: t.row, col: t.col}));
            if (ctx.creatorLive & bit != 0) enemy += t.points;
            else if (ctx.joinerLive & bit != 0) own += t.points;
        }
    }

    function _nearestEnemyOnTile(
        Ctx memory ctx
    ) private pure returns (Position memory pos, bool found) {
        uint16 bestDist = type(uint16).max;
        for (uint i = 0; i < ctx.scoringPositions.length; i++) {
            ScoringPosition memory t = ctx.scoringPositions[i];
            Position memory p = Position({row: t.row, col: t.col});
            if (ctx.creatorLive & _cellBit(p) == 0) continue;
            uint16 dist = _manhattan(ctx.pos, p);
            if (dist < bestDist) {
                pos = p;
                found = true;
                bestDist = dist;
            }
        }
    }

    function onScoringTile(Ctx memory ctx) internal pure returns (bool) {
        return _isScoringTile(ctx.scoringPositions, ctx.pos);
    }

    // Already on a scoring tile and leaving it isn't free (see
    // _shouldHoldScoringTile) — the caller should stay put.
    function shouldHoldTile(Ctx memory ctx) internal view returns (bool) {
        return _shouldHoldScoringTile(ctx);
    }

    // Nothing on the board to fight: hold a tile we're already on, else head
    // for an objective.
    function idleOrSeekTile(
        Ctx memory ctx
    ) internal view returns (Decision memory) {
        if (_shouldHoldScoringTile(ctx)) return _holdDecision(ctx);
        return _approachOrSeekTile(ctx, ctx.pos, false);
    }

    // At most this many tiles get shotWithinReach's external path and line
    // of sight checks, to bound its gas.
    uint constant SHOT_SEARCH_MAX = 16;

    // Line-of-sight seeking (2026-11-03): the nearest tile this ship can move
    // to this turn from which its gun has a target (see _bestEnemyWithin),
    // for when the tile its tree planned has none. Searches outward from
    // where the ship stands, nearest first, its own tile included. Before
    // this, a ship whose target sat behind blocked tiles took its usual step
    // and passed again every turn. Only tiles with an enemy within gun range
    // get the external checks, and at most SHOT_SEARCH_MAX of them.
    function shotWithinReach(
        Ctx memory ctx,
        bool safeOnly
    ) internal view returns (Position memory dest, uint target, bool found) {
        uint256 enemyBitmap = _shipOccupiedBitmap(ctx, true);
        uint checks;
        int16 m = int16(uint16(ctx.attrs.movement));
        for (int16 d = 0; d <= m; d++) {
            for (int16 dr = -d; dr <= d; dr++) {
                int16 rem = d - (dr < 0 ? -dr : dr);
                for (int16 side = 1; side >= -1; side -= 2) {
                    dest = Position({
                        row: ctx.pos.row + dr,
                        col: ctx.pos.col + side * rem
                    });
                    (target, found, checks) = _shotFrom(
                        ctx,
                        dest,
                        enemyBitmap,
                        checks,
                        safeOnly
                    );
                    if (found) return (dest, target, true);
                    if (checks >= SHOT_SEARCH_MAX) return (ctx.pos, 0, false);
                    if (rem == 0) break; // one tile on the axis, not two
                }
            }
        }
        return (ctx.pos, 0, false);
    }

    // One candidate for shotWithinReach: a gun target from `t`, if `t` is on
    // the board, has an enemy within gun range and (with `safeOnly`) is out
    // of every live enemy's range, both checked in memory first, and is
    // reachable this turn. `checks` counts the external checks spent.
    function _shotFrom(
        Ctx memory ctx,
        Position memory t,
        uint256 enemyBitmap,
        uint checks,
        bool safeOnly
    ) private view returns (uint target, bool found, uint) {
        if (!_onBoard(ctx, t)) return (0, false, checks);
        if (!_enemyWithin(ctx, t, ctx.attrs.range)) return (0, false, checks);
        if (safeOnly && _threatened(ctx, t)) return (0, false, checks);
        checks++;
        if (!_isReachable(ctx, t, enemyBitmap)) return (0, false, checks);
        (target, found) = _bestEnemyWithin(ctx, t, ctx.attrs.range, true);
        return (target, found, checks);
    }

    function _onBoard(
        Ctx memory ctx,
        Position memory t
    ) private pure returns (bool) {
        return
            t.row >= 0 &&
            t.col >= 0 &&
            t.row < ctx.gridHeight &&
            t.col < ctx.gridWidth;
    }

    // Any live enemy within its own gun range of `p`, by distance alone:
    // conservative (a wall may block the shot) and free of external calls.
    function _threatened(
        Ctx memory ctx,
        Position memory p
    ) private pure returns (bool) {
        for (uint i = 0; i < ctx.g.shipPositions.length; i++) {
            ShipPosition memory sp = ctx.g.shipPositions[i];
            if (sp.status != 0 || !sp.isCreator) continue;
            // sp.status == 0 already checked above (G-01) — direct index read.
            Attributes memory a = ctx.g.shipAttributes[i];
            if (a.hullPoints == 0) continue; // a disabled ship can't fire
            if (_manhattan(p, sp.position) <= a.range) return true;
        }
        return false;
    }

    // Self-preservation (2026-11-03), for a ship below a quarter of its max
    // HP that isn't holding a scoring tile (the points are worth the risk):
    // a reachable tile out of every live enemy's range that still has a
    // shot; else, if where it stands is in range of one, the nearest
    // reachable tile that isn't. ok == false: carry on with the tree.
    function lowHpEvade(
        Ctx memory ctx
    ) internal view returns (Decision memory d, bool ok) {
        if (
            ctx.attrs.hullPoints == 0 ||
            uint(ctx.attrs.hullPoints) * 4 >= ctx.attrs.maxHullPoints ||
            _isScoringTile(ctx.scoringPositions, ctx.pos)
        ) return (d, false);
        (Position memory p, uint target, bool found) = shotWithinReach(
            ctx,
            true
        );
        if (found) return (decision(p, ActionType.Shoot, target), true);
        if (!_threatened(ctx, ctx.pos)) return (d, false);
        (p, found) = _safeTileWithinReach(ctx);
        if (found) return (decision(p, ActionType.Pass, 0), true);
        return (d, false);
    }

    // The nearest tile this ship can move to this turn that no live enemy
    // has in range; at most SHOT_SEARCH_MAX external path checks.
    function _safeTileWithinReach(
        Ctx memory ctx
    ) private view returns (Position memory t, bool found) {
        uint256 enemyBitmap = _shipOccupiedBitmap(ctx, true);
        uint checks;
        int16 m = int16(uint16(ctx.attrs.movement));
        for (int16 d = 1; d <= m; d++) {
            for (int16 dr = -d; dr <= d; dr++) {
                int16 rem = d - (dr < 0 ? -dr : dr);
                for (int16 side = 1; side >= -1; side -= 2) {
                    t = Position({
                        row: ctx.pos.row + dr,
                        col: ctx.pos.col + side * rem
                    });
                    if (_onBoard(ctx, t) && !_threatened(ctx, t)) {
                        if (_isReachable(ctx, t, enemyBitmap)) return (t, true);
                        if (++checks >= SHOT_SEARCH_MAX) return (ctx.pos, false);
                    }
                    if (rem == 0) break;
                }
            }
        }
        return (ctx.pos, false);
    }

    // A ship on the board at 0 HP.
    function isDisabled(
        Ctx memory ctx,
        uint shipId
    ) internal pure returns (bool) {
        (Attributes memory a, bool found) = findAttributes(ctx.g, shipId);
        return found && a.hullPoints == 0;
    }

    // ---- Objective Runner and Hunter (2026-11-03) ----

    // The nearest live enemy standing on a scoring tile.
    function nearestTileHolder(
        Ctx memory ctx
    ) internal pure returns (Position memory, bool) {
        return _nearestEnemyOnTile(ctx);
    }

    // Stay put if `target` is within `range`, else step toward it just far
    // enough to bring it within `range` (never past movement).
    function withinRangeOf(
        Ctx memory ctx,
        Position memory target,
        uint8 range
    ) internal view returns (Position memory) {
        return _withinRangeOf(ctx, target, range);
    }

    // Whether this ship's gun can hit `target` from `from`: in range, with
    // line of sight past range 1.
    function canShoot(
        Ctx memory ctx,
        Position memory from,
        Position memory target
    ) internal view returns (bool) {
        return _canShootFrom(ctx, from, target, _shipOccupiedBitmap(ctx, true));
    }

    function _canShootFrom(
        Ctx memory ctx,
        Position memory from,
        Position memory target,
        uint256 enemyBitmap
    ) private view returns (bool) {
        uint16 dist = _manhattan(from, target);
        if (dist > ctx.attrs.range) return false;
        return
            dist <= 1 || _hasLosExcludingTarget(ctx, from, target, enemyBitmap);
    }

    // The Runner's gun target from `from`: a live enemy on a scoring tile
    // (lowest HP first), ahead of any other; else the usual best target.
    function holderFirstWithin(
        Ctx memory ctx,
        Position memory from
    ) internal view returns (uint id, bool found) {
        uint256 enemyBitmap = _shipOccupiedBitmap(ctx, true);
        uint8 bestHp;
        for (uint i = 0; i < ctx.g.shipPositions.length; i++) {
            ShipPosition memory sp = ctx.g.shipPositions[i];
            if (sp.status != 0 || !sp.isCreator) continue;
            // sp.status == 0 already checked above (G-01) — direct index read.
            uint8 hp = ctx.g.shipAttributes[i].hullPoints;
            if (hp == 0 || (found && hp >= bestHp)) continue;
            if (!_isScoringTile(ctx.scoringPositions, sp.position)) continue;
            if (!_canShootFrom(ctx, from, sp.position, enemyBitmap)) continue;
            id = sp.shipId;
            bestHp = hp;
            found = true;
        }
        if (found) return (id, true);
        return _bestEnemyWithin(ctx, from, ctx.attrs.range, true);
    }

    // The Hunter's quarry: the live enemy it can destroy soonest (turns to
    // come within gun range, plus shots to destroy it by Game's damage
    // formula). Ties go to one on a scoring tile, then the nearer.
    function huntTarget(
        Ctx memory ctx
    ) internal pure returns (uint id, Position memory pos, bool found) {
        Quarry memory best;
        for (uint i = 0; i < ctx.g.shipPositions.length; i++) {
            ShipPosition memory sp = ctx.g.shipPositions[i];
            if (sp.status != 0 || !sp.isCreator) continue;
            // sp.status == 0 already checked above (G-01) — direct index read.
            Quarry memory q = _quarry(ctx, ctx.g.shipAttributes[i], sp.position);
            if (!q.ok) continue;
            if (
                !found ||
                q.cost < best.cost ||
                (q.cost == best.cost &&
                    ((q.onTile && !best.onTile) ||
                        (q.onTile == best.onTile && q.dist < best.dist)))
            ) {
                best = q;
                id = sp.shipId;
                pos = sp.position;
                found = true;
            }
        }
    }

    // One candidate for huntTarget.
    struct Quarry {
        bool ok; // live, and this ship's gun can damage it
        uint cost; // turns to come within range plus shots to destroy it
        bool onTile;
        uint16 dist;
    }

    function _quarry(
        Ctx memory ctx,
        Attributes memory a,
        Position memory p
    ) private pure returns (Quarry memory q) {
        if (a.hullPoints == 0) return q;
        uint dmg = shotDamage(ctx.attrs.gunDamage, a.damageReduction);
        if (dmg == 0) return q;
        q.dist = _manhattan(ctx.pos, p);
        uint travel = q.dist > ctx.attrs.range
            ? _turnsToReach(q.dist - ctx.attrs.range, ctx.attrs.movement)
            : 0;
        if (travel == type(uint).max) return q; // can't move, can't reach it
        q.cost = travel + (uint(a.hullPoints) + dmg - 1) / dmg;
        q.onTile = _isScoringTile(ctx.scoringPositions, p);
        q.ok = true;
    }

    // Whether a repair of `allyId` can't wait (2026-11-03): it's disabled
    // (a repair revives it), or a live enemy that could reach it next turn
    // (within its range plus movement) would destroy it with one shot.
    function healIsUrgent(
        Ctx memory ctx,
        uint allyId
    ) internal pure returns (bool) {
        (Position memory at, bool found) = findPosition(ctx.g, allyId);
        if (!found) return false;
        (Attributes memory ally, ) = findAttributes(ctx.g, allyId);
        if (ally.hullPoints == 0) return true;
        for (uint i = 0; i < ctx.g.shipPositions.length; i++) {
            ShipPosition memory sp = ctx.g.shipPositions[i];
            if (sp.status != 0 || !sp.isCreator) continue;
            // sp.status == 0 already checked above (G-01) — direct index read.
            Attributes memory e = ctx.g.shipAttributes[i];
            if (e.hullPoints == 0) continue;
            if (_manhattan(sp.position, at) > uint16(e.range) + e.movement)
                continue;
            if (shotDamage(e.gunDamage, ally.damageReduction) >= ally.hullPoints)
                return true;
        }
        return false;
    }

    // Any live enemy within `range` of `p`, by distance alone. Live only:
    // shotWithinReach shouldn't move a ship just to shoot a wreck.
    function _enemyWithin(
        Ctx memory ctx,
        Position memory p,
        uint8 range
    ) private pure returns (bool) {
        for (uint i = 0; i < ctx.g.shipPositions.length; i++) {
            ShipPosition memory sp = ctx.g.shipPositions[i];
            if (sp.status != 0 || !sp.isCreator) continue;
            // sp.status == 0 already checked above (G-01) — direct index read.
            if (ctx.g.shipAttributes[i].hullPoints == 0) continue;
            if (_manhattan(p, sp.position) <= range) return true;
        }
        return false;
    }

    // Close in on an enemy only as far as it brings a shot into range,
    // otherwise head for an objective (see _approachOrSeekTile).
    function approachOrSeekTile(
        Ctx memory ctx,
        Position memory enemyPos
    ) internal view returns (Decision memory) {
        return _approachOrSeekTile(ctx, enemyPos, true);
    }

    function bestEnemyWithin(
        Ctx memory ctx,
        Position memory from,
        uint8 range,
        bool needsLineOfSight
    ) internal view returns (uint targetId, bool found) {
        return _bestEnemyWithin(ctx, from, range, needsLineOfSight);
    }

    // Public wrapper for _stepTowardReachable — see that function's own
    // comment. Unlike a plain greedy step, this guarantees the result is an
    // actually-legal moveShip destination (not blocked by an enemy ship or
    // occupied by anyone), backing off and detouring as needed.
    function stepTowardReachable(
        Ctx memory ctx,
        Position memory target,
        uint8 maxSteps,
        uint8 stopShortBy
    ) internal view returns (Position memory) {
        return _stepTowardReachable(ctx, target, maxSteps, stopShortBy);
    }

    function _min8(uint16 a, uint8 b) private pure returns (uint8) {
        return a < b ? uint8(a) : b;
    }

    // Close on `target` at up to `maxSteps`, but never onto (or past) its tile:
    // stop adjacent at the nearest, and back off one step at a time if the
    // landing square is already taken. Stays put if there is no free square.
    function advanceToward(
        Ctx memory ctx,
        Position memory target,
        uint8 maxSteps
    ) internal view returns (Position memory) {
        return _stepTowardReachable(ctx, target, maxSteps, 1);
    }

    // Where to stand to shoot the nearest enemy from as far away as this
    // ship's range allows: out of range -> step toward it, but only as far
    // as reaches maximum range (not all the way in); already inside range
    // -> back away (if allowed) toward maximum range. A blocked destination
    // means "stay put".
    function standoffPosition(
        Ctx memory ctx,
        Position memory enemyPos,
        bool allowRetreat
    ) internal view returns (Position memory stand) {
        uint16 d = _manhattan(ctx.pos, enemyPos);
        uint8 range = ctx.attrs.range;
        if (d > range) {
            return _stepTowardReachable(ctx, enemyPos, ctx.attrs.movement, range);
        }
        if (!allowRetreat) return ctx.pos;
        uint8 budget = _min8(range - d, ctx.attrs.movement);
        if (budget == 0) return ctx.pos;
        stand = _retreatStep(ctx, enemyPos, budget);
        if (!_isReachable(ctx, stand, _shipOccupiedBitmap(ctx, true)))
            return ctx.pos;
    }

    // Spend up to `budget` steps moving directly away from `threat` (every step
    // along either axis away from it adds one tile of distance), taking the
    // axis with the larger separation first and the other if that one runs
    // into the edge of the grid. Unlike _stepAway (which only mirrors the
    // threat through the ship, so it can retreat no farther than the current
    // distance), this uses the whole budget — that is what lets a ship back
    // all the way out to its maximum range.
    function _retreatStep(
        Ctx memory ctx,
        Position memory threat,
        uint8 budget
    ) private pure returns (Position memory p) {
        // A COPY: memory structs are references, and mutating ctx.pos itself
        // would corrupt every later read of this ship's own position.
        p = Position({row: ctx.pos.row, col: ctx.pos.col});
        int16 dRow = p.row - threat.row;
        int16 dCol = p.col - threat.col;
        bool rowFirst = (dRow < 0 ? -dRow : dRow) >= (dCol < 0 ? -dCol : dCol);
        for (uint pass = 0; pass < 2 && budget > 0; pass++) {
            bool useRow = (pass == 0) == rowFirst;
            int16 pos = useRow ? p.row : p.col;
            int16 delta = useRow ? dRow : dCol;
            int16 limit = useRow ? ctx.gridHeight : ctx.gridWidth;
            // Away from the threat along this axis; if level with it, toward
            // whichever side of the grid has more room.
            int16 dir = delta > 0 ? int16(1) : delta < 0
                ? int16(-1)
                : (pos < limit / 2 ? int16(1) : int16(-1));
            int16 room = dir > 0 ? limit - 1 - pos : pos;
            uint8 use = uint8(uint16(room)) < budget ? uint8(uint16(room)) : budget;
            if (use == 0) continue;
            if (useRow) p.row += dir * int16(uint16(use));
            else p.col += dir * int16(uint16(use));
            budget -= use;
        }
    }

    // Tally of the live ships within `range` of `center` (excluding this
    // one), for area specials: how many enemies, how many of them are
    // finishable (already at 0 HP or with their reactor timer at 2+), and
    // how many allies are in it / already near destruction themselves.
    struct Sweep {
        uint enemies;
        uint finishableEnemies;
        uint allies;
        uint alliesAtRisk;
    }

    function sweep(
        Ctx memory ctx,
        Position memory center,
        uint8 range
    ) internal pure returns (Sweep memory s) {
        for (uint i = 0; i < ctx.g.shipPositions.length; i++) {
            ShipPosition memory sp = ctx.g.shipPositions[i];
            if (sp.shipId == ctx.shipId || sp.status != 0) continue;
            if (_manhattan(center, sp.position) > range) continue;
            // sp.status == 0 already checked above (G-01) — direct index read.
            Attributes memory a = ctx.g.shipAttributes[i];
            if (sp.isCreator) {
                s.enemies++;
                if (a.hullPoints == 0 || a.reactorCriticalTimer >= 2) {
                    s.finishableEnemies++;
                }
            } else {
                s.allies++;
                if (a.reactorCriticalTimer >= 2) s.alliesAtRisk++;
            }
        }
    }

    // Nearest enemy already at 0 HP (a downed ship still on the board).
    function nearestDownedEnemy(
        Ctx memory ctx
    ) internal pure returns (uint id, Position memory pos, bool found) {
        uint16 bestDist = type(uint16).max;
        for (uint i = 0; i < ctx.g.shipPositions.length; i++) {
            ShipPosition memory sp = ctx.g.shipPositions[i];
            if (sp.status != 0 || !sp.isCreator) continue;
            // sp.status == 0 already checked above (G-01) — direct index read.
            if (ctx.g.shipAttributes[i].hullPoints != 0) continue;
            uint16 dist = _manhattan(ctx.pos, sp.position);
            if (!found || dist < bestDist) {
                id = sp.shipId;
                pos = sp.position;
                found = true;
                bestDist = dist;
            }
        }
    }

    // An enemy within `range` of `from` whose reactor timer is already at 2+:
    // one more tick destroys it, whatever its hull.
    function doomedEnemyWithin(
        Ctx memory ctx,
        Position memory from,
        uint8 range
    ) internal pure returns (uint id, bool found) {
        for (uint i = 0; i < ctx.g.shipPositions.length; i++) {
            ShipPosition memory sp = ctx.g.shipPositions[i];
            if (sp.status != 0 || !sp.isCreator) continue;
            if (_manhattan(from, sp.position) > range) continue;
            // sp.status == 0 already checked above (G-01) — direct index read.
            if (ctx.g.shipAttributes[i].reactorCriticalTimer >= 2) {
                return (sp.shipId, true);
            }
        }
    }

    // Heal the most injured ally this ship can reach THIS turn: if one is
    // already within `range` heal from here, else move just far enough to
    // bring the healer's range onto it and heal from there. HOW a faction
    // heals (an equipped special, a faction ability) and with what range is
    // that faction's own knowledge — it passes both in. healed == false
    // (and an unused Decision) if no injured ally is reachable.
    function healWithReach(
        Ctx memory ctx,
        uint8 range,
        ActionType healAction
    ) internal view returns (Decision memory d, bool healed) {
        (uint allyId, Position memory allyPos, bool found) = _reachableAlly(
            ctx,
            range
        );
        if (!found) return (d, false);
        Position memory dest;
        (dest, found) = reachWithin(ctx, allyPos, range);
        if (!found) return (d, false);
        return (decision(dest, healAction, allyId), true);
    }

    // A tile this ship can reach this turn from which `target` is within
    // `range` (staying put if it already is), or found = false. A move-
    // then-act decision must land in range: otherwise the resolver reverts
    // OutOfRange and the ship passes, every turn, so the caller falls
    // through instead (docs/audit-4.md HA7-06). Tries the direct approach
    // first, then every tile within `range` of the target.
    function reachWithin(
        Ctx memory ctx,
        Position memory target,
        uint8 range
    ) internal view returns (Position memory dest, bool found) {
        if (_manhattan(ctx.pos, target) <= range) return (ctx.pos, true);
        dest = _withinRangeOf(ctx, target, range);
        if (_manhattan(dest, target) <= range) return (dest, true);
        Stand memory s = _standTile(ctx, target, range);
        return (s.pos, s.found);
    }

    // The injured ally (0-HP preferred, then lowest HP) within `range` plus
    // this ship's movement — i.e. one it can heal this turn.
    function _reachableAlly(
        Ctx memory ctx,
        uint8 range
    ) private pure returns (uint id, Position memory pos, bool found) {
        uint16 reach = uint16(range) + ctx.attrs.movement;
        (id, found) = _bestAllyToHeal(
            ctx,
            reach > type(uint8).max ? type(uint8).max : uint8(reach)
        );
        if (!found) return (id, pos, false);
        (pos, found) = findPosition(ctx.g, id);
    }

    // Stay put if `target` is already within `range`, otherwise step toward
    // it just far enough to bring it within `range` (never past movement).
    function _withinRangeOf(
        Ctx memory ctx,
        Position memory target,
        uint8 range
    ) private view returns (Position memory) {
        return _stepTowardReachable(ctx, target, ctx.attrs.movement, range);
    }

    // The Support archetype's tree once its variant-specific healing step
    // (see healWithReach) found nothing to heal: shoots an enemy in range —
    // a free action from the current position, never skipped in favor of
    // moving. Otherwise seeks an unclaimed scoring tile first (the
    // objective matters more than positioning near an ally that isn't hurt
    // yet), falling back to closing toward whichever ally most needs
    // staying in healing range of if no scoring tile exists on the map.
    function decideSupportFallback(
        Ctx memory ctx
    ) internal view returns (Decision memory d) {
        d.destRow = ctx.pos.row;
        d.destCol = ctx.pos.col;
        d.action = ActionType.Pass;

        (uint target, bool found) = _bestEnemyInRange(
            ctx,
            ctx.pos,
            ctx.attrs.range
        );
        if (found) {
            d.action = ActionType.Shoot;
            d.actionTarget = target;
            return d;
        }

        if (_shouldHoldScoringTile(ctx)) return d; // already Pass-at-current-pos

        (Position memory dest, bool destFound) = _bestScoringTile(ctx);
        if (!destFound) {
            // No scoring tile on this map: fall back to staying useful near
            // whichever ally is most injured.
            (uint allyTarget, bool allyFound) = _bestAllyToHeal(
                ctx,
                type(uint8).max
            );
            if (!allyFound) return d;
            (dest, destFound) = findPosition(ctx.g, allyTarget);
            if (!destFound) return d;
        }

        Position memory newPos = _stepTowardReachable(
            ctx,
            dest,
            ctx.attrs.movement,
            0
        );
        d.destRow = newPos.row;
        d.destCol = newPos.col;
    }

    // Holds/seeks unclaimed scoring tiles (weapon-range-biased, see
    // _bestScoringTile); shoots opportunistically from wherever it ends up
    // if an enemy is in range from the current position (never gives up a
    // free shot just to move toward a tile).
    function decideTurtle(
        Ctx memory ctx
    ) internal view returns (Decision memory d) {
        d.destRow = ctx.pos.row;
        d.destCol = ctx.pos.col;
        d.action = ActionType.Pass;

        (uint target, bool found) = _bestEnemyInRange(
            ctx,
            ctx.pos,
            ctx.attrs.range
        );
        if (found) {
            d.action = ActionType.Shoot;
            d.actionTarget = target;
            return d;
        }

        if (_shouldHoldScoringTile(ctx)) return d; // already Pass-at-current-pos

        (Position memory tilePos, bool tileFound) = _bestScoringTile(ctx);
        if (!tileFound) return d;

        // The best available tile may already be held by another ship
        // (everything else on the map is claimed) — standing exactly on it
        // is an illegal move anyway, so once within 1 tile just hold there
        // rather than endlessly retrying the last step.
        if (
            _isOccupiedByOther(ctx, tilePos) &&
            _manhattan(ctx.pos, tilePos) <= 1
        ) {
            return d;
        }

        Position memory newPos = _stepTowardReachable(
            ctx,
            tilePos,
            ctx.attrs.movement,
            0
        );
        d.destRow = newPos.row;
        d.destCol = newPos.col;
    }

    // ---- objective-first toolbox (ram-on-objective, heal priorities) ----

    // A tile this ship can legally end its move on: reachable within its
    // movement, in bounds, and not occupied by another ship (the same three
    // rules Game.moveShip enforces — blocked tiles only affect line of sight,
    // not movement). `scoring` marks a scoring tile.
    struct Stand {
        Position pos;
        bool found;
        bool scoring;
        uint16 dist;
    }

    // The best tile within `range` of `target` that this ship can move to
    // THIS turn (staying put counts): a scoring tile beats a plain one, then
    // the shortest move. found == false if every such tile is out of reach,
    // off the grid, or occupied.
    function _standTile(
        Ctx memory ctx,
        Position memory target,
        uint8 range
    ) private view returns (Stand memory s) {
        // This already enumerates every candidate tile within `range` of
        // `target` (not just points along one line toward it), so unlike
        // the greedy _stepToward-based helpers, checking reachability here
        // naturally finds a genuinely different approach angle when the
        // straight line happens to be blocked — no separate detour logic
        // needed (2026-09-26).
        uint256 enemyBitmap = _shipOccupiedBitmap(ctx, true);
        int16 r = int16(uint16(range));
        for (int16 dr = -r; dr <= r; dr++) {
            int16 rem = r - (dr < 0 ? -dr : dr);
            for (int16 dc = -rem; dc <= rem; dc++) {
                _offerStand(
                    ctx,
                    s,
                    enemyBitmap,
                    Position({row: target.row + dr, col: target.col + dc})
                );
            }
        }
    }

    function _offerStand(
        Ctx memory ctx,
        Stand memory s,
        uint256 enemyBitmap,
        Position memory t
    ) private view {
        if (
            t.row < 0 ||
            t.col < 0 ||
            t.row >= ctx.gridHeight ||
            t.col >= ctx.gridWidth
        ) return;
        uint16 dist = _manhattan(ctx.pos, t);
        if (dist > ctx.attrs.movement) return;
        if (!_isReachable(ctx, t, enemyBitmap)) return;
        bool scoring = _isScoringTile(ctx.scoringPositions, t);
        if (
            !s.found ||
            (scoring && !s.scoring) ||
            (scoring == s.scoring && dist < s.dist)
        ) {
            s.pos = t;
            s.found = true;
            s.scoring = scoring;
            s.dist = dist;
        }
    }

    // Ram, for EVERY variant-1 ship: an enemy that is at 0 HP AND standing on
    // a scoring tile is worth evicting (the rammer takes the tile). Finds the
    // nearest such enemy this ship can ram this turn — moving to a free tile
    // within `ramRange` of it if needed. The caller decides whether its own
    // reactor timer can afford the tick a ram costs.
    function ramOnScoringTile(
        Ctx memory ctx,
        uint8 ramRange
    ) internal view returns (Decision memory d, bool found) {
        uint16 bestDist = type(uint16).max;
        for (uint i = 0; i < ctx.g.shipPositions.length; i++) {
            ShipPosition memory sp = ctx.g.shipPositions[i];
            if (sp.status != 0 || !sp.isCreator) continue;
            // sp.status == 0 already checked above (G-01) — direct index read.
            if (ctx.g.shipAttributes[i].hullPoints != 0) continue;
            if (!_isScoringTile(ctx.scoringPositions, sp.position)) continue;
            uint16 dist = _manhattan(ctx.pos, sp.position);
            if (found && dist >= bestDist) continue;
            Stand memory s = _standTile(ctx, sp.position, ramRange);
            if (!s.found) continue;
            d = decision(s.pos, ActionType.FactionAbility, sp.shipId);
            bestDist = dist;
            found = true;
        }
    }

    // Which ships a heal may pick and whether the healer may move to reach
    // them (see _planHeal).
    struct HealFilter {
        bool scoringOnly; // target must stand on a scoring tile
        bool disabledOnly; // target must be at 0 HP
        bool includeSelf; // the healer itself is a candidate
        bool canMove; // may step to a free tile within range of the target
    }

    // The injured friendly ship to heal, by priority: disabled (0 HP) first,
    // then lowest HP. With `canMove` the healer may travel to a free tile
    // within `range` of the target (stand = that tile); otherwise the target
    // must already be within `range` of `from`.
    function _planHeal(
        Ctx memory ctx,
        Position memory from,
        uint8 range,
        HealFilter memory f
    ) private view returns (uint id, Position memory stand, bool found) {
        uint8 bestHp;
        bool bestDisabled;
        for (uint i = 0; i < ctx.g.shipPositions.length; i++) {
            (bool ok, Position memory at) = _healCandidate(
                ctx,
                i,
                from,
                range,
                f
            );
            if (!ok) continue;
            // sp.status == 0 was checked in _healCandidate (G-01).
            uint8 hp = ctx.g.shipAttributes[i].hullPoints;
            bool disabled = hp == 0;
            if (
                found &&
                !((disabled && !bestDisabled) ||
                    (disabled == bestDisabled && hp < bestHp))
            ) continue;
            id = ctx.g.shipPositions[i].shipId;
            stand = at;
            found = true;
            bestHp = hp;
            bestDisabled = disabled;
        }
    }

    // Whether ship index `i` is a legal heal target under filter `f`, and
    // where the healer would stand to heal it.
    function _healCandidate(
        Ctx memory ctx,
        uint i,
        Position memory from,
        uint8 range,
        HealFilter memory f
    ) private view returns (bool ok, Position memory at) {
        ShipPosition memory sp = ctx.g.shipPositions[i];
        if (sp.status != 0 || sp.isCreator) return (false, at); // own side only
        bool isSelf = sp.shipId == ctx.shipId;
        if (isSelf && !f.includeSelf) return (false, at);
        // sp.status == 0 already checked above (G-01) — direct index read.
        Attributes memory a = ctx.g.shipAttributes[i];
        if (a.hullPoints >= a.maxHullPoints) return (false, at); // not injured
        if (f.disabledOnly && a.hullPoints != 0) return (false, at);
        if (f.scoringOnly && !_isScoringTile(ctx.scoringPositions, sp.position))
            return (false, at);
        if (f.canMove) {
            Stand memory s = _standTile(ctx, sp.position, range);
            return (s.found, s.pos);
        }
        // A ship is always within range of itself, wherever it ends up.
        if (!isSelf && _manhattan(from, sp.position) > range) return (false, at);
        return (true, from);
    }

    function _healDecision(
        Ctx memory ctx,
        Position memory from,
        uint8 range,
        ActionType healAction,
        HealFilter memory f
    ) private view returns (Decision memory d, bool healed) {
        (uint id, Position memory stand, bool found) = _planHeal(
            ctx,
            from,
            range,
            f
        );
        if (!found) return (d, false);
        return (decision(stand, healAction, id), true);
    }

    // Faction-2 heal priority 1: an injured OR disabled friendly ship (not
    // this one) standing on a scoring tile — moving within `range` of it if
    // needed (onto a scoring tile of its own when it can).
    function healOnScoringTile(
        Ctx memory ctx,
        uint8 range,
        ActionType healAction
    ) internal view returns (Decision memory, bool) {
        return
            _healDecision(
                ctx,
                ctx.pos,
                range,
                healAction,
                HealFilter(true, false, false, true)
            );
    }

    // Faction-2 heal priority 3, standing where it is (the objective step
    // has already fixed where the ship ends up): a disabled friendly ship
    // within `range` of `from`.
    function healDisabledFrom(
        Ctx memory ctx,
        Position memory from,
        uint8 range,
        ActionType healAction
    ) internal view returns (Decision memory, bool) {
        return
            _healDecision(
                ctx,
                from,
                range,
                healAction,
                HealFilter(false, true, false, false)
            );
    }

    // Faction-2 heal priority 3 when the ship has no objective to claim: a
    // disabled friendly ship it can reach this turn, moving to do so.
    function healDisabledWithReach(
        Ctx memory ctx,
        uint8 range,
        ActionType healAction
    ) internal view returns (Decision memory, bool) {
        return
            _healDecision(
                ctx,
                ctx.pos,
                range,
                healAction,
                HealFilter(false, true, false, true)
            );
    }

    // Faction-2 heal, last resort: this ship itself or any injured friendly
    // ship within `range` of where the ship is about to stand (`from`).
    function healAnyFrom(
        Ctx memory ctx,
        Position memory from,
        uint8 range,
        ActionType healAction
    ) internal view returns (Decision memory, bool) {
        return
            _healDecision(
                ctx,
                from,
                range,
                healAction,
                HealFilter(false, false, true, false)
            );
    }

    // Step toward `target` with the full movement budget, landing on the
    // nearest free square along the way (the target tile itself included).
    function _moveToward(
        Ctx memory ctx,
        Position memory target
    ) private view returns (Position memory) {
        return _stepTowardReachable(ctx, target, ctx.attrs.movement, 0);
    }

    // The objective step: standing on a scoring tile already -> stay
    // (objective == true, stand == here); else if an UNCLAIMED scoring tile
    // exists -> head for it at full speed (objective == true, stand == where
    // that lands); else there is nothing to claim (objective == false).
    function claimScoringTile(
        Ctx memory ctx
    ) internal view returns (Position memory stand, bool objective) {
        if (_isScoringTile(ctx.scoringPositions, ctx.pos)) {
            return (ctx.pos, true);
        }
        (Position memory tile, bool found) = _bestScoringTile(ctx);
        if (!found || _isOccupiedByOther(ctx, tile)) return (ctx.pos, false);
        return (_moveToward(ctx, tile), true);
    }
}

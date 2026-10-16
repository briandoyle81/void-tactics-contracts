// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import "./Types.sol";
import "./IEffectResolver.sol";
import "./IShipAttributes.sol";
import "./IShips.sol";

// Split out of Game.sol — already the tightest-margin contract in the repo —
// and deployed as a standalone library (an external function taking
// `GameData storage` compiles to a DELEGATECALL stub at Game.sol's call
// sites instead of being inlined), per CLAUDE.md: reduce bytecode via
// libraries rather than touching the contract-size check.
//
// Effect dispatch (resolveAndApply) is the one thing that lives here: the
// resolver call (IEffectResolver — shared by faction abilities and equipped
// Specials alike, see Game.sol's factionAbilityResolvers/specialResolvers
// mappings), the SpecialEffect[] ABI decode, and all hull/reactor/relocate
// arithmetic directly against game storage. The one thing it deliberately
// does NOT do is remove a ship from the game itself — that needs Game.sol's
// `ships`/`fleets` references and its existing, heavily-invariant
// `_removeShipFromGame` (fleet cleanup, game-end checks, orchestrator
// callback). Instead this returns a normalized list of ships to remove
// (and how), which Game.sol applies via that existing function.
library SpecialEffectsLib {
    int16 constant NO_RELOCATE = type(int16).min;

    error ShipNotFound();
    error ShipDestroyed();
    error RelocationDestinationOccupied();

    // Bundled to keep resolveAndApply's own parameter/local count low
    // (Solidity's legacy codegen runs out of stack slots quickly across a
    // multi-parameter external function with a loop and several locals).
    struct ResolveContext {
        uint gameId;
        uint shipId;
        uint16 variant;
        uint targetShipId;
        int16 newRow;
        int16 newCol;
    }

    // Bundled for the same stack-pressure reason as ResolveContext.
    // Relocations are deferred (not applied here) rather than applied
    // inline: a relocate that lands on a cell a removal is about to vacate
    // must run strictly after that removal, since Game.sol's
    // _removeShipFromGame clears a ship's grid cell using that ship's own
    // stored position — if a relocate already overwrote that cell first,
    // the removal would wipe the relocated ship's new occupancy right back
    // out. Game.sol applies removals (via its own _removeShipFromGame) and
    // then calls applyRelocations, in that order.
    struct EffectResults {
        uint[] removeShipIds;
        uint8[] removeKinds;
        uint[] relocateShipIds;
        // row * 1000 + col (both always non-negative, well within the grid) —
        // packed into one array instead of two to keep this return struct's
        // ABI decode/encode footprint down.
        int32[] relocatePositions;
    }

    // UA-06 fix (2026-09-29): healCapPercent used to be passed in as a
    // separate parameter (Game.sol's live, unpinned value) — now read
    // directly off `game.healCapPercentAtStart`, snapshotted once at
    // startGame, so a later live change to Game.healCapPercent can't
    // retroactively affect an already-active game's heal cap. Dropping the
    // parameter also relieves _dispatchEffects' own stack pressure at the
    // call site (see Game.sol's comment there).
    function resolveAndApply(
        GameData storage game,
        address resolver,
        IShips ships,
        ResolveContext memory ctx
    ) external returns (EffectResults memory results) {
        // Defense in depth: guarantee a non-zero target actually exists and
        // isn't already destroyed before any resolver ever sees it, the same
        // as the native RepairDrones/EMP path already does — rather than
        // relying on every resolver to reimplement this check itself. 0
        // means "no target" (e.g. a self-centered ability), same convention
        // FlakArray already uses.
        if (ctx.targetShipId != 0) {
            Ship memory targetShip = ships.getShip(ctx.targetShipId);
            if (targetShip.id == 0) revert ShipNotFound();
            if (targetShip.shipData.timestampDestroyed != 0) revert ShipDestroyed();
        }

        SpecialEffect[] memory effects = IEffectResolver(resolver).resolveEffect(
            ctx.gameId,
            ctx.shipId,
            ctx.variant,
            ctx.targetShipId,
            ctx.newRow,
            ctx.newCol
        );

        // Allocate for the worst case (every effect turns out to need
        // removal, or every effect turns out to relocate), fill in a single
        // pass, then shrink the length words in place — same pattern
        // Game.getAllShipPositions already uses.
        results.removeShipIds = new uint[](effects.length);
        results.removeKinds = new uint8[](effects.length);
        results.relocateShipIds = new uint[](effects.length);
        results.relocatePositions = new int32[](effects.length);
        uint removeIdx;
        uint relocateIdx;

        for (uint i = 0; i < effects.length; i++) {
            SpecialEffect memory effect = effects[i];
            (bool removed, uint8 kind) = _applyEffect(
                game,
                ctx.shipId,
                effect,
                game.healCapPercentAtStart
            );
            if (removed) {
                results.removeShipIds[removeIdx] = effect.shipId;
                results.removeKinds[removeIdx] = kind;
                removeIdx++;
            } else if (effect.newRow != NO_RELOCATE) {
                results.relocateShipIds[relocateIdx] = effect.shipId;
                results.relocatePositions[relocateIdx] =
                    int32(effect.newRow) *
                    1000 +
                    int32(effect.newCol);
                relocateIdx++;
            }
        }

        uint[] memory removeShipIds = results.removeShipIds;
        uint8[] memory removeKinds = results.removeKinds;
        uint[] memory relocateShipIds = results.relocateShipIds;
        int32[] memory relocatePositions = results.relocatePositions;
        assembly {
            mstore(removeShipIds, removeIdx)
            mstore(removeKinds, removeIdx)
            mstore(relocateShipIds, relocateIdx)
            mstore(relocatePositions, relocateIdx)
        }
    }

    // Applies one effect's hull/reactor delta directly to game storage
    // (relocation is deferred — see EffectResults). Returns (true, kind) if
    // the ship needs removing via Game.sol's _removeShipFromGame (kind: 1 =
    // retreat, 2 = destroy) — Game.sol acts on this without re-deriving it.
    function _applyEffect(
        GameData storage game,
        uint _actingShipId,
        SpecialEffect memory _effect,
        uint8 _healCapPercent
    ) private returns (bool removed, uint8 kind) {
        if (_effect.removalKind != 0) {
            return (true, _effect.removalKind);
        }

        Attributes storage attrs = game.shipAttributes[_effect.shipId];

        if (_effect.reactorTimerDelta != 0) {
            // Matches the old native EMP's unconditional lastDamage write on
            // every hit (not just the one that tips the timer critical) —
            // only the value in place when the ship actually gets removed
            // (read at Game.sol's _removeShipFromGame) ever matters, but
            // writing it here on every delta is the minimal-diff match for
            // prior behavior and self-attributes a rammer that destroys
            // itself on its own 3rd ram.
            game.lastDamage[_effect.shipId] = _actingShipId;
            int16 newTimer = int16(uint16(attrs.reactorCriticalTimer)) +
                int16(_effect.reactorTimerDelta);
            if (newTimer < 0) newTimer = 0;
            // A reactor delta that just went critical destroys the ship —
            // it never gets to apply a hull delta or relocate from this same
            // effect (mirrors the old ramming code's "a rammer destroyed by
            // its own 3rd ram never occupies the tile" behavior).
            if (newTimer >= 3) return (true, 2);
            attrs.reactorCriticalTimer = uint8(uint16(newTimer));
        }

        if (_effect.hullDelta != 0) {
            _applyHullDelta(
                game,
                attrs,
                _effect.shipId,
                _effect.hullDelta,
                _actingShipId,
                _healCapPercent
            );
        }

        return (false, 0);
    }

    // Heal (positive delta) is capped at _healCapPercent% of maxHullPoints —
    // a ceiling on how high a heal can raise HP, never a floor: a ship
    // already above that ceiling (e.g. from taking less than
    // (100 - _healCapPercent)% damage) is left alone, not healed down to
    // it. Damage (negative delta) is unaffected by this cap and can still
    // bring a ship to 0 regardless. Same percent-of-max arithmetic pattern
    // as RoguelikeMatch.sol's campaignAutoHealPercent floor.
    function _applyHullDelta(
        GameData storage game,
        Attributes storage attrs,
        uint _shipId,
        int16 _hullDelta,
        uint _actingShipId,
        uint8 _healCapPercent
    ) private {
        if (_hullDelta < 0) {
            uint16 damage = uint16(uint32(-int32(_hullDelta)));
            if (damage >= attrs.hullPoints) {
                attrs.hullPoints = 0;
                // HA6-24: remember it had already moved this round (see
                // GameData.zeroedAfterMovingInRound).
                if (EnumerableSet.remove(game.shipMovedThisRound, _shipId)) {
                    game.zeroedAfterMovingInRound[_shipId] = game
                        .turnState
                        .currentRound;
                }
                EnumerableSet.add(game.shipsWithZeroHP, _shipId);
                game.lastDamage[_shipId] = _actingShipId;
            } else {
                attrs.hullPoints -= uint8(damage);
            }
        } else {
            uint8 currentHullPoints = attrs.hullPoints;
            uint16 newHullPoints = uint16(currentHullPoints) +
                uint16(uint16(_hullDelta));
            uint16 healCap = (uint16(attrs.maxHullPoints) * _healCapPercent) /
                100;
            uint16 cappedHullPoints = newHullPoints > healCap
                ? healCap
                : newHullPoints;
            // A ship already above healCap (e.g. _healCapPercent was lowered
            // mid-game while it sat above the new ceiling) must not be
            // healed down to it — clamp only ever raises HP.
            attrs.hullPoints = cappedHullPoints > currentHullPoints
                ? uint8(cappedHullPoints)
                : currentHullPoints;
            // Only a ship actually brought back above 0 HP leaves the
            // zero-HP set — a heal capped at 0 (healCapPercent 0) used to
            // remove it anyway, so it was never reactor-ticked or destroyed
            // and stalled the round (docs/audit-3.md HA6-25).
            if (currentHullPoints == 0 && attrs.hullPoints > 0) {
                EnumerableSet.remove(game.shipsWithZeroHP, _shipId);
                // HA6-24: going to 0 HP cleared its moved flag. If it had
                // already acted this round, it counts as moved again so it
                // can't act twice; a ship downed before moving keeps its move.
                if (
                    game.zeroedAfterMovingInRound[_shipId] ==
                    game.turnState.currentRound
                ) {
                    EnumerableSet.add(game.shipMovedThisRound, _shipId);
                }
            }
        }
    }

    // Applies deferred relocations — call after Game.sol has applied every
    // removal from the same resolveAndApply's EffectResults, so a relocate
    // never gets clobbered by a same-batch removal clearing its destination.
    function applyRelocations(
        GameData storage game,
        uint[] memory _shipIds,
        int32[] memory _positions
    ) external {
        for (uint i = 0; i < _shipIds.length; i++) {
            int16 newRow = int16(_positions[i] / 1000);
            int16 newCol = int16(_positions[i] % 1000);
            Position storage p = game.shipPositions[_shipIds[i]].position;
            game.grid[p.row][p.col] = 0;
            // HA3-05: every other grid-write path in this codebase (moveShip,
            // _placeShipOnGrid) rejects an occupied destination — this one
            // didn't. Checked after clearing the source cell above (so a
            // relocation landing back on its own current cell, or onto a
            // cell a same-batch removal just cleared, is still valid) but
            // before writing, so a genuine collision reverts instead of
            // silently desyncing grid from shipPositions with no way to
            // detect or repair it later.
            if (game.grid[newRow][newCol] != 0) {
                revert RelocationDestinationOccupied();
            }
            game.grid[newRow][newCol] = _shipIds[i];
            p.row = newRow;
            p.col = newCol;
        }
    }
}

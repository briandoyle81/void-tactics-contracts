// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "./Types.sol";
import "./IEffectResolver.sol";
import "./IGameView.sol";

// Repair: the faction 2 innate ability. Every variant-2 ship has it
// regardless of loadout (dispatched via ActionType.FactionAbility, not tied
// to equipment.special) -- mirrors RamResolver's shape exactly (faction 1's
// own innate ability), just healing a friendly ship in range instead of
// evicting a downed enemy. Range/strength are this contract's own
// owner-settable state rather than the shared per-variant SpecialData table
// (IShipAttributes) that equipped Specials like RepairDronesResolver read
// from -- a faction ability was never equipped, so, like Ram, it has no
// reason to share that config table.
//
// Engine-agnostic by construction (2026-09-28) — see EMPResolver's header
// comment: reads live ship state via IGameView(msg.sender) instead of a
// stored `game` address, so the same deployed instance works for every
// future engine with no reconfiguration.
contract RepairResolver is IEffectResolver {
    int16 constant NO_RELOCATE = type(int16).min;

    address public owner;

    uint8 public range = 1;
    uint8 public strength = 50;

    error NotOwner();
    error TargetNotFound();
    error TargetNotFriendly();
    error OutOfRange();

    constructor() {
        owner = msg.sender;
    }

    function setRange(uint8 _range) external {
        if (msg.sender != owner) revert NotOwner();
        range = _range;
    }

    function setStrength(uint8 _strength) external {
        if (msg.sender != owner) revert NotOwner();
        strength = _strength;
    }

    function resolveEffect(
        uint gameId,
        uint shipId,
        uint16 /* variant */,
        uint targetShipId,
        int16 actingRow,
        int16 actingCol
    ) external view returns (SpecialEffect[] memory effects) {
        IGameView game = IGameView(msg.sender);
        ShipPosition memory acting = game.getShipPosition(gameId, shipId);
        ShipPosition memory target = game.getShipPosition(gameId, targetShipId);
        if (acting.shipId == 0 || target.shipId == 0) revert TargetNotFound();
        // Reject an already-fled/destroyed target — shipPositions entries
        // aren't deleted on removal (only status flips), so shipId == 0
        // alone doesn't catch this (see docs/pre-audit.md SP-02, and
        // docs/audit-2.md HA2-08 for why this resolver specifically needed
        // the same check RamResolver/EMPResolver/DroneSwarmResolver already
        // have).
        if (target.status != 0) revert TargetNotFound();
        // Repair can only target friendly ships.
        if (acting.isCreator != target.isCreator) revert TargetNotFriendly();

        if (
            _manhattanDistance(
                actingRow,
                actingCol,
                target.position.row,
                target.position.col
            ) > range
        ) revert OutOfRange();

        effects = new SpecialEffect[](1);
        effects[0] = SpecialEffect({
            shipId: targetShipId,
            hullDelta: int16(uint16(strength)),
            reactorTimerDelta: 0,
            newRow: NO_RELOCATE,
            newCol: 0,
            removalKind: 0
        });
    }

    function _manhattanDistance(
        int16 r1,
        int16 c1,
        int16 r2,
        int16 c2
    ) private pure returns (uint8) {
        uint8 rowDiff = r1 > r2 ? uint8(uint16(r1 - r2)) : uint8(uint16(r2 - r1));
        uint8 colDiff = c1 > c2 ? uint8(uint16(c1 - c2)) : uint8(uint16(c2 - c1));
        return rowDiff + colDiff;
    }
}

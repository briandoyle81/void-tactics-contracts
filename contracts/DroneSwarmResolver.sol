// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "./Types.sol";
import "./IEffectResolver.sol";
import "./IGameView.sol";
import "./IShipAttributes.sol";

// Drone Swarm: an equipped Special dispatched via
// Game.specialResolvers[variant][slot], where `slot` is whichever faction
// slot this instance is registered at (set once at deploy time — see
// `slot` below). Single-target hull damage against an enemy ship within
// range, reduced by the target's armor/shields (same formula as
// FlakArrayResolver). Range/strength stay in the shared per-variant
// SpecialData table (IShipAttributes) rather than being owned by this
// contract, so factions can retune numbers via
// ShipAttributes.setVariantAttributes without redeploying this resolver.
//
// Engine-agnostic by construction (2026-09-28) — see EMPResolver's header
// comment: reads live ship state via IGameView(msg.sender) instead of a
// stored `game` address, so the same deployed instance works for every
// future engine with no reconfiguration.
contract DroneSwarmResolver is IEffectResolver {
    int16 constant NO_RELOCATE = type(int16).min;

    IShipAttributes public shipAttributes;
    address public owner;
    // Which faction slot (0-7) this instance is registered at — Special is
    // a per-faction local index, not a global identity, so this resolver
    // must be told its own slot rather than assuming one. The same
    // resolver contract can be redeployed with a different _slot if
    // another faction wants this exact behavior at a different slot.
    Special public immutable slot;

    error NotOwner();
    error TargetNotFound();
    error TargetNotEnemy();
    error OutOfRange();

    constructor(address _shipAttributes, Special _slot) {
        shipAttributes = IShipAttributes(_shipAttributes);
        owner = msg.sender;
        slot = _slot;
    }

    function setShipAttributesAddress(address _shipAttributes) external {
        if (msg.sender != owner) revert NotOwner();
        shipAttributes = IShipAttributes(_shipAttributes);
    }

    function resolveEffect(
        uint gameId,
        uint shipId,
        uint16 variant,
        uint targetShipId,
        int16 actingRow,
        int16 actingCol
    ) external view returns (SpecialEffect[] memory effects) {
        IGameView game = IGameView(msg.sender);
        ShipPosition memory acting = game.getShipPosition(gameId, shipId);
        ShipPosition memory target = game.getShipPosition(gameId, targetShipId);
        if (acting.shipId == 0 || target.shipId == 0) revert TargetNotFound();
        // Reject an already-destroyed/fled target — shipPositions entries
        // aren't deleted on removal (only status flips), so shipId == 0
        // alone doesn't catch this. Without this check, a stale target's
        // deleted (zeroed) Attributes would read as 0 HP and get re-added
        // to shipsWithZeroHP, permanently bricking future round transitions
        // (see docs/pre-audit.md SP-02).
        if (target.status != 0) revert TargetNotFound();
        // Drone Swarm can only target enemy ships.
        if (acting.isCreator == target.isCreator) revert TargetNotEnemy();

        uint16 attrVersion = _pinnedVersion(gameId, shipId);
        uint8 range = shipAttributes.getSpecialRangeAt(
            variant,
            attrVersion,
            slot
        );
        if (
            _manhattanDistance(
                actingRow,
                actingCol,
                target.position.row,
                target.position.col
            ) > range
        ) revert OutOfRange();

        uint8 strength = shipAttributes.getSpecialStrengthAt(
            variant,
            attrVersion,
            slot
        );
        uint8 damageReduction = game
            .getShipAttributes(gameId, targetShipId)
            .damageReduction;
        uint8 damage = uint8(
            strength - ((uint16(strength) * damageReduction) / 100)
        );

        effects = new SpecialEffect[](1);
        effects[0] = SpecialEffect({
            shipId: targetShipId,
            hullDelta: -int16(uint16(damage)),
            reactorTimerDelta: 0,
            newRow: NO_RELOCATE,
            newCol: 0,
            removalKind: 0
        });
    }

    // The acting ship's attributes version, pinned when the game snapshotted
    // its attributes at start (Game.calculateShipAttributes). Special numbers
    // are read at THIS version so publishing or rolling back a version can't
    // change them under an in-flight game (see ShipAttributes.getSpecialRangeAt).
    function _pinnedVersion(
        uint gameId,
        uint shipId
    ) private view returns (uint16) {
        return IGameView(msg.sender).getShipAttributes(gameId, shipId).version;
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

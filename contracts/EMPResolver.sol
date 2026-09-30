// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "./Types.sol";
import "./IEffectResolver.sol";
import "./IGameView.sol";
import "./IShipAttributes.sol";

// EMP: an equipped Special dispatched via
// Game.specialResolvers[variant][slot], where `slot` is whichever faction
// slot this instance is registered at (set once at deploy time — see
// `slot` below). Adds to an enemy ship's reactor critical timer within
// range; the shared SpecialEffectsLib._applyEffect path destroys the ship
// once that timer reaches 3, same as every other reactor-timer-driven
// removal. Range/strength stay in the shared per-variant SpecialData table
// (IShipAttributes) rather than being owned by this contract, so factions
// can retune numbers via ShipAttributes.setVariantAttributes without
// redeploying this resolver.
//
// Engine-agnostic by construction (2026-09-28): reads live ship state via
// IGameView(msg.sender) instead of a stored/owner-settable `game` address.
// resolveEffect is only ever reached via a call chain that starts at some
// Game contract's own moveShip (Game -[delegatecall]-> SpecialEffectsLib
// -[call]-> this resolver), so msg.sender here IS that calling Game,
// whichever "engine" it is — this resolver never needs to be told or
// updated to know which Game to trust, and the same deployed instance is
// reused by every future engine automatically. A contract that isn't a
// real Game calling in only ever gets to manipulate its own storage this
// way, exactly as it already could without going through this resolver at
// all — no new attack surface.
contract EMPResolver is IEffectResolver {
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
        // alone doesn't catch this (see docs/pre-audit.md SP-02).
        if (target.status != 0) revert TargetNotFound();
        // EMP can only target enemy ships.
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
        // HA3-06: int8(uint8) silently wraps negative for strength >= 128
        // (e.g. 150 -> -106), inverting "add to reactor timer" into
        // "subtract from it." Clamp to int8's max instead of letting a
        // misconfigured value flip sign.
        int8 reactorTimerDelta = strength > 127 ? int8(127) : int8(strength);

        effects = new SpecialEffect[](1);
        effects[0] = SpecialEffect({
            shipId: targetShipId,
            hullDelta: 0,
            reactorTimerDelta: reactorTimerDelta,
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

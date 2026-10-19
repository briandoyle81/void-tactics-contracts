// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/access/Ownable.sol";
import "./IWinEffect.sol";
import "./IShips.sol";
import "./Types.sol";

// Pluggable win effect (see IWinEffect.sol): mints a fully specified,
// already-constructed ship to the winner, configured per roguelike node.
// contextId is the node id RoguelikeMatch passes to onWin, so one deployment
// serves every node, each with its own ship (or none).
//
// Reworked 2026-10-19. Before, it minted a random, unconstructed free ship
// of one variant for every node, its tier setting was ignored (createShips
// skips rank for free ships), and variant 2 failed for anyone without the
// Shattered Hive medal. Now it mints through Ships.createSpecificShip (the
// lottery prize path), so every listed property is the admin's choice, and
// any player can receive any variant: deploy wiring exempts this contract
// from VariantPurchaseGate.
//
// Needs Ships.setIsAllowedToCreateShips(this, true) and
// VariantPurchaseGate.setExemptMinter(this, true) — deploy-time wiring.
//
// onWin is gated behind its own isAllowedToTrigger allowlist — see
// DECBonusWinEffect.sol's matching comment on why (assume hostile outside
// actors: without this gate, any address could call onWin directly and
// mint itself ships with no match ever played).
contract ShipGrantWinEffect is Ownable, IWinEffect {
    // The configurable parts of the granted ship. Everything else on the
    // minted Ship (id, serial number, cost, constructed, ...) is set by
    // Ships itself. Rank comes from shipsDestroyed (Ships._getKillsForRank:
    // 1 / 10 / 30 / 100 / 300 / 1000 kills = rank 1-6).
    struct ShipGrant {
        string name;
        Equipment equipment;
        Colors colors;
        uint16 variant;
        uint8 accuracy; // 0-2
        uint8 hull; // 0-2
        uint8 speed; // 0-2
        uint32 shipsDestroyed;
        bool shiny;
        bool isFreeShip; // free ships can't be recycled and pay no kill UTC
        // true: each address gets this node's ship at most once, across all
        // runs. false: every win at the node grants another one.
        bool oncePerAddress;
    }

    IShips public ships;

    mapping(uint => ShipGrant) private grants; // nodeId => grant
    mapping(uint => bool) public hasGrant; // nodeId => configured
    // nodeId => player => already received this node's ship. Kept when a
    // grant is replaced or cleared; use resetClaim to let someone claim again.
    mapping(uint => mapping(address => bool)) public hasClaimed;

    mapping(address => bool) public isAllowedToTrigger;

    error NotAllowedToTrigger();
    error NoGrantForNode(uint nodeId);
    error InvalidTraitValue(uint8 value);
    error InvalidVariant(uint16 variant);
    error ArmorAndShieldsBothSet();

    event TriggerAllowedSet(address indexed caller, bool allowed);
    event GrantSet(uint indexed nodeId);
    event GrantCleared(uint indexed nodeId);
    event ClaimReset(uint indexed nodeId, address indexed player);
    event ShipGranted(
        uint indexed nodeId,
        address indexed player,
        uint shipId
    );

    constructor(address _ships) Ownable(msg.sender) {
        ships = IShips(_ships);
    }

    modifier onlyAllowed() {
        if (!isAllowedToTrigger[msg.sender]) revert NotAllowedToTrigger();
        _;
    }

    function setIsAllowedToTrigger(
        address _caller,
        bool _allowed
    ) external onlyOwner {
        isAllowedToTrigger[_caller] = _allowed;
        emit TriggerAllowedSet(_caller, _allowed);
    }

    function setShipsAddress(address _ships) external onlyOwner {
        ships = IShips(_ships);
    }

    /// @dev Set or replace the ship a win at _nodeId grants. Validated with
    /// the same rules DroneYard applies to a player's own edits.
    function setGrant(
        uint _nodeId,
        ShipGrant calldata _grant
    ) external onlyOwner {
        if (_grant.accuracy > 2) revert InvalidTraitValue(_grant.accuracy);
        if (_grant.hull > 2) revert InvalidTraitValue(_grant.hull);
        if (_grant.speed > 2) revert InvalidTraitValue(_grant.speed);
        if (_grant.variant == 0 || _grant.variant > ships.maxVariant())
            revert InvalidVariant(_grant.variant);
        if (
            _grant.equipment.armor != Armor.None &&
            _grant.equipment.shields != Shields.None
        ) revert ArmorAndShieldsBothSet();
        grants[_nodeId] = _grant;
        hasGrant[_nodeId] = true;
        emit GrantSet(_nodeId);
    }

    function clearGrant(uint _nodeId) external onlyOwner {
        delete grants[_nodeId];
        hasGrant[_nodeId] = false;
        emit GrantCleared(_nodeId);
    }

    /// @dev Lets _player receive a once-per-address grant again.
    function resetClaim(uint _nodeId, address _player) external onlyOwner {
        hasClaimed[_nodeId][_player] = false;
        emit ClaimReset(_nodeId, _player);
    }

    function getGrant(uint _nodeId) external view returns (ShipGrant memory) {
        return grants[_nodeId];
    }

    // Reverting is safe for the game: RoguelikeMatch try/catches each
    // effect and emits WinEffectFailed. A revert also undoes the hasClaimed
    // write, so a failed mint (e.g. Ships paused) doesn't use up a
    // once-per-address claim.
    function onWin(address _player, uint _nodeId) external override onlyAllowed {
        if (!hasGrant[_nodeId]) revert NoGrantForNode(_nodeId);
        ShipGrant memory g = grants[_nodeId];
        if (g.oncePerAddress) {
            // Already received: no ship, and not a failure.
            if (hasClaimed[_nodeId][_player]) return;
            hasClaimed[_nodeId][_player] = true;
        }
        uint shipId = ships.createSpecificShip(_player, _buildShip(g));
        emit ShipGranted(_nodeId, _player, shipId);
    }

    function _buildShip(
        ShipGrant memory g
    ) internal pure returns (Ship memory ship) {
        // Fields left zero (id, serialNumber, cost, constructed, owner, ...)
        // are ignored or recomputed by createSpecificShip.
        ship.name = g.name;
        ship.equipment = g.equipment;
        ship.traits.colors = g.colors;
        ship.traits.variant = g.variant;
        ship.traits.accuracy = g.accuracy;
        ship.traits.hull = g.hull;
        ship.traits.speed = g.speed;
        ship.shipData.shipsDestroyed = g.shipsDestroyed;
        ship.shipData.shiny = g.shiny;
        ship.shipData.isFreeShip = g.isFreeShip;
    }
}

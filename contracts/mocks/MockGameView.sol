// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "../Types.sol";
import "../IEffectResolver.sol";

// Minimal settable stand-in for Game.sol's IGameView surface, so an effect
// resolver's own target-validation logic (e.g. the SP-02 status check) can
// be unit-tested directly without spinning up a full game.
contract MockGameView {
    mapping(uint => mapping(uint => ShipPosition)) private positions;
    mapping(uint => mapping(uint => Attributes)) private attrs;
    // Tracks every shipId ever set per game, so getAllShipPositions (needed
    // by FlakArrayResolver/DroneSwarmResolver/ElectricStormResolver's
    // AoE scans — see HA3-06's test) can return something real instead of
    // the previously-hardcoded empty array. Idempotent: re-setting an
    // already-registered shipId's position doesn't duplicate it here.
    mapping(uint => uint[]) private shipIdsByGame;
    mapping(uint => mapping(uint => bool)) private shipIdRegistered;

    function setShipPosition(
        uint _gameId,
        uint _shipId,
        ShipPosition calldata _position
    ) external {
        positions[_gameId][_shipId] = _position;
        if (!shipIdRegistered[_gameId][_shipId]) {
            shipIdRegistered[_gameId][_shipId] = true;
            shipIdsByGame[_gameId].push(_shipId);
        }
    }

    function setShipAttributes(
        uint _gameId,
        uint _shipId,
        Attributes calldata _attrs
    ) external {
        attrs[_gameId][_shipId] = _attrs;
    }

    function getShipPosition(
        uint _gameId,
        uint _shipId
    ) external view returns (ShipPosition memory) {
        return positions[_gameId][_shipId];
    }

    function getShipAttributes(
        uint _gameId,
        uint _shipId
    ) external view returns (Attributes memory) {
        return attrs[_gameId][_shipId];
    }

    function getAllShipPositions(
        uint _gameId
    ) external view returns (ShipPosition[] memory result) {
        uint[] storage ids = shipIdsByGame[_gameId];
        result = new ShipPosition[](ids.length);
        for (uint i = 0; i < ids.length; i++) {
            result[i] = positions[_gameId][ids[i]];
        }
    }

    // Resolvers (2026-09-28) read live ship state via IGameView(msg.sender)
    // instead of a stored/settable `game` address, since msg.sender is
    // already the real calling Game engine in production. A test calling
    // resolver.resolveEffect(...) directly would make the TEST's own
    // account msg.sender, not this mock -- so tests route through here
    // instead, making THIS contract msg.sender from the resolver's point of
    // view, exactly like a real Game would be.
    function callResolveEffect(
        address _resolver,
        uint _gameId,
        uint _shipId,
        uint16 _variant,
        uint _targetShipId,
        int16 _actingRow,
        int16 _actingCol
    ) external view returns (SpecialEffect[] memory) {
        return
            IEffectResolver(_resolver).resolveEffect(
                _gameId,
                _shipId,
                _variant,
                _targetShipId,
                _actingRow,
                _actingCol
            );
    }
}

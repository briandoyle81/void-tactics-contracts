// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "./Types.sol";

interface IFleets {
    function createFleet(
        uint _lobbyId,
        address _owner,
        uint[] calldata _shipIds,
        Position[] calldata _startingPositions,
        uint _costLimit,
        bool _isCreator,
        uint _mapId
    ) external returns (uint);

    function createFleetFrozenPrices(
        uint _lobbyId,
        address _owner,
        uint[] calldata _shipIds,
        Position[] calldata _startingPositions,
        uint _costLimit,
        bool _isCreator,
        uint _mapId
    ) external returns (uint);

    function clearFleet(uint _fleetId) external;

    function removeShipFromFleet(uint _fleetId, uint _shipId) external;

    function getFleet(uint _fleetId) external view returns (Fleet memory);

    function isShipInFleet(
        uint _fleetId,
        uint _shipId
    ) external view returns (bool);

    function getFleetShipIdsAndPositions(
        uint _fleetId
    )
        external
        view
        returns (uint[] memory shipIds, Position[] memory startingPositions);
}

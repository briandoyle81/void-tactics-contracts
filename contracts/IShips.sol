// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "./Types.sol";

interface IShips {
    function createShips(
        address _to,
        uint _amount,
        uint16 _variant,
        uint8 _tier,
        bool _isFreeShip
    ) external;

    function createSpecificShip(address _to, Ship calldata _ship) external returns (uint);

    function getShip(uint _id) external view returns (Ship memory);

    function getShipStatsInput(
        uint _id
    ) external view returns (ShipStatsInput memory);

    function isShipDestroyed(uint _id) external view returns (bool);

    function setTimestampDestroyed(uint _id, uint _destroyerId) external;

    function setInFleet(uint _id, bool _inFleet) external;

    function customizeShip(
        uint _id,
        Ship memory _ship
    ) external;

    function maxVariant() external view returns (uint16);

    function recycleReward() external view returns (uint);
}

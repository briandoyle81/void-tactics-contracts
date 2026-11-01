// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "./Types.sol";

// Surface AIShips.sol exposes beyond plain ship-data lookups: allocate/
// release are pool-management concepts IShips has no notion of, so this is
// deliberately a separate interface rather than a superset/subset of IShips.
interface IAIShips {
    // Lets ShipsRouter read the offset once at construction instead of
    // hardcoding its own copy — two independently-declared constants that
    // must always match is a silent-drift hazard neither compiler nor
    // tests catch if one gets edited without the other.
    function AI_SHIP_ID_OFFSET() external view returns (uint);

    // Called only by SinglePlayerMatch (gated by isAllowedToCreateShips).
    function allocateShip(
        address _to,
        Ship calldata _template
    ) external returns (uint globalId);

    function releaseShips(uint[] calldata _shipIds) external;

    // Called only by ShipsRouter (gated by the configured router address).
    function getShip(uint _id) external view returns (Ship memory);

    function getShipStatsInput(
        uint _id
    ) external view returns (ShipStatsInput memory);

    function isShipDestroyed(uint _id) external view returns (bool);

    function markDestroyed(uint _id) external returns (address ownerOut);

    function recordKill(uint _destroyerId) external returns (address ownerOut);

    function setInFleet(uint _id, bool _inFleet) external;
}

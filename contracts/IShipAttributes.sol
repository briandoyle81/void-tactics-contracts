// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "./Types.sol";

interface IShipAttributes {
    function calculateShipAttributes(
        Ship memory _ship
    ) external view returns (Attributes memory);

    function calculateShipAttributesById(
        uint _shipId
    ) external view returns (Attributes memory);

    function calculateBoardStatsByIds(
        uint[] calldata _shipIds
    )
        external
        view
        returns (
            Attributes[] memory attributes,
            uint16[] memory variants,
            Special[] memory specials
        );

    function calculateShipAttributesByIds(
        uint[] memory _shipIds
    ) external view returns (Attributes[] memory);

    function getSpecialRange(
        Special _special,
        uint16 _variant
    ) external view returns (uint8);

    function getSpecialStrength(
        Special _special,
        uint16 _variant
    ) external view returns (uint8);

    // Pinned-version reads: in-game logic passes the acting ship's
    // Attributes.version (its game-start snapshot) so a later publish or
    // rollback can't change the numbers mid-game.
    function getSpecialRangeAt(
        uint16 _variant,
        uint16 _version,
        Special _special
    ) external view returns (uint8);

    function getSpecialStrengthAt(
        uint16 _variant,
        uint16 _version,
        Special _special
    ) external view returns (uint8);

    function getRank(
        uint16 _variant,
        uint _shipsDestroyed
    ) external view returns (uint8);

    function getGunData(
        MainWeapon _weapon,
        uint16 _variant
    ) external view returns (GunData memory);

    function getArmorData(
        Armor _armor,
        uint16 _variant
    ) external view returns (ArmorData memory);

    function getShieldData(
        Shields _shields,
        uint16 _variant
    ) external view returns (ShieldData memory);

    function getSpecialData(
        Special _special,
        uint16 _variant
    ) external view returns (SpecialData memory);

    // Cost calculation functions
    function calculateShipCost(Ship memory ship) external view returns (uint16);

    function setCosts(uint16 _variant, Costs memory _costs) external;

    function getCosts(
        uint16 _variant
    ) external view returns (uint, Costs memory);

    function getCurrentCostsVersion(
        uint16 _variant
    ) external view returns (uint16);

    // Attributes version management functions (per variant)
    function setCurrentAttributesVersion(
        uint16 _variant,
        uint16 _version
    ) external;

    function getCurrentAttributesVersion(
        uint16 _variant
    ) external view returns (uint16);

    function getLatestAttributesVersion(
        uint16 _variant
    ) external view returns (uint16);

    function getVariantAttributes(
        uint16 _variant,
        uint16 _version
    ) external view returns (VariantAttributeData memory);

    function setVariantAttributes(
        SetVariantAttributesParams memory params
    ) external;
}

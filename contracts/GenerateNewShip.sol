// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/access/Ownable.sol";
import "./Types.sol";
import "./IOnchainRandomShipNames.sol";
import "./IDroneNames.sol";
import "./IGameView.sol";

contract GenerateNewShip is Ownable {
    IOnchainRandomShipNames public immutable shipNames;
    IDroneNames public immutable droneNames;
    // Wired post-deploy (Game.sol doesn't exist yet when this contract is
    // constructed — Game depends on Ships, which depends on this). Used only
    // to read maxSpecialSlot so the random roll below never lands on a slot
    // with no registered resolver. Guarded everywhere it's read: an unset
    // game falls back to always rolling None rather than reverting ship
    // generation over missing wiring.
    IGameView public game;

    constructor(address _shipNames, address _droneNames) Ownable(msg.sender) {
        shipNames = IOnchainRandomShipNames(_shipNames);
        droneNames = IDroneNames(_droneNames);
    }

    function setGameContract(address _game) external onlyOwner {
        game = IGameView(_game);
    }

    function generateShip(
        uint id,
        uint serialNumber,
        uint64 randomBase,
        uint16 variant
    ) external view returns (Ship memory) {
        Ship memory newShip;
        newShip.id = id;
        newShip.traits.serialNumber = serialNumber;

        // Weapon is rolled before name (not in its original relative
        // position further down) because variant-2 drone names are themed
        // to the ship's equipped weapon (see DroneNames.sol) and so need to
        // know it already.
        randomBase++;
        newShip.equipment.mainWeapon = MainWeapon(
            uint(keccak256(abi.encodePacked(randomBase))) % 4
        );

        randomBase++;
        bytes32 nameSeed = bytes32(
            uint256(keccak256(abi.encodePacked(randomBase)))
        );
        if (variant == 2) {
            newShip.name = droneNames.getRandomDroneName(
                nameSeed,
                newShip.equipment.mainWeapon
            );
        } else {
            newShip.name = shipNames.getRandomShipName(nameSeed);
        }

        // r g b 1 and 2 values are 0 to 255
        randomBase++;
        newShip.traits.colors.h1 = uint16(
            uint(keccak256(abi.encodePacked(randomBase))) % 360
        );

        randomBase++;
        newShip.traits.colors.s1 = uint8(
            uint(keccak256(abi.encodePacked(randomBase))) % 100
        );

        randomBase++;
        newShip.traits.colors.l1 = uint8(
            uint(keccak256(abi.encodePacked(randomBase))) % 100
        );

        randomBase++;
        newShip.traits.colors.h2 = uint16(
            uint(keccak256(abi.encodePacked(randomBase))) % 360
        );

        randomBase++;
        newShip.traits.colors.s2 = uint8(
            uint(keccak256(abi.encodePacked(randomBase))) % 100
        );

        randomBase++;
        newShip.traits.colors.l2 = uint8(
            uint(keccak256(abi.encodePacked(randomBase))) % 100
        );

        randomBase++;
        newShip.traits.accuracy = uint8(
            getTierOfTrait(uint(keccak256(abi.encodePacked(randomBase))) % 100)
        );

        randomBase++;
        newShip.traits.hull = uint8(
            getTierOfTrait(uint(keccak256(abi.encodePacked(randomBase))) % 100)
        );

        randomBase++;
        newShip.traits.speed = uint8(
            getTierOfTrait(uint(keccak256(abi.encodePacked(randomBase))) % 100)
        );

        randomBase++;
        newShip.traits.variant = variant;

        // Flip a coin to determine if a ship has armor or shields
        randomBase++;
        bool hasArmor = uint(keccak256(abi.encodePacked(randomBase))) % 2 == 0;
        randomBase++;
        if (hasArmor) {
            newShip.equipment.armor = Armor(
                uint(keccak256(abi.encodePacked(randomBase))) % 4
            );
        } else {
            newShip.equipment.shields = Shields(
                uint(keccak256(abi.encodePacked(randomBase))) % 4
            );
        }

        randomBase++;
        // Special is a per-faction local slot (see Types.sol) — roll only
        // across the slots this variant actually has a resolver for
        // (maxSpecialSlot[variant] + 1, since None is always a valid
        // outcome), so a freshly-generated ship can never land on an inert
        // filler slot (4-7 today) that reverts the moment it's used. Falls
        // back to always-None if `game` isn't wired yet, rather than
        // reverting ship generation.
        uint8 maxSlot = address(game) != address(0)
            ? game.maxSpecialSlot(variant)
            : 0;
        newShip.equipment.special = Special(
            uint(keccak256(abi.encodePacked(randomBase))) % (uint(maxSlot) + 1)
        );

        // TODO: Should it be adjustable chance for shiny?
        uint shinyChance = uint(keccak256(abi.encodePacked(randomBase))) % 100;
        if (shinyChance <= 8) {
            newShip.shipData.shiny = true;
        }

        // Generated a weighted random number to determine the starting number of enemies destroyed
        // Distribution maintains similar probabilities to original but with new rank thresholds:
        // 75% chance: Rank 1 (1-9 kills)
        // 15% chance: Rank 2 (10-29 kills)
        // 5% chance: Rank 3 (30-99 kills)
        // 4% chance: Rank 4 (100-299 kills)
        // 1% chance: Rank 5 (300-999 kills)
        // Rank 6 (1000+) cannot be created, must be earned through gameplay

        randomBase++;
        uint shipsDestroyed = uint(keccak256(abi.encodePacked(randomBase))) %
            100;
        if (shipsDestroyed < 75) {
            // 75% chance: Rank 1 (1-9 kills)
            newShip.shipData.shipsDestroyed = uint16(1 + (shipsDestroyed % 9));
        } else if (shipsDestroyed < 90) {
            // 15% chance: Rank 2 (10-29 kills)
            newShip.shipData.shipsDestroyed = uint16(10 + (shipsDestroyed % 20));
        } else if (shipsDestroyed < 95) {
            // 5% chance: Rank 3 (30-99 kills)
            newShip.shipData.shipsDestroyed = uint16(30 + (shipsDestroyed % 70));
        } else if (shipsDestroyed < 99) {
            // 4% chance: Rank 4 (100-299 kills)
            newShip.shipData.shipsDestroyed = uint16(100 + (shipsDestroyed % 200));
        } else {
            // 1% chance: Rank 5 (300-999 kills)
            newShip.shipData.shipsDestroyed = uint16(300 + (shipsDestroyed % 700));
        }

        return newShip;
    }

    // The ship an expired, never-captured random request builds
    // (docs/trustless-randomness-plan-2026-11-01.md, audit-4 HA7-10): no
    // better than any real roll in anything that matters, so letting a bad
    // roll expire on purpose never pays. Tier 0 traits, no shiny, minimum
    // rank (Ships keeps a purchase tier's preset kills), the Generic
    // weapon, no armor or shields, no special. Name and colors are cosmetic and come
    // from a seed fixed at mint, so they offer no choice either.
    function generateBaselineShip(
        uint id,
        uint serialNumber,
        uint16 variant
    ) external view returns (Ship memory ship) {
        ship = this.generateShip(
            id,
            serialNumber,
            uint64(uint(keccak256(abi.encode("baseline", serialNumber)))),
            variant
        );
        ship.traits.accuracy = 0;
        ship.traits.hull = 0;
        ship.traits.speed = 0;
        ship.equipment.mainWeapon = MainWeapon(0);
        ship.equipment.armor = Armor(0);
        ship.equipment.shields = Shields(0);
        ship.equipment.special = Special.None;
        ship.shipData.shiny = false;
        ship.shipData.shipsDestroyed = 1;
    }

    // WARNING: This function is duplicated in Ships.sol
    function getTierOfTrait(uint _trait) public pure returns (uint8) {
        if (_trait < 50) {
            return 0;
        } else if (_trait < 80) {
            return 1;
        } else {
            return 2;
        }
    }
}

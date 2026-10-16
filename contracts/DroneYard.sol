// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "./IShips.sol";
import "./IUniversalCredits.sol";
import "./IShipPurchaser.sol";
import "./IOnchainRandomShipNames.sol";
import "./IGameView.sol";
import "./Types.sol";

contract DroneYard is Ownable, ReentrancyGuard {
    error NotShipOwner(uint _shipId);
    error ShipNotConstructed(uint _shipId);
    error ShipInFleet(uint _shipId);
    error InvalidModification();
    error InsufficientFunds(uint _required, uint _available);
    error InvalidTraitValue(uint8 _value);
    error ArmorAndShieldsBothSet();
    error InvalidVariant(uint16 _variant);
    error InvalidSpecial(Special _special);

    event Withdrawn(address indexed to, uint amount);

    IShips public immutable ships;
    IUniversalCredits public immutable universalCredits;
    IShipPurchaser public immutable shipPurchaser;
    IOnchainRandomShipNames public immutable shipNames;
    // Wired post-deploy, same as GenerateNewShip.game — Game.sol doesn't
    // exist yet when this contract is constructed. Guarded everywhere it's
    // read: an unset game skips the special-slot check entirely rather than
    // blocking every modifyShip call over missing wiring.
    IGameView public game;

    constructor(
        address _ships,
        address _universalCredits,
        address _shipPurchaser,
        address _shipNames
    ) Ownable(msg.sender) {
        ships = IShips(_ships);
        universalCredits = IUniversalCredits(_universalCredits);
        shipPurchaser = IShipPurchaser(_shipPurchaser);
        shipNames = IOnchainRandomShipNames(_shipNames);
    }

    function setGameContract(address _game) external onlyOwner {
        game = IGameView(_game);
    }

    /**
     * @dev Withdraw accumulated UTC modification fees to `_to`. H-04 fix: without
     * this, every modifyShip fee is permanently locked in this contract.
     */
    function withdraw(address _to) external onlyOwner {
        uint amount = universalCredits.balanceOf(address(this));
        require(universalCredits.transfer(_to, amount), "UTC transfer failed");
        emit Withdrawn(_to, amount);
    }

    /**
     * @dev Burns UTC modification fees this contract is already holding,
     * as an alternative to withdraw() — an on-chain-visible supply
     * reduction instead of a claim about what happened to withdrawn funds.
     */
    function burnCollected(uint _amount) external onlyOwner {
        universalCredits.burn(_amount);
    }

    /**
     * @dev Calculate the cost to modify a ship
     * @param _shipId The ID of the ship to modify
     * @param _newShip The new ship configuration
     * @return The cost in UTC tokens
     */
    function calculateCostToModify(
        uint _shipId,
        Ship memory _newShip
    ) public view returns (uint) {
        return _calculateCostToModify(ships.getShip(_shipId), _newShip);
    }

    // G-05: split out of calculateCostToModify so modifyShip can pass in the
    // Ship it already fetched once, instead of paying for a second
    // cross-contract ships.getShip call for data that can't have changed
    // within the same transaction. calculateCostToModify (above) stays as a
    // standalone public preview entry point for the frontend.
    function _calculateCostToModify(
        Ship memory currentShip,
        Ship memory _newShip
    ) internal view returns (uint) {
        if (currentShip.id == 0) revert InvalidModification();

        uint totalModifications = _calculateTotalModifications(
            currentShip,
            _newShip
        );

        // Base cost is 1/5 of tier 0 price
        uint baseCost = shipPurchaser.tierPrices(0) / 5;

        // Cost doubles for each modification (existing + new)
        // If totalModifications is 0, cost is baseCost
        // If totalModifications is 1, cost is baseCost * 2
        // If totalModifications is 2, cost is baseCost * 4
        // etc.
        if (totalModifications == 0) {
            return baseCost;
        }

        // Calculate 2^totalModifications
        uint costMultiplier = 1;
        for (uint i = 0; i < totalModifications; i++) {
            costMultiplier *= 2;
        }

        return baseCost * costMultiplier;
    }

    /**
     * @dev Validate that a ship modification is valid
     * @param _shipId The ID of the ship to modify
     * @param _newShip The new ship configuration
     */
    function validateShip(
        uint _shipId,
        Ship memory _newShip
    ) public view returns (bool) {
        return _validateShip(ships.getShip(_shipId), _newShip);
    }

    // G-05: split out of validateShip for the same reason as
    // _calculateCostToModify above — lets modifyShip reuse the Ship it
    // already fetched instead of a second redundant ships.getShip call.
    function _validateShip(
        Ship memory currentShip,
        Ship memory _newShip
    ) internal view returns (bool) {
        if (currentShip.id == 0) revert InvalidModification();

        // Validate trait values (must be 0, 1, or 2)
        if (_newShip.traits.accuracy > 2)
            revert InvalidTraitValue(_newShip.traits.accuracy);
        if (_newShip.traits.hull > 2)
            revert InvalidTraitValue(_newShip.traits.hull);
        if (_newShip.traits.speed > 2)
            revert InvalidTraitValue(_newShip.traits.speed);
        if (
            _newShip.traits.variant == 0 ||
            _newShip.traits.variant > ships.maxVariant()
        ) revert InvalidVariant(_newShip.traits.variant);

        // DroneYard never changes a ship's variant — closes the
        // buy-cheap-then-convert bypass around variant purchase gates
        // (e.g. VariantPurchaseGate.sol) at the root, rather than
        // duplicating a gate check here.
        if (_newShip.traits.variant != currentShip.traits.variant)
            revert InvalidVariant(_newShip.traits.variant);

        // One of armor or shields must be None
        if (
            _newShip.equipment.armor != Armor.None &&
            _newShip.equipment.shields != Shields.None
        ) {
            revert ArmorAndShieldsBothSet();
        }

        // Reject equipping a special slot this variant has no resolver for
        // (an inert filler slot) — a deliberate player choice should be
        // told it's invalid, not silently accepted into a dead loadout.
        // Skipped if `game` isn't wired (see its own comment).
        if (
            address(game) != address(0) &&
            uint8(_newShip.equipment.special) >
            game.maxSpecialSlot(_newShip.traits.variant)
        ) {
            revert InvalidSpecial(_newShip.equipment.special);
        }

        return true;
    }

    /**
     * @dev Modify a ship owned by the caller
     * @param _shipId The ID of the ship to modify
     * @param _newShip The new ship configuration
     */
    function modifyShip(
        uint _shipId,
        Ship memory _newShip
    ) public nonReentrant {
        Ship memory currentShip = ships.getShip(_shipId);
        if (currentShip.id == 0) revert InvalidModification();

        // Check ownership
        if (currentShip.owner != msg.sender) {
            revert NotShipOwner(_shipId);
        }

        // Ship must be constructed
        if (!currentShip.shipData.constructed) {
            revert ShipNotConstructed(_shipId);
        }

        // Ship must not be in a fleet
        if (currentShip.shipData.inFleet) {
            revert ShipInFleet(_shipId);
        }

        // Validate the modification — reuse currentShip (already fetched
        // above) instead of validateShip's own ships.getShip call (G-05).
        _validateShip(currentShip, _newShip);

        // Calculate cost — same reuse (G-05).
        uint cost = _calculateCostToModify(currentShip, _newShip);

        // Check balance
        uint balance = universalCredits.balanceOf(msg.sender);
        if (balance < cost) {
            revert InsufficientFunds(cost, balance);
        }

        // Transfer UTC tokens from user to this contract
        require(
            universalCredits.transferFrom(msg.sender, address(this), cost),
            "UTC transfer failed"
        );

        // Update the ship using customizeShip
        // We need to preserve the serial number, colors, and other immutable traits
        _newShip.traits.serialNumber = currentShip.traits.serialNumber;
        _newShip.traits.colors = currentShip.traits.colors; // Preserve colors
        _newShip.name = currentShip.name; // Preserve name
        _newShip.id = _shipId;
        _newShip.owner = currentShip.owner;
        // customizeShip stores these from the caller's struct, and neither
        // is validated or priced here — without this, ~1 UTC buys rank 6
        // (or a uint32.max kill count that makes recordKill overflow and
        // freeze a game), or clears isFreeShip to recycle a free ship
        // (docs/audit-3.md HA6-03). Shiny is the one shipData field
        // DroneYard prices, so it's still taken from the caller.
        _newShip.shipData.shipsDestroyed = currentShip.shipData.shipsDestroyed;
        _newShip.shipData.isFreeShip = currentShip.shipData.isFreeShip;

        // Call customizeShip on Ships contract (it will calculate modifications internally)
        ships.customizeShip(_shipId, _newShip);
    }

    /**
     * @dev Internal function to calculate total modifications (for cost calculation)
     * Includes existing modified value + new modifications
     * @param _currentShip The current ship state
     * @param _newShip The new ship configuration
     * @return Total number of modifications (existing + new)
     */
    function _calculateTotalModifications(
        Ship memory _currentShip,
        Ship memory _newShip
    ) internal pure returns (uint) {
        uint modifications = _currentShip.shipData.modified;
        modifications += _calculateNewModifications(
            _currentShip,
            _newShip
        );
        return modifications;
    }

    /**
     * @dev Internal function to calculate new modifications only
     * @param _currentShip The current ship state
     * @param _newShip The new ship configuration
     * @return Number of new modifications
     */
    function _calculateNewModifications(
        Ship memory _currentShip,
        Ship memory _newShip
    ) internal pure returns (uint) {
        uint modifications = 0;

        // Count equipment changes (add 1 for each changed property)
        if (
            _currentShip.equipment.mainWeapon != _newShip.equipment.mainWeapon
        ) {
            modifications++;
        }
        if (_currentShip.equipment.armor != _newShip.equipment.armor) {
            modifications++;
        }
        if (_currentShip.equipment.shields != _newShip.equipment.shields) {
            modifications++;
        }
        if (_currentShip.equipment.special != _newShip.equipment.special) {
            modifications++;
        }

        // Calculate trait changes (total absolute difference)
        int16 accuracyChange = int16(int(uint(_newShip.traits.accuracy))) -
            int16(int(uint(_currentShip.traits.accuracy)));
        int16 hullChange = int16(int(uint(_newShip.traits.hull))) -
            int16(int(uint(_currentShip.traits.hull)));
        int16 speedChange = int16(int(uint(_newShip.traits.speed))) -
            int16(int(uint(_currentShip.traits.speed)));

        uint traitChanges = uint(
            uint16(abs(accuracyChange)) +
                uint16(abs(hullChange)) +
                uint16(abs(speedChange))
        );
        modifications += traitChanges;

        // Count shiny status change as 3 modifications
        if (_currentShip.shipData.shiny != _newShip.shipData.shiny) {
            modifications += 3;
        }

        // Count variant change as 3 modifications, matching shiny's weight
        if (_currentShip.traits.variant != _newShip.traits.variant) {
            modifications += 3;
        }

        return modifications;
    }

    /**
     * @dev Helper function to get absolute value
     */
    function abs(int16 x) internal pure returns (int16) {
        return x >= 0 ? x : -x;
    }
}

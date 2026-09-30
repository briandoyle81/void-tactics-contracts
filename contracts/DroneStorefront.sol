// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import "@openzeppelin/contracts/access/Ownable.sol";
import "./IDroneEnergyCores.sol";

// Where players spend DEC (a freely transferable ERC20 — see
// DroneEnergyCores.sol): turn in an exact tier's worth of cores to
// permanently step up droneCoreTier, which FreeShipClaim.claimFreeShips
// reads directly as a player's free-ship bonus (1 tier = +1 ship — see
// IDroneStorefront.sol/FreeShipClaim.sol).
contract DroneStorefront is Ownable {
    address public droneEnergyCores;

    // tierCoreCost[i] = cores required to advance from tier i to tier i+1.
    // Tiers must be purchased in order; the number of configured tiers is
    // itself the cap on how large a player's bonus can grow.
    uint256[] public tierCoreCost;
    mapping(address => uint8) public droneCoreTier;

    event TierAdded(uint256 indexed tierIndex, uint256 cost);
    event CoresTurnedIn(address indexed player, uint8 newTier, uint256 amount);

    error MaxTierReached(address);
    error WrongAmount(uint256 expected, uint256 provided);
    error InvalidDroneEnergyCoresAddress();

    constructor(address _droneEnergyCores) Ownable(msg.sender) {
        _setDroneEnergyCoresAddress(_droneEnergyCores);
    }

    function setDroneEnergyCoresAddress(
        address _droneEnergyCores
    ) external onlyOwner {
        _setDroneEnergyCoresAddress(_droneEnergyCores);
    }

    // HA4-06 fix (2026-09-29): rejects address(0) and any address with no
    // deployed code. Without this, turnInCores' burnFrom call against a
    // misconfigured address silently succeeds (a call to a non-existent
    // void-returning function has no return data to fail decoding on),
    // advancing droneCoreTier — a permanent free-ship bonus — with no DEC
    // ever actually burned.
    function _setDroneEnergyCoresAddress(address _droneEnergyCores) private {
        if (
            _droneEnergyCores == address(0) ||
            _droneEnergyCores.code.length == 0
        ) revert InvalidDroneEnergyCoresAddress();
        droneEnergyCores = _droneEnergyCores;
    }

    function addTier(uint256 _cost) external onlyOwner {
        tierCoreCost.push(_cost);
        emit TierAdded(tierCoreCost.length - 1, _cost);
    }

    // Turns in the exact number of cores required for the caller's next
    // tier, permanently granting +1 to their free-ship bonus.
    function turnInCores(uint256 _amount) external {
        uint8 currentTier = droneCoreTier[msg.sender];
        if (currentTier >= tierCoreCost.length) {
            revert MaxTierReached(msg.sender);
        }

        uint256 required = tierCoreCost[currentTier];
        if (_amount != required) {
            revert WrongAmount(required, _amount);
        }

        // HA4-07 fix (2026-09-29): state updated before the external call
        // (checks-effects-interactions), not after. Not currently
        // exploitable — DroneEnergyCores is a stock OpenZeppelin
        // ERC20/ERC20Burnable with no transfer/burn hooks, so there's no
        // live reentrancy surface today — but this is free defense-in-depth
        // against a future non-standard token ever being wired in (the same
        // precondition HA4-06's check above guards against).
        droneCoreTier[msg.sender] = currentTier + 1;

        // Burn turned-in cores directly out of circulation (requires the
        // caller to have approved this contract for `_amount`) rather than
        // pulling them into this contract's own balance — DEC turned in
        // here was previously an unrecoverable sink (no withdraw path
        // existed), so burning is strictly more honest about what already
        // happens to it, and it's now reflected in totalSupply().
        IDroneEnergyCores(droneEnergyCores).burnFrom(msg.sender, _amount);

        emit CoresTurnedIn(msg.sender, currentTier + 1, _amount);
    }
}

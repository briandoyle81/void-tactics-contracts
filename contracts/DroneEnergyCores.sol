// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

// Reward token minted to a player's own wallet for destroying an AI-owned
// ship in a single-player match (ShipsRouter.setTimestampDestroyed) — a
// freely transferable ERC20, same as UniversalCredits. Deliberately not
// soulbound: a player who has time but not money can grind DEC and sell it
// (P2P/DEX/OTC — nothing on-chain needs to broker this) to a player who has
// money but not time, who then turns it in themselves via
// DroneStorefront.turnInCores. Wallet-level transfer restrictions don't
// meaningfully deter this kind of trade in a permissionless system (a new
// wallet is free), so supply is controlled entirely by the mint side
// (authorizedToMint), not by gating transfers.
contract DroneEnergyCores is ERC20, ERC20Burnable, Ownable {
    error NotAuthorized(address);
    error MintNotActive();

    bool public mintIsActive;

    mapping(address => bool) public authorizedToMint;

    constructor() ERC20("Drone Energy Cores", "DEC") Ownable(msg.sender) {}

    // Cores are indivisible (docs/audit-4.md HA7-01): every amount is a
    // whole number of cores, so DroneStorefront tier costs, kill rewards
    // and win bonuses are all plain counts.
    function decimals() public pure override returns (uint8) {
        return 0;
    }

    /*
     * @dev Public Functions
     */

    function mint(address _to, uint _amount) public mintingIsActive {
        if (!authorizedToMint[msg.sender]) {
            revert NotAuthorized(msg.sender);
        }

        _mint(_to, _amount);
    }

    /*
     * @dev Owner Functions
     */

    function setMintIsActive(bool _mintIsActive) public onlyOwner {
        mintIsActive = _mintIsActive;
    }

    function setAuthorizedToMint(
        address _address,
        bool _authorized
    ) public onlyOwner {
        authorizedToMint[_address] = _authorized;
    }

    /*
     * @dev Modifiers
     */

    modifier mintingIsActive() {
        if (!mintIsActive) {
            revert MintNotActive();
        }
        _;
    }
}

// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract UniversalCredits is ERC20, ERC20Burnable, Ownable {
    error NotAuthorized(address);
    error MintNotActive();

    bool public mintIsActive;

    mapping(address => bool) public authorizedToMint;

    constructor() ERC20("Universal Time Credits", "UTC") Ownable(msg.sender) {}

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

    function withdrawAll() public onlyOwner {
        // Send the balance of flow (ether) to the owner
        (bool success, ) = owner().call{value: address(this).balance}("");
        require(success, "Failed to send Ether");
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

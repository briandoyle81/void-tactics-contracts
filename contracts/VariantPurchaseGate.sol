// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";

// Generic "does this address hold the NFT required to mint variant X"
// registry. Deployed standalone and called from Ships.sol (already the
// tightest-margin contract in the repo — see CLAUDE.md) so that Ships.sol
// never needs to grow new code when a future variant gets a similar gate:
// it just stays ignorant of which variants are gated and on what, and
// owner-configuration below is what actually adds a new gate.
//
// requiredNft[variant] == address(0) means that variant is ungated.
contract VariantPurchaseGate is Ownable {
    mapping(uint16 => address) public requiredNft;

    // Mint sources that bypass every gate. The lottery hook is exempt so any
    // winner can receive any variant as a prize, medal or not (otherwise a
    // gated prize would make resolveDraw revert for a medal-less winner —
    // docs/audit-3.md HA6-06). Purchases and free claims stay gated.
    mapping(address => bool) public exemptMinter;

    error GateRequirementNotMet(uint16 variant);

    constructor() Ownable(msg.sender) {}

    function setRequiredNft(uint16 _variant, address _nft) external onlyOwner {
        requiredNft[_variant] = _nft;
    }

    function setExemptMinter(address _minter, bool _exempt) external onlyOwner {
        exemptMinter[_minter] = _exempt;
    }

    function checkGate(
        uint16 _variant,
        address _to,
        address _minter
    ) external view {
        if (exemptMinter[_minter]) return;
        address nft = requiredNft[_variant];
        if (nft != address(0) && IERC721(nft).balanceOf(_to) == 0) {
            revert GateRequirementNotMet(_variant);
        }
    }
}

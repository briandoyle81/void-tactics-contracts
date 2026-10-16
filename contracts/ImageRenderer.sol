// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "./Types.sol";
import "./IRenderer.sol";
import "./Renderers/RenderSpecial.sol";
import "./Renderers/RenderAft.sol";
import "./Renderers/RenderWeapon.sol";
import "./Renderers/RenderBody.sol";
import "./Renderers/RenderFore.sol";
import "@openzeppelin/contracts/utils/Strings.sol";
import "@openzeppelin/contracts/utils/Base64.sol";

contract ImageRenderer is IImageRenderer {
    using Strings for string;

    // Base SVG template with viewBox and dimensions
    string private constant BASE_SVG =
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">';
    string private constant SVG_END = "</svg>";

    IRenderComponent public immutable renderSpecial;
    IRenderComponent public immutable renderAft;
    IRenderComponent public immutable renderWeapon;
    IRenderComponent public immutable renderBody;
    IRenderComponent public immutable renderFore;

    // On-chain destroyed (explosion) and unconstructed art, each stored
    // pre-base64-encoded and split into ordered leaves to fit the 24KB cap
    // (scripts/renderer-pipeline/svg-to-leaves.js). Replaced the IPFS
    // DESTROYED_IMAGE and UNCONSTRUCTED_IMAGE 2026-10-16.
    IReturnSVG[] public destroyedParts;
    IReturnSVG[] public unconstructedParts;

    constructor(
        address _renderSpecial,
        address _renderAft,
        address _renderWeapon,
        address _renderBody,
        address _renderFore,
        address[] memory _destroyedParts,
        address[] memory _unconstructedParts
    ) {
        renderSpecial = IRenderComponent(_renderSpecial);
        renderAft = IRenderComponent(_renderAft);
        renderWeapon = IRenderComponent(_renderWeapon);
        renderBody = IRenderComponent(_renderBody);
        renderFore = IRenderComponent(_renderFore);
        for (uint i = 0; i < _destroyedParts.length; i++) {
            destroyedParts.push(IReturnSVG(_destroyedParts[i]));
        }
        for (uint i = 0; i < _unconstructedParts.length; i++) {
            unconstructedParts.push(IReturnSVG(_unconstructedParts[i]));
        }
    }

    function renderShip(Ship memory ship) public view override returns (string memory) {
        // Return appropriate image URI based on ship state
        if (ship.shipData.timestampDestroyed > 0) {
            return _renderParts(destroyedParts, ship);
        } else if (!ship.shipData.constructed) {
            return _renderParts(unconstructedParts, ship);
        }

        // For constructed and non-destroyed ships, render the SVG
        string memory svg = BASE_SVG;

        // Call each renderer in sequence from bottom to top
        svg = string.concat(svg, renderSpecial.render(ship)); // Special effects (bottom)
        svg = string.concat(svg, renderAft.render(ship)); // Aft section
        svg = string.concat(svg, renderWeapon.render(ship)); // Weapons
        svg = string.concat(svg, renderBody.render(ship)); // Body
        svg = string.concat(svg, renderFore.render(ship)); // Fore section (top)

        // Close the SVG
        svg = string.concat(svg, SVG_END);

        return _toDataUri(svg);
    }

    // Joins the leaves' base64 behind the data-URI prefix in one allocation.
    // Encoding on-chain (~78 gas/byte) or growing the string with repeated
    // string.concat (quadratic copying) pushed the largest image's tokenURI
    // read past common eth_call gas caps.
    function _renderParts(
        IReturnSVG[] storage parts,
        Ship memory ship
    ) private view returns (string memory) {
        bytes memory prefix = "data:image/svg+xml;base64,";
        string[] memory chunks = new string[](parts.length);
        uint total = prefix.length;
        for (uint i = 0; i < parts.length; i++) {
            chunks[i] = parts[i].render(ship);
            total += bytes(chunks[i]).length;
        }

        bytes memory out = new bytes(total);
        uint dest;
        assembly {
            dest := add(out, 32)
        }
        dest = _copy(dest, prefix);
        for (uint i = 0; i < chunks.length; i++) {
            dest = _copy(dest, bytes(chunks[i]));
        }
        return string(out);
    }

    // Copies src's bytes to dest; returns the position after them. Whole
    // words are copied, so up to 31 bytes past src's end get overwritten.
    // That's safe in _renderParts: a spill inside `out` is rewritten by the
    // next copy, and the last copy's spill lands in out's word padding or
    // unallocated memory (which Solidity never assumes is zeroed).
    function _copy(uint dest, bytes memory src) private pure returns (uint) {
        assembly {
            let len := mload(src)
            let s := add(src, 32)
            for {
                let i := 0
            } lt(i, len) {
                i := add(i, 32)
            } {
                mstore(add(dest, i), mload(add(s, i)))
            }
            dest := add(dest, len)
        }
        return dest;
    }

    function _toDataUri(string memory svg) private pure returns (string memory) {
        return
            string(abi.encodePacked("data:image/svg+xml;base64,", Base64.encode(bytes(svg))));
    }
}

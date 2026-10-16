// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "../Types.sol";
import "../IRenderer.sol";

contract RenderBody is IRenderComponent {
    // Base ship body SVG (used when no shields or armor)
    IReturnSVG public immutable renderBaseBody;
    IReturnSVG public immutable renderShield1; // Light Shield
    IReturnSVG public immutable renderShield2; // Medium Shield
    IReturnSVG public immutable renderShield3; // Heavy Shield
    IReturnSVG public immutable renderArmor1; // Light Armor
    IReturnSVG public immutable renderArmor2; // Medium Armor
    IReturnSVG public immutable renderArmor3; // Heavy Armor

    constructor(address[] memory renderers) {
        require(renderers.length == 7, "Invalid renderers array in RenderBody");
        renderBaseBody = IReturnSVG(renderers[0]);
        renderShield1 = IReturnSVG(renderers[1]);
        renderShield2 = IReturnSVG(renderers[2]);
        renderShield3 = IReturnSVG(renderers[3]);
        renderArmor1 = IReturnSVG(renderers[4]);
        renderArmor2 = IReturnSVG(renderers[5]);
        renderArmor3 = IReturnSVG(renderers[6]);
    }

    function render(
        Ship memory ship
    ) external view override returns (string memory) {
        // If both shields and armor are None, return base body
        if (
            ship.equipment.shields == Shields.None &&
            ship.equipment.armor == Armor.None
        ) {
            return renderBaseBody.render(ship);
        }

        // If shields are present, render shield
        if (ship.equipment.shields != Shields.None) {
            if (ship.equipment.shields == Shields.Light) {
                return renderShield1.render(ship);
            } else if (ship.equipment.shields == Shields.Medium) {
                return renderShield2.render(ship);
            } else if (ship.equipment.shields == Shields.Heavy) {
                return renderShield3.render(ship);
            }
        }

        // If armor is present, render armor
        if (ship.equipment.armor != Armor.None) {
            if (ship.equipment.armor == Armor.Light) {
                return renderArmor1.render(ship);
            } else if (ship.equipment.armor == Armor.Medium) {
                return renderArmor2.render(ship);
            } else if (ship.equipment.armor == Armor.Heavy) {
                return renderArmor3.render(ship);
            }
        }

        return renderBaseBody.render(ship);
    }
}

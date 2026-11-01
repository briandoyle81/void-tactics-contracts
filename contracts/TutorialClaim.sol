// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./ITutorialShips.sol";
import "./ITutorialGameResults.sol";
import "./IEligibilityProvider.sol";
import "./Types.sol";

contract TutorialClaim is Ownable, ReentrancyGuard {
    error TutorialAlreadyCompleted();
    error ZeroAddress();
    error NotEligible(address player);

    mapping(address => bool) public tutorialCompleted;

    ITutorialShips public immutable ships;
    ITutorialGameResults public immutable gameResults;

    // Same swappable-provider shape as FreeShipClaim.sol/Ships.sol's
    // IRandomManager: this contract doesn't know or care how eligibility is
    // established, only whether IEligibilityProvider says yes. Unset
    // (address(0), the default) means completing the tutorial stays fully
    // open — matches today's behavior exactly, no gating until the owner
    // deliberately wires a real provider (e.g. SelfieCheckEligibilityProvider.sol)
    // in. See docs/pre-audit.md's SC-01 addendum.
    IEligibilityProvider public eligibilityProvider;

    event TutorialCompleted(
        address indexed player,
        bool winPath,
        uint8 shipsCreated
    );
    event EligibilityProviderSet(address indexed provider);

    constructor(
        address _ships,
        address _gameResults
    ) Ownable(msg.sender) {
        if (_ships == address(0) || _gameResults == address(0))
            revert ZeroAddress();
        ships = ITutorialShips(_ships);
        gameResults = ITutorialGameResults(_gameResults);
    }

    function setEligibilityProvider(
        address _eligibilityProvider
    ) external onlyOwner {
        eligibilityProvider = IEligibilityProvider(_eligibilityProvider);
        emit EligibilityProviderSet(_eligibilityProvider);
    }

    function completeTutorialWinPath() external nonReentrant {
        _markTutorialCompleted(msg.sender);

        _createAndCustomizeShip(msg.sender, _buildVigilantTemplate(msg.sender));
        _createAndCustomizeShip(msg.sender, _buildSentinelTemplate(msg.sender));

        gameResults.addWin(msg.sender);

        emit TutorialCompleted(msg.sender, true, 2);
    }

    function completeTutorialLossPath() external nonReentrant {
        _markTutorialCompleted(msg.sender);

        _createAndCustomizeShip(msg.sender, _buildResoluteTemplate(msg.sender));
        _createAndCustomizeShip(msg.sender, _buildVigilantTemplate(msg.sender));
        _createAndCustomizeShip(msg.sender, _buildSentinelTemplate(msg.sender));

        gameResults.addLoss(msg.sender);

        emit TutorialCompleted(msg.sender, false, 3);
    }

    function _markTutorialCompleted(address player) internal {
        if (address(eligibilityProvider) != address(0)) {
            if (!eligibilityProvider.isEligible(player)) {
                revert NotEligible(player);
            }
        }
        if (tutorialCompleted[player]) revert TutorialAlreadyCompleted();
        tutorialCompleted[player] = true;
    }

    function _createAndCustomizeShip(
        address player,
        Ship memory template
    ) internal {
        ships.createSpecificShip(player, template);
    }

    function _buildResoluteTemplate(
        address owner
    ) internal pure returns (Ship memory s) {
        s.name = "Resolute";
        s.owner = owner;
        s.equipment = Equipment({
            mainWeapon: MainWeapon.Close,
            armor: Armor.None,
            shields: Shields.Medium,
            special: Special.Slot1
        });
        s.traits = Traits({
            serialNumber: 0,
            colors: Colors({
                h1: 200,
                s1: 80,
                l1: 50,
                h2: 220,
                s2: 70,
                l2: 40
            }),
            variant: 1,
            // Tier indices 0–2 for costs/attributes
            accuracy: 2,
            hull: 2,
            speed: 2
        });
        // Rank 2 starts at 10 kills under variant 1's rankThresholds as deployed
        // (see ShipAttributes.getRank(variant, kills)) — retuning them changes this.
        s.shipData.shipsDestroyed = 10;
        s.shipData.shiny = true;
        s.shipData.isFreeShip = true;
    }

    function _buildVigilantTemplate(
        address owner
    ) internal pure returns (Ship memory s) {
        s.name = "Vigilant";
        s.owner = owner;
        s.equipment = Equipment({
            mainWeapon: MainWeapon.Sniper,
            armor: Armor.None,
            shields: Shields.Light,
            special: Special.Slot2
        });
        s.traits = Traits({
            serialNumber: 0,
            colors: Colors({
                h1: 250,
                s1: 90,
                l1: 60,
                h2: 270,
                s2: 80,
                l2: 50
            }),
            variant: 1,
            accuracy: 1,
            hull: 0,
            speed: 0
        });
        s.shipData.isFreeShip = true;
    }

    function _buildSentinelTemplate(
        address owner
    ) internal pure returns (Ship memory s) {
        s.name = "Sentinel";
        s.owner = owner;
        s.equipment = Equipment({
            mainWeapon: MainWeapon.Generic,
            armor: Armor.Medium,
            shields: Shields.None,
            special: Special.None
        });
        s.traits = Traits({
            serialNumber: 0,
            colors: Colors({
                h1: 150,
                s1: 70,
                l1: 55,
                h2: 170,
                s2: 60,
                l2: 45
            }),
            variant: 1,
            accuracy: 1,
            hull: 0,
            speed: 0
        });
        s.shipData.isFreeShip = true;
    }
}

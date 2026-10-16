// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./IShips.sol";
import "./IDroneStorefront.sol";
import "./IEligibilityProvider.sol";

// Recurring free-ship claim, split out of Ships.sol entirely (which has
// almost no bytecode headroom left) and built on the same
// isAllowedToCreateShips "authorized minter" pattern DroneYard/ShipPurchaser/
// TutorialClaim already use — Ships.sol needed zero new logic beyond an
// _isFreeShip flag on its existing createShips (see Ships.sol/IShips.sol).
contract FreeShipClaim is Ownable, ReentrancyGuard {
    IShips public ships;
    address public droneStorefront;

    // Same swappable-provider shape as Ships.sol/Tournament.sol's
    // IRandomManager: this contract doesn't know or care how eligibility is
    // established, only whether IEligibilityProvider says yes. Unset
    // (address(0), the default) means claiming stays fully open — matches
    // today's behavior exactly, no gating until the owner deliberately wires
    // a real provider (e.g. SelfieCheckEligibilityProvider.sol) in. See
    // docs/pre-audit.md's SC-01 addendum.
    IEligibilityProvider public eligibilityProvider;

    mapping(address => uint256) public lastClaimTimestamp;

    // 4 weeks in seconds (28 days * 24 hours * 60 minutes * 60 seconds)
    uint256 public claimCooldownPeriod = 28 days;

    event FreeShipsClaimed(address indexed player, uint256 amount);
    event EligibilityProviderSet(address indexed provider);

    error ClaimCooldownNotPassed();
    error NotEligible(address player);

    constructor(address _ships) Ownable(msg.sender) {
        ships = IShips(_ships);
    }

    function setDroneStorefront(address _droneStorefront) external onlyOwner {
        droneStorefront = _droneStorefront;
    }

    function setClaimCooldownPeriod(
        uint256 _newCooldownPeriod
    ) external onlyOwner {
        claimCooldownPeriod = _newCooldownPeriod;
    }

    function setEligibilityProvider(
        address _eligibilityProvider
    ) external onlyOwner {
        eligibilityProvider = IEligibilityProvider(_eligibilityProvider);
        emit EligibilityProviderSet(_eligibilityProvider);
    }

    function claimFreeShips(uint16 _variant) external nonReentrant {
        if (address(eligibilityProvider) != address(0)) {
            if (!eligibilityProvider.isEligible(msg.sender)) {
                revert NotEligible(msg.sender);
            }
        }

        uint256 lastClaim = lastClaimTimestamp[msg.sender];
        uint256 currentTime = block.timestamp;

        // Note: When lastClaim == 0 (first claim), currentTime will always
        // be much larger than claimCooldownPeriod, so this won't revert for
        // new users.
        if (currentTime < lastClaim + claimCooldownPeriod) {
            revert ClaimCooldownNotPassed();
        }

        // Checks-effects-interactions: record the claim before minting
        // (see docs/pre-audit.md SP-01; matches TutorialClaim's pattern).
        // Ships now mints with _mint (no onERC721Received callback, see
        // docs/audit-3.md HA6-04), so there's no reentry path today; this
        // ordering and nonReentrant stay as defense in depth.
        lastClaimTimestamp[msg.sender] = currentTime;

        // 10 base ships, plus a permanent bonus (DroneStorefront's own tier
        // count) earned by turning in drone cores — 1 tier = +1 ship.
        uint256 bonus = droneStorefront == address(0)
            ? 0
            : IDroneStorefront(droneStorefront).droneCoreTier(msg.sender);

        uint256 amount = 10 + bonus;
        emit FreeShipsClaimed(msg.sender, amount);

        ships.createShips(msg.sender, amount, _variant, 0, true);
    }
}

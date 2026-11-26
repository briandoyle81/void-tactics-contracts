// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./IShips.sol";
import "./IDroneStorefront.sol";
import "./IEligibilityProvider.sol";

// Ships.sol's ownership index (its GR-01 pagination primitives). Kept out of
// IShips because ShipsRouter implements IShips and has no ownership index.
interface IShipsOwnership {
    function shipsOwnedCount(address _owner) external view returns (uint);

    function shipIdOwnedAt(
        address _owner,
        uint _index
    ) external view returns (uint);
}

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

    // Top-up floor (2026-11-19): topUpFreeShips fills a player back up to
    // this many ships that aren't destroyed, any time, with no cooldown.
    // 0 turns top-ups off. Why it's safe to leave open: any new address can
    // already claim 10 free ships immediately, so a top-up only spares a
    // player who has run out the choice between quitting and starting over
    // on a fresh account (losing their progress). What it does add is
    // re-rolling free ships on a progressed account (lose weak ships in an
    // easy fight, top up with fresh rolls); see
    // docs/frontend-handoff-free-ship-topup-2026-11-19.md.
    uint256 public topUpFloor = 10;

    event FreeShipsClaimed(address indexed player, uint256 amount);
    event FreeShipsToppedUp(address indexed player, uint256 amount);
    event EligibilityProviderSet(address indexed provider);
    event TopUpFloorSet(uint256 floor);

    error ClaimCooldownNotPassed();
    error NotEligible(address player);
    error NothingToTopUp(uint256 liveShips);

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

    function setTopUpFloor(uint256 _floor) external onlyOwner {
        topUpFloor = _floor;
        emit TopUpFloorSet(_floor);
    }

    function _requireEligible() private view {
        if (address(eligibilityProvider) != address(0)) {
            if (!eligibilityProvider.isEligible(msg.sender)) {
                revert NotEligible(msg.sender);
            }
        }
    }

    // Ships `_player` owns that aren't destroyed (in fleets and roguelike
    // runs included: they still exist), counted up to `_cap`. Destroyed ships
    // stay in the ownership index until recycled, and free ones can never be
    // recycled, so they have to be skipped. Walks newest first and stops at
    // `_cap`, so a hangar with 10 live ships among its newest costs ~10
    // reads; the walk only reaches old wrecks when the player is actually
    // short. The caller pays for its own walk; nobody else's call reads it.
    function liveShipCount(
        address _player,
        uint256 _cap
    ) public view returns (uint256 live) {
        IShipsOwnership index = IShipsOwnership(address(ships));
        uint256 i = index.shipsOwnedCount(_player);
        while (i > 0 && live < _cap) {
            unchecked {
                --i;
            }
            if (!ships.isShipDestroyed(index.shipIdOwnedAt(_player, i))) {
                ++live;
            }
        }
    }

    // Fills the caller back up to `topUpFloor` ships that aren't destroyed
    // with free ships of `_variant` (random rolls, exactly as a claim makes
    // them). Separate from the 28-day claim: doesn't need or reset its
    // cooldown, and gets no storefront-tier bonus (the claim keeps that).
    function topUpFreeShips(uint16 _variant) external nonReentrant {
        _requireEligible();
        uint256 floor = topUpFloor;
        uint256 live = liveShipCount(msg.sender, floor);
        if (live >= floor) {
            revert NothingToTopUp(live);
        }
        uint256 amount = floor - live;
        emit FreeShipsToppedUp(msg.sender, amount);
        ships.createShips(msg.sender, amount, _variant, 0, true);
    }

    function claimFreeShips(uint16 _variant) external nonReentrant {
        _requireEligible();

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

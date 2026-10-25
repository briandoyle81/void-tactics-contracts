// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./IShips.sol";
import "./IUniversalCredits.sol";

contract ShipPurchaser is Ownable, ReentrancyGuard {
    error InvalidPurchase(uint _tier, uint _amount);
    error ArrayLengthMismatch();
    error NotAuthorized(address);
    error InsufficientFunds(uint _required, uint _available);

    IShips public immutable ships;
    IERC20 public immutable universalCredits;
    IUniversalCredits public immutable universalCreditsMintable;

    // Static - Contract with the world
    // Hardcoded referral tiers (stages: 1000, 10000, 50000, 100000)
    // Percentages: 0%, 10%, 20%, 35%, 50%
    uint8[] public referralPercentages = [0, 10, 20, 35, 50];
    // Amount of Ships sold to reach each tier
    uint32[] public referralStages = [
        1000, // 1000 ships sold
        10000, // 10000 ships sold
        50000, // 50000 ships sold
        100000 // 100000 ships sold
    ];

    uint8[] public tierShips;
    // UTC prices, used by purchaseWithUTC.
    uint[] public tierPrices;
    // Native-token prices (ETH on Base), used by purchaseUTCWithFlow. Kept
    // separate from tierPrices on 2026-10-23: the two functions used to share
    // one array in different currencies, and the production deploy's ETH
    // prices (~0.002 per pack) made purchaseWithUTC sell 5 ships for ~0.002
    // UTC, which recycle for 0.5 UTC -- an unlimited UTC mint.
    uint[] public flowTierPrices;

    mapping(address => uint) public referralCount;
    mapping(address => bool) public isAllowedToCreateShips;

    constructor(address _ships, address _universalCredits) Ownable(msg.sender) {
        ships = IShips(_ships);
        universalCredits = IERC20(_universalCredits);
        universalCreditsMintable = IUniversalCredits(_universalCredits);

        tierShips = [5, 11, 22, 40, 60];
        // Using same tier structure but with UTC tokens instead of ether
        tierPrices = [
            4.99 ether, // 4.99 UTC
            9.99 ether, // 9.99 UTC
            19.99 ether, // 19.99 UTC
            34.99 ether, // 34.99 UTC
            49.99 ether // 49.99 UTC
        ];
        flowTierPrices = [
            4.99 ether,
            9.99 ether,
            19.99 ether,
            34.99 ether,
            49.99 ether
        ];
    }

    function purchaseWithUTC(
        address _to,
        uint8 _tier,
        address _referral,
        uint16 _variant
    ) public nonReentrant {
        uint totalShips = tierShips[_tier];
        uint price = tierPrices[_tier];

        // Check balance before attempting transfer
        uint balance = universalCredits.balanceOf(msg.sender);
        if (balance < price) {
            revert InsufficientFunds(price, balance);
        }

        // Transfer UTC tokens from buyer to this contract
        require(
            universalCredits.transferFrom(msg.sender, address(this), price),
            "UTC transfer failed"
        );

        // Create ships for the buyer
        ships.createShips(_to, totalShips, _variant, _tier, false);

        if (_referral != address(0)) {
            _processReferral(_referral, totalShips, price);
        }
    }

    /**
     * @dev Direct UTC Purchase - saves the trouble of buying a ship pack
     * and recycling it via Ships.shipBreaker.
     *
     * Mints the same UTC a player would net from buying that tier's ship
     * pack with FLOW and recycling every ship (tierShips[_tier] * recycleReward),
     * for the same FLOW cost - just skipping the extra steps.
     */
    function purchaseUTCWithFlow(
        address _to,
        uint _tier
    ) public payable nonReentrant {
        if (_tier >= flowTierPrices.length) {
            revert InvalidPurchase(_tier, msg.value);
        }

        uint price = flowTierPrices[_tier];
        if (msg.value != price) {
            revert InvalidPurchase(_tier, msg.value);
        }

        // Mint the UTC equivalent of buying + recycling this tier's ship pack
        uint mintAmount = tierShips[_tier] * ships.recycleReward();
        universalCreditsMintable.mint(_to, mintAmount);
    }

    function _processReferral(
        address _referrer,
        uint _shipsSold,
        uint _salePrice
    ) internal {
        referralCount[_referrer] += _shipsSold;

        uint referralPercentage = 0; // Default 0% for < 1000 ships

        for (uint i = referralStages.length; i > 0; i--) {
            if (referralCount[_referrer] >= referralStages[i - 1]) {
                referralPercentage = referralPercentages[i - 1];
                break;
            }
        }

        uint referralAmount = (_salePrice * referralPercentage) / 100;

        // Transfer UTC tokens to referrer
        require(
            universalCredits.transfer(_referrer, referralAmount),
            "Referral transfer failed"
        );
    }

    /**
     * @dev OWNER
     */

    function setPurchaseInfo(
        uint8[] memory _tierShips,
        uint[] memory _tierPrices
    ) public onlyOwner {
        if (_tierShips.length != _tierPrices.length) {
            revert ArrayLengthMismatch();
        }
        tierShips = _tierShips;
        tierPrices = _tierPrices;
    }

    function setFlowTierPrices(uint[] memory _flowTierPrices) public onlyOwner {
        if (_flowTierPrices.length != tierShips.length) {
            revert ArrayLengthMismatch();
        }
        flowTierPrices = _flowTierPrices;
    }

    function getFlowPurchaseInfo()
        external
        view
        returns (uint8[] memory, uint[] memory)
    {
        return (tierShips, flowTierPrices);
    }

    function getPurchaseInfo()
        external
        view
        returns (uint8[] memory, uint[] memory)
    {
        return (tierShips, tierPrices);
    }

    function withdrawUTC() public onlyOwner {
        uint balance = universalCredits.balanceOf(address(this));
        require(
            universalCredits.transfer(owner(), balance),
            "UTC withdrawal failed"
        );
    }

    // Burns UTC this contract is already holding (from purchaseWithUTC sales,
    // net of referral payouts) directly, as an alternative to withdrawUTC —
    // an on-chain-visible supply reduction instead of a claim about what
    // happened to withdrawn funds.
    function burnCollected(uint _amount) public onlyOwner {
        universalCreditsMintable.burn(_amount);
    }

    function withdrawFlow() public onlyOwner {
        (bool success, ) = payable(owner()).call{value: address(this).balance}(
            ""
        );
        require(success, "FLOW withdrawal failed");
    }
}

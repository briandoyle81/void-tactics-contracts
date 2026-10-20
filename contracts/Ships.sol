// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

// import "hardhat/console.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import "./Types.sol";
import "./IRenderer.sol";
import "./IRandomManager.sol";
import "./IGenerateNewShip.sol";
import "./IUniversalCredits.sol";
import "./IShipAttributes.sol";
import "./IDroneEnergyCores.sol";
import "./IVariantPurchaseGate.sol";

contract Ships is ERC721, Ownable, ReentrancyGuard {
    using EnumerableSet for EnumerableSet.UintSet;

    mapping(uint => Ship) public ships;
    uint public shipCount;

    mapping(address => EnumerableSet.UintSet) private shipsOwned;
    mapping(address => uint) public amountPurchased;

    mapping(address => uint) public referralCount;

    // Hardcoded referral tiers (saves bytecode size)
    // Stages: 100, 1000, 10000, 50000, 100000 ships sold
    // Percentages: 0%, 10%, 20%, 35%, 50%

    error NotAuthorized(address);
    error NotYourShip(uint);
    error ShipDestroyed();
    error MintPaused();
    error ShipConstructed(uint);
    error ShipInFleet(uint);
    error InsufficientPurchases(address);
    error InvalidPurchase(uint _tier, uint _amount);
    error ArrayLengthMismatch();
    error ShipAlreadyDestroyed(uint);
    error CannotRecycleFreeShip(uint);
    error InvalidVariant(uint16);
    error ReferralTransferFailed();
    error WithdrawalFailed();

    struct ContractConfig {
        address gameAddress;
        address lobbyAddress;
        address fleetsAddress;
        IRenderMetadata metadataRenderer;
        IRandomManager randomManager;
        IGenerateNewShip shipGenerator;
        IShipAttributes shipAttributes;
    }

    ContractConfig public config;

    uint8[] public tierShips;
    uint[] public tierPrices;

    bool public paused;

    uint16 public maxVariant = 1;

    event MetadataUpdate(uint256 _tokenId);
    // ERC-4906 batch form, emitted by setConfig for every token (0 to max, as
    // the EIP specifies for "all") so marketplaces re-fetch art after a
    // renderer swap, which goes through setConfig. A RenderMetadata name
    // change doesn't touch Ships, so to refresh after one, call setConfig
    // again with the current values. Emitted from setConfig rather than its
    // own function because a separate function put Ships over 24 KiB.
    // Added 2026-10-20.
    event BatchMetadataUpdate(uint256 _fromTokenId, uint256 _toTokenId);

    // ERC-5192 Minimal Soulbound extension (no extra storage required)
    // See: https://eips.ethereum.org/EIPS/eip-5192
    event Locked(uint256 tokenId);
    event Unlocked(uint256 tokenId);

    mapping(address => bool) public isAllowedToCreateShips;

    // TODO: Should variants have different weapons or props?

    IUniversalCredits public universalCredits;
    IDroneEnergyCores public droneEnergyCores;
    // Per-variant purchase gate registry (e.g. requiring the Shattered Hive
    // Campaign medal for variant 2) — see _mintShip/VariantPurchaseGate.sol.
    // Ships.sol deliberately knows nothing about which variants are gated or
    // on what; that's owner-configured entirely inside the gate contract, so
    // future gated variants need zero Ships.sol changes.
    address purchaseGate;
    uint public recycleReward = 0.1 ether; // 0.1 UC tokens

    // Only Owner TODO
    // Withdrawal

    constructor(
        address _renderer
    ) ERC721("Void Tactics Ships", "SHIP") Ownable(msg.sender) {
        config.metadataRenderer = IRenderMetadata(_renderer);

        // Variant 0 has no modifiers, already exists as zeroes

        tierShips = [5, 11, 22, 40, 60];
        //              0%, 10%, 15%, 20%, 25%
        tierPrices = [
            4.99 ether,
            9.99 ether,
            19.99 ether,
            34.99 ether,
            49.99 ether
        ];
    }

    /**
     * @dev PUBLIC
     */

    // For purchases with ERC20s such as Universal Credits
    // or anything else I think of

    function createShips(
        address _to,
        uint _amount,
        uint16 _variant,
        uint8 _tier,
        bool _isFreeShip
    ) external {
        if (!isAllowedToCreateShips[msg.sender]) {
            revert NotAuthorized(msg.sender);
        }

        uint8 tierRankCount = _tier + 1;
        for (uint i = 0; i < _amount; i++) {
            if (!_isFreeShip && i < tierRankCount) {
                uint8 rank = _tier + 1 - uint8(i);
                _mintShip(_to, _variant, _getKillsForRank(rank));
            } else {
                _mintShip(_to, _variant, 0);
            }
            if (_isFreeShip) {
                ships[shipCount].shipData.isFreeShip = true;
            }
        }

        // Free-ship claims don't count as purchases (referral/tier stats key
        // off actual paid volume).
        if (!_isFreeShip) {
            amountPurchased[_to] += _amount;
        }
    }

    function purchaseWithFlow(
        address _to,
        uint8 _tier,
        address _referral,
        uint16 _variant
    ) external payable nonReentrant {
        if (msg.value != tierPrices[_tier]) {
            revert InvalidPurchase(_tier, msg.value);
        }

        uint totalShips = tierShips[_tier];
        uint8 tierRankCount = _tier + 1;

        for (uint i = 0; i < totalShips; i++) {
            if (i < tierRankCount) {
                uint8 rank = uint8(_tier + 1 - i);
                _mintShip(_to, _variant, _getKillsForRank(rank));
            } else {
                _mintShip(_to, _variant, 0);
            }
        }

        if (_referral != address(0)) {
            _processReferral(_referral, totalShips, tierPrices[_tier]);
        }

        amountPurchased[_to] += totalShips;
    }

    function constructShips(uint[] calldata _ids) external {
        for (uint i = 0; i < _ids.length; i++) {
            constructShip(_ids[i]);
        }
    }

    function constructAllMyShips() external {
        uint[] memory ids = shipsOwned[msg.sender].values();
        for (uint i = 0; i < ids.length; i++) {
            if (!ships[ids[i]].shipData.constructed) {
                constructShip(ids[i]);
            }
        }
    }

    // Used for bonuses, special ships, events, etc. Overwrites _id's traits
    // regardless of current owner — no ownership check by design (matches
    // customizeShip's other authorized-caller-only callers). This makes any
    // "mint now, customize a predicted future id later" flow genuinely
    // exploitable: shipCount is public and sequential, so an outside
    // address could predict the target id and acquire it before the
    // customize call lands, diverting the special ship's value to itself.
    // Never build a feature that mints then customizes by id in a later,
    // separate call — use createSpecificShip below instead, which mints
    // and customizes atomically to a caller-specified recipient in one
    // transaction, closing that window entirely.
    function customizeShip(uint _id, Ship calldata _ship) external {
        if (!isAllowedToCreateShips[msg.sender]) {
            revert NotAuthorized(msg.sender);
        }

        Ship storage ship = ships[_id];
        _applyShipCustomization(ship, _id, _ship);
    }

    // Used for minting predefined/specific ships in one call for authorized callers.
    function createSpecificShip(
        address _to,
        Ship calldata _ship
    ) external returns (uint) {
        if (!isAllowedToCreateShips[msg.sender]) {
            revert NotAuthorized(msg.sender);
        }

        _mintShip(_to, _ship.traits.variant, 0);
        uint newShipId = shipCount;
        Ship storage ship = ships[newShipId];
        _applyShipCustomization(ship, newShipId, _ship);
        return newShipId;
    }

    function _applyShipCustomization(
        Ship storage ship,
        uint _id,
        Ship calldata _ship
    ) internal {
        emit MetadataUpdate(_id);

        if (ship.shipData.timestampDestroyed != 0) {
            revert ShipDestroyed();
        }

        if (ship.shipData.inFleet) {
            revert ShipInFleet(_id);
        }

        // Calculate modifications by comparing old and new
        uint16 amountModified = _calculateModifications(ship, _ship);

        // Update ship properties (preserve immutable traits like serialNumber)
        ship.name = _ship.name;
        ship.traits.accuracy = _ship.traits.accuracy;
        ship.traits.hull = _ship.traits.hull;
        ship.traits.speed = _ship.traits.speed;
        // NOTE: traits.variant is not bounds-checked against maxVariant here.
        // DroneYard.validateShip is currently the only caller-side enforcement
        // of that bound (variant == 0 or > maxVariant reverts there). Ships.sol
        // has almost no bytecode headroom left (see
        // docs/ShipsSizeOptimizationAnalysis.md for identified savings), so a
        // second check here was deliberately deferred. Any future
        // isAllowedToCreateShips-authorized caller that lets end users set
        // variant must enforce this bound itself until there's room to
        // centralize it.
        ship.traits.variant = _ship.traits.variant;
        ship.traits.colors = _ship.traits.colors;
        ship.equipment = _ship.equipment;
        // Allow authorized custom templates (e.g. tutorial ships) to define rank.
        ship.shipData.shipsDestroyed = _ship.shipData.shipsDestroyed;
        ship.shipData.isFreeShip = _ship.shipData.isFreeShip;

        ship.shipData.shiny = _ship.shipData.shiny;

        // Update modified amount (add to existing if constructed, set if not)
        if (ship.shipData.constructed) {
            ship.shipData.modified += amountModified;
        } else {
            ship.shipData.modified = amountModified;
            ship.shipData.constructed = true;
        }

        _setCostOfShip(_id);
    }

    function _calculateModifications(
        Ship storage _currentShip,
        Ship memory _newShip
    ) internal view returns (uint16) {
        uint16 modifications = 0;

        // Count equipment changes (add 1 for each changed property)
        if (
            _currentShip.equipment.mainWeapon != _newShip.equipment.mainWeapon
        ) {
            modifications++;
        }
        if (_currentShip.equipment.armor != _newShip.equipment.armor) {
            modifications++;
        }
        if (_currentShip.equipment.shields != _newShip.equipment.shields) {
            modifications++;
        }
        if (_currentShip.equipment.special != _newShip.equipment.special) {
            modifications++;
        }

        // Calculate trait changes (total absolute difference)
        uint8 accuracyDiff = _newShip.traits.accuracy >
            _currentShip.traits.accuracy
            ? _newShip.traits.accuracy - _currentShip.traits.accuracy
            : _currentShip.traits.accuracy - _newShip.traits.accuracy;
        uint8 hullDiff = _newShip.traits.hull > _currentShip.traits.hull
            ? _newShip.traits.hull - _currentShip.traits.hull
            : _currentShip.traits.hull - _newShip.traits.hull;
        uint8 speedDiff = _newShip.traits.speed > _currentShip.traits.speed
            ? _newShip.traits.speed - _currentShip.traits.speed
            : _currentShip.traits.speed - _newShip.traits.speed;

        modifications += accuracyDiff + hullDiff + speedDiff;

        // Count shiny status change as 3 modifications
        if (_currentShip.shipData.shiny != _newShip.shipData.shiny) {
            modifications += 3;
        }

        // Count variant change as 3 modifications, matching shiny's weight
        if (_currentShip.traits.variant != _newShip.traits.variant) {
            modifications += 3;
        }

        return modifications;
    }

    function constructShip(uint _id) public {
        emit MetadataUpdate(_id);

        Ship storage newShip = ships[_id];

        if (newShip.owner != msg.sender) {
            revert NotYourShip(_id);
        }

        if (newShip.shipData.constructed) {
            revert ShipConstructed(_id);
        }

        // Reveals (locks in, permanently) this ship's randomness on first
        // call if the commit-reveal entropy window has opened, then returns
        // it — no separate prior reveal transaction required. Reverts
        // TooSoonToReveal if called before block.prevrandao has actually
        // changed since the ship was minted (see RandomManager.sol's header
        // comment for why this must be a genuine change, not just a later
        // block number).
        uint64 randomBase = config.randomManager.fulfillRandomRequest(
            newShip.traits.serialNumber
        );

        Ship memory generatedShip = config.shipGenerator.generateShip(
            _id,
            newShip.traits.serialNumber,
            randomBase,
            newShip.traits.variant
        );

        // Copy generated ship data to storage
        // We already have variant, it was set at purchase
        // as was the serial number
        newShip.name = generatedShip.name;
        newShip.traits = generatedShip.traits;
        newShip.equipment = generatedShip.equipment;
        newShip.shipData.shiny = generatedShip.shipData.shiny;
        // Preserve existing kills if already set (tier-based purchases)
        if (newShip.shipData.shipsDestroyed == 0) {
            newShip.shipData.shipsDestroyed = generatedShip
                .shipData
                .shipsDestroyed;
        }
        newShip.shipData.constructed = true;
        // modified defaults to 0 (false) for regular construction

        _setCostOfShip(_id);
    }

    function setCostOfShip(uint _id) external {
        if (msg.sender != owner() && msg.sender != config.gameAddress) {
            revert NotAuthorized(msg.sender);
        }

        _setCostOfShip(_id);
    }

    /// @notice Permissionless: refresh cost and costsVersion for each id (minted ERC-721 tokens only; invalid ids corrupt storage).
    function syncShipCosts(uint[] calldata _ids) external {
        for (uint i; i < _ids.length; ++i) {
            _setCostOfShip(_ids[i]);
        }
    }

    function _setCostOfShip(uint _id) internal {
        Ship storage ship = ships[_id];
        if (ship.shipData.inFleet) {
            revert ShipInFleet(_id);
        }
        ship.shipData.costsVersion = config.shipAttributes.getCurrentCostsVersion(
            ship.traits.variant
        );
        ship.shipData.cost = config.shipAttributes.calculateShipCost(ship);
    }

    /**
     * @dev Lobby and GameFunctions
     */

    function setInFleet(uint _id, bool _inFleet) external {
        if (
            msg.sender != config.lobbyAddress &&
            msg.sender != config.gameAddress &&
            msg.sender != config.fleetsAddress
        ) {
            revert NotAuthorized(msg.sender);
        }
        // Only guard the "add to fleet" direction — removing a destroyed
        // ship from a fleet (e.g. during game cleanup) must still work.
        // Without this, a ship destroyed in one game can be resubmitted
        // into a fresh fleet for a new game (nothing else in the
        // createFleet path checks timestampDestroyed either) and fight
        // normally until anyone tries to remove it there, permanently
        // reverting ShipDestroyed() forever (see docs/audit-2.md HA2-03).
        if (_inFleet && ships[_id].shipData.timestampDestroyed != 0) {
            revert ShipDestroyed();
        }

        ships[_id].shipData.inFleet = _inFleet;

        // ERC-5192: Lock when added to fleet; unlock when removed (purely via events)
        if (_inFleet) emit Locked(_id);
        else emit Unlocked(_id);
    }

    /**
     * @dev INTERNAL
     */

    // Override erc721 update
    function _update(
        address to,
        uint256 tokenId,
        address auth
    ) internal override(ERC721) returns (address) {
        // Cache storage reference to avoid repeated SLOADs
        Ship storage ship = ships[tokenId];
        address oldOwner = ship.owner;

        // Skip destroyed check for burning (when to is address(0))
        if (to != address(0)) {
            if (ship.shipData.timestampDestroyed != 0) {
                revert ShipDestroyed();
            }
        }

        // Always check if ship is in fleet
        if (ship.shipData.inFleet) {
            revert ShipInFleet(tokenId);
        }

        // Skip transfer check for minting (when oldOwner is address(0))
        if (oldOwner != address(0)) {
            if (amountPurchased[oldOwner] < 10) {
                revert InsufficientPurchases(oldOwner);
            }
            if (to != address(0) && amountPurchased[to] < 10) {
                revert InsufficientPurchases(to);
            }
            // Handle ownership list
            shipsOwned[oldOwner].remove(tokenId);
        }

        // Only add to shipsOwned if not burning
        if (to != address(0)) {
            shipsOwned[to].add(tokenId);
            ship.owner = to;
        }

        // ERC-5192: if burning (to == address(0)) emit Locked for final state
        if (to == address(0)) emit Locked(tokenId);

        return super._update(to, tokenId, auth);
    }

    function _getKillsForRank(uint8 rank) internal pure returns (uint16) {
        if (rank >= 6) return 1000;
        if (rank == 5) return 300;
        if (rank == 4) return 100;
        if (rank == 3) return 30;
        if (rank == 2) return 10;
        return 1;
    }

    function _mintShip(
        address _to,
        uint16 _variant,
        uint16 _shipsDestroyed
    ) internal {
        if (paused) {
            revert MintPaused();
        }

        if (_variant > maxVariant || _variant == 0) {
            revert InvalidVariant(_variant);
        }
        if (purchaseGate != address(0)) {
            IVariantPurchaseGate(purchaseGate).checkGate(
                _variant,
                _to,
                msg.sender
            );
        }

        unchecked {
            shipCount++;
        }
        Ship storage newShip = ships[shipCount];
        newShip.id = shipCount;

        newShip.traits.serialNumber = config.randomManager.requestRandomness();
        newShip.traits.variant = _variant;
        if (_shipsDestroyed > 0) {
            newShip.shipData.shipsDestroyed = _shipsDestroyed;
        }

        // _mint, not _safeMint: no onERC721Received callback mid-mint, so a
        // recipient contract can't act before this function and its callers
        // (createShips' isFreeShip write, Game._endGame via ShipGrantWinEffect)
        // finish. Owner is set by _update (docs/audit-3.md HA6-04/HA6-11).
        _mint(_to, shipCount);

        // ERC-5192: Ships start unlocked (emit for indexers if desired)
        emit Unlocked(shipCount);
    }

    function _processReferral(
        address _referrer,
        uint _shipsSold,
        uint _salePrice
    ) internal {
        referralCount[_referrer] += _shipsSold;

        uint referralPercentage;
        uint totalSold = referralCount[_referrer];

        // Hardcoded referral tiers (stages: 100, 1000, 10000, 50000, 100000)
        // Percentages: 0%, 10%, 20%, 35%, 50%
        if (totalSold >= 100000) {
            referralPercentage = 50;
        } else if (totalSold >= 50000) {
            referralPercentage = 35;
        } else if (totalSold >= 10000) {
            referralPercentage = 20;
        } else if (totalSold >= 1000) {
            referralPercentage = 10;
        } else {
            referralPercentage = 0;
        }

        uint referralAmount = (_salePrice * referralPercentage) / 100;

        (bool success, ) = payable(_referrer).call{value: referralAmount}("");
        if (!success) revert ReferralTransferFailed();
    }

    /**
     * @dev OWNER
     */

    function setIsAllowedToCreateShips(
        address _address,
        bool _isAllowed
    ) public onlyOwner {
        isAllowedToCreateShips[_address] = _isAllowed;
    }

    // Decomposed from a single combined setTimestampDestroyed into two
    // primitives (this + recordKill) so ShipsRouter can orchestrate a kill
    // that spans this contract and AIShips.sol — the destroyed ship and the
    // destroyer ship no longer always live in the same contract's storage.
    // The DEC/UTC reward payout itself now lives entirely in ShipsRouter,
    // which is the only caller that can see both ships' owners regardless
    // of which contract holds them.
    function markDestroyed(uint _id) external returns (address ownerOut) {
        if (msg.sender != owner() && msg.sender != config.gameAddress) {
            revert NotAuthorized(msg.sender);
        }
        if (ships[_id].shipData.timestampDestroyed != 0) {
            revert ShipAlreadyDestroyed(_id);
        }
        ships[_id].shipData.timestampDestroyed = block.timestamp;

        // ERC-5192: Lock when destroyed
        emit Locked(_id);
        emit MetadataUpdate(_id);

        return ships[_id].owner;
    }

    function recordKill(uint _destroyerId) external returns (address ownerOut) {
        if (msg.sender != owner() && msg.sender != config.gameAddress) {
            revert NotAuthorized(msg.sender);
        }
        ships[_destroyerId].shipData.shipsDestroyed++;
        return ships[_destroyerId].owner;
    }

    function setPurchaseInfo(
        uint8[] calldata _tierShips,
        uint[] calldata _tierPrices
    ) external onlyOwner {
        if (_tierShips.length != _tierPrices.length) {
            revert ArrayLengthMismatch();
        }
        tierShips = _tierShips;
        tierPrices = _tierPrices;
    }

    function setConfig(
        address _gameAddress,
        address _lobbyAddress, // now SinglePlayerMatch's address — see DestroyRewardLib/ILobbiesOrchestratorCheck

        address _fleetsAddress,
        address _shipGenerator,
        address _randomManager,
        address _metadataRenderer,
        address _shipAttributes,
        address _universalCredits,
        address _droneEnergyCores,
        address _purchaseGate
    ) public onlyOwner {
        config.gameAddress = _gameAddress;
        config.lobbyAddress = _lobbyAddress;
        config.fleetsAddress = _fleetsAddress;
        config.shipGenerator = IGenerateNewShip(_shipGenerator);
        config.randomManager = IRandomManager(_randomManager);
        config.metadataRenderer = IRenderMetadata(_metadataRenderer);
        config.shipAttributes = IShipAttributes(_shipAttributes);
        universalCredits = IUniversalCredits(_universalCredits);
        droneEnergyCores = IDroneEnergyCores(_droneEnergyCores);
        purchaseGate = _purchaseGate;
        emit BatchMetadataUpdate(0, type(uint256).max);
    }

    function setPaused(bool _paused) external onlyOwner {
        paused = _paused;
    }

    function withdraw() external onlyOwner {
        (bool success, ) = payable(owner()).call{value: address(this).balance}(
            ""
        );
        if (!success) revert WithdrawalFailed();
    }

    function setMaxVariant(uint16 _maxVariant) external onlyOwner {
        maxVariant = _maxVariant;
    }

    function setRecycleReward(uint _newReward) external onlyOwner {
        recycleReward = _newReward;
    }

    // function setShipModified(uint _id, bool _modified) public onlyOwner {
    //     Ship storage ship = ships[_id];
    //     if (ship.id == 0) {
    //         revert InvalidId();
    //     }
    //     ship.shipData.modified = _modified;
    //     emit MetadataUpdate(_id);
    // }

    /**
     * @dev VIEW
     */

    function getShip(uint _id) external view returns (Ship memory) {
        return ships[_id];
    }

    // Used by game contract
    function isShipDestroyed(uint _id) external view returns (bool) {
        return ships[_id].shipData.timestampDestroyed != 0;
    }

    // ERC-5192: minimal interface view - derived from existing state
    // Not used by Opensea and other marketplaces, I don't think it's necessary to keep it.
    // function locked(uint256 tokenId) external view returns (bool) {
    //     Ship storage s = ships[tokenId];
    //     if (s.shipData.timestampDestroyed != 0) return true;
    //     return s.shipData.inFleet;
    // }

    function getPurchaseInfo()
        external
        view
        returns (uint8[] memory _tierShips, uint[] memory _tierPrices)
    {
        return (tierShips, tierPrices);
    }

    function tokenURI(uint _id) public view override returns (string memory) {
        return config.metadataRenderer.tokenURI(ships[_id]);
    }

    function getShipIdsOwned(
        address _owner
    ) external view returns (uint[] memory) {
        return shipsOwned[_owner].values();
    }

    // GR-01 pagination escape hatch (see docs/pre-audit.md) for owners with
    // too many ships for getShipIdsOwned's full-array return to fit in an
    // RPC provider's eth_call response/gas cap. Deliberately the two
    // smallest possible primitives (count + index) rather than a single
    // paginated-array function, to minimize bytecode in this
    // already-near-the-limit contract — a caller pages by calling
    // shipIdOwnedAt in a loop (or a JSON-RPC batch request) from _offset to
    // min(_offset + _limit, shipsOwnedCount(_owner)) itself.
    function shipsOwnedCount(address _owner) external view returns (uint) {
        return shipsOwned[_owner].length();
    }

    function shipIdOwnedAt(
        address _owner,
        uint _index
    ) external view returns (uint) {
        return shipsOwned[_owner].at(_index);
    }

    function getShipsByIds(
        uint[] calldata _ids
    ) external view returns (Ship[] memory) {
        Ship[] memory shipsFetched = new Ship[](_ids.length);
        for (uint i = 0; i < _ids.length; i++) {
            shipsFetched[i] = ships[_ids[i]];
        }
        return shipsFetched;
    }

    function shipBreaker(uint[] calldata _shipIds) external nonReentrant {
        uint totalReward = 0;

        for (uint i = 0; i < _shipIds.length; i++) {
            uint shipId = _shipIds[i];

            // Cache storage reference to avoid repeated SLOADs
            Ship storage s = ships[shipId];

            // Check if caller owns the ship
            // TODO: I'm 85% sure this is redundant.
            if (s.owner != msg.sender) {
                revert NotYourShip(shipId);
            }

            // Ships in a fleet must not be destroyed: _update's inFleet check would
            // revert the _burn call below anyway, but only after timestampDestroyed
            // has already been written — checking here keeps that write from ever
            // happening instead of relying on the burn's revert to undo it.
            if (s.shipData.inFleet) {
                revert ShipInFleet(shipId);
            }

            // Prevent recycling of free ships
            if (s.shipData.isFreeShip) {
                revert CannotRecycleFreeShip(shipId);
            }

            // Determine recycle reward based on destruction state PRIOR to this call
            bool wasDestroyed = s.shipData.timestampDestroyed != 0;
            uint rewardForThisShip = wasDestroyed
                ? (recycleReward >> 1) // Division by 2
                : recycleReward;

            // Mark ship as destroyed and burn it
            s.shipData.timestampDestroyed = block.timestamp;
            emit Locked(shipId);
            _burn(shipId);

            // Add to total reward
            totalReward += rewardForThisShip;
        }

        // Mint reward tokens to the owner
        if (totalReward > 0) {
            universalCredits.mint(msg.sender, totalReward);
        }
    }
}

// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/access/Ownable.sol";
import "./Types.sol";
import "./IShips.sol";
import "./IAIShips.sol";
import "./Ships.sol";
import "./IUniversalCredits.sol";
import "./IFactionRewardTokenRegistry.sol";
import "./DestroyRewardLib.sol";

// Facade Game.sol/Fleets.sol/ShipAttributes.sol call instead of Ships.sol
// directly, so a single shipId space can resolve against two different
// backing stores: Ships.sol (real ERC-721 human ships) and AIShips.sol
// (pooled, non-NFT AI ships). Dispatch is purely numeric — any id at or
// above AI_SHIP_ID_OFFSET belongs to AIShips.sol, everything below belongs
// to Ships.sol — so Game.sol needs no source changes at all, only a
// constructor argument pointed here instead of at Ships.sol.
//
// setTimestampDestroyed is the one function that needs real orchestration:
// Ships.sol used to mark the destroyed ship, credit the destroyer, and pay
// the DEC/UTC reward all by indexing into its own storage for both ships.
// Once AI ships can live in a different contract than their destroyer (or
// vice versa), that combined logic has to live here instead, uniformly for
// both the pure-PvP case (both ids human) and the cross-contract case.
contract ShipsRouter is IShips, Ownable {
    // Read from AIShips at construction rather than redeclared here, so
    // there's exactly one source of truth for this value — see IAIShips's
    // comment on why a second hardcoded copy is a drift hazard.
    uint public immutable AI_SHIP_ID_OFFSET;

    Ships public ships; // human ships (real ERC-721)
    IAIShips public aiShips; // pooled AI ships (no ERC-721)
    IUniversalCredits public universalCredits;
    IFactionRewardTokenRegistry public factionRewardTokenRegistry;

    // Game instances allowed to call setTimestampDestroyed (report a ship
    // destroyed). Was a single `gameAddress` until 2026-09-28 — widened to
    // an allowlist so more than one Game "engine" instance can be trusted
    // at once, the same way Fleets.isAllowedToManageFleets already is. See
    // the engine-registry plan.
    mapping(address => bool) public isAllowedGame;
    address public fleetsAddress;
    address public lobbyAddress; // SinglePlayerMatch — see DestroyRewardLib

    error NotAuthorized(address);
    error NotSupported();

    constructor(
        address _ships,
        address _aiShips,
        address _universalCredits,
        address _factionRewardTokenRegistry
    ) Ownable(msg.sender) {
        ships = Ships(_ships);
        aiShips = IAIShips(_aiShips);
        universalCredits = IUniversalCredits(_universalCredits);
        factionRewardTokenRegistry = IFactionRewardTokenRegistry(
            _factionRewardTokenRegistry
        );
        AI_SHIP_ID_OFFSET = aiShips.AI_SHIP_ID_OFFSET();
    }

    function setIsAllowedGame(address _game, bool _allowed) external onlyOwner {
        isAllowedGame[_game] = _allowed;
    }

    function setFleetsAddress(address _fleetsAddress) external onlyOwner {
        fleetsAddress = _fleetsAddress;
    }

    function setLobbyAddress(address _lobbyAddress) external onlyOwner {
        lobbyAddress = _lobbyAddress;
    }

    function _isAI(uint _id) internal view returns (bool) {
        return _id >= AI_SHIP_ID_OFFSET;
    }

    // public (not external) so setTimestampDestroyed below can call it
    // directly as an internal dispatch instead of paying for an external
    // CALL to itself — external callers are unaffected, IShips only
    // requires this to be at least externally visible.
    function getShip(uint _id) public view returns (Ship memory) {
        return _isAI(_id) ? aiShips.getShip(_id) : ships.getShip(_id);
    }

    function isShipDestroyed(uint _id) external view returns (bool) {
        return _isAI(_id) ? aiShips.isShipDestroyed(_id) : ships.isShipDestroyed(_id);
    }

    // Ships.sol/AIShips.sol both whitelist this router as a caller, so this
    // router must enforce the same caller check Ships.sol used to apply
    // directly — otherwise any account could call through the router and
    // silently unlock/lock a ship it doesn't control, since the backing
    // contracts see the trusted router as msg.sender regardless of who
    // called the router itself.
    function setInFleet(uint _id, bool _inFleet) external {
        if (msg.sender != owner() && msg.sender != fleetsAddress) {
            revert NotAuthorized(msg.sender);
        }
        if (_isAI(_id)) {
            aiShips.setInFleet(_id, _inFleet);
        } else {
            ships.setInFleet(_id, _inFleet);
        }
    }

    function setTimestampDestroyed(uint _id, uint _destroyerId) external {
        if (msg.sender != owner() && !isAllowedGame[msg.sender]) {
            revert NotAuthorized(msg.sender);
        }

        Ship memory destroyed = getShip(_id);

        address destroyedOwner = _isAI(_id)
            ? aiShips.markDestroyed(_id)
            : ships.markDestroyed(_id);

        // docs/audit-3.md HA6-16: only a PvP kill (no AI ship on either
        // side) of a non-free ship counts toward the destroyer's kill count
        // (= rank). PvE kills and free-ship kills only look up the owner.
        bool freeVictim = destroyed.shipData.isFreeShip;
        address destroyerOwner;
        if (_isAI(_id) || _isAI(_destroyerId) || freeVictim) {
            destroyerOwner = getShip(_destroyerId).owner;
        } else {
            destroyerOwner = ships.recordKill(_destroyerId);
        }

        // No reward for destroying a free ship (HA6-16: free ships pay no
        // UTC), and none when an AI ship is the destroyer — its owner is an
        // orchestrator contract, so the UTC was minted to a contract that
        // can't use it (HA6-21).
        if (
            destroyerOwner != address(0) &&
            !freeVictim &&
            !_isAI(_destroyerId)
        ) {
            DestroyRewardLib.payDestroyReward(
                lobbyAddress,
                destroyedOwner,
                destroyerOwner,
                ships.recycleReward() >> 2, // Division by 4
                destroyed.traits.variant,
                universalCredits,
                factionRewardTokenRegistry
            );
        }
    }

    // The three functions below exist purely so this contract satisfies the
    // IShips interface Game.sol's constructor expects — nothing legitimately
    // calls them through this router (DroneYard/ShipPurchaser/TutorialClaim/
    // FreeShipClaim all stay wired directly to Ships.sol). Unlike
    // setInFleet/setTimestampDestroyed above, they deliberately do NOT
    // forward to Ships.sol at all, not even behind a caller check: Ships.sol
    // only gates createShips/createSpecificShip/customizeShip on
    // isAllowedToCreateShips[msg.sender], and from Ships.sol's perspective
    // msg.sender would be this router regardless of who called the router
    // itself. If this router were ever added to that allowlist for a
    // legitimate reason, a forwarding version of these functions — even a
    // "correctly" caller-checked one — would still be a live, unlimited,
    // free ship-minting/customization backdoor for anyone the moment that
    // allowlist entry existed (see docs/pre-audit.md HA-01). Reverting
    // unconditionally closes that off regardless of future allowlist
    // changes, since satisfying IShips only requires these to exist with
    // the right signature, not to do anything.
    function createShips(
        address /* _to */,
        uint /* _amount */,
        uint16 /* _variant */,
        uint8 /* _tier */,
        bool /* _isFreeShip */
    ) external pure {
        revert NotSupported();
    }

    function createSpecificShip(
        address /* _to */,
        Ship calldata /* _ship */
    ) external pure returns (uint) {
        revert NotSupported();
    }

    function customizeShip(uint /* _id */, Ship memory /* _ship */) external pure {
        revert NotSupported();
    }

    function maxVariant() external view returns (uint16) {
        return ships.maxVariant();
    }

    function recycleReward() external view returns (uint) {
        return ships.recycleReward();
    }
}

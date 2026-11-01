// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/access/Ownable.sol";
import "./Types.sol";
import "./IAIShips.sol";

// Non-NFT store for single-player AI ships, sitting behind ShipsRouter.
// AI ships are never owned or traded by players, so there's no ERC-721
// here — just Ship structs keyed by id, backed by a self-expanding
// free-list pool instead of minting a fresh token every match: allocateShip
// reuses a released slot when one is available (growing slotCount only when
// the pool is empty), and releaseShips returns a game's full AI roster to
// the pool once, at game end (see SinglePlayerMatch.onGameEnded) — never
// per-ship-destroyed mid-match, so a slot is never touched while its game
// is still resolving.
//
// Ids are offset into a range disjoint from Ships.sol's own id space so
// ShipsRouter can tell, from the numeric id alone, which backing contract
// to call. 2**40 (~1.1T) is comfortably past any realistic Ships.sol
// token-id count while staying ~8,192x under Number.MAX_SAFE_INTEGER
// (2**53-1) — frontend code that treats ids as JS numbers (rather than
// bigint) needs this to stay exact; a symbolic value like 2**128 (this
// used before) silently breaks that.
contract AIShips is Ownable, IAIShips {
    uint public constant AI_SHIP_ID_OFFSET = 2 ** 40;

    mapping(uint => Ship) private ships; // keyed by LOCAL id, 1-indexed
    uint public slotCount;
    // The free list is freeSlots[0 .. freeSlotCount). The array never
    // shrinks (2026-10-31): entries past freeSlotCount are stale and get
    // overwritten by the next release. Popping zeroed each entry, so every
    // release paid a ~20k first write per ship to refill it.
    uint[] public freeSlots;
    uint public freeSlotCount;
    // HA3-04: per-slot free/in-use tracking, keyed by LOCAL id, as a bitmap
    // (bit localId % 256 of word localId / 256). Set only while a slot sits
    // in the free list. Lets releaseShips detect (and skip, not corrupt
    // state over) a redundant release instead of duplicating a slot in the
    // free list, which would let allocateShip hand the same globalId out
    // twice. Not currently reachable (Game._endGame's single-invocation
    // guard — see pre-audit.md L-08 — means onGameEnded, the only caller of
    // releaseShips, can't fire twice for one game), but defense-in-depth
    // per this project's "assume hostile/buggy callers" standing rule.
    // Bit 0 of word 0 (local id 0, never used) stays set from construction,
    // so emptying the free list never zeroes that word and the next
    // release doesn't pay a first write for it.
    mapping(uint => uint256) private freeSlotBits;

    address public router;
    mapping(address => bool) public isAllowedToCreateShips;

    error NotAuthorized(address);

    constructor() Ownable(msg.sender) {
        freeSlotBits[0] = 1;
    }

    function setRouter(address _router) external onlyOwner {
        router = _router;
    }

    function setIsAllowedToCreateShips(
        address _address,
        bool _isAllowed
    ) external onlyOwner {
        isAllowedToCreateShips[_address] = _isAllowed;
    }

    function allocateShip(
        address _to,
        Ship calldata _template
    ) external returns (uint globalId) {
        if (!isAllowedToCreateShips[msg.sender]) revert NotAuthorized(msg.sender);

        uint localId;
        uint freeCount = freeSlotCount;
        if (freeCount > 0) {
            localId = freeSlots[freeCount - 1];
            freeSlotCount = freeCount - 1;
            freeSlotBits[localId >> 8] &= ~(uint256(1) << (localId & 255));
        } else {
            slotCount++;
            localId = slotCount;
        }
        globalId = localId + AI_SHIP_ID_OFFSET;

        // Every field is overwritten unconditionally so a reused slot is
        // indistinguishable from a fresh one — a previous occupant's kill
        // count or destroyed flag must never leak into the next allocation
        // (ShipAttributes derives a rank bonus from shipsDestroyed).
        Ship storage ship = ships[localId];
        ship.name = _template.name;
        ship.id = globalId;
        ship.equipment = _template.equipment;
        ship.traits = _template.traits;
        ship.traits.serialNumber = 0; // AI ships never go through constructShip
        ship.owner = _to;

        ship.shipData.shipsDestroyed = 0;
        ship.shipData.modified = 0; // never customized via DroneYard
        ship.shipData.shiny = false;
        ship.shipData.constructed = true;
        ship.shipData.inFleet = false;
        ship.shipData.isFreeShip = false;
        ship.shipData.timestampDestroyed = 0;
        // AI ships aren't priced (2026-10-30): AI fleets have no cost cap
        // and Fleets skips the costs-version check for them, so the two
        // ShipAttributes calls this used to make were wasted gas. Zeroed so
        // a reused slot never shows an earlier occupant's price.
        ship.shipData.costsVersion = 0;
        ship.shipData.cost = 0;
    }

    function releaseShips(uint[] calldata _shipIds) external {
        if (!isAllowedToCreateShips[msg.sender]) revert NotAuthorized(msg.sender);
        uint freeCount = freeSlotCount;
        uint stored = freeSlots.length;
        for (uint i = 0; i < _shipIds.length; i++) {
            uint localId = _shipIds[i] - AI_SHIP_ID_OFFSET;
            uint256 bit = uint256(1) << (localId & 255);
            uint256 word = freeSlotBits[localId >> 8];
            // Skip (don't revert the whole batch over) an already-free
            // slot — same griefing-resistant reasoning as
            // RandomManager.revealRandomnessBatch and Fleets.clearFleet's
            // idempotent-redundant-call handling elsewhere in this repo.
            if (word & bit != 0) continue;
            freeSlotBits[localId >> 8] = word | bit;
            if (freeCount < stored) {
                freeSlots[freeCount] = localId;
            } else {
                freeSlots.push(localId);
                stored++;
            }
            freeCount++;
        }
        freeSlotCount = freeCount;
    }

    function getShip(uint _id) external view returns (Ship memory) {
        return ships[_id - AI_SHIP_ID_OFFSET];
    }

    function getShipStatsInput(
        uint _id
    ) external view returns (ShipStatsInput memory) {
        Ship storage s = ships[_id - AI_SHIP_ID_OFFSET];
        return
            ShipStatsInput(
                s.id,
                s.equipment,
                s.traits.variant,
                s.traits.accuracy,
                s.traits.hull,
                s.traits.speed,
                s.shipData.shipsDestroyed
            );
    }

    function isShipDestroyed(uint _id) external view returns (bool) {
        return ships[_id - AI_SHIP_ID_OFFSET].shipData.timestampDestroyed != 0;
    }

    function markDestroyed(uint _id) external returns (address ownerOut) {
        if (msg.sender != router) revert NotAuthorized(msg.sender);
        Ship storage ship = ships[_id - AI_SHIP_ID_OFFSET];
        ship.shipData.timestampDestroyed = block.timestamp;
        return ship.owner;
    }

    function recordKill(uint _destroyerId) external returns (address ownerOut) {
        if (msg.sender != router) revert NotAuthorized(msg.sender);
        Ship storage ship = ships[_destroyerId - AI_SHIP_ID_OFFSET];
        ship.shipData.shipsDestroyed++;
        return ship.owner;
    }

    function setInFleet(uint _id, bool _inFleet) external {
        if (msg.sender != router) revert NotAuthorized(msg.sender);
        ships[_id - AI_SHIP_ID_OFFSET].shipData.inFleet = _inFleet;
    }
}

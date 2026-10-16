// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/access/Ownable.sol";
import "./BlockHashLib.sol";

// Block-hash randomness (docs/audit-3.md HA6-19, 2026-10-15). A request's
// result is keccak256(blockhash(target block), requestId), where the target
// block is the block the request was made in. Nobody can know that block's
// hash while the request is being made, and once the block is sealed the
// result is fixed — so WHEN it's revealed, and by WHOM, can't change it.
//
// This replaces the earlier caller-timed prevrandao reveal, where the first
// reveal locked in whatever the current ~12s epoch produced. Since that
// value was public, the revealer could preview every epoch and pick one:
// owners could re-roll their own ships for free (a rank-4+ ship in ~4
// minutes on average), and — because reveal was permissionless — anyone
// could lock in the WORST epoch for someone else's ship.
//
// Revealing (capturing the hash) stays permissionless: it can't influence
// anything, only record the already-fixed value. fulfillRandomRequest —
// what Ships.constructShip and Tournament.buildBracket call — captures it on
// first use. requestId is mixed in so ships minted in the same block (one
// pack) still get independent randomness.
//
// The target hash stays readable for 8191 blocks (~4.5 hours on Base) via
// the EIP-2935 history contract, or 256 (~8.5 minutes) on a chain without
// a working one (BlockHashLib, 2026-10-16).
// A request nobody revealed in time is EXPIRED: it reverts RequestExpired
// until the owner re-targets it via retargetExpired, which points it at the
// block of the owner's own transaction — a hash the owner can't know in
// advance either, so re-targeting can't pick an outcome. Players are
// expected to construct promptly after minting (the frontend does it right
// away); anything that misses the window waits for an admin batch.
//
// Residual trust: Base's sequencer builds the target block and could in
// theory reorder transactions to influence its hash. A re-target is also a
// fresh roll, so the owner is trusted not to re-target the same request
// repeatedly hoping for a better one (only expired requests can be
// re-targeted, so each try costs a full window of waiting). A real VRF (e.g.
// Chainlink VRF) is the only way to remove these.
contract RandomManager is Ownable {
    struct Request {
        uint blockNumber; // target block whose hash seeds the result
        bool revealed;
        uint64 result;
    }

    uint public requestCount;
    // Public so a read-only caller (frontend, test) can inspect a captured
    // result (.result, .revealed) without a state-changing call — the same
    // data is also emitted via RandomnessRevealed.
    mapping(uint => Request) public requests;

    error RequestNotFound();
    error TooSoonToReveal();
    error RequestExpired(uint requestId);

    event RandomnessRequested(uint indexed requestId, uint blockNumber);
    event RandomnessRevealed(uint indexed requestId, uint64 result);
    event RandomnessRetargeted(uint indexed requestId, uint blockNumber);

    constructor() Ownable(msg.sender) {}

    function requestRandomness() external returns (uint requestId) {
        requestCount++;
        requestId = requestCount;
        requests[requestId].blockNumber = block.number;
        emit RandomnessRequested(requestId, block.number);
    }

    // Consumer entry point (Ships.constructShip, Tournament.buildBracket):
    // captures on first call, then returns the stored result.
    function fulfillRandomRequest(uint _requestId) external returns (uint64) {
        return _revealOrGet(_requestId);
    }

    // Permissionless capture. Harmless to call at any time: the result is
    // fixed by the target block, not by when or by whom this is called.
    function revealRandomness(uint _requestId) external returns (uint64) {
        return _revealOrGet(_requestId);
    }

    // Batch form of revealRandomness. An already-revealed id is skipped
    // rather than reverting the whole batch, so a third party revealing one
    // id ahead of the batch can't make it fail (CLAUDE.md "Assume Hostile
    // Outside Actors"). TooSoonToReveal/RequestExpired still revert the
    // batch: they depend only on the ids and the current block, not on
    // anything a third party can trigger against this caller.
    function revealRandomnessBatch(
        uint[] calldata _requestIds
    ) external returns (uint64[] memory results) {
        results = new uint64[](_requestIds.length);
        for (uint i = 0; i < _requestIds.length; i++) {
            results[i] = _revealOrGet(_requestIds[i]);
        }
    }

    // Owner backup for requests that missed the blockhash window, done in
    // batches whenever convenient. Each expired, unrevealed id is pointed at
    // the current block (whose hash the owner can't know yet); anything
    // else — revealed, unknown, or still inside its window — is skipped, so
    // a still-valid request can never be re-rolled this way.
    function retargetExpired(uint[] calldata _requestIds) external onlyOwner {
        for (uint i = 0; i < _requestIds.length; i++) {
            uint requestId = _requestIds[i];
            if (requestId == 0 || requestId > requestCount) continue;
            Request storage request = requests[requestId];
            if (request.revealed || !_isExpired(request)) continue;
            request.blockNumber = block.number;
            emit RandomnessRetargeted(requestId, block.number);
        }
    }

    function _revealOrGet(uint _requestId) internal returns (uint64) {
        if (_requestId == 0 || _requestId > requestCount) revert RequestNotFound();
        Request storage request = requests[_requestId];
        if (request.revealed) return request.result;
        // The target block's hash isn't available until a later block.
        if (block.number <= request.blockNumber) revert TooSoonToReveal();
        bytes32 targetHash = BlockHashLib.get(request.blockNumber);
        if (targetHash == bytes32(0)) revert RequestExpired(_requestId);

        uint64 result = uint64(
            uint(keccak256(abi.encodePacked(targetHash, _requestId)))
        );
        request.revealed = true;
        request.result = result;
        emit RandomnessRevealed(_requestId, result);
        return result;
    }

    // Expired = the target block is sealed but its hash can no longer be
    // read. Defined by the same lookup _revealOrGet uses, so the two always
    // agree, whatever window the chain actually provides.
    function _isExpired(Request storage _request) internal view returns (bool) {
        return
            block.number > _request.blockNumber &&
            BlockHashLib.get(_request.blockNumber) == bytes32(0);
    }

    // True if fulfillRandomRequest would currently succeed: already
    // revealed, or the target block is sealed and still inside the window.
    function canFulfill(uint _requestId) external view returns (bool) {
        return _canFulfill(_requestId);
    }

    function canFulfillBatch(
        uint[] calldata _requestIds
    ) external view returns (bool) {
        for (uint i = 0; i < _requestIds.length; i++) {
            if (!_canFulfill(_requestIds[i])) return false;
        }
        return true;
    }

    // Same as canFulfillBatch — kept under its existing name for callers
    // that poll it before revealRandomnessBatch.
    function canRevealBatch(
        uint[] calldata _requestIds
    ) external view returns (bool) {
        for (uint i = 0; i < _requestIds.length; i++) {
            if (!_canFulfill(_requestIds[i])) return false;
        }
        return true;
    }

    // True for a valid, unrevealed request whose window has passed — what
    // needs an owner retargetExpired before it can ever be fulfilled.
    function isExpired(uint _requestId) external view returns (bool) {
        if (_requestId == 0 || _requestId > requestCount) return false;
        Request storage request = requests[_requestId];
        return !request.revealed && _isExpired(request);
    }

    function _canFulfill(uint _requestId) internal view returns (bool) {
        if (_requestId == 0 || _requestId > requestCount) return false;
        Request storage request = requests[_requestId];
        if (request.revealed) return true;
        return block.number > request.blockNumber && !_isExpired(request);
    }
}

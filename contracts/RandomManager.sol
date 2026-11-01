// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

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
// a working one (BlockHashLib, 2026-10-16). Nothing can re-roll a request
// (docs/trustless-randomness-plan-2026-11-01.md, audit-4 HA7-10): the
// owner retarget is gone, and with it this contract's owner. Instead:
//   - Every call here stores the hash of the oldest pending request blocks
//     once they're sealed (_capture), so ordinary activity by anyone —
//     mints, constructs, reveals, tournaments, lottery swaps via
//     capturePending — fixes a request's result before its window closes,
//     whether or not its owner ever reveals it.
//   - A request nothing captured in time stays EXPIRED for good. Ships
//     builds such a ship as a fixed baseline that's never better than a
//     real roll (GenerateNewShip.generateBaselineShip), so letting a bad
//     roll expire never pays; Tournament gets a fresh request through its
//     own permissionless rerollBracketShuffle.
//
// Residual trust: Base's sequencer builds the target block and could in
// theory reorder transactions to influence its hash. A real VRF (e.g.
// Chainlink VRF) is the only way to remove that.
contract RandomManager {
    struct Request {
        uint blockNumber; // target block whose hash seeds the result
        bool revealed;
        uint64 result;
    }

    // Pending blocks walked per call (plan decision D3): keeps up with
    // steady activity (each call queues at most one block) and drains a
    // backlog over a few calls.
    uint public constant CAPTURE_PER_CALL = 2;

    uint public requestCount;
    // Public so a read-only caller (frontend, test) can inspect a captured
    // result (.result, .revealed) without a state-changing call — the same
    // data is also emitted via RandomnessRevealed.
    mapping(uint => Request) public requests;

    // A target block's hash, stored by _capture while it was still
    // readable. Zero = not stored (yet, or ever).
    mapping(uint => bytes32) public blockSeed;
    // FIFO of blocks with requests, oldest first; pendingHead is the next
    // one to capture. A pack of requests in one block queues it once.
    uint64[] public pendingBlocks;
    uint public pendingHead;
    uint private lastRequestBlock;

    error RequestNotFound();
    error TooSoonToReveal();
    error RequestExpired(uint requestId);

    event RandomnessRequested(uint indexed requestId, uint blockNumber);
    event RandomnessRevealed(uint indexed requestId, uint64 result);

    function requestRandomness() external returns (uint requestId) {
        _capture(CAPTURE_PER_CALL);
        requestCount++;
        requestId = requestCount;
        requests[requestId].blockNumber = block.number;
        if (block.number != lastRequestBlock) {
            lastRequestBlock = block.number;
            pendingBlocks.push(uint64(block.number));
        }
        emit RandomnessRequested(requestId, block.number);
    }

    // Consumer entry point (Ships.constructShip, Tournament.buildBracket):
    // captures on first call, then returns the stored result.
    function fulfillRandomRequest(uint _requestId) external returns (uint64) {
        _capture(CAPTURE_PER_CALL);
        return _revealOrGet(_requestId);
    }

    // Permissionless capture. Harmless to call at any time: the result is
    // fixed by the target block, not by when or by whom this is called.
    function revealRandomness(uint _requestId) external returns (uint64) {
        _capture(CAPTURE_PER_CALL);
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
        _capture(CAPTURE_PER_CALL);
        results = new uint64[](_requestIds.length);
        for (uint i = 0; i < _requestIds.length; i++) {
            results[i] = _revealOrGet(_requestIds[i]);
        }
    }

    // Stores up to `_maxBlocks` pending block hashes. Permissionless and
    // safe to call any time: it only records hashes that are already
    // fixed. Called from UTCLotteryHook's afterSwap, and by anyone (e.g. a
    // non-privileged keeper during long quiet periods); nothing depends on
    // any particular caller.
    function capturePending(uint _maxBlocks) external {
        _capture(_maxBlocks);
    }

    // True while some queued block still needs capturing.
    function hasPendingCapture() external view returns (bool) {
        return pendingHead < pendingBlocks.length;
    }

    function _capture(uint _maxBlocks) internal {
        uint head = pendingHead;
        uint end = pendingBlocks.length;
        uint stop = head + _maxBlocks;
        if (stop > end) stop = end;
        while (head < stop) {
            uint b = pendingBlocks[head];
            if (b >= block.number) break; // not sealed yet
            bytes32 h = BlockHashLib.get(b);
            // An unreadable hash means the block aged out uncaptured: its
            // requests stay expired. Skip it either way.
            if (h != bytes32(0)) blockSeed[b] = h;
            head++;
        }
        if (head != pendingHead) pendingHead = head;
    }

    function _revealOrGet(uint _requestId) internal returns (uint64) {
        if (_requestId == 0 || _requestId > requestCount) revert RequestNotFound();
        Request storage request = requests[_requestId];
        if (request.revealed) return request.result;
        // The target block's hash isn't available until a later block.
        if (block.number <= request.blockNumber) revert TooSoonToReveal();
        bytes32 targetHash = _targetHash(request.blockNumber);
        if (targetHash == bytes32(0)) revert RequestExpired(_requestId);

        uint64 result = uint64(
            uint(keccak256(abi.encodePacked(targetHash, _requestId)))
        );
        request.revealed = true;
        request.result = result;
        emit RandomnessRevealed(_requestId, result);
        return result;
    }

    // The stored hash if captured, else the live one (zero once it has
    // aged out of the window).
    function _targetHash(uint _blockNumber) internal view returns (bytes32) {
        bytes32 h = blockSeed[_blockNumber];
        return h != bytes32(0) ? h : BlockHashLib.get(_blockNumber);
    }

    // Expired = the target block is sealed, its hash was never captured,
    // and it can no longer be read. Defined by the same lookup
    // _revealOrGet uses, so the two always agree.
    function _isExpired(Request storage _request) internal view returns (bool) {
        return
            block.number > _request.blockNumber &&
            _targetHash(_request.blockNumber) == bytes32(0);
    }

    // True if fulfillRandomRequest would currently succeed: already
    // revealed, or the target block is sealed and its hash captured or
    // still readable.
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

    // True for a valid, unrevealed request that nothing captured before its
    // window passed. Permanent: Ships builds it as a baseline ship.
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

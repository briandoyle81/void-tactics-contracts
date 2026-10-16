// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

// Block hashes with the EIP-2935 history window (added 2026-10-16).
//
// The BLOCKHASH opcode only covers the 256 most recent blocks (~8.5 minutes
// on Base). EIP-2935 adds a system contract holding the last 8191 block
// hashes (~4.5 hours on Base). It's live on Base mainnet and Base Sepolia
// (verified 2026-10-16: it returns the same hashes as the blocks themselves,
// and reverts past 8191). It returns the very hash BLOCKHASH would, so
// outcomes don't change — only how long they stay readable.
//
// Callers should treat "get() returns 0 for a sealed block" as expired,
// rather than comparing against a fixed window: that stays correct on a
// chain without a working EIP-2935 contract (e.g. Hardhat 2.27, which puts
// an always-reverting stub at the address), where the window is 256.
library BlockHashLib {
    address internal constant HISTORY =
        0x0000F90827F1C53a10cb7A02335B175320002935;
    uint internal constant HISTORY_WINDOW = 8191;

    // Hash of block _n, or 0 if it isn't sealed yet or is no longer readable.
    function get(uint _n) internal view returns (bytes32 hash) {
        if (_n >= block.number) return 0;
        hash = blockhash(_n);
        if (hash != 0 || block.number - _n > HISTORY_WINDOW) return hash;
        // No code succeeds with no data; out of window (or a stub) reverts.
        // Either way the hash stays 0.
        (bool ok, bytes memory ret) = HISTORY.staticcall(abi.encode(_n));
        if (ok && ret.length == 32) hash = abi.decode(ret, (bytes32));
    }
}

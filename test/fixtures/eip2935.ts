import hre from "hardhat";
import { getAddress } from "viem";

// Hardhat 2.27 doesn't support EIP-2935: it puts an always-reverting stub
// at the history address, so on the default test chain BlockHashLib falls
// back to the 256-block BLOCKHASH window. These helpers install the real
// contract (the exact runtime bytecode on Base mainnet and Base Sepolia,
// read 2026-10-16) and feed it block hashes the way the chain does, so
// tests can exercise the 8191-block window.
export const HISTORY_ADDRESS = getAddress("0x0000F90827F1C53a10cb7A02335B175320002935");
const SYSTEM_ADDRESS = getAddress("0xfffffffffffffffffffffffffffffffffffffffe");
const BASE_HISTORY_CODE =
  "0x3373fffffffffffffffffffffffffffffffffffffffe14604657602036036042575f35600143038111604257611fff81430311604257611fff9006545f5260205ff35b5f5ffd5b5f35611fff60014303065500";

export async function installHistoryContract() {
  await hre.network.provider.send("hardhat_setCode", [HISTORY_ADDRESS, BASE_HISTORY_CODE]);
  await hre.network.provider.send("hardhat_impersonateAccount", [SYSTEM_ADDRESS]);
  await hre.network.provider.send("hardhat_setBalance", [SYSTEM_ADDRESS, "0x56BC75E2D63100000"]);
}

// Records block `blockNumber`'s hash in the history contract. On a real
// chain a system call does this at the start of the next block; here the
// write is a transaction from the system address, so call this right after
// that block is mined -- the write must land in block blockNumber + 1.
export async function recordBlockHash(blockNumber: bigint) {
  const publicClient = await hre.viem.getPublicClient();
  const latest = await publicClient.getBlockNumber();
  if (latest !== blockNumber) {
    throw new Error(`recordBlockHash(${blockNumber}) must run while it is the latest block (latest is ${latest})`);
  }
  const { hash } = await publicClient.getBlock({ blockNumber });
  const system = await hre.viem.getWalletClient(SYSTEM_ADDRESS);
  await system.sendTransaction({ to: HISTORY_ADDRESS, data: hash! });
}

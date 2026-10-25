import fs from "fs";
import path from "path";
import hre from "hardhat";
import {
  getAddress,
  zeroAddress,
  formatEther,
  encodePacked,
  encodeAbiParameters,
  keccak256,
} from "viem";

// ---------------------------------------------------------------------------
// Withdraws 100% of the full-range liquidity position deployUTCLotteryPool.ts
// added to the real Base Sepolia UTC/ETH pool, back to the same wallet that
// added it. Companion to that script -- read its header comment first if
// you haven't. Safe to run any time; reports "nothing to withdraw" and exits
// cleanly if the position is already empty.
//
// Why this is possible at all: PoolModifyLiquidityTest.modifyLiquidity's
// unlockCallback (node_modules/@uniswap/v4-core/src/test/
// PoolModifyLiquidityTest.sol) settles a negative liquidityDelta by calling
// `.take(manager, data.sender, ...)` -- data.sender is whoever calls
// modifyLiquidity, so calling it again with a negative delta for the same
// PoolKey/tick-range/salt returns the underlying ETH+UTC to that caller. The
// position itself is tracked inside PoolManager under
// PoolModifyLiquidityTest's own address (not the original depositor's), so
// this only reads back correctly for the same key/tick-range/salt the
// deploy script used -- not tied to a specific depositor identity, so in
// principle any caller could withdraw it, but that's not a concern for us
// recovering our own deposit.
//
// How the current liquidity amount is read: PoolManager exposes `extsload`
// (raw storage-slot reads, IExtsload) to any external caller. This
// replicates StateLibrary.getPositionInfo's exact slot-derivation formula in
// TypeScript (node_modules/@uniswap/v4-core/src/libraries/StateLibrary.sol)
// rather than needing a helper contract -- same "mirror the on-chain logic
// off-chain" approach hookMiner.ts already uses for CREATE2 salt mining.
//
// Usage:
//   npx hardhat run scripts/withdrawUTCLotteryLiquidity.ts --network base-sepolia
// ---------------------------------------------------------------------------

const BASE_SEPOLIA_CHAIN_ID = 84532;
const POOL_MANAGER = getAddress("0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408");
const POOL_MODIFY_LIQUIDITY_TEST = getAddress(
  "0x37429cd17cb1454c34e7f50b09725202fd533039",
);

// Must match deployUTCLotteryPool.ts's liquidity-add call exactly, or this
// resolves a different (very likely empty) position.
const FEE = 3000;
const TICK_SPACING = 60;
const MIN_TICK = -887272;
const MAX_TICK = 887272;
const MIN_USABLE_TICK = Math.trunc(MIN_TICK / TICK_SPACING) * TICK_SPACING;
const MAX_USABLE_TICK = Math.trunc(MAX_TICK / TICK_SPACING) * TICK_SPACING;
const SALT = `0x${"0".repeat(64)}` as `0x${string}`;

// StateLibrary.sol constants (storage layout of PoolManager's `pools`
// mapping, slot 6, with `positions` nested at offset 6 within each pool's
// Pool.State struct).
const POOLS_SLOT = 6n;
const POSITIONS_OFFSET = 6n;

function toBytes32(n: bigint): `0x${string}` {
  return `0x${n.toString(16).padStart(64, "0")}` as `0x${string}`;
}

function loadDeployedAddresses(chainId: number): Record<string, string> {
  const addressesPath = path.join(
    __dirname,
    "..",
    "ignition",
    "deployments",
    `chain-${chainId}`,
    "deployed_addresses.json",
  );
  return JSON.parse(fs.readFileSync(addressesPath, "utf8"));
}

// Mirrors deployUTCLotteryPool.ts's computePoolId exactly -- PoolId.sol's
// keccak256(abi.encode(poolKey)), NOT packed.
function computePoolId(key: {
  currency0: `0x${string}`;
  currency1: `0x${string}`;
  fee: number;
  tickSpacing: number;
  hooks: `0x${string}`;
}): `0x${string}` {
  const encoded = encodeAbiParameters(
    [
      { type: "address" },
      { type: "address" },
      { type: "uint24" },
      { type: "int24" },
      { type: "address" },
    ],
    [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
  );
  return keccak256(encoded);
}

async function main() {
  const publicClient = await hre.viem.getPublicClient();
  const chainId = await publicClient.getChainId();
  if (chainId !== BASE_SEPOLIA_CHAIN_ID) {
    throw new Error(
      `This script hardcodes real Base Sepolia (${BASE_SEPOLIA_CHAIN_ID}) addresses -- ` +
        `refusing to run against chain ${chainId}. Run with --network base-sepolia.`,
    );
  }

  const [wallet] = await hre.viem.getWalletClients();
  console.log("Withdrawing to wallet:", wallet.account.address);

  const hookInfoPath = path.join(__dirname, "..", "uniswap-lottery-hook.json");
  if (!fs.existsSync(hookInfoPath)) {
    throw new Error(
      `${hookInfoPath} not found -- run deployUTCLotteryPool.ts first (it writes this file ` +
        "once the hook is deployed).",
    );
  }
  const hookInfo = JSON.parse(fs.readFileSync(hookInfoPath, "utf8")) as {
    address: string;
    abi: any[];
  };
  const hookAddress = getAddress(hookInfo.address);

  const deployed = loadDeployedAddresses(chainId);
  const universalCreditsAddress = getAddress(
    deployed["DeployModule#UniversalCredits"],
  );

  const key = {
    currency0: zeroAddress,
    currency1: universalCreditsAddress,
    fee: FEE,
    tickSpacing: TICK_SPACING,
    hooks: hookAddress,
  } as const;
  const poolId = computePoolId(key);

  // ---- Read the position's current liquidity via raw storage slots -------
  const stateSlot = keccak256(
    encodePacked(["bytes32", "bytes32"], [poolId, toBytes32(POOLS_SLOT)]),
  );
  const positionsMappingSlot = toBytes32(BigInt(stateSlot) + POSITIONS_OFFSET);
  const positionId = keccak256(
    encodePacked(
      ["address", "int24", "int24", "bytes32"],
      [POOL_MODIFY_LIQUIDITY_TEST, MIN_USABLE_TICK, MAX_USABLE_TICK, SALT],
    ),
  );
  const positionInfoSlot = keccak256(
    encodePacked(["bytes32", "bytes32"], [positionId, positionsMappingSlot]),
  );

  const poolManagerAbi = (await hre.artifacts.readArtifact("PoolManager")).abi as any;
  const slotValue = (await publicClient.readContract({
    address: POOL_MANAGER,
    abi: poolManagerAbi,
    functionName: "extsload",
    args: [positionInfoSlot],
  })) as `0x${string}`;
  // Position.State's first word is `liquidity` alone (uint128, but occupies
  // the full slot) -- matches StateLibrary.getPositionLiquidity's own
  // uint128(uint256(word)) cast.
  const currentLiquidity = BigInt.asUintN(128, BigInt(slotValue));
  console.log("Current position liquidity:", currentLiquidity.toString());

  if (currentLiquidity === 0n) {
    console.log("Nothing to withdraw -- position is already empty.");
    return;
  }

  const poolModifyLiquidityTestAbi = (
    await hre.artifacts.readArtifact("PoolModifyLiquidityTest")
  ).abi as any;

  const ethBefore = await publicClient.getBalance({
    address: wallet.account.address,
  });
  const utcAbi = (await hre.artifacts.readArtifact("UniversalCredits")).abi as any;
  const utcBefore = (await publicClient.readContract({
    address: universalCreditsAddress,
    abi: utcAbi,
    functionName: "balanceOf",
    args: [wallet.account.address],
  })) as bigint;

  const { request } = await publicClient.simulateContract({
    address: POOL_MODIFY_LIQUIDITY_TEST,
    abi: poolModifyLiquidityTestAbi,
    functionName: "modifyLiquidity",
    args: [
      key,
      {
        tickLower: MIN_USABLE_TICK,
        tickUpper: MAX_USABLE_TICK,
        liquidityDelta: -currentLiquidity,
        salt: SALT,
      },
      "0x",
    ],
    account: wallet.account,
  });
  const hash = await wallet.writeContract(request);
  console.log("Withdraw tx:", hash);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    throw new Error(`Withdraw tx reverted: ${hash}`);
  }

  const ethAfter = await publicClient.getBalance({
    address: wallet.account.address,
  });
  const utcAfter = (await publicClient.readContract({
    address: universalCreditsAddress,
    abi: utcAbi,
    functionName: "balanceOf",
    args: [wallet.account.address],
  })) as bigint;
  const gasCost = receipt.gasUsed * receipt.effectiveGasPrice;

  console.log(
    `Received: ${formatEther(ethAfter - ethBefore + gasCost)} ETH (net of gas), ` +
      `${formatEther(utcAfter - utcBefore)} UTC.`,
  );
  console.log(
    "Note: the ETH:UTC ratio returned reflects the pool's CURRENT price, which may differ " +
      "from what was originally deposited if the price moved since (e.g. from the earlier " +
      "oversized smoke-test trade) -- total value should be roughly conserved modulo the " +
      "0.3% pool fee, not the original deposit ratio.",
  );
}

// Same reasoning as deployUTCLotteryPool.ts's summarizeError: viem contract
// errors carry the full ABI on the error object, which console.error(e)
// would dump in full.
function summarizeError(e: unknown): string {
  if (e && typeof e === "object") {
    const err = e as { shortMessage?: string; details?: string; message?: string };
    const headline = err.shortMessage ?? err.message ?? String(e);
    return err.details && err.details !== headline
      ? `${headline}\nDetails: ${err.details}`
      : headline;
  }
  return String(e);
}

main().catch((e) => {
  console.error(summarizeError(e));
  process.exit(1);
});

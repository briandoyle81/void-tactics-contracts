import fs from "fs";
import path from "path";
import hre from "hardhat";
import {
  getAddress,
  zeroAddress,
  parseEther,
  formatEther,
  encodeAbiParameters,
  encodeFunctionData,
  concatHex,
  keccak256,
  parseEventLogs,
  createWalletClient,
  http,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { mineHookAddress, HOOK_FLAGS } from "./hookMiner";
import { getEthUsdPrice, MAP_EDITOR } from "../ignition/modules/DeployAndConfig";

// ---------------------------------------------------------------------------
// Deploys UTCLotteryHook + its real UTC/ETH Uniswap v4 pool on Base Sepolia,
// mirroring exactly the local recipe already proven in
// test/UTCLotteryHookSwap.test.ts, but against real infrastructure:
//   - Real Uniswap v4 PoolManager / PoolSwapTest / PoolModifyLiquidityTest --
//     Uniswap's own official Base Sepolia testnet deployments, independently
//     confirmed via live eth_getCode (2026-09-12). See
//     docs/eth-global-remote-strategy-v2.md's Pick 3 section.
//   - The real canonical CREATE2 "deterministic deployment proxy"
//     (0x4e59b44847b379578588920cA78FbF26c0B4956C -- note the trailing "C":
//     the commonly-pasted 39-hex-digit version is truncated/invalid; see
//     contracts/Create2Deployer.sol's header for the same correction).
//
// Deliberately low-ceremony: there's no canonical UniversalCredits token or
// accumulated pool history yet, and this repo already expects repeated full
// test redeploys. The one technically-irreversible step here
// (PoolManager.initialize locking the hook to one pool forever) is real, but
// isn't treated as precious right now -- if it goes wrong, redeploy Phase 1
// (the main game redeploy) first, THEN re-run this script.
//
// IMPORTANT, confirmed 2026-09-17 (this caused real confusion once already):
// mineHookAddress (hookMiner.ts) is a DETERMINISTIC salt search, not random --
// given the exact same constructorArgs (POOL_MANAGER, shipsAddress,
// universalCreditsAddress, hookOwnerAddress), it always
// finds and returns the exact same salt/hookAddress. "Mine and deploy a fresh
// hook and try again" only actually produces a *different* address because
// Phase 1 mints a brand-new UniversalCredits/Ships address
// every time it's redeployed (per this project's workflow -- the UTC contract
// is not meant to be permanent yet), which changes constructorArgs and
// therefore the mined address as a side effect. Re-running *this* script
// alone, against the same already-deployed Phase 1 (unchanged
// deployed_addresses.json), will find the identical hook already deployed and
// its pool already locked -- if that pool's price got distorted by a bad
// trade (e.g. an oversized/failed smoke test), there is no way to reset it
// short of a fresh Phase 1 redeploy. Don't reach for "just re-run Phase 2" as
// a fix for a bad pool state; it won't do anything different.
//
// If this pool is ever promoted to "long-running" or production: add a real
// manual-confirmation gate before the initialize step below, AND replace
// PoolModifyLiquidityTest with a real position manager (e.g. Uniswap's
// PositionManager/NFT-based one) before any real-value liquidity goes in.
// PoolModifyLiquidityTest is Uniswap's own official *test* router -- it
// tracks the resulting position under its own address with no per-caller
// ownership at all, so literally any address can call modifyLiquidity again
// with a negative delta for the same PoolKey/tick-range/salt and receive the
// underlying tokens themselves (see scripts/withdrawUTCLotteryLiquidity.ts's
// header comment for the exact mechanism -- confirmed by reading
// PoolModifyLiquidityTest.sol directly, not assumed). Fine for testnet,
// where this is a deliberate low-ceremony trade-off and nothing here has
// real value; not fine the moment real funds are at stake.
//
// Output: writes { address, abi, poolId, poolKey } for the hook to
// uniswap-lottery-hook.json at the repo root as soon as the hook is
// confirmed deployed (before the later liquidity/grant/smoke-test steps,
// which can still fail independently -- the frontend needs this file
// regardless). Overwritten every run.
//
// Usage:
//   npx hardhat run scripts/deployUTCLotteryPool.ts --network base-sepolia
//
// Configuration via environment variables (all optional):
//   REFERENCE_TIER_INDEX     ShipPurchaser tier that fixes the pool's initial
//                            price. Default: 0. (LP-seed sourcing always uses
//                            whichever tier mints the most UC per purchase,
//                            independent of this -- see "Sourcing tier" log
//                            line -- since sourcing needs few transactions,
//                            not a specific price; any tier's price/mint
//                            ratio yields the same fungible UC either way.)
//   LP_SEED_UC_AMOUNT        Whole-UC amount to seed as liquidity (e.g.
//                            "500"). Default: the larger of a live-computed
//                            ~$10-equivalent or LP_SEED_TO_SMOKE_TEST_RATIO
//                            times the smoke-test sell size (see that
//                            constant's comment -- too little liquidity
//                            relative to the smoke-test trade causes enough
//                            price impact for it to under-report and fail).
//                            Sourced through ShipPurchaser.purchaseUTCWithFlow
//                            so the seeded price matches the pool's initial
//                            price by construction. If set explicitly below
//                            that floor, a warning is printed but the
//                            explicit value is still used as-is.
//   HOOK_OWNER_ADDRESS       Owner of the deployed hook. Default: MAP_EDITOR
//                            (ignition/modules/DeployAndConfig.ts's constant).
//   MAP_EDITOR_KEY           Private key for MAP_EDITOR -- the real owner of
//                            both Ships (after the main redeploy's ownership
//                            handover) and this hook (HOOK_OWNER_ADDRESS
//                            defaults to the same address). Checked first for
//                            both owner-gated calls this flow needs
//                            (Ships.setIsAllowedToCreateShips and, via the
//                            hook, PoolManager.initialize). This is the key
//                            to set for a fully-automated run.
//   SHIP_MINTER_PRIVATE_KEY  Fallback, checked only if MAP_EDITOR_KEY is
//                            unset or doesn't match. Historically this is
//                            where the owner key lived before MAP_EDITOR_KEY
//                            existed as its own variable -- kept working so
//                            nothing else relying on that name breaks. If
//                            neither key matches the relevant owner for a
//                            given call, that call's calldata is printed for
//                            manual submission instead.
//   DRY_RUN_ONLY             "true" to preview the hook deploy (mine +
//                            simulate, no send) and stop there -- useful the
//                            first time this runs against a new/unfamiliar
//                            environment. Default: "false".
//   SKIP_SMOKE_TEST          "false" to run the real smoke-test swap (step
//                            14) -- pass this explicitly when you actually
//                            want to prove the Uniswap integration end to
//                            end with real funding. Default: "true", since
//                            this repo redeploys often and the smoke test's
//                            required LP-seed liquidity costs real testnet
//                            ETH (scarce -- faucets give ~0.01 ETH at a
//                            time) well beyond what routine iteration
//                            should need. When skipped (the default), the
//                            LP-seed size also drops back to the cheap
//                            ~$10-equivalent heuristic (see step 8).
// ---------------------------------------------------------------------------

const FEE = 3000; // 0.3% -- the only fee tier this repo has ever tested against a real PoolManager.
const TICK_SPACING = 60;
const MIN_TICK = -887272;
const MAX_TICK = 887272;
const MIN_USABLE_TICK = Math.trunc(MIN_TICK / TICK_SPACING) * TICK_SPACING;
const MAX_USABLE_TICK = Math.trunc(MAX_TICK / TICK_SPACING) * TICK_SPACING;
const MIN_SQRT_PRICE = 4295128739n;
const MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342n;
const Q96 = 1n << 96n;

// Real Base Sepolia addresses -- independently confirmed via live
// eth_getCode this session (2026-09-12), not assumed.
const POOL_MANAGER = getAddress("0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408");
const POOL_SWAP_TEST = getAddress("0x8b5bcc363dde2614281ad875bad385e0a785d3b9");
const POOL_MODIFY_LIQUIDITY_TEST = getAddress(
  "0x37429cd17cb1454c34e7f50b09725202fd533039",
);
// Canonical CREATE2 deterministic-deployment proxy ("Nick's method"). Note
// the trailing "C" -- the commonly-pasted 39-hex-digit version is truncated
// and not a valid address; see contracts/Create2Deployer.sol's header.
const CREATE2_PROXY = getAddress("0x4e59b44847b379578588920cA78FbF26c0B4956C");

const BASE_SEPOLIA_CHAIN_ID = 84532;

const DRY_RUN_ONLY =
  (process.env.DRY_RUN_ONLY ?? "false").toLowerCase() === "true";
// Skips the real smoke-test swap (step 14) entirely. Defaults to true
// (2026-09-17) -- this repo redeploys Phase 1+2 often, and the smoke test
// requires a sell big enough to clear minEntryThresholdWei after realistic
// slippage, which in turn requires meaningfully more LP-seed liquidity (and
// therefore real testnet ETH, which is genuinely scarce -- faucets dispense
// it in ~0.01 ETH increments, not the ~1+ ETH a passing smoke test needs)
// than routine iteration should cost. Still worth running with real funding
// occasionally to prove the real Uniswap integration end-to-end -- pass
// SKIP_SMOKE_TEST=false explicitly for that. When skipped, the LP-seed
// default also drops back to the cheap ~$10-equivalent heuristic (see step
// 8) instead of sizing itself against the smoke-test sell, since there's no
// smoke-test size to stay ahead of.
const SKIP_SMOKE_TEST =
  (process.env.SKIP_SMOKE_TEST ?? "true").toLowerCase() === "true";
const REFERENCE_TIER_INDEX = Number(process.env.REFERENCE_TIER_INDEX ?? "0");

// Multiplies the UC amount that would just barely clear the hook's
// minEntryThresholdWei, so the smoke-test swap comfortably qualifies after
// pool fees (0.3%) and price impact eat into its proceeds.
const SMOKE_TEST_SAFETY_MULTIPLIER = 3n;

// Default LP-seed liquidity must be at least this many multiples of the
// smoke-test sell size, or the smoke test's own trade becomes a large
// fraction of the pool and real (post-price-impact) proceeds fall well short
// of the naive/reference-rate estimate SMOKE_TEST_SAFETY_MULTIPLIER assumes.
// Confirmed on-chain (2026-09-17): a ~$10 LP seed against a 3x-multiplied
// smoke-test sell put the trade at ~7.4x the pool's own UC reserve, real ETH
// proceeds landed at ~12% of the naive estimate (0.00358 ETH vs. a 0.01 ETH
// threshold), and no SellRecorded event fired at all -- confirmed via
// hasParticipated/weightInDraw both reading false/0 after the swap. For a
// constant-product pool, real/naive proceeds ratio is ~1/(1+r) where r is the
// trade's fraction of pool reserve -- this ratio keeps r <= 5%, so real
// proceeds land within ~95% of the naive estimate the smoke-test sizing
// above assumes, comfortably preserving its 3x safety margin.
const LP_SEED_TO_SMOKE_TEST_RATIO = 20n;

function loadDeployedAddresses(chainId: number): Record<string, string> {
  const addressesPath = path.join(
    __dirname,
    "..",
    "ignition",
    "deployments",
    `chain-${chainId}`,
    "deployed_addresses.json",
  );
  if (!fs.existsSync(addressesPath)) {
    throw new Error(
      `No deployment found at ${addressesPath}. Run the main game redeploy first.`,
    );
  }
  return JSON.parse(fs.readFileSync(addressesPath, "utf8"));
}

// Exact BigInt Newton/Babylonian integer square root -- no floating point;
// exact for arbitrarily large BigInts (used on ~2^192-magnitude inputs here).
function isqrt(n: bigint): bigint {
  if (n < 0n) throw new Error("isqrt: negative input");
  if (n < 2n) return n;
  let x0 = n;
  let x1 = (x0 + 1n) >> 1n;
  while (x1 < x0) {
    x0 = x1;
    x1 = (x0 + n / x0) >> 1n;
  }
  return x0;
}

// Mirrors @uniswap/v4-periphery's LiquidityAmounts.getLiquidityForAmount0 --
// BigInt has no fixed-width overflow risk, so no mulDiv trick is needed.
function getLiquidityForAmount0(
  a: bigint,
  b: bigint,
  amount0: bigint,
): bigint {
  const [lo, hi] = a > b ? [b, a] : [a, b];
  const intermediate = (lo * hi) / Q96;
  return (amount0 * intermediate) / (hi - lo);
}

// Mirrors LiquidityAmounts.getLiquidityForAmount1.
function getLiquidityForAmount1(
  a: bigint,
  b: bigint,
  amount1: bigint,
): bigint {
  const [lo, hi] = a > b ? [b, a] : [a, b];
  return (amount1 * Q96) / (hi - lo);
}

// Mirrors LiquidityAmounts.getLiquidityForAmounts's "price strictly inside
// range" branch -- the only branch this script needs, since sqrtPriceX96 is
// always strictly between MIN_SQRT_PRICE/MAX_SQRT_PRICE for any real,
// non-degenerate ratio.
function getLiquidityForAmounts(
  sqrtPriceX96: bigint,
  sqrtPriceAX96: bigint,
  sqrtPriceBX96: bigint,
  amount0: bigint,
  amount1: bigint,
): bigint {
  const liquidity0 = getLiquidityForAmount0(sqrtPriceX96, sqrtPriceBX96, amount0);
  const liquidity1 = getLiquidityForAmount1(sqrtPriceAX96, sqrtPriceX96, amount1);
  return liquidity0 < liquidity1 ? liquidity0 : liquidity1;
}

// keccak256(abi.encode(poolKey)) -- PoolId.sol's exact formula. For a static
// 5-field struct (address, address, uint24, int24, address), abi.encode of
// the struct is bit-identical to abi.encode of the flat field list.
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

function buildClientFromKey(rawKey: string) {
  const pk = (
    rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`
  ) as `0x${string}`;
  const account = privateKeyToAccount(pk);
  return createWalletClient({
    account,
    chain: baseSepolia,
    transport: http(process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org"),
  });
}

// Tries each candidate private key, in priority order, and returns the first
// whose derived address matches expectedOwner -- MAP_EDITOR_KEY first, since
// it's the actual key for both owner-gated calls this script needs
// (Ships.setIsAllowedToCreateShips and, via the hook, PoolManager.initialize
// -- both default to the same MAP_EDITOR address, see this file's header
// comment). SHIP_MINTER_PRIVATE_KEY is kept as a fallback for anyone still
// relying on that name holding the owner key. Returns undefined (and warns)
// if neither is set or neither matches -- the caller prints manual-step
// calldata in that case instead of attempting a doomed transaction.
function resolveOwnerClient(
  expectedOwner: `0x${string}`,
  label: string,
): ReturnType<typeof createWalletClient> | undefined {
  const candidates: Array<[string, string | undefined]> = [
    ["MAP_EDITOR_KEY", process.env.MAP_EDITOR_KEY],
    ["SHIP_MINTER_PRIVATE_KEY", process.env.SHIP_MINTER_PRIVATE_KEY],
  ];
  for (const [envName, rawKey] of candidates) {
    if (!rawKey) continue;
    const client = buildClientFromKey(rawKey);
    if (getAddress(client.account!.address) === expectedOwner) {
      console.log(
        `${envName} matches ${label} (${expectedOwner}) -- will sign automatically.`,
      );
      return client;
    }
  }
  console.warn(
    `WARNING: neither MAP_EDITOR_KEY nor SHIP_MINTER_PRIVATE_KEY matches ${label} ` +
      `(${expectedOwner}) -- the corresponding call will be printed for manual ` +
      "submission instead.",
  );
  return undefined;
}

async function main() {
  const publicClient = await hre.viem.getPublicClient();
  const chainId = await publicClient.getChainId();
  if (chainId !== BASE_SEPOLIA_CHAIN_ID) {
    throw new Error(
      `This script hardcodes real Base Sepolia (${BASE_SEPOLIA_CHAIN_ID}) Uniswap v4 ` +
        `addresses -- refusing to run against chain ${chainId}. Run with --network base-sepolia.`,
    );
  }

  const [wallet] = await hre.viem.getWalletClients();
  console.log("Deployer/LP/trader wallet:", wallet.account.address);
  console.log("DRY_RUN_ONLY:", DRY_RUN_ONLY);

  // ---- Step 2: load + verify addresses -----------------------------------
  const deployed = loadDeployedAddresses(chainId);
  const shipsAddress = getAddress(deployed["DeployModule#Ships"]);
  const universalCreditsAddress = getAddress(
    deployed["DeployModule#UniversalCredits"],
  );
  const shipPurchaserAddress = getAddress(
    deployed["DeployModule#ShipPurchaser"],
  );
  const variantPurchaseGateAddress = getAddress(
    deployed["DeployModule#VariantPurchaseGate"],
  );

  for (const [label, addr] of [
    ["PoolManager", POOL_MANAGER],
    ["PoolSwapTest", POOL_SWAP_TEST],
    ["PoolModifyLiquidityTest", POOL_MODIFY_LIQUIDITY_TEST],
    ["CREATE2 proxy", CREATE2_PROXY],
  ] as const) {
    const code = await publicClient.getCode({ address: addr });
    if (!code || code === "0x") {
      throw new Error(
        `${label} (${addr}) has no deployed bytecode on chain ${chainId} -- aborting.`,
      );
    }
  }
  console.log("Loaded + verified addresses:", {
    ships: shipsAddress,
    universalCredits: universalCreditsAddress,
    shipPurchaser: shipPurchaserAddress,
  });

  const shipsAbi = (await hre.artifacts.readArtifact("Ships")).abi as any;
  const gateAbi = (await hre.artifacts.readArtifact("VariantPurchaseGate"))
    .abi as any;
  const shipPurchaserAbi = (await hre.artifacts.readArtifact("ShipPurchaser"))
    .abi as any;
  const ucAbi = (await hre.artifacts.readArtifact("UniversalCredits"))
    .abi as any;
  const hookArtifact = await hre.artifacts.readArtifact("UTCLotteryHook");
  const hookAbi = hookArtifact.abi as any;
  const poolManagerAbi = (await hre.artifacts.readArtifact("PoolManager"))
    .abi as any;
  const poolSwapTestAbi = (await hre.artifacts.readArtifact("PoolSwapTest"))
    .abi as any;
  const poolModifyLiquidityTestAbi = (
    await hre.artifacts.readArtifact("PoolModifyLiquidityTest")
  ).abi as any;

  // ---- Step 3: ownership / key-custody check -----------------------------
  const shipsOwner = getAddress(
    (await publicClient.readContract({
      address: shipsAddress,
      abi: shipsAbi,
      functionName: "owner",
      args: [],
    })) as `0x${string}`,
  );
  console.log("Ships owner:", shipsOwner);

  const shipsOwnerClient = resolveOwnerClient(shipsOwner, "Ships.owner()");

  // ---- Step 4: read the reference UC/ETH rate ----------------------------
  const tierPriceWei = (await publicClient.readContract({
    address: shipPurchaserAddress,
    abi: shipPurchaserAbi,
    functionName: "tierPrices",
    args: [BigInt(REFERENCE_TIER_INDEX)],
  })) as bigint;
  const tierShipsCount = (await publicClient.readContract({
    address: shipPurchaserAddress,
    abi: shipPurchaserAbi,
    functionName: "tierShips",
    args: [BigInt(REFERENCE_TIER_INDEX)],
  })) as number;
  const recycleReward = (await publicClient.readContract({
    address: shipsAddress,
    abi: shipsAbi,
    functionName: "recycleReward",
    args: [],
  })) as bigint;
  const mintAmountUC = BigInt(tierShipsCount) * recycleReward;
  console.log(
    `Reference rate (tier ${REFERENCE_TIER_INDEX}): ${formatEther(tierPriceWei)} ETH -> ${formatEther(mintAmountUC)} UC`,
  );

  // Sourcing loop (step 8) buys whichever tier mints the most UC per
  // purchase, independent of REFERENCE_TIER_INDEX (which only fixes the
  // pool's initial price) -- with the LP_SEED_TO_SMOKE_TEST_RATIO fix above,
  // sourcing enough UC at tier 0's 0.5 UC/purchase would take ~300
  // transactions; the largest tier mints ~12x more per purchase.
  const [allTierShips, allTierPrices] = (await publicClient.readContract({
    address: shipPurchaserAddress,
    abi: shipPurchaserAbi,
    functionName: "getPurchaseInfo",
    args: [],
  })) as [readonly number[], readonly bigint[]];
  let sourcingTierIndex = 0;
  for (let i = 1; i < allTierShips.length; i++) {
    if (allTierShips[i] > allTierShips[sourcingTierIndex]) sourcingTierIndex = i;
  }
  const sourcingTierPriceWei = allTierPrices[sourcingTierIndex];
  const sourcingTierMintUC = BigInt(allTierShips[sourcingTierIndex]) * recycleReward;
  console.log(
    `Sourcing tier ${sourcingTierIndex}: ${formatEther(sourcingTierPriceWei)} ETH -> ` +
      `${formatEther(sourcingTierMintUC)} UC per purchase`,
  );

  // ---- Step 5: compute sqrtPriceX96 (price = currency1/currency0 = UC/ETH) ----
  const ratioX192 = (mintAmountUC << 192n) / tierPriceWei;
  const sqrtPriceX96 = isqrt(ratioX192);
  console.log("sqrtPriceX96:", sqrtPriceX96.toString());
  if (sqrtPriceX96 <= MIN_SQRT_PRICE || sqrtPriceX96 >= MAX_SQRT_PRICE) {
    throw new Error(
      `Computed sqrtPriceX96 (${sqrtPriceX96}) is outside Uniswap's valid range -- ` +
        `the reference rate read from ShipPurchaser is almost certainly wrong.`,
    );
  }

  // ---- Step 6: mine the CREATE2 salt -------------------------------------
  const hookOwnerAddress = getAddress(process.env.HOOK_OWNER_ADDRESS || MAP_EDITOR);
  // Resolved independently from shipsOwnerClient above -- hookOwnerAddress
  // and shipsOwner default to the same MAP_EDITOR address but aren't
  // guaranteed to match, so each owner-gated call checks its own expected
  // owner rather than assuming one client covers both.
  const hookOwnerClient = resolveOwnerClient(hookOwnerAddress, "the hook's owner");
  const flags = HOOK_FLAGS.BEFORE_INITIALIZE | HOOK_FLAGS.AFTER_SWAP;
  const constructorArgs = [
    POOL_MANAGER,
    shipsAddress,
    universalCreditsAddress,
    hookOwnerAddress,
  ] as const;
  const { hookAddress, salt, initCode } = mineHookAddress({
    deployer: CREATE2_PROXY,
    flags,
    abi: hookArtifact.abi,
    bytecode: hookArtifact.bytecode as `0x${string}`,
    constructorArgs,
  });
  const flagMask = 0x3fffn;
  if ((BigInt(hookAddress) & flagMask) !== (flags & flagMask)) {
    throw new Error(
      "Mined hook address does not actually match the requested permission flags -- aborting.",
    );
  }
  console.log("Mined hook address:", hookAddress, "salt:", salt);

  // ---- Step 7: deploy the hook via the canonical CREATE2 proxy -----------
  const existingHookCode = await publicClient.getCode({ address: hookAddress });
  if (existingHookCode && existingHookCode !== "0x") {
    console.log("Hook already deployed at", hookAddress, "-- skipping deployment.");
  } else {
    const data = concatHex([salt, initCode]);
    const simulated = await publicClient.call({
      to: CREATE2_PROXY,
      data,
      account: wallet.account.address,
    });
    const simulatedAddress = simulated.data
      ? getAddress(`0x${simulated.data.slice(-40)}`)
      : undefined;
    if (simulatedAddress !== hookAddress) {
      throw new Error(
        `Simulated CREATE2 deploy address (${simulatedAddress}) does not match the ` +
          `offline-mined address (${hookAddress}) -- aborting before spending gas.`,
      );
    }
    const gasEstimate = await publicClient.estimateGas({
      account: wallet.account.address,
      to: CREATE2_PROXY,
      data,
    });
    const fees = await publicClient.estimateFeesPerGas();
    console.log(
      "Hook deploy gas estimate:",
      gasEstimate.toString(),
      "maxFeePerGas:",
      fees.maxFeePerGas?.toString(),
    );

    if (DRY_RUN_ONLY) {
      console.log(
        "DRY_RUN_ONLY set -- not sending the hook deploy transaction. Stopping here " +
          "(later steps need a real deployed hook to read state from).",
      );
      return;
    }

    const hash = await wallet.sendTransaction({
      to: CREATE2_PROXY,
      data,
      account: wallet.account,
    });
    console.log("Hook deploy tx:", hash);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      throw new Error(`Hook deploy tx reverted: ${hash}`);
    }
    const deployedOwner = getAddress(
      (await publicClient.readContract({
        address: hookAddress,
        abi: hookAbi,
        functionName: "owner",
        args: [],
      })) as `0x${string}`,
    );
    const deployedUtcToken = getAddress(
      (await publicClient.readContract({
        address: hookAddress,
        abi: hookAbi,
        functionName: "utcToken",
        args: [],
      })) as `0x${string}`,
    );
    if (
      deployedOwner !== hookOwnerAddress ||
      deployedUtcToken !== universalCreditsAddress
    ) {
      throw new Error(
        "Deployed hook's owner/utcToken do not match intent -- something is wrong, " +
          "investigate before proceeding.",
      );
    }
    console.log("Hook deployed and verified:", hookAddress);
  }

  // Hoisted up from where it's used later (step 11) so the pool id can be
  // included in the output file below -- every field this needs
  // (universalCreditsAddress, hookAddress) is already available by this
  // point, no need to wait for the later steps.
  const key = {
    currency0: zeroAddress,
    currency1: universalCreditsAddress,
    fee: FEE,
    tickSpacing: TICK_SPACING,
    hooks: hookAddress,
  } as const;
  const poolId = computePoolId(key);

  // Written as soon as the hook is confirmed deployed (whether just now or
  // on a prior run) -- the frontend needs this address/ABI/poolId, and it
  // shouldn't depend on the later, unrelated liquidity/grant/smoke-test
  // steps succeeding. Overwritten every run, since the current deployment is
  // what matters, not a history -- and per this file's header comment, a
  // fresh Phase 1 redeploy is what actually changes this address, not
  // re-running Phase 2 alone.
  const hookOutputPath = path.join(__dirname, "..", "uniswap-lottery-hook.json");
  fs.writeFileSync(
    hookOutputPath,
    JSON.stringify(
      { address: hookAddress, abi: hookArtifact.abi, poolId, poolKey: key },
      null,
      2,
    ),
  );
  console.log("Wrote hook address + ABI + poolId + poolKey to", hookOutputPath);

  // ---- Step 7b: read minEntryThresholdWei, size the smoke-test sell ------
  const minEntryThresholdWei = (await publicClient.readContract({
    address: hookAddress,
    abi: hookAbi,
    functionName: "minEntryThresholdWei",
    args: [],
  })) as bigint;
  const smokeTestSellUc =
    ((minEntryThresholdWei * mintAmountUC) / tierPriceWei) *
    SMOKE_TEST_SAFETY_MULTIPLIER;
  console.log(
    `minEntryThresholdWei: ${formatEther(minEntryThresholdWei)} ETH -- smoke-test sell sized to ${formatEther(smokeTestSellUc)} UC`,
  );

  // ---- Step 8: source LP-seed UC via ShipPurchaser.purchaseUTCWithFlow ---
  let lpSeedUcTarget: bigint;
  const lpSeedEnvRaw = process.env.LP_SEED_UC_AMOUNT;
  const smokeTestFloor = smokeTestSellUc * LP_SEED_TO_SMOKE_TEST_RATIO;
  if (lpSeedEnvRaw) {
    lpSeedUcTarget = parseEther(lpSeedEnvRaw);
    if (!SKIP_SMOKE_TEST && lpSeedUcTarget < smokeTestFloor) {
      console.warn(
        `WARNING: LP_SEED_UC_AMOUNT (${formatEther(lpSeedUcTarget)} UC) is below ` +
          `${LP_SEED_TO_SMOKE_TEST_RATIO}x the smoke-test sell size (${formatEther(smokeTestFloor)} UC) -- ` +
          "the smoke-test swap may see enough price impact to fall short of minEntryThresholdWei.",
      );
    }
  } else {
    const ethUsdPrice = getEthUsdPrice();
    const tenDollarsEthWei = parseEther((10 / ethUsdPrice).toFixed(18));
    const tenDollarsUc = (tenDollarsEthWei * mintAmountUC) / tierPriceWei;
    if (SKIP_SMOKE_TEST) {
      lpSeedUcTarget = tenDollarsUc;
      console.log(
        `No LP_SEED_UC_AMOUNT set -- defaulting to ~$10 of UC at $${ethUsdPrice}/ETH: ` +
          `${formatEther(lpSeedUcTarget)} UC (SKIP_SMOKE_TEST set, so not sizing against the ` +
          "smoke-test sell).",
      );
    } else {
      lpSeedUcTarget = tenDollarsUc > smokeTestFloor ? tenDollarsUc : smokeTestFloor;
      console.log(
        `No LP_SEED_UC_AMOUNT set -- ~$10 of UC would be ${formatEther(tenDollarsUc)} UC, but ` +
          `defaulting to ${formatEther(lpSeedUcTarget)} UC (>= ${LP_SEED_TO_SMOKE_TEST_RATIO}x the ` +
          "smoke-test sell size, so the smoke test itself doesn't move the price enough to fail).",
      );
    }
  }
  const sourcingTarget = SKIP_SMOKE_TEST
    ? lpSeedUcTarget
    : lpSeedUcTarget + smokeTestSellUc;

  let ucBalance = (await publicClient.readContract({
    address: universalCreditsAddress,
    abi: ucAbi,
    functionName: "balanceOf",
    args: [wallet.account.address],
  })) as bigint;
  console.log("Current UC balance:", formatEther(ucBalance));

  while (ucBalance < sourcingTarget) {
    console.log(
      `Sourcing more UC via purchaseUTCWithFlow(tier ${sourcingTierIndex}, ` +
        `+${formatEther(sourcingTierMintUC)} UC)...`,
    );
    const { request } = await publicClient.simulateContract({
      address: shipPurchaserAddress,
      abi: shipPurchaserAbi,
      functionName: "purchaseUTCWithFlow",
      args: [wallet.account.address, sourcingTierIndex],
      value: sourcingTierPriceWei,
      account: wallet.account,
    });
    const hash = await wallet.writeContract(request);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      throw new Error(`purchaseUTCWithFlow reverted: ${hash}`);
    }
    ucBalance = (await publicClient.readContract({
      address: universalCreditsAddress,
      abi: ucAbi,
      functionName: "balanceOf",
      args: [wallet.account.address],
    })) as bigint;
  }
  console.log("UC sourced. Balance now:", formatEther(ucBalance));

  // ---- Step 9: approve UC to PoolModifyLiquidityTest ----------------------
  {
    const { request } = await publicClient.simulateContract({
      address: universalCreditsAddress,
      abi: ucAbi,
      functionName: "approve",
      args: [POOL_MODIFY_LIQUIDITY_TEST, lpSeedUcTarget],
      account: wallet.account,
    });
    const hash = await wallet.writeContract(request);
    await publicClient.waitForTransactionReceipt({ hash });
  }

  // ---- Step 10: compute liquidityDelta for a full-range position --------
  const amount0Wei = (lpSeedUcTarget * tierPriceWei) / mintAmountUC;
  const liquidityDelta = getLiquidityForAmounts(
    sqrtPriceX96,
    MIN_SQRT_PRICE,
    MAX_SQRT_PRICE,
    amount0Wei,
    lpSeedUcTarget,
  );
  console.log(
    `Liquidity math: amount0 (ETH) = ${formatEther(amount0Wei)}, amount1 (UC) = ${formatEther(lpSeedUcTarget)}, liquidityDelta = ${liquidityDelta.toString()}`,
  );

  // ---- Step 11: initialize the pool --------------------------------------
  // See this script's header comment: the first successful call here
  // permanently locks the hook to this exact key -- not treated as precious
  // right now (no canonical UC token / accumulated history yet), but there's
  // no on-chain fix for a wrong key, so still verify carefully before
  // sending. key/poolId were already computed above, right before writing
  // the output file.
  const intendedPoolId = poolId;
  const poolLocked = (await publicClient.readContract({
    address: hookAddress,
    abi: hookAbi,
    functionName: "poolLocked",
    args: [],
  })) as boolean;

  if (poolLocked) {
    const lockedPoolId = (await publicClient.readContract({
      address: hookAddress,
      abi: hookAbi,
      functionName: "lockedPoolId",
      args: [],
    })) as `0x${string}`;
    if (lockedPoolId.toLowerCase() === intendedPoolId.toLowerCase()) {
      console.log(
        "Pool already initialized with the intended key -- skipping initialize.",
      );
    } else {
      throw new Error(
        `Hook ${hookAddress} is already permanently locked to a DIFFERENT pool ` +
          `(${lockedPoolId}, expected ${intendedPoolId}). There is no on-chain fix, and ` +
          `re-running this script alone won't mine a different hook address -- the salt ` +
          `search is deterministic given the same constructorArgs (see this file's header ` +
          `comment). Redeploy Phase 1 first (fresh Ships/UniversalCredits ` +
          `addresses), THEN re-run this script.`,
      );
    }
  } else {
    console.log("PoolKey:", key, "sqrtPriceX96:", sqrtPriceX96.toString());

    // PoolManager.initialize is permissionless on the real network, but
    // UTCLotteryHook._beforeInitialize is now owner-gated (HA2-02) -- the
    // call must come from the hook's own owner, not just any wallet.
    // hookOwnerClient was already resolved (MAP_EDITOR_KEY first, then
    // SHIP_MINTER_PRIVATE_KEY) against hookOwnerAddress specifically, right
    // after that address was computed in step 6.
    if (!hookOwnerClient) {
      const initializeCalldata = encodeFunctionData({
        abi: poolManagerAbi,
        functionName: "initialize",
        args: [key, sqrtPriceX96],
      });
      console.log(
        "MANUAL STEP REQUIRED -- no available wallet matches this hook's owner " +
          `(${hookOwnerAddress}). PoolManager.initialize is owner-gated on this hook ` +
          "(docs/audit-2.md HA2-02) and must be submitted from that wallet. Submit this, " +
          "then re-run this script to continue:",
      );
      console.log("  to:  ", POOL_MANAGER);
      console.log("  data:", initializeCalldata);
      throw new Error(
        "Cannot initialize the pool automatically -- see the manual-step instructions above.",
      );
    }

    const { request, result: resultingTick } = await publicClient.simulateContract({
      address: POOL_MANAGER,
      abi: poolManagerAbi,
      functionName: "initialize",
      args: [key, sqrtPriceX96],
      account: hookOwnerClient.account,
    });
    console.log("Simulated pool initialize OK. Resulting tick:", resultingTick);
    const hash = await hookOwnerClient.writeContract(request);
    console.log("Pool initialize tx:", hash);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      throw new Error(`Pool initialize tx reverted: ${hash}`);
    }
    const lockedAfter = (await publicClient.readContract({
      address: hookAddress,
      abi: hookAbi,
      functionName: "poolLocked",
      args: [],
    })) as boolean;
    if (!lockedAfter) {
      throw new Error(
        "Pool initialize succeeded but hook.poolLocked() is still false -- investigate.",
      );
    }
    console.log("Pool initialized and hook locked to it.");
  }

  // ---- Step 12: add liquidity ---------------------------------------------
  {
    const { request } = await publicClient.simulateContract({
      address: POOL_MODIFY_LIQUIDITY_TEST,
      abi: poolModifyLiquidityTestAbi,
      functionName: "modifyLiquidity",
      args: [
        key,
        {
          tickLower: MIN_USABLE_TICK,
          tickUpper: MAX_USABLE_TICK,
          liquidityDelta,
          salt: `0x${"0".repeat(64)}`,
        },
        "0x",
      ],
      account: wallet.account,
      value: amount0Wei,
    });
    const hash = await wallet.writeContract(request);
    console.log("Add-liquidity tx:", hash);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      throw new Error(`modifyLiquidity reverted: ${hash}`);
    }
    console.log("Liquidity added.");
  }

  // ---- Step 13: grant Ships.setIsAllowedToCreateShips(hook, true) --------
  const alreadyAllowed = (await publicClient.readContract({
    address: shipsAddress,
    abi: shipsAbi,
    functionName: "isAllowedToCreateShips",
    args: [hookAddress],
  })) as boolean;
  if (alreadyAllowed) {
    console.log("Hook already allowed to create ships -- skipping grant.");
  } else if (shipsOwnerClient) {
    const { request } = await publicClient.simulateContract({
      address: shipsAddress,
      abi: shipsAbi,
      functionName: "setIsAllowedToCreateShips",
      args: [hookAddress, true],
      account: shipsOwnerClient.account,
    });
    const hash = await shipsOwnerClient.writeContract(request);
    console.log("Grant tx:", hash);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      throw new Error(`Grant tx reverted: ${hash}`);
    }
    console.log("Hook granted ship-minting rights.");
  } else {
    const calldata = encodeFunctionData({
      abi: shipsAbi,
      functionName: "setIsAllowedToCreateShips",
      args: [hookAddress, true],
    });
    console.log("MANUAL STEP REQUIRED -- submit this from the Ships owner wallet:");
    console.log("  to:  ", shipsAddress);
    console.log("  data:", calldata);
  }

  // ---- Step 13b: exempt the hook from VariantPurchaseGate ----------------
  // Lottery prizes may be any variant and go to any winner, medal or not
  // (docs/audit-3.md HA6-06) -- without this, a gated prize variant makes
  // resolveDraw revert for a winner lacking the required NFT.
  const gateOwner = getAddress(
    (await publicClient.readContract({
      address: variantPurchaseGateAddress,
      abi: gateAbi,
      functionName: "owner",
      args: [],
    })) as `0x${string}`,
  );
  const alreadyExempt = (await publicClient.readContract({
    address: variantPurchaseGateAddress,
    abi: gateAbi,
    functionName: "exemptMinter",
    args: [hookAddress],
  })) as boolean;
  const gateOwnerClient = alreadyExempt
    ? undefined
    : resolveOwnerClient(gateOwner, "VariantPurchaseGate.owner()");
  if (alreadyExempt) {
    console.log("Hook already exempt from VariantPurchaseGate -- skipping.");
  } else if (gateOwnerClient) {
    const { request } = await publicClient.simulateContract({
      address: variantPurchaseGateAddress,
      abi: gateAbi,
      functionName: "setExemptMinter",
      args: [hookAddress, true],
      account: gateOwnerClient.account,
    });
    const hash = await gateOwnerClient.writeContract(request);
    console.log("Gate exemption tx:", hash);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      throw new Error(`Gate exemption tx reverted: ${hash}`);
    }
    console.log("Hook exempted from VariantPurchaseGate.");
  } else {
    const calldata = encodeFunctionData({
      abi: gateAbi,
      functionName: "setExemptMinter",
      args: [hookAddress, true],
    });
    console.log(
      "MANUAL STEP REQUIRED -- submit this from the VariantPurchaseGate owner wallet:",
    );
    console.log("  to:  ", variantPurchaseGateAddress);
    console.log("  data:", calldata);
  }

  // ---- Step 14: smoke test -------------------------------------------------
  let swapHash: `0x${string}` | undefined;
  if (SKIP_SMOKE_TEST) {
    console.log("SKIP_SMOKE_TEST set -- skipping the smoke-test swap.");
  } else {
    const currentDrawIdBefore = (await publicClient.readContract({
      address: hookAddress,
      abi: hookAbi,
      functionName: "currentDrawId",
      args: [],
    })) as bigint;

    const finalUcBalance = (await publicClient.readContract({
      address: universalCreditsAddress,
      abi: ucAbi,
      functionName: "balanceOf",
      args: [wallet.account.address],
    })) as bigint;
    if (finalUcBalance < smokeTestSellUc) {
      throw new Error(
        "Not enough leftover UC for the smoke-test swap -- this shouldn't happen given the sourcing target above.",
      );
    }

    {
      const { request } = await publicClient.simulateContract({
        address: universalCreditsAddress,
        abi: ucAbi,
        functionName: "approve",
        args: [POOL_SWAP_TEST, smokeTestSellUc],
        account: wallet.account,
      });
      const hash = await wallet.writeContract(request);
      await publicClient.waitForTransactionReceipt({ hash });
    }

    const hookData = encodeAbiParameters(
      [{ type: "address" }],
      [wallet.account.address],
    );
    const { request: swapRequest } = await publicClient.simulateContract({
      address: POOL_SWAP_TEST,
      abi: poolSwapTestAbi,
      functionName: "swap",
      args: [
        key,
        {
          zeroForOne: false,
          amountSpecified: -smokeTestSellUc,
          sqrtPriceLimitX96: MAX_SQRT_PRICE - 1n,
        },
        { takeClaims: false, settleUsingBurn: false },
        hookData,
      ],
      account: wallet.account,
    });
    swapHash = await wallet.writeContract(swapRequest);
    console.log("Smoke-test swap tx:", swapHash);
    const swapReceipt = await publicClient.waitForTransactionReceipt({
      hash: swapHash,
    });
    if (swapReceipt.status !== "success") {
      throw new Error(`Smoke-test swap reverted: ${swapHash}`);
    }

    const sellRecordedEvents = parseEventLogs({
      abi: hookAbi,
      logs: swapReceipt.logs,
      eventName: "SellRecorded",
    }) as any[];
    const ownEvent = sellRecordedEvents.find(
      (e) => getAddress(e.args.player) === getAddress(wallet.account.address),
    );
    if (!ownEvent) {
      throw new Error(
        "No SellRecorded event found for this trader in the swap receipt -- something is wrong.",
      );
    }
    console.log("SellRecorded event:", ownEvent.args);

    const hasParticipated = (await publicClient.readContract({
      address: hookAddress,
      abi: hookAbi,
      functionName: "hasParticipated",
      args: [currentDrawIdBefore, wallet.account.address],
    })) as boolean;
    const weight = (await publicClient.readContract({
      address: hookAddress,
      abi: hookAbi,
      functionName: "weightInDraw",
      args: [currentDrawIdBefore, wallet.account.address],
    })) as bigint;
    if (!hasParticipated || weight <= 0n) {
      throw new Error(
        `Smoke test verification failed: hasParticipated=${hasParticipated}, weight=${weight}.`,
      );
    }
    console.log(
      `Smoke test verified: hasParticipated=${hasParticipated}, weight=${formatEther(weight)} ETH.`,
    );
  }

  // ---- Step 15: summary ----------------------------------------------------
  console.log("\n=== Deploy summary ===");
  console.log("Hook address:      ", hookAddress);
  console.log("CREATE2 salt:      ", salt);
  console.log("PoolKey:           ", key);
  console.log("sqrtPriceX96:      ", sqrtPriceX96.toString());
  console.log(
    "Smoke-test swap tx:",
    swapHash ?? "(skipped -- SKIP_SMOKE_TEST was set)",
  );
  console.log(
    `Hook address + ABI + poolId + poolKey written to ${hookOutputPath} (step 7). ` +
      "CREATE2 salt/sqrtPriceX96 above aren't in that file -- copy them into a doc yourself if " +
      "you want a durable record of those too.",
  );
}

// viem contract-call errors carry the full ABI (and other large, mostly
// redundant fields -- args, metaMessages, a repeated nested `cause` chain
// with its own copy of all of that) on the error object itself, which
// console.error(e) dumps in full -- unreadable for what's usually a
// one-line problem. Pull out just the useful bits: the short summary and,
// if present, `details` (viem's own field for the actual underlying reason,
// e.g. "EVM error: OutOfFunds" -- often more specific than shortMessage).
function summarizeError(e: unknown): string {
  if (e && typeof e === "object") {
    const err = e as {
      shortMessage?: string;
      details?: string;
      message?: string;
    };
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

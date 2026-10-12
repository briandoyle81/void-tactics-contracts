import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox-viem";
import "hardhat-gas-reporter";

require("hardhat-contract-sizer");
require("dotenv").config();

const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY as string;

const config: HardhatUserConfig = {
  solidity: {
    compilers: [
      {
        version: "0.8.28",
        settings: {
          // viaIR: true, // Yul stack issues in this repo; runs:1 keeps Game under 24 KiB
          optimizer: {
            enabled: true,
            runs: 1,
          },
          // Dev-only, no effect on deployed bytecode: emits an authoritative
          // slot/offset map per contract (artifacts/.../<Contract>.json's
          // .storageLayout), used to cross-check hand-derived storage slots
          // for test-only EVM storage manipulation (see test/helpers/
          // gameStorage.ts).
          outputSelection: {
            "*": {
              "*": ["storageLayout"],
            },
          },
        },
      },
      {
        // Only @uniswap/v4-core/src/PoolManager.sol needs this — it pins an
        // exact `pragma solidity 0.8.26;` rather than a caret range, unlike
        // every other Uniswap v4 file this repo imports (all `^0.8.x`,
        // compatible with 0.8.28 already). Added for
        // contracts/mocks/UniswapV4TestImports.sol / UTCLotteryHook.sol's
        // real-swap integration tests.
        version: "0.8.26",
        settings: {
          // Uniswap v4 core uses transient storage (tload/tstore, EIP-1153)
          // throughout — requires at least Cancun; the default target for
          // this compiler version otherwise rejects those opcodes.
          evmVersion: "cancun",
          optimizer: {
            enabled: true,
            runs: 1,
          },
        },
      },
    ],
    // Deliberately NOT applied to the main 0.8.28 compiler above: PoolManager
    // itself needs viaIR to avoid a stack-too-deep error, but viaIR is
    // already off there on purpose (see that entry's comment) to keep
    // Game.sol under the 24 KiB limit — turning it on globally would risk
    // exactly that regression. These three files (and whatever they alone
    // pull in — Uniswap's own PoolManager/PoolTestBase graph, which uses
    // transient storage throughout) get isolated into their own compiler
    // job instead, entirely separate from this repo's own contracts.
    overrides: Object.fromEntries(
      [
        // Full transitive import closure of PoolManager.sol +
        // PoolSwapTest.sol + PoolModifyLiquidityTest.sol, computed by
        // walking their actual import graphs rather than guessed — Hardhat
        // overrides apply per listed file only, NOT transitively to that
        // file's own imports, so every file in the closure needs its own
        // entry or it silently falls back to the default (Paris, no viaIR)
        // job and fails on tload/tstore or PoolManager's stack depth.
        "@uniswap/v4-core/src/ERC6909.sol",
        "@uniswap/v4-core/src/ERC6909Claims.sol",
        "@uniswap/v4-core/src/Extsload.sol",
        "@uniswap/v4-core/src/Exttload.sol",
        "@uniswap/v4-core/src/NoDelegateCall.sol",
        "@uniswap/v4-core/src/PoolManager.sol",
        "@uniswap/v4-core/src/ProtocolFees.sol",
        "@uniswap/v4-core/src/interfaces/IExtsload.sol",
        "@uniswap/v4-core/src/interfaces/IExttload.sol",
        "@uniswap/v4-core/src/interfaces/IHooks.sol",
        "@uniswap/v4-core/src/interfaces/IPoolManager.sol",
        "@uniswap/v4-core/src/interfaces/IProtocolFees.sol",
        "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol",
        "@uniswap/v4-core/src/interfaces/external/IERC20Minimal.sol",
        "@uniswap/v4-core/src/interfaces/external/IERC6909Claims.sol",
        "@uniswap/v4-core/src/libraries/BitMath.sol",
        "@uniswap/v4-core/src/libraries/CurrencyDelta.sol",
        "@uniswap/v4-core/src/libraries/CurrencyReserves.sol",
        "@uniswap/v4-core/src/libraries/CustomRevert.sol",
        "@uniswap/v4-core/src/libraries/FixedPoint128.sol",
        "@uniswap/v4-core/src/libraries/FixedPoint96.sol",
        "@uniswap/v4-core/src/libraries/FullMath.sol",
        "@uniswap/v4-core/src/libraries/Hooks.sol",
        "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol",
        "@uniswap/v4-core/src/libraries/LiquidityMath.sol",
        "@uniswap/v4-core/src/libraries/Lock.sol",
        "@uniswap/v4-core/src/libraries/NonzeroDeltaCount.sol",
        "@uniswap/v4-core/src/libraries/ParseBytes.sol",
        "@uniswap/v4-core/src/libraries/Pool.sol",
        "@uniswap/v4-core/src/libraries/Position.sol",
        "@uniswap/v4-core/src/libraries/ProtocolFeeLibrary.sol",
        "@uniswap/v4-core/src/libraries/SafeCast.sol",
        "@uniswap/v4-core/src/libraries/SqrtPriceMath.sol",
        "@uniswap/v4-core/src/libraries/StateLibrary.sol",
        "@uniswap/v4-core/src/libraries/SwapMath.sol",
        "@uniswap/v4-core/src/libraries/TickBitmap.sol",
        "@uniswap/v4-core/src/libraries/TickMath.sol",
        "@uniswap/v4-core/src/libraries/TransientStateLibrary.sol",
        "@uniswap/v4-core/src/libraries/UnsafeMath.sol",
        "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol",
        "@uniswap/v4-core/src/test/PoolSwapTest.sol",
        "@uniswap/v4-core/src/test/PoolTestBase.sol",
        "@uniswap/v4-core/src/types/BalanceDelta.sol",
        "@uniswap/v4-core/src/types/BeforeSwapDelta.sol",
        "@uniswap/v4-core/src/types/Currency.sol",
        "@uniswap/v4-core/src/types/PoolId.sol",
        "@uniswap/v4-core/src/types/PoolKey.sol",
        "@uniswap/v4-core/src/types/PoolOperation.sol",
        "@uniswap/v4-core/src/types/Slot0.sol",
        "@uniswap/v4-core/test/utils/CurrencySettler.sol",
      ].map((path) => [
        path,
        {
          version: "0.8.26",
          settings: {
            evmVersion: "cancun",
            viaIR: true,
            optimizer: { enabled: true, runs: 1 },
          },
        },
      ]),
    ),
  },
  mocha: {
    // Default (40s) is no longer reliably enough for a cold loadFixture
    // deploy — confirmed across several files this session (Ships.test.ts,
    // DroneEnergyCores.test.ts, others), most likely from the extra
    // artifact-loading overhead of the real Uniswap v4-core PoolManager
    // dependency (see UTCLotteryHookSwap.test.ts). A timed-out fixture call
    // doesn't actually cancel — it keeps running underneath — so a later
    // test's own loadFixture call collides with it and corrupts Hardhat
    // Ignition's nonce tracking for the rest of that process (IGN403),
    // cascading into unrelated-looking failures well past the real slow
    // point. Raising the timeout fixes the root cause, not just this file's
    // symptom.
    timeout: 120_000,
  },
  contractSizer: {
    alphaSort: true,
    disambiguatePaths: false,
    runOnCompile: true,
    strict: true,
    // only: [":ERC20$"],
  },
  etherscan: {
    // Single Etherscan.io API key → hardhat-verify uses API v2 (chainid param) for
    // all Etherscan-supported networks, including Base Sepolia (84532). Per-network
    // keys + custom explorer URLs force deprecated v1 endpoints.
    apiKey: ETHERSCAN_API_KEY,
    customChains: [
      {
        network: "base-sepolia",
        chainId: 84532,
        urls: {
          apiURL: "https://api-sepolia.basescan.org/v2/api",
          browserURL: "https://sepolia.basescan.org",
        },
      },
      {
        network: "flow",
        chainId: 747,
        urls: {
          apiURL: "https://evm.flowscan.io/api",
          browserURL: "https://evm.flowscan.io",
        },
      },
      {
        network: "flow-testnet",
        chainId: 545,
        urls: {
          apiURL: "https://evm-testnet.flowscan.io/api",
          browserURL: "https://evm-testnet.flowscan.io",
        },
      },
      {
        network: "ronin-saigon",
        chainId: 202601,
        urls: {
          apiURL: "https://saigon-testnet.roninchain.com/rpc",
          browserURL: "https://saigon-explorer.roninchain.com/",
        },
      },
      {
        network: "polygon-amoy",
        chainId: 80002,
        urls: {
          apiURL: "	https://polygon-amoy.drpc.org",
          browserURL: "https://amoy.polygonscan.com",
        },
      },
      {
        network: "xai-testnet",
        chainId: 37714555429,
        urls: {
          apiURL: "https://testnet-v2.xai-chain.net/rpc",
          browserURL: "https://testnet-explorer-v2.xai-chain.net",
        },
      },
    ],
  },
  networks: {
    // for testnet
    "base-sepolia": {
      url: process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org",
      accounts: [process.env.METAMASK_WALLET_1 as string],
      // The Ankr key in BASE_SEPOLIA_RPC_URL is shared with the frontend and
      // domain-allowlisted, so requests without a matching Origin header are
      // rejected ("Origin not allowed"). Send the frontend's own origin so
      // deploys/scripts can use the same key. Harmless on endpoints that
      // don't check it.
      httpHeaders: {
        Origin: process.env.RPC_ORIGIN || "https://www.voidtactics.xyz",
      },
    },
    "flow-testnet": {
      url: "https://testnet.evm.nodes.onflow.org",
      accounts: [process.env.METAMASK_WALLET_1 as string],
      gas: 500000,
    },
    "ronin-saigon": {
      url: "https://saigon-testnet.roninchain.com/rpc",
      accounts: [process.env.METAMASK_WALLET_1 as string],
      // Large Ignition deploys: default fee estimates can be "underpriced"; the tx may never
      // enter the mempool but Ignition still advances local nonce state → IGN411 on retry.
      ignition: {
        maxPriorityFeePerGas: 20_000_000_000n, // 20 gwei; raise if mempool still rejects
        maxFeePerGasLimit: 2_000_000_000_000n, // 2000 gwei ceiling for getNetworkFees guard only
      },
    },
    "polygon-amoy": {
      url: "https://polygon-amoy.drpc.org",
      accounts: [process.env.METAMASK_WALLET_1 as string],
    },
    "xai-testnet": {
      url: "https://testnet-v2.xai-chain.net/rpc",
      accounts: [process.env.METAMASK_WALLET_1 as string],
    },
    // CRITICAL: CHANGE NAMES CONTRACT ADDRESS BEFORE ADDING AND DEPLOYING ON MAINNET
  },
  gasReporter: {
    // currency: "USD",
    // L1: "ethereum",
    // L2: "base",
    // L1Etherscan: process.env.ETHERSCAN_API_KEY,
    // L2Etherscan: process.env.BASESCAN_API_KEY,
    // coinmarketcap: process.env.COINMARKETCAP_API_KEY,
    enabled: true,
  },
};

export default config;

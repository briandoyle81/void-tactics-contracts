import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers";
import hre from "hardhat";
import {
  getAddress,
  parseEther,
  zeroAddress,
  encodeAbiParameters,
  toFunctionSelector,
  keccak256,
} from "viem";
import { installHistoryContract, recordBlockHash } from "./fixtures/eip2935";
import DeployModule from "../ignition/modules/DeployAndConfig";
import { mineHookAddress, HOOK_FLAGS } from "../scripts/hookMiner";

// Real-swap integration test: a genuine Uniswap v4 PoolManager, the real
// official PoolSwapTest/PoolModifyLiquidityTest routers (from
// @uniswap/v4-core's own src/test), and UTCLotteryHook attached to an actual
// UTC/native pool — not a mocked/hand-rolled stand-in for any of it. Proves
// the hook's afterSwap logic fires correctly from a real swap, not just
// from directly calling internal-shaped test hooks.

const FEE = 3000; // 0.3%, standard tier
const TICK_SPACING = 60;
const MIN_TICK = -887272;
const MAX_TICK = 887272;
const MIN_USABLE_TICK = Math.trunc(MIN_TICK / TICK_SPACING) * TICK_SPACING;
const MAX_USABLE_TICK = Math.trunc(MAX_TICK / TICK_SPACING) * TICK_SPACING;
const SQRT_PRICE_1_1 = 79228162514264337593543950336n; // 2^96, tick 0
const MIN_SQRT_PRICE = 4295128739n;
const MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342n;

describe("UTCLotteryHook — real swap integration", function () {
  // The fixture runs the full DeployModule plus PoolManager/router/hook
  // setup — a lot of sequential transactions. The default 40s mocha timeout
  // isn't enough on a cold run, and — unlike an isolated single-file rerun —
  // an aborted first attempt here corrupts nonce tracking for every later
  // test in this same process, cascading into unrelated-looking failures.
  this.timeout(180_000);

  async function deployFixture() {
    const [deployerSigner, lp, trader, trader2, trader3] =
      await hre.viem.getWalletClients();
    const deployed = await hre.ignition.deploy(DeployModule);
    const ships = deployed.ships;
    const universalCredits = deployed.universalCredits;
    const randomManager = deployed.randomManager;

    const shipsOwnerAddress = getAddress(await ships.read.owner());
    const allClients = await hre.viem.getWalletClients();
    const ownerClient = allClients.find(
      (c) => getAddress(c.account.address) === shipsOwnerAddress,
    );
    if (!ownerClient) throw new Error("Could not resolve Ships owner");

    const shipsAsOwner = await hre.viem.getContractAt(
      "Ships",
      ships.address,
      { client: { wallet: ownerClient } },
    );
    const utcAsOwner = await hre.viem.getContractAt(
      "UniversalCredits",
      universalCredits.address,
      { client: { wallet: ownerClient } },
    );

    // Real v4 core: PoolManager + the official test routers, not mocks.
    const poolManager = await hre.viem.deployContract("PoolManager", [
      ownerClient.account.address,
    ]);
    const swapRouter = await hre.viem.deployContract("PoolSwapTest", [
      poolManager.address,
    ]);
    const liquidityRouter = await hre.viem.deployContract(
      "PoolModifyLiquidityTest",
      [poolManager.address],
    );
    const create2Deployer = await hre.viem.deployContract(
      "Create2Deployer",
      [],
    );

    const hookArtifact = await hre.artifacts.readArtifact("UTCLotteryHook");
    const flags = HOOK_FLAGS.BEFORE_INITIALIZE | HOOK_FLAGS.AFTER_SWAP;
    const { hookAddress, salt, initCode } = mineHookAddress({
      deployer: create2Deployer.address,
      flags,
      abi: hookArtifact.abi,
      bytecode: hookArtifact.bytecode as `0x${string}`,
      constructorArgs: [
        poolManager.address,
        ships.address,
        universalCredits.address,
        ownerClient.account.address,
      ],
    });
    await create2Deployer.write.deploy([initCode, salt]);
    const hook = await hre.viem.getContractAt("UTCLotteryHook", hookAddress);
    const hookAsOwner = await hre.viem.getContractAt(
      "UTCLotteryHook",
      hookAddress,
      { client: { wallet: ownerClient } },
    );

    await shipsAsOwner.write.setIsAllowedToCreateShips([hookAddress, true]);
    // Same as scripts/deployUTCLotteryPool.ts Step 13b: lottery prizes
    // bypass VariantPurchaseGate so any winner can receive any variant.
    const gateAsOwner = await hre.viem.getContractAt(
      "VariantPurchaseGate",
      deployed.variantPurchaseGate.address,
      { client: { wallet: ownerClient } },
    );
    await gateAsOwner.write.setExemptMinter([hookAddress, true]);

    // Fund LP + trader with real UTC, temporarily authorizing the owner to
    // mint it directly rather than routing through ShipPurchaser.
    await utcAsOwner.write.setAuthorizedToMint([ownerClient.account.address, true]);
    await utcAsOwner.write.mint([lp.account.address, parseEther("10000")]);
    for (const t of [trader, trader2, trader3]) {
      await utcAsOwner.write.mint([t.account.address, parseEther("1000")]);
    }

    const utcAsLp = await hre.viem.getContractAt(
      "UniversalCredits",
      universalCredits.address,
      { client: { wallet: lp } },
    );
    await utcAsLp.write.approve([liquidityRouter.address, parseEther("10000")]);

    const [utcAsTrader, utcAsTrader2, utcAsTrader3] = await Promise.all(
      [trader, trader2, trader3].map((t) =>
        hre.viem.getContractAt("UniversalCredits", universalCredits.address, {
          client: { wallet: t },
        }),
      ),
    );
    await utcAsTrader.write.approve([swapRouter.address, parseEther("1000")]);
    await utcAsTrader2.write.approve([swapRouter.address, parseEther("1000")]);
    await utcAsTrader3.write.approve([swapRouter.address, parseEther("1000")]);

    const key = {
      currency0: zeroAddress,
      currency1: getAddress(universalCredits.address),
      fee: FEE,
      tickSpacing: TICK_SPACING,
      hooks: getAddress(hookAddress),
    } as const;

    return {
      ownerClient,
      shipsAsOwner,
      gateAsOwner,
      lp,
      trader,
      trader2,
      trader3,
      ships,
      universalCredits,
      randomManager,
      poolManager,
      swapRouter,
      liquidityRouter,
      hook,
      hookAsOwner,
      key,
    };
  }

  it("locks onto the pool on initialize", async function () {
    const { poolManager, key, hook } = await loadFixture(deployFixture);

    await poolManager.write.initialize([key, SQRT_PRICE_1_1]);

    expect(await hook.read.poolLocked()).to.equal(true);
  });

  it("rejects a non-owner calling PoolManager.initialize on this hook's pool (HA2-02)", async function () {
    const { poolManager, key, hook, trader } = await loadFixture(deployFixture);

    // PoolManager.initialize is itself permissionless -- anyone can call it
    // for any PoolKey. Without the owner check, this would permanently lock
    // the hook to whichever caller gets there first. Here `trader` (not the
    // hook's owner) tries it directly.
    const poolManagerAsTrader = await hre.viem.getContractAt(
      "PoolManager",
      poolManager.address,
      { client: { wallet: trader } },
    );

    // Uniswap wraps a reverting hook's error in its own WrappedError(...)
    // (see @uniswap/v4-core's CustomRevert/Hooks.sol: bubbleUpAndRevertWith),
    // so a plain string match against "OwnableUnauthorizedAccount" won't be
    // found in the bubbled-up message -- the raw error selector IS present
    // in the wrapped revert data (confirmed manually), so assert on that
    // instead of the (unreadable, wrapped) decoded name.
    const ownableUnauthorizedSelector = toFunctionSelector(
      "OwnableUnauthorizedAccount(address)",
    ).slice(2);

    await expect(
      poolManagerAsTrader.write.initialize([key, SQRT_PRICE_1_1]),
    ).to.be.rejectedWith(ownableUnauthorizedSelector);

    expect(await hook.read.poolLocked()).to.equal(false);
  });

  it("records a qualifying sell from a real swap, crediting the trader named in hookData", async function () {
    const { poolManager, liquidityRouter, swapRouter, key, hook, lp, trader } =
      await loadFixture(deployFixture);

    await poolManager.write.initialize([key, SQRT_PRICE_1_1]);

    await liquidityRouter.write.modifyLiquidity(
      [
        key,
        {
          tickLower: MIN_USABLE_TICK,
          tickUpper: MAX_USABLE_TICK,
          liquidityDelta: parseEther("1"),
          salt: `0x${"0".repeat(64)}`,
        },
        "0x",
      ],
      { account: lp.account, value: parseEther("5") },
    );

    const hookData = encodeAbiParameters(
      [{ type: "address" }],
      [getAddress(trader.account.address)],
    );

    // zeroForOne = false: selling UTC (currency1) for native ETH
    // (currency0) — the direction the hook is supposed to record.
    await swapRouter.write.swap(
      [
        key,
        {
          zeroForOne: false,
          amountSpecified: -parseEther("10"),
          sqrtPriceLimitX96: MAX_SQRT_PRICE - 1n,
        },
        { takeClaims: false, settleUsingBurn: false },
        hookData,
      ],
      { account: trader.account },
    );

    expect(
      await hook.read.hasParticipated([0n, trader.account.address]),
    ).to.equal(true);
    const weight = await hook.read.weightInDraw([0n, trader.account.address]);
    expect(weight > 0n).to.equal(true);
    expect(await hook.read.totalWeightInDraw([0n])).to.equal(weight);
  });

  it("does not record a buy (native -> UTC)", async function () {
    const { poolManager, liquidityRouter, swapRouter, key, hook, lp, trader } =
      await loadFixture(deployFixture);

    await poolManager.write.initialize([key, SQRT_PRICE_1_1]);
    await liquidityRouter.write.modifyLiquidity(
      [
        key,
        {
          tickLower: MIN_USABLE_TICK,
          tickUpper: MAX_USABLE_TICK,
          liquidityDelta: parseEther("1"),
          salt: `0x${"0".repeat(64)}`,
        },
        "0x",
      ],
      { account: lp.account, value: parseEther("5") },
    );

    const hookData = encodeAbiParameters(
      [{ type: "address" }],
      [getAddress(trader.account.address)],
    );

    // zeroForOne = true: buying UTC with native ETH — must NOT record.
    await swapRouter.write.swap(
      [
        key,
        {
          zeroForOne: true,
          amountSpecified: -parseEther("0.01"),
          sqrtPriceLimitX96: MIN_SQRT_PRICE + 1n,
        },
        { takeClaims: false, settleUsingBurn: false },
        hookData,
      ],
      { account: trader.account, value: parseEther("1") },
    );

    expect(
      await hook.read.hasParticipated([0n, trader.account.address]),
    ).to.equal(false);
  });

  it("weights an address by its single best sell in the draw, not a sum — a lower later sell doesn't replace it", async function () {
    const { poolManager, liquidityRouter, swapRouter, key, hook, lp, trader } =
      await loadFixture(deployFixture);

    await poolManager.write.initialize([key, SQRT_PRICE_1_1]);
    // Much deeper liquidity than the other tests in this file use — this
    // test compares *relative* proceeds between a small and a large sell,
    // which needs a pool deep enough that a 20-token sell isn't itself
    // enough to exhaust reserves and distort the comparison.
    await liquidityRouter.write.modifyLiquidity(
      [
        key,
        {
          tickLower: MIN_USABLE_TICK,
          tickUpper: MAX_USABLE_TICK,
          liquidityDelta: parseEther("1000"),
          salt: `0x${"0".repeat(64)}`,
        },
        "0x",
      ],
      { account: lp.account, value: parseEther("2000") },
    );

    const hookData = encodeAbiParameters(
      [{ type: "address" }],
      [getAddress(trader.account.address)],
    );
    const testSettings = { takeClaims: false, settleUsingBurn: false };
    const sell = (amount: bigint) => ({
      zeroForOne: false,
      amountSpecified: -amount,
      sqrtPriceLimitX96: MAX_SQRT_PRICE - 1n,
    });

    // Small sell first.
    await swapRouter.write.swap(
      [key, sell(parseEther("1")), testSettings, hookData],
      { account: trader.account },
    );
    const weightAfterSmall = await hook.read.weightInDraw([
      0n,
      trader.account.address,
    ]);

    // Bigger sell — should replace (raise) the recorded weight.
    await swapRouter.write.swap(
      [key, sell(parseEther("20")), testSettings, hookData],
      { account: trader.account },
    );
    const weightAfterBig = await hook.read.weightInDraw([
      0n,
      trader.account.address,
    ]);
    expect(weightAfterBig > weightAfterSmall).to.equal(true);
    expect(await hook.read.totalWeightInDraw([0n])).to.equal(weightAfterBig);

    // Small sell again — must NOT reduce the already-recorded (higher) weight.
    await swapRouter.write.swap(
      [key, sell(parseEther("1")), testSettings, hookData],
      { account: trader.account },
    );
    const weightAfterSecondSmall = await hook.read.weightInDraw([
      0n,
      trader.account.address,
    ]);
    expect(weightAfterSecondSmall).to.equal(weightAfterBig);
    expect(await hook.read.totalWeightInDraw([0n])).to.equal(weightAfterBig);
  });

  describe("draw eligibility gating", function () {
    it("defaults: drawInterval 24h, minParticipants 3, minTotalWeightWei 0", async function () {
      const { hook } = await loadFixture(deployFixture);
      expect(await hook.read.drawInterval()).to.equal(24n * 60n * 60n);
      expect(await hook.read.minParticipants()).to.equal(3n);
      expect(await hook.read.minTotalWeightWei()).to.equal(0n);
    });

    // HA2-06 (docs/audit-2.md)
    it("defaults: maxWeightPerEntryWei 1 ETH, maxWinProbabilityDenominator 10", async function () {
      const { hook } = await loadFixture(deployFixture);
      expect(await hook.read.maxWeightPerEntryWei()).to.equal(parseEther("1"));
      expect(await hook.read.maxWinProbabilityDenominator()).to.equal(10n);
    });

    it("drawInterval/minParticipants/minTotalWeightWei setters are owner-only", async function () {
      const { hook, trader } = await loadFixture(deployFixture);
      const asTrader = await hre.viem.getContractAt(
        "UTCLotteryHook",
        hook.address,
        { client: { wallet: trader } },
      );
      await expect(
        asTrader.write.setDrawInterval([1n]),
      ).to.be.rejectedWith("OwnableUnauthorizedAccount");
      await expect(
        asTrader.write.setMinParticipants([1n]),
      ).to.be.rejectedWith("OwnableUnauthorizedAccount");
      await expect(
        asTrader.write.setMinTotalWeightWei([1n]),
      ).to.be.rejectedWith("OwnableUnauthorizedAccount");
    });

    // HA2-06 (docs/audit-2.md)
    it("maxWeightPerEntryWei/maxWinProbabilityDenominator setters are owner-only", async function () {
      const { hook, trader } = await loadFixture(deployFixture);
      const asTrader = await hre.viem.getContractAt(
        "UTCLotteryHook",
        hook.address,
        { client: { wallet: trader } },
      );
      await expect(
        asTrader.write.setMaxWeightPerEntryWei([1n]),
      ).to.be.rejectedWith("OwnableUnauthorizedAccount");
      await expect(
        asTrader.write.setMaxWinProbabilityDenominator([1n]),
      ).to.be.rejectedWith("OwnableUnauthorizedAccount");
    });

    // HA2-06 (docs/audit-2.md): a single sell's *recorded weight* is capped
    // at maxWeightPerEntryWei even when its real, uncapped proceeds
    // (reported separately in the SellRecorded event) are much higher —
    // bounds how much one trade (flash-loaned or genuine) can inflate one
    // address's odds.
    it("caps recorded weight at maxWeightPerEntryWei, independent of real (uncapped) sell proceeds", async function () {
      const fixture = await loadFixture(deployFixture);
      const { hookAsOwner, hook, liquidityRouter, key, lp, trader } = fixture;
      await setUpPoolAndLiquidity(fixture);
      // Deep liquidity so a real, large sell doesn't itself get starved by
      // slippage down near the cap -- this test needs proceeds to clearly
      // exceed the cap to prove clamping actually happened.
      await liquidityRouter.write.modifyLiquidity(
        [
          key,
          {
            tickLower: MIN_USABLE_TICK,
            tickUpper: MAX_USABLE_TICK,
            liquidityDelta: parseEther("1000"),
            salt: `0x${"1".repeat(64)}`,
          },
          "0x",
        ],
        { account: lp.account, value: parseEther("2000") },
      );
      await hookAsOwner.write.setMaxWeightPerEntryWei([parseEther("2")]);
      const sellAs = makeSellAs(fixture);

      // A real sell whose actual proceeds are well above the 2 ETH cap.
      await sellAs(trader, parseEther("50"));

      const weight = await hook.read.weightInDraw([0n, trader.account.address]);
      expect(weight).to.equal(parseEther("2"));
      expect(await hook.read.totalWeightInDraw([0n])).to.equal(parseEther("2"));
    });

    it("does not start a draw with fewer than minParticipants sellers, and keeps running (no reset) until a 3rd distinct seller shows up — even past drawInterval", async function () {
      const fixture = await loadFixture(deployFixture);
      const { hook, liquidityRouter, key, lp, trader, trader2, trader3 } =
        fixture;
      await setUpPoolAndLiquidity(fixture);
      // Deeper than the shared default — this test's final (eligibility-
      // completing) sell has to itself clear minEntryThresholdWei after
      // several prior sells, which a thin pool can't reliably do.
      await liquidityRouter.write.modifyLiquidity(
        [
          key,
          {
            tickLower: MIN_USABLE_TICK,
            tickUpper: MAX_USABLE_TICK,
            liquidityDelta: parseEther("1000"),
            salt: `0x${"1".repeat(64)}`,
          },
          "0x",
        ],
        { account: lp.account, value: parseEther("2000") },
      );
      const sellAs = makeSellAs(fixture);

      await sellAs(trader);
      await sellAs(trader2);
      expect(await hook.read.currentDrawId()).to.equal(0n);

      await hre.network.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
      await hre.network.provider.send("evm_mine");

      // Past the interval, but still only 2 distinct participants (trader
      // selling again doesn't add a new one) — must not start.
      await sellAs(trader);
      expect(await hook.read.currentDrawId()).to.equal(0n);
      expect(await hook.read.drawResolved([0n])).to.equal(false);

      // A genuinely 3rd distinct participant finally satisfies eligibility —
      // same draw (id 0) just kept accumulating the whole time, no reset.
      await sellAs(trader3);
      expect(await hook.read.currentDrawId()).to.equal(1n);
    });

    it("does not start a draw below minTotalWeightWei even with enough participants", async function () {
      const fixture = await loadFixture(deployFixture);
      const { hookAsOwner, hook, liquidityRouter, key, lp, trader, trader2, trader3 } =
        fixture;
      await setUpPoolAndLiquidity(fixture);
      await liquidityRouter.write.modifyLiquidity(
        [
          key,
          {
            tickLower: MIN_USABLE_TICK,
            tickUpper: MAX_USABLE_TICK,
            liquidityDelta: parseEther("1000"),
            salt: `0x${"1".repeat(64)}`,
          },
          "0x",
        ],
        { account: lp.account, value: parseEther("2000") },
      );
      await hookAsOwner.write.setMinTotalWeightWei([parseEther("5")]);
      // This test is about minTotalWeightWei gating specifically, not the
      // HA2-06 per-entry weight cap (default 1 ETH) — raise the cap so the
      // "big sell" below isn't itself clamped below the 5 ETH bar it's
      // meant to cross.
      await hookAsOwner.write.setMaxWeightPerEntryWei([parseEther("20")]);
      const sellAs = makeSellAs(fixture);

      // Three small sells, each just over minEntryThresholdWei (0.01 ETH)
      // but nowhere near the 5 ETH minTotalWeightWei bar.
      await sellAs(trader, parseEther("0.1"));
      await sellAs(trader2, parseEther("0.1"));
      await sellAs(trader3, parseEther("0.1"));

      await hre.network.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
      await hre.network.provider.send("evm_mine");

      // Enough participants, still not enough total volume — must not start.
      await sellAs(trader, parseEther("0.1"));
      expect(await hook.read.currentDrawId()).to.equal(0n);

      // A big sell finally clears the total-volume bar.
      await sellAs(trader, parseEther("10"));
      expect(await hook.read.currentDrawId()).to.equal(1n);
    });

    it("setDrawInterval changes how long a draw must wait before it's even checked", async function () {
      const fixture = await loadFixture(deployFixture);
      const { hookAsOwner, hook, trader, trader2, trader3 } = fixture;
      await setUpPoolAndLiquidity(fixture);
      await hookAsOwner.write.setDrawInterval([60n]); // 1 minute, not 24h
      const sellAs = makeSellAs(fixture);

      await sellAs(trader);
      await sellAs(trader2);
      await sellAs(trader3);

      await hre.network.provider.send("evm_increaseTime", [61]);
      await hre.network.provider.send("evm_mine");

      await sellAs(trader);
      expect(await hook.read.currentDrawId()).to.equal(1n);
    });

    // HA2-06 (docs/audit-2.md): with maxWinProbabilityDenominator set very
    // high relative to maxWeightPerEntryWei, resolveDraw's effective
    // denominator (maxWinProbabilityDenominator * maxWeightPerEntryWei)
    // vastly exceeds RandomManager's uint64 randomness range — once that
    // product exceeds 2^64, the modulo becomes a no-op, so the "phantom
    // zone" probability is bounded by 1 - totalWeight/2^64, not by how
    // extreme these parameters get. With tiny real weight (three sells
    // just clearing minEntryThresholdWei), that ceiling is ~99.8% per
    // attempt. Two independent attempts drive the chance that *both*
    // happen to land on a real winner down to roughly (0.2%)^2 ~= 4e-6 —
    // an acceptable, disclosed residual flake probability for a genuinely
    // random on-chain outcome, not a design flaw.
    it("resolves with no winner when the random pick lands in the probability-cap's phantom zone", async function () {
      const fixture = await loadFixture(deployFixture);
      const { hookAsOwner, hook, ships, trader, trader2, trader3 } = fixture;
      await setUpPoolAndLiquidity(fixture);
      await hookAsOwner.write.setMaxWinProbabilityDenominator([
        10n ** 15n,
      ]);
      const sellAs = makeSellAs(fixture);
      const sellers = [trader, trader2, trader3];

      let sawNoWinner = false;
      for (let attempt = 0; attempt < 2 && !sawNoWinner; attempt++) {
        for (const seller of sellers) {
          await sellAs(seller, parseEther("0.02"));
        }
        await hre.network.provider.send("evm_increaseTime", [
          24 * 60 * 60 + 1,
        ]);
        await hre.network.provider.send("evm_mine");
        await sellAs(trader, parseEther("0.02"));

        const drawId = BigInt(attempt);
        expect(await hook.read.currentDrawId()).to.equal(drawId + 1n);

        const shipCountsBefore = await Promise.all(
          sellers.map((s) => ships.read.getShipIdsOwned([s.account.address])),
        );

        await hre.network.provider.send("evm_mine");
        await hook.write.resolveDraw([drawId]);
        expect(await hook.read.drawResolved([drawId])).to.equal(true);

        const noWinnerEvents = await hook.getEvents.DrawResolvedNoWinner();
        const thisAttemptNoWinner = noWinnerEvents.some(
          (e: any) => e.args.drawId === drawId,
        );

        const shipCountsAfter = await Promise.all(
          sellers.map((s) => ships.read.getShipIdsOwned([s.account.address])),
        );
        const anyoneWon = shipCountsAfter.some(
          (after, i) => after.length > shipCountsBefore[i].length,
        );

        // The event and the ship-count observation must always agree.
        expect(thisAttemptNoWinner).to.equal(!anyoneWon);
        sawNoWinner = thisAttemptNoWinner;
      }

      expect(sawNoWinner).to.equal(true);
    });
  });

  const validTemplate = {
    variant: 1,
    colors: {
      h1: 45,
      s1: 100,
      l1: 50,
      h2: 45,
      s2: 100,
      l2: 50,
      h3: 45,
      s3: 100,
      l3: 50,
    },
    accuracy: 2,
    hull: 2,
    speed: 2,
    mainWeapon: 0, // MainWeapon.Generic
    armor: 3, // Armor.Heavy
    shields: 0, // Shields.None
    special: 0, // Special.None
  };

  async function setUpPoolAndLiquidity(
    fixture: Awaited<ReturnType<typeof deployFixture>>,
  ) {
    const { poolManager, liquidityRouter, key, lp } = fixture;
    await poolManager.write.initialize([key, SQRT_PRICE_1_1]);
    await liquidityRouter.write.modifyLiquidity(
      [
        key,
        {
          tickLower: MIN_USABLE_TICK,
          tickUpper: MAX_USABLE_TICK,
          liquidityDelta: parseEther("1"),
          salt: `0x${"0".repeat(64)}`,
        },
        "0x",
      ],
      { account: lp.account, value: parseEther("5") },
    );
  }

  // Shared qualifying-sell helper: seller sells `amount` UTC for native ETH,
  // hookData naming them as the trader.
  function makeSellAs(fixture: Awaited<ReturnType<typeof deployFixture>>) {
    const { swapRouter, key } = fixture;
    return async (
      seller: { account: { address: `0x${string}` } },
      amount: bigint = parseEther("10"),
    ) => {
      const hookData = encodeAbiParameters(
        [{ type: "address" }],
        [getAddress(seller.account.address)],
      );
      await swapRouter.write.swap(
        [
          key,
          {
            zeroForOne: false,
            amountSpecified: -amount,
            sqrtPriceLimitX96: MAX_SQRT_PRICE - 1n,
          },
          { takeClaims: false, settleUsingBurn: false },
          hookData,
        ],
        { account: seller.account },
      );
    };
  }

  // Meets the default minParticipants (3) with three distinct qualifying
  // sellers, then triggers and resolves the draw. Returns the winner's
  // address — with 3 possible winners now (not just `trader`), callers
  // can't assume who it is and must check.
  async function runFullDrawCycle(
    fixture: Awaited<ReturnType<typeof deployFixture>>,
  ): Promise<`0x${string}`> {
    const { hook, hookAsOwner, ships, trader, trader2, trader3 } = fixture;
    const sellers = [trader, trader2, trader3];
    const sellAs = makeSellAs(fixture);

    // This helper tests the prize-minting flow, not the HA2-06
    // no-winner/probability-cap mechanic — neutralize it deterministically,
    // independent of this pool's actual slippage-affected sell proceeds.
    // With the cap set to exactly minEntryThresholdWei, every qualifying
    // sell (by definition >= that threshold) clamps to the same value, so
    // totalWeight for N sellers is always exactly N * cap; with K=1,
    // effectiveTotalWeight = max(N*cap, 1*cap) = N*cap = totalWeight
    // exactly, for any N >= 1 — zero phantom ("no winner") zone,
    // deterministically. (K=1 alone isn't enough here: this fixture's pool
    // is thin enough that real per-sell proceeds land under the *default*
    // 1 ETH cap already, so effectiveTotalWeight would still be floored
    // above the real total without also lowering the cap itself.)
    await hookAsOwner.write.setMaxWeightPerEntryWei([
      await hook.read.minEntryThresholdWei(),
    ]);
    await hookAsOwner.write.setMaxWinProbabilityDenominator([1n]);

    for (const seller of sellers) {
      await sellAs(seller);
    }
    expect(await hook.read.currentDrawId()).to.equal(0n);

    const shipCountsBefore = await Promise.all(
      sellers.map((s) => ships.read.getShipIdsOwned([s.account.address])),
    );

    // Past drawInterval. Time alone isn't enough to start a draw — it also
    // needs >= minParticipants and >= minTotalWeightWei, both already met
    // by the three sells above.
    await hre.network.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
    await hre.network.provider.send("evm_mine");

    // Any qualifying swap after the interval (now that eligibility is also
    // met) triggers the draw start.
    await sellAs(trader);
    expect(await hook.read.currentDrawId()).to.equal(1n);
    expect(await hook.read.drawCloseBlock([0n])).to.not.equal(0n);

    // RandomManager needs a genuinely new prevrandao epoch since the
    // request's commit block before it can be revealed.
    await hre.network.provider.send("evm_mine");

    await hook.write.resolveDraw([0n]);
    expect(await hook.read.drawResolved([0n])).to.equal(true);

    const shipCountsAfter = await Promise.all(
      sellers.map((s) => ships.read.getShipIdsOwned([s.account.address])),
    );
    const winnerIndex = shipCountsAfter.findIndex(
      (after, i) => after.length > shipCountsBefore[i].length,
    );
    expect(winnerIndex).to.not.equal(-1);
    return getAddress(sellers[winnerIndex].account.address);
  }

  it("runs a full draw cycle with a queued template: sell -> 24h -> trigger -> resolve -> hand-crafted ship minted", async function () {
    const fixture = await loadFixture(deployFixture);
    const { hookAsOwner, ships } = fixture;
    await setUpPoolAndLiquidity(fixture);
    await hookAsOwner.write.queuePrizeTemplate([validTemplate]);

    const winner = await runFullDrawCycle(fixture);

    const winnerShipIds = await ships.read.getShipIdsOwned([winner]);
    expect(winnerShipIds.length).to.equal(1);

    // Hand-crafted via createSpecificShip, not the generic random path —
    // confirms _buildPrizeShip actually ran, not just that some ship exists.
    const prizeShip = await ships.read.getShip([winnerShipIds[0]]);
    expect(prizeShip.name).to.equal("Legendary Draw #0");
    expect(prizeShip.shipData.shiny).to.equal(true);
    expect(prizeShip.traits.accuracy).to.equal(2);
    expect(prizeShip.traits.hull).to.equal(2);
    expect(prizeShip.traits.speed).to.equal(2);
    expect(await hookAsOwner.read.queueLength()).to.equal(0n);
  });

  it("delivers the prize to a winner contract that rejects ERC-721 receipt (HA4-02, HA6-04)", async function () {
    // Regression test for docs/audit-2.md HA4-02: _extractPlayer trusts
    // whatever address hookData names, with no check it's related to the
    // real swap signer — any seller can credit a contract that reverts on
    // ERC-721 receipt as the "winner." Before the fix, resolveDraw's mint
    // call was unguarded, so a picked winner like that would revert the
    // whole transaction forever (fulfillRandomRequest returns the same
    // fixed value on every retry, so the same winner is picked every time).
    // Since docs/audit-3.md HA6-04, Ships mints with _mint (no
    // onERC721Received call), so such a winner now simply receives the
    // prize and the draw resolves normally.
    const fixture = await loadFixture(deployFixture);
    const { hook, hookAsOwner, trader, trader2, ships } = fixture;
    await setUpPoolAndLiquidity(fixture);

    const poison = await hre.viem.deployContract("MockNonReceivingContract");

    // minParticipants=1 makes the single credited entry the draw's ONLY
    // participant, so it's picked with certainty — no probabilistic
    // "which of several participants wins" ambiguity to work around.
    await hookAsOwner.write.setMinParticipants([1n]);
    // Same neutralization runFullDrawCycle uses: floors effectiveTotalWeight
    // to exactly totalWeight, so there's no "no winner" zone to land in.
    await hookAsOwner.write.setMaxWeightPerEntryWei([
      await hook.read.minEntryThresholdWei(),
    ]);
    await hookAsOwner.write.setMaxWinProbabilityDenominator([1n]);

    // trader sells, but hookData credits `poison` as the player — exactly
    // the attack _extractPlayer's lack of a signer check allows.
    const poisonHookData = encodeAbiParameters(
      [{ type: "address" }],
      [getAddress(poison.address)],
    );
    await fixture.swapRouter.write.swap(
      [
        fixture.key,
        {
          zeroForOne: false,
          amountSpecified: -parseEther("10"),
          sqrtPriceLimitX96: MAX_SQRT_PRICE - 1n,
        },
        { takeClaims: false, settleUsingBurn: false },
        poisonHookData,
      ],
      { account: trader.account },
    );
    expect(await hook.read.currentDrawId()).to.equal(0n);

    // Any qualifying sell after the interval closes draw 0 and starts draw
    // 1 — but this triggering sell is itself recorded into draw 0 BEFORE
    // the draw index advances, so it credits `poison` too (a different real
    // signer, trader2, but the same attributed player) rather than a second
    // real address, which would otherwise dilute the single-participant
    // setup above into a coin flip between poison and a real winner.
    await hre.network.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
    await hre.network.provider.send("evm_mine");
    await fixture.swapRouter.write.swap(
      [
        fixture.key,
        {
          zeroForOne: false,
          amountSpecified: -parseEther("10"),
          sqrtPriceLimitX96: MAX_SQRT_PRICE - 1n,
        },
        { takeClaims: false, settleUsingBurn: false },
        poisonHookData,
      ],
      { account: trader2.account },
    );
    expect(await hook.read.currentDrawId()).to.equal(1n);

    await hre.network.provider.send("evm_mine");

    // Must NOT revert — this is the actual fix under test.
    await hook.write.resolveDraw([0n]);
    expect(await hook.read.drawResolved([0n])).to.equal(true);

    const resolvedEvents = await hook.getEvents.DrawResolved();
    const resolved = resolvedEvents.find((e) => e.args.drawId === 0n);
    expect(resolved).to.not.be.undefined;
    expect(getAddress(resolved!.args.winner!)).to.equal(
      getAddress(poison.address),
    );
    expect(
      (await ships.read.getShipIdsOwned([poison.address])).length,
    ).to.equal(1);
  });

  it("a failed prize mint reverts resolveDraw and leaves the draw open for retry (HA6-06)", async function () {
    // Regression test for docs/audit-3.md HA6-06: the prize mint used to be
    // wrapped in try/catch after drawResolved was set, so any mint failure
    // (a paused Ships here; a caller starving the mint of gas in the attack)
    // finalized the draw with the winner getting nothing. Now the failure
    // reverts the whole call and the draw can be resolved once it's fixed.
    const fixture = await loadFixture(deployFixture);
    const { hook, hookAsOwner, ships, shipsAsOwner, trader, trader2, trader3 } =
      fixture;
    await setUpPoolAndLiquidity(fixture);
    const sellers = [trader, trader2, trader3];
    const sellAs = makeSellAs(fixture);

    // Same deterministic no-phantom-zone setup as runFullDrawCycle.
    await hookAsOwner.write.setMaxWeightPerEntryWei([
      await hook.read.minEntryThresholdWei(),
    ]);
    await hookAsOwner.write.setMaxWinProbabilityDenominator([1n]);
    for (const seller of sellers) {
      await sellAs(seller);
    }
    const before = await Promise.all(
      sellers.map((s) => ships.read.getShipIdsOwned([s.account.address])),
    );
    await hre.network.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
    await hre.network.provider.send("evm_mine");
    await sellAs(trader);
    expect(await hook.read.currentDrawId()).to.equal(1n);
    await hre.network.provider.send("evm_mine");

    await shipsAsOwner.write.setPaused([true]);
    await expect(hook.write.resolveDraw([0n])).to.be.rejectedWith(
      "MintPaused",
    );
    expect(await hook.read.drawResolved([0n])).to.equal(false);

    await shipsAsOwner.write.setPaused([false]);
    await hook.write.resolveDraw([0n]);
    expect(await hook.read.drawResolved([0n])).to.equal(true);

    const after = await Promise.all(
      sellers.map((s) => ships.read.getShipIdsOwned([s.account.address])),
    );
    const winners = after.filter((a, i) => a.length > before[i].length);
    expect(winners.length).to.equal(1);
    const resolved = (await hook.getEvents.DrawResolved()).find(
      (e) => e.args.drawId === 0n,
    );
    expect(resolved).to.not.be.undefined;
  });

  it("any winner receives a purchase-gated prize variant, medal or not (HA6-06)", async function () {
    const fixture = await loadFixture(deployFixture);
    const { hook, hookAsOwner, ships, gateAsOwner, trader, trader2, trader3 } =
      fixture;
    await setUpPoolAndLiquidity(fixture);
    const sellers = [trader, trader2, trader3];
    const sellAs = makeSellAs(fixture);

    // Variant 2 is gated on the Shattered Hive medal, which none of the
    // sellers hold. Make it the fallback prize.
    await hookAsOwner.write.setFallbackVariant([2]);

    await hookAsOwner.write.setMaxWeightPerEntryWei([
      await hook.read.minEntryThresholdWei(),
    ]);
    await hookAsOwner.write.setMaxWinProbabilityDenominator([1n]);
    for (const seller of sellers) {
      await sellAs(seller);
    }
    const before = await Promise.all(
      sellers.map((s) => ships.read.getShipIdsOwned([s.account.address])),
    );
    await hre.network.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
    await hre.network.provider.send("evm_mine");
    await sellAs(trader);
    await hre.network.provider.send("evm_mine");

    // Control: without the hook's exemption the gate blocks the prize, and
    // the draw stays open rather than burning it.
    const hookAddress = hook.address;
    await gateAsOwner.write.setExemptMinter([hookAddress, false]);
    await expect(hook.write.resolveDraw([0n])).to.be.rejectedWith(
      "GateRequirementNotMet",
    );
    expect(await hook.read.drawResolved([0n])).to.equal(false);

    await gateAsOwner.write.setExemptMinter([hookAddress, true]);
    await hook.write.resolveDraw([0n]);

    const after = await Promise.all(
      sellers.map((s) => ships.read.getShipIdsOwned([s.account.address])),
    );
    const winnerIdx = after.findIndex((a, i) => a.length > before[i].length);
    expect(winnerIdx).to.not.equal(-1);
    const prizeId = after[winnerIdx][after[winnerIdx].length - 1];
    const prize = await ships.read.getShip([prizeId]);
    expect(prize.traits.variant).to.equal(2);
  });

  it("falls back to a random 4-star ship when the queue is empty", async function () {
    const fixture = await loadFixture(deployFixture);
    const { ships } = fixture;
    await setUpPoolAndLiquidity(fixture);
    // Queue deliberately left empty.

    const winner = await runFullDrawCycle(fixture);

    const winnerShipIds = await ships.read.getShipIdsOwned([winner]);
    expect(winnerShipIds.length).to.equal(1);

    // createShips(winner, 1, fallbackVariant, 4, false) gives the single
    // minted ship rank 5 (Ships._getKillsForRank(5) == 300), the same top
    // rank a real tier-4 pack's first ship gets — and it's NOT hand-crafted,
    // so it's still unconstructed (no name/stats revealed yet).
    const prizeShip = await ships.read.getShip([winnerShipIds[0]]);
    expect(prizeShip.shipData.shipsDestroyed).to.equal(300);
    expect(prizeShip.shipData.constructed).to.equal(false);
    expect(prizeShip.name).to.equal("");
  });

  describe("close-block randomness and automatic resolution (HA6-05/HA6-07)", function () {
    // Three sellers enter draw 0, then 24h passes; the next qualifying
    // sell closes it. Cap == min entry and denominator 1 remove the no-winner
    // zone, so every resolution has a winner.
    async function prepareClosableDraw() {
      const fixture = await loadFixture(deployFixture);
      const { hook, hookAsOwner, trader, trader2, trader3 } = fixture;
      await setUpPoolAndLiquidity(fixture);
      await hookAsOwner.write.setMaxWeightPerEntryWei([
        await hook.read.minEntryThresholdWei(),
      ]);
      await hookAsOwner.write.setMaxWinProbabilityDenominator([1n]);
      const sellAs = makeSellAs(fixture);
      for (const seller of [trader, trader2, trader3]) {
        await sellAs(seller);
      }
      await hre.network.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
      await hre.network.provider.send("evm_mine");
      return fixture;
    }

    // A qualifying sell with an explicit gas limit (skips estimation, which
    // would otherwise size the tx without room for the auto-resolve).
    async function sellWithGas(
      fixture: Awaited<ReturnType<typeof deployFixture>>,
      seller: { account: any },
      gas: bigint,
    ) {
      const { swapRouter, key } = fixture;
      return swapRouter.write.swap(
        [
          key,
          {
            zeroForOne: false,
            amountSpecified: -parseEther("10"),
            sqrtPriceLimitX96: MAX_SQRT_PRICE - 1n,
          },
          { takeClaims: false, settleUsingBurn: false },
          encodeAbiParameters(
            [{ type: "address" }],
            [getAddress(seller.account.address)],
          ),
        ],
        { account: seller.account, gas },
      );
    }

    it("picks the winner from the close block's hash, with the pick's denominator snapshotted at close", async function () {
      const fixture = await prepareClosableDraw();
      const { hook, hookAsOwner, ships, trader } = fixture;
      await makeSellAs(fixture)(trader); // closes draw 0
      const closeBlock = await hook.read.drawCloseBlock([0n]);
      expect(closeBlock).to.not.equal(0n);
      const snapshot = await hook.read.drawEffectiveTotalWeight([0n]);
      expect(snapshot).to.equal(await hook.read.totalWeightInDraw([0n]));

      // Owner changes after close (when the close hash is already public)
      // must not affect this draw.
      await hookAsOwner.write.setMaxWinProbabilityDenominator([10n]);
      await hookAsOwner.write.setMaxWeightPerEntryWei([parseEther("1")]);

      const publicClient = await hre.viem.getPublicClient();
      const { hash } = await publicClient.getBlock({ blockNumber: closeBlock });
      const target =
        BigInt(
          keccak256(
            encodeAbiParameters(
              [{ type: "bytes32" }, { type: "uint256" }],
              [hash!, 0n],
            ),
          ),
        ) % snapshot;
      let expected: `0x${string}` | undefined;
      let cumulative = 0n;
      for (let i = 0n; i < 3n; i++) {
        const p = await hook.read.drawParticipants([0n, i]);
        cumulative += await hook.read.weightInDraw([0n, p]);
        if (expected === undefined && target < cumulative) expected = p;
      }

      await hook.write.resolveDraw([0n]);
      const resolved = (await hook.getEvents.DrawResolved()).find(
        (e) => e.args.drawId === 0n,
      );
      expect(getAddress(resolved!.args.winner!)).to.equal(getAddress(expected!));
      expect(
        (await ships.read.getShipIdsOwned([expected!])).length,
      ).to.be.greaterThan(0);
    });

    it("can't be resolved in the block that closes it", async function () {
      const fixture = await prepareClosableDraw();
      const { hook, trader, trader2 } = fixture;
      const publicClient = await hre.viem.getPublicClient();

      // Close and attempt resolution in the same block.
      await hre.network.provider.send("evm_setAutomine", [false]);
      try {
        const closeTx = await sellWithGas(fixture, trader, 3_000_000n);
        const hookAsTrader2 = await hre.viem.getContractAt(
          "UTCLotteryHook",
          hook.address,
          { client: { wallet: trader2 } },
        );
        const resolveTx = await hookAsTrader2.write.resolveDraw([0n], {
          gas: 3_000_000n,
        });
        await hre.network.provider.send("evm_mine");
        const closeReceipt = await publicClient.getTransactionReceipt({ hash: closeTx });
        const resolveReceipt = await publicClient.getTransactionReceipt({ hash: resolveTx });
        expect(closeReceipt.blockNumber).to.equal(resolveReceipt.blockNumber);
        expect(closeReceipt.status).to.equal("success");
        expect(resolveReceipt.status).to.equal("reverted");
      } finally {
        await hre.network.provider.send("evm_setAutomine", [true]);
      }
      expect(await hook.read.drawCloseBlock([0n])).to.not.equal(0n);
      expect(await hook.read.drawResolved([0n])).to.equal(false);

      // Any later block resolves it.
      await hook.write.resolveDraw([0n]);
      expect(await hook.read.drawResolved([0n])).to.equal(true);
    });

    it("the next swap in a later block resolves the draw automatically", async function () {
      const fixture = await prepareClosableDraw();
      const { hook, trader, trader2 } = fixture;
      await makeSellAs(fixture)(trader); // closes draw 0
      expect(await hook.read.drawResolved([0n])).to.equal(false);

      await sellWithGas(fixture, trader2, 5_000_000n);
      expect(await hook.read.drawResolved([0n])).to.equal(true);
      expect(await hook.read.nextDrawToResolve()).to.equal(1n);
      const resolved = (await hook.getEvents.DrawResolved()).find(
        (e) => e.args.drawId === 0n,
      );
      expect(resolved).to.not.be.undefined;
    });

    it("a failing automatic resolution never reverts the swap; the draw stays pending", async function () {
      const fixture = await prepareClosableDraw();
      const { hook, shipsAsOwner, trader, trader2 } = fixture;
      await makeSellAs(fixture)(trader); // closes draw 0

      await shipsAsOwner.write.setPaused([true]);
      await sellWithGas(fixture, trader2, 5_000_000n); // must not revert
      expect(await hook.read.drawResolved([0n])).to.equal(false);

      await shipsAsOwner.write.setPaused([false]);
      await sellWithGas(fixture, trader2, 5_000_000n);
      expect(await hook.read.drawResolved([0n])).to.equal(true);
    });

    it("skips automatic resolution on a swap with less than autoResolveMinGas left", async function () {
      const fixture = await prepareClosableDraw();
      const { hook, trader, trader2 } = fixture;
      await makeSellAs(fixture)(trader); // closes draw 0

      await sellWithGas(fixture, trader2, 700_000n);
      expect(await hook.read.drawResolved([0n])).to.equal(false);
    });

    it("re-targets a draw left unresolved past the 256-block blockhash window", async function () {
      const fixture = await prepareClosableDraw();
      const { hook, trader } = fixture;
      await makeSellAs(fixture)(trader); // closes draw 0
      const originalCloseBlock = await hook.read.drawCloseBlock([0n]);

      await hre.network.provider.send("hardhat_mine", ["0x12c"]); // 300 blocks
      await hook.write.resolveDraw([0n]);
      expect(await hook.read.drawResolved([0n])).to.equal(false);
      const retargeted = await hook.read.drawCloseBlock([0n]);
      expect(retargeted > originalCloseBlock).to.equal(true);
      const events = await hook.getEvents.DrawRetargeted();
      expect(events.find((e) => e.args.drawId === 0n)).to.not.be.undefined;

      await hook.write.resolveDraw([0n]);
      expect(await hook.read.drawResolved([0n])).to.equal(true);
    });

    // 2026-10-16: with a working EIP-2935 history contract (as on Base) the
    // close block's hash stays readable for 8191 blocks (BlockHashLib).
    it("with EIP-2935, resolves a draw left unresolved past 256 blocks without re-targeting", async function () {
      const fixture = await prepareClosableDraw();
      const { hook, trader } = fixture;
      await installHistoryContract();
      await makeSellAs(fixture)(trader); // closes draw 0
      const closeBlock = await hook.read.drawCloseBlock([0n]);
      await recordBlockHash(closeBlock);

      await hre.network.provider.send("hardhat_mine", ["0x12c"]); // 300 blocks
      await hook.write.resolveDraw([0n]);
      expect(await hook.read.drawResolved([0n])).to.equal(true);
      expect(await hook.read.drawCloseBlock([0n])).to.equal(closeBlock);
      const retargets = await hook.getEvents.DrawRetargeted();
      expect(retargets.find((e) => e.args.drawId === 0n)).to.be.undefined;
    });
  });

  describe("ticket segments and binary-search winner (HA5-02)", function () {
    // Sell `amount` UTC as `seller`, crediting `credited` via hookData.
    async function sellFor(
      fixture: Awaited<ReturnType<typeof deployFixture>>,
      seller: { account: any },
      credited: `0x${string}`,
      amount: bigint,
    ) {
      const { swapRouter, key } = fixture;
      await swapRouter.write.swap(
        [
          key,
          {
            zeroForOne: false,
            amountSpecified: -amount,
            sqrtPriceLimitX96: MAX_SQRT_PRICE - 1n,
          },
          { takeClaims: false, settleUsingBurn: false },
          encodeAbiParameters([{ type: "address" }], [getAddress(credited)]),
        ],
        { account: seller.account },
      );
    }

    function addr(i: number): `0x${string}` {
      return getAddress(`0x${(0x1000 + i).toString(16).padStart(40, "0")}`);
    }

    it("splits a raised weight into an extra segment, and the winner matches an off-chain search over segments", async function () {
      const fixture = await loadFixture(deployFixture);
      const { hook, hookAsOwner, trader } = fixture;
      await setUpPoolAndLiquidity(fixture);
      // No floor (denominator 0), so every draw has a winner; threshold
      // 1 wei so small sells qualify in this shallow test pool.
      await hookAsOwner.write.setMaxWinProbabilityDenominator([0n]);
      await hookAsOwner.write.setMinEntryThresholdWei([1n]);

      await sellFor(fixture, trader, addr(1), parseEther("0.001"));
      await sellFor(fixture, trader, addr(2), parseEther("0.001"));
      await sellFor(fixture, trader, addr(1), parseEther("0.01")); // raises addr(1)
      await sellFor(fixture, trader, addr(3), parseEther("0.001"));

      const count = await hook.read.drawSegmentCount([0n]);
      expect(count).to.equal(4n);
      const segments: { owner: string; end: bigint }[] = [];
      for (let i = 0n; i < count; i++) {
        const [owner, end] = await hook.read.getDrawSegment([0n, i]);
        segments.push({ owner: getAddress(owner), end });
      }
      // Each address's segment sizes sum to its weight; ends are increasing
      // and the last equals the total.
      const sums = new Map<string, bigint>();
      let prev = 0n;
      for (const seg of segments) {
        expect(seg.end > prev).to.equal(true);
        sums.set(seg.owner, (sums.get(seg.owner) ?? 0n) + (seg.end - prev));
        prev = seg.end;
      }
      expect(prev).to.equal(await hook.read.totalWeightInDraw([0n]));
      for (const a of [addr(1), addr(2), addr(3)]) {
        expect(sums.get(a)).to.equal(await hook.read.weightInDraw([0n, a]));
      }

      // Close (past drawInterval) and resolve; check the winner.
      await hre.network.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
      await hre.network.provider.send("evm_mine");
      await sellFor(fixture, trader, addr(3), parseEther("0.0001"));
      const closeBlock = await hook.read.drawCloseBlock([0n]);
      expect(closeBlock).to.not.equal(0n);
      // The closing sell landed in draw 0 only if it raised addr(3)'s weight;
      // re-read segments so the expectation uses the final state.
      const finalCount = await hook.read.drawSegmentCount([0n]);
      const ends: bigint[] = [];
      const owners: string[] = [];
      for (let i = 0n; i < finalCount; i++) {
        const [owner, end] = await hook.read.getDrawSegment([0n, i]);
        owners.push(getAddress(owner));
        ends.push(end);
      }
      const publicClient = await hre.viem.getPublicClient();
      const { hash } = await publicClient.getBlock({ blockNumber: closeBlock });
      const target =
        BigInt(
          keccak256(
            encodeAbiParameters(
              [{ type: "bytes32" }, { type: "uint256" }],
              [hash!, 0n],
            ),
          ),
        ) % (await hook.read.drawEffectiveTotalWeight([0n]));
      const expected = owners[ends.findIndex((e) => target < e)];

      await hook.write.resolveDraw([0n]);
      const resolved = (await hook.getEvents.DrawResolved()).find(
        (e) => e.args.drawId === 0n,
      );
      expect(getAddress(resolved!.args.winner!)).to.equal(expected);
    });

    it("resolves a draw with hundreds of participants without the gas cost growing with participant count", async function () {
      this.timeout(600_000);
      const fixture = await loadFixture(deployFixture);
      const { hook, hookAsOwner, trader } = fixture;
      await setUpPoolAndLiquidity(fixture);
      await hookAsOwner.write.setMaxWinProbabilityDenominator([0n]);
      await hookAsOwner.write.setMinEntryThresholdWei([1n]);

      const N = 300;
      for (let i = 0; i < N; i++) {
        await sellFor(fixture, trader, addr(i), parseEther("0.0001"));
      }
      expect(await hook.read.drawSegmentCount([0n])).to.equal(BigInt(N));

      await hre.network.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
      await hre.network.provider.send("evm_mine");
      await sellFor(fixture, trader, addr(0), parseEther("0.0001"));
      expect(await hook.read.drawCloseBlock([0n])).to.not.equal(0n);

      const txHash = await hook.write.resolveDraw([0n]);
      const publicClient = await hre.viem.getPublicClient();
      const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
      expect(receipt.status).to.equal("success");
      // The old per-participant loop alone would cost well over 1M gas here
      // (two cold storage reads per participant); binary search stays near
      // the cost of a 3-participant draw.
      expect(receipt.gasUsed < 700_000n).to.equal(true);
    });
  });

  describe("prize queue", function () {
    it("only the owner can queue a template", async function () {
      const { hook, trader } = await loadFixture(deployFixture);
      const asTrader = await hre.viem.getContractAt(
        "UTCLotteryHook",
        hook.address,
        { client: { wallet: trader } },
      );
      await expect(
        asTrader.write.queuePrizeTemplate([validTemplate]),
      ).to.be.rejectedWith("OwnableUnauthorizedAccount");
    });

    it("reverts InvalidPrizeVariant for variant 0", async function () {
      const { hookAsOwner } = await loadFixture(deployFixture);
      await expect(
        hookAsOwner.write.queuePrizeTemplate([
          { ...validTemplate, variant: 0 },
        ]),
      ).to.be.rejectedWith("InvalidPrizeVariant");
    });

    it("reverts InvalidPrizeVariant for a variant beyond maxVariant", async function () {
      const { hookAsOwner, ships } = await loadFixture(deployFixture);
      const maxVariant = await ships.read.maxVariant();
      await expect(
        hookAsOwner.write.queuePrizeTemplate([
          { ...validTemplate, variant: maxVariant + 1 },
        ]),
      ).to.be.rejectedWith("InvalidPrizeVariant");
    });

    it("reverts ArmorAndShieldsBothSet when both are non-None", async function () {
      const { hookAsOwner } = await loadFixture(deployFixture);
      await expect(
        hookAsOwner.write.queuePrizeTemplate([
          { ...validTemplate, armor: 3, shields: 1 },
        ]),
      ).to.be.rejectedWith("ArmorAndShieldsBothSet");
    });

    it("reverts InvalidPrizeStatTier when a stat exceeds tier 2", async function () {
      const { hookAsOwner } = await loadFixture(deployFixture);
      await expect(
        hookAsOwner.write.queuePrizeTemplate([
          { ...validTemplate, accuracy: 3 },
        ]),
      ).to.be.rejectedWith("InvalidPrizeStatTier");
    });

    it("accepts a valid template and increments queueLength", async function () {
      const { hookAsOwner } = await loadFixture(deployFixture);
      await hookAsOwner.write.queuePrizeTemplate([
        { ...validTemplate, hull: 1 },
      ]);
      expect(await hookAsOwner.read.queueLength()).to.equal(1n);
    });

    it("allows up to MAX_QUEUE_SIZE (5) templates, then reverts PrizeQueueFull", async function () {
      const { hookAsOwner } = await loadFixture(deployFixture);
      for (let i = 0; i < 5; i++) {
        await hookAsOwner.write.queuePrizeTemplate([validTemplate]);
      }
      expect(await hookAsOwner.read.queueLength()).to.equal(5n);
      await expect(
        hookAsOwner.write.queuePrizeTemplate([validTemplate]),
      ).to.be.rejectedWith("PrizeQueueFull");
    });

    it("clearPrizeQueue empties the queue and is owner-only", async function () {
      const { hookAsOwner, hook, trader } = await loadFixture(deployFixture);
      await hookAsOwner.write.queuePrizeTemplate([validTemplate]);
      await hookAsOwner.write.queuePrizeTemplate([validTemplate]);
      expect(await hook.read.queueLength()).to.equal(2n);

      const asTrader = await hre.viem.getContractAt(
        "UTCLotteryHook",
        hook.address,
        { client: { wallet: trader } },
      );
      await expect(
        asTrader.write.clearPrizeQueue(),
      ).to.be.rejectedWith("OwnableUnauthorizedAccount");

      await hookAsOwner.write.clearPrizeQueue();
      expect(await hook.read.queueLength()).to.equal(0n);
    });

    it("dequeues in FIFO order across multiple resolved draws", async function () {
      const fixture = await loadFixture(deployFixture);
      const { hookAsOwner, ships } = fixture;
      await setUpPoolAndLiquidity(fixture);
      await hookAsOwner.write.queuePrizeTemplate([
        { ...validTemplate, hull: 0 },
      ]);
      await hookAsOwner.write.queuePrizeTemplate([
        { ...validTemplate, hull: 1 },
      ]);

      const winner = await runFullDrawCycle(fixture);
      expect(await hookAsOwner.read.queueLength()).to.equal(1n);
      const winnerShipIds = await ships.read.getShipIdsOwned([winner]);
      const firstPrize = await ships.read.getShip([winnerShipIds[0]]);
      expect(firstPrize.traits.hull).to.equal(0); // first-queued template
    });
  });
});

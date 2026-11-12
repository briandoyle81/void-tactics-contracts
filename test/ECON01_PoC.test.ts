import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers";
import { deployShipsFixture } from "./fixtures/deployShipsFixture";

// 2026-11-12: converted to a "this no longer works" regression test, as the
// note below asks. ShipPurchaser.purchaseUTCWithFlow now mints the pack's
// UTC price (tierPrices) for its native price (flowTierPrices), so that is
// the peg. By it, recycling a pack returns ~12% of what it cost, and the 10%
// self-referral refund doesn't make the cycle profitable. The original
// write-up follows.
//
// Proof-of-concept for docs/tokenomics-audit.md's ECON-01 finding:
// Ships.purchaseWithFlow's FLOW-denominated self-referral, stacked with
// shipBreaker recycling, extracts real protocol FLOW revenue as repeatable
// profit. This is a DEMONSTRATION, not a regression test — it currently
// PASSES against unfixed contracts.sol, proving the exploit is real and
// live. Once ECON-01 is fixed, this file's assertions should start failing
// (the profit should shrink to zero or negative) and should be either
// deleted or converted into a "this no longer works" regression test at
// that point — it is not meant to be kept as permanent guard-rail coverage
// in its current form.
//
// Every step below reads real on-chain state after each transaction rather
// than computing expected values in JS and trusting them — the numbers
// printed are what actually happened on the ephemeral Hardhat network.
describe("ECON-01 regression: referral + recycle arbitrage", function () {
  const TIER = 4; // 60 ships/purchase — fewest transactions to reach the referral thresholds
  const REFERRAL_TIER_1_THRESHOLD = 1000n; // 10% referral kicks in at >= 1000 cumulative referred ships

  it("is unprofitable at the 10% referral tier under the purchaseUTCWithFlow peg", async function () {
    this.timeout(120_000);

    const { ships, user1Ships, user1, universalCredits, publicClient, shipPurchaser } =
      await loadFixture(deployShipsFixture);

    const attacker = user1;
    const attackerAddress = attacker.account.address;

    const tierPrice = (await ships.read.tierPrices([TIER])) as bigint;
    const tierShipCount = (await ships.read.tierShips([TIER])) as number;
    const recycleReward = (await ships.read.recycleReward()) as bigint;

    console.log(`\n--- Setup ---`);
    console.log(`Tier ${TIER}: ${tierShipCount} ships for ${tierPrice} wei`);
    console.log(`recycleReward: ${recycleReward} wei UTC per recycled ship`);
    const [, pegUtcPrices] = (await shipPurchaser.read.getPurchaseInfo()) as [number[], bigint[]];
    const [, pegFlowPrices] = (await shipPurchaser.read.getFlowPurchaseInfo()) as [number[], bigint[]];
    const pegUtc = pegUtcPrices[TIER]!;
    const pegFlow = pegFlowPrices[TIER]!;
    console.log(
      `Protocol's own peg (ShipPurchaser.purchaseUTCWithFlow): ${pegUtc} wei UTC for ${pegFlow} wei FLOW`,
    );

    // ---- Phase 1: bootstrap referralCount[attacker] past the 1000 threshold ----
    // Every purchase self-refers. Below the threshold this costs full price
    // (referralPercentage is 0%) -- these are genuine, real-cost purchases,
    // exactly like an honest buyer would make. No special privilege needed.
    const purchasesNeeded = Math.ceil(
      Number(REFERRAL_TIER_1_THRESHOLD) / tierShipCount,
    );
    console.log(`\n--- Phase 1: bootstrap (${purchasesNeeded} purchases) ---`);

    let totalBootstrapFlowOut = 0n;
    let totalBootstrapGas = 0n;

    for (let i = 0; i < purchasesNeeded; i++) {
      const before = await publicClient.getBalance({
        address: attackerAddress,
      });
      const hash = await user1Ships.write.purchaseWithFlow(
        [attackerAddress, TIER, attackerAddress, 1],
        { value: tierPrice },
      );
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      const gasCost = receipt.gasUsed * receipt.effectiveGasPrice;
      const after = await publicClient.getBalance({ address: attackerAddress });

      totalBootstrapGas += gasCost;
      // Pure value outflow (gas backed out): before - after - gasCost
      const pureOutflow = before - after - gasCost;
      totalBootstrapFlowOut += pureOutflow;
    }

    const referralCountAfterBootstrap = (await ships.read.referralCount([
      attackerAddress,
    ])) as bigint;
    console.log(
      `referralCount[attacker] after bootstrap: ${referralCountAfterBootstrap}`,
    );
    console.log(
      `Total pure FLOW spent during bootstrap (gas excluded): ${totalBootstrapFlowOut} wei ` +
        `(${purchasesNeeded} purchases x ${tierPrice} wei = ${
          BigInt(purchasesNeeded) * tierPrice
        } wei expected at 0% referral)`,
    );
    expect(referralCountAfterBootstrap >= REFERRAL_TIER_1_THRESHOLD).to.be.true;
    // referralCount[_referrer] is incremented BEFORE the tier percentage is
    // computed inside _processReferral, so the purchase that CROSSES the
    // threshold already benefits from the new tier on that same purchase --
    // it isn't "one purchase later." With 60 ships/purchase, purchase #17
    // (16*60=960 -> 1020) is where this happens: 16 purchases at 0% + 1
    // purchase at 10% off, not 17 purchases at 0%.
    const purchasesAtZeroPercent = purchasesNeeded - 1;
    const expectedBootstrapCost =
      BigInt(purchasesAtZeroPercent) * tierPrice + (tierPrice * 90n) / 100n;
    console.log(
      `(Discovered via this PoC, not assumed up front: the threshold-crossing ` +
        `purchase itself already gets the discount, since referralCount is ` +
        `incremented before the tier check runs in the same call -- expected ` +
        `bootstrap cost is ${purchasesAtZeroPercent} full-price purchases + 1 ` +
        `at 10% off = ${expectedBootstrapCost} wei.)`,
    );
    expect(totalBootstrapFlowOut).to.equal(expectedBootstrapCost);

    // ---- Phase 2: one more purchase, now at the 10% referral tier ----
    console.log(`\n--- Phase 2: the profitable cycle ---`);

    const shipCountBefore = (await ships.read.shipCount()) as bigint;
    const flowBefore = await publicClient.getBalance({
      address: attackerAddress,
    });
    const utcBefore = (await universalCredits.read.balanceOf([
      attackerAddress,
    ])) as bigint;

    const purchaseHash = await user1Ships.write.purchaseWithFlow(
      [attackerAddress, TIER, attackerAddress, 1],
      { value: tierPrice },
    );
    const purchaseReceipt = await publicClient.waitForTransactionReceipt({
      hash: purchaseHash,
    });
    const purchaseGasCost =
      purchaseReceipt.gasUsed * purchaseReceipt.effectiveGasPrice;

    const flowAfterPurchase = await publicClient.getBalance({
      address: attackerAddress,
    });
    const netFlowOutThisPurchase =
      flowBefore - flowAfterPurchase - purchaseGasCost;

    console.log(`Paid ${tierPrice} wei FLOW for ${tierShipCount} ships.`);
    console.log(
      `Net FLOW outflow this purchase (gas excluded, so this already nets ` +
        `out the same-tx self-referral payout): ${netFlowOutThisPurchase} wei`,
    );
    const observedReferralRefund = tierPrice - netFlowOutThisPurchase;
    console.log(
      `=> Observed referral refund received: ${observedReferralRefund} wei ` +
        `(${(Number(observedReferralRefund) * 100) / Number(tierPrice)}% of price paid)`,
    );
    // 10% tier: referralAmount = tierPrice * 10 / 100
    expect(observedReferralRefund).to.equal((tierPrice * 10n) / 100n);

    // Recycle every ship from this specific purchase.
    const shipCountAfter = (await ships.read.shipCount()) as bigint;
    const newShipIds: bigint[] = [];
    for (let id = shipCountBefore + 1n; id <= shipCountAfter; id++) {
      newShipIds.push(id);
    }
    expect(newShipIds.length).to.equal(tierShipCount);

    const recycleHash = await user1Ships.write.shipBreaker([newShipIds]);
    await publicClient.waitForTransactionReceipt({ hash: recycleHash });

    const utcAfter = (await universalCredits.read.balanceOf([
      attackerAddress,
    ])) as bigint;
    const utcMinted = utcAfter - utcBefore;
    console.log(
      `Recycled all ${newShipIds.length} newly-purchased ships -> minted ${utcMinted} wei UTC.`,
    );
    expect(utcMinted).to.equal(BigInt(tierShipCount) * recycleReward);

    // ---- Final accounting for this one cycle ----
    // UTC and FLOW are not 1:1; value the recycled UTC at the protocol's own
    // peg (pegFlow FLOW buys pegUtc UTC).
    const utcValueInFlow = (utcMinted * pegFlow) / pegUtc;
    const profitInFlowTerms = utcValueInFlow - netFlowOutThisPurchase;
    console.log(`\n--- Result ---`);
    console.log(`Net FLOW spent this cycle:                        ${netFlowOutThisPurchase} wei`);
    console.log(`UTC received (raw):                               ${utcMinted} wei UTC`);
    console.log(`UTC received, FLOW-equivalent per the peg:        ${utcValueInFlow} wei`);
    console.log(`Profit (negative = loss):                         ${profitInFlowTerms} wei`);
    expect(profitInFlowTerms < 0n).to.be.true;
  });
});

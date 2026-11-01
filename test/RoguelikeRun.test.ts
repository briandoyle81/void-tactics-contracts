import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers";
import hre from "hardhat";

// RoguelikeRun keeps each roster ship's hull points inside the packed
// roster (2026-10-31), and a ship that leaves the roster keeps its hull
// points for the rest of the run, as when every ship's HP was keyed by id.
describe("RoguelikeRun roster hull points", function () {
  async function deployFixture() {
    const [owner, player, other] = await hre.viem.getWalletClients();
    const run = await hre.viem.deployContract("RoguelikeRun");
    await run.write.setIsAllowedToModifyRuns([owner.account.address, true]);
    const p = player.account.address;
    const start = (roster: bigint[]) =>
      run.write.startRun([p, 1n, 1n, 1000n, roster, 1n, 0]);
    return { run, p, start, other };
  }

  it("keeps a ship's hull points when it leaves the roster and comes back", async function () {
    const { run, p, start } = await loadFixture(deployFixture);
    await start([1n, 2n, 3n]);
    expect(await run.read.getRosterHP([p])).to.deep.equal([0, 0, 0]);

    await run.write.setShipHP([p, 2n, 40]);
    await run.write.setShipHP([p, 3n, 50]);
    expect(await run.read.getRosterHP([p])).to.deep.equal([0, 40, 50]);

    // Dropped (e.g. at a resupply stop): its damage stays with it.
    await run.write.setRoster([p, [1n, 3n]]);
    expect(await run.read.getRosterHP([p])).to.deep.equal([0, 50]);
    expect(await run.read.getShipHP([p, 2n])).to.equal(40);

    // Added back in a new order: not healed for free.
    await run.write.setRoster([p, [3n, 1n, 2n]]);
    expect((await run.read.getRun([p])).rosterShipIds).to.deep.equal([3n, 1n, 2n]);
    expect(await run.read.getRosterHP([p])).to.deep.equal([50, 0, 40]);

    // Healed to full in the roster, dropped and added back: still full.
    await run.write.setShipHP([p, 2n, 0]);
    await run.write.setRoster([p, [3n, 1n]]);
    await run.write.setRoster([p, [3n, 1n, 2n]]);
    expect(await run.read.getShipHP([p, 2n])).to.equal(0);
  });

  it("sets the whole roster's hull points in one call", async function () {
    const { run, p, start } = await loadFixture(deployFixture);
    await start([1n, 2n, 3n]);
    await run.write.setShipHP([p, 3n, 30]);

    await run.write.setRosterAndHP([p, [2n, 1n], [20, 10]]);
    expect((await run.read.getRun([p])).rosterShipIds).to.deep.equal([2n, 1n]);
    expect(await run.read.getRosterHP([p])).to.deep.equal([20, 10]);
    expect(await run.read.getShipHP([p, 1n])).to.equal(10);
    // The dropped ship keeps its hull points.
    expect(await run.read.getShipHP([p, 3n])).to.equal(30);

    await expect(
      run.write.setRosterAndHP([p, [1n, 2n], [10]]),
    ).to.be.rejectedWith("ArrayLengthMismatch");
  });

  it("stores hull points for a ship outside the roster until it joins", async function () {
    const { run, p, start } = await loadFixture(deployFixture);
    await start([1n]);
    await run.write.setShipHP([p, 9n, 25]);
    expect(await run.read.getShipHP([p, 9n])).to.equal(25);
    await run.write.setRoster([p, [1n, 9n]]);
    expect(await run.read.getRosterHP([p])).to.deep.equal([0, 25]);
  });

  it("starts a new run at full, ignoring the last run's dropped ships", async function () {
    const { run, p, start } = await loadFixture(deployFixture);
    await start([1n, 2n]);
    await run.write.setShipHP([p, 1n, 11]);
    await run.write.setShipHP([p, 2n, 22]);
    await run.write.setRoster([p, [1n]]);
    await run.write.endRun([p, false]);

    await start([1n, 2n]);
    expect(await run.read.getRosterHP([p])).to.deep.equal([0, 0]);
    expect(await run.read.getShipHP([p, 2n])).to.equal(0);
  });

  it("rejects ids that don't fit the packed roster and callers that aren't allowed", async function () {
    const { run, p, start, other } = await loadFixture(deployFixture);
    await expect(start([2n ** 56n])).to.be.rejectedWith("ShipIdTooLarge");
    await start([1n]);
    await expect(
      run.write.setRoster([p, [2n ** 56n]]),
    ).to.be.rejectedWith("ShipIdTooLarge");
    await expect(
      run.write.setRoster([p, [1n]], { account: other.account }),
    ).to.be.rejectedWith("NotAllowedToModifyRuns");
    await expect(
      run.write.setRosterAndHP([p, [1n], [5]], { account: other.account }),
    ).to.be.rejectedWith("NotAllowedToModifyRuns");
  });
});

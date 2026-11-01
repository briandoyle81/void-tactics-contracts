import { expect } from "chai";
import fs from "fs";
import os from "os";
import path from "path";
import hre from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers";
import { getAddress, parseEther, type Address, type Hex } from "viem";
import { deployShipsFixture } from "./fixtures/deployShipsFixture";
import { main } from "../scripts/redeployVariant1Renderers";

// audit-4 HA7-12 (2026-11-01): the variant 1 renderer redeploy script must
// refuse to run unless the live Ships and every renderer it reuses take the
// compiled Ship struct, and must smoke-test through Ships.tokenURI.
describe("scripts/redeployVariant1Renderers.ts (HA7-12)", function () {
  const ENV_KEYS = ["APPLY", "DEPLOYMENT_DIR", "IMPERSONATE"] as const;
  let quiet: { log: typeof console.log; warn: typeof console.warn } | undefined;

  afterEach(function () {
    for (const k of ENV_KEYS) delete process.env[k];
    if (quiet) {
      console.log = quiet.log;
      console.warn = quiet.warn;
      quiet = undefined;
    }
  });

  async function fixtureWithShips() {
    const f = await deployShipsFixture();
    const { ships, randomManager, shatteredHiveMedal, owner, user1, user2 } = f;
    // Constructed variant 1 and variant 2 ships for user1.
    await shatteredHiveMedal.write.ownerMint([user1.account.address], { account: owner.account });
    for (const variant of [1, 2]) {
      const before = await ships.read.shipCount();
      await ships.write.purchaseWithFlow([user1.account.address, 0, user1.account.address, variant], {
        value: parseEther("4.99"),
      });
      for (let id = before + 1n; id <= (await ships.read.shipCount()); id++)
        await randomManager.write.revealRandomness([(await ships.read.getShip([id])).traits.serialNumber]);
      await ships.write.constructAllMyShips({ account: user1.account });
    }
    // Unconstructed ships for user2.
    await ships.write.purchaseWithFlow([user2.account.address, 0, user2.account.address, 1], {
      value: parseEther("4.99"),
    });
    return f;
  }

  async function runScript(f: any, env: Record<string, string> = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "renderer-redeploy-"));
    fs.writeFileSync(
      path.join(dir, "deployed_addresses.json"),
      JSON.stringify({
        "DeployModule#Ships": f.ships.address,
        "DeployModule#VariantPurchaseGate": f.variantPurchaseGate.address,
      }),
    );
    process.env.DEPLOYMENT_DIR = dir;
    Object.assign(process.env, env);
    quiet = { log: console.log, warn: console.warn };
    console.log = () => {};
    console.warn = () => {};
    await main();
  }

  // Flips the code's last byte (the CBOR metadata length, never executed):
  // the contract still works but no longer matches the compiled code, like a
  // build from older sources.
  async function makeStale(address: Address) {
    const publicClient = await hre.viem.getPublicClient();
    const code = (await publicClient.getCode({ address }))!;
    const last = parseInt(code.slice(-2), 16) ^ 0xff;
    await publicClient.request({
      method: "hardhat_setCode" as any,
      params: [address, (code.slice(0, -2) + last.toString(16).padStart(2, "0")) as Hex] as any,
    });
  }

  it("plan mode on a matching deploy finds nothing to do", async function () {
    const f = await loadFixture(fixtureWithShips);
    await runScript(f);
  });

  it("refuses to run when the live Ships doesn't match the compiled Ships", async function () {
    const f = await loadFixture(fixtureWithShips);
    await makeStale(f.ships.address);
    await expect(runScript(f)).to.be.rejectedWith(/Live Ships doesn't match.*full redeploy/s);
  });

  it("refuses to run when a reused variant 2 or explosion part doesn't match", async function () {
    const f = await loadFixture(fixtureWithShips);
    const destroyedV2: Address = await f.imageRendererV2.read.destroyedParts([0n]);
    const aftV2 = await hre.viem.getContractAt("RenderAftV2", await f.imageRendererV2.read.renderAft());
    await makeStale(destroyedV2);
    await makeStale(await aftV2.read.render1());
    await expect(runScript(f)).to.be.rejectedWith(/RenderAft1V2[\s\S]*RenderExplosion1V2[\s\S]*full redeploy/);
  });

  it("redeploys a changed variant 1 leaf and smoke-tests through Ships.tokenURI", async function () {
    const f = await loadFixture(fixtureWithShips);
    const oldMetadata = getAddress(f.metadataRenderer.address);
    await makeStale(f.renderAft0.address);
    await runScript(f, { APPLY: "true", IMPERSONATE: await f.ships.read.owner() });

    const newMetadata = getAddress((await f.ships.read.config())[3]);
    expect(newMetadata).to.not.equal(oldMetadata);
    const metadata = await hre.viem.getContractAt("RenderMetadata", newMetadata);
    const image = await hre.viem.getContractAt("ImageRenderer", await metadata.read.imageRenderer());
    const aft = await hre.viem.getContractAt("RenderAft", await image.read.renderAft());
    expect(getAddress(await aft.read.renderAft0())).to.not.equal(getAddress(f.renderAft0.address));
    expect(getAddress(await metadata.read.imageRendererV2())).to.equal(getAddress(f.imageRendererV2.address));
    for (let id = 1n; id <= (await f.ships.read.shipCount()); id++)
      expect(await f.ships.read.tokenURI([id])).to.match(/^data:application\/json;base64,/);
  });
});

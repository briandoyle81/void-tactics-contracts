import { expect } from "chai";
import fs from "fs";
import os from "os";
import path from "path";
import hre from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers";
import { getAddress, type Address, type Hex } from "viem";
import DeployModule from "../ignition/modules/DeployAndConfig";
import { main } from "../scripts/redeployVariantAIs";

// 2026-11-04: the AI-only redeploy script must refuse to run unless every
// live contract the AI talks to matches the compiled code, and must only
// replace an AI that changed, with the same dependencies and owner.
describe("scripts/redeployVariantAIs.ts", function () {
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

  async function deployFixture() {
    return (await hre.ignition.deploy(DeployModule)) as any;
  }

  async function runScript(f: any, env: Record<string, string> = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-redeploy-"));
    fs.writeFileSync(
      path.join(dir, "deployed_addresses.json"),
      JSON.stringify({
        "DeployModule#AIBehaviorRegistry": f.aiBehaviorRegistry.address,
        "DeployModule#Game": f.game.address,
        "DeployModule#Maps": f.maps.address,
        "DeployModule#SinglePlayerMatch": f.singlePlayerMatch.address,
        "DeployModule#RoguelikeMatch": f.roguelikeMatch.address,
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
  // the contract still works, but the script then strips a different length
  // of metadata, so it no longer matches the compiled code, like a build
  // from older sources.
  async function makeStale(address: Address) {
    const publicClient = await hre.viem.getPublicClient();
    const code = (await publicClient.getCode({ address }))!;
    const last = parseInt(code.slice(-2), 16) ^ 0xff;
    await publicClient.request({
      method: "hardhat_setCode" as any,
      params: [address, (code.slice(0, -2) + last.toString(16).padStart(2, "0")) as Hex] as any,
    });
  }

  it("changes nothing when both AIs already match the compiled code", async function () {
    const f = await loadFixture(deployFixture);
    await runScript(f, { APPLY: "true" });
    expect(getAddress(await f.aiBehaviorRegistry.read.aiFor([1]))).to.equal(getAddress(f.variant1AI.address));
    expect(getAddress(await f.aiBehaviorRegistry.read.aiFor([2]))).to.equal(getAddress(f.variant2AI.address));
  });

  it("accepts a match contract whose only difference is the metadata hash", async function () {
    // What an AI-only source change does to the match contracts, which
    // import AIBehavior.sol (found on the first base-sepolia dry run).
    const f = await loadFixture(deployFixture);
    const publicClient = await hre.viem.getPublicClient();
    const code = (await publicClient.getCode({ address: f.roguelikeMatch.address }))!;
    // 20 bytes from the end: inside the 34-byte IPFS hash.
    const at = code.length - 40;
    const flipped = (parseInt(code.slice(at, at + 2), 16) ^ 0xff).toString(16).padStart(2, "0");
    await publicClient.request({
      method: "hardhat_setCode" as any,
      params: [f.roguelikeMatch.address, (code.slice(0, at) + flipped + code.slice(at + 2)) as Hex] as any,
    });
    await makeStale(f.variant2AI.address);
    await runScript(f, { APPLY: "true", IMPERSONATE: await f.aiBehaviorRegistry.read.owner() });
    expect(getAddress(await f.aiBehaviorRegistry.read.aiFor([2]))).to.not.equal(getAddress(f.variant2AI.address));
  });

  it("refuses to run when a match contract or an AI dependency doesn't match", async function () {
    const f = await loadFixture(deployFixture);
    await makeStale(f.variant1AI.address);
    await makeStale(f.roguelikeMatch.address);
    await makeStale(await f.variant2AI.read.healAbility());
    await expect(runScript(f, { APPLY: "true" })).to.be.rejectedWith(
      /RoguelikeMatch[\s\S]*RepairResolver[\s\S]*Redeploy everything/,
    );
    expect(getAddress(await f.aiBehaviorRegistry.read.aiFor([1]))).to.equal(getAddress(f.variant1AI.address));
  });

  it("redeploys only the changed AI, with the same dependencies and owner", async function () {
    const f = await loadFixture(deployFixture);
    const owner = getAddress(await f.variant1AI.read.owner());
    await makeStale(f.variant1AI.address);
    await runScript(f, { APPLY: "true", IMPERSONATE: await f.aiBehaviorRegistry.read.owner() });

    const ai1 = getAddress(await f.aiBehaviorRegistry.read.aiFor([1]));
    expect(ai1).to.not.equal(getAddress(f.variant1AI.address));
    expect(getAddress(await f.aiBehaviorRegistry.read.aiFor([2]))).to.equal(getAddress(f.variant2AI.address));
    const v1 = await hre.viem.getContractAt("Variant1AI", ai1);
    expect(getAddress(await v1.read.shipAttributes())).to.equal(getAddress(await f.variant1AI.read.shipAttributes()));
    expect(getAddress(await v1.read.ramAbility())).to.equal(getAddress(await f.variant1AI.read.ramAbility()));
    expect(getAddress(await v1.read.owner())).to.equal(owner);
  });
});

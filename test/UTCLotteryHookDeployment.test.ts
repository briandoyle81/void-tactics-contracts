import { expect } from "chai";
import hre from "hardhat";
import { getAddress } from "viem";
import { mineHookAddress, HOOK_FLAGS } from "../scripts/hookMiner";

// Scoped narrowly to proving the CREATE2 mining/deployment mechanics
// actually work — UTCLotteryHook's address must satisfy BaseHook's
// permission-flag check or the constructor reverts. Swap/draw behavior is
// exercised separately once a real (or mocked) IPoolManager integration is
// in place; this only confirms the hook can be deployed at all.
describe("UTCLotteryHook deployment (CREATE2 address mining)", function () {
  it("mines a salt producing a correctly-flagged address and deploys there", async function () {
    const [deployerSigner, shipsStandin, utcStandin, owner] =
      await hre.viem.getWalletClients();

    const create2Deployer = await hre.viem.deployContract("Create2Deployer", []);
    const artifact = await hre.artifacts.readArtifact("UTCLotteryHook");

    const flags = HOOK_FLAGS.BEFORE_INITIALIZE | HOOK_FLAGS.AFTER_SWAP;

    // poolManager isn't dereferenced during construction (only stored), so
    // a plain EOA stands in for it here — same rationale AIShips.test.ts
    // already uses for an unrelated stand-in address.
    const { hookAddress, salt, initCode } = mineHookAddress({
      deployer: create2Deployer.address,
      flags,
      abi: artifact.abi,
      bytecode: artifact.bytecode as `0x${string}`,
      constructorArgs: [
        deployerSigner.account.address,
        shipsStandin.account.address,
        utcStandin.account.address,
        owner.account.address,
      ],
    });

    const flagMask = 0x3fffn;
    expect(BigInt(hookAddress) & flagMask).to.equal(flags & flagMask);

    await create2Deployer.write.deploy([initCode, salt]);

    const hook = await hre.viem.getContractAt("UTCLotteryHook", hookAddress);
    expect(getAddress(await hook.read.owner())).to.equal(
      getAddress(owner.account.address),
    );
    expect(getAddress(await hook.read.utcToken())).to.equal(
      getAddress(utcStandin.account.address),
    );
    expect(await hook.read.poolLocked()).to.equal(false);
  });
});

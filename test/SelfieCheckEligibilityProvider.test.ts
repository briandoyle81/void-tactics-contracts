import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers";
import hre from "hardhat";

// Focused on what isn't already covered indirectly via
// Ships.test.ts/TutorialClaim.test.ts's eligibility-provider integration
// tests: this contract's own event emissions.
describe("SelfieCheckEligibilityProvider", function () {
  async function deployFixture() {
    const [owner, verifier, other] = await hre.viem.getWalletClients();
    const provider = await hre.viem.deployContract(
      "SelfieCheckEligibilityProvider",
      [owner.account.address],
    );
    return { owner, verifier, other, provider };
  }

  it("emits AuthorizedVerifierSet when a verifier is authorized or revoked", async function () {
    const { provider, verifier } = await loadFixture(deployFixture);
    const publicClient = await hre.viem.getPublicClient();

    const hash = await provider.write.setAuthorizedVerifier([
      verifier.account.address,
      true,
    ]);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    const events = await provider.getEvents.AuthorizedVerifierSet(undefined, {
      fromBlock: receipt.blockNumber,
      toBlock: receipt.blockNumber,
    });
    expect(events).to.have.length(1);
    expect(events[0].args.verifier?.toLowerCase()).to.equal(
      verifier.account.address.toLowerCase(),
    );
    expect(events[0].args.isAuthorized).to.equal(true);
  });

  it("emits NullifierCheckEnabledSet when toggled", async function () {
    const { provider } = await loadFixture(deployFixture);
    const publicClient = await hre.viem.getPublicClient();

    const hash = await provider.write.setNullifierCheckEnabled([false]);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    const events = await provider.getEvents.NullifierCheckEnabledSet(
      undefined,
      { fromBlock: receipt.blockNumber, toBlock: receipt.blockNumber },
    );
    expect(events).to.have.length(1);
    expect(events[0].args.enabled).to.equal(false);
    expect(await provider.read.nullifierCheckEnabled()).to.equal(false);
  });

  it("both setters are owner-only", async function () {
    const { provider, other, verifier } = await loadFixture(deployFixture);
    const asOther = await hre.viem.getContractAt(
      "SelfieCheckEligibilityProvider",
      provider.address,
      { client: { wallet: other } },
    );
    await expect(
      asOther.write.setAuthorizedVerifier([verifier.account.address, true]),
    ).to.be.rejectedWith("OwnableUnauthorizedAccount");
    await expect(
      asOther.write.setNullifierCheckEnabled([false]),
    ).to.be.rejectedWith("OwnableUnauthorizedAccount");
  });

  describe("nullifier binding, renewal and release (HA6-14)", function () {
    const N = `0x${"ab".repeat(32)}` as `0x${string}`;
    const DAY = 24 * 60 * 60;

    async function withVerifier() {
      const f = await loadFixture(deployFixture);
      await f.provider.write.setAuthorizedVerifier([f.verifier.account.address, true]);
      const asVerifier = await hre.viem.getContractAt(
        "SelfieCheckEligibilityProvider",
        f.provider.address,
        { client: { wallet: f.verifier } },
      );
      return { ...f, asVerifier };
    }

    it("lets the same wallet renew its verification with its own nullifier", async function () {
      const { provider, asVerifier, other } = await withVerifier();
      const player = other.account.address;
      await asVerifier.write.markVerified([player, N]);
      const first = await provider.read.verifiedUntil([player]);

      await hre.network.provider.send("evm_increaseTime", [91 * DAY]);
      await hre.network.provider.send("evm_mine");
      expect(await provider.read.isEligible([player])).to.equal(false);

      // Used to revert NullifierAlreadyUsed, locking the player out forever.
      await asVerifier.write.markVerified([player, N]);
      expect((await provider.read.verifiedUntil([player])) > first).to.equal(true);
      expect(await provider.read.isEligible([player])).to.equal(true);
    });

    it("still rejects the same human verifying a second wallet", async function () {
      const { asVerifier, other, owner } = await withVerifier();
      await asVerifier.write.markVerified([other.account.address, N]);
      await expect(
        asVerifier.write.markVerified([owner.account.address, N]),
      ).to.be.rejectedWith("NullifierAlreadyUsed");
    });

    it("owner can release a nullifier for a wallet move, ending the old wallet's eligibility", async function () {
      const { provider, asVerifier, other, owner } = await withVerifier();
      const oldWallet = other.account.address;
      const newWallet = owner.account.address;
      await asVerifier.write.markVerified([oldWallet, N]);

      const asOther = await hre.viem.getContractAt(
        "SelfieCheckEligibilityProvider",
        provider.address,
        { client: { wallet: other } },
      );
      await expect(asOther.write.releaseNullifier([N])).to.be.rejected;

      await provider.write.releaseNullifier([N]);
      expect(await provider.read.isEligible([oldWallet])).to.equal(false);
      expect(await provider.read.usedNullifiers([N])).to.equal(false);

      await asVerifier.write.markVerified([newWallet, N]);
      expect(await provider.read.isEligible([newWallet])).to.equal(true);
      expect(
        (await provider.read.nullifierOwner([N])).toLowerCase(),
      ).to.equal(newWallet.toLowerCase());
    });
  });
});

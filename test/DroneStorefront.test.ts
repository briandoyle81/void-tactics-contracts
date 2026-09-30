import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers";
import hre from "hardhat";
import { parseEther, getAddress } from "viem";
import { deployShipsFixture } from "./fixtures/deployShipsFixture";

// DroneStorefront's turn-in-cores tier ladder — see Ships.sol/FreeShipClaim.sol
// for how droneCoreTier is read back as a permanent free-ship bonus.
describe("DroneStorefront", function () {
  async function mintDec(
    droneEnergyCores: any,
    owner: any,
    to: string,
    amount: bigint,
  ) {
    await droneEnergyCores.write.setAuthorizedToMint(
      [owner.account.address, true],
      { account: owner.account },
    );
    await droneEnergyCores.write.mint([to, amount], {
      account: owner.account,
    });
  }

  it("Should seed the tier ladder from the deploy script", async function () {
    const { droneStorefront } = await loadFixture(deployShipsFixture);

    expect(await droneStorefront.read.tierCoreCost([0n])).to.equal(10n);
    expect(await droneStorefront.read.tierCoreCost([1n])).to.equal(20n);
    expect(await droneStorefront.read.tierCoreCost([9n])).to.equal(1625n);
  });

  it("Should advance a player's tier and consume their DEC when turning in the exact cost", async function () {
    const { droneStorefront, droneEnergyCores, owner, user1 } =
      await loadFixture(deployShipsFixture);

    await mintDec(droneEnergyCores, owner, user1.account.address, 10n);

    const user1DEC = await hre.viem.getContractAt(
      "DroneEnergyCores",
      droneEnergyCores.address,
      { client: { wallet: user1 } },
    );
    await user1DEC.write.approve([droneStorefront.address, 10n]);

    const user1Storefront = await hre.viem.getContractAt(
      "DroneStorefront",
      droneStorefront.address,
      { client: { wallet: user1 } },
    );
    await user1Storefront.write.turnInCores([10n]);

    expect(
      await droneStorefront.read.droneCoreTier([user1.account.address]),
    ).to.equal(1);
    expect(
      await droneEnergyCores.read.balanceOf([user1.account.address]),
    ).to.equal(0n);
    // turnInCores burns the turned-in DEC directly rather than holding it.
    expect(
      await droneEnergyCores.read.balanceOf([droneStorefront.address]),
    ).to.equal(0n);
    expect(await droneEnergyCores.read.totalSupply()).to.equal(0n);
  });

  it("Should advance through multiple tiers in sequence", async function () {
    const { droneStorefront, droneEnergyCores, owner, user1 } =
      await loadFixture(deployShipsFixture);

    // Tier 0->1 costs 10, tier 1->2 costs 20.
    await mintDec(droneEnergyCores, owner, user1.account.address, 30n);

    const user1DEC = await hre.viem.getContractAt(
      "DroneEnergyCores",
      droneEnergyCores.address,
      { client: { wallet: user1 } },
    );
    await user1DEC.write.approve([droneStorefront.address, 30n]);

    const user1Storefront = await hre.viem.getContractAt(
      "DroneStorefront",
      droneStorefront.address,
      { client: { wallet: user1 } },
    );
    await user1Storefront.write.turnInCores([10n]);
    await user1Storefront.write.turnInCores([20n]);

    expect(
      await droneStorefront.read.droneCoreTier([user1.account.address]),
    ).to.equal(2);
  });

  it("Should revert with WrongAmount when the amount doesn't match the next tier's exact cost", async function () {
    const { droneStorefront, droneEnergyCores, owner, user1 } =
      await loadFixture(deployShipsFixture);

    await mintDec(droneEnergyCores, owner, user1.account.address, 20n);

    const user1DEC = await hre.viem.getContractAt(
      "DroneEnergyCores",
      droneEnergyCores.address,
      { client: { wallet: user1 } },
    );
    await user1DEC.write.approve([droneStorefront.address, 20n]);

    const user1Storefront = await hre.viem.getContractAt(
      "DroneStorefront",
      droneStorefront.address,
      { client: { wallet: user1 } },
    );

    // Tier 0's cost is 10, not 20 — too much is rejected just like too
    // little, since the amount must match exactly.
    await expect(
      user1Storefront.write.turnInCores([20n]),
    ).to.be.rejectedWith("WrongAmount");
  });

  it("Should revert with MaxTierReached once a player has purchased every configured tier", async function () {
    const { droneStorefront, droneEnergyCores, owner, user1 } =
      await loadFixture(deployShipsFixture);

    const tierCosts = [10n, 20n, 30n, 55n, 95n, 170n, 300n, 525n, 925n, 1625n];
    const total = tierCosts.reduce((a, b) => a + b, 0n);

    await mintDec(droneEnergyCores, owner, user1.account.address, total);

    const user1DEC = await hre.viem.getContractAt(
      "DroneEnergyCores",
      droneEnergyCores.address,
      { client: { wallet: user1 } },
    );
    await user1DEC.write.approve([droneStorefront.address, total]);

    const user1Storefront = await hre.viem.getContractAt(
      "DroneStorefront",
      droneStorefront.address,
      { client: { wallet: user1 } },
    );

    for (const cost of tierCosts) {
      await user1Storefront.write.turnInCores([cost]);
    }

    expect(
      await droneStorefront.read.droneCoreTier([user1.account.address]),
    ).to.equal(10);

    await mintDec(droneEnergyCores, owner, user1.account.address, 1n);
    await user1DEC.write.approve([droneStorefront.address, 1n]);

    await expect(
      user1Storefront.write.turnInCores([1n]),
    ).to.be.rejectedWith("MaxTierReached");
  });

  it("Should let the owner add further tiers post-deploy", async function () {
    const { droneStorefront, owner } = await loadFixture(deployShipsFixture);

    await droneStorefront.write.addTier([5000n], { account: owner.account });

    expect(await droneStorefront.read.tierCoreCost([10n])).to.equal(5000n);
  });

  it("Should reject a zero or non-contract droneEnergyCores address at construction and via the setter (HA4-06)", async function () {
    const [owner, user1] = await hre.viem.getWalletClients();
    const zeroAddress = "0x0000000000000000000000000000000000000000";

    await expect(
      hre.viem.deployContract("DroneStorefront", [zeroAddress]),
    ).to.be.rejectedWith("InvalidDroneEnergyCoresAddress");
    await expect(
      hre.viem.deployContract("DroneStorefront", [user1.account.address]),
    ).to.be.rejectedWith("InvalidDroneEnergyCoresAddress");

    // A real deployed contract is accepted, and the setter enforces the
    // same rule post-deploy.
    const { droneStorefront, droneEnergyCores } = await loadFixture(
      deployShipsFixture,
    );
    await expect(
      droneStorefront.write.setDroneEnergyCoresAddress([zeroAddress], {
        account: owner.account,
      }),
    ).to.be.rejectedWith("InvalidDroneEnergyCoresAddress");
    await expect(
      droneStorefront.write.setDroneEnergyCoresAddress(
        [user1.account.address],
        { account: owner.account },
      ),
    ).to.be.rejectedWith("InvalidDroneEnergyCoresAddress");
    // Sanity: re-setting to the real address still works.
    await droneStorefront.write.setDroneEnergyCoresAddress(
      [droneEnergyCores.address],
      { account: owner.account },
    );
    expect(await droneStorefront.read.droneEnergyCores()).to.equal(
      getAddress(droneEnergyCores.address),
    );
  });
});

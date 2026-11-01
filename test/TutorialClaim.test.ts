import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers";
import hre from "hardhat";
import { keccak256, toBytes } from "viem";
import DeployModule from "../ignition/modules/DeployAndConfig";

describe("TutorialClaim", function () {
  async function deployTutorialFixture() {
    const [owner, user1, user2] = await hre.viem.getWalletClients();
    const deployed = await hre.ignition.deploy(DeployModule);

    const tutorialClaim = deployed.tutorialClaim;
    const user1TutorialClaim = await hre.viem.getContractAt(
      "TutorialClaim",
      tutorialClaim.address,
      { client: { wallet: user1 } },
    );
    const user2TutorialClaim = await hre.viem.getContractAt(
      "TutorialClaim",
      tutorialClaim.address,
      { client: { wallet: user2 } },
    );

    return {
      owner,
      user1,
      user2,
      ships: deployed.ships,
      gameResults: deployed.gameResults,
      tutorialClaim,
      user1TutorialClaim,
      user2TutorialClaim,
    };
  }

  /** Owner order from `getShipIdsOwned` is not guaranteed; key by name. */
  async function shipsByName(
    ships: Awaited<ReturnType<typeof deployTutorialFixture>>["ships"],
    owner: `0x${string}`,
  ) {
    const shipIds = await ships.read.getShipIdsOwned([owner]);
    const out: Record<
      string,
      {
        name: string;
        shiny: boolean;
        isFreeShip: boolean;
        shipsDestroyed: number;
        equipment: {
          mainWeapon: number;
          armor: number;
          shields: number;
          special: number;
        };
      }
    > = {};
    for (const id of shipIds) {
      const s = await ships.read.getShip([id]);
      out[s.name] = {
        name: s.name,
        shiny: s.shipData.shiny,
        isFreeShip: s.shipData.isFreeShip,
        shipsDestroyed: Number(s.shipData.shipsDestroyed),
        equipment: {
          mainWeapon: Number(s.equipment.mainWeapon),
          armor: Number(s.equipment.armor),
          shields: Number(s.equipment.shields),
          special: Number(s.equipment.special),
        },
      };
    }
    return out;
  }

  /** `playerStats` mapping returns `[wins, losses]` from viem; total games is their sum. */
  function expectStats(
    raw: readonly [bigint, bigint] | { wins: bigint; losses: bigint },
    wins: bigint,
    losses: bigint,
    totalGames: bigint,
  ) {
    const w = Array.isArray(raw) ? raw[0] : (raw as { wins: bigint }).wins;
    const l = Array.isArray(raw) ? raw[1] : (raw as { losses: bigint }).losses;
    expect(w).to.equal(wins);
    expect(l).to.equal(losses);
    expect(w + l).to.equal(totalGames);
  }

  it("completes win path once, mints 2 ships, records win", async function () {
    const { user1, ships, gameResults, user1TutorialClaim, tutorialClaim } =
      await loadFixture(deployTutorialFixture);

    await user1TutorialClaim.write.completeTutorialWinPath();

    const completed = await tutorialClaim.read.tutorialCompleted([
      user1.account.address,
    ]);
    expect(completed).to.equal(true);

    const shipIds = await ships.read.getShipIdsOwned([user1.account.address]);
    expect(shipIds.length).to.equal(2);

    const byName = await shipsByName(ships, user1.account.address);
    expect(Object.keys(byName).sort()).to.deep.equal(
      ["Sentinel", "Vigilant"].sort(),
    );

    const vigilant = byName["Vigilant"];
    const sentinel = byName["Sentinel"];
    expect(vigilant.equipment.mainWeapon).to.equal(1); // Sniper
    expect(vigilant.equipment.armor).to.equal(0); // None
    expect(vigilant.equipment.shields).to.equal(1); // Light
    expect(vigilant.equipment.special).to.equal(2); // Repair

    expect(sentinel.equipment.mainWeapon).to.equal(0); // Generic
    expect(sentinel.equipment.armor).to.equal(2); // Medium
    expect(sentinel.equipment.shields).to.equal(0); // None
    expect(sentinel.equipment.special).to.equal(0); // None

    expect(vigilant.shiny).to.equal(false);
    expect(sentinel.shiny).to.equal(false);
    expect(vigilant.isFreeShip).to.equal(true);
    expect(sentinel.isFreeShip).to.equal(true);

    const stats = await gameResults.read.playerStats([user1.account.address]);
    expectStats(stats, 1n, 0n, 1n);
  });

  it("completes loss path once, mints 3 ships, records loss", async function () {
    const { user1, ships, gameResults, user1TutorialClaim } = await loadFixture(
      deployTutorialFixture,
    );

    await user1TutorialClaim.write.completeTutorialLossPath();

    const shipIds = await ships.read.getShipIdsOwned([user1.account.address]);
    expect(shipIds.length).to.equal(3);

    const byName = await shipsByName(ships, user1.account.address);
    expect(Object.keys(byName).sort()).to.deep.equal(
      ["Resolute", "Sentinel", "Vigilant"].sort(),
    );

    const resolute = byName["Resolute"];
    expect(resolute.equipment.mainWeapon).to.equal(3); // Plasma
    expect(resolute.equipment.armor).to.equal(0);
    expect(resolute.equipment.shields).to.equal(2); // Medium
    expect(resolute.equipment.special).to.equal(1); // EMP
    expect(resolute.shiny).to.equal(true);
    expect(resolute.shipsDestroyed).to.equal(10); // rank 2 starts at 10 kills
    expect(resolute.isFreeShip).to.equal(true);

    const vigilantLoss = byName["Vigilant"];
    expect(vigilantLoss.equipment.mainWeapon).to.equal(1);
    expect(vigilantLoss.equipment.armor).to.equal(0);
    expect(vigilantLoss.equipment.shields).to.equal(1);
    expect(vigilantLoss.equipment.special).to.equal(2);

    const sentinelLoss = byName["Sentinel"];
    expect(sentinelLoss.equipment.mainWeapon).to.equal(0);
    expect(sentinelLoss.equipment.armor).to.equal(2);
    expect(sentinelLoss.equipment.shields).to.equal(0);
    expect(sentinelLoss.equipment.special).to.equal(0);

    expect(vigilantLoss.shiny).to.equal(false);
    expect(sentinelLoss.shiny).to.equal(false);
    expect(vigilantLoss.isFreeShip).to.equal(true);
    expect(sentinelLoss.isFreeShip).to.equal(true);

    const stats = await gameResults.read.playerStats([user1.account.address]);
    expectStats(stats, 0n, 1n, 1n);
  });

  it("reverts on second tutorial completion for same address", async function () {
    const { user1TutorialClaim } = await loadFixture(deployTutorialFixture);

    await user1TutorialClaim.write.completeTutorialWinPath();
    await expect(
      user1TutorialClaim.write.completeTutorialLossPath(),
    ).to.be.rejectedWith("TutorialAlreadyCompleted");
  });

  it("allows different addresses to complete independently", async function () {
    const {
      user1,
      user2,
      gameResults,
      user1TutorialClaim,
      user2TutorialClaim,
    } = await loadFixture(deployTutorialFixture);

    await user1TutorialClaim.write.completeTutorialWinPath();
    await user2TutorialClaim.write.completeTutorialLossPath();

    const s1 = await gameResults.read.playerStats([user1.account.address]);
    expectStats(s1, 1n, 0n, 1n);

    const s2 = await gameResults.read.playerStats([user2.account.address]);
    expectStats(s2, 0n, 1n, 1n);
  });

  /**
   * Real `GameResults` from Ignition does not callback into `TutorialClaim`.
   * This case uses a malicious stand-in for `addWin` only.
   */
  it("blocks reentrant callback from game results contract", async function () {
    const [deployer, user1] = await hre.viem.getWalletClients();
    const ships = await hre.viem.deployContract("MockTutorialShips", []);
    const reentrantResults = await hre.viem.deployContract(
      "MockTutorialReentrantGameResults",
      [],
    );
    const tutorialClaim = await hre.viem.deployContract("TutorialClaim", [
      ships.address,
      reentrantResults.address,
    ]);
    await reentrantResults.write.setTarget([tutorialClaim.address], {
      account: deployer.account.address,
    });

    const user1TutorialClaim = await hre.viem.getContractAt(
      "TutorialClaim",
      tutorialClaim.address,
      { client: { wallet: user1 } },
    );

    await expect(user1TutorialClaim.write.completeTutorialWinPath()).to.be
      .rejected;
  });

  it("rejects direct createSpecificShip from unauthorized EOA", async function () {
    const { user1, ships } = await loadFixture(deployTutorialFixture);

    const user1Ships = await hre.viem.getContractAt("Ships", ships.address, {
      client: { wallet: user1 },
    });

    const template = {
      name: "Unauthorized",
      id: 0n,
      equipment: {
        mainWeapon: 0,
        armor: 1,
        shields: 1,
        special: 0,
      },
      traits: {
        serialNumber: 0n,
        colors: {
          h1: 10,
          s1: 10,
          l1: 10,
          h2: 20,
          s2: 20,
          l2: 20,
        },
        variant: 1,
        accuracy: 1,
        hull: 1,
        speed: 1,
      },
      shipData: {
        shipsDestroyed: 0,
        costsVersion: 0,
        cost: 0,
        modified: 0,
        shiny: false,
        constructed: false,
        inFleet: false,
        isFreeShip: false,
        timestampDestroyed: 0n,
      },
      owner: user1.account.address,
    } as const;

    await expect(
      user1Ships.write.createSpecificShip([user1.account.address, template]),
    ).to.be.rejectedWith("NotAuthorized");
  });

  describe("eligibilityProvider", function () {
    it("deploy module wires a permissive MockAlwaysEligible by default, so completing stays open", async function () {
      const { tutorialClaim } = await loadFixture(deployTutorialFixture);

      const providerAddress = await tutorialClaim.read.eligibilityProvider();
      expect(providerAddress).to.not.equal(
        "0x0000000000000000000000000000000000000000",
      );
      const provider = await hre.viem.getContractAt(
        "MockAlwaysEligible",
        providerAddress,
      );
      expect(await provider.read.isEligible([providerAddress])).to.equal(
        true,
      );
    });

    it("only the owner can set eligibilityProvider", async function () {
      const { user1TutorialClaim } = await loadFixture(deployTutorialFixture);
      await expect(
        user1TutorialClaim.write.setEligibilityProvider([
          "0x0000000000000000000000000000000000000001",
        ]),
      ).to.be.rejectedWith("OwnableUnauthorizedAccount");
    });

    it("reverts NotEligible once a provider is wired and the player hasn't been verified", async function () {
      const { tutorialClaim, user1TutorialClaim, user1 } =
        await loadFixture(deployTutorialFixture);
      const owner = await tutorialClaim.read.owner();
      const ownerClient = (await hre.viem.getWalletClients()).find(
        (c) => c.account.address.toLowerCase() === owner.toLowerCase(),
      )!;
      const tutorialClaimAsOwner = await hre.viem.getContractAt(
        "TutorialClaim",
        tutorialClaim.address,
        { client: { wallet: ownerClient } },
      );

      const provider = await hre.viem.deployContract(
        "SelfieCheckEligibilityProvider",
        [ownerClient.account.address],
      );
      await tutorialClaimAsOwner.write.setEligibilityProvider([
        provider.address,
      ]);

      await expect(
        user1TutorialClaim.write.completeTutorialWinPath(),
      ).to.be.rejectedWith("NotEligible");
      expect(await tutorialClaim.read.tutorialCompleted([
        user1.account.address,
      ])).to.equal(false);
    });

    it("succeeds once the wired provider marks the player verified", async function () {
      const { tutorialClaim, user1TutorialClaim, user1 } =
        await loadFixture(deployTutorialFixture);
      const owner = await tutorialClaim.read.owner();
      const ownerClient = (await hre.viem.getWalletClients()).find(
        (c) => c.account.address.toLowerCase() === owner.toLowerCase(),
      )!;
      const tutorialClaimAsOwner = await hre.viem.getContractAt(
        "TutorialClaim",
        tutorialClaim.address,
        { client: { wallet: ownerClient } },
      );

      const provider = await hre.viem.deployContract(
        "SelfieCheckEligibilityProvider",
        [ownerClient.account.address],
      );
      await tutorialClaimAsOwner.write.setEligibilityProvider([
        provider.address,
      ]);
      await provider.write.setAuthorizedVerifier(
        [ownerClient.account.address, true],
        { account: ownerClient.account },
      );
      const nullifierHash = keccak256(toBytes("tutorial-test-nullifier"));
      await provider.write.markVerified(
        [user1.account.address, nullifierHash],
        { account: ownerClient.account },
      );

      await user1TutorialClaim.write.completeTutorialWinPath();
      expect(await tutorialClaim.read.tutorialCompleted([
        user1.account.address,
      ])).to.equal(true);
    });
  });
});

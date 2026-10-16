import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers";
import hre from "hardhat";
import { zeroAddress } from "viem";
import { seedVariant1Attributes } from "./fixtures/seedVariant1Attributes";
import { costsParams } from "./fixtures/attributeTables";

// Standalone unit tests for ShipsRouter.sol's dispatch logic: does an id
// resolve to Ships.sol (human) or AIShips.sol (AI) correctly, and does
// setTimestampDestroyed's cross-contract kill-reward orchestration work in
// both directions plus the pure-PvP (both-human) case. Deploys Ships/
// AIShips/ShipAttributes/UniversalCredits/DroneEnergyCores directly rather
// than the full DeployAndConfig module, matching test/NodeMap.test.ts's
// convention for contracts with few real dependencies.
describe("ShipsRouter", function () {
  const AI_SHIP_ID_OFFSET = 2n ** 40n;

  async function deployFixture() {
    const [owner, gameEOA, fleetsEOA, human, aiOwner, other] =
      await hre.viem.getWalletClients();

    const ships = await hre.viem.deployContract("Ships", [
      owner.account.address, // dummy metadata renderer, never called in these tests
    ]);
    const aiShips = await hre.viem.deployContract("AIShips", []);
    const shipAttributes = await hre.viem.deployContract("ShipAttributes", [
      ships.address,
    ]);
    await seedVariant1Attributes(shipAttributes, owner.account);
    // Variant 2 needs costs configured too (calculateShipCost reverts with
    // InvalidCostsVersion otherwise) so an AI ship of variant 2 -- the one
    // this fixture registers a reward token for below, mirroring
    // production's real variant-2-pays-DEC mapping -- can be allocated at
    // all. Values reused from seedVariant1Attributes; only baseCost/version
    // existing (non-zero) matters for these tests.
    await shipAttributes.write.setCosts(
      [
        2,
        costsParams({
          version: 0,
          baseCost: 50,
          accuracy: [0, 10, 25],
          hull: [0, 10, 25],
          speed: [0, 10, 25],
          mainWeapon: [25, 30, 40, 40],
          armor: [0, 5, 10, 15],
          shields: [0, 10, 20, 30],
          special: [0, 10, 20, 15, 15, 20, 10, 0],
        }),
      ],
      { account: owner.account },
    );
    const universalCredits = await hre.viem.deployContract("UniversalCredits");
    const droneEnergyCores = await hre.viem.deployContract("DroneEnergyCores");
    const factionRewardTokenRegistry = await hre.viem.deployContract(
      "FactionRewardTokenRegistry",
    );
    // Registers variant 2 -> DEC, mirroring production's real mapping (see
    // ignition/modules/DeployAndConfig.ts's setVariant2RewardTokenCall).
    // Variant 1 (this file's defaultTraits.variant) is deliberately left
    // unregistered, same as production today, to also prove the "no reward
    // token yet" path for free.
    await factionRewardTokenRegistry.write.setRewardToken([
      2,
      droneEnergyCores.address,
    ]);
    const mockLobbyCheck = await hre.viem.deployContract(
      "MockLobbiesOrchestratorCheck",
    );

    const randomManager = await hre.viem.deployContract("RandomManager");

    const destroyRewardLib = await hre.viem.deployContract("DestroyRewardLib");
    const shipsRouter = await hre.viem.deployContract(
      "ShipsRouter",
      [
        ships.address,
        aiShips.address,
        universalCredits.address,
        factionRewardTokenRegistry.address,
      ],
      { libraries: { DestroyRewardLib: destroyRewardLib.address } },
    );

    // Mirrors DeployAndConfig.ts's production wiring: Ships.sol whitelists
    // the router (not Game.sol/Fleets.sol directly) for gameAddress/
    // fleetsAddress, since it's the router that calls Ships.sol now.
    await ships.write.setConfig([
      shipsRouter.address, // gameAddress
      mockLobbyCheck.address, // lobbyAddress
      shipsRouter.address, // fleetsAddress
      zeroAddress, // shipGenerator (unused here)
      randomManager.address,
      zeroAddress, // metadataRenderer (unused here)
      shipAttributes.address,
      universalCredits.address,
      droneEnergyCores.address,
      zeroAddress, // purchaseGate (unused here)
    ]);
    await ships.write.setIsAllowedToCreateShips([owner.account.address, true]);

    await aiShips.write.setShipAttributesAddress([shipAttributes.address]);
    await aiShips.write.setRouter([shipsRouter.address]);
    await aiShips.write.setIsAllowedToCreateShips([owner.account.address, true]);

    await shipsRouter.write.setIsAllowedGame([gameEOA.account.address, true]);
    await shipsRouter.write.setFleetsAddress([fleetsEOA.account.address]);
    await shipsRouter.write.setLobbyAddress([mockLobbyCheck.address]);

    await universalCredits.write.setMintIsActive([true]);
    await universalCredits.write.setAuthorizedToMint([shipsRouter.address, true]);
    await droneEnergyCores.write.setMintIsActive([true]);
    await droneEnergyCores.write.setAuthorizedToMint([shipsRouter.address, true]);

    // mockLobbyCheck.isSinglePlayerOrchestrator(x) == (x == aiOwner) — the
    // AI's ships are always "owned" by this address in this test, same
    // pattern as SinglePlayerMatch.isSinglePlayerOrchestrator in production.
    await mockLobbyCheck.write.setAiOrchestrator([aiOwner.account.address]);

    const gameRouter = await hre.viem.getContractAt(
      "ShipsRouter",
      shipsRouter.address,
      { client: { wallet: gameEOA } },
    );
    const fleetsRouter = await hre.viem.getContractAt(
      "ShipsRouter",
      shipsRouter.address,
      { client: { wallet: fleetsEOA } },
    );
    const otherRouter = await hre.viem.getContractAt(
      "ShipsRouter",
      shipsRouter.address,
      { client: { wallet: other } },
    );

    return {
      ships,
      aiShips,
      shipAttributes,
      shipsRouter,
      gameRouter,
      fleetsRouter,
      otherRouter,
      universalCredits,
      droneEnergyCores,
      factionRewardTokenRegistry,
      mockLobbyCheck,
      owner,
      gameEOA,
      fleetsEOA,
      human,
      aiOwner,
      other,
    };
  }

  const defaultEquipment = { mainWeapon: 0, armor: 0, shields: 0, special: 0 };
  const defaultTraits = {
    serialNumber: 0n,
    colors: { h1: 0, s1: 0, l1: 0, h2: 0, s2: 0, l2: 0, h3: 0, s3: 0, l3: 0 },
    variant: 1,
    accuracy: 0,
    hull: 0,
    speed: 0,
  };
  const shipData = {
    shipsDestroyed: 0,
    costsVersion: 0,
    cost: 0,
    modified: 0,
    shiny: false,
    constructed: false,
    inFleet: false,
    isFreeShip: false,
    timestampDestroyed: 0n,
  };

  async function mintHumanShip(ships: any, to: `0x${string}`, name: string) {
    await ships.write.createSpecificShip([
      to,
      { name, id: 0n, equipment: defaultEquipment, traits: defaultTraits, shipData, owner: zeroAddress },
    ]);
    return await ships.read.shipCount();
  }

  async function allocateAiShip(
    aiShips: any,
    to: `0x${string}`,
    name: string,
    variant: number = 1,
  ) {
    await aiShips.write.allocateShip([
      to,
      {
        name,
        id: 0n,
        equipment: defaultEquipment,
        traits: { ...defaultTraits, variant },
        shipData,
        owner: zeroAddress,
      },
    ]);
    return AI_SHIP_ID_OFFSET + (await aiShips.read.slotCount());
  }

  describe("getShip / isShipDestroyed dispatch", function () {
    it("resolves a human id against Ships.sol and an AI id against AIShips.sol", async function () {
      const { ships, aiShips, shipsRouter, human, aiOwner } =
        await loadFixture(deployFixture);

      const humanId = await mintHumanShip(ships, human.account.address, "Human Ship");
      const aiId = await allocateAiShip(aiShips, aiOwner.account.address, "AI Ship");

      const viaRouterHuman = await shipsRouter.read.getShip([humanId]);
      expect(viaRouterHuman.name).to.equal("Human Ship");
      expect(viaRouterHuman.owner.toLowerCase()).to.equal(
        human.account.address.toLowerCase(),
      );

      const viaRouterAi = await shipsRouter.read.getShip([aiId]);
      expect(viaRouterAi.name).to.equal("AI Ship");
      expect(viaRouterAi.owner.toLowerCase()).to.equal(
        aiOwner.account.address.toLowerCase(),
      );

      expect(await shipsRouter.read.isShipDestroyed([humanId])).to.equal(false);
      expect(await shipsRouter.read.isShipDestroyed([aiId])).to.equal(false);
    });
  });

  describe("setInFleet", function () {
    it("reverts when called by anyone other than owner or the configured fleetsAddress", async function () {
      const { otherRouter, ships, human } = await loadFixture(deployFixture);
      const humanId = await mintHumanShip(ships, human.account.address, "Ship");

      await expect(
        otherRouter.write.setInFleet([humanId, true]),
      ).to.be.rejectedWith("NotAuthorized");
    });

    it("dispatches to Ships.sol for a human id and AIShips.sol for an AI id", async function () {
      const { fleetsRouter, ships, aiShips, human, aiOwner } =
        await loadFixture(deployFixture);
      const humanId = await mintHumanShip(ships, human.account.address, "Ship");
      const aiId = await allocateAiShip(aiShips, aiOwner.account.address, "AI Ship");

      await fleetsRouter.write.setInFleet([humanId, true]);
      await fleetsRouter.write.setInFleet([aiId, true]);

      expect((await ships.read.getShip([humanId])).shipData.inFleet).to.equal(
        true,
      );
      expect((await aiShips.read.getShip([aiId])).shipData.inFleet).to.equal(
        true,
      );
    });
  });

  describe("setTimestampDestroyed", function () {
    it("reverts when called by anyone other than owner or the configured gameAddress", async function () {
      const { otherRouter, ships, human } = await loadFixture(deployFixture);
      const humanId = await mintHumanShip(ships, human.account.address, "Ship");

      await expect(
        otherRouter.write.setTimestampDestroyed([humanId, humanId]),
      ).to.be.rejectedWith("NotAuthorized");
    });

    it("pays the destroyer DEC (not UTC) when a human ship destroys an AI-owned ship", async function () {
      const { gameRouter, ships, aiShips, universalCredits, droneEnergyCores, human, aiOwner } =
        await loadFixture(deployFixture);

      const humanId = await mintHumanShip(ships, human.account.address, "Human Ship");
      // Variant 2 -- this fixture registers variant 2's reward token as
      // DEC, mirroring production's real mapping.
      const aiId = await allocateAiShip(aiShips, aiOwner.account.address, "AI Ship", 2);

      const recycleReward = await ships.read.recycleReward();
      await gameRouter.write.setTimestampDestroyed([aiId, humanId]);

      expect(await aiShips.read.isShipDestroyed([aiId])).to.equal(true);
      expect(
        await droneEnergyCores.read.balanceOf([human.account.address]),
      ).to.equal(recycleReward >> 2n);
      expect(
        await universalCredits.read.balanceOf([human.account.address]),
      ).to.equal(0n);

      // PvE kills don't count toward rank (docs/audit-3.md HA6-16).
      const humanShip = await ships.read.getShip([humanId]);
      expect(humanShip.shipData.shipsDestroyed).to.equal(0);
    });

    it("pays nothing and credits no kill when an AI ship destroys a human-owned ship (HA6-16/HA6-21)", async function () {
      const { gameRouter, ships, aiShips, universalCredits, droneEnergyCores, human, aiOwner } =
        await loadFixture(deployFixture);

      const humanId = await mintHumanShip(ships, human.account.address, "Human Ship");
      const aiId = await allocateAiShip(aiShips, aiOwner.account.address, "AI Ship");

      const recycleReward = await ships.read.recycleReward();
      await gameRouter.write.setTimestampDestroyed([humanId, aiId]);

      expect((await ships.read.getShip([humanId])).shipData.timestampDestroyed).to.not.equal(0n);
      // The AI ship's owner is an orchestrator contract; UTC minted to it
      // was stuck (HA6-21), so no reward is paid at all.
      expect(recycleReward > 0n).to.equal(true);
      expect(
        await universalCredits.read.balanceOf([aiOwner.account.address]),
      ).to.equal(0n);
      expect(
        await droneEnergyCores.read.balanceOf([aiOwner.account.address]),
      ).to.equal(0n);

      const aiShip = await aiShips.read.getShip([aiId]);
      expect(aiShip.shipData.shipsDestroyed).to.equal(0);
    });

    it("still pays UTC correctly for a pure human-vs-human (PvP) kill", async function () {
      const { gameRouter, ships, universalCredits, droneEnergyCores, human, other } =
        await loadFixture(deployFixture);

      const destroyedId = await mintHumanShip(ships, human.account.address, "Victim");
      const destroyerId = await mintHumanShip(ships, other.account.address, "Attacker");

      const recycleReward = await ships.read.recycleReward();
      await gameRouter.write.setTimestampDestroyed([destroyedId, destroyerId]);

      expect(
        await universalCredits.read.balanceOf([other.account.address]),
      ).to.equal(recycleReward >> 2n);
      expect(
        await droneEnergyCores.read.balanceOf([other.account.address]),
      ).to.equal(0n);
      // A PvP kill of a non-free ship does count toward rank.
      expect(
        (await ships.read.getShip([destroyerId])).shipData.shipsDestroyed,
      ).to.equal(1);
    });

    it("pays nothing and credits no kill for destroying a free ship (HA6-16)", async function () {
      const { gameRouter, ships, universalCredits, human, other } =
        await loadFixture(deployFixture);

      await ships.write.createSpecificShip([
        human.account.address,
        {
          name: "Free Victim",
          id: 0n,
          equipment: defaultEquipment,
          traits: defaultTraits,
          shipData: { ...shipData, isFreeShip: true },
          owner: zeroAddress,
        },
      ]);
      const destroyedId = await ships.read.shipCount();
      const destroyerId = await mintHumanShip(ships, other.account.address, "Attacker");

      await gameRouter.write.setTimestampDestroyed([destroyedId, destroyerId]);

      expect(
        (await ships.read.getShip([destroyedId])).shipData.timestampDestroyed,
      ).to.not.equal(0n);
      expect(
        await universalCredits.read.balanceOf([other.account.address]),
      ).to.equal(0n);
      expect(
        (await ships.read.getShip([destroyerId])).shipData.shipsDestroyed,
      ).to.equal(0);
    });

    it("still processes the kill when the reward mint fails, emitting RewardSkipped instead of reverting (HA6-22)", async function () {
      const { gameRouter, ships, universalCredits, human, other } =
        await loadFixture(deployFixture);

      const destroyedId = await mintHumanShip(ships, human.account.address, "Victim");
      const destroyerId = await mintHumanShip(ships, other.account.address, "Attacker");

      // Minting switched off: the UTC mint inside the reward reverts.
      await universalCredits.write.setMintIsActive([false]);
      await gameRouter.write.setTimestampDestroyed([destroyedId, destroyerId]);

      expect(
        (await ships.read.getShip([destroyedId])).shipData.timestampDestroyed,
      ).to.not.equal(0n);
      expect(
        (await ships.read.getShip([destroyerId])).shipData.shipsDestroyed,
      ).to.equal(1);
      expect(
        await universalCredits.read.balanceOf([other.account.address]),
      ).to.equal(0n);
    });

    it("mints no reward token and does not revert when the destroyed AI ship's variant has no reward token registered", async function () {
      const { gameRouter, ships, aiShips, universalCredits, droneEnergyCores, human, aiOwner } =
        await loadFixture(deployFixture);

      const humanId = await mintHumanShip(ships, human.account.address, "Human Ship");
      // Variant 1 -- deliberately never registered in this fixture (only
      // variant 2 is, mirroring production), unlike variant 2's AI kill
      // above.
      const aiId = await allocateAiShip(aiShips, aiOwner.account.address, "Unfunded AI Ship", 1);

      await gameRouter.write.setTimestampDestroyed([aiId, humanId]);

      // The kill still processes fully -- no revert, ship still marked
      // destroyed -- it just pays no reward currently. (No kill credit
      // either: PvE kills don't count toward rank, HA6-16.)
      expect(await aiShips.read.isShipDestroyed([aiId])).to.equal(true);
      const humanShip = await ships.read.getShip([humanId]);
      expect(humanShip.shipData.shipsDestroyed).to.equal(0);

      expect(
        await droneEnergyCores.read.balanceOf([human.account.address]),
      ).to.equal(0n);
      expect(
        await universalCredits.read.balanceOf([human.account.address]),
      ).to.equal(0n);
    });

    it("mints a newly-registered token for a variant registered after the router's initial deploy", async function () {
      const {
        gameRouter,
        ships,
        aiShips,
        shipAttributes,
        factionRewardTokenRegistry,
        shipsRouter,
        owner,
        human,
        aiOwner,
      } = await loadFixture(deployFixture);

      // A brand-new AI faction (variant 3) and its own brand-new reward
      // token, both deployed/configured well after shipsRouter/
      // destroyRewardLib already exist -- proves a new faction's reward
      // token can be added with zero contract redeploy.
      await shipAttributes.write.setCosts(
        [
          3,
          costsParams({
            version: 0,
            baseCost: 50,
            accuracy: [0, 10, 25],
            hull: [0, 10, 25],
            speed: [0, 10, 25],
            mainWeapon: [25, 30, 40, 40],
            armor: [0, 5, 10, 15],
            shields: [0, 10, 20, 30],
            special: [0, 10, 20, 15, 15, 20, 10, 0],
          }),
        ],
        { account: owner.account },
      );
      const newFactionToken = await hre.viem.deployContract("DroneEnergyCores");
      await newFactionToken.write.setMintIsActive([true]);
      await newFactionToken.write.setAuthorizedToMint([shipsRouter.address, true]);
      await factionRewardTokenRegistry.write.setRewardToken([3, newFactionToken.address]);

      const humanId = await mintHumanShip(ships, human.account.address, "Human Ship");
      const aiId = await allocateAiShip(aiShips, aiOwner.account.address, "Faction 3 Ship", 3);

      const recycleReward = await ships.read.recycleReward();
      await gameRouter.write.setTimestampDestroyed([aiId, humanId]);

      expect(
        await newFactionToken.read.balanceOf([human.account.address]),
      ).to.equal(recycleReward >> 2n);
    });
  });

  describe("dead-in-production passthroughs", function () {
    // createShips/createSpecificShip/customizeShip revert unconditionally
    // (HA-01, docs/pre-audit.md) rather than forwarding to Ships.sol: a
    // forwarding version — even one that reverted today because the router
    // isn't on Ships.isAllowedToCreateShips — would become a live, free,
    // unlimited ship-minting/customization backdoor the moment anyone ever
    // added this router to that allowlist. These exist only to satisfy the
    // IShips interface Game.sol's constructor expects.
    it("createShips reverts unconditionally", async function () {
      const { shipsRouter, human } = await loadFixture(deployFixture);

      await expect(
        shipsRouter.write.createShips([
          human.account.address,
          1n,
          1,
          0,
          false,
        ]),
      ).to.be.rejectedWith("NotSupported");
    });

    it("createSpecificShip reverts unconditionally, never reaching Ships.sol", async function () {
      const { shipsRouter, human } = await loadFixture(deployFixture);

      await expect(
        shipsRouter.write.createSpecificShip([
          human.account.address,
          { name: "x", id: 0n, equipment: defaultEquipment, traits: defaultTraits, shipData, owner: zeroAddress },
        ]),
      ).to.be.rejectedWith("NotSupported");
    });

    it("customizeShip reverts unconditionally", async function () {
      const { shipsRouter } = await loadFixture(deployFixture);

      await expect(
        shipsRouter.write.customizeShip([
          1n,
          { name: "x", id: 1n, equipment: defaultEquipment, traits: defaultTraits, shipData, owner: zeroAddress },
        ]),
      ).to.be.rejectedWith("NotSupported");
    });

    it("maxVariant/recycleReward passthrough to Ships.sol's own values", async function () {
      const { shipsRouter, ships } = await loadFixture(deployFixture);

      expect(await shipsRouter.read.maxVariant()).to.equal(
        await ships.read.maxVariant(),
      );
      expect(await shipsRouter.read.recycleReward()).to.equal(
        await ships.read.recycleReward(),
      );
    });
  });
});

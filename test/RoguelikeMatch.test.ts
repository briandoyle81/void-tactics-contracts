import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers";
import hre from "hardhat";
import { parseEther, zeroAddress } from "viem";
import {
  ActionType,
  GameDataView,
  MapMode,
  ShipTuple,
  tupleToShip,
} from "./types";
import DeployModule from "../ignition/modules/DeployAndConfig";
import roguelikeStarterContent from "../ignition/data/roguelikeStarterContent.json";
import {
  setShipPosition,
  setShipHullPointsToZero,
} from "./helpers/gameStorage";

const AI_SHIP_ID_OFFSET = 2n ** 40n;
const ROGUELIKE_GAME_ID_OFFSET = 2n ** 41n;

enum RoguelikeNodeKind {
  Combat = 0,
  Resupply = 1,
}

describe("RoguelikeMatch / RoguelikeResupply / RoguelikeNodeMap", function () {
  async function deployFixture() {
    const [owner, human, other] = await hre.viem.getWalletClients();
    const publicClient = await hre.viem.getPublicClient();
    const deployed = await hre.ignition.deploy(DeployModule);

    const humanRoguelikeMatch = await hre.viem.getContractAt(
      "RoguelikeMatch",
      deployed.roguelikeMatch.address,
      { client: { wallet: human } },
    );
    const otherRoguelikeMatch = await hre.viem.getContractAt(
      "RoguelikeMatch",
      deployed.roguelikeMatch.address,
      { client: { wallet: other } },
    );
    const humanRoguelikeResupply = await hre.viem.getContractAt(
      "RoguelikeResupply",
      deployed.roguelikeResupply.address,
      { client: { wallet: human } },
    );
    const humanGame = await hre.viem.getContractAt(
      "Game",
      deployed.game.address,
      { client: { wallet: human } },
    );
    const humanUniversalCredits = await hre.viem.getContractAt(
      "UniversalCredits",
      deployed.universalCredits.address,
      { client: { wallet: human } },
    );

    return {
      owner,
      human,
      other,
      publicClient,
      deployed,
      humanRoguelikeMatch,
      otherRoguelikeMatch,
      humanRoguelikeResupply,
      humanGame,
      humanUniversalCredits,
    };
  }

  // One AI ship, Grunt archetype, at (0, 16) — the AIShips pool's first
  // ever allocation always lands there, matching test/SinglePlayerMatch
  // .test.ts's own convention.
  async function setupBasicAIEncounter(
    maps: any,
    aiEncounters: any,
    variant = 1,
    archetype = 0, // Grunt
  ) {
    await maps.write.createPresetMap([[], MapMode.Both]);
    const mapId = await maps.read.mapCount();
    const defaultEquipment = {
      mainWeapon: 0,
      armor: 0,
      shields: 0,
      special: 0,
    };
    const defaultTraits = {
      serialNumber: 0n,
      colors: {
        h1: 0,
        s1: 0,
        l1: 0,
        h2: 0,
        s2: 0,
        l2: 0,
        h3: 0,
        s3: 0,
        l3: 0,
      },
      variant,
      accuracy: 0,
      hull: 0,
      speed: 0,
    };
    await aiEncounters.write.createAIShipConfig([
      "AI Ship",
      defaultEquipment,
      defaultTraits,
      archetype,
    ]);
    const configId = await aiEncounters.read.aiShipConfigCount();
    await aiEncounters.write.setMapPlacement([mapId, 0, 16, configId]);
    return mapId as bigint;
  }

  async function purchaseAndConstructHumanShips(
    ships: any,
    randomManager: any,
    human: any,
  ) {
    await ships.write.purchaseWithFlow(
      [human.account.address, 0n, human.account.address, 1],
      { value: parseEther("4.99") },
    );
    for (let i = 1; i <= 5; i++) {
      const shipTuple = (await ships.read.ships([BigInt(i)])) as ShipTuple;
      const ship = tupleToShip(shipTuple);
      await randomManager.write.revealRandomness([ship.traits.serialNumber]);
    }
    await ships.write.constructAllMyShips({ account: human.account });
  }

  async function createCombatNode(
    roguelikeNodeMap: any,
    campaignId: bigint,
    mapId: bigint,
  ) {
    await roguelikeNodeMap.write.createNode([
      campaignId,
      RoguelikeNodeKind.Combat,
      mapId,
      86400n,
      20n,
      true,
      0n,
    ]);
    return await roguelikeNodeMap.read.nodeCount();
  }

  async function createResupplyNode(
    roguelikeNodeMap: any,
    campaignId: bigint,
    costCapOverride = 0n,
  ) {
    await roguelikeNodeMap.write.createNode([
      campaignId,
      RoguelikeNodeKind.Resupply,
      0n,
      0n,
      0n,
      false,
      costCapOverride,
    ]);
    return await roguelikeNodeMap.read.nodeCount();
  }

  async function setupCampaignWithRoot(
    roguelikeNodeMap: any,
    maps: any,
    aiEncounters: any,
    costCap = 2000n,
    variant = 1,
    archetype = 0,
  ) {
    const mapId = await setupBasicAIEncounter(
      maps,
      aiEncounters,
      variant,
      archetype,
    );
    await roguelikeNodeMap.write.createCampaign();
    const campaignId = await roguelikeNodeMap.read.campaignCount();
    const rootNodeId = await createCombatNode(roguelikeNodeMap, campaignId, mapId);
    await roguelikeNodeMap.write.setCampaignRoot([campaignId, rootNodeId]);
    await roguelikeNodeMap.write.setCampaignInitialCostCap([campaignId, costCap]);
    return { mapId, campaignId, rootNodeId };
  }

  // Wins the currently-active combat node by handing the turn to the AI,
  // letting it take exactly one real action (so any damage it deals to the
  // human ship is genuine, not hardcoded), then forcing its surrender —
  // mirrors test/SinglePlayerMatch.test.ts's own "surrenders when at 0 HP"
  // pattern rather than playing out full combat.
  async function winCombatNode(
    game: any,
    humanGame: any,
    otherRoguelikeMatch: any,
    owner: any,
    human: any,
    gameId: bigint,
    humanShipId: bigint,
  ) {
    const aiShipId = AI_SHIP_ID_OFFSET + 1n;

    await setShipPosition(game.address, gameId, humanShipId, 0, 15);

    await humanGame.write.moveShip(
      [gameId, humanShipId, 0, 15, ActionType.Pass, 0n],
      { account: human.account },
    );

    // AI's one real move — may shoot the adjacent human ship.
    await otherRoguelikeMatch.write.takeAITurn([gameId]);

    await setShipHullPointsToZero(game.address, gameId, aiShipId);
    await otherRoguelikeMatch.write.takeAITurn([gameId]);
  }

  // Launches and wins the root combat mission, so the run is free to move
  // on — leaving a combat node requires having won it (CurrentNodeNotCleared).
  async function clearRoot(fx: any, rootNodeId: bigint) {
    const { deployed, owner, human, humanRoguelikeMatch, otherRoguelikeMatch, humanGame } = fx;
    await humanRoguelikeMatch.write.enterCombatNode([
      rootNodeId,
      [{ row: 0, col: 0 }],
    ]);
    const { activeGameId } = await deployed.roguelikeRun.read.getRun([
      human.account.address,
    ]);
    await winCombatNode(
      deployed.game,
      humanGame,
      otherRoguelikeMatch,
      owner,
      human,
      activeGameId,
      1n,
    );
  }

  describe("Deploy wiring", function () {
    it("deploys successfully with all wiring intact", async function () {
      const { deployed } = await loadFixture(deployFixture);
      expect(deployed.roguelikeMatch.address).to.match(/^0x/);
      expect(deployed.roguelikeResupply.address).to.match(/^0x/);
      expect(deployed.roguelikeNodeMap.address).to.match(/^0x/);
      expect(deployed.roguelikeRun.address).to.match(/^0x/);
      expect(deployed.aiBehaviorRegistry.address).to.match(/^0x/);
      expect(deployed.variant1AI.address).to.match(/^0x/);
      expect(deployed.variant2AI.address).to.match(/^0x/);
      expect(deployed.singlePlayerOrchestratorRegistry.address).to.match(/^0x/);
    });

    it("registers both SinglePlayerMatch and RoguelikeMatch as orchestrators", async function () {
      const { deployed } = await loadFixture(deployFixture);
      expect(
        await deployed.singlePlayerOrchestratorRegistry.read.isRegisteredOrchestrator(
          [deployed.singlePlayerMatch.address],
        ),
      ).to.equal(true);
      expect(
        await deployed.singlePlayerOrchestratorRegistry.read.isRegisteredOrchestrator(
          [deployed.roguelikeMatch.address],
        ),
      ).to.equal(true);
    });

    it("rejects deregistering an already-registered orchestrator, but still allows registering a new one (UA-09)", async function () {
      const { deployed, other } = await loadFixture(deployFixture);
      const { singlePlayerOrchestratorRegistry, roguelikeMatch } = deployed;

      // Deregistering a live orchestrator would silently misroute every
      // future kill against its AI ships to the wrong reward token — must
      // be rejected outright, not just discouraged.
      await expect(
        singlePlayerOrchestratorRegistry.write.setOrchestrator([
          roguelikeMatch.address,
          false,
        ]),
      ).to.be.rejectedWith("CannotDeregisterOrchestrator");
      expect(
        await singlePlayerOrchestratorRegistry.read.isRegisteredOrchestrator([
          roguelikeMatch.address,
        ]),
      ).to.equal(true);

      // Registering a brand-new orchestrator (the additive, safe
      // direction) must still work unrestricted.
      await expect(
        singlePlayerOrchestratorRegistry.write.setOrchestrator([
          other.account.address,
          true,
        ]),
      ).to.not.be.rejected;
      expect(
        await singlePlayerOrchestratorRegistry.read.isRegisteredOrchestrator([
          other.account.address,
        ]),
      ).to.equal(true);
    });

    it("pays DEC (not UTC) for destroying a RoguelikeMatch-owned AI ship", async function () {
      const { deployed, owner, human } = await loadFixture(deployFixture);
      const {
        ships,
        shipsRouter,
        universalCredits,
        droneEnergyCores,
        maps,
        aiEncounters,
        roguelikeNodeMap,
        randomManager,
      } = deployed;
      const humanRoguelikeMatch = await hre.viem.getContractAt(
        "RoguelikeMatch",
        deployed.roguelikeMatch.address,
        { client: { wallet: human } },
      );

      // Variant 2 -- production's FactionRewardTokenRegistry registers DEC
      // for variant 2 (see DeployAndConfig.ts's setVariant2RewardTokenCall);
      // variant 1 intentionally has no reward token registered.
      const { rootNodeId } = await setupCampaignWithRoot(
        roguelikeNodeMap,
        maps,
        aiEncounters,
        2000n,
        2,
      );
      await purchaseAndConstructHumanShips(ships, randomManager, human);
      await humanRoguelikeMatch.write.startRun([
        await roguelikeNodeMap.read.campaignCount(),
        [1n],
      ]);
      await humanRoguelikeMatch.write.enterCombatNode([
        rootNodeId,
        [{ row: 0, col: 0 }],
      ]);
      const gameId = ROGUELIKE_GAME_ID_OFFSET + 1n;
      const aiShipId = AI_SHIP_ID_OFFSET + 1n;

      const [utcBefore, decBefore, recycleReward] = await Promise.all([
        universalCredits.read.balanceOf([human.account.address]),
        droneEnergyCores.read.balanceOf([human.account.address]),
        ships.read.recycleReward(),
      ]);

      await shipsRouter.write.setTimestampDestroyed([aiShipId, 1n], {
        account: owner.account,
      });

      const [utcAfter, decAfter] = await Promise.all([
        universalCredits.read.balanceOf([human.account.address]),
        droneEnergyCores.read.balanceOf([human.account.address]),
      ]);

      expect(decAfter - decBefore).to.equal(recycleReward >> 2n);
      expect(utcAfter).to.equal(utcBefore);
    });
  });

  describe("startRun", function () {
    it("reverts with an empty roster", async function () {
      const { deployed, humanRoguelikeMatch } = await loadFixture(deployFixture);
      const { maps, aiEncounters, roguelikeNodeMap } = deployed;
      const { campaignId } = await setupCampaignWithRoot(
        roguelikeNodeMap,
        maps,
        aiEncounters,
      );
      await expect(
        humanRoguelikeMatch.write.startRun([campaignId, []]),
      ).to.be.rejectedWith("EmptyRoster");
    });

    it("reverts for a campaign that doesn't exist", async function () {
      const { humanRoguelikeMatch } = await loadFixture(deployFixture);
      await expect(
        humanRoguelikeMatch.write.startRun([999n, [1n]]),
      ).to.be.rejectedWith("CampaignNotFound");
    });

    it("reverts for a campaign with no root node set", async function () {
      const { deployed, humanRoguelikeMatch } = await loadFixture(deployFixture);
      const { roguelikeNodeMap } = deployed;
      await roguelikeNodeMap.write.createCampaign();
      const campaignId = await roguelikeNodeMap.read.campaignCount();
      await expect(
        humanRoguelikeMatch.write.startRun([campaignId, [1n]]),
      ).to.be.rejectedWith("CampaignHasNoRoot");
    });

    it("reverts when the campaign requires a different variant", async function () {
      const { deployed, human, humanRoguelikeMatch } = await loadFixture(
        deployFixture,
      );
      const { ships, maps, aiEncounters, roguelikeNodeMap, randomManager } =
        deployed;
      const { campaignId } = await setupCampaignWithRoot(
        roguelikeNodeMap,
        maps,
        aiEncounters,
      );
      await roguelikeNodeMap.write.setCampaignRequiredVariant([campaignId, 2]);
      await purchaseAndConstructHumanShips(ships, randomManager, human);

      await expect(
        humanRoguelikeMatch.write.startRun([campaignId, [1n]]),
      ).to.be.rejectedWith("WrongCampaignVariant");
    });

    it("reserves the roster fleet and records an Active run at the root node", async function () {
      const { deployed, human, humanRoguelikeMatch } = await loadFixture(
        deployFixture,
      );
      const { ships, maps, aiEncounters, roguelikeNodeMap, randomManager } =
        deployed;
      const { campaignId, rootNodeId } = await setupCampaignWithRoot(
        roguelikeNodeMap,
        maps,
        aiEncounters,
      );
      await purchaseAndConstructHumanShips(ships, randomManager, human);

      await humanRoguelikeMatch.write.startRun([campaignId, [1n]]);

      const run = await deployed.roguelikeRun.read.getRun([
        human.account.address,
      ]);
      expect(run.status).to.equal(1); // Active
      expect(run.currentNodeId).to.equal(rootNodeId);
      expect(run.rosterShipIds.map(String)).to.deep.equal(["1"]);

      const shipAfter = await ships.read.getShip([1n]);
      expect(shipAfter.shipData.inFleet).to.equal(true);
    });

    it("reverts starting a second run while one is already active", async function () {
      const { deployed, human, humanRoguelikeMatch } = await loadFixture(
        deployFixture,
      );
      const { ships, maps, aiEncounters, roguelikeNodeMap, randomManager } =
        deployed;
      const { campaignId } = await setupCampaignWithRoot(
        roguelikeNodeMap,
        maps,
        aiEncounters,
      );
      await purchaseAndConstructHumanShips(ships, randomManager, human);
      await humanRoguelikeMatch.write.startRun([campaignId, [1n]]);

      await expect(
        humanRoguelikeMatch.write.startRun([campaignId, [2n]]),
      ).to.be.rejectedWith("RunAlreadyActive");
    });
  });

  describe("GameLens aggregate views", function () {
    it("pages a player's owned ships, clamped to their count", async function () {
      const { deployed, human } = await loadFixture(deployFixture);
      const { ships, randomManager, gameLens } = deployed;
      await purchaseAndConstructHumanShips(ships, randomManager, human);
      const owner = human.account.address;
      const total = await ships.read.shipsOwnedCount([owner]);
      expect(total).to.equal(5n);

      const [firstTwo, t1] = await gameLens.read.getShipsOwned([owner, 0n, 2n]);
      expect(t1).to.equal(total);
      expect(firstTwo.map((s: any) => s.id)).to.deep.equal([
        await ships.read.shipIdOwnedAt([owner, 0n]),
        await ships.read.shipIdOwnedAt([owner, 1n]),
      ]);

      const [tail] = await gameLens.read.getShipsOwned([owner, 4n, 10n]);
      expect(tail.length).to.equal(1);
      const [past] = await gameLens.read.getShipsOwned([owner, 5n, 1n]);
      expect(past.length).to.equal(0);
      // _offset + _limit overflowing must clamp, not revert.
      const [all] = await gameLens.read.getShipsOwned([owner, 1n, 2n ** 256n - 1n]);
      expect(all.length).to.equal(4);
    });

    it("returns each reachable node exactly once, root first, through a diamond and a cycle", async function () {
      const { deployed } = await loadFixture(deployFixture);
      const { maps, aiEncounters, roguelikeNodeMap, gameLens } = deployed;
      const { campaignId, rootNodeId, mapId } = await setupCampaignWithRoot(
        roguelikeNodeMap,
        maps,
        aiEncounters,
      );
      const a = await createCombatNode(roguelikeNodeMap, campaignId, mapId);
      const b = await createCombatNode(roguelikeNodeMap, campaignId, mapId);
      const c = await createCombatNode(roguelikeNodeMap, campaignId, mapId);
      // Created but never linked — must not appear.
      await createCombatNode(roguelikeNodeMap, campaignId, mapId);
      await roguelikeNodeMap.write.addChild([rootNodeId, a]);
      await roguelikeNodeMap.write.addChild([rootNodeId, b]);
      await roguelikeNodeMap.write.addChild([a, c]);
      await roguelikeNodeMap.write.addChild([b, c]); // diamond
      await roguelikeNodeMap.write.addChild([c, a]); // cycle

      const graph = await gameLens.read.getCampaignGraph([campaignId]);
      const ids = graph.map((n: any) => n.id);
      expect(ids[0]).to.equal(rootNodeId);
      expect([...ids].sort()).to.deep.equal([rootNodeId, a, b, c].sort());
      expect(graph[0].children).to.deep.equal([a, b]);

      expect(await gameLens.read.getCampaignGraph([999n])).to.deep.equal([]);
    });

    it("walks the whole deploy-seeded roguelike campaign", async function () {
      const { deployed } = await loadFixture(deployFixture);
      const { roguelikeNodeMap, gameLens } = deployed;
      const graph = await gameLens.read.getCampaignGraph([1n]);
      const ids = graph.map((n: any) => n.id);

      // Compared against what's reachable from the root in the data file,
      // not every node in it: orphaned nodes are acceptable while the
      // progression path is being redesigned (2026-10-12), and the graph
      // walk can't see them by construction.
      const reachable = new Set([roguelikeStarterContent.root]);
      for (let grew = true; grew; ) {
        grew = false;
        for (const e of roguelikeStarterContent.edges) {
          if (reachable.has(e.from) && !reachable.has(e.to)) {
            reachable.add(e.to);
            grew = true;
          }
        }
      }
      const reachableEdges = roguelikeStarterContent.edges.filter((e) =>
        reachable.has(e.from),
      );

      expect(ids[0]).to.equal(await roguelikeNodeMap.read.campaignRootNode([1n]));
      expect(new Set(ids).size).to.equal(ids.length);
      expect(ids.length).to.equal(reachable.size);
      const edgeCount = graph.reduce((n: number, node: any) => n + node.children.length, 0);
      expect(edgeCount).to.equal(reachableEdges.length);
      for (const node of graph) expect(node.campaignId).to.equal(1n);
    });

    it("returns a player's run, roster HP and per-node lock/defeat flags in one call", async function () {
      const fx = await loadFixture(deployFixture);
      const { deployed, owner, human, humanRoguelikeMatch, otherRoguelikeMatch, humanGame } = fx;
      const { ships, maps, aiEncounters, roguelikeNodeMap, roguelikeRun, randomManager, game, gameLens } =
        deployed;
      const player = human.account.address;

      // No run yet: zeroed run, nothing else.
      const empty = await gameLens.read.getRunView([player]);
      expect(empty.run.status).to.equal(0);
      expect(empty.rosterHP).to.deep.equal([]);
      expect(empty.nodeIds).to.deep.equal([]);

      const { campaignId, rootNodeId, mapId } = await setupCampaignWithRoot(
        roguelikeNodeMap,
        maps,
        aiEncounters,
      );
      const childA = await createCombatNode(roguelikeNodeMap, campaignId, mapId);
      const childB = await createCombatNode(roguelikeNodeMap, campaignId, mapId);
      // childA needs a child so winning it doesn't end the run as Won.
      const grandchild = await createCombatNode(roguelikeNodeMap, campaignId, mapId);
      await roguelikeNodeMap.write.addChild([rootNodeId, childA]);
      await roguelikeNodeMap.write.addChild([rootNodeId, childB]);
      await roguelikeNodeMap.write.addChild([childA, grandchild]);

      await purchaseAndConstructHumanShips(ships, randomManager, human);
      await humanRoguelikeMatch.write.startRun([campaignId, [1n]]);
      await clearRoot(fx, rootNodeId);
      await humanRoguelikeMatch.write.enterCombatNode([
        childA,
        [{ row: 0, col: 0 }],
      ]);
      await winCombatNode(
        game,
        humanGame,
        otherRoguelikeMatch,
        owner,
        human,
        ROGUELIKE_GAME_ID_OFFSET + 2n, // match 1 was the root
        1n,
      );

      const v = await gameLens.read.getRunView([player]);
      expect(v.run.status).to.equal(1); // Active
      expect(v.run.campaignId).to.equal(campaignId);
      expect(v.run.rosterShipIds).to.deep.equal([1n]);
      expect(v.rosterHP).to.deep.equal([
        await roguelikeRun.read.getShipHP([player, 1n]),
      ]);

      const graph = await gameLens.read.getCampaignGraph([campaignId]);
      expect(v.nodeIds).to.deep.equal(graph.map((n: any) => n.id));
      for (const [i, id] of v.nodeIds.entries()) {
        expect(v.nodeLocked[i], `locked ${id}`).to.equal(
          await roguelikeRun.read.isNodeLocked([player, id]),
        );
        expect(v.nodeDefeated[i], `defeated ${id}`).to.equal(
          await roguelikeRun.read.isNodeDefeated([player, id]),
        );
      }
      // Spot-check the flags actually vary, so the loop above isn't
      // comparing all-false against all-false.
      expect(v.nodeLocked[v.nodeIds.indexOf(childB)]).to.equal(true);
      expect(v.nodeDefeated[v.nodeIds.indexOf(childA)]).to.equal(true);
      expect(v.nodeDefeated[v.nodeIds.indexOf(grandchild)]).to.equal(false);
    });
  });

  describe("Graph lockout", function () {
    it("locks every other sibling and the parent on a one-way commit", async function () {
      const fx = await loadFixture(deployFixture);
      const { deployed, human, humanRoguelikeMatch } = fx;
      const { ships, maps, aiEncounters, roguelikeNodeMap, randomManager } =
        deployed;
      const { campaignId, rootNodeId, mapId } = await setupCampaignWithRoot(
        roguelikeNodeMap,
        maps,
        aiEncounters,
      );
      const childA = await createCombatNode(roguelikeNodeMap, campaignId, mapId);
      const childB = await createCombatNode(roguelikeNodeMap, campaignId, mapId);
      await roguelikeNodeMap.write.addChild([rootNodeId, childA]);
      await roguelikeNodeMap.write.addChild([rootNodeId, childB]);

      await purchaseAndConstructHumanShips(ships, randomManager, human);
      await humanRoguelikeMatch.write.startRun([campaignId, [1n]]);
      await clearRoot(fx, rootNodeId);
      await humanRoguelikeMatch.write.enterCombatNode([
        childA,
        [{ row: 0, col: 0 }],
      ]);

      expect(
        await deployed.roguelikeRun.read.isNodeLocked([
          human.account.address,
          childB,
        ]),
      ).to.equal(true);
      expect(
        await deployed.roguelikeRun.read.isNodeLocked([
          human.account.address,
          rootNodeId,
        ]),
      ).to.equal(true);
    });

    it("never lets the run walk back to a parent, even after winning the child", async function () {
      const fx = await loadFixture(deployFixture);
      const { deployed, owner, human, humanRoguelikeMatch, otherRoguelikeMatch, humanGame } = fx;
      const { ships, maps, aiEncounters, roguelikeNodeMap, randomManager, game } =
        deployed;
      const { campaignId, rootNodeId, mapId } = await setupCampaignWithRoot(
        roguelikeNodeMap,
        maps,
        aiEncounters,
      );
      const hub = await createResupplyNode(roguelikeNodeMap, campaignId);
      const child = await createCombatNode(roguelikeNodeMap, campaignId, mapId);
      // child needs a child of its own so winning it doesn't end the run.
      const grandchild = await createCombatNode(roguelikeNodeMap, campaignId, mapId);
      await roguelikeNodeMap.write.addChild([rootNodeId, hub]);
      await roguelikeNodeMap.write.addChild([hub, child]);
      await roguelikeNodeMap.write.addChild([child, grandchild]);

      await purchaseAndConstructHumanShips(ships, randomManager, human);
      await humanRoguelikeMatch.write.startRun([campaignId, [1n]]);
      await clearRoot(fx, rootNodeId);

      // Leaving a resupply node for its child locks the resupply node.
      await humanRoguelikeMatch.write.enterResupplyNode([hub]);
      await humanRoguelikeMatch.write.enterCombatNode([
        child,
        [{ row: 0, col: 0 }],
      ]);
      await winCombatNode(
        game,
        humanGame,
        otherRoguelikeMatch,
        owner,
        human,
        ROGUELIKE_GAME_ID_OFFSET + 2n, // match 1 was the root
        1n,
      );

      expect(
        await deployed.roguelikeRun.read.isNodeLocked([
          human.account.address,
          hub,
        ]),
      ).to.equal(true);
      await expect(
        humanRoguelikeMatch.write.enterResupplyNode([hub]),
      ).to.be.rejectedWith("CannotAdvance");
      await expect(
        humanRoguelikeMatch.write.enterCombatNode([
          rootNodeId,
          [{ row: 0, col: 0 }],
        ]),
      ).to.be.rejectedWith("CannotAdvance");
    });

    it("reverts advancing to a node that isn't a child of the current node", async function () {
      const fx = await loadFixture(deployFixture);
      const { deployed, human, humanRoguelikeMatch } = fx;
      const { ships, maps, aiEncounters, roguelikeNodeMap, randomManager } =
        deployed;
      const { campaignId, mapId, rootNodeId } = await setupCampaignWithRoot(
        roguelikeNodeMap,
        maps,
        aiEncounters,
      );
      const unrelated = await createCombatNode(roguelikeNodeMap, campaignId, mapId);
      // Root needs a child so winning it doesn't end the run as Won.
      const child = await createCombatNode(roguelikeNodeMap, campaignId, mapId);
      await roguelikeNodeMap.write.addChild([rootNodeId, child]);

      await purchaseAndConstructHumanShips(ships, randomManager, human);
      await humanRoguelikeMatch.write.startRun([campaignId, [1n]]);
      await clearRoot(fx, rootNodeId);

      await expect(
        humanRoguelikeMatch.write.enterCombatNode([
          unrelated,
          [{ row: 0, col: 0 }],
        ]),
      ).to.be.rejectedWith("CannotAdvance");
    });
  });

  describe("RoguelikeNodeMap.removeChild stranding guard (UA-05)", function () {
    it("refuses to remove a node's last remaining child while a run is standing there", async function () {
      const { deployed, human } = await loadFixture(deployFixture);
      const { ships, maps, aiEncounters, roguelikeNodeMap, randomManager } =
        deployed;
      const { campaignId, mapId, rootNodeId } = await setupCampaignWithRoot(
        roguelikeNodeMap,
        maps,
        aiEncounters,
      );
      const onlyChild = await createCombatNode(
        roguelikeNodeMap,
        campaignId,
        mapId,
      );
      await roguelikeNodeMap.write.addChild([rootNodeId, onlyChild]);

      const humanRoguelikeMatch = await hre.viem.getContractAt(
        "RoguelikeMatch",
        deployed.roguelikeMatch.address,
        { client: { wallet: human } },
      );
      await purchaseAndConstructHumanShips(ships, randomManager, human);
      await humanRoguelikeMatch.write.startRun([campaignId, [1n]]);
      // Run's currentNodeId is now rootNodeId, whose ONLY child is onlyChild.

      await expect(
        roguelikeNodeMap.write.removeChild([rootNodeId, onlyChild]),
      ).to.be.rejectedWith("WouldStrandActiveRun");
    });

    it("still allows removing a child when it isn't the node's last one", async function () {
      const { deployed, human } = await loadFixture(deployFixture);
      const { ships, maps, aiEncounters, roguelikeNodeMap, randomManager } =
        deployed;
      const { campaignId, mapId, rootNodeId } = await setupCampaignWithRoot(
        roguelikeNodeMap,
        maps,
        aiEncounters,
      );
      const childA = await createCombatNode(roguelikeNodeMap, campaignId, mapId);
      const childB = await createCombatNode(roguelikeNodeMap, campaignId, mapId);
      await roguelikeNodeMap.write.addChild([rootNodeId, childA]);
      await roguelikeNodeMap.write.addChild([rootNodeId, childB]);

      const humanRoguelikeMatch = await hre.viem.getContractAt(
        "RoguelikeMatch",
        deployed.roguelikeMatch.address,
        { client: { wallet: human } },
      );
      await purchaseAndConstructHumanShips(ships, randomManager, human);
      await humanRoguelikeMatch.write.startRun([campaignId, [1n]]);

      // rootNodeId still has childB left after this — not the last child,
      // so this must still succeed even with an active run standing there.
      await expect(
        roguelikeNodeMap.write.removeChild([rootNodeId, childA]),
      ).to.not.be.rejected;
    });

    it("allows removing a node's last child once no run is standing there anymore", async function () {
      const { deployed, human } = await loadFixture(deployFixture);
      const { ships, maps, aiEncounters, roguelikeNodeMap, randomManager } =
        deployed;
      const { campaignId, mapId, rootNodeId } = await setupCampaignWithRoot(
        roguelikeNodeMap,
        maps,
        aiEncounters,
      );
      const onlyChild = await createCombatNode(
        roguelikeNodeMap,
        campaignId,
        mapId,
      );
      await roguelikeNodeMap.write.addChild([rootNodeId, onlyChild]);

      const humanRoguelikeMatch = await hre.viem.getContractAt(
        "RoguelikeMatch",
        deployed.roguelikeMatch.address,
        { client: { wallet: human } },
      );
      await purchaseAndConstructHumanShips(ships, randomManager, human);
      await humanRoguelikeMatch.write.startRun([campaignId, [1n]]);
      await humanRoguelikeMatch.write.retreatRun([0n]);

      await expect(
        roguelikeNodeMap.write.removeChild([rootNodeId, onlyChild]),
      ).to.not.be.rejected;
    });

    it("moves the guard with the run when it advances to a new node", async function () {
      const fx = await loadFixture(deployFixture);
      const { deployed, human } = fx;
      const { ships, maps, aiEncounters, roguelikeNodeMap, randomManager } =
        deployed;
      const { campaignId, mapId, rootNodeId } = await setupCampaignWithRoot(
        roguelikeNodeMap,
        maps,
        aiEncounters,
      );
      // Root has two children so it's never itself down to "last child" —
      // isolates this test to exercising setCurrentNode's own
      // increment/decrement, not removeChild's length==1 gate again.
      const hub = await createResupplyNode(roguelikeNodeMap, campaignId);
      const decoy = await createCombatNode(roguelikeNodeMap, campaignId, mapId);
      await roguelikeNodeMap.write.addChild([rootNodeId, hub]);
      await roguelikeNodeMap.write.addChild([rootNodeId, decoy]);
      // The hub's only child — this is what should become guarded once the
      // run actually moves onto the hub, and NOT before.
      const hubOnlyChild = await createCombatNode(
        roguelikeNodeMap,
        campaignId,
        mapId,
      );
      await roguelikeNodeMap.write.addChild([hub, hubOnlyChild]);

      const humanRoguelikeMatch = await hre.viem.getContractAt(
        "RoguelikeMatch",
        deployed.roguelikeMatch.address,
        { client: { wallet: human } },
      );
      await purchaseAndConstructHumanShips(ships, randomManager, human);
      await humanRoguelikeMatch.write.startRun([campaignId, [1n]]);
      await clearRoot(fx, rootNodeId);

      // Run is still at rootNodeId — the hub's only child isn't guarded
      // yet, since no run has actually reached the hub.
      await expect(
        roguelikeNodeMap.write.removeChild([hub, hubOnlyChild]),
      ).to.not.be.rejected;
      // Re-add it for the rest of the test.
      await roguelikeNodeMap.write.addChild([hub, hubOnlyChild]);

      // Advance onto the hub.
      await humanRoguelikeMatch.write.enterResupplyNode([hub]);

      // Now the hub's only child IS guarded (setCurrentNode's increment
      // fired for the new node)...
      await expect(
        roguelikeNodeMap.write.removeChild([hub, hubOnlyChild]),
      ).to.be.rejectedWith("WouldStrandActiveRun");

      // ...and rootNodeId's old occupancy was correctly cleared
      // (setCurrentNode's decrement fired for the node the run left) — a
      // fresh single-remaining-child scenario back at root must not be
      // blocked by stale accounting from before the run moved on.
      await roguelikeNodeMap.write.removeChild([rootNodeId, decoy]);
      await expect(
        roguelikeNodeMap.write.removeChild([rootNodeId, hub]),
      ).to.not.be.rejected;
    });
  });

  describe("AI registry engine-live pin (UA-08)", function () {
    it("keeps an active combat node's AI on the registry that was live when it started, even if the owner swaps it mid-fight", async function () {
      const { deployed, owner, human } = await loadFixture(deployFixture);
      const { ships, maps, aiEncounters, roguelikeNodeMap, randomManager } =
        deployed;
      const { campaignId, rootNodeId } = await setupCampaignWithRoot(
        roguelikeNodeMap,
        maps,
        aiEncounters,
      );

      const humanRoguelikeMatch = await hre.viem.getContractAt(
        "RoguelikeMatch",
        deployed.roguelikeMatch.address,
        { client: { wallet: human } },
      );
      const otherRoguelikeMatch = await hre.viem.getContractAt(
        "RoguelikeMatch",
        deployed.roguelikeMatch.address,
        { client: { wallet: owner } },
      );
      const humanGame = await hre.viem.getContractAt(
        "Game",
        deployed.game.address,
        { client: { wallet: human } },
      );

      await purchaseAndConstructHumanShips(ships, randomManager, human);
      await humanRoguelikeMatch.write.startRun([campaignId, [1n]]);
      await humanRoguelikeMatch.write.enterCombatNode([
        rootNodeId,
        [{ row: 0, col: 0 }],
      ]);
      const gameId = ROGUELIKE_GAME_ID_OFFSET + 1n;

      await humanGame.write.moveShip(
        [gameId, 1n, 0, 0, ActionType.Pass, 0n],
        { account: human.account },
      );

      // Simulate an admin AI rollout mid-fight: swap in a brand-new, EMPTY
      // registry (no variant registered at all).
      const emptyRegistry = await hre.viem.deployContract(
        "AIBehaviorRegistry",
        [],
      );
      await deployed.roguelikeMatch.write.setAIRegistryAddress([
        emptyRegistry.address,
      ]);

      // The AI's turn in this already-active fight must still succeed — a
      // live read would instead revert NoAIForVariant from the new,
      // unconfigured registry.
      await expect(otherRoguelikeMatch.write.takeAITurn([gameId])).to.not.be
        .rejected;
    });
  });

  describe("Combat node reward farming (SP-05)", function () {
    // Hub (Resupply, root) -> Combat node -> dummy Resupply node -> back to
    // the Combat node (a cycle). The dummy keeps the Combat node non-final,
    // so winning it doesn't end the run and there's something to farm.
    async function setupCycleCampaign(
      roguelikeNodeMap: any,
      maps: any,
      aiEncounters: any,
    ) {
      const mapId = await setupBasicAIEncounter(maps, aiEncounters);
      await roguelikeNodeMap.write.createCampaign();
      const campaignId = await roguelikeNodeMap.read.campaignCount();
      const hubNodeId = await createResupplyNode(roguelikeNodeMap, campaignId);
      const combatNodeId = await createCombatNode(
        roguelikeNodeMap,
        campaignId,
        mapId,
      );
      const dummyNodeId = await createResupplyNode(roguelikeNodeMap, campaignId);
      await roguelikeNodeMap.write.addChild([hubNodeId, combatNodeId]);
      await roguelikeNodeMap.write.addChild([combatNodeId, dummyNodeId]);
      await roguelikeNodeMap.write.addChild([dummyNodeId, combatNodeId]);
      await roguelikeNodeMap.write.setCampaignRoot([campaignId, hubNodeId]);
      await roguelikeNodeMap.write.setCampaignInitialCostCap([campaignId, 2000n]);
      return { campaignId, hubNodeId, combatNodeId, dummyNodeId };
    }

    async function winTheCombatNode(fx: any) {
      const { deployed, owner, human, humanRoguelikeMatch, otherRoguelikeMatch, humanGame } = fx;
      const { ships, maps, aiEncounters, roguelikeNodeMap, randomManager } =
        deployed;
      const ids = await setupCycleCampaign(roguelikeNodeMap, maps, aiEncounters);

      await purchaseAndConstructHumanShips(ships, randomManager, human);
      await humanRoguelikeMatch.write.startRun([ids.campaignId, [1n]]);
      await humanRoguelikeMatch.write.enterCombatNode([
        ids.combatNodeId,
        [{ row: 0, col: 0 }],
      ]);
      await winCombatNode(
        deployed.game,
        humanGame,
        otherRoguelikeMatch,
        owner,
        human,
        ROGUELIKE_GAME_ID_OFFSET + 1n,
        1n,
      );

      // Still Active: the dummy child keeps combatNodeId from being final.
      const run = await deployed.roguelikeRun.read.getRun([
        human.account.address,
      ]);
      expect(run.status).to.equal(1); // Active
      return ids;
    }

    it("reverts re-entering a just-won Combat node in place", async function () {
      const fx = await loadFixture(deployFixture);
      const { combatNodeId } = await winTheCombatNode(fx);

      await expect(
        fx.humanRoguelikeMatch.write.enterCombatNode([
          combatNodeId,
          [{ row: 0, col: 0 }],
        ]),
      ).to.be.rejectedWith("NodeAlreadyDefeated");
    });

    it("reverts re-entering a won Combat node through a cycle in the graph", async function () {
      const fx = await loadFixture(deployFixture);
      const { combatNodeId, dummyNodeId } = await winTheCombatNode(fx);

      await fx.humanRoguelikeMatch.write.enterResupplyNode([dummyNodeId]);
      // dummy -> combatNodeId is a real child edge, but the node was locked
      // when the run left it.
      await expect(
        fx.humanRoguelikeMatch.write.enterCombatNode([
          combatNodeId,
          [{ row: 0, col: 0 }],
        ]),
      ).to.be.rejectedWith("CannotAdvance");
    });
  });

  describe("Combat nodes: HP persistence, auto-heal, run completion", function () {
    it("persists a survivor's damage into the next combat node, applying the auto-heal floor", async function () {
      const { deployed, owner, human, humanRoguelikeMatch, otherRoguelikeMatch, humanGame } =
        await loadFixture(deployFixture);
      const { ships, maps, aiEncounters, roguelikeNodeMap, randomManager, game } =
        deployed;
      const { campaignId, rootNodeId, mapId } = await setupCampaignWithRoot(
        roguelikeNodeMap,
        maps,
        aiEncounters,
      );
      const nextNode = await createCombatNode(roguelikeNodeMap, campaignId, mapId);
      await roguelikeNodeMap.write.addChild([rootNodeId, nextNode]);
      // Heal floor of 90% — the real damage taken (see below) is engineered
      // to leave the ship well below that, so the floor should visibly
      // raise its persisted HP above what it actually ended combat at.
      await roguelikeNodeMap.write.setCampaignAutoHealPercent([campaignId, 90]);

      await purchaseAndConstructHumanShips(ships, randomManager, human);
      await humanRoguelikeMatch.write.startRun([campaignId, [1n]]);
      await humanRoguelikeMatch.write.enterCombatNode([
        rootNodeId,
        [{ row: 0, col: 0 }],
      ]);

      const gameId = ROGUELIKE_GAME_ID_OFFSET + 1n;
      const attrsBefore = await game.read.getShipAttributes([gameId, 1n]);

      await winCombatNode(
        game,
        humanGame,
        otherRoguelikeMatch,
        owner,
        human,
        gameId,
        1n,
      );

      const attrsAfterCombat = await game.read.getShipAttributes([gameId, 1n]);
      expect(attrsAfterCombat.hullPoints).to.be.lessThan(
        attrsBefore.hullPoints,
      );

      const floor = Math.floor(
        (Number(attrsAfterCombat.maxHullPoints) * 90) / 100,
      );
      const expectedPersisted = Math.max(
        Number(attrsAfterCombat.hullPoints),
        floor,
      );
      const persistedHP = await deployed.roguelikeRun.read.getShipHP([
        human.account.address,
        1n,
      ]);
      expect(persistedHP).to.equal(expectedPersisted);

      // Enter the next node — the ship should start already at the
      // persisted (possibly floor-healed) HP, not a fresh 100%.
      await humanRoguelikeMatch.write.enterCombatNode([
        nextNode,
        [{ row: 0, col: 0 }],
      ]);
      const nextGameId = ROGUELIKE_GAME_ID_OFFSET + 2n;
      const attrsNextNode = await game.read.getShipAttributes([
        nextGameId,
        1n,
      ]);
      expect(attrsNextNode.hullPoints).to.equal(expectedPersisted);
    });

    it("carries a disabled (0 HP) survivor forward at 1 HP under a 0% floor, not as the 0 = full-HP sentinel", async function () {
      const { deployed, human, humanRoguelikeMatch, otherRoguelikeMatch, humanGame } =
        await loadFixture(deployFixture);
      const { ships, maps, aiEncounters, roguelikeNodeMap, randomManager, game } =
        deployed;
      const { campaignId, rootNodeId, mapId } = await setupCampaignWithRoot(
        roguelikeNodeMap,
        maps,
        aiEncounters,
      );
      const nextNode = await createCombatNode(roguelikeNodeMap, campaignId, mapId);
      await roguelikeNodeMap.write.addChild([rootNodeId, nextNode]);
      // No auto-heal floor configured (defaults to 0%).

      await purchaseAndConstructHumanShips(ships, randomManager, human);
      await humanRoguelikeMatch.write.startRun([campaignId, [1n]]);
      await humanRoguelikeMatch.write.enterCombatNode([
        rootNodeId,
        [{ row: 0, col: 0 }],
      ]);
      const gameId = ROGUELIKE_GAME_ID_OFFSET + 1n;
      const aiShipId = AI_SHIP_ID_OFFSET + 1n;

      await humanGame.write.moveShip([
        gameId,
        1n,
        0,
        0,
        ActionType.Pass,
        0n,
      ]);
      // Human ship disabled (0 HP, still on the board), then the AI
      // surrenders — the human wins with a disabled survivor.
      await setShipHullPointsToZero(game.address, gameId, 1n);
      await setShipHullPointsToZero(game.address, gameId, aiShipId);
      await otherRoguelikeMatch.write.takeAITurn([gameId]);

      const gameData = (await game.read.getGame([gameId])) as GameDataView;
      expect(gameData.metadata.ended).to.equal(true);
      expect(gameData.metadata.winner.toLowerCase()).to.equal(
        human.account.address.toLowerCase(),
      );
      expect(
        await deployed.roguelikeRun.read.getShipHP([human.account.address, 1n]),
      ).to.equal(1);

      await humanRoguelikeMatch.write.enterCombatNode([
        nextNode,
        [{ row: 0, col: 0 }],
      ]);
      const attrsNext = await game.read.getShipAttributes([
        ROGUELIKE_GAME_ID_OFFSET + 2n,
        1n,
      ]);
      expect(attrsNext.hullPoints).to.equal(1);
    });

    it("ends the run as Won and permanently releases the roster at a childless (final) node", async function () {
      const { deployed, owner, human, humanRoguelikeMatch, otherRoguelikeMatch, humanGame } =
        await loadFixture(deployFixture);
      const { ships, maps, aiEncounters, roguelikeNodeMap, randomManager, game } =
        deployed;
      const { campaignId, rootNodeId } = await setupCampaignWithRoot(
        roguelikeNodeMap,
        maps,
        aiEncounters,
      );
      // rootNodeId has no children -- it IS the final node.
      await purchaseAndConstructHumanShips(ships, randomManager, human);
      await humanRoguelikeMatch.write.startRun([campaignId, [1n]]);
      await humanRoguelikeMatch.write.enterCombatNode([
        rootNodeId,
        [{ row: 0, col: 0 }],
      ]);

      const gameId = ROGUELIKE_GAME_ID_OFFSET + 1n;
      await winCombatNode(
        game,
        humanGame,
        otherRoguelikeMatch,
        owner,
        human,
        gameId,
        1n,
      );

      const run = await deployed.roguelikeRun.read.getRun([
        human.account.address,
      ]);
      expect(run.status).to.equal(2); // Won

      const shipAfter = await ships.read.getShip([1n]);
      expect(shipAfter.shipData.inFleet).to.equal(false);
    });

    it("still ends the run as Won at a node that was final at entry, even if an admin adds a child to it mid-fight (UA-11)", async function () {
      const { deployed, owner, human, humanRoguelikeMatch, otherRoguelikeMatch, humanGame } =
        await loadFixture(deployFixture);
      const { ships, maps, aiEncounters, roguelikeNodeMap, randomManager, game } =
        deployed;
      const { campaignId, mapId, rootNodeId } = await setupCampaignWithRoot(
        roguelikeNodeMap,
        maps,
        aiEncounters,
      );
      // rootNodeId has no children at entry -- it IS final at that moment.
      await purchaseAndConstructHumanShips(ships, randomManager, human);
      await humanRoguelikeMatch.write.startRun([campaignId, [1n]]);
      await humanRoguelikeMatch.write.enterCombatNode([
        rootNodeId,
        [{ row: 0, col: 0 }],
      ]);

      const gameId = ROGUELIKE_GAME_ID_OFFSET + 1n;

      // Simulate an admin content edit mid-fight: give the node the human
      // is CURRENTLY fighting at a real child — after this, a LIVE
      // re-check of "is this node final" would read false.
      const newChild = await createCombatNode(roguelikeNodeMap, campaignId, mapId);
      await roguelikeNodeMap.write.addChild([rootNodeId, newChild]);

      await winCombatNode(
        game,
        humanGame,
        otherRoguelikeMatch,
        owner,
        human,
        gameId,
        1n,
      );

      // The run still ends as Won — proving isFinalNode stayed pinned to
      // what was true at entry (no children yet), not re-derived live at
      // resolution time (which would now see the newly-added child and
      // wrongly continue the run instead of ending it).
      const run = await deployed.roguelikeRun.read.getRun([
        human.account.address,
      ]);
      expect(run.status).to.equal(2); // Won
    });

    it("keeps a combat node's auto-heal floor pinned to whatever was live at entry, even if an admin retunes it mid-fight (UA-11)", async function () {
      const { deployed, owner, human, humanRoguelikeMatch, otherRoguelikeMatch, humanGame } =
        await loadFixture(deployFixture);
      const { ships, maps, aiEncounters, roguelikeNodeMap, randomManager, game } =
        deployed;
      const { campaignId, mapId, rootNodeId } = await setupCampaignWithRoot(
        roguelikeNodeMap,
        maps,
        aiEncounters,
      );
      const nextNode = await createCombatNode(roguelikeNodeMap, campaignId, mapId);
      await roguelikeNodeMap.write.addChild([rootNodeId, nextNode]);
      // Live at entry: 90%, engineered (as the sibling persistence test
      // above does) so real combat damage lands well below it.
      await roguelikeNodeMap.write.setCampaignAutoHealPercent([campaignId, 90]);

      await purchaseAndConstructHumanShips(ships, randomManager, human);
      await humanRoguelikeMatch.write.startRun([campaignId, [1n]]);
      await humanRoguelikeMatch.write.enterCombatNode([
        rootNodeId,
        [{ row: 0, col: 0 }],
      ]);
      const gameId = ROGUELIKE_GAME_ID_OFFSET + 1n;

      // Admin retunes the floor mid-fight — a live (unpinned) read would
      // apply this new, much lower floor to this fight's own result.
      await roguelikeNodeMap.write.setCampaignAutoHealPercent([campaignId, 1]);

      await winCombatNode(
        game,
        humanGame,
        otherRoguelikeMatch,
        owner,
        human,
        gameId,
        1n,
      );

      const attrsAfterCombat = await game.read.getShipAttributes([gameId, 1n]);
      const floorAt90 = Math.floor(
        (Number(attrsAfterCombat.maxHullPoints) * 90) / 100,
      );
      const expectedPersisted = Math.max(
        Number(attrsAfterCombat.hullPoints),
        floorAt90,
      );
      const persistedHP = await deployed.roguelikeRun.read.getShipHP([
        human.account.address,
        1n,
      ]);
      // Proves the 90% floor that was live at entry applied, not the 1%
      // the admin changed it to mid-fight.
      expect(persistedHP).to.equal(expectedPersisted);
    });
  });

  describe("Combat nodes: fled ships (rammed or retreated) rejoin on a win", function () {
    // Any two of the human's ships sharing a variant (Fleets rejects a
    // mixed-variant fleet). Variants are random, so pick at runtime.
    async function pickSameVariantPair(ships: any, ids: bigint[]) {
      const variants = new Map<number, bigint[]>();
      for (const id of ids) {
        const v = Number((await ships.read.getShip([id])).traits.variant);
        const group = variants.get(v) ?? [];
        group.push(id);
        if (group.length === 2) return group as [bigint, bigint];
        variants.set(v, group);
      }
      throw new Error("no same-variant pair");
    }

    // Starts a run with [kept, fled] at a root combat node (80% heal floor,
    // with a following combat node so the win re-reserves the roster).
    async function startTwoShipRun(
      deployed: any,
      human: any,
      humanRoguelikeMatch: any,
      opts: { archetype?: number; costCap?: bigint; tier1?: boolean } = {},
    ) {
      const { ships, maps, aiEncounters, roguelikeNodeMap, randomManager } =
        deployed;
      const { campaignId, rootNodeId, mapId } = await setupCampaignWithRoot(
        roguelikeNodeMap,
        maps,
        aiEncounters,
        opts.costCap ?? 2000n,
        1,
        opts.archetype ?? 0,
      );
      const nextNode = await createCombatNode(roguelikeNodeMap, campaignId, mapId);
      await roguelikeNodeMap.write.addChild([rootNodeId, nextNode]);
      await roguelikeNodeMap.write.setCampaignAutoHealPercent([campaignId, 80]);

      let shipCount = 5;
      if (opts.tier1) {
        // Tier 1 (11 ships) clears Ships' 10-purchase transfer gate.
        await ships.write.purchaseWithFlow(
          [human.account.address, 1n, human.account.address, 1],
          { value: parseEther("9.99") },
        );
        shipCount = 11;
        for (let i = 1; i <= shipCount; i++) {
          const ship = tupleToShip(
            (await ships.read.ships([BigInt(i)])) as ShipTuple,
          );
          await randomManager.write.revealRandomness([ship.traits.serialNumber]);
        }
        await ships.write.constructAllMyShips({ account: human.account });
      } else {
        await purchaseAndConstructHumanShips(ships, randomManager, human);
      }
      const [kept, fled] = await pickSameVariantPair(
        ships,
        Array.from({ length: shipCount }, (_, i) => BigInt(i + 1)),
      );

      await humanRoguelikeMatch.write.startRun([campaignId, [kept, fled]]);
      await humanRoguelikeMatch.write.enterCombatNode([
        rootNodeId,
        [
          { row: 0, col: 0 },
          { row: 1, col: 0 },
        ],
      ]);
      return { kept, fled, nextNode, gameId: ROGUELIKE_GAME_ID_OFFSET + 1n };
    }

    // The AI surrenders on its turn once it has no live ship left.
    async function aiSurrenders(
      game: any,
      otherRoguelikeMatch: any,
      gameId: bigint,
    ) {
      await setShipHullPointsToZero(
        game.address,
        gameId,
        AI_SHIP_ID_OFFSET + 1n,
      );
      await otherRoguelikeMatch.write.takeAITurn([gameId]);
      const gameData = (await game.read.getGame([gameId])) as GameDataView;
      expect(gameData.metadata.ended).to.equal(true);
    }

    it("keeps a retreated ship in the roster at the 80% heal floor and brings it into the next node", async function () {
      const { deployed, human, humanRoguelikeMatch, otherRoguelikeMatch, humanGame } =
        await loadFixture(deployFixture);
      const { game, ships } = deployed;
      const { kept, fled, nextNode, gameId } = await startTwoShipRun(
        deployed,
        human,
        humanRoguelikeMatch,
      );

      await humanGame.write.moveShip([
        gameId,
        fled,
        0,
        0,
        ActionType.Retreat,
        0n,
      ]);
      expect((await game.read.getShipPosition([gameId, fled])).status).to.equal(2);
      await aiSurrenders(game, otherRoguelikeMatch, gameId);

      const run = await deployed.roguelikeRun.read.getRun([
        human.account.address,
      ]);
      expect(run.rosterShipIds.map(String)).to.deep.equal([
        String(kept),
        String(fled),
      ]);
      expect((await ships.read.getShip([fled])).shipData.inFleet).to.equal(true);

      const maxHP = Number(
        (await deployed.shipAttributes.read.calculateShipAttributesById([fled]))
          .maxHullPoints,
      );
      const expected = Math.floor((maxHP * 80) / 100);
      expect(
        await deployed.roguelikeRun.read.getShipHP([human.account.address, fled]),
      ).to.equal(expected);

      await humanRoguelikeMatch.write.enterCombatNode([
        nextNode,
        [
          { row: 0, col: 0 },
          { row: 1, col: 0 },
        ],
      ]);
      const attrsNext = await game.read.getShipAttributes([
        ROGUELIKE_GAME_ID_OFFSET + 2n,
        fled,
      ]);
      expect(attrsNext.hullPoints).to.equal(expected);
    });

    it("keeps a ship rammed off the board by an AI Rammer in the roster at the 80% heal floor", async function () {
      const { deployed, human, humanRoguelikeMatch, otherRoguelikeMatch, humanGame } =
        await loadFixture(deployFixture);
      const { game } = deployed;
      const { kept, fled, gameId } = await startTwoShipRun(
        deployed,
        human,
        humanRoguelikeMatch,
        { archetype: 5 }, // Rammer
      );

      // Downed human ship right next to the AI at (0, 16).
      await setShipPosition(game.address, gameId, fled, 0, 15);
      await setShipHullPointsToZero(game.address, gameId, fled);
      await humanGame.write.moveShip([
        gameId,
        kept,
        0,
        0,
        ActionType.Pass,
        0n,
      ]);
      await otherRoguelikeMatch.write.takeAITurn([gameId]);

      const lastMove = (await game.read.getGame([gameId])) as GameDataView;
      expect(lastMove.lastMove.actionType).to.equal(ActionType.FactionAbility);
      expect(lastMove.lastMove.targetShipId).to.equal(fled);
      expect((await game.read.getShipPosition([gameId, fled])).status).to.equal(2);

      await aiSurrenders(game, otherRoguelikeMatch, gameId);

      const run = await deployed.roguelikeRun.read.getRun([
        human.account.address,
      ]);
      expect(run.rosterShipIds.map(String)).to.deep.equal([
        String(kept),
        String(fled),
      ]);
      const maxHP = Number(
        (await deployed.shipAttributes.read.calculateShipAttributesById([fled]))
          .maxHullPoints,
      );
      expect(
        await deployed.roguelikeRun.read.getShipHP([human.account.address, fled]),
      ).to.equal(Math.floor((maxHP * 80) / 100));
    });

    it("drops a retreated ship that was transferred away mid-match, without reverting the win", async function () {
      const {
        deployed,
        human,
        other,
        humanRoguelikeMatch,
        otherRoguelikeMatch,
        humanGame,
      } = await loadFixture(deployFixture);
      const { game, ships } = deployed;
      const { kept, fled, gameId } = await startTwoShipRun(
        deployed,
        human,
        humanRoguelikeMatch,
        { tier1: true },
      );
      await ships.write.purchaseWithFlow(
        [other.account.address, 1n, other.account.address, 1],
        { value: parseEther("9.99"), account: other.account },
      );

      await humanGame.write.moveShip([
        gameId,
        fled,
        0,
        0,
        ActionType.Retreat,
        0n,
      ]);
      // Released from the combat fleet by the retreat, so it's transferable.
      await ships.write.transferFrom(
        [human.account.address, other.account.address, fled],
        { account: human.account },
      );
      await aiSurrenders(game, otherRoguelikeMatch, gameId);

      const run = await deployed.roguelikeRun.read.getRun([
        human.account.address,
      ]);
      expect(run.rosterShipIds.map(String)).to.deep.equal([String(kept)]);
      expect(run.reservationFleetId).to.not.equal(0n);
      expect((await ships.read.getShip([kept])).shipData.inFleet).to.equal(true);
      expect((await ships.read.getShip([fled])).shipData.inFleet).to.equal(false);
    });

    it("falls back to on-board survivors only when a rejoiner no longer fits the cost cap", async function () {
      const {
        deployed,
        owner,
        human,
        humanRoguelikeMatch,
        otherRoguelikeMatch,
        humanGame,
      } = await loadFixture(deployFixture);
      const { game, ships } = deployed;

      // Cap set to exactly the two ships' combined cost, so any increase
      // to the rejoiner's cost pushes the re-reservation over it.
      const probe = await startTwoShipRun(deployed, human, humanRoguelikeMatch);
      const exactCap =
        BigInt((await ships.read.getShip([probe.kept])).shipData.cost) +
        BigInt((await ships.read.getShip([probe.fled])).shipData.cost);
      await humanRoguelikeMatch.write.retreatRun([probe.gameId]);

      // New run on a fresh campaign with the exact cap (ships are free
      // again after the forfeit above).
      const { roguelikeNodeMap, maps, aiEncounters } = deployed;
      const mapId = await setupBasicAIEncounter(maps, aiEncounters);
      await roguelikeNodeMap.write.createCampaign();
      const campaignId = await roguelikeNodeMap.read.campaignCount();
      const root = await createCombatNode(roguelikeNodeMap, campaignId, mapId);
      const next = await createCombatNode(roguelikeNodeMap, campaignId, mapId);
      await roguelikeNodeMap.write.setCampaignRoot([campaignId, root]);
      await roguelikeNodeMap.write.setCampaignInitialCostCap([
        campaignId,
        exactCap,
      ]);
      await roguelikeNodeMap.write.addChild([root, next]);
      await roguelikeNodeMap.write.setCampaignAutoHealPercent([campaignId, 80]);
      await humanRoguelikeMatch.write.startRun([
        campaignId,
        [probe.kept, probe.fled],
      ]);
      await humanRoguelikeMatch.write.enterCombatNode([
        root,
        [
          { row: 0, col: 0 },
          { row: 1, col: 0 },
        ],
      ]);
      const gameId = ROGUELIKE_GAME_ID_OFFSET + 2n;

      await humanGame.write.moveShip([
        gameId,
        probe.fled,
        0,
        0,
        ActionType.Retreat,
        0n,
      ]);
      // Unlocked by the retreat — upgrade its equipment so its cost rises.
      await ships.write.setIsAllowedToCreateShips([owner.account.address, true]);
      const fledShip = await ships.read.getShip([probe.fled]);
      const costBefore = fledShip.shipData.cost;
      await ships.write.customizeShip([
        probe.fled,
        {
          ...fledShip,
          equipment: {
            ...fledShip.equipment,
            armor: fledShip.equipment.armor === 3 ? 2 : 3,
            shields: fledShip.equipment.shields === 3 ? 2 : 3,
          },
        },
      ]);
      expect(
        Number((await ships.read.getShip([probe.fled])).shipData.cost),
      ).to.be.greaterThan(Number(costBefore));

      await aiSurrenders(game, otherRoguelikeMatch, gameId);

      const run = await deployed.roguelikeRun.read.getRun([
        human.account.address,
      ]);
      expect(run.rosterShipIds.map(String)).to.deep.equal([String(probe.kept)]);
      expect(
        (await ships.read.getShip([probe.kept])).shipData.inFleet,
      ).to.equal(true);
    });
  });

  describe("Pluggable win effects", function () {
    it("reverts setNodeWinEffects from a non-editor and for a non-existent node", async function () {
      const { deployed, other } = await loadFixture(deployFixture);
      const { roguelikeNodeMap } = deployed;
      const { rootNodeId } = await setupCampaignWithRoot(
        roguelikeNodeMap,
        deployed.maps,
        deployed.aiEncounters,
      );

      const otherRoguelikeNodeMap = await hre.viem.getContractAt(
        "RoguelikeNodeMap",
        roguelikeNodeMap.address,
        { client: { wallet: other } },
      );
      await expect(
        otherRoguelikeNodeMap.write.setNodeWinEffects([
          rootNodeId,
          [deployed.decBonusWinEffect.address],
        ]),
      ).to.be.rejectedWith("NotNodeEditor");

      await expect(
        roguelikeNodeMap.write.setNodeWinEffects([
          999n,
          [deployed.decBonusWinEffect.address],
        ]),
      ).to.be.rejectedWith("NodeNotFound");
    });

    it("mints the configured DEC bonus to the player on a combat-node win", async function () {
      const {
        deployed,
        owner,
        human,
        humanRoguelikeMatch,
        otherRoguelikeMatch,
        humanGame,
      } = await loadFixture(deployFixture);
      const { ships, maps, aiEncounters, roguelikeNodeMap, randomManager, game, droneEnergyCores } =
        deployed;
      const { campaignId, rootNodeId } = await setupCampaignWithRoot(
        roguelikeNodeMap,
        maps,
        aiEncounters,
      );
      await roguelikeNodeMap.write.setNodeWinEffects([
        rootNodeId,
        [deployed.decBonusWinEffect.address],
      ]);

      await purchaseAndConstructHumanShips(ships, randomManager, human);
      const decBefore = await droneEnergyCores.read.balanceOf([
        human.account.address,
      ]);

      await humanRoguelikeMatch.write.startRun([campaignId, [1n]]);
      await humanRoguelikeMatch.write.enterCombatNode([
        rootNodeId,
        [{ row: 0, col: 0 }],
      ]);
      const gameId = ROGUELIKE_GAME_ID_OFFSET + 1n;
      await winCombatNode(
        game,
        humanGame,
        otherRoguelikeMatch,
        owner,
        human,
        gameId,
        1n,
      );

      const decAfter = await droneEnergyCores.read.balanceOf([
        human.account.address,
      ]);
      const bonusAmount = await deployed.decBonusWinEffect.read.bonusAmount();
      expect(decAfter - decBefore).to.equal(bonusAmount);
    });

    it("grants a free ship to the player on a combat-node win", async function () {
      const {
        deployed,
        owner,
        human,
        humanRoguelikeMatch,
        otherRoguelikeMatch,
        humanGame,
      } = await loadFixture(deployFixture);
      const { ships, maps, aiEncounters, roguelikeNodeMap, randomManager, game } =
        deployed;
      const { campaignId, rootNodeId } = await setupCampaignWithRoot(
        roguelikeNodeMap,
        maps,
        aiEncounters,
      );
      await roguelikeNodeMap.write.setNodeWinEffects([
        rootNodeId,
        [deployed.shipGrantWinEffect.address],
      ]);

      await purchaseAndConstructHumanShips(ships, randomManager, human);
      const shipCountBefore = await ships.read.shipCount();

      await humanRoguelikeMatch.write.startRun([campaignId, [1n]]);
      await humanRoguelikeMatch.write.enterCombatNode([
        rootNodeId,
        [{ row: 0, col: 0 }],
      ]);
      const gameId = ROGUELIKE_GAME_ID_OFFSET + 1n;
      await winCombatNode(
        game,
        humanGame,
        otherRoguelikeMatch,
        owner,
        human,
        gameId,
        1n,
      );

      const shipCountAfter = await ships.read.shipCount();
      expect(shipCountAfter - shipCountBefore).to.equal(1n);
      const grantedShip = await ships.read.getShip([shipCountAfter]);
      expect(grantedShip.owner.toLowerCase()).to.equal(
        human.account.address.toLowerCase(),
      );
      expect(grantedShip.shipData.isFreeShip).to.equal(true);
    });

    it("heals a survivor above the campaign's ordinary auto-heal floor when configured on the node", async function () {
      const {
        deployed,
        owner,
        human,
        humanRoguelikeMatch,
        otherRoguelikeMatch,
        humanGame,
      } = await loadFixture(deployFixture);
      const { ships, maps, aiEncounters, roguelikeNodeMap, randomManager, game } =
        deployed;
      const { campaignId, rootNodeId } = await setupCampaignWithRoot(
        roguelikeNodeMap,
        maps,
        aiEncounters,
      );
      // Low base floor (10%) so the bonus resolver's 100% heal-to is
      // clearly distinguishable from what the ordinary floor alone would
      // have produced.
      await roguelikeNodeMap.write.setCampaignAutoHealPercent([campaignId, 10]);
      await roguelikeNodeMap.write.setNodeWinEffects([
        rootNodeId,
        [deployed.healAboveFloorWinEffect.address],
      ]);
      expect(
        await deployed.healAboveFloorWinEffect.read.healToPercent(),
      ).to.equal(100);

      await purchaseAndConstructHumanShips(ships, randomManager, human);
      await humanRoguelikeMatch.write.startRun([campaignId, [1n]]);
      await humanRoguelikeMatch.write.enterCombatNode([
        rootNodeId,
        [{ row: 0, col: 0 }],
      ]);
      const gameId = ROGUELIKE_GAME_ID_OFFSET + 1n;
      await winCombatNode(
        game,
        humanGame,
        otherRoguelikeMatch,
        owner,
        human,
        gameId,
        1n,
      );

      const attrsAfterCombat = await game.read.getShipAttributes([gameId, 1n]);
      expect(attrsAfterCombat.hullPoints).to.be.lessThan(
        attrsAfterCombat.maxHullPoints,
      );

      const persistedHP = await deployed.roguelikeRun.read.getShipHP([
        human.account.address,
        1n,
      ]);
      expect(persistedHP).to.equal(attrsAfterCombat.maxHullPoints);
    });

    it("still completes the win when a configured win effect reverts, emitting WinEffectFailed instead of bricking the game-end tx", async function () {
      const {
        deployed,
        owner,
        human,
        humanRoguelikeMatch,
        otherRoguelikeMatch,
        humanGame,
        publicClient,
      } = await loadFixture(deployFixture);
      const { ships, maps, aiEncounters, roguelikeNodeMap, randomManager, game } =
        deployed;
      const { campaignId, rootNodeId } = await setupCampaignWithRoot(
        roguelikeNodeMap,
        maps,
        aiEncounters,
      );

      const brokenEffect = await hre.viem.deployContract(
        "MockAlwaysRevertsWinEffect",
        [],
      );
      // Sandwiched between two working effects so the test also proves the
      // loop doesn't stop early — both the DEC bonus (before) and the ship
      // grant (after) must still fire despite the broken one in between.
      await roguelikeNodeMap.write.setNodeWinEffects([
        rootNodeId,
        [
          deployed.decBonusWinEffect.address,
          brokenEffect.address,
          deployed.shipGrantWinEffect.address,
        ],
      ]);

      await purchaseAndConstructHumanShips(ships, randomManager, human);
      const decBefore = await deployed.droneEnergyCores.read.balanceOf([
        human.account.address,
      ]);
      const shipCountBefore = await ships.read.shipCount();

      await humanRoguelikeMatch.write.startRun([campaignId, [1n]]);
      await humanRoguelikeMatch.write.enterCombatNode([
        rootNodeId,
        [{ row: 0, col: 0 }],
      ]);
      const gameId = ROGUELIKE_GAME_ID_OFFSET + 1n;

      // The critical assertion: winCombatNode's final takeAITurn call
      // triggers onGameEnded -> the win-effect dispatch loop. Before the
      // fix this would have reverted the whole game-ending transaction.
      const blockBeforeWin = await publicClient.getBlockNumber();
      await winCombatNode(
        game,
        humanGame,
        otherRoguelikeMatch,
        owner,
        human,
        gameId,
        1n,
      );

      const run = await deployed.roguelikeRun.read.getRun([
        human.account.address,
      ]);
      expect(run.status).to.equal(2); // Won — game-end wasn't bricked

      const decAfter = await deployed.droneEnergyCores.read.balanceOf([
        human.account.address,
      ]);
      const bonusAmount = await deployed.decBonusWinEffect.read.bonusAmount();
      expect(decAfter - decBefore).to.equal(bonusAmount); // effect before the broken one still ran

      const shipCountAfter = await ships.read.shipCount();
      expect(shipCountAfter - shipCountBefore).to.equal(1n); // effect after the broken one still ran

      const events = await deployed.roguelikeMatch.getEvents.WinEffectFailed(
        undefined,
        { fromBlock: blockBeforeWin, toBlock: "latest" },
      );
      expect(events).to.have.length(1);
      expect(events[0].args.resolver?.toLowerCase()).to.equal(
        brokenEffect.address.toLowerCase(),
      );
      expect(events[0].args.player?.toLowerCase()).to.equal(
        human.account.address.toLowerCase(),
      );
    });
  });

  describe("Run-ending retreat", function () {
    it("ends the run and releases the roster on a between-node retreat", async function () {
      const { deployed, human, humanRoguelikeMatch } = await loadFixture(
        deployFixture,
      );
      const { ships, maps, aiEncounters, roguelikeNodeMap, randomManager } =
        deployed;
      const { campaignId } = await setupCampaignWithRoot(
        roguelikeNodeMap,
        maps,
        aiEncounters,
      );
      await purchaseAndConstructHumanShips(ships, randomManager, human);
      await humanRoguelikeMatch.write.startRun([campaignId, [1n]]);

      await humanRoguelikeMatch.write.retreatRun([0n]);

      const run = await deployed.roguelikeRun.read.getRun([
        human.account.address,
      ]);
      expect(run.status).to.equal(3); // Ended

      const shipAfter = await ships.read.getShip([1n]);
      expect(shipAfter.shipData.inFleet).to.equal(false);
    });

    it("ends the run mid-combat via forceEndSession, exercising the same non-win path an AI win would", async function () {
      const { deployed, human, humanRoguelikeMatch } = await loadFixture(
        deployFixture,
      );
      const { ships, maps, aiEncounters, roguelikeNodeMap, randomManager, game } =
        deployed;
      const { campaignId, rootNodeId } = await setupCampaignWithRoot(
        roguelikeNodeMap,
        maps,
        aiEncounters,
      );
      await purchaseAndConstructHumanShips(ships, randomManager, human);
      await humanRoguelikeMatch.write.startRun([campaignId, [1n]]);
      await humanRoguelikeMatch.write.enterCombatNode([
        rootNodeId,
        [{ row: 0, col: 0 }],
      ]);
      const gameId = ROGUELIKE_GAME_ID_OFFSET + 1n;

      await humanRoguelikeMatch.write.retreatRun([gameId]);

      const gameData = (await game.read.getGame([gameId])) as GameDataView;
      expect(gameData.metadata.ended).to.equal(true);
      expect(gameData.metadata.winner.toLowerCase()).to.not.equal(
        human.account.address.toLowerCase(),
      );

      const run = await deployed.roguelikeRun.read.getRun([
        human.account.address,
      ]);
      expect(run.status).to.equal(3); // Ended

      const shipAfter = await ships.read.getShip([1n]);
      expect(shipAfter.shipData.inFleet).to.equal(false);
    });

    it("reverts retreatRun for a game the caller doesn't own", async function () {
      const { deployed, human, other, humanRoguelikeMatch, otherRoguelikeMatch } =
        await loadFixture(deployFixture);
      const { ships, maps, aiEncounters, roguelikeNodeMap, randomManager } =
        deployed;
      const { campaignId, rootNodeId } = await setupCampaignWithRoot(
        roguelikeNodeMap,
        maps,
        aiEncounters,
      );
      await purchaseAndConstructHumanShips(ships, randomManager, human);
      await humanRoguelikeMatch.write.startRun([campaignId, [1n]]);
      await humanRoguelikeMatch.write.enterCombatNode([
        rootNodeId,
        [{ row: 0, col: 0 }],
      ]);
      const gameId = ROGUELIKE_GAME_ID_OFFSET + 1n;

      await expect(
        otherRoguelikeMatch.write.retreatRun([gameId]),
      ).to.be.rejectedWith("NoActiveRun");
    });

    // SP-04 (docs/pre-audit.md): retreatRun(0) used to end a run with no
    // regard for whether a combat match it started was still unresolved,
    // letting that game's later onGameEnded callback silently apply its
    // outcome to whatever run/generation was current for the player by
    // then (e.g. crediting a brand-new run as Won from an old, abandoned
    // game's win). activeGameId tracking + the checks below close that.
    it("reverts retreatRun(0) while a combat match is still active (SP-04)", async function () {
      const { deployed, human, humanRoguelikeMatch } = await loadFixture(
        deployFixture,
      );
      const { ships, maps, aiEncounters, roguelikeNodeMap, randomManager } =
        deployed;
      const { campaignId, rootNodeId } = await setupCampaignWithRoot(
        roguelikeNodeMap,
        maps,
        aiEncounters,
      );
      await purchaseAndConstructHumanShips(ships, randomManager, human);
      await humanRoguelikeMatch.write.startRun([campaignId, [1n]]);
      await humanRoguelikeMatch.write.enterCombatNode([
        rootNodeId,
        [{ row: 0, col: 0 }],
      ]);

      await expect(
        humanRoguelikeMatch.write.retreatRun([0n]),
      ).to.be.rejectedWith("ActiveGameInProgress");
    });

    it("clears activeGameId once the active game resolves as a win (SP-04)", async function () {
      const { deployed, human, owner, humanRoguelikeMatch, otherRoguelikeMatch, humanGame } =
        await loadFixture(deployFixture);
      const { ships, maps, aiEncounters, roguelikeNodeMap, randomManager, game } =
        deployed;
      const { campaignId, rootNodeId } = await setupCampaignWithRoot(
        roguelikeNodeMap,
        maps,
        aiEncounters,
      );
      await purchaseAndConstructHumanShips(ships, randomManager, human);
      await humanRoguelikeMatch.write.startRun([campaignId, [1n]]);
      await humanRoguelikeMatch.write.enterCombatNode([
        rootNodeId,
        [{ row: 0, col: 0 }],
      ]);
      const gameId = ROGUELIKE_GAME_ID_OFFSET + 1n;

      const runDuringCombat = await deployed.roguelikeRun.read.getRun([
        human.account.address,
      ]);
      expect(runDuringCombat.activeGameId).to.equal(gameId);

      await winCombatNode(
        game,
        humanGame,
        otherRoguelikeMatch,
        owner,
        human,
        gameId,
        1n,
      );

      const runAfter = await deployed.roguelikeRun.read.getRun([
        human.account.address,
      ]);
      expect(runAfter.activeGameId).to.equal(0n);
    });

    it("clears activeGameId once the active game resolves via retreatRun(gameId) forfeit (SP-04)", async function () {
      const { deployed, human, humanRoguelikeMatch } = await loadFixture(
        deployFixture,
      );
      const { ships, maps, aiEncounters, roguelikeNodeMap, randomManager } =
        deployed;
      const { campaignId, rootNodeId } = await setupCampaignWithRoot(
        roguelikeNodeMap,
        maps,
        aiEncounters,
      );
      await purchaseAndConstructHumanShips(ships, randomManager, human);
      await humanRoguelikeMatch.write.startRun([campaignId, [1n]]);
      await humanRoguelikeMatch.write.enterCombatNode([
        rootNodeId,
        [{ row: 0, col: 0 }],
      ]);
      const gameId = ROGUELIKE_GAME_ID_OFFSET + 1n;

      await humanRoguelikeMatch.write.retreatRun([gameId]);

      // retreatRun(gameId) ends the run outright (loss), so activeGameId
      // being cleared is checked via the raw ledger read (getRun) rather
      // than trying to act on the run again.
      const runAfter = await deployed.roguelikeRun.read.getRun([
        human.account.address,
      ]);
      expect(runAfter.activeGameId).to.equal(0n);
    });
  });

  describe("Detached currentNodeId via enterResupplyNode during combat (HA2-04)", function () {
    // Before the fix, enterResupplyNode never checked run.activeGameId, so a
    // player could enter a resupply node while a combat match at the
    // current node was still unresolved -- detaching run.currentNodeId
    // from the node actually being fought. The eventual onGameEnded
    // callback only checks *which game*, not *which node*, so it would
    // credit the wrong (resupply) node as defeated and evaluate
    // win-effects/isFinalNode against it instead of the real fight.
    it("reverts enterResupplyNode while a combat match is still active at the current node", async function () {
      const { deployed, human, humanRoguelikeMatch } = await loadFixture(
        deployFixture,
      );
      const { maps, aiEncounters, roguelikeNodeMap, ships, randomManager } =
        deployed;
      const { campaignId, rootNodeId } = await setupCampaignWithRoot(
        roguelikeNodeMap,
        maps,
        aiEncounters,
      );
      const resupplyNode = await createResupplyNode(roguelikeNodeMap, campaignId);
      await roguelikeNodeMap.write.addChild([rootNodeId, resupplyNode]);

      await purchaseAndConstructHumanShips(ships, randomManager, human);
      await humanRoguelikeMatch.write.startRun([campaignId, [1n]]);
      await humanRoguelikeMatch.write.enterCombatNode([
        rootNodeId,
        [{ row: 0, col: 0 }],
      ]);

      // Without resolving the just-started combat game, try to advance to
      // the resupply node.
      await expect(
        humanRoguelikeMatch.write.enterResupplyNode([resupplyNode]),
      ).to.be.rejectedWith("ActiveGameInProgress");

      // run.currentNodeId must still be the combat node, not the resupply
      // node -- confirms the state was never detached.
      const run = await deployed.roguelikeRun.read.getRun([
        human.account.address,
      ]);
      expect(run.currentNodeId).to.equal(rootNodeId);
    });
  });

  describe("Leaving a mission before winning it", function () {
    // _commitToNode used to check only the target node, never the node being
    // left, so a player could skip an unbeaten combat mission (including the
    // root, right after startRun) or move while a match was still live —
    // which let onGameEnded credit the win to a node never fought.
    async function setupBranchingCampaign(fx: any) {
      const { roguelikeNodeMap, maps, aiEncounters, ships, randomManager } =
        fx.deployed;
      const { campaignId, rootNodeId, mapId } = await setupCampaignWithRoot(
        roguelikeNodeMap,
        maps,
        aiEncounters,
      );
      // root -> combatChild (has its own child so it isn't final)
      // root -> hub (resupply) -> hubChild (combat, also non-final)
      const combatChild = await createCombatNode(roguelikeNodeMap, campaignId, mapId);
      const grandchild = await createCombatNode(roguelikeNodeMap, campaignId, mapId);
      const hub = await createResupplyNode(roguelikeNodeMap, campaignId);
      const hubChild = await createCombatNode(roguelikeNodeMap, campaignId, mapId);
      const hubGrandchild = await createCombatNode(roguelikeNodeMap, campaignId, mapId);
      await roguelikeNodeMap.write.addChild([rootNodeId, combatChild]);
      await roguelikeNodeMap.write.addChild([combatChild, grandchild]);
      await roguelikeNodeMap.write.addChild([rootNodeId, hub]);
      await roguelikeNodeMap.write.addChild([hub, hubChild]);
      await roguelikeNodeMap.write.addChild([hubChild, hubGrandchild]);

      await purchaseAndConstructHumanShips(ships, randomManager, fx.human);
      await fx.humanRoguelikeMatch.write.startRun([campaignId, [1n]]);
      return { rootNodeId, combatChild, hub, hubChild };
    }

    it("reverts entering a child of the root right after startRun", async function () {
      const fx = await loadFixture(deployFixture);
      const { combatChild, hub } = await setupBranchingCampaign(fx);

      await expect(
        fx.humanRoguelikeMatch.write.enterCombatNode([
          combatChild,
          [{ row: 0, col: 0 }],
        ]),
      ).to.be.rejectedWith("CurrentNodeNotCleared");
      await expect(
        fx.humanRoguelikeMatch.write.enterResupplyNode([hub]),
      ).to.be.rejectedWith("CurrentNodeNotCleared");
    });

    it("reverts entering a child, a resupply node, or the current node again while a match is live", async function () {
      const fx = await loadFixture(deployFixture);
      const { rootNodeId, combatChild, hub } = await setupBranchingCampaign(fx);
      await fx.humanRoguelikeMatch.write.enterCombatNode([
        rootNodeId,
        [{ row: 0, col: 0 }],
      ]);
      const { activeGameId } = await fx.deployed.roguelikeRun.read.getRun([
        fx.human.account.address,
      ]);

      await expect(
        fx.humanRoguelikeMatch.write.enterCombatNode([
          combatChild,
          [{ row: 0, col: 0 }],
        ]),
      ).to.be.rejectedWith("ActiveGameInProgress");
      await expect(
        fx.humanRoguelikeMatch.write.enterResupplyNode([hub]),
      ).to.be.rejectedWith("ActiveGameInProgress");
      await expect(
        fx.humanRoguelikeMatch.write.enterCombatNode([
          rootNodeId,
          [{ row: 0, col: 0 }],
        ]),
      ).to.be.rejectedWith("ActiveGameInProgress");

      const run = await fx.deployed.roguelikeRun.read.getRun([
        fx.human.account.address,
      ]);
      expect(run.currentNodeId).to.equal(rootNodeId);
      expect(run.activeGameId).to.equal(activeGameId);
    });

    it("lets the run move on once the root is won, crediting the root, not the child", async function () {
      const fx = await loadFixture(deployFixture);
      const { rootNodeId, combatChild } = await setupBranchingCampaign(fx);
      await clearRoot(fx, rootNodeId);

      await fx.humanRoguelikeMatch.write.enterCombatNode([
        combatChild,
        [{ row: 0, col: 0 }],
      ]);

      const player = fx.human.account.address;
      const run = await fx.deployed.roguelikeRun.read.getRun([player]);
      expect(run.currentNodeId).to.equal(combatChild);
      expect(
        await fx.deployed.roguelikeRun.read.isNodeDefeated([player, rootNodeId]),
      ).to.equal(true);
      expect(
        await fx.deployed.roguelikeRun.read.isNodeDefeated([player, combatChild]),
      ).to.equal(false);
    });

    it("always lets the run leave a resupply node", async function () {
      const fx = await loadFixture(deployFixture);
      const { rootNodeId, hub, hubChild } = await setupBranchingCampaign(fx);
      await clearRoot(fx, rootNodeId);

      await fx.humanRoguelikeMatch.write.enterResupplyNode([hub]);
      // Re-entering the hub while standing on it is still allowed.
      await fx.humanRoguelikeMatch.write.enterResupplyNode([hub]);
      // A resupply node has no fight, so its children open straight away.
      await fx.humanRoguelikeMatch.write.enterCombatNode([
        hubChild,
        [{ row: 0, col: 0 }],
      ]);
      const run = await fx.deployed.roguelikeRun.read.getRun([
        fx.human.account.address,
      ]);
      expect(run.currentNodeId).to.equal(hubChild);
    });
  });

  describe("Resupply: repair", function () {
    it("full-heals listed ships and charges UTC proportional to missing HP", async function () {
      const { deployed, owner, human, humanRoguelikeMatch, humanRoguelikeResupply, otherRoguelikeMatch, humanGame, humanUniversalCredits } =
        await loadFixture(deployFixture);
      const { ships, maps, aiEncounters, roguelikeNodeMap, randomManager, game, universalCredits } =
        deployed;
      const { campaignId, rootNodeId, mapId } = await setupCampaignWithRoot(
        roguelikeNodeMap,
        maps,
        aiEncounters,
      );
      const resupplyNode = await createResupplyNode(roguelikeNodeMap, campaignId);
      await roguelikeNodeMap.write.addChild([rootNodeId, resupplyNode]);
      await deployed.roguelikeResupply.write.setRepairCostPerHP([10n]);

      await purchaseAndConstructHumanShips(ships, randomManager, human);
      await humanRoguelikeMatch.write.startRun([campaignId, [1n]]);
      await humanRoguelikeMatch.write.enterCombatNode([
        rootNodeId,
        [{ row: 0, col: 0 }],
      ]);
      const gameId = ROGUELIKE_GAME_ID_OFFSET + 1n;

      await winCombatNode(
        game,
        humanGame,
        otherRoguelikeMatch,
        owner,
        human,
        gameId,
        1n,
      );

      const attrsAfterCombat = await game.read.getShipAttributes([gameId, 1n]);
      const missing = Number(attrsAfterCombat.maxHullPoints) -
        Number(attrsAfterCombat.hullPoints);
      // No auto-heal configured for this campaign (defaults to 0%), so the
      // persisted HP equals whatever combat left it at.
      expect(missing).to.be.greaterThan(0);

      await humanRoguelikeMatch.write.enterResupplyNode([resupplyNode]);

      const expectedCost = BigInt(missing) * 10n;
      await universalCredits.write.setAuthorizedToMint(
        [owner.account.address, true],
        { account: owner.account },
      );
      await universalCredits.write.mint([human.account.address, expectedCost], {
        account: owner.account,
      });
      await humanUniversalCredits.write.approve([
        deployed.roguelikeResupply.address,
        expectedCost,
      ]);

      const balanceBefore = await universalCredits.read.balanceOf([
        human.account.address,
      ]);

      await humanRoguelikeResupply.write.resupplyRepair([[1n]]);

      const balanceAfter = await universalCredits.read.balanceOf([
        human.account.address,
      ]);
      expect(balanceBefore - balanceAfter).to.equal(expectedCost);

      const persistedHP = await deployed.roguelikeRun.read.getShipHP([
        human.account.address,
        1n,
      ]);
      expect(persistedHP).to.equal(Number(attrsAfterCombat.maxHullPoints));
    });

    it("reverts resupplyRepair when not at a resupply node", async function () {
      const { deployed, human, humanRoguelikeResupply, humanRoguelikeMatch } =
        await loadFixture(deployFixture);
      const { ships, maps, aiEncounters, roguelikeNodeMap, randomManager } =
        deployed;
      const { campaignId } = await setupCampaignWithRoot(
        roguelikeNodeMap,
        maps,
        aiEncounters,
      );
      await purchaseAndConstructHumanShips(ships, randomManager, human);
      await humanRoguelikeMatch.write.startRun([campaignId, [1n]]);

      await expect(
        humanRoguelikeResupply.write.resupplyRepair([[1n]]),
      ).to.be.rejectedWith("NotResupplyNode");
    });
  });

  describe("Engine-live setter locks (HA6-13)", function () {
    it("locks RoguelikeMatch and RoguelikeResupply's live-state setters once any run has started", async function () {
      const fx = await loadFixture(deployFixture);
      const { deployed, owner, human, humanRoguelikeMatch } = fx;
      const { ships, maps, aiEncounters, roguelikeNodeMap, randomManager, roguelikeMatch, roguelikeResupply, roguelikeRun } =
        deployed;

      // Before any run: still configurable.
      expect(await roguelikeRun.read.runsStarted()).to.equal(0n);
      await roguelikeMatch.write.setFleetsAddress([await roguelikeMatch.read.fleets()]);
      await roguelikeResupply.write.setFleetsAddress([await roguelikeResupply.read.fleets()]);

      const { campaignId } = await setupCampaignWithRoot(
        roguelikeNodeMap,
        maps,
        aiEncounters,
      );
      await purchaseAndConstructHumanShips(ships, randomManager, human);
      await humanRoguelikeMatch.write.startRun([campaignId, [1n]]);
      expect(await roguelikeRun.read.runsStarted()).to.equal(1n);

      const someAddress = owner.account.address;
      for (const fn of [
        "setAIShipsAddress",
        "setHumanShipsAddress",
        "setGameAddress",
        "setFleetsAddress",
        "setMapsAddress",
        "setNodeMapAddress",
        "setRunLedgerAddress",
      ]) {
        await expect(
          (roguelikeMatch.write as any)[fn]([someAddress]),
        ).to.be.rejectedWith("EngineAlreadyLive");
      }
      for (const fn of [
        "setHumanShipsAddress",
        "setFleetsAddress",
        "setNodeMapAddress",
        "setRunLedgerAddress",
      ]) {
        await expect(
          (roguelikeResupply.write as any)[fn]([someAddress]),
        ).to.be.rejectedWith("EngineAlreadyLive");
      }
    });
  });

  describe("AI that can't decide (HA6-12)", function () {
    it("passes and emits AIDecisionFailed instead of freezing the match", async function () {
      const fx = await loadFixture(deployFixture);
      const { deployed, human, humanGame, humanRoguelikeMatch, otherRoguelikeMatch } = fx;
      const { ships, maps, aiEncounters, roguelikeNodeMap, randomManager, aiBehaviorRegistry } =
        deployed;
      const { campaignId, rootNodeId } = await setupCampaignWithRoot(
        roguelikeNodeMap,
        maps,
        aiEncounters,
      );
      await purchaseAndConstructHumanShips(ships, randomManager, human);
      // A "broken" AI (a contract with no decide()), registered before the
      // fight since AI ships pin their AI at mint (HA6-18).
      await aiBehaviorRegistry.write.setVariantAI([1, aiEncounters.address]);
      await humanRoguelikeMatch.write.startRun([campaignId, [1n]]);
      await humanRoguelikeMatch.write.enterCombatNode([
        rootNodeId,
        [{ row: 0, col: 0 }],
      ]);
      const { activeGameId } = await deployed.roguelikeRun.read.getRun([
        human.account.address,
      ]);
      await humanGame.write.moveShip(
        [activeGameId, 1n, 0, 0, ActionType.Pass, 0n],
        { account: human.account },
      );

      await otherRoguelikeMatch.write.takeAITurn([activeGameId]);
      const failed = await deployed.roguelikeMatch.getEvents.AIDecisionFailed();
      expect(failed.length).to.be.greaterThan(0);
      expect(
        (await deployed.game.read.getGame([activeGameId])).metadata.ended,
      ).to.equal(false);
    });
  });

  describe("Cost changes during a run (HA6-09)", function () {
    // Re-publishes variant 1's cost table (bumping its version), optionally
    // raising baseCost so every ship's current price goes up.
    async function bumpCosts(shipAttributes: any, extraBaseCost = 0) {
      const [, costs] = await shipAttributes.read.getCosts([1]);
      await shipAttributes.write.setCosts([
        1,
        { ...costs, baseCost: Number(costs.baseCost) + extraBaseCost },
      ]);
    }

    it("a price increase mid-combat doesn't break the winning move or the next fight", async function () {
      const fx = await loadFixture(deployFixture);
      const { deployed, owner, human, humanGame, humanRoguelikeMatch, otherRoguelikeMatch } = fx;
      const { ships, maps, aiEncounters, roguelikeNodeMap, randomManager, shipAttributes } =
        deployed;
      await purchaseAndConstructHumanShips(ships, randomManager, human);
      // Cap the run at ship 1's exact current price, so any increase
      // would push the roster over the cap if it were re-priced.
      const startPrice = (await ships.read.getShip([1n])).shipData.cost;
      const { campaignId, rootNodeId, mapId } = await setupCampaignWithRoot(
        roguelikeNodeMap,
        maps,
        aiEncounters,
        BigInt(startPrice),
      );
      const nextNode = await createCombatNode(roguelikeNodeMap, campaignId, mapId);
      await roguelikeNodeMap.write.addChild([rootNodeId, nextNode]);

      await humanRoguelikeMatch.write.startRun([campaignId, [1n]]);
      await humanRoguelikeMatch.write.enterCombatNode([
        rootNodeId,
        [{ row: 0, col: 0 }],
      ]);
      const { activeGameId } = await deployed.roguelikeRun.read.getRun([
        human.account.address,
      ]);

      await bumpCosts(shipAttributes, 50);

      await winCombatNode(
        deployed.game,
        humanGame,
        otherRoguelikeMatch,
        owner,
        human,
        activeGameId,
        1n,
      );
      let run = await deployed.roguelikeRun.read.getRun([human.account.address]);
      expect(run.status).to.equal(1); // still Active
      expect(run.activeGameId).to.equal(0n);
      expect(run.reservationFleetId).to.not.equal(0n);
      expect((await ships.read.getShip([1n])).shipData.inFleet).to.equal(true);

      // Another price change between nodes; the next fight still starts.
      await bumpCosts(shipAttributes, 10);
      await humanRoguelikeMatch.write.enterCombatNode([
        nextNode,
        [{ row: 0, col: 0 }],
      ]);
      run = await deployed.roguelikeRun.read.getRun([human.account.address]);
      expect(run.activeGameId).to.not.equal(0n);
    });

    it("startRun still requires current prices", async function () {
      const fx = await loadFixture(deployFixture);
      const { deployed, human, humanRoguelikeMatch } = fx;
      const { ships, maps, aiEncounters, roguelikeNodeMap, randomManager, shipAttributes } =
        deployed;
      const { campaignId } = await setupCampaignWithRoot(
        roguelikeNodeMap,
        maps,
        aiEncounters,
      );
      await purchaseAndConstructHumanShips(ships, randomManager, human);
      await bumpCosts(shipAttributes);

      await expect(
        humanRoguelikeMatch.write.startRun([campaignId, [1n]]),
      ).to.be.rejectedWith("ShipCostVersionMismatch");

      await ships.write.syncShipCosts([[1n]]);
      await humanRoguelikeMatch.write.startRun([campaignId, [1n]]);
    });

    it("resupply keeps the roster's frozen prices but requires current prices for added ships", async function () {
      const fx = await loadFixture(deployFixture);
      const { deployed, human, humanRoguelikeMatch, humanRoguelikeResupply } = fx;
      const { ships, maps, aiEncounters, roguelikeNodeMap, randomManager, shipAttributes } =
        deployed;
      const { campaignId, rootNodeId } = await setupCampaignWithRoot(
        roguelikeNodeMap,
        maps,
        aiEncounters,
      );
      const resupplyNode = await createResupplyNode(roguelikeNodeMap, campaignId);
      await roguelikeNodeMap.write.addChild([rootNodeId, resupplyNode]);

      await purchaseAndConstructHumanShips(ships, randomManager, human);
      await humanRoguelikeMatch.write.startRun([campaignId, [1n]]);
      await clearRoot(fx, rootNodeId);
      await humanRoguelikeMatch.write.enterResupplyNode([resupplyNode]);

      await bumpCosts(shipAttributes);

      // Ship 2 was never re-priced after the change.
      await expect(
        humanRoguelikeResupply.write.resupplyModifyRoster([[2n], []]),
      ).to.be.rejectedWith("ShipCostVersionMismatch");

      // Once re-priced it can join; ship 1 (still on the old price) stays.
      await ships.write.syncShipCosts([[2n]]);
      await humanRoguelikeResupply.write.resupplyModifyRoster([[2n], []]);
      const run = await deployed.roguelikeRun.read.getRun([
        human.account.address,
      ]);
      expect(run.rosterShipIds.map(String)).to.deep.equal(["1", "2"]);
    });
  });

  describe("Resupply: roster composition", function () {
    it("adds and removes ships, re-reserving against the current cost cap", async function () {
      const fx = await loadFixture(deployFixture);
      const { deployed, human, humanRoguelikeMatch, humanRoguelikeResupply } = fx;
      const { ships, maps, aiEncounters, roguelikeNodeMap, randomManager } =
        deployed;
      const { campaignId, rootNodeId } = await setupCampaignWithRoot(
        roguelikeNodeMap,
        maps,
        aiEncounters,
      );
      const resupplyNode = await createResupplyNode(roguelikeNodeMap, campaignId);
      await roguelikeNodeMap.write.addChild([rootNodeId, resupplyNode]);

      await purchaseAndConstructHumanShips(ships, randomManager, human);
      await humanRoguelikeMatch.write.startRun([campaignId, [1n]]);
      await clearRoot(fx, rootNodeId);
      await humanRoguelikeMatch.write.enterResupplyNode([resupplyNode]);

      await humanRoguelikeResupply.write.resupplyModifyRoster([[2n], [1n]]);

      const run = await deployed.roguelikeRun.read.getRun([
        human.account.address,
      ]);
      expect(run.rosterShipIds.map(String)).to.deep.equal(["2"]);

      const removedShip = await ships.read.getShip([1n]);
      expect(removedShip.shipData.inFleet).to.equal(false);
      const addedShip = await ships.read.getShip([2n]);
      expect(addedShip.shipData.inFleet).to.equal(true);
    });

    it("reverts adding a ship the caller doesn't own", async function () {
      const fx = await loadFixture(deployFixture);
      const {
        deployed,
        human,
        other,
        humanRoguelikeMatch,
        humanRoguelikeResupply,
      } = fx;
      const { ships, maps, aiEncounters, roguelikeNodeMap, randomManager } =
        deployed;
      const { campaignId, rootNodeId } = await setupCampaignWithRoot(
        roguelikeNodeMap,
        maps,
        aiEncounters,
      );
      const resupplyNode = await createResupplyNode(roguelikeNodeMap, campaignId);
      await roguelikeNodeMap.write.addChild([rootNodeId, resupplyNode]);

      await purchaseAndConstructHumanShips(ships, randomManager, human);
      // ship 6 belongs to `other`, not `human`.
      await ships.write.purchaseWithFlow(
        [other.account.address, 0n, other.account.address, 1],
        { value: parseEther("4.99"), account: other.account },
      );

      await humanRoguelikeMatch.write.startRun([campaignId, [1n]]);
      await clearRoot(fx, rootNodeId);
      await humanRoguelikeMatch.write.enterResupplyNode([resupplyNode]);

      await expect(
        humanRoguelikeResupply.write.resupplyModifyRoster([[6n], []]),
      ).to.be.rejectedWith("ShipNotOwned");
    });

    it("reverts adding a wrong-variant ship when the campaign requires one", async function () {
      const fx = await loadFixture(deployFixture);
      const { deployed, owner, human, humanRoguelikeMatch, humanRoguelikeResupply } = fx;
      const { ships, maps, aiEncounters, roguelikeNodeMap, randomManager } =
        deployed;
      const { campaignId, rootNodeId } = await setupCampaignWithRoot(
        roguelikeNodeMap,
        maps,
        aiEncounters,
      );
      await roguelikeNodeMap.write.setCampaignRequiredVariant([campaignId, 1]);
      const resupplyNode = await createResupplyNode(roguelikeNodeMap, campaignId);
      await roguelikeNodeMap.write.addChild([rootNodeId, resupplyNode]);

      await purchaseAndConstructHumanShips(ships, randomManager, human);

      // Mint a plain variant-1 ship, then overwrite it to variant 2 — same
      // pattern test/Game.test.ts uses to get a variant-2 ship without
      // needing to actually hold ShatteredHiveMedal.
      await ships.write.setIsAllowedToCreateShips(
        [owner.account.address, true],
        { account: owner.account },
      );
      await ships.write.createShips(
        [human.account.address, 1, 1, 0, false],
        { account: owner.account },
      );
      const variant2ShipId = 6n;
      const shipTuple = (await ships.read.ships([variant2ShipId])) as ShipTuple;
      const ship = tupleToShip(shipTuple);
      await ships.write.customizeShip(
        [
          variant2ShipId,
          { ...ship, traits: { ...ship.traits, variant: 2 } },
        ],
        { account: owner.account },
      );

      await humanRoguelikeMatch.write.startRun([campaignId, [1n]]);
      await clearRoot(fx, rootNodeId);
      await humanRoguelikeMatch.write.enterResupplyNode([resupplyNode]);

      await expect(
        humanRoguelikeResupply.write.resupplyModifyRoster([
          [variant2ShipId],
          [],
        ]),
      ).to.be.rejectedWith("WrongCampaignVariant");
    });

    it("keeps a run's required-variant rule pinned to whatever was live at startRun, even if an admin retunes it mid-run (UA-16)", async function () {
      const fx = await loadFixture(deployFixture);
      const { deployed, owner, human, humanRoguelikeMatch, humanRoguelikeResupply } = fx;
      const { ships, maps, aiEncounters, roguelikeNodeMap, randomManager } =
        deployed;
      const { campaignId, rootNodeId } = await setupCampaignWithRoot(
        roguelikeNodeMap,
        maps,
        aiEncounters,
      );
      // Unrestricted (0) at the moment the run starts.
      const resupplyNode = await createResupplyNode(roguelikeNodeMap, campaignId);
      await roguelikeNodeMap.write.addChild([rootNodeId, resupplyNode]);

      await purchaseAndConstructHumanShips(ships, randomManager, human);

      // A variant-2 ship, same technique as the sibling test above.
      await ships.write.setIsAllowedToCreateShips(
        [owner.account.address, true],
        { account: owner.account },
      );
      await ships.write.createShips(
        [human.account.address, 1, 1, 0, false],
        { account: owner.account },
      );
      const variant2ShipId = 6n;
      const shipTuple = (await ships.read.ships([variant2ShipId])) as ShipTuple;
      const ship = tupleToShip(shipTuple);
      await ships.write.customizeShip(
        [variant2ShipId, { ...ship, traits: { ...ship.traits, variant: 2 } }],
        { account: owner.account },
      );

      await humanRoguelikeMatch.write.startRun([campaignId, [1n]]);
      await clearRoot(fx, rootNodeId);

      // Admin tightens the requirement AFTER the run has already started —
      // a live (unpinned) read would apply this new rule to this run's
      // resupply stops too.
      await roguelikeNodeMap.write.setCampaignRequiredVariant([campaignId, 1]);

      await humanRoguelikeMatch.write.enterResupplyNode([resupplyNode]);

      // Still succeeds — swapping the roster to the variant-2 ship entirely
      // (avoiding Fleets' own separate MixedVariantFleet check) — proving
      // the pinned (unrestricted) rule from startRun applied, not the
      // tightened live one.
      await expect(
        humanRoguelikeResupply.write.resupplyModifyRoster([
          [variant2ShipId],
          [1n],
        ]),
      ).to.not.be.rejected;
    });

    it("reverts resupplyModifyRoster when not at a resupply node", async function () {
      const { deployed, human, humanRoguelikeMatch, humanRoguelikeResupply } =
        await loadFixture(deployFixture);
      const { ships, maps, aiEncounters, roguelikeNodeMap, randomManager } =
        deployed;
      const { campaignId } = await setupCampaignWithRoot(
        roguelikeNodeMap,
        maps,
        aiEncounters,
      );
      await purchaseAndConstructHumanShips(ships, randomManager, human);
      await humanRoguelikeMatch.write.startRun([campaignId, [1n]]);

      await expect(
        humanRoguelikeResupply.write.resupplyModifyRoster([[2n], []]),
      ).to.be.rejectedWith("NotResupplyNode");
    });
  });

  describe("Resupply: cost cap override", function () {
    it("updates the run's cost cap going forward", async function () {
      const fx = await loadFixture(deployFixture);
      const { deployed, human, humanRoguelikeMatch } = fx;
      const { ships, maps, aiEncounters, roguelikeNodeMap, randomManager } =
        deployed;
      const { campaignId, rootNodeId } = await setupCampaignWithRoot(
        roguelikeNodeMap,
        maps,
        aiEncounters,
        500n,
      );
      const resupplyNode = await createResupplyNode(
        roguelikeNodeMap,
        campaignId,
        9000n,
      );
      await roguelikeNodeMap.write.addChild([rootNodeId, resupplyNode]);

      await purchaseAndConstructHumanShips(ships, randomManager, human);
      await humanRoguelikeMatch.write.startRun([campaignId, [1n]]);
      await clearRoot(fx, rootNodeId);

      let run = await deployed.roguelikeRun.read.getRun([
        human.account.address,
      ]);
      expect(run.currentCostCap).to.equal(500n);

      await humanRoguelikeMatch.write.enterResupplyNode([resupplyNode]);

      run = await deployed.roguelikeRun.read.getRun([human.account.address]);
      expect(run.currentCostCap).to.equal(9000n);
    });
  });
});

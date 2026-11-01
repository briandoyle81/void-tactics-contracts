import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers";
import hre from "hardhat";
import { parseEther } from "viem";
import { ActionType, MapMode, ShipTuple, tupleToShip } from "./types";
import DeployModule from "../ignition/modules/DeployAndConfig";
import roguelikeStarterContent from "../ignition/data/roguelikeStarterContent.json";
import { expectLiveBitmapsConsistent } from "./helpers/liveBitmaps";
import { expectAIViewsConsistent } from "./helpers/aiView";
import {
  primeShipForRealDestruction,
  setShipHullPoints,
  setShipHullPointsToZero,
  setShipPosition,
} from "./helpers/gameStorage";

// Gas budgets for the largest single transactions a player sends.
//
// Ethereum's Fusaka upgrade (EIP-7825) caps a transaction at 2^24 =
// 16,777,216 gas, and OP Stack chains such as Base follow L1 upgrades, so
// anything near that can't be sent at all. These tests fail well before the
// cap so a call growing toward it gets noticed early. Added 2026-10-23 after
// a live enterCombatNode with a 7-ship fleet needed ~6.0M gas and ran out
// at the frontend's fixed 5.5M limit.
const TX_GAS_CAP = 16_777_216n;
const GAS_BUDGET = 12_000_000n;

const AI_ARCHETYPE_GRUNT = 0;
const ROGUELIKE_COMBAT = 0;
const JOINER_COLS = [13, 14, 15, 16];
const CREATOR_COLS = [0, 1, 2, 3];
const GRID_HEIGHT = 11;
// Every seeded map has 4-5 scoring tiles, each copied into the game at
// start; this is the seeded 5-tile layout.
const SCORING_TILES = [
  [5, 8],
  [1, 4],
  [9, 12],
  [9, 4],
  [1, 12],
].map(([row, col]) => ({ row, col, points: 10, onlyOnce: false }));
// High enough that scoring never ends the measured rounds early.
const MAX_SCORE = 1000n;

// Largest cost cap any node in the seeded campaign gives a run.
const MAX_COST_CAP = BigInt(
  Math.max(
    roguelikeStarterContent.campaign.initialCostCap,
    ...roguelikeStarterContent.nodes.map((n: any) => n.costCapOverride ?? 0),
  ),
);

describe("Gas budgets for the largest player transactions", function () {
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
    const humanGame = await hre.viem.getContractAt(
      "Game",
      deployed.game.address,
      { client: { wallet: human } },
    );
    return {
      owner,
      human,
      publicClient,
      deployed,
      humanRoguelikeMatch,
      otherRoguelikeMatch,
      humanGame,
    };
  }

  const gasOf = async (publicClient: any, hash: `0x${string}`) =>
    (await publicClient.waitForTransactionReceipt({ hash })).gasUsed as bigint;

  // The worst case the seeded content allows: the most ships that fit in
  // the largest cost cap (cheapest first), against an AI fleet at the
  // deploy's maxPlacementsPerMap, on a 5-scoring-tile map. The node has a
  // child, so a win there re-reserves the roster (a final node doesn't).
  async function setupLargestFight(fx: any, aiVariant: number) {
    const { deployed, human } = fx;
    const { ships, randomManager, maps, aiEncounters, roguelikeNodeMap } =
      deployed;

    await ships.write.purchaseWithFlow(
      [human.account.address, 4n, human.account.address, 1],
      { value: parseEther("49.99") },
    );
    const bought = Number(await ships.read.shipCount());
    for (let id = 1; id <= bought; id++) {
      const ship = tupleToShip(
        (await ships.read.ships([BigInt(id)])) as ShipTuple,
      );
      await randomManager.write.revealRandomness([ship.traits.serialNumber]);
    }
    await ships.write.constructAllMyShips({ account: human.account });

    const costs: { id: bigint; cost: bigint }[] = [];
    for (let id = 1; id <= bought; id++) {
      const ship = await ships.read.getShip([BigInt(id)]);
      costs.push({ id: BigInt(id), cost: BigInt(ship.shipData.cost) });
    }
    costs.sort((a, b) => (a.cost < b.cost ? -1 : a.cost > b.cost ? 1 : 0));
    const roster: bigint[] = [];
    let total = 0n;
    for (const c of costs) {
      if (total + c.cost > MAX_COST_CAP) break;
      if (roster.length >= CREATOR_COLS.length * GRID_HEIGHT) break;
      total += c.cost;
      roster.push(c.id);
    }
    const positions = roster.map((_, i) => ({
      row: i % GRID_HEIGHT,
      col: CREATOR_COLS[Math.floor(i / GRID_HEIGHT)],
    }));

    await maps.write.createPresetMap([[], SCORING_TILES, MapMode.Both]);
    const mapId = await maps.read.mapCount();
    await aiEncounters.write.createAIShipConfig([
      "AI Ship",
      { mainWeapon: 0, armor: 0, shields: 0, special: 0 },
      {
        serialNumber: 0n,
        colors: { h1: 0, s1: 0, l1: 0, h2: 0, s2: 0, l2: 0 },
        variant: aiVariant,
        accuracy: 0,
        hull: 0,
        speed: 0,
      },
      AI_ARCHETYPE_GRUNT,
    ]);
    const configId = await aiEncounters.read.aiShipConfigCount();
    const aiCount = Number(await aiEncounters.read.maxPlacementsPerMap());
    for (let i = 0; i < aiCount; i++) {
      await aiEncounters.write.setMapPlacement([
        mapId,
        i % GRID_HEIGHT,
        JOINER_COLS[JOINER_COLS.length - 1 - Math.floor(i / GRID_HEIGHT)],
        configId,
      ]);
    }

    await roguelikeNodeMap.write.createCampaign();
    const campaignId = await roguelikeNodeMap.read.campaignCount();
    await roguelikeNodeMap.write.createNode([
      campaignId,
      ROGUELIKE_COMBAT,
      mapId,
      86400n,
      MAX_SCORE,
      true,
      0n,
    ]);
    const nodeId = await roguelikeNodeMap.read.nodeCount();
    await roguelikeNodeMap.write.setCampaignRoot([campaignId, nodeId]);
    await roguelikeNodeMap.write.createNode([
      campaignId,
      ROGUELIKE_COMBAT,
      mapId,
      86400n,
      MAX_SCORE,
      true,
      0n,
    ]);
    await roguelikeNodeMap.write.addChild([
      nodeId,
      await roguelikeNodeMap.read.nodeCount(),
    ]);
    await roguelikeNodeMap.write.setCampaignInitialCostCap([
      campaignId,
      MAX_COST_CAP,
    ]);

    return { roster, positions, campaignId, nodeId, aiCount };
  }

  for (const aiVariant of [1, 2]) {
    it(`keeps enterCombatNode and every AI turn under budget at the largest seeded fleets (variant ${aiVariant} AI)`, async function () {
      const fx = await loadFixture(deployFixture);
      const { publicClient, deployed, humanRoguelikeMatch, otherRoguelikeMatch, humanGame, human } = fx;
      const { roster, positions, campaignId, nodeId, aiCount } =
        await setupLargestFight(fx, aiVariant);
      // Bigger than the 7-ship fleet that hit the live limit.
      expect(roster.length).to.be.greaterThan(7);

      await humanRoguelikeMatch.write.startRun([campaignId, roster]);
      const enterGas = await gasOf(
        publicClient,
        await humanRoguelikeMatch.write.enterCombatNode([nodeId, positions]),
      );
      const gameId = (await deployed.roguelikeRun.read.getRun([
        human.account.address,
      ])).activeGameId;

      // Two full rounds: the human passes each ship in place, the AI moves
      // every one of its ships.
      let maxAITurnGas = 0n;
      let aiTurns = 0;
      for (let step = 0; step < 200; step++) {
        const g = await deployed.game.read.getGame([gameId]);
        if (g.metadata.ended || g.turnState.currentRound > 2n) break;
        if (g.turnState.currentTurn.toLowerCase() === human.account.address.toLowerCase()) {
          const moved = new Set(g.creatorMovedShipIds.map(String));
          const unmoved = g.creatorActiveShipIds.filter((id: bigint) => !moved.has(String(id)));
          let passed = false;
          for (const shipId of unmoved) {
            const pos = g.shipPositions.find((p: any) => p.shipId === shipId)!.position;
            try {
              await humanGame.write.moveShip([gameId, shipId, pos.row, pos.col, ActionType.Pass, 0n]);
              passed = true;
              break;
            } catch {
              // e.g. a ship at 0 HP; try the next one.
            }
          }
          expect(passed, "no human ship could pass").to.equal(true);
        } else {
          await expectAIViewsConsistent(deployed.game, gameId);
          const gas = await gasOf(
            publicClient,
            await otherRoguelikeMatch.write.takeAITurn([gameId]),
          );
          if (gas > maxAITurnGas) maxAITurnGas = gas;
          aiTurns++;
          if (!(await deployed.game.read.getGame([gameId])).metadata.ended) {
            await expectLiveBitmapsConsistent(deployed.game, gameId);
          }
        }
      }

      console.log(
        `      ${roster.length} human ships vs ${aiCount} AI (variant ${aiVariant}): ` +
          `enterCombatNode ${enterGas} gas, worst of ${aiTurns} AI turns ${maxAITurnGas} gas ` +
          `(budget ${GAS_BUDGET}, cap ${TX_GAS_CAP})`,
      );
      expect(aiTurns).to.be.greaterThan(aiCount);
      expect(enterGas <= GAS_BUDGET, `enterCombatNode used ${enterGas} gas`).to.equal(true);
      expect(maxAITurnGas <= GAS_BUDGET, `takeAITurn used ${maxAITurnGas} gas`).to.equal(true);
    });
  }

  // The transactions that end a game run every orchestrator and Fleets
  // cleanup on top of the move itself (added 2026-10-31). A game ends only
  // when a ship leaves the board, so each case downs all but one ship of the
  // losing side through storage and lets a real removal finish it.
  async function enterLargestFight(fx: any) {
    const { deployed, humanRoguelikeMatch, human } = fx;
    const setup = await setupLargestFight(fx, 2);
    await humanRoguelikeMatch.write.startRun([setup.campaignId, setup.roster]);
    await humanRoguelikeMatch.write.enterCombatNode([setup.nodeId, setup.positions]);
    const gameId = (await deployed.roguelikeRun.read.getRun([
      human.account.address,
    ])).activeGameId;
    return { gameId, ...setup };
  }

  const shipAt = (g: any, ids: readonly bigint[], row: number, col: number) =>
    ids.find((id) => {
      const p = g.shipPositions.find((s: any) => s.shipId === id)!.position;
      return p.row === row && p.col === col;
    })!;

  it("keeps the human's winning move under budget at the largest seeded fleets", async function () {
    const fx = await loadFixture(deployFixture);
    const { publicClient, deployed, humanGame, human } = fx;
    const { gameId, roster } = await enterLargestFight(fx);
    const game = deployed.game.address;

    // The last AI ship sits at 0 HP one shot from removal, next to the
    // human ship at (0, 1).
    let g = await deployed.game.read.getGame([gameId]);
    const ai = g.joinerActiveShipIds;
    for (const id of ai.slice(0, -1)) {
      await setShipHullPointsToZero(game, gameId, id);
    }
    const last = ai[ai.length - 1];
    await setShipPosition(game, gameId, last, 0, 2);
    await primeShipForRealDestruction(game, gameId, last);
    const shooter = shipAt(g, g.creatorActiveShipIds, 0, 1);

    const gas = await gasOf(
      publicClient,
      await humanGame.write.moveShip([gameId, shooter, 0, 1, ActionType.Shoot, last]),
    );
    g = await deployed.game.read.getGame([gameId]);
    expect(g.metadata.ended).to.equal(true);
    expect(g.metadata.winner.toLowerCase()).to.equal(human.account.address.toLowerCase());
    // A non-final win re-reserves the roster for the next node.
    expect((await deployed.roguelikeRun.read.getRun([human.account.address])).status).to.equal(1); // Active

    console.log(`      ${roster.length} human ships vs ${ai.length} AI: winning move ${gas} gas`);
    expect(gas <= GAS_BUDGET, `winning moveShip used ${gas} gas`).to.equal(true);
  });

  it("keeps the AI's game-ending turn under budget at the largest seeded fleets", async function () {
    const fx = await loadFixture(deployFixture);
    const { publicClient, deployed, humanGame, otherRoguelikeMatch, human } = fx;
    const { gameId, roster, aiCount } = await enterLargestFight(fx);
    const game = deployed.game.address;

    // One human ship left at 1 HP, with an AI ship next to it.
    let g = await deployed.game.read.getGame([gameId]);
    const survivor = shipAt(g, g.creatorActiveShipIds, 0, 1);
    for (const id of g.creatorActiveShipIds) {
      if (id !== survivor) await setShipHullPointsToZero(game, gameId, id);
    }
    await setShipHullPoints(game, gameId, survivor, 1);
    const ai = g.joinerActiveShipIds;
    await setShipPosition(game, gameId, ai[ai.length - 1], 0, 2);

    let endGas = 0n;
    for (let step = 0; step < 100 && endGas === 0n; step++) {
      g = await deployed.game.read.getGame([gameId]);
      expect(g.metadata.ended, "game ended on a human move").to.equal(false);
      if (g.turnState.currentTurn.toLowerCase() === human.account.address.toLowerCase()) {
        const p = g.shipPositions.find((s: any) => s.shipId === survivor)!.position;
        await humanGame.write.moveShip([gameId, survivor, p.row, p.col, ActionType.Pass, 0n]);
      } else {
        const gas = await gasOf(
          publicClient,
          await otherRoguelikeMatch.write.takeAITurn([gameId]),
        );
        if ((await deployed.game.read.getGame([gameId])).metadata.ended) endGas = gas;
      }
    }
    expect(endGas > 0n, "the AI never ended the game").to.equal(true);

    console.log(`      ${roster.length} human ships vs ${aiCount} AI: game-ending AI turn ${endGas} gas`);
    expect(endGas <= GAS_BUDGET, `game-ending takeAITurn used ${endGas} gas`).to.equal(true);
  });
});

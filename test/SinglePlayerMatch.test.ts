import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers";
import hre from "hardhat";
import { parseEther, parseEventLogs } from "viem";
import {
  ShipTuple,
  tupleToShip,
  ActionType,
  GameDataView,
  MapMode,
} from "./types";
import DeployModule from "../ignition/modules/DeployAndConfig";
import {
  setShipPosition,
  setShipHullPointsToZero,
  primeShipForRealDestruction,
} from "./helpers/gameStorage";

// Node-match game ids live in a disjoint range above Lobbies-sourced (PvP)
// ids — see SinglePlayerMatch.sol's NODE_MATCH_ID_OFFSET. Every test below
// starts exactly one node match against a fresh fixture, so its gameId is
// always this offset plus 1.
const NODE_MATCH_ID_OFFSET = 2n ** 40n;

// AI ship ids live in AIShips.sol's own local id space, offset by this same
// constant (mirrors AIShips.sol's AI_SHIP_ID_OFFSET) so ShipsRouter can tell
// them apart from Ships.sol's (human) ids. Every test below allocates AI
// ships against a fresh AIShips pool, so the Nth AI ship ever allocated in
// that test is always this offset plus N, regardless of how many human
// ships were minted first.
const AI_SHIP_ID_OFFSET = 2n ** 40n;

function findShipPosition(gameData: GameDataView, shipId: bigint) {
  for (const shipPosition of gameData.shipPositions) {
    if (shipPosition.shipId === shipId) {
      return shipPosition.position;
    }
  }
  throw new Error(`Ship ${shipId} not found in game data`);
}

describe("SinglePlayerMatch", function () {
  async function deploySinglePlayerFixture() {
    const [owner, human, other] = await hre.viem.getWalletClients();
    const publicClient = await hre.viem.getPublicClient();

    const deployed = await hre.ignition.deploy(DeployModule);

    const humanShips = await hre.viem.getContractAt(
      "Ships",
      deployed.ships.address,
      { client: { wallet: human } },
    );
    const humanGame = await hre.viem.getContractAt(
      "Game",
      deployed.game.address,
      { client: { wallet: human } },
    );
    const humanSinglePlayerMatch = await hre.viem.getContractAt(
      "SinglePlayerMatch",
      deployed.singlePlayerMatch.address,
      { client: { wallet: human } },
    );
    const singlePlayerMatchOther = await hre.viem.getContractAt(
      "SinglePlayerMatch",
      deployed.singlePlayerMatch.address,
      { client: { wallet: other } },
    );

    return {
      ships: deployed.ships,
      aiShips: deployed.aiShips,
      shipsRouter: deployed.shipsRouter,
      game: deployed.game,
      maps: deployed.maps,
      nodeMap: deployed.nodeMap,
      singlePlayerMatch: deployed.singlePlayerMatch,
      aiBehaviorRegistry: deployed.aiBehaviorRegistry,
      aiEncounters: deployed.aiEncounters,
      universalCredits: deployed.universalCredits,
      droneEnergyCores: deployed.droneEnergyCores,
      randomManager: deployed.randomManager,
      humanShips,
      humanGame,
      humanSinglePlayerMatch,
      singlePlayerMatchOther,
      owner,
      human,
      other,
      publicClient,
    };
  }

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
    variant: 1,
    accuracy: 0,
    hull: 0,
    speed: 0,
  };

  const defaultEquipment = {
    mainWeapon: 0, // Generic
    armor: 0, // None
    shields: 0, // None
    special: 0, // None
  };

  const defaultArchetype = 0; // Grunt

  // Creates a preset map with one AI ship config placed at (0, 16) — the
  // same single-ship-at-the-AI's-corner shape the old hardcoded template
  // produced for ship index 0 — and returns its map id. _mintAIFleet reads
  // its fleet composition/placement entirely from AIEncounters, so every
  // single-player test needs a real, non-empty configured map.
  async function setupBasicAIEncounter(
    maps: any,
    aiEncounters: any,
    variant = 1,
  ) {
    await maps.write.createPresetMap([[], MapMode.Both]);
    const mapId = await maps.read.mapCount();
    await aiEncounters.write.createAIShipConfig([
      "AI Ship",
      defaultEquipment,
      { ...defaultTraits, variant },
      defaultArchetype,
    ]);
    const configId = await aiEncounters.read.aiShipConfigCount();
    await aiEncounters.write.setMapPlacement([mapId, 0, 16, configId]);
    return mapId;
  }

  // Admin-curates a campaign node against the given map (as owner, the
  // deployer/node editor by default) and returns its id. costLimit/turnTime/
  // maxScore mirror what a generous player-chosen lobby used to allow.
  async function createCampaignNode(
    nodeMap: any,
    mapId: bigint,
    prerequisites: bigint[] = [],
    campaignId: bigint = 1n, // deploy-seeded "mainCampaign" by default
  ) {
    await nodeMap.write.createNode([
      campaignId,
      mapId,
      prerequisites,
      2000n, // costLimit
      86400n, // turnTime
      20n, // maxScore
      true, // creatorGoesFirst
    ]);
    return await nodeMap.read.nodeCount();
  }

  // Mints and constructs the human's tier-0 ships (ids 1-5) — same
  // boilerplate every scenario below needs before startNodeMatch. Does not
  // create a fleet itself; startNodeMatch does that as part of entering the
  // match.
  async function purchaseAndConstructHumanShip(
    ships: any,
    randomManager: any,
    humanShips: any,
    human: any,
  ) {
    await ships.write.purchaseWithFlow(
      [human.account.address, 0n, human.account.address, 1],
      { value: parseEther("4.99") },
    );
    for (let i = 1; i <= 5; i++) {
      const shipTuple = (await ships.read.ships([BigInt(i)])) as ShipTuple;
      const ship = tupleToShip(shipTuple);
      await randomManager.write.revealRandomness([
        ship.traits.serialNumber,
      ]);
    }
    await humanShips.write.constructAllMyShips({ account: human.account });
  }

  it("identifies only this contract's own address as the single-player orchestrator", async function () {
    const { singlePlayerMatch, human } = await loadFixture(
      deploySinglePlayerFixture,
    );
    expect(
      await singlePlayerMatch.read.isSinglePlayerOrchestrator([
        singlePlayerMatch.address,
      ]),
    ).to.equal(true);
    expect(
      await singlePlayerMatch.read.isSinglePlayerOrchestrator([
        human.account.address,
      ]),
    ).to.equal(false);
  });

  it("plays a single-player match end to end through startNodeMatch", async function () {
    const {
      ships,
      game,
      maps,
      nodeMap,
      singlePlayerMatch,
      aiEncounters,
      randomManager,
      humanShips,
      humanGame,
      humanSinglePlayerMatch,
      singlePlayerMatchOther,
      human,
      owner,
    } = await loadFixture(deploySinglePlayerFixture);

    const mapId = await setupBasicAIEncounter(maps, aiEncounters);
    const nodeId = await createCampaignNode(nodeMap, mapId);

    // Human purchases and constructs a ship. Creator ships must sit in
    // columns 0-3, so it starts far from the AI's fleet (col 16) — repositioned
    // below via the debug helper to directly exercise the v0 script's Case 1
    // (adjacent enemy) without needing 10+ rounds of the AI closing the gap.
    await purchaseAndConstructHumanShip(ships, randomManager, humanShips, human);

    await humanSinglePlayerMatch.write.startNodeMatch([
      nodeId,
      [1n],
      [{ row: 0, col: 0 }],
    ]);

    const gameId = NODE_MATCH_ID_OFFSET + 1n;

    let gameData = (await game.read.getGame([gameId])) as GameDataView;
    expect(gameData.metadata.ended).to.equal(false);
    expect(gameData.metadata.creator.toLowerCase()).to.equal(
      human.account.address.toLowerCase(),
    );
    expect(gameData.metadata.joiner.toLowerCase()).to.equal(
      singlePlayerMatch.address.toLowerCase(),
    );
    expect(gameData.turnState.currentTurn.toLowerCase()).to.equal(
      human.account.address.toLowerCase(),
    );

    // The AI's first ship allocated from AIShips' pool starts at (0, 16),
    // regardless of the human's own ship ids. Reposition the human's ship
    // to (0, 15) — one column to its left — so Case 1 of the v0 script
    // applies: stay and fire.
    const humanShipId = 1n;
    const aiShipId = AI_SHIP_ID_OFFSET + 1n;
    await setShipPosition(game.address, gameId, humanShipId, 0, 15);
    const humanAttrsBefore = await game.read.getShipAttributes([
      gameId,
      humanShipId,
    ]);

    // Human passes in place
    await humanGame.write.moveShip(
      [gameId, humanShipId, 0, 15, ActionType.Pass, 0n],
      { account: human.account },
    );

    gameData = (await game.read.getGame([gameId])) as GameDataView;
    expect(gameData.turnState.currentTurn.toLowerCase()).to.equal(
      singlePlayerMatch.address.toLowerCase(),
    );

    // Anyone can trigger the AI's turn — takeAITurn moves exactly one ship
    // per call now.
    await singlePlayerMatchOther.write.takeAITurn([gameId]);

    // The variant-1 AI is a skirmisher: with the enemy adjacent it backs
    // off to its gun's maximum range (Laser: 3) before firing. It is in the
    // corner (0,16), so it slides along the wall to (2,16) — exactly range 3
    // from the human at (0,15) — and fires from there.
    const aiPosAfter = findShipPosition(
      (await game.read.getGame([gameId])) as GameDataView,
      aiShipId,
    );
    expect(aiPosAfter.row).to.equal(2);
    expect(aiPosAfter.col).to.equal(16);

    const humanAttrsAfter = await game.read.getShipAttributes([
      gameId,
      humanShipId,
    ]);
    expect(humanAttrsAfter.hullPoints).to.be.lessThan(
      humanAttrsBefore.hullPoints,
    );

    // Both sides only have one ship, so the AI's single move immediately
    // ends the round — and turn order alternates by round, so the AI goes
    // first in round 2 as well, meaning the turn stays with the AI after
    // this first call. Drain any further AI-only turns exactly like the
    // frontend does: keep calling takeAITurn (one ship per call) until the
    // turn actually returns to the human.
    gameData = (await game.read.getGame([gameId])) as GameDataView;
    let guard = 0;
    while (
      !gameData.metadata.ended &&
      gameData.turnState.currentTurn.toLowerCase() ===
        singlePlayerMatch.address.toLowerCase()
    ) {
      guard++;
      expect(guard).to.be.lessThan(10); // safety bound against an infinite loop
      await singlePlayerMatchOther.write.takeAITurn([gameId]);
      gameData = (await game.read.getGame([gameId])) as GameDataView;
    }

    expect(gameData.turnState.currentTurn.toLowerCase()).to.equal(
      human.account.address.toLowerCase(),
    );
  });

  it("keeps an active match's AI on the registry that was live when it started, even if the owner swaps it mid-match (UA-08)", async function () {
    const {
      ships,
      game,
      maps,
      nodeMap,
      singlePlayerMatch,
      aiEncounters,
      randomManager,
      humanShips,
      humanGame,
      humanSinglePlayerMatch,
      singlePlayerMatchOther,
      human,
      owner,
    } = await loadFixture(deploySinglePlayerFixture);

    const mapId = await setupBasicAIEncounter(maps, aiEncounters);
    const nodeId = await createCampaignNode(nodeMap, mapId);
    await purchaseAndConstructHumanShip(ships, randomManager, humanShips, human);

    await humanSinglePlayerMatch.write.startNodeMatch([
      nodeId,
      [1n],
      [{ row: 0, col: 0 }],
    ]);
    const gameId = NODE_MATCH_ID_OFFSET + 1n;

    await humanGame.write.moveShip(
      [gameId, 1n, 0, 0, ActionType.Pass, 0n],
      { account: human.account },
    );

    // Simulate an admin AI rollout mid-match: swap in a brand-new, EMPTY
    // registry (no variant registered at all) — a routine "ship an AI
    // balance patch" action, not a rare migration.
    const emptyRegistry = await hre.viem.deployContract(
      "AIBehaviorRegistry",
      [],
    );
    await singlePlayerMatch.write.setAIRegistryAddress(
      [emptyRegistry.address],
      { account: owner.account },
    );

    // The AI's turn in this already-active match must still succeed — if
    // this were a live read, it would revert NoAIForVariant from the new,
    // unconfigured registry instead.
    await expect(singlePlayerMatchOther.write.takeAITurn([gameId])).to.not
      .be.rejected;
  });

  it("lets the human forfeit their own match, releasing their ships (HA6-12)", async function () {
    const {
      ships,
      maps,
      nodeMap,
      singlePlayerMatch,
      aiEncounters,
      randomManager,
      humanShips,
      humanGame,
      singlePlayerMatchOther,
      humanSinglePlayerMatch,
      human,
    } = await loadFixture(deploySinglePlayerFixture);

    const mapId = await setupBasicAIEncounter(maps, aiEncounters);
    const nodeId = await createCampaignNode(nodeMap, mapId);
    await purchaseAndConstructHumanShip(ships, randomManager, humanShips, human);
    await humanSinglePlayerMatch.write.startNodeMatch([
      nodeId,
      [1n],
      [{ row: 0, col: 0 }],
    ]);
    const gameId = NODE_MATCH_ID_OFFSET + 1n;
    expect((await ships.read.getShip([1n])).shipData.inFleet).to.equal(true);

    await expect(
      singlePlayerMatchOther.write.forfeit([gameId]),
    ).to.be.rejectedWith("NotYourGame");

    await humanSinglePlayerMatch.write.forfeit([gameId]);
    const game = await humanGame.read.getGame([gameId]);
    expect(game.metadata.ended).to.equal(true);
    expect(game.metadata.winner.toLowerCase()).to.equal(
      singlePlayerMatch.address.toLowerCase(),
    );
    expect((await ships.read.getShip([1n])).shipData.inFleet).to.equal(false);
  });

  it("locks the live-state address setters once a match has started (HA6-13)", async function () {
    const {
      ships,
      maps,
      nodeMap,
      singlePlayerMatch,
      aiEncounters,
      randomManager,
      humanShips,
      humanSinglePlayerMatch,
      human,
      owner,
    } = await loadFixture(deploySinglePlayerFixture);

    // Before any match: still configurable.
    const current = await singlePlayerMatch.read.game();
    await singlePlayerMatch.write.setGameAddress([current], {
      account: owner.account,
    });

    const mapId = await setupBasicAIEncounter(maps, aiEncounters);
    const nodeId = await createCampaignNode(nodeMap, mapId);
    await purchaseAndConstructHumanShip(ships, randomManager, humanShips, human);
    await humanSinglePlayerMatch.write.startNodeMatch([
      nodeId,
      [1n],
      [{ row: 0, col: 0 }],
    ]);

    const someAddress = owner.account.address;
    for (const fn of [
      "setGameAddress",
      "setShipsAddress",
      "setMapsAddress",
      "setNodeMapAddress",
    ] as const) {
      await expect(
        (singlePlayerMatch.write as any)[fn]([someAddress], {
          account: owner.account,
        }),
      ).to.be.rejectedWith("EngineAlreadyLive");
    }
  });

  it("allows a mixed-variant AI fleet, with each AI ship on its own faction's AI (HA6-30)", async function () {
    const {
      ships,
      maps,
      nodeMap,
      singlePlayerMatch,
      aiEncounters,
      aiBehaviorRegistry,
      randomManager,
      humanShips,
      humanGame,
      humanSinglePlayerMatch,
      singlePlayerMatchOther,
      human,
    } = await loadFixture(deploySinglePlayerFixture);

    await maps.write.createPresetMap([[], MapMode.Both]);
    const mapId = await maps.read.mapCount();
    const equipment = { mainWeapon: 0, armor: 0, shields: 0, special: 0 };
    const colors = { h1: 0, s1: 0, l1: 0, h2: 0, s2: 0, l2: 0, h3: 0, s3: 0, l3: 0 };
    for (const [variant, row] of [[1, 0], [2, 2]] as const) {
      await aiEncounters.write.createAIShipConfig([
        `AI v${variant}`,
        equipment,
        { serialNumber: 0n, colors, variant, accuracy: 0, hull: 0, speed: 0 },
        0,
      ]);
      const configId = await aiEncounters.read.aiShipConfigCount();
      await aiEncounters.write.setMapPlacement([mapId, row, 16, configId]);
    }
    const nodeId = await createCampaignNode(nodeMap, mapId);
    await purchaseAndConstructHumanShip(ships, randomManager, humanShips, human);

    // Used to revert MixedVariantFleet.
    await humanSinglePlayerMatch.write.startNodeMatch([
      nodeId,
      [1n],
      [{ row: 0, col: 0 }],
    ]);
    const gameId = NODE_MATCH_ID_OFFSET + 1n;
    const gd = await humanGame.read.getGame([gameId]);
    const aiIds = gd.joinerActiveShipIds;
    expect(aiIds.length).to.equal(2);
    const infos = await Promise.all(
      aiIds.map((id: bigint) => singlePlayerMatch.read.aiShipInfo([id])),
    );
    const variants = infos.map((i: any) => Number(i[1])).sort();
    expect(variants).to.deep.equal([1, 2]);
    const ais = infos.map((i: any) => (i[4] as string).toLowerCase()).sort();
    expect(ais).to.deep.equal(
      [
        (await aiBehaviorRegistry.read.aiFor([1])).toLowerCase(),
        (await aiBehaviorRegistry.read.aiFor([2])).toLowerCase(),
      ].sort(),
    );

    // Both AI ships can take their turns.
    await humanGame.write.moveShip([gameId, 1n, 0, 0, ActionType.Pass, 0n], {
      account: human.account,
    });
    await singlePlayerMatchOther.write.takeAITurns([gameId, 2n]);
  });

  it("reverts takeAITurn when it isn't the AI's turn", async function () {
    const {
      ships,
      maps,
      nodeMap,
      aiEncounters,
      randomManager,
      humanShips,
      humanSinglePlayerMatch,
      singlePlayerMatchOther,
      human,
    } = await loadFixture(deploySinglePlayerFixture);

    const mapId = await setupBasicAIEncounter(maps, aiEncounters);
    const nodeId = await createCampaignNode(nodeMap, mapId);

    await purchaseAndConstructHumanShip(ships, randomManager, humanShips, human);
    await humanSinglePlayerMatch.write.startNodeMatch([
      nodeId,
      [1n],
      [{ row: 0, col: 0 }],
    ]);

    const gameId = NODE_MATCH_ID_OFFSET + 1n;

    // It's the human's turn right after the game starts (human is always
    // creatorGoesFirst on a campaign node here) — takeAITurn must revert
    // rather than act out of turn.
    await expect(
      singlePlayerMatchOther.write.takeAITurn([gameId]),
    ).to.be.rejectedWith("NotAITurn");
  });

  describe("takeAITurns (batched AI turns)", function () {
    // One human ship vs three AI ships: once the human's only ship has
    // moved, the turn stays with the AI until all three of its ships have
    // moved too — the one case where batching actually saves transactions.
    async function startOneVsThree() {
      const f = await loadFixture(deploySinglePlayerFixture);
      const mapId = await setupBasicAIEncounter(f.maps, f.aiEncounters);
      const configId = await f.aiEncounters.read.aiShipConfigCount();
      await f.aiEncounters.write.setMapPlacement([mapId, 4, 16, configId]);
      await f.aiEncounters.write.setMapPlacement([mapId, 8, 16, configId]);
      const nodeId = await createCampaignNode(f.nodeMap, mapId);
      await purchaseAndConstructHumanShip(
        f.ships,
        f.randomManager,
        f.humanShips,
        f.human,
      );
      await f.humanSinglePlayerMatch.write.startNodeMatch([
        nodeId,
        [1n],
        [{ row: 0, col: 0 }],
      ]);
      const gameId = NODE_MATCH_ID_OFFSET + 1n;
      await f.humanGame.write.moveShip(
        [gameId, 1n, 0, 0, ActionType.Pass, 0n],
        { account: f.human.account },
      );
      return { ...f, gameId };
    }

    async function aiTurnsIn(f: any, hash: `0x${string}`) {
      const receipt = await f.publicClient.waitForTransactionReceipt({ hash });
      return parseEventLogs({
        abi: f.singlePlayerMatch.abi,
        logs: receipt.logs,
        eventName: "AITurnTaken",
      });
    }

    it("moves every AI ship the turn stays with the AI for in one transaction, then stops once it's the human's turn", async function () {
      const f = await startOneVsThree();

      const hash = await f.singlePlayerMatchOther.write.takeAITurns([
        f.gameId,
        20n,
      ]);
      const turns = await aiTurnsIn(f, hash);

      // All three AI ships moved in this single call (round 1's tail).
      // Exact count past that depends on who opens round 2 and on combat
      // RNG, so it's only bounded, not pinned.
      expect(turns.length).to.be.at.least(3);
      expect(turns.length).to.be.lessThan(20);

      const g = (await f.game.read.getGame([f.gameId])) as GameDataView;
      if (!g.metadata.ended) {
        expect(g.turnState.currentTurn.toLowerCase()).to.equal(
          f.human.account.address.toLowerCase(),
        );
      }
    });

    it("never moves more than _maxMoves ships", async function () {
      const f = await startOneVsThree();

      const hash = await f.singlePlayerMatchOther.write.takeAITurns([
        f.gameId,
        2n,
      ]);
      expect((await aiTurnsIn(f, hash)).length).to.equal(2);

      // The third AI ship is still unmoved, so the turn is still the AI's.
      const g = (await f.game.read.getGame([f.gameId])) as GameDataView;
      expect(g.turnState.currentTurn.toLowerCase()).to.equal(
        f.singlePlayerMatch.address.toLowerCase(),
      );
    });

    it("reverts when it isn't the AI's turn, like takeAITurn", async function () {
      const f = await loadFixture(deploySinglePlayerFixture);
      const mapId = await setupBasicAIEncounter(f.maps, f.aiEncounters);
      const nodeId = await createCampaignNode(f.nodeMap, mapId);
      await purchaseAndConstructHumanShip(
        f.ships,
        f.randomManager,
        f.humanShips,
        f.human,
      );
      await f.humanSinglePlayerMatch.write.startNodeMatch([
        nodeId,
        [1n],
        [{ row: 0, col: 0 }],
      ]);

      await expect(
        f.singlePlayerMatchOther.write.takeAITurns([
          NODE_MATCH_ID_OFFSET + 1n,
          5n,
        ]),
      ).to.be.rejectedWith("NotAITurn");
    });
  });

  it("indexes GameStarted by creator and joiner so a player can find their own games by topic", async function () {
    const f = await loadFixture(deploySinglePlayerFixture);
    const mapId = await setupBasicAIEncounter(f.maps, f.aiEncounters);
    const nodeId = await createCampaignNode(f.nodeMap, mapId);
    await purchaseAndConstructHumanShip(
      f.ships,
      f.randomManager,
      f.humanShips,
      f.human,
    );
    await f.humanSinglePlayerMatch.write.startNodeMatch([
      nodeId,
      [1n],
      [{ row: 0, col: 0 }],
    ]);

    const mine = await f.game.getEvents.GameStarted(
      { creator: f.human.account.address },
      { fromBlock: 0n },
    );
    expect(mine.length).to.equal(1);
    expect(mine[0].args.gameId).to.equal(NODE_MATCH_ID_OFFSET + 1n);

    const notMine = await f.game.getEvents.GameStarted(
      { creator: f.other.account.address },
      { fromBlock: 0n },
    );
    expect(notMine.length).to.equal(0);
  });

  it("reverts startNodeMatch when the node does not exist", async function () {
    const { humanSinglePlayerMatch } = await loadFixture(
      deploySinglePlayerFixture,
    );

    await expect(
      humanSinglePlayerMatch.write.startNodeMatch([999n, [], []]),
    ).to.be.rejectedWith("NodeNotFound");
  });

  it("reverts startNodeMatch when the node's map has no AI placements configured", async function () {
    const { maps, nodeMap, humanSinglePlayerMatch } = await loadFixture(
      deploySinglePlayerFixture,
    );

    await maps.write.createPresetMap([[], MapMode.Both]);
    const mapId = await maps.read.mapCount();
    const nodeId = await createCampaignNode(nodeMap, mapId);

    await expect(
      humanSinglePlayerMatch.write.startNodeMatch([nodeId, [], []]),
    ).to.be.rejectedWith("NoAIPlacementsConfigured");
  });

  it("reverts startNodeMatch when the human fleet's variant doesn't match the campaign's required variant", async function () {
    const {
      ships,
      maps,
      nodeMap,
      aiEncounters,
      humanShips,
      humanSinglePlayerMatch,
      human,
      owner,
    } = await loadFixture(deploySinglePlayerFixture);

    const mapId = await setupBasicAIEncounter(maps, aiEncounters);
    const nodeId = await createCampaignNode(nodeMap, mapId);

    // Deploy-seeded: campaign 1 ("mainCampaign", reused by createCampaignNode
    // above) requires variant 1 — see DeployAndConfig.ts's
    // SetMainCampaignRequiredVariant call.
    expect(await nodeMap.read.campaignRequiredVariant([1n])).to.equal(1);

    // Mint a plain (ungated) variant-1 ship, then overwrite it to variant 2
    // via customizeShip — same pattern Game.test.ts's variant-2 special
    // tests use, avoids needing to actually hold ShatteredHiveMedal just to
    // exercise this gate.
    await ships.write.setIsAllowedToCreateShips(
      [owner.account.address, true],
      { account: owner.account },
    );
    await ships.write.createShips(
      [human.account.address, 1, 1, 0, false],
      { account: owner.account },
    );
    const ownedShipIds = await ships.read.getShipIdsOwned([
      human.account.address,
    ]);
    const shipId = ownedShipIds[ownedShipIds.length - 1];

    const shipTuple = (await ships.read.ships([shipId])) as ShipTuple;
    const ship = tupleToShip(shipTuple);
    await ships.write.customizeShip(
      [shipId, { ...ship, traits: { ...ship.traits, variant: 2 } }],
      { account: owner.account },
    );
    await ships.write.setCostOfShip([shipId], { account: owner.account });

    await expect(
      humanSinglePlayerMatch.write.startNodeMatch([
        nodeId,
        [shipId],
        [{ row: 0, col: 0 }],
      ]),
    ).to.be.rejectedWith("WrongCampaignVariant");

    // Unrestricted (0) campaigns are unaffected — same fleet, different
    // (fresh, unrestricted) campaign.
    await nodeMap.write.createCampaign();
    const unrestrictedNodeId = await createCampaignNode(
      nodeMap,
      mapId,
      [],
      2n,
    );
    await humanSinglePlayerMatch.write.startNodeMatch([
      unrestrictedNodeId,
      [shipId],
      [{ row: 0, col: 0 }],
    ]);
  });

  it("builds the AI fleet exactly from the configured map placements", async function () {
    const {
      ships,
      aiShips,
      game,
      maps,
      nodeMap,
      aiEncounters,
      randomManager,
      humanShips,
      humanSinglePlayerMatch,
      human,
    } = await loadFixture(deploySinglePlayerFixture);

    await maps.write.createPresetMap([[], MapMode.Both]);
    const mapId = await maps.read.mapCount();

    await aiEncounters.write.createAIShipConfig([
      "Scout",
      { mainWeapon: 0, armor: 0, shields: 0, special: 1 }, // Generic/None/None/EMP
      { ...defaultTraits, variant: 1, accuracy: 1 },
      1, // Aggressor
    ]);
    const scoutConfigId = await aiEncounters.read.aiShipConfigCount();
    await aiEncounters.write.createAIShipConfig([
      "Bruiser",
      { mainWeapon: 1, armor: 1, shields: 0, special: 2 }, // Sniper/Light/None/RepairDrones
      { ...defaultTraits, variant: 1, hull: 2 },
      3, // Support
    ]);
    const bruiserConfigId = await aiEncounters.read.aiShipConfigCount();
    await aiEncounters.write.createAIShipConfig([
      "Support",
      { mainWeapon: 2, armor: 0, shields: 1, special: 3 }, // Missile/None/Light/FlakArray
      { ...defaultTraits, variant: 1, speed: 2 },
      0, // Grunt
    ]);
    const supportConfigId = await aiEncounters.read.aiShipConfigCount();
    await aiEncounters.write.setMapPlacements([
      mapId,
      [
        { row: 0, col: 16 },
        { row: 1, col: 15 },
        { row: 2, col: 14 },
      ],
      [scoutConfigId, bruiserConfigId, supportConfigId],
    ]);

    const nodeId = await createCampaignNode(nodeMap, mapId);

    // Human mints/constructs a ship — the game only starts once
    // startNodeMatch runs, so this is needed before getGame below resolves.
    await purchaseAndConstructHumanShip(ships, randomManager, humanShips, human);
    await humanSinglePlayerMatch.write.startNodeMatch([
      nodeId,
      [1n],
      [{ row: 0, col: 0 }],
    ]);

    const gameId = NODE_MATCH_ID_OFFSET + 1n;

    // AIShips' pool allocates ids independently of the human's own ships —
    // the AI's ships (allocated in placement order) start at
    // AI_SHIP_ID_OFFSET + 1.
    const scoutId = AI_SHIP_ID_OFFSET + 1n;
    const bruiserId = AI_SHIP_ID_OFFSET + 2n;
    const supportId = AI_SHIP_ID_OFFSET + 3n;

    const scout = await aiShips.read.getShip([scoutId]);
    expect(scout.name).to.equal("Scout");
    expect(scout.equipment.mainWeapon).to.equal(0);
    expect(scout.equipment.special).to.equal(1);
    expect(scout.traits.accuracy).to.equal(1);

    const bruiser = await aiShips.read.getShip([bruiserId]);
    expect(bruiser.name).to.equal("Bruiser");
    expect(bruiser.equipment.mainWeapon).to.equal(1);
    expect(bruiser.traits.hull).to.equal(2);

    const support = await aiShips.read.getShip([supportId]);
    expect(support.name).to.equal("Support");
    expect(support.equipment.shields).to.equal(1);
    expect(support.traits.speed).to.equal(2);

    const gameData = (await game.read.getGame([gameId])) as GameDataView;
    expect(findShipPosition(gameData, scoutId)).to.deep.equal({ row: 0, col: 16 });
    expect(findShipPosition(gameData, bruiserId)).to.deep.equal({ row: 1, col: 15 });
    expect(findShipPosition(gameData, supportId)).to.deep.equal({ row: 2, col: 14 });
  });

  it("sizes the AI fleet dynamically from however many placements are configured (not fixed at 3)", async function () {
    const { aiShips, maps, nodeMap, singlePlayerMatch, aiEncounters, humanSinglePlayerMatch, human } =
      await loadFixture(deploySinglePlayerFixture);

    await maps.write.createPresetMap([[], MapMode.Both]);
    const mapId = await maps.read.mapCount();

    await aiEncounters.write.createAIShipConfig([
      "AI Ship",
      defaultEquipment,
      defaultTraits,
      defaultArchetype,
    ]);
    const configId = await aiEncounters.read.aiShipConfigCount();

    const positions = [
      { row: 0, col: 13 },
      { row: 1, col: 13 },
      { row: 2, col: 13 },
      { row: 3, col: 13 },
      { row: 4, col: 13 },
    ];
    await aiEncounters.write.setMapPlacements([
      mapId,
      positions,
      positions.map(() => configId),
    ]);

    const nodeId = await createCampaignNode(nodeMap, mapId);

    await humanSinglePlayerMatch.write.startNodeMatch([nodeId, [], []]);

    // No human ships were minted in this test (empty fleet), so all 5 ids
    // allocated here are the AI's — AIShips' pool starts at
    // AI_SHIP_ID_OFFSET + 1 regardless.
    for (let i = 1; i <= 5; i++) {
      const ship = await aiShips.read.getShip([AI_SHIP_ID_OFFSET + BigInt(i)]);
      expect(ship.owner.toLowerCase()).to.equal(
        singlePlayerMatch.address.toLowerCase(),
      );
    }
  });

  it("does not cap the AI fleet's cost against the node's costLimit", async function () {
    const { maps, nodeMap, aiEncounters, humanSinglePlayerMatch } =
      await loadFixture(deploySinglePlayerFixture);

    // setupBasicAIEncounter's single default-traits AI ship still costs 75
    // (baseCost 50 + Laser's mainWeapon cost 25) — comfortably more than
    // the costLimit: 1n below. If the AI fleet were still capped against
    // the node's costLimit (the old behavior), minting it would revert
    // InvalidFleetCost; an admin-curated encounter should never be
    // second-guessed by the human's own fleet-cost ceiling.
    const mapId = await setupBasicAIEncounter(maps, aiEncounters);
    await nodeMap.write.createNode([1n, mapId, [], 1n, 600n, 20n, true]);
    const nodeId = await nodeMap.read.nodeCount();

    // Human enters with an empty fleet (cost 0, so it alone can't prove
    // anything — the AI fleet is what has to clear a costLimit of 1).
    await humanSinglePlayerMatch.write.startNodeMatch([nodeId, [], []]);
  });

  describe("Deploy-seeded starter maps", function () {
    it("seeds sixty-six starter maps scaling from an easy opener (m01) through a matched-difficulty midpoint (m15) to the hardest finale (f06)", async function () {
      const { maps, aiEncounters } = await loadFixture(deploySinglePlayerFixture);

      // 30 campaign maps (ids 1-30), 30 dedicated roguelike maps (ids
      // 31-60 — every roguelike Combat node has its own map since the
      // 2026-09-23 pass, not just the first three missions' variant-1
      // rosters), plus 6 PvP-only maps (ids 61-66, not attached to any
      // node — pvp06 added 2026-09-28). Everything below reads campaign
      // maps by id, so the rest don't disturb it.
      expect(await maps.read.mapCount()).to.equal(66n);

      // Map 1 (m01, id 1): easiest mission — thematically generated "Open
      // Void" terrain (light cover, long sightlines), one contested
      // center scoring tile plus a symmetric flanking pair, a small
      // 3-ship fleet.
      const map1Blocked = await maps.read.getPresetMap([1n]);
      expect(map1Blocked.length).to.equal(2);
      const map1Scoring = await maps.read.getPresetScoringMap([1n]);
      expect(map1Scoring.length).to.equal(3);
      for (const tile of map1Scoring as any[]) {
        expect(tile.points).to.equal(5);
      }

      const [map1Positions] = await aiEncounters.read.getMapPlacements([1n]);
      expect(map1Positions.length).to.equal(3);
      for (const pos of map1Positions as any[]) {
        expect(pos.col).to.be.at.least(13);
        expect(pos.col).to.be.at.most(16);
      }

      // Map 15 (m15, id 15): the "average" mission at the campaign's
      // midpoint — a tiered objective (one 20-point contested center, four
      // 10-point one-time flanking holds) over dense generated cover.
      const map15Blocked = await maps.read.getPresetMap([15n]);
      expect(map15Blocked.length).to.equal(53);
      const map15Scoring = await maps.read.getPresetScoringMap([15n]);
      expect(map15Scoring.length).to.equal(5);
      expect(
        (map15Scoring as any[]).filter((t) => t.points === 20).length,
      ).to.equal(1);
      expect(
        (map15Scoring as any[]).filter((t) => t.points === 10).length,
      ).to.equal(4);

      // Map 30 (f06, id 30): the hardest, final mission — same tiered
      // objective shape as m15, maxed out on the live-tunable AI fleet
      // size (14 ships).
      const map30Scoring = await maps.read.getPresetScoringMap([30n]);
      expect(map30Scoring.length).to.equal(5);
      expect(
        (map30Scoring as any[]).filter((t) => t.points === 20).length,
      ).to.equal(1);
      const [map30Positions] = await aiEncounters.read.getMapPlacements([30n]);
      expect(map30Positions.length).to.equal(14);
      for (const pos of map30Positions as any[]) {
        expect(pos.col).to.be.at.least(13);
        expect(pos.col).to.be.at.most(16);
      }
    });

    // DeployAndConfig.ts's setCreatorZone/setJoinerZone loop
    // (added alongside the 2026-09-23 map-redesign pass) had no test
    // coverage at all until now — every other map test here only checked
    // Maps.sol's functions in isolation, never that the deploy module's own
    // per-map wiring actually ran against real seeded content. Found via a
    // full-repo audit (2026-09-25) and confirmed against the live Base
    // Sepolia deploy before writing this.
    it("wires a custom deployment zone onto deploy-seeded maps, across all three map id bands", async function () {
      const { maps } = await loadFixture(deploySinglePlayerFixture);

      // Campaign (ids 1-30): m01 uses the default (vertical) zone shape --
      // an unset zone reads back as an empty array, not the default
      // rectangle itself (see isValidDeploymentTile's fallback).
      expect(await maps.read.getCreatorZonePositions([1n])).to.deep.equal([]);
      expect(await maps.read.getJoinerZonePositions([1n])).to.deep.equal([]);

      // m02 uses a custom (diagonal) zone shape -- both sides should come
      // back with real, non-empty tile sets.
      const m02Creator = await maps.read.getCreatorZonePositions([2n]);
      const m02Joiner = await maps.read.getJoinerZonePositions([2n]);
      expect(m02Creator.length).to.be.greaterThan(0);
      expect(m02Joiner.length).to.be.greaterThan(0);

      // PvP (ids 61-66): id 61 is pvp01, the first-ever PvP preset map.
      expect(await maps.read.mapMode([61n])).to.equal(0); // MapMode.PvP
    });

    it("seeds a thirty-node campaign graph — a 15-mission mainline, a 6-mission dead end, and a 3-mission shortcut that reconverges into a 6-mission final stretch", async function () {
      const { nodeMap, human } = await loadFixture(deploySinglePlayerFixture);

      expect(await nodeMap.read.nodeCount()).to.equal(30n);

      // All 30 seeded nodes belong to the single deploy-seeded
      // "mainCampaign" (id 1).
      expect(await nodeMap.read.campaignCount()).to.equal(1n);
      const campaignNodeIds = (await nodeMap.read.getNodesInCampaign([
        1n,
      ])) as bigint[];
      expect(campaignNodeIds.length).to.equal(30);

      // Node ids follow seed order: mainline m01-m15 = 1-15, dead end
      // d01-d06 = 16-21, shortcut s01-s03 = 22-24, final stretch f01-f06 =
      // 25-30.

      // The dead end (16-21) branches off m02 (id 2) and terminates at
      // node 21 (d06) — nothing in the graph lists it as a prerequisite,
      // so completing it doesn't unlock anything further.
      expect(await nodeMap.read.getPrerequisites([16n])).to.deep.equal([2n]);
      expect(await nodeMap.read.getPrerequisites([21n])).to.deep.equal([
        20n,
      ]);
      for (let nodeId = 1n; nodeId <= 30n; nodeId++) {
        const prereqs = (await nodeMap.read.getPrerequisites([
          nodeId,
        ])) as bigint[];
        expect(prereqs).to.not.deep.include(21n);
      }

      // Node 25 (f01) is reachable either the "long way" — the full
      // 13-mission mainline stretch m03-m15 (ids 3-15) — or via the
      // 3-mission shortcut s01-s03 (ids 22-24), which also branches off
      // m02. ANY-of prerequisite semantics mean beating node 24 (s03)
      // alone unlocks node 25, skipping the rest of the mainline entirely.
      expect(await nodeMap.read.getPrerequisites([22n])).to.deep.equal([2n]);
      expect(await nodeMap.read.getPrerequisites([25n])).to.deep.equal([
        15n,
        24n,
      ]);

      expect(
        await nodeMap.read.isNodeUnlocked([human.account.address, 25n]),
      ).to.equal(false);
    });
  });

  describe("AI behavior archetypes", function () {
    async function getAITurnTakenEvents(publicClient: any, abi: any, hash: any) {
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      return parseEventLogs({ abi, logs: receipt.logs, eventName: "AITurnTaken" });
    }

    // Shared setup: curate a node against mapId, mint/construct the human's
    // ship, and enter the match. Returns the started match's gameId.
    async function startMatch(
      nodeMap: any,
      ships: any,
      randomManager: any,
      humanShips: any,
      humanSinglePlayerMatch: any,
      human: any,
      mapId: bigint,
    ) {
      const nodeId = await createCampaignNode(nodeMap, mapId);
      await purchaseAndConstructHumanShip(ships, randomManager, humanShips, human);
      await humanSinglePlayerMatch.write.startNodeMatch([
        nodeId,
        [1n],
        [{ row: 0, col: 0 }],
      ]);
      return NODE_MATCH_ID_OFFSET + 1n;
    }

    it("Aggressor archetype shoots an enemy in range", async function () {
      const {
        ships,
        game,
        maps,
        nodeMap,
        aiEncounters,
        randomManager,
        humanShips,
        humanGame,
        humanSinglePlayerMatch,
        singlePlayerMatchOther,
        singlePlayerMatch,
        human,
        owner,
        publicClient,
      } = await loadFixture(deploySinglePlayerFixture);

      await maps.write.createPresetMap([[], MapMode.Both]);
      const mapId = await maps.read.mapCount();
      await aiEncounters.write.createAIShipConfig([
        "Aggressor Ship",
        defaultEquipment, // Generic, range 3
        defaultTraits,
        1, // Aggressor
      ]);
      const configId = await aiEncounters.read.aiShipConfigCount();
      await aiEncounters.write.setMapPlacement([mapId, 0, 16, configId]);

      const gameId = await startMatch(
        nodeMap,
        ships,
        randomManager,
        humanShips,
        humanSinglePlayerMatch,
        human,
        mapId,
      );

      const aiShipId = AI_SHIP_ID_OFFSET + 1n;
      await setShipPosition(game.address, gameId, 1n, 0, 14);
      await humanGame.write.moveShip([gameId, 1n, 0, 14, ActionType.Pass, 0n], {
        account: human.account,
      });

      const hash = await singlePlayerMatchOther.write.takeAITurn([gameId]);
      const events = await getAITurnTakenEvents(
        publicClient,
        singlePlayerMatch.abi,
        hash,
      );
      const ev = events.find((e: any) => e.args.shipId === aiShipId);
      expect(ev).to.not.be.undefined;
      expect(ev!.args.actionType).to.equal(ActionType.Shoot);
      expect(ev!.args.targetShipId).to.equal(1n);
    });

    it("Variant 1 Sniper backs off to its maximum range and still shoots, rather than staying adjacent", async function () {
      const {
        ships,
        game,
        maps,
        nodeMap,
        aiEncounters,
        randomManager,
        humanShips,
        humanGame,
        humanSinglePlayerMatch,
        singlePlayerMatchOther,
        singlePlayerMatch,
        human,
        owner,
        publicClient,
      } = await loadFixture(deploySinglePlayerFixture);

      await maps.write.createPresetMap([[], MapMode.Both]);
      const mapId = await maps.read.mapCount();
      await aiEncounters.write.createAIShipConfig([
        "Sniper Ship",
        defaultEquipment,
        defaultTraits,
        2, // Sniper
      ]);
      const configId = await aiEncounters.read.aiShipConfigCount();
      await aiEncounters.write.setMapPlacement([mapId, 0, 16, configId]);

      const gameId = await startMatch(
        nodeMap,
        ships,
        randomManager,
        humanShips,
        humanSinglePlayerMatch,
        human,
        mapId,
      );

      const aiShipId = AI_SHIP_ID_OFFSET + 1n;
      // Reposition both ships (away from the fixed fleet-setup corner) so
      // there's room to observe a retreat: Sniper at (5,10), enemy adjacent
      // at (5,9). Laser range is 3, so the variant-1 skirmisher backs off two
      // tiles to (5,12) — exactly maximum range from (5,9) — and fires from there.
      await setShipPosition(game.address, gameId, aiShipId, 5, 10);
      await setShipPosition(game.address, gameId, 1n, 5, 9);
      await humanGame.write.moveShip([gameId, 1n, 5, 9, ActionType.Pass, 0n], {
        account: human.account,
      });

      const hash = await singlePlayerMatchOther.write.takeAITurn([gameId]);
      const events = await getAITurnTakenEvents(
        publicClient,
        singlePlayerMatch.abi,
        hash,
      );
      const ev = events.find((e: any) => e.args.shipId === aiShipId);
      expect(ev).to.not.be.undefined;
      expect(ev!.args.actionType).to.equal(ActionType.Shoot);
      expect(ev!.args.targetShipId).to.equal(1n);

      const gameData = (await game.read.getGame([gameId])) as GameDataView;
      const pos = findShipPosition(gameData, aiShipId);
      // Backed off to maximum range (3 from the enemy at col 9), same row.
      expect(pos.row).to.equal(5);
      expect(pos.col).to.equal(12);
    });

    it("Variant 1 Sniper shoots without moving when the enemy is already at its maximum range", async function () {
      const {
        ships,
        game,
        maps,
        nodeMap,
        aiEncounters,
        randomManager,
        humanShips,
        humanGame,
        humanSinglePlayerMatch,
        singlePlayerMatchOther,
        singlePlayerMatch,
        human,
        owner,
        publicClient,
      } = await loadFixture(deploySinglePlayerFixture);

      await maps.write.createPresetMap([[], MapMode.Both]);
      const mapId = await maps.read.mapCount();
      await aiEncounters.write.createAIShipConfig([
        "Sniper Ship",
        defaultEquipment,
        defaultTraits,
        2, // Sniper
      ]);
      const configId = await aiEncounters.read.aiShipConfigCount();
      await aiEncounters.write.setMapPlacement([mapId, 0, 16, configId]);

      const gameId = await startMatch(
        nodeMap,
        ships,
        randomManager,
        humanShips,
        humanSinglePlayerMatch,
        human,
        mapId,
      );

      const aiShipId = AI_SHIP_ID_OFFSET + 1n;
      // Laser range is 3: an enemy at (5,7) is exactly at maximum range from
      // (5,10), so there is nothing to gain by moving.
      await setShipPosition(game.address, gameId, aiShipId, 5, 10);
      await setShipPosition(game.address, gameId, 1n, 5, 7);
      await humanGame.write.moveShip([gameId, 1n, 5, 7, ActionType.Pass, 0n], {
        account: human.account,
      });

      const hash = await singlePlayerMatchOther.write.takeAITurn([gameId]);
      const events = await getAITurnTakenEvents(
        publicClient,
        singlePlayerMatch.abi,
        hash,
      );
      const ev = events.find((e: any) => e.args.shipId === aiShipId);
      expect(ev).to.not.be.undefined;
      expect(ev!.args.actionType).to.equal(ActionType.Shoot);
      expect(ev!.args.targetShipId).to.equal(1n);

      const gameData = (await game.read.getGame([gameId])) as GameDataView;
      const pos = findShipPosition(gameData, aiShipId);
      expect(pos.row).to.equal(5);
      expect(pos.col).to.equal(10);
    });

    it("Support archetype heals the weakest ally over shooting an available enemy", async function () {
      const {
        ships,
        game,
        maps,
        nodeMap,
        aiEncounters,
        randomManager,
        humanShips,
        humanGame,
        humanSinglePlayerMatch,
        singlePlayerMatchOther,
        singlePlayerMatch,
        human,
        owner,
        publicClient,
      } = await loadFixture(deploySinglePlayerFixture);

      await maps.write.createPresetMap([[], MapMode.Both]);
      const mapId = await maps.read.mapCount();

      // Scan order (row-major, col 13->16) mints the col-15 placement
      // before col-16, so the healer ends up with the lower shipId and
      // acts first — before the (deliberately 0-HP) ally would otherwise
      // get stuck retrying an illegal turn of its own.
      await aiEncounters.write.createAIShipConfig([
        "Healer",
        { mainWeapon: 0, armor: 0, shields: 0, special: 2 }, // Generic/.../RepairDrones
        defaultTraits,
        3, // Support
      ]);
      const healerConfigId = await aiEncounters.read.aiShipConfigCount();
      await aiEncounters.write.createAIShipConfig([
        "Ally",
        defaultEquipment,
        defaultTraits,
        0, // Grunt
      ]);
      const allyConfigId = await aiEncounters.read.aiShipConfigCount();
      await aiEncounters.write.setMapPlacements([
        mapId,
        [
          { row: 0, col: 15 },
          { row: 0, col: 16 },
        ],
        [healerConfigId, allyConfigId],
      ]);

      const gameId = await startMatch(
        nodeMap,
        ships,
        randomManager,
        humanShips,
        humanSinglePlayerMatch,
        human,
        mapId,
      );

      const healerShipId = AI_SHIP_ID_OFFSET + 1n;
      const allyShipId = AI_SHIP_ID_OFFSET + 2n;

      await setShipHullPointsToZero(game.address, gameId, allyShipId);
      await setShipPosition(game.address, gameId, 1n, 0, 13);
      await humanGame.write.moveShip([gameId, 1n, 0, 13, ActionType.Pass, 0n], {
        account: human.account,
      });

      const hash = await singlePlayerMatchOther.write.takeAITurn([gameId]);
      const events = await getAITurnTakenEvents(
        publicClient,
        singlePlayerMatch.abi,
        hash,
      );
      const ev = events.find((e: any) => e.args.shipId === healerShipId);
      expect(ev).to.not.be.undefined;
      expect(ev!.args.actionType).to.equal(ActionType.Special);
      expect(ev!.args.targetShipId).to.equal(allyShipId);

      const allyAttrs = await game.read.getShipAttributes([gameId, allyShipId]);
      expect(allyAttrs.hullPoints).to.be.greaterThan(0);
    });

    it("variant 2 Support ships heal with the repair faction ability, never with an equipped special", async function () {
      const {
        ships,
        game,
        maps,
        nodeMap,
        aiEncounters,
        randomManager,
        humanShips,
        humanGame,
        humanSinglePlayerMatch,
        singlePlayerMatchOther,
        singlePlayerMatch,
        human,
        publicClient,
      } = await loadFixture(deploySinglePlayerFixture);

      await maps.write.createPresetMap([[], MapMode.Both]);
      const mapId = await maps.read.mapCount();

      // Variant 2's AI knows every ship has the repair faction ability and
      // that none of its equipped specials heal. This healer equips slot 2 —
      // variant 1's RepairDrones slot, but variant 2's DroneSwarm (an attack
      // special) — so a slot-only "slot 2 is the healer" check would wrongly
      // try to heal with it as a Special. Variant 2's tree must use the
      // faction ability instead.
      const variant2Traits = { ...defaultTraits, variant: 2 };
      await aiEncounters.write.createAIShipConfig([
        "Variant 2 Healer",
        { mainWeapon: 0, armor: 0, shields: 0, special: 2 },
        variant2Traits,
        3, // Support
      ]);
      const healerConfigId = await aiEncounters.read.aiShipConfigCount();
      await aiEncounters.write.createAIShipConfig([
        "Variant 2 Ally",
        defaultEquipment,
        variant2Traits,
        0, // Grunt
      ]);
      const allyConfigId = await aiEncounters.read.aiShipConfigCount();
      await aiEncounters.write.setMapPlacements([
        mapId,
        [
          { row: 0, col: 15 },
          { row: 0, col: 16 },
        ],
        [healerConfigId, allyConfigId],
      ]);

      const gameId = await startMatch(
        nodeMap,
        ships,
        randomManager,
        humanShips,
        humanSinglePlayerMatch,
        human,
        mapId,
      );

      const healerShipId = AI_SHIP_ID_OFFSET + 1n;
      const allyShipId = AI_SHIP_ID_OFFSET + 2n;

      await setShipHullPointsToZero(game.address, gameId, allyShipId);
      await setShipPosition(game.address, gameId, 1n, 0, 13);
      await humanGame.write.moveShip([gameId, 1n, 0, 13, ActionType.Pass, 0n], {
        account: human.account,
      });

      const hash = await singlePlayerMatchOther.write.takeAITurn([gameId]);
      const events = await getAITurnTakenEvents(
        publicClient,
        singlePlayerMatch.abi,
        hash,
      );
      const ev = events.find((e: any) => e.args.shipId === healerShipId);
      expect(ev).to.not.be.undefined;
      expect(ev!.args.actionType).to.equal(ActionType.FactionAbility);
      expect(ev!.args.targetShipId).to.equal(allyShipId);

      const allyAttrs = await game.read.getShipAttributes([gameId, allyShipId]);
      expect(allyAttrs.hullPoints).to.be.greaterThan(0);
    });

    it("passes (emitting AIDecisionFailed) instead of freezing when an AI ship's AI contract can't decide (HA6-12)", async function () {
      const {
        ships,
        game,
        maps,
        nodeMap,
        aiEncounters,
        aiBehaviorRegistry,
        randomManager,
        humanShips,
        humanGame,
        humanSinglePlayerMatch,
        singlePlayerMatchOther,
        human,
      } = await loadFixture(deploySinglePlayerFixture);

      await maps.write.createPresetMap([[], MapMode.Both]);
      const mapId = await maps.read.mapCount();
      await aiEncounters.write.createAIShipConfig([
        "Grunt Ship",
        defaultEquipment,
        defaultTraits, // variant 1
        0, // Grunt
      ]);
      const configId = await aiEncounters.read.aiShipConfigCount();
      await aiEncounters.write.setMapPlacement([mapId, 0, 16, configId]);

      // Register a "broken" AI for variant 1 before the match: a contract
      // with no decide() (AIEncounters itself), so every decide reverts.
      // AI ships pin their AI at mint (HA6-18), so it must be set up front.
      await aiBehaviorRegistry.write.setVariantAI([1, aiEncounters.address]);

      const gameId = await startMatch(
        nodeMap,
        ships,
        randomManager,
        humanShips,
        humanSinglePlayerMatch,
        human,
        mapId,
      );

      await setShipPosition(game.address, gameId, 1n, 0, 15);
      await humanGame.write.moveShip([gameId, 1n, 0, 15, ActionType.Pass, 0n], {
        account: human.account,
      });

      // This used to revert on every takeAITurn, leaving the game stuck on
      // the AI's turn forever; now the ship passes and the failure is
      // still loud via an event.
      const hash = await singlePlayerMatchOther.write.takeAITurn([gameId]);
      const publicClient = await hre.viem.getPublicClient();
      const receipt = await publicClient.getTransactionReceipt({ hash });
      const logs = parseEventLogs({
        abi: singlePlayerMatchOther.abi,
        logs: receipt.logs,
      });
      const failed = logs.find((l: any) => l.eventName === "AIDecisionFailed");
      expect(failed).to.not.be.undefined;
      const taken = logs.find((l: any) => l.eventName === "AITurnTaken") as any;
      expect(taken.args.actionType).to.equal(ActionType.Pass);
      expect((await humanGame.read.getGame([gameId])).metadata.ended).to.equal(
        false,
      );
    });

    it("keeps each AI ship on the AI it was minted with, even if the registry entry changes mid-match (HA6-18)", async function () {
      const {
        ships,
        game,
        maps,
        nodeMap,
        aiEncounters,
        aiBehaviorRegistry,
        randomManager,
        humanShips,
        humanGame,
        humanSinglePlayerMatch,
        singlePlayerMatchOther,
        human,
      } = await loadFixture(deploySinglePlayerFixture);

      await maps.write.createPresetMap([[], MapMode.Both]);
      const mapId = await maps.read.mapCount();
      await aiEncounters.write.createAIShipConfig([
        "Grunt Ship",
        defaultEquipment,
        defaultTraits,
        0,
      ]);
      const configId = await aiEncounters.read.aiShipConfigCount();
      await aiEncounters.write.setMapPlacement([mapId, 0, 16, configId]);
      const gameId = await startMatch(
        nodeMap,
        ships,
        randomManager,
        humanShips,
        humanSinglePlayerMatch,
        human,
        mapId,
      );
      await setShipPosition(game.address, gameId, 1n, 0, 15);
      await humanGame.write.moveShip([gameId, 1n, 0, 15, ActionType.Pass, 0n], {
        account: human.account,
      });

      // Swap variant 1's registry entry mid-match: this match's AI ship
      // keeps deciding with the AI it was minted with.
      await aiBehaviorRegistry.write.setVariantAI([1, aiEncounters.address]);
      const hash = await singlePlayerMatchOther.write.takeAITurn([gameId]);
      const publicClient = await hre.viem.getPublicClient();
      const receipt = await publicClient.getTransactionReceipt({ hash });
      const logs = parseEventLogs({
        abi: singlePlayerMatchOther.abi,
        logs: receipt.logs,
      });
      expect(logs.find((l: any) => l.eventName === "AIDecisionFailed")).to.be
        .undefined;
    });

    it("fails at match start when an AI ship's variant has no registered AI (HA6-18)", async function () {
      const {
        ships,
        maps,
        nodeMap,
        aiEncounters,
        aiBehaviorRegistry,
        randomManager,
        humanShips,
        humanSinglePlayerMatch,
        human,
      } = await loadFixture(deploySinglePlayerFixture);

      await maps.write.createPresetMap([[], MapMode.Both]);
      const mapId = await maps.read.mapCount();
      await aiEncounters.write.createAIShipConfig([
        "Grunt Ship",
        defaultEquipment,
        defaultTraits,
        0,
      ]);
      const configId = await aiEncounters.read.aiShipConfigCount();
      await aiEncounters.write.setMapPlacement([mapId, 0, 16, configId]);
      await aiBehaviorRegistry.write.setVariantAI([
        1,
        "0x0000000000000000000000000000000000000000",
      ]);

      await expect(
        startMatch(
          nodeMap,
          ships,
          randomManager,
          humanShips,
          humanSinglePlayerMatch,
          human,
          mapId,
        ),
      ).to.be.rejectedWith("NoAIForVariant");
    });

    it("Turtle archetype moves toward an unclaimed scoring tile when no enemy is in range", async function () {
      const {
        ships,
        game,
        maps,
        nodeMap,
        aiEncounters,
        randomManager,
        humanShips,
        humanGame,
        humanSinglePlayerMatch,
        singlePlayerMatchOther,
        singlePlayerMatch,
        human,
        owner,
        publicClient,
      } = await loadFixture(deploySinglePlayerFixture);

      await maps.write.createPresetScoringMap([
        [{ row: 0, col: 13, points: 5, onlyOnce: false }],
        MapMode.Both,
      ]);
      const mapId = await maps.read.mapCount();
      await aiEncounters.write.createAIShipConfig([
        "Turtle Ship",
        defaultEquipment,
        defaultTraits,
        4, // Turtle
      ]);
      const configId = await aiEncounters.read.aiShipConfigCount();
      await aiEncounters.write.setMapPlacement([mapId, 0, 16, configId]);

      const gameId = await startMatch(
        nodeMap,
        ships,
        randomManager,
        humanShips,
        humanSinglePlayerMatch,
        human,
        mapId,
      );

      const aiShipId = AI_SHIP_ID_OFFSET + 1n;
      // Keep the human ship far away, out of any plausible gun range.
      await setShipPosition(game.address, gameId, 1n, 10, 0);
      await humanGame.write.moveShip([gameId, 1n, 10, 0, ActionType.Pass, 0n], {
        account: human.account,
      });

      const beforeData = (await game.read.getGame([gameId])) as GameDataView;
      const before = findShipPosition(beforeData, aiShipId);

      const hash = await singlePlayerMatchOther.write.takeAITurn([gameId]);
      const events = await getAITurnTakenEvents(
        publicClient,
        singlePlayerMatch.abi,
        hash,
      );
      const ev = events.find((e: any) => e.args.shipId === aiShipId);
      expect(ev).to.not.be.undefined;
      expect(ev!.args.actionType).to.equal(ActionType.Pass);

      const afterData = (await game.read.getGame([gameId])) as GameDataView;
      const after = findShipPosition(afterData, aiShipId);
      const distBefore = Math.abs(before.row - 0) + Math.abs(before.col - 13);
      const distAfter = Math.abs(after.row - 0) + Math.abs(after.col - 13);
      expect(distAfter).to.be.lessThan(distBefore);
    });

    it("stops adjacent to a scoring tile already held by an enemy, instead of attempting an illegal move onto it", async function () {
      const {
        ships,
        game,
        maps,
        nodeMap,
        aiEncounters,
        randomManager,
        humanShips,
        humanGame,
        humanSinglePlayerMatch,
        singlePlayerMatchOther,
        singlePlayerMatch,
        human,
        publicClient,
      } = await loadFixture(deploySinglePlayerFixture);

      // A lone scoring tile that an ENEMY is standing on. A Turtle heads for
      // the tile (there is nothing else to score) — the shared "step toward"
      // primitive now checks reachability (occupancy + enemy-path-blocking,
      // 2026-09-26) at each candidate distance, backing off to the nearest
      // tile short of the occupied one instead of walking straight onto the
      // enemy's own square. Before that fix, this same scenario produced an
      // illegal move Game.sol correctly rejected, caught by
      // SinglePlayerMatch's try/catch fallback to a same-tile Pass (see git
      // history for that version of this test) — now the stepping primitive
      // gets it right on the first try, no fallback needed. (The Plasma
      // Cannon's range of 2 keeps the enemy out of gun range from the
      // Turtle's starting tile, so no shot preempts the move.)
      await maps.write.createPresetScoringMap([
        [{ row: 5, col: 7, points: 5, onlyOnce: false }],
        MapMode.Both,
      ]);
      const mapId = await maps.read.mapCount();
      await aiEncounters.write.createAIShipConfig([
        "Plasma Turtle",
        { mainWeapon: 3, armor: 0, shields: 0, special: 0 },
        defaultTraits,
        4, // Turtle
      ]);
      const configId = await aiEncounters.read.aiShipConfigCount();
      await aiEncounters.write.setMapPlacement([mapId, 0, 16, configId]);

      const gameId = await startMatch(
        nodeMap,
        ships,
        randomManager,
        humanShips,
        humanSinglePlayerMatch,
        human,
        mapId,
      );

      const aiShipId = AI_SHIP_ID_OFFSET + 1n;
      await setShipPosition(game.address, gameId, aiShipId, 5, 10);
      await setShipPosition(game.address, gameId, 1n, 5, 7);
      await humanGame.write.moveShip([gameId, 1n, 5, 7, ActionType.Pass, 0n], {
        account: human.account,
      });

      // Must not throw/revert.
      const hash = await singlePlayerMatchOther.write.takeAITurn([gameId]);
      const events = await getAITurnTakenEvents(
        publicClient,
        singlePlayerMatch.abi,
        hash,
      );
      const ev = events.find((e: any) => e.args.shipId === aiShipId);
      expect(ev).to.not.be.undefined;
      expect(ev!.args.actionType).to.equal(ActionType.Pass);
      expect(ev!.args.targetShipId).to.equal(0n);

      const gameData = (await game.read.getGame([gameId])) as GameDataView;
      const pos = findShipPosition(gameData, aiShipId);
      expect(pos.row).to.equal(5);
      // Moved from (5,10) to (5,8) — one tile short of the enemy-occupied
      // (5,7) — rather than staying put at (5,10) the way the old,
      // occupancy-blind stepping primitive did.
      expect(pos.col).to.equal(8);
    });

    it("skips a 0-HP ship and moves the next one instead of getting stuck (regression: this used to deadlock the whole match)", async function () {
      const {
        ships,
        game,
        maps,
        nodeMap,
        aiEncounters,
        randomManager,
        humanShips,
        humanGame,
        humanSinglePlayerMatch,
        singlePlayerMatchOther,
        singlePlayerMatch,
        human,
        owner,
        publicClient,
      } = await loadFixture(deploySinglePlayerFixture);

      // Two AI ships on this map instead of one, so there's a live ship
      // behind the zeroed-out one for the AI to reach.
      await maps.write.createPresetMap([[], MapMode.Both]);
      const mapId = await maps.read.mapCount();
      await aiEncounters.write.createAIShipConfig([
        "AI Grunt A",
        defaultEquipment,
        defaultTraits,
        defaultArchetype,
      ]);
      const config1 = await aiEncounters.read.aiShipConfigCount();
      await aiEncounters.write.createAIShipConfig([
        "AI Grunt B",
        defaultEquipment,
        defaultTraits,
        defaultArchetype,
      ]);
      const config2 = await aiEncounters.read.aiShipConfigCount();
      await aiEncounters.write.setMapPlacements([
        mapId,
        [
          { row: 0, col: 16 },
          { row: 1, col: 16 },
        ],
        [config1, config2],
      ]);

      const gameId = await startMatch(
        nodeMap,
        ships,
        randomManager,
        humanShips,
        humanSinglePlayerMatch,
        human,
        mapId,
      );

      const deadAiShipId = AI_SHIP_ID_OFFSET + 1n;
      const liveAiShipId = AI_SHIP_ID_OFFSET + 2n;

      // Human passes in place, handing the turn to the AI
      await humanGame.write.moveShip(
        [gameId, 1n, 0, 0, ActionType.Pass, 0n],
        { account: human.account },
      );

      // Simulate the first AI ship having already been shot down to 0 HP
      // (mid reactor-critical grace period, not yet removed) — exactly the
      // state that used to permanently deadlock the AI's turn, since
      // _findUnmovedShip always picked this ship first (it's the first
      // unmoved ship in joinerActiveShipIds) and it could never
      // successfully move (moveShip reverts ShipDestroyed for any
      // non-Retreat action at 0 HP), so it never entered
      // joinerMovedShipIds and every other ship behind it was unreachable.
      await setShipHullPointsToZero(game.address, gameId, deadAiShipId);

      const preGameData = (await game.read.getGame([gameId])) as GameDataView;
      const preRound = preGameData.turnState.currentRound;

      // Must not get stuck: the AI should skip the dead ship and
      // successfully move the live one instead. This was the human's ship
      // (1), the AI's dead ship (accounted for via shipsWithZeroHP, no
      // move needed) and the AI's live ship (7) — every active ship this
      // round, so a successful move here also completes the round, which
      // is the clearest possible proof the deadlock is gone: before this
      // fix, this call would silently do nothing and the round (and the
      // whole match) would never progress past this point.
      const hash = await singlePlayerMatchOther.write.takeAITurn([gameId]);
      const events = await getAITurnTakenEvents(
        publicClient,
        singlePlayerMatch.abi,
        hash,
      );
      expect(events.length).to.equal(1);
      const ev = events.find((e: any) => e.args.shipId === liveAiShipId);
      expect(ev).to.not.be.undefined;

      const gameData = (await game.read.getGame([gameId])) as GameDataView;
      expect(gameData.turnState.currentRound).to.equal(preRound + 1n);
    });

    it("surrenders (human wins) when every one of the AI's ships is at 0 HP", async function () {
      const {
        ships,
        game,
        maps,
        nodeMap,
        aiEncounters,
        randomManager,
        humanShips,
        humanGame,
        humanSinglePlayerMatch,
        singlePlayerMatchOther,
        human,
        owner,
      } = await loadFixture(deploySinglePlayerFixture);

      const mapId = await setupBasicAIEncounter(maps, aiEncounters);

      const gameId = await startMatch(
        nodeMap,
        ships,
        randomManager,
        humanShips,
        humanSinglePlayerMatch,
        human,
        mapId,
      );

      const aiShipId = AI_SHIP_ID_OFFSET + 1n;

      // Human passes in place, handing the turn to the AI
      await humanGame.write.moveShip(
        [gameId, 1n, 0, 0, ActionType.Pass, 0n],
        { account: human.account },
      );

      // The AI's only ship is at 0 HP -- it has nothing left it can
      // meaningfully do (its only legal action, Retreat, isn't a decision
      // worth making — see takeAITurn's comment), so it should surrender
      // rather than deadlock the match.
      await setShipHullPointsToZero(game.address, gameId, aiShipId);

      await singlePlayerMatchOther.write.takeAITurn([gameId]);

      const gameData = (await game.read.getGame([gameId])) as GameDataView;
      expect(gameData.metadata.ended).to.equal(true);
      expect(gameData.metadata.winner.toLowerCase()).to.equal(
        human.account.address.toLowerCase(),
      );
    });
  });

  describe("Node completion", function () {
    it("records the node as completed for the human when they win, and unlocks a node that requires it", async function () {
      const {
        ships,
        game,
        maps,
        nodeMap,
        aiEncounters,
        randomManager,
        humanShips,
        humanGame,
        humanSinglePlayerMatch,
        singlePlayerMatchOther,
        human,
        owner,
      } = await loadFixture(deploySinglePlayerFixture);

      const mapId = await setupBasicAIEncounter(maps, aiEncounters);
      const nodeId = await createCampaignNode(nodeMap, mapId);
      const nextMapId = await setupBasicAIEncounter(maps, aiEncounters);
      const nextNodeId = await createCampaignNode(nodeMap, nextMapId, [
        nodeId,
      ]);

      expect(
        await nodeMap.read.isNodeUnlocked([human.account.address, nextNodeId]),
      ).to.equal(false);

      await purchaseAndConstructHumanShip(ships, randomManager, humanShips, human);
      await humanSinglePlayerMatch.write.startNodeMatch([
        nodeId,
        [1n],
        [{ row: 0, col: 0 }],
      ]);
      const gameId = NODE_MATCH_ID_OFFSET + 1n;

      await humanGame.write.moveShip(
        [gameId, 1n, 0, 0, ActionType.Pass, 0n],
        { account: human.account },
      );
      await setShipHullPointsToZero(
        game.address,
        gameId,
        AI_SHIP_ID_OFFSET + 1n,
      );
      await singlePlayerMatchOther.write.takeAITurn([gameId]);

      expect(
        await nodeMap.read.isNodeCompleted([human.account.address, nodeId]),
      ).to.equal(true);
      expect(
        await nodeMap.read.isNodeUnlocked([human.account.address, nextNodeId]),
      ).to.equal(true);
    });

    it("does not record completion when the AI wins", async function () {
      const {
        ships,
        game,
        maps,
        nodeMap,
        aiEncounters,
        randomManager,
        humanShips,
        humanGame,
        humanSinglePlayerMatch,
        singlePlayerMatchOther,
        human,
      } = await loadFixture(deploySinglePlayerFixture);

      const mapId = await setupBasicAIEncounter(maps, aiEncounters);
      const nodeId = await createCampaignNode(nodeMap, mapId);

      await purchaseAndConstructHumanShip(ships, randomManager, humanShips, human);
      await humanSinglePlayerMatch.write.startNodeMatch([
        nodeId,
        [1n],
        [{ row: 0, col: 0 }],
      ]);
      const gameId = NODE_MATCH_ID_OFFSET + 1n;

      // Force the AI to win via the real reactor-critical-timer removal
      // path (debugDestroyShip is gone — see docs/audit-2.md I-01). Human
      // passes first (ship 1 is still full HP here, so Pass is legal and
      // hands the turn to the AI naturally) — priming BEFORE any move would
      // leave the human's only ship unmovable at turn 0 with nothing having
      // ever handed the turn to the AI, a deadlock real gameplay could never
      // reach in the first place. Only after that real move is ship 1 primed
      // for destruction. The AI's own real move then completes round 1;
      // within that same transaction Game.sol's own
      // _incrementReactorCriticalTimerForZeroHPShips takes ship 1's
      // reactorCriticalTimer from 2 to 3 and calls the real
      // _removeShipFromGame, which triggers _checkGameEndCondition ->
      // _endGame with the AI as winner — exactly what debugDestroyShip's
      // instant removal used to produce, just reached through the actual
      // production code path instead of a debug shortcut.
      await humanGame.write.moveShip(
        [gameId, 1n, 0, 0, ActionType.Pass, 0n],
        { account: human.account },
      );
      await primeShipForRealDestruction(game.address, gameId, 1n);
      await singlePlayerMatchOther.write.takeAITurn([gameId]);

      const gameData = (await game.read.getGame([gameId])) as GameDataView;
      expect(gameData.metadata.ended).to.equal(true);
      expect(gameData.metadata.winner.toLowerCase()).to.not.equal(
        human.account.address.toLowerCase(),
      );
      expect(
        await nodeMap.read.isNodeCompleted([human.account.address, nodeId]),
      ).to.equal(false);
    });
  });

  describe("Kill rewards", function () {
    // setTimestampDestroyed is exactly what Game.sol calls mid-combat to
    // attribute a kill — it's also directly callable by ShipsRouter's
    // owner (that's how Game.sol itself is authorized to call it:
    // `msg.sender == owner() || msg.sender == gameAddress`). Using it
    // directly here (via the router, since AI ship ids only resolve
    // through it) tests DestroyRewardLib's UTC-vs-DEC branching without
    // needing to reproduce Game.sol's deterministic-but-opaque damage math
    // just to force a real one-shot kill in combat.
    async function setUpOneAIShip(fixture: any, variant = 1) {
      const {
        ships,
        maps,
        nodeMap,
        aiEncounters,
        randomManager,
        humanShips,
        humanSinglePlayerMatch,
        human,
      } = fixture;

      const mapId = await setupBasicAIEncounter(maps, aiEncounters, variant);
      const nodeId = await createCampaignNode(nodeMap, mapId);

      await purchaseAndConstructHumanShip(ships, randomManager, humanShips, human);
      await humanSinglePlayerMatch.write.startNodeMatch([
        nodeId,
        [1n],
        [{ row: 0, col: 0 }],
      ]);

      return {
        gameId: NODE_MATCH_ID_OFFSET + 1n,
        humanShipId: 1n,
        aiShipId: AI_SHIP_ID_OFFSET + 1n,
      };
    }

    it("pays the human DEC (not UTC) for destroying an AI-owned ship", async function () {
      const fixture = await loadFixture(deploySinglePlayerFixture);
      const { ships, shipsRouter, universalCredits, droneEnergyCores, owner, human } =
        fixture;
      // Variant 2 -- production's FactionRewardTokenRegistry registers DEC
      // for variant 2 (see DeployAndConfig.ts's setVariant2RewardTokenCall);
      // variant 1 intentionally has no reward token registered.
      const { humanShipId, aiShipId } = await setUpOneAIShip(fixture, 2);

      const [utcBefore, decBefore, recycleReward] = await Promise.all([
        universalCredits.read.balanceOf([human.account.address]),
        droneEnergyCores.read.balanceOf([human.account.address]),
        ships.read.recycleReward(),
      ]);

      await shipsRouter.write.setTimestampDestroyed([aiShipId, humanShipId], {
        account: owner.account,
      });

      const [utcAfter, decAfter] = await Promise.all([
        universalCredits.read.balanceOf([human.account.address]),
        droneEnergyCores.read.balanceOf([human.account.address]),
      ]);

      expect(decAfter - decBefore).to.equal(recycleReward >> 2n);
      expect(utcAfter).to.equal(utcBefore);
    });

    it("mints no UTC when the AI destroys a human ship (HA6-21)", async function () {
      const fixture = await loadFixture(deploySinglePlayerFixture);
      const { universalCredits, shipsRouter, singlePlayerMatch, droneEnergyCores, owner, human } =
        fixture;
      const { humanShipId, aiShipId } = await setUpOneAIShip(fixture);

      await shipsRouter.write.setTimestampDestroyed([humanShipId, aiShipId], {
        account: owner.account,
      });

      // The AI's owner is this orchestrator contract; minting UTC to it
      // only created stuck/unused supply, so nothing is paid.
      expect(
        await universalCredits.read.balanceOf([singlePlayerMatch.address]),
      ).to.equal(0n);
      expect(
        await droneEnergyCores.read.balanceOf([human.account.address]),
      ).to.equal(0n);
    });
  });
});

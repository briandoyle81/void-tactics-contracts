import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers";
import hre from "hardhat";
import { parseEther, getAddress, zeroAddress } from "viem";
import {
  ShipTuple,
  tupleToShip,
  ActionType,
  GameDataView,
  MapMode,
} from "./types";
import DeployModule from "../ignition/modules/DeployAndConfig";
import { setShipPosition } from "./helpers/gameStorage";

// Proves the core claim of the engine-registry plan (2026-09-28): a second
// "engine" (a fresh Game + PvPMatch) can be stood up reusing every piece of
// shared infrastructure this deploy already created — Ships, Fleets, Maps
// (with its ~65 preset maps untouched), ShipAttributes, ShipsRouter,
// GameResults, RandomManager, and every one of the 7 effect resolvers with
// ZERO redeployment or reconfiguration of the resolvers themselves — and
// that a game already running on the first engine keeps working completely
// unaffected once the second engine exists and becomes `currentEngine`.
describe("GameEngineRegistry — in-flight engine upgrades", function () {
  function findShipPosition(gameData: GameDataView, shipId: bigint) {
    for (const p of gameData.shipPositions) {
      if (p.shipId === shipId) return p.position;
    }
    throw new Error(`ship ${shipId} not found`);
  }

  async function deployTwoEngines() {
    const [owner, creatorA, joinerA, creatorB, joinerB] =
      await hre.viem.getWalletClients();
    const publicClient = await hre.viem.getPublicClient();

    const deployed = await hre.ignition.deploy(DeployModule);
    const {
      ships,
      shipsRouter,
      shipAttributes,
      maps,
      fleets,
      gameResults,
      randomManager,
      game: gameA,
      lobbies,
      gameEngineRegistry,
      specialEffectsLib,
      ramResolver,
      repairResolver,
      empResolver,
      repairDronesResolver,
      flakArrayResolver,
      electricStormResolver,
      droneSwarmResolver,
    } = deployed;

    const creatorALobbies = await hre.viem.getContractAt(
      "Lobbies",
      lobbies.address,
      { client: { wallet: creatorA } },
    );
    const joinerALobbies = await hre.viem.getContractAt(
      "Lobbies",
      lobbies.address,
      { client: { wallet: joinerA } },
    );

    // --- Engine A: the normal flow, exactly like every other test — Lobbies
    // -> PvPMatch (the deploy's own) -> Game.startGame. This exercises the
    // automatic engineOfGame recording this session wired into PvPMatch.
    await ships.write.purchaseWithFlow(
      [creatorA.account.address, 0n, joinerA.account.address, 1],
      { value: parseEther("4.99") },
    );
    await ships.write.purchaseWithFlow(
      [joinerA.account.address, 0n, creatorA.account.address, 1],
      { value: parseEther("4.99") },
    );
    for (let i = 1; i <= 10; i++) {
      const t = tupleToShip((await ships.read.ships([BigInt(i)])) as ShipTuple);
      await randomManager.write.revealRandomness([t.traits.serialNumber]);
    }
    await ships.write.constructAllMyShips({ account: creatorA.account });
    await ships.write.constructAllMyShips({ account: joinerA.account });

    await creatorALobbies.write.createLobby([
      1000n,
      300n,
      true,
      0n,
      100n,
      zeroAddress,
    ]);
    await joinerALobbies.write.joinLobby([1n]);
    await creatorALobbies.write.createFleet([
      1n,
      [1n],
      [{ row: 5, col: 0 }],
    ]);
    await joinerALobbies.write.createFleet([
      1n,
      [6n],
      [{ row: 5, col: 16 }],
    ]);
    const gameIdA = 1n; // gameId == lobbyId

    // --- Engine B: a brand-new Game + PvPMatch, wired to reuse every shared
    // contract above verbatim. This is the smallest real instance of what a
    // future "ship a gameplay fix" deploy would do.
    const gameB = await hre.viem.deployContract(
      "Game",
      [shipsRouter.address, shipAttributes.address],
      { libraries: { SpecialEffectsLib: specialEffectsLib.address } },
    );
    await gameB.write.setAddresses([
      maps.address,
      fleets.address,
      shipAttributes.address,
      shipsRouter.address,
    ]);

    const pvpMatchB = await hre.viem.deployContract("PvPMatch", [
      gameB.address,
      gameResults.address,
    ]);
    // Stand-in for Lobbies in this test — owner calls startGame directly.
    await pvpMatchB.write.setLobbiesAddress([owner.account.address]);
    await gameB.write.setIsAllowedToStartGames([pvpMatchB.address, true]);

    // Reuse every resolver deployed for engine A, unmodified — the whole
    // point of the msg.sender-based engine-agnostic resolver change.
    await gameB.write.setFactionAbilityResolver([1, ramResolver.address]);
    await gameB.write.setFactionAbilityResolver([2, repairResolver.address]);
    await gameB.write.setSpecialResolver([1, 1, empResolver.address]);
    await gameB.write.setSpecialResolver([1, 2, repairDronesResolver.address]);
    await gameB.write.setSpecialResolver([1, 3, flakArrayResolver.address]);
    await gameB.write.setSpecialResolver([2, 1, electricStormResolver.address]);
    await gameB.write.setSpecialResolver([2, 2, droneSwarmResolver.address]);
    await gameB.write.setMaxSpecialSlot([1, 3]);
    await gameB.write.setMaxSpecialSlot([2, 3]);

    // Authorize the new engine on every shared contract's allowlist.
    await fleets.write.setIsAllowedToManageFleets([gameB.address, true]);
    await fleets.write.setIsAllowedToManageFleets([owner.account.address, true]);
    await maps.write.setIsAllowedGame([gameB.address, true]);
    await shipsRouter.write.setIsAllowedGame([gameB.address, true]);
    await gameResults.write.setIsAllowedRecorder([pvpMatchB.address, true]);

    // Register engine B and make it the one new games should use going
    // forward — engine A's already-started game must be unaffected by this.
    await gameEngineRegistry.write.registerEngine([
      gameB.address,
      "v2-test",
      true,
    ]);
    await gameEngineRegistry.write.setIsAllowedToRecord([
      pvpMatchB.address,
      true,
    ]);
    await pvpMatchB.write.setEngineRegistry([gameEngineRegistry.address]);

    await ships.write.purchaseWithFlow(
      [creatorB.account.address, 0n, joinerB.account.address, 1],
      { value: parseEther("4.99") },
    );
    await ships.write.purchaseWithFlow(
      [joinerB.account.address, 0n, creatorB.account.address, 1],
      { value: parseEther("4.99") },
    );
    for (let i = 11; i <= 20; i++) {
      const t = tupleToShip((await ships.read.ships([BigInt(i)])) as ShipTuple);
      await randomManager.write.revealRandomness([t.traits.serialNumber]);
    }
    await ships.write.constructAllMyShips({ account: creatorB.account });
    await ships.write.constructAllMyShips({ account: joinerB.account });

    const gameIdB = 2n; // arbitrary — independent storage from gameA
    await fleets.write.createFleet(
      [gameIdB, creatorB.account.address, [11n], [{ row: 5, col: 0 }], 1000n, true, 0n],
      { account: owner.account },
    );
    await fleets.write.createFleet(
      [gameIdB, joinerB.account.address, [16n], [{ row: 5, col: 16 }], 1000n, false, 0n],
      { account: owner.account },
    );
    // createFleet returns the new fleet's id, but a write call only gives a
    // tx hash — fleetCount is sequential, so the two fleets just created are
    // fleetCount-1 and fleetCount.
    const fleetCount = await fleets.read.fleetCount();
    const creatorFleetB = fleetCount - 1n;
    const joinerFleetB = fleetCount;

    await pvpMatchB.write.startGame(
      [gameIdB, creatorB.account.address, joinerB.account.address, creatorFleetB, joinerFleetB, true, 300n, 0n, 100n],
      { account: owner.account },
    );

    return {
      gameA,
      gameB,
      gameIdA,
      gameIdB,
      gameEngineRegistry,
      creatorA,
      joinerA,
      creatorB,
      joinerB,
      owner,
      publicClient,
    };
  }

  it("records each game against the engine it actually started on", async function () {
    const { gameA, gameB, gameIdA, gameIdB, gameEngineRegistry } =
      await loadFixture(deployTwoEngines);

    expect(
      getAddress(
        (await gameEngineRegistry.read.engineOfGame([gameIdA])) as string,
      ),
    ).to.equal(getAddress(gameA.address));
    expect(
      getAddress(
        (await gameEngineRegistry.read.engineOfGame([gameIdB])) as string,
      ),
    ).to.equal(getAddress(gameB.address));
    // currentEngine has moved on to B, but A's own recorded game is
    // untouched — this is the whole point.
    expect(getAddress((await gameEngineRegistry.read.currentEngine()) as string)).to.equal(
      getAddress(gameB.address),
    );
  });

  it("engine A's game keeps working normally after engine B is registered and made current", async function () {
    const { gameA, gameIdA, creatorA } = await loadFixture(deployTwoEngines);

    const before = (await gameA.read.getGame([gameIdA])) as unknown as GameDataView;
    const pos = findShipPosition(before, 1n);
    await gameA.write.moveShip(
      [gameIdA, 1n, pos.row, pos.col, ActionType.Pass, 0n],
      { account: creatorA.account },
    );
    const after = (await gameA.read.getGame([gameIdA])) as unknown as GameDataView;
    expect(after.shipPositions.length).to.be.greaterThan(0);
  });

  it("engine B's game works end-to-end on the shared Fleets/Maps/Ships infrastructure", async function () {
    const { gameB, gameIdB, creatorB } = await loadFixture(deployTwoEngines);

    const before = (await gameB.read.getGame([gameIdB])) as unknown as GameDataView;
    const pos = findShipPosition(before, 11n);
    await gameB.write.moveShip(
      [gameIdB, 11n, pos.row, pos.col, ActionType.Pass, 0n],
      { account: creatorB.account },
    );
    const after = (await gameB.read.getGame([gameIdB])) as unknown as GameDataView;
    expect(after.turnState.currentTurn).to.not.equal(creatorB.account.address);
  });

  it("engine B resolves a Shoot action using the SAME core combat path as engine A (no per-engine combat code)", async function () {
    const { gameB, gameIdB, creatorB, joinerB } = await loadFixture(deployTwoEngines);

    // Place both ships adjacent directly (their default spawn columns are
    // 15+ tiles apart, far beyond any ship's movement stat) — proves Game
    // B's own _performShoot/_validateShootTarget (and the shared
    // Maps.hasMapsAvoidingShips it calls into) works independently of
    // engine A.
    await setShipPosition(gameB.address, gameIdB, 11n, 5, 8);
    await setShipPosition(gameB.address, gameIdB, 16n, 5, 9);

    await gameB.write.moveShip(
      [gameIdB, 11n, 5, 8, ActionType.Shoot, 16n],
      { account: creatorB.account },
    );

    const after = (await gameB.read.getGame([gameIdB])) as unknown as GameDataView;
    const idx = after.shipIds.findIndex((id) => id === 16n);
    expect(idx).to.not.equal(-1);
    expect(after.shipAttributes[idx].hullPoints).to.be.lessThan(
      after.shipAttributes[idx].maxHullPoints,
    );
  });

  // HA4-01 regression (docs/audit-2.md): a second SinglePlayerMatch's
  // nodeMatchCount starts fresh at 0, so without engineIndex its first game
  // would compute the exact same gameId as the first instance's first game
  // — colliding in GameEngineRegistry.engineOfGame (one mapping shared
  // across every engine) and reverting the whole startNodeMatch transaction,
  // unconditionally, the moment a second single-player engine is ever used.
  // Deliberately reuses the SAME Game/Fleets/AIShips/Maps/NodeMap/
  // AIEncounters as the deploy's own SinglePlayerMatch — this isolates the
  // test to the gameId-uniqueness mechanism itself, not a full second
  // engine stack (already covered by the PvP tests above).
  describe("HA4-01: two SinglePlayerMatch instances never collide", function () {
    const defaultTraits = {
      serialNumber: 0n,
      colors: { h1: 0, s1: 0, l1: 0, h2: 0, s2: 0, l2: 0, h3: 0, s3: 0, l3: 0 },
      variant: 1,
      accuracy: 0,
      hull: 0,
      speed: 0,
    };
    const defaultEquipment = { mainWeapon: 0, armor: 0, shields: 0, special: 0 };
    const defaultArchetype = 0; // Grunt
    const NODE_MATCH_ID_OFFSET = 2n ** 40n;
    const ENGINE_ID_BLOCK_SIZE = 2n ** 64n;

    it("both instances' first-ever game gets a distinct gameId, and both record cleanly in the registry", async function () {
      const [owner, humanA, humanB] = await hre.viem.getWalletClients();
      const deployed = await hre.ignition.deploy(DeployModule);
      const {
        ships,
        aiShips,
        game,
        maps,
        nodeMap,
        fleets,
        aiEncounters,
        randomManager,
        gameEngineRegistry,
        singlePlayerMatch: spmA, // engineIndex 0, the deploy's own instance
        lobbies,
        aiBehaviorRegistry,
      } = deployed;

      // A second SinglePlayerMatch, engineIndex 1, reusing every other
      // shared contract verbatim.
      const spmB = await hre.viem.deployContract("SinglePlayerMatch", [
        aiShips.address,
        lobbies.address,
        game.address,
        aiEncounters.address,
        maps.address,
        nodeMap.address,
        fleets.address,
        1n, // engineIndex
      ]);
      await game.write.setIsAllowedToStartGames([spmB.address, true]);
      await fleets.write.setIsAllowedToManageFleets([spmB.address, true]);
      await aiShips.write.setIsAllowedToCreateShips([spmB.address, true]);
      await spmB.write.setEngineRegistry([gameEngineRegistry.address]);
      // A new engine needs its AI registry wired: AI ships pin their AI
      // contract at mint, so startNodeMatch fails loudly without one
      // (docs/audit-3.md HA6-18).
      await spmB.write.setAIRegistryAddress([aiBehaviorRegistry.address]);
      await gameEngineRegistry.write.setIsAllowedToRecord([spmB.address, true]);

      // One shared map/AI-config/campaign node, reused by both matches —
      // the point under test is the orchestrator's own gameId scheme, not
      // per-map content.
      await maps.write.createPresetMap([[], MapMode.Both]);
      const mapId = await maps.read.mapCount();
      await aiEncounters.write.createAIShipConfig([
        "AI Ship",
        defaultEquipment,
        { ...defaultTraits, variant: 1 },
        defaultArchetype,
      ]);
      const configId = await aiEncounters.read.aiShipConfigCount();
      await aiEncounters.write.setMapPlacement([mapId, 0, 16, configId]);
      // A fresh campaign (not the deploy-seeded "mainCampaign", id 1, which
      // has a required variant set) — humanB's randomly-generated ship
      // otherwise has a real chance of not matching it and reverting
      // WrongCampaignVariant, unrelated to what this test is actually
      // checking.
      await nodeMap.write.createCampaign();
      const campaignId = await nodeMap.read.campaignCount();
      await nodeMap.write.createNode([
        campaignId,
        mapId,
        [],
        2000n,
        86400n,
        20n,
        true,
      ]);
      const nodeId = await nodeMap.read.nodeCount();

      async function purchaseAndConstructHumanShip(human: any, startId: number) {
        await ships.write.purchaseWithFlow(
          [human.account.address, 0n, human.account.address, 1],
          { value: parseEther("4.99") },
        );
        for (let i = startId; i < startId + 5; i++) {
          const t = tupleToShip((await ships.read.ships([BigInt(i)])) as ShipTuple);
          await randomManager.write.revealRandomness([t.traits.serialNumber]);
        }
        await ships.write.constructAllMyShips({ account: human.account });
      }

      await purchaseAndConstructHumanShip(humanA, 1);
      await purchaseAndConstructHumanShip(humanB, 6);

      const spmAHuman = await hre.viem.getContractAt(
        "SinglePlayerMatch",
        spmA.address,
        { client: { wallet: humanA } },
      );
      const spmBHuman = await hre.viem.getContractAt(
        "SinglePlayerMatch",
        spmB.address,
        { client: { wallet: humanB } },
      );

      // Engine A's first game: gameId == OFFSET + 1, exactly as before this
      // fix (engineIndex 0 reproduces today's numbering unchanged).
      await spmAHuman.write.startNodeMatch([nodeId, [1n], [{ row: 0, col: 0 }]]);
      const gameIdA = NODE_MATCH_ID_OFFSET + 1n;
      expect(
        getAddress((await gameEngineRegistry.read.engineOfGame([gameIdA])) as string),
      ).to.equal(getAddress(game.address));

      // Engine B's first game: its OWN nodeMatchCount also starts at 1 — pre-
      // fix this would compute the identical gameIdA above and revert here.
      await spmBHuman.write.startNodeMatch([nodeId, [6n], [{ row: 0, col: 0 }]]);
      const gameIdB = NODE_MATCH_ID_OFFSET + ENGINE_ID_BLOCK_SIZE + 1n;
      expect(gameIdB).to.not.equal(gameIdA);
      expect(
        getAddress((await gameEngineRegistry.read.engineOfGame([gameIdB])) as string),
      ).to.equal(getAddress(game.address));

      // Both games are genuinely independent and playable.
      const gameDataA = (await game.read.getGame([gameIdA])) as unknown as GameDataView;
      const gameDataB = (await game.read.getGame([gameIdB])) as unknown as GameDataView;
      expect(gameDataA.shipPositions.length).to.be.greaterThan(0);
      expect(gameDataB.shipPositions.length).to.be.greaterThan(0);
    });
  });
});

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
  setShipHullPoints,
  setShipStat,
  primeShipForRealDestruction,
} from "./helpers/gameStorage";

// Each faction's AI has its own decision trees (Variant1AI / Variant2AI),
// written around what that faction has. Variant 1 is the light, long-range
// faction and plays as a SKIRMISHER (stand off at maximum range, back away
// before shooting); variant 2 is the heavy, short-range faction and plays as
// a BRAWLER (advance at full speed, never retreat). These tests drive real
// takeAITurn calls through SinglePlayerMatch and check what each tree does.
//
// AI ships are built from fixed configs, so their stats are deterministic:
//   variant 1 (base speed 4, no armor/shields = +1): movement 5
//     Generic gun range 3, Sniper range 6, Close range 2
//   variant 2 (base speed 3, no armor/shields = +1): movement 4
//     Generic (Medium Mining Laser) range 2, Sniper (Linear Accelerator)
//     range 5, Close (Mining Drill) range 1
// Specials (per faction): variant 1 slot 1 EMP (range 1), slot 2 Repair
// Drones (range 3), slot 3 Flak Array (range 3); variant 2 slot 1 Electric
// Storm (range 2), slot 2 Drone Swarm (range 5). Variant 1's Ram and variant
// 2's repair (range 1) are faction abilities.
describe("Per-variant AI behavior trees", function () {
  const NODE_MATCH_ID_OFFSET = 2n ** 40n;
  const AI_SHIP_ID_OFFSET = 2n ** 40n;

  // Archetype ids (see Types.sol's Archetype enum)
  const GRUNT = 0;
  const AGGRESSOR = 1;
  const SNIPER = 2;
  const SUPPORT = 3;
  const TURTLE = 4;
  const RAMMER = 5;
  const RUNNER = 6;
  const HUNTER = 7;

  // MainWeapon ids
  const GENERIC = 0;
  const SNIPER_GUN = 1;
  const CLOSE = 3;

  const traits = (variant: number) => ({
    serialNumber: 0n,
    colors: { h1: 0, s1: 0, l1: 0, h2: 0, s2: 0, l2: 0 },
    variant,
    accuracy: 0,
    hull: 0,
    speed: 0,
  });

  async function deployFixture() {
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
      game: deployed.game,
      maps: deployed.maps,
      nodeMap: deployed.nodeMap,
      singlePlayerMatch: deployed.singlePlayerMatch,
      aiEncounters: deployed.aiEncounters,
      randomManager: deployed.randomManager,
      humanShips,
      humanGame,
      humanSinglePlayerMatch,
      singlePlayerMatchOther,
      human,
      owner,
      publicClient,
    };
  }

  type AIShip = {
    variant: number;
    archetype: number;
    weapon?: number;
    special?: number;
    at: [number, number];
    downed?: boolean;
    // Injured but alive: current hull points (below its maximum)
    hp?: number;
  };
  type HumanShip = {
    at: [number, number];
    // 0 HP (a downed ship still on the board)
    downed?: boolean;
    // 0 HP with its reactor timer at 2 (one more tick destroys it)
    primed?: boolean;
    // Exact stats, overriding the purchased ship's rolled ones.
    hp?: number;
    range?: number;
    gunDamage?: number;
  };
  type Scenario = {
    // ai[0] is the ship under test. It must be the ship the AI picks to act
    // first (AIBehavior._pickShip), unless `anyActor` is set: then the
    // result's `actor` says which ship acted.
    ai: AIShip[];
    anyActor?: boolean;
    humans: HumanShip[]; // humans[0] must be live: it makes the turn-passing move
    scoringTiles?: { row: number; col: number }[];
    blocked?: [number, number][];
    impassable?: [number, number][];
  };

  // Builds the match described by `sc`, lets the human pass, has the AI take
  // one turn, and returns what ai[0] did and where it ended up.
  async function run(sc: Scenario) {
    const f = await loadFixture(deployFixture);

    if (sc.scoringTiles) {
      await f.maps.write.createPresetScoringMap([
        sc.scoringTiles.map((t) => ({ ...t, points: 5, onlyOnce: false })),
        MapMode.Both,
      ]);
    } else {
      await f.maps.write.createPresetMap([[], MapMode.Both]);
    }
    const mapId = await f.maps.read.mapCount();

    // AI ships spawn along row 0 and are then moved to their scenario
    // positions. Placements are minted in scan order (ascending column), so
    // spawning ai[i] at column 13 + i gives ai[0] the lowest ship id — the one
    // that acts first.
    const configIds: bigint[] = [];
    const spawns: { row: number; col: number }[] = [];
    for (let i = 0; i < sc.ai.length; i++) {
      const a = sc.ai[i];
      await f.aiEncounters.write.createAIShipConfig([
        `AI ${i}`,
        {
          mainWeapon: a.weapon ?? GENERIC,
          armor: 0,
          shields: 0,
          special: a.special ?? 0,
        },
        traits(a.variant),
        a.archetype,
        false, // shiny
        0, // shipsDestroyed
      ]);
      configIds.push(await f.aiEncounters.read.aiShipConfigCount());
      spawns.push({ row: 0, col: 13 + i });
    }
    await f.aiEncounters.write.setMapPlacements([mapId, spawns, configIds]);

    await f.nodeMap.write.createNode([1n, mapId, [], 2000n, 86400n, 20n, true]);
    const nodeId = await f.nodeMap.read.nodeCount();

    await f.ships.write.purchaseWithFlow(
      [f.human.account.address, 0n, f.human.account.address, 1],
      { value: parseEther("4.99") },
    );
    for (let i = 1; i <= 5; i++) {
      const t = tupleToShip((await f.ships.read.ships([BigInt(i)])) as ShipTuple);
      await f.randomManager.write.revealRandomness([t.traits.serialNumber]);
    }
    await f.humanShips.write.constructAllMyShips({ account: f.human.account });

    const humanIds = sc.humans.map((_, i) => BigInt(i + 1));
    await f.humanSinglePlayerMatch.write.startNodeMatch([
      nodeId,
      humanIds,
      sc.humans.map((_, i) => ({ row: i, col: 0 })),
    ]);
    const gameId = NODE_MATCH_ID_OFFSET + 1n;

    for (const [row, col] of sc.blocked ?? []) {
      await f.maps.write.setBlockedTile([gameId, row, col, true], {
        account: f.owner.account,
      });
    }

    for (const [row, col] of sc.impassable ?? []) {
      await f.maps.write.setImpassableTile([gameId, row, col, true], {
        account: f.owner.account,
      });
    }

    const aiIds = sc.ai.map((_, i) => AI_SHIP_ID_OFFSET + 1n + BigInt(i));
    for (let i = 0; i < sc.ai.length; i++) {
      await setShipPosition(
        f.game.address,
        gameId,
        aiIds[i],
        sc.ai[i].at[0],
        sc.ai[i].at[1],
      );
    }
    for (let i = 0; i < sc.humans.length; i++) {
      await setShipPosition(
        f.game.address,
        gameId,
        humanIds[i],
        sc.humans[i].at[0],
        sc.humans[i].at[1],
      );
    }
    for (let i = 0; i < sc.ai.length; i++) {
      if (sc.ai[i].downed) {
        await setShipHullPointsToZero(f.game.address, gameId, aiIds[i]);
      } else if (sc.ai[i].hp !== undefined) {
        await setShipHullPoints(f.game.address, gameId, aiIds[i], sc.ai[i].hp!);
      }
    }
    for (let i = 0; i < sc.humans.length; i++) {
      const h = sc.humans[i];
      if (h.primed) {
        await primeShipForRealDestruction(f.game.address, gameId, humanIds[i]);
      } else if (h.downed) {
        await setShipHullPointsToZero(f.game.address, gameId, humanIds[i]);
      } else if (h.hp !== undefined) {
        await setShipHullPoints(f.game.address, gameId, humanIds[i], h.hp);
      }
      if (h.range !== undefined) {
        await setShipStat(f.game.address, gameId, humanIds[i], "range", h.range);
      }
      if (h.gunDamage !== undefined) {
        await setShipStat(f.game.address, gameId, humanIds[i], "gunDamage", h.gunDamage);
      }
    }

    // The first human ship passes in place, which hands the turn to the AI.
    await f.humanGame.write.moveShip(
      [
        gameId,
        humanIds[0],
        sc.humans[0].at[0],
        sc.humans[0].at[1],
        ActionType.Pass,
        0n,
      ],
      { account: f.human.account },
    );

    const hash = await f.singlePlayerMatchOther.write.takeAITurn([gameId]);
    const receipt = await f.publicClient.waitForTransactionReceipt({ hash });
    const events = parseEventLogs({
      abi: f.singlePlayerMatch.abi,
      logs: receipt.logs,
      eventName: "AITurnTaken",
    });
    const actor = events[0]?.args.shipId as bigint;
    if (sc.anyActor) return { actor, events, aiIds, humanIds };
    const ev = events.find((e: any) => e.args.shipId === aiIds[0]);
    expect(ev, "the AI ship under test took a turn").to.not.be.undefined;

    const gameData = (await f.game.read.getGame([gameId])) as GameDataView;
    const where = gameData.shipPositions.find((p) => p.shipId === aiIds[0])!;
    return {
      action: Number(ev!.args.actionType),
      target: ev!.args.targetShipId as bigint,
      row: Number(where.position.row),
      col: Number(where.position.col),
      actor,
      aiIds,
      humanIds,
      game: f.game,
      gameId,
    };
  }

  describe("Variant 1 — skirmisher", function () {
    it("Grunt closes only to its maximum range (not all the way in) before shooting", async function () {
      // Laser range 3, movement 5. Enemy 6 tiles away: a full-speed advance
      // would end adjacent; the skirmisher stops at range 3 -> (5,7).
      const r = await run({
        ai: [{ variant: 1, archetype: GRUNT, at: [5, 10] }],
        humans: [{ at: [5, 4] }],
      });
      expect(r.action).to.equal(ActionType.Shoot);
      expect(r.target).to.equal(1n);
      expect([r.row, r.col]).to.deep.equal([5, 7]);
    });

    it("Grunt backs away to maximum range, then shoots", async function () {
      const r = await run({
        ai: [{ variant: 1, archetype: GRUNT, at: [5, 10] }],
        humans: [{ at: [5, 9] }],
      });
      expect(r.action).to.equal(ActionType.Shoot);
      expect([r.row, r.col]).to.deep.equal([5, 12]);
    });

    it("Aggressor presses the fight: it never backs off", async function () {
      const r = await run({
        ai: [{ variant: 1, archetype: AGGRESSOR, at: [5, 10] }],
        humans: [{ at: [5, 9] }],
      });
      expect(r.action).to.equal(ActionType.Shoot);
      expect([r.row, r.col]).to.deep.equal([5, 10]);
    });

    it("Grunt won't abandon a scoring tile to kite, but Sniper will", async function () {
      const grunt = await run({
        ai: [{ variant: 1, archetype: GRUNT, at: [5, 10] }],
        humans: [{ at: [5, 9] }],
        scoringTiles: [{ row: 5, col: 10 }],
      });
      expect(grunt.action).to.equal(ActionType.Shoot);
      expect([grunt.row, grunt.col]).to.deep.equal([5, 10]);

      const sniper = await run({
        ai: [{ variant: 1, archetype: SNIPER, weapon: GENERIC, at: [5, 10] }],
        humans: [{ at: [5, 9] }],
        scoringTiles: [{ row: 5, col: 10 }],
      });
      expect(sniper.action).to.equal(ActionType.Shoot);
      expect([sniper.row, sniper.col]).to.deep.equal([5, 12]);
    });

    it("Support moves into Repair Drones range of an injured ally, then heals it", async function () {
      // Repair Drones range 3, movement 5: the downed ally is 6 tiles away, so
      // the healer steps 3 closer (to range 3) and heals from (5,7).
      const r = await run({
        ai: [
          { variant: 1, archetype: SUPPORT, special: 2, at: [5, 10] },
          { variant: 1, archetype: GRUNT, at: [5, 4], downed: true },
        ],
        humans: [{ at: [0, 0] }],
      });
      expect(r.action).to.equal(ActionType.Special);
      expect(r.target).to.equal(r.aiIds[1]);
      expect([r.row, r.col]).to.deep.equal([5, 7]);
    });

    it("Rammer hunts a downed enemy: moves adjacent and rams it", async function () {
      // Ram range 1, movement 5: the downed ship is 4 tiles away.
      const r = await run({
        ai: [{ variant: 1, archetype: RAMMER, at: [5, 10] }],
        humans: [{ at: [0, 0] }, { at: [5, 6], downed: true }],
      });
      expect(r.action).to.equal(ActionType.FactionAbility);
      expect(r.target).to.equal(2n);
      // It moved adjacent to (5,7) and rammed: a ram evicts the victim and
      // relocates the rammer onto the victim's tile.
      expect([r.row, r.col]).to.deep.equal([5, 6]);
    });

    it("EVERY archetype rams a downed enemy that is holding a scoring tile", async function () {
      // Ram range 1, movement 5: the downed human sits on a scoring tile 4
      // tiles away. The ram evicts it and the rammer takes its tile.
      for (const archetype of [GRUNT, AGGRESSOR, SNIPER, SUPPORT, TURTLE]) {
        const r = await run({
          ai: [{ variant: 1, archetype, at: [5, 10] }],
          humans: [{ at: [0, 0] }, { at: [5, 6], downed: true }],
          scoringTiles: [{ row: 5, col: 6 }],
        });
        expect(r.action, `archetype ${archetype}`).to.equal(
          ActionType.FactionAbility,
        );
        expect(r.target, `archetype ${archetype}`).to.equal(2n);
        expect([r.row, r.col], `archetype ${archetype}`).to.deep.equal([5, 6]);
      }
    });

    it("only the Rammer archetype rams a downed enemy that is NOT on a scoring tile", async function () {
      const scenario = (archetype: number): Scenario => ({
        ai: [{ variant: 1, archetype, at: [5, 10] }],
        humans: [{ at: [0, 0] }, { at: [5, 6], downed: true }],
        scoringTiles: [{ row: 9, col: 15 }],
      });
      const grunt = await run(scenario(GRUNT));
      expect(grunt.action).to.not.equal(ActionType.FactionAbility);
      const rammer = await run(scenario(RAMMER));
      expect(rammer.action).to.equal(ActionType.FactionAbility);
    });

    // docs/audit-4.md HA7-06: a heal or ram that can't land in range this
    // turn must fall through, not pick an out-of-range tile (the resolver
    // reverts OutOfRange and the ship passes, every turn).
    it("Rammer that can't get next to a downed enemy fights instead of passing (HA7-06)", async function () {
      // Live humans fill every tile within Ram range 1 of the downed one.
      const r = await run({
        ai: [{ variant: 1, archetype: RAMMER, at: [5, 10] }],
        humans: [
          { at: [5, 7] },
          { at: [5, 6], downed: true },
          { at: [4, 6] },
          { at: [6, 6] },
          { at: [5, 5] },
        ],
      });
      expect(r.action).to.not.equal(ActionType.FactionAbility);
      expect(r.action).to.not.equal(ActionType.Pass);
    });

    it("Support that can't reach Repair Drones range of its ally fights instead of passing (HA7-06)", async function () {
      // Repair Drones range 3, movement 5: live humans fill every tile it
      // could reach this turn that's within range 3 of the downed ally.
      const r = await run({
        ai: [
          { variant: 1, archetype: SUPPORT, special: 2, at: [5, 10] },
          { variant: 1, archetype: GRUNT, at: [5, 4], downed: true },
        ],
        humans: [
          { at: [5, 7] },
          { at: [5, 6] },
          { at: [5, 5] },
          { at: [4, 6] },
          { at: [6, 6] },
        ],
      });
      expect(r.action).to.not.equal(ActionType.Special);
      expect(r.action).to.not.equal(ActionType.Pass);
    });

    it("closes on the enemy instead of parking beside a scoring tile its ally holds", async function () {
      // Roguelike game 559 (found live 2026-11-03): the map's only scoring
      // tile, (8,12), is held by an ally, with walls to the west and north
      // and allies on every other way around the tile. The Aggressor used to
      // head for that tile and stand beside it every turn. Now it closes on
      // the enemy: the path search takes it past the wall's east end to
      // (7,14), its line passing through its ally at (8,13).
      const r = await run({
        ai: [
          { variant: 1, archetype: AGGRESSOR, weapon: CLOSE, at: [9, 12] },
          { variant: 1, archetype: GRUNT, at: [8, 12] },
          { variant: 1, archetype: GRUNT, at: [9, 13] },
          { variant: 1, archetype: GRUNT, at: [8, 13] },
        ],
        humans: [{ at: [3, 14] }],
        scoringTiles: [{ row: 8, col: 12 }],
        impassable: [
          [7, 11],
          [7, 12],
          [7, 13],
          [8, 11],
          [9, 11],
        ],
      });
      expect(r.action).to.equal(ActionType.Pass); // nothing in range yet
      expect([r.row, r.col]).to.deep.equal([7, 14]);
    });

    it("Rammer fights like a Grunt when there is nothing to ram", async function () {
      const r = await run({
        ai: [{ variant: 1, archetype: RAMMER, at: [5, 10] }],
        humans: [{ at: [5, 8] }],
      });
      expect(r.action).to.equal(ActionType.Shoot);
      expect(r.target).to.equal(1n);
    });

    it("Flak Array is used when it catches 2+ enemies and no ally", async function () {
      const r = await run({
        ai: [{ variant: 1, archetype: GRUNT, special: 3, at: [5, 10] }],
        humans: [{ at: [5, 8] }, { at: [6, 9] }],
      });
      expect(r.action).to.equal(ActionType.Special);
      expect(r.target).to.equal(0n); // area effect: no target
    });

    it("Flak Array is NOT used when an ally would be caught in it", async function () {
      const r = await run({
        ai: [
          { variant: 1, archetype: GRUNT, special: 3, at: [5, 10] },
          { variant: 1, archetype: GRUNT, at: [5, 11] },
        ],
        humans: [{ at: [5, 8] }, { at: [6, 9] }],
      });
      // Falls back to a plain shot rather than friendly-firing its wingman.
      expect(r.action).to.equal(ActionType.Shoot);
    });

    it("Flak Array reaches an enemy the gun cannot (line of sight is blocked)", async function () {
      // A wall stands between the ships: the Laser needs line of sight past
      // range 1, Flak doesn't.
      const r = await run({
        ai: [{ variant: 1, archetype: GRUNT, special: 3, at: [5, 10] }],
        humans: [{ at: [5, 7] }],
        blocked: [
          [5, 8],
          [5, 9],
        ],
      });
      expect(r.action).to.equal(ActionType.Special);
      expect(r.target).to.equal(0n);
    });

    it("EMP finishes an adjacent enemy that is one tick from destruction", async function () {
      const r = await run({
        // The live enemy sits at (5,13), within gun range: ships close on live
        // enemies before wrecks (2026-11-03), and with it far away this
        // Aggressor would walk off toward it instead.
        ai: [{ variant: 1, archetype: AGGRESSOR, special: 1, at: [5, 10] }],
        humans: [{ at: [5, 13] }, { at: [5, 9], primed: true }],
      });
      expect(r.action).to.equal(ActionType.Special);
      expect(r.target).to.equal(2n);
    });
  });

  describe("Variant 2 — brawler", function () {
    it("Grunt advances at full speed and never stops short", async function () {
      // Movement 4, Medium Mining Laser range 2: enemy 8 tiles away -> the
      // brawler covers the full 4 tiles (a skirmisher would stop at range).
      const r = await run({
        ai: [{ variant: 2, archetype: GRUNT, at: [5, 12] }],
        humans: [{ at: [5, 4] }],
      });
      expect(r.action).to.equal(ActionType.Pass); // nothing in range yet
      expect([r.row, r.col]).to.deep.equal([5, 8]);
    });

    // Rows 4-6, columns 12-14 impassable, directly west of the AI ship.
    // A move is one line from tile to tile, so every line toward an enemy
    // to the west runs into it. Found live 2026-11-03 (roguelike game 57).
    const WALL: [number, number][] = [];
    for (let row = 4; row <= 6; row++)
      for (let col = 12; col <= 14; col++) WALL.push([row, col]);

    it("goes around a wall across its path instead of standing still", async function () {
      // The enemy is south-west: the path search goes round the wall's
      // south-east corner, to the tile nearest the enemy by walking distance.
      const r = await run({
        ai: [{ variant: 2, archetype: GRUNT, special: 2, at: [5, 15] }],
        humans: [{ at: [7, 3] }],
        impassable: WALL,
      });
      expect(r.action).to.equal(ActionType.Pass); // nothing in range yet
      expect([r.row, r.col]).to.deep.equal([7, 14]);
    });

    it("goes around a wall when the enemy is level with it", async function () {
      const r = await run({
        ai: [{ variant: 2, archetype: GRUNT, at: [5, 15] }],
        humans: [{ at: [5, 3] }],
        impassable: WALL,
      });
      // Round either corner, onto the row just past the wall.
      expect(r.row === 3 || r.row === 7, `ended at (${r.row},${r.col})`).to.equal(true);
      expect(r.col).to.equal(14);
    });

    it("walks out of a pocket open away from the enemy instead of rocking inside it", async function () {
      // A U of impassable tiles open to the east, with the ship inside it and
      // the enemy due west. Every line west, north or south hits the wall;
      // the old sidestep went up and down inside the U. The only way out is
      // east and around a corner of the U.
      const POCKET: [number, number][] = [];
      for (let row = 2; row <= 8; row++) POCKET.push([row, 13]);
      for (const col of [14, 15]) POCKET.push([2, col], [8, col]);
      const r = await run({
        ai: [{ variant: 2, archetype: GRUNT, at: [5, 15] }],
        humans: [{ at: [5, 3] }],
        impassable: POCKET,
      });
      expect(r.action).to.equal(ActionType.Pass); // nothing in range yet
      expect(r.col).to.equal(16);
      expect(r.row === 2 || r.row === 8, `ended at (${r.row},${r.col})`).to.equal(true);
    });

    it("Grunt closes to melee and fires, stopping adjacent — never on the enemy's own tile", async function () {
      // Mining Drill range 1, movement 4, enemy 3 tiles away.
      const r = await run({
        ai: [{ variant: 2, archetype: GRUNT, weapon: CLOSE, at: [5, 12] }],
        humans: [{ at: [5, 9] }],
      });
      expect(r.action).to.equal(ActionType.Shoot);
      expect(r.target).to.equal(1n);
      expect([r.row, r.col]).to.deep.equal([5, 10]);
    });

    it("Sniper never retreats: it shoots an adjacent enemy in place", async function () {
      // Linear Accelerator range 5. (Variant 1's Sniper would back away.)
      const r = await run({
        ai: [{ variant: 2, archetype: SNIPER, weapon: SNIPER_GUN, at: [5, 10] }],
        humans: [{ at: [5, 9] }],
      });
      expect(r.action).to.equal(ActionType.Shoot);
      expect([r.row, r.col]).to.deep.equal([5, 10]);
    });

    it("Sniper closes only as far as its maximum range, then shoots", async function () {
      // Range 5, enemy 7 tiles away: steps 2 to (5,10) rather than charging in.
      const r = await run({
        ai: [{ variant: 2, archetype: SNIPER, weapon: SNIPER_GUN, at: [5, 12] }],
        humans: [{ at: [5, 5] }],
      });
      expect(r.action).to.equal(ActionType.Shoot);
      expect([r.row, r.col]).to.deep.equal([5, 10]);
    });

    it("every archetype holds a scoring tile it stands on (Aggressor included)", async function () {
      // Holding an objective outranks the archetype's own advance: an
      // Aggressor no longer walks off a tile to chase an enemy 10 away.
      for (const archetype of [GRUNT, AGGRESSOR, TURTLE, SNIPER]) {
        const r = await run({
          ai: [{ variant: 2, archetype, at: [5, 12] }],
          humans: [{ at: [5, 2] }],
          scoringTiles: [{ row: 5, col: 12 }],
        });
        expect(r.action, `archetype ${archetype}`).to.equal(ActionType.Pass);
        expect([r.row, r.col], `archetype ${archetype}`).to.deep.equal([5, 12]);
      }
    });

    it("Rammer plays as a Grunt (variant 2 has no Ram): it never rams a downed enemy", async function () {
      const r = await run({
        ai: [{ variant: 2, archetype: RAMMER, at: [5, 10] }],
        humans: [{ at: [0, 0] }, { at: [5, 9], downed: true }],
      });
      expect(r.action).to.not.equal(ActionType.FactionAbility);
    });

    it("Support moves adjacent to an injured ally and repairs it with the faction ability", async function () {
      // Repair range 1, movement 4: the downed ally is 5 tiles away.
      const r = await run({
        ai: [
          { variant: 2, archetype: SUPPORT, at: [5, 12] },
          { variant: 2, archetype: GRUNT, at: [5, 7], downed: true },
        ],
        humans: [{ at: [0, 0] }],
      });
      expect(r.action).to.equal(ActionType.FactionAbility);
      expect(r.target).to.equal(r.aiIds[1]);
      expect([r.row, r.col]).to.deep.equal([5, 8]);
    });

    it("Drone Swarm reaches past the guns when nothing is in gun range", async function () {
      // Swarm range 5 (line of sight not needed); Medium Mining Laser range 2.
      // Enemy 9 tiles away: after advancing 4 it is 5 away — out of gun range,
      // within Swarm range.
      const r = await run({
        ai: [{ variant: 2, archetype: GRUNT, special: 2, at: [5, 10] }],
        humans: [{ at: [5, 1] }],
      });
      expect(r.action).to.equal(ActionType.Special);
      expect(r.target).to.equal(1n);
      expect([r.row, r.col]).to.deep.equal([5, 6]);
    });

    it("Electric Storm finishes 2+ downed enemies at once when it is safe", async function () {
      const r = await run({
        ai: [{ variant: 2, archetype: GRUNT, special: 1, at: [5, 10] }],
        humans: [
          { at: [0, 0] },
          { at: [5, 9], downed: true },
          { at: [5, 11], downed: true },
        ],
      });
      expect(r.action).to.equal(ActionType.Special);
      expect(r.target).to.equal(0n); // area effect: no target
    });
  });

  // Every variant 2 ship has Repair (range 1), so every archetype follows the
  // same priorities: (1) repair an injured/disabled friendly standing on a
  // scoring tile, (2) claim a scoring tile, (3) repair a disabled friendly,
  // then its archetype's fight, and last of all (4) repair itself or any
  // injured friendly in range. Variant 2 movement is 4 here.
  describe("Variant 2 — repair and objective priorities", function () {
    const GRUNT_AT = (at: [number, number], extra: Partial<AIShip> = {}) => ({
      variant: 2,
      archetype: GRUNT,
      at,
      ...extra,
    });

    it("1: repairs an injured friendly on a scoring tile ahead of shooting an adjacent enemy", async function () {
      // Any archetype: an Aggressor next to an enemy still goes to repair.
      for (const archetype of [GRUNT, AGGRESSOR, SNIPER, TURTLE]) {
        const r = await run({
          ai: [
            { variant: 2, archetype, at: [5, 12] },
            GRUNT_AT([5, 9], { hp: 10 }),
          ],
          // Adjacent to the AI's start (so a Shoot is genuinely available
          // this turn — that's the point being tested), but off row 5, the
          // AI's straight-line repair-approach toward (5,9). Enemy ships
          // now block movement (2026-09-26) — an enemy at (5,11) instead
          // would sit exactly on that approach and make the repair
          // genuinely unreachable in one move, which is a real, different
          // scenario (see the "blocked by an enemy" test below), not what
          // this test is checking.
          humans: [{ at: [4, 12] }],
          scoringTiles: [{ row: 5, col: 9 }],
        });
        expect(r.action, `archetype ${archetype}`).to.equal(
          ActionType.FactionAbility,
        );
        expect(r.target, `archetype ${archetype}`).to.equal(r.aiIds[1]);
        // Nearest free tile within repair range 1 of (5,9).
        expect([r.row, r.col], `archetype ${archetype}`).to.deep.equal([5, 10]);
      }
    });

    // Found via a real regression (2026-09-26): before enemy ships blocked
    // movement, an enemy sitting exactly on the repair approach never
    // mattered — the ship just flew past it. Now it can make the repair
    // genuinely unreachable this turn (every tile within repair range of
    // the ally is either past the enemy on the same line, or too far via
    // any other angle within this movement budget) — the AI correctly
    // falls through to its next priority (fight) instead of Passing.
    it("1b: falls through to shooting when an enemy blocks the only reachable repair approach", async function () {
      const r = await run({
        ai: [
          { variant: 2, archetype: GRUNT, at: [5, 12] },
          GRUNT_AT([5, 9], { hp: 10 }),
        ],
        // Directly on row 5, between the AI and the ally it wants to
        // repair — blocks every tile within repair range 1 of (5,9) that's
        // reachable within this ship's movement (4).
        humans: [{ at: [5, 11] }],
        scoringTiles: [{ row: 5, col: 9 }],
      });
      expect(r.action).to.equal(ActionType.Shoot);
      expect(r.target).to.equal(r.humanIds[0]);
    });

    // Counterpart to 1b (2026-09-28): same geometry, but the ship sitting on
    // the repair approach is DISABLED (0 HP), and a disabled ship no longer
    // blocks movement — so the approach is reachable again and the repair
    // (the higher priority) happens instead of the fall-through to shooting.
    // A second, healthy human sits far away to take the turn-passing move
    // (a 0-HP ship can't act).
    it("1c: still repairs when the ship on the approach is a DISABLED enemy (wreckage doesn't block)", async function () {
      const r = await run({
        ai: [
          { variant: 2, archetype: GRUNT, at: [5, 12] },
          GRUNT_AT([5, 9], { hp: 10 }),
        ],
        humans: [{ at: [0, 0] }, { at: [5, 11], downed: true }],
        scoringTiles: [{ row: 5, col: 9 }],
      });
      expect(r.action).to.equal(ActionType.FactionAbility);
      expect(r.target).to.equal(r.aiIds[1]);
      expect([r.row, r.col]).to.deep.equal([5, 10]);
    });

    it("1: also repairs a DISABLED friendly on a scoring tile, and prefers it to an injured one", async function () {
      const r = await run({
        ai: [
          GRUNT_AT([5, 12]),
          GRUNT_AT([5, 9], { hp: 10 }),
          GRUNT_AT([5, 15], { downed: true }),
        ],
        humans: [{ at: [0, 0] }],
        scoringTiles: [
          { row: 5, col: 9 },
          { row: 5, col: 15 },
        ],
      });
      expect(r.action).to.equal(ActionType.FactionAbility);
      expect(r.target).to.equal(r.aiIds[2]);
      // The repair really landed on-chain: the disabled ship is back above 0.
      const g = (await r.game.read.getGame([r.gameId])) as GameDataView;
      const healed = g.shipAttributes[g.shipIds.indexOf(r.aiIds[2])];
      expect(healed.hullPoints).to.be.greaterThan(0);
    });

    it("1: an injured friendly that is NOT on a scoring tile does not outrank claiming one", async function () {
      // Scoring tile 4 away; injured ally adjacent but off the tile.
      const r = await run({
        ai: [GRUNT_AT([5, 12]), GRUNT_AT([4, 12], { hp: 10 })],
        humans: [{ at: [5, 2] }],
        scoringTiles: [{ row: 5, col: 8 }],
      });
      // 2: it heads for the tile at full speed instead of repairing.
      expect([r.row, r.col]).to.deep.equal([5, 8]);
      expect(r.action).to.equal(ActionType.Pass);
    });

    it("2: claims a scoring tile ahead of repairing a disabled friendly", async function () {
      // Tile 3 south; the disabled ally is 3 west, off the tile. After
      // claiming the tile the ally is out of repair range.
      const r = await run({
        ai: [GRUNT_AT([5, 12]), GRUNT_AT([5, 9], { downed: true })],
        humans: [{ at: [5, 2] }],
        scoringTiles: [{ row: 8, col: 12 }],
      });
      expect([r.row, r.col]).to.deep.equal([8, 12]);
      expect(r.action).to.equal(ActionType.Pass);
    });

    it("2/3: once on the tile it repairs a disabled friendly beside it (ahead of shooting), but does not leave to reach a far one", async function () {
      const beside = await run({
        ai: [GRUNT_AT([5, 12]), GRUNT_AT([5, 13], { downed: true })],
        humans: [{ at: [5, 11] }], // adjacent enemy the gun could shoot
        scoringTiles: [{ row: 5, col: 12 }],
      });
      expect(beside.action).to.equal(ActionType.FactionAbility);
      expect(beside.target).to.equal(beside.aiIds[1]);
      expect([beside.row, beside.col]).to.deep.equal([5, 12]);

      const far = await run({
        ai: [GRUNT_AT([5, 12]), GRUNT_AT([5, 9], { downed: true })],
        humans: [{ at: [5, 2] }],
        scoringTiles: [{ row: 5, col: 12 }],
      });
      expect(far.action).to.equal(ActionType.Pass);
      expect([far.row, far.col]).to.deep.equal([5, 12]);
    });

    it("3: with no tile to claim, it moves to repair a disabled friendly ahead of shooting", async function () {
      const r = await run({
        ai: [GRUNT_AT([5, 12]), GRUNT_AT([5, 9], { downed: true })],
        humans: [{ at: [5, 13] }], // adjacent enemy
      });
      expect(r.action).to.equal(ActionType.FactionAbility);
      expect(r.target).to.equal(r.aiIds[1]);
      expect([r.row, r.col]).to.deep.equal([5, 10]);
    });

    it("4: shooting comes before the last-resort repair", async function () {
      // Injured but above a quarter of its HP: at 10 HP it would step out
      // of range instead (low-HP evasion, 2026-11-03).
      const r = await run({
        ai: [GRUNT_AT([5, 12], { hp: 60 })],
        humans: [{ at: [5, 11] }],
      });
      expect(r.action).to.equal(ActionType.Shoot);
    });

    it("4: with nothing else to do it repairs ITSELF, from wherever its move ends", async function () {
      // The Grunt advances 4 toward the distant enemy, finds nothing to shoot,
      // and repairs itself instead of passing.
      const r = await run({
        ai: [GRUNT_AT([5, 12], { hp: 10 })],
        humans: [{ at: [5, 2] }],
      });
      expect(r.action).to.equal(ActionType.FactionAbility);
      expect(r.target).to.equal(r.aiIds[0]);
      expect([r.row, r.col]).to.deep.equal([5, 8]);
    });

    it("4: with nothing else to do it repairs an injured (not disabled) friendly in range", async function () {
      const r = await run({
        ai: [
          { variant: 2, archetype: TURTLE, at: [5, 12] },
          GRUNT_AT([5, 13], { hp: 10 }),
        ],
        humans: [{ at: [5, 2] }],
      });
      expect(r.action).to.equal(ActionType.FactionAbility);
      expect(r.target).to.equal(r.aiIds[1]);
      expect([r.row, r.col]).to.deep.equal([5, 12]);
    });

    it("4: a healthy ship with no injured friendly does not waste the action", async function () {
      const r = await run({
        ai: [{ variant: 2, archetype: TURTLE, at: [5, 12] }],
        humans: [{ at: [5, 2] }],
      });
      expect(r.action).to.equal(ActionType.Pass);
    });
  });

  // 2026-11-03, from the live-game evaluation (docs/ai-evaluation-2026-11-03.md):
  // players won almost every game on points while the AI chased ships.
  describe("Objective play", function () {
    it("heads for the tile it reaches before the enemy, not one on the enemy's half", async function () {
      // A short-range variant 2 Grunt used to prefer tiles at col <= 8
      // (toward the enemy) and walk to (5,4), which the enemy at (5,1) owns.
      const r = await run({
        ai: [{ variant: 2, archetype: GRUNT, at: [5, 15] }],
        humans: [{ at: [5, 1] }],
        scoringTiles: [
          { row: 5, col: 4 },
          { row: 5, col: 12 },
        ],
      });
      expect(r.action).to.equal(ActionType.Pass);
      expect([r.row, r.col]).to.deep.equal([5, 12]);
    });

    it("variant 1 Grunt takes a free tile before kiting to shoot", async function () {
      // Before, it stood off at range 3 from the enemy at (5,10) and shot.
      const r = await run({
        ai: [{ variant: 1, archetype: GRUNT, at: [5, 15] }],
        humans: [{ at: [5, 10] }],
        scoringTiles: [{ row: 2, col: 15 }],
      });
      expect(r.action).to.equal(ActionType.Pass); // nothing in range from the tile
      expect([r.row, r.col]).to.deep.equal([2, 15]);
    });

    it("variant 1 Aggressor still presses the fight instead of taking the tile", async function () {
      const r = await run({
        ai: [{ variant: 1, archetype: AGGRESSOR, at: [5, 15] }],
        humans: [{ at: [5, 10] }],
        scoringTiles: [{ row: 2, col: 15 }],
      });
      expect(r.action).to.equal(ActionType.Shoot);
    });

    it("closes on the enemy holding a tile, not the nearer one, while the enemy out-earns it", async function () {
      // The only tile, (5,6), is held by humans[0], 9 away. The nearest
      // enemy is at (0,13), 7 away: out of reach of a shot this turn
      // (range 2 + movement 4), so line-of-sight seeking doesn't apply.
      // Advancing at full speed toward the holder stops at (5,11); toward
      // the nearer enemy it would have gone to (1,15).
      const r = await run({
        ai: [{ variant: 2, archetype: GRUNT, at: [5, 15] }],
        humans: [{ at: [5, 6] }, { at: [0, 13] }],
        scoringTiles: [{ row: 5, col: 6 }],
      });
      expect(r.action).to.equal(ActionType.Pass);
      expect([r.row, r.col]).to.deep.equal([5, 11]);
    });

    it("goes for the nearer enemy when no tile is being held", async function () {
      // Same two enemies, no scoring tiles: the nearer one, (2,15), is the
      // target. The Grunt stops adjacent at (3,15) and shoots it.
      const r = await run({
        ai: [{ variant: 2, archetype: GRUNT, at: [5, 15] }],
        humans: [{ at: [5, 7] }, { at: [2, 15] }],
      });
      expect(r.action).to.equal(ActionType.Shoot);
      expect(r.target).to.equal(r.humanIds[1]);
    });
  });

  // 2026-11-03: a ship whose target sits behind a line-of-sight blocker
  // used to take its usual step and pass. Here the blocker at (5,10) hides
  // the enemy at (5,8) from (5,12), and a wall at column 11 (rows 4-6)
  // stops it walking in. One step north, (4,12), has a clear line.
  describe("Line-of-sight seeking", function () {
    const wallAndBlocker = {
      blocked: [[5, 10]] as [number, number][],
      impassable: [
        [4, 11],
        [5, 11],
        [6, 11],
      ] as [number, number][],
    };

    it("variant 1 Aggressor steps to a tile with a clear shot and fires", async function () {
      const r = await run({
        // Sniper gun (range 6), so (4,12) is in range of (5,8).
        ai: [{ variant: 1, archetype: AGGRESSOR, weapon: SNIPER_GUN, at: [5, 12] }],
        humans: [{ at: [5, 8] }],
        ...wallAndBlocker,
      });
      expect(r.action).to.equal(ActionType.Shoot);
      expect(r.target).to.equal(r.humanIds[0]);
      expect([r.row, r.col]).to.deep.equal([4, 12]);
    });

    it("variant 2 Sniper does the same", async function () {
      const r = await run({
        ai: [{ variant: 2, archetype: SNIPER, weapon: SNIPER_GUN, at: [5, 12] }],
        humans: [{ at: [5, 8] }],
        ...wallAndBlocker,
      });
      expect(r.action).to.equal(ActionType.Shoot);
      expect([r.row, r.col]).to.deep.equal([4, 12]);
    });

    it("a ship holding a scoring tile keeps holding instead of leaving for a shot", async function () {
      const r = await run({
        ai: [{ variant: 1, archetype: SNIPER, weapon: SNIPER_GUN, at: [5, 12] }],
        humans: [{ at: [5, 8] }],
        scoringTiles: [{ row: 5, col: 12 }],
        ...wallAndBlocker,
      });
      expect(r.action).to.equal(ActionType.Pass);
      expect([r.row, r.col]).to.deep.equal([5, 12]);
    });
  });

  // 2026-11-03, from the live-game evaluation: shoot before a routine
  // repair, rank targets by kills, and keep low-HP ships out of fire.
  describe("Repairs, targets and threat", function () {
    it("variant 2 shoots an enemy instead of a repair that can wait", async function () {
      // The ally on the tile is injured but no enemy shot can destroy it
      // (the only enemy hits for 40). Before, the repair came first.
      const r = await run({
        ai: [
          { variant: 2, archetype: GRUNT, at: [5, 12] },
          { variant: 2, archetype: GRUNT, at: [5, 9], hp: 100 },
        ],
        humans: [{ at: [4, 12], gunDamage: 40 }],
        scoringTiles: [{ row: 5, col: 9 }],
      });
      expect(r.action).to.equal(ActionType.Shoot);
      expect(r.target).to.equal(r.humanIds[0]);
    });

    it("variant 2 still makes a repair that can wait when it has no shot", async function () {
      const r = await run({
        ai: [
          { variant: 2, archetype: GRUNT, at: [5, 12] },
          { variant: 2, archetype: GRUNT, at: [5, 9], hp: 100 },
        ],
        humans: [{ at: [0, 0], gunDamage: 40 }],
        scoringTiles: [{ row: 5, col: 9 }],
      });
      expect(r.action).to.equal(ActionType.FactionAbility);
      expect(r.target).to.equal(r.aiIds[1]);
    });

    it("takes the kill over a healthy enemy holding a tile", async function () {
      // Before, the enemy on the tile was always shot first.
      const r = await run({
        ai: [{ variant: 2, archetype: SNIPER, weapon: SNIPER_GUN, at: [5, 12] }],
        humans: [{ at: [5, 9] }, { at: [3, 12], hp: 5 }],
        scoringTiles: [{ row: 5, col: 9 }],
      });
      expect(r.action).to.equal(ActionType.Shoot);
      expect(r.target).to.equal(r.humanIds[1]);
    });

    it("shoots a live enemy before a disabled one on a tile", async function () {
      const r = await run({
        ai: [{ variant: 2, archetype: SNIPER, weapon: SNIPER_GUN, at: [5, 12] }],
        humans: [{ at: [3, 12] }, { at: [5, 9], downed: true }],
        scoringTiles: [{ row: 5, col: 9 }],
      });
      expect(r.action).to.equal(ActionType.Shoot);
      expect(r.target).to.equal(r.humanIds[0]);
    });

    it("closes on a live enemy, not a nearer wreck", async function () {
      // The wreck at (2,14) is 5 away and the live enemy at (5,4) 10 away.
      // Toward the live one at full speed (movement 4) is (5,8).
      const r = await run({
        ai: [{ variant: 2, archetype: GRUNT, at: [5, 12] }],
        humans: [{ at: [5, 4] }, { at: [2, 14], downed: true }],
      });
      expect(r.action).to.equal(ActionType.Pass);
      expect([r.row, r.col]).to.deep.equal([5, 8]);
    });

    it("variant 1 kiter shoots from a tile no enemy can return fire on", async function () {
      // Sniper gun, range 6. Backing off to range 6 from the nearer enemy
      // (5,8) would land at (5,14), inside the range-3 enemy at (5,16).
      // Where it stands, (5,10), is out of both enemies' range.
      const r = await run({
        ai: [{ variant: 1, archetype: SNIPER, weapon: SNIPER_GUN, at: [5, 10] }],
        humans: [
          { at: [5, 8], range: 1 },
          { at: [5, 16], range: 3 },
        ],
      });
      expect(r.action).to.equal(ActionType.Shoot);
      expect([r.row, r.col]).to.deep.equal([5, 10]);
    });

    it("a low-HP variant 2 ship steps out of range and repairs itself", async function () {
      // 10 HP, enemy 3 away with range 3. Its own gun (range 2) has no tile
      // out of that enemy's range, so it moves to the nearest safe tile.
      const r = await run({
        ai: [{ variant: 2, archetype: GRUNT, at: [5, 12], hp: 10 }],
        humans: [{ at: [5, 9], range: 3 }],
      });
      expect(r.action).to.equal(ActionType.FactionAbility);
      expect(r.target).to.equal(r.aiIds[0]);
      expect([r.row, r.col]).to.deep.equal([4, 12]);
    });
  });

  // 2026-11-03: the two archetypes added after the live-game evaluation.
  describe("Objective Runner and Hunter", function () {
    // Each side holds one tile, so the score is level and other archetypes
    // aren't drawn to the holder. humans[1] is nearer and destroyable in one
    // shot, which every other archetype would shoot first.
    const levelTiles = {
      scoringTiles: [
        { row: 5, col: 8 },
        { row: 2, col: 15 },
      ],
    };

    it("variant 1 Runner goes after the enemy holding a tile and shoots it over an easy kill", async function () {
      const r = await run({
        ai: [
          { variant: 1, archetype: RUNNER, at: [5, 13] },
          { variant: 1, archetype: GRUNT, at: [2, 15] },
        ],
        humans: [{ at: [5, 8] }, { at: [3, 11], hp: 5 }],
        ...levelTiles,
      });
      // Gun range 3: it closes to (5,11), 3 from the holder.
      expect(r.action).to.equal(ActionType.Shoot);
      expect(r.target).to.equal(r.humanIds[0]);
      expect([r.row, r.col]).to.deep.equal([5, 11]);
    });

    it("variant 2 Runner does the same", async function () {
      const r = await run({
        ai: [
          { variant: 2, archetype: RUNNER, at: [5, 13] },
          { variant: 2, archetype: GRUNT, at: [2, 15] },
        ],
        humans: [{ at: [5, 8] }, { at: [4, 11], hp: 5 }],
        ...levelTiles,
      });
      // Gun range 2: it closes to (5,10), 2 from the holder.
      expect(r.action).to.equal(ActionType.Shoot);
      expect(r.target).to.equal(r.humanIds[0]);
      expect([r.row, r.col]).to.deep.equal([5, 10]);
    });

    it("variant 2 Hunter goes after the enemy it can destroy soonest, not the one in range", async function () {
      // humans[0] is in gun range (2) but, at 200 HP, takes at least three
      // shots; humans[1], 3 away, takes one turn to reach and one shot. A
      // Grunt would shoot humans[0] where it stands.
      const r = await run({
        ai: [{ variant: 2, archetype: HUNTER, at: [5, 12] }],
        humans: [{ at: [5, 10], hp: 200 }, { at: [2, 12], hp: 5 }],
      });
      expect(r.action).to.equal(ActionType.Shoot);
      expect(r.target).to.equal(r.humanIds[1]);
    });

    it("variant 1 Hunter ignores a free tile and closes to shoot", async function () {
      // A variant 1 Grunt would take the tile at (2,15) instead.
      const r = await run({
        ai: [{ variant: 1, archetype: HUNTER, at: [5, 15] }],
        humans: [{ at: [5, 10] }],
        scoringTiles: [{ row: 2, col: 15 }],
      });
      expect(r.action).to.equal(ActionType.Shoot);
      expect([r.row, r.col]).to.deep.equal([5, 13]);
    });

    it("variant 2 Hunter skips the claim step every other variant 2 ship takes", async function () {
      const r = await run({
        ai: [{ variant: 2, archetype: HUNTER, at: [5, 15] }],
        humans: [{ at: [5, 10] }],
        scoringTiles: [{ row: 2, col: 15 }],
      });
      expect(r.action).to.equal(ActionType.Shoot);
      expect([r.row, r.col]).to.deep.equal([5, 12]);
    });
  });

  describe("Turn order", function () {
    it("moves a ship that can destroy an enemy before one that can only shoot", async function () {
      // ai[0] has the 200-HP enemy in range; ai[1] has a 1-HP enemy in range.
      const r: any = await run({
        ai: [
          { variant: 2, archetype: GRUNT, at: [5, 10] },
          { variant: 2, archetype: GRUNT, at: [1, 14] },
        ],
        humans: [{ at: [5, 8], hp: 200 }, { at: [1, 12], hp: 1 }],
        anyActor: true,
      });
      expect(r.actor).to.equal(r.aiIds[1]);
      expect(Number(r.events[0].args.actionType)).to.equal(ActionType.Shoot);
      expect(r.events[0].args.targetShipId).to.equal(r.humanIds[1]);
    });

    it("moves a ship with an enemy in range before one with none", async function () {
      const r: any = await run({
        ai: [
          { variant: 2, archetype: GRUNT, at: [9, 16] },
          { variant: 2, archetype: GRUNT, at: [5, 10] },
        ],
        humans: [{ at: [5, 8], hp: 200 }],
        anyActor: true,
      });
      expect(r.actor).to.equal(r.aiIds[1]);
    });

    it("moves a Support after the other ships", async function () {
      // The Support has an enemy in range and the Grunt doesn't; the
      // Support still waits.
      const r: any = await run({
        ai: [
          { variant: 1, archetype: SUPPORT, at: [5, 10] },
          { variant: 1, archetype: GRUNT, at: [9, 16] },
        ],
        humans: [{ at: [5, 8], hp: 200 }],
        anyActor: true,
      });
      expect(r.actor).to.equal(r.aiIds[1]);
    });

    it("keeps the first ship first when nothing separates them", async function () {
      const r: any = await run({
        ai: [
          { variant: 2, archetype: GRUNT, at: [9, 16] },
          { variant: 2, archetype: GRUNT, at: [8, 16] },
        ],
        humans: [{ at: [5, 3] }],
        anyActor: true,
      });
      expect(r.actor).to.equal(r.aiIds[0]);
    });
  });

  describe("Same slot, different faction", function () {
    it("special slot 2 heals for variant 1 (Repair Drones) but attacks for variant 2 (Drone Swarm)", async function () {
      // Same slot number, same shape of scenario (an injured ally within
      // reach, an enemy far off): variant 1's slot 2 is a heal, variant 2's
      // slot 2 is an attack special that must never be aimed at an ally.
      const v1 = await run({
        ai: [
          { variant: 1, archetype: SUPPORT, special: 2, at: [5, 10] },
          { variant: 1, archetype: GRUNT, at: [5, 8], downed: true },
        ],
        humans: [{ at: [0, 0] }],
      });
      expect(v1.action).to.equal(ActionType.Special);
      expect(v1.target).to.equal(v1.aiIds[1]);

      const v2 = await run({
        ai: [
          { variant: 2, archetype: SUPPORT, special: 2, at: [5, 10] },
          { variant: 2, archetype: GRUNT, at: [5, 9], downed: true },
        ],
        humans: [{ at: [0, 0] }],
      });
      // Variant 2 heals with its faction ability, never its Swarm special.
      expect(v2.action).to.equal(ActionType.FactionAbility);
      expect(v2.target).to.equal(v2.aiIds[1]);
    });
  });
});

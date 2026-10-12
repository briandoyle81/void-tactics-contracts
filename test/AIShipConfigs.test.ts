import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers";
import hre from "hardhat";
import { parseEther, parseEventLogs, zeroAddress } from "viem";
import {
  ShipTuple,
  tupleToShip,
  ActionType,
  GameDataView,
  MapMode,
} from "./types";
import DeployModule from "../ignition/modules/DeployAndConfig";
import starterContent from "../ignition/data/singlePlayerStarterContent.json";
import {
  setShipPosition,
  setShipHullPointsToZero,
  primeShipForRealDestruction,
} from "./helpers/gameStorage";

// The seeded AI ship configs (ignition/data/singlePlayerStarterContent.json,
// "aiShipConfigs"), checked as deployed: every config must be a viable ship
// for its archetype, use ITS OWN faction's kit, and climb the level ramp
// sensibly; and a few real configs are driven through real AI turns to check
// the ship and its behavior tree fit together. The design and how to iterate on
// it live in docs/ai-ship-configs.md and scripts/balance-sim/ai_config_lab.py.
describe("Seeded AI ship configs", function () {
  const GRUNT = 0;
  const AGGRESSOR = 1;
  const SNIPER = 2;
  const SUPPORT = 3;
  const TURTLE = 4;
  const RAMMER = 5;

  // Which archetypes may carry each faction's special (slot -> archetypes).
  // Variant 1: 1 EMP (adjacent finisher), 2 Repair Drones (heal), 3 Flak Array
  // (AoE from a held position). Variant 2: 1 Electric Storm (finisher), 2 Drone
  // Swarm (reach past short guns), 3 Thruster (passive speed for heavy ships).
  const ALLOWED_SPECIALS: Record<number, Record<number, number[]>> = {
    1: { 1: [AGGRESSOR], 2: [SUPPORT], 3: [GRUNT, TURTLE] },
    2: {
      1: [AGGRESSOR],
      2: [GRUNT, TURTLE],
      3: [GRUNT, AGGRESSOR, SNIPER, SUPPORT],
    },
  };

  async function deployAll() {
    return hre.ignition.deploy(DeployModule);
  }

  // name -> data-file entry (names are unique), so each on-chain config can be
  // related back to its variant/archetype/level.
  const byName = new Map(starterContent.aiShipConfigs.map((c) => [c.name, c]));
  // A key's level is normally its trailing digit (no digit = level 1). These
  // keys don't follow that: the content editor re-keyed v1's level 1-2 ships
  // (2026-10-12), and the keys are referenced from mapPlacements, so they're
  // pinned here instead of renamed. `grunt`/`aggressor` now hold level-2
  // ships of the OTHER archetype (grunt = aggressor line, aggressor = grunt
  // line).
  const LEVEL_OVERRIDES: Record<string, number> = {
    grunt: 2,
    aggressor: 2,
    aiConfig5: 1,
    aiConfig10: 1,
    aiConfig13: 2,
    aiConfig17: 1,
    aiConfig22: 1,
  };
  // Snipers normally carry gun 1 with a long-range floor; these are
  // deliberate design exceptions.
  const SNIPER_EXCEPTIONS: Record<string, { gun: number; minRange: number }> = {
    v2sniper3: { gun: 2, minRange: 4 }, // intentional, 2026-10-12
  };
  const levelOf = (key: string) => {
    if (key in LEVEL_OVERRIDES) return LEVEL_OVERRIDES[key];
    const m = key.match(/(\d)$/);
    return m ? Number(m[1]) : 1;
  };

  function shipOf(cfg: any) {
    return {
      name: cfg.name,
      id: 1n,
      equipment: cfg.equipment,
      traits: cfg.traits,
      shipData: {
        shipsDestroyed: 0,
        costsVersion: 0,
        cost: 0,
        modified: 0,
        shiny: false,
        constructed: true,
        inFleet: false,
        isFreeShip: false,
        timestampDestroyed: 0n,
      },
      owner: zeroAddress,
    };
  }

  async function readAll(d: Awaited<ReturnType<typeof deployAll>>) {
    const configs = await d.aiEncounters.read.getAllAIShipConfigs();
    const rows = [];
    for (const cfg of configs) {
      const entry = byName.get(cfg.name)!;
      expect(entry, `${cfg.name} is in the data file`).to.not.equal(undefined);
      const ship = shipOf(cfg);
      const attrs = await d.shipAttributes.read.calculateShipAttributes([
        ship as any,
      ]);
      const cost = await d.shipAttributes.read.calculateShipCost([ship as any]);
      rows.push({
        cfg,
        key: entry.key,
        level: levelOf(entry.key),
        variant: Number(cfg.traits.variant),
        archetype: Number(cfg.archetype),
        attrs,
        cost: Number(cost),
      });
    }
    return rows;
  }

  describe("design rules (real on-chain stats)", function () {
    it("seeds every config in the data file", async function () {
      const d = await loadFixture(deployAll);
      const configs = await d.aiEncounters.read.getAllAIShipConfigs();
      expect(configs.length).to.equal(starterContent.aiShipConfigs.length);
    });

    it("every ship can actually move, and only tile-holders are allowed to be slow", async function () {
      const rows = await readAll(await loadFixture(deployAll));
      for (const r of rows) {
        const min = r.archetype === TURTLE ? 2 : 3;
        expect(
          Number(r.attrs.movement),
          `${r.key} movement`,
        ).to.be.greaterThanOrEqual(min);
      }
    });

    it("each archetype is equipped for its tree", async function () {
      const rows = await readAll(await loadFixture(deployAll));
      for (const r of rows) {
        const e = r.cfg.equipment;
        // a ship carries armor OR shields, never both
        expect(e.armor !== 0 && e.shields !== 0, `${r.key} armor+shields`).to.equal(
          false,
        );
        if (r.archetype === SNIPER) {
          const exception = SNIPER_EXCEPTIONS[r.key];
          expect(e.mainWeapon, `${r.key} sniper gun`).to.equal(
            exception?.gun ?? 1,
          );
          expect(
            Number(r.attrs.range),
            `${r.key} sniper range`,
          ).to.be.greaterThanOrEqual(
            exception?.minRange ?? (r.variant === 1 ? 6 : 5),
          );
        }
        if (r.archetype === SUPPORT && r.variant === 1) {
          // variant 1 heals with an EQUIPPED Repair Drones special
          expect(e.special, `${r.key} v1 support heals`).to.equal(2);
        }
        if (r.archetype === RAMMER) {
          expect(r.variant, `${r.key}: only variant 1 has Ram`).to.equal(1);
        }
      }
    });

    it("every special is one of its OWN faction's, on an archetype that can use it", async function () {
      const rows = await readAll(await loadFixture(deployAll));
      for (const r of rows) {
        const slot = Number(r.cfg.equipment.special);
        if (slot === 0) continue;
        const allowed = ALLOWED_SPECIALS[r.variant]?.[slot];
        expect(allowed, `${r.key}: slot ${slot} exists for variant ${r.variant}`).to.not.equal(
          undefined,
        );
        expect(
          allowed!.includes(r.archetype),
          `${r.key}: slot ${slot} on archetype ${r.archetype}`,
        ).to.equal(true);
      }
    });

    it("each faction's whole kit is used by some config (no dead specials)", async function () {
      const rows = await readAll(await loadFixture(deployAll));
      for (const variant of [1, 2]) {
        const used = new Set(
          rows
            .filter((r) => r.variant === variant)
            .map((r) => Number(r.cfg.equipment.special)),
        );
        for (const slot of [1, 2, 3]) {
          expect(used.has(slot), `variant ${variant} special slot ${slot} is equipped somewhere`).to.equal(
            true,
          );
        }
      }
    });

    it("cost rises with level within every faction and archetype", async function () {
      const rows = await readAll(await loadFixture(deployAll));
      for (const variant of [1, 2]) {
        for (let archetype = 0; archetype <= RAMMER; archetype++) {
          const line = rows
            .filter((r) => r.variant === variant && r.archetype === archetype)
            .sort((a, b) => a.level - b.level);
          for (let i = 1; i < line.length; i++) {
            expect(
              line[i].cost,
              `${line[i].key} (level ${line[i].level}) costs at least ${line[i - 1].key}`,
            ).to.be.greaterThanOrEqual(line[i - 1].cost);
          }
          const levels = line.map((r) => r.level);
          expect(levels, `v${variant} archetype ${archetype} levels are contiguous from 1`).to.deep.equal(
            levels.map((_, i) => i + 1),
          );
        }
      }
    });

    it("top-level ships are clearly a step above entry-level ones", async function () {
      const rows = await readAll(await loadFixture(deployAll));
      for (const variant of [1, 2]) {
        for (const archetype of [GRUNT, AGGRESSOR, SNIPER, SUPPORT, TURTLE]) {
          const line = rows
            .filter((r) => r.variant === variant && r.archetype === archetype)
            .sort((a, b) => a.level - b.level);
          const first = line[0];
          const last = line[line.length - 1];
          expect(last.cost - first.cost, `${last.key} vs ${first.key} cost`).to.be.greaterThanOrEqual(
            60,
          );
          expect(
            Number(last.attrs.hullPoints) * (100 - 0) /
              (100 - Number(last.attrs.damageReduction)),
            `${last.key} effective HP`,
          ).to.be.greaterThan(
            (Number(first.attrs.hullPoints) * 100) /
              (100 - Number(first.attrs.damageReduction)),
          );
        }
      }
    });

    it("the two factions play differently: variant 2 is tougher and shorter-ranged at every level", async function () {
      const rows = await readAll(await loadFixture(deployAll));
      const avg = (variant: number, f: (r: any) => number) => {
        const set = rows.filter(
          (r) => r.variant === variant && r.archetype !== RAMMER,
        );
        return set.reduce((s, r) => s + f(r), 0) / set.length;
      };
      expect(avg(2, (r) => Number(r.attrs.hullPoints))).to.be.greaterThan(
        avg(1, (r) => Number(r.attrs.hullPoints)),
      );
      expect(avg(2, (r) => Number(r.attrs.damageReduction))).to.be.greaterThan(
        avg(1, (r) => Number(r.attrs.damageReduction)),
      );
      expect(avg(2, (r) => Number(r.attrs.range))).to.be.lessThan(
        avg(1, (r) => Number(r.attrs.range)),
      );
      expect(avg(2, (r) => Number(r.attrs.movement))).to.be.lessThan(
        avg(1, (r) => Number(r.attrs.movement)),
      );
    });
  });

  describe("real configs through real AI turns", function () {
    const NODE_MATCH_ID_OFFSET = 2n ** 40n;
    const AI_SHIP_ID_OFFSET = 2n ** 40n;

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
        ...deployed,
        humanShips,
        humanGame,
        humanSinglePlayerMatch,
        singlePlayerMatchOther,
        human,
        publicClient,
        owner,
      };
    }

    type HumanShip = { at: [number, number]; downed?: boolean; primed?: boolean };
    type AIShip = { key: string; at: [number, number]; downed?: boolean };

    // Plays one AI turn for ai[0] (the config under test, by data-file key).
    async function run(sc: { ai: AIShip[]; humans: HumanShip[] }) {
      const f = await loadFixture(deployFixture);
      const configs = await f.aiEncounters.read.getAllAIShipConfigs();
      const idOfKey = (key: string) => {
        const name = starterContent.aiShipConfigs.find((c) => c.key === key)!.name;
        return configs.find((c) => c.name === name)!.id;
      };

      await f.maps.write.createPresetMap([[], MapMode.Both]);
      const mapId = await f.maps.read.mapCount();
      // placements are minted in scan order (ascending column): ai[i] at col 13 + i
      await f.aiEncounters.write.setMapPlacements([
        mapId,
        sc.ai.map((_, i) => ({ row: 0, col: 13 + i })),
        sc.ai.map((a) => idOfKey(a.key)),
      ]);
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

      const aiIds = sc.ai.map((_, i) => AI_SHIP_ID_OFFSET + 1n + BigInt(i));
      for (let i = 0; i < sc.ai.length; i++) {
        await setShipPosition(f.game.address, gameId, aiIds[i], ...sc.ai[i].at);
      }
      for (let i = 0; i < sc.humans.length; i++) {
        await setShipPosition(f.game.address, gameId, humanIds[i], ...sc.humans[i].at);
      }
      for (let i = 0; i < sc.ai.length; i++) {
        if (sc.ai[i].downed) await setShipHullPointsToZero(f.game.address, gameId, aiIds[i]);
      }
      for (let i = 0; i < sc.humans.length; i++) {
        if (sc.humans[i].primed) {
          await primeShipForRealDestruction(f.game.address, gameId, humanIds[i]);
        } else if (sc.humans[i].downed) {
          await setShipHullPointsToZero(f.game.address, gameId, humanIds[i]);
        }
      }
      await f.humanGame.write.moveShip(
        [gameId, humanIds[0], ...sc.humans[0].at, ActionType.Pass, 0n],
        { account: f.human.account },
      );

      const hash = await f.singlePlayerMatchOther.write.takeAITurn([gameId]);
      const receipt = await f.publicClient.waitForTransactionReceipt({ hash });
      const ev = parseEventLogs({
        abi: f.singlePlayerMatch.abi,
        logs: receipt.logs,
        eventName: "AITurnTaken",
      }).find((e: any) => e.args.shipId === aiIds[0])!;
      expect(ev, "the config under test took a turn").to.not.equal(undefined);
      const g = (await f.game.read.getGame([gameId])) as GameDataView;
      const at = g.shipPositions.find((p) => p.shipId === aiIds[0])!.position;
      return {
        action: Number(ev.args.actionType),
        target: ev.args.targetShipId as bigint,
        row: Number(at.row),
        col: Number(at.col),
        aiIds,
      };
    }

    it("a Level V variant 2 Support (heavy shields + Thruster) still reaches and repairs a distant ally", async function () {
      // Heavy shields alone would leave it crawling (movement 3); the Thruster
      // gives it movement 6, so it covers the 6 tiles and repairs (range 1).
      const r = await run({
        ai: [
          { key: "v2support5", at: [5, 14] },
          { key: "v2grunt", at: [5, 7], downed: true },
        ],
        humans: [{ at: [0, 0] }],
      });
      expect(r.action).to.equal(ActionType.FactionAbility);
      expect(r.target).to.equal(r.aiIds[1]);
      expect([r.row, r.col]).to.deep.equal([5, 8]);
    });

    it("a variant 1 Rammer covers ground fast and rams a downed enemy", async function () {
      // Movement 7: the downed enemy is 6 tiles away.
      const r = await run({
        ai: [{ key: "rammer", at: [5, 12] }],
        humans: [{ at: [0, 0] }, { at: [5, 6], downed: true }],
      });
      expect(r.action).to.equal(ActionType.FactionAbility);
      expect(r.target).to.equal(2n);
    });

    it("a variant 1 Turtle with Flak Array lays it down on a pair of enemies", async function () {
      const r = await run({
        ai: [{ key: "turtle3", at: [5, 10] }],
        humans: [{ at: [5, 8] }, { at: [6, 9] }],
      });
      expect(r.action).to.equal(ActionType.Special);
      expect(r.target).to.equal(0n);
    });

    it("a variant 2 Turtle with Drone Swarm reaches an enemy its gun can't", async function () {
      // Medium Mining Laser range 2-3; the enemy is 4 away, inside Swarm range 5.
      const r = await run({
        ai: [{ key: "v2turtle3", at: [5, 10] }],
        humans: [{ at: [5, 6] }],
      });
      expect(r.action).to.equal(ActionType.Special);
      expect(r.target).to.equal(1n);
    });

    it("a variant 1 top-level Aggressor finishes an adjacent doomed enemy with EMP", async function () {
      const r = await run({
        ai: [{ key: "aggressor5", at: [5, 10] }],
        humans: [{ at: [0, 0] }, { at: [5, 9], primed: true }],
      });
      expect(r.action).to.equal(ActionType.Special);
      expect(r.target).to.equal(2n);
    });

    it("a variant 2 Aggressor charges into melee and fires its Mining Drill", async function () {
      const r = await run({
        ai: [{ key: "v2aggressor3", at: [5, 12] }],
        humans: [{ at: [5, 8] }],
      });
      expect(r.action).to.equal(ActionType.Shoot);
      expect(r.target).to.equal(1n);
      // range 1: it stopped adjacent to the enemy at (5,8)
      expect(Math.abs(r.row - 5) + Math.abs(r.col - 8)).to.equal(1);
    });
  });
});

// Plays real single-player campaign matches on the Solidity stack and exports
// every step (human moves, AI turns) with the full resulting board, for the
// NEAR port's engine + AI differential test
// (near/crates/vt-core/tests/golden_games.rs).
//
// Ephemeral hardhat network only:
//   npx hardhat run scripts/near-golden/exportSinglePlayerGames.ts
// Env: GOLDEN_NODES (default 8), GOLDEN_MAX_STEPS (default 260).
//
// Written 2026-11-13.

import hre from "hardhat";
import { mkdirSync, writeFileSync } from "fs";
import path from "path";
import { parseEventLogs } from "viem";
import DeployModule from "../../ignition/modules/DeployAndConfig";

const OUT_DIR = path.join(__dirname, "../../near/golden");
const NODES = Number(process.env.GOLDEN_NODES ?? 8);
const MAX_STEPS = Number(process.env.GOLDEN_MAX_STEPS ?? 700);
// Seeded nodes end by score within a few rounds; replaying each seeded map as
// an extra node with this score cap makes games end by combat instead, which
// exercises destruction, reactor timers, Ram, revives and wipe-outs.
const COMBAT_MAX_SCORE = BigInt(process.env.GOLDEN_COMBAT_MAX_SCORE ?? 200);
const ActionType = { Pass: 0, Shoot: 1, Retreat: 2, Assist: 3, Special: 4, FactionAbility: 5 };

const big = (x: unknown) => JSON.parse(JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));

async function main() {
  if (hre.network.name !== "hardhat") throw new Error("hardhat network only");
  mkdirSync(OUT_DIR, { recursive: true });
  const [owner, human] = await hre.viem.getWalletClients();
  const publicClient = await hre.viem.getPublicClient();
  const d: any = await hre.ignition.deploy(DeployModule);

  const as = async (name: string, addr: `0x${string}`, wallet = human) =>
    hre.viem.getContractAt(name as any, addr, { client: { wallet } }) as any;
  const game = d.game;
  const spm = d.singlePlayerMatch;
  const humanSpm = await as("SinglePlayerMatch", spm.address);
  const humanGame = await as("Game", game.address);
  const humanShips = await as("Ships", d.ships.address);

  // ---- rules the Rust engine needs ----
  const variantTables: Record<string, unknown[]> = {};
  for (const v of [1, 2]) {
    const latest = Number(await d.shipAttributes.read.getLatestAttributesVersion([v]));
    variantTables[v] = [];
    for (let ver = 1; ver <= latest; ver++) {
      variantTables[v].push({ version: ver, data: await d.shipAttributes.read.getVariantAttributes([v, ver]) });
    }
  }
  const ramResolverAddr = await game.read.factionAbilityResolvers([1]);
  const repairResolverAddr = await game.read.factionAbilityResolvers([2]);
  const ram = await as("RamResolver", ramResolverAddr, owner);
  const repair = await as("RepairResolver", repairResolverAddr, owner);
  const rules = {
    healCapPercent: Number(await game.read.healCapPercent()),
    ramRange: Number(await ram.read.range()),
    repairRange: Number(await repair.read.range()),
    repairStrength: Number(await repair.read.strength()),
    variantTables,
  };

  // ---- unlock every node and buy ships ----
  await d.nodeMap.write.setIsAllowedToCompleteNodes([owner.account.address, true]);
  for (let n = 1n; n <= (await d.nodeMap.read.nodeCount()); n++) {
    await d.nodeMap.write.recordCompletion([human.account.address, n]);
  }
  const [, tierPrices] = await d.ships.read.getPurchaseInfo();
  for (let i = 0; i < 2; i++) {
    await humanShips.write.purchaseWithFlow([human.account.address, 4, human.account.address, 1], {
      value: tierPrices[4],
    });
  }
  await humanShips.write.constructAllMyShips();

  // Two passes over the first NODES seeded nodes: as seeded, then as a
  // combat variant (same map/cost cap, high score cap, alternating first mover).
  const plan: bigint[] = [];
  for (let nodeId = 1n; nodeId <= BigInt(NODES); nodeId++) plan.push(nodeId);
  for (let nodeId = 1n; nodeId <= BigInt(NODES); nodeId++) {
    const seeded: any = await d.nodeMap.read.getNode([nodeId]);
    await d.nodeMap.write.createNode([seeded.campaignId, seeded.mapId, [], seeded.costLimit, seeded.turnTime,
      COMBAT_MAX_SCORE, nodeId % 2n === 0n]);
    plan.push(await d.nodeMap.read.nodeCount());
  }

  const games: unknown[] = [];
  for (const nodeId of plan) {
    const node: any = await d.nodeMap.read.getNode([nodeId]);
    const currentCosts = await d.shipAttributes.read.getCurrentCostsVersion([1]);

    // Fleet: cheapest-first available ships under the cost cap, at most 4.
    const owned: bigint[] = await d.ships.read.getShipIdsOwned([human.account.address]);
    const avail: any[] = [];
    for (const id of owned) {
      const s: any = await d.ships.read.getShip([id]);
      if (s.shipData.constructed && !s.shipData.inFleet && s.shipData.timestampDestroyed === 0n &&
          s.traits.variant === 1 && s.shipData.costsVersion === currentCosts) avail.push(s);
    }
    avail.sort((a, b) => a.shipData.cost - b.shipData.cost || Number(a.id - b.id));
    // Rotate the pool per node so different games field different ships.
    const rot = Number(nodeId) * 3 % Math.max(avail.length, 1);
    const pool = avail.slice(rot).concat(avail.slice(0, rot));
    const fleet: any[] = [];
    let total = 0n;
    for (const s of pool) {
      if (fleet.length >= 4) break;
      if (total + BigInt(s.shipData.cost) <= node.costLimit) {
        fleet.push(s);
        total += BigInt(s.shipData.cost);
      }
    }
    if (fleet.length === 0) continue;

    let zone: any[] = await d.maps.read.getCreatorZonePositions([node.mapId]);
    if (zone.length === 0) {
      zone = [];
      for (let r = 0; r < 11; r++) for (let c = 0; c <= 3; c++) zone.push({ row: r, col: c });
    }
    const positions = fleet.map((_, i) => zone[Math.floor((i * zone.length) / fleet.length)]);
    await humanSpm.write.startNodeMatch([nodeId, fleet.map((s) => s.id), positions]);
    const gameId = (2n ** 40n) + (await spm.read.nodeMatchCount());

    const specials = new Map<bigint, number>();
    for (const s of fleet) specials.set(s.id, Number(s.equipment.special));

    const snapshot = async () => {
      const board: bigint[] = await game.read.getAIBoard([gameId]);
      const g: any = await game.read.getGame([gameId]);
      const scoring: any[] = await d.maps.read.getGameScoringPositions([gameId]);
      return {
        board: board.map((w) => "0x" + w.toString(16)),
        ended: g.metadata.ended,
        winnerIsHuman: g.metadata.winner.toLowerCase() === human.account.address.toLowerCase(),
        winnerIsAI: g.metadata.winner.toLowerCase() === spm.address.toLowerCase(),
        creatorScore: g.creatorScore.toString(),
        joinerScore: g.joinerScore.toString(),
        round: g.turnState.currentRound.toString(),
        humanTurn: g.turnState.currentTurn.toLowerCase() === human.account.address.toLowerCase(),
        lastMove: big(g.lastMove),
        positions: g.shipPositions.map((p: any) => [p.shipId.toString(), p.position.row, p.position.col, p.isCreator, p.status]),
        scoring: scoring.map((s: any) => [s.row, s.col, s.points, s.onlyOnce]),
      };
    };

    const aiInfo: Record<string, unknown> = {};
    const initialBoard: bigint[] = await game.read.getAIBoard([gameId]);
    for (let i = 7; i < initialBoard.length; i += 2) {
      const id = initialBoard[i];
      if (id >= 2n ** 40n) {
        const info: any = await spm.read.aiShipInfo([id]);
        aiInfo[id.toString()] = { archetype: Number(info[0]), variant: Number(info[1]), special: Number(info[2]) };
      }
    }
    const [blocked, , impassable] = (await d.maps.read.getGameMapState([gameId])) as any[];

    const record: any = {
      nodeId: nodeId.toString(),
      gameId: gameId.toString(),
      maxScore: node.maxScore.toString(),
      creatorGoesFirst: node.creatorGoesFirst,
      map: { blocked: big(blocked), impassable: big(impassable) },
      aiInfo,
      initial: await snapshot(),
      steps: [] as unknown[],
    };

    const tryMove = async (shipId: bigint, row: number, col: number, action: number, target: bigint) => {
      try {
        await publicClient.simulateContract({
          address: game.address, abi: game.abi, functionName: "moveShip",
          args: [gameId, shipId, row, col, action, target], account: human.account,
        });
        return true;
      } catch {
        return false;
      }
    };

    for (let step = 0; step < MAX_STEPS; step++) {
      const g: any = await game.read.getGame([gameId]);
      if (g.metadata.ended) break;
      const humanTurn = g.turnState.currentTurn.toLowerCase() === human.account.address.toLowerCase();
      if (!humanTurn) {
        const hash = await spm.write.takeAITurn([gameId]);
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        const logs = parseEventLogs({ abi: spm.abi, logs: receipt.logs }) as any[];
        const aiLogs = logs
          .filter((l) => l.eventName === "AITurnTaken" || l.eventName === "AIDecisionFailed")
          .map((l) => ({ event: l.eventName, shipId: l.args.shipId.toString(),
                         action: l.args.actionType ?? null, target: l.args.targetShipId?.toString() ?? null }));
        record.steps.push({ kind: "ai", aiLogs, snapshot: await snapshot() });
        continue;
      }

      // ---- human policy ----
      const n = g.shipIds.length;
      const ships = [...Array(n).keys()].map((i) => ({
        id: g.shipIds[i] as bigint, a: g.shipAttributes[i], p: g.shipPositions[i].position, creator: g.shipPositions[i].isCreator,
      }));
      const moved = new Set<bigint>(g.creatorMovedShipIds);
      const mine = ships.filter((s) => s.creator && s.a.hullPoints > 0 && !moved.has(s.id));
      const enemies = ships.filter((s) => !s.creator).sort((x, y) => x.a.hullPoints - y.a.hullPoints);
      const allies = ships.filter((s) => s.creator);
      if (mine.length === 0) break; // shouldn't happen on our turn
      const me = mine[step % mine.length];
      let chosen: [number, number, number, bigint] | null = null;
      const here: [number, number] = [me.p.row, me.p.col];

      const candidatesFrom = (r: number, c: number, withSpecials: boolean) => {
        const out: [number, number, number, bigint][] = [];
        for (const e of enemies) if (e.a.hullPoints === 0) out.push([r, c, ActionType.FactionAbility, e.id]);
        for (const e of enemies) out.push([r, c, ActionType.Shoot, e.id]);
        if (withSpecials && (specials.get(me.id) ?? 0) !== 0) {
          for (const e of enemies) out.push([r, c, ActionType.Special, e.id]);
          for (const a of allies) if (a.a.hullPoints < a.a.maxHullPoints) out.push([r, c, ActionType.Special, a.id]);
          out.push([r, c, ActionType.Special, 0n]);
        }
        return out;
      };
      // Badly damaged ships sometimes retreat (exercises removal-by-retreat).
      if (me.a.hullPoints * 5 < me.a.maxHullPoints && step % 3 === 0 &&
          (await tryMove(me.id, here[0], here[1], ActionType.Retreat, 0n))) {
        chosen = [here[0], here[1], ActionType.Retreat, 0n];
      }
      // Specials only every other turn, so plain shooting dominates.
      for (const cand of chosen ? [] : candidatesFrom(...here, step % 2 === 1)) {
        if (await tryMove(me.id, ...cand)) { chosen = cand; break; }
      }
      if (!chosen) {
        // Step toward the nearest enemy.
        const target = [...enemies].sort((x, y) =>
          Math.abs(x.p.row - me.p.row) + Math.abs(x.p.col - me.p.col) - (Math.abs(y.p.row - me.p.row) + Math.abs(y.p.col - me.p.col)))[0];
        let fallback: [number, number, number, bigint] | null = null;
        for (let k = me.a.movement; k >= 1 && target && !chosen; k--) {
          let dr = target.p.row - me.p.row, dc = target.p.col - me.p.col;
          let budget = k;
          const useC = Math.min(Math.abs(dc), budget); budget -= useC;
          const useR = Math.min(Math.abs(dr), budget);
          const r = me.p.row + Math.sign(dr) * useR, c = me.p.col + Math.sign(dc) * useC;
          if (r === me.p.row && c === me.p.col) continue;
          for (const cand of candidatesFrom(r, c, false).filter((x) => x[2] === ActionType.Shoot)) {
            if (await tryMove(me.id, ...cand)) { chosen = cand; break; }
          }
          if (!chosen && !fallback && (await tryMove(me.id, r, c, ActionType.Pass, 0n))) fallback = [r, c, ActionType.Pass, 0n];
        }
        chosen = chosen ?? fallback ?? [here[0], here[1], ActionType.Pass, 0n];
      }
      await humanGame.write.moveShip([gameId, me.id, chosen[0], chosen[1], chosen[2], chosen[3]]);
      record.steps.push({
        kind: "human",
        move: { shipId: me.id.toString(), row: chosen[0], col: chosen[1], action: chosen[2], target: chosen[3].toString() },
        snapshot: await snapshot(),
      });
    }
    console.log(`node ${nodeId}: ${record.steps.length} steps, ended=${record.steps.at(-1)?.snapshot.ended}`);
    games.push(record);
  }

  writeFileSync(
    path.join(OUT_DIR, "single_player_games.json"),
    JSON.stringify({ generatedAt: new Date().toISOString(), rules: big(rules), games }),
  );
  console.log(`wrote ${games.length} games`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

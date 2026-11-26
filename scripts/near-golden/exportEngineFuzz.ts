// Differential fuzzing for the NEAR port's engine + AI (2026-11-14).
//
// Plays randomized single-player games on the unmodified Solidity stack and
// exports every step in the same format as exportSinglePlayerGames.ts, plus
// rejected moves, for near/crates/vt-core/tests/golden_games.rs:
//   - random maps: blocked, impassable and scoring tiles (with only-once and
//     multi-point tiles) in the middle columns;
//   - random AI fleets: 4-8 of the 64 seeded configs (both variants: every
//     archetype, special and faction ability) on random joiner tiles;
//   - random human fleets of 2-6 ships, random first mover, combat-length
//     score caps;
//   - a random human policy that tries every action type (shoot, special,
//     assist, retreat, faction ability, pass) with random destinations and
//     targets, and on half of its turns also submits an arbitrary
//     move that Solidity rejects, recording the custom error so the Rust
//     engine must reject it with the same error and leave the state as is.
//
// Deterministic for a given FUZZ_SEED. Ephemeral hardhat network only:
//   npx hardhat run scripts/near-golden/exportEngineFuzz.ts
// Env: FUZZ_SEED (default 20261114), FUZZ_GAMES (default 60), FUZZ_MAX_STEPS (default 400).

import hre from "hardhat";
import { mkdirSync, writeFileSync } from "fs";
import path from "path";
import { BaseError, ContractFunctionRevertedError, parseEventLogs } from "viem";
import DeployModule from "../../ignition/modules/DeployAndConfig";

const OUT = path.join(__dirname, "../../near/golden/engine_fuzz.json");
const GAMES = Number(process.env.FUZZ_GAMES ?? 60);
const MAX_STEPS = Number(process.env.FUZZ_MAX_STEPS ?? 400);
let seed = Number(process.env.FUZZ_SEED ?? 20261114) >>> 0;
const rnd = (n: number) => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed % n;
};
const pick = <T,>(a: T[]) => a[rnd(a.length)];
const ActionType = { Pass: 0, Shoot: 1, Retreat: 2, Assist: 3, Special: 4, FactionAbility: 5 };
const big = (x: unknown) => JSON.parse(JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));

async function main() {
  if (hre.network.name !== "hardhat") throw new Error("hardhat network only");
  mkdirSync(path.dirname(OUT), { recursive: true });
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

  // ---- rules (same shape as exportSinglePlayerGames.ts) ----
  const variantTables: Record<string, unknown[]> = {};
  for (const v of [1, 2]) {
    const latest = Number(await d.shipAttributes.read.getLatestAttributesVersion([v]));
    variantTables[v] = [];
    for (let ver = 1; ver <= latest; ver++) {
      variantTables[v].push({ version: ver, data: await d.shipAttributes.read.getVariantAttributes([v, ver]) });
    }
  }
  const ram = await as("RamResolver", await game.read.factionAbilityResolvers([1]), owner);
  const repair = await as("RepairResolver", await game.read.factionAbilityResolvers([2]), owner);
  const rules = {
    healCapPercent: Number(await game.read.healCapPercent()),
    ramRange: Number(await ram.read.range()),
    repairRange: Number(await repair.read.range()),
    repairStrength: Number(await repair.read.strength()),
    variantTables,
  };

  // ---- ships: two 60-packs of variant 1 (three exceed constructAllMyShips' gas) ----
  const [, tierPrices] = await d.ships.read.getPurchaseInfo();
  for (let i = 0; i < 2; i++) {
    await humanShips.write.purchaseWithFlow([human.account.address, 4, human.account.address, 1], { value: tierPrices[4] });
  }
  await humanShips.write.constructAllMyShips();
  const configCount = Number(await d.aiEncounters.read.aiShipConfigCount());
  const campaignId = 1n;

  // Hardhat reports reverts as an RPC error whose message carries the decoded
  // reason; viem's typed decoding only works against a real node.
  const errorOf = (e: unknown): string => {
    let c: any = e;
    for (let k = 0; c && k < 8; k++, c = c.cause) {
      const det = String(c.details ?? c.message ?? "");
      const custom = det.match(/reverted with custom error '([A-Za-z0-9_]+)\(/);
      if (custom) return custom[1];
      const panic = det.match(/reverted with panic code (0x[0-9a-f]+)/);
      if (panic) return `panic:${panic[1]}`;
      const reason = det.match(/reverted with reason string '([^']*)'/);
      if (reason) return `reason:${reason[1]}`;
    }
    if (e instanceof BaseError) {
      const rev = e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
      if (rev?.data?.errorName) return rev.data.errorName;
      if (rev?.signature) return `sig:${rev.signature}`;
      if (rev?.reason) return `reason:${rev.reason}`;
    }
    return "unknown";
  };

  const games: unknown[] = [];
  let rejectedTotal = 0;
  for (let gi = 0; gi < GAMES; gi++) {
    // ---- random map (middle columns only, so deployment stays possible) ----
    const cells = (count: number) => {
      const out: { row: number; col: number }[] = [];
      for (let k = 0; k < count; k++) out.push({ row: rnd(11), col: 4 + rnd(9) });
      return out;
    };
    const scoring = cells(rnd(6)).map((c) => ({ ...c, points: 1 + rnd(3), onlyOnce: rnd(3) === 0 }));
    await d.maps.write.createFullPresetMap([cells(rnd(14)), cells(rnd(10)), scoring, 1]);
    const mapId = await d.maps.read.mapCount();

    // ---- random AI fleet on joiner tiles ----
    const aiCount = 4 + rnd(5);
    const placed = new Set<string>();
    const positions: { row: number; col: number }[] = [];
    const configs: bigint[] = [];
    while (positions.length < aiCount) {
      const p = { row: rnd(11), col: 13 + rnd(4) };
      const key = `${p.row},${p.col}`;
      if (placed.has(key)) continue;
      placed.add(key);
      positions.push(p);
      configs.push(BigInt(1 + rnd(configCount)));
    }
    await d.aiEncounters.write.setMapPlacements([mapId, positions, configs]);
    const maxScore = BigInt(60 + rnd(300));
    await d.nodeMap.write.createNode([campaignId, mapId, [], 5000n, 600n, maxScore, rnd(2) === 0]);
    const nodeId = await d.nodeMap.read.nodeCount();

    // ---- random human fleet ----
    const owned: bigint[] = await d.ships.read.getShipIdsOwned([human.account.address]);
    const avail: bigint[] = [];
    for (const id of owned) {
      const s: any = await d.ships.read.getShip([id]);
      if (s.shipData.constructed && !s.shipData.inFleet && s.shipData.timestampDestroyed === 0n) avail.push(id);
    }
    if (avail.length < 2) break;
    const fleet: bigint[] = [];
    const want = 2 + rnd(5);
    while (fleet.length < Math.min(want, avail.length)) {
      const id = pick(avail);
      if (!fleet.includes(id)) fleet.push(id);
    }
    const humanPos: { row: number; col: number }[] = [];
    const used = new Set<string>();
    while (humanPos.length < fleet.length) {
      const p = { row: rnd(11), col: rnd(4) };
      const key = `${p.row},${p.col}`;
      if (!used.has(key)) {
        used.add(key);
        humanPos.push(p);
      }
    }
    try {
      await humanSpm.write.startNodeMatch([nodeId, fleet, humanPos]);
    } catch (e) {
      console.log(`game ${gi}: start rejected (${errorOf(e)}), skipping`);
      continue;
    }
    const gameId = (2n ** 40n) + (await spm.read.nodeMatchCount());

    const snapshot = async () => {
      const board: bigint[] = await game.read.getAIBoard([gameId]);
      const g: any = await game.read.getGame([gameId]);
      const sc: any[] = await d.maps.read.getGameScoringPositions([gameId]);
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
        scoring: sc.map((s: any) => [s.row, s.col, s.points, s.onlyOnce]),
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
      maxScore: maxScore.toString(),
      creatorGoesFirst: (await d.nodeMap.read.getNode([nodeId])).creatorGoesFirst,
      map: { blocked: big(blocked), impassable: big(impassable) },
      aiInfo,
      initial: await snapshot(),
      steps: [] as unknown[],
    };

    const simulate = async (shipId: bigint, row: number, col: number, action: number, target: bigint): Promise<string | null> => {
      try {
        await publicClient.simulateContract({
          address: game.address, abi: game.abi, functionName: "moveShip",
          args: [gameId, shipId, row, col, action, target], account: human.account,
        });
        return null;
      } catch (e) {
        return errorOf(e);
      }
    };

    let stuck = 0;
    for (let step = 0; step < MAX_STEPS; step++) {
      const g: any = await game.read.getGame([gameId]);
      if (g.metadata.ended) break;
      if (g.turnState.currentTurn.toLowerCase() !== human.account.address.toLowerCase()) {
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

      const ids: bigint[] = g.shipIds;
      const moved = new Set<bigint>(g.creatorMovedShipIds);
      const mine = ids
        .map((id: bigint, i: number) => ({ id, a: g.shipAttributes[i], p: g.shipPositions[i].position, creator: g.shipPositions[i].isCreator }))
        .filter((s: any) => s.creator && !moved.has(s.id));
      if (mine.length === 0) break;
      const me = pick(mine);
      const randomMove = (): [bigint, number, number, number, bigint] => {
        const m = Number(me.a.movement) + 1;
        const dr = rnd(2 * m + 1) - m;
        const dc = rnd(2 * m + 1) - m;
        // Retreat is rare: it removes a ship, and frequent retreats end games
        // in a few steps.
        const action = rnd(30) === 0 ? ActionType.Retreat
          : pick([ActionType.Pass, ActionType.Shoot, ActionType.Shoot, ActionType.Shoot, ActionType.Special, ActionType.Special,
                  ActionType.Assist, ActionType.FactionAbility]);
        const target = rnd(8) === 0 ? 0n : rnd(12) === 0 ? 999n : pick(ids);
        const shipId = rnd(10) === 0 ? pick(ids) : me.id; // sometimes not ours / already moved
        return [shipId, me.p.row + dr, me.p.col + dc, action, target];
      };

      // Half the time: an arbitrary move Solidity rejects.
      if (rnd(2) === 0) {
        for (let t = 0; t < 12; t++) {
          const mv = randomMove();
          const err = await simulate(...mv);
          if (err) {
            record.steps.push({
              kind: "human_rejected",
              move: { shipId: mv[0].toString(), row: mv[1], col: mv[2], action: mv[3], target: mv[4].toString() },
              error: err,
            });
            rejectedTotal++;
            break;
          }
        }
      }

      // Then a legal move: actions with targets from here and from random
      // reachable tiles first (shuffled), then plain moves, retreat rarely.
      // Fallback: pass in place.
      const shuffle = <T,>(a: T[]) => {
        for (let k = a.length - 1; k > 0; k--) {
          const j = rnd(k + 1);
          [a[k], a[j]] = [a[j], a[k]];
        }
        return a;
      };
      const m = Number(me.a.movement);
      const tiles: [number, number][] = [[me.p.row, me.p.col]];
      for (let t = 0; t < 6; t++) {
        const dr = rnd(2 * m + 1) - m;
        const rest = m - Math.abs(dr);
        const dc = rnd(2 * rest + 1) - rest;
        tiles.push([me.p.row + dr, me.p.col + dc]);
      }
      const targeted: [bigint, number, number, number, bigint][] = [];
      for (const [r, c] of tiles.slice(0, 3)) {
        for (const action of [ActionType.Shoot, ActionType.Special, ActionType.Assist, ActionType.FactionAbility]) {
          for (const t of ids) targeted.push([me.id, r, c, action, t]);
          if (action === ActionType.Special) targeted.push([me.id, r, c, action, 0n]);
        }
      }
      const plain: [bigint, number, number, number, bigint][] = tiles.slice(1).map(([r, c]) => [me.id, r, c, ActionType.Pass, 0n]);
      const candidates = [...shuffle(targeted).slice(0, 40), ...shuffle(plain),
        [me.id, me.p.row, me.p.col, ActionType.Pass, 0n] as [bigint, number, number, number, bigint],
        [me.id, me.p.row, me.p.col, ActionType.Retreat, 0n] as [bigint, number, number, number, bigint]];
      if (rnd(25) === 0) candidates.unshift([me.id, me.p.row, me.p.col, ActionType.Retreat, 0n]);
      let chosen: [bigint, number, number, number, bigint] | null = null;
      for (const mv of candidates) {
        if ((await simulate(...mv)) === null) {
          chosen = mv;
          break;
        }
      }
      // A disabled ship that can't even retreat: let the next human turn pick
      // another ship; give up on the game if none can move.
      if (!chosen) {
        stuck++;
        if (stuck > 10) break;
        continue;
      }
      stuck = 0;
      await humanGame.write.moveShip([gameId, ...chosen]);
      record.steps.push({
        kind: "human",
        move: { shipId: chosen[0].toString(), row: chosen[1], col: chosen[2], action: chosen[3], target: chosen[4].toString() },
        snapshot: await snapshot(),
      });
    }
    console.log(`game ${gi} (map ${mapId}, ${fleet.length} vs ${aiCount}): ${record.steps.length} steps, ended=${(record.steps.at(-1) as any)?.snapshot?.ended}`);
    games.push(record);
  }

  writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), fuzzSeed: process.env.FUZZ_SEED ?? "20261114", rules: big(rules), games }));
  console.log(`wrote ${games.length} games, ${rejectedTotal} rejected moves, to ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

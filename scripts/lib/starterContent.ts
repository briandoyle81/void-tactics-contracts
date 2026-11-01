// Shared by scripts/syncStarterContent.ts (seed -> chain) and
// scripts/exportStarterContent.ts (chain -> seed): reading a deployment
// folder and working out which on-chain id belongs to which seed key.
import fs from "fs";
import path from "path";
import { getAddress, type Address } from "viem";

export const DATA_DIR = path.join(__dirname, "..", "..", "ignition", "data");
export const SEED_FILES = {
  singlePlayer: path.join(DATA_DIR, "singlePlayerStarterContent.json"),
  roguelike: path.join(DATA_DIR, "roguelikeStarterContent.json"),
  pvp: path.join(DATA_DIR, "pvpStarterContent.json"),
};
export const MAP_MODE: Record<string, number> = { PvP: 0, PvE: 1, Both: 2 };
export const NODE_KIND: Record<string, number> = { Combat: 0, Resupply: 1 };
// Must match DeployAndConfig.ts (it creates exactly one roguelike campaign).
export const ROGUELIKE_CAMPAIGN_ID = 1n;
export const WIN_EFFECT_CONTRACTS: Record<string, string> = {
  DEC_BONUS_WIN_EFFECT: "DECBonusWinEffect",
  HEAL_ABOVE_FLOOR_WIN_EFFECT: "HealAboveFloorWinEffect",
  SHIP_GRANT_WIN_EFFECT: "ShipGrantWinEffect",
};

export type Pos = { row: number; col: number };
export type ScoringPos = Pos & { points: number; onlyOnce: boolean };
export type SyncState = {
  maps: Record<string, string>;
  roguelikeNodes: Record<string, string>;
  ignored?: { maps?: string[]; roguelikeNodes?: string[] };
};

export const cap = (k: string) => `${k[0].toUpperCase()}${k.slice(1)}`;
export const posKey = (p: Pos) => `${Number(p.row)},${Number(p.col)}`;
export const posSet = (ps: readonly Pos[] | undefined) =>
  [...(ps ?? [])].map(posKey).sort().join(" ");
export const scoringSet = (ps: readonly ScoringPos[] | undefined) =>
  [...(ps ?? [])]
    .map((p) => `${posKey(p)}:${Number(p.points)}:${p.onlyOnce}`)
    .sort()
    .join(" ");
export const toPositions = (ps: readonly Pos[] | undefined) =>
  (ps ?? []).map((p) => ({ row: Number(p.row), col: Number(p.col) }));
export const toScoring = (ps: readonly ScoringPos[] | undefined) =>
  (ps ?? []).map((p) => ({
    row: Number(p.row),
    col: Number(p.col),
    points: Number(p.points),
    onlyOnce: p.onlyOnce,
  }));

export function readJson(file: string) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// Confirmed nonce per completed call future, and readEventArgument results.
export function readJournal(file: string) {
  const nonceByHash = new Map<string, number>();
  const confirmedNonce = new Map<string, number>();
  const completed = new Set<string>();
  const readResults = new Map<string, bigint>();
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    const id: string | undefined = msg.futureId;
    switch (msg.type) {
      case "TRANSACTION_SEND":
        nonceByHash.set(msg.transaction.hash, msg.nonce);
        break;
      case "TRANSACTION_CONFIRM":
        if (nonceByHash.has(msg.hash))
          confirmedNonce.set(id!, nonceByHash.get(msg.hash)!);
        break;
      case "CALL_EXECUTION_STATE_COMPLETE":
        if (msg.result?.type === "SUCCESS") completed.add(id!);
        break;
      case "READ_EVENT_ARGUMENT_EXECUTION_STATE_INITIALIZE":
        if (msg.result?._kind === "bigint")
          readResults.set(id!, BigInt(msg.result.value));
        break;
      case "WIPE_APPLY":
        completed.delete(id!);
        confirmedNonce.delete(id!);
        readResults.delete(id!);
        break;
    }
  }
  return { confirmedNonce, completed, readResults };
}

// Ids for keys whose creation futures ran, numbered 1..n by nonce order.
export function idsFromJournal(
  journal: ReturnType<typeof readJournal>,
  keys: string[],
  futureIdFor: (key: string) => string,
): Map<string, bigint> {
  const found = keys
    .map((key) => ({ key, futureId: futureIdFor(key) }))
    .filter(({ futureId }) => journal.completed.has(futureId))
    .map(({ key, futureId }) => {
      const nonce = journal.confirmedNonce.get(futureId);
      if (nonce === undefined)
        throw new Error(`No confirmed transaction in the journal for ${futureId}`);
      return { key, nonce };
    })
    .sort((a, b) => a.nonce - b.nonce);
  return new Map(found.map(({ key }, i) => [key, BigInt(i + 1)]));
}

// Everything about a deployment folder that maps seed keys to chain ids.
export function loadDeployment(deployDir: string) {
  const journalPath = path.join(deployDir, "journal.jsonl");
  const syncStatePath = path.join(deployDir, "content-sync.json");
  if (!fs.existsSync(journalPath))
    throw new Error(`No deployment journal at ${journalPath}`);
  const deployed: Record<string, string> = readJson(
    path.join(deployDir, "deployed_addresses.json"),
  );
  const addressOf = (name: string): Address => {
    const a = deployed[`DeployModule#${name}`];
    if (!a) throw new Error(`DeployModule#${name} missing from deployed_addresses.json`);
    return getAddress(a);
  };

  const sp = readJson(SEED_FILES.singlePlayer);
  const rl = readJson(SEED_FILES.roguelike);
  const pvp = readJson(SEED_FILES.pvp);
  // Same order as DeployAndConfig.ts.
  const allMaps: any[] = [...sp.maps, ...rl.maps, ...pvp.maps];
  const allPlacements: any[] = [...sp.mapPlacements, ...rl.mapPlacements];

  const journal = readJournal(journalPath);
  // "ignored": on-chain ids that belong to no seed entry (e.g. a duplicate
  // left by a failed run), so they don't count as unknown.
  const syncState: SyncState = fs.existsSync(syncStatePath)
    ? readJson(syncStatePath)
    : { maps: {}, roguelikeNodes: {} };

  const mapIds = idsFromJournal(
    journal,
    allMaps.map((m) => m.key),
    (k) => `DeployModule#Create${cap(k)}Map`,
  );
  for (const [k, id] of Object.entries(syncState.maps)) mapIds.set(k, BigInt(id));
  const nodeIds = idsFromJournal(
    journal,
    rl.nodes.map((n: any) => n.key),
    (k) => `DeployModule#CreateRoguelike${cap(k)}Node`,
  );
  for (const [k, id] of Object.entries(syncState.roguelikeNodes))
    nodeIds.set(k, BigInt(id));

  const configIds = new Map<string, bigint>();
  for (const c of sp.aiShipConfigs) {
    const id = journal.readResults.get(`DeployModule#Read${cap(c.key)}ConfigId`);
    if (id !== undefined) configIds.set(c.key, id);
  }

  return {
    deployDir,
    journal,
    syncState,
    syncStatePath,
    addressOf,
    sp,
    rl,
    pvp,
    allMaps,
    allPlacements,
    mapIds,
    nodeIds,
    configIds,
  };
}

// A ShipGrantWinEffect.ShipGrant in the seed's `shipGrant` shape, from either
// the chain (viem's decoded struct) or a seed entry, so the two compare equal.
export const toShipGrant = (g: any) => ({
  name: g.name,
  equipment: {
    mainWeapon: Number(g.equipment.mainWeapon),
    armor: Number(g.equipment.armor),
    shields: Number(g.equipment.shields),
    special: Number(g.equipment.special),
  },
  colors: Object.fromEntries(
    ["h1", "s1", "l1", "h2", "s2", "l2"].map((k) => [k, Number(g.colors[k])]),
  ),
  variant: Number(g.variant),
  accuracy: Number(g.accuracy),
  hull: Number(g.hull),
  speed: Number(g.speed),
  shipsDestroyed: Number(g.shipsDestroyed),
  shiny: g.shiny,
  isFreeShip: g.isFreeShip,
  oncePerAddress: g.oncePerAddress,
});

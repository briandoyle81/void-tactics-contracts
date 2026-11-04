// The reverse of scripts/syncStarterContent.ts (written 2026-10-26): reads a
// deployment's maps, AI ship configs, AI placements and roguelike campaign
// from chain and writes them into the seed files in ignition/data/, so edits
// made in the frontend's editors survive the next full deploy.
//
// Run it against the live deployment before every full redeploy
// (scripts/ignition-deploy-retry.sh does this for you). Without it, a fresh
// deploy seeds from ignition/data/ and every on-chain edit is lost.
//
// What it exports (chain = source of truth):
//   - Maps (all three seed files): blocked/impassable/scoring tiles, mode,
//     creator/joiner zones. Maps on chain that no seed lists are appended to
//     the roguelike seed as "chainMap<id>".
//   - AI ship configs: name, equipment, traits, archetype. New ones are
//     appended as "chainConfig<id>".
//   - AI placements (singlePlayer + roguelike): each map's fleet.
//   - Roguelike campaign 1: settings, root, nodes, edges and win effects.
//     New nodes are appended as "chainNode<id>".
//   - Roguelike reward ships (ShipGrantWinEffect grants, the `shipGrant` field).
// Kept from the seed: keys, map names, node titles and descriptions (these
// are frontend-only and aren't on chain).
// Not exported: single-player NodeMap campaigns.
//
// Usage:
//   npx hardhat run scripts/exportStarterContent.ts --network base-sepolia
//     Prints what would change. Writes nothing.
//   WRITE=true npx hardhat run scripts/exportStarterContent.ts --network base-sepolia
//     Writes the seed files.
//
// Env:
//   WRITE            "true" to write the seed files. Anything else: report only.
//   DEPLOYMENT_ID    Deployment folder to read (default chain-<chainId>).
//   DEPLOYMENT_DIR   Full path to a deployment folder instead (e.g. an older
//                    deployment's journal restored from git).
//   ONLY_IF_FRESH    "true": do nothing if the deployment folder is on disk
//                    (scripts/ignition-deploy-retry.sh uses this).
// If the deployment folder isn't on disk (a fresh deploy removes it first),
// the copy committed at git HEAD is read instead.
//
// ABIs (2026-11-01): the chain is read with the ABIs Ignition saved when the
// old contracts were deployed (artifacts/DeployModule#<Name>.json in the
// deployment folder), not the ones compiled from today's sources. A full
// redeploy usually follows a struct change, and decoding the old contracts
// with the new layout fails or misreads fields (e.g. 653a918 dropped
// h3/s3/l3 from Colors, so the new ABI couldn't decode the old getGrant or
// getAIShipConfig). The values are then converted to today's seed shape as
// usual. The compiled ABI is only a fallback for a contract with no saved one.
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import hre from "hardhat";
import { getAddress, type Abi, type Address } from "viem";
import {
  MAP_MODE,
  NODE_KIND,
  ROGUELIKE_CAMPAIGN_ID,
  SEED_FILES,
  WIN_EFFECT_CONTRACTS,
  loadDeployment,
  posSet,
  scoringSet,
  toPositions,
  toScoring,
  toShipGrant,
} from "./lib/starterContent";

const WRITE = process.env.WRITE === "true";
// Every contract this script reads (see `contract` below).
const READ_CONTRACTS = ["Maps", "AIEncounters", "RoguelikeNodeMap", "ShipGrantWinEffect"];
const MODE_NAME = Object.fromEntries(Object.entries(MAP_MODE).map(([k, v]) => [v, k]));
const KIND_NAME = Object.fromEntries(Object.entries(NODE_KIND).map(([k, v]) => [v, k]));

async function main() {
  const publicClient = await hre.viem.getPublicClient();
  const chainId = await publicClient.getChainId();
  const deploymentId = process.env.DEPLOYMENT_ID || `chain-${chainId}`;
  let deployDir =
    process.env.DEPLOYMENT_DIR ||
    path.join(__dirname, "..", "ignition", "deployments", deploymentId);
  // The deploy wrapper sets this: with the folder on disk it's resuming a
  // deploy, whose chain may be only part-seeded, so don't export from it.
  if (process.env.ONLY_IF_FRESH === "true" && fs.existsSync(path.join(deployDir, "journal.jsonl"))) {
    console.log(`${deploymentId} folder exists (resuming a deploy): skipping the content export.`);
    return;
  }
  // Before a fresh full deploy the old deployment folder has already been
  // removed, so read the last committed copy of it instead.
  if (!process.env.DEPLOYMENT_DIR && !fs.existsSync(path.join(deployDir, "journal.jsonl"))) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "starter-content-export-"));
    const files = [
      "journal.jsonl",
      "deployed_addresses.json",
      "content-sync.json",
      ...READ_CONTRACTS.map((n) => `artifacts/DeployModule#${n}.json`),
    ];
    fs.mkdirSync(path.join(tmp, "artifacts"));
    for (const f of files) {
      try {
        const data = execFileSync("git", ["show", `HEAD:ignition/deployments/${deploymentId}/${f}`], {
          maxBuffer: 1 << 30,
          stdio: ["ignore", "pipe", "ignore"],
        });
        fs.writeFileSync(path.join(tmp, f), data);
      } catch {
        if (f !== "content-sync.json" && !f.startsWith("artifacts/"))
          throw new Error(`No ${deploymentId} deployment in ignition/deployments/ or in git HEAD: nothing to export.`);
      }
    }
    console.log(`No ${deploymentId} folder on disk: reading the copy committed at HEAD.`);
    deployDir = tmp;
  }
  const d = loadDeployment(deployDir);
  const { sp, rl, pvp, mapIds, nodeIds, configIds, syncState } = d;

  const contract = async (name: string) => {
    const saved = path.join(deployDir, "artifacts", `DeployModule#${name}.json`);
    if (!fs.existsSync(saved)) console.warn(`  (no saved ABI for ${name}; using the compiled one)`);
    return {
      address: d.addressOf(name),
      abi: (fs.existsSync(saved)
        ? JSON.parse(fs.readFileSync(saved, "utf8")).abi
        : (await hre.artifacts.readArtifact(name)).abi) as Abi,
    };
  };
  const maps = await contract("Maps");
  const aiEncounters = await contract("AIEncounters");
  const nodeMap = await contract("RoguelikeNodeMap");
  const read = (c: { address: Address; abi: Abi }, functionName: string, args: unknown[] = []) =>
    publicClient.readContract({ ...c, functionName, args }) as Promise<any>;

  // An id with no known key whose "chain<Kind><id>" entry an earlier export
  // already appended to the seed (and no other id on this deployment owns).
  const reuse = (key: string, entries: Map<string, any>, ids: Map<string, bigint>) =>
    entries.has(key) && !ids.has(key) ? key : undefined;

  let changes = 0;
  const change = (msg: string) => {
    changes++;
    console.log(`  ${msg}`);
  };
  console.log(`Deployment ${path.basename(deployDir)} (${d.addressOf("Maps")} Maps)`);

  // ---- Maps ------------------------------------------------------------------
  console.log("\nMaps:");
  const chainMapCount = BigInt(await read(maps, "mapCount"));
  const chainNodeCount = BigInt(await read(nodeMap, "nodeCount"));
  // An "ignored" map (e.g. a leftover duplicate) is exported after all once
  // a node or an AI fleet uses it: it was reused in the editor.
  const ignoredMaps = new Set(syncState.ignored?.maps ?? []);
  for (const id of [...ignoredMaps]) {
    let used = Number(await read(aiEncounters, "mapPlacementCount", [BigInt(id)])) > 0;
    for (let n = 1n; !used && n <= chainNodeCount; n++)
      used = BigInt((await read(nodeMap, "getNode", [n])).mapId) === BigInt(id);
    if (used) {
      ignoredMaps.delete(id);
      console.log(`  map #${id} is listed as ignored but is in use: exporting it`);
    }
  }
  const mapKeyOf = new Map<bigint, string>();
  const mapEntry = new Map<string, any>();
  for (const m of [...sp.maps, ...rl.maps, ...pvp.maps]) mapEntry.set(m.key, m);
  for (const [k, id] of mapIds) mapKeyOf.set(id, k);
  for (let id = 1n; id <= chainMapCount; id++) {
    if (ignoredMaps.has(id.toString())) continue;
    const [blocked, impassable, scoring, mode, creatorZone, joinerZone] = await Promise.all([
      read(maps, "getPresetMap", [id]),
      read(maps, "getPresetMapImpassable", [id]),
      read(maps, "getPresetScoringMap", [id]),
      read(maps, "mapMode", [id]),
      read(maps, "getCreatorZonePositions", [id]),
      read(maps, "getJoinerZonePositions", [id]),
    ]);
    let key = mapKeyOf.get(id) ?? reuse(`chainMap${id}`, mapEntry, mapIds);
    if (key !== undefined) mapKeyOf.set(id, key);
    else {
      key = `chainMap${id}`;
      mapKeyOf.set(id, key);
      const entry = { key, name: `Map ${id} (from chain)`, mode: MODE_NAME[Number(mode)], type: "full",
        blockedTiles: [], impassableTiles: [], scoringTiles: [], creatorZone: [], joinerZone: [] };
      rl.maps.push(entry);
      mapEntry.set(key, entry);
      change(`new map "${key}" (#${id}) appended to the roguelike seed`);
    }
    const m = mapEntry.get(key)!;
    const label = `map "${key}" (#${id})`;
    if (posSet(blocked) !== posSet(m.blockedTiles)) {
      m.blockedTiles = toPositions(blocked);
      change(`${label} blocked tiles`);
    }
    if (posSet(impassable) !== posSet(m.impassableTiles)) {
      m.impassableTiles = toPositions(impassable);
      change(`${label} impassable tiles`);
    }
    if (scoringSet(scoring) !== scoringSet(m.scoringTiles)) {
      m.scoringTiles = toScoring(scoring);
      change(`${label} scoring tiles`);
    }
    if (MODE_NAME[Number(mode)] !== m.mode) {
      change(`${label} mode ${m.mode} -> ${MODE_NAME[Number(mode)]}`);
      m.mode = MODE_NAME[Number(mode)];
    }
    if (posSet(creatorZone) !== posSet(m.creatorZone)) {
      m.creatorZone = toPositions(creatorZone);
      change(`${label} creator zone`);
    }
    if (posSet(joinerZone) !== posSet(m.joinerZone)) {
      m.joinerZone = toPositions(joinerZone);
      change(`${label} joiner zone`);
    }
  }

  // ---- AI ship configs -------------------------------------------------------
  console.log("\nAI ship configs:");
  const configCount = BigInt(await read(aiEncounters, "aiShipConfigCount"));
  const configKeyOf = new Map<bigint, string>([...configIds].map(([k, id]) => [id, k]));
  const configEntry = new Map<string, any>(sp.aiShipConfigs.map((c: any) => [c.key, c]));
  for (let id = 1n; id <= configCount; id++) {
    const c = await read(aiEncounters, "getAIShipConfig", [id]);
    const want = {
      name: c.name,
      equipment: {
        mainWeapon: Number(c.equipment.mainWeapon),
        armor: Number(c.equipment.armor),
        shields: Number(c.equipment.shields),
        special: Number(c.equipment.special),
      },
      traits: {
        variant: Number(c.traits.variant),
        accuracy: Number(c.traits.accuracy),
        hull: Number(c.traits.hull),
        speed: Number(c.traits.speed),
      },
      archetype: Number(c.archetype),
      // Configs from before the shiny/kills fields read as the defaults.
      shiny: Boolean(c.shiny ?? false),
      shipsDestroyed: Number(c.shipsDestroyed ?? 0),
    };
    let key = configKeyOf.get(id) ?? reuse(`chainConfig${id}`, configEntry, configIds);
    if (key !== undefined) configKeyOf.set(id, key);
    else {
      key = `chainConfig${id}`;
      configKeyOf.set(id, key);
      const entry = { key, ...want };
      sp.aiShipConfigs.push(entry);
      configEntry.set(key, entry);
      change(`new AI config "${key}" (#${id}, ${c.name}) appended`);
      continue;
    }
    const e = configEntry.get(key)!;
    const have = {
      name: e.name,
      equipment: e.equipment,
      traits: e.traits,
      archetype: e.archetype,
      shiny: e.shiny ?? false,
      shipsDestroyed: e.shipsDestroyed ?? 0,
    };
    if (JSON.stringify(have) !== JSON.stringify(want)) {
      Object.assign(e, want);
      change(`AI config "${key}" (#${id}) -> ${c.name}`);
    }
  }

  // ---- AI placements ---------------------------------------------------------
  console.log("\nAI placements:");
  const placementOf = new Map<string, { file: any; p: any }>();
  for (const file of [sp, rl])
    for (const p of file.mapPlacements) placementOf.set(p.mapKey, { file, p });
  const spMapKeys = new Set(sp.maps.map((m: any) => m.key));
  for (let id = 1n; id <= chainMapCount; id++) {
    const key = mapKeyOf.get(id);
    if (key === undefined) continue; // ignored map
    const [positions, ids] = await read(aiEncounters, "getMapPlacements", [id]);
    const want = (positions as any[]).map((pos, i) => `${pos.row},${pos.col}:${ids[i]}`).sort().join(" ");
    const existing = placementOf.get(key);
    const have = existing
      ? existing.p.positions
          .map((pos: any, i: number) => `${pos.row},${pos.col}:${configIds.get(existing.p.configKeys[i])}`)
          .sort()
          .join(" ")
      : "";
    if (want === have) continue;
    if ((positions as any[]).length === 0) {
      existing!.file.mapPlacements.splice(existing!.file.mapPlacements.indexOf(existing!.p), 1);
      change(`AI fleet on "${key}" (#${id}) removed`);
      continue;
    }
    const entry = {
      mapKey: key,
      positions: toPositions(positions),
      configKeys: (ids as bigint[]).map((cid) => {
        const k = configKeyOf.get(BigInt(cid));
        if (!k) throw new Error(`Map #${id} places unknown AI config #${cid}`);
        return k;
      }),
    };
    if (existing) Object.assign(existing.p, entry);
    else (spMapKeys.has(key) ? sp : rl).mapPlacements.push(entry);
    change(`AI fleet on "${key}" (#${id}), ${entry.positions.length} ships`);
  }

  // ---- Roguelike campaign ----------------------------------------------------
  console.log("\nRoguelike campaign:");
  const c = rl.campaign;
  const settings = {
    initialCostCap: Number(await read(nodeMap, "campaignInitialCostCap", [ROGUELIKE_CAMPAIGN_ID])),
    autoHealPercent: Number(await read(nodeMap, "campaignAutoHealPercent", [ROGUELIKE_CAMPAIGN_ID])),
    requiredVariant: Number(await read(nodeMap, "campaignRequiredVariant", [ROGUELIKE_CAMPAIGN_ID])),
  };
  for (const [k, v] of Object.entries(settings))
    if (c[k] !== v) {
      change(`campaign ${k} ${c[k]} -> ${v}`);
      c[k] = v;
    }

  const winEffectKeyOf = new Map<string, string>(
    Object.entries(WIN_EFFECT_CONTRACTS).map(([k, name]) => [d.addressOf(name), k]),
  );
  const ignoredNodes = new Set(syncState.ignored?.roguelikeNodes ?? []);
  const nodeKeyOf = new Map<bigint, string>([...nodeIds].map(([k, id]) => [id, k]));
  const nodeEntry = new Map<string, any>(rl.nodes.map((n: any) => [n.key, n]));
  const campaignNodes: bigint[] = [];
  for (let id = 1n; id <= chainNodeCount; id++) {
    if (ignoredNodes.has(id.toString())) continue;
    const n = await read(nodeMap, "getNode", [id]);
    if (BigInt(n.campaignId) !== ROGUELIKE_CAMPAIGN_ID) {
      console.warn(`  WARN: node #${id} is in campaign ${n.campaignId}; only campaign 1 is seeded (skipped).`);
      continue;
    }
    campaignNodes.push(id);
    const kind = KIND_NAME[Number(n.kind)];
    const want: any =
      kind === "Combat"
        ? {
            kind,
            mapKey: mapKeyOf.get(BigInt(n.mapId)),
            turnTime: Number(n.turnTime),
            maxScore: Number(n.maxScore),
            creatorGoesFirst: n.creatorGoesFirst,
          }
        : { kind, costCapOverride: Number(n.costCapOverride) };
    if (kind === "Combat" && want.mapKey === undefined)
      throw new Error(`Node #${id} is on map #${n.mapId}, which has no seed key`);
    const effects: Address[] = await read(nodeMap, "getNodeWinEffects", [id]);
    const effectKeys = effects.map((a) => {
      const k = winEffectKeyOf.get(getAddress(a));
      if (!k) throw new Error(`Node #${id} has unknown win effect ${a}`);
      return k;
    });

    let key = nodeKeyOf.get(id) ?? reuse(`chainNode${id}`, nodeEntry, nodeIds);
    if (key !== undefined) nodeKeyOf.set(id, key);
    else {
      key = `chainNode${id}`;
      nodeKeyOf.set(id, key);
      const entry = { key, ...want };
      rl.nodes.push(entry);
      nodeEntry.set(key, entry);
      change(`new node "${key}" (#${id}) appended`);
    }
    const e = nodeEntry.get(key)!;
    const fields = ["kind", "mapKey", "turnTime", "maxScore", "creatorGoesFirst", "costCapOverride"];
    const pick = (o: any) => JSON.stringify(fields.map((f) => o[f]));
    if (pick(e) !== pick(want)) {
      for (const f of fields) delete e[f];
      // Keep the seed's field order: key, the node fields, then the rest.
      const rest = { ...e };
      delete rest.key;
      for (const f of Object.keys(rest)) delete e[f];
      Object.assign(e, want, rest);
      change(`node "${key}" (#${id}) -> ${kind}${want.mapKey ? ` on "${want.mapKey}"` : ""}`);
    }
    if (JSON.stringify(e.winEffects ?? []) !== JSON.stringify(effectKeys)) {
      if (effectKeys.length) e.winEffects = effectKeys;
      else delete e.winEffects;
      change(`node "${key}" (#${id}) win effects -> [${effectKeys.join(", ")}]`);
    }
  }

  const rootKey = nodeKeyOf.get(BigInt(await read(nodeMap, "campaignRootNode", [ROGUELIKE_CAMPAIGN_ID])));
  if (rootKey !== rl.root) {
    change(`root ${rl.root} -> ${rootKey}`);
    rl.root = rootKey;
  }

  // Edges: the chain's set, keeping the seed's order for edges it already has.
  const chainEdges: { from: string; to: string }[] = [];
  for (const id of campaignNodes)
    for (const child of await read(nodeMap, "getChildren", [id]))
      chainEdges.push({ from: nodeKeyOf.get(id)!, to: nodeKeyOf.get(BigInt(child))! });
  const edgeKey = (e: { from: string; to: string }) => `${e.from}>${e.to}`;
  const chainSet = new Set(chainEdges.map(edgeKey));
  const seedSet = new Set(rl.edges.map(edgeKey));
  for (const e of rl.edges) if (!chainSet.has(edgeKey(e))) change(`edge ${e.from} -> ${e.to} removed`);
  for (const e of chainEdges) if (!seedSet.has(edgeKey(e))) change(`edge ${e.from} -> ${e.to} added`);
  rl.edges = [
    ...rl.edges.filter((e: any) => chainSet.has(edgeKey(e))),
    ...chainEdges.filter((e) => !seedSet.has(edgeKey(e))),
  ];

  // Reward ships (ShipGrantWinEffect), per node.
  const shipGrant = await contract("ShipGrantWinEffect");
  for (const id of campaignNodes) {
    const e = nodeEntry.get(nodeKeyOf.get(id)!)!;
    const want = (await read(shipGrant, "hasGrant", [id]))
      ? toShipGrant(await read(shipGrant, "getGrant", [id]))
      : undefined;
    const have = e.shipGrant ? toShipGrant(e.shipGrant) : undefined;
    if (JSON.stringify(have) === JSON.stringify(want)) continue;
    if (want) e.shipGrant = want;
    else delete e.shipGrant;
    change(`node "${e.key}" (#${id}) reward ship -> ${want ? `"${want.name}"` : "none"}`);
  }

  console.log(`\n${changes === 0 ? "Seeds already match the chain." : `${changes} change(s).`}`);
  if (changes && WRITE) {
    for (const [file, data] of [[SEED_FILES.singlePlayer, sp], [SEED_FILES.roguelike, rl], [SEED_FILES.pvp, pvp]] as const)
      fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
    console.log("Wrote the seed files in ignition/data/.");
  } else if (changes) console.log("Report only (set WRITE=true to write the seed files).");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

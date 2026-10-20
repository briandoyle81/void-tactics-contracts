// Brings an already-deployed chain's maps, AI placements and roguelike
// campaign in line with the seed files in ignition/data/ (written 2026-10-19).
//
// Why a script: after a real deploy, Ignition can't apply seed edits. The
// content futures already ran with the old arguments, so changed arguments
// fail reconciliation, and DeployAndConfig hands contract ownership to
// MAP_EDITOR at the end anyway. This script reads the chain, compares it to
// the seeds, and sends only the differences, signed by MAP_EDITOR.
//
// What it syncs (seed = source of truth):
//   - Maps (all three seed files): creates maps missing on chain; for
//     existing ones, fixes blocked/impassable/scoring tiles, mode and
//     creator/joiner zones.
//   - AI placements (singlePlayer + roguelike mapPlacements): replaces a
//     map's fleet when it differs.
//   - Roguelike campaign 1: campaign settings and root, nodes (update in
//     place; new nodes appended), edges (adds missing ones) and win effects.
// What it does NOT sync (prints a warning if the seed has new entries):
//   single-player NodeMap campaigns/nodes and AI ship configs. Edges on chain
//   that the seed no longer lists are reported, not removed (removing one
//   can strand a run standing on that node).
//
// How ids are found: map and roguelike node ids come from the deployment
// journal (ignition/deployments/<id>/journal.jsonl) -- each Create<Key>Map /
// CreateRoguelike<Key>Node call's confirmed nonce gives its creation order,
// so its id. Ids for things this script creates are saved to
// content-sync.json next to the journal, so reruns find them. AI config
// ids are the Read<Key>ConfigId results in the journal. New maps and nodes
// are only supported appended (their id is read back from chain).
//
// Usage:
//   npx hardhat run scripts/syncStarterContent.ts --network base-sepolia
//     Prints the plan only. Nothing is sent.
//   APPLY=true MAP_EDITOR_KEY=0x... npx hardhat run scripts/syncStarterContent.ts --network base-sepolia
//     Sends the plan, one transaction at a time (simulated first).
//
// Env:
//   APPLY            "true" to send. Anything else: plan only.
//   MAP_EDITOR_KEY   Private key of MAP_EDITOR (the owner/editor of Maps,
//                    AIEncounters and RoguelikeNodeMap after a real deploy).
//   DEPLOYMENT_ID    Deployment folder to read (default chain-<chainId>).
//   DEPLOYMENT_DIR   Full path to a deployment folder instead (testing on a
//                    copy, so content-sync.json isn't written to the real one).
//   IMPERSONATE      Local fork testing only: an address to impersonate
//                    instead of MAP_EDITOR_KEY (hardhat/localhost networks).
import fs from "fs";
import path from "path";
import hre from "hardhat";
import {
  createWalletClient,
  getAddress,
  http,
  type Abi,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const APPLY = process.env.APPLY === "true";
const DATA_DIR = path.join(__dirname, "..", "ignition", "data");
const MAP_MODE: Record<string, number> = { PvP: 0, PvE: 1, Both: 2 };
const NODE_KIND: Record<string, number> = { Combat: 0, Resupply: 1 };
// Must match DeployAndConfig.ts (it creates exactly one roguelike campaign).
const ROGUELIKE_CAMPAIGN_ID = 1n;
const WIN_EFFECT_CONTRACTS: Record<string, string> = {
  DEC_BONUS_WIN_EFFECT: "DECBonusWinEffect",
  HEAL_ABOVE_FLOOR_WIN_EFFECT: "HealAboveFloorWinEffect",
  SHIP_GRANT_WIN_EFFECT: "ShipGrantWinEffect",
};

type Pos = { row: number; col: number };
type ScoringPos = Pos & { points: number; onlyOnce: boolean };

const cap = (k: string) => `${k[0].toUpperCase()}${k.slice(1)}`;
const posKey = (p: Pos) => `${Number(p.row)},${Number(p.col)}`;
const posSet = (ps: readonly Pos[] | undefined) =>
  [...(ps ?? [])].map(posKey).sort().join(" ");
const scoringSet = (ps: readonly ScoringPos[] | undefined) =>
  [...(ps ?? [])]
    .map((p) => `${posKey(p)}:${Number(p.points)}:${p.onlyOnce}`)
    .sort()
    .join(" ");
const toPositions = (ps: readonly Pos[] | undefined) =>
  (ps ?? []).map((p) => ({ row: p.row, col: p.col }));
const toScoring = (ps: readonly ScoringPos[] | undefined) =>
  (ps ?? []).map((p) => ({
    row: p.row,
    col: p.col,
    points: p.points,
    onlyOnce: p.onlyOnce,
  }));

function readJson(file: string) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// Confirmed nonce per completed call future, and readEventArgument results.
function readJournal(file: string) {
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
function idsFromJournal(
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

async function main() {
  const publicClient = await hre.viem.getPublicClient();
  const chainId = await publicClient.getChainId();
  const deploymentId = process.env.DEPLOYMENT_ID || `chain-${chainId}`;
  const deployDir =
    process.env.DEPLOYMENT_DIR ||
    path.join(__dirname, "..", "ignition", "deployments", deploymentId);
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
  const contract = async (name: string) => ({
    address: addressOf(name),
    abi: (await hre.artifacts.readArtifact(name)).abi as Abi,
  });
  const maps = await contract("Maps");
  const aiEncounters = await contract("AIEncounters");
  const nodeMap = await contract("RoguelikeNodeMap");
  const read = (c: { address: Address; abi: Abi }, functionName: string, args: unknown[] = []) =>
    publicClient.readContract({ ...c, functionName, args }) as Promise<any>;

  const sp = readJson(path.join(DATA_DIR, "singlePlayerStarterContent.json"));
  const rl = readJson(path.join(DATA_DIR, "roguelikeStarterContent.json"));
  const pvp = readJson(path.join(DATA_DIR, "pvpStarterContent.json"));
  // Same order as DeployAndConfig.ts.
  const allMaps: any[] = [...sp.maps, ...rl.maps, ...pvp.maps];
  const allPlacements: any[] = [...sp.mapPlacements, ...rl.mapPlacements];

  const journal = readJournal(journalPath);
  // "ignored": on-chain ids that belong to no seed entry (e.g. a duplicate
  // left by a failed run), so they don't count as unknown.
  const syncState: {
    maps: Record<string, string>;
    roguelikeNodes: Record<string, string>;
    ignored?: { maps?: string[]; roguelikeNodes?: string[] };
  } = fs.existsSync(syncStatePath)
    ? readJson(syncStatePath)
    : { maps: {}, roguelikeNodes: {} };
  const saveSyncState = () =>
    fs.writeFileSync(syncStatePath, JSON.stringify(syncState, null, 2) + "\n");

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
    if (id === undefined)
      console.warn(`WARN: AI config "${c.key}" was never created on chain (not synced by this script).`);
    else configIds.set(c.key, id);
  }
  for (const c of sp.campaigns)
    if (!journal.completed.has(`DeployModule#Create${cap(c.key)}Campaign`))
      console.warn(`WARN: campaign "${c.key}" is new in the seed (not synced by this script).`);
  for (const n of sp.campaignNodes)
    if (!journal.completed.has(`DeployModule#Create${cap(n.key)}`))
      console.warn(`WARN: campaign node "${n.key}" is new in the seed (not synced by this script).`);

  // Chain counts must match what we know, or ids could be off.
  const chainMapCount = BigInt(await read(maps, "mapCount"));
  const chainNodeCount = BigInt(await read(nodeMap, "nodeCount"));
  const knownMapIds = [
    ...mapIds.values(),
    ...(syncState.ignored?.maps ?? []).map(BigInt),
  ];
  const knownNodeIds = [
    ...nodeIds.values(),
    ...(syncState.ignored?.roguelikeNodes ?? []).map(BigInt),
  ];
  console.log(`Deployment ${path.basename(deployDir)}: chain has ${chainMapCount} maps (${knownMapIds.length} known from seed), ` +
    `${chainNodeCount} roguelike nodes (${knownNodeIds.length} known).`);
  if (knownMapIds.some((id) => id > chainMapCount) || knownNodeIds.some((id) => id > chainNodeCount))
    throw new Error("Journal/sync-state ids exceed on-chain counts -- wrong deployment?");
  // More on chain than we know about: maybe an earlier run created something
  // and crashed before recording it, or someone added one in the editor.
  // Creating now could duplicate it (happened once, 2026-10-20: map 67 was
  // created twice, as 67 and 68), so creation is refused until every id is
  // accounted for -- add the missing ones to content-sync.json by hand.
  // Updates to known ids are still allowed.
  const unknownOnChain =
    chainMapCount > BigInt(knownMapIds.length) ||
    chainNodeCount > BigInt(knownNodeIds.length);
  if (unknownOnChain)
    console.warn(
      "WARN: the chain has maps/nodes this script doesn't know about. Creating new ones is refused " +
        `until they're recorded in ${syncStatePath} (key -> id), or listed in "ignored" there.`,
    );

  // ---- Signer --------------------------------------------------------------
  const netConfig: any = hre.network.config;
  let wallet: ReturnType<typeof createWalletClient> | undefined;
  if (process.env.IMPERSONATE) {
    if (!["hardhat", "localhost"].includes(hre.network.name))
      throw new Error("IMPERSONATE is only for local fork testing");
    const who = getAddress(process.env.IMPERSONATE);
    await publicClient.request({ method: "hardhat_impersonateAccount" as any, params: [who] as any });
    await publicClient.request({ method: "hardhat_setBalance" as any, params: [who, "0x56BC75E2D63100000"] as any });
    wallet = await hre.viem.getWalletClient(who);
  } else if (process.env.MAP_EDITOR_KEY) {
    const raw = process.env.MAP_EDITOR_KEY;
    wallet = createWalletClient({
      account: privateKeyToAccount((raw.startsWith("0x") ? raw : `0x${raw}`) as `0x${string}`),
      chain: publicClient.chain,
      transport: http(netConfig.url, {
        fetchOptions: { headers: netConfig.httpHeaders ?? {} },
      }),
    });
  }
  if (APPLY && !wallet) throw new Error("APPLY=true needs MAP_EDITOR_KEY");
  if (wallet) console.log(`Signer: ${wallet.account!.address}`);
  console.log(APPLY ? "APPLY=true: sending changes." : "Plan only (set APPLY=true to send).");

  let planned = 0;
  // Sends (or, in plan mode, prints) one call. Returns the receipt when sent.
  const send = async (
    label: string,
    c: { address: Address; abi: Abi },
    functionName: string,
    args: unknown[],
  ) => {
    planned++;
    console.log(`  ${APPLY ? "SEND" : "PLAN"} ${label}: ${functionName}`);
    if (!APPLY) return undefined;
    const { request } = await publicClient.simulateContract({
      ...c,
      functionName,
      args,
      account: wallet!.account!,
    });
    const hash = await wallet!.writeContract(request as any);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${label} reverted (${hash})`);
    console.log(`       ${hash}`);
    return receipt;
  };
  // Id for something this call just created: the count read at its block.
  // Refuses if anything else was created in between.
  const createdId = async (
    receipt: Awaited<ReturnType<typeof publicClient.waitForTransactionReceipt>>,
    c: { address: Address; abi: Abi },
    countFn: string,
    before: bigint,
  ) => {
    // Public RPCs behind a load balancer can briefly lack state for a block
    // they just reported (that crash is what caused the 2026-10-20
    // duplicate), so retry before giving up.
    let after: bigint | undefined;
    for (let attempt = 1; after === undefined; attempt++) {
      try {
        after = BigInt(
          (await publicClient.readContract({
            ...c,
            functionName: countFn,
            blockNumber: receipt.blockNumber,
          })) as bigint,
        );
      } catch (e) {
        if (attempt >= 10)
          throw new Error(
            `Created in ${receipt.transactionHash} but couldn't read its id. Record it in ` +
              `content-sync.json by hand (likely ${before + 1n}) before rerunning.`,
          );
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
    if (after !== before + 1n)
      throw new Error(`${countFn} went ${before} -> ${after}; something else created one too`);
    return after;
  };

  // ---- Maps ------------------------------------------------------------------
  console.log("\nMaps:");
  let provisionalMapId = chainMapCount;
  for (const map of allMaps) {
    const mode = MAP_MODE[map.mode];
    let id = mapIds.get(map.key);
    const isNew = id === undefined;
    if (isNew) {
      if (unknownOnChain) throw new Error(`Refusing to create map "${map.key}": see the WARN above.`);
      const receipt = await send(
        `create map "${map.key}" (${map.name})`,
        maps,
        "createFullPresetMap",
        [toPositions(map.blockedTiles), toPositions(map.impassableTiles), toScoring(map.scoringTiles), mode],
      );
      if (receipt) {
        id = await createdId(receipt, maps, "mapCount", provisionalMapId);
        syncState.maps[map.key] = id.toString();
        saveSyncState();
      } else {
        id = provisionalMapId + 1n;
      }
      provisionalMapId++;
      mapIds.set(map.key, id);
      console.log(`       -> map id ${id}${receipt ? "" : " (expected)"}`);
    } else {
      const [blocked, impassable, scoring, chainMode] = await Promise.all([
        read(maps, "getPresetMap", [id]),
        read(maps, "getPresetMapImpassable", [id]),
        read(maps, "getPresetScoringMap", [id]),
        read(maps, "mapMode", [id]),
      ]);
      if (posSet(blocked) !== posSet(map.blockedTiles))
        await send(`map "${map.key}" (#${id}) blocked tiles`, maps, "updatePresetMap", [id, toPositions(map.blockedTiles)]);
      if (posSet(impassable) !== posSet(map.impassableTiles))
        await send(`map "${map.key}" (#${id}) impassable tiles`, maps, "updatePresetMapImpassable", [id, toPositions(map.impassableTiles)]);
      if (scoringSet(scoring) !== scoringSet(map.scoringTiles))
        await send(`map "${map.key}" (#${id}) scoring tiles`, maps, "updatePresetScoringMap", [id, toScoring(map.scoringTiles)]);
      if (Number(chainMode) !== mode)
        await send(`map "${map.key}" (#${id}) mode -> ${map.mode}`, maps, "setMapMode", [id, mode]);
    }
    // Zones. A new map in plan mode doesn't exist yet: compare against empty.
    const existsNow = !isNew || APPLY;
    const [creatorZone, joinerZone] = existsNow
      ? await Promise.all([
          read(maps, "getCreatorZonePositions", [id]),
          read(maps, "getJoinerZonePositions", [id]),
        ])
      : [[], []];
    if (posSet(creatorZone) !== posSet(map.creatorZone))
      await send(`map "${map.key}" (#${id}) creator zone`, maps, "setCreatorZone", [id, toPositions(map.creatorZone)]);
    if (posSet(joinerZone) !== posSet(map.joinerZone))
      await send(`map "${map.key}" (#${id}) joiner zone`, maps, "setJoinerZone", [id, toPositions(map.joinerZone)]);
  }

  // ---- AI placements ---------------------------------------------------------
  console.log("\nAI placements:");
  for (const p of allPlacements) {
    const id = mapIds.get(p.mapKey);
    if (id === undefined) throw new Error(`Placement for unknown map "${p.mapKey}"`);
    const wantIds = p.configKeys.map((k: string) => {
      const cid = configIds.get(k);
      if (cid === undefined) throw new Error(`Placement on "${p.mapKey}" uses unknown AI config "${k}"`);
      return cid;
    });
    const want = p.positions
      .map((pos: Pos, i: number) => `${posKey(pos)}:${wantIds[i]}`)
      .sort()
      .join(" ");
    let have = "";
    if (id <= chainMapCount) {
      const [positions, ids] = await read(aiEncounters, "getMapPlacements", [id]);
      have = (positions as Pos[]).map((pos, i) => `${posKey(pos)}:${ids[i]}`).sort().join(" ");
    }
    if (have !== want)
      await send(`AI fleet on "${p.mapKey}" (#${id}), ${p.positions.length} ships`, aiEncounters, "setMapPlacements", [
        id,
        toPositions(p.positions),
        wantIds,
      ]);
  }

  // ---- Roguelike campaign ----------------------------------------------------
  console.log("\nRoguelike campaign:");
  const c = rl.campaign;
  if (BigInt(await read(nodeMap, "campaignInitialCostCap", [ROGUELIKE_CAMPAIGN_ID])) !== BigInt(c.initialCostCap))
    await send(`initial cost cap -> ${c.initialCostCap}`, nodeMap, "setCampaignInitialCostCap", [ROGUELIKE_CAMPAIGN_ID, BigInt(c.initialCostCap)]);
  if (Number(await read(nodeMap, "campaignAutoHealPercent", [ROGUELIKE_CAMPAIGN_ID])) !== c.autoHealPercent)
    await send(`auto-heal -> ${c.autoHealPercent}%`, nodeMap, "setCampaignAutoHealPercent", [ROGUELIKE_CAMPAIGN_ID, c.autoHealPercent]);
  if (Number(await read(nodeMap, "campaignRequiredVariant", [ROGUELIKE_CAMPAIGN_ID])) !== c.requiredVariant)
    await send(`required variant -> ${c.requiredVariant}`, nodeMap, "setCampaignRequiredVariant", [ROGUELIKE_CAMPAIGN_ID, c.requiredVariant]);

  let provisionalNodeId = chainNodeCount;
  for (const node of rl.nodes) {
    const isCombat = node.kind === "Combat";
    const mapId = isCombat ? mapIds.get(node.mapKey) : 0n;
    if (mapId === undefined) throw new Error(`Node "${node.key}" uses unknown map "${node.mapKey}"`);
    // Same argument rules as DeployAndConfig.ts.
    const args = [
      ROGUELIKE_CAMPAIGN_ID,
      NODE_KIND[node.kind],
      mapId,
      isCombat ? BigInt(node.turnTime) : 0n,
      isCombat ? BigInt(node.maxScore) : 0n,
      isCombat ? node.creatorGoesFirst : false,
      isCombat ? 0n : BigInt(node.costCapOverride),
    ] as const;
    const id = nodeIds.get(node.key);
    if (id === undefined) {
      if (unknownOnChain) throw new Error(`Refusing to create node "${node.key}": see the WARN above.`);
      const receipt = await send(`create node "${node.key}"`, nodeMap, "createNode", [...args]);
      const newId = receipt
        ? await createdId(receipt, nodeMap, "nodeCount", provisionalNodeId)
        : provisionalNodeId + 1n;
      provisionalNodeId++;
      nodeIds.set(node.key, newId);
      if (receipt) {
        syncState.roguelikeNodes[node.key] = newId.toString();
        saveSyncState();
      }
      console.log(`       -> node id ${newId}${receipt ? "" : " (expected)"}`);
      continue;
    }
    const n = await read(nodeMap, "getNode", [id]);
    const have = [n.campaignId, n.kind, n.mapId, n.turnTime, n.maxScore, n.creatorGoesFirst, n.costCapOverride]
      .map(String).join("|");
    if (have !== args.map(String).join("|"))
      await send(
        `node "${node.key}" (#${id}) -> ${node.kind}${isCombat ? ` on "${node.mapKey}" (#${mapId})` : ""}`,
        nodeMap,
        "updateNode",
        [id, ...args],
      );
  }

  const rootId = nodeIds.get(rl.root)!;
  if (BigInt(await read(nodeMap, "campaignRootNode", [ROGUELIKE_CAMPAIGN_ID])) !== rootId)
    await send(`root -> "${rl.root}" (#${rootId})`, nodeMap, "setCampaignRoot", [ROGUELIKE_CAMPAIGN_ID, rootId]);

  // Edges: add missing. Report (don't remove) on-chain edges the seed dropped.
  const childrenOf = new Map<bigint, bigint[]>();
  const getChildren = async (id: bigint) => {
    if (!childrenOf.has(id))
      childrenOf.set(id, id <= chainNodeCount ? [...(await read(nodeMap, "getChildren", [id]))].map(BigInt) : []);
    return childrenOf.get(id)!;
  };
  const seedEdges = new Set<string>();
  for (const e of rl.edges) {
    const from = nodeIds.get(e.from)!;
    const to = nodeIds.get(e.to)!;
    seedEdges.add(`${from}>${to}`);
    if (!(await getChildren(from)).includes(to))
      await send(`edge "${e.from}" (#${from}) -> "${e.to}" (#${to})`, nodeMap, "addChild", [from, to]);
  }
  const keyOf = new Map([...nodeIds].map(([k, id]) => [id, k]));
  for (const [from, children] of childrenOf)
    for (const to of children)
      if (!seedEdges.has(`${from}>${to}`))
        console.warn(`  WARN: on-chain edge "${keyOf.get(from)}" (#${from}) -> "${keyOf.get(to)}" (#${to}) is not in the seed (left in place).`);

  // Win effects (full replace per node; nodes without the field must be empty).
  for (const node of rl.nodes) {
    const id = nodeIds.get(node.key)!;
    const want = (node.winEffects ?? []).map((k: string) => {
      const name = WIN_EFFECT_CONTRACTS[k];
      if (!name) throw new Error(`Node "${node.key}" lists unknown win effect "${k}"`);
      return addressOf(name);
    });
    const have: Address[] = id <= chainNodeCount ? await read(nodeMap, "getNodeWinEffects", [id]) : [];
    if (have.map((a) => getAddress(a)).join() !== want.join())
      await send(`node "${node.key}" (#${id}) win effects -> [${(node.winEffects ?? []).join(", ")}]`, nodeMap, "setNodeWinEffects", [id, want]);
  }

  console.log(
    `\n${planned === 0 ? "Already in sync." : `${planned} change(s) ${APPLY ? "sent" : "planned"}.`}` +
      " Titles, descriptions and map names are frontend-only and aren't written on chain.",
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

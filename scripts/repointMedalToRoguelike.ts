// One-off (2026-11-21): makes the live Shattered Hive medal claimable by
// winning a roguelike run at either ending (11. The Hive: Dominance or
// 15. The Hive: Alliance), instead of completing node 30 of the stub
// single-player campaign. A fresh DeployAndConfig deploy already wires this;
// this script applies the same wiring to an existing deployment without
// redeploying the medal, so current holders keep their tokens.
//
// Steps:
//   1. Deploy RoguelikeCompletionWinEffect(RoguelikeNodeMap) from the
//      default (deployer) wallet, allow RoguelikeMatch to trigger it, and
//      hand ownership to MAP_EDITOR.
//   2. For every ending of roguelike campaign 1 (a combat node reachable
//      from the root with no children, read from chain), append the effect
//      to the node's existing win effects (setNodeWinEffects replaces the
//      whole list, so the current ones are read and kept).
//   3. Point ShatteredHiveMedal.nodeMap at the effect and set finalNodeId
//      to 0 (the effect ignores it).
// Steps 2 and 3 need MAP_EDITOR (owner of RoguelikeNodeMap and the medal):
// signed automatically if MAP_EDITOR_KEY or SHIP_MINTER_PRIVATE_KEY matches,
// otherwise the calldata is printed for manual submission.
//
// Only wins after step 2 are recorded. Players who already won a run can be
// given the medal with scripts/grantShatteredHiveMedal.ts (ownerMint).
//
// Run with: npx hardhat run scripts/repointMedalToRoguelike.ts --network base-sepolia
//
// Environment:
//   ROGUELIKE_COMPLETION_WIN_EFFECT_ADDRESS  Reuse an already-deployed effect
//                                            (skips step 1).
//   MAP_EDITOR_KEY / SHIP_MINTER_PRIVATE_KEY Owner's private key.

import fs from "fs";
import path from "path";
import hre from "hardhat";
import {
  createWalletClient,
  encodeFunctionData,
  getAddress,
  http,
  isAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { MAP_EDITOR } from "../ignition/modules/DeployAndConfig";

const ROGUELIKE_CAMPAIGN_ID = 1n;
const COMBAT = 0;

function deployedAddress(chainId: number, key: string): `0x${string}` {
  const file = path.join(
    __dirname,
    "..",
    "ignition",
    "deployments",
    `chain-${chainId}`,
    "deployed_addresses.json",
  );
  const address = JSON.parse(fs.readFileSync(file, "utf8"))[key];
  if (!address) throw new Error(`${key} missing in ${file}`);
  return getAddress(address);
}

function ownerClient() {
  for (const name of ["MAP_EDITOR_KEY", "SHIP_MINTER_PRIVATE_KEY"]) {
    const raw = process.env[name];
    if (!raw) continue;
    const pk = (raw.startsWith("0x") ? raw : `0x${raw}`) as `0x${string}`;
    const account = privateKeyToAccount(pk);
    if (getAddress(account.address) !== getAddress(MAP_EDITOR)) continue;
    console.log(`${name} matches MAP_EDITOR -- will sign automatically.`);
    return createWalletClient({
      account,
      chain: baseSepolia,
      // Same URL and headers as the hardhat network: the shared Ankr key
      // rejects requests without the frontend's Origin header.
      transport: http((hre.network.config as any).url, {
        fetchOptions: { headers: (hre.network.config as any).httpHeaders ?? {} },
      }),
    });
  }
  console.warn("No MAP_EDITOR key -- owner calls will be printed for manual submission.");
  return undefined;
}

async function main() {
  const publicClient = await hre.viem.getPublicClient();
  const chainId = await publicClient.getChainId();
  const nodeMapAddress = deployedAddress(chainId, "DeployModule#RoguelikeNodeMap");
  const matchAddress = deployedAddress(chainId, "DeployModule#RoguelikeMatch");
  const medalAddress = deployedAddress(chainId, "DeployModule#ShatteredHiveMedal");
  const nodeMap = await hre.viem.getContractAt("RoguelikeNodeMap", nodeMapAddress);
  const medal = await hre.viem.getContractAt("ShatteredHiveMedal", medalAddress);
  console.log("chainId:", chainId);

  // 1. The effect.
  let effectAddress: `0x${string}`;
  const reuse = process.env.ROGUELIKE_COMPLETION_WIN_EFFECT_ADDRESS;
  if (reuse) {
    if (!isAddress(reuse)) throw new Error(`not an address: ${reuse}`);
    effectAddress = getAddress(reuse);
    console.log("Reusing RoguelikeCompletionWinEffect", effectAddress);
  } else {
    const effect = await hre.viem.deployContract("RoguelikeCompletionWinEffect", [
      nodeMapAddress,
    ]);
    effectAddress = getAddress(effect.address);
    console.log("Deployed RoguelikeCompletionWinEffect", effectAddress);
    await publicClient.waitForTransactionReceipt({
      hash: await effect.write.setIsAllowedToTrigger([matchAddress, true]),
    });
    await publicClient.waitForTransactionReceipt({
      hash: await effect.write.transferOwnership([MAP_EDITOR]),
    });
    console.log("  RoguelikeMatch allowed to trigger; ownership -> MAP_EDITOR");
  }

  // 2. Endings, read from chain.
  const root = await nodeMap.read.campaignRootNode([ROGUELIKE_CAMPAIGN_ID]);
  const seen = new Set<bigint>([root]);
  const queue = [root];
  const endings: bigint[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    const node = await nodeMap.read.getNode([id]);
    if (node.children.length === 0 && node.kind === COMBAT) endings.push(id);
    for (const child of node.children) {
      if (!seen.has(child)) {
        seen.add(child);
        queue.push(child);
      }
    }
  }
  console.log(`Endings of campaign ${ROGUELIKE_CAMPAIGN_ID}:`, endings.join(", "));
  if (endings.length === 0) throw new Error("no ending found");

  const calls: { to: `0x${string}`; abi: any; functionName: string; args: any[] }[] = [];
  for (const id of endings) {
    const current = (await nodeMap.read.getNodeWinEffects([id])).map((a) => getAddress(a));
    if (current.includes(effectAddress)) {
      console.log(`  node ${id}: already has the effect`);
      continue;
    }
    calls.push({
      to: nodeMapAddress,
      abi: nodeMap.abi,
      functionName: "setNodeWinEffects",
      args: [id, [...current, effectAddress]],
    });
  }

  // 3. The medal.
  if (getAddress(await medal.read.nodeMap()) !== effectAddress) {
    calls.push({ to: medalAddress, abi: medal.abi, functionName: "setNodeMapAddress", args: [effectAddress] });
  }
  if ((await medal.read.finalNodeId()) !== 0n) {
    calls.push({ to: medalAddress, abi: medal.abi, functionName: "setFinalNodeId", args: [0n] });
  }

  const client = ownerClient();
  for (const c of calls) {
    const label = `${c.functionName}(${c.args.map(String).join(", ")})`;
    if (!client) {
      console.log(`\nto:   ${c.to}\ncall: ${label}\ndata: ${encodeFunctionData(c)}`);
      continue;
    }
    const hash = await client.writeContract({ ...c, account: client.account!, chain: baseSepolia } as any);
    await publicClient.waitForTransactionReceipt({ hash });
    console.log(`  ${label}: ${hash}`);
  }
  if (calls.length === 0) console.log("Nothing to do: already wired.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

// Redeploys the variant 1 ship renderers on a live chain and points Ships at
// them (written 2026-10-20, for the variant 1 shiny recolor in
// contracts/Renderers/RenderUtils.sol's blendHSL).
//
// Every renderer address is immutable all the way up (leaf parts ->
// combiners -> ImageRenderer -> RenderMetadata), so changing any variant 1
// leaf means new copies of everything above it, then
// Ships.setConfig(..., newRenderMetadata, ...). This script:
//   1. Walks the live chain from Ships.config().metadataRenderer down to every
//      variant 1 leaf, and compares each leaf's on-chain code with the
//      compiled bytecode. Only changed leaves are redeployed; a combiner is
//      redeployed only if one of its leaves changed, and so on up.
//   2. Reuses the variant 2 ImageRenderer and the explosion/unconstructed
//      parts as they are (read from the live contracts).
//   3. Copies every special/weapon/armor/shield display name from the old
//      RenderMetadata to the new one, then hands its ownership to the old
//      one's owner (MAP_EDITOR after a real deploy).
//   4. Calls Ships.setConfig with every other field read back from chain
//      unchanged. purchaseGate has no getter, so it's read from storage (the
//      slot holding the deployed VariantPurchaseGate address); the script
//      refuses to continue if it can't find it.
//
// Crash-safe: each deploy's tx hash is saved to renderer-redeploy.json next
// to the deployment journal as soon as it's sent, so a rerun picks up the
// same contract instead of deploying a duplicate. Entries are keyed by
// contract name + bytecode hash + constructor args, so a later run for a
// different renderer change never reuses them.
//
// Usage:
//   npx hardhat run scripts/redeployVariant1Renderers.ts --network base-sepolia
//     Plan only: shows which contracts would be redeployed. Sends nothing.
//   APPLY=true MAP_EDITOR_KEY=0x... npx hardhat run scripts/redeployVariant1Renderers.ts --network base-sepolia
//     Deploys from the network's default account, then calls setConfig as
//     Ships' owner (MAP_EDITOR_KEY, or the default account if it's the owner).
//
// Env:
//   APPLY            "true" to send. Anything else: plan only.
//   MAP_EDITOR_KEY   Private key of Ships' (and RenderMetadata's) owner.
//   VERIFY           "true" to verify each new contract on the block explorer.
//   DEPLOYMENT_ID    Deployment folder (default chain-<chainId>).
//   DEPLOYMENT_DIR   Full path to a deployment folder instead (testing).
//   IMPERSONATE      Local fork testing only: owner address to impersonate.
import fs from "fs";
import path from "path";
import hre from "hardhat";
import {
  createWalletClient,
  getAddress,
  http,
  keccak256,
  pad,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const APPLY = process.env.APPLY === "true";
const VERIFY = process.env.VERIFY === "true";

// Same order as DeployAndConfig.ts's constructor arrays (it matters: each
// combiner assigns its immutables by array position).
const COMBINERS: { name: string; leaves: string[] }[] = [
  { name: "RenderSpecial", leaves: ["RenderSpecial1", "RenderSpecial2", "RenderSpecial3"] },
  { name: "RenderAft", leaves: ["RenderAft0", "RenderAft1", "RenderAft2"] },
  { name: "RenderWeapon", leaves: ["RenderWeapon1", "RenderWeapon2", "RenderWeapon3", "RenderWeapon4"] },
  {
    name: "RenderBody",
    leaves: [
      "RenderBaseBody",
      "RenderShield1",
      "RenderShield2",
      "RenderShield3",
      "RenderArmor1",
      "RenderArmor2",
      "RenderArmor3",
    ],
  },
  { name: "RenderFore", leaves: ["RenderFore0", "RenderFore1", "RenderFore2", "RenderForePerfect"] },
];
// Each contract exposes the next level down under its own name, lowercased.
const getterFor = (name: string) => `${name[0].toLowerCase()}${name.slice(1)}`;
// RenderMetadata's name tables: (setter, getter). Enum keys are tried 0..15
// (an out-of-range one just fails the read and is skipped).
const NAME_TABLES = [
  ["setSpecialName", "specialNames"],
  ["setMainWeaponName", "mainWeaponNames"],
  ["setArmorName", "armorNames"],
  ["setShieldsName", "shieldsNames"],
] as const;
const MAX_ENUM_KEY = 15;

async function main() {
  const publicClient = await hre.viem.getPublicClient();
  const chainId = await publicClient.getChainId();
  const deployDir =
    process.env.DEPLOYMENT_DIR ||
    path.join(__dirname, "..", "ignition", "deployments", process.env.DEPLOYMENT_ID || `chain-${chainId}`);
  const deployed: Record<string, string> = JSON.parse(
    fs.readFileSync(path.join(deployDir, "deployed_addresses.json"), "utf8"),
  );
  const statePath = path.join(deployDir, "renderer-redeploy.json");
  const state: Record<string, { hash?: Hex; address?: Address }> = fs.existsSync(statePath)
    ? JSON.parse(fs.readFileSync(statePath, "utf8"))
    : {};
  const saveState = () => fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");

  const artifact = (name: string) => hre.artifacts.readArtifact(name);
  const read = async (name: string, address: Address, functionName: string, args: unknown[] = []) =>
    publicClient.readContract({ address, abi: (await artifact(name)).abi as Abi, functionName, args }) as Promise<any>;

  // ---- 1. Walk the live renderer tree ---------------------------------------
  const shipsAddress = getAddress(deployed["DeployModule#Ships"]);
  const config = await read("Ships", shipsAddress, "config");
  const [gameAddress, lobbyAddress, fleetsAddress, oldMetadata, randomManager, shipGenerator, shipAttributes] =
    config as Address[];
  const oldImage: Address = await read("RenderMetadata", oldMetadata, "imageRenderer");
  const imageV2: Address = await read("RenderMetadata", oldMetadata, "imageRendererV2");
  const metadataOwner: Address = await read("RenderMetadata", oldMetadata, "owner");
  console.log(`Ships ${shipsAddress}\n  RenderMetadata ${oldMetadata}\n  ImageRenderer  ${oldImage} (variant 1)\n  ImageRendererV2 ${imageV2} (kept)`);

  const readArray = async (getter: string) => {
    const out: Address[] = [];
    for (let i = 0; ; i++) {
      try {
        out.push(await read("ImageRenderer", oldImage, getter, [BigInt(i)]));
      } catch {
        return out;
      }
    }
  };
  const destroyedParts = await readArray("destroyedParts");
  const unconstructedParts = await readArray("unconstructedParts");

  const plan: { name: string; old: Address; changed: boolean }[] = [];
  const changedLeaves = new Set<string>();
  for (const c of COMBINERS) {
    const combiner: Address = await read("ImageRenderer", oldImage, getterFor(c.name));
    for (const leaf of c.leaves) {
      const addr: Address = await read(c.name, combiner, getterFor(leaf));
      const onChain = (await publicClient.getCode({ address: addr })) ?? "0x";
      const changed = onChain.toLowerCase() !== (await artifact(leaf)).deployedBytecode.toLowerCase();
      if (changed) changedLeaves.add(leaf);
      plan.push({ name: leaf, old: addr, changed });
    }
    plan.push({ name: c.name, old: combiner, changed: c.leaves.some((l) => changedLeaves.has(l)) });
  }
  const imageChanged = plan.some((p) => p.changed);
  plan.push({ name: "ImageRenderer", old: oldImage, changed: imageChanged });
  plan.push({ name: "RenderMetadata", old: oldMetadata, changed: imageChanged });

  console.log("\nPlan:");
  for (const p of plan)
    console.log(`  ${p.changed ? "REDEPLOY" : "keep    "} ${p.name.padEnd(18)} ${p.old}`);
  if (!imageChanged) {
    console.log("\nEvery variant 1 leaf already matches the compiled code. Nothing to do.");
    return;
  }

  // ---- Signers --------------------------------------------------------------
  const [deployer] = await hre.viem.getWalletClients();
  const shipsOwner = getAddress(await read("Ships", shipsAddress, "owner"));
  const netConfig: any = hre.network.config;
  let ownerWallet: any;
  if (process.env.IMPERSONATE) {
    if (!["hardhat", "localhost"].includes(hre.network.name)) throw new Error("IMPERSONATE is only for local fork testing");
    const who = getAddress(process.env.IMPERSONATE);
    await publicClient.request({ method: "hardhat_impersonateAccount" as any, params: [who] as any });
    await publicClient.request({ method: "hardhat_setBalance" as any, params: [who, "0x56BC75E2D63100000"] as any });
    ownerWallet = await hre.viem.getWalletClient(who);
  } else if (getAddress(deployer.account.address) === shipsOwner) {
    ownerWallet = deployer;
  } else if (process.env.MAP_EDITOR_KEY) {
    const raw = process.env.MAP_EDITOR_KEY;
    ownerWallet = createWalletClient({
      account: privateKeyToAccount((raw.startsWith("0x") ? raw : `0x${raw}`) as Hex),
      chain: publicClient.chain,
      transport: http(netConfig.url, { fetchOptions: { headers: netConfig.httpHeaders ?? {} } }),
    });
  }
  console.log(`\nDeployer: ${deployer.account.address}\nShips owner: ${shipsOwner}${ownerWallet ? " (have its key)" : " (NO KEY -- set MAP_EDITOR_KEY)"}`);
  if (ownerWallet && getAddress(ownerWallet.account.address) !== shipsOwner)
    throw new Error(`MAP_EDITOR_KEY is ${ownerWallet.account.address}, but Ships is owned by ${shipsOwner}`);

  // purchaseGate has no getter: confirm which storage slot holds it.
  const expectedGate = getAddress(deployed["DeployModule#VariantPurchaseGate"]);
  const gateWord = pad(expectedGate.toLowerCase() as Hex).toLowerCase();
  let gateFound = false;
  for (let slot = 0n; slot < 128n && !gateFound; slot++) {
    const v = await publicClient.getStorageAt({ address: shipsAddress, slot: pad(`0x${slot.toString(16)}` as Hex) });
    if (v?.toLowerCase() === gateWord) gateFound = true;
  }
  if (!gateFound)
    throw new Error(`Couldn't find Ships.purchaseGate (${expectedGate}) in storage -- it may have changed. Not calling setConfig.`);
  const universalCredits: Address = await read("Ships", shipsAddress, "universalCredits");
  const droneEnergyCores: Address = await read("Ships", shipsAddress, "droneEnergyCores");

  if (!APPLY) {
    console.log(`\nPlan only (set APPLY=true to send). ${plan.filter((p) => p.changed).length} contracts to deploy, then Ships.setConfig.`);
    return;
  }
  if (!ownerWallet) throw new Error("APPLY=true needs MAP_EDITOR_KEY (Ships' owner)");

  // ---- 2. Deploy, resumably -------------------------------------------------
  const deployOne = async (name: string, args: unknown[]): Promise<Address> => {
    const a = await artifact(name);
    const key = `${name}@${keccak256(a.bytecode as Hex).slice(0, 18)}:${keccak256(
      new TextEncoder().encode(JSON.stringify(args)),
    ).slice(0, 18)}`;
    const s = (state[key] ??= {});
    if (s.address) {
      console.log(`  reuse  ${name}: ${s.address}`);
      return s.address;
    }
    if (!s.hash) {
      s.hash = await deployer.deployContract({ abi: a.abi as Abi, bytecode: a.bytecode as Hex, args });
      saveState(); // before waiting, so a crash can't cause a duplicate
      console.log(`  deploy ${name}: ${s.hash}`);
    } else {
      console.log(`  resume ${name}: ${s.hash}`);
    }
    const receipt = await publicClient.waitForTransactionReceipt({ hash: s.hash });
    if (receipt.status !== "success" || !receipt.contractAddress) throw new Error(`${name} deploy failed (${s.hash})`);
    s.address = getAddress(receipt.contractAddress);
    saveState();
    // Load-balanced public RPCs can lag behind the receipt: wait until the
    // code is visible before anything reads from the new contract.
    for (let i = 0; !((await publicClient.getCode({ address: s.address })) ?? "0x").slice(2); i++) {
      if (i >= 20) throw new Error(`${name} at ${s.address} still has no code after 60s`);
      await new Promise((r) => setTimeout(r, 3000));
    }
    console.log(`         -> ${s.address}`);
    if (VERIFY) {
      try {
        await hre.run("verify:verify", { address: s.address, constructorArguments: args });
      } catch (e: any) {
        console.warn(`  verify ${name}: ${e?.message?.split("\n")[0]}`);
      }
    }
    return s.address;
  };

  console.log("\nDeploying:");
  const current = new Map(plan.map((p) => [p.name, p.old]));
  const addrOf = async (name: string, args: unknown[]) =>
    plan.find((p) => p.name === name)!.changed ? deployOne(name, args) : current.get(name)!;
  const combinerAddrs: Address[] = [];
  for (const c of COMBINERS) {
    const leaves: Address[] = [];
    for (const leaf of c.leaves) leaves.push(await addrOf(leaf, []));
    combinerAddrs.push(await addrOf(c.name, [leaves]));
  }
  const newImage = await deployOne("ImageRenderer", [...combinerAddrs, destroyedParts, unconstructedParts]);
  const newMetadata = await deployOne("RenderMetadata", [newImage, imageV2]);

  // ---- 3. Copy display names, then hand over ownership ---------------------
  console.log("\nRenderMetadata names:");
  const maxVariant = Number(await read("Ships", shipsAddress, "maxVariant"));
  const metaAbi = (await artifact("RenderMetadata")).abi as Abi;
  const newMetaOwner = getAddress(await read("RenderMetadata", newMetadata, "owner"));
  for (const [setter, getter] of NAME_TABLES) {
    for (let variant = 0; variant <= maxVariant; variant++) {
      for (let key = 0; key <= MAX_ENUM_KEY; key++) {
        let want: string;
        try {
          want = await read("RenderMetadata", oldMetadata, getter, [variant, key]);
        } catch {
          break; // past the enum's last value
        }
        if (!want) continue;
        const have: string = await read("RenderMetadata", newMetadata, getter, [variant, key]);
        if (have === want) continue;
        if (newMetaOwner !== getAddress(deployer.account.address))
          throw new Error(`New RenderMetadata is already owned by ${newMetaOwner}; can't set ${getter}[${variant}][${key}]`);
        const hash = await deployer.writeContract({ address: newMetadata, abi: metaAbi, functionName: setter, args: [variant, key, want] });
        await publicClient.waitForTransactionReceipt({ hash });
        console.log(`  ${getter}[${variant}][${key}] = "${want}"`);
      }
    }
  }
  if (newMetaOwner !== getAddress(metadataOwner)) {
    const hash = await deployer.writeContract({ address: newMetadata, abi: metaAbi, functionName: "transferOwnership", args: [metadataOwner] });
    await publicClient.waitForTransactionReceipt({ hash });
    console.log(`  ownership -> ${metadataOwner}`);
  }

  // ---- 4. Point Ships at the new RenderMetadata ----------------------------
  console.log("\nShips.setConfig:");
  const shipsAbi = (await artifact("Ships")).abi as Abi;
  if (getAddress(oldMetadata) === newMetadata) {
    console.log("  already pointing at the new RenderMetadata");
  } else {
    const args = [
      gameAddress,
      lobbyAddress,
      fleetsAddress,
      shipGenerator,
      randomManager,
      newMetadata,
      shipAttributes,
      universalCredits,
      droneEnergyCores,
      expectedGate,
    ];
    const { request } = await publicClient.simulateContract({
      address: shipsAddress,
      abi: shipsAbi,
      functionName: "setConfig",
      args,
      account: ownerWallet.account,
    });
    const hash = await ownerWallet.writeContract(request);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`setConfig reverted (${hash})`);
    console.log(`  ${hash}`);
  }

  // Read everything back.
  const after = (await read("Ships", shipsAddress, "config")) as Address[];
  const expectAfter = [gameAddress, lobbyAddress, fleetsAddress, newMetadata, randomManager, shipGenerator, shipAttributes];
  if (after.some((a, i) => getAddress(a) !== getAddress(expectAfter[i])))
    throw new Error(`Ships.config() after setConfig is not what was sent: ${after.join(", ")}`);
  if (getAddress(await read("Ships", shipsAddress, "universalCredits")) !== getAddress(universalCredits) ||
      getAddress(await read("Ships", shipsAddress, "droneEnergyCores")) !== getAddress(droneEnergyCores))
    throw new Error("Ships token addresses changed unexpectedly");
  console.log("  Ships config verified: only metadataRenderer changed.");
  // Smoke test: the new tree renders a shiny variant 1 ship end to end.
  const sample = {
    name: "Sample",
    id: 1n,
    equipment: { mainWeapon: 0, armor: 1, shields: 0, special: 0 },
    traits: {
      serialNumber: 1n,
      colors: { h1: 0, s1: 85, l1: 50, h2: 0, s2: 0, l2: 0, h3: 0, s3: 0, l3: 0 },
      variant: 1,
      accuracy: 1,
      hull: 1,
      speed: 1,
    },
    shipData: {
      shipsDestroyed: 1, costsVersion: 1, cost: 100, modified: 0, shiny: true,
      constructed: true, inFleet: false, isFreeShip: false, timestampDestroyed: 0n,
    },
    owner: shipsOwner,
  };
  const uri: string = await read("RenderMetadata", newMetadata, "tokenURI", [sample]);
  console.log(`  New RenderMetadata renders a sample shiny ship (${uri.length} chars).`);
  console.log(`\nDone. New RenderMetadata: ${newMetadata}, ImageRenderer: ${newImage}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

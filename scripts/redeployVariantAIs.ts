// Redeploys Variant1AI and Variant2AI on a live chain and points
// AIBehaviorRegistry at them (written 2026-11-04), for AI behavior fixes
// that don't touch anything else (e.g. the move-then-shoot fix in
// AIBehavior.decideSupportFallback / decideTurtle).
//
// AI ships pin their AI contract at mint (docs/audit-3.md HA6-18), so only
// matches started after setVariantAI use the new AI; matches in progress
// keep the old one. This script:
//   1. Checks that every live contract the AI talks to matches the compiled
//      code (immutables and library links masked): the match contracts that
//      encode its decision input (AIBehavior.Ctx), Game (getAIBoard's
//      layout), Maps, and each AI's constructor dependencies. If any
//      doesn't, the new AI may not decode its input or may call functions
//      the live contracts don't have, so every AI ship would pass every
//      turn (AIDecisionFailed). It stops instead: run a full redeploy.
//   2. Compares each registered AI with the compiled code. Only a changed
//      one is redeployed, with the same constructor arguments, read from
//      the live AI's getters.
//   3. Hands each new AI's ownership to the old one's owner (MAP_EDITOR
//      after a real deploy).
//   4. Calls AIBehaviorRegistry.setVariantAI as the registry's owner, and
//      reads aiFor back.
//
// Crash-safe: each deploy's tx hash is saved to ai-redeploy.json next to
// the deployment journal as soon as it's sent, so a rerun picks up the same
// contract instead of deploying a duplicate. Entries are keyed by contract
// name + bytecode hash + constructor args.
//
// deployed_addresses.json is not changed: it keeps the original AI
// addresses. The registry is the source of truth (aiFor).
//
// Usage:
//   npx hardhat run scripts/redeployVariantAIs.ts --network base-sepolia
//     Plan only: shows which AIs would be redeployed. Sends nothing.
//   APPLY=true MAP_EDITOR_KEY=0x... npx hardhat run scripts/redeployVariantAIs.ts --network base-sepolia
//     Deploys from the network's default account, then calls setVariantAI
//     as the registry's owner (MAP_EDITOR_KEY, or the default account if
//     it's the owner).
//
// Env:
//   APPLY            "true" to send. Anything else: plan only.
//   MAP_EDITOR_KEY   Private key of AIBehaviorRegistry's owner.
//   VERIFY           "true" to verify each new contract on the block explorer.
//   DEPLOYMENT_ID    Deployment folder (default chain-<chainId>).
//   DEPLOYMENT_DIR   Full path to a deployment folder instead (testing).
//   IMPERSONATE      Local fork testing only: owner address to impersonate.
import fs from "fs";
import path from "path";
import hre from "hardhat";
import { createWalletClient, getAddress, http, keccak256, type Abi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

// Each AI by variant: its contract, its constructor dependencies as
// (getter, compiled contract name) in constructor order, as
// DeployAndConfig.ts deploys them.
const AIS = [
  {
    variant: 1,
    name: "Variant1AI",
    deps: [
      ["shipAttributes", "ShipAttributes"],
      ["ramAbility", "RamResolver"],
    ],
  },
  {
    variant: 2,
    name: "Variant2AI",
    deps: [
      ["healAbility", "RepairResolver"],
      ["shipAttributes", "ShipAttributes"],
    ],
  },
] as const;
// The live contracts the AI reads from or is called by, by deployment key.
const COUNTERPARTS = ["Game", "Maps", "SinglePlayerMatch", "RoguelikeMatch"];

// Exported for test/RedeployVariantAIs.test.ts; `hardhat run` runs the file
// as its own process, so the call at the bottom fires there.
export async function main() {
  const APPLY = process.env.APPLY === "true";
  const VERIFY = process.env.VERIFY === "true";
  const publicClient = await hre.viem.getPublicClient();
  const chainId = await publicClient.getChainId();
  const deployDir =
    process.env.DEPLOYMENT_DIR ||
    path.join(__dirname, "..", "ignition", "deployments", process.env.DEPLOYMENT_ID || `chain-${chainId}`);
  const deployed: Record<string, string> = JSON.parse(
    fs.readFileSync(path.join(deployDir, "deployed_addresses.json"), "utf8"),
  );
  const statePath = path.join(deployDir, "ai-redeploy.json");
  const state: Record<string, { hash?: Hex; address?: Address }> = fs.existsSync(statePath)
    ? JSON.parse(fs.readFileSync(statePath, "utf8"))
    : {};
  const saveState = () => fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");

  const artifact = (name: string) => hre.artifacts.readArtifact(name);
  const read = async (name: string, address: Address, functionName: string, args: unknown[] = []) =>
    publicClient.readContract({ address, abi: (await artifact(name)).abi as Abi, functionName, args }) as Promise<any>;
  const deployedAddress = (key: string) => {
    const a = deployed[`DeployModule#${key}`];
    if (!a) throw new Error(`DeployModule#${key} missing from deployed_addresses.json`);
    return getAddress(a);
  };

  // On-chain code vs. the compiled runtime code, with immutable and library
  // slots zeroed on both sides (they hold deploy-time addresses), and
  // without the trailing CBOR metadata (its length is the code's last 2
  // bytes). The metadata hashes every source file, so the match contracts,
  // which import AIBehavior.sol for turnState, get a new hash from any AI
  // change even when their own code is identical.
  const zeroRanges = (hex: string, ranges: { start: number; length: number }[]) => {
    let s = hex.toLowerCase().replace(/^0x/, "");
    for (const r of ranges) s = s.slice(0, r.start * 2) + "0".repeat(r.length * 2) + s.slice((r.start + r.length) * 2);
    const metadata = (parseInt(s.slice(-4), 16) + 2) * 2;
    return metadata < s.length ? s.slice(0, -metadata) : s;
  };
  const matchesCompiled = async (name: string, address: Address) => {
    const a = await artifact(name);
    const buildInfo = await hre.artifacts.getBuildInfo(`${a.sourceName}:${a.contractName}`);
    const evm: any = buildInfo!.output.contracts[a.sourceName][a.contractName].evm.deployedBytecode;
    const ranges = [
      ...Object.values(evm.immutableReferences ?? {}).flat(),
      ...Object.values(evm.linkReferences ?? {}).flatMap((libs: any) => Object.values(libs).flat()),
    ] as { start: number; length: number }[];
    const onChain = (await publicClient.getCode({ address })) ?? "0x";
    return zeroRanges(onChain, ranges) === zeroRanges(evm.object, ranges);
  };

  // ---- 1. Refuse to run against contracts the new AI wasn't built for -------
  const registryAddress = deployedAddress("AIBehaviorRegistry");
  const mismatched: string[] = [];
  for (const key of COUNTERPARTS) {
    const address = deployedAddress(key);
    if (!(await matchesCompiled(key, address))) mismatched.push(`${key} ${address}`);
  }

  // ---- 2. Which AIs changed -------------------------------------------------
  const plan: {
    variant: number;
    name: string;
    old: Address;
    owner: Address;
    args: Address[];
    changed: boolean;
  }[] = [];
  for (const ai of AIS) {
    const old = getAddress(await read("AIBehaviorRegistry", registryAddress, "aiFor", [ai.variant]));
    const args: Address[] = [];
    for (const [getter, depName] of ai.deps) {
      const dep = getAddress(await read(ai.name, old, getter));
      if (!(await matchesCompiled(depName, dep))) mismatched.push(`${depName} ${dep} (${ai.name}.${getter})`);
      args.push(dep);
    }
    const owner = getAddress(await read(ai.name, old, "owner"));
    plan.push({ variant: ai.variant, name: ai.name, old, owner, args, changed: !(await matchesCompiled(ai.name, old)) });
  }
  if (mismatched.length)
    throw new Error(
      `These live contracts don't match the compiled code, so a new AI may not work with them:\n  ` +
        `${mismatched.join("\n  ")}\nRedeploy everything instead.`,
    );

  console.log(`AIBehaviorRegistry ${registryAddress}\n\nPlan:`);
  for (const p of plan) console.log(`  ${p.changed ? "REDEPLOY" : "keep    "} ${p.name} (variant ${p.variant}) ${p.old}`);
  if (!plan.some((p) => p.changed)) {
    console.log("\nBoth AIs already match the compiled code. Nothing to do.");
    return;
  }

  // ---- Signers --------------------------------------------------------------
  const [deployer] = await hre.viem.getWalletClients();
  const registryOwner = getAddress(await read("AIBehaviorRegistry", registryAddress, "owner"));
  const netConfig: any = hre.network.config;
  let ownerWallet: any;
  if (process.env.IMPERSONATE) {
    if (!["hardhat", "localhost"].includes(hre.network.name)) throw new Error("IMPERSONATE is only for local fork testing");
    const who = getAddress(process.env.IMPERSONATE);
    await publicClient.request({ method: "hardhat_impersonateAccount" as any, params: [who] as any });
    await publicClient.request({ method: "hardhat_setBalance" as any, params: [who, "0x56BC75E2D63100000"] as any });
    ownerWallet = await hre.viem.getWalletClient(who);
  } else if (getAddress(deployer.account.address) === registryOwner) {
    ownerWallet = deployer;
  } else if (process.env.MAP_EDITOR_KEY) {
    const raw = process.env.MAP_EDITOR_KEY;
    ownerWallet = createWalletClient({
      account: privateKeyToAccount((raw.startsWith("0x") ? raw : `0x${raw}`) as Hex),
      chain: publicClient.chain,
      transport: http(netConfig.url, { fetchOptions: { headers: netConfig.httpHeaders ?? {} } }),
    });
  }
  console.log(
    `\nDeployer: ${deployer.account.address}\nRegistry owner: ${registryOwner}` +
      `${ownerWallet ? " (have its key)" : " (NO KEY -- set MAP_EDITOR_KEY)"}`,
  );
  if (ownerWallet && getAddress(ownerWallet.account.address) !== registryOwner)
    throw new Error(`MAP_EDITOR_KEY is ${ownerWallet.account.address}, but AIBehaviorRegistry is owned by ${registryOwner}`);

  if (!APPLY) {
    console.log(
      `\nPlan only (set APPLY=true to send). ${plan.filter((p) => p.changed).length} AI(s) to deploy, then setVariantAI.`,
    );
    return;
  }
  if (!ownerWallet) throw new Error("APPLY=true needs MAP_EDITOR_KEY (AIBehaviorRegistry's owner)");

  // ---- Deploy, resumably ----------------------------------------------------
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

  const registryAbi = (await artifact("AIBehaviorRegistry")).abi as Abi;
  for (const p of plan.filter((p) => p.changed)) {
    console.log(`\n${p.name}:`);
    const ai = await deployOne(p.name, p.args);

    // ---- 3. Same dependencies and owner as the old AI ------------------------
    const spec = AIS.find((a) => a.name === p.name)!;
    for (let i = 0; i < spec.deps.length; i++) {
      const got = getAddress(await read(p.name, ai, spec.deps[i][0]));
      if (got !== p.args[i]) throw new Error(`New ${p.name}.${spec.deps[i][0]} is ${got}, expected ${p.args[i]}`);
    }
    const newOwner = getAddress(await read(p.name, ai, "owner"));
    if (newOwner !== p.owner) {
      if (newOwner !== getAddress(deployer.account.address))
        throw new Error(`New ${p.name} is owned by ${newOwner}; can't hand it to ${p.owner}`);
      const hash = await deployer.writeContract({
        address: ai,
        abi: (await artifact(p.name)).abi as Abi,
        functionName: "transferOwnership",
        args: [p.owner],
      });
      await publicClient.waitForTransactionReceipt({ hash });
      console.log(`  ownership -> ${p.owner}`);
    }

    // ---- 4. Point the registry at it --------------------------------------
    const current = getAddress(await read("AIBehaviorRegistry", registryAddress, "aiFor", [p.variant]));
    if (current === ai) {
      console.log(`  registry already points variant ${p.variant} at it`);
    } else {
      const { request } = await publicClient.simulateContract({
        address: registryAddress,
        abi: registryAbi,
        functionName: "setVariantAI",
        args: [p.variant, ai],
        account: ownerWallet.account,
      });
      const hash = await ownerWallet.writeContract(request);
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error(`setVariantAI(${p.variant}) reverted (${hash})`);
      console.log(`  setVariantAI(${p.variant}): ${hash}`);
    }
    const after = getAddress(await read("AIBehaviorRegistry", registryAddress, "aiFor", [p.variant]));
    if (after !== ai) throw new Error(`aiFor(${p.variant}) is ${after} after setVariantAI, expected ${ai}`);
  }

  console.log("\nDone. New matches use the new AI; matches in progress keep the one pinned at mint.");
  for (const p of plan) {
    const now = getAddress(await read("AIBehaviorRegistry", registryAddress, "aiFor", [p.variant]));
    console.log(`  variant ${p.variant}: ${now}${now === p.old ? " (unchanged)" : ` (was ${p.old})`}`);
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

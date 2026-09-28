// One-off utility (2026-09-28): sweeps stray test ETH out of every contract
// this project has ever deployed to Base Sepolia, across the WHOLE git
// history -- not just the currently-deployed set. This project resets to a
// fresh set of contract addresses on every full deploy, so ETH sent to an
// older deployment's Ships/Lobbies/ShipPurchaser/UniversalCredits (ship
// purchase fees, lobby reservation fees, etc.) is otherwise just abandoned.
//
// How addresses are discovered (nothing is hardcoded; new redeploys and new
// commits are picked up automatically):
//   1. Labeled: for EVERY commit reachable from any ref or the reflog
//      (`git rev-list --all --reflog`), every distinct version of
//      ignition/deployments/chain-84532/deployed_addresses.json AND of
//      journal.jsonl is read via `git show <sha>:<path>`. The journal is
//      included because it records every contract a deploy completed
//      (DEPLOYMENT_EXECUTION_STATE_COMPLETE), including deploys that were
//      interrupted before deployed_addresses.json was finalized. The live
//      working-tree copies of both are read too. Result: (contract name ->
//      address) pairs.
//   2. Unlabeled: every 0x-address literal found anywhere else in every
//      commit (docs, scripts, logs, other json -- excluding
//      ignition/deployments, test/, artifacts/) that isn't already labeled.
//      These have no contract name, so any that hold ETH are probed: the
//      script simulates each known withdraw function as the contract's
//      owner() to work out what kind of contract it is.
// Caveat: a deploy that was overwritten (e.g. `--reset`) before it was ever
// committed leaves no trace in git, so its addresses can't be found here.
//
// What actually gets withdrawn: only 4 contract types hold native ETH with
// an owner-gated withdraw function (confirmed by reading every contract's
// `function withdraw`/`payable` -- everything else that takes a fee takes
// it in UTC, an ERC20, not ETH):
//   Ships.withdraw()               -> sends address(this).balance to owner()
//   Lobbies.withdraw()             -> sends address(this).balance to owner()
//   ShipPurchaser.withdrawFlow()   -> sends address(this).balance to owner()
//   UniversalCredits.withdrawAll() -> sends address(this).balance to owner()
// All four are no-argument, send-everything-to-current-owner() calls --
// there's no way to choose a different destination or a partial amount.
// ETH sitting in any other contract (forced/accidental sends) has no
// withdraw path; it's reported but can't be recovered.
//
// Ownership varies per historical deployment: older (fully-completed)
// deploys already ran their PRODUCTION ownership-handover to MAP_EDITOR.
// withdraw() sends to whoever owner() is for THAT instance, which this
// script reads live -- it uses whichever of MAP_EDITOR_KEY,
// SHIP_MINTER_PRIVATE_KEY, METAMASK_WALLET_1_OLD, METAMASK_WALLET_1_OLD_2
// matches, and reports (with calldata info) any it can't sign for.
//
// The script prints every address it checked with its balance, then a plan
// of exactly which withdrawals it would send, and asks y/N before sending
// anything. Answer anything but y/yes (or run with no TTY and no
// SWEEP_CONFIRM=yes) and nothing is sent -- it's a read-only report.
//
// Run with: npx hardhat run scripts/sweepTestEth.ts --network base-sepolia
//
// Configuration via environment variables:
//   SWEEP_CONFIRM=yes                         Skip the prompt (non-interactive only).
//   MAP_EDITOR_KEY / SHIP_MINTER_PRIVATE_KEY /
//   METAMASK_WALLET_1_OLD / METAMASK_WALLET_1_OLD_2
//                                             Candidate owner private keys;
//                                             whichever matches a contract's
//                                             owner() signs for it.
//   BASE_SEPOLIA_RPC_URL                      Defaults to the public RPC.

import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import readline from "readline";
import hre from "hardhat";
import {
  createWalletClient,
  http,
  getAddress,
  isAddress,
  formatEther,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

const CHAIN_ID = 84532;
const REPO_ROOT = path.join(__dirname, "..");
const DEPLOY_DIR = `ignition/deployments/chain-${CHAIN_ID}`;
const HISTORY_FILES = [
  `${DEPLOY_DIR}/deployed_addresses.json`,
  `${DEPLOY_DIR}/journal.jsonl`,
];

type Withdrawable = { artifact: string; fn: string };

// Contract types that actually hold native ETH and have an owner-gated,
// no-argument, send-everything-to-owner() withdraw function. Derived by
// reading every contract's source for `function withdraw`/`payable` --
// re-check if new payable functions are added later.
const WITHDRAWABLE: Record<string, Withdrawable> = {
  "DeployModule#Ships": { artifact: "Ships", fn: "withdraw" },
  "DeployModule#Lobbies": { artifact: "Lobbies", fn: "withdraw" },
  "DeployModule#ShipPurchaser": { artifact: "ShipPurchaser", fn: "withdrawFlow" },
  "DeployModule#UniversalCredits": { artifact: "UniversalCredits", fn: "withdrawAll" },
};

const UNLABELED = "(unlabeled)";

type Entry = { name: string; source: string; address: Address };
type Checked = Entry & { balance: bigint; error?: string };

// ---------------------------------------------------------------------------
// git helpers
// ---------------------------------------------------------------------------

function git(args: string[]): string {
  return execFileSync("git", args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

// git exits nonzero for "no match"/"path missing" -- both just mean "nothing".
function gitOrEmpty(args: string[]): string {
  try {
    return git(args);
  } catch {
    return "";
  }
}

function toAddress(raw: string): Address | undefined {
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) return undefined;
  // Lowercase first so a mixed-case literal with a bad checksum still parses.
  const addr = getAddress(raw.toLowerCase());
  // Skip the zero address and precompile-range addresses.
  if (BigInt(addr) < 2n ** 32n) return undefined;
  return addr;
}

function allCommits(): string[] {
  return git(["rev-list", "--all", "--reflog"])
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

// Adds labeled (name, address) pairs from one deployed_addresses.json body.
function addFromDeployedAddresses(
  body: string,
  source: string,
  labeled: Map<string, Entry>,
) {
  let json: Record<string, string>;
  try {
    json = JSON.parse(body);
  } catch {
    return;
  }
  for (const [name, raw] of Object.entries(json)) {
    const address = toAddress(raw);
    if (address && !labeled.has(address.toLowerCase())) {
      labeled.set(address.toLowerCase(), { name, source, address });
    }
  }
}

// Adds labeled pairs from one journal.jsonl body: each completed contract
// deployment is a line of type DEPLOYMENT_EXECUTION_STATE_COMPLETE with the
// future id ("DeployModule#Ships") and result.address.
function addFromJournal(body: string, source: string, labeled: Map<string, Entry>) {
  for (const line of body.split("\n")) {
    if (!line.includes("DEPLOYMENT_EXECUTION_STATE_COMPLETE")) continue;
    try {
      const rec = JSON.parse(line);
      if (rec.type !== "DEPLOYMENT_EXECUTION_STATE_COMPLETE") continue;
      const address = toAddress(rec.result?.address ?? "");
      if (address && typeof rec.futureId === "string" && !labeled.has(address.toLowerCase())) {
        labeled.set(address.toLowerCase(), { name: rec.futureId, source, address });
      }
    } catch {
      // malformed/truncated line -- skip
    }
  }
}

const ADDRESS_LITERAL = /(^|[^0-9a-zA-Z])(0x[0-9a-fA-F]{40})(?![0-9a-zA-Z])/g;
const GREP_PATHSPEC = [
  "--",
  ".",
  ":(exclude)ignition/deployments",
  ":(exclude)test",
  ":(exclude)node_modules",
  ":(exclude)artifacts",
  ":(exclude)cache",
];

function addressLiteralsIn(text: string, into: Set<string>) {
  for (const m of text.matchAll(ADDRESS_LITERAL)) {
    const address = toAddress(m[2]);
    if (address) into.add(address.toLowerCase());
  }
}

function discoverAddresses(): { labeled: Entry[]; unlabeled: Entry[]; commitCount: number } {
  const commits = allCommits();
  const labeled = new Map<string, Entry>();

  // 1a. Live working-tree copies (may be a newer, possibly in-progress deploy).
  for (const file of HISTORY_FILES) {
    const p = path.join(REPO_ROOT, file);
    if (!fs.existsSync(p)) continue;
    const body = fs.readFileSync(p, "utf8");
    const source = `working_tree:${path.basename(file)}`;
    if (file.endsWith(".json")) addFromDeployedAddresses(body, source, labeled);
    else addFromJournal(body, source, labeled);
  }

  // 1b. Every distinct historical version of both files (deduped by blob id,
  // so an unchanged file across many commits is only parsed once).
  const seenBlobs = new Set<string>();
  for (const sha of commits) {
    for (const file of HISTORY_FILES) {
      const blob = gitOrEmpty(["rev-parse", `${sha}:${file}`]).trim();
      if (!blob || seenBlobs.has(blob)) continue;
      seenBlobs.add(blob);
      const body = gitOrEmpty(["show", blob]);
      const source = `${sha.slice(0, 7)}:${path.basename(file)}`;
      if (file.endsWith(".json")) addFromDeployedAddresses(body, source, labeled);
      else addFromJournal(body, source, labeled);
    }
  }

  // 2. Address literals anywhere else in any commit (and the working tree).
  const literals = new Set<string>();
  addressLiteralsIn(
    gitOrEmpty(["grep", "-h", "-I", "-o", "-E", "(^|[^0-9a-zA-Z])0x[0-9a-fA-F]{40}([^0-9a-zA-Z]|$)", ...GREP_PATHSPEC]),
    literals,
  );
  for (const sha of commits) {
    addressLiteralsIn(
      gitOrEmpty(["grep", "-h", "-I", "-o", "-E", "(^|[^0-9a-zA-Z])0x[0-9a-fA-F]{40}([^0-9a-zA-Z]|$)", sha, ...GREP_PATHSPEC]),
      literals,
    );
  }
  const unlabeled: Entry[] = [];
  for (const lower of literals) {
    if (labeled.has(lower)) continue;
    unlabeled.push({ name: UNLABELED, source: "other files", address: getAddress(lower) });
  }

  return { labeled: [...labeled.values()], unlabeled, commitCount: commits.length };
}

// ---------------------------------------------------------------------------
// signing / utility helpers
// ---------------------------------------------------------------------------

function buildClientFromKey(rawKey: string) {
  const pk = (rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`) as `0x${string}`;
  const account = privateKeyToAccount(pk);
  return createWalletClient({
    account,
    chain: baseSepolia,
    transport: http(process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org"),
  });
}

function candidateSigners() {
  const out: Array<{ label: string; client: ReturnType<typeof buildClientFromKey> }> = [];
  for (const [label, key] of [
    ["MAP_EDITOR_KEY", process.env.MAP_EDITOR_KEY],
    ["SHIP_MINTER_PRIVATE_KEY", process.env.SHIP_MINTER_PRIVATE_KEY],
    // Earlier deployer wallets: older deploys were made (and, if they never
    // ran the ownership handover, are still owned) by these.
    ["METAMASK_WALLET_1_OLD", process.env.METAMASK_WALLET_1_OLD],
    ["METAMASK_WALLET_1_OLD_2", process.env.METAMASK_WALLET_1_OLD_2],
  ] as const) {
    if (!key) continue;
    try {
      out.push({ label, client: buildClientFromKey(key) });
    } catch (e) {
      console.warn(`WARNING: ${label} is set but isn't a usable private key -- ignoring it (${(e as Error).message.split("\n")[0]}).`);
    }
  }
  return out;
}

// Simple bounded-concurrency map so a large balance sweep against a public
// RPC doesn't fire everything at once and get rate-limited.
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// y/N prompt before anything is sent. Anything but an explicit yes aborts.
// With no TTY (piped/CI), it never prompts and only proceeds if
// SWEEP_CONFIRM=yes is set, so an unattended run can't send by accident.
async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    return process.env.SWEEP_CONFIRM === "yes";
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => rl.question(`\n${question} [y/N] `, resolve));
  rl.close();
  return ["y", "yes"].includes(answer.trim().toLowerCase());
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const publicClient = await hre.viem.getPublicClient();
  const chainId = await publicClient.getChainId();
  if (chainId !== CHAIN_ID) {
    throw new Error(
      `Refusing to run: connected chainId is ${chainId}, expected ${CHAIN_ID} (Base Sepolia). ` +
        `Run with --network base-sepolia.`,
    );
  }

  const signers = candidateSigners();
  console.log(
    signers.length
      ? `Available signers: ${signers.map((s) => `${s.label} (${s.client.account!.address})`).join(", ")}`
      : "No signer keys set (MAP_EDITOR_KEY, SHIP_MINTER_PRIVATE_KEY, METAMASK_WALLET_1_OLD, METAMASK_WALLET_1_OLD_2) -- will report only.",
  );

  console.log("\nDiscovering addresses across all git history (this can take a moment)...");
  const { labeled, unlabeled, commitCount } = discoverAddresses();
  const distinctNames = new Set(labeled.map((e) => e.name)).size;
  console.log(
    `Scanned ${commitCount} commits: ${labeled.length} labeled addresses (${distinctNames} contract names), ` +
      `${unlabeled.length} other address literals found in docs/scripts/logs.`,
  );

  const withdrawableLabeled = labeled.filter((e) => WITHDRAWABLE[e.name]);
  console.log(
    `${withdrawableLabeled.length} of the labeled addresses are Ships/Lobbies/ShipPurchaser/UniversalCredits ` +
      `instances (the only types with a withdraw function).`,
  );

  console.log("\n--- Phase 1: balance-checking every address ---");
  const check = async (e: Entry): Promise<Checked> => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return { ...e, balance: await publicClient.getBalance({ address: e.address }) };
      } catch (err) {
        if (attempt === 2) return { ...e, balance: 0n, error: (err as Error).message };
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      }
    }
    return { ...e, balance: 0n, error: "unreachable" };
  };
  const labeledChecked = await mapWithConcurrency(labeled, 15, check);
  const unlabeledChecked = await mapWithConcurrency(unlabeled, 15, check);

  // Every labeled address, with its balance -- printed in full so it's
  // visible exactly what was and wasn't looked at. `*` marks the 4 contract
  // types that have a known withdraw function.
  console.log("\n=== Every labeled address checked ===");
  const sorted = [...labeledChecked].sort(
    (a, b) => a.name.localeCompare(b.name) || a.source.localeCompare(b.source),
  );
  for (const b of sorted) {
    const tag = WITHDRAWABLE[b.name] ? "*" : " ";
    const bal = b.error ? `ERROR (${b.error.slice(0, 60)})` : `${formatEther(b.balance)} ETH`;
    console.log(
      `${tag} ${b.name.replace("DeployModule#", "").padEnd(34)} ${b.source.padEnd(28)} ${b.address}  ${bal}`,
    );
  }

  const errored = [...labeledChecked, ...unlabeledChecked].filter((b) => b.error);
  if (errored.length) {
    console.warn(`\n${errored.length} addresses failed to balance-check (RPC errors) -- not counted, re-run to retry.`);
  }

  // Unlabeled literals: only the ones holding ETH are worth listing. Say
  // whether each is a contract or a plain account (e.g. one of our wallets).
  const unlabeledNonZero = unlabeledChecked.filter((b) => b.balance > 0n);
  console.log(
    `\n=== Other address literals (docs/scripts/logs): ${unlabeledChecked.length} checked, ` +
      `${unlabeledNonZero.length} hold ETH ===`,
  );
  const kindOf = new Map<string, "contract" | "account">();
  for (const b of unlabeledNonZero) {
    let kind: "contract" | "account" = "account";
    try {
      const code = await publicClient.getCode({ address: b.address });
      if (code && code !== "0x") kind = "contract";
    } catch {
      // leave as "account"
    }
    kindOf.set(b.address.toLowerCase(), kind);
    console.log(`  ${b.address}  ${kind.padEnd(8)} ${formatEther(b.balance)} ETH`);
  }

  const nonZero: Checked[] = [
    ...labeledChecked.filter((b) => b.balance > 0n),
    // Unlabeled plain accounts aren't ours to sweep (and have no withdraw fn).
    ...unlabeledNonZero.filter((b) => kindOf.get(b.address.toLowerCase()) === "contract"),
  ];

  const labeledNonZero = labeledChecked.filter((b) => b.balance > 0n);
  const totalHeld = labeledNonZero.reduce((sum, b) => sum + b.balance, 0n);
  console.log(
    `\n${labeledNonZero.length} labeled address(es) hold a nonzero balance, ${formatEther(totalHeld)} ETH total:`,
  );
  for (const b of labeledNonZero) {
    console.log(`  ${b.name} [${b.source}] ${b.address}: ${formatEther(b.balance)} ETH`);
  }

  if (!nonZero.length) {
    console.log("\nNo contract at any known address currently holds any ETH. Nothing to sweep.");
    return;
  }

  // Build the plan (read-only): for each nonzero balance, what kind of
  // contract is it, who owns it, and can we sign as them?
  console.log("\n--- Plan: what a sweep would do ---");
  type PlanItem = {
    b: Checked;
    label: string;
    withdrawable: Withdrawable;
    abi: any;
    owner: Address;
    signer: (typeof signers)[number] | undefined;
  };
  const plan: PlanItem[] = [];
  const strayBalances: Checked[] = [];
  const artifactAbi = async (artifact: string) =>
    (await hre.artifacts.readArtifact(artifact)).abi as any;

  for (const b of nonZero) {
    let withdrawable: Withdrawable | undefined = WITHDRAWABLE[b.name];
    let abi: any;
    let owner: Address | undefined;
    let label = b.name;

    if (withdrawable) {
      abi = await artifactAbi(withdrawable.artifact);
      try {
        owner = getAddress(
          (await publicClient.readContract({ address: b.address, abi, functionName: "owner", args: [] })) as string,
        );
      } catch (err) {
        console.warn(`  ${b.name} [${b.source}] couldn't read owner() -- skipping: ${(err as Error).message}`);
      }
    } else {
      // Unlabeled contract holding ETH: work out its type by simulating each
      // known withdraw function as its owner(); the one that doesn't revert
      // is the type. Reverting simulations cost nothing.
      for (const candidate of Object.values(WITHDRAWABLE)) {
        try {
          const candAbi = await artifactAbi(candidate.artifact);
          const candOwner = getAddress(
            (await publicClient.readContract({ address: b.address, abi: candAbi, functionName: "owner", args: [] })) as string,
          );
          await publicClient.simulateContract({
            address: b.address,
            abi: candAbi,
            functionName: candidate.fn,
            args: [],
            account: candOwner,
          });
          withdrawable = candidate;
          abi = candAbi;
          owner = candOwner;
          label = `${UNLABELED} looks like ${candidate.artifact}`;
          break;
        } catch {
          // not this type -- try the next
        }
      }
    }

    if (!withdrawable || !owner) {
      console.log(`  ${label} [${b.source}] ${b.address} ${formatEther(b.balance)} ETH -- no known withdraw function that works, can't recover`);
      strayBalances.push(b);
      continue;
    }

    const signer = signers.find((s) => getAddress(s.client.account!.address) === owner);
    console.log(
      `  ${label} [${b.source}] ${b.address} ${formatEther(b.balance)} ETH -- ${withdrawable.fn}() sends it to owner ${owner} ` +
        (signer ? `(will sign with ${signer.label})` : `(NO matching signer -- would need manual submission)`),
    );
    plan.push({ b, label, withdrawable, abi, owner, signer });
  }

  const executable = plan.filter((p) => p.signer);
  const executableTotal = executable.reduce((sum, p) => sum + p.b.balance, 0n);
  console.log(
    `\n${executable.length} withdrawal(s) can be sent now, ${formatEther(executableTotal)} ETH total ` +
      `(each costs a little gas from its signer's own balance).`,
  );
  const unsignable = plan.filter((p) => !p.signer);
  if (unsignable.length) {
    console.log(`${unsignable.length} more need a key we don't have (owners: ${[...new Set(unsignable.map((p) => p.owner))].join(", ")}).`);
  }
  if (!executable.length) {
    console.log("Nothing executable with the available signers.");
    return;
  }

  if (!(await confirm("Proceed with these withdrawals?"))) {
    console.log("Aborted -- nothing sent.");
    return;
  }

  console.log("\n--- Withdrawing ---");
  let totalSwept = 0n;

  for (const { b, label, withdrawable, abi, owner, signer } of plan) {
    console.log(`\n${label} [${b.source}] ${b.address} -- ${formatEther(b.balance)} ETH`);
    if (!signer) {
      console.warn(`  owner() is ${owner}, which doesn't match any available signer.`);
      console.warn(`  Manual step -- send this from ${owner}:`);
      console.warn(`    to:   ${b.address}`);
      console.warn(`    function: ${withdrawable.fn}()`);
      strayBalances.push(b);
      continue;
    }

    try {
      const { request } = await publicClient.simulateContract({
        address: b.address,
        abi,
        functionName: withdrawable.fn,
        args: [],
        account: signer.client.account,
      });
      const hash = await signer.client.writeContract(request);
      console.log(`  Submitted (${signer.label}): ${hash}`);
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") {
        console.warn(`  Transaction reverted: ${hash}`);
        strayBalances.push(b);
        continue;
      }
      console.log(`  Mined in block ${receipt.blockNumber} -- ${formatEther(b.balance)} ETH sent to ${owner}.`);
      totalSwept += b.balance;
    } catch (err) {
      console.warn(`  Withdraw failed: ${(err as Error).message}`);
      strayBalances.push(b);
    }
  }

  console.log("\n=== Summary ===");
  console.log(`Swept: ${formatEther(totalSwept)} ETH`);
  if (strayBalances.length) {
    console.log(`\n${strayBalances.length} balance(s) NOT recovered (no known withdraw mechanism, no matching signer, or the call failed):`);
    for (const b of strayBalances) {
      console.log(`  ${b.name} [${b.source}] ${b.address}: ${formatEther(b.balance)} ETH`);
    }
  } else {
    console.log("Nothing left behind.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

// Used by scripts/ignition-deploy-retry.sh when a send fails with the RPC's
// "already known" (written 2026-11-01). That error means the node already
// has this exact signed transaction (the provider resent it), so it went
// out, but Ignition throws before journaling its hash. The journal then
// holds a nonce with no transaction, and every resume fails until the hash
// is added with `ignition track-tx`.
//
// This finds that hash. For each journaled send with no hash, it waits for
// the sender's nonce to move past it, looks up the sender's transaction
// with that nonce on the block explorer (ETHERSCAN_API_KEY, Etherscan v2
// multichain API), and checks that its input, recipient and value match
// the journaled request byte for byte before printing it.
//
// Exit 0: prints TRACK_TX=<hash> and DEPLOYMENT_ID=chain-<id>.
// Exit 1: the nonce was never used, so nothing went out; the next resume
//         hits IGN411, which the retry script already handles with a wipe.
// Exit 2: anything else (no open send, mismatch, lookup failure). Don't retry.
//
// Read-only. Runs through `hardhat run --network <name>`.
import fs from "fs";
import path from "path";
import hre from "hardhat";
import { getAddress, type Address } from "viem";

const NONCE_WAIT_MS = 120_000;
const LOOKUP_TRIES = 12;
const POLL_MS = 5_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const publicClient = await hre.viem.getPublicClient();
  const chainId = await publicClient.getChainId();
  const deploymentId = `chain-${chainId}`;
  const journalPath = path.join(__dirname, "..", "ignition", "deployments", deploymentId, "journal.jsonl");
  const records = fs.readFileSync(journalPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));

  const sent = new Set(
    records.filter((r) => r.type === "TRANSACTION_SEND").map((r) => `${r.futureId}/${r.networkInteractionId}`),
  );
  const open = records.filter(
    (r) => r.type === "TRANSACTION_PREPARE_SEND" && !sent.has(`${r.futureId}/${r.networkInteractionId}`),
  );
  if (open.length !== 1) {
    console.error(`findAlreadyKnownTx: expected one journaled send with no hash, found ${open.length}`);
    process.exit(2);
  }
  const { futureId, networkInteractionId, nonce } = open[0];
  const request = records.find(
    (r) =>
      r.type === "NETWORK_INTERACTION_REQUEST" &&
      r.futureId === futureId &&
      r.networkInteraction.id === networkInteractionId,
  )?.networkInteraction;
  const from = records.find((r) => r.futureId === futureId && r.from)?.from as Address | undefined;
  if (!request || !from) {
    console.error(`findAlreadyKnownTx: no request or sender journaled for ${futureId}`);
    process.exit(2);
  }
  console.log(`findAlreadyKnownTx: ${futureId} nonce ${nonce} from ${from}`);

  // Wait for the transaction to be mined.
  const deadline = Date.now() + NONCE_WAIT_MS;
  while ((await publicClient.getTransactionCount({ address: from, blockTag: "latest" })) <= nonce) {
    if (Date.now() > deadline) {
      const pending = await publicClient.getTransactionCount({ address: from, blockTag: "pending" });
      console.log(`findAlreadyKnownTx: nonce ${nonce} not mined after ${NONCE_WAIT_MS / 1000}s (pending ${pending})`);
      process.exit(pending > nonce ? 2 : 1);
    }
    await sleep(POLL_MS);
  }

  // The explorer can lag the chain by a few blocks.
  const apiKey = process.env.ETHERSCAN_API_KEY;
  if (!apiKey) {
    console.error("findAlreadyKnownTx: ETHERSCAN_API_KEY not set");
    process.exit(2);
  }
  const url =
    `https://api.etherscan.io/v2/api?chainid=${chainId}&module=account&action=txlist` +
    `&address=${from}&sort=desc&page=1&offset=50&apikey=${apiKey}`;
  for (let i = 0; i < LOOKUP_TRIES; i++) {
    const res: any = await (await fetch(url)).json();
    const hit = Array.isArray(res.result) ? res.result.find((t: any) => Number(t.nonce) === nonce) : undefined;
    if (hit) {
      const tx = await publicClient.getTransaction({ hash: hit.hash });
      const matches =
        tx.input.toLowerCase() === String(request.data).toLowerCase() &&
        (tx.to ? getAddress(tx.to) : undefined) === (request.to ? getAddress(request.to) : undefined) &&
        tx.value === BigInt(request.value?.value ?? request.value ?? 0);
      if (!matches) {
        console.error(`findAlreadyKnownTx: nonce ${nonce} is ${hit.hash}, which isn't the journaled ${futureId} request`);
        process.exit(2);
      }
      console.log(`TRACK_TX=${hit.hash}`);
      console.log(`DEPLOYMENT_ID=${deploymentId}`);
      process.exit(0);
    }
    await sleep(POLL_MS);
  }
  console.error(`findAlreadyKnownTx: nonce ${nonce} is mined but the explorer has no tx for it yet`);
  process.exit(2);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});

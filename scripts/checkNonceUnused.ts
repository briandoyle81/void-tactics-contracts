// Used by scripts/ignition-deploy-retry.sh when Ignition fails with IGN411
// and asks you to find a transaction "with nonce N sent from account A"
// with a block explorer. Checks whether nonce N was ever used, so the retry
// script can tell the two cases apart:
//
// - Exit 0 (unused): A's pending nonce on chain is still N, so the send
//   never reached the network. Rerunning alone does NOT help: on resume
//   Ignition throws IGN411 again for any interaction holding a nonce but
//   no transaction, before syncing nonces. The retry script instead runs
//   `ignition wipe` on the stuck future (safe, since nothing was sent),
//   then retries. Also prints CHAIN_ID=<id> for the deployment id.
// - Exit 1 (used): the nonce moved past N, so some transaction went out
//   with it. It needs `npx hardhat ignition track-tx`, not a blind retry.
// - Exit 2: bad input or RPC error. Treat as "don't retry".
//
// Read-only (one eth_getTransactionCount call). Runs through `hardhat run
// --network <name>` so it uses the network's configured RPC and headers.
//
// Env: NONCE_CHECK_ACCOUNT (0x address), NONCE_CHECK_NONCE (integer).
import hre from "hardhat";

async function main() {
  const account = process.env.NONCE_CHECK_ACCOUNT ?? "";
  const nonceStr = process.env.NONCE_CHECK_NONCE ?? "";
  if (!/^0x[0-9a-fA-F]{40}$/.test(account) || !/^\d+$/.test(nonceStr)) {
    console.error(
      `checkNonceUnused: bad NONCE_CHECK_ACCOUNT/NONCE_CHECK_NONCE (${account}, ${nonceStr})`
    );
    process.exit(2);
  }
  const nonce = Number(nonceStr);

  const publicClient = await hre.viem.getPublicClient();
  const pending = await publicClient.getTransactionCount({
    address: account as `0x${string}`,
    blockTag: "pending",
  });

  if (pending === nonce) {
    console.log(`CHAIN_ID=${await publicClient.getChainId()}`);
    console.log(
      `checkNonceUnused: nonce ${nonce} from ${account} is unused (pending nonce ${pending})`
    );
    process.exit(0);
  }
  console.log(
    `checkNonceUnused: nonce ${nonce} from ${account} is NOT free (pending nonce ${pending})`
  );
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});

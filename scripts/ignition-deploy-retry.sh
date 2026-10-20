#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  ./ignition-deploy-retry.sh --network <network-name> [--deploy-script <path/to/Module.ts>] [--with-lottery-pool]

If --deploy-script is omitted, every module in ignition/modules/*.ts is deployed
(in alphabetical order), each with its own retry loop. Paths are resolved from
the repo root.

Options:
  --deploy-script <p> Deploy a single module. If omitted, deploy all modules.
  --skip-verify        Do not pass `--verify` to hardhat ignition deploy
  --no-auto-confirm   Do not auto-answer "y" to any deploy confirmation prompts
  --sleep-seconds <n> Sleep seconds between retries on transient errors (see retry conditions below)
  --with-lottery-pool After the Ignition deploy succeeds, run
                      scripts/deployUTCLotteryPool.ts (UTCLotteryHook + its
                      Uniswap v4 pool) with the same retry handling. Its env
                      vars (MAP_EDITOR_KEY, SKIP_SMOKE_TEST, DRY_RUN_ONLY, ...)
                      pass straight through; see that script's header. Safe to
                      retry: every step skips work a prior run already did.

Environment variables:
  LOG_FILE            Log file to write (default: ignition_deploy_retry.log)
  SLEEP_SECONDS      Sleep seconds between retries (default: 5)

RPC-provider-outage retries ("no backend is currently healthy to serve
traffic", seen against base-sepolia's public RPC endpoint under load) use
their own exponential backoff instead of --sleep-seconds: 5s, 10s, 20s,
40s... doubling each retry, stopping (rather than actually waiting) once
the next wait would exceed 3 minutes. Every other known-transient error
(nonce mismatch, IGN411, underpriced gas) keeps retrying at the fixed
--sleep-seconds interval with no limit, unchanged.

IGN411 with "Please use a block explorer to find the hash of the
transaction with nonce N" (2026-10-19): the script checks the account's
pending nonce on chain (scripts/checkNonceUnused.ts, read-only). If it is
still N, the send never landed, so there is no hash for track-tx: the script
runs `npx hardhat ignition wipe chain-<id> <futureId>` on the stuck future
and retries, which sends it fresh (up to 5 times in a row per future).
Otherwise it stops and prints the `ignition track-tx` command to run.

PRODUCTION flag handling: for any --network other than "hardhat"/"localhost",
this script sets `const PRODUCTION = true;` in
ignition/modules/DeployAndConfig.ts before deploying (that flag gates
real-deploy-only setup, e.g. transferring contract ownership away from the
deployer, and defaults to false so test fixtures work) and always restores
it to `const PRODUCTION = false;` on exit -- success, failure, or
interruption (Ctrl-C) -- via a trap, so it can never be left committed as
true. It does NOT run the test suite afterward; run `npx hardhat test`
yourself to confirm PRODUCTION=false didn't leave anything broken.
EOF
}

NETWORK=""
DEPLOY_SCRIPT=""
VERIFY=1
AUTO_CONFIRM=1
WITH_LOTTERY_POOL=0
SLEEP_SECONDS_DEFAULT="5"

LOG_FILE="${LOG_FILE:-ignition_deploy_retry.log}"
SLEEP_SECONDS="${SLEEP_SECONDS:-$SLEEP_SECONDS_DEFAULT}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --network)
      NETWORK="${2:-}"
      shift 2
      ;;
    --deploy-script)
      DEPLOY_SCRIPT="${2:-}"
      shift 2
      ;;
    --skip-verify)
      VERIFY=0
      shift 1
      ;;
    --no-auto-confirm)
      AUTO_CONFIRM=0
      shift 1
      ;;
    --sleep-seconds)
      SLEEP_SECONDS="${2:-}"
      shift 2
      ;;
    --with-lottery-pool)
      WITH_LOTTERY_POOL=1
      shift 1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "$NETWORK" ]]; then
  usage >&2
  exit 2
fi

# Run from the repo root so module paths and the Ignition deployment dir resolve
# consistently regardless of where the script is invoked from.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

DEPLOY_MODULE_FILE="ignition/modules/DeployAndConfig.ts"

# Rewrites the `const PRODUCTION = <true|false>;` line in-place. Uses python3
# (already a dependency of this script's retry-detection logic below) rather
# than sed, to sidestep BSD-vs-GNU sed -i flag differences across macOS/Linux.
set_production_flag() {
  local value="$1" # "true" or "false"
  python3 -c "
import pathlib, re, sys
p = pathlib.Path('$DEPLOY_MODULE_FILE')
s = p.read_text()
s2, n = re.subn(r'^const PRODUCTION = (?:true|false);', 'const PRODUCTION = $value;', s, count=1, flags=re.M)
if n == 0:
    sys.exit(\"Could not find 'const PRODUCTION = ...;' in $DEPLOY_MODULE_FILE\")
p.write_text(s2)
"
}

# DeployAndConfig.ts's `PRODUCTION` flag gates real-deploy-only setup (e.g.
# transferring contract ownership away from the deployer) -- see its own
# comment there. It defaults to false so every test fixture can deploy the
# same module via hre.ignition.deploy(DeployModule) without that gated setup
# breaking owner-gated test calls. Flip it to true only for the duration of
# an actual real-network deploy, and always restore it to false on exit --
# success, failure, or interruption (Ctrl-C) -- via a trap, so a real deploy
# can never again leave it committed as true (see CLAUDE.md's documented
# 2026-08-26 incident: PRODUCTION left true broke every test with no error
# pointing at the actual cause).
if [[ "$NETWORK" != "hardhat" && "$NETWORK" != "localhost" ]]; then
  echo "Setting PRODUCTION = true in $DEPLOY_MODULE_FILE for this real-network deploy..."
  set_production_flag true
  restore_production_flag() {
    echo "Restoring PRODUCTION = false in $DEPLOY_MODULE_FILE..."
    set_production_flag false
  }
  trap restore_production_flag EXIT
fi

# Deploy a single module with an automatic retry loop on transient errors.
# Returns 0 on success, or the deploy command's exit code on a non-retryable error.
deploy_with_retry() {
  local script="$1"
  local CMD=(npx hardhat ignition deploy "$script" --network "$NETWORK")
  if [[ "$VERIFY" -eq 1 ]]; then
    CMD+=(--verify)
  fi
  run_with_retry "$script" "${CMD[@]}"
}

# Runs scripts/deployUTCLotteryPool.ts (added 2026-10-17). It reads the
# Ignition deployment's deployed_addresses.json, so it only runs after the
# Ignition deploy above succeeds. Re-running it is safe: it skips the hook
# deploy, pool initialize, LP seed, and grants when a prior run already did
# them.
deploy_lottery_pool_with_retry() {
  local script="scripts/deployUTCLotteryPool.ts"
  run_with_retry "$script" npx hardhat run "$script" --network "$NETWORK"
}

# Runs a command with an automatic retry loop on transient errors.
# Usage: run_with_retry <label> <command...>
run_with_retry() {
  local script="$1"
  shift
  local CMD=("$@")

  # Exponential backoff, but only for the RPC-provider-outage case ("no
  # backend is currently healthy to serve traffic" -- seen against
  # base-sepolia's public RPC endpoint, which is periodically overloaded).
  # Separate from SLEEP_SECONDS below, which stays a fixed interval for the
  # other known-transient errors (nonce mismatch, IGN411, underpriced gas)
  # -- those aren't RPC-outage symptoms, so there's no reason to make them
  # wait longer on each retry. Starts at 5s, doubles each retry (5, 10, 20,
  # 40, 80, 160...), and gives up once the *next* wait would exceed the cap
  # rather than actually waiting that long.
  local backend_wait=5

  # IGN411 auto-wipe (see below): stop if the same future keeps failing to
  # send, rather than wiping and resending it forever.
  local last_wiped_future=""
  local wipe_count=0
  local MAX_WIPES_PER_FUTURE=5
  local BACKEND_WAIT_CAP_SECONDS=180

  while true; do
    : > "$LOG_FILE"
    echo "--- deploy $script retry $(date) ---"

    # Run and stream output to log; capture the deploy command exit code from bash's PIPESTATUS.
    set +e
    if [[ "$AUTO_CONFIRM" -eq 1 ]]; then
      # Hardhat Ignition may ask for an interactive confirmation (e.g. "Confirm deploy to network ... (y/N)").
      # Feed "y" continuously so retries never require human interaction.
      "${CMD[@]}" < <(yes) 2>&1 | tee "$LOG_FILE"
    else
      "${CMD[@]}" 2>&1 | tee "$LOG_FILE"
    fi
    local ec="${PIPESTATUS[0]}"
    set -e

    if [[ "$ec" -eq 0 ]]; then
      echo "SUCCESS: $script"
      return 0
    fi

    # RPC-provider-outage case: back off exponentially instead of the fixed
    # SLEEP_SECONDS interval used below, and stop retrying (rather than
    # blindly waiting) once the next wait would exceed the cap.
    if grep -qF "no backend is currently healthy to serve traffic" "$LOG_FILE"; then
      if [[ "$backend_wait" -gt "$BACKEND_WAIT_CAP_SECONDS" ]]; then
        echo "Stopping: RPC backend still unhealthy after backing off past ${BACKEND_WAIT_CAP_SECONDS}s in $script"
        return "$ec"
      fi
      echo "RPC backend unhealthy; retrying $script in ${backend_wait}s..."
      sleep "$backend_wait"
      backend_wait=$((backend_wait * 2))
      continue
    fi

    # Retry on transient errors: nonce mismatch, Ignition rerun hint, underpriced gas, or IGN411
    # without the "use a block explorer" hint (that case needs track-tx or ignition wipe, not a blind retry).
    set +e
    python3 -c '
import pathlib, sys
p = pathlib.Path("'"$LOG_FILE"'")
s = p.read_text(errors="ignore")
explorer_hint = "Please use a block explorer" in s
retry_ign411 = "IGN411" in s and not explorer_hint
retry = (
    "The next nonce" in s
    or "Please try rerunning Hardhat Ignition." in s
    or retry_ign411
    or "transaction underpriced" in s
    or "nonce too low" in s.lower()  # viem wording, from deployUTCLotteryPool.ts
)
sys.exit(0 if retry else 1)
'
    local retryable=$?
    set -e

    if [[ "$retryable" -eq 0 ]]; then
      echo "Retrying $script due to transient deploy error..."
      sleep "$SLEEP_SECONDS"
      backend_wait=5 # reset the outage backoff; this retry wasn't one
      continue
    fi

    # IGN411 with the "use a block explorer" hint: Ignition journaled a
    # nonce for a future, then the send failed, so the journal holds a nonce
    # with no transaction. On every resume Ignition throws IGN411 again for
    # that (a plain retry loops forever), and track-tx needs a hash that
    # doesn't exist if the send never reached the chain. So: if the chain
    # confirms the nonce is unused, `ignition wipe` the stuck future (an
    # append-only journal entry; it refuses if anything depends on the
    # future) and retry, which sends it fresh. If the nonce was used, stop so
    # the tx can be added with track-tx (see scripts/checkNonceUnused.ts).
    if grep -qF "IGN411" "$LOG_FILE" && grep -qF "Please use a block explorer" "$LOG_FILE"; then
      local stuck stuck_future
      stuck="$(grep -oE "with nonce [0-9]+ sent from account 0x[0-9a-fA-F]{40}" "$LOG_FILE" | head -n1 || true)"
      stuck_future="$(grep -oE "transaction for future [^ ]+\." "$LOG_FILE" | head -n1 | sed -E 's/^transaction for future //; s/\.$//' || true)"
      if [[ -n "$stuck" && -n "$stuck_future" ]]; then
        local stuck_nonce stuck_account
        stuck_nonce="$(echo "$stuck" | awk '{print $3}')"
        stuck_account="$(echo "$stuck" | awk '{print $7}')"
        # Give a just-sent tx time to show up in the pending pool first.
        echo "IGN411: checking whether nonce $stuck_nonce from $stuck_account was ever used (in ${SLEEP_SECONDS}s)..."
        sleep "$SLEEP_SECONDS"
        set +e
        local check_out
        check_out="$(NONCE_CHECK_ACCOUNT="$stuck_account" NONCE_CHECK_NONCE="$stuck_nonce" \
          npx hardhat run scripts/checkNonceUnused.ts --network "$NETWORK" 2>&1)"
        local nonce_check=$?
        set -e
        echo "$check_out" | grep -E "^(checkNonceUnused|CHAIN_ID=)" || true
        local chain_id
        chain_id="$(echo "$check_out" | grep -oE "^CHAIN_ID=[0-9]+" | head -n1 | cut -d= -f2 || true)"
        if [[ "$nonce_check" -eq 0 && -n "$chain_id" ]]; then
          if [[ "$stuck_future" == "$last_wiped_future" ]]; then
            wipe_count=$((wipe_count + 1))
          else
            last_wiped_future="$stuck_future"
            wipe_count=1
          fi
          if [[ "$wipe_count" -gt "$MAX_WIPES_PER_FUTURE" ]]; then
            echo "Stopping: $stuck_future failed to send $MAX_WIPES_PER_FUTURE times in a row; check the RPC/account."
            return "$ec"
          fi
          echo "Nonce $stuck_nonce was never used; wiping $stuck_future (chain-$chain_id) and retrying ($wipe_count/$MAX_WIPES_PER_FUTURE)..."
          if ! npx hardhat ignition wipe "chain-$chain_id" "$stuck_future"; then
            echo "Stopping: ignition wipe failed for $stuck_future"
            return "$ec"
          fi
          backend_wait=5
          continue
        fi
        echo "Nonce $stuck_nonce was used (or the check failed). Find that tx and run:"
        echo "  npx hardhat ignition track-tx <txHash> <deploymentId> --network $NETWORK"
      fi
    fi

    echo "Stopping due to non-retryable error in $script (exit code: $ec)"
    return "$ec"
  done
}

if [[ -n "$DEPLOY_SCRIPT" ]]; then
  deploy_with_retry "$DEPLOY_SCRIPT" || exit $?
  if [[ "$WITH_LOTTERY_POOL" -eq 1 ]]; then
    deploy_lottery_pool_with_retry || exit $?
  fi
  exit 0
fi

# No --deploy-script provided: deploy every module in ignition/modules.
shopt -s nullglob
MODULES=(ignition/modules/*.ts)
shopt -u nullglob

if [[ ${#MODULES[@]} -eq 0 ]]; then
  echo "No modules found in ignition/modules/*.ts" >&2
  exit 1
fi

echo "Deploying all modules:"
printf '  %s\n' "${MODULES[@]}"

for module in "${MODULES[@]}"; do
  deploy_with_retry "$module" || {
    ec=$?
    echo "Aborting: $module failed (exit code: $ec)"
    exit "$ec"
  }
done

echo "ALL MODULES DEPLOYED"

if [[ "$WITH_LOTTERY_POOL" -eq 1 ]]; then
  deploy_lottery_pool_with_retry || exit $?
fi

# Deploy Runbook — Main Redeploy, Then the Uniswap Lottery Pool

_Written 2026-09-12. Describes contract state as of this date. Re-verify against
`ignition/deployments/chain-84532/deployed_addresses.json` and the actual contract
source if this is read much later — both may have moved on._

> **Audience:** whoever (human or agent) is actually running the real Base Sepolia
> deploy from this repo. Not the FE/BE repo — see
> `docs/uniswap-lottery-selfie-check-frontend-integration.md` for that handoff.

This is a two-phase sequence: **Phase 1** redeploys the whole game (picks up every
contract change from this session — Selfie Check eligibility gating, the new
`FreeShipsClaimed` event, everything). **Phase 2** — only after Phase 1 is live —
deploys `UTCLotteryHook.sol` and its real Uniswap v4 pool against the fresh
addresses Phase 1 produces. Do not run Phase 2 against a stale/old deployment.

---

## Deploy-safety reminders (apply to both phases)

- **Base Sepolia only.** Never target mainnet or another testnet without
  explicit direction for that specific deploy.
- **`PRODUCTION` must be `false` before running `npx hardhat test`** — confirm
  with `grep -n "^const PRODUCTION" ignition/modules/DeployAndConfig.ts`.
  Flipping it to `true` is *only* for the real deploy transaction itself; flip
  it back to `false` and re-run the test suite immediately after, before
  leaving it committed.
- Read `CLAUDE.md`'s "Deployment Safety" and "Git Write Commands Require
  Explicit Permission" sections before doing anything here for real — this
  runbook assumes you've already read them.

---

## Phase 1 — Main game redeploy

### 1.1 Preconditions

- [ ] `.env` has `METAMASK_WALLET_1` (the deploy signer) funded with enough
      Base Sepolia ETH for the full deploy (dozens of contracts + many config
      calls — budget generously).
- [ ] `.env` has `MAP_EDITOR_KEY` set — the private key for `MAP_EDITOR`
      (`ignition/modules/DeployAndConfig.ts`'s hardcoded constant), which is
      who this deploy's ownership-handover step actually transfers `Ships` to
      (not whichever wallet ran the deploy). Phase 2 checks this key first for
      both owner-gated calls it needs. `SHIP_MINTER_PRIVATE_KEY` still works
      as a fallback name for the same key if that's what you already have set.
- [ ] `npx hardhat test` passes (650/650 as of this writing) with `PRODUCTION
      = false`.

### 1.2 Run the deploy

```bash
# 1. Flip PRODUCTION to true in ignition/modules/DeployAndConfig.ts (line ~24).
#    Do NOT commit this as true.

# 2. Deploy for real. Use scripts/ignition-deploy-retry.sh rather than a bare
#    `npx hardhat ignition deploy` — it refuses to run at all unless
#    PRODUCTION is actually true (a real safety check, not just a reminder),
#    and auto-retries known-transient failures (RPC outages, nonce races,
#    underpriced gas) instead of leaving a partial deploy for you to
#    diagnose by hand:
./scripts/ignition-deploy-retry.sh --network base-sepolia \
  --deploy-script ignition/modules/DeployAndConfig.ts

# 3. Flip PRODUCTION back to false immediately.

# 4. Confirm the test suite still passes against the local ephemeral network
#    (this does NOT touch the real deploy — it's just re-validating the repo
#    state is sane):
npx hardhat test
```

If step 2 stops on a non-retryable error, re-running the same command is safe
— Hardhat Ignition's own journal makes re-invocation resumable (it skips
whatever already completed), which is exactly what the retry script leans on.

### 1.3 What this deploy does that's new since the last one

- Deploys the real `SelfieCheckEligibilityProvider` (not the `MockAlwaysEligible`
  test stand-in), owned by the deployer and handed to `MAP_EDITOR` at the end
  of the module, same as every other `Ownable` contract.
- Calls `setAuthorizedVerifier(FIREBASE_FLOW_MINTER, true)` on it — the
  existing ship-minting backend wallet also becomes the Selfie-Check-verifying
  backend's relay key. **This does not mean Selfie Check verification is
  live** — the backend still needs to actually implement the
  off-chain-verify-then-`markVerified` flow (see the FE/BE handoff doc).
- Wires that **one shared instance** to both `FreeShipClaim.setEligibilityProvider`
  and `TutorialClaim.setEligibilityProvider`.
- **Behavior change, take this seriously:** once this is live, `FreeShipClaim.
  claimFreeShips` and `TutorialClaim.completeTutorialWinPath`/
  `completeTutorialLossPath` are immediately, unconditionally gated on
  `SelfieCheckEligibilityProvider.isEligible(player)` — there's no "leave it
  open for now" lever once a real (non-zero-address) provider is wired. If
  the backend relay isn't ready yet, **every player is locked out of free
  ships and tutorial rewards** until it is. Confirm this is the intended
  timing before running Phase 1 for real.
- `FreeShipClaim.claimFreeShips` now emits `FreeShipsClaimed(player, amount)`
  on-chain for the first time (previously only in source, unreachable on the
  live deploy) — this is what unblocks Pick 1's subgraph indexing of it.

### 1.4 `Ships.paused` — the "unlock ship minting after we deploy" lever

`Ships.sol` has an owner-only `setPaused(bool)` / public `paused` flag,
checked inside `_mintShip` (so it blocks `createShips`/`createSpecificShip`
regardless of which authorized-minter contract calls them). It defaults to
`false` and nothing in `DeployAndConfig.ts` touches it — so **minting is live
immediately after Phase 1** unless you explicitly call `Ships.setPaused(true)`
yourself as a manual post-deploy step. If you intend to keep it paused for a
period after this deploy before "unlocking" minting for players, that's a
manual call, not something either script does.

**Interaction with Phase 2:** Phase 2's smoke test only performs a swap — it
never mints a ship, so it's unaffected by `paused`. But the *real* first
`UTCLotteryHook.resolveDraw()` call **does** mint a prize ship
(`createSpecificShip`/`createShips`), and will revert while `Ships.paused ==
true`. Make sure minting is unpaused before the first real draw is expected to
resolve, not just before Phase 2 runs.

---

## Phase 2 — Uniswap lottery pool deploy

Only run this after Phase 1 is live and you've confirmed
`ignition/deployments/chain-84532/deployed_addresses.json` reflects it.

### 2.1 Preconditions

- [ ] `.env` has `MAP_EDITOR_KEY` set (see 1.1) — **this is now a hard
      requirement, not just nice-to-have.** As of the HA2-02 fix (2026-09-12),
      `PoolManager.initialize` is owner-gated on the hook, so this key must
      also match `hookOwnerAddress` (defaults to `MAP_EDITOR`, same as
      `Ships.owner()` after Phase 1's handover) for the script to complete
      Phase 2 in one run. `SHIP_MINTER_PRIVATE_KEY` is checked as a fallback
      if `MAP_EDITOR_KEY` isn't set. If neither matches, the script prints
      calldata for manual submission and halts at whichever step needs it —
      the ship-minting grant is safely skippable, but pool-initialize is not
      (everything after it depends on the pool existing).
- [ ] Deploy wallet (`METAMASK_WALLET_1`) funded with enough Base Sepolia ETH.
      **As of 2026-09-17, `SKIP_SMOKE_TEST` defaults to `true`** (see below),
      so routine runs only need hook-deploy gas plus a cheap ~$10-equivalent
      LP seed — a small faucet claim covers it. Only budget for the smoke
      test's much larger LP-seed requirement (~1+ ETH — real testnet ETH is
      scarce, faucets give ~0.01 ETH at a time) if you're deliberately
      passing `SKIP_SMOKE_TEST=false` to prove the integration end-to-end
      with real funding.
- [ ] Decide (or accept the defaults) for the script's optional env vars —
      see `scripts/deployUTCLotteryPool.ts`'s own header comment for the
      full list (`REFERENCE_TIER_INDEX`, `LP_SEED_UC_AMOUNT`,
      `HOOK_OWNER_ADDRESS`, `DRY_RUN_ONLY`, `SKIP_SMOKE_TEST`).

### 2.2 Run it

```bash
npx hardhat run scripts/deployUTCLotteryPool.ts --network base-sepolia
```

The script is idempotent-by-state-inspection — safe to re-run from the top if
it fails partway (it re-checks bytecode presence, `poolLocked` state, and
current balances before doing anything it's already done).

### 2.3 What it does

Mines a CREATE2 salt against the real canonical deployment proxy, deploys
`UTCLotteryHook`, computes an initial pool price from `ShipPurchaser`'s live
mint rate, sources LP-seed UC via `purchaseUTCWithFlow`, initializes the real
Uniswap v4 pool (**the one genuinely irreversible step** — see the script's
header comment for why that's not treated as high-ceremony right now; also
now owner-gated on the hook itself per the HA2-02 fix, and sent from
`shipMinterClient` rather than the general deploy wallet), adds liquidity,
grants the hook `Ships.setIsAllowedToCreateShips`, and runs one real
smoke-test sell swap — verified via both the decoded `SellRecorded` event and
a direct state read before the script declares success.

### 2.4 If something goes wrong

- **`PoolAlreadyLocked` / the script reports a hook locked to the wrong (or a
  price-distorted) pool:** there is no on-chain fix for that specific hook
  address, **and re-running this script alone will not give you a different
  one.** Confirmed 2026-09-17: `hookMiner.ts`'s salt search is deterministic
  given the same constructor args (Ships/UniversalCredits/
  hookOwnerAddress), so it always reproduces the same hook address until one
  of those inputs changes. The only way to get a genuinely fresh hook is to
  **redeploy Phase 1 first** (a fresh `UniversalCredits` etc. — this project's
  UTC contract isn't meant to be permanent yet, so this is the expected normal
  cycle, not a workaround), *then* re-run this script. Don't try to reuse the
  old hook or its pool for anything once this happens.
- **Manual grant printed instead of sent:** neither `MAP_EDITOR_KEY` nor
  `SHIP_MINTER_PRIVATE_KEY` matched `Ships.owner()`. Submit the printed
  `to`/`data` from whichever wallet actually holds owner rights (e.g. via
  Basescan's "Write Contract" using raw calldata, or a separately-keyed
  script run) — or just set `MAP_EDITOR_KEY` in `.env` and re-run, which is
  the automated path this is for.
- **Script throws with a printed `initialize` calldata instead of completing:**
  neither `MAP_EDITOR_KEY` nor `SHIP_MINTER_PRIVATE_KEY` matched
  `hookOwnerAddress` — unlike the grant above, this step can't be skipped
  (liquidity/smoke-test all depend on the pool existing), so the script halts
  here on purpose. Set `MAP_EDITOR_KEY` in `.env` and re-run (preferred,
  fully automated), or submit the printed `to`/`data` manually from the
  hook's actual owner wallet and then **re-run the whole script** — it's
  idempotent, so it'll skip everything already done and pick up at
  liquidity-adding either way.
- **Smoke test fails to find a `SellRecorded` event:** confirmed on-chain
  2026-09-17 — the actual cause was the default LP seed (~$10-equivalent)
  being far too small relative to the smoke-test sell size, so the trade's
  own price impact ate most of its proceeds (a trade that's a large fraction
  of a pool's reserve gets real proceeds well below the naive/linear
  estimate). The script now sizes the default LP seed relative to the
  smoke-test sell size specifically (see `LP_SEED_TO_SMOKE_TEST_RATIO` in
  `deployUTCLotteryPool.ts`) so this shouldn't recur by default — if you set
  `LP_SEED_UC_AMOUNT` explicitly, keep it comfortably above that same floor
  (the script warns if it isn't) rather than assuming a small round-number
  seed is fine.

### 2.5 After a successful run

- Copy the printed hook address, `PoolKey`, and `sqrtPriceX96` into
  `docs/uniswap-lottery-selfie-check-frontend-integration.md`'s constants
  table (currently marked `TBD`) — the script does not persist its own
  output anywhere.
- Curate real `PrizeTemplate`s via `UTCLotteryHook.queuePrizeTemplate` (owner
  call) — the queue starts empty, so every draw uses the random-4-star
  fallback until you do.
- Confirm `Ships.paused` is `false` before the first real draw is expected to
  resolve (see 1.4).

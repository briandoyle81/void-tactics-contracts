# Void Tactics Contracts

## Contract Size Limits

You are **never** allowed to turn on or enable "ignore contract size" (or equivalent) for compilation.

- Do **not** add or set options that skip or ignore contract size checks (e.g. in Hardhat, Solidity config, or contract-sizer).
- Do **not** suggest disabling or bypassing the 24 KiB deployment / 24 KiB init size limits.
- If contracts exceed size limits, reduce size by refactoring, libraries, or optimizer settings — do not disable the check.

This applies to any config that would ignore or suppress contract size warnings/errors (e.g. `ignoreContractSizeLimit`, `ignoreSizeLimit`, or similar).

## Deployment Safety

- **Never delete folders/directories.** If a directory needs to be removed, tell the user and let them do it themselves.
- To validate contract or deploy-script changes, use the test suite (`npx hardhat test`) and the ephemeral in-memory deploys it performs via `loadFixture`/`hre.ignition.deploy(...)`.
- **Never run `npx hardhat ignition deploy` (or equivalent) against any network other than the local ephemeral `hardhat` network.** Do not deploy to `base-sepolia` or any other real/live network unless the user explicitly directs you to do that specific deploy.

## Check the `PRODUCTION` Flag Before Running Tests

`ignition/modules/DeployAndConfig.ts` has a module-level `const PRODUCTION` flag. It must be `false` before running `npx hardhat test` — every test fixture deploys this same module via `hre.ignition.deploy(DeployModule)`, and when `PRODUCTION` is `true` the module points several contracts at hardcoded real-network addresses (instead of test mocks) and runs a real-deploy-only ownership-transfer step, neither of which exist/make sense on the ephemeral test chain.

- Before running the test suite, `grep -n "^const PRODUCTION" ignition/modules/DeployAndConfig.ts` (or just read the line) and confirm it says `false`. If it's `true`, that's a real bug to flag/fix before trusting any test result, not something to work around.
- **Found 2026-08-26:** `PRODUCTION` was left `true` after the last real deploy (the "Redeploy" commit) and stayed that way, committed, on `main`. This caused mass failures across every test file using the shared full-deploy fixture (`DroneEnergyCores`, `DroneStorefront`, `Game`, and others) — with no error pointing at the actual cause; it just looked like a huge, unrelated regression. Diagnosed by tracing a `HardhatPluginError: Expected contract future but got undefined` back to `hre.ignition.deploy` itself, then finding the flag via `grep -n "PRODUCTION = "`.
- If you ever need to run a real deploy, flip it to `true` for that deploy only, and flip it back to `false` and confirm the test suite passes again before leaving it — do not leave `PRODUCTION = true` committed.

## Git Write Commands Require Explicit Permission

Do **not** run `git commit`, `git push`, `git merge`, `git rebase`, `git reset`, `git checkout -- <file>`, `git mv`, `git add` for the purpose of committing, or any other git command that changes repo state (local or remote), without the user explicitly asking for that specific action first. Read-only commands (`git status`, `git diff`, `git log`, `git show`, `git fetch`, `git ls-tree`, etc.) are fine at any time.

- "Fix the push" or "resolve this conflict" is not blanket permission for every write command that might be involved — narrate the plan and get a go-ahead for the consequential steps (commit, push, rebase/reset), especially anything that rewrites history.
- This applies even when a write operation seems obviously safe or fully reversible (e.g. commits that only touch local, unpushed history) — ask first rather than judging reversibility yourself.

## Deployment Safety

Hardhat Ignition does **not** guarantee `m.call(...)` invocations execute on-chain in the order they're registered in a deploy module — only `after:`-declared dependencies are honored. Independent calls (or independent branches of a dependency graph) can be interleaved/reordered by Ignition's own scheduler.

- Never assume a resource's on-chain id equals its 1-indexed position in a JS array/loop unless every call that creates one of these resources is *also* explicitly chained to the previous one via `after:` (as `ignition/modules/DeployAndConfig.ts` does for maps, campaigns, and campaign nodes) — without that forced chain, a branching dependency graph (e.g. multiple independent prerequisite chains hanging off a shared node) can silently assign ids out of the order you expect, corrupting anything computed from the guessed id (e.g. a later node's prerequisites pointing at the wrong node).
- This was found and fixed once already (30-node campaign seed, 2026-08-03): two nodes in independent branches got their ids swapped relative to array position. If you add new branching content to a deploy module that assigns ids this way, either keep the "chain every call to the previous one" pattern going, or switch to reading the real id back via `m.readEventArgument(call, "SomeCreatedEvent", "someId", {...})` (already used for `aiConfigIds` in the same file) instead of guessing it.

## Assume Hostile Outside Actors

When designing, reviewing, or reasoning about any smart contract operation — especially permissionless ones (no access control, callable by any address) — assume extreme hostility from every outside actor. Never reason about whether an attacker has "a reason to" grief, front-run, or otherwise abuse a call; assume they will if it is possible and costs them nothing (or only gas), even if it gains them no funds and only harms someone else's UX or availability.

- Do not dismiss a griefing/DoS vector because it's "not profitable" for the attacker, or because "no one would bother." Pure griefing (wasting a victim's gas, forcing a worse UX path, breaking an invariant another function relies on) is a valid, real attack in a permissionless system and must be treated as such.
- This was found and fixed 2026-08-26: `RandomManager.revealRandomnessBatch` initially reverted its entire batch if any single id in it was already revealed. Since `revealRandomness` is deliberately permissionless (anyone can call it, by design — see `RandomManager.sol`), any outside address could front-run one id out of a victim's pending batch for the cost of gas alone, forcing that player back to one-at-a-time reveals with no benefit to the attacker beyond breaking someone else's transaction. The fix (tolerating an already-revealed id as a no-op instead of reverting) only happened after this was explicitly flagged — the first-pass design had reasoned "no outside actor has any reason to do this," which is exactly the assumption to never make.
- When adding or reviewing any function with no `onlyOwner`/allowlist gate, explicitly ask: "what is the worst thing a purely malicious, zero-profit-seeking caller could do to someone else by calling this, and does the design tolerate it?" — not just "what would a rational, profit-seeking attacker do?"

## Never Use `tx.origin`

Do **not** use `tx.origin` in any contract, for authentication, authorization, or identifying "the real caller/player." Use `msg.sender`; for hook-style callbacks where the immediate caller is a router or other intermediary (e.g. Uniswap v4 hooks), pass the real actor's address explicitly through call data instead of reaching for `tx.origin`.

- `tx.origin` is a well-known phishing-adjacent anti-pattern: a malicious contract can trick a user into a transaction that ends up calling your contract with the user's EOA still set as `tx.origin`, defeating any check based on it.
- It also silently misattributes actions for anyone interacting through a smart-contract wallet — this project already uses Dynamic for wallet auth, so that's a real case, not a hypothetical one. `tx.origin` resolves to the wallet's underlying signer, not the smart account actually holding funds or making the call.
- **Found 2026-09-11:** `UTCLotteryHook.sol`'s first draft used `tx.origin` to decide which player should get lottery-entry credit for a swap. Caught before it shipped — the correct fix was decoding the real trader's address from `hookData` (the mechanism Uniswap v4 hooks already provide for exactly this), not `sender` (the calling router, not the trader) or `tx.origin`.

## NEAR: Never Read `random_seed` in a User Receipt

Do **not** call `env::random_seed()` / `env::random_seed_array()` anywhere except the contract's own self-callback that resolves randomness (`resolve_randomness` in `near/contracts/void-tactics/src/randomness.rs`, which is `#[private]`). Code that needs randomness records a request and schedules that callback; it never reads the seed in the user's own receipt.

- A NEAR transaction can carry several FunctionCall actions to the same contract, executed in one receipt that reverts as a whole if any action fails. If the seed is read in the user's receipt, a player can batch `[mint/roll, call-that-panics-on-a-bad-outcome]` (e.g. `start_node_match` with a cost cap the bad roll would exceed) and retry until they get a roll they like, for the cost of gas.
- The self-callback runs as a separate receipt in a later block: the player can't predict its seed, can't include it in their batch, and its outcome can't be rolled back by anything they do.
- Anything that consumes the resolved value afterward (e.g. `construct_ship`) must be deterministic from the stored value, so retrying it can never re-roll.
- Decided 2026-11-13 while porting `RandomManager.sol`'s deferred-blockhash design to native NEAR; covered by `near/tests/tests/phase0_spikes.rs` (`batched_failing_action_reverts_the_request_entirely`, `resolve_randomness_rejects_external_callers`).

## Dating Cross-Agent Documents

Any document or set of instructions written for another agent to consume (e.g. a frontend-integration handoff doc, a migration guide) must include the date it was written, near the top. These documents describe contract state at a point in time and go stale as the contracts evolve — a reader needs the date to judge whether the content is still current.

## Marking Completed Items in Documents

When an item in a document becomes done (a checklist entry, a prioritized item in a doc like `docs/pre-audit.md`, `docs/internal-todos.md`, or a design-analysis doc), mark it complete with markdown strikethrough (`~~text~~`) rather than deleting it or rewriting it into new prose. Keep the original text intact under the strikethrough — add a brief note after it (date/what happened) if useful, but don't lose the original wording. This keeps a scannable record of what was flagged and keeps completed vs. outstanding items visually distinguishable at a glance.

## Rules Sync

Rules are maintained in two places — keep them in sync:

- **Claude Code**: `CLAUDE.md` (this file)
- **Cursor**: `.cursor/rules/*.mdc`

When adding, changing, or removing a rule in one tool, apply the equivalent change in the other. Each Cursor rule maps to a section in `CLAUDE.md` with the same intent.

# Void Tactics — Open Security/Audit Items (Pass HA7)

_Written 2026-10-31. Live tracker, replacing `docs/audit-3.md` as the place for new findings and status changes. `audit-3.md` stays as written; its still-open items are listed under **Carried forward** below and are not duplicated here._

**Scope:** every non-mock contract in `contracts/` at `653a918` ("Massive efficiency pass"), plus the uncommitted orphan-removal diff (Ships, DroneYard, Lobbies, SinglePlayerMatch, ShipPurchaser, GameBlobRegistry, `CadenceArchCaller` deleted, `DeployAndConfig.ts`). Extra attention went to code that is new since HA6: packed `ShipBoardState`, the occupancy and live bitmaps, Ships-free moves (cached side/variant/special), `getAIBoard` and AIBehavior's decoding, AI fleets skipping Fleets' checks, `transferFleet`/`reserveFleet`, RoguelikeRun's packed roster, Maps' packed scoring list and the AIShips free list. `Renderers/` and `RenderersV2/` got a light pass only.

**Method:** five parallel read-only subsystem reviews: core engine, orchestrators/modes/fleets, economy/tokens, ships/NFTs/drones and AI. Every finding was re-checked against the code before it went in this doc, and checked against `pre-audit.md`, `audit-2.md` and `audit-3.md` so fixed or accepted items aren't raised again. **Confirmed** = traced end to end in the code. **Plausible** = the code facts are confirmed but the exploit precondition isn't fully proven. Every fix is pending, to be taken one finding at a time. Baseline: `npx hardhat test`, 938 passing, 0 failing (`PRODUCTION = false`), including the uncommitted diff.

**When an item gets fixed:** strike it through (`~~text~~`) and add a short "Fixed <date>" note. Don't delete it.

| Severity | Count |
|---|---|
| High | 0 |
| Medium | 3 (2 fixed, 1 open) |
| Low | 10 (8 fixed, 2 accepted) |
| Info | see list |

**Areas the reviews found clean:**
- **inFleet lock:** every path that can change a fleet ship's owner, traits, cost or existence is blocked. Game's cached side, variant and special hold for every orchestrator.
- **Board state:** every bit offset `getAIBoard`/AIBehavior decode matches `ShipBoardState`. The bitmaps stay consistent on every path the shipped resolvers can reach. The running-total round accounting can't underflow or double-count.
- **Fleets:** `transferFleet`, `reserveFleet` and the AI-fleet branch can't be steered into locking or unlocking someone else's ships.
- **Roguelike win callback:** no third party can make it revert.
- **Lottery:** the HA5-02, HA6-05, HA6-06 and HA6-07 fixes hold.
- **Mint authority:** every UTC/DEC mint path is bounded.
- **`tx.origin`:** no uses.

### Contract size headroom (runtime, 24 KiB = 24.000 limit), measured 2026-10-31

| Contract | Runtime KiB | Headroom |
|---|---|---|
| RenderArmor3 | 23.932 | ~70 bytes |
| Game | 23.864 | **~139 bytes** |
| Ships | 22.825 | ~1.2 KiB |
| RoguelikeMatch | 21.867 | ~2.2 KiB |
| Maps | 17.506 | ~6.6 KiB |
| Tournament / ShipAttributes | 16.534 / 16.084 | ~7.5 / ~8 KiB |
| Variant2AI / Variant1AI | 15.577 / 14.878 | ~8.5 / ~9 KiB |
| Lobbies / SinglePlayerMatch | 15.385 / 13.029 | ~8.6 / ~11 KiB |
| UTCLotteryHook / Fleets | 12.064 / 10.719 | ample |

Any fix that touches Game.sol has to be byte-neutral or byte-negative, or live in `SpecialEffectsLib`/an orchestrator. Several fixes below are chosen with that in mind.

---

## Medium

### ~~HA7-01 — DEC Is Meant to Be a Whole-Number Token, but It Has 18 Decimals and AI Kills Mint UTC's 18-Decimal Amount: One Kill Maxes the Whole DroneStorefront Ladder~~

**Status: Fixed 2026-10-31.** `DroneEnergyCores.decimals()` returns 0. AI kills pay the new `ShipsRouter.factionKillReward` (default 1 core, owner-settable) through a separate `DestroyRewardLib` amount instead of UTC's `recycleReward >> 2`. Tier costs and the win bonus are unchanged (already whole cores; tier 1 = 10 kills). Tests: `test/ShipsRouter.test.ts` "pays factionKillReward whole tokens per AI kill…", plus updated DEC expectations in ShipsRouter, RoguelikeMatch and SinglePlayerMatch tests. The frontend's divide-by-1e18 is in `frontend-handoff-2026-10-30.md` §10.

**Confidence: Confirmed.** Intent (owner, 2026-10-31): Drone Energy Cores are indivisible, i.e. a 0-decimal token.

**Already correct for that intent:**
- the tier costs `[10, 20, 30, 55, 95, 170, 300, 525, 925, 1625]` (`DeployAndConfig.ts:2251`);
- the `DECBonusWinEffect` bonus of 20 (`DeployAndConfig.ts:626`);
- the tests (`test/Ships.test.ts`'s "tier 1 (10 DEC)" mints `10n`).

**Using the 18-decimal scale instead:**
- `DroneEnergyCores.sol` doesn't override `decimals()`, so it inherits OpenZeppelin's 18.
- The kill reward reuses UTC's amount. `ShipsRouter.sol:154` passes `ships.recycleReward() >> 2` (0.025e18, sized for 18-decimal UTC) to `DestroyRewardLib.payDestroyReward`, which mints that same number in the victim's reward token (`DestroyRewardLib.sol:76`). For DEC that's 2.5e16 whole cores per AI kill.
- The frontend (`DroneStorefront.tsx:51-54`) runs DEC costs and balances through `formatEther` (÷1e18) before `formatDec`. The 10-core tier shows as "1 DEC", and balances show as 25 quadrillion.

**Failure scenario:**
- A player's first AI kill pays for every tier (3,755 cores in total), so every later `claimFreeShips` gives the maximum bonus permanently.
- DEC is transferable on purpose, so the rest of that one kill's cores can max out an effectively unlimited number of other wallets. Combined with the known Sybil-able free claim while `eligibilityProvider` is unset, every Sybil wallet gets the maximum bonus for the cost of one kill.

**Fix:**
- Add `decimals()` returning 0 to `DroneEnergyCores`.
- Give DEC its own per-kill amount in whole cores (a ShipsRouter setting, or a separate parameter to `DestroyRewardLib` for the AI-owned branch) instead of reusing UTC's amount. The deploy comment wants tier 1 "in a handful of AI kills": at 1 core per kill that's 10 kills.
- Drop `formatEther` from the frontend's DEC displays.
- `addTier` and the bonus stay as they are.

### ~~HA7-02 — Lowering a Variant's Max Hull Points Bricks Every In-Progress Roguelike Run's Next Combat Node~~

**Status: Fixed 2026-11-01.** `RoguelikeMatch.enterCombatNode` now seeds a stored HP only when it's below the ship's max for the new game. A stored value at or above that max is left at full, so Game's override check can't revert. Game.sol is unchanged. Test: `test/RoguelikeMatch.test.ts` "still enters the next node after an attributes update lowers a stored survivor's max HP", which fails with `InvalidMove()` without the fix.

**Confidence: Confirmed** (the precondition is an owner action). Same class as HA6-09.

**Files:**
- `Game.sol` `setInitialHullPointsOverride`: `if (_hullPoints == 0 || _hullPoints > attributes.maxHullPoints) revert InvalidMove();`
- `RoguelikeMatch.sol:329-334` seeds every non-zero stored HP through it.
- `RoguelikeMatch._healedHP` stores the full max (non-zero) for a survivor at full HP. `RoguelikeResupply.resupplyRepair` and `HealAboveFloorWinEffect` also store the max that was current at the time.

**Failure scenario:**
1. A run wins a node, and its survivors are stored at the old max (say 100).
2. The owner publishes a ShipAttributes version, or rolls back with `setCurrentAttributesVersion`, so the variant's max becomes 90.
3. `enterCombatNode` → `startGame` computes 90 → the override with 100 reverts. The whole `enterCombatNode` reverts on every try.
4. The only exits are a Resupply child, where repair rewrites HP to the new max, or `retreatRun`, which loses the run.

**Fix:** clamp instead of reverting. Either do it in RoguelikeMatch before the call (`min(stored, current max)`, read from `game.getShipAttributes`), or in Game, where the clamp is roughly byte-neutral. Storing 0 (= full) for a survivor at full HP would also shrink the problem, but that alone doesn't fix it.

---

### HA7-13 — The New UTC Mint Price Lets Anyone Drain the Lottery Pool's ETH When the New ShipPurchaser Goes Live

**Status: Open, added 2026-11-12. To be addressed at the `ShipPurchaser` redeploy.** `scripts/deployUTCLotteryPool.ts` was fixed the same day to price from `tierPrices`, so a re-run seeds at the new rate. The pool already on chain still has the old price.

**Confidence: Confirmed** (code and live reads; not exploited).

**Files:**
- `ShipPurchaser.sol` `purchaseUTCWithFlow`: since 2026-11-12 it mints `tierPrices[tier]` UTC (about $1 per UTC) instead of `tierShips[tier] * recycleReward` (about $10 per UTC). The deployed contract still runs the old code.
- `UTCLotteryHook.sol`: the hook binds to one pool (`poolLocked`). Its header relies on the mint price acting as the pool's price ceiling.
- `scripts/deployUTCLotteryPool.ts`: set the pool's starting price from the old mint, about 0.0044 ETH per UTC on Base Sepolia.

**Failure scenario:**
- The live UTC/ETH pool (hook `0x72D0930d6456489F5A2f648924ED6689EF262040` on Base Sepolia) is priced at the old ceiling, about $10 per UTC.
- Once a `ShipPurchaser` with the new mint is live, anyone mints UTC at about $1 and sells it into the pool. That continues until the pool's price falls to about $1, so the protocol-seeded liquidity loses up to its whole ETH side to whoever acts first. The sells also earn lottery entries.
- No privilege is needed; it's mint then swap. On Base Sepolia the pool holds about 1 UTC, so the loss there is negligible. Production would lose whatever was seeded.

**Fix (at the redeploy, in this order):**
1. Remove the protocol's liquidity from the pool.
2. Move the pool's price to the new ceiling. That's cheap once the pool is empty.
3. Re-seed liquidity at the new price. Use the same pool, because the hook can't bind to another one.
4. Only then let the new `ShipPurchaser` mint UTC.

Any later change to `tierPrices`/`flowTierPrices` that lowers the mint price moves the ceiling the same way, so repricing needs the same pull, reprice and re-seed.

## Low

### ~~HA7-03 — Electric Storm Mutual Destruction Hands the Joiner the Win, and the Joiner's Doomed Ship Survives (HA6-26 Variant)~~

**Status: Fixed 2026-11-01.** `Game._dispatchEffects` now checks game end once, after every removal and relocation from the ability (`_removeShipFromGame` takes a `_checkEnd` flag). A mutual wipe-out ends by score, and every doomed ship is destroyed. Game +13 bytes (23.877 KiB). Test: `test/Game.test.ts` "ends a mutual wipe-out from one ability by score… (HA7-03)", using the new test-only `contracts/mocks/MockEffectsResolver.sol`.

**Confidence: Confirmed.**

**Files:**
- `SpecialEffectsLib._applyEffect`: `if (newTimer >= 3) return (true, 2);`, and the `removalKind` early return. Both return a removal without clearing the ship's `live` bit.
- `ElectricStormResolver._inRange`: excludes neither the caster nor allies.
- `Game._dispatchEffects` (~1372-1382): removes ships in order and breaks once the game has ended.
- `_removeShipFromGame` → `_checkGameEndCondition` after each removal.

**Failure scenario:**
- Reactor deltas apply to ships with HP > 0, so a live ship can reach timer 3. Suppose the creator's last live ship C and the joiner's last live ship J are both at timer 2, and a Storm covers both. Removals run creator-first.
- Removing C clears `live[0]`. `live[1]` still holds J's bit, so the joiner wins.
- The loop breaks, so J is never removed or marked destroyed.
- HA6-26's rule (both sides wiped → decided by score) is bypassed. A creator who wipes both sides always loses, and a joiner who is behind on score turns a loss into a win.

**Fix:** in `_applyEffect`, call `_setLive(game, attrs, false)` before returning any removal (library only, 0 Game bytes). The first removal's check then sees both sides empty and ends by score. Making J's destruction itself happen needs the end check deferred until after the removal loop, which costs Game bytes.

### ~~HA7-04 — Friendly Fire Rewrites `lastDamager`: Players Can Take the Kill Credit (Rank + UTC) for Their Own Doomed Ships, Including in PvE~~

**Status: Fixed 2026-11-01.** `SpecialEffectsLib._creditDamager` records the acting ship only when it's on the other side (both the damage and reactor-delta paths). `ShipsRouter.setTimestampDestroyed` returns before any kill credit or reward when the destroyer id is 0. Tests: `test/Game.test.ts` "credits a kill only to an enemy's damage… (HA7-04)" and `test/ShipsRouter.test.ts` "pays nothing and credits no kill when a ship has no destroyer (HA7-04)".

**Confidence: Confirmed.**

**Files:**
- `SpecialEffectsLib._applyHullDelta`: `attrs.lastDamager = uint48(_actingShipId);` whenever damage reaches 0 HP.
- `_applyEffect`: the same write on every reactor delta.
- Flak and Storm hit allies.
- `ShipsRouter.setTimestampDestroyed:135-158` records the kill and pays UTC when neither ship is AI.

**Failure scenario:**
- **PvP:** the opponent disables my ship X. I hit X with my own Flak or Storm before its reactor removes it. The rank kill and `recycleReward/4` UTC go to me instead of the opponent.
- **PvE:** I destroy my own non-free ships with friendly fire. Neither id is AI, so `recordKill` runs and the destroyer gets a permanent rank kill. That gets around HA6-16's intent (no rank from PvE).
- **Ram:** a rammer destroyed by its own 3rd ram credits itself.

**Fix:** in the library, set `lastDamager` only when the acting ship is on the other side (`game.shipBoard[_actingShipId].isCreator != attrs.isCreator`). Library only, 0 Game bytes. Optionally, ShipsRouter can also skip the kill and reward when destroyer == destroyed.

### HA7-05 — AI Surrender Ignores Mutual Disable (the HA6-26 Mirror, Noted in audit-3 but Never Fixed)

**Status: Accepted 2026-11-01 (owner decision).** Left as is.

**Confidence: Plausible** (the code path is traced; reaching a mutual disable on the AI's turn wasn't tested).

**Files:** `RoguelikeMatch.sol:802`, `SinglePlayerMatch.sol:438`: `if (!hasLiveShip) { game.forceEndSession(_gameId, creator, address(this)); ... }`. `hasLiveShip` reads only the joiner's live word.

**Failure scenario:**
1. A friendly-fire Flak or Storm leaves both sides with only 0-HP ships, none removed yet.
2. The next turn is the AI's, and anyone calls `takeAITurn`.
3. The human is handed the win (node completion, win effects) even when the AI is ahead on score.

**Fix:** when `!hasLiveShip`, also check `board[1]` (creator live). If both are empty, end by score or as a draw instead of a creator win. The scores aren't in the board header, so this needs a scores read or two more header words.

### ~~HA7-06 — AI Heal/Ram Moves Don't Check the Landing Tile Is in Range; a Human Can Bait Support and Rammer Ships Into Passing Every Turn~~

**Status: Fixed 2026-11-01.** New `AIBehavior.reachWithin(ctx, target, range)` returns a reachable tile within range (staying put, the direct approach, then every tile within range of the target), or found = false. `healWithReach` and `Variant1AI._rammer` use it, and fall through to fighting when nothing is in reach. Tests: `test/VariantAITrees.test.ts`, the two "(HA7-06)" bait scenarios.

**Confidence: Confirmed** (by trace).

**Files:**
- `AIBehavior.healWithReach` → `_withinRangeOf` → `_stepTowardReachable` / `_backoffToward` (~505-518, 1100-1139).
- `Variant1AI._rammer` (~166-200).

**Failure scenario:**
- The backoff returns the first reachable tile at decreasing step counts. That tile, or the current position, can be out of heal or ram range.
- The decision still emits Special/FactionAbility, the resolver reverts `OutOfRange`, and `_takeShipTurn` falls back to Pass. The fallback skips `AIDecisionFailed` because `decided` was true.
- A human who parks a ship on the one tile that would bring the target into range neutralises that AI ship every turn. It never falls through to shooting.

**Fix:** use `_standTile(ctx, target, range)`, as Variant2's `healDisabledWithReach`/`ramOnScoringTile` already do. Or check `_manhattan(dest, target) <= range` and return not-found so the tree falls through.

### ~~HA7-07 — A Fled Ship That Doesn't Rejoin Comes Back at Its Pre-Fight HP (Free Repair)~~

**Status: Fixed 2026-11-01.** `RoguelikeMatch._stashFledHP` runs after `setRosterAndHP` on a win. A fled (status 2) ship that isn't rejoining has its HP stored at the heal floor from 0. The lookup is in a try block, so it never reverts the winning move. RoguelikeMatch 22.599 KiB. Test: `test/RoguelikeMatch.test.ts` "stores a fled ship that doesn't rejoin at the heal floor… (HA7-07)".

**Confidence: Confirmed.** This predates the packed roster.

**Files:**
- `RoguelikeMatch._postWinRoster` skips a fled ship that fails `_canRejoin`.
- `RoguelikeRun._setRoster` stashes that ship's old roster HP, which is its pre-fight value.
- `RoguelikeResupply.resupplyModifyRoster` → `setRoster` restores it.

**Failure scenario:**
1. Ship X is badly damaged and retreats, which unlocks it.
2. The player moves X to an alt, so `_canRejoin` fails, then wins the fight.
3. The player moves X back and re-adds it at a Resupply node. X returns at full or pre-fight HP, not the heal floor, and skips `repairCostPerHP`.

**Fix:** in `_postWinRoster`, for fled ships that don't rejoin, store the floor HP (`runLedger.setShipHP(player, id, _healedHP(gameId, 0, max))` writes the stash because the ship isn't in the roster). About 150 bytes in RoguelikeMatch.

### ~~HA7-08 — Third-Party `syncShipCosts` Can Drop Every Rejoining Ship From a Winner's Roster (L-03 Variant)~~

**Status: Fixed 2026-11-01.** `Ships.syncShipCosts` accepts only ids the caller owns or is approved for (OpenZeppelin `_isAuthorized`), and reverts `NotYourShip(id)` otherwise, including for unminted ids. That also closes audit-2 L-03. Ships 22.876 KiB. Test: `test/ShipCostsVersions.test.ts` "syncShipCosts updates multiple ships for their owner or an approved address, and no one else".

**Confidence: Confirmed** (code path; the trigger needs a costs-version bump since run start and a run near its cost cap).

**Files:**
- `Ships.syncShipCosts` (`Ships.sol:~395-410`) can be called by anyone on any ship that isn't in a fleet. A fled ship stays unlocked for the rest of the match.
- `Fleets.reserveFleet` prices rejoiners at their current stored cost.
- `RoguelikeMatch.onGameEnded`'s catch truncates to `survivorCount`, dropping all rejoiners.

**Failure scenario:** an attacker calls `syncShipCosts([fledShipId])` mid-match. The first `reserveFleet` then reverts `InvalidFleetCost`, and every fled ship is dropped from the run.

**Fix:** close L-03 (restrict `syncShipCosts` to the ship's owner or approved addresses). Or retry dropping only the failing rejoiner, which is more bytes.

### ~~HA7-09 — Lottery Retarget Gives Losers a Free Re-Roll When the Winner Doesn't Resolve~~

**Status: Fixed 2026-11-01.** The first swap after the close block stores the close hash in the new `drawSeed(drawId)`. That happens before the auto-resolve gas gate, so a cheap swap still stores it. `resolveDraw` uses the stored seed, so a draw with a seed can't expire or re-roll. A retarget now needs no swap and no `resolveDraw` for the whole window. UTCLotteryHook 12.148 KiB. Test: `test/UTCLotteryHookSwap.test.ts` "a cheap swap after close stores the seed, so the draw can't be re-rolled past the window (HA7-09)".

**Confidence: Plausible** (needs no keeper, and the winner idle for the whole window).

**Files:** `UTCLotteryHook._maybeAutoResolve` (~440-450): it retargets once the close hash is unreadable, and only auto-resolves when `gasleft() >= autoResolveMinGas`.

**Failure scenario:**
- Wallet gas estimates usually land on the cheaper branch where resolution is skipped, so in practice only a manual `resolveDraw` resolves a draw.
- Once the close block is sealed, every participant can compute the winner. If the winner doesn't act within the hash window (about 4.5 hours on Base), the next swap retargets and every loser gets a fresh roll.
- The comment at ~452-458 calls this impractical because it relies on ordinary swaps auto-resolving.

**Fix:** capture `BlockHashLib.get(closeBlock)` into storage as soon as `block.number > closeBlock`, before the gas gate (~22k gas, always included in estimates). `resolveDraw` then uses the stored seed, so the draw never expires.

### ~~HA7-10 — RandomManager: Preview, Let the Request Expire, Then Ask Support to Retarget = Re-Roll (HA6-19 Variant)~~

**Status: Fixed 2026-11-01.** Implemented as planned. Every RandomManager call (and each lottery swap) stores pending block hashes in `blockSeed`, so a stored roll never expires. `retargetExpired` and `Ownable` are removed, so nobody can re-roll. A request nothing captured in time builds `GenerateNewShip.generateBaselineShip`, which is never better than a real roll. Ships 23.144 KiB. Tests: `test/RandomManager.test.ts` "capture instead of re-roll (HA7-10)", `test/Ships.test.ts` "builds a baseline ship… (HA7-10)", `test/UTCLotteryHookSwap.test.ts` "ship randomness capture on swaps (HA7-10)". This also closes the owner re-roll lever left from HA6-19. Design: `docs/trustless-randomness-plan-2026-11-01.md`. It needs no privileged backend, so the backend-reveal fix below is superseded.

**Confidence: Plausible** (depends on support policy).

**Files:** `RandomManager.sol:104-126`: the result is `keccak(blockhash(mintBlock), id)`, public one block after mint, and `retargetExpired` re-rolls any expired, unrevealed request.

**Failure scenario:** the owner of a high-value roll computes it. If it's bad, they don't reveal or construct, wait for expiry, and ask support to retarget. Support can't tell a deliberate expiry from an accidental one.

**Fix (no contract change):** run a backend job that `revealRandomnessBatch`es every new request within the window. It's permissionless, and the batch tolerates ids that are already revealed. Or only retarget requests nobody could have previewed in time.

### HA7-11 — Gas-Starving the AI's `decide` Forces a Pass (Latent)

**Status: Accepted 2026-11-01 (owner decision): documented, left as is.** When it becomes reachable (estimates; the Pass path hasn't been measured on its own):
- **Condition:** the EVM keeps 1/64 of the gas back from each call, and the Pass fallback (`AIDecisionFailed`, `moveShip(Pass)`, which itself gets only 63/64 of what's left, then `AITurnTaken`) has to fit in that leftover. So the starved step has to cost more than about **64× the Pass path**.
- **Pass path:** an estimated 60–100k for a plain Pass. A Pass that ends the round costs more, which makes the attack harder.
- **Threshold:** `decide` has to cost more than about **4–6.5M gas**. Above the ~16.7M per-transaction cap (2²⁴, EIP-7825), honest calls fail too, which is a different problem.
- **Today:** the worst whole AI turn is ~0.5M (GasBudget, 15 v 14), so `decide` would need to grow 10–15×. At maximum fleet size (44 v 44, ~3× today's ship count), that only happens if `decide` scales much faster than linearly with ship count. Not measured.
- **Same threshold, second route:** let `decide` finish and starve the AI's real `moveShip`, so it falls back to Pass. The real move would have to cost ~64× a Pass (~4–6M). The worst measured AI move is ~1.01M (the game-ending turn).
- **Already possible, harmless:** a gas range where `decide` and both `moveShip` attempts run out, but the transaction still succeeds with no AI action. The turn stays with the AI, so nobody gains. It can mislead gas estimation, so the frontend should confirm `AITurnTaken`.
- **Revisit if:** fleet caps rise, the AI's search gets wider, or GasBudget shows `decide` above ~2M. Measuring an AI Pass alone and `decide` at 44 v 44 would replace these estimates.

**Confidence: Plausible, not reachable at measured sizes.**

**Files:** `RoguelikeMatch.sol:891-897` and `SinglePlayerMatch.sol` (same pattern): `try info.ai.decide(...) {...} catch {}` → Pass. The fallback `moveShip` paths in `_takeShipTurn` follow the same pattern. `takeAITurn` is permissionless.

**Failure scenario:**
- A caller tunes the gas so `decide` runs out of gas and the 1/64 kept back pays for the Pass, every AI turn.
- That needs `decide` to cost more than ~63 times the Pass path (several million gas).
- The measured worst AI turn is ~0.5M (GasBudget, 15 v 14), so this can't be reached today. It becomes reachable if decide cost grows (it scales with enemy count).
- A related side effect today: because success isn't monotonic in gas, a gas estimate can land in a no-op region, where the transaction succeeds without the AI acting.

**Fix:** in each catch, `if (gasleft() < MIN_FALLBACK_GAS) revert();`, or give `decide` a fixed gas stipend and revert when the caller supplied less. About 50-100 bytes per orchestrator. The frontend should confirm an `AITurnTaken` event after `takeAITurn`.

### ~~HA7-12 — `scripts/redeployVariant1Renderers.ts` Would Make Every Live `tokenURI` Revert, and Its Smoke Test Still Passes~~

**Status: Fixed 2026-11-01.** Before anything else, the script now checks that the live Ships, the whole variant 2 tree and both trees' explosion/unconstructed parts match the compiled code, with immutables and library links masked. If anything doesn't match, it stops and says to run only after the full redeploy. The synthetic two-colour sample is gone. It now renders real ships (one constructed ship per variant, one destroyed, one unconstructed) through the new RenderMetadata before `setConfig`, then through `Ships.tokenURI` after it. Tests: `test/RedeployVariant1Renderers.test.ts` (refuses on a stale Ships; refuses on a stale variant 2 leaf or explosion part; an end-to-end apply on the local chain), with both refusal tests mutation-checked.

**Confidence: Confirmed** (code; not run on chain).

**Files:** the script reuses the live `imageRendererV2` and leaf renderers (~60-81) and points the live Ships at a RenderMetadata built from current sources. Its smoke test (~330) calls `RenderMetadata.tokenURI(sample)` directly.

**Failure scenario:**
- `653a918` removed `h3/s3/l3`, which changes every renderer selector that takes `Ship` (`IRenderer.render/tokenURI/renderShip`).
- Run against the live (three-colour) Ships, every `Ships.tokenURI` reverts. Even with a matching Ships, the reused V2, explosion and unconstructed leaves would revert.
- The smoke test uses a two-colour sample, so it passes.

**Fix:**
- Only run the script after the full redeploy, guarded by a check that the live Ships and reused renderers' code matches the compiled artifacts.
- Smoke-test through `Ships.tokenURI(existingId)`, for one ship of each variant and one destroyed ship.

---

## Info

- **`SpecialEffectsLib` trusts resolver output in ways that would break invariants.** The shipped resolvers can't trigger these, and resolvers lock once the engine is live, but the fixes are free in the library:
  - A relocation onto the ship's own cell runs `live[side] ^= oldBit | newBit` and clears the live bit. Use `oldBit ^ newBit`.
  - A damage effect on a ship that's already gone (`status != 0`) adds a `shipsWithZeroHP` entry that's never removed, which ends later rounds early.
  - Relocating a gone ship sets a phantom `occupied` bit.
  - `resolveAndApply`'s target check rejects only `status == 1`, so a fled ship (status 2) passes.
  - Fix: skip or revert effects on ships with `activeIndex == 0`, and check `status != 0`.
- **Reactor removals at round start have no gas bound.** The player whose move ends the round pays for every timer-3 removal: Fleets scan, `markDestroyed`, `recordKill`, reward mint, an estimated 150-200k each. A player can synchronise many 0-HP ships with friendly fire to grief the opponent's round-ending move. It only nears the per-tx cap with near-full 44-ship fleets on both sides. Measure, then cap removals per tick or cap fleet size.
- **`Ships.setInFleet` still authorizes `config.lobbyAddress`** (`Ships.sol:416-423`), wired to SinglePlayerMatch. Nothing needs it, and it lets that contract lock or unlock any human ship directly, bypassing ShipsRouter's gate. Dropping the clause (and ideally the field) removes Ships bytes.
- **`AIShips.releaseShips` doesn't bound `localId` to `1..slotCount`.** AI fleets now skip Fleets' inFleet check, so a buggy orchestrator releasing a never-allocated id could later lead to one AI ship being shared by two games. That isn't reachable through current callers. Add `if (localId == 0 || localId > slotCount) continue;`.
- **A fled ship keeps kill credit after it's unlocked.** If ship A zeroes B and then retreats, the reactor kill later credits A and pays A's owner at that moment, even if A is now in another game or burned. This predates the efficiency pass. Optionally skip the credit when the destroyer's board status isn't 0.
- ~~**Fleet records are internally inconsistent after a removal or after being emptied.** `removeShipFromFleet` swap-and-pops `shipIds` but not `startingPositions`. `clearFleet`, `transferFleet` and `reserveFleet` delete only `shipIds`. `getFleet` and `getFleetShipIdsAndPositions` can return misaligned arrays and a stale `totalCost`. This predates the packing.~~ **Fixed 2026-11-01.**
  - `removeShipFromFleet` now swap-and-pops `startingPositions` in step with `shipIds`.
  - The three emptying paths share `_emptyFleet`, which deletes both arrays and zeroes `totalCost`.
  - No contract read the stale data. Game reads positions only at start, from a fresh fleet, and every `totalCost` that was read was exact. So the exposure was off-chain readers and future code.
  - Fleets 10.977 KiB.
  - Tests: `test/Fleets.test.ts` "keeps positions aligned with ship ids after a removal…" and "leaves the old fleet and a cleared fleet with no positions and no cost". Both fail on the old code.
- **A score-decided win with no surviving or rejoining ships leaves an Active run with an empty roster.** Only a Resupply child or `retreatRun` gets the player out.
- **Variant AI contracts' dependency setters stay mutable mid-match.** These are `setShipAttributesAddress`, `setRamAbilityAddress` and `setHealAbilityAddress`. It's an owner-only residual of HA6-18. Make them immutable or lock them once used.
- **AIBehavior decodes `ShipBoardState` by fixed bit offsets.** Every offset matches today. Keep `test/helpers/aiView.ts`'s cross-check, and add cases for a 0-HP joiner ship, a ship that already moved, and round > 1. Any added or reordered field breaks the AI silently.
- **Game assumes every ship starts with HP > 0.** `_placeShipOnGrid` sets the live bit unconditionally. A 0-hull config (admin-only) gives a live wreck that can't move, which stalls the round.
- **`lastMove.targetShipId` is stored as `uint64(targetShipId)` without a check** (`Game.sol:~820`). It's unvalidated for Pass/Retreat. Cosmetic; it affects only the caller's own move.
- **`UTCLotteryHook._extractPlayer`** decodes 32-byte `hookData` with `abi.decode(..., (address))`, which reverts the trader's own swap when the upper bytes are dirty. Decode as `uint256` and treat `w >> 160 != 0` as invalid.
- **`minEntryThresholdWei = 0`** lets zero-proceeds sellers pad `minParticipants`. It's an owner config footgun; require a value above 0.
- **Stale after HA6-21:**
  - The `DeployAndConfig.ts` comment (~2149-2152) explaining ShipsRouter's UTC mint right.
  - `SinglePlayerMatch.withdrawUTC` and `universalCredits`, since UTC no longer accrues there.
- **`Ships.tokenURI`** renders burned ids (ERC-721 says nonexistent tokens revert). `constructShip` on a burned, unconstructed ship writes to the dead struct. Both are cosmetic.
- ~~**Stale `Ships.sol` comment naming `DroneYard.validateShip`**~~ _(Fixed 2026-10-31 during this audit: it now names `_validateShip`. The removal diff had made it stale.)_

---

## Carried Forward (Still Open)

From `audit-3.md` (Info list; full write-ups there):
- `RenderMetadata.tokenURI` doesn't escape names.
- Shiny is correlated with the special roll.
- `DroneStorefront.droneCoreTier` is `uint8`.
- AI slot reuse rewrites history.
- AI `_takeShipTurn`'s catch swallows all reverts (see also HA7-06 and HA7-11).
- `Game.setInitialHullPointsOverride` doesn't sync `shipsWithZeroHP` (see also HA7-02).
- The root Resupply node's `costCapOverride` can be skipped.
- Tournament World ID linkability.
- `Create2Deployer.deploy` squatting.
- `UniversalCredits.withdrawAll` is dead.
- `TutorialClaim` is Sybil-able while `eligibilityProvider` is unset.

From `audit-2.md` (via `audit-3.md`):
- **H-08:** `Ships.purchaseWithFlow` referral transfer before state finality.
- **HA5-01:** Tournament walkover.
- **HA5-03:** `_calculateMovement` casts.
- **HA5-04:** void external calls without code-length checks.
- **M-04:** `ShipAttributes` version arrays out of bounds.
- ~~**L-03:** `Ships.syncShipCosts` is permissionless (see HA7-08).~~ _(Fixed 2026-11-01 with HA7-08.)_
- **I-02:** owner centralisation (HA7-02 and the AI dependency setters are concrete instances).
- **I-08:** `Ships._update` writes state before `super._update`.
- Admin/backend key separation for the production deploy.

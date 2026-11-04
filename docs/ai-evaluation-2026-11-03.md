# AI Re-evaluation: Live Game Data and Decision Trees

_Written 2026-11-03. Covers `contracts/AIBehavior.sol`, `contracts/Variant1AI.sol` and `contracts/Variant2AI.sol` as they stand in the working tree, including the two uncommitted fixes from 2026-11-03 (wall sidestep, ally-held tile). The data is every AI game on Base Sepolia from 2026-10-08 to 2026-11-03._

---

## 1. Summary

The AI loses on points, not in fights. Of the 23 games with AI turns, the player won 17 outright and led on score in 4 more (three recorded as AI wins, which look like timeouts, and one unfinished). The other 2 never got going. Nearly every win came from holding scoring tiles from the first round. Players end 25% of their turns on a scoring tile; the AI ends 6%. Both sides shoot on about half their turns.

The biggest improvements, in order:

1. **Make every archetype objective-aware** (§4.1). Variant 1 has no objective step at all, and both variants' tile choice sends short-range ships to the far side of the board.
2. **Move to get line of sight** (§4.2). 16 AI turns passed with an enemy in gun range but terrain blocking the shot.
3. **Shoot before a routine repair** (§4.3). Variant 2 ships used Repair on 10 turns while live enemies were in range with clear terrain line of sight.
4. **Threat-aware positioning** (§4.4). Variant 1's "stand at my maximum range" puts most of its ships inside the player's range, because player ships out-range them.

New archetypes help less than these shared fixes. Two are worth adding afterwards: an **Objective Runner** and a **Hunter** (§5).

## 2. Data

| | |
|---|---|
| Deployments scanned | 7 (the on-disk deployment plus commits `903db57`, `95346c9`, `e736b60`, `cb95773`, `9b526be`, `6596cbd`) |
| Deployments with AI games | 4: on-disk (7 games), `95346c9` (4), `e736b60` (5), `6596cbd` (7) |
| Games | 23, all roguelike. No single-player node matches were played in this window. |
| AI turns / all moves | 277 / 673 |
| Players | 5 wallets. One wallet played 13 of the 23 games. |

Sources: `Game.Move` events (every move from both sides, with old and new positions), `AITurnTaken` and `AIDecisionFailed`, plus state reads at each game's blocks: each AI ship's archetype, loadout and stats, each map's tiles, and each game's final state.

**Caveats:**
- The sample is small, and it's mostly one player.
- The older deployments ran older AI code. They lack the HA7-06 fixes and both 2026-11-03 fixes.
- Hit points per turn aren't in any event, so target choice can't be scored directly.
- Line of sight below is terrain only. It ignores ships standing in the line.
- The committed `deployed_addresses.json` (`903db57`) is older than the one on disk. Game `0xCAb7…` and RoguelikeMatch `0x7356…` are only in the uncommitted file, and all current play is there.

## 3. What the data shows

### 3.1 Games are decided on points

| Game | Result | Rounds | Score (player–AI) | Ships lost (AI / player) |
|---|---|---|---|---|
| 95346c9:556 | player | 6 | 96–0 | 1 / 0 |
| disk:556 | player | 6 | 80–0 | 0 / 3 |
| e736b60:556 | player | 7 | 56–16 | 5 / 0 |
| disk:558 | player | 3 | 54–18 | 0 / 1 |
| disk:554 | player | 3 | 42–7 | 0 / 0 |
| 95346c9:555 | player | 2 | 36–0 | 0 / 0 |
| disk:557 (no tiles) | player | 7 | 0–0 | 5 / 0 |
| disk:559 (one tile) | player | 6 | 1–2 | 7 / 0 |

These are the games with the most points or kills. The other 15 follow the same pattern.
- **Kills:** only the two games without a real scoring race (disk:557, disk:559) were won on kills.
- **"AI" results in `6596cbd`:** three games list the AI as winner while the player led on score. Those look like timeouts or abandoned games, not AI wins.

### 3.2 The AI doesn't hold scoring tiles

| | Turns ending on a scoring tile | Shooting turns | Stand-still turns |
|---|---|---|---|
| Players | 25% | 48% | 9% |
| AI | 6% | 50% | 9% |

- **Map layout:** most campaign maps put two of three tiles on the player's half, at (1,4) and (5,8), and the player moves first. Players are on a tile by their first or second move in 14 of the 23 games.
- **The AI's own tile:** the tile on the AI's side, (9,12), often goes untaken. In 95346c9:556 and disk:556 the AI never stood on a tile and lost 96–0 and 80–0.

### 3.3 Action mix by archetype

| Variant, archetype | Turns | Shoot | Special | Faction ability | Move only | Stand still | On a tile |
|---|---|---|---|---|---|---|---|
| v1 Aggressor | 51 | 55% | 0% | 4% (Ram) | 29% | 12% | 4% |
| v1 Grunt | 51 | 63% | 0% | 0% | 37% | 0% | 2% |
| v1 Sniper | 41 | 83% | 0% | 0% | 12% | 5% | 15% |
| v1 Support | 14 | 7% | 50% (Repair Drones) | 0% | 29% | 14% | 29% |
| v2 Aggressor | 19 | 21% | 0% | 26% (Repair) | 42% | 11% | 0% |
| v2 Grunt | 30 | 23% | 13% | 10% | 27% | 27% | 0% |
| v2 Sniper | 62 | 52% | 0% | 18% | 27% | 3% | 8% |
| v2 Support | 6 | 0% | 0% | 17% | 50% | 33% | 0% |
| v2 Turtle | 3 | 0% | 0% | 0% | 67% | 33% | 0% |

- **Move-only turns:** 76 of 81 closed the distance to the nearest enemy, and only 9 ended on a tile. The AI chases ships, not objectives.
- **v2 Aggressor:** it carries the Mining Drill (range 1), so it rarely gets a shot (21%).
- **v2 Grunt:** its 27% stand-still rate is the wall problem, now fixed (§6).

### 3.4 Stand-stills

25 stand-still turns:
- **20 were next to an impassable tile.** All of those that I replayed move with the 2026-11-03 fixes.
- **4 were deliberate holds on a tile.**
- **1 was a v1 Support with nothing to heal.**

### 3.5 Turns with an enemy in range that didn't shoot

| Pattern | Turns | Cause |
|---|---|---|
| Passed, enemy in gun range, terrain blocks every line of sight | 16 | The ship holds or edges closer but never moves to a tile with line of sight (§4.2) |
| v2 used Repair while an enemy was in range with clear terrain line of sight | 10 | Repair priorities 1 and 3 come before shooting (§4.3) |
| v1 Ram on a downed enemy holding a tile | 2 | Working as designed |

The v2 Sniper with range 7 used Repair on three turns in a row in two separate games (95346c9:556 and disk:556), with three to five enemies visible each time.

### 3.6 Stats

The average loadout across these games:

| | Gun damage | Range | Movement | Max HP | Damage reduction |
|---|---|---|---|---|---|
| Player ships | 67 | 4 | 5 | 119 | 26 |
| AI v1 Generic | 50 | 3 | 5 | 102 | 15 |
| AI v1 Sniper | 40 | 7 | 5 | 103 | 17 |
| AI v2 Generic | 60 | 3 | 4 | 146 | 26 |
| AI v2 Close | 95 | 1 | 5 | 150 | 20 |

Player fleets were also larger: 4.6 ships on average against the AI's 3.8. That's a content and balance point rather than AI logic, but it means kiting at the AI's own maximum range mostly doesn't work (§4.4).

## 4. Decision-tree findings

### 4.1 Objective play (highest impact)

1. **Variant 1 has no objective step.** `Variant1AI.decide` goes straight to the archetype tree. A tile is only sought in `_approachOrSeekTile`, when stepping toward the enemy wouldn't give a shot this turn. Only the Turtle seeks tiles first.
2. **Variant 2 claims tiles for every archetype, but often can't.** `claimScoringTile` runs before the archetype tree. When the best tile is taken it gives up the objective entirely (`objective == false`) rather than picking the next free tile.
   - _Correction, 2026-11-03: this one was wrong. `_bestScoringTile` already skipped occupied tiles until every tile was held, so the claim step only gives up when no free tile is left. Then the ship fights, and targeting prefers enemies standing on tiles. No change was needed._
3. **The side bias points short-range ships at the player's half.** `_bestScoringTile` pass 0 prefers tiles with `col <= midCol` for Generic and Close weapons. The AI spawns on the right, so short-range ships head for the player-side tiles first. The player reaches those tiles first, while the tile beside the AI stays empty.
4. **No score awareness.** Nothing reads `creatorScore`, `joinerScore` or `maxScore`. An AI that's about to lose on points plays exactly as it does at 0–0.
5. **Holds are all-or-nothing.** `_shouldHoldScoringTile` only lets a ship leave its tile if all three hold: it could shoot from where it would step, an ally could cover the tile, and no enemy threatens it. It never values the tile's points against a shot.

**Fixes:**
- ~~Add a shared objective step to Variant 1, reusing Variant 2's `claimScoringTile`, for every archetype except Aggressor and Sniper.~~ _Done 2026-11-03: `Variant1AI._claimOrSkirmish` for Grunt and Rammer, and the same step in `_support` after its heal. Turtle already played for tiles. Aggressor and Sniper are unchanged._
- ~~Replace the side bias with "nearest tile this ship can reach before any enemy can". The tile-race check can use the enemy movement stats already in the board view.~~ _Done 2026-11-03: `AIBehavior._bestScoringTile` now ranks tiles by tier:_
  1. _free, and this ship gets there first;_
  2. _free, and it's a tie;_
  3. _free, but an enemy gets there first;_
  4. _held by a live enemy._

  _Within a tier it prefers the most points per turn of travel, then the nearest. It never picks a tile its own ships or a wreck hold. Turns to reach are distance divided by movement, rounded up._
- ~~When the best tile is taken, take the next free one instead of dropping the objective.~~ _Not needed; see the correction to item 2._
- ~~When the player is within one or two rounds of `maxScore`, bias every ship toward an enemy tile-holder: shoot it, or move to contest its tile. The targeting already prefers enemies standing on tiles (`_bestEnemyWithin`), but movement doesn't.~~ _Done 2026-11-03, in a different form. The AI's board has no scores or `maxScore`, and adding them to `Game.getAIBoard` would use most of Game's last ~126 bytes. Instead, `AIBehavior.nearestEnemy` closes on the nearest enemy standing on a scoring tile whenever the enemy side earns more points per round from tiles than the AI does. That's the same live-ship count Game's round scoring uses. It affects every tree that approaches "the nearest enemy": v1 skirmish, and v2 brawl and fire support._

### 4.2 Line of sight

`standoffPosition`, `advanceToward` and `_fightFrom` only check the gun from the tile the ship moves to. They never look for a nearby tile that has line of sight. A ship whose target sits behind blocked tiles holds its tile, or takes its usual step, and passes again next turn.

~~**Fix:** when the enemy is within `range + movement` but no shot exists from the planned tile, search the tiles within movement for one with line of sight. Pick a scoring tile first, then the shortest move. This is `_standTile`'s existing enumeration with a line-of-sight test added. Gas: one `hasMapsAvoidingShips` call per candidate tile. Limit the search to tiles within `range` of the target to keep it bounded.~~

_Done 2026-11-03: `AIBehavior.shotWithinReach`, used by the v1 skirmish, the v2 brawl and the v2 fire support._
- _How it searches: it goes outward from the ship's own tile, nearest first. It skips tiles with no live enemy within gun range (checked in memory), and runs the external path and line-of-sight checks on at most 16 tiles. It doesn't prefer scoring tiles._
- _Where it runs: after the hold-a-tile check, so a ship holding a scoring tile keeps holding it._

### 4.3 Repair before shooting (variant 2)

`Variant2AI.decide` runs `healOnScoringTile` (priority 1) and `healDisabledWithReach` and `healDisabledFrom` (priority 3) before any shooting. Repair is +50 HP at range 1. That's worth it to revive a disabled ally, or to save an ally on a tile that would otherwise die. Topping up an injured ally while a 50–95 damage shot is available loses tempo, and the data shows it happening repeatedly.

~~**Fix:**~~
- ~~**Keep repair first** for a disabled ally, and for an ally on a tile at or below one enemy shot's worth of HP.~~
- ~~**Otherwise shoot first** when a target is in range, and repair only when there's no shot.~~

_Done 2026-11-03._
- _Priority 1 (an ally on a scoring tile) now repairs first only when `AIBehavior.healIsUrgent`: the ally is disabled, or a live enemy that can reach it next turn (range plus movement) would destroy it with one shot, using Game's damage formula._
- _Otherwise the repair waits. It happens if the turn would end without an action, or if its only action would be a shot at a disabled ship._
- _Priority 3 (revive a disabled ally) was already disabled-only and is unchanged._

### 4.4 Positioning and threat

1. **Variant 1 kites at its own maximum range.** That only helps when the AI out-ranges the enemy. v1 Generic has range 3 against the player's average of 4, so its stand-off tile is usually inside the player's range anyway.
   - ~~**Fix:** among tiles in its own range of the target, prefer one outside every live enemy's range. The inverse of `_enemyThreatensTile` already exists. Fall back to maximum range.~~ _Done 2026-11-03: a v1 kiter (Grunt, Sniper, and the Rammer and Support when they skirmish) first runs `shotWithinReach(ctx, true)`. That's a reachable tile with a shot that's out of every live enemy's range, judged by distance only. It doesn't run from a scoring tile. With no such tile, it falls back to the maximum-range stand-off._
2. **No self-preservation.** No ship backs off at low HP, and no ship avoids ending in range of several enemies. Variant 2 brawlers are meant to trade, but a 1-HP Sniper advancing into four guns throws the ship away.
   - ~~**Fix:** a low-HP check, for example below 25% of max HP. If any enemy threatens the planned tile, take the safest reachable tile that still shoots, else retreat toward allies (a Support's range when one exists).~~ _Done 2026-11-03, both variants: `AIBehavior.lowHpEvade` applies to a ship below a quarter of its max HP that isn't on a scoring tile._
     - _First choice: a safe tile with a shot._
     - _Otherwise, if its own tile is in an enemy's range, it moves to the nearest reachable tile out of every enemy's range. Variant 2 then repairs itself, or an ally, from there._
     - _"Toward allies" isn't implemented; it takes the nearest safe tile._
3. **Enemy choice counts wrecks.** `nearestEnemy` (`_nearestEnemyPosition(ctx, false)`) includes 0-HP enemies, so ships advance toward wrecks, which can't fire, ahead of live ships.
   - ~~**Fix:** live enemies first, and fall back to wrecks only for Ram and Storm users.~~ _Done 2026-11-03: `_nearestEnemyPosition` takes live ships first and falls back to wrecks only when none are left. Ram and Storm have their own downed-enemy lookups. `shotWithinReach` doesn't move a ship just to shoot a wreck._
4. **Distance ignores walls.** Every "nearest" choice uses Manhattan distance. With straight-line movement only, the nearest enemy can be several turns away behind a wall while a farther one is reachable now.

### 4.5 Target choice

`_bestEnemyWithin` prefers an enemy on a tile, then the lowest nonzero HP. It ignores:
- **Kills:** `hullPoints <= gunDamage - damageReduction` is the best target there is, and lowest HP only approximates it.
- **Damage reduction:** a 30-damage-reduction target can take less than half the damage of a 0-reduction one.
- **The enemy's threat:** its gun damage, and whether it's about to score.

~~**Fix:**~~
- ~~Score each target by: kill this shot, then on a tile, then expected damage after reduction, then lowest HP.~~
- ~~The fields are already in `ctx.g.shipAttributes`, so this is cheap.~~

_Done 2026-11-03: `AIBehavior._targetKey` ranks targets in this order:_
1. _a live target before a disabled one;_
2. _then a kill this shot;_
3. _then a target on a tile;_
4. _then damage after reduction (`shotDamage`, Game's formula);_
5. _then lower HP._

_For Drone Swarm (no line of sight needed), steps 2 and 4 are skipped, since its damage isn't the gun's. The enemy's own threat isn't scored yet._

### 4.6 Movement

The 2026-11-03 fixes covered:
- the wall sidestep;
- skipping a tile its own ships hold.

Movement is still greedy straight-line steps, plus four offset retries and the sidestep. A ship needing two turns to get around an L-shaped wall can oscillate.

**Fix (larger):**
- ~~Compute, inside the AI, a breadth-first distance field over passable tiles toward the target, using the impassable and occupancy bitmaps already in `ctx`.~~
- ~~Move to the reachable tile (straight line, within movement) with the lowest distance to the target.~~
  - _Done 2026-11-03: `AIBehavior._pathStep`. The search grows one ring at a time from the goal, every tile within the caller's stop-short distance of the target. Each ring is a few shifts on one `uint256`. Impassable tiles and live enemies block the search; allies and wrecks don't. The AI takes the first ring with a tile it can land on and reach in one clear line, trying the old greedy step's tile first. It allows at most 12 line checks. If nothing reachable is closer than where the ship stands, the old greedy step, detours and sidestep still run. The impassable bitmap wasn't in `ctx`, so `Maps.getImpassableBitmap` was added. Variant1AI grew by 1.3 KiB to 21.6 KiB, and Variant2AI to 22.7 KiB._
- This would replace the greedy step, the detours and the sidestep with one rule. ~~On an 11×17 grid with bitmaps, a breadth-first search is a few hundred thousand gas in a view call. That's well inside the HA7-11 headroom: an AI turn is about 0.5M today, against a 4–6.5M threshold.~~
  - _Correction, 2026-11-03: `decide` is not a view call. `SinglePlayerMatch` and `RoguelikeMatch` call it inside `takeAITurn`, so the player pays for it. A queue-based search would add 100–300k gas to a turn that costs about 490k today (`GasBudget.test.ts`, worst AI turn). The 11×17 board is 187 cells, so it fits in one `uint256`. A search can grow the whole frontier at once with shifts and masks: a few dozen operations per step, under about 40 steps. That's a few thousand gas. Most of the cost is the check that each candidate tile can be reached in a straight line, and the current code already pays for those checks._

### 4.7 Turn order

`AIBehavior.turnState` moves the AI's first unmoved ship in id order. Neither variant chooses which ship acts first. Two examples where order matters:
- a ship that can kill this turn should act before a healer moves next to the target's attackers;
- a Support should act after the ships it would heal take their turns.

This is a smaller gain, and it changes `turnState`, so leave it for later.

- ~~Choose which ship acts first.~~ _Done 2026-11-03: `AIBehavior.turnState` now picks among the unmoved live AI ships, using only the board:_
  1. _a ship with a live enemy in gun range that one shot destroys;_
  2. _then a ship with any live enemy in range;_
  3. _then the rest;_
  4. _Supports last._

  _Ties go to the first in the list, as before. Range is Manhattan distance, without the line-of-sight check, so a hidden enemy still counts. Each orchestrator passes `_isSupport`, a lookup of its own archetype records, and it's read only when a ship would otherwise be picked. The pick costs 27–47k gas at 14 against 15 ships, against 6.7k before. The range check is one bitboard per ship, and the one-shot check is one bitmap per gun damage value. A plain loop over pairs cost 160–230k. RoguelikeMatch grew to 23.6 KiB._

### 4.8 Things that work

- **Variant 1 Support:** it uses Repair Drones on half its turns.
- **Ram, Electric Storm and Flak:** their safety checks behave as designed.
- **Drone Swarm:** it reaches past the guns when nothing else can.
- **`AIDecisionFailed`:** it never fired. No decision reverted or ran out of gas.
- **Shooting rate:** about the same as players' (50% against 48%).

## 5. Archetypes

| Archetype | Today | Assessment |
|---|---|---|
| Grunt | v1: kites, holds tiles. v2: advances, holds tiles. | Fine once §4.1 and §4.2 land |
| Aggressor | v1: closes to max range. v2: as Grunt but never holds. | v2 never holding a tile is largely undone by the shared claim step. Decide whether v2 Aggressor should skip `claimScoringTile`. |
| Sniper | Max-range fire. v1 gives up tiles to keep range. | Good shot rate (83% on v1). Needs line-of-sight seeking (§4.2). |
| Support | Heals, else shoots, else seeks a tile. | v1 is fine. v2 is undercut by every v2 ship already having Repair (§4.3). |
| Turtle | Seeks and holds tiles. | Rarely placed: 10 of 52 configs, and 3 turns in the data. Not a substitute for objective play everywhere. |
| Rammer | v1 only: hunts downed enemies. | Niche. Fine. |

**Recommendation:** fix the shared behavior first. Most of the gap is objective play and line of sight, which every archetype shares. Then add two archetypes:

1. ~~**Objective Runner.** Fast, and races to the tile it can reach before any enemy, then holds it. It leaves the tile only to shoot a tile-holder. It's the role the current fleets lack: the Turtle seeks tiles but walks to the side-biased one, and no other archetype prioritizes tiles in variant 1. It suits variant 1's movement.~~ _Done 2026-11-03 as `Archetype.Runner` (6), in both variants. It takes the best free tile and holds it. With none free, it closes to gun range of the nearest enemy tile holder, whatever the score, and shoots holders ahead of any other target. It doesn't leave a held tile, even to shoot a holder. By then every variant 2 ship and the variant 1 Grunt already claimed free tiles, so the Runner's own part is contesting held tiles and putting holders first._
2. ~~**Hunter.** It picks the enemy it can kill soonest, weighted toward enemy tile-holders, and closes on it regardless of range or position, finishing with EMP, Ram or Swarm. `_nearestEnemyPosition`'s unused `preferZeroHP` path was kept for exactly this ("a future assassin-style archetype"). It gives the AI a way to break a player's tile hold, which is how the AI currently loses.~~ _Done 2026-11-03 as `Archetype.Hunter` (7), in both variants. Its quarry is the live enemy with the lowest (turns to come within range + shots to destroy it); ties go to a tile holder, then the nearer. It closes to gun range, uses its specials first, and shoots the quarry when it can, else the best target. It skips every claim step. Ram isn't part of its tree; the decide-level Ram on downed tile holders still applies to variant 1._

**Later, only if wanted:** a **Guardian**. It stays between the enemy and an ally on a tile, and shoots whatever threatens that ally.

**Adding archetypes is cheap structurally:**
- `Archetype` is a `uint8` enum, and appending values keeps existing configs valid.
- Each variant contract needs its own branch.
- Variant1AI is 15.6 KiB and Variant2AI is 16.4 KiB, both well under 24 KiB.
- It needs a full redeploy, and new seed configs that use the new archetypes.

## 6. Already done (2026-11-03, uncommitted)

- ~~AI ships stand still behind impassable tiles.~~ Fixed by `AIBehavior._trySidestep`. Tests in `test/VariantAITrees.test.ts`. All 7 variant 2 stand-stills in games disk:557 and disk:558 move when replayed.
- ~~A ship parks beside a scoring tile its own ally holds.~~ Fixed by `AIBehavior._unclaimableTile` in `_approachOrSeekTile`. Test in `test/VariantAITrees.test.ts`. Both disk:559 variant 1 stand-stills move when replayed.

## 7. Suggested order

1. ~~§4.1 objective play: a shared claim step, a tile race in place of the side bias, the next free tile when the best is taken, and score awareness.~~ _Done 2026-11-03._
2. ~~§4.2 line-of-sight seeking.~~ _Done 2026-11-03._
3. ~~§4.3 shoot before a routine repair.~~ _Done 2026-11-03._
4. ~~§4.5 target scoring: kills first, damage reduction counted.~~ _Done 2026-11-03._
5. ~~§4.4 threat-aware stand-off and low-HP retreat.~~ _Done 2026-11-03._
6. ~~§5 Objective Runner and Hunter archetypes.~~ _Done 2026-11-03._
7. ~~§4.6 breadth-first movement, and §4.7 turn order.~~ _Done 2026-11-03._

Steps 1–5 are changes to existing functions in `AIBehavior`, `Variant1AI` and `Variant2AI`. Each needs scenario tests in `test/VariantAITrees.test.ts`, and a full-suite run, since they change AI moves that other tests assert.

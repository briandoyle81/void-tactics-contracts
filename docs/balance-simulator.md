# Balance simulator (`near/crates/vt-sim`)

_Written 2026-11-16. ~~Status: Phases 1–5 built and tested. The first full experiment (`near/sim/experiments/default.json`, an overnight run) hasn't been run yet.~~ Updated 2026-11-17: the first full run finished (`near/sim/out/default/report.md`), and iteration 2 (loss-aware players, an Excellent player that models the on-chain AI) is built and tested. See "Iteration 2" at the end._

An off-chain simulator that produces balance data for **PvE** (campaign nodes and roguelike runs) and **PvP**. Simulated players play on the real rules: `vt-core` is the same deterministic engine the NEAR contract runs, and it is checked against Solidity.

**The goal:** nine player archetypes, {FTP, Casual, Whale} × {Poor, Average, Excellent}.
- **Two skill axes:** each archetype has a fleet-composition skill and an on-board tactics skill, weighted equally.
- **Spend profiles cover spend and play time:**
  - FTP: $0, plays a lot.
  - Casual: about $10/month.
  - Whale: about $200/month.
- **Output:** JSONL per match, summary CSVs, and a generated Markdown report.
- **The full design** is in the approved plan, summarized under "Phases" below.

**Simulated players never use the on-chain AI as their policy.** That AI is constrained by EVM gas limits. It appears only as the PvE opponent (as on chain) and as a strength yardstick. The simulated players' tactics come from a learned evaluation plus search (Phase 2).

## Running it

```sh
cd near
cargo test -p vt-sim --profile sim                       # Phase 1 checks (~2 s)
cargo run  -p vt-sim --profile sim -- smoke              # -> near/sim/out/smoke/{matches,runs}.jsonl
cargo run  -p vt-sim --profile sim -- smoke --seed 7 --pvp 100 --runs 20 --out /tmp/x
cargo run  -p vt-sim --profile sim --example movegen_bench
cargo run  -p vt-sim --profile sim -- train              # ~4 min -> near/sim/weights/{eval,train_log}.json
cargo run  -p vt-sim --profile sim -- calibrate          # ~11 min -> near/sim/{tactics,calibration}.json
cargo run  -p vt-sim --profile sim -- bench [--levels poor,average] [--scenarios N]
cargo run  -p vt-sim --profile sim --example mcts_sweep  # Excellent search settings vs Average
```

Phase 3 commands:

```sh
cargo run  -p vt-sim --profile sim -- fit-values         # ~1 min -> near/sim/weights/ship_value.json
cargo run  -p vt-sim --profile sim -- compose-bench [--scenarios 60] [--factorial 40]   # -> near/sim/composition_bench.json
```

**Retraining:** re-run `train`, then `calibrate`, then `fit-values` after any change to the rules, the attribute or cost tables, the content, or the feature list. The weights file records its feature list, and loading refuses a mismatch. The trained weights and calibration are committed, so experiments are reproducible without retraining.

- **Profile:** `--profile sim` is opt-level 3 with unwinding. The workspace `release` profile is tuned for small contract WASM, not speed.
- **Output:** `near/sim/out/` is git-ignored.
- **CI:** runs the tests and a smoke run (`.github/workflows/near.yml`).

## Phase 1: what exists

| Module | What it does |
|---|---|
| `rules.rs` | `LocalRules` (vt-core `Rules`) and `Config` (attribute and cost tables, storefront tiers, heal cap), loaded from `near/seed/config.json`. `integration-tests` now re-exports this `LocalRules` instead of keeping its own copy. |
| `content.rs` | Loads `ignition/data/{singlePlayer,roguelike,pvp}StarterContent.json`: maps with deployment zones, 64 AI ship configs, placements, 30 campaign nodes with prerequisites, the 35-node roguelike graph (win effects, ship grants, resupply caps), and 6 PvP maps. It builds AI fleets the way `build_ai_fleet` does (cells in ascending order, ids 2^40+1..). |
| `movegen.rs` | The legal-move generator (see below). |
| `fleet.rs` | `roll_ship`, which matches the contract's construction path (`generate_ship`, kept preset rank, constructed, priced). Fleet entries, and Poor-level random selection and placement. |
| `tactics.rs` | The `Tactician` trait, and `RandomTactician` (the strength floor and smoke-test player). |
| `runner.rs` | `play_match` (any two controllers; the on-chain AI may play only the joiner side, through `take_ai_turns`); `run_roguelike` (whole runs); the `RunPlanner` hook for path, resupply and placement decisions; and PvE DEC rewards. |
| `log.rs` | The `MatchLog`, `ShipLog` and `RunLog` records, and a JSONL writer. |
| `experiments.rs` | `smoke`: every campaign node, N PvP games and N roguelike runs. |

The pure roguelike run rules moved from the contract into **`vt-core::roguelike`**: `healed_hp`, `heal_above_floor`, `repair_missing_hp`, `check_advance`, `locked_by_advance` and `roster_positions`. The contract and the simulator share one implementation. All 264 contract unit tests and the roguelike sandbox test pass after the move.

### Move generator

- **Candidates:** every candidate is confirmed by applying it to a clone with `GameState::move_ship`.
- **Destinations:** computed with the engine's own rules (distance, occupancy, a path that avoids enemies).
- **Targets:** pruned by reach.
- **Duplicates by outcome are dropped.**
  - Flak Array is an area effect, and the engine only checks that its named target exists. So aiming it at any ship gives the same position as aiming it at none.
  - Repairing yourself at full HP is the same as passing.
  - Only the first such move is kept, which shrinks the search tree without losing any reachable position.
- **Throughput:** about 4,500 positions a second per core, with about 138 legal moves per position (Apple Silicon, 10 cores). That is too slow to expand every move at every node in Phase 2. MCTS should expand one ship's moves at a time (`ship_moves`) rather than call `legal_moves` per node.

### Verification (`crates/vt-sim/tests/phase1.rs`)

- **Content:** all content loads, and every campaign and roguelike combat node builds an AI fleet.
- **Soundness:** every generated move is legal (more than 50 positions from random PvP and campaign play, both variants).
- **Completeness, by brute force:**
  - For one actor per sampled position, every (cell × action × target) is tried against the engine.
  - Every engine-accepted move's resulting position must be reachable from a generated move, in both pruned and exhaustive modes.
  - Generated moves must be distinct by outcome.
- **Reproducibility:** the same seed gives byte-identical JSONL, and a different seed gives different output. Records hold no wall-clock data.
- **Rolled ships** are constructed and priced (`cost == ship_cost(current table)`), and a preset rank is kept.

### Record schema (JSONL)

- **`match`**:
  - **game:** `kind` (campaign/roguelike/pvp), `seed`, `map`, `node`;
  - **result:**
    - `winner` (creator/joiner/draw);
    - `end` (decided, `round_cap` or `stalled`);
    - `rounds`, `moves`, `scores`;
  - **per side:**
    - `creator`/`joiner`: label, tactician, fleet cost and list cost, ship count;
    - `actions`: counts of pass/shoot/retreat/assist/special/faction;
  - **`ship_logs`, per ship:**
    - the build: traits, equipment, rank kills, cost, `list_cost` (a price for AI ships too), AI config key, cell;
    - HP: max, start and end;
    - damage dealt and taken, healing done, kills, moves;
    - the outcome: alive, disabled, destroyed or fled.
- **`run`**:
  - the run: `seed`, `label`, the node `path`, `combats_won`, `won`;
  - why it ended (`end`): won, lost, `no_path` or `roster_exceeds_zone`;
  - rewards and costs: DEC earned, HP repaired, ships lost (permanently destroyed, as on chain), granted ships.

### Deliberate simplifications and known gaps

- **Round cap:** a game still running after 40 rounds (or 4,000 moves) ends as a draw (`end: "round_cap"`). On chain there's no round cap, only turn timeouts. The cap is in `Limits`.
- **Stalls:** if the on-chain AI makes no move on its turn, the game ends as a draw (`end: "stalled"`). That would leave a real game waiting for a timeout claim. The report will flag any stalls.
- **Roster order:** after a roguelike win, the roster keeps its own order rather than the contract's swap-remove order. The player re-places every combat, so outcomes don't depend on it.
- ~~**Roguelike win paths aren't exercised by a test yet.** The random player never clears the first node. Phase 2's Average tactician will add that test: survivors, rejoiners, the heal floor, win effects and resupply.~~ Done in Phase 2: `roguelike_wins_follow_the_post_win_rules` (`tests/phase2.rs`).
- **Plan deviation:** the plan said to test completeness on the fuzz-corpus states (`near/golden/engine_fuzz.json`). That corpus stores move sequences rather than positions, so the test samples positions from seeded random play instead. That covers both variants and every special.

## Phase 2: tactics

### Evaluation (`eval.rs`)

The evaluation is a weighted sum of 14 features. Each feature is "us minus them", so a position's value for one side is the negative of its value for the other (a test checks this):
- **material:** operational HP, live ships, disabled ships, firepower;
- **score:** score, and closeness to a points win (`score_race`);
- **scoring tiles:** points on tiles our live ships stand on (`tile_hold`), and how close our ships are to tiles (`tile_reach`);
- **danger:** damage the enemy can deal next round (`threat`), and our ships it can disable (`killable`);
- **position:** shots available from where ships stand, using the engine's range and line-of-sight rules (`shots_now`);
- **turn order:** ships yet to move (`tempo`) and whose turn it is (`to_move`);
- **reactor timers** on disabled ships.

The features encode the engine's mechanics:
- Combat is fully deterministic: no hit rolls. Damage is gun damage reduced by damage reduction.
- A ship at 0 HP is disabled. Its reactor timer ticks every round and every time it's shot, and destroys it at 3.
- At the end of each round, every live ship on a scoring tile scores.

**The weights are learned, not hand-set** (`train.rs`), with separable CMA-ES (Ros & Hansen 2008; a diagonal covariance suits 14 weights and noisy fitness).
- **Fitness:** a candidate plays as Average. Half its fitness is its score against the generation's mean weights over 24 paired PvP scenarios (48 games). The other half is its campaign clear rate against the on-chain AI over 24 games.
- **Common random numbers:** every candidate in a generation plays the same scenarios.
- **Win-probability scale:** fitted afterwards by logistic regression on every position of 200 Average self-play scenarios: P(win) = sigmoid(0.70 × evaluation).
- **Training run:** 60 generations, about 4 minutes on 10 cores.
- **Result:**
  - trained weights beat the seed weights **56.8% ±4.4%** over 400 paired games;
  - the campaign clear rate with random fleets rose from **28% to 42%**.
- **What it learned:** scoring tiles matter much more than the seed weights assumed (`tile_hold` is the largest weight), along with HP and `score_race`. Several small weights flipped sign, which is common when features overlap.
- **Where it's stored:** `near/sim/weights/eval.json` (with provenance) and `train_log.json`.

### The three levels (`tactics.rs`)

| Level | Method | Calibrated knobs (`near/sim/tactics.json`) |
|---|---|---|
| Poor | One-ply greedy. Its noise dial t fades out the positional features (keeping material and score), raises the softmax temperature, and adds random moves. | t = 0.145 (temperature 0.072, ε 0.043) |
| Average | One-ply greedy on the full evaluation (argmax, random tie-break). | none |
| Excellent | MCTS with progressive widening, ordered by the one-ply evaluation. Values are normalized across the tree's observed range (as MuZero does). Leaves are scored after a short greedy look-ahead. | 100 simulations, 4-ply look-ahead |

### Calibration results (`near/sim/calibration.json`, 200 paired games each)

_Superseded 2026-11-16 by the Phase 4 recalibration with loss aversion (see Phase 4); kept for the record._

| Head to head | Score (95% CI) |
|---|---|
| Average vs Poor | 0.735 ±0.056 |
| Excellent vs Average | 0.748 ±0.052 |
| Excellent vs Poor | 0.850 ±0.042 |

| Campaign clear rate vs the on-chain AI (30 nodes × 4 random fleets) | |
|---|---|
| Random | 0.00 (smoke run) |
| Poor | 0.133 |
| Average | 0.350 |
| Excellent | 0.558 |

The PvE ordering wasn't a calibration target, but it comes out monotone. The fleets are random (Poor composition), so these numbers measure tactics alone. Phase 3 adds composition skill.

### Findings along the way

- **The first attempt at Poor was too weak:** Average beat it 92% even with no added noise, because hiding the positional features entirely costs too much. The dial now fades those features continuously, from "identical to Average" (t = 0) to "material only, noisy" (t = 1), which bisection can set to any target.
- **More simulations don't make tree search stronger. Look-ahead does.**
  - Simulation count barely matters: from 25 to 800 simulations, Excellent stayed at 55–63% against Average.
  - Value normalization was needed but didn't help on its own.
  - Look-ahead scales:

    | Leaf look-ahead | Excellent vs Average |
    |---|---|
    | 0 plies | 60% |
    | 2 plies | 72% |
    | 4 plies | 76% |
    | 8 plies | 80% |

  - Games are short (score races end them in a few rounds), and a move is one ship's action, so a few plies of opponent replies is where the extra strength comes from.
- **Cost:** an Excellent game takes about 5 core-seconds, against milliseconds for Average. Phase 5 experiments should budget for this (about 2,000 Excellent games per core-hour).

### Verification (`crates/vt-sim/tests/phase2.rs`, ~11 s)

- **Antisymmetry:** evaluation and value are antisymmetric on positions along real games.
- **Legal and reproducible moves:** every level picks a legal move, and the same move again for the same seed.
- **Ordering:** the committed weights and calibration keep the ordering on fixed seeds. Those seeds are deterministic, so the test can't flake:
  - Average beats Random (above 0.9);
  - Average beats Poor (above 0.55);
  - Excellent beats Average (above 0.55).
- **Parallel reproducibility:** head-to-head runs in parallel give byte-identical logs.
- **Roguelike win paths, with the Average tactician:** runs win combats (at least 5 across 24 runs), and after every win:
  - every roster ship is at or above the heal floor;
  - ships are at full HP after heal-to-full nodes;
  - paths follow graph edges;
  - grants come only from grant nodes.

## Phase 3: composition

Composition is a second skill axis with the same three levels (`src/composition/`). It covers choosing ships under the cost cap, deploying them, and DroneYard builds.

### Ship value model (`value.rs`)

The value model is a Bradley–Terry logistic fit, P(creator wins) = sigmoid(b0 + β·(Σφ(creator ships) − Σφ(joiner ships))).
- **Data:** 8,000 Average-vs-Average PvP games between random fleets. Caps are 500–2,000, about 30% of fleets are variant 2, and placement is heuristic.
- **Features φ:** ship count, HP, effective HP, damage, range, damage × range, movement, and a special slot per variant.
- **Fit quality:** on 1,600 held-out games it predicts the winner 66.8% of the time, with log-loss 0.641 (a coin flip is 0.693).
  - Fleets matter, but tactics and placement decide much of each game.
- **Result:** movement is by far the most valuable stat (+0.405 per 5 movement, against +0.138 per 100 damage and +0.08 per 100 HP).
  - That fits Phase 2's finding that scoring-tile races decide games.
  - Heavy armor and Missile weapons cost movement. Phase 5's cost-efficiency analysis should check their prices.

### Levels

| | Ship choice | Placement | DroneYard build (`modify.rs`) |
|---|---|---|---|
| Poor | random ships that fit | random tiles | random valid build |
| Average | greedy by value per cost, plus a role check (at least one front-liner, range ≤ 3, and one long-range ship, range ≥ 5, when the pool allows) | heuristic (`place.rs`): each ship stands at a distance from the enemy matching its range; front line first; avoids clumping; fast ships lean toward scoring tiles | highest-value build |
| Excellent | (μ+λ) evolutionary search over (ships, tiles), seeded with the Average lineup. Each candidate is scored by playing it with Average tactics against the node's real AI fleet (PvE) or 3 sampled meta fleets (PvP). | same search | best value per fleet cost (the cap is what binds) |

**Excellent's settings** (`SearchParams`): 6 parents, 8 offspring, 6 generations. That's about 4 core-seconds per composition, comparable to one Excellent tactics game (about 5 s).

**Held-out validation:** without it, Excellent overfit the 3 meta fleets it searched against and scored 0.375 against Average in a small probe. Now the final parents and the starting lineup are re-scored on 6 fresh opponents (PvP) or a fresh seed (PvE), and the best is kept. That raised it to 0.592.

**DroneYard builds** follow `DroneYard.modifyShip`:
- the variant can't change;
- armor and shields can't both be set;
- trait tiers run 0–2;
- specials go up to the variant's max slot.

How much to spend on modifications is Phase 4's economy decision; the composer only picks the build.

**Roguelike planners** (`planner.rs`) make the run decisions at each level:
- **Poor:** random path, no repairs.
- **Average:** heads for resupply when damaged; otherwise takes the weakest-looking AI fleet. Repairs ships below 60% HP, and fills the raised cap with the best value-per-cost reserves.
- **Excellent:** previews each combat child by playing it once; repairs every damaged ship; swaps out its weakest ship for clearly better reserves; and searches placement against each node's AI, weighting survival (damage carries forward).

### Results (`near/sim/composition_bench.json`; Average tactics unless noted)

**PvP**, 120 shared-pool games per pair (both players get copies of the same pool, sides swapped):

| | Score |
|---|---|
| Average composition vs Poor | 0.767 ±0.070 |
| Excellent vs Average | 0.592 ±0.077 |
| Excellent vs Poor | 0.775 ±0.069 |

**Campaign clear rate** against the on-chain AI (30 nodes × 4 random 30-ship pools):

| Composition | Clear rate |
|---|---|
| Poor | 0.358 |
| Average | 0.675 |
| Excellent | 0.733 |

**Roguelike**, 40 runs each:

| Composition and planning | Combats won per run | Runs won | Ships lost per run |
|---|---|---|---|
| Poor | 1.75 | 0/40 | 1.0 |
| Average | 2.70 | 0/40 | 2.5 |
| Excellent | 3.95 | 1/40 | 4.8 |

**Factorial**: 3 composition × 3 tactics levels at a fixed shared pool. Each cell is the score of 80 PvP games against an Average/Average player:

| composition \ tactics | Poor | Average | Excellent |
|---|---|---|---|
| Poor | 0.087 | 0.169 | 0.431 |
| Average | 0.250 | 0.500 | 0.887 |
| Excellent | 0.225 | 0.550 | 0.812 |

- **Variance share:** composition 30%, tactics 65%, interaction 5%.
- **Excellent minus Poor**, averaged over the other axis: composition +0.300, tactics +0.523.

### What the results say, and their limits

- **PvE: composition matters as much as tactics.**
  - Composition alone, at Average tactics, roughly doubles the campaign clear rate (36% to 68%).
  - Tactics alone, at Poor composition, moves it from 13% to 56% (Phase 2).
- **PvP: tactics carries about two-thirds of the variance.** Almost all of composition's effect is Poor to Average: bringing a sensible fleet. Above that, Average and Excellent composition are within noise of each other in the factorial (0.500 vs 0.550 at Average tactics, and 0.887 vs 0.812 at Excellent tactics, with overlapping intervals).
  - So against a competent opponent drawing from the same pool, fleet optimization beyond "sensible" is worth only a few points.
  - In real play pools differ by spend, which is exactly what Phase 4/5 add.
- **The PvP shares aren't a pure property of the game.**
  - The tactics levels were calibrated to fixed 75% gaps; that's a modeling choice about how far apart human players are.
  - The composition levels are defined by method and measured, not calibrated.
  - So the 65/30 split says "with players spread this far apart in tactics, tactics matters about twice as much as composition." Phase 5's report will show how the split moves with that assumption.
- **No roguelike run gets close to finishing.** The best is 1 complete run in 40 (35 nodes; the median run ends within the first 2–4 combats), even with Excellent planning.
  - That may be a difficulty issue: a starting pool of 30 random ships, a 600 starting cap, and an 80% heal floor.
  - Or the players may still be too weak (Excellent tactics wasn't used here, for cost).
  - Phase 5 should run roguelike with Excellent tactics and composition before calling it.

### Verification (`crates/vt-sim/tests/phase3.rs`, ~11 s)

- **Composers return valid fleets** for every level on PvP maps (both sides) and campaign nodes:
  - the ships come from the pool, distinct, with total cost under the cap;
  - one variant, the required variant when set;
  - distinct tiles from the side's deployment zone;
  - fixed-roster placement checked the same way.
- **DroneYard builds follow the contract's rules:**
  - all 4 × 7 × (max special + 1) × 27 loadouts are enumerated;
  - armor and shields are never both set;
  - none of the unused `Future` slots are used;
  - every build is re-priced;
  - each level stays within its change budget;
  - Average's builds raise the ship's value.
- **Average composition clears more campaign nodes than Poor** (fixed seeds, so deterministic).

### Finding outside the simulator (not changed)

Both `DroneYard.sol` and the NEAR `modify_ship` accept the four unused `Future1..4` slots for weapon, armor and shields, because only the special slot is range-checked. Those slots have zero stats and the same price as the real types, so picking one is never an advantage and isn't an exploit. It does let a player store an equipment value the frontend and renderer may not handle. Worth deciding whether to reject indices ≥ 4 in both contracts.

## Phase 4: economy (`src/economy.rs`, `near/sim/profiles.json`)

```sh
cargo run -p vt-sim --profile sim -- economy [--days 84] [--players 4] [--seed 1] [--out DIR] [--resume | --fresh]
# -> DIR/{matches,runs,players}.jsonl, DIR/summary_partial.json (updated daily),
#    DIR/checkpoint.json, and at the end DIR/summary.json plus a per-archetype table
```

**Runs write as they go, and resume where they stopped** (`economy::run_to_dir`). After each simulated day:
1. The day's lines are appended to the JSONL files and flushed to disk.
2. `checkpoint.json` is replaced atomically (write a temp file, fsync, rename). It holds the full state and each file's length.
3. `summary_partial.json` is refreshed.

So stopping a run, for any reason, loses at most the day in progress, and the partial results are always readable.
- **Resume:** `--resume` continues from the checkpoint. It trims any lines written after it, so a crash mid-day never duplicates a day.
- **Extend:** a finished run can be lengthened with `--resume --days N`.
- **Safety:** an existing run is never overwritten by accident. Without `--resume` or `--fresh` the command refuses.
  - A resume is also refused if the inputs changed: the weights, tactics, ship values, profiles, rules or content files, or the search settings (checked by an FNV-1a fingerprint), or if any option other than `--days` differs.
- **Exactness:** a resumed run produces exactly the files of an uninterrupted one. Nothing random carries across days, and floats round-trip exactly (`serde_json` `float_roundtrip`).
  - **Tested:** `resumed_runs_match_uninterrupted_runs` stops a run with a half-written day after its checkpoint, resumes it, and compares all three files byte for byte with an uninterrupted run and the in-memory run.

### Population and profiles

The nine archetypes are each spend profile × each skill level. A skill level sets both composition and tactics.

| Spend | $/month | Sessions/week | Games/session | Mix (campaign / roguelike / PvP) | Packs | Modifications |
|---|---|---|---|---|---|---|
| FTP | 0 | 10 | 4 | 0.55 / 0.15 / 0.30 | none | none |
| Casual | 10 | 3 | 3 | 0.45 / 0.20 / 0.35 | tier 1 (11 ships, $9.99) | none |
| Whale | 200 | 5 | 4 | 0.30 / 0.20 / 0.50 | tier 4 (60 ships, $49.99) | 25% of spend as UTC |

Every number is in `near/sim/profiles.json`. That includes the economy constants mirrored from the deploy seed (pack sizes and prices, claim base and cooldown, recycle and kill rewards, repair and modification costs, the medal node), so a pricing experiment is a config edit.

### What happens each day

1. **Economy, per player:**
   - **Free claim** every 28 days: 10 plus the storefront tier.
   - **Spend:** accrues daily. Packs are bought when the budget covers them, with the first tier+1 ships getting rank presets as on chain. The modification share converts to UTC.
   - **DEC turn-in** at the storefront prices.
   - **Recycling:**
     - Average and Excellent recycle destroyed paid hulks for half the reward.
     - Excellent also recycles its weakest paid ships once it has more than 120.
   - **DroneYard modifications:** applied to the strongest ships while UTC (above a 5 UTC reserve) covers the doubling cost. The build comes from the composition level (Phase 3).
   - **Which variant to claim and buy:**
     - Poor stays on variant 1.
     - Average alternates once the medal unlocks variant 2.
     - Excellent claims variant 1 (roguelike needs it) and buys the variant with the better expected value per cost.
2. **PvE, in parallel across players:**
   - **Campaign:** the next unlocked node. Poor picks a random unlocked node; Excellent picks the easiest by AI fleet value. Once the campaign is done, players farm the node with the most variant-2 AI ships per AI strength, for DEC.
   - **Roguelike runs:** the repair budget is the player's UTC, and the runner enforces it. A repair the player can't pay for is skipped, so free players effectively can't repair.
3. **PvP rounds:**
   - **Matchmaking:** players queue in the largest bracket (500/1000/2000) their 12 best ships can mostly fill (80% of the cap), and are paired by Elo plus noise.
   - **Opponents in search:** an Excellent composer searches against a rolling meta of the 24 fleets most recently fielded in that bracket.

### Contract rules modelled

- **Destroyed ships are permanently lost**, in campaign, roguelike and PvP, and are recyclable as hulks for half the reward.
- **AI kills:** variant-2 AI kills pay 1 DEC; variant 1 pays nothing.
- **PvP kills:** a kill of a non-free ship pays the killer's owner 0.025 UTC and adds a rank kill to the killing ship. Free victims pay nothing.
- **Free ships** can't be recycled.
- **Medal:** winning campaign node f06 earns it, and it unlocks variant 2 for claims and purchases.
- **Roguelike grants:** ship grants are once per player where flagged, and roguelike DEC bonuses are paid.

Every player's randomness is seeded from (seed, player, day). Players act in parallel only where they don't interact, and results are applied in a fixed order, so runs are reproducible (tested).

### Loss aversion (a finding, and a model change)

The first economy probe had players lose almost all their ships within a week: free players went from 10 to 1–2.

**The cause was in the simulated players, not the game.** The trained evaluation only cares about winning, so a destroyed ship and a retreated one looked the same, and nobody retreated a doomed disabled ship. Real players would, because destruction is permanent.

**The fix:** each level's evaluation gets a **loss-aversion term** (`eval::loss_term`).
- ~~**What it counts:** enemy minus own ships permanently destroyed, plus the risk on disabled ships still on the board, (1 + reactor timer) / 3.~~ Replaced 2026-11-17 by one-sided, per-player loss preferences (`eval::LossPrefs`); see "Iteration 2".
- ~~**Weight:** 0.5 for Average and Excellent, 0 for Poor (`tactics.json` → `loss_aversion`).~~ Replaced 2026-11-17: the weight now depends on the spend profile and the hangar; see "Iteration 2".
- **Why it's a preference, not a trained weight:** losing ships doesn't lose games.

**Measured effect** (Average, `--example loss_aversion`):

| | Without | With |
|---|---|---|
| Own ships destroyed per campaign game | 3.08 | 0.34 |
| Ships retreated per campaign game | 1.03 | 4.28 |
| Own ships destroyed per PvP game | 0.52 | 0.04 |
| Head to head vs no aversion | — | 0.483 ±0.050 |
| Campaign clear rate | 0.375 | 0.350 |

So it protects ships at almost no cost in wins.

**Recalibrated** with loss aversion applied the same way games apply it: Poor noise 0.145; Excellent at 4 plies of look-ahead.

| Head to head | Score |
|---|---|
| Average vs Poor | 0.708 ±0.057 |
| Excellent vs Average | 0.743 ±0.053 |
| Excellent vs Poor | 0.845 ±0.043 |

Campaign clear rates against the on-chain AI are now 0.133, 0.358 and 0.517 for Poor, Average and Excellent.

### Speed (results unchanged)

Quality takes priority over speed. Every optimization here leaves results bit-identical, checked by a digest of the game logs (`--example excellent_profile`):
- **Evaluation:** no longer clones each ship's record or the scoring list on every call.
- **Search reuse:** a search leaf keeps the ordered move list its look-ahead computed. The look-ahead's pick is that list's first entry, so the node doesn't recompute it.
- **Parallel work:** move generation runs per ship in parallel, and candidates are scored in parallel. Collection is order-preserving.
- **Composer search:** candidates are scored in parallel.

**Timing for 8 Excellent-vs-Average games:**
- single-threaded: 23.2 s down to 19.9 s;
- on 10 cores: 7.0 s.

The economy is still bound by the busiest player's sequential games.
- **Measured cost:** a 36-player run (4 per archetype) takes about 18–22 minutes per simulated week, growing as hangars grow. A 12-week run is several hours.
- **That's Phase 5 work:** large runs are overnight jobs. ~~Phase 5's experiment runner should:~~ Done 2026-11-16 for the economy run (see the start of Phase 4), and Phase 5's experiments will use the same pattern:
  - ~~save progress (checkpoint) so a run can resume;~~
  - ~~write results as it goes;~~
  - be scheduled overnight.
- Phase 4 was validated by its tests and a 7-day, 9-player probe.

### Bug found by the first long run (fixed)

The first 12-week run crashed on day 8: a placement ran out of tiles.
- **Cause:** PvP meta fleets come from every map, but zones differ (`pvp03` has 16 tiles; the default band has 44). The Excellent search tried to place a 17+ ship meta fleet as a hypothetical opponent on `pvp03`.
- **Fix:** the search now samples only meta fleets that could deploy on the map's opponent zone. If none fit, it keeps the most expensive ships that do.
- **Same pattern in the roguelike planner:** the Excellent planner's preview now scores a node whose zone can't hold the roster as a loss, since the real run would end there with `roster_exceeds_zone`.
- **Regression test:** `oversized_meta_fleets_are_never_placed` (`tests/phase3.rs`).

### Verification (`crates/vt-sim/tests/phase4.rs`)

- **Spending and claims with play turned off** (60 days, all nine archetypes), checked exactly:
  - claims are 3 × 10 at tier 0;
  - spend equals $/month × days;
  - packs bought equal floor(spend / price) × pack size;
  - the inventory adds up;
  - every ship is variant 1 without the medal;
  - pack rank presets match `kills_for_rank`;
  - every ship is constructed and correctly priced.
- **Short runs with play:**
  - byte-identical across reruns;
  - ship ids unique and below the AI range;
  - UTC never negative;
  - DEC earned equals turned in plus held;
  - inventory equals claimed + bought + granted − lost − recycled.

## Phase 5: experiments and the report (`src/experiment/`)

```sh
cd near
cargo build -p vt-sim --profile sim
./target/sim/vt-sim run sim/experiments/default.json      # overnight; -> sim/out/default/report.md
./target/sim/vt-sim run sim/experiments/default.json      # after any stop: resumes where it left off
./target/sim/vt-sim report sim/out/default                # re-render the report at any time
./target/sim/vt-sim run sim/experiments/smoke.json        # the whole pipeline in ~15 s (not results)
```

### Writing as it goes

Every stage is a list of independent units: one scenario, one node attempt, one run. Each unit is seeded only by (experiment seed, stage, unit index).
- **Saving:** finished units are appended to `<stage>.units.jsonl` in chunks, each flushed to disk.
- **Resuming:** units already in the file are skipped, and a half-written last line is trimmed.
- **Economy:** the economy stage resumes from its daily checkpoint.
- **When a stage finishes:** its aggregate goes to `<stage>.json` and the report is re-rendered. So `report.md` is readable during a run, with unfinished stages marked pending.
- **Safety:** `manifest.json` records the config and an input fingerprint. A run directory refuses a different config or changed inputs unless `--fresh` is given, which empties the runner's own files and never deletes directories.
- **Tested** (`tests/phase5.rs`): the smoke experiment runs every stage. Then a stage is cut off mid-file, leaving half its units and a half-written line, and its aggregate is lost. The re-run recomputes only the missing units, and the aggregate and report come out byte-identical. A changed config is refused.

### Stages (`default.json`)

| Stage | What it measures | Default size |
|---|---|---|
| `components` | The value of every cost-table entry (Bradley–Terry over Average-vs-Average games between random fleets), compared with its price. That gives value per cost point, each entry's fair price, and an over/under/fair verdict at 2 standard errors. Also which entries Excellent composers actually field, relative to what they had. | 20,000 games; 300 compositions |
| `pve` | Clear rate per campaign node per level (composition and tactics at the same level), with every level given the same random pools. Also AI config effectiveness: damage, kills, how often destroyed. | 30 nodes × 3 levels × 8 pools |
| `roguelike` | Full runs per level, with unlimited repairs to measure play rather than the wallet: combats won (histogram), runs completed, ships lost, and win rate per node (where runs end). | 40 runs per level |
| `factorial` | Composition × tactics, 3×3 against an Average/Average reference, under three tactics-gap assumptions: **narrow** (Poor noise 0.06, no look-ahead), **calibrated**, and **wide** (noise 0.25, 8 plies). Each variant reports its own measured gaps beside the variance split, so the split is always shown with the assumption it depends on. | 40 scenarios × 9 cells × 3 variants |
| `economy` | The nine-archetype population over time (Phase 4), with progression curves by week. | 84 days, 3 players per archetype |
| `matrix` | 9×9 PvP using each archetype's actual end-of-economy hangar: paired scenarios with sides swapped, in 1,000 and 2,000 brackets. Gives Bradley–Terry Elo, the **pay-to-win index** (higher spender vs lower at equal skill), and the **skill index** (Excellent vs Poor at equal spend). | 45 pairs × 30 scenarios |

**Flags** (thresholds in the experiment file):
- pay-to-win above 65%;
- Excellent beating Poor below 65%;
- a node Average players clear under 20% of the time;
- a difficulty spike of more than 35 points between consecutive nodes;
- a skill inversion on a node;
- a mispriced component (more than 30%, 5 points and 2 standard errors);
- a component Excellent never picks;
- an AI config that never deals damage or is never destroyed;
- no roguelike run completed at Excellent.

**Estimated cost** of `default.json` on 10 cores, from the Phase 2–4 timings:

| Stage | Estimate |
|---|---|
| Components | ~10 min |
| PvE | ~5 min |
| Roguelike | ~10 min |
| Factorial | ~30 min |
| Economy | ~3–4 h |
| Matrix | ~45 min |

**About 5–6 hours in total, so run it overnight.** The cheap stages run first, so their sections are readable early.

## Phases

1. ~~Foundations: crate, loaders, move generator, runners, logging, roguelike rules into vt-core.~~ Done 2026-11-16.
2. ~~**Tactics:**~~ Done 2026-11-16 (see above). Excellent uses look-ahead rollouts rather than full playouts, and the leaf look-ahead is a calibrated knob.
   - ~~a feature-based evaluation function, with weights trained by self-play (CMA-ES);~~
   - ~~three levels:~~
     - ~~Poor: a reduced feature set, high temperature and ε-random moves;~~
     - ~~Average: one-ply greedy;~~
     - ~~Excellent: MCTS with Average-policy rollouts;~~
   - ~~calibration targets (Average beats Poor about 75%, Excellent beats Average about 75%), and benchmarks against the on-chain AI.~~
3. ~~**Composition:**~~ Done 2026-11-16 (see above). Excellent placement also uses the search; pack and variant purchase choices move to Phase 4, where the money is.
   - ~~three levels:~~
     - ~~Poor: random;~~
     - ~~Average: a learned ship value model plus role templates and heuristic placement;~~
     - ~~Excellent: evolutionary search over subset and placement, scored by simulation against the expected opponent;~~
   - ~~DroneYard modification choices.~~
4. ~~**Economy:**~~ Done 2026-11-16 (see above), plus loss aversion and result-identical speedups.
   - ~~spend and play-time profiles (`near/sim/profiles.json`);~~
   - ~~free claims, storefront tiers, packs, recycling and modification;~~
   - ~~session mixes, the medal and variant-2 unlock;~~
   - ~~Elo matchmaking in cost brackets.~~
5. ~~**Experiments and report:**~~ Built 2026-11-16 (see above): every listed output, resumable. ~~The first full run is pending.~~ The first full run finished 2026-11-17 (~6h45m; `near/sim/out/default/report.md`).
   - ~~the nine archetypes, plus a 3 × 3 composition × tactics factorial at fixed spend;~~
   - ~~outputs:~~
     - ~~win-rate matrices and Elo;~~
     - ~~pay-to-win and skill indices;~~
     - ~~per-node clear rates;~~
     - ~~component pick and win rates;~~
     - ~~a cost-efficiency regression;~~
     - ~~economy curves;~~
   - ~~flagged outliers.~~

## Iteration 2 (2026-11-17)

**Why:** the first full run (`near/sim/out/default/report.md`) had two problems that made its headline results unreliable:
- **Free players ended with 0 ships.** So the PvP matrix couldn't play them: 1,592 games were unplayable, and there were no pay-to-win numbers against free players.
- **Excellent was far weaker than a strong human.** It cleared m13 38% of the time and f01/f03–f06 12–62%. A strong human clears the campaign easily with an unoptimized fleet.

The plan is at `~/.claude/plans/good-first-run-we-sparkling-nautilus.md`.

### What changed

**Loss preferences depend on the player** (`eval::LossPrefs`, `economy::World::loss_prefs`):
- **In win-probability units:** an own ship weighted 0.3 means losing it for good is as bad as 30% of a win.
- **Base aversion per spend profile** (`profiles.json` → `loss_aversion`): FTP 0.2, casual 0.1, whale 0.02.
  - Scaled by scarcity: (2 rosters of 8 ships ÷ ships owned), clamped to 1–3×.
  - Scaled per ship by its cost relative to the fleet's average.
- **One-sided:** an enemy ship destroyed is worth only what the kill pays.
  - A variant-2 AI kill is worth 1 DEC ≈ 0.01.
  - A PvP kill of a paid ship is worth 0.025 UTC × 0.2.
  - Before, destroying AI ships counted as a gain, which rewarded trading ships.
- **Full weight in finished games:** before, a finished game was valued as 96% win/loss and only 4% ships lost, so search sacrificed ships whenever a win was in reach.
- **Games without a player profile** (training, calibration, benches) use 0.05 for Average and Excellent and 0 for Poor (`tactics.json`).
- **Finding:** also penalizing ships that are merely *at risk* (killable next round) made players retreat almost everything.
  - Excellent's clear rate fell to 12–68%, for almost no ships saved.
  - So `KILLABLE_RISK` is 0. The disabled-ship risk and full terminal weighting are enough.
  - With aversion 0.05, Excellent loses 0.08 ships per campaign game (down from 1.49 with none) and still clears 80%.

**Campaign play-or-skip** (`economy::World::pick_node`):
- Average and Excellent remember each node's record: games, wins, and own ships destroyed.
- They skip an open node when its estimated clear chance, (wins + 1) / (games + 2), is below the player's current aversion × expected ships lost per attempt.
- When every open node is skipped, they farm a completed node instead. Farming is now limited to completed nodes.
- Not done for roguelike runs: their losses were already low (0.02–0.09 ships per game for FTP).

**Excellent searches against the real on-chain AI in PvE** (`MctsParams::model_onchain_ai`, `tactics::ai_reply`):
- The AI is deterministic, so in campaign and roguelike games Excellent's tree no longer searches the AI's replies. It plays each one exactly as `take_ai_turns` would. A strong human learns the AI's behaviour in the same way.
- PvP is unchanged: the opponent is unknown.
- The agent learns about the AI through `Tactician::choose_vs`, which `runner::play_out` calls with the AI's configs.
- Results: campaign clear rate across all 30 nodes, random fleets (Poor composition), same fleets in every row:

| Excellent setting | Clear rate | Own ships destroyed per game | Time |
|---|---|---|---|
| Unknown opponent, no aversion (as in the first run) | 0.567 | 1.87 | 208 s |
| **Models the AI**, no aversion | **0.808** | 1.49 | 109 s |
| Models the AI, aversion 0.05 | 0.800 | 0.08 | 89 s |
| Models the AI, aversion 0.2 | 0.767 | 0.02 | 97 s |
| Models the AI, aversion 0.05, 8-ply look-ahead | 0.822 | 0.07 | 215 s |
| Models the AI, aversion 0.05, 300 simulations | 0.778 | 0.13 | 278 s |

- More simulations still don't help.
- Deeper look-ahead helps a little, for twice the time.
- With random fleets the remaining failures are f05, f06 and partly m13 and f01. The human benchmark will show whether a sensible fleet fixes those.

**Retraining didn't help** (`vt-sim train --from`; weights in `near/sim/weights/iter2/`, not adopted):
- **Fitness changes:** half the campaign games now come from the hardest nodes (`TrainOpts::hard_nodes`), and training ran 150 generations, warm-started from the committed weights.
- **New selection step:** the means at ⅓, ⅔ and the end, plus the starting weights, are each played as Excellent on the campaign, and the best combined score is kept.
- **It picked the ⅓ mean:** Excellent cleared 0.800 against 0.767 for the starting weights, and Average scored 0.53 ±0.06 in PvP against them.
- **On a larger check the new weights didn't win:** 180 Excellent campaign games gave 0.783, against 0.800 for the committed weights. So the committed weights stay.
- **So the gain came from modelling the AI, not from the evaluation.** Its 14 features may be the ceiling. If Excellent still falls short of the human benchmark, the evaluation's features are the next thing to change.

**Calibration anchors Excellent to a strong human** (`calibrate.rs`):
- Excellent is no longer tuned to beat Average by 75%. It takes the shortest leaf look-ahead (from 4, 6 and 8) whose campaign clear rate is within 2 points of the best, so it's as strong as is affordable.
- Average has no knob and is measured.
- Poor's noise is still set so Average beats it 75%.
- The Excellent-vs-Average gap is whatever it comes out as, and it's reported.

**Calibration results** (`near/sim/calibration.json`, 2026-11-17, ~29 min; campaign clear rates use random fleets, 4 per node):

| Excellent look-ahead | Campaign clear rate | Excellent vs Average (PvP) | Time |
|---|---|---|---|
| 4 plies | 0.783 | 0.748 ±0.054 | 253 s |
| 6 plies | 0.800 | 0.800 ±0.052 | 361 s |
| **8 plies (chosen)** | **0.867** | 0.777 ±0.052 | 502 s |

- **Poor's noise:** 0.137.
- **Final ladder (PvP):**
  - Average vs Poor: 0.715 ±0.056;
  - Excellent vs Average: 0.775 ±0.052;
  - Excellent vs Poor: 0.843 ±0.044.
- **Campaign clear rate** with random fleets: Poor 0.117, Average 0.350, Excellent 0.867.
- **The PvE gap between Average and Excellent is now large** (0.35 vs 0.87), because only Excellent models the AI.
- **The PvP gap barely moved,** since the opponent there is unknown.
- **Factorial "wide" variant:** ~~now uses 12 plies, so it still sits above the calibrated 8.~~ 12 plies again after the revert to the 8-ply calibration (2026-11-18).

**Report** (`experiment/report.rs`):
- The pay-to-win flag now covers every pair of spend tiers.
- **New flags:**
  - an archetype ends the economy stage with fewer than 8 ships (`flags.min_final_ships`);
  - a PvP matrix cell has fewer than 50% of its games playable (`flags.matrix_min_played`).
- **New table:** ships destroyed, retreated and disabled at the end, per game, by archetype and mode.
- **Matrix fallback:** each player keeps the strongest hangar they had at the start of any day's play, after claims and purchases (`Player::peak_hangar`). A matrix game whose final hangar can't field a fleet is replayed with peak hangars, and the report counts those games.

### Economy probe (7 days, 1 player per archetype, final iteration-2 settings)

| Archetype | Ships after 7 days | Own ships destroyed per game | Retreated per game |
|---|---|---|---|
| ftp/poor | 0 (of 10) | 0.67 | 0.67 |
| ftp/average | 9 | 0.01 | 2.32 |
| ftp/excellent | 9 | 0.02 | 1.24 |
| casual/average, casual/excellent, whale/excellent | 10–12 | 0.00 | 0.13–0.78 |

- **Average and Excellent free players now keep their ships.** In the first run, the Excellent FTP players ran out by day 49.
- **Poor players still lose everything:** they have no loss aversion by design. The peak-hangar fallback keeps them in the PvP matrix.
- **m02 is a wall for Average players on a starter hangar** (10 claimed ships). This is a balance finding, not a simulator regression.
  - In the probe, ftp/average lost m02 16 times and drew twice, and whale/average lost it 5 times.
  - In the first run, two of the three free Average players needed 82 and 94 attempts. They only cleared it after their second free claim on day 28.
  - Average's campaign clear rate with random fleets is unchanged by loss preferences (0.375 without, 0.367 at aversion 0.2; `--example average_pve`). So the wall comes from the starter hangar and the node, not from the aversion.
- **Speed:** 7 days for 9 players took 874 s. The full iteration-2 run (27 players, 84 days, 8-ply Excellent) should take roughly 9–12 hours.

### New tools
- **`--log-moves`** (any command): match records also carry `start_board` and a `transcript` of every move and the board after it. Off by default, because the files get large.
- **`vt-sim replay <matches.jsonl> (--game N | --node KEY [--losses]) [--every-move]`:** prints a logged game as ASCII boards with move lines and HP/score changes. The board legend is at the top of `src/replay.rs`.
- **`vt-sim human-bench [near/sim/human/bench.json] [--seeds 20] [--aversion 0.05]`:**
  - plays a human's recorded fleets on the same nodes with Excellent;
  - the fleets are rebuilt exactly and placed by the Excellent composer;
  - writes `near/sim/out/human-bench/{results.json,matches.jsonl}`.

  The benchmark sheet for the human side is `docs/sim-human-benchmark-2026-11-17.md`.
- **`--example excellent_pve -- [fleets] [plies] [sims] [aversion] [on|off|both] [killable_risk] [weights]`:** Excellent's campaign clear rate per node.
- **`sim/experiments/iter2.json`:** the same stages and seed as `default.json`, plus the new flags, with its own output directory, so the first run stays for comparison.

### Verification (`crates/vt-sim/tests/iter2.rs`)
- **`modelled_ai_replies_match_the_real_ai`:** over 6 campaign games, every AI reply Excellent's model predicts matches the board the real AI produces in the runner.
- **`loss_preferences_are_one_sided`:** losing an own ship costs exactly its weight; destroying an enemy ship pays only its bounty; without preferences, utility equals the win probability.
- **`careful_players_lose_fewer_ships`:** with aversion 0.3, Average loses fewer than half as many ships as with none, over 60 campaign games.
- **`players_stop_attempting_nodes_that_cost_ships`:** an FTP player with an empty hangar farms a completed node once every open node has cost ships without wins; a whale with 200 ships keeps trying.
- All 19 earlier tests still pass.

### Human benchmark: a roguelike run (2026-11-18)

**The run:** the user played a roguelike run with free ships on Base Sepolia (`near/sim/human/bench*.json`, read from chain with `Game.getGamesForPlayer` and `Ships.getShip`).
- **Path:** m01 → m02 → m03 → m05 → d01 → m06 → m08 → m09 → m10.
- **Result:** 8 wins, then a loss at m10 (Full Court Press) that destroyed 3 ships. The user's own verdict was "too aggressive".
- **Why this stretch matters:** in the first run, simulated runs mostly died between m05 and m09.

**The comparison:** `vt-sim human-bench` replayed each fight with the user's exact fleet, 20 seeds each.
- **Starting HP:** each fight starts at the damage the run carried in. That's computed from the chain's end-of-fight HP with the 80% heal floor and m09's heal to full.
- **Resupply bounds:** the user's repairs at the m04 and m07 resupply stations aren't recorded, so the replay used both bounds, no repair and full repair. The two gave the same results.

| Fight | Human | Excellent with the human's fleet | Excellent ships destroyed / retreated per game |
|---|---|---|---|
| m01–m03 | 3 wins | 100% | 0.00 / 0.00–0.05 |
| m05 | win, 2 retreated | 95–100% | 0.00 / 0.30 |
| d01 | win | 100% | 0.00 / 0.00 |
| m06 | win | 95% | 0.00 / 0.00 |
| m08 | win | 100% | 0.00 / 0.15–0.35 |
| m09 | win, 3 retreated | 100% | 0.00 / 0.50 |
| m10 (started at full HP) | loss, 3 destroyed, 2 retreated | 55% | 0.15 / 3.25 |

**What it shows:**
- **Excellent (modelling the on-chain AI) is now at least as strong as a strong human** on this run. It is no longer the weak player of the first run.
- **One human game at m10 can't show it's stronger.** If later benchmarks put it clearly above humans, add noise to its model of the AI: today it predicts the AI exactly, which no human does. Not done yet.

### Changes from the human's notes (2026-11-18)

The notes are in the conversation of 2026-11-18. Three changes came from them:

1. **Veterans weigh more:** "ships over 1 star should be preserved at a higher rate".
   - An own ship's loss weight is (cost ÷ fleet mean) × (1 + 0.5 × (rank − 1)) (`economy::ship_loss_weight`, `VETERAN_WEIGHT_PER_RANK`).
   - Rank is earned rather than bought, so cost alone missed it.
   - Used by the economy and by `human-bench`.
2. **Roguelike rosters bring repair ships:** "select at least 1 repair ship for the roguelike, 2 is better".
   - Average and Excellent composers include up to `ROGUELIKE_REPAIR_SHIPS` = 2 repair ships when the pool has them (`ComposeCtx::repair_ships`, `compose::ensure_repair`).
   - They swap out the lowest value-per-cost ship and keep its cell. Excellent's search scores single fights, where a repair ship rarely pays, so the rule is applied after its search.
3. **Five evaluation features** (19 in total), the role awareness the human asked about. A durable ship holding a tile is now worth more than a fragile one, and a ship standing where it can be shot without shooting back is penalized.

| Feature | From the notes |
|---|---|
| `exposed`: our ships an enemy can reach next round with no shot of their own | "avoid moving our ships to places they can't shoot an enemy ship, but can be shot by an enemy ship that moves" |
| `outgun`: (our ship, enemy) reach pairs, ours on them minus theirs on us | "make sure at any given time more of your ships can shoot theirs than their ships can shoot yours"; "small locally unfair fights win" |
| `held_hp`: HP of our live ships on live scoring tiles | "repairing a ship on a scoring tile is much more important than damaging an enemy"; "hold scoring tiles at all cost" |
| `repair_live`: operational repair ships, ours minus theirs | "vs faction 1 it's almost always a good idea to focus on enemy repair ships first" |
| `repair_exposed`: our repair ships within enemy reach | "it's critical the healing ship follows this group"; "protect the healer ships" |

**Repair ships** are found from the rules (`eval::set_repair_kinds`): specials with a Repair resolver (variant 1 slot 2, Repair Drones), plus variants whose faction ability is Repair.

**Old 14-feature weights still load** with `Eval::load_mapped`, with the new features at weight 0, so the old player is an exact baseline.

**Retrained with the new features, ~~and adopted~~ then reverted** (2026-11-18, `vt-sim train --from` the iteration-1 weights, 150 generations, 25 min):
- **Selection** kept the final mean.
- **PvP:** Average with the new weights beats the old weights **0.595 ±0.062** head to head, a real gain.
- **Average campaign clear rate:** 0.517 against 0.417 for the previous training, on the same random fleets.
- **Excellent (8 plies, 180 campaign games):** 0.806 with the new weights against 0.817 with the old ones, within noise.
  - The new weights win more of the hard nodes: f01 4/6 against 1/6, m11 6/6 against 3/6, s03 6/6 against 4/6.
  - They win slightly fewer early nodes.
- **Largest new weight:** `held_hp` (+0.47), HP on scoring tiles. That matches the human's "hold scoring tiles at all cost".
- **Odd signs:** some small weights came out with unexpected signs (`repair_live` −0.18, `exposed` −0.09). That's common when features overlap, as noted for Phase 2.
- **Files:**
  - the iteration-1 weights, tactics, calibration and ship values are in `near/sim/weights/iter1/`;
  - the new weights are in `near/sim/weights/eval.json`, and also in `near/sim/weights/iter2b/`;
  - the abandoned 14-feature retrain is in `near/sim/weights/iter2/`.

**Reverted after the human benchmark** (2026-11-18). On the human's own fleets (the 9 roguelike fights, 20 seeds each, carried HP), Excellent with the new weights did worse:

| Setting | Excellent clear rate summed over the 9 fights (max 900) | m09 Interception |
|---|---|---|
| Old weights, 8 plies | ~845 | 100% |
| Old weights, 4 plies | 830 | 100% |
| New weights, 8 plies | 800 | 60% |
| New weights, 4 plies | 715 | 40% |

- **The likely cause:** `held_hp`, the new weights' largest term, pulls ships onto scoring tiles. In Interception the human called the tile "a trap". A per-ship feature can't tell a trap tile from a good one; that needs search or map knowledge.
- **On random campaign fleets the two sets of weights were equal.** So the human benchmark decides.
- **What the committed state is now:**
  - `near/sim/weights/eval.json` is the iteration-1 weights, rewritten under the 19-feature list with the new features at weight 0 (`--example remap_weights`). It plays exactly as before.
  - `tactics.json`, `calibration.json` and `ship_value.json` are restored from `near/sim/weights/iter1/`: 8-ply Excellent, Poor noise 0.137.
  - The benchmark reproduces: 95–100% through m09, 55% at m10.
- **What stays:** the five features remain in the code at weight 0, and the 19-feature weights are kept in `near/sim/weights/iter2b/`.
- **What still applies:** veteran weighting and repair-ship rosters stay. They don't depend on the weights.
- **Next attempt at role awareness:** train against the human-benchmark fights, or make tile features depend on whether the tile can be held. Don't just add weight to holding.

~~Recalibrated with the 19-feature weights~~ (2026-11-18, 26 min; superseded by the revert above, kept for the record):

| Excellent look-ahead | Campaign clear rate | Excellent vs Average (PvP) |
|---|---|---|
| **4 plies (chosen: within 2 points of the best, at about half the cost of 8)** | **0.833** | 0.752 ±0.054 |
| 6 plies | 0.842 | 0.710 ±0.057 |
| 8 plies | 0.850 | 0.705 ±0.059 |

- **Final ladder (PvP):**
  - Average vs Poor: 0.745 ±0.053;
  - Excellent vs Average: 0.680 ±0.059;
  - Excellent vs Poor: 0.818 ±0.049.
- **Campaign clear rate with random fleets:** Poor 0.125, Average 0.458, Excellent 0.833.
- **Average is stronger with the new weights,** so the Excellent-vs-Average gap narrowed.
- **Ship values refit:** held-out accuracy 0.663, log-loss 0.640. Movement is still by far the most valuable stat (+0.475).

**Left to the search, not encoded:** scoring tiles that are traps (Interference, Interception), using chokepoints and nebulae, a low-HP hitter acting early, and checking for a one-shot disable before firing. Excellent's look-ahead and its exact model of the AI should find these. Check them in `vt-sim replay` transcripts.

**For the contract, not the simulator:** in Digging Deeper (roguelike m02), the on-chain AI could have taken the center tile and didn't. Not changed: it needs an AI contract change and a size check.

### Scoring tiles measured against the score still needed (2026-11-18)

**The human's correction:** chasing scoring tiles is always the top priority, except in Interference (m08) and Interception (m09). There the tiles score too little to matter.

**The data agrees:**

| Mission | Max score | Points per round holding every tile | Rounds to win by holding |
|---|---|---|---|
| m01 A Strange Encounter | 15 | 6 | 2.5 |
| m02 Digging Deeper | 28 | 21 | 1.3 |
| m03 Collision Course | 27 | 27 | 1.0 |
| m05 Shocking Revelation | 80 | 24 | 3.3 |
| m08 Interference | 100 | 1 | 100 |
| m09 Interception | 100 | 1 | 100 |

**The flaw:** the evaluation's tile features counted absolute points (`tile_hold`, `tile_reach`), so a 1-point tile looked the same on a 100-point map as on a 15-point map.

**The fix (21 features):**
- two new features measure a tile against the score still needed: `tile_pace` (held) and `reach_pace` (distance-weighted);
- a tile's *pace* for a side is min(1, points ÷ (max score − that side's score));
- `held_hp` is now weighted by pace too;
- `tile_hold` and `tile_reach` are unchanged, so older weights still play exactly as before.

**Training change:** a quarter of the campaign fitness games are now roguelike combat nodes, as single fights with random variant-1 fleets (`TrainOpts::roguelike_share`, `arena::roguelike_fight`). Those maps are where the low-value tiles are, and training never saw them before.

**The human's nine fights stay out of training,** as a held-out check.

**The first iteration-2 run (`iter2`) was stopped** 27 minutes in, partway through the campaign stage, so this fix could go first.

**Results: adopted** (2026-11-19; `near/sim/weights/iter2c/`, now `near/sim/weights/eval.json`):
- **Training** (150 generations, warm-started from the iteration-1 weights) kept the final mean.
  - Excellent campaign clear rate: 0.889 against 0.856 for the starting weights.
  - Average PvP against the starting weights: 0.585 ±0.063.
- **Largest new weight:** `reach_pace` (+0.37). `held_hp`, now pace-weighted, dropped to +0.19.
- **Human benchmark** (the nine roguelike fights, carried HP, 20 seeds each):

| Setting | Clear rate summed over the 9 fights (max 900) | m09 Interception | m10 Full Court Press (human lost) |
|---|---|---|---|
| Iteration-1 weights, 8 plies | ~845 | 100% | 55% |
| 19-feature weights (reverted) | 715–800 | 40–60% | 45–75% |
| **Tile-pace weights, 8 plies** | **875** | **100%** | **75%** |
| **Tile-pace weights, 6 plies (calibrated)** | **850** | **100%** | **75%** |

- **Recalibrated** (`near/sim/calibration.json`, `tactics.json`):
  - Excellent takes **6 plies**: campaign clear rate 0.900, against 0.817 at 4 plies and 0.908 at 8.
  - Poor noise is 0.191.
  - Final ladder (PvP): Average vs Poor 0.760 ±0.054; Excellent vs Average 0.710 ±0.056; Excellent vs Poor 0.820 ±0.046.
  - Campaign clear rate with random fleets: Poor 0.150, Average 0.417, Excellent 0.900.
- **Ship values refit:** held-out accuracy 0.638.
- **Excellent now beats the human's result at m10** (75% against the human's loss) and matches every other fight. That's one human game, so treat it as "at least human level", not "superhuman".

### Free ship top-ups modelled (2026-11-19)

**The contracts** now let any player top back up to 10 live ships with free ships, at any time: `FreeShipClaim.topUpFreeShips` on EVM, `top_up_free_ships` on NEAR. The frontend handoff is `docs/frontend-handoff-free-ship-topup-2026-11-19.md`.

**The simulator mirrors it** with `profiles.json` → `economy.free_topup_floor` = 10. 0 restores the old rules.
- **When players top up:** at the start of each day and before each campaign or roguelike game, since players top up whenever they're short.
- **Stats:** `PlayerStats::ships_topped_up` counts the ships, and the report's economy table has a "Free top-ups" column.

**Why it's modelled:** any new wallet can already claim 10 free ships, so the realistic alternative for a free player who runs out is a fresh account, losing progress. The first run's free players who ended with 0 ships weren't realistic either way.

**Not modelled:** deliberate re-rolling, i.e. losing weak free ships on purpose to top up with fresh rolls. Simulated players don't throw games.

### Iteration 2 full run (`sim/experiments/iter2.json`, finished 2026-11-20)

**Run:** about 14 hours; the report is at `near/sim/out/iter2/report.md`.

**Settings:**
- tile-pace weights, 6-ply Excellent that models the on-chain AI;
- per-player loss preferences, play-or-skip, veteran weighting, repair-ship rosters;
- free top-ups to 10.

**Headline results:**
- **Nobody runs out of ships.** Every PvP matrix cell was played: no unplayable games, and no peak-hangar fallbacks were needed.
  - Free top-ups per player over 84 days: ftp/poor 176 (they lose about 2 ships a day), casual/poor 26, everyone else 0–6.
  - Final hangars: ftp/average 19 ships, ftp/excellent 42.
- **Excellent is now strong.**
  - Campaign: 100% on 25 of 30 nodes, with f01 75%, f04 88%, f05 62% and f06 50% (8 random pools per node).
  - Roguelike: it wins 35 of 40 full runs, against 1 in 40 before iteration 2.
  - Average wins 2 of 40 roguelike runs, and Poor wins none.
- **Skill dominates PvP.**
  - At equal spend, Excellent beats Poor 98–100% and Average 70–88%.
  - Elo: whale/excellent 1981, **ftp/excellent 1845**, casual/excellent 1781, whale/average 1738.
- **Pay-to-win is flagged in places, but it isn't monotone:**

| Skill | Whale vs FTP | Casual vs FTP | Whale vs Casual |
|---|---|---|---|
| poor | 0.78 ±0.10 | 0.45 ±0.11 | 0.71 ±0.11 |
| average | 0.86 ±0.08 | 0.70 ±0.10 | 0.64 ±0.11 |
| excellent | 0.69 ±0.11 | 0.38 ±0.11 | 0.78 ±0.09 |

- **Why excellent free players do so well:** they play far more games, reach storefront tier 8 (casual 6, whale 7) and earn the medal as often as casual players. That's why they beat casual players at excellent skill.
- ~~**Campaign walls for Average players:**~~
  - ~~m13 is 0%, between 88% at m12 and 100% at m14. That's a spike out of order with its neighbours.~~
  - ~~d04 is 62% and s03 is 38%.~~
  - ~~f01 is 12%, and f03–f06 are 0%.~~
- ~~**The medal (f06)** goes almost only to Excellent players: 67% of free and casual, 100% of whales. Among Average players only whales get it (33%). So variant 2 stays locked for most players.~~
- _2026-11-20: the two items above are void. The single-player campaign is a stub, so its nodes and its medal node say nothing about the game. See "Iteration 3"._
- **Part prices**, with the same caveat as before (Average-vs-Average play, no deliberate tanking):
  - speed, ship count, v1 special 2 and v2 special 3 (+119 against a price of 10) are underpriced;
  - medium and heavy armor and v2 shields are overpriced, though heavy armor is less extreme than in the first run (−51 against −111).
- **Unkillable AI configs:** v2turtle5 and v2support were never destroyed in 120 appearances each, and v2sniper2 in 24.
- **Composition vs tactics** (calibrated variant): tactics 78%, composition 20%.

## Iteration 3: roguelike missions only (2026-11-20)

**Why:** the single-player campaign in `singlePlayerStarterContent.json` is a stub. Every finding before this date that came from its nodes (campaign difficulty, campaign walls, the medal at its node f06, campaign-trained weights' hard nodes) is void. Only the roguelike campaign matters.

**The live graph (Base Sepolia, read 2026-11-20):**
- The content file matched the chain exactly: 35 nodes, same children and scores.
- Only 18 nodes can be reached from mission 1. The 17 others (unnamed combat stubs d02–f06 and resupply stubs r03–r05) were deleted from `roguelikeStarterContent.json`, with their edges. They are still on chain, unreachable. The 22 roguelike maps no reachable mission uses were left in place.
- The graph has three two-way branches, so 8 paths from mission 1 to an ending:
  - after 5. Shocking Revelation: 17. Repair Station DS7 or 16. Sneak Attack, both rejoining at 6. Counterattack;
  - after 9. Interception: 10. Full Court Press, or 12. The Long Road → 13. Highway 50 → 14. End of the Line;
  - after the last resupply: 11. The Hive: Dominance or 15. The Hive: Alliance.
- Most missions field variant-2 AI, so runs are the DEC source. Missions 1–3, 8. Interference, 10. Full Court Press and 15. The Hive: Alliance field variant 1.
- **On Base Sepolia the medal is still tied to the stub campaign** (`ShatteredHiveMedal.finalNodeId` = stub node 30). The simulator models the medal as winning a run at either Hive ending.

**Simulator changes:**
- The mission list is now the reachable roguelike combat missions. Each is a single fight at full HP under the cost cap a run has when it gets there (600, 800 after the first resupply, 1000, 1200). Single-fight stages, training, calibration and benches use it. Unreachable nodes are dropped on load.
- **Economy:** players no longer play campaign games. That share of play moved to roguelike runs, and a run uses one game slot per fight. Players choose every branch themselves. Runs bounty variant-2 AI kills (DEC).
- **Roguelike stage:**
  - player's-choice runs, plus a branch-choice table;
  - `runs_per_path` forced runs per level on each of the 8 paths, so every path is measured whatever players prefer;
  - a per-mission table with damage carried in.
  - A forced run that loses early still never sees the later missions on its path. The single-fight table covers every mission regardless.
- **Reports** name missions by node id and title ("6. Counterattack").
- **Move generator bug fixed:** a ship's faction ability on itself after moving (for example a repair ship repairing itself on a scoring tile) was pruned from search, because its range was measured from the cell the ship had left. It came to light when the generator test started sampling the roguelike maps.
- `sim/experiments/iter3.json`: iter2's settings plus 10 forced runs per path per level.


### Iteration 3 full run (`sim/experiments/iter3.json`, finished 2026-11-21)

Recalibrated on the 15 reachable missions first: Poor noise 0.164 and Excellent at 6 plies. Excellent clears 92% of single missions, Average 45% and Poor 17%. The run took 11.2 h. Report: `sim/out/iter3/report.md`.

**Roguelike runs** (player's choice, 40 per level):
- **Excellent** wins 38/40. It goes 16. Sneak Attack 29 times out of 40, takes 12. The Long Road 38/39 and always ends at 11. The Hive: Dominance.
- **Average** wins 3/40, with 3.5 combats per run. Win rates per attempt with damage carried in:
  - 3. Collision Course: 66%
  - 5. Shocking Revelation: 54%
  - **6. Counterattack: 33%** (25% as a single fight, down from 62% for the mission before it)
  - 17. Repair Station DS7: 33%. Average never picks it; it takes 16. Sneak Attack (79%).
  
  Past 9. Interception, Average won every attempt, but only 3 runs got that far.
- **Poor** stops at **2. Digging Deeper**: 10% per attempt, 1.05 combats per run.

**Every path** (10 forced runs per level per path):
- Excellent wins 10/10 on both paths through 17. Repair Station DS7 that end at 11. The Hive: Dominance.
- Every path ending at **15. The Hive: Alliance** is 5–7/10. It's the hardest mission: 50% for Excellent as a single fight, 61% per attempt in runs, and 0% for Average.
- **10. Full Court Press** is 0% for Average and 88% for Excellent. Excellent avoids it: 1 choice in 39.
- Average and Poor win no forced run on any path.

**Economy (84 days):**
- Every Excellent player gets the medal. So do 1 of 3 FTP/Average and casual/Average players, and 2 of 3 whale/Average.
- **FTP/Poor:**
  - loses 110 ships and ends at exactly the 10-ship top-up floor, after 90 free top-ups;
  - the top-up isn't deployed (see "Free ship top-ups modelled"), so on today's contracts this player runs out of ships.
- **Whale/Poor** loses 150 ships.
- Average and Excellent lose few ships.

**PvP:**
- Skill still dominates: ftp/excellent is #2 by Elo at 1824, behind whale/excellent at 2032.
- But the pay-to-win flag fires at every skill level:
  - whale vs FTP: 66% at Poor, 89% at Average, 80% at Excellent;
  - whale vs casual: 88% at Excellent.
- Casual/Excellent scores only 38% against FTP/Excellent. FTP plays more runs and ends with more fleet power (4.18 against 4.00).

**Other flags:**
- **AI configs never destroyed:** grunt, aggressor, aiConfig13, aiConfig22, v2turtle and v2sniper5. aiConfig12, aiConfig14 and aiConfig61 deal almost no damage.
- **Prices:**
  - armor and v2 shields have negative value at any price;
  - speed and v1 Light shields are underpriced;
  - v2 special 3 plays like 131 points against a price of 10.
- **Composition vs tactics** (calibrated variant): tactics account for 80%.

Recommendations from this run: `docs/balance-recommendations-2026-11-21.md`.

### Damage-aware exposure feature (2026-11-24): armor's negative value is the rules, not the players

**The question:** the iteration-3 price fit put armor and v2 shields at negative value at any price. Was that the simulated players misusing protected ships, or the trade-off in the rules? Nothing in the tactics code knows about armor or shields; they reach it only as damage reduction, through `threat`, `killable` and the search. `exposed` counted a heavily armored ship in enemy reach the same as an unprotected one.

**The feature (22 features):** `exposed_dmg`. Each of our ships an enemy can reach next round, with no shot of its own, weighted by min(1, the damage the enemies reaching it would deal after its damage reduction ÷ its HP). Negated, like `exposed`. Test: `exposed_damage_accounts_for_damage_reduction` (`tests/phase2.rs`).

**Retrained** (`vt-sim train --from` the iteration-3 weights, 150 generations, 21 min; `near/sim/weights/iter4/`):
- Selection kept the generation-100 mean.
- **Excellent** single-mission clear rate: 0.844, against 0.889 for the starting weights.
- **Average PvP** against the starting weights: 0.562 ±0.064, within noise.
- `exposed_dmg` came out at **−0.07**, the opposite of the intended sign. `exposed` is near 0. The two overlap, and training didn't find a use for the distinction.

**Price fit, same seed and 20,000 games** (`sim/experiments/iter4-prices.json`). The old weights reproduce iteration 3 exactly, so the new feature at weight 0 changes nothing.

| Entry | Price | Fair price, old weights | Fair price, new weights |
|---|---|---|---|
| v1 armor Light / Medium / Heavy | 5 / 10 / 15 | −7 / −33 / −59 | −13 / −31 / −65 |
| v2 armor Light / Medium / Heavy | 5 / 10 / 15 | −11 / −39 / −94 | −9 / −35 / −84 |
| v1 shields Light / Medium / Heavy | 10 / 20 / 30 | 24 / 17 / 0 | 22 / 15 / −12 |
| v2 shields Light / Medium / Heavy | 10 / 20 / 30 | −16 / −41 / −60 | −3 / −29 / −60 |

Every change is within about 2 standard errors, and none turns positive.

**Human benchmark** (the 9 fights, 20 seeds, 6 plies): identical everywhere except 10. Full Court Press, where the new weights win 90% and the old ones 70%. That's 18/20 against 14/20, not significant.

**Not adopted.** `near/sim/weights/eval.json` is the iteration-3 weights, remapped to the 22-feature list with `exposed_dmg` at weight 0, so it plays exactly as before. The iteration-3 files are backed up in `near/sim/weights/iter3/`.

**What this says about armor:** the armor table in `near/seed/config.json` explains the fitted values without blaming the players.
- **No armor gives +1 movement.** So every armor tier costs at least 1 movement against the baseline: Light 1, Medium 2, Heavy 3 (v1) or 4 (v2).
- **v1 Light shields give +1 movement and 15% damage reduction:** the only protection that adds speed. They're also the only protection that fits as underpriced.
- The fit values +1 speed at 33–44 points. Fitted armor and shield values track the movement each tier costs, not the damage reduction.

~~So it's a mechanics problem, as `docs/balance-recommendations-2026-11-21.md` section 7 suspected.~~ Retracted the same day: see the next section. The price fit's games are 3–4 round sprints, which favour speed regardless. Pricing alone can't fix it, because the price would have to go negative. Options: smaller movement penalties, no +1 movement for going without armor, or more damage reduction per tier. Each can be checked with this price-fit experiment (10–15 min) before anything changes on chain.

### Do simulated players use ships by role? (2026-11-24)

**The question (human):**
- a fast ship with a short-range, high-damage gun raids an enemy-side tile from a weak enemy ship;
- a fastish ship with high damage reduction races to and holds the center;
- a slow, heavy ship with high damage reduction sits on home objectives.

Do the agents play like that?

**Measured with `--example ship_roles [level] [games] [max_score]`.** Same-level PvP on random fleets and maps, recording where each operational ship stands at every round boundary. A tile's zone for a side is d_own ÷ (d_own + d_enemy) from the two deployment centroids: home < 0.4, center 0.4–0.6, enemy > 0.6 (`--example pvp_map_zones`). The roles:
- **raider:** movement in the top third (> 5), range ≤ 3, gun ≥ 60;
- **fast tank:** movement ≥ 4, damage reduction ≥ 30;
- **heavy:** movement in the bottom third (≤ 3), damage reduction ≥ 30.

**At the setting every PvP game in the simulator uses (max score 30: training, calibration, the price fit):**
- Games last **2.7–4.6 rounds** and 90–100% end on score. One or two 13-point home tiles held for 2–3 rounds wins.
- **No ship at any level ever stood on an enemy-side tile:** 0 of about 30,000 ship-rounds.
- Heavies spend 2–3% of rounds on any tile; raiders 12–17%.
- There's no time for roles: the game is a race to the nearest tiles.

**At max score 200** (9–13 rounds). Share of rounds on any tile, and the home / center / enemy split of those rounds:

| Role | Poor | Average | Excellent |
|---|---|---|---|
| raider | 20%: 44 / 53 / 3 | 32%: 53 / 42 / 5 | 13%: 32 / 64 / 5 |
| fast tank | 18%: 54 / 44 / 3 | 28%: 48 / 49 / 2 | 20%: 42 / 56 / 2 |
| heavy | 11%: 71 / 29 / 1 | 15%: 60 / 39 / 1 | 11%: 61 / 37 / 2 |

- **Heavies lean home and fast ships lean center at every level, Poor included.** That's mostly speed: a slow ship only reaches the near tiles. It isn't deliberate role play.
- **Nobody raids:** at most 5% of a raider's tile time is on an enemy-side tile.
- **Nobody anchors:** heavies are on any tile only 11–15% of the time.
- **Excellent at 200 mostly fights:** 58% of its games end by elimination.

**Why:** the evaluation and the search were trained and tuned only on max-score-30 sprints and the roguelike missions. In a sprint, holding home tiles fast is the whole game, so the tile features never had to learn zones or roles.

**Consequence:** the armor and shield prices and the "speed is worth 33–44 points" figure both come from the sprint format, and say little about longer games. Before any price conclusion:
1. Find out the max score real PvP lobbies use: players choose it at lobby creation.
2. Rerun the price fit at that setting, which needs a `max_score` option in the components stage (it's hard-coded to 30). If it's long, train and calibrate there too.

### Standard PvP match (2026-11-24)

**The human's standard match:** map id 70, first to 100 points, threat (cost) cap 1000 or 2000. Map ids are assigned in a chained order: single-player maps 1–30, roguelike maps 31–66, PvP maps 67–72. So map 70 is **`pvp04`**: five 10-point tiles, one home tile per side and three in the center.

**The simulator now plays only that match in PvP** (`arena::STANDARD_PVP_MAP`, `STANDARD_PVP_MAX_SCORE`, `STANDARD_PVP_CAPS`):
- `Content::pvp_maps` holds only `pvp04`; `pvp_maps_all` keeps all six for move-generator coverage.
- Max score 100 everywhere. It was 30 in training, calibration, the price fit, the composition benches and `profiles.json`.
- Caps 1000/2000 everywhere. They were 500–2000 in places; the economy's PvP brackets are now [1000, 2000].
- The tests are updated, and the whole sim suite passes.

**Role check on the standard match** (Average, 400 games, `--example ship_roles average 400`):
- Matches last 5.1 rounds, and 98% end on score. It's a race for the three center tiles.

| Role | On a tile | Home / center / enemy, of tile rounds |
|---|---|---|
| raider | 30% | 34 / 65 / 2 |
| fast tank | 25% | 39 / 60 / 1 |
| heavy | 12.5% | 65 / 35 / 0 |

- Fast ships go for the center, and the little time heavies spend on tiles is mostly home.
- But heavies are on a tile only 12.5% of rounds, so they don't anchor home.
- Retrained weights (below) give the same picture.

**Price fit on the standard match.** Fair prices; each tier's movement change against no armor or shields is in brackets:

| Entry | Price | Old format (score 30, 6 maps) | Standard, current weights | Standard, retrained |
|---|---|---|---|---|
| v1 armor Light / Medium / Heavy (−1 / −2 / −3) | 5 / 10 / 15 | −7 / −33 / −59 | **19 / 12** / −48 | **14** / −3 / −70 |
| v1 shields Light / Medium / Heavy (+1 / 0 / −1) | 10 / 20 / 30 | 24 / 17 / 0 | **31 / 51 / 20** | 31 / 44 / 2 |
| v2 armor Light / Medium / Heavy (−1 / −2 / −4) | 5 / 10 / 15 | −11 / −39 / −94 | 7 / −26 / −114 | 10 / −32 / −135 |
| v2 shields Light / Medium / Heavy (0 / −1 / −2) | 10 / 20 / 30 | −16 / −41 / −60 | 0 / −41 / −86 | 18 / −23 / −99 |
| Speed +1 / +2, v1 | 10 / 25 | 33 / 64 | 33 / 47 | 39 / 63 |
| Speed +1 / +2, v2 | 10 / 25 | 40 / 84 | 46 / 87 | 45 / 95 |
| v2 special 3 | 10 | 131 | 115 | 131 |

- **The format mattered for light and medium protection.** On the standard match, v1 Light armor and v1 shields at every tier are worth their price or more. Medium v1 shields come out about 2.5× their price.
- **Heavy tiers are still strongly negative,** worst for v2 Heavy armor (−4 movement). A protection tier's fitted value tracks how much movement it costs.
- **Unchanged:** speed is still underpriced, and v2 special 3 is still about 115–131.

**Retrained on the standard match** (`near/sim/weights/iter5/`, 150 generations, 36 min; not adopted):
- Selection kept the generation-50 mean.
- Excellent single-mission clear rate: 0.867, against 0.889 for the current weights.
- Average PvP against the current weights, on the standard match: 0.575 ±0.068.
- Adopting needs the human benchmark, `calibrate` and `fit-values` first.

**Revised armor conclusion:**
- ~~Armor is negative because the price fit plays 3-round sprints~~: it's partly the format. Light and medium protection is fine on the standard match.
- The heavy tiers' movement penalties (−3/−4 armor, −2 v2 shields) cost more than their damage reduction is worth.
- That holds with players who still don't anchor heavies on objectives. It's an open question whether a human who parks a heavy ship on the home tile gets more from it.

### Roles and varied training opponents (2026-11-25)

**The question (human):** why can't the agents come up with a strategy like parking a heavy ship on the home objective?

**The reasons:**
- Search sees less than half a round ahead: a ply is one ship's move.
- The evaluation can't tell a good holder from a bad one.
- Nobody raids, so home never needs defending.
- Fleet choice and play are separate.

**Option 2: roles in the evaluation (27 features).**
- `eval::role_ships` gives each side an **anchor** and a **raider**, from fixed ship stats so the choice is stable through a game:
  - anchor: the most durable operational ship, max HP / (1 − damage reduction), slower first;
  - raider: the fastest other ship, more damage first.
- Tiles are home, center or enemy by column (`eval::zone_of`). Every one of the 72 maps deploys the creator left and the joiner right (`--example zone_orientation`).
- **New features:**
  - `anchor_hold` and `anchor_reach`: the anchor on, or heading to, a home tile;
  - `raider_hold` and `raider_reach`: the raider on, or heading to, an enemy-side tile;
  - `home_pressure`: enemy ships that can reach our home tiles (negated).
- The reach features are linear (1 − d/26). With 1/(1 + d), a styled raider never set out toward a tile about 12 columns away.
- Test: `role_ships_pick_the_most_durable_anchor_and_fastest_raider`.
- `ANCHOR_SLOWEST=1` ranks anchors slowest first, for the experiment below.

**Option 3: styled training opponents** (`TrainOpts::style_opponents`, on by default).
- PvP fitness scenarios rotate between the incumbent, its raider style and its anchor style (`eval::styled_weights`: the incumbent plus `STYLE_STRENGTH` = 1.0 × its norm on that role's hold and reach weights).
- **Checked before training** (Average, standard match, 400–600 games):
  - The **anchor style** parks its anchor: 96% of its tile time is on the home tile, against 53% unstyled.
  - The **raider style** barely raids: 2–6% of its tile time is on an enemy-side tile. On `pvp04` that tile is the enemy's home tile, inside their deployment zone. An enemy ship holds it 84% of rounds, and it's about 11 tiles from the raider's start.
  - Crossing takes about 2 rounds and disabling the holder 2–3 more, while matches last about 5 rounds and are decided in the center first.

**Trained** (`near/sim/weights/iter6/`, 150 generations, 24 PvP scenarios per generation, 48 min). Selection kept the generation-100 mean.

Learned role weights:

| Feature | Weight |
|---|---|
| `anchor_hold` | −0.21 |
| `anchor_reach` | +0.07 |
| `raider_hold` | +0.03 |
| `raider_reach` | −0.05 |
| `home_pressure` | −0.06 |

- **The trained player avoids anchoring.** Its anchor spends 37% of its tile time at home, down from 53% before training.
- Its most durable ships go to the center instead: fast tanks spend 63% of their tile time there.

**Head to head** (Average, standard match, 600 games, sides swapped):

| A | B | A's score |
|---|---|---|
| Role-trained | Current | **0.568** |
| Anchor style (most durable) | Current | 0.460 |
| Anchor style (most durable) | Role-trained | 0.416 |
| Anchor style (slowest, `ANCHOR_SLOWEST`) | Current | 0.503 |
| Anchor style (slowest) | Role-trained | 0.387 |
| Raider style | Current | 0.462 |
| Raider style | Role-trained | 0.407 |

**Conclusion:** on the standard match, against these opponents, parking a heavy ship on the home tile doesn't pay.
- Nobody comes for the home tile, so any ship scores the same 10 points there.
- A slow anchor takes 2–3 of the match's roughly 5 rounds just to arrive.
- The most durable ship is worth more fighting for the three center tiles.
- Raiding the enemy home tile is too slow on this map.
- **Untested:** whether human opponents leave openings that make raiding pay, and therefore home defence too. Human games of this match would settle it.

**Price fit with the role-trained weights:**
- v2 Heavy armor −96 and v2 Heavy shields −53, against −114 and −86 with the current weights. The heavy tiers are still strongly negative.
- v1 Light/Medium armor and v1 shields stay at or above their price.

**Human benchmark:**
- 10. Full Court Press 50%, against 70% for the current weights.
- 6. Counterattack 95%.
- Everything else 100%.

**Not adopted:**
- Excellent's single-mission clear rate fell to 0.844 from 0.889.
- 10. Full Court Press fell to 50% on the human benchmark.
- `near/sim/weights/eval.json` is the iteration-3 weights, remapped to the 27 features with every new one at 0, so it plays exactly as before.
- The features and styled training stay in the code. The full sim suite passes.

### Movement clamps and slow ships on home (2026-11-25)

**Question:** is the movement range (1–7 v1, 1–9 v2) the reason heavy armor and shields price negative?

**Method:**
- `VT_SIM_MOVE_CLAMP=lo,hi` is a simulator-only switch (`src/rules.rs`). It clamps every ship's final movement.
- A price fit was run for each clamp on the standard match. Each fit is 20,000 Average-vs-Average games with the current weights.

**Fair prices** (current costs: Light/Medium/Heavy armor 5/10/15, shields 10/20/30):

| Entry | On-chain | Clamp 3–9 | Clamp 1–6 | Clamp 3–6 |
|---|---|---|---|---|
| v1 Heavy armor | −48 | 19 | −52 | 18 |
| v1 Heavy shields | 20 | 27 | 16 | 28 |
| v2 Medium armor | −26 | 23 | −29 | 15 |
| v2 Heavy armor | −114 | −2 | −112 | 4 |
| v2 Medium shields | −41 | 17 | −36 | 22 |
| v2 Heavy shields | −86 | 13 | −80 | 13 |
| v1 speed tier 2 | 47 | 14 | 49 | 18 |
| v2 speed tier 2 | 87 | 33 | 85 | 33 |
| v2 special 3 (+3 move) | 115 | 55 | 112 | 44 |

**Conclusion:** the minimum speed is the problem, not the maximum.
- A movement floor of 3 brings every heavy tier back to roughly fair or positive. It also roughly halves how much speed is underpriced.
- A ceiling of 6 changes almost nothing.
- Fix options: raise `MIN_MOVEMENT` to 3, or soften the heavy tiers' movement penalties so that heavy builds don't drop below 3.

**Slowest ship deployed on its home tile** (`DEPLOY_SLOW_HOME=1 ship_roles`):
- Average vs the same weights, 600 games: 0.554.
- Control with the fastest ship on home: 0.482.
- Against the role-trained `iter6` weights: 0.454. `iter6` itself beats the current weights 0.568, so this is a gain against it too.
- Excellent vs Excellent, 100 games: 0.540.
- So putting slow ships on home is a real but modest gain, about 5 points. Deployment currently doesn't do it.

### Purpose deployment (2026-11-25)

**What it is:** from the human: "each ship needs to be placed with a purpose in mind". `src/purpose.rs` gives every ship one of four purposes, from fixed stats:
- **Home:** every ship of speed 1–2, or else the slowest ship in fleets of 3+.
- **Rush:** the fastest remaining ship of speed 5+, at most one.
- **Support:** long-range guns and repair specials, at most one per Center or Rush ship, each paired with one of them.
- **Center:** the rest.

The ships deploy to match their purpose. `composition::place::heuristic_cells` now does this for Average and Excellent. The old range-based placement is kept as `range_cells`.

**Who deploys second:** on chain, the first fleet submitted moves first and can be read from contract state before the second one goes in. So the second deployer sees the first fleet's ships and cells:
- Placement avoids cells where the first fleet can disable a ship in one move.
- The Rush ship heads for the least defended enemy tile.
- Excellent's ship-and-cell search plays its candidates against the actual first fleet (`Foe::Known`).
- The economy, the composition benchmark, the price fit, the value-model fit and the training scenarios all deploy the creator first and the joiner second.

**Placement alone, current weights** (`--example purpose_play`, standard match):

| A deploys | B deploys | Average (600 games) | Excellent (100 games) |
|---|---|---|---|
| by purpose | old range-based placement | 0.713 | 0.585 |
| by purpose | at random | 0.644 | 0.610 |
| old range-based placement | at random | 0.410 | |

The old placement lost to random placement, and Average and Excellent players used it in every earlier economy run and price fit.

**Human benchmark, current weights:** with Excellent's placement search starting from purpose deployment, 10. Full Court Press goes to 85% (was 70%) and 9. Hive Outpost to 100%.

**Retraining** (`vt-sim train --purpose`):
- 150 generations, with seven new purpose features plus purpose-styled opponents and purpose deployment, joiners seeing the first fleet.
- Selection kept the starting weights: the final candidate's Excellent campaign clear rate fell to 0.800, from 0.889.
- The final candidate (`sim/weights/iter7/eval-final.json`):
  - beats the current weights in PvP: 0.615 ± 0.020 (Average, 600 games) and 0.650 ± 0.048 (Excellent, 100);
  - is weaker on the human benchmark: 6. Counterattack 85%, 9. Hive Outpost 80% and 10. Full Court Press 70%, against 95%, 100% and 85% for the current weights;
  - learned positive `support_cover`, `home_reach` and `center_reach`, and negative `rush_*` and `raider_*`: rushing doesn't pay on the standard match.
- Not adopted. `eval.json` is unchanged; the purpose features are at weight 0.

### Playing against the bots (2026-11-25)

`vt-sim play` plays the standard match (map 70 `pvp04`, first to 100) in the terminal against a simulated player, on the simulator's engine (the same rules as on chain):

```sh
cd near
./target/sim/vt-sim play [--level poor|average|excellent] [--side creator|joiner] [--seed N] [--cap 1000|2000] [--weights PATH]
```

- Defaults: Excellent, you as the creator (first to move, deployed left), a new seed each time (printed, so a game can be replayed), cap 1000 or 2000 drawn at random.
- Fleets are random, as in training and the price fit; both are deployed by purpose, the joiner seeing the creator's fleet. The roster shows each ship's assigned purpose.
- Commands: `A` shows ship A's reachable cells and every legal shot (from where, and the target's HP afterwards); `A 5 3 shoot b`, `A 5 3 special x`, `A 5 3 ability x`, `A pass`, `A retreat`; `hint` asks the same bot what it would play; `ships`, `board`, `help`, `quit`.
- `#` cells block line of sight only; ships can move through them.
- Not yet: choosing your own fleet or placing it by hand.

### Price fit with purpose deployment (2026-11-25)

Both fits use `sim/experiments/iter4-prices.json` (20,000 Average-vs-Average games, standard match) with purpose deployment, under on-chain rules (`sim/out/purpose-prices-onchain`) and with `VT_SIM_MOVE_CLAMP=3,9` (`sim/out/purpose-prices-3-9`). The full table and suggested prices are in `docs/balance-recommendations-2026-11-21.md` §7.

- On-chain: v1 is close to fair (Heavy armor −2, up from −48 with the old placement). v2 Medium/Heavy armor and shields are still negative (Heavy armor −72, Heavy shields −39), and v2 speed (35 / 66) and v2 special 3 (85) are underpriced.
- Minimum movement 3: every armor and shield tier is fair or underpriced, v2 speed is fair, v2 special 3 falls to 36, and v2 Missile becomes fair (11).
- Both: extra ships underpriced (~115–127 vs 75); v1 accuracy, hull tier 2, v1 specials 1 and 3 and v2 special 1 overpriced.

### Minimum movement raised to 3 (2026-11-26)

`MIN_MOVEMENT` is now 3 in `contracts/ShipAttributes.sol` and `near/crates/vt-core/src/attributes.rs` (the simulator and the NEAR contract both use `vt-core`), so the simulator's default rules now match the `VT_SIM_MOVE_CLAMP=3,9` fits; that switch is only needed to try other clamps. Not deployed to either chain yet. `near/golden/generation.json` was re-exported from Solidity (39 of 614 ships changed movement).

### New prices and roguelike caps (2026-11-26)

The suggested prices and 25% higher roguelike caps are applied in code (details and old values: `docs/balance-recommendations-2026-11-21.md` §7). The simulator reads both from `near/seed/config.json` and `ignition/data/roguelikeStarterContent.json`, so every run from now on uses them. Results from earlier runs (price fits, calibration, the value model in `fit-values`, economy runs) used the old prices and should be redone before relying on them.

### Roguelike stage, new vs old prices (2026-11-26)

`sim/experiments/prices-rl.json` (the iter3 roguelike stage alone: 40 runs per level plus 10 per forced path), current code (min movement 3, purpose placement, current weights) both times; only prices and caps differ. Old prices and caps were loaded with `VT_SIM_OVERRIDE` (a simulator-only data-file switch added for this). Runs: `sim/out/prices-rl-new`, `sim/out/prices-rl-old`.

| Level | Combats won per run (old → new) | Runs won of 40 | Ships lost per run |
|---|---|---|---|
| Poor | 1.18 → 1.02 | 0 → 0 | 0.4 → 0.3 |
| Average | 4.47 → 3.62 | 2 → 0 | 0.1 → 0.6 |
| Excellent | 11.95 → 11.30 | 38 → 34 | 0.1 → 0.1 |

Biggest per-mission drops: Average on 5. Shocking Revelation 62% → 47% and 8. Interference 64% → 40%; Excellent on 15. The Hive: Alliance 50% → 33% and 10. Full Court Press 79% → 71%. The 25% cap rise keeps the human's own fleets, but the composer's best fleets under the old prices were wider (a bare ship cost 75, now 120), so they lose a ship or two. The new prices with these caps make the roguelike harder, mostly for Average players.

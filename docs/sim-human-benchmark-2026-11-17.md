# Human benchmark for the balance simulator

_Written 2026-11-17, for iteration 2 of the balance simulator (`docs/balance-simulator.md`)._

**Why:** the simulator's best player ("Excellent") is supposed to play as well as a strong human. You are the reference. Your results on the nodes below set its target. Afterwards, `vt-sim human-bench` plays **your exact fleets** on the same nodes, 20 times each with different seeds, so the two are compared fleet for fleet.

## How to play it

- **Fleet:** use whatever ships you have, and don't optimize the fleet. A careless fleet is the point, since that's the claim we're testing.
  - Stay under the node's cost cap. Anything under it is fine.
- **Play:** as you normally would, including retreating ships you want to keep.
- **Placement:** use your own. You don't need to record it.
- **Network:** any network with the campaign deployed (Base, Base Sepolia or NEAR testnet). Note which one, so I can read your ships' traits from it.
- **Attempts:** one per node is enough, and two is better. Log every attempt, including losses. Don't log only your best try.
- **Locked nodes:** play the ones you have unlocked. Partial results are still useful.

## Nodes

These are where the simulator struggled most in the first run. A clear rate is the share of games won.

| Node | On-chain id | Cost cap | Max score | Unlocked by | Simulator's Excellent clear rate (first run) |
|---|---|---|---|---|---|
| m07 | 7 | 710 | 51 | m06 | 0 of 3 with random fleets (iteration 2 probe) |
| m11 | 11 | 860 | 76 | m10 | 1 of 3 (iteration 2 probe); Average 38% |
| m13 | 13 | 930 | 88 | m12 | 38% |
| d04 | 19 | 790 | 64 | d03 | 88% (Average 25%) |
| s03 | 24 | 1200 | 120 | s02 | 75% |
| f01 | 25 | 1330 | 133 | m15 and s03 | 12% |
| f03 | 27 | 1600 | 160 | f02 | 38% |
| f05 | 29 | 1870 | 187 | f04 | 12% (0 of 3 in iteration 2 probes) |
| f06 | 30 | 2000 | 200 | f05 | 25% (0 of 3 in iteration 2 probes) |

## What to record per attempt

Fill one row per attempt. The ship ids are enough: I'll read each ship's traits and equipment from chain.

| Node | Network | Ship ids fielded | Result (win / loss / draw) | Rounds (roughly) | Own ships destroyed | Own ships retreated | Notes (what decided it) |
|---|---|---|---|---|---|---|---|
| | | | | | | | |

**Notes:** useful things to write down:
- Tricks you used against the AI, such as baiting it, holding a tile, focusing fire, or exploiting how it picks targets.
- Whether the fleet felt over- or under-powered for the node.

These tell me what the simulated player is missing, if it still falls short.

## What happens with the results

1. I convert the table to `near/sim/human/bench.json`.
2. `vt-sim human-bench near/sim/human/bench.json` plays each recorded fleet on its node with the iteration-2 Excellent player, over 20 seeds.
3. The target is that Excellent's clear rate on your fleets comes close to yours, with no more ships lost. If it falls short on a node, I review that node's games with the new `vt-sim replay` transcripts, compare them to your notes, and work on that gap next.

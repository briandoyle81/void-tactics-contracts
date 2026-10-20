# Roguelike Enemy Progression

**Written: 2026-09-21.** Describes the roguelike campaign's enemy progression as seeded by `ignition/modules/DeployAndConfig.ts` from `ignition/data/roguelikeStarterContent.json`. Re-verify against those files if they have changed since.

**Update (2026-09-23):** the map-redesign pass gave every roguelike Combat node its own dedicated map (not just the first five) — see "How it is built" below, rewritten for this. The mission → variant rule itself, and everything under "Things to know", are unaffected.

**Update (2026-10-20):** the story is being rewritten and the seed files are the source of truth while it is. In the current seed, a new `m05 → d01` edge makes `d01` ("Sneak Attack") mission 5, and through it `s01` (reached from `d03`) mission 8; both keep their variant 1 rosters. `test/RoguelikeProgression.test.ts` exempts them by key (`RULE_EXEMPT_NODE_KEYS`) rather than failing; remove them from that list once the story settles. The mission 3 row below predates this.

## The rule

**The first three missions on any path fight variant 1 ships. Every later mission fights variant 2.**

A node's **mission number** is the number of *Combat* nodes on the path from the root to it, inclusive (Resupply nodes don't count). Because the graph branches, "mission 3" is a set of nodes:

| Mission | Nodes | Enemies |
|---|---|---|
| 1 | `m01` | variant 1 |
| 2 | `m02` | variant 1 |
| 3 | `m03` (main spine), `d01` (dead-end branch), `s01` (shortcut branch) | variant 1 |
| 4 and beyond | everything else — `m04`…`m15`, `d02`…`d06`, `s02`, `s03`, `f01`…`f06` | variant 2 |

The player's side is unchanged: the roguelike campaign requires variant 1 ships (`requiredVariant: 1`), so the first three missions are variant 1 against variant 1, and from mission 4 on the enemy is the heavier variant 2.

## How it is built

Enemy rosters are attached **per map id** (`AIEncounters.setMapPlacements`), and every roguelike Combat node now has its **own dedicated map** — `roguelikeStarterContent.json`'s `maps` holds 30 entries (`rlM01`…`rlM15`, `rlD01`…`rlD06`, `rlS01`…`rlS03`, `rlF01`…`rlF06`), one per Combat node, each with its own generated terrain (never the campaign's raw blocked/scoring tile data — that stopped being shared in the 2026-09-23 map-redesign pass). `nodes[].mapKey` points every Combat node at its own `rl*` map uniformly.

**Terrain is always dedicated; roster composition is not always distinct:**
- The first five missions (`rlM01`, `rlM02`, `rlM03`, `rlD01`, `rlS01` — mission ≤ 3 on any path) have their **own hand-designed variant 1 rosters** (they started as the variant 2 originals with each `v2…` config swapped for its variant 1 counterpart, then retuned to introduce the variant 1 kit and smooth the difficulty ramp — see `docs/ai-ship-configs.md`).
- Every other roguelike map (mission 4+) **copies its campaign counterpart's exact roster** (`configKeys` — same ships, same variant 2 rosters) at generation time, placed on the new dedicated terrain via the same formation logic. This is a deliberate "same difficulty, different battlefield" design choice, not leftover sharing — the two `mapPlacements` entries are independent on-chain data from this point on (retuning one doesn't retune the other), they just started identical.
- The deploy module seeds all 30 roguelike maps chained after the 30 campaign maps (ids 31–60), then the 5 PvP-only maps (ids 61–65, not attached to any node). Map ids are computed from array position, so keeping the chain unbroken matters (see the Ignition execution-order note in `CLAUDE.md`).

The NodeMap campaign's own 30 maps are a separate, independent set of map ids (1–30) — nothing about the roguelike's map-dedication pass touches them structurally (their terrain changed too, but as part of the same map-redesign pass, not because of anything roguelike-specific).

## Things to know

- **No DEC from the first three missions.** Kill rewards are paid in the destroyed ship's faction token, and only variant 2 has a reward token registered (`FactionRewardTokenRegistry`); destroying variant 1 ships emits `RewardSkipped`. If you want early-game rewards, register a variant 1 token.
- **Variant 1 enemies are weaker** than the variant 2 rosters they replace (less hull and armor, faster, longer range), and they kite. The first three missions are therefore easier than before. The variant 1 Support configs already equip Repair Drones, so they heal.
- **`d01` and `s01` count as mission 3.** They are the third fight on their branches, so they use variant 1. `s01` (the risky shortcut) is a deliberately harder 4-ship roster than a normal mission 3 — an earlier 7-ship version was out of reach.
- **The AI ship configs were redesigned** (2026-09-21, see `docs/ai-ship-configs.md`): each faction's ships now use their own kit — specials, faction abilities, and a variant 1 Rammer — and the five variant 1 rosters introduce it gradually.

## Changing the progression

- **Different number of variant 1 missions:** the graph and rosters are data. Re-point the affected nodes' `mapKey` in `roguelikeStarterContent.json` to variant 1 (or variant 2) maps, adding `maps` / `mapPlacements` entries as needed. `test/RoguelikeProgression.test.ts` has a `VARIANT_1_MISSIONS` constant that must match.
- **On a live deploy:** use `AIEncounters.setMapPlacements` on the affected roguelike map id directly — every roguelike map has its own id and its own placement data now, independent of its campaign counterpart (see "How it is built"), so this never touches the NodeMap campaign.

## Verification

`test/RoguelikeProgression.test.ts` walks the graph as deployed on-chain, computes each node's mission number, and asserts every mission ≤ 3 has only variant 1 enemies and every later mission only variant 2 — plus that the campaign's own 30 maps are unchanged and the early missions use roguelike-only maps.

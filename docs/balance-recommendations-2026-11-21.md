# Balance recommendations: roguelike (simulator iteration 3)

_Written 2026-11-21._

Source: simulator iteration 3 (`near/sim/experiments/iter3.json`, finished 2026-11-21). Full numbers are in `near/sim/out/iter3/report.md`, with a summary in `docs/balance-simulator.md` under "Iteration 3 full run".

The run covers only the 18 roguelike nodes reachable from mission 1. The single-player campaign is a stub. Missions are named by node id and title. Single-fight win rates are at the cost cap a run has on arriving at the mission, against the deployed on-chain AI.

## 1. Two of the three branches never get chosen

At two of the three branches, one option is both harder and pays no DEC. Simulated players almost never take those options.

| Branch | Option A | Option B | What players do |
|---|---|---|---|
| After 9. Interception | **10. Full Court Press**: 1 fight, 10 enemies, last one standing wins, variant 1 (no DEC). Average 0%, Excellent 88% | **12 → 13 → 14** (The Long Road, Highway 50, End of the Line): 3 fights, variant 2 (pays DEC). Average 75–100%, Excellent 100% | Excellent picked 10. Full Court Press once in 39 runs |
| Last resupply (18) | **11. The Hive: Dominance**: variant 2, Average 50%, Excellent 100% | **15. The Hive: Alliance**: 11 enemies, last one standing wins, variant 1. Average 0%, Excellent 50% | Nobody ever chose 15. The Hive: Alliance |

The shortcut and the alternative ending are traps rather than real choices.

**Recommendation.** Pick a role for each and tune to it:

- **10. Full Court Press as a risky shortcut:** make it beatable for Average players, roughly 40–60%. Trimming the 10-ship roster (aiConfig62 and aiConfig16 are the strongest) would do it, or give it variant 2 enemies so it pays DEC.
- **15. The Hive: Alliance as the hard ending:** keep it hard, but give it a reason to be chosen, such as a better reward or a separate medal or cosmetic. Otherwise only completionists will ever see it. It is the hardest fight in the game: Excellent wins only 5–7 of 10 runs on every path ending there.

The first branch is fine: 16. Sneak Attack and 17. Repair Station DS7 both get picked by Excellent (29 and 11 times out of 40).

## 2. Difficulty curve for Average players

Average wins only 3 of 40 runs. The losses pile up early:

| Mission | Average, per attempt in runs | As a single fight |
|---|---|---|
| 3. Collision Course | 66% | 81% |
| 5. Shocking Revelation | 54% | 62% |
| **6. Counterattack** | **33%** | **25%** |
| 17. Repair Station DS7 | 33% | 50% |
| 16. Sneak Attack | 79% | 94% |

- **6. Counterattack is the biggest difficulty spike.** It fields 9 enemies under an 800 cap, against 5 on the mission before it. Everyone has to fight it, because both branches join there. Cutting it to 6–7 ships (one of the two v2sniper3, v2grunt, v2support3) should bring Average to about 50–60%.
- **After 6. Counterattack it gets easier for Average.** They won every attempt at 11 through 14, but only 3 runs got that far, so those numbers are thin. The single-fight table agrees: 75–100% at 12–14.
- **8. Interference and 9. Interception take 19–21 rounds.** At up to 600 s a turn, those are very long sessions. Both have a max score of 100, and in practice you score about 1 point a round, so they play as long fights to the last ship. Consider lowering the max score to about 30–40 so the tiles end the game.
- **Check 17. Repair Station DS7: its `turnTime` is 0** in `roguelikeStarterContent.json`. It's the only mission without 600. It may be a content error; the simulator doesn't model turn time.

## 3. New players stall at mission 2

- **Poor players clear 2. Digging Deeper 10% of the time in runs** (25% as a single fight). Almost every Poor run ends there, at 1.05 combats per run.
- The enemies there (grunt, aggressor, aiConfig13) were never destroyed in any game. That's because the fight is won on tiles (max score 28), not because the ships are too tough. A careless player who fights instead of holding tiles loses.

**Recommendation:**

- Raise mission 2's max score a little, or make a single enemy weaker.
- Or teach tile control in the mission text: mission 1 is won by fighting, so mission 2 is the first one that needs tiles.

The pending Digging Deeper AI fix (the AI doesn't take the center tile) would make the on-chain AI stronger, so mission 2 gets harder, not easier. If you make that fix, retune mission 2 at the same time.

## 4. Ship supply: deploy the free top-up

- **FTP/Poor** loses about 110 ships in 84 days and ends at exactly the 10-ship floor after 90 free top-ups. The top-up exists (`FreeShipClaim.topUpFreeShips` and NEAR `top_up_free_ships`) but isn't deployed. **On today's contracts this player runs out of ships.**
- **Whale/Poor** loses 150 ships, but buys more. Average and Excellent players lose almost nothing (0–0.12 destroyed per game).
- **Recommendation:** deploy the top-up (handoff: `docs/frontend-handoff-free-ship-topup-2026-11-19.md`).

## ~~5. Medal is tied to the wrong campaign~~

- ~~**On Base Sepolia, `ShatteredHiveMedal.finalNodeId` = 30.** That's the final node of the placeholder single-player campaign. Nobody can earn the medal through the roguelike.~~
- ~~The simulator assumes winning either Hive ending earns it. Under that rule every Excellent player gets it, and 1–2 of 3 Average players per spend tier.~~
- ~~**Recommendation:** point the medal at the roguelike's endings. It holds a single node id, so covering both endings may need a small contract change, or a decision to award it only for 11. The Hive: Dominance. How the medal hooks into the roguelike contract hasn't been checked yet.~~

**Fixed in code 2026-11-21; applied on Base Sepolia 2026-11-24** (effect `0xb6821756Ae6EC61eF203fb55cd0f48A288D9c43b`):
- **EVM:** new `RoguelikeCompletionWinEffect` records a win at a node with no children. The deploy module attaches it to every reachable ending, and the medal reads it, so `claimMedal` works after winning 11. The Hive: Dominance or 15. The Hive: Alliance.
- **Live medal:** `scripts/repointMedalToRoguelike.ts` repoints it without a redeploy. Players who won a run earlier can be granted the medal with `scripts/grantShatteredHiveMedal.ts`.
- **NEAR:** a new `HiveMedal` win effect, seeded on both endings, awards the medal directly.
- **Frontend note:** `docs/frontend-handoff-medal-roguelike-2026-11-21.md`.

## 6. PvP: pay-to-win flags

| At equal skill | Whale vs FTP | Casual vs FTP | Whale vs Casual |
|---|---|---|---|
| Poor | 66% | 69% | 55% |
| Average | **89%** | 74% | 64% |
| Excellent | 80% | 38% | **88%** |

- **Skill still matters most.** FTP/Excellent is #2 by rating (1824), above Whale/Average (1801). Excellent beats Poor about 99% at every spend level.
- **Spending still decides games between equals.** Whales end with fleet power 5.4–6.0 against 3.2–4.2 for FTP, and cost-capped brackets don't close that gap: whales fill the same cap with better ships.
- Casual/Excellent losing to FTP/Excellent (38%) is not a bug: FTP plays more runs, so it earns more and ends with more fleet power.
- **Recommendation:** match PvP by fleet power, not just cost cap, or narrow the stat range per cost point. Section 7 covers where the cost table misprices power.

## 7. Ship part prices

These are fitted from 20,000 simulated Average-vs-Average games. Treat them as directions to check with real play, not exact prices.

**Update 2026-11-25: the table below supersedes the struck-through one further down.** It was fitted on the standard match (map 70 `pvp04`, first to 100, threat 1000/2000) with purpose deployment, the joiner seeing the creator's fleet. The earlier fits used a placement that lost to random deployment. There are two rule sets: on-chain, and the minimum movement raised to 3 (simulator switch `VT_SIM_MOVE_CLAMP=3,9`). Each is 20,000 Average-vs-Average games. Runs: `near/sim/out/purpose-prices-onchain`, `near/sim/out/purpose-prices-3-9`.

| Entry | Price | Fair, on-chain | Fair, min movement 3 | Suggested price (with min movement 3) |
|---|---|---|---|---|
| Each extra ship, v1 / v2 | 75 | 125 / 124 | 115 / 127 | ~120 (changes every fleet; phase it) |
| v1 armor Light / Medium / Heavy | 5 / 10 / 15 | 8 / 20 / −2 | 9 / 21 / 28 | 5 / 20 / 25 |
| v1 shields Light / Medium / Heavy | 10 / 20 / 30 | 13 / 32 / 36 | 10 / 30 / 39 | 10 / 30 / 35 |
| v2 armor Light / Medium / Heavy | 5 / 10 / 15 | 7 / −13 / −72 | 8 / 20 / 16 | 5 / 20 / 15 |
| v2 shields Light / Medium / Heavy | 10 / 20 / 30 | 6 / −10 / −39 | 6 / 25 / 25 | 10 / 20 / 30 (fair) |
| v1 speed tier 1 / 2 | 10 / 25 | 15 / 23 | 9 / 16 | 10 / 15–20 |
| v2 speed tier 1 / 2 | 10 / 25 | 35 / 66 | 11 / 24 | 10 / 25 (fair) |
| v1 accuracy tier 1 / 2 | 10 / 25 | 4 / 15 | 1 / 8 | 5 / 10 |
| v2 accuracy tier 1 / 2 | 10 / 25 | 9 / 23 | 10 / 20 | 10 / 20–25 (fair) |
| v1 hull tier 1 / 2 | 10 / 25 | 7 / 12 | 4 / 9 | 5 / 10 |
| v2 hull tier 1 / 2 | 10 / 25 | 6 / 15 | 9 / 10 | 10 / 10–15 |
| Weapons v1 Sniper / Missile / Close | 5 / 15 / 15 | 13 / 12 / 16 | 10 / 18 / 14 | fair |
| Weapons v2 Sniper / Missile / Close | 5 / 15 / 15 | 13 / −10 / 12 | 5 / 11 / 13 | fair |
| v1 special 1 (EMP) / 2 / 3 | 10 / 20 / 15 | 3 / 25 / 4 | −1 / 22 / 2 | 1 and 3 play like nothing: a mechanics question, not price; 2 fair |
| v2 special 1 / 2 / 3 | 15 / 20 / 10 | 8 / 28 / 85 | 6 / 26 / 36 | 5 / 20–25 / 35 |

- **Minimum movement 3 fixes protection.** Under on-chain rules, v2 Medium/Heavy armor and shields and v1 Heavy armor are worth less than nothing at any price. With a floor of 3, every armor and shield tier is fair or underpriced. ~~Recommendation: raise the minimum movement to 3, or soften the heavy tiers' movement penalties so no build drops below 3. This is a ship-stats change on both chains. Not made.~~ **Done in code 2026-11-26:** `MIN_MOVEMENT` = 3 in `contracts/ShipAttributes.sol` and `near/crates/vt-core/src/attributes.rs`. Not yet deployed to either chain. The "min movement 3" column is now the on-chain rules once deployed. ~~The prices in the last column are not changed yet.~~

**Prices applied in code 2026-11-26** (`ignition/modules/DeployAndConfig.ts`, exported to `near/seed/config.json`; not deployed). Where the table gives a range, the value nearest the min-movement-3 fit was used:

| Table | v1 (was) | v2 (was) |
|---|---|---|
| baseCost (a bare Generic ship = base + 25) | **95** (50) | **95** (50) |
| accuracy tiers 0/1/2 | **0 / 5 / 10** (0 / 10 / 25) | **0 / 10 / 20** (0 / 10 / 25) |
| hull tiers | **0 / 5 / 10** (0 / 10 / 25) | **0 / 10 / 10** (0 / 10 / 25) |
| speed tiers | **0 / 10 / 15** (0 / 10 / 25) | 0 / 10 / 25 (unchanged) |
| weapons Generic / Sniper / Missile / Close | 25 / 30 / 40 / 40 (unchanged) | 25 / 30 / 40 / 40 (unchanged) |
| armor None / Light / Medium / Heavy | **0 / 5 / 20 / 25** (0 / 5 / 10 / 15) | **0 / 5 / 15 / 20** (0 / 5 / 10 / 15); ~~0 / 5 / 20 / 15~~ changed the same day so each tier costs more than the one below |
| shields None / Light / Medium / Heavy | **0 / 10 / 30 / 35** (0 / 10 / 20 / 30) | 0 / 10 / 20 / 30 (unchanged) |
| specials None / 1 / 2 / 3 | 0 / 10 / 20 / 15 (unchanged: 1 and 3 need mechanics work) | **0 / 5 / 25 / 35** (0 / 15 / 20 / 10) |

**Roguelike caps raised 25% to match** (`ignition/data/roguelikeStarterContent.json`, read by both chains' seeders): initial 600 → 750, 4. Resupply Station 800 → 1000, 7. Resupply Station 1000 → 1250, r02 Resupply Station 1200 → 1500. The human's 2026-11-18 fleets cost 741 / 921 / 1249 at the new prices, so they still fit. PvP caps (1000/2000) are unchanged.

**Live rollout needs:** a new costs version and the cap updates on each chain (`setCosts` / `setCampaignInitialCostCap` / `updateNode` on EVM; the NEAR equivalents), and every existing ship re-synced by its owner (`syncShipCosts` / `sync_ship_costs`) before it can join a fleet. Then rerun the price fit, the roguelike stage, `calibrate` and `fit-values` on the new prices.
- **The floor also fixes v2 speed and v2 Missile, and shrinks v2 special 3 (+3 movement) from 85 to 36.**
- **Holding under both rule sets:** extra ships are underpriced (~120 vs 75); v1 accuracy, hull tier 2 on both variants, v1 specials 1 and 3, and v2 special 1 are overpriced.
- **Caveats:** Average-vs-Average play, random fleets. The exchange rate differs between fits (0.0058 vs 0.0070 win log-odds per cost point), so compare verdicts more than exact numbers. Rank and repricing interactions aren't modelled: refit after any change.

**Old table (2026-11-21), superseded:**

| Entry | Price | Fair price (sim) | Note |
|---|---|---|---|
| **v2 special 3** | 10 | ~~**131**~~ | ~~By far the biggest gap. Excellent players already favour it, picking it 1.5× more often than you'd expect~~ |
| Speed +1 / +2 | 10 / 25 | ~~33–40 / 64–84~~ | ~~Underpriced for both variants~~ |
| v1 Light shields, v1 special 2, Close weapon | 10–20 | ~~24–47~~ | ~~Underpriced~~ |
| **Armor (all tiers)** | 5–15 | ~~**negative**~~ | ~~Fleets play worse with armor, at any price~~ |
| v2 shields (all), v1 Heavy shields | 10–30 | ~~0 to −60~~ | ~~Same pattern~~ |
| Missile | 15 | ~~−22 / −25~~ | ~~Plays worse than Generic~~ |
| Each extra ship (count) | 75 | ~~122–145~~ | ~~An extra cheap ship beats upgrades on the ships you have~~ |

**Recommendation:**

1. Look at v2 special 3 first.
2. Armor and shields being worth nothing (or less) suggests their stat trade-off, probably the speed they cost, is too steep. That's more likely a mechanics problem than a pricing one.
   - ~~**Checked 2026-11-24:** the simulated players now take damage reduction into account when judging exposure (`exposed_dmg`). The fitted values barely moved, and none turned positive. The values track movement: going without armor gives +1 movement, so every armor tier costs 1–4 movement. It is the mechanics. Details: `docs/balance-simulator.md`, "Damage-aware exposure feature".~~
   - **Retracted 2026-11-24:** the price fit plays PvP to max score 30 on maps whose tiles score 10–25 points. Games end in 3–4 rounds, and whoever reaches the near tiles first wins. That format alone favours speed over damage reduction, so the fit can't tell whether armor is weak in general. Simulated players also don't use ships by role (`docs/balance-simulator.md`, "Do simulated players use ships by role?"). Rerun the price fit at a longer max score before drawing a conclusion.
   - **Rerun 2026-11-24 on the standard match** (map 70 `pvp04`, 100 points, threat 1000/2000): v1 Light armor and v1 shields at every tier are worth their price or more. The heavy tiers are still strongly negative (v2 Heavy armor about −114 to −135 against a price of 15), and they cost the most movement. **Recommendation:** soften the heavy tiers' movement penalty rather than reprice them. Details: `docs/balance-simulator.md`, "Standard PvP match".
   - **2026-11-25:** agents given roles, and trained against opponents that anchor or raid, learned to *avoid* parking heavies at home on the standard match. Anchoring scores 39–50% head to head, and the heavy tiers stay strongly negative. Details: `docs/balance-simulator.md`, "Roles and varied training opponents". Human games of the standard match would show whether real opponents raid enough to change that.
3. Raising speed prices and the per-ship base cost would push fleets towards fewer, better ships.

## 8. AI rosters

- **Never destroyed:**
  - grunt, aggressor, aiConfig13 (2. Digging Deeper);
  - aiConfig22 (3. Collision Course);
  - v2turtle (9. Interception);
  - v2sniper5 (12. The Long Road).

  This is fine if they're meant as tile-holders, but worth a look.
- **Almost no damage:** aiConfig12, aiConfig14 and aiConfig61 (in 8. Interference, 10. Full Court Press and 15. The Hive: Alliance) deal 2–9 damage a game. They're probably filler: easy cuts if you trim 10. Full Court Press.
- **Hardest hitters:** aiConfig63 (484 damage a game, in 11. The Hive: Dominance), then aiConfig10_2 and aiConfig13_2.

## 9. Simulator follow-ups

- **Absolute clear rates for Poor and Average depend on calibration.** Their order is reliable, but the plan's targets (Average about 70%, Poor about 30%) landed at 45% and 17%.
- **Retrain the eval on roguelike fights only.** The current weights were partly trained on placeholder-campaign fights.
- **Human benchmark:** a human playing 6. Counterattack, 10. Full Court Press and 15. The Hive: Alliance would confirm the sim's view of the hardest fights. The 2026-11-18 human run lost at 10. Full Court Press, which matches.

## Suggested order

| # | Change | Type |
|---|---|---|
| 1 | Deploy the free top-up | Deploy |
| ~~2~~ | ~~Point the medal at the Hive ending(s)~~ (done in code 2026-11-21; live repoint applied 2026-11-24) | Contract or config |
| 3 | Trim 6. Counterattack; check `turnTime` 0 on 17. Repair Station DS7 | Content |
| 4 | Give 10. Full Court Press and 15. The Hive: Alliance a reason to be chosen | Content |
| 5 | Ease 2. Digging Deeper (with or without the AI center-tile fix) | Content |
| 6 | Reprice v2 special 3, speed and armor | Cost table |
| 7 | Shorten 8. Interference and 9. Interception | Content |
| 8 | Fleet-power matchmaking for PvP | Design |

Items 3–5 and 7 are content-file changes. Each can be checked with a quick simulator re-run of the affected missions before anything goes on chain.

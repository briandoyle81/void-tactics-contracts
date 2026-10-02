# Frontend Handoff: Roguelike Disabled-Ship HP Fix

**Written: 2026-10-02.** Describes a `RoguelikeMatch` change made on `main` on this date. **Not yet
deployed.** Until the next redeploy, Base Sepolia still runs the 2026-09-30 contracts described in
`docs/frontend-handoff-engine-registry-and-redeploy-2026-09-30.md`. There's no ABI change; this is a
behavior fix only.

## What changed

A ship can sit on the board at 0 HP without being destroyed. Suppose one did that through a won
roguelike mission, and the campaign's automatic heal (`campaignAutoHealPercent`) was 0%. Its stored run
HP (`RoguelikeRun.getShipHP`) was then saved as `0`. `0` means "undamaged / full," so the ship entered
the next mission at full HP.

After this fix, that ship carries forward at **1 HP**, or at the heal floor if that's higher. If the FE
shows a ship's run HP as `getShipHP(player, shipId) || maxHullPoints`, that formula is still correct.
The ship now simply shows 1 HP instead of full.

(The per-mission squads feature drafted the same day was reverted before deploy and does not affect the
FE. See `docs/fleet-parent-child-design-2026-10-02.md` if it comes back.)

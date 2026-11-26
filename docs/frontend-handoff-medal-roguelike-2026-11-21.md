# Frontend handoff: the Shattered Hive medal is now earned in the roguelike

_Written 2026-11-21._

The Shattered Hive Campaign Medal (soulbound, required to buy variant 2 ships) used to be earned by completing the last node of the single-player campaign. That campaign is a stub. The medal is now earned by **winning a roguelike run at either ending**: 11. The Hive: Dominance or 15. The Hive: Alliance. An ending is any node with no children.

## EVM (Base)

- **New contract `RoguelikeCompletionWinEffect`.** It is a roguelike win effect attached to both ending nodes. On a win there it sets `hasCompleted(player)` and emits `RoguelikeCompleted(player, nodeId)`.
- **`ShatteredHiveMedal.nodeMap()` now points at that contract,** and `finalNodeId()` is 0.
- **The claim flow is unchanged:** the player still calls `claimMedal()` themselves.
  - Before a win it reverts `CampaignNotCompleted`.
  - A second claim reverts `AlreadyClaimed`.
- **To show a "Claim medal" button:** show it when `RoguelikeCompletionWinEffect.hasCompleted(player)` is true and `ShatteredHiveMedal.balanceOf(player)` is 0. A good moment to offer it is right after a run ends as Won (`RoguelikeRun.RunEnded(player, true)`).
- **Single-player campaign completion no longer earns the medal on EVM.**
- **Address:**
  - A fresh deploy lists it as `DeployModule#RoguelikeCompletionWinEffect`.
  - ~~On the current Base Sepolia deployment it doesn't exist yet. Until `scripts/repointMedalToRoguelike.ts` is run there, the medal still reads the old campaign node.~~ Applied on Base Sepolia 2026-11-24: **`RoguelikeCompletionWinEffect` = `0xb6821756Ae6EC61eF203fb55cd0f48A288D9c43b`**. It is attached to nodes 11 and 15, and the medal reads it (`finalNodeId` 0). It isn't in `deployed_addresses.json`, because it was deployed by script, not Ignition.
- **Players who won a run before the repoint** were not recorded. They need an owner grant.

## NEAR

- **New `WinEffect` variant `"HiveMedal"`.** The seed sets it on both ending nodes. Winning there **awards the medal directly**: no claim call.
  - It shows up as an `mt_mint` event for token `hive_medal`.
  - `mt_balance_of(account, "hive_medal")` becomes 1.
- **No claim step.** Don't show a claim button after a roguelike win. If the account already holds the medal, the effect does nothing.
- **`claim_medal` still exists** for the single-player campaign path. It isn't needed for the roguelike.
- **`get_rl_node(node_id).win_effects`** can include the string `"HiveMedal"` alongside the existing `DecBonus`, `HealAboveFloor` and `ShipGrant` objects. ABI: `near/abi/void_tactics_abi.json`.

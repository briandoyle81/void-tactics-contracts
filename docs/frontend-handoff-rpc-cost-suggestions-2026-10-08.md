# Frontend RPC-Cost Suggestions — Contract-Side Evaluation

**Written: 2026-10-08.** Describes contract state as of this date. Check the date against later handoff docs before relying on it.

**Update (same day):** suggestions 1–3 are now built as recommended below (sections marked done). The "Frontend usage" notes under each describe the new API.

This responds to the frontend's three suggestions for cutting RPC request and credit costs (batch AI turns, indexed player topics, aggregated views). It also records one change already made in response: map names and node titles/descriptions have been **removed from the contracts** (section 4). That change needs frontend work.

Size context: with current changes, `Game` is at 23.929 KiB (about 70 bytes of headroom) and `Ships` is at 23.986 KiB (about 14 bytes) against the 24 KiB EIP-170 limit. Nothing that adds bytecode to those two contracts is feasible.

---

## ~~1. Batch AI turns — partially feasible; smaller win than estimated~~ — BUILT (2026-10-08)

~~**Status: not built.**~~ Built: `takeAITurns(uint gameId, uint maxMoves)` on both `SinglePlayerMatch` and `RoguelikeMatch`.

The suggestion assumes the AI moves all its ships in one block per round. It doesn't. `Game._switchTurnIfOtherPlayerHasShips` **alternates turns ship by ship**. After each AI move the turn passes back to the human, unless the human has no unmoved ships left this round.

- **`takeAITurns(gameId, maxMoves)`:** feasible and rules-correct, as a loop that keeps going while `currentTurn == address(this)`. It only removes requests in the tail case, where the AI has more unmoved ships left than the human. It does **not** give the ~4× reduction estimated. Implementation notes: the loop must re-read `game.getGame` after each move, because the cached view goes stale. `maxMoves` must be a hard cap, since each AI decision is an expensive view in `AIBehavior`. Size headroom: `RoguelikeMatch` has about 1.5 KiB, `SinglePlayerMatch` about 8.6 KiB.
- **Run the AI automatically at the end of the human's move:** not feasible as things stand. The human already pays the AI's gas, so cost isn't the obstacle. The obstacles are:
  - Hooking it into `Game.moveShip` doesn't fit Game's ~70 bytes of headroom.
  - A wrapper on the match contract can't move the human's ship. `moveShip` requires `msg.sender == currentTurn` and that the sender owns the ship.
  - It would also only cover the one AI reply before the turn alternates back.

~~**Frontend guidance for now:** keep calling `takeAITurn` once per AI move. If `takeAITurns` gets built, call it when the AI has unmoved ships left and the human has none.~~

**Frontend usage:** you can call `takeAITurns(gameId, maxMoves)` wherever you call `takeAITurn` today. It moves AI ships until the turn leaves the AI, the game ends, or it has made `maxMoves` moves, and it emits one `AITurnTaken` per ship moved.
- It's permissionless, and it reverts `NotAITurn`/`GameEnded` only if the very first move can't happen, exactly like `takeAITurn`. After that it stops without reverting.
- It also stops early if a ship's move and its Pass fallback both fail, so a stuck ship can't burn the budget.
- Pick `maxMoves` from the AI fleet size (e.g. its number of live ships). Gas scales linearly with ships actually moved, so estimate gas rather than hardcoding a limit.
- The existing `takeAITurn` is unchanged.

## ~~2. Indexed player topics — mostly already in place~~ — BUILT (2026-10-08)

~~**Status: not built. A small change is recommended.**~~ Built: `Game.GameStarted` is now `GameStarted(uint indexed gameId, uint lobbyId, address indexed creator, address indexed joiner)`.

- `GameUpdate`, `Move`, `GameStarted` and both contracts' `AITurnTaken` already index `gameId`. Once a client knows its game IDs, it can already filter or subscribe to only those games' events. "Every client billed for every game's events" isn't the case today.
- **Gap: discovering which games a player is in.** `GameStarted(gameId indexed, lobbyId indexed, creator, joiner)` doesn't index the players. Recommended: index `creator` and `joiner`, removing `lobbyId`'s index (events allow at most 3 indexed topics). It's a cold path, so the bytecode change is small.
  - Single-player games already have this: `SinglePlayerMatch.NodeMatchStarted` has `address indexed human`, and `RoguelikeMatch.CombatNodeEntered` has `address indexed player`.
- **Not recommended:** adding creator/joiner topics to `GameUpdate`. That adds two storage reads to every move and bytecode Game can't spare, and it adds nothing beyond the existing `gameId` filter.
- Changing an event's signature changes its topic hash. Frontend log filters and any indexers must update at the redeploy that ships it.
  - Note: the parameter types are unchanged, so `topic0` stays the same here. What changes is which values sit in topics vs. data: `lobbyId` moves from topic 2 into data, and `creator`/`joiner` move into topics 2 and 3. Decoders must use the new ABI.

**Frontend usage:** to discover a player's games, filter `GameStarted` by `creator = player`, plus a second filter by `joiner = player` for PvP games joined. Then filter `GameUpdate`/`Move` by `gameId`. Also, `Game.playerGames(player, i)` and `Game.getGamesForPlayer(player)` already list a player's games without logs.

## ~~3. Aggregated views — recommended, as a separate lens contract~~ — BUILT (2026-10-08)

~~**Status: not built.**~~ Built: new stateless `GameLens` contract (`contracts/GameLens.sol`), deployed by `DeployAndConfig.ts` and returned from the module as `gameLens`. It has no admin functions and needs no wiring.

The recommendation is one new read-only `GameLens` contract holding all of these. It leaves `Game`/`Ships` untouched and can be redeployed on its own whenever the frontend needs a new view.

- **`getShipsOwned(owner, offset, limit)`:** this can't go in `Ships` (14 bytes free). It must be **paginated**. The existing `shipsOwnedCount`/`shipIdOwnedAt` pair exists because a full-array return blows past provider response and gas caps for large holders (GR-01).
- **`getRunView(player)`:** returns the `Run`, plus `getShipHP` for each roster ship, plus `isNodeLocked`/`isNodeDefeated` flags. The flags are for node IDs the caller passes in, or for the campaign graph below.
- **`getCampaignGraph(campaignId)`:** `RoguelikeNodeMap` node IDs are global (`nodeCount` spans every campaign), and nothing indexes nodes by campaign. The view should walk the graph outward from `campaignRootNode[campaignId]` through `children`, which also returns the edges, rather than scanning `1..nodeCount`.

**Frontend usage (as built):**
- `getShipsOwned(address owner, uint offset, uint limit) → (Ship[] page, uint total)`
  - Returns `Ship` structs for the owner's ships `[offset, offset+limit)`, clamped. `total` is the owner's full count, so keep paging while `offset + page.length < total`.
  - A huge `limit` is safe; it clamps rather than reverting. Keep pages modest (e.g. 50–100) for large holders, for the same provider-cap reason as GR-01.
  - It replaces `getShipIdsOwned` → `getShipsByIds`.
- `getCampaignGraph(uint campaignId) → RoguelikeNode[]`
  - Every node reachable from the campaign root, breadth-first, root at index 0, each node once, cycles handled.
  - Each node's `children` (with `twoWay`) are the edges.
  - Returns an empty array for an unknown campaign or one with no root.
  - A node an admin created but never linked from the root doesn't appear.
  - It replaces `nodeCount` → `getNode`×N.
- `getRunView(address player) → RunView { Run run; uint8[] rosterHP; uint[] nodeIds; bool[] nodeLocked; bool[] nodeDefeated }`
  - `rosterHP` is parallel to `run.rosterShipIds`. 0 means "not yet damaged this run", i.e. full HP.
  - `nodeIds` is the run's campaign graph in `getCampaignGraph` order, with `nodeLocked`/`nodeDefeated` parallel to it.
  - A player who never started a run gets `run.status == None` and empty arrays.
  - After a run ends, `run` still returns its final state.
- Built in a separate contract rather than in `Ships`/`RoguelikeRun`/`RoguelikeNodeMap`, so new views can be added later by redeploying `GameLens` alone. The frontend should read its address from the deploy output like any other contract.

## 4. ~~On-chain map names and node titles/descriptions~~ — REMOVED (2026-10-08)

**Status: done in the contracts repo. Takes effect at the next redeploy.** The live Base Sepolia deploy still has the old functions until then.

Neither was read by any contract logic. They existed only for display. Removing them saves about 4M gas and 66 transactions per deploy, removes one contract, and removes the frontend's reads of these strings. Gameplay gas is unchanged.

### What changed
- **`Maps.sol` / `IMaps.sol`:** removed `mapName(uint)`, `setMapName(uint, string)` and the `MapNameSet` event. Maps bytecode went from 18.10 to 17.12 KiB.
- **`NodeContentRegistry.sol`:** the contract is deleted entirely, including `getNodeContent`, `setNodeContentBatch`, the editor allowlist and the `NodeContentSet` event. It's no longer deployed or returned by the deploy module.
- **`DeployAndConfig.ts`:** no longer calls `setMapName`, and no longer seeds node content or grants node-content editor rights. Roguelike `winEffects` seeding is unchanged.
- The seed JSON files (`ignition/data/*StarterContent.json`) **keep** each map's `name` field. The deploy ignores it, so the frontend can use these files as its source for names.

### Frontend action items
1. **Map names:** source them from frontend data keyed by map key or by on-chain map ID. On a fresh deploy, IDs are assigned in this fixed order (the deploy chains every map creation to the previous one, so the order is guaranteed):
   - 1–30: `singlePlayerStarterContent.maps`, in array order
   - 31–60: `roguelikeStarterContent.maps`
   - 61–66: `pvpStarterContent.maps`

   Maps created later by admins have no on-chain name either. The frontend's own map data needs an entry for them.
2. **Node titles/descriptions:** remove the registry layer from the content fallback chain (it was registry → Postgres draft → static config → default). Postgres, or static config, is now the source of truth.
3. **Admin publish flow:** retire the "publish to chain" step that called `setNodeContentBatch`. The `NODE_CONTENT_PUBLISHER_PRIVATE_KEY` signer is no longer needed.
4. **ABIs and addresses:** drop the `NodeContentRegistry` address and ABI. Regenerate the `Maps` ABI and remove any `mapName` reads and `MapNameSet` log handling.
5. The mission seed export (`missionSeedExport.ts`) can keep writing `title`/`description`. The deploy ignores them, so stopping is optional.

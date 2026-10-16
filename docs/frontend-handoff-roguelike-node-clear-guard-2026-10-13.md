# Frontend Handoff: Roguelike "Clear the Current Mission First" Guard, and Two-Way Edges Removed

**Written: 2026-10-13.** Describes two `RoguelikeMatch`/`RoguelikeNodeMap` changes made on `main` on
this date. **Not yet deployed.** Until the next redeploy, Base Sepolia still runs the 2026-10-12
contracts, which have the bug in §1 and still support two-way edges.

## 1. Bug fix: leaving a mission without beating it

### The bug

`enterCombatNode` and `enterResupplyNode` both go through `_commitToNode`. It checked only the
*target* node, never the node being left, so a direct contract call could:

1. **Skip a mission:** right after `startRun`, enter a child of the root without fighting the root.
2. **Move mid-match:** enter another node while a match was live. `activeGameId` was overwritten by
   the new match. When the first match ended, `onGameEnded` credited the win (and its kill rewards
   and progression) to the new node, and a loss there ended the run anyway.
3. **Duplicate a match:** re-enter the current combat node while its match was live.

### The fix

`_commitToNode` now checks, before any traversal:

- `run.activeGameId != 0` → reverts `ActiveGameInProgress()`. This applies to every target,
  including the current node. (`enterResupplyNode` already had this check; it now lives in the
  shared path.)
- Target is not the current node, current node is `Combat`, and
  `RoguelikeRun.isNodeDefeated(player, currentNodeId)` is false → reverts the **new** error
  `CurrentNodeNotCleared()`. Leaving a `Resupply` node is always allowed.

Entering the current node with no live match still works. That's how the root mission is launched
after `startRun`, and how a resupply node is re-entered.

**Frontend:** no behavior change is needed. The run map and the web2 routes already enforce the
same rule (`isCurrentNodeCleared` in `app/utils/runMapAction.ts`).

## 2. Two-way edges removed

Every edge is now forward-only. A run can only move to an unlocked child of its current node, and
moving locks the node it left plus that node's other children. There is no way to walk back to a
parent.

### ABI changes (`RoguelikeNodeMap`, `GameLens`)

| Before | After |
| --- | --- |
| `struct RoguelikeEdge { uint childId; bool twoWay; }` | removed |
| `RoguelikeNode.children: RoguelikeEdge[]` | `RoguelikeNode.children: uint[]` (child node ids) |
| `getChildren(nodeId) → RoguelikeEdge[]` | `getChildren(nodeId) → uint[]` |
| `addChild(parentId, childId, bool twoWay)` | `addChild(parentId, childId)` |
| `event ChildAdded(parentId, childId, bool twoWay)` | `event ChildAdded(parentId, childId)` |
| `getEdge(parentId, childId) → bool twoWay` | removed |

`GameLens.getCampaignGraph` returns `RoguelikeNode[]`, so its `children` field changes shape the
same way. Regenerate the `RoguelikeNodeMap`, `GameLens` and `RoguelikeMatch` ABIs (`RoguelikeMatch`
also gained the `CurrentNodeNotCleared()` error from §1).

### Frontend places that use two-way edges (from a read of `void-tactics-fe` on 2026-10-13)

- **Reading children:** `e.childId` becomes the element itself, in `RoguelikeGraph.tsx`,
  `RoguelikeNodeEditPanel.tsx`, and anywhere else that reads `node.children` or `getChildren`.
- **Admin editor:** the two-way checkbox and `↔` display in `RoguelikeNodeEditPanel.tsx` /
  `RoguelikeNodeEditPanelWeb2.tsx`, the `twoWay` argument to `admin.addChild` in
  `RoguelikeGraph.tsx` / `RoguelikeGraphWeb2.tsx` and the admin hooks, and `twoWay` in
  `app/api/admin/roguelike/edges/route.ts`.
- **Web2 run server:** the backward-move branch (`{ parentId: targetNodeId, childId: currentNodeId,
  twoWay: true }`) in `app/api/roguelike/run/nodes/[id]/enter-combat/route.ts` and
  `enter-resupply/route.ts` should go, so web2 matches the contract.
- **Prisma:** `RoguelikeEdge.twoWay` in the web2 schema can be dropped. Any existing two-way rows
  then behave as forward-only edges.

The seeded campaign (`ignition/data/roguelikeStarterContent.json`) has no two-way edges, so the
deployed content is unaffected.

### Repeat-reward guard (SP-05) still applies

A won combat node can still be re-entered in place (target == current node skips the lockout), so
`enterCombatNode` still reverts `NodeAlreadyDefeated()` there. A node the run has left is locked,
so a cycle in the graph back to it reverts `CannotAdvance()`.

# Frontend Handoff: Engine Registry, Redeploy & Upgrade-Safety Fixes

**Written: 2026-09-30.** Everything that changed since `docs/frontend-handoff-combat-blocking-and-ship-specials-2026-09-26.md`
(including its 2026-09-28 update). Describes the contracts **now live on Base Sepolia (chain 84532)**
as of today's full redeploy (git commit `5f61c99`, "Redeploy"). This was a **fresh, full redeploy —
every contract has a new address.** Companion docs, all still the source of truth for their own topic
and unaffected by this one: `docs/frontend-handoff-maps-and-deployment-zones-2026-09-23.md`,
`docs/frontend-handoff-attributes-costs-and-ai-2026-09-21.md`,
`docs/frontend-handoff-combat-blocking-and-ship-specials-2026-09-26.md`, `docs/ai-ship-configs.md`.

---

## 0. TL;DR — what to do

1. **Every contract address changed.** This was a full fresh Ignition deploy, not an upgrade. Pull the
   current address list from `ignition/deployments/chain-84532/deployed_addresses.json` in this repo
   (or ask backend for the current list) — do not reuse any address from before 2026-09-30. **Regenerate
   ABIs for everything.**
2. **The 2026-09-28 disabled-ship-blocking exception is now live** — see
   `docs/frontend-handoff-combat-blocking-and-ship-specials-2026-09-26.md`'s "Update (2026-09-28)" note,
   which said "Still not deployed" at the time. It's deployed now: a disabled (0 HP) enemy ship no
   longer blocks movement-through or line-of-sight, only landing directly on its tile. No ABI change,
   behavior only — nothing else in that note changes.
3. **New contract: `GameEngineRegistry`** (§2). Lets you trustlessly resolve which `Game` contract
   address actually serves a given `gameId`, instead of relying only on local/cached state. There's
   only one "engine" live today, so this doesn't change anything you need to do right now — but wiring
   in the lookup now means a future in-progress-preserving rules upgrade (a new `Game` engine that only
   affects games created after it) won't require an FE code change later.
4. **Two ABI struct shape changes** — regenerate types for these specifically:
   - `Lobbies.getLobby(lobbyId)` (and the raw `lobbies(lobbyId)` mapping getter) — the nested game-config
     struct gained a new field, `pvpMatch` (§4.1).
   - `RoguelikeRun.getRun(player)` — the `Run` struct gained a new field, `requiredVariantAtStart` (§4.2).
   Both are purely additive (new trailing field) — decoding by name is unaffected; decoding by
   positional tuple index needs the regenerated ABI.
5. **Two new revert reasons to handle** (§5):
   - `Tournament.addSponsorPrize` now reverts `NoSponsorContribution` if called with `msg.value == 0`
     before any sponsor has been set (it used to silently let this claim the sponsor slot for free).
   - `Fleets.createFleet` (reached via `Lobbies.createFleet`, `SinglePlayerMatch.startNodeMatch`, and
     `RoguelikeMatch.startRun`/`enterCombatNode`) now reverts `DuplicateShipId` if the same ship id
     appears twice in one fleet submission. Validate client-side (no duplicate ship ids in the array)
     to avoid a wasted revert.
6. **Two new informational events**, neither of which blocks the normal player flow — worth listening
   for in admin/support tooling, not required for the core game UI (§6):
   `PvPMatch.GameResultRecordFailed`, `UTCLotteryHook.PrizeMintFailed`.
7. **Everything else** — a large batch of backend security/upgrade-safety hardening — needs **no FE
   action at all** (§7): new admin-only guards, internal per-game/per-run value pinning with unchanged
   read shapes, etc.

---

## 1. New addresses (full redeploy)

Every contract in the deploy was redeployed today with a new address — this includes contracts whose
code didn't even change this round (a full Ignition deploy redeploys the whole graph). Notable ones:

| Contract | New address (Base Sepolia) |
|---|---|
| `Game` | `0x2345602357edAF46A11656378d0bf8dc9Dbea559` |
| `Lobbies` | `0xE81A6ad03099B9510b0133B43Cb03b2Df1FB1E67` |
| `PvPMatch` | `0x7045C0bEb24805Df04Fc8c6Fda354Da7d939f235` |
| `SinglePlayerMatch` | `0xAa4826397d0a5Fd0d14F5800B2f5fa7F0EC0C085` |
| `RoguelikeMatch` | `0x319AbD0058495A11693A197971CEC6dE1E9eD755` |
| `RoguelikeResupply` | `0x67E016235f5888F89578bc6Ce990AAD849606350` |
| `RoguelikeRun` | `0x361Ca413133c1B87A22D8C0A75037De61bE898d3` |
| `RoguelikeNodeMap` | `0xe8daABfDd74Cc9503Ef7bF609cf31176Ed482A6C` |
| `NodeMap` | `0x3993B9Cde6A49988166cDFd222fC00fA9218EC35` |
| `Ships` | `0xd9572967D59104573753247A7f6448efD59B7731` |
| `ShipsRouter` | `0xcA66b7E15fbE12405C0Af586AC4bb52a15050dAb` |
| `Fleets` | `0x6e745F432157DB6Dd3EC1e040c082C6daFa30010` |
| `Maps` | `0x348Be44Fdb5129A48d39445e0C897E007879BE20` |
| `Tournament` | `0x38b3247d6E6e4ee31F3d7f53CdFbAb6874D7Df26` |
| `GameResults` | `0xA6f6Ec4660eE86B4E23e320b38D27D2821937bcD` |
| **`GameEngineRegistry`** (new contract) | `0xd58a2748Df9c28792C2F9B2da4D4a18Cec6f62ff` |

**Full list**: every other contract (token/reward contracts, resolvers, win effects, renderers, etc.)
also has a new address — see `ignition/deployments/chain-84532/deployed_addresses.json` in this repo
for the complete, authoritative set (109 entries). Don't hand-copy from this doc for anything not
listed above; pull the JSON.

---

## 2. New: `GameEngineRegistry`

### 2.1 Why this exists

The contracts now support shipping a gameplay-rules change (e.g. a combat-mechanics fix) as a brand
new `Game` contract + its orchestrators (`PvPMatch`/`SinglePlayerMatch`/`RoguelikeMatch`), wired to
reuse all the existing shared infrastructure (`Ships`, `Fleets`, `Maps`'s ~65 preset maps, tokens,
etc.) — **without a full redeploy**, and without disturbing games already in progress on the previous
"engine." Today's redeploy still only has one engine, so this is mostly future-proofing, but the
lookup mechanism is live now and worth wiring in.

### 2.2 What to actually do

For any `gameId` you don't already have a known `Game` contract address for (e.g. you're recovering
game state after clearing local storage, or loading a shared link to someone else's match), resolve
it trustlessly instead of assuming it's whatever `Game` address you have hardcoded:

```solidity
address gameContract = gameEngineRegistry.engineOfGame(gameId);
```

- Returns `address(0)` if this exact `gameId` was never recorded (e.g. a game older than this
  registry's own deployment, or on an engine whose orchestrator wasn't wired to record — shouldn't
  happen for anything created after today). Fall back to your currently-known `Game` address in that
  case.
- For **new** games you're about to create, you don't need this at all — `Lobbies`/`SinglePlayerMatch`/
  `RoguelikeMatch` already know which `Game` engine they talk to; just call `createLobby`/
  `startNodeMatch`/`startRun` as before. The registry is for **resolving an existing gameId back to its
  Game contract**, not for picking where a new game goes.
- `gameEngineRegistry.currentEngine()` — the `Game` address a *brand-new* game would be created
  against right now, if you want to display "what version am I about to play." With one engine live,
  this always equals the `Game` address in §1.
- `gameEngineRegistry.getEngines()` — every engine ever registered, in order, for a "which version was
  this" / changelog-style display if wanted. Not required for core gameplay.

None of this is consulted on-chain by `moveShip` or any other per-turn call — it's a pure off-chain/FE
convenience lookup, so there's no gas cost to using it and no behavior change to account for.

---

## 3. Disabled-ship blocking exception — now live

Already fully documented in
`docs/frontend-handoff-combat-blocking-and-ship-specials-2026-09-26.md`'s 2026-09-28 update note — not
repeating it here. The only thing that changed is its deployment status: that note said "Still not
deployed"; as of today's redeploy, it **is** deployed. If your client-side move/shot preview (if you
built one) already accounts for this per that note, no further action. If you haven't built that
preview yet, or have been working around the "not deployed yet" caveat, you can drop the workaround.

---

## 4. ABI / struct shape changes

### 4.1 `Lobbies` — `LobbyGameConfig` gained `pvpMatch`

`Lobbies.getLobby(lobbyId)` (and the raw `lobbies(lobbyId)` public mapping getter) return a `Lobby`
struct that nests a `LobbyGameConfig`. That nested struct gained one new trailing field:

```solidity
struct LobbyGameConfig {
    bool creatorGoesFirst;
    uint turnTime;
    uint selectedMapId;
    uint maxScore;
    address pvpMatch;   // NEW
}
```

`pvpMatch` is the engine this specific lobby's game will start on (or started on) — pinned at lobby
creation, not necessarily whatever `Lobbies.pvpMatch()` currently points at live. With one engine
live, this is always the same address as `Lobbies.pvpMatch()`/the `PvPMatch` address in §1. It only
diverges in the (currently hypothetical, one-engine-only) case of a lobby created just before an
engine swap — not something you need to special-case today, just know the field is there.

### 4.2 `RoguelikeRun` — `Run` gained `requiredVariantAtStart`

`RoguelikeRun.getRun(player)` returns a `Run` struct that gained one new trailing field:

```solidity
struct Run {
    RunStatus status;
    uint generation;
    uint campaignId;
    uint currentNodeId;
    uint currentCostCap;
    uint reservationFleetId;
    uint[] rosterShipIds;
    uint activeGameId;
    uint16 requiredVariantAtStart;   // NEW
}
```

The campaign's required faction, pinned at `startRun` (0 = unrestricted). This is what
`RoguelikeResupply.resupplyModifyRoster` actually enforces for that run's resupply stops — it no
longer re-reads the campaign's *current* live requirement, so if you were computing "can I add this
ship" client-side by reading `RoguelikeNodeMap.campaignRequiredVariant(campaignId)` directly, switch to
reading `run.requiredVariantAtStart` instead so your client-side check matches what the contract will
actually enforce.

---

## 5. New revert reasons

- **`Tournament.addSponsorPrize(tournamentId)`** — new error `NoSponsorContribution()`. Reverts if
  called with `msg.value == 0` while no sponsor has been set yet for that tournament (previously this
  silently claimed the sponsor slot for free, permanently blocking a real sponsor). If your UI has an
  "add sponsor" flow, make sure it can't submit a zero-value transaction before a sponsor exists —
  either disable the button below some minimum, or handle the revert.
- **`Fleets.createFleet(...)`** — new error `DuplicateShipId()`. Reverts if the same ship id appears
  more than once in the `_shipIds` array. Reached from every human-facing fleet/roster-submission entry
  point: `Lobbies.createFleet`, `SinglePlayerMatch.startNodeMatch`, `RoguelikeMatch.startRun`,
  `RoguelikeMatch.enterCombatNode`, and `RoguelikeResupply.resupplyModifyRoster` (its `_shipIdsToAdd`
  array). Validate client-side before submitting (no duplicates in whatever ship-selection array you're
  about to send) to avoid a wasted revert — this should never happen from normal fleet-builder UI, only
  from a bug or a malformed manual call.

Both are new, additive errors — nothing that previously succeeded now fails; these only reject inputs
that used to silently misbehave (sponsor squatting) or slip through into a later, harder-to-diagnose
failure (duplicate ship ids).

---

## 6. New informational events

Neither of these needs to be handled for the core player-facing flow — both represent a rare backend
misconfiguration case degrading gracefully instead of bricking something, and are only useful for
admin/support-side monitoring:

- **`PvPMatch.GameResultRecordFailed(uint indexed gameId, address indexed winner, address indexed loser)`**
  — fires instead of reverting if writing the match result to `GameResults` fails for some reason. The
  game itself still ends normally (winner recorded on `Game`, ships released) either way; only the PvP
  leaderboard entry would be missing if this ever fires. Shouldn't happen under normal operation.
- **`UTCLotteryHook.PrizeMintFailed(uint256 indexed drawId, address indexed winner)`** — fires instead
  of reverting if minting a lottery draw's prize ship fails (e.g. the winning address can't receive an
  ERC-721 for some reason). The draw still resolves either way; the winner just doesn't receive their
  prize automatically in that case. If you have a "did I win" UI for the lottery, this event is the
  signal to show "resolved, prize mint failed" instead of "prize sent."

---

## 7. Everything else — no FE action needed

A large batch of internal security and upgrade-safety hardening went into this redeploy. None of it
changes any ABI signature you weren't already using, none of it introduces a new revert reachable from
normal play, and all of it is either admin-only or a transparent internal snapshot with an unchanged
read surface. Listed here only so nothing looks suspiciously undocumented if you go digging through the
diff yourself:

- Several `onlyOwner` setters across `Game`, `PvPMatch`, and `SinglePlayerOrchestratorRegistry` are now
  permanently locked once the contract has processed its first real game/orchestrator registration —
  purely an admin-side safety rail against an accidental live-config change breaking in-flight games.
- `Game`'s heal-cap percentage, the AI opponent's "brain" registry (`SinglePlayerMatch`/
  `RoguelikeMatch`), a combat node's final-node/auto-heal/win-effects determination, and a ram/resolver
  dispatch path are all now pinned per-game/per-run at the moment they start, rather than re-read live —
  closes a class of "an admin balance change mid-match retroactively affects an already-started game"
  edge cases. Every existing read function you already call for these still returns the same shape.
- `Maps`' debug tile-editing functions (`setBlockedTile`/`setImpassableTile`/`setScoringTile` —
  admin/debug tooling only, never called by the normal player flow) now refuse to edit an already-ended
  game.
- `RoguelikeNodeMap.removeChild` (admin content-editing only) now refuses to remove a node's last
  remaining child if a player's run is currently standing there, to prevent an admin content edit from
  ever stranding an in-progress run.

If you're building admin/backend tooling that calls any of the above setters directly, expect the new
guards; the normal player-facing FE never touches any of these.

---

## Appendix: full context

The underlying work is recorded in `docs/upgrade-safety-audit-2026-09-29.md` (the pinning/guard fixes
in §7 above, findings UA-01 through UA-16) and `docs/audit-2.md` (the security fixes, findings HA4-01
through HA4-07, and the `GameEngineRegistry` architecture itself) if deeper rationale is ever needed —
neither is required reading for frontend integration; everything actually FE-relevant from both is
already pulled into §§1-6 above.

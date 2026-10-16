# Void Tactics — Selfie Check Gating + Uniswap Lottery Hook: FE/BE Integration Guide

> **Written 2026-09-12.** Describes contract state as of this date, before the
> real redeploy that ships it. Re-check against this repo's actual source if
> read much later — the addresses below are `TBD` until that redeploy and the
> follow-on Uniswap pool deploy both happen; see
> `docs/deploy-runbook-uniswap-lottery.md` (this repo, not yours) for that
> sequence.
>
> **Audience:** the frontend + backend service repo (not this contracts repo).
> **Chain:** Base Sepolia (`84532`).
> **Companion docs (this repo):** `docs/eth-global-remote-strategy-v2.md`
> (Pick 2/Pick 3 design reasoning), `docs/pre-audit.md` (search "SC-01" for
> the eligibility-gating audit history), `contracts/UTCLotteryHook.sol` /
> `contracts/SelfieCheckEligibilityProvider.sol` / `contracts/FreeShipClaim.sol`
> / `contracts/TutorialClaim.sol` (source of truth for everything below).

This guide covers two independent, unrelated features that both shipped this
session: (1) gating free-ship claims and tutorial completion behind Selfie
Check verification, and (2) a Uniswap v4 hook that runs a lottery for anyone
who sells UTC for ETH in the game's pool. Nothing here has been deployed for
real yet — see the "Known gaps" section at the end before building against
this as if it's live.

---

## 1. Constants — fill in after deploy

> Collect from `ignition/deployments/chain-84532/deployed_addresses.json`
> (for everything except the hook/pool) after the redeploy, and from
> `docs/deploy-runbook-uniswap-lottery.md`'s Phase 2 output (for the hook/pool)
> once that's run. ABIs come from this repo's
> `artifacts/contracts/<Name>.sol/<Name>.json` (the `abi` field).

| Contract | Address |
|---|---|
| `SelfieCheckEligibilityProvider` | `TBD` |
| `FreeShipClaim` | `TBD` |
| `TutorialClaim` | `TBD` |
| `UniversalCredits` (UTC) | `TBD` |
| `Ships` | `TBD` |
| `UTCLotteryHook` | `TBD` (does not exist until Phase 2 of the deploy runbook runs) |

| Uniswap v4 infra (Base Sepolia — fixed, not project-specific) | Address |
|---|---|
| `PoolManager` | `0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408` |

The pool's `PoolKey` (needed for every swap/liquidity call) is:

```ts
const key = {
  currency0: "0x0000000000000000000000000000000000000000", // native ETH
  currency1: "TBD", // UniversalCredits address, checksummed
  fee: 3000,        // 0.3%
  tickSpacing: 60,
  hooks: "TBD",     // UTCLotteryHook address
};
```

---

## 2. Roles

| Role | Who | Responsibilities |
|---|---|---|
| **Player** | end users | Sell UTC for ETH to earn lottery entries; claim free ships / complete tutorial (once Selfie Check-verified, if a provider is wired). |
| **Selfie-Check-verifying backend** | your relayer, authorized on-chain via `setAuthorizedVerifier` | Runs a Selfie Check against World's off-chain API, then calls `SelfieCheckEligibilityProvider.markVerified` on success. Holds no power beyond that one call — it cannot mint, transfer, or alter anything else. |
| **Contract owner** (`MAP_EDITOR` after the redeploy's ownership handover) | project admin wallet | Authorizes/revokes verifier backends, tunes lottery parameters, curates prize templates, grants ship-minting rights. |

---

## 3. Selfie Check eligibility gating

### 3.1 Why this shape

Selfie Check has **no on-chain verification path** — unlike Orb-level World
ID (which `Tournament.sol` already uses on-chain via `IWorldID`), Selfie Check
verification is an off-chain REST call against World's API. **This repo's
contracts have zero dependency on that API's exact request/response shape —
that lives entirely in your backend.** Confirm the current schema directly
against World's own developer docs before implementing; what's confirmed from
this session's research is only: it's an off-chain call (no proof for a
contract to verify), and a successful verification carries a real ~90-day
validity window, which `SelfieCheckEligibilityProvider.VERIFICATION_VALIDITY_PERIOD`
deliberately mirrors (see 3.3).

So the pattern is a trusted backend relay: your service verifies a Selfie
Check off-chain, then calls one on-chain function to record that a wallet
address is verified for a fixed window. This mirrors the same pattern this
project already uses elsewhere for Fireblocks Flow fulfillment (a backend
confirms something off-chain, then an authorized address relays the result
on-chain).

### 3.2 The interface (`IEligibilityProvider`)

```solidity
interface IEligibilityProvider {
    function isEligible(address _player) external view returns (bool);
}
```

`FreeShipClaim` and `TutorialClaim` **share one instance** of whatever
implements this — verifying a wallet once makes it eligible for both, for the
same window. Don't expect two separate verification flows.

### 3.3 `SelfieCheckEligibilityProvider` — your backend's contract surface

```solidity
uint256 public constant VERIFICATION_VALIDITY_PERIOD = 90 days;
mapping(address => bool) public authorizedVerifiers;
mapping(bytes32 => bool) public usedNullifiers;
mapping(address => uint256) public verifiedUntil;
bool public nullifierCheckEnabled = true; // owner kill switch

event PlayerVerified(address indexed player, bytes32 indexed nullifierHash, uint256 verifiedUntil);
event AuthorizedVerifierSet(address indexed verifier, bool isAuthorized);
event NullifierCheckEnabledSet(bool enabled);

error NotAuthorizedVerifier(address caller);
error NullifierAlreadyUsed(bytes32 nullifierHash);

// Your backend's ONE call, after confirming a Selfie Check pass off-chain.
// msg.sender must be on the authorizedVerifiers allowlist (owner-granted).
function markVerified(address _player, bytes32 _nullifierHash) external;

// Read-only, used internally by FreeShipClaim/TutorialClaim — you generally
// don't need to call this directly, but it's how the UI can pre-check.
function isEligible(address _player) external view returns (bool);
```

- **`_nullifierHash`**: derive this from whatever unique identifier World's
  Selfie Check response gives you for the verified human, so the same person
  can't back multiple wallets. `usedNullifiers` blocks reuse; the owner can
  disable that specific check via `setNullifierCheckEnabled(false)` without
  disabling verification entirely, if it turns out to cause false positives.
- **`markVerified` reverts** `NotAuthorizedVerifier` if your backend's wallet
  isn't on the allowlist — confirm with the project owner that your relay
  address has been granted via `setAuthorizedVerifier(yourAddress, true)`
  before going live. `FIREBASE_FLOW_MINTER` (`0x7f9dc2D68FF842EC79DA722B68E3ca7e5aa31CCb`)
  is authorized on this contract as of the redeploy per the current plan —
  confirm whether that's the actual key your backend will sign with, or
  whether a distinct key gets provisioned before this goes live (see
  `docs/pre-audit.md`'s key-separation addendum in the contracts repo).
- `verifiedUntil[player] > block.timestamp` is the eligibility check —
  verification is a rolling 90-day window from whenever `markVerified` last
  ran for that address, not a one-time flag.

> **Updated 2026-10-15** (`docs/audit-3.md` HA6-14): renewal now actually works.
> - **Same wallet:** re-running `markVerified(player, sameNullifier)` refreshes the window. It used to revert `NullifierAlreadyUsed`, which locked every player out after 90 days.
> - **Different wallet:** the same nullifier on a different wallet still reverts.
> - **Wallet moves:** for a real person who moved wallets, the owner calls `releaseNullifier(nullifier)`. That ends the old wallet's eligibility, and the new wallet can then be verified.
> - **New views and events:** `nullifierOwner(bytes32)` and the `NullifierReleased(nullifierHash, previousOwner)` event.

### 3.4 What changed in `FreeShipClaim` / `TutorialClaim`

Both now have exactly **one** claim/complete entry point each, and it's the
gated one — there is no separate "unverified" path running alongside a
"verified" one. The check is inline:

```solidity
// FreeShipClaim.claimFreeShips — unchanged signature, new leading check:
function claimFreeShips(uint16 _variant) external; // nonReentrant
// Reverts NotEligible(msg.sender) if eligibilityProvider is set and
// !eligibilityProvider.isEligible(msg.sender).

// TutorialClaim.completeTutorialWinPath() / completeTutorialLossPath() —
// unchanged signatures, same NotEligible check via a shared internal helper.
```

```solidity
event EligibilityProviderSet(address indexed provider); // both contracts
error NotEligible(address player);                       // both contracts
```

**Important:** if `eligibilityProvider` is unset (`address(0)`), both stay
**fully open** — this is the same "not configured yet" pattern as
`FreeShipClaim.droneStorefront == address(0)` elsewhere in this repo, not a
gate with a bypass door. Once a real provider is wired (which the redeploy
does — see the deploy runbook), there is no alternate path; every claim/
completion genuinely requires `isEligible(msg.sender) == true`. **Build your
UI to check eligibility before showing a claim button, not just catch the
revert** — `NotEligible` is a real, expected outcome for any never-verified
wallet, not an edge case.

`FreeShipClaim.claimFreeShips` also now emits, for the first time on the live
deployment (previously source-only):
```solidity
event FreeShipsClaimed(address indexed player, uint256 amount);
```

---

## 4. UTC Lottery Hook (Uniswap v4)

### 4.1 What it does

Every UTC→ETH ("sell") swap through the game's Uniswap v4 pool earns the
seller weighted entry into a periodic drawing for a prize ship — funded by
nothing but chance, no fees taken, no swap economics altered. Buys (ETH→UTC)
never earn entries. One entry per address per draw, sized to that address's
single **best** qualifying sell in the draw period (not a sum — see
`contracts/UTCLotteryHook.sol`'s header comment for why).

### 4.2 CRITICAL — how the hook knows who's trading

The hook has **no reliable way to know the real trader's identity** from
`msg.sender`/`sender` (that's whatever router relayed the swap, e.g. Uniswap's
Universal Router — not the end user) or `tx.origin` (rejected outright — see
`CLAUDE.md`'s "Never Use `tx.origin`" rule in the contracts repo; it
misattributes any trade made through a smart-contract wallet, which this
project's Dynamic-based wallet auth makes a real case, not hypothetical).

**Your swap call must pass the trader's real address as `hookData`,
ABI-encoded as a single `address` (exactly 32 bytes):**

```ts
import { encodeAbiParameters, getAddress } from "viem";

const hookData = encodeAbiParameters(
  [{ type: "address" }],
  [getAddress(traderWalletAddress)],
);
```

If `hookData` is missing, malformed, or not exactly 32 bytes, the swap still
succeeds normally — it just silently earns no lottery entry. There is no
error/revert for this, by design (a swap must never fail because of it), so
**test this specifically** — a UI bug that forgets to pass `hookData` will
look completely fine to a player and only show up as "why didn't I get an
entry."

### 4.3 No production router is wired up by this repo yet

This repo's own deploy/test tooling only uses Uniswap's **official test-only**
routers (`PoolSwapTest`/`PoolModifyLiquidityTest`) for admin liquidity-seeding
and smoke-testing — not something end users should swap through. **You need
to decide and build the actual player-facing swap path** — most likely
Uniswap's Universal Router + Permit2 (the standard production v4 integration
path), or a direct `PoolManager` unlock-callback integration if you want more
control. Either way, the `hookData` requirement above applies regardless of
which router you choose — it's a swap-level parameter the hook reads directly
off the `afterSwap` callback, not something router-specific.

Swap direction reminder: `zeroForOne: false` (currency1/UTC → currency0/ETH)
is a sell and earns entries; `zeroForOne: true` is a buy and does not.

**Confirmed 2026-09-18 — do not link out to Uniswap's own hosted swap UI
(app.uniswap.org) for the sell-to-earn-entry flow, even where it's
available.** This was checked directly, not assumed: as of this writing,
Uniswap's hosted interface doesn't list Base Sepolia in its network switcher
at all (per Uniswap's own "Testnets on Uniswap" support article), but that's
not actually the operative reason — **even if it did support this network,
it has no way to know about this hook's custom `hookData` convention**, so a
sell routed through it would execute completely normally and silently earn
no entry, for the same reason described in 4.2 above. This applies to *any*
third-party swap interface, not just Uniswap's own — the `hookData`
requirement is project-specific, not something any external router or UI
has a reason to implement. Build the sell-side swap directly (4.3); the buy
direction (native → UTC) has no such requirement and is unaffected by any of
this.

### 4.4 Read functions for UI

```solidity
uint256 public currentDrawId;
mapping(uint256 => mapping(address => bool)) public hasParticipated;   // [drawId][player]
mapping(uint256 => mapping(address => uint256)) public weightInDraw;   // [drawId][player] -> wei
mapping(uint256 => uint256) public totalWeightInDraw;                  // [drawId]
mapping(uint256 => bool) public drawResolved;                          // [drawId]

uint256 public minEntryThresholdWei;  // min ETH proceeds a sell must clear to earn an entry
uint256 public drawInterval;          // seconds since last draw start before a new one can begin
uint256 public minParticipants;       // min distinct qualifying sellers before a draw can start
uint256 public minTotalWeightWei;     // min total qualifying volume before a draw can start
uint256 public lastDrawTime;

function queueLength() external view returns (uint256); // curated prizes waiting; 0 == next draw uses random 4-star fallback
```

A draw only starts once *all* of `drawInterval` elapsed, `minParticipants`
distinct sellers, and `minTotalWeightWei` total volume are satisfied — time
alone is deliberately not enough. If a draw hasn't reached eligibility, it
just keeps accumulating (no reset) until a later qualifying swap pushes it
over. There's no dedicated "is a draw ready to start" view function — it's
evaluated internally on every qualifying swap. If your UI wants to show
"draw pending," compute it client-side from the values above.

### 4.5 Events

> **Superseded 2026-10-14:** `DrawStarted` was replaced by `DrawClosed`, and draws now resolve automatically. See `docs/frontend-handoff-lottery-prize-retry-2026-10-14.md` for the current §4.5/§4.6 behavior.

```solidity
event SellRecorded(uint256 indexed drawId, address indexed player, uint256 ethProceeds, uint256 playerWeightInDraw);
event DrawStarted(uint256 indexed drawId, uint256 requestId, uint256 totalWeight);
event DrawResolved(uint256 indexed drawId, address indexed winner);
event PrizeQueued(uint256 indexed queueIndex);
event PrizeQueueCleared();
```

`SellRecorded` fires on every qualifying sell (not every swap) — use it to
confirm a trade actually earned an entry, rather than assuming from the swap
tx alone. `DrawResolved`'s `winner` is who got the prize ship; the ship itself
is minted directly to them in the same transaction (no separate claim step).

### 4.6 Resolving a draw

```solidity
function resolveDraw(uint256 _drawId) external; // permissionless
```

Callable by anyone once a draw has started (`DrawStarted` fired) and enough
time has passed for the underlying `RandomManager` request to be revealable
(same commit-reveal pattern `Tournament.buildBracket`/`Ships.constructShip`
already use elsewhere in this project — not a Chainlink VRF dependency). Your
backend can call this proactively (like it might for `Tournament`'s
equivalent flows) rather than waiting for a player to notice a draw needs
resolving, since there's no UX benefit to leaving it unresolved.

---

## 5. Known gaps — check before building against any of this as if it's live

- **Nothing is deployed yet.** Every address above is `TBD`. Confirm with the
  contracts repo (or `docs/deploy-runbook-uniswap-lottery.md`) that both
  redeploy phases have actually run before wiring real addresses in.
- **No backend Selfie Check relay exists yet.** Until your service actually
  implements the off-chain-verify-then-`markVerified` flow, `FreeShipClaim`/
  `TutorialClaim` will revert `NotEligible` for every wallet (once the real
  provider is wired — see 3.4's "no alternate path" note). Coordinate timing
  with the contracts-repo redeploy so players aren't locked out with no
  working verification flow to unlock them.
- **No production swap router exists yet** (see 4.3) — this is real, unbuilt
  frontend/backend work, not just a config value to fill in.
- **The prize queue starts empty** — every draw uses the random-4-star
  fallback until the contract owner curates real `PrizeTemplate`s. Don't
  assume winners always get a hand-crafted "Legendary Draw #N" ship; check
  `prizeShip.name` if your UI wants to distinguish the two cases (a queued
  template's ship has a non-empty name starting with `"Legendary Draw #"`
  and `shiny: true`; the fallback path mints via the ordinary random-generation
  flow — its stats aren't revealed until the winner calls `constructShip`
  themselves, same as any other purchased ship).

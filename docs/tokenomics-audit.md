# Void Tactics — Tokenomics / Economy Audit

_Created 2026-09-16._ Scope: economic soundness of value-flow paths (UTC/UniversalCredits
minting and burning, DEC rewards, FLOW pricing, referral payouts, fee splits, the UTC/FLOW
peg) — assuming a maximally hostile, profit-seeking actor. The question throughout isn't "can
they break the game," it's "can they mint, extract, or farm more real value than they
legitimately put in." This is a different lens from the correctness/security audits in
`docs/pre-audit.md`/`docs/audit-2.md` (all HA2-*/HA3-* findings there are fixed) and the pure
gas-cost audit in `docs/gas-audit.md` — findings here are new, not duplicates of either.

This is audit-only, matching this project's established workflow: findings are recorded here,
not implemented, until the project owner picks one to fix. No `.sol` files were changed while
writing this doc. Findings use an `ECON-XX` prefix (distinct from Tournament.sol's own internal
`T-0X` code comments, which refer to already-implemented features, not audit findings) and the
same strikethrough-on-fix convention as the other audit docs.

Two parallel passes fed this doc: one on minting/reward paths (UniversalCredits, ShipPurchaser,
Ships.sol's purchase/referral/recycle flow, DestroyRewardLib, win-effect reward contracts,
FreeShipClaim/TutorialClaim), one on pricing/fee mechanisms (DroneYard, Tournament's prize
split, Lobbies' fee logic, UTCLotteryHook's entry-qualifying mechanism, VariantPurchaseGate,
ShipAttributes' cost versioning). ECON-01 was independently re-verified against current source
line-by-line before its initial write-up, including a full worked numeric trace and an on-chain
proof-of-concept (`test/ECON01_PoC.test.ts`) — that verification of the *mechanism* stands, even
though the original *severity conclusion* was corrected through discussion with the project
owner (see ECON-01's reassessment note below). No native token should be assumed to be any
specific chain's asset; findings below use "native token" generically.

---

## Low

### ECON-02 — `DroneYard._calculateCostToModify`'s Cost-Doubling Loop Has an Unreachable-in-Practice Overflow-Revert Point

**File:** `contracts/DroneYard.sol`, `_calculateCostToModify` (the `costMultiplier *= 2` loop)

Once a ship's cumulative `shipData.modified` (confirmed genuinely cumulative — `Ships.sol`
does `+= amountModified`, not a boolean flag, despite a stale comment elsewhere suggesting
otherwise) reaches 256 total modifications, `costMultiplier` would need to double past `2^255`,
overflowing `uint256` under Solidity 0.8's default checked arithmetic — the ship becomes
permanently unmodifiable via `DroneYard`, forever, with no recovery path.

**Not practically reachable**: the exponential cost curve means `totalModifications ≈ 80-100`
already costs more UTC than any realistic token supply could fund, long before 256. Confirmed no
free/repeatable path exists to increment `shipData.modified` outside the paid `modifyShip` flow.

**Fix (cheap insurance, not urgent):** add a defensive cap, or switch the loop to a bit-shift
(`1 << totalModifications`, same result, no realistic revert risk at these magnitudes either, but
marginally cheaper and no worse) as belt-and-suspenders.

---

## Informational

### ~~ECON-01 — `Ships.purchaseWithFlow`'s FLOW-Denominated Referral, Stacked With `shipBreaker` Recycling, Extracts Real Protocol Revenue~~

**Reassessed 2026-09-16, after discussion with the project owner — not an exploit.** The
mechanism below was verified accurately (including with a real on-chain PoC), but the original
conclusion was wrong. See "Corrected understanding" at the end of this entry; the original
write-up is kept intact above it for the record, per this repo's documentation convention.

**File:** `contracts/Ships.sol` — `purchaseWithFlow` (149-176), `_processReferral` (532-560),
`shipBreaker` (736-...); `contracts/ShipPurchaser.sol` — `purchaseUTCWithFlow` (91-107, the
protocol's own documented UTC/native-token peg definition)

**Distinct from the already-reviewed-and-accepted `pre-audit.md` L-07** (self-referral on
`ShipPurchaser`'s UTC-denominated path — harmless, since the referral payout there comes out of
the *same currency* being distributed, bounding it to a discount that nets to a wash). This
finding is a different mechanism: `Ships.sol` has its *own*, separate `_processReferral`, paid in
**real native FLOW**, on a purchase path whose product (ships) can be immediately converted back
into UTC at a protocol-defined 1:1 peg via recycling — and unlike `ShipPurchaser`'s UTC-side
referral, nothing discounts the recycled side to compensate.

**The peg, confirmed directly from source:** `ShipPurchaser.purchaseUTCWithFlow`'s own comment
states it plainly — `"Mint the UTC equivalent of buying + recycling this tier's ship pack"` —
and mints `tierShips[_tier] * ships.recycleReward()` UTC for exactly `tierPrices[_tier]` FLOW.
This is the protocol's explicit, intentional definition: `tierShips[tier] * recycleReward` UTC
**is** worth `tierPrices[tier]` FLOW. Buying a tier's ships via `Ships.purchaseWithFlow` and then
recycling all of them via `shipBreaker` reaches this exact same peg by an alternate route — on
its own, a break-even loop, not a bug (an intentional alternate on-ramp, not exploitable by
itself).

**The exploit — verified line-by-line, not just trusted:**
- `Ships.purchaseWithFlow(_to, tier, _referral, variant)` requires `msg.value ==
  tierPrices[_tier]` (real FLOW), mints `tierShips[tier]` ships, then — since (unlike
  `purchaseUTCWithFlow`) this function *does* accept a `_referral` address — calls
  `_processReferral(_referral, totalShips, tierPrices[_tier])`.
- `_processReferral` pays `payable(_referrer).call{value: referralAmount}("")` where
  `referralAmount = (_salePrice * referralPercentage) / 100` — **real FLOW**, not UTC.
  `referralPercentage` scales with the referrer's cumulative `referralCount` (hardcoded tiers:
  0% under 1,000, 10% at 1,000+, 20% at 10,000+, 35% at 50,000+, 50% at 100,000+).
- `shipBreaker` mints `recycleReward` (0.1 UTC default) per non-previously-destroyed ship burned,
  **completely independent of what was paid for the ship** — no check for discount, referral, or
  purchase price at all (the only gate is `isFreeShip`, which correctly blocks the *unrelated*
  free-claim paths, but does nothing here since `purchaseWithFlow`-minted ships aren't free
  ships).

**Worked numbers:** self-refer (or use a second address you also control — this doesn't require
defeating Sybil resistance, which this project's own design notes already treat as infeasible
on-chain). Pay `P = tierPrices[tier]` FLOW. Same transaction, receive back `R = P *
pct/100` FLOW. Net FLOW outlay: `P*(1 - pct/100)`. Recycle all minted ships: receive UTC worth,
by the protocol's own peg, exactly `P` FLOW-equivalent. **Profit per cycle: `P * pct/100`,
funded directly out of `Ships.sol`'s FLOW balance** — the same balance `withdraw()` (owner-only)
expects to be genuine sale revenue. At the 10% tier (reachable after ~1,000 cumulative referred
ships — attainable with ordinary repeated purchases, no special privilege) every cycle nets 10%
of the tier price back as pure profit; at the 50% tier, nearly double. Fully repeatable, no
per-transaction cap beyond the tier price itself.

**Why this isn't just "another instance of L-07":** L-07's self-referral is economically inert
because the payout and the thing being discounted are the *same currency* (UTC), so a self-payer
is just moving their own money in a circle. Here the referral is paid in FLOW while the
recyclable product (UTC, via the ships) is untouched by the discount — the two don't net against
each other, so the referral is uncompensated, real, extractable value every single cycle.

**Fix candidates considered at the time (kept for the record — none were needed; see "Corrected
understanding" below):**
1. Require `_referral != msg.sender` / `_referral != _to` — closes literal self-referral but not
   collusion via a second address (the same actor controls both) — likely insufficient alone.
2. Switch `Ships.sol`'s referral to be UTC-denominated (deducted from/capped by the recyclable
   value), matching `ShipPurchaser`'s already-safe L-07 pattern — closes the arbitrage at the
   root, but is a real behavior change (referrers currently expect a FLOW payout).
3. Prevent (or claw back / time-lock) recycling for ships minted via a referred purchase — targets
   the actual buy→recycle cycle directly, but adds real state-tracking complexity.
4. Cap `referralAmount` relative to `tierShips[tier] * recycleReward`'s FLOW-equivalent value —
   reduces the margin but doesn't eliminate it (any nonzero referral still leaves *some*
   uncompensated profit, per the math above).

**Corrected understanding (2026-09-16), after discussion with the project owner:**

The native-token-denominated self-referral is an accepted, by-design cost of the referral
program — not itself a bug. The relevant question is only whether stacking it with recycling lets
a player exceed the referral program's own bound, and it doesn't: `referralPercentages` hard-caps
at 50% (the array has no higher tier), and `recycleReward` is a flat, purchase-price-independent
constant, so the combination can't be leveraged past that ceiling. Effective UTC-minting cost via
this route ranges from the full peg (`tierPrice / (tierShips * recycleReward)`, ≈8.33
native-token per UTC at tier 4, 0% referral) down to exactly half that (≈4.17 native-token per
UTC) at the maxed-out 50% referral tier — never lower.

Once a liquid UTC market exists (e.g. the planned Uniswap v4 lottery pool, seeded from this same
peg), this becomes a supply-side arbitrage rather than a direct drain: mint UTC at the discounted
cost, sell it on the market, repeat. As long as market price sits above the arbitrageur's mint
cost, this keeps adding sell-side supply and pushes market price down; it stops being profitable
once market price reaches the mint-cost floor. With referral-tier access unrestricted (anyone can
ramp their own `referralCount` up with ordinary repeated purchases — no Sybil resistance needed or
assumed to exist here), that floor converges toward roughly 50% of the peg's full price, matching
the project owner's own economic model. This is expected, self-limiting market behavior, not an
uncapped extraction — there's no fix needed here.

Checked for a cheaper alternative floor before accepting this: free ships
(`FreeShipClaim`/`TutorialClaim`) cannot be recycled at all (`Ships.sol`'s `shipBreaker` reverts
with `CannotRecycleFreeShip` on `isFreeShip` ships) — so the 50%-off self-referral purchase really
is the cheapest way to obtain a recyclable ship; nothing pushes the floor lower. Also confirmed
the "UTC only ever enters the economy via a native-token-backed purchase" premise holds even
through combat kills: `ShipsRouter.setTimestampDestroyed` pays a killer `recycleReward >> 2` (25%)
via `DestroyRewardLib`, and if the original owner later recycles that same now-destroyed ship,
`shipBreaker` only pays them `recycleReward >> 1` (50%) — 75% total, split between killer and
owner, never more than one clean recycle (100%) would have paid. No new/free UTC source, just a
redistribution of one purchase's backing.

**Residual item spun out of this analysis, since closed:** an earlier pass of this section flagged
`ShipPurchaser.purchaseWithUC`'s pricing as inconsistent with this mint peg (tracked as ECON-06).
That comparison used the wrong benchmark — see ECON-06 under "Reviewed, no issue found" for the
corrected analysis.

### ~~ECON-03 — `VariantPurchaseGate` Only Enforces at Mint Time, Not on Transfer~~

**Confirmed intentional by the project owner, 2026-09-16 — left as is, no change needed.**

**File:** `contracts/VariantPurchaseGate.sol`; `contracts/Ships.sol:508` (`checkGate` called only
from `_mintShip`)

Standard, common NFT-gated-mint behavior (gate at mint, freely tradeable after) and very likely
intentional — flagged only because `DroneYard.sol`'s own comment on `_validateShip` explicitly
frames "closing the buy-cheap-then-convert bypass around variant purchase gates... at the root"
as a deliberate design goal, suggesting the project cares about this gate's integrity beyond just
mint-time. Worth an explicit design confirmation (matching how other accepted-intentional items
are tracked in `audit-2.md`), not a fix by default.

Confirmed: the gate is meant to restrict who can *mint* a gated variant, not who can *own* one
afterward — ordinary secondary-market resale of an already-minted gated-variant ship to a
non-holder is expected behavior, same as most NFT-holder-gated mints. `DroneYard`'s
variant-immutability guard closes a different bypass (minting around the gate indirectly via
modification) and doesn't imply transfer-time enforcement was also intended.

### ~~ECON-04 — Stale "(soulbound)" Comment in `DestroyRewardLib.sol` Contradicts DEC's Actual, Intentional Design~~

**Fixed 2026-09-16** — removed the stale "(soulbound)" word from the comment at
`contracts/DestroyRewardLib.sol:21`. Doc-only change, no behavior affected.

**File:** `contracts/DestroyRewardLib.sol:20`

`DroneEnergyCores.sol`'s own header comment states DEC is "Deliberately not soulbound: a player
who has time but not money can grind DEC and sell it" — matching the project's actual intended
design (see also this session's memory notes on the DEC economy design). The word "(soulbound)"
in `DestroyRewardLib`'s comment is stale/wrong documentation, not a behavior bug — the actual
mint call and token contract are correct. One-line doc fix, not a code fix.

### ECON-05 — Collusive Free-Ship Kill-Farming Nets a Small, Already-Bounded UTC Reward

**File:** `contracts/FreeShipClaim.sol`, `contracts/DestroyRewardLib.sol`

Two Sybil-controlled accounts can each claim free ships (`FreeShipClaim.claimFreeShips`, 10 free
ships, no cost beyond gas), use their one free `Lobbies.createLobby` game each, and have one
side's ships kill the other's uncontested for `DestroyRewardLib`'s flat `recycleReward >> 2`
(0.025 UTC) per kill — up to 10 kills = 0.25 UTC for near-zero real cost. Not a serious drain:
free ships can't be recycled (`CannotRecycleFreeShip`), the per-kill rate is tiny, and any
*repeat* game costs real FLOW (`additionalLobbyFee`) that almost certainly exceeds the reward.
Noted since it's a real, previously-undocumented path, even though the value is negligible.

> **Correction (2026-10-15):** the "any *repeat* game costs real FLOW (`additionalLobbyFee`)" premise above is wrong.
> - **Why:** `freeGamesPerAddress` limits *concurrently open* lobbies. `activeLobbiesCount` drops when a game starts, so back-to-back self-play games are always free.
> - **Consequence:** this path was effectively unbounded. With eligibility gating off, unlimited Sybil addresses each claim 10 free ships per 28 days. Each kill minted 0.025 UTC, and the killer's ship ranked up toward rank 6 (+50% PvP stats) for roughly $75–150 in Base gas.
> - **Resolution (2026-10-16, `docs/audit-3.md` HA6-16):**
>   - destroying a free ship no longer pays UTC and no longer counts as a kill;
>   - PvE (AI) kills no longer count toward rank;
>   - free ships still can't be recycled (`CannotRecycleFreeShip`), so they never pay out that way either;
>   - rank otherwise stays grindable by design.

### ECON-07 — UTC Has No Automatic Supply Sink; Mitigated by an Active Owner-Managed Burn/Sell Policy

**Context, 2026-09-17** — arose from a holistic design-review discussion (pros/cons/opportunities
for profit across the whole tokenomics), not from a code-level bug hunt like ECON-01 through
ECON-06.

Every UTC mint path is either purchase-backed (`purchaseUTCWithFlow`, buy-then-recycle) or
grind-backed (`shipBreaker` recycling, `DestroyRewardLib`'s PvP kill reward) — none of them are
paired with an enforced removal. The only sinks that exist are owner-discretionary:
`ShipPurchaser.withdrawUC`/`burnCollected` and `DroneYard.withdraw`/`burnCollected`, fed by real,
ongoing volume from `purchaseWithUC` sales and `DroneYard` modification fees. Nothing forces
either contract's owner to ever call them. Contrast with DEC, which has a genuinely automatic,
enforced sink (`DroneStorefront.turnInCores` calls `burnFrom` directly — verified during the
design-review pass). Left unmanaged, UTC supply has a one-directional upward bias from ordinary
legitimate play alone, independent of the ECON-01 referral-arbitrage dynamic — which could push
UTC's real market value below the ~50%-of-peg floor modeled in ECON-01's corrected understanding,
since that floor only accounts for arbitrage-driven selling, not organic dilution from thousands
of non-arbitraging players.

**Resolution — an explicit operational policy, not a code change:** the project owner's plan is to
actively manage UTC price stability by burning or selling already-collected UTC (via the four
functions above) depending on market conditions — burn to support price when it's soft, sell
(converting held UTC to native-token treasury revenue) when it's strong — using the pool
(e.g. the planned Uniswap v4 lottery pool) as the execution venue. This is a legitimate,
well-understood pattern (open-market operations / buyback-vs-issuance), and the tooling to execute
it already exists in the deployed contracts — no new function was needed.

**Practical dependencies worth keeping in view, not fixes:**
- Direction must stay counter-cyclical (burn when soft, sell when strong) — the reverse compounds
  the exact move being corrected, especially since the same pool is where ECON-01-style arbitrage
  dumps also land.
- The lever is bounded by how much UTC has actually been collected — can't sell or burn past that,
  so a fast, sustained one-directional move that outpaces `purchaseWithUC`/`DroneYard` inflow could
  outrun the available intervention.
- How much a given intervention moves price depends on treasury size relative to pool depth — worth
  knowing which regime this is operating in (shallow pool = high leverage but frequent intervention
  needed; deep pool = the opposite) rather than discovering it live.
- A concrete reference band (e.g. anchored to the mint-peg rate and its modeled ~50% arbitrage
  floor from ECON-01) would make "what's needed for stability" a consistent, checkable trigger
  rather than a purely case-by-case judgment call — suggested, not required.

---

## Reviewed, no issue found

- **`ShipPurchaser.purchaseUTCWithFlow`** — its mint formula is exactly the protocol's own peg
  definition, not exploitable against itself; it takes no referral parameter at all, so ECON-01's
  mechanism can't occur on this path directly.
- **ECON-06 — `ShipPurchaser.purchaseWithUC`'s pricing** (originally flagged, then reassessed —
  see `contracts/ShipPurchaser.sol` `purchaseWithUC` 54-81, `Ships.sol` `recycleReward` 88) — an
  earlier pass compared `purchaseWithUC`'s price table against `purchaseUTCWithFlow`'s mint peg
  and flagged a mismatch. That was the wrong benchmark: the mint peg is calibrated to mirror
  recycling's own rate (its doc comment says so directly), and recycling is *intentionally* a
  lossy "dust" mechanic by design — a player recycling 10 unwanted ships should net roughly enough
  UTC for 1 new ship, the same shape as disenchant/shard systems in gacha-style games, not a
  break-even round trip. Checked `purchaseWithUC` against that actual target instead
  (`recycleReward` = 0.1 UTC/ship flat): tier 0 (5 ships / 4.99 UC) works out to 0.998 UTC/ship,
  a ~9.98:1 ratio against the 0.1 UTC/ship recycle rate — almost exactly the intended 10:1.
  Larger tiers drift toward ~8.3:1 (tier 4: 60 ships / 49.99 UC = 0.833 UTC/ship), a mild,
  consistent bulk discount for buying bigger packs — standard store/gacha pricing shape, not a
  miscalibration. Also re-checked the exploit-safety question under this corrected framing
  (native-token → UTC via `purchaseUTCWithFlow` → ships via `purchaseWithUC`, compared to buying
  ships directly): still not exploitable, and by a wider margin than the original (wrong-benchmark)
  analysis suggested — routing through UTC this way costs roughly 5-20x more per ship than buying
  directly, even at ECON-01's ~50%-referral floor. Current pricing needs no change.
- **DEC/UTC currency-routing** — `DestroyRewardLib.payDestroyReward` routes by checking whether
  the *destroyed* ship's owner is a registered single-player orchestrator
  (`ILobbiesOrchestratorCheck.isSinglePlayerOrchestrator`). AI-ship ownership is fixed at
  allocation time and can't be spoofed by a player, so there's no path to redirect an AI-kill
  reward from DEC into the more valuable UTC.
- **`Ships.sol` cost-versioning** (`_mintShip`/`calculateShipCost`) — already hardened by the
  fixed H-01/M-01 (version-increment-then-overwrite bug). No new gap found.
- **`GenerateNewShip.sol`** — pure/deterministic trait generation, no state, no value-flow
  surface.
- **`DECBonusWinEffect.sol`/`ShipGrantWinEffect.sol`/`HealAboveFloorWinEffect.sol`** — each gated
  to its configured caller only (Tournament/PvPMatch/RoguelikeMatch's win-effect dispatch); no
  direct player-callable mint path.
- **`TutorialClaim.sol`** — same shape as `FreeShipClaim`, one-time per address, free ships
  non-recyclable; no new farming path.
- **`DroneStorefront.sol`** — burns via `burnFrom` (real allowance-gated burn, not bypassable).
- **`UniversalCredits.sol`** — clean owner-gated mint infrastructure; economic risk lives in which
  contracts are authorized and their own logic (covered above), not in this contract itself.
- **`Tournament.finalize()`'s 60/40-minus-1%-fee split** — verified with real numbers: for a 100
  ETH pool, `fee=1`, `remainder=99`, `second=(99*40)/100=39` (truncated), `first=99-39=60`. Sums
  to exactly 100, integer-division dust correctly flows to the champion, never lost or
  double-counted. `claim()`/`finalize()` both use correct checks-effects-interactions ordering.
- **`UTCLotteryHook`'s entry-qualifying mechanism** (distinct angle from the already-fixed
  HA2-06, which covered win-probability gaming) — `ethProceeds` is the PoolManager's real,
  enforced settlement delta, not user-suppliable data; no way to "look like" a qualifying sell
  without actually paying the corresponding real UTC input and the pool's real fee both
  directions. `hookData`'s free-form trader-attribution can misdirect lottery weight to a third
  party but never for the misattributor's own profit.
- **`Lobbies`' `freeGamesPerAddress`/`additionalLobbyFee`** — measures *concurrent* active
  lobbies, not lifetime games; a player who finishes one lobby before starting the next never
  pays the fee, by design — correct, not a bypass.
- **`ShipAttributes.setCosts`/cost-versioning** — always derives the new version from current
  on-chain storage, ignoring any caller-supplied version (already hardened per H-01/M-01);
  `calculateShipCost` is a pure live read with no staleness desync against the separate
  attributes-versioning system.
- **`DroneEnergyCores.sol`** — a straightforward `authorizedToMint`-gated ERC20 with no pricing
  logic of its own.

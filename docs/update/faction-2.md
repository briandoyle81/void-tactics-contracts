# Faction 2 (Variant 2 / "Drone" Ships) — Economy Update

**Written: 2026-08-15. Revised same day** — an initial version of this doc described DEC rewards that varied by ship *variant* (recycling/destroying a variant-2 ship paid DEC, everything else paid UTC). That was reviewed and deliberately reverted before shipping: **currency now depends only on who owns the ship (human vs. AI), never on its variant.** Everything below reflects the final, current behavior — if you already read the earlier version, disregard the variant-based DEC table, it no longer applies.

**Revised 2026-08-18** — section 6 rewritten top to bottom: variant 2 now has real, complete on-chain art (previously the single biggest outstanding gap). Also new: variant-2 ship names, variant 2's own innate combat ability, and the single-player campaign's AI fleet now flying variant 2. See sections 6-8.

**Revised 2026-08-24** — section 6's weapon-name paragraph updated for two internal changes, neither of which changes what your frontend reads:
1. `RenderMetadata.getMainWeaponString` no longer picks the display string via a hardcoded per-variant if-chain. It now reads a `(variant, weapon) → string` mapping (`mainWeaponNames`, populated via `setMainWeaponName`) — the same pattern `getSpecialString`/`specialNames` already used, generalized so a third+ variant doesn't need its own new if-branch. `getArmorString`/`getShieldsString` got the equivalent `armorNames`/`shieldsNames` mappings.
2. The underlying Solidity `MainWeapon` enum members were renamed from item names (`Laser`/`Railgun`/`MissileLauncher`/`PlasmaCannon`) to generic role slots (`Generic`/`Sniper`/`Missile`/`Close`), since the old item names didn't fit variant 2's mining-equipment reskin (`MainWeapon.PlasmaCannon` mechanically indexing to a "Mining Drill" read as actively wrong). This is a source-identifier-only rename — enum members aren't exposed in the ABI, and both changes are compile-verified to produce byte-identical `tokenURI` output for existing ships. **No action needed on your end** — this note exists only so the enum names below in the original section 6 bullet aren't confusing if you cross-reference contract source.

## TL;DR for the frontend

- **Reward currency depends only on ownership, not variant.** A human-controlled ship (any variant, including variant 2) always drops UTC on recycle/PvP kill, exactly like today's variant-1 behavior. An AI-controlled ship (any variant) always drops DEC (Drone Energy Cores) when a human destroys it. There is no variant-specific economy — variant 2 is faction flavor only, economically identical to variant 1.
- **DEC is a freely transferable ERC20, not soulbound.** This is intentional, not an oversight — it's meant to let time-rich players grind DEC and sell it to money-rich players. Treat it like UTC in any wallet/inventory UI. See section 2.
- Players can **turn in DEC at a new `DroneStorefront` contract** to permanently increase the number of free ships they get from each 28-day claim — see section 3.
- **Free-ship claiming moved to a new contract, `FreeShipClaim`.** It is no longer a function on `Ships`. If your frontend calls `ships.claimFreeShips(...)` directly, that call will now fail — see the ABI/address change section below.
- Variant selection and the variant-2 NFT gate (Shattered Hive medal) already existed and are unchanged by any of this — see section 5.
- **Variant 2 now has complete on-chain art and its own ship names.** `tokenURI` for a variant-2 ship renders real, distinct art (not variant-1's assets) and a real generated name — see section 6.
- **Variant 2 has its own innate combat ability (heals, doesn't ram).** See section 7.
- **The single-player campaign now spawns variant-2 AI ships, not variant-1.** See section 8.

---

## 1. Reward currency: ownership-based, not variant-based

DEC has exactly one source: **a human destroying an AI-owned ship** (single-player), same as before any of this session's work. Recycling and PvP kills always pay UTC, regardless of the ship's variant:

| Event | Who gets paid | Currency |
|---|---|---|
| Player recycles their own ship, any variant (`Ships.shipBreaker`) | The recycler | UTC (`Ships.recycleReward()`, halved if previously destroyed) — unchanged for all variants |
| A human destroys an **AI-owned** ship, any variant (single-player) | The human destroyer | DEC (`ShipsRouter`'s reward formula, `Ships.recycleReward() >> 2`) |
| A human destroys **another human's** ship, any variant (PvP) | The destroyer only | UTC — same as it's always been, no dual-payout |
| An AI destroys a human's ship, any variant (single-player loss) | The AI's owner (`SinglePlayerMatch`, withdrawable) | UTC — unchanged |

An earlier version of this feature made variant 2 specifically pay DEC on recycle/PvP-kill and split PvP rewards between both players. That was reviewed, found to open an unintended cheap DEC-acquisition path (buy a variant-2 ship, recycle it, repeat) and a stranded-token bug (AI-vs-human kills minted DEC to the AI orchestrator contract, which has no way to spend it), and was reverted before shipping. **Ships.sol no longer has a `variant2RecycleReward`, and `ShipsRouter` no longer has a `variant2DestroyReward` — those functions don't exist.** If your frontend was built against the earlier version of this doc, remove any variant-branching logic around reward currency; go back to whatever you had before this feature existed (check destroyed-ship ownership, not variant, to decide which token's balance to watch).

## 2. DEC is a freely transferable ERC20 — not soulbound

**This is a deliberate design choice, and it means DEC can be sold peer-to-peer.** `DroneEnergyCores` is a plain ERC20 — standard `transfer`/`transferFrom`/`approve`, no allowlist, no exempt-address restriction. A player who has time but not money can grind DEC in single-player and sell it (via a marketplace, a DEX pool, or a straight OTC deal — nothing on-chain brokers this, it's just a normal token transfer) to a player who has money but not time, who then calls `DroneStorefront.turnInCores` themselves with the DEC they bought. If you're building any kind of wallet/inventory view, treat DEC like UTC (a normal spendable/tradeable balance), not like `ShatteredHiveMedal` (which *is* genuinely soulbound — one per address, `_update` reverts on any non-mint transfer, unaffected by this change).

If your frontend was built against an earlier version of this doc that mentioned `transferExemptAddress`/`setTransferExemptAddress` or a `Soulbound` error on `DroneEnergyCores` — that's gone. Those never existed on `UniversalCredits` either; `DroneEnergyCores` is now the same shape.

## 3. DEC sink: turn in cores for a permanent free-ship bonus

New contract: **`DroneStorefront`**.

```js
// Player must approve DroneStorefront to pull DEC first (standard ERC20 flow).
await droneEnergyCores.write.approve([droneStorefront.address, cost]);
await droneStorefront.write.turnInCores([cost]);
```

- Progression is a **tier ladder**, not a flat exchange rate. `DroneStorefront.droneCoreTier(player)` (uint8) is the player's current tier, starting at 0. Each call to `turnInCores` must pass the **exact** cost of the player's *next* tier — read it with `DroneStorefront.tierCoreCost(tier)` before calling, don't guess. Reverts:
  - `WrongAmount(expected, provided)` — amount doesn't match the next tier's exact cost.
  - `MaxTierReached(player)` — player has already purchased every configured tier.
- The seeded tier costs (owner-adjustable later via `addTier`, so re-read `tierCoreCost` rather than hardcoding these):

  | Tier | Cost (this tier) | Cumulative | Bonus after this tier |
  |---|---|---|---|
  | 1 | 10 | 10 | +1 |
  | 2 | 20 | 30 | +2 |
  | 3 | 30 | 60 | +3 |
  | 4 | 55 | 115 | +4 |
  | 5 | 95 | 210 | +5 |
  | 6 | 170 | 380 | +6 |
  | 7 | 300 | 680 | +7 |
  | 8 | 525 | 1,205 | +8 |
  | 9 | 925 | 2,130 | +9 |
  | 10 | 1,625 | 3,755 | +10 |

  To render a "next tier" UI: `const tier = await droneStorefront.read.droneCoreTier([player]); const nextCost = await droneStorefront.read.tierCoreCost([tier]);` (reverts/returns 0 past the last configured tier depending on array bounds — check `tier` against the array length, which you can get via repeated reads or just catching the OOB revert).
- The bonus is **permanent and cumulative** — once earned it never resets or needs to be re-earned.
- Emits `TierAdded(tierIndex, cost)` (owner config) and `CoresTurnedIn(player, newTier, amount)` (per turn-in) — useful for a toast/history feed.

## 4. Free ship claiming moved to a new contract

**Breaking change if you call this directly.** `claimFreeShips` is no longer on `Ships`. It now lives on a new contract, `FreeShipClaim`, deployed alongside everything else by the same Ignition module (available as `freeShipClaim` in the deploy output).

```js
// OLD — will now fail, function no longer exists on Ships:
// await ships.write.claimFreeShips([variant]);

// NEW:
await freeShipClaim.write.claimFreeShips([variant]);
```

Everything else about the call is unchanged in spirit:
- Still takes the desired `variant` as its only argument.
- Still gated by a 28-day cooldown (`FreeShipClaim.claimCooldownPeriod`, `FreeShipClaim.lastClaimTimestamp(player)` — same names, just on the new contract instead of `Ships`).
- Still mints ships flagged `isFreeShip = true` (non-recyclable), exactly as before.
- **Now also grants the DroneStorefront bonus automatically**: the number of ships minted per claim is `10 + DroneStorefront.droneCoreTier(player)`, computed inside the same transaction. Nothing extra to call — if the player has turned in cores, their next claim (even one already in progress before they turned cores in) will just mint more ships.

If your frontend caches contract addresses/ABIs by name, add `FreeShipClaim` as a new entry rather than assuming `claimFreeShips` stays reachable through the `Ships` ABI you already have.

### Why this moved

Not functionally motivated — `Ships.sol` was up against Ethereum's 24KB contract size limit and had no room left for the DroneStorefront-bonus logic. The whole claim feature (not just the new bonus part) was split out into its own contract to make room, reusing `Ships`' existing authorized-minter allowlist (`isAllowedToCreateShips`) rather than duplicating minting logic. One small side effect: `Ships.createShips` gained a 5th parameter, `bool _isFreeShip` — only relevant if you call `createShips` directly (e.g. through `ShipPurchaser`'s wiring); pass `false` for any paid purchase path.

## 5. Variant selection and gating — unchanged, already correct

This was asked about separately and confirmed already working, included here for completeness since it's directly relevant to faction 2:

- Both ship-bundle purchases (`ShipPurchaser.purchaseWithUTC`, `Ships.purchaseWithFlow`) and free claims (`FreeShipClaim.claimFreeShips`) take an explicit `_variant` parameter — the player picks their faction per-transaction, nothing is inferred.
- Every mint path funnels through `Ships._mintShip`, which enforces `VariantPurchaseGate.checkGate(variant, recipient)`. Currently only variant 2 is gated, to the Shattered Hive medal NFT (`ShatteredHiveMedal`) — attempting to mint/claim variant 2 without holding it reverts `GateRequirementNotMet`. Variant 1 is ungated.
- The gate checks the **recipient's** holdings (`_to`), not `msg.sender` — relevant if you ever support minting/claiming to an address other than the caller.

No frontend changes needed here beyond what should already be in place: let the player pick a variant, submit it, and handle `GateRequirementNotMet` as "you need the Shattered Hive medal for this faction" in the UI.

## 6. Variant 2 now has complete, distinct on-chain art and real ship names

**This closes the gap the original version of this doc flagged.** `RenderMetadata`'s `imageRendererV2` no longer points at variant 1's `ImageRenderer` as a placeholder — it's a real, separate `ImageRendererV2` assembled from its own `contracts/RenderersV2/*.sol` leaves, generated from an actual "drone" PSD. A variant-2 ship's `tokenURI` image is now genuinely different art from a variant-1 ship's — same `<svg>`-data-URI shape as before, nothing about the *format* the frontend consumes changed, just what's inside it.

- **Weapon display names changed to match the art** (`RenderMetadata.getMainWeaponString`, variant-2 entries in the `mainWeaponNames` mapping — see the 2026-08-24 note above for the internal mechanism): `MainWeapon.Generic` (formerly named `Laser`) → **"Medium Mining Laser"**, `MainWeapon.Sniper` (formerly `Railgun`) → **"Linear Accelerator"**, `MainWeapon.Missile` (formerly `MissileLauncher`) → **"Torpedo Launcher"**, `MainWeapon.Close` (formerly `PlasmaCannon`) → **"Mining Drill"**. These are the actual on-chain display strings and are unchanged by the 2026-08-24 rename above. If your frontend hardcoded the older placeholder strings ("Mining Laser"/"Mass Driver"/"Attack Drones"/"Plasma Beam" from an earlier iteration of this faction), update them — don't rely on cached copies, re-read from the contract.
- **Special display names** (`RenderMetadata.getSpecialString`, via `setSpecialName(2, slot, ...)`): Slot 4 → **"Lightening Field"** (AoE reactor damage, hits friendly/enemy/caster alike), Slot 5 → **"Attack Drones"** (targeted damage), Slot 6 → **"Aux Engine"** (movement bonus). Note the intentional spelling "Lightening" (not "Lightning") — that's the actual on-chain string, matches the art asset's own name.
- **Ship names are now generated, not blank/placeholder.** A new contract, `DroneNames`, produces variant-2 ship names in the shape `[MODEL]-[SERIAL] [CODEWORD]` (e.g. `"KR-17 Cinder"`, `"MX-773 Auger"`) — deterministic per ship, no on-chain storage, distinct in style from variant 1's real-world-style names (`IOnchainRandomShipNames`/`shipNames`). The codeword is themed to the ship's equipped weapon (mining tools → material/industrial words like Flint/Slate/Cinder, the accelerator weapon → space words like Comet/Nova/Vector, the missile weapon → predator words like Wasp/Viper/Kestrel) — players can learn to recognize a ship's rough loadout from its name alone. Nothing to change on the frontend here either — `ship.name` is populated the same way it always was, just with different content for variant 2.
- Shiny-tint rendering also differs for variant 2 specifically (`blendHSLV2` vs. variant 1's `blendHSL`) — a shiny variant-2 ship's orange/amber accent colors get fully recolored to the ship's own random color instead of staying orange, since the old blend math barely moved already-saturated colors. Purely a rendering-contract-side change; `shipData.shiny` and the `traits.colors` fields the frontend already reads are unaffected in shape.

## 7. Variant 2 has its own innate ability: Repair (not Ram)

Every ship has one **faction ability** — an innate combat action available regardless of loadout, dispatched via `ActionType.FactionAbility` and independent of `equipment.special`. Variant 1's is **Ram** (evict a downed enemy ship, `RamResolver`). Variant 2's is **Repair** (`RepairResolver`): heal a friendly ship within range 1 for 50 hull points. Same action type, same call shape (`moveShip(..., ActionType.FactionAbility, targetShipId)`) — the frontend doesn't need new UI plumbing, just correct copy/iconography per faction (don't show a "Ram" icon/tooltip for a variant-2 ship's faction-ability button, and vice versa). If you want the ability's flavor programmatically rather than hardcoding a per-variant string, `Game.factionAbilityIsHeal(variant)` tells you whether a given faction's innate ability heals (true for variant 2, false for variant 1) — this is also how new factions' abilities will be distinguished going forward, so prefer it over a hardcoded variant check if you're building this generically.

## 8. Single-player campaign now spawns variant-2 AI ships

All 30 seeded campaign maps (`ignition/data/singlePlayerStarterContent.json`) now place variant-2 AI ships, not variant 1 — every enemy fleet in the standard campaign is faction 2. `AIEncounters.aiShipConfigs` grew from 25 entries to 50: the original 25 variant-1 configs are untouched and still exist on-chain (just no longer referenced by any seeded map placement), plus 25 new variant-2 configs (`v2grunt`...`v2turtle5`, mirroring the same five archetypes × five tiers, with real `DroneNames`-generated names). If your admin fleet editor or any campaign-preview UI lists/filters AI configs, don't assume "25 configs" or that config ids map to a single variant — check `traits.variant` and re-read `getAllAIShipConfigs()` rather than caching the old count or id range. The "Support" archetype's healing now comes from variant 2's Repair faction ability (section 7) rather than an equipped Special, so its `equipment.special` field reads `0`/None for the new configs — expected, not a data bug.

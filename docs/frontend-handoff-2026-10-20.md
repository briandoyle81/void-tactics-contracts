# Frontend Handoff — Live Deploy, Roguelike Content, Variant 1 Shiny Colors

_Written 2026-10-20. Covers every change since `frontend-handoff-2026-10-19.md`; read that doc (and `frontend-handoff-2026-10-17.md` before it) for everything earlier. Sections 1–3 are live on Base Sepolia (84532) now. Section 4 takes effect at the next `Ships` deploy._

_Tests: the full suite passed on 2026-10-20 (903 passing, 0 failing)._

---

## 1. The 2026-10-19 Base Sepolia redeploy is live

The 10-19 doc said "none of this is deployed yet". That's out of date: the full redeploy that finished on 2026-10-19 includes both of its changes.

- **AI placements follow the map's joiner zone** (10-19 doc §1). The live `AIEncounters` has the new check and the `GRID_WIDTH` constant.
- **Configurable node reward ships** (10-19 doc §2). The live `ShipGrantWinEffect` has `setGrant` / `getGrant` / `hasClaimed`, and the deploy exempted it from `VariantPurchaseGate`. No node has a grant set yet.

Contract addresses are in `ignition/deployments/chain-84532/deployed_addresses.json`, **except the variant 1 renderers and `RenderMetadata`** (see §3). The ones these docs refer to most:

| Contract | Address |
|---|---|
| `Ships` | `0xEB83fAbEa5f0b099B6fBB09Eee42162465e4726d` |
| `Maps` | `0x21a5eE53Bd7483F125c32336205E5F8a9257E668` |
| `AIEncounters` | `0xE97D6c34f7a3aBAe89b642928438e0007Eb5fcf1` |
| `RoguelikeNodeMap` | `0x2646f9E65FC257E0Ac393B0CBFd9eD55aCD31794` |
| `HealAboveFloorWinEffect` | `0x0C1cF9B8CB791D89d92dee7a9654399EFA92C50d` |
| `ShipGrantWinEffect` | `0xf17F466fEc65d61Db1dC53acFF253727e5EB7e92` |

---

## 2. Roguelike content update (live)

The roguelike seed (`ignition/data/roguelikeStarterContent.json`) was updated with the story in progress, and the live chain was synced to it with `scripts/syncStarterContent.ts`. The story isn't finished; expect more updates like this.

### What changed on chain

- **New map "Repair Facility DS7"** (seed key `map67`) is **map id 68** on the live deploy. It has a custom joiner zone and a 5-ship variant 2 enemy fleet, and no scoring tiles.
- **Node `r01` (id 31) is now a Combat node** ("Repair Station DS7") on map 68, instead of a Resupply node. Its win effect is `HealAboveFloorWinEffect`. Its `turnTime` and `maxScore` are 0: roguelike fights don't enforce turn time, and with no scoring tiles the fight only ends by eliminating one side.
- **New edge `m05` (id 5) → `d01` (id 16).** `m05`'s children are now `r01` and `d01`. This connects the old dead-end branch (`d01`…`d06`) and, through `d03`, `s01`, which nothing led to before.

### Things the frontend needs to know

- **Map 67 is a leftover duplicate. Hide it.** A failed sync run created Repair Facility DS7 twice. Map 67 has the same terrain, mode PvE, no joiner zone, no enemy fleet, and no node uses it. Maps can't be deleted, so `Maps.getAllPresetMapIds()` and `mapCount` include it. Leave it out of admin map pickers and anything that lists maps (it may be reused for a future map).
- **Don't work out map ids from the seed's array order.** Fresh deploys and the live deploy now differ:

  | | Repair Facility DS7 | PvP maps |
  |---|---|---|
  | Live Base Sepolia | 68 | 61–66 |
  | A fresh deploy from the current seed | 61 | 62–67 |

  The sync script records ids it creates in `ignition/deployments/chain-84532/content-sync.json` (`map67 → 68`, and map 67 under `ignored`). Read a node's map from `RoguelikeNodeMap.getNode(id).mapId`, not from the seed.
- **Titles, descriptions and map names are frontend-only.** The seed now has a title and description for `d01` ("Sneak Attack") and `r01` ("Repair Station DS7"), and the name "Repair Facility DS7" for the new map. None of these are on chain; take them from the seed.
- **`d01` and `s01` break the enemy-variant rule for now.** The rule is "missions 1–3 fight variant 1 ships, later missions variant 2". Through the new edge, `d01` is mission 5 and `s01` mission 8, but both still have variant 1 fleets. This is intentional while the story is being written (the test exempts them). If the UI derives anything from the rule, such as a difficulty label or the "no DEC from variant 1 kills" hint, read the actual fleet instead (`AIEncounters.getMapPlacements` → `getAIShipConfig(id).traits.variant`).

---

## 3. Variant 1 shiny ships use their full color (live)

Variant 1 shiny ships used to be unable to show red, orange or gold. The renderer averaged the ship's hue with the artwork's blue-grey hull, so every result landed between green and purple; hue 0 came out green and hue 359 purple, though both are red. The renderer now gives the hull and structure colors (art colors at 40% saturation or less) the ship's own hue and saturation, keeping the art's lightness so the shading survives. Vivid accents, such as the shield and engine glows, keep the old gentle tint. Variant 2 is unchanged.

**Every existing variant 1 shiny changes color.** Ships that showed green or purple but rolled red, orange or gold now show the color they rolled. Higher saturation rolls give strongly colored hulls; very low ones give a subtle tint.

### New addresses

The renderer addresses are immutable, so the variant 1 renderer tree was redeployed (`scripts/redeployVariant1Renderers.ts`) and `Ships` was pointed at it:

| Contract | New address | Old address (don't use) |
|---|---|---|
| `RenderMetadata` | `0xd73720aD5C39b483Cd4e1F9dbA99ad31554cEea8` | `0x6A5AC91d11985D9edDE6C2297133F56E79efd7d9` |
| `ImageRenderer` (variant 1) | `0x68E65eE5FAf143d1Ebc19e0117C125CC9F52d409` | `0x7a2089bBa6Cfb1681757631B2f21427798043c59` |

All 28 new contracts are verified on BaseScan, and their addresses are in `ignition/deployments/chain-84532/renderer-redeploy.json`. `ImageRendererV2` is unchanged. The new `RenderMetadata` has the same display names and is owned by MAP_EDITOR, as before.

### Frontend changes needed

- **`deployed_addresses.json` still lists the old `RenderMetadata` and `ImageRenderer`.** Ignition's file isn't updated by the redeploy script. Anything that calls the renderers directly must use the new addresses, or better, read the current one from `Ships.config().metadataRenderer` (then `RenderMetadata.imageRenderer()`). The old contracts still exist and still render the old colors.
- **Clear cached ship images.** `Ships.tokenURI` returns the new art straight away, but any image the frontend or an indexer cached is stale for variant 1 shinies. Marketplaces need a manual "refresh metadata" for the current collection; the live `Ships` can't signal it (see §4).
- **If the frontend previews shiny colors itself** (for example a customization preview that recolors SVGs client-side instead of calling the contract), update it to the new rule. For each `hsl(H2, S2%, L2%)` in variant 1 art, with the ship's `colors.h1/s1/l1` as `h, s, l` and integer division:
  - ~~`S2 <= 40`: `hsl(h, s%, L2%)`~~ _(superseded 2026-10-20 by the lightness follow-up below)_
  - `S2 > 40`: `hsl((H2*95 + h*5)/100, (S2*95 + s*5)/100%, (L2*85 + l*15)/100%)` (unchanged)

### Follow-up: the ship's lightness now affects the hull (not deployed yet)

With the rule above, a variant 1 shiny's hull ignored the ship's lightness (`l1`), so ships with different lightness looked almost the same. A follow-up change, also dated 2026-10-20, fixes this in `RenderUtils.blendHSL`.

- **Not live yet.** It takes effect at the next run of `scripts/redeployVariant1Renderers.ts` plus `Ships.setConfig`. That run produces new `RenderMetadata` / `ImageRenderer` addresses again, replacing the ones in the table above. Read them from `Ships.config()` rather than hardcoding them.
- **What changes:** hull and structure colors (`S2 <= 40`) move halfway toward black for dark ships and toward white for light ones. Lightness 50 looks the same as today. Above 50 the effect is squeezed so `l` 99 looks like 85 would, which keeps the brightest ships from washing out. Accent glows (`S2 > 40`) are unchanged.
- **Client-side preview:** for `S2 <= 40`, integer division:
  - `l <= 50`: `hsl(h, s%, (L2 - L2*(50 - l)/100)%)`
  - `l > 50`: let `l' = 50 + (l - 50)*35/49`, then `hsl(h, s%, (L2 + (100 - L2)*(l' - 50)/100)%)`
- **Every variant 1 shiny changes brightness** again, except those with `l1` of exactly 50. Clear cached images again after the redeploy.

---

## 4. `Ships` emits ERC-4906 `BatchMetadataUpdate` (next `Ships` deploy)

The next `Ships` deploy emits the standard ERC-4906 event `BatchMetadataUpdate(0, type(uint256).max)`, meaning "every token's metadata changed", whenever the owner calls `setConfig`. Every renderer swap goes through `setConfig`, so marketplaces re-fetch all ship art automatically. To refresh after a change that doesn't touch `Ships` (for example renaming a weapon in `RenderMetadata`), the owner calls `setConfig` again with the current values.

The live `Ships` doesn't have this; it takes effect at the next `Ships` deploy, which is a new collection.

### Frontend changes needed

- **Optional:** if the frontend or an indexer caches ship images, listen for `BatchMetadataUpdate` on `Ships` and drop all cached ship art when it fires. The per-ship `MetadataUpdate(tokenId)` event (customization, construction, destruction) is unchanged.
- `Ships.supportsInterface` doesn't report ERC-4906 (`0x49064906`); `Ships` was too close to the size limit. Don't gate on it.

### ABI changes (next `Ships` deploy)

- **Added:** event `BatchMetadataUpdate(uint256 _fromTokenId, uint256 _toTokenId)`.

---

## 5. Checklist

- [ ] Treat the 10-19 doc's two changes (AI placement zones, configurable node reward ships) as live (§1).
- [ ] Hide map 67 from map lists and admin map pickers (§2).
- [ ] Use map 68 for Repair Facility DS7 on the live deploy; read node maps from `RoguelikeNodeMap.getNode`, not seed order (§2).
- [ ] Show the `d01` / `r01` titles and descriptions, and the new map's name, from the seed (§2).
- [ ] Don't assume the mission → enemy-variant rule for `d01` and `s01`; read the actual fleet (§2).
- [ ] Switch to the new `RenderMetadata` / `ImageRenderer` addresses, ideally read from `Ships.config()` (§3).
- [ ] Clear cached variant 1 ship images (§3).
- [ ] Update any client-side shiny preview to the new color rule (§3).
- [ ] After the next variant 1 renderer redeploy: re-read renderer addresses from `Ships.config()`, clear cached images again, and use the lightness rule in any client-side preview (§3 follow-up).
- [ ] Optional: invalidate cached ship art on `BatchMetadataUpdate`, from the next `Ships` deploy (§4).

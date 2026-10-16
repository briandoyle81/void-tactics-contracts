# Frontend Handoff: Destroyed and Unconstructed Ships Render On-Chain Art

_Written 2026-10-16 (updated the same day to add unconstructed art). Not deployed yet; takes effect at the next redeploy of ImageRenderer, ImageRendererV2 and RenderMetadata (and Ships, which points at RenderMetadata)._

## What changed

`tokenURI`'s `image` is now an on-chain SVG data URI, specific to each variant, for both of these states. Each used to be one shared IPFS image:
- **Destroyed ships:** variant 1 and variant 2 explosion art. Previously `ipfs://bafkreige3z6...`.
- **Unconstructed ships:** variant 1 and variant 2 unconstructed art. Previously `ipfs://bafkreibc3fdr...`.

The art is stored already base64-encoded and split into leaf contracts so each stays under the 24 KiB cap:

| Image | Leaves |
|---|---|
| v1 explosion | `RenderExplosion1`–`2` |
| v2 explosion | `RenderExplosion1V2`–`3V2` |
| v1 unconstructed | `RenderUnconstructed1`–`2` |
| v2 unconstructed | `RenderUnconstructed1V2`–`5V2` |

`ImageRenderer*` joins them in order behind `data:image/svg+xml;base64,`.

## Frontend changes needed

- **Local renderer port:** `app/utils/shipRenderer/ImageRenderer.ts` still returns the two old IPFS URIs (`DESTROYED_IMAGE`, `UNCONSTRUCTED_IMAGE`). Switch it to each variant's art, using any of these:
  - The source SVGs in `~/Documents/void-tactics-character-art/`:
    - explosions: `variant-{1,2}-explosion/variant-{1,2}-explosion-256px-portrait.svg`;
    - unconstructed: `v{1,2}-unconstructed/v{1,2}-unconstructed-256px-merge35.svg`.

    The on-chain copies differ only in using `fill="#..."` attributes instead of `style="fill:#...;"`.
  - The joined `render()` output of the leaves, which is base64.
  - `tokenURI`'s `image` field.
- **Constructor ABI:** `ImageRenderer` / `ImageRendererV2` take two more arguments, `address[] _destroyedParts` and `address[] _unconstructedParts`. There are new views `destroyedParts(uint)` and `unconstructedParts(uint)`.
- **Gas** (measured on the test chain): unconstructed `tokenURI` costs about 5.1M (v1) and 11.4M (v2), against about 15–16M for a constructed ship. A destroyed render is under 1M. There's no new RPC gas-cap risk.
  - The unconstructed art was re-traced at `--merge=35` to get here. The earlier `--merge=15` v2 file put `tokenURI` near 48M.

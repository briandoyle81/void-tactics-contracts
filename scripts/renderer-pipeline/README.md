# Renderer pipeline (written 2026-08-15, updated 2026-08-18 and 2026-10-05)

Automates turning a Photoshop file into a fully on-chain SVG rendering
pipeline, matching the shape of the existing hand-built variant-1 pipeline
(`contracts/Renderers/`, `contracts/ImageRenderer.sol`). Built for variant 2
(faction 2). As of the 2026-08-18 update, variant 2 has real art: the actual
`variant-2-pixel.psd` was run through this pipeline, and
`contracts/RenderMetadata.sol`'s `imageRendererV2` field now points at a real
`ImageRendererV2` (`contracts/ImageRendererV2.sol` + `contracts/RenderersV2/`)
generated from it, not the variant-1 placeholder described further down in
this doc's earlier (2026-08-15) sections. See "Round 7 onward" below for what
changed since then.

Describes pipeline mechanics as of this date. Re-verify against the current
`contracts/Renderers/` and `scripts/renderer-pipeline/*.js` before relying on
specifics here (byte budgets, tier settings, manifest shape) if much time has
passed.

## Prerequisites

The source PSD's layers must already be raster/painted (not vector shapes),
one canvas-sized layer per trait/equipment/special value, using the same
naming convention as `variant-1-pixel.psd`: kebab-case layer names inside
category groups (`fore`, `aft`, `weapon`, a `mid` group containing
`shield-armor-0` + `armor`/`shields` subgroups, `special`), regardless of
which single layer happens to be visible when the artist last saved the
file -- every layer's pixels are read regardless of its visibility flag.

## Usage

`manifest.variant2.json` is already wired to the real `variant-2-pixel.psd`
(on disk as `variant-2-pixel copy.psd`) and deployed -- these are the steps
for re-running the pipeline after the art changes, or for standing up
another variant from scratch:

1. Edit `manifest.variant2.json`: set `psdFile` to the real PSD's path
   (relative to repo root), and adjust each `psdLayerName` to match the
   artist's actual layer names if they differ from the convention above.
2. Run the full pipeline (extraction, tracing, hex->hsl conversion,
   PART/COLOR chunking, compile, size-fit escalation):
   ```
   node scripts/renderer-pipeline/check-sizes.js scripts/renderer-pipeline/manifest.variant2.json [--brightness=15]
   ```
   This writes leaf contracts into `contracts/RenderersV2/`. Any leaf still
   over budget after all simplification tiers is reported, not silently
   left broken or bypassed (per CLAUDE.md, the 24KB cap is never disabled) --
   simplify that specific PSD layer (flatten shading, reduce detail) and
   re-run. `--brightness=N` applies a linear +N% gain to output fill colors
   only (see Round 7 onward below); omit it for no change.
3. Generate the combiner contracts and `ImageRendererV2.sol`:
   ```
   node scripts/renderer-pipeline/gen-combiners.js scripts/renderer-pipeline/manifest.variant2.json ImageRendererV2
   ```
4. Wire the new `ImageRendererV2` into the deploy module
   (`ignition/modules/DeployAndConfig.ts`): deploy the leaves, combiners,
   and `ImageRendererV2` the same way variant 1's are deployed (see the
   variant-2 deploy block there for the pattern already in place), then
   pass its address as `RenderMetadata`'s second constructor argument.
5. Run `npx hardhat test`, including `test/RendererV2.test.ts` and
   `test/RendererSizes.test.ts`.

## Single image (added 2026-10-05)

`image-to-svg.js` converts one raster image to a standalone SVG with the same
tracer the PSD pipeline uses (`lib/vtrace.js`). It needs no manifest or PSD
and writes no Solidity. The `.svg` is written next to the source, with the same
basename (`art/ship.png` -> `art/ship.svg`), overwriting any existing file of
that name. It refuses to run on an `.svg` input, since that would overwrite the
input itself.

```
node scripts/renderer-pipeline/image-to-svg.js <image> [--portrait] [--colors=N] [--simplify=EPSILON] [--brightness=PERCENT] [--merge=DISTANCE]
```

- **`--portrait`**: the least detail that still reads as the same person
  (`--merge=45 --simplify=3`). Use it for character art. Explicit flags still
  override it, e.g. `--portrait --merge=40` for a cleaner face. It was chosen
  from a sweep on a 256x256 portrait (2026-10-05):

  | Settings | Size | Result |
  |---|---|---|
  | merge 40, simplify 3 | 46 KB | cleanest face |
  | **merge 45, simplify 3 (`--portrait`)** | **41 KB** | features and expression intact |
  | merge 50, simplify 3 | 35 KB | recognizable; color smears start on the face |
  | merge 55, simplify 3-4 | 29-30 KB | blotchy; facial shading lost |
  | merge 65 (default), simplify 0 | 33 KB | face merges into the background |

  Two limits showed up in the sweep:
  - **Simplify:** above about 4, faces fracture into shards and files get
    *larger* (overlapping simplified shapes).
  - **Where the bytes go:** most of what's left is hair texture and
    background, so removing the background from the source first is the
    biggest further saving.

- **Formats:** anything node-canvas `loadImage` reads (PNG, JPEG, GIF's first
  frame, ...). Any image size works, and the SVG's `viewBox` matches the image.
- **`--colors`** (default 80): the k-means palette ceiling. `lib/palette.js` merges
  near-duplicate clusters, so the real color count self-limits. Lower it to
  force a flatter, more posterized look.
- **`--simplify`** (default 0): the Douglas-Peucker tolerance in source pixels,
  the same `epsilon` `check-sizes.js` searches over. Raise it for a smaller file
  with coarser outlines (try 0.5-4).
- **`--brightness`** (default 0): a percent gain on the output fill colors only,
  the same as `check-sizes.js --brightness`.
- **`--merge`** (default 65, `lib/palette.js`'s `MERGE_THRESHOLD`): palette
  colors closer than this RGB distance are merged. The default suits flat
  pixel art, but on **photos and painted portraits** it collapses the image to
  a handful of tones. For those, use about 35 (good detail at moderate size)
  or 20 (closest to the source, roughly 2.5x larger). Measured on a 256x256
  portrait (2026-10-05):

  | `--merge` | Colors | Size (simplify 0 / 1) |
  |---|---|---|
  | 65 (default) | 6 | 33 KB / 29 KB |
  | 35 | 19 | 193 KB / 168 KB |
  | 20 | 45 | 460 KB / 395 KB |

  The PSD pipeline (`check-sizes.js`) doesn't pass this, so it always uses the
  default.
- **The output look:** the tracer is tuned for this project's pixel art. Output
  is straight-edged polygons (no curves), and pixels are snapped to fully opaque
  or fully transparent at 50% alpha. A fully opaque image (e.g. a JPEG) traces
  its background as the bottom shape. There is no byte-budget search here; use
  `check-sizes.js` when a result has to fit in a contract.
- **From code:**
  `require("./scripts/renderer-pipeline/image-to-svg").imageToSvg(path, { portrait, colors, simplify, brightness, merge, outPath })`
  resolves to `{ outPath, width, height, bytes }`. `outPath` (code only)
  overrides the next-to-the-source default, e.g. for writing several
  variants into one folder.

## How it works

**Current state, in brief:** each layer is reduced to a palette
(`lib/palette.js`). Each palette color is traced with **potrace**, using
cumulative "stack" masks (`lib/vtrace.js`), and simplified with
Douglas-Peucker at a tunable `epsilon`. The bullets below record how the
pipeline got there. The `lib/vtrace.js` bullet's Rounds 2-6 describe the
earlier **vtracer** design, which is superseded. See "Round 7 onward" below
for the current tracer.

- `lib/psd.js` -- reads the PSD (`ag-psd` + `canvas`), composites each named
  layer onto the full 256x256 canvas at its absolute position (matching the
  deployed contracts' convention of baking absolute coordinates directly
  into path data, no `<g transform>`), then alpha-thresholds it to a clean
  binary edge. Color reduction is *not* done here -- an earlier version of
  this pipeline hand-rolled palette quantization plus a spatial blur to
  fight per-pixel shading noise in the source art, but blurring before
  quantizing smeared away real linework (panel seams, rivets) along with
  the noise, producing visibly mushy output. That whole approach was
  replaced first with vtracer and now with palette quantization plus potrace
  (see "Round 7 onward"). Both cluster by color similarity across the image
  rather than by spatial blur, so they preserve edges instead of eroding
  them.
- `lib/palette.js` -- reduces a layer to a small palette (farthest-point
  -seeded k-means -- see below for why) and quantizes each pixel to its
  single nearest palette color, with no dithering.
- `lib/vtrace.js` -- **currently** traces each palette color's cumulative
  mask with potrace (see "Round 7 onward"). What follows is the original
  vtracer design, kept as history: it traced the whole already-quantized
  layer to SVG in **one** call via `@neplex/vectorizer` (a native/napi
  binding of vtracer; still listed in `package.json` but no longer used),
  with `mode: Polygon` (guarantees straight-line-only output, `M`/`L`/`Z`,
  matching every existing deployed leaf contract -- verified: zero curve
  commands in any of them) and `hierarchical: Cutout` (partitions the
  canvas into non-overlapping regions, so a lower layer never pays bytes
  for geometry a layer drawn on top of it ends up completely covering --
  see Round 6 below for why this matters and why Stacked was tried first).
  `colorPrecision` is maxed and `layerDifference` is 0 so vtracer's own
  clustering doesn't second-guess the palette `lib/palette.js` already
  chose; even so it tends to emit somewhat more distinct output colors than
  requested (region-average color computation isn't perfectly stable), so
  same-color regions get merged into one `<path>` per unique output color
  afterward. vtracer emits each path with a `transform="translate(tx,ty)"`;
  this bakes that into the path's own coordinates and drops the attribute,
  matching the deployed no-transform convention, and rounds coordinates to
  integers to shrink the string.
  Getting this right took several rounds past the initial vtracer switch:
  - Round 2: vtracer's curve-fitting knobs (`cornerThreshold`/
    `lengthThreshold`/`spliceThreshold`) were left at values that smooth
    vertices even in Polygon mode. Verified empirically that all three have
    *zero* effect on output size in Polygon mode (identical output across
    their whole range on a test layer) -- so they're pinned at vtracer's
    own defaults now and never touched by a tier.
  - Round 3: escalation was coarsening `colorPrecision` (bits per RGB
    channel for the *initial* color clustering) too early to hit the size
    budget, in only 4 big steps. That does shrink files, but it degrades
    fidelity faster than pushing `layerDifference` (merges
    already-clustered, perceptually-similar colors further) and
    `filterSpeckle` (drops small regions outright) does: verified
    empirically that `colorPrecision: 6` with a much higher
    `layerDifference` reaches similar or smaller output than
    `colorPrecision: 5`, while keeping noticeably more detail -- the
    underlying clustering stays fine, it's just merged harder afterward,
    which reads better than coarsening the clustering itself.
  - Round 4: a fixed list of hand-picked tiers, even a finer one, still
    either overshoots past the size budget (wasting available detail) or
    undershoots (still too big) depending on how a given piece happens to
    land relative to the tier boundaries -- there's no guarantee any
    hand-picked tier sits close to a piece's actual size ceiling.
    `lib/tiers.js` now exposes `BANDS`: one array per `colorPrecision`
    (7 down to 3, most detail first), each a fine `layerDifference` sweep
    (`filterSpeckle` scaled alongside it) that's monotonically
    non-increasing in output size -- verified empirically. `check-sizes.js`
    binary-searches *within* one band at a time for the most detail that
    still fits, only falling through to the next (coarser) band when the
    current band's most aggressive setting still doesn't fit under budget.
    That flat monotonicity matters: an earlier attempt spanned
    `colorPrecision` values in a single flat array and binary-searched that
    directly, but `colorPrecision: 5` at its *lowest* `layerDifference` can
    be a much *bigger* file than `colorPrecision: 6` at its *highest* --
    confirmed empirically, a 15x jump right at the band boundary -- which
    broke the search's monotonicity assumption and threw off convergence
    entirely. Per-band search fixes that, and (at the time) nearly every
    piece converged within the very first (finest, `colorPrecision: 7`)
    band, using the same color precision throughout and only trading
    `layerDifference` per piece for however much that specific piece
    actually needs to fit.
  - Round 5 (the big one): even the recalibrated result above still lost
    real detail compared to the deployed contracts -- inspecting
    `RenderAft2.sol` directly explained why. It has only **7 unique
    colors** but **662 traced subpaths** (real count -- an earlier,
    case-sensitive `M`-only grep undercounted this badly the first time).
    Texture in the source art comes from *complex per-color shape
    boundaries*, not from many distinct colors -- vtracer's own
    hierarchical color clustering fundamentally can't reproduce that. Push
    it toward few colors and it does what a clustering algorithm should:
    finds smooth regions of similar color, i.e. flat blobs. What the
    original art almost certainly did instead is reduce to a small
    *deliberate* palette and then **dither** onto it (classic
    Floyd-Steinberg-style error diffusion, the same technique retro pixel
    art has always used to fake intermediate tones from a limited palette)
    -- which produces exactly "few colors, many small alternating regions"
    directly, by construction, rather than as an emergent property of
    clustering thresholds. The first version of this fix reduced to a
    palette of `k` colors (k-means) and Floyd-Steinberg **dithered** each
    pixel onto it (deliberate error-diffusion noise, the classic trick for
    faking intermediate tones from a limited palette), then traced each
    palette color as its own exact single-color mask.
  - Round 6: that dithered version still didn't match, per direct user
    feedback -- having actually built the original art pipeline by hand in
    Inkscape, they pointed out the real technique traces "one layer per
    color, larger simpler shapes where possible that are covered by the
    layer above," plus manually removing hidden geometry a layer's shape
    didn't need since a later layer covers it anyway. Dithering is the
    opposite of that: it deliberately scatters many small alternating
    single-pixel regions to fake a smooth gradient, where the real
    technique gets a similar-looking result from far fewer, larger
    regions by *simplifying* a layer's shape and letting whatever's drawn
    on top of it clean up the parts that don't need to be exactly right.
    Fixed by dropping dithering entirely: `lib/palette.js` (renamed from
    `lib/dither.js`, since it no longer dithers) now does plain
    nearest-color quantization -- each pixel becomes exactly its nearest
    palette color, no error diffusion -- which on smooth painted shading
    produces contour-like bands rather than noise: large, contiguous
    regions per color, not scattered speckle. Palette seeding also changed
    to farthest-point sampling (each new centroid is whichever pixel is
    farthest, in RGB space, from every centroid picked so far): the
    previous luminance-sorted seeding never once produced an orange
    centroid across a whole k=7-20 sweep, silently dropping a small but
    visually important accent-light color from the palette entirely, since
    it doesn't fall in the same luminance band as anything else large
    enough to seed a cluster on its own. `lib/vtrace.js` also switched from
    tracing each color in isolation (`Hierarchical.Stacked` semantics, one
    full-shape mask per color, no matter how much of it ends up covered by
    another color) to tracing the whole already-quantized image in **one**
    vtracer call with `Hierarchical.Cutout`: Cutout partitions the canvas
    into non-overlapping regions, so a lower layer never pays bytes for
    geometry a layer on top of it ends up completely hiding -- directly
    reproducing the "covered by the layer above" property instead of
    approximating it. (Cutout was tried and rejected earlier in this
    pipeline's history for a different reason -- tracing a raw,
    non-pre-quantized sparse layer directly, it invented a solid-colored
    "background" region hiding what should stay transparent. That bug did
    not reappear once tracing an already-quantized image with explicitly
    zeroed transparent pixels; worth retesting rather than assuming a
    ruled-out approach stays ruled out once the surrounding pipeline has
    changed.) `lib/tiers.js`'s `BANDS` changed shape again to match: one
    array per palette size `k`, each a `filterSpeckle` sweep within that
    `k` (this now has a real effect, unlike in the per-isolated-mask
    dithered version, since vtracer is doing genuine multi-region
    segmentation again). `K_VALUES` was seeded from a survey of the
    actually-deployed leaves' real `COLOR_n` counts (5-15, averaging ~9),
    then pushed higher once that range turned out not to be a ceiling --
    most self-test leaves now land at the search's current max (`k: 20`,
    later widened to 40) with little to no `filterSpeckle` needed at all,
    meaning the earlier revisions were leaving real headroom on the table,
    not just fidelity.
  - Also fixed while chasing this: an unrelated but real inefficiency in
    `lib/vtrace.js` -- it emitted one `<path>` (and, once split, one
    `COLOR_n` constant plus its own `shiny ? blendHSL(...) : COLOR_n`
    ternary, real bytecode, not just string length) *per traced region*,
    not per unique color. A color reused in 90 disconnected spots paid that
    overhead 90 times. Grouping by color first closes that gap, and is
    still done today (vtracer's own region-average color computation isn't
    perfectly stable even against an already-quantized input, so it still
    emits somewhat more distinct output colors than the requested palette
    size).
- `extract.js` / `vectorize.js` -- glue: extract every manifest leaf, trace
  each into a legacy-format `.sol` file (single string constant, inline hex
  fills) -- i.e. reproduce the *pre-split* shape variant 1's leaves had
  before `scripts/splitSvgStrings.js` ran on them (preserved for reference
  in `Renderers_original/`).
- `scripts/convertColors.js` and `scripts/splitSvgStrings.js` (repo root,
  not this directory) are reused with an added `--dir=`/`--file=` CLI
  option -- they already did exactly the hex->hsl conversion and
  `PART_n`/`COLOR_n` chunking this pipeline's output needs, so this
  pipeline generates their expected input shape rather than reimplementing
  that logic. `splitSvgStrings.js`'s final concatenation was also changed
  to fold all parts into one reassigned `result` accumulator instead of a
  flat `string.concat(chunk1..chunkN)` over many chunk variables -- pieces
  with 100+ traced fragments hit "stack too deep" under the old shape, since
  Solidity's compiler struggles once too many named locals are
  simultaneously alive in one function, regardless of how few arguments any
  single `string.concat` call has.
- `check-sizes.js` -- runs the above, compiles, reads real deployed
  bytecode sizes from the Hardhat artifacts, and binary-searches
  `lib/tiers.js`'s `BANDS` per leaf for the most detail that still fits
  (falling through to a coarser band -- fewer palette colors -- only when
  the current one's most aggressive `epsilon` setting doesn't; this was
  `filterSpeckle` in the vtracer era) before
  giving up and flagging it -- mirroring, automated, the manual "Shrink X"
  commits variant 1's leaves needed by hand. All leaves currently searching
  share one compile per round (a round probes one candidate per active
  leaf, then reads every leaf's real size from that single compile) rather
  than compiling once per leaf per probe, so the whole manifest converges
  in roughly `bands x log2(band size)` compiles total regardless of how
  many leaves it has. The per-leaf budget (`DEFAULT_BUDGET_BYTES`) is
  24300 bytes, not a much more conservative number: several real deployed
  leaves already sit at 95-99.6% of the 24576-byte cap (`RenderArmor3`:
  24484/24576), so a large safety cushion just throws away detail the
  original art already spent that budget on -- 24300 leaves ~1% margin for
  solc/optimizer version drift, which is what the margin actually needs to
  cover.
- `gen-combiners.js` -- manifest-driven codegen for the 5 combiner
  contracts and the top-level `ImageRendererV2`, matching the existing
  combiners' `if`/`else` dispatch shape exactly (see
  `contracts/Renderers/RenderWeapon.sol` etc. for the pattern being
  mirrored).

## Round 7 onward (2026-08-18): potrace replaces vtracer

Everything above (Rounds 1-6) is preserved as an accurate record of what was
tried against vtracer and why each step happened, but **the tracer itself
has since been replaced** -- `lib/vtrace.js` no longer uses
`@neplex/vectorizer` at all. The trigger: the user shared their own actual
Inkscape "Trace Bitmap" settings (Multiple Scans: Colors, Stack checked,
Scans 8-14, Speckles 2-20, Optimize 5.0) that reliably produce good-fidelity
SVGs under 80KB. Research confirmed Inkscape's Colors+Stack mode is: reduce
to N colors, decompose into one mask per color, trace **each with potrace**
(the actual `potrace` npm package, not vtracer), and stack the results. That
explained the remaining fidelity gap: potrace does real point-count
reduction (its `bestPolygon` step) that vtracer's Polygon mode empirically
never did (Round 2 above already proved vtracer's own corner/length/splice
thresholds are no-ops in Polygon mode).

- **Tracer**: each palette color is traced separately via `potrace`
  (`alphaMax: 0`, which -- verified by reading potrace's source -- forces
  every vertex to `CORNER` classification, guaranteeing pure straight-line
  output with no Bezier curves, matching every deployed leaf). Critically,
  this does *not* use potrace's own `getPathTag()` output: for a
  `CORNER`-tagged vertex, potrace's curve representation stores the vertex
  itself *and* the geometrically-redundant midpoint to the next vertex, and
  emits an `L` for both -- pure waste, since a midpoint of an already-straight
  segment changes nothing about the shape. `lib/vtrace.js` instead reads
  `path.curve.vertex[]` directly (one point per real corner) and runs those
  through real **Ramer-Douglas-Peucker** polyline simplification
  (`simplifyClosedPolygon`, tunable `epsilon` = max deviation in pixels) --
  a graceful, controllable size lever, unlike potrace's own `turdSize`
  (speckle-area threshold), which was tried first as the per-band search
  dimension and rejected: it can only delete an entire small region
  outright, never simplify a large one's outline, so once a palette is large
  enough that most colors are inherently small patches, a `turdSize` big
  enough to hit budget deleted nearly all of them -- confirmed by a visibly
  near-blank render on a real self-test leaf.
- **Cumulative "stack" masks, not a jigsaw partition**: the first potrace
  version traced each color's *exact, mutually-exclusive* pixel set as its
  own mask (matching the old vtracer/Cutout mental model). That produced
  visible background gaps: two colors sharing a real interior seam get
  simplified independently, and their simplified edges drift apart in
  different directions. Fixed by tracing **cumulative** masks instead,
  matching Inkscape's actual Stack semantics: layer `pos`'s mask is that
  color *plus every color stacked on top of it* (`buildStackedMask`), so
  each layer is a large, mostly-solid blob, and a simplification gap in an
  upper layer just reveals the correct color underneath rather than bare
  canvas -- only the bottom (largest-area) layer's own outer silhouette ever
  has to be precise against true transparent background, which is the
  simplest, least-textured contour there is. This also shrank output
  substantially on its own: most of the previous complexity was tracing fine
  seams between similar adjacent colors, which cumulative masking merges
  away entirely.
- **Palette cluster merging, not a fixed `k` ceiling**: a large `k` (tried up
  to 40) still hurt visual quality even after the above fixes -- farthest-
  point k-means seeding runs out of *real* distinct materials to find once
  `k` is large, and starts claiming clusters for antialiasing/blend-edge
  outlier pixels instead, reading as mottled noise (worst on a small ~900px
  weapon-icon layer, which fragmented a real 2-tone highlight into 8
  near-identical reds where the real deployed art uses 2). Capping `k` at 18
  helped but still couldn't adapt to how much real color variation a given
  layer actually has. `lib/palette.js`'s `buildPalette` now keeps k-means
  generous (`K_VALUES` back up to 80) but greedily merges any two resulting
  clusters closer than `MERGE_THRESHOLD` (Euclidean RGB distance),
  weighted by pixel count -- so the *final* color count self-limits to
  however many colors are actually distinct, independent of `k` or layer
  size (confirmed empirically: `k=18` vs. `k=80` on the same layer converge
  to within 1-2 of the same post-merge count).
- **`brightness` parameter**: `vectorizeLayerFragment`'s config accepts a
  `brightness` percent (default 0/off, linear gain on final RGB fill values
  only -- clustering/ordering/geometry are still computed from true pixel
  values first, so it can't change detail or byte size). Exposed via
  `check-sizes.js --brightness=15`.
- `lib/tiers.js`'s `BANDS` sweep dimension changed from potrace's `turdSize`
  to the RDP `epsilon` described above, for the reason given there.

## Validation

The pipeline was run end-to-end against `variant-1-pixel.psd` via
`manifest.variant1-test.json` (ground truth, compared against the real
deployed `contracts/Renderers/*.sol`) and, as of 2026-08-18, for real
against `variant-2-pixel.psd` (the actual file added to the repo root --
on disk as `variant-2-pixel copy.psd`; consider renaming to drop the
` copy` suffix) via `manifest.variant2.json`. **All 20 of 20 variant-1
leaves and all 21 of 21 variant-2 leaves fit the 24300-byte working
budget** with the current potrace + cumulative-stack + palette-merge
pipeline, most with real headroom to spare rather than pushed against the
cap. Variant 2's leaf -> `MainWeapon`/`Special` enum mapping and
`RenderMetadata.sol` display-string renames were confirmed with the user
directly (2026-08-17 conversation): weapon art maps to its enum value by
theme (`medium-mining-laser`->Laser/"Medium Mining Laser",
`linear-accelerator`->Railgun/"Linear Accelerator",
`torpedo-launcher`->MissileLauncher/"Torpedo Launcher",
`mining-drill`->PlasmaCannon/"Mining Drill"); special art maps by matching
each slot's real resolver identity (`lightening-field`->Slot1/"Lightening
Field", `attack-drones`->Slot2/"Attack Drones",
`aux-engine`->Slot3/"Aux Engine" -- variant 2's own slot numbering, moved
from 4/5/6 on 2026-09-20 since a special's behavior is looked up by variant
then slot; the leaf contracts were renamed `RenderSpecial4V2`/`5V2`/`6V2` ->
`RenderSpecial1V2`/`2V2`/`3V2` to match); `fore-3`/`fore-special` fill the same
structural slots variant 1's `fore-2`/`fore-perfect` do. The generated
`contracts/RenderersV2/` leaves, `contracts/ImageRendererV2.sol`, and
`gen-combiners.js`-produced combiners are deployed for real in
`ignition/modules/DeployAndConfig.ts` (mirroring the variant-1 deploy block
exactly) and wired into `RenderMetadata`'s `imageRendererV2` slot --
variant 2 no longer reuses variant 1's `ImageRenderer` as a placeholder.
Full test suite (515 tests) passes with this wired in.

Per-run self-test/exploratory output belongs in `scratch/`, never left
sitting in `contracts/` (the project's `hardhat-contract-sizer` runs in
strict mode and will fail the whole project on anything oversized there,
even a leftover throwaway). Earlier scratch snapshots
(`renderer-pipeline-selftest-output-v1` through the current one, and
similarly-named `-explore`/experiment directories) are kept only as a
before/after record and can be deleted once no longer useful as a
reference.

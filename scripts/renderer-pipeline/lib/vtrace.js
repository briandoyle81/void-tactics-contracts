const { createCanvas } = require("canvas");
const { Potrace } = require("potrace");
const { buildPalette, quantize } = require("./palette");

// This is what Inkscape's own "Trace Bitmap -> Multiple Scans: Colors" +
// "Stack" mode does under the hood (confirmed via source/docs research):
// reduce to N colors, then decompose into N black/white masks -- each one
// cumulative (its own color plus every color stacked on top of it, see
// buildStackedMask), not a mutually-exclusive per-color partition -- and
// trace each with potrace. vtracer (tried first, see git history / README)
// was dropped because its Polygon mode's point-reduction knobs
// (cornerThreshold/lengthThreshold/spliceThreshold) empirically have zero
// effect on output size. An earlier version of this file also traced
// exact, non-overlapping per-color masks instead of cumulative ones: two
// jigsaw-piece regions that used to share an exact boundary, once
// simplified independently (see epsilon/RDP below), pull apart in
// different directions and leave visible background gaps along real
// interior seams -- switching to cumulative masks makes that structurally
// impossible, since every layer except the topmost is a strict superset of
// the one above it.
//
// alphaMax: 0 forces every vertex to potrace's CORNER classification
// (verified by reading potrace's source: the alpha computed in smooth() is
// never negative, so `alpha >= alphaMax` is always true when alphaMax is
// 0), guaranteeing pure straight-line output (M/L/H/V/Z only), matching
// every real deployed leaf.
//
// Critically, this does NOT use potrace's own getPathTag()/renderCurve()
// output: for a CORNER-tagged vertex, potrace's curve representation
// stores the vertex itself *and* the midpoint to the next vertex as two
// separate control points, and renderCurve emits an "L" for both -- but a
// midpoint of a straight segment, inserted between two points already
// joined by a straight line, changes nothing about the resulting shape.
// That makes the default output almost 4x more bytes than the geometry
// actually needs, for zero visual benefit. This instead reads
// path.curve.vertex[] directly (one point per real corner, see
// extractPolygons), then runs those vertices through Douglas-Peucker
// simplification (simplifyPolygon) -- a real point-count-reduction lever
// with a controllable max-deviation tolerance, unlike turdSize (which can
// only delete an entire small region outright, discovered the hard way: at
// a large palette size, most colors are inherently small textured patches,
// and turdSize large enough to hit budget deleted nearly all of them
// rather than gracefully simplifying anything).
const TRACE_OPTIONS = {
  alphaMax: 0,
  optCurve: false,
  threshold: 128,
  blackOnWhite: true,
  color: "black",
  // A small fixed despeckle just to drop true 1-2px noise flecks -- not
  // used as a search lever (see lib/tiers.js: `epsilon`, the
  // simplification tolerance below, is the tunable size/fidelity knob).
  turdSize: 2,
};

function traceColorMask(pngBuffer) {
  return new Promise((resolve, reject) => {
    const tracer = new Potrace(TRACE_OPTIONS);
    tracer.loadImage(pngBuffer, (err) => {
      if (err) return reject(err);
      tracer.getPathTag(""); // lazily triggers _bmToPathlist/_processPath
      resolve(tracer._pathlist);
    });
  });
}

// One array of [x, y] vertices per traced subpath, dropping potrace's
// redundant per-corner midpoint (see header comment).
function extractPolygons(pathlist) {
  return pathlist.map((p) => {
    const { vertex, n } = p.curve;
    const pts = new Array(n);
    for (let i = 0; i < n; i++) pts[i] = [vertex[i].x, vertex[i].y];
    return pts;
  });
}

function perpDist([x, y], [x1, y1], [x2, y2]) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(x - x1, y - y1);
  const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / len2));
  return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
}

// Ramer-Douglas-Peucker on an open point sequence: keeps a point only if it
// deviates from the straight line between its neighbors by more than
// epsilon. Applied to closed traced subpaths by treating the polygon as an
// open path that returns to its own start (see simplifyClosedPolygon).
function rdp(points, epsilon) {
  if (points.length < 3) return points;
  let maxDist = -1;
  let idx = 0;
  const first = points[0];
  const last = points[points.length - 1];
  for (let i = 1; i < points.length - 1; i++) {
    const d = perpDist(points[i], first, last);
    if (d > maxDist) {
      maxDist = d;
      idx = i;
    }
  }
  if (maxDist > epsilon) {
    const left = rdp(points.slice(0, idx + 1), epsilon);
    const right = rdp(points.slice(idx), epsilon);
    return left.slice(0, -1).concat(right);
  }
  return [first, last];
}

function simplifyClosedPolygon(pts, epsilon) {
  if (epsilon <= 0 || pts.length < 4) return pts;
  const closed = pts.concat([pts[0]]);
  const simplified = rdp(closed, epsilon);
  simplified.pop();
  return simplified.length >= 3 ? simplified : pts;
}

function polygonsToD(polygons) {
  let d = "";
  for (const pts of polygons) {
    if (pts.length < 2) continue;
    d += `M${Math.round(pts[0][0])} ${Math.round(pts[0][1])}`;
    for (let i = 1; i < pts.length; i++) d += `L${Math.round(pts[i][0])} ${Math.round(pts[i][1])}`;
    d += "Z";
  }
  return d;
}

// Counts each palette color's pixel area in the already-quantized image, to
// derive a stacking order: largest-area (base/background-like) colors
// first, smaller/more specific detail colors last, so they paint on top --
// mirroring how the real hand-built art layers a base coat under detail
// work, and matching Inkscape's "Stack" mode semantics. Also returns a
// per-pixel index into this order (-1 for transparent), used to build
// cumulative masks (see buildStackedMask).
function orderPaletteByArea(quantized, palette) {
  const { width, height, data } = quantized;
  const counts = palette.map(() => 0);
  const rawIndex = new Int16Array(width * height).fill(-1);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    if (data[i + 3] !== 255) continue;
    for (let c = 0; c < palette.length; c++) {
      const col = palette[c];
      if (data[i] === col[0] && data[i + 1] === col[1] && data[i + 2] === col[2]) {
        counts[c] += 1;
        rawIndex[p] = c;
        break;
      }
    }
  }
  const ordered = palette
    .map((color, idx) => ({ color, rawIdx: idx, count: counts[idx] }))
    .filter((entry) => entry.count > 0)
    .sort((a, b) => b.count - a.count);

  // Map from each color's original palette index to its position in the
  // area-sorted stacking order, so pixel-level lookups (keyed by the raw
  // palette index already computed above) can find "how deep in the stack"
  // a pixel's color sits without a second nearest-color search.
  const rawToStackPos = new Array(palette.length).fill(-1);
  ordered.forEach(({ rawIdx }, stackPos) => {
    rawToStackPos[rawIdx] = stackPos;
  });
  const stackIndex = new Int16Array(rawIndex.length);
  for (let p = 0; p < rawIndex.length; p++) {
    stackIndex[p] = rawIndex[p] === -1 ? -1 : rawToStackPos[rawIndex[p]];
  }

  return { ordered: ordered.map(({ color }) => ({ color })), stackIndex, width, height };
}

// Builds a full-canvas-sized opaque-black/transparent PNG mask for stack
// position `pos`: opaque wherever a pixel's color is at or *after* `pos` in
// the largest-area-first stacking order -- i.e. this color's own pixels
// plus every color drawn on top of it later. This is what makes the result
// a true layer stack (each shape a large, simple, mostly-solid blob) rather
// than a jigsaw of mutually-exclusive per-color regions: independently
// simplifying (see epsilon/RDP below) two jigsaw pieces that used to share
// an exact boundary pulls their edges apart in different directions,
// leaving thin background gaps. With cumulative masks, layer `pos`'s own
// simplified edge only has to be accurate against whatever's drawn
// *underneath* it (which is itself a superset, so already the right kind
// of color) -- the only edge that ever has to be precise against true
// transparent background is the outermost, bottom (pos=0) layer's own
// silhouette, which is the simplest, least-textured contour there is.
function buildStackedMask(stackIndex, width, height, pos) {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  const maskData = ctx.createImageData(width, height);
  for (let p = 0; p < stackIndex.length; p++) {
    if (stackIndex[p] >= pos) maskData.data[p * 4 + 3] = 255;
  }
  ctx.putImageData(maskData, 0, 0);
  return canvas.toBuffer("image/png");
}

function toHex([r, g, b]) {
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

// Linear-gain brightness adjustment: multiplies each channel by
// (1 + percent/100), clamped to 0-255. Applied only to the final palette
// colors used for output fills -- clustering, area ordering, and stacking
// all still operate on the true (unbrightened) pixel values, so this is
// purely a display/output adjustment, not a change to which pixels get
// grouped together.
function brighten([r, g, b], percent) {
  if (!percent) return [r, g, b];
  const factor = 1 + percent / 100;
  return [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v * factor))));
}

// Reduces a layer to a small palette (see lib/palette.js -- farthest-point
// k-means, no dithering), then traces one black/white *cumulative* mask
// per palette color with potrace (see buildStackedMask -- each layer is
// its own color plus everything stacked on top of it, not just its own
// exclusive pixels), extracts its raw corner vertices (not potrace's own
// getPathTag output, see header comment), simplifies each subpath with
// Douglas-Peucker at the given epsilon, and draws the results
// largest-area-first, smaller on top -- exactly Inkscape's own "Stack"
// semantics. Each layer's (possibly multi-subpath, possibly holed where an
// entirely-later/smaller color's region is fully enclosed by it) mask
// becomes one <path> with fill-rule="evenodd", required since a cumulative
// region legitimately can have a hole (e.g. the bottom/base layer wrapping
// all the way around a detail color that sits deep inside the silhouette).
//
// `brightness` (percent, default 0/off) linearly brightens the final fill
// colors only -- see brighten() -- letting a whole run be lightened
// without touching clustering, ordering, or geometry at all.
//
// `merge` (optional) overrides lib/palette.js's MERGE_THRESHOLD for this
// call; omitted, the PSD pipeline's behavior is unchanged.
async function vectorizeLayerFragment(layer, config) {
  const { k, epsilon = 0, brightness = 0, merge } = config;
  const palette = buildPalette(layer, k, undefined, merge);
  const quantized = quantize(layer, palette);
  const { ordered, stackIndex, width, height } = orderPaletteByArea(quantized, palette);

  const parts = [];
  for (let pos = 0; pos < ordered.length; pos++) {
    const mask = buildStackedMask(stackIndex, width, height, pos);
    const pathlist = await traceColorMask(mask);
    const polygons = extractPolygons(pathlist).map((pts) => simplifyClosedPolygon(pts, epsilon));
    const d = polygonsToD(polygons);
    if (!d) continue;
    const fill = toHex(brighten(ordered[pos].color, brightness));
    parts.push(`<path d="${d}" fill-rule="evenodd" style="fill:${fill};"/>`);
  }
  return parts.join("");
}

module.exports = { vectorizeLayerFragment };

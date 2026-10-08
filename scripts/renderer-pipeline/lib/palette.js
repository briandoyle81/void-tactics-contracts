// Palette reduction for painted (not flat pixel-art) source layers.
//
// Two approaches were tried and rejected before this one:
//
// 1. Letting vtracer's own hierarchical color clustering find colors
//    directly. Pushed toward few colors, it just smooths continuous
//    shading into flat blobs -- it clusters by raw color similarity, and
//    the deployed variant-1 leaves don't actually have flat-blob shading
//    (see lib/tiers.js for the "7 colors, 662 subpaths" finding).
//
// 2. Reducing to a small k-means palette and Floyd-Steinberg dithering
//    onto it (deliberate error-diffusion noise, the classic trick for
//    faking intermediate tones from a limited palette). This produced
//    real per-pixel texture, but far more traced subpaths -- and bytes --
//    than the deployed contracts need for a similar visual result:
//    dithering scatters many small alternating single-pixel regions,
//    where the real art (per direct user feedback, having built the
//    original pipeline by hand in Inkscape) uses fewer, larger, simpler
//    shapes per color and relies on later colors/layers to cover
//    (occlude) whatever complexity in an earlier shape doesn't need to be
//    exactly right, rather than getting every pixel exactly right via
//    dithering.
//
// This reduces to a small palette (still k-means, but seeded via
// farthest-point sampling -- see buildPalette below -- so a rare but
// visually important color, like a single bright accent light among
// mostly grey, reliably gets its own cluster instead of being absorbed
// into a larger nearby one) and quantizes each pixel to its single
// nearest palette color with **no** dithering. On smooth painted shading
// this produces contour-like bands rather than dither noise: large,
// simple, contiguous regions per color, matching the "few colors, larger
// simpler shapes" structure the real art actually has. vtracer (see
// lib/vtrace.js) then traces the whole already-quantized image in one
// call using Hierarchical.Cutout, which partitions the canvas into
// non-overlapping regions -- so, unlike Hierarchical.Stacked, a lower
// layer never pays for geometry that ends up entirely covered by a layer
// drawn on top of it.

// Euclidean RGB distance below which two k-means clusters are considered
// the same color for mergeSimilarColors' purposes (0-441 scale, since max
// possible distance is sqrt(255^2*3) =~ 441.7).
const MERGE_THRESHOLD = 65;

// A fixed k forces exactly that many clusters regardless of how much real
// color variation the source actually has: on a small or smoothly-shaded
// layer (e.g. a weapon icon's ~900-pixel highlight stripe), k-means will
// still find k clusters, but most of them just subdivide one smooth
// gradient into several near-duplicate shades rather than finding k truly
// distinct materials -- confirmed on the "laser" weapon layer, where k=18
// produced 8 near-identical reds and 10 near-identical greys where the
// real deployed art uses 2 and 5. This greedily merges the two closest
// remaining centroids (weighted by how many pixels each represents, so a
// merge is a proper weighted average, not a plain midpoint) whenever
// they're closer than MERGE_THRESHOLD, letting the final color count
// self-limit to however many colors are actually distinct -- independent
// of whatever k or layer size produced the pre-merge clusters.
function mergeSimilarColors(centroids, weights, threshold) {
  let items = centroids.map((color, i) => ({ color, weight: weights[i] || 1 }));
  for (;;) {
    let bestI = -1;
    let bestJ = -1;
    let bestDist = Infinity;
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i].color;
        const b = items[j].color;
        const d = Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
        if (d < bestDist) {
          bestDist = d;
          bestI = i;
          bestJ = j;
        }
      }
    }
    if (bestDist >= threshold || items.length <= 1) break;
    const a = items[bestI];
    const b = items[bestJ];
    const totalWeight = a.weight + b.weight;
    const merged = {
      color: [0, 1, 2].map((ch) => Math.round((a.color[ch] * a.weight + b.color[ch] * b.weight) / totalWeight)),
      weight: totalWeight,
    };
    items = items.filter((_, idx) => idx !== bestI && idx !== bestJ);
    items.push(merged);
  }
  return items.map((it) => it.color);
}

// mergeThreshold defaults to MERGE_THRESHOLD (tuned for this project's ship
// pixel art); image-to-svg.js exposes it as --merge, since photo-like art
// needs a lower value to keep its subtler tones apart.
function buildPalette(imageData, k, iterations = 10, mergeThreshold = MERGE_THRESHOLD) {
  const { data } = imageData;
  const pixels = [];
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue;
    pixels.push([data[i], data[i + 1], data[i + 2]]);
  }
  if (pixels.length === 0) return [];

  // Farthest-point seeding: each new centroid is whichever remaining
  // pixel is farthest (in RGB space) from every centroid picked so far.
  // Reliably captures rare-but-distinct hues (a small patch of orange
  // among mostly grey) as their own cluster -- a plain luminance-sorted
  // seeding tried first did not: it evaluated k=7-20 without ever
  // producing an orange centroid, silently dropping a visually important
  // accent color from the palette entirely.
  const centroids = [pixels[0].slice()];
  const distToNearest = pixels.map(() => Infinity);
  for (let c = 1; c < k && c < pixels.length; c++) {
    const last = centroids[c - 1];
    for (let i = 0; i < pixels.length; i++) {
      const d = (pixels[i][0] - last[0]) ** 2 + (pixels[i][1] - last[1]) ** 2 + (pixels[i][2] - last[2]) ** 2;
      if (d < distToNearest[i]) distToNearest[i] = d;
    }
    let best = 0;
    let bestDist = -1;
    for (let i = 0; i < pixels.length; i++) {
      if (distToNearest[i] > bestDist) {
        bestDist = distToNearest[i];
        best = i;
      }
    }
    centroids.push(pixels[best].slice());
  }

  let finalSums = null;
  for (let iter = 0; iter < iterations; iter++) {
    const sums = centroids.map(() => [0, 0, 0, 0]);
    for (const p of pixels) {
      let best = 0;
      let bestDist = Infinity;
      for (let c = 0; c < centroids.length; c++) {
        const d =
          (p[0] - centroids[c][0]) ** 2 + (p[1] - centroids[c][1]) ** 2 + (p[2] - centroids[c][2]) ** 2;
        if (d < bestDist) {
          bestDist = d;
          best = c;
        }
      }
      sums[best][0] += p[0];
      sums[best][1] += p[1];
      sums[best][2] += p[2];
      sums[best][3] += 1;
    }
    for (let c = 0; c < centroids.length; c++) {
      if (sums[c][3] > 0) {
        centroids[c] = [sums[c][0] / sums[c][3], sums[c][1] / sums[c][3], sums[c][2] / sums[c][3]];
      }
    }
    finalSums = sums;
  }
  const rounded = centroids.map((c) => c.map(Math.round));
  const weights = finalSums.map((s) => s[3]);
  return mergeSimilarColors(rounded, weights, mergeThreshold);
}

function nearestPaletteIdx(r, g, b, palette) {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < palette.length; i++) {
    const p = palette[i];
    const d = (r - p[0]) ** 2 + (g - p[1]) ** 2 + (b - p[2]) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

// Plain nearest-color quantization -- no error diffusion. Each pixel
// becomes exactly its nearest palette color; alpha stays binary
// (transparent pixels are skipped and left zeroed).
function quantize(imageData, palette) {
  const { width, height, data } = imageData;
  const out = Buffer.alloc(data.length);
  if (palette.length === 0) return { data: out, width, height };
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue;
    const idx = nearestPaletteIdx(data[i], data[i + 1], data[i + 2], palette);
    const [r, g, b] = palette[idx];
    out[i] = r;
    out[i + 1] = g;
    out[i + 2] = b;
    out[i + 3] = 255;
  }
  return { data: out, width, height };
}

module.exports = { buildPalette, quantize, MERGE_THRESHOLD };

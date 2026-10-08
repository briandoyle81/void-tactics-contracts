const fs = require("fs");
const path = require("path");
const { createCanvas, loadImage } = require("canvas");
const { alphaThreshold } = require("./lib/psd");
const { vectorizeLayerFragment } = require("./lib/vtrace");
const { BANDS } = require("./lib/tiers");
const { MERGE_THRESHOLD } = require("./lib/palette");

// Single-image entry point to the same tracer the PSD pipeline uses (see
// README.md "Single image"): no manifest, no PSD, no Solidity output, no
// size-fit search -- just one raster image in, one standalone .svg out,
// written next to the source with the same basename. Defaults to the
// pipeline's most-detailed setting (BANDS[0][0]); lib/palette.js's cluster
// merging self-limits the real color count, so a high `colors` ceiling is
// safe. `merge` is that merging's color-distance threshold: the default
// suits flat pixel art; photo-like art needs it lower (~20-35) or it
// collapses to a handful of tones.
const DEFAULTS = {
  colors: BANDS[0][0].k,
  simplify: BANDS[0][0].epsilon,
  brightness: 0,
  merge: MERGE_THRESHOLD,
};

// --portrait: the least detail that still reads as the same person, picked
// from a merge x simplify sweep on a 256x256 character portrait (2026-10-05,
// see README.md "Single image"). Above merge ~50 facial shading flattens out;
// above simplify ~4 faces fracture into shards and files get *bigger*.
// Explicit --merge/--simplify/etc. still override it.
const PORTRAIT = { merge: 45, simplify: 3 };

function svgPathFor(imagePath) {
  const { dir, name } = path.parse(imagePath);
  return path.join(dir, `${name}.svg`);
}

// opts.outPath (code only, not a CLI flag) overrides the default
// next-to-the-source output location.
async function imageToSvg(imagePath, opts = {}) {
  const { colors, simplify, brightness, merge } = {
    ...DEFAULTS,
    ...(opts.portrait ? PORTRAIT : {}),
    ...withoutUndefined(opts),
  };
  if (!fs.existsSync(imagePath)) throw new Error(`Image not found: ${imagePath}`);
  const outPath = opts.outPath || svgPathFor(imagePath);
  if (path.resolve(outPath) === path.resolve(imagePath)) {
    throw new Error(`Refusing to overwrite the input itself: ${imagePath}`);
  }

  const img = await loadImage(imagePath);
  const { width, height } = img;
  const ctx = createCanvas(width, height).getContext("2d");
  ctx.drawImage(img, 0, 0);
  const layer = alphaThreshold(ctx.getImageData(0, 0, width, height));

  const body = await vectorizeLayerFragment(layer, {
    k: colors,
    epsilon: simplify,
    brightness,
    merge,
  });
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="0 0 ${width} ${height}">${body}</svg>\n`;
  fs.writeFileSync(outPath, svg);
  return { outPath, width, height, bytes: Buffer.byteLength(svg) };
}

function withoutUndefined(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

function parseArgs(argv) {
  const opts = {};
  const positional = [];
  for (const arg of argv) {
    if (arg === "--portrait") {
      opts.portrait = true;
      continue;
    }
    const m = arg.match(/^--(colors|simplify|brightness|merge)=(.+)$/);
    if (!m) {
      positional.push(arg);
      continue;
    }
    const value = Number(m[2]);
    if (!Number.isFinite(value)) throw new Error(`Invalid value for --${m[1]}: ${m[2]}`);
    opts[m[1]] = value;
  }
  return { imagePath: positional[0], opts };
}

async function main() {
  const { imagePath, opts } = parseArgs(process.argv.slice(2));
  if (!imagePath) {
    console.error(
      "Usage: node scripts/renderer-pipeline/image-to-svg.js <image> " +
        "[--portrait] [--colors=N] [--simplify=EPSILON] [--brightness=PERCENT] [--merge=DISTANCE]",
    );
    process.exit(1);
  }
  const { outPath, width, height, bytes } = await imageToSvg(imagePath, opts);
  console.log(`[image-to-svg] ${imagePath} (${width}x${height}) -> ${outPath} (${bytes} bytes)`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = { imageToSvg, svgPathFor, PORTRAIT };

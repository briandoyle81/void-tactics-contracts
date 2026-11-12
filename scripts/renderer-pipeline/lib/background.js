// Background removal for image-to-svg.js --remove-bg (2026-11-09): makes an
// opaque image's dark space background transparent before tracing, so the
// SVG has no full-canvas bottom shape and can sit over other art (e.g. FE
// grid tiles). Tuned on broken-mining-station.png, a 256x256 station on a
// black starfield with dark blue nebula; see README.md "Single image".
//
// 1. Flood fill from every border pixel through "background" pixels: near
//    black (max channel <= DARK), or dim and blue-tinted (max channel <= DIM
//    and blue - red >= BLUE_TINT), which takes nebula without the station's
//    warm-grey shadows or grey smoke.
// 2. Clear what the fill can't reach but is still background: islands of
//    up to SPECK pixels (stars), and islands of up to ISLAND pixels that are
//    dim (mean max channel < ISLAND_DIM) or dim-ish and blue (mean < DIM_ISH
//    and mean blue - red > ISLAND_BLUE). Islands use 4-connectivity.
const DEFAULTS = {
  dark: 20,
  dim: 50,
  blueTint: 4,
  speck: 4,
  island: 600,
  islandDim: 45,
  dimIsh: 60,
  islandBlue: 2,
};

function removeBackground(imageData, opts = {}) {
  const c = { ...DEFAULTS, ...opts };
  const { data, width: W, height: H } = imageData;
  const lum = (i) => Math.max(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
  const blue = (i) => data[i * 4 + 2] - data[i * 4];
  const isBg = (i) => lum(i) <= c.dark || (lum(i) <= c.dim && blue(i) >= c.blueTint);
  const neighbors = (i) => {
    const x = i % W;
    const y = (i / W) | 0;
    const out = [];
    if (x > 0) out.push(i - 1);
    if (x < W - 1) out.push(i + 1);
    if (y > 0) out.push(i - W);
    if (y < H - 1) out.push(i + W);
    return out;
  };

  const bg = new Uint8Array(W * H);
  const stack = [];
  for (let x = 0; x < W; x++) stack.push(x, (H - 1) * W + x);
  for (let y = 0; y < H; y++) stack.push(y * W, y * W + W - 1);
  while (stack.length) {
    const i = stack.pop();
    if (bg[i] || !isBg(i)) continue;
    bg[i] = 1;
    stack.push(...neighbors(i));
  }

  const seen = new Uint8Array(W * H);
  for (let s = 0; s < W * H; s++) {
    if (bg[s] || seen[s]) continue;
    const comp = [];
    let lumSum = 0;
    let blueSum = 0;
    seen[s] = 1;
    stack.push(s);
    while (stack.length) {
      const i = stack.pop();
      comp.push(i);
      lumSum += lum(i);
      blueSum += blue(i);
      for (const j of neighbors(i)) {
        if (!bg[j] && !seen[j]) {
          seen[j] = 1;
          stack.push(j);
        }
      }
    }
    const meanLum = lumSum / comp.length;
    const drop =
      comp.length <= c.speck ||
      (comp.length <= c.island &&
        (meanLum < c.islandDim ||
          (meanLum < c.dimIsh && blueSum / comp.length > c.islandBlue)));
    if (drop) for (const i of comp) bg[i] = 1;
  }

  let removed = 0;
  for (let i = 0; i < W * H; i++) {
    if (!bg[i]) continue;
    data[i * 4 + 3] = 0;
    removed++;
  }
  return removed;
}

module.exports = { removeBackground };

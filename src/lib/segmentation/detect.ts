import type { Img, Region } from '$lib/types';
import { FULL_PAGE } from '$lib/types';
import { toGray, percentileGray } from '$lib/image/ops';

export const MAX_CHEQUES_PER_PAGE = 12;
export type SegFlag = 'single' | 'ok' | 'ambiguous';

// Contiguous [start, end) runs of truthy values in a 0/1 array.
function boolRuns(mask: Uint8Array): [number, number][] {
  const runs: [number, number][] = [];
  const n = mask.length;
  let i = 0;
  while (i < n) {
    if (mask[i]) {
      let j = i + 1;
      while (j < n && mask[j]) j++;
      runs.push([i, j]);
      i = j;
    } else i++;
  }
  return runs;
}

function boxSmooth(arr: Float32Array, win: number): Float32Array {
  if (win <= 1) return arr;
  const n = arr.length;
  const out = new Float32Array(n);
  const half = Math.floor(win / 2);
  let sum = 0;
  for (let i = 0; i < Math.min(win, n); i++) sum += arr[i];
  // simple centered moving average via prefix sums
  const prefix = new Float32Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + arr[i];
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - half);
    const b = Math.min(n, i + half + 1);
    out[i] = (prefix[b] - prefix[a]) / (b - a);
  }
  void sum;
  return out;
}

export function orderRegions(regions: Region[]): Region[] {
  // Top-to-bottom, then left-to-right (rows bucketed so a side-by-side pair groups).
  return [...regions].sort(
    (a, b) => round2(a[1]) - round2(b[1]) || round2(a[0]) - round2(b[0])
  );
}
const round2 = (v: number) => Math.round(v * 100) / 100;

export function regionsOverlapBadly(regions: Region[]): boolean {
  for (let i = 0; i < regions.length; i++) {
    for (let j = i + 1; j < regions.length; j++) {
      const a = regions[i];
      const b = regions[j];
      const vOv = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
      const hOv = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
      const ha = a[3] - a[1],
        hb = b[3] - b[1],
        wa = a[2] - a[0],
        wb = b[2] - b[0];
      if (ha > 0 && hb > 0 && wa > 0 && wb > 0) {
        if (vOv / Math.min(ha, hb) > 0.5 && hOv / Math.min(wa, wb) > 0.3) return true;
      }
    }
  }
  return false;
}

// Detect >=2 wide side-by-side blocks within one band (2-up cheques).
function splitBandColumns(colOn: Uint8Array, width: number): [number, number][] {
  const runs = boolRuns(colOn);
  if (!runs.length) return [];
  const minGap = Math.max(2, Math.floor(width * 0.04));
  const merged: [number, number][] = [[...runs[0]] as [number, number]];
  for (let r = 1; r < runs.length; r++) {
    const [s, e] = runs[r];
    if (s - merged[merged.length - 1][1] <= minGap) merged[merged.length - 1][1] = e;
    else merged.push([s, e]);
  }
  const blocks = merged.filter(([s, e]) => e - s >= width * 0.28);
  return blocks.length >= 2 ? blocks : [];
}

/**
 * Deterministic cheque detector. Returns regions plus a confidence flag:
 *   single    -> treat page as one cheque (use full page; matches legacy behaviour)
 *   ok        -> confident multi-cheque split (>=2 clean bands)
 *   ambiguous -> geometry is unclear; caller may consult the LLM fallback
 */
export function detectChequeRegionsClassical(
  gray: Uint8Array,
  width: number,
  height: number
): { regions: Region[]; flag: SegFlag } {
  const h = height,
    w = width;
  if (h < 10 || w < 10) return { regions: [FULL_PAGE], flag: 'single' };

  const bg = percentileGray(gray, 95);
  const thresh = Math.min(235, Math.max(120, bg - 40));
  const ink = new Uint8Array(gray.length);
  let inkCount = 0;
  for (let i = 0; i < gray.length; i++) {
    if (gray[i] < thresh) {
      ink[i] = 1;
      inkCount++;
    }
  }
  if (inkCount / gray.length < 0.002) return { regions: [FULL_PAGE], flag: 'single' };

  // Row ink-density projection, smoothed.
  const row = new Float32Array(h);
  for (let y = 0; y < h; y++) {
    let c = 0;
    const base = y * w;
    for (let x = 0; x < w; x++) c += ink[base + x];
    row[y] = c / w;
  }
  const rowS = boxSmooth(row, Math.max(1, Math.floor(h * 0.012)));
  let rowMax = 0;
  for (let y = 0; y < h; y++) if (rowS[y] > rowMax) rowMax = rowS[y];
  const rowThresh = Math.max(0.02, 0.06 * rowMax);
  const rowOn = new Uint8Array(h);
  for (let y = 0; y < h; y++) rowOn[y] = rowS[y] > rowThresh ? 1 : 0;

  const runs = boolRuns(rowOn);
  if (!runs.length) return { regions: [FULL_PAGE], flag: 'single' };

  // Merge bands separated by a thin gutter; drop bands that are too short.
  const minGutter = Math.max(2, Math.floor(h * 0.012));
  const merged: [number, number][] = [[...runs[0]] as [number, number]];
  for (let r = 1; r < runs.length; r++) {
    const [s, e] = runs[r];
    if (s - merged[merged.length - 1][1] <= minGutter) merged[merged.length - 1][1] = e;
    else merged.push([s, e]);
  }
  const minBandH = Math.max(4, Math.floor(h * 0.06));
  const bands = merged.filter(([s, e]) => e - s >= minBandH);
  if (!bands.length) return { regions: [FULL_PAGE], flag: 'single' };

  const raw: [number, number, number, number][] = [];
  let ambiguous = false;
  for (const [y0, y1] of bands) {
    const col = new Float32Array(w);
    const bandH = y1 - y0;
    for (let x = 0; x < w; x++) {
      let c = 0;
      for (let y = y0; y < y1; y++) c += ink[y * w + x];
      col[x] = c / bandH;
    }
    let colMax = 0;
    for (let x = 0; x < w; x++) if (col[x] > colMax) colMax = col[x];
    const colThresh = Math.max(0.02, 0.06 * (colMax || 1));
    const colOn = new Uint8Array(w);
    for (let x = 0; x < w; x++) colOn[x] = col[x] > colThresh ? 1 : 0;
    const colRuns = boolRuns(colOn);
    if (!colRuns.length) continue;
    const xLeft = colRuns[0][0];
    const xRight = colRuns[colRuns.length - 1][1];
    const bandW = xRight - xLeft;

    const sub = splitBandColumns(colOn, w);
    if (sub.length >= 2) {
      for (const [xs, xe] of sub) raw.push([xs, y0, xe, y1]);
      ambiguous = true; // side-by-side splits are lower confidence
    } else {
      raw.push([xLeft, y0, xRight, y1]);
    }
    if (bandW < w * 0.4 || bandH > bandW) ambiguous = true;
  }
  if (!raw.length) return { regions: [FULL_PAGE], flag: 'single' };

  const padX = w * 0.01,
    padY = h * 0.01;
  let regions: Region[] = [];
  for (const [x0, y0, x1, y1] of raw) {
    const nx0 = Math.max(0, (x0 - padX) / w);
    const ny0 = Math.max(0, (y0 - padY) / h);
    const nx1 = Math.min(1, (x1 + padX) / w);
    const ny1 = Math.min(1, (y1 + padY) / h);
    if (nx1 - nx0 > 0.05 && ny1 - ny0 > 0.03) regions.push([nx0, ny0, nx1, ny1]);
  }
  regions = orderRegions(regions);
  const n = regions.length;
  if (n <= 1) return { regions: [FULL_PAGE], flag: 'single' };
  if (n > MAX_CHEQUES_PER_PAGE) return { regions: [FULL_PAGE], flag: 'ambiguous' };
  if (regionsOverlapBadly(regions)) return { regions, flag: 'ambiguous' };
  return { regions, flag: ambiguous ? 'ambiguous' : 'ok' };
}

/**
 * Full cascade: deterministic primary, optional vision-LLM fallback on ambiguous
 * pages, else a single full-page region (never worse than one-cheque-per-page).
 * `proposeLLM` is injected so this stays free of network/DOM concerns.
 */
export async function segmentPage(
  gray: Uint8Array,
  width: number,
  height: number,
  opts: { enableLlmFallback: boolean; proposeLLM?: () => Promise<Region[]> }
): Promise<Region[]> {
  const { regions, flag } = detectChequeRegionsClassical(gray, width, height);
  if (flag === 'single') return [FULL_PAGE];
  if (flag === 'ok' && regions.length >= 2) return regions;

  if (opts.enableLlmFallback && opts.proposeLLM) {
    const llm = await opts.proposeLLM().catch(() => [] as Region[]);
    if (llm.length >= 2) return orderRegions(llm);
    if (llm.length === 1) return [FULL_PAGE];
  }
  return [FULL_PAGE];
}

/** Convenience for the browser path: derive gray from an Img then segment. */
export async function segmentImage(
  img: Img,
  opts: { enableLlmFallback: boolean; proposeLLM?: () => Promise<Region[]> }
): Promise<Region[]> {
  return segmentPage(toGray(img), img.width, img.height, opts);
}

import type { Img, Region } from '$lib/types';

// --- These functions operate on the minimal Img surface, so they run unchanged
// --- in the browser (real ImageData) and in node tests. No canvas required.

/** Single-channel grayscale (luma) array, length = width*height. */
export function toGray(img: Img): Uint8Array {
  const { data, width, height } = img;
  const out = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    // Rec. 601 luma; cheap and adequate for layout/ink detection.
    out[i] = (data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) >> 8;
  }
  return out;
}

/** Percentile (0..100) of a single-channel array via a 256-bin histogram. */
export function percentileGray(gray: Uint8Array, pct: number): number {
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const target = (pct / 100) * gray.length;
  let cum = 0;
  for (let v = 0; v < 256; v++) {
    cum += hist[v];
    if (cum >= target) return v;
  }
  return 255;
}

/** Clamp a normalized region to integer pixel box [x0,y0,x1,y1]. */
export function regionToPixels(region: Region, width: number, height: number) {
  const x0 = Math.max(0, Math.min(width - 1, Math.round(region[0] * width)));
  const y0 = Math.max(0, Math.min(height - 1, Math.round(region[1] * height)));
  const x1 = Math.max(x0 + 1, Math.min(width, Math.round(region[2] * width)));
  const y1 = Math.max(y0 + 1, Math.min(height, Math.round(region[3] * height)));
  return { x0, y0, x1, y1 };
}

export function isFullPage(r: Region): boolean {
  return r[0] <= 0.001 && r[1] <= 0.001 && r[2] >= 0.999 && r[3] >= 0.999;
}

/** Crop an Img to a normalized region, returning a new Img (RGBA preserved). */
export function cropImg(img: Img, region: Region): Img {
  if (isFullPage(region)) return img;
  const { x0, y0, x1, y1 } = regionToPixels(region, img.width, img.height);
  const w = x1 - x0;
  const h = y1 - y0;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const srcRow = ((y + y0) * img.width + x0) * 4;
    out.set(img.data.subarray(srcRow, srcRow + w * 4), y * w * 4);
  }
  return { data: out, width: w, height: h };
}

/** Per-pixel contrast around mid-gray (port of PIL ImageEnhance.Contrast). In place. */
export function contrast(img: Img, factor: number): Img {
  const d = img.data;
  for (let p = 0; p < d.length; p += 4) {
    for (let c = 0; c < 3; c++) {
      d[p + c] = 128 + (d[p + c] - 128) * factor;
    }
  }
  return img;
}

/** 3x3 unsharp mask (port of PIL ImageEnhance.Sharpness, amount>1). Returns a new Img. */
export function sharpen(img: Img, amount: number): Img {
  const { width: w, height: h, data: src } = img;
  const out = new Uint8ClampedArray(src.length);
  out.set(src);
  const k = amount - 1; // 0 = identity
  if (k <= 0) return { data: out, width: w, height: h };
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        const center = src[i + c];
        const blur =
          (src[i - 4 + c] +
            src[i + 4 + c] +
            src[i - w * 4 + c] +
            src[i + w * 4 + c] +
            center) /
          5;
        out[i + c] = center + (center - blur) * k;
      }
    }
  }
  return { data: out, width: w, height: h };
}

/** Convert to a high-contrast grayscale RGBA Img (used for crisp OCR crops). */
export function enhanceForRead(img: Img, contrastF = 1.75, sharpF = 1.9): Img {
  const gray = toGray(img);
  const rgba = new Uint8ClampedArray(img.width * img.height * 4);
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    rgba[p] = rgba[p + 1] = rgba[p + 2] = gray[i];
    rgba[p + 3] = 255;
  }
  const g: Img = { data: rgba, width: img.width, height: img.height };
  contrast(g, contrastF);
  return sharpen(g, sharpF);
}

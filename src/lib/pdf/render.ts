import * as pdfjsLib from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import type { Img, Region } from '$lib/types';
import { cropImg, enhanceForRead, isFullPage } from '$lib/image/ops';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

const DETECT_LONG_EDGE = 1500; // segmentation runs on a downscaled render
const CROP_LONG_EDGE = 1568; // Anthropic auto-downscales above ~1568; no point sending more

export async function loadPdf(data: ArrayBuffer): Promise<PDFDocumentProxy> {
  return pdfjsLib.getDocument({ data }).promise;
}

// Mirror of the Python rule: rotate portrait scans into landscape so detection
// and crops share one orientation.
function rotationFor(page: PDFPageProxy): number {
  const def = page.getViewport({ scale: 1 });
  const portrait = def.height > def.width * 1.3;
  return portrait ? (page.rotate + 90) % 360 : page.rotate;
}

async function renderToCanvas(page: PDFPageProxy, longEdge: number) {
  const rotation = rotationFor(page);
  const unit = page.getViewport({ scale: 1, rotation });
  const scale = longEdge / Math.max(unit.width, unit.height);
  const viewport = page.getViewport({ scale, rotation });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  await page.render({ canvasContext: ctx, viewport }).promise;
  return { canvas, ctx };
}

function canvasToImg(ctx: CanvasRenderingContext2D, w: number, h: number): Img {
  const id = ctx.getImageData(0, 0, w, h);
  return { data: id.data, width: id.width, height: id.height };
}

function imgToJpegBase64(img: Img, quality = 0.9): string {
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d')!;
  const id = ctx.createImageData(img.width, img.height);
  id.data.set(img.data);
  ctx.putImageData(id, 0, 0);
  const url = canvas.toDataURL('image/jpeg', quality);
  return url.slice(url.indexOf(',') + 1);
}

/** Downscaled page render for segmentation. */
export async function renderPageForDetection(doc: PDFDocumentProxy, pageIndex: number): Promise<Img> {
  const page = await doc.getPage(pageIndex + 1);
  const { ctx, canvas } = await renderToCanvas(page, DETECT_LONG_EDGE);
  return canvasToImg(ctx, canvas.width, canvas.height);
}

/** High-res crop of one cheque region, returned as base64 JPEG (no data: prefix). */
export async function renderRegionBase64(
  doc: PDFDocumentProxy,
  pageIndex: number,
  region: Region,
  opts: { enhance?: boolean; quality?: number } = {}
): Promise<string> {
  const page = await doc.getPage(pageIndex + 1);
  const { ctx, canvas } = await renderToCanvas(page, CROP_LONG_EDGE);
  let img = canvasToImg(ctx, canvas.width, canvas.height);
  if (!isFullPage(region)) img = cropImg(img, region);
  if (opts.enhance) img = enhanceForRead(img);
  return imgToJpegBase64(img, opts.quality ?? 0.9);
}

/** Lower-res crop for inline preview in the review pane (returns a data: URL). */
export async function renderRegionPreview(
  doc: PDFDocumentProxy,
  pageIndex: number,
  region: Region
): Promise<string> {
  const page = await doc.getPage(pageIndex + 1);
  const { ctx, canvas } = await renderToCanvas(page, 1100);
  let img = canvasToImg(ctx, canvas.width, canvas.height);
  if (!isFullPage(region)) img = cropImg(img, region);
  return 'data:image/jpeg;base64,' + imgToJpegBase64(img, 0.85);
}

export function getPageCount(doc: PDFDocumentProxy): number {
  return doc.numPages;
}

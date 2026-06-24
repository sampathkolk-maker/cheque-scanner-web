import type { ChequeResult, Region, Settings, Progress } from '$lib/types';
import { FULL_PAGE } from '$lib/types';
import { loadPdf, getPageCount, renderPageForDetection, renderRegionBase64, renderRegionPreview } from '$lib/pdf/render';
import { segmentImage } from '$lib/segmentation/detect';
import { extractFields, proposeRegions } from '$lib/llm/client';
import { validateExtraction, type Validated } from '$lib/extract/validate';
import { parseAmount, formatAmount } from '$lib/extract/normalize';
import { buildHint } from '$lib/extract/fewshot';
import { mapPool } from '$lib/concurrency';

function pdfIdOf(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

// Higher is better: reconciled wins, then fewer high flags, then confidence.
function score(v: Validated): number {
  const high = v.flags.filter((f) => f.severity === 'high').length;
  return (v.amountReconciled ? 1000 : 0) - high * 100 + v.confidence;
}

function toResult(
  id: string,
  pdfId: string,
  file: string,
  pageIndex: number,
  ordinal: number,
  count: number,
  region: Region,
  v: Validated,
  model: string,
  cropDataUrl?: string
): ChequeResult {
  return {
    id,
    pdfId,
    sourceFile: file,
    pageIndex,
    chequeOnPage: ordinal,
    chequesOnPage: count,
    region,
    amount: v.amount,
    amountWords: v.amountWords,
    amountNumericValue: v.amountNumericValue,
    amountWordsValue: v.amountWordsValue,
    currency: v.currency,
    date: v.date,
    payer: v.payer,
    bank: v.bank,
    chequeNumber: v.chequeNumber,
    hasHandwriting: v.hasHandwriting,
    amountReconciled: v.amountReconciled,
    flags: v.flags,
    confidence: v.confidence,
    status: v.status,
    reviewed: false,
    model,
    cropDataUrl
  };
}

async function selfConsistencyAmount(
  cropB64: string,
  settings: Settings,
  base: Validated,
  hint?: string
): Promise<Validated> {
  // Sample the strong model a couple more times and majority-vote the amount.
  const samples: (number | null)[] = [base.amountNumericValue, base.amountWordsValue];
  for (let i = 0; i < 2; i++) {
    try {
      const raw = await extractFields(cropB64, settings.escalateModel, settings.apiKey, hint);
      samples.push(parseAmount(raw.amount_numeric));
      if (raw.amount_words_value != null) samples.push(Number(raw.amount_words_value));
    } catch {
      /* ignore a failed sample */
    }
  }
  const counts = new Map<string, number>();
  for (const s of samples) {
    if (s == null) continue;
    const key = formatAmount(s);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let best = '';
  let bestN = 0;
  for (const [k, n] of counts) if (n > bestN) ((best = k), (bestN = n));
  if (best && bestN >= 3) {
    // Strong consensus: accept it and clear the amount high-flag.
    return {
      ...base,
      amount: best,
      amountReconciled: true,
      flags: base.flags.filter((f) => f.field !== 'amount'),
      status: base.flags.some((f) => f.field !== 'amount' && f.severity === 'high') ? 'review' : 'ok'
    };
  }
  return base;
}

async function extractOneCheque(
  doc: Awaited<ReturnType<typeof loadPdf>>,
  pdfId: string,
  file: string,
  pageIndex: number,
  region: Region,
  ordinal: number,
  count: number,
  settings: Settings
): Promise<ChequeResult> {
  const id = `${pdfId}:${pageIndex}:${ordinal}`;
  try {
    const cropB64 = await renderRegionBase64(doc, pageIndex, region, { enhance: false });
    let modelUsed = settings.model;
    let raw = await extractFields(cropB64, settings.model, settings.apiKey);
    let v = validateExtraction(raw);

    if (settings.enableEscalation && v.status === 'review' && settings.escalateModel !== settings.model) {
      try {
        const hint = settings.enableBankFewShot ? buildHint(v.bank) : undefined;
        const raw2 = await extractFields(cropB64, settings.escalateModel, settings.apiKey, hint);
        const v2 = validateExtraction(raw2);
        if (score(v2) > score(v)) {
          raw = raw2;
          v = v2;
          modelUsed = settings.escalateModel;
        }
      } catch {
        /* keep first read */
      }
    }

    if (settings.enableSelfConsistency && v.status === 'review') {
      const hint = settings.enableBankFewShot ? buildHint(v.bank) : undefined;
      v = await selfConsistencyAmount(cropB64, settings, v, hint);
      modelUsed = settings.escalateModel;
    }

    const preview = await renderRegionPreview(doc, pageIndex, region);
    return toResult(id, pdfId, file, pageIndex, ordinal, count, region, v, modelUsed, preview);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const v = validateExtraction({}); // all-empty -> flagged
    const r = toResult(id, pdfId, file, pageIndex, ordinal, count, region, v, settings.model);
    r.status = 'error';
    r.error = msg;
    return r;
  }
}

async function processPage(
  doc: Awaited<ReturnType<typeof loadPdf>>,
  pdfId: string,
  file: string,
  pageIndex: number,
  settings: Settings,
  onResult: (r: ChequeResult) => void
): Promise<number> {
  const detectImg = await renderPageForDetection(doc, pageIndex);
  const regions = await segmentImage(detectImg, {
    enableLlmFallback: settings.enableLlmSegmentation,
    proposeLLM: settings.enableLlmSegmentation
      ? async () => {
          const full = await renderRegionBase64(doc, pageIndex, FULL_PAGE, { enhance: false });
          return proposeRegions(full, settings.model, settings.apiKey);
        }
      : undefined
  });
  const count = regions.length;
  for (let i = 0; i < regions.length; i++) {
    const r = await extractOneCheque(doc, pdfId, file, pageIndex, regions[i], i + 1, count, settings);
    onResult(r);
  }
  return count;
}

/** Process a batch of PDF files. Streams each cheque result via onResult. */
export async function processFiles(
  files: File[],
  settings: Settings,
  onResult: (r: ChequeResult) => void,
  onProgress: (p: Progress) => void
): Promise<void> {
  // Pre-count pages for an accurate progress denominator.
  const docs: { file: File; doc: Awaited<ReturnType<typeof loadPdf>>; pages: number }[] = [];
  let totalPages = 0;
  for (const file of files) {
    const buf = await file.arrayBuffer();
    const doc = await loadPdf(buf);
    const pages = getPageCount(doc);
    totalPages += pages;
    docs.push({ file, doc, pages });
  }

  let pagesDone = 0;
  let chequesFound = 0;
  for (const { file, doc, pages } of docs) {
    const pdfId = pdfIdOf(file);
    const pageIndices = Array.from({ length: pages }, (_, i) => i);
    await mapPool(
      pageIndices,
      settings.concurrency,
      (pageIndex) =>
        processPage(doc, pdfId, file.name, pageIndex, settings, (r) => {
          chequesFound++;
          onResult(r);
        }),
      () => {
        pagesDone++;
        onProgress({ pagesDone, totalPages, chequesFound, file: file.name });
      }
    );
  }
}

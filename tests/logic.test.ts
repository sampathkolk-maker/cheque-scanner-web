/* Pure-logic unit tests. Run: npm run test
   These exercise the DOM-free core (segmentation, normalization, validation,
   concurrency) on synthetic data — the same strategy used on the Python build. */
import type { Img } from '$lib/types';
import { detectChequeRegionsClassical } from '$lib/segmentation/detect';
import { toGray, percentileGray, cropImg } from '$lib/image/ops';
import { parseAmount, formatAmount, wordsToNumber, parseDate, normalizeChequeNumber, toWesternDigits } from '$lib/extract/normalize';
import { validateExtraction, HANDOVER_MARKER } from '$lib/extract/validate';
import { mapPool } from '$lib/concurrency';
import { canonicalBank, buildHint } from '$lib/extract/fewshot';
import { providerOf, modelsFor, MODELS } from '$lib/types';

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; }
  else { failed++; console.error('  ✗ ' + msg); }
}
function eq(a: unknown, b: unknown, msg: string) {
  ok(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
}
function near(a: number | null, b: number, tol: number, msg: string) {
  ok(a != null && Math.abs(a - b) <= tol, `${msg} (got ${a}, want ~${b})`);
}
async function section(name: string, fn: () => void | Promise<void>) {
  console.log('• ' + name);
  await fn();
}

// --- helpers: build a synthetic page image with solid dark cheque bands ---
function makeWhite(w: number, h: number): Img {
  const data = new Uint8ClampedArray(w * h * 4);
  data.fill(255); // white, opaque
  return { data, width: w, height: h };
}
function fillRect(img: Img, x0: number, y0: number, x1: number, y1: number, v: number) {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * img.width + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    }
  }
}

(async () => {
  await section('image ops', () => {
    const img = makeWhite(10, 10);
    fillRect(img, 0, 0, 10, 5, 0);
    const gray = toGray(img);
    eq(gray.length, 100, 'gray length = w*h');
    ok(gray[0] === 0 && gray[99] === 255, 'gray reflects fill (top black, bottom white)');
    ok(percentileGray(gray, 95) >= 200, '95th percentile is bright on mostly-white');
    const c = cropImg(img, [0, 0, 0.5, 1]);
    eq([c.width, c.height], [5, 10], 'crop dimensions from normalized region');
  });

  await section('segmentation: 3 stacked cheques', () => {
    const w = 900, h = 600;
    const img = makeWhite(w, h);
    fillRect(img, 50, 20, 850, 160, 40);
    fillRect(img, 50, 220, 850, 360, 40);
    fillRect(img, 50, 420, 850, 560, 40);
    const { regions, flag } = detectChequeRegionsClassical(toGray(img), w, h);
    eq(regions.length, 3, 'detects 3 bands');
    ok(flag === 'ok', `flag is ok for clean stack (got ${flag})`);
    // ordered top-to-bottom
    ok(regions[0][1] < regions[1][1] && regions[1][1] < regions[2][1], 'regions ordered top-to-bottom');
  });

  await section('segmentation: single full cheque', () => {
    const w = 900, h = 600;
    const img = makeWhite(w, h);
    fillRect(img, 40, 30, 860, 570, 40); // one big block
    const { regions, flag } = detectChequeRegionsClassical(toGray(img), w, h);
    eq(regions.length, 1, 'single band -> one region');
    ok(flag === 'single', `flag is single (got ${flag})`);
    eq(regions[0], [0, 0, 1, 1], 'single resolves to full page');
  });

  await section('segmentation: blank page', () => {
    const w = 400, h = 300;
    const img = makeWhite(w, h);
    const { regions, flag } = detectChequeRegionsClassical(toGray(img), w, h);
    eq(flag, 'single', 'blank page flagged single');
    eq(regions[0], [0, 0, 1, 1], 'blank -> full page (never corrupts a single cheque)');
  });

  await section('segmentation: two cheques', () => {
    const w = 900, h = 600;
    const img = makeWhite(w, h);
    fillRect(img, 50, 40, 850, 260, 40);
    fillRect(img, 50, 340, 850, 560, 40);
    const { regions } = detectChequeRegionsClassical(toGray(img), w, h);
    eq(regions.length, 2, 'detects 2 bands');
  });

  await section('normalize: amounts', () => {
    near(parseAmount('1,234.56'), 1234.56, 0.001, 'US-style thousands');
    near(parseAmount('1.234,56'), 1234.56, 0.001, 'EU-style thousands');
    near(parseAmount(toWesternDigits('١٢٣٤٫٥٦')), 1234.56, 0.001, 'Eastern-Arabic digits');
    eq(formatAmount(1234.5), '1234.50', 'formatAmount pads to 2dp');
    eq(parseAmount('abc'), null, 'non-numeric -> null');
  });

  await section('normalize: words -> number', () => {
    near(wordsToNumber('one thousand two hundred thirty four and 50/100'), 1234.5, 0.001, 'compound words + fils');
    near(wordsToNumber('five hundred'), 500, 0.001, 'hundreds');
    eq(wordsToNumber('qwerty'), null, 'gibberish -> null');
  });

  await section('normalize: dates & cheque numbers', () => {
    eq(parseDate('25/12/2026').iso, '2026-12-25', 'DD/MM/YYYY');
    eq(parseDate('2026-03-09').iso, '2026-03-09', 'YYYY-MM-DD');
    ok(!parseDate('31/02/2026').valid, 'invalid calendar date rejected');
    eq(normalizeChequeNumber('123456789012'), '12345678', 'first 8 MICR digits');
    eq(normalizeChequeNumber('00 12 34 56 78', 8), '00123456', 'strips spaces, takes 8');
  });

  await section('validate: reconciliation gate', () => {
    const good = validateExtraction({
      amount_numeric: '1000.00', amount_words: 'one thousand', amount_words_value: 1000,
      date: '01/01/2026', payer: 'ACME LLC', bank: 'Qatar National Bank', cheque_number: '12345678'
    });
    ok(good.amountReconciled, 'agreeing digits/words reconcile');
    eq(good.status, 'ok', 'fully-read cheque is ok');
    eq(good.currency, 'QAR', 'currency inferred from Qatari bank');
    ok(!good.flags.some((f) => f.field === 'amount'), 'no amount flag when reconciled');

    const bad = validateExtraction({
      amount_numeric: '1000.00', amount_words: 'nine hundred', amount_words_value: 900,
      date: '01/01/2026', payer: 'ACME LLC', bank: 'CBQ', cheque_number: '12345678'
    });
    ok(!bad.amountReconciled, 'disagreeing amounts do NOT reconcile');
    ok(bad.flags.some((f) => f.field === 'amount' && f.severity === 'high'), 'amount high-flagged on mismatch');
    eq(bad.status, 'review', 'mismatch -> review');
    eq(bad.amount, '900.00', 'words value chosen when digits/words disagree');
  });

  await section('validate: handover & bad cheque number', () => {
    const v = validateExtraction({ amount_numeric: '50.00', amount_words: 'fifty', amount_words_value: 50, date: '', payer: 'X', bank: 'Doha Bank', cheque_number: '123' });
    eq(v.date, HANDOVER_MARKER, 'blank date -> handover marker');
    ok(v.flags.some((f) => f.field === 'chequeNumber' && f.severity === 'high'), 'short cheque number flagged');
  });

  await section('concurrency: mapPool', async () => {
    const items = [1, 2, 3, 4, 5, 6, 7];
    let active = 0, peak = 0;
    const out = await mapPool(items, 3, async (n) => {
      active++; peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return n * 2;
    });
    eq(out, [2, 4, 6, 8, 10, 12, 14], 'results preserve input order');
    ok(peak <= 3, `concurrency capped at limit (peak ${peak})`);
  });

  await section('few-shot: bank canonicalization & hints', () => {
    eq(canonicalBank('Qatar National Bank'), 'qnb', 'QNB name -> key');
    eq(canonicalBank('CBQ'), 'cbq', 'CBQ abbrev -> key');
    eq(canonicalBank('Some Unlisted Bank'), '', 'unknown bank -> empty key');
    const hint = buildHint('Doha Bank');
    ok(!!hint && hint.includes('Doha Bank'), 'known bank yields a static hint block');
    ok(buildHint('Some Unlisted Bank') === undefined, 'unknown bank with no exemplars -> no hint');
  });

  await section('provider routing', () => {
    eq(providerOf('gemini-2.5-flash-lite'), 'google', 'gemini model -> google');
    eq(providerOf('gemini-2.5-pro'), 'google', 'gemini pro -> google');
    eq(providerOf('claude-opus-4-8'), 'anthropic', 'claude model -> anthropic');
    ok(modelsFor('google').every((m) => m.provider === 'google'), 'modelsFor google all google');
    ok(modelsFor('anthropic').every((m) => m.provider === 'anthropic'), 'modelsFor anthropic all anthropic');
    ok(MODELS.some((m) => m.id === 'gemini-2.5-flash-lite'), 'catalog includes Gemini Flash-Lite');
    // strongest of each provider is last (used as default escalation target)
    eq(modelsFor('google').at(-1)?.id, 'gemini-2.5-pro', 'google strongest is Pro');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();

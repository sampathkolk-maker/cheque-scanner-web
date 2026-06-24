// Eastern-Arabic and Persian digits -> Western, plus Arabic decimal/thousands marks.
const EASTERN: Record<string, string> = {
  '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
  '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4', '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9',
  '٫': '.', '٬': ','
};

export function toWesternDigits(s: string): string {
  let out = '';
  for (const ch of s) out += EASTERN[ch] ?? ch;
  return out;
}

/** Parse a written amount into a number, tolerating separators and Arabic digits. */
export function parseAmount(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  let s = toWesternDigits(String(raw)).trim();
  s = s.replace(/[^0-9.,-]/g, '');
  if (!s) return null;
  // Decide whether ',' or '.' is the decimal separator by last-occurrence.
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma > lastDot) {
    s = s.replace(/\./g, '').replace(',', '.'); // European style: 1.234,56
    s = s.replace(/,/g, '');
  } else {
    s = s.replace(/,/g, ''); // 1,234.56
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Canonical money string with 2 decimals, or '' if unparseable. */
export function formatAmount(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return '';
  return n.toFixed(2);
}

/** First N digits of a MICR/number line (Qatari cheque number = first 8). */
export function normalizeChequeNumber(raw: string | null | undefined, take = 8): string {
  if (raw == null) return '';
  const digits = toWesternDigits(String(raw)).replace(/[^0-9]/g, '');
  if (!digits) return '';
  return digits.slice(0, take);
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12
};

export interface ParsedDate {
  iso: string; // YYYY-MM-DD when valid, else ''
  valid: boolean;
}

/** Parse common cheque date formats and validate the calendar date. */
export function parseDate(raw: string | null | undefined): ParsedDate {
  if (raw == null) return { iso: '', valid: false };
  const s = toWesternDigits(String(raw)).trim().toLowerCase();
  if (!s) return { iso: '', valid: false };

  // Numeric DMY / YMD with / - .
  const num = s.match(/(\d{1,4})[./-](\d{1,2})[./-](\d{1,4})/);
  if (num) {
    let a = parseInt(num[1], 10);
    const b = parseInt(num[2], 10);
    let c = parseInt(num[3], 10);
    let y: number, m: number, d: number;
    if (a > 31) {
      // YYYY-MM-DD
      y = a; m = b; d = c;
    } else {
      // DD-MM-YYYY (GCC convention); accept 2-digit year.
      d = a; m = b; y = c;
      if (y < 100) y += y < 70 ? 2000 : 1900;
    }
    void a; void c;
    return validateYMD(y, m, d);
  }

  // "12 Mar 2026" / "Mar 12 2026"
  const words = s.match(/([a-z]{3,})/);
  if (words) {
    const mon = MONTHS[words[1].slice(0, 3)];
    const nums = s.match(/\d{1,4}/g);
    if (mon && nums && nums.length >= 2) {
      const day = parseInt(nums[0], 10);
      let yr = parseInt(nums[nums.length - 1], 10);
      if (yr < 100) yr += yr < 70 ? 2000 : 1900;
      return validateYMD(yr, mon, day);
    }
  }
  return { iso: '', valid: false };
}

function validateYMD(y: number, m: number, d: number): ParsedDate {
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1900 || y > 2200) return { iso: '', valid: false };
  const dt = new Date(Date.UTC(y, m - 1, d));
  const valid = dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
  const iso = valid ? `${y.toString().padStart(4, '0')}-${pad2(m)}-${pad2(d)}` : '';
  return { iso, valid };
}
const pad2 = (n: number) => n.toString().padStart(2, '0');

// --- English words -> number (defense-in-depth cross-check of the courtesy line) ---
const SMALL: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90
};
const MAGNITUDE: Record<string, number> = { hundred: 100, thousand: 1000, million: 1_000_000, billion: 1_000_000_000 };

/** Best-effort English amount-in-words parser. Returns null if it can't parse. */
export function wordsToNumber(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const text = String(raw).toLowerCase().replace(/[,-]/g, ' ');
  const tokens = text.split(/\s+/).filter(Boolean);
  let total = 0;
  let current = 0;
  let matched = false;
  let fraction = 0;

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === 'and') continue;
    if (t === 'only' || t === 'riyals' || t === 'riyal' || t === 'dirhams' || t === 'dirham') continue;
    // "50/100" fils style
    const frac = t.match(/^(\d{1,2})\/100$/);
    if (frac) { fraction = parseInt(frac[1], 10) / 100; matched = true; continue; }
    if (t in SMALL) { current += SMALL[t]; matched = true; continue; }
    if (t === 'hundred') { current = (current || 1) * 100; matched = true; continue; }
    if (t in MAGNITUDE) {
      const mag = MAGNITUDE[t];
      total += (current || 1) * mag;
      current = 0;
      matched = true;
      continue;
    }
    // unknown token: ignore (model may include currency words in other languages)
  }
  if (!matched) return null;
  return total + current + fraction;
}

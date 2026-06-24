// Per-bank few-shot guidance injected on re-reads (escalation / self-consistency),
// once the first pass has identified the bank. Two sources:
//   1. A static table of layout/format hints for known GCC banks.
//   2. Exemplars learned from the user's own review-pane corrections — verified
//      ground truth that compounds accuracy on banks they process repeatedly.

const browser = typeof window !== 'undefined';
const LS_EXEMPLARS = 'cheque-scanner.exemplars.v1';
const MAX_PER_BANK = 3;

export interface Exemplar {
  amount: string;
  date: string;
  currency: string;
  chequeNumber: string;
}

// Canonical key + static guidance for known banks. Keys are matched as
// case-insensitive substrings of the detected bank name.
const BANKS: { key: string; names: string[]; label: string; hint: string }[] = [
  {
    key: 'qnb',
    names: ['qatar national', 'qnb'],
    label: 'Qatar National Bank (QNB)',
    hint: 'Amount box is top-right; courtesy line is centre, usually English. Cheque number = first 8 digits of the MICR line. Currency QAR.'
  },
  {
    key: 'cbq',
    names: ['commercial bank', 'cbq'],
    label: 'Commercial Bank of Qatar (CBQ)',
    hint: 'Bilingual layout; legal amount box upper-right. MICR cheque number is 8 digits. Currency QAR.'
  },
  {
    key: 'qib',
    names: ['qatar islamic', 'qib'],
    label: 'Qatar Islamic Bank (QIB)',
    hint: 'Arabic-forward layout; date often upper-right in DD/MM/YYYY. 8-digit cheque number. Currency QAR.'
  },
  {
    key: 'qiib',
    names: ['international islamic', 'qiib'],
    label: 'Qatar International Islamic Bank (QIIB)',
    hint: 'Bilingual; courtesy line may be Arabic. 8-digit MICR cheque number. Currency QAR.'
  },
  {
    key: 'doha',
    names: ['doha bank'],
    label: 'Doha Bank',
    hint: 'Amount box upper-right; English courtesy line common. 8-digit cheque number. Currency QAR.'
  },
  {
    key: 'rayan',
    names: ['al rayan', 'masraf'],
    label: 'Masraf Al Rayan',
    hint: 'Islamic-bank bilingual layout. 8-digit MICR cheque number. Currency QAR.'
  },
  {
    key: 'hsbc',
    names: ['hsbc'],
    label: 'HSBC',
    hint: 'English-forward layout; amount box upper-right. 8-digit cheque number.'
  }
];

/** Canonical bank key for a detected bank name, or '' if unknown. */
export function canonicalBank(bank: string): string {
  const b = (bank || '').toLowerCase();
  return BANKS.find((e) => e.names.some((n) => b.includes(n)))?.key ?? '';
}

function loadExemplars(): Record<string, Exemplar[]> {
  if (!browser) return {};
  try {
    return JSON.parse(localStorage.getItem(LS_EXEMPLARS) || '{}') as Record<string, Exemplar[]>;
  } catch {
    return {};
  }
}

function saveExemplars(map: Record<string, Exemplar[]>): void {
  if (!browser) return;
  try {
    localStorage.setItem(LS_EXEMPLARS, JSON.stringify(map));
  } catch {
    /* ignore */
  }
}

/** Record a verified exemplar from a user correction, keyed by bank. */
export function recordExemplar(bank: string, ex: Exemplar): void {
  const key = canonicalBank(bank) || (bank || '').toLowerCase().trim();
  if (!key || !ex.amount) return;
  const map = loadExemplars();
  const list = map[key] ?? [];
  // de-dup on amount+date, keep most recent at the front, cap the list
  const filtered = list.filter((e) => !(e.amount === ex.amount && e.date === ex.date));
  map[key] = [ex, ...filtered].slice(0, MAX_PER_BANK);
  saveExemplars(map);
}

/**
 * Build a textual few-shot hint for a bank: static guidance plus any learned
 * exemplars. Returns undefined when nothing is known about the bank.
 */
export function buildHint(bank: string): string | undefined {
  const key = canonicalBank(bank);
  const entry = BANKS.find((e) => e.key === key);
  const exemplars = (loadExemplars()[key || (bank || '').toLowerCase().trim()] ?? []).slice(0, 2);

  const parts: string[] = [];
  if (entry) parts.push(`Bank-specific guidance for ${entry.label}: ${entry.hint}`);
  if (exemplars.length) {
    const lines = exemplars
      .map((e) => `  - amount=${e.amount} ${e.currency}, date=${e.date}, cheque#=${e.chequeNumber}`)
      .join('\n');
    parts.push(`Recently human-verified examples for this bank (format references only, NOT answers for this image):\n${lines}`);
  }
  if (!parts.length) return undefined;
  return parts.join('\n\n');
}

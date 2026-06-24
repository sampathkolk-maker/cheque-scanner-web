import type { Region } from '$lib/types';

// Normalized ROIs on a single cheque image. Ported from the Python build; used
// for optional focused re-reads of weak fields (amount box, MICR line, date).
// Keys are matched as case-insensitive substrings of the detected bank name.

export interface BankRois {
  amount: Region;
  date: Region;
  micr: Region;
}

const DEFAULT_ROIS: BankRois = {
  amount: [0.56, 0.08, 0.99, 0.38],
  date: [0.66, 0.12, 0.99, 0.42],
  micr: [0.0, 0.8, 1.0, 1.0]
};

const BANK_TABLE: { keys: string[]; rois: Partial<BankRois> }[] = [
  { keys: ['qatar national', 'qnb'], rois: { amount: [0.58, 0.1, 0.98, 0.36] } },
  { keys: ['commercial bank', 'cbq'], rois: { amount: [0.58, 0.1, 0.98, 0.37] } },
  { keys: ['qatar islamic', 'qib'], rois: { amount: [0.58, 0.1, 0.98, 0.37] } },
  { keys: ['international islamic', 'qiib'], rois: { amount: [0.58, 0.1, 0.98, 0.37] } },
  { keys: ['doha bank'], rois: { amount: [0.58, 0.1, 0.98, 0.38] } },
  { keys: ['al rayan', 'masraf'], rois: { amount: [0.58, 0.1, 0.98, 0.38] } },
  { keys: ['hsbc'], rois: { amount: [0.58, 0.1, 0.98, 0.38] } }
];

export function roisForBank(bank: string): BankRois {
  const b = (bank || '').toLowerCase();
  const hit = BANK_TABLE.find((e) => e.keys.some((k) => b.includes(k)));
  return { ...DEFAULT_ROIS, ...(hit?.rois ?? {}) };
}

// Currency inferred from the bank's country when the model leaves it blank.
const CURRENCY_HINTS: { keys: string[]; currency: string }[] = [
  { keys: ['qatar', 'qnb', 'cbq', 'qib', 'qiib', 'doha', 'rayan', 'barwa'], currency: 'QAR' },
  { keys: ['emirates', 'dubai', 'abu dhabi', 'mashreq', 'enbd', 'adcb', 'fab'], currency: 'AED' },
  { keys: ['saudi', 'rajhi', 'riyad', 'alinma', 'ncb', 'snb'], currency: 'SAR' },
  { keys: ['kuwait', 'nbk', 'gulf bank', 'boubyan'], currency: 'KWD' },
  { keys: ['oman', 'bank muscat', 'nbo'], currency: 'OMR' },
  { keys: ['bahrain', 'bbk', 'ahli united'], currency: 'BHD' }
];

export function inferCurrency(bank: string): string {
  const b = (bank || '').toLowerCase();
  const hit = CURRENCY_HINTS.find((e) => e.keys.some((k) => b.includes(k)));
  return hit?.currency ?? '';
}

// Expected MICR cheque-number length by region (most GCC = 8).
export function expectedChequeDigits(_bank: string): number {
  return 8;
}

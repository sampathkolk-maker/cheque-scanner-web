import type { Flag, RawExtraction, FieldName, ChequeStatus } from '$lib/types';
import { parseAmount, formatAmount, wordsToNumber, parseDate, normalizeChequeNumber } from './normalize';
import { inferCurrency, expectedChequeDigits } from './rois';

export const HANDOVER_MARKER = 'HANDOVER PAYMENT';

export interface Validated {
  amount: string;
  amountWords: string;
  amountNumericValue: number | null;
  amountWordsValue: number | null;
  amountReconciled: boolean;
  currency: string;
  date: string;
  payer: string;
  bank: string;
  chequeNumber: string;
  hasHandwriting: boolean;
  flags: Flag[];
  confidence: number;
  status: ChequeStatus;
}

const CONF_WEIGHTS: Record<FieldName, number> = {
  amount: 3,
  date: 3,
  payer: 1,
  bank: 1.5,
  chequeNumber: 1.5
};
const CONF_TOTAL = Object.values(CONF_WEIGHTS).reduce((a, b) => a + b, 0);

function approxEqual(a: number, b: number): boolean {
  const diff = Math.abs(a - b);
  if (diff < 0.01) return true;
  const rel = diff / Math.max(Math.abs(a), Math.abs(b), 1);
  return rel < 0.005; // 0.5% tolerance for rounding/fils
}

/**
 * Turn a raw model extraction into validated, flagged fields. The central check
 * is the legal-vs-courtesy amount reconciliation: the numeric box and the
 * written-words value must agree, or the amount is flagged for human review.
 */
export function validateExtraction(raw: RawExtraction): Validated {
  const fc = raw.field_confidence ?? {};
  const flags: Flag[] = [];
  const bank = (raw.bank ?? '').trim();

  // --- Amount: reconcile legal (digits) vs courtesy (words) ---
  const numericVal = parseAmount(raw.amount_numeric);
  const wordsVal =
    raw.amount_words_value != null && Number.isFinite(raw.amount_words_value)
      ? Number(raw.amount_words_value)
      : wordsToNumber(raw.amount_words);

  let reconciled = false;
  if (numericVal != null && wordsVal != null) {
    reconciled = approxEqual(numericVal, wordsVal);
    if (!reconciled) {
      flags.push({
        field: 'amount',
        severity: 'high',
        reason: `Digits (${formatAmount(numericVal)}) and words (${formatAmount(wordsVal)}) disagree`
      });
    }
  } else if (numericVal == null && wordsVal == null) {
    flags.push({ field: 'amount', severity: 'high', reason: 'No amount detected' });
  } else {
    flags.push({
      field: 'amount',
      severity: 'low',
      reason: 'Only one of digits/words present; cannot cross-check'
    });
  }
  // Prefer the courtesy (words) value when the two disagree — words are the
  // legally controlling amount on a cheque.
  const chosen = reconciled ? numericVal : (wordsVal ?? numericVal);
  const amount = formatAmount(chosen ?? null);
  if (amount && (fc.amount ?? 1) < 0.7 && reconciled) {
    flags.push({ field: 'amount', severity: 'low', reason: 'Model low confidence on amount' });
  }

  // --- Date: validate calendar; detect blank handover cheques ---
  const rawDate = (raw.date ?? '').trim();
  let date = '';
  if (!rawDate) {
    date = HANDOVER_MARKER;
  } else {
    const pd = parseDate(rawDate);
    if (pd.valid) {
      date = pd.iso;
    } else {
      date = rawDate;
      flags.push({ field: 'date', severity: 'high', reason: 'Date does not parse to a valid calendar date' });
    }
  }

  // --- Cheque number: expect fixed-length MICR leading digits ---
  const expect = expectedChequeDigits(bank);
  const chequeNumber = normalizeChequeNumber(raw.cheque_number, expect);
  if (!chequeNumber) {
    flags.push({ field: 'chequeNumber', severity: 'high', reason: 'No cheque number detected' });
  } else if (chequeNumber.length !== expect) {
    flags.push({
      field: 'chequeNumber',
      severity: 'high',
      reason: `Expected ${expect} digits, got ${chequeNumber.length}`
    });
  }

  // --- Payer / bank ---
  const payer = (raw.payer ?? '').trim();
  if (!payer) flags.push({ field: 'payer', severity: 'low', reason: 'Payer not detected' });
  else if ((fc.payer ?? 1) < 0.6) flags.push({ field: 'payer', severity: 'low', reason: 'Model low confidence on payer' });

  if (!bank) flags.push({ field: 'bank', severity: 'low', reason: 'Bank not detected' });

  const currency = (raw.currency ?? '').trim() || inferCurrency(bank);

  // --- Confidence score (weighted field presence, penalised for review items) ---
  const present: Record<FieldName, boolean> = {
    amount: !!amount,
    date: !!date && date !== HANDOVER_MARKER,
    payer: !!payer,
    bank: !!bank,
    chequeNumber: chequeNumber.length === expect
  };
  let found = 0;
  (Object.keys(CONF_WEIGHTS) as FieldName[]).forEach((f) => {
    if (present[f]) found += CONF_WEIGHTS[f];
  });
  if (!reconciled && numericVal != null && wordsVal != null) found = Math.max(0, found - 2);
  const highFlags = flags.filter((f) => f.severity === 'high').length;
  found = Math.max(0, found - 0.5 * highFlags);
  const confidence = Math.round((found / CONF_TOTAL) * 100);

  const status: ChequeStatus = highFlags > 0 ? 'review' : 'ok';

  return {
    amount,
    amountWords: (raw.amount_words ?? '').trim(),
    amountNumericValue: numericVal,
    amountWordsValue: wordsVal,
    amountReconciled: reconciled,
    currency,
    date,
    payer,
    bank,
    chequeNumber,
    hasHandwriting: !!raw.has_handwriting,
    flags,
    confidence,
    status
  };
}

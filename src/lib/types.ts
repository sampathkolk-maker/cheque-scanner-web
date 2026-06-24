// Normalized bounding box on a page image: [x0, y0, x1, y1] each in [0, 1].
export type Region = [number, number, number, number];

export const FULL_PAGE: Region = [0, 0, 1, 1];

// A minimal image surface that works both in the browser (real ImageData) and
// in node tests (a plain object). Decouples the pure CV/image code from the DOM.
export interface Img {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export type FieldName = 'amount' | 'date' | 'payer' | 'bank' | 'chequeNumber';

export interface Flag {
  field: FieldName;
  severity: 'high' | 'low';
  reason: string;
}

export type ChequeStatus = 'ok' | 'review' | 'error';

// What the model returns (snake_case mirrors the tool schema it is forced into).
export interface RawExtraction {
  amount_numeric?: string;
  amount_words?: string;
  amount_words_value?: number | null;
  currency?: string;
  date?: string;
  payer?: string;
  bank?: string;
  cheque_number?: string;
  has_handwriting?: boolean;
  field_confidence?: Partial<Record<FieldName, number>>;
}

export interface ChequeResult {
  id: string; // `${pdfId}:${pageIndex}:${ordinal}` — stable, page-major, cheque-minor
  pdfId: string;
  sourceFile: string;
  pageIndex: number; // 0-based
  chequeOnPage: number; // 1-based
  chequesOnPage: number;
  region: Region;

  amount: string; // canonical numeric string, e.g. "1234.00"
  amountWords: string;
  amountNumericValue: number | null;
  amountWordsValue: number | null;
  currency: string;
  date: string;
  payer: string;
  bank: string;
  chequeNumber: string;
  hasHandwriting: boolean;

  amountReconciled: boolean;
  flags: Flag[];
  confidence: number; // 0-100
  status: ChequeStatus;
  reviewed: boolean;
  model: string;
  cropDataUrl?: string; // the cheque crop, for the review pane
  error?: string;
}

export interface Progress {
  pagesDone: number;
  totalPages: number;
  chequesFound: number;
  file: string;
}

export type Provider = 'anthropic' | 'google';

export type ModelId =
  | 'claude-haiku-4-5-20251001'
  | 'claude-sonnet-4-6'
  | 'claude-opus-4-8'
  | 'gemini-2.5-flash-lite'
  | 'gemini-2.5-pro';

export interface ModelInfo {
  id: ModelId;
  label: string;
  provider: Provider;
}

// Ordered weakest -> strongest within each provider (so the last entry for a
// provider is its strongest model, used as the default escalation target).
export const MODELS: ModelInfo[] = [
  { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash-Lite (cheap/fast)', provider: 'google' },
  { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro (accurate)', provider: 'google' },
  { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5 (fast)', provider: 'anthropic' },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (balanced)', provider: 'anthropic' },
  { id: 'claude-opus-4-8', label: 'Claude Opus 4.8 (most accurate)', provider: 'anthropic' }
];

/** Provider is derived from the model id, so a single API-key field serves whichever provider is active. */
export function providerOf(model: ModelId): Provider {
  return model.startsWith('gemini') ? 'google' : 'anthropic';
}

export function modelsFor(provider: Provider): ModelInfo[] {
  return MODELS.filter((m) => m.provider === provider);
}

export interface Settings {
  apiKey: string; // key for the active provider (derived from model); blank -> server env var
  model: ModelId;
  escalateModel: ModelId; // used to re-read flagged cheques
  enableEscalation: boolean;
  enableSelfConsistency: boolean; // sample flagged fields 3x, majority vote
  enableLlmSegmentation: boolean; // vision fallback on ambiguous pages
  enableBankFewShot: boolean; // inject per-bank guidance + learned exemplars on re-reads
  concurrency: number;
}

export const DEFAULT_SETTINGS: Settings = {
  apiKey: '',
  model: 'gemini-2.5-flash-lite',
  escalateModel: 'gemini-2.5-pro',
  enableEscalation: true,
  enableSelfConsistency: false,
  enableLlmSegmentation: true,
  enableBankFewShot: true,
  concurrency: 4
};

// Server request/response contracts for /api/extract.
export interface ExtractRequest {
  image: string; // base64 JPEG (no data: prefix)
  model: ModelId;
  mode: 'extract' | 'regions';
  hint?: string; // optional bank-specific few-shot guidance appended to the prompt
  apiKey?: string; // per-request key from settings; backend falls back to its env var if blank
}
export interface ExtractResponse {
  ok: boolean;
  data?: RawExtraction | { regions: { x0: number; y0: number; x1: number; y1: number }[] };
  error?: string;
}

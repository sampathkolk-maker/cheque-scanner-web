import { writable, get } from 'svelte/store';
import type { ChequeResult, Settings, Progress } from '$lib/types';
import { DEFAULT_SETTINGS } from '$lib/types';
import { putCrop, clearCrops } from '$lib/storage/cropStore';

const LS_RESULTS = 'cheque-scanner.results.v1';
const LS_SETTINGS = 'cheque-scanner.settings.v1';
const browser = typeof window !== 'undefined';

function load<T>(key: string, fallback: T): T {
  if (!browser) return fallback;
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export const settings = writable<Settings>({ ...DEFAULT_SETTINGS, ...load<Partial<Settings>>(LS_SETTINGS, {}) });
export const results = writable<ChequeResult[]>(load(LS_RESULTS, []));
export const progress = writable<Progress | null>(null);
export const busy = writable(false);

if (browser) {
  // Persist settings and results so a reload doesn't lose work (resume support).
  settings.subscribe((s) => localStorage.setItem(LS_SETTINGS, JSON.stringify(s)));
  let t: ReturnType<typeof setTimeout> | null = null;
  results.subscribe((r) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => localStorage.setItem(LS_RESULTS, JSON.stringify(stripCrops(r))), 300);
  });
}

// Crops are large data URLs; don't persist them (re-rendered on demand).
function stripCrops(rows: ChequeResult[]): ChequeResult[] {
  return rows.map((r) => ({ ...r, cropDataUrl: undefined }));
}

function sortKey(r: ChequeResult): string {
  // page-major, cheque-minor, padded for lexicographic ordering
  return `${r.pdfId}:${String(r.pageIndex).padStart(6, '0')}:${String(r.chequeOnPage).padStart(3, '0')}`;
}

export function upsertResult(r: ChequeResult): void {
  if (r.cropDataUrl) void putCrop(r.id, r.cropDataUrl); // cache full-res crop for later review
  results.update((rows) => {
    const idx = rows.findIndex((x) => x.id === r.id);
    if (idx >= 0) rows[idx] = r;
    else rows.push(r);
    rows.sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
    return [...rows];
  });
}

export function patchResult(id: string, patch: Partial<ChequeResult>): void {
  results.update((rows) => rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
}

export function clearResults(): void {
  results.set([]);
  progress.set(null);
  void clearCrops();
}

const CSV_FIELDS: (keyof ChequeResult)[] = [
  'sourceFile', 'pageIndex', 'chequeOnPage', 'chequesOnPage',
  'amount', 'currency', 'amountReconciled', 'amountWords',
  'date', 'payer', 'bank', 'chequeNumber', 'hasHandwriting',
  'confidence', 'status', 'model', 'reviewed', 'error'
];

function csvCell(v: unknown): string {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export function exportCsv(): void {
  const rows = get(results);
  const header = [...CSV_FIELDS.map(String), 'flags'];
  const lines = [header.join(',')];
  for (const r of rows) {
    const base = CSV_FIELDS.map((f) => csvCell(r[f]));
    const flags = r.flags.map((f) => `${f.field}:${f.severity}:${f.reason}`).join(' | ');
    lines.push([...base, csvCell(flags)].join(','));
  }
  const blob = new Blob(['\uFEFF' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'cheques_export.csv';
  a.click();
  URL.revokeObjectURL(url);
}

import type { ModelId, RawExtraction, Region } from '$lib/types';
import { callBackend } from '$lib/llm/transport';

/** Full-cheque field read. Throws on transport/auth error so the pipeline can mark the row. */
export async function extractFields(imageBase64: string, model: ModelId, apiKey: string, hint?: string): Promise<RawExtraction> {
  const r = await callBackend({ image: imageBase64, model, mode: 'extract', hint, apiKey });
  if (!r.ok || !r.data) throw new Error(r.error || 'Extraction failed');
  return r.data as RawExtraction;
}

/** Vision region proposal for ambiguous pages. Returns [] on any failure. */
export async function proposeRegions(imageBase64: string, model: ModelId, apiKey: string): Promise<Region[]> {
  try {
    const r = await callBackend({ image: imageBase64, model, mode: 'regions', apiKey });
    if (!r.ok || !r.data || !('regions' in r.data)) return [];
    const out: Region[] = [];
    for (const it of r.data.regions) {
      let { x0, y0, x1, y1 } = it;
      if (Math.max(x0, y0, x1, y1) > 1.5) {
        x0 /= 100; y0 /= 100; x1 /= 100; y1 /= 100;
      }
      const a: [number, number] = [Math.max(0, Math.min(1, x0)), Math.max(0, Math.min(1, x1))].sort((p, q) => p - q) as [number, number];
      const b: [number, number] = [Math.max(0, Math.min(1, y0)), Math.max(0, Math.min(1, y1))].sort((p, q) => p - q) as [number, number];
      if (a[1] - a[0] > 0.05 && b[1] - b[0] > 0.03) out.push([a[0], b[0], a[1], b[1]]);
    }
    return out;
  } catch {
    return [];
  }
}

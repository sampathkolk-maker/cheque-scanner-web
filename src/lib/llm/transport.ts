import type { ExtractRequest, ExtractResponse } from '$lib/types';

// True only inside a Tauri webview. In that case the API key lives in the Rust
// backend and we call a command; on the web we POST to the SvelteKit route.
function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

type TauriGlobal = { core: { invoke: (cmd: string, args?: unknown) => Promise<unknown> } };

export async function callBackend(body: ExtractRequest): Promise<ExtractResponse> {
  if (isTauri()) {
    try {
      const tauri = (window as unknown as { __TAURI__: TauriGlobal }).__TAURI__;
      const data = await tauri.core.invoke('extract_cheque', {
        image: body.image,
        model: body.model,
        mode: body.mode,
        hint: body.hint ?? null,
        apiKey: body.apiKey ?? null
      });
      return { ok: true, data: data as ExtractResponse['data'] };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  const res = await fetch('/api/extract', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const j = (await res.json()) as ExtractResponse;
      if (j.error) msg = j.error;
    } catch {
      /* ignore */
    }
    return { ok: false, error: msg };
  }
  return (await res.json()) as ExtractResponse;
}

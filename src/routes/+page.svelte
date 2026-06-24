<script lang="ts">
  import { settings, results, progress, busy, upsertResult, patchResult, clearResults, exportCsv } from '$lib/stores';
  import { processFiles } from '$lib/pipeline';
  import ReviewPane from '$lib/components/ReviewPane.svelte';
  import { MODELS, modelsFor, providerOf, type ChequeResult } from '$lib/types';

  let files = $state<File[]>([]);
  let selected = $state<ChequeResult | null>(null);
  let dragOver = $state(false);

  // Escalation must stay within the same provider as the primary model (one key).
  const escalateOpts = $derived(modelsFor(providerOf($settings.model)));
  const keyLabel = $derived(providerOf($settings.model) === 'google' ? 'Google AI API key' : 'Anthropic API key');

  function onModelChange() {
    const p = providerOf($settings.model);
    if (providerOf($settings.escalateModel) !== p) {
      const opts = modelsFor(p);
      $settings.escalateModel = opts[opts.length - 1].id; // strongest of that provider
    }
  }

  const summary = $derived.by(() => {
    const r = $results;
    const ok = r.filter((x) => x.status === 'ok').length;
    const review = r.filter((x) => x.status === 'review').length;
    const error = r.filter((x) => x.status === 'error').length;
    const avg = r.length ? Math.round(r.reduce((a, x) => a + x.confidence, 0) / r.length) : 0;
    return { total: r.length, ok, review, error, avg };
  });

  const pct = $derived($progress && $progress.totalPages ? Math.round(($progress.pagesDone / $progress.totalPages) * 100) : 0);

  function pickFiles(list: FileList | null) {
    if (!list) return;
    files = Array.from(list).filter((f) => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'));
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    dragOver = false;
    pickFiles(e.dataTransfer?.files ?? null);
  }

  async function start() {
    if (!files.length || $busy) return;
    clearResults();
    busy.set(true);
    try {
      await processFiles(files, $settings, upsertResult, (p) => progress.set(p));
    } catch (e) {
      alert('Extraction failed: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      busy.set(false);
    }
  }

  function pgChq(r: ChequeResult) {
    return r.chequesOnPage > 1 ? `${r.pageIndex + 1}·${r.chequeOnPage}/${r.chequesOnPage}` : `p${r.pageIndex + 1}`;
  }
</script>

<main>
  <header class="top">
    <h1>Cheque Scanner <span class="muted">· multi-cheque · browser-side</span></h1>
    <div class="actions">
      <button onclick={exportCsv} disabled={!$results.length}>Export CSV</button>
      <button onclick={() => clearResults()} disabled={!$results.length || $busy}>Clear</button>
    </div>
  </header>

  <section
    class="drop panel"
    class:over={dragOver}
    role="button"
    tabindex="0"
    ondragover={(e) => { e.preventDefault(); dragOver = true; }}
    ondragleave={() => (dragOver = false)}
    ondrop={onDrop}
  >
    <input id="file" type="file" accept="application/pdf" multiple onchange={(e) => pickFiles((e.target as HTMLInputElement).files)} />
    <label for="file" class="filebtn">Choose PDF scans</label>
    <span class="muted">{files.length ? `${files.length} file(s) selected` : 'or drop PDF files here'}</span>
  </section>

  <section class="controls panel">
    <label class="chk keyrow">{keyLabel}
      <input type="password" placeholder="paste key (stored locally in this browser) — or leave blank to use the server env var" bind:value={$settings.apiKey} autocomplete="off" spellcheck="false" />
    </label>
    <label class="chk">Model
      <select bind:value={$settings.model} onchange={onModelChange}>
        {#each MODELS as m}<option value={m.id}>{m.label}</option>{/each}
      </select>
    </label>
    <label class="chk">Escalate to
      <select bind:value={$settings.escalateModel}>
        {#each escalateOpts as m}<option value={m.id}>{m.label}</option>{/each}
      </select>
    </label>
    <label class="chk"><input type="checkbox" bind:checked={$settings.enableEscalation} /> Re-read flagged with stronger model</label>
    <label class="chk"><input type="checkbox" bind:checked={$settings.enableSelfConsistency} /> Self-consistency on flagged amounts</label>
    <label class="chk"><input type="checkbox" bind:checked={$settings.enableLlmSegmentation} /> LLM fallback for ambiguous pages</label>
    <label class="chk"><input type="checkbox" bind:checked={$settings.enableBankFewShot} /> Bank-specific few-shot on re-reads</label>
    <label class="chk">Concurrency
      <input type="number" min="1" max="16" bind:value={$settings.concurrency} style="width:60px" />
    </label>
    <button class="primary" onclick={start} disabled={!files.length || $busy}>{$busy ? 'Processing…' : 'Start extraction'}</button>
  </section>

  {#if $busy || $progress}
    <section class="progresswrap">
      <div class="progress"><div style="width:{pct}%"></div></div>
      <span class="muted mono">
        {#if $progress}{$progress.pagesDone}/{$progress.totalPages} pages · {$progress.chequesFound} cheque(s){:else}starting…{/if}
      </span>
    </section>
  {/if}

  {#if $results.length}
    <section class="summary muted">
      {summary.total} cheque(s) · <span style="color:var(--ok)">{summary.ok} ok</span> ·
      <span style="color:var(--warn)">{summary.review} review</span> ·
      <span style="color:var(--err)">{summary.error} error</span> · avg confidence {summary.avg}%
    </section>

    <section class="panel tablewrap">
      <table>
        <thead>
          <tr>
            <th>#</th><th>Pg·Chq</th><th>File</th><th>Amount</th><th>Cur</th>
            <th>Date</th><th>Payer</th><th>Bank</th><th>Chq #</th><th>Conf</th><th>Status</th><th></th>
          </tr>
        </thead>
        <tbody>
          {#each $results as r, i (r.id)}
            <tr class="clickable {r.status}" onclick={() => (selected = r)}>
              <td class="muted">{i + 1}</td>
              <td class="mono">{pgChq(r)}{!r.amountReconciled && r.amount ? '' : ''}</td>
              <td>{r.sourceFile}</td>
              <td class="mono">{r.amount}{!r.amountReconciled && r.amount ? ' ⚠' : ''}{r.reviewed ? ' ✎' : ''}</td>
              <td>{r.currency}</td>
              <td class="mono">{r.date}</td>
              <td>{r.payer}</td>
              <td>{r.bank}</td>
              <td class="mono">{r.chequeNumber}</td>
              <td>{r.confidence}%</td>
              <td><span class="badge {r.status}">{r.status}</span></td>
              <td><button onclick={(e) => { e.stopPropagation(); selected = r; }}>Review</button></td>
            </tr>
          {/each}
        </tbody>
      </table>
    </section>
  {/if}
</main>

{#if selected}
  {#key selected.id}
    <ReviewPane result={selected} onSave={patchResult} onClose={() => (selected = null)} />
  {/key}
{/if}

<style>
  main { max-width: 1280px; margin: 0 auto; padding: 18px; display: flex; flex-direction: column; gap: 14px; }
  .top { display: flex; justify-content: space-between; align-items: center; }
  .actions { display: flex; gap: 8px; }
  .drop { padding: 18px; display: flex; align-items: center; gap: 14px; border-style: dashed; }
  .drop.over { border-color: var(--accent); }
  .drop input[type=file] { display: none; }
  .filebtn { background: var(--panel-2); border: 1px solid var(--border); border-radius: 6px; padding: 6px 12px; cursor: pointer; font-size: 13px; }
  .filebtn:hover { border-color: var(--accent); }
  .controls { padding: 12px; display: flex; flex-wrap: wrap; gap: 14px; align-items: center; }
  .keyrow { flex-basis: 100%; }
  .keyrow input { flex: 1; min-width: 280px; font-family: var(--mono); }
  .progresswrap { display: flex; align-items: center; gap: 12px; }
  .progresswrap .progress { flex: 1; }
  .summary { font-size: 13px; }
  .tablewrap { overflow: auto; max-height: 62vh; }
</style>

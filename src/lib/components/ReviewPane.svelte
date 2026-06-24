<script lang="ts">
  import type { ChequeResult } from '$lib/types';
  import { untrack, onMount } from 'svelte';
  import { getCrop } from '$lib/storage/cropStore';
  import { recordExemplar } from '$lib/extract/fewshot';

  let {
    result,
    onSave,
    onClose
  }: {
    result: ChequeResult;
    onSave: (id: string, patch: Partial<ChequeResult>) => void;
    onClose: () => void;
  } = $props();

  // One-time snapshot; the pane is remounted per selection via {#key} upstream.
  const seed = untrack(() => result);
  let amount = $state(seed.amount);
  let currency = $state(seed.currency);
  let date = $state(seed.date);
  let payer = $state(seed.payer);
  let bank = $state(seed.bank);
  let chequeNumber = $state(seed.chequeNumber);

  // In-session the crop is on the result; after a reload it comes from IndexedDB.
  let cropUrl = $state<string | null>(seed.cropDataUrl ?? null);
  onMount(async () => {
    if (!cropUrl) cropUrl = await getCrop(seed.id);
  });

  function save() {
    onSave(result.id, {
      amount,
      currency,
      date,
      payer,
      bank,
      chequeNumber,
      reviewed: true,
      status: 'ok',
      flags: []
    });
    // A manual correction is verified ground truth — feed it back as a few-shot exemplar.
    if (bank.trim()) recordExemplar(bank, { amount, date, currency, chequeNumber });
    onClose();
  }

  const fieldFlags = $derived(
    Object.fromEntries(result.flags.map((f) => [f.field, f.reason])) as Record<string, string>
  );
</script>

<div
  class="overlay"
  role="button"
  tabindex="0"
  onclick={onClose}
  onkeydown={(e) => e.key === 'Escape' && onClose()}
></div>
<aside class="pane panel">
  <header>
    <strong>Review · {result.sourceFile} · p{result.pageIndex + 1}{result.chequesOnPage > 1 ? `#${result.chequeOnPage}/${result.chequesOnPage}` : ''}</strong>
    <button onclick={onClose}>Close</button>
  </header>

  <div class="crop">
    {#if cropUrl}
      <img src={cropUrl} alt="cheque crop" />
    {:else}
      <p class="muted">Loading crop…</p>
    {/if}
  </div>

  <div class="fields">
    {#each [['Amount', 'amount'], ['Currency', 'currency'], ['Date', 'date'], ['Payer', 'payer'], ['Bank', 'bank'], ['Cheque #', 'chequeNumber']] as [label, key]}
      <label>
        <span>{label}{fieldFlags[key === 'chequeNumber' ? 'chequeNumber' : key] ? ' ⚠' : ''}</span>
        {#if key === 'amount'}
          <input type="text" bind:value={amount} class="mono" />
        {:else if key === 'currency'}
          <input type="text" bind:value={currency} />
        {:else if key === 'date'}
          <input type="text" bind:value={date} class="mono" />
        {:else if key === 'payer'}
          <input type="text" bind:value={payer} />
        {:else if key === 'bank'}
          <input type="text" bind:value={bank} />
        {:else}
          <input type="text" bind:value={chequeNumber} class="mono" />
        {/if}
      </label>
    {/each}
  </div>

  {#if result.amountWords}
    <p class="muted words">Words read: “{result.amountWords}”{result.amountReconciled ? ' · reconciled ✓' : ' · NOT reconciled ✗'}</p>
  {/if}

  {#if result.flags.length}
    <ul class="flags">
      {#each result.flags as f}
        <li class={f.severity}>{f.field}: {f.reason}</li>
      {/each}
    </ul>
  {/if}

  <footer>
    <button class="primary" onclick={save}>Save correction</button>
  </footer>
</aside>

<style>
  .overlay { position: fixed; inset: 0; background: rgba(0,0,0,.5); z-index: 10; }
  .pane {
    position: fixed; top: 0; right: 0; height: 100vh; width: min(460px, 92vw);
    z-index: 11; padding: 16px; overflow-y: auto; display: flex; flex-direction: column; gap: 14px;
    border-radius: 0;
  }
  header, footer { display: flex; justify-content: space-between; align-items: center; gap: 10px; }
  .crop { background: #000; border: 1px solid var(--border); border-radius: 8px; padding: 6px; }
  .crop img { width: 100%; height: auto; display: block; border-radius: 4px; }
  .fields { display: grid; gap: 10px; }
  .fields label { display: grid; gap: 4px; }
  .fields span { color: var(--muted); font-size: 12px; }
  .words { font-size: 12px; }
  .flags { margin: 0; padding-left: 18px; font-size: 12px; }
  .flags li.high { color: var(--warn); }
  .flags li.low { color: var(--muted); }
</style>

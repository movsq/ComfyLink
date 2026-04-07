<script>
  import { listResults, getResultFull, deleteResult } from '../lib/api.js';
  import { decryptBlob, b64ToBuf } from '../lib/vault-crypto.js';

  let { token, masterKey, onClose, onUseAsInput = null } = $props();

  let items = $state([]);
  let loading = $state(true);
  let loadError = $state('');
  let hasMore = $state(false);
  let loadingMore = $state(false);

  const PAGE_LIMIT = 20;

  // Full-view state
  let viewingId = $state(null);
  let viewUrl = $state(null);
  let viewBytes = $state(null);
  let viewLoading = $state(false);
  let viewError = $state('');
  let useInputOpen = $state(false);
  let assigningInput = $state(false);
  let inputAssignError = $state('');

  // Delete state
  let deletingId = $state(null);

  $effect(() => {
    loadInitial();
  });

  async function loadInitial() {
    loading = true;
    loadError = '';
    try {
      const data = await listResults(token, { limit: PAGE_LIMIT });
      await decryptThumbnails(data);
      items = data;
      hasMore = data.length >= PAGE_LIMIT;
    } catch (err) {
      loadError = err.message || 'Failed to load gallery';
    } finally {
      loading = false;
    }
  }

  async function loadMore() {
    if (loadingMore || !hasMore || items.length === 0) return;
    loadingMore = true;
    try {
      const last = items[items.length - 1];
      const data = await listResults(token, { limit: PAGE_LIMIT, before: last.id });
      await decryptThumbnails(data);
      items = [...items, ...data];
      hasMore = data.length >= PAGE_LIMIT;
    } catch {
      // silently fail pagination
    } finally {
      loadingMore = false;
    }
  }

  async function decryptThumbnails(results) {
    for (const r of results) {
      try {
        const encBuf = b64ToBuf(r.encryptedThumb);
        const ivBuf = b64ToBuf(r.ivThumb);
        const plain = await decryptBlob(masterKey, ivBuf, encBuf);
        const blob = new Blob([plain], { type: 'image/webp' });
        r._thumbUrl = URL.createObjectURL(blob);
      } catch {
        r._thumbUrl = null;
      }
    }
  }

  async function viewFull(id) {
    viewingId = id;
    viewUrl = null;
    viewBytes = null;
    viewLoading = true;
    viewError = '';
    useInputOpen = false;
    inputAssignError = '';
    try {
      const data = await getResultFull(token, id);
      const encBuf = b64ToBuf(data.encryptedFull);
      const ivBuf = b64ToBuf(data.ivFull);
      const plain = await decryptBlob(masterKey, ivBuf, encBuf);
      viewBytes = plain;
      const blob = new Blob([plain], { type: 'image/png' });
      viewUrl = URL.createObjectURL(blob);
    } catch (err) {
      viewError = err.message || 'Failed to load image';
    } finally {
      viewLoading = false;
    }
  }

  function closeView() {
    if (viewUrl) URL.revokeObjectURL(viewUrl);
    viewingId = null;
    viewUrl = null;
    viewBytes = null;
    viewError = '';
    useInputOpen = false;
    inputAssignError = '';
  }

  async function assignToInput(slot) {
    if (!onUseAsInput || !viewBytes || assigningInput || (slot !== 1 && slot !== 2)) return;
    assigningInput = true;
    inputAssignError = '';
    try {
      const ok = await onUseAsInput({
        slot,
        bytes: viewBytes,
        mime: 'image/png',
        filename: `vault-${viewingId}.png`,
      });
      if (ok) {
        useInputOpen = false;
      } else {
        inputAssignError = 'Could not set input right now.';
      }
    } catch {
      inputAssignError = 'Could not set input right now.';
    } finally {
      assigningInput = false;
    }
  }

  async function handleDelete(id) {
    deletingId = id;
    try {
      await deleteResult(token, id);
      const item = items.find(r => r.id === id);
      if (item?._thumbUrl) URL.revokeObjectURL(item._thumbUrl);
      items = items.filter(r => r.id !== id);
      if (viewingId === id) closeView();
    } catch {
      // silently fail
    } finally {
      deletingId = null;
    }
  }

  function formatDate(iso) {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function formatSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1048576).toFixed(1)} MB`;
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_noninteractive_element_interactions -->
<div class="backdrop" role="dialog" aria-modal="true" tabindex="-1" onclick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
  <div class="panel">
    <div class="handle"></div>

    <div class="header">
      <span class="title">SAVED RESULTS</span>
      <button class="close-btn" type="button" onclick={onClose} aria-label="Close">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
      </button>
    </div>

    {#if loading}
      <p class="status">LOADING…</p>
    {:else if loadError}
      <p class="error">{loadError}</p>
    {:else if items.length === 0}
      <p class="empty">No saved results yet.</p>
    {:else}
      <div class="grid">
        {#each items as item (item.id)}
          <button class="thumb-card" onclick={() => viewFull(item.id)} aria-label="View image">
            {#if item._thumbUrl}
              <img src={item._thumbUrl} alt="" class="thumb-img" />
            {:else}
              <div class="thumb-broken">?</div>
            {/if}
            <span class="thumb-meta">{formatDate(item.createdAt)}</span>
          </button>
        {/each}
      </div>

      {#if hasMore}
        <button class="load-more" onclick={loadMore} disabled={loadingMore}>
          {loadingMore ? 'Loading…' : 'Load more'}
        </button>
      {/if}
    {/if}
  </div>
</div>

<!-- Full image viewer overlay -->
{#if viewingId !== null}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_noninteractive_element_interactions -->
  <div class="view-backdrop" role="dialog" aria-modal="true" tabindex="-1" onclick={(e) => { if (e.target === e.currentTarget) closeView(); }}>
    <div class="view-panel">
      <button class="close-btn view-close" onclick={closeView} aria-label="Close">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
      </button>

      {#if viewLoading}
        <p class="status">DECRYPTING…</p>
      {:else if viewError}
        <p class="error">{viewError}</p>
      {:else if viewUrl}
        <img src={viewUrl} alt="Saved result" class="view-img" />
        <div class="view-actions">
          <a href={viewUrl} download="result.png" class="btn btn-accent">Download</a>
          <button class="btn btn-danger" onclick={() => handleDelete(viewingId)} disabled={deletingId === viewingId}>
            {deletingId === viewingId ? 'Deleting…' : 'Delete'}
          </button>
          <button class="btn btn-ghost" onclick={closeView}>Close</button>
        </div>
        <div class="use-input-row">
          <div class="use-input-wrap">
            <button
              class="btn btn-ghost"
              onclick={() => { useInputOpen = !useInputOpen; inputAssignError = ''; }}
              disabled={!viewBytes || assigningInput}
              aria-haspopup="true"
              aria-expanded={useInputOpen}
            >
              {assigningInput ? 'Assigning…' : 'Use as Input'}
            </button>
            {#if useInputOpen}
              <div class="use-input-picker" role="menu" aria-label="Select input slot">
                <button class="picker-btn" role="menuitem" onclick={() => assignToInput(1)} disabled={assigningInput}>Input 1</button>
                <button class="picker-btn" role="menuitem" onclick={() => assignToInput(2)} disabled={assigningInput}>Input 2</button>
              </div>
            {/if}
          </div>
        </div>
        {#if inputAssignError}
          <p class="error">{inputAssignError}</p>
        {/if}
      {/if}
    </div>
  </div>
{/if}

<style>
  .backdrop {
    position: fixed; inset: 0; z-index: 50;
    background: rgba(0, 0, 0, 0.78);
    backdrop-filter: blur(8px);
    display: flex; align-items: flex-end; justify-content: center;
    animation: fade-in 0.22s ease both;
  }
  @media (min-width: 480px) {
    .backdrop { align-items: center; padding: 1.5rem; }
  }
  @keyframes fade-in { from { opacity: 0 } to { opacity: 1 } }

  .panel {
    width: 100%; max-width: 460px;
    background: rgba(14, 14, 18, 0.94);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 1.25rem 1.25rem 0 0;
    padding: 0 1.25rem 1.25rem;
    backdrop-filter: blur(24px);
    display: flex; flex-direction: column; gap: 0.875rem;
    max-height: 85dvh; overflow-y: auto;
    animation: sheet-up 0.28s cubic-bezier(0.16, 1, 0.3, 1) both;
    user-select: none;
    -webkit-user-select: none;
  }
  @media (min-width: 480px) {
    .panel { border-radius: 1.25rem; max-height: 80vh; }
  }
  @keyframes sheet-up {
    from { transform: translateY(100%); opacity: 0; }
    to   { transform: translateY(0);    opacity: 1; }
  }

  .handle {
    width: 2.5rem; height: 3px; border-radius: 9999px;
    background: rgba(255, 255, 255, 0.12);
    align-self: center; margin: 1rem 0 0.5rem; flex-shrink: 0;
  }
  @media (min-width: 480px) { .handle { display: none; } }

  .header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 0.25rem 0 0;
  }
  .title {
    font-family: 'DM Mono', monospace;
    font-size: 0.65rem; letter-spacing: 0.22em; color: #527490;
  }
  .close-btn {
    width: 2rem; height: 2rem; border-radius: 50%;
    border: 1px solid rgba(255, 255, 255, 0.08);
    background: rgba(255, 255, 255, 0.05);
    color: #a4afbb; display: flex; align-items: center; justify-content: center;
    cursor: pointer; transition: transform 0.12s, background 0.2s, color 0.2s;
  }
  .close-btn:hover { background: rgba(255, 255, 255, 0.1); color: #e4e4e7; }
  .close-btn:active { transform: scale(0.88); filter: brightness(0.85); }

  .status {
    font-family: 'DM Mono', monospace;
    color: #527490; font-size: 0.8rem; letter-spacing: 0.08em; margin: 0; text-align: center;
  }
  .error {
    font-family: 'DM Mono', monospace;
    color: #c47070; font-size: 0.78rem; margin: 0;
  }
  .empty {
    font-family: 'DM Mono', monospace;
    color: #525a66; font-size: 0.8rem; text-align: center; margin: 2rem 0;
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 0.5rem;
  }

  .thumb-card {
    aspect-ratio: 1;
    border-radius: 0.625rem;
    border: 1px solid rgba(255, 255, 255, 0.06);
    background: rgba(255, 255, 255, 0.03);
    overflow: hidden;
    cursor: pointer;
    position: relative;
    transition: transform 0.12s, border-color 0.2s;
    padding: 0;
  }
  .thumb-card:hover {
    border-color: rgba(82, 116, 144, 0.3);
    transform: scale(1.02);
  }
  .thumb-card:active { transform: scale(0.96); }

  .thumb-img {
    width: 100%; height: 100%;
    object-fit: cover; display: block;
  }
  .thumb-broken {
    width: 100%; height: 100%;
    display: flex; align-items: center; justify-content: center;
    color: #525a66; font-family: 'DM Mono', monospace; font-size: 1.2rem;
  }
  .thumb-meta {
    position: absolute; bottom: 0; left: 0; right: 0;
    padding: 0.2rem 0.35rem;
    background: linear-gradient(transparent, rgba(0, 0, 0, 0.65));
    font-family: 'DM Mono', monospace; font-size: 0.52rem;
    color: #a4afbb; text-align: right;
  }

  .load-more {
    align-self: center;
    padding: 0.5rem 1.5rem;
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 3rem;
    color: #8b96a6;
    font-family: 'DM Mono', monospace; font-size: 0.7rem; letter-spacing: 0.08em;
    cursor: pointer; transition: background 0.2s, color 0.2s;
  }
  .load-more:hover { background: rgba(255, 255, 255, 0.1); color: #c2ccd5; }
  .load-more:disabled { opacity: 0.5; cursor: not-allowed; }

  /* Full image viewer */
  .view-backdrop {
    position: fixed; inset: 0; z-index: 110;
    background: rgba(0, 0, 0, 0.88);
    backdrop-filter: blur(10px);
    display: flex; align-items: center; justify-content: center;
    padding: 1rem;
    animation: fade-in 0.18s ease both;
  }

  .view-panel {
    position: relative;
    max-width: 600px; width: 100%;
    max-height: calc(100dvh - 2rem);
    display: flex; flex-direction: column;
    gap: 0.75rem; align-items: center;
    user-select: none;
    -webkit-user-select: none;
  }

  .view-close {
    position: absolute; top: -0.5rem; right: -0.5rem; z-index: 1;
  }

  .view-img {
    width: 100%; max-height: calc(100dvh - 8rem);
    object-fit: contain;
    border-radius: 0.875rem;
    border: 1px solid rgba(255, 255, 255, 0.07);
    -webkit-touch-callout: default;
    user-select: none;
    -webkit-user-select: none;
  }

  .view-actions {
    display: flex;
    gap: 0.75rem;
    width: 100%;
    max-width: 520px;
    flex-wrap: wrap;
    justify-content: center;
  }

  .use-input-row {
    width: 100%;
    max-width: 520px;
    display: flex;
    justify-content: center;
  }

  .use-input-wrap {
    width: 100%;
    max-width: 320px;
    position: relative;
  }

  .btn {
    flex: 1;
    min-width: 120px;
    padding: 0.7rem;
    border: none; border-radius: 3rem;
    font-family: 'DM Mono', monospace;
    font-size: 0.72rem; letter-spacing: 0.08em;
    cursor: pointer; text-align: center; text-decoration: none;
    display: inline-flex; align-items: center; justify-content: center;
    transition: transform 0.12s, filter 0.12s, background 0.2s;
  }
  .btn:active { transform: scale(0.95); filter: brightness(0.85); }

  .btn-accent { background: #527490; color: #09090b; }
  .btn-accent:hover { background: #7d9db6; }

  .btn-danger {
    background: rgba(196, 112, 112, 0.15);
    color: #c47070;
    border: 1px solid rgba(196, 112, 112, 0.2);
  }
  .btn-danger:hover { background: rgba(196, 112, 112, 0.25); }
  .btn-danger:disabled { opacity: 0.5; cursor: not-allowed; }

  .btn-ghost {
    background: rgba(255, 255, 255, 0.06);
    color: #c2ccd5;
    border: 1px solid rgba(255, 255, 255, 0.08);
  }
  .btn-ghost:hover {
    background: rgba(255, 255, 255, 0.1);
    color: #e4e4e7;
  }

  .use-input-picker {
    position: absolute;
    left: 0;
    right: 0;
    bottom: calc(100% + 0.45rem);
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.4rem;
    padding: 0.45rem;
    border-radius: 0.75rem;
    background: rgba(9, 9, 11, 0.96);
    border: 1px solid rgba(82, 116, 144, 0.35);
    box-shadow: 0 14px 28px rgba(0, 0, 0, 0.32);
  }

  .picker-btn {
    border: 1px solid rgba(255, 255, 255, 0.12);
    background: rgba(255, 255, 255, 0.06);
    color: #d1dae3;
    border-radius: 0.6rem;
    font-family: 'DM Mono', monospace;
    font-size: 0.66rem;
    letter-spacing: 0.08em;
    padding: 0.5rem 0.2rem;
    cursor: pointer;
  }

  .picker-btn:hover {
    background: rgba(82, 116, 144, 0.28);
    border-color: rgba(82, 116, 144, 0.52);
    color: #eef3f8;
  }

  .picker-btn:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }
</style>

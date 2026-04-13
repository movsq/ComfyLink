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
  let viewIndex = $state(-1);
  let viewUrl = $state(null);
  let viewBytes = $state(null);
  let viewLoading = $state(false);
  let viewError = $state('');
  let useInputOpen = $state(false);
  let assigningInput = $state(false);
  let inputAssignError = $state('');

  // Delete state
  let deletingId = $state(null);
  let confirmDeleteId = $state(null);

  $effect(() => {
    loadInitial();
  });

  async function loadInitial() {
    loading = true;
    loadError = '';
    try {
      const data = await listResults(token, { limit: PAGE_LIMIT });
      await loadThumbnails(data);
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
      await loadThumbnails(data);
      items = [...items, ...data];
      hasMore = data.length >= PAGE_LIMIT;
    } catch {
      // silently fail pagination
    } finally {
      loadingMore = false;
    }
  }

  async function loadThumbnails(results) {
    for (const r of results) {
      if (r.hasThumb) {
        try {
          const res = await fetch(`/results/${r.id}/thumb`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (res.ok) {
            const { encryptedThumb, ivThumb } = await res.json();
            const decrypted = await decryptBlob(
              masterKey,
              b64ToBuf(ivThumb),
              b64ToBuf(encryptedThumb),
            );
            const blob = new Blob([decrypted], { type: 'image/webp' });
            r._thumbUrl = URL.createObjectURL(blob);
          } else {
            r._thumbUrl = null;
          }
        } catch {
          r._thumbUrl = null;
        }
      } else {
        r._thumbUrl = null;
      }
    }
  }

  async function viewFull(index) {
    const id = items[index].id;
    viewingId = id;
    viewIndex = index;
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
    viewIndex = -1;
    viewUrl = null;
    viewBytes = null;
    viewError = '';
    useInputOpen = false;
    inputAssignError = '';
    confirmDeleteId = null;
  }

  function prevImage() {
    if (viewIndex > 0) { confirmDeleteId = null; viewFull(viewIndex - 1); }
  }

  function nextImage() {
    if (viewIndex < items.length - 1) { confirmDeleteId = null; viewFull(viewIndex + 1); }
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
        {#each items as item, i (item.id)}
          <button class="thumb-card" onclick={() => viewFull(i)} aria-label="View image">
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
      <div class="view-modal-header">
        <span class="view-modal-label">VAULT</span>
        <button class="close-btn" onclick={closeView} aria-label="Close">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
        </button>
      </div>

      {#if viewLoading}
        <p class="status">DECRYPTING…</p>
      {:else if viewError}
        <p class="error">{viewError}</p>
      {:else if viewUrl}
        <div class="view-image-wrap">
          <img src={viewUrl} alt="Saved result" class="view-result-image" />
          <div class="view-img-overlay">
            <a href={viewUrl} download="result.png" class="view-overlay-download" aria-label="Download image">
              <svg width="15" height="15" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <path d="M10 3v10M6 9l4 4 4-4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
                <path d="M3 15h14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
              </svg>
            </a>
          </div>
        </div>

        <div class="view-action-bar">
          <div class="view-action-left">
            <button class="overlay-pill" onclick={prevImage} disabled={viewIndex <= 0} aria-label="Previous image">
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M8 2L4 6l4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
              Prev
            </button>
            <button class="overlay-pill" onclick={nextImage} disabled={viewIndex >= items.length - 1} aria-label="Next image">
              Next
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M4 2l4 4-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </button>
          </div>

          <div class="view-action-right">
            <div class="view-use-input-wrap">
              <button
                class="overlay-pill overlay-pill-use"
                onclick={() => { useInputOpen = !useInputOpen; inputAssignError = ''; }}
                disabled={!viewBytes || assigningInput}
                aria-haspopup="true"
                aria-expanded={useInputOpen}
              >
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="1" y="5" width="6" height="6" rx="1.5" stroke="currentColor" stroke-width="1.4"/><rect x="9" y="5" width="6" height="6" rx="1.5" stroke="currentColor" stroke-width="1.4"/><path d="M7 8h2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
                {assigningInput ? 'Assigning…' : 'Use as Input'}
                <span class="overlay-chevron" class:open={useInputOpen}>
                  <svg width="9" height="9" viewBox="0 0 10 6" fill="none"><path d="M1 1l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
                </span>
              </button>
              {#if useInputOpen}
                <div class="view-input-picker" role="menu" aria-label="Select input slot">
                  <button class="picker-btn" role="menuitem" onclick={() => assignToInput(1)} disabled={assigningInput}>Input 1</button>
                  <button class="picker-btn" role="menuitem" onclick={() => assignToInput(2)} disabled={assigningInput}>Input 2</button>
                </div>
              {/if}
            </div>

            {#if confirmDeleteId === viewingId}
              <button class="overlay-pill" onclick={() => confirmDeleteId = null}>Cancel</button>
              <button class="overlay-pill overlay-pill-discard" onclick={() => { confirmDeleteId = null; handleDelete(viewingId); }} disabled={deletingId === viewingId}>
                {deletingId === viewingId ? 'Deleting…' : 'Delete'}
              </button>
            {:else}
              <button class="overlay-pill overlay-pill-discard" onclick={() => confirmDeleteId = viewingId} disabled={deletingId === viewingId}>
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
                Delete
              </button>
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
    background: var(--surface-backdrop);
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
    background: var(--surface-raised-glass);
    border: 1px solid var(--border-default);
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
    background: var(--border-default);
    align-self: center; margin: 1rem 0 0.5rem; flex-shrink: 0;
  }
  @media (min-width: 480px) { .handle { display: none; } }

  .header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 0.25rem 0 0;
  }
  .title {
    font-family: 'DM Mono', monospace;
    font-size: 0.65rem; letter-spacing: 0.22em; color: var(--accent-primary);
  }
  .close-btn {
    width: 2rem; height: 2rem; border-radius: 50%;
    border: 1px solid var(--border-subtle);
    background: var(--surface-well-glass);
    color: var(--text-secondary); display: flex; align-items: center; justify-content: center;
    cursor: pointer; transition: transform 0.12s, background 0.2s, color 0.2s;
  }
  .close-btn:hover { background: var(--surface-hover); color: var(--text-primary); }
  .close-btn:active { transform: scale(0.88); filter: brightness(0.85); }

  .status {
    font-family: 'DM Mono', monospace;
    color: var(--accent-primary); font-size: 0.8rem; letter-spacing: 0.08em; margin: 0; text-align: center;
  }
  .error {
    font-family: 'DM Mono', monospace;
    color: var(--state-error); font-size: 0.78rem; margin: 0;
  }
  .empty {
    font-family: 'DM Mono', monospace;
    color: var(--text-muted); font-size: 0.8rem; text-align: center; margin: 2rem 0;
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 0.5rem;
  }

  .thumb-card {
    aspect-ratio: 1;
    border-radius: 0.625rem;
    border: 1px solid var(--border-subtle);
    background: var(--surface-hover);
    overflow: hidden;
    cursor: pointer;
    position: relative;
    transition: transform 0.12s, border-color 0.2s;
    padding: 0;
  }
  .thumb-card:hover {
    border-color: var(--accent-primary-border);
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
    color: var(--text-muted); font-family: 'DM Mono', monospace; font-size: 1.2rem;
  }
  .thumb-meta {
    position: absolute; bottom: 0; left: 0; right: 0;
    padding: 0.2rem 0.35rem;
    background: linear-gradient(transparent, rgba(0, 0, 0, 0.65));
    font-family: 'DM Mono', monospace; font-size: 0.52rem;
    color: var(--text-secondary); text-align: right;
  }

  .load-more {
    align-self: center;
    padding: 0.5rem 1.5rem;
    background: var(--surface-well-glass);
    border: 1px solid var(--border-subtle);
    border-radius: 3rem;
    color: var(--text-secondary);
    font-family: 'DM Mono', monospace; font-size: 0.7rem; letter-spacing: 0.08em;
    cursor: pointer; transition: background 0.2s, color 0.2s;
  }
  .load-more:hover { background: var(--surface-hover); color: var(--text-primary); }
  .load-more:disabled { opacity: 0.5; cursor: not-allowed; }

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
    width: 100%;
    max-width: 520px;
    max-height: calc(100dvh - 2rem);
    background: var(--surface-raised-glass);
    border: 1px solid var(--border-default);
    border-radius: 1.25rem 1.25rem 1rem 1rem;
    padding: 1rem;
    backdrop-filter: blur(24px);
    display: flex;
    flex-direction: column;
    gap: 0.65rem;
    overflow: hidden;
    user-select: none;
    -webkit-user-select: none;
    animation: slide-up 0.26s cubic-bezier(0.16, 1, 0.3, 1);
  }

  @media (min-width: 480px) {
    .view-panel {
      border-radius: 1.25rem;
      padding: 1.25rem;
      gap: 0.75rem;
      max-height: calc(100dvh - 3rem);
    }
  }

  @keyframes slide-up {
    from { transform: translateY(20px); opacity: 0; }
    to   { transform: translateY(0);    opacity: 1; }
  }

  .view-modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-shrink: 0;
  }

  .view-modal-label {
    display: block;
    font-family: 'DM Mono', monospace;
    font-size: 0.65rem;
    letter-spacing: 0.22em;
    color: var(--accent-primary);
    font-weight: 400;
  }

  .view-image-wrap {
    position: relative;
    flex: 1;
    min-height: 0;
    border-radius: 0.875rem;
    overflow: hidden;
    user-select: auto;
    -webkit-user-select: auto;
    -webkit-touch-callout: default;
  }

  .view-result-image {
    width: 100%;
    height: 100%;
    object-fit: contain;
    display: block;
    border-radius: 0.875rem;
    -webkit-touch-callout: default;
    user-select: none;
    -webkit-user-select: none;
    pointer-events: auto;
  }

  .view-img-overlay {
    position: absolute;
    inset: 0;
    pointer-events: none;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    border-radius: 0.875rem;
  }

  .view-overlay-download {
    position: absolute;
    top: 0.6rem;
    right: 0.6rem;
    pointer-events: auto;
    padding: 0.5rem;
    border-radius: 50%;
    background: var(--surface-raised-glass);
    border: 1px solid var(--border-default);
    color: var(--text-primary);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: background 0.15s, transform 0.1s, color 0.15s;
    text-decoration: none;
    -webkit-touch-callout: none;
    user-select: none;
    -webkit-user-select: none;
  }

  .view-overlay-download:hover {
    background: var(--accent-primary-dim);
    color: var(--text-primary);
  }

  .view-overlay-download:active { transform: scale(0.88); }

  .view-action-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.4rem;
    flex-shrink: 0;
    flex-wrap: wrap;
    row-gap: 0.4rem;
  }

  .view-action-left {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-shrink: 0;
  }

  .view-action-right {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-shrink: 1;
  }

  .overlay-pill {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0 0.75rem;
    height: 2rem;
    border-radius: 3rem;
    font-family: 'DM Mono', monospace;
    font-size: 0.68rem;
    letter-spacing: 0.08em;
    font-weight: 500;
    cursor: pointer;
    border: 1px solid var(--border-strong);
    background: var(--surface-raised-glass);
    color: var(--text-primary);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    transition: background 0.15s, border-color 0.15s, transform 0.1s, color 0.15s;
    text-decoration: none;
    white-space: nowrap;
    box-sizing: border-box;
    -webkit-touch-callout: none;
    user-select: none;
    -webkit-user-select: none;
  }

  .overlay-pill:hover {
    background: var(--surface-active);
    border-color: var(--border-strong);
    color: var(--text-primary);
  }

  .overlay-pill:active { transform: scale(0.93); }

  .overlay-pill:disabled {
    opacity: 0.5;
    cursor: not-allowed;
    transform: none;
  }

  .overlay-pill-discard {
    color: var(--state-error);
    border-color: var(--state-error-border);
  }

  .overlay-pill-discard:hover {
    background: var(--state-error-bg);
    border-color: var(--state-error);
    color: var(--state-error);
  }

  .overlay-chevron {
    display: inline-flex;
    align-items: center;
    opacity: 0.7;
    transition: transform 0.18s ease;
  }

  .overlay-chevron.open {
    transform: rotate(180deg);
  }

  .overlay-pill-use {
    position: relative;
  }

  .view-use-input-wrap {
    position: relative;
    flex: 0 0 auto;
    display: flex;
    align-items: center;
  }

  .view-input-picker {
    position: absolute;
    left: 0;
    right: 0;
    bottom: calc(100% + 0.4rem);
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.35rem;
    padding: 0.4rem;
    border-radius: 0.75rem;
    background: var(--surface-overlay-glass);
    border: 1px solid var(--accent-primary-border);
    box-shadow: 0 8px 24px var(--shadow-panel);
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
    z-index: 10;
    min-width: 140px;
  }

  .picker-btn {
    border: 1px solid var(--border-default);
    background: var(--surface-well-glass);
    color: var(--text-primary);
    border-radius: 0.6rem;
    font-family: 'DM Mono', monospace;
    font-size: 0.66rem;
    letter-spacing: 0.08em;
    padding: 0.5rem 0.2rem;
    cursor: pointer;
  }

  .picker-btn:hover {
    background: var(--accent-primary-dim);
    border-color: var(--accent-primary-border);
    color: var(--text-primary);
  }

  .picker-btn:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }
</style>

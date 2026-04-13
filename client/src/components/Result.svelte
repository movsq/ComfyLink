<script>
  import { onDestroy, untrack } from 'svelte';
  import { decodeResultPayload, decryptPayload } from '../lib/crypto.js';
  import { encryptBlob, bufToB64, b64ToBuf } from '../lib/vault-crypto.js';
  import { saveResult } from '../lib/api.js';

  let { result, aesKey, onDone, onClose, token = null, masterKey = null, userType = 'google', onRequestVaultUnlock = null, isGhost = false, stackOffset = 0, onImageReady = null, onUseAsInput = null, initialSaved = false, onSaved = () => {}, thumbnailB64 = null } = $props();

  let imageUrl = $state(null);
  let imageBytes = $state(null); // raw PNG bytes, kept alongside imageUrl for save
  let decryptError = $state('');
  let decrypting = $state(true);
  let saving = $state(false);
  let saved = $state(untrack(() => initialSaved ?? false));
  let saveError = $state('');
  let savePending = $state(false); // waiting for vault unlock/setup before saving
  let useInputOpen = $state(false);
  let assigningInput = $state(false);
  let inputAssignError = $state('');
  let confirmDiscard = $state(false);

  const DECRYPT_TIMEOUT_MS = 15_000;
  let _decryptInFlight = false; // re-entry guard
  let _decryptStarted = false;  // one-shot: effect may only initiate decrypt once

  // Auto-trigger save once masterKey arrives after a pending save request
  $effect(() => {
    if (savePending && masterKey && imageUrl && !decrypting) {
      savePending = false;
      handleSave();
    }
  });

  $effect(() => {
    if (!result || _decryptStarted) return;
    if (!aesKey) {
      _decryptStarted = true;
      decrypting = false;
      decryptError = 'This result cannot be decrypted in this tab/session.';
      return;
    }
    if (!result.payload) {
      _decryptStarted = true;
      decrypting = false;
      decryptError = 'Missing result payload.';
      return;
    }
    _decryptStarted = true;
    decrypt();
  });

  onDestroy(() => {
    if (imageUrl) URL.revokeObjectURL(imageUrl);
  });

  async function decrypt() {
    if (_decryptInFlight) return; // prevent concurrent decrypts
    _decryptInFlight = true;
    decrypting = true;
    decryptError = '';
    try {
      const { iv, ciphertext } = decodeResultPayload(result.payload);

      const decryptPromise = decryptPayload(aesKey, iv, ciphertext);
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Decryption timed out — the result may be corrupted')), DECRYPT_TIMEOUT_MS)
      );
      const plaintext = await Promise.race([decryptPromise, timeoutPromise]);

      imageBytes = plaintext;
      const blob = new Blob([plaintext], { type: 'image/png' });
      if (imageUrl) URL.revokeObjectURL(imageUrl);
      imageUrl = URL.createObjectURL(blob);
      // Notify parent so dismissed cards can show the image
      if (onImageReady) onImageReady(imageUrl);
    } catch (err) {
      decryptError = `Decryption failed: ${err.message}`;
    } finally {
      decrypting = false;
      _decryptInFlight = false;
    }
  }

  function retryDecrypt() {
    decryptError = '';
    decrypt();
  }

  async function assignToInput(slot) {
    if (!onUseAsInput || !imageBytes || assigningInput || (slot !== 1 && slot !== 2)) return;
    assigningInput = true;
    inputAssignError = '';
    try {
      const ok = await onUseAsInput({
        slot,
        bytes: imageBytes,
        mime: 'image/png',
        filename: `result-${result?.jobId ?? 'image'}.png`,
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

  async function handleSave() {
    if (!masterKey) {
      savePending = true;
      if (onRequestVaultUnlock) onRequestVaultUnlock(() => { savePending = false; });
      return;
    }
    savePending = false;
    saving = true;
    saveError = '';
    try {
      // Use cached bytes — avoids fetch(blob:) which is blocked by CSP connect-src
      const fullBuf = imageBytes;

      // Encrypt full image
      const { ciphertext: encFull, iv: ivFull } = await encryptBlob(masterKey, fullBuf);

      // Encrypt thumbnail if one was relayed from the PC
      let encryptedThumb = null;
      let ivThumb = null;
      if (thumbnailB64) {
        try {
          const thumbBytes = b64ToBuf(thumbnailB64);
          const { ciphertext: encT, iv: ivT } = await encryptBlob(masterKey, thumbBytes);
          encryptedThumb = bufToB64(encT);
          ivThumb = bufToB64(ivT);
        } catch {
          // Non-fatal: save without thumbnail if encryption fails
        }
      }

      try {
        await saveResult(token, {
          encryptedFull: bufToB64(encFull),
          ivFull: bufToB64(ivFull),
          fullSizeBytes: fullBuf.length,
          jobId: result?.jobId ?? null,
          encryptedThumb,
          ivThumb,
        });
      } catch (err) {
        // 409 means this job was already saved — treat as success
        if (err.status !== 409) throw err;
      }

      saved = true;
      onSaved(result?.jobId ?? null);
    } catch (err) {
      saveError = err.message || 'Save failed';
    } finally {
      saving = false;
    }
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_noninteractive_element_interactions a11y_interactive_supports_focus -->
<div
  class="backdrop"
  class:ghost={isGhost}
  style={isGhost ? `--stack-offset: ${stackOffset}` : ''}
  role="dialog"
  aria-modal="true"
  tabindex="-1"
  onclick={(e) => { if (!isGhost && e.target === e.currentTarget) onClose(); }}
>
  <div class="modal">
    <div class="modal-header">
      <span class="modal-label">RESULT</span>
      <button class="close-btn" onclick={onClose} aria-label="Close">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
      </button>
    </div>

    {#if decrypting}
      <p class="status">DECRYPTING…</p>
    {:else if decryptError}
      <p class="error">{decryptError}</p>
      <button onclick={retryDecrypt} class="overlay-pill">Retry</button>
    {:else if imageUrl}
      <div class="image-wrap">
        <!-- svelte-ignore a11y_interactive_supports_focus -->
        <img src={imageUrl} alt="Generated result" class="result-image" />

        <!-- Overlay: download button only -->
        <div class="img-overlay">
          <a href={imageUrl} download="result.png" class="overlay-btn overlay-download" aria-label="Download image">
            <svg width="15" height="15" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <path d="M10 3v10M6 9l4 4 4-4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
              <path d="M3 15h14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
            </svg>
          </a>
        </div>
      </div>

      <!-- Action bar below the image -->
      <div class="action-bar">
        {#if userType === 'google'}
          {#if saved}
            <span class="overlay-pill overlay-pill-saved">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 8l3.5 3.5L13 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
              Saved
            </span>
          {:else if saving || savePending}
            <span class="overlay-pill overlay-pill-pending">
              {saving ? 'Saving…' : 'Unlocking…'}
            </span>
          {:else}
            <button class="overlay-pill overlay-pill-save" onclick={handleSave}>
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="2" y="2" width="12" height="12" rx="2" stroke="currentColor" stroke-width="1.5"/><path d="M5 9l2.5 2.5L11 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
              Save
            </button>
            {#if confirmDiscard}
              <button class="overlay-pill" onclick={() => confirmDiscard = false}>Cancel</button>
              <button class="overlay-pill overlay-pill-discard" onclick={onDone}>Discard</button>
            {:else}
              <button class="overlay-pill overlay-pill-discard" onclick={() => confirmDiscard = true}>
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
                Discard
              </button>
            {/if}
          {/if}
        {:else}
          {#if confirmDiscard}
            <button class="overlay-pill" onclick={() => confirmDiscard = false}>Cancel</button>
            <button class="overlay-pill overlay-pill-discard" onclick={onDone}>Discard</button>
          {:else}
            <button class="overlay-pill overlay-pill-discard" onclick={() => confirmDiscard = true}>
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
              Discard
            </button>
          {/if}
        {/if}

        <!-- Use as Input -->
        <div class="use-input-wrap">
          <button
            class="overlay-pill overlay-pill-use"
            onclick={() => { useInputOpen = !useInputOpen; inputAssignError = ''; }}
            disabled={!imageBytes || assigningInput}
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
            <div class="use-input-picker" role="menu" aria-label="Select input slot">
              <button class="picker-btn" role="menuitem" onclick={() => assignToInput(1)} disabled={assigningInput}>Input 1</button>
              <button class="picker-btn" role="menuitem" onclick={() => assignToInput(2)} disabled={assigningInput}>Input 2</button>
            </div>
          {/if}
        </div>
      </div>

      {#if inputAssignError}
        <p class="save-error">{inputAssignError}</p>
      {/if}
      {#if saveError}
        <p class="save-error">{saveError}</p>
      {/if}
    {/if}
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 100;
    background: var(--surface-backdrop);
    backdrop-filter: blur(6px);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1rem;
    animation: fade-in 0.18s ease;
  }

  .backdrop.ghost {
    background: transparent;
    backdrop-filter: none;
    pointer-events: none;
    z-index: calc(98 - var(--stack-offset, 1) * 2);
    animation: none;
  }

  .backdrop.ghost .modal {
    transform:
      translateY(calc(var(--stack-offset, 1) * -10px))
      scale(calc(1 - var(--stack-offset, 1) * 0.028));
    opacity: calc(1 - var(--stack-offset, 1) * 0.18);
    filter: blur(calc(var(--stack-offset, 1) * 0.6px));
    animation: none;
  }

  .backdrop.ghost .modal-header,
  .backdrop.ghost .img-overlay,
  .backdrop.ghost .action-bar {
    opacity: 0;
  }

  @media (min-width: 480px) {
    .backdrop {
      align-items: center;
      padding: 1.5rem;
    }
  }

  @keyframes fade-in {
    from { opacity: 0; }
    to   { opacity: 1; }
  }

  .modal {
    position: relative;
    width: 100%;
    max-width: 520px;
    max-height: calc(100dvh - 2rem);
    background: var(--surface-raised-glass);
    border: 1px solid var(--border-default);
    border-radius: 1.25rem;
    user-select: none;
    -webkit-user-select: none;
    padding: 1rem;
    backdrop-filter: blur(24px);
    display: flex;
    flex-direction: column;
    gap: 0.65rem;
    overflow: hidden;
    animation: slide-up 0.26s cubic-bezier(0.16, 1, 0.3, 1);
  }

  @media (min-width: 480px) {
    .modal {
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

  .modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-shrink: 0;
  }

  .close-btn {
    width: 2rem;
    height: 2rem;
    border-radius: 50%;
    border: 1px solid var(--border-subtle);
    background: var(--surface-well-glass);
    color: var(--text-secondary);
    font-size: 0.75rem;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: transform 0.12s ease, filter 0.12s ease, background 0.2s, color 0.2s;
    line-height: 1;
  }

  .close-btn:hover {
    background: var(--surface-hover);
    color: var(--text-primary);
  }

  .close-btn:active {
    transform: scale(0.88);
    filter: brightness(0.85);
  }

  .modal-label {
    display: block;
    font-family: 'DM Mono', monospace;
    font-size: 0.65rem;
    letter-spacing: 0.22em;
    color: var(--accent-primary);
    font-weight: 400;
  }

  .status {
    font-family: 'DM Mono', monospace;
    color: var(--accent-primary);
    font-size: 0.8rem;
    margin: 0;
    letter-spacing: 0.08em;
  }

  .error {
    font-family: 'DM Mono', monospace;
    color: var(--state-error);
    font-size: 0.78rem;
    margin: 0;
  }

  .result-image {
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

  .image-wrap {
    position: relative;
    flex: 1;
    min-height: 0;
    border-radius: 0.875rem;
    overflow: hidden;
    user-select: auto;
    -webkit-user-select: auto;
    -webkit-touch-callout: default;
  }

  .img-overlay {
    position: absolute;
    inset: 0;
    pointer-events: none;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    border-radius: 0.875rem;
  }

  .overlay-download {
    position: absolute;
    top: 0.6rem;
    right: 0.6rem;
    pointer-events: auto;
  }

  .action-bar {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.4rem;
    flex-shrink: 0;
  }

  .overlay-pill {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0 0.75rem;
    height: 2rem;
    box-sizing: border-box;
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
    -webkit-touch-callout: none;
    user-select: none;
    -webkit-user-select: none;
  }

  .overlay-pill:hover {
    background: var(--surface-active);
    border-color: var(--border-strong);
    color: var(--text-primary);
  }

  .overlay-pill:active {
    transform: scale(0.93);
  }

  .overlay-pill:disabled {
    opacity: 0.5;
    cursor: not-allowed;
    transform: none;
  }

  .overlay-download {
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
    pointer-events: auto;
    text-decoration: none;
    -webkit-touch-callout: none;
    user-select: none;
    -webkit-user-select: none;
  }

  .overlay-download:hover {
    background: var(--accent-primary-dim);
    color: var(--text-primary);
  }

  .overlay-download:active { transform: scale(0.88); }

  .overlay-pill-save {
    background: var(--accent-primary-fill);
    border-color: var(--accent-primary-fill-border);
    color: var(--text-primary);
  }

  .overlay-pill-save:hover {
    background: var(--accent-primary-fill-hover);
    border-color: var(--accent-primary-hover);
    color: var(--text-primary);
  }

  .overlay-pill-saved {
    background: var(--accent-primary-dim);
    border-color: var(--accent-primary-border);
    color: var(--state-success);
    cursor: default;
  }

  .overlay-pill-pending {
    background: var(--accent-primary-glow);
    border-color: var(--accent-primary-dim);
    color: var(--accent-primary);
    opacity: 0.8;
    cursor: default;
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

  .use-input-wrap {
    position: relative;
    flex: 0 0 auto;
    display: flex;
    align-items: center;
  }

  .use-input-picker {
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
    border-radius: 0.5rem;
    font-family: 'DM Mono', monospace;
    font-size: 0.66rem;
    letter-spacing: 0.08em;
    padding: 0.5rem 0.3rem;
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s, color 0.15s;
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

  .save-error {
    font-family: 'DM Mono', monospace;
    color: var(--state-error);
    font-size: 0.7rem;
    margin: 0;
    text-align: center;
  }
</style>

<script>
  import { decodeResultPayload, decryptPayload } from '../lib/crypto.js';
  import { encryptBlob, generateThumbnail, bufToB64 } from '../lib/vault-crypto.js';
  import { saveResult } from '../lib/api.js';

  let { result, aesKey, onDone, onClose, token = null, masterKey = null, userType = 'google', onRequestVaultUnlock = null } = $props();

  let imageUrl = $state(null);
  let decryptError = $state('');
  let decrypting = $state(true);
  let saving = $state(false);
  let saved = $state(false);
  let saveError = $state('');
  let savePending = $state(false); // waiting for vault unlock/setup before saving

  const DECRYPT_TIMEOUT_MS = 15_000;
  let _decryptInFlight = false; // re-entry guard

  // Auto-trigger save once masterKey arrives after a pending save request
  $effect(() => {
    if (savePending && masterKey && imageUrl && !decrypting) {
      savePending = false;
      handleSave();
    }
  });

  $effect(() => {
    if (!result || !aesKey) return;
    decrypt();
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

      const blob = new Blob([plaintext], { type: 'image/png' });
      imageUrl = URL.createObjectURL(blob);
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

  async function handleSave() {
    if (!masterKey) {
      savePending = true;
      if (onRequestVaultUnlock) onRequestVaultUnlock();
      return;
    }
    savePending = false;
    saving = true;
    saveError = '';
    try {
      // Generate thumbnail
      const thumbBuf = await generateThumbnail(imageUrl);

      // Get full image data
      const fullResp = await fetch(imageUrl);
      const fullBuf = new Uint8Array(await fullResp.arrayBuffer());

      // Encrypt both
      const { ciphertext: encThumb, iv: ivThumb } = await encryptBlob(masterKey, thumbBuf);
      const { ciphertext: encFull, iv: ivFull } = await encryptBlob(masterKey, fullBuf);

      await saveResult(token, {
        encryptedThumb: bufToB64(encThumb),
        ivThumb: bufToB64(ivThumb),
        encryptedFull: bufToB64(encFull),
        ivFull: bufToB64(ivFull),
        fullSizeBytes: fullBuf.length,
      });

      saved = true;
    } catch (err) {
      saveError = err.message || 'Save failed';
    } finally {
      saving = false;
    }
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_noninteractive_element_interactions a11y_interactive_supports_focus -->
<div class="backdrop" role="dialog" aria-modal="true" tabindex="-1" onclick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
  <div class="modal">
    <button class="close-btn" onclick={onClose} aria-label="Close">✕</button>

    <span class="modal-label">RESULT</span>

    {#if decrypting}
      <p class="status">DECRYPTING…</p>
    {:else if decryptError}
      <p class="error">{decryptError}</p>
      <button onclick={retryDecrypt} class="btn btn-ghost">Retry</button>
    {:else if imageUrl}
      <img src={imageUrl} alt="Generated result" class="result-image" />
      <div class="actions">
        <a href={imageUrl} download="result.png" class="btn btn-accent">Download</a>
        {#if userType === 'google'}
          <button onclick={handleSave} class="btn btn-ghost" class:save-pending={savePending} disabled={saving || saved || savePending}>
            {#if saved}✓ Saved
            {:else if saving}Saving…
            {:else if savePending}Unlock vault to save
            {:else}Save
            {/if}
          </button>
        {/if}
        <button onclick={onDone} class="btn btn-ghost">New Job</button>
      </div>
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
    background: rgba(0, 0, 0, 0.8);
    backdrop-filter: blur(6px);
    display: flex;
    align-items: flex-end;
    justify-content: center;
    padding: 0.75rem 0.75rem 1.25rem;
    animation: fade-in 0.18s ease;
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
    max-width: 480px;
    max-height: calc(100dvh - 2rem);
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 1.25rem 1.25rem 1rem 1rem;
    padding: 1.25rem;
    backdrop-filter: blur(24px);
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    overflow: hidden;
    animation: slide-up 0.26s cubic-bezier(0.16, 1, 0.3, 1);
  }

  @media (min-width: 480px) {
    .modal {
      border-radius: 1.25rem;
      padding: 1.75rem;
      gap: 1rem;
      max-height: calc(100dvh - 3rem);
    }
  }

  @keyframes slide-up {
    from { transform: translateY(20px); opacity: 0; }
    to   { transform: translateY(0);    opacity: 1; }
  }

  .close-btn {
    position: absolute;
    top: 1rem;
    right: 1rem;
    width: 2rem;
    height: 2rem;
    border-radius: 50%;
    border: 1px solid rgba(255, 255, 255, 0.08);
    background: rgba(255, 255, 255, 0.05);
    color: #a4afbb;
    font-size: 0.75rem;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: transform 0.12s ease, filter 0.12s ease, background 0.2s, color 0.2s;
    line-height: 1;
  }

  .close-btn:hover {
    background: rgba(255, 255, 255, 0.1);
    color: #e4e4e7;
  }

  .close-btn:active {
    transform: scale(0.88);
    filter: brightness(0.85);
  }

  .modal-label {
    display: block;
    font-family: 'DM Mono', monospace;
    font-size: 0.65rem;
    letter-spacing: 0.2em;
    color: #7b9cbf;
    font-weight: 400;
  }

  .status {
    font-family: 'DM Mono', monospace;
    color: #7b9cbf;
    font-size: 0.8rem;
    margin: 0;
    letter-spacing: 0.08em;
  }

  .error {
    font-family: 'DM Mono', monospace;
    color: #c47070;
    font-size: 0.78rem;
    margin: 0;
  }

  .result-image {
    width: 100%;
    flex: 1;
    min-height: 0;
    object-fit: contain;
    border-radius: 0.875rem;
    border: 1px solid rgba(255, 255, 255, 0.07);
    display: block;
  }

  .actions {
    display: flex;
    gap: 0.75rem;
    flex-shrink: 0;
  }

  .btn {
    flex: 1;
    padding: 0.75rem;
    border: none;
    border-radius: 3rem;
    font-family: 'DM Mono', monospace;
    font-size: 0.72rem;
    letter-spacing: 0.1em;
    cursor: pointer;
    text-align: center;
    text-decoration: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    transition: transform 0.12s ease, filter 0.12s ease, background 0.2s, color 0.2s;
  }

  .btn:active {
    transform: scale(0.95);
    filter: brightness(0.85);
  }

  .btn-accent {
    background: #7b9cbf;
    color: #09090b;
  }

  .btn-accent:hover {
    background: #a3bdd4;
  }

  .btn-ghost {
    background: rgba(255, 255, 255, 0.06);
    color: #c2ccd5;
    border: 1px solid rgba(255, 255, 255, 0.08);
  }

  .btn-ghost:hover {
    background: rgba(255, 255, 255, 0.1);
    color: #e4e4e7;
  }

  .btn-ghost.save-pending {
    border-color: rgba(123, 156, 191, 0.3);
    color: #7b9cbf;
    opacity: 0.75;
  }

  .save-error {
    font-family: 'DM Mono', monospace;
    color: #c47070;
    font-size: 0.7rem;
    margin: 0;
    text-align: center;
  }
</style>

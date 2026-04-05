<script>
  import { onDestroy } from 'svelte';
  import { decodeResultPayload, decryptPayload } from '../lib/crypto.js';
  import { encryptBlob, generateThumbnail, bufToB64 } from '../lib/vault-crypto.js';
  import { saveResult } from '../lib/api.js';

  let { result, aesKey, onDone, onClose, token = null, masterKey = null, userType = 'google', onRequestVaultUnlock = null, isGhost = false, stackOffset = 0, onImageReady = null } = $props();

  let imageUrl = $state(null);
  let imageBytes = $state(null); // raw PNG bytes, kept alongside imageUrl for save
  let decryptError = $state('');
  let decrypting = $state(true);
  let saving = $state(false);
  let saved = $state(false);
  let saveError = $state('');
  let savePending = $state(false); // waiting for vault unlock/setup before saving

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

      // Use cached bytes — avoids fetch(blob:) which is blocked by CSP connect-src
      const fullBuf = imageBytes;

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
          {#if saved}
            <!-- Save chosen: Discard is gone, show confirmation -->
            <button class="btn btn-ghost" disabled>✓ Saved</button>
          {:else if saving || savePending}
            <!-- Save in progress / waiting for vault: hide Discard so user can't do both -->
            <button class="btn btn-ghost save-pending" disabled>
              {saving ? 'Saving…' : 'Unlock vault to save…'}
            </button>
          {:else}
            <!-- Idle: show both options — user must pick one -->
            <button onclick={handleSave} class="btn btn-ghost">Save</button>
            <button onclick={onDone} class="btn btn-ghost btn-danger">Discard</button>
          {/if}
        {:else}
          <!-- Code users have no vault: only Discard -->
          <button onclick={onDone} class="btn btn-ghost btn-danger">Discard</button>
        {/if}
        <!-- After a successful save the result is in the vault — close permanently
             (onDone) so it doesn't linger in the 2-min dismissed shelf. -->
        <button onclick={saved ? onDone : onClose} class="btn btn-ghost btn-close-action">Close</button>
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

  /* Ghost ("behind" stack entry): no dimming, no pointer events, peeking visual */
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

  .backdrop.ghost .close-btn,
  .backdrop.ghost .actions,
  .backdrop.ghost .modal-label {
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
    max-width: 480px;
    max-height: calc(100dvh - 2rem);
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 1.25rem 1.25rem 1rem 1rem;
    user-select: none;
    -webkit-user-select: none;
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
    color: #527490;
    font-weight: 400;
  }

  .status {
    font-family: 'DM Mono', monospace;
    color: #527490;
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
    -webkit-touch-callout: default;
    user-select: none;
    -webkit-user-select: none;
  }

  .actions {
    display: flex;
    gap: 0.75rem;
    flex-shrink: 0;
  }

  .btn-close-action {
    margin-left: auto;
    flex: 0 0 auto;
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
    background: #527490;
    color: #09090b;
  }

  .btn-accent:hover {
    background: #7d9db6;
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

  .btn-ghost.btn-danger {
    color: #c47070;
    border-color: rgba(196, 112, 112, 0.4);
  }

  .btn-ghost.btn-danger:hover {
    background: rgba(196, 112, 112, 0.12);
    color: #e07070;
    border-color: rgba(196, 112, 112, 0.65);
  }

  .btn-ghost.save-pending {
    border-color: rgba(82, 116, 144, 0.3);
    color: #527490;
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

<script>
  import { rekeyVault, unlockVault, deleteVault } from '../lib/api.js';
  import {
    exportMasterKey, deriveKeyFromPRF, deriveKeyFromRecovery,
    wrapMasterKey, unwrapMasterKey, bufToB64, b64ToBuf,
    wordsToRecoveryKey, recoveryKeyFromJSON,
  } from '../lib/vault-crypto.js';
  import {
    checkWebAuthnSupport, checkPlatformAuthenticator, registerCredential,
  } from '../lib/webauthn.js';

  let { token, vaultInfo, masterKey = null, userEmail = '', onClose, onUpdated, onRequestUnlock = () => {}, onVaultReset = () => {}, requestFreshGoogleToken = null } = $props();

  let mode = $state('main'); // 'main' | 'recovery' | 'reset_confirm'
  let loading = $state(false);
  let error = $state('');
  let success = $state('');

  // Recovery fields
  let recoveryInput = $state('');
  let recoveryFile = $state(null);

  // Reset
  let resetConfirmText = $state('');

  // Platform authenticator detection
  let platformAvailable = $state(false);
  let webauthnSupported = $state(false);
  let checkingPlatform = $state(true);

  $effect(() => {
    checkPlatform();
  });

  async function checkPlatform() {
    checkingPlatform = true;
    webauthnSupported = checkWebAuthnSupport();
    if (webauthnSupported) {
      platformAvailable = await checkPlatformAuthenticator();
    }
    checkingPlatform = false;
  }

  let canAddBio = $derived(
    !vaultInfo.hasBio && webauthnSupported && platformAvailable && !checkingPlatform,
  );

  async function handleAddBiometric() {
    if (!masterKey) {
      onRequestUnlock();
      return;
    }
    loading = true;
    error = '';
    success = '';
    try {
      const prfSalt = b64ToBuf(vaultInfo.prfSalt);

      // Register WebAuthn credential with existing prfSalt
      const reg = await registerCredential(userEmail, userEmail, prfSalt);

      if (!reg.prfOutput) {
        error = 'Your authenticator does not support PRF. Biometric cannot be added.';
        loading = false;
        return;
      }

      // Derive bio wrapping key and wrap the existing master key
      const bioWrappingKey = await deriveKeyFromPRF(reg.prfOutput, prfSalt);
      const wrappedBio = await wrapMasterKey(masterKey, bioWrappingKey);

      // Step-up auth: get a fresh Google token to confirm identity
      let idToken;
      if (requestFreshGoogleToken) {
        idToken = await requestFreshGoogleToken();
      }

      // Update vault with new bio blob
      await rekeyVault(token, {
        encryptedMasterKeyBio: bufToB64(wrappedBio),
        prfCredentialId: reg.credentialId,
        prfPublicKey: reg.publicKey,
        idToken,
      });

      success = 'Biometric added successfully';
      onUpdated();
    } catch (err) {
      error = err.message || 'Failed to add biometric';
    } finally {
      loading = false;
    }
  }

  async function handleRecoveryUnlock(e) {
    e.preventDefault();
    loading = true;
    error = '';
    try {
      let recoveryBytes;
      if (recoveryFile) {
        const text = await recoveryFile.text();
        const json = JSON.parse(text);
        recoveryBytes = recoveryKeyFromJSON(json);
      } else {
        recoveryBytes = await wordsToRecoveryKey(recoveryInput.trim().split(/\s+/));
      }

      const prfSalt = b64ToBuf(vaultInfo.prfSalt);
      const wrappingKey = await deriveKeyFromRecovery(recoveryBytes, prfSalt);

      const { encryptedMasterKey } = await unlockVault(token, 'recovery');
      const wrappedBuf = b64ToBuf(encryptedMasterKey);
      const mk = await unwrapMasterKey(wrappedBuf, wrappingKey);

      // Recovery unlock succeeded — pass the key up so vault is unlocked
      onClose();
      // Use the onUnlocked callback pattern — but here we go through onRequestUnlock's pending flow
      // For now, just close and let the user know
      success = 'Recovery key verified';
      mode = 'main';
    } catch (err) {
      error = err.message || 'Recovery key invalid';
    } finally {
      loading = false;
    }
  }

  function handleFileInput(e) {
    const file = e.target.files?.[0];
    if (file) recoveryFile = file;
  }

  async function handleResetVault() {
    loading = true;
    error = '';
    try {
      // Step-up auth: get a fresh Google token to confirm identity
      let idToken;
      if (requestFreshGoogleToken) {
        idToken = await requestFreshGoogleToken();
      }
      await deleteVault(token, idToken);
      onVaultReset();
    } catch (err) {
      error = err.message || 'Vault reset failed';
    } finally {
      loading = false;
    }
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_noninteractive_element_interactions -->
<div class="backdrop" role="dialog" aria-modal="true" tabindex="-1" onclick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
  <div class="panel">
    <div class="handle"></div>

    {#if mode === 'main'}
      <div class="header">
        <span class="title">VAULT SETTINGS</span>
        <button class="close-btn" type="button" onclick={onClose} aria-label="Close">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
        </button>
      </div>

      <div class="methods-status">
        <div class="status-block">
          <div class="status-row" class:row-unavailable={!vaultInfo.hasBio && !checkingPlatform && (!webauthnSupported || !platformAvailable)}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/>
            </svg>
            <span class="status-label">Biometric</span>
            {#if vaultInfo.hasBio}
              <span class="status-badge enabled">Active</span>
            {:else if !checkingPlatform && (!webauthnSupported || !platformAvailable)}
              <span class="status-badge disabled">Not available</span>
            {:else}
              <span class="status-badge disabled">Not set up</span>
            {/if}
          </div>
        </div>

        <div class="status-row">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 11-7.78 7.78 5.5 5.5 0 017.78-7.78L15 11h3V8h2V5h2V2h-3z"/>
          </svg>
          <span class="status-label">Password</span>
          {#if vaultInfo.hasPw}
            <span class="status-badge enabled">Active</span>
          {:else}
            <span class="status-badge disabled">Not set up</span>
          {/if}
        </div>

        <div class="status-row">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
          </svg>
          <span class="status-label">Recovery key</span>
          {#if vaultInfo.hasRecovery}
            <span class="status-badge enabled">Active</span>
          {:else}
            <span class="status-badge disabled">Not set up</span>
          {/if}
        </div>
      </div>

      {#if !vaultInfo.hasBio && (checkingPlatform || canAddBio)}
        <div class="add-section">
          {#if checkingPlatform}
            <p class="hint">Checking for biometric support…</p>
          {:else}
            <p class="hint">Add fingerprint or Face ID to unlock your vault faster on this device.</p>
            <button class="btn-primary" disabled={loading || !canAddBio} onclick={handleAddBiometric}>
              {loading ? 'REGISTERING…' : 'ADD BIOMETRIC'}
            </button>
          {/if}
        </div>
      {/if}

      {#if error}
        <p class="error">{error}</p>
      {/if}

      {#if success}
        <p class="success">{success}</p>
      {/if}

      {#if vaultInfo.hasRecovery}
        <button class="settings-link" type="button" onclick={() => { mode = 'recovery'; error = ''; success = ''; }}>
          Unlock with recovery key
        </button>
      {/if}

      <button class="settings-link danger" type="button" onclick={() => { mode = 'reset_confirm'; error = ''; success = ''; resetConfirmText = ''; }}>
        Reset vault
      </button>

    {:else if mode === 'recovery'}
      <div class="header">
        <span class="title">RECOVERY KEY</span>
        <button class="close-btn" type="button" onclick={() => { mode = 'main'; error = ''; recoveryFile = null; }} aria-label="Back">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M8 2L4 6l4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
      </div>

      <form onsubmit={handleRecoveryUnlock} class="pw-form">
        <div class="field">
          <textarea bind:value={recoveryInput} placeholder="Enter your 24 recovery words…" rows="3" disabled={loading || !!recoveryFile}></textarea>
        </div>

        <div class="or-divider">
          <span class="or-line"></span><span class="or-text">OR</span><span class="or-line"></span>
        </div>

        <label class="file-upload" class:has-file={!!recoveryFile}>
          <input type="file" accept=".json" onchange={handleFileInput} hidden disabled={loading} />
          {recoveryFile ? recoveryFile.name : 'Upload recovery file'}
        </label>

        {#if error}
          <p class="error">{error}</p>
        {/if}

        <button type="submit" class="btn-primary" disabled={loading || (!recoveryInput.trim() && !recoveryFile)}>
          {loading ? 'UNLOCKING…' : 'RESTORE ACCESS'}
        </button>
      </form>

    {:else if mode === 'reset_confirm'}
      <div class="header">
        <span class="title">RESET VAULT</span>
        <button class="close-btn" type="button" onclick={() => { mode = 'main'; error = ''; }} aria-label="Back">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M8 2L4 6l4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
      </div>

      <div class="reset-warning">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#c47070" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
        </svg>
        <p>This <strong>permanently deletes</strong> your vault and all saved images. They cannot be recovered.</p>
        <p>You will set up a new vault afterward.</p>
      </div>

      <div class="field">
        <label class="field-label" for="reset-confirm-settings">Type <strong>DELETE</strong> to confirm</label>
        <input id="reset-confirm-settings" type="text" bind:value={resetConfirmText} placeholder="DELETE" autocomplete="off" disabled={loading} />
      </div>

      {#if error}
        <p class="error">{error}</p>
      {/if}

      <button class="btn-danger" disabled={loading || resetConfirmText !== 'DELETE'} onclick={handleResetVault}>
        {loading ? 'DELETING…' : 'DELETE VAULT'}
      </button>
    {/if}
  </div>
</div>

<style>
  .backdrop {
    position: fixed; inset: 0; z-index: 110;
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
    width: 100%; max-width: 400px;
    background: rgba(14, 14, 18, 0.94);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 1.25rem 1.25rem 0 0;
    padding: 0 1.75rem 1.75rem;
    backdrop-filter: blur(24px);
    display: flex; flex-direction: column; gap: 1rem;
    max-height: 90dvh; overflow-y: auto;
    animation: sheet-up 0.28s cubic-bezier(0.16, 1, 0.3, 1) both;
  }
  @media (min-width: 480px) {
    .panel { border-radius: 1.25rem; max-height: 80vh; animation: panel-in 0.24s cubic-bezier(0.16, 1, 0.3, 1) both; }
    @keyframes panel-in {
      from { transform: scale(0.96) translateY(-6px); opacity: 0; }
      to   { transform: scale(1) translateY(0); opacity: 1; }
    }
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
    padding: 0.5rem 0 0;
  }
  .title {
    font-family: 'DM Mono', monospace;
    font-size: 0.75rem; letter-spacing: 0.22em; color: #527490;
  }
  .close-btn {
    width: 2rem; height: 2rem; border-radius: 50%;
    border: 1px solid rgba(255, 255, 255, 0.08);
    background: rgba(255, 255, 255, 0.05);
    color: #a4afbb; display: flex; align-items: center; justify-content: center;
    cursor: pointer; transition: transform 0.12s, background 0.2s, color 0.2s;
  }
  .close-btn:hover { background: rgba(255, 255, 255, 0.1); color: #e4e4e7; }
  .close-btn:active { transform: scale(0.88); }

  .methods-status {
    display: flex; flex-direction: column; gap: 0.5rem;
  }

  .status-row {
    display: flex; align-items: center; gap: 0.75rem;
    padding: 0.75rem 1rem;
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 0.75rem;
  }
  .status-row svg { color: #6c7585; flex-shrink: 0; }
  .row-unavailable { opacity: 0.45; }
  .status-label {
    font-family: 'Syne', sans-serif; font-size: 0.82rem; font-weight: 600;
    color: #a4afbb; flex: 1;
  }
  .status-badge {
    font-family: 'DM Mono', monospace; font-size: 0.68rem;
    letter-spacing: 0.08em; padding: 0.2rem 0.5rem;
    border-radius: 3rem;
  }
  .status-badge.enabled {
    background: rgba(123, 191, 140, 0.12); color: #7bbf8c;
    border: 1px solid rgba(123, 191, 140, 0.2);
  }
  .status-badge.disabled {
    background: rgba(255, 255, 255, 0.04); color: #8b96a6;
    border: 1px solid rgba(255, 255, 255, 0.06);
  }

  .status-block {
    display: flex; flex-direction: column; gap: 0.3rem;
  }

  .add-section {
    display: flex; flex-direction: column; gap: 0.75rem;
  }

  .hint {
    font-family: 'DM Mono', monospace;
    font-size: 0.72rem; color: #6c7585; line-height: 1.5; margin: 0;
  }

  .btn-primary {
    padding: 0.8rem; border: none; border-radius: 3rem;
    background: #527490; color: #09090b;
    font-family: 'DM Mono', monospace;
    font-size: 0.72rem; font-weight: 500; letter-spacing: 0.14em;
    cursor: pointer; transition: transform 0.12s, filter 0.12s, background 0.2s;
  }
  .btn-primary:hover:not(:disabled) { background: #7d9db6; }
  .btn-primary:active:not(:disabled) { transform: scale(0.96); filter: brightness(0.85); }
  .btn-primary:disabled { opacity: 0.4; cursor: not-allowed; }

  .error {
    font-family: 'DM Mono', monospace;
    color: #c47070; font-size: 0.75rem; margin: 0;
  }

  .success {
    font-family: 'DM Mono', monospace;
    color: #7bbf8c; font-size: 0.75rem; margin: 0;
  }

  .settings-link {
    background: none; border: none;
    font-family: 'DM Mono', monospace;
    font-size: 0.75rem; color: #8b96a6; letter-spacing: 0.05em;
    cursor: pointer; padding: 0.25rem 0; text-align: center;
    transition: color 0.2s;
  }
  .settings-link:hover { color: #b4bec9; }
  .settings-link.danger:hover { color: #c47070; }

  .pw-form { display: flex; flex-direction: column; gap: 0.875rem; }

  .field { display: flex; flex-direction: column; }
  .field input, .field textarea {
    padding: 0.72rem 1rem;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 0.75rem;
    background: rgba(255, 255, 255, 0.05);
    color: #e4e4e7; font-family: 'DM Mono', monospace; font-size: 0.85rem;
    outline: none; transition: border-color 0.2s; resize: none;
  }
  .field input::placeholder, .field textarea::placeholder { color: #6c7585; }
  .field input:focus, .field textarea:focus { border-color: rgba(82, 116, 144, 0.4); }

  .field-label {
    font-family: 'DM Mono', monospace;
    font-size: 0.72rem; color: #6c7585; letter-spacing: 0.04em;
    margin-bottom: 0.35rem; display: block;
  }
  .field-label strong { color: #c47070; }

  .or-divider {
    display: flex; align-items: center; gap: 0.75rem;
    margin: 0.25rem 0;
  }
  .or-line { flex: 1; height: 1px; background: rgba(255, 255, 255, 0.08); }
  .or-text {
    font-family: 'DM Mono', monospace;
    font-size: 0.68rem; color: #525a66; letter-spacing: 0.15em;
  }

  .file-upload {
    display: flex; align-items: center; justify-content: center;
    padding: 0.72rem 1rem;
    border: 1px dashed rgba(255, 255, 255, 0.12);
    border-radius: 0.75rem;
    background: rgba(255, 255, 255, 0.02);
    color: #6c7585; font-family: 'DM Mono', monospace; font-size: 0.78rem;
    cursor: pointer; transition: border-color 0.2s, color 0.2s;
  }
  .file-upload:hover { border-color: rgba(82, 116, 144, 0.3); color: #8b96a6; }
  .file-upload.has-file { color: #527490; border-color: rgba(82, 116, 144, 0.3); }

  .reset-warning {
    display: flex; flex-direction: column; align-items: center; gap: 0.5rem;
    text-align: center; padding: 0.75rem;
    border: 1px solid rgba(196, 112, 112, 0.2);
    border-radius: 0.75rem;
    background: rgba(196, 112, 112, 0.06);
  }
  .reset-warning p {
    font-family: 'DM Mono', monospace;
    font-size: 0.72rem; color: #a4afbb; margin: 0; line-height: 1.5;
  }
  .reset-warning strong { color: #e4e4e7; }

  .btn-danger {
    padding: 0.8rem; border: none; border-radius: 3rem;
    background: #943b3b; color: #e4e4e7;
    font-family: 'DM Mono', monospace;
    font-size: 0.72rem; font-weight: 500; letter-spacing: 0.14em;
    cursor: pointer; transition: transform 0.12s, filter 0.12s, background 0.2s;
  }
  .btn-danger:hover:not(:disabled) { background: #b04848; }
  .btn-danger:active:not(:disabled) { transform: scale(0.96); filter: brightness(0.85); }
  .btn-danger:disabled { opacity: 0.4; cursor: not-allowed; }

  @media (hover: none) and (pointer: coarse) {
    .field input, .field textarea { font-size: 16px !important; }
  }
</style>

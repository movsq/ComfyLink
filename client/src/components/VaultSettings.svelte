<script>
  import { rekeyVault, unlockVault, deleteVault } from '../lib/api.js';
  import {
    deriveKeyFromPassword, deriveKeyFromPRF, deriveKeyFromRecovery,
    wrapMasterKey, unwrapMasterKey, bufToB64, b64ToBuf,
    wordsToRecoveryKey, recoveryKeyFromJSON,
  } from '../lib/vault-crypto.js';
  import {
    checkWebAuthnSupport, checkPlatformAuthenticator, registerCredential,
  } from '../lib/webauthn.js';

  let { token, vaultInfo, masterKey = null, userEmail = '', userType = 'google', onClose, onUpdated, onUnlocked = () => {}, onRequestUnlock = () => {}, onVaultReset = () => {}, requestFreshGoogleToken = null } = $props();

  let mode = $state('main'); // 'main' | 'recovery' | 'set_password' | 'change_password' | 'reset_confirm'
  let loading = $state(false);
  let error = $state('');
  let success = $state('');

  // Recovery fields
  let recoveryInput = $state('');
  let recoveryFile = $state(null);

  // Reset
  let resetConfirmText = $state('');

  // Step-up password for email users (rekey / delete vault)
  let stepUpPassword = $state('');

  // Current vault password — used to re-derive a short-lived extractable copy of
  // the master key for re-wrapping. Distinct from stepUpPassword, which is the
  // *account* password the server checks.
  let vaultPassword = $state('');

  // New vault password (change-password / post-recovery set-password)
  let newPassword = $state('');
  let confirmNewPassword = $state('');

  // Short-lived EXTRACTABLE master key held only while a rekey is in progress.
  // The long-lived key the app holds is deliberately non-extractable.
  let rekeyKey = null;

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

  /** Step-up auth for vault mutations: Google users provide a fresh ID token,
   *  email users confirm with their account password. */
  async function buildStepUp() {
    if (userType !== 'google') return { password: stepUpPassword };
    if (requestFreshGoogleToken) return { idToken: await requestFreshGoogleToken() };
    return {};
  }

  /**
   * Re-derive a short-lived EXTRACTABLE copy of the master key from the vault
   * password. The key the app holds for the session is non-extractable on
   * purpose, and AES-KW wrapping requires extractability, so every re-wrap
   * derives its own copy here and lets it go out of scope afterwards.
   */
  async function unwrapExtractableWithVaultPassword(password) {
    if (!vaultInfo.hasPw) throw new Error('Vault has no password configured');
    if (typeof vaultInfo.pbkdf2Salt !== 'string') throw new Error('Vault is missing its password salt');
    const pbkdf2Salt = b64ToBuf(vaultInfo.pbkdf2Salt);
    const wrappingKey = await deriveKeyFromPassword(password, pbkdf2Salt);
    const { encryptedMasterKey } = await unlockVault(token, 'pw');
    return unwrapMasterKey(b64ToBuf(encryptedMasterKey), wrappingKey, true);
  }

  async function handleAddBiometric() {
    if (!masterKey) {
      onRequestUnlock();
      return;
    }
    loading = true;
    error = '';
    success = '';
    try {
      if (typeof vaultInfo.prfSalt !== 'string') throw new Error('Vault is missing its PRF salt');
      const prfSalt = b64ToBuf(vaultInfo.prfSalt);

      // Re-wrapping needs raw key bytes, which the session key deliberately
      // cannot give us — derive a throwaway extractable copy first.
      const mk = await unwrapExtractableWithVaultPassword(vaultPassword);

      // Register WebAuthn credential with existing prfSalt
      const reg = await registerCredential(userEmail, userEmail, prfSalt);

      if (!reg.prfOutput) {
        error = 'Your authenticator does not support PRF. Biometric cannot be added.';
        loading = false;
        return;
      }

      // Derive bio wrapping key and wrap the existing master key
      const bioWrappingKey = await deriveKeyFromPRF(reg.prfOutput, prfSalt);
      const wrappedBio = await wrapMasterKey(mk, bioWrappingKey);

      const stepUp = await buildStepUp();

      // Update vault with new bio blob
      await rekeyVault(token, {
        encryptedMasterKeyBio: bufToB64(wrappedBio),
        prfCredentialId: reg.credentialId,
        prfPublicKey: reg.publicKey,
        ...stepUp,
      });

      success = 'Biometric added successfully';
      stepUpPassword = '';
      vaultPassword = '';
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

      if (typeof vaultInfo.prfSalt !== 'string') throw new Error('Vault is missing its PRF salt');
      const prfSalt = b64ToBuf(vaultInfo.prfSalt);
      const wrappingKey = await deriveKeyFromRecovery(recoveryBytes, prfSalt);

      const { encryptedMasterKey } = await unlockVault(token, 'recovery');
      const wrappedBuf = b64ToBuf(encryptedMasterKey);

      // Two copies: the non-extractable one the app keeps for the session, and a
      // throwaway extractable one so the user can immediately set a new password.
      const mk = await unwrapMasterKey(wrappedBuf, wrappingKey);
      rekeyKey = await unwrapMasterKey(wrappedBuf, wrappingKey, true);

      // Recovery unlock succeeded — hand the key up so the vault is actually open…
      onUnlocked(mk);

      // …then keep this panel open on a set-a-new-password step, otherwise the
      // user is back in the same dead end on their next visit.
      recoveryInput = '';
      recoveryFile = null;
      newPassword = '';
      confirmNewPassword = '';
      error = '';
      success = 'Vault unlocked with recovery key — set a new password now';
      mode = 'set_password';
    } catch (err) {
      error = err.message || 'Recovery key invalid';
    } finally {
      loading = false;
    }
  }

  /** Wrap the master key under a freshly derived password key and store it. */
  async function handleSetNewPassword(e) {
    e.preventDefault();
    if (newPassword.length < 12) { error = 'Password must be at least 12 characters'; return; }
    if (newPassword !== confirmNewPassword) { error = 'Passwords do not match'; return; }

    loading = true;
    error = '';
    try {
      // In 'change_password' mode the current vault password is the only way to
      // get raw key bytes; in 'set_password' the recovery unwrap already gave us one.
      const mk = rekeyKey ?? await unwrapExtractableWithVaultPassword(vaultPassword);

      const pbkdf2Salt = crypto.getRandomValues(new Uint8Array(32));
      const pwWrappingKey = await deriveKeyFromPassword(newPassword, pbkdf2Salt);
      const wrappedPw = await wrapMasterKey(mk, pwWrappingKey);

      const stepUp = await buildStepUp();

      await rekeyVault(token, {
        encryptedMasterKeyPw: bufToB64(wrappedPw),
        pbkdf2Salt: bufToB64(pbkdf2Salt),
        ...stepUp,
      });

      rekeyKey = null;
      newPassword = '';
      confirmNewPassword = '';
      vaultPassword = '';
      stepUpPassword = '';
      success = 'Vault password updated';
      onUpdated();
      onClose();
    } catch (err) {
      error = err.message || 'Could not set the new password';
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
      // Step-up auth: Google users provide a fresh ID token; email users confirm with password.
      let stepUp = {};
      if (userType !== 'google') {
        stepUp = { password: stepUpPassword };
      } else if (requestFreshGoogleToken) {
        stepUp = { idToken: await requestFreshGoogleToken() };
      }
      await deleteVault(token, stepUp);
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
            <div class="field">
              <label class="field-label" for="bio-vault-pw">Vault password</label>
              <input id="bio-vault-pw" type="password" bind:value={vaultPassword} placeholder="Your vault password" autocomplete="current-password" disabled={loading} />
            </div>
            {#if userType !== 'google'}
              <div class="field">
                <label class="field-label" for="bio-step-up-pw">Confirm account password to continue</label>
                <input id="bio-step-up-pw" type="password" bind:value={stepUpPassword} placeholder="Your password" autocomplete="current-password" disabled={loading} />
              </div>
            {/if}
            <button class="btn-primary" disabled={loading || !canAddBio || !vaultPassword || (userType !== 'google' && !stepUpPassword)} onclick={handleAddBiometric}>
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

      {#if vaultInfo.hasPw}
        <button class="settings-link" type="button" onclick={() => { mode = 'change_password'; error = ''; success = ''; rekeyKey = null; vaultPassword = ''; newPassword = ''; confirmNewPassword = ''; stepUpPassword = ''; }}>
          Change vault password
        </button>
      {/if}

      {#if vaultInfo.hasRecovery}
        <button class="settings-link" type="button" onclick={() => { mode = 'recovery'; error = ''; success = ''; }}>
          Unlock with recovery key
        </button>
      {/if}

      <button class="settings-link danger" type="button" onclick={() => { mode = 'reset_confirm'; error = ''; success = ''; resetConfirmText = ''; stepUpPassword = ''; }}>
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

    {:else if mode === 'set_password' || mode === 'change_password'}
      <div class="header">
        <span class="title">{mode === 'set_password' ? 'SET NEW PASSWORD' : 'CHANGE VAULT PASSWORD'}</span>
        <button class="close-btn" type="button" onclick={() => { mode = 'main'; error = ''; rekeyKey = null; vaultPassword = ''; newPassword = ''; confirmNewPassword = ''; }} aria-label="Back">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M8 2L4 6l4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
      </div>

      {#if success}
        <p class="success">{success}</p>
      {/if}

      <form onsubmit={handleSetNewPassword} class="pw-form">
        {#if mode === 'change_password'}
          <div class="field">
            <label class="field-label" for="vault-pw-current">Current vault password</label>
            <input id="vault-pw-current" type="password" bind:value={vaultPassword} placeholder="Current vault password" autocomplete="current-password" disabled={loading} />
          </div>
        {/if}

        <div class="field">
          <label class="field-label" for="vault-pw-new">New vault password (min 12 characters)</label>
          <input id="vault-pw-new" type="password" bind:value={newPassword} placeholder="New vault password" autocomplete="new-password" disabled={loading} />
        </div>

        <div class="field">
          <label class="field-label" for="vault-pw-confirm">Confirm new password</label>
          <input id="vault-pw-confirm" type="password" bind:value={confirmNewPassword} placeholder="Repeat new password" autocomplete="new-password" disabled={loading} />
        </div>

        {#if userType !== 'google'}
          <div class="field">
            <label class="field-label" for="vault-pw-step-up">Confirm account password to continue</label>
            <input id="vault-pw-step-up" type="password" bind:value={stepUpPassword} placeholder="Your password" autocomplete="current-password" disabled={loading} />
          </div>
        {/if}

        {#if error}
          <p class="error">{error}</p>
        {/if}

        <button type="submit" class="btn-primary" disabled={loading || !newPassword || !confirmNewPassword || (mode === 'change_password' && !vaultPassword) || (userType !== 'google' && !stepUpPassword)}>
          {loading ? 'SAVING…' : 'SAVE PASSWORD'}
        </button>
      </form>

    {:else if mode === 'reset_confirm'}
      <div class="header">
        <span class="title">RESET VAULT</span>
        <button class="close-btn" type="button" onclick={() => { mode = 'main'; error = ''; stepUpPassword = ''; }} aria-label="Back">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M8 2L4 6l4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
      </div>

      <div class="reset-warning">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--state-error)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
        </svg>
        <p>This <strong>permanently deletes</strong> your vault and all saved images. They cannot be recovered.</p>
        <p>You will set up a new vault afterward.</p>
      </div>

      <div class="field">
        <label class="field-label" for="reset-confirm-settings">Type <strong>DELETE</strong> to confirm</label>
        <input id="reset-confirm-settings" type="text" bind:value={resetConfirmText} placeholder="DELETE" autocomplete="off" disabled={loading} />
      </div>

      {#if userType !== 'google'}
        <div class="field">
          <label class="field-label" for="reset-step-up-pw">Confirm password to delete vault</label>
          <input id="reset-step-up-pw" type="password" bind:value={stepUpPassword} placeholder="Your password" autocomplete="current-password" disabled={loading} />
        </div>
      {/if}

      {#if error}
        <p class="error">{error}</p>
      {/if}

      <button class="btn-danger" disabled={loading || resetConfirmText !== 'DELETE' || (userType !== 'google' && !stepUpPassword)} onclick={handleResetVault}>
        {loading ? 'DELETING…' : 'DELETE VAULT'}
      </button>
    {/if}
  </div>
</div>

<style>
  .backdrop {
    position: fixed; inset: 0; z-index: 110;
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
    width: 100%; max-width: 400px;
    background: var(--surface-raised-glass);
    border: 1px solid var(--border-default);
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
    background: var(--border-default);
    align-self: center; margin: 1rem 0 0.5rem; flex-shrink: 0;
  }
  @media (min-width: 480px) { .handle { display: none; } }

  .header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 0.5rem 0 0;
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

  .methods-status {
    display: flex; flex-direction: column; gap: 0.5rem;
  }

  .status-row {
    display: flex; align-items: center; gap: 0.75rem;
    padding: 0.75rem 1rem;
    background: var(--surface-hover);
    border: 1px solid var(--border-subtle);
    border-radius: 0.75rem;
  }
  .status-row svg { color: var(--text-muted); flex-shrink: 0; }
  .row-unavailable { opacity: 0.45; }
  .status-label {
    font-family: 'Syne', sans-serif; font-size: 0.82rem; font-weight: 600;
    color: var(--text-secondary); flex: 1;
  }
  .status-badge {
    font-family: 'DM Mono', monospace; font-size: 0.68rem;
    letter-spacing: 0.08em; padding: 0.2rem 0.5rem;
    border-radius: 3rem;
  }
  .status-badge.enabled {
    background: var(--state-success-bg); color: var(--state-success);
    border: 1px solid var(--state-success-bg);
  }
  .status-badge.disabled {
    background: var(--surface-hover); color: var(--text-secondary);
    border: 1px solid var(--border-subtle);
  }

  .status-block {
    display: flex; flex-direction: column; gap: 0.3rem;
  }

  .add-section {
    display: flex; flex-direction: column; gap: 0.75rem;
  }

  .hint {
    font-family: 'DM Mono', monospace;
    font-size: 0.75rem; color: var(--text-secondary); line-height: 1.6; margin: 0;
  }

  .btn-primary {
    padding: 0.8rem; border: none; border-radius: 3rem;
    background: var(--accent-primary); color: var(--text-on-accent);
    font-family: 'DM Mono', monospace;
    font-size: 0.72rem; font-weight: 500; letter-spacing: 0.14em;
    cursor: pointer; transition: transform 0.12s, filter 0.12s, background 0.2s;
  }
  .btn-primary:hover:not(:disabled) { background: var(--accent-primary-hover); }
  .btn-primary:active:not(:disabled) { transform: scale(0.96); filter: brightness(0.85); }
  .btn-primary:disabled { opacity: 0.4; cursor: not-allowed; }

  .error {
    font-family: 'DM Mono', monospace;
    color: var(--state-error); font-size: 0.75rem; margin: 0;
  }

  .success {
    font-family: 'DM Mono', monospace;
    color: var(--state-success); font-size: 0.75rem; margin: 0;
  }

  .settings-link {
    background: none; border: none;
    font-family: 'DM Mono', monospace;
    font-size: 0.75rem; color: var(--text-secondary); letter-spacing: 0.05em;
    cursor: pointer; padding: 0.25rem 0; text-align: center;
    transition: color 0.2s;
  }
  .settings-link:hover { color: var(--text-primary); }
  .settings-link.danger:hover { color: var(--state-error); }

  .pw-form { display: flex; flex-direction: column; gap: 0.875rem; }

  .field { display: flex; flex-direction: column; }
  .field input, .field textarea {
    padding: 0.72rem 1rem;
    border: 1px solid var(--border-subtle);
    border-radius: 0.75rem;
    background: var(--surface-well-glass);
    color: var(--text-primary); font-family: 'DM Mono', monospace; font-size: 0.85rem;
    outline: none; transition: border-color 0.2s; resize: none;
  }
  .field input::placeholder, .field textarea::placeholder { color: var(--text-muted); }
  .field input:focus, .field textarea:focus { border-color: var(--border-focus); }

  .field-label {
    font-family: 'DM Mono', monospace;
    font-size: 0.6rem; color: var(--text-secondary); letter-spacing: 0.18em;
    margin-bottom: 0.35rem; display: block;
  }
  .field-label strong { color: var(--state-error); }

  .or-divider {
    display: flex; align-items: center; gap: 0.75rem;
    margin: 0.25rem 0;
  }
  .or-line { flex: 1; height: 1px; background: var(--border-subtle); }
  .or-text {
    font-family: 'DM Mono', monospace;
    font-size: 0.65rem; color: var(--text-muted); letter-spacing: 0.15em;
  }

  .file-upload {
    display: flex; align-items: center; justify-content: center;
    padding: 0.72rem 1rem;
    border: 1px dashed var(--border-default);
    border-radius: 0.75rem;
    background: var(--surface-hover);
    color: var(--text-muted); font-family: 'DM Mono', monospace; font-size: 0.78rem;
    cursor: pointer; transition: border-color 0.2s, color 0.2s;
  }
  .file-upload:hover { border-color: var(--accent-primary-border); color: var(--text-secondary); }
  .file-upload.has-file { color: var(--accent-primary); border-color: var(--accent-primary-border); }

  .reset-warning {
    display: flex; flex-direction: column; align-items: center; gap: 0.5rem;
    text-align: center; padding: 0.75rem;
    border: 1px solid var(--state-error-border);
    border-radius: 0.75rem;
    background: var(--state-error-bg);
  }
  .reset-warning p {
    font-family: 'DM Mono', monospace;
    font-size: 0.72rem; color: var(--text-secondary); margin: 0; line-height: 1.5;
  }
  .reset-warning strong { color: var(--text-primary); }

  .btn-danger {
    padding: 0.8rem; border: none; border-radius: 3rem;
    background: var(--state-error-strong); color: var(--text-primary);
    font-family: 'DM Mono', monospace;
    font-size: 0.72rem; font-weight: 500; letter-spacing: 0.14em;
    cursor: pointer; transition: transform 0.12s, filter 0.12s, background 0.2s;
  }
  .btn-danger:hover:not(:disabled) { background: var(--state-error-strong-hover); }
  .btn-danger:active:not(:disabled) { transform: scale(0.96); filter: brightness(0.85); }
  .btn-danger:disabled { opacity: 0.4; cursor: not-allowed; }

  @media (hover: none) and (pointer: coarse) {
    .field input, .field textarea { font-size: 16px !important; }
  }
</style>

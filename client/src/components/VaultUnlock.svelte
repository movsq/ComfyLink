<script>
  import { unlockVault } from '../lib/api.js';
  import {
    deriveKeyFromPassword, deriveKeyFromPRF,
    unwrapMasterKey, b64ToBuf,
  } from '../lib/vault-crypto.js';
  import { authenticateWithPRF, checkPlatformAuthenticator } from '../lib/webauthn.js';
  import { onMount } from 'svelte';

  let { token, vaultInfo, onUnlocked, onCancel, onOpenSettings = () => {} } = $props();

  let mode = $state('choose'); // 'choose' | 'password'
  let loading = $state(false);
  let error = $state('');
  let bioAvailable = $state(false);

  onMount(async () => {
    bioAvailable = await checkPlatformAuthenticator();
  });

  // Password field
  let password = $state('');

  async function handleBiometric() {
    loading = true;
    error = '';
    try {
      const prfSalt = b64ToBuf(vaultInfo.prfSalt);
      const prfOutput = await authenticateWithPRF(vaultInfo.prfCredentialId, prfSalt);
      const wrappingKey = await deriveKeyFromPRF(prfOutput, prfSalt);

      const { encryptedMasterKey } = await unlockVault(token, 'bio');
      const wrappedBuf = b64ToBuf(encryptedMasterKey);
      const masterKey = await unwrapMasterKey(wrappedBuf, wrappingKey);

      onUnlocked(masterKey);
    } catch (err) {
      error = err.message || 'Biometric unlock failed';
    } finally {
      loading = false;
    }
  }

  async function handlePasswordUnlock(e) {
    e.preventDefault();
    if (!password) return;
    loading = true;
    error = '';
    try {
      const pbkdf2Salt = b64ToBuf(vaultInfo.pbkdf2Salt);
      const wrappingKey = await deriveKeyFromPassword(password, pbkdf2Salt);

      const { encryptedMasterKey } = await unlockVault(token, 'pw');
      const wrappedBuf = b64ToBuf(encryptedMasterKey);
      const masterKey = await unwrapMasterKey(wrappedBuf, wrappingKey);

      onUnlocked(masterKey);
    } catch (err) {
      error = 'Wrong password or unlock failed';
    } finally {
      loading = false;
    }
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_noninteractive_element_interactions -->
<div class="backdrop" role="dialog" aria-modal="true" tabindex="-1" onclick={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
  <div class="panel">
    <div class="handle"></div>

    {#if mode === 'choose'}
      <div class="header">
        <span class="title">UNLOCK VAULT</span>
        <button class="close-btn" type="button" onclick={onCancel} aria-label="Close">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
        </button>
      </div>

      <div class="methods">
        {#if vaultInfo.hasBio}
          <button class="method-btn" class:unavailable={!bioAvailable} disabled={loading || !bioAvailable} onclick={handleBiometric}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/>
            </svg>
            <span class="method-label">Biometric</span>
            <span class="method-sub">{bioAvailable ? 'Fingerprint · Face ID' : 'Not available on this device'}</span>
          </button>
        {/if}

        {#if vaultInfo.hasPw}
          <button class="method-btn" disabled={loading} onclick={() => { mode = 'password'; error = ''; }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 11-7.78 7.78 5.5 5.5 0 017.78-7.78L15 11h3V8h2V5h2V2h-3z"/>
            </svg>
            <span class="method-label">Password</span>
            <span class="method-sub">Enter vault password</span>
          </button>
        {/if}
      </div>

      {#if error}
        <p class="error">{error}</p>
      {/if}

      <button class="recovery-link" type="button" onclick={onOpenSettings}>
        Manage unlock methods
      </button>

    {:else if mode === 'password'}
      <div class="header">
        <span class="title">VAULT PASSWORD</span>
        <button class="close-btn" type="button" onclick={() => { mode = 'choose'; error = ''; }} aria-label="Back">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M8 2L4 6l4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
      </div>

      <form onsubmit={handlePasswordUnlock} class="pw-form">
        <div class="field">
          <input type="password" bind:value={password} placeholder="Enter vault password" autocomplete="current-password" disabled={loading} />
        </div>

        {#if error}
          <p class="error">{error}</p>
        {/if}

        <button type="submit" class="btn-primary" disabled={loading || !password}>
          {loading ? 'UNLOCKING…' : 'UNLOCK'}
        </button>
      </form>
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

  .methods { display: flex; flex-direction: column; gap: 0.75rem; }

  .method-btn {
    display: flex; align-items: center; gap: 0.875rem;
    padding: 1rem 1.125rem;
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 0.875rem;
    color: #e4e4e7; cursor: pointer;
    transition: transform 0.12s, background 0.2s, border-color 0.2s;
  }
  .method-btn:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.08);
    border-color: rgba(82, 116, 144, 0.3);
  }
  .method-btn:active:not(:disabled) { transform: scale(0.97); }
  .method-btn:disabled { opacity: 0.35; cursor: not-allowed; }
  .method-btn.unavailable { opacity: 0.45; cursor: not-allowed; }
  .method-btn.unavailable .method-sub { color: #8b96a6; }
  .method-btn svg { color: #527490; flex-shrink: 0; }
  .method-label { font-family: 'Syne', sans-serif; font-size: 0.9rem; font-weight: 600; }
  .method-sub {
    font-family: 'DM Mono', monospace; font-size: 0.72rem;
    color: #6c7585; letter-spacing: 0.04em; margin-left: auto;
  }

  .pw-form { display: flex; flex-direction: column; gap: 0.875rem; }

  .field { display: flex; flex-direction: column; }
  .field input {
    padding: 0.72rem 1rem;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 0.75rem;
    background: rgba(255, 255, 255, 0.05);
    color: #e4e4e7; font-family: 'DM Mono', monospace; font-size: 0.85rem;
    outline: none; transition: border-color 0.2s;
  }
  .field input::placeholder { color: #6c7585; }
  .field input:focus { border-color: rgba(82, 116, 144, 0.4); }

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

  .recovery-link {
    background: none; border: none;
    font-family: 'DM Mono', monospace;
    font-size: 0.75rem; color: #8b96a6; letter-spacing: 0.05em;
    cursor: pointer; padding: 0.25rem 0; text-align: center;
    transition: color 0.2s;
  }
  .recovery-link:hover { color: #b4bec9; }

  .error {
    font-family: 'DM Mono', monospace;
    color: #c47070; font-size: 0.75rem; margin: 0;
  }

  @media (hover: none) and (pointer: coarse) {
    .field input { font-size: 16px !important; }
  }
</style>

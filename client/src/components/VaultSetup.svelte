<script>
  import { setupVault } from '../lib/api.js';
  import {
    generateMasterKey, exportMasterKey,
    deriveKeyFromPassword, deriveKeyFromPRF, deriveKeyFromRecovery,
    wrapMasterKey, generateRecoveryKey, recoveryKeyToWords, recoveryKeyToJSON,
    bufToB64,
  } from '../lib/vault-crypto.js';
  import {
    checkWebAuthnSupport, checkPlatformAuthenticator,
    registerCredential,
  } from '../lib/webauthn.js';

  let { token, userEmail = '', onComplete, onSkip } = $props();

  let step = $state('choose');   // 'choose' | 'password' | 'biometric_password' | 'recovery'
  let loading = $state(false);
  let error = $state('');

  // Platform authenticator detection
  let platformAvailable = $state(false);
  let webauthnSupported = $state(false);
  let checkingPlatform = $state(true);

  // Password fields
  let password = $state('');
  let confirmPassword = $state('');

  // Recovery key state
  let recoveryWords = $state([]);
  let recoveryBytes = $state(null);
  let saved = $state(false);
  let copyFeedback = $state(false);

  // The master key to pass to parent on completion
  let masterKey = $state(null);

  // Intermediate state held between bio registration and password fallback entry
  let _pendingBio = $state(null); // { wrappedBio, prfSalt, prfCredentialId, prfPublicKey, mk, rb }

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

  async function handleBiometric() {
    loading = true;
    error = '';
    try {
      // Generate master key and recovery key
      const mk = await generateMasterKey();
      await exportMasterKey(mk); // ensure exportable
      const rb = generateRecoveryKey();

      // PRF salt for this user
      const prfSalt = crypto.getRandomValues(new Uint8Array(32));

      // Register WebAuthn credential with PRF
      const reg = await registerCredential(userEmail, userEmail, prfSalt);

      if (!reg.prfOutput) {
        error = 'Your authenticator does not support PRF. Please use a password instead.';
        loading = false;
        return;
      }

      // Wrap master key with bio key
      const bioWrappingKey = await deriveKeyFromPRF(reg.prfOutput, prfSalt);
      const wrappedBio = await wrapMasterKey(mk, bioWrappingKey);

      // Stash intermediary state — password fallback collected next
      _pendingBio = {
        wrappedBio,
        prfSalt,
        prfCredentialId: reg.credentialId,
        prfPublicKey: reg.publicKey,
        mk,
        rb,
      };
      password = '';
      confirmPassword = '';
      step = 'biometric_password';
    } catch (err) {
      error = err.message || 'Biometric setup failed';
    } finally {
      loading = false;
    }
  }

  async function handleBiometricWithPassword(e) {
    e.preventDefault();
    if (password.length < 12) { error = 'Password must be at least 12 characters'; return; }
    if (password !== confirmPassword) { error = 'Passwords do not match'; return; }
    if (!_pendingBio) { error = 'Biometric data lost — please start again'; step = 'choose'; return; }

    loading = true;
    error = '';
    try {
      const { wrappedBio, prfSalt, prfCredentialId, prfPublicKey, mk, rb } = _pendingBio;

      // Derive password wrapping key
      const pbkdf2Salt = crypto.getRandomValues(new Uint8Array(32));
      const pwWrappingKey = await deriveKeyFromPassword(password, pbkdf2Salt);
      const wrappedPw = await wrapMasterKey(mk, pwWrappingKey);

      // Derive recovery wrapping key and wrap
      const recoveryWrappingKey = await deriveKeyFromRecovery(rb, prfSalt);
      const wrappedRecovery = await wrapMasterKey(mk, recoveryWrappingKey);

      // Store all three blobs on server
      await setupVault(token, {
        encryptedMasterKeyBio: bufToB64(wrappedBio),
        encryptedMasterKeyPw: bufToB64(wrappedPw),
        encryptedMasterKeyRecovery: bufToB64(wrappedRecovery),
        prfSalt: bufToB64(prfSalt),
        pbkdf2Salt: bufToB64(pbkdf2Salt),
        prfCredentialId,
        prfPublicKey,
      });

      // Commit to parent state and proceed to recovery step
      masterKey = mk;
      recoveryBytes = rb;
      recoveryWords = await recoveryKeyToWords(rb);
      _pendingBio = null;
      step = 'recovery';
    } catch (err) {
      error = err.message || 'Setup failed';
    } finally {
      loading = false;
    }
  }

  async function handlePasswordSetup(e) {
    e.preventDefault();
    if (password.length < 12) {
      error = 'Password must be at least 12 characters';
      return;
    }
    if (password !== confirmPassword) {
      error = 'Passwords do not match';
      return;
    }

    loading = true;
    error = '';
    try {
      masterKey = await generateMasterKey();
      const masterKeyRaw = await exportMasterKey(masterKey);
      recoveryBytes = generateRecoveryKey();

      const pbkdf2Salt = crypto.getRandomValues(new Uint8Array(32));
      const prfSalt = crypto.getRandomValues(new Uint8Array(32)); // used as common salt for recovery

      const pwWrappingKey = await deriveKeyFromPassword(password, pbkdf2Salt);
      const recoveryWrappingKey = await deriveKeyFromRecovery(recoveryBytes, prfSalt);

      const wrappedPw = await wrapMasterKey(masterKey, pwWrappingKey);
      const wrappedRecovery = await wrapMasterKey(masterKey, recoveryWrappingKey);

      await setupVault(token, {
        encryptedMasterKeyPw: bufToB64(wrappedPw),
        encryptedMasterKeyRecovery: bufToB64(wrappedRecovery),
        pbkdf2Salt: bufToB64(pbkdf2Salt),
        prfSalt: bufToB64(prfSalt),
      });

      recoveryWords = await recoveryKeyToWords(recoveryBytes);
      step = 'recovery';
    } catch (err) {
      error = err.message || 'Password setup failed';
      masterKey = null;
      recoveryBytes = null;
    } finally {
      loading = false;
    }
  }

  async function handleCopyWords() {
    await navigator.clipboard.writeText(recoveryWords.join(' '));
    copyFeedback = true;
    setTimeout(() => copyFeedback = false, 2000);
  }

  function handleDownloadJSON() {
    const data = recoveryKeyToJSON(recoveryBytes, userEmail);
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'comfylink-recovery.json';
    a.click();
    URL.revokeObjectURL(url);
  }

  function handleContinue() {
    // Clear sensitive data
    password = '';
    confirmPassword = '';
    recoveryBytes = null;
    onComplete(masterKey);
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_noninteractive_element_interactions -->
<div class="backdrop" role="dialog" aria-modal="true" tabindex="-1" onclick={(e) => { if (e.target === e.currentTarget && step === 'choose') onSkip(); }}>
  <div class="panel">
    <div class="handle"></div>

    {#if step === 'choose'}
      <div class="header">
        <span class="title">SECURE YOUR VAULT</span>
        <button class="close-btn" type="button" onclick={onSkip} aria-label="Skip">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
        </button>
      </div>

      <p class="desc">Choose how to protect your saved results. Your encryption key never leaves this device.</p>

      <div class="methods">
        <button
          class="method-btn"
          disabled={checkingPlatform || !platformAvailable || loading}
          onclick={handleBiometric}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/>
          </svg>
          <span class="method-label">Biometric</span>
          <span class="method-sub">
            {#if checkingPlatform}Checking…
            {:else if !webauthnSupported}Not supported
            {:else if !platformAvailable}No authenticator
            {:else}Fingerprint or Face ID
            {/if}
          </span>
        </button>

        <button
          class="method-btn"
          disabled={loading}
          onclick={() => { step = 'password'; error = ''; }}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 11-7.78 7.78 5.5 5.5 0 017.78-7.78L15 11h3V8h2V5h2V2h-3z"/>
          </svg>
          <span class="method-label">Password</span>
          <span class="method-sub">Always available</span>
        </button>
      </div>

      {#if error}
        <p class="error">{error}</p>
      {/if}

      <button class="skip-link" type="button" onclick={onSkip}>Skip for now</button>

    {:else if step === 'password'}
      <div class="header">
        <span class="title">SET VAULT PASSWORD</span>
        <button class="close-btn" type="button" onclick={() => { step = 'choose'; error = ''; }} aria-label="Back">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M8 2L4 6l4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
      </div>

      <form onsubmit={handlePasswordSetup} class="pw-form">
        <div class="field">
          <label class="field-label" for="vault-pw">PASSWORD</label>
          <input id="vault-pw" type="password" bind:value={password} placeholder="At least 12 characters" autocomplete="new-password" disabled={loading} />
        </div>
        <div class="field">
          <label class="field-label" for="vault-pw-confirm">CONFIRM</label>
          <input id="vault-pw-confirm" type="password" bind:value={confirmPassword} placeholder="Repeat password" autocomplete="new-password" disabled={loading} />
        </div>

        {#if error}
          <p class="error">{error}</p>
        {/if}

        <button type="submit" class="btn-primary" disabled={loading || password.length < 12 || !confirmPassword}>
          {loading ? 'SETTING UP…' : 'SET PASSWORD'}
        </button>
      </form>

    {:else if step === 'biometric_password'}
      <div class="header">
        <span class="title">PASSWORD FALLBACK</span>
        <button class="close-btn" type="button" onclick={() => { _pendingBio = null; step = 'choose'; error = ''; password = ''; confirmPassword = ''; }} aria-label="Back">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M8 2L4 6l4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
      </div>

      <p class="desc">Biometric registered. Set a password so you can still unlock the vault on devices without biometric support.</p>

      <form onsubmit={handleBiometricWithPassword} class="pw-form">
        <div class="field">
          <label class="field-label" for="bio-fallback-pw">PASSWORD</label>
          <input id="bio-fallback-pw" type="password" bind:value={password} placeholder="At least 12 characters" autocomplete="new-password" disabled={loading} />
        </div>
        <div class="field">
          <label class="field-label" for="bio-fallback-pw-confirm">CONFIRM</label>
          <input id="bio-fallback-pw-confirm" type="password" bind:value={confirmPassword} placeholder="Repeat password" autocomplete="new-password" disabled={loading} />
        </div>

        {#if error}
          <p class="error">{error}</p>
        {/if}

        <button type="submit" class="btn-primary" disabled={loading || password.length < 12 || !confirmPassword}>
          {loading ? 'SETTING UP…' : 'COMPLETE SETUP'}
        </button>
      </form>

    {:else if step === 'recovery'}
      <div class="header">
        <span class="title">RECOVERY KEY</span>
      </div>

      <p class="desc">Save this recovery key. If you lose access to your biometric or password, this is the <strong>only way</strong> to restore your saved results.</p>

      <div class="word-grid">
        {#each recoveryWords as word, i}
          <span class="word"><span class="word-num">{i + 1}.</span> {word}</span>
        {/each}
      </div>

      <div class="recovery-actions">
        <button class="btn-secondary" onclick={handleCopyWords}>
          {copyFeedback ? '✓ Copied' : 'Copy Words'}
        </button>
        <button class="btn-secondary" onclick={handleDownloadJSON}>
          Download File
        </button>
      </div>

      <label class="checkbox-row">
        <input type="checkbox" bind:checked={saved} />
        <span class="checkbox-label">I've saved my recovery key</span>
      </label>

      <button class="btn-primary" disabled={!saved} onclick={handleContinue}>
        CONTINUE
      </button>
    {/if}
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 110;
    background: rgba(0, 0, 0, 0.78);
    backdrop-filter: blur(8px);
    display: flex;
    align-items: flex-end;
    justify-content: center;
    animation: fade-in 0.22s ease both;
  }
  @media (min-width: 480px) {
    .backdrop { align-items: center; padding: 1.5rem; }
  }
  @keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }

  .panel {
    width: 100%;
    max-width: 400px;
    background: rgba(14, 14, 18, 0.94);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 1.25rem 1.25rem 0 0;
    padding: 0 1.75rem 1.75rem;
    backdrop-filter: blur(24px);
    display: flex;
    flex-direction: column;
    gap: 1rem;
    max-height: 90dvh;
    overflow-y: auto;
    animation: sheet-up 0.28s cubic-bezier(0.16, 1, 0.3, 1) both;
  }
  @media (min-width: 480px) {
    .panel {
      border-radius: 1.25rem;
      max-height: 80vh;
      animation: panel-in 0.24s cubic-bezier(0.16, 1, 0.3, 1) both;
    }
    @keyframes panel-in {
      from { transform: scale(0.96) translateY(-6px); opacity: 0; }
      to   { transform: scale(1)    translateY(0);    opacity: 1; }
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
  .close-btn:active { transform: scale(0.88); }

  .desc {
    font-family: 'DM Mono', monospace;
    font-size: 0.75rem; color: #8b96a6; line-height: 1.6; margin: 0;
  }
  .desc strong { color: #c2ccd5; }

  .methods {
    display: flex; flex-direction: column; gap: 0.75rem;
  }

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

  .method-btn svg { color: #527490; flex-shrink: 0; }
  .method-label {
    font-family: 'Syne', sans-serif; font-size: 0.9rem; font-weight: 600;
  }
  .method-sub {
    font-family: 'DM Mono', monospace; font-size: 0.65rem;
    color: #6c7585; letter-spacing: 0.04em; margin-left: auto;
  }

  .pw-form { display: flex; flex-direction: column; gap: 0.875rem; }

  .field { display: flex; flex-direction: column; }

  .field-label {
    font-family: 'DM Mono', monospace;
    font-size: 0.6rem; letter-spacing: 0.18em; color: #8b96a6;
    margin-bottom: 0.35rem;
  }

  .field input {
    padding: 0.72rem 1rem;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 0.75rem;
    background: rgba(255, 255, 255, 0.05);
    color: #e4e4e7;
    font-family: 'DM Mono', monospace; font-size: 0.85rem;
    outline: none; transition: border-color 0.2s;
  }
  .field input::placeholder { color: #6c7585; }
  .field input:focus { border-color: rgba(82, 116, 144, 0.4); }

  .btn-primary {
    padding: 0.8rem; border: none; border-radius: 3rem;
    background: #527490; color: #09090b;
    font-family: 'DM Mono', monospace;
    font-size: 0.72rem; font-weight: 500; letter-spacing: 0.14em;
    cursor: pointer;
    transition: transform 0.12s, filter 0.12s, background 0.2s;
  }
  .btn-primary:hover:not(:disabled) { background: #7d9db6; }
  .btn-primary:active:not(:disabled) { transform: scale(0.96); filter: brightness(0.85); }
  .btn-primary:disabled { opacity: 0.4; cursor: not-allowed; }

  .btn-secondary {
    flex: 1; padding: 0.65rem 0.875rem;
    background: rgba(255, 255, 255, 0.06); color: #c2ccd5;
    border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 3rem;
    font-family: 'DM Mono', monospace;
    font-size: 0.68rem; letter-spacing: 0.08em;
    cursor: pointer;
    transition: transform 0.12s, background 0.2s, color 0.2s;
  }
  .btn-secondary:hover { background: rgba(255, 255, 255, 0.1); color: #e4e4e7; }
  .btn-secondary:active { transform: scale(0.95); }

  .word-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 0.4rem;
    padding: 0.875rem;
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 0.75rem;
  }

  .word {
    font-family: 'DM Mono', monospace;
    font-size: 0.68rem; color: #e4e4e7;
    padding: 0.2rem 0;
  }
  .word-num { color: #525a66; font-size: 0.58rem; }

  .recovery-actions {
    display: flex; gap: 0.75rem;
  }

  .checkbox-row {
    display: flex; align-items: center; gap: 0.6rem; cursor: pointer;
  }
  .checkbox-row input[type='checkbox'] {
    appearance: none; -webkit-appearance: none;
    width: 16px; height: 16px;
    border: 1px solid rgba(255, 255, 255, 0.2); border-radius: 4px;
    background: rgba(255, 255, 255, 0.05);
    cursor: pointer; flex-shrink: 0; position: relative;
    transition: border-color 0.2s, background 0.2s;
  }
  .checkbox-row input[type='checkbox']:checked {
    border-color: #527490; background: rgba(82, 116, 144, 0.2);
  }
  .checkbox-row input[type='checkbox']:checked::after {
    content: ''; position: absolute; top: 2px; left: 5px;
    width: 4px; height: 8px;
    border: solid #527490; border-width: 0 1.5px 1.5px 0;
    transform: rotate(45deg);
  }
  .checkbox-label {
    font-family: 'DM Mono', monospace;
    font-size: 0.78rem; color: #a4afbb;
  }

  .skip-link {
    background: none; border: none;
    font-family: 'DM Mono', monospace;
    font-size: 0.68rem; color: #525a66; letter-spacing: 0.05em;
    cursor: pointer; padding: 0.25rem 0;
    transition: color 0.2s;
    text-align: center;
  }
  .skip-link:hover { color: #8b96a6; }

  .error {
    font-family: 'DM Mono', monospace;
    color: #c47070; font-size: 0.75rem; margin: 0;
  }

  @media (hover: none) and (pointer: coarse) {
    .field input { font-size: 16px !important; }
  }
</style>

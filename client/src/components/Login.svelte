<script>
  import { loginWithGoogle, loginWithCode } from '../lib/api.js';
  import EmailAuthModal from './EmailAuthModal.svelte';

  let { onLogin, exiting = false, notice = '', accessCodesEnabled = true, inviteRequired = true } = $props();

  let error = $state('');
  let loading = $state(false);
  let step = $state('google');  // 'google' | 'invite' | 'pending' | 'code'
  let hasCode = $state(false);
  let inviteCode = $state('');
  let googleIdToken = $state(null);
  let accessCode = $state('');
  let noticeDismissed = $state(false);
  let showEmailModal = $state(false);
  let showGoogleInvitePopup = $state(false);
  let googleInviteCode = $state('');
  let googleInviteLoading = $state(false);
  let googleInviteError = $state('');

  // Reset dismiss flag whenever a new notice arrives
  $effect(() => { if (notice) noticeDismissed = false; });

  // Wait for Google Identity Services to load, then initialize.
  // Skip entirely when no client ID is configured — avoids GSI runtime errors.
  const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID;
  let gsiReady = $state(false);
  let googleBtnNode = $state(null);
  let btnVisible = $state(false);

  $effect(() => {
    if (!GOOGLE_CLIENT_ID) return; // email-only deployment — do not load GSI
    if (typeof google !== 'undefined' && google.accounts) {
      initGsi();
    } else {
      const interval = setInterval(() => {
        if (typeof google !== 'undefined' && google.accounts) {
          clearInterval(interval);
          initGsi();
        }
      }, 100);
      return () => clearInterval(interval);
    }
  });

  function initGsi() {
    google.accounts.id.initialize({
      // @ts-ignore — GOOGLE_CLIENT_ID is injected by Vite from .env
      client_id: GOOGLE_CLIENT_ID,
      callback: handleGoogleCredential,
      auto_select: false,
    });
    gsiReady = true;
  }

  $effect(() => {
    if (gsiReady && googleBtnNode) {
      google.accounts.id.renderButton(googleBtnNode, {
        type: 'standard',
        theme: 'filled_black',
        size: 'large',
        width: 260,
        text: 'signin_with',
        shape: 'pill',
      });
      // Delay visibility to let GSI finish both renders:
      // first (generic) + second (personalized "Sign in as…") before fading in
      const t = setTimeout(() => { btnVisible = true; }, 650);
      return () => clearTimeout(t);
    }
  });

  async function handleGoogleCredential(response) {
    const idToken = response.credential;
    googleIdToken = idToken;
    error = '';
    loading = true;

    try {
      const data = await loginWithGoogle(idToken);

      if (data.status === 'invite_required') {
        showGoogleInvitePopup = true;
        loading = false;
        return;
      }

      if (data.status === 'pending_approval') {
        step = data.isNew === false ? 'pending' : 'invite';
        loading = false;
        return;
      }

      if (data.token) {
        onLogin(data.token, data.user);
        return;
      }
    } catch (err) {
      // If this is a new user, the server returns pending_approval as 200
      // but let's also handle invite code flow on error
      error = err.message;
    } finally {
      loading = false;
    }
  }

  async function handleInviteSubmit(e) {
    e.preventDefault();
    if (!inviteCode.trim() || !googleIdToken) return;
    error = '';
    loading = true;

    try {
      const data = await loginWithGoogle(googleIdToken, inviteCode.trim());
      if (data.token) {
        onLogin(data.token, data.user);
        return;
      }
      if (data.status === 'pending_approval') {
        step = 'pending';
      }
    } catch (err) {
      error = err.message;
    } finally {
      loading = false;
    }
  }

  function handleRegisterWithoutCode() {
    step = 'pending';
  }

  async function handleGoogleInviteSubmit(e) {
    e.preventDefault();
    if (!googleInviteCode.trim() || !googleIdToken) return;
    googleInviteError = '';
    googleInviteLoading = true;
    try {
      const data = await loginWithGoogle(googleIdToken, googleInviteCode.trim());
      if (data.token) {
        showGoogleInvitePopup = false;
        onLogin(data.token, data.user);
        return;
      }
      if (data.status === 'pending_approval') {
        showGoogleInvitePopup = false;
        step = 'pending';
      }
    } catch (err) {
      googleInviteError = err.message;
    } finally {
      googleInviteLoading = false;
    }
  }

  async function handleAccessCode(e) {
    e.preventDefault();
    if (!accessCode.trim()) return;
    error = '';
    loading = true;
    try {
      const data = await loginWithCode(accessCode.trim());
      if (data.token) {
        onLogin(data.token, data.user);
      }
    } catch (err) {
      error = err.message;
    } finally {
      loading = false;
    }
  }
</script>

<div class="login-bg" class:is-exiting={exiting}>
  {#if step === 'google'}
    <div class="login-card">
      <div class="brand">
        <span class="brand-title">ComfyLink</span>
        <span class="brand-sub">FLUX2 9B KLEIN &middot; REMOTE</span>
      </div>

      {#if GOOGLE_CLIENT_ID}
      <div class="google-btn-wrap">
        <div class="google-btn-slot" class:loaded={btnVisible} bind:this={googleBtnNode}></div>
        {#if !btnVisible}
          <div class="google-btn-placeholder" class:failed={!gsiReady && !btnVisible}>
            {#if gsiReady}
              <span class="dot-pulse"><span></span><span></span><span></span></span>
            {:else}
              <span class="placeholder-text">Connecting…</span>
            {/if}
          </div>
        {/if}
      </div>
      {/if}

      {#if notice && !noticeDismissed}
        <div class="notice">
          <span>{notice}</span>
          <button type="button" class="notice-dismiss" onclick={() => noticeDismissed = true} aria-label="Dismiss">×</button>
        </div>
      {/if}

      {#if error}
        <p class="error">{error}</p>
      {/if}

      {#if accessCodesEnabled}
        <div class="divider">
          <span class="divider-line"></span><span class="divider-text">OR</span><span class="divider-line"></span>
        </div>
        <button type="button" class="btn-code-toggle" onclick={() => { step = 'code'; error = ''; }}>
          Enter access code
        </button>
      {/if}

      <div class="divider">
        <span class="divider-line"></span><span class="divider-text">OR</span><span class="divider-line"></span>
      </div>
      <button type="button" class="btn-code-toggle" onclick={() => { showEmailModal = true; }}>
        Login with e-mail
      </button>
    </div>

  {:else if step === 'code'}
    <form class="login-card" onsubmit={handleAccessCode}>
      <div class="brand">
        <span class="brand-title">ComfyLink</span>
        <span class="brand-sub">ACCESS CODE</span>
      </div>

      <input
        type="text"
        placeholder="KLEIN-XXXX-XXXX"
        autocomplete="off"
        spellcheck="false"
        bind:value={accessCode}
        disabled={loading}
        class="code-input"
      />

      <button type="submit" disabled={loading || !accessCode.trim()}>
        {loading ? 'VERIFYING…' : 'ENTER'}
      </button>

      {#if notice && !noticeDismissed}
        <div class="notice">
          <span>{notice}</span>
          <button type="button" class="notice-dismiss" onclick={() => noticeDismissed = true} aria-label="Dismiss">×</button>
        </div>
      {/if}

      {#if error}
        <p class="error">{error}</p>
      {/if}

      <button type="button" class="btn-code-toggle" onclick={() => { step = 'google'; error = ''; accessCode = ''; }}>
        Use a different login method
      </button>
    </form>

  {:else if step === 'invite'}
    <form class="login-card" onsubmit={handleInviteSubmit}>
      <div class="brand">
        <span class="brand-title">ComfyLink</span>
        <span class="brand-sub">COMPLETE REGISTRATION</span>
      </div>

      <p class="invite-prompt">Do you have an invite code?</p>

      <label class="checkbox-row">
        <input type="checkbox" bind:checked={hasCode} />
        <span class="checkbox-label">Yes, I have a code</span>
      </label>

      {#if hasCode}
        <input
          type="text"
          placeholder="KLEIN-XXXX-XXXX"
          autocomplete="off"
          spellcheck="false"
          bind:value={inviteCode}
          disabled={loading}
          class="code-input"
        />
        <button type="submit" disabled={loading || !inviteCode.trim()}>
          {loading ? 'VERIFYING…' : 'ACTIVATE'}
        </button>
      {:else}
        <button type="button" class="btn-secondary" onclick={handleRegisterWithoutCode} disabled={loading}>
          REGISTER WITHOUT CODE
        </button>
      {/if}

      {#if notice && !noticeDismissed}
        <div class="notice">
          <span>{notice}</span>
          <button type="button" class="notice-dismiss" onclick={() => noticeDismissed = true} aria-label="Dismiss">×</button>
        </div>
      {/if}

      {#if error}
        <p class="error">{error}</p>
      {/if}
    </form>

  {:else if step === 'pending'}
    <div class="login-card">
      <div class="brand">
        <span class="brand-title">ComfyLink</span>
        <span class="brand-sub">REGISTRATION SUBMITTED</span>
      </div>

      <div class="pending-msg">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="12" cy="12" r="10" stroke="var(--accent-primary)" stroke-width="1.5"/>
          <path d="M12 7v5l3 3" stroke="var(--accent-primary)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        <p>Your account is pending admin approval. You'll be able to sign in once approved.</p>
      </div>

      {#if notice && !noticeDismissed}
        <div class="notice">
          <span>{notice}</span>
          <button type="button" class="notice-dismiss" onclick={() => noticeDismissed = true} aria-label="Dismiss">×</button>
        </div>
      {/if}

      <button type="button" onclick={() => { step = 'google'; error = ''; }}>
        BACK TO SIGN IN
      </button>
    </div>
  {/if}
</div>

{#if showGoogleInvitePopup}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_noninteractive_element_interactions -->
  <div class="google-invite-backdrop" role="dialog" aria-modal="true" tabindex="-1"
    onclick={(e) => { if (e.target === e.currentTarget) { showGoogleInvitePopup = false; googleInviteCode = ''; googleInviteError = ''; } }}
    onkeydown={(e) => { if (e.key === 'Escape') { showGoogleInvitePopup = false; googleInviteCode = ''; googleInviteError = ''; } }}>
    <form class="google-invite-card" onsubmit={handleGoogleInviteSubmit} novalidate>
      <p class="google-invite-heading">INVITE REQUIRED</p>
      <p class="google-invite-body">Your Google account isn't registered yet. Enter an invite code to complete registration.</p>
      <input
        type="text"
        placeholder="KLEIN-XXXX-XXXX"
        autocomplete="off"
        spellcheck="false"
        bind:value={googleInviteCode}
        disabled={googleInviteLoading}
        class="code-input"
      />
      {#if googleInviteError}
        <p class="error">{googleInviteError}</p>
      {/if}
      <button type="submit" disabled={googleInviteLoading || !googleInviteCode.trim()}>
        {googleInviteLoading ? 'VERIFYING…' : 'ACTIVATE'}
      </button>
      <button type="button" class="btn-secondary" onclick={() => { showGoogleInvitePopup = false; googleInviteCode = ''; googleInviteError = ''; }}>
        CANCEL
      </button>
    </form>
  </div>
{/if}

{#if showEmailModal}
  <EmailAuthModal
    onLogin={(token, user) => { showEmailModal = false; onLogin(token, user); }}
    onClose={() => { showEmailModal = false; }}
    inviteRequired={inviteRequired}
  />
{/if}

<style>
  .login-bg {
    display: flex;
    justify-content: center;
    align-items: center;
    min-height: 100dvh;
    padding: 1.5rem;
  }

  .login-card {
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
    width: 100%;
    max-width: 320px;
    background: var(--surface-raised-glass);
    border: 1px solid var(--border-default);
    border-radius: 1.25rem;
    padding: 2rem 1.75rem;
    backdrop-filter: blur(16px);
    animation: cardEntrance 0.75s cubic-bezier(0.16, 1, 0.3, 1) both;
    will-change: transform, opacity;
  }

  @keyframes cardEntrance {
    from {
      opacity: 0;
      transform: translateY(28px) scale(0.97);
    }
    to {
      opacity: 1;
      transform: translateY(0) scale(1);
    }
  }

  .brand {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    margin-bottom: 0.25rem;
    align-items: center;
    text-align: center;
  }

  .brand-title {
    font-family: 'Syne', sans-serif;
    font-size: 1.9rem;
    font-weight: 800;
    color: var(--text-primary);
    letter-spacing: -0.03em;
    line-height: 1;
  }

  .brand-sub {
    font-family: 'DM Mono', monospace;
    font-size: 0.65rem;
    letter-spacing: 0.18em;
    color: var(--accent-primary);
    font-weight: 400;
  }

  .notice {
    margin: -0.35rem 0 0;
    padding: 0.6rem 0.75rem;
    border: 1px solid var(--state-warning-border);
    border-radius: 0.65rem;
    background: var(--state-warning-bg);
    color: var(--state-warning);
    font-family: 'DM Mono', monospace;
    font-size: 0.68rem;
    letter-spacing: 0.05em;
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .notice span {
    flex: 1;
    text-align: center;
  }

  .notice-dismiss {
    flex-shrink: 0;
    background: none;
    border: none;
    color: var(--state-warning);
    font-size: 1rem;
    line-height: 1;
    padding: 0;
    cursor: pointer;
    opacity: 0.6;
  }

  .notice-dismiss:hover {
    opacity: 1;
  }

  .google-btn-wrap {
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    padding: 0.25rem 0;
    min-height: 48px;
    position: relative;
  }

  .google-btn-slot {
    position: absolute;
    width: 260px;
    height: 44px;
    display: flex;
    justify-content: center;
    align-items: center;
    opacity: 0;
    transition: opacity 0.4s ease;
    pointer-events: none;
  }

  .google-btn-slot.loaded {
    opacity: 1;
    pointer-events: auto;
  }

  .google-btn-placeholder {
    height: 44px;
    display: flex;
    justify-content: center;
    align-items: center;
  }

  .placeholder-text {
    font-family: 'DM Mono', monospace;
    font-size: 0.72rem;
    color: var(--text-muted);
    letter-spacing: 0.08em;
  }

  .dot-pulse {
    display: flex;
    gap: 5px;
    align-items: center;
  }

  .dot-pulse span {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--text-muted);
    animation: dotPulse 1.2s ease-in-out infinite;
  }

  .dot-pulse span:nth-child(2) { animation-delay: 0.2s; }
  .dot-pulse span:nth-child(3) { animation-delay: 0.4s; }

  @keyframes dotPulse {
    0%, 80%, 100% { transform: scale(0.6); opacity: 0.3; }
    40%            { transform: scale(1);   opacity: 1; }
  }

  .invite-prompt {
    font-family: 'DM Mono', monospace;
    font-size: 0.8rem;
    color: var(--text-secondary);
    margin: 0;
    text-align: center;
  }

  .checkbox-row {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    cursor: pointer;
    padding: 0.25rem 0;
  }

  .checkbox-row input[type='checkbox'] {
    appearance: none;
    -webkit-appearance: none;
    width: 16px;
    height: 16px;
    border: 1px solid var(--border-strong);
    border-radius: 4px;
    background: var(--surface-well-glass);
    cursor: pointer;
    flex-shrink: 0;
    position: relative;
    transition: border-color 0.2s, background 0.2s;
  }

  .checkbox-row input[type='checkbox']:checked {
    border-color: var(--accent-primary);
    background: var(--accent-primary-dim);
  }

  .checkbox-row input[type='checkbox']:checked::after {
    content: '';
    position: absolute;
    top: 2px;
    left: 5px;
    width: 4px;
    height: 8px;
    border: solid var(--accent-primary);
    border-width: 0 1.5px 1.5px 0;
    transform: rotate(45deg);
  }

  .checkbox-label {
    font-family: 'DM Mono', monospace;
    font-size: 0.78rem;
    color: var(--text-secondary);
    letter-spacing: 0.02em;
  }

  .code-input {
    padding: 0.72rem 1rem;
    border: 1px solid var(--border-default);
    border-radius: 0.75rem;
    background: var(--surface-well-glass);
    color: var(--text-primary);
    font-family: 'DM Mono', monospace;
    font-size: 0.95rem;
    outline: none;
    transition: border-color 0.2s;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    width: 100%;
  }

  .code-input::placeholder {
    color: var(--text-muted);
    letter-spacing: 0.05em;
    text-transform: none;
  }

  .code-input:focus {
    border-color: var(--border-focus);
  }

  button {
    padding: 0.8rem 1.5rem;
    border: none;
    border-radius: 3rem;
    background: var(--accent-primary);
    color: var(--text-on-accent);
    font-family: 'DM Mono', monospace;
    font-size: 0.72rem;
    font-weight: 500;
    letter-spacing: 0.14em;
    cursor: pointer;
    transition: transform 0.12s ease, filter 0.12s ease, background 0.2s;
  }

  button:hover:not(:disabled) {
    background: var(--accent-primary-hover);
  }

  button:active:not(:disabled) {
    transform: scale(0.95);
    filter: brightness(0.85);
  }

  button:disabled {
    opacity: 0.35;
    cursor: not-allowed;
  }

  .btn-secondary {
    background: var(--surface-well-glass);
    color: var(--text-secondary);
    border: 1px solid var(--border-default);
  }

  .btn-secondary:hover:not(:disabled) {
    background: var(--surface-active);
    color: var(--text-primary);
  }

  .pending-msg {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.75rem;
    text-align: center;
  }

  .pending-msg p {
    font-family: 'DM Mono', monospace;
    font-size: 0.78rem;
    color: var(--text-secondary);
    line-height: 1.6;
    margin: 0;
  }

  .error {
    font-family: 'DM Mono', monospace;
    color: var(--state-error);
    font-size: 0.75rem;
    margin: 0;
    letter-spacing: 0.03em;
  }

  .divider {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }
  .divider-line {
    flex: 1;
    height: 1px;
    background: var(--border-subtle);
  }
  .divider-text {
    font-family: 'DM Mono', monospace;
    font-size: 0.6rem;
    color: var(--text-muted);
    letter-spacing: 0.15em;
  }

  .btn-code-toggle {
    background: none;
    border: none;
    padding: 0.25rem;
    font-family: 'DM Mono', monospace;
    font-size: 0.7rem;
    color: var(--text-muted);
    letter-spacing: 0.05em;
    cursor: pointer;
    transition: color 0.2s;
    text-align: center;
  }
  .btn-code-toggle:hover {
    color: var(--text-secondary);
  }

  .login-bg {
    transition: filter 0.5s ease;
  }

  .login-bg.is-exiting .login-card {
    animation: cardExit 0.65s cubic-bezier(0.4, 0, 1, 1) forwards !important;
    pointer-events: none;
  }

  @keyframes cardExit {
    0% {
      opacity: 1;
      transform: scale(1) translateY(0);
      filter: blur(0px);
    }
    100% {
      opacity: 0;
      transform: scale(1.05) translateY(-12px);
      filter: blur(12px);
    }
  }

  @media (hover: none) and (pointer: coarse) {
    .code-input { font-size: 16px !important; }
  }

  .google-invite-backdrop {
    position: fixed;
    inset: 0;
    z-index: 100;
    background: var(--surface-backdrop);
    backdrop-filter: blur(8px);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1.5rem;
    animation: fade-in-overlay 0.2s ease both;
  }
  @keyframes fade-in-overlay { from { opacity: 0; } to { opacity: 1; } }

  .google-invite-card {
    width: 100%;
    max-width: 300px;
    background: var(--surface-overlay-glass);
    border: 1px solid var(--border-default);
    border-radius: 1.25rem;
    padding: 1.5rem 1.5rem 1.25rem;
    display: flex;
    flex-direction: column;
    gap: 0.9rem;
    animation: panel-in-overlay 0.22s cubic-bezier(0.16, 1, 0.3, 1) both;
  }
  @keyframes panel-in-overlay {
    from { transform: scale(0.95) translateY(-8px); opacity: 0; }
    to   { transform: scale(1)    translateY(0);    opacity: 1; }
  }

  .google-invite-heading {
    font-family: 'DM Mono', monospace;
    font-size: 0.6rem;
    letter-spacing: 0.2em;
    color: var(--accent-primary);
    margin: 0;
    text-align: center;
  }

  .google-invite-body {
    font-family: 'DM Mono', monospace;
    font-size: 0.72rem;
    color: var(--text-secondary);
    margin: 0;
    line-height: 1.55;
    text-align: center;
  }
</style>

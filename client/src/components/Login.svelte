<script>
  import { loginWithGoogle, loginWithCode } from '../lib/api.js';

  let { onLogin, exiting = false } = $props();

  let error = $state('');
  let loading = $state(false);
  let step = $state('google');  // 'google' | 'invite' | 'pending' | 'code'
  let hasCode = $state(false);
  let inviteCode = $state('');
  let googleIdToken = $state(null);
  let accessCode = $state('');

  // Wait for Google Identity Services to load, then initialize
  let gsiReady = $state(false);
  let googleBtnNode = $state(null);
  let btnVisible = $state(false);

  $effect(() => {
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
      client_id: import.meta.env.VITE_GOOGLE_CLIENT_ID,
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

      {#if error}
        <p class="error">{error}</p>
      {/if}

      <div class="divider">
        <span class="divider-line"></span><span class="divider-text">OR</span><span class="divider-line"></span>
      </div>

      <button type="button" class="btn-code-toggle" onclick={() => { step = 'code'; error = ''; }}>
        Enter access code
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

      {#if error}
        <p class="error">{error}</p>
      {/if}

      <button type="button" class="btn-code-toggle" onclick={() => { step = 'google'; error = ''; accessCode = ''; }}>
        Sign in with Google instead
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
          <circle cx="12" cy="12" r="10" stroke="#527490" stroke-width="1.5"/>
          <path d="M12 7v5l3 3" stroke="#527490" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        <p>Your account is pending admin approval. You'll be able to sign in once approved.</p>
      </div>

      <button type="button" onclick={() => { step = 'google'; error = ''; }}>
        BACK TO SIGN IN
      </button>
    </div>
  {/if}
</div>

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
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.08);
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
    color: #d4d4d8;
    letter-spacing: -0.03em;
    line-height: 1;
  }

  .brand-sub {
    font-family: 'DM Mono', monospace;
    font-size: 0.65rem;
    letter-spacing: 0.18em;
    color: #527490;
    font-weight: 400;
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
    color: #3d4550;
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
    background: #3d4550;
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
    color: #a4afbb;
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
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: 4px;
    background: rgba(255, 255, 255, 0.05);
    cursor: pointer;
    flex-shrink: 0;
    position: relative;
    transition: border-color 0.2s, background 0.2s;
  }

  .checkbox-row input[type='checkbox']:checked {
    border-color: #527490;
    background: rgba(82, 116, 144, 0.2);
  }

  .checkbox-row input[type='checkbox']:checked::after {
    content: '';
    position: absolute;
    top: 2px;
    left: 5px;
    width: 4px;
    height: 8px;
    border: solid #527490;
    border-width: 0 1.5px 1.5px 0;
    transform: rotate(45deg);
  }

  .checkbox-label {
    font-family: 'DM Mono', monospace;
    font-size: 0.78rem;
    color: #a4afbb;
    letter-spacing: 0.02em;
  }

  .code-input {
    padding: 0.72rem 1rem;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 0.75rem;
    background: rgba(255, 255, 255, 0.06);
    color: #f4f4f5;
    font-family: 'DM Mono', monospace;
    font-size: 0.95rem;
    outline: none;
    transition: border-color 0.2s;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    width: 100%;
  }

  .code-input::placeholder {
    color: #6c7585;
    letter-spacing: 0.05em;
    text-transform: none;
  }

  .code-input:focus {
    border-color: rgba(82, 116, 144, 0.5);
  }

  button {
    padding: 0.8rem 1.5rem;
    border: none;
    border-radius: 3rem;
    background: #527490;
    color: #09090b;
    font-family: 'DM Mono', monospace;
    font-size: 0.72rem;
    font-weight: 500;
    letter-spacing: 0.14em;
    cursor: pointer;
    transition: transform 0.12s ease, filter 0.12s ease, background 0.2s;
  }

  button:hover:not(:disabled) {
    background: #7d9db6;
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
    background: rgba(255, 255, 255, 0.06);
    color: #c2ccd5;
    border: 1px solid rgba(255, 255, 255, 0.08);
  }

  .btn-secondary:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.11);
    color: #e4e4e7;
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
    color: #8b96a6;
    line-height: 1.6;
    margin: 0;
  }

  .error {
    font-family: 'DM Mono', monospace;
    color: #c47070;
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
    background: rgba(255, 255, 255, 0.08);
  }
  .divider-text {
    font-family: 'DM Mono', monospace;
    font-size: 0.6rem;
    color: #525a66;
    letter-spacing: 0.15em;
  }

  .btn-code-toggle {
    background: none;
    border: none;
    padding: 0.25rem;
    font-family: 'DM Mono', monospace;
    font-size: 0.7rem;
    color: #525a66;
    letter-spacing: 0.05em;
    cursor: pointer;
    transition: color 0.2s;
    text-align: center;
  }
  .btn-code-toggle:hover {
    color: #8b96a6;
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
</style>

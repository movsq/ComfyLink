<script>
  import { registerEmail, loginEmail, acceptTos } from '../lib/api.js';
  import TermsModal from './TermsModal.svelte';
  import DataNoticeModal from './DataNoticeModal.svelte';

  let { onLogin, onClose, inviteRequired = true } = $props();

  // ── Tab ──────────────────────────────────────────────────────────────────
  let activeTab = $state('login'); // 'login' | 'register'

  // ── Login form ────────────────────────────────────────────────────────────
  let loginEmail_ = $state('');
  let loginPassword = $state('');
  let forgotClicked = $state(false);
  let loginLoading = $state(false);
  let loginError = $state('');

  // ── Register form ────────────────────────────────────────────────────────
  let regEmail = $state('');
  let regPassword = $state('');
  let regConfirm = $state('');
  let regInviteCode = $state('');
  let regLoading = $state(false);
  let regError = $state('');
  let regSuccess = $state(false); // pending_approval case
  let regStep = $state('form'); // 'form' | 'tos' | 'data'

  // ── Password strength ────────────────────────────────────────────────────
  const SYMBOL_RE = /[!@#$%^&*()_+\-=[\]{}|;':",.<>?/\\`~]/;
  const LETTER_RE = /[a-zA-Z]/;
  const NUMBER_RE = /[0-9]/;

  let pwLen = $derived(regPassword.length >= 8);
  let pwLetters = $derived(LETTER_RE.test(regPassword));
  let pwNumbers = $derived(NUMBER_RE.test(regPassword));
  let pwSymbols = $derived(SYMBOL_RE.test(regPassword));
  let pwClassCount = $derived((pwLetters ? 1 : 0) + (pwNumbers ? 1 : 0) + (pwSymbols ? 1 : 0));
  let pwStrengthOk = $derived(pwLen && pwClassCount >= 2);
  let pwStrengthLevel = $derived(!regPassword ? 0 : (!pwLen ? 1 : (pwClassCount < 2 ? 1 : (pwClassCount === 2 ? 2 : 3))));
  let pwMismatch = $derived(regConfirm.length > 0 && regPassword !== regConfirm);

  // ── Form validity ────────────────────────────────────────────────────────
  let regValid = $derived(
    regEmail.trim().length > 0 &&
    regEmail.includes('@') &&
    pwStrengthOk &&
    regPassword === regConfirm &&
    regConfirm.length > 0 &&
    (!inviteRequired || regInviteCode.trim().length > 0)
  );

  // ── Handlers ─────────────────────────────────────────────────────────────

  async function handleLogin(e) {
    e.preventDefault();
    loginError = '';
    forgotClicked = false;
    loginLoading = true;
    try {
      const data = await loginEmail({ email: loginEmail_, password: loginPassword });
      if (data.status === 'pending_approval') {
        loginError = 'Your account is pending admin approval.';
        return;
      }
      if (data.token) {
        onLogin(data.token, data.user);
      }
    } catch (err) {
      loginError = err.message;
    } finally {
      loginLoading = false;
    }
  }

  function handleRegister(e) {
    e.preventDefault();
    regError = '';
    regStep = 'tos';
  }

  async function handleActualRegister() {
    regLoading = true;
    regError = '';
    try {
      const data = await registerEmail({
        email: regEmail.trim(),
        password: regPassword,
        inviteCode: regInviteCode.trim() || null,
        acceptedData: true,
        acceptedTos: true,
      });
      if (data.status === 'pending_approval') {
        regStep = 'form';
        regSuccess = true;
        return;
      }
      if (data.token) {
        // Persist TOS acceptance server-side; non-fatal if it fails
        try { await acceptTos(data.token); } catch (_) { /* ignore */ }
        onLogin(data.token, { ...data.user, tosAccepted: true });
      }
    } catch (err) {
      regStep = 'form';
      regError = err.message;
    } finally {
      regLoading = false;
    }
  }

  function switchTab(tab) {
    activeTab = tab;
    loginError = '';
    regError = '';
    forgotClicked = false;
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_noninteractive_element_interactions -->
<div class="backdrop" role="dialog" aria-modal="true" tabindex="-1" onclick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
  <div class="panel">
    <div class="handle"></div>

    <!-- Header -->
    <div class="modal-header">
      <span class="modal-title">COMFYLINK</span>
      <button class="close-btn" type="button" onclick={onClose} aria-label="Close">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <path d="M1 1l12 12M13 1L1 13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
      </button>
    </div>

    <!-- Tabs -->
    <div class="tabs">
      <button type="button" class="tab" class:active={activeTab === 'login'} onclick={() => switchTab('login')}>
        SIGN IN
      </button>
      <button type="button" class="tab" class:active={activeTab === 'register'} onclick={() => switchTab('register')}>
        REGISTER
      </button>
    </div>

    <!-- ── Login tab ───────────────────────────────────────────────────── -->
    {#if activeTab === 'login'}
      <form class="form" onsubmit={handleLogin} novalidate>
        <div class="field">
          <label class="field-label" for="login-email">EMAIL</label>
          <input
            id="login-email"
            type="email"
            autocomplete="email"
            bind:value={loginEmail_}
            disabled={loginLoading}
            class="field-input"
            placeholder="you@example.com"
            required
          />
        </div>

        <div class="field">
          <div class="field-header">
            <label class="field-label" for="login-password">PASSWORD</label>
            <button
              type="button"
              class="forgot-link"
              onclick={() => { forgotClicked = !forgotClicked; }}
            >forgot password?</button>
          </div>
          <input
            id="login-password"
            type="password"
            autocomplete="current-password"
            bind:value={loginPassword}
            disabled={loginLoading}
            class="field-input"
            placeholder="••••••••"
            required
          />
        </div>

        {#if forgotClicked}
          <p class="info-msg">Password reset is not yet available. Please contact the administrator.</p>
        {/if}

        {#if loginError}
          <p class="error">{loginError}</p>
        {/if}

        <button
          type="submit"
          class="btn-primary"
          disabled={loginLoading || !loginEmail_.trim() || !loginPassword}
        >
          {loginLoading ? 'SIGNING IN…' : 'SIGN IN'}
        </button>

        <p class="switch-hint">
          No account?
          <button type="button" class="switch-link" onclick={() => switchTab('register')}>Create one</button>
        </p>
      </form>

    <!-- ── Register tab ─────────────────────────────────────────────────── -->
    {:else if regSuccess}
      <div class="pending-state">
        <svg class="pending-icon" width="28" height="28" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="12" cy="12" r="10" stroke="#527490" stroke-width="1.5"/>
          <path d="M12 7v5l3 3" stroke="#527490" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        <p class="pending-text">Registration submitted. Your account is pending admin approval.</p>
        <button class="btn-secondary" type="button" onclick={onClose}>CLOSE</button>
      </div>
    {:else}
      <form class="form" onsubmit={handleRegister} novalidate>
        <div class="field">
          <label class="field-label" for="reg-email">EMAIL</label>
          <input
            id="reg-email"
            type="email"
            autocomplete="email"
            bind:value={regEmail}
            disabled={regLoading}
            class="field-input"
            placeholder="you@example.com"
            required
          />
        </div>

        <div class="field">
          <label class="field-label" for="reg-password">PASSWORD</label>
          <input
            id="reg-password"
            type="password"
            autocomplete="new-password"
            bind:value={regPassword}
            disabled={regLoading}
            class="field-input"
            placeholder="••••••••"
            required
          />
          {#if regPassword.length > 0}
            <div class="strength-bar-wrap">
              <div
                class="strength-bar"
                class:level-1={pwStrengthLevel === 1}
                class:level-2={pwStrengthLevel === 2}
                class:level-3={pwStrengthLevel === 3}
                style="width: {pwStrengthLevel === 0 ? 0 : pwStrengthLevel === 1 ? 33 : pwStrengthLevel === 2 ? 66 : 100}%"
              ></div>
            </div>
            <ul class="strength-criteria">
              <li class:met={pwLen}>At least 8 characters</li>
              <li class:met={pwClassCount >= 2}>2+ character types (letters, numbers, symbols)</li>
            </ul>
          {/if}
        </div>

        <div class="field">
          <label class="field-label" for="reg-confirm">CONFIRM PASSWORD</label>
          <input
            id="reg-confirm"
            type="password"
            autocomplete="new-password"
            bind:value={regConfirm}
            disabled={regLoading}
            class="field-input"
            class:mismatch={pwMismatch}
            placeholder="••••••••"
            required
          />
          {#if pwMismatch}
            <p class="field-error">Passwords do not match</p>
          {/if}
        </div>

        <div class="field">
          <label class="field-label" for="reg-code">
            INVITE CODE{inviteRequired ? '' : ' (OPTIONAL)'}
          </label>
          <input
            id="reg-code"
            type="text"
            autocomplete="off"
            spellcheck="false"
            bind:value={regInviteCode}
            disabled={regLoading}
            class="field-input code-input"
            placeholder="KLEIN-XXXX-XXXX"
          />
        </div>

        {#if regError}
          <p class="error">{regError}</p>
        {/if}

        <button
          type="submit"
          class="btn-primary"
          disabled={regLoading || !regValid}
        >
          {regLoading ? 'CONTINUING…' : 'CONTINUE'}
        </button>

        <p class="switch-hint">
          Already registered?
          <button type="button" class="switch-link" onclick={() => switchTab('login')}>Sign in</button>
        </p>
      </form>
    {/if}
  </div>

  {#if regStep === 'tos'}
    <TermsModal
      token={null}
      isCodeUser={true}
      viewOnly={false}
      onAccepted={() => { regStep = 'data'; }}
      onDeclined={() => { regStep = 'form'; }}
    />
  {:else if regStep === 'data'}
    <DataNoticeModal
      onClose={() => { regStep = 'form'; }}
      onAccepted={handleActualRegister}
    />
  {/if}
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 120;
    background: rgba(0, 0, 0, 0.82);
    backdrop-filter: blur(10px);
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
    background: rgba(14, 14, 18, 0.96);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 1.25rem 1.25rem 0 0;
    padding: 0 1.75rem 1.75rem;
    backdrop-filter: blur(24px);
    display: flex;
    flex-direction: column;
    gap: 0;
    max-height: 92dvh;
    overflow-y: auto;
    scrollbar-width: thin;
    scrollbar-color: rgba(82, 116, 144, 0.2) transparent;
    animation: sheet-up 0.28s cubic-bezier(0.16, 1, 0.3, 1) both;
  }
  @media (min-width: 480px) {
    .panel {
      border-radius: 1.25rem;
      max-height: 88vh;
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

  .modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.5rem 0 0;
    margin-bottom: 1.25rem;
  }
  .modal-title {
    font-family: 'DM Mono', monospace;
    font-size: 0.6rem;
    letter-spacing: 0.25em;
    color: #527490;
  }
  .close-btn {
    background: none; border: none; padding: 0.25rem;
    color: rgba(255,255,255,0.3);
    cursor: pointer; transition: color 0.15s; line-height: 1;
    border-radius: 4px;
  }
  .close-btn:hover { color: rgba(255,255,255,0.7); }

  /* ── Tabs ─────────────────────────────────────────────────────────────── */
  .tabs {
    display: flex;
    border-bottom: 1px solid rgba(255,255,255,0.07);
    margin-bottom: 1.25rem;
    gap: 0;
  }
  .tab {
    flex: 1;
    background: none; border: none;
    padding: 0.6rem 0;
    font-family: 'DM Mono', monospace;
    font-size: 0.62rem; letter-spacing: 0.18em;
    color: rgba(255,255,255,0.28);
    cursor: pointer;
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
    transition: color 0.2s, border-color 0.2s;
  }
  .tab:hover { color: rgba(255,255,255,0.55); }
  .tab.active { color: #d4d4d8; border-bottom-color: #527490; }

  /* ── Form ─────────────────────────────────────────────────────────────── */
  .form {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .field-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .field-label {
    font-family: 'DM Mono', monospace;
    font-size: 0.65rem;
    letter-spacing: 0.15em;
    color: #527490;
  }
  .forgot-link {
    background: none; border: none; padding: 0;
    font-family: 'DM Mono', monospace;
    font-size: 0.62rem;
    color: rgba(255,255,255,0.25);
    cursor: pointer;
    transition: color 0.15s;
  }
  .forgot-link:hover { color: rgba(255,255,255,0.5); }

  .field-input {
    padding: 0.65rem 0.9rem;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 0.65rem;
    background: rgba(255, 255, 255, 0.05);
    color: #f4f4f5;
    font-family: 'DM Mono', monospace;
    font-size: 1rem;
    outline: none;
    transition: border-color 0.2s;
    width: 100%;
    box-sizing: border-box;
  }
  .field-input::placeholder { color: rgba(255,255,255,0.18); }
  .field-input:focus { border-color: rgba(82, 116, 144, 0.45); }
  .field-input:disabled { opacity: 0.5; }
  .field-input.mismatch { border-color: rgba(196, 112, 112, 0.5); }
  .field-input.code-input { letter-spacing: 0.1em; text-transform: uppercase; font-size: 0.82rem; }
  .field-input.code-input::placeholder { text-transform: none; letter-spacing: 0.04em; }

  .field-error {
    font-family: 'DM Mono', monospace;
    font-size: 0.65rem;
    color: #c47070;
    margin: 0;
  }

  /* ── Password strength ────────────────────────────────────────────────── */
  .strength-bar-wrap {
    height: 3px;
    background: rgba(255,255,255,0.06);
    border-radius: 9999px;
    overflow: hidden;
    margin-top: 0.15rem;
  }
  .strength-bar {
    height: 100%;
    border-radius: 9999px;
    transition: width 0.25s ease, background 0.25s ease;
    background: #c47070;
  }
  .strength-bar.level-2 { background: #c4a44e; }
  .strength-bar.level-3 { background: #5a9e72; }

  .strength-criteria {
    list-style: none;
    margin: 0.3rem 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }
  .strength-criteria li {
    font-family: 'DM Mono', monospace;
    font-size: 0.72rem;
    color: rgba(255,255,255,0.3);
    padding-left: 1rem;
    position: relative;
    transition: color 0.2s;
  }
  .strength-criteria li::before {
    content: '✗';
    position: absolute;
    left: 0;
    color: #c47070;
    font-size: 0.6rem;
  }
  .strength-criteria li.met { color: rgba(255,255,255,0.55); }
  .strength-criteria li.met::before { content: '✓'; color: #5a9e72; }

  /* ── Buttons ──────────────────────────────────────────────────────────── */
  .btn-primary {
    padding: 0.8rem;
    border: none; border-radius: 3rem;
    background: #527490; color: #09090b;
    font-family: 'DM Mono', monospace;
    font-size: 0.72rem; font-weight: 500; letter-spacing: 0.14em;
    cursor: pointer;
    transition: transform 0.12s, filter 0.12s, background 0.2s;
    margin-top: 0.25rem;
  }
  .btn-primary:hover:not(:disabled) { background: #7d9db6; }
  .btn-primary:active:not(:disabled) { transform: scale(0.96); filter: brightness(0.85); }
  .btn-primary:disabled { opacity: 0.35; cursor: not-allowed; }

  .btn-secondary {
    padding: 0.7rem;
    background: rgba(255, 255, 255, 0.06); color: #c2ccd5;
    border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 3rem;
    font-family: 'DM Mono', monospace;
    font-size: 0.7rem; letter-spacing: 0.1em;
    cursor: pointer; text-align: center;
    transition: background 0.2s, color 0.2s;
    width: 100%;
  }
  .btn-secondary:hover { background: rgba(255, 255, 255, 0.1); color: #e4e4e7; }

  /* ── Misc ─────────────────────────────────────────────────────────────── */
  .error {
    font-family: 'DM Mono', monospace;
    font-size: 0.82rem; color: #c47070;
    margin: 0; letter-spacing: 0.03em;
  }
  .info-msg {
    font-family: 'DM Mono', monospace;
    font-size: 0.8rem; color: #a4afbb;
    margin: 0; line-height: 1.5;
    padding: 0.6rem 0.75rem;
    border: 1px solid rgba(255,255,255,0.06);
    border-radius: 0.6rem;
    background: rgba(255,255,255,0.03);
  }

  .switch-hint {
    font-family: 'DM Mono', monospace;
    font-size: 0.78rem; color: rgba(255,255,255,0.22);
    margin: 0; text-align: center;
  }
  .switch-link {
    background: none; border: none; padding: 0;
    font-family: 'DM Mono', monospace;
    font-size: 0.78rem; color: #527490;
    cursor: pointer; transition: color 0.15s;
  }
  .switch-link:hover { color: #7d9db6; }

  .pending-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.9rem;
    padding: 1rem 0 0.5rem;
    text-align: center;
  }
  .pending-icon { opacity: 0.8; }
  .pending-text {
    font-family: 'DM Mono', monospace;
    font-size: 0.88rem; color: #8b96a6;
    line-height: 1.6; margin: 0;
  }
</style>

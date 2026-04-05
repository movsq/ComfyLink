<script>
  import { acceptTos, getTos } from '../lib/api.js';

  let { token, isCodeUser = false, onAccepted, onDeclined } = $props();

  let loading = $state(false);
  let error = $state('');
  let scrolledToBottom = $state(false);
  let lang = $state('en');
  let scrollEl;

  let tosHtml = $state(null); // { en: string, cz: string } once loaded

  $effect(() => {
    getTos()
      .then(data => { tosHtml = data; })
      .catch(() => { error = 'Failed to load terms — please reload and try again.'; });
  });

  $effect(() => {
    if (!scrollEl) return;
    // Reset to top on mount/lang change. Also check if content fits without scrolling.
    scrollEl.scrollTop = 0;
    scrolledToBottom = scrollEl.scrollHeight <= scrollEl.clientHeight + 4;
  });

  function handleScroll(e) {
    const el = e.currentTarget;
    scrolledToBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
  }

  async function handleAccept() {
    loading = true;
    error = '';
    try {
      // Code users have no server-side row — acceptance is session-local only.
      // The /auth/tos endpoint uses requireActive and would reject code JWTs.
      if (!isCodeUser) {
        await acceptTos(token);
      }
      onAccepted();
    } catch (err) {
      error = err.message;
    } finally {
      loading = false;
    }
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_noninteractive_element_interactions -->
<div class="backdrop" role="dialog" aria-modal="true" tabindex="-1">
  <div class="panel">
    <div class="handle"></div>

    <div class="header">
      <span class="title">{lang === 'en' ? 'TERMS OF SERVICE' : 'PODMÍNKY UŽÍVÁNÍ'}</span>
      <div class="lang-toggle">
        <button class="lang-btn" class:active={lang === 'en'} onclick={() => { lang = 'en'; scrolledToBottom = false; scrollEl?.scrollTo(0, 0); }}>EN</button>
        <span class="lang-sep">|</span>
        <button class="lang-btn" class:active={lang === 'cz'} onclick={() => { lang = 'cz'; scrolledToBottom = false; scrollEl?.scrollTo(0, 0); }}>CZ</button>
      </div>
    </div>

    <div class="terms-scroll" onscroll={handleScroll} bind:this={scrollEl}>
      {#if tosHtml}
        <!-- eslint-disable-next-line svelte/no-at-html-tags -->
        {@html tosHtml[lang]}
      {:else if !error}
        <p class="terms-text" style="opacity:0.45">Loading…</p>
      {/if}
    </div>

    {#if error}
      <p class="error">{error}</p>
    {/if}

    <div class="actions">
      <button class="btn-primary" onclick={handleAccept} disabled={loading || !scrolledToBottom}>
        {loading ? (lang === 'en' ? 'SAVING…' : 'UKLÁDÁM…') : (lang === 'en' ? 'I UNDERSTAND AND AGREE' : 'ROZUMÍM A SOUHLASÍM')}
      </button>
      <button class="btn-secondary" onclick={onDeclined} disabled={loading}>
        {lang === 'en' ? 'DECLINE' : 'ODMÍTNOUT'}
      </button>
    </div>
  </div>
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
    max-width: 440px;
    background: rgba(14, 14, 18, 0.96);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 1.25rem 1.25rem 0 0;
    padding: 0 1.75rem 1.75rem;
    backdrop-filter: blur(24px);
    display: flex;
    flex-direction: column;
    gap: 0.875rem;
    max-height: 90dvh;
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
    padding: 0.25rem 0 0;
  }
  .title {
    font-family: 'DM Mono', monospace;
    font-size: 0.65rem; letter-spacing: 0.22em; color: #527490;
  }

  .lang-toggle {
    display: flex; align-items: center; gap: 0.3rem;
  }
  .lang-sep {
    font-family: 'DM Mono', monospace;
    font-size: 0.6rem; color: rgba(255,255,255,0.15);
  }
  .lang-btn {
    background: none; border: none; padding: 0.1rem 0.2rem;
    font-family: 'DM Mono', monospace;
    font-size: 0.6rem; letter-spacing: 0.12em;
    color: rgba(255,255,255,0.3);
    cursor: pointer;
    transition: color 0.15s;
  }
  .lang-btn:hover { color: rgba(255,255,255,0.6); }
  .lang-btn.active { color: #527490; }

  .terms-scroll {
    overflow-y: auto;
    max-height: 50dvh;
    padding-right: 0.5rem;
    scrollbar-width: thin;
    scrollbar-color: rgba(82, 116, 144, 0.25) transparent;
  }

  .section-heading {
    font-family: 'DM Mono', monospace;
    font-size: 0.68rem; font-weight: 600;
    letter-spacing: 0.06em;
    color: #c2ccd5;
    margin: 1rem 0 0.25rem;
  }
  .section-heading:first-child { margin-top: 0; }

  .terms-text {
    font-family: 'DM Mono', monospace;
    font-size: 0.68rem; color: #8b96a6;
    line-height: 1.65; margin: 0 0 0.25rem;
  }
  .terms-text strong { color: #c2ccd5; }

  .error {
    font-family: 'DM Mono', monospace;
    font-size: 0.7rem; color: #d97a5a; margin: 0;
    text-align: center;
  }

  .actions {
    display: flex; flex-direction: column; gap: 0.6rem;
    padding-top: 0.25rem;
  }

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
    padding: 0.65rem 0.875rem;
    background: rgba(255, 255, 255, 0.06); color: #c2ccd5;
    border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 3rem;
    font-family: 'DM Mono', monospace;
    font-size: 0.68rem; letter-spacing: 0.08em;
    cursor: pointer; text-align: center;
    transition: transform 0.12s, background 0.2s, color 0.2s;
  }
  .btn-secondary:hover { background: rgba(255, 255, 255, 0.1); color: #e4e4e7; }
  .btn-secondary:active { transform: scale(0.95); }
  .btn-secondary:disabled { opacity: 0.4; cursor: not-allowed; }
</style>

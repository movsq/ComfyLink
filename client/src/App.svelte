<script>
  import Login from './components/Login.svelte';
  import Submit from './components/Submit.svelte';
  import Result from './components/Result.svelte';
  import Admin from './components/Admin.svelte';
  import VaultSetup from './components/VaultSetup.svelte';
  import VaultUnlock from './components/VaultUnlock.svelte';
  import VaultSettings from './components/VaultSettings.svelte';
  import Gallery from './components/Gallery.svelte';
  import TermsModal from './components/TermsModal.svelte';
  import DataNoticeModal from './components/DataNoticeModal.svelte';
  import { createPhoneWS } from './lib/ws.js';
  import { getVaultInfo, logoutToken, getConfig } from './lib/api.js';
  import { onDestroy } from 'svelte';

  function randomSeed() {
    return Math.floor(Math.random() * 2 ** 32);
  }

  // ── State ──────────────────────────────────────────────────────────────────
  // DEV bypass — Vite sets import.meta.env.DEV=true only during `npm run dev`.
  // The ternary dead-code-eliminates to the production value in every real build.
  const _DEV = import.meta.env.DEV;
  let token = $state(_DEV ? 'dev-token' : null);
  let user  = $state(_DEV ? { name: 'Dev', email: 'dev@local', status: 'active', isAdmin: false, type: 'code_user', tosAccepted: true } : null);
  let ws = $state(null);
  let view = $state(_DEV ? 'submit' : 'login');  // 'login' | 'submit'
  // Result stack — index 0 is frontmost (currently shown), others peek behind it
  let resultStack = $state([]); // [{ id, result, aesKey, promptSnippet, imageUrl }]
  // Dismissed results waiting 2 min before auto-expiring
  let dismissedResults = $state([]); // [{ id, result, aesKey, promptSnippet, imageUrl, expiresAt, timerId }]
  // Ticker for countdown displays
  let clockNow = $state(Date.now());
  let wsError = $state('');
  let wsState = $state('disconnected'); // connected | reconnecting | exhausted | connecting | auth_invalid | disconnected
  let wsFailedAttempts = $state(0);
  let wsEverConnected = $state(false);
  let sessionNotice = $state('');
  let submitInputSetter = null;
  let inputToast = $state('');
  let inputToastTimer = null;
  let codeUsesRemaining = $state(null); // null = not a code user or unlimited; 0 = depleted
  let userUsesRemaining = $state(null); // null = unlimited; number = remaining uses for Google user
  let showAdmin = $state(false);
  let showGallery = $state(false);
  let showTerms = $state(false);
  let termsViewOnly = $state(false);
  let showDataNotice = $state(false);
  let tosAccepted = $state(_DEV ? true : false);

  // Queue state
  let queueState = $state({ queue: [], activeJobId: null, avgDuration: 60 });
  /** Map<jobId, { aesKey: CryptoKey, promptSnippet: string }> */
  let pendingJobs = $state(new Map());

  // Vault state
  let vaultInfo = $state(null);       // null | { configured, hasBio, hasPw, ... }
  let masterKey = $state(null);       // CryptoKey when unlocked
  let showVaultSetup = $state(false);
  let showVaultUnlock = $state(false);
  let showVaultSettings = $state(false);
  let pendingVaultAction = $state(null); // callback after unlock
  let _pendingUnlockCancelCb = null;   // non-reactive, called if unlock dismissed without unlocking

  // Transition animation state
  let loginExiting = $state(false);

  // Feature flags from server config
  // null = not yet fetched (hides code button until confirmed to avoid flash on disabled deployments)
  let accessCodesEnabled = $state(null);
  let inviteRequired = $state(null); // null = loading

  // Seed + mode are owned here so they survive cycles
  let seed = $state(randomSeed());
  let seedMode = $state('randomize');

  // Derived
  // hasDbUser: true for account-based users (Google or email/password) — they have a DB identity, vault access, and server-side ToS
  let hasDbUser = $derived(user?.type === 'google' || user?.type === 'email');

  // Fetch server feature flags once on mount
  $effect(() => {
    getConfig().then(cfg => { accessCodesEnabled = cfg.accessCodesEnabled; inviteRequired = cfg.inviteRequired ?? true; });
  });

  // ── Cross-tab coordination ─────────────────────────────────────────────────
  // Lets sibling tabs know a job was submitted / completed so their queue UI
  // stays coherent. AES keys are deliberately NOT shared — they remain in the
  // tab that performed the ECDH exchange. Results will only arrive on the WS
  // that submitted the job, so decryption is always handled in the correct tab.
  let tabChannel = null;

  function initTabChannel() {
    if (typeof BroadcastChannel === 'undefined') return;
    tabChannel = new BroadcastChannel('klein_jobs');
    tabChannel.onmessage = ({ data }) => {
      if (!data?.type) return;
      if (data.type === 'job_pending') {
        // Another tab submitted a job — reflect it in pendingJobs without an aesKey
        // so the cancel button / queue display shows the right count.
        if (!pendingJobs.has(data.jobId)) {
          pendingJobs.set(data.jobId, { aesKey: null, promptText: data.promptText ?? '' });
          pendingJobs = new Map(pendingJobs);
        }
      } else if (data.type === 'job_done') {
        // Another tab's job finished — remove from our pending display.
        if (pendingJobs.has(data.jobId)) {
          pendingJobs.delete(data.jobId);
          pendingJobs = new Map(pendingJobs);
        }
      }
    };
  }

  function closeTabChannel() {
    tabChannel?.close();
    tabChannel = null;
  }

  onDestroy(() => closeTabChannel());

  // Tick clockNow every second for dismissed-card countdown
  $effect(() => {
    const id = setInterval(() => { clockNow = Date.now(); }, 1000);
    return () => clearInterval(id);
  });

  // ── Login ──────────────────────────────────────────────────────────────────
  function handleLogin(newToken, newUser) {
    loginExiting = true;
    sessionNotice = ''; // clear immediately so it's gone before exit animation completes

    setTimeout(() => {
      loginExiting = false;
      token = newToken;
      user = newUser;
      view = 'submit';
      sessionNotice = '';
      tosAccepted = !!newUser.tosAccepted;

      // Initialise quota for Google users from login response
      if (!newUser.type || newUser.type !== 'code_user') {
        userUsesRemaining = newUser.usesRemaining ?? null;
      }

      ws = createPhoneWS(token);
      wsState = ws.getConnectionState();
      wsFailedAttempts = 0;
      wsEverConnected = false;

      // Open cross-tab channel for job state sync
      closeTabChannel();
      initTabChannel();

    ws.on('queued', ({ jobId }) => {
      if (wsState === 'connected') wsError = ''; // only dismiss non-connection errors when actually connected
      console.log(`[app] Job queued: ${jobId}`);
    });

    ws.on('result', (msg) => {
      const entry = pendingJobs.get(msg.jobId);
      if (!entry) {
        console.log(`[app] Ignoring stale result for job ${msg.jobId}`);
        return;
      }
      if (!entry.aesKey) {
        // This tab/session does not have the ECDH key material for this job.
        pendingJobs.delete(msg.jobId);
        pendingJobs = new Map(pendingJobs);
        wsError = 'A finished job was recovered, but this tab cannot decrypt it.';
        return;
      }
      if (wsState === 'connected') wsError = '';
      // Append to END of stack (opens behind the currently-viewed result)
      resultStack = [...resultStack, {
        id: msg.jobId,
        result: msg,
        aesKey: entry.aesKey,
        promptSnippet: (entry.promptText ?? '').slice(0, 80),
        thumbnail: typeof msg.thumbnail === 'string' ? msg.thumbnail : null,
        imageUrl: null,
        expiresAt: Date.now() + 120_000, // 2-min shelf window starts now
      }];
      // Remove from pending
      pendingJobs.delete(msg.jobId);
      pendingJobs = new Map(pendingJobs); // trigger reactivity
      // Notify sibling tabs so they can remove this job from their display
      tabChannel?.postMessage({ type: 'job_done', jobId: msg.jobId });
    });

    ws.on('error', ({ message, jobId }) => {
      // Map internal error keys to user-friendly messages
      if (message === 'no_uses_remaining') {
        wsError = 'No uses remaining — contact an admin to get more.';
      } else if (message === 'tos_not_accepted') {
        showTerms = true;
      } else if (message === 'queue_full') {
        wsError = 'Queue is full (max 3 jobs) — wait for one to finish.';
      } else {
        wsError = message ?? 'Unknown error';
      }
      // Remove from pending if we have a jobId for it
      if (jobId && pendingJobs.has(jobId)) {
        pendingJobs.delete(jobId);
        pendingJobs = new Map(pendingJobs);
      }
    });

    ws.on('no_pc', () => {
      wsError = 'PC is not connected to the relay.';
    });

    ws.on('close', () => {
      wsError = wsState === 'exhausted'
        ? 'Reconnect failed. Tap Retry Connection to resume live updates.'
        : 'Connection lost — reconnecting...';
    });

    ws.on('open', () => {
      wsError = '';
    });

    ws.on('connection_state', ({ state, failedAttempts }) => {
      wsState = state;
      wsFailedAttempts = failedAttempts ?? 0;
      if (state === 'connected') {
        wsEverConnected = true;
        wsError = '';
      } else if (state === 'reconnecting' || state === 'connecting') {
        wsError = 'Connection lost — reconnecting...';
      } else if (state === 'exhausted') {
        wsError = 'Reconnect failed. Tap Retry Connection to resume live updates.';
      } else if (state === 'auth_invalid') {
        wsError = codeUsesRemaining === 0
          ? 'Your access code has no remaining uses.'
          : 'Session expired. Please sign in again.';
      }
    });

    ws.on('session_invalid', ({ reason }) => {
      if (reason === 'code_exhausted') return; // stay on submit screen; wsError set via connection_state
      forceRelogin(reason);
    });

    ws.on('queue_update', (msg) => {
      // The server sends per-job detail (queue, activeJobId) only to the owner socket.
      // Non-owner sockets receive aggregate-only data (queueSize, avgDuration).
      queueState = {
        queue: msg.queue ?? [],
        activeJobId: msg.activeJobId ?? null,
        avgDuration: msg.avgDuration ?? 60,
        queueSize: msg.queueSize ?? (msg.queue?.length ?? 0),
      };
    });

    ws.on('job_recovery', ({ jobs }) => {
      if (!Array.isArray(jobs) || jobs.length === 0) return;
      // Create placeholders for recovered jobs that originated before this socket.
      const next = new Map(pendingJobs);
      for (const job of jobs) {
        if (job?.jobId && !next.has(job.jobId)) {
          next.set(job.jobId, { aesKey: null, promptText: '' });
        }
      }
      pendingJobs = next;
    });

    ws.on('code_refreshed', () => {
      // Admin increased uses count — dismiss the stale "no remaining uses" error
      if (wsError) wsError = '';
    });

    ws.on('code_status', ({ usesRemaining }) => {
      codeUsesRemaining = usesRemaining; // null = unlimited
      // If admin restored uses, also dismiss any stale error banner
      if (usesRemaining === null || usesRemaining > 0) {
        if (wsError) wsError = '';
      }
    });

    ws.on('uses_updated', ({ usesRemaining }) => {
      userUsesRemaining = usesRemaining; // null = unlimited
      if (usesRemaining === null || usesRemaining > 0) {
        if (wsError) wsError = '';
      }
    });

    ws.on('reconnect_failed', () => {
      wsState = 'exhausted';
      wsError = 'Reconnect failed. Tap Retry Connection to resume live updates.';
    });

    // Check vault status for account-based users
    if (hasDbUser) {
      checkVault();
    }

    // Show terms modal if not yet accepted.
    // Code users: acceptance is session-local (resets on every reload / new session).
    // Google users: acceptance is persisted server-side.
    if (!tosAccepted) {
      showTerms = true;
    }

    }, 650);
  }

  async function checkVault() {
    try {
      vaultInfo = await getVaultInfo(token);
      if (vaultInfo && !vaultInfo.configured) {
        showVaultSetup = true;
      }
    } catch {
      vaultInfo = null;
    }
  }

  // ── Vault ──────────────────────────────────────────────────────────────────
  function handleVaultSetupComplete(key) {
    masterKey = key;
    showVaultSetup = false;
    _pendingUnlockCancelCb = null;
    checkVault(); // refresh info
  }

  function handleVaultUnlocked(key) {
    masterKey = key;
    showVaultUnlock = false;
    _pendingUnlockCancelCb = null;
    if (pendingVaultAction) {
      pendingVaultAction();
      pendingVaultAction = null;
    }
  }

  function handleVaultReset() {
    masterKey = null;
    showVaultUnlock = false;
    pendingVaultAction = null;
    _pendingUnlockCancelCb = null;
    checkVault();
  }

  async function requestVaultUnlock(onCancelled = null) {
    _pendingUnlockCancelCb = onCancelled;
    // If vaultInfo hasn't loaded yet, fetch it now before deciding which panel to show
    if (vaultInfo === null) {
      try {
        vaultInfo = await getVaultInfo(token);
      } catch {
        vaultInfo = null;
      }
    }
    if (!vaultInfo?.configured) {
      showVaultSetup = true;
      return;
    }
    showVaultUnlock = true;
  }

  function handleOpenGallery() {
    if (!masterKey) {
      pendingVaultAction = () => { showGallery = true; };
      requestVaultUnlock();
      return;
    }
    showGallery = true;
  }

  function handleOpenVaultSettings() {
    showVaultSettings = true;
  }

  /** Request a fresh Google ID token for step-up auth (vault rekey/delete). */
  function requestFreshGoogleToken() {
    return new Promise((resolve, reject) => {
      if (typeof google === 'undefined' || !google.accounts) {
        reject(new Error('Google Sign-In not available'));
        return;
      }
      google.accounts.id.initialize({
        client_id: import.meta.env.VITE_GOOGLE_CLIENT_ID,
        callback: (response) => {
          if (response.credential) {
            resolve(response.credential);
          } else {
            reject(new Error('Re-authentication cancelled'));
          }
        },
        auto_select: false,
      });
      google.accounts.id.prompt((notification) => {
        if (notification.isNotDisplayed() || notification.isSkippedMoment()) {
          reject(new Error('Please sign in with Google again to confirm this action'));
        }
      });
    });
  }

  // ── Submit ─────────────────────────────────────────────────────────────────
  function handleJobSubmitted({ aesKey, jobId, promptText, preview1, preview2 }) {
    pendingJobs.set(jobId, { aesKey, promptText, preview1, preview2 });
    pendingJobs = new Map(pendingJobs); // trigger reactivity
    // Notify sibling tabs (no aesKey — it stays in this tab only)
    tabChannel?.postMessage({ type: 'job_pending', jobId, promptText });
  }

  function handleJobCancelled({ jobId }) {
    if (jobId && pendingJobs.has(jobId)) {
      pendingJobs.delete(jobId);
      pendingJobs = new Map(pendingJobs);
    }
  }

  function registerSubmitInputSetter(setter) {
    submitInputSetter = typeof setter === 'function' ? setter : null;
  }

  function showInputToastMessage(message) {
    inputToast = message;
    if (inputToastTimer) clearTimeout(inputToastTimer);
    inputToastTimer = setTimeout(() => {
      inputToast = '';
      inputToastTimer = null;
    }, 1800);
  }

  async function handleUseAsInput({ slot, bytes, mime = 'image/png', filename = 'input.png' }) {
    if (!submitInputSetter || (slot !== 1 && slot !== 2) || !bytes) return false;
    try {
      const assigned = await submitInputSetter({ slot, bytes, mime, filename });
      if (assigned) showInputToastMessage(`Set as Input ${slot}`);
      return !!assigned;
    } catch {
      return false;
    }
  }

  // ── Modal close: dismiss front result to recovery shelf (remaining time of its 2-min window) ──
  function handleClose() {
    if (resultStack.length === 0) return;
    const item = resultStack[0];
    resultStack = resultStack.slice(1);
    const remaining = item.expiresAt - Date.now();
    if (remaining <= 0) {
      // Window already expired while modal was open — discard silently
      if (item.imageUrl) URL.revokeObjectURL(item.imageUrl);
      return;
    }
    const timerId = setTimeout(() => {
      const expiring = dismissedResults.find(d => d.id === item.id);
      if (expiring?.imageUrl) URL.revokeObjectURL(expiring.imageUrl);
      dismissedResults = dismissedResults.filter(d => d.id !== item.id);
    }, remaining);
    dismissedResults = [...dismissedResults, { ...item, timerId }];
  }

  // ── New Job: discard front result cleanly, advance seed ──────────────────────
  function handleDone() {
    if (seedMode === 'randomize') seed = randomSeed();
    else if (seedMode === 'increment') seed = seed + 1;
    else if (seedMode === 'decrement') seed = seed - 1;
    if (resultStack[0]?.imageUrl) URL.revokeObjectURL(resultStack[0].imageUrl);
    resultStack = resultStack.slice(1);
    wsError = '';
  }

  // Store decrypted imageUrl so dismissed cards can display the image
  function storeImageUrl(id, url) {
    resultStack = resultStack.map(item => item.id === id ? { ...item, imageUrl: url } : item);
    dismissedResults = dismissedResults.map(item => item.id === id ? { ...item, imageUrl: url } : item);
  }

  // Mark a result as saved so the flag survives close/reopen cycles
  function handleResultSaved(id) {
    resultStack = resultStack.map(item => item.id === id ? { ...item, saved: true } : item);
    dismissedResults = dismissedResults.map(item => item.id === id ? { ...item, saved: true } : item);
  }

  // Re-open a dismissed result: cancel its expiry timer and bring it to the front.
  // expiresAt is preserved so handleClose can compute remaining shelf time if closed again.
  function reopenDismissed(id) {
    const item = dismissedResults.find(d => d.id === id);
    if (!item) return;
    clearTimeout(item.timerId);
    dismissedResults = dismissedResults.filter(d => d.id !== id);
    const { timerId, ...entry } = item; // keep expiresAt
    resultStack = [entry, ...resultStack];
  }

  onDestroy(() => ws?.close());
  onDestroy(() => {
    if (inputToastTimer) clearTimeout(inputToastTimer);
  });

  function retryConnection() {
    ws?.reconnectNow?.();
  }

  function formatSessionReason(reason) {
    if (reason === 'token_expired') return 'Session expired while idle.';
    if (reason === 'code_expired') return 'Access code expired.';
    if (reason === 'code_exhausted') return 'Access code has no remaining uses.';
    if (reason === 'codes_disabled') return 'Access code login has been disabled. Please sign in with Google.';
    if (reason === 'no_uses_remaining') return 'No remaining uses on your account.';
    if (reason === 'account_suspended') return 'Account is no longer active.';
    if (reason === 'code_not_found') return 'Access code is no longer valid.';
    return 'Session expired. Please sign in again.';
  }

  function clearResultCards() {
    for (const item of resultStack) {
      if (item?.imageUrl) URL.revokeObjectURL(item.imageUrl);
    }
    for (const item of dismissedResults) {
      if (item?.timerId) clearTimeout(item.timerId);
      if (item?.imageUrl) URL.revokeObjectURL(item.imageUrl);
    }
    resultStack = [];
    dismissedResults = [];
  }

  function forceRelogin(reason) {
    const oldToken = token;
    clearResultCards();
    ws?.close?.();
    ws = null;
    token = null;
    user = null;
    view = 'login';
    wsError = '';
    wsState = 'disconnected';
    wsFailedAttempts = 0;
    wsEverConnected = false;
    sessionNotice = formatSessionReason(reason);
    queueState = { queue: [], activeJobId: null, avgDuration: 60 };
    pendingJobs = new Map();
    showAdmin = false;
    showGallery = false;
    showTerms = false;
    showVaultSetup = false;
    showVaultUnlock = false;
    showVaultSettings = false;
    vaultInfo = null;
    masterKey = null;
    pendingVaultAction = null;
    _pendingUnlockCancelCb = null;
    closeTabChannel();
    if (oldToken) logoutToken(oldToken);
  }
</script>

<div class="app">
  {#if !window.isSecureContext}
    <div class="secure-context-banner">
      <strong>⚠ Encryption unavailable</strong> —
      this app requires a secure context. Open it via <code>https://</code> or <code>http://localhost</code>,
      not a plain <code>http://</code> IP address. WebCrypto is blocked by your browser on insecure origins.
    </div>
  {/if}

  {#if (wsError || wsState === 'reconnecting' || wsState === 'exhausted') && view !== 'login'}
    <div class="ws-banner">
      <span>{wsError || (wsState === 'exhausted' ? 'Reconnect failed. Tap Retry Connection to resume live updates.' : 'Connection lost — reconnecting...')}</span>
      {#if wsState === 'exhausted'}
        <button type="button" class="ws-retry" onclick={retryConnection}>
          RETRY CONNECTION
        </button>
      {:else if wsState === 'reconnecting' || wsState === 'connecting'}
        <span class="ws-meta">Attempt {Math.max(1, wsFailedAttempts)}</span>
      {/if}
    </div>
  {/if}

  {#if view === 'login'}
    <Login onLogin={handleLogin} exiting={loginExiting} notice={sessionNotice} {accessCodesEnabled} inviteRequired={inviteRequired ?? true} />
  {:else if view === 'submit'}
    <Submit
      {token} {ws}
      onJobSubmitted={handleJobSubmitted}
      onCancel={handleJobCancelled}
      onRegisterInputSetter={registerSubmitInputSetter}
      bind:seed bind:seedMode
      onNewJob={handleDone}
      isAdmin={user?.isAdmin}
      onOpenAdmin={() => showAdmin = true}
      showGalleryBtn={hasDbUser && vaultInfo?.configured}
      onOpenGallery={handleOpenGallery}
      showVaultSettingsBtn={hasDbUser && vaultInfo?.configured}
      onOpenVaultSettings={handleOpenVaultSettings}
      {codeUsesRemaining}
      {userUsesRemaining}
      {queueState}
      {pendingJobs}
      {dismissedResults}
      {clockNow}
      wsConnected={wsState === 'connected'}
      wsInitializing={!wsEverConnected}
      onReopenDismissed={reopenDismissed}
    />
  {/if}

  {#if resultStack.length > 0}
    <!-- Render back-to-front: last in array = deepest, index 0 = topmost.
         We iterate reversed so index 0 is rendered last (highest DOM stacking order). -->
    {#each [...resultStack].reverse() as item, revI (item.id)}
      {@const forwardI = resultStack.length - 1 - revI}
      <Result
        result={item.result}
        aesKey={item.aesKey}
        onDone={handleDone}
        onClose={handleClose}
        onImageReady={(url) => storeImageUrl(item.id, url)}
        isGhost={forwardI > 0}
        stackOffset={forwardI}
        {token}
        {masterKey}
        userType={user?.type ?? 'google'}
        onRequestVaultUnlock={requestVaultUnlock}
        onUseAsInput={handleUseAsInput}
        initialSaved={item.saved ?? false}
        onSaved={() => handleResultSaved(item.id)}
        thumbnailB64={item.thumbnail ?? null}
      />
    {/each}
  {/if}

  {#if showAdmin && user?.isAdmin}
    <Admin {token} onClose={() => showAdmin = false} {accessCodesEnabled} />
  {/if}

  {#if showVaultSetup && hasDbUser}
    <VaultSetup
      {token}
      userEmail={user?.email ?? ''}
      onComplete={handleVaultSetupComplete}
      onSkip={() => { showVaultSetup = false; const cb = _pendingUnlockCancelCb; _pendingUnlockCancelCb = null; cb?.(); }}
    />
  {/if}

  {#if showVaultUnlock && vaultInfo?.configured}
    <VaultUnlock
      {token}
      {vaultInfo}
      onUnlocked={handleVaultUnlocked}
      onCancel={() => { showVaultUnlock = false; pendingVaultAction = null; const cb = _pendingUnlockCancelCb; _pendingUnlockCancelCb = null; cb?.(); }}
      onOpenSettings={() => { showVaultUnlock = false; pendingVaultAction = null; const cb = _pendingUnlockCancelCb; _pendingUnlockCancelCb = null; cb?.(); showVaultSettings = true; }}
    />
  {/if}

  {#if showVaultSettings && vaultInfo?.configured}
    <VaultSettings
      {token}
      {vaultInfo}
      {masterKey}
      userEmail={user?.email ?? ''}
      userType={user?.type}
      {requestFreshGoogleToken}
      onClose={() => showVaultSettings = false}
      onUpdated={() => { showVaultSettings = false; checkVault(); }}
      onRequestUnlock={() => { showVaultSettings = false; pendingVaultAction = () => { showVaultSettings = true; }; requestVaultUnlock(); }}
      onVaultReset={() => { showVaultSettings = false; handleVaultReset(); }}
    />
  {/if}

  {#if showGallery && masterKey}
    <Gallery
      {token}
      {masterKey}
      onClose={() => showGallery = false}
      onUseAsInput={handleUseAsInput}
    />
  {/if}

  {#if showTerms}
    <TermsModal
      {token}
      isCodeUser={user?.type === 'code_user'}
      viewOnly={termsViewOnly}
      onAccepted={() => { tosAccepted = true; showTerms = false; termsViewOnly = false; }}
      onDeclined={() => { showTerms = false; termsViewOnly = false; }}
    />
  {/if}

  {#if showDataNotice}
    <DataNoticeModal onClose={() => { showDataNotice = false; }} />
  {/if}

  <footer class="site-footer">
    <button class="footer-btn" onclick={() => { termsViewOnly = true; showTerms = true; }}>
      Terms of Service
    </button>
    <span class="footer-divider">|</span>
    <button class="footer-btn" onclick={() => { showDataNotice = true; }}>
      How we use your data
    </button>
  </footer>

  {#if inputToast}
    <div class="input-toast" role="status" aria-live="polite">{inputToast}</div>
  {/if}
</div>

<style>
  :global(*, *::before, *::after) {
    box-sizing: border-box;
  }

  :global(html, body) {
    overflow-x: hidden;
    overscroll-behavior-x: none;
  }

  :global(body) {
    margin: 0;
    font-family: 'Syne', system-ui, sans-serif;
    background: var(--surface-base);
    background-image:
      linear-gradient(var(--grid-line) 1px, transparent 1px),
      linear-gradient(90deg, var(--grid-line) 1px, transparent 1px);
    background-size: 48px 48px;
    color: var(--text-primary);
    line-height: 1.6;
    letter-spacing: 0.01em;
    -webkit-font-smoothing: antialiased;
  }

  /* Global scrollbar styling */
  :global(::-webkit-scrollbar) {
    width: 4px;
    height: 4px;
  }
  :global(::-webkit-scrollbar-track) {
    background: transparent;
  }
  :global(::-webkit-scrollbar-thumb) {
    background: var(--surface-hover);
    border-radius: 2px;
  }
  :global(::-webkit-scrollbar-thumb:hover) {
    background: var(--surface-active);
  }

  .app {
    min-height: 100dvh;
    touch-action: pan-y;
  }

  .secure-context-banner {
    background: #7f1d1d;
    border-bottom: 1px solid #b91c1c;
    color: #fca5a5;
    font-family: 'DM Mono', monospace;
    font-size: 0.72rem;
    letter-spacing: 0.04em;
    padding: 0.6rem 1.2rem;
    text-align: center;
    line-height: 1.6;
  }
  .secure-context-banner code {
    background: rgba(0,0,0,0.3);
    border-radius: 3px;
    padding: 0.05em 0.3em;
  }

  .ws-banner {
    background: var(--surface-hover);
    border-bottom: 1px solid var(--border-subtle);
    color: var(--state-warning);
    font-family: 'DM Mono', monospace;
    font-size: 0.72rem;
    letter-spacing: 0.06em;
    padding: 0.5rem 1rem;
    text-align: center;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.7rem;
  }

  .ws-retry {
    border: 1px solid var(--state-warning-border);
    background: var(--state-warning-bg);
    color: var(--state-warning);
    font-family: 'DM Mono', monospace;
    font-size: 0.65rem;
    letter-spacing: 0.07em;
    border-radius: 999px;
    padding: 0.24rem 0.58rem;
    cursor: pointer;
  }

  .ws-meta {
    color: var(--text-secondary);
    font-size: 0.64rem;
  }

  .input-toast {
    position: fixed;
    left: 50%;
    bottom: 1.5rem;
    transform: translateX(-50%);
    padding: 0.6rem 1.15rem;
    border-radius: 999px;
    border: 1px solid var(--accent-primary-border);
    background: var(--surface-overlay-glass);
    backdrop-filter: blur(28px) saturate(1.4);
    -webkit-backdrop-filter: blur(28px) saturate(1.4);
    color: var(--text-secondary);
    font-family: 'DM Mono', monospace;
    font-size: 0.68rem;
    letter-spacing: 0.1em;
    z-index: 220;
    box-shadow:
      0 8px 32px var(--shadow-panel),
      0 1px 0 var(--border-subtle) inset,
      0 0 0 1px var(--surface-hover) inset;
    pointer-events: none;
    white-space: nowrap;
    animation: toast-in 0.22s cubic-bezier(0.16, 1, 0.3, 1) both;
  }

  @keyframes toast-in {
    from { opacity: 0; transform: translateX(-50%) translateY(6px); }
    to   { opacity: 1; transform: translateX(-50%) translateY(0); }
  }

  .site-footer {
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    z-index: 50;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    padding: 0.3rem 1rem;
    background: var(--surface-raised-glass);
    backdrop-filter: blur(12px);
    border-top: 1px solid var(--border-subtle);
  }

  .footer-btn {
    background: none;
    border: none;
    padding: 0.15rem 0.2rem;
    font-family: 'DM Mono', monospace;
    font-size: 0.72rem;
    letter-spacing: 0.06em;
    color: var(--text-muted);
    cursor: pointer;
    transition: color 0.15s;
    line-height: 1;
  }
  .footer-btn:hover { color: var(--text-secondary); }

  .footer-divider {
    font-family: 'DM Mono', monospace;
    font-size: 0.72rem;
    color: var(--border-subtle);
    line-height: 1;
    user-select: none;
  }


</style>

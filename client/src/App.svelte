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
  import { createPhoneWS } from './lib/ws.js';
  import { getVaultInfo } from './lib/api.js';
  import { onDestroy } from 'svelte';

  function randomSeed() {
    return Math.floor(Math.random() * 2 ** 32);
  }

  // ── State ──────────────────────────────────────────────────────────────────
  let token = $state(null);
  let user = $state(null);       // { name, email, status, isAdmin, type }
  let ws = $state(null);
  let view = $state('login');        // 'login' | 'submit'
  // Result stack — index 0 is frontmost (currently shown), others peek behind it
  let resultStack = $state([]); // [{ id, result, aesKey, promptSnippet, imageUrl }]
  // Dismissed results waiting 2 min before auto-expiring
  let dismissedResults = $state([]); // [{ id, result, aesKey, promptSnippet, imageUrl, expiresAt, timerId }]
  // Ticker for countdown displays
  let clockNow = $state(Date.now());
  let wsError = $state('');
  let codeUsesRemaining = $state(null); // null = not a code user or unlimited; 0 = depleted
  let userUsesRemaining = $state(null); // null = unlimited; number = remaining uses for Google user
  let showAdmin = $state(false);
  let showGallery = $state(false);
  let showTerms = $state(false);
  let tosAccepted = $state(false);

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

  // Transition animation state
  let loginExiting = $state(false);

  // Seed + mode are owned here so they survive cycles
  let seed = $state(randomSeed());
  let seedMode = $state('randomize');

  // Derived
  let isGoogleUser = $derived(user?.type === 'google' || (user && !user.type));

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

    setTimeout(() => {
      loginExiting = false;
      token = newToken;
      user = newUser;
      view = 'submit';
      tosAccepted = !!newUser.tosAccepted;

      // Initialise quota for Google users from login response
      if (!newUser.type || newUser.type !== 'code_user') {
        userUsesRemaining = newUser.usesRemaining ?? null;
      }

      ws = createPhoneWS(token);

      // Open cross-tab channel for job state sync
      closeTabChannel();
      initTabChannel();

    ws.on('queued', ({ jobId }) => {
      wsError = ''; // server accepted the job — dismiss any stale error banner
      console.log(`[app] Job queued: ${jobId}`);
    });

    ws.on('result', (msg) => {
      const entry = pendingJobs.get(msg.jobId);
      if (!entry) {
        console.log(`[app] Ignoring stale result for job ${msg.jobId}`);
        return;
      }
      wsError = '';
      // Append to END of stack (opens behind the currently-viewed result)
      resultStack = [...resultStack, {
        id: msg.jobId,
        result: msg,
        aesKey: entry.aesKey,
        promptSnippet: (entry.promptText ?? '').slice(0, 80),
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
      wsError = 'Connection lost — reconnecting…';
    });

    ws.on('open', () => {
      wsError = '';
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
      ws.close();
      ws = null;
      token = null;
      user = null;
      // Cancel all dismissed timers and revoke object URLs
      dismissedResults.forEach(d => {
        clearTimeout(d.timerId);
        if (d.imageUrl) URL.revokeObjectURL(d.imageUrl);
      });
      resultStack.forEach(item => { if (item.imageUrl) URL.revokeObjectURL(item.imageUrl); });
      resultStack = [];
      dismissedResults = [];
      pendingJobs = new Map();
      queueState = { queue: [], activeJobId: null, avgDuration: 60 };
      wsError = '';
      showAdmin = false;
      showGallery = false;
      showTerms = false;
      tosAccepted = false;
      masterKey = null;
      vaultInfo = null;
      view = 'login';
    });

    // Check vault status for Google users
    if (isGoogleUser) {
      checkVault();
    }

    // Show terms modal if not yet accepted (Google users only)
    if (isGoogleUser && !tosAccepted) {
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
    checkVault(); // refresh info
  }

  function handleVaultUnlocked(key) {
    masterKey = key;
    showVaultUnlock = false;
    if (pendingVaultAction) {
      pendingVaultAction();
      pendingVaultAction = null;
    }
  }

  function handleVaultReset() {
    masterKey = null;
    showVaultUnlock = false;
    pendingVaultAction = null;
    checkVault();
  }

  async function requestVaultUnlock() {
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
</script>

<div class="app">
  {#if wsError && view !== 'login'}
    <div class="ws-banner">{wsError}</div>
  {/if}

  {#if view === 'login'}
    <Login onLogin={handleLogin} exiting={loginExiting} />
  {:else if view === 'submit'}
    <Submit
      {token} {ws}
      onJobSubmitted={handleJobSubmitted}
      onCancel={handleJobCancelled}
      bind:seed bind:seedMode
      onNewJob={handleDone}
      isAdmin={user?.isAdmin}
      onOpenAdmin={() => showAdmin = true}
      showGalleryBtn={isGoogleUser && vaultInfo?.configured}
      onOpenGallery={handleOpenGallery}
      showVaultSettingsBtn={isGoogleUser && vaultInfo?.configured}
      onOpenVaultSettings={handleOpenVaultSettings}
      {codeUsesRemaining}
      {userUsesRemaining}
      {queueState}
      {pendingJobs}
      {dismissedResults}
      {clockNow}
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
      />
    {/each}
  {/if}

  {#if showAdmin && user?.isAdmin}
    <Admin {token} onClose={() => showAdmin = false} />
  {/if}

  {#if showVaultSetup && isGoogleUser}
    <VaultSetup
      {token}
      userEmail={user?.email ?? ''}
      onComplete={handleVaultSetupComplete}
      onSkip={() => showVaultSetup = false}
    />
  {/if}

  {#if showVaultUnlock && vaultInfo?.configured}
    <VaultUnlock
      {token}
      {vaultInfo}
      onUnlocked={handleVaultUnlocked}
      onCancel={() => { showVaultUnlock = false; pendingVaultAction = null; }}
      onOpenSettings={() => { showVaultUnlock = false; pendingVaultAction = null; showVaultSettings = true; }}
    />
  {/if}

  {#if showVaultSettings && vaultInfo?.configured}
    <VaultSettings
      {token}
      {vaultInfo}
      {masterKey}
      userEmail={user?.email ?? ''}
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
    />
  {/if}

  {#if showTerms && isGoogleUser}
    <TermsModal
      {token}
      onAccepted={() => { tosAccepted = true; showTerms = false; }}
      onDeclined={() => { showTerms = true; }}
    />
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
    background: #09090b;
    background-image:
      linear-gradient(rgba(123, 156, 191, 0.07) 1px, transparent 1px),
      linear-gradient(90deg, rgba(123, 156, 191, 0.07) 1px, transparent 1px);
    background-size: 48px 48px;
    color: #e4e4e7;
    -webkit-font-smoothing: antialiased;
  }

  .app {
    min-height: 100dvh;
    touch-action: pan-y;
  }

  .ws-banner {
    background: rgba(255, 255, 255, 0.04);
    border-bottom: 1px solid rgba(255, 255, 255, 0.07);
    color: #c4996a;
    font-family: 'DM Mono', monospace;
    font-size: 0.72rem;
    letter-spacing: 0.06em;
    padding: 0.5rem 1rem;
    text-align: center;
  }



</style>

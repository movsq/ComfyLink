<script>
  import Login from './components/Login.svelte';
  import Submit from './components/Submit.svelte';
  import Result from './components/Result.svelte';
  import Admin from './components/Admin.svelte';
  import VaultSetup from './components/VaultSetup.svelte';
  import VaultUnlock from './components/VaultUnlock.svelte';
  import VaultSettings from './components/VaultSettings.svelte';
  import Gallery from './components/Gallery.svelte';
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
  let currentAesKey = $state(null);
  let currentJobId = $state(null);
  let currentResult = $state(null);
  let wsError = $state('');
  let codeUsesRemaining = $state(null); // null = not a code user or unlimited; 0 = depleted
  let userUsesRemaining = $state(null); // null = unlimited; number = remaining uses for Google user
  let showModal = $state(false);
  let showAdmin = $state(false);
  let showGallery = $state(false);

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

  // ── Login ──────────────────────────────────────────────────────────────────
  function handleLogin(newToken, newUser) {
    loginExiting = true;

    setTimeout(() => {
      loginExiting = false;
      token = newToken;
      user = newUser;
      view = 'submit';

      // Initialise quota for Google users from login response
      if (!newUser.type || newUser.type !== 'code_user') {
        userUsesRemaining = newUser.usesRemaining ?? null;
      }

      ws = createPhoneWS(token);

    ws.on('queued', ({ jobId }) => {
      currentJobId = jobId;
      wsError = ''; // server accepted the job — dismiss any stale error banner
      console.log(`[app] Job queued: ${jobId}`);
    });

    ws.on('result', (msg) => {
      if (!currentJobId || msg.jobId !== currentJobId) {
        console.log(`[app] Ignoring stale result for job ${msg.jobId}`);
        return;
      }      if (!currentAesKey) {
        console.log(`[app] Ignoring result — no AES key available (job ${msg.jobId})`);
        return;
      }      wsError = ''; // result arrived — any “PC not connected” banner is stale
      currentResult = msg;
      showModal = true;
    });

    ws.on('error', ({ message }) => {
      // Map internal error keys to user-friendly messages
      if (message === 'no_uses_remaining') {
        wsError = 'No uses remaining — contact an admin to get more.';
      } else {
        wsError = message ?? 'Unknown error';
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
      currentAesKey = null;
      currentJobId = null;
      currentResult = null;
      wsError = '';
      showModal = false;
      showAdmin = false;
      showGallery = false;
      masterKey = null;
      vaultInfo = null;
      view = 'login';
    });

    // Check vault status for Google users
    if (isGoogleUser) {
      checkVault();
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

  // ── Submit ─────────────────────────────────────────────────────────────────
  function handleJobSubmitted({ aesKey }) {
    currentAesKey = aesKey;
  }

  function handleJobCancelled() {
    currentJobId = null;
    currentAesKey = null;
  }

  // ── Modal close (keeps result for Preview button) ──────────────────────────
  function handleClose() {
    showModal = false;
  }

  // ── New Job (clears result entirely) ──────────────────────────────────────
  function handleDone() {
    if (seedMode === 'randomize') seed = randomSeed();
    else if (seedMode === 'increment') seed = seed + 1;
    else if (seedMode === 'decrement') seed = seed - 1;

    currentResult = null;
    currentAesKey = null;
    currentJobId = null;
    wsError = '';
    showModal = false;
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
      previewResult={currentResult}
      onPreview={() => showModal = true}
      onNewJob={handleDone}
      isAdmin={user?.isAdmin}
      onOpenAdmin={() => showAdmin = true}
      showGalleryBtn={isGoogleUser && vaultInfo?.configured}
      onOpenGallery={handleOpenGallery}
      showVaultSettingsBtn={isGoogleUser && vaultInfo?.configured}
      onOpenVaultSettings={handleOpenVaultSettings}
      {codeUsesRemaining}
      {userUsesRemaining}
    />
  {/if}

  {#if showModal && currentResult}
    <Result
      result={currentResult}
      aesKey={currentAesKey}
      onDone={handleDone}
      onClose={handleClose}
      {token}
      {masterKey}
      userType={user?.type ?? 'google'}
      onRequestVaultUnlock={requestVaultUnlock}
    />
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

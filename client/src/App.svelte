<script>
  import Login from './components/Login.svelte';
  import Submit from './components/Submit.svelte';
  import Result from './components/Result.svelte';
  import { createPhoneWS } from './lib/ws.js';
  import { onDestroy } from 'svelte';

  function randomSeed() {
    return Math.floor(Math.random() * 2 ** 32);
  }

  // ── State ──────────────────────────────────────────────────────────────────
  let token = $state(null);
  let ws = $state(null);
  let view = $state('login');        // 'login' | 'submit' | 'result'
  let currentAesKey = $state(null);
  let currentResult = $state(null);
  let wsError = $state('');

  // Seed + mode are owned here so they survive the submit → result → submit cycle
  let seed = $state(randomSeed());
  let seedMode = $state('randomize'); // 'randomize' | 'fixed' | 'increment' | 'decrement'

  // ── Login ──────────────────────────────────────────────────────────────────
  function handleLogin(newToken) {
    token = newToken;
    view = 'submit';

    ws = createPhoneWS(token);

    ws.on('queued', ({ jobId }) => {
      console.log(`[app] Job queued: ${jobId}`);
    });

    ws.on('result', (msg) => {
      currentResult = msg;
      view = 'result';
    });

    ws.on('error', ({ message }) => {
      wsError = message ?? 'Unknown error';
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
  }

  // ── Submit → Result ────────────────────────────────────────────────────────
  function handleJobSubmitted({ aesKey }) {
    currentAesKey = aesKey;
  }

  // ── Result → Submit ────────────────────────────────────────────────────────
  function handleDone() {
    // Apply seed mode before returning to submit view
    if (seedMode === 'randomize') seed = randomSeed();
    else if (seedMode === 'increment') seed = seed + 1;
    else if (seedMode === 'decrement') seed = seed - 1;
    // 'fixed': seed stays the same

    currentResult = null;
    currentAesKey = null;
    wsError = '';
    view = 'submit';
  }

  onDestroy(() => ws?.close());
</script>

<div class="app">
  {#if wsError && view !== 'login'}
    <div class="ws-banner">{wsError}</div>
  {/if}

  {#if view === 'login'}
    <Login onLogin={handleLogin} />
  {:else if view === 'submit' || (view === 'result' && !currentResult)}
    <Submit {token} {ws} onJobSubmitted={handleJobSubmitted} bind:seed bind:seedMode />
  {:else if view === 'result' && currentResult}
    <Result result={currentResult} aesKey={currentAesKey} onDone={handleDone} />
  {/if}
</div>

<style>
  :global(*, *::before, *::after) {
    box-sizing: border-box;
  }

  :global(body) {
    margin: 0;
    font-family: system-ui, -apple-system, sans-serif;
    background: #0f0f0f;
    color: #e5e5e5;
    -webkit-font-smoothing: antialiased;
  }

  .app {
    min-height: 100dvh;
  }

  .ws-banner {
    background: #1f1f1f;
    border-bottom: 1px solid #333;
    color: #f59e0b;
    font-size: 0.8rem;
    padding: 0.5rem 1rem;
    text-align: center;
  }
</style>

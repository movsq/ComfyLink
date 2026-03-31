<script>
  import { login } from '../lib/api.js';

  let { onLogin } = $props();

  let pin = $state('');
  let error = $state('');
  let loading = $state(false);

  async function handleSubmit(e) {
    e.preventDefault();
    error = '';
    loading = true;
    try {
      const token = await login(pin);
      onLogin(token);
    } catch (err) {
      error = err.message;
    } finally {
      loading = false;
    }
  }
</script>

<div class="login-bg">
  <form onsubmit={handleSubmit} class="login-card">
    <div class="brand">
      <span class="brand-title">ComfyLink</span>
      <span class="brand-sub">FLUX2 9B KLEIN &middot; REMOTE</span>
    </div>

    <input
      type="password"
      placeholder="Enter PIN"
      autocomplete="current-password"
      inputmode="numeric"
      bind:value={pin}
      disabled={loading}
      required
    />

    {#if error}
      <p class="error">{error}</p>
    {/if}

    <button type="submit" disabled={loading || !pin}>
      {loading ? 'VERIFYING…' : 'ACCESS'}
    </button>
  </form>
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
    max-width: 300px;
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 1.25rem;
    padding: 2rem 1.75rem;
    backdrop-filter: blur(16px);
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
    color: #f4f4f5;
    letter-spacing: -0.03em;
    line-height: 1;
  }

  .brand-sub {
    font-family: 'DM Mono', monospace;
    font-size: 0.65rem;
    letter-spacing: 0.18em;
    color: #7b9cbf;
    font-weight: 400;
  }

  input {
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
  }

  input::placeholder {
    color: #6c7585;
    letter-spacing: 0.05em;
  }

  input:focus {
    border-color: rgba(123, 156, 191, 0.5);
  }

  button {
    padding: 0.8rem 1.5rem;
    border: none;
    border-radius: 3rem;
    background: #7b9cbf;
    color: #09090b;
    font-family: 'DM Mono', monospace;
    font-size: 0.72rem;
    font-weight: 500;
    letter-spacing: 0.14em;
    cursor: pointer;
    transition: transform 0.12s ease, filter 0.12s ease, background 0.2s;
  }

  button:hover:not(:disabled) {
    background: #a3bdd4;
  }

  button:active:not(:disabled) {
    transform: scale(0.95);
    filter: brightness(0.85);
  }

  button:disabled {
    opacity: 0.35;
    cursor: not-allowed;
  }

  .error {
    font-family: 'DM Mono', monospace;
    color: #c47070;
    font-size: 0.75rem;
    margin: 0;
    letter-spacing: 0.03em;
  }

  @media (hover: none) and (pointer: coarse) {
    input { font-size: 16px !important; }
  }
</style>

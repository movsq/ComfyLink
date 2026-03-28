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

<div class="login-wrapper">
  <form onsubmit={handleSubmit} class="login-form">
    <h1>Flux2 9B Klein Remote</h1>
    <p class="subtitle">Enter your PIN to continue</p>

    <input
      type="password"
      placeholder="PIN"
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
      {loading ? 'Verifying…' : 'Login'}
    </button>
  </form>
</div>

<style>
  .login-wrapper {
    display: flex;
    justify-content: center;
    align-items: center;
    min-height: 100dvh;
    padding: 1rem;
    background: #0f0f0f;
  }

  .login-form {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    width: 100%;
    max-width: 320px;
  }

  h1 {
    margin: 0;
    font-size: 2rem;
    color: #fff;
    letter-spacing: 0.05em;
  }

  .subtitle {
    margin: 0;
    color: #888;
    font-size: 0.9rem;
  }

  input {
    padding: 0.75rem 1rem;
    border: 1px solid #333;
    border-radius: 8px;
    background: #1a1a1a;
    color: #fff;
    font-size: 1.1rem;
    outline: none;
    transition: border-color 0.2s;
  }

  input:focus {
    border-color: #666;
  }

  button {
    padding: 0.75rem;
    border: none;
    border-radius: 8px;
    background: #7c3aed;
    color: #fff;
    font-size: 1rem;
    cursor: pointer;
    transition: background 0.2s, opacity 0.2s;
  }

  button:hover:not(:disabled) {
    background: #6d28d9;
  }

  button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .error {
    color: #f87171;
    font-size: 0.875rem;
    margin: 0;
  }
</style>

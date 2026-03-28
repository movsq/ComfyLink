<script>
  import { decodeResultPayload, decryptPayload } from '../lib/crypto.js';

  let { result, aesKey, onDone } = $props();

  // result: { jobId, payload } — payload is base64 (iv + ciphertext)
  // aesKey: the AES-256-GCM CryptoKey derived during Submit

  let imageUrl = $state(null);
  let decryptError = $state('');
  let decrypting = $state(true);

  $effect(() => {
    if (!result || !aesKey) return;
    decrypt();
  });

  async function decrypt() {
    decrypting = true;
    decryptError = '';
    try {
      const { iv, ciphertext } = decodeResultPayload(result.payload);
      const plaintext = await decryptPayload(aesKey, iv, ciphertext);

      // Plaintext is raw image bytes (PNG/JPEG/WebP — whatever ComfyUI outputs)
      const blob = new Blob([plaintext], { type: 'image/png' });
      imageUrl = URL.createObjectURL(blob);
    } catch (err) {
      decryptError = `Decryption failed: ${err.message}`;
    } finally {
      decrypting = false;
    }
  }
</script>

<div class="result-wrapper">
  <h2>Result</h2>

  {#if decrypting}
    <p class="status">Decrypting…</p>
  {:else if decryptError}
    <p class="error">{decryptError}</p>
  {:else if imageUrl}
    <img src={imageUrl} alt="Generated result" class="result-image" />
    <div class="actions">
      <a href={imageUrl} download="result.png" class="btn-download">Download</a>
      <button onclick={onDone} class="btn-new">New Job</button>
    </div>
  {/if}
</div>

<style>
  .result-wrapper {
    padding: 1.25rem;
    max-width: 480px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  h2 {
    margin: 0;
    color: #fff;
    font-size: 1.25rem;
  }

  .status {
    color: #a78bfa;
    margin: 0;
  }

  .error {
    color: #f87171;
    font-size: 0.875rem;
    margin: 0;
  }

  .result-image {
    width: 100%;
    border-radius: 12px;
    border: 1px solid #333;
  }

  .actions {
    display: flex;
    gap: 0.75rem;
  }

  .btn-download,
  .btn-new {
    flex: 1;
    padding: 0.75rem;
    border: none;
    border-radius: 8px;
    font-size: 0.95rem;
    cursor: pointer;
    text-align: center;
    text-decoration: none;
    transition: background 0.2s;
  }

  .btn-download {
    background: #7c3aed;
    color: #fff;
  }

  .btn-download:hover {
    background: #6d28d9;
  }

  .btn-new {
    background: #333;
    color: #fff;
  }

  .btn-new:hover {
    background: #444;
  }
</style>

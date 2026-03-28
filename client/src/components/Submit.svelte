<script>
  import { getPCPublicKey } from '../lib/api.js';
  import {
    generateEphemeralKeyPair,
    importPcPublicKey,
    deriveAESKey,
    encryptPayload,
    exportEphemeralPublicKey,
    encodeJobPayload,
  } from '../lib/crypto.js';

  // seed + seedMode are $bindable so App.svelte owns and persists them
  let { token, ws, onJobSubmitted, seed = $bindable(), seedMode = $bindable() } = $props();

  // ── Per-form local state ────────────────────────────────────────────────────
  let imageFile1 = $state(null);
  let imagePreviewUrl1 = $state(null);
  let imageFile2 = $state(null);
  let imagePreviewUrl2 = $state(null);
  let prompt = $state('');
  let steps = $state(4);
  let sampler = $state('euler');
  let status = $state('idle'); // 'idle' | 'encrypting' | 'sent' | 'error'
  let error = $state('');

  // ── Progress state ──────────────────────────────────────────────────────────
  const SEGMENTS = 16;
  let progressValue = $state(0);
  let progressMax   = $state(1);
  let progressPhase = $state(1); // increments each time a sampler resets
  let _prevValue    = 0;         // internal — not reactive

  $effect(() => {
    if (!ws) return;
    const off = ws.on('progress', ({ value, max }) => {
      // Detect a new sampling phase: value dropped after reaching near-completion
      if (value < _prevValue && _prevValue >= progressMax * 0.9) {
        progressPhase += 1;
      }
      _prevValue    = value;
      progressValue = value;
      progressMax   = max > 0 ? max : 1;
    });
    return off; // cleanup when ws changes or component unmounts
  });

  function resetProgress() {
    progressValue = 0;
    progressMax   = 1;
    progressPhase = 1;
    _prevValue    = 0;
  }

  let phaseName = $derived(progressPhase === 1 ? 'SAMPLING' : progressPhase === 2 ? 'REFINING' : `PASS ${progressPhase}`);
  let pct = $derived(progressMax > 0 ? Math.round((progressValue / progressMax) * 100) : 0);
  let litCount = $derived(Math.round((progressValue / progressMax) * SEGMENTS));

  // ── Image slot helpers ──────────────────────────────────────────────────────
  function handleFileChange1(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (imagePreviewUrl1) URL.revokeObjectURL(imagePreviewUrl1);
    imageFile1 = file;
    imagePreviewUrl1 = URL.createObjectURL(file);
    e.target.value = '';
  }

  function handleFileChange2(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (imagePreviewUrl2) URL.revokeObjectURL(imagePreviewUrl2);
    imageFile2 = file;
    imagePreviewUrl2 = URL.createObjectURL(file);
    e.target.value = '';
  }

  function clearImage1() {
    if (imagePreviewUrl1) URL.revokeObjectURL(imagePreviewUrl1);
    imageFile1 = null;
    imagePreviewUrl1 = null;
  }

  function clearImage2() {
    if (imagePreviewUrl2) URL.revokeObjectURL(imagePreviewUrl2);
    imageFile2 = null;
    imagePreviewUrl2 = null;
  }

  // Avoids spread-operator stack overflow on large files
  async function fileToBase64(file) {
    if (!file) return null;
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }

  // ── Submit ──────────────────────────────────────────────────────────────────
  async function handleSubmit(e) {
    e.preventDefault();
    if (!prompt.trim()) return;
    error = '';
    status = 'encrypting';

    try {
      // 1. Fetch PC's public key
      const pcPubKeyB64 = await getPCPublicKey(token);
      const pcPublicKey = await importPcPublicKey(pcPubKeyB64);

      // 2. Generate per-job ephemeral keypair
      const ephKeyPair = await generateEphemeralKeyPair();

      // 3. Derive shared AES key via ECDH + HKDF
      const aesKey = await deriveAESKey(ephKeyPair.privateKey, pcPublicKey);

      // 4. Build plaintext: JSON with prompt, both images (null if not selected),
      //    and generation parameters
      const image1B64 = await fileToBase64(imageFile1);
      const image2B64 = await fileToBase64(imageFile2);
      const plaintext = new TextEncoder().encode(
        JSON.stringify({
          prompt: prompt.trim(),
          image1: image1B64,
          image2: image2B64,
          seed,
          steps,
          sampler,
        }),
      );

      // 5. Encrypt
      const { iv, ciphertext } = await encryptPayload(aesKey, plaintext);

      // 6. Export ephemeral public key so PC can derive the same AES key
      const ephPubKeyBytes = await exportEphemeralPublicKey(ephKeyPair.publicKey);

      // 7. Pack into wire format
      const payload = encodeJobPayload(ephPubKeyBytes, iv, ciphertext);

      // 8. Send via WebSocket relay
      const sent = ws.send({ type: 'submit', payload });
      if (!sent) throw new Error('WebSocket is not connected');

      status = 'sent';
      onJobSubmitted({ aesKey });
    } catch (err) {
      error = err.message;
      status = 'error';
    }
  }

  function reset() {
    clearImage1();
    clearImage2();
    prompt = '';
    status = 'idle';
    error = '';
    resetProgress();
    // seed/seedMode/steps/sampler persist intentionally
  }
</script>

<div class="submit-wrapper">
  {#if status === 'sent'}
    <div class="sent-state">
      <!-- ── System status header ─────────────────────────────────────── -->
      <div class="telemetry-header">
        <span class="sys-label">SYSTEM STATUS</span>
        {#if progressValue > 0}
          <span class="telemetry-tag">[ {phaseName}: {pct}% ]</span>
        {:else}
          <span class="telemetry-tag">[ QUEUED ]</span>
        {/if}
      </div>

      <!-- ── Segmented progress bar ──────────────────────────────────── -->
      <div class="seg-bar" role="progressbar" aria-valuenow={pct} aria-valuemin="0" aria-valuemax="100">
        {#each { length: SEGMENTS } as _, i}
          <div class="seg" class:seg-on={i < litCount}></div>
        {/each}
      </div>

      <button onclick={reset} class="btn-secondary">Submit another</button>
    </div>
  {:else}
    <form onsubmit={handleSubmit} class="submit-form">
      <h2>New Job</h2>

      <!-- ── Image slots ─────────────────────────────────────────────────── -->
      <div class="img-slots">
        <!-- Image 1 -->
        <div class="img-slot">
          <span class="slot-title">Image 1</span>
          <label class="img-label">
            {#if imagePreviewUrl1}
              <img src={imagePreviewUrl1} alt="Slot 1 preview" class="preview" />
            {:else}
              <div class="drop-zone">
                <span>Tap to select</span>
              </div>
            {/if}
            <input
              type="file"
              accept="image/*"
              onchange={handleFileChange1}
              class="hidden-input"
              disabled={status === 'encrypting'}
            />
          </label>
          {#if imageFile1}
            <button type="button" class="btn-clear" onclick={clearImage1}>✕ Remove</button>
          {/if}
        </div>

        <!-- Image 2 -->
        <div class="img-slot">
          <span class="slot-title">Image 2</span>
          <label class="img-label">
            {#if imagePreviewUrl2}
              <img src={imagePreviewUrl2} alt="Slot 2 preview" class="preview" />
            {:else}
              <div class="drop-zone">
                <span>Tap to select</span>
              </div>
            {/if}
            <input
              type="file"
              accept="image/*"
              onchange={handleFileChange2}
              class="hidden-input"
              disabled={status === 'encrypting'}
            />
          </label>
          {#if imageFile2}
            <button type="button" class="btn-clear" onclick={clearImage2}>✕ Remove</button>
          {/if}
        </div>
      </div>

      <!-- ── Prompt ─────────────────────────────────────────────────────── -->
      <textarea
        placeholder="Prompt…"
        bind:value={prompt}
        rows="4"
        disabled={status === 'encrypting'}
      ></textarea>

      <!-- ── Seed + seed mode ───────────────────────────────────────────── -->
      <div class="param-row">
        <div class="param-field">
          <label for="seed-input">Seed</label>
          <input
            id="seed-input"
            type="number"
            min="0"
            step="1"
            bind:value={seed}
            disabled={status === 'encrypting'}
          />
        </div>
        <div class="param-field">
          <label for="seed-mode">After generation</label>
          <select id="seed-mode" bind:value={seedMode} disabled={status === 'encrypting'}>
            <option value="randomize">Randomize</option>
            <option value="fixed">Fixed</option>
            <option value="increment">Increment (+1)</option>
            <option value="decrement">Decrement (−1)</option>
          </select>
        </div>
      </div>

      <!-- ── Steps + sampler ───────────────────────────────────────────── -->
      <div class="param-row">
        <div class="param-field">
          <label for="steps-input">Steps (1–8)</label>
          <input
            id="steps-input"
            type="number"
            min="1"
            max="8"
            step="1"
            bind:value={steps}
            disabled={status === 'encrypting'}
          />
        </div>
        <div class="param-field">
          <label for="sampler-input">Sampler</label>
          <select id="sampler-input" bind:value={sampler} disabled={status === 'encrypting'}>
            <option value="euler">Euler</option>
            <option value="res_multistep">Res Multistep</option>
            <option value="heun">Heun</option>
          </select>
        </div>
      </div>

      {#if error}
        <p class="error">{error}</p>
      {/if}

      <button type="submit" disabled={!prompt.trim() || status === 'encrypting'}>
        {status === 'encrypting' ? 'Encrypting…' : 'Send'}
      </button>
    </form>
  {/if}
</div>

<style>
  .submit-wrapper {
    padding: 1.25rem;
    max-width: 480px;
    margin: 0 auto;
  }

  .submit-form {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  h2 {
    margin: 0;
    color: #fff;
    font-size: 1.25rem;
  }

  /* ── Image slots ──────────────────────────────────────────────────────── */
  .img-slots {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.75rem;
  }

  .img-slot {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }

  .slot-title {
    font-size: 0.78rem;
    color: #888;
    font-weight: 500;
    letter-spacing: 0.03em;
  }

  .img-label {
    cursor: pointer;
    display: block;
  }

  .drop-zone {
    display: flex;
    align-items: center;
    justify-content: center;
    border: 2px dashed #333;
    border-radius: 10px;
    height: 130px;
    color: #555;
    font-size: 0.82rem;
    transition: border-color 0.2s;
  }

  .drop-zone:hover {
    border-color: #555;
  }

  .preview {
    width: 100%;
    height: 130px;
    object-fit: cover;
    border-radius: 10px;
    border: 1px solid #333;
    display: block;
  }

  .hidden-input {
    display: none;
  }

  .btn-clear {
    padding: 0.3rem 0.6rem;
    border: 1px solid #444;
    border-radius: 6px;
    background: transparent;
    color: #888;
    font-size: 0.75rem;
    cursor: pointer;
    transition: color 0.2s, border-color 0.2s;
    align-self: flex-start;
  }

  .btn-clear:hover {
    color: #f87171;
    border-color: #f87171;
  }

  /* ── Prompt ───────────────────────────────────────────────────────────── */
  textarea {
    padding: 0.75rem 1rem;
    border: 1px solid #333;
    border-radius: 8px;
    background: #1a1a1a;
    color: #fff;
    font-size: 0.95rem;
    resize: vertical;
    outline: none;
    font-family: inherit;
    transition: border-color 0.2s;
  }

  textarea:focus {
    border-color: #666;
  }

  /* ── Parameter rows ───────────────────────────────────────────────────── */
  .param-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.75rem;
  }

  .param-field {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }

  .param-field label {
    font-size: 0.78rem;
    color: #888;
    font-weight: 500;
    letter-spacing: 0.03em;
  }

  .param-field input,
  .param-field select {
    padding: 0.5rem 0.75rem;
    border: 1px solid #333;
    border-radius: 8px;
    background: #1a1a1a;
    color: #fff;
    font-size: 0.9rem;
    outline: none;
    transition: border-color 0.2s;
    width: 100%;
    box-sizing: border-box;
  }

  .param-field input:focus,
  .param-field select:focus {
    border-color: #666;
  }

  .param-field input:disabled,
  .param-field select:disabled {
    opacity: 0.5;
  }

  /* ── Submit button ────────────────────────────────────────────────────── */
  button[type='submit'] {
    padding: 0.75rem;
    border: none;
    border-radius: 8px;
    background: #7c3aed;
    color: #fff;
    font-size: 1rem;
    cursor: pointer;
    transition: background 0.2s, opacity 0.2s;
  }

  button[type='submit']:hover:not(:disabled) {
    background: #6d28d9;
  }

  button[type='submit']:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* ── Misc ─────────────────────────────────────────────────────────────── */
  .error {
    color: #f87171;
    font-size: 0.875rem;
    margin: 0;
  }

  .sent-state {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    align-items: flex-start;
    padding-top: 1rem;
  }

  /* ── Telemetry header ─────────────────────────────────────────────────── */
  .telemetry-header {
    display: flex;
    align-items: baseline;
    gap: 0.75rem;
    flex-wrap: wrap;
  }

  .sys-label {
    font-size: 0.72rem;
    font-weight: 700;
    letter-spacing: 0.12em;
    color: #555;
    text-transform: uppercase;
  }

  .telemetry-tag {
    font-size: 0.78rem;
    font-family: 'Courier New', Courier, monospace;
    font-weight: 700;
    color: #f97316;
    letter-spacing: 0.06em;
  }

  /* ── Segmented bar ────────────────────────────────────────────────────── */
  .seg-bar {
    display: flex;
    gap: 3px;
    width: 100%;
  }

  .seg {
    flex: 1;
    height: 18px;
    border-radius: 2px;
    background: #1e1e1e;
    border: 1px solid #2e2e2e;
    transition: background 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease;
  }

  .seg-on {
    background: #f97316;
    border-color: #fb923c;
    box-shadow: 0 0 6px #f9731688;
  }

  .btn-secondary {
    padding: 0.65rem 1.25rem;
    border: none;
    border-radius: 8px;
    background: #333;
    color: #fff;
    font-size: 0.95rem;
    cursor: pointer;
    transition: background 0.2s;
  }

  .btn-secondary:hover {
    background: #444;
  }
</style>

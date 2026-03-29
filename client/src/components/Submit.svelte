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

  let { token, ws, onJobSubmitted, seed = $bindable(), seedMode = $bindable(), previewResult, onPreview, onNewJob } = $props();

  // ── Per-form local state ──────────────────────────────────────────────
  let imageFile1 = $state(null);
  let imagePreviewUrl1 = $state(null);
  let imageFile2 = $state(null);
  let imagePreviewUrl2 = $state(null);
  let prompt = $state('');
  let steps = $state(4);
  let sampler = $state('euler');
  let status = $state('idle'); // 'idle' | 'encrypting' | 'sent' | 'error'
  let error = $state('');
  let currentJobId = $state(null);
  let _timeoutId = null;

  // ── Dropdown open state ───────────────────────────────────────────────
  let seedModeOpen = $state(false);
  let samplerOpen = $state(false);

  const seedModeOptions = [
    { value: 'randomize', label: 'Randomize' },
    { value: 'fixed', label: 'Fixed' },
    { value: 'increment', label: 'Increment +1' },
    { value: 'decrement', label: 'Decrement -1' },
  ];
  const samplerOptions = [
    { value: 'euler', label: 'Euler' },
    { value: 'res_multistep', label: 'Res Multistep' },
    { value: 'heun', label: 'Heun' },
  ];

  let seedModeLabel = $derived(seedModeOptions.find(o => o.value === seedMode)?.label ?? seedMode);
  let samplerLabel = $derived(samplerOptions.find(o => o.value === sampler)?.label ?? sampler);

  // Click-outside action for dropdowns
  function clickOutside(node, callback) {
    const handle = (e) => { if (!node.contains(e.target)) callback(); };
    document.addEventListener('pointerdown', handle, true);
    return { destroy() { document.removeEventListener('pointerdown', handle, true); } };
  }

  // ── Progress state ────────────────────────────────────────────────────
  let progressValue = $state(0);
  let progressMax   = $state(1);
  let progressPhase = $state(1);
  let _prevValue    = 0;

  $effect(() => {
    if (!ws) return;
    const offs = [];

    offs.push(ws.on('progress', ({ jobId, value, max }) => {
      if (currentJobId && jobId !== currentJobId) return;
      if (value < _prevValue && _prevValue >= progressMax * 0.9) progressPhase += 1;
      _prevValue    = value;
      progressValue = value;
      progressMax   = max > 0 ? max : 1;
    }));

    offs.push(ws.on('queued', ({ jobId }) => {
      currentJobId = jobId;
    }));

    offs.push(ws.on('error', () => {
      if (status === 'sent') reset();
    }));

    offs.push(ws.on('no_pc', () => {
      if (status === 'sent') reset();
    }));

    offs.push(ws.on('close', () => {
      if (status === 'sent') reset();
    }));

    return () => offs.forEach(off => off());
  });

  function resetProgress() {
    progressValue = 0;
    progressMax   = 1;
    progressPhase = 1;
    _prevValue    = 0;
  }

  let pct = $derived(progressMax > 0 ? Math.round((progressValue / progressMax) * 100) : 0);

  // ── Auto-reset when App clears the result (New Job from modal) ────────
  let _hadResult = false;
  $effect(() => {
    if (previewResult) { _hadResult = true; }
    if (!previewResult && _hadResult && status === 'sent') {
      reset();
      _hadResult = false;
    }
  });

  // ── Image helpers ─────────────────────────────────────────────────────
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
    imageFile1 = null; imagePreviewUrl1 = null;
  }
  function clearImage2() {
    if (imagePreviewUrl2) URL.revokeObjectURL(imagePreviewUrl2);
    imageFile2 = null; imagePreviewUrl2 = null;
  }

  async function fileToBase64(file) {
    if (!file) return null;
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }

  // ── Submit ────────────────────────────────────────────────────────────
  async function handleSubmit(e) {
    e.preventDefault();
    if (!prompt.trim() || status === 'sent') return;
    error = '';
    status = 'encrypting';
    try {
      const pcPubKeyB64  = await getPCPublicKey(token);
      const pcPublicKey  = await importPcPublicKey(pcPubKeyB64);
      const ephKeyPair   = await generateEphemeralKeyPair();
      const aesKey       = await deriveAESKey(ephKeyPair.privateKey, pcPublicKey);
      const image1B64    = await fileToBase64(imageFile1);
      const image2B64    = await fileToBase64(imageFile2);
      const plaintext    = new TextEncoder().encode(JSON.stringify({ prompt: prompt.trim(), image1: image1B64, image2: image2B64, seed, steps, sampler }));
      const { iv, ciphertext } = await encryptPayload(aesKey, plaintext);
      const ephPubKeyBytes = await exportEphemeralPublicKey(ephKeyPair.publicKey);
      const payload = encodeJobPayload(ephPubKeyBytes, iv, ciphertext);
      const sent = ws.send({ type: 'submit', payload });
      if (!sent) throw new Error('WebSocket is not connected');
      status = 'sent';
      onJobSubmitted({ aesKey });
      clearTimeout(_timeoutId);
      _timeoutId = setTimeout(() => {
        if (status === 'sent') {
          error = 'Generation timed out — please try again';
          reset();
        }
      }, 120_000);
    } catch (err) {
      error = err.message;
      status = 'error';
    }
  }

  function handleCancel() {
    ws.send({ type: 'cancel', jobId: currentJobId });
    reset();
  }

  function reset() {
    status = 'idle';
    error = '';
    currentJobId = null;
    clearTimeout(_timeoutId);
    _timeoutId = null;
    resetProgress();
  }
</script>

<div class="page">
  <div class="card">
    <form onsubmit={handleSubmit} class="form">
      <div class="form-header">
        <span class="form-title">ComfyLink</span>
        <span class="form-sub">FLUX2 9B KLEIN &middot; REMOTE</span>
      </div>

      <!-- Images -->
      <div class="img-slots">
        <div class="img-slot">
          <span class="field-label">IMAGE 1</span>
          <label class="img-label">
            {#if imagePreviewUrl1}
              <img src={imagePreviewUrl1} alt="Slot 1 preview" class="img-preview" />
            {:else}
              <div class="drop-zone">+ SELECT</div>
            {/if}
            <input type="file" accept="image/*" onchange={handleFileChange1} class="hidden-input" />
          </label>
          {#if imageFile1}
            <button type="button" class="btn-clear" onclick={clearImage1}>&times; Remove</button>
          {/if}
        </div>

        <div class="img-slot">
          <span class="field-label">IMAGE 2</span>
          <label class="img-label">
            {#if imagePreviewUrl2}
              <img src={imagePreviewUrl2} alt="Slot 2 preview" class="img-preview" />
            {:else}
              <div class="drop-zone">+ SELECT</div>
            {/if}
            <input type="file" accept="image/*" onchange={handleFileChange2} class="hidden-input" />
          </label>
          {#if imageFile2}
            <button type="button" class="btn-clear" onclick={clearImage2}>&times; Remove</button>
          {/if}
        </div>
      </div>

      <!-- Prompt -->
      <div class="field">
        <label class="field-label" for="prompt-input">PROMPT</label>
        <textarea
          id="prompt-input"
          placeholder="Describe your image..."
          bind:value={prompt}
          rows="4"
          spellcheck="false"
        ></textarea>
      </div>

      <!-- Seed + After generation -->
      <div class="param-row">
        <div class="param-field">
          <label class="field-label" for="seed-input">SEED</label>
          <input
            id="seed-input"
            type="number"
            min="0"
            step="1"
            bind:value={seed}
          />
        </div>
        <div class="param-field">
          <span class="field-label">AFTER GEN</span>
          <div class="custom-select" use:clickOutside={() => seedModeOpen = false}>
            <button
              type="button"
              class="select-trigger"
              class:open={seedModeOpen}
              onclick={() => seedModeOpen = !seedModeOpen}
            >
              <span>{seedModeLabel}</span>
              <span class="chevron"><svg width="10" height="6" viewBox="0 0 10 6" fill="none"><path d="M1 1l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
            </button>
            <div class="select-list" class:visible={seedModeOpen}>
              {#each seedModeOptions as opt}
                <button
                  type="button"
                  class="select-option"
                  class:active={seedMode === opt.value}
                  onclick={() => { seedMode = opt.value; seedModeOpen = false; }}
                >{opt.label}</button>
              {/each}
            </div>
          </div>
        </div>
      </div>

      <!-- Steps + Sampler -->
      <div class="param-row">
        <div class="param-field">
          <label class="field-label" for="steps-input">STEPS (1-8)</label>
          <input
            id="steps-input"
            type="number"
            min="1"
            max="8"
            step="1"
            bind:value={steps}
          />
        </div>
        <div class="param-field">
          <span class="field-label">SAMPLER</span>
          <div class="custom-select" use:clickOutside={() => samplerOpen = false}>
            <button
              type="button"
              class="select-trigger"
              class:open={samplerOpen}
              onclick={() => samplerOpen = !samplerOpen}
            >
              <span>{samplerLabel}</span>
              <span class="chevron"><svg width="10" height="6" viewBox="0 0 10 6" fill="none"><path d="M1 1l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
            </button>
            <div class="select-list" class:visible={samplerOpen}>
              {#each samplerOptions as opt}
                <button
                  type="button"
                  class="select-option"
                  class:active={sampler === opt.value}
                  onclick={() => { sampler = opt.value; samplerOpen = false; }}
                >{opt.label}</button>
              {/each}
            </div>
          </div>
        </div>
      </div>

      {#if error}
        <p class="error">{error}</p>
      {/if}

      <!-- Generate row -->
      <div class="generate-row">
        {#if status === 'sent' && previewResult}
          <button type="button" class="btn-generate view-result" onclick={onPreview}>
            VIEW RESULT
          </button>
          <button type="button" class="btn-generate btn-new-job" onclick={onNewJob}>
            NEW JOB
          </button>
        {:else if status === 'sent'}
          <button
            type="button"
            class="btn-generate generating"
            disabled
            style:--progress="{pct}%"
          >
            GENERATING
          </button>
          <button type="button" class="btn-cancel-icon" onclick={handleCancel} aria-label="Cancel generation">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
          </button>
        {:else}
          <button type="submit" class="btn-generate" disabled={!prompt.trim() || status === 'encrypting'}>
            {status === 'encrypting' ? 'ENCRYPTING...' : 'GENERATE'}
          </button>
        {/if}
      </div>
    </form>
  </div>
</div>

<style>
  /* ── Page shell ──────────────────────────────────────────────────────── */
  .page {
    min-height: 100dvh;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding: 2rem 1.25rem;
  }

  .card {
    width: 100%;
    max-width: 440px;
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 1.25rem;
    padding: 1.75rem;
    backdrop-filter: blur(12px);
  }

  /* ── Form ──────────────────────────────────────────────────────────── */
  .form {
    display: flex;
    flex-direction: column;
    gap: 1.1rem;
  }

  .form-header {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    margin-bottom: 0.2rem;
  }

  .form-title {
    font-family: 'Syne', sans-serif;
    font-size: 1.6rem;
    font-weight: 800;
    color: #f4f4f5;
    letter-spacing: -0.02em;
    line-height: 1;
  }

  .form-sub {
    font-family: 'DM Mono', monospace;
    font-size: 0.62rem;
    letter-spacing: 0.2em;
    color: #7b9cbf;
  }

  /* ── Field label ───────────────────────────────────────────────────── */
  .field-label {
    display: block;
    font-family: 'DM Mono', monospace;
    font-size: 0.6rem;
    letter-spacing: 0.18em;
    color: #52525b;
    margin-bottom: 0.35rem;
  }

  .field {
    display: flex;
    flex-direction: column;
  }

  /* ── Image slots ───────────────────────────────────────────────────── */
  .img-slots {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.75rem;
  }

  .img-slot {
    display: flex;
    flex-direction: column;
  }

  .img-label {
    cursor: pointer;
    display: block;
    touch-action: manipulation;
  }

  .drop-zone {
    display: flex;
    align-items: center;
    justify-content: center;
    border: 1px dashed rgba(255, 255, 255, 0.12);
    border-radius: 0.75rem;
    height: 120px;
    background: rgba(255, 255, 255, 0.02);
    color: #3f3f46;
    font-family: 'DM Mono', monospace;
    font-size: 0.68rem;
    letter-spacing: 0.12em;
    transition: border-color 0.2s, color 0.2s, background 0.2s;
  }

  .img-label:hover .drop-zone {
    border-color: rgba(123, 156, 191, 0.4);
    color: #7b9cbf;
    background: rgba(123, 156, 191, 0.04);
  }

  .img-preview {
    width: 100%;
    height: 120px;
    object-fit: cover;
    border-radius: 0.75rem;
    border: 1px solid rgba(255, 255, 255, 0.08);
    display: block;
  }

  .hidden-input { display: none; }

  .btn-clear {
    margin-top: 0.3rem;
    padding: 0.25rem 0.5rem;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 0.375rem;
    background: transparent;
    color: #52525b;
    font-family: 'DM Mono', monospace;
    font-size: 0.65rem;
    cursor: pointer;
    align-self: flex-start;
    letter-spacing: 0.04em;
    transition: color 0.2s, border-color 0.2s, transform 0.12s ease, filter 0.12s ease;
  }

  .btn-clear:hover { color: #c47070; border-color: rgba(196, 112, 112, 0.4); }
  .btn-clear:active { transform: scale(0.93); filter: brightness(0.85); }

  /* ── Inputs / textarea ──────────────────────────────────────────────── */
  textarea,
  input[type='number'] {
    padding: 0.65rem 0.875rem;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 0.75rem;
    background: rgba(255, 255, 255, 0.05);
    color: #e4e4e7;
    font-family: 'DM Mono', monospace;
    font-size: 0.85rem;
    outline: none;
    width: 100%;
    transition: border-color 0.2s;
  }

  input[type='number'] {
    -moz-appearance: textfield;
    -webkit-appearance: textfield;
    appearance: textfield;
  }

  input[type='number']::-webkit-inner-spin-button,
  input[type='number']::-webkit-outer-spin-button {
    -webkit-appearance: none;
    margin: 0;
  }

  textarea {
    resize: none;
    font-family: 'DM Mono', monospace;
    font-size: 0.88rem;
    line-height: 1.7;
    padding-top: 0.75rem;
    padding-bottom: 1rem;
    overflow: auto;
  }

  textarea::placeholder,
  input::placeholder { color: #3f3f46; }

  textarea:focus,
  input[type='number']:focus { border-color: rgba(123, 156, 191, 0.4); }

  textarea:disabled,
  input:disabled { opacity: 0.45; }

  /* ── Param row ──────────────────────────────────────────────────────── */
  .param-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.75rem;
  }

  .param-field {
    display: flex;
    flex-direction: column;
  }

  /* ── Custom dropdown ─────────────────────────────────────────────────── */
  .custom-select { position: relative; }

  .select-trigger {
    width: 100%;
    padding: 0.65rem 0.875rem;
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 0.75rem;
    color: #e4e4e7;
    font-family: 'DM Mono', monospace;
    font-size: 0.82rem;
    cursor: pointer;
    display: flex;
    justify-content: space-between;
    align-items: center;
    text-align: left;
    transition: border-color 0.2s, transform 0.12s ease, filter 0.12s ease;
  }

  .select-trigger:hover:not(:disabled) { border-color: rgba(255, 255, 255, 0.18); }
  .select-trigger:active:not(:disabled) { transform: scale(0.98); filter: brightness(0.9); }
  .select-trigger:disabled { opacity: 0.45; cursor: not-allowed; }

  .chevron {
    display: flex;
    align-items: center;
    color: #52525b;
    transition: transform 0.22s ease;
    flex-shrink: 0;
  }

  .select-trigger.open .chevron { transform: rotate(180deg); }

  .select-list {
    position: absolute;
    top: calc(100% + 5px);
    left: 0;
    right: 0;
    background: rgba(12, 12, 15, 0.96);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 0.75rem;
    overflow: hidden;
    z-index: 20;
    max-height: 0;
    opacity: 0;
    pointer-events: none;
    transition: max-height 0.22s ease, opacity 0.18s ease;
    backdrop-filter: blur(20px);
  }

  .select-list.visible {
    max-height: 14rem;
    opacity: 1;
    pointer-events: auto;
  }

  .select-option {
    width: 100%;
    padding: 0.6rem 0.875rem;
    background: transparent;
    border: none;
    color: #71717a;
    font-family: 'DM Mono', monospace;
    font-size: 0.8rem;
    text-align: left;
    cursor: pointer;
    transition: background 0.15s, color 0.15s, transform 0.1s ease;
  }

  .select-option:hover { background: rgba(255, 255, 255, 0.05); color: #e4e4e7; }
  .select-option:active { transform: scale(0.98); }
  .select-option.active { color: #7b9cbf; }

  /* ── Generate row ────────────────────────────────────────────────────── */
  .generate-row {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    margin-top: 0.25rem;
  }

  .btn-generate {
    flex: 1;
    padding: 0.85rem;
    border: none;
    border-radius: 3rem;
    background: #7b9cbf;
    color: #09090b;
    font-family: 'DM Mono', monospace;
    font-size: 0.75rem;
    font-weight: 500;
    letter-spacing: 0.14em;
    cursor: pointer;
    transition: transform 0.12s ease, filter 0.12s ease, background 0.3s, flex 0.3s ease;
  }

  .btn-generate:hover:not(:disabled) { background: #a3bdd4; }
  .btn-generate:active:not(:disabled) { transform: scale(0.96); filter: brightness(0.85); }
  .btn-generate:disabled { opacity: 0.7; cursor: not-allowed; }

  @keyframes generating-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.55; }
  }

  .btn-generate.generating {
    background: linear-gradient(
      to right,
      rgba(123, 156, 191, 0.45) var(--progress, 0%),
      rgba(123, 156, 191, 0.12) var(--progress, 0%)
    );
    color: #7b9cbf;
    border: 1px solid rgba(123, 156, 191, 0.25);
    opacity: 1;
    animation: generating-pulse 2s ease-in-out infinite;
  }

  .btn-generate.view-result {
    background: #7b9cbf;
    color: #09090b;
    cursor: pointer;
  }

  .btn-generate.view-result:hover { background: #a3bdd4; }
  .btn-generate.view-result:active { transform: scale(0.96); filter: brightness(0.85); }

  .btn-generate.btn-new-job {
    background: rgba(255, 255, 255, 0.06);
    color: #a1a1aa;
    border: 1px solid rgba(255, 255, 255, 0.08);
  }

  .btn-generate.btn-new-job:hover { background: rgba(255, 255, 255, 0.11); color: #e4e4e7; }

  .btn-cancel-icon {
    width: 2.5rem;
    height: 2.5rem;
    flex-shrink: 0;
    border-radius: 50%;
    border: 1px solid rgba(255, 255, 255, 0.08);
    background: rgba(255, 255, 255, 0.05);
    color: #71717a;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: transform 0.12s ease, filter 0.12s ease, background 0.2s, color 0.2s;
  }

  .btn-cancel-icon:hover { background: rgba(255, 255, 255, 0.1); color: #e4e4e7; }
  .btn-cancel-icon:active { transform: scale(0.88); filter: brightness(0.85); }

  /* ── Error ──────────────────────────────────────────────────────────── */
  .error {
    font-family: 'DM Mono', monospace;
    color: #c47070;
    font-size: 0.75rem;
    margin: 0;
    letter-spacing: 0.03em;
  }

  /* ── Mobile font-size to prevent iOS zoom ───────────────────────────── */
  @media (hover: none) and (pointer: coarse) {
    input, textarea { font-size: 16px !important; }
  }
</style>

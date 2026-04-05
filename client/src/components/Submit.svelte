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

  let { token, ws, onJobSubmitted, onCancel = () => {}, seed = $bindable(), seedMode = $bindable(), onNewJob, isAdmin = false, onOpenAdmin, showGalleryBtn = false, onOpenGallery, showVaultSettingsBtn = false, onOpenVaultSettings, codeUsesRemaining = null, userUsesRemaining = null, queueState = { queue: [], activeJobId: null, avgDuration: 60 }, pendingJobs = new Map(), dismissedResults = [], clockNow = Date.now(), onReopenDismissed = null } = $props();

  let codeDepleted = $derived(codeUsesRemaining !== null && codeUsesRemaining === 0);
  let userDepleted = $derived(userUsesRemaining !== null && userUsesRemaining === 0);

  // Queue-derived state
  // queue now contains only this user's own jobs (server only sends owner detail).
  let myQueueCount = $derived(queueState.queue.length);
  let queueLimit = $derived(queueState.maxQueuePerUser ?? 3);
  let queueFull = $derived(myQueueCount >= queueLimit);

  // ── Per-form local state ──────────────────────────────────────────────
  let imageFile1 = $state(null);
  let imagePreviewUrl1 = $state(null);
  let imageFile2 = $state(null);
  let imagePreviewUrl2 = $state(null);
  let prompt = $state('');
  let steps = $state(4);
  let sampler = $state('euler');
  let lora = $state('none');
  let loraStrength = $state(0.75);
  let quantization = $state('flux-2-klein-9b-Q4_K_M.gguf');
  let clipModel = $state('Qwen_Qwen3-8B-Q4_K_M.gguf');
  let status = $state('idle'); // 'idle' | 'encrypting' | 'error'
  let error = $state('');

  // ── Config overlay state ──────────────────────────────────────────────
  let configOpen = $state(false);

  // ── Drag state ────────────────────────────────────────────────────────
  let dragOverSlot = $state(0);       // 0=none, 1=slot1, 2=slot2
  let draggingFromSlot = $state(0);   // 0=not internal, 1 or 2
  let cardDragActive = $state(false);
  let _cardDragCount = 0;

  // ── Dropdown open state (inside overlay only) ─────────────────────────
  let seedModeOpen = $state(false);
  let samplerOpen = $state(false);
  let loraOpen = $state(false);
  let quantizationOpen = $state(false);
  let clipModelOpen = $state(false);

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
  const loraOptions = [
    { value: 'none', label: 'None' },
    { value: 'lora1.safetensors', label: 'LoRa - N1' },
    { value: 'lora2.safetensors', label: 'LoRa - N2' },
  ];
  const quantizationOptions = [
    { value: 'flux-2-klein-9b-Q4_K_M.gguf',      label: 'flux-2-klein-9b-Q4_K_M.gguf',      size: '5.91 GB' },
    { value: 'flux-2-klein-9b-Q5_K_M.gguf',      label: 'flux-2-klein-9b-Q5_K_M.gguf',      size: '7.02 GB' },
    { value: 'flux-2-klein-9b-Q6_K.gguf',         label: 'flux-2-klein-9b-Q6_K.gguf',         size: '7.87 GB' },
    { value: 'Flux-2-Klein-9B-KV-Q4_K_M.gguf',   label: 'Flux-2-Klein-9B-KV-Q4_K_M.gguf',   size: '5.72 GB' },
    { value: 'Flux-2-Klein-9B-KV-Q5_K_M.gguf',   label: 'Flux-2-Klein-9B-KV-Q5_K_M.gguf',   size: '6.81 GB' },
    { value: 'Flux-2-Klein-9B-KV-Q6_K.gguf',     label: 'Flux-2-Klein-9B-KV-Q6_K.gguf',     size: '7.87 GB' },
  ];
  const clipModelOptions = [
    { value: 'Qwen_Qwen3-8B-Q4_K_M.gguf', label: 'Qwen_Qwen3-8B-Q4_K_M.gguf', size: '5.03 GB' },
    { value: 'Qwen3-8B-Q4_K_M.gguf',      label: 'Qwen3-8B-Q4_K_M.gguf',      size: '5.03 GB' },
    { value: 'Qwen3-8B-Q4_K_M_v2.gguf',   label: 'Qwen3-8B-Q4_K_M_v2.gguf',   size: '5.03 GB' },
  ];

  let seedModeLabel     = $derived(seedModeOptions.find(o => o.value === seedMode)?.label ?? seedMode);
  let samplerLabel      = $derived(samplerOptions.find(o => o.value === sampler)?.label ?? sampler);
  let loraLabel         = $derived(loraOptions.find(o => o.value === lora)?.label ?? lora);
  let quantizationLabel = $derived(quantizationOptions.find(o => o.value === quantization)?.label ?? quantization);
  let quantizationSize  = $derived(quantizationOptions.find(o => o.value === quantization)?.size ?? '');
  let clipModelLabel    = $derived(clipModelOptions.find(o => o.value === clipModel)?.label ?? clipModel);
  let clipModelSize     = $derived(clipModelOptions.find(o => o.value === clipModel)?.size ?? '');

  let configSummary = $derived(
    `${seed} · ${steps} steps · ${samplerLabel} · ${seedModeLabel.split(' ')[0]}` +
    (lora !== 'none' ? ` · ${loraLabel}` : '') +
    ` · ${quantizationLabel} · ${clipModelLabel}`
  );

  // Click-outside action — reused for overlay panel and dropdowns
  function clickOutside(node, callback) {
    const handle = (e) => { if (!node.contains(e.target)) callback(); };
    document.addEventListener('pointerdown', handle, true);
    return { destroy() { document.removeEventListener('pointerdown', handle, true); } };
  }

  // ── Progress state (tracks the currently processing job) ────────────
  let progressValue = $state(0);
  let progressMax   = $state(1);
  let progressPhase = $state(1);
  let _prevValue    = 0;
  let _trackingJobId = null;

  $effect(() => {
    if (!ws) return;
    const offs = [];

    offs.push(ws.on('progress', ({ jobId, value, max }) => {
      // Only track progress for the active job
      if (queueState.activeJobId && jobId !== queueState.activeJobId) return;
      if (_trackingJobId !== jobId) {
        // New job started processing — reset progress
        _trackingJobId = jobId;
        progressValue = 0;
        progressMax = 1;
        progressPhase = 1;
        _prevValue = 0;
      }
      if (value < _prevValue && _prevValue >= progressMax * 0.9) progressPhase += 1;
      _prevValue    = value;
      progressValue = value;
      progressMax   = max > 0 ? max : 1;
    }));

    offs.push(ws.on('error', () => {
      if (status === 'error' || status === 'idle') {
        error = '';
      }
    }));

    offs.push(ws.on('open', () => {
      if (status === 'error' || status === 'idle') {
        error = '';
      }
    }));

    return () => offs.forEach(off => off());
  });

  // Reset progress whenever the server's active job changes (handles stale pct between jobs)
  $effect(() => {
    const activeId = queueState.activeJobId;
    if (_trackingJobId !== activeId) {
      progressValue = 0;
      progressMax = 1;
      progressPhase = 1;
      _prevValue = 0;
      _trackingJobId = activeId;
    }
  });

  function resetProgress() {
    progressValue = 0;
    progressMax   = 1;
    progressPhase = 1;
    _prevValue    = 0;
    _trackingJobId = null;
  }

  let pct = $derived(progressMax > 0 ? Math.round((progressValue / progressMax) * 100) : 0);

  // ── Image helpers ─────────────────────────────────────────────────────
  function setSlot1(file) {
    if (!file) return;
    if (imagePreviewUrl1) URL.revokeObjectURL(imagePreviewUrl1);
    imageFile1 = file;
    imagePreviewUrl1 = URL.createObjectURL(file);
  }
  function setSlot2(file) {
    if (!file) return;
    if (imagePreviewUrl2) URL.revokeObjectURL(imagePreviewUrl2);
    imageFile2 = file;
    imagePreviewUrl2 = URL.createObjectURL(file);
  }

  function handleFileChange1(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setSlot1(file);
    e.target.value = '';
  }
  function handleFileChange2(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setSlot2(file);
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

  // ── Drag-and-drop: card-level ─────────────────────────────────────────
  function onCardDragEnter(e) {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    _cardDragCount++;
    cardDragActive = true;
  }
  function onCardDragOver(e) {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }
  function onCardDragLeave() {
    _cardDragCount--;
    if (_cardDragCount <= 0) {
      _cardDragCount = 0;
      cardDragActive = false;
      dragOverSlot = 0;
    }
  }
  function onCardDrop(e) {
    e.preventDefault();
    _cardDragCount = 0;
    cardDragActive = false;
    dragOverSlot = 0;
    const file = e.dataTransfer.files?.[0];
    if (!file || !file.type.startsWith('image/')) return;
    if (!imageFile1) setSlot1(file);
    else if (!imageFile2) setSlot2(file);
    else setSlot1(file);
  }

  // ── Drag-and-drop: per-slot ───────────────────────────────────────────
  function onSlotDragEnter(e, slot) {
    e.preventDefault();
    e.stopPropagation();
    dragOverSlot = slot;
    cardDragActive = false;
  }
  function onSlotDragOver(e) {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = draggingFromSlot !== 0 ? 'move' : 'copy';
  }
  function onSlotDragLeave(e, slot) {
    e.stopPropagation();
    if (!e.relatedTarget || !e.currentTarget.contains(e.relatedTarget)) {
      if (dragOverSlot === slot) dragOverSlot = 0;
    }
  }
  function onSlotDrop(e, slot) {
    e.preventDefault();
    e.stopPropagation();
    dragOverSlot = 0;
    cardDragActive = false;
    _cardDragCount = 0;
    if (draggingFromSlot !== 0 && draggingFromSlot !== slot) {
      const f1 = imageFile1, u1 = imagePreviewUrl1;
      const f2 = imageFile2, u2 = imagePreviewUrl2;
      imageFile1 = f2; imagePreviewUrl1 = u2;
      imageFile2 = f1; imagePreviewUrl2 = u1;
      draggingFromSlot = 0;
      return;
    }
    const file = e.dataTransfer.files?.[0];
    if (!file || !file.type.startsWith('image/')) return;
    if (slot === 1) setSlot1(file);
    else setSlot2(file);
  }

  // ── Internal slot drag (swap) ─────────────────────────────────────────
  let _transparentImg;
  function getTransparentDragImage() {
    if (!_transparentImg) {
      _transparentImg = document.createElement('img');
      _transparentImg.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    }
    return _transparentImg;
  }
  function onImgDragStart(e, slot) {
    draggingFromSlot = slot;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setDragImage(getTransparentDragImage(), 0, 0);
  }
  function onImgDragEnd() {
    draggingFromSlot = 0;
  }

  function swapImages() {
    const f1 = imageFile1, u1 = imagePreviewUrl1;
    const f2 = imageFile2, u2 = imagePreviewUrl2;
    imageFile1 = f2; imagePreviewUrl1 = u2;
    imageFile2 = f1; imagePreviewUrl2 = u1;
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
    if (!prompt.trim() || status !== 'idle' || queueFull) return;
    error = '';
    status = 'encrypting';
    let offQueued = null;
    try {
      const pcPubKeyB64  = await getPCPublicKey(token);
      const pcPublicKey  = await importPcPublicKey(pcPubKeyB64);
      const ephKeyPair   = await generateEphemeralKeyPair();
      const aesKey       = await deriveAESKey(ephKeyPair.privateKey, pcPublicKey);
      const image1B64    = await fileToBase64(imageFile1);
      const image2B64    = await fileToBase64(imageFile2);
      const plaintext    = new TextEncoder().encode(JSON.stringify({ prompt: prompt.trim(), image1: image1B64, image2: image2B64, seed, steps, sampler, lora: lora !== 'none' ? lora : null, loraStrength: Number(loraStrength), quantization, clipModel }));
      const { iv, ciphertext } = await encryptPayload(aesKey, plaintext);
      const ephPubKeyBytes = await exportEphemeralPublicKey(ephKeyPair.publicKey);
      const payload = encodeJobPayload(ephPubKeyBytes, iv, ciphertext);

      // Capture form state at submit time for queue preview display
      const capturedPromptText = prompt.trim();
      const capturedPreview1 = imagePreviewUrl1;
      const capturedPreview2 = imagePreviewUrl2;

      // Listen for the queued response to capture jobId
      offQueued = ws.on('queued', ({ jobId }) => {
        offQueued();
        onJobSubmitted({ aesKey, jobId, promptText: capturedPromptText, preview1: capturedPreview1, preview2: capturedPreview2 });
        // Advance seed for next submission
        if (seedMode === 'randomize') seed = Math.floor(Math.random() * 2 ** 32);
        else if (seedMode === 'increment') seed = seed + 1;
        else if (seedMode === 'decrement') seed = seed - 1;
      });

      const sent = ws.send({ type: 'submit', payload });
      if (!sent) {
        offQueued();
        throw new Error('WebSocket is not connected');
      }
      // Return to idle immediately so user can queue more jobs
      status = 'idle';
    } catch (err) {
      if (offQueued) offQueued();
      error = err.message;
      status = 'error';
      setTimeout(() => { if (status === 'error') status = 'idle'; }, 3000);
    }
  }

  function handleCancelJob(jobId) {
    ws.send({ type: 'cancel', jobId });
    onCancel({ jobId });
  }
</script>

<!-- ── Config overlay ────────────────────────────────────────────────── -->
{#if configOpen}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_noninteractive_element_interactions -->
  <div
    class="cfg-backdrop"
    role="dialog"
    aria-modal="true"
    aria-label="Configuration"
    tabindex="-1"
    onclick={(e) => { if (e.target === e.currentTarget) { configOpen = false; seedModeOpen = false; samplerOpen = false; loraOpen = false; quantizationOpen = false; clipModelOpen = false; } }}
  >
    <div class="cfg-panel" use:clickOutside={() => { configOpen = false; seedModeOpen = false; samplerOpen = false; loraOpen = false; quantizationOpen = false; clipModelOpen = false; }}>
      <div class="cfg-handle"></div>
      <div class="cfg-header">
        <span class="cfg-title">CONFIGURATION</span>
        <button class="cfg-close" type="button" onclick={() => { configOpen = false; seedModeOpen = false; samplerOpen = false; loraOpen = false; quantizationOpen = false; clipModelOpen = false; }} aria-label="Close configuration">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
        </button>
      </div>

      <div class="cfg-body">
        <!-- Seed + After Gen -->
        <div class="cfg-section">
          <span class="cfg-section-label">SEED &amp; BEHAVIOR</span>
          <div class="param-row">
            <div class="param-field">
              <label class="field-label" for="cfg-seed">SEED</label>
              <input id="cfg-seed" type="number" min="0" step="1" bind:value={seed} />
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
        </div>

        <!-- Steps + Sampler -->
        <div class="cfg-section">
          <span class="cfg-section-label">SAMPLING</span>
          <div class="param-row">
            <div class="param-field">
              <label class="field-label" for="cfg-steps">STEPS (1–8)</label>
              <input id="cfg-steps" type="number" min="1" max="8" step="1" bind:value={steps} />
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
        </div>

        <!-- LoRA -->
        <div class="cfg-section">
          <span class="cfg-section-label">LORA</span>
          <div class="param-row">
            <div class="param-field">
              <span class="field-label">MODEL</span>
              <div class="custom-select dropup" use:clickOutside={() => loraOpen = false}>
                <button
                  type="button"
                  class="select-trigger"
                  class:open={loraOpen}
                  onclick={() => loraOpen = !loraOpen}
                >
                  <span>{loraLabel}</span>
                  <span class="chevron"><svg width="10" height="6" viewBox="0 0 10 6" fill="none"><path d="M1 1l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
                </button>
                <div class="select-list" class:visible={loraOpen}>
                  {#each loraOptions as opt}
                    <button
                      type="button"
                      class="select-option"
                      class:active={lora === opt.value}
                      onclick={() => { lora = opt.value; loraOpen = false; }}
                    >{opt.label}</button>
                  {/each}
                </div>
              </div>
            </div>
            <div class="param-field param-field-slider" class:hidden-field={lora === 'none'}>
              <label class="field-label" for="cfg-lora-strength">STRENGTH ({loraStrength.toFixed(2)})</label>
              <input id="cfg-lora-strength" type="range" min="0" max="2" step="0.05" bind:value={loraStrength} class="range-slider" />
            </div>
          </div>
        </div>

        <!-- Models -->
        <div class="cfg-section cfg-section-quant">
          <span class="cfg-section-label">MODELS</span>
          <div class="param-row">
            <div class="param-field">
              <span class="field-label">DIFFUSION</span>
              <div class="custom-select dropup" use:clickOutside={() => quantizationOpen = false}>
                <button
                  type="button"
                  class="select-trigger"
                  class:open={quantizationOpen}
                  onclick={() => quantizationOpen = !quantizationOpen}
                >
                  <span class="trigger-label">{quantizationLabel}</span>
                  <span class="trigger-size">{quantizationSize}</span>
                  <span class="chevron"><svg width="10" height="6" viewBox="0 0 10 6" fill="none"><path d="M1 1l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
                </button>
                <div class="select-list" class:visible={quantizationOpen}>
                  {#each quantizationOptions as opt}
                    <button
                      type="button"
                      class="select-option select-option-quant"
                      class:active={quantization === opt.value}
                      onclick={() => { quantization = opt.value; quantizationOpen = false; }}
                    >
                      <span>{opt.label}</span>
                      <span class="quant-opt-size">{opt.size}</span>
                    </button>
                  {/each}
                </div>
              </div>
            </div>
            <div class="param-field">
              <span class="field-label">CLIP</span>
              <div class="custom-select dropup" use:clickOutside={() => clipModelOpen = false}>
                <button
                  type="button"
                  class="select-trigger"
                  class:open={clipModelOpen}
                  onclick={() => clipModelOpen = !clipModelOpen}
                >
                  <span class="trigger-label">{clipModelLabel}</span>
                  <span class="trigger-size">{clipModelSize}</span>
                  <span class="chevron"><svg width="10" height="6" viewBox="0 0 10 6" fill="none"><path d="M1 1l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
                </button>
                <div class="select-list" class:visible={clipModelOpen}>
                  {#each clipModelOptions as opt}
                    <button
                      type="button"
                      class="select-option select-option-quant"
                      class:active={clipModel === opt.value}
                      onclick={() => { clipModel = opt.value; clipModelOpen = false; }}
                    >
                      <span>{opt.label}</span>
                      <span class="quant-opt-size">{opt.size}</span>
                    </button>
                  {/each}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="cfg-footer">
        <button type="button" class="cfg-done" onclick={() => { configOpen = false; seedModeOpen = false; samplerOpen = false; loraOpen = false; quantizationOpen = false; clipModelOpen = false; }}>
          DONE
        </button>
      </div>
    </div>
  </div>
{/if}

<!-- ── Main page ──────────────────────────────────────────────────────── -->
<div class="page">
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="card"
    class:card-drag={cardDragActive}
    ondragenter={onCardDragEnter}
    ondragover={onCardDragOver}
    ondragleave={onCardDragLeave}
    ondrop={onCardDrop}
  >
    <form onsubmit={handleSubmit} class="form">
      <div class="form-header">
        <div class="form-header-left">
          <span class="form-title">ComfyLink</span>
          <span class="form-sub">FLUX2 9B KLEIN &middot; REMOTE</span>
        </div>
        <div class="form-header-right">
          {#if isAdmin}
            <button type="button" class="btn-admin" onclick={onOpenAdmin} aria-label="Admin panel">
              <svg width="16" height="16" viewBox="0 0 20 20" fill="none">
                <path d="M17 10a7 7 0 11-14 0 7 7 0 0114 0z" stroke="currentColor" stroke-width="1.3"/>
                <path d="M10 7v3l2 2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
                <circle cx="10" cy="3" r="1.2" fill="currentColor"/>
                <circle cx="10" cy="17" r="1.2" fill="currentColor"/>
                <circle cx="3" cy="10" r="1.2" fill="currentColor"/>
                <circle cx="17" cy="10" r="1.2" fill="currentColor"/>
              </svg>
            </button>
          {/if}
          {#if showGalleryBtn}
            <button type="button" class="btn-admin" onclick={onOpenGallery} aria-label="Saved results">
              <svg width="16" height="16" viewBox="0 0 20 20" fill="none">
                <rect x="2" y="2" width="7" height="7" rx="1.5" stroke="currentColor" stroke-width="1.3"/>
                <rect x="11" y="2" width="7" height="7" rx="1.5" stroke="currentColor" stroke-width="1.3"/>
                <rect x="2" y="11" width="7" height="7" rx="1.5" stroke="currentColor" stroke-width="1.3"/>
                <rect x="11" y="11" width="7" height="7" rx="1.5" stroke="currentColor" stroke-width="1.3"/>
              </svg>
            </button>
          {/if}
          {#if showVaultSettingsBtn}
            <button type="button" class="btn-admin" onclick={onOpenVaultSettings} aria-label="Vault settings">
              <svg width="16" height="16" viewBox="0 0 20 20" fill="none">
                <rect x="3" y="5" width="14" height="10" rx="2" stroke="currentColor" stroke-width="1.3"/>
                <path d="M7 5V4a3 3 0 016 0v1" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
                <circle cx="10" cy="11" r="1.5" fill="currentColor"/>
              </svg>
            </button>
          {/if}
        </div>
      </div>

      <!-- Images -->
      <div class="img-slots">
        <!-- Slot 1 -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class="img-slot"
          class:drag-target={dragOverSlot === 1 || (cardDragActive && dragOverSlot === 0)}
          ondragenter={(e) => onSlotDragEnter(e, 1)}
          ondragover={onSlotDragOver}
          ondragleave={(e) => onSlotDragLeave(e, 1)}
          ondrop={(e) => onSlotDrop(e, 1)}
        >
          <span class="field-label">IMAGE 1</span>
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <label
            class="img-label"
            draggable={imageFile1 ? 'true' : 'false'}
            ondragstart={imageFile1 ? (e) => onImgDragStart(e, 1) : null}
            ondragend={imageFile1 ? onImgDragEnd : null}
          >
            {#if imagePreviewUrl1}
              <div class="img-preview-wrap">
                <img src={imagePreviewUrl1} alt="Slot 1 preview" class="img-preview" draggable="false" />
                {#if draggingFromSlot === 1 && dragOverSlot === 2}
                  <div class="swap-hint">SWAP ⇄</div>
                {/if}
              </div>
            {:else}
              <div class="drop-zone">
                {#if cardDragActive && dragOverSlot === 0}
                  <span>DROP HERE</span>
                {:else if dragOverSlot === 1}
                  <span>{draggingFromSlot === 2 ? 'SWAP ⇄' : 'DROP'}</span>
                {:else}
                  <span>+ SELECT</span>
                {/if}
              </div>
            {/if}
            <input type="file" accept="image/*" onchange={handleFileChange1} class="hidden-input" />
          </label>
          {#if imageFile1}
            <button type="button" class="btn-clear" onclick={clearImage1}>&times; Remove</button>
          {/if}
        </div>

        <!-- Slot 2 -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class="img-slot"
          class:drag-target={dragOverSlot === 2 || (cardDragActive && dragOverSlot === 0)}
          ondragenter={(e) => onSlotDragEnter(e, 2)}
          ondragover={onSlotDragOver}
          ondragleave={(e) => onSlotDragLeave(e, 2)}
          ondrop={(e) => onSlotDrop(e, 2)}
        >
          <span class="field-label">IMAGE 2</span>
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <label
            class="img-label"
            draggable={imageFile2 ? 'true' : 'false'}
            ondragstart={imageFile2 ? (e) => onImgDragStart(e, 2) : null}
            ondragend={imageFile2 ? onImgDragEnd : null}
          >
            {#if imagePreviewUrl2}
              <div class="img-preview-wrap">
                <img src={imagePreviewUrl2} alt="Slot 2 preview" class="img-preview" draggable="false" />
                {#if draggingFromSlot === 2 && dragOverSlot === 1}
                  <div class="swap-hint">SWAP ⇄</div>
                {/if}
              </div>
            {:else}
              <div class="drop-zone">
                {#if cardDragActive && dragOverSlot === 0}
                  <span>DROP HERE</span>
                {:else if dragOverSlot === 2}
                  <span>{draggingFromSlot === 1 ? 'SWAP ⇄' : 'DROP'}</span>
                {:else}
                  <span>+ SELECT</span>
                {/if}
              </div>
            {/if}
            <input type="file" accept="image/*" onchange={handleFileChange2} class="hidden-input" />
          </label>
          {#if imageFile2}
            <button type="button" class="btn-clear" onclick={clearImage2}>&times; Remove</button>
          {/if}
        </div>
      </div>

      {#if imageFile1 && imageFile2}
        <div class="swap-row">
          <button type="button" class="btn-swap" onclick={swapImages}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M1 4h9M1 4l2.5-2.5M1 4l2.5 2.5M13 10H4M13 10l-2.5-2.5M13 10l-2.5 2.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
            SWAP
          </button>
        </div>
      {/if}

      <!-- Prompt -->
      <div class="field">
        <label class="field-label" for="prompt-input">PROMPT</label>
        <textarea
          id="prompt-input"
          placeholder="Describe your image..."
          bind:value={prompt}
          oninput={() => { if (error) error = ''; }}
          rows="7"
          spellcheck="false"
        ></textarea>
      </div>

      <!-- Config pill row -->
      <button type="button" class="config-row" onclick={() => configOpen = true}>
        <span class="config-row-left">
          <svg class="config-icon" width="13" height="13" viewBox="0 0 20 20" fill="none">
            <circle cx="10" cy="10" r="2.5" stroke="currentColor" stroke-width="1.5"/>
            <path d="M10 2v2M10 16v2M2 10h2M16 10h2M4.22 4.22l1.42 1.42M14.36 14.36l1.42 1.42M4.22 15.78l1.42-1.42M14.36 5.64l1.42-1.42" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          </svg>
          <span class="config-label">CONFIGURE</span>
        </span>
        <span class="config-summary">
          <span class="config-summary-inner">
            <span>{configSummary}&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span>
            <span aria-hidden="true">{configSummary}&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span>
          </span>
        </span>
      </button>

      {#if error}
        <p class="error">{error}</p>
      {/if}

      {#if codeDepleted}
        <p class="code-depleted">Access code has no remaining uses</p>
      {/if}

      {#if userDepleted}
        <p class="code-depleted">No uses remaining — contact an admin to get more</p>
      {/if}

      <!-- Generate row -->
      <div class="generate-row">
        <button type="submit" class="btn-generate" class:btn-queue-full={queueFull} disabled={!prompt.trim() || status === 'encrypting' || codeDepleted || userDepleted || queueFull}>
          {#if status === 'encrypting'}
            ENCRYPTING...
          {:else if queueFull}
            QUEUED JOBS ({myQueueCount}/{queueLimit})
          {:else}
            ADD TO QUEUE ({myQueueCount}/{queueLimit})
          {/if}
        </button>
      </div>
    </form>

    <!-- ── Queue panel ──────────────────────────────────────────────── -->
    {#if queueState.queue.length > 0 || (queueState.queueSize ?? 0) > 0 || dismissedResults.length > 0}
      <div class="queue-panel">
        <div class="queue-header">
          <span class="queue-title">QUEUE</span>
          <div class="queue-header-right">
            <span class="queue-mine-count" class:queue-mine-full={queueFull}>{myQueueCount}/{queueLimit} YOUR SLOTS</span>
            <span class="queue-total-count">{queueState.queueSize ?? queueState.queue.length} total</span>
          </div>
        </div>
        {#if queueState.queue.length > 0}
          <div class="queue-list">
            {#each queueState.queue as item (item.jobId)}
              {@const jobMeta = pendingJobs.get(item.jobId)}
              <div class="queue-item queue-mine" class:queue-active={item.status === 'processing'}>
                <div class="queue-main-row">
                  <span class="queue-pos">#{item.position}</span>
                  <span class="queue-mine-badge">YOU</span>
                  <span class="queue-status" class:queue-processing={item.status === 'processing'}>
                    {#if item.status === 'processing'}
                      {#if pct > 0}
                        <span class="queue-progress-inline" style:--progress="{pct}%">PROCESSING {pct}%</span>
                      {:else}
                        <span class="queue-progress-inline queue-progress-indeterminate">PROCESSING</span>
                      {/if}
                    {:else}
                      <span class="queue-dot waiting"></span> WAITING
                    {/if}
                  </span>
                  {#if jobMeta?.preview1 || jobMeta?.preview2}
                    <div class="queue-thumbs">
                      {#if jobMeta.preview1}
                        <img src={jobMeta.preview1} alt="" class="queue-thumb" draggable="false" />
                      {/if}
                      {#if jobMeta.preview2}
                        <img src={jobMeta.preview2} alt="" class="queue-thumb" draggable="false" />
                      {/if}
                    </div>
                  {/if}
                  <span class="queue-eta">
                    {#if item.status === 'pending'}
                      ~{Math.max(1, Math.round(Math.max(0, item.position - 1) * queueState.avgDuration / 60))}m
                    {/if}
                  </span>
                  <button type="button" class="queue-cancel" onclick={() => handleCancelJob(item.jobId)} aria-label="Cancel job">
                    <svg width="10" height="10" viewBox="0 0 12 12" fill="none"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
                  </button>
                </div>
                {#if jobMeta?.promptText}
                  <div class="queue-prompt-row">
                    <span class="queue-prompt-scroll">
                      <span class="queue-prompt-inner">{jobMeta.promptText}&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;{jobMeta.promptText}&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span>
                    </span>
                  </div>
                {/if}
              </div>
            {/each}
          </div>
        {/if}

        <!-- ── Completed jobs ──────────────────────────────────────── -->
        {#if dismissedResults.length > 0}
          <div class="queue-finished-section">
            <div class="queue-finished-header">
              <span class="queue-finished-title">COMPLETED</span>
              <span class="queue-finished-count">{dismissedResults.length}</span>
            </div>
            {#each dismissedResults as d (d.id)}
              {@const secondsLeft = Math.max(0, Math.ceil((d.expiresAt - clockNow) / 1000))}
              {@const mm = String(Math.floor(secondsLeft / 60))}
              {@const ss = String(secondsLeft % 60).padStart(2, '0')}
              <button type="button" class="queue-finished-item" onclick={() => onReopenDismissed?.(d.id)}>
                <div class="queue-main-row">
                  {#if d.imageUrl}
                    <img src={d.imageUrl} alt="" class="queue-finished-thumb" draggable="false" />
                  {:else}
                    <div class="queue-finished-placeholder"></div>
                  {/if}
                  <span class="queue-finished-badge">DONE</span>
                  <span class="queue-finished-prompt">
                    <span class="queue-finished-prompt-inner">{d.promptSnippet || 'Result'}&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;{d.promptSnippet || 'Result'}&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span>
                  </span>
                  <span class="queue-finished-timer">{mm}:{ss}</span>
                </div>
              </button>
            {/each}
          </div>
        {/if}
      </div>
    {/if}
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
    transition: border-color 0.2s;
  }

  .card.card-drag {
    border-color: rgba(82, 116, 144, 0.35);
  }

  /* ── Form ──────────────────────────────────────────────────────────── */
  .form {
    display: flex;
    flex-direction: column;
    gap: 1.1rem;
  }

  /* ────────────────────────────────────────────────────────────────────
     Entrance animation tokens — adjust --el-opacity per element to
     control its final translucency. fill-mode: backwards means the
     element is hidden during its delay then reverts to the natural
     opacity below once the animation completes (no permanent override).
  ──────────────────────────────────────────────────────────────────── */
  @keyframes constructIn {
    from { opacity: 0; }
    to   { opacity: 1; }
  }

  .form-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 0.5rem;
    margin-bottom: 0.2rem;
    --el-opacity: 1;
    opacity: var(--el-opacity);
    animation: constructIn 0.4s cubic-bezier(0.16, 1, 0.3, 1) 0.05s backwards;
  }

  .form-header-right {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-shrink: 0;
    margin-top: 0.2rem;
  }

  .form-header-left {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }

  .btn-admin {
    width: 2rem;
    height: 2rem;
    border-radius: 50%;
    border: 1px solid rgba(255, 255, 255, 0.08);
    background-color: rgba(9, 9, 11, 0.84);
    background-image:
      linear-gradient(rgba(123, 156, 191, 0.07) 1px, transparent 1px),
      linear-gradient(90deg, rgba(123, 156, 191, 0.07) 1px, transparent 1px);
    background-size: 48px 48px;
    background-attachment: fixed;
    color: #8b96a6;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: transform 0.12s ease, filter 0.12s ease, background-color 0.2s, color 0.2s;
    flex-shrink: 0;
  }

  .btn-admin:hover { background-color: rgba(9, 9, 11, 0.5); color: #527490; }
  .btn-admin:active { transform: scale(0.88); filter: brightness(0.85); }

  .form-title {
    font-family: 'Syne', sans-serif;
    font-size: 1.6rem;
    font-weight: 800;
    color: #d4d4d8;
    letter-spacing: -0.02em;
    line-height: 1;
  }

  .form-sub {
    font-family: 'DM Mono', monospace;
    font-size: 0.62rem;
    letter-spacing: 0.2em;
    color: #527490;
  }

  /* ── Field label ───────────────────────────────────────────────────── */
  .field-label {
    display: block;
    font-family: 'DM Mono', monospace;
    font-size: 0.6rem;
    letter-spacing: 0.18em;
    color: #8b96a6;
    margin-bottom: 0.35rem;
  }

  .field {
    display: flex;
    flex-direction: column;
    --el-opacity: 1;
    opacity: var(--el-opacity);
    animation: constructIn 0.4s cubic-bezier(0.16, 1, 0.3, 1) 0.25s backwards;
  }

  /* ── Image slots ───────────────────────────────────────────────────── */
  .img-slots {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.75rem;
    --el-opacity: 1;
    opacity: var(--el-opacity);
    animation: constructIn 0.4s cubic-bezier(0.16, 1, 0.3, 1) 0.15s backwards;
  }

  .img-slot {
    display: flex;
    flex-direction: column;
    border-radius: 0.75rem;
  }

  .img-label {
    cursor: pointer;
    display: block;
    touch-action: manipulation;
    user-select: none;
  }

  .drop-zone {
    display: flex;
    align-items: center;
    justify-content: center;
    border: 1px dashed rgba(255, 255, 255, 0.12);
    border-radius: 0.75rem;
    height: 180px;
    background-color: rgba(9, 9, 11, 0.84);
    background-image:
      linear-gradient(rgba(123, 156, 191, 0.07) 1px, transparent 1px),
      linear-gradient(90deg, rgba(123, 156, 191, 0.07) 1px, transparent 1px);
    background-size: 48px 48px;
    background-attachment: fixed;
  }

  .img-label:hover .drop-zone {
    border-color: rgba(82, 116, 144, 0.4);
    color: #527490;
    background-color: rgba(82, 116, 144, 0.06);
  }

  .img-preview-wrap {
    position: relative;
    border-radius: 0.75rem;
    overflow: hidden;
  }

  .img-preview {
    width: 100%;
    height: 180px;
    object-fit: contain;
    background: rgba(0, 0, 0, 0.25);
    border-radius: 0.75rem;
    border: 1px solid rgba(255, 255, 255, 0.08);
    display: block;
    pointer-events: none;
    transition: border-color 0.2s, box-shadow 0.2s;
  }

  .swap-hint {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(9, 9, 11, 0.65);
    color: #527490;
    font-family: 'DM Mono', monospace;
    font-size: 0.75rem;
    letter-spacing: 0.18em;
    font-weight: 500;
    border-radius: 0.75rem;
    pointer-events: none;
  }

  .drop-zone > span {
    pointer-events: none;
    font-family: 'DM Mono', monospace;
    font-size: 0.85rem;
    color: #6c7585;
    letter-spacing: 0.04em;
  }

  .drag-target .drop-zone {
    border-color: rgba(82, 116, 144, 0.6);
    color: #527490;
    background: rgba(82, 116, 144, 0.06);
    box-shadow: 0 0 0 3px rgba(82, 116, 144, 0.12);
  }

  .drag-target .img-preview {
    border-color: rgba(82, 116, 144, 0.5);
    box-shadow: 0 0 0 3px rgba(82, 116, 144, 0.12);
  }

  .hidden-input { display: none; }

  /* ── Swap row ────────────────────────────────────────────────────────── */
  .swap-row {
    display: flex;
    justify-content: center;
    margin-top: -0.25rem;
  }

  .btn-swap {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.3rem 0.9rem;
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 3rem;
    background: rgba(255, 255, 255, 0.04);
    color: #8b96a6;
    font-family: 'DM Mono', monospace;
    font-size: 0.65rem;
    letter-spacing: 0.1em;
    cursor: pointer;
    transition: color 0.2s, border-color 0.2s, background 0.2s, transform 0.12s ease;
  }

  .btn-swap:hover { color: #527490; border-color: rgba(82, 116, 144, 0.35); background: rgba(82, 116, 144, 0.05); }
  .btn-swap:active { transform: scale(0.93); }

  .btn-clear {
    margin-top: 0.3rem;
    padding: 0.25rem 0.5rem;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 0.375rem;
    background: transparent;
    color: #8b96a6;
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
    background-color: rgba(9, 9, 11, 0.84);
    background-image:
      linear-gradient(rgba(123, 156, 191, 0.07) 1px, transparent 1px),
      linear-gradient(90deg, rgba(123, 156, 191, 0.07) 1px, transparent 1px);
    background-size: 48px 48px;
    background-attachment: fixed;
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
  input::placeholder { color: #6c7585; }

  textarea:focus,
  input[type='number']:focus { border-color: rgba(82, 116, 144, 0.4); }

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
    color: #8b96a6;
    transition: transform 0.22s ease;
    flex-shrink: 0;
  }

  .select-trigger.open .chevron { transform: rotate(180deg); }

  .dropup .select-list {
    top: auto;
    bottom: calc(100% + 5px);
  }
  .dropup .select-trigger.open .chevron { transform: rotate(0deg); }
  .dropup .select-trigger .chevron { transform: rotate(180deg); }

  .select-list {
    position: absolute;
    top: calc(100% + 5px);
    left: 0;
    right: 0;
    background: rgba(12, 12, 15, 0.96);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 0.75rem;
    overflow: hidden;
    z-index: 60;
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
    color: #a4afbb;
    font-family: 'DM Mono', monospace;
    font-size: 0.8rem;
    text-align: left;
    cursor: pointer;
    transition: background 0.15s, color 0.15s, transform 0.1s ease;
  }

  .select-option:hover { background: rgba(255, 255, 255, 0.05); color: #e4e4e7; }
  .select-option:active { transform: scale(0.98); }
  .select-option.active { color: #527490; }

  /* ── Range slider ────────────────────────────────────────────────────── */
  .param-field-slider {
    display: flex;
    flex-direction: column;
    justify-content: center;
    transition: opacity 0.2s, max-height 0.2s;
  }
  .hidden-field {
    opacity: 0;
    max-height: 0;
    overflow: hidden;
    pointer-events: none;
    margin: 0;
    padding: 0;
  }
  @media (min-width: 600px) {
    .hidden-field {
      max-height: none;
      visibility: hidden;
    }
  }

  .range-slider {
    -webkit-appearance: none;
    appearance: none;
    width: 100%;
    height: 4px;
    border-radius: 2px;
    background: rgba(255, 255, 255, 0.1);
    outline: none;
    margin: 0;
    cursor: pointer;
  }
  .range-slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: #527490;
    border: 2px solid rgba(9, 9, 11, 0.8);
    cursor: pointer;
    transition: background 0.2s, transform 0.12s;
  }
  .range-slider::-webkit-slider-thumb:hover { background: #7d9db6; transform: scale(1.15); }
  .range-slider::-moz-range-thumb {
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: #527490;
    border: 2px solid rgba(9, 9, 11, 0.8);
    cursor: pointer;
  }
  .range-slider::-moz-range-track {
    height: 4px;
    border-radius: 2px;
    background: rgba(255, 255, 255, 0.1);
  }

  /* ── Generate row ────────────────────────────────────────────────────── */
  .generate-row {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    margin-top: 0.25rem;
    --el-opacity: 1;
    opacity: var(--el-opacity);
    animation: constructIn 0.4s cubic-bezier(0.16, 1, 0.3, 1) 0.42s backwards;
  }

  .btn-generate {
    flex: 1;
    padding: 0.85rem;
    border: none;
    border-radius: 3rem;
    background: #527490;
    color: #09090b;
    font-family: 'DM Mono', monospace;
    font-size: 0.75rem;
    font-weight: 500;
    letter-spacing: 0.14em;
    cursor: pointer;
    transition: transform 0.12s ease, filter 0.12s ease, background 0.3s, flex 0.3s ease;
  }

  .btn-generate:hover:not(:disabled) { background: #7d9db6; }
  .btn-generate:active:not(:disabled) { transform: scale(0.96); filter: brightness(0.85); }
  .btn-generate:disabled { opacity: 0.7; cursor: not-allowed; }
  .btn-generate.btn-queue-full:disabled { opacity: 0.42; }

  /* ── Error / Code status ─────────────────────────────────────────────── */
  .error {
    font-family: 'DM Mono', monospace;
    color: #c47070;
    font-size: 0.75rem;
    margin: 0;
    letter-spacing: 0.03em;
  }

  .code-depleted {
    font-family: 'DM Mono', monospace;
    color: #c8a84b;
    font-size: 0.75rem;
    margin: 0;
    letter-spacing: 0.03em;
  }

  /* ── Config pill row ─────────────────────────────────────────────────── */
  .config-row {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.65rem 0.875rem;
    background-color: rgba(9, 9, 11, 0.84);
    background-image:
      linear-gradient(rgba(123, 156, 191, 0.07) 1px, transparent 1px),
      linear-gradient(90deg, rgba(123, 156, 191, 0.07) 1px, transparent 1px);
    background-size: 48px 48px;
    background-attachment: fixed;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 0.75rem;
    cursor: pointer;
    transition: border-color 0.2s, background-color 0.2s, transform 0.12s ease, filter 0.12s ease;
    text-align: left;
    --el-opacity: 1;
    opacity: var(--el-opacity);
    animation: constructIn 0.4s cubic-bezier(0.16, 1, 0.3, 1) 0.33s backwards;
  }

  .config-row:hover {
    border-color: rgba(255, 255, 255, 0.16);
    background-color: rgba(9, 9, 11, 0.7);
  }
  .config-row:active { transform: scale(0.99); filter: brightness(0.9); }

  .config-row-left {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-shrink: 0;
  }

  .config-icon {
    color: #8b96a6;
    flex-shrink: 0;
    transition: color 0.2s;
  }
  .config-row:hover .config-icon { color: #527490; }

  .config-label {
    font-family: 'DM Mono', monospace;
    font-size: 0.68rem;
    letter-spacing: 0.18em;
    color: #8b96a6;
    transition: color 0.2s;
  }
  .config-row:hover .config-label { color: #a4afbb; }

  .config-summary {
    font-family: 'DM Mono', monospace;
    font-size: 0.68rem;
    letter-spacing: 0.05em;
    color: #6c7585;
    overflow: hidden;
    flex: 1;
    min-width: 0;
    transition: color 0.2s;
    mask-image: linear-gradient(to left, transparent 0%, black 15%);
    -webkit-mask-image: linear-gradient(to left, transparent 0%, black 15%);
  }
  .config-row:hover .config-summary { color: #8b96a6; }

  .config-summary-inner {
    display: inline-flex;
    width: max-content;
    white-space: nowrap;
    animation: summary-scroll 14s linear infinite;
    will-change: transform;
  }

  .config-summary-inner span {
    flex-shrink: 0;
  }

  @keyframes summary-scroll {
    0%   { transform: translateX(0); }
    100% { transform: translateX(-50%); }
  }

  /* ── Config overlay ──────────────────────────────────────────────────── */
  .cfg-backdrop {
    position: fixed;
    inset: 0;
    z-index: 50;
    background: rgba(0, 0, 0, 0.72);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    display: flex;
    align-items: flex-end;
    justify-content: center;
    animation: cfg-backdrop-in 0.22s ease both;
  }

  @keyframes cfg-backdrop-in {
    from { opacity: 0; }
    to   { opacity: 1; }
  }

  .cfg-panel {
    width: 100%;
    max-width: 440px;
    background: rgba(14, 14, 18, 0.92);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 1.25rem 1.25rem 0 0;
    padding: 0 1.75rem 1.75rem;
    backdrop-filter: blur(24px);
    -webkit-backdrop-filter: blur(24px);
    display: flex;
    flex-direction: column;
    gap: 0;
    max-height: 92dvh;
    overflow: hidden;
    animation: cfg-sheet-up 0.28s cubic-bezier(0.16, 1, 0.3, 1) both;
  }

  @keyframes cfg-sheet-up {
    from { transform: translateY(100%); opacity: 0; }
    to   { transform: translateY(0);    opacity: 1; }
  }

  @media (min-width: 600px) {
    .cfg-backdrop { align-items: center; }

    .cfg-panel {
      border-radius: 1.25rem;
      max-height: 80vh;
      animation: cfg-panel-in 0.24s cubic-bezier(0.16, 1, 0.3, 1) both;
    }

    @keyframes cfg-panel-in {
      from { transform: scale(0.96) translateY(-6px); opacity: 0; }
      to   { transform: scale(1)    translateY(0);    opacity: 1; }
    }
  }

  .cfg-handle {
    width: 2.5rem;
    height: 3px;
    border-radius: 9999px;
    background: rgba(255, 255, 255, 0.12);
    align-self: center;
    margin: 1rem 0 0.75rem;
    flex-shrink: 0;
  }

  @media (min-width: 600px) {
    .cfg-handle { display: none; }
  }

  .cfg-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 1rem 0;
    flex-shrink: 0;
  }

  @media (min-width: 600px) {
    .cfg-header { padding-top: 1.5rem; }
  }

  .cfg-title {
    font-family: 'DM Mono', monospace;
    font-size: 0.65rem;
    letter-spacing: 0.22em;
    color: #527490;
  }

  .cfg-close {
    width: 2rem;
    height: 2rem;
    border-radius: 50%;
    border: 1px solid rgba(255, 255, 255, 0.08);
    background: rgba(255, 255, 255, 0.05);
    color: #a4afbb;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: transform 0.12s ease, filter 0.12s ease, background 0.2s, color 0.2s;
    flex-shrink: 0;
  }
  .cfg-close:hover { background: rgba(255, 255, 255, 0.1); color: #e4e4e7; }
  .cfg-close:active { transform: scale(0.88); filter: brightness(0.85); }

  .cfg-body {
    flex: 1;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
    padding-bottom: 0.5rem;
    scrollbar-width: thin;
    scrollbar-color: rgba(255,255,255,0.1) transparent;
  }
  .cfg-body::-webkit-scrollbar { width: 4px; }
  .cfg-body::-webkit-scrollbar-track { background: transparent; }
  .cfg-body::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 2px; }

  .cfg-section {
    display: flex;
    flex-direction: column;
    gap: 0.65rem;
  }

  .cfg-section-label {
    font-family: 'DM Mono', monospace;
    font-size: 0.58rem;
    letter-spacing: 0.2em;
    color: #6c7585;
  }

  .cfg-footer {
    padding-top: 1.25rem;
    flex-shrink: 0;
  }

  .cfg-done {
    width: 100%;
    padding: 0.85rem;
    border: none;
    border-radius: 3rem;
    background: #527490;
    color: #09090b;
    font-family: 'DM Mono', monospace;
    font-size: 0.75rem;
    font-weight: 500;
    letter-spacing: 0.14em;
    cursor: pointer;
    transition: transform 0.12s ease, filter 0.12s ease, background 0.2s;
  }
  .cfg-done:hover { background: #7d9db6; }
  .cfg-done:active { transform: scale(0.97); filter: brightness(0.85); }

  /* ── Mobile layout ───────────────────────────────────────────────────── */
  @media (max-width: 599px) {
    .page {
      padding: 0.75rem 0.75rem 1.5rem;
    }
    .card {
      padding: 1.25rem 1.1rem;
    }
    .form {
      gap: 0.85rem;
    }
    .drop-zone {
      height: 140px;
    }
    .img-preview {
      height: 140px;
    }
    textarea {
      max-height: 9.5rem;
    }
  }

  /* ── Mobile font-size to prevent iOS zoom ───────────────────────────── */
  @media (hover: none) and (pointer: coarse) {
    input, textarea { font-size: 16px !important; }
  }

  /* ── Quantization section ────────────────────────────────────────────── */
  .cfg-section-quant {
    border-top: 1px solid rgba(255, 255, 255, 0.05);
    padding-top: 1.25rem;
  }

  .cfg-section-quant .cfg-section-label {
    color: #525a66;
  }

  .cfg-section-quant .param-row {
    grid-template-columns: 1fr;
  }

  .trigger-label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .trigger-size {
    font-size: 0.75rem;
    color: #6c7585;
    padding: 0 0.5rem;
    flex-shrink: 0;
  }

  .select-option-quant {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .quant-opt-size {
    color: #525a66;
    font-size: 0.76rem;
    padding-left: 0.5rem;
    flex-shrink: 0;
  }

  /* ── Queue panel ─────────────────────────────────────────────────────── */
  .queue-panel {
    margin-top: 1rem;
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 0.75rem;
    overflow: hidden;
    animation: constructIn 0.3s cubic-bezier(0.16, 1, 0.3, 1) both;
  }

  .queue-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.6rem 0.875rem;
    background: rgba(255, 255, 255, 0.03);
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  }

  .queue-title {
    font-family: 'DM Mono', monospace;
    font-size: 0.6rem;
    letter-spacing: 0.18em;
    color: #8b96a6;
    font-weight: 500;
  }

  .queue-header-right {
    display: flex;
    align-items: center;
    gap: 0.65rem;
  }

  .queue-mine-count {
    font-family: 'DM Mono', monospace;
    font-size: 0.6rem;
    letter-spacing: 0.1em;
    color: #527490;
    font-weight: 500;
    transition: color 0.2s;
  }

  .queue-mine-count.queue-mine-full {
    color: #c47070;
  }

  .queue-total-count {
    font-family: 'DM Mono', monospace;
    font-size: 0.6rem;
    color: #525a66;
    letter-spacing: 0.05em;
  }

  .queue-list {
    display: flex;
    flex-direction: column;
    max-height: calc(6 * 3.4rem);
    overflow-y: auto;
    scrollbar-width: thin;
    scrollbar-color: rgba(255,255,255,0.08) transparent;
  }

  .queue-list::-webkit-scrollbar { width: 3px; }
  .queue-list::-webkit-scrollbar-track { background: transparent; }
  .queue-list::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 2px; }

  .queue-item {
    display: flex;
    flex-direction: column;
    padding: 0.55rem 0.875rem;
    border-bottom: 1px solid rgba(255, 255, 255, 0.04);
    transition: background 0.2s;
  }

  .queue-item:last-child {
    border-bottom: none;
  }

  .queue-main-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .queue-item.queue-mine {
    background: rgba(82, 116, 144, 0.08);
    border-left: 2px solid rgba(82, 116, 144, 0.5);
    padding-left: calc(0.875rem - 2px);
  }

  .queue-item.queue-active.queue-mine {
    background: rgba(82, 116, 144, 0.13);
  }

  .queue-mine-badge {
    font-family: 'DM Mono', monospace;
    font-size: 0.55rem;
    letter-spacing: 0.15em;
    color: #527490;
    background: rgba(82, 116, 144, 0.15);
    border: 1px solid rgba(82, 116, 144, 0.35);
    border-radius: 0.25rem;
    padding: 0.08rem 0.3rem;
    flex-shrink: 0;
  }

  .queue-pos {
    font-family: 'DM Mono', monospace;
    font-size: 0.7rem;
    color: #6c7585;
    min-width: 1.5rem;
    flex-shrink: 0;
  }

  .queue-status {
    font-family: 'DM Mono', monospace;
    font-size: 0.68rem;
    letter-spacing: 0.06em;
    color: #8b96a6;
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex: 1;
    min-width: 0;
  }

  .queue-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .queue-dot.waiting {
    background: #525a66;
  }

  @keyframes queue-pulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.4; transform: scale(0.8); }
  }

  .queue-progress-inline {
    font-family: 'DM Mono', monospace;
    font-size: 0.68rem;
    color: #527490;
    letter-spacing: 0.06em;
    background: linear-gradient(
      to right,
      rgba(82, 116, 144, 0.2) var(--progress, 0%),
      transparent var(--progress, 0%)
    );
    padding: 0.1rem 0.4rem;
    border-radius: 0.25rem;
  }


  @keyframes queue-sweep {
    0%   { background-position: 200% center; }
    100% { background-position: -200% center; }
  }

  .queue-progress-indeterminate {
    background: linear-gradient(
      90deg,
      transparent 25%,
      rgba(82, 116, 144, 0.28) 50%,
      transparent 75%
    );
    background-size: 200% 100%;
    animation: queue-sweep 1.8s linear infinite;
    color: #527490;
    opacity: 0.7;
  }

  .queue-thumbs {
    display: flex;
    gap: 0.2rem;
    flex-shrink: 0;
  }

  .queue-thumb {
    width: 28px;
    height: 28px;
    object-fit: cover;
    border-radius: 0.25rem;
    border: 1px solid rgba(82, 116, 144, 0.22);
    flex-shrink: 0;
    pointer-events: none;
    user-select: none;
    -webkit-user-drag: none;
  }

  .queue-eta {
    font-family: 'DM Mono', monospace;
    font-size: 0.62rem;
    color: #525a66;
    flex-shrink: 0;
    min-width: 2rem;
    text-align: right;
  }

  .queue-cancel {
    width: 1.4rem;
    height: 1.4rem;
    flex-shrink: 0;
    border-radius: 50%;
    border: 1px solid rgba(196, 112, 112, 0.45);
    background: rgba(196, 112, 112, 0.1);
    color: #c47070;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s, transform 0.1s;
  }

  .queue-cancel:hover { background: rgba(196, 112, 112, 0.25); border-color: rgba(196, 112, 112, 0.7); }
  .queue-cancel:active { transform: scale(0.85); }

  .queue-prompt-row {
    margin-top: 0.28rem;
    overflow: hidden;
  }

  .queue-prompt-scroll {
    display: block;
    overflow: hidden;
    mask-image: linear-gradient(to right, transparent 0%, black 8%, black 92%, transparent 100%);
    -webkit-mask-image: linear-gradient(to right, transparent 0%, black 8%, black 92%, transparent 100%);
  }

  .queue-prompt-inner {
    display: inline-block;
    white-space: nowrap;
    font-family: 'DM Mono', monospace;
    font-size: 0.62rem;
    letter-spacing: 0.04em;
    color: #527490;
    opacity: 0.75;
    animation: queue-marquee 14s linear infinite;
  }

  @keyframes queue-marquee {
    0%   { transform: translateX(0); }
    100% { transform: translateX(-50%); }
  }

  /* ── Completed jobs section ─────────────────────────────────────────── */
  .queue-finished-section {
    border-top: 1px solid rgba(255, 255, 255, 0.06);
  }

  .queue-finished-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.4rem 0.875rem;
    background: rgba(255, 255, 255, 0.02);
    border-bottom: 1px solid rgba(255, 255, 255, 0.04);
  }

  .queue-finished-title {
    font-family: 'DM Mono', monospace;
    font-size: 0.58rem;
    letter-spacing: 0.18em;
    color: #525a66;
    font-weight: 500;
  }

  .queue-finished-count {
    font-family: 'DM Mono', monospace;
    font-size: 0.58rem;
    color: #525a66;
    letter-spacing: 0.05em;
  }

  .queue-finished-item {
    width: 100%;
    display: flex;
    flex-direction: column;
    padding: 0.45rem 0.875rem;
    background: transparent;
    border: none;
    border-bottom: 1px solid rgba(255, 255, 255, 0.03);
    cursor: pointer;
    text-align: left;
    font: inherit;
    color: inherit;
    transition: background 0.15s;
  }

  .queue-finished-item:hover {
    background: rgba(255, 255, 255, 0.04);
  }

  .queue-finished-item:last-child {
    border-bottom: none;
  }

  .queue-finished-item:active {
    background: rgba(255, 255, 255, 0.06);
  }

  .queue-finished-thumb {
    width: 26px;
    height: 26px;
    object-fit: cover;
    border-radius: 0.2rem;
    border: 1px solid rgba(255, 255, 255, 0.08);
    flex-shrink: 0;
    pointer-events: none;
    user-select: none;
    -webkit-user-drag: none;
  }

  .queue-finished-placeholder {
    width: 26px;
    height: 26px;
    border-radius: 0.2rem;
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.06);
    flex-shrink: 0;
  }

  .queue-finished-badge {
    font-family: 'DM Mono', monospace;
    font-size: 0.5rem;
    letter-spacing: 0.15em;
    color: #527490;
    background: rgba(82, 116, 144, 0.1);
    border: 1px solid rgba(82, 116, 144, 0.25);
    border-radius: 0.2rem;
    padding: 0.05rem 0.28rem;
    flex-shrink: 0;
  }

  .queue-finished-prompt {
    display: block;
    overflow: hidden;
    flex: 1;
    min-width: 0;
    mask-image: linear-gradient(to right, transparent 0%, black 8%, black 92%, transparent 100%);
    -webkit-mask-image: linear-gradient(to right, transparent 0%, black 8%, black 92%, transparent 100%);
  }

  .queue-finished-prompt-inner {
    display: inline-block;
    white-space: nowrap;
    font-family: 'DM Mono', monospace;
    font-size: 0.6rem;
    letter-spacing: 0.04em;
    color: #6c7585;
    animation: queue-marquee 18s linear infinite;
  }

  .queue-finished-timer {
    font-family: 'DM Mono', monospace;
    font-size: 0.58rem;
    color: #c4996a;
    letter-spacing: 0.08em;
    flex-shrink: 0;
  }
</style>

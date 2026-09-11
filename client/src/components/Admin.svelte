<script>
  import { onMount } from 'svelte';
  import { dialog } from './dialog.js';
  import { generateCode, listCodes, deleteCode, updateCode, listUsers, updateUserStatus, updateUserUses } from '../lib/api.js';

  let { token, onClose, accessCodesEnabled = true } = $props();

  // Decode own userId from JWT payload (no crypto — server validates signature on every request)
  const selfId = (() => {
    try {
      return JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).userId ?? null;
    } catch {
      return null;
    }
  })();

  let activeTab = $state('codes'); // 'codes' | 'users'

  let codes = $state([]);
  let loading = $state(true);
  let initialLoaded = $state(false);
  let generating = $state(false);
  let error = $state('');
  let copyFeedback = $state(null); // code id that was just copied

  // Config for new code
  let usesRemaining = $state(1);
  let expiresInHours = $state('');
  let codeType = $state('registration');

  // Edit state for existing codes
  let editingCodeId = $state(null);
  let editUsesRemaining = $state('');
  let editExpiresInHours = $state('');
  let editSaving = $state(false);
  let editError = $state('');

  // Users state
  let users = $state([]);
  let usersLoading = $state(false);
  let usersError = $state('');
  let userFilter = $state('all'); // 'all' | 'pending' | 'active' | 'suspended'
  let updatingUserId = $state(null);

  // User uses editing state
  let editingUsesId = $state(null);
  let editUserUses = $state('');
  let editUserUnlimited = $state(false);
  let editUsesSaving = $state(false);
  let editUsesError = $state('');

  // ── Admin WebSocket for real-time updates ──────────────────────────────────
  let adminWs = null;
  let adminWsReconnectTimer = null;
  let _reconnectDelay = 2000; // exponential backoff state
  let wsStatus = $state('connecting'); // connecting | connected | reconnecting
  let wsStatusText = $state('Connecting live updates...');
  let adminBodyEl = $state(null);
  let adminScrolledNearBottom = $state(false);

  // Debounce timers — prevent a burst of WS events from flooding HTTP requests
  let _codesDebounce = null;
  let _usersDebounce = null;

  // Cooldown: minimum ms between WS-triggered refreshes (not user actions)
  const WS_REFRESH_COOLDOWN = 3000;
  let _lastCodesLoad = 0;
  let _lastUsersLoad = 0;

  function debouncedLoadCodes() {
    clearTimeout(_codesDebounce);
    _codesDebounce = setTimeout(() => {
      if (Date.now() - _lastCodesLoad < WS_REFRESH_COOLDOWN) return;
      loadCodes();
    }, 500);
  }

  function debouncedLoadUsers() {
    clearTimeout(_usersDebounce);
    _usersDebounce = setTimeout(() => {
      if (Date.now() - _lastUsersLoad < WS_REFRESH_COOLDOWN) return;
      loadUsers();
    }, 500);
  }

  function connectAdminWS() {
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    // Token is sent as the first WebSocket message (type: 'auth'), NOT in the URL,
    // so it is never written to proxy access logs.
    const ws = new WebSocket(`${protocol}://${location.host}/ws/admin`);
    adminWs = ws;
    wsStatus = 'connecting';
    wsStatusText = 'Connecting live updates...';

    let _authenticated = false;

    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ type: 'auth', token }));
    });

    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }

      if (!_authenticated) {
        if (msg.type === 'auth_ok') {
          _authenticated = true;
          _reconnectDelay = 2000; // reset backoff on successful connect
          wsStatus = 'connected';
          wsStatusText = '';
        } else if (msg.type === 'auth_failed') {
          wsStatus = 'error';
          wsStatusText = 'Live updates: authentication failed.';
          ws.close();
        }
        return;
      }

      if (msg.type === 'codes_changed') {
        debouncedLoadCodes();
      } else if (msg.type === 'users_changed') {
        // Refresh users if already loaded
        if (activeTab === 'users' || users.length > 0) debouncedLoadUsers();
      }
    });

    ws.addEventListener('error', () => {
      if (adminWs !== ws) return;
      wsStatus = 'reconnecting';
      wsStatusText = 'Live updates interrupted. Reconnecting...';
    });

    ws.addEventListener('close', () => {
      if (adminWs !== ws) return; // superseded
      wsStatus = 'reconnecting';
      wsStatusText = 'Live updates interrupted. Reconnecting...';
      adminWsReconnectTimer = setTimeout(connectAdminWS, _reconnectDelay);
      // Exponential backoff, cap at 30 s
      _reconnectDelay = Math.min(_reconnectDelay * 2, 30_000);
    });
  }

  // Load codes on mount, connect admin WS
  // Hides gradient when content doesn't need to scroll, shows it when it does.
  // Tracks codes.length / users.length / activeTab so it re-runs after async
  // data loads and correctly shows/hides the gradient without waiting for a scroll.
  $effect(() => {
    const el = adminBodyEl;
    // Read reactive data to register as dependencies — re-runs when content changes
    void codes.length;
    void users.length;
    void activeTab;
    if (!el) return;
    adminScrolledNearBottom = false;
    const rafId = requestAnimationFrame(() => {
      if (el.scrollHeight <= el.clientHeight) {
        adminScrolledNearBottom = true;
      }
    });
    return () => {
      cancelAnimationFrame(rafId);
    };
  });

  onMount(() => {
    loadCodes();
    connectAdminWS();
    return () => {
      // Cleanup on panel close
      clearTimeout(adminWsReconnectTimer);
      clearTimeout(_codesDebounce);
      clearTimeout(_usersDebounce);
      if (adminWs) { adminWs.close(); adminWs = null; }
    };
  });

  async function loadCodes() {
    if (codes.length === 0) loading = true;
    try {
      codes = await listCodes(token);
      _lastCodesLoad = Date.now();
    } catch (err) {
      error = err.message;
    } finally {
      loading = false;
      initialLoaded = true;
    }
  }

  async function handleGenerate() {
    generating = true;
    error = '';
    try {
      const expiry = expiresInHours ? parseInt(expiresInHours, 10) : null;
      await generateCode(token, {
        type: codeType,
        usesRemaining: usesRemaining || null,
        expiresInHours: expiry,
      });
      await loadCodes();
    } catch (err) {
      error = err.message;
    } finally {
      generating = false;
    }
  }

  async function handleDelete(id) {
    try {
      await deleteCode(token, id);
      codes = codes.filter(c => c.id !== id);
    } catch (err) {
      error = err.message;
    }
  }

  function startEdit(code) {
    editingCodeId = code.id;
    editUsesRemaining = code.usesRemaining !== null ? String(code.usesRemaining) : '';
    // Convert stored expiresAt timestamp to hours from now (rounded up)
    if (code.expiresAt && Date.now() < code.expiresAt) {
      editExpiresInHours = String(Math.ceil((code.expiresAt - Date.now()) / 3600_000));
    } else {
      editExpiresInHours = '';
    }
    editError = '';
  }

  function cancelEdit() {
    editingCodeId = null;
    editError = '';
  }

  async function handleEditSave(id) {
    editSaving = true;
    editError = '';
    try {
      const uses = editUsesRemaining !== '' ? parseInt(editUsesRemaining, 10) : null;
      const expiry = editExpiresInHours !== '' ? parseFloat(editExpiresInHours) : null;
      await updateCode(token, id, { usesRemaining: uses, expiresInHours: expiry });
      editingCodeId = null;
      // WS will trigger loadCodes(), but also refresh immediately for responsiveness
      await loadCodes();
    } catch (err) {
      editError = err.message;
    } finally {
      editSaving = false;
    }
  }

  async function handleCopy(code, id) {
    await navigator.clipboard.writeText(code);
    copyFeedback = id;
    setTimeout(() => { if (copyFeedback === id) copyFeedback = null; }, 1500);
  }

  function formatExpiry(expiresAt) {
    if (!expiresAt) return 'Never';
    const d = new Date(expiresAt);
    if (Date.now() > expiresAt) return 'Expired';
    const hours = Math.round((expiresAt - Date.now()) / 3600_000);
    if (hours < 1) return '<1h left';
    if (hours < 24) return `${hours}h left`;
    return `${Math.round(hours / 24)}d left`;
  }

  function isExpired(code) {
    return code.expiresAt && Date.now() > code.expiresAt;
  }

  function isDepleted(code) {
    return code.usesRemaining !== null && code.usesRemaining <= 0;
  }

  // Users management
  async function loadUsers() {
    if (users.length === 0) usersLoading = true;
    usersError = '';
    try {
      const filter = userFilter === 'all' ? null : userFilter;
      users = await listUsers(token, filter);
      _lastUsersLoad = Date.now();
    } catch (err) {
      usersError = err.message;
    } finally {
      usersLoading = false;
    }
  }

  async function handleUpdateUser(userId, status) {
    updatingUserId = userId;
    usersError = '';
    try {
      await updateUserStatus(token, userId, status);
      await loadUsers();
    } catch (err) {
      usersError = err.message;
    } finally {
      updatingUserId = null;
    }
  }

  function startEditUses(u) {
    editingUsesId = u.id;
    editUserUnlimited = u.usesRemaining === null;
    editUserUses = u.usesRemaining !== null ? String(u.usesRemaining) : '';
    editUsesError = '';
  }

  function cancelEditUses() {
    editingUsesId = null;
    editUsesError = '';
  }

  async function handleSaveUses(userId) {
    editUsesSaving = true;
    editUsesError = '';
    try {
      const uses = editUserUnlimited ? null : parseInt(editUserUses, 10);
      if (!editUserUnlimited && (isNaN(uses) || uses < 0 || uses > 999999)) {
        editUsesError = 'Enter a number 0–999999';
        return;
      }
      await updateUserUses(token, userId, uses);
      editingUsesId = null;
      await loadUsers();
    } catch (err) {
      editUsesError = err.message;
    } finally {
      editUsesSaving = false;
    }
  }

  function switchTab(tab) {
    activeTab = tab;
    error = '';
    usersError = '';
    if (tab === 'users' && users.length === 0) loadUsers();
  }

  function formatUserDate(iso) {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  // Click-outside action
  function clickOutside(node, callback) {
    const handle = (e) => { if (!node.contains(e.target)) callback(); };
    document.addEventListener('pointerdown', handle, true);
    return { destroy() { document.removeEventListener('pointerdown', handle, true); } };
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_noninteractive_element_interactions -->
<div
  class="admin-backdrop"
  role="dialog"
  aria-modal="true"
  aria-label="Admin Panel"
  tabindex="-1"
  use:dialog={onClose}
  onclick={(e) => { if (e.target === e.currentTarget) onClose(); }}
>
  <div class="admin-panel" use:clickOutside={onClose}>
    <div class="admin-handle"></div>
    <div class="admin-header">
      <div class="tab-bar">
        <button class="tab-btn" class:tab-active={activeTab === 'codes'} onclick={() => switchTab('codes')}>CODES</button>
        <button class="tab-btn" class:tab-active={activeTab === 'users'} onclick={() => switchTab('users')}>USERS</button>
      </div>
      <button class="admin-close" type="button" onclick={onClose} aria-label="Close">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
      </button>
    </div>

    {#if wsStatus !== 'connected'}
      <p class="ws-status">{wsStatusText}</p>
    {/if}

    <div class="admin-body-wrap" class:scrolled-bottom={adminScrolledNearBottom}>
    <div class="admin-body" bind:this={adminBodyEl} onscroll={() => { const el = adminBodyEl; adminScrolledNearBottom = (el.scrollHeight - el.scrollTop - el.clientHeight) < 30; }}>
      {#if activeTab === 'codes'}
      {#if !accessCodesEnabled}
        <div class="codes-disabled-notice">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style="flex-shrink:0;margin-top:1px"><path d="M7 1.5L12.5 11H1.5L7 1.5Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M7 5.5v2.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><circle cx="7" cy="9.5" r="0.6" fill="currentColor"/></svg>
          <span>Access codes are disabled via server configuration. Users cannot log in with codes until this is re-enabled.</span>
        </div>
      {/if}
      <!-- Generate section -->
      <div class="gen-section">
        <span class="section-label">GENERATE NEW CODE</span>
        <div class="type-toggle" role="group" aria-label="Code type">
          <button class="type-opt" class:type-opt-active={codeType === 'registration'} onclick={() => codeType = 'registration'}>REGISTRATION</button>
          <button class="type-opt" class:type-opt-active={codeType === 'job_access'} onclick={() => codeType = 'job_access'}>ACCESS</button>
        </div>
        <div class="gen-row">
          <div class="gen-field">
            <label class="field-label" for="admin-uses">USES</label>
            <input id="admin-uses" type="number" min="1" step="1" bind:value={usesRemaining} placeholder="∞" />
          </div>
          <div class="gen-field">
            <label class="field-label" for="admin-expiry">EXPIRES (HOURS)</label>
            <input id="admin-expiry" type="number" min="1" step="1" bind:value={expiresInHours} placeholder="Never" />
          </div>
        </div>
        <button class="btn-gen" disabled={generating} onclick={handleGenerate}>
          {generating ? 'GENERATING…' : 'GENERATE CODE'}
        </button>
      </div>

      {#if error}
        <p class="error">{error}</p>
      {/if}

      <!-- Code list -->
      <div class="code-list">
        {#if loading && !initialLoaded}
          <p class="empty">Loading…</p>
        {:else if codes.length === 0}
          <p class="empty">No codes yet. Generate one above.</p>
        {:else}
          {#each codes as code (code.id)}
            <div class="code-item" class:code-inactive={isExpired(code) || isDepleted(code)} class:code-editing={editingCodeId === code.id}>
              <div class="code-main">
                <span class="code-value">{code.code}</span>
                <div class="code-meta">
                  <span class="type-badge" class:type-reg={code.type === 'registration'} class:type-access={code.type === 'job_access'}>{code.type === 'registration' ? 'REG' : 'ACCESS'}</span>
                  <span class="separator">·</span>
                  <span>{code.usesRemaining !== null ? `${code.usesRemaining} uses` : '∞ uses'}</span>
                  <span class="separator">·</span>
                  <span>{formatExpiry(code.expiresAt)}</span>
                </div>
              </div>
              <div class="code-actions">
                <button class="btn-icon" onclick={() => handleCopy(code.code, code.id)} aria-label="Copy code">
                  {#if copyFeedback === code.id}
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3 7.5l2.5 2.5L11 4" stroke="var(--accent-primary)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
                  {:else}
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><rect x="4.5" y="4.5" width="7" height="7" rx="1.5" stroke="currentColor" stroke-width="1.2"/><path d="M9.5 4.5V3a1.5 1.5 0 00-1.5-1.5H3A1.5 1.5 0 001.5 3v5A1.5 1.5 0 003 9.5h1.5" stroke="currentColor" stroke-width="1.2"/></svg>
                  {/if}
                </button>
                <button class="btn-icon btn-edit" class:btn-edit-active={editingCodeId === code.id} onclick={() => editingCodeId === code.id ? cancelEdit() : startEdit(code)} aria-label="Edit code">
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M9.5 2.5l2 2-7 7H2.5v-2l7-7z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>
                </button>
                <button class="btn-icon btn-delete" onclick={() => handleDelete(code.id)} aria-label="Revoke code">
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 2l10 10M12 2L2 12" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>
                </button>
              </div>
            </div>
            {#if editingCodeId === code.id}
              <div class="edit-form">
                <div class="edit-row">
                  <div class="gen-field">
                    <label class="field-label" for="edit-uses-{code.id}">USES (∞ = blank)</label>
                    <input id="edit-uses-{code.id}" type="number" min="0" step="1" bind:value={editUsesRemaining} placeholder="∞" />
                  </div>
                  <div class="gen-field">
                    <label class="field-label" for="edit-expiry-{code.id}">EXPIRY IN HOURS (blank = never)</label>
                    <input id="edit-expiry-{code.id}" type="number" min="0.1" step="1" bind:value={editExpiresInHours} placeholder="Never" />
                  </div>
                </div>
                {#if editError}
                  <p class="edit-error">{editError}</p>
                {/if}
                <div class="edit-actions">
                  <button class="btn-edit-save" disabled={editSaving} onclick={() => handleEditSave(code.id)}>
                    {editSaving ? 'SAVING…' : 'SAVE'}
                  </button>
                  <button class="btn-edit-cancel" onclick={cancelEdit}>CANCEL</button>
                </div>
              </div>
            {/if}
          {/each}
        {/if}
      </div>

      {:else}
      <!-- Users tab -->
      <div class="filter-row">
        {#each ['all', 'pending', 'active', 'suspended'] as f}
          <button class="filter-btn" class:filter-active={userFilter === f} onclick={() => { userFilter = f; loadUsers(); }}>
            {f.toUpperCase()}
          </button>
        {/each}
      </div>

      {#if usersError}
        <p class="error">{usersError}</p>
      {/if}

      <div class="user-list">
        {#if usersLoading}
          <p class="empty">Loading…</p>
        {:else if users.length === 0}
          <p class="empty">No users found.</p>
        {:else}
          {#each users as u (u.id)}
            <div class="user-row-wrap">
              <div class="user-item" class:user-item-editing={editingUsesId === u.id}>
                <div class="user-main">
                  <span class="user-email">{u.email}</span>
                  <div class="user-meta">
                    <span class="status-badge" class:status-active={u.status === 'active'} class:status-pending={u.status === 'pending'} class:status-rejected={u.status === 'suspended'}>
                      {u.status.toUpperCase()}
                    </span>
                    {#if u.isAdmin}
                      <span class="role-badge">ADMIN</span>
                    {/if}
                    <span class="uses-badge" class:uses-zero={u.usesRemaining === 0 && !u.isAdmin}>
                      {u.usesRemaining === null ? '∞ uses' : `${u.usesRemaining} uses`}
                    </span>
                    <span class="user-date">{formatUserDate(u.createdAt)}</span>
                  </div>
                </div>
                {#if !u.isAdmin || u.id === selfId}
                  <div class="user-actions">
                    <button class="btn-icon btn-edit" class:btn-edit-active={editingUsesId === u.id} onclick={() => editingUsesId === u.id ? cancelEditUses() : startEditUses(u)} aria-label="Set uses">
                      <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M9.5 2.5l2 2-7 7H2.5v-2l7-7z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>
                    </button>
                    {#if !u.isAdmin}
                      {#if u.status !== 'active'}
                        <button class="btn-small btn-approve" disabled={updatingUserId === u.id} onclick={() => handleUpdateUser(u.id, 'active')} aria-label="Approve user">
                          <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 6.5l2.5 2.5L10 3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
                        </button>
                      {/if}
                      {#if u.status !== 'suspended'}
                        <button class="btn-small btn-reject" disabled={updatingUserId === u.id} onclick={() => handleUpdateUser(u.id, 'suspended')} aria-label="Suspend user">
                          <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
                        </button>
                      {/if}
                    {/if}
                  </div>
                {/if}
              </div>
              {#if editingUsesId === u.id}
                <div class="uses-edit-form">
                  <label class="uses-unlimited-label">
                    <input type="checkbox" bind:checked={editUserUnlimited} />
                    <span>UNLIMITED</span>
                  </label>
                  {#if !editUserUnlimited}
                    <div class="gen-field">
                      <label class="field-label" for="edit-uses-{u.id}">USES (0–999999)</label>
                      <input id="edit-uses-{u.id}" type="number" min="0" max="999999" step="1" bind:value={editUserUses} placeholder="0" />
                    </div>
                  {/if}
                  {#if editUsesError}
                    <p class="edit-error">{editUsesError}</p>
                  {/if}
                  <div class="edit-actions">
                    <button class="btn-edit-save" disabled={editUsesSaving} onclick={() => handleSaveUses(u.id)}>
                      {editUsesSaving ? 'SAVING…' : 'SAVE'}
                    </button>
                    <button class="btn-edit-cancel" onclick={cancelEditUses}>CANCEL</button>
                  </div>
                </div>
              {/if}
            </div>
          {/each}
        {/if}
      </div>
      {/if}
    </div>
    </div><!-- /admin-body-wrap -->
  </div>
</div>

<style>
  .admin-backdrop {
    position: fixed;
    inset: 0;
    z-index: 60;
    background: var(--surface-backdrop);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    display: flex;
    align-items: flex-end;
    justify-content: center;
    animation: admin-backdrop-in 0.22s ease both;
  }

  @keyframes admin-backdrop-in {
    from { opacity: 0; }
    to   { opacity: 1; }
  }

  .admin-panel {
    width: 100%;
    max-width: 440px;
    background: var(--surface-raised-glass);
    border: 1px solid var(--border-default);
    border-radius: 1.25rem 1.25rem 0 0;
    padding: 0 1.75rem 1.75rem;
    backdrop-filter: blur(24px);
    -webkit-backdrop-filter: blur(24px);
    display: flex;
    flex-direction: column;
    gap: 0;
    max-height: 85dvh;
    overflow: hidden;
    animation: admin-sheet-up 0.28s cubic-bezier(0.16, 1, 0.3, 1) both;
  }

  @keyframes admin-sheet-up {
    from { transform: translateY(100%); opacity: 0; }
    to   { transform: translateY(0);    opacity: 1; }
  }

  @media (min-width: 600px) {
    .admin-backdrop { align-items: center; }
    .admin-panel {
      border-radius: 1.25rem;
      max-height: 80vh;
      animation: admin-panel-in 0.24s cubic-bezier(0.16, 1, 0.3, 1) both;
    }
    @keyframes admin-panel-in {
      from { transform: scale(0.96) translateY(-6px); opacity: 0; }
      to   { transform: scale(1)    translateY(0);    opacity: 1; }
    }
  }

  .admin-handle {
    width: 2.5rem;
    height: 3px;
    border-radius: 9999px;
    background: var(--border-default);
    align-self: center;
    margin: 1rem 0 0.75rem;
    flex-shrink: 0;
  }

  @media (min-width: 600px) {
    .admin-handle { display: none; }
  }

  .admin-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 1rem 0;
    flex-shrink: 0;
  }

  @media (min-width: 600px) {
    .admin-header { padding-top: 1.5rem; }
  }

  .admin-close {
    width: 2rem;
    height: 2rem;
    border-radius: 50%;
    border: 1px solid var(--border-subtle);
    background: var(--surface-well-glass);
    color: var(--text-secondary);
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: transform 0.12s ease, filter 0.12s ease, background 0.2s, color 0.2s;
    flex-shrink: 0;
  }
  .admin-close:hover { background: var(--surface-hover); color: var(--text-primary); }
  .admin-close:active { transform: scale(0.88); filter: brightness(0.85); }

  .admin-body-wrap {
    position: relative;
    flex: 1;
    min-height: 0;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  .admin-body-wrap::after {
    content: '';
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    height: 4rem;
    background: linear-gradient(to bottom, transparent, var(--surface-raised-glass));
    pointer-events: none;
    transition: opacity 0.3s ease;
  }
  .admin-body-wrap.scrolled-bottom::after {
    opacity: 0;
  }

  .admin-body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
    scrollbar-width: thin;
    scrollbar-color: var(--border-strong) transparent;
  }

  .ws-status {
    margin: 0 0 0.7rem;
    padding: 0.5rem 0.65rem;
    border: 1px solid var(--state-warning-border);
    border-radius: 0.62rem;
    background: var(--state-warning-bg);
    color: var(--state-warning);
    font-family: 'DM Mono', monospace;
    font-size: 0.66rem;
    letter-spacing: 0.05em;
  }

  .codes-disabled-notice {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    margin: 0 0 0.9rem;
    padding: 0.5rem 0.65rem;
    border: 1px solid var(--state-warning-border);
    border-radius: 0.62rem;
    background: var(--state-warning-bg);
    color: var(--state-warning);
    font-family: 'DM Mono', monospace;
    font-size: 0.66rem;
    line-height: 1.55;
    letter-spacing: 0.05em;
  }
  .admin-body::-webkit-scrollbar { width: 4px; }
  .admin-body::-webkit-scrollbar-track { background: transparent; }
  .admin-body::-webkit-scrollbar-thumb { background: var(--border-strong); border-radius: 2px; }

  .gen-section {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .section-label {
    font-family: 'DM Mono', monospace;
    font-size: 0.65rem;
    letter-spacing: 0.2em;
    color: var(--text-muted);
  }

  .gen-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.75rem;
  }

  .gen-field {
    display: flex;
    flex-direction: column;
  }

  .field-label {
    display: block;
    font-family: 'DM Mono', monospace;
    font-size: 0.6rem;
    letter-spacing: 0.18em;
    color: var(--text-secondary);
    margin-bottom: 0.35rem;
  }

  input[type='number'] {
    padding: 0.72rem 1rem;
    border: 1px solid var(--border-subtle);
    border-radius: 0.75rem;
    background: var(--surface-well-glass);
    color: var(--text-primary);
    font-family: 'DM Mono', monospace;
    font-size: 0.85rem;
    outline: none;
    width: 100%;
    transition: border-color 0.2s;
    -moz-appearance: textfield;
    -webkit-appearance: textfield;
    appearance: textfield;
  }

  input[type='number']::-webkit-inner-spin-button,
  input[type='number']::-webkit-outer-spin-button {
    -webkit-appearance: none;
    margin: 0;
  }

  input[type='number']::placeholder { color: var(--text-muted); }
  input[type='number']:focus { border-color: var(--border-focus); }

  .btn-gen {
    padding: 0.8rem;
    border: none;
    border-radius: 3rem;
    background: var(--accent-primary);
    color: var(--text-on-accent);
    font-family: 'DM Mono', monospace;
    font-size: 0.72rem;
    font-weight: 500;
    letter-spacing: 0.14em;
    cursor: pointer;
    transition: transform 0.12s ease, filter 0.12s ease, background 0.2s;
  }
  .btn-gen:hover:not(:disabled) { background: var(--accent-primary-hover); }
  .btn-gen:active:not(:disabled) { transform: scale(0.96); filter: brightness(0.85); }
  .btn-gen:disabled { opacity: 0.5; cursor: not-allowed; }

  .error {
    font-family: 'DM Mono', monospace;
    color: var(--state-error);
    font-size: 0.75rem;
    margin: 0;
  }

  .code-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .empty {
    font-family: 'DM Mono', monospace;
    font-size: 0.75rem;
    color: var(--text-muted);
    margin: 0;
    text-align: center;
    padding: 1rem 0;
  }

  .code-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 0.65rem 0.875rem;
    background: var(--surface-hover);
    border: 1px solid var(--border-subtle);
    border-radius: 0.75rem;
    transition: opacity 0.2s;
  }

  .code-inactive {
    opacity: 0.4;
  }

  .code-main {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    min-width: 0;
  }

  .code-value {
    font-family: 'DM Mono', monospace;
    font-size: 0.8rem;
    color: var(--text-primary);
    letter-spacing: 0.08em;
  }

  .code-meta {
    font-family: 'DM Mono', monospace;
    font-size: 0.72rem;
    color: var(--text-muted);
    letter-spacing: 0.04em;
    display: flex;
    gap: 0.3rem;
  }

  .separator {
    color: var(--text-muted);
  }

  .code-actions {
    display: flex;
    gap: 0.35rem;
    flex-shrink: 0;
  }

  .btn-icon {
    width: 2rem;
    height: 2rem;
    border-radius: 0.5rem;
    border: 1px solid var(--border-subtle);
    background: transparent;
    color: var(--text-secondary);
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: transform 0.12s ease, background 0.2s, color 0.2s;
  }
  .btn-icon:hover { background: var(--surface-hover); color: var(--text-primary); }
  .btn-icon:active { transform: scale(0.88); }

  .btn-delete:hover { color: var(--state-error); }
  .btn-edit:hover { color: var(--accent-primary); }
  .btn-edit-active { color: var(--accent-primary); background: var(--accent-primary-glow); }

  /* Tabs */
  .tab-bar {
    display: flex;
    gap: 0.25rem;
  }
  .tab-btn {
    padding: 0.4rem 0.75rem;
    border: none;
    border-radius: 3rem;
    background: transparent;
    font-family: 'DM Mono', monospace;
    font-size: 0.72rem;
    letter-spacing: 0.18em;
    color: var(--text-muted);
    cursor: pointer;
    transition: background 0.2s, color 0.2s;
  }
  .tab-btn:hover { color: var(--text-secondary); }
  .tab-active {
    background: var(--accent-primary-glow);
    color: var(--accent-primary);
  }

  /* User filter */
  .filter-row {
    display: flex;
    gap: 0.35rem;
    flex-wrap: wrap;
  }
  .filter-btn {
    padding: 0.35rem 0.65rem;
    border: 1px solid var(--border-subtle);
    border-radius: 3rem;
    background: transparent;
    font-family: 'DM Mono', monospace;
    font-size: 0.68rem;
    letter-spacing: 0.12em;
    color: var(--text-muted);
    cursor: pointer;
    transition: background 0.2s, color 0.2s, border-color 0.2s;
  }
  .filter-btn:hover { color: var(--text-secondary); border-color: var(--border-default); }
  .filter-active {
    background: var(--accent-primary-glow);
    color: var(--accent-primary);
    border-color: var(--accent-primary-dim);
  }

  /* User list */
  .user-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .user-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 0.65rem 0.875rem;
    background: var(--surface-hover);
    border: 1px solid var(--border-subtle);
    border-radius: 0.75rem;
  }
  .user-main {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    min-width: 0;
  }
  .user-email {
    font-family: 'DM Mono', monospace;
    font-size: 0.75rem;
    color: var(--text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .user-meta {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-family: 'DM Mono', monospace;
    font-size: 0.68rem;
  }
  .status-badge {
    padding: 0.1rem 0.4rem;
    border-radius: 3rem;
    font-size: 0.62rem;
    letter-spacing: 0.1em;
  }
  .status-active { background: var(--state-success-bg); color: var(--state-success); }
  .status-pending { background: var(--state-warning-bg); color: var(--state-warning); }
  .status-rejected { background: var(--state-error-bg); color: var(--state-error); }
  .role-badge {
    padding: 0.1rem 0.4rem;
    border-radius: 3rem;
    background: var(--accent-primary-dim);
    color: var(--accent-primary);
    font-size: 0.62rem;
    letter-spacing: 0.1em;
  }
  .user-date { color: var(--text-muted); }
  .user-actions {
    display: flex;
    gap: 0.3rem;
    flex-shrink: 0;
  }
  .btn-small {
    width: 1.75rem;
    height: 1.75rem;
    border-radius: 0.5rem;
    border: 1px solid var(--border-subtle);
    background: transparent;
    font-size: 0.7rem;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: transform 0.12s, background 0.2s, color 0.2s;
  }
  .btn-small:active { transform: scale(0.88); }
  .btn-small:disabled { opacity: 0.4; cursor: not-allowed; }
  .btn-approve { color: var(--state-success); }
  .btn-approve:hover { background: var(--state-success-bg); }
  .btn-reject { color: var(--state-error); }
  .btn-reject:hover { background: var(--state-error-bg); }

  /* User row wrapper + uses editing */
  .user-row-wrap {
    display: flex;
    flex-direction: column;
    gap: 0;
  }

  .user-item-editing {
    border-color: var(--accent-primary-border);
    border-bottom-left-radius: 0;
    border-bottom-right-radius: 0;
  }

  .uses-badge {
    padding: 0.1rem 0.4rem;
    border-radius: 3rem;
    background: var(--surface-well-glass);
    color: var(--text-secondary);
    font-size: 0.62rem;
    letter-spacing: 0.08em;
    font-family: 'DM Mono', monospace;
  }

  .uses-zero {
    background: var(--state-warning-bg);
    color: var(--state-warning);
  }

  .uses-edit-form {
    padding: 0.75rem;
    background: var(--accent-primary-glow);
    border: 1px solid var(--accent-primary-dim);
    border-top: none;
    border-bottom-left-radius: 0.75rem;
    border-bottom-right-radius: 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.65rem;
  }

  .uses-unlimited-label {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    cursor: pointer;
    font-family: 'DM Mono', monospace;
    font-size: 0.68rem;
    letter-spacing: 0.14em;
    color: var(--accent-primary);
    user-select: none;
  }

  .uses-unlimited-label input[type='checkbox'] {
    accent-color: var(--accent-primary);
    width: 0.9rem;
    height: 0.9rem;
    cursor: pointer;
  }

  @media (hover: none) and (pointer: coarse) {
    input[type='number'] { font-size: 16px !important; }
  }

  /* Code type toggle */
  .type-toggle {
    display: flex;
    background: var(--surface-hover);
    border: 1px solid var(--border-subtle);
    border-radius: 3rem;
    padding: 0.2rem;
  }
  .type-opt {
    flex: 1;
    padding: 0.4rem 0.75rem;
    border: none;
    border-radius: 3rem;
    background: transparent;
    font-family: 'DM Mono', monospace;
    font-size: 0.72rem;
    letter-spacing: 0.14em;
    color: var(--text-muted);
    cursor: pointer;
    transition: background 0.18s, color 0.18s;
  }
  .type-opt:hover { color: var(--text-secondary); }
  .type-opt-active { background: var(--accent-primary-dim); color: var(--accent-primary); }

  /* Code type badge in list */
  .type-badge {
    padding: 0.1rem 0.4rem;
    border-radius: 3rem;
    font-size: 0.62rem;
    letter-spacing: 0.1em;
    font-family: 'DM Mono', monospace;
  }
  .type-reg { background: var(--accent-primary-dim); color: var(--accent-primary); }
  .type-access { background: var(--badge-purple-bg); color: var(--badge-purple); }

  /* Inline code edit form */
  .code-editing {
    border-color: var(--accent-primary-border);
  }

  .edit-form {
    padding: 0.75rem;
    background: var(--accent-primary-glow);
    border: 1px solid var(--accent-primary-dim);
    border-radius: 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.65rem;
    margin-top: -0.25rem;
  }

  .edit-form .field-label {
    white-space: normal;
    line-height: 1.4;
  }

  .edit-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.65rem;
    align-items: end;
  }

  .edit-actions {
    display: flex;
    gap: 0.5rem;
  }

  .btn-edit-save {
    flex: 1;
    padding: 0.5rem 0;
    border: none;
    border-radius: 0.6rem;
    background: var(--accent-primary-dim);
    color: var(--accent-primary);
    font-family: 'DM Mono', monospace;
    font-size: 0.65rem;
    letter-spacing: 0.14em;
    cursor: pointer;
    transition: background 0.18s, color 0.18s;
  }
  .btn-edit-save:hover:not(:disabled) { background: var(--accent-primary-glow); color: var(--accent-primary-hover); }
  .btn-edit-save:disabled { opacity: 0.5; cursor: not-allowed; }

  .btn-edit-cancel {
    padding: 0.5rem 0.9rem;
    border: 1px solid var(--border-subtle);
    border-radius: 0.6rem;
    background: transparent;
    color: var(--text-muted);
    font-family: 'DM Mono', monospace;
    font-size: 0.65rem;
    letter-spacing: 0.14em;
    cursor: pointer;
    transition: background 0.18s, color 0.18s;
  }
  .btn-edit-cancel:hover { background: var(--surface-hover); color: var(--text-secondary); }

  .edit-error {
    font-family: 'DM Mono', monospace;
    font-size: 0.72rem;
    color: var(--state-error);
    margin: 0;
  }
</style>

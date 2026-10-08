(() => {
  'use strict';

  const CONFIG = window.APP_CONFIG || {};
  const CATEGORIES = [
    'Food & Groceries',
    'Housing & Utilities',
    'Education',
    'Transportation',
    'Healthcare & Medical',
    'Communication & Technology',
    'Personal Care & Clothing',
    'Entertainment & Festivals',
    'Debt & EMI',
    'Savings & Emergency Fund',
    'Miscellaneous'
  ];
  const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const EXPENSE_HEADERS = ['ID','Date','Expense Category','Amount','Created At','Updated At'];
  const SETTINGS_HEADERS = ['Key','Value'];
  const AUDIT_HEADERS = ['Timestamp','Action','Expense ID','Details'];
  const REQUIRED_SCOPE = 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/spreadsheets';
  const DRIVE_API = 'https://www.googleapis.com/drive/v3';
  const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';
  const DATABASE_POINTER_KEY = 'expenseTrackerDatabaseId';

  const state = {
    accessToken: null,
    accessTokenExpiresAt: 0,
    tokenClient: null,
    googleIdentity: null,
    spreadsheetId: null,
    spreadsheetName: CONFIG.DATABASE_NAME || 'Expense_Tracker_DB',
    folderId: null,
    expenses: [],
    selectedYear: new Date().getFullYear(),
    selectedMonth: new Date().getMonth() + 1,
    monthlyYear: new Date().getFullYear(),
    monthlyMonth: new Date().getMonth() + 1,
    yearlyYear: new Date().getFullYear(),
    filters: { search: '', category: 'ALL', date: '', amount: '' },
    currentTab: 'expenses',
    dbStatus: 'Disconnected',
    isBusy: false,
    pendingConfirm: null,
    undoTimer: null,
    lastDeleted: null,
    lastSyncAt: null,
    refreshInFlight: false,
    connectionInFlight: null,
    silentRestoreAttempted: false,
    tokenRequestInFlight: null,
    tokenRequestMode: null,
    tokenRequestSequence: 0,
    activeTokenRequestId: 0,
    apiAuthorizationGranted: false
  };

  const $ = (id) => document.getElementById(id);
  const qs = (sel, root = document) => root.querySelector(sel);
  const qsa = (sel, root = document) => [...root.querySelectorAll(sel)];
  const nativeAuthPending = new Map();
  let nativeAuthSequence = 0;

  function isNativeApp() {
    return Boolean(window.AndroidExpenseBridge);
  }

  function isConfigured() {
    if (isNativeApp()) return true;
    return Boolean(CONFIG.CLIENT_ID && !CONFIG.CLIENT_ID.startsWith('YOUR_'));
  }

  // Native Android returns short-lived access tokens through this callback.
  // The token is held only in JS runtime memory and is never persisted by this page.
  window.__expenseNativeAuthResult = function(callbackId, payloadText) {
    const key = String(callbackId);
    const finish = nativeAuthPending.get(key);
    if (!finish) return;
    nativeAuthPending.delete(key);
    finish(payloadText);
  };

  async function requestNativeAccessToken(mode = 'silent') {
    if (!isNativeApp()) return false;
    const callbackId = `native-auth-${Date.now()}-${++nativeAuthSequence}`;
    const interactive = mode !== 'silent';
    return new Promise(resolve => {
      let settled = false;
      const timeoutId = window.setTimeout(() => {
        nativeAuthPending.delete(callbackId);
        if (interactive) showToast('Google authorization timed out. Please try again.', 'error', 8000);
        finish(false);
      }, interactive ? 90000 : 25000);
      function finish(value) {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeoutId);
        resolve(value);
      }
      nativeAuthPending.set(callbackId, payloadText => {
        let response;
        try { response = typeof payloadText === 'string' ? JSON.parse(payloadText) : payloadText; }
        catch { finish(false); return; }
        if (response?.ok && response.access_token) {
          state.accessToken = response.access_token;
          state.accessTokenExpiresAt = Date.now() + Math.max(30, Number(response.expires_in || 3600) - 30) * 1000;
          state.apiAuthorizationGranted = true;
          if (response.identity) {
            state.googleIdentity = response.identity;
            updateAccountUI();
          }
          finish(true);
          return;
        }
        if (response?.error && response.error !== 'interaction_required' && interactive) {
          showToast(`Google authorization failed: ${response.error}`, 'error', 8000);
        }
        finish(false);
      });
      try {
        window.AndroidExpenseBridge.authorize(interactive, callbackId);
      } catch (err) {
        nativeAuthPending.delete(callbackId);
        if (interactive) showToast(`Could not start Google authorization: ${err.message}`, 'error');
        finish(false);
      }
    });
  }

  function getStoredDatabaseId() {
    try {
      const id = window.localStorage.getItem(DATABASE_POINTER_KEY);
      return id && /^[A-Za-z0-9_-]{10,}$/.test(id) ? id : null;
    } catch {
      return null;
    }
  }

  function setStoredDatabaseId(id) {
    if (!id) return;
    try {
      window.localStorage.setItem(DATABASE_POINTER_KEY, id);
    } catch {
      // The database pointer is only an optimization. The cloud database remains authoritative.
    }
  }

  function clearStoredDatabaseId() {
    try {
      window.localStorage.removeItem(DATABASE_POINTER_KEY);
    } catch {
      // Ignore storage failures.
    }
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function showToast(message, type = 'info', duration = 4200) {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    const icon = type === 'success' ? '✓' : type === 'error' ? '!' : type === 'warning' ? '⚠' : 'i';
    toast.innerHTML = `<span class="toast-icon">${icon}</span><span>${escapeHtml(message)}</span>`;
    $('toastRegion').appendChild(toast);
    window.setTimeout(() => toast.remove(), duration);
  }

  function setSyncStatus(status, textOverride = '') {
    const pill = $('syncPill');
    const text = $('syncText');
    pill.className = `sync-pill ${status}`;
    const labels = {
      neutral: 'Connecting',
      syncing: 'Syncing...',
      success: 'Synced',
      warning: 'Reconnect Required',
      error: 'Sync Error'
    };
    text.textContent = textOverride || labels[status] || 'Status';
    state.dbStatus = text.textContent;
    if ($('settingsDbStatus')) $('settingsDbStatus').textContent = text.textContent;
  }

  function showAuthScreen() {
    $('authScreen').classList.remove('hidden');
    $('mainApp').classList.add('hidden');
  }

  function showMainApp() {
    $('authScreen').classList.add('hidden');
    $('mainApp').classList.remove('hidden');
  }

  function applyTheme() {
    let saved = 'light';
    try { saved = window.localStorage.getItem('expenseTrackerTheme') || 'light'; } catch { /* Storage may be blocked by browser privacy settings. */ }
    document.body.classList.toggle('theme-dark', saved === 'dark');
    $('themeToggle').textContent = saved === 'dark' ? '☀' : '☾';
  }

  function toggleTheme() {
    const dark = !document.body.classList.contains('theme-dark');
    document.body.classList.toggle('theme-dark', dark);
    try { window.localStorage.setItem('expenseTrackerTheme', dark ? 'dark' : 'light'); } catch { /* Theme still toggles for this session. */ }
    $('themeToggle').textContent = dark ? '☀' : '☾';
  }

  function pad2(n) { return String(n).padStart(2, '0'); }
  function localDateInputValue(date = new Date()) { return `${date.getFullYear()}-${pad2(date.getMonth()+1)}-${pad2(date.getDate())}`; }
  function currentYear() { return new Date().getFullYear(); }
  function currentMonth() { return new Date().getMonth() + 1; }

  function formatDate(dateStr) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr;
    const [y, m, d] = dateStr.split('-').map(Number);
    return `${pad2(d)} ${MONTHS[m - 1].slice(0,3)} ${y}`;
  }

  function formatMoney(amount) {
    const safe = Number.isFinite(Number(amount)) ? Number(amount) : 0;
    return `${CONFIG.CURRENCY_SYMBOL || '৳'}${safe.toLocaleString('en-BD', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  function normalizeAmount(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    return Math.round((n + Number.EPSILON) * 100) / 100;
  }

  function normalizeDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const [y, m, d] = value.split('-').map(Number);
    const test = new Date(Date.UTC(y, m - 1, d));
    if (test.getUTCFullYear() !== y || test.getUTCMonth() + 1 !== m || test.getUTCDate() !== d) return null;
    return value;
  }

  function monthKey(dateStr) { return dateStr.slice(0, 7); }
  function yearOf(dateStr) { return Number(dateStr.slice(0, 4)); }
  function monthOf(dateStr) { return Number(dateStr.slice(5, 7)); }

  function ensureYearOptions() {
    const years = new Set([currentYear(), state.selectedYear, state.monthlyYear, state.yearlyYear]);
    for (const e of state.expenses) years.add(yearOf(e.date));
    const list = [...years].filter(Number.isFinite).sort((a,b) => b-a);
    for (const id of ['expenseYear','monthlyYear','yearlyYear']) {
      const el = $(id);
      if (!el) continue;
      const val = id === 'expenseYear' ? state.selectedYear : id === 'monthlyYear' ? state.monthlyYear : state.yearlyYear;
      el.innerHTML = list.map(y => `<option value="${y}">${y}</option>`).join('');
      el.value = String(val);
    }
  }

  function fillCategorySelects() {
    const options = CATEGORIES.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
    $('expenseCategory').innerHTML = options;
    $('categoryFilter').innerHTML = `<option value="ALL">All categories</option>${options}`;
  }

  function fillMonthSelects() {
    const options = MONTHS.map((m, i) => `<option value="${i+1}">${m}</option>`).join('');
    $('expenseMonth').innerHTML = options;
    $('monthlyMonth').innerHTML = options;
    $('expenseMonth').value = String(state.selectedMonth);
    $('monthlyMonth').value = String(state.monthlyMonth);
  }

  function setInitialSelectors() {
    state.selectedYear = currentYear();
    state.selectedMonth = currentMonth();
    state.monthlyYear = state.selectedYear;
    state.monthlyMonth = state.selectedMonth;
    state.yearlyYear = state.selectedYear;
    ensureYearOptions();
    fillMonthSelects();
  }

  function sortExpenses(expenses) {
    return [...expenses].sort((a,b) => {
      const dateDiff = a.date.localeCompare(b.date);
      if (dateDiff !== 0) return dateDiff;
      const c = String(a.createdAt).localeCompare(String(b.createdAt));
      if (c !== 0) return c;
      return a.id.localeCompare(b.id);
    });
  }

  function generateExpenseId(date) {
    const ymd = date.replaceAll('-', '');
    const suffix = (window.crypto?.randomUUID ? window.crypto.randomUUID().replaceAll('-', '').slice(0, 10) : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`).toUpperCase();
    return `EXP-${ymd}-${suffix}`;
  }

  function validateExpenseObject(expense) {
    const errors = [];
    if (!expense || typeof expense !== 'object') errors.push('Invalid expense record.');
    if (!expense.id || typeof expense.id !== 'string') errors.push('Missing expense ID.');
    if (!normalizeDate(expense.date)) errors.push('Invalid date.');
    if (!CATEGORIES.includes(expense.category)) errors.push('Invalid expense category.');
    if (normalizeAmount(expense.amount) === null) errors.push('Amount must be greater than zero.');
    if (!expense.createdAt || Number.isNaN(Date.parse(expense.createdAt))) errors.push('Invalid created timestamp.');
    if (!expense.updatedAt || Number.isNaN(Date.parse(expense.updatedAt))) errors.push('Invalid updated timestamp.');
    return errors;
  }

  function parseSheetRows(values) {
    const rows = Array.isArray(values) ? values : [];
    const data = rows.slice(1);
    const valid = [];
    const invalid = [];
    for (const row of data) {
      if (!row || row.every(v => String(v ?? '').trim() === '')) continue;
      const expense = {
        id: String(row[0] ?? '').trim(),
        date: String(row[1] ?? '').trim(),
        category: String(row[2] ?? '').trim(),
        amount: normalizeAmount(row[3]),
        createdAt: String(row[4] ?? '').trim(),
        updatedAt: String(row[5] ?? '').trim()
      };
      const errors = validateExpenseObject(expense);
      if (errors.length) invalid.push({ expense, errors }); else valid.push(expense);
    }
    return { valid, invalid };
  }

  function authErrorFromResponse(resp, bodyText) {
    const err = new Error(`Google API ${resp.status}: ${bodyText || resp.statusText}`);
    err.status = resp.status;
    err.body = bodyText;
    return err;
  }

  function createAuthorizationRequiredError(message = 'Google authorization is required.') {
    const err = new Error(message);
    err.code = 'AUTH_REQUIRED';
    err.status = 401;
    return err;
  }

  function isSilentAuthError(response) {
    const code = String(response?.error || '').toLowerCase();
    return [
      'interaction_required',
      'login_required',
      'account_selection_required',
      'consent_required'
    ].includes(code);
  }

  async function googleFetch(url, options = {}, retry = true) {
    if (!state.accessToken) {
      throw createAuthorizationRequiredError();
    }

    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 30000);
    const headers = new Headers(options.headers || {});
    headers.set('Authorization', `Bearer ${state.accessToken}`);
    if (!headers.has('Accept')) headers.set('Accept', 'application/json');

    let response;
    try {
      response = await fetch(url, { ...options, headers, signal: controller.signal });
    } catch (err) {
      if (err?.name === 'AbortError') {
        const timeoutError = new Error('Google API request timed out. Please try again.');
        timeoutError.code = 'API_TIMEOUT';
        throw timeoutError;
      }
      throw err;
    } finally {
      window.clearTimeout(timeout);
    }

    if (response.status === 401 && retry) {
      // Never start an interactive OAuth flow automatically from an API request.
      // Refresh the access token silently first. If Google requires interaction,
      // leave that to the explicit Reconnect button.
      const refreshed = await requestAccessToken({ mode: 'silent' });
      if (refreshed) return googleFetch(url, options, false);

      state.accessToken = null;
      state.accessTokenExpiresAt = 0;
      state.apiAuthorizationGranted = false;
      throw createAuthorizationRequiredError('Google authorization expired. Please reconnect.');
    }

    if (!response.ok) {
      throw authErrorFromResponse(response, await response.text());
    }

    if (response.status === 204) return null;

    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }

  async function requestAccessToken({ mode = 'silent' } = {}) {
    if (isNativeApp()) return requestNativeAccessToken(mode);
    if (!state.tokenClient || !window.google?.accounts?.oauth2) return false;

    if (state.tokenRequestInFlight) {
      // Concurrent refreshes can share the same promise. A real user gesture
      // must be allowed to supersede a background silent request, otherwise a
      // sign-in click during that short window could inherit its failed result.
      if (mode === 'silent' || state.tokenRequestMode !== 'silent') {
        return state.tokenRequestInFlight;
      }
    }

    const supersedingSilent = Boolean(
      state.tokenRequestInFlight &&
      state.tokenRequestMode === 'silent' &&
      mode !== 'silent'
    );
    const client = supersedingSilent
      ? google.accounts.oauth2.initTokenClient({
          client_id: CONFIG.CLIENT_ID,
          scope: REQUIRED_SCOPE,
          callback: () => {}
        })
      : state.tokenClient;
    const requestId = ++state.tokenRequestSequence;
    state.activeTokenRequestId = requestId;

    const promise = new Promise(resolve => {
      let settled = false;
      let timeoutId = null;
      const finish = value => {
        if (settled) return;
        settled = true;
        if (timeoutId !== null) window.clearTimeout(timeoutId);
        resolve(value);
      };

      timeoutId = window.setTimeout(() => {
        if (requestId !== state.activeTokenRequestId) {
          finish(false);
          return;
        }
        if (mode !== 'silent') {
          setSyncStatus('error', 'Sync Error');
          showToast('Google authorization timed out. Please try again.', 'error', 8000);
        }
        finish(false);
      }, 15000);

      client.callback = response => {
        // Ignore a late callback from an older silent attempt if an interactive
        // user-initiated request has taken priority.
        if (requestId !== state.activeTokenRequestId) {
          finish(false);
          return;
        }

        if (response?.error) {
          if (mode === 'silent' && isSilentAuthError(response)) {
            finish(false);
            return;
          }
          setSyncStatus('warning', 'Reconnect Required');
          showToast(`Google authorization failed: ${response.error}`, 'error', 7000);
          finish(false);
          return;
        }

        if (!response?.access_token) {
          finish(false);
          return;
        }

        state.accessToken = response.access_token;
        state.accessTokenExpiresAt = Date.now() + Math.max(
          30,
          Number(response.expires_in || 3600) - 30
        ) * 1000;
        state.apiAuthorizationGranted = true;
        finish(true);
      };

      try {
        const prompt = mode === 'consent' ? 'consent' : mode === 'silent' ? 'none' : '';
        client.requestAccessToken({ prompt });
      } catch (err) {
        if (mode !== 'silent') {
          showToast(`Could not start Google authorization: ${err.message}`, 'error');
        }
        finish(false);
      }
    });

    state.tokenRequestInFlight = promise;
    state.tokenRequestMode = mode;
    try {
      return await promise;
    } finally {
      if (state.tokenRequestInFlight === promise) {
        state.tokenRequestInFlight = null;
        state.tokenRequestMode = null;
      }
    }
  }

  async function ensureAccessToken({ allowInteractive = false } = {}) {
    if (
      state.accessToken &&
      Date.now() < state.accessTokenExpiresAt
    ) {
      return true;
    }

    // Explicit Sign-In/Reconnect must NOT wait for a silent request first.
    // The Google identity callback already proves a user interaction occurred.
    if (allowInteractive) {
      return requestAccessToken({ mode: 'interactive' });
    }

    // Page refresh / token expiry: try silent restoration only.
    return requestAccessToken({ mode: 'silent' });
  }

  async function restoreSessionSilently() {
    if (
      state.silentRestoreAttempted ||
      !isConfigured() ||
      (!isNativeApp() && !state.tokenClient) ||
      (isNativeApp() ? !window.AndroidExpenseBridge.hasRememberedSession() : !getStoredDatabaseId())
    ) {
      return false;
    }

    state.silentRestoreAttempted = true;

    try {
      const ok = await ensureAccessToken({ allowInteractive: false });
      if (!ok) {
        setSyncStatus('neutral', 'Sign in required');
        if (isNativeApp()) $('reconnectAuthBtn').classList.remove('hidden');
        showAuthScreen();
        return false;
      }

      await connectToDatabase({ allowInteractive: false });

      return true;
    } catch (err) {
      console.debug('Silent Google session restore unavailable:', err);
      state.accessToken = null;
      state.accessTokenExpiresAt = 0;
      state.apiAuthorizationGranted = false;
      setSyncStatus('neutral', 'Sign in required');
      if (isNativeApp()) $('reconnectAuthBtn').classList.remove('hidden');
      showAuthScreen();
      return false;
    }
  }

  function decodeJwtPayload(jwt) {
    try {
      const [, payload] = jwt.split('.');
      const base64 = payload.replaceAll('-', '+').replaceAll('_', '/');
      const json = decodeURIComponent(atob(base64.padEnd(base64.length + ((4 - base64.length % 4) % 4), '='))
        .split('').map(c => `%${`00${c.charCodeAt(0).toString(16)}`.slice(-2)}`).join(''));
      return JSON.parse(json);
    } catch {
      return null;
    }
  }

  function handleGoogleIdentity(response) {
    const payload = decodeJwtPayload(response.credential);
    if (!payload) {
      showToast('Google identity response could not be read.', 'error');
      return;
    }

    state.googleIdentity = {
      email: payload.email || '',
      name: payload.name || 'Google Account',
      picture: payload.picture || ''
    };

    updateAccountUI();

    // This callback follows an explicit Google sign-in interaction, so it is
    // allowed to obtain the Sheets/Drive scope interactively if needed.
    startGoogleApiConnection(false, true);
  }

  async function connectToDatabase({ allowInteractive = false } = {}) {
    if (!isConfigured()) return false;
    if (state.connectionInFlight) return state.connectionInFlight;

    state.connectionInFlight = (async () => {
      setSyncStatus('syncing', 'Authorizing Google');
      showMainApp();

      const ok = await ensureAccessToken({ allowInteractive });
      if (!ok) {
        showAuthScreen();
        setSyncStatus('warning', 'Sign in required');
        return false;
      }

      setSyncStatus('syncing', 'Connecting to Google Drive');
      await bootstrapDatabase();
      try {
        await loadAllExpenses();
      } catch (err) {
        if (err?.status !== 404) throw err;
        await refreshDatabaseReferenceAfterNotFound();
        await loadAllExpenses();
      }
      renderAll();
      setSyncStatus('success', 'Synced');
      return true;
    })().catch(err => {
      handleApiError(err);
      return false;
    }).finally(() => {
      state.connectionInFlight = null;
    });

    return state.connectionInFlight;
  }

  async function startGoogleApiConnection(forceConsent = false, fromUserSignIn = false) {
    if (!isConfigured()) return false;

    if (forceConsent) {
      setSyncStatus('syncing', 'Reconnecting');
      showMainApp();

      const ok = await requestAccessToken({ mode: 'consent' });
      if (!ok) return false;

      state.connectionInFlight = null;
    }

    const connected = await connectToDatabase({
      allowInteractive: Boolean(fromUserSignIn)
    });

    if (connected && (forceConsent || fromUserSignIn)) {
      showToast('Google Drive database connected.', 'success');
    }

    return connected;
  }

  function updateAccountUI() {
    const account = state.googleIdentity;
    const name = account?.name || account?.email || 'Google Account';
    const initial = name.trim().charAt(0).toUpperCase() || 'G';
    $('accountName').textContent = name;
    $('settingsAccount').textContent = account?.email || name;
    $('accountAvatar').textContent = initial;
    $('accountAvatar').style.backgroundImage = '';
    $('accountAvatar').style.backgroundSize = '';
    if (account?.picture) {
      $('accountAvatar').style.backgroundImage = `url(${account.picture})`;
      $('accountAvatar').style.backgroundSize = 'cover';
      $('accountAvatar').textContent = '';
    }
  }

  function initGoogleIdentity() {
    if (!window.google?.accounts?.id) {
      setTimeout(initGoogleIdentity, 200);
      return;
    }
    google.accounts.id.initialize({ client_id: CONFIG.CLIENT_ID, callback: handleGoogleIdentity, auto_select: true, cancel_on_tap_outside: true });
    google.accounts.id.renderButton($('googleButton'), { type: 'standard', theme: document.body.classList.contains('theme-dark') ? 'filled_black' : 'outline', size: 'large', text: 'signin_with', shape: 'rectangular', logo_alignment: 'left', width: 320 });
  }

  function initGoogleTokenClient() {
    if (!window.google?.accounts?.oauth2) {
      setTimeout(initGoogleTokenClient, 200);
      return;
    }
    state.tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CONFIG.CLIENT_ID,
      scope: REQUIRED_SCOPE,
      callback: () => {}
    });
  }

  function driveAppQuery(resource, parentId = null) {
    const app = String(CONFIG.APP_ID || 'personal-expense-tracker-v1').replaceAll('\\', '\\\\').replaceAll("'", "\\'");
    const res = String(resource).replaceAll('\\', '\\\\').replaceAll("'", "\\'");
    const clauses = [
      `appProperties has { key='app' and value='${app}' }`,
      `appProperties has { key='resource' and value='${res}' }`,
      'trashed = false'
    ];
    if (parentId) clauses.push(`'${String(parentId).replaceAll("'", "\\'")}' in parents`);
    return clauses.join(' and ');
  }

  async function bootstrapDatabase() {
    setSyncStatus('syncing', 'Preparing database');

    // First use the stable spreadsheet ID remembered from a prior successful
    // connection. This is only metadata; no financial records are stored locally.
    const storedId = getStoredDatabaseId();
    if (storedId) {
      try {
        state.spreadsheetId = storedId;
        const meta = await verifySpreadsheet(storedId);
        state.spreadsheetName = meta?.properties?.title || CONFIG.DATABASE_NAME;
        await ensureSpreadsheetStructure();
        updateSettingsUI();
        return;
      } catch (err) {
        if (err?.status !== 404) throw err;
        clearStoredDatabaseId();
        state.spreadsheetId = null;
      }
    }

    let folder = await findDatabaseFolder();
    if (!folder) folder = await createDatabaseFolder();
    if (!folder?.id) throw new Error('Google Drive database folder could not be created.');
    state.folderId = folder.id;

    let spreadsheet = await findDatabaseSpreadsheet(folder.id);
    if (!spreadsheet) spreadsheet = await createDatabaseSpreadsheet(folder.id);
    if (!spreadsheet?.id) throw new Error('Database spreadsheet could not be created.');
    state.spreadsheetId = spreadsheet.id;
    state.spreadsheetName = spreadsheet.name || CONFIG.DATABASE_NAME;
    setStoredDatabaseId(state.spreadsheetId);

    await verifySpreadsheetReference();
    await ensureSpreadsheetStructure();
    updateSettingsUI();
  }

  function driveQueryForName(name, mimeType, parentId = null) {
    const safeName = String(name ?? '').replaceAll('\\', '\\\\').replaceAll("'", "\\'");
    const clauses = [`name = '${safeName}'`, `mimeType = '${mimeType}'`, 'trashed = false'];
    if (parentId) clauses.push(`'${String(parentId).replaceAll("'", "\\'")}' in parents`);
    return clauses.join(' and ');
  }

  async function driveList(query) {
    const params = new URLSearchParams({
      q: query,
      pageSize: '100',
      fields: 'files(id,name,mimeType,createdTime,modifiedTime,parents,appProperties)',
      spaces: 'drive'
    });
    const data = await googleFetch(`${DRIVE_API}/files?${params.toString()}`);
    return data.files || [];
  }

  async function findDatabaseFolder() {
    // Prefer the folder explicitly created/managed by this application.
    const appFolders = await driveList(driveAppQuery('database-folder'));
    if (appFolders.length) return appFolders.sort((a,b) => String(a.createdTime).localeCompare(String(b.createdTime)))[0];

    // Legacy name-based fallback for folders created by older versions.
    const folders = await driveList(driveQueryForName(CONFIG.DATABASE_FOLDER_NAME, 'application/vnd.google-apps.folder'));
    return folders.sort((a,b) => String(a.createdTime).localeCompare(String(b.createdTime)))[0] || null;
  }

  async function createDatabaseFolder() {
    const body = {
      name: CONFIG.DATABASE_FOLDER_NAME || 'Personal Expense Tracker',
      mimeType: 'application/vnd.google-apps.folder',
      appProperties: {
        app: CONFIG.APP_ID || 'personal-expense-tracker-v1',
        resource: 'database-folder',
        schema: CONFIG.SCHEMA_VERSION || '1.0',
        databaseVersion: CONFIG.DATABASE_VERSION || '1.0.0'
      }
    };
    return googleFetch(`${DRIVE_API}/files`, {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify(body)
    });
  }

  async function findDatabaseSpreadsheet(folderId) {
    // Preferred: app-managed database in the app-managed folder.
    const appFiles = await driveList(driveAppQuery('database', folderId));
    if (appFiles.length) {
      for (const file of appFiles.sort((a,b) => String(a.createdTime).localeCompare(String(b.createdTime)))) {
        try {
          await verifySpreadsheet(file.id);
          return file;
        } catch {
          // Ignore stale/inaccessible candidates.
        }
      }
    }

    // Secondary: app-managed database anywhere in Drive; recover its folder membership.
    const anywhere = await driveList(driveAppQuery('database'));
    for (const file of anywhere.sort((a,b) => String(a.createdTime).localeCompare(String(b.createdTime)))) {
      try {
        await verifySpreadsheet(file.id);
        if (folderId && (!Array.isArray(file.parents) || !file.parents.includes(folderId))) {
          try {
            const currentParents = Array.isArray(file.parents) ? file.parents.join(',') : '';
            const params = new URLSearchParams({ addParents: folderId, fields: 'id,name,mimeType,parents,appProperties' });
            if (currentParents) params.set('removeParents', currentParents);
            await googleFetch(`${DRIVE_API}/files/${encodeURIComponent(file.id)}?${params.toString()}`, {
              method:'PATCH',
              headers:{'Content-Type':'application/json'},
              body:JSON.stringify({ appProperties: {
                app: CONFIG.APP_ID || 'personal-expense-tracker-v1',
                resource: 'database',
                schema: CONFIG.SCHEMA_VERSION || '1.0',
                databaseVersion: CONFIG.DATABASE_VERSION || '1.0.0'
              }})
            });
          } catch (moveErr) {
            console.warn('Could not move/tag application database:', moveErr);
          }
        }
        return file;
      } catch {
        // Ignore stale/inaccessible candidates.
      }
    }

    // Legacy name-based fallback.
    const files = await driveList(driveQueryForName(CONFIG.DATABASE_NAME, 'application/vnd.google-apps.spreadsheet', folderId));
    if (files.length) {
      for (const file of files.sort((a,b) => String(a.createdTime).localeCompare(String(b.createdTime)))) {
        try {
          await verifySpreadsheet(file.id);
          return file;
        } catch {
          // Ignore stale/inaccessible candidates.
        }
      }
    }

    const fallback = await driveList(driveQueryForName(CONFIG.DATABASE_NAME, 'application/vnd.google-apps.spreadsheet'));
    for (const file of fallback.sort((a,b) => String(a.createdTime).localeCompare(String(b.createdTime)))) {
      try {
        await verifySpreadsheet(file.id);
        return file;
      } catch {
        // Ignore stale/inaccessible candidates.
      }
    }

    return null;
  }

  async function createDatabaseSpreadsheet(folderId) {
    // IMPORTANT: create the Google Sheet through Drive API so drive.file can
    // reliably discover and manage the same application-created file later.
    const body = {
      name: CONFIG.DATABASE_NAME || 'Expense_Tracker_DB',
      mimeType: 'application/vnd.google-apps.spreadsheet',
      parents: [folderId],
      appProperties: {
        app: CONFIG.APP_ID || 'personal-expense-tracker-v1',
        resource: 'database',
        schema: CONFIG.SCHEMA_VERSION || '1.0',
        databaseVersion: CONFIG.DATABASE_VERSION || '1.0.0'
      }
    };

    const params = new URLSearchParams({ fields:'id,name,mimeType,parents,appProperties,createdTime,modifiedTime' });
    const file = await googleFetch(`${DRIVE_API}/files?${params.toString()}`, {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify(body)
    });

    if (!file?.id) throw new Error('Google Drive did not return a database spreadsheet ID.');
    await verifySpreadsheet(file.id);
    return file;
  }

  async function verifySpreadsheet(spreadsheetId) {
    if (!spreadsheetId) throw new Error('Database spreadsheet ID is missing.');
    return googleFetch(`${SHEETS_API}/${encodeURIComponent(spreadsheetId)}?includeGridData=false`);
  }

  async function verifySpreadsheetReference() {
    try {
      return await verifySpreadsheet(state.spreadsheetId);
    } catch (err) {
      if (err?.status !== 404) throw err;
      const folder = await findDatabaseFolder();
      if (!folder?.id) throw err;
      const recovered = await findDatabaseSpreadsheet(folder.id);
      if (!recovered?.id) throw err;
      state.folderId = folder.id;
      state.spreadsheetId = recovered.id;
      state.spreadsheetName = recovered.name || CONFIG.DATABASE_NAME;
      setStoredDatabaseId(state.spreadsheetId);
      return verifySpreadsheet(state.spreadsheetId);
    }
  }

  async function refreshDatabaseReferenceAfterNotFound() {
    clearStoredDatabaseId();
    const folder = await findDatabaseFolder();
    if (!folder?.id) throw new Error('Database folder could not be found.');
    const spreadsheet = await findDatabaseSpreadsheet(folder.id);
    if (!spreadsheet?.id) throw new Error('Database spreadsheet could not be found.');
    state.folderId = folder.id;
    state.spreadsheetId = spreadsheet.id;
    state.spreadsheetName = spreadsheet.name || CONFIG.DATABASE_NAME;
    setStoredDatabaseId(state.spreadsheetId);
    await verifySpreadsheet(state.spreadsheetId);
  }

  async function withDatabaseReferenceRecovery(operation) {
    try {
      return await operation();
    } catch (err) {
      if (err?.status !== 404) throw err;
      await refreshDatabaseReferenceAfterNotFound();
      return operation();
    }
  }

  async function getSpreadsheetMeta() {
    return googleFetch(`${SHEETS_API}/${encodeURIComponent(state.spreadsheetId)}?includeGridData=false`);
  }

  async function ensureSpreadsheetStructure() {
    const meta = await getSpreadsheetMeta();
    const titles = (meta.sheets || []).map(s => s.properties?.title).filter(Boolean);
    const requests = [];
    for (const title of ['Expenses','Settings','Audit Log']) {
      if (!titles.includes(title)) requests.push({ addSheet: { properties: { title } } });
    }
    if (requests.length) await batchUpdate(requests);

    const current = await getSpreadsheetMeta();
    const titleMap = Object.fromEntries((current.sheets || []).map(s => [s.properties.title, s.properties.sheetId]));
    const currentValues = await valuesBatchGet(['Expenses!A1:F1','Settings!A1:B6','Audit Log!A1:D1']);
    const expenseHeader = currentValues.valueRanges?.[0]?.values?.[0] || [];
    const settingRows = currentValues.valueRanges?.[1]?.values || [];
    const auditHeader = currentValues.valueRanges?.[2]?.values?.[0] || [];
    const values = [];
    if (expenseHeader.join('|') !== EXPENSE_HEADERS.join('|')) values.push({ range:'Expenses!A1:F1', values:[EXPENSE_HEADERS] });
    if (auditHeader.join('|') !== AUDIT_HEADERS.join('|')) values.push({ range:'Audit Log!A1:D1', values:[AUDIT_HEADERS] });
    if (values.length) await valuesBatchUpdate(values);

    const hasSettingsHeader = (settingRows[0] || []).join('|') === SETTINGS_HEADERS.join('|');
    if (!hasSettingsHeader) await valuesUpdate('Settings!A1:B1', [SETTINGS_HEADERS]);
    const existingSettings = Object.fromEntries(settingRows.slice(1).filter(row => row?.[0]).map(row => [String(row[0]), String(row[1] ?? '')]));
    const requiredSettings = [
      ['Database version', CONFIG.DATABASE_VERSION],
      ['Currency', `${CONFIG.CURRENCY_CODE || 'BDT'} (${CONFIG.CURRENCY_SYMBOL || '৳'})`],
      ['Application configuration', CONFIG.APP_NAME || 'Personal Expense Tracker'],
      ['Schema version', CONFIG.SCHEMA_VERSION || '1.0'],
      ['Created timestamp', new Date().toISOString()]
    ];
    for (const [key,value] of requiredSettings) {
      if (!existingSettings[key]) existingSettings[key] = value;
    }
    const settingsRows = requiredSettings.map(([key]) => [key, existingSettings[key]]);
    await valuesUpdate('Settings!A2:B6', settingsRows);
    await styleDatabaseSheets(titleMap);
  }

  async function styleDatabaseSheets(titleMap) {
    const requests = [];
    for (const title of ['Expenses','Settings','Audit Log']) {
      const sheetId = titleMap[title];
      if (typeof sheetId !== 'number') continue;
      requests.push({ updateSheetProperties: { properties: { sheetId, title }, fields: 'gridProperties.frozenRowCount' } });
      requests.push({ repeatCell: { range:{sheetId,startRowIndex:0,endRowIndex:1}, cell:{userEnteredFormat:{textFormat:{bold:true},backgroundColor:{red:0.10,green:0.14,blue:0.24}}}, fields:'userEnteredFormat.textFormat.bold,userEnteredFormat.backgroundColor' } });
    }
    if (requests.length) {
      try { await batchUpdate(requests); } catch { /* Formatting is non-critical. */ }
    }
  }

  async function batchUpdate(requests) {
    return googleFetch(`${SHEETS_API}/${encodeURIComponent(state.spreadsheetId)}:batchUpdate`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({requests}) });
  }

  async function valuesBatchGet(ranges) {
    const params = new URLSearchParams();
    ranges.forEach(r => params.append('ranges', r));
    params.set('majorDimension','ROWS');
    return googleFetch(`${SHEETS_API}/${encodeURIComponent(state.spreadsheetId)}/values:batchGet?${params.toString()}`);
  }

  async function valuesBatchUpdate(data) {
    return googleFetch(`${SHEETS_API}/${encodeURIComponent(state.spreadsheetId)}/values:batchUpdate`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ valueInputOption:'RAW', data }) });
  }

  async function valuesUpdate(range, values) {
    return googleFetch(`${SHEETS_API}/${encodeURIComponent(state.spreadsheetId)}/values/${encodeURIComponent(range)}?valueInputOption=RAW`, { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ range, majorDimension:'ROWS', values }) });
  }

  async function loadAllExpenses() {
    setSyncStatus('syncing', 'Loading records');
    const response = await valuesBatchGet(['Expenses!A1:F']);
    const values = response.valueRanges?.[0]?.values || [];
    const parsed = parseSheetRows(values);
    state.expenses = sortExpenses(parsed.valid);
    ensureYearOptions();
    updateSettingsUI();
    if (parsed.invalid.length) {
      showToast(`${parsed.invalid.length} malformed record(s) were ignored. Check the Google Sheet before editing them.`, 'warning', 8000);
    }
    if (parsed.invalid.length === 0 && values.length === 0) await valuesUpdate('Expenses!A1:F1', [EXPENSE_HEADERS]);
    state.lastSyncAt = new Date();
  }

  async function fetchExpenseById(id) {
    const row = state.expenses.find(e => e.id === id);
    return row || null;
  }

  async function findExpenseRowIndex(id) {
    const values = (await valuesBatchGet(['Expenses!A2:A']))?.valueRanges?.[0]?.values || [];
    for (let i = 0; i < values.length; i++) if (String(values[i]?.[0] ?? '') === id) return i + 2;
    return null;
  }

  async function appendExpense(expense) {
    const values = [[expense.id, expense.date, expense.category, expense.amount, expense.createdAt, expense.updatedAt]];
    return googleFetch(`${SHEETS_API}/${encodeURIComponent(state.spreadsheetId)}/values/${encodeURIComponent('Expenses!A:F')}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ majorDimension:'ROWS', values }) });
  }

  async function updateExpenseRow(rowIndex, expense) {
    const range = `Expenses!A${rowIndex}:F${rowIndex}`;
    return valuesUpdate(range, [[expense.id, expense.date, expense.category, expense.amount, expense.createdAt, expense.updatedAt]]);
  }

  async function deleteExpenseRow(rowIndex) {
    const meta = await getSpreadsheetMeta();
    const expenseSheet = (meta.sheets || []).find(s => s.properties?.title === 'Expenses');
    if (!expenseSheet) throw new Error('Expenses sheet could not be found.');
    return batchUpdate([{ deleteDimension:{ range:{ sheetId:expenseSheet.properties.sheetId, dimension:'ROWS', startIndex:rowIndex - 1, endIndex:rowIndex } } }]);
  }

  async function audit(action, expenseId, details) {
    try {
      const values = [[new Date().toISOString(), action, expenseId || '', details || '']];
      await googleFetch(`${SHEETS_API}/${encodeURIComponent(state.spreadsheetId)}/values/${encodeURIComponent('Audit Log!A:D')}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({majorDimension:'ROWS',values}) });
    } catch {
      // Audit is intentionally best-effort and cannot block the primary transaction write.
    }
  }

  function validateForm() {
    const date = normalizeDate($('expenseDate').value);
    const category = $('expenseCategory').value;
    const amount = normalizeAmount($('expenseAmount').value);
    const errors = [];
    if (!date) errors.push('Choose a valid date.');
    if (!CATEGORIES.includes(category)) errors.push('Choose a valid expense category.');
    if (amount === null) errors.push('Enter an amount greater than ৳0.00.');
    return { valid: errors.length === 0, date, category, amount, message: errors.join(' ') };
  }

  async function saveExpenseFromForm(event) {
    event.preventDefault();
    if (state.isBusy) return;
    const result = validateForm();
    if (!result.valid) {
      $('expenseFormError').textContent = result.message;
      $('expenseFormError').classList.remove('hidden');
      return;
    }
    $('expenseFormError').classList.add('hidden');
    const id = $('expenseId').value.trim();
    const now = new Date().toISOString();
    const existing = id ? await fetchExpenseById(id) : null;
    const expense = {
      id: existing?.id || id || generateExpenseId(result.date),
      date: result.date,
      category: result.category,
      amount: result.amount,
      createdAt: existing?.createdAt || now,
      updatedAt: now
    };
    // Keep the generated ID in the still-open form after a failed write. This
    // lets retries check the same stable ID instead of creating a second row.
    $('expenseId').value = expense.id;
    setBusy(true, 'Saving...');
    try {
      if (!(await ensureAccessToken())) throw new Error('Google authorization is unavailable. Please sign in or reconnect.');
      if (existing) {
        await withDatabaseReferenceRecovery(async () => {
          const refreshedRow = await findExpenseRowIndex(existing.id);
          if (!refreshedRow) throw new Error('The expense record no longer exists in Google Sheets. Refresh and try again.');
          const latest = await getExpenseByIdFromSheet(existing.id);
          if (latest && latest.updatedAt !== existing.updatedAt) throw new Error('Conflict detected: this expense was changed on another device. Refresh before saving your edit.');
          await updateExpenseRow(refreshedRow, expense);
          await audit('UPDATE', expense.id, `Changed ${existing.category} ${existing.amount} -> ${expense.category} ${expense.amount}`);
        });
        const index = state.expenses.findIndex(e => e.id === existing.id);
        if (index >= 0) state.expenses[index] = expense;
      } else {
        await withDatabaseReferenceRecovery(async () => {
          // A request may time out after Google accepted the append. Check the
          // ID first, preventing a retry from inserting the same transaction twice.
          const priorRow = await findExpenseRowIndex(expense.id);
          if (priorRow) {
            const prior = await getExpenseByIdFromSheet(expense.id);
            if (!prior) throw new Error('An expense with this ID already exists. Sync the database before retrying.');
            const sameTransaction = prior.date === expense.date && prior.category === expense.category && Number(prior.amount) === Number(expense.amount);
            if (!sameTransaction) throw new Error('This expense may already have been saved with different values. Sync the database before retrying.');
            Object.assign(expense, prior);
            return;
          }
          await appendExpense(expense);
          await audit('CREATE', expense.id, `${expense.category} ${expense.amount}`);
        });
        state.expenses.push(expense);
      }
      state.expenses = sortExpenses(state.expenses);
      closeExpenseModal();
      renderAll();
      setSyncStatus('success', 'Saved');
      showToast(existing ? 'Expense updated in Google Sheets.' : 'Expense saved to Google Sheets.', 'success');
    } catch (err) {
      setSyncStatus('error', 'Sync Error');
      showToast(`Could not save expense. ${friendlyError(err)}`, 'error', 8500);
    } finally {
      setBusy(false);
    }
  }

  async function getExpenseByIdFromSheet(id) {
    const row = await findExpenseRowIndex(id);
    if (!row) return null;
    const range = `Expenses!A${row}:F${row}`;
    const response = await valuesBatchGet([range]);
    const values = response.valueRanges?.[0]?.values || [];
    const parsed = parseSheetRows([EXPENSE_HEADERS, ...(values || [])]).valid;
    return parsed[0] || null;
  }

  function friendlyError(err) {
    if (!navigator.onLine) return 'You appear to be offline. Reconnect and retry.';
    if (err?.status === 401) return 'Google authorization expired. Please reconnect.';
    if (err?.status === 403) return 'Google denied this operation. Check the requested scopes and OAuth configuration.';
    if (err?.status === 404) {
      const detail = String(err?.body || '').trim();
      return detail ? `Database spreadsheet could not be found. Google said: ${detail.slice(0, 220)}` : 'Database spreadsheet could not be found.';
    }
    if (err?.status === 429) return 'Google API quota is temporarily exhausted. Please retry later.';
    return err?.message || 'Google Sheets is temporarily unavailable.';
  }

  function setBusy(busy, label) {
    state.isBusy = busy;
    $('saveExpenseBtn').disabled = busy;
    $('saveExpenseBtn').textContent = busy ? label : 'Save Expense';
    if (busy) setSyncStatus('syncing', label || 'Syncing...');
  }

  function openExpenseModal(expense = null) {
    $('expenseId').value = expense?.id || '';
    $('expenseModalTitle').textContent = expense ? 'Edit Expense' : 'Add Expense';
    const defaultExpenseDate = (state.selectedYear === currentYear() && state.selectedMonth === currentMonth())
      ? localDateInputValue()
      : `${state.selectedYear}-${pad2(state.selectedMonth)}-01`;
    $('expenseDate').value = expense?.date || defaultExpenseDate;
    $('expenseCategory').value = expense?.category || CATEGORIES[0];
    $('expenseAmount').value = expense ? String(expense.amount) : '';
    $('deleteExpenseFromEditorBtn').classList.toggle('hidden', !expense);
    $('expenseFormError').classList.add('hidden');
    $('expenseModal').classList.remove('hidden');
    setTimeout(() => (expense ? $('expenseAmount') : $('expenseDate')).focus(), 50);
  }

  function closeExpenseModal() { $('expenseModal').classList.add('hidden'); }

  function askDelete(expense) {
    state.pendingConfirm = expense;
    $('confirmTitle').textContent = 'Delete expense?';
    $('confirmMessage').textContent = `${formatDate(expense.date)} • ${expense.category} • ${formatMoney(expense.amount)} will be permanently removed from Google Sheets.`;
    $('confirmModal').classList.remove('hidden');
  }

  async function confirmDelete() {
    const expense = state.pendingConfirm;
    if (!expense || state.isBusy) return;
    state.isBusy = true;
    $('confirmOkBtn').disabled = true;
    setSyncStatus('syncing', 'Deleting...');
    try {
      await ensureAccessToken();
      await withDatabaseReferenceRecovery(async () => {
        const currentRow = await findExpenseRowIndex(expense.id);
        if (!currentRow) throw new Error('The expense no longer exists in Google Sheets. Refresh and try again.');
        const latest = await getExpenseByIdFromSheet(expense.id);
        if (latest && latest.updatedAt !== expense.updatedAt) throw new Error('Conflict detected: the expense changed on another device. Refresh before deleting.');
        await deleteExpenseRow(currentRow);
        await audit('DELETE', expense.id, `${expense.category} ${expense.amount}`);
      });
      state.lastDeleted = expense;
      state.expenses = state.expenses.filter(e => e.id !== expense.id);
      closeConfirmModal();
      renderAll();
      setSyncStatus('success', 'Saved');
      showUndoToast(expense);
    } catch (err) {
      setSyncStatus('error', 'Sync Error');
      showToast(`Could not delete expense. ${friendlyError(err)}`, 'error', 8500);
    } finally {
      state.isBusy = false;
      $('confirmOkBtn').disabled = false;
    }
  }

  function closeConfirmModal() { $('confirmModal').classList.add('hidden'); state.pendingConfirm = null; }

  function showUndoToast(expense) {
    if (state.undoTimer) clearTimeout(state.undoTimer);
    const toast = document.createElement('div');
    toast.className = 'toast warning';
    toast.innerHTML = `<span class="toast-icon">!</span><span style="flex:1">Deleted ${escapeHtml(expense.category)} ${formatMoney(expense.amount)}.</span><button class="button button-secondary" style="min-height:32px;padding:5px 9px" id="undoDeleteBtn">Undo</button>`;
    $('toastRegion').appendChild(toast);
    $('undoDeleteBtn').addEventListener('click', async () => {
      toast.remove();
      await restoreDeletedExpense(expense);
    });
    state.undoTimer = setTimeout(() => toast.remove(), 9000);
  }

  async function restoreDeletedExpense(expense) {
    try {
      await ensureAccessToken();
      if (state.expenses.some(e => e.id === expense.id)) return;
      await withDatabaseReferenceRecovery(async () => {
        await appendExpense(expense);
        await audit('UNDO_DELETE', expense.id, `${expense.category} ${expense.amount}`);
      });
      state.expenses.push(expense);
      state.expenses = sortExpenses(state.expenses);
      renderAll();
      setSyncStatus('success', 'Saved');
      showToast('Deleted expense restored.', 'success');
    } catch (err) {
      setSyncStatus('error', 'Sync Error');
      showToast(`Undo failed. ${friendlyError(err)}`, 'error', 8500);
    }
  }

  function getSelectedMonthExpenses() {
    const ym = `${state.selectedYear}-${pad2(state.selectedMonth)}`;
    return state.expenses.filter(e => monthKey(e.date) === ym);
  }

  function getFilteredExpenses() {
    const records = getSelectedMonthExpenses();
    const f = state.filters;
    return records.filter(e => {
      const text = `${e.date} ${e.category}`.toLowerCase();
      if (f.search && !text.includes(f.search.toLowerCase())) return false;
      if (f.category !== 'ALL' && e.category !== f.category) return false;
      if (f.date && e.date !== f.date) return false;
      if (f.amount !== '' && Number(e.amount) !== Number(f.amount)) return false;
      return true;
    });
  }

  function renderMonthlyInsight(currentTotal) {
    const panel = $('monthlyInsight');
    const copy = panel?.querySelector('.insight-copy span');
    const value = $('monthlyInsightValue');
    const symbol = panel?.querySelector('.insight-symbol');
    if (!panel || !copy || !value || !symbol) return;

    const previousMonth = new Date(state.selectedYear, state.selectedMonth - 2, 1);
    const previousKey = `${previousMonth.getFullYear()}-${pad2(previousMonth.getMonth() + 1)}`;
    const previousTotal = state.expenses
      .filter(e => monthKey(e.date) === previousKey)
      .reduce((sum, e) => sum + e.amount, 0);
    const previousLabel = `${MONTHS[previousMonth.getMonth()]} ${previousMonth.getFullYear()}`;
    const currentLabel = `${MONTHS[state.selectedMonth - 1]} ${state.selectedYear}`;

    panel.classList.remove('insight-up', 'insight-down', 'insight-neutral');
    if (currentTotal === 0 && previousTotal === 0) {
      panel.classList.add('insight-neutral');
      symbol.textContent = '↔';
      copy.textContent = `No spending recorded for ${currentLabel} or ${previousLabel}.`;
      value.textContent = 'No comparison yet';
      return;
    }
    if (previousTotal === 0) {
      panel.classList.add('insight-neutral');
      symbol.textContent = '✦';
      copy.textContent = `This is the first recorded spending month in comparison with ${previousLabel}.`;
      value.textContent = formatMoney(currentTotal);
      return;
    }

    const difference = currentTotal - previousTotal;
    const percent = (difference / previousTotal) * 100;
    panel.classList.add(difference > 0.005 ? 'insight-up' : difference < -0.005 ? 'insight-down' : 'insight-neutral');
    symbol.textContent = difference > 0.005 ? '↗' : difference < -0.005 ? '↘' : '↔';
    const direction = difference > 0.005 ? 'higher' : difference < -0.005 ? 'lower' : 'unchanged';
    copy.textContent = `${currentLabel} spending is ${direction} than ${previousLabel} by ${formatMoney(Math.abs(difference))}.`;
    value.textContent = `${Math.abs(percent).toFixed(1)}% ${difference > 0.005 ? '↑' : difference < -0.005 ? '↓' : '↔'}`;
  }

  function renderExpenseTable() {
    const rows = getFilteredExpenses();
    const monthRows = getSelectedMonthExpenses();
    const monthTotal = monthRows.reduce((s,e) => s + e.amount, 0);
    const filteredTotal = rows.reduce((s,e) => s + e.amount, 0);
    $('expenseTableTitle').textContent = `${MONTHS[state.selectedMonth - 1]} ${state.selectedYear} Expenses`;
    $('selectedMonthTotal').textContent = formatMoney(monthTotal);
    $('selectedMonthCount').textContent = `${monthRows.length} transaction${monthRows.length === 1 ? '' : 's'}`;
    $('filteredTotal').textContent = formatMoney(filteredTotal);
    $('filteredCount').textContent = `${rows.length} shown`;
    $('tableTotal').textContent = formatMoney(filteredTotal);
    $('tableRecordSummary').textContent = `${rows.length} record${rows.length === 1 ? '' : 's'}`;
    renderMonthlyInsight(monthTotal);

    const body = $('expenseTableBody');
    $('emptyState').classList.toggle('hidden', rows.length > 0);
    body.innerHTML = rows.map((e, idx) => {
      const prev = rows[idx - 1];
      const groupStart = !prev || prev.date !== e.date;
      return `<tr class="expense-row ${groupStart ? 'group-start' : ''}" tabindex="0" data-id="${escapeHtml(e.id)}" title="Enter to edit • Delete to delete">
        <td class="date-cell" data-label="Date">${groupStart ? escapeHtml(formatDate(e.date)) : '<span class="muted">↳ same date</span>'}</td>
        <td class="category-cell" data-label="Category"><span class="category-pill"><span class="category-dot"></span>${escapeHtml(e.category)}</span></td>
        <td class="amount" data-label="Amount">${escapeHtml(formatMoney(e.amount))}</td>
      </tr>`;
    }).join('');
    qsa('.expense-row', body).forEach(row => {
      const id = row.dataset.id;
      row.addEventListener('dblclick', () => {
        const expense = state.expenses.find(e => e.id === id);
        if (expense) openExpenseModal(expense);
      });
      row.addEventListener('click', () => {
        const expense = state.expenses.find(e => e.id === id);
        const touchUI = window.matchMedia('(hover: none) and (pointer: coarse)').matches;
        if (touchUI && expense) {
          openExpenseModal(expense);
          return;
        }
        qsa('.expense-row.selected', body).forEach(r => r.classList.remove('selected'));
        row.classList.add('selected');
      });
      row.addEventListener('keydown', e => {
        const expense = state.expenses.find(x => x.id === id);
        if (!expense) return;
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openExpenseModal(expense); }
        if (e.key === 'Delete') { e.preventDefault(); askDelete(expense); }
      });
    });
  }

  function categoryStats(records) {
    const map = Object.fromEntries(CATEGORIES.map(c => [c, { total:0, count:0 }]));
    for (const e of records) if (map[e.category]) { map[e.category].total += e.amount; map[e.category].count += 1; }
    return map;
  }

  function summaryMetrics(records, mode = 'monthly') {
    const total = records.reduce((s,e) => s + e.amount, 0);
    const count = records.length;
    const stats = categoryStats(records);
    const highest = CATEGORIES.reduce((best,c) => stats[c].total > stats[best].total ? c : best, CATEGORIES[0]);
    const largest = records.reduce((best,e) => !best || e.amount > best.amount ? e : best, null);
    let highestMonth = '—';
    if (mode === 'yearly') {
      const monthTotals = MONTHS.map((m,i) => records.filter(e => monthOf(e.date) === i+1).reduce((s,e)=>s+e.amount,0));
      const idx = monthTotals.reduce((bi,v,i,arr)=>v>arr[bi]?i:bi,0);
      if (total > 0) highestMonth = MONTHS[idx];
    }
    return { total, count, highest, largest, avg: count ? total / count : 0, highestMonth };
  }

  function metricCard(label, value, sub = '') {
    const icons = {
      'Total Monthly Expense': 'Σ',
      'Total Yearly Expense': '↗',
      'Lifetime Expense': '∞',
      'Transaction Count': '↔',
      'Total Transactions': '↔',
      'Highest Spending Category': '◆',
      'Highest Spending Month': '◷',
      'Largest Single Expense': '↑',
      'Average Expense / Transaction': '≈',
      'Average / Transaction': '≈',
      'First Expense Date': '◷',
      'Last Expense Date': '◷'
    };
    const icon = icons[label] || '•';
    return `<article class="metric-card"><div><span class="metric-label">${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong>${sub ? `<small>${escapeHtml(sub)}</small>` : ''}</div><div class="metric-icon" aria-hidden="true">${icon}</div></article>`;
  }

  function renderMonthlySummary() {
    const records = state.expenses.filter(e => yearOf(e.date) === state.monthlyYear && monthOf(e.date) === state.monthlyMonth);
    const m = summaryMetrics(records);
    $('monthlyMetrics').innerHTML = [
      metricCard('Total Monthly Expense', formatMoney(m.total), `${records.length} transactions`),
      metricCard('Transaction Count', String(m.count)),
      metricCard('Highest Spending Category', m.total ? m.highest : '—'),
      metricCard('Largest Single Expense', m.largest ? formatMoney(m.largest.amount) : '৳0.00'),
      metricCard('Average Expense / Transaction', formatMoney(m.avg))
    ].join('');
    const stats = categoryStats(records);
    $('monthlyCategoryBody').innerHTML = CATEGORIES.map(c => {
      const s = stats[c]; const pct = m.total ? (s.total / m.total) * 100 : 0;
      return `<tr><td class="category-name ${s.total ? '' : 'zero'}" data-label="Category">${escapeHtml(c)}</td><td data-label="Amount">${formatMoney(s.total)}</td><td data-label="Share">${pct.toFixed(1)}%</td><td data-label="Transactions">${s.count}</td></tr>`;
    }).join('');
    renderDonutChart('monthlyChart', stats, m.total);
  }

  function renderYearlySummary() {
    const records = state.expenses.filter(e => yearOf(e.date) === state.yearlyYear);
    const m = summaryMetrics(records, 'yearly');
    $('yearlyMetrics').innerHTML = [
      metricCard('Total Yearly Expense', formatMoney(m.total), `${records.length} transactions`),
      metricCard('Total Transactions', String(m.count)),
      metricCard('Highest Spending Category', m.total ? m.highest : '—'),
      metricCard('Highest Spending Month', m.total ? m.highestMonth : '—'),
      metricCard('Largest Single Expense', m.largest ? formatMoney(m.largest.amount) : '৳0.00'),
      metricCard('Average / Transaction', formatMoney(m.avg))
    ].join('');
    const stats = categoryStats(records);
    $('yearlyCategoryBody').innerHTML = CATEGORIES.map(c => {
      const s = stats[c]; const pct = m.total ? (s.total / m.total) * 100 : 0;
      return `<tr><td class="category-name ${s.total ? '' : 'zero'}" data-label="Category">${escapeHtml(c)}</td><td data-label="Amount">${formatMoney(s.total)}</td><td data-label="Share">${pct.toFixed(1)}%</td><td data-label="Transactions">${s.count}</td></tr>`;
    }).join('');
    $('yearlyMonthsBody').innerHTML = MONTHS.map((month, i) => {
      const mr = records.filter(e => monthOf(e.date) === i+1);
      const total = mr.reduce((s,e)=>s+e.amount,0);
      return `<tr><td data-label="Month">${month}</td><td data-label="Total">${formatMoney(total)}</td><td data-label="Transactions">${mr.length}</td></tr>`;
    }).join('');
    renderTrendChart('yearlyTrendChart', MONTHS.map((month,i)=>({label:month, value:records.filter(e=>monthOf(e.date)===i+1).reduce((s,e)=>s+e.amount,0)})));
  }

  function renderTotalSummary() {
    const records = state.expenses;
    const m = summaryMetrics(records);
    const first = records[0]?.date || '—';
    const last = records[records.length - 1]?.date || '—';
    $('totalMetrics').innerHTML = [
      metricCard('Lifetime Expense', formatMoney(m.total), `${records.length} transactions`),
      metricCard('Total Transactions', String(m.count)),
      metricCard('First Expense Date', first === '—' ? '—' : formatDate(first)),
      metricCard('Last Expense Date', last === '—' ? '—' : formatDate(last)),
      metricCard('Highest Spending Category', m.total ? m.highest : '—'),
      metricCard('Largest Single Expense', m.largest ? formatMoney(m.largest.amount) : '৳0.00'),
      metricCard('Average / Transaction', formatMoney(m.avg))
    ].join('');
    const stats = categoryStats(records);
    $('totalCategoryBody').innerHTML = CATEGORIES.map(c => {
      const s = stats[c]; const pct = m.total ? (s.total / m.total) * 100 : 0;
      return `<tr><td class="category-name ${s.total ? '' : 'zero'}" data-label="Category">${escapeHtml(c)}</td><td data-label="Amount">${formatMoney(s.total)}</td><td data-label="Share">${pct.toFixed(1)}%</td><td data-label="Transactions">${s.count}</td></tr>`;
    }).join('');
    renderDonutChart('totalChart', stats, m.total);
  }

  function cssColor(index, total) {
    const hue = Math.round((index / Math.max(total,1)) * 285) + 205;
    return `hsl(${hue}, 78%, 56%)`;
  }

  function renderDonutChart(containerId, stats, total) {
    const el = $(containerId);
    const entries = CATEGORIES.map((c,i)=>({ name:c, value:stats[c].total, color:cssColor(i,CATEGORIES.length) })).filter(e => e.value > 0);
    if (!entries.length || !total) { el.innerHTML = `<div class="empty-state"><div class="empty-icon">◌</div><h3>No category spending yet</h3><p class="muted">The chart will populate automatically when expenses are saved.</p></div>`; return; }
    const cx=150, cy=150, r=105, inner=64;
    let angle=-Math.PI/2;
    let paths='';
    const polar=(a,rad)=>[cx+Math.cos(a)*rad,cy+Math.sin(a)*rad];
    for(const e of entries){
      const delta=(e.value/total)*Math.PI*2;
      const start=angle, end=angle+delta;
      const [x1,y1]=polar(start,r), [x2,y2]=polar(end,r);
      const [ix1,iy1]=polar(start,inner), [ix2,iy2]=polar(end,inner);
      const large=delta>Math.PI?1:0;
      paths+=`<path d="M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} L ${ix2} ${iy2} A ${inner} ${inner} 0 ${large} 0 ${ix1} ${iy1} Z" fill="${e.color}" opacity=".92"></path>`;
      angle=end;
    }
    el.innerHTML = `<div><svg viewBox="0 0 300 300" role="img" aria-label="Category spending donut chart"><circle cx="150" cy="150" r="105" fill="none" stroke="var(--surface-2)" stroke-width="1"></circle>${paths}<circle cx="150" cy="150" r="64" fill="var(--surface-solid)"></circle><text x="150" y="142" text-anchor="middle" fill="currentColor" font-size="12">Total</text><text x="150" y="164" text-anchor="middle" fill="currentColor" font-size="16" font-weight="800">${escapeHtml(formatMoney(total))}</text></svg><div class="chart-legend">${entries.map(e=>`<div class="legend-item"><div class="legend-left"><span class="legend-swatch" style="background:${e.color}"></span><span class="legend-name">${escapeHtml(e.name)}</span></div><strong>${((e.value/total)*100).toFixed(1)}%</strong></div>`).join('')}</div></div>`;
  }

  function renderTrendChart(containerId, points) {
    const el=$(containerId);
    const max=Math.max(...points.map(p=>p.value),0);
    const W=760,H=300,P=36;
    if(max<=0){el.innerHTML='<div class="empty-state"><div class="empty-icon">◌</div><h3>No yearly spending yet</h3><p class="muted">The trend chart will populate automatically.</p></div>';return;}
    const usableW=W-P*2, usableH=H-P*2;
    const coords=points.map((p,i)=>({x:P+(usableW*(points.length===1?0.5:i/(points.length-1))),y:P+usableH-(p.value/max)*usableH,...p}));
    const line=coords.map((p,i)=>`${i?'L':'M'} ${p.x} ${p.y}`).join(' ');
    const area=`M ${coords[0].x} ${H-P} ${coords.map(p=>`L ${p.x} ${p.y}`).join(' ')} L ${coords.at(-1).x} ${H-P} Z`;
    const labels=coords.map(p=>`<text x="${p.x}" y="${H-10}" text-anchor="middle" fill="var(--muted)" font-size="10">${escapeHtml(p.label.slice(0,3))}</text>`).join('');
    const dots=coords.map(p=>`<circle cx="${p.x}" cy="${p.y}" r="4" fill="var(--primary)"></circle>`).join('');
    const grid=[0,.25,.5,.75,1].map(v=>{const y=P+usableH-v*usableH;return `<line x1="${P}" x2="${W-P}" y1="${y}" y2="${y}" stroke="var(--line)" stroke-width="1"></line>`}).join('');
    el.innerHTML=`<div><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Yearly spending trend">${grid}<path d="${area}" fill="rgba(51,92,255,.10)"></path><path d="${line}" fill="none" stroke="var(--primary)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"></path>${dots}${labels}</svg><div class="muted small" style="text-align:right">Peak: ${escapeHtml(formatMoney(max))}</div></div>`;
  }

  function renderAll() {
    ensureYearOptions();
    fillMonthSelects();
    $('categoryFilter').value = state.filters.category;
    $('dateFilter').value = state.filters.date;
    $('expenseSearch').value = state.filters.search;
    $('amountFilter').value = state.filters.amount;
    renderExpenseTable();
    renderMonthlySummary();
    renderYearlySummary();
    renderTotalSummary();
    updateSettingsUI();
    updateAccountUI();
    $('schemaVersionFooter').textContent = CONFIG.SCHEMA_VERSION || '1.0';
  }

  function updateSettingsUI() {
    $('settingsDatabase').textContent = state.spreadsheetId ? `${state.spreadsheetName} (${state.spreadsheetId})` : 'Not connected';
    $('settingsRecordCount').textContent = String(state.expenses.length);
    $('settingsDbStatus').textContent = state.dbStatus;
    if ($('settingsLastSync')) {
      $('settingsLastSync').textContent = state.lastSyncAt
        ? new Intl.DateTimeFormat('en-BD', { dateStyle: 'medium', timeStyle: 'short' }).format(state.lastSyncAt)
        : 'Not synced yet';
    }
  }

  async function syncNow() {
    if (state.refreshInFlight) return;
    if (!state.spreadsheetId) { showToast('Connect Google first.', 'warning'); return; }
    state.refreshInFlight = true;
    setSyncStatus('syncing', 'Syncing...');
    try {
      if (!(await ensureAccessToken())) throw new Error('Google authorization is unavailable. Please sign in or reconnect.');
      try {
        await loadAllExpenses();
      } catch (err) {
        if (err?.status !== 404) throw err;
        await refreshDatabaseReferenceAfterNotFound();
        await loadAllExpenses();
      }
      renderAll();
      setSyncStatus('success','Synced');
      showToast('Latest Google Sheets data loaded.', 'success');
    } catch (err) {
      setSyncStatus('error','Sync Error');
      handleApiError(err);
    } finally {
      state.refreshInFlight = false;
    }
  }

  function handleApiError(err) {
    console.error(err);
    if (err?.status === 401) {
      setSyncStatus('warning', 'Reconnect Required');
      showToast('Google authorization expired. Please reconnect.', 'error', 8000);
      return;
    }
    if (err?.status === 403) {
      setSyncStatus('error', 'Sync Error');
      showToast('Access was denied. Verify the OAuth scopes and Google Cloud configuration.', 'error', 9000);
      return;
    }
    if (err?.status === 404) {
      setSyncStatus('error', 'Sync Error');
      showToast('Database spreadsheet could not be found. The app will not create another copy automatically during this session.', 'error', 9000);
      return;
    }
    setSyncStatus('error', 'Sync Error');
    showToast(friendlyError(err), 'error', 8000);
  }

  function exportJson() {
    const data = {
      schemaVersion: CONFIG.SCHEMA_VERSION || '1.0',
      exportTimestamp: new Date().toISOString(),
      application: CONFIG.APP_NAME || 'Personal Expense Tracker',
      currency: CONFIG.CURRENCY_CODE || 'BDT',
      currencySymbol: CONFIG.CURRENCY_SYMBOL || '৳',
      records: state.expenses.map(e => ({ ...e }))
    };
    downloadBlob(JSON.stringify(data, null, 2), `expense-tracker-backup-${localDateInputValue()}.json`, 'application/json');
  }

  function exportCsv() {
    const rows = [['Date','Expense Category','Amount'], ...sortExpenses(state.expenses).map(e => [e.date,e.category,e.amount])];
    const csv = rows.map(r => r.map(v => `"${String(v).replaceAll('"','""')}"`).join(',')).join('\r\n');
    downloadBlob(csv, `expense-tracker-${localDateInputValue()}.csv`, 'text/csv;charset=utf-8');
  }

  function downloadBlob(content, filename, type) {
    if (isNativeApp()) {
      window.AndroidExpenseBridge.exportFile(filename, type, String(content));
      return;
    }
    const blob = new Blob([content], {type});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href=url; a.download=filename; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
  }

  function openSettings() { updateSettingsUI(); $('settingsModal').classList.remove('hidden'); }
  function closeSettings() { $('settingsModal').classList.add('hidden'); }

  function switchTab(tab) {
    state.currentTab = tab;
    qsa('.main-tab').forEach(btn => {
      const active = btn.dataset.tab === tab;
      btn.classList.toggle('active', active);
      if (active) btn.setAttribute('aria-current', 'page');
      else btn.removeAttribute('aria-current');
    });
    qsa('.tab-panel').forEach(panel => {
      const active = panel.id === `tab-${tab}`;
      panel.classList.toggle('active', active);
      panel.setAttribute('aria-hidden', String(!active));
    });
    if (window.matchMedia('(max-width: 760px)').matches) {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }

  function resetToCurrentMonth() {
    state.selectedYear=currentYear(); state.selectedMonth=currentMonth();
    state.monthlyYear=state.selectedYear; state.monthlyMonth=state.selectedMonth; state.yearlyYear=state.selectedYear;
    ensureYearOptions(); fillMonthSelects(); renderAll();
  }

  function bindEvents() {
    qsa('.main-tab').forEach(btn => btn.addEventListener('click', ()=>switchTab(btn.dataset.tab)));
    $('themeToggle').addEventListener('click', toggleTheme);
    $('settingsButton').addEventListener('click', openSettings);
    qsa('[data-close-settings]').forEach(el=>el.addEventListener('click',closeSettings));
    qsa('[data-close-expense]').forEach(el=>el.addEventListener('click',closeExpenseModal));
    qsa('[data-close-confirm]').forEach(el=>el.addEventListener('click',closeConfirmModal));
    $('addExpenseBtn').addEventListener('click',()=>openExpenseModal());
    $('emptyAddBtn').addEventListener('click',()=>openExpenseModal());
    $('expenseForm').addEventListener('submit',saveExpenseFromForm);
    $('deleteExpenseFromEditorBtn').addEventListener('click', () => {
      const id = $('expenseId').value;
      const expense = state.expenses.find(e => e.id === id);
      if (!expense) return;
      closeExpenseModal();
      askDelete(expense);
    });
    $('settingsOpenDatabaseBtn').addEventListener('click', () => {
      if (!state.spreadsheetId) {
        showToast('Connect to Google Sheets first.', 'warning');
        return;
      }
      const url = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(state.spreadsheetId)}/edit`;
      if (isNativeApp()) window.AndroidExpenseBridge.openExternal(url);
      else window.open(url, '_blank', 'noopener,noreferrer');
    });
    $('confirmOkBtn').addEventListener('click',confirmDelete);
    $('confirmCancelBtn').addEventListener('click',closeConfirmModal);
    $('refreshBtn').addEventListener('click',syncNow);
    $('settingsSyncBtn').addEventListener('click',async()=>{closeSettings();await syncNow();});
    $('settingsReconnectBtn').addEventListener('click',async()=>{closeSettings();await startGoogleApiConnection(true);});
    $('settingsExportJsonBtn').addEventListener('click',exportJson);
    $('settingsExportCsvBtn').addEventListener('click',exportCsv);
    $('settingsSignOutBtn').addEventListener('click',()=>{
      if (isNativeApp()) { try { window.AndroidExpenseBridge.signOut(); } catch { /* UI still signs out locally. */ } }
      clearStoredDatabaseId();
      state.accessToken=null;state.accessTokenExpiresAt=0;state.apiAuthorizationGranted=false;state.spreadsheetId=null;state.folderId=null;state.expenses=[];state.googleIdentity=null;state.silentRestoreAttempted=true;
      closeSettings();showAuthScreen();setSyncStatus('neutral','Signed out');
      if (window.google?.accounts?.id) google.accounts.id.disableAutoSelect();
      showToast('Signed out from this application session.', 'success');
    });
    $('currentMonthBtn').addEventListener('click',resetToCurrentMonth);
    $('monthlyCurrentBtn').addEventListener('click',()=>{state.monthlyYear=currentYear();state.monthlyMonth=currentMonth();ensureYearOptions();fillMonthSelects();renderMonthlySummary();});
    $('yearlyCurrentBtn').addEventListener('click',()=>{state.yearlyYear=currentYear();ensureYearOptions();renderYearlySummary();});
    $('expenseYear').addEventListener('change',e=>{state.selectedYear=Number(e.target.value);renderExpenseTable();});
    $('expenseMonth').addEventListener('change',e=>{state.selectedMonth=Number(e.target.value);renderExpenseTable();});
    $('monthlyYear').addEventListener('change',e=>{state.monthlyYear=Number(e.target.value);renderMonthlySummary();});
    $('monthlyMonth').addEventListener('change',e=>{state.monthlyMonth=Number(e.target.value);renderMonthlySummary();});
    $('yearlyYear').addEventListener('change',e=>{state.yearlyYear=Number(e.target.value);renderYearlySummary();});
    $('expenseSearch').addEventListener('input',e=>{state.filters.search=e.target.value.trim();renderExpenseTable();});
    $('categoryFilter').addEventListener('change',e=>{state.filters.category=e.target.value;renderExpenseTable();});
    $('dateFilter').addEventListener('change',e=>{state.filters.date=e.target.value;renderExpenseTable();});
    $('amountFilter').addEventListener('input',e=>{state.filters.amount=e.target.value;renderExpenseTable();});
    $('clearFiltersBtn').addEventListener('click',()=>{state.filters={search:'',category:'ALL',date:'',amount:''};renderExpenseTable();});
    window.addEventListener('online',()=>{if(state.accessToken) syncNow();});
    window.addEventListener('offline',()=>{setSyncStatus('warning','Offline / Reconnect Required');showToast('Offline: Google Drive remains the source of truth. Changes will not be marked saved until synchronization succeeds.','warning',7000);});
    document.addEventListener('keydown',e=>{
      if (e.key === 'Escape') { closeExpenseModal(); closeConfirmModal(); closeSettings(); }
      if (e.key === 'F5') return;
    });
  }

  function init() {
    applyTheme();
    bindEvents();
    setInitialSelectors();
    fillCategorySelects();
    if (!isConfigured()) {
      $('configWarning').textContent = 'Setup required: replace YOUR_GOOGLE_OAUTH_WEB_CLIENT_ID.apps.googleusercontent.com in config.js with your Google Cloud Web OAuth Client ID before deployment.';
      $('configWarning').classList.remove('hidden');
      $('googleButton').classList.add('hidden');
      showAuthScreen();
      setSyncStatus('warning','Configuration Required');
      return;
    }
    showAuthScreen();
    if (isNativeApp()) {
      $('googleButton').classList.add('hidden');
      $('nativeSignInBtn').classList.remove('hidden');
      $('nativeSignInBtn').addEventListener('click', async () => {
        $('nativeSignInBtn').disabled = true;
        try { await startGoogleApiConnection(false, true); }
        finally { $('nativeSignInBtn').disabled = false; }
      });
      $('reconnectAuthBtn').addEventListener('click', async () => {
        $('reconnectAuthBtn').classList.add('hidden');
        await startGoogleApiConnection(true);
      });
      if (window.AndroidExpenseBridge.hasRememberedSession()) {
        setSyncStatus('syncing', 'Restoring Google session');
        window.setTimeout(() => restoreSessionSilently(), 250);
      } else {
        setSyncStatus('neutral', 'Sign in required');
      }
      return;
    }
    initGoogleTokenClient();
    initGoogleIdentity();
    // On subsequent web visits, try silent restoration without storing an OAuth token.
    const waitForSilentRestore = () => {
      if (state.tokenClient) restoreSessionSilently();
      else window.setTimeout(waitForSilentRestore, 250);
    };
    window.setTimeout(waitForSilentRestore, 300);
  }

  init();
})();

import { LANGUAGES, pickLanguage, translate } from './i18n.js';

const LANG_STORAGE_KEY = 'iconstore_lang';
const SEARCH_DEBOUNCE_MS = 200;
const TOAST_MS = 4500;
const TOAST_LONG_MS = 8000;
const COPIED_RESET_MS = 1600;
const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

/** @param {string} id */
const $ = (id) => /** @type {any} */ (document.getElementById(id));

const state = {
  /** @type {'de' | 'en'} */
  lang: loadLanguage(),
  /** @type {any[]} */
  icons: [],
  /** @type {File[]} */
  files: [],
  /** @type {any} */
  editing: null,
  session: { authenticated: false, authRequired: true, publicBrowse: false, maxUploadBytes: 8 * 1024 * 1024 },
};

/** @param {string} key @param {Record<string, string | number>} [params] */
const t = (key, params) => translate(state.lang, key, params);

function loadLanguage() {
  try {
    const saved = localStorage.getItem(LANG_STORAGE_KEY);
    if (saved === 'de' || saved === 'en') return saved;
  } catch {
    /* storage may be blocked; fall back to the browser language */
  }
  return pickLanguage(navigator.languages ?? [navigator.language]);
}

// ---------- API ----------

class ApiError extends Error {
  /** @param {string} code @param {Record<string, string | number>} params @param {number} status */
  constructor(code, params, status) {
    super(code);
    this.code = code;
    this.params = params;
    this.status = status;
  }
}

/**
 * Same-origin fetch; the session cookie travels automatically and the
 * browser adds the Origin header the server checks for CSRF.
 * @param {string} url
 * @param {RequestInit} [options]
 */
async function api(url, options = {}) {
  let res;
  try {
    res = await fetch(url, { credentials: 'same-origin', ...options });
  } catch {
    throw new ApiError('network_error', {}, 0);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && url !== '/api/login') showLogin();
    throw new ApiError(data.code ?? 'internal_error', data.params ?? {}, res.status);
  }
  return data;
}

/** @param {unknown} err */
function errorText(err) {
  return err instanceof ApiError ? t(err.code, err.params) : t('internal_error');
}

/** @param {string} url @param {unknown} body @param {string} [method] */
const sendJson = (url, body, method = 'POST') =>
  api(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

// ---------- i18n ----------

function applyLanguage() {
  document.documentElement.lang = state.lang;
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(/** @type {any} */ (el).dataset.i18n);
  for (const el of document.querySelectorAll('[data-i18n-placeholder]')) {
    /** @type {any} */ (el).placeholder = t(/** @type {any} */ (el).dataset.i18nPlaceholder);
  }
  const other = LANGUAGES.find((l) => l !== state.lang) ?? 'en';
  $('langToggle').textContent = other.toUpperCase();
  $('langToggle').lang = other;
  $('langToggle').setAttribute('aria-label', t('nav.language'));
  $('typesHint').textContent = t('upload.types', { mb: Math.round(state.session.maxUploadBytes / 1024 / 1024) });
  renderIcons();
}

$('langToggle').addEventListener('click', () => {
  state.lang = state.lang === 'de' ? 'en' : 'de';
  try {
    localStorage.setItem(LANG_STORAGE_KEY, state.lang);
  } catch {
    /* preference simply is not remembered */
  }
  applyLanguage();
});

// ---------- views ----------

function showLogin() {
  state.session.authenticated = false;
  $('loginView').hidden = false;
  $('libraryView').hidden = true;
  $('searchWrap').hidden = true;
  for (const id of ['openUpload', 'openBackup', 'logout']) $(id).hidden = true;
  $('loginKey').focus();
}

function showLibrary() {
  const canWrite = state.session.authenticated;
  $('loginView').hidden = true;
  $('libraryView').hidden = false;
  $('searchWrap').hidden = false;
  $('openUpload').hidden = !canWrite;
  $('openBackup').hidden = !canWrite;
  $('logout').hidden = !canWrite || !state.session.authRequired;
  return loadIcons();
}

async function boot() {
  try {
    state.session = await api('/api/session');
  } catch {
    /* keep defaults; login view will show */
  }
  applyLanguage();
  if (state.session.authenticated || state.session.publicBrowse) await showLibrary();
  else showLogin();
}

$('loginForm').addEventListener('submit', async (/** @type {SubmitEvent} */ e) => {
  e.preventDefault();
  $('loginError').textContent = '';
  try {
    await sendJson('/api/login', { key: $('loginKey').value });
    $('loginKey').value = '';
    state.session = await api('/api/session');
    await showLibrary();
    $('search').focus();
  } catch (err) {
    $('loginError').textContent = errorText(err);
    $('loginKey').select();
  }
});

$('logout').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' }).catch(() => undefined);
  showLogin();
});

// ---------- library ----------

async function loadIcons() {
  const q = $('search').value.trim();
  try {
    const data = await api(`/api/icons${q ? `?q=${encodeURIComponent(q)}` : ''}`);
    state.icons = data.icons;
    $('usage').textContent = t('usage', {
      count: data.usage.count,
      used: formatBytes(data.usage.totalSize),
      max: formatBytes(data.usage.maxTotalSize),
    });
    renderIcons();
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 401)) showToast(errorText(err));
  }
}

function renderIcons() {
  const q = $('search').value.trim();
  const grid = $('grid');
  grid.replaceChildren(...state.icons.map(buildCard));
  $('emptyState').hidden = state.icons.length > 0 || q !== '' || !state.session.authenticated;
  $('noMatch').hidden = state.icons.length > 0 || q === '';
  $('noMatch').textContent = t('search.none', { q });
  $('searchCount').textContent = q ? t('search.count', { n: state.icons.length }) : '';
}

/**
 * Built with DOM APIs instead of innerHTML so names and tags can never be
 * interpreted as markup.
 * @param {any} icon
 */
function buildCard(icon) {
  const li = document.createElement('li');
  li.className = 'card';

  const art = document.createElement('div');
  art.className = 'card-art';
  const img = document.createElement('img');
  img.src = icon.url;
  img.alt = '';
  img.loading = 'lazy';
  img.decoding = 'async';
  art.append(img);

  const info = document.createElement('div');
  info.className = 'card-info';
  const name = document.createElement('h3');
  name.className = 'card-name';
  name.textContent = icon.name;
  const file = document.createElement('p');
  file.className = 'card-file';
  file.textContent = icon.filename;
  info.append(name, file);
  if (icon.tags.length) {
    const tags = document.createElement('ul');
    tags.className = 'card-tags';
    tags.setAttribute('aria-label', t('upload.tags'));
    for (const tag of icon.tags) {
      const pill = document.createElement('li');
      pill.textContent = tag;
      tags.append(pill);
    }
    info.append(tags);
  }

  const actions = document.createElement('div');
  actions.className = 'card-actions';
  const copy = iconButton('copy', t('card.copy', { name: icon.name }), () => copyLink(icon, copy));
  actions.append(copy);
  if (state.session.authenticated) {
    actions.append(
      iconButton('edit', t('card.edit', { name: icon.name }), () => openEdit(icon)),
      iconButton('delete', t('card.delete', { name: icon.name }), () => openDelete(icon), 'danger'),
    );
  }

  li.append(art, info, actions);
  return li;
}

const ICON_PATHS = {
  copy: 'M9 9h11v11H9zM5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1',
  edit: 'M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z',
  delete: 'M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6',
  check: 'M20 6 9 17l-5-5',
};

/** @param {keyof typeof ICON_PATHS} kind */
function svgIcon(kind) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', ICON_PATHS[kind]);
  svg.append(path);
  return svg;
}

/**
 * @param {keyof typeof ICON_PATHS} kind
 * @param {string} label
 * @param {() => void} onClick
 * @param {string} [variant]
 */
function iconButton(kind, label, onClick, variant = '') {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `icon-btn ${variant}`.trim();
  btn.setAttribute('aria-label', label);
  btn.title = label;
  btn.append(svgIcon(kind));
  btn.addEventListener('click', onClick);
  return btn;
}

let searchTimer = 0;
$('search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = window.setTimeout(loadIcons, SEARCH_DEBOUNCE_MS);
});

// ---------- copy ----------

/** @param {string} filename */
const fullUrl = (filename) => `${window.location.origin}/icons/${filename}`;

/**
 * navigator.clipboard only exists on HTTPS/localhost; on a plain
 * http://<lan-ip> the textarea fallback is the only way to copy.
 * @param {string} text
 */
async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      /* fall through */
    }
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.className = 'visually-hidden';
  document.body.append(ta);
  ta.select();
  const ok = document.execCommand('copy');
  ta.remove();
  if (!ok) throw new Error('copy failed');
}

/** @param {any} icon @param {HTMLButtonElement} btn */
async function copyLink(icon, btn) {
  const url = fullUrl(icon.filename);
  try {
    await copyText(url);
    showToast(t('toast.copied', { url }));
    btn.replaceChildren(svgIcon('check'));
    btn.classList.add('copied');
    setTimeout(() => {
      btn.replaceChildren(svgIcon('copy'));
      btn.classList.remove('copied');
    }, COPIED_RESET_MS);
  } catch {
    showToast(t('toast.copyFailed', { url }), TOAST_LONG_MS);
  }
}

// ---------- toast ----------

let toastTimer = 0;
/** @param {string} msg @param {number} [ms] */
function showToast(msg, ms = TOAST_MS) {
  const toast = $('toast');
  toast.textContent = msg;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toast.hidden = true;
  }, ms);
}

// ---------- dialogs ----------

for (const btn of document.querySelectorAll('[data-close]')) {
  btn.addEventListener('click', () => /** @type {HTMLDialogElement} */ (btn.closest('dialog')).close());
}

// Upload
function openUpload() {
  state.files = [];
  $('uploadForm').reset();
  $('uploadError').textContent = '';
  renderFileList();
  $('uploadDialog').showModal();
}
$('openUpload').addEventListener('click', openUpload);
$('emptyUpload').addEventListener('click', openUpload);

/** @param {FileList | File[]} list */
function addFiles(list) {
  state.files = [...state.files, ...list];
  if (state.files.length === 1 && !$('nameInput').value) {
    $('nameInput').value = state.files[0].name.replace(/\.[^.]+$/, '');
  }
  renderFileList();
}

/** @param {Map<File, string>} [status] */
function renderFileList(status = new Map()) {
  const list = $('fileList');
  list.replaceChildren(
    ...state.files.map((f) => {
      const li = document.createElement('li');
      li.textContent = `${f.name} (${formatBytes(f.size)})`;
      const s = status.get(f);
      if (s) {
        const span = document.createElement('span');
        span.className = 'file-status';
        span.textContent = ` – ${s}`;
        li.append(span);
      }
      return li;
    }),
  );
  const multi = state.files.length > 1;
  $('nameField').hidden = multi;
  $('nameMultiHint').hidden = !multi;
  $('submitUpload').disabled = state.files.length === 0;
}

$('fileInput').addEventListener('change', () => addFiles($('fileInput').files));
const dropzone = $('dropzone');
for (const evt of ['dragenter', 'dragover']) {
  dropzone.addEventListener(evt, (/** @type {DragEvent} */ e) => {
    e.preventDefault();
    dropzone.classList.add('drag-over');
  });
}
for (const evt of ['dragleave', 'drop']) dropzone.addEventListener(evt, () => dropzone.classList.remove('drag-over'));
dropzone.addEventListener('drop', (/** @type {DragEvent} */ e) => {
  e.preventDefault();
  if (e.dataTransfer?.files.length) addFiles(e.dataTransfer.files);
});

// Sequential on purpose: keeps server memory flat and gives per-file feedback.
$('uploadForm').addEventListener('submit', async (/** @type {SubmitEvent} */ e) => {
  e.preventDefault();
  $('submitUpload').disabled = true;
  $('uploadError').textContent = '';
  const status = new Map(state.files.map((f) => [f, t('upload.pending')]));
  const errors = [];
  let ok = 0;
  /** @type {any} */
  let last = null;
  for (const file of state.files) {
    status.set(file, t('upload.busy'));
    renderFileList(status);
    const form = new FormData();
    form.append('file', file);
    form.append('name', state.files.length === 1 ? $('nameInput').value.trim() : '');
    form.append('tags', $('tagsInput').value.trim());
    try {
      last = await api('/api/icons', { method: 'POST', body: form });
      ok += 1;
      status.set(file, t('upload.done'));
    } catch (err) {
      const msg = errorText(err);
      status.set(file, msg);
      errors.push(`${file.name}: ${msg}`);
    }
    renderFileList(status);
  }
  await loadIcons();
  if (errors.length === 0) {
    $('uploadDialog').close();
    if (ok === 1 && last) await copyLink(last, document.createElement('button'));
    else showToast(t('upload.summary', { ok, total: state.files.length }));
  } else {
    $('uploadError').textContent = `${t('upload.summary', { ok, total: state.files.length })}. ${errors.join(' · ')}`;
    state.files = state.files.filter((f) => status.get(f) !== t('upload.done'));
    renderFileList(status);
  }
});

// Edit
/** @param {any} icon */
function openEdit(icon) {
  state.editing = icon;
  $('editName').value = icon.name;
  $('editTags').value = icon.tags.join(', ');
  $('editError').textContent = '';
  $('editDialog').showModal();
}
$('editForm').addEventListener('submit', async (/** @type {SubmitEvent} */ e) => {
  e.preventDefault();
  try {
    await sendJson(`/api/icons/${state.editing.id}`, { name: $('editName').value, tags: $('editTags').value }, 'PATCH');
    $('editDialog').close();
    showToast(t('toast.updated'));
    await loadIcons();
  } catch (err) {
    $('editError').textContent = errorText(err);
  }
});

// Delete – always via an explicit confirmation dialog.
/** @param {any} icon */
function openDelete(icon) {
  state.editing = icon;
  $('deleteText').textContent = t('delete.text', { name: icon.name });
  $('deleteError').textContent = '';
  $('deleteDialog').showModal();
}
$('deleteForm').addEventListener('submit', async (/** @type {SubmitEvent} */ e) => {
  e.preventDefault();
  try {
    await api(`/api/icons/${state.editing.id}`, { method: 'DELETE' });
    $('deleteDialog').close();
    showToast(t('toast.deleted'));
    await loadIcons();
  } catch (err) {
    $('deleteError').textContent = errorText(err);
  }
});

// Backup
$('openBackup').addEventListener('click', () => {
  $('importResult').textContent = '';
  $('backupDialog').showModal();
});
$('importForm').addEventListener('submit', async (/** @type {SubmitEvent} */ e) => {
  e.preventDefault();
  const file = $('importFile').files[0];
  if (!file) {
    $('importResult').textContent = t('no_file');
    return;
  }
  const form = new FormData();
  form.append('file', file);
  try {
    const r = await api('/api/import', { method: 'POST', body: form });
    $('importResult').textContent = t('backup.result', {
      imported: r.imported,
      skipped: r.skipped,
      failed: r.failed.length,
    });
    await loadIcons();
  } catch (err) {
    $('importResult').textContent = errorText(err);
  }
});

/** @param {number} bytes */
function formatBytes(bytes) {
  let n = bytes;
  let unit = 0;
  while (n >= 1024 && unit < BYTE_UNITS.length - 1) {
    n /= 1024;
    unit += 1;
  }
  return `${n.toLocaleString(state.lang, { maximumFractionDigits: unit === 0 ? 0 : 1 })} ${BYTE_UNITS[unit]}`;
}

boot();

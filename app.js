/* MyEasyPlant dashboard.
 *
 * Reads data/plants.json. When served from GitHub Pages it reads/writes through
 * the GitHub API (always-fresh data, no Pages-rebuild lag); served locally it
 * falls back to the relative file, read-only unless a token is set.
 *
 * Render model (same as BrickVault): state -> full re-render. Modals render
 * once on open and are not re-rendered while typing.
 */
'use strict';

// ---------- config ----------
const FALLBACK_OWNER = 'jesvasor';
const FALLBACK_REPO = 'MyEasyPlant';
const BRANCH = 'main';
const DATA_PATH = 'data/plants.json';
const ADD_WORKFLOW = 'add-plant.yml';

const CONFIG = (() => {
  const host = location.hostname;
  if (host.endsWith('.github.io')) {
    return {
      owner: host.split('.')[0],
      repo: location.pathname.split('/').filter(Boolean)[0] || FALLBACK_REPO,
      hosted: true,
    };
  }
  return { owner: FALLBACK_OWNER, repo: FALLBACK_REPO, hosted: false };
})();
const API = `https://api.github.com/repos/${CONFIG.owner}/${CONFIG.repo}`;

// ---------- state ----------
const state = {
  store: null, // { settings, plants }
  sha: null,   // sha of data/plants.json (needed for API writes)
  error: null,
};

const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function token() { return localStorage.getItem('mep_token') || ''; }

// ---------- date math ----------
// Keep in sync with scripts/check-reminders.js (same functions, CommonJS side).
function todayISO() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
function addMonthsClamped(iso, months) {
  const [y, m, d] = iso.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(d, lastDay));
  return t.toISOString().slice(0, 10);
}
function daysBetween(a, b) { // b - a in days
  return Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
}
function nextWaterISO(p) {
  if (!p.lastWatered || !p.waterEveryMonths) return null;
  return addMonthsClamped(p.lastWatered, p.waterEveryMonths);
}
function waterStatus(p) {
  const next = nextWaterISO(p);
  if (!next) return { cls: 'due-soon', label: 'set last watered date', next: null, days: null };
  const days = daysBetween(todayISO(), next);
  if (days < 0) return { cls: 'overdue', label: `Overdue ${-days}d`, next, days };
  if (days === 0) return { cls: 'overdue', label: 'Due today', next, days };
  if (days <= 7) return { cls: 'due-soon', label: `Due in ${days}d`, next, days };
  return { cls: 'ok', label: `in ${days}d`, next, days };
}
function fmtDate(iso) {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

// ---------- data IO ----------
async function ghFetch(path, opts = {}) {
  const headers = Object.assign(
    { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    opts.headers || {}
  );
  const t = token();
  if (t) headers.Authorization = 'Bearer ' + t;
  const res = await fetch(API + path, Object.assign({}, opts, { headers, cache: 'no-store' }));
  return res;
}

const b64encode = (s) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
const b64decode = (b) => new TextDecoder().decode(Uint8Array.from(atob(b.replace(/\n/g, '')), (c) => c.charCodeAt(0)));

async function loadData() {
  // Local dev: relative file (fresh because no CDN involved).
  if (!CONFIG.hosted) {
    try {
      const res = await fetch(DATA_PATH + '?ts=' + Date.now(), { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      state.store = await res.json();
      state.sha = null;
      state.error = null;
      return;
    } catch (e) {
      state.error = 'Could not load ' + DATA_PATH + ' — serve the repo root (e.g. python -m http.server). ' + e.message;
      return;
    }
  }
  // Hosted: GitHub contents API — fresh immediately after any commit.
  const res = await ghFetch(`/contents/${DATA_PATH}?ref=${BRANCH}`);
  if (!res.ok) {
    state.error = `Could not load data from GitHub API (HTTP ${res.status}).` +
      (res.status === 403 ? ' Rate limit? Add your token in Settings to raise it.' : '');
    return;
  }
  const j = await res.json();
  state.sha = j.sha;
  state.store = JSON.parse(b64decode(j.content));
  state.error = null;
}

async function saveData(message) {
  if (!token()) { openSettings('A GitHub token is required to save changes.'); return false; }
  const body = {
    message,
    content: b64encode(JSON.stringify(state.store, null, 2) + '\n'),
    branch: BRANCH,
  };
  if (state.sha) body.sha = state.sha;
  let res = await ghFetch(`/contents/${DATA_PATH}`, { method: 'PUT', body: JSON.stringify(body) });
  if (res.status === 409 || res.status === 422) {
    // sha conflict — someone else committed; re-read, re-apply is caller's job.
    await loadData();
    body.sha = state.sha;
    res = await ghFetch(`/contents/${DATA_PATH}`, { method: 'PUT', body: JSON.stringify(body) });
  }
  if (!res.ok) {
    const detail = (await res.json().catch(() => ({}))).message || '';
    toast(`Save failed (HTTP ${res.status}) ${detail}`, true);
    return false;
  }
  state.sha = (await res.json()).content.sha;
  return true;
}

// ---------- actions ----------
async function markWatered(id, dateISO) {
  const p = state.store.plants.find((x) => x.id === id);
  if (!p) return;
  p.lastWatered = dateISO;
  render();
  const ok = await saveData(`water: ${p.name} watered ${dateISO}`);
  toast(ok ? `💧 ${p.name} marked watered (${fmtDate(dateISO)})` : 'Not saved — see settings', !ok);
  if (ok) render();
}

async function removePlant(id) {
  const p = state.store.plants.find((x) => x.id === id);
  if (!p) return;
  if (!confirm(`Remove "${p.name}" from your plants? The record is deleted from the dashboard (it stays in git history).`)) return;
  state.store.plants = state.store.plants.filter((x) => x.id !== id);
  render();
  if (await saveData(`data: remove plant ${p.name}`)) toast(`Removed ${p.name}`);
}

async function saveSettings(days) {
  state.store.settings.reminderEveryDays = days;
  const ok = await saveData(`settings: reminder cadence every ${days} days`);
  if (ok) toast('Settings saved');
  return ok;
}

async function dispatchAddPlant(url, lastWatered, statusEl) {
  const inputs = { url };
  if (lastWatered) inputs.last_watered = lastWatered;
  const res = await ghFetch(`/actions/workflows/${ADD_WORKFLOW}/dispatches`, {
    method: 'POST',
    body: JSON.stringify({ ref: BRANCH, inputs }),
  });
  if (res.status !== 204) {
    const detail = (await res.json().catch(() => ({}))).message || '';
    throw new Error(`workflow dispatch failed (HTTP ${res.status}) ${detail}`);
  }
  // Poll until the plant shows up (scrape + commit usually takes ~30-60s).
  const before = state.store.plants.length;
  for (let i = 0; i < 24; i++) {
    statusEl.textContent = `Fetching from easyplant… (${(i + 1) * 10}s)`;
    await new Promise((r) => setTimeout(r, 10000));
    await loadData();
    if (state.store.plants.length > before) return true;
  }
  return false;
}

// ---------- rendering ----------
function assetSrc(repoPath, p) {
  if (!repoPath) return null;
  if (CONFIG.hosted)
    return `https://raw.githubusercontent.com/${CONFIG.owner}/${CONFIG.repo}/${BRANCH}/${repoPath}?v=${encodeURIComponent(p.addedAt || '')}`;
  return repoPath;
}
function imgSrc(p) {
  return assetSrc(p.image, p);
}

function glanceChips(p) {
  const c = p.care || {};
  const chips = [];
  if (p.waterPeriod) chips.push(`💧 every ${p.waterEveryMonths > 1 ? p.waterEveryMonths + ' months' : 'month'}`);
  if (c.height) chips.push('📏 ' + c.height);
  if (c.petFriendly) chips.push('🐾 Pet friendly');
  if (c.bloomingSeason) chips.push('🌸 ' + c.bloomingSeason);
  for (const t of c.light?.traits || []) chips.push('☀️ ' + (t.trait || t));
  if (c.areaOfGrowth) chips.push('🌍 ' + c.areaOfGrowth);
  return chips;
}

// The glance description is just the plant bio. Prefer the clean structured
// about.text; fall back to the scraped glance text after its "<Name> Bio"
// heading, trimmed to the first paragraph.
function bioText(c) {
  const about = c.about?.text && stripHtml(c.about.text);
  if (about) return about;
  const gt = c.glanceText;
  if (!gt) return null;
  return gt.replace(/^.*? Bio /, '');
}

function cardHTML(p) {
  const st = waterStatus(p);
  const c = p.care || {};
  const sub = [p.size, p.pot, p.potColor].filter(Boolean).join(' · ');
  const img = imgSrc(p);
  const chips = glanceChips(p).map((t) => `<span class="chip">${esc(t)}</span>`).join('');
  const faq = (c.faq || [])
    .map((f) => `<h4>${esc(f.title)}</h4><p>${esc(f.text)}</p>`)
    .join('');
  return `
  <article class="card ${st.cls === 'overdue' ? 'overdue' : ''}" data-id="${esc(p.id)}">
    ${img ? `<img class="card-img" src="${esc(img)}" alt="${esc(p.name)}" loading="lazy" />` : ''}
    <div class="card-body">
      <div>
        <h2>${esc(p.name)}</h2>
        ${sub ? `<div class="sub">${esc(sub)}</div>` : ''}
      </div>
      <div><span class="pill ${st.cls}">${esc(st.label)}</span></div>
      <dl class="dates">
        <dt>Last watered</dt>
        <dd>${fmtDate(p.lastWatered)} <button class="edit-date" data-act="edit-date" title="Edit date">✏️</button></dd>
        <dt>Next water</dt>
        <dd><strong>${fmtDate(st.next)}</strong></dd>
      </dl>
      <div class="water-row">
        <button class="btn primary" data-act="water-today">💧 Watered today</button>
        <button class="link-btn" data-act="water-date">on a date…</button>
      </div>
      <div class="date-inline" data-role="date-editor" hidden>
        <input type="date" max="${todayISO()}" value="${esc(p.lastWatered || todayISO())}" />
        <button class="btn small primary" data-act="date-save">Save</button>
        <button class="btn small" data-act="date-cancel">Cancel</button>
      </div>
      <details class="section">
        <summary>At a glance</summary>
        <div class="section-body">
          <div class="chips">${chips}</div>
          ${bioText(c) ? `<p>${esc(bioText(c))}</p>` : ''}
        </div>
      </details>
      <details class="section">
        <summary>Light</summary>
        <div class="section-body">
          <div class="chips">${(c.light?.traits || []).map((t) => `<span class="chip">☀️ ${esc(t.trait || t)}</span>`).join('')}</div>
          <p>${esc(c.light?.text || 'No light instructions saved.')}</p>
          ${c.lightImage ? `<img class="light-img" src="${esc(assetSrc(c.lightImage, p))}" alt="Where to place ${esc(p.name)} for good light" loading="lazy" />` : ''}
        </div>
      </details>
      <details class="section">
        <summary>Care &amp; details</summary>
        <div class="section-body">
          ${c.water?.text ? `<h4>Watering</h4><p>${esc(stripHtml(c.water.text))}</p>` : ''}
          ${c.careText ? `<h4>Plant care</h4><p>${esc(stripHtml(c.careText))}</p>` : ''}
          ${c.humidity?.text ? `<h4>${esc(c.humidity.title || 'Temperature & humidity')}</h4><p>${esc(stripHtml(c.humidity.text))}</p>` : ''}
          ${c.growth?.text ? `<h4>${esc(c.growth.title || 'Growth')}</h4><p>${esc(stripHtml(c.growth.text))}</p>` : ''}
          ${c.toxicity?.text ? `<h4>${esc(c.toxicity.title || 'Toxicity')}</h4><p>${esc(stripHtml(c.toxicity.text))}</p>` : ''}
          ${c.troubleshooting?.text ? `<h4>${esc(c.troubleshooting.title || 'Troubleshooting')}</h4><p>${esc(stripHtml(c.troubleshooting.text))}</p>` : ''}
          ${faq}
          <div class="card-links">
            <a href="${esc(p.url)}" target="_blank" rel="noopener">easyplant page ↗</a>
            <button class="btn small danger" data-act="remove">Remove plant</button>
          </div>
        </div>
      </details>
    </div>
  </article>`;
}

function stripHtml(s) {
  const d = document.createElement('div');
  d.innerHTML = s || '';
  return d.textContent.trim();
}

function render() {
  const main = $('#main');
  if (state.error) {
    main.innerHTML = `<div class="empty">⚠️ ${esc(state.error)}</div>`;
    return;
  }
  if (!state.store) return;
  const plants = [...state.store.plants].sort((a, b) => {
    const da = waterStatus(a).days ?? 9e9;
    const db = waterStatus(b).days ?? 9e9;
    return da - db;
  });
  const overdue = plants.filter((p) => (waterStatus(p).days ?? 1) <= 0).length;
  $('#topbarStatus').innerHTML =
    `${plants.length} plant${plants.length === 1 ? '' : 's'}` +
    (overdue ? ` · <span class="alert">${overdue} need${overdue === 1 ? 's' : ''} water</span>` : ' · all watered 🎉');
  main.innerHTML = plants.length
    ? `<div class="grid">${plants.map(cardHTML).join('')}</div>`
    : `<div class="empty">No plants yet — add your first with the ＋ button.</div>`;
  $('#foot').innerHTML =
    `Email reminders: every ${esc(state.store.settings?.reminderEveryDays ?? 3)} days while something is overdue · ` +
    `data lives in <a href="https://github.com/${CONFIG.owner}/${CONFIG.repo}" target="_blank" rel="noopener">${CONFIG.owner}/${CONFIG.repo}</a>`;
}

// ---------- card events (delegated) ----------
$('#main').addEventListener('click', (ev) => {
  const btn = ev.target.closest('[data-act]');
  if (!btn) return;
  const card = ev.target.closest('.card');
  const id = card?.dataset.id;
  const act = btn.dataset.act;
  const editor = card?.querySelector('[data-role="date-editor"]');
  if (act === 'water-today') markWatered(id, todayISO());
  else if (act === 'water-date' || act === 'edit-date') editor.hidden = false;
  else if (act === 'date-cancel') editor.hidden = true;
  else if (act === 'date-save') {
    const v = editor.querySelector('input').value;
    if (v) markWatered(id, v);
  } else if (act === 'remove') removePlant(id);
});

// ---------- modals ----------
function openModal(html) {
  const root = $('#modal-root');
  root.innerHTML = `<div class="modal-backdrop"><div class="modal">${html}</div></div>`;
  root.firstElementChild.addEventListener('click', (e) => {
    if (e.target === root.firstElementChild) closeModal();
  });
  return root;
}
function closeModal() { $('#modal-root').innerHTML = ''; }

function openSettings(notice) {
  const s = state.store?.settings || { reminderEveryDays: 3 };
  const root = openModal(`
    <h2>⚙️ Settings</h2>
    ${notice ? `<p class="error">${esc(notice)}</p>` : ''}
    <label>GitHub token (stored only on this device)</label>
    <input type="password" id="setToken" value="${esc(token())}" placeholder="github_pat_…" autocomplete="off" />
    <details class="help">
      <summary>How to create the token (one time, ~2 min)</summary>
      <ol>
        <li>GitHub → Settings → Developer settings → <em>Fine-grained personal access tokens</em> → Generate new token.</li>
        <li>Repository access: <strong>Only ${esc(CONFIG.owner)}/${esc(CONFIG.repo)}</strong>.</li>
        <li>Permissions → Repository permissions: <strong>Contents: Read and write</strong> and <strong>Actions: Read and write</strong>.</li>
        <li>Expiration: up to you (you'll paste a new one here when it expires).</li>
        <li>Copy it and paste it above — do this once per device (desktop, phone).</li>
      </ol>
    </details>
    <label>Email reminders: check every N days</label>
    <input type="number" id="setDays" min="1" max="30" value="${esc(s.reminderEveryDays ?? 3)}" />
    <p class="hint">While any plant is overdue, an email is sent at most once every N days until you mark it watered. Saving this needs the token.</p>
    <div class="row">
      <button class="btn" id="setCancel">Close</button>
      <button class="btn primary" id="setSave">Save</button>
    </div>
  `);
  $('#setCancel', root).onclick = closeModal;
  $('#setSave', root).onclick = async () => {
    const t = $('#setToken', root).value.trim();
    if (t) localStorage.setItem('mep_token', t);
    else localStorage.removeItem('mep_token');
    const days = Math.max(1, Math.min(30, parseInt($('#setDays', root).value, 10) || 3));
    if (state.store && days !== state.store.settings.reminderEveryDays) {
      if (!(await saveSettings(days))) return;
    } else {
      toast('Settings saved');
    }
    closeModal();
    render();
  };
}

function openAddPlant() {
  if (!token()) { openSettings('Set your GitHub token first — adding a plant runs a GitHub Action.'); return; }
  const root = openModal(`
    <h2>＋ Add a plant</h2>
    <p class="hint">Paste the easyplant product URL <strong>with the pot &amp; color you bought</strong> (open the product on easyplant.com, pick your pot/color, copy the address). All details and the photo are saved locally so it won't matter if easyplant later removes the page.</p>
    <label>easyplant URL</label>
    <input type="url" id="addUrl" placeholder="https://easyplant.com/products/…?pot=…&variant=…" />
    <label>Last watered (optional — defaults to today)</label>
    <input type="date" id="addDate" max="${todayISO()}" />
    <div class="row">
      <button class="btn" id="addCancel">Cancel</button>
      <button class="btn primary" id="addGo">Fetch &amp; add</button>
    </div>
    <div class="progress" id="addProgress" hidden></div>
    <div class="error" id="addError" hidden></div>
  `);
  $('#addCancel', root).onclick = closeModal;
  $('#addGo', root).onclick = async () => {
    const url = $('#addUrl', root).value.trim();
    const date = $('#addDate', root).value || null;
    const err = $('#addError', root);
    const prog = $('#addProgress', root);
    err.hidden = true;
    if (!/^https:\/\/(www\.)?easyplant\.com\/products\//.test(url)) {
      err.textContent = 'That does not look like an easyplant product URL.';
      err.hidden = false;
      return;
    }
    $('#addGo', root).disabled = true;
    prog.hidden = false;
    prog.textContent = 'Starting the fetch job on GitHub…';
    try {
      const found = await dispatchAddPlant(url, date, prog);
      closeModal();
      render();
      toast(found ? '🌱 Plant added!' : 'Job started but taking long — refresh in a minute.', !found);
    } catch (e) {
      prog.hidden = true;
      err.textContent = e.message;
      err.hidden = false;
      $('#addGo', root).disabled = false;
    }
  };
}

$('#btnSettings').onclick = () => openSettings();
$('#btnAdd').onclick = openAddPlant;

// ---------- toast ----------
function toast(msg, isError) {
  const el = document.createElement('div');
  el.className = 'toast' + (isError ? ' error' : '');
  el.textContent = msg;
  $('#toast-root').appendChild(el);
  setTimeout(() => el.remove(), isError ? 6000 : 3500);
}

// ---------- boot ----------
(async function boot() {
  await loadData();
  render();
  // Refresh when returning to the tab (phone: app switch back).
  document.addEventListener('visibilitychange', async () => {
    if (!document.hidden) { await loadData(); render(); }
  });
})();

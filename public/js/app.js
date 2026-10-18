import { api, setUnauthorizedHandler } from './api.js';
import { html, icon, initials, toast, setCurrency, showErrors, clearErrors, formValues } from './ui.js';
import { dashboardView } from './views/dashboard.js';
import { assetListView, assetDetailView, assetFormView } from './views/assets.js';
import { employeeListView, employeeDetailView } from './views/employees.js';
import { licenseListView, licenseDetailView } from './views/licenses.js';
import { importView } from './views/import.js';
import { labelsView } from './views/labels.js';
import { activityView } from './views/activity.js';
import { adminView, accountView } from './views/admin.js';

export const state = { user: null, settings: {}, demo: false, demoAccounts: [], setupNeeded: false };

const ROLE_RANK = { viewer: 1, editor: 2, admin: 3 };
export const can = (role) => !!state.user && ROLE_RANK[state.user.role] >= ROLE_RANK[role];

const routes = [
  [/^\/$/, dashboardView, 'dashboard'],
  [/^\/assets$/, assetListView, 'assets'],
  [/^\/assets\/new$/, assetFormView, 'assets'],
  [/^\/assets\/(\d+)$/, assetDetailView, 'assets'],
  [/^\/assets\/(\d+)\/edit$/, assetFormView, 'assets'],
  [/^\/employees$/, employeeListView, 'employees'],
  [/^\/employees\/(\d+)$/, employeeDetailView, 'employees'],
  [/^\/licenses$/, licenseListView, 'licenses'],
  [/^\/licenses\/(\d+)$/, licenseDetailView, 'licenses'],
  [/^\/import$/, importView, 'import'],
  [/^\/labels$/, labelsView, 'labels'],
  [/^\/activity$/, activityView, 'activity'],
  [/^\/admin$/, adminView, 'admin'],
  [/^\/account$/, accountView, 'account'],
  [/^\/scan\/(.+)$/, scanView, 'assets'],
];

const NAV = [
  ['', 'dashboard', 'Dashboard', 'dashboard'],
  ['assets', 'box', 'Assets', 'assets'],
  ['employees', 'users', 'Employees', 'employees'],
  ['licenses', 'key', 'Licenses', 'licenses'],
  null,
  ['import', 'upload', 'Import & export', 'import'],
  ['labels', 'qr', 'QR labels', 'labels'],
  ['activity', 'activity', 'Activity log', 'activity'],
];

export function navigate(path) {
  if (location.hash === `#${path}`) route();
  else location.hash = path;
}

function parseHash() {
  const h = location.hash.replace(/^#/, '') || '/';
  const [path, query = ''] = h.split('?');
  return { path: path || '/', query: new URLSearchParams(query) };
}

/** Replaces the query string of the current route without adding a history entry. */
export function setQuery(params) {
  const { path } = parseHash();
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') p.set(k, v);
  const s = p.toString();
  history.replaceState(null, '', `#${path}${s ? `?${s}` : ''}`);
}

const root = document.getElementById('app');
let shellRendered = false;

function renderShell() {
  const adminLink = can('admin') ? html`<a href="#/admin" data-nav="admin">${icon('settings')}Admin</a>` : '';
  root.innerHTML = html`
    <div class="shell">
      <aside class="sidebar" aria-label="Main navigation">
        <a class="brand" href="#/"><img src="/favicon.svg" alt=""><span>AssetDesk<small>${state.settings.company_name}</small></span></a>
        <nav class="nav">
          ${NAV.map((n) => (n ? html`<a href="#/${n[0]}" data-nav="${n[3]}">${icon(n[1])}${n[2]}</a>` : html`<div class="nav-section">Tools</div>`))}
          ${adminLink}
        </nav>
        <div class="sidebar-foot">
          <a class="user-chip" href="#/account" title="Your account">
            <span class="avatar">${initials(state.user.name)}</span>
            <div><strong>${state.user.name}</strong><span>${state.user.role}</span></div>
          </a>
          <div class="actions">
            <button class="btn small ghost" id="themeBtn" title="Toggle dark mode">${icon('moon')}Theme</button>
            <button class="btn small ghost" id="logoutBtn">${icon('logout')}Sign out</button>
          </div>
        </div>
      </aside>
      <div class="main">
        ${state.demo ? html`<div class="demo-banner">Public demo: all data is fictional and resets every few hours. Sign in as Viewer, Editor or Admin to try each role.</div>` : ''}
        <header class="topbar">
          <button class="btn ghost menu-btn" id="menuBtn" aria-label="Open menu">${icon('menu')}</button>
          <form class="search" id="globalSearch" role="search">
            <label class="sr-only" for="gq">Search assets</label>
            <input id="gq" type="search" placeholder="Search by tag, serial, name or person…" autocomplete="off">
          </form>
          ${can('editor') ? html`<a class="btn primary" href="#/assets/new">${icon('plus')}<span class="hide-sm">New asset</span></a>` : ''}
        </header>
        <main class="content" id="content" tabindex="-1"></main>
      </div>
    </div>`.toString();

  document.getElementById('logoutBtn').onclick = async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    state.user = null;
    shellRendered = false;
    navigate('/login');
  };
  document.getElementById('themeBtn').onclick = () => {
    const dark = document.documentElement.dataset.theme
      ? document.documentElement.dataset.theme === 'dark'
      : matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.dataset.theme = dark ? 'light' : 'dark';
    try { localStorage.setItem('assetdesk-theme', document.documentElement.dataset.theme); } catch { /* storage blocked */ }
  };
  const shell = root.querySelector('.shell');
  document.getElementById('menuBtn').onclick = () => shell.classList.toggle('nav-open');
  root.querySelector('.sidebar').addEventListener('click', (e) => { if (e.target.closest('a')) shell.classList.remove('nav-open'); });
  document.getElementById('globalSearch').onsubmit = async (e) => {
    e.preventDefault();
    const q = document.getElementById('gq').value.trim();
    if (!q) return;
    // An exact tag or serial jumps straight to the asset (handy with a barcode scanner).
    try {
      const { id } = await api(`/assets/by-tag/${encodeURIComponent(q)}`);
      navigate(`/assets/${id}`);
    } catch {
      navigate(`/assets?q=${encodeURIComponent(q)}`);
    }
    document.getElementById('gq').value = '';
  };
  shellRendered = true;
}

async function scanView({ params }) {
  try {
    const { id } = await api(`/assets/by-tag/${encodeURIComponent(decodeURIComponent(params[0]))}`);
    history.replaceState(null, '', `#/assets/${id}`);
    route();
  } catch (err) {
    return html`<div class="card card-pad"><h1>Asset not found</h1><p class="muted">${err.message}</p></div>`;
  }
  return null;
}

function loginView() {
  shellRendered = false;
  const demoBlock = state.demo ? html`
    <div class="callout">This is a public demo with fictional data. Pick an account to sign in:</div>
    <div class="demo-accounts">${state.demoAccounts.map((a) => html`
      <button type="button" class="btn" data-email="${a.email}" data-password="${a.password}">
        <span><strong>${a.role}</strong> <span class="muted">· ${a.email}</span></span><span>→</span></button>`)}</div>
    <div class="muted" style="text-align:center;font-size:12px">or sign in manually</div>` : '';
  root.innerHTML = html`
    <div class="login-wrap"><div class="login">
      <form class="card" id="loginForm" novalidate>
        <div class="brand"><img src="/favicon.svg" alt=""><span>AssetDesk<small>${state.settings.company_name || ''}</small></span></div>
        <div><h1>Sign in</h1><p class="muted" style="margin:4px 0 0">IT asset and license inventory</p></div>
        ${demoBlock}
        ${state.setupNeeded ? html`<div class="callout warn">No accounts exist yet. Ask your administrator to set ADMIN_EMAIL and ADMIN_PASSWORD on the server, or run <span class="mono">npm run create-admin</span>.</div>` : ''}
        <label class="field">Email<input type="email" name="email" autocomplete="username" required></label>
        <label class="field">Password<input type="password" name="password" autocomplete="current-password" required></label>
        <div class="field-error" data-error-for="_form" role="alert"></div>
        <button class="btn primary" type="submit">Sign in</button>
      </form>
    </div></div>`.toString();
  const form = document.getElementById('loginForm');
  const submit = async (email, password) => {
    clearErrors(form);
    try {
      const { user } = await api('/auth/login', { method: 'POST', body: { email, password } });
      state.user = user;
      await loadSession();
      navigate(sessionStorage.getItem('assetdesk-after-login') || '/');
      sessionStorage.removeItem('assetdesk-after-login');
    } catch (err) {
      showErrors(form, { message: err.message });
    }
  };
  form.onsubmit = (e) => { e.preventDefault(); const v = formValues(form); submit(v.email, v.password); };
  form.querySelectorAll('[data-email]').forEach((b) => { b.onclick = () => submit(b.dataset.email, b.dataset.password); });
  form.querySelector('[name=email]').focus();
}

async function loadSession() {
  const me = await api('/auth/me');
  Object.assign(state, { user: me.user, demo: me.demo, demoAccounts: me.demoAccounts || [], setupNeeded: me.setupNeeded, settings: me.settings || {} });
  setCurrency(state.settings.currency);
}

let routeSeq = 0;
export async function route() {
  const { path, query } = parseHash();
  if (path === '/login') { if (state.user) return navigate('/'); return loginView(); }
  if (!state.user) {
    if (path !== '/') sessionStorage.setItem('assetdesk-after-login', location.hash.slice(1));
    return navigate('/login');
  }
  if (!shellRendered) renderShell();
  const match = routes.map(([re, view, nav]) => [re.exec(path), view, nav]).find(([m]) => m);
  const content = document.getElementById('content');
  root.querySelectorAll('[data-nav]').forEach((a) => a.toggleAttribute('aria-current', false));
  if (!match) {
    content.innerHTML = html`<div class="card card-pad"><h1>Page not found</h1><p><a href="#/">Go to the dashboard</a></p></div>`.toString();
    return;
  }
  const [m, view, nav] = match;
  root.querySelector(`[data-nav="${nav}"]`)?.setAttribute('aria-current', 'page');
  const seq = ++routeSeq;
  // Each view gets a fresh element, so listeners from the previous page are dropped with it.
  const el = document.createElement('div');
  el.innerHTML = '<div class="skeleton">Loading…</div>';
  content.replaceChildren(el);
  try {
    const out = await view({ el, params: m.slice(1), query, navigate, isCurrent: () => seq === routeSeq });
    if (seq !== routeSeq) return;
    if (out) el.innerHTML = out.toString();
  } catch (err) {
    if (seq !== routeSeq) return;
    if (err.status === 401) return;
    el.innerHTML = html`<div class="card card-pad"><h1>${err.status === 404 ? 'Not found' : 'Something went wrong'}</h1><p class="muted">${err.message}</p></div>`.toString();
  }
  window.scrollTo(0, 0);
  document.title = `${el.querySelector('h1')?.textContent || 'AssetDesk'} · AssetDesk`;
}

setUnauthorizedHandler(() => {
  if (!state.user) return;
  state.user = null;
  shellRendered = false;
  toast('Your session has ended. Please sign in again.', 'error');
  navigate('/login');
});

try {
  const t = localStorage.getItem('assetdesk-theme');
  if (t) document.documentElement.dataset.theme = t;
} catch { /* storage blocked */ }

window.addEventListener('hashchange', route);
loadSession()
  .catch(() => {})
  .finally(() => { root.classList.remove('booting'); root.removeAttribute('aria-busy'); route(); });

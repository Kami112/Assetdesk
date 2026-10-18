// Shared UI helpers: auto-escaping templates, formatting, toasts, dialogs and icons.

class Safe {
  constructor(s) { this.s = s; }
  toString() { return this.s; }
}
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ESC[c]);
const render = (v) => {
  if (v == null || v === false) return '';
  if (v instanceof Safe) return v.s;
  if (Array.isArray(v)) return v.map(render).join('');
  return esc(v);
};

/** Tagged template that escapes every interpolated value unless it is itself html`` output. */
export function html(strings, ...values) {
  let out = strings[0];
  values.forEach((v, i) => { out += render(v) + strings[i + 1]; });
  return new Safe(out);
}
export const raw = (s) => new Safe(s);

export const STATUS_LABELS = { in_use: 'In use', in_stock: 'In stock', in_repair: 'In repair', retired: 'Retired', lost: 'Lost' };
export const statusChip = (s) => html`<span class="chip ${s}">${STATUS_LABELS[s] || s}</span>`;

let currency = 'USD';
export const setCurrency = (c) => { currency = c || 'USD'; };
export function money(n, { decimals = 0 } = {}) {
  if (n == null || n === '') return '—';
  return `${currency} ${Number(n).toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
}
export const num = (n) => (n == null ? '—' : Number(n).toLocaleString('en-US'));

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function fmtDate(iso) {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}
export function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${fmtDate(d.toISOString())} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}
export const monthLabel = (ym) => `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(2, 4)}`;
export function daysUntil(iso) {
  if (!iso) return null;
  const today = new Date(new Date().toISOString().slice(0, 10));
  return Math.round((new Date(iso.slice(0, 10)) - today) / 86400000);
}
export function relTime(iso) {
  if (!iso) return '—';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} d ago`;
  return fmtDate(iso);
}
/** "in 12 days" / "3 days ago" with a severity class for warranty and license dates. */
export function dueChip(iso, { soon = 90 } = {}) {
  const d = daysUntil(iso);
  if (d == null) return html`<span class="muted">—</span>`;
  if (d < 0) return html`<span class="chip bad" title="${fmtDate(iso)}">Expired ${fmtDate(iso)}</span>`;
  if (d <= soon) return html`<span class="chip warn" title="${fmtDate(iso)}">${d === 0 ? 'Today' : `In ${d} day${d === 1 ? '' : 's'}`}</span>`;
  return html`<span>${fmtDate(iso)}</span>`;
}
export const initials = (name) => (name || '?').split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();

/* ---------- Toasts ---------- */
export function toast(message, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), type === 'error' ? 6000 : 3500);
}

/* ---------- Dialogs ---------- */
const modal = () => document.getElementById('modal');

export function confirmDialog({ title, body = '', confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    const dlg = modal();
    dlg.innerHTML = html`
      <form method="dialog">
        <div class="modal-head"><h2>${title}</h2>${body ? html`<p>${body}</p>` : ''}</div>
        <div class="modal-foot" style="margin-top:16px">
          <button class="btn" value="cancel">Cancel</button>
          <button class="btn ${danger ? 'danger' : 'primary'}" value="ok" autofocus>${confirmLabel}</button>
        </div>
      </form>`.toString();
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true });
    dlg.showModal();
  });
}

/**
 * Shows a form in a dialog. `onSubmit(values)` may throw an API error with `errors`;
 * those are shown next to the matching fields and the dialog stays open.
 */
export function formDialog({ title, description = '', body, submitLabel = 'Save', danger = false, onSubmit, onOpen }) {
  return new Promise((resolve) => {
    const dlg = modal();
    dlg.innerHTML = html`
      <form novalidate>
        <div class="modal-head"><h2>${title}</h2>${description ? html`<p>${description}</p>` : ''}</div>
        <div class="modal-body">${body}<div class="field-error" data-error-for="_form"></div></div>
        <div class="modal-foot">
          <button type="button" class="btn" data-cancel>Cancel</button>
          <button type="submit" class="btn ${danger ? 'danger' : 'primary'}">${submitLabel}</button>
        </div>
      </form>`.toString();
    const form = dlg.querySelector('form');
    let result;
    dlg.querySelector('[data-cancel]').onclick = () => dlg.close();
    form.onsubmit = async (e) => {
      e.preventDefault();
      clearErrors(form);
      const submit = form.querySelector('[type=submit]');
      submit.disabled = true;
      try {
        result = await onSubmit(formValues(form), form);
        dlg.close();
      } catch (err) {
        showErrors(form, err);
      } finally {
        submit.disabled = false;
      }
    };
    dlg.addEventListener('close', () => resolve(result), { once: true });
    dlg.showModal();
    onOpen?.(form);
    form.querySelector('input:not([type=hidden]), select, textarea')?.focus();
  });
}

export function formValues(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name || el.disabled) continue;
    if (el.type === 'checkbox') out[el.name] = el.checked;
    else if (el.type === 'radio') { if (el.checked) out[el.name] = el.value; }
    else out[el.name] = el.value;
  }
  return out;
}

export function clearErrors(root) {
  root.querySelectorAll('[data-error-for]').forEach((el) => { el.textContent = ''; });
  root.querySelectorAll('[aria-invalid]').forEach((el) => el.removeAttribute('aria-invalid'));
}

export function showErrors(root, err) {
  const errors = err.errors || { _form: err.message };
  let shownAny = false;
  for (const [key, msg] of Object.entries(errors)) {
    const slot = root.querySelector(`[data-error-for="${key}"]`);
    const input = root.querySelector(`[name="${key}"]`);
    if (input) input.setAttribute('aria-invalid', 'true');
    if (slot) { slot.textContent = msg; shownAny = true; }
  }
  if (!shownAny) {
    const slot = root.querySelector('[data-error-for="_form"]');
    if (slot) slot.textContent = err.message; else toast(err.message, 'error');
  }
  root.querySelector('[aria-invalid="true"]')?.focus();
}

/** A labelled form field with an error slot. */
export function field(label, name, { type = 'text', value = '', hint = '', required = false, options = null, attrs = '', span = false } = {}) {
  let control;
  if (options) {
    control = html`<select name="${name}" id="f-${name}" ${raw(attrs)}>${options.map(([v, l]) =>
      html`<option value="${v}" ${String(v) === String(value ?? '') ? raw('selected') : ''}>${l}</option>`)}</select>`;
  } else if (type === 'textarea') {
    control = html`<textarea name="${name}" id="f-${name}" ${raw(attrs)}>${value ?? ''}</textarea>`;
  } else {
    control = html`<input type="${type}" name="${name}" id="f-${name}" value="${value ?? ''}" ${required ? raw('required') : ''} ${raw(attrs)}>`;
  }
  return html`<label class="field ${span ? 'span-all' : ''}" for="f-${name}">
    <span>${label}${required ? html` <span class="muted">*</span>` : ''}</span>${control}
    ${hint ? html`<span class="hint">${hint}</span>` : ''}
    <span class="field-error" data-error-for="${name}"></span></label>`;
}

/* ---------- Downloads ---------- */
export async function download(url, fallbackName) {
  const res = await fetch(url, { headers: { 'X-Requested-With': 'AssetDesk' }, credentials: 'same-origin' });
  if (!res.ok) {
    let msg = `Download failed (${res.status})`;
    try { msg = (await res.json()).error || msg; } catch { /* not JSON */ }
    throw new Error(msg);
  }
  const blob = await res.blob();
  const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') || '')?.[1] || fallbackName;
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

/* ---------- Icons (24px stroke icons) ---------- */
const ICONS = {
  dashboard: '<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>',
  box: '<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="m3 8 9 5 9-5M12 13v8"/>',
  users: '<circle cx="9" cy="8" r="4"/><path d="M2 21a7 7 0 0 1 14 0"/><path d="M16 4a4 4 0 0 1 0 8M22 21a7 7 0 0 0-4-6.3"/>',
  key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.7 12.3 9.8-9.8M17 6l3 3M14.5 8.5l2 2"/>',
  upload: '<path d="M12 15V3M7 8l5-5 5 5"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>',
  download: '<path d="M12 3v12M7 10l5 5 5-5"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>',
  qr: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17 17h4v4h-4"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  edit: '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 1 1 3 3L7 19l-4 1 1-4z"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  print: '<path d="M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>',
  arrowDown: '<path d="M12 5v14M19 12l-7 7-7-7"/>',
  arrowUp: '<path d="M12 19V5M5 12l7-7 7 7"/>',
};
export const icon = (name) => raw(`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`);

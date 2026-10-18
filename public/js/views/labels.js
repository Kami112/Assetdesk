import { api, qs } from '../api.js';
import { html, raw, icon, STATUS_LABELS } from '../ui.js';
import { state } from '../app.js';
import { CATEGORIES } from './assets.js';

export async function labelsView({ el, query }) {
  const ids = query.get('ids') || '';
  const f = { category: query.get('category') || '', location: query.get('location') || '', status: query.get('status') || '' };
  const facets = (await api('/assets?pageSize=1')).facets;

  el.innerHTML = html`
    <div class="page-head no-print">
      <div><h1>QR labels</h1><p>Print and stick these on devices. Scanning one with a phone camera opens the asset in AssetDesk.</p></div>
      <div class="actions"><button class="btn primary" id="print">${icon('print')}Print</button></div>
    </div>
    ${ids ? html`<div class="callout no-print" style="margin-bottom:14px">Showing the assets you selected. <a href="#/labels">Choose by filter instead</a></div>`
      : html`<form class="filters no-print" id="lf">
        <select name="category" aria-label="Category"><option value="">All categories</option>${CATEGORIES.map((c) => html`<option ${c === f.category ? raw('selected') : ''}>${c}</option>`)}</select>
        <select name="location" aria-label="Location"><option value="">All locations</option>${facets.locations.map((c) => html`<option ${c === f.location ? raw('selected') : ''}>${c}</option>`)}</select>
        <select name="status" aria-label="Status"><option value="">Any status</option>${Object.entries(STATUS_LABELS).map(([v, l]) => html`<option value="${v}" ${v === f.status ? raw('selected') : ''}>${l}</option>`)}</select>
        <button class="btn" type="submit">Show labels</button>
      </form>`}
    <div id="sheet"><p class="muted">Loading labels…</p></div>`.toString();

  el.querySelector('#print').addEventListener('click', () => window.print());
  el.querySelector('#lf')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(e.target));
    location.hash = `#/labels${qs(v)}`;
  });

  const { items } = await api(`/labels${qs(ids ? { ids } : f)}`);
  el.querySelector('#sheet').innerHTML = items.length ? html`
    <p class="muted no-print">${items.length} label${items.length === 1 ? '' : 's'}${items.length === 500 ? ' (limit reached; narrow the filter)' : ''}</p>
    <div class="label-sheet">${items.map((a) => html`<div class="qr-label">
      <div class="qr">${raw(a.qr)}</div>
      <div><div class="company">${state.settings.company_name} · IT</div><div class="tag">${a.tag}</div>
        <div class="name">${a.name}</div>${a.serial ? html`<div class="serial">S/N ${a.serial}</div>` : ''}</div>
    </div>`)}</div>`.toString() : '<div class="empty">No assets match.</div>';
}

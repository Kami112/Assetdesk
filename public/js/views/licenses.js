import { api } from '../api.js';
import { html, icon, money, num, fmtDate, dueChip, toast, confirmDialog, formDialog, field } from '../ui.js';
import { can, state } from '../app.js';
import { timeline, activeEmployees } from './assets.js';

const licenseFields = (l = {}) => html`
  ${field('Product name', 'name', { value: l.name, required: true, hint: 'e.g. Microsoft 365 Business Premium' })}
  <div class="form-grid" style="grid-template-columns:1fr 1fr">
    ${field('Vendor', 'vendor', { value: l.vendor })}
    ${field('Seats purchased', 'seats', { type: 'number', value: l.seats ?? 1, attrs: 'min="0" step="1"' })}
    ${field('Renewal / expiry date', 'expires_on', { type: 'date', value: l.expires_on })}
    ${field(`Annual cost (${state.settings.currency})`, 'annual_cost', { type: 'number', value: l.annual_cost, attrs: 'min="0" step="0.01"' })}
  </div>
  ${field('License key', 'license_key', { value: l.license_key, hint: 'Hidden from viewers' })}
  ${field('Notes', 'notes', { type: 'textarea', value: l.notes })}`;

const seatMeter = (l) => {
  const over = l.seats_used > l.seats;
  const pct = l.seats ? Math.min(100, (l.seats_used / l.seats) * 100) : (l.seats_used ? 100 : 0);
  return html`<div class="nowrap"><strong>${l.seats_used}</strong> / ${l.seats}${over ? html` <span class="chip bad">Over by ${l.seats_used - l.seats}</span>` : ''}</div>
    <div class="meter ${over ? 'over' : ''}" style="width:120px" role="img" aria-label="${l.seats_used} of ${l.seats} seats used"><div style="width:${pct.toFixed(0)}%"></div></div>`;
};

export async function licenseListView({ el, navigate }) {
  const { items } = await api('/licenses');
  const annual = items.reduce((s, l) => s + (l.annual_cost || 0), 0);
  const seats = items.reduce((s, l) => s + l.seats, 0);
  const used = items.reduce((s, l) => s + Math.min(l.seats, l.seats_used), 0);
  el.innerHTML = html`
    <div class="page-head">
      <div><h1>Software licenses</h1><p>${num(items.length)} products · ${money(annual)} per year · ${seats ? Math.round((used / seats) * 100) : 0}% of seats in use</p></div>
      ${can('editor') ? html`<div class="actions"><button class="btn primary" id="addLic">${icon('plus')}Add license</button></div>` : ''}
    </div>
    <div class="card"><div class="table-wrap">${items.length ? html`<table>
      <thead><tr><th>Product</th><th>Seats used</th><th>Renewal</th><th class="num hide-sm">Annual cost</th></tr></thead>
      <tbody>${items.map((l) => html`<tr>
        <td><a class="primary-link" href="#/licenses/${l.id}">${l.name}</a><span class="sub">${l.vendor || ''}</span></td>
        <td>${seatMeter(l)}</td><td class="nowrap">${dueChip(l.expires_on, { soon: 60 })}</td>
        <td class="num hide-sm nowrap">${money(l.annual_cost)}</td></tr>`)}</tbody></table>`
      : html`<div class="empty">No licenses yet.</div>`}</div></div>`.toString();
  el.querySelector('#addLic')?.addEventListener('click', async () => {
    const lic = await formDialog({ title: 'Add license', body: licenseFields(), submitLabel: 'Add', onSubmit: (v) => api('/licenses', { method: 'POST', body: v }) });
    if (lic) { toast(`${lic.name} added.`); navigate(`/licenses/${lic.id}`); }
  });
}

export async function licenseDetailView({ el, params, navigate }) {
  const l = await api(`/licenses/${params[0]}`);
  const free = l.seats - l.seats_used;
  el.innerHTML = html`
    <div class="breadcrumb"><a href="#/licenses">Licenses</a> / ${l.name}</div>
    <div class="page-head">
      <div><h1>${l.name}</h1><p>${l.vendor || 'No vendor'} · renews ${fmtDate(l.expires_on)}</p></div>
      <div class="actions">
        ${can('editor') ? html`<button class="btn primary" id="assign">${icon('plus')}Assign seat</button><button class="btn" id="edit">${icon('edit')}Edit</button>` : ''}
        ${can('admin') ? html`<button class="btn danger" id="delete">${icon('trash')}Delete</button>` : ''}
      </div>
    </div>
    ${free < 0 ? html`<div class="callout bad" style="margin-bottom:16px">${-free} more seat${free === -1 ? ' is' : 's are'} assigned than purchased. Buy more seats or release some to stay compliant.</div>` : ''}
    <div class="detail">
      <section class="card">
        <div class="card-head"><h2>Seat holders (${l.holders.length})</h2><span class="muted">${free >= 0 ? `${free} free` : ''}</span></div>
        <div class="card-body">${l.holders.length ? html`<ul class="list">${l.holders.map((h) => html`<li>
          <span class="grow"><a href="#/employees/${h.id}">${h.name}</a><span class="muted">${[h.department, `since ${fmtDate(h.assigned_at)}`].filter(Boolean).join(' · ')}</span></span>
          ${h.status === 'offboarded' ? html`<span class="chip warn">Offboarded</span>` : ''}
          ${can('editor') ? html`<button class="btn small" data-release="${h.id}" data-name="${h.name}">Release</button>` : ''}</li>`)}</ul>`
          : html`<p class="muted">No seats assigned yet.</p>`}</div>
      </section>
      <aside class="grid">
        <section class="card card-pad">
          <h2 style="margin-bottom:12px">Details</h2>
          <dl class="props" style="grid-template-columns:1fr 1fr">
            <div><dt>Seats</dt><dd>${seatMeter(l)}</dd></div>
            <div><dt>Renewal</dt><dd>${dueChip(l.expires_on, { soon: 60 })}</dd></div>
            <div><dt>Annual cost</dt><dd>${money(l.annual_cost)}</dd></div>
            <div><dt>Cost per seat</dt><dd>${l.annual_cost && l.seats ? money(l.annual_cost / l.seats) : '—'}</dd></div>
          </dl>
          <dl class="props" style="grid-template-columns:1fr;margin-top:14px">
            <div><dt>License key</dt><dd>${l.license_key ? html`<span class="mono" id="key" data-key="${l.license_key}">${can('editor') ? '••••••••••••' : l.license_key}</span>
              ${can('editor') ? html` <button class="btn small ghost" id="reveal">Show</button> <button class="btn small ghost" id="copy">Copy</button>` : ''}` : '—'}</dd></div>
          </dl>
          ${l.notes ? html`<p style="white-space:pre-wrap;margin:14px 0 0">${l.notes}</p>` : ''}
        </section>
        <section class="card card-pad"><h2 style="margin-bottom:14px">History</h2>${timeline(l.history.slice(0, 15))}</section>
      </aside>
    </div>`.toString();

  const reload = () => navigate(`/licenses/${l.id}`);
  el.querySelector('#reveal')?.addEventListener('click', (ev) => {
    const k = el.querySelector('#key');
    const shown = ev.target.textContent === 'Hide';
    k.textContent = shown ? '••••••••••••' : k.dataset.key;
    ev.target.textContent = shown ? 'Show' : 'Hide';
  });
  el.querySelector('#copy')?.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(el.querySelector('#key').dataset.key); toast('License key copied.'); } catch { toast('Copy failed. Use Show and copy it manually.', 'error'); }
  });
  el.querySelector('#assign')?.addEventListener('click', async () => {
    const holders = new Set(l.holders.map((h) => h.id));
    const emps = (await activeEmployees()).filter((e) => !holders.has(e.id));
    const ok = await formDialog({
      title: `Assign a ${l.name} seat`,
      description: free > 0 ? `${free} seat${free === 1 ? '' : 's'} available.` : 'All seats are in use, so this will over-allocate the license.',
      body: field('Employee', 'employee_id', { options: [['', 'Choose…'], ...emps.map((e) => [e.id, `${e.name}${e.department ? ` · ${e.department}` : ''}`])] }),
      submitLabel: free > 0 ? 'Assign' : 'Assign anyway',
      onSubmit: (v) => api(`/licenses/${l.id}/seats`, { method: 'POST', body: { ...v, allow_over: free <= 0 } }),
    });
    if (ok) { toast('Seat assigned.'); reload(); }
  });
  el.addEventListener('click', async (ev) => {
    const b = ev.target.closest('[data-release]');
    if (!b) return;
    if (!await confirmDialog({ title: `Release ${b.dataset.name}'s seat?`, confirmLabel: 'Release' })) return;
    try { await api(`/licenses/${l.id}/seats/${b.dataset.release}`, { method: 'DELETE' }); toast('Seat released.'); reload(); } catch (err) { toast(err.message, 'error'); }
  });
  el.querySelector('#edit')?.addEventListener('click', async () => {
    const saved = await formDialog({ title: `Edit ${l.name}`, body: licenseFields(l), onSubmit: (v) => api(`/licenses/${l.id}`, { method: 'PATCH', body: v }) });
    if (saved) { toast('Saved.'); reload(); }
  });
  el.querySelector('#delete')?.addEventListener('click', async () => {
    if (!await confirmDialog({ title: `Delete ${l.name}?`, body: 'All seat assignments are removed. The activity log keeps a record.', confirmLabel: 'Delete', danger: true })) return;
    await api(`/licenses/${l.id}`, { method: 'DELETE' });
    toast('License deleted.');
    navigate('/licenses');
  });
}

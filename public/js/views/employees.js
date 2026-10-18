import { api, qs } from '../api.js';
import { html, raw, icon, money, num, fmtDate, statusChip, toast, confirmDialog, formDialog, field } from '../ui.js';
import { can, setQuery } from '../app.js';
import { timeline, invalidateEmployees } from './assets.js';

const employeeFields = (e = {}) => html`
  ${field('Full name', 'name', { value: e.name, required: true })}
  ${field('Email', 'email', { type: 'email', value: e.email })}
  <div class="form-grid" style="grid-template-columns:1fr 1fr">
    ${field('Department', 'department', { value: e.department })}
    ${field('Job title', 'title', { value: e.title })}
  </div>
  ${field('Location', 'location', { value: e.location })}`;

export async function employeeListView({ el, query, navigate }) {
  const f = { q: query.get('q') || '', status: query.get('status') || 'active' };
  el.innerHTML = html`
    <div class="page-head">
      <div><h1>Employees</h1><p id="empCount">&nbsp;</p></div>
      ${can('editor') ? html`<div class="actions"><button class="btn primary" id="addEmp">${icon('plus')}Add employee</button></div>` : ''}
    </div>
    <div class="filters">
      <input type="search" id="eq" placeholder="Search name, email, department…" value="${f.q}" aria-label="Search employees">
      <select id="es" aria-label="Status">
        <option value="active" ${f.status === 'active' ? raw('selected') : ''}>Active</option>
        <option value="offboarded" ${f.status === 'offboarded' ? raw('selected') : ''}>Offboarded</option>
        <option value="all" ${f.status === 'all' ? raw('selected') : ''}>Everyone</option>
      </select>
    </div>
    <div class="card"><div class="table-wrap" id="empTable"></div></div>`.toString();

  async function load() {
    const { items } = await api(`/employees${qs({ q: f.q, status: f.status === 'all' ? '' : f.status })}`);
    el.querySelector('#empCount').textContent = `${num(items.length)} ${f.status === 'all' ? '' : f.status} employee${items.length === 1 ? '' : 's'}`;
    el.querySelector('#empTable').innerHTML = items.length ? html`<table>
      <thead><tr><th>Name</th><th class="hide-sm">Department</th><th class="hide-sm">Location</th><th class="num">Assets</th><th class="num">Licenses</th><th>Status</th></tr></thead>
      <tbody>${items.map((e) => html`<tr>
        <td><a class="primary-link" href="#/employees/${e.id}">${e.name}</a><span class="sub">${[e.title, e.email].filter(Boolean).join(' · ')}</span></td>
        <td class="hide-sm">${e.department || '—'}</td><td class="hide-sm">${e.location || '—'}</td>
        <td class="num">${e.asset_count}</td><td class="num">${e.license_count}</td>
        <td><span class="chip ${e.status}">${e.status === 'active' ? 'Active' : 'Offboarded'}</span></td></tr>`)}</tbody></table>`.toString()
      : html`<div class="empty">No employees found.</div>`.toString();
  }

  let timer;
  el.querySelector('#eq').addEventListener('input', (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => { f.q = e.target.value.trim(); setQuery(f); load(); }, 250);
  });
  el.querySelector('#es').addEventListener('change', (e) => { f.status = e.target.value; setQuery(f); load(); });
  el.querySelector('#addEmp')?.addEventListener('click', async () => {
    const emp = await formDialog({ title: 'Add employee', body: employeeFields(), submitLabel: 'Add', onSubmit: (v) => api('/employees', { method: 'POST', body: v }) });
    if (emp) { invalidateEmployees(); toast(`${emp.name} added.`); navigate(`/employees/${emp.id}`); }
  });
  await load();
}

export async function employeeDetailView({ el, params, navigate }) {
  const e = await api(`/employees/${params[0]}`);
  const totalValue = e.assets.reduce((s, a) => s + (a.book_value || 0), 0);
  el.innerHTML = html`
    <div class="breadcrumb"><a href="#/employees">Employees</a> / ${e.name}</div>
    <div class="page-head">
      <div><h1>${e.name}</h1><p>${[e.title, e.department, e.location].filter(Boolean).join(' · ') || 'No details yet'}
        · <span class="chip ${e.status}">${e.status === 'active' ? 'Active' : 'Offboarded'}</span></p></div>
      <div class="actions">
        ${can('editor') && e.status === 'active' ? html`<button class="btn" id="offboard">Offboard…</button>` : ''}
        ${can('editor') && e.status === 'offboarded' ? html`<button class="btn" id="reactivate">Reactivate</button>` : ''}
        ${can('editor') ? html`<button class="btn" id="edit">${icon('edit')}Edit</button>` : ''}
        ${can('admin') && !e.assets.length ? html`<button class="btn danger" id="delete">${icon('trash')}Delete</button>` : ''}
      </div>
    </div>
    <div class="detail">
      <div class="grid">
        <section class="card">
          <div class="card-head"><h2>Assets (${e.assets.length})</h2>${e.assets.length ? html`<span class="muted">Book value ${money(totalValue)}</span>` : ''}</div>
          <div class="card-body">${e.assets.length ? html`<div class="table-wrap"><table>
            <thead><tr><th>Asset</th><th class="hide-sm">Category</th><th>Status</th><th class="hide-sm">Last updated</th></tr></thead>
            <tbody>${e.assets.map((a) => html`<tr><td><a class="primary-link" href="#/assets/${a.id}"><span class="mono">${a.tag}</span> · ${a.name}</a>
              <span class="sub">${a.serial ? `S/N ${a.serial}` : ''}</span></td><td class="hide-sm">${a.category}</td><td>${statusChip(a.status)}</td>
              <td class="hide-sm">${fmtDate(a.updated_at)}</td></tr>`)}</tbody></table></div>`
            : html`<p class="muted">No assets assigned.</p>`}</div>
        </section>
        <section class="card card-pad"><h2 style="margin-bottom:14px">History</h2>${timeline(e.history)}</section>
      </div>
      <aside class="grid">
        <section class="card card-pad">
          <h2 style="margin-bottom:12px">Contact</h2>
          <dl class="props" style="grid-template-columns:1fr">
            <div><dt>Email</dt><dd>${e.email ? html`<a href="mailto:${e.email}">${e.email}</a>` : '—'}</dd></div>
            <div><dt>Department</dt><dd>${e.department || '—'}</dd></div>
            <div><dt>Location</dt><dd>${e.location || '—'}</dd></div>
          </dl>
        </section>
        <section class="card card-pad">
          <h2 style="margin-bottom:6px">Software licenses (${e.licenses.length})</h2>
          ${e.licenses.length ? html`<ul class="list">${e.licenses.map((l) => html`<li><span class="grow"><a href="#/licenses/${l.id}">${l.name}</a>
            <span class="muted">${l.vendor || ''}</span></span></li>`)}</ul>` : html`<p class="muted">No license seats.</p>`}
        </section>
      </aside>
    </div>`.toString();

  el.querySelector('#edit')?.addEventListener('click', async () => {
    const saved = await formDialog({ title: `Edit ${e.name}`, body: employeeFields(e), onSubmit: (v) => api(`/employees/${e.id}`, { method: 'PATCH', body: v }) });
    if (saved) { invalidateEmployees(); toast('Saved.'); navigate(`/employees/${e.id}`); }
  });
  el.querySelector('#reactivate')?.addEventListener('click', async () => {
    await api(`/employees/${e.id}`, { method: 'PATCH', body: { status: 'active' } });
    invalidateEmployees();
    toast(`${e.name} is active again.`);
    navigate(`/employees/${e.id}`);
  });
  el.querySelector('#delete')?.addEventListener('click', async () => {
    if (!await confirmDialog({ title: `Delete ${e.name}?`, body: 'Their license seats are released. The activity log keeps a record.', confirmLabel: 'Delete', danger: true })) return;
    try {
      await api(`/employees/${e.id}`, { method: 'DELETE' });
      invalidateEmployees();
      toast(`${e.name} deleted.`);
      navigate('/employees');
    } catch (err) { toast(err.message, 'error'); }
  });
  el.querySelector('#offboard')?.addEventListener('click', async () => {
    const r = await formDialog({
      title: `Offboard ${e.name}`,
      description: 'Everything below happens in one step and is recorded in the activity log.',
      body: html`
        <div><strong>${e.assets.length} asset${e.assets.length === 1 ? '' : 's'} will be returned to stock.</strong>
          ${e.assets.length ? html`<span class="muted"> Tick any that were not returned to mark them lost.</span>` : ''}</div>
        ${e.assets.length ? html`<div class="list" style="max-height:220px;overflow:auto">${e.assets.map((a) => html`
          <label class="checkbox" style="padding:6px 0"><input type="checkbox" name="lost_${a.id}"> Not returned: <span class="mono">${a.tag}</span> ${a.name}</label>`)}</div>` : ''}
        <div><strong>${e.licenses.length} license seat${e.licenses.length === 1 ? '' : 's'} will be released</strong>${e.licenses.length ? html`<span class="muted">: ${e.licenses.map((l) => l.name).join(', ')}</span>` : ''}.</div>`,
      submitLabel: 'Offboard',
      danger: true,
      onSubmit: (v) => api(`/employees/${e.id}/offboard`, {
        method: 'POST',
        body: { lost_asset_ids: Object.entries(v).filter(([k, on]) => k.startsWith('lost_') && on).map(([k]) => Number(k.slice(5))) },
      }),
    });
    if (r) {
      invalidateEmployees();
      toast(`${e.name} offboarded: ${r.assets} asset(s) processed, ${r.seats} seat(s) released.`);
      navigate(`/employees/${e.id}`);
    }
  });
}

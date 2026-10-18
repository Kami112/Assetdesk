import { api, qs } from '../api.js';
import {
  html, raw, icon, money, num, fmtDate, fmtDateTime, dueChip, statusChip, STATUS_LABELS, toast,
  confirmDialog, formDialog, field, download, formValues, clearErrors, showErrors,
} from '../ui.js';
import { can, setQuery, state } from '../app.js';

export const CATEGORIES = ['Laptop', 'Desktop', 'Monitor', 'Server', 'Network', 'Phone', 'Tablet', 'Printer', 'Peripheral', 'Other'];
const FLAGS = {
  warranty_soon: 'Warranty ending within 90 days',
  warranty_expired: 'Out of warranty',
  refresh_due: 'Due for refresh',
  unassigned_in_use: '"In use" but not assigned',
};
const FILTER_KEYS = ['q', 'category', 'status', 'location', 'department', 'flag', 'sort', 'dir', 'page'];

let employeeCache = null;
export async function activeEmployees(force = false) {
  if (!employeeCache || force) employeeCache = (await api('/employees?status=active')).items;
  return employeeCache;
}
export const invalidateEmployees = () => { employeeCache = null; };

/* ======================= List ======================= */
export async function assetListView({ el, query }) {
  const f = Object.fromEntries(FILTER_KEYS.map((k) => [k, query.get(k) || '']));
  const selected = new Set();
  let facets = { locations: [], departments: [] };
  let lastItems = [];

  el.innerHTML = html`
    <div class="page-head">
      <div><h1>Assets</h1><p id="assetCount">&nbsp;</p></div>
      <div class="actions">
        <button class="btn" data-export="xlsx">${icon('download')}Excel</button>
        <button class="btn" data-export="csv">CSV</button>
        ${can('editor') ? html`<a class="btn primary" href="#/assets/new">${icon('plus')}New asset</a>` : ''}
      </div>
    </div>
    <div class="filters" role="search">
      <label class="sr-only" for="fq">Search</label>
      <input type="search" id="fq" placeholder="Search tag, serial, model, person, location…" value="${f.q}">
      <select id="fcategory" aria-label="Category"><option value="">All categories</option>${CATEGORIES.map((c) => html`<option ${c === f.category ? raw('selected') : ''}>${c}</option>`)}</select>
      <select id="fstatus" aria-label="Status"><option value="">All statuses</option><option value="active" ${f.status === 'active' ? raw('selected') : ''}>Active (not retired/lost)</option>
        ${Object.entries(STATUS_LABELS).map(([v, l]) => html`<option value="${v}" ${v === f.status ? raw('selected') : ''}>${l}</option>`)}</select>
      <select id="flocation" aria-label="Location"><option value="">All locations</option></select>
      <select id="fdepartment" aria-label="Department"><option value="">All departments</option></select>
      <span id="flagChip"></span>
    </div>
    <div class="card">
      <div id="bulk"></div>
      <div class="table-wrap" id="tableWrap"><div class="skeleton" style="padding:20px">Loading…</div></div>
      <div id="pager"></div>
    </div>`.toString();

  const $ = (s) => el.querySelector(s);

  function syncUrl() { setQuery(f); }

  async function load() {
    const data = await api(`/assets${qs({ ...f, pageSize: 50 })}`);
    lastItems = data.items;
    facets = data.facets;
    fillFacet($('#flocation'), facets.locations, f.location);
    fillFacet($('#fdepartment'), facets.departments, f.department);
    $('#assetCount').textContent = `${num(data.total)} asset${data.total === 1 ? '' : 's'}${hasFilters() ? ' match these filters' : ''}`;
    $('#flagChip').innerHTML = f.flag ? html`<button class="chip warn" id="clearFlag" title="Remove filter">${FLAGS[f.flag] || f.flag} ✕</button>`.toString() : '';
    $('#clearFlag')?.addEventListener('click', () => { f.flag = ''; f.page = ''; syncUrl(); load(); });
    renderTable(data);
    renderPager(data);
    renderBulk();
  }

  const hasFilters = () => ['q', 'category', 'status', 'location', 'department', 'flag'].some((k) => f[k]);

  function fillFacet(select, values, current) {
    const first = select.options[0].outerHTML;
    select.innerHTML = first + values.map((v) => html`<option ${v === current ? raw('selected') : ''}>${v}</option>`.toString()).join('');
  }

  function sortHeader(key, label, cls = '') {
    const active = f.sort === key || (!f.sort && key === 'tag');
    const dir = active && f.dir === 'desc' ? 'desc' : 'asc';
    return html`<th class="${cls}" aria-sort="${active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}">
      <button class="sort" data-sort="${key}">${label}${active ? icon(dir === 'asc' ? 'arrowUp' : 'arrowDown') : ''}</button></th>`;
  }

  function renderTable(data) {
    if (!data.items.length) {
      $('#tableWrap').innerHTML = html`<div class="empty">${hasFilters() ? 'No assets match these filters.' : 'No assets yet.'}
        ${can('editor') && !hasFilters() ? html`<p><a class="btn primary" href="#/assets/new">Add your first asset</a> <a class="btn" href="#/import">Import a spreadsheet</a></p>` : ''}</div>`.toString();
      return;
    }
    const allSelected = data.items.every((a) => selected.has(a.id));
    $('#tableWrap').innerHTML = html`<table>
      <thead><tr>
        <th class="check"><input type="checkbox" class="checkbox" id="selAll" aria-label="Select all on this page" ${allSelected ? raw('checked') : ''}></th>
        ${sortHeader('tag', 'Asset')}${sortHeader('category', 'Category', 'hide-sm')}${sortHeader('status', 'Status')}
        ${sortHeader('employee', 'Assigned to')}${sortHeader('location', 'Location', 'hide-sm')}
        ${sortHeader('warranty_end', 'Warranty', 'hide-sm')}${sortHeader('purchase_cost', 'Cost', 'hide-sm num')}
      </tr></thead>
      <tbody>${data.items.map((a) => html`<tr>
        <td class="check"><input type="checkbox" data-sel="${a.id}" aria-label="Select ${a.tag}" ${selected.has(a.id) ? raw('checked') : ''}></td>
        <td><a class="primary-link" href="#/assets/${a.id}"><span class="mono">${a.tag}</span> · ${a.name}</a>
          <span class="sub">${[a.serial && `S/N ${a.serial}`, a.model].filter(Boolean).join(' · ')}</span></td>
        <td class="hide-sm">${a.category}</td>
        <td>${statusChip(a.status)}</td>
        <td>${a.employee_id ? html`<a href="#/employees/${a.employee_id}">${a.employee_name}</a>` : html`<span class="muted">—</span>`}</td>
        <td class="hide-sm">${a.location || html`<span class="muted">—</span>`}</td>
        <td class="hide-sm nowrap">${['retired', 'lost'].includes(a.status) ? html`<span class="muted">${fmtDate(a.warranty_end)}</span>` : dueChip(a.warranty_end)}</td>
        <td class="hide-sm num nowrap">${money(a.purchase_cost)}</td>
      </tr>`)}</tbody></table>`.toString();
  }

  function renderPager(data) {
    const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
    const from = data.total ? (data.page - 1) * data.pageSize + 1 : 0;
    const to = Math.min(data.total, data.page * data.pageSize);
    $('#pager').innerHTML = pages > 1 || data.total > 10 ? html`<div class="pager"><span>${from}–${to} of ${num(data.total)}</span>
      <span class="actions"><button class="btn small" data-page="${data.page - 1}" ${data.page <= 1 ? raw('disabled') : ''}>Previous</button>
      <span>Page ${data.page} of ${pages}</span>
      <button class="btn small" data-page="${data.page + 1}" ${data.page >= pages ? raw('disabled') : ''}>Next</button></span></div>`.toString() : '';
  }

  function renderBulk() {
    if (!selected.size) { $('#bulk').innerHTML = ''; return; }
    $('#bulk').innerHTML = html`<div class="bulkbar">
      <span>${selected.size} selected</span>
      ${can('editor') ? html`<select id="bulkStatus" aria-label="Change status"><option value="">Change status…</option>
        ${Object.entries(STATUS_LABELS).map(([v, l]) => html`<option value="${v}">${l}</option>`)}</select>
        <button class="btn small" id="bulkMove">Move…</button>` : ''}
      <button class="btn small" id="bulkLabels">${icon('qr')}Print labels</button>
      <button class="btn small" id="bulkExport">${icon('download')}Export</button>
      ${can('admin') ? html`<button class="btn small danger" id="bulkDelete">${icon('trash')}Delete</button>` : ''}
      <button class="btn small ghost" id="bulkClear">Clear</button></div>`.toString();
  }

  async function bulk(action, value) {
    const r = await api('/assets/bulk', { method: 'POST', body: { ids: [...selected], action, value } });
    toast(`${r.count} asset${r.count === 1 ? '' : 's'} updated.`);
    selected.clear();
    await load();
  }

  el.addEventListener('click', async (e) => {
    const t = e.target.closest('button, input');
    if (!t) return;
    try {
      if (t.dataset.sort) {
        const key = t.dataset.sort;
        f.dir = (f.sort || 'tag') === key && f.dir !== 'desc' ? 'desc' : 'asc';
        f.sort = key; f.page = '';
        syncUrl(); await load();
      } else if (t.dataset.page) {
        f.page = t.dataset.page; syncUrl(); await load(); el.scrollIntoView();
      } else if (t.dataset.export) {
        await download(`/api/export/assets.${t.dataset.export}${qs({ ...f, page: '' })}`, `assets.${t.dataset.export}`);
      } else if (t.id === 'selAll') {
        lastItems.forEach((a) => (t.checked ? selected.add(a.id) : selected.delete(a.id)));
        el.querySelectorAll('[data-sel]').forEach((c) => { c.checked = t.checked; });
        renderBulk();
      } else if (t.dataset.sel) {
        const id = Number(t.dataset.sel);
        if (t.checked) selected.add(id); else selected.delete(id);
        renderBulk();
      } else if (t.id === 'bulkClear') {
        selected.clear(); el.querySelectorAll('[data-sel], #selAll').forEach((c) => { c.checked = false; }); renderBulk();
      } else if (t.id === 'bulkLabels') {
        location.hash = `#/labels?ids=${[...selected].join(',')}`;
      } else if (t.id === 'bulkExport') {
        await download(`/api/export/assets.xlsx?ids=${[...selected].join(',')}`, 'assets.xlsx');
      } else if (t.id === 'bulkMove') {
        const loc = await formDialog({
          title: `Move ${selected.size} asset${selected.size === 1 ? '' : 's'}`,
          body: html`${field('New location', 'value', { required: true, attrs: 'list="locList"' })}
            <datalist id="locList">${facets.locations.map((l) => html`<option value="${l}">`)}</datalist>`,
          submitLabel: 'Move',
          onSubmit: async (v) => { await bulk('location', v.value); return true; },
        });
        if (loc) renderBulk();
      } else if (t.id === 'bulkDelete') {
        if (await confirmDialog({ title: `Delete ${selected.size} asset${selected.size === 1 ? '' : 's'}?`, body: 'This cannot be undone. The activity log keeps a record of the deletion.', confirmLabel: 'Delete', danger: true })) {
          await bulk('delete');
        }
      }
    } catch (err) { toast(err.message, 'error'); }
  });

  el.addEventListener('change', async (e) => {
    const t = e.target;
    try {
      if (t.id === 'bulkStatus' && t.value) await bulk('status', t.value);
      const key = { fcategory: 'category', fstatus: 'status', flocation: 'location', fdepartment: 'department' }[t.id];
      if (key) { f[key] = t.value; f.page = ''; syncUrl(); await load(); }
    } catch (err) { toast(err.message, 'error'); }
  });

  let timer;
  $('#fq').addEventListener('input', (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => { f.q = e.target.value.trim(); f.page = ''; syncUrl(); load().catch((err) => toast(err.message, 'error')); }, 250);
  });

  await load();
}

/* ======================= Detail ======================= */
const FIELD_LABELS = {
  tag: 'Asset tag', name: 'Name', category: 'Category', manufacturer: 'Manufacturer', model: 'Model', serial: 'Serial number',
  status: 'Status', employee_id: 'Assigned to', employee: 'Assigned to', department: 'Department', location: 'Location',
  purchase_date: 'Purchase date', purchase_cost: 'Purchase cost', supplier: 'Supplier', warranty_end: 'Warranty end',
  notes: 'Notes', seats: 'Seats', expires_on: 'Expires', annual_cost: 'Annual cost', vendor: 'Vendor', license_key: 'License key',
  email: 'Email', title: 'Job title', role: 'Role', active: 'Active', company_name: 'Company name', currency: 'Currency', tag_prefix: 'Tag prefix',
};
const showVal = (k, v) => {
  if (v == null || v === '') return '—';
  if (k === 'status') return STATUS_LABELS[v] || v;
  if (k === 'employee_id') return `#${v}`;
  return String(v);
};

export function timeline(history) {
  if (!history.length) return html`<p class="muted">No history yet.</p>`;
  return html`<ul class="timeline">${history.map((h) => html`<li>
    <div>${h.summary}</div>
    ${h.changes && h.action === 'update' ? html`<div class="changes">${Object.entries(h.changes).map(([k, [a, b]]) =>
      html`<div>${FIELD_LABELS[k] || k}: <del>${showVal(k, a)}</del> → ${showVal(k, b)}</div>`)}</div>` : ''}
    <div class="when">${h.user_name} · ${fmtDateTime(h.at)}</div></li>`)}</ul>`;
}

export async function assetDetailView({ el, params, navigate }) {
  const a = await api(`/assets/${params[0]}`);
  const assignable = !['retired', 'lost'].includes(a.status);
  const age = a.purchase_date ? (Date.now() - new Date(a.purchase_date)) / (365.25 * 86400000) : null;
  const eolDays = a.end_of_life ? Math.round((new Date(a.end_of_life) - Date.now()) / 86400000) : null;

  el.innerHTML = html`
    <div class="breadcrumb"><a href="#/assets">Assets</a> / ${a.tag}</div>
    <div class="page-head">
      <div><h1>${a.name}</h1><p><span class="mono">${a.tag}</span> · ${a.category} · ${statusChip(a.status)}</p></div>
      <div class="actions">
        ${can('editor') && assignable ? (a.employee_id
          ? html`<button class="btn primary" id="checkin">Check in</button>`
          : html`<button class="btn primary" id="checkout">Check out</button>`) : ''}
        <a class="btn" href="#/labels?ids=${a.id}">${icon('qr')}Label</a>
        ${can('editor') ? html`<a class="btn" href="#/assets/${a.id}/edit">${icon('edit')}Edit</a>` : ''}
        ${can('admin') ? html`<button class="btn danger" id="delete">${icon('trash')}Delete</button>` : ''}
      </div>
    </div>
    <div class="detail">
      <div class="grid">
        <section class="card card-pad">
          <h2 style="margin-bottom:14px">Details</h2>
          <dl class="props">
            <div><dt>Assigned to</dt><dd>${a.employee_id ? html`<a href="#/employees/${a.employee_id}">${a.employee_name}</a>` : '—'}</dd></div>
            <div><dt>Department</dt><dd>${a.department || '—'}</dd></div>
            <div><dt>Location</dt><dd>${a.location || '—'}</dd></div>
            <div><dt>Manufacturer</dt><dd>${a.manufacturer || '—'}</dd></div>
            <div><dt>Model</dt><dd>${a.model || '—'}</dd></div>
            <div><dt>Serial number</dt><dd class="mono">${a.serial || '—'}</dd></div>
            <div><dt>Supplier</dt><dd>${a.supplier || '—'}</dd></div>
            <div><dt>Purchase date</dt><dd>${fmtDate(a.purchase_date)}${age != null ? html` <span class="muted">(${age < 1 ? `${Math.max(0, Math.round(age * 12))} mo` : `${age.toFixed(1)} yr`} old)</span>` : ''}</dd></div>
            <div><dt>Warranty end</dt><dd>${dueChip(a.warranty_end)}</dd></div>
          </dl>
          ${a.notes ? html`<h2 style="margin:18px 0 6px">Notes</h2><p style="margin:0;white-space:pre-wrap">${a.notes}</p>` : ''}
        </section>
        <section class="card card-pad"><h2 style="margin-bottom:14px">History</h2>${timeline(a.history)}</section>
      </div>
      <aside class="grid">
        <section class="card card-pad">
          <h2 style="margin-bottom:12px">Value</h2>
          <dl class="props" style="grid-template-columns:1fr 1fr">
            <div><dt>Purchase cost</dt><dd>${money(a.purchase_cost)}</dd></div>
            <div><dt>Book value today</dt><dd>${money(a.book_value)}</dd></div>
          </dl>
          ${a.purchase_cost && a.book_value != null ? html`<div class="meter" title="Remaining value"><div style="width:${Math.round((a.book_value / a.purchase_cost) * 100)}%"></div></div>
            <p class="muted" style="margin:6px 0 0;font-size:12.5px">${Math.round((a.book_value / a.purchase_cost) * 100)}% of value remaining, depreciated straight-line to zero.</p>` : ''}
        </section>
        <section class="card card-pad">
          <h2 style="margin-bottom:8px">Lifecycle</h2>
          ${eolDays == null ? html`<p class="muted">Add a purchase date to plan its replacement.</p>`
            : eolDays <= 0 ? html`<div class="callout warn">Reached its expected end of life on ${fmtDate(a.end_of_life)}. Plan a replacement.</div>`
              : html`<p style="margin:0">Expected end of life: <strong>${fmtDate(a.end_of_life)}</strong> <span class="muted">(${eolDays > 365 ? `${(eolDays / 365).toFixed(1)} years` : `${eolDays} days`} left)</span></p>`}
        </section>
      </aside>
    </div>`.toString();

  el.querySelector('#checkout')?.addEventListener('click', async () => {
    const emps = await activeEmployees();
    const done = await formDialog({
      title: `Check out ${a.tag}`,
      description: 'Assign this asset to an employee. Their department and location are copied onto the asset.',
      body: html`${field('Employee', 'employee_id', { options: [['', 'Choose…'], ...emps.map((e) => [e.id, `${e.name}${e.department ? ` · ${e.department}` : ''}`])] })}
        ${field('Note (optional)', 'note', { hint: 'e.g. ticket number or accessories handed over' })}`,
      submitLabel: 'Check out',
      onSubmit: (v) => api(`/assets/${a.id}/checkout`, { method: 'POST', body: v }),
    });
    if (done) { toast(`${a.tag} checked out to ${done.employee_name}.`); navigate(`/assets/${a.id}`); }
  });
  el.querySelector('#checkin')?.addEventListener('click', async () => {
    const done = await formDialog({
      title: `Check in ${a.tag}`,
      description: `Return this asset from ${a.employee_name}.`,
      body: html`${field('New status', 'status', { options: [['in_stock', 'In stock (ready to reuse)'], ['in_repair', 'In repair'], ['retired', 'Retired'], ['lost', 'Lost']] })}
        ${field('Note (optional)', 'note', { hint: 'e.g. condition on return' })}`,
      submitLabel: 'Check in',
      onSubmit: (v) => api(`/assets/${a.id}/checkin`, { method: 'POST', body: v }),
    });
    if (done) { toast(`${a.tag} checked in.`); navigate(`/assets/${a.id}`); }
  });
  el.querySelector('#delete')?.addEventListener('click', async () => {
    if (!await confirmDialog({ title: `Delete ${a.tag}?`, body: 'This permanently removes the asset. The activity log keeps a record.', confirmLabel: 'Delete', danger: true })) return;
    try {
      await api(`/assets/${a.id}`, { method: 'DELETE' });
      toast(`${a.tag} deleted.`);
      navigate('/assets');
    } catch (err) { toast(err.message, 'error'); }
  });
}

/* ======================= Form ======================= */
export async function assetFormView({ el, params, navigate }) {
  const editing = !!params[0];
  const [a, emps, facets] = await Promise.all([
    editing ? api(`/assets/${params[0]}`) : api('/assets/next-tag').then(({ tag }) => ({ tag, status: 'in_stock', category: '' })),
    activeEmployees(),
    api('/assets?pageSize=1').then((d) => d.facets),
  ]);
  if (!can('editor')) { el.innerHTML = html`<div class="callout">You have read-only access.</div>`.toString(); return; }
  const empOptions = [['', '— Not assigned —'], ...emps.map((e) => [e.id, `${e.name}${e.department ? ` · ${e.department}` : ''}`])];
  if (a.employee_id && !emps.some((e) => e.id === a.employee_id)) empOptions.push([a.employee_id, `${a.employee_name} (offboarded)`]);

  el.innerHTML = html`
    <div class="breadcrumb"><a href="#/assets">Assets</a> / ${editing ? html`<a href="#/assets/${a.id}">${a.tag}</a> / Edit` : 'New'}</div>
    <div class="page-head"><div><h1>${editing ? `Edit ${a.tag}` : 'New asset'}</h1><p>Fields marked * are required.</p></div></div>
    <form class="card card-pad" id="assetForm" novalidate>
      <div class="form-grid">
        ${field('Name', 'name', { value: a.name, required: true, hint: 'e.g. Dell Latitude 7440' })}
        ${field('Category', 'category', { value: a.category, options: [['', 'Choose…'], ...CATEGORIES.map((c) => [c, c])] })}
        ${field('Asset tag', 'tag', { value: a.tag, hint: editing ? '' : 'Suggested automatically; change it to match an existing sticker' })}
        ${field('Status', 'status', { value: a.status, options: Object.entries(STATUS_LABELS) })}
        ${field('Assigned to', 'employee_id', { value: a.employee_id ?? '', options: empOptions })}
        ${field('Location', 'location', { value: a.location, attrs: 'list="locs"' })}
        ${field('Department', 'department', { value: a.department, attrs: 'list="depts"' })}
        ${field('Manufacturer', 'manufacturer', { value: a.manufacturer })}
        ${field('Model', 'model', { value: a.model })}
        ${field('Serial number', 'serial', { value: a.serial })}
        ${field('Supplier', 'supplier', { value: a.supplier })}
        ${field('Purchase date', 'purchase_date', { type: 'date', value: a.purchase_date })}
        ${field(`Purchase cost (${state.settings.currency})`, 'purchase_cost', { type: 'number', value: a.purchase_cost, attrs: 'min="0" step="0.01" inputmode="decimal"' })}
        ${field('Warranty end', 'warranty_end', { type: 'date', value: a.warranty_end })}
        ${field('Notes', 'notes', { type: 'textarea', value: a.notes, span: true })}
      </div>
      <datalist id="locs">${facets.locations.map((l) => html`<option value="${l}">`)}</datalist>
      <datalist id="depts">${facets.departments.map((l) => html`<option value="${l}">`)}</datalist>
      <div class="field-error" data-error-for="_form" style="margin-top:12px"></div>
      <div class="actions" style="margin-top:18px">
        <button class="btn primary" type="submit">${editing ? 'Save changes' : 'Create asset'}</button>
        <a class="btn" href="${editing ? `#/assets/${a.id}` : '#/assets'}">Cancel</a>
        ${editing ? '' : html`<label class="checkbox" style="margin-left:8px"><input type="checkbox" id="another"> Add another after saving</label>`}
      </div>
    </form>`.toString();

  const form = el.querySelector('#assetForm');
  // Picking an employee implies "In use"; clearing them implies "In stock".
  form.employee_id.addEventListener('change', () => {
    if (form.employee_id.value && ['in_stock', 'retired', 'lost'].includes(form.status.value)) form.status.value = 'in_use';
    if (!form.employee_id.value && form.status.value === 'in_use') form.status.value = 'in_stock';
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearErrors(form);
    const btn = form.querySelector('[type=submit]');
    btn.disabled = true;
    try {
      const saved = await api(editing ? `/assets/${a.id}` : '/assets', { method: editing ? 'PATCH' : 'POST', body: formValues(form) });
      toast(editing ? 'Changes saved.' : `${saved.tag} created.`);
      if (!editing && el.querySelector('#another')?.checked) navigate('/assets/new');
      else navigate(`/assets/${saved.id}`);
    } catch (err) {
      showErrors(form, err);
    } finally {
      btn.disabled = false;
    }
  });
}

import { api } from '../api.js';
import { html, icon, num, toast, download } from '../ui.js';
import { can } from '../app.js';
import { invalidateEmployees } from './assets.js';

const FIELD_NAMES = {
  tag: 'Asset tag', name: 'Name', category: 'Category', manufacturer: 'Manufacturer', model: 'Model', serial: 'Serial number',
  status: 'Status', assignee: 'Assigned to', assignee_email: 'Assignee email', department: 'Department', location: 'Location',
  purchase_date: 'Purchase date', purchase_cost: 'Purchase cost', supplier: 'Supplier', warranty_end: 'Warranty end', notes: 'Notes',
};

export async function importView({ el, navigate }) {
  el.innerHTML = html`
    <div class="page-head"><div><h1>Import &amp; export</h1><p>Bring in an existing spreadsheet, or take your data to Excel.</p></div></div>
    <div class="grid cols-3">
      <section class="card card-pad span-2" id="importCard">
        <h2 style="margin-bottom:6px">Import from Excel or CSV</h2>
        ${can('editor') ? html`
          <p class="muted" style="margin:0 0 14px">Your own column names usually work: AssetDesk recognises headers like "Serial No", "Owner" or "Site".
            Nothing is saved until you review the preview. Rows whose tag or serial number already exists update that asset.</p>
          <label class="dropzone" id="drop" tabindex="0">
            <input type="file" id="file" accept=".xlsx,.csv" hidden>
            <strong>Drop a file here or click to choose</strong>
            <span class="muted">.xlsx or .csv, up to 5,000 rows</span>
          </label>
          <div class="actions" style="margin-top:12px">
            <label class="checkbox"><input type="checkbox" id="createEmps" checked> Create employees that don't exist yet</label>
            <button class="btn small ghost" id="template">${icon('download')}Download template</button>
          </div>
          <div id="preview"></div>`
          : html`<div class="callout">You have read-only access. Ask an admin for editor rights to import data.</div>`}
      </section>
      <section class="card card-pad">
        <h2 style="margin-bottom:6px">Export</h2>
        <p class="muted" style="margin:0 0 14px">All assets with assignees, costs and current book value. Exported files can be edited and imported back.</p>
        <div class="grid">
          <button class="btn" data-export="xlsx">${icon('download')}All assets (Excel)</button>
          <button class="btn" data-export="csv">${icon('download')}All assets (CSV)</button>
        </div>
        <p class="muted" style="font-size:12.5px;margin:14px 0 0">Need a filtered export? Filter the <a href="#/assets">assets list</a> first, then export from there.</p>
      </section>
    </div>`.toString();

  el.querySelectorAll('[data-export]').forEach((b) => b.addEventListener('click', () =>
    download(`/api/export/assets.${b.dataset.export}`, `assets.${b.dataset.export}`).catch((err) => toast(err.message, 'error'))));
  if (!can('editor')) return;

  el.querySelector('#template').addEventListener('click', () =>
    download('/api/export/template.xlsx', 'assetdesk-import-template.xlsx').catch((err) => toast(err.message, 'error')));

  const drop = el.querySelector('#drop');
  const input = el.querySelector('#file');
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
  ['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('drag'); }));
  drop.addEventListener('drop', (e) => { if (e.dataTransfer.files[0]) upload(e.dataTransfer.files[0]); });
  input.addEventListener('change', () => { if (input.files[0]) upload(input.files[0]); input.value = ''; });

  const previewEl = el.querySelector('#preview');

  async function upload(file) {
    previewEl.innerHTML = '<p class="muted" style="margin-top:16px">Reading and checking every row…</p>';
    const form = new FormData();
    form.append('file', file);
    form.append('createEmployees', String(el.querySelector('#createEmps').checked));
    try {
      renderPreview(await api('/import/preview', { method: 'POST', form }));
    } catch (err) {
      previewEl.innerHTML = html`<div class="callout bad" style="margin-top:16px">${err.message}</div>`.toString();
    }
  }

  function renderPreview(p) {
    let show = p.summary.error ? 'error' : 'all';
    const s = p.summary;
    const draw = () => {
      const rows = p.rows.filter((r) => show === 'all' || (show === 'error' ? r.action === 'error' : r.warnings.length));
      previewEl.innerHTML = html`
        <div style="margin-top:20px;border-top:1px solid var(--border);padding-top:18px">
          <h2>Preview: ${p.fileName}</h2>
          <div class="grid cols-4" style="margin:14px 0">
            <div class="card stat"><span class="label">New assets</span><span class="value">${num(s.create)}</span></div>
            <div class="card stat"><span class="label">Updates</span><span class="value">${num(s.update)}</span></div>
            <div class="card stat"><span class="label">Rows with errors</span><span class="value">${num(s.error)}</span><span class="sub ${s.error ? 'bad' : ''}">${s.error ? 'Will be skipped' : 'None'}</span></div>
            <div class="card stat"><span class="label">New employees</span><span class="value">${num(s.newEmployees)}</span></div>
          </div>
          <div style="margin-bottom:14px"><div class="muted" style="font-size:12.5px;margin-bottom:6px">How your columns were read</div>
            <div class="mapping">${p.mapping.filter((m) => m.header).map((m) => html`<span class="chip plain ${m.field ? 'mapped' : ''}" title="${m.field ? 'Imported' : 'Ignored'}">
              ${m.header}${m.field ? ` → ${FIELD_NAMES[m.field]}` : ' (ignored)'}</span>`)}</div></div>
          <div class="actions" style="margin-bottom:10px">
            <button class="btn small ${show === 'all' ? 'primary' : ''}" data-show="all">All rows (${num(s.total)})</button>
            <button class="btn small ${show === 'error' ? 'primary' : ''}" data-show="error">Errors (${num(s.error)})</button>
            <button class="btn small ${show === 'warn' ? 'primary' : ''}" data-show="warn">Warnings (${num(s.warnings)})</button>
          </div>
          <div class="card"><div class="table-wrap" style="max-height:420px">
            ${rows.length ? html`<table><thead><tr><th>Row</th><th>Action</th><th>Asset</th><th class="hide-sm">Assigned to</th><th>Notes</th></tr></thead>
            <tbody>${rows.slice(0, 500).map((r) => html`<tr class="${r.action === 'error' ? 'row-error' : ''}">
              <td class="mono">${r.line}</td>
              <td><span class="chip ${r.action === 'create' ? 'good' : r.action === 'update' ? 'in_use' : 'bad'}">${r.action === 'create' ? 'New' : r.action === 'update' ? 'Update' : 'Error'}</span></td>
              <td>${r.tag ? html`<span class="mono">${r.tag}</span> · ` : ''}${r.name || html`<span class="muted">(no name)</span>`}<span class="sub">${r.category || ''}</span></td>
              <td class="hide-sm">${r.employeeName || html`<span class="muted">—</span>`}</td>
              <td>${r.errors.map((m) => html`<span class="issue error">${m}</span>`)}${r.warnings.map((m) => html`<span class="issue warn">${m}</span>`)}</td></tr>`)}</tbody></table>`
              : html`<div class="empty">No rows in this view.</div>`}
          </div></div>
          <div class="actions" style="margin-top:16px">
            <button class="btn primary" id="commit" ${s.create + s.update === 0 ? 'disabled' : ''}>Import ${num(s.create + s.update)} row${s.create + s.update === 1 ? '' : 's'}${s.error ? `, skip ${num(s.error)}` : ''}</button>
            <button class="btn" id="cancel">Cancel</button>
          </div>
        </div>`.toString();
    };
    draw();
    previewEl.onclick = async (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.show) { show = b.dataset.show; draw(); }
      if (b.id === 'cancel') previewEl.innerHTML = '';
      if (b.id === 'commit') {
        b.disabled = true;
        try {
          const r = await api('/import/commit', { method: 'POST', body: { token: p.token, skipErrors: true } });
          invalidateEmployees();
          toast(`Import complete: ${r.created} created, ${r.updated} updated${r.unchanged ? `, ${r.unchanged} already up to date` : ''}${r.skipped ? `, ${r.skipped} skipped` : ''}.`);
          navigate('/assets?sort=updated_at&dir=desc');
        } catch (err) {
          b.disabled = false;
          toast(err.message, 'error');
        }
      }
    };
  }
}

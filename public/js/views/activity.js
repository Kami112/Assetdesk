import { api, qs } from '../api.js';
import { html, raw, num, fmtDateTime } from '../ui.js';
import { setQuery } from '../app.js';

const ENTITIES = [['', 'Everything'], ['asset', 'Assets'], ['employee', 'Employees'], ['license', 'Licenses'], ['user', 'Users'], ['import', 'Imports'], ['settings', 'Settings']];
const LINKS = { asset: 'assets', employee: 'employees', license: 'licenses' };

export async function activityView({ el, query }) {
  const f = { q: query.get('q') || '', entity: query.get('entity') || '', page: query.get('page') || '' };
  el.innerHTML = html`
    <div class="page-head"><div><h1>Activity log</h1><p>Every change, who made it and when. Entries cannot be edited or deleted.</p></div></div>
    <div class="filters">
      <input type="search" id="aq" placeholder="Search activity…" value="${f.q}" aria-label="Search activity">
      <select id="ae" aria-label="Type">${ENTITIES.map(([v, l]) => html`<option value="${v}" ${v === f.entity ? raw('selected') : ''}>${l}</option>`)}</select>
    </div>
    <div class="card"><div id="rows"></div><div id="pager"></div></div>`.toString();

  async function load() {
    const d = await api(`/audit${qs(f)}`);
    const pages = Math.max(1, Math.ceil(d.total / d.pageSize));
    el.querySelector('#rows').innerHTML = d.items.length ? html`<div class="table-wrap"><table>
      <thead><tr><th>When</th><th>What happened</th><th class="hide-sm">By</th></tr></thead>
      <tbody>${d.items.map((r) => html`<tr>
        <td class="nowrap muted">${fmtDateTime(r.at)}</td>
        <td>${LINKS[r.entity] && r.action !== 'delete' && r.entity_id ? html`<a href="#/${LINKS[r.entity]}/${r.entity_id}">${r.summary}</a>` : r.summary}</td>
        <td class="hide-sm nowrap">${r.user_name}</td></tr>`)}</tbody></table></div>`.toString()
      : '<div class="empty">No activity found.</div>';
    el.querySelector('#pager').innerHTML = html`<div class="pager"><span>${num(d.total)} entries</span>
      <span class="actions"><button class="btn small" data-page="${d.page - 1}" ${d.page <= 1 ? raw('disabled') : ''}>Newer</button>
      <span>Page ${d.page} of ${pages}</span>
      <button class="btn small" data-page="${d.page + 1}" ${d.page >= pages ? raw('disabled') : ''}>Older</button></span></div>`.toString();
  }

  let timer;
  el.querySelector('#aq').addEventListener('input', (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => { f.q = e.target.value.trim(); f.page = ''; setQuery(f); load(); }, 250);
  });
  el.querySelector('#ae').addEventListener('change', (e) => { f.entity = e.target.value; f.page = ''; setQuery(f); load(); });
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-page]');
    if (b) { f.page = b.dataset.page; setQuery(f); load(); }
  });
  await load();
}

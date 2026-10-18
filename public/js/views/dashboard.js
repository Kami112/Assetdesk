import { api } from '../api.js';
import { html, money, num, fmtDate, relTime, dueChip, STATUS_LABELS, monthLabel } from '../ui.js';
import { barList, columnChart, bindColumnTooltips } from '../charts.js';
import { state } from '../app.js';

export async function dashboardView({ el }) {
  const d = await api('/dashboard');
  const t = d.totals;
  const spendTotal = d.spend.reduce((s, m) => s + m.total, 0);
  const statusOrder = ['in_use', 'in_stock', 'in_repair', 'retired', 'lost'];
  const attention = [];
  if (d.overAllocated.length) {
    attention.push(html`<li><span class="grow"><strong>${d.overAllocated.length} license${d.overAllocated.length > 1 ? 's' : ''} over-allocated</strong>
      <span class="muted">${d.overAllocated.map((l) => `${l.name} (${l.seats_used}/${l.seats})`).join(', ')}</span></span>
      <a class="btn small" href="#/licenses/${d.overAllocated[0].id}">Review</a></li>`);
  }
  if (t.warrantySoon) {
    attention.push(html`<li><span class="grow"><strong>${t.warrantySoon} warrant${t.warrantySoon > 1 ? 'ies' : 'y'} ending within 90 days</strong>
      <span class="muted">Extend coverage or plan replacements</span></span><a class="btn small" href="#/assets?flag=warranty_soon&sort=warranty_end">View</a></li>`);
  }
  if (t.refreshDue) {
    attention.push(html`<li><span class="grow"><strong>${t.refreshDue} device${t.refreshDue > 1 ? 's' : ''} due for refresh</strong>
      <span class="muted">Past or near the end of their expected life</span></span><a class="btn small" href="#/assets?flag=refresh_due&sort=purchase_date">View</a></li>`);
  }
  if (d.licensesExpiring.length) {
    attention.push(html`<li><span class="grow"><strong>${d.licensesExpiring.length} license${d.licensesExpiring.length > 1 ? 's' : ''} renewing within 90 days</strong>
      <span class="muted">${d.licensesExpiring.map((l) => `${l.name} (${fmtDate(l.expires_on)})`).join(', ')}</span></span>
      <a class="btn small" href="#/licenses">View</a></li>`);
  }
  if (t.unusedSeats) {
    attention.push(html`<li><span class="grow"><strong>${t.unusedSeats} unused license seats</strong>
      <span class="muted">About ${money(t.unusedSeatCost)} a year in unused subscriptions</span></span><a class="btn small" href="#/licenses">Review</a></li>`);
  }

  el.innerHTML = html`
    <div class="page-head">
      <div><h1>Dashboard</h1><p>${state.settings.company_name} · ${num(t.active)} active assets across ${num(t.employees)} employees</p></div>
      <div class="actions"><a class="btn" href="#/import">Import / export</a></div>
    </div>

    <div class="grid cols-4">
      <a class="card stat" href="#/assets?status=active"><span class="label">Active assets</span><span class="value">${num(t.active)}</span>
        <span class="sub">${num(d.byStatus.in_use)} in use · ${num(d.byStatus.in_stock)} in stock</span></a>
      <div class="card stat"><span class="label">Fleet value (book)</span><span class="value">${money(t.currentValue)}</span>
        <span class="sub">Bought for ${money(t.purchaseValue)}</span></div>
      <a class="card stat" href="#/assets?flag=warranty_soon&sort=warranty_end"><span class="label">Warranties ending ≤ 90 days</span>
        <span class="value">${num(t.warrantySoon)}</span><span class="sub ${t.warrantyExpired ? 'warn' : ''}">${num(t.warrantyExpired)} active assets already out of warranty</span></a>
      <a class="card stat" href="#/assets?flag=refresh_due&sort=purchase_date"><span class="label">Due for refresh</span>
        <span class="value">${num(t.refreshDue)}</span><span class="sub">End of expected life within 90 days</span></a>
    </div>

    <div class="grid cols-3" style="margin-top:16px">
      <section class="card span-2">
        <div class="card-head"><h2>Hardware spend, last 12 months</h2><span class="muted">${money(spendTotal)} total</span></div>
        <div class="card-body">${columnChart(d.spend.map((m) => ({ label: monthLabel(m.month), value: m.total, tip: `${money(m.total)} · ${m.count} item${m.count === 1 ? '' : 's'}` })))}</div>
      </section>
      <section class="card">
        <div class="card-head"><h2>Needs attention</h2></div>
        <div class="card-body">${attention.length ? html`<ul class="list">${attention}</ul>` : html`<div class="callout good">Nothing needs attention right now.</div>`}</div>
      </section>
    </div>

    <div class="grid cols-3" style="margin-top:16px">
      <section class="card">
        <div class="card-head"><h2>Active assets by category</h2></div>
        <div class="card-body">${barList(d.byCategory.map((c) => ({ label: c.category, value: c.n, href: `#/assets?category=${encodeURIComponent(c.category)}&status=active` })), { format: num })}</div>
      </section>
      <section class="card">
        <div class="card-head"><h2>All assets by status</h2></div>
        <div class="card-body">${barList(statusOrder.map((s) => ({ label: STATUS_LABELS[s], value: d.byStatus[s], href: `#/assets?status=${s}` })), { format: num })}</div>
      </section>
      <section class="card">
        <div class="card-head"><h2>Warranties ending soon</h2><a href="#/assets?flag=warranty_soon&sort=warranty_end">All</a></div>
        <div class="card-body">${d.warrantySoon.length ? html`<ul class="list">${d.warrantySoon.map((a) => html`
          <li><span class="grow"><a href="#/assets/${a.id}"><strong>${a.tag}</strong> ${a.name}</a><span class="muted">${a.employee_name || STATUS_LABELS[a.status]}</span></span>${dueChip(a.warranty_end)}</li>`)}</ul>`
          : html`<p class="muted">No warranties end in the next 90 days.</p>`}</div>
      </section>
    </div>

    <section class="card" style="margin-top:16px">
      <div class="card-head"><h2>Recent activity</h2><a href="#/activity">Full log</a></div>
      <div class="card-body"><ul class="list">${d.recent.map((r) => html`
        <li><span class="grow"><span>${r.summary}</span><span class="muted">${r.user_name}</span></span><span class="muted nowrap" title="${r.at}">${relTime(r.at)}</span></li>`)}</ul></div>
    </section>`.toString();
  bindColumnTooltips(el);
}

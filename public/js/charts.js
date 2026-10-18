// Minimal, dependency-free charts. Each is a single series, so one hue plus direct labels; no legend needed.
import { html, raw } from './ui.js';

/** Horizontal bar list: one row per item with the value written beside the bar. */
export function barList(items, { format = (v) => v, max = null } = {}) {
  const top = max ?? Math.max(1, ...items.map((i) => i.value));
  return html`<div class="bars">${items.map((i) => {
    const pct = Math.max(0, Math.min(100, (i.value / top) * 100));
    const inner = html`<span>${i.label}</span>
      <span class="track"><span class="fill" style="display:block;width:${pct.toFixed(1)}%"></span></span>
      <span class="num">${format(i.value)}</span>`;
    return i.href
      ? html`<a class="bar-row" href="${i.href}" title="${i.label}: ${format(i.value)}">${inner}</a>`
      : html`<div class="bar-row" title="${i.label}: ${format(i.value)}">${inner}</div>`;
  })}</div>`;
}

const niceMax = (v) => {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const m = v / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p;
};
const compact = (v) => (v >= 1e6 ? `${+(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${+(v / 1e3).toFixed(1)}k` : String(Math.round(v)));

/** Column chart with a recessive grid and a hover tooltip per column (bind with bindColumnTooltips). */
export function columnChart(data, { height = 200 } = {}) {
  const W = 640;
  const H = height;
  const pad = { l: 40, r: 6, t: 10, b: 24 };
  const max = niceMax(Math.max(...data.map((d) => d.value)));
  const plotW = W - pad.l - pad.r;
  const plotH = H - pad.t - pad.b;
  const slot = plotW / data.length;
  const bw = Math.min(36, slot * 0.62);
  const ticks = [0, 0.5, 1];
  const y = (v) => pad.t + plotH * (1 - v / max);
  return html`<div class="columns" role="img" aria-label="${data.map((d) => `${d.label}: ${d.tip}`).join('; ')}">
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
      <g class="axis">${ticks.map((t) => html`
        <line class="grid-line" x1="${pad.l}" x2="${W - pad.r}" y1="${y(max * t)}" y2="${y(max * t)}"></line>
        <text x="${pad.l - 8}" y="${y(max * t) + 4}" text-anchor="end">${compact(max * t)}</text>`)}
      ${data.map((d, i) => html`<text x="${pad.l + slot * i + slot / 2}" y="${H - 6}" text-anchor="middle">${d.label}</text>`)}</g>
      ${data.map((d, i) => {
        const x = pad.l + slot * i + (slot - bw) / 2;
        const h = Math.max(d.value > 0 ? 2 : 0, plotH * (d.value / max));
        const top = pad.t + plotH - h;
        const r = Math.min(4, h / 2, bw / 2);
        // Rounded top corners only; the base sits flat on the axis.
        const path = h > 0
          ? `M${x},${top + h} V${top + r} Q${x},${top} ${x + r},${top} H${x + bw - r} Q${x + bw},${top} ${x + bw},${top + r} V${top + h} Z`
          : '';
        return html`<g data-tip="${d.label}: ${d.tip}" data-x="${((pad.l + slot * i + slot / 2) / W) * 100}" data-y="${(top / H) * 100}">
          <rect class="col-hit" x="${pad.l + slot * i}" y="${pad.t}" width="${slot}" height="${plotH}"></rect>
          <path class="col" d="${raw(path)}"></path></g>`;
      })}
    </svg>
    <div class="tooltip" hidden></div>
  </div>`;
}

export function bindColumnTooltips(root) {
  root.querySelectorAll('.columns').forEach((chart) => {
    const tip = chart.querySelector('.tooltip');
    chart.querySelectorAll('g[data-tip]').forEach((g) => {
      const show = () => {
        tip.textContent = g.dataset.tip;
        tip.style.left = `${g.dataset.x}%`;
        tip.style.top = `${g.dataset.y}%`;
        tip.hidden = false;
      };
      g.addEventListener('mouseenter', show);
      g.addEventListener('mouseleave', () => { tip.hidden = true; });
    });
  });
}

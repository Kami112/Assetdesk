'use strict';
const { LIFESPAN_YEARS, STATUSES, getMeta } = require('./db');
const { normalizeCategory } = require('./validate');

const DAY_MS = 86400000;
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (iso, days) => new Date(Date.parse(iso) + days * DAY_MS).toISOString().slice(0, 10);

// SQL expression: the date an asset reaches the end of its expected life.
const LIFESPAN_CASE = `CASE a.category ${Object.entries(LIFESPAN_YEARS)
  .map(([c, y]) => `WHEN '${c}' THEN ${y}`).join(' ')} ELSE 4 END`;
const END_OF_LIFE_SQL = `date(a.purchase_date, '+' || (${LIFESPAN_CASE}) || ' years')`;

const ASSET_SELECT = `
  SELECT a.*, e.name AS employee_name, e.email AS employee_email, ${END_OF_LIFE_SQL} AS end_of_life
  FROM assets a LEFT JOIN employees e ON e.id = a.employee_id`;

const SORTS = {
  tag: 'a.tag', name: 'a.name', category: 'a.category', status: 'a.status', employee: 'e.name',
  location: 'a.location', purchase_date: 'a.purchase_date', warranty_end: 'a.warranty_end',
  purchase_cost: 'a.purchase_cost', updated_at: 'a.updated_at',
};

const likeEscape = (s) => s.replace(/[\\%_]/g, (c) => '\\' + c);

/** Builds a WHERE clause from list/export query parameters. */
function assetFilters(q) {
  const where = [];
  const params = [];
  const t = today();
  if (q.q) {
    const like = `%${likeEscape(String(q.q).trim())}%`;
    where.push(`(a.tag LIKE ? ESCAPE '\\' OR a.name LIKE ? ESCAPE '\\' OR a.serial LIKE ? ESCAPE '\\'
      OR a.model LIKE ? ESCAPE '\\' OR a.manufacturer LIKE ? ESCAPE '\\' OR a.location LIKE ? ESCAPE '\\'
      OR e.name LIKE ? ESCAPE '\\' OR e.email LIKE ? ESCAPE '\\')`);
    params.push(like, like, like, like, like, like, like, like);
  }
  if (q.category) {
    const c = normalizeCategory(q.category);
    if (c) { where.push('a.category = ?'); params.push(c); }
  }
  if (q.status && STATUSES.includes(q.status)) { where.push('a.status = ?'); params.push(q.status); }
  if (q.status === 'active') where.push(`a.status NOT IN ('retired', 'lost')`);
  if (q.location) { where.push('a.location = ?'); params.push(String(q.location)); }
  if (q.department) { where.push('a.department = ?'); params.push(String(q.department)); }
  if (q.employee_id) { where.push('a.employee_id = ?'); params.push(Number(q.employee_id)); }
  if (q.ids) {
    const ids = String(q.ids).split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 1000);
    where.push(`a.id IN (${ids.map(() => '?').join(',') || 'NULL'})`);
    params.push(...ids);
  }
  switch (q.flag) {
    case 'warranty_soon':
      where.push(`a.warranty_end BETWEEN ? AND ? AND a.status NOT IN ('retired', 'lost')`);
      params.push(t, addDays(t, 90));
      break;
    case 'warranty_expired':
      where.push(`a.warranty_end < ? AND a.status NOT IN ('retired', 'lost')`);
      params.push(t);
      break;
    case 'refresh_due':
      where.push(`a.purchase_date IS NOT NULL AND ${END_OF_LIFE_SQL} <= ? AND a.status NOT IN ('retired', 'lost')`);
      params.push(addDays(t, 90));
      break;
    case 'unassigned_in_use':
      where.push(`a.status = 'in_use' AND a.employee_id IS NULL`);
      break;
    default:
  }
  return { where: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

function orderBy(q) {
  const col = SORTS[q.sort] || 'a.tag';
  const dir = q.dir === 'desc' ? 'DESC' : 'ASC';
  return `ORDER BY ${col} IS NULL, ${col} ${dir}, a.id ${dir}`;
}

/** Straight-line depreciation to zero over the category's expected life. */
function bookValue(asset, onDate = today()) {
  if (asset.purchase_cost == null || !asset.purchase_date) return null;
  const years = LIFESPAN_YEARS[asset.category] || 4;
  const age = (Date.parse(onDate) - Date.parse(asset.purchase_date)) / (365.25 * DAY_MS);
  if (age <= 0) return asset.purchase_cost;
  return Math.max(0, Math.round(asset.purchase_cost * (1 - age / years) * 100) / 100);
}

function settings(db) {
  return {
    company_name: getMeta(db, 'company_name', 'My Company'),
    currency: getMeta(db, 'currency', 'USD'),
    tag_prefix: getMeta(db, 'tag_prefix', 'AST-'),
  };
}

module.exports = {
  ASSET_SELECT, END_OF_LIFE_SQL, assetFilters, orderBy, bookValue, settings, today, addDays, likeEscape,
};

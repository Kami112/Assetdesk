// Thin fetch wrapper. Every call sends the X-Requested-With header the server requires (CSRF guard).

export class ApiError extends Error {
  constructor(message, status, errors) {
    super(message);
    this.status = status;
    this.errors = errors;
  }
}

let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };

export async function api(path, { method = 'GET', body, form } = {}) {
  const opts = { method, credentials: 'same-origin', headers: { 'X-Requested-With': 'AssetDesk' } };
  if (form) opts.body = form;
  else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(`/api${path}`, opts);
  } catch {
    throw new ApiError('Cannot reach the server. Check your connection.', 0);
  }
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (res.status === 401 && !path.startsWith('/auth/')) onUnauthorized();
  if (!res.ok) throw new ApiError(data?.error || `Request failed (${res.status})`, res.status, data?.errors);
  return data;
}

export const qs = (params) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
};

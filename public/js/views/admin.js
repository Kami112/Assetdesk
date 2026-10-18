import { api } from '../api.js';
import { html, icon, relTime, toast, formDialog, field, download, formValues, clearErrors, showErrors, setCurrency } from '../ui.js';
import { can, state } from '../app.js';

const ROLE_HELP = {
  viewer: 'Can see everything except license keys. Cannot change anything.',
  editor: 'Can add and edit assets, employees and licenses, import, check in and out.',
  admin: 'Everything editors can do, plus deleting, users, settings and backups.',
};
const roleOptions = [['viewer', 'Viewer'], ['editor', 'Editor'], ['admin', 'Admin']];

export async function adminView({ el, navigate }) {
  if (!can('admin')) { el.innerHTML = '<div class="callout">Only admins can open this page.</div>'; return; }
  const [{ items: users }, settings] = await Promise.all([api('/users'), api('/settings')]);

  el.innerHTML = html`
    <div class="page-head"><div><h1>Admin</h1><p>Users, settings and backups.</p></div></div>
    ${state.demo ? html`<div class="callout warn" style="margin-bottom:16px">Changes on this page are disabled in the public demo.</div>` : ''}
    <section class="card" style="margin-bottom:16px">
      <div class="card-head"><h2>Users (${users.length})</h2><button class="btn small primary" id="addUser">${icon('plus')}Add user</button></div>
      <div class="card-body"><div class="table-wrap"><table>
        <thead><tr><th>Name</th><th>Role</th><th class="hide-sm">Last sign-in</th><th>Status</th><th></th></tr></thead>
        <tbody>${users.map((u) => html`<tr>
          <td><strong>${u.name}</strong><span class="sub">${u.email}</span></td>
          <td class="role">${u.role}</td>
          <td class="hide-sm muted">${u.last_login_at ? relTime(u.last_login_at) : 'Never'}</td>
          <td><span class="chip ${u.active ? 'active' : 'retired'}">${u.active ? 'Active' : 'Deactivated'}</span></td>
          <td class="nowrap" style="text-align:right"><button class="btn small" data-edit="${u.id}">Edit</button>
            <button class="btn small ghost" data-reset="${u.id}">Reset password</button></td></tr>`)}</tbody></table></div>
        <p class="muted" style="font-size:12.5px;margin:12px 0 0">${roleOptions.map(([r, l]) => html`<strong>${l}:</strong> ${ROLE_HELP[r]} `)}</p>
      </div>
    </section>
    <div class="grid cols-2">
      <form class="card card-pad" id="settingsForm" novalidate>
        <h2 style="margin-bottom:14px">Settings</h2>
        <div class="grid">
          ${field('Company name', 'company_name', { value: settings.company_name })}
          ${field('Currency', 'currency', { value: settings.currency, hint: '3-letter code shown next to all amounts, e.g. SAR' })}
          ${field('Asset tag prefix', 'tag_prefix', { value: settings.tag_prefix, hint: 'New assets get tags like AST-00042' })}
        </div>
        <div class="field-error" data-error-for="_form"></div>
        <div class="actions" style="margin-top:14px"><button class="btn primary" type="submit">Save settings</button></div>
      </form>
      <section class="card card-pad">
        <h2 style="margin-bottom:6px">Backup</h2>
        <p class="muted" style="margin:0 0 14px">Download a complete copy of the database (a single SQLite file). Keep it somewhere safe; it contains all
          inventory data and license keys. To restore, stop the server and replace <span class="mono">assetdesk.db</span> in the data folder.</p>
        <button class="btn" id="backup">${icon('download')}Download backup</button>
      </section>
    </div>`.toString();

  const userForm = (u = {}) => html`
    ${field('Full name', 'name', { value: u.name, required: true })}
    ${u.id ? '' : field('Email', 'email', { type: 'email', required: true })}
    ${field('Role', 'role', { value: u.role || 'viewer', options: roleOptions })}
    ${u.id ? html`<label class="checkbox"><input type="checkbox" name="active" ${u.active ? 'checked' : ''}> Account is active</label>`
      : field('Temporary password', 'password', { type: 'password', hint: 'At least 10 characters. Ask them to change it after signing in.', attrs: 'autocomplete="new-password"' })}`;

  el.querySelector('#addUser').addEventListener('click', async () => {
    const u = await formDialog({ title: 'Add user', body: userForm(), submitLabel: 'Add user', onSubmit: (v) => api('/users', { method: 'POST', body: v }) });
    if (u) { toast(`${u.name} can now sign in.`); navigate('/admin'); }
  });
  el.addEventListener('click', async (e) => {
    const editId = e.target.closest('[data-edit]')?.dataset.edit;
    const resetId = e.target.closest('[data-reset]')?.dataset.reset;
    if (editId) {
      const u = users.find((x) => String(x.id) === editId);
      const saved = await formDialog({ title: `Edit ${u.name}`, body: userForm(u), onSubmit: (v) => api(`/users/${u.id}`, { method: 'PATCH', body: v }) });
      if (saved) { toast('User updated.'); navigate('/admin'); }
    }
    if (resetId) {
      const u = users.find((x) => String(x.id) === resetId);
      const ok = await formDialog({
        title: `Reset password for ${u.name}`,
        description: 'They will be signed out everywhere and must use the new password.',
        body: field('New password', 'password', { type: 'password', hint: 'At least 10 characters', attrs: 'autocomplete="new-password"' }),
        submitLabel: 'Reset password',
        onSubmit: (v) => api(`/users/${u.id}/password`, { method: 'POST', body: v }),
      });
      if (ok) toast('Password reset.');
    }
  });
  const sf = el.querySelector('#settingsForm');
  sf.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearErrors(sf);
    try {
      state.settings = await api('/settings', { method: 'PATCH', body: formValues(sf) });
      setCurrency(state.settings.currency);
      document.querySelector('.brand small').textContent = state.settings.company_name;
      toast('Settings saved.');
    } catch (err) { showErrors(sf, err); }
  });
  el.querySelector('#backup').addEventListener('click', () => download('/api/admin/backup', 'assetdesk-backup.db').catch((err) => toast(err.message, 'error')));
}

export async function accountView({ el }) {
  el.innerHTML = html`
    <div class="page-head"><div><h1>Your account</h1><p>${state.user.name} · ${state.user.email} · <span class="role">${state.user.role}</span></p></div></div>
    <form class="card card-pad" id="pwForm" style="max-width:480px" novalidate>
      <h2 style="margin-bottom:14px">Change password</h2>
      <div class="grid">
        ${field('Current password', 'current_password', { type: 'password', attrs: 'autocomplete="current-password"' })}
        ${field('New password', 'new_password', { type: 'password', hint: 'At least 10 characters. A short sentence is easy to remember and hard to guess.', attrs: 'autocomplete="new-password"' })}
      </div>
      <div class="field-error" data-error-for="_form"></div>
      <div class="actions" style="margin-top:14px"><button class="btn primary" type="submit">Change password</button></div>
    </form>`.toString();
  const form = el.querySelector('#pwForm');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearErrors(form);
    try {
      await api('/auth/password', { method: 'POST', body: formValues(form) });
      form.reset();
      toast('Password changed. Other devices have been signed out.');
    } catch (err) { showErrors(form, err); }
  });
}

// System settings (super-admins only): change server settings without
// touching Portainer. A value saved here overrides the server environment;
// "Reset" goes back to it. Secrets are write-only.
import { api, append, busy, fmtDate, h, session, showError, toast } from '../ui.js';

const SOURCE = {
  saved: ['good', 'Set here'],
  environment: ['', 'From server environment'],
  default: ['', 'Default'],
};

export async function systemView(el) {
  if (!session.me?.is_superadmin) {
    el.append(h('h1', {}, 'System'), h('div', { class: 'card notice warn' }, 'Only a super-admin can open this page.'));
    return;
  }
  const rows = await api.get('/system/settings');
  const groups = [...new Set(rows.map((r) => r.group))];
  const rerender = async () => {
    try {
      const fresh = h('div');
      await systemView(fresh);
      el.replaceChildren(...fresh.childNodes);
    } catch (e) { showError(e); }
  };

  append(el, // append(): the DOM's own append() would print the array of sections as text
    h('div', { class: 'page-head' }, h('h1', {}, 'System')),
    h('p', { class: 'muted' },
      'Server settings. A value saved here takes effect within half a minute and overrides the server environment (.env / Portainer). ',
      '“Reset” goes back to the environment or the default. Passwords and keys are never shown – only their last characters.'),
    groups.map((g) => h('section', { class: 'card' },
      h('h2', {}, g),
      h('div', { class: 'sys-rows' }, rows.filter((r) => r.group === g).map((r) => settingRow(r, rerender))))));
}

function settingRow(r, done) {
  let input;
  if (r.choices.length) {
    input = h('select', {}, r.choices.map((c) => h('option', { value: c }, c)));
    input.value = r.value ?? r.default ?? r.choices[0];
  } else {
    input = h('input', {
      type: r.secret ? 'password' : (r.type === 'str' ? 'text' : 'number'),
      value: r.secret ? '' : (r.value ?? ''),
      placeholder: r.secret ? (r.is_set ? `Set (${r.hint}) – type a new value to replace` : 'Not set') : (r.default !== '' && r.default != null ? `Default: ${r.default}` : ''),
      min: r.min ?? undefined, max: r.max ?? undefined, step: r.type === 'float' ? 'any' : undefined,
      autocomplete: r.secret ? 'new-password' : 'off', spellcheck: 'false',
    });
  }
  input.id = `sys-${r.name}`;
  const save = h('button', { class: 'btn primary small', type: 'submit' }, 'Save');
  const [cls, label] = SOURCE[r.source] ?? ['', r.source];
  const form = h('form', { class: 'sys-row' },
    h('label', { for: input.id }, h('strong', {}, r.label),
      r.help ? h('span', { class: 'muted small block' }, r.help) : null),
    h('div', { class: 'sys-input' }, input, save),
    h('div', { class: 'sys-meta small' },
      h('span', { class: `badge ${cls}` }, label),
      r.secret && r.is_set && r.source !== 'saved' ? h('span', { class: 'muted' }, ` ${r.hint}`) : null,
      r.updated_at ? h('span', { class: 'muted' }, ` · ${fmtDate(r.updated_at)}${r.updated_by_name ? ` by ${r.updated_by_name}` : ''}`) : null,
      ' ',
      r.source === 'saved' ? h('button', {
        class: 'link', type: 'button',
        onClick: async () => {
          if (!confirm(`Reset “${r.label}” to the server environment / default?`)) return;
          try { await api.del(`/system/settings/${r.name}`); toast('Reset', 'success'); await done(); } catch (e) { showError(e); }
        },
      }, 'Reset') : null,
      h('code', { class: 'muted sys-env' }, r.env)));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!String(input.value).trim()) { showError(new Error('Type a value first (or use Reset)')); return; }
    busy(save, async () => {
      await api.put(`/system/settings/${r.name}`, { value: String(input.value) });
      toast(`${r.label} saved`, 'success');
      await done();
    });
  });
  return form;
}

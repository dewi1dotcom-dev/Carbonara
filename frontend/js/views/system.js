// System settings (system admins only): change server settings without
// touching Portainer. A value saved here overrides the server environment;
// "Reset" goes back to it. Secrets are write-only.
import { api, append, busy, fmtDate, h, session, showError, toast } from '../ui.js';

const SOURCE = {
  saved: ['good', 'Set here'],
  environment: ['', 'From server environment'],
  default: ['', 'Default'],
};

// host: the page's real container. A redraw renders into a fresh div and moves the result
// into host, so every redraw (not only the first) updates the visible page.
export async function systemView(el, _params = [], host = el) {
  if (!session.me?.is_superadmin) {
    el.append(h('h1', {}, 'System'), h('div', { class: 'card notice warn' }, 'Only a system admin can open this page.'));
    return;
  }
  const [rows, teams] = await Promise.all([api.get('/system/settings'), api.get('/system/teams')]);
  const groups = [...new Set(rows.map((r) => r.group))];
  const rerender = async () => {
    try {
      const fresh = h('div');
      await systemView(fresh, [], host);
      host.replaceChildren(...fresh.childNodes);
    } catch (e) { showError(e); }
  };

  append(el, // append(): the DOM's own append() would print the array of sections as text
    h('div', { class: 'page-head' }, h('h1', {}, 'System')),
    h('p', { class: 'muted' },
      'Server settings. A value saved here takes effect within half a minute and overrides the server environment (.env / Portainer). ',
      '“Reset” goes back to the environment or the default. Passwords and keys are never shown – only their last characters.'),
    teamsCard(teams, rerender),
    groups.map((g) => h('section', { class: 'card' },
      h('h2', {}, g),
      h('div', { class: 'sys-rows' }, rows.filter((r) => r.group === g).map((r) => settingRow(r, rerender))))));
}

// ---------------------------------------------------------------- teams

// Top menu items a team can be given (server: auth.MENU_ITEMS). Today is always there.
const MENU_LABEL = {
  arrivals: 'Arrivals', vehicles: 'Vehicles', storage: 'Storage', testdrive: 'Test drive', rental: 'Rental cars',
  deliveries: 'Deliveries', settings: 'Settings',
};

/** Teams: name, which menu items they see, and who is in them. One team per user. */
function teamsCard(data, done) {
  const run = async (fn) => { try { await fn(); await done(); } catch (e) { showError(e); } };
  const teamName = (id) => data.teams.find((t) => t.id === id)?.name;
  const noTeam = data.staff.filter((s) => !s.team_id && !s.is_superadmin);

  const teamBox = (t) => {
    // Ticking a box saves at once.
    const boxes = data.items.map((key) => {
      const box = h('input', { type: 'checkbox', checked: t.menu.includes(key) });
      box.addEventListener('change', () => run(() => api.patch(`/system/teams/${t.id}`, {
        menu: data.items.filter((k, i) => boxes[i].querySelector('input').checked),
      })));
      return h('label', { class: 'chip' }, box, h('span', {}, MENU_LABEL[key] ?? key));
    });
    // Anyone not in this team can be added (moved from their current team).
    const pick = h('select', { 'aria-label': 'Add a user to the team' },
      h('option', { value: '' }, 'Add a user…'),
      data.staff.filter((s) => s.team_id !== t.id).map((s) => h('option', { value: s.id },
        s.team_id ? `${s.name} (now in ${teamName(s.team_id)})` : s.name)));
    pick.addEventListener('change', () => {
      if (pick.value) run(() => api.put(`/system/staff/${pick.value}/team`, { team_id: t.id }));
    });
    return h('div', { class: 'card inner team-box' },
      h('div', { class: 'team-head' }, h('h3', { translate: 'no' }, t.name),
        h('span', { class: 'row-actions' },
          h('button', {
            class: 'link', type: 'button',
            onClick: () => {
              const n = prompt('Team name', t.name);
              if (n != null && n.trim() && n.trim() !== t.name) run(() => api.patch(`/system/teams/${t.id}`, { name: n }));
            },
          }, 'Rename'),
          h('button', {
            class: 'link danger', type: 'button',
            onClick: () => {
              const msg = t.members.length
                ? `Delete the team ${t.name}? Its ${t.members.length} member(s) will only see Today until you place them in another team.`
                : `Delete the team ${t.name}?`;
              if (confirm(msg)) run(() => api.del(`/system/teams/${t.id}`));
            },
          }, 'Delete'))),
      h('div', { class: 'small muted' }, 'Menu items this team sees (Today is always shown):'),
      h('div', { class: 'chips' }, boxes),
      h('div', { class: 'small muted team-members-label' }, `Members (${t.members.length})`),
      t.members.length
        ? h('ul', { class: 'plain rows' }, t.members.map((s) => h('li', {},
          h('span', {}, h('span', { translate: 'no' }, s.name),
            s.is_superadmin ? h('span', { class: 'muted small' }, ' · System admin – sees everything') : null),
          h('span', { class: 'row-actions' },
            h('button', {
              class: 'link', type: 'button',
              onClick: () => run(() => api.put(`/system/staff/${s.id}/team`, { team_id: null })),
            }, 'Remove from team')))))
        : h('p', { class: 'empty' }, 'No members.'),
      pick);
  };

  const name = h('input', { type: 'text', placeholder: 'New team name, e.g. Sales', maxlength: 60, required: true });
  const add = h('button', { class: 'btn primary', type: 'submit' }, 'Add team');
  const form = h('form', { class: 'inline-form wrap' }, name, add);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(add, async () => {
      await api.post('/system/teams', { name: name.value, menu: [] });
      toast('Team added', 'success');
      await done();
    });
  });

  return h('section', { class: 'card' },
    h('h2', {}, 'Teams'),
    h('p', { class: 'muted small' },
      'Each user is in one team. The team decides which items they see in the top menu; other pages show “not available”. '
      + 'Users without a team see only Today. System admins always see everything. '
      + 'A change takes effect the next time the user opens or reloads Carbonara.'),
    noTeam.length ? h('div', { class: 'notice warn' },
      h('span', {}, `Without a team (only Today): ${noTeam.map((s) => s.name).join(', ')}`)) : null,
    data.teams.length ? h('div', { class: 'list' }, data.teams.map(teamBox)) : h('p', { class: 'empty' }, 'No teams yet.'),
    form);
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

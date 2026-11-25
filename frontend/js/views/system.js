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
  const [rows, teams, more, health] = await Promise.all([
    api.get('/system/settings'), api.get('/system/teams'), api.get('/system/menu-more'), api.get('/system/health')]);
  // The HTTPS group (server address) is drawn inside the HTTPS card instead of its own card.
  const groups = [...new Set(rows.map((r) => r.group))].filter((g) => g !== 'HTTPS');
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
    workerCard(health.worker),
    diskCard(health.disk),
    httpsCard(health.https, rows.filter((r) => r.group === 'HTTPS'), rerender),
    teamsCard(teams, rerender),
    moreCard(more),
    groups.map((g) => h('section', { class: 'card' },
      h('h2', {}, g),
      h('div', { class: 'sys-rows' }, rows.filter((r) => r.group === g).map((r) => settingRow(r, rerender))))));
}

// ---------------------------------------------------------------- background worker

/** The worker's state: when it last reported in, and any problems (workerStatusNotice). */
function workerCard(w) {
  return h('section', { class: 'card' },
    h('h2', {}, 'Background worker'),
    h('p', { class: 'muted small' },
      'The worker does the automatic deletions the privacy notices promise (test drive and rental customers, '
      + 'customer deliveries, private messages), the data retention and the Statens vegvesen sync. '
      + 'If it stops, restart the stack in Portainer and check the worker container’s log.'),
    w.ok ? h('div', { class: 'notice good' }, '✓ Running normally') : workerStatusNotice(w),
    h('dl', { class: 'kv' },
      h('dt', {}, 'Last round'), h('dd', {}, w.loop_at ? fmtDate(w.loop_at) : '–'),
      h('dt', {}, 'Last daily cleanup'), h('dd', {}, w.housekeeping_at
        ? [fmtDate(w.housekeeping_at), w.housekeeping_ok ? '' : h('span', { class: 'badge bad' }, 'failed')] : '–')));
}

const WORKER_STEP = { private_messages: 'Deleting expired private messages', registry_sync: 'Statens vegvesen sync' };

/** Red notice listing the worker's problems (also on Today for system admins). Error types (e.g.
 *  OperationalError) are technical names for the log, not translated. */
export function workerStatusNotice(w, { link = false } = {}) {
  const lines = w.problems.map((p) => {
    switch (p.kind) {
      case 'never': return 'The background worker has not reported in yet. Is the worker container running?';
      case 'stopped': return `The background worker has stopped. Last seen ${fmtDate(p.since)}.`;
      case 'step_failed': return [h('span', {}, 'The background worker’s last round had errors:'),
        p.steps.map((s) => h('div', {}, '• ', h('span', {}, WORKER_STEP[s.step] ?? s.step),
          s.error ? h('span', { class: 'mono small', translate: 'no' }, ` (${s.error})`) : null))];
      case 'cleanup_late': return p.since ? `The daily cleanup has not run since ${fmtDate(p.since)}.` : 'The daily cleanup has not run yet.';
      case 'cleanup_failed': return [h('span', {}, `The daily cleanup failed ${fmtDate(p.at)}.`),
        p.error ? h('span', { class: 'mono small', translate: 'no' }, ` (${p.error})`) : null];
      default: return p.kind;
    }
  });
  return h('div', { class: 'card notice bad' },
    h('strong', {}, '⚠ Background worker'),
    lines.map((t) => h('div', {}, t)),
    h('div', { class: 'small' }, 'Automatic deletions of personal data may be late. Restart the stack in Portainer and check the worker container’s log.'),
    link ? h('a', { href: '#/system' }, 'Open the System page') : null);
}

// ---------------------------------------------------------------- disk space

const gb = (n) => `${String(n).replace('.', ',')} GB`; // Norwegian decimal comma

/** Free space on the server disk that holds the photos and files (diskstatus.py). */
function diskCard(d) {
  const pct = d.free_percent;
  return h('section', { class: 'card' },
    h('h2', {}, 'Disk space'),
    h('p', { class: 'muted small' },
      'Free space on the server disk that holds photos, licence photos, PDI sheets, documents and message files. '
      + 'Amber below 15 % or 10 GB free, red below 5 % or 3 GB.'),
    d.level === 'ok' ? h('div', { class: 'notice good' }, '✓ Enough free space') : diskNotice(d),
    pct != null ? h('div', { class: `disk-bar ${d.level}`, role: 'img', 'aria-label': `${Math.round(100 - pct)} % used` },
      h('span', { style: `width: ${Math.min(100, Math.max(0, 100 - pct))}%` })) : null,
    h('dl', { class: 'kv' },
      h('dt', {}, 'Free'), h('dd', {}, d.free_gb != null ? `${gb(d.free_gb)} (${String(pct).replace('.', ',')} %)` : '–'),
      h('dt', {}, 'Disk size'), h('dd', {}, d.total_gb != null ? gb(d.total_gb) : '–'),
      h('dt', {}, 'Database'), h('dd', {}, d.db_gb != null ? gb(d.db_gb) : '–')));
}

/** Amber / red notice about the disk (also on Today for system admins). */
export function diskNotice(d, { link = false } = {}) {
  const text = d.level === 'unknown' ? 'The free disk space could not be read.'
    : d.level === 'bad' ? `The server disk is almost full: ${gb(d.free_gb)} free.`
      : `The server disk is getting full: ${gb(d.free_gb)} free.`;
  return h('div', { class: `card notice ${d.level === 'bad' ? 'bad' : 'warn'}` },
    h('strong', {}, '💾 Disk space'),
    h('div', {}, text),
    d.level === 'unknown' ? null : h('div', { class: 'small' },
      'When the disk is full, new photos can’t be saved and the database can stop. Free up space on the server or give it a bigger disk.'),
    link ? h('a', { href: '#/system' }, 'Open the System page') : null);
}

// ---------------------------------------------------------------- HTTPS

/** HTTPS through the caddy service: the https address and how each device installs the
 *  local root certificate once (/carbonara-ca.crt). Device steps stay in the device's own words. */
function httpsCard(s, rows, done) {
  const onHttps = location.protocol === 'https:';
  // The server address (setting carbonara_host, 0.39.0): saved in the database so it survives redeploys and
  // each location has its own; the app hands it to the caddy container, which makes the certificate for it.
  const addr = rows.find((r) => r.name === 'carbonara_host');
  const here = location.hostname;
  const saved = addr?.value || '';
  const url = `https://${saved || here}:${s.port}/`;
  const useHere = async () => {
    try {
      await api.put('/system/settings/carbonara_host', { value: here });
      toast('Server address saved', 'success');
      await done();
    } catch (e) { showError(e); }
  };
  const step = (title, ...lines) => h('li', {}, h('strong', {}, title), lines.map((t) => h('div', { class: 'small' }, t)));
  return h('section', { class: 'card' },
    h('h2', {}, 'HTTPS'),
    onHttps ? h('div', { class: 'notice good' }, '✓ This page is open over HTTPS (encrypted).')
      : h('div', { class: 'notice warn' }, 'This page is open over plain HTTP (not encrypted).'),
    h('p', { class: 'muted small' },
      'Carbonara has its own certificate. Install it once on each phone, tablet and PC, then use the https address. '
      + 'Plain HTTP keeps working until every device has moved over.'),
    addr ? h('div', { class: 'sys-rows' }, settingRow(addr, done)) : null,
    addr && !saved && here !== 'localhost' ? h('div', { class: 'notice warn' },
      h('span', {}, 'No server address is saved yet. This page is open at ', h('strong', { class: 'mono', translate: 'no' }, here), '. '),
      h('button', { class: 'btn primary small', type: 'button', onClick: useHere }, `Use ${here}`)) : null,
    h('dl', { class: 'kv' },
      h('dt', {}, 'HTTPS address'), h('dd', {}, h('a', { href: url, class: 'mono', translate: 'no' }, url))),
    s.ca_ready ? null : h('div', { class: 'notice warn' },
      'The certificate is not ready yet. Check that the caddy container is running.'),
    h('ol', { class: 'https-steps' },
      step('1. Download the certificate on the device',
        h('span', {}, s.ca_ready ? h('a', { href: '/carbonara-ca.crt', download: 'carbonara-ca.crt' }, '⬇ carbonara-ca.crt') : '–')),
      step('2. Install it',
        'Android: Settings → Security → Encryption & credentials → Install a certificate → CA certificate → choose the file.',
        // Android 11+ refuses a CA certificate opened from the browser or the file app ("must be installed in
        // Settings"; "from <app>" names the app that opened the file, "null" when it reports no name). Afterwards Android always shows
        // "Network may be monitored" while a user-installed certificate is on the device; that's expected.
        'Android: don\'t tap the downloaded file (Android refuses it there). Go through Settings as above; on Samsung: '
        + 'Settings → Security and privacy → More security settings → Install from device storage → CA certificate. '
        + 'Or search for "CA certificate" in Settings.',
        'Android then shows "Network may be monitored". That is normal for an installed certificate and can be ignored.',
        'iPhone / iPad: open the file in Safari → Settings → Profile Downloaded → Install. Then Settings → General → About → '
        + 'Certificate Trust Settings → turn on "Carbonara Local Root".',
        'Windows (Chrome / Edge / Opera): open the file → Install Certificate → Current User → "Place all certificates in the '
        + 'following store" → Trusted Root Certification Authorities → Finish. Restart the browser.',
        'Firefox has its own list: Settings → Privacy & Security → Certificates → View Certificates → Authorities → Import.'),
      step('3. Open the https address',
        'Bookmark it, and add it to the home screen again if Carbonara is installed as an app. The kiosk tablet stays a kiosk.')));
}

// ---------------------------------------------------------------- teams

// Top menu items a team can be given (server: auth.MENU_ITEMS). Today is always there.
const MENU_LABEL = {
  arrivals: 'Arrivals', vehicles: 'Vehicles', pdi_orders: 'PDI orders', storage: 'Storage', testdrive: 'Test drive', rental: 'Rental cars',
  deliveries: 'Deliveries', customers: 'Customers', work_orders: 'Work orders', planner: 'Planner', parts: 'Parts', settings: 'Settings',
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

/** Top menu → "More": items ticked here leave the menu line and go into a "More" dropdown, for
 *  everyone (each user still sees only their team's items). Nothing ticked = no "More". */
function moreCard(data) {
  const boxes = data.items.map((key) => {
    const box = h('input', { type: 'checkbox', checked: data.more.includes(key) });
    box.addEventListener('change', async () => {
      const chosen = data.items.filter((k, i) => boxes[i].querySelector('input').checked);
      try {
        const res = await api.put('/system/menu-more', { more: chosen });
        data.more = res.more;
        if (session.me) session.me.menu_more = res.more;
        window.dispatchEvent(new Event('carbonara:menu-changed')); // this admin's own menu at once
        toast('Saved', 'success');
      } catch (e) { box.checked = !box.checked; showError(e); }
    });
    return h('label', { class: 'chip' }, box, h('span', {}, key === 'system' ? 'System' : MENU_LABEL[key] ?? key));
  });
  return h('section', { class: 'card' },
    h('h2', {}, 'Top menu'),
    h('p', { class: 'muted small' },
      'Items ticked here are moved into a “More” dropdown at the end of the top menu, for everyone. '
      + 'Each user still sees only their team’s items. With nothing ticked, there is no “More”. '
      + 'A change takes effect the next time a user opens or reloads Carbonara.'),
    h('div', { class: 'small muted' }, 'Show under “More”:'),
    h('div', { class: 'chips' }, boxes));
}

// Readable names for settings stored as short keys (others show the value itself).
const CHOICE_LABEL = { south: 'South and Central Norway', north: 'Nordland, Troms and Finnmark', off: 'Off', on: 'On' };

function settingRow(r, done) {
  let input;
  if (r.choices.length) {
    input = h('select', {}, r.choices.map((c) => h('option', { value: c }, CHOICE_LABEL[c] ?? c)));
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

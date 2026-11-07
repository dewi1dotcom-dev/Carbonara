import { PANEL_LABELS } from '../diagram.js';
import {
  api, busy, debounce, fmtDate, fmtKm, getInspectorId, h, openDialog, photoUrl, pill, showError, STATUS,
  toast, vehicleTitle, viewPhoto,
} from '../ui.js';

export async function vehiclesView(el) {
  const search = h('input', { type: 'search', placeholder: 'Search VIN, make, model, reg. no or spot…' });
  const statusSel = h('select', {}, h('option', { value: '' }, 'All statuses'),
    ['intake', 'in_storage', 'off_site'].map((s) => h('option', { value: s }, STATUS[s])));
  const results = h('div', { class: 'list' });

  async function load() {
    const params = new URLSearchParams();
    if (search.value.trim()) params.set('q', search.value.trim());
    if (statusSel.value) params.set('status', statusSel.value);
    try {
      const rows = await api.get(`/vehicles?${params}`);
      results.replaceChildren(...(rows.length ? rows.map((v) => {
        const eu = euStatus(v.eu_control_due);
        return h('a', { class: 'card list-card', href: `#/vehicles/${v.id}` },
          h('div', { class: 'list-main' },
            h('div', { class: 'list-title' }, vehicleTitle(v), ' ', pill(v.status)),
            h('div', { class: 'vin mono' }, v.vin),
            h('div', { class: 'badges' },
              badge(regStatus(v.registered_marked_at, v.registration_status_code, v.registration_status)),
              eu && eu.cls !== 'good' ? badge(eu, 'EU-kontroll: ') : null)),
          h('div', { class: 'list-meta' },
            [v.registration_number, v.color, v.location_code && `Spot ${v.location_code}`,
              v.eu_control_due && `EU-kontroll ${fmtDate(v.eu_control_due, false)}`].filter(Boolean).join(' · ')));
      }) : [h('p', { class: 'empty' }, 'No vehicles found.')]));
    } catch (e) { showError(e); }
  }
  search.addEventListener('input', debounce(load, 250));
  statusSel.addEventListener('change', load);

  el.append(
    h('div', { class: 'page-head' }, h('h1', {}, 'Vehicles')),
    h('div', { class: 'toolbar' }, search, statusSel),
    results);
  await load();
}

const EVENT_LABELS = {
  vehicle_created: 'Added to the system',
  arrival_inspection_started: 'Arrival inspection started',
  arrival_inspection_completed: 'Arrival inspection completed',
  arrival_inspection_cancelled: 'Arrival inspection cancelled',
  placed_in_storage: 'Placed in storage',
  vehicle_details_updated: 'Details updated',
  marked_registered: 'Marked as registered in Norway',
  registered_mark_removed: '"Registered" mark removed',
  registry_first_sync: 'Data fetched from Statens vegvesen',
  registry_changed: 'Change in Statens vegvesen registry',
};

const FIELD_LABELS = {
  registration_number: 'Reg. no', registration_status: 'Registration status', eu_control_due: 'EU-kontroll due',
  eu_control_last_approved: 'EU-kontroll approved', color: 'Colour', make: 'Make', model: 'Model', fuel_type: 'Fuel',
};
const changeText = (obj) => Object.entries(obj || {})
  .map(([k, [a, b]]) => `${FIELD_LABELS[k] ?? k}: ${a ?? '–'} → ${b ?? '–'}`).join(', ');

function eventDetail(e) {
  const d = e.data || {};
  switch (e.event_type) {
    case 'placed_in_storage': return `Spot ${d.location_code}`;
    case 'arrival_inspection_completed': return `${fmtKm(d.odometer_km)}, ${d.damage_count} damage(s)`;
    case 'vehicle_created':
    case 'arrival_inspection_started': return d.vin_source ? `VIN via ${d.vin_source}` : '';
    case 'vehicle_details_updated': return changeText(d.changes);
    case 'registry_first_sync':
      return [d.registration_number && `Reg. no ${d.registration_number}`,
        d.eu_control_due && `EU-kontroll due ${fmtDate(d.eu_control_due, false)}`,
        changeText(d.vehicle_changes)].filter(Boolean).join(' · ');
    case 'registry_changed':
      return [changeText(d.changes), changeText(d.vehicle_changes)].filter(Boolean).join(' · ');
    default: return '';
  }
}

// ------------------------------------------------------------ registration / Vegvesen

const SYNC_TEXT = {
  pending: 'Waiting for first sync with Statens vegvesen',
  ok: 'Synced with Statens vegvesen',
  not_found: 'Not found in the vehicle registry yet — retried daily',
  error: 'Sync failed — will retry automatically',
};

// ------------------------------------------------------------ status badges

const EU_WARN_DAYS = 60; // amber from this many days before the deadline
const EU_RED_DAYS = 1;   // red from this many days before the deadline
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Whole days from today (local) until an ISO date; negative when passed. */
function daysUntil(iso) {
  if (!iso) return null;
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  const now = new Date();
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())) / 86400000);
}

/** EU-kontroll: red within EU_RED_DAYS or passed, amber within EU_WARN_DAYS, green otherwise. */
function euStatus(due) {
  const days = daysUntil(due);
  if (days == null) return null;
  if (days < 0) return { cls: 'bad', days, text: `Overdue by ${plural(-days, 'day')}` };
  if (days <= EU_RED_DAYS) {
    return { cls: 'bad', days, text: days === 0 ? 'Due today' : days === 1 ? 'Due tomorrow' : `Due in ${days} days` };
  }
  if (days <= EU_WARN_DAYS) return { cls: 'warn', days, text: `Due in ${plural(days, 'day')}` };
  return { cls: 'good', days, text: 'Valid' };
}

/** Registration: amber when not registered, red when Vegvesen says anything
 *  other than registered (deregistered, scrapped…), green when registered. */
function regStatus(markedAt, code, name) {
  if (!markedAt) return { cls: 'warn', text: 'Not registered' };
  if (!code) return { cls: '', text: 'Registered · awaiting data' };
  if (code === 'REGISTRERT') {
    return { cls: 'good', text: name && name !== 'Registrert' ? `Registered (${name})` : 'Registered' };
  }
  return { cls: 'bad', text: name || code };
}

const badge = (st, prefix = '') => st && h('span', { class: `badge ${st.cls}` }, prefix + st.text);

function markDialog(v, done) {
  const staffSel = h('select', { id: 'reg-staff' }, h('option', { value: '' }, 'Loading…'));
  api.get('/staff').then((staff) => {
    staffSel.replaceChildren(h('option', { value: '' }, 'Select…'), staff.map((s) => h('option', { value: s.id }, s.name)));
    if (staff.some((s) => String(s.id) === getInspectorId())) staffSel.value = getInspectorId();
  }).catch(showError);
  const okBtn = h('button', { class: 'btn primary', type: 'submit' }, 'Mark as registered');
  const form = h('form', { class: 'form' },
    h('p', {}, `Confirm that ${vehicleTitle(v)} (${v.vin}) has been registered in Norway.`),
    h('p', { class: 'muted small' },
      'Technical data, registration number and EU-kontroll dates will then be fetched from Statens vegvesen and kept up to date automatically.'),
    h('label', { for: 'reg-staff' }, 'Marked by'), staffSel,
    h('div', { class: 'actions' }, okBtn));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(okBtn, async () => {
      const res = await api.post(`/vehicles/${v.id}/registered`, { staff_id: staffSel.value ? Number(staffSel.value) : null });
      close();
      const st = res.registry?.sync_status;
      if (!res.registry_configured) toast('Marked as registered. Registry sync starts once the API key is configured.');
      else if (st === 'ok') toast('Marked as registered — data fetched from Statens vegvesen', 'success');
      else toast(`Marked as registered. ${SYNC_TEXT[st] ?? ''}`, st === 'error' ? 'error' : 'info');
      done();
    });
  });
  const { close } = openDialog('Registered in Norway', form);
}

async function showRaw(v) {
  try {
    const raw = await api.get(`/vehicles/${v.id}/registry/raw`);
    openDialog('Statens vegvesen data', h('div', {},
      h('p', { class: 'muted small' },
        `Last fetched ${fmtDate(raw.current?.last_success_at)} · ${raw.snapshots.length} distinct version(s) stored`),
      h('pre', { class: 'raw-json' }, raw.current?.data ? JSON.stringify(raw.current.data, null, 2) : 'No data yet.')),
    { wide: true });
  } catch (e) { showError(e); }
}

const kv = (rows) => h('dl', { class: 'kv' },
  rows.filter(([, val]) => val != null && val !== '').map(([k, val]) => [h('dt', {}, k), h('dd', {}, val)]));

/** Top of the vehicle page: the facts staff need at a glance. */
function overviewCard(v, rerender) {
  const r = v.registry || {};
  const reg = regStatus(v.registered_marked_at, r.status_code, r.registration_status);
  const eu = euStatus(r.eu_control_due);
  const loc = v.current_location;

  const alerts = [];
  if (eu?.cls === 'bad') {
    alerts.push(h('div', { class: 'notice bad' }, h('strong', {}, `EU-kontroll ${eu.text.toLowerCase()}. `),
      eu.days < 0
        ? `The deadline was ${fmtDate(r.eu_control_due, false)}. The car must pass EU-kontroll before it is driven on public roads.`
        : `The deadline is ${fmtDate(r.eu_control_due, false)}. Book EU-kontroll now.`));
  }
  if (reg.cls === 'bad') {
    alerts.push(h('div', { class: 'notice bad' }, h('strong', {}, `Registration status: ${reg.text}. `),
      'Statens vegvesen does not list this car as registered.'));
  }

  return h('section', { class: 'card overview' },
    alerts,
    kv([
      ['Registration', h('span', { class: 'inline' },
        v.registration_number ? h('span', { class: 'mono strong' }, v.registration_number) : null,
        badge(reg),
        v.registered_marked_at ? null
          : h('button', { class: 'btn primary small', type: 'button', onClick: () => markDialog(v, rerender) },
            'Mark as registered'))],
      ['EU-kontroll', eu
        ? h('span', { class: 'inline' }, badge(eu), `due ${fmtDate(r.eu_control_due, false)}`)
        : h('span', { class: 'muted' }, v.registered_marked_at ? 'No date from Statens vegvesen yet' : '–')],
      ['Last approved', r.eu_control_last_approved && fmtDate(r.eu_control_last_approved, false)],
      ['Colour', v.color ?? r.color ?? '–'],
      ['VIN location', r.vin_location ?? h('span', { class: 'muted' }, '–')],
      ['Storage spot', loc ? `${loc.code}${loc.zone ? ` (${loc.zone})` : ''} since ${fmtDate(loc.placed_at)}` : '–'],
    ]));
}

/** Everything else, folded away under "All vehicle data". */
function registryCard(v, rerender) {
  const card = h('section', { class: 'card' }, h('h2', {}, 'Statens vegvesen'));
  const r = v.registry || { sync_status: 'pending' };

  if (!v.registered_marked_at) {
    card.append(h('p', { class: 'muted' },
      'Not registered yet. When sales has registered the car, use "Mark as registered" above to fetch its data.'));
  } else {
    if (!v.registry_configured) {
      card.append(h('div', { class: 'notice warn' },
        'The Statens vegvesen API key is not configured on the server, so no data can be fetched yet.'));
    }
    card.append(h('div', { class: `sync-line sync-${r.sync_status}` },
      SYNC_TEXT[r.sync_status] ?? r.sync_status,
      r.last_success_at ? ` · last ${fmtDate(r.last_success_at)}` : '',
      r.sync_status !== 'ok' && r.last_error ? h('span', { class: 'block small' }, r.last_error) : null));
  }

  const fmt = ([label, val, type]) => [label, type === 'date' ? fmtDate(val, false) : val];
  const groups = [
    { title: 'In Carbonara', rows: [
      ['Make / model', [v.make, v.model, v.variant].filter(Boolean).join(' ')],
      ['Model year', v.model_year],
      ['Fuel', v.fuel_type],
      ['In system since', fmtDate(v.created_at)],
      ['Marked as registered', v.registered_marked_at &&
        `${fmtDate(v.registered_marked_at)}${v.registered_marked_by_name ? ` by ${v.registered_marked_by_name}` : ''}`],
    ] },
    ...(v.registry_details || []).map((g) => ({ title: g.title, rows: g.rows.map(fmt) })),
  ];
  card.append(h('details', { class: 'more' },
    h('summary', {}, 'All vehicle data'),
    groups.map((g) => [h('h3', {}, g.title), kv(g.rows)])));

  if (!v.registered_marked_at) return card;

  const syncBtn = h('button', { class: 'btn', type: 'button', disabled: !v.registry_configured }, '↻ Sync now');
  syncBtn.addEventListener('click', () => busy(syncBtn, async () => {
    const res = await api.post(`/vehicles/${v.id}/registry/sync`);
    toast(res.result.status === 'ok' ? 'Synced' : res.result.message, res.result.status === 'ok' ? 'success' : 'error');
    rerender();
  }));
  card.append(h('div', { class: 'actions spread' },
    h('button', {
      class: 'link danger', type: 'button',
      onClick: async () => {
        if (!confirm('Remove the "registered" mark? Registry data already fetched is kept, but syncing stops.')) return;
        try {
          const me = getInspectorId();
          await api.del(`/vehicles/${v.id}/registered${me ? `?staff_id=${me}` : ''}`);
          rerender();
        } catch (e) { showError(e); }
      },
    }, 'Undo mark'),
    h('span', { class: 'row' },
      r.last_success_at && h('button', { class: 'btn', type: 'button', onClick: () => showRaw(v) }, 'Raw data'),
      syncBtn)));
  return card;
}

export async function vehicleView(el, [id]) {
  const v = await api.get(`/vehicles/${id}`);
  const rerender = async () => {
    try {
      const fresh = h('div');
      await vehicleView(fresh, [id]);
      el.replaceChildren(...fresh.childNodes);
    } catch (e) { showError(e); }
  };
  el.append(
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', {}, vehicleTitle(v)), h('div', { class: 'vin mono big' }, v.vin)),
      pill(v.status)),
    overviewCard(v, rerender),
    registryCard(v, rerender),
    h('section', { class: 'card' },
      h('h2', {}, `Known damage (${v.open_damages.length})`),
      v.open_damages.length
        ? h('ul', { class: 'plain' }, v.open_damages.map((d) => h('li', { class: `damage-row sev-${d.severity}` },
          d.photo_id
            ? h('button', { class: 'thumb small', type: 'button', onClick: () => viewPhoto(d.photo_id, 'Damage') },
              h('img', { src: photoUrl(d.photo_id), alt: '' }))
            : null,
          h('span', {}, h('strong', {}, PANEL_LABELS[d.panel] ?? d.panel), ` — ${d.damage_type}, ${d.severity}`,
            d.description ? ` — ${d.description}` : '',
            h('span', { class: 'muted small block' }, `Found ${fmtDate(d.inspected_at, false)}`)))))
        : h('p', { class: 'empty' }, 'No unrepaired damage on record.')),
    h('section', { class: 'card' },
      h('h2', {}, 'Inspections'),
      h('div', { class: 'list' }, v.inspections.map((i) =>
        h('a', { class: 'list-card inner', href: `#/inspections/${i.id}` },
          i.front_photo_id ? h('img', { class: 'mini-thumb', src: photoUrl(i.front_photo_id), alt: '' }) : null,
          h('div', { class: 'list-main' },
            h('div', { class: 'list-title' }, `${i.kind === 'arrival' ? 'Arrival' : i.kind} inspection `, pill(i.status)),
            h('div', { class: 'list-meta' },
              [fmtDate(i.started_at), i.inspector_name, fmtKm(i.odometer_km), `${i.damage_count} damage(s)`]
                .filter(Boolean).join(' · '))))))),
    h('section', { class: 'card' },
      h('h2', {}, 'History'),
      h('ol', { class: 'timeline' }, v.events.map((e) => h('li', {},
        h('div', { class: 'tl-when muted small' }, fmtDate(e.occurred_at)),
        h('div', {}, h('strong', {}, EVENT_LABELS[e.event_type] ?? e.event_type),
          e.staff_name ? ` — ${e.staff_name}` : ''),
        h('div', { class: 'muted small' }, eventDetail(e)))))),
  );
}

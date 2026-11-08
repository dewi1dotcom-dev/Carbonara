import { PANEL_LABELS } from '../diagram.js';
import {
  api, append, badge, busy, CONDITION, serviceStatus, debounce, euStatus, fmtDate, fmtKm, FUEL_TYPES, getInspectorId, h, openDialog, photoUrl, pill,
  regStatus, showError, spotLabel, STATUS,
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
      results.replaceChildren(...(rows.length ? rows.map((v) => vehicleCard(v))
        : [h('p', { class: 'empty' }, 'No vehicles found.')]));
    } catch (e) { showError(e); }
  }
  search.addEventListener('input', debounce(load, 250));
  statusSel.addEventListener('change', load);

  el.append(
    h('div', { class: 'page-head' }, h('h1', {}, 'Vehicles'),
      h('a', { href: '#/vehicles/deleted', class: 'small' }, '🗑 Recently deleted')),
    h('div', { class: 'toolbar' }, search, statusSel),
    results);
  await load();
}

/** One car in a list (vehicle list, storage spot): title, VIN, status badges.
 *  `extra` adds text to the meta line, e.g. "In spot since …". */
export function vehicleCard(v, extra = null) {
  const eu = euStatus(v.eu_control_due);
  const svc = serviceStatus(v.service);
  return h('a', { class: 'card list-card', href: `#/vehicles/${v.id}` },
    h('div', { class: 'list-main' },
      h('div', { class: 'list-title' }, vehicleTitle(v), ' ', pill(v.status)),
      h('div', { class: 'vin mono' }, v.vin),
      h('div', { class: 'badges' },
        badge(regStatus(v.registered_marked_at, v.registration_status_code, v.registration_status)),
        eu && eu.cls !== 'good' ? badge(eu, 'EU-kontroll: ') : null,
        svc && svc.cls !== 'good' ? badge(svc) : null)),
    h('div', { class: 'list-meta' },
      [v.registration_number, v.color, v.location_code && `Spot ${v.location_code}`,
        v.eu_control_due && `EU-kontroll ${fmtDate(v.eu_control_due, false)}`, extra].filter(Boolean).join(' · ')));
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
  registry_changed: 'Updated from Statens vegvesen',
  moved: 'Moved',
  moved_off_site: 'Taken off site',
  damage_repaired: 'Damage repaired',
  damage_repair_undone: '"Repaired" undone',
  registry_mismatch_resolved: 'Checked against Statens vegvesen',
  deleted: 'Deleted',
  restored: 'Restored from Recently deleted',
};

const FIELD_LABELS = {
  registration_number: 'Reg. no', registration_status: 'Registration status', eu_control_due: 'EU-kontroll due',
  eu_control_last_approved: 'EU-kontroll approved', color: 'Colour', make: 'Make', model: 'Model', fuel_type: 'Fuel',
  variant: 'Variant', model_year: 'Model year',
  condition: 'New/used', last_service_date: 'Last service', last_service_km: 'Km at last service',
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
    case 'moved':
      return [d.from ? `${d.from} → ${d.to}` : `To ${d.to}`, d.note].filter(Boolean).join(' — ');
    case 'moved_off_site':
      return [d.from && `From ${d.from}`, d.note].filter(Boolean).join(' — ');
    case 'marked_registered':
      return d.source === 'statens_vegvesen' ? 'Automatically — listed as registered in Statens vegvesen' : '';
    case 'registry_mismatch_resolved':
      return [d.used && Object.keys(d.used).length && `Used Statens vegvesen: ${changeText(d.used)}`,
        d.kept && Object.keys(d.kept).length &&
          `Kept ours: ${Object.entries(d.kept).map(([k, [ours, theirs]]) => `${FIELD_LABELS[k] ?? k} "${ours}" (registry: "${theirs}")`).join(', ')}`,
      ].filter(Boolean).join(' · ');
    case 'damage_repair_undone':
    case 'damage_repaired':
      return [`${PANEL_LABELS[d.panel] ?? d.panel} — ${d.damage_type}, ${d.severity}`, d.note].filter(Boolean).join(' — ');
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


/** Staff picker, preselecting the person last chosen on this device. */
function staffSelect(id) {
  const sel = h('select', { id }, h('option', { value: '' }, 'Loading…'));
  api.get('/staff').then((staff) => {
    // replaceChildren() does not accept arrays, so spread the options.
    sel.replaceChildren(h('option', { value: '' }, 'Select…'), ...staff.map((s) => h('option', { value: s.id }, s.name)));
    if (staff.some((s) => String(s.id) === getInspectorId())) sel.value = getInspectorId();
  }).catch(showError);
  return sel;
}
const staffId = (sel) => (sel.value ? Number(sel.value) : null);

/** Edit vehicle details. Where Statens vegvesen has a different value, it is
 *  shown under the field with a one-tap "use" link. */
function editDialog(v, done) {
  const reg = v.registry_values || {};
  const inputs = {};
  const field = (name, label, input) => {
    input.id = `edit-${name}`;
    inputs[name] = input;
    const regVal = reg[name];
    const hint = regVal ? h('div', { class: 'reg-hint small' }) : null;
    const updateHint = () => {
      if (!hint) return;
      const same = input.value.trim().toLowerCase() === String(regVal).toLowerCase();
      hint.replaceChildren(same ? '✓ Matches Statens vegvesen'
        : h('span', {}, `Statens vegvesen: ${regVal} · `,
          h('button', { class: 'link', type: 'button', onClick: () => { input.value = regVal; updateHint(); } }, 'use')));
      hint.classList.toggle('differs', !same);
    };
    input.addEventListener('input', updateHint);
    updateHint();
    return h('div', { class: 'field' }, h('label', { for: input.id }, label), input, hint);
  };
  const text = (val, attrs = {}) => h('input', { type: 'text', value: val ?? '', ...attrs });

  const okBtn = h('button', { class: 'btn primary', type: 'submit' }, 'Save');
  const form = h('form', { class: 'form' },
    h('div', { class: 'grid' },
      field('make', 'Make', text(v.make)),
      field('model', 'Model', text(v.model)),
      field('variant', 'Variant / trim', text(v.variant)),
      field('model_year', 'Model year', h('input', { type: 'number', inputmode: 'numeric', min: 1900, max: 2100, value: v.model_year ?? '' })),
      field('color', 'Colour', text(v.color)),
      field('fuel_type', 'Fuel type', text(v.fuel_type, { list: 'edit-dl-fuel' })),
      field('registration_number', 'Registration no.', text(v.registration_number, { class: 'mono' })),
      field('condition', 'New or used', (() => {
        const s = h('select', {}, h('option', { value: '' }, '–'),
          Object.entries(CONDITION).map(([k, l]) => h('option', { value: k }, l)));
        s.value = v.condition ?? '';
        return s;
      })()),
      field('last_service_date', 'Last service date',
        h('input', { type: 'date', value: v.last_service_date ?? '', max: new Date().toISOString().slice(0, 10) })),
      field('last_service_km', 'Km at last service', h('input', { type: 'number', inputmode: 'numeric', min: 0, value: v.last_service_km ?? '' }))),
    h('datalist', { id: 'edit-dl-fuel' }, FUEL_TYPES.map((f) => h('option', { value: f }))),
    h('div', { class: 'actions' }, okBtn));

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const changes = {};
    for (const [name, input] of Object.entries(inputs)) {
      let val = input.value.trim() || null;
      if (['model_year', 'last_service_km'].includes(name) && val != null) val = Number(val);
      if (name === 'registration_number' && val) val = val.replace(/[^A-Za-z0-9ÆØÅæøå]/g, '').toUpperCase();
      if (val !== (v[name] ?? null)) changes[name] = val;
    }
    if (!Object.keys(changes).length) { close(); return; }
    busy(okBtn, async () => {
      await api.patch(`/vehicles/${v.id}`, changes);
      close();
      toast('Details saved', 'success');
      done();
    });
  });
  const { close } = openDialog('Edit vehicle details', form);
}

/** Move to another free spot, or take the car off site (workshop, test drive…). */
function moveDialog(v, done) {
  const here = v.current_location;
  const spotSel = h('select', { id: 'move-spot', required: true }, h('option', { value: '' }, 'Loading…'));
  api.get('/storage-locations?available_only=true').then((locs) => {
    const byZone = new Map();
    locs.forEach((l) => byZone.set(l.zone || 'Other', [...(byZone.get(l.zone || 'Other') || []), l]));
    spotSel.replaceChildren(...[ // spread: replaceChildren() does not accept arrays or null
      h('option', { value: '' }, 'Select…'),
      v.status !== 'off_site' ? h('option', { value: 'off' }, 'Off site (workshop, test drive, delivered…)') : null,
      ...[...byZone].map(([zone, list]) => h('optgroup', { label: zone },
        list.map((l) => h('option', { value: l.id }, spotLabel(l))))),
    ].filter(Boolean));
  }).catch(showError);
  const note = h('input', { type: 'text', id: 'move-note', maxlength: 200, placeholder: 'Optional, e.g. "At workshop for paint"' });
  const staffSel = staffSelect('move-staff');
  const okBtn = h('button', { class: 'btn primary', type: 'submit' }, 'Move');

  const form = h('form', { class: 'form' },
    h('p', {}, here ? `Currently at ${here.code}${here.zone ? ` (${here.zone})` : ''}.` : 'Currently off site.'),
    h('label', { for: 'move-spot' }, 'Move to'), spotSel,
    h('label', { for: 'move-note' }, 'Note'), note,
    h('label', { for: 'move-staff' }, 'Moved by'), staffSel,
    h('div', { class: 'actions' }, okBtn));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!spotSel.value) return;
    busy(okBtn, async () => {
      await api.post(`/vehicles/${v.id}/move`, {
        location_id: spotSel.value === 'off' ? null : Number(spotSel.value),
        note: note.value.trim() || null, staff_id: staffId(staffSel),
      });
      close();
      toast(spotSel.value === 'off' ? 'Marked as off site' : 'Moved', 'success');
      done();
    });
  });
  const { close } = openDialog('Move car', form);
}

/** Record a service done while the car is with us: moves "next service" a year on. */
function serviceDialog(v, done) {
  const today = new Date().toISOString().slice(0, 10);
  const date = h('input', { type: 'date', id: 'svc-date', value: today, max: today, required: true });
  const km = h('input', { type: 'number', id: 'svc-km', inputmode: 'numeric', min: 0, placeholder: 'Odometer reading' });
  const okBtn = h('button', { class: 'btn primary', type: 'submit' }, 'Save service');
  const form = h('form', { class: 'form' },
    v.last_service_date ? h('p', { class: 'muted small' },
      `Previous service: ${fmtDate(v.last_service_date, false)}${v.last_service_km != null ? ` at ${fmtKm(v.last_service_km)}` : ''}.`) : null,
    h('label', { for: 'svc-date' }, 'Service date'), date,
    h('label', { for: 'svc-km' }, 'Odometer at service (km)'), km,
    h('div', { class: 'actions' }, okBtn));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(okBtn, async () => {
      await api.patch(`/vehicles/${v.id}`, {
        last_service_date: date.value,
        ...(km.value ? { last_service_km: Number(km.value) } : {}),
        ...(v.condition ? {} : { condition: 'used' }),
      });
      close();
      toast('Service recorded', 'success');
      done();
    });
  });
  const { close } = openDialog('Service done', form);
}

/** Text + badge for the "Service" row. */
function serviceRow(v) {
  const s = v.service || {};
  const st = serviceStatus(s);
  const last = v.last_service_date
    ? `last ${fmtDate(v.last_service_date, false)}${v.last_service_km != null ? ` at ${fmtKm(v.last_service_km)}` : ''}`
    : null;
  if (!st) {
    return h('span', { class: 'muted' },
      v.condition ? s.note || '–' : 'Choose new or used (Edit details) to track service');
  }
  return h('span', { class: 'inline' }, badge(st), `due ${fmtDate(s.due, false)}`,
    last ? h('span', { class: 'muted small' }, `· ${last}`) : null,
    s.basis !== 'last_service' && s.note ? h('span', { class: 'muted small block' }, s.note) : null);
}

async function deleteVehicle(v) {
  const name = [vehicleTitle(v), v.registration_number, v.vin].filter(Boolean).join(' · ');
  if (!confirm(`Delete this car?\n\n${name}\n\nIt moves to "Recently deleted" and can be restored from there. `
    + 'After that period it is removed for good, with its inspections, photos and history.')) return;
  try {
    const me = getInspectorId();
    await api.del(`/vehicles/${v.id}${me ? `?staff_id=${me}` : ''}`);
    toast(`${vehicleTitle(v)} moved to Recently deleted`, 'success');
    location.hash = '#/vehicles';
  } catch (e) { showError(e); }
}

/** Vehicles › Recently deleted: restore, or remove for good. */
export async function deletedView(el) {
  const rows = await api.get('/vehicles-deleted');
  const list = h('div', { class: 'list' });
  const render = (items) => list.replaceChildren(...(items.length ? items.map((v) => {
    const restoreBtn = h('button', { class: 'btn', type: 'button' }, 'Restore');
    restoreBtn.addEventListener('click', () => busy(restoreBtn, async () => {
      const me = getInspectorId();
      const res = await api.post(`/vehicles/${v.id}/restore${me ? `?staff_id=${me}` : ''}`);
      toast(res.current_location ? `Restored to ${res.current_location.code}` : 'Restored (off site — use Move to place it)', 'success');
      location.hash = `#/vehicles/${v.id}`;
    }));
    const purgeBtn = h('button', { class: 'btn danger', type: 'button' }, 'Delete permanently');
    purgeBtn.addEventListener('click', () => {
      if (!confirm(`Delete ${vehicleTitle(v)} (${v.registration_number || v.vin}) permanently?\n\nAll its data and photos are removed now. This cannot be undone.`)) return;
      busy(purgeBtn, async () => {
        await api.del(`/vehicles/${v.id}/permanent`);
        toast('Deleted permanently', 'success');
        render(items.filter((x) => x.id !== v.id));
      });
    });
    return h('div', { class: 'card list-card deleted-card' },
      h('div', { class: 'list-main' },
        h('div', { class: 'list-title' }, vehicleTitle(v), v.registration_number ? h('span', { class: 'mono muted' }, ` ${v.registration_number}`) : null),
        h('div', { class: 'vin mono' }, v.vin),
        h('div', { class: 'muted small' },
          v.deleted_reason === 'retention'
            ? `Deleted automatically ${fmtDate(v.deleted_at, false)} (no activity for the retention period)`
            : `Deleted ${fmtDate(v.deleted_at)}${v.deleted_by_name ? ` by ${v.deleted_by_name}` : ''}`,
          ` · removed for good ${fmtDate(v.purge_at, false)}`)),
      h('div', { class: 'row-actions' }, restoreBtn, purgeBtn));
  }) : [h('p', { class: 'empty' }, 'Nothing here. Deleted cars appear here and can be restored for a while.')]));
  render(rows);
  el.append(
    h('div', { class: 'page-head' },
      h('div', {}, h('a', { href: '#/vehicles', class: 'small' }, '← Vehicles'), h('h1', {}, 'Recently deleted'))),
    list);
}

function repairDialog(d, done) {
  const note = h('textarea', { id: 'repair-note', rows: 3, maxlength: 1000, placeholder: 'Optional, e.g. "Repainted by workshop"' });
  const staffSel = staffSelect('repair-staff');
  const okBtn = h('button', { class: 'btn primary', type: 'submit' }, 'Mark repaired');
  const form = h('form', { class: 'form' },
    h('p', {}, h('strong', {}, PANEL_LABELS[d.panel] ?? d.panel), ` — ${d.damage_type}, ${d.severity}`,
      d.description ? ` — ${d.description}` : ''),
    h('label', { for: 'repair-note' }, 'Repair note'), note,
    h('label', { for: 'repair-staff' }, 'Marked by'), staffSel,
    h('div', { class: 'actions' }, okBtn));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(okBtn, async () => {
      await api.post(`/damages/${d.id}/repaired`, { note: note.value.trim() || null, staff_id: staffId(staffSel) });
      close();
      toast('Damage marked as repaired', 'success');
      done();
    });
  });
  const { close } = openDialog('Damage repaired', form);
}

function markDialog(v, done) {
  const staffSel = staffSelect('reg-staff');
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
      const res = await api.post(`/vehicles/${v.id}/registered`, { staff_id: staffId(staffSel) });
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

/** Prompt shown when Statens vegvesen disagrees with what was typed in. */
function mismatchCard(v, rerender) {
  const list = v.registry_mismatches || [];
  if (!list.length) return null;
  const checks = {};
  const staffSel = staffSelect('mm-staff');
  const useBtn = h('button', { class: 'btn primary', type: 'button' }, 'Use Statens vegvesen');
  const keepBtn = h('button', { class: 'btn', type: 'button' }, 'Keep ours');
  const send = (btn, mode) => {
    const chosen = list.filter((m) => checks[m.field].checked).map((m) => m.field);
    if (!chosen.length) { toast('Tick at least one field', 'error'); return; }
    busy(btn, async () => {
      await api.post(`/vehicles/${v.id}/registry/resolve`, { [mode]: chosen, staff_id: staffId(staffSel) });
      toast(mode === 'use' ? 'Updated from Statens vegvesen' : 'Kept our values', 'success');
      rerender();
    });
  };
  useBtn.addEventListener('click', () => send(useBtn, 'use'));
  keepBtn.addEventListener('click', () => send(keepBtn, 'keep'));

  return h('section', { class: 'card mismatch' },
    h('h2', {}, `Check data: Statens vegvesen differs (${list.length})`),
    h('p', { class: 'muted small' },
      'Tick the fields this applies to and choose which value is right. ',
      '"Keep ours" is remembered until Statens vegvesen changes the value again.'),
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['', 'Field', 'In Carbonara', 'Statens vegvesen'].map((t) => h('th', {}, t)))),
      h('tbody', {}, list.map((m) => {
        const cb = h('input', { type: 'checkbox', id: `mm-${m.field}` });
        cb.checked = true;
        checks[m.field] = cb;
        return h('tr', {},
          h('td', {}, cb),
          h('td', {}, h('label', { for: cb.id }, FIELD_LABELS[m.field] ?? m.field)),
          h('td', { class: 'old' }, m.current ?? '–'),
          h('td', { class: 'strong' }, m.registry));
      })))),
    h('div', { class: 'inline mm-staff' }, h('label', { for: 'mm-staff' }, 'Checked by'), staffSel),
    h('div', { class: 'actions' }, keepBtn, useBtn));
}

function repairedList(v, rerender) {
  const list = v.repaired_damages || [];
  if (!list.length) return null;
  return h('details', { class: 'more' },
    h('summary', {}, `Repaired damage (${list.length})`),
    h('ul', { class: 'plain' }, list.map((d) => h('li', { class: 'damage-row repaired' },
      h('span', { class: 'grow' }, h('strong', {}, PANEL_LABELS[d.panel] ?? d.panel), ` — ${d.damage_type}, ${d.severity}`,
        d.description ? ` — ${d.description}` : '',
        h('span', { class: 'muted small block' },
          `Repaired ${fmtDate(d.repaired_at)}${d.repair_note ? ` — ${d.repair_note}` : ''}`)),
      h('button', {
        class: 'btn small', type: 'button',
        onClick: async () => {
          if (!confirm('Undo "repaired"? The damage will be listed as known damage again.')) return;
          try {
            const me = getInspectorId();
            await api.del(`/damages/${d.id}/repaired${me ? `?staff_id=${me}` : ''}`);
            toast('Repair undone', 'success');
            rerender();
          } catch (e) { showError(e); }
        },
      }, 'Undo')))));
}

/** Top of the vehicle page: the facts staff need at a glance. */
function overviewCard(v, rerender) {
  const r = v.registry || {};
  const reg = regStatus(v.registered_marked_at, r.status_code, r.registration_status);
  const eu = euStatus(r.eu_control_due);

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
      ['Service', serviceRow(v)],
      ['Condition', v.condition ? CONDITION[v.condition] : null],
      ['Colour', v.color ?? r.color ?? '–'],
      ['VIN location', r.vin_location ?? h('span', { class: 'muted' }, '–')],
      ['Storage spot', storageText(v)],
    ]),
    v.status === 'intake' ? null : h('div', { class: 'actions' },
      h('button', { class: 'btn', type: 'button', onClick: () => moveDialog(v, rerender) },
        v.status === 'off_site' ? 'Return to storage' : 'Move'),
      h('button', { class: 'btn', type: 'button', onClick: () => serviceDialog(v, rerender) }, 'Service done'),
      h('button', { class: 'btn', type: 'button', onClick: () => editDialog(v, rerender) }, 'Edit details')));
}

function storageText(v) {
  const loc = v.current_location;
  if (loc) return `${loc.code}${loc.zone ? ` (${loc.zone})` : ''} since ${fmtDate(loc.placed_at)}`;
  if (v.status === 'off_site') {
    const ev = v.events.find((e) => e.event_type === 'moved_off_site');
    return h('span', { class: 'inline' }, h('span', { class: 'badge warn' }, 'Off site'),
      ev ? `${ev.data?.note ? `${ev.data.note} · ` : ''}since ${fmtDate(ev.occurred_at)}` : '');
  }
  return v.status === 'intake' ? 'Placed when the arrival inspection is completed' : '–';
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
  append(el, // mismatchCard() is null when there is nothing to confirm
    h('div', { class: 'page-head' },
      h('div', {},
        h('h1', {}, vehicleTitle(v)),
        // Reg. no in the same size as the title, so it can be read at a glance.
        v.registration_number
          ? h('div', { class: 'reg-big mono' }, v.registration_number)
          : h('div', { class: 'reg-big none' }, 'No reg. no'),
        h('div', { class: 'vin mono big' }, v.vin)),
      pill(v.status)),
    mismatchCard(v, rerender),
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
          h('span', { class: 'grow' }, h('strong', {}, PANEL_LABELS[d.panel] ?? d.panel), ` — ${d.damage_type}, ${d.severity}`,
            d.description ? ` — ${d.description}` : '',
            h('span', { class: 'muted small block' }, `Found ${fmtDate(d.inspected_at, false)}`)),
          h('button', { class: 'btn small', type: 'button', onClick: () => repairDialog(d, rerender) }, '✓ Repaired'))))
        : h('p', { class: 'empty' }, 'No unrepaired damage on record.'),
      repairedList(v, rerender)),
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
    h('div', { class: 'danger-zone' },
      h('button', { class: 'btn danger', type: 'button', onClick: () => deleteVehicle(v) }, '🗑 Delete car')),
  );
}

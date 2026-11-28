// Work orders (0.49.0): a car + the work to perform (free text and / or a list to tick off) + the mechanic's reply +
// labour time (the clock on the order; breaks taken off) + parts (parts orders tied to it). Who worked when is shown to
// admins only. Server: routers/work_orders.py.
import {
  api, append, busy, canOpen, canSee, dateInput, debounce, fmtDate, h, openDialog, osloTodayIso, session, showError, timeInput, toast,
} from '../ui.js';
import { carTitle, orderBadge, pickCustomer } from './customers.js';
import { entryDialog, fmtDuration, fmtLocal } from './hours.js';
import { field, fmtMoney, fmtQty, money2, numInput, parseNum, qtyText } from './parts.js';
import {
  allArrivedButton, customerDiscountNote, discountText, lineDialog, supplyCell, totalDiscountBox,
} from './partsorders.js';
import { lang } from '../i18n.js';
import { workOrderRecallCard } from './recalls.js';

export const WO_STATUS = { open: 'Open', in_progress: 'In progress', done: 'Done', invoiced: 'Invoiced', cancelled: 'Cancelled' };
const WO_CLS = { open: '', in_progress: 'warn', done: 'good', invoiced: '', cancelled: 'bad' };
export const woBadge = (status) => h('span', { class: `badge ${WO_CLS[status] ?? ''}` }, WO_STATUS[status] ?? status);
const ACTIVE = ['open', 'in_progress'];
const clockChanged = () => window.dispatchEvent(new Event('carbonara:clock-changed'));

/** "2,5" → 150 minutes; '' → null; NaN when not a number. */
function parseHours(text) {
  const s = String(text ?? '').trim().replace(',', '.');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 60) : NaN;
}
const hoursText = (minutes) => (minutes ? String(Math.round((minutes / 60) * 100) / 100).replace('.', ',') : '');

const carLine = (o) => [o.registration_number, carTitle(o)].filter(Boolean).join(' · ');

// ---------------------------------------------------------------- #/work-orders

export async function workOrdersView(el) {
  const saved = new URLSearchParams(location.hash.split('?')[1] || '');
  const state = { show: saved.get('show') || 'active', q: saved.get('q') || '' };
  const query = () => new URLSearchParams(Object.entries(state).filter(([k, v]) => v && !(k === 'show' && v === 'active'))).toString();
  const showSel = h('select', { 'aria-label': 'Show' },
    [['active', 'Not done yet'], ['attention', 'Needs a look'], ['done', 'Done'], ['invoiced', 'Invoiced'],
      ['cancelled', 'Cancelled'], ['all', 'All work orders']]
      .map(([v, t]) => h('option', { value: v, selected: v === state.show }, t)));
  const search = h('input', { type: 'search', value: state.q, placeholder: 'Work order no., reg. no., customer, text…', 'aria-label': 'Search work orders' });
  const listSlot = h('div');
  let seq = 0;
  const load = async () => {
    const my = ++seq;
    const q = query();
    if (location.hash.startsWith('#/work-orders')) history.replaceState(null, '', `#/work-orders${q ? `?${q}` : ''}`);
    const data = await api.get(`/work-orders?show=${state.show}&q=${encodeURIComponent(state.q)}`);
    if (my === seq) listSlot.replaceChildren(ordersTable(data));
  };
  const reload = () => load().catch(showError);
  showSel.addEventListener('change', () => { state.show = showSel.value; reload(); });
  search.addEventListener('input', debounce(() => { state.q = search.value.trim(); reload(); }, 300));
  append(el,
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', {}, 'Work orders'),
        h('div', { class: 'muted' }, 'The car, the work to perform, the mechanic’s reply, labour time and parts.')),
      h('div', { class: 'row-actions' },
        h('a', { class: 'btn', href: '#/invoices' }, '🧾 Invoices'),
        h('button', { class: 'btn primary', type: 'button', onClick: () => newWorkOrderDialog() }, '+ New work order'))),
    h('div', { class: 'toolbar' }, search, showSel),
    listSlot);
  await load();
}

function ordersTable(data) {
  const c = data.counts || {};
  const summary = h('p', { class: 'muted small' }, ACTIVE.some((s) => c[s])
    ? ACTIVE.filter((s) => c[s]).map((s, i) => [i ? ' · ' : '', h('span', {}, WO_STATUS[s]), `: ${c[s]}`]) : 'No work orders waiting.');
  if (!data.orders.length) return h('div', {}, summary, h('p', { class: 'empty' }, 'No work orders.'));
  return h('div', {}, summary, workOrderTable(data.orders));
}

// ---------------------------------------------------------------- not forgotten (0.61.0)

export const WAITING = {
  customer: 'Waiting for the customer', car: 'Waiting for the car', approval: 'Waiting for approval',
  parts: 'Waiting for parts', other: 'Waiting', planned: 'Planned',
};

/** Badges under the status (server: work_orders.add_attention): follow-up due, quiet for n days, why it waits,
 *  done but not invoiced. */
export function attentionBadges(o) {
  const b = [];
  if (o.follow_up_due) b.push(h('span', { class: 'badge bad' }, h('span', {}, 'Follow up'), ` ${fmtDate(o.follow_up_on, false)}`));
  else if (o.follow_up_on && ACTIVE.includes(o.status)) b.push(h('span', { class: 'badge' }, h('span', {}, 'Look again'), ` ${fmtDate(o.follow_up_on, false)}`));
  if (o.quiet) b.push(h('span', { class: `badge ${o.quiet}` }, `Quiet ${o.quiet_days} d`));
  if (o.waiting && o.waiting !== 'planned') b.push(h('span', { class: 'badge' }, WAITING[o.waiting] || o.waiting));
  if (o.not_invoiced) b.push(h('span', { class: 'badge warn' }, 'Not invoiced'));
  return b.length ? h('div', { class: 'wo-attention' }, b.map((x, i) => [i ? ' ' : '', x])) : null;
}

/** "Waiting for / Look again on" on the work order page (0.61.0): why it waits and when someone should look at it
 *  again; on that day it is on Today and its creator (+ the people chosen in Settings) get a notification. */
export function followUpCard(o, editable, rerender) {
  const age = Math.max(0, Math.round((Date.now() - new Date(o.created_at).getTime()) / 86400000));
  const facts = h('p', { class: 'small muted' },
    h('span', {}, `Open ${age} d`), ' · ', h('span', {}, `last activity ${fmtDate(o.last_activity)}`),
    o.quiet ? [' ', h('span', { class: `badge ${o.quiet}` }, `Quiet ${o.quiet_days} d`)] : null);
  const auto = !o.waiting_for && o.waiting ? h('span', { class: 'muted small' }, h('span', {}, 'Now:'), ' ', h('span', {}, WAITING[o.waiting])) : null;
  if (!editable) {
    return h('section', { class: 'card follow-up-card no-print' }, facts,
      o.waiting ? h('p', {}, h('span', { class: 'badge' }, WAITING[o.waiting]), o.waiting_note ? h('span', { translate: 'no' }, ` ${o.waiting_note}`) : null) : null,
      o.follow_up_on ? h('p', {}, h('span', {}, 'Look again on'), ` ${fmtDate(o.follow_up_on, false)}`) : null);
  }
  const why = h('select', { 'aria-label': 'Waiting for' },
    h('option', { value: '' }, 'Not waiting / as shown'),
    ['customer', 'car', 'approval', 'parts', 'other'].map((k) => h('option', { value: k, selected: o.waiting_for === k }, WAITING[k])));
  const note = h('input', { type: 'text', maxlength: 200, autocomplete: 'off', value: o.waiting_note || '', placeholder: 'Short note (optional)' });
  const when = dateInput({ value: o.follow_up_on || '' });
  const save = h('button', { class: 'btn primary small', type: 'button' }, 'Save');
  const send = (date = when.value) => busy(save, async () => {
    await api.put(`/work-orders/${o.id}/follow-up`, { waiting_for: why.value || null, waiting_note: note.value.trim() || null, follow_up_on: date || null });
    toast('Saved', 'success');
    await rerender();
  });
  save.addEventListener('click', () => send());
  const inWeeks = (n) => {
    const d = new Date(`${osloTodayIso()}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 7 * n);
    return d.toISOString().slice(0, 10);
  };
  const quick = [1, 2, 4].map((n) => h('button', { class: 'link small', type: 'button', onClick: () => { when.value = inWeeks(n); send(when.value); } },
    n === 1 ? 'In 1 week' : `In ${n} weeks`));
  const clear = o.follow_up_on ? h('button', { class: 'link small danger', type: 'button', onClick: () => { when.value = ''; send(''); } }, 'No date') : null;
  return h('section', { class: `card follow-up-card no-print${o.follow_up_due ? ' due' : ''}` },
    h('div', { class: 'card-head' }, h('h2', {}, 'Waiting and follow-up'), facts),
    h('div', { class: 'grid' },
      h('div', { class: 'field' }, h('label', {}, 'Waiting for'), why, auto),
      h('div', { class: 'field' }, h('label', {}, 'Note'), note),
      h('div', { class: 'field' }, h('label', {}, 'Look again on'), when,
        h('span', { class: 'small' }, quick.map((q, i) => [i ? ' · ' : '', q]), clear ? [' · ', clear] : null))),
    h('div', { class: 'actions left' }, save,
      h('span', { class: 'muted small' }, 'On that day it is on Today, and whoever made the work order gets a notification.')));
}

/** The table of work orders (list page, car pages, customer pages). */
export function workOrderTable(orders) {
  const rows = orders.map((o) => {
    const tr = h('tr', { class: 'click-row', tabindex: '0' },
      h('td', {}, h('a', { href: `#/work-orders/${o.id}` }, `#${o.number}`)),
      h('td', {}, o.registration_number ? h('span', { class: 'mono' }, o.registration_number) : '–',
        h('span', { class: 'muted small block', translate: 'no' }, carTitle(o))),
      h('td', {}, o.customer_name ? h('span', { translate: 'no' }, o.customer_name) : h('span', { class: 'muted' }, '–'),
        o.title ? h('span', { class: 'muted small block', translate: 'no' }, o.title) : null),
      h('td', {}, woBadge(o.status), Number(o.clocks_running) > 0 ? [' ', h('span', { class: 'badge good' }, '⏱')] : null,
        attentionBadges(o)),
      h('td', { class: 'num' }, o.task_count ? `${o.tasks_done}/${o.task_count}` : '–'),
      h('td', { class: 'num' }, o.labour_seconds ? fmtDuration(o.labour_seconds) : '–',
        o.estimated_minutes ? h('span', { class: 'muted small block' }, `estimated ${fmtDuration(o.estimated_minutes * 60)}`) : null),
      h('td', {}, o.planned_local ? fmtLocal(o.planned_local) : '–',
        o.assigned_name ? h('span', { class: 'muted small block', translate: 'no' }, o.assigned_name) : null));
    const go = () => { location.hash = `#/work-orders/${o.id}`; };
    tr.addEventListener('click', (e) => { if (!e.target.closest('a')) go(); });
    tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    return tr;
  });
  return h('div', { class: 'table-wrap' }, h('table', { class: 'price-table parts-table' },
    h('thead', {}, h('tr', {}, h('th', {}, 'No.'), h('th', {}, 'Car'), h('th', {}, 'Customer'), h('th', {}, 'Status'),
      h('th', { class: 'num' }, 'Tasks'), h('th', { class: 'num' }, 'Labour'), h('th', {}, 'Planned'))),
    h('tbody', {}, rows)));
}

/** "Work orders" card for a car page or a customer page (only for teams that see Work orders). */
export async function workOrdersCard(filter, newArgs, { hideEmpty = false } = {}) {
  if (!canSee('work_orders')) return null;
  let data;
  try { data = await api.get(`/work-orders?show=all&${new URLSearchParams(filter)}`); } catch { return null; }
  if (hideEmpty && !data.orders.length) return null;
  return h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, `Work orders (${data.orders.length})`),
      newArgs ? h('button', { class: 'btn small', type: 'button', onClick: () => newWorkOrderDialog(newArgs) }, '+ New work order') : null),
    data.orders.length ? workOrderTable(data.orders.slice(0, 20)) : h('p', { class: 'empty' }, 'No work orders.'));
}

// ---------------------------------------------------------------- parts ready (0.55.1)

/** "Parts arrived and ready" or "Waiting for parts". Since 0.60.0 a work order with parts lines follows them (every line
 *  in stock or arrived = ready); the button to tick it by hand is only there when it has no lines (parts handled
 *  outside Carbonara). */
export function partsReadyBar(o, editable, onChange) {
  const btn = editable && !o.has_parts ? h('button', { class: o.parts_ready_at ? 'link small' : 'btn primary', type: 'button' },
    o.parts_ready_at ? 'Undo' : '✓ Parts arrived and ready') : null;
  btn?.addEventListener('click', () => busy(btn, async () => {
    await api.post(`/work-orders/${o.id}/parts-ready`, { ready: !o.parts_ready_at });
    await onChange();
  }));
  const state = o.parts_ready_at
    ? h('span', {}, h('span', { class: 'badge good' }, '✓ Parts arrived and ready'), ' ',
      h('span', { class: 'muted small' }, fmtDate(o.parts_ready_at)),
      o.parts_ready_by_name ? h('span', { class: 'muted small', translate: 'no' }, ` · ${o.parts_ready_by_name}`) : null)
    : o.has_parts ? h('span', { class: 'badge warn' }, '📦 Waiting for parts')
      : h('span', { class: 'muted small' }, 'No parts on this work order yet.');
  const hint = o.has_parts ? h('span', { class: 'muted small' }, 'Follows the parts below: ready when every part is in stock or has arrived.') : null;
  return h('div', { class: 'parts-ready-bar no-print' }, state, hint, btn);
}

// ---------------------------------------------------------------- job types (0.55.0)

let typesCache = null;
/** The job types (planner colours), cached for the page. */
export async function jobTypes(fresh = false) {
  if (fresh || !typesCache) typesCache = await api.get('/job-types');
  return typesCache;
}
export const jobTypeName = (t) => (t ? (lang === 'no' ? t.name_no || t.name : t.name || t.name_no) : '');
/** "No type" + the active job types (and the chosen one, even when switched off). */
export function jobTypeSelect(selected) {
  const sel = h('select', {}, h('option', { value: '' }, 'No type'));
  jobTypes().then((list) => list.filter((t) => t.active || t.id === selected).forEach((t) =>
    sel.append(h('option', { value: t.id, selected: t.id === selected, translate: 'no' }, jobTypeName(t))))).catch(() => {});
  return sel;
}

// ---------------------------------------------------------------- new work order

let staffCache = null;
async function staffList() {
  staffCache ??= await api.get('/work-orders/staff');
  return staffCache;
}

/** New work order. `car` = { vehicle_id | customer_car_id, text } to skip the car search. */
export async function newWorkOrderDialog(car = null, prefill = {}) {
  let chosen = car;
  const carSlot = h('div');
  const title = h('input', { type: 'text', maxlength: 120, autocomplete: 'off', placeholder: 'e.g. Service, Tyre change, Brakes' });
  const desc = h('textarea', { rows: 4, maxlength: 5000, placeholder: 'What should be done' }, prefill.description || '');
  const tasks = h('textarea', { rows: 4, placeholder: 'One task per line' });
  const est = h('input', { type: 'text', inputmode: 'decimal', autocomplete: 'off', placeholder: 'e.g. 2,5' });
  const pDay = dateInput({ value: prefill.planned ? prefill.planned.slice(0, 10) : '' });
  const pTime = timeInput({ value: prefill.planned ? prefill.planned.slice(11, 16) : '' });
  const who = h('select', {}, h('option', { value: '' }, 'Nobody yet'));
  staffList().then((list) => list.forEach((s) => who.append(h('option', { value: s.id, selected: s.id === prefill.assigned_to, translate: 'no' }, s.name)))).catch(() => {});
  const type = jobTypeSelect(prefill.job_type_id ?? null);
  const ok = h('button', { class: 'btn primary', type: 'submit' }, 'Create work order');

  const drawCar = () => {
    if (chosen) {
      carSlot.replaceChildren(h('div', { class: 'inline' },
        h('strong', { translate: 'no' }, chosen.text),
        car ? null : h('button', { class: 'link small', type: 'button', onClick: () => { chosen = null; drawCar(); } }, 'change')));
      return;
    }
    const q = h('input', { type: 'search', placeholder: 'Reg. no., VIN or the owner’s name…', 'aria-label': 'Find the car', autocomplete: 'off' });
    const res = h('div');
    let seq = 0;
    q.addEventListener('input', debounce(async () => {
      const my = ++seq;
      if (q.value.trim().length < 2) { res.replaceChildren(); return; }
      try {
        const d = await api.get(`/work-orders/cars?q=${encodeURIComponent(q.value.trim())}`);
        if (my !== seq) return;
        const pick = (text, value) => h('li', {}, h('button', {
          class: 'link pick', type: 'button', onClick: () => { chosen = { ...value, text }; drawCar(); },
        }, text));
        res.replaceChildren(...[
          d.customer_cars.length ? h('h4', {}, 'Customer register') : null,
          d.customer_cars.length ? h('ul', { class: 'rows pick-list', translate: 'no' }, d.customer_cars.map((c) => pick(
            [c.registration_number, carTitle(c), c.customer_name].filter(Boolean).join(' · '), { customer_car_id: c.id }))) : null,
          d.vehicles.length ? h('h4', {}, 'Cars in stock (Vehicles)') : null,
          d.vehicles.length ? h('ul', { class: 'rows pick-list', translate: 'no' }, d.vehicles.map((v) => pick(
            [v.registration_number, carTitle(v), v.registration_number ? null : v.vin].filter(Boolean).join(' · '), { vehicle_id: v.id }))) : null,
          !d.customer_cars.length && !d.vehicles.length ? h('p', { class: 'empty' }, 'No cars match. Add the car in the customer register first.') : null,
        ].filter(Boolean));
      } catch (e) { showError(e); }
    }, 250));
    carSlot.replaceChildren(q, res);
    setTimeout(() => q.focus(), 0);
  };
  drawCar();

  const form = h('form', {},
    h('div', { class: 'field' }, h('label', {}, 'Car *'), carSlot),
    h('div', { class: 'grid' }, field('Title', title), field('Job type', type)),
    prefill.place_name ? h('p', { class: 'muted small' }, h('span', {}, 'Place:'), ' ', h('strong', { translate: 'no' }, prefill.place_name)) : null,
    field('Work to perform', desc),
    field('Tasks to tick off', tasks, 'Optional: one per line. The mechanic ticks them off.'),
    h('div', { class: 'grid' }, field('Estimated hours', est), field('Planned date', pDay), field('Planned time', pTime)),
    field('Mechanic', who),
    h('div', { class: 'actions' }, ok));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!chosen) { toast('Choose the car', 'error'); return; }
    const minutes = parseHours(est.value);
    if (Number.isNaN(minutes)) { toast('Check the estimated hours', 'error'); est.focus(); return; }
    busy(ok, async () => {
      const r = await api.post('/work-orders', {
        vehicle_id: chosen.vehicle_id || null, customer_car_id: chosen.customer_car_id || null,
        title: title.value.trim() || null, description: desc.value.trim() || null,
        tasks: tasks.value.split('\n').map((s) => s.trim()).filter(Boolean),
        estimated_minutes: minutes, planned_at: pDay.value ? `${pDay.value}T${pTime.value || '08:00'}` : null,
        assigned_to: who.value ? Number(who.value) : null,
        job_type_id: type.value ? Number(type.value) : null, place_id: prefill.place_id || null,
      });
      close();
      // The make is covered by a recall source: say so (the work order page shows the check at the top).
      if (r.recall_due) toast(`Check for recalls on work order #${r.number}`, prefill.onDone ? 'error' : 'info');
      if (prefill.onDone) await prefill.onDone(r); else location.hash = `#/work-orders/${r.id}`;
    });
  });
  const { close } = openDialog('New work order', form, { wide: true });
}

// ---------------------------------------------------------------- #/work-orders/:id

const EVENT = {
  created: 'Work order created', updated: 'Details changed', tasks: 'Tasks changed', status: 'Status changed',
  parts_order: 'Parts order made', extra_lines: 'Other charges changed', total_discount: 'Total discount changed', invoiced: 'Invoiced', credited: 'Invoice credited',
  arrived: 'Car arrived', not_arrived: 'Not arrived after all', parts_ready: 'Parts arrived and ready', parts_not_ready: 'Parts not ready after all',
  follow_up: 'Waiting and follow-up changed',
  recall_check: 'Checked for recalls', recall_work_order: 'Recalls put on a new work order', recall_from: 'Made from a recall check',
};

function eventDetail(e) {
  const d = e.data || {};
  if (e.kind === 'invoiced') return h('a', { href: `#/invoices/${d.invoice_id}` }, `Invoice no. ${d.number}`);
  if (e.kind === 'arrived' && d.kiosk) return h('span', {}, 'Registered on the delivery kiosk');
  if ((e.kind === 'parts_ready' || e.kind === 'parts_not_ready') && d.auto) return h('span', {}, 'Follows the parts');
  if (e.kind === 'follow_up') {
    return [d.waiting_for ? h('span', {}, WAITING[d.waiting_for] || d.waiting_for) : h('span', {}, 'Not waiting'),
      d.follow_up_on ? [' · ', h('span', {}, 'look again on'), ` ${fmtDate(d.follow_up_on, false)}`] : null];
  }
  if (e.kind === 'credited') {
    return [h('a', { href: `#/invoices/${d.invoice_id}` }, `Invoice no. ${d.number}`), ' → ',
      h('a', { href: `#/invoices/${d.credit_note_id}` }, `Credit note no. ${d.credit_note_number}`)];
  }
  if (e.kind === 'status') return [h('span', {}, WO_STATUS[d.from] ?? d.from), ' → ', h('span', {}, WO_STATUS[d.to] ?? d.to)];
  if (e.kind === 'tasks') return d.added != null ? h('span', {}, `+${d.added}`) : h('span', {}, `${d.done}/${d.count}`);
  if (e.kind === 'recall_check') return h('span', {}, d.result === 'found' ? `Found: ${d.count}` : 'No open recalls');
  if (e.kind === 'recall_work_order' || e.kind === 'recall_from') {
    return h('a', { href: `#/work-orders/${d.work_order_id}` }, `Work order #${d.number}`);
  }
  if (e.kind === 'parts_order') return h('a', { href: `#/parts-orders/${d.order_id}` }, `Parts order #${d.order_no}`);
  if (e.kind === 'updated' && d.estimated_minutes) {
    return [h('span', {}, 'Estimated hours'), `: ${hoursText(d.estimated_minutes.from) || '–'} → ${hoursText(d.estimated_minutes.to) || '–'}`];
  }
  return null;
}

export async function workOrderView(el, [id], host = el) {
  const o = await api.get(`/work-orders/${id}`);
  const rerender = async () => {
    try {
      const fresh = h('div');
      await workOrderView(fresh, [id], host);
      host.replaceChildren(...fresh.childNodes);
    } catch (e) { showError(e); }
  };
  const active = ACTIVE.includes(o.status);
  const editable = !['cancelled', 'invoiced'].includes(o.status);
  const isAdmin = !!session.me?.is_admin;
  const status = (to, label, cls = 'btn', ask = null) => {
    const b = h('button', { class: cls, type: 'button' }, label);
    b.addEventListener('click', () => busy(b, async () => {
      if (ask && !confirm(ask)) return;
      await api.post(`/work-orders/${o.id}/status`, { status: to });
      toast('Saved', 'success');
      clockChanged();
      await rerender();
    }));
    return b;
  };
  const actions = {
    open: [status('done', '✓ Work done', 'btn primary'), status('cancelled', 'Cancel work order', 'link danger', 'Cancel this work order?')],
    in_progress: [status('done', '✓ Work done', 'btn primary'), status('open', 'Back to open', 'link'),
      status('cancelled', 'Cancel work order', 'link danger', 'Cancel this work order?')],
    done: [h('button', { class: 'btn primary', type: 'button', onClick: () => invoiceDialog(o) }, '🧾 Make invoice'),
      status('open', 'Open again', 'link')],
    invoiced: [o.invoice_id ? h('a', { class: 'btn primary', href: `#/invoices/${o.invoice_id}` }, '🧾 Open the invoice') : null].filter(Boolean),
    cancelled: [status('open', 'Open again', 'link')],
  }[o.status] ?? [];

  // The clock: one running per person; starting here stops any other and starts the working day.
  const clockBtn = !active ? null : o.my_clock
    ? h('button', { class: 'btn danger', type: 'button' }, '■ Stop my clock')
    : h('button', { class: 'btn primary', type: 'button' }, '▶ Start my clock');
  clockBtn?.addEventListener('click', () => busy(clockBtn, async () => {
    if (o.my_clock) await api.post('/hours/clock/stop');
    else await api.post(`/work-orders/${o.id}/clock`);
    clockChanged();
    await rerender();
  }));

  const row = (label, value) => (value ? [h('dt', {}, label), h('dd', {}, value)] : null);
  const carHref = o.vehicle_id ? `#/vehicles/${o.vehicle_id}` : o.customer_car_id ? `#/customer-cars/${o.customer_car_id}` : null;
  const carValue = (o.vehicle_id || o.customer_car_id)
    ? h('span', {}, carHref && canOpen(carHref) ? h('a', { href: carHref, translate: 'no' }, carTitle(o)) : h('span', { translate: 'no' }, carTitle(o)),
      ' ', h('span', { class: 'mono' }, o.registration_number || ''), o.vin ? h('span', { class: 'muted small block mono' }, o.vin) : null,
      o.vehicle_id ? h('span', { class: 'muted small block' }, o.vehicle_deleted ? 'Car deleted from Vehicles' : 'Car in stock (Vehicles)') : null)
    : h('span', { class: 'muted' }, 'Car deleted');
  // The customer is the one invoiced: chosen here when the car is from Vehicles (or to bill someone else).
  const chooseCustomer = () => pickCustomer('Customer for the work order', async (c) => {
    try {
      await api.patch(`/work-orders/${o.id}`, { customer_id: c.id });
      toast('Saved', 'success');
      await rerender();
    } catch (e) { showError(e); }
  });
  const custValue = o.customer_id
    ? h('span', {}, canOpen(`#/customers/${o.customer_id}`) ? h('a', { href: `#/customers/${o.customer_id}`, translate: 'no' }, o.customer_name)
      : h('span', { translate: 'no' }, o.customer_name), ' ', h('span', { class: 'muted' }, `(${o.customer_no})`),
    editable ? [' ', h('button', { class: 'link small no-print', type: 'button', onClick: chooseCustomer }, 'change')] : null,
    o.customer_phone ? h('span', { class: 'muted small block', translate: 'no' }, o.customer_phone) : null)
    : editable ? h('button', { class: 'link', type: 'button', onClick: chooseCustomer }, 'Choose the customer') : h('span', { class: 'muted' }, '–');
  // Arrived: set by the kiosk when the customer picks their booked car, or by hand here / in the planner.
  const arrivedBtn = editable ? h('button', { class: 'link small no-print', type: 'button' },
    o.arrived_at ? 'Not arrived after all' : '🔑 The car has arrived') : null;
  arrivedBtn?.addEventListener('click', () => busy(arrivedBtn, async () => {
    await api.post(`/work-orders/${o.id}/arrived`, { arrived: !o.arrived_at });
    await rerender();
  }));
  const arrivedValue = o.arrived_at || editable
    ? h('span', {}, o.arrived_at ? fmtDate(o.arrived_at) : h('span', { class: 'muted' }, 'Not arrived yet'), ' ', arrivedBtn)
    : null;

  append(el,
    h('p', { class: 'small no-print' }, h('a', { href: '#/work-orders' }, '← Work orders')),
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', {}, `Work order #${o.number}`), woBadge(o.status),
        o.title ? h('div', { class: 'muted', translate: 'no' }, o.title) : null),
      h('div', { class: 'row-actions no-print' },
        h('button', { class: 'btn', type: 'button', onClick: () => window.print() }, '🖨 Print'),
        editable ? h('button', { class: 'btn', type: 'button', onClick: () => editDialog(o, rerender) }, 'Edit') : null)),
    actions.length ? h('div', { class: 'actions left no-print' }, actions) : null,
    partsReadyBar(o, editable, rerender),
    ACTIVE.includes(o.status) ? followUpCard(o, editable, rerender) : null,
    o.not_invoiced ? h('div', { class: 'notice warn no-print' }, 'The work is done but not invoiced yet.') : null,
    workOrderRecallCard(o, editable, rerender),
    h('section', { class: 'card clock-card no-print' },
      h('div', { class: 'clock-line' },
        h('div', {},
          h('strong', {}, h('span', {}, 'Labour:'), ` ${fmtDuration(o.labour_seconds)}`),
          o.estimated_minutes ? h('span', { class: 'muted' }, ` (estimated ${fmtDuration(o.estimated_minutes * 60)})`) : null,
          o.estimated_minutes && o.labour_seconds > o.estimated_minutes * 60 ? [' ', h('span', { class: 'badge warn' }, 'Over the estimate')] : null,
          o.expected_done ? h('span', { class: 'block' }, h('span', {}, 'Expected done:'), ` ${fmtLocal(o.expected_done)}`) : null,
          o.my_clock ? h('span', { class: 'block good-text' }, h('span', {}, 'Your clock is running since'), ` ${fmtLocal(o.my_clock, false)}`)
            : Number(o.clocks_running) > 0 ? h('span', { class: 'block muted' }, h('span', {}, 'Clock running'), ` (${o.clocks_running})`) : null),
        clockBtn)),
    h('section', { class: 'card' },
      h('dl', { class: 'kv' },
        row('Car', carValue),
        row('Customer', custValue),
        row('Mileage', o.km != null && `${Number(o.km).toLocaleString('nb-NO')} km`),
        row('Job type', o.job_type_id && h('span', { class: 'inline' },
          h('span', { class: 'pl-swatch', style: `background:${o.job_type_color}` }),
          h('span', { translate: 'no' }, jobTypeName({ name: o.job_type_name, name_no: o.job_type_name_no })))),
        row('Mechanic', o.assigned_name && h('span', { translate: 'no' }, o.assigned_name)),
        row('Place', o.place_name && h('span', { translate: 'no' }, o.place_name)),
        row('Planned', o.planned_local && fmtLocal(o.planned_local)),
        row('Car arrived', arrivedValue),
        row('Estimated hours', o.estimated_minutes && fmtDuration(o.estimated_minutes * 60)),
        row('PDI', o.pdi_order_id && (canOpen('#/pdi-orders') && o.vehicle_id
          ? h('a', { href: `#/pdi-orders?car=${o.vehicle_id}` }, 'Open the PDI order') : h('span', {}, 'PDI order'))),
        row('Created', `${fmtDate(o.created_at)}${o.created_by_name ? ` · ${o.created_by_name}` : ''}`),
        row('Done', o.done_at && `${fmtDate(o.done_at)}${o.done_by_name ? ` · ${o.done_by_name}` : ''}`))),
    h('section', { class: 'card' },
      h('h2', {}, 'Work to perform'),
      o.description ? h('p', { class: 'pre-line', translate: 'no' }, o.description) : null,
      tasksBlock(o, editable),
      !o.description && !o.tasks.length ? h('p', { class: 'empty' }, 'Nothing written yet. Use Edit to describe the work.') : null),
    replyCard(o, editable, rerender),
    isAdmin ? labourCard(o, rerender) : null,
    partsCard(o, editable, rerender),
    billingCard(o, editable, rerender),
    invoicesCard(o),
    h('section', { class: 'card no-print' }, h('h2', {}, 'History'),
      o.events.length ? h('ul', { class: 'rows' }, o.events.map((e) => {
        const detail = eventDetail(e);
        return h('li', {}, h('span', {},
          h('span', {}, EVENT[e.kind] ?? e.kind),
          detail ? h('span', { class: 'block' }, detail) : null,
          h('span', { class: 'muted small block', translate: 'no' }, [fmtDate(e.created_at), e.staff_name].filter(Boolean).join(' · '))));
      })) : h('p', { class: 'empty' }, 'No history yet.')));
  watchRecalls(o, rerender);
}

// The work order page follows a recall check done elsewhere (0.58.2, the user's request): "Check for recalls" opens
// the recall source in another tab, where Sidekick records the result. Coming back to this tab (or every 20 s while a
// check is due) fetches the work order again and redraws it when the recall check or the tasks changed, so the
// warning turns into "Recalls found – create new work order". Never while a dialog is open or a field has focus.
let recallWatch = null; // { id, sig, rerender }
const recallSig = (o) => JSON.stringify([o.recall, (o.tasks || []).length]);

function watchRecalls(o, rerender) {
  recallWatch = o.recall ? { id: o.id, sig: recallSig(o), due: !!o.recall.due, rerender } : null;
  if (watchRecalls.hooked) return;
  watchRecalls.hooked = true;
  let checking = false;
  const check = async () => {
    const w = recallWatch;
    if (!w || checking || document.visibilityState !== 'visible') return;
    if (location.hash.split(/[?/]/)[2] !== String(w.id) || !location.hash.startsWith('#/work-orders/')) { recallWatch = null; return; }
    const el = document.activeElement;
    if (document.querySelector('dialog[open]') || (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
    checking = true;
    try {
      const fresh = await api.get(`/work-orders/${w.id}`);
      if (recallWatch === w && recallSig(fresh) !== w.sig) await w.rerender();
    } catch { /* the next check tries again */ } finally { checking = false; }
  };
  document.addEventListener('visibilitychange', check);
  window.addEventListener('focus', check);
  setInterval(() => { if (recallWatch?.due) check(); }, 20 * 1000);
}

/** The task list: tick off (saved at once), add, remove. */
function tasksBlock(o, editable) {
  const list = o.tasks.map((t) => ({ ...t }));
  const box = h('div', { class: 'task-list' });
  const save = async () => {
    const r = await api.put(`/work-orders/${o.id}/tasks`, { tasks: list.map(({ id, text, done }) => ({ id, text, done })) });
    list.splice(0, list.length, ...r.tasks);
    draw();
  };
  const draw = () => {
    const add = h('input', { type: 'text', maxlength: 300, placeholder: 'Add a task…', autocomplete: 'off' });
    const addBtn = h('button', { class: 'btn small', type: 'button' }, '+ Add');
    const doAdd = () => {
      if (!add.value.trim()) return;
      list.push({ text: add.value.trim(), done: false });
      busy(addBtn, save).catch(showError);
    };
    addBtn.addEventListener('click', doAdd);
    add.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doAdd(); } });
    box.replaceChildren(...[
      list.length ? h('ul', { class: 'tasks' }, list.map((t, i) => {
        const cb = h('input', { type: 'checkbox', checked: !!t.done, disabled: !editable });
        cb.addEventListener('change', async () => {
          t.done = cb.checked;
          try { await save(); } catch (e) { cb.checked = !cb.checked; t.done = cb.checked; showError(e); }
        });
        return h('li', { class: t.done ? 'done' : '' },
          h('label', { class: 'check' }, cb, h('span', { translate: 'no' }, t.text)),
          t.done && t.done_by ? h('span', { class: 'muted small', translate: 'no' }, `${t.done_by} · ${fmtDate(t.done_at)}`) : null,
          editable ? h('button', {
            class: 'link danger small no-print', type: 'button', 'aria-label': 'Remove',
            onClick: async () => {
              if (!confirm('Remove this task?')) return;
              list.splice(i, 1);
              try { await save(); } catch (e) { showError(e); }
            },
          }, '✕') : null);
      })) : null,
      editable ? h('div', { class: 'toolbar no-print' }, add, addBtn) : null,
    ].filter(Boolean));
  };
  draw();
  return box;
}

/** The mechanic's reply: what was done, found, needs doing later. */
function replyCard(o, editable, rerender) {
  const text = h('textarea', { class: 'no-print', rows: 4, maxlength: 5000, placeholder: 'What was done, what was found, what needs doing later' }, o.mechanic_note || '');
  const save = h('button', { class: 'btn', type: 'button' }, 'Save reply');
  save.addEventListener('click', () => busy(save, async () => {
    await api.patch(`/work-orders/${o.id}`, { mechanic_note: text.value.trim() || null });
    toast('Saved', 'success');
    await rerender();
  }));
  return h('section', { class: 'card' },
    h('h2', {}, 'Mechanic’s reply'),
    editable ? [text, h('div', { class: 'actions left no-print' }, save)]
      : (o.mechanic_note ? h('p', { class: 'pre-line', translate: 'no' }, o.mechanic_note) : h('p', { class: 'empty' }, 'No reply.')),
    editable && o.mechanic_note ? h('p', { class: 'pre-line print-only', translate: 'no' }, o.mechanic_note) : null);
}

/** Labour per person (admins only: work hours are for admins). */
function labourCard(o, rerender) {
  const add = h('button', { class: 'btn small', type: 'button' }, '+ Add time');
  add.addEventListener('click', async () => {
    try { entryDialog({ number: o.number }, rerender, { staff: await staffList() }); } catch (e) { showError(e); }
  });
  return h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, 'Labour'), h('span', { class: 'no-print' }, add)),
    o.entries.length ? h('ul', { class: 'rows' }, o.entries.map((t) => h('li', {},
      h('span', {},
        h('span', { translate: 'no' }, t.staff_name || '?'), ' · ', fmtLocal(t.start), '–', t.end ? fmtLocal(t.end, false) : '',
        t.running ? [' ', h('span', { class: 'badge good' }, 'Running')] : null,
        t.note ? h('span', { class: 'muted small block', translate: 'no' }, t.note) : null),
      h('span', { class: 'nowrap' }, fmtDuration(t.seconds), ' ',
        t.running ? null : h('button', {
          class: 'link small no-print', type: 'button', onClick: () => entryDialog({ ...t, number: o.number }, rerender),
        }, 'change')))))
      : h('p', { class: 'empty' }, 'No time on this work order yet.'),
    h('p', { class: 'muted small' }, 'Only administrators see who worked when. Breaks are taken off.'));
}

const OPEN_PARTS = ['open', 'ordered', 'arrived'];

/** Parts, added right here (kept in the work order's parts order: reserved now, out of the stock on the invoice). */
function partsCard(o, editable, rerender) {
  const cd = o.billing?.customer_discount || null;
  // 0.63.0: a line without its own discount gets the customer's parts discount.
  const lines = o.parts_lines.map((l) => ({ ...l, discount_used: l.discount ?? cd?.parts ?? null }));
  const orderId = async () => (await api.post(`/work-orders/${o.id}/parts-order`)).id;
  const target = async (id) => ({ id: id ?? await orderId(), customer_discount: cd });
  const search = h('input', { type: 'search', placeholder: 'Find a part: number or name…', 'aria-label': 'Find a part' });
  const results = h('div');
  let seq = 0;
  search.addEventListener('input', debounce(async () => {
    const q = search.value.trim();
    const my = ++seq;
    if (!q) { results.replaceChildren(); return; }
    try {
      const data = await api.get(`/parts?q=${encodeURIComponent(q)}`);
      if (my !== seq) return;
      results.replaceChildren(data.parts.length ? h('ul', { class: 'rows pick-list' }, data.parts.slice(0, 12).map((p) => h('li', {},
        h('button', {
          class: 'link pick', type: 'button',
          onClick: async () => { try { lineDialog(await target(), { part: p }, rerender); } catch (e) { showError(e); } },
        },
        h('span', { class: 'mono', translate: 'no' }, p.part_number), ' ', h('span', { translate: 'no' }, p.name),
        h('span', { class: 'muted small block' }, h('span', {}, 'In stock:'), ' ', qtyText(p.quantity, p.unit),
          Number(p.reserved) > 0 ? ` (${fmtQty(p.reserved)} reserved)` : '',
          p.location ? [' · ', h('span', { translate: 'no' }, p.location)] : null, ` · ${fmtMoney(p.sale_price)}`)))))
        : h('p', { class: 'empty' }, 'No parts match.'));
    } catch (e) { showError(e); }
  }, 250));
  const free = h('button', { class: 'btn', type: 'button' }, '+ Part not in the store');
  free.addEventListener('click', () => busy(free, async () => lineDialog(await target(), { free: true }, rerender)));
  const rows = lines.map((l) => {
    const canChange = editable && OPEN_PARTS.includes(l.order_status);
    return h('tr', {},
      h('td', {}, h('span', { class: 'mono', translate: 'no' }, l.part_number || '–')),
      h('td', {}, h('span', { translate: 'no' }, l.name),
        l.part_id && l.order_status !== 'done' ? h('span', { class: 'muted small block no-print' },
          l.part_deleted ? h('span', {}, 'Deleted from the parts store')
            : [h('span', {}, 'In stock:'), ' ', qtyText(l.stock, l.unit), l.location ? [' · ', h('span', { translate: 'no' }, l.location)] : null])
          : null),
      h('td', {}, l.order_status === 'done' ? h('span', { class: 'muted small' }, 'Handed out')
        : supplyCell(l.order_id, l, canChange, rerender)),
      h('td', { class: 'num' }, qtyText(l.quantity, l.unit)),
      h('td', { class: 'num' }, fmtMoney(l.unit_price)),
      h('td', { class: 'num' }, discountText(l)),
      h('td', { class: 'no-print nowrap' }, canChange ? [
        h('button', {
          class: 'link small', type: 'button',
          onClick: async () => { try { lineDialog(await target(l.order_id), l, rerender); } catch (e) { showError(e); } },
        }, 'change'), ' ',
        h('button', {
          class: 'link danger small', type: 'button',
          onClick: async () => {
            if (!confirm('Remove this line?')) return;
            try { await api.del(`/parts-orders/${l.order_id}/lines/${l.id}`); await rerender(); } catch (e) { showError(e); }
          },
        }, 'remove')] : null));
  });
  // 0.60.0: the parts are handled here only (the parts order behind them is no longer shown); "All arrived" per order.
  const waitingOrders = editable ? [...new Set(lines.filter((l) => OPEN_PARTS.includes(l.order_status)
    && (l.supply === 'order' || l.supply === 'ordered')).map((l) => l.order_id))] : [];
  return h('section', { class: 'card' },
    h('h2', {}, 'Parts on the work order'),
    waitingOrders.map((id) => allArrivedButton(id, lines.filter((l) => l.order_id === id), rerender)),
    lines.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'price-table parts-table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Part number'), h('th', {}, 'Name'), h('th', {}, 'Supply'), h('th', { class: 'num' }, 'Quantity'),
        h('th', { class: 'num' }, 'Price ex VAT'), h('th', { class: 'num' }, 'Discount'), h('th', { class: 'no-print' }))),
      h('tbody', {}, rows)))
      : h('p', { class: 'empty' }, 'No parts on this work order.'),
    customerDiscountNote(cd),
    editable ? h('div', { class: 'add-line no-print' },
      h('div', { class: 'toolbar' }, search, free), results,
      h('p', { class: 'muted small' }, 'A part is “In stock” when there is enough on the shelf, else “To order”. Set it to Ordered and Arrived as it comes in. The parts leave the stock when the invoice is made.')) : null);
}

/** "2,5" → 150 minutes; "0" → 0; '' → null; NaN when not a number. */
function parseHoursOrZero(text) {
  const s = String(text ?? '').trim().replace(',', '.');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 60) : NaN;
}
const kr = (n) => `${money2(n)} kr`;
const pct = (n) => `${Number(n).toLocaleString('nb-NO', { maximumFractionDigits: 2 })} %`;

/** What will be invoiced: labour (hours × rate), parts, other charges, VAT and the total; "Make invoice". */
function billingCard(o, editable, rerender) {
  const b = o.billing;
  const hours = h('input', { type: 'text', inputmode: 'decimal', autocomplete: 'off', value: hoursText(b.minutes) || '0', disabled: !editable });
  const rate = h('input', { type: 'text', inputmode: 'decimal', autocomplete: 'off', value: String(b.rate).replace('.', ','), disabled: !editable });
  // 0.63.0: the labour discount; empty = the customer's labour discount.
  const custLabour = b.customer_discount?.labour;
  const labourDiscount = numInput(b.own_labour_discount ? b.labour_discount : null, {
    qty: true, disabled: !editable, placeholder: Number(custLabour) > 0 ? `${pct(custLabour)} (customer)` : '0',
  });
  const save = h('button', { class: 'btn', type: 'button' }, 'Save labour');
  save.addEventListener('click', () => busy(save, async () => {
    const minutes = parseHoursOrZero(hours.value);
    const r = parseNum(rate.value);
    const d = parseNum(labourDiscount.value.replace('%', ''));
    if (minutes == null || Number.isNaN(minutes)) { toast('Check the hours', 'error'); hours.focus(); return; }
    if (r == null || Number.isNaN(r) || r < 0) { toast('Check the hourly rate', 'error'); rate.focus(); return; }
    if (Number.isNaN(d) || (d != null && (d < 0 || d > 100))) { toast('Check the discount', 'error'); labourDiscount.focus(); return; }
    await api.patch(`/work-orders/${o.id}`, {
      billed_minutes: minutes === b.suggested_minutes && b.billed_minutes == null ? null : minutes,
      labour_rate: !b.own_rate && r === Number(b.default_rate) ? null : r,
      labour_discount: d,
    });
    toast('Saved', 'success');
    await rerender();
  }));
  const reset = (field, label) => h('button', {
    class: 'link small no-print', type: 'button',
    onClick: async () => { try { await api.patch(`/work-orders/${o.id}`, { [field]: null }); await rerender(); } catch (e) { showError(e); } },
  }, label);

  const hasDiscount = b.lines.some((l) => Number(l.discount) > 0);
  const linesTable = b.lines.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'price-table parts-table' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Description'), h('th', { class: 'num' }, 'Quantity'), h('th', { class: 'num' }, 'Price ex VAT'),
      hasDiscount ? h('th', { class: 'num' }, 'Discount') : null,
      h('th', { class: 'num' }, 'VAT'), h('th', { class: 'num' }, 'Total ex VAT'))),
    h('tbody', {}, b.lines.map((l) => h('tr', {},
      h('td', {}, l.part_number ? [h('span', { class: 'mono', translate: 'no' }, l.part_number), ' '] : null, h('span', { translate: 'no' }, l.text)),
      h('td', { class: 'num nowrap', translate: 'no' }, l.kind === 'discount' ? '' : `${fmtQty(l.quantity)} ${l.unit}`),
      h('td', { class: 'num' }, l.kind === 'discount' ? '' : kr(l.unit_price)),
      hasDiscount ? h('td', { class: 'num' }, Number(l.discount) > 0 ? pct(l.discount) : '') : null,
      h('td', { class: 'num' }, pct(l.vat_rate)),
      h('td', { class: 'num' }, kr(l.total_ex))))))) : h('p', { class: 'empty' }, 'Nothing to invoice yet.');

  return h('section', { class: 'card' },
    h('h2', {}, 'Invoice basis'),
    h('h3', {}, 'Labour'),
    h('p', { class: 'muted small' }, h('span', {}, 'Clocked:'), ` ${fmtDuration(b.clocked_seconds)} · `,
      h('span', {}, 'rounded up to a quarter hour:'), ` ${hoursText(b.suggested_minutes) || '0'} h`),
    h('div', { class: 'grid' },
      field('Hours to invoice', hours, b.billed_minutes != null && editable ? reset('billed_minutes', 'Use the clocked time') : null),
      field('Hourly rate ex VAT (kr)', rate, b.own_rate && editable ? reset('labour_rate', 'Use the rate from the System page') : null),
      field('Labour discount (%)', labourDiscount,
        b.own_labour_discount && editable ? reset('labour_discount', 'Use the customer\'s discount') : null)),
    editable ? h('div', { class: 'actions left no-print' }, save) : null,
    h('h3', {}, 'Other charges'),
    extraLines(o, editable, rerender),
    totalDiscountBox(`/work-orders/${o.id}/total-discount`, b, editable, rerender),
    h('h3', {}, 'On the invoice'),
    linesTable,
    customerDiscountNote(b.customer_discount, { labour: true }),
    h('dl', { class: 'kv order-totals' },
      h('dt', {}, 'Total ex VAT'), h('dd', {}, kr(b.total_ex)),
      ...b.vat_lines.map((v) => [h('dt', {}, `VAT ${pct(v.rate)}`), h('dd', {}, kr(v.vat))]).flat(),
      h('dt', {}, 'Total inc VAT'), h('dd', {}, h('strong', {}, kr(b.total_inc)))),
    !b.vat_registered ? h('p', { class: 'muted small' }, 'Not registered for VAT (System page): no VAT is added.') : null,
    b.missing.length && o.status !== 'invoiced' ? h('div', { class: 'notice warn' }, h('strong', {}, 'Missing before invoicing:'),
      h('ul', {}, b.missing.map((m) => h('li', {}, m)))) : null);
}

/** Other charges (e.g. an environmental fee, consumables): text, quantity, price ex VAT, VAT %. */
function extraLines(o, editable, rerender) {
  const list = (o.extra_lines || []).map((x) => ({ ...x }));
  const save = async () => {
    await api.put(`/work-orders/${o.id}/extra-lines`, { lines: list });
    await rerender();
  };
  const text = h('input', { type: 'text', maxlength: 200, placeholder: 'e.g. Environmental fee', autocomplete: 'off' });
  const qty = h('input', { type: 'text', inputmode: 'decimal', value: '1', 'aria-label': 'Quantity', class: 'num-input' });
  const price = h('input', { type: 'text', inputmode: 'decimal', placeholder: 'kr ex VAT', 'aria-label': 'Price ex VAT', class: 'num-input' });
  const vat = h('input', { type: 'text', inputmode: 'decimal', value: '25', 'aria-label': 'VAT (%)', class: 'num-input' });
  const disc = h('input', { type: 'text', inputmode: 'decimal', placeholder: 'Discount %', 'aria-label': 'Discount (%)', class: 'num-input' });
  const add = h('button', { class: 'btn small', type: 'button' }, '+ Add');
  add.addEventListener('click', () => busy(add, async () => {
    const q = parseNum(qty.value); const p = parseNum(price.value); const v = parseNum(vat.value);
    const d = parseNum(disc.value.replace('%', ''));
    if (!text.value.trim()) { toast('Write what the charge is for', 'error'); text.focus(); return; }
    if (q == null || Number.isNaN(q) || q <= 0) { toast('Enter the quantity', 'error'); qty.focus(); return; }
    if (p == null || Number.isNaN(p) || p < 0) { toast('Check the price', 'error'); price.focus(); return; }
    if (Number.isNaN(d) || (d != null && (d < 0 || d > 100))) { toast('Check the discount', 'error'); disc.focus(); return; }
    list.push({ text: text.value.trim(), quantity: q, unit_price: p, vat_rate: v == null || Number.isNaN(v) ? 25 : v, discount: d || null });
    await save();
  }));
  return h('div', {},
    list.length ? h('ul', { class: 'rows' }, list.map((x, i) => h('li', {},
      h('span', { translate: 'no' }, `${x.text} · ${fmtQty(x.quantity)} × ${kr(x.unit_price)} · ${pct(x.vat_rate)}`,
        Number(x.discount) > 0 ? [' · ', h('span', {}, 'discount'), ` ${pct(x.discount)}`] : null),
      editable ? h('button', {
        class: 'link danger small no-print', type: 'button',
        onClick: async () => { list.splice(i, 1); try { await save(); } catch (e) { showError(e); } },
      }, 'remove') : null))) : h('p', { class: 'empty' }, 'None.'),
    editable ? h('div', { class: 'toolbar extra-line no-print' }, text, qty, price, vat, disc, add) : null);
}

/** Invoices and credit notes of this work order. */
function invoicesCard(o) {
  if (!o.invoices.length) return null;
  return h('section', { class: 'card' }, h('h2', {}, 'Invoices'),
    h('ul', { class: 'rows' }, o.invoices.map((i) => h('li', {},
      h('span', {}, h('a', { href: `#/invoices/${i.id}` }, `${i.kind === 'credit_note' ? 'Credit note' : 'Invoice'} no. ${i.number}`),
        h('span', { class: 'muted small block' }, fmtDate(i.issue_date))),
      h('span', { class: 'nowrap' }, kr(i.total_inc))))));
}

/** Issue the invoice: final, can't be changed or deleted afterwards (a credit note corrects it). */
function invoiceDialog(o) {
  const b = o.billing;
  const note = h('textarea', { rows: 2, maxlength: 1000, placeholder: 'Printed on the invoice (optional)' });
  const ok = h('button', { class: 'btn primary', type: 'submit', disabled: b.missing.length > 0 }, 'Issue invoice');
  const form = h('form', {},
    h('dl', { class: 'kv' },
      h('dt', {}, 'Customer'), h('dd', { translate: 'no' }, o.customer_name ? `${o.customer_name} (${o.customer_no})` : '–'),
      h('dt', {}, 'Total inc VAT'), h('dd', {}, h('strong', {}, kr(b.total_inc)))),
    b.missing.length ? h('div', { class: 'notice warn' }, h('strong', {}, 'Missing before invoicing:'),
      h('ul', {}, b.missing.map((m) => h('li', {}, m)))) : null,
    h('div', { class: 'notice' }, 'An issued invoice can never be changed or deleted. A mistake is corrected with a credit note. '
      + 'The parts are taken out of the stock now.'),
    field('Note on the invoice', note),
    h('div', { class: 'actions' }, ok));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(ok, async () => {
      const r = await api.post(`/work-orders/${o.id}/invoice`, { note: note.value.trim() || null });
      close();
      toast(`Invoice no. ${r.number} issued`, 'success');
      location.hash = `#/invoices/${r.id}`;
    });
  });
  const { close } = openDialog(`Invoice for work order #${o.number}`, form);
}

/** Edit title, work to perform, estimate, planned start and mechanic. */
async function editDialog(o, done) {
  const title = h('input', { type: 'text', maxlength: 120, autocomplete: 'off', value: o.title || '' });
  const desc = h('textarea', { rows: 6, maxlength: 5000 }, o.description || '');
  const est = h('input', { type: 'text', inputmode: 'decimal', autocomplete: 'off', value: hoursText(o.estimated_minutes) });
  const pDay = dateInput({ value: o.planned_local ? o.planned_local.slice(0, 10) : '' });
  const pTime = timeInput({ value: o.planned_local ? o.planned_local.slice(11, 16) : '' });
  const km = h('input', { type: 'text', inputmode: 'numeric', autocomplete: 'off', value: o.km ?? '' });
  const who = h('select', {}, h('option', { value: '' }, 'Nobody yet'));
  try {
    (await staffList()).forEach((s) => who.append(h('option', { value: s.id, selected: s.id === o.assigned_to, translate: 'no' }, s.name)));
  } catch (e) { showError(e); }
  const type = jobTypeSelect(o.job_type_id);
  const ok = h('button', { class: 'btn primary', type: 'submit' }, 'Save');
  const form = h('form', {},
    h('div', { class: 'grid' }, field('Title', title), field('Job type', type)),
    field('Work to perform', desc),
    h('div', { class: 'grid' }, field('Estimated hours', est), field('Planned date', pDay), field('Planned time', pTime)),
    h('div', { class: 'grid' }, field('Mechanic', who), field('Mileage (km)', km)),
    h('div', { class: 'actions' }, ok));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const minutes = parseHours(est.value);
    if (Number.isNaN(minutes)) { toast('Check the estimated hours', 'error'); est.focus(); return; }
    const kmDigits = km.value.replace(/\D/g, '');
    const kmVal = kmDigits ? Number(kmDigits) : null;
    busy(ok, async () => {
      await api.patch(`/work-orders/${o.id}`, {
        title: title.value.trim() || null, description: desc.value.trim() || null, estimated_minutes: minutes,
        planned_at: pDay.value ? `${pDay.value}T${pTime.value || '08:00'}` : null,
        assigned_to: who.value ? Number(who.value) : null, km: kmVal, job_type_id: type.value ? Number(type.value) : null,
      });
      close();
      toast('Saved', 'success');
      await done();
    });
  });
  const { close } = openDialog(`Work order #${o.number}`, form, { wide: true });
}

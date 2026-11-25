// Work orders (0.49.0): a car + the work to perform (free text and / or a list to tick off) + the mechanic's reply +
// labour time (the clock on the order; breaks taken off) + parts (parts orders tied to it). Who worked when is shown to
// admins only. Server: routers/work_orders.py.
import { api, append, busy, canOpen, canSee, dateInput, debounce, fmtDate, h, openDialog, session, showError, timeInput, toast } from '../ui.js';
import { carTitle, orderBadge } from './customers.js';
import { entryDialog, fmtDuration, fmtLocal } from './hours.js';
import { field, fmtMoney, qtyText } from './parts.js';

export const WO_STATUS = { open: 'Open', in_progress: 'In progress', done: 'Done', cancelled: 'Cancelled' };
const WO_CLS = { open: '', in_progress: 'warn', done: 'good', cancelled: 'bad' };
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
    [['active', 'Not done yet'], ['done', 'Done'], ['cancelled', 'Cancelled'], ['all', 'All work orders']]
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
      h('button', { class: 'btn primary', type: 'button', onClick: () => newWorkOrderDialog() }, '+ New work order')),
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

/** The table of work orders (list page, car pages, customer pages). */
export function workOrderTable(orders) {
  const rows = orders.map((o) => {
    const tr = h('tr', { class: 'click-row', tabindex: '0' },
      h('td', {}, h('a', { href: `#/work-orders/${o.id}` }, `#${o.number}`)),
      h('td', {}, o.registration_number ? h('span', { class: 'mono' }, o.registration_number) : '–',
        h('span', { class: 'muted small block', translate: 'no' }, carTitle(o))),
      h('td', {}, o.customer_name ? h('span', { translate: 'no' }, o.customer_name) : h('span', { class: 'muted' }, '–'),
        o.title ? h('span', { class: 'muted small block', translate: 'no' }, o.title) : null),
      h('td', {}, woBadge(o.status), Number(o.clocks_running) > 0 ? [' ', h('span', { class: 'badge good' }, '⏱')] : null),
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

// ---------------------------------------------------------------- new work order

let staffCache = null;
async function staffList() {
  staffCache ??= await api.get('/work-orders/staff');
  return staffCache;
}

/** New work order. `car` = { vehicle_id | customer_car_id, text } to skip the car search. */
export async function newWorkOrderDialog(car = null) {
  let chosen = car;
  const carSlot = h('div');
  const title = h('input', { type: 'text', maxlength: 120, autocomplete: 'off', placeholder: 'e.g. Service, Tyre change, Brakes' });
  const desc = h('textarea', { rows: 4, maxlength: 5000, placeholder: 'What should be done' });
  const tasks = h('textarea', { rows: 4, placeholder: 'One task per line' });
  const est = h('input', { type: 'text', inputmode: 'decimal', autocomplete: 'off', placeholder: 'e.g. 2,5' });
  const pDay = dateInput({});
  const pTime = timeInput({});
  const who = h('select', {}, h('option', { value: '' }, 'Nobody yet'));
  staffList().then((list) => list.forEach((s) => who.append(h('option', { value: s.id, translate: 'no' }, s.name)))).catch(() => {});
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
    field('Title', title),
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
      });
      close();
      location.hash = `#/work-orders/${r.id}`;
    });
  });
  const { close } = openDialog('New work order', form, { wide: true });
}

// ---------------------------------------------------------------- #/work-orders/:id

const EVENT = {
  created: 'Work order created', updated: 'Details changed', tasks: 'Tasks changed', status: 'Status changed',
  parts_order: 'Parts order made',
};

function eventDetail(e) {
  const d = e.data || {};
  if (e.kind === 'status') return [h('span', {}, WO_STATUS[d.from] ?? d.from), ' → ', h('span', {}, WO_STATUS[d.to] ?? d.to)];
  if (e.kind === 'tasks') return h('span', {}, `${d.done}/${d.count}`);
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
  const editable = o.status !== 'cancelled';
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
    done: [status('open', 'Open again', 'link')],
    cancelled: [status('open', 'Open again', 'link')],
  }[o.status];

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
  const custValue = o.customer_id
    ? h('span', {}, canOpen(`#/customers/${o.customer_id}`) ? h('a', { href: `#/customers/${o.customer_id}`, translate: 'no' }, o.customer_name)
      : h('span', { translate: 'no' }, o.customer_name), ' ', h('span', { class: 'muted' }, `(${o.customer_no})`),
    o.customer_phone ? h('span', { class: 'muted small block', translate: 'no' }, o.customer_phone) : null)
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
        row('Mechanic', o.assigned_name && h('span', { translate: 'no' }, o.assigned_name)),
        row('Planned', o.planned_local && fmtLocal(o.planned_local)),
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
    partsCard(o, rerender),
    h('section', { class: 'card no-print' }, h('h2', {}, 'History'),
      o.events.length ? h('ul', { class: 'rows' }, o.events.map((e) => {
        const detail = eventDetail(e);
        return h('li', {}, h('span', {},
          h('span', {}, EVENT[e.kind] ?? e.kind),
          detail ? h('span', { class: 'block' }, detail) : null,
          h('span', { class: 'muted small block', translate: 'no' }, [fmtDate(e.created_at), e.staff_name].filter(Boolean).join(' · '))));
      })) : h('p', { class: 'empty' }, 'No history yet.')));
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

/** Parts: the lines of the parts orders tied to this work order. */
function partsCard(o, rerender) {
  const editParts = !!session.me?.is_admin || canSee('parts');
  const add = editParts && o.status !== 'cancelled' ? h('button', { class: 'btn small', type: 'button' }, '+ Add parts') : null;
  add?.addEventListener('click', () => busy(add, async () => {
    const r = await api.post(`/work-orders/${o.id}/parts-order`);
    location.hash = `#/parts-orders/${r.id}`;
  }));
  const lines = o.parts_lines;
  return h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, 'Parts on the work order'), add ? h('span', { class: 'no-print' }, add) : null),
    lines.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'price-table parts-table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Part number'), h('th', {}, 'Name'), h('th', { class: 'num' }, 'Quantity'),
        h('th', { class: 'num' }, 'Price ex VAT'))),
      h('tbody', {}, lines.map((l) => h('tr', {},
        h('td', {}, h('span', { class: 'mono', translate: 'no' }, l.part_number || '–')),
        h('td', {}, h('span', { translate: 'no' }, l.name)),
        h('td', { class: 'num' }, qtyText(l.quantity, l.unit)),
        h('td', { class: 'num' }, fmtMoney(l.unit_price)))))))
      : h('p', { class: 'empty' }, 'No parts on this work order.'),
    lines.length ? h('p', {}, h('span', {}, 'Parts total ex VAT:'), ' ', h('strong', {}, fmtMoney(o.parts_total_ex))) : null,
    o.parts_orders.length ? h('ul', { class: 'rows no-print' }, o.parts_orders.map((p) => h('li', {},
      h('span', {}, canOpen('#/parts-orders') ? h('a', { href: `#/parts-orders/${p.id}` }, `Parts order #${p.order_no}`)
        : h('span', {}, `Parts order #${p.order_no}`), ' ', orderBadge(p.status)),
      h('span', { class: 'nowrap' }, fmtMoney(p.total_inc))))) : null);
}

/** Edit title, work to perform, estimate, planned start and mechanic. */
async function editDialog(o, done) {
  const title = h('input', { type: 'text', maxlength: 120, autocomplete: 'off', value: o.title || '' });
  const desc = h('textarea', { rows: 6, maxlength: 5000 }, o.description || '');
  const est = h('input', { type: 'text', inputmode: 'decimal', autocomplete: 'off', value: hoursText(o.estimated_minutes) });
  const pDay = dateInput({ value: o.planned_local ? o.planned_local.slice(0, 10) : '' });
  const pTime = timeInput({ value: o.planned_local ? o.planned_local.slice(11, 16) : '' });
  const who = h('select', {}, h('option', { value: '' }, 'Nobody yet'));
  try {
    (await staffList()).forEach((s) => who.append(h('option', { value: s.id, selected: s.id === o.assigned_to, translate: 'no' }, s.name)));
  } catch (e) { showError(e); }
  const ok = h('button', { class: 'btn primary', type: 'submit' }, 'Save');
  const form = h('form', {},
    field('Title', title),
    field('Work to perform', desc),
    h('div', { class: 'grid' }, field('Estimated hours', est), field('Planned date', pDay), field('Planned time', pTime)),
    field('Mechanic', who),
    h('div', { class: 'actions' }, ok));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const minutes = parseHours(est.value);
    if (Number.isNaN(minutes)) { toast('Check the estimated hours', 'error'); est.focus(); return; }
    busy(ok, async () => {
      await api.patch(`/work-orders/${o.id}`, {
        title: title.value.trim() || null, description: desc.value.trim() || null, estimated_minutes: minutes,
        planned_at: pDay.value ? `${pDay.value}T${pTime.value || '08:00'}` : null,
        assigned_to: who.value ? Number(who.value) : null,
      });
      close();
      toast('Saved', 'success');
      await done();
    });
  });
  const { close } = openDialog(`Work order #${o.number}`, form, { wide: true });
}

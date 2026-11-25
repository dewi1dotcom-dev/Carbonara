// Work orders (0.49.0): a car + the work to perform (free text and / or a list to tick off) + the mechanic's reply +
// labour time (the clock on the order; breaks taken off) + parts (parts orders tied to it). Who worked when is shown to
// admins only. Server: routers/work_orders.py.
import { api, append, busy, canOpen, canSee, dateInput, debounce, fmtDate, h, openDialog, session, showError, timeInput, toast } from '../ui.js';
import { carTitle, orderBadge, pickCustomer } from './customers.js';
import { entryDialog, fmtDuration, fmtLocal } from './hours.js';
import { field, fmtMoney, fmtQty, money2, parseNum, qtyText } from './parts.js';
import { lineDialog } from './partsorders.js';

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
    [['active', 'Not done yet'], ['done', 'Done'], ['invoiced', 'Invoiced'], ['cancelled', 'Cancelled'], ['all', 'All work orders']]
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
export async function newWorkOrderDialog(car = null, prefill = {}) {
  let chosen = car;
  const carSlot = h('div');
  const title = h('input', { type: 'text', maxlength: 120, autocomplete: 'off', placeholder: 'e.g. Service, Tyre change, Brakes' });
  const desc = h('textarea', { rows: 4, maxlength: 5000, placeholder: 'What should be done' });
  const tasks = h('textarea', { rows: 4, placeholder: 'One task per line' });
  const est = h('input', { type: 'text', inputmode: 'decimal', autocomplete: 'off', placeholder: 'e.g. 2,5' });
  const pDay = dateInput({ value: prefill.planned ? prefill.planned.slice(0, 10) : '' });
  const pTime = timeInput({ value: prefill.planned ? prefill.planned.slice(11, 16) : '' });
  const who = h('select', {}, h('option', { value: '' }, 'Nobody yet'));
  staffList().then((list) => list.forEach((s) => who.append(h('option', { value: s.id, selected: s.id === prefill.assigned_to, translate: 'no' }, s.name)))).catch(() => {});
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
      if (prefill.onDone) await prefill.onDone(r); else location.hash = `#/work-orders/${r.id}`;
    });
  });
  const { close } = openDialog('New work order', form, { wide: true });
}

// ---------------------------------------------------------------- #/work-orders/:id

const EVENT = {
  created: 'Work order created', updated: 'Details changed', tasks: 'Tasks changed', status: 'Status changed',
  parts_order: 'Parts order made', extra_lines: 'Other charges changed', invoiced: 'Invoiced', credited: 'Invoice credited',
};

function eventDetail(e) {
  const d = e.data || {};
  if (e.kind === 'invoiced') return h('a', { href: `#/invoices/${d.invoice_id}` }, `Invoice no. ${d.number}`);
  if (e.kind === 'credited') {
    return [h('a', { href: `#/invoices/${d.invoice_id}` }, `Invoice no. ${d.number}`), ' → ',
      h('a', { href: `#/invoices/${d.credit_note_id}` }, `Credit note no. ${d.credit_note_number}`)];
  }
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
        row('Mileage', o.km != null && `${Number(o.km).toLocaleString('nb-NO')} km`),
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
  const lines = o.parts_lines;
  const orderId = async () => (await api.post(`/work-orders/${o.id}/parts-order`)).id;
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
          onClick: async () => { try { lineDialog({ id: await orderId() }, { part: p }, rerender); } catch (e) { showError(e); } },
        },
        h('span', { class: 'mono', translate: 'no' }, p.part_number), ' ', h('span', { translate: 'no' }, p.name),
        h('span', { class: 'muted small block' }, h('span', {}, 'In stock:'), ' ', qtyText(p.quantity, p.unit),
          Number(p.reserved) > 0 ? ` (${fmtQty(p.reserved)} reserved)` : '',
          p.location ? [' · ', h('span', { translate: 'no' }, p.location)] : null, ` · ${fmtMoney(p.sale_price)}`)))))
        : h('p', { class: 'empty' }, 'No parts match.'));
    } catch (e) { showError(e); }
  }, 250));
  const free = h('button', { class: 'btn', type: 'button' }, '+ Part not in the store');
  free.addEventListener('click', () => busy(free, async () => lineDialog({ id: await orderId() }, { free: true }, rerender)));
  const rows = lines.map((l) => {
    const canChange = editable && OPEN_PARTS.includes(l.order_status);
    return h('tr', {},
      h('td', {}, h('span', { class: 'mono', translate: 'no' }, l.part_number || '–')),
      h('td', {}, h('span', { translate: 'no' }, l.name),
        l.part_id && l.order_status !== 'done' ? h('span', { class: 'muted small block no-print' },
          l.part_deleted ? h('span', {}, 'Deleted from the parts store')
            : [h('span', {}, 'In stock:'), ' ', qtyText(l.stock, l.unit), l.location ? [' · ', h('span', { translate: 'no' }, l.location)] : null])
          : null),
      h('td', { class: 'num' }, qtyText(l.quantity, l.unit)),
      h('td', { class: 'num' }, fmtMoney(l.unit_price)),
      h('td', { class: 'no-print nowrap' }, canChange ? [
        h('button', { class: 'link small', type: 'button', onClick: () => lineDialog({ id: l.order_id }, l, rerender) }, 'change'), ' ',
        h('button', {
          class: 'link danger small', type: 'button',
          onClick: async () => {
            if (!confirm('Remove this line?')) return;
            try { await api.del(`/parts-orders/${l.order_id}/lines/${l.id}`); await rerender(); } catch (e) { showError(e); }
          },
        }, 'remove')] : null));
  });
  return h('section', { class: 'card' },
    h('h2', {}, 'Parts on the work order'),
    lines.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'price-table parts-table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Part number'), h('th', {}, 'Name'), h('th', { class: 'num' }, 'Quantity'),
        h('th', { class: 'num' }, 'Price ex VAT'), h('th', { class: 'no-print' }))),
      h('tbody', {}, rows)))
      : h('p', { class: 'empty' }, 'No parts on this work order.'),
    editable ? h('div', { class: 'add-line no-print' },
      h('div', { class: 'toolbar' }, search, free), results,
      h('p', { class: 'muted small' }, 'The parts are reserved now and taken out of the stock when the invoice is made.')) : null,
    o.parts_orders.length && canOpen('#/parts-orders') ? h('p', { class: 'muted small no-print' },
      o.parts_orders.map((p, i) => [i ? ' · ' : '', h('a', { href: `#/parts-orders/${p.id}` }, `Parts order #${p.order_no}`), ' ', orderBadge(p.status)])) : null);
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
  const save = h('button', { class: 'btn', type: 'button' }, 'Save labour');
  save.addEventListener('click', () => busy(save, async () => {
    const minutes = parseHoursOrZero(hours.value);
    const r = parseNum(rate.value);
    if (minutes == null || Number.isNaN(minutes)) { toast('Check the hours', 'error'); hours.focus(); return; }
    if (r == null || Number.isNaN(r) || r < 0) { toast('Check the hourly rate', 'error'); rate.focus(); return; }
    await api.patch(`/work-orders/${o.id}`, {
      billed_minutes: minutes === b.suggested_minutes && b.billed_minutes == null ? null : minutes,
      labour_rate: !b.own_rate && r === Number(b.default_rate) ? null : r,
    });
    toast('Saved', 'success');
    await rerender();
  }));
  const reset = (field, label) => h('button', {
    class: 'link small no-print', type: 'button',
    onClick: async () => { try { await api.patch(`/work-orders/${o.id}`, { [field]: null }); await rerender(); } catch (e) { showError(e); } },
  }, label);

  const linesTable = b.lines.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'price-table parts-table' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Description'), h('th', { class: 'num' }, 'Quantity'), h('th', { class: 'num' }, 'Price ex VAT'),
      h('th', { class: 'num' }, 'VAT'), h('th', { class: 'num' }, 'Total ex VAT'))),
    h('tbody', {}, b.lines.map((l) => h('tr', {},
      h('td', {}, l.part_number ? [h('span', { class: 'mono', translate: 'no' }, l.part_number), ' '] : null, h('span', { translate: 'no' }, l.text)),
      h('td', { class: 'num nowrap', translate: 'no' }, `${fmtQty(l.quantity)} ${l.unit}`),
      h('td', { class: 'num' }, kr(l.unit_price)),
      h('td', { class: 'num' }, pct(l.vat_rate)),
      h('td', { class: 'num' }, kr(l.total_ex))))))) : h('p', { class: 'empty' }, 'Nothing to invoice yet.');

  return h('section', { class: 'card' },
    h('h2', {}, 'Invoice basis'),
    h('h3', {}, 'Labour'),
    h('p', { class: 'muted small' }, h('span', {}, 'Clocked:'), ` ${fmtDuration(b.clocked_seconds)} · `,
      h('span', {}, 'rounded up to a quarter hour:'), ` ${hoursText(b.suggested_minutes) || '0'} h`),
    h('div', { class: 'grid' },
      field('Hours to invoice', hours, b.billed_minutes != null && editable ? reset('billed_minutes', 'Use the clocked time') : null),
      field('Hourly rate ex VAT (kr)', rate, b.own_rate && editable ? reset('labour_rate', 'Use the rate from the System page') : null)),
    editable ? h('div', { class: 'actions left no-print' }, save) : null,
    h('h3', {}, 'Other charges'),
    extraLines(o, editable, rerender),
    h('h3', {}, 'On the invoice'),
    linesTable,
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
  const add = h('button', { class: 'btn small', type: 'button' }, '+ Add');
  add.addEventListener('click', () => busy(add, async () => {
    const q = parseNum(qty.value); const p = parseNum(price.value); const v = parseNum(vat.value);
    if (!text.value.trim()) { toast('Write what the charge is for', 'error'); text.focus(); return; }
    if (q == null || Number.isNaN(q) || q <= 0) { toast('Enter the quantity', 'error'); qty.focus(); return; }
    if (p == null || Number.isNaN(p) || p < 0) { toast('Check the price', 'error'); price.focus(); return; }
    list.push({ text: text.value.trim(), quantity: q, unit_price: p, vat_rate: v == null || Number.isNaN(v) ? 25 : v });
    await save();
  }));
  return h('div', {},
    list.length ? h('ul', { class: 'rows' }, list.map((x, i) => h('li', {},
      h('span', { translate: 'no' }, `${x.text} · ${fmtQty(x.quantity)} × ${kr(x.unit_price)} · ${pct(x.vat_rate)}`),
      editable ? h('button', {
        class: 'link danger small no-print', type: 'button',
        onClick: async () => { list.splice(i, 1); try { await save(); } catch (e) { showError(e); } },
      }, 'remove') : null))) : h('p', { class: 'empty' }, 'None.'),
    editable ? h('div', { class: 'toolbar extra-line no-print' }, text, qty, price, vat, add) : null);
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
  const ok = h('button', { class: 'btn primary', type: 'submit' }, 'Save');
  const form = h('form', {},
    field('Title', title),
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
        assigned_to: who.value ? Number(who.value) : null, km: kmVal,
      });
      close();
      toast('Saved', 'success');
      await done();
    });
  });
  const { close } = openDialog(`Work order #${o.number}`, form, { wide: true });
}

// Parts orders (0.48.0): parts collected for a customer's car. Open → ordered from the supplier → arrived → handed out
// (the stock goes down then), or cancelled; with history. Server: routers/parts_orders.py.
import { api, append, busy, canOpen, debounce, fmtDate, h, nameInput, openDialog, showError, toast, upperInput } from '../ui.js';
import {
  ORDER_STATUS, canEditOrders, carTitle, historyList, newOrderDialog, orderBadge, pickCustomer,
} from './customers.js';
import { field, fmtMoney, fmtQty, numInput, parseNum, qtyText } from './parts.js';

const ACTIVE = ['open', 'ordered', 'arrived'];

// ---------------------------------------------------------------- #/parts-orders

export async function partsOrdersView(el) {
  const saved = new URLSearchParams(location.hash.split('?')[1] || '');
  const state = { show: saved.get('show') || 'active', q: saved.get('q') || '' };
  const query = () => new URLSearchParams(Object.entries(state).filter(([k, v]) => v && !(k === 'show' && v === 'active'))).toString();
  const showSel = h('select', { 'aria-label': 'Show' },
    [['active', 'Not handed out yet'], ['done', 'Handed out'], ['cancelled', 'Cancelled'], ['all', 'All orders']]
      .map(([v, t]) => h('option', { value: v, selected: v === state.show }, t)));
  const search = h('input', { type: 'search', value: state.q, placeholder: 'Order no., customer, reg. no., reference…', 'aria-label': 'Search orders' });
  const listSlot = h('div');
  let seq = 0;
  const load = async () => {
    const my = ++seq;
    const q = query();
    if (location.hash.startsWith('#/parts-orders')) history.replaceState(null, '', `#/parts-orders${q ? `?${q}` : ''}`);
    const data = await api.get(`/parts-orders?show=${state.show}&q=${encodeURIComponent(state.q)}`);
    if (my === seq) listSlot.replaceChildren(ordersTable(data));
  };
  const reload = () => load().catch(showError);
  showSel.addEventListener('change', () => { state.show = showSel.value; reload(); });
  search.addEventListener('input', debounce(() => { state.q = search.value.trim(); reload(); }, 300));
  append(el,
    h('p', { class: 'small' }, canOpen('#/parts') ? h('a', { href: '#/parts' }, '← Parts') : null),
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', {}, 'Parts orders'),
        h('div', { class: 'muted' }, 'Parts collected for a customer’s car. The stock goes down when an order is handed out.')),
      canEditOrders() ? h('button', { class: 'btn primary', type: 'button', onClick: () => newOrderDialog() }, '+ New parts order') : null),
    h('div', { class: 'toolbar' }, search, showSel),
    listSlot);
  await load();
}

function ordersTable(data) {
  const c = data.counts || {};
  const waiting = ACTIVE.filter((s) => c[s]);
  const summary = h('p', { class: 'muted small' }, waiting.length
    ? waiting.map((s, i) => [i ? ' · ' : '', h('span', {}, ORDER_STATUS[s]), `: ${c[s]}`]) : 'No orders waiting.');
  if (!data.orders.length) return h('div', {}, summary, h('p', { class: 'empty' }, 'No parts orders.'));
  const rows = data.orders.map((o) => {
    const tr = h('tr', { class: 'click-row', tabindex: '0' },
      h('td', {}, h('a', { href: `#/parts-orders/${o.id}` }, `#${o.order_no}`)),
      h('td', {}, o.customer_name ? h('span', { translate: 'no' }, o.customer_name) : h('span', { class: 'muted' }, 'Deleted customer'),
        o.customer_no ? h('span', { class: 'muted small block' }, String(o.customer_no)) : null),
      h('td', {}, o.registration_number ? h('span', { class: 'mono' }, o.registration_number) : '–',
        o.make ? h('span', { class: 'muted small block', translate: 'no' }, carTitle(o)) : null),
      h('td', {}, orderBadge(o.status)),
      h('td', { class: 'num' }, String(o.lines)),
      h('td', { class: 'num' }, fmtMoney(o.total_inc)),
      h('td', {}, fmtDate(o.created_at, false), o.reference ? h('span', { class: 'muted small block', translate: 'no' }, o.reference) : null));
    const go = () => { location.hash = `#/parts-orders/${o.id}`; };
    tr.addEventListener('click', (e) => { if (!e.target.closest('a')) go(); });
    tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    return tr;
  });
  return h('div', {}, summary,
    h('div', { class: 'table-wrap' }, h('table', { class: 'price-table parts-table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Order'), h('th', {}, 'Customer'), h('th', {}, 'Car'), h('th', {}, 'Status'),
        h('th', { class: 'num' }, 'Lines'), h('th', { class: 'num' }, 'Total inc VAT'), h('th', {}, 'Created'))),
      h('tbody', {}, rows))));
}

// ---------------------------------------------------------------- #/parts-orders/:id

export async function partsOrderView(el, [id], host = el) {
  const o = await api.get(`/parts-orders/${id}`);
  const rerender = async () => {
    try {
      const fresh = h('div');
      await partsOrderView(fresh, [id], host);
      host.replaceChildren(...fresh.childNodes);
    } catch (e) { showError(e); }
  };
  const edit = canEditOrders();
  const editable = edit && ACTIVE.includes(o.status);
  const status = (to, label, cls = 'btn', ask = null) => {
    const b = h('button', { class: cls, type: 'button' }, label);
    b.addEventListener('click', () => busy(b, async () => {
      if (ask && !confirm(ask)) return;
      await api.post(`/parts-orders/${o.id}/status`, { status: to });
      toast('Saved', 'success');
      await rerender();
    }));
    return b;
  };
  const actions = !edit ? [] : {
    open: [status('ordered', 'Ordered from supplier'), status('arrived', 'Parts arrived'),
      status('done', '✓ Hand out', 'btn primary', 'Hand out the parts? They are taken out of the stock.'),
      status('cancelled', 'Cancel order', 'link danger', 'Cancel this order? The reserved parts are released.')],
    ordered: [status('arrived', 'Parts arrived'), status('done', '✓ Hand out', 'btn primary', 'Hand out the parts? They are taken out of the stock.'),
      status('open', 'Back to open', 'link'), status('cancelled', 'Cancel order', 'link danger', 'Cancel this order? The reserved parts are released.')],
    arrived: [status('done', '✓ Hand out', 'btn primary', 'Hand out the parts? They are taken out of the stock.'),
      status('ordered', 'Not arrived after all', 'link'), status('cancelled', 'Cancel order', 'link danger', 'Cancel this order? The reserved parts are released.')],
    done: [status('arrived', 'Undo hand-out', 'link danger', 'Undo the hand-out? The parts are put back into the stock.')],
    cancelled: [],
  }[o.status];

  const custLink = o.customer_id
    ? h('span', {}, canOpen(`#/customers/${o.customer_id}`) ? h('a', { href: `#/customers/${o.customer_id}`, translate: 'no' }, o.customer_name)
      : h('span', { translate: 'no' }, o.customer_name), ' ', h('span', { class: 'muted' }, `(${o.customer_no})`),
    o.customer_phone ? h('span', { class: 'muted small block', translate: 'no' }, o.customer_phone) : null)
    : h('span', { class: 'muted' }, 'Deleted customer');
  const carLink = o.car_id
    ? h('span', {}, h('a', { href: `#/customer-cars/${o.car_id}`, translate: 'no' }, carTitle(o)),
      ' ', h('span', { class: 'mono' }, o.registration_number || ''), o.vin ? h('span', { class: 'muted small block mono' }, o.vin) : null)
    : h('span', { class: 'muted' }, 'No car');
  const row = (label, value) => (value ? [h('dt', {}, label), h('dd', {}, value)] : null);

  append(el,
    h('p', { class: 'small no-print' }, h('a', { href: '#/parts-orders' }, '← Parts orders')),
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', {}, `Parts order #${o.order_no}`), orderBadge(o.status)),
      h('div', { class: 'row-actions no-print' },
        h('button', { class: 'btn', type: 'button', onClick: () => window.print() }, '🖨 Print'),
        editable ? h('button', { class: 'btn', type: 'button', onClick: () => orderEditDialog(o, rerender) }, 'Edit') : null)),
    actions.length ? h('div', { class: 'actions left no-print' }, actions) : null,
    h('section', { class: 'card' },
      h('dl', { class: 'kv' },
        row('Customer', custLink),
        row('Car', carLink),
        row('Reference', o.reference && h('span', { translate: 'no' }, o.reference)),
        row('Note', o.note && h('span', { class: 'pre-line', translate: 'no' }, o.note)),
        row('Created', `${fmtDate(o.created_at)}${o.created_by_name ? ` · ${o.created_by_name}` : ''}`),
        row('Handed out', o.done_at && `${fmtDate(o.done_at)}${o.done_by_name ? ` · ${o.done_by_name}` : ''}`))),
    h('section', { class: 'card' },
      h('h2', {}, 'Parts on the order'),
      linesTable(o, editable, rerender),
      editable ? addLine(o, rerender) : null),
    h('section', { class: 'card no-print' }, h('h2', {}, 'History'), historyList(o.events, { orderLinks: false })));
}

function linesTable(o, editable, rerender) {
  if (!o.lines.length) return h('p', { class: 'empty' }, 'No parts on the order yet.');
  const rows = o.lines.map((l) => {
    const stock = l.part_id
      ? h('span', { class: 'muted small block' },
        l.part_deleted ? h('span', {}, 'Deleted from the parts store') : [h('span', {}, 'In stock:'), ' ', qtyText(l.stock, l.unit),
          l.location ? [' · ', h('span', { translate: 'no' }, l.location)] : null])
      : h('span', { class: 'muted small block' }, 'Not in the parts store');
    return h('tr', {},
      h('td', {}, h('span', { class: 'mono', translate: 'no' }, l.part_number || '–')),
      h('td', {}, h('span', { translate: 'no' }, l.name), o.status === 'done' ? null : stock),
      h('td', { class: 'num' }, qtyText(l.quantity, l.unit)),
      h('td', { class: 'num' }, fmtMoney(l.unit_price)),
      h('td', { class: 'num' }, fmtMoney(l.total_ex)),
      editable ? h('td', { class: 'no-print nowrap' },
        h('button', { class: 'link small', type: 'button', onClick: () => lineDialog(o, l, rerender) }, 'change'), ' ',
        h('button', {
          class: 'link danger small', type: 'button',
          onClick: async () => {
            if (!confirm('Remove this line?')) return;
            try { await api.del(`/parts-orders/${o.id}/lines/${l.id}`); await rerender(); } catch (e) { showError(e); }
          },
        }, 'remove')) : null);
  });
  return h('div', {},
    h('div', { class: 'table-wrap' }, h('table', { class: 'price-table parts-table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Part number'), h('th', {}, 'Name'), h('th', { class: 'num' }, 'Quantity'),
        h('th', { class: 'num' }, 'Price ex VAT'), h('th', { class: 'num' }, 'Total ex VAT'), editable ? h('th', { class: 'no-print' }) : null)),
      h('tbody', {}, rows))),
    h('dl', { class: 'kv order-totals' },
      h('dt', {}, 'Total ex VAT'), h('dd', {}, fmtMoney(o.total_ex)),
      h('dt', {}, 'VAT'), h('dd', {}, fmtMoney(o.vat)),
      h('dt', {}, 'Total inc VAT'), h('dd', {}, h('strong', {}, fmtMoney(o.total_inc)))));
}

/** Add a line: search the parts store, or a free text line for a part that is not in it. */
function addLine(o, rerender) {
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
        h('button', { class: 'link pick', type: 'button', onClick: () => lineDialog(o, { part: p }, rerender) },
          h('span', { class: 'mono', translate: 'no' }, p.part_number), ' ', h('span', { translate: 'no' }, p.name),
          h('span', { class: 'muted small block' }, h('span', {}, 'In stock:'), ' ', qtyText(p.quantity, p.unit),
            Number(p.reserved) > 0 ? ` (${fmtQty(p.reserved)} reserved)` : '',
            p.location ? [' · ', h('span', { translate: 'no' }, p.location)] : null, ` · ${fmtMoney(p.sale_price)}`)))))
        : h('p', { class: 'empty' }, 'No parts match.'));
    } catch (e) { showError(e); }
  }, 250));
  return h('div', { class: 'add-line no-print' },
    h('h3', {}, 'Add a part'),
    h('div', { class: 'toolbar' }, search,
      h('button', { class: 'btn', type: 'button', onClick: () => lineDialog(o, { free: true }, rerender) }, '+ Part not in the store')),
    results);
}

/** New line (from a part or free text) or a change of an existing line (quantity, price). */
function lineDialog(o, l, done) {
  const isNew = !l.id;
  const part = l.part;
  const qty = numInput(isNew ? 1 : l.quantity, { qty: true });
  const price = numInput(isNew ? (part ? part.sale_price : null) : l.unit_price);
  const name = l.free ? nameInput({ maxlength: 200 }) : null;
  const number = l.free ? upperInput({ maxlength: 60, class: 'mono' }) : null;
  const vat = l.free ? numInput(25, { qty: true }) : null;
  const ok = h('button', { class: 'btn primary', type: 'submit' }, isNew ? 'Add' : 'Save');
  const title = part ? [h('strong', { class: 'mono', translate: 'no' }, part.part_number), ' ', h('span', { translate: 'no' }, part.name)]
    : !l.free ? [h('strong', { class: 'mono', translate: 'no' }, l.part_number || ''), ' ', h('span', { translate: 'no' }, l.name)] : null;
  const form = h('form', {},
    title ? h('p', {}, title) : null,
    part && Number(part.quantity) - Number(part.reserved || 0) <= 0
      ? h('div', { class: 'notice warn' }, 'Not available in stock now: order it from the supplier.') : null,
    l.free ? h('div', { class: 'grid' }, field('Name *', name), field('Part number', number)) : null,
    h('div', { class: 'grid' }, field('Quantity *', qty), field('Price per unit ex VAT (kr)', price), vat ? field('VAT (%)', vat) : null),
    h('div', { class: 'actions' }, ok));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const n = parseNum(qty.value);
    const p = parseNum(price.value);
    if (n == null || Number.isNaN(n) || n <= 0) { toast('Enter the quantity', 'error'); qty.focus(); return; }
    if (Number.isNaN(p) || p < 0) { toast('Check the price', 'error'); price.focus(); return; }
    if (l.free && !name.value.trim()) { toast('Type the name of the part', 'error'); name.focus(); return; }
    busy(ok, async () => {
      if (!isNew) {
        await api.patch(`/parts-orders/${o.id}/lines/${l.id}`, { quantity: n, unit_price: p });
      } else if (part) {
        await api.post(`/parts-orders/${o.id}/lines`, { part_id: part.id, quantity: n, unit_price: p });
      } else {
        const v = parseNum(vat.value);
        await api.post(`/parts-orders/${o.id}/lines`, {
          name: name.value.trim(), part_number: number.value.trim() || null, quantity: n, unit_price: p,
          vat_rate: v == null || Number.isNaN(v) ? 25 : v,
        });
      }
      close();
      await done();
    });
  });
  const { close } = openDialog(isNew ? (l.free ? 'Part not in the store' : 'Add part') : 'Change line', form);
  setTimeout(() => (l.free ? name : qty).focus(), 0);
}

/** Edit customer, car, reference and note of an order. */
async function orderEditDialog(o, done) {
  let customer = o.customer_id ? { id: o.customer_id, name: o.customer_name, customer_no: o.customer_no } : null;
  const custText = h('strong', { translate: 'no' });
  const carSel = h('select', {});
  const loadCars = async () => {
    custText.textContent = customer ? `${customer.name} (${customer.customer_no})` : '–';
    const cars = customer ? (await api.get(`/customers/${customer.id}`)).cars.filter((c) => !c.owned_until) : [];
    const ids = cars.map((c) => c.id);
    const extra = o.car_id && !ids.includes(o.car_id) && customer?.id === o.customer_id
      ? [{ id: o.car_id, registration_number: o.registration_number, make: o.make, model: o.model }] : [];
    carSel.replaceChildren(h('option', { value: '' }, 'No car'),
      ...[...extra, ...cars].map((c) => h('option', { value: c.id, selected: c.id === o.car_id },
        [c.registration_number, carTitle(c)].filter(Boolean).join(' · '))));
  };
  const ref = h('input', { type: 'text', maxlength: 60, autocomplete: 'off', value: o.reference || '' });
  const note = h('textarea', { rows: 2, maxlength: 1000 }, o.note || '');
  const ok = h('button', { class: 'btn primary', type: 'submit' }, 'Save');
  const form = h('form', {},
    h('div', { class: 'field' }, h('label', {}, 'Customer'),
      h('div', { class: 'inline' }, custText,
        h('button', {
          class: 'link small', type: 'button',
          onClick: () => pickCustomer('Customer for the order', async (c) => { customer = c; try { await loadCars(); } catch (e) { showError(e); } }),
        }, 'change'))),
    field('Car', carSel),
    field('Reference', ref),
    field('Note', note),
    h('div', { class: 'actions' }, ok));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!customer) { toast('Choose a customer', 'error'); return; }
    busy(ok, async () => {
      await api.patch(`/parts-orders/${o.id}`, {
        customer_id: customer.id, car_id: carSel.value ? Number(carSel.value) : null,
        reference: ref.value.trim() || null, note: note.value.trim() || null,
      });
      close();
      toast('Saved', 'success');
      await done();
    });
  });
  const { close } = openDialog(`Parts order #${o.order_no}`, form);
  try { await loadCars(); } catch (e) { showError(e); }
}

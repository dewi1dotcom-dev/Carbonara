// Parts store (delelager, 0.47.0): part numbers, names, prices ex / inc VAT, shelf locations and stock, with every
// stock change in the part's history. Cost price, margin and stock value only for admins and the parts team (the team
// with the "Parts" menu item; the server decides: `editor`). Server: routers/parts.py.
import { api, append, busy, debounce, fmtDate, h, openDialog, showError, toast } from '../ui.js';

const UNITS = ['pcs', 'set', 'l', 'm', 'kg'];
const UNIT_NAME = { pcs: 'Pieces (pcs)', set: 'Sets (set)', l: 'Litres (l)', m: 'Metres (m)', kg: 'Kilograms (kg)' };
const KIND = {
  created: 'Added', received: 'Received', out: 'Taken out', count: 'Stock counted', import: 'Imported', price: 'Price changed',
};

const money2 = (n) => Number(n).toLocaleString('nb-NO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtMoney = (n) => (n == null ? '–' : `${money2(n)} kr`);
const fmtQty = (n) => (n == null ? '–' : Number(n).toLocaleString('nb-NO', { maximumFractionDigits: 2 }));
const signed = (n) => (Number(n) > 0 ? `+${fmtQty(n)}` : Number(n) < 0 ? `−${fmtQty(Math.abs(n))}` : '0');
const qtyText = (n, unit) => h('span', { class: 'nowrap' }, fmtQty(n), ' ', h('span', {}, unit || 'pcs'));

/** A typed number: "1 234,50", "1234.5", "249,-" → 1234.5; '' → null; not a number → NaN. */
function parseNum(text) {
  let t = String(text ?? '').replace(/[\s  ]|kr|,-$/gi, '');
  if (!t) return null;
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
  return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : NaN;
}
const numInput = (value, { qty = false, ...attrs } = {}) => h('input', {
  type: 'text', inputmode: 'decimal', autocomplete: 'off', ...attrs,
  value: value != null ? (qty ? fmtQty(value) : money2(value)) : '',
});
const field = (label, input, hint) => h('div', { class: 'field' }, h('label', {}, label), input,
  hint ? h('div', { class: 'muted small' }, hint) : null);

function stockBadge(p) {
  if (Number(p.quantity) <= 0) return h('span', { class: 'badge bad' }, 'Out of stock');
  if (p.low) return h('span', { class: 'badge warn' }, 'Low stock');
  return null;
}

// ---------------------------------------------------------------- #/parts

export async function partsView(el) {
  const saved = new URLSearchParams(location.hash.split('?')[1] || '');
  const state = { q: saved.get('q') || '', show: saved.get('show') || 'all', make: saved.get('make') || '' };
  const query = () => {
    const p = new URLSearchParams();
    if (state.q.trim()) p.set('q', state.q.trim());
    if (state.show !== 'all') p.set('show', state.show);
    if (state.make) p.set('make', state.make);
    return p.toString();
  };
  let data = await api.get(`/parts?${query()}`);
  const editor = data.editor;

  const search = h('input', { type: 'search', placeholder: 'Part number, name, location…', value: state.q, 'aria-label': 'Search parts' });
  const showSel = h('select', { 'aria-label': 'Show' },
    [['all', 'All parts'], ['stock', 'In stock'], ['low', 'Low stock'], ['out', 'Out of stock']]
      .map(([v, t]) => h('option', { value: v, selected: v === state.show }, t)));
  const makeSel = h('select', { 'aria-label': 'Make' });
  const exportLink = h('a', { class: 'btn', href: '#', download: 'parts.csv' }, '⬇ Export (CSV)');
  const statsSlot = h('div', { class: 'parts-stats' });
  const listSlot = h('div');

  let seq = 0;
  const reload = async () => {
    const my = ++seq;
    const q = query();
    if (!location.hash.startsWith('#/parts')) return; // the person has left the page
    history.replaceState(null, '', `#/parts${q ? `?${q}` : ''}`); // keeps the search on reload / back (no new render)
    const fresh = await api.get(`/parts?${q}`);
    if (my !== seq) return; // a newer search already answered
    data = fresh;
    draw();
  };
  const safeReload = () => reload().catch(showError);
  const draw = () => {
    makeSel.replaceChildren(h('option', { value: '' }, 'All makes'),
      ...data.makes.map((m) => h('option', { value: m, selected: m === state.make, translate: 'no' }, m)));
    exportLink.href = `/api/parts/export?${query()}`;
    statsSlot.replaceChildren(statsLine(data, (show) => { state.show = show; showSel.value = show; safeReload(); }));
    listSlot.replaceChildren(partsTable(data, (id) => partDialog(id, data, safeReload)));
  };
  search.addEventListener('input', debounce(() => { state.q = search.value; safeReload(); }, 300));
  showSel.addEventListener('change', () => { state.show = showSel.value; safeReload(); });
  makeSel.addEventListener('change', () => { state.make = makeSel.value; safeReload(); });

  append(el,
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', {}, 'Parts'),
        h('div', { class: 'muted' }, 'The parts store: part numbers, prices, locations and stock.')),
      editor ? h('button', { class: 'btn primary', type: 'button', onClick: () => partForm(null, data, safeReload) }, '+ New part') : null),
    statsSlot,
    h('div', { class: 'toolbar' }, search, showSel, makeSel, exportLink),
    listSlot,
    editor ? importCard(safeReload) : null);
  draw();
}

function statsLine(data, setShow) {
  const s = data.stats;
  const link = (text, show, cls) => h('button', { class: `badge ${cls} as-link`, type: 'button', onClick: () => setShow(show) }, text);
  return h('p', { class: 'muted small' },
    `${s.parts} part(s)`,
    s.low ? [' · ', link(`${s.low} low stock`, 'low', 'warn')] : null,
    s.out_of_stock ? [' · ', link(`${s.out_of_stock} out of stock`, 'out', '')] : null,
    data.editor ? [' · ', `Stock value (cost price): ${fmtMoney(s.stock_value)}`] : null,
    data.editor && s.no_cost ? h('span', { class: 'block' }, `${s.no_cost} part(s) in stock have no cost price (not counted).`) : null);
}

function partsTable(data, open) {
  if (!data.parts.length) return h('p', { class: 'empty' }, data.stats.parts ? 'No parts match.' : 'No parts yet.');
  const rows = data.parts.map((p) => {
    const tr = h('tr', { class: 'click-row', tabindex: '0' },
      h('td', {}, h('span', { class: 'mono', translate: 'no' }, p.part_number)),
      h('td', {}, h('span', { translate: 'no' }, p.name),
        p.make || p.supplier ? h('span', { class: 'muted small block', translate: 'no' }, [p.make, p.supplier].filter(Boolean).join(' · ')) : null),
      h('td', { translate: 'no' }, p.location || '–'),
      h('td', { class: 'num' }, qtyText(p.quantity, p.unit), stockBadge(p) ? h('span', { class: 'block' }, stockBadge(p)) : null),
      h('td', { class: 'num col-ex' }, fmtMoney(p.sale_price)),
      h('td', { class: 'num' }, fmtMoney(p.sale_price_inc)));
    tr.addEventListener('click', () => open(p.id));
    tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(p.id); });
    return tr;
  });
  return h('div', {},
    h('div', { class: 'table-wrap' }, h('table', { class: 'price-table parts-table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Part number'), h('th', {}, 'Name'), h('th', {}, 'Location'),
        h('th', { class: 'num' }, 'In stock'), h('th', { class: 'num col-ex' }, 'Price ex VAT'), h('th', { class: 'num' }, 'Price inc VAT'))),
      h('tbody', {}, rows))),
    data.total > data.parts.length
      ? h('p', { class: 'muted small' }, `Showing the first ${data.parts.length} of ${data.total}. Search to narrow it down.`) : null);
}

// ---------------------------------------------------------------- one part

async function partDialog(id, data, changed) {
  const body = h('div', {}, h('div', { class: 'loading' }, 'Loading…'));
  const { close } = openDialog('Part', body, { wide: true });
  const after = async () => { await draw(); await changed(); };
  const draw = async () => {
    const p = await api.get(`/parts/${id}`);
    body.replaceChildren(...partDetails(p, data, after, close, changed).filter(Boolean));
  };
  try { await draw(); } catch (e) { close(); showError(e); }
}

function partDetails(p, data, after, close, changed) {
  const editor = data.editor;
  const row = (label, value) => (value == null || value === '' ? null : [h('dt', {}, label), h('dd', {}, value)]);
  const del = h('button', { class: 'link danger', type: 'button' }, 'Delete part');
  del.addEventListener('click', () => busy(del, async () => {
    if (!confirm('Delete this part? Its history is kept, and the part number can be used again.')) return;
    await api.del(`/parts/${p.id}`);
    close();
    toast('Part deleted', 'success');
    await changed();
  }));
  return [
    h('p', { class: 'part-title' }, h('strong', { class: 'mono', translate: 'no' }, p.part_number), ' ',
      h('span', { translate: 'no' }, p.name)),
    h('p', { class: 'part-stock' }, h('span', {}, 'In stock:'), ' ', h('strong', {}, qtyText(p.quantity, p.unit)), ' ', stockBadge(p)),
    editor ? h('div', { class: 'actions left' },
      h('button', { class: 'btn primary', type: 'button', onClick: () => moveDialog(p, 'received', after) }, '＋ Received'),
      h('button', { class: 'btn', type: 'button', onClick: () => moveDialog(p, 'out', after) }, '－ Taken out'),
      h('button', { class: 'btn', type: 'button', onClick: () => moveDialog(p, 'count', after) }, 'Count stock'),
      h('button', { class: 'btn', type: 'button', onClick: () => partForm(p, data, after) }, 'Edit')) : null,
    h('dl', { class: 'kv' },
      row('Make', p.make && h('span', { translate: 'no' }, p.make)),
      row('Supplier', p.supplier && h('span', { translate: 'no' }, p.supplier)),
      row('Location', p.location && h('span', { translate: 'no' }, p.location)),
      row('Minimum stock', p.min_quantity != null ? qtyText(p.min_quantity, p.unit) : null),
      editor ? row('Cost price ex VAT', fmtMoney(p.cost_price)) : null,
      row('Price ex VAT', fmtMoney(p.sale_price)),
      row('Price inc VAT', p.sale_price_inc != null
        ? [h('strong', {}, fmtMoney(p.sale_price_inc)), ' ', h('span', { class: 'muted small' }, `(${fmtQty(p.vat_rate)} % VAT)`)] : '–'),
      editor ? row('Margin', p.margin_pct != null ? `${fmtQty(p.margin_pct)} %` : null) : null,
      row('Note', p.note && h('span', { class: 'pre-line', translate: 'no' }, p.note))),
    h('h3', {}, 'History'),
    p.movements.length ? h('ul', { class: 'rows part-history' }, p.movements.map((m) => historyRow(m, p.unit)))
      : h('p', { class: 'empty' }, 'No history yet.'),
    editor ? h('div', { class: 'actions spread' }, del, h('span')) : null,
  ];
}

function historyRow(m, unit) {
  let what;
  if (m.kind === 'price') {
    const d = m.data || {};
    what = [
      'sale_from' in d || 'sale_to' in d ? h('span', { class: 'block' }, `Price ex VAT: ${fmtMoney(d.sale_from)} → ${fmtMoney(d.sale_to)}`) : null,
      'cost_from' in d || 'cost_to' in d ? h('span', { class: 'block' }, `Cost price: ${fmtMoney(d.cost_from)} → ${fmtMoney(d.cost_to)}`) : null,
    ];
  } else {
    what = [' ', h('strong', {}, signed(m.change)), ' ', h('span', { class: 'muted' }, '→'), ' ', qtyText(m.quantity_after, unit)];
  }
  const meta = [fmtDate(m.created_at), m.staff_name].filter(Boolean).join(' · ');
  return h('li', {},
    h('span', {},
      h('span', {}, KIND[m.kind] ?? m.kind), what,
      m.unit_cost != null ? h('span', { class: 'muted small block' }, `Purchase price ${fmtMoney(m.unit_cost)} per unit`) : null,
      m.reference ? h('span', { class: 'muted small block' }, h('span', {}, 'Ref.:'), ' ', h('span', { translate: 'no' }, m.reference)) : null,
      m.note ? h('span', { class: 'muted small block', translate: 'no' }, m.note) : null,
      h('span', { class: 'muted small block', translate: 'no' }, meta)));
}

// ---------------------------------------------------------------- stock in / out / count

function moveDialog(p, kind, done) {
  const title = { received: 'Parts received', out: 'Take parts out', count: 'Count stock' }[kind];
  const qty = numInput(null, { qty: true, required: true });
  const cost = kind === 'received' ? numInput(p.cost_price) : null;
  const ref = kind === 'count' ? null : h('input', { type: 'text', maxlength: 60, autocomplete: 'off' });
  const note = h('input', { type: 'text', maxlength: 300, autocomplete: 'off' });
  const ok = h('button', { class: 'btn primary', type: 'submit' }, 'Save');
  const form = h('form', {},
    h('p', {}, h('strong', { class: 'mono', translate: 'no' }, p.part_number), ' ', h('span', { translate: 'no' }, p.name)),
    h('p', { class: 'muted small' }, `In Carbonara now: ${fmtQty(p.quantity)}`, ' ', h('span', {}, p.unit)),
    field({ received: 'Quantity received *', out: 'Quantity taken out *', count: 'Counted quantity *' }[kind], qty),
    cost ? field('Purchase price per unit, ex VAT (kr)', cost, 'Changing it updates the part’s cost price.') : null,
    ref ? field(kind === 'received' ? 'Delivery note / invoice no.' : 'Work order / receipt no.', ref) : null,
    field('Note', note),
    h('div', { class: 'actions' }, ok));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const n = parseNum(qty.value);
    const c = cost ? parseNum(cost.value) : null;
    if (n == null || Number.isNaN(n) || n < 0) { toast('Enter the quantity', 'error'); qty.focus(); return; }
    if (Number.isNaN(c)) { toast('Check the price', 'error'); cost.focus(); return; }
    busy(ok, async () => {
      await api.post(`/parts/${p.id}/movements`, {
        kind, quantity: n, unit_cost: c, reference: ref?.value.trim() || null, note: note.value.trim() || null,
      });
      close();
      toast('Saved', 'success');
      await done();
    });
  });
  const { close } = openDialog(title, form);
  setTimeout(() => qty.focus(), 0);
}

// ---------------------------------------------------------------- add / edit

function partForm(p, data, done) {
  const v = p || { unit: 'pcs', vat_rate: 25 };
  const text = (value, max, attrs = {}) => h('input', { type: 'text', maxlength: max, autocomplete: 'off', value: value || '', ...attrs });
  const number = text(v.part_number, 60, { required: true, class: 'mono' });
  const name = text(v.name, 200, { required: true });
  const makes = h('datalist', { id: 'parts-makes' }, data.makes.map((m) => h('option', { value: m })));
  const make = text(v.make, 60, { list: 'parts-makes' });
  const supplier = text(v.supplier, 100);
  const location = text(v.location, 60);
  const unit = h('select', {}, UNITS.map((u) => h('option', { value: u, selected: u === v.unit }, UNIT_NAME[u])));
  const qty = p ? null : numInput(0, { qty: true });
  const min = numInput(v.min_quantity, { qty: true });
  const cost = numInput(v.cost_price);
  const ex = numInput(v.sale_price);
  const inc = numInput(v.sale_price_inc);
  const vat = numInput(v.vat_rate, { qty: true });
  const note = h('textarea', { rows: 2, maxlength: 1000 }, v.note || '');
  const margin = h('div', { class: 'muted small' });

  // Ex and inc VAT follow each other; the margin follows both prices.
  const rate = () => { const r = parseNum(vat.value); return r == null || Number.isNaN(r) ? 25 : r; };
  const showMargin = () => {
    const s = parseNum(ex.value); const c = parseNum(cost.value);
    margin.textContent = s > 0 && c != null && !Number.isNaN(c) ? `Margin: ${fmtQty(Math.round(((s - c) / s) * 1000) / 10)} %` : '';
  };
  const fromEx = () => { const s = parseNum(ex.value); inc.value = s == null || Number.isNaN(s) ? '' : money2(s * (1 + rate() / 100)); showMargin(); };
  const fromInc = () => { const s = parseNum(inc.value); ex.value = s == null || Number.isNaN(s) ? '' : money2(s / (1 + rate() / 100)); showMargin(); };
  ex.addEventListener('input', fromEx);
  inc.addEventListener('input', fromInc);
  vat.addEventListener('input', fromEx);
  cost.addEventListener('input', showMargin);
  showMargin();

  const ok = h('button', { class: 'btn primary', type: 'submit' }, p ? 'Save' : 'Add part');
  const form = h('form', {},
    h('div', { class: 'grid' },
      field('Part number *', number), field('Name *', name),
      field('Make', make), field('Supplier', supplier),
      field('Location (shelf)', location), field('Unit', unit),
      qty ? field('In stock now', qty) : null, field('Minimum stock', min, 'Shown as “Low stock” at or below this.'),
      field('Cost price ex VAT (kr)', cost), field('VAT (%)', vat),
      field('Price ex VAT (kr)', ex), field('Price inc VAT (kr)', inc)),
    makes, margin,
    field('Note', note),
    h('div', { class: 'actions' }, ok));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const nums = { min_quantity: min, cost_price: cost, sale_price: ex, vat_rate: vat, ...(qty ? { quantity: qty } : {}) };
    const body = {
      part_number: number.value.trim(), name: name.value.trim(), make: make.value.trim() || null,
      supplier: supplier.value.trim() || null, location: location.value.trim() || null, unit: unit.value,
      note: note.value.trim() || null,
    };
    for (const [k, input] of Object.entries(nums)) {
      const n = parseNum(input.value);
      if (Number.isNaN(n) || n < 0) { toast('Check the numbers', 'error'); input.focus(); return; }
      body[k] = n;
    }
    if (body.vat_rate == null) body.vat_rate = 25;
    if (body.quantity == null && qty) body.quantity = 0;
    busy(ok, async () => {
      if (p) await api.patch(`/parts/${p.id}`, body);
      else await api.post('/parts', body);
      close();
      toast(p ? 'Part saved' : 'Part added', 'success');
      await done();
    });
  });
  const { close } = openDialog(p ? 'Edit part' : 'New part', form, { wide: true });
  setTimeout(() => (p ? name : number).focus(), 0);
}

// ---------------------------------------------------------------- import

function importCard(changed) {
  const file = h('input', { type: 'file', accept: '.csv,.xlsx,.txt,text/csv' });
  const addNew = h('input', { type: 'checkbox', checked: true });
  const setStock = h('input', { type: 'checkbox' });
  const result = h('div');
  const past = h('div');
  const go = h('button', { class: 'btn primary', type: 'button' }, 'Import');
  const loadHistory = async () => {
    const list = await api.get('/parts/imports');
    past.replaceChildren(...(list.length ? [h('ul', { class: 'rows' }, list.slice(0, 5).map((i) => h('li', {},
      h('span', {}, h('strong', { translate: 'no' }, i.file_name),
        h('span', { class: 'muted small block' }, `${fmtDate(i.imported_at)} · ${i.imported_by_name || ''}`),
        h('span', { class: 'muted small block' }, `${i.added} added, ${i.updated} updated`)))))] : []));
  };
  go.addEventListener('click', () => busy(go, async () => {
    if (!file.files[0]) { toast('Choose a file first', 'error'); return; }
    const fd = new FormData();
    fd.append('file', file.files[0]);
    fd.append('add_new', addNew.checked ? 'true' : 'false');
    fd.append('set_stock', setStock.checked ? 'true' : 'false');
    const r = await api.postForm('/parts/import', fd);
    result.replaceChildren(h('div', { class: 'notice' },
      h('span', { class: 'block' }, `Imported: ${r.added} added, ${r.updated} updated, ${r.unchanged} unchanged`),
      r.not_added ? h('span', { class: 'block' }, `${r.not_added} part(s) in the file are not in Carbonara (not added)`) : null,
      r.skipped ? h('span', { class: 'block' }, `${r.skipped} row(s) skipped (no part number or name, or a repeated part number)`) : null));
    toast('Import done', 'success');
    file.value = '';
    await changed();
    await loadHistory();
  }));
  loadHistory().catch(() => {});
  return h('section', { class: 'card' },
    h('details', {},
      h('summary', {}, h('strong', {}, 'Import a price list or stock list')),
      h('p', { class: 'muted small' }, 'A CSV file or an Excel file (.xlsx, first sheet). Columns are found by their name, in English or '
        + 'Norwegian: part number (needed), name, make, supplier, location, unit, quantity, minimum, cost price, price ex VAT '
        + 'or price inc VAT, VAT, note. A column called just “price” counts as ex VAT. Parts are matched by part number; '
        + 'only cells with a value change a part, and price changes go into its history.'),
      h('div', { class: 'toolbar' }, file, go),
      h('label', { class: 'check' }, addNew, h('span', {}, 'Add parts that are not in Carbonara yet')),
      h('label', { class: 'check' }, setStock, h('span', {}, 'Set the stock of existing parts from the file’s quantities')),
      h('p', { class: 'muted small' }, 'New parts always get the file’s quantity. Untick the first box to only update prices from a '
        + 'supplier’s full price list.'),
      result,
      past));
}

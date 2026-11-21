// Asking prices (0.44.0): each car's asking price (typed in, or read from its finn.no ad by the helper), compared
// with the other cars in stock of the same make and model, with year and latest mileage beside it.
// Server: vehicles.asking_price*, GET /vehicles/prices, price_peers on GET /vehicles/{id}.
import { api, busy, CONDITION, fmtDate, fmtKm, fmtKr, h, openDialog, toast, vehicleTitle } from '../ui.js';

const year = (c) => c.model_year || c.first_reg_year || null;
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};
const stats = (cars) => {
  const prices = cars.map((c) => c.asking_price).filter((p) => p != null);
  return prices.length ? { low: Math.min(...prices), median: median(prices), high: Math.max(...prices), n: prices.length } : null;
};
/** "+8 %" / "−5 %" against the median (badge colour: above = amber, below = green, close = plain). */
function vsMedian(price, med) {
  if (price == null || !med) return null;
  const pct = Math.round(((price - med) / med) * 100);
  if (pct === 0) return h('span', { class: 'badge' }, '± 0 %');
  return h('span', { class: `badge ${pct > 5 ? 'warn' : pct < -5 ? 'good' : ''}` }, `${pct > 0 ? '+' : '−'}${Math.abs(pct)} %`);
}
const sourceText = (c) => [c.asking_price_source === 'finn' ? 'finn.no' : null, c.asking_price_at && fmtDate(c.asking_price_at, false)]
  .filter(Boolean).join(', ');

// ---------------------------------------------------------------- the car page

/** The "Asking price" row of the overview card. */
export function priceValue(v, rerender) {
  return v.asking_price != null
    ? h('span', { class: 'inline' }, h('strong', {}, fmtKr(v.asking_price)),
      sourceText(v) ? h('span', { class: 'muted small' }, ` (${sourceText(v)})`) : null,
      h('button', { class: 'link small', type: 'button', onClick: () => priceDialog(v, rerender) }, 'change'))
    : h('span', { class: 'inline' }, h('span', { class: 'muted' }, 'No price'),
      h('button', { class: 'link', type: 'button', onClick: () => priceDialog(v, rerender) }, '+ Add price'));
}

function priceDialog(v, done) {
  const input = h('input', {
    type: 'text', inputmode: 'numeric', autocomplete: 'off', placeholder: 'e.g. 289 900',
    value: v.asking_price != null ? Number(v.asking_price).toLocaleString('nb-NO') : '',
  });
  const ok = h('button', { class: 'btn primary', type: 'submit' }, 'Save');
  const save = (price) => busy(ok, async () => {
    await api.patch(`/vehicles/${v.id}`, { asking_price: price, asking_price_source: 'manual' });
    close();
    toast(price == null ? 'Price removed' : 'Price saved', 'success');
    await done();
  });
  const form = h('form', {},
    h('p', { class: 'muted small' }, 'The asking price in kroner, as on the ad. Carbonara Sidekick can read it from the car’s finn.no ad.'),
    h('div', { class: 'field' }, h('label', {}, 'Asking price (kr)'), input),
    h('div', { class: 'actions spread' },
      v.asking_price != null ? h('button', { class: 'link danger', type: 'button', onClick: () => save(null) }, 'Remove price') : h('span'),
      ok));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const digits = input.value.replace(/[^\d]/g, '');
    if (!digits) { input.focus(); return; }
    save(Number(digits));
  });
  const { close } = openDialog('Asking price', form);
  setTimeout(() => input.focus(), 0);
}

/** Price against the other cars of the same make and model in stock. */
export function priceCard(v) {
  const peers = v.price_peers || [];
  if (v.asking_price == null && !peers.some((p) => p.asking_price != null)) return null;
  const all = [v, ...peers];
  const st = stats(all);
  const kmOf = (c) => (c.id === v.id ? v.mileage?.km : c.km);
  return h('section', { class: 'card' },
    h('h2', {}, 'Price compared with similar cars in stock'),
    peers.length ? null : h('p', { class: 'muted' }, 'No other cars of this make and model in stock.'),
    st && st.n > 1 ? h('dl', { class: 'kv' },
      h('dt', {}, 'Lowest'), h('dd', {}, fmtKr(st.low)),
      h('dt', {}, 'Median'), h('dd', {}, fmtKr(st.median)),
      h('dt', {}, 'Highest'), h('dd', {}, fmtKr(st.high)),
      h('dt', {}, 'This car'), h('dd', {}, v.asking_price != null
        ? [fmtKr(v.asking_price), ' ', vsMedian(v.asking_price, st.median)] : h('span', { class: 'muted' }, 'No price'))) : null,
    peers.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'price-table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Car'), h('th', {}, 'Year'), h('th', {}, 'Mileage'), h('th', {}, 'Price'))),
      h('tbody', {}, all.map((c) => h('tr', { class: c.id === v.id ? 'this-car' : '' },
        h('td', {}, c.id === v.id ? h('strong', {}, 'This car')
          : h('a', { href: `#/vehicles/${c.id}`, translate: 'no' }, c.registration_number || c.vin),
        c.variant ? h('span', { class: 'muted small block', translate: 'no' }, c.variant) : null),
        h('td', {}, year(c) ?? '–'),
        h('td', {}, fmtKm(kmOf(c))),
        h('td', {}, c.asking_price != null ? fmtKr(c.asking_price) : h('span', { class: 'muted' }, '–'))))))) : null,
    h('p', { class: 'small' }, h('a', { href: '#/prices' }, 'Price overview →')));
}

// ---------------------------------------------------------------- #/prices: every car in stock

export async function pricesView(el) {
  const cars = await api.get('/vehicles/prices');
  const condSel = h('select', { 'aria-label': 'New/used' },
    h('option', { value: '' }, 'New and used'), h('option', { value: 'used' }, CONDITION.used), h('option', { value: 'new' }, CONDITION.new));
  const list = h('div');
  const draw = () => {
    const shown = cars.filter((c) => !condSel.value || c.condition === condSel.value);
    const key = (c) => `${(c.make || '').toLowerCase().replace(/[^a-z0-9]/g, '')}|${(c.model || '').toLowerCase().replace(/[^a-z0-9]/g, '')}`;
    const groups = new Map();
    for (const c of shown) groups.set(key(c), [...(groups.get(key(c)) || []), c]);
    list.replaceChildren(...(groups.size ? [...groups.values()].map((g) => groupCard(g)) : [h('p', { class: 'empty' }, 'No cars in stock.')]));
  };
  condSel.addEventListener('change', draw);
  el.append(
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', {}, 'Price overview'),
        h('div', { class: 'muted' }, 'Asking prices of the cars in stock, compared within the same make and model.'))),
    h('div', { class: 'toolbar' }, condSel),
    list);
  draw();
}

function groupCard(cars) {
  const st = stats(cars);
  const sorted = [...cars].sort((a, b) => (a.asking_price ?? Infinity) - (b.asking_price ?? Infinity));
  return h('section', { class: 'card' },
    h('h2', { translate: 'no' }, vehicleTitle({ make: cars[0].make, model: cars[0].model })),
    h('p', { class: 'muted small' }, `${cars.length} car(s)`,
      st ? h('span', {}, ` · ${fmtKr(st.low)} – ${fmtKr(st.high)} · median ${fmtKr(st.median)}`) : null),
    h('div', { class: 'table-wrap' }, h('table', { class: 'price-table' },
      h('thead', {}, h('tr', {},
        h('th', {}, 'Car'), h('th', {}, 'Year'), h('th', {}, 'Mileage'), h('th', {}, 'Price'), h('th', {}, 'vs. median'))),
      h('tbody', {}, sorted.map((c) => h('tr', {},
        h('td', {}, h('a', { href: `#/vehicles/${c.id}`, translate: 'no' }, c.registration_number || c.vin),
          c.variant ? h('span', { class: 'muted small block', translate: 'no' }, c.variant) : null),
        h('td', {}, year(c) ?? '–'),
        h('td', {}, fmtKm(c.km)),
        h('td', {}, c.asking_price != null ? fmtKr(c.asking_price) : h('span', { class: 'muted' }, 'No price'),
          sourceText(c) ? h('span', { class: 'muted small block' }, sourceText(c)) : null),
        h('td', {}, st && st.n > 1 ? vsMedian(c.asking_price, st.median) : null)))))));
}

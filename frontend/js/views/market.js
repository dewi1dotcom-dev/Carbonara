// Market data (test, 0.46.0): listings imported from a CSV file, compared with our asking prices by make, model, year
// and mileage. Switched on / off on the System page (session.me.market_data). Server: routers/market.py.
import { api, append, busy, fmtDate, fmtKm, fmtKr, h, session, showError, toast, vehicleTitle } from '../ui.js';

export const marketOn = () => !!session.me?.market_data;
const yearOf = (c) => c.model_year || c.first_reg_year || null;

/** "+8 %" / "−5 %" of a price against a reference (above = amber, below = green, within 5 % = plain). */
function vs(price, ref) {
  if (price == null || !ref) return null;
  const pct = Math.round(((price - ref) / ref) * 100);
  if (pct === 0) return h('span', { class: 'badge' }, '± 0 %');
  return h('span', { class: `badge ${pct > 5 ? 'warn' : pct < -5 ? 'good' : ''}` }, `${pct > 0 ? '+' : '−'}${Math.abs(pct)} %`);
}
const range = (s) => (s ? `${fmtKr(s.low)} – ${fmtKr(s.high)}` : '–');
const sellerText = (k) => (k === 'private' ? 'Private' : k === 'dealer' ? 'Dealer' : '');

// ---------------------------------------------------------------- the car page

/** "Market price" card: the estimate for this car's year + mileage, the range, and the closest listings. */
export function marketCard(v, data) {
  const m = data?.market;
  if (!m) return null;
  const est = m.estimate;
  return h('section', { class: 'card' },
    h('h2', {}, 'Market price (imported listings)'),
    h('p', { class: 'muted small' }, `${m.model_name}: ${m.all.n} listing(s) for sale. A test: based on the imported file only.`),
    h('dl', { class: 'kv' },
      h('dt', {}, 'Estimate for this car'), h('dd', {}, est
        ? [h('strong', {}, fmtKr(est.price)), ' ', h('span', { class: 'muted small' },
          est.km_assumed ? `year ${m.year}, typical mileage (this car has none recorded)` : `year ${m.year}, ${fmtKm(m.km)}`)]
        : h('span', { class: 'muted' }, m.year ? 'Too few listings with year and mileage' : 'The car has no model year')),
      h('dt', {}, 'Similar listings'), h('dd', {}, m.similar
        ? `${m.similar.n} · ${range(m.similar)} · median ${fmtKr(m.similar.median)}` : h('span', { class: 'muted' }, 'None (year ± 1, similar mileage)')),
      h('dt', {}, 'All listings of the model'), h('dd', {}, `${range(m.all)} · median ${fmtKr(m.all.median)}`),
      h('dt', {}, 'This car'), h('dd', {}, data.asking_price != null
        ? [fmtKr(data.asking_price), ' ', vs(data.asking_price, est?.price ?? m.similar?.median ?? m.all.median)]
        : h('span', { class: 'muted' }, 'No asking price'))),
    m.closest.length ? h('details', {},
      h('summary', {}, `Closest listings (${m.closest.length})`),
      h('div', { class: 'table-wrap' }, h('table', { class: 'price-table' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Listing'), h('th', {}, 'Year'), h('th', {}, 'Mileage'), h('th', {}, 'Price'))),
        h('tbody', {}, m.closest.map((x) => h('tr', {},
          h('td', {}, x.url
            ? h('a', { href: x.url, target: '_blank', rel: 'noopener noreferrer', translate: 'no' }, x.variant || x.model)
            : h('span', { translate: 'no' }, x.variant || x.model),
          sellerText(x.seller_kind) ? h('span', { class: 'muted small block' }, sellerText(x.seller_kind)) : null),
          h('td', {}, x.year ?? '–'),
          h('td', {}, fmtKm(x.km)),
          h('td', {}, fmtKr(x.price),
            x.first_price && x.first_price !== x.price
              ? h('span', { class: 'muted small block' }, `was ${fmtKr(x.first_price)}`) : null))))))) : null,
    h('p', { class: 'small' }, h('a', { href: '#/market' }, 'Market prices →')));
}

// ---------------------------------------------------------------- #/market

export async function marketView(el, _params, host = el) {
  if (!marketOn()) {
    append(el, h('h1', {}, 'Market prices'),
      h('div', { class: 'card notice' }, 'Market data is turned off. A system admin can turn it on: System → Market data.'));
    return;
  }
  const data = await api.get('/market');
  const redraw = async () => {
    try {
      const fresh = h('div');
      await marketView(fresh, _params, host);
      host.replaceChildren(...fresh.childNodes);
    } catch (e) { showError(e); }
  };
  append(el,
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', {}, 'Market prices'),
        h('div', { class: 'muted' }, 'Test: car listings imported from a file, compared with the asking prices of our cars.'))),
    session.me?.is_admin ? importCard(data, redraw) : null,
    carsCard(data),
    modelsCard(data));
}

function importCard(data, redraw) {
  const file = h('input', { type: 'file', accept: '.csv,text/csv,text/plain' });
  const go = h('button', { class: 'btn primary', type: 'button' }, 'Import');
  go.addEventListener('click', () => busy(go, async () => {
    if (!file.files[0]) { toast('Choose a file first', 'error'); return; }
    const fd = new FormData();
    fd.append('file', file.files[0]);
    const r = await api.postForm('/market/import', fd);
    toast(`Imported ${r.rows_read} listing(s)${r.rows_skipped ? `, ${r.rows_skipped} row(s) skipped` : ''}`, 'success');
    await redraw();
  }));
  return h('section', { class: 'card' },
    h('h2', {}, 'Import listings'),
    h('p', { class: 'muted small' }, 'A CSV file with one listing per row. Needed columns: make, model, price (or price_nok). '
      + 'Used when present: year, km, variant, fuel, seller, status, first_price_nok, first_seen, last_seen, finn_code, url. '
      + 'Each make and model in the file replaces the earlier listings of that make and model; other models are kept. '
      + 'Seller names and places are not stored.'),
    h('div', { class: 'toolbar' }, file, go),
    data.imports.length ? h('ul', { class: 'rows' }, data.imports.map((i) => {
      const del = h('button', { class: 'link danger small', type: 'button' }, 'Delete');
      del.addEventListener('click', () => busy(del, async () => {
        if (!confirm('Delete this import and its listings?')) return;
        await api.del(`/market/imports/${i.id}`);
        await redraw();
      }));
      return h('li', {},
        h('span', {}, h('strong', { translate: 'no' }, i.file_name),
          h('span', { class: 'muted small block' },
            [fmtDate(i.imported_at), i.imported_by].filter(Boolean).join(' · '), ' · ', `${i.listings} listing(s)`, ' · ',
            h('span', { translate: 'no' }, i.models.join(', ')))),
        del);
    })) : h('p', { class: 'empty' }, 'Nothing imported yet.'));
}

function carsCard(data) {
  return h('section', { class: 'card' },
    h('h2', {}, `Our cars with market data (${data.cars.length})`),
    h('p', { class: 'muted small' }, 'Cars in stock, and cars added from their ad that have not arrived yet. '
      + 'The estimate is worked out from the listings\' year and mileage.'),
    data.cars.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'price-table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Car'), h('th', {}, 'Year'), h('th', {}, 'Mileage'), h('th', {}, 'Asking price'),
        h('th', {}, 'Estimate'), h('th', {}, 'Similar listings'), h('th', {}, 'vs. estimate'))),
      h('tbody', {}, data.cars.map((c) => {
        const m = c.market;
        const ref = m.estimate?.price ?? m.similar?.median ?? null;
        return h('tr', {},
          h('td', {}, h('a', { href: `#/vehicles/${c.id}` }, h('span', { translate: 'no' }, vehicleTitle(c))),
            h('span', { class: 'muted small block mono' }, c.registration_number || c.vin)),
          h('td', {}, yearOf(c) ?? '–'),
          h('td', {}, fmtKm(c.km)),
          h('td', {}, c.asking_price != null ? fmtKr(c.asking_price) : h('span', { class: 'muted' }, 'No price')),
          h('td', {}, m.estimate ? fmtKr(m.estimate.price) : '–'),
          h('td', {}, m.similar ? `${m.similar.n} · ${fmtKr(m.similar.median)}` : '–'),
          h('td', {}, vs(c.asking_price, ref)));
      })))) : h('p', { class: 'empty' }, 'None of our cars match the imported make and model yet.'));
}

function modelsCard(data) {
  return h('section', { class: 'card' },
    h('h2', {}, `Imported models (${data.models.length})`),
    data.models.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'price-table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Make and model'), h('th', {}, 'For sale'), h('th', {}, 'Years'),
        h('th', {}, 'Price range'), h('th', {}, 'Median'), h('th', {}, 'Last seen'))),
      h('tbody', {}, data.models.map((m) => h('tr', {},
        h('td', { translate: 'no' }, `${m.make} ${m.model}`),
        h('td', {}, m.inactive ? `${m.n} (+${m.inactive} sold)` : String(m.n)),
        h('td', {}, m.year_min ? (m.year_min === m.year_max ? String(m.year_min) : `${m.year_min}–${m.year_max}`) : '–'),
        h('td', {}, m.n ? range(m) : '–'),
        h('td', {}, fmtKr(m.median)),
        h('td', {}, m.last_seen ? fmtDate(m.last_seen, false) : '–')))))) : h('p', { class: 'empty' }, 'No listings imported.'));
}

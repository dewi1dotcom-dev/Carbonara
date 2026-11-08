// Storage: every spot with how full it is; tap a spot to see the cars in it.
import { api, append, fmtDate, h } from '../ui.js';
import { vehicleCard } from './vehicles.js';

const OFF_SITE = 'off-site';

/** How full a spot is. Spots with sub-zones use their totals. */
function fill(l) {
  const n = l.total_count ?? l.vehicle_count ?? 0;
  const cap = l.total_capacity;
  if (!cap) return { text: `${n} ${n === 1 ? 'car' : 'cars'}`, pct: null, cls: '' };
  const pct = Math.min(100, Math.round((n / cap) * 100));
  return { text: `${n} / ${cap} cars`, pct, cls: n >= cap ? 'bad' : pct >= 80 ? 'warn' : 'good' };
}

const meter = (f) => (f.pct != null ? h('div', { class: `meter ${f.cls}` }, h('div', { style: { width: `${f.pct}%` } })) : null);

function spotTile(l, children) {
  const f = fill(l);
  return h('a', { class: 'card spot-tile', href: `#/storage/${l.id}` },
    h('div', { class: 'spot-head' },
      h('span', { class: 'mono strong' }, l.code),
      f.cls === 'bad' ? h('span', { class: 'badge bad' }, 'Full') : null),
    l.description ? h('div', { class: 'muted small' }, l.description) : null,
    h('div', { class: 'spot-count' }, f.text),
    meter(f),
    children.length ? h('ul', { class: 'plain sub-list' }, children.map((c) => {
      const cf = fill(c);
      return h('li', { class: cf.cls === 'bad' ? 'full' : '' }, h('span', { class: 'mono' }, c.own_code), h('span', {}, cf.text));
    })) : null);
}

export async function storageView(el) {
  const [all, offSite] = await Promise.all([api.get('/storage-locations'), api.get('/vehicles?status=off_site')]);
  const locs = all.filter((l) => !l.parent_id); // top-level spots; sub-zones are shown inside them
  const childrenOf = (id) => all.filter((c) => c.parent_id === id);
  const zones = new Map();
  for (const l of locs) {
    const z = l.zone || 'Other';
    if (!zones.has(z)) zones.set(z, []);
    zones.get(z).push(l);
  }
  const total = locs.reduce((s, l) => s + (l.total_count ?? 0), 0);

  append(el,
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', {}, 'Storage'),
        h('div', { class: 'muted' }, `${total} ${total === 1 ? 'car' : 'cars'} in ${locs.length} ${locs.length === 1 ? 'spot' : 'spots'}`
          + (offSite.length ? ` · ${offSite.length} off site` : ''))),
      h('a', { class: 'small', href: '#/settings' }, 'Manage spots →')),
    locs.length ? null : h('div', { class: 'card notice warn' }, 'No storage spots yet. ',
      h('a', { href: '#/settings' }, 'Add spots in settings')),
    [...zones].map(([zone, list]) => h('section', {},
      h('h2', { class: 'zone-title' }, zone),
      h('div', { class: 'spot-grid' }, list.map((l) => spotTile(l, childrenOf(l.id)))))),
    h('section', {},
      h('h2', { class: 'zone-title' }, 'Away'),
      h('div', { class: 'spot-grid' },
        h('a', { class: 'card spot-tile off', href: `#/storage/${OFF_SITE}` },
          h('div', { class: 'spot-head' }, h('span', { class: 'strong' }, 'Off site')),
          h('div', { class: 'muted small' }, 'Workshop, test drive, delivered…'),
          h('div', { class: 'spot-count' }, `${offSite.length} ${offSite.length === 1 ? 'car' : 'cars'}`)))));
}

export async function storageSpotView(el, [id]) {
  const back = h('a', { href: '#/storage', class: 'small' }, '← All storage');
  if (id === OFF_SITE) {
    const cars = await api.get('/vehicles?status=off_site');
    append(el,
      h('div', { class: 'page-head' }, h('div', {}, back, h('h1', {}, 'Off site'),
        h('div', { class: 'muted' }, `${cars.length} ${cars.length === 1 ? 'car' : 'cars'}`))),
      h('div', { class: 'list' }, cars.length ? cars.map((v) => vehicleCard(v))
        : h('p', { class: 'empty' }, 'No cars are off site.')));
    return;
  }

  const l = await api.get(`/storage-locations/${id}`);
  const f = fill(l);
  const since = (v) => `In spot since ${fmtDate(v.placed_at)}`;
  const carList = (cars, empty) => h('div', { class: 'list' }, cars.length
    ? cars.map((v) => vehicleCard(v, since(v))) : h('p', { class: 'empty' }, empty));

  let body;
  if (l.children.length) {
    // One section per sub-zone, plus any cars placed in the spot before it was split.
    const direct = l.vehicles.filter((v) => v.location_id === l.id);
    body = [
      l.children.map((c) => {
        const cf = fill(c);
        return h('section', { class: 'sub-zone' },
          h('div', { class: 'sub-head' },
            h('h2', { class: 'mono' }, c.own_code),
            h('span', { class: 'inline' }, h('span', { class: 'spot-count' }, cf.text),
              cf.cls === 'bad' ? h('span', { class: 'badge bad' }, 'Full') : null)),
          c.description ? h('div', { class: 'muted small' }, c.description) : null,
          meter(cf),
          carList(l.vehicles.filter((v) => v.location_id === c.id), 'No cars here.'));
      }),
      direct.length ? h('section', { class: 'sub-zone' },
        h('div', { class: 'sub-head' }, h('h2', {}, 'Not in a sub-zone'),
          h('span', { class: 'badge warn' }, `${direct.length} to place`)),
        h('p', { class: 'muted small' }, 'These cars were placed before the spot was split. Open a car and use Move to put it in a sub-zone.'),
        carList(direct, '')) : null,
    ];
  } else {
    body = carList(l.vehicles, 'No cars in this spot.');
  }

  append(el,
    h('div', { class: 'page-head' },
      h('div', {}, back,
        h('h1', { class: 'mono' }, l.code),
        h('div', { class: 'muted' }, [l.zone, l.description, l.active ? null : 'Inactive',
          l.children.length ? `${l.children.length} sub-zones` : null].filter(Boolean).join(' · '))),
      h('div', { class: 'spot-side' },
        h('div', { class: 'spot-count big' }, f.text),
        f.cls === 'bad' ? h('span', { class: 'badge bad' }, 'Full') : null)),
    meter(f),
    body);
}

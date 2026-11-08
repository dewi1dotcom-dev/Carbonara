// Storage: every spot with how full it is; tap a spot to see the cars in it.
import { api, fmtDate, h } from '../ui.js';
import { vehicleCard } from './vehicles.js';

const OFF_SITE = 'off-site';

function fill(l) {
  const n = l.vehicle_count ?? 0;
  if (!l.capacity) return { text: `${n} ${n === 1 ? 'car' : 'cars'}`, pct: null, cls: '' };
  const pct = Math.min(100, Math.round((n / l.capacity) * 100));
  return { text: `${n} / ${l.capacity} cars`, pct, cls: n >= l.capacity ? 'bad' : pct >= 80 ? 'warn' : 'good' };
}

function spotTile(l) {
  const f = fill(l);
  return h('a', { class: 'card spot-tile', href: `#/storage/${l.id}` },
    h('div', { class: 'spot-head' },
      h('span', { class: 'mono strong' }, l.code),
      f.cls === 'bad' ? h('span', { class: 'badge bad' }, 'Full') : null),
    l.description ? h('div', { class: 'muted small' }, l.description) : null,
    h('div', { class: 'spot-count' }, f.text),
    f.pct != null ? h('div', { class: `meter ${f.cls}` }, h('div', { style: { width: `${f.pct}%` } })) : null);
}

export async function storageView(el) {
  const [locs, offSite] = await Promise.all([api.get('/storage-locations'), api.get('/vehicles?status=off_site')]);
  const zones = new Map();
  for (const l of locs) {
    const z = l.zone || 'Other';
    if (!zones.has(z)) zones.set(z, []);
    zones.get(z).push(l);
  }
  const total = locs.reduce((s, l) => s + (l.vehicle_count ?? 0), 0);

  el.append(
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', {}, 'Storage'),
        h('div', { class: 'muted' }, `${total} ${total === 1 ? 'car' : 'cars'} in ${locs.length} ${locs.length === 1 ? 'spot' : 'spots'}`
          + (offSite.length ? ` · ${offSite.length} off site` : ''))),
      h('a', { class: 'small', href: '#/settings' }, 'Manage spots →')),
    locs.length ? null : h('div', { class: 'card notice warn' }, 'No storage spots yet. ',
      h('a', { href: '#/settings' }, 'Add spots in settings')),
    [...zones].map(([zone, list]) => h('section', {},
      h('h2', { class: 'zone-title' }, zone),
      h('div', { class: 'spot-grid' }, list.map(spotTile)))),
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
    el.append(
      h('div', { class: 'page-head' }, h('div', {}, back, h('h1', {}, 'Off site'),
        h('div', { class: 'muted' }, `${cars.length} ${cars.length === 1 ? 'car' : 'cars'}`))),
      h('div', { class: 'list' }, cars.length ? cars.map((v) => vehicleCard(v))
        : h('p', { class: 'empty' }, 'No cars are off site.')));
    return;
  }

  const l = await api.get(`/storage-locations/${id}`);
  const f = fill(l);
  el.append(
    h('div', { class: 'page-head' },
      h('div', {}, back,
        h('h1', { class: 'mono' }, l.code),
        h('div', { class: 'muted' }, [l.zone, l.description, l.active ? null : 'Inactive'].filter(Boolean).join(' · '))),
      h('div', { class: 'spot-side' },
        h('div', { class: 'spot-count big' }, f.text),
        f.cls === 'bad' ? h('span', { class: 'badge bad' }, 'Full') : null)),
    f.pct != null ? h('div', { class: `meter ${f.cls}` }, h('div', { style: { width: `${f.pct}%` } })) : null,
    h('div', { class: 'list' }, l.vehicles.length
      ? l.vehicles.map((v) => vehicleCard(v, `In spot since ${fmtDate(v.placed_at)}`))
      : h('p', { class: 'empty' }, 'No cars in this spot.')));
}

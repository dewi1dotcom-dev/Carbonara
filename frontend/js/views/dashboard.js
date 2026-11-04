import { api, fmtDate, h, vehicleTitle } from '../ui.js';

function inspectionCard(i) {
  const meta = i.status === 'in_progress'
    ? [`Started ${fmtDate(i.started_at)}`, i.inspector_name, `${i.angle_photos}/4 photos`,
      `${i.damage_count} damage${i.damage_count === 1 ? '' : 's'}`]
    : [`Stored ${fmtDate(i.completed_at)}`, i.location_code && `Spot ${i.location_code}`, i.inspector_name];
  return h('a', { class: 'card list-card', href: `#/inspections/${i.id}` },
    h('div', { class: 'list-main' },
      h('div', { class: 'list-title' }, vehicleTitle(i)),
      h('div', { class: 'vin mono' }, i.vin)),
    h('div', { class: 'list-meta' }, meta.filter(Boolean).join(' · ')));
}

export async function dashboardView(el) {
  const [open, done] = await Promise.all([
    api.get('/inspections?status=in_progress'),
    api.get('/inspections?status=completed&limit=10'),
  ]);

  el.append(
    h('div', { class: 'page-head' },
      h('h1', {}, 'Arrivals'),
      h('a', { class: 'btn primary big', href: '#/intake' }, '+ New arrival')),
    h('section', {},
      h('h2', {}, `In progress (${open.length})`),
      open.length
        ? h('div', { class: 'list' }, open.map(inspectionCard))
        : h('p', { class: 'empty' }, 'No arrival inspections in progress.')),
    h('section', {},
      h('h2', {}, 'Recently placed in storage'),
      done.length
        ? h('div', { class: 'list' }, done.map(inspectionCard))
        : h('p', { class: 'empty' }, 'Nothing yet.')),
  );
}

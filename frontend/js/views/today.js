// The start page ("Today board"): what needs doing today and tomorrow first,
// then what needs attention, then a few numbers.
import { lang } from '../i18n.js';
import { api, append, boardBlock as block, boardRow as row, carText, fmtDate, h, vehicleTitle } from '../ui.js';

const weekday = new Intl.DateTimeFormat(lang === 'no' ? 'nb-NO' : 'en-GB', { timeZone: 'Europe/Oslo', weekday: 'long' });
const clock = new Intl.DateTimeFormat('nb-NO', { timeZone: 'Europe/Oslo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

const since = (iso) => {
  const min = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`;
};
const inDays = (n) => (n < 0 ? `${-n} d overdue` : n === 0 ? 'today' : n === 1 ? 'tomorrow' : `in ${n} d`);

// withPrep: today/tomorrow also show whether the car is prepared (notification bar until it is).
const pdiRow = (o, withPrep = false) => row(`#/vehicles/${o.vehicle_id}`, carText(o),
  [o.pdi_at && clock.format(new Date(o.pdi_at)), o.location_code && `spot ${o.location_code}`,
    withPrep && (o.prepared_at ? '✓ prepared' : 'not prepared yet')].filter(Boolean).join(' · '),
  withPrep && !o.prepared_at ? 'bad' : '');

export async function todayView(el) {
  const d = await api.get('/dashboard');
  const n = d.numbers;
  const day = new Date(`${d.today}T12:00:00`);

  append(el,
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', {}, 'Today'),
        h('div', { class: 'muted' }, `${weekday.format(day)} ${fmtDate(d.today, false)}`)),
      h('a', { class: 'btn primary big', href: '#/intake' }, '+ New arrival')),

    // ---- today & tomorrow
    block('🔧', 'PDI tomorrow – make the car ready', d.pdi_tomorrow.map((o) => pdiRow(o, true)), { cls: 'warn' }),
    block('🔧', 'PDI today', d.pdi_today.map((o) => pdiRow(o, true)), { cls: 'info' }),
    block('⏰', 'PDI date passed – mark as done?', d.pdi_overdue.map((o) =>
      row(`#/vehicles/${o.vehicle_id}`, carText(o), `was ${fmtDate(o.pdi_at)}`)), { cls: 'bad' }),
    block('🔋', 'Storage checks due (new cars)', d.storage_due.map((s) =>
      row(`#/vehicles/${s.id}`, carText(s), s.kind === 'arrival' ? 'first storage check missing'
        : `${s.title} · ${s.in_days < 0 ? `${-s.in_days} d overdue` : s.in_days === 0 ? 'today' : `in ${s.in_days} d`}`,
      s.in_days < 0 || s.kind === 'arrival' ? 'bad' : '')), { cls: d.storage_due.some((s) => s.in_days < 0) ? 'bad' : '' }),
    block('🔑', 'Out on test drive', d.test_drives.map((t) => (t.plate_moved_at
      ? row(`#/test-drive?return=${t.id}`, carText(t), 'trade plates moved to another car – register the return', 'bad')
      : row('#/test-drive', carText(t), `${t.customer_name} · ${since(t.started_at)}`)))),
    block('📋', 'Arrivals in progress', d.arrivals.map((i) =>
      row(`#/inspections/${i.id}`, vehicleTitle(i), [i.inspector_name, `started ${fmtDate(i.started_at)}`].filter(Boolean).join(' · ')))),

    // ---- needs attention
    h('h2', { class: 'today-heading' }, 'Needs attention'),
    block('✉', 'PDI orders waiting for the workshop’s reply', d.pdi_waiting.map((o) =>
      row(`#/vehicles/${o.vehicle_id}`, carText(o), o.sent_via === 'print'
        ? `printed / PDF ${fmtDate(o.sent_at, false)} · enter the date when they reply`
        : `sent ${fmtDate(o.sent_at, false)} to ${o.sent_to} · enter the date when they reply`))),
    block('📝', 'PDI orders not sent yet', d.pdi_drafts.map((o) =>
      row(`#/vehicles/${o.vehicle_id}`, carText(o), `started ${fmtDate(o.created_at, false)}${o.created_by_name ? ` by ${o.created_by_name}` : ''}`))),
    block('🛂', 'EU-kontroll due', d.eu_control.map((c) =>
      row(`#/vehicles/${c.id}`, carText(c), `${fmtDate(c.due, false)} (${inDays(c.in_days)})`, c.in_days <= 1 ? 'bad' : ''))),
    block('🛠', 'Service due', d.service.map((c) =>
      row(`#/vehicles/${c.id}`, carText(c), `${fmtDate(c.due, false)} (${inDays(c.in_days)})`, c.in_days < -31 ? 'bad' : ''))),
    block('⚠', 'Statens vegvesen differences to check', d.registry_mismatches.map((c) =>
      row(`#/vehicles/${c.id}`, carText(c), 'open the car to confirm'))),
    !(d.pdi_waiting.length || d.pdi_drafts.length || d.eu_control.length || d.service.length || d.registry_mismatches.length)
      ? h('p', { class: 'empty' }, 'Nothing needs attention. 👍') : null,

    // ---- upcoming & numbers
    block('📅', 'Upcoming PDIs', d.pdi_upcoming.map((o) => row(`#/vehicles/${o.vehicle_id}`, carText(o),
      [fmtDate(o.pdi_at), o.location_code && `spot ${o.location_code}`].filter(Boolean).join(' · ')))),
    h('section', { class: 'today-tiles' },
      tile(n.in_storage, 'In storage', '#/storage'),
      tile(n.free_places, 'Free places', '#/storage'),
      tile(n.arrived_this_week, 'Arrived this week', '#/arrivals'),
      tile(n.pdi_this_week, 'PDIs this week', '#/pdi'),
      tile(n.ready_for_delivery, 'Ready for registration and delivery', '#/vehicles?status=ready')));
}

function tile(value, label, href) {
  const inner = [h('span', { class: 'tile-num' }, String(value ?? 0)), h('span', { class: 'tile-label muted small' }, label)];
  return href ? h('a', { class: 'card tile', href }, inner) : h('div', { class: 'card tile' }, inner);
}

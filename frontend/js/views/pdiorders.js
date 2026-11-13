// PDI orders page (#/pdi-orders): every car with a PDI order, from the order until the car
// is both marked as registered and taken off site. Car details, the right-side photo,
// the order, the PDI date (confirm / change, expected completion) and the car's history.
// No documents (contracts hold personal data; the server leaves their events out too).
import {
  api, append, canSee, CONDITION, fmtDate, fmtKm, h, photoUrl, pill, showError, tyreBadge, vehicleTitle, viewPhoto, WHEELS,
} from '../ui.js';
import { bookingDialog, confirmDate, confirmedText, itemsList, STATUS_CLS, STATUS_TEXT } from './pdi.js';
import { doneDialog, sheetActions } from './pdisheet.js';
import { EVENT_LABELS, eventDetail } from './vehicles.js';

// host: the page's real container (a redraw renders into a fresh div, then moves it into host).
export async function pdiOrdersView(el, _params = [], host = el) {
  const [orders, opts] = await Promise.all([api.get('/pdi/orders'), api.get('/pdi/options')]);
  const rerender = async () => {
    try {
      const fresh = h('div');
      await pdiOrdersView(fresh, [], host);
      host.replaceChildren(...fresh.childNodes);
    } catch (e) { showError(e); }
  };
  const open = orders.filter((o) => o.status !== 'done');
  const done = orders.filter((o) => o.status === 'done');

  append(el,
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', {}, 'PDI orders'),
        h('div', { class: 'muted' }, 'Cars with a PDI order, until they are registered and taken off site.'))),
    h('h2', { class: 'po-group' }, 'Open orders', h('span', { class: 'count' }, open.length)),
    open.length ? h('div', { class: 'po-list' }, open.map((o) => orderCard(o, opts, rerender)))
      : h('p', { class: 'empty' }, 'No open PDI orders.'),
    h('h2', { class: 'po-group' }, 'PDI done – waiting for registration or delivery', h('span', { class: 'count' }, done.length)),
    done.length ? h('div', { class: 'po-list' }, done.map((o) => orderCard(o, opts, rerender)))
      : h('p', { class: 'empty' }, 'No cars waiting.'));
}

function orderCard(o, opts, rerender) {
  const lines = itemsList(o, opts);
  const isOpen = o.status !== 'done' && o.status !== 'cancelled';
  const kv = (rows) => h('dl', { class: 'kv' },
    rows.filter(([, v]) => v).map(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]));

  return h('section', { class: 'card po-card' },
    h('div', { class: 'po-head' },
      h('div', { class: 'car-text' },
        h('h3', { class: 'list-title' }, vehicleTitle(o)),
        h('div', { class: 'car-reg mono' }, o.registration_number || 'No reg. no yet'),
        h('div', { class: 'vin mono' }, o.vin),
        h('div', { class: 'badges' },
          pill(o.vehicle_status),
          o.registered_marked_at ? h('span', { class: 'badge good' }, 'Registered') : h('span', { class: 'badge' }, 'Not registered yet'),
          tyreBadge(o.tyre_warning))),
      o.right_photo_id
        ? h('button', { class: 'car-photo po-photo', type: 'button', title: 'Right side', onClick: () => viewPhoto(o.right_photo_id, 'Right side') },
          h('img', { src: photoUrl(o.right_photo_id), alt: 'Right side', loading: 'lazy' }))
        : h('div', { class: 'car-photo' }, h('span', { class: 'car-photo-none muted small' }, 'No photo'))),
    kv([
      ['Colour', o.color], ['Fuel', o.fuel_type], ['New/used', CONDITION[o.condition]],
      ['Spot', o.location_code], ['Wheels', WHEELS[o.wheels]],
    ]),

    h('h3', {}, 'PDI order'),
    h('div', { class: 'pdi-status' },
      h('span', { class: `badge ${STATUS_CLS[o.status]}` }, STATUS_TEXT[o.status]),
      o.pdi_at && o.status !== 'done' ? h('strong', {}, fmtDate(o.pdi_at)) : null,
      confirmedText(o)),
    kv([
      ['PDI date', o.pdi_at && fmtDate(o.pdi_at)],
      ['Expected completion', o.expected_done_date && fmtDate(o.expected_done_date, false)],
      ['Ordered', `${fmtDate(o.created_at, false)}${o.created_by_name ? ` (${o.created_by_name})` : ''}`],
      ['Sent to the workshop', o.sent_at && (o.sent_via === 'print' ? `${fmtDate(o.sent_at)} (printed / PDF)` : fmtDate(o.sent_at))],
      ['PDI done', o.done_at && `${fmtDate(o.done_at)}${o.done_by_name ? ` (${o.done_by_name})` : ''}`],
      ['Mileage at the PDI', o.done_km != null && fmtKm(o.done_km)],
    ]),
    o.changed_since_sent ? h('div', { class: 'notice warn small' }, 'Changed since it was sent — send it again so the workshop has the latest order.') : null,
    o.prepared_at ? h('div', { class: 'notice small' },
      h('strong', {}, `✓ Prepared for the PDI ${fmtDate(o.prepared_at)}${o.prepared_by_name ? ` by ${o.prepared_by_name}` : ''}`),
      [o.prep_plate_name && `Trade plates: ${o.prep_plate_name}`, o.prep_note,
        o.prep_wheels_location && `Winter wheels: ${o.prep_wheels_location}`].filter(Boolean).map((t) => h('div', {}, t))) : null,
    lines.length ? h('ul', {}, lines.map((l) => h('li', {}, l))) : h('p', { class: 'muted' }, 'Nothing ordered.'),
    o.other ? h('p', {}, h('strong', {}, 'Other: '), o.other) : null,
    o.note ? h('p', { class: 'muted' }, `Note: ${o.note}`) : null,

    h('div', { class: 'actions' },
      canSee('vehicles') ? h('a', { class: 'btn', href: `#/vehicles/${o.vehicle_id}` }, 'Open car page') : null,
      isOpen ? h('button', { class: 'btn', type: 'button', onClick: () => bookingDialog(o, rerender) },
        o.pdi_at ? 'Change PDI date' : 'Enter PDI date') : null,
      o.status === 'booked' && !o.pdi_confirmed_at
        ? h('button', { class: 'btn primary', type: 'button', onClick: () => confirmDate(o, rerender) }, '✓ Confirm PDI date') : null,
      // Mileage, date, stamp and signature for the model's PDI sheet.
      o.status === 'booked' ? h('button', {
        class: o.pdi_confirmed_at ? 'btn primary' : 'btn', type: 'button', onClick: () => doneDialog(o, rerender),
      }, '✓ PDI done') : null,
      o.status === 'done' ? sheetActions(o, rerender) : null),

    h('details', { class: 'more' }, h('summary', {}, `History (${o.events.length})`),
      o.events.length ? h('ol', { class: 'timeline' }, o.events.map((e) => h('li', {},
        h('div', { class: 'tl-when muted small' }, fmtDate(e.occurred_at)),
        h('div', {}, h('strong', {}, EVENT_LABELS[e.event_type] ?? e.event_type), e.staff_name ? ` — ${e.staff_name}` : ''),
        h('div', { class: 'muted small' }, eventDetail(e)))))
        : h('p', { class: 'empty' }, 'No history.')));
}

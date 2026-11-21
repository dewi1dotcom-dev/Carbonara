// PDI orders page (#/pdi-orders): every car with a PDI order, from the order until the car
// is both marked as registered and taken off site. Car details, the right-side photo,
// the order, the PDI date (confirm / change, expected completion) and the car's history.
// No documents (contracts hold personal data; the server leaves their events out too).
import {
  api, append, busy, canSee, CONDITION, fmtDate, fmtKm, h, openDialog, photoUrl, pill, session, showError, toast, tyreBadge, vehicleTitle, viewPhoto, WHEELS,
} from '../ui.js';
import { bookingDialog, confirmDate, confirmedText, itemsList, STATUS_CLS, STATUS_TEXT, workOrderLine } from './pdi.js';
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

  // #/pdi-orders?car=<vehicle id> (from Today, for teams without the car pages): show that car's order.
  // Only on the first draw, not when the page redraws itself after an action.
  const car = el === host ? new URLSearchParams(location.hash.split('?')[1] || '').get('car') : null;
  if (car) {
    setTimeout(() => {
      const card = document.getElementById(`po-car-${car}`);
      if (!card) return;
      card.classList.add('po-focus');
      card.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }, 50);
  }
}

/* "Delivered" (0.35.3, the user's rule): confirm the delivery and/or the registration in one dialog.
 * - Delivered: off site with the note "Delivered" (the same as Move car → Off site).
 * - Registered: the same as "Mark as registered" on the car page (starts the Statens vegvesen sync).
 *   Ticked by default; not offered when the car is already marked as registered (by hand or by a sync
 *   that found it registered). */
function deliveredDialog(o, rerender) {
  const box = (checked) => h('input', { type: 'checkbox', checked });
  const deliver = o.vehicle_status !== 'off_site' ? box(true) : null;
  const register = o.registered_marked_at ? null : box(true);
  const ok = h('button', { class: 'btn primary', type: 'submit' }, 'Confirm');
  // A car shouldn't be handed over with an open recall (a warning, never a block).
  const recalls = (o.open_recalls || []).filter((r) => r.certainty === 'confirmed');
  const form = h('form', {},
    h('p', {}, h('strong', { translate: 'no' }, vehicleTitle(o)), ' ',
      h('span', { class: 'mono', translate: 'no' }, o.registration_number || o.vin)),
    deliver && recalls.length ? h('div', { class: 'notice bad' },
      h('strong', {}, 'This car has an open recall. Fix it before it is delivered.'),
      h('ul', {}, recalls.map((r) => h('li', { translate: 'no' }, [r.code, r.title].filter(Boolean).join(': '))))) : null,
    deliver ? h('label', { class: 'check' }, deliver, h('span', {}, 'Delivered to the customer – the car is taken off site'))
      : h('p', { class: 'muted' }, '✓ Already off site'),
    register ? h('label', { class: 'check' }, register, h('span', {}, 'Registered in Norway – mark the car as registered'))
      : h('p', { class: 'muted' }, h('span', {}, '✓ Already marked as registered'),
        o.registration_number ? h('span', { class: 'mono', translate: 'no' }, ` (${o.registration_number})`) : null),
    h('div', { class: 'actions' }, ok));
  const { close } = openDialog('Delivered', form);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const doDeliver = !!deliver?.checked;
    const doRegister = !!register?.checked;
    if (!doDeliver && !doRegister) { showError(new Error('Tick at least one')); return; }
    busy(ok, async () => {
      // Registration first: it fetches the reg. no from Statens vegvesen while the car is still here.
      if (doRegister) {
        await api.post(`/vehicles/${o.vehicle_id}/registered`, { staff_id: session.me?.id ?? null });
        register.checked = false; // done: a retry after a failed delivery mustn't mark it again
        register.disabled = true;
        o.registered_marked_at = new Date().toISOString();
      }
      if (doDeliver) await api.post(`/vehicles/${o.vehicle_id}/move`, { location_id: null, note: 'Delivered' });
      close();
      toast(doDeliver && doRegister ? 'Delivered and marked as registered'
        : doDeliver ? 'Delivered – the car is off site' : 'Marked as registered', 'success');
      await rerender();
    });
  });
}

function orderCard(o, opts, rerender) {
  const lines = itemsList(o, opts);
  const isOpen = o.status !== 'done' && o.status !== 'cancelled';
  const kv = (rows) => h('dl', { class: 'kv' },
    rows.filter(([, v]) => v).map(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]));

  return h('section', { class: 'card po-card', id: `po-car-${o.vehicle_id}` },
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
    workOrderLine(o, rerender),
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
    (o.open_recalls || []).length ? h('div', { class: 'notice warn small' },
      h('strong', {}, 'Open recalls – to be done during the PDI'),
      h('ul', {}, o.open_recalls.map((r) => h('li', { translate: 'no' },
        [r.code, r.title].filter(Boolean).join(': '), r.certainty === 'possible' ? ' (?)' : '')))) : null,
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
      o.status === 'done' ? sheetActions(o, rerender) : null,
      // Handed over / registered: a dialog with both (every car in this group still lacks one of them).
      o.status === 'done' ? h('button', { class: 'btn primary', type: 'button', onClick: () => deliveredDialog(o, rerender) },
        o.vehicle_status !== 'off_site' ? '✓ Delivered' : '✓ Registered') : null),

    h('details', { class: 'more' }, h('summary', {}, `History (${o.events.length})`),
      o.events.length ? h('ol', { class: 'timeline' }, o.events.map((e) => h('li', {},
        h('div', { class: 'tl-when muted small' }, fmtDate(e.occurred_at)),
        h('div', {}, h('strong', {}, EVENT_LABELS[e.event_type] ?? e.event_type), e.staff_name ? ` — ${e.staff_name}` : ''),
        h('div', { class: 'muted small' }, eventDetail(e)))))
        : h('p', { class: 'empty' }, 'No history.')));
}

// Customer car delivery.
//
// kioskView: the form customers fill in on the kiosk tablet when they drop off
// their car for the workshop (reg. no, name, phone, where the key is, a pin on
// a picture of the lot, tick boxes, message). On a kiosk tablet it is the whole
// app (no menu); staff can preview it at #/kiosk.
//
// deliveriesView (#/deliveries): what customers delivered, "Received", and the
// kiosk setup for admins (maps, key places, tick boxes, kiosk tablets).
import { lang, setLang } from '../i18n.js';
import {
  api, append, badge, busy, euStatus, fmtDate, h, nameInput, openDialog, session, showError, toast, vehicleTitle,
} from '../ui.js';

const IDLE_MS = 3 * 60 * 1000;   // a half-filled form is cleared when the customer walks away
const DONE_MS = 30 * 1000;       // the thank-you screen goes back to an empty form

const mapUrl = (id) => `/api/kiosk/maps/${id}/image`;

/** Label in the user's language: options ({label, label_no}), stored choices ({en, no}) and maps ({name, name_no}). */
export function optText(o) {
  if (!o) return '';
  const en = o.en ?? o.label ?? o.name;
  const no = o.no ?? o.label_no ?? o.name_no;
  return (lang === 'no' ? no || en : en || no) || '';
}

/** A map picture with the customer's pin on it (x, y = share of width / height). */
function mapWithPin(mapId, x, y, cls = '') {
  return h('div', { class: `map-wrap ${cls}` },
    h('img', { src: mapUrl(mapId), alt: '', loading: 'lazy', draggable: 'false' }),
    x != null && y != null ? h('span', { class: 'map-pin', style: { left: `${x * 100}%`, top: `${y * 100}%` } }) : null);
}

/** Tap the picture to drop the pin; onPick(x, y). */
function mapPicker(m, onPick) {
  const pin = h('span', { class: 'map-pin', hidden: true });
  const img = h('img', { src: mapUrl(m.id), alt: '', draggable: 'false' });
  const wrap = h('div', { class: 'map-wrap map-pick' }, img, pin);
  wrap.addEventListener('click', (e) => {
    const r = img.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    pin.hidden = false;
    pin.style.left = `${x * 100}%`;
    pin.style.top = `${y * 100}%`;
    onPick(x, y);
  });
  return wrap;
}

/** The privacy notice for customers delivering a car (GDPR art. 13), in Norwegian. Printable. */
export function deliveryPrivacyDialog(privacy, trashDays) {
  const lines = [['Telefon', privacy?.phone], ['E-post', privacy?.email], ['Adresse', privacy?.address]]
    .filter(([, v]) => v);
  const contact = lines.length
    ? h('p', { class: 'privacy-contact' }, lines.map(([label, v]) => h('span', { class: 'block' }, `${label}: `, h('strong', {}, v))))
    : h('p', {}, h('strong', { class: 'td-items' }, '[kontaktinfo mangler – legges inn under System → Firma]'));
  const company = privacy?.company || 'Forhandleren';
  const body = h('div', { class: 'privacy-text', translate: 'no' }, // a Norwegian document
    h('p', {}, h('strong', {}, company), ' er behandlingsansvarlig for opplysningene du registrerer når du leverer bilen din til oss.'),
    h('h3', {}, 'Hva vi registrerer'),
    h('p', {}, 'Registreringsnummer, navn og telefonnummer, hvor bilen står og hvor nøkkelen ligger, hva du krysser av for, og meldingen du skriver.'),
    h('h3', {}, 'Hvorfor'),
    h('p', {}, 'For å finne bilen og nøkkelen, utføre det du ber oss om, og kontakte deg om bilen.'),
    h('h3', {}, 'Rettslig grunnlag'),
    h('p', {}, 'Det er nødvendig for å utføre oppdraget du ber oss om (personvernforordningen art. 6 nr. 1 bokstav b).'),
    h('h3', {}, 'Hvor lenge'),
    h('p', {}, `Registreringen slettes automatisk ${trashDays} dager etter at vi har tatt imot bilen.`),
    h('h3', {}, 'Hvem som ser dem'),
    h('p', {}, 'Bare våre ansatte, som logger inn med personlig kode. Opplysningene lagres på vår egen server og deles ikke med andre.'),
    h('h3', {}, 'Dine rettigheter'),
    h('p', {}, 'Du kan be om innsyn, retting og sletting, og protestere mot behandlingen. '
      + 'Du kan også klage til Datatilsynet (datatilsynet.no). Kontakt oss:'),
    contact);
  const wrap = h('div', {}, body,
    h('div', { class: 'actions no-print' },
      h('button', { class: 'btn', type: 'button', onClick: () => window.print() }, '🖨 Print')));
  openDialog('Personvern – levering av bil', wrap, { wide: true });
}

// ---------------------------------------------------------------- the kiosk form

/**
 * standalone: this device is a kiosk tablet (no staff logged in); shows a
 * language switch and a "Staff login" link (onStaffLogin). Otherwise a staff
 * preview inside the app (#/kiosk).
 */
export async function kioskView(el, _params = [], { standalone = false, onStaffLogin = null } = {}) {
  const cfg = await api.get('/kiosk/config');
  const page = h('div', { class: 'kiosk' });
  el.replaceChildren(page);
  let idleTimer = null;
  let doneTimer = null;

  const frame = (...content) => page.replaceChildren(...[
    standalone ? null : h('div', { class: 'card notice' },
      h('span', {}, 'Preview of the kiosk form. A delivery sent from here is real and shows up for the staff. ',
        h('a', { href: '#/deliveries' }, 'Back to Customer deliveries'))),
    // Before anyone is logged in, the language follows the device; switchable here.
    standalone ? h('p', { class: 'small muted lang-switch', translate: 'no' },
      [['en', 'English'], ['no', 'Norsk']].map(([code, label]) => (code === lang
        ? h('strong', {}, label)
        : h('button', { class: 'link', type: 'button', onClick: () => { setLang(code); location.reload(); } }, label)))) : null,
    ...content,
    standalone && onStaffLogin ? h('p', { class: 'kiosk-foot' },
      h('button', { class: 'link small', type: 'button', onClick: () => { clearTimeout(idleTimer); clearTimeout(doneTimer); onStaffLogin(); } },
        'Staff login')) : null,
  ].filter(Boolean));

  function renderForm() {
    clearTimeout(doneTimer);
    clearTimeout(idleTimer);
    let mapId = cfg.maps.length === 1 ? cfg.maps[0].id : null;
    let pin = null; // {x, y}

    const reg = h('input', {
      type: 'text', id: 'kd-reg', class: 'kiosk-reg', required: true, maxlength: 12, autocomplete: 'off',
      autocapitalize: 'characters', spellcheck: 'false', placeholder: 'AB 12345',
    });
    const name = nameInput({ id: 'kd-name', required: true, maxlength: 120, autocomplete: 'off' });
    const phone = h('input', { type: 'tel', id: 'kd-phone', required: true, maxlength: 20, inputmode: 'tel', autocomplete: 'off', placeholder: 'e.g. 912 34 567' });
    const message = h('textarea', { id: 'kd-msg', rows: 3, maxlength: 1000 });
    const keyRadios = cfg.key_places.map((o) => h('input', { type: 'radio', name: 'kd-key', value: o.id }));
    const checkBoxes = cfg.checkboxes.map((o) => h('input', { type: 'checkbox', value: o.id }));

    // Several locations: choose one first, then tap its map.
    const mapSlot = h('div');
    const drawMap = () => {
      const m = cfg.maps.find((x) => x.id === mapId);
      mapSlot.replaceChildren(...(m ? [
        h('p', { class: 'muted small' }, 'Tap the map where you parked the car.'),
        mapPicker(m, (x, y) => { pin = { x, y }; }),
      ] : []));
    };
    const locChips = cfg.maps.length > 1 ? cfg.maps.map((m) => {
      const r = h('input', { type: 'radio', name: 'kd-loc', value: m.id });
      r.addEventListener('change', () => { mapId = m.id; pin = null; drawMap(); });
      return h('label', { class: 'chip' }, r, h('span', { translate: 'no' }, optText(m)));
    }) : [];
    drawMap();

    const submit = h('button', { class: 'btn primary big', type: 'submit' }, 'Register delivery');
    const form = h('form', { class: 'card kiosk-card', autocomplete: 'off' },
      h('h1', {}, 'Deliver your car'),
      h('p', { class: 'muted' }, 'Register the car you are leaving with us. It only takes a minute.'),
      h('div', { class: 'field' }, h('label', { for: 'kd-reg' }, 'Registration number'), reg),
      h('div', { class: 'grid' },
        h('div', { class: 'field' }, h('label', { for: 'kd-name' }, 'Your name'), name),
        h('div', { class: 'field' }, h('label', { for: 'kd-phone' }, 'Phone number'), phone)),
      cfg.key_places.length ? h('div', { class: 'field' }, h('label', {}, 'Where did you leave the key?'),
        h('div', { class: 'chips' }, cfg.key_places.map((o, i) =>
          h('label', { class: 'chip' }, keyRadios[i], h('span', { translate: 'no' }, optText(o)))))) : null,
      cfg.maps.length ? h('div', { class: 'field' }, h('label', {}, 'Where is the car parked?'),
        locChips.length ? h('div', { class: 'chips' }, locChips) : null,
        mapSlot) : null,
      cfg.checkboxes.length ? h('div', { class: 'field' }, h('label', {}, 'Tick what applies'),
        h('div', { class: 'chips' }, cfg.checkboxes.map((o, i) =>
          h('label', { class: 'chip' }, checkBoxes[i], h('span', { translate: 'no' }, optText(o)))))) : null,
      h('div', { class: 'field' }, h('label', { for: 'kd-msg' }, 'Message to the workshop (optional)'), message),
      h('p', { class: 'muted small' },
        `We use your name and phone number only to contact you about the car. The registration is deleted ${cfg.trash_days} days after we have received the car. `,
        h('button', { class: 'link', type: 'button', onClick: () => deliveryPrivacyDialog(cfg.privacy, cfg.trash_days) },
          'Read the privacy notice')),
      h('div', { class: 'actions' }, submit));

    // Walked away halfway: clear the form (the next customer must not see the details).
    const bump = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => { if (form.isConnected) renderForm(); }, IDLE_MS);
    };
    form.addEventListener('input', bump);
    form.addEventListener('click', bump);

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const key = keyRadios.find((r) => r.checked);
      if (cfg.key_places.length && !key) { toast('Choose where you left the key', 'error'); return; }
      if (cfg.maps.length && !mapId) { toast('Choose where the car is parked', 'error'); return; }
      if (cfg.maps.length && !pin) { toast('Tap the map where the car is parked', 'error'); return; }
      busy(submit, async () => {
        await api.post('/kiosk/deliveries', {
          registration_number: reg.value,
          customer_name: name.value,
          customer_phone: phone.value,
          map_id: mapId,
          pin_x: pin ? pin.x : null,
          pin_y: pin ? pin.y : null,
          key_place_id: key ? Number(key.value) : null,
          check_ids: checkBoxes.filter((b) => b.checked).map((b) => Number(b.value)),
          message: message.value.trim() || null,
        });
        clearTimeout(idleTimer);
        renderDone(reg.value, key ? cfg.key_places.find((o) => String(o.id) === key.value) : null);
      });
    });

    frame(form);
    window.scrollTo(0, 0); // the next customer starts at the top
    // Not on the tablet itself: the keyboard would pop up every time the form resets.
    if (!standalone) reg.focus();
  }

  function renderDone(regText, keyOpt) {
    const done = h('button', { class: 'btn big', type: 'button', onClick: () => renderForm() }, 'Done');
    const card = h('div', { class: 'card kiosk-card kiosk-done' },
      h('div', { class: 'kiosk-check', 'aria-hidden': 'true' }, '✓'),
      h('h1', {}, 'Thank you!'),
      h('p', {}, 'We have registered your car ', h('strong', { class: 'mono' }, regText.toUpperCase().replace(/[^\p{L}\p{N}]/gu, '')), '.'),
      keyOpt ? h('p', {}, 'Remember to leave the key here: ', h('strong', { translate: 'no' }, optText(keyOpt))) : null,
      h('p', { class: 'muted' }, 'We will contact you if we have any questions.'),
      h('div', { class: 'actions' }, done));
    frame(card);
    window.scrollTo(0, 0); // the button was at the bottom of a long form; show the thank-you from the top
    doneTimer = setTimeout(() => { if (card.isConnected) renderForm(); }, DONE_MS);
  }

  renderForm();
}

// ---------------------------------------------------------------- staff: deliveries

// How the name the customer typed compares with the owner's name from Statens vegvesen
// (server: common.name_match). 'same' needs no badge.
const NAME_MATCH = {
  similar: { cls: '', text: 'Similar to the typed name' },
  different: { cls: 'warn', text: 'Different from the typed name' },
  company: { cls: '', text: 'Company car' },
};

/**
 * Customer name + phone, and what Statens vegvesen says about the car (VIN,
 * EU-kontroll). The SVV owner's name, once SVV sends it, is shown first; the
 * name the customer typed stays visible when it differs. Redraws itself after
 * "Look up again".
 */
function customerAndRegistry(first) {
  const slot = h('div', { class: 'delivery-svv' });
  const draw = (d) => {
    const look = h('button', {
      class: 'link small', type: 'button',
      onClick: () => busy(look, async () => draw(await api.post(`/deliveries/${d.id}/registry`))),
    }, '↻ Look up again');
    const eu = euStatus(d.svv_eu_due);
    const car = [d.svv_make, d.svv_model].filter(Boolean).join(' ');
    let svv;
    if (d.svv_status === 'ok') {
      svv = h('div', { class: 'small' },
        h('span', {}, 'Statens vegvesen: '), car ? h('span', { translate: 'no' }, `${car} · `) : null,
        h('span', {}, 'VIN: '), h('span', { class: 'mono' }, d.svv_vin || '–'),
        d.svv_eu_due ? [h('span', {}, ' · '), h('span', {}, 'EU-kontroll: '), h('strong', {}, fmtDate(d.svv_eu_due, false)), ' ', badge(eu)] : null,
        ' ', look);
    } else {
      const text = {
        not_found: 'Not found at Statens vegvesen – check the registration number',
        error: 'Statens vegvesen lookup failed',
        not_configured: 'Statens vegvesen is not set up (System page)',
      }[d.svv_status] || 'Not looked up at Statens vegvesen yet';
      svv = h('div', { class: `small ${d.svv_status === 'not_found' ? 'warn-text' : 'muted'}` },
        h('span', { title: d.svv_error || '' }, text), ' ', d.svv_status === 'not_configured' ? null : look);
    }
    const match = NAME_MATCH[d.name_match];
    slot.replaceChildren(...[
      h('div', {}, h('span', { translate: 'no' }, d.display_name || d.customer_name), ' · ',
        h('a', { href: `tel:${d.customer_phone}` }, d.customer_phone)),
      d.svv_name ? h('div', { class: 'small muted' }, h('span', {}, 'Name from Statens vegvesen'),
        match ? [' ', badge(match)] : null,
        d.name_match !== 'same' ? h('span', { class: 'block' }, h('span', {}, 'Typed by the customer: '),
          h('span', { translate: 'no' }, d.customer_name)) : null) : null,
      svv,
    ].filter(Boolean));
  };
  draw(first);
  return slot;
}

function deliveryDetails(d) {
  return [
    h('div', { class: 'list-title' }, h('span', { class: 'mono strong delivery-reg' }, d.registration_number),
      // The car is linked when it is in Carbonara (same reg. no, or the VIN from Statens vegvesen).
      d.vehicle_id && d.make ? [' ', h('a', { href: `#/vehicles/${d.vehicle_id}` }, vehicleTitle(d))] : null),
    customerAndRegistry(d),
    h('div', { class: 'muted small' }, `Delivered ${fmtDate(d.created_at)}`,
      d.kiosk_name ? h('span', { translate: 'no' }, ` · ${d.kiosk_name}`) : null),
    d.key_place ? h('div', {}, 'Key: ', h('strong', { translate: 'no' }, optText(d.key_place))) : null,
    d.checks?.length ? h('div', { class: 'chips delivery-checks' },
      d.checks.map((c) => h('span', { class: 'badge', translate: 'no' }, optText(c)))) : null,
    d.message ? h('blockquote', { class: 'delivery-msg', translate: 'no' }, d.message) : null,
    d.map_id ? h('div', { class: 'delivery-map' },
      h('div', { class: 'small muted' }, 'Parked: ', h('span', { translate: 'no' }, optText({ name: d.map_name, name_no: d.map_name_no }))),
      h('button', { class: 'map-btn', type: 'button', 'aria-label': 'Enlarge the map', onClick: () => openMap(d) },
        mapWithPin(d.map_id, d.pin_x, d.pin_y))) : null,
  ];
}

function openMap(d) {
  openDialog(d.registration_number, h('div', { class: 'photo-view' },
    mapWithPin(d.map_id, d.pin_x, d.pin_y, 'map-large')), { wide: true });
}

export async function deliveriesView(el) {
  const data = await api.get('/deliveries');
  const admin = !!session.me?.is_admin;
  const rerender = async () => {
    try {
      const fresh = h('div');
      await deliveriesView(fresh);
      el.replaceChildren(...fresh.childNodes);
    } catch (e) { showError(e); }
  };

  const openCard = (d) => {
    const receive = h('button', {
      class: 'btn primary', type: 'button',
      onClick: () => {
        if (!confirm(`Have you got the car and the key for ${d.registration_number}?\n\n`
          + `The delivery, with the customer's name and phone number, is deleted automatically ${data.trash_days} days from now.`)) return;
        busy(receive, async () => {
          await api.post(`/deliveries/${d.id}/receive`);
          toast(`${d.registration_number} received`, 'success');
          await rerender();
        });
      },
    }, '✓ Received');
    return h('div', { class: 'card inner delivery-card' },
      h('div', { class: 'delivery-main' }, deliveryDetails(d)),
      h('div', { class: 'delivery-actions' }, receive));
  };

  const receivedRow = (d) => h('li', {},
    h('span', {}, h('span', { class: 'mono strong' }, d.registration_number), ' ', h('span', { translate: 'no' }, d.display_name || d.customer_name),
      h('span', { class: 'muted small block' }, `Received ${fmtDate(d.received_at)}`,
        d.received_by_name ? h('span', {}, ` by ${d.received_by_name}`) : null,
        h('span', {}, ` · deleted automatically ${fmtDate(d.purge_at, false)}`))),
    h('span', { class: 'row-actions' },
      h('button', { class: 'link', type: 'button', onClick: () => openDialog(d.registration_number, h('div', {}, deliveryDetails(d))) }, 'Show'),
      h('button', {
        class: 'link danger', type: 'button',
        onClick: async () => {
          if (!confirm(`Delete the delivery of ${d.registration_number} now, with the customer's details?`)) return;
          try {
            await api.del(`/deliveries/${d.id}`);
            toast(`${d.registration_number} deleted`, 'success');
            await rerender();
          } catch (e) { showError(e); }
        },
      }, 'Delete now')));

  append(el,
    h('div', { class: 'page-head' }, h('h1', {}, 'Customer deliveries'),
      h('a', { class: 'btn', href: '#/kiosk' }, 'Open the kiosk form')),
    h('section', { class: 'card' },
      h('h2', {}, `Waiting to be received (${data.open.length})`),
      data.open.length
        ? h('div', { class: 'list' }, data.open.map(openCard))
        : h('p', { class: 'empty' }, 'No customer cars waiting.')),
    h('section', { class: 'card' },
      h('h2', {}, `Received (${data.received.length})`),
      h('p', { class: 'muted small' },
        `Received deliveries are deleted automatically ${data.trash_days} days after they were received, with the customer's details.`),
      data.received.length
        ? h('ul', { class: 'plain rows' }, data.received.map(receivedRow))
        : h('p', { class: 'empty' }, 'None.')),
    admin ? await setupSection()
      : h('p', { class: 'muted small' }, 'An administrator sets up the kiosk (maps, key places, tick boxes, tablets) on this page.'));
}

// ---------------------------------------------------------------- admin: kiosk setup

async function setupSection() {
  const box = h('div');
  const redraw = async () => { try { await draw(); } catch (e) { showError(e); } };

  async function draw() {
    const [maps, options, kiosks] = await Promise.all([
      api.get('/delivery-maps'), api.get('/delivery-options'), api.get('/kiosk-devices')]);
    box.replaceChildren(
      h('h2', { class: 'today-heading' }, 'Kiosk setup'),
      mapsCard(maps), optionsCard(options, 'key_place'), optionsCard(options, 'checkbox'), kiosksCard(kiosks));
  }

  function mapsCard(maps) {
    const name = h('input', { type: 'text', placeholder: 'Location name, e.g. Main lot', required: true, maxlength: 80 });
    const nameNo = h('input', { type: 'text', placeholder: 'Norwegian name (optional)', maxlength: 80 });
    const file = h('input', { type: 'file', accept: 'image/*', required: true });
    const add = h('button', { class: 'btn primary', type: 'submit' }, 'Add map');
    const form = h('form', { class: 'inline-form wrap' }, name, nameNo, file, add);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!file.files[0]) return;
      busy(add, async () => {
        const fd = new FormData();
        fd.append('name', name.value);
        if (nameNo.value.trim()) fd.append('name_no', nameNo.value);
        fd.append('file', file.files[0]);
        await api.postForm('/delivery-maps', fd);
        toast('Map added', 'success');
        await redraw();
      });
    });
    const patch = async (m, body) => {
      try { await api.patch(`/delivery-maps/${m.id}`, body); await redraw(); } catch (e) { showError(e); }
    };
    return h('section', { class: 'card' },
      h('h2', {}, 'Maps (locations)'),
      h('p', { class: 'muted small' },
        'One picture per location: a drone photo, a screenshot of the lot or a simple drawing, seen from above. '
        + 'Customers tap where they parked. With several maps, they choose the location first. '
        + 'To change a picture, add a new map and remove the old one. Pictures from map services (Google, norgeskart.no) may have licence terms.'),
      maps.length
        ? h('ul', { class: 'plain rows list-edit' }, maps.map((m) => h('li', { class: m.active ? '' : 'inactive' },
          h('span', { class: 'map-row' },
            h('img', { class: 'map-mini', src: mapUrl(m.id), alt: '' }),
            h('span', {},
              h('span', { translate: 'no' }, m.name), m.name_no ? h('span', { class: 'muted small', translate: 'no' }, ` / ${m.name_no}`) : null,
              m.active ? null : h('span', {}, ' (removed)'),
              h('span', { class: 'muted small block' }, m.used === 1 ? 'Used by 1 delivery' : `Used by ${m.used} deliveries`))),
          h('span', { class: 'row-actions' },
            h('button', {
              class: 'link', type: 'button',
              onClick: () => {
                const n = prompt('Name (English)', m.name);
                if (n == null || !n.trim()) return;
                const nn = prompt('Name (Norwegian, optional)', m.name_no ?? '');
                if (nn == null) return;
                patch(m, { name: n, name_no: nn });
              },
            }, 'Rename'),
            h('button', { class: 'link', type: 'button', onClick: () => patch(m, { active: !m.active }) }, m.active ? 'Remove' : 'Restore'),
            m.used ? null : h('button', {
              class: 'link danger', type: 'button',
              onClick: async () => {
                if (!confirm(`Delete ${m.name}?`)) return;
                try { await api.del(`/delivery-maps/${m.id}`); await redraw(); } catch (e) { showError(e); }
              },
            }, 'Delete')))))
        : h('p', { class: 'empty' }, 'No maps yet. Without a map, customers are not asked where the car is parked.'),
      form);
  }

  function optionsCard(options, kind) {
    const list = options.filter((o) => o.kind === kind);
    const en = h('input', { type: 'text', placeholder: 'English text', required: true, maxlength: 80 });
    const no = h('input', { type: 'text', placeholder: 'Norwegian text', required: true, maxlength: 80 });
    const add = h('button', { class: 'btn primary', type: 'submit' }, 'Add');
    const form = h('form', { class: 'inline-form wrap' }, en, no, add);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      busy(add, async () => {
        await api.post('/delivery-options', { kind, label: en.value, label_no: no.value });
        await redraw();
      });
    });
    const patch = async (o, body) => {
      try { await api.patch(`/delivery-options/${o.id}`, body); await redraw(); } catch (e) { showError(e); }
    };
    return h('section', { class: 'card' },
      h('h2', {}, kind === 'key_place' ? 'Key places' : 'Tick boxes'),
      h('p', { class: 'muted small' }, kind === 'key_place'
        ? 'Where customers can leave the key. They choose one. Each text in English and Norwegian (the customer’s language is shown).'
        : 'Tick boxes on the form, e.g. what the car is in for. Customers tick any number. Each text in English and Norwegian.'),
      list.length
        ? h('ul', { class: 'plain rows list-edit' }, list.map((o) => h('li', { class: o.active ? '' : 'inactive' },
          h('span', {}, h('span', { translate: 'no' }, o.label, h('span', { class: 'muted small' }, ` / ${o.label_no}`)),
            o.active ? null : h('span', {}, ' (removed)')),
          h('span', { class: 'row-actions' },
            h('button', {
              class: 'link', type: 'button',
              onClick: () => {
                const a = prompt('English text', o.label);
                if (a == null || !a.trim()) return;
                const b = prompt('Norwegian text', o.label_no);
                if (b == null || !b.trim()) return;
                patch(o, { label: a, label_no: b });
              },
            }, 'Edit'),
            h('button', { class: 'link', type: 'button', onClick: () => patch(o, { active: !o.active }) }, o.active ? 'Remove' : 'Restore')))))
        : h('p', { class: 'empty' }, kind === 'key_place'
          ? 'No key places. Customers are not asked where the key is.' : 'No tick boxes.'),
      form);
  }

  function kiosksCard(kiosks) {
    const revoke = async (k) => {
      if (!confirm(`Stop ${k.name} from showing the delivery form?`)) return;
      try { await api.del(`/kiosk-devices/${k.id}`); await redraw(); } catch (e) { showError(e); }
    };
    return h('section', { class: 'card' },
      h('h2', {}, 'Kiosk tablets'),
      h('p', { class: 'muted small' },
        'A kiosk tablet shows only the delivery form, with no login. To set one up, log in on the tablet as an administrator, '
        + 'open this page and press the button below. You are then logged out on the tablet.'),
      kiosks.length
        ? h('ul', { class: 'plain rows' }, kiosks.map((k) => h('li', { class: k.revoked_at ? 'inactive' : '' },
          h('span', {}, h('span', { translate: 'no' }, k.name), ' ',
            k.revoked_at ? h('span', { class: 'badge' }, 'Stopped') : null,
            h('span', { class: 'muted small block' }, `Set up ${fmtDate(k.created_at, false)}`,
              k.created_by_name ? h('span', {}, ` by ${k.created_by_name}`) : null,
              k.last_seen_at ? h('span', {}, ` · last used ${fmtDate(k.last_seen_at)}`) : null)),
          k.revoked_at ? null : h('span', { class: 'row-actions' },
            h('button', { class: 'link danger', type: 'button', onClick: () => revoke(k) }, 'Stop')))))
        : h('p', { class: 'empty' }, 'No kiosk tablets yet.'),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', type: 'button', onClick: kioskDialog }, 'Use this device as the delivery kiosk')));
  }

  function kioskDialog() {
    const name = h('input', { type: 'text', id: 'kiosk-name', required: true, maxlength: 60, placeholder: 'e.g. Tablet at the key drop' });
    const ok = h('button', { class: 'btn primary', type: 'submit' }, 'Make this device a kiosk');
    const form = h('form', {},
      h('p', {}, 'This device will show only the customer delivery form. You are logged out here, and the rest of Carbonara '
        + 'can only be opened again by logging in (the "Staff login" link at the bottom of the form).'),
      h('div', { class: 'field' }, h('label', { for: 'kiosk-name' }, 'Name of this device'), name),
      h('div', { class: 'actions' }, ok));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      busy(ok, async () => {
        await api.post('/kiosk-devices', { name: name.value });
        location.hash = '#/';
        location.reload();
      });
    });
    openDialog('Delivery kiosk', form);
    name.focus();
  }

  await draw();
  return box;
}

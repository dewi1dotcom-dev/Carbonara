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
  api, append, badge, busy, canOpen, debounce, euStatus, fmtDate, h, nameInput, openDialog, session, showError, toast,
  vehicleTitle,
} from '../ui.js';
import { newWorkOrderDialog } from './workorders.js';

const IDLE_MS = 3 * 60 * 1000;   // a half-filled form is cleared when the customer walks away
const DONE_MS = 30 * 1000;       // the thank-you screen goes back to an empty form
const SHOW_KIOSKS = 3;           // kiosk tablets listed before "More tablets"
const KIOSK_KEEP_DAYS = 30;      // stopped tablets are deleted after this (deliveries.KIOSK_KEEP_STOPPED_DAYS)

const mapUrl = (id) => `/api/kiosk/maps/${id}/image`;

/** Language of a kiosk tablet (Customer deliveries → Kiosk tablets). */
const langSelect = (value, id) => {
  const sel = h('select', { id }, h('option', { value: 'no' }, 'Norwegian'), h('option', { value: 'en' }, 'English'));
  sel.value = value || 'no';
  return sel;
};

/** Label in the user's language: options ({label, label_no}), stored choices ({en, no}) and maps ({name, name_no}). */
export function optText(o) {
  if (!o) return '';
  const en = o.en ?? o.label ?? o.name;
  const no = o.no ?? o.label_no ?? o.name_no;
  return (lang === 'no' ? no || en : en || no) || '';
}

/** A map picture with the customer's pin on it (x, y = share of width / height). */
export function mapWithPin(mapId, x, y, cls = '') {
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
    : h('p', {}, h('strong', { class: 'td-items' }, privacy?.source === 'delivery'
      ? '[kontaktinfo mangler – legges inn under System → Kundeleveringer (kiosk)]'
      : '[kontaktinfo mangler – legges inn under System → Firma eller Kundeleveringer (kiosk)]'));
  const company = privacy?.company || 'Forhandleren';
  // Two companies under one roof: the kiosk company owns the data, the company
  // running Carbonara stores it for them (data processor, GDPR art. 28).
  const operator = privacy?.operator;
  const whoSees = operator
    ? h('p', {}, `Bare ansatte hos ${company} og ${operator} som har tilgang til systemet, og som logger inn med personlig kode. `
      + `Opplysningene lagres på en server som ${operator} drifter på vegne av ${company} (databehandler), og deles ikke med andre.`)
    : h('p', {}, 'Bare våre ansatte, som logger inn med personlig kode. Opplysningene lagres på vår egen server og deles ikke med andre.');
  const body = h('div', { class: 'privacy-text', translate: 'no' }, // a Norwegian document
    h('p', {}, h('strong', {}, company), privacy?.org_no ? ` (org.nr. ${privacy.org_no})` : '', ' er behandlingsansvarlig for opplysningene du registrerer når du leverer bilen din til oss.'),
    h('h3', {}, 'Hva vi registrerer'),
    h('p', {}, 'Registreringsnummer, navn og telefonnummer, hvor bilen står og hvor nøkkelen ligger, hva du krysser av for, og meldingen du skriver.'),
    h('p', {}, 'For en bil vi ikke har registrert fra før: navnet og adressen til bilens eier, og fornavnet til den som leverer '
      + 'bilen hvis det ikke er eieren. Telefonnummeret kan da være til den som leverer.'),
    h('h3', {}, 'Hvorfor'),
    h('p', {}, 'For å finne bilen og nøkkelen, vite hvem som eier bilen vi jobber på, utføre det du ber oss om, og kontakte deg om bilen.'),
    h('p', {}, 'Har du time hos oss, vises registreringsnummeret ditt på nettbrettet fra kl. 07.00 virkedagen før timen og ut timedagen, slik at '
      + 'du kan velge bilen din. Når du trykker på bilen, fylles navnet og telefonnummeret vi har registrert inn i skjemaet, '
      + 'slik at du kan kontrollere og rette dem.'),
    h('h3', {}, 'Rettslig grunnlag'),
    h('p', {}, 'Det er nødvendig for å utføre oppdraget du ber oss om (personvernforordningen art. 6 nr. 1 bokstav b).'),
    h('h3', {}, 'Hvor lenge'),
    h('p', {}, `Registreringen slettes automatisk ${trashDays} dager etter at vi har tatt imot bilen.`),
    h('h3', {}, 'Hvem som ser dem'),
    whoSees,
    h('h3', {}, 'Dine rettigheter'),
    h('p', {}, 'Du kan be om innsyn, retting og sletting, og protestere mot behandlingen. '
      + `Du kan også klage til Datatilsynet (datatilsynet.no). Kontakt ${operator ? company : 'oss'}:`),
    contact);
  const wrap = h('div', {}, body,
    h('div', { class: 'actions no-print' },
      h('button', { class: 'btn', type: 'button', onClick: () => window.print() }, '🖨 Print')));
  openDialog('Personvern – levering av bil', wrap, { wide: true });
}

// ---------------------------------------------------------------- the kiosk form

/* Full screen on the kiosk tablet. Browsers only allow it after a tap (never on page load), so
 * every tap on the kiosk form asks for it while the page isn't full screen: the first customer
 * touch, and again after a reload (language change) or someone swiping out of it.
 * iPhones have no full screen for pages; iPads use webkit. */
let fullscreenOn = false;
function askFullscreen() {
  if (document.fullscreenElement || document.webkitFullscreenElement) return;
  const root = document.documentElement;
  const req = root.requestFullscreen || root.webkitRequestFullscreen;
  if (!req) return;
  try {
    const p = req.call(root, { navigationUI: 'hide' });
    if (p?.catch) p.catch(() => {}); // refused (e.g. not allowed in this browser): just stay as is
  } catch { /* old webkit throws instead */ }
}
function kioskFullscreen() {
  if (fullscreenOn) return;
  fullscreenOn = true;
  document.addEventListener('pointerdown', askFullscreen, true);
}

/* The kiosk tablet has no language switch and no staff login (0.33.12, the user's rule): admins set
 * its language on the Customer deliveries page, and "Stop" there turns it back into a normal device.
 * The tablet checks the server every minute and reloads for either, but never while a customer is
 * filling in the form or reading the thank-you. */
const KIOSK_CHECK_MS = 60 * 1000;

/**
 * standalone: this device is a kiosk tablet (no staff logged in). Otherwise a staff
 * preview inside the app (#/kiosk), in the staff member's own language.
 */
export async function kioskView(el, _params = [], { standalone = false } = {}) {
  const cfg = await api.get('/kiosk/config');
  const page = h('div', { class: 'kiosk' });
  el.replaceChildren(page);
  let idleTimer = null;
  let doneTimer = null;
  let inUse = false; // a customer has touched the form, or the thank-you is showing

  if (standalone) {
    kioskFullscreen();
    const check = async () => {
      if (!page.isConnected) return;
      if (!inUse) {
        try {
          const st = await api.get('/auth/state');
          if (!page.isConnected || inUse) { /* changed while asking */ } else if (st.me || !st.kiosk) {
            location.reload(); return; // stopped (or someone logged in): boot() shows the right screen
          } else if (st.kiosk.language && st.kiosk.language !== lang) {
            setLang(st.kiosk.language); location.reload(); return;
          }
        } catch { /* server away: try again next time */ }
      }
      setTimeout(check, KIOSK_CHECK_MS);
    };
    setTimeout(check, KIOSK_CHECK_MS);
  }

  /* On-screen keyboard: keep the "Register delivery" button visible above it while typing (the message
   * field is right above it, and the keyboard covered the button). 0.33.14 scrolled the page from code,
   * which brought the browser's address bar back and was off by the bar's height the next time. Now
   * nothing is scrolled by us:
   * - On the tablet, the keyboard shrinks the page (interactive-widget=resizes-content, Chrome / Android),
   *   so the browser itself scrolls the field into view above the keyboard.
   * - While the message field has focus, the button row sticks to the bottom of what is visible (.typing).
   *   Browsers that lay the keyboard over the page (e.g. iPad) lift it by the hidden part (--kb).
   *   0.60.2 (the user's report: the button jumped up and floated when a text box was tapped): only for the message
   *   field, which sits right above the button; for the fields higher up (reg. no., name, phone) the button stays in
   *   its place in the form instead of floating over it. */
  if (standalone) {
    const meta = document.querySelector('meta[name=viewport]');
    if (meta && !meta.content.includes('interactive-widget')) meta.content += ', interactive-widget=resizes-content';
  }
  const vv = window.visualViewport;
  const onKeyboard = () => {
    if (!page.isConnected) { vv?.removeEventListener('resize', onKeyboard); return; }
    const form = page.querySelector('form.kiosk-card');
    if (!form) return;
    const field = document.activeElement;
    const inForm = !!field?.closest?.('form.kiosk-card');
    // Tapping the stuck button itself must not drop it back down mid-tap (the click would miss).
    const typing = inForm && (field.matches('textarea')
      || (form.classList.contains('typing') && !!field.closest('.actions')));
    const hidden = vv ? Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)) : 0;
    form.classList.toggle('typing', typing);
    form.style.setProperty('--kb', `${typing ? hidden : 0}px`);
  };
  vv?.addEventListener('resize', onKeyboard);
  page.addEventListener('focusin', onKeyboard);
  page.addEventListener('focusout', () => setTimeout(onKeyboard, 0)); // focus has moved on by then

  const frame = (...content) => page.replaceChildren(...[
    standalone ? null : h('div', { class: 'card notice' },
      h('span', {}, 'Preview of the kiosk form. A delivery sent from here is real and shows up for the staff. ',
        h('a', { href: '#/deliveries' }, 'Back to Customer deliveries'))),
    ...content,
  ].filter(Boolean));

  function renderForm() {
    clearTimeout(doneTimer);
    clearTimeout(idleTimer);
    inUse = false;
    let mapId = cfg.maps.length === 1 ? cfg.maps[0].id : null;
    let pin = null; // {x, y}

    const reg = h('input', {
      type: 'text', id: 'kd-reg', class: 'kiosk-reg', required: true, maxlength: 12, autocomplete: 'off',
      autocapitalize: 'characters', spellcheck: 'false', placeholder: 'AB 12345',
    });
    const name = nameInput({ id: 'kd-name', required: true, maxlength: 120, autocomplete: 'off' });
    const phone = h('input', { type: 'tel', id: 'kd-phone', required: true, maxlength: 20, inputmode: 'tel', autocomplete: 'off', placeholder: 'e.g. 912 34 567' });
    // 0.60.3 (the user's request): a car the workshop doesn't know yet asks for its legal owner (first + last name,
    // address); the phone can be anyone's, and someone delivering for the owner ticks "not the owner" and gives their
    // first name. Known cars keep the short form (name + phone).
    const last = nameInput({ id: 'kd-last', maxlength: 80, autocomplete: 'off' });
    const address = h('input', { type: 'text', id: 'kd-addr', maxlength: 160, autocomplete: 'off' });
    const postal = h('input', { type: 'text', id: 'kd-postal', maxlength: 4, inputmode: 'numeric', autocomplete: 'off', placeholder: '1234' });
    const city = nameInput({ id: 'kd-city', maxlength: 80, autocomplete: 'off' });
    const notOwner = h('input', { type: 'checkbox', id: 'kd-notowner' });
    const contactName = nameInput({ id: 'kd-contact', maxlength: 60, autocomplete: 'off' });
    let known = null;   // true / false once the reg. no. is checked; null = not checked yet
    const peopleSlot = h('div');
    const contactSlot = h('div');
    const drawContact = () => contactSlot.replaceChildren(...(notOwner.checked
      ? [h('div', { class: 'field' }, h('label', { for: 'kd-contact' }, 'Your first name'), contactName)] : []));
    notOwner.addEventListener('change', () => { drawContact(); if (notOwner.checked) contactName.focus(); });
    const drawPeople = () => {
      peopleSlot.replaceChildren(...(known === false ? [
        h('div', { class: 'notice kiosk-owner-note' },
          'We don’t have this car registered yet. Fill in the car’s legal owner, as on the registration certificate. The phone number can be anyone we can reach about the car.'),
        h('div', { class: 'grid' },
          h('div', { class: 'field' }, h('label', { for: 'kd-name' }, 'Owner’s first name'), name),
          h('div', { class: 'field' }, h('label', { for: 'kd-last' }, 'Owner’s last name'), last)),
        h('div', { class: 'field' }, h('label', { for: 'kd-addr' }, 'Owner’s address'), address),
        h('div', { class: 'grid' },
          h('div', { class: 'field' }, h('label', { for: 'kd-postal' }, 'Postal code'), postal),
          h('div', { class: 'field' }, h('label', { for: 'kd-city' }, 'City'), city)),
        h('div', { class: 'field' }, h('label', { for: 'kd-phone' }, 'Contact phone number'), phone),
        h('label', { class: 'check' }, notOwner, h('span', {}, 'I am not the owner')),
        contactSlot,
      ] : [
        h('div', { class: 'grid' },
          h('div', { class: 'field' }, h('label', { for: 'kd-name' }, 'Your name'), name),
          h('div', { class: 'field' }, h('label', { for: 'kd-phone' }, 'Phone number'), phone)),
      ]));
    };
    let knownSeq = 0;
    const checkKnown = async () => {
      const r = String(reg.value || '').toUpperCase().replace(/[^\p{L}\p{N}]/gu, '');
      const my = ++knownSeq;
      let k = null;
      if (r.length >= 2 && r.length <= 8) {
        try { k = (await api.get(`/kiosk/known?reg=${encodeURIComponent(r)}`)).known; } catch { k = false; } // ask, to be safe
      }
      if (my !== knownSeq) return known;
      if (k !== known) { known = k; drawPeople(); }
      return known;
    };
    reg.addEventListener('input', debounce(checkKnown, 450));
    drawContact();
    drawPeople();
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

    // Booked today (0.52.0): the customer taps their car (only the reg. no. is listed, 0.54.2); the owner's name and
    // phone are then filled in (fetched for that one car) and the delivery is tied to the work order, so the planner
    // shows the car as arrived. Typing another reg. no. drops the choice and clears what was filled in.
    let picked = null; // { id, registration_number }
    let filled = null; // { name, phone } as filled in from the booking
    const bookedSlot = h('div');
    const norm = (s) => String(s || '').toUpperCase().replace(/[^\p{L}\p{N}]/gu, '');
    const unfill = () => {
      if (!filled) return;
      if (name.value === filled.name) name.value = '';
      if (phone.value === filled.phone) phone.value = '';
      filled = null;
    };
    const pick = async (b, list) => {
      unfill();
      picked = b;
      reg.value = b.registration_number;
      knownSeq += 1;   // a booked car is in the customer register
      if (known !== true) { known = true; drawPeople(); }
      drawBooked(list);
      try {
        const c = await api.get(`/kiosk/booked/${b.id}/contact`);
        if (picked !== b) return; // another car was tapped meanwhile
        filled = { name: name.value || c.name || '', phone: phone.value || c.phone || '' };
        name.value = filled.name;
        phone.value = filled.phone;
      } catch { /* the form still works by typing */ }
      (name.value ? (phone.value ? null : phone) : name)?.focus();
    };
    const drawBooked = (list) => {
      bookedSlot.replaceChildren(...(list.length ? [h('div', { class: 'field kiosk-booked' },
        h('label', {}, 'Booked in? Tap your car'),
        h('div', { class: 'chips' }, list.map((b) => h('button', {
          class: `chip booked-chip${picked?.id === b.id ? ' on' : ''}`, type: 'button',
          onClick: () => pick(b, list),
        }, h('strong', { class: 'mono' }, b.registration_number)))),
        h('p', { class: 'muted small' }, 'Not on the list? Just fill in the form.'))] : []));
    };
    api.get('/kiosk/booked').then((list) => {
      drawBooked(list);
      reg.addEventListener('input', () => {
        if (picked && norm(reg.value) !== picked.registration_number) { picked = null; unfill(); drawBooked(list); }
      });
    }).catch(() => {});

    const submit = h('button', { class: 'btn primary big', type: 'submit' }, 'Register delivery');
    const form = h('form', { class: 'card kiosk-card', autocomplete: 'off' },
      h('div', { class: 'kiosk-head' }, h('h1', {}, 'Deliver your car')),
      h('p', { class: 'muted' }, 'Register the car you are leaving with us. Quick and easy.'),
      bookedSlot,
      h('div', { class: 'field' }, h('label', { for: 'kd-reg' }, 'Registration number'), reg),
      peopleSlot,
      cfg.key_places.length ? h('div', { class: 'field' }, h('label', {}, 'Put your key in an available box'),
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
        `We use these details only for the work on the car and to contact you about it. The registration is deleted ${cfg.trash_days} days after we have received the car. `,
        h('button', { class: 'link', type: 'button', onClick: () => deliveryPrivacyDialog(cfg.privacy, cfg.trash_days) },
          'Read the privacy notice')),
      h('div', { class: 'actions' }, submit));

    // Walked away halfway: clear the form (the next customer must not see the details).
    const bump = () => {
      inUse = true;
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
        // Typed and sent before the check came back: check now (an unknown car needs the owner's details).
        if (known === null && !picked) await checkKnown();
        if (known === false) {
          const need = [[name, 'Fill in the owner\'s first and last name'], [last, 'Fill in the owner\'s first and last name'],
            [address, 'Fill in the owner\'s address'], [postal, 'Postal code: 4 digits'], [city, 'Fill in the owner\'s address']]
            .find(([el]) => !el.value.trim());
          if (need) { toast(need[1], 'error'); need[0].focus(); return; }
          if (!/^\d{4}$/.test(postal.value.trim())) { toast('Postal code: 4 digits', 'error'); postal.focus(); return; }
          if (notOwner.checked && !contactName.value.trim()) { toast('Fill in your first name', 'error'); contactName.focus(); return; }
        }
        const unknown = known === false;
        await api.post('/kiosk/deliveries', {
          owner_last_name: unknown ? last.value : null,
          owner_address: unknown ? address.value : null,
          owner_postal_code: unknown ? postal.value : null,
          owner_city: unknown ? city.value : null,
          not_owner: unknown && notOwner.checked,
          contact_name: unknown && notOwner.checked ? contactName.value : null,
          registration_number: reg.value,
          customer_name: name.value,
          customer_phone: phone.value,
          map_id: mapId,
          pin_x: pin ? pin.x : null,
          pin_y: pin ? pin.y : null,
          key_place_id: key ? Number(key.value) : null,
          check_ids: checkBoxes.filter((b) => b.checked).map((b) => Number(b.value)),
          message: message.value.trim() || null,
          work_order_id: picked ? picked.id : null,
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
    inUse = true;
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
 * The top of a delivery card, in the order staff asked for (0.26.2):
 * 1. registration number (+ the car: linked when it is in Carbonara, else make/model from SVV)
 * 2. VIN from Statens vegvesen
 * 3. name(s) and phone: the SVV owner's name first once SVV sends it, the typed name under it
 *    when it differs
 * 4. EU-kontroll: green / amber / red badge and the deadline (or why there is no SVV data)
 * Redraws itself after "Look up again".
 */
function cardTop(first) {
  const slot = h('div', { class: 'delivery-svv' });
  const draw = (d) => {
    const look = h('button', {
      class: 'link small', type: 'button',
      onClick: () => busy(look, async () => draw(await api.post(`/deliveries/${d.id}/registry`))),
    }, '↻ Look up again');
    const car = [d.svv_make, d.svv_model].filter(Boolean).join(' ');
    const match = NAME_MATCH[d.name_match];

    let eu;
    if (d.svv_status === 'ok') {
      eu = h('div', {}, h('span', {}, 'EU-kontroll: '),
        d.svv_eu_due
          ? [badge(euStatus(d.svv_eu_due)), ' ', h('strong', {}, fmtDate(d.svv_eu_due, false))]
          : h('span', { class: 'muted' }, 'no deadline from Statens vegvesen'),
        ' ', look);
    } else {
      const text = {
        not_found: 'Not found at Statens vegvesen – check the registration number',
        error: 'Statens vegvesen lookup failed',
        not_configured: 'Statens vegvesen is not set up (System page)',
      }[d.svv_status] || 'Not looked up at Statens vegvesen yet';
      eu = h('div', { class: `small ${d.svv_status === 'not_found' ? 'warn-text' : 'muted'}` },
        h('span', { title: d.svv_error || '' }, text), ' ', d.svv_status === 'not_configured' ? null : look);
    }

    slot.replaceChildren(...[
      h('div', { class: 'list-title' }, h('span', { class: 'mono strong delivery-reg' }, d.registration_number),
        // Linked when the car is in the workshop's customer register (same reg. no, or the VIN from Statens
        // vegvesen; 0.53.0). Deliveries from before that may still link to the car stock.
        d.customer_car_id ? [' ', canOpen(`#/customer-cars/${d.customer_car_id}`)
          ? h('a', { href: `#/customer-cars/${d.customer_car_id}`, translate: 'no' }, [d.car_make, d.car_model].filter(Boolean).join(' ') || 'Customer car')
          : h('span', { translate: 'no' }, [d.car_make, d.car_model].filter(Boolean).join(' '))]
          : d.vehicle_id && d.make ? [' ', h('a', { href: `#/vehicles/${d.vehicle_id}` }, vehicleTitle(d))]
            : car ? [' ', h('span', { translate: 'no' }, car)] : null),
      d.svv_vin ? h('div', {}, h('span', {}, 'VIN: '), h('span', { class: 'mono' }, d.svv_vin)) : null,
      h('div', {}, h('span', { translate: 'no' }, d.display_name || d.customer_name), ' · ',
        h('a', { href: `tel:${d.customer_phone}` }, d.customer_phone)),
      // A car not in the register (0.60.3): the owner's address, and who delivered it when not the owner.
      d.owner_address ? h('div', { class: 'small' }, h('span', {}, 'Owner’s address:'), ' ',
        h('span', { translate: 'no' }, `${d.owner_address}, ${d.owner_postal_code || ''} ${d.owner_city || ''}`.trim())) : null,
      d.not_owner ? h('div', { class: 'small' }, h('span', { class: 'badge warn' }, 'Delivered by someone else'), ' ',
        h('span', { translate: 'no' }, d.contact_name || ''), ' · ', h('span', {}, 'the phone number is theirs')) : null,
      d.owner_address && !d.customer_car_id ? h('div', { class: 'small muted' }, 'Not in the customer register yet') : null,
      d.svv_name ? h('div', { class: 'small muted' }, h('span', {}, 'Name from Statens vegvesen'),
        match ? [' ', badge(match)] : null,
        d.name_match !== 'same' ? h('span', { class: 'block' }, h('span', {}, 'Typed by the customer: '),
          h('span', { translate: 'no' }, d.customer_name)) : null) : null,
      eu,
    ].filter(Boolean));
  };
  draw(first);
  return slot;
}

/** Work orders for the delivered car (0.60.4, the user's request): its open work orders as links, or "New work order"
 *  when it has none (a car not in the customer register is added first, from what was typed on the kiosk).
 *  `rerender` = the page's redraw; without it (the received list's "Show") only the links are shown. */
function workOrdersLine(d, rerender) {
  const others = (d.open_work_orders || []).filter((w) => w.id !== d.work_order_id);
  const link = (w) => (canOpen(`#/work-orders/${w.id}`) ? h('a', { href: `#/work-orders/${w.id}` }, `#${w.number}`) : `#${w.number}`);
  const parts = [];
  if (d.work_order_id) {
    parts.push(h('div', { class: 'small' }, h('span', {}, 'Booked:'), ' ',
      link({ id: d.work_order_id, number: d.work_order_number })));
  }
  if (others.length) {
    parts.push(h('div', { class: 'small' }, h('span', {}, 'Open work orders:'), ' ',
      others.map((w, i) => [i ? ', ' : '', link(w), w.title ? h('span', { class: 'muted', translate: 'no' }, ` ${w.title}`) : null])));
  }
  if (rerender && !d.work_order_id && !others.length && !d.received_at && canOpen('#/work-orders')) {
    const make = h('button', { class: 'btn small', type: 'button' }, d.customer_car_id ? '🛠 New work order' : '🛠 Add to customer register + work order');
    make.addEventListener('click', () => busy(make, async () => {
      let carId = d.customer_car_id;
      if (!carId) {
        if (!confirm(`Add ${d.registration_number} and its owner (${d.customer_name}) to the customer register?`)) return;
        carId = (await api.post(`/deliveries/${d.id}/to-register`)).customer_car_id;
        toast('Added to the customer register', 'success');
      }
      await newWorkOrderDialog({ customer_car_id: carId, text: [d.registration_number, d.display_name || d.customer_name].filter(Boolean).join(' · ') }, {
        description: d.message || '',
        onDone: async (r) => {
          await api.post(`/deliveries/${d.id}/work-order`, { work_order_id: r.id });
          toast(`Work order #${r.number} made`, 'success');
          await rerender();
        },
      });
      if (!d.customer_car_id) await rerender();   // shows the link to the register even if the dialog is closed
    }));
    parts.push(h('div', { class: 'no-print' }, make));
  }
  return parts;
}

function deliveryDetails(d, rerender = null) {
  return [
    cardTop(d),
    h('div', { class: 'muted small' }, `Delivered ${fmtDate(d.created_at)}`,
      d.kiosk_name ? h('span', { translate: 'no' }, ` · ${d.kiosk_name}`) : null),
    workOrdersLine(d, rerender),
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

// host: the page's real container. A redraw renders into a fresh div and moves the result
// into host, so every redraw (not only the first) updates the visible page.
export async function deliveriesView(el, _params = [], host = el) {
  const data = await api.get('/deliveries');
  const admin = !!session.me?.is_admin;
  const rerender = async () => {
    try {
      const fresh = h('div');
      await deliveriesView(fresh, [], host);
      host.replaceChildren(...fresh.childNodes);
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
      h('div', { class: 'delivery-main' }, deliveryDetails(d, rerender)),
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
    // The tablet's language is set only here (the tablet has no switch); it follows within a minute.
    const languageSelect = (k) => {
      const sel = langSelect(k.language, `kiosk-lang-${k.id}`);
      sel.className = 'kiosk-lang';
      sel.setAttribute('aria-label', 'Language on the tablet');
      sel.addEventListener('change', async () => {
        try {
          await api.put(`/kiosk-devices/${k.id}/language`, { language: sel.value });
          k.language = sel.value;
          toast('Saved. The tablet changes language within a minute.', 'success');
        } catch (e) { sel.value = k.language; showError(e); }
      });
      return sel;
    };
    // System admins can delete a tablet from the list at once (an active one also stops).
    const remove = async (k) => {
      const q = k.revoked_at ? `Delete ${k.name} from the list for good?`
        : `Delete ${k.name} for good? The tablet stops showing the delivery form.`;
      if (!confirm(q)) return;
      try { await api.del(`/kiosk-devices/${k.id}/record`); toast(`${k.name} deleted`, 'success'); await redraw(); } catch (e) { showError(e); }
    };
    const sysAdmin = !!session.me?.is_superadmin;
    const row = (k) => h('li', { class: k.revoked_at ? 'inactive' : '' },
      h('span', {}, h('span', { translate: 'no' }, k.name), ' ',
        k.revoked_at ? h('span', { class: 'badge' }, 'Stopped') : null,
        h('span', { class: 'muted small block' }, `Set up ${fmtDate(k.created_at, false)}`,
          k.created_by_name ? h('span', {}, ` by ${k.created_by_name}`) : null,
          k.last_seen_at ? h('span', {}, ` · last used ${fmtDate(k.last_seen_at)}`) : null,
          k.revoked_at ? h('span', {}, ` · stopped ${fmtDate(k.revoked_at, false)}`) : null)),
      h('span', { class: 'row-actions kiosk-actions' },
        k.revoked_at ? null : languageSelect(k),
        k.revoked_at ? null : h('button', { class: 'link danger', type: 'button', onClick: () => revoke(k) }, 'Stop'),
        sysAdmin ? h('button', { class: 'link danger', type: 'button', onClick: () => remove(k) }, 'Delete') : null));
    return h('section', { class: 'card' },
      h('h2', {}, 'Kiosk tablets'),
      h('p', { class: 'muted small' },
        'A kiosk tablet shows only the delivery form, with no login and no language switch. To set one up, log in on the '
        + 'tablet as an administrator, open this page and press the button below. You are then logged out on the tablet.'),
      h('p', { class: 'muted small' },
        'Choose the language of each tablet here. To use a tablet as a normal device again, press Stop.'),
      kiosks.length ? h('ul', { class: 'plain rows' }, kiosks.slice(0, SHOW_KIOSKS).map(row))
        : h('p', { class: 'empty' }, 'No kiosk tablets yet.'),
      // More than three: the rest folded away (active tablets come first, so these are mostly stopped ones).
      kiosks.length > SHOW_KIOSKS ? h('details', { class: 'more' },
        h('summary', {}, `More tablets (${kiosks.length - SHOW_KIOSKS})`),
        h('ul', { class: 'plain rows' }, kiosks.slice(SHOW_KIOSKS).map(row))) : null,
      h('p', { class: 'muted small' }, `Stopped tablets are deleted automatically ${KIOSK_KEEP_DAYS} days after they were stopped.`),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', type: 'button', onClick: kioskDialog }, 'Use this device as the delivery kiosk')));
  }

  function kioskDialog() {
    const name = h('input', { type: 'text', id: 'kiosk-name', required: true, maxlength: 60, placeholder: 'e.g. Tablet at the key drop' });
    const language = langSelect('no', 'kiosk-new-lang');
    const ok = h('button', { class: 'btn primary', type: 'submit' }, 'Make this device a kiosk');
    const form = h('form', {},
      h('p', {}, 'This device will show only the customer delivery form, with no staff login. You are logged out here. '
        + 'To use it as a normal device again, press Stop for it on this page from another device.'),
      h('div', { class: 'field' }, h('label', { for: 'kiosk-name' }, 'Name of this device'), name),
      h('div', { class: 'field' }, h('label', { for: 'kiosk-new-lang' }, 'Language on the tablet'), language),
      h('div', { class: 'actions' }, ok));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      busy(ok, async () => {
        await api.post('/kiosk-devices', { name: name.value, language: language.value });
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

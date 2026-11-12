// Rental cars: the dealer's own rental / loan fleet, kept apart from the car
// database (they never show up in Vehicles, Storage or search). Cars are added
// and edited on this page, with Statens vegvesen data (EU-kontroll first).
// Renting out works like a test drive: customer, driving licence photo, items
// taken out / put in, return check; customer details go to the trash on return
// and are deleted for good after TRASH_DAYS.
import {
  FUEL_TYPES, api, append, busy, cameraPicker, dateInput, euStatus, fmtDate, fmtKm, getInspectorId, h,
  openDialog, osloTodayIso, session, setInspectorId, showError, timeInput, toast,
} from '../ui.js';
import { duration, itemPicker, telLink } from './testdrive.js';

const REMOVED_PRESETS = ['Winter wheels', 'Summer wheels', 'Charging cable', 'Floor mats', 'Cargo cover / parcel shelf'];
const ADDED_PRESETS = ['Charging cable', 'Fuel / charging card', 'Child seat', 'Roof box', 'Ski rack'];

const licenseUrl = (id, variant = 'thumb') => `/api/rentals/${id}/license/${variant}`;
const carName = (c) => [c.make, c.model, c.model_year].filter(Boolean).join(' ');
const regEl = (c) => h('span', { class: 'mono strong', translate: 'no' }, c.registration_number);

/** "EU-kontroll 01.02.2027 · Due in 40 days" as a coloured badge (unknown = amber). */
function euBadge(due) {
  const st = euStatus(due);
  if (!st) return h('span', { class: 'badge warn' }, h('span', {}, 'EU-kontroll'), ' ', h('span', {}, 'unknown'));
  return h('span', { class: `badge ${st.cls}` },
    h('span', {}, 'EU-kontroll'), ' ', fmtDate(due, false), ' · ', h('span', {}, st.text));
}

/** Registration status from Statens vegvesen, shown only when it isn't plain "registered". */
const regBadge = (c) => (c.registration_status_code && c.registration_status_code !== 'REGISTRERT'
  ? h('span', { class: 'badge bad', translate: 'no' }, c.registration_status || c.registration_status_code) : null);

function viewLicense(r) {
  openDialog(`Driving licence — ${r.customer_name}`, h('div', { class: 'photo-view' },
    h('img', { src: licenseUrl(r.id, 'display'), alt: 'Driving licence' }),
    h('a', { href: licenseUrl(r.id, 'original'), target: '_blank', rel: 'noopener', class: 'muted' }, 'Open original')),
  { wide: true });
}

/** The privacy notice for renters (GDPR art. 13), in Norwegian. Printable. */
export function rentalPrivacyDialog(privacy, trashDays) {
  const lines = [['Telefon', privacy?.phone], ['E-post', privacy?.email], ['Adresse', privacy?.address]]
    .filter(([, v]) => v);
  const contact = lines.length
    ? h('p', { class: 'privacy-contact' }, lines.map(([label, v]) => h('span', { class: 'block' }, `${label}: `, h('strong', {}, v))))
    : h('p', {}, h('strong', { class: 'td-items' }, privacy?.source === 'rental'
      ? '[kontaktinfo mangler – legges inn under System → Leiebiler]'
      : '[kontaktinfo mangler – legges inn under System → Firma eller Leiebiler]'));
  const company = privacy?.company || 'Forhandleren';
  // Two companies under one roof: the rental company owns the data, the company
  // running Carbonara stores it for them (data processor, GDPR art. 28).
  const operator = privacy?.operator;
  const whoSees = operator
    ? h('p', {}, `Bare ansatte hos ${company} og ${operator} som har tilgang til systemet, og som logger inn med personlig kode. `
      + `Opplysningene lagres på en server som ${operator} drifter på vegne av ${company} (databehandler), og deles ikke, `
      + 'med mindre det er nødvendig for å håndtere et krav (for eksempel overfor politi, bompengeselskap eller forsikringsselskap).')
    : h('p', {}, 'Bare våre ansatte, som logger inn med personlig kode. Opplysningene lagres på vår egen server og deles ikke, '
      + 'med mindre det er nødvendig for å håndtere et krav (for eksempel overfor politi, bompengeselskap eller forsikringsselskap).');
  const body = h('div', { class: 'privacy-text', translate: 'no' }, // a Norwegian document
    h('p', {}, h('strong', {}, company), ' er behandlingsansvarlig for opplysningene vi registrerer når du leier eller låner en bil av oss.'),
    h('h3', {}, 'Hva vi registrerer'),
    h('p', {}, 'Navn, telefonnummer og et bilde av førerkortet ditt (hele kortet, også fødselsnummer), hvilken bil du har, '
      + 'når den ble hentet, når du regnet med å levere den, og når den ble levert.'),
    h('h3', {}, 'Hvorfor'),
    h('p', {}, 'For å vite hvem som har bilen, og for å kunne følge opp bompenger, fartsbøter, parkeringsgebyr, skader eller tyveri mens du har den. '
      + 'Vi tar bilde av hele førerkortet for å kunne identifisere føreren sikkert overfor politi, Statens vegvesen, bompengeselskap og forsikring.'),
    h('h3', {}, 'Rettslig grunnlag'),
    h('p', {}, 'Det er nødvendig for leieavtalen med deg (personvernforordningen art. 6 nr. 1 bokstav b), og for vår berettigede interesse i å '
      + 'ivareta bilen og håndtere krav som oppstår mens du har den (art. 6 nr. 1 bokstav f). '
      + 'Fødselsnummer brukes fordi det er nødvendig for sikker identifisering (personopplysningsloven § 12).'),
    h('h3', {}, 'Hvor lenge'),
    h('p', {}, `Opplysningene om deg slettes automatisk ${trashDays} dager etter at bilen er levert tilbake. `
      + 'Hvilken bil som var utleid og når, beholdes uten opplysninger om deg.'),
    h('h3', {}, 'Hvem som ser dem'),
    whoSees,
    h('h3', {}, 'Dine rettigheter'),
    h('p', {}, 'Du kan be om innsyn, retting og sletting, og protestere mot behandlingen. '
      + `Du kan også klage til Datatilsynet (datatilsynet.no). Kontakt ${operator ? company : 'oss'}:`),
    contact,
    h('div', { class: 'sign-lines' },
      h('div', { class: 'sign-wide' }, 'Kundens signatur'),
      h('div', {}, 'Dato'),
      h('div', { class: 'sign-wide' }, 'Navn med blokkbokstaver')));
  const wrap = h('div', {}, body,
    h('div', { class: 'actions no-print' },
      h('button', { class: 'btn', type: 'button', onClick: () => window.print() }, '🖨 Print')));
  openDialog('Personvern – leie av bil', wrap, { wide: true });
}

const itemsText = (r) => [
  r.removed_items?.length && `Taken out: ${r.removed_items.join(', ')}`,
  r.added_items?.length && `Put in: ${r.added_items.join(', ')}`,
  r.items_note,
].filter(Boolean);

// host: the page's real container. A redraw renders into a fresh div and moves the
// result into host, so every redraw (not only the first) updates the visible page.
export async function rentalView(el, _params = [], host = el) {
  const [data, staff] = await Promise.all([api.get('/rental-cars'), api.get('/staff')]);
  const rerender = async () => {
    try {
      const fresh = h('div');
      await rentalView(fresh, [], host);
      host.replaceChildren(...fresh.childNodes);
    } catch (e) { showError(e); }
  };
  const euSoon = data.cars.filter((c) => { const st = euStatus(c.eu_control_due); return st && st.cls !== 'good'; });

  append(el,
    h('div', { class: 'page-head' }, h('h1', {}, 'Rental cars'),
      h('button', { class: 'link small', type: 'button', onClick: () => rentalPrivacyDialog(data.privacy, data.trash_days) },
        '🔒 Privacy notice for customers')),
    data.privacy?.phone || data.privacy?.email || data.privacy?.address ? null : h('div', { class: 'card notice warn' },
      data.privacy?.source === 'rental'
        ? 'The rental privacy notice has no contact details yet. A system admin can add them on the System page → Rental cars.'
        : 'The customer privacy notice has no contact details yet. A system admin can add them on the System page → Company.'),
    euSoon.length ? h('div', { class: `card notice ${euSoon.some((c) => euStatus(c.eu_control_due).cls === 'bad') ? 'bad-notice' : 'warn'}` },
      h('strong', {}, 'EU-kontroll soon: '),
      euSoon.map((c, i) => [i ? ', ' : '', regEl(c), ` (${fmtDate(c.eu_control_due, false)})`])) : null,
    rentCard(data, staff, rerender),
    h('section', { class: 'card' },
      h('h2', {}, `Out on rental now (${data.active.length})`),
      data.active.length
        ? h('div', { class: 'list' }, data.active.map((r) => activeRow(r, rerender)))
        : h('p', { class: 'empty' }, 'No rental cars are out.')),
    fleetCard(data, rerender),
    trashCard(data, rerender));
}

// ---------------------------------------------------------------- the fleet

function fleetCard(data, done) {
  return h('section', { class: 'card' },
    h('div', { class: 'team-head' },
      h('h2', {}, `Rental cars (${data.cars.length})`),
      h('button', { class: 'btn primary', type: 'button', onClick: () => carDialog(null, data, done) }, '+ Add rental car')),
    data.registry ? null : h('p', { class: 'muted small' },
      'Statens vegvesen is not set up (System page), so EU-kontroll must be typed in by hand.'),
    data.cars.length
      ? h('div', { class: 'list' }, data.cars.map((c) => fleetRow(c, data, done)))
      : h('p', { class: 'empty' }, 'No rental cars yet. Add the first one with “+ Add rental car”.'));
}

function fleetRow(c, data, done) {
  return h('div', { class: 'list-card inner rc-row' },
    h('div', { class: 'list-main' },
      h('div', { class: 'list-title' }, h('span', { class: 'rc-reg', translate: 'no' }, c.registration_number), ' ',
        h('span', { translate: 'no' }, carName(c)), c.color ? h('span', { class: 'muted', translate: 'no' }, ` · ${c.color}`) : null),
      h('div', { class: 'rc-badges' }, euBadge(c.eu_control_due), regBadge(c),
        c.rental_id
          ? h('span', { class: 'badge warn' }, h('span', {}, 'Rented out'), ' · ', h('span', { translate: 'no' }, c.rented_to))
          : h('span', { class: 'badge good' }, 'Available')),
      h('div', { class: 'list-meta' }, [
        c.eu_control_last_approved && h('span', {}, `last approved ${fmtDate(c.eu_control_last_approved, false)}`),
        c.registry_checked_at && h('span', {}, `Statens vegvesen checked ${fmtDate(c.registry_checked_at, false)}`),
        c.vin && h('span', { class: 'mono', translate: 'no' }, c.vin),
      ].filter(Boolean).flatMap((x, i) => (i ? [' · ', x] : [x]))),
      c.registry_error ? h('div', { class: 'small td-items' }, h('span', {}, 'Statens vegvesen: '), h('span', {}, c.registry_error)) : null,
      c.note ? h('div', { class: 'small', translate: 'no' }, c.note) : null),
    h('div', { class: 'row-actions' },
      h('button', { class: 'btn small', type: 'button', onClick: () => carDialog(c, data, done) }, 'Edit'),
      data.registry ? h('button', {
        class: 'btn small', type: 'button',
        onClick: (e) => busy(e.currentTarget, async () => {
          try {
            await api.post(`/rental-cars/${c.id}/refresh`);
            toast('Updated from Statens vegvesen', 'success');
          } finally { await done(); }
        }),
      }, 'Look up again') : null,
      h('button', {
        class: 'btn small danger', type: 'button', disabled: !!c.rental_id,
        title: c.rental_id ? 'Out on rental' : null,
        onClick: async (e) => {
          if (!confirm(`Remove ${c.registration_number} from the rental cars?`)) return;
          await busy(e.currentTarget, async () => {
            await api.del(`/rental-cars/${c.id}`);
            toast('Rental car removed', 'success');
            await done();
          });
        },
      }, 'Remove')));
}

/** Add (car = null) or edit a rental car. "Look up" fills the form from Statens vegvesen. */
function carDialog(car, data, done) {
  const v = car || {};
  const reg = h('input', {
    type: 'text', id: 'rc-reg', required: true, maxlength: 12, autocomplete: 'off', autocapitalize: 'characters',
    spellcheck: 'false', placeholder: 'AB 12345', value: v.registration_number || '', class: 'rc-reg-input',
  });
  const make = h('input', { type: 'text', id: 'rc-make', maxlength: 60, value: v.make || '' });
  const model = h('input', { type: 'text', id: 'rc-model', maxlength: 80, value: v.model || '' });
  const year = h('input', { type: 'number', id: 'rc-year', min: 1950, max: 2100, inputmode: 'numeric', value: v.model_year ?? '' });
  const color = h('input', { type: 'text', id: 'rc-color', maxlength: 40, value: v.color || '' });
  const fuel = h('select', { id: 'rc-fuel' }, h('option', { value: '' }, '—'),
    FUEL_TYPES.map((f) => h('option', { value: f }, f)));
  if (v.fuel && !FUEL_TYPES.includes(v.fuel)) fuel.append(h('option', { value: v.fuel }, v.fuel));
  fuel.value = v.fuel || '';
  const vin = h('input', { type: 'text', id: 'rc-vin', maxlength: 17, autocomplete: 'off', class: 'mono', value: v.vin || '' });
  const eu = dateInput({ id: 'rc-eu', value: v.eu_control_due || '' });
  const note = h('input', { type: 'text', id: 'rc-note', maxlength: 500, value: v.note || '', placeholder: 'e.g. winter wheels in the boot' });
  const lookupHint = h('div', { class: 'small muted' });

  const fill = (input, value) => { if (value != null && value !== '' && !input.value) input.value = value; };
  const lookupBtn = h('button', {
    class: 'btn', type: 'button', disabled: !data.registry,
    onClick: (e) => busy(e.currentTarget, async () => {
      if (!reg.value.trim()) { toast('Type the registration number first', 'error'); return; }
      lookupHint.className = 'small muted';
      lookupHint.textContent = '';
      try {
        const r = await api.get(`/rental-cars/lookup?reg=${encodeURIComponent(reg.value)}`);
        fill(make, r.make); fill(model, r.model); fill(color, r.color); fill(vin, r.vin);
        if (r.fuel && !fuel.value) {
          if (![...fuel.options].some((o) => o.value === r.fuel)) fuel.append(h('option', { value: r.fuel }, r.fuel));
          fuel.value = r.fuel;
        }
        if (r.eu_control_due) eu.value = r.eu_control_due; // always the registry's date
        lookupHint.replaceChildren(); // append(): the DOM's own would print null / arrays as text
        append(lookupHint, h('span', {}, '✓ Found at Statens vegvesen'),
          r.eu_control_due ? [' · ', h('span', {}, 'EU-kontroll'), ` ${fmtDate(r.eu_control_due, false)}`] : null);
      } catch (err) {
        lookupHint.className = 'small td-items';
        lookupHint.textContent = err.message;
      }
    }),
  }, 'Look up at Statens vegvesen');

  const submit = h('button', { class: 'btn primary', type: 'submit' }, car ? 'Save' : 'Add rental car');
  const form = h('form', { class: 'form' },
    h('div', { class: 'field' }, h('label', { for: 'rc-reg' }, 'Registration number'),
      h('div', { class: 'row' }, reg, data.registry ? lookupBtn : null), lookupHint),
    h('div', { class: 'grid' },
      h('div', { class: 'field' }, h('label', { for: 'rc-make' }, 'Make'), make),
      h('div', { class: 'field' }, h('label', { for: 'rc-model' }, 'Model'), model)),
    h('div', { class: 'grid' },
      h('div', { class: 'field' }, h('label', { for: 'rc-year' }, 'Model year'), year),
      h('div', { class: 'field' }, h('label', { for: 'rc-color' }, 'Colour'), color)),
    h('div', { class: 'grid' },
      h('div', { class: 'field' }, h('label', { for: 'rc-fuel' }, 'Fuel'), fuel),
      h('div', { class: 'field' }, h('label', { for: 'rc-vin' }, 'VIN (optional)'), vin)),
    h('div', { class: 'field' }, h('label', { for: 'rc-eu' }, 'EU-kontroll due'), eu,
      h('div', { class: 'small muted' }, data.registry
        ? 'Filled in from Statens vegvesen, and updated automatically when the car has passed.'
        : 'Statens vegvesen is not set up, so type the date from the registration certificate.')),
    h('div', { class: 'field' }, h('label', { for: 'rc-note' }, 'Note (optional)'), note),
    h('div', { class: 'actions' }, submit));

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(submit, async () => {
      const body = {
        registration_number: reg.value, make: make.value, model: model.value,
        model_year: year.value ? Number(year.value) : null, color: color.value, fuel: fuel.value || null,
        vin: vin.value, eu_control_due: eu.value || null, note: note.value,
      };
      if (car) await api.patch(`/rental-cars/${car.id}`, body);
      else await api.post('/rental-cars', body);
      close();
      toast(car ? 'Rental car saved' : 'Rental car added', 'success');
      await done();
    });
  });
  const { close } = openDialog(car ? `Edit ${car.registration_number}` : 'Add rental car', form);
  if (!car) reg.focus();
}

// ---------------------------------------------------------------- rent out a car

function rentCard(data, staff, done) {
  const free = data.cars.filter((c) => !c.rental_id);
  const card = h('section', { class: 'card' }, h('h2', {}, 'Rent out a car'));
  const formSlot = h('div');
  const chooser = h('div', { class: 'list' }, free.map((c) => h('button', {
    class: 'card list-card', type: 'button', onClick: () => choose(c),
  },
  h('div', { class: 'list-main' },
    h('div', { class: 'list-title' }, h('span', { class: 'rc-reg', translate: 'no' }, c.registration_number), ' ',
      h('span', { translate: 'no' }, carName(c))),
    h('div', { class: 'rc-badges' }, euBadge(c.eu_control_due), regBadge(c))))));

  function choose(c) {
    chooser.hidden = true;
    formSlot.replaceChildren(rentForm(c, staff, data, done, () => {
      formSlot.replaceChildren();
      chooser.hidden = false;
    }));
  }

  append(card,
    data.cars.length && !free.length ? h('p', { class: 'empty' }, 'All rental cars are out.') : null,
    data.cars.length ? null : h('p', { class: 'empty' }, 'Add a rental car below first.'),
    chooser, formSlot);
  return card;
}

function rentForm(c, staff, data, done, cancel) {
  const informed = h('input', { type: 'checkbox', id: 'rt-informed', required: true });
  const name = h('input', { type: 'text', id: 'rt-name', required: true, maxlength: 120, autocomplete: 'off' });
  const phone = h('input', { type: 'tel', id: 'rt-phone', required: true, maxlength: 20, inputmode: 'tel', autocomplete: 'off', placeholder: 'e.g. 912 34 567' });
  const backDate = dateInput({ id: 'rt-back-date', min: osloTodayIso() });
  const backTime = timeInput({ id: 'rt-back-time' });
  const odo = h('input', { type: 'number', id: 'rt-odo', min: 0, inputmode: 'numeric', placeholder: 'km' });
  const note = h('input', { type: 'text', id: 'rt-note', maxlength: 500 });
  const staffSel = h('select', { id: 'rt-staff' }, h('option', { value: '' }, 'Select staff…'),
    staff.map((s) => h('option', { value: s.id }, s.name)));
  staffSel.value = staff.some((s) => String(s.id) === getInspectorId()) ? getInspectorId() : '';
  const removed = itemPicker(REMOVED_PRESETS, 'Taken out of the car for the rental');
  const added = itemPicker(ADDED_PRESETS, 'Put into the car for the rental');

  // EU-kontroll: warn when it has passed, or runs out before the car is due back.
  const euWarn = h('div');
  const checkEu = () => {
    const st = euStatus(c.eu_control_due);
    const back = backDate.value;
    let msg = null;
    if (st && st.days < 0) msg = h('div', { class: 'notice bad-notice small' }, 'The EU-kontroll deadline has passed – the car should not be driven.');
    else if (st && back && c.eu_control_due < back) {
      msg = h('div', { class: 'notice warn small' }, h('span', {}, 'The EU-kontroll deadline is before the expected return:'), ` ${fmtDate(c.eu_control_due, false)}`);
    }
    euWarn.replaceChildren(...[msg].filter(Boolean));
  };
  backDate.addEventListener('change', checkEu);
  checkEu();

  // Driving licence photo (required); the name is read from it.
  let licenseFile = null;
  const preview = h('div', { class: 'photo-tile needed td-license' }, h('span', { class: 'muted small' }, 'No photo yet'));
  const nameHint = h('div', { class: 'small muted' });
  let autoName = null; // the last name filled in from a photo (never overwrite a typed name)
  name.addEventListener('input', () => { nameHint.textContent = ''; });
  const picker = cameraPicker(async (file) => {
    licenseFile = file;
    preview.className = 'photo-tile has td-license';
    preview.replaceChildren(h('img', { src: URL.createObjectURL(file), alt: 'Driving licence' }));
    shootBtn.textContent = '📷 Retake licence photo';
    await readName(file);
  });
  async function readName(file) {
    if (name.value.trim() && name.value !== autoName) return;
    nameHint.className = 'small muted';
    nameHint.textContent = 'Reading the name from the licence…';
    try {
      const fd = new FormData();
      fd.append('file', file);
      const r = await api.postForm('/test-drives/read-license', fd);
      if (licenseFile !== file) return;
      if (name.value.trim() && name.value !== autoName) { nameHint.textContent = ''; return; }
      if (r.name) {
        name.value = autoName = r.name;
        nameHint.className = `small ${r.confidence === 'high' ? 'muted' : 'td-items'}`;
        nameHint.textContent = r.confidence === 'high'
          ? '✓ Read from the licence — check the spelling.'
          : '⚠ Read from the licence, but unsure — check it carefully.';
      } else {
        nameHint.textContent = 'Could not read the name from the photo. Type it in.';
      }
    } catch {
      nameHint.textContent = 'Could not read the name from the photo. Type it in.';
    }
  }
  const shootBtn = h('button', { class: 'btn', type: 'button', onClick: () => picker.open() }, '📷 Photo of driving licence');

  const submit = h('button', { class: 'btn primary', type: 'submit' }, 'Rent out');
  const form = h('form', { class: 'form' },
    h('div', { class: 'card inner notice' },
      h('span', { class: 'rc-reg', translate: 'no' }, c.registration_number), ' ', h('strong', { translate: 'no' }, carName(c)),
      h('div', { class: 'rc-badges' }, euBadge(c.eu_control_due), regBadge(c)),
      h('button', { class: 'link small', type: 'button', onClick: () => { picker.remove(); cancel(); } }, 'Choose another car')),
    euWarn,
    h('h3', {}, 'Customer'),
    h('div', { class: 'field' }, h('label', {}, 'Driving licence'),
      h('div', { class: 'row' }, preview, shootBtn),
      h('div', { class: 'small muted' }, 'Take the photo first — the name is filled in from the licence.')),
    h('div', { class: 'grid' },
      h('div', { class: 'field' }, h('label', { for: 'rt-name' }, 'Name'), name, nameHint),
      h('div', { class: 'field' }, h('label', { for: 'rt-phone' }, 'Phone number'), phone)),
    h('h3', {}, 'The car'),
    h('div', { class: 'grid' },
      h('div', { class: 'field' }, h('label', { for: 'rt-back-date' }, 'Expected back (optional)'), backDate),
      h('div', { class: 'field' }, h('label', { for: 'rt-back-time' }, 'Time'), backTime)),
    removed.el,
    added.el,
    h('div', { class: 'grid' },
      h('div', { class: 'field' }, h('label', { for: 'rt-odo' }, 'Odometer out (optional)'), odo),
      h('div', { class: 'field' }, h('label', { for: 'rt-staff' }, 'Handed out by'), staffSel)),
    h('div', { class: 'field' }, h('label', { for: 'rt-note' }, 'Note (optional)'), note),
    h('label', { class: 'check', for: 'rt-informed' }, informed,
      h('span', {}, 'The customer has been given the privacy information ',
        h('button', { class: 'link', type: 'button', onClick: () => rentalPrivacyDialog(data.privacy, data.trash_days) }, '(show / print)'))),
    h('p', { class: 'muted small' },
      `Customer details and the licence photo are moved to the trash when the car is returned, and deleted for good after ${data.trash_days} days.`),
    h('div', { class: 'actions' }, submit));

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!licenseFile) { toast('Take a photo of the driving licence first', 'error'); return; }
    if (!informed.checked) { toast('Give the customer the privacy information and tick the box', 'error'); return; }
    if (backTime.value && !backDate.value) { toast('Give the date the car is expected back', 'error'); return; }
    const st = euStatus(c.eu_control_due);
    if (st && st.days < 0 && !confirm(`The EU-kontroll deadline for ${c.registration_number} has passed.\n\nRent it out anyway?`)) return;
    busy(submit, async () => {
      const fd = new FormData();
      fd.append('rental_car_id', c.id);
      fd.append('customer_name', name.value);
      fd.append('customer_phone', phone.value);
      fd.append('license', licenseFile);
      if (backDate.value) fd.append('expected_return', `${backDate.value}T${backTime.value || '16:00'}`);
      if (staffSel.value) { fd.append('staff_id', staffSel.value); setInspectorId(staffSel.value); }
      if (odo.value) fd.append('odometer_out', odo.value);
      fd.append('removed_items', JSON.stringify(removed.value()));
      fd.append('added_items', JSON.stringify(added.value()));
      if (note.value.trim()) fd.append('items_note', note.value);
      fd.append('customer_informed', 'true');
      await api.postForm('/rentals', fd);
      picker.remove();
      toast(`${c.registration_number} is rented out`, 'success');
      await done();
    });
  });
  return form;
}

// ---------------------------------------------------------------- cars out now

function activeRow(r, done) {
  const late = r.expected_return_at && new Date(r.expected_return_at) < new Date();
  return h('div', { class: 'list-card inner td-row' },
    r.has_license
      ? h('button', { class: 'thumb small', type: 'button', title: 'Driving licence', onClick: () => viewLicense(r) },
        h('img', { src: licenseUrl(r.id), alt: 'Driving licence' }))
      : null,
    h('div', { class: 'list-main' },
      h('div', { class: 'list-title' }, h('span', { class: 'rc-reg', translate: 'no' }, r.registration_number), ' ',
        h('span', { translate: 'no' }, carName(r))),
      h('div', {}, h('strong', { translate: 'no' }, r.customer_name), ' · ', telLink(r.customer_phone)),
      h('div', { class: 'list-meta' },
        [`Out since ${fmtDate(r.started_at)} (${duration(r.started_at)})`, r.started_by_name,
          r.odometer_out != null && fmtKm(r.odometer_out)].filter(Boolean).join(' · ')),
      r.expected_return_at ? h('div', { class: late ? 'notice bad-notice small' : 'small' },
        h('span', {}, late ? 'Not returned – expected back' : 'Expected back'), ` ${fmtDate(r.expected_return_at)}`) : null,
      itemsText(r).map((t) => h('div', { class: 'small td-items' }, t))),
    h('button', { class: 'btn primary', type: 'button', onClick: () => returnDialog(r, done) }, 'Returned'));
}

function returnDialog(r, done) {
  const odo = h('input', { type: 'number', id: 'rr-odo', min: r.odometer_out ?? 0, inputmode: 'numeric', placeholder: 'km' });
  const note = h('input', { type: 'text', id: 'rr-note', maxlength: 500, placeholder: 'e.g. winter wheels left at the customer' });
  const receivedBy = h('div', { class: 'readonly-value', id: 'rr-staff' }, session.me?.name ?? '');
  const items = [
    ...r.removed_items.map((i) => `Put back in the car: ${i}`),
    ...r.added_items.map((i) => `Taken out of the car: ${i}`),
  ];
  const boxes = items.map((t) => h('input', { type: 'checkbox', value: t }));
  const submit = h('button', { class: 'btn primary', type: 'submit' }, 'Register return');

  const form = h('form', {},
    h('p', {}, h('span', { class: 'rc-reg', translate: 'no' }, r.registration_number), ' ',
      h('strong', { translate: 'no' }, carName(r)), ' — ', h('span', { translate: 'no' }, r.customer_name)),
    items.length ? h('div', { class: 'field' },
      h('label', {}, 'Check that the car is back as it was'),
      boxes.map((b) => h('label', { class: 'check' }, b, b.value))) : null,
    h('div', { class: 'grid' },
      h('div', { class: 'field' }, h('label', { for: 'rr-odo' }, 'Odometer in (optional)'), odo),
      h('div', { class: 'field' }, h('label', { for: 'rr-staff' }, 'Received by'), receivedBy)),
    h('div', { class: 'field' }, h('label', { for: 'rr-note' }, items.length ? 'Note (required if something is missing)' : 'Note (optional)'), note),
    h('p', { class: 'muted small' },
      'The customer’s name, phone number and licence photo are moved to the trash and deleted for good after 30 days.'),
    h('div', { class: 'actions' }, submit));

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const allChecked = boxes.every((b) => b.checked);
    if (!allChecked && !note.value.trim()) {
      toast('Tick every item, or write a note about what is missing', 'error');
      return;
    }
    busy(submit, async () => {
      await api.post(`/rentals/${r.id}/return`, {
        odometer_in: odo.value ? Number(odo.value) : null,
        items_checked: allChecked,
        return_note: note.value,
      });
      close();
      toast('Rental returned · customer details moved to the trash', 'success');
      await done();
    });
  });
  const { close } = openDialog('Car returned', form);
}

/** Who opened the licence photo or deleted the customer's details. */
async function accessLog(r) {
  try {
    const rows = await api.get(`/rentals/${r.id}/access-log`);
    const label = { license_viewed: 'Opened licence photo', customer_deleted: 'Deleted customer details' };
    openDialog(`Access log — ${r.customer_name ?? 'rental'}`, rows.length
      ? h('ul', { class: 'plain rows' }, rows.map((x) => h('li', {},
        h('span', {}, `${label[x.action] ?? x.action} — ${x.staff_name ?? 'unknown'}`),
        h('span', { class: 'muted small' }, fmtDate(x.at)))))
      : h('p', { class: 'empty' }, 'Nobody has opened the licence photo.'));
  } catch (e) { showError(e); }
}

// ---------------------------------------------------------------- trash

function trashCard(data, done) {
  const rows = data.trash;
  return h('section', { class: 'card' },
    h('h2', {}, `Returned — customer details in the trash (${rows.length})`),
    h('p', { class: 'muted small' },
      `Kept for ${data.trash_days} days after the return (e.g. for toll or speeding fines), then deleted for good.`),
    rows.length
      ? h('div', { class: 'list' }, rows.map((r) => h('div', { class: 'list-card inner td-row' },
        h('div', { class: 'list-main' },
          h('div', { class: 'list-title' }, h('span', { class: 'rc-reg', translate: 'no' }, r.registration_number), ' ',
            h('span', { translate: 'no' }, carName(r))),
          h('div', {}, h('span', { translate: 'no' }, r.customer_name), ' · ', telLink(r.customer_phone)),
          h('div', { class: 'list-meta' },
            [`${fmtDate(r.started_at)} → ${fmtDate(r.returned_at)}`,
              r.odometer_in != null && r.odometer_out != null && `${fmtKm(r.odometer_in - r.odometer_out)} driven`,
              `deleted for good ${fmtDate(r.purge_at, false)}`].filter(Boolean).join(' · ')),
          r.return_note ? h('div', { class: 'small td-items' }, `Note: ${r.return_note}`) : null),
        h('div', { class: 'row-actions' },
          r.has_license ? h('button', { class: 'btn small', type: 'button', onClick: () => viewLicense(r) }, 'Licence') : null,
          h('button', { class: 'btn small', type: 'button', onClick: () => accessLog(r) }, 'Access log'),
          h('button', {
            class: 'btn small danger', type: 'button',
            onClick: async (e) => {
              if (!confirm(`Delete ${r.customer_name}'s details and licence photo for good now? This cannot be undone.`)) return;
              await busy(e.currentTarget, async () => {
                await api.del(`/rentals/${r.id}/customer`);
                toast('Customer details deleted', 'success');
                await done();
              });
            },
          }, 'Delete now')))))
      : h('p', { class: 'empty' }, 'Nothing in the trash.'));
}

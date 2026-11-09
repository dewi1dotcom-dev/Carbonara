// Test drives: one place to see which cars are out, start a drive (customer,
// driving licence photo, items taken out / put in) and register the return.
// Customer details go to the trash on return and are deleted for good after
// TRASH_DAYS.
import {
  api, append, busy, cameraPicker, debounce, fmtDate, fmtKm, getInspectorId, h, openDialog, pill,
  setInspectorId, showError, toast, vehicleTitle,
} from '../ui.js';

// Most common by far: the spare set of wheels kept in the car is taken out.
const REMOVED_PRESETS = ['Winter wheels', 'Summer wheels', 'Charging cable', 'Floor mats', 'Cargo cover / parcel shelf'];
const ADDED_PRESETS = ['Trade plates (prøvekjennemerker)', 'Charging cable', 'Fuel / charging card', 'Child seat'];

const licenseUrl = (id, variant = 'thumb') => `/api/test-drives/${id}/license/${variant}`;
const telLink = (phone) => h('a', { href: `tel:${phone}` }, phone);

/** "1 h 20 min" since a timestamp. */
function duration(iso) {
  const min = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (min < 60) return `${min} min`;
  const hrs = Math.floor(min / 60);
  return hrs < 24 ? `${hrs} h ${min % 60} min` : `${Math.floor(hrs / 24)} d ${hrs % 24} h`;
}

function viewLicense(drive) {
  openDialog(`Driving licence — ${drive.customer_name}`, h('div', { class: 'photo-view' },
    h('img', { src: licenseUrl(drive.id, 'display'), alt: 'Driving licence' }),
    h('a', { href: licenseUrl(drive.id, 'original'), target: '_blank', rel: 'noopener', class: 'muted' }, 'Open original')),
  { wide: true });
}

/** The privacy notice for the customer (GDPR art. 13), in Norwegian. Printable. */
export function privacyDialog(privacy, trashDays) {
  const contact = privacy?.contact
    ? h('strong', {}, privacy.contact)
    : h('strong', { class: 'td-items' }, '[kontaktinfo mangler – legges inn under System → Company]');
  const company = privacy?.company || 'Forhandleren';
  const body = h('div', { class: 'privacy-text', translate: 'no' }, // a Norwegian document
    h('p', {}, h('strong', {}, company), ' er behandlingsansvarlig for opplysningene vi registrerer når du prøvekjører en bil.'),
    h('h3', {}, 'Hva vi registrerer'),
    h('p', {}, 'Navn, telefonnummer og et bilde av førerkortet ditt (hele kortet, også fødselsnummer), hvilken bil du kjører, og når den ble hentet og levert.'),
    h('h3', {}, 'Hvorfor'),
    h('p', {}, 'For å vite hvem som har bilen, og for å kunne følge opp bompenger, fartsbøter, parkeringsgebyr, skader eller tyveri under prøvekjøringen. '
      + 'Vi tar bilde av hele førerkortet for å kunne identifisere føreren sikkert overfor politi, Statens vegvesen, bompengeselskap og forsikring.'),
    h('h3', {}, 'Rettslig grunnlag'),
    h('p', {}, 'Vår berettigede interesse i å ivareta bilen og håndtere krav som oppstår under prøvekjøringen (personvernforordningen art. 6 nr. 1 bokstav f). '
      + 'Fødselsnummer brukes fordi det er nødvendig for sikker identifisering (personopplysningsloven § 12).'),
    h('h3', {}, 'Hvor lenge'),
    h('p', {}, `Opplysningene om deg slettes automatisk ${trashDays} dager etter at bilen er levert tilbake. `
      + 'Hvilken bil som var ute og når, beholdes uten opplysninger om deg.'),
    h('h3', {}, 'Hvem som ser dem'),
    h('p', {}, 'Bare våre ansatte, som logger inn med personlig kode. Opplysningene lagres på vår egen server og deles ikke, '
      + 'med mindre det er nødvendig for å håndtere et krav (for eksempel overfor politi, bompengeselskap eller forsikringsselskap).'),
    h('h3', {}, 'Dine rettigheter'),
    h('p', {}, 'Du kan be om innsyn, retting og sletting, og protestere mot behandlingen. Kontakt: ', contact,
      '. Du kan også klage til Datatilsynet (datatilsynet.no).'),
    h('div', { class: 'actions no-print' },
      h('button', { class: 'btn', type: 'button', onClick: () => window.print() }, '🖨 Print')));
  openDialog('Personvern – prøvekjøring', body, { wide: true });
}

const itemsText = (d) => [
  d.removed_items?.length && `Taken out: ${d.removed_items.join(', ')}`,
  d.added_items?.length && `Put in: ${d.added_items.join(', ')}`,
  d.items_note,
].filter(Boolean);

export async function testDriveView(el, [preselectId]) {
  const [data, staff] = await Promise.all([api.get('/test-drives'), api.get('/staff')]);
  const rerender = async () => {
    try {
      const fresh = h('div');
      await testDriveView(fresh, []);
      el.replaceChildren(...fresh.childNodes);
    } catch (e) { showError(e); }
  };
  const preselect = preselectId ? await api.get(`/vehicles/${preselectId}`).catch(() => null) : null;

  append(el,
    h('div', { class: 'page-head' }, h('h1', {}, 'Test drive'),
      h('button', { class: 'link small', type: 'button', onClick: () => privacyDialog(data.privacy, data.trash_days) },
        '🔒 Privacy notice for customers')),
    data.privacy?.contact ? null : h('div', { class: 'card notice warn' },
      'The customer privacy notice has no contact details yet. A system admin can add them on the System page → Company.'),
    startCard(staff, data, rerender, preselect),
    h('section', { class: 'card' },
      h('h2', {}, `Out on test drive now (${data.active.length})`),
      data.active.length
        ? h('div', { class: 'list' }, data.active.map((d) => activeRow(d, staff, rerender)))
        : h('p', { class: 'empty' }, 'No cars are out on a test drive.')),
    trashCard(data, rerender));
}

// ---------------------------------------------------------------- start a test drive

function startCard(staff, data, done, preselect) {
  const card = h('section', { class: 'card' }, h('h2', {}, 'Start a test drive'));
  const outIds = new Set(data.active.map((d) => d.vehicle_id));
  const search = h('input', { type: 'search', placeholder: 'Search reg. no, VIN, make, model, colour or spot…', autocomplete: 'off' });
  const results = h('div', { class: 'list' });
  const formSlot = h('div');

  async function find() {
    const q = search.value.trim();
    if (!q) { results.replaceChildren(); return; }
    try {
      const rows = await api.get(`/vehicles?q=${encodeURIComponent(q)}&limit=8`);
      results.replaceChildren(...(rows.length ? rows.map((v) => {
        const out = outIds.has(v.id);
        return h('button', {
          class: 'card list-card', type: 'button', disabled: out,
          onClick: () => choose(v),
        },
        h('div', { class: 'list-main' },
          h('div', { class: 'list-title' }, vehicleTitle(v), ' ', pill(v.status),
            out ? h('span', { class: 'badge warn' }, 'Out on test drive') : null),
          h('div', { class: 'vin mono' }, v.vin)),
        h('div', { class: 'list-meta' },
          [v.registration_number, v.color, v.location_code && `Spot ${v.location_code}`].filter(Boolean).join(' · ')));
      }) : [h('p', { class: 'empty' }, 'No cars found.')]));
    } catch (e) { showError(e); }
  }
  search.addEventListener('input', debounce(find, 250));

  function choose(v) {
    search.value = '';
    results.replaceChildren();
    search.hidden = true;
    formSlot.replaceChildren(startForm(v, staff, data, done, () => {
      formSlot.replaceChildren();
      search.hidden = false;
      search.focus();
    }));
  }

  append(card, search, results, formSlot);
  if (preselect && !outIds.has(preselect.id)) choose(preselect);
  return card;
}

/** Checkbox chips for the presets plus an "Other…" free-text field. */
function itemPicker(presets, label) {
  const boxes = presets.map((p) => h('input', { type: 'checkbox', value: p }));
  const other = h('input', { type: 'text', maxlength: 80, placeholder: 'Other (separate with commas)' });
  const el = h('div', { class: 'field' },
    h('label', {}, label),
    h('div', { class: 'chips' }, boxes.map((b) => h('label', { class: 'chip' }, b, b.value))),
    other);
  const value = () => [
    ...boxes.filter((b) => b.checked).map((b) => b.value),
    ...other.value.split(',').map((s) => s.trim()).filter(Boolean),
  ];
  return { el, value };
}

function startForm(v, staff, data, done, cancel) {
  const informed = h('input', { type: 'checkbox', id: 'td-informed', required: true });
  const name = h('input', { type: 'text', id: 'td-name', required: true, maxlength: 120, autocomplete: 'off' });
  const phone = h('input', { type: 'tel', id: 'td-phone', required: true, maxlength: 20, inputmode: 'tel', autocomplete: 'off', placeholder: 'e.g. 912 34 567' });
  const odo = h('input', { type: 'number', id: 'td-odo', min: 0, inputmode: 'numeric', placeholder: 'km' });
  const note = h('input', { type: 'text', id: 'td-note', maxlength: 500 });
  const staffSel = h('select', { id: 'td-staff' }, h('option', { value: '' }, 'Select staff…'),
    staff.map((s) => h('option', { value: s.id }, s.name)));
  staffSel.value = staff.some((s) => String(s.id) === getInspectorId()) ? getInspectorId() : '';
  const removed = itemPicker(REMOVED_PRESETS, 'Taken out of the car for the test drive');
  const added = itemPicker(ADDED_PRESETS, 'Put into the car for the test drive');

  // Driving licence photo (required).
  let licenseFile = null;
  const preview = h('div', { class: 'photo-tile needed td-license' },
    h('span', { class: 'muted small' }, 'No photo yet'));
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

  // Fill in the name from the licence (fields 1. surname and 2. given names).
  async function readName(file) {
    if (name.value.trim() && name.value !== autoName) return; // staff already typed it
    nameHint.className = 'small muted';
    nameHint.textContent = 'Reading the name from the licence…';
    try {
      const fd = new FormData();
      fd.append('file', file);
      const r = await api.postForm('/test-drives/read-license', fd);
      if (licenseFile !== file) return; // a newer photo was taken meanwhile
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

  const submit = h('button', { class: 'btn primary', type: 'submit' }, 'Start test drive');
  const form = h('form', { class: 'form' },
    h('div', { class: 'card inner notice' },
      h('strong', {}, vehicleTitle(v)), ' ',
      v.registration_number ? h('span', { class: 'mono strong' }, v.registration_number) : null,
      h('div', { class: 'vin mono small' }, v.vin),
      h('button', { class: 'link small', type: 'button', onClick: () => { picker.remove(); cancel(); } }, 'Choose another car')),
    h('h3', {}, 'Customer'),
    h('div', { class: 'field' }, h('label', {}, 'Driving licence'),
      h('div', { class: 'row' }, preview, shootBtn),
      h('div', { class: 'small muted' }, 'Take the photo first — the name is filled in from the licence.')),
    h('div', { class: 'grid' },
      h('div', { class: 'field' }, h('label', { for: 'td-name' }, 'Name'), name, nameHint),
      h('div', { class: 'field' }, h('label', { for: 'td-phone' }, 'Phone number'), phone)),
    h('h3', {}, 'The car'),
    removed.el,
    added.el,
    h('div', { class: 'grid' },
      h('div', { class: 'field' }, h('label', { for: 'td-odo' }, 'Odometer out (optional)'), odo),
      h('div', { class: 'field' }, h('label', { for: 'td-staff' }, 'Handed out by'), staffSel)),
    h('div', { class: 'field' }, h('label', { for: 'td-note' }, 'Note (optional)'), note),
    h('label', { class: 'check', for: 'td-informed' }, informed,
      h('span', {}, 'The customer has been given the privacy information ',
        h('button', { class: 'link', type: 'button', onClick: () => privacyDialog(data.privacy, data.trash_days) }, '(show / print)'))),
    h('p', { class: 'muted small' },
      `Customer details and the licence photo are moved to the trash when the car is returned, and deleted for good after ${data.trash_days} days.`),
    h('div', { class: 'actions' }, submit));

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!licenseFile) { toast('Take a photo of the driving licence first', 'error'); return; }
    if (!informed.checked) { toast('Give the customer the privacy information and tick the box', 'error'); return; }
    busy(submit, async () => {
      const fd = new FormData();
      fd.append('vehicle_id', v.id);
      fd.append('customer_name', name.value);
      fd.append('customer_phone', phone.value);
      fd.append('license', licenseFile);
      if (staffSel.value) { fd.append('staff_id', staffSel.value); setInspectorId(staffSel.value); }
      if (odo.value) fd.append('odometer_out', odo.value);
      fd.append('removed_items', JSON.stringify(removed.value()));
      fd.append('added_items', JSON.stringify(added.value()));
      if (note.value.trim()) fd.append('items_note', note.value);
      fd.append('customer_informed', 'true');
      await api.postForm('/test-drives', fd);
      picker.remove();
      toast(`${v.registration_number || vehicleTitle(v)} is out on a test drive`, 'success');
      if (location.hash !== '#/test-drive') location.hash = '#/test-drive';
      else await done();
    });
  });
  return form;
}

// ---------------------------------------------------------------- cars out now

function activeRow(d, staff, done) {
  return h('div', { class: 'list-card inner td-row' },
    d.has_license
      ? h('button', { class: 'thumb small', type: 'button', title: 'Driving licence', onClick: () => viewLicense(d) },
        h('img', { src: licenseUrl(d.id), alt: 'Driving licence' }))
      : null,
    h('div', { class: 'list-main' },
      h('div', { class: 'list-title' },
        h('a', { href: `#/vehicles/${d.vehicle_id}` }, vehicleTitle(d)), ' ',
        d.registration_number ? h('span', { class: 'mono strong' }, d.registration_number) : null),
      h('div', {}, h('strong', {}, d.customer_name), ' · ', telLink(d.customer_phone)),
      h('div', { class: 'list-meta' },
        [`Out since ${fmtDate(d.started_at)} (${duration(d.started_at)})`, d.started_by_name,
          d.odometer_out != null && fmtKm(d.odometer_out)].filter(Boolean).join(' · ')),
      itemsText(d).map((t) => h('div', { class: 'small td-items' }, t))),
    h('button', { class: 'btn primary', type: 'button', onClick: () => returnDialog(d, staff, done) }, 'Returned'));
}

function returnDialog(d, staff, done) {
  const odo = h('input', { type: 'number', id: 'tr-odo', min: d.odometer_out ?? 0, inputmode: 'numeric', placeholder: 'km' });
  const note = h('input', { type: 'text', id: 'tr-note', maxlength: 500, placeholder: 'e.g. winter wheels left at the customer' });
  const staffSel = h('select', { id: 'tr-staff' }, h('option', { value: '' }, 'Select staff…'),
    staff.map((s) => h('option', { value: s.id }, s.name)));
  staffSel.value = staff.some((s) => String(s.id) === getInspectorId()) ? getInspectorId() : '';
  const items = [
    ...d.removed_items.map((i) => `Put back in the car: ${i}`),
    ...d.added_items.map((i) => `Taken out of the car: ${i}`),
  ];
  const boxes = items.map((t) => h('input', { type: 'checkbox', value: t }));
  const submit = h('button', { class: 'btn primary', type: 'submit' }, 'Register return');

  const form = h('form', {},
    h('p', {}, h('strong', {}, vehicleTitle(d)), ' ', d.registration_number ?? '', ' — ', d.customer_name),
    items.length ? h('div', { class: 'field' },
      h('label', {}, 'Check that the car is back as it was'),
      boxes.map((b) => h('label', { class: 'check' }, b, b.value))) : null,
    h('div', { class: 'grid' },
      h('div', { class: 'field' }, h('label', { for: 'tr-odo' }, 'Odometer in (optional)'), odo),
      h('div', { class: 'field' }, h('label', { for: 'tr-staff' }, 'Received by'), staffSel)),
    h('div', { class: 'field' }, h('label', { for: 'tr-note' }, items.length ? 'Note (required if something is missing)' : 'Note (optional)'), note),
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
      if (staffSel.value) setInspectorId(staffSel.value);
      await api.post(`/test-drives/${d.id}/return`, {
        staff_id: staffSel.value ? Number(staffSel.value) : null,
        odometer_in: odo.value ? Number(odo.value) : null,
        items_checked: allChecked,
        return_note: note.value,
      });
      close();
      toast('Test drive returned · customer details moved to the trash', 'success');
      await done();
    });
  });
  const { close } = openDialog('Car returned', form);
}

/** Who opened the licence photo or deleted the customer's details. */
async function accessLog(d) {
  try {
    const rows = await api.get(`/test-drives/${d.id}/access-log`);
    const label = { license_viewed: 'Opened licence photo', customer_deleted: 'Deleted customer details' };
    openDialog(`Access log — ${d.customer_name ?? 'test drive'}`, rows.length
      ? h('ul', { class: 'plain rows' }, rows.map((r) => h('li', {},
        h('span', {}, `${label[r.action] ?? r.action} — ${r.staff_name ?? 'unknown'}`),
        h('span', { class: 'muted small' }, fmtDate(r.at)))))
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
      ? h('div', { class: 'list' }, rows.map((d) => h('div', { class: 'list-card inner td-row' },
        h('div', { class: 'list-main' },
          h('div', { class: 'list-title' },
            h('a', { href: `#/vehicles/${d.vehicle_id}` }, vehicleTitle(d)), ' ',
            d.registration_number ? h('span', { class: 'mono strong' }, d.registration_number) : null),
          h('div', {}, d.customer_name, ' · ', telLink(d.customer_phone)),
          h('div', { class: 'list-meta' },
            [`${fmtDate(d.started_at)} → ${fmtDate(d.returned_at)}`,
              d.odometer_in != null && d.odometer_out != null && `${fmtKm(d.odometer_in - d.odometer_out)} driven`,
              `deleted for good ${fmtDate(d.purge_at, false)}`].filter(Boolean).join(' · ')),
          d.return_note ? h('div', { class: 'small td-items' }, `Note: ${d.return_note}`) : null),
        h('div', { class: 'row-actions' },
          d.has_license ? h('button', { class: 'btn small', type: 'button', onClick: () => viewLicense(d) }, 'Licence') : null,
          h('button', { class: 'btn small', type: 'button', onClick: () => accessLog(d) }, 'Access log'),
          h('button', {
            class: 'btn small danger', type: 'button',
            onClick: async (e) => {
              if (!confirm(`Delete ${d.customer_name}'s details and licence photo for good now? This cannot be undone.`)) return;
              await busy(e.currentTarget, async () => {
                await api.del(`/test-drives/${d.id}/customer`);
                toast('Customer details deleted', 'success');
                await done();
              });
            },
          }, 'Delete now')))))
      : h('p', { class: 'empty' }, 'Nothing in the trash.'));
}

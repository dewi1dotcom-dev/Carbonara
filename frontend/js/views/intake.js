// Step 0 of an arrival: identify the car by VIN (typed, read from a photo, or
// found from the registration number) and pull its data from Statens vegvesen.
import {
  api, badge, busy, cameraPicker, debounce, euStatus, fmtDate, getInspectorId, h, normalizeVin, regStatus,
  setInspectorId, showError, STATUS, vehicleTitle, vinCheckDigitOk, vinFormatOk,
} from '../ui.js';

const FIELD_LABELS = {
  registration_number: 'Reg. no', make: 'Make', model: 'Model', color: 'Colour', fuel_type: 'Fuel',
};

export async function intakeView(el) {
  const staff = await api.get('/staff');
  if (!staff.length) {
    el.append(
      h('h1', {}, 'New arrival'),
      h('div', { class: 'card notice warn' },
        'Add at least one staff member before starting inspections. ',
        h('a', { href: '#/settings' }, 'Go to settings')));
    return;
  }

  // registry: Statens vegvesen lookup for the current VIN; accept: checkboxes
  // for differences the inspector confirms (take the registry value).
  const state = { vinSource: 'manual', vinPhoto: null, lookup: null, registry: null, accept: {} };

  const inspectorSel = h('select', { id: 'inspector', required: true },
    h('option', { value: '' }, 'Select inspector…'),
    staff.map((s) => h('option', { value: s.id }, s.name)));
  inspectorSel.value = staff.some((s) => String(s.id) === getInspectorId()) ? getInspectorId() : '';

  const vinInput = h('input', {
    id: 'vin', class: 'vin-input mono', maxlength: 24, autocomplete: 'off', spellcheck: 'false',
    autocapitalize: 'characters', placeholder: '17-character VIN',
  });
  const vinStatus = h('div', { class: 'vin-status' });
  const scanResult = h('div', { class: 'scan-result' });
  const lookupBox = h('div');
  const registryBox = h('div', { class: 'registry-box' });

  const regInput = h('input', {
    id: 'regnr', class: 'mono', maxlength: 12, autocomplete: 'off', spellcheck: 'false',
    autocapitalize: 'characters', placeholder: 'e.g. EB 82655',
  });
  const regBtn = h('button', { class: 'btn', type: 'button' }, 'Find VIN');
  const regStatusLine = h('div', { class: 'vin-status' });
  const startBtn = h('button', { class: 'btn primary big', disabled: true }, 'Start inspection');

  const picker = cameraPicker(scanPhoto);
  const scanBtn = h('button', { class: 'btn', type: 'button', onClick: () => picker.open() }, '📷 Read VIN or plate from photo');

  function currentVin() { return normalizeVin(vinInput.value); }

  function updateStatus() {
    const vin = currentVin();
    vinStatus.replaceChildren();
    vinStatus.className = 'vin-status';
    if (!vin) return;
    const bad = vin.match(/[IOQ]/g);
    if (bad) {
      vinStatus.classList.add('bad');
      vinStatus.append(`VINs never contain ${[...new Set(bad)].join(', ')} — did you mean 1 or 0?`);
    } else if (/[^A-Z0-9]/.test(vin)) {
      vinStatus.classList.add('bad');
      vinStatus.append('Only letters and digits are allowed.');
    } else if (vin.length !== 17) {
      vinStatus.append(`${vin.length}/17 characters`);
    } else if (vinCheckDigitOk(vin)) {
      vinStatus.classList.add('good');
      vinStatus.append('✓ Valid VIN (check digit matches)');
    } else if ('12345L'.includes(vin[0])) {
      // North America / China: the check digit is mandatory, so a mismatch means a typo.
      vinStatus.classList.add('bad');
      vinStatus.append('Check digit does not match — for this manufacturer a character is probably wrong.');
    } else {
      vinStatus.classList.add('warn');
      vinStatus.append('✓ Valid format. (Check digit not used by this manufacturer — normal for many European cars.)');
    }
  }

  function updateStart() {
    const lk = state.lookup;
    const blocked = lk?.existing_vehicle?.status === 'in_storage' && !lk.open_inspection_id;
    startBtn.disabled = !(vinFormatOk(currentVin()) && inspectorSel.value && lk && lk.vin === currentVin() && !blocked);
    startBtn.textContent = lk?.open_inspection_id ? 'Continue inspection' : 'Start inspection';
  }

  const doLookup = debounce(async () => {
    const vin = currentVin();
    if (!vinFormatOk(vin)) return;
    if (state.registry?.vin !== vin) fetchRegistry({ vin });
    try {
      const res = await api.get(`/vin/${vin}`);
      if (res.vin !== currentVin()) return; // input changed meanwhile
      state.lookup = res;
      renderLookup();
      updateStart();
    } catch (err) { showError(err); }
  }, 350);

  // ---- Statens vegvesen
  async function fetchRegistry(query) {
    const key = query.vin || query.regnr;
    state.registry = { loading: true, key };
    renderRegistry();
    try {
      const res = await api.get(`/registry/lookup?${new URLSearchParams(query)}`);
      // Ignore answers that were superseded by a newer lookup or a changed VIN.
      if (state.registry?.key !== key || (query.vin && query.vin !== currentVin())) return null;
      state.registry = { ...res, key, vin: res.vin || query.vin || null };
      state.accept = {};
      renderRegistry();
      return res;
    } catch (err) {
      state.registry = null;
      renderRegistry();
      showError(err);
      return null;
    }
  }

  function renderRegistry() {
    const r = state.registry;
    registryBox.replaceChildren();
    if (!r || r.configured === false) return;
    if (r.loading) {
      registryBox.append(h('div', { class: 'card spinner-line' }, 'Checking Statens vegvesen…'));
      return;
    }
    if (!r.found) {
      registryBox.append(h('div', { class: `card notice ${r.error ? 'warn' : ''}` },
        r.error ? `Could not reach Statens vegvesen: ${r.message}`
          : 'Not found in Statens vegvesen — normal for cars not yet registered in Norway.'));
      return;
    }
    const val = r.values || {};
    const eu = euStatus(r.eu_control_due);
    const rows = [
      ['Car', [val.make, val.model].filter(Boolean).join(' ')],
      ['Reg. no', val.registration_number && h('span', { class: 'mono strong' }, val.registration_number)],
      ['Registration', badge(regStatus(true, r.status_code, r.registration_status))],
      ['EU-kontroll', eu && h('span', { class: 'inline' }, badge(eu), `due ${fmtDate(r.eu_control_due, false)}`)],
      ['Colour', val.color],
      ['Fuel', val.fuel_type],
      ['VIN location', r.vin_location],
    ].filter(([, v]) => v);

    const mism = r.mismatches || [];
    registryBox.append(h('section', { class: 'card' },
      h('h2', {}, 'Statens vegvesen'),
      h('dl', { class: 'kv' }, rows.map(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])),
      mism.length ? h('div', { class: 'mismatch-box' },
        h('h3', {}, 'Differs from what we have on file'),
        h('p', { class: 'muted small' }, 'Ticked fields are updated to the Statens vegvesen value when the inspection starts.'),
        h('div', { class: 'table-wrap' }, h('table', {},
          h('thead', {}, h('tr', {}, ['Use', 'Field', 'On file', 'Statens vegvesen'].map((t) => h('th', {}, t)))),
          h('tbody', {}, mism.map((m) => {
            const cb = h('input', { type: 'checkbox', id: `acc-${m.field}` });
            cb.checked = state.accept[m.field] ?? true;
            state.accept[m.field] = cb.checked;
            cb.addEventListener('change', () => { state.accept[m.field] = cb.checked; });
            return h('tr', {}, h('td', {}, cb),
              h('td', {}, h('label', { for: cb.id }, FIELD_LABELS[m.field] ?? m.field)),
              h('td', { class: 'old' }, m.current ?? '–'),
              h('td', { class: 'strong' }, m.registry));
          }))))) : null,
      h('p', { class: 'muted small' },
        r.status_code === 'REGISTRERT'
          ? 'The data is saved and the car is marked as registered when the inspection starts.'
          : 'The data is saved when the inspection starts.')));
  }

  async function findByRegnr() {
    const regnr = regInput.value.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    regStatusLine.className = 'vin-status';
    if (regnr.length < 2) { regStatusLine.textContent = 'Type a registration number first.'; return; }
    regStatusLine.textContent = 'Looking up…';
    await busy(regBtn, async () => {
      const res = await fetchRegistry({ regnr });
      if (!res) { regStatusLine.textContent = ''; return; }
      if (!res.configured) {
        regStatusLine.textContent = 'Statens vegvesen API key is not configured on the server.';
      } else if (!res.found || !res.vin) {
        regStatusLine.classList.add('bad');
        regStatusLine.textContent = res.message || 'No car found with this registration number.';
      } else {
        regStatusLine.classList.add('good');
        regStatusLine.textContent = `✓ Found — VIN filled in from Statens vegvesen`;
        state.registry.key = res.vin; // the registry result belongs to this VIN now
        state.registry.vin = res.vin;
        vinInput.value = res.vin;
        onVinChanged();
        state.vinSource = 'registry';
      }
    });
  }
  regBtn.addEventListener('click', findByRegnr);
  regInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); findByRegnr(); } });

  function renderLookup() {
    const lk = state.lookup;
    lookupBox.replaceChildren();
    if (!lk || lk.vin !== currentVin()) return;
    const v = lk.existing_vehicle;
    if (v && lk.open_inspection_id) {
      lookupBox.append(h('div', { class: 'card notice' },
        `${vehicleTitle(v)} already has an arrival inspection in progress. Continuing will open it.`));
    } else if (v?.status === 'in_storage') {
      lookupBox.append(h('div', { class: 'card notice warn' },
        `${vehicleTitle(v)} is already in stock (${STATUS[v.status]}). `,
        h('a', { href: `#/vehicles/${v.id}` }, 'View vehicle')));
    } else if (v) {
      lookupBox.append(h('div', { class: 'card notice' },
        `Known vehicle: ${vehicleTitle(v)}. A new arrival inspection will be added to its history.`));
    } else {
      const decoded = [lk.make, lk.model_year && `model year ${lk.model_year}`].filter(Boolean).join(', ');
      lookupBox.append(h('div', { class: 'card notice' },
        'New vehicle — not seen before.', decoded ? ` From the VIN: ${decoded}.` : ''));
    }
    // NA/China VINs (e.g. MG) must pass the check digit; if not, a character is misread.
    if (lk.check_digit_required && lk.check_digit_ok === false) {
      lookupBox.append(h('div', { class: 'card notice bad' },
        h('strong', {}, 'Check digit does not match. '),
        'For this manufacturer that means a character is probably wrong (8/B, 5/S, 0/D, 2/Z…). Compare with the car.'));
    }
  }

  function onVinChanged() {
    updateStatus();
    state.lookup = null;
    if (state.registry && state.registry.vin !== currentVin() && !state.registry.loading) {
      state.registry = null;
      renderRegistry();
    }
    renderLookup();
    updateStart();
    doLookup();
  }

  vinInput.addEventListener('input', () => {
    const upper = vinInput.value.toUpperCase();
    if (upper !== vinInput.value) {
      const pos = vinInput.selectionStart;
      vinInput.value = upper;
      vinInput.setSelectionRange(pos, pos);
    }
    state.vinSource = 'manual';
    onVinChanged();
  });
  inspectorSel.addEventListener('change', () => { setInspectorId(inspectorSel.value); updateStart(); });

  async function scanPhoto(file) {
    state.vinPhoto = file;
    scanResult.replaceChildren(h('div', { class: 'spinner-line' }, 'Reading photo…'));
    scanBtn.disabled = true;
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await api.postForm('/vin/recognize', fd);
      const plates = res.plates || [];
      let candidates = res.candidates || [];
      // One clear high-confidence VIN: show just that (and fill it in), not the
      // low-confidence fragments the reader also found around it.
      const high = candidates.filter((c) => c.confidence === 'high');
      if (high.length === 1) candidates = high;
      scanResult.replaceChildren();
      if (!candidates.length && !plates.length) {
        scanResult.append(h('div', { class: 'card notice warn' },
          'No VIN or registration plate found. Try again a bit closer, avoid glare, or type it in.'));
        return;
      }
      const choose = (c) => {
        vinInput.value = c.vin;
        onVinChanged();
        state.vinSource = c.source;
      };
      // A plate is checked against Statens vegvesen, which also fills in the VIN.
      const choosePlate = (p) => {
        regInput.value = p.plate;
        findByRegnr();
      };
      if (candidates.length === 1 && candidates[0].confidence === 'high') choose(candidates[0]);
      else if (!candidates.length && plates[0].confidence === 'medium') choosePlate(plates[0]);

      if (candidates.length) {
        scanResult.append(
          h('p', { class: 'muted' }, candidates.length === 1 ? 'VIN found:' : 'Possible VINs — tap the right one:'),
          h('div', { class: 'candidates' }, candidates.map((c) =>
            h('button', { class: `candidate conf-${c.confidence}`, type: 'button', onClick: () => choose(c) },
              h('span', { class: 'mono' }, c.vin),
              h('small', {}, [
                c.make && `${c.make}${c.model_year ? ` ${c.model_year}` : ''}`,
                c.source === 'barcode' ? 'Barcode' : 'Text recognition',
                `${c.confidence} confidence`,
                c.repaired_from && `1 character corrected (read as ${c.repaired_from})`,
              ].filter(Boolean).join(' · '))))));
      }
      if (plates.length) {
        scanResult.append(
          h('p', { class: 'muted' }, plates.length === 1 ? 'Registration plate found:' : 'Possible plates — tap the right one:'),
          h('div', { class: 'candidates' }, plates.map((p) =>
            h('button', { class: `candidate conf-${p.confidence}`, type: 'button', onClick: () => choosePlate(p) },
              h('span', { class: 'mono' }, p.plate),
              h('small', {}, p.custom
                ? 'Personalised plate? · tap to look up'
                : `Plate · ${p.confidence} confidence · tap to look up`)))));
      }
      scanResult.append(h('p', { class: 'muted small' }, 'Always compare with the car before starting.'));
    } catch (err) {
      scanResult.replaceChildren();
      showError(err);
    } finally {
      scanBtn.disabled = false;
    }
  }

  startBtn.addEventListener('click', () => busy(startBtn, async () => {
    const reg = state.registry;
    const res = await api.post('/intake', {
      vin: currentVin(),
      inspector_id: Number(inspectorSel.value),
      vin_source: state.vinSource,
      // Make and model year decoded from the VIN, used for new cars only; Statens
      // vegvesen data (if the car is registered) is checked against them later.
      vehicle: state.lookup?.vin === currentVin() && (state.lookup.make || state.lookup.model_year)
        ? { make: state.lookup.make || null, model_year: state.lookup.model_year || null } : null,
      use_registry: true, // the server pulls Statens vegvesen data if the API key is configured
      accept_fields: reg?.found && reg.vin === currentVin()
        ? Object.entries(state.accept).filter(([, on]) => on).map(([f]) => f) : [],
    });
    if (state.vinPhoto && state.vinSource !== 'manual') {
      const fd = new FormData();
      fd.append('kind', 'vin');
      fd.append('file', state.vinPhoto);
      fd.append('uploaded_by', inspectorSel.value);
      await api.postForm(`/inspections/${res.inspection_id}/photos`, fd).catch(showError);
    }
    location.hash = `#/inspections/${res.inspection_id}`;
  }));

  el.append(
    h('div', { class: 'page-head' }, h('h1', {}, 'New arrival')),
    h('div', { class: 'card form' },
      h('label', { for: 'inspector' }, 'Inspector'),
      inspectorSel,
      h('label', { for: 'regnr' }, 'Registration number (if the car has one)'),
      h('div', { class: 'inline-form' }, regInput, regBtn),
      regStatusLine,
      h('label', { for: 'vin' }, 'VIN (chassis number)'),
      vinInput,
      vinStatus,
      h('div', { class: 'row' }, scanBtn),
      h('p', { class: 'muted small' },
        'Tip: photograph the registration plate, the VIN plate at the bottom of the windscreen, the label in the driver door frame (barcode), or the registration document. The photo does not need to be level.'),
      scanResult),
    lookupBox,
    registryBox,
    h('div', { class: 'actions' }, startBtn),
  );
  setTimeout(() => vinInput.focus(), 0); // after the router attaches the view

  // Clean up the hidden file input when we navigate away.
  window.addEventListener('hashchange', () => picker.remove(), { once: true });
}

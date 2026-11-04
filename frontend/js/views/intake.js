// Step 0 of an arrival: identify the car by VIN (typed or read from a photo).
import {
  api, busy, cameraPicker, debounce, getInspectorId, h, normalizeVin, setInspectorId, showError,
  STATUS, vehicleTitle, vinCheckDigitOk, vinFormatOk,
} from '../ui.js';

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

  const state = { vinSource: 'manual', vinPhoto: null, lookup: null };

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
  const startBtn = h('button', { class: 'btn primary big', disabled: true }, 'Start inspection');

  const picker = cameraPicker(scanPhoto);
  const scanBtn = h('button', { class: 'btn', type: 'button', onClick: () => picker.open() }, '📷 Read VIN from photo');

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
    } else {
      vinStatus.classList.add('warn');
      vinStatus.append('✓ Valid format. (Check digit not used by this manufacturer — normal for most European cars.)');
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
    try {
      const res = await api.get(`/vin/${vin}`);
      if (res.vin !== currentVin()) return; // input changed meanwhile
      state.lookup = res;
      renderLookup();
      updateStart();
    } catch (err) { showError(err); }
  }, 350);

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
      lookupBox.append(h('div', { class: 'card notice' }, 'New vehicle — not seen before.'));
    }
  }

  function onVinChanged() {
    updateStatus();
    state.lookup = null;
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
    scanResult.replaceChildren(h('div', { class: 'spinner-line' }, 'Reading VIN from photo…'));
    scanBtn.disabled = true;
    try {
      const fd = new FormData();
      fd.append('file', file);
      const { candidates } = await api.postForm('/vin/recognize', fd);
      scanResult.replaceChildren();
      if (!candidates.length) {
        scanResult.append(h('div', { class: 'card notice warn' },
          'No VIN found. Try again closer and straight-on, avoid glare, or type it in.'));
        return;
      }
      const choose = (c) => {
        vinInput.value = c.vin;
        onVinChanged();
        state.vinSource = c.source;
      };
      if (candidates.length === 1 && candidates[0].confidence === 'high') choose(candidates[0]);
      scanResult.append(
        h('p', { class: 'muted' }, candidates.length === 1 ? 'Found:' : 'Possible VINs — tap the right one:'),
        h('div', { class: 'candidates' }, candidates.map((c) =>
          h('button', { class: `candidate conf-${c.confidence}`, type: 'button', onClick: () => choose(c) },
            h('span', { class: 'mono' }, c.vin),
            h('small', {}, `${c.source === 'barcode' ? 'Barcode' : 'Text recognition'} · ${c.confidence} confidence`)))),
        h('p', { class: 'muted small' }, 'Always compare with the car before starting.'));
    } catch (err) {
      scanResult.replaceChildren();
      showError(err);
    } finally {
      scanBtn.disabled = false;
    }
  }

  startBtn.addEventListener('click', () => busy(startBtn, async () => {
    const res = await api.post('/intake', {
      vin: currentVin(),
      inspector_id: Number(inspectorSel.value),
      vin_source: state.vinSource,
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
      h('label', { for: 'vin' }, 'VIN (chassis number)'),
      vinInput,
      vinStatus,
      h('div', { class: 'row' }, scanBtn),
      h('p', { class: 'muted small' },
        'Tip: photograph the VIN plate at the bottom of the windscreen, the label in the driver door frame (barcode), or the registration document.'),
      scanResult),
    lookupBox,
    h('div', { class: 'actions' }, startBtn),
  );
  setTimeout(() => vinInput.focus(), 0); // after the router attaches the view

  // Clean up the hidden file input when we navigate away.
  window.addEventListener('hashchange', () => picker.remove(), { once: true });
}

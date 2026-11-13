// Arrival inspection: vehicle details -> 4 photos -> damage -> (factory-new cars,
// first arrival: MG's first storage check) -> storage.
import { carDiagram, DIAGRAM_PANELS, EXTRA_PANELS, PANEL_LABELS } from '../diagram.js';
import { checkDialog } from './storagecare.js';
import {
  api, busy, cameraPicker, CONDITION, dateInput, osloTodayIso, duplicateNotice, fmtDate, fmtKm, FUEL_TYPES, getInspectorId, h, openDialog, photoUrl, pill,
  showError, spotLabel, toast, vehicleTitle, viewPhoto, wheelsSelect,
} from '../ui.js';

const ANGLES = [
  { kind: 'front', label: 'Front' },
  { kind: 'rear', label: 'Rear' },
  { kind: 'left', label: 'Left side' },
  { kind: 'right', label: 'Right side' },
];
const DAMAGE_TYPES = ['scratch', 'dent', 'chip', 'crack', 'scuff', 'rust', 'broken', 'missing', 'other'];
const SEVERITIES = ['minor', 'moderate', 'severe'];
const FUEL_LEVELS = [
  [0, 'Empty'], [13, '1/8'], [25, '1/4'], [38, '3/8'], [50, '1/2'],
  [63, '5/8'], [75, '3/4'], [88, '7/8'], [100, 'Full'],
];
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

export async function inspectionView(el, [id]) {
  let data = await api.get(`/inspections/${id}`);
  const editable = () => data.status === 'in_progress';
  // One shared hidden camera input; each button sets what happens with the file.
  let onPicked = null;
  const camera = cameraPicker((f) => onPicked?.(f));
  window.addEventListener('hashchange', () => camera.remove(), { once: true });
  const picker = (fn) => ({ open: () => { onPicked = fn; camera.open(); } });

  const slots = {
    head: h('div'),
    checklist: h('div'),
    photos: h('div'),
    damage: h('div'),
    storage: h('div'),
    finish: h('div'),
  };

  async function reload() {
    data = await api.get(`/inspections/${id}`);
    renderDynamic();
  }

  function renderDynamic() {
    renderHead();
    renderChecklist();
    renderPhotos();
    renderDamage();
    renderStorageCheck();
    renderFinish();
  }

  // ------------------------------------------------------------ header
  function renderHead() {
    const v = data.vehicle;
    // filter(Boolean): replaceChildren() would print a missing warning as "null"
    slots.head.replaceChildren(...[h('div', { class: 'page-head' },
      h('div', {},
        h('h1', {}, vehicleTitle(v)),
        h('div', { class: 'vin mono big' }, v.vin),
        h('div', { class: 'muted' },
          `Arrival inspection · ${data.inspector_name ?? 'no inspector'} · started ${fmtDate(data.started_at)}`)),
      h('div', { class: 'head-side' }, pill(data.status),
        h('a', { href: `#/vehicles/${v.id}`, class: 'small' }, 'Vehicle history →'))),
    duplicateNotice(data.possible_duplicates)].filter(Boolean));
  }

  function renderChecklist() {
    const done = data.checklist.filter((c) => c.done).length;
    slots.checklist.replaceChildren(h('div', { class: 'checklist card' },
      h('div', { class: 'progress' }, h('div', { style: { width: `${(done / data.checklist.length) * 100}%` } })),
      h('ul', {}, data.checklist.map((c) => h('li', { class: c.done ? 'done' : '' }, c.label)))));
  }

  // ------------------------------------------------------------ 1. details
  function detailsCard() {
    const v = data.vehicle;
    const ro = !editable();
    const status = h('span', { class: 'save-state muted small' });

    async function save(kind, field, raw) {
      let value = typeof raw === 'string' ? raw.trim() : raw;
      if (value === '') value = null;
      if (['model_year', 'odometer_km', 'keys_count', 'fuel_level_pct', 'last_service_km'].includes(field) && value != null) value = Number(value);
      status.textContent = 'Saving…';
      try {
        if (kind === 'vehicle') await api.patch(`/vehicles/${v.id}`, { [field]: value });
        else await api.patch(`/inspections/${id}`, { [field]: value });
        status.textContent = '✓ Saved';
        await reload();
      } catch (err) {
        status.textContent = '';
        showError(err);
      }
    }

    const field = (kind, name, label, input) => {
      input.id = `f-${name}`;
      input.disabled = ro;
      input.addEventListener('change', () => save(kind, name, input.value));
      return h('div', { class: 'field' }, h('label', { for: input.id }, label), input);
    };
    const text = (value, attrs = {}) => h('input', { type: 'text', value: value ?? '', ...attrs });
    const num = (value, attrs = {}) => h('input', { type: 'number', inputmode: 'numeric', value: value ?? '', ...attrs });

    const fuelSel = h('select', {}, h('option', { value: '' }, '–'),
      FUEL_LEVELS.map(([p, l]) => h('option', { value: p }, l)));
    fuelSel.value = data.fuel_level_pct ?? '';

    // New from the factory, or used. Used cars record their last service;
    // a new car's first service is due one year after registration.
    const condSel = h('select', {}, h('option', { value: '' }, 'Choose…'),
      Object.entries(CONDITION).map(([k, l]) => h('option', { value: k }, l)));
    condSel.value = v.condition ?? '';
    const today = osloTodayIso();

    // The details card is built once (so typing isn't interrupted by reloads),
    // so this part redraws itself as soon as New/Used is chosen.
    const serviceSlot = h('div', { class: 'service-slot' });
    const renderService = (condition) => {
      const cur = data.vehicle;
      serviceSlot.replaceChildren(...(condition === 'used'
        ? [h('div', { class: 'grid' },
          // Used cars: which wheels are on (required; the season warnings use it).
          field('vehicle', 'wheels', 'Summer or winter wheels? *', wheelsSelect(cur.wheels))),
        h('div', { class: 'grid' },
          field('vehicle', 'last_service_date', 'Last service date',
            dateInput({ value: cur.last_service_date ?? '', max: today })),
          field('vehicle', 'last_service_km', 'Odometer at last service (km)', num(cur.last_service_km, { min: 0 }))),
        h('p', { class: 'muted small' }, 'Leave empty if the service history is unknown; the next service is then estimated from the registration date.')]
        : condition === 'new'
          ? [h('p', { class: 'muted small' },
            'New car: no service record needed. The first service is due one year after registration (date from Statens vegvesen).')]
          : []));
    };
    renderService(v.condition);
    condSel.addEventListener('change', () => renderService(condSel.value));

    return h('section', { class: 'card step' },
      h('div', { class: 'step-head' }, h('h2', {}, '1. Vehicle details'), status),
      h('div', { class: 'grid' }, field('vehicle', 'condition', 'New or used? *', condSel)),
      serviceSlot,
      h('div', { class: 'grid' },
        field('vehicle', 'make', 'Make *', text(v.make, { list: 'dl-makes', autocomplete: 'off' })),
        field('vehicle', 'model', 'Model *', text(v.model)),
        field('vehicle', 'variant', 'Variant / trim', text(v.variant)),
        field('vehicle', 'model_year', 'Model year', num(v.model_year, { min: 1900, max: 2100 })),
        field('vehicle', 'color', 'Colour', text(v.color)),
        field('vehicle', 'fuel_type', 'Fuel type', text(v.fuel_type, { list: 'dl-fuel' })),
        field('vehicle', 'registration_number', 'Registration no.', text(v.registration_number, { class: 'mono' })),
        field('inspection', 'odometer_km', 'Odometer (km) *', num(data.odometer_km, { min: 0 })),
        field('inspection', 'fuel_level_pct', 'Fuel / charge level', fuelSel),
        field('inspection', 'keys_count', 'Keys received', num(data.keys_count, { min: 0, max: 20 }))),
      field('inspection', 'notes', 'Notes', h('textarea', { rows: 3, value: data.notes ?? '' })),
      h('datalist', { id: 'dl-fuel' }, FUEL_TYPES.map((f) => h('option', { value: f }))),
      h('datalist', { id: 'dl-makes' },
        ['Audi', 'BMW', 'Citroën', 'Cupra', 'Dacia', 'Fiat', 'Ford', 'Honda', 'Hyundai', 'Kia', 'Lexus',
          'Mazda', 'Mercedes-Benz', 'MG', 'Mini', 'Mitsubishi', 'Nissan', 'Opel', 'Peugeot', 'Polestar',
          'Renault', 'Seat', 'Skoda', 'Subaru', 'Suzuki', 'Tesla', 'Toyota', 'Volkswagen', 'Volvo']
          .map((m) => h('option', { value: m }))));
  }

  // ------------------------------------------------------------ 2. photos
  async function upload(kind, file, tile) {
    tile?.classList.add('busy');
    try {
      const fd = new FormData();
      fd.append('kind', kind);
      fd.append('file', file);
      const me = getInspectorId();
      if (me) fd.append('uploaded_by', me);
      const photo = await api.postForm(`/inspections/${id}/photos`, fd);
      await reload();
      return photo;
    } catch (err) {
      showError(err);
      return null;
    } finally {
      tile?.classList.remove('busy');
    }
  }

  function photoTile(kind, label, required) {
    const photo = data.photos.find((p) => p.kind === kind);
    const tile = h('div', { class: `photo-tile${photo ? ' has' : ''}${required && !photo ? ' needed' : ''}` });
    const pk = picker((f) => upload(kind, f, tile));
    if (photo) {
      tile.append(
        h('button', { class: 'thumb', type: 'button', onClick: () => viewPhoto(photo.id, label) },
          h('img', { src: photoUrl(photo.id), alt: label, loading: 'lazy' })),
        h('div', { class: 'tile-foot' }, h('span', {}, `✓ ${label}`),
          editable() && h('button', { class: 'link', type: 'button', onClick: () => pk.open() }, 'Retake')));
    } else if (editable()) {
      tile.append(h('button', { class: 'shoot', type: 'button', onClick: () => pk.open() },
        h('span', { class: `angle-icon a-${kind}` }), h('span', {}, `📷 ${label}`)));
    } else {
      tile.append(h('div', { class: 'shoot' }, `${label}: no photo`));
    }
    tile.append(h('div', { class: 'tile-spinner' }, 'Uploading…'));
    return tile;
  }

  function renderPhotos() {
    const extras = data.photos.filter((p) => p.kind === 'other');
    const extraPicker = picker((f) => upload('other', f));
    slots.photos.replaceChildren(h('section', { class: 'card step' },
      h('div', { class: 'step-head' }, h('h2', {}, '2. Photos')),
      h('p', { class: 'muted small' },
        'Take one photo from each side with the whole car in frame. "Left" means the left side when sitting in the car.'),
      h('div', { class: 'photo-grid' }, ANGLES.map((a) => photoTile(a.kind, a.label, true))),
      h('div', { class: 'photo-grid small' },
        photoTile('vin', 'VIN plate', false),
        extras.map((p) => h('div', { class: 'photo-tile has' },
          h('button', { class: 'thumb', type: 'button', onClick: () => viewPhoto(p.id, 'Extra photo') },
            h('img', { src: photoUrl(p.id), alt: 'Extra photo', loading: 'lazy' })),
          editable() && h('div', { class: 'tile-foot' }, h('span', {}, 'Extra'),
            h('button', {
              class: 'link danger', type: 'button',
              onClick: async () => {
                if (!confirm('Delete this photo?')) return;
                try { await api.del(`/photos/${p.id}`); await reload(); } catch (e) { showError(e); }
              },
            }, 'Delete')))),
        editable() && h('div', { class: 'photo-tile' },
          h('button', { class: 'shoot', type: 'button', onClick: () => extraPicker.open() }, '+ Extra photo')))));
  }

  // ------------------------------------------------------------ 3. damage
  function damageDialog(existing, defaults = {}) {
    const d = { panel: 'other', damage_type: 'scratch', severity: 'minor', ...defaults, ...existing };
    let newFile = null;
    const ro = !editable();

    const panelSel = h('select', { id: 'd-panel', disabled: ro },
      h('optgroup', { label: 'Body' }, DIAGRAM_PANELS.map((p) => h('option', { value: p.id }, p.label))),
      h('optgroup', { label: 'Other' }, EXTRA_PANELS.map((p) => h('option', { value: p.id }, p.label))));
    panelSel.value = d.panel;

    const chips = (name, options, current) => {
      const box = h('div', { class: 'chips', role: 'radiogroup' });
      for (const o of options) {
        box.append(h('label', { class: `chip${name === 'severity' ? ` sev-${o}` : ''}` },
          h('input', { type: 'radio', name, value: o, checked: o === current, disabled: ro }), cap(o)));
      }
      return box;
    };
    const typeChips = chips('damage_type', DAMAGE_TYPES, d.damage_type);
    const sevChips = chips('severity', SEVERITIES, d.severity);
    const sizeInput = h('input', { id: 'd-size', type: 'number', inputmode: 'numeric', min: 1, value: d.size_mm ?? '', disabled: ro });
    const descInput = h('textarea', { id: 'd-desc', rows: 2, value: d.description ?? '', disabled: ro });

    const preview = h('div', { class: 'damage-photo' });
    const showPreview = () => {
      preview.replaceChildren();
      if (newFile) preview.append(h('img', { src: URL.createObjectURL(newFile), alt: 'Damage photo' }));
      else if (d.photo_id) preview.append(h('img', { src: photoUrl(d.photo_id), alt: 'Damage photo' }));
    };
    showPreview();
    const pk = picker((f) => { newFile = f; showPreview(); });

    const saveBtn = h('button', { class: 'btn primary', type: 'submit' }, existing ? 'Save' : 'Add damage');
    const form = h('form', { class: 'form' },
      h('label', { for: 'd-panel' }, 'Location'), panelSel,
      h('label', {}, 'Type'), typeChips,
      h('label', {}, 'Severity'), sevChips,
      h('div', { class: 'grid two' },
        h('div', { class: 'field' }, h('label', { for: 'd-size' }, 'Size (mm)'), sizeInput)),
      h('label', { for: 'd-desc' }, 'Description'), descInput,
      h('label', {}, 'Photo of the damage'),
      preview,
      !ro && h('button', { class: 'btn', type: 'button', onClick: () => pk.open() },
        d.photo_id || newFile ? '📷 Retake photo' : '📷 Take photo'),
      h('div', { class: 'actions spread' },
        existing && !ro && h('button', {
          class: 'btn danger', type: 'button',
          onClick: async () => {
            if (!confirm('Delete this damage?')) return;
            try { await api.del(`/damages/${existing.id}`); close(); await reload(); } catch (e) { showError(e); }
          },
        }, 'Delete'),
        h('span'),
        !ro && saveBtn));

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      busy(saveBtn, async () => {
        const fd = new FormData(form);
        const body = {
          panel: panelSel.value,
          damage_type: fd.get('damage_type'),
          severity: fd.get('severity'),
          size_mm: sizeInput.value ? Number(sizeInput.value) : null,
          description: descInput.value,
        };
        if (!existing) { body.pos_x = d.pos_x ?? null; body.pos_y = d.pos_y ?? null; }
        if (newFile) {
          const photo = await upload('damage', newFile);
          if (!photo) return;
          body.photo_id = photo.id;
        }
        if (existing) await api.patch(`/damages/${existing.id}`, body);
        else await api.post(`/inspections/${id}/damages`, body);
        close();
        await reload();
      });
    });

    const { close } = openDialog(existing ? 'Damage' : 'Add damage', form);
  }

  function renderDamage() {
    const ro = !editable();
    const noDamage = h('input', {
      type: 'checkbox', id: 'no-damage', checked: data.no_damage_confirmed,
      disabled: ro || data.damages.length > 0,
    });
    noDamage.addEventListener('change', async () => {
      try {
        await api.patch(`/inspections/${id}`, { no_damage_confirmed: noDamage.checked });
        await reload();
      } catch (e) { noDamage.checked = !noDamage.checked; showError(e); }
    });

    slots.damage.replaceChildren(h('section', { class: 'card step' },
      h('div', { class: 'step-head' }, h('h2', {}, '3. Damage inspection')),
      !ro && h('p', { class: 'muted small' }, 'Walk around the car. Tap the diagram where you find damage.'),
      h('div', { class: 'damage-layout' },
        h('div', { class: 'diagram-wrap' },
          h('div', { class: 'front-label' }, '▲ FRONT'),
          carDiagram({
            damages: data.damages,
            editable: !ro,
            onAdd: (panel, x, y) => damageDialog(null, { panel, pos_x: x, pos_y: y }),
            onSelect: (d) => damageDialog(d),
          })),
        h('div', { class: 'damage-list' },
          data.damages.length
            ? h('ol', {}, data.damages.map((d) => h('li', {},
              h('button', { class: `damage-item sev-${d.severity}`, type: 'button', onClick: () => damageDialog(d) },
                d.photo_id ? h('img', { src: photoUrl(d.photo_id), alt: '' }) : h('span', { class: 'no-photo' }, 'no photo'),
                h('span', {},
                  h('strong', {}, PANEL_LABELS[d.panel] ?? d.panel),
                  h('br'),
                  `${cap(d.damage_type)} · ${d.severity}${d.size_mm ? ` · ${d.size_mm} mm` : ''}`,
                  d.description && h('span', { class: 'muted small block' }, d.description))))))
            : h('p', { class: 'empty' }, 'No damage recorded.'),
          !ro && h('button', { class: 'btn', type: 'button', onClick: () => damageDialog(null) },
            '+ Add damage without diagram position'),
          h('label', { class: 'check' }, noDamage, ' No damage found on this vehicle'))),
    ));
  }

  // ------------------------------------------------------------ 4. first storage check (new cars)
  // Shown when the server says the car needs one (factory new, first arrival).
  const storageStepShown = () => !!data.storage_check && (data.storage_check.done || editable());
  const finishNo = () => (storageStepShown() ? 5 : 4);

  function renderStorageCheck() {
    const sc = data.storage_check;
    if (!storageStepShown()) { slots.storage.replaceChildren(); return; }
    const openCheck = async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        const p = await api.get(`/vehicles/${data.vehicle.id}/storage-care`);
        if (p.next?.kind !== 'arrival') throw new Error(p.note || 'No storage check is due for this car');
        checkDialog(data.vehicle, p, reload);
      } catch (err) { showError(err); } finally { btn.disabled = false; }
    };
    slots.storage.replaceChildren(h('section', { class: `card step${sc.done ? ' done-card' : ''}` },
      h('div', { class: 'step-head' }, h('h2', {}, '4. First storage check')),
      sc.done
        ? h('p', {}, `✓ Done ${fmtDate(sc.performed_at)}${sc.performed_by_name ? ` by ${sc.performed_by_name}` : ''}`)
        : [h('p', { class: 'muted small' },
          'Factory-new car: MG’s storage requirements start with this check (parking, 12V battery, tyre pressure). It is saved on the car, and the monthly storage checks follow from it.'),
        h('div', { class: 'actions' },
          h('button', { class: 'btn primary', type: 'button', onClick: openCheck }, 'Do first storage check'))]));
  }

  // ------------------------------------------------------------ 4/5. storage
  async function renderFinish() {
    if (data.status === 'completed') {
      const loc = data.current_location;
      slots.finish.replaceChildren(h('section', { class: 'card step done-card' },
        h('h2', {}, `${finishNo()}. Storage`),
        h('p', {}, `Completed ${fmtDate(data.completed_at)}. Odometer ${fmtKm(data.odometer_km)}.`),
        loc ? h('p', { class: 'big-loc' }, `📍 ${loc.code}`) : null));
      return;
    }
    if (data.status === 'cancelled') {
      slots.finish.replaceChildren(h('section', { class: 'card step' },
        h('h2', {}, 'Cancelled'), h('p', {}, `This inspection was cancelled ${fmtDate(data.cancelled_at)}.`)));
      return;
    }

    let locations = [];
    try { locations = await api.get('/storage-locations?available_only=true'); } catch (e) { showError(e); }
    const locSel = h('select', { id: 'loc' }, h('option', { value: '' }, 'Choose a spot…'),
      locations.map((l) => h('option', { value: l.id }, spotLabel(l))));

    const missing = data.checklist.filter((c) => !c.done);
    const completeBtn = h('button', { class: 'btn primary big', type: 'button', disabled: missing.length > 0 },
      'Complete & place in storage');
    completeBtn.addEventListener('click', () => {
      if (!locSel.value) { toast('Choose a storage spot first', 'error'); locSel.focus(); return; }
      busy(completeBtn, async () => {
        data = await api.post(`/inspections/${id}/complete`, {
          location_id: Number(locSel.value),
          staff_id: getInspectorId() ? Number(getInspectorId()) : null,
        });
        toast(`Stored at ${data.current_location?.code}`, 'success');
        rerenderAll();
      });
    });
    // A car new to Carbonara is deleted with the inspection (server: cancel_deletes);
    // a car coming back keeps its record and history.
    const deletes = !!data.cancel_deletes;
    const cancelBtn = h('button', { class: 'btn ghost danger', type: 'button' },
      deletes ? 'Cancel inspection and delete' : 'Cancel inspection');
    cancelBtn.addEventListener('click', () => {
      if (!confirm(deletes
        ? 'Cancel this arrival inspection and delete the car?\n\nThe car goes to Recently deleted and can be restored from Settings for a while.'
        : 'Cancel this arrival inspection? The car was here before, so it is kept; the inspection stays in its history as cancelled.')) return;
      busy(cancelBtn, async () => {
        data = await api.post(`/inspections/${id}/cancel`);
        if (data.vehicle_deleted) {
          toast('Inspection cancelled and car deleted', 'success');
          location.hash = '#/arrivals';
          return;
        }
        rerenderAll();
      });
    });
    // Everything entered is already saved, so pausing just leaves the page;
    // the inspection waits under Arrivals → In progress.
    const pauseBtn = h('a', { class: 'btn', href: '#/arrivals' }, '⏸ Pause inspection');

    slots.finish.replaceChildren(h('section', { class: 'card step' },
      h('div', { class: 'step-head' }, h('h2', {}, `${finishNo()}. Place in storage`)),
      missing.length
        ? h('div', { class: 'notice warn' }, 'Still to do: ', missing.map((m) =>
          m.key === 'photos' ? `${m.label.toLowerCase()} (missing: ${m.missing.join(', ')})` : m.label.toLowerCase()).join('; '))
        : null,
      locations.length
        ? h('div', { class: 'form' }, h('label', { for: 'loc' }, 'Storage spot'), locSel)
        : h('div', { class: 'notice warn' }, 'All storage spots are full. ', h('a', { href: '#/settings' }, 'Add spots or raise capacity in settings')),
      h('div', { class: 'actions spread' }, cancelBtn, h('span', { class: 'row' }, pauseBtn, completeBtn))));
  }

  function rerenderAll() {
    el.replaceChildren(slots.head, slots.checklist, detailsCard(), slots.photos, slots.damage, slots.storage, slots.finish);
    renderDynamic();
  }

  rerenderAll();
}

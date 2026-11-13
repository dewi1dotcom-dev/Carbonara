// PDI sheets: each car model's own PDI form (PDF), filled in when the PDI is done with
// reg. no, VIN, mileage, date, a company stamp and the signature of the person marking
// it done (server: pdisheet.py, routers/pdi_sheets.py).
// - Settings → PDI sheets (admins): upload a model's PDF, tap where each field goes
//   (OCR suggests positions), test fill; company stamps.
// - My signature (everyone): draw it or upload a picture (Settings and the 👤 menu).
// - "✓ PDI done" dialog and "Make PDI sheet" on the PDI card and the PDI orders page.
import { tr } from '../i18n.js';
import {
  api, busy, dateInput, h, openDialog, osloTodayIso, session, showError, toast,
} from '../ui.js';

const FIELD_LABEL = {
  reg: 'Reg. no', vin: 'VIN', km: 'Mileage', date: 'Date', signer: 'Name of the person signing',
  stamp: 'Stamp', signature: 'Signature',
};
const FIELD_KEYS = Object.keys(FIELD_LABEL);
const IMAGE_FIELDS = ['stamp', 'signature'];
const DEFAULT_W = { stamp: 0.2, signature: 0.22 };
const SAMPLE = { reg: 'AB 12345', vin: 'TESTVIN0123456789', km: '12 345', date: '14.11.2026', signer: 'Ola Nordmann' };

const fmtReg = (r) => (r && /^[A-Z]{2}\d{4,5}$/.test(r) ? `${r.slice(0, 2)} ${r.slice(2)}` : r || '');

// ---------------------------------------------------------------- my signature

function signaturePad() {
  const canvas = h('canvas', { class: 'sig-pad', width: 900, height: 300, 'aria-label': 'Signature pad' });
  const ctx = canvas.getContext('2d');
  let drawing = false;
  let empty = true;
  let last = null;
  const pos = (e) => {
    const r = canvas.getBoundingClientRect();
    return [(e.clientX - r.left) * (canvas.width / r.width), (e.clientY - r.top) * (canvas.height / r.height)];
  };
  const line = (a, b) => {
    ctx.strokeStyle = '#111';
    ctx.lineWidth = 5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(...a);
    ctx.lineTo(...b);
    ctx.stroke();
    empty = false;
  };
  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    drawing = true;
    last = pos(e);
    line(last, [last[0] + 0.1, last[1] + 0.1]); // a dot
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    const p = pos(e);
    line(last, p);
    last = p;
  });
  const stop = () => { drawing = false; };
  canvas.addEventListener('pointerup', stop);
  canvas.addEventListener('pointercancel', stop);
  return {
    canvas,
    clear: () => { ctx.clearRect(0, 0, canvas.width, canvas.height); empty = true; },
    isEmpty: () => empty,
    blob: () => new Promise((resolve) => canvas.toBlob(resolve, 'image/png')),
  };
}

/** The user's own signature: shows it, draw a new one or upload a picture, or remove it. */
export function signatureDialog(onChange = null) {
  const body = h('div');
  const draw = () => {
    const pad = signaturePad();
    const removeBtn = h('button', {
      class: 'link danger', type: 'button',
      onClick: async () => {
        if (!confirm('Remove your signature?')) return;
        try { await api.del('/my-signature'); toast('Signature removed', 'success'); draw(); onChange?.(); } catch (e) { showError(e); }
      },
    }, 'Remove my signature');
    const current = h('div', { class: 'sig-current' });
    const img = h('img', { src: `/api/my-signature?t=${Date.now()}`, alt: 'Your signature' });
    img.addEventListener('error', () => {
      current.replaceChildren(h('p', { class: 'muted' }, 'No signature yet.'));
      removeBtn.hidden = true;
    });
    current.append(img);

    const save = async (file) => {
      const fd = new FormData();
      fd.append('file', file, file.name || 'signature.png');
      await api.put('/my-signature', fd);
      toast('Signature saved', 'success');
      draw();
      onChange?.();
    };
    const saveDrawn = h('button', {
      class: 'btn primary', type: 'button',
      onClick: (e) => {
        if (pad.isEmpty()) { toast('Sign in the box first', 'error'); return; }
        busy(e.currentTarget, async () => save(new File([await pad.blob()], 'signature.png', { type: 'image/png' })));
      },
    }, 'Save drawn signature');
    const file = h('input', { type: 'file', accept: 'image/*' });
    const upload = h('button', {
      class: 'btn', type: 'button',
      onClick: (e) => {
        if (!file.files[0]) { toast('Choose a picture first', 'error'); return; }
        busy(e.currentTarget, () => save(file.files[0]));
      },
    }, 'Upload');

    body.replaceChildren(
      h('p', { class: 'muted small' }, 'Your signature is put on the PDI sheets you mark as done. Only you can see or change it.'),
      h('h3', {}, 'Current signature'), current, removeBtn,
      h('h3', {}, 'Sign here'),
      pad.canvas,
      h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', onClick: () => pad.clear() }, 'Clear'), saveDrawn),
      h('h3', {}, 'Or upload a picture'),
      h('p', { class: 'muted small' }, 'A photo or scan of your signature on white paper. The white background is made transparent.'),
      h('div', { class: 'inline-form wrap' }, file, upload));
  };
  draw();
  openDialog('My signature', body);
}

/** Settings card: open the signature dialog. */
export function signatureCard() {
  return h('section', { class: 'card' },
    h('h2', {}, 'My signature'),
    h('p', { class: 'muted small' }, 'Put on the PDI sheets you mark as done. Draw it or upload a picture.'),
    h('button', { class: 'btn', type: 'button', onClick: () => signatureDialog() }, 'My signature…'));
}

// ---------------------------------------------------------------- Settings → PDI sheets

/** Templates (one PDF per car model) and company stamps. Admins change them. */
export async function renderPdiSheetSettings(box) {
  const [templates, stamps] = await Promise.all([api.get('/pdi-templates'), api.get('/pdi-stamps')]);
  const admin = !!session.me?.is_admin;
  const again = () => renderPdiSheetSettings(box).catch(showError);
  const run = async (fn) => { try { await fn(); await again(); } catch (e) { showError(e); } };
  const placed = (t) => FIELD_KEYS.filter((k) => t.fields?.[k]).map((k) => tr(FIELD_LABEL[k])); // joined: translate each

  // Upload a model's PDF.
  const name = h('input', { type: 'text', placeholder: 'Name, e.g. MG4 PDI', maxlength: 80, required: true });
  const models = h('input', { type: 'text', placeholder: 'Car models it is for, e.g. MG4, MG4 Electric', maxlength: 300 });
  const file = h('input', { type: 'file', accept: 'application/pdf,.pdf', required: true });
  const addBtn = h('button', { class: 'btn primary', type: 'submit' }, 'Upload PDF');
  const tplForm = h('form', { class: 'pdi-sheet-form' },
    h('div', { class: 'grid' }, name, models), h('div', { class: 'inline-form wrap' }, file, addBtn));
  tplForm.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(addBtn, async () => {
      const fd = new FormData();
      fd.append('name', name.value);
      fd.append('models', models.value);
      fd.append('file', file.files[0]);
      const t = await api.postForm('/pdi-templates', fd);
      toast('PDI sheet uploaded – now place the fields', 'success');
      await again();
      placeDialog(t, stamps, again);
    });
  });

  // Upload a stamp.
  const sName = h('input', { type: 'text', placeholder: 'Name, e.g. Workshop stamp', maxlength: 80, required: true });
  const sFile = h('input', { type: 'file', accept: 'image/*', required: true });
  const sBtn = h('button', { class: 'btn primary', type: 'submit' }, 'Upload stamp');
  const stampForm = h('form', { class: 'inline-form wrap' }, sName, sFile, sBtn);
  stampForm.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(sBtn, async () => {
      const fd = new FormData();
      fd.append('name', sName.value);
      fd.append('file', sFile.files[0]);
      await api.postForm('/pdi-stamps', fd);
      toast('Stamp uploaded', 'success');
      await again();
    });
  });

  box.replaceChildren(h('section', { class: 'card' },
    h('h2', {}, 'PDI sheets'),
    h('p', { class: 'muted small' },
      'Each car model’s own PDI form (PDF). When a PDI is marked as done, the sheet is filled in with reg. no, VIN, mileage, '
      + 'date, a stamp and the signature of the person marking it done, and stored on the PDI order. '
      + 'Upload the PDF once, then tap where each field goes.'),
    h('h3', {}, 'Car models'),
    templates.length
      ? h('ul', { class: 'plain rows list-edit' }, templates.map((t) => h('li', {},
        h('span', {},
          h('strong', { translate: 'no' }, t.name),
          h('span', { class: 'muted small', translate: 'no' }, t.models ? ` – ${t.models}` : ''),
          h('span', { class: 'block small muted' }, placed(t).length
            ? `Fields: ${placed(t).join(', ')}` : 'No fields placed yet')),
        h('span', { class: 'row-actions' },
          h('a', { class: 'link', href: `/api/pdi-templates/${t.id}/test`, target: '_blank', rel: 'noopener' }, 'Test'),
          admin ? [
            h('button', { class: 'link', type: 'button', onClick: () => placeDialog(t, stamps, again) }, 'Place fields'),
            h('button', {
              class: 'link', type: 'button',
              onClick: () => {
                const n = prompt('Name', t.name);
                if (n == null || !n.trim()) return;
                const m = prompt('Car models it is for (comma-separated)', t.models);
                if (m == null) return;
                run(() => api.patch(`/pdi-templates/${t.id}`, { name: n.trim(), models: m.trim() }));
              },
            }, 'Edit'),
            h('button', {
              class: 'link danger', type: 'button',
              onClick: () => { if (confirm(`Remove the PDI sheet ${t.name}? Sheets already made are kept.`)) run(() => api.del(`/pdi-templates/${t.id}`)); },
            }, 'Remove'),
          ] : null))))
      : h('p', { class: 'empty' }, 'No PDI sheets yet.'),
    admin ? tplForm : h('p', { class: 'muted small' }, 'Only an administrator can change the PDI sheets.'),
    h('h3', {}, 'Stamps'),
    stamps.length
      ? h('ul', { class: 'plain rows list-edit' }, stamps.map((s) => h('li', {},
        h('span', { class: 'stamp-row' },
          h('img', { class: 'stamp-thumb', src: `/api/pdi-stamps/${s.id}/image`, alt: '' }),
          h('span', { translate: 'no' }, s.name), s.is_default ? h('span', { class: 'badge good' }, 'Default') : null),
        admin ? h('span', { class: 'row-actions' },
          s.is_default ? null : h('button', { class: 'link', type: 'button', onClick: () => run(() => api.patch(`/pdi-stamps/${s.id}`, { is_default: true })) }, 'Make default'),
          h('button', {
            class: 'link', type: 'button',
            onClick: () => {
              const n = prompt('Name', s.name);
              if (n != null && n.trim() && n.trim() !== s.name) run(() => api.patch(`/pdi-stamps/${s.id}`, { name: n.trim() }));
            },
          }, 'Rename'),
          h('button', {
            class: 'link danger', type: 'button',
            onClick: () => { if (confirm(`Remove the stamp ${s.name}?`)) run(() => api.del(`/pdi-stamps/${s.id}`)); },
          }, 'Remove')) : null)))
      : h('p', { class: 'empty' }, 'No stamps yet.'),
    admin ? stampForm : null));
}

/** Tap where each field goes on the model's PDF. OCR suggests positions the first time. */
function placeDialog(t, stamps, onSaved) {
  const fields = JSON.parse(JSON.stringify(t.fields || {}));
  const pages = t.pages || [];
  let page = 1;
  let selected = FIELD_KEYS.find((k) => !fields[k]) || 'reg';
  const sampleImg = {
    stamp: stamps[0] ? `/api/pdi-stamps/${stamps[0].id}/image` : null,
    signature: `/api/my-signature?t=${Date.now()}`,
  };

  const img = h('img', { class: 'ps-page', alt: '', draggable: 'false' });
  const markers = h('div', { class: 'ps-markers' });
  const stage = h('div', { class: 'ps-stage' }, img, markers);
  const fieldBar = h('div', { class: 'chips ps-fields' });
  const pageBar = h('div', { class: 'row ps-pages' });
  const controls = h('div', { class: 'ps-controls' });
  const status = h('div', { class: 'muted small' });

  const drawMarkers = () => {
    const scale = img.clientWidth / (pages[page - 1]?.w || 595); // px per PDF point
    markers.replaceChildren(...Object.entries(fields).filter(([, f]) => f.page === page).map(([k, f]) => {
      const sel = k === selected ? ' sel' : '';
      if (IMAGE_FIELDS.includes(k)) {
        const box = h('div', {
          class: `ps-mark ps-img${sel}`,
          style: { left: `${f.x * 100}%`, top: `${f.y * 100}%`, width: `${f.w * 100}%` },
        });
        const fallback = () => { box.classList.add('empty'); box.replaceChildren(FIELD_LABEL[k]); };
        if (sampleImg[k]) {
          const pic = h('img', { src: sampleImg[k], alt: '' });
          pic.addEventListener('error', fallback);
          box.append(pic);
        } else fallback();
        return box;
      }
      return h('div', {
        class: `ps-mark ps-text${sel}`,
        style: { left: `${f.x * 100}%`, top: `${f.y * 100}%`, fontSize: `${Math.max(f.size * scale, 6)}px` },
      }, SAMPLE[k]);
    }));
  };

  const drawControls = () => {
    fieldBar.replaceChildren(...FIELD_KEYS.map((k) => h('button', {
      class: k === selected ? 'btn primary small' : 'btn small', type: 'button',
      onClick: () => { selected = k; if (fields[k] && fields[k].page !== page) showPage(fields[k].page); drawAll(); },
    }, `${fields[k] ? '✓ ' : ''}${FIELD_LABEL[k]}`)));
    pageBar.replaceChildren(...(pages.length > 1 ? pages.map((_, i) => h('button', {
      class: i + 1 === page ? 'btn primary small' : 'btn small', type: 'button', onClick: () => showPage(i + 1),
    }, `Page ${i + 1}`)) : []));
    const f = fields[selected];
    if (!f) {
      controls.replaceChildren(h('p', { class: 'small' }, `Tap on the page where “${FIELD_LABEL[selected]}” goes.`));
      return;
    }
    const isImg = IMAGE_FIELDS.includes(selected);
    const size = h('input', isImg
      ? { type: 'range', min: 3, max: 60, step: 1, value: Math.round(f.w * 100) }
      : { type: 'number', min: 6, max: 24, step: 0.5, value: f.size, class: 'ps-size' });
    size.addEventListener('input', () => {
      const v = Number(size.value);
      if (!v) return;
      if (isImg) f.w = v / 100; else f.size = Math.min(Math.max(v, 6), 24);
      drawMarkers();
    });
    controls.replaceChildren(h('div', { class: 'inline-form wrap' },
      h('label', {}, isImg ? 'Width' : 'Text size (pt)'), size,
      h('button', {
        class: 'link danger', type: 'button',
        onClick: () => { delete fields[selected]; drawAll(); },
      }, 'Remove from the sheet')),
    h('p', { class: 'muted small' }, 'Tap the page again to move it.'));
  };
  const drawAll = () => { drawControls(); drawMarkers(); };
  const showPage = (n) => {
    page = n;
    img.src = `/api/pdi-templates/${t.id}/pages/${n}`;
    drawAll();
  };

  img.addEventListener('load', drawMarkers);
  if (window.ResizeObserver) new ResizeObserver(drawMarkers).observe(img);
  img.addEventListener('click', (e) => {
    const r = img.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    const prev = fields[selected];
    fields[selected] = IMAGE_FIELDS.includes(selected)
      ? { page, x, y, w: prev?.w ?? DEFAULT_W[selected] }
      : { page, x, y, size: prev?.size ?? 10 };
    // Next field not placed yet, so the sheet can be done tap by tap.
    const next = FIELD_KEYS.find((k) => !fields[k]);
    if (next && !prev) selected = next;
    drawAll();
  });

  const suggestBtn = h('button', {
    class: 'btn', type: 'button',
    onClick: (e) => busy(e.currentTarget, () => suggest(true)),
  }, 'Suggest positions');
  const suggest = async (manual) => {
    status.textContent = 'Looking for labels on the sheet…';
    try {
      const found = await api.post(`/pdi-templates/${t.id}/suggest`);
      const added = Object.keys(found).filter((k) => !fields[k]);
      added.forEach((k) => { fields[k] = found[k]; });
      status.textContent = added.length
        ? `Suggested: ${added.map((k) => tr(FIELD_LABEL[k])).join(', ')}. Check each one and tap to move it.`
        : 'No more labels found. Tap the page to place the fields.';
      selected = FIELD_KEYS.find((k) => !fields[k]) || selected;
      drawAll();
    } catch (err) {
      status.textContent = '';
      if (manual) throw err;
    }
  };

  const save = h('button', { class: 'btn primary', type: 'button' }, 'Save');
  save.addEventListener('click', () => busy(save, async () => {
    await api.patch(`/pdi-templates/${t.id}`, { fields });
    close();
    toast('Fields saved – use “Test” to check the sheet', 'success');
    await onSaved();
  }));

  const body = h('div', { class: 'ps' },
    h('p', { class: 'muted small' },
      'Choose a field, then tap on the page. Text starts where you tap (the middle of the line); the stamp and the signature are centred where you tap. '
      + 'Fields you don’t place are left out.'),
    fieldBar, pageBar, controls, status, stage,
    h('div', { class: 'actions spread' }, suggestBtn, save));
  const { close } = openDialog(`Place fields – ${t.name}`, body, { wide: true });
  showPage(1);
  if (!Object.keys(fields).length) suggest(false);
}

// ---------------------------------------------------------------- PDI done / make sheet

/** "✓ PDI done" (remake = false) or "Make PDI sheet" on a done order (remake = true). */
export async function doneDialog(o, done, { remake = false } = {}) {
  let opts;
  try { opts = await api.get(`/pdi/${o.id}/sheet-options`); } catch (e) { showError(e); return; }
  const ord = opts.order;
  const tplSel = h('select', { id: 'ps-template' },
    remake ? null : h('option', { value: '' }, 'No PDI sheet'),
    opts.templates.map((t) => h('option', { value: t.id }, t.name)));
  tplSel.value = opts.suggested_template_id ? String(opts.suggested_template_id) : (remake && opts.templates[0] ? String(opts.templates[0].id) : '');
  const km = h('input', { type: 'text', id: 'ps-km', inputmode: 'numeric', maxlength: 9, value: ord.done_km ?? '', placeholder: 'e.g. 12', autocomplete: 'off' });
  const date = dateInput({ id: 'ps-date', value: ord.sheet_date || osloTodayIso() });
  const stampSel = h('select', { id: 'ps-stamp' }, opts.stamps.map((s) => h('option', { value: s.id }, s.name)));
  const defStamp = opts.stamps.find((s) => s.id === ord.sheet_stamp_id) || opts.stamps.find((s) => s.is_default) || opts.stamps[0];
  if (defStamp) stampSel.value = String(defStamp.id);

  const slot = h('div');
  const tpl = () => opts.templates.find((t) => String(t.id) === tplSel.value);
  const drawSlot = () => {
    const t = tpl();
    const has = (k) => t?.fields.includes(k);
    slot.replaceChildren(...[
      t ? h('p', { class: 'small' }, ord.registration_number
        ? `Reg. no on the sheet: ${fmtReg(ord.registration_number)}`
        : 'No reg. no yet – that field stays empty. Make the sheet again once the car is registered.') : null,
      t && !t.fields.length ? h('div', { class: 'notice warn small' }, 'The fields of this PDI sheet have not been placed yet (Settings → PDI sheets).') : null,
      h('div', { class: 'grid' },
        h('div', { class: 'field' }, h('label', { for: 'ps-km' }, t ? 'Mileage (km) *' : 'Mileage (km)'), km,
          ord.last_km != null ? h('div', { class: 'muted small' }, `At the arrival inspection: ${ord.last_km} km`) : null),
        t ? h('div', { class: 'field' }, h('label', { for: 'ps-date' }, 'Date on the sheet'), date) : null),
      has('stamp') ? (opts.stamps.length
        ? h('div', { class: 'field' }, h('label', { for: 'ps-stamp' }, 'Stamp'), stampSel)
        : h('div', { class: 'notice warn small' }, 'No stamps yet – an administrator can add them under Settings → PDI sheets.')) : null,
      has('signature') ? h('div', { class: 'field' }, h('label', {}, 'Your signature'),
        opts.has_signature
          ? h('div', { class: 'sig-current small' }, h('img', { src: `/api/my-signature?t=${Date.now()}`, alt: 'Your signature' }))
          : h('div', { class: 'notice warn small' }, h('span', {}, 'You have no signature yet. '),
            h('button', {
              class: 'btn small', type: 'button',
              onClick: () => signatureDialog(() => { opts.has_signature = true; drawSlot(); }),
            }, 'Add my signature'))) : null,
    ].filter(Boolean));
  };
  tplSel.addEventListener('change', drawSlot);
  drawSlot();

  const submit = h('button', { class: 'btn primary', type: 'submit' }, remake ? 'Make PDI sheet' : '✓ Mark as done');
  const form = h('form', {},
    h('p', {}, h('strong', {}, [o.make, o.model].filter(Boolean).join(' ')), ` · `, h('span', { class: 'mono' }, o.vin)),
    opts.templates.length
      ? h('div', { class: 'field' }, h('label', { for: 'ps-template' }, 'PDI sheet'), tplSel)
      : h('div', { class: 'notice small' }, 'No PDI sheets set up yet – an administrator can add each model’s PDF under Settings → PDI sheets.'),
    slot,
    h('div', { class: 'actions' }, submit));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const t = tpl();
    const kmText = km.value.replace(/\s/g, '');
    if (remake && !t) { toast('Choose a PDI sheet', 'error'); return; }
    if (kmText && !/^\d+$/.test(kmText)) { toast('Mileage: whole kilometres only', 'error'); km.focus(); return; }
    if (t && !kmText) { toast('Enter the mileage for the PDI sheet', 'error'); km.focus(); return; }
    if (t?.fields.includes('signature') && !opts.has_signature) { toast('Add your signature first', 'error'); return; }
    busy(submit, async () => {
      const body = {
        template_id: t ? t.id : null, km: kmText ? Number(kmText) : null,
        date: date.value || osloTodayIso(), stamp_id: stampSel.value ? Number(stampSel.value) : null,
      };
      if (remake) await api.post(`/pdi/${o.id}/sheet`, body);
      else await api.post(`/pdi/${o.id}/done`, body);
      toast(remake ? 'PDI sheet made' : 'PDI done – the car is ready for registration and delivery', 'success');
      window.dispatchEvent(new Event('carbonara:pdi-changed'));
      await done();
      if (!t) { close(); return; }
      // The link is opened by a tap (a new tab opened after waiting would be blocked).
      form.replaceWith(h('div', {},
        h('p', {}, '✓ The PDI sheet is filled in and stored on the PDI order.'),
        h('div', { class: 'actions' },
          h('button', { class: 'btn', type: 'button', onClick: () => close() }, 'Close'),
          h('a', { class: 'btn primary', href: `/api/pdi/${o.id}/sheet`, target: '_blank', rel: 'noopener' }, '📄 Open PDI sheet'))));
    });
  });
  const { close } = openDialog(remake ? 'Make PDI sheet' : 'PDI done', form);
}

/** For a done order: "📄 PDI sheet" (if made) and "Make PDI sheet" / "Make sheet again". */
export function sheetActions(o, rerender) {
  return [
    o.sheet_file_key ? h('a', { class: 'btn small', href: `/api/pdi/${o.id}/sheet`, target: '_blank', rel: 'noopener' }, '📄 PDI sheet') : null,
    h('button', { class: 'btn small', type: 'button', onClick: () => doneDialog(o, rerender, { remake: true }) },
      o.sheet_file_key ? 'Make sheet again' : 'Make PDI sheet'),
  ];
}


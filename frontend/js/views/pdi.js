// PDI order card on the vehicle page: what the customer ordered, sent to the
// workshop (RBV) by e-mail; the workshop's date/time is entered by staff.
// Also the banner at the top of the vehicle page and the PDI page (#/pdi).
import { tr } from '../i18n.js';
import {
  api, append, boardBlock, boardRow, busy, carText, dateInput, fmtDate, h, openDialog, session, showError, spotLabel,
  timeInput, toast,
} from '../ui.js';

const WHEELS_AT_DEALER = ['in_stock', 'sales_ordered']; // the dealer has the winter wheels

/** "Sent 10.11.2026 14:00 to rbv@…" or "Printed / PDF 10.11.2026 14:00". */
const sentText = (o, withTime = true) => (o.sent_via === 'print'
  ? `printed / PDF ${fmtDate(o.sent_at, withTime)}`
  : `sent ${fmtDate(o.sent_at, withTime)} to ${o.sent_to}`);

const STATUS_TEXT = { draft: 'Not sent', sent: 'Sent – waiting for date', booked: 'PDI booked', done: 'PDI done', cancelled: 'Cancelled' };
const STATUS_CLS = { draft: 'warn', sent: 'warn', booked: 'good', done: 'good', cancelled: '' };

function itemsList(o, opts) {
  const lines = (o.items || []).map((i) => `${i.label}${i.choice ? `: ${i.choice}` : ''}`);
  const t = o.tyres || {};
  if (t.mode && t.mode !== 'none') {
    lines.push([tr(opts.tyre_modes[t.mode]), t.company, t.expected_date && `expected ${fmtDate(t.expected_date, false)}`]
      .filter(Boolean).join(' · '));
  }
  return lines;
}

/** Top of the vehicle page: the car has an open PDI order (booked date first). */
export function pdiBanner(o) {
  if (!o) return null;
  const booked = o.status === 'booked';
  return h('div', { class: `card notice ${booked ? '' : 'warn'} td-banner` },
    h('div', {},
      h('strong', {}, booked ? `🔧 PDI booked ${fmtDate(o.pdi_at)}`
        : o.status === 'sent' ? '🔧 PDI ordered – waiting for the workshop’s date'
          : '🔧 PDI order started – not sent to the workshop yet'),
      booked && !o.sent_at ? h('div', { class: 'small' }, 'The order list has not been sent to the workshop yet.') : null),
    h('span', { class: 'row' },
      h('button', {
        class: 'btn', type: 'button',
        onClick: () => document.getElementById('pdi-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
      }, 'See order'),
      h('a', { class: 'btn', href: '#/pdi' }, 'All PDIs')));
}

/** The PDI page: this week's PDIs first, then everything else that is open. */
export async function pdiListView(el) {
  const d = await api.get('/pdi');
  const inWeek = new Set(d.week.map((o) => o.id));
  const now = Date.now();
  const link = (o, meta, cls = '') => boardRow(`#/vehicles/${o.vehicle_id}`, carText(o), meta, cls);
  const when = (o) => [fmtDate(o.pdi_at), o.location_code && `spot ${o.location_code}`].filter(Boolean).join(' · ');
  const booked = d.open.filter((o) => o.status === 'booked' && !inWeek.has(o.id));
  const passed = booked.filter((o) => new Date(o.pdi_at).getTime() < now);
  const later = booked.filter((o) => new Date(o.pdi_at).getTime() >= now);
  const by = (name) => (name ? ` by ${name}` : '');

  append(el,
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', {}, 'PDI'), h('div', { class: 'muted' }, 'New cars booked for PDI at the workshop'))),
    boardBlock('📅', 'This week', d.week.map((o) => link(o,
      [when(o), o.status === 'done' ? 'done' : !o.sent_at ? 'order not sent' : null].filter(Boolean).join(' · '),
      o.status === 'booked' && !o.sent_at ? 'bad' : '')), { cls: 'info', empty: 'No PDIs this week.' }),
    boardBlock('⏰', 'PDI date passed – mark as done?', passed.map((o) => link(o, `was ${fmtDate(o.pdi_at)}`, 'bad')), { cls: 'bad' }),
    boardBlock('🗓', 'Later', later.map((o) => link(o, when(o)))),
    boardBlock('✉', 'Waiting for the workshop’s date', d.open.filter((o) => o.status === 'sent').map((o) =>
      link(o, sentText(o, false)))),
    boardBlock('📝', 'Not sent yet', d.open.filter((o) => o.status === 'draft').map((o) =>
      link(o, `started ${fmtDate(o.created_at, false)}${by(o.created_by_name)}`))),
    boardBlock('✓', 'Recently done', d.done.map((o) => link(o, `done ${fmtDate(o.done_at, false)}${by(o.done_by_name)}`))));
}

export function pdiCard(v, data, opts, rerender) {
  const o = data.current;
  const card = h('section', { class: 'card', id: 'pdi-card' }, h('h2', {}, 'PDI order'));
  if (!o) {
    append(card,
      h('p', { class: v.condition === 'new' ? '' : 'muted' }, v.condition === 'new'
        ? 'New car – no PDI order yet. Register what the customer ordered and send it to the workshop.'
        : 'No PDI order.'),
      h('div', { class: 'actions' },
        h('button', { class: v.condition === 'new' ? 'btn primary' : 'btn', type: 'button', onClick: () => editDialog(v, null, opts, rerender) },
          'Create PDI order')));
  } else {
    const lines = itemsList(o, opts);
    append(card, // skips the null parts (no note, not changed…)
      h('div', { class: 'pdi-status' },
        h('span', { class: `badge ${STATUS_CLS[o.status]}` }, STATUS_TEXT[o.status]),
        o.status === 'booked' ? h('strong', {}, fmtDate(o.pdi_at)) : null,
        o.sent_at ? h('span', { class: 'muted small' }, o.sent_via === 'print'
          ? `Printed / PDF ${fmtDate(o.sent_at)}${o.sent_by_name ? ` by ${o.sent_by_name}` : ''}`
          : `Sent ${fmtDate(o.sent_at)} to ${o.sent_to}${o.sent_by_name ? ` by ${o.sent_by_name}` : ''}${o.sent_via === 'mail_app' ? ' (e-mail app)' : ''}`) : null),
      o.changed_since_sent ? h('div', { class: 'notice warn small' }, 'Changed since it was sent — send it again so the workshop has the latest order.') : null,
      o.status === 'booked' && !o.sent_at ? h('div', { class: 'notice warn small' }, 'PDI date is set, but the order list has not been sent to the workshop yet.') : null,
      o.prepared_at ? h('div', { class: 'notice small' },
        h('strong', {}, `✓ Prepared for the PDI ${fmtDate(o.prepared_at)}${o.prepared_by_name ? ` by ${o.prepared_by_name}` : ''}`),
        [o.prep_plate_name && `Trade plates: ${o.prep_plate_name}`, o.location_code && `Spot ${o.location_code}`, o.prep_note,
          o.prep_wheels_location && `Winter wheels: ${o.prep_wheels_location}`].filter(Boolean).map((t) => h('div', {}, t))) : null,
      lines.length ? h('ul', {}, lines.map((l) => h('li', {}, l))) : h('p', { class: 'muted' }, 'Nothing ordered yet.'),
      o.other ? h('p', {}, h('strong', {}, 'Other: '), o.other) : null,
      o.note ? h('p', { class: 'muted' }, `Note: ${o.note}`) : null,
      h('div', { class: 'actions spread' },
        h('button', { class: 'link danger', type: 'button', onClick: () => cancelOrder(o, rerender) }, 'Cancel order'),
        h('span', { class: 'row' },
          h('button', { class: 'btn', type: 'button', onClick: () => editDialog(v, o, opts, rerender) }, 'Edit order'),
          h('button', { class: o.sent_at && !o.changed_since_sent ? 'btn' : 'btn primary', type: 'button', onClick: () => sendDialog(o, opts, rerender) },
            o.sent_at ? 'Send again…' : 'Send to workshop…'),
          // Always available: the date may be agreed with the workshop in person or by phone.
          h('button', { class: o.status === 'sent' ? 'btn primary' : 'btn', type: 'button', onClick: () => bookingDialog(o, rerender) },
            o.status === 'booked' ? 'Change PDI date' : 'Enter PDI date'),
          o.status === 'booked' ? h('button', { class: o.prepared_at ? 'btn' : 'btn primary', type: 'button', onClick: () => prepDialog(o, rerender) },
            o.prepared_at ? 'Edit preparation' : 'Prepare for PDI') : null,
          o.status === 'booked' ? h('button', { class: 'btn', type: 'button', onClick: () => doneOrder(o, rerender) }, '✓ PDI done') : null)));
  }
  const done = data.history.filter((x) => x.status === 'done');
  if (done.length) {
    card.append(h('p', { class: 'muted small' },
      done.map((x) => `PDI done ${fmtDate(x.done_at, false)}${x.done_by_name ? ` (${x.done_by_name})` : ''}`).join(' · ')));
  }
  return card;
}

// ---------------------------------------------------------------- edit

function editDialog(v, o, opts, done) {
  const chosen = new Map((o?.items || []).map((i) => [i.label, i.choice]));
  // Items that were ordered but have since been removed from the list stay visible.
  const known = new Set(opts.items.map((i) => i.label));
  const items = [...opts.items, ...[...chosen.keys()].filter((l) => !known.has(l)).map((label) => ({ label, choices: [] }))];
  const rows = items.map((it) => {
    const box = h('input', { type: 'checkbox', checked: chosen.has(it.label) });
    const sel = it.choices?.length ? h('select', {}, it.choices.map((c) => h('option', { value: c }, c))) : null;
    if (sel && chosen.get(it.label)) sel.value = chosen.get(it.label);
    return { it, box, sel, el: h('div', { class: 'pdi-item' }, h('label', { class: 'check' }, box, it.label), sel) };
  });
  const other = h('textarea', { rows: 2, maxlength: 1000, placeholder: 'Anything else the customer ordered' }, o?.other ?? '');

  const t = o?.tyres || { mode: 'none' };
  const mode = h('select', { id: 'pdi-tyres' }, Object.entries(opts.tyre_modes).map(([k, label]) => h('option', { value: k }, label)));
  mode.value = t.mode || 'none';
  const company = h('select', { id: 'pdi-company' }, h('option', { value: '' }, 'Choose tyre company…'),
    opts.tyre_companies.map((c) => h('option', { value: c.label }, c.label)),
    t.company && !opts.tyre_companies.some((c) => c.label === t.company) ? h('option', { value: t.company }, t.company) : null);
  company.value = t.company || '';
  const expected = dateInput({ id: 'pdi-expected', value: t.expected_date || '' });
  const tyreNote = h('input', { type: 'text', maxlength: 300, placeholder: 'Dimension, rims, studded/unstudded…', value: t.note || '' });
  const tyreSlot = h('div');
  const drawTyres = () => {
    const m = mode.value;
    tyreSlot.replaceChildren(...(m === 'none' ? [] : [
      m === 'in_stock' ? null : h('div', { class: 'field' }, h('label', { for: 'pdi-company' },
        m === 'rbv_orders' ? 'Tyre company (the workshop orders from)' : 'Tyre company (optional)'), company),
      m === 'sales_ordered' ? h('div', { class: 'field' }, h('label', { for: 'pdi-expected' }, 'Expected delivery date'), expected) : null,
      h('div', { class: 'field' }, h('label', {}, 'Tyre details (optional)'), tyreNote),
    ].filter(Boolean)));
  };
  mode.addEventListener('change', drawTyres);
  drawTyres();
  const note = h('textarea', { rows: 2, maxlength: 1000, placeholder: 'Note to the workshop (optional)' }, o?.note ?? '');
  const save = h('button', { class: 'btn primary', type: 'submit' }, 'Save order');

  const form = h('form', {},
    h('h3', {}, 'Ordered by the customer'),
    h('div', { class: 'pdi-items' }, rows.map((r) => r.el)),
    h('div', { class: 'field' }, h('label', {}, 'Other'), other),
    h('h3', {}, 'Winter tyres'),
    h('div', { class: 'field' }, mode),
    tyreSlot,
    h('div', { class: 'field' }, h('label', {}, 'Note'), note),
    h('div', { class: 'actions' }, save));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(save, async () => {
      await api.put(`/vehicles/${v.id}/pdi`, {
        items: rows.filter((r) => r.box.checked).map((r) => ({ label: r.it.label, choice: r.sel ? r.sel.value : null })),
        other: other.value,
        tyres: { mode: mode.value, company: company.value || null, expected_date: expected.value || null, note: tyreNote.value || null },
        note: note.value,
      });
      close();
      toast('PDI order saved', 'success');
      await done();
    });
  });
  const { close } = openDialog(o ? 'Edit PDI order' : 'New PDI order', form, { wide: true });
}

// ---------------------------------------------------------------- send

/** The order as a Norwegian A4 sheet for the workshop (printed or saved as PDF). */
function pdiSheet(o, opts) {
  const car = [o.make, o.model, o.model_year].filter(Boolean).join(' ') || 'Bil';
  const t = o.tyres || {};
  const rows = (pairs) => h('table', { class: 'rep-head' }, h('tbody', {},
    pairs.filter(([, v]) => v).map(([k, v]) => h('tr', {}, h('th', {}, k), h('td', {}, v)))));
  const textBlock = (title, text) => (text ? [h('h2', {}, title), h('p', { style: { whiteSpace: 'pre-line' } }, text)] : null);
  return h('div', { class: 'report pdi-sheet', translate: 'no' }, // a Norwegian document
    h('div', { class: 'rep-title' },
      h('h1', {}, 'Bestilling av nybilklargjøring'),
      h('div', { class: 'small' }, [opts.company, fmtDate(new Date(), false)].filter(Boolean).join(' · '))),
    h('h2', {}, 'Bil'),
    rows([['Bil', car], ['Understellsnr. (VIN)', h('span', { class: 'mono' }, o.vin)],
      ['Reg.nr.', o.registration_number || 'ikke registrert ennå'], ['Farge', o.color], ['Står på', o.location_code]]),
    h('h2', {}, 'Bestilt'),
    (o.items || []).length
      ? h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Utstyr / arbeid'), h('th', { class: 'pdi-tick' }, 'Utført'))),
        h('tbody', {}, o.items.map((i) => h('tr', {},
          h('td', {}, `${i.label}${i.choice ? `: ${i.choice}` : ''}`), h('td', { class: 'pdi-tick' }, '☐')))))
      : h('p', {}, '(ingen tilbehør)'),
    textBlock('Annet', o.other),
    t.mode && t.mode !== 'none' ? [h('h2', {}, 'Vinterdekk'),
      rows([['Vinterdekk', opts.tyre_modes[t.mode]], ['Dekkleverandør', t.company],
        ['Forventet levert', t.expected_date && fmtDate(t.expected_date, false)], ['Detaljer', t.note]])] : null,
    textBlock('Merknad', o.note),
    h('h2', {}, 'Tidspunkt for nybilklargjøring'),
    h('p', { class: 'small' }, 'Gi beskjed om dato og klokkeslett for nybilklargjøringen.'),
    h('div', { class: 'pdi-lines' }, h('div', {}, 'Dato:'), h('div', {}, 'Klokkeslett:')),
    h('div', { class: 'sign-lines' },
      h('div', { class: 'sign-wide' }, `Bestilt av${session.me?.name ? `: ${session.me.name}` : ''}`),
      h('div', {}, 'Dato'),
      h('div', { class: 'sign-wide' }, 'Mottatt av verkstedet'),
      h('div', {}, 'Dato')));
}

/** "Did you give it to the workshop?" as an in-app Yes/No, with the PDI date
 *  and time if the workshop already gave one. onYes(booking | null). */
function givenDialog(question, o, onYes) {
  const [d0, t0] = (o.pdi_local || '').split('T');
  const date = dateInput({ id: 'given-date', value: d0 || '' });
  const time = timeInput({ id: 'given-time', value: (t0 || '').slice(0, 5) || '08:00' });
  const yes = h('button', { class: 'btn primary', type: 'submit' }, 'Yes');
  const form = h('form', {},
    h('p', {}, question),
    h('h3', {}, 'PDI date (optional)'),
    h('p', { class: 'muted small' }, 'Fill in if the workshop has already given a date and time.'),
    h('div', { class: 'grid' },
      h('div', { class: 'field' }, h('label', { for: 'given-date' }, 'Date'), date),
      h('div', { class: 'field' }, h('label', { for: 'given-time' }, 'Time'), time)),
    h('div', { class: 'actions' },
      h('button', { class: 'btn', type: 'button', onClick: () => close() }, 'No'),
      yes));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(yes, async () => {
      await onYes(date.value ? { date: date.value, time: time.value || '08:00' } : null);
      close();
    });
  });
  const { close } = openDialog('Order given to the workshop?', form);
}

/** Get the car ready the day before the PDI: trade plates, where the car is
 *  (spot + short message), and where the winter wheels are if the dealer has them. */
export async function prepDialog(o, done) {
  let plates, spots;
  try {
    [plates, spots] = await Promise.all([api.get('/trade-plates'), api.get('/storage-locations?available_only=true')]);
  } catch (e) { showError(e); return; }
  const carName = (p) => p.registration_number || [p.make, p.model].filter(Boolean).join(' ');

  const plateSel = h('select', { id: 'prep-plate' }, h('option', { value: '' }, 'No trade plates'),
    plates.map((p) => h('option', { value: p.id }, p.drive_id ? `${p.name} – on ${carName(p)} (test drive)` : p.name)));
  plateSel.value = o.prep_plate_id ? String(o.prep_plate_id) : '';
  const plateHint = h('div', { class: 'small td-items' });
  const showPlateHint = () => {
    const p = plates.find((x) => String(x.id) === plateSel.value);
    plateHint.textContent = p?.drive_id ? `${p.name} are on ${carName(p)} (out on a test drive) right now.` : '';
  };
  plateSel.addEventListener('change', showPlateHint);
  showPlateHint();

  // The car's current spot first (it may be full, so not in the "available" list).
  const spotSel = h('select', { id: 'prep-spot' },
    o.location_id ? null : h('option', { value: '' }, 'Choose a spot…'),
    o.location_id && !spots.some((l) => l.id === o.location_id) ? h('option', { value: o.location_id }, o.location_code) : null,
    spots.map((l) => h('option', { value: l.id }, spotLabel(l))));
  spotSel.value = o.location_id ? String(o.location_id) : '';
  const note = h('input', { type: 'text', id: 'prep-note', maxlength: 300, value: o.prep_note ?? '',
    placeholder: 'e.g. Keys in the key cabinet' });
  const wheelsOn = WHEELS_AT_DEALER.includes(o.tyres?.mode);
  const wheels = h('input', { type: 'text', id: 'prep-wheels', maxlength: 200, value: o.prep_wheels_location ?? '',
    placeholder: 'e.g. Tyre storage, shelf 3 (or: not delivered yet)' });

  const save = h('button', { class: 'btn primary', type: 'submit' }, '✓ Mark as prepared');
  const form = h('form', {},
    h('p', {}, h('strong', {}, carText(o)), o.pdi_at ? ` · PDI ${fmtDate(o.pdi_at)}` : ''),
    h('div', { class: 'field' }, h('label', { for: 'prep-plate' }, 'Trade plates'), plateSel, plateHint),
    h('div', { class: 'grid' },
      h('div', { class: 'field' }, h('label', { for: 'prep-spot' }, 'Where is the car?'), spotSel),
      h('div', { class: 'field' }, h('label', { for: 'prep-note' }, 'Message (optional)'), note)),
    h('p', { class: 'muted small' }, 'Choosing another spot moves the car there.'),
    wheelsOn ? h('div', { class: 'field' },
      h('label', { for: 'prep-wheels' }, 'Where are the winter wheels?'), wheels,
      h('div', { class: 'muted small' }, o.tyres.mode === 'in_stock' ? 'Winter wheels in stock at the dealer.' : 'Winter wheels ordered by sales.')) : null,
    h('div', { class: 'actions' }, save));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (wheelsOn && !wheels.value.trim()) { toast('Write where the winter wheels are (or that they have not arrived)', 'error'); wheels.focus(); return; }
    busy(save, async () => {
      await api.post(`/pdi/${o.id}/prepare`, {
        trade_plate_id: plateSel.value ? Number(plateSel.value) : null,
        location_id: spotSel.value ? Number(spotSel.value) : null,
        note: note.value,
        wheels_location: wheelsOn ? wheels.value : null,
      });
      close();
      toast('Car marked as prepared for the PDI', 'success');
      window.dispatchEvent(new Event('carbonara:pdi-changed')); // updates the notification bar
      await done();
    });
  });
  const { close } = openDialog('Prepare for PDI', form);
}

/** Send the order to the workshop: by e-mail, or printed / saved as a PDF. */
function sendDialog(o, opts, done) {
  const hasRecipients = opts.recipients.length > 0;
  const recipient = h('select', { id: 'pdi-to' }, opts.recipients.map((r) => h('option', { value: r.id }, `${r.label} – ${r.email}`)));
  if (hasRecipients) recipient.value = String((opts.recipients.find((r) => r.is_default) || opts.recipients[0]).id);
  const preview = h('div', { class: 'pdi-mail', translate: 'no' }); // the e-mail is always Norwegian
  let mail = null;
  const load = async () => {
    if (!hasRecipients) return;
    try {
      mail = await api.get(`/pdi/${o.id}/email?recipient_id=${recipient.value}`);
      preview.textContent = `Til: ${mail.to}\nEmne: ${mail.subject}\n\n${mail.body}`;
    } catch (e) { showError(e); }
  };
  recipient.addEventListener('change', load);

  // booking: {date, time} when the workshop already gave a date (from givenDialog).
  const record = async (via, booking = null) => {
    await api.post(`/pdi/${o.id}/send`, { recipient_id: via === 'print' ? null : Number(recipient.value), via });
    if (booking) {
      await api.post(`/pdi/${o.id}/booking`, booking);
      window.dispatchEvent(new Event('carbonara:pdi-changed'));
    }
    close();
    toast(via === 'smtp' ? `Sent to ${mail?.to ?? 'the workshop'}` : via === 'print' ? 'Marked as given to the workshop' : 'Marked as sent', 'success');
    await done();
  };
  const smtpBtn = h('button', { class: 'btn primary', type: 'button', onClick: (e) => busy(e.currentTarget, () => record('smtp')) },
    'Send from Carbonara');
  const appBtn = h('button', {
    class: opts.smtp_configured ? 'btn' : 'btn primary', type: 'button',
    onClick: () => {
      if (!mail) return;
      location.href = `mailto:${mail.to}?subject=${encodeURIComponent(mail.subject)}&body=${encodeURIComponent(mail.body)}`;
      setTimeout(() => givenDialog('Did you send the e-mail from your e-mail app?', o, (b) => record('mail_app', b)), 800);
    },
  }, 'Open in e-mail app');
  const copyBtn = h('button', {
    class: 'btn', type: 'button',
    onClick: async () => {
      try { await navigator.clipboard.writeText(`${mail.subject}\n\n${mail.body}`); toast('Copied', 'success'); } catch { toast('Copy not allowed here – select the text instead', 'error'); }
    },
  }, 'Copy text');

  const emailPanel = hasRecipients
    ? h('div', {},
      h('div', { class: 'field' }, h('label', { for: 'pdi-to' }, 'Send to'), recipient),
      preview,
      opts.smtp_configured ? null : h('p', { class: 'muted small' },
        'Sending directly from Carbonara is not set up yet (a system admin can add the mail server on the System page → E-mail), so use your own e-mail app.'),
      h('div', { class: 'actions' }, copyBtn, appBtn, opts.smtp_configured ? smtpBtn : null))
    : h('div', { class: 'notice warn' }, 'No e-mail recipients yet. An administrator can add them under Settings → PDI order lists.');

  // Print / PDF: the browser's print dialog also offers "Save as PDF".
  const printBtn = h('button', {
    class: 'btn primary', type: 'button',
    onClick: () => {
      window.print();
      setTimeout(() => givenDialog('Did you give the order to the workshop (printed or as a PDF)?', o, (b) => record('print', b)), 500);
    },
  }, '🖨 Print / save as PDF');
  const printPanel = h('div', {},
    h('p', { class: 'muted small no-print' }, 'Print the order for the workshop, or choose “Save as PDF” in the print window to send or store it as a file.'),
    pdiSheet(o, opts),
    h('div', { class: 'actions no-print' },
      h('button', {
        class: 'btn', type: 'button',
        onClick: () => givenDialog('Did you give the order to the workshop (printed or as a PDF)?', o, (b) => record('print', b)),
      }, 'Already given – mark as sent'),
      printBtn));

  // E-mail or print: one panel at a time.
  const slot = h('div');
  const modeBtns = {};
  const show = (mode) => {
    slot.replaceChildren(mode === 'print' ? printPanel : emailPanel);
    Object.entries(modeBtns).forEach(([m, b]) => { b.className = m === mode ? 'btn primary' : 'btn'; });
  };
  modeBtns.email = h('button', { type: 'button', onClick: () => show('email') }, '✉ E-mail');
  modeBtns.print = h('button', { type: 'button', onClick: () => show('print') }, '🖨 Print or PDF');
  const body = h('div', {}, h('div', { class: 'send-modes no-print' }, modeBtns.email, modeBtns.print), slot);
  const { close } = openDialog('Send PDI order', body, { wide: true, doc: true });
  show(hasRecipients ? 'email' : 'print');
  load();
}

// ---------------------------------------------------------------- booking / done / cancel

function bookingDialog(o, done) {
  const [d0, t0] = (o.pdi_local || '').split('T');
  const date = dateInput({ id: 'pdi-date', required: true, value: d0 || '' });
  const time = timeInput({ id: 'pdi-time', required: true, value: (t0 || '').slice(0, 5) || '08:00' });
  const save = h('button', { class: 'btn primary', type: 'submit' }, 'Save PDI date');
  const form = h('form', {},
    h('p', { class: 'muted' }, 'Enter the date and time the workshop replied with. Everyone sees it on the Today page, with a reminder the day before.'),
    h('div', { class: 'grid' },
      h('div', { class: 'field' }, h('label', { for: 'pdi-date' }, 'Date'), date),
      h('div', { class: 'field' }, h('label', { for: 'pdi-time' }, 'Time'), time)),
    h('div', { class: 'actions spread' },
      o.pdi_at ? h('button', {
        class: 'link danger', type: 'button',
        onClick: async () => {
          try { await api.post(`/pdi/${o.id}/booking`, { date: null }); close(); await done(); } catch (e) { showError(e); }
        },
      }, 'Remove date') : h('span'),
      save));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(save, async () => {
      await api.post(`/pdi/${o.id}/booking`, { date: date.value, time: time.value });
      close();
      toast('PDI date saved', 'success');
      window.dispatchEvent(new Event('carbonara:pdi-changed'));
      await done();
    });
  });
  const { close } = openDialog('PDI date and time', form);
}

async function doneOrder(o, done) {
  if (!confirm('Mark the PDI as done?')) return;
  try {
    await api.post(`/pdi/${o.id}/done`);
    toast('PDI done – the car is ready for registration and delivery', 'success');
    await done();
  } catch (e) { showError(e); }
}

async function cancelOrder(o, done) {
  if (!confirm(o.sent_at
    ? 'Cancel this PDI order? It has already been sent – remember to tell the workshop.'
    : 'Cancel this PDI order?')) return;
  try { await api.post(`/pdi/${o.id}/cancel`); await done(); } catch (e) { showError(e); }
}

// PDI order card on the vehicle page: what the customer ordered, sent to the
// workshop (RBV) by e-mail; the workshop's date/time is entered by staff.
// Also the banner at the top of the vehicle page and the PDI page (#/pdi).
import { tr } from '../i18n.js';
import {
  api, append, boardBlock, boardRow, busy, carText, dateInput, fmtDate, h, openDialog, showError, timeInput, toast,
} from '../ui.js';

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
      link(o, `sent ${fmtDate(o.sent_at, false)} to ${o.sent_to}`))),
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
        o.sent_at ? h('span', { class: 'muted small' },
          `Sent ${fmtDate(o.sent_at)} to ${o.sent_to}${o.sent_by_name ? ` by ${o.sent_by_name}` : ''}${o.sent_via === 'mail_app' ? ' (e-mail app)' : ''}`) : null),
      o.changed_since_sent ? h('div', { class: 'notice warn small' }, 'Changed since it was sent — send it again so the workshop has the latest order.') : null,
      o.status === 'booked' && !o.sent_at ? h('div', { class: 'notice warn small' }, 'PDI date is set, but the order list has not been sent to the workshop yet.') : null,
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

function sendDialog(o, opts, done) {
  if (!opts.recipients.length) { showError(new Error('No e-mail recipients yet. An administrator can add them under Settings → PDI order lists.')); return; }
  const recipient = h('select', { id: 'pdi-to' }, opts.recipients.map((r) => h('option', { value: r.id }, `${r.label} – ${r.email}`)));
  recipient.value = String((opts.recipients.find((r) => r.is_default) || opts.recipients[0]).id);
  const preview = h('div', { class: 'pdi-mail', translate: 'no' }); // the e-mail is always Norwegian
  let mail = null;
  const load = async () => {
    try {
      mail = await api.get(`/pdi/${o.id}/email?recipient_id=${recipient.value}`);
      preview.textContent = `Til: ${mail.to}\nEmne: ${mail.subject}\n\n${mail.body}`;
    } catch (e) { showError(e); }
  };
  recipient.addEventListener('change', load);

  const record = async (via) => {
    await api.post(`/pdi/${o.id}/send`, { recipient_id: Number(recipient.value), via });
    close();
    toast(via === 'smtp' ? `Sent to ${mail?.to ?? 'the workshop'}` : 'Marked as sent', 'success');
    await done();
  };
  const smtpBtn = h('button', { class: 'btn primary', type: 'button', onClick: (e) => busy(e.currentTarget, () => record('smtp')) },
    'Send from Carbonara');
  const appBtn = h('button', {
    class: opts.smtp_configured ? 'btn' : 'btn primary', type: 'button',
    onClick: () => {
      if (!mail) return;
      location.href = `mailto:${mail.to}?subject=${encodeURIComponent(mail.subject)}&body=${encodeURIComponent(mail.body)}`;
      setTimeout(() => {
        if (confirm('Did you send the e-mail from your e-mail app?')) record('mail_app').catch(showError);
      }, 800);
    },
  }, 'Open in e-mail app');
  const copyBtn = h('button', {
    class: 'btn', type: 'button',
    onClick: async () => {
      try { await navigator.clipboard.writeText(`${mail.subject}\n\n${mail.body}`); toast('Copied', 'success'); } catch { toast('Copy not allowed here – select the text instead', 'error'); }
    },
  }, 'Copy text');

  const body = h('div', {},
    h('div', { class: 'field' }, h('label', { for: 'pdi-to' }, 'Send to'), recipient),
    preview,
    opts.smtp_configured ? null : h('p', { class: 'muted small' },
      'Sending directly from Carbonara is not set up yet (a system admin can add the mail server on the System page → E-mail), so use your own e-mail app.'),
    h('div', { class: 'actions' }, copyBtn, appBtn, opts.smtp_configured ? smtpBtn : null));
  const { close } = openDialog('Send PDI order', body, { wide: true });
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
      await done();
    });
  });
  const { close } = openDialog('PDI date and time', form);
}

async function doneOrder(o, done) {
  if (!confirm('Mark the PDI as done?')) return;
  try { await api.post(`/pdi/${o.id}/done`); toast('PDI marked as done', 'success'); await done(); } catch (e) { showError(e); }
}

async function cancelOrder(o, done) {
  if (!confirm(o.sent_at
    ? 'Cancel this PDI order? It has already been sent – remember to tell the workshop.'
    : 'Cancel this PDI order?')) return;
  try { await api.post(`/pdi/${o.id}/cancel`); await done(); } catch (e) { showError(e); }
}

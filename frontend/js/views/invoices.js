// Invoices (0.50.0): the list (#/invoices) and the invoice itself (#/invoices/:id), printed as a Norwegian A4 document.
// Issued invoices never change; only the payment is recorded. A credit note cancels a whole invoice (the parts go back
// into the stock and the work order can be invoiced again). Server: routers/invoices.py.
import { api, append, busy, dateInput, debounce, fmtDate, h, openDialog, osloTodayIso, showError, toast } from '../ui.js';
import { money2 } from './parts.js';

const kr = (n) => `${money2(n)} kr`;
const nok = (n) => money2(n);
const no = (iso) => (iso ? String(iso).slice(0, 10).split('-').reverse().join('.') : '');
const qtyNo = (n) => Number(n).toLocaleString('nb-NO', { maximumFractionDigits: 2 });
const pctNo = (n) => `${Number(n).toLocaleString('nb-NO', { maximumFractionDigits: 2 })} %`;

function stateBadge(i, today) {
  if (i.kind === 'credit_note') return h('span', { class: 'badge' }, 'Credit note');
  if (i.credited_by_number) return h('span', { class: 'badge' }, `Credited (no. ${i.credited_by_number})`);
  if (i.paid_at) return h('span', { class: 'badge good' }, `Paid ${fmtDate(i.paid_at)}`);
  if (String(i.due_date) < String(today)) return h('span', { class: 'badge bad' }, 'Overdue');
  return h('span', { class: 'badge warn' }, 'Not paid');
}

// ---------------------------------------------------------------- #/invoices

export async function invoicesView(el) {
  const saved = new URLSearchParams(location.hash.split('?')[1] || '');
  const state = { show: saved.get('show') || 'all', q: saved.get('q') || '' };
  const showSel = h('select', { 'aria-label': 'Show' },
    [['all', 'All invoices'], ['unpaid', 'Not paid'], ['paid', 'Paid']].map(([v, t]) => h('option', { value: v, selected: v === state.show }, t)));
  const search = h('input', { type: 'search', value: state.q, placeholder: 'Invoice no., customer, reg. no., work order no.…', 'aria-label': 'Search invoices' });
  const listSlot = h('div');
  let seq = 0;
  const load = async () => {
    const my = ++seq;
    const q = new URLSearchParams(Object.entries(state).filter(([k, v]) => v && !(k === 'show' && v === 'all'))).toString();
    if (location.hash.startsWith('#/invoices')) history.replaceState(null, '', `#/invoices${q ? `?${q}` : ''}`);
    const data = await api.get(`/invoices?show=${state.show}&q=${encodeURIComponent(state.q)}`);
    if (my === seq) listSlot.replaceChildren(table(data));
  };
  const reload = () => load().catch(showError);
  showSel.addEventListener('change', () => { state.show = showSel.value; reload(); });
  search.addEventListener('input', debounce(() => { state.q = search.value.trim(); reload(); }, 300));
  const today = osloTodayIso();
  const from = dateInput({ value: `${today.slice(0, 8)}01` });
  const to = dateInput({ value: today });
  const exp = h('button', { class: 'btn', type: 'button' }, '⬇ Export (CSV)');
  exp.addEventListener('click', () => {
    if (!from.value || !to.value) { toast('Choose the dates', 'error'); return; }
    location.href = `/api/invoices/export?start=${from.value}&end=${to.value}`;
  });
  append(el,
    h('p', { class: 'small' }, h('a', { href: '#/work-orders' }, '← Work orders')),
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', {}, 'Invoices'),
        h('div', { class: 'muted' }, 'Invoices and credit notes from the work orders. An issued invoice is never changed or deleted.'))),
    h('div', { class: 'toolbar' }, search, showSel),
    listSlot,
    h('section', { class: 'card' },
      h('h2', {}, 'Export for the accountant'),
      h('p', { class: 'muted small' }, 'Invoices and credit notes issued between the two dates, as a CSV file for Excel.'),
      h('div', { class: 'toolbar hours-toolbar' }, from, h('span', {}, '–'), to, exp)));
  await load();
}

function table(data) {
  const summary = h('p', { class: 'muted small' },
    h('span', {}, 'Not paid:'), ` ${data.unpaid.n} · ${kr(data.unpaid.sum)}`,
    data.overdue ? [' · ', h('span', { class: 'badge bad' }, `${data.overdue} overdue`)] : null);
  if (!data.invoices.length) return h('div', {}, summary, h('p', { class: 'empty' }, 'No invoices.'));
  const rows = data.invoices.map((i) => {
    const tr = h('tr', { class: 'click-row', tabindex: '0' },
      h('td', {}, h('a', { href: `#/invoices/${i.id}` }, String(i.number))),
      h('td', {}, fmtDate(i.issue_date)),
      h('td', {}, h('span', { translate: 'no' }, i.buyer_name || '–'),
        i.registration_number ? h('span', { class: 'muted small block mono' }, i.registration_number) : null),
      h('td', {}, i.work_order_number ? `#${i.work_order_number}`
        : i.parts_order_number ? h('span', {}, h('span', {}, 'Parts order'), ` #${i.parts_order_number}`) : '–'),
      h('td', { class: 'num' }, kr(i.total_inc)),
      h('td', {}, stateBadge(i, data.today), i.kind === 'invoice' && !i.paid_at && !i.credited_by_number
        ? h('span', { class: 'muted small block' }, h('span', {}, 'Due'), ` ${fmtDate(i.due_date)}`) : null));
    const go = () => { location.hash = `#/invoices/${i.id}`; };
    tr.addEventListener('click', (e) => { if (!e.target.closest('a')) go(); });
    tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    return tr;
  });
  return h('div', {}, summary, h('div', { class: 'table-wrap' }, h('table', { class: 'price-table parts-table' },
    h('thead', {}, h('tr', {}, h('th', {}, 'No.'), h('th', {}, 'Date'), h('th', {}, 'Customer'), h('th', {}, 'Order'),
      h('th', { class: 'num' }, 'Total inc VAT'), h('th', {}, 'Status'))),
    h('tbody', {}, rows))));
}

// ---------------------------------------------------------------- #/invoices/:id

export async function invoiceView(el, [id], host = el) {
  const inv = await api.get(`/invoices/${id}`);
  const rerender = async () => {
    try {
      const fresh = h('div');
      await invoiceView(fresh, [id], host);
      host.replaceChildren(...fresh.childNodes);
    } catch (e) { showError(e); }
  };
  const isInvoice = inv.kind === 'invoice';
  const credited = !!inv.credited_by_id;

  const paidBtn = isInvoice && !credited ? h('button', { class: 'btn', type: 'button' }, inv.paid_at ? 'Change payment' : '✓ Mark as paid') : null;
  paidBtn?.addEventListener('click', () => paidDialog(inv, rerender));
  const creditBtn = isInvoice && !credited ? h('button', { class: 'link danger', type: 'button' }, 'Make a credit note') : null;
  creditBtn?.addEventListener('click', () => creditDialog(inv));

  append(el,
    h('div', { class: 'no-print' },
      h('p', { class: 'small' }, h('a', { href: '#/invoices' }, '← Invoices'),
        inv.work_order_id ? [' · ', h('a', { href: `#/work-orders/${inv.work_order_id}` }, `Work order #${inv.car?.work_order ?? ''}`)] : null,
        !inv.work_order_id && inv.car?.parts_order && inv.parts_order_ids?.length
          ? [' · ', h('a', { href: `#/parts-orders/${inv.parts_order_ids[0]}` }, `Parts order #${inv.car.parts_order}`)] : null),
      h('div', { class: 'page-head' },
        h('div', {}, h('h1', {}, `${isInvoice ? 'Invoice' : 'Credit note'} no. ${inv.number}`), stateBadge(inv, inv.today)),
        h('div', { class: 'row-actions' },
          h('button', { class: 'btn primary', type: 'button', onClick: () => window.print() }, '🖨 Print or PDF'),
          paidBtn)),
      credited ? h('div', { class: 'notice' }, h('span', {}, 'Credited by'), ' ',
        h('a', { href: `#/invoices/${inv.credited_by_id}` }, `Credit note no. ${inv.credited_by_number}`)) : null,
      inv.paid_at ? h('p', { class: 'muted small' }, h('span', {}, 'Paid'), ` ${fmtDate(inv.paid_at)}${inv.paid_by_name ? ` · ${inv.paid_by_name}` : ''}`) : null),
    invoiceDoc(inv),
    creditBtn ? h('div', { class: 'actions spread no-print' }, creditBtn, h('span')) : null);
}

/** The invoice as a Norwegian document (always Norwegian, like the other documents). */
function invoiceDoc(inv) {
  const s = inv.seller || {};
  const b = inv.buyer || {};
  const c = inv.car || {};
  const isInvoice = inv.kind === 'invoice';
  const rabatt = (inv.lines || []).some((l) => Number(l.discount) > 0);   // the column only when a line has a discount (0.63.0)
  const orgLine = s.org_no ? `Org.nr. ${s.org_no}${s.vat_registered ? ' MVA' : ''}` : null;
  const meta = (label, value) => (value ? h('tr', {}, h('th', {}, label), h('td', {}, value)) : null);
  const carText = [c.registration_number, [c.make, c.model].filter(Boolean).join(' '), c.vin ? `VIN ${c.vin}` : null,
    c.km != null ? `Km-stand ${qtyNo(c.km)}` : null].filter(Boolean).join(' · ');
  return h('div', { class: 'report invoice-doc', translate: 'no' },
    h('div', { class: 'inv-head' },
      h('div', { class: 'inv-seller' },
        h('div', { class: 'inv-company' }, s.name || ''),
        s.address ? h('div', { class: 'pre-line' }, s.address) : null,
        orgLine ? h('div', {}, orgLine) : null,
        s.foretaksregisteret ? h('div', {}, 'Foretaksregisteret') : null,
        s.phone ? h('div', {}, `Tlf. ${s.phone}`) : null,
        s.email ? h('div', {}, s.email) : null),
      h('div', { class: 'inv-title' },
        h('div', { class: 'inv-kind' }, isInvoice ? 'FAKTURA' : 'KREDITNOTA'),
        h('table', { class: 'inv-meta' }, h('tbody', {},
          meta(isInvoice ? 'Fakturanr.' : 'Kreditnotanr.', String(inv.number)),
          meta(isInvoice ? 'Fakturadato' : 'Dato', no(inv.issue_date)),
          meta('Leveringsdato', no(inv.delivery_date)),
          isInvoice ? meta('Forfallsdato', no(inv.due_date)) : null,
          meta('Kundenr.', b.customer_no ? String(b.customer_no) : null),
          meta('Arbeidsordre', c.work_order ? String(c.work_order) : null),
          meta('Delebestilling', c.parts_order ? String(c.parts_order) : null),
          isInvoice ? meta('KID', inv.kid) : null)))),
    h('div', { class: 'inv-buyer' },
      h('div', { class: 'inv-label' }, 'Kunde'),
      h('div', { class: 'inv-buyer-name' }, b.name || ''),
      b.address ? h('div', {}, b.address) : null,
      b.postal_code || b.city ? h('div', {}, [b.postal_code, b.city].filter(Boolean).join(' ')) : null,
      b.org_no ? h('div', {}, `Org.nr. ${b.org_no}`) : null),
    !isInvoice && inv.credits_number ? h('p', { class: 'inv-credit' },
      `Krediterer faktura nr. ${inv.credits_number} datert ${no(inv.credits_issue_date)}.`) : null,
    carText ? h('p', {}, h('strong', {}, 'Bil: '), carText) : null,
    h('table', { class: 'inv-lines' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Varenr.'), h('th', {}, 'Beskrivelse'), h('th', { class: 'num' }, 'Antall'),
        h('th', {}, 'Enhet'), h('th', { class: 'num' }, 'Pris eks. mva'), rabatt ? h('th', { class: 'num' }, 'Rabatt') : null,
        h('th', { class: 'num' }, 'Mva'), h('th', { class: 'num' }, 'Beløp eks. mva'))),
      h('tbody', {}, inv.lines.map((l) => h('tr', {},
        h('td', { class: 'mono' }, l.part_number || ''),
        h('td', {}, l.text),
        h('td', { class: 'num' }, l.kind === 'discount' ? '' : qtyNo(l.quantity)),
        h('td', {}, l.unit || ''),
        h('td', { class: 'num' }, l.kind === 'discount' ? '' : nok(l.unit_price)),
        rabatt ? h('td', { class: 'num' }, Number(l.discount) > 0 ? pctNo(l.discount) : '') : null,
        h('td', { class: 'num' }, pctNo(l.vat_rate)),
        h('td', { class: 'num' }, nok(l.total_ex)))))),
    h('table', { class: 'inv-totals' }, h('tbody', {},
      h('tr', {}, h('th', {}, 'Sum eks. mva'), h('td', { class: 'num' }, nok(inv.total_ex))),
      ...inv.vat_lines.map((v) => h('tr', {}, h('th', {}, `Mva ${pctNo(v.rate)} av ${nok(v.base)}`), h('td', { class: 'num' }, nok(v.vat)))),
      h('tr', { class: 'inv-sum' }, h('th', {}, isInvoice ? 'Å betale (NOK)' : 'Til gode (NOK)'), h('td', { class: 'num' }, nok(inv.total_inc))))),
    !s.vat_registered ? h('p', {}, 'Selger er ikke registrert i Merverdiavgiftsregisteret. Det er ikke beregnet merverdiavgift.') : null,
    isInvoice ? h('div', { class: 'inv-pay' },
      h('strong', {}, 'Betaling: '),
      [s.bank_account ? `Kontonr. ${s.bank_account}` : null, inv.kid ? `KID ${inv.kid}` : null, `Forfall ${no(inv.due_date)}`]
        .filter(Boolean).join(' · ')) : null,
    inv.note ? h('p', { class: 'pre-line' }, inv.note) : null,
    s.footer ? h('p', { class: 'inv-footer pre-line' }, s.footer) : null);
}

function paidDialog(inv, done) {
  const day = dateInput({ value: inv.paid_at || osloTodayIso(), required: true });
  const ok = h('button', { class: 'btn primary', type: 'submit' }, 'Save');
  const remove = inv.paid_at ? h('button', { class: 'link danger', type: 'button' }, 'Not paid after all') : null;
  const form = h('form', {},
    h('div', { class: 'field' }, h('label', {}, 'Paid on'), day),
    h('div', { class: 'actions spread' }, remove || h('span'), ok));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!day.value) { toast('Choose the date', 'error'); return; }
    busy(ok, async () => {
      await api.put(`/invoices/${inv.id}/paid`, { paid_at: day.value });
      close();
      toast('Saved', 'success');
      await done();
    });
  });
  remove?.addEventListener('click', () => busy(remove, async () => {
    await api.put(`/invoices/${inv.id}/paid`, { paid_at: null });
    close();
    await done();
  }));
  const { close } = openDialog(`Invoice no. ${inv.number}`, form);
}

function creditDialog(inv) {
  const reason = h('textarea', { rows: 2, maxlength: 500, placeholder: 'Printed on the credit note (optional)' });
  const ok = h('button', { class: 'btn danger', type: 'submit' }, 'Make credit note');
  const form = h('form', {},
    h('p', {}, 'A credit note cancels the whole invoice with a new number. The parts go back into the stock, and the work '
      + 'order can be changed and invoiced again.'),
    h('div', { class: 'field' }, h('label', {}, 'Reason'), reason),
    h('div', { class: 'actions' }, ok));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(ok, async () => {
      const r = await api.post(`/invoices/${inv.id}/credit`, { reason: reason.value.trim() || null });
      close();
      toast(`Credit note no. ${r.number} made`, 'success');
      location.hash = `#/invoices/${r.id}`;
    });
  });
  const { close } = openDialog(`Credit invoice no. ${inv.number}`, form);
}

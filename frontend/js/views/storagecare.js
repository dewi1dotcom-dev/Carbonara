// Storage maintenance for new cars (MG SI-GI2022102501): a card on the vehicle
// page with the next check, the check form, and the printable record.
import { api, append, busy, fmtDate, h, openDialog, session, showError, toast, vehicleTitle } from '../ui.js';

const RESULT = { ok: '✓', not_ok: '✗', na: '–' };
const dueText = (n) => (n.days < 0 ? `overdue by ${-n.days} d` : n.days === 0 ? 'due today' : `due ${fmtDate(n.due, false)} (in ${n.days} d)`);
const num = (v, digits = 2) => (v == null ? '' : Number(v).toFixed(digits).replace('.', ','));

// The "arrival" kind is called First storage check in the UI, so it isn't
// mixed up with the arrival inspection (it is done as a step of it).
const KIND_EN = { arrival: 'First storage check', monthly: 'Monthly check', quarterly: '3-month check', half_year: '6-month check' };
const checkName = (c) => KIND_EN[c.kind === 'arrival' ? 'arrival' : c.level];

/** All checks, newest first; admins can cancel one registered by mistake. */
function checkList(p, rerender) {
  const admin = !!session.me?.is_admin;
  const rows = [...p.checks].reverse().map((c) => h('li', { class: c.voided_at ? 'sc-void' : '' },
    h('span', {},
      h('strong', {}, checkName(c)), ` — ${fmtDate(c.performed_at)}${c.performed_by_name ? `, ${c.performed_by_name}` : ''}`,
      c.v12_before != null ? ` · 12V ${num(c.v12_before)} V` : '',
      c.voided_at ? h('span', { class: 'small block' },
        `Cancelled ${fmtDate(c.voided_at)}${c.voided_by_name ? ` by ${c.voided_by_name}` : ''}: ${c.void_reason}`) : null),
    admin && !c.voided_at ? h('button', {
      class: 'link danger', type: 'button',
      onClick: async () => {
        const reason = prompt(`Cancel the ${checkName(c).toLowerCase()} from ${fmtDate(c.performed_at)}?\n\n`
          + 'It stops counting in the schedule but stays in the report, struck through.\nReason (required):');
        if (reason == null) return;
        if (reason.trim().length < 3) { showError(new Error('Give a reason (at least 3 characters)')); return; }
        try {
          await api.post(`/storage-checks/${c.id}/void`, { reason: reason.trim() });
          toast('Check cancelled', 'success');
          await rerender();
        } catch (e) { showError(e); }
      },
    }, 'Cancel') : null));
  return h('details', { class: 'more' }, h('summary', {}, `All checks (${p.checks.length})`),
    h('ul', { class: 'plain rows' }, rows));
}

export function storageCard(v, p, rerender) {
  if (!p.applies && !p.checks.length) return null;
  const card = h('section', { class: 'card' }, h('h2', {}, 'Storage maintenance'));
  const n = p.next;
  const valid = p.checks.filter((c) => !c.voided_at);
  const last = valid[valid.length - 1];
  append(card,
    h('p', { class: 'muted small' }, 'MG storage requirements (SI-GI2022102501): a first storage check at arrival, then every month (more every 3 and 6 months) until the PDI.'),
    n ? h('div', { class: `notice ${n.days < 0 ? 'bad-notice' : n.days <= 3 ? 'warn' : ''}` },
      h('strong', {}, n.title_en), ' — ', n.kind === 'arrival' ? 'not done yet' : dueText(n))
      : (p.note ? h('p', { class: 'muted' }, p.note) : null),
    last ? h('p', { class: 'small' }, `Last check ${fmtDate(last.performed_at)}${last.performed_by_name ? ` by ${last.performed_by_name}` : ''}`,
      last.v12_before != null ? ` · 12V ${num(last.v12_before)} V` : '',
      last.soc_percent != null ? ` · SOC ${last.soc_percent} %` : '') : null,
    p.start ? h('p', { class: 'muted small' }, `In storage since ${fmtDate(p.start, false)} · ${valid.length} check${valid.length === 1 ? '' : 's'} recorded`) : null,
    p.checks.length ? checkList(p, rerender) : null,
    h('div', { class: 'actions' },
      p.checks.length ? h('a', { class: 'btn', href: `#/vehicles/${v.id}/storage-report` }, '🖨 Storage report') : null,
      n ? h('button', { class: n.days <= 3 ? 'btn primary' : 'btn', type: 'button', onClick: () => checkDialog(v, p, rerender) },
        `Do ${n.title_en.toLowerCase()}`) : null));
  return card;
}

// ---------------------------------------------------------------- used cars: 12V charging every month

const chargeText = (c) => [fmtDate(c.charged_at), c.charged_by_name,
  c.v12_before != null && `before ${num(c.v12_before)} V`, c.v12_after != null && `after ${num(c.v12_after)} V`]
  .filter(Boolean).join(' · ');

/** p = GET /vehicles/:id/battery-charging. Shown for used cars (or any car with charges recorded). */
export function batteryCard(v, p, rerender) {
  if (!p.applies && !p.charges.length) return null;
  const admin = !!session.me?.is_admin;
  const n = p.next;
  const valid = p.charges.filter((c) => !c.voided_at);
  const last = valid[valid.length - 1];
  const rows = [...p.charges].reverse().map((c) => h('li', { class: c.voided_at ? 'sc-void' : '' },
    h('span', {}, chargeText(c),
      c.note ? h('span', { class: 'small block' }, c.note) : null,
      c.voided_at ? h('span', { class: 'small block' },
        `Cancelled ${fmtDate(c.voided_at)}${c.voided_by_name ? ` by ${c.voided_by_name}` : ''}: ${c.void_reason}`) : null),
    admin && !c.voided_at ? h('button', {
      class: 'link danger', type: 'button',
      onClick: async () => {
        const reason = prompt(`Cancel the 12V charge from ${fmtDate(c.charged_at)}?\n\nIt stops counting but stays in the list, struck through.\nReason (required):`);
        if (reason == null) return;
        if (reason.trim().length < 3) { showError(new Error('Give a reason (at least 3 characters)')); return; }
        try {
          await api.post(`/battery-charges/${c.id}/void`, { reason: reason.trim() });
          toast('Charge cancelled', 'success');
          await rerender();
        } catch (e) { showError(e); }
      },
    }, 'Cancel') : null));
  return h('section', { class: 'card' },
    h('h2', {}, '12V battery charging'),
    h('p', { class: 'muted small' }, 'Used cars in storage: charge the 12V battery every month.'),
    n ? h('div', { class: `notice ${n.days < 0 ? 'bad-notice' : n.days <= 3 ? 'warn' : ''}` },
      h('strong', {}, 'Next charge'), ' — ', dueText(n))
      : (p.note ? h('p', { class: 'muted' }, p.note) : null),
    last ? h('p', { class: 'small' }, `Last charged ${chargeText(last)}`)
      : (p.stay_start && n ? h('p', { class: 'small' }, `Not charged since it came into storage ${fmtDate(p.stay_start, false)}`) : null),
    p.charges.length ? h('details', { class: 'more' }, h('summary', {}, `All charges (${p.charges.length})`),
      h('ul', { class: 'plain rows' }, rows)) : null,
    p.applies ? h('div', { class: 'actions' },
      h('button', { class: n && n.days <= 3 ? 'btn primary' : 'btn', type: 'button', onClick: () => chargeDialog(v, p, rerender) },
        '🔌 Record charge')) : null);
}

function chargeDialog(v, p, done) {
  const before = h('input', { type: 'number', id: 'bc-before', step: '0.01', min: 0, max: 20, inputmode: 'decimal', placeholder: '12,2' });
  const after = h('input', { type: 'number', id: 'bc-after', step: '0.01', min: 0, max: 20, inputmode: 'decimal', placeholder: '12,7' });
  const note = h('textarea', { id: 'bc-note', rows: 2, maxlength: 500 });
  const warning = h('div', { class: 'notice warn small', hidden: true },
    `Below ${num(p.v12_min, 1)} V after charging – the battery may need replacing. Write what was done under Note.`);
  after.addEventListener('input', () => { warning.hidden = !(after.value && Number(after.value) < p.v12_min); });
  const save = h('button', { class: 'btn primary', type: 'submit' }, 'Save');
  const form = h('form', {},
    h('p', { class: 'muted' }, `${vehicleTitle(v)} · ${v.vin}`),
    h('div', { class: 'grid' },
      h('div', { class: 'field' }, h('label', { for: 'bc-before' }, 'Voltage before charging (V)'), before),
      h('div', { class: 'field' }, h('label', { for: 'bc-after' }, 'Voltage after charging (V)'), after)),
    h('p', { class: 'muted small' }, 'The voltages are optional.'),
    h('div', { class: 'field' }, h('label', { for: 'bc-note' }, 'Note'), note),
    warning,
    h('p', { class: 'muted small' }, 'Signed with your name and the time when saved.'),
    h('div', { class: 'actions' }, save));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(save, async () => {
      await api.post(`/vehicles/${v.id}/battery-charging`, {
        v12_before: before.value ? Number(before.value) : null,
        v12_after: after.value ? Number(after.value) : null,
        note: note.value,
      });
      close();
      toast('12V charge saved', 'success');
      await done();
    });
  });
  const { close } = openDialog('Record 12V charge', form);
}

// ---------------------------------------------------------------- the check form

/** The check form for p.next (p = GET /vehicles/:id/storage-care). Also opened
 *  from the arrival inspection for the first storage check. */
export function checkDialog(v, p, done) {
  const n = p.next;
  const L = p.limits;
  const results = new Map();
  const itemRows = p.form.items.map((it) => {
    const name = `it-${it.key}`;
    const radios = ['ok', 'not_ok', 'na'].map((r) => {
      const input = h('input', { type: 'radio', name, value: r });
      input.addEventListener('change', () => { results.set(it.key, r); warn(); });
      return h('label', { class: `chip res-${r}` }, input, { ok: 'OK', not_ok: 'Not OK', na: 'N/A' }[r]);
    });
    return { it, radios, el: h('div', { class: 'sc-item' }, h('span', { class: 'sc-label' }, it.label), h('span', { class: 'chips' }, radios)) };
  });
  const allOk = h('button', {
    class: 'link', type: 'button',
    onClick: () => itemRows.forEach((r) => { r.radios[0].querySelector('input').checked = true; results.set(r.it.key, 'ok'); warn(); }),
  }, 'Mark all OK');

  const tyre = h('input', { type: 'number', id: 'sc-tyre', step: '0.05', min: 0, max: 6, inputmode: 'decimal', placeholder: '2,7', required: true });
  const tyresOk = h('input', { type: 'checkbox', id: 'sc-tyres-ok' });
  tyre.addEventListener('input', () => {
    const t = Number(tyre.value);
    if (tyre.value) tyresOk.checked = t >= L.tyre_min && t <= L.tyre_max;
    warn();
  });
  tyresOk.addEventListener('change', warn);

  const v12 = h('input', { type: 'number', id: 'sc-v12', step: '0.01', min: 0, max: 20, inputmode: 'decimal', placeholder: '12,6', required: true });
  const status = h('select', { id: 'sc-status', required: true }, h('option', { value: '' }, 'Tester result…'),
    Object.entries(p.battery_status).map(([k, t]) => h('option', { value: k }, t)));
  const action = h('select', { id: 'sc-action' }, Object.entries(p.battery_action).map(([k, t]) => h('option', { value: k }, t)));
  const v12after = h('input', { type: 'number', id: 'sc-v12after', step: '0.01', min: 0, max: 20, inputmode: 'decimal' });
  const afterField = h('div', { class: 'field', hidden: true }, h('label', { for: 'sc-v12after' }, 'Voltage after charging (V)'), v12after);
  const partNo = p.form.part_no ? h('input', { type: 'text', id: 'sc-part', maxlength: 60, placeholder: 'From the battery label' }) : null;
  [v12, status, action].forEach((x) => x.addEventListener('input', warn));

  const soc = p.form.soc ? h('input', { type: 'number', id: 'sc-soc', min: 0, max: 100, inputmode: 'numeric', placeholder: '%' }) : null;
  const socTo = h('input', { type: 'number', id: 'sc-socto', min: 0, max: 100, inputmode: 'numeric', placeholder: '%' });
  const socToField = h('div', { class: 'field', hidden: true }, h('label', { for: 'sc-socto' }, `Charged to (min. ${L.soc_long} %)`), socTo);
  if (soc) soc.addEventListener('input', warn);

  const remarks = h('textarea', { id: 'sc-remarks', rows: 3, maxlength: 2000, placeholder: 'Required if something is not OK: what was found and what was done' });
  const warnings = h('div', { class: 'sc-warnings' });

  function warn() {
    const list = [];
    const t = Number(tyre.value);
    if (tyre.value && (t < L.tyre_min || t > L.tyre_max)) list.push(`Tyre pressure ${num(t)} bar – adjust to 2,7 ± 0,1 bar.`);
    const volt = Number(v12.value);
    const lowV = v12.value && volt < L.v12_min;
    if (lowV) list.push(`12V is below ${num(L.v12_min, 1)} V – charge or replace the battery.`);
    if (status.value && status.value !== 'good') list.push('Battery tester did not say “Good” – charge or replace.');
    afterField.hidden = action.value !== 'charged';
    if (soc) {
      const s = Number(soc.value);
      socToField.hidden = !(soc.value && s < L.soc_min);
      if (soc.value && s < L.soc_min) list.push(`SOC below ${L.soc_min} % – charge to at least ${L.soc_long} %.`);
      else if (soc.value && n.kind === 'arrival' && s < L.soc_long) list.push(`For storage over a month MG wants SOC over ${L.soc_long} %.`);
    }
    if ([...results.values()].includes('not_ok')) list.push('A point is not OK – describe it under Remarks.');
    warnings.replaceChildren(...list.map((w) => h('div', { class: 'notice warn small' }, w)));
  }

  const save = h('button', { class: 'btn primary', type: 'submit' }, 'Save check');
  const form = h('form', { class: 'sc-form' },
    h('p', { class: 'muted' }, `${vehicleTitle(v)} · ${v.vin}`, n.kind === 'periodic' ? ` · ${dueText(n)}` : ''),
    h('div', { class: 'row spread-row' }, h('h3', {}, 'Checklist'), allOk),
    itemRows.map((r) => r.el),
    h('h3', {}, 'Tyre pressure'),
    h('div', { class: 'grid' },
      h('div', { class: 'field' }, h('label', { for: 'sc-tyre' }, 'Measured (bar)'), tyre)),
    h('label', { class: 'check', for: 'sc-tyres-ok' }, tyresOk, `All four tyres within ${num(L.tyre_min, 1)}–${num(L.tyre_max, 1)} bar (adjusted if needed)`),
    h('h3', {}, '12V battery (tester)'),
    h('div', { class: 'grid' },
      h('div', { class: 'field' }, h('label', { for: 'sc-v12' }, n.kind === 'arrival' ? 'Voltage on arrival (V)' : 'Voltage before charging (V)'), v12),
      h('div', { class: 'field' }, h('label', { for: 'sc-status' }, 'Battery status'), status),
      h('div', { class: 'field' }, h('label', { for: 'sc-action' }, 'Action'), action),
      afterField,
      partNo ? h('div', { class: 'field' }, h('label', { for: 'sc-part' }, 'Battery part number'), partNo) : null),
    soc ? [h('h3', {}, 'HV battery'),
      h('div', { class: 'grid' },
        h('div', { class: 'field' }, h('label', { for: 'sc-soc' }, 'State of charge (SOC %)'), soc), socToField)] : null,
    h('div', { class: 'field' }, h('label', { for: 'sc-remarks' }, 'Remarks'), remarks),
    warnings,
    h('p', { class: 'muted small' }, 'Signed with your name and the time when saved.'),
    h('div', { class: 'actions' }, save));

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const missing = itemRows.find((r) => !results.has(r.it.key));
    if (missing) { showError(new Error(`Answer every point (missing: ${missing.it.label})`)); return; }
    busy(save, async () => {
      await api.post(`/vehicles/${v.id}/storage-care/checks`, {
        kind: n.kind,
        items: itemRows.map((r) => ({ key: r.it.key, result: results.get(r.it.key) })),
        tyre_pressure: tyre.value ? Number(tyre.value) : null,
        tyres_ok: tyresOk.checked,
        v12_before: v12.value ? Number(v12.value) : null,
        v12_after: v12after.value && action.value === 'charged' ? Number(v12after.value) : null,
        battery_status: status.value || null,
        battery_action: action.value,
        battery_part_no: partNo ? partNo.value : null,
        soc_percent: soc && soc.value ? Number(soc.value) : null,
        soc_charged_to: socTo.value ? Number(socTo.value) : null,
        remarks: remarks.value,
      });
      close();
      toast(`${n.title_en} saved`, 'success');
      await done();
    });
  });
  const { close } = openDialog(n.title_en, form, { wide: true });
}

// ---------------------------------------------------------------- printable record

export async function storageReportView(el, [id]) {
  const r = await api.get(`/vehicles/${id}/storage-care/report`);
  const v = r.vehicle;
  const arrival = r.checks.find((c) => c.kind === 'arrival' && !c.voided_at);
  const periodic = r.checks.filter((c) => c.kind === 'periodic'); // cancelled ones too, struck through
  const voided = r.checks.filter((c) => c.voided_at);
  const voidCls = (c) => (c.voided_at ? 'rep-void' : '');
  const sign = (c) => c.performed_by_name ?? '';
  const only12 = h('input', { type: 'checkbox', id: 'only12' });
  const body = h('div', { class: 'report', translate: 'no' }); // a Norwegian document

  const head = () => h('table', { class: 'rep-head' }, h('tbody', {},
    h('tr', {}, h('th', {}, 'Forhandler'), h('td', {}, r.company), h('th', {}, 'Forh. nr.'), h('td', {}, r.dealer_number ?? '')),
    h('tr', {}, h('th', {}, 'VIN'), h('td', { class: 'mono' }, v.vin), h('th', {}, 'Modell'),
      h('td', {}, [v.make, v.model, v.variant, v.model_year].filter(Boolean).join(' '))),
    h('tr', {}, h('th', {}, 'Ankomstdato'), h('td', {}, r.start ? fmtDate(r.start, false) : ''), h('th', {}, 'Farge'), h('td', {}, v.color ?? '')),
    h('tr', {}, h('th', {}, 'Reg.nr.'), h('td', {}, v.registration_number ?? ''), h('th', {}, 'Parkering'), h('td', {}, r.spot ?? '')),
    h('tr', {}, h('th', {}, 'Reg. dato'), h('td', {}, v.first_registered ? fmtDate(v.first_registered, false) : ''),
      h('th', {}, 'Delenr. batteri'), h('td', {}, arrival?.battery_part_no ?? '')),
    h('tr', {}, h('th', {}, 'Spenning ved mottak'), h('td', {}, arrival?.v12_before != null ? `${num(arrival.v12_before)} V` : ''),
      h('th', {}, 'Drivstoff'), h('td', {}, r.fuel ?? ''))));

  const resultCell = (c, key) => {
    const it = (c.items || []).find((i) => i.key === key);
    return h('td', { class: `res res-${it?.result ?? 'none'} ${voidCls(c)}` }, it ? RESULT[it.result] : '');
  };

  const arrivalSection = () => (!arrival ? h('p', {}, 'Ankomstkontroll er ikke registrert.') : [
    h('p', { class: 'small' }, `Utført ${fmtDate(arrival.performed_at)} av ${sign(arrival)}`),
    h('table', { class: 'rep-table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Kontrollpunkt'), h('th', {}, 'Sjekk'))),
      h('tbody', {}, (arrival.items || []).map((i) => h('tr', {}, h('td', {}, i.label), h('td', { class: `res res-${i.result}` }, RESULT[i.result]))),
        h('tr', {}, h('td', {}, 'Dekktrykk 2,7 ± 0,1 bar'), h('td', {}, `${num(arrival.tyre_pressure)} bar ${arrival.tyres_ok ? '✓' : '✗'}`)),
        arrival.soc_percent != null ? h('tr', {}, h('td', {}, 'HV-batteri SOC'), h('td', {}, `${arrival.soc_percent} %`)) : null)),
  ]);

  // Periodic checklist: one column per check, at most 6 per table so it fits on A4.
  const periodicSection = () => {
    if (!periodic.length) return h('p', {}, 'Ingen periodiske kontroller registrert ennå.');
    const keys = r.items.filter((i) => i.when !== 'arrival' && periodic.some((c) => (c.items || []).some((x) => x.key === i.key)));
    const chunks = [];
    for (let i = 0; i < periodic.length; i += 6) chunks.push(periodic.slice(i, i + 6));
    return chunks.map((cs) => h('table', { class: 'rep-table rep-grid' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Sjekkpunkt / sjekkdato'),
        cs.map((c) => h('th', { class: voidCls(c) }, fmtDate(c.performed_at, false),
          h('div', { class: 'rep-sub' }, c.voided_at ? 'ANNULLERT' : r.level_text[c.level]))))),
      h('tbody', {},
        keys.map((k) => h('tr', {}, h('td', {}, k.label), cs.map((c) => resultCell(c, k.key)))),
        h('tr', {}, h('td', {}, 'Dekktrykk (2,7 bar)'), cs.map((c) => h('td', { class: `res ${voidCls(c)}` }, `${num(c.tyre_pressure)}${c.tyres_ok ? '' : ' ✗'}`))),
        r.fuel_kind.nev ? h('tr', {}, h('td', {}, 'SOC HV-batteri (%)'), cs.map((c) => h('td', { class: `res ${voidCls(c)}` },
          c.soc_percent ?? '', c.soc_charged_to != null ? ` → ${c.soc_charged_to}` : ''))) : null,
        h('tr', {}, h('td', {}, 'Signatur'), cs.map((c) => h('td', { class: `res small ${voidCls(c)}` }, sign(c)))))));
  };

  const batterySection = () => h('table', { class: 'rep-table' },
    h('thead', {}, h('tr', {}, ['Sjekk dato', 'Batteristatus', 'Spenning før lading (V)', 'Spenning etter lading (V)', 'Tiltak', 'Sign. insp.']
      .map((t) => h('th', {}, t)))),
    h('tbody', {}, r.checks.map((c) => h('tr', { class: c.voided_at ? 'rep-void' : c.battery_status && c.battery_status !== 'good' ? 'rep-flag' : '' },
      h('td', {}, fmtDate(c.performed_at)),
      h('td', {}, r.battery_status[c.battery_status] ?? ''),
      h('td', {}, num(c.v12_before)),
      h('td', {}, num(c.v12_after)),
      h('td', {}, r.battery_action[c.battery_action] ?? ''),
      h('td', {}, sign(c))))));

  const remarksSection = () => {
    const rows = r.checks.filter((c) => c.remarks);
    return rows.length
      ? h('table', { class: 'rep-table' }, h('thead', {}, h('tr', {}, h('th', {}, 'Dato'), h('th', {}, 'Anmerkning / tiltak'), h('th', {}, 'Sign.'))),
        h('tbody', {}, rows.map((c) => h('tr', {}, h('td', {}, fmtDate(c.performed_at)), h('td', {}, c.remarks), h('td', {}, sign(c))))))
      : h('p', {}, 'Ingen anmerkninger.');
  };

  const draw = () => {
    const full = !only12.checked;
    body.replaceChildren(...[
      h('div', { class: 'rep-title' },
        h('h1', {}, full ? 'Lagringsvedlikehold – ny bil' : 'Lagerbil 12V batteri inspeksjonsskjema'),
        h('div', { class: 'small' }, `Iht. ${r.reference} · ${r.company}`)),
      head(),
      full ? h('h2', {}, '1. Ankomstkontroll') : null,
      full ? arrivalSection() : null,
      full ? h('h2', {}, '2. Periodisk sjekkliste') : null,
      full ? periodicSection() : null,
      h('h2', {}, full ? '3. 12V batteri inspeksjonsskjema' : 'Målinger'),
      batterySection(),
      h('h2', {}, full ? '4. Anmerkninger' : 'Anmerkninger'),
      remarksSection(),
      voided.length ? h('h2', {}, full ? '5. Annullerte kontroller' : 'Annullerte kontroller') : null,
      voided.length ? h('table', { class: 'rep-table' },
        h('thead', {}, h('tr', {}, ['Kontroll', 'Utført', 'Annullert', 'Av', 'Begrunnelse'].map((t) => h('th', {}, t)))),
        h('tbody', {}, voided.map((c) => h('tr', {},
          h('td', {}, c.kind === 'arrival' ? 'Ankomstkontroll' : `${r.level_text[c.level]} sjekk`),
          h('td', {}, `${fmtDate(c.performed_at)} (${sign(c)})`),
          h('td', {}, fmtDate(c.voided_at)),
          h('td', {}, c.voided_by_name ?? ''),
          h('td', {}, c.void_reason ?? ''))))) : null,
      h('div', { class: 'rep-sign' },
        h('div', {}, 'Signatur og stempel'), h('div', {}, 'Dato')),
      h('p', { class: 'rep-foot small' }, `Utskrift fra Carbonara ${fmtDate(new Date())}. Hver kontroll er signert elektronisk med innlogget ansatt og tidspunkt.`),
    ].flat().filter(Boolean));
  };
  only12.addEventListener('change', draw);
  draw();

  append(el,
    h('div', { class: 'page-head no-print' },
      h('div', {}, h('h1', {}, 'Storage report'), h('a', { href: `#/vehicles/${v.id}` }, `← ${vehicleTitle(v)}`)),
      h('div', { class: 'row' },
        h('label', { class: 'check', for: 'only12' }, only12, 'Only 12V battery form'),
        h('button', { class: 'btn primary', type: 'button', onClick: () => window.print() }, '🖨 Print / save as PDF'))),
    body);
}

// Recalls / campaigns (0.41.0, phase 1; server: routers/recalls.py). Carbonara works out when a car needs a
// recall check (after arrival, every n days in storage, when a PDI is booked); staff check in the brand's own
// system ("recall source", Settings → Recall sources) and record the result here.
import { api, busy, fmtDate, h, openDialog, session, showError, toast } from '../ui.js';

const REASON = {
  arrival: 'new in storage',
  pdi: 'PDI booked',
  storage: 'regular check in storage',
  manual: 'checked by hand',
};
const RESULT = { none: 'No open recalls', found: 'Recalls found', error: 'Could not check' };
const STATUS = { open: 'Open', done: 'Done', not_applicable: 'Doesn’t apply' };

/** "⚠ Open recall" badge for car cards and the car page (n = number of open recalls). */
export const recallBadge = (n) => (n > 0
  ? h('span', { class: 'badge bad' }, n === 1 ? '⚠ Open recall' : `⚠ Open recalls: ${n}`) : null);

/** The source's lookup address with the car filled in ({vin}, {reg}). */
const lookupUrl = (s, v) => (s.url || '')
  .replaceAll('{vin}', encodeURIComponent(v.vin || ''))
  .replaceAll('{reg}', encodeURIComponent(v.registration_number || ''));

/** Copy a text; also works on plain http (no clipboard API there). */
async function copy(text, what) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const tmp = h('textarea', { style: { position: 'fixed', opacity: '0' } });
    tmp.value = text;
    document.body.append(tmp);
    tmp.select();
    document.execCommand('copy');
    tmp.remove();
  }
  toast(`${what} copied`, 'success');
}

// ---------------------------------------------------------------- the card on the car page

export function recallsCard(v, data, rerender) {
  if (!data.covered && !data.recalls.length) {
    return h('section', { class: 'card' },
      h('h2', {}, 'Recalls and campaigns'),
      h('p', { class: 'muted small' },
        'No recall source covers this make. An administrator can add one under Settings → Recall sources.'),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', type: 'button', onClick: () => addDialog(v, data, rerender, { asCheck: false }) }, '+ Add recall')));
  }
  const open = data.recalls.filter((r) => r.status === 'open');
  const closed = data.recalls.filter((r) => r.status !== 'open');
  const last = data.last_check;
  return h('section', { class: 'card', id: 'recalls' },
    h('h2', {}, 'Recalls and campaigns'),
    data.due ? h('div', { class: 'notice warn' },
      h('strong', {}, 'Recall check due'), ' · ', h('span', {}, REASON[data.reason] ?? data.reason)) : null,
    // Separate pieces, so each one translates (names and sources are not translated).
    h('p', { class: 'muted small' }, last ? dots(
      h('span', {}, `Last checked ${fmtDate(last.checked_at)}`),
      last.checked_by_name && h('span', { translate: 'no' }, last.checked_by_name),
      last.source_name && h('span', { translate: 'no' }, last.source_name),
      h('strong', {}, RESULT[last.result])) : 'Not checked yet.'),
    open.length ? h('div', { class: 'recall-list' }, open.map((r) => recallRow(r, rerender))) : null,
    h('div', { class: 'actions' },
      h('button', { class: data.due ? 'btn primary' : 'btn', type: 'button', onClick: () => checkDialog(v, data, rerender) },
        '🔍 Check for recalls'),
      h('button', { class: 'btn', type: 'button', onClick: () => addDialog(v, data, rerender, { asCheck: false }) }, '+ Add recall')),
    closed.length ? h('details', { class: 'recall-closed' },
      h('summary', {}, `Closed recalls (${closed.length})`),
      h('div', { class: 'recall-list' }, closed.map((r) => recallRow(r, rerender)))) : null,
    data.checks.length ? h('details', { class: 'recall-closed' },
      h('summary', {}, `Check history (${data.checks.length})`),
      h('ul', { class: 'plain small' }, data.checks.map((c) => h('li', {}, dots(
        h('span', {}, fmtDate(c.checked_at)), h('span', {}, RESULT[c.result]),
        c.source_name && h('span', { translate: 'no' }, c.source_name),
        c.checked_by_name && h('span', { translate: 'no' }, c.checked_by_name),
        c.reason && h('span', {}, REASON[c.reason] ?? c.reason),
        c.note && h('span', { translate: 'no' }, c.note)))))) : null);
}

/** Nodes with " · " between them (empty ones left out). */
function dots(...parts) {
  return parts.filter(Boolean).flatMap((p, i) => (i ? [' · ', p] : [p]));
}

function recallRow(r, rerender) {
  const set = (status, note = null) => async () => {
    try { await api.patch(`/recalls/${r.id}`, { status, note }); await rerender(); } catch (e) { showError(e); }
  };
  const mayDelete = r.created_by === session.me?.id || session.me?.is_admin;
  return h('div', { class: `recall ${r.status}` },
    h('div', { class: 'recall-title' },
      r.code ? h('span', { class: 'mono', translate: 'no' }, r.code) : null,
      h('strong', { translate: 'no' }, r.title),
      r.certainty === 'possible' ? h('span', { class: 'badge warn' }, 'Possible') : null,
      r.status !== 'open' ? h('span', { class: 'badge' }, STATUS[r.status]) : null),
    r.details ? h('div', { class: 'recall-details small', translate: 'no' }, r.details) : null,
    h('div', { class: 'muted small' }, dots(
      h('span', {}, `Added ${fmtDate(r.created_at)}`),
      r.created_by_name && h('span', { translate: 'no' }, r.created_by_name),
      r.source_name && h('span', { translate: 'no' }, r.source_name),
      r.closed_at && [h('span', {}, STATUS[r.status]), ' ', h('span', {}, fmtDate(r.closed_at))],
      r.closed_by_name && h('span', { translate: 'no' }, r.closed_by_name),
      r.close_note && h('span', { translate: 'no' }, r.close_note))),
    h('div', { class: 'recall-actions' },
      r.status === 'open' ? [
        h('button', { class: 'btn small primary', type: 'button', onClick: set('done') }, '✓ Done'),
        h('button', {
          class: 'link small', type: 'button',
          onClick: () => {
            const why = prompt('Why doesn’t it apply to this car?');
            if (why != null) set('not_applicable', why)();
          },
        }, 'Doesn’t apply'),
      ] : h('button', { class: 'link small', type: 'button', onClick: set('open') }, 'Reopen'),
      mayDelete ? h('button', {
        class: 'link small', type: 'button',
        onClick: async () => {
          if (!confirm('Delete this recall? Only for one added by mistake.')) return;
          try { await api.del(`/recalls/${r.id}`); await rerender(); } catch (e) { showError(e); }
        },
      }, 'Delete') : null));
}

// ---------------------------------------------------------------- checking

function sourcePicker(sources) {
  if (sources.length <= 1) return { el: null, value: () => sources[0]?.id ?? null };
  const sel = h('select', {}, sources.map((s) => h('option', { value: s.id }, s.name)));
  return { el: h('div', { class: 'field' }, h('label', {}, 'Checked in'), sel), value: () => Number(sel.value) || null };
}

/** Open the brand's system with the car, then record what it says. */
function checkDialog(v, data, rerender) {
  const picker = sourcePicker(data.sources);
  const note = h('input', { type: 'text', maxlength: 300, placeholder: 'Note (optional)' });
  const none = h('button', { class: 'btn primary', type: 'button' }, '✓ No open recalls');
  const found = h('button', { class: 'btn', type: 'button' }, '⚠ Found recalls');
  const body = h('div', {},
    h('p', { class: 'muted small' }, 'Open the brand’s system, look up the car, and record the result here.'),
    data.sources.map((s) => h('div', { class: 'recall-source' },
      h('strong', { translate: 'no' }, s.name),
      s.note ? h('div', { class: 'muted small', translate: 'no' }, s.note) : null,
      h('div', { class: 'row' },
        // noreferrer: a portal whose login returns to the referring page sent staff back to Carbonara (0.41.1).
        s.url ? h('a', { class: 'btn', href: lookupUrl(s, v), target: '_blank', rel: 'noopener noreferrer' }, `Open ${s.name} ↗`) : null,
        h('button', { class: 'btn', type: 'button', onClick: () => copy(v.vin, 'VIN') }, 'Copy VIN'),
        v.registration_number
          ? h('button', { class: 'btn', type: 'button', onClick: () => copy(v.registration_number, 'Reg. no') }, 'Copy reg. no')
          : null))),
    h('div', { class: 'field' }, h('label', {}, 'VIN'), h('div', { class: 'mono', translate: 'no' }, v.vin)),
    picker.el,
    h('div', { class: 'field' }, h('label', {}, 'Note'), note),
    h('div', { class: 'actions' }, found, none));
  const { close } = openDialog('Check for recalls', body);
  none.addEventListener('click', () => busy(none, async () => {
    await api.post(`/vehicles/${v.id}/recall-checks`, { source_id: picker.value(), result: 'none', note: note.value || null });
    close();
    toast('Recall check saved', 'success');
    await rerender();
  }));
  found.addEventListener('click', () => { close(); addDialog(v, data, rerender, { asCheck: true, sourceId: picker.value() }); });
}

/** Add a recall (found in a check, or e.g. from a letter from the importer). */
function addDialog(v, data, rerender, { asCheck, sourceId = null }) {
  const picker = sourcePicker(data.sources);
  if (picker.el && sourceId) picker.el.querySelector('select').value = String(sourceId);
  const code = h('input', { type: 'text', maxlength: 60, placeholder: 'e.g. campaign number', spellcheck: 'false' });
  const title = h('input', { type: 'text', maxlength: 200, required: true, placeholder: 'What it is about' });
  const details = h('textarea', { rows: 3, maxlength: 2000, placeholder: 'Fault and fix (optional)' });
  const save = h('button', { class: 'btn primary', type: 'submit' }, 'Save recall');
  const again = h('button', { class: 'btn', type: 'button' }, 'Save and add another');
  const form = h('form', {},
    asCheck ? h('p', { class: 'muted small' }, 'Add each recall the brand’s system shows for this car.') : null,
    h('div', { class: 'field' }, h('label', {}, 'Campaign / recall code'), code),
    h('div', { class: 'field' }, h('label', {}, 'Title *'), title),
    h('div', { class: 'field' }, h('label', {}, 'Details'), details),
    picker.el,
    h('div', { class: 'actions' }, again, save));
  let first = true; // only the first one counts as the car's check
  let finished = false;
  const submit = (button, more) => busy(button, async () => {
    if (!title.value.trim()) { title.focus(); return; }
    await api.post(`/vehicles/${v.id}/recalls`, {
      source_id: picker.value(), code: code.value || null, title: title.value, details: details.value || null,
      as_check: asCheck && first,
    });
    first = false;
    toast('Recall saved', 'success');
    if (more) { code.value = ''; title.value = ''; details.value = ''; code.focus(); return; }
    finished = true;
    close();
    await rerender();
  });
  const { close } = openDialog(asCheck ? 'Recalls found' : 'Add recall', form);
  form.addEventListener('submit', (e) => { e.preventDefault(); submit(save, false); });
  again.addEventListener('click', () => submit(again, true));
  // Closed with ✕ after "Save and add another": show what was saved.
  form.closest('dialog')?.addEventListener('close', () => { if (!first && !finished) rerender(); });
}

// ---------------------------------------------------------------- Settings → Recall sources

export async function renderRecallSources(box) {
  const sources = await api.get('/recall-sources?include_inactive=true');
  const admin = !!session.me?.is_admin;
  const redraw = () => renderRecallSources(box).catch(showError);
  box.replaceChildren(h('section', { class: 'card' },
    h('h2', {}, 'Recall sources'),
    h('p', { class: 'muted small' },
      'Where cars are checked for recalls, e.g. each brand’s dealer system. Cars whose make is listed get a recall check '
      + 'after the arrival inspection, when a PDI is booked and regularly in storage (System page). '
      + 'In the address, {vin} and {reg} are replaced with the car’s VIN and reg. no.'),
    sources.length
      ? h('ul', { class: 'plain rows list-edit' }, sources.map((s) => h('li', { class: s.active ? '' : 'inactive' },
        h('span', {},
          h('strong', { translate: 'no' }, s.name),
          h('span', { class: 'muted small block', translate: 'no' }, s.makes.length ? s.makes.join(', ') : 'All makes'),
          s.url ? h('span', { class: 'muted small block mono', translate: 'no' }, s.url) : null,
          s.note ? h('span', { class: 'muted small block', translate: 'no' }, s.note) : null),
        admin ? h('span', { class: 'row-actions' },
          h('button', { class: 'link', type: 'button', onClick: () => sourceDialog(s, redraw) }, 'Edit'),
          h('button', {
            class: 'link', type: 'button',
            onClick: async () => {
              try { await api.patch(`/recall-sources/${s.id}`, { active: !s.active }); await redraw(); } catch (e) { showError(e); }
            },
          }, s.active ? 'Remove' : 'Restore')) : null)))
      : h('p', { class: 'empty' }, 'No recall sources yet.'),
    admin ? h('div', { class: 'actions' },
      h('button', { class: 'btn primary', type: 'button', onClick: () => sourceDialog(null, redraw) }, '+ Add recall source'))
      : h('p', { class: 'muted small' }, 'Only an administrator can change this list.')));
}

function sourceDialog(s, done) {
  const name = h('input', { type: 'text', maxlength: 60, required: true, placeholder: 'e.g. the brand’s dealer system' });
  const makes = h('input', { type: 'text', maxlength: 300, placeholder: 'Makes, separated by commas', spellcheck: 'false' });
  const url = h('input', { type: 'url', maxlength: 500, placeholder: 'https://…', spellcheck: 'false' });
  const note = h('input', { type: 'text', maxlength: 300, placeholder: 'e.g. log in with your own dealer account' });
  name.value = s?.name || '';
  makes.value = (s?.makes || []).join(', ');
  url.value = s?.url || '';
  note.value = s?.note || '';
  const save = h('button', { class: 'btn primary', type: 'submit' }, 'Save');
  const form = h('form', {},
    h('div', { class: 'field' }, h('label', {}, 'Name *'), name),
    h('div', { class: 'field' }, h('label', {}, 'Car makes'), makes,
      h('div', { class: 'muted small' }, 'As they appear on the cars. Empty = every car.')),
    h('div', { class: 'field' }, h('label', {}, 'Address of the lookup page'), url,
      h('div', { class: 'muted small' }, '{vin} and {reg} are replaced with the car’s VIN and reg. no, if the page takes them in the address.')),
    h('div', { class: 'field' }, h('label', {}, 'Note for staff'), note),
    h('div', { class: 'actions' }, save));
  const { close } = openDialog(s ? 'Edit recall source' : 'Add recall source', form);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(save, async () => {
      const body = { name: name.value, makes: makes.value, url: url.value || null, note: note.value || null };
      if (s) await api.patch(`/recall-sources/${s.id}`, body); else await api.post('/recall-sources', body);
      close();
      toast('Recall source saved', 'success');
      await done();
    });
  });
}

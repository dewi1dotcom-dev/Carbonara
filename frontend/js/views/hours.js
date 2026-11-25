// Work hours (0.49.0): the ⏱ button (start / end my day, the running work order clock) and the admins' #/hours page.
// Everyone starts and ends their own day; only admins see the hours (list, corrections, CSV export).
// Breaks (System page → Work hours) are taken off the worked time on the server (worktime.py). Server: routers/hours.py.
import { api, append, busy, canSee, dateInput, h, openDialog, osloTodayIso, session, showError, timeInput, toast } from '../ui.js';

/** 8100 → "2 h 15 min", 2700 → "45 min". */
export function fmtDuration(seconds) {
  const m = Math.round((Number(seconds) || 0) / 60);
  if (m < 60) return `${m} min`;
  const rest = m % 60;
  return rest ? `${Math.floor(m / 60)} h ${String(rest).padStart(2, '0')} min` : `${m / 60} h`;
}

/** "2026-11-25T11:30" (local Oslo time from the server) → "25.11.2026 11:30" (no time zone shift). */
export function fmtLocal(s, withDate = true) {
  if (!s) return '–';
  const [d, t] = s.split('T');
  const [y, mo, dd] = d.split('-');
  return withDate ? `${dd}.${mo}.${y} ${t.slice(0, 5)}` : t.slice(0, 5);
}

const hhmm = (s) => (s ? s.split('T')[1].slice(0, 5) : '');
const changed = () => window.dispatchEvent(new Event('carbonara:clock-changed'));

// ---------------------------------------------------------------- ⏱ in the top bar

/** The ⏱ panel: my day and my running clock. */
export async function clockPanel() {
  let st;
  try { st = await api.get('/hours/me'); } catch (e) { showError(e); return; }
  const body = h('div');
  const { close } = openDialog('Work hours', body);
  const act = (label, cls, path) => {
    const b = h('button', { class: cls, type: 'button' }, label);
    b.addEventListener('click', () => busy(b, async () => {
      st = await api.post(path);
      changed();
      draw();
    }));
    return b;
  };
  const draw = () => {
    const day = st.day;
    const r = st.running;
    body.replaceChildren(...[
      !st.enabled ? h('div', { class: 'notice' }, 'Work hours are switched off (System page).') : null,
      st.enabled ? h('section', { class: 'clock-box' },
        h('h3', {}, 'My working day'),
        !day ? h('p', { class: 'muted' }, 'Not started today.')
          : day.end ? h('p', {}, h('span', {}, 'Started'), ` ${hhmm(day.start)} · `, h('span', {}, 'ended'), ` ${hhmm(day.end)}`)
            : h('p', {}, h('span', {}, 'Started at'), ` ${hhmm(day.start)}`),
        day?.breaks?.length ? h('p', { class: 'muted small' }, h('span', {}, 'Breaks today:'), ` ${day.breaks.join(', ')}`) : null,
        h('div', { class: 'actions left' },
          !day ? act('▶ Start my day', 'btn primary', '/hours/day/start')
            : day.end ? act('▶ Start again', 'btn', '/hours/day/start')
              : act('■ End my day', 'btn danger', '/hours/day/end'))) : null,
      h('section', { class: 'clock-box' },
        h('h3', {}, 'Work order clock'),
        r ? h('p', {},
          h('a', { href: `#/work-orders/${r.work_order_id}`, onClick: () => close() }, `#${r.number}`), ' ',
          h('span', { translate: 'no' }, [r.title, [r.make, r.model].filter(Boolean).join(' '), r.registration_number].filter(Boolean).join(' · ')),
          h('span', { class: 'muted small block' }, h('span', {}, 'Running since'), ` ${hhmm(r.start)}`))
          : h('p', { class: 'muted' }, 'No clock running. Start it on a work order.'),
        r ? h('div', { class: 'actions left' }, act('■ Stop clock', 'btn', '/hours/clock/stop')) : null),
      h('div', { class: 'actions left' },
        canSee('work_orders') ? h('a', { class: 'btn', href: '#/work-orders', onClick: () => close() }, 'Work orders') : null,
        session.me?.is_admin ? h('a', { class: 'btn', href: '#/hours', onClick: () => close() }, 'All work hours') : null),
    ].filter(Boolean));
  };
  draw();
}

// ---------------------------------------------------------------- #/hours (admins)

const addDays = (iso, n) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const mondayOf = (iso) => {
  const d = new Date(`${iso}T12:00:00Z`);
  return addDays(iso, -((d.getUTCDay() + 6) % 7));
};
const isoNo = (iso) => iso.split('-').reverse().join('.');

export async function hoursView(el, _params, host = el) {
  if (!session.me?.is_admin) {
    append(el, h('h1', {}, 'Work hours'), h('div', { class: 'card notice warn' }, 'Only an administrator can see the work hours.'));
    return;
  }
  const saved = new URLSearchParams(location.hash.split('?')[1] || '');
  const start = saved.get('start') || mondayOf(osloTodayIso());
  const end = saved.get('end') || addDays(start, 6);
  const who = saved.get('staff') || '';
  const data = await api.get(`/hours?start=${start}&end=${end}${who ? `&staff_id=${who}` : ''}`);
  const go = (s, e, p = who) => {
    const q = new URLSearchParams({ start: s, end: e, ...(p ? { staff: p } : {}) }).toString();
    location.hash = `#/hours?${q}`;
  };
  const rerender = async () => {
    try {
      const fresh = h('div');
      await hoursView(fresh, [], host);
      host.replaceChildren(...fresh.childNodes);
    } catch (e) { showError(e); }
  };
  const from = dateInput({ value: data.start });
  const to = dateInput({ value: data.end });
  const person = h('select', { 'aria-label': 'Person' }, h('option', { value: '' }, 'Everyone'),
    data.staff.map((s) => h('option', { value: s.id, selected: String(s.id) === who, translate: 'no' }, s.name)));
  from.addEventListener('change', () => from.value && go(from.value, to.value || from.value));
  to.addEventListener('change', () => to.value && go(from.value || to.value, to.value));
  person.addEventListener('change', () => go(data.start, data.end, person.value));
  const days = (Date.parse(data.end) - Date.parse(data.start)) / 86400000 + 1;
  const exportHref = `/api/hours/export?start=${data.start}&end=${data.end}${who ? `&staff_id=${who}` : ''}`;

  append(el,
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', {}, 'Work hours'),
        h('div', { class: 'muted' }, 'Start and end of each person’s day and the time on work orders. Breaks are taken off. Only administrators see this page.')),
      h('div', { class: 'row-actions' },
        h('a', { class: 'btn', href: exportHref }, '⬇ Export (CSV)'),
        h('button', { class: 'btn primary', type: 'button', onClick: () => dayDialog(null, data, rerender) }, '+ Add a day'))),
    !data.enabled ? h('div', { class: 'card notice' }, 'Work hours are switched off on the System page: nobody can start their day now.') : null,
    h('div', { class: 'toolbar hours-toolbar' },
      h('button', { class: 'btn', type: 'button', onClick: () => go(addDays(data.start, -days), addDays(data.end, -days)) }, '◀'),
      from, h('span', {}, '–'), to,
      h('button', { class: 'btn', type: 'button', onClick: () => go(addDays(data.start, days), addDays(data.end, days)) }, '▶'),
      h('button', { class: 'link', type: 'button', onClick: () => { const m = mondayOf(osloTodayIso()); go(m, addDays(m, 6)); } }, 'This week'),
      person),
    h('p', { class: 'muted small' }, h('span', {}, 'Breaks (System page):'), ` ${data.default_breaks.join(', ') || '–'}`),
    data.people.length ? data.people.map((p) => personCard(p, data, rerender))
      : h('p', { class: 'empty' }, `No hours ${isoNo(data.start)} – ${isoNo(data.end)}.`));
}

function personCard(p, data, rerender) {
  const rows = p.days.map((d) => [
    h('tr', { class: d.end || !d.start ? '' : 'open-day' },
      h('td', { class: 'nowrap' }, isoNo(String(d.day))),
      h('td', {}, d.start ? hhmm(d.start) : h('span', { class: 'muted' }, '–')),
      h('td', {}, d.end ? hhmm(d.end) : d.start ? h('span', { class: 'badge warn' }, 'Not ended') : '–'),
      h('td', { class: 'small' }, d.breaks.join(', ') || '–'),
      h('td', { class: 'num' }, d.start ? fmtDuration(d.worked_seconds) : '–'),
      h('td', { class: 'num' }, d.order_seconds ? fmtDuration(d.order_seconds) : '–'),
      h('td', { class: 'no-print nowrap' },
        d.id ? h('button', { class: 'link small', type: 'button', onClick: () => dayDialog({ ...d, staff_id: p.staff_id, name: p.name }, data, rerender) }, 'change')
          : h('button', { class: 'link small', type: 'button', onClick: () => dayDialog({ new_for: p.staff_id, day: String(d.day) }, data, rerender) }, '+ day'))),
    d.note ? h('tr', { class: 'sub-row' }, h('td'), h('td', { colspan: 6, class: 'muted small pre-line', translate: 'no' }, d.note)) : null,
    ...d.entries.map((t) => h('tr', { class: 'sub-row' },
      h('td'),
      h('td', { colspan: 3, class: 'small' },
        h('a', { href: `#/work-orders/${t.work_order_id}` }, `#${t.number}`), ' ',
        t.title ? h('span', { translate: 'no' }, t.title) : null, ' ',
        h('span', { class: 'muted' }, `${hhmm(t.start)}–${t.end ? hhmm(t.end) : ''}`),
        t.running ? [' ', h('span', { class: 'badge good' }, 'Running')] : null),
      h('td'),
      h('td', { class: 'num small' }, fmtDuration(t.seconds)),
      h('td', { class: 'no-print' }, t.running ? null
        : h('button', { class: 'link small', type: 'button', onClick: () => entryDialog({ ...t, staff_id: p.staff_id }, rerender) }, 'change')))),
  ]);
  return h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', { translate: 'no' }, p.name),
      h('span', { class: 'muted' }, h('span', {}, 'Worked:'), ` ${fmtDuration(p.worked_seconds)} · `,
        h('span', {}, 'on work orders:'), ` ${fmtDuration(p.order_seconds)}`)),
    h('div', { class: 'table-wrap' }, h('table', { class: 'price-table hours-table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Date'), h('th', {}, 'Start'), h('th', {}, 'End'), h('th', {}, 'Breaks'),
        h('th', { class: 'num' }, 'Worked'), h('th', { class: 'num' }, 'Work orders'), h('th', { class: 'no-print' }))),
      h('tbody', {}, rows.flat().filter(Boolean)))));
}

const fieldEl = (label, input, hint) => h('div', { class: 'field' }, h('label', {}, label), input,
  hint ? h('div', { class: 'muted small' }, hint) : null);

/** Add or change one person's day: start, end, that day's breaks, note. */
function dayDialog(d, data, done) {
  const isNew = !d?.id;
  const person = isNew ? h('select', {}, data.staff.map((s) => h('option', {
    value: s.id, selected: String(s.id) === String(d?.new_for ?? ''), translate: 'no',
  }, s.name))) : null;
  const day = isNew ? dateInput({ value: d?.day || osloTodayIso(), required: true }) : null;
  const start = timeInput({ value: d?.start ? hhmm(d.start) : '', required: true });
  const end = timeInput({ value: d?.end ? hhmm(d.end) : '' });
  const breaks = h('input', { type: 'text', autocomplete: 'off', value: (d?.breaks ?? data.default_breaks).join(', '), placeholder: '11:30-12:00, 14:00-14:15' });
  const note = h('textarea', { rows: 2, maxlength: 500 }, d?.note || '');
  const ok = h('button', { class: 'btn primary', type: 'submit' }, 'Save');
  const del = isNew ? null : h('button', { class: 'link danger', type: 'button' }, 'Delete the day');
  const form = h('form', {},
    !isNew ? h('p', {}, h('strong', { translate: 'no' }, d.name), ` · ${isoNo(String(d.day))}`) : null,
    isNew ? h('div', { class: 'grid' }, fieldEl('Person', person), fieldEl('Date', day)) : null,
    h('div', { class: 'grid' }, fieldEl('Start *', start), fieldEl('End', end, 'Empty = not ended. An end before the start is the next day.')),
    fieldEl('Breaks this day', breaks, 'e.g. 11:30-12:00, 14:00-14:15. Empty = no breaks.'),
    fieldEl('Note', note),
    h('div', { class: 'actions spread' }, del || h('span'), ok));
  const payload = () => ({
    start: start.value, end: end.value || null, note: note.value.trim() || null,
    breaks: breaks.value.split(',').map((s) => s.trim()).filter(Boolean),
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!start.value) { toast('Enter the start time', 'error'); return; }
    busy(ok, async () => {
      if (isNew) await api.post('/hours/days', { ...payload(), staff_id: Number(person.value), day: day.value });
      else await api.put(`/hours/days/${d.id}`, { ...payload(), day: String(d.day) });
      close();
      toast('Saved', 'success');
      await done();
    });
  });
  del?.addEventListener('click', () => busy(del, async () => {
    if (!confirm('Delete this day? The time on work orders is kept.')) return;
    await api.del(`/hours/days/${d.id}`);
    close();
    await done();
  }));
  const { close } = openDialog(isNew ? 'Add a day' : 'Change the day', form);
}

/** Add or change time on a work order (admins). `t.number` + `t.staff_id` for a new entry from a work order page. */
export function entryDialog(t, done, { staff = null } = {}) {
  const isNew = !t.id;
  const person = isNew && staff ? h('select', {}, staff.map((s) => h('option', { value: s.id, translate: 'no' }, s.name))) : null;
  const day = dateInput({ value: t.start ? t.start.slice(0, 10) : osloTodayIso(), required: true });
  const start = timeInput({ value: t.start ? hhmm(t.start) : '', required: true });
  const end = timeInput({ value: t.end ? hhmm(t.end) : '', required: true });
  const note = h('input', { type: 'text', maxlength: 500, autocomplete: 'off', value: t.note || '' });
  const ok = h('button', { class: 'btn primary', type: 'submit' }, 'Save');
  const del = isNew ? null : h('button', { class: 'link danger', type: 'button' }, 'Delete');
  const form = h('form', {},
    h('p', {}, h('strong', {}, `#${t.number}`), t.staff_name ? [' · ', h('span', { translate: 'no' }, t.staff_name)] : null),
    person ? fieldEl('Person', person) : null,
    h('div', { class: 'grid' }, fieldEl('Date', day), fieldEl('Start *', start), fieldEl('End *', end)),
    fieldEl('Note', note),
    h('p', { class: 'muted small' }, 'Breaks inside the time are taken off.'),
    h('div', { class: 'actions spread' }, del || h('span'), ok));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!start.value || !end.value || !day.value) { toast('Enter the date, start and end', 'error'); return; }
    busy(ok, async () => {
      const body = { day: day.value, start: start.value, end: end.value, note: note.value.trim() || null };
      if (isNew) await api.post('/hours/entries', { ...body, work_order_number: t.number, staff_id: Number(person?.value || t.staff_id) });
      else await api.put(`/hours/entries/${t.id}`, body);
      close();
      toast('Saved', 'success');
      await done();
    });
  });
  del?.addEventListener('click', () => busy(del, async () => {
    if (!confirm('Delete this time?')) return;
    await api.del(`/hours/entries/${t.id}`);
    close();
    await done();
  }));
  const { close } = openDialog(isNew ? 'Add time' : 'Change time', form);
}

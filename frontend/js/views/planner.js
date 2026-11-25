// Planner (0.51.0): one calendar per team. A line per person; their work orders laid out over the working day, one after
// another, with breaks (hatched) and absences. Drag a job to move it (time and person), drag its right edge to change
// the estimate, drag a job from "Not planned" onto a line, or tap an empty spot. Everyone in the team can change it.
// Server: routers/planner.py; jobs are saved through PATCH /work-orders/{id}.
import { api, append, busy, dateInput, fmtDate, h, openDialog, osloTodayIso, session, showError, timeInput, toast } from '../ui.js';
import { fmtDuration } from './hours.js';
import { newWorkOrderDialog, woBadge } from './workorders.js';

const PX = 1.6;          // pixels per minute (96 px an hour)
const GAP = 14;          // between days
const SNAP = 15;         // minutes
const ABSENCE = { holiday: 'Holiday', away: 'Away', course: 'Course', other: 'Other' };
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const pad = (n) => String(n).padStart(2, '0');
const hhmm = (min) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
const isoNo = (iso) => iso.split('-').reverse().join('.');
const addDays = (iso, n) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const weekday = (iso) => new Date(`${iso}T12:00:00Z`).getUTCDay();
/** "2026-11-25T11:30" → minutes after midnight. */
const minOf = (local) => Number(local.slice(11, 13)) * 60 + Number(local.slice(14, 16));
const hoursNo = (sec) => String(Math.round((sec / 3600) * 10) / 10).replace('.', ',');

export async function plannerView(el, _params, host = el) {
  const saved = new URLSearchParams(location.hash.split('?')[1] || '');
  const teams = await api.get('/planner/teams');
  if (!teams.length) {
    append(el, h('h1', {}, 'Planner'),
      h('div', { class: 'card notice warn' }, 'You are not in a team. A system admin puts people in teams on the System page.'));
    return;
  }
  const teamId = Number(saved.get('team')) || (teams.find((t) => t.id === session.me?.team_id) || teams[0]).id;
  const days = Number(saved.get('days')) || 1;
  let start = saved.get('start') || osloTodayIso();
  if (days >= 5) start = addDays(start, -((weekday(start) + 6) % 7)); // the week view starts on Monday
  const data = await api.get(`/planner?team_id=${teamId}&start=${start}&days=${days}`);

  const go = (changes) => {
    const q = new URLSearchParams({ team: teamId, start, days, ...changes });
    location.hash = `#/planner?${q}`;
  };
  const rerender = async () => {
    try {
      const fresh = h('div');
      await plannerView(fresh, [], host);
      host.replaceChildren(...fresh.childNodes);
    } catch (e) { showError(e); }
  };

  const teamSel = h('select', { 'aria-label': 'Team' }, teams.map((t) => h('option', { value: t.id, selected: t.id === teamId, translate: 'no' }, t.name)));
  teamSel.addEventListener('change', () => go({ team: teamSel.value }));
  const daySel = h('select', { 'aria-label': 'Days' },
    [[1, 'One day'], [3, 'Three days'], [7, 'One week']].map(([v, t]) => h('option', { value: v, selected: v === days }, t)));
  daySel.addEventListener('change', () => go({ days: daySel.value }));
  const dateIn = dateInput({ value: start });
  dateIn.addEventListener('change', () => dateIn.value && go({ start: dateIn.value }));
  const step = days >= 7 ? 7 : days;

  append(el,
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', {}, 'Planner'),
        h('div', { class: 'muted' }, 'Drag a job to move it, drag its right edge to change the time it takes, or tap an empty spot.')),
      h('div', { class: 'row-actions' },
        h('button', { class: 'btn', type: 'button', onClick: () => linesDialog(data, rerender) }, 'Lines'),
        h('button', { class: 'btn', type: 'button', onClick: () => absenceDialog(null, data, rerender) }, '+ Absence'))),
    h('div', { class: 'toolbar planner-toolbar' },
      teams.length > 1 ? teamSel : h('strong', { translate: 'no' }, data.team.name),
      h('button', { class: 'btn', type: 'button', 'aria-label': 'Earlier', onClick: () => go({ start: addDays(start, -step) }) }, '◀'),
      dateIn,
      h('button', { class: 'btn', type: 'button', 'aria-label': 'Later', onClick: () => go({ start: addDays(start, step) }) }, '▶'),
      h('button', { class: 'link', type: 'button', onClick: () => go({ start: osloTodayIso() }) }, 'Today'),
      daySel),
    data.rows.length ? board(data, rerender) : h('div', { class: 'card notice' }, 'No lines yet. Use "Lines" to add people.'),
    unplannedCard(data, rerender));
}

// ---------------------------------------------------------------- the board

function board(data, rerender) {
  const [ws, we] = data.window;
  const dayW = (we - ws) * PX;
  const days = data.days.map(String);
  const width = days.length * dayW + (days.length - 1) * GAP;
  const xOf = (local) => {
    const i = days.indexOf(local.slice(0, 10));
    const m = Math.min(Math.max(minOf(local), ws), we);
    return i < 0 ? null : i * (dayW + GAP) + (m - ws) * PX;
  };
  /** x in a lane → { day, minutes } snapped to 15 minutes (null in the gap between days). */
  const timeAt = (x) => {
    const i = Math.floor(x / (dayW + GAP));
    if (i < 0 || i >= days.length) return null;
    const within = x - i * (dayW + GAP);
    if (within > dayW) return null;
    const m = Math.round((ws + within / PX) / SNAP) * SNAP;
    return { day: days[i], min: Math.min(Math.max(m, ws), we - SNAP) };
  };

  // Header: the days and the hours.
  const head = h('div', { class: 'pl-head', style: `width:${width}px` },
    days.map((d, i) => {
      const left = i * (dayW + GAP);
      const ticks = [];
      for (let m = Math.ceil(ws / 60) * 60; m < we; m += 60) {
        ticks.push(h('span', { class: 'pl-tick', style: `left:${(m - ws) * PX}px` }, pad(m / 60)));
      }
      const today = d === String(data.today);
      return h('div', { class: `pl-day-head${today ? ' today' : ''}`, style: `left:${left}px;width:${dayW}px` },
        h('div', { class: 'pl-day-title' }, h('span', {}, DAY_NAMES[weekday(d)]), ` ${isoNo(d)}`),
        h('div', { class: 'pl-ticks' }, ticks));
    }));

  const breakStripes = () => days.flatMap((d, i) => (weekday(d) % 6 === 0 ? [h('div', {
    class: 'pl-weekend', style: `left:${i * (dayW + GAP)}px;width:${dayW}px`,
  })] : data.breaks.map((b) => {
    const [a, z] = b.split('-').map((t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)));
    if (z <= ws || a >= we) return null;
    const l = i * (dayW + GAP) + (Math.max(a, ws) - ws) * PX;
    return h('div', { class: 'pl-break', style: `left:${l}px;width:${(Math.min(z, we) - Math.max(a, ws)) * PX}px` });
  }).filter(Boolean)));

  // "Now" line.
  const now = new Date();
  const nowLocal = `${osloTodayIso()}T${new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Oslo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now)}`;
  const nowX = days.includes(nowLocal.slice(0, 10)) && minOf(nowLocal) >= ws && minOf(nowLocal) <= we ? xOf(nowLocal) : null;

  const lanes = data.rows.map((r) => {
    // Pieces: a job is drawn per day from its first to its last piece of working time that day.
    const pieces = [];
    data.orders.filter((o) => o.assigned_to === r.staff_id).forEach((o) => {
      const byDay = {};
      o.segments.forEach(([s, e]) => { const d = s.slice(0, 10); (byDay[d] ||= []).push([s, e]); });
      const keys = Object.keys(byDay).sort();
      keys.forEach((d, k) => {
        const segs = byDay[d];
        const x1 = xOf(segs[0][0]);
        const x2 = xOf(segs[segs.length - 1][1]);
        if (x1 == null || x2 == null) return;
        pieces.push({ o, x1, x2: Math.max(x2, x1 + 12), first: segs[0][0] === o.planned_local, last: segs[segs.length - 1][1] === o.end_local, cont: k > 0 });
      });
    });
    const absences = [];
    data.absences.filter((a) => a.staff_id === r.staff_id).forEach((a) => {
      days.forEach((d) => {
        const s = a.start > `${d}T${hhmm(ws)}` ? a.start : `${d}T${hhmm(ws)}`;
        const e = a.end < `${d}T${hhmm(we)}` ? a.end : `${d}T${hhmm(we)}`;
        if (s < e) absences.push({ a, x1: xOf(s), x2: xOf(e) });
      });
    });
    // Jobs that overlap on one line are stacked.
    pieces.sort((p, q) => p.x1 - q.x1);
    const ends = [];
    pieces.forEach((p) => {
      let i = ends.findIndex((x) => x <= p.x1 + 1);
      if (i < 0) { i = ends.length; ends.push(0); }
      ends[i] = p.x2;
      p.row = i;
    });
    const stack = Math.max(1, ends.length);
    const laneH = 18 + stack * 46;
    const lane = h('div', { class: 'pl-lane', style: `width:${width}px;height:${laneH}px`, 'data-staff': r.staff_id },
      breakStripes(),
      absences.map(({ a, x1, x2 }) => h('button', {
        class: `pl-absence abs-${a.kind}`, type: 'button', style: `left:${x1}px;width:${Math.max(x2 - x1, 8)}px`,
        title: a.note || '', onClick: (e) => { e.stopPropagation(); absenceDialog(a, data, rerender); },
      }, h('span', {}, ABSENCE[a.kind]), a.note ? h('span', { class: 'pl-abs-note', translate: 'no' }, ` · ${a.note}`) : null)),
      pieces.map((p) => jobBar(p, data, rerender, { timeAt })),
      nowX != null ? h('div', { class: 'pl-now', style: `left:${nowX}px` }) : null);
    lane.addEventListener('click', (e) => {
      if (e.target !== lane && !e.target.classList.contains('pl-break')) return;
      const rect = lane.getBoundingClientRect();
      const t = timeAt(e.clientX - rect.left);
      if (t) slotDialog(r, t, data, rerender);
    });
    const cap = days.reduce((acc, d) => {
      const c = data.capacity[`${r.staff_id}:${d}`] || { available: 0, planned: 0 };
      return { available: acc.available + c.available, planned: acc.planned + c.planned };
    }, { available: 0, planned: 0 });
    const full = cap.available && cap.planned > cap.available;
    const name = h('div', { class: 'pl-name', style: `height:${laneH}px` },
      h('strong', { translate: 'no' }, r.name),
      h('span', { class: `small ${full ? 'bad-text' : 'muted'}` }, `${hoursNo(cap.planned)} / ${hoursNo(cap.available)} h`));
    return { name, lane };
  });

  return h('section', { class: 'card planner' },
    h('div', { class: 'pl-wrap' },
      h('div', { class: 'pl-names' }, h('div', { class: 'pl-corner' }), lanes.map((l) => l.name)),
      h('div', { class: 'pl-scroll' }, head, lanes.map((l) => l.lane))),
    h('p', { class: 'muted small' }, h('span', {}, 'Planned / available hours on the days shown.'), ' ',
      h('span', { class: 'pl-key pl-key-break' }), ' ', h('span', {}, 'Break')));
}

/** One job on a line: drag to move (time + person), drag the right edge to change the estimate, tap to open. */
function jobBar(p, data, rerender, { timeAt }) {
  const o = p.o;
  const label = [o.registration_number, o.title || o.customer_name].filter(Boolean).join(' · ');
  const handle = p.last ? h('span', { class: 'pl-resize', title: 'Drag to change the time it takes' }) : null;
  const bar = h('div', {
    class: `pl-job st-${o.status}${o.pdi_order_id ? ' pdi' : ''}${p.cont ? ' cont' : ''}${o.arrived_at ? ' arrived' : ''}`,
    style: `left:${p.x1}px;width:${p.x2 - p.x1}px;top:${9 + p.row * 46}px`,
    title: `#${o.number} ${label}`,
  },
  h('span', { class: 'pl-job-no' }, `#${o.number}`), ' ',
  h('span', { class: 'pl-job-text', translate: 'no' }, label),
  o.task_count ? h('span', { class: 'pl-job-meta' }, `${o.tasks_done}/${o.task_count}`) : null,
  Number(o.clocks_running) > 0 ? h('span', { class: 'pl-job-meta' }, '⏱') : null,
  o.arrived_at ? h('span', { class: 'pl-job-meta pl-arrived', title: 'The car has arrived' }, '🔑') : null,
  handle);

  if (!data.can_edit) {
    bar.addEventListener('click', () => jobDialog(o, data, rerender));
    return bar;
  }
  let drag = null;
  const startDrag = (e, mode) => {
    e.preventDefault();
    e.stopPropagation();
    bar.setPointerCapture(e.pointerId);
    drag = { mode, x0: e.clientX, y0: e.clientY, moved: false, left: p.x1, width: p.x2 - p.x1 };
  };
  bar.addEventListener('pointerdown', (e) => startDrag(e, e.target === handle ? 'resize' : 'move'));
  bar.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x0;
    const dy = e.clientY - drag.y0;
    if (!drag.moved && Math.hypot(dx, dy) < 6) return;
    drag.moved = true;
    bar.classList.add('dragging');
    if (drag.mode === 'resize') bar.style.width = `${Math.max(24, drag.width + dx)}px`;
    else bar.style.transform = `translate(${dx}px, ${dy}px)`;
  });
  const finish = async (e) => {
    if (!drag) return;
    const d = drag;
    drag = null;
    bar.classList.remove('dragging');
    if (!d.moved) { jobDialog(o, data, rerender); return; }
    const dx = e.clientX - d.x0;
    try {
      if (d.mode === 'resize') {
        const minutes = Math.max(SNAP, Math.round(((o.estimated_minutes || 60) + dx / PX) / SNAP) * SNAP);
        await api.patch(`/work-orders/${o.id}`, { estimated_minutes: minutes });
      } else {
        bar.style.visibility = 'hidden';
        const under = document.elementFromPoint(e.clientX, e.clientY)?.closest('.pl-lane');
        bar.style.visibility = '';
        if (!under) { bar.style.transform = ''; return; }
        const t = timeAt(d.left + dx);
        if (!t) { bar.style.transform = ''; toast('Drop the job inside a working day', 'error'); return; }
        await api.patch(`/work-orders/${o.id}`, { planned_at: `${t.day}T${hhmm(t.min)}`, assigned_to: Number(under.dataset.staff) });
      }
      await rerender();
    } catch (err) { bar.style.transform = ''; bar.style.width = ''; showError(err); }
  };
  bar.addEventListener('pointerup', finish);
  bar.addEventListener('pointercancel', () => { drag = null; bar.style.transform = ''; bar.style.width = ''; bar.classList.remove('dragging'); });
  return bar;
}

// ---------------------------------------------------------------- not planned

function unplannedCard(data, rerender) {
  const list = data.unplanned;
  return h('section', { class: 'card' },
    h('h2', {}, `Not planned (${list.length})`),
    h('p', { class: 'muted small' }, 'Work orders that are not done, without a time or a person on this planner. Drag one onto a line, or tap it.'),
    list.length ? h('div', { class: 'pl-unplanned' }, list.map((o) => unplannedItem(o, data, rerender)))
      : h('p', { class: 'empty' }, 'Everything is planned.'));
}

function unplannedItem(o, data, rerender) {
  const item = h('div', { class: 'pl-un-item', tabindex: '0' },
    h('strong', {}, `#${o.number}`), ' ',
    h('span', { translate: 'no' }, [o.registration_number, o.title || o.customer_name].filter(Boolean).join(' · ')),
    h('span', { class: 'muted small block' }, o.estimated_minutes ? fmtDuration(o.estimated_minutes * 60) : h('span', {}, 'No estimate'),
      o.assigned_to ? '' : [' · ', h('span', {}, 'No mechanic')]));
  if (!data.can_edit) return item;
  let drag = null;
  item.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    item.setPointerCapture(e.pointerId);
    drag = { x0: e.clientX, y0: e.clientY, ghost: null };
  });
  item.addEventListener('pointermove', (e) => {
    if (!drag) return;
    if (!drag.ghost && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 6) return;
    if (!drag.ghost) {
      drag.ghost = h('div', { class: 'pl-job pl-ghost st-open' }, `#${o.number}`);
      document.body.append(drag.ghost);
    }
    drag.ghost.style.left = `${e.clientX + 8}px`;
    drag.ghost.style.top = `${e.clientY + 8}px`;
  });
  item.addEventListener('pointerup', async (e) => {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (!d.ghost) { placeDialog(o, data, rerender); return; }
    d.ghost.remove();
    const lane = document.elementFromPoint(e.clientX, e.clientY)?.closest('.pl-lane');
    if (!lane) return;
    const [ws, we] = data.window;
    const dayW = (we - ws) * PX;
    const x = e.clientX - lane.getBoundingClientRect().left;
    const i = Math.floor(x / (dayW + GAP));
    const within = x - i * (dayW + GAP);
    if (i < 0 || i >= data.days.length || within > dayW) { toast('Drop the job inside a working day', 'error'); return; }
    const m = Math.min(Math.max(Math.round((ws + within / PX) / SNAP) * SNAP, ws), we - SNAP);
    try {
      await api.patch(`/work-orders/${o.id}`, { planned_at: `${data.days[i]}T${hhmm(m)}`, assigned_to: Number(lane.dataset.staff) });
      await rerender();
    } catch (err) { showError(err); }
  });
  item.addEventListener('pointercancel', () => { drag?.ghost?.remove(); drag = null; });
  return item;
}

// ---------------------------------------------------------------- dialogs

const field = (label, input) => h('div', { class: 'field' }, h('label', {}, label), input);
const personSelect = (data, selected) => h('select', {}, data.rows.map((r) => h('option', { value: r.staff_id, selected: r.staff_id === selected, translate: 'no' }, r.name)));

/** Tap on an empty spot: a new work order there, an absence, or a job from "Not planned". */
function slotDialog(r, t, data, rerender) {
  const at = `${t.day}T${hhmm(t.min)}`;
  const body = h('div', {},
    h('p', {}, h('strong', { translate: 'no' }, r.name), ` · ${isoNo(t.day)} ${hhmm(t.min)}`),
    h('div', { class: 'actions left' },
      h('button', {
        class: 'btn primary', type: 'button',
        onClick: () => { close(); newWorkOrderDialog(null, { planned: at, assigned_to: r.staff_id, onDone: rerender }); },
      }, '+ New work order here'),
      h('button', { class: 'btn', type: 'button', onClick: () => { close(); absenceDialog({ staff_id: r.staff_id, start: at }, data, rerender); } }, '+ Absence')),
    data.unplanned.length ? [h('h3', {}, 'Put a job from "Not planned" here'),
      h('ul', { class: 'rows' }, data.unplanned.slice(0, 30).map((o) => h('li', {},
        h('button', {
          class: 'link pick', type: 'button',
          onClick: async () => {
            try {
              await api.patch(`/work-orders/${o.id}`, { planned_at: at, assigned_to: r.staff_id });
              close();
              await rerender();
            } catch (e) { showError(e); }
          },
        }, `#${o.number} `, h('span', { translate: 'no' }, [o.registration_number, o.title || o.customer_name].filter(Boolean).join(' · '))))))] : null);
  const { close } = openDialog('Plan', body);
}

/** Tap on a job: its details, change start / person / time it takes, take it off the plan, open it. */
function jobDialog(o, data, rerender) {
  const day = dateInput({ value: o.planned_local.slice(0, 10) });
  const time = timeInput({ value: o.planned_local.slice(11, 16) });
  const who = personSelect(data, o.assigned_to);
  const est = h('input', { type: 'text', inputmode: 'decimal', autocomplete: 'off', value: o.estimated_minutes ? String(Math.round((o.estimated_minutes / 60) * 100) / 100).replace('.', ',') : '' });
  const ok = h('button', { class: 'btn primary', type: 'submit' }, 'Save');
  const off = h('button', { class: 'link danger', type: 'button' }, 'Take off the plan');
  const arrived = h('button', { class: o.arrived_at ? 'btn small' : 'btn small primary', type: 'button' },
    o.arrived_at ? 'Not arrived after all' : '🔑 The car has arrived');
  arrived.addEventListener('click', () => busy(arrived, async () => {
    await api.post(`/work-orders/${o.id}/arrived`, { arrived: !o.arrived_at });
    close();
    await rerender();
  }));
  const form = h('form', {},
    h('p', {}, woBadge(o.status), ' ', h('span', { translate: 'no' }, [o.registration_number, [o.make, o.model].filter(Boolean).join(' '), o.customer_name].filter(Boolean).join(' · '))),
    o.title ? h('p', { translate: 'no' }, o.title) : null,
    h('p', { class: 'muted small' }, h('span', {}, 'Done about'), ` ${isoNo(o.end_local.slice(0, 10))} ${o.end_local.slice(11, 16)}`),
    h('p', {}, o.arrived_at ? h('span', { class: 'badge good' }, h('span', {}, 'Arrived'), ` ${fmtDate(o.arrived_at)}`)
      : h('span', { class: 'badge' }, 'Not arrived yet'), ' ', data.can_edit ? arrived : null),
    data.can_edit ? [
      h('div', { class: 'grid' }, field('Date', day), field('Start', time), field('Estimated hours', est)),
      field('Mechanic', who),
      h('div', { class: 'actions spread' }, off, ok)] : null,
    h('p', {}, h('a', { href: `#/work-orders/${o.id}`, onClick: () => close() }, 'Open the work order')));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const s = est.value.trim().replace(',', '.');
    const minutes = s ? Math.round(Number(s) * 60) : null;
    if (s && (!Number.isFinite(minutes) || minutes <= 0)) { toast('Check the estimated hours', 'error'); return; }
    if (!day.value || !time.value) { toast('Enter the date and time', 'error'); return; }
    busy(ok, async () => {
      await api.patch(`/work-orders/${o.id}`, { planned_at: `${day.value}T${time.value}`, assigned_to: Number(who.value), estimated_minutes: minutes });
      close();
      await rerender();
    });
  });
  off.addEventListener('click', () => busy(off, async () => {
    await api.patch(`/work-orders/${o.id}`, { planned_at: null });
    close();
    await rerender();
  }));
  const { close } = openDialog(`Work order #${o.number}`, form);
}

/** Put a job from "Not planned" on a line (the same as dragging it). */
function placeDialog(o, data, rerender) {
  const day = dateInput({ value: String(data.days[0]) });
  const time = timeInput({ value: hhmm(data.window[0]) });
  const who = personSelect(data, o.assigned_to);
  const ok = h('button', { class: 'btn primary', type: 'submit' }, 'Plan');
  const form = h('form', {},
    h('p', { translate: 'no' }, [o.registration_number, o.title || o.customer_name].filter(Boolean).join(' · ')),
    h('div', { class: 'grid' }, field('Date', day), field('Start', time)),
    field('Mechanic', who),
    h('p', {}, h('a', { href: `#/work-orders/${o.id}`, onClick: () => close() }, 'Open the work order')),
    h('div', { class: 'actions' }, ok));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!day.value || !time.value) { toast('Enter the date and time', 'error'); return; }
    busy(ok, async () => {
      await api.patch(`/work-orders/${o.id}`, { planned_at: `${day.value}T${time.value}`, assigned_to: Number(who.value) });
      close();
      await rerender();
    });
  });
  const { close } = openDialog(`Plan work order #${o.number}`, form);
}

/** Add or change an absence (holiday / away / course / other). */
function absenceDialog(a, data, rerender) {
  const isNew = !a?.id;
  const [ws, we] = data.window;
  const startIso = a?.start || `${String(data.days[0])}T${hhmm(ws)}`;
  const endIso = a?.end || `${startIso.slice(0, 10)}T${hhmm(we)}`;
  const who = personSelect(data, a?.staff_id ?? data.rows[0]?.staff_id);
  const kind = h('select', {}, Object.entries(ABSENCE).map(([k, t]) => h('option', { value: k, selected: k === (a?.kind || 'holiday') }, t)));
  const d1 = dateInput({ value: startIso.slice(0, 10) });
  const t1 = timeInput({ value: startIso.slice(11, 16) });
  const d2 = dateInput({ value: endIso.slice(0, 10) });
  const t2 = timeInput({ value: endIso.slice(11, 16) });
  const note = h('input', { type: 'text', maxlength: 200, autocomplete: 'off', value: a?.note || '' });
  const ok = h('button', { class: 'btn primary', type: 'submit' }, 'Save');
  const del = isNew ? null : h('button', { class: 'link danger', type: 'button' }, 'Delete');
  const form = h('form', {},
    h('div', { class: 'grid' }, field('Person', who), field('Kind', kind)),
    h('div', { class: 'grid' }, field('From date', d1), field('From', t1), field('To date', d2), field('To', t2)),
    field('Note', note),
    h('p', { class: 'muted small' }, 'Don’t write why someone is away (health information is not stored here).'),
    h('div', { class: 'actions spread' }, del || h('span'), ok));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!d1.value || !t1.value || !d2.value || !t2.value) { toast('Enter the dates and times', 'error'); return; }
    busy(ok, async () => {
      const body = { staff_id: Number(who.value), kind: kind.value, start: `${d1.value}T${t1.value}`, end: `${d2.value}T${t2.value}`, note: note.value.trim() || null };
      if (isNew) await api.post('/planner/absences', body);
      else await api.put(`/planner/absences/${a.id}`, body);
      close();
      await rerender();
    });
  });
  del?.addEventListener('click', () => busy(del, async () => {
    if (!confirm('Delete this absence?')) return;
    await api.del(`/planner/absences/${a.id}`);
    close();
    await rerender();
  }));
  const { close } = openDialog(isNew ? 'New absence' : 'Absence', form);
}

/** The planner's lines: order, take people off, add people (also from other teams). */
async function linesDialog(data, rerender) {
  let people;
  try { people = await api.get(`/planner/${data.team.id}/people`); } catch (e) { showError(e); return; }
  const list = data.rows.map((r) => ({ id: r.staff_id, name: r.name }));
  const box = h('div');
  const add = h('select', { 'aria-label': 'Add a person' });
  const draw = () => {
    box.replaceChildren(list.length ? h('ul', { class: 'rows' }, list.map((p, i) => h('li', {},
      h('span', { translate: 'no' }, p.name),
      h('span', { class: 'nowrap' },
        h('button', { class: 'link small', type: 'button', disabled: i === 0, 'aria-label': 'Up', onClick: () => { [list[i - 1], list[i]] = [list[i], list[i - 1]]; draw(); } }, '↑'), ' ',
        h('button', { class: 'link small', type: 'button', disabled: i === list.length - 1, 'aria-label': 'Down', onClick: () => { [list[i + 1], list[i]] = [list[i], list[i + 1]]; draw(); } }, '↓'), ' ',
        h('button', { class: 'link danger small', type: 'button', onClick: () => { list.splice(i, 1); draw(); } }, 'remove')))))
      : h('p', { class: 'empty' }, 'No lines.'));
    const ids = new Set(list.map((p) => p.id));
    add.replaceChildren(h('option', { value: '' }, 'Add a person…'),
      ...people.filter((p) => !ids.has(p.id)).map((p) => h('option', { value: p.id, translate: 'no' }, p.name)));
  };
  add.addEventListener('change', () => {
    const p = people.find((x) => String(x.id) === add.value);
    if (p) { list.push({ id: p.id, name: p.name }); draw(); }
  });
  draw();
  const ok = h('button', { class: 'btn primary', type: 'button' }, 'Save');
  ok.addEventListener('click', () => busy(ok, async () => {
    await api.put(`/planner/${data.team.id}/rows`, { staff_ids: list.map((p) => p.id) });
    close();
    toast('Saved', 'success');
    await rerender();
  }));
  const { close } = openDialog(`Lines · ${data.team.name}`, h('div', {},
    h('p', { class: 'muted small' }, 'One line per person. Team members are on it unless taken off; people from other teams can be added.'),
    box, field('Add', add), h('div', { class: 'actions' }, ok)));
}

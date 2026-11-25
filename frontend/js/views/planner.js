// Planner (0.51.0): one calendar per team. A line per person (and, from 0.55.0, per workshop place: lifts / bays); their
// work orders laid out over the working day, one after another, with breaks (hatched) and absences. Drag a job to move
// it (time and line), drag its right edge to change the estimate, drag a job from "Not planned" onto a line, or tap an
// empty spot. Everyone in the team can change it.
// 0.55.0 (the user's request, with a photo of their old booking system): the board fills the width of the screen, a
// month calendar to pick the day (coloured by how full it is), a chart of the next 7 working days, job types with
// colours (fill) + status marks (left edge, icons), a legend, and "Open in its own window" (#/planner?full=1: no top
// bar, refreshes itself every minute).
// Server: routers/planner.py; jobs are saved through PATCH /work-orders/{id}.
import { api, append, busy, dateInput, fmtDate, h, openDialog, osloTodayIso, session, showError, timeInput, toast } from '../ui.js';
import { lang } from '../i18n.js';
import { fmtDuration } from './hours.js';
import { jobTypeName, jobTypes, newWorkOrderDialog, woBadge } from './workorders.js';
import { mapWithPin, optText } from './deliveries.js';

const GAP = 14;          // between days
const SNAP = 15;         // minutes
const MIN_PX = 0.55;     // pixels per minute: below this the board scrolls sideways
const MAX_PX = 4;
const NAMES_W = 152;     // the names column (.pl-names)
const ROW_H = 52;        // one stacked row of jobs on a line
const ABSENCE = { holiday: 'Holiday', away: 'Away', course: 'Course', other: 'Other' };
const STATUS_MARK = { open: 'Open', in_progress: 'In progress', done: 'Done', invoiced: 'Invoiced' };
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
const locale = () => (lang === 'no' ? 'nb-NO' : 'en-GB');
/** Short weekday in the user's language ("ons." / "Wed"). */
const shortDay = (iso) => new Intl.DateTimeFormat(locale(), { weekday: 'short', timeZone: 'UTC' }).format(new Date(`${iso}T12:00:00Z`));
/** Dark or light text on a job type colour. */
const textOn = (hex) => {
  const n = parseInt(String(hex).slice(1), 16);
  return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255 > 0.58 ? '#111' : '#fff';
};
/** How full a day is: '' (no working time), free, good (< 85 %), warn (85–100 %), bad (over). */
const level = (d) => {
  if (!d || !d.available) return d && d.planned ? 'bad' : '';
  const r = d.planned / d.available;
  return r > 1.001 ? 'bad' : r >= 0.85 ? 'warn' : d.planned > 0 ? 'good' : 'free';
};
const pct = (d) => (d && d.available ? Math.round((d.planned / d.available) * 100) : null);

// The page redraws itself on a resize (the board follows the width) and every minute (others' changes), but never
// while a dialog is open or a job is being dragged. One set of listeners for the whole app.
let current = null;
const onPlanner = () => location.hash.startsWith('#/planner');
const busyNow = () => document.querySelector('dialog[open], .pl-job.dragging, .pl-ghost');
let hooked = false;
function hookOnce() {
  if (hooked) return;
  hooked = true;
  let t = null;
  let lastW = window.innerWidth;
  window.addEventListener('resize', () => {
    clearTimeout(t);
    t = setTimeout(() => {
      if (Math.abs(window.innerWidth - lastW) < 40) return;
      lastW = window.innerWidth;
      if (onPlanner() && !busyNow()) current?.();
    }, 300);
  });
  setInterval(() => {
    if (onPlanner() && document.visibilityState === 'visible' && !busyNow()) current?.();
  }, 60 * 1000);
  window.addEventListener('hashchange', () => {
    if (!onPlanner()) document.body.classList.remove('planner-wide', 'planner-full');
  });
}

export async function plannerView(el, _params, host = el) {
  hookOnce();
  const saved = new URLSearchParams(location.hash.split('?')[1] || '');
  const full = saved.get('full') === '1';
  document.body.classList.add('planner-wide');
  document.body.classList.toggle('planner-full', full);
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

  // Pixels per minute: the board fills the width; a narrow screen scrolls sideways instead of squeezing the jobs.
  const [ws, we] = data.window;
  const n = data.days.length;
  const avail = (host.clientWidth || window.innerWidth) - NAMES_W - 36 - (n - 1) * GAP;
  data.px = Math.min(MAX_PX, Math.max(MIN_PX, avail / (n * (we - ws))));

  const go = (changes) => {
    const q = new URLSearchParams({ team: teamId, start, days, ...(full ? { full: 1 } : {}), ...changes });
    location.hash = `#/planner?${q}`;
  };
  const rerender = async () => {
    try {
      const fresh = h('div');
      await plannerView(fresh, [], host);
      host.replaceChildren(...fresh.childNodes);
    } catch (e) { showError(e); }
  };
  current = rerender;

  const teamSel = h('select', { 'aria-label': 'Team' }, teams.map((t) => h('option', { value: t.id, selected: t.id === teamId, translate: 'no' }, t.name)));
  teamSel.addEventListener('change', () => go({ team: teamSel.value }));
  const daySel = h('select', { 'aria-label': 'Days' },
    [[1, 'One day'], [3, 'Three days'], [7, 'One week']].map(([v, t]) => h('option', { value: v, selected: v === days }, t)));
  daySel.addEventListener('change', () => go({ days: daySel.value }));
  const dateIn = dateInput({ value: start });
  dateIn.addEventListener('change', () => dateIn.value && go({ start: dateIn.value }));
  const step = days >= 7 ? 7 : days;

  const openWindow = () => {
    const q = new URLSearchParams({ team: teamId, start, days, full: 1 });
    const w = window.open(`${location.pathname}#/planner?${q}`, 'carbonara-planner', 'popup=yes,width=1600,height=950');
    if (!w) toast('The browser blocked the new window. Allow pop-ups for Carbonara.', 'error');
  };
  const fullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else document.documentElement.requestFullscreen?.().catch(() => {});
  };

  append(el,
    h('div', { class: 'page-head pl-page-head' },
      h('div', {}, h('h1', {}, 'Planner'),
        full ? null : h('div', { class: 'muted' }, 'Drag a job to move it, drag its right edge to change the time it takes, or tap an empty spot.')),
      h('div', { class: 'row-actions' },
        full ? h('button', { class: 'btn', type: 'button', onClick: fullscreen }, '⛶ Full screen')
          : h('button', { class: 'btn', type: 'button', onClick: openWindow }, '⧉ Open in its own window'),
        h('button', { class: 'btn', type: 'button', onClick: () => linesDialog(data, rerender) }, 'Lines'),
        data.is_admin ? h('button', { class: 'btn', type: 'button', onClick: () => jobTypesDialog(rerender) }, 'Job types') : null,
        h('button', { class: 'btn', type: 'button', onClick: () => absenceDialog(null, data, rerender) }, '+ Absence'))),
    h('div', { class: 'pl-top' },
      calendarBox(teamId, start, go, data),
      loadChart(teamId, start, go),
      legendBox(data)),
    h('div', { class: 'toolbar planner-toolbar' },
      teams.length > 1 ? teamSel : h('strong', { translate: 'no' }, data.team.name),
      h('button', { class: 'btn', type: 'button', 'aria-label': 'Earlier', onClick: () => go({ start: addDays(start, -step) }) }, '◀'),
      dateIn,
      h('button', { class: 'btn', type: 'button', 'aria-label': 'Later', onClick: () => go({ start: addDays(start, step) }) }, '▶'),
      h('button', { class: 'link', type: 'button', onClick: () => go({ start: osloTodayIso() }) }, 'Today'),
      daySel),
    data.rows.length ? board(data, rerender) : h('div', { class: 'card notice' }, 'No lines yet. Use "Lines" to add people or places.'),
    unplannedCard(data, rerender));
}

// ---------------------------------------------------------------- calendar, 7-day chart, legend

/** A month to pick the day from; each day coloured by how full the team's people are. */
function calendarBox(teamId, start, go, data) {
  const box = h('section', { class: 'card pl-cal' });
  let month = start.slice(0, 7);
  const draw = async () => {
    const first = `${month}-01`;
    const gridStart = addDays(first, -((weekday(first) + 6) % 7));
    const load = {};
    try {
      (await api.get(`/planner/load?team_id=${teamId}&start=${gridStart}&days=42`)).forEach((d) => { load[String(d.date)] = d; });
    } catch { /* the calendar still works without colours */ }
    const [y, m] = month.split('-').map(Number);
    const title = new Intl.DateTimeFormat(locale(), { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, 15)));
    const shift = (k) => {
      const d = new Date(Date.UTC(y, m - 1 + k, 15));
      month = d.toISOString().slice(0, 7);
      draw();
    };
    const heads = [0, 1, 2, 3, 4, 5, 6].map((i) => h('span', { class: 'pl-cal-dow' },
      new Intl.DateTimeFormat(locale(), { weekday: 'narrow', timeZone: 'UTC' }).format(new Date(`${addDays(gridStart, i)}T12:00:00Z`))));
    const cells = Array.from({ length: 42 }, (_, i) => {
      const iso = addDays(gridStart, i);
      const d = load[iso];
      const p = pct(d);
      const cls = ['pl-cal-day', iso.slice(0, 7) !== month ? 'other' : '', weekday(iso) % 6 === 0 ? 'weekend' : '',
        iso === String(data.today) ? 'today' : '', iso === start ? 'on' : '', level(d) ? `lv-${level(d)}` : ''].filter(Boolean).join(' ');
      return h('button', {
        class: cls, type: 'button', onClick: () => go({ start: iso }),
        title: `${isoNo(iso)}${p != null ? ` · ${p} % · ${hoursNo(d.planned)} / ${hoursNo(d.available)} h` : ''}`,
      }, String(Number(iso.slice(8))));
    });
    box.replaceChildren(
      h('div', { class: 'pl-cal-head' },
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Earlier', onClick: () => shift(-1) }, '‹'),
        h('strong', { translate: 'no' }, title),
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Later', onClick: () => shift(1) }, '›')),
      h('div', { class: 'pl-cal-grid' }, heads, cells));
  };
  draw();
  return box;
}

/** How full the next 7 working days are (from the day shown): planned / available hours of the people lines. */
function loadChart(teamId, start, go) {
  const box = h('section', { class: 'card pl-chart' }, h('h3', {}, 'Booked, next 7 working days'));
  api.get(`/planner/load?team_id=${teamId}&start=${start}&days=11`).then((list) => {
    const work = list.filter((d) => weekday(String(d.date)) % 6 !== 0).slice(0, 7);
    const bars = work.map((d) => {
      const iso = String(d.date);
      const p = pct(d);
      const lv = level(d) || 'free';
      return h('button', {
        class: `pl-bar lv-${lv}`, type: 'button', onClick: () => go({ start: iso }),
        title: `${isoNo(iso)}: ${hoursNo(d.planned)} / ${hoursNo(d.available)} h`,
      },
      h('span', { class: 'pl-bar-pct' }, p != null ? `${p} %` : '–'),
      h('span', { class: 'pl-bar-track' },
        h('span', { class: 'pl-bar-full' }),
        h('span', { class: 'pl-bar-fill', style: `height:${Math.min(p ?? 0, 120) / 1.2}%` })),
      h('span', { class: 'pl-bar-day', translate: 'no' }, `${shortDay(iso)} ${isoNo(iso).slice(0, 5)}`),
      h('span', { class: 'pl-bar-h' }, `${hoursNo(d.planned)}/${hoursNo(d.available)} h`));
    });
    box.append(h('div', { class: 'pl-bars' }, bars),
      h('p', { class: 'muted small' }, h('span', {}, 'The line marks 100 % (all available hours booked).')));
  }).catch(() => box.append(h('p', { class: 'muted small' }, 'Could not load the overview.')));
  return box;
}

function legendBox(data) {
  const types = data.job_types.filter((t) => t.active);
  return h('section', { class: 'card pl-legend' },
    h('h3', {}, 'Job types'),
    types.length ? h('ul', { class: 'pl-legend-list' }, types.map((t) => h('li', {},
      h('span', { class: 'pl-swatch', style: `background:${t.color}` }), h('span', { translate: 'no' }, jobTypeName(t)))))
      : h('p', { class: 'muted small' }, 'No job types.'),
    h('h3', {}, 'Status'),
    h('ul', { class: 'pl-legend-list' },
      Object.entries(STATUS_MARK).map(([k, t]) => h('li', {}, h('span', { class: `pl-edge st-${k}` }), h('span', {}, t))),
      h('li', {}, h('span', { class: 'pl-icon' }, '🔑'), h('span', {}, 'Car arrived')),
      h('li', {}, h('span', { class: 'pl-icon' }, '⏱'), h('span', {}, 'Clock running')),
      h('li', {}, h('span', { class: 'pl-icon' }, '📦'), h('span', {}, 'Waiting for parts')),
      h('li', {}, h('span', { class: 'pl-icon' }, '✅'), h('span', {}, 'Parts arrived'))),
    h('h3', {}, 'Absence'),
    h('ul', { class: 'pl-legend-list' },
      Object.entries(ABSENCE).map(([k, t]) => h('li', {}, h('span', { class: `pl-swatch abs-${k}` }), h('span', {}, t))),
      h('li', {}, h('span', { class: 'pl-swatch pl-key-break' }), h('span', {}, 'Break'))));
}

// ---------------------------------------------------------------- the board

const ordersOn = (data, r) => data.orders.filter((o) => (r.kind === 'place' ? o.place_id === r.place_id : o.assigned_to === r.staff_id));
/** What dropping a job on a line changes: the mechanic (a person's line) or the place. */
const lineTarget = (lane) => (lane.dataset.kind === 'place' ? { place_id: Number(lane.dataset.id) } : { assigned_to: Number(lane.dataset.id) });

function board(data, rerender) {
  const PX = data.px;
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
  data.timeAt = timeAt;

  // Header: the days and the hours (half hours too when there is room).
  const half = PX >= 1.6;
  const head = h('div', { class: 'pl-head', style: `width:${width}px` },
    days.map((d, i) => {
      const left = i * (dayW + GAP);
      const ticks = [];
      for (let m = Math.ceil(ws / 30) * 30; m < we; m += 30) {
        if (m % 60 && !half) continue;
        ticks.push(h('span', { class: `pl-tick${m % 60 ? ' half' : ''}`, style: `left:${(m - ws) * PX}px` }, m % 60 ? '' : pad(m / 60)));
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
  const nowLocal = `${osloTodayIso()}T${new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Oslo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date())}`;
  const nowX = days.includes(nowLocal.slice(0, 10)) && minOf(nowLocal) >= ws && minOf(nowLocal) <= we ? xOf(nowLocal) : null;

  let placesStarted = false;
  const lanes = data.rows.map((r) => {
    // Pieces: a job is drawn per day from its first to its last piece of working time that day.
    const pieces = [];
    ordersOn(data, r).forEach((o) => {
      const byDay = {};
      o.segments.forEach(([s, e]) => { const d = s.slice(0, 10); (byDay[d] ||= []).push([s, e]); });
      Object.keys(byDay).sort().forEach((d, k) => {
        const segs = byDay[d];
        const x1 = xOf(segs[0][0]);
        const x2 = xOf(segs[segs.length - 1][1]);
        if (x1 == null || x2 == null) return;
        pieces.push({ o, x1, x2: Math.max(x2, x1 + 12), last: segs[segs.length - 1][1] === o.end_local, cont: k > 0 });
      });
    });
    const absences = [];
    if (r.kind === 'staff') {
      data.absences.filter((a) => a.staff_id === r.staff_id).forEach((a) => {
        days.forEach((d) => {
          const s = a.start > `${d}T${hhmm(ws)}` ? a.start : `${d}T${hhmm(ws)}`;
          const e = a.end < `${d}T${hhmm(we)}` ? a.end : `${d}T${hhmm(we)}`;
          if (s < e) absences.push({ a, x1: xOf(s), x2: xOf(e) });
        });
      });
    }
    // Jobs that overlap on one line are stacked.
    pieces.sort((p, q) => p.x1 - q.x1);
    const ends = [];
    pieces.forEach((p) => {
      let i = ends.findIndex((x) => x <= p.x1 + 1);
      if (i < 0) { i = ends.length; ends.push(0); }
      ends[i] = p.x2;
      p.row = i;
    });
    const laneH = 12 + Math.max(1, ends.length) * ROW_H;
    const id = r.kind === 'place' ? r.place_id : r.staff_id;
    const lane = h('div', { class: `pl-lane${r.kind === 'place' ? ' place' : ''}`, style: `width:${width}px;height:${laneH}px`, 'data-kind': r.kind, 'data-id': id },
      breakStripes(),
      absences.map(({ a, x1, x2 }) => h('button', {
        class: `pl-absence abs-${a.kind}`, type: 'button', style: `left:${x1}px;width:${Math.max(x2 - x1, 8)}px`,
        title: a.note || '', onClick: (e) => { e.stopPropagation(); absenceDialog(a, data, rerender); },
      }, h('span', {}, ABSENCE[a.kind]), a.note ? h('span', { class: 'pl-abs-note', translate: 'no' }, ` · ${a.note}`) : null)),
      pieces.map((p) => jobBar(p, data, rerender)),
      nowX != null ? h('div', { class: 'pl-now', style: `left:${nowX}px` }) : null);
    lane.addEventListener('click', (e) => {
      if (e.target !== lane && !e.target.classList.contains('pl-break')) return;
      const t = timeAt(e.clientX - lane.getBoundingClientRect().left);
      if (t) slotDialog(r, t, data, rerender);
    });
    const cap = days.reduce((acc, d) => {
      const c = data.capacity[`${r.key}:${d}`] || { available: 0, planned: 0 };
      return { available: acc.available + c.available, planned: acc.planned + c.planned };
    }, { available: 0, planned: 0 });
    const over = cap.available && cap.planned > cap.available;
    const first = r.kind === 'place' && !placesStarted;
    if (r.kind === 'place') placesStarted = true;
    const name = h('div', { class: `pl-name${r.kind === 'place' ? ' place' : ''}${first ? ' first-place' : ''}`, style: `height:${laneH}px` },
      h('strong', { translate: 'no' }, r.kind === 'place' ? `🔧 ${r.name}` : r.name),
      h('span', { class: `small ${over ? 'bad-text' : 'muted'}` }, `${hoursNo(cap.planned)} / ${hoursNo(cap.available)} h`));
    if (first) lane.classList.add('first-place');
    return { name, lane };
  });

  return h('section', { class: 'card planner' },
    h('div', { class: 'pl-wrap' },
      h('div', { class: 'pl-names' }, h('div', { class: 'pl-corner' }), lanes.map((l) => l.name)),
      h('div', { class: 'pl-scroll' }, head, lanes.map((l) => l.lane))),
    h('p', { class: 'muted small' }, 'Planned / available hours on the days shown. A job booked on a place is also on its mechanic’s line.'));
}

/** One job on a line: drag to move (time + line), drag the right edge to change the estimate, tap to open. */
function jobBar(p, data, rerender) {
  const o = p.o;
  const type = data.job_types.find((t) => t.id === o.job_type_id);
  const who = [o.registration_number, o.customer_name].filter(Boolean).join(' · ');
  const what = [type ? jobTypeName(type) : null, o.title].filter(Boolean).join(' · ');
  const icons = [
    o.arrived_at ? h('span', { title: 'Car arrived' }, '🔑') : null,
    Number(o.clocks_running) > 0 ? h('span', { title: 'Clock running' }, '⏱') : null,
    o.parts_status === 'ordered' ? h('span', { title: 'Waiting for parts' }, '📦') : o.parts_status === 'arrived' ? h('span', { title: 'Parts arrived' }, '✅') : null,
    o.task_count ? h('span', {}, `${o.tasks_done}/${o.task_count}`) : null,
  ].filter(Boolean);
  const handle = p.last ? h('span', { class: 'pl-resize', title: 'Drag to change the time it takes' }) : null;
  const bar = h('div', {
    class: `pl-job st-${o.status}${type ? ' typed' : ''}${o.pdi_order_id ? ' pdi' : ''}${p.cont ? ' cont' : ''}${o.arrived_at ? ' arrived' : ''}`,
    style: `left:${p.x1}px;width:${p.x2 - p.x1}px;top:${6 + p.row * ROW_H}px;${type ? `background:${type.color};color:${textOn(type.color)};` : ''}`,
    title: [`#${o.number}`, who, what, STATUS_MARK[o.status]].filter(Boolean).join(' · '),
  },
  h('span', { class: 'pl-job-line' },
    h('span', { class: 'pl-job-no' }, `#${o.number}`), ' ',
    h('span', { class: 'pl-job-text', translate: 'no' }, who || '–'),
    icons.length ? h('span', { class: 'pl-job-meta' }, icons) : null),
  what ? h('span', { class: 'pl-job-line pl-job-what', translate: 'no' }, what) : null,
  handle);

  if (!data.can_edit) {
    bar.addEventListener('click', () => jobDialog(o, data, rerender));
    return bar;
  }
  const PX = data.px;
  let drag = null;
  bar.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    bar.setPointerCapture(e.pointerId);
    drag = { mode: e.target === handle ? 'resize' : 'move', x0: e.clientX, y0: e.clientY, moved: false, left: p.x1, width: p.x2 - p.x1 };
  });
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
  const reset = () => { bar.style.transform = ''; bar.style.width = ''; };
  bar.addEventListener('pointerup', async (e) => {
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
        if (!under) { reset(); return; }
        const t = data.timeAt(d.left + dx);
        if (!t) { reset(); toast('Drop the job inside a working day', 'error'); return; }
        await api.patch(`/work-orders/${o.id}`, { planned_at: `${t.day}T${hhmm(t.min)}`, ...lineTarget(under) });
      }
      await rerender();
    } catch (err) { reset(); showError(err); }
  });
  bar.addEventListener('pointercancel', () => { drag = null; reset(); bar.classList.remove('dragging'); });
  return bar;
}

// ---------------------------------------------------------------- not planned

const jobText = (o) => [o.registration_number, o.title || o.customer_name].filter(Boolean).join(' · ');

function unplannedCard(data, rerender) {
  const list = data.unplanned;
  return h('section', { class: 'card' },
    h('h2', {}, `Not planned (${list.length})`),
    h('p', { class: 'muted small' }, 'Work orders that are not done, without a time or a line on this planner. Drag one onto a line, or tap it.'),
    list.length ? h('div', { class: 'pl-unplanned' }, list.map((o) => unplannedItem(o, data, rerender)))
      : h('p', { class: 'empty' }, 'Everything is planned.'));
}

function unplannedItem(o, data, rerender) {
  const type = data.job_types.find((t) => t.id === o.job_type_id);
  const item = h('div', { class: 'pl-un-item', tabindex: '0' },
    type ? h('span', { class: 'pl-swatch', style: `background:${type.color}`, title: jobTypeName(type) }) : null,
    h('strong', {}, `#${o.number}`), ' ',
    h('span', { translate: 'no' }, jobText(o)),
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
      drag.ghost = h('div', { class: 'pl-job pl-ghost st-open', style: type ? `background:${type.color};color:${textOn(type.color)}` : '' }, `#${o.number}`);
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
    if (!lane || !data.timeAt) return;
    const t = data.timeAt(e.clientX - lane.getBoundingClientRect().left);
    if (!t) { toast('Drop the job inside a working day', 'error'); return; }
    try {
      await api.patch(`/work-orders/${o.id}`, { planned_at: `${t.day}T${hhmm(t.min)}`, ...lineTarget(lane) });
      await rerender();
    } catch (err) { showError(err); }
  });
  item.addEventListener('pointercancel', () => { drag?.ghost?.remove(); drag = null; });
  return item;
}

// ---------------------------------------------------------------- dialogs

const field = (label, input) => h('div', { class: 'field' }, h('label', {}, label), input);
const staffRows = (data) => data.rows.filter((r) => r.kind === 'staff');
const placeRows = (data) => data.rows.filter((r) => r.kind === 'place');
/** The people on this planner; `empty` adds "Nobody yet". */
const personSelect = (data, selected, empty = false) => h('select', {},
  empty ? h('option', { value: '' }, 'Nobody yet') : null,
  staffRows(data).map((r) => h('option', { value: r.staff_id, selected: r.staff_id === selected, translate: 'no' }, r.name)));
const placeSelect = (data, selected) => h('select', {}, h('option', { value: '' }, 'No place'),
  placeRows(data).map((r) => h('option', { value: r.place_id, selected: r.place_id === selected, translate: 'no' }, r.name)));
const typeSelect = (data, selected) => h('select', {}, h('option', { value: '' }, 'No type'),
  data.job_types.filter((t) => t.active || t.id === selected).map((t) => h('option', { value: t.id, selected: t.id === selected, translate: 'no' }, jobTypeName(t))));
const numOrNull = (sel) => (sel.value ? Number(sel.value) : null);

/** Tap on an empty spot: a new work order there, an absence, or a job from "Not planned". */
function slotDialog(r, t, data, rerender) {
  const at = `${t.day}T${hhmm(t.min)}`;
  const target = r.kind === 'place' ? { place_id: r.place_id } : { assigned_to: r.staff_id };
  const body = h('div', {},
    h('p', {}, h('strong', { translate: 'no' }, r.name), ` · ${isoNo(t.day)} ${hhmm(t.min)}`),
    h('div', { class: 'actions left' },
      h('button', {
        class: 'btn primary', type: 'button',
        onClick: () => {
          close();
          newWorkOrderDialog(null, { planned: at, ...target, place_name: r.kind === 'place' ? r.name : null, onDone: rerender });
        },
      }, '+ New work order here'),
      r.kind === 'staff' ? h('button', { class: 'btn', type: 'button', onClick: () => { close(); absenceDialog({ staff_id: r.staff_id, start: at }, data, rerender); } }, '+ Absence') : null),
    data.unplanned.length ? [h('h3', {}, 'Put a job from "Not planned" here'),
      h('ul', { class: 'rows' }, data.unplanned.slice(0, 30).map((o) => h('li', {},
        h('button', {
          class: 'link pick', type: 'button',
          onClick: async () => {
            try {
              await api.patch(`/work-orders/${o.id}`, { planned_at: at, ...target });
              close();
              await rerender();
            } catch (e) { showError(e); }
          },
        }, `#${o.number} `, h('span', { translate: 'no' }, jobText(o))))))] : null);
  const { close } = openDialog('Plan', body);
}

/** Where the customer parked (the pin they tapped on the kiosk map) and left the key. */
function deliveryInfo(d) {
  if (!d) return null;
  return h('div', { class: 'delivery-map pl-delivery-map' },
    h('div', { class: 'small muted' }, h('span', {}, 'Delivered at the kiosk'), ` ${fmtDate(d.created_at)}`),
    d.key_place ? h('div', { class: 'small' }, 'Key: ', h('strong', { translate: 'no' }, optText(d.key_place))) : null,
    d.map_id ? [
      h('div', { class: 'small muted' }, 'Parked: ', h('span', { translate: 'no' }, optText({ name: d.map_name, name_no: d.map_name_no }))),
      mapWithPin(d.map_id, d.pin_x, d.pin_y)] : null);
}

/** Tap on a job: its details, change start / mechanic / place / type / time it takes, take it off the plan, open it. */
function jobDialog(o, data, rerender) {
  const day = dateInput({ value: o.planned_local.slice(0, 10) });
  const time = timeInput({ value: o.planned_local.slice(11, 16) });
  const who = personSelect(data, o.assigned_to, true);
  const where = placeSelect(data, o.place_id);
  const type = typeSelect(data, o.job_type_id);
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
    h('p', { class: 'muted small' }, h('span', {}, 'Done about'), ` ${isoNo(o.end_local.slice(0, 10))} ${o.end_local.slice(11, 16)}`,
      o.parts_status === 'ordered' ? [' · ', h('span', {}, '📦 Waiting for parts')] : o.parts_status === 'arrived' ? [' · ', h('span', {}, '✅ Parts arrived')] : null),
    h('p', {}, o.arrived_at ? h('span', { class: 'badge good' }, h('span', {}, 'Arrived'), ` ${fmtDate(o.arrived_at)}`)
      : h('span', { class: 'badge' }, 'Not arrived yet'), ' ', data.can_edit ? arrived : null),
    deliveryInfo(o.delivery),
    data.can_edit ? [
      h('div', { class: 'grid' }, field('Date', day), field('Start', time), field('Estimated hours', est)),
      h('div', { class: 'grid' }, field('Mechanic', who), field('Place', where), field('Job type', type)),
      h('div', { class: 'actions spread' }, off, ok)] : null,
    h('p', {}, h('a', { href: `#/work-orders/${o.id}`, onClick: () => close() }, 'Open the work order')));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const s = est.value.trim().replace(',', '.');
    const minutes = s ? Math.round(Number(s) * 60) : null;
    if (s && (!Number.isFinite(minutes) || minutes <= 0)) { toast('Check the estimated hours', 'error'); return; }
    if (!day.value || !time.value) { toast('Enter the date and time', 'error'); return; }
    busy(ok, async () => {
      await api.patch(`/work-orders/${o.id}`, {
        planned_at: `${day.value}T${time.value}`, assigned_to: numOrNull(who), place_id: numOrNull(where),
        job_type_id: numOrNull(type), estimated_minutes: minutes,
      });
      close();
      await rerender();
    });
  });
  off.addEventListener('click', () => busy(off, async () => {
    await api.patch(`/work-orders/${o.id}`, { planned_at: null });
    close();
    await rerender();
  }));
  const { close } = openDialog(`Work order #${o.number}`, form, { wide: true });
}

/** Put a job from "Not planned" on the plan (the same as dragging it). */
function placeDialog(o, data, rerender) {
  const day = dateInput({ value: String(data.days[0]) });
  const time = timeInput({ value: hhmm(data.window[0]) });
  const who = personSelect(data, o.assigned_to, true);
  const where = placeSelect(data, o.place_id);
  const ok = h('button', { class: 'btn primary', type: 'submit' }, 'Plan');
  const form = h('form', {},
    h('p', { translate: 'no' }, jobText(o)),
    h('div', { class: 'grid' }, field('Date', day), field('Start', time)),
    h('div', { class: 'grid' }, field('Mechanic', who), field('Place', where)),
    h('p', {}, h('a', { href: `#/work-orders/${o.id}`, onClick: () => close() }, 'Open the work order')),
    h('div', { class: 'actions' }, ok));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!day.value || !time.value) { toast('Enter the date and time', 'error'); return; }
    if (!who.value && !where.value) { toast('Choose a mechanic or a place', 'error'); return; }
    busy(ok, async () => {
      await api.patch(`/work-orders/${o.id}`, { planned_at: `${day.value}T${time.value}`, assigned_to: numOrNull(who), place_id: numOrNull(where) });
      close();
      await rerender();
    });
  });
  const { close } = openDialog(`Plan work order #${o.number}`, form);
}

/** Add or change an absence (holiday / away / course / other). */
function absenceDialog(a, data, rerender) {
  if (!staffRows(data).length) { toast('Add people with "Lines" first', 'error'); return; }
  const isNew = !a?.id;
  const [ws, we] = data.window;
  const startIso = a?.start || `${String(data.days[0])}T${hhmm(ws)}`;
  const endIso = a?.end || `${startIso.slice(0, 10)}T${hhmm(we)}`;
  const who = personSelect(data, a?.staff_id ?? staffRows(data)[0]?.staff_id);
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

/** A list with ↑ ↓ and remove, drawn by `label(item, i)`. */
function orderList(list, label, redraw, emptyText) {
  return list.length ? h('ul', { class: 'rows' }, list.map((p, i) => h('li', {},
    label(p, i),
    h('span', { class: 'nowrap' },
      h('button', { class: 'link small', type: 'button', disabled: i === 0, 'aria-label': 'Up', onClick: () => { [list[i - 1], list[i]] = [list[i], list[i - 1]]; redraw(); } }, '↑'), ' ',
      h('button', { class: 'link small', type: 'button', disabled: i === list.length - 1, 'aria-label': 'Down', onClick: () => { [list[i + 1], list[i]] = [list[i], list[i + 1]]; redraw(); } }, '↓'), ' ',
      h('button', { class: 'link danger small', type: 'button', onClick: () => { list.splice(i, 1); redraw(); } }, 'remove')))))
    : h('p', { class: 'empty' }, emptyText);
}

/** The planner's lines: people (order, take off, add from any team) and workshop places (lifts / bays). */
async function linesDialog(data, rerender) {
  let people;
  try { people = await api.get(`/planner/${data.team.id}/people`); } catch (e) { showError(e); return; }
  const list = staffRows(data).map((r) => ({ id: r.staff_id, name: r.name }));
  const spots = placeRows(data).map((r) => ({ id: r.place_id, name: r.name }));
  const box = h('div');
  const placeBox = h('div');
  const add = h('select', { 'aria-label': 'Add a person' });
  const newPlace = h('input', { type: 'text', maxlength: 60, autocomplete: 'off', placeholder: 'e.g. Lift 1, Wheel alignment, Wash bay' });
  const draw = () => {
    box.replaceChildren(orderList(list, (p) => h('span', { translate: 'no' }, p.name), draw, 'No people.'));
    const ids = new Set(list.map((p) => p.id));
    add.replaceChildren(h('option', { value: '' }, 'Add a person…'),
      ...people.filter((p) => !ids.has(p.id)).map((p) => h('option', { value: p.id, translate: 'no' }, p.name)));
    placeBox.replaceChildren(orderList(spots, (p) => {
      const inp = h('input', { type: 'text', maxlength: 60, value: p.name, 'aria-label': 'Name of the place', class: 'pl-place-name' });
      inp.addEventListener('input', () => { p.name = inp.value; });
      return inp;
    }, draw, 'No places.'));
  };
  add.addEventListener('change', () => {
    const p = people.find((x) => String(x.id) === add.value);
    if (p) { list.push({ id: p.id, name: p.name }); draw(); }
  });
  const addPlace = () => {
    const name = newPlace.value.trim();
    if (!name) return;
    spots.push({ id: null, name });
    newPlace.value = '';
    draw();
  };
  newPlace.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addPlace(); } });
  draw();
  const ok = h('button', { class: 'btn primary', type: 'button' }, 'Save');
  ok.addEventListener('click', () => busy(ok, async () => {
    if (newPlace.value.trim()) addPlace();
    if (spots.some((p) => !p.name.trim())) { toast('Give the place a name', 'error'); return; }
    await api.put(`/planner/${data.team.id}/rows`, { staff_ids: list.map((p) => p.id) });
    await api.put(`/planner/${data.team.id}/places`, { places: spots.map((p) => ({ id: p.id, name: p.name.trim() })) });
    close();
    toast('Saved', 'success');
    await rerender();
  }));
  const { close } = openDialog(`Lines · ${data.team.name}`, h('div', {},
    h('h3', {}, 'People'),
    h('p', { class: 'muted small' }, 'One line per person. Team members are on it unless taken off; people from other teams can be added.'),
    box, field('Add', add),
    h('h3', {}, 'Places in the workshop'),
    h('p', { class: 'muted small' }, 'Lifts, bays and other places that can be booked. A job booked on a place shows on the place’s line and on its mechanic’s line.'),
    placeBox,
    h('div', { class: 'inline pl-add-place' }, newPlace, h('button', { class: 'btn', type: 'button', onClick: addPlace }, '+ Add place')),
    h('div', { class: 'actions' }, ok)), { wide: true });
}

/** Admins: the job types and their colours (they fill the jobs on the planner). */
async function jobTypesDialog(rerender) {
  let types;
  try { types = (await jobTypes(true)).map((t) => ({ ...t })); } catch (e) { showError(e); return; }
  const box = h('div');
  const draw = () => {
    box.replaceChildren(types.length ? h('div', { class: 'pl-types' },
      h('div', { class: 'pl-types-row head' }, h('span', {}, 'Colour'), h('span', {}, 'Name (English)'), h('span', {}, 'Name (Norwegian)'), h('span', {}, 'In use'), h('span')),
      types.map((t, i) => {
        const color = h('input', { type: 'color', value: t.color, 'aria-label': 'Colour' });
        color.addEventListener('input', () => { t.color = color.value; });
        const en = h('input', { type: 'text', maxlength: 60, value: t.name || '', 'aria-label': 'Name (English)' });
        en.addEventListener('input', () => { t.name = en.value; });
        const no = h('input', { type: 'text', maxlength: 60, value: t.name_no || '', 'aria-label': 'Name (Norwegian)' });
        no.addEventListener('input', () => { t.name_no = no.value; });
        const on = h('input', { type: 'checkbox', checked: t.active, 'aria-label': 'In use' });
        on.addEventListener('change', () => { t.active = on.checked; });
        return h('div', { class: 'pl-types-row' }, color, en, no, on,
          h('span', { class: 'nowrap' },
            h('button', { class: 'link small', type: 'button', disabled: i === 0, 'aria-label': 'Up', onClick: () => { [types[i - 1], types[i]] = [types[i], types[i - 1]]; draw(); } }, '↑'), ' ',
            h('button', { class: 'link small', type: 'button', disabled: i === types.length - 1, 'aria-label': 'Down', onClick: () => { [types[i + 1], types[i]] = [types[i], types[i + 1]]; draw(); } }, '↓')));
      })) : h('p', { class: 'empty' }, 'No job types.'));
  };
  draw();
  const addBtn = h('button', { class: 'btn', type: 'button', onClick: () => { types.push({ id: null, name: '', name_no: '', color: '#90CAF9', active: true }); draw(); } }, '+ Add job type');
  const ok = h('button', { class: 'btn primary', type: 'button' }, 'Save');
  ok.addEventListener('click', () => busy(ok, async () => {
    if (types.some((t) => !String(t.name || '').trim())) { toast('Give the job type a name', 'error'); return; }
    await api.put('/job-types', { types: types.map((t) => ({ id: t.id, name: t.name.trim(), name_no: (t.name_no || '').trim() || null, color: t.color, active: t.active })) });
    await jobTypes(true);
    close();
    toast('Saved', 'success');
    await rerender();
  }));
  const { close } = openDialog('Job types', h('div', {},
    h('p', { class: 'muted small' }, 'The colour fills the job on the planner. A job type that is not in use is kept on old work orders.'),
    box, h('div', { class: 'actions spread' }, addBtn, ok)), { wide: true });
}

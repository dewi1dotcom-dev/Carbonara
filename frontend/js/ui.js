import { lang } from './i18n.js';

// Small DOM + API helpers shared by all views. No framework, no build step.

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function request(method, path, body) {
  const opts = { method, headers: {} };
  if (body instanceof FormData) {
    opts.body = body;
  } else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch('/api' + path, opts);
  } catch {
    throw new ApiError(0, 'Cannot reach the server. Check the network connection.');
  }
  if (res.status === 401 && !path.startsWith('/auth/')) {
    // Session expired or logged out elsewhere: show the login screen.
    window.dispatchEvent(new CustomEvent('carbonara:logged-out'));
  }
  if (!res.ok) {
    let msg = res.statusText || `Error ${res.status}`;
    try {
      const j = await res.json();
      if (typeof j.detail === 'string') msg = j.detail;
      else if (Array.isArray(j.detail)) msg = j.detail.map((d) => `${d.loc?.slice(-1)[0] ?? ''}: ${d.msg}`).join('; ');
    } catch { /* not JSON */ }
    throw new ApiError(res.status, msg);
  }
  return res.status === 204 ? null : res.json();
}

/** The logged-in staff member ({id, name, is_admin, …}); set by app.js. */
export const session = { me: null };

/** Does the user's team give them this top menu item? (server: auth.menu_for; Today always.)
 *  Only hides menu items and blocks pages in the app; the server doesn't lock the data. */
export const canSee = (nav) => !session.me || nav === 'today' || (session.me.menu ?? []).includes(nav);

export const api = {
  get: (p) => request('GET', p),
  post: (p, b) => request('POST', p, b ?? {}),
  postForm: (p, fd) => request('POST', p, fd),
  patch: (p, b) => request('PATCH', p, b),
  put: (p, b) => request('PUT', p, b),
  del: (p) => request('DELETE', p),
};

// ---------------------------------------------------------------- DOM helpers

function setProps(el, props) {
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.setAttribute('class', v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value' && 'value' in el && !(el instanceof SVGElement)) el.value = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
}

function addChildren(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
}

/** Like el.append(), but skips null/false and unpacks arrays (the DOM's own
 *  append()/replaceChildren() would print them as "null" / "[object …]"). */
export function append(el, ...children) {
  addChildren(el, children);
  return el;
}

/** h('div', {class: 'x', onClick}, ...children) */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  addChildren(el, children); // children first so <select value> works
  setProps(el, props);
  return el;
}

/** SVG variant of h() */
export function s(tag, props, ...children) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  addChildren(el, children);
  setProps(el, props);
  return el;
}

// ---------------------------------------------------------------- feedback

export function toast(message, type = 'info') {
  let box = document.getElementById('toasts');
  if (!box) document.body.append((box = h('div', { id: 'toasts', 'aria-live': 'polite' })));
  const t = h('div', { class: `toast ${type}` }, message);
  box.append(t);
  setTimeout(() => t.classList.add('out'), type === 'error' ? 6000 : 2500);
  setTimeout(() => t.remove(), type === 'error' ? 6500 : 3000);
}

export function showError(err) {
  console.error(err);
  toast(err?.message || String(err), 'error');
}

/** Run an async action with a busy state on a button. */
export async function busy(button, fn) {
  const label = button.textContent;
  button.disabled = true;
  button.classList.add('busy');
  try {
    return await fn();
  } catch (err) {
    showError(err);
  } finally {
    button.disabled = false;
    button.classList.remove('busy');
    button.textContent = label;
  }
}

/** Modal dialog. Returns {dialog, close}. */
/** `doc: true` for a printable document: its title bar is left off the printout. */
export function openDialog(title, body, { wide = false, doc = false } = {}) {
  const dialog = h('dialog', { class: [wide ? 'wide' : '', doc ? 'doc-dialog' : ''].filter(Boolean).join(' ') },
    h('div', { class: 'dialog-head' },
      h('h2', {}, title),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', onClick: () => close() }, '✕')),
    body);
  const close = () => { dialog.close(); dialog.remove(); };
  dialog.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  document.body.append(dialog);
  dialog.showModal();
  return { dialog, close };
}

/** Hidden <input type=file> that opens the camera on phones/tablets. */
export function cameraPicker(onFile) {
  const input = h('input', {
    type: 'file', accept: 'image/*', capture: 'environment', hidden: true,
    onChange: () => { const f = input.files[0]; input.value = ''; if (f) onFile(f); },
  });
  document.body.append(input);
  return { open: () => input.click(), remove: () => input.remove() };
}

export const photoUrl = (id, variant = 'thumb') => `/api/photos/${id}/${variant}`;

export function viewPhoto(id, title = 'Photo') {
  openDialog(title, h('div', { class: 'photo-view' },
    h('img', { src: photoUrl(id, 'display'), alt: title }),
    h('a', { href: photoUrl(id, 'original'), target: '_blank', rel: 'noopener', class: 'muted' }, 'Open original')),
  { wide: true });
}

// ---------------------------------------------------------------- formatting

// All dates/times are shown in Norwegian standard, 24-hour, Oslo time,
// regardless of the device's language settings: "08.11.2026 00:48".
// (The header clock keeps the long form, in the user's language:
// "søndag 8. november 2026" / "Sunday 8 November 2026".)
const TZ = 'Europe/Oslo';
const fmtTime = new Intl.DateTimeFormat('nb-NO', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const fmtLongDate = new Intl.DateTimeFormat(lang === 'no' ? 'nb-NO' : 'en-GB', {
  timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
});
const fmtParts = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric' });

/** dd.mm.yyyy in Oslo time, built from parts so no locale can change the order. */
function fmtDay(d) {
  const p = Object.fromEntries(fmtParts.formatToParts(d).map(({ type, value }) => [type, value]));
  return `${p.day}.${p.month}.${p.year}`;
}

/** With time: "08.11.2026 00:48". Date only: "08.11.2026". */
export function fmtDate(iso, withTime = true) {
  if (!iso) return '–';
  // A bare date ("2027-03-27") is a calendar day, not a moment: format it as-is.
  if (typeof iso === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    const [y, m, d] = iso.split('-');
    return `${d}.${m}.${y}`;
  }
  const d = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return withTime ? `${fmtDay(d)} ${fmtTime.format(d)}` : fmtDay(d);
}

// ---------------------------------------------------------------- date / time inputs
// The browser's own <input type=date/time> follow the device language (e.g.
// mm/dd/yyyy and AM/PM on an English phone). These always show dd.mm.yyyy and
// 24-hour HH:MM. `.value` is ISO (YYYY-MM-DD / HH:MM) like the native inputs,
// and `.id`, `.disabled`, change/input events work the same.

const pad2 = (n) => String(n).padStart(2, '0');

/** "9.11.2026", "09112026", "9/11/2026", "2026-11-09" -> "2026-11-09"; '' if empty; null if invalid. */
export function parseDate(text) {
  const s = String(text ?? '').trim();
  if (!s) return '';
  let d, m, y;
  let r;
  if ((r = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) [, y, m, d] = r;
  else if ((r = s.match(/^(\d{1,2})[.\/\-\s](\d{1,2})[.\/\-\s](\d{2}|\d{4})$/))) [, d, m, y] = r;
  else if ((r = s.match(/^(\d{2})(\d{2})(\d{4})$/))) [, d, m, y] = r;
  else return null;
  y = Number(y.length === 2 ? `20${y}` : y);
  const dt = new Date(Date.UTC(y, Number(m) - 1, Number(d)));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== Number(m) - 1 || dt.getUTCDate() !== Number(d)) return null;
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

/** "8", "800", "0800", "8:00", "8.00", "14:30" -> "08:00"/"14:30"; '' if empty; null if invalid. */
export function parseTime(text) {
  const s = String(text ?? '').trim();
  if (!s) return '';
  const r = s.match(/^(\d{1,2})(?:[:.\s]?(\d{2}))?$/);
  if (!r) return null;
  const hh = Number(r[1]);
  const mm = Number(r[2] ?? 0);
  return hh <= 23 && mm <= 59 ? `${pad2(hh)}:${pad2(mm)}` : null;
}

const isoToNo = (iso) => (iso ? iso.split('-').reverse().join('.') : '');

/** Wraps a visible text field so it behaves like a native input with an ISO `.value`. */
function wrapField(wrap, text, controls, toIso, fromIso) {
  Object.defineProperty(wrap, 'value', {
    get: () => { const v = toIso(text.value); return v ?? text.value; },
    set: (v) => { text.value = fromIso(v ?? ''); text.setCustomValidity(''); },
  });
  Object.defineProperty(wrap, 'id', { get: () => text.id, set: (v) => { text.id = v; } });
  Object.defineProperty(wrap, 'disabled', {
    get: () => text.disabled,
    set: (v) => { text.disabled = !!v; controls.forEach((c) => { c.disabled = !!v; }); },
  });
  wrap.focus = () => text.focus();
  return wrap;
}

/** Date field: dd.mm.yyyy, with a 📅 button that opens the device's calendar. */
export function dateInput({ value = '', min, max, required = false, id } = {}) {
  const text = h('input', {
    type: 'text', class: 'dt-text', inputmode: 'numeric', autocomplete: 'off', maxlength: 10,
    placeholder: 'dd.mm.yyyy', required, id, value: isoToNo(value),
  });
  const picker = h('input', { type: 'date', class: 'dt-native', tabindex: '-1', 'aria-hidden': 'true', min, max, value });
  const btn = h('button', {
    class: 'dt-btn', type: 'button', 'aria-label': 'Open calendar', title: 'Calendar',
    onClick: () => {
      picker.value = parseDate(text.value) || '';
      try { picker.showPicker(); } catch { picker.focus(); picker.click(); }
    },
  }, '📅');
  const check = () => {
    const iso = parseDate(text.value);
    let msg = '';
    if (iso === null) msg = 'Use the format dd.mm.yyyy';
    else if (iso && min && iso < min) msg = `Not before ${isoToNo(min)}`;
    else if (iso && max && iso > max) msg = `Not after ${isoToNo(max)}`;
    text.setCustomValidity(msg);
    if (iso) text.value = isoToNo(iso);
    return !msg;
  };
  // Runs before listeners on the wrapper: an invalid date never reaches them.
  text.addEventListener('change', (e) => { if (!check()) { e.stopPropagation(); text.reportValidity(); } });
  picker.addEventListener('change', (e) => {
    e.stopPropagation();
    text.value = isoToNo(picker.value);
    text.dispatchEvent(new Event('input', { bubbles: true }));
    text.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const wrap = h('span', { class: 'dt-field' }, text, btn, picker);
  return wrapField(wrap, text, [btn], parseDate, isoToNo);
}

/** Time field: 24-hour HH:MM (typing "800" or "8" gives 08:00). */
export function timeInput({ value = '', required = false, id } = {}) {
  const text = h('input', {
    type: 'text', class: 'dt-text dt-time', inputmode: 'numeric', autocomplete: 'off', maxlength: 5,
    placeholder: 'hh:mm', required, id, value: value ? value.slice(0, 5) : '',
  });
  text.addEventListener('change', (e) => {
    const t = parseTime(text.value);
    text.setCustomValidity(t === null ? 'Use 24-hour time, e.g. 08:00 or 14:30' : '');
    if (t === null) { e.stopPropagation(); text.reportValidity(); } else text.value = t;
  });
  const wrap = h('span', { class: 'dt-field' }, text);
  return wrapField(wrap, text, [], parseTime, (v) => (v || '').slice(0, 5));
}

/** Today's date in Oslo as YYYY-MM-DD (not UTC: right also just after midnight). */
export function osloTodayIso() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
}

/** Today's date in Oslo as [year, month, day]. */
export function osloToday() {
  const [y, m, d] = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date()).split('-').map(Number);
  return [y, m, d];
}

// ---------------------------------------------------------------- status badges

const EU_WARN_DAYS = 60; // amber from this many days before the deadline
const EU_RED_DAYS = 1;   // red from this many days before the deadline
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Whole days from today (Oslo) until an ISO date; negative when passed. */
export function daysUntil(iso) {
  if (!iso) return null;
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  const [ty, tm, td] = osloToday();
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(ty, tm - 1, td)) / 86400000);
}

/** EU-kontroll: red within EU_RED_DAYS or passed, amber within EU_WARN_DAYS, green otherwise. */
export function euStatus(due) {
  const days = daysUntil(due);
  if (days == null) return null;
  if (days < 0) return { cls: 'bad', days, text: `Overdue by ${plural(-days, 'day')}` };
  if (days <= EU_RED_DAYS) {
    return { cls: 'bad', days, text: days === 0 ? 'Due today' : days === 1 ? 'Due tomorrow' : `Due in ${days} days` };
  }
  if (days <= EU_WARN_DAYS) return { cls: 'warn', days, text: `Due in ${plural(days, 'day')}` };
  return { cls: 'good', days, text: 'Valid' };
}

/** Summer / winter wheels on a car (vehicles.wheels, rental_cars.wheels). */
export const WHEELS = { summer: 'Summer wheels', winter: 'Winter wheels' };

/** The server's tyre_warning ({level, kind, date}) as one sentence (one string, so it translates). */
export function tyreText(w) {
  if (!w) return '';
  const d = fmtDate(w.date, false);
  if (w.kind === 'summer_in_season') return `Summer wheels – studded tyre season since ${d}`;
  if (w.kind === 'summer_soon') return `Summer wheels – studded tyre season starts ${d}`;
  return `Winter wheels – studded tyre season ended ${d}`;
}

/** Red / amber badge for summer wheels, a plain (neutral) one for winter wheels after the season. */
export const tyreBadge = (w) => (w
  ? h('span', { class: `badge ${w.level === 'info' ? '' : w.level}`.trim() }, tyreText(w)) : null);

/** "Not recorded / Summer wheels / Winter wheels"; onChange gets 'summer', 'winter' or null. */
export function wheelsSelect(value, onChange, attrs = {}) {
  const sel = h('select', attrs, h('option', { value: '' }, 'Not recorded'),
    Object.entries(WHEELS).map(([k, l]) => h('option', { value: k }, l)));
  sel.value = value ?? '';
  if (onChange) sel.addEventListener('change', () => onChange(sel.value || null));
  return sel;
}

/** Registration: amber when not registered, red when Vegvesen says anything
 *  other than registered (deregistered, scrapped…), green when registered. */
export function regStatus(markedAt, code, name) {
  if (!markedAt) return { cls: 'warn', text: 'Not registered' };
  if (!code) return { cls: '', text: 'Registered · awaiting data' };
  if (code === 'REGISTRERT') {
    return { cls: 'good', text: name && name !== 'Registrert' ? `Registered (${name})` : 'Registered' };
  }
  return { cls: 'bad', text: name || code };
}

/** Yearly service, "± a month": green until a month before the due date, amber
 *  from a month before to a month after, red after that. */
const SERVICE_WINDOW_DAYS = 31;
export function serviceStatus(service) {
  const days = daysUntil(service?.due);
  if (days == null) return null;
  if (days < -SERVICE_WINDOW_DAYS) return { cls: 'bad', days, text: `Service overdue by ${plural(-days, 'day')}` };
  if (days < 0) return { cls: 'warn', days, text: `Service due (${plural(-days, 'day')} ago)` };
  if (days <= SERVICE_WINDOW_DAYS) return { cls: 'warn', days, text: days === 0 ? 'Service due today' : `Service due in ${plural(days, 'day')}` };
  return { cls: 'good', days, text: 'Service OK' };
}

export const CONDITION = { new: 'New from factory', used: 'Used' };

/** The car's ad on finn.no (FINN redirects old ad URLs to this one too). */
export const finnUrl = (code) => `https://www.finn.no/mobility/item/${encodeURIComponent(code)}`;
export const finnLink = (code, text = 'Available on finn.no ↗') =>
  h('a', { class: 'finn-link', href: finnUrl(code), target: '_blank', rel: 'noopener noreferrer' }, text);

/** VIN in monospace, with the character at `pos` (1-based) highlighted. */
export function vinWithDiff(vin, pos = null) {
  if (!pos) return h('span', { class: 'mono' }, vin);
  return h('span', { class: 'mono' }, vin.slice(0, pos - 1), h('mark', { class: 'vin-diff' }, vin[pos - 1]), vin.slice(pos));
}

/** Warning for cars that may be this same car (same reg. no, or a VIN one
 *  character away). Never blocks; `onUseVin(vin)` adds a "Use this VIN" button. */
export function duplicateNotice(list, { onUseVin = null } = {}) {
  if (!list?.length) return null;
  const link = (d) => h('a', { href: `#/vehicles/${d.id}` }, vehicleTitle(d));
  return h('div', { class: 'card notice warn dup-notice' },
    h('strong', {}, list.length === 1 ? 'Possible duplicate' : 'Possible duplicates'),
    h('ul', { class: 'plain' }, list.map((d) => h('li', {},
      d.reason === 'same_reg'
        ? [`Reg. no ${d.registration_number} is already on `, link(d), ' (VIN ', vinWithDiff(d.vin), '). Same car with a mistyped VIN?']
        : ['Almost the same VIN is already in Carbonara: ', vinWithDiff(d.vin, d.diff_pos), ' on ', link(d),
          d.diff_pos ? ` — only character ${d.diff_pos} differs.` : '.',
          onUseVin ? h('button', { class: 'link', type: 'button', onClick: () => onUseVin(d.vin) }, ' Use this VIN') : null]))));
}

export const badge = (st, prefix = '') => st && h('span', { class: `badge ${st.cls}` }, prefix + st.text);

/** Live clock: keeps `el` showing the current time and date, updated on the minute. */
export function startClock(el) {
  const tick = () => {
    const now = new Date();
    el.replaceChildren(
      h('span', { class: 'clock-time' }, fmtTime.format(now)),
      h('span', { class: 'clock-date' }, fmtLongDate.format(now)));
    setTimeout(tick, 60000 - (now.getSeconds() * 1000 + now.getMilliseconds()) + 50);
  };
  tick();
}

// Norwegian number format: 119 782 km (space as thousands separator).
export const fmtKm = (n) => (n == null ? '–' : `${Number(n).toLocaleString('nb-NO')} km`);

export const STATUS = {
  intake: 'Arrival inspection',
  in_storage: 'In storage',
  off_site: 'Off site',
  in_progress: 'In progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

/** "BRUKTBILREKKE — Front row (12/20)" for spot pickers. */
export const spotLabel = (l) => `${l.code}${l.description ? ` — ${l.description}` : ''}`
  + ` (${l.vehicle_count ?? 0}${l.capacity ? `/${l.capacity}` : ''} ${(l.vehicle_count === 1 && !l.capacity) ? 'car' : 'cars'})`;

export const FUEL_TYPES = ['Petrol', 'Diesel', 'Hybrid', 'Plug-in hybrid', 'Electric', 'LPG', 'CNG', 'Hydrogen'];

export const pill = (status) => h('span', { class: `pill st-${status}` }, STATUS[status] ?? status);

export const vehicleTitle = (v) =>
  [v.make, v.model, v.model_year && `(${v.model_year})`].filter(Boolean).join(' ') || 'Unknown vehicle';

/** PDI done and the car hasn't left (server: common.READY_SQL). */
export const readyBadge = (v) => (v.ready_for_delivery
  ? h('span', { class: 'badge good' }, '✓ Ready for registration and delivery') : null);

/** 'anne-lise berg' -> 'Anne-Lise Berg' (the server does the same). The rest is kept as typed. */
export const capName = (s) => String(s ?? '').replace(/(^|[\s-])(\p{Ll})/gu, (_, sep, ch) => sep + ch.toUpperCase());

/** A text input for a person's name that capitalizes as you type. */
export function nameInput(attrs = {}) {
  const input = h('input', { type: 'text', autocapitalize: 'words', autocomplete: 'off', ...attrs });
  input.addEventListener('input', () => {
    const fixed = capName(input.value);
    if (fixed === input.value) return;
    const pos = input.selectionStart; // same length, so the cursor can stay put
    input.value = fixed;
    input.setSelectionRange(pos, pos);
  });
  return input;
}

/** "MG ZS EV (2020) · EB82655" */
export const carText = (c) => [vehicleTitle(c), c.registration_number].filter(Boolean).join(' · ');

// Board lists (Today page, PDI page): a card with a heading + count and rows
// of cars, each with its details on the line below.
export function boardRow(href, title, meta, cls = '') {
  return h('a', { class: `today-row ${cls}`, href },
    h('span', { class: 'today-title' }, title),
    h('span', { class: 'today-meta muted small' }, meta));
}

export function boardBlock(icon, title, rows, { cls = '', empty = null, more = null } = {}) {
  if (!rows.length && !empty) return null;
  return h('section', { class: `card today-block ${cls}` },
    h('h2', {}, `${icon} ${title}`, rows.length ? h('span', { class: 'count' }, rows.length) : null),
    rows.length ? h('div', { class: 'today-rows' }, rows) : h('p', { class: 'empty' }, empty),
    more);
}

// ---------------------------------------------------------------- VIN (client-side mirror of vinlib.py)

const TRANSLIT = { A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8, J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9, S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9 };
const WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];
export const normalizeVin = (v) => (v || '').toUpperCase().replace(/[\s\-.]/g, '');
export const vinFormatOk = (v) => /^[A-HJ-NPR-Z0-9]{17}$/.test(v);
export function vinCheckDigitOk(v) {
  if (!vinFormatOk(v)) return false;
  const sum = [...v].reduce((acc, c, i) => acc + (/\d/.test(c) ? +c : TRANSLIT[c]) * WEIGHTS[i], 0);
  const r = sum % 11;
  return v[8] === (r === 10 ? 'X' : String(r));
}

// ---------------------------------------------------------------- local prefs

const INSPECTOR_KEY = 'carbonara.inspectorId';
export function getInspectorId() {
  try { return localStorage.getItem(INSPECTOR_KEY) || ''; } catch { return ''; }
}
export function setInspectorId(id) {
  try { localStorage.setItem(INSPECTOR_KEY, String(id)); } catch { /* private mode */ }
}

// Theme: 'auto' (follow the device), 'light' or 'dark'. Saved on the account
// and in localStorage, so the script in index.html can set it before the first
// paint. <html data-theme> always holds the resolved 'light' / 'dark'.
const THEME_KEY = 'carbonara.theme';
const darkQuery = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
export let theme = (() => {
  try { const t = localStorage.getItem(THEME_KEY); if (['auto', 'light', 'dark'].includes(t)) return t; } catch { /* private mode */ }
  return 'auto';
})();
function resolveTheme() {
  const dark = theme === 'dark' || (theme === 'auto' && !!darkQuery?.matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  // Phone browser bar colour = the top bar (--topbar in app.css).
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', dark ? '#272522' : '#EFE8D4');
}
export function applyTheme(t) {
  theme = ['light', 'dark'].includes(t) ? t : 'auto';
  try { localStorage.setItem(THEME_KEY, theme); } catch { /* private mode */ }
  resolveTheme();
}
// "Same as device" follows the device when it switches (e.g. automatic dark mode at night).
darkQuery?.addEventListener?.('change', resolveTheme);
resolveTheme();

export function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

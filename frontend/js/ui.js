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

export const api = {
  get: (p) => request('GET', p),
  post: (p, b) => request('POST', p, b ?? {}),
  postForm: (p, fd) => request('POST', p, fd),
  patch: (p, b) => request('PATCH', p, b),
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
export function openDialog(title, body, { wide = false } = {}) {
  const dialog = h('dialog', { class: wide ? 'wide' : '' },
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

// All dates/times are shown in Norwegian, 24-hour, Oslo time, regardless of
// the device's language settings: "00:48, søndag 8. november 2026".
const TZ = 'Europe/Oslo';
const fmtTime = new Intl.DateTimeFormat('nb-NO', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const fmtLongDate = new Intl.DateTimeFormat('nb-NO', {
  timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
});
const fmtDay = new Intl.DateTimeFormat('nb-NO', { timeZone: TZ, day: 'numeric', month: 'long', year: 'numeric' });

/** With time: "00:48, søndag 8. november 2026". Date only: "8. november 2026". */
export function fmtDate(iso, withTime = true) {
  if (!iso) return '–';
  const d = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return withTime ? `${fmtTime.format(d)}, ${fmtLongDate.format(d)}` : fmtDay.format(d);
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

export const fmtKm = (n) => (n == null ? '–' : `${Number(n).toLocaleString()} km`);

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

export function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

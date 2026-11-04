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

export function fmtDate(iso, withTime = true) {
  if (!iso) return '–';
  const d = new Date(iso);
  return withTime
    ? d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
    : d.toLocaleDateString(undefined, { dateStyle: 'medium' });
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

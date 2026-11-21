// Carbonara Sidekick: the recall check itself (from 1.1.0). It runs here, in the extension's background, so it keeps
// going when the small popup window closes (Chrome closes it as soon as you click anywhere else; in 1.0.0 the
// check ran in the popup and stopped half way). Progress is kept in chrome.storage.local "job"; the popup shows it.
//
// - Which cars: GET /api/recall-helper/cars (due ones, or all cars here), each with its recall sources. Only cars
//   whose source address is on the portal tab's site are checked, so the tab decides the portal.
// - The portal: a campaign search page with window.url_AsyncMethods; POST AsyncMethod=CampaignByVIN returns an
//   HTML table, one row (tr.rowCampaign, data-id = campaign no.) per operation; a campaign is done on the car when
//   one of its rows has the "Utført" mark / a repair date. Asked and read inside the page (the portal's session).
// - Carbonara: POST /api/recall-helper/result adds open campaigns, closes those the portal shows as done, and
//   records the check. Uses the Carbonara login in this Chrome (cookie), never its own password.
//
// Texts are keys (English) with arguments; the popup translates them.

const PAUSE_MS = 1500; // between cars: a gentle pace for the portal

class Problem extends Error {
  constructor(key, ...args) { super(key); this.key = key; this.args = args; }
}

async function carbonara(base, path, body) {
  let r;
  try {
    r = await fetch(base + path, {
      method: body ? 'POST' : 'GET', credentials: 'include', cache: 'no-store',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Problem('Could not reach Carbonara. Check the address and that you are on the dealership network.');
  }
  if (r.status === 401) throw new Problem('Log in to Carbonara in this Chrome first, then try again.');
  if (!r.ok) throw new Problem('Carbonara answered {0}.', r.status);
  return r.json();
}

async function inPage(tabId, func, args = []) {
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func, args });
  return res?.result;
}

/** In the page: the portal's request address, if this is its campaign search. */
function probePage() {
  // eslint-disable-next-line no-undef
  const path = typeof url_AsyncMethods === 'string' ? url_AsyncMethods : null;
  return { path, search: !!document.getElementById('chassisNumber') };
}

/** In the page: the portal's own campaign search for one VIN, read there (self-contained: it runs in the page). */
async function checkVin(path, vin) {
  const fd = new FormData();
  fd.set('carlicensenumber', '');
  fd.set('chassisNumber', vin);
  fd.set('AsyncMethod', 'CampaignByVIN');
  let html;
  try {
    const r = await fetch(path, { method: 'POST', body: fd, credentials: 'same-origin' });
    if (!r.ok) return { status: r.status };
    html = await r.text();
  } catch (e) {
    return { status: String(e) };
  }
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const rows = [...doc.querySelectorAll('tr.rowCampaign')];
  if (!rows.length) {
    if (doc.querySelector('#login-username, input[name="LoginAction"], input[type="password"]')) return { login: true };
    if (/Antall:\s*0\b/.test(doc.body?.textContent || '')) return { open: [], done: [] };
    return { unreadable: true }; // never record "no recalls" from an answer we don't understand
  }
  const cell = (row, i) => (row.cells[i]?.textContent || '').replace(/\s+/g, ' ').trim();
  const byCode = new Map();
  for (const row of rows) {
    const code = (row.dataset.id || '').trim();
    if (!code) continue;
    const c = byCode.get(code) ?? { code, done: false, variants: [] };
    c.done = c.done || !!row.querySelector('[title="Utført"]') || !!cell(row, 8);
    c.variants.push({
      type: cell(row, 0), status: cell(row, 1), start: cell(row, 3), end: cell(row, 4), op: cell(row, 5), text: cell(row, 6),
    });
    byCode.set(code, c);
  }
  const open = [];
  const done = [];
  for (const c of byCode.values()) {
    if (c.done) { done.push(c.code); continue; }
    const first = c.variants[0];
    const title = [first.type, first.text].filter(Boolean).join(': ').slice(0, 200) || c.code;
    const details = [
      ...c.variants.map((x) => [x.op, x.text].filter(Boolean).join(' – ')),
      [first.status, first.start && `${first.start} – ${first.end}`].filter(Boolean).join(' · '),
    ].filter(Boolean).join('\n').slice(0, 2000);
    open.push({ code: c.code, title, details });
  }
  return { open, done };
}

// ---------------------------------------------------------------- progress (read by the popup)

let job = null;
const save = () => chrome.storage.local.set({ job });
const setStatus = (cls, key, ...args) => { job.status = { cls, key, args }; return save(); };
const addLine = (name, cls, parts) => { job.lines.push({ name, cls, parts }); return save(); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run(tabId, origin, all) {
  const { base = '' } = await chrome.storage.local.get('base');
  job = { running: true, startedAt: Date.now(), lines: [], status: null };
  await setStatus('', 'Starting…');
  try {
    const cars = await carbonara(base, `/api/recall-helper/cars${all ? '?all=1' : ''}`);
    const onSite = (s) => { try { return !!s.url && new URL(s.url).origin === origin; } catch { return false; } };
    const mine = cars.map((c) => ({ ...c, source: c.sources.find(onSite) })).filter((c) => c.source);
    if (!mine.length) {
      await setStatus('', cars.some((c) => c.sources.some(onSite)) || !cars.length
        ? 'No cars need a recall check for this portal.'
        : 'This site is not one of Carbonara\'s recall sources (Settings → Recall sources).');
      return;
    }
    const probe = await inPage(tabId, probePage);
    if (!probe?.path || !probe.search) {
      await setStatus('bad', 'This page is not the campaign search. Open the campaign page in the portal and log in.');
      return;
    }
    let checked = 0; let added = 0; let closed = 0;
    for (const [i, car] of mine.entries()) {
      await setStatus('', 'Checking car {0} of {1}…', i + 1, mine.length);
      const name = [car.registration_number || car.vin, [car.make, car.model].filter(Boolean).join(' ')].join(' · ');
      const answer = await inPage(tabId, checkVin, [probe.path, car.vin]);
      if (answer?.login) {
        await addLine(name, 'bad', [{ key: 'log in to the portal first', args: [] }]);
        await setStatus('bad', 'Stopped: log in to the portal and try again.');
        return;
      }
      const error = !answer ? { key: 'portal error {0}', args: ['?'] }
        : answer.status !== undefined ? { key: 'portal error {0}', args: [answer.status] }
          : answer.unreadable ? { key: 'could not read the portal\'s answer', args: [] } : null;
      const saved = await carbonara(base, '/api/recall-helper/result', {
        vehicle_id: car.id, source_id: car.source.id,
        error: error ? error.key.replace('{0}', error.args[0] ?? '') : null,
        open: error ? [] : answer.open, done: error ? [] : answer.done,
      });
      if (error) {
        await addLine(name, 'bad', [error]);
      } else {
        checked += 1; added += saved.added; closed += saved.closed;
        await addLine(name, saved.open ? 'warn' : 'good', [
          saved.open ? { key: '{0} open recall(s)', args: [saved.open] } : { key: 'no open recalls', args: [] },
          saved.added ? { key: '{0} new', args: [saved.added] } : null,
          saved.closed ? { key: '{0} closed as done', args: [saved.closed] } : null,
        ].filter(Boolean));
      }
      if (i < mine.length - 1) await sleep(PAUSE_MS);
    }
    await setStatus('good', 'Done: {0} checked, {1} new recall(s), {2} closed.', checked, added, closed);
  } catch (e) {
    await setStatus('bad', e instanceof Problem ? e.key : String(e.message || e), ...(e.args || []));
  } finally {
    job.running = false;
    await save();
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type !== 'run') return false;
  if (job?.running) { reply({ started: false }); return false; } // one check at a time
  run(msg.tabId, msg.origin, !!msg.all);
  reply({ started: true });
  return false;
});

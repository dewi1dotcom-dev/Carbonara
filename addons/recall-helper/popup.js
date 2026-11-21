// Carbonara recall helper (Chrome extension, 0.42.0).
//
// Runs in the person's own, logged-in dealer portal tab: for each car Carbonara says needs a recall check, it
// asks the portal's campaign search (the same request the portal's own page makes) and sends the result to
// Carbonara. No password is stored anywhere; it only works while the person is logged in to both.
//
// - Which cars: GET /api/recall-helper/cars (due ones, or all cars here), each with its recall sources. Only cars
//   whose source address is on the open tab's site are checked, so the tab decides the portal.
// - The portal: a campaign search page with window.url_AsyncMethods; POST AsyncMethod=CampaignByVIN returns
//   an HTML table, one row (tr.rowCampaign, data-id = campaign no.) per operation; a campaign is done on the car
//   when one of its rows has the "Utført" mark / a repair date.
// - Carbonara: POST /api/recall-helper/result adds open campaigns, closes those the portal shows as done, and
//   records the check. Uses the Carbonara login in this Chrome (cookie), never its own password.

const $ = (id) => document.getElementById(id);
const PAUSE_MS = 1500; // between cars: a gentle pace for the portal

// ---------------------------------------------------------------- language (Carbonara's rule: EN or NO, never mixed)

const NO = {
  'Carbonara recall helper': 'Carbonara-hjelper for tilbakekallinger',
  'Carbonara\'s address, as you open it in Chrome:': 'Adressen til Carbonara, slik du åpner den i Chrome:',
  'Save': 'Lagre',
  'Open the dealer portal\'s campaign search and log in. Keep this window open while it checks.':
    'Åpne kampanjesøket i forhandlerportalen og logg inn. La dette vinduet være åpent mens den sjekker.',
  'All cars here, not only those due': 'Alle biler her, ikke bare de som forfaller',
  'Check cars': 'Sjekk biler',
  'Change Carbonara address': 'Endre adressen til Carbonara',
  'Type Carbonara\'s address first.': 'Skriv adressen til Carbonara først.',
  'Chrome did not get permission to reach Carbonara.': 'Chrome fikk ikke lov til å nå Carbonara.',
  'Log in to Carbonara in this Chrome first, then try again.': 'Logg inn i Carbonara i denne Chrome først, og prøv igjen.',
  'Carbonara answered {0}.': 'Carbonara svarte {0}.',
  'Could not reach Carbonara. Check the address and that you are on the dealership network.':
    'Fikk ikke kontakt med Carbonara. Sjekk adressen og at du er på forhandlerens nettverk.',
  'This page is not the campaign search. Open the campaign page in the portal and log in.':
    'Denne siden er ikke kampanjesøket. Åpne kampanjesiden i portalen og logg inn.',
  'No cars need a recall check for this portal.': 'Ingen biler trenger sjekk av tilbakekallinger for denne portalen.',
  'This site is not one of Carbonara\'s recall sources (Settings → Recall sources).':
    'Dette nettstedet er ikke en av Carbonaras kilder for tilbakekallinger (Innstillinger → Kilder for tilbakekallinger).',
  'Checking {0} car(s)…': 'Sjekker {0} bil(er) …',
  'Done: {0} checked, {1} new recall(s), {2} closed.': 'Ferdig: {0} sjekket, {1} nye tilbakekallinger, {2} lukket.',
  'no open recalls': 'ingen åpne tilbakekallinger',
  '{0} open recall(s)': '{0} åpne tilbakekallinger',
  '{0} new': '{0} nye',
  '{0} closed as done': '{0} lukket som utført',
  'log in to the portal first': 'logg inn i portalen først',
  'could not read the portal\'s answer': 'kunne ikke lese svaret fra portalen',
  'portal error {0}': 'feil fra portalen {0}',
  'Stopped: log in to the portal and try again.': 'Stoppet: logg inn i portalen og prøv igjen.',
};
let lang = (navigator.language || '').toLowerCase().startsWith('n') ? 'no' : 'en';
const t = (text, ...args) => (lang === 'no' ? NO[text] ?? text : text).replace(/\{(\d)\}/g, (_, i) => args[i]);

function translatePage() {
  for (const id of ['title', 'setupText', 'save', 'intro', 'allText', 'run', 'change']) $(id).textContent = t($(id).textContent);
}

// ---------------------------------------------------------------- Carbonara

let base = '';

async function carbonara(path, body) {
  let r;
  try {
    r = await fetch(base + path, {
      method: body ? 'POST' : 'GET', credentials: 'include', cache: 'no-store',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error(t('Could not reach Carbonara. Check the address and that you are on the dealership network.'));
  }
  if (r.status === 401) throw new Error(t('Log in to Carbonara in this Chrome first, then try again.'));
  if (!r.ok) throw new Error(t('Carbonara answered {0}.', r.status));
  return r.json();
}

// ---------------------------------------------------------------- the portal tab (runs inside the page)

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

/** In the page: the portal's own campaign search for one VIN (the page's session cookie goes along). */
async function lookupVin(path, vin) {
  const fd = new FormData();
  fd.set('carlicensenumber', '');
  fd.set('chassisNumber', vin);
  fd.set('AsyncMethod', 'CampaignByVIN');
  try {
    const r = await fetch(path, { method: 'POST', body: fd, credentials: 'same-origin' });
    if (!r.ok) return { status: r.status };
    return { html: await r.text(), url: r.url };
  } catch (e) {
    return { status: String(e) };
  }
}

/** The answer: campaigns still open on the car and campaign numbers done, or why it can't be read. */
function parseAnswer(html) {
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
    c.done ||= !!row.querySelector('[title="Utført"]') || !!cell(row, 8);
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

// ---------------------------------------------------------------- the check

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function logLine(text, cls = '') {
  const li = document.createElement('li');
  li.textContent = text;
  if (cls) li.className = cls;
  $('log').append(li);
  li.scrollIntoView({ block: 'nearest' });
}

async function run() {
  $('run').disabled = true;
  $('log').replaceChildren();
  $('status').textContent = '';
  $('status').className = '';
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const origin = new URL(tab.url).origin;
    const cars = await carbonara(`/api/recall-helper/cars${$('all').checked ? '?all=1' : ''}`);
    const mine = cars.map((c) => ({ ...c, source: c.sources.find((s) => s.url && new URL(s.url).origin === origin) }))
      .filter((c) => c.source);
    if (!mine.length) {
      const known = cars.some((c) => c.sources.some((s) => s.url && new URL(s.url).origin === origin));
      $('status').textContent = t(known || !cars.length
        ? 'No cars need a recall check for this portal.'
        : 'This site is not one of Carbonara\'s recall sources (Settings → Recall sources).');
      return;
    }
    const probe = await inPage(tab.id, probePage);
    if (!probe?.path || !probe.search) {
      $('status').textContent = t('This page is not the campaign search. Open the campaign page in the portal and log in.');
      $('status').className = 'bad';
      return;
    }
    $('status').textContent = t('Checking {0} car(s)…', mine.length);
    let checked = 0; let added = 0; let closed = 0;
    for (const car of mine) {
      const name = [car.registration_number || car.vin, [car.make, car.model].filter(Boolean).join(' ')].join(' · ');
      const answer = await inPage(tab.id, lookupVin, [probe.path, car.vin]);
      let result;
      if (!answer?.html) {
        result = { error: t('portal error {0}', answer?.status ?? '?') };
      } else {
        const parsed = parseAnswer(answer.html);
        if (parsed.login) {
          logLine(`${name}: ${t('log in to the portal first')}`, 'bad');
          $('status').textContent = t('Stopped: log in to the portal and try again.');
          $('status').className = 'bad';
          return;
        }
        result = parsed.unreadable ? { error: t('could not read the portal\'s answer') } : parsed;
      }
      const saved = await carbonara('/api/recall-helper/result', {
        vehicle_id: car.id, source_id: car.source.id,
        error: result.error ?? null, open: result.open ?? [], done: result.done ?? [],
      });
      if (result.error) {
        logLine(`${name}: ${result.error}`, 'bad');
      } else {
        checked += 1; added += saved.added; closed += saved.closed;
        const parts = [saved.open ? t('{0} open recall(s)', saved.open) : t('no open recalls'),
          saved.added && t('{0} new', saved.added), saved.closed && t('{0} closed as done', saved.closed)].filter(Boolean);
        logLine(`${name}: ${parts.join(' · ')}`, saved.open ? 'warn' : 'good');
      }
      await sleep(PAUSE_MS);
    }
    $('status').textContent = t('Done: {0} checked, {1} new recall(s), {2} closed.', checked, added, closed);
    $('status').className = 'good';
  } catch (e) {
    $('status').textContent = e.message;
    $('status').className = 'bad';
  } finally {
    $('run').disabled = false;
  }
}

// ---------------------------------------------------------------- setup

function show(setup) {
  $('setup').hidden = !setup;
  $('main').hidden = setup;
}

async function save() {
  let value = $('base').value.trim().replace(/\/+$/, '');
  if (!value) { $('setupText').textContent = t('Type Carbonara\'s address first.'); return; }
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  const origin = new URL(value).origin;
  // Asked once: lets the helper talk to Carbonara (and only Carbonara) from this browser.
  const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
  if (!granted) { $('setupText').textContent = t('Chrome did not get permission to reach Carbonara.'); return; }
  base = origin;
  await chrome.storage.local.set({ base });
  show(false);
  await followLanguage();
}

/** Use the Carbonara user's language (until known: the browser's). Remembered, so it reloads at most once. */
async function followLanguage() {
  try {
    const state = await carbonara('/api/auth/state');
    if (!state?.me) return; // not logged in to Carbonara yet
    const wanted = state.me.language === 'no' ? 'no' : 'en';
    if (wanted !== lang) {
      await chrome.storage.local.set({ lang: wanted });
      location.reload();
    }
  } catch { /* shown when checking */ }
}

(async () => {
  const stored = await chrome.storage.local.get(['base', 'lang']);
  base = stored.base || '';
  if (stored.lang) lang = stored.lang;
  translatePage();
  $('base').value = base;
  show(!base);
  $('save').addEventListener('click', save);
  $('run').addEventListener('click', run);
  $('change').addEventListener('click', () => show(true));
  if (base) await followLanguage();
})();

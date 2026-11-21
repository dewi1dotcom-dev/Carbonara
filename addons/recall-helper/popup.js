// Carbonara recall helper: the popup (1.1.0). It only starts a check and shows its progress; the check runs in
// worker.js, so it continues when this window closes. Texts follow the Carbonara user's language (EN or NO,
// never mixed), until known the browser's.

const $ = (id) => document.getElementById(id);
const STALE_MS = 15 * 60 * 1000; // a "running" check this old was cut off (e.g. Chrome closed)

const NO = {
  'Carbonara recall helper': 'Carbonara-hjelper for tilbakekallinger',
  'Carbonara\'s address, as you open it in Chrome:': 'Adressen til Carbonara, slik du åpner den i Chrome:',
  'Save': 'Lagre',
  'Open the dealer portal\'s campaign search and log in, then press "Check cars". You can close this window; the check continues.':
    'Åpne kampanjesøket i forhandlerportalen og logg inn, og trykk «Sjekk biler». Du kan lukke dette vinduet; sjekken fortsetter.',
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
  'Starting…': 'Starter …',
  'Checking car {0} of {1}…': 'Sjekker bil {0} av {1} …',
  'A check is already running.': 'En sjekk kjører allerede.',
  'The last check was cut off. Start it again.': 'Forrige sjekk ble avbrutt. Start den på nytt.',
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
const t = (text, ...args) => (lang === 'no' ? NO[text] ?? text : text).replace(/\{(\d)\}/g, (_, i) => args[i] ?? '');

function translatePage() {
  for (const id of ['title', 'setupText', 'save', 'intro', 'allText', 'run', 'change']) $(id).textContent = t($(id).textContent);
}

let base = '';

// ---------------------------------------------------------------- progress

function render(job) {
  const stale = job?.running && Date.now() - (job.startedAt || 0) > STALE_MS;
  const running = !!job?.running && !stale;
  $('run').disabled = running;
  const st = stale ? { cls: 'bad', key: 'The last check was cut off. Start it again.', args: [] } : job?.status;
  $('status').textContent = st ? t(st.key, ...(st.args || [])) : '';
  $('status').className = st?.cls || '';
  $('log').replaceChildren(...(job?.lines || []).map((l) => {
    const li = document.createElement('li');
    li.textContent = `${l.name}: ${l.parts.map((p) => t(p.key, ...(p.args || []))).join(' · ')}`;
    if (l.cls) li.className = l.cls;
    return li;
  }));
  $('log').lastElementChild?.scrollIntoView({ block: 'nearest' });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.job) render(changes.job.newValue);
});

async function run() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let origin = '';
  try { origin = new URL(tab.url).origin; } catch { /* not a web page */ }
  const reply = await chrome.runtime.sendMessage({ type: 'run', tabId: tab.id, origin, all: $('all').checked });
  if (!reply?.started) {
    $('status').textContent = t('A check is already running.');
    $('status').className = 'warn';
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

/** Use the Carbonara user's language. Remembered, so it reloads at most once. */
async function followLanguage() {
  try {
    const r = await fetch(`${base}/api/auth/state`, { credentials: 'include', cache: 'no-store' });
    const state = r.ok ? await r.json() : null;
    if (!state?.me) return; // not logged in to Carbonara yet
    const wanted = state.me.language === 'no' ? 'no' : 'en';
    if (wanted !== lang) {
      await chrome.storage.local.set({ lang: wanted });
      location.reload();
    }
  } catch { /* shown when checking */ }
}

(async () => {
  const stored = await chrome.storage.local.get(['base', 'lang', 'job']);
  base = stored.base || '';
  if (stored.lang) lang = stored.lang;
  translatePage();
  $('base').value = base;
  show(!base);
  render(stored.job);
  $('save').addEventListener('click', save);
  $('run').addEventListener('click', run);
  $('change').addEventListener('click', () => show(true));
  if (base) await followLanguage();
})();

// Carbonara Sidekick (Chrome extension; called "recall helper" until 1.3.0): the popup.
// - On a dealer portal: starts the recall check and shows its progress. The check runs in worker.js, so it
//   continues when this window closes.
// - On one of the dealer's finn.no ads: links the ad to a car and saves its asking price.
// Texts follow the Carbonara user's language (EN or NO, never mixed), until known the browser's.

const $ = (id) => document.getElementById(id);
const STALE_MS = 15 * 60 * 1000; // a "running" check this old was cut off (e.g. Chrome closed)

const NO = {
  'Carbonara Sidekick': 'Carbonara Sidekick',
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
  'Link this finn.no ad to a car in Carbonara:': 'Koble denne finn.no-annonsen til en bil i Carbonara:',
  'Asking price on the ad (kr)': 'Prisantydning på annonsen (kr)',
  'Read from the ad – check it before saving.': 'Lest fra annonsen – sjekk den før du lagrer.',
  'Could not find the price on the ad. Type it in, or leave it empty.': 'Fant ikke prisen på annonsen. Skriv den inn, eller la feltet stå tomt.',
  'Linked to {0}, price {1} kr.': 'Koblet til {0}, pris {1} kr.',
  'FINN code {0}': 'FINN-kode {0}',
  'Choose the car…': 'Velg bilen …',
  'Already linked to {0}.': 'Allerede koblet til {0}.',
  'Linked to {0}.': 'Koblet til {0}.',
  'Choose the car first.': 'Velg bilen først.',
  'Cars without a finn.no link': 'Biler uten finn.no-lenke',
  'Cars with a finn.no link': 'Biler med finn.no-lenke',
};
let lang = (navigator.language || '').toLowerCase().startsWith('n') ? 'no' : 'en';
const t = (text, ...args) => (lang === 'no' ? NO[text] ?? text : text).replace(/\{(\d)\}/g, (_, i) => args[i] ?? '');

function translatePage() {
  for (const id of ['title', 'setupText', 'save', 'intro', 'allText', 'run', 'change', 'finnIntro', 'finnLink', 'finnPriceLabel']) {
    $(id).textContent = t($(id).textContent);
  }
}

// ---------------------------------------------------------------- finn.no: link the ad you are looking at (0.43.0)
// Uses only the open tab's address (the FINN code) and title (to guess the car); it never reads or searches
// finn.no itself, which forbids crawling. The same as copying the ad's link into Carbonara, in one click.

const finnCode = (url) => {
  try {
    const u = new URL(url);
    if (!/(^|\.)finn\.no$/.test(u.hostname)) return null;
    const m = u.href.match(/\/item\/(\d{6,12})/) || u.href.match(/[?&]finnkode=(\d{6,12})/);
    return m ? m[1] : null;
  } catch { return null; }
};
const carName = (c) => [c.registration_number || c.vin, [c.make, c.model, c.model_year].filter(Boolean).join(' ')]
  .filter(Boolean).join(' · ');
/** In the ad page (the one the person opened and clicked the helper on): its asking price, or null.
 *  Structured data first (schema.org offers.price), then price meta tags, then the visible "Totalpris" / "Pris". */
function readAdPrice() {
  const num = (s) => {
    const d = String(s ?? '').replace(/[^\d]/g, '');
    const n = d ? Number(d) : null;
    return n && n >= 1000 && n < 100000000 ? n : null;
  };
  const walk = (o) => {
    if (!o || typeof o !== 'object') return null;
    if (Array.isArray(o)) { for (const x of o) { const r = walk(x); if (r) return r; } return null; }
    const offers = Array.isArray(o.offers) ? o.offers[0] : o.offers;
    if (offers && num(offers.price)) return num(offers.price);
    for (const v of Object.values(o)) { const r = walk(v); if (r) return r; }
    return null;
  };
  for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
    try { const p = walk(JSON.parse(s.textContent)); if (p) return p; } catch { /* next */ }
  }
  const meta = document.querySelector('meta[property="product:price:amount"], meta[itemprop="price"], [itemprop="price"][content]');
  if (meta && num(meta.getAttribute('content'))) return num(meta.getAttribute('content'));
  const text = document.body?.innerText || '';
  const m = text.match(/Totalpris\s*:?\s*([\d\s .]{4,})\s*kr/i) || text.match(/\bPris\s*:?\s*([\d\s .]{4,})\s*kr/i);
  return m ? num(m[1]) : null;
}

const words = (s) => (s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 1);

async function finnPanel(tab, code) {
  $('finn').hidden = false;
  $('main').hidden = true;
  $('finnAd').textContent = `${tab.title || ''} · ${t('FINN code {0}', code)}`;
  const status = (text, cls = '') => { $('finnStatus').textContent = text; $('finnStatus').className = cls; };
  let cars;
  try {
    const r = await fetch(`${base}/api/vehicles?limit=500`, { credentials: 'include', cache: 'no-store' });
    if (r.status === 401) throw new Error(t('Log in to Carbonara in this Chrome first, then try again.'));
    if (!r.ok) throw new Error(t('Carbonara answered {0}.', r.status));
    cars = await r.json();
  } catch (e) {
    status(e.message.startsWith('Failed') ? t('Could not reach Carbonara. Check the address and that you are on the dealership network.')
      : e.message, 'bad');
    $('finnLink').disabled = true;
    return;
  }
  const linked = cars.find((c) => c.finn_code === code);
  if (linked) status(t('Already linked to {0}.', carName(linked)), 'good');
  // Best guess first: the most words of make / model / year found in the ad's title; cars without a link first.
  const title = new Set(words(tab.title));
  const score = (c) => words([c.make, c.model, c.variant, c.model_year].join(' ')).filter((w) => title.has(w)).length;
  const here = cars.filter((c) => c.status !== 'off_site' || c.finn_code === code);
  const group = (label, list) => {
    const g = document.createElement('optgroup');
    g.label = label;
    list.sort((a, b) => score(b) - score(a) || carName(a).localeCompare(carName(b))).forEach((c) => {
      const o = document.createElement('option');
      o.value = c.id;
      o.textContent = carName(c);
      g.append(o);
    });
    return list.length ? g : null;
  };
  const first = document.createElement('option');
  first.value = '';
  first.textContent = t('Choose the car…');
  $('finnCar').replaceChildren(first, ...[
    group(t('Cars without a finn.no link'), here.filter((c) => !c.finn_code)),
    group(t('Cars with a finn.no link'), here.filter((c) => c.finn_code)),
  ].filter(Boolean));
  const best = here.filter((c) => !c.finn_code).sort((a, b) => score(b) - score(a))[0];
  $('finnCar').value = linked ? String(linked.id) : best && score(best) > 0 ? String(best.id) : '';
  // The asking price on this ad (read from the page the person is looking at, once, on their click).
  let price = null;
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: readAdPrice });
    price = res?.result ?? null;
  } catch { /* not readable: typed in instead */ }
  $('finnPrice').value = price ? Number(price).toLocaleString('nb-NO') : '';
  $('finnPriceNote').textContent = price ? t('Read from the ad – check it before saving.')
    : t('Could not find the price on the ad. Type it in, or leave it empty.');
  $('finnLink').addEventListener('click', async () => {
    const id = $('finnCar').value;
    if (!id) { status(t('Choose the car first.'), 'bad'); return; }
    $('finnLink').disabled = true;
    const patch = async (carId, body) => {
      const r = await fetch(`${base}/api/vehicles/${carId}`, {
        method: 'PATCH', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(t('Carbonara answered {0}.', r.status));
    };
    const digits = $('finnPrice').value.replace(/[^\d]/g, '');
    const priceNow = digits ? Number(digits) : null;
    try {
      // One ad, one car: moved from another car, the link is taken off that one first.
      for (const other of cars.filter((c) => c.finn_code === code && String(c.id) !== id)) {
        await patch(other.id, { finn_code: null });
        other.finn_code = null;
      }
      // The price is saved only when there is one (an empty field leaves the car's price as it was).
      await patch(id, priceNow ? { finn_code: code, asking_price: priceNow, asking_price_source: 'finn' } : { finn_code: code });
      const car = cars.find((c) => String(c.id) === id);
      car.finn_code = code;
      status(priceNow ? t('Linked to {0}, price {1} kr.', carName(car), priceNow.toLocaleString('nb-NO'))
        : t('Linked to {0}.', carName(car)), 'good');
    } catch (e) {
      status(e.message, 'bad');
    } finally {
      $('finnLink').disabled = false;
    }
  });
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
  // On a finn.no ad: offer to link it to a car instead of the recall check.
  if (base) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const code = finnCode(tab?.url);
    if (code) await finnPanel(tab, code);
  }
})();

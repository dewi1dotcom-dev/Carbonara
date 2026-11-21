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
  '➕ New car from this ad': '➕ Ny bil fra denne annonsen',
  'Add car': 'Legg til bil',
  'Reg. no': 'Reg.nr.', 'VIN': 'VIN', 'Make': 'Merke', 'Model': 'Modell', 'Model year': 'Årsmodell',
  'Mileage (km)': 'Kilometerstand (km)', 'Colour': 'Farge', 'Fuel': 'Drivstoff', 'New/used': 'Ny/brukt',
  'Used': 'Brukt', 'New': 'Ny',
  'Photos to copy (tick the ones you want):': 'Bilder som skal kopieres (kryss av de du vil ha):',
  'Looking the car up at Statens vegvesen…': 'Slår opp bilen hos Statens vegvesen …',
  'From the ad and Statens vegvesen – check the details.': 'Fra annonsen og Statens vegvesen – sjekk opplysningene.',
  'This car is already in Carbonara: {0}. Link the ad to it instead.':
    'Denne bilen er allerede i Carbonara: {0}. Koble annonsen til den i stedet.',
  'The VIN is needed. Statens vegvesen gives it from the reg. no, or type it in.':
    'VIN trengs. Statens vegvesen gir den fra reg.nr., eller skriv den inn.',
  'Copying photo {0} of {1}…': 'Kopierer bilde {0} av {1} …',
  'Adding the car…': 'Legger til bilen …',
  'Already adding a car – wait a moment.': 'Legger allerede til en bil – vent litt.',
  'Added to Carbonara with {0} photo(s). ': 'Lagt til i Carbonara med {0} bilde(r). ',
  'Open it in Carbonara': 'Åpne den i Carbonara',
  // Carbonara's own messages (from the server, in English)
  'The ad shows no registration number': 'Annonsen viser ikke noe registreringsnummer',
  'Statens vegvesen lookup is not set up (System page)': 'Oppslag hos Statens vegvesen er ikke satt opp (System-siden)',
  'Statens vegvesen does not know this registration number': 'Statens vegvesen kjenner ikke dette registreringsnummeret',
  'This car is already in Carbonara': 'Denne bilen er allerede i Carbonara',
  'This car is in Recently deleted; restore it there': 'Denne bilen ligger i Nylig slettet; gjenopprett den der',
  'VIN must be 17 characters: A–Z and 0–9, without I, O or Q': 'VIN må være 17 tegn: A–Z og 0–9, uten I, O eller Q',
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
  for (const id of ['title', 'setupText', 'save', 'intro', 'allText', 'run', 'change', 'finnIntro', 'finnLink', 'finnPriceLabel',
    'lReg', 'lVin', 'lMake', 'lModel', 'lYear', 'lKm', 'lColor', 'lFuel', 'lCond', 'oUsed', 'oNew', 'lPhotos']) {
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
/** In the ad page (the one the person opened and clicked Sidekick on; self-contained, it runs in the page): what
 *  the ad says about the car, and its photos. Structured data first (schema.org Car / Product), then the details
 *  list (a label followed by its value), then meta tags / visible text. Anything not found is null. */
function readAd() {
  const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
  const num = (s, min, max) => {
    const d = String(s ?? '').replace(/[^\d]/g, '');
    const n = d ? Number(d) : null;
    return n != null && n >= min && n <= max ? n : null;
  };
  const out = { images: [] };
  // 1. Structured data.
  const nodes = [];
  const collect = (o) => {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) { o.forEach(collect); return; }
    nodes.push(o);
    Object.values(o).forEach(collect);
  };
  for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
    try { collect(JSON.parse(s.textContent)); } catch { /* next */ }
  }
  const typeOf = (o) => [].concat(o['@type'] || []).join(' ').toLowerCase();
  const car = nodes.find((o) => /\b(car|vehicle)\b/.test(typeOf(o))) || nodes.find((o) => /product/.test(typeOf(o))) || {};
  const nameOf = (x) => (typeof x === 'string' ? x : x?.name);
  out.make = clean(nameOf(car.brand) || nameOf(car.manufacturer)) || null;
  out.model = clean(nameOf(car.model)) || null;
  out.year = num(car.vehicleModelDate || car.modelDate || car.productionDate, 1950, 2100);
  out.km = num(car.mileageFromOdometer?.value ?? car.mileageFromOdometer, 0, 5000000);
  out.color = clean(car.color) || null;
  out.fuel = clean(nameOf(car.fuelType) || car.vehicleEngine?.fuelType) || null;
  out.vin = clean(car.vehicleIdentificationNumber) || null;
  const offers = nodes.map((o) => (Array.isArray(o.offers) ? o.offers[0] : o.offers)).find((o) => o?.price);
  out.price = num(offers?.price, 1000, 99999999);
  [].concat(car.image || []).forEach((i) => out.images.push(typeof i === 'string' ? i : i?.url || i?.contentUrl));
  // 2. The details list: a short label followed by its value.
  const byLabel = {};
  for (const el of document.querySelectorAll('dt, th, span, div, p, li, h3, h4')) {
    if (el.children.length > 2) continue;
    const label = clean(el.textContent).replace(/:$/, '').toLowerCase();
    if (!label || label.length > 30 || byLabel[label]) continue;
    const value = clean(el.nextElementSibling?.textContent);
    if (value && value.length < 60) byLabel[label] = value;
  }
  const pick = (...labels) => labels.map((l) => byLabel[l]).find(Boolean) || null;
  out.make ||= pick('merke');
  out.model ||= pick('modell');
  out.year ||= num(pick('modellår', 'årsmodell'), 1950, 2100);
  out.km ??= num(pick('kilometerstand', 'kilometer', 'km.stand'), 0, 5000000);
  out.color ||= pick('farge', 'karosserifarge');
  out.fuel ||= pick('drivstoff');
  out.reg = pick('registreringsnummer', 'reg.nr.', 'reg.nr', 'regnr', 'kjennemerke');
  out.vin ||= pick('chassisnr. (vin)', 'chassisnr.', 'chassisnummer', 'understellsnummer', 'vin');
  out.price ??= num(pick('totalpris', 'pris'), 1000, 99999999);
  // 3. Meta tags and visible text.
  const text = document.body?.innerText || '';
  if (!out.price) {
    const meta = document.querySelector('meta[property="product:price:amount"], [itemprop="price"][content]');
    out.price = num(meta?.getAttribute('content'), 1000, 99999999)
      ?? num((text.match(/Totalpris\s*:?\s*([\d\s.]{4,})\s*kr/i) || [])[1], 1000, 99999999);
  }
  if (!out.reg) out.reg = (text.match(/Reg(?:istrerings)?\.?\s*nr\.?\s*:?\s*([A-Z]{2}\s?\d{4,5})\b/i) || [])[1] || null;
  document.querySelectorAll('meta[property="og:image"]').forEach((m) => out.images.push(m.content));
  for (const img of document.images) {
    const src = img.currentSrc || img.src;
    if (img.naturalWidth >= 400 && !/logo|icon|avatar|profile/i.test(src)) out.images.push(src);
  }
  // The same photo comes at several sizes (the ad's data, the share preview, the gallery; finn.no's photo server has
  // the size in the path, e.g. /dynamic/1280w/ or /dynamic/default/): one per photo, in first-seen order, the largest.
  const sizeOf = (u) => {
    const m = u.match(/\/dynamic\/(\d+)/) || u.match(/[?&](?:w|width)=(\d+)/);
    return m ? Number(m[1]) : (/\/dynamic\/default\//.test(u) ? 1000 : 0);
  };
  const photos = new Map();
  for (const u of out.images.filter((x) => /^https:\/\//.test(x || ''))) {
    const bare = u.replace(/[?#].*$/, '');
    const file = bare.split('/').pop();
    const key = file.length >= 12 ? file : bare.replace(/\/dynamic\/[^/]+\//, '/dynamic/'); // long file names are unique ids
    if (!photos.has(key) || sizeOf(u) > sizeOf(photos.get(key))) photos.set(key, u);
  }
  out.images = [...photos.values()].slice(0, 40);
  out.title = clean(document.querySelector('h1')?.textContent) || clean(document.title);
  return out;
}

const words = (s) => (s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 1);

const regNorm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9ÆØÅ]/g, '');
const digitsOf = (s) => { const d = String(s || '').replace(/[^\d]/g, ''); return d ? Number(d) : null; };
/** Norwegian fuel on an ad -> Carbonara's fuel names (Statens vegvesen's value wins when there is one). */
function fuelName(text) {
  const s = String(text || '').toLowerCase();
  if (!s) return null;
  if (/plug|ladbar/.test(s)) return 'Plug-in hybrid';
  if (/hybrid/.test(s)) return 'Hybrid';
  if (/^el|elektr/.test(s)) return 'Electric';
  if (/bensin|petrol/.test(s)) return 'Petrol';
  if (/diesel/.test(s)) return 'Diesel';
  if (/hydrogen/.test(s)) return 'Hydrogen';
  return text;
}

async function carbonaraJson(path, body, method = body ? 'POST' : 'GET') {
  const r = await fetch(`${base}${path}`, {
    method, credentials: 'include', cache: 'no-store',
    headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 401) throw new Error(t('Log in to Carbonara in this Chrome first, then try again.'));
  if (!r.ok) {
    let detail = '';
    try { detail = (await r.json()).detail; } catch { /* no text */ }
    throw new Error(typeof detail === 'string' && detail ? t(detail) : t('Carbonara answered {0}.', r.status));
  }
  return r.status === 204 ? null : r.json();
}

async function finnPanel(tab, code) {
  $('finn').hidden = false;
  $('main').hidden = true;
  $('finnAd').textContent = `${tab.title || ''} · ${t('FINN code {0}', code)}`;
  const status = (text, cls = '') => { $('finnStatus').replaceChildren(text); $('finnStatus').className = cls; };
  let cars;
  try {
    cars = await carbonaraJson('/api/vehicles?limit=500');
  } catch (e) {
    status(e.message.startsWith('Failed') ? t('Could not reach Carbonara. Check the address and that you are on the dealership network.')
      : e.message, 'bad');
    $('finnLink').disabled = true;
    return;
  }
  // What the ad says (read from the page the person is looking at, once, on their click).
  let ad = {};
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: readAd });
    ad = res?.result || {};
  } catch { /* not readable: typed in instead */ }

  const linked = cars.find((c) => c.finn_code === code);
  const byReg = ad.reg ? cars.find((c) => regNorm(c.registration_number) === regNorm(ad.reg)) : null;
  if (linked) status(t('Already linked to {0}.', carName(linked)), 'good');
  // Best guess first: the most words of make / model / year found in the ad's title; cars without a link first.
  const title = new Set(words(`${tab.title} ${ad.title || ''}`));
  const score = (c) => words([c.make, c.model, c.variant, c.model_year].join(' ')).filter((w) => title.has(w)).length;
  const option = (value, text) => { const o = document.createElement('option'); o.value = value; o.textContent = text; return o; };
  const group = (label, list) => {
    const g = document.createElement('optgroup');
    g.label = label;
    list.sort((a, b) => score(b) - score(a) || carName(a).localeCompare(carName(b))).forEach((c) => g.append(option(c.id, carName(c))));
    return list.length ? g : null;
  };
  $('finnCar').replaceChildren(option('', t('Choose the car…')), option('new', t('➕ New car from this ad')), ...[
    group(t('Cars without a finn.no link'), cars.filter((c) => !c.finn_code)),
    group(t('Cars with a finn.no link'), cars.filter((c) => c.finn_code)),
  ].filter(Boolean));
  const best = cars.filter((c) => !c.finn_code).sort((a, b) => score(b) - score(a))[0];
  const guess = linked || byReg || (best && score(best) > 0 ? best : null);
  $('finnCar').value = guess ? String(guess.id) : 'new';

  $('finnPrice').value = ad.price ? Number(ad.price).toLocaleString('nb-NO') : '';
  $('finnPriceNote').textContent = ad.price ? t('Read from the ad – check it before saving.')
    : t('Could not find the price on the ad. Type it in, or leave it empty.');

  // ---- a new car: the ad's details + Statens vegvesen (the VIN), and the photos to copy
  let previewed = false;
  const fill = (id, value) => { if (value != null && value !== '' && !$(id).value) $(id).value = value; };
  async function preview() {
    previewed = true;
    fill('nReg', ad.reg); fill('nVin', ad.vin); fill('nMake', ad.make); fill('nModel', ad.model);
    fill('nYear', ad.year); fill('nKm', ad.km != null ? Number(ad.km).toLocaleString('nb-NO') : '');
    fill('nColor', ad.color); fill('nFuel', fuelName(ad.fuel));
    $('nPhotos').replaceChildren(...(ad.images || []).map((src, i) => {
      const box = document.createElement('input');
      box.type = 'checkbox'; box.value = src; box.checked = i < 8;
      const img = document.createElement('img');
      img.src = src; img.alt = ''; img.loading = 'lazy';
      const label = document.createElement('label');
      label.className = 'pic';
      label.append(box, img);
      return label;
    }));
    $('lPhotos').hidden = !(ad.images || []).length;
    $('newInfo').textContent = t('Looking the car up at Statens vegvesen…');
    try {
      const p = await carbonaraJson('/api/vehicles/from-ad/preview', { registration_number: $('nReg').value || null, vin: $('nVin').value || null });
      if (p.existing && !p.existing.deleted_at && cars.some((c) => c.id === p.existing.id)) {
        $('finnCar').value = String(p.existing.id);
        toggle();
        status(t('This car is already in Carbonara: {0}. Link the ad to it instead.', carName(p.existing)), 'warn');
        return;
      }
      if (p.vin) $('nVin').value = p.vin;
      if (p.registration_number) $('nReg').value = p.registration_number;
      const values = p.registry?.values || {};
      for (const [id, key] of [['nMake', 'make'], ['nModel', 'model'], ['nColor', 'color'], ['nFuel', 'fuel_type']]) {
        if (values[key]) $(id).value = values[key]; // the registry's official values win
      }
      $('newInfo').textContent = p.registry_error ? t(p.registry_error)
        : t('From the ad and Statens vegvesen – check the details.');
      $('newInfo').className = p.registry_error ? 'warn' : 'muted';
    } catch (e) {
      $('newInfo').textContent = e.message;
      $('newInfo').className = 'bad';
    }
  }
  function toggle() {
    const isNew = $('finnCar').value === 'new';
    $('finnNew').hidden = !isNew;
    $('finnLink').textContent = isNew ? t('Add car') : t('Save');
    if (isNew && !previewed) preview();
  }
  $('finnCar').addEventListener('change', toggle);
  toggle();

  // The adding runs in worker.js (1.5.1): Chrome's question about the photos closes this window, which stopped
  // 1.5.0 before the car reached Carbonara. Its progress comes back through chrome.storage ("adJob").
  function showAdJob(job) {
    if (!job || job.code !== code) return;
    const st = job.status || {};
    if (job.running || !job.id) {
      status(t(st.key || '', ...(st.args || [])), st.cls || '');
    } else {
      const open = document.createElement('a');
      open.href = `${base}/#/vehicles/${job.id}`;
      open.target = '_blank';
      open.textContent = t('Open it in Carbonara');
      const done = document.createElement('span');
      done.append(t(st.key || '', ...(st.args || [])), open);
      $('finnStatus').replaceChildren(done);
      $('finnStatus').className = st.cls || 'good';
    }
    const busy = job.running || !!job.id;
    $('finnCar').disabled = busy;
    $('finnLink').disabled = busy;
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.adJob) showAdJob(changes.adJob.newValue);
  });
  const { adJob } = await chrome.storage.local.get('adJob');
  if (adJob?.code === code && (adJob.running || adJob.id)) showAdJob(adJob);

  async function addNew() {
    const pics = [...document.querySelectorAll('#nPhotos input:checked')].map((i) => i.value);
    const vin = $('nVin').value.trim();
    if (!vin) { status(t('The VIN is needed. Statens vegvesen gives it from the reg. no, or type it in.'), 'bad'); return; }
    const car = {
      vin, registration_number: $('nReg').value || null, make: $('nMake').value || null, model: $('nModel').value || null,
      model_year: digitsOf($('nYear').value), listed_km: digitsOf($('nKm').value), color: $('nColor').value || null,
      fuel_type: $('nFuel').value || null, condition: $('nCond').value, finn_code: code, asking_price: digitsOf($('finnPrice').value),
    };
    // Both started in the click itself (no await before them): Chrome only asks about permissions during a click.
    const started = chrome.runtime.sendMessage({ type: 'addFromAd', car, pics });
    const origins = [...new Set(pics.map((u) => `${new URL(u).origin}/*`))];
    const asked = origins.length ? chrome.permissions.request({ origins }) : Promise.resolve(true);
    if (!(await started)?.started) { status(t('Already adding a car – wait a moment.'), 'warn'); return; }
    if (!(await asked.catch(() => false))) chrome.runtime.sendMessage({ type: 'photosDenied' });
  }

  async function linkExisting(id) {
    const priceNow = digitsOf($('finnPrice').value);
    // One ad, one car: moved from another car, the link is taken off that one first.
    for (const other of cars.filter((c) => c.finn_code === code && String(c.id) !== id)) {
      await carbonaraJson(`/api/vehicles/${other.id}`, { finn_code: null }, 'PATCH');
      other.finn_code = null;
    }
    // The price / mileage are saved only when there is one (empty leaves the car's value as it was).
    await carbonaraJson(`/api/vehicles/${id}`, {
      finn_code: code,
      ...(priceNow ? { asking_price: priceNow, asking_price_source: 'finn' } : {}),
      ...(ad.km != null ? { listed_km: ad.km } : {}),
    }, 'PATCH');
    const car = cars.find((c) => String(c.id) === id);
    car.finn_code = code;
    status(priceNow ? t('Linked to {0}, price {1} kr.', carName(car), priceNow.toLocaleString('nb-NO'))
      : t('Linked to {0}.', carName(car)), 'good');
  }

  $('finnLink').addEventListener('click', async () => {
    const id = $('finnCar').value;
    if (!id) { status(t('Choose the car first.'), 'bad'); return; }
    $('finnLink').disabled = true;
    try {
      if (id === 'new') await addNew(); else await linkExisting(id);
    } catch (e) {
      status(e.message, 'bad');
    } finally {
      if (!$('finnCar').disabled) $('finnLink').disabled = false;
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

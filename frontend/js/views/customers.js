// Customer register (0.48.0): customers with a customer number, their cars (kept apart from the car database) and who
// owned each car when, with history. A car from the car database can be copied in when the customer agrees.
// Server: routers/customers.py. Parts orders: views/partsorders.js.
import {
  api, append, busy, canOpen, canSee, debounce, euStatus, fmtDate, h, nameInput, openDialog, session, showError,
  toast,
} from '../ui.js';
import { field, fmtMoney } from './parts.js';
import { workOrdersCard } from './workorders.js';

export const ORDER_STATUS = {
  open: 'Open', ordered: 'Ordered from supplier', arrived: 'Arrived', done: 'Handed out', cancelled: 'Cancelled',
};
const STATUS_CLS = { open: '', ordered: 'warn', arrived: 'good', done: '', cancelled: 'bad' };
export const orderBadge = (status) => h('span', { class: `badge ${STATUS_CLS[status] ?? ''}` }, ORDER_STATUS[status] ?? status);

export const carTitle = (c) => [c.make, c.model].filter(Boolean).join(' ') || 'Car';
export const canEditOrders = () => !!session.me?.is_admin || canSee('parts');
const workshopOn = () => (session.me?.modules ?? ['module_workshop']).includes('module_workshop');

/** Re-render helper for pages that redraw themselves (pitfall #3: render into a fresh div, move into host). */
const redrawer = (view, params, host) => async () => {
  try {
    const fresh = h('div');
    await view(fresh, params, host);
    host.replaceChildren(...fresh.childNodes);
  } catch (e) { showError(e); }
};

// ---------------------------------------------------------------- history

const EVENT = {
  customer_created: 'Customer created', customer_updated: 'Customer details changed', car_created: 'Car added to the register',
  car_updated: 'Car details changed', owner_changed: 'Owner changed',
  transferred_from_car_database: 'Copied from the car database (the customer agreed)',
  order_created: 'Parts order created', order_line_added: 'Line added', order_line_changed: 'Line changed',
  order_line_removed: 'Line removed', order_status: 'Status changed', order_customer_changed: 'Customer changed',
  order_car_changed: 'Car changed', order_updated: 'Order details changed',
  customer_delivery: 'Delivered at the kiosk', customer_delivery_received: 'Delivery received',
  registration_number_changed: 'New registration number from Statens vegvesen',
};
const qty = (n) => Number(n).toLocaleString('nb-NO', { maximumFractionDigits: 2 });

function eventDetail(e) {
  const d = e.data || {};
  const name = (key) => (d[key] ? (e.names?.[key] || h('span', { class: 'muted' }, 'deleted customer')) : h('span', { class: 'muted' }, 'nobody'));
  switch (e.kind) {
    case 'owner_changed':
    case 'order_customer_changed':
      return [name('from_customer_id'), ' → ', name('to_customer_id')];
    case 'registration_number_changed':
      return h('span', { class: 'mono', translate: 'no' }, `${d.from || '–'} → ${d.to}`);
    case 'order_status':
      return [h('span', {}, ORDER_STATUS[d.from] ?? d.from), ' → ', h('span', {}, ORDER_STATUS[d.to] ?? d.to)];
    case 'order_line_added':
    case 'order_line_removed':
      return [h('span', { translate: 'no' }, d.part_number || ''), ' ', `× ${qty(d.quantity)}`];
    case 'order_line_changed':
      return [h('span', { translate: 'no' }, d.part_number || ''), ' ', `× ${qty(d.quantity_from)} → ${qty(d.quantity_to)}`,
        d.price_from !== d.price_to ? ` · ${fmtMoney(d.price_from)} → ${fmtMoney(d.price_to)}` : ''];
    default:
      return null;
  }
}

export function historyList(events, { orderLinks = true } = {}) {
  if (!events.length) return h('p', { class: 'empty' }, 'No history yet.');
  return h('ul', { class: 'rows' }, events.map((e) => {
    const detail = eventDetail(e);
    return h('li', {}, h('span', {},
      h('span', {}, EVENT[e.kind] ?? e.kind),
      orderLinks && e.order_id ? [' · ', h('a', { href: `#/parts-orders/${e.order_id}` }, `Parts order #${e.order_no}`)] : null,
      detail ? h('span', { class: 'block' }, detail) : null,
      h('span', { class: 'muted small block', translate: 'no' }, [fmtDate(e.created_at), e.staff_name].filter(Boolean).join(' · '))));
  }));
}

export function ordersList(orders) {
  if (!orders.length) return h('p', { class: 'empty' }, 'No parts orders.');
  return h('ul', { class: 'rows' }, orders.map((o) => h('li', {},
    h('span', {},
      h('a', { href: `#/parts-orders/${o.id}` }, `Parts order #${o.order_no}`), ' ', orderBadge(o.status),
      h('span', { class: 'muted small block' },
        [fmtDate(o.created_at, false), o.registration_number, `${o.lines} line(s)`].filter(Boolean).join(' · '))),
    h('span', { class: 'nowrap' }, fmtMoney(o.total_inc)))));
}

// ---------------------------------------------------------------- privacy notice

/** The customer register's privacy notice (GDPR art. 13), in Norwegian. Printable. */
export function registerPrivacyDialog(company, years) {
  const c = company || {};
  const lines = [['Telefon', c.phone], ['E-post', c.email], ['Adresse', c.address]].filter(([, v]) => v);
  const contact = lines.length
    ? h('p', { class: 'privacy-contact' }, lines.map(([label, v]) => h('span', { class: 'block' }, `${label}: `, h('strong', {}, v))))
    : h('p', {}, h('strong', { class: 'td-items' }, '[kontaktinfo mangler – legges inn under System → Firma eller Kunderegister]'));
  const name = c.company || 'Forhandleren';
  const operator = c.operator;
  const keep = years > 0
    ? `Opplysningene slettes automatisk når det har gått ${years} år uten ordre eller endringer for deg. `
      + 'Regnskapsbilag oppbevares i regnskapssystemet etter bokføringsloven.'
    : 'Opplysningene beholdes til du ber oss slette dem. Regnskapsbilag oppbevares i regnskapssystemet etter bokføringsloven.';
  const body = h('div', { class: 'privacy-text', translate: 'no' }, // a Norwegian document
    h('p', {}, h('strong', {}, name), c.org_no ? ` (org.nr. ${c.org_no})` : '', ' er behandlingsansvarlig for opplysningene i kunderegisteret.'),
    h('h3', {}, 'Hva vi registrerer'),
    h('p', {}, 'Navn, kundenummer, telefon, e-post og adresse (for bedrifter også organisasjonsnummer), hvilke biler du eier eller har eid, '
      + 'og hvilke deler som er bestilt og utlevert til deg.'),
    h('h3', {}, 'Hvorfor'),
    h('p', {}, 'For å kunne bestille og levere deler og utføre arbeid på bilen din, kontakte deg om bestillingen, '
      + 'og vite hvilke deler som passer bilen.'),
    h('h3', {}, 'Rettslig grunnlag'),
    h('p', {}, 'Det er nødvendig for avtalen med deg (personvernforordningen art. 6 nr. 1 bokstav b), og for vår berettigede interesse i å '
      + 'ha oversikt over kunder og biler vi har levert deler til (art. 6 nr. 1 bokstav f). '
      + 'Opplysninger som er overført fra bilsalget, er overført fordi du har sagt ja til det.'),
    h('h3', {}, 'Hvor lenge'),
    h('p', {}, keep),
    h('h3', {}, 'Hvem som ser dem'),
    operator
      ? h('p', {}, `Bare ansatte hos ${name} og ${operator} som har tilgang til kunderegisteret, og som logger inn med personlig kode. `
        + `Opplysningene lagres på en server som ${operator} drifter på vegne av ${name} (databehandler), og deles ikke med andre.`)
      : h('p', {}, 'Bare våre ansatte som har tilgang til kunderegisteret, og som logger inn med personlig kode. '
        + 'Opplysningene lagres på vår egen server og deles ikke med andre.'),
    h('h3', {}, 'Dine rettigheter'),
    h('p', {}, 'Du kan be om innsyn, retting og sletting, og protestere mot behandlingen. '
      + `Du kan også klage til Datatilsynet (datatilsynet.no). Kontakt ${operator ? name : 'oss'}:`),
    contact);
  openDialog('Personvern – kunderegister', h('div', {}, body,
    h('div', { class: 'actions no-print' }, h('button', { class: 'btn', type: 'button', onClick: () => window.print() }, '🖨 Print'))),
  { wide: true });
}

// ---------------------------------------------------------------- customer form

/** The customer fields (also used when a car is copied from the car database). read() = the body for the server. */
function customerFields(c = {}) {
  const kind = h('select', {}, h('option', { value: 'private', selected: c.kind !== 'company' }, 'Private person'),
    h('option', { value: 'company', selected: c.kind === 'company' }, 'Company'));
  const text = (value, max, attrs = {}) => h('input', { type: 'text', maxlength: max, autocomplete: 'off', value: value || '', ...attrs });
  const first = nameInput({ maxlength: 60, value: c.first_name || '' });
  const last = nameInput({ maxlength: 60, value: c.last_name || '' });
  const companyName = nameInput({ maxlength: 120, value: c.company_name || '' });
  const orgNo = text(c.org_no, 20, { inputmode: 'numeric' });
  const phone = text(c.phone, 30, { type: 'tel' });
  const email = text(c.email, 120, { type: 'email' });
  const address = text(c.address, 120);
  const postal = text(c.postal_code, 10, { inputmode: 'numeric' });
  const city = text(c.city, 60);
  const note = h('textarea', { rows: 2, maxlength: 1000 }, c.note || '');
  const personBox = h('div', { class: 'grid' }, field('First name *', first), field('Last name *', last));
  const companyBox = h('div', { class: 'grid' }, field('Company name *', companyName), field('Organisation number', orgNo));
  const sync = () => { personBox.hidden = kind.value === 'company'; companyBox.hidden = kind.value !== 'company'; };
  kind.addEventListener('change', sync);
  sync();
  const el = h('div', {},
    field('Customer type', kind), personBox, companyBox,
    h('div', { class: 'grid' }, field('Phone', phone), field('E-mail', email)),
    field('Address', address),
    h('div', { class: 'grid' }, field('Postal code', postal), field('City', city)),
    field('Note', note));
  const read = () => ({
    kind: kind.value, first_name: first.value, last_name: last.value, company_name: companyName.value, org_no: orgNo.value,
    phone: phone.value, email: email.value, address: address.value, postal_code: postal.value, city: city.value,
    note: note.value,
  });
  return { el, read, focus: () => (kind.value === 'company' ? companyName : first).focus() };
}

export function customerForm(c, done) {
  const f = customerFields(c || {});
  const ok = h('button', { class: 'btn primary', type: 'submit' }, c ? 'Save' : 'Add customer');
  const form = h('form', {}, f.el, h('div', { class: 'actions' }, ok));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(ok, async () => {
      const saved = c ? await api.put(`/customers/${c.id}`, f.read()) : await api.post('/customers', f.read());
      close();
      toast(c ? 'Customer saved' : `Customer ${saved.customer_no} added`, 'success');
      await done(saved);
    });
  });
  const { close } = openDialog(c ? 'Edit customer' : 'New customer', form, { wide: true });
  setTimeout(() => f.focus(), 0);
}

/** Search for a customer (or add a new one); onPick(customer) gets {id, name, customer_no}. */
export function pickCustomer(title, onPick, { extra = null } = {}) {
  const search = h('input', { type: 'search', placeholder: 'Name, customer no., phone, reg. no.…', 'aria-label': 'Search customers' });
  const list = h('div');
  let seq = 0;
  const load = async () => {
    const my = ++seq;
    const data = await api.get(`/customers?q=${encodeURIComponent(search.value.trim())}`);
    if (my !== seq) return;
    list.replaceChildren(data.customers.length ? h('ul', { class: 'rows pick-list' }, data.customers.map((c) => h('li', {},
      h('button', { class: 'link pick', type: 'button', onClick: () => { close(); onPick(c); } },
        h('strong', { translate: 'no' }, c.name), ' ', h('span', { class: 'muted' }, `(${c.customer_no})`),
        h('span', { class: 'muted small block', translate: 'no' },
          [c.phone, c.city, ...c.cars.map((car) => car.registration_number)].filter(Boolean).join(' · '))))))
      : h('p', { class: 'empty' }, 'No customers found.'));
  };
  search.addEventListener('input', debounce(() => load().catch(showError), 250));
  const body = h('div', {},
    search, list,
    h('div', { class: 'actions spread' },
      extra || h('span'),
      h('button', { class: 'btn', type: 'button', onClick: () => { close(); customerForm(null, (c) => onPick(c)); } }, '+ New customer')));
  const { close } = openDialog(title, body, { wide: true });
  load().catch(showError);
  setTimeout(() => search.focus(), 0);
}

// ---------------------------------------------------------------- car form

// first registered is not here: Statens vegvesen sets it (0.59.1, the user's rule)
const CAR_FIELDS = ['registration_number', 'vin', 'make', 'model', 'model_year', 'color', 'fuel_type', 'note'];

function carForm(customerId, car, done) {
  const c = car || {};
  const text = (value, max, attrs = {}) => h('input', { type: 'text', maxlength: max, autocomplete: 'off', value: value ?? '', ...attrs });
  const inputs = {
    registration_number: text(c.registration_number, 20, { class: 'mono' }), // room for a VIN (0.58.4)
    vin: text(c.vin, 40, { class: 'mono' }),
    make: text(c.make, 60), model: text(c.model, 80),
    model_year: text(c.model_year, 4, { inputmode: 'numeric' }),
    color: text(c.color, 40), fuel_type: text(c.fuel_type, 40),
    note: h('textarea', { rows: 2, maxlength: 1000 }, c.note || ''),
  };
  const lookupBtn = h('button', { class: 'btn small', type: 'button' }, 'Look up at Statens vegvesen');
  // The first field takes a registration number or a VIN (0.58.4, the user's request); an empty one looks up the VIN
  // field instead. A VIN typed there moves to the VIN field, and the reg. no. comes from Statens vegvesen.
  const svvSlot = h('div', { class: 'svv-preview' }, car ? registryDates(c) : null); // the dates Statens vegvesen keeps (0.59.0)
  const isVin = (v) => /^[A-HJ-NPR-Z0-9]{17}$/.test(v.toUpperCase().replace(/[\s\-.]/g, ''));
  lookupBtn.addEventListener('click', () => busy(lookupBtn, async () => {
    const typed = inputs.registration_number.value.trim() || inputs.vin.value.trim();
    if (!typed) { toast('Type the registration number or VIN first', 'error'); return; }
    const r = await api.get(`/customer-cars/lookup?reg=${encodeURIComponent(typed)}`);
    if (isVin(typed)) {
      inputs.registration_number.value = r.registration_number || '';
      inputs.vin.value = r.vin || typed.toUpperCase().replace(/[\s\-.]/g, '');
    }
    for (const k of CAR_FIELDS) if (r[k] != null && k in inputs && k !== 'note') inputs[k].value = r[k];
    // the dates staff can't change (0.59.0): shown here, saved from Statens vegvesen with the car
    const dates = registryDates(r);
    svvSlot.replaceChildren(...(dates ? [h('p', { class: 'muted small' }, 'From Statens vegvesen (saved with the car, not changeable):'), dates] : []));
    toast('Filled in from Statens vegvesen', 'success');
    syncChassis();
  }));
  // An older car's chassis number (0.54.0): not the 17-character VIN. Saved only as Statens vegvesen has it for the
  // reg. no., after someone ticks that it was checked on the car (the server checks Statens vegvesen again).
  const chassisCheck = h('input', { type: 'checkbox' });
  const chassisBox = h('div', { class: 'notice warn', hidden: true },
    h('span', {}, 'Older chassis number (not the 17-character VIN). It is accepted as Statens vegvesen has it for this registration number. Compare it with the car.'),
    h('label', { class: 'check' }, chassisCheck, h('span', {}, 'I have checked the chassis number on the car')));
  const syncChassis = () => {
    const v = inputs.vin.value.toUpperCase().replace(/[\s\-.]/g, '');
    chassisBox.hidden = !v || /^[A-HJ-NPR-Z0-9]{17}$/.test(v) || !!c.vin_nonstandard && v === c.vin;
  };
  inputs.vin.addEventListener('input', syncChassis);
  syncChassis();
  const ok = h('button', { class: 'btn primary', type: 'submit' }, car ? 'Save' : 'Add car');
  const form = h('form', {},
    h('div', { class: 'field' }, h('label', {}, 'Registration number or VIN'),
      h('div', { class: 'toolbar' }, inputs.registration_number, lookupBtn)),
    field('VIN (chassis number)', inputs.vin),
    chassisBox,
    svvSlot,
    h('div', { class: 'grid' }, field('Make', inputs.make), field('Model', inputs.model), field('Model year', inputs.model_year),
      field('Colour', inputs.color), field('Fuel', inputs.fuel_type)),
    field('Note', inputs.note),
    h('div', { class: 'actions' }, ok));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    // a VIN typed in the first field without a lookup goes to the VIN field
    if (isVin(inputs.registration_number.value) && !inputs.vin.value.trim()) {
      inputs.vin.value = inputs.registration_number.value.toUpperCase().replace(/[\s\-.]/g, '');
      inputs.registration_number.value = '';
    }
    const body = Object.fromEntries(CAR_FIELDS.map((k) => [k, inputs[k].value?.trim?.() ?? inputs[k].value]));
    body.model_year = body.model_year ? Number(body.model_year) : null;
    for (const k of Object.keys(body)) if (body[k] === '') body[k] = null;
    // An unchanged older chassis number was checked when it was saved.
    body.chassis_checked = chassisCheck.checked || (!!c.vin_nonstandard && (body.vin || '').toUpperCase().replace(/[\s\-.]/g, '') === c.vin);
    if (!chassisBox.hidden && !chassisCheck.checked) { toast('Tick that you have checked the chassis number on the car', 'error'); return; }
    busy(ok, async () => {
      if (car) {
        await api.put(`/customer-cars/${car.id}`, body);
      } else {
        // Already in the register (e.g. bought from another customer)? Then it changes owner instead.
        const found = await api.get(`/customer-cars/find?reg=${encodeURIComponent(body.registration_number || '')}`
          + `&vin=${encodeURIComponent(body.vin || '')}`);
        if (found) {
          const owner = found.owner_name ? `${found.owner_name} (${found.owner_no})` : 'nobody';
          if (!confirm(`This car is already in the customer register, owned by ${owner}. Make this customer the owner?`)) return;
          await api.post(`/customer-cars/${found.id}/owner`, { customer_id: customerId });
        } else {
          await api.post(`/customers/${customerId}/cars`, body);
        }
      }
      close();
      toast(car ? 'Car saved' : 'Car added', 'success');
      await done();
    });
  });
  const { close } = openDialog(car ? 'Edit car' : 'Add car', form, { wide: true });
  setTimeout(() => inputs.registration_number.focus(), 0);
}

// ---------------------------------------------------------------- #/customers

/** #/customers: the workshop's register, two tabs: Customers and Cars (0.53.0, so the cars are easy to find).
 *  Kept apart from Vehicles (the sales company's stock); a car moves over only with the customer's consent. */
export async function customersView(el) {
  const saved = new URLSearchParams(location.hash.split('?')[1] || '');
  let q = saved.get('q') || '';
  const tab = saved.get('tab') === 'cars' ? 'cars' : 'customers';
  const path = (t, text) => `/${t === 'cars' ? 'customer-cars' : 'customers'}?q=${encodeURIComponent(text)}`;
  const [first, info] = await Promise.all([api.get(path(tab, q)), tab === 'cars' ? api.get('/customers?q=') : null]);
  const meta = info || first;
  const company = meta.company;
  const search = h('input', {
    type: 'search', value: q, 'aria-label': tab === 'cars' ? 'Search cars' : 'Search customers',
    placeholder: tab === 'cars' ? 'Reg. no., VIN, make, model, owner…' : 'Name, customer no., phone, e-mail, reg. no.…',
  });
  const listSlot = h('div');
  const draw = (data) => listSlot.replaceChildren(tab === 'cars' ? carTable(data) : customerTable(data));
  const hashFor = (t, text) => {
    const p = new URLSearchParams({ ...(t === 'cars' ? { tab: 'cars' } : {}), ...(text ? { q: text } : {}) }).toString();
    return `#/customers${p ? `?${p}` : ''}`;
  };
  const reload = async () => {
    const my = ++seq;
    try {
      const data = await api.get(path(tab, q));
      if (my === seq) draw(data);
    } catch (e) { showError(e); }
  };
  let seq = 0;
  search.addEventListener('input', debounce(() => {
    q = search.value.trim();
    if (location.hash.startsWith('#/customers')) history.replaceState(null, '', hashFor(tab, q));
    reload();
  }, 300));
  const tabBtn = (t, label) => h('a', { class: `tab${t === tab ? ' active' : ''}`, href: hashFor(t, '') }, label);
  const newCar = () => pickCustomer('Owner of the car', (c) => carForm(c.id, null, reload));
  append(el,
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', {}, 'Customers'),
        h('div', { class: 'muted' }, company?.company ? `Customer register of ${company.company}` : 'The customer register',
          ' · ', h('button', { class: 'link', type: 'button', onClick: () => registerPrivacyDialog(company, meta.retention_years) },
            'Privacy notice'))),
      h('div', { class: 'row-actions' },
        canSee('parts') ? h('a', { class: 'btn', href: '#/parts-orders' }, '📋 Parts orders') : null,
        tab === 'cars'
          ? h('button', { class: 'btn primary', type: 'button', onClick: newCar }, '+ New car')
          : h('button', { class: 'btn primary', type: 'button', onClick: () => customerForm(null, (c) => { location.hash = `#/customers/${c.id}`; }) },
            '+ New customer'))),
    h('div', { class: 'tabs' }, tabBtn('customers', 'Customers'), tabBtn('cars', 'Cars')),
    h('p', { class: 'muted small' }, 'The workshop’s own customers and their cars, kept apart from Vehicles (the cars for sale). '
      + 'A car from Vehicles is copied in only when the customer agrees.'),
    h('div', { class: 'toolbar' }, search),
    listSlot);
  draw(first);
}

/** EU-kontroll from Statens vegvesen as a badge, the same limits as Vehicles and Rental cars (euStatus); `quiet` hides
 *  it while the deadline is far off (lists). 0.59.0 */
function euBadge(due, quiet = false) {
  const st = euStatus(due);
  if (!st || (quiet && st.cls === 'good')) return null;
  return h('span', { class: `badge ${st.cls}` }, h('span', {}, 'EU-kontroll'), ' ', fmtDate(due, false), ' · ', h('span', {}, st.text));
}

/** The Statens vegvesen dates as a list (null when there are none); also the read-only preview in the car form. */
function registryDates(car) {
  const imported = car.first_registered_norway && car.first_registered && car.first_registered_norway !== car.first_registered;
  const row = (label, value) => (value ? [h('dt', {}, label), h('dd', {}, value)] : null);
  const d = (v) => v && fmtDate(v, false);
  if (!(car.first_registered || car.first_registered_norway || car.owner_since || car.eu_control_due
    || car.eu_control_last_approved)) return null;
  return h('dl', { class: 'kv' },
    row('First registered', d(car.first_registered)),
    row('First registered in Norway', car.first_registered_norway && h('span', {}, d(car.first_registered_norway),
      imported ? [' ', h('span', { class: 'badge' }, 'Imported')] : null)),
    row('Current owner registered', d(car.owner_since)),
    row('EU-kontroll last approved', d(car.eu_control_last_approved)),
    row('EU-kontroll deadline', car.eu_control_due && euBadge(car.eu_control_due)));
}

/** The car's Statens vegvesen dates (0.59.0, the user's request): set by the registry only, never in the car form. */
function registryCard(car, rerender) {
  const again = h('button', { class: 'btn small', type: 'button' }, '↻ Look up again');
  again.addEventListener('click', () => busy(again, async () => {
    const r = await api.post(`/customer-cars/${car.id}/registry`, {});
    if (r.registry_result) toast(r.registry_result, 'error'); else toast('Updated from Statens vegvesen', 'success');
    await rerender();
  }));
  const dates = registryDates(car);
  return h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, 'Statens vegvesen'), again),
    dates,
    car.registry_error ? h('p', { class: 'notice warn small', translate: 'no' }, car.registry_error) : null,
    !dates && !car.registry_error ? h('p', { class: 'empty' }, car.registry_checked_at ? 'No dates from Statens vegvesen.' : 'Not looked up yet.') : null,
    car.registry_checked_at ? h('p', { class: 'muted small' }, `Looked up ${fmtDate(car.registry_checked_at)}`) : null);
}

/** The register's cars: reg. no., car, owner, open work orders. */
function carTable(data) {
  if (!data.cars.length) return h('p', { class: 'empty' }, 'No cars found.');
  const rows = data.cars.map((car) => {
    const tr = h('tr', { class: 'click-row', tabindex: '0' },
      h('td', {}, h('a', { href: `#/customer-cars/${car.id}`, class: 'mono' }, car.registration_number || '–'),
        car.vin ? h('span', { class: 'muted small block mono' }, car.vin) : null),
      h('td', {}, h('span', { translate: 'no' }, [carTitle(car), car.model_year].filter(Boolean).join(' ')),
        car.eu_control_due ? h('span', { class: 'block' }, euBadge(car.eu_control_due, true)) : null),
      h('td', {}, car.owner_id ? [h('a', { href: `#/customers/${car.owner_id}`, translate: 'no' }, car.owner_name), ' ',
        h('span', { class: 'muted' }, `(${car.owner_no})`)] : h('span', { class: 'muted' }, 'No owner')),
      h('td', { class: 'num' }, Number(car.open_work_orders) ? String(car.open_work_orders) : '–'));
    const go = () => { location.hash = `#/customer-cars/${car.id}`; };
    tr.addEventListener('click', (e) => { if (!e.target.closest('a')) go(); });
    tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    return tr;
  });
  return h('div', {},
    h('div', { class: 'table-wrap' }, h('table', { class: 'price-table parts-table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Reg. no.'), h('th', {}, 'Car'), h('th', {}, 'Owner'), h('th', { class: 'num' }, 'Open work orders'))),
      h('tbody', {}, rows))),
    data.total > data.cars.length
      ? h('p', { class: 'muted small' }, `Showing the latest ${data.cars.length} of ${data.total}. Search to find others.`) : null);
}

function customerTable(data) {
  if (!data.customers.length) return h('p', { class: 'empty' }, 'No customers found.');
  const rows = data.customers.map((c) => {
    const tr = h('tr', { class: 'click-row', tabindex: '0' },
      h('td', { class: 'mono' }, String(c.customer_no)),
      h('td', {}, h('a', { href: `#/customers/${c.id}`, translate: 'no' }, c.name),
        c.kind === 'company' ? [' ', h('span', { class: 'badge' }, 'Company')] : null),
      h('td', { translate: 'no' }, c.phone || '–'),
      h('td', { class: 'mono', translate: 'no' }, c.cars.map((car) => car.registration_number || carTitle(car)).join(', ') || '–'),
      h('td', { translate: 'no' }, c.city || '–'));
    const go = () => { location.hash = `#/customers/${c.id}`; };
    tr.addEventListener('click', (e) => { if (!e.target.closest('a')) go(); });
    tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    return tr;
  });
  return h('div', {},
    h('div', { class: 'table-wrap' }, h('table', { class: 'price-table parts-table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Customer no.'), h('th', {}, 'Name'), h('th', {}, 'Phone'), h('th', {}, 'Cars'),
        h('th', {}, 'City'))),
      h('tbody', {}, rows))),
    data.total > data.customers.length
      ? h('p', { class: 'muted small' }, `Showing the latest ${data.customers.length} of ${data.total}. Search to find others.`) : null);
}

// ---------------------------------------------------------------- #/customers/:id

export async function customerView(el, [id], host = el) {
  const c = await api.get(`/customers/${id}`);
  const rerender = redrawer(customerView, [id], host);
  const current = c.cars.filter((car) => !car.owned_until);
  const earlier = c.cars.filter((car) => car.owned_until);
  const del = h('button', { class: 'link danger', type: 'button' }, 'Delete customer');
  del.addEventListener('click', () => busy(del, async () => {
    if (!confirm('Delete this customer for good? Their cars stay in the register without this owner, and parts orders stay without a customer.')) return;
    await api.del(`/customers/${c.id}`);
    toast('Customer deleted', 'success');
    location.hash = '#/customers';
  }));
  const addr = [c.address, [c.postal_code, c.city].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const row = (label, value) => (value ? [h('dt', {}, label), h('dd', {}, value)] : null);
  append(el,
    h('p', { class: 'small' }, h('a', { href: '#/customers' }, '← Customers')),
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', { translate: 'no' }, c.name),
        h('div', { class: 'muted' }, `Customer no. ${c.customer_no}`, c.kind === 'company' ? [' · ', h('span', {}, 'Company')] : null)),
      h('div', { class: 'row-actions' },
        canEditOrders() ? h('button', { class: 'btn', type: 'button', onClick: () => newOrderDialog({ customer: c }) }, '+ New parts order') : null,
        h('button', { class: 'btn', type: 'button', onClick: () => customerForm(c, rerender) }, 'Edit'))),
    h('section', { class: 'card' },
      h('dl', { class: 'kv' },
        row('Customer no.', h('span', { class: 'mono' }, String(c.customer_no))),
        row('Organisation number', c.org_no && h('span', { class: 'mono' }, c.org_no)),
        row('Phone', c.phone && h('a', { href: `tel:${c.phone}`, translate: 'no' }, c.phone)),
        row('E-mail', c.email && h('a', { href: `mailto:${c.email}`, translate: 'no' }, c.email)),
        row('Address', addr && h('span', { translate: 'no' }, addr)),
        row('Note', c.note && h('span', { class: 'pre-line', translate: 'no' }, c.note)),
        row('Created', fmtDate(c.created_at)))),
    h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', {}, `Cars (${current.length})`),
        h('button', { class: 'btn small', type: 'button', onClick: () => carForm(c.id, null, rerender) }, '+ Add car')),
      current.length ? h('ul', { class: 'rows' }, current.map((car) => h('li', {},
        h('span', {}, h('a', { href: `#/customer-cars/${car.id}`, translate: 'no' }, carTitle(car)),
          ' ', h('span', { class: 'mono' }, car.registration_number || ''),
          euBadge(car.eu_control_due, true) ? [' ', euBadge(car.eu_control_due, true)] : null,
          h('span', { class: 'muted small block' }, `Owner since ${fmtDate(car.owned_from, false)}`)))))
        : h('p', { class: 'empty' }, 'No cars.'),
      earlier.length ? h('details', {}, h('summary', {}, `Earlier cars (${earlier.length})`),
        h('ul', { class: 'rows' }, earlier.map((car) => h('li', {},
          h('span', {}, h('a', { href: `#/customer-cars/${car.id}`, translate: 'no' }, carTitle(car)),
            ' ', h('span', { class: 'mono' }, car.registration_number || ''),
            h('span', { class: 'muted small block' }, `${fmtDate(car.owned_from, false)} – ${fmtDate(car.owned_until, false)}`)))))) : null),
    await workOrdersCard({ customer_id: c.id }),
    h('section', { class: 'card' }, h('h2', {}, 'Parts orders'), ordersList(c.orders)),
    h('section', { class: 'card' }, h('h2', {}, 'History'), historyList(c.events)),
    session.me?.is_admin ? h('div', { class: 'actions spread' }, del, h('span')) : null);
}

// ---------------------------------------------------------------- #/customer-cars/:id

export async function customerCarView(el, [id], host = el) {
  const car = await api.get(`/customer-cars/${id}`);
  const rerender = redrawer(customerCarView, [id], host);
  const owner = car.owners.find((o) => !o.ended_at);
  const row = (label, value) => (value != null && value !== '' ? [h('dt', {}, label), h('dd', {}, value)] : null);
  const del = h('button', { class: 'link danger', type: 'button' }, 'Delete car from the register');
  del.addEventListener('click', () => busy(del, async () => {
    if (!confirm('Delete this car from the customer register? Its owner history goes too; parts orders stay without the car.')) return;
    await api.del(`/customer-cars/${car.id}`);
    toast('Car deleted', 'success');
    location.hash = owner ? `#/customers/${owner.customer_id}` : '#/customers';
  }));
  const changeOwner = () => pickCustomer('New owner', async (c) => {
    try {
      await api.post(`/customer-cars/${car.id}/owner`, { customer_id: c.id });
      toast('Owner changed', 'success');
      await rerender();
    } catch (e) { showError(e); }
  }, {
    extra: owner ? h('button', {
      class: 'link danger', type: 'button',
      onClick: async (e) => {
        if (!confirm('Remove the owner? Use this when the car is sold to someone who is not a customer, or scrapped.')) return;
        e.target.closest('dialog')?.close();
        e.target.closest('dialog')?.remove();
        try { await api.post(`/customer-cars/${car.id}/owner`, { customer_id: null }); await rerender(); } catch (err) { showError(err); }
      },
    }, 'No owner now') : null,
  });
  append(el,
    h('p', { class: 'small' }, owner ? h('a', { href: `#/customers/${owner.customer_id}`, translate: 'no' }, `← ${owner.name}`)
      : h('a', { href: '#/customers' }, '← Customers')),
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', { translate: 'no' }, carTitle(car)),
        car.registration_number ? h('div', { class: 'reg-big mono' }, car.registration_number) : null),
      h('div', { class: 'row-actions' },
        canEditOrders() && owner ? h('button', { class: 'btn', type: 'button',
          onClick: () => newOrderDialog({ customer: { id: owner.customer_id, name: owner.name }, carId: car.id }) }, '+ New parts order') : null,
        h('button', { class: 'btn', type: 'button', onClick: changeOwner }, 'Change owner'),
        h('button', { class: 'btn', type: 'button', onClick: () => carForm(null, car, rerender) }, 'Edit'))),
    h('section', { class: 'card' },
      h('dl', { class: 'kv' },
        row('Owner', owner ? h('span', {}, h('a', { href: `#/customers/${owner.customer_id}`, translate: 'no' }, owner.name),
          ' ', h('span', { class: 'muted' }, `(${owner.customer_no})`), owner.phone ? h('span', { class: 'muted small block', translate: 'no' }, owner.phone) : null)
          : h('span', { class: 'muted' }, 'No owner in the register')),
        row('VIN', car.vin && h('span', { class: 'mono vin' }, car.vin)),
        row('Model year', car.model_year),
        row('Colour', car.color),
        row('Fuel', car.fuel_type),
        row('Note', car.note && h('span', { class: 'pre-line', translate: 'no' }, car.note)),
        row('From the car database', car.vehicle_id
          ? h('span', {}, canOpen(`#/vehicles/${car.vehicle_id}`) ? h('a', { href: `#/vehicles/${car.vehicle_id}` }, 'Open in Vehicles') : 'Yes',
            car.consent_at ? h('span', { class: 'muted small block' }, `Customer agreed ${fmtDate(car.consent_at)}`) : null)
          : null))),
    registryCard(car, rerender),
    h('section', { class: 'card' }, h('h2', {}, 'Owners'),
      car.owners.length ? h('ul', { class: 'rows' }, car.owners.map((o) => h('li', {},
        h('span', {}, h('a', { href: `#/customers/${o.customer_id}`, translate: 'no' }, o.name), ' ', h('span', { class: 'muted' }, `(${o.customer_no})`),
          h('span', { class: 'muted small block' }, o.ended_at
            ? `${fmtDate(o.started_at, false)} – ${fmtDate(o.ended_at, false)}` : `Owner since ${fmtDate(o.started_at, false)}`)))))
        : h('p', { class: 'empty' }, 'No owners in the register.')),
    await workOrdersCard({ customer_car_id: car.id },
      { customer_car_id: car.id, text: [car.registration_number, carTitle(car), owner?.name].filter(Boolean).join(' · ') }),
    h('section', { class: 'card' }, h('h2', {}, 'Parts orders'), ordersList(car.orders)),
    h('section', { class: 'card' }, h('h2', {}, 'History'), historyList(car.events)),
    session.me?.is_admin ? h('div', { class: 'actions spread' }, del, h('span')) : null);
}

// ---------------------------------------------------------------- new parts order

/** Start a parts order: customer (picked here when not given), one of their cars or none, a reference. */
export async function newOrderDialog({ customer = null, carId = null } = {}) {
  if (!customer) { pickCustomer('Parts order for which customer?', (c) => newOrderDialog({ customer: c })); return; }
  let cars = [];
  try { cars = (await api.get(`/customers/${customer.id}`)).cars.filter((c) => !c.owned_until); } catch (e) { showError(e); return; }
  const carSel = h('select', {},
    h('option', { value: '' }, 'No car'),
    cars.map((c) => h('option', { value: c.id, selected: Number(carId) === c.id || (!carId && cars.length === 1) },
      [c.registration_number, carTitle(c)].filter(Boolean).join(' · '))));
  const ref = h('input', { type: 'text', maxlength: 60, autocomplete: 'off' });
  const ok = h('button', { class: 'btn primary', type: 'submit' }, 'Create order');
  const form = h('form', {},
    h('p', {}, h('span', {}, 'Customer:'), ' ', h('strong', { translate: 'no' }, customer.name)),
    field('Car', carSel),
    field('Reference (work order, customer’s reference)', ref),
    h('div', { class: 'actions' }, ok));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(ok, async () => {
      const r = await api.post('/parts-orders', { customer_id: customer.id, car_id: carSel.value ? Number(carSel.value) : null,
        reference: ref.value.trim() || null });
      close();
      location.hash = `#/parts-orders/${r.id}`;
    });
  });
  const { close } = openDialog('New parts order', form);
}

// ---------------------------------------------------------------- the car database (vehicle page)

/** "Customer" row on the vehicle page: the customer typed by sales, and the copy into the customer register. */
export function vehicleCustomerRow(v, rerender) {
  const name = [v.customer_first_name, v.customer_last_name].filter(Boolean).join(' ');
  const has = name || v.customer_phone || v.customer_address;
  const edit = h('button', { class: 'link small', type: 'button', onClick: () => vehicleCustomerDialog(v, rerender) }, has ? 'change' : '+ Add customer');
  const register = v.customer_car_id
    ? h('span', { class: 'muted small block' }, '✓ ', canOpen(`#/customer-cars/${v.customer_car_id}`)
      ? h('a', { href: `#/customer-cars/${v.customer_car_id}` }, 'In the customer register') : h('span', {}, 'In the customer register'))
    : has && workshopOn()
      ? h('button', { class: 'link small block', type: 'button', onClick: () => transferDialog(v, rerender) }, 'Transfer to the customer register')
      : null;
  return h('span', {},
    has ? h('span', { translate: 'no' }, h('strong', {}, name || ''),
      v.customer_phone ? h('span', { class: 'block' }, v.customer_phone) : null,
      v.customer_address ? h('span', { class: 'block' }, v.customer_address) : null) : h('span', { class: 'muted' }, 'None'),
    ' ', edit, register);
}

function vehicleCustomerDialog(v, done) {
  const first = nameInput({ maxlength: 60, value: v.customer_first_name || '' });
  const last = nameInput({ maxlength: 60, value: v.customer_last_name || '' });
  const address = h('input', { type: 'text', maxlength: 160, autocomplete: 'off', value: v.customer_address || '' });
  const phone = h('input', { type: 'tel', maxlength: 30, autocomplete: 'off', value: v.customer_phone || '' });
  const ok = h('button', { class: 'btn primary', type: 'submit' }, 'Save');
  const save = (body) => busy(ok, async () => {
    await api.put(`/vehicles/${v.id}/customer`, body);
    close();
    toast('Saved', 'success');
    await done();
  });
  const form = h('form', {},
    h('p', { class: 'muted small' }, 'The customer for this car (e.g. the buyer). Kept with the car in the car database only; '
      + 'it goes into the customer register only if the customer agrees.'),
    h('div', { class: 'grid' }, field('First name', first), field('Last name', last)),
    field('Address', address), field('Phone', phone),
    h('div', { class: 'actions spread' },
      v.customer_first_name || v.customer_last_name || v.customer_phone || v.customer_address
        ? h('button', { class: 'link danger', type: 'button', onClick: () => save({}) }, 'Remove customer') : h('span'),
      ok));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    save({ first_name: first.value, last_name: last.value, address: address.value, phone: phone.value });
  });
  const { close } = openDialog('Customer', form);
  setTimeout(() => first.focus(), 0);
}

async function transferDialog(v, done) {
  let pre;
  try { pre = await api.get(`/vehicles/${v.id}/transfer`); } catch (e) { showError(e); return; }
  const company = pre.company || {};
  const choices = [...pre.matches.map((m) => ({ value: String(m.id), label: `${m.name} (${m.customer_no})${m.city ? ` · ${m.city}` : ''}` })),
    { value: 'new', label: 'New customer' }];
  let chosen = pre.matches.length ? String(pre.matches[0].id) : 'new';
  const f = customerFields({ first_name: v.customer_first_name, last_name: v.customer_last_name, phone: v.customer_phone,
    address: v.customer_address });
  const newBox = h('div', { class: 'card inner' }, f.el);
  const radios = choices.map((c) => {
    const r = h('input', { type: 'radio', name: 'transfer-customer', value: c.value, checked: c.value === chosen });
    r.addEventListener('change', () => { chosen = r.value; newBox.hidden = chosen !== 'new'; });
    return h('label', { class: 'check' }, r, h('span', { translate: c.value === 'new' ? null : 'no' }, c.label));
  });
  newBox.hidden = chosen !== 'new';
  const consent = h('input', { type: 'checkbox' });
  const ok = h('button', { class: 'btn primary', type: 'submit' }, 'Transfer');
  const form = h('form', {},
    h('p', {}, 'The car and the customer are copied into the customer register',
      company.company ? h('span', {}, ' of ', h('strong', { translate: 'no' }, company.company)) : null, '. ',
      'The car stays in Vehicles as it is.'),
    pre.car ? h('div', { class: 'notice' }, 'This car is already in the customer register',
      pre.car.owner_name ? h('span', {}, ', owned by ', h('strong', { translate: 'no' }, `${pre.car.owner_name} (${pre.car.owner_no})`)) : null,
      '. It gets the customer below as its new owner.') : null,
    h('h3', {}, pre.matches.length ? 'Customer (possible matches found)' : 'Customer'),
    radios, newBox,
    h('label', { class: 'check' }, consent,
      h('span', {}, 'The customer agrees that the car and their details are stored in the customer register.')),
    h('p', { class: 'small' }, h('button', { class: 'link', type: 'button', onClick: () => registerPrivacyDialog(company, pre.retention_years) },
      'Show the privacy notice')),
    h('div', { class: 'actions' }, ok));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!consent.checked) { toast('Tick that the customer agrees first', 'error'); return; }
    busy(ok, async () => {
      const body = chosen === 'new' ? { consent: true, customer: f.read() } : { consent: true, customer_id: Number(chosen) };
      const r = await api.post(`/vehicles/${v.id}/transfer`, body);
      close();
      toast('Transferred to the customer register', 'success');
      await done();
      if (canOpen(`#/customers/${r.customer_id}`) && confirm('Open the customer now?')) location.hash = `#/customers/${r.customer_id}`;
    });
  });
  const { close } = openDialog('Transfer to the customer register', form, { wide: true });
}

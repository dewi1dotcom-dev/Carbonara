import {
  api, append, applyTheme, canSee, carText, fmtDate, h, initFoldCards, openDialog, osloTodayIso, pdiCarHref, session, setInspectorId, setRouteCheck, showError, startClock,
  theme, toast,
} from './ui.js';
import { lang, setLang, startTranslator } from './i18n.js';
import { changePinForm, loginView } from './views/login.js';
import { arrivalsView } from './views/dashboard.js';
import { deliveriesView, kioskView } from './views/deliveries.js';
import { dmChatView, dmListView } from './views/dm.js';
import { todayView } from './views/today.js';
import { inspectionView } from './views/inspection.js';
import { intakeView } from './views/intake.js';
import { notesView, toggleNotesPanel } from './views/notes.js';
import { pricesView } from './views/prices.js';
import { marketView } from './views/market.js';
import { partsView } from './views/parts.js';
import { partsOrdersView, partsOrderView } from './views/partsorders.js';
import { customerCarView, customersView, customerView } from './views/customers.js';
import { notificationsDialog, pushLogout, syncPush } from './views/notifications.js';
import { pdiListView, prepDialog } from './views/pdi.js';
import { pdiOrdersView } from './views/pdiorders.js';
import { signatureDialog } from './views/pdisheet.js';
import { settingsView } from './views/settings.js';
import { storageSpotView, storageView } from './views/storage.js';
import { storageReportView } from './views/storagecare.js';
import { systemView } from './views/system.js';
import { rentalView } from './views/rental.js';
import { testDriveView } from './views/testdrive.js';
import { deletedView, vehiclesView, vehicleView } from './views/vehicles.js';

const routes = [
  [/^#?\/?$/, todayView, 'today'],
  [/^#\/arrivals$/, arrivalsView, 'arrivals'],
  [/^#\/pdi$/, pdiListView, 'today'],
  [/^#\/pdi-orders$/, pdiOrdersView, 'pdi_orders'], // PDI orders with car details + history, until registered and off site
  [/^#\/intake$/, intakeView, 'arrivals'],
  [/^#\/inspections\/(\d+)$/, inspectionView, 'arrivals'],
  [/^#\/vehicles$/, vehiclesView, 'vehicles'],
  [/^#\/vehicles\/deleted$/, deletedView, 'vehicles'],
  [/^#\/prices$/, pricesView, 'vehicles'], // asking prices of the cars in stock, compared within make + model
  [/^#\/market$/, marketView, 'vehicles'], // market data (test): imported listings vs. our asking prices
  [/^#\/vehicles\/(\d+)\/storage-report$/, storageReportView, 'vehicles'],
  [/^#\/vehicles\/(\d+)$/, vehicleView, 'vehicles'],
  [/^#\/storage$/, storageView, 'storage'],
  [/^#\/storage\/(\d+|off-site)$/, storageSpotView, 'storage'],
  [/^#\/test-drive(?:\/new\/(\d+))?$/, testDriveView, 'testdrive'],
  [/^#\/rental$/, rentalView, 'rental'], // rental cars: their own fleet, not in the car database
  [/^#\/deliveries$/, deliveriesView, 'deliveries'],
  [/^#\/kiosk$/, kioskView, 'deliveries'], // staff preview of the delivery kiosk form
  [/^#\/parts$/, partsView, 'parts'], // parts store (delelager): part numbers, prices, locations, stock
  [/^#\/parts-orders$/, partsOrdersView, 'parts'], // parts orders for customers' cars
  [/^#\/parts-orders\/(\d+)$/, partsOrderView, 'parts'],
  [/^#\/customers$/, customersView, 'customers'], // customer register (kept apart from the car database)
  [/^#\/customers\/(\d+)$/, customerView, 'customers'],
  [/^#\/customer-cars\/(\d+)$/, customerCarView, 'customers'],
  [/^#\/messages$/, dmListView, 'messages'], // private messages: every user, whatever the team
  [/^#\/messages\/(\d+)$/, dmChatView, 'messages'],
  [/^#\/notes$/, notesView, 'notes'], // my notes as a page (a reminder notification opens it); usually the 📝 panel
  [/^#\/settings$/, settingsView, 'settings'],
  [/^#\/system$/, systemView, 'system'],
];

// Links (Today board rows and tiles) only lead to pages the user's team can see.
setRouteCheck((href) => {
  const route = routes.find(([re]) => re.test(href.split('?')[0]));
  return !route || route[2] === 'system' || canSee(route[2]);
});

const root = document.getElementById('app');

async function render() {
  refreshNotify(); // not awaited: the page doesn't wait for the notification bar
  refreshDm();
  refreshNotes();
  const hash = (location.hash || '#/').split('?')[0]; // "?…" holds page filters, not part of the route
  const match = routes.map(([re, view, nav]) => [hash.match(re), view, nav]).find(([m]) => m);

  // Each navigation renders into a fresh container, so a slow, stale view
  // never overwrites the current page.
  const container = h('div', { class: 'view' }, h('div', { class: 'loading' }, 'Loading…'));
  root.replaceChildren(container);
  window.scrollTo(0, 0);

  document.querySelectorAll('[data-nav]').forEach((a) =>
    a.classList.toggle('active', match && a.dataset.nav === match[2]));
  markMore();

  if (!match) {
    container.replaceChildren(h('h1', {}, 'Not found'), h('a', { href: '#/' }, 'Back to Today'));
    return;
  }
  const [m, view, nav] = match;
  if (nav !== 'system' && !canSee(nav)) { // System checks its own rights
    container.replaceChildren(
      h('h1', {}, 'Not available'),
      h('div', { class: 'card notice warn' }, 'This page is not available for your team. Ask a system admin if you need it.'),
      h('a', { href: '#/' }, 'Back to Today'));
    return;
  }
  const content = h('div');
  try {
    await view(content, m.slice(1));
    container.replaceChildren(content);
  } catch (err) {
    console.error(err);
    container.replaceChildren(
      h('div', { class: 'card notice warn' }, h('strong', {}, 'Could not load this page. '), err.message ?? String(err)),
      h('a', { href: '#/' }, 'Back to Today'));
  }
}

// ---------------------------------------------------------------- notifications

// Cars with a PDI by the next working day that aren't prepared yet: a bar on
// every page; "Prepare" opens the preparation form.
const notifyEl = document.getElementById('notify');
const DAY_MS = 86400000;

async function refreshNotify() {
  if (!session.me) { notifyEl.replaceChildren(); return; }
  let due;
  try { due = await api.get('/pdi/prepare-due'); } catch { return; }
  const today = osloTodayIso();
  notifyEl.replaceChildren(...due.map((o) => {
    const [day, time] = String(o.pdi_local || '').split('T');
    const inDays = Math.round((new Date(`${day}T12:00:00`) - new Date(`${today}T12:00:00`)) / DAY_MS);
    const hhmm = (time || '').slice(0, 5);
    const when = inDays <= 0 ? `PDI today at ${hhmm}` : inDays === 1 ? `PDI tomorrow at ${hhmm}` : `PDI ${fmtDate(day, false)} at ${hhmm}`;
    return h('div', { class: 'notify-bar' },
      h('span', {}, '🔔 ', when, ': ', h('a', { href: pdiCarHref(o.vehicle_id) }, h('strong', {}, carText(o))), ' — ', 'prepare the car'),
      h('button', {
        class: 'btn primary small', type: 'button',
        onClick: () => prepDialog(o, async () => { await refreshNotify(); await render(); }),
      }, 'Prepare'));
  }));
}
setInterval(refreshNotify, 15 * 60 * 1000); // a page left open overnight still shows it
window.addEventListener('carbonara:pdi-changed', refreshNotify); // prepared / booked from a card

// ---------------------------------------------------------------- login

const userMenu = document.getElementById('user-menu');

// 💬 Private messages, beside the account button, with the number of unread messages.
// data-nav: highlighted like a menu item while a conversation is open.
const dmCount = h('span', { class: 'dm-count', hidden: true });
const dmButton = h('a', { class: 'user-btn dm-btn', href: '#/messages', 'data-nav': 'messages', title: 'Private messages', 'aria-label': 'Private messages' },
  '💬', dmCount);

async function refreshDm() {
  if (!session.me) return;
  let n;
  try { ({ count: n } = await api.get('/dm/unread')); } catch { return; }
  dmCount.textContent = n > 99 ? '99+' : String(n);
  dmCount.hidden = !n;
  dmButton.classList.toggle('has-new', n > 0);
}
setInterval(refreshDm, 60 * 1000); // new messages show up without navigating
window.addEventListener('carbonara:dm-changed', refreshDm); // read / sent in a conversation

// 📝 My notes (0.40.0): opens the notes panel on any page; the count = reminders that are due.
const notesCount = h('span', { class: 'dm-count', hidden: true });
const notesButton = h('button', {
  class: 'user-btn dm-btn', type: 'button', 'data-nav': 'notes', title: 'My notes', 'aria-label': 'My notes',
  onClick: toggleNotesPanel,
}, '📝', notesCount);

async function refreshNotes() {
  if (!session.me) return;
  let n;
  try { ({ count: n } = await api.get('/notes/due')); } catch { return; }
  notesCount.textContent = n > 99 ? '99+' : String(n);
  notesCount.hidden = !n;
}
setInterval(refreshNotes, 60 * 1000); // a reminder becomes due without navigating
window.addEventListener('carbonara:notes-changed', refreshNotes);

// "More" at the end of the top menu: the items a system admin chose (System page → Top menu) are moved
// into its dropdown. Hidden when nothing is chosen, or when none of the chosen items is open to this user.
// The panel is position: fixed, because the menu line scrolls sideways (overflow) and would clip it.
const navEl = document.querySelector('.topbar nav');
const navLinks = [...navEl.querySelectorAll(':scope > a[data-nav]')]; // the order in index.html
const morePanel = h('div', { class: 'nav-more-panel', hidden: true });
const moreBtn = h('button', {
  class: 'nav-more-btn', type: 'button', 'aria-haspopup': 'true', 'aria-expanded': 'false',
  onClick: (e) => { e.stopPropagation(); toggleMore(morePanel.hidden); },
}, h('span', {}, 'More'), ' ▾');
const moreBox = h('div', { class: 'nav-more', hidden: true }, moreBtn);
document.body.append(morePanel);

function toggleMore(open) {
  morePanel.hidden = !open;
  moreBtn.setAttribute('aria-expanded', String(open));
  if (!open) return;
  const r = moreBtn.getBoundingClientRect();
  morePanel.style.top = `${r.bottom + 4}px`;
  morePanel.style.right = `${Math.max(8, window.innerWidth - r.right)}px`;
}
document.addEventListener('click', (e) => { if (!morePanel.hidden && !morePanel.contains(e.target)) toggleMore(false); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') toggleMore(false); });
window.addEventListener('hashchange', () => toggleMore(false));
window.addEventListener('resize', () => toggleMore(false));
morePanel.addEventListener('click', (e) => { if (e.target.closest('a')) toggleMore(false); });

function layoutNav() {
  const more = new Set(session.me?.menu_more || []);
  navEl.replaceChildren(...navLinks.filter((a) => !more.has(a.dataset.nav)), moreBox);
  morePanel.replaceChildren(...navLinks.filter((a) => more.has(a.dataset.nav)));
  moreBox.hidden = !morePanel.querySelector('a:not([hidden])');
  if (moreBox.hidden) toggleMore(false);
  markMore();
}
/** "More" looks active while one of its pages is open. */
function markMore() {
  moreBtn.classList.toggle('active', !!morePanel.querySelector('a.active'));
}
window.addEventListener('carbonara:menu-changed', layoutNav); // changed on the System page

function renderUser() {
  const me = session.me;
  document.getElementById('nav-system').hidden = !me?.is_superadmin;
  // The team decides which menu items show (System page → Teams).
  navLinks.forEach((a) => {
    if (a.dataset.nav !== 'system') a.hidden = !canSee(a.dataset.nav);
  });
  layoutNav();
  if (!me) { userMenu.replaceChildren(); return; }
  userMenu.replaceChildren(notesButton, dmButton, h('button', {
    // Silhouette only (user's request); the name shows on hover and as the dialog title.
    class: 'user-btn', type: 'button', title: me.name, 'aria-label': me.name, translate: 'no',
    onClick: () => {
      // Light / dark / device: applied at once, then saved on the account.
      const themeRow = h('div', { class: 'row' });
      const drawThemes = () => themeRow.replaceChildren(
        ...[['auto', 'Same as device'], ['light', 'Light'], ['dark', 'Dark']].map(([code, label]) => h('button', {
          class: code === theme ? 'btn primary' : 'btn', type: 'button',
          onClick: async () => {
            if (code === theme) return;
            const before = theme;
            applyTheme(code);
            drawThemes();
            try {
              await api.post('/auth/theme', { theme: code });
              me.theme = code;
            } catch (e) { applyTheme(before); drawThemes(); showError(e); }
          },
        }, label)));
      drawThemes();
      const { close } = openDialog(me.name, h('div', {},
        h('p', { class: 'muted' }, me.is_superadmin ? 'System admin' : me.is_admin ? 'Administrator' : 'Staff'),
        h('div', { class: 'field' }, h('label', {}, 'Language'),
          h('div', { class: 'row' },
            [['en', 'English'], ['no', 'Norsk']].map(([code, label]) => h('button', {
              class: code === lang ? 'btn primary' : 'btn', type: 'button', translate: 'no',
              onClick: async () => {
                if (code === lang) return;
                try { await api.post('/auth/language', { language: code }); } catch (e) { showError(e); return; }
                setLang(code);
                location.reload(); // simplest way to show every page in the new language
              },
            }, label)))),
        h('div', { class: 'field' }, h('label', {}, 'Theme'), themeRow),
        h('div', { class: 'actions spread' },
          h('button', {
            class: 'btn', type: 'button',
            onClick: () => {
              close();
              const d = openDialog('Change PIN', changePinForm(() => { d.close(); toast('PIN changed', 'success'); }));
            },
          }, 'Change PIN'),
          // Put on the PDI sheets this person marks as done (also under Settings).
          h('button', { class: 'btn', type: 'button', onClick: () => { close(); signatureDialog(); } }, 'My signature'),
          // Phone / PC notifications for this device + which kinds (views/notifications.js).
          h('button', { class: 'btn', type: 'button', onClick: () => { close(); notificationsDialog(); } }, 'Notifications'),
          h('button', {
            class: 'btn danger', type: 'button',
            onClick: async () => {
              close();
              await pushLogout(); // this device stops getting the person's notifications
              try { await api.post('/auth/logout'); } catch { /* already logged out */ }
              await boot();
            },
          }, 'Log out'))));
    },
  }, '👤'));
}

let booting = null;
/** Check the session; show the login screen (or the delivery kiosk form) or the app.
 *  A delivery kiosk tablet shows only the delivery form: no staff login there (0.33.12). An admin
 *  sets its language and stops it on the Customer deliveries page. */
function boot() {
  booting ??= (async () => {
    try {
      const state = await api.get('/auth/state');
      session.me = state.me;
      // The user's saved language wins over the device's; reload once to apply it.
      if (state.me?.language && state.me.language !== lang) { setLang(state.me.language); location.reload(); return; }
      if (state.me?.theme && state.me.theme !== theme) applyTheme(state.me.theme); // no reload needed
      renderUser();
      document.body.classList.toggle('logged-out', !state.me);
      if (!state.me) {
        refreshNotify(); // clears the bar
        // Whoever logs in next starts on Today, not on the page the last user had open
        // (e.g. System, which a regular user may not see). replaceState: no hashchange.
        if ((location.hash || '#/') !== '#/') history.replaceState(null, '', `${location.pathname}${location.search}#/`);
        if (state.kiosk) {
          // The tablet's language is the one set for it on the Customer deliveries page.
          if (state.kiosk.language && state.kiosk.language !== lang) { setLang(state.kiosk.language); location.reload(); return; }
          await kioskView(root, [], { standalone: true });
          return;
        }
        loginView(root, state, () => { booting = null; return boot(); });
        return;
      }
      setInspectorId(state.me.id); // staff pickers default to whoever is logged in
      syncPush(); // not awaited: keeps this device's notifications with whoever is logged in
      await render();
    } catch (e) {
      showError(e);
      root.replaceChildren(h('div', { class: 'card notice warn' }, 'Cannot reach the server. ',
        h('button', { class: 'btn', type: 'button', onClick: () => { booting = null; boot(); } }, 'Try again')));
    } finally {
      booting = null;
    }
  })();
  return booting;
}

window.addEventListener('carbonara:logged-out', () => { if (session.me) { session.me = null; boot(); } });
window.addEventListener('hashchange', () => { if (session.me) render(); });
// From /sw.js: a tapped notification opens its page in this window; a new private message updates the 💬 count.
navigator.serviceWorker?.addEventListener('message', (e) => {
  const msg = e.data || {};
  if (msg.type === 'carbonara-open' && typeof msg.url === 'string' && msg.url.startsWith('#/')) location.hash = msg.url;
  if (msg.type === 'carbonara-push' && String(msg.tag).startsWith('dm')) window.dispatchEvent(new Event('carbonara:dm-changed'));
  if (msg.type === 'carbonara-push' && String(msg.tag).startsWith('note')) window.dispatchEvent(new Event('carbonara:notes-changed'));
});
/* HTTPS (the caddy service): a device opened over plain HTTP that already trusts Carbonara's
 * certificate moves to https:// by itself. The test request only succeeds when the certificate is
 * trusted, so devices without it stay on http:// (and can still log in there). It also matters
 * because after a login over HTTPS, the browser won't let http:// set the login cookie. */
async function moveToHttps() {
  if (location.protocol !== 'http:') return false;
  try {
    const v = await (await fetch('/api/version', { cache: 'no-store' })).json();
    if (!v.https_port) return false;
    const target = `https://${location.hostname}:${v.https_port}`;
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 3000);
    await fetch(`${target}/api/version`, { mode: 'no-cors', cache: 'no-store', signal: stop.signal });
    location.replace(target + location.pathname + location.search + location.hash);
    return true;
  } catch {
    return false; // no HTTPS yet, or the certificate isn't installed on this device
  }
}

startTranslator();
initFoldCards(); // after the translator: Settings and System cards fold (keys are read in the user's language)
moveToHttps().then((moved) => { if (!moved) boot(); });
startClock(document.getElementById('clock'));

// Show which version/build is running, so it is easy to check after an update.
fetch('/api/version')
  .then((r) => (r.ok ? r.json() : null))
  .then((v) => {
    if (!v) return;
    const el = document.getElementById('app-version');
    el.textContent = v.build_time
      ? `Carbonara v${v.version} · built ${fmtDate(v.build_time)}`
      : `Carbonara v${v.version}`;
  })
  .catch(() => {});

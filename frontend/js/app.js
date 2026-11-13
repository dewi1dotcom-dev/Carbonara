import {
  api, append, applyTheme, canSee, carText, fmtDate, h, openDialog, osloTodayIso, session, setInspectorId, showError, startClock,
  theme, toast,
} from './ui.js';
import { lang, setLang, startTranslator } from './i18n.js';
import { changePinForm, loginView } from './views/login.js';
import { arrivalsView } from './views/dashboard.js';
import { deliveriesView, kioskView } from './views/deliveries.js';
import { todayView } from './views/today.js';
import { inspectionView } from './views/inspection.js';
import { intakeView } from './views/intake.js';
import { pdiListView, prepDialog } from './views/pdi.js';
import { pdiOrdersView } from './views/pdiorders.js';
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
  [/^#\/vehicles\/(\d+)\/storage-report$/, storageReportView, 'vehicles'],
  [/^#\/vehicles\/(\d+)$/, vehicleView, 'vehicles'],
  [/^#\/storage$/, storageView, 'storage'],
  [/^#\/storage\/(\d+|off-site)$/, storageSpotView, 'storage'],
  [/^#\/test-drive(?:\/new\/(\d+))?$/, testDriveView, 'testdrive'],
  [/^#\/rental$/, rentalView, 'rental'], // rental cars: their own fleet, not in the car database
  [/^#\/deliveries$/, deliveriesView, 'deliveries'],
  [/^#\/kiosk$/, kioskView, 'deliveries'], // staff preview of the delivery kiosk form
  [/^#\/settings$/, settingsView, 'settings'],
  [/^#\/system$/, systemView, 'system'],
];

const root = document.getElementById('app');

async function render() {
  refreshNotify(); // not awaited: the page doesn't wait for the notification bar
  const hash = (location.hash || '#/').split('?')[0]; // "?…" holds page filters, not part of the route
  const match = routes.map(([re, view, nav]) => [hash.match(re), view, nav]).find(([m]) => m);

  // Each navigation renders into a fresh container, so a slow, stale view
  // never overwrites the current page.
  const container = h('div', { class: 'view' }, h('div', { class: 'loading' }, 'Loading…'));
  root.replaceChildren(container);
  window.scrollTo(0, 0);

  document.querySelectorAll('[data-nav]').forEach((a) =>
    a.classList.toggle('active', match && a.dataset.nav === match[2]));

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
      h('span', {}, '🔔 ', when, ': ', h('a', { href: `#/vehicles/${o.vehicle_id}` }, h('strong', {}, carText(o))), ' — ', 'prepare the car'),
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

function renderUser() {
  const me = session.me;
  document.getElementById('nav-system').hidden = !me?.is_superadmin;
  // The team decides which menu items show (System page → Teams).
  document.querySelectorAll('nav [data-nav]').forEach((a) => {
    if (a.dataset.nav !== 'system') a.hidden = !canSee(a.dataset.nav);
  });
  if (!me) { userMenu.replaceChildren(); return; }
  userMenu.replaceChildren(h('button', {
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
          h('button', {
            class: 'btn danger', type: 'button',
            onClick: async () => {
              close();
              try { await api.post('/auth/logout'); } catch { /* already logged out */ }
              staffLogin = false; // on a kiosk tablet: back to the delivery form
              await boot();
            },
          }, 'Log out'))));
    },
  }, '👤'));
}

let booting = null;
// A delivery kiosk tablet shows the delivery form instead of the login screen,
// until someone taps "Staff login" (staffLogin = true).
let staffLogin = false;

/** Check the session; show the login screen (or the delivery kiosk form) or the app. */
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
        const again = () => { booting = null; return boot(); };
        if (state.kiosk && !staffLogin) {
          await kioskView(root, [], { standalone: true, onStaffLogin: () => { staffLogin = true; again(); } });
          return;
        }
        loginView(root, state, again);
        if (state.kiosk) {
          append(root, h('p', { class: 'kiosk-foot' }, h('button', {
            class: 'link', type: 'button', onClick: () => { staffLogin = false; again(); },
          }, 'Back to the delivery form')));
        }
        return;
      }
      setInspectorId(state.me.id); // staff pickers default to whoever is logged in
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
startTranslator();
boot();
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

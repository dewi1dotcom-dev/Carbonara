import { fmtDate, h, startClock } from './ui.js';
import { dashboardView } from './views/dashboard.js';
import { inspectionView } from './views/inspection.js';
import { intakeView } from './views/intake.js';
import { settingsView } from './views/settings.js';
import { storageSpotView, storageView } from './views/storage.js';
import { testDriveView } from './views/testdrive.js';
import { deletedView, vehiclesView, vehicleView } from './views/vehicles.js';

const routes = [
  [/^#?\/?$/, dashboardView, 'arrivals'],
  [/^#\/intake$/, intakeView, 'arrivals'],
  [/^#\/inspections\/(\d+)$/, inspectionView, 'arrivals'],
  [/^#\/vehicles$/, vehiclesView, 'vehicles'],
  [/^#\/vehicles\/deleted$/, deletedView, 'vehicles'],
  [/^#\/vehicles\/(\d+)$/, vehicleView, 'vehicles'],
  [/^#\/storage$/, storageView, 'storage'],
  [/^#\/storage\/(\d+|off-site)$/, storageSpotView, 'storage'],
  [/^#\/test-drive(?:\/new\/(\d+))?$/, testDriveView, 'testdrive'],
  [/^#\/settings$/, settingsView, 'settings'],
];

const root = document.getElementById('app');

async function render() {
  const hash = location.hash || '#/';
  const match = routes.map(([re, view, nav]) => [hash.match(re), view, nav]).find(([m]) => m);

  // Each navigation renders into a fresh container, so a slow, stale view
  // never overwrites the current page.
  const container = h('div', { class: 'view' }, h('div', { class: 'loading' }, 'Loading…'));
  root.replaceChildren(container);
  window.scrollTo(0, 0);

  document.querySelectorAll('[data-nav]').forEach((a) =>
    a.classList.toggle('active', match && a.dataset.nav === match[2]));

  if (!match) {
    container.replaceChildren(h('h1', {}, 'Not found'), h('a', { href: '#/' }, 'Back to arrivals'));
    return;
  }
  const [m, view] = match;
  const content = h('div');
  try {
    await view(content, m.slice(1));
    container.replaceChildren(content);
  } catch (err) {
    console.error(err);
    container.replaceChildren(
      h('div', { class: 'card notice warn' }, h('strong', {}, 'Could not load this page. '), err.message ?? String(err)),
      h('a', { href: '#/' }, 'Back to arrivals'));
  }
}

window.addEventListener('hashchange', render);
render();
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

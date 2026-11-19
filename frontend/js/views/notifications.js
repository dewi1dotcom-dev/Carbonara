// Phone / PC notifications (Web Push; server: app/push.py, routers/notifications.py).
// Turned on per device from the 👤 menu; which kinds is chosen per person (all their devices).
// Needs HTTPS: browsers only allow notifications on a secure address. /sw.js shows them.
import { api, busy, h, openDialog, session, showError, toast } from '../ui.js';

const OWNER_KEY = 'carbonara.pushOwner'; // who turned notifications on on this device

const KIND_LABEL = {
  dm: 'New private messages',
  board: 'New messages on the Today page',
  pdi_prep: 'PDI soon and the car is not prepared',
  pdi_status: 'PDI date confirmed or PDI done (orders you made)',
  late_return: 'Test drive or rental car not back (cars you handed out)',
  daily_due: 'Storage checks and 12V charging due (in the morning)',
  system: 'Background worker or disk space problems',
};

export const pushSupported = () =>
  window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

const owner = {
  get() { try { return localStorage.getItem(OWNER_KEY); } catch { return null; } },
  set(id) {
    try { if (id == null) localStorage.removeItem(OWNER_KEY); else localStorage.setItem(OWNER_KEY, String(id)); } catch { /* private mode */ }
  },
};

let registering = null;
function registration() {
  registering ??= navigator.serviceWorker.register('/sw.js', { scope: '/' })
    .then(() => navigator.serviceWorker.ready)
    .catch((e) => { registering = null; throw e; });
  return registering;
}

async function currentSubscription() {
  return (await registration()).pushManager.getSubscription();
}

function keyBytes(base64url) {
  const b64 = base64url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (base64url.length % 4)) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

/** On every start (logged in): keep this device's notifications with the person who turned them on.
 *  Someone else logged in now (or permission withdrawn) → this device stops getting them. */
export async function syncPush() {
  if (!pushSupported() || !session.me) return;
  try {
    const sub = await currentSubscription();
    if (!sub) return;
    if (owner.get() !== String(session.me.id) || Notification.permission !== 'granted') {
      await sub.unsubscribe();
      owner.set(null);
      return;
    }
    await api.post('/push/subscriptions', sub.toJSON()); // follows the current login session
  } catch { /* notifications are optional */ }
}

/** Before logging out: this device stops getting the person's notifications. */
export async function pushLogout() {
  if (!pushSupported()) return;
  try {
    const sub = await currentSubscription();
    if (sub) {
      await api.post('/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
      await sub.unsubscribe();
    }
  } catch { /* the server drops it with the session anyway */ }
  owner.set(null);
}

async function turnOn(publicKey) {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error(permission === 'denied'
      ? 'Notifications are blocked for Carbonara in this browser'
      : 'Notifications were not allowed');
  }
  const reg = await registration();
  const old = await reg.pushManager.getSubscription();
  if (old) await old.unsubscribe(); // start fresh (another person's, or an old key)
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
  await api.post('/push/subscriptions', sub.toJSON());
  owner.set(session.me.id);
}

const isIos = () => /iPad|iPhone|iPod/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

/** 👤 menu → Notifications: this device on / off, a test, and which kinds. */
export async function notificationsDialog() {
  let cfg;
  try { cfg = await api.get('/push/config'); } catch (e) { showError(e); return; }
  const deviceSlot = h('div', {});
  openDialog('Notifications', h('div', {},
    h('p', { class: 'muted small' },
      'Carbonara can notify you on this phone or PC, also when Carbonara is closed. '
      + 'Notifications never show customer details.'),
    deviceSlot,
    prefsBlock(cfg)));

  const drawDevice = async () => {
    deviceSlot.replaceChildren(...deviceBlock(await deviceState(), cfg, drawDevice).filter(Boolean));
  };
  await drawDevice();
}

async function deviceState() {
  if (!window.isSecureContext) return 'insecure';
  if (!pushSupported()) return isIos() ? 'ios' : 'unsupported';
  if (Notification.permission === 'denied') return 'blocked';
  try {
    const sub = await currentSubscription();
    return sub && Notification.permission === 'granted' && owner.get() === String(session.me.id) ? 'on' : 'off';
  } catch { return 'unsupported'; }
}

function deviceBlock(state, cfg, redraw) {
  const notice = (cls, text) => h('div', { class: `notice ${cls}` }, text);
  switch (state) {
    case 'insecure':
      return [notice('warn', 'Notifications only work when Carbonara is opened on its https address, with '
        + 'Carbonara\'s certificate installed on this device. Ask your system administrator.')];
    case 'ios':
      return [notice('warn', 'iPhone / iPad: add Carbonara to the Home Screen (Share → Add to Home Screen), '
        + 'open it from there, and turn notifications on there.')];
    case 'unsupported':
      return [notice('warn', 'This browser can\'t show notifications. Use Chrome.')];
    case 'blocked':
      return [notice('warn', 'Notifications are blocked for Carbonara in this browser. Allow them in the browser\'s '
        + 'site settings (the lock or settings icon next to the address), then open this again.')];
    case 'on':
      return [
        notice('good', '✓ Notifications are on for this device.'),
        h('div', { class: 'actions' },
          h('button', {
            class: 'btn', type: 'button',
            onClick: (ev) => busy(ev.currentTarget, async () => {
              await api.post('/push/test');
              toast('Test sent. It should arrive within a few seconds.', 'success');
            }),
          }, 'Send a test'),
          h('button', {
            class: 'btn', type: 'button',
            onClick: (ev) => busy(ev.currentTarget, async () => { await pushLogout(); await redraw(); }),
          }, 'Turn off on this device')),
      ];
    default:
      return [
        h('p', {}, 'Notifications are off on this device.'),
        h('div', { class: 'actions' },
          h('button', {
            class: 'btn primary', type: 'button',
            onClick: (ev) => busy(ev.currentTarget, async () => {
              await turnOn(cfg.public_key);
              toast('Notifications turned on', 'success');
              await redraw();
            }),
          }, 'Turn on notifications')),
      ];
  }
}

function prefsBlock(cfg) {
  const box = (kind) => {
    const input = h('input', {
      type: 'checkbox', checked: cfg.prefs[kind] !== false,
      onChange: async () => {
        try {
          cfg.prefs = await api.put('/push/prefs', { prefs: { [kind]: input.checked } });
          toast('Saved', 'success');
        } catch (e) { input.checked = !input.checked; showError(e); }
      },
    });
    return h('label', { class: 'check' }, input, ' ', KIND_LABEL[kind] || kind);
  };
  return h('div', { class: 'push-prefs' },
    h('h3', {}, 'Notify me about'),
    h('p', { class: 'muted small' }, 'Applies to all your devices.'),
    cfg.kinds.map(box));
}

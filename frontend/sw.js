/* Carbonara service worker: only for phone / PC notifications (Web Push, app/push.py on the server).
 * It caches nothing (pages always come from the server, so a deploy is never hidden behind old files).
 * Served from the site root so it covers the whole app; works only over HTTPS. */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data && event.data.text() }; }
  const show = self.registration.showNotification(data.title || 'Carbonara', {
    body: data.body || '',
    tag: data.tag || undefined,          // a newer one with the same tag replaces the old one
    renotify: Boolean(data.tag),
    icon: '/img/carbonara-icon-192.png',
    data: { url: data.url || '#/' },
  });
  // Open Carbonara pages update at once (e.g. the 💬 unread count).
  const tell = self.clients.matchAll({ type: 'window' })
    .then((list) => list.forEach((c) => c.postMessage({ type: 'carbonara-push', tag: data.tag || '' })));
  event.waitUntil(Promise.all([show, tell]));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const hash = (event.notification.data && event.notification.data.url) || '#/';
  event.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = list.find((c) => new URL(c.url).origin === self.location.origin);
    if (open) {
      await open.focus();
      open.postMessage({ type: 'carbonara-open', url: hash }); // app.js moves to that page
      return;
    }
    await self.clients.openWindow(new URL(hash, self.registration.scope).href);
  })());
});

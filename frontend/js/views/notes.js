// My notes (0.40.0): each person's own notes, in a panel opened with 📝 in the top bar on every page
// (and as a page at #/notes, which a reminder notification opens). A note is a text and/or a pinned car
// or page, with an optional reminder. Only the person who wrote it can see it (server: routers/notes.py).
import {
  api, append, busy, canOpen, carText, dateInput, fmtDate, h, openDialog, showError, timeInput, toast,
} from '../ui.js';

const MAX = 1000;
const changed = () => window.dispatchEvent(new Event('carbonara:notes-changed')); // the 📝 count

// ---------------------------------------------------------------- the panel

let layer = null;
const onKey = (e) => { if (e.key === 'Escape') closeNotesPanel(); };

export function toggleNotesPanel() {
  if (layer) closeNotesPanel(); else openNotesPanel();
}

function openNotesPanel() {
  const body = h('div', { class: 'notes-body' });
  layer = h('div', { class: 'notes-layer no-print' },
    h('div', { class: 'notes-backdrop', onClick: closeNotesPanel }),
    h('aside', { class: 'notes-panel', role: 'dialog', 'aria-label': 'My notes' },
      h('div', { class: 'notes-head' },
        h('h2', {}, '📝 My notes'),
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', onClick: closeNotesPanel }, '✕')),
      h('p', { class: 'muted small' }, 'Only you can see your notes.'),
      body));
  document.body.append(layer);
  document.addEventListener('keydown', onKey);
  notesContent(body, { onNav: closeNotesPanel }).catch(showError);
  layer.querySelector('textarea')?.focus({ preventScroll: true });
}

export function closeNotesPanel() {
  if (!layer) return;
  layer.remove();
  layer = null;
  document.removeEventListener('keydown', onKey);
}
window.addEventListener('hashchange', closeNotesPanel); // the pinned page would be the old one

/** #/notes: the same notes as a page (a reminder notification opens it). */
export async function notesView(el) {
  const body = h('div', { class: 'notes-body notes-page' });
  append(el,
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', {}, 'My notes'), h('div', { class: 'muted' }, 'Only you can see your notes.'))),
    body);
  await notesContent(body, {});
}

// ---------------------------------------------------------------- content

/** What "📌 Pin" pins on the page that is open now: the car on a car page, else the page itself. */
function pinTarget() {
  const hash = location.hash || '#/';
  const route = hash.split('?')[0];
  const car = route.match(/^#\/vehicles\/(\d+)$/);
  if (car) return { body: { vehicle_id: Number(car[1]) }, label: '📌 Pin this car' };
  if (['#', '#/', '#/notes', '#/kiosk'].includes(route)) return null;
  const title = document.querySelector('#app h1')?.textContent?.trim() || route;
  return { body: { link: hash.slice(0, 300), link_title: title.slice(0, 120) }, label: '📌 Pin this page' };
}

async function notesContent(el, { onNav = null }) {
  const list = h('div', { class: 'notes-list' }, h('div', { class: 'loading' }, 'Loading…'));
  const draw = async () => {
    const data = await api.get('/notes');
    const cards = data.open.map((n) => noteCard(n, refresh, onNav));
    list.replaceChildren(...(cards.length ? cards : [h('p', { class: 'empty' }, 'No notes yet.')]),
      ...(data.done.length ? [h('details', { class: 'notes-done' },
        h('summary', {}, `Done (${data.done_count})`),
        h('p', { class: 'muted small' }, `Done notes are deleted after ${data.keep_days} days.`),
        ...data.done.map((n) => noteCard(n, refresh, onNav)))] : []));
  };
  const refresh = async () => { await draw(); changed(); };
  append(el, composer(refresh), list);
  await draw();
}

// ---------------------------------------------------------------- writing

/** Oslo date and time of a moment: ['2026-11-21', '14:30']. */
function osloParts(d) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Oslo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(d).map((x) => [x.type, x.value]));
  return [`${p.year}-${p.month}-${p.day}`, `${p.hour}:${p.minute}`];
}

/** Date + time fields for a reminder, with quick choices. value(): "2026-11-21T14:30" or ''. */
function reminderFields(local) {
  const [d, t] = local ? String(local).split('T') : ['', ''];
  const date = dateInput({ value: d || '' });
  const time = timeInput({ value: t ? t.slice(0, 5) : '' });
  const set = (when) => { const [dd, tt] = osloParts(when); date.value = dd; time.value = tt; };
  const at8 = (days) => { // 08:00 Oslo time, `days` days from today
    const [today] = osloParts(new Date());
    const day = new Date(`${today}T12:00:00Z`);
    day.setUTCDate(day.getUTCDate() + days);
    date.value = day.toISOString().slice(0, 10);
    time.value = '08:00';
  };
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] // today in Oslo, 0 = Sunday
    .indexOf(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Oslo', weekday: 'short' }).format(new Date()));
  const quick = (label, fn) => h('button', { class: 'chip', type: 'button', onClick: fn }, label);
  const el = h('div', { class: 'note-remind' },
    h('div', { class: 'note-remind-fields' }, date, time),
    h('div', { class: 'note-quick' },
      quick('In 1 hour', () => set(new Date(Date.now() + 3600000))),
      quick('Tomorrow 08:00', () => at8(1)),
      quick('Monday 08:00', () => at8(((8 - weekday) % 7) || 7))));
  const value = () => {
    const day = date.value;
    if (!day) return '';
    return `${day}T${time.value || '08:00'}`;
  };
  return { el, value, date, time };
}

function composer(refresh) {
  const text = h('textarea', { rows: 2, maxlength: MAX, placeholder: 'Write a note…', 'aria-label': 'Note' });
  const rem = reminderFields(null);
  const remBox = h('div', { class: 'note-remind-box', hidden: true }, rem.el);
  const remBtn = h('button', {
    class: 'link small', type: 'button',
    onClick: () => { remBox.hidden = !remBox.hidden; },
  }, '⏰ Remind me');
  const pin = pinTarget();
  const save = (button, withPin) => busy(button, async () => {
    if (!withPin && !text.value.trim()) { text.focus(); return; }
    const body = { body: text.value, ...(withPin ? pin.body : {}) };
    if (!remBox.hidden && rem.value()) body.remind = rem.value();
    await api.post('/notes', body);
    text.value = '';
    rem.date.value = '';
    rem.time.value = '';
    remBox.hidden = true;
    toast(withPin ? 'Pinned' : 'Note added', 'success');
    await refresh();
  });
  const add = h('button', { class: 'btn primary', type: 'submit' }, 'Add note');
  const pinBtn = pin ? h('button', {
    class: 'btn', type: 'button', title: 'Pin it, with the text above if you wrote one', onClick: () => save(pinBtn, true),
  }, pin.label) : null;
  const form = h('form', {
    class: 'note-compose',
    onSubmit: (e) => { e.preventDefault(); save(add, false); },
  },
  text, remBox,
  h('div', { class: 'note-compose-row' }, remBtn, h('span', { class: 'note-compose-buttons' }, pinBtn, add)));
  // Ctrl+Enter (or ⌘+Enter) adds it on a keyboard; on phones Enter makes a new line.
  text.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) form.requestSubmit(); });
  return form;
}

// ---------------------------------------------------------------- one note

function pinnedLine(n, onNav) {
  const go = onNav ? { onClick: () => onNav() } : {};
  if (n.vehicle_id) {
    const label = h('span', {}, '🚗 ', h('strong', { translate: 'no' }, carText(n)));
    if (n.vehicle_deleted) return h('div', { class: 'note-pin muted' }, label, ' ', h('span', { class: 'badge' }, 'Car deleted'));
    const href = `#/vehicles/${n.vehicle_id}`;
    return h('div', { class: 'note-pin' }, canOpen(href) ? h('a', { href, ...go }, label) : label);
  }
  if (n.link) {
    const label = h('span', {}, '🔗 ', h('strong', { translate: 'no' }, n.link_title || n.link));
    return h('div', { class: 'note-pin' }, canOpen(n.link) ? h('a', { href: n.link, ...go }, label) : label);
  }
  return null;
}

function noteCard(n, refresh, onNav) {
  const act = (label, fn, cls = 'link small') => h('button', {
    class: cls, type: 'button',
    onClick: async () => { try { await fn(); } catch (e) { showError(e); } },
  }, label);
  const patch = async (body) => { await api.patch(`/notes/${n.id}`, body); await refresh(); };
  const done = !!n.done_at;
  return h('div', { class: `note${n.due && !done ? ' due' : ''}${done ? ' done' : ''}` },
    pinnedLine(n, onNav),
    n.body ? h('div', { class: 'note-text', translate: 'no' }, n.body) : null,
    h('div', { class: 'note-meta small' },
      n.remind_at && !done ? h('span', { class: `badge ${n.due ? 'bad' : ''}` }, `⏰ ${fmtDate(n.remind_at)}`) : null,
      h('span', { class: 'muted' }, done ? `Done ${fmtDate(n.done_at)}` : fmtDate(n.created_at)),
      h('span', { class: 'note-actions' },
        done ? act('Undo', () => patch({ done: false })) : act('✓ Done', () => patch({ done: true })),
        done ? null : act('Edit', () => editDialog(n, refresh)),
        act('Delete', async () => {
          if (!confirm('Delete this note?')) return;
          await api.del(`/notes/${n.id}`);
          await refresh();
        }))));
}

function editDialog(n, refresh) {
  const text = h('textarea', { rows: 4, maxlength: MAX, 'aria-label': 'Note' });
  text.value = n.body || '';
  const rem = reminderFields(n.remind_local);
  const save = h('button', { class: 'btn primary', type: 'submit' }, 'Save');
  const form = h('form', {
    onSubmit: (e) => {
      e.preventDefault();
      busy(save, async () => {
        await api.patch(`/notes/${n.id}`, { body: text.value, remind: rem.value() });
        close();
        toast('Note saved', 'success');
        await refresh();
      });
    },
  },
  pinnedLine(n, () => close()),
  h('div', { class: 'field' }, h('label', {}, 'Note'), text),
  h('div', { class: 'field' }, h('label', {}, 'Remind me'), rem.el,
    h('button', {
      class: 'link small', type: 'button',
      onClick: () => { rem.date.value = ''; rem.time.value = ''; },
    }, 'No reminder')),
  h('div', { class: 'actions' }, save));
  const { close } = openDialog('Edit note', form);
}

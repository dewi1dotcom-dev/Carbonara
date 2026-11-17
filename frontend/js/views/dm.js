// Private messages (#/messages, #/messages/:staffId): text, photos and files between two users.
// Only the two of them can read them. Every message is deleted 72 working hours after it was
// sent (Monday–Friday hours only; the server works out the time and shows it on each message).
import { api, append, busy, fmtDate, h, openDialog, showError } from '../ui.js';

const POLL_MS = 10000; // an open conversation checks for new messages this often
const MAX = 2000;
const RULE = 'Messages and files are deleted after 72 working hours. Saturdays and Sundays don’t count.';

const changed = () => window.dispatchEvent(new Event('carbonara:dm-changed')); // the 💬 count in the top bar
const fileUrl = (m, variant = 'original') => `/api/dm/${m.id}/file${variant === 'original' ? '' : `?variant=${variant}`}`;
const fmtSize = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1).replace('.', ',')} MB` : `${Math.max(1, Math.round(n / 1024))} kB`);

export async function dmListView(el) {
  const people = await api.get('/dm/contacts');
  append(el,
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', {}, 'Private messages'), h('div', { class: 'muted' }, RULE))),
    people.length ? h('div', { class: 'list dm-people' }, ...people.map((p) => h('a', { class: 'card list-card dm-person', href: `#/messages/${p.id}` },
      h('span', { class: 'msg-initials', translate: 'no' }, p.initials),
      h('span', { class: 'dm-person-main' },
        h('strong', { translate: 'no' }, p.name),
        p.last_at ? h('span', { class: 'muted small' }, `Last message ${fmtDate(p.last_at)}`) : null),
      p.unread ? h('span', { class: 'badge warn' }, `${p.unread} new`) : null)))
      : h('p', { class: 'empty' }, 'There is nobody else to write to yet.'));
}

export async function dmChatView(el, [staffId]) {
  let data = await api.get(`/dm/with/${staffId}`);
  changed(); // opening it marked the messages as read

  const list = h('div', { class: 'dm-thread' });
  let signature = '';
  const draw = (scroll) => {
    // Redraw only when something changed, so a picture being looked at doesn't jump.
    const sig = data.messages.map((m) => `${m.id}:${m.read_at ? 1 : 0}`).join(',');
    if (sig === signature) return;
    const grew = data.messages.length > signature.split(',').filter(Boolean).length;
    signature = sig;
    list.replaceChildren(...(data.messages.length ? data.messages.map((m) => bubble(m, refresh))
      : [h('p', { class: 'empty' }, 'No messages yet. Write the first one below.')]));
    if (scroll || grew) requestAnimationFrame(() => list.lastElementChild?.scrollIntoView({ block: 'end' }));
  };
  const refresh = async () => {
    data = await api.get(`/dm/with/${staffId}`);
    draw(false);
    changed();
  };

  const p = data.person;
  append(el,
    h('div', { class: 'page-head dm-head' },
      h('div', {},
        h('a', { href: '#/messages', class: 'small' }, '← All conversations'),
        h('h1', { class: 'dm-title' }, h('span', { class: 'msg-initials', translate: 'no' }, p.initials), h('span', { translate: 'no' }, p.name)),
        h('div', { class: 'muted small' }, RULE))),
    list,
    p.active ? composer(staffId, refresh) : h('div', { class: 'notice warn' }, 'This person is deactivated and can’t receive messages.'));
  draw(true);

  const timer = setInterval(() => {
    if (!list.isConnected) { clearInterval(timer); return; } // left the page
    refresh().catch(() => { /* try again next time */ });
  }, POLL_MS);
}

function bubble(m, refresh) {
  const file = !m.has_file ? null : m.is_image
    ? h('button', { class: 'dm-image', type: 'button', title: 'Open picture', onClick: () => viewImage(m) },
      h('img', { src: fileUrl(m, 'thumb'), alt: m.original_name || 'Picture', loading: 'lazy' }))
    : h('a', { class: 'dm-file', href: fileUrl(m), target: '_blank', rel: 'noopener' },
      '📎 ', h('span', { translate: 'no' }, m.original_name), ' ', h('span', { class: 'muted small' }, `(${fmtSize(m.size_bytes || 0)})`));
  return h('div', { class: m.mine ? 'dm-msg mine' : 'dm-msg' },
    h('div', { class: 'dm-bubble' },
      file,
      m.body ? h('div', { class: 'dm-text', translate: 'no' }, m.body) : null),
    h('div', { class: 'dm-meta muted small' },
      h('span', {}, fmtDate(m.created_at)),
      m.mine ? [' · ', h('span', {}, m.read_at ? '✓ Read' : 'Not read yet')] : null,
      ' · ', h('span', { title: 'Deleted automatically' }, `deleted ${fmtDate(m.expires_at)}`),
      m.mine ? h('button', {
        class: 'link small', type: 'button',
        onClick: async () => {
          if (!confirm('Delete this message for both of you?')) return;
          try { await api.del(`/dm/${m.id}`); await refresh(); } catch (e) { showError(e); }
        },
      }, 'Delete') : null));
}

function viewImage(m) {
  openDialog(m.original_name || 'Picture', h('div', { class: 'photo-view' },
    h('img', { src: fileUrl(m, 'display'), alt: m.original_name || 'Picture' }),
    h('a', { href: fileUrl(m), target: '_blank', rel: 'noopener', class: 'muted' }, 'Open original')),
  { wide: true });
}

function composer(staffId, refresh) {
  const text = h('textarea', { id: 'dm-text', rows: 2, maxlength: MAX, placeholder: 'Write a message', 'aria-label': 'Message' });
  // A photo from the camera or the gallery, or a document (the same types as documents on a car).
  const fileInput = h('input', {
    type: 'file', hidden: true,
    accept: 'image/*,.pdf,.doc,.docx,.xls,.xlsx,.odt,.ods,.txt,.heic,.heif',
  });
  const chosen = h('div', { class: 'dm-chosen' });
  const showChosen = () => {
    const f = fileInput.files[0];
    chosen.replaceChildren(...(f ? [h('span', { translate: 'no' }, `📎 ${f.name}`), h('button', {
      class: 'link small', type: 'button', onClick: () => { fileInput.value = ''; showChosen(); },
    }, 'Remove')] : []));
  };
  fileInput.addEventListener('change', showChosen);
  const send = h('button', { class: 'btn primary', type: 'submit' }, 'Send');
  const form = h('form', {
    class: 'card dm-compose',
    onSubmit: (e) => {
      e.preventDefault();
      const f = fileInput.files[0];
      if (!text.value.trim() && !f) { text.focus(); return; }
      busy(send, async () => {
        const fd = new FormData();
        if (text.value.trim()) fd.append('body', text.value);
        if (f) fd.append('file', f);
        await api.postForm(`/dm/with/${staffId}`, fd);
        text.value = '';
        fileInput.value = '';
        showChosen();
        await refresh();
      });
    },
  },
  text, chosen,
  h('div', { class: 'dm-compose-row' },
    h('button', { class: 'btn', type: 'button', onClick: () => fileInput.click() }, '📎 Photo or file'),
    fileInput, send));
  // Ctrl+Enter (or ⌘+Enter) sends on a keyboard; on phones Enter makes a new line.
  text.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) form.requestSubmit(); });
  return form;
}

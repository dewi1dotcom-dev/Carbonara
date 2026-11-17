// Message board on the Today page: short notes for the writer's team (admins can also write
// to everyone or another team), marked with the writer's initials and shown for 24 hours
// (the server deletes them after that). With several messages, the board changes between
// them by itself; the dots switch by hand.
import { api, busy, fmtDate, h, openDialog, session, showError, toast } from '../ui.js';

const CHANGE_MS = 8000; // time each message is shown before the next one
const REFRESH_MS = 60000; // new messages from others show up without a reload
const MAX = 300;

export function messageBoard() {
  let list = [];
  let index = 0;
  let timer = null;

  const counter = h('span', { class: 'count' });
  const slot = h('div', { class: 'msg-slot' });
  const dots = h('div', { class: 'msg-dots' });
  // Filled once the server says this user may write (staff without a team can't: nobody would see it).
  const actions = h('div', { class: 'msg-actions' });
  const board = h('section', { class: 'card today-block msg-board' },
    h('h2', {}, '💬 ', h('span', {}, 'Messages'), counter),
    slot, dots, actions);

  const show = (i, restart = true) => {
    // Messages run out after 24 h even while the page stays open.
    list = list.filter((m) => new Date(m.expires_at).getTime() > Date.now());
    index = list.length ? ((i % list.length) + list.length) % list.length : 0;
    counter.textContent = list.length > 1 ? `${index + 1} / ${list.length}` : '';
    counter.hidden = list.length < 2;
    const m = list[index];
    slot.replaceChildren(m ? h('div', { class: 'msg' },
      h('span', { class: 'msg-initials', title: m.name || '', translate: 'no' }, m.initials),
      h('div', { class: 'msg-main' },
        h('div', { class: 'msg-text', translate: 'no' }, m.body),
        h('div', { class: 'muted small' }, h('span', {}, `Written ${fmtDate(m.created_at)}`), ' · ',
          m.to_all ? h('span', {}, 'To everyone') : h('span', { translate: 'no' }, m.team_name))),
      m.can_delete ? h('button', {
        class: 'icon-btn', type: 'button', title: 'Delete message', 'aria-label': 'Delete message',
        onClick: async () => {
          if (!confirm('Delete this message?')) return;
          try { await api.del(`/messages/${m.id}`); await load(); } catch (e) { showError(e); }
        },
      }, '✕') : null)
      : h('p', { class: 'empty' }, 'No messages. A message is shown for 24 hours.'));
    dots.replaceChildren(...(list.length > 1 ? list.map((x, n) => h('button', {
      class: n === index ? 'msg-dot active' : 'msg-dot', type: 'button', 'aria-label': `Message ${n + 1}`,
      onClick: () => show(n),
    })) : []));
    if (restart || (list.length > 1) !== Boolean(timer)) { // a tap on a dot gives that message its full time
      clearInterval(timer);
      timer = list.length > 1 ? setInterval(() => {
        if (!board.isConnected) { clearInterval(timer); return; } // left the Today page
        show(index + 1, false);
      }, CHANGE_MS) : null;
    }
  };

  // showId: a message just written is shown first.
  const load = async (showId = null) => {
    const current = list[index]?.id;
    const data = await api.get('/messages');
    list = data.messages;
    if (data.can_post && !actions.firstChild) {
      actions.append(h('button', {
        class: 'btn small', type: 'button', onClick: () => writeDialog(async (id) => { await load(id); }),
      }, '+ Write a message'));
    } else if (!data.can_post) actions.replaceChildren();
    const want = showId ?? current;
    const at = list.findIndex((m) => m.id === want);
    show(at >= 0 ? at : 0, false);
  };

  load().catch(showError);
  const refresh = setInterval(() => {
    if (!board.isConnected) { clearInterval(refresh); clearInterval(timer); return; }
    load().catch(() => { /* try again next time */ });
  }, REFRESH_MS);
  return board;
}

async function writeDialog(onSaved) {
  const me = session.me || {};
  // Admins choose who sees it: everyone or a team (their own team preselected). Staff always
  // write to their own team.
  let to = null;
  if (me.is_admin) {
    let teams = [];
    try { teams = await api.get('/messages/teams'); } catch (e) { showError(e); return; }
    to = h('select', { id: 'msg-to' },
      h('option', { value: 'all' }, 'Everyone'),
      teams.map((t) => h('option', { value: String(t.id), translate: 'no' }, t.name)));
    to.value = me.team_id && teams.some((t) => t.id === me.team_id) ? String(me.team_id) : 'all';
  }
  const text = h('textarea', { id: 'msg-body', rows: 3, maxlength: MAX });
  const left = h('div', { class: 'muted small' });
  const countLeft = () => { left.textContent = `${MAX - text.value.length} characters left`; };
  text.addEventListener('input', countLeft);
  countLeft();
  const save = h('button', { class: 'btn primary', type: 'submit' }, 'Post');
  const form = h('form', {
    onSubmit: (e) => {
      e.preventDefault();
      if (!text.value.trim()) { text.focus(); return; }
      busy(save, async () => {
        const { id } = await api.post('/messages', { body: text.value, to: to ? to.value : null });
        close();
        toast('Message posted', 'success');
        await onSaved(id);
      });
    },
  },
  h('p', { class: 'muted' }, to
    ? 'The message is shown on the Today page for 24 hours, marked with your initials.'
    : 'Your team sees the message on the Today page for 24 hours, marked with your initials.'),
  to ? h('div', { class: 'field' }, h('label', { for: 'msg-to' }, 'Who sees it'), to) : null,
  h('div', { class: 'field' }, h('label', { for: 'msg-body' }, 'Message'), text, left),
  h('div', { class: 'actions' },
    h('button', { class: 'btn', type: 'button', onClick: () => close() }, 'Cancel'), save));
  const { close } = openDialog('Write a message', form);
  text.focus();
}

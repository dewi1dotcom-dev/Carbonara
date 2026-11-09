// Login with a personal PIN. On first start (nobody has a PIN yet) the same
// screen sets up the first administrator.
import { lang, setLang } from '../i18n.js';
import { api, busy, h, setInspectorId, showError } from '../ui.js';

const LAST_USER_KEY = 'carbonara.lastLogin';
const lastUser = () => { try { return localStorage.getItem(LAST_USER_KEY) || ''; } catch { return ''; } };
const rememberUser = (id) => { try { localStorage.setItem(LAST_USER_KEY, String(id)); } catch { /* private mode */ } };

/** Renders into `el`; calls onDone() once logged in. */
export function loginView(el, state, onDone) {
  const setup = state.setup_needed;
  const who = h('select', { id: 'login-who', required: !setup || state.staff.length > 0 },
    h('option', { value: '' }, setup ? 'Choose your name…' : 'Who are you?'),
    state.staff.map((s) => h('option', { value: s.id }, s.name)));
  who.value = state.staff.some((s) => String(s.id) === lastUser()) ? lastUser() : '';
  const newName = h('input', { type: 'text', id: 'login-name', maxlength: 100, placeholder: 'Your name' });
  const pin = h('input', {
    type: 'password', id: 'login-pin', inputmode: 'numeric', pattern: '[0-9]*', autocomplete: setup ? 'new-password' : 'current-password',
    minlength: 4, maxlength: 8, required: true, placeholder: '••••',
  });
  const pin2 = setup ? h('input', {
    type: 'password', id: 'login-pin2', inputmode: 'numeric', pattern: '[0-9]*', autocomplete: 'new-password',
    minlength: 4, maxlength: 8, required: true, placeholder: '••••',
  }) : null;
  const submit = h('button', { class: 'btn primary', type: 'submit' }, setup ? 'Set PIN and log in' : 'Log in');

  const form = h('form', { class: 'card login-card' },
    h('h1', {}, 'Carbonara'),
    setup
      ? h('div', { class: 'notice' },
        h('strong', {}, 'First-time setup. '),
        'Choose your name and a PIN. You become the administrator and can give the others their PINs under Settings.')
      : h('p', { class: 'muted' }, 'Log in with your personal PIN.'),
    h('div', { class: 'field' }, h('label', { for: 'login-who' }, 'Name'),
      state.staff.length ? who : null,
      setup && !state.staff.length ? newName : null),
    h('div', { class: 'field' }, h('label', { for: 'login-pin' }, setup ? 'Choose a PIN (4–8 digits)' : 'PIN'), pin),
    setup ? h('div', { class: 'field' }, h('label', { for: 'login-pin2' }, 'Repeat the PIN'), pin2) : null,
    !setup && !state.staff.length
      ? h('p', { class: 'notice warn' }, 'Nobody has a PIN yet. Ask an administrator.') : null,
    h('div', { class: 'actions' }, submit),
    // Before anyone is logged in, the language follows the device; switchable here.
    h('p', { class: 'small muted lang-switch', translate: 'no' },
      [['en', 'English'], ['no', 'Norsk']].map(([code, label]) => (code === lang
        ? h('strong', {}, label)
        : h('button', { class: 'link', type: 'button', onClick: () => { setLang(code); location.reload(); } }, label)))));

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!/^\d{4,8}$/.test(pin.value)) { showError(new Error('The PIN must be 4–8 digits')); return; }
    if (setup && pin.value !== pin2.value) { showError(new Error('The two PINs are not the same')); return; }
    busy(submit, async () => {
      if (setup) {
        await api.post('/auth/setup', who.value ? { staff_id: Number(who.value), pin: pin.value }
          : { name: newName.value, pin: pin.value });
      } else {
        await api.post('/auth/login', { staff_id: Number(who.value), pin: pin.value });
      }
      if (who.value) { rememberUser(who.value); setInspectorId(who.value); }
      await onDone();
    }).finally(() => { pin.value = ''; if (pin2) pin2.value = ''; });
  });

  el.replaceChildren(form);
  (who.value || !state.staff.length ? pin : who).focus();
}

/** Change your own PIN (from the header menu). */
export function changePinForm(onDone) {
  const cur = h('input', { type: 'password', id: 'pin-cur', inputmode: 'numeric', pattern: '[0-9]*', required: true, maxlength: 8, autocomplete: 'current-password' });
  const next = h('input', { type: 'password', id: 'pin-new', inputmode: 'numeric', pattern: '[0-9]*', required: true, minlength: 4, maxlength: 8, autocomplete: 'new-password' });
  const next2 = h('input', { type: 'password', id: 'pin-new2', inputmode: 'numeric', pattern: '[0-9]*', required: true, minlength: 4, maxlength: 8, autocomplete: 'new-password' });
  const submit = h('button', { class: 'btn primary', type: 'submit' }, 'Change PIN');
  const form = h('form', {},
    h('div', { class: 'field' }, h('label', { for: 'pin-cur' }, 'Current PIN'), cur),
    h('div', { class: 'field' }, h('label', { for: 'pin-new' }, 'New PIN (4–8 digits)'), next),
    h('div', { class: 'field' }, h('label', { for: 'pin-new2' }, 'Repeat new PIN'), next2),
    h('p', { class: 'muted small' }, 'Your other devices are logged out.'),
    h('div', { class: 'actions' }, submit));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (next.value !== next2.value) { showError(new Error('The two new PINs are not the same')); return; }
    busy(submit, async () => {
      await api.post('/auth/pin', { current_pin: cur.value, new_pin: next.value });
      onDone();
    });
  });
  return form;
}

import { api, busy, fmtDate, h, openDialog, session, showError, spotLabel, toast } from '../ui.js';

export async function settingsView(el) {
  const staffBox = h('div');
  const locBox = h('div');
  const registryBox = h('div');
  const retentionBox = h('div');
  const pdiBox = h('div');
  el.append(h('div', { class: 'page-head' }, h('h1', {}, 'Settings')), staffBox, locBox, pdiBox, registryBox, retentionBox);
  await Promise.all([renderStaff(), renderLocations(), renderPdiLists(), renderRegistry(), renderRetention()]);

  // PDI order lists: items the customer can order, tyre companies, e-mail recipients.
  async function renderPdiLists() {
    const rows = await api.get('/pdi/lists');
    const admin = !!session.me?.is_admin;
    const patch = async (r, body) => {
      try { await api.patch(`/pdi/lists/${r.id}`, body); await renderPdiLists(); } catch (e) { showError(e); }
    };
    const section = (kind, title, help, describe, addForm) => {
      const list = rows.filter((r) => r.kind === kind);
      return h('div', {},
        h('h3', {}, title),
        h('p', { class: 'muted small' }, help),
        h('ul', { class: 'plain rows list-edit' }, list.map((r) => h('li', { class: r.active ? '' : 'inactive' },
          h('span', {}, describe(r), r.active ? '' : ' (removed)'),
          admin ? h('span', { class: 'row-actions' },
            kind === 'recipient' && r.active && !r.is_default
              ? h('button', { class: 'link', type: 'button', onClick: () => patch(r, { is_default: true }) }, 'Make default') : null,
            h('button', {
              class: 'link', type: 'button',
              onClick: () => {
                const label = prompt('Name', r.label);
                if (label == null || !label.trim()) return;
                const body = { label };
                if (kind === 'recipient') {
                  const email = prompt('E-mail address', r.email);
                  if (email == null) return;
                  body.email = email;
                }
                if (kind === 'item') {
                  const choices = prompt('Choices, separated by commas (empty = none)', (r.choices || []).join(', '));
                  if (choices == null) return;
                  body.choices = choices.split(',').map((c) => c.trim()).filter(Boolean);
                }
                patch(r, body);
              },
            }, 'Edit'),
            h('button', { class: 'link', type: 'button', onClick: () => patch(r, { active: !r.active }) }, r.active ? 'Remove' : 'Restore'))
            : null))),
        admin ? addForm : null);
    };
    const addForm = (kind, inputs, toBody) => {
      const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Add');
      const f = h('form', { class: 'inline-form wrap' }, ...inputs, btn);
      f.addEventListener('submit', (e) => {
        e.preventDefault();
        busy(btn, async () => { await api.post('/pdi/lists', { kind, ...toBody() }); await renderPdiLists(); });
      });
      return f;
    };
    const itemName = h('input', { type: 'text', placeholder: 'Item, e.g. Takboks', required: true, maxlength: 80 });
    const itemChoices = h('input', { type: 'text', placeholder: 'Choices (optional), e.g. Gummi, Tekstil', maxlength: 200 });
    const tyreName = h('input', { type: 'text', placeholder: 'Tyre company', required: true, maxlength: 80 });
    const recName = h('input', { type: 'text', placeholder: 'Name, e.g. RBV', required: true, maxlength: 80 });
    const recEmail = h('input', { type: 'email', placeholder: 'E-mail address', required: true, maxlength: 200 });

    pdiBox.replaceChildren(h('section', { class: 'card' },
      h('h2', {}, 'PDI order lists'),
      admin ? null : h('p', { class: 'muted small' }, 'Only an administrator can change these lists.'),
      section('item', 'Items the customer can order',
        'Shown as tick boxes on the PDI order. Names go to the workshop as written (Norwegian is fine).',
        (r) => [r.label, r.choices?.length ? h('span', { class: 'muted small' }, ` (${r.choices.join(' / ')})`) : null],
        addForm('item', [itemName, itemChoices], () => ({
          label: itemName.value, choices: itemChoices.value.split(',').map((c) => c.trim()).filter(Boolean),
        }))),
      section('tyre_company', 'Tyre companies', 'Who the workshop orders winter tyres from.',
        (r) => r.label, addForm('tyre_company', [tyreName], () => ({ label: tyreName.value }))),
      section('recipient', 'E-mail recipients', 'Who PDI orders can be sent to. The default is preselected when sending.',
        (r) => [r.label, h('span', { class: 'muted small' }, ` – ${r.email}`), r.is_default ? h('span', { class: 'badge' }, ' Default') : null],
        addForm('recipient', [recName, recEmail], () => ({ label: recName.value, email: recEmail.value })))));
  }

  async function renderRetention() {
    const r = await api.get('/retention');
    retentionBox.replaceChildren(h('section', { class: 'card' },
      h('h2', {}, 'Data retention'),
      h('ul', { class: 'plain rows' },
        // One <span>: the rows are flex lines, so loose text + link would become columns.
        h('li', {}, h('span', {}, 'Deleted cars stay in ', h('a', { href: '#/vehicles/deleted' }, 'Recently deleted'),
          ` for ${r.trash_days} days and can be restored. After that they are removed for good, with all photos.`)),
        h('li', {}, r.retention_years > 0
          ? `Cars that are off site (sold/delivered) and have had no activity for ${r.retention_years} years are deleted automatically — they go to Recently deleted first. Cars in storage are never deleted automatically.`
          : 'Automatic deletion of old cars is turned off.'),
        h('li', {}, `In Recently deleted now: ${r.in_trash}`
          + (r.retention_years > 0 ? ` · Due for automatic deletion within 30 days: ${r.due_within_30_days}` : ''))),
      h('p', { class: 'muted small' }, session.me?.is_superadmin
        ? ['Change the periods on the ', h('a', { href: '#/system' }, 'System'), ' page → Data retention.']
        : 'A system admin can change the periods on the System page.')));
  }

  async function renderRegistry() {
    const s = await api.get('/registry/status');
    registryBox.replaceChildren(h('section', { class: 'card' },
      h('h2', {}, 'Statens vegvesen sync'),
      s.configured
        ? h('p', {},
          `API key configured${s.key_hint ? ` (ending in …${s.key_hint})` : ''}. `,
          `Registered vehicles are re-synced every ${s.sync_days} days.`)
        : h('div', { class: 'notice warn' }, 'No API key configured yet.'),
      h('p', { class: 'muted small' }, session.me?.is_superadmin
        ? ['To add or replace the key: ', h('a', { href: '#/system' }, 'System'), ' → Statens vegvesen → API key.']
        : 'A system admin can add or replace the key on the System page.'),
      h('dl', { class: 'kv' },
        [['Synced OK', s.ok], ['Waiting', s.pending], ['Not found in registry', s.not_found], ['Errors', s.error],
          ['Due for sync now', s.due]].map(([k, val]) => [h('dt', {}, k), h('dd', {}, String(val))])),
      s.last_error ? h('p', { class: 'muted small' },
        `Latest error (${fmtDate(s.last_error.last_attempt_at)}): ${s.last_error.last_error}`) : null));
  }

  async function renderStaff() {
    const staff = await api.get('/staff?include_inactive=true');
    const me = session.me;
    const admin = !!me?.is_admin;
    const name = h('input', { type: 'text', placeholder: 'Name', required: true, maxlength: 100 });
    const addBtn = h('button', { class: 'btn primary', type: 'submit' }, 'Add');
    const form = h('form', { class: 'inline-form' }, name, addBtn);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      busy(addBtn, async () => {
        const s = await api.post('/staff', { name: name.value });
        await renderStaff();
        pinDialog(s); // a new person needs a PIN to log in
      });
    });
    const patch = async (s, body) => {
      try { await api.patch(`/staff/${s.id}`, body); await renderStaff(); } catch (e) { showError(e); }
    };
    const actions = (s) => (!admin ? null : h('span', { class: 'row-actions' },
      h('button', { class: 'link', type: 'button', onClick: () => pinDialog(s) }, s.has_pin ? 'Reset PIN' : 'Set PIN'),
      s.id === me.id ? null : h('button', { class: 'link', type: 'button', onClick: () => patch(s, { is_admin: !s.is_admin }) },
        s.is_admin ? 'Remove admin' : 'Make admin'),
      s.id === me.id || !me.is_superadmin ? null : h('button', {
        class: 'link', type: 'button',
        onClick: () => {
          if (!s.is_superadmin && !confirm(`Make ${s.name} system admin? They can change all system settings (API key, e-mail server…).`)) return;
          patch(s, { is_superadmin: !s.is_superadmin });
        },
      }, s.is_superadmin ? 'Remove system admin' : 'Make system admin'),
      s.id === me.id ? null : h('button', { class: 'link', type: 'button', onClick: () => patch(s, { active: !s.active }) },
        s.active ? 'Deactivate' : 'Activate')));

    staffBox.replaceChildren(h('section', { class: 'card' },
      h('h2', {}, 'Staff / inspectors'),
      h('p', { class: 'muted small' }, admin
        ? 'Everyone logs in with a personal PIN. Give new staff a PIN here; reset it if someone forgets theirs (that also unlocks the account and logs out their devices).'
        : 'Only an administrator can add staff or change PINs.'),
      h('ul', { class: 'plain rows' }, staff.map((s) => h('li', { class: s.active ? '' : 'inactive' },
        h('span', {}, s.name, s.id === me?.id ? ' (you)' : '', s.active ? '' : ' (inactive)', ' ',
          s.is_superadmin ? h('span', { class: 'badge good' }, 'System admin') : s.is_admin ? h('span', { class: 'badge' }, 'Admin') : null, ' ',
          s.active && !s.has_pin ? h('span', { class: 'badge warn' }, 'No PIN — can’t log in') : null,
          s.last_login_at ? h('span', { class: 'muted small block' }, `Last login ${fmtDate(s.last_login_at)}`) : null),
        actions(s)))),
      admin ? form : null));

    function pinDialog(s) {
      const pin = h('input', { type: 'password', id: 'set-pin', inputmode: 'numeric', pattern: '[0-9]*', minlength: 4, maxlength: 8, required: true, autocomplete: 'new-password' });
      const save = h('button', { class: 'btn primary', type: 'submit' }, 'Save PIN');
      const f = h('form', {},
        h('p', {}, `New PIN for ${s.name}. Tell them the PIN in person; they can change it themselves afterwards (their name at the top → Change PIN).`),
        h('div', { class: 'field' }, h('label', { for: 'set-pin' }, 'PIN (4–8 digits)'), pin),
        h('div', { class: 'actions' }, save));
      f.addEventListener('submit', (e) => {
        e.preventDefault();
        if (!/^\d{4,8}$/.test(pin.value)) { showError(new Error('The PIN must be 4–8 digits')); return; }
        busy(save, async () => {
          await api.post(`/staff/${s.id}/pin`, { pin: pin.value });
          close();
          toast(`PIN saved for ${s.name}`, 'success');
          await renderStaff();
        });
      });
      const { close } = openDialog(s.has_pin ? 'Reset PIN' : 'Set PIN', f);
      pin.focus();
    }
  }

  async function renderLocations() {
    const locs = await api.get('/storage-locations?include_inactive=true');
    const admin = !!session.me?.is_admin; // deleting spots is admin-only

    const code = h('input', { type: 'text', placeholder: 'Code, e.g. A-12', required: true, maxlength: 30 });
    const zone = h('input', { type: 'text', placeholder: 'Zone, e.g. Yard A', maxlength: 60 });
    const desc = h('input', { type: 'text', placeholder: 'Description (optional)', maxlength: 200 });
    const cap = h('input', { type: 'number', placeholder: 'Max cars (empty = no limit)', min: 1, max: 10000, inputmode: 'numeric' });
    const addBtn = h('button', { class: 'btn primary', type: 'submit' }, 'Add spot');
    const single = h('form', { class: 'inline-form wrap' }, code, zone, desc, cap, addBtn);
    single.addEventListener('submit', (e) => {
      e.preventDefault();
      busy(addBtn, async () => {
        await api.post('/storage-locations', {
          code: code.value, zone: zone.value || null, description: desc.value || null,
          capacity: cap.value ? Number(cap.value) : null,
        });
        await renderLocations();
      });
    });

    // Capacity is edited in place: change the number and leave the field to save.
    const capacityInput = (l) => {
      const input = h('input', {
        type: 'number', class: 'cap-input', min: 1, max: 10000, inputmode: 'numeric',
        value: l.capacity ?? '', placeholder: 'No limit', 'aria-label': `Capacity for ${l.code}`,
      });
      input.addEventListener('change', async () => {
        try {
          await api.patch(`/storage-locations/${l.id}`, { capacity: input.value ? Number(input.value) : null });
          toast(`${l.code}: ${input.value ? `max ${input.value} cars` : 'no limit'}`, 'success');
          await renderLocations();
        } catch (err) {
          input.value = l.capacity ?? '';
          showError(err);
        }
      });
      return input;
    };

    const prefix = h('input', { type: 'text', placeholder: 'Prefix, e.g. A-', maxlength: 20 });
    const from = h('input', { type: 'number', placeholder: 'From', min: 0, value: 1 });
    const to = h('input', { type: 'number', placeholder: 'To', min: 0, value: 20 });
    const rZone = h('input', { type: 'text', placeholder: 'Zone', maxlength: 60 });
    const rangeBtn = h('button', { class: 'btn', type: 'submit' }, 'Add range');
    const range = h('form', { class: 'inline-form wrap' }, prefix, from, to, rZone, rangeBtn);
    range.addEventListener('submit', (e) => {
      e.preventDefault();
      const a = Number(from.value);
      const b = Number(to.value);
      if (!(b >= a) || b - a > 500) { toast('Range must be 1–500 spots', 'error'); return; }
      busy(rangeBtn, async () => {
        const width = String(b).length;
        let added = 0;
        for (let n = a; n <= b; n++) {
          try {
            await api.post('/storage-locations', {
              code: `${prefix.value}${String(n).padStart(width, '0')}`, zone: rZone.value || null,
            });
            added++;
          } catch (err) { if (err.status !== 409) throw err; }
        }
        toast(`Added ${added} spots`, 'success');
        await renderLocations();
      });
    });

    // Add a sub-zone (e.g. RAD 1) inside a top-level spot.
    const subZoneDialog = (parent) => {
      const sCode = h('input', { type: 'text', id: 'sz-code', required: true, maxlength: 30, placeholder: 'e.g. RAD 1' });
      const sCap = h('input', { type: 'number', id: 'sz-cap', min: 1, max: 10000, inputmode: 'numeric', placeholder: 'Empty = no limit' });
      const sDesc = h('input', { type: 'text', id: 'sz-desc', maxlength: 200, placeholder: 'Optional' });
      const ok = h('button', { class: 'btn primary', type: 'submit' }, 'Add sub-zone');
      const form = h('form', { class: 'form' },
        !parent.child_count && parent.vehicle_count
          ? h('div', { class: 'notice warn' },
            `The ${parent.vehicle_count} ${parent.vehicle_count === 1 ? 'car' : 'cars'} already in ${parent.code} stay there `
            + 'as "not in a sub-zone" until moved into one. New cars must go into a sub-zone.')
          : null,
        h('label', { for: 'sz-code' }, 'Sub-zone name'), sCode,
        h('label', { for: 'sz-cap' }, 'Max cars'), sCap,
        h('label', { for: 'sz-desc' }, 'Description'), sDesc,
        h('div', { class: 'actions' }, ok));
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        busy(ok, async () => {
          await api.post('/storage-locations', {
            code: sCode.value, parent_id: parent.id, description: sDesc.value || null,
            capacity: sCap.value ? Number(sCap.value) : null,
          });
          close();
          toast(`Added ${parent.code} › ${sCode.value.toUpperCase()}`, 'success');
          await renderLocations();
        });
      });
      const { close } = openDialog(`Sub-zone in ${parent.code}`, form);
    };

    const toggleActive = async (l) => {
      if (l.active && l.child_count && !confirm(`Deactivate ${l.code} and all its sub-zones?`)) return;
      try { await api.patch(`/storage-locations/${l.id}`, { active: !l.active }); await renderLocations(); } catch (e) { showError(e); }
    };
    const carsLink = (l, n) => h('a', { href: `#/storage/${l.id}` }, n ? `${n} ${n === 1 ? 'car' : 'cars'} →` : 'empty →');

    const rename = async (l) => {
      const next = prompt(`New code for ${l.code}`, l.own_code);
      if (next == null || !next.trim() || next.trim().toUpperCase() === l.own_code) return;
      try {
        await api.patch(`/storage-locations/${l.id}`, { code: next.trim() });
        toast(`${l.code} renamed to ${next.trim().toUpperCase()}`, 'success');
        await renderLocations();
      } catch (e) { showError(e); }
    };

    // Delete a spot; cars still in it (or its sub-zones) are moved to another spot first.
    const remove = async (l) => {
      const n = l.parent_id ? l.vehicle_count : l.total_count;
      const what = `${l.code}${!l.parent_id && l.child_count ? ` and its ${l.child_count} sub-zone${l.child_count === 1 ? '' : 's'}` : ''}`;
      if (!n) {
        if (!confirm(`Delete ${what}?`)) return;
        try { await api.del(`/storage-locations/${l.id}`); toast(`${l.code} deleted`, 'success'); await renderLocations(); } catch (e) { showError(e); }
        return;
      }
      let spots;
      try { spots = await api.get('/storage-locations?available_only=true'); } catch (e) { showError(e); return; }
      const targets = spots.filter((s) => s.id !== l.id && s.parent_id !== l.id
        && (s.capacity == null || s.capacity - s.vehicle_count >= n));
      const sel = h('select', { id: 'move-to', required: true }, h('option', { value: '' }, 'Choose a spot…'),
        targets.map((s) => h('option', { value: s.id }, spotLabel(s))));
      const ok = h('button', { class: 'btn danger', type: 'submit' }, `Move ${n} ${n === 1 ? 'car' : 'cars'} and delete`);
      const form = h('form', {},
        h('p', {}, `${what} has ${n} ${n === 1 ? 'car' : 'cars'}. Move ${n === 1 ? 'it' : 'all of them'} to:`),
        targets.length ? sel : h('p', { class: 'notice warn' }, `No spot has room for ${n} cars. Add a spot or raise a capacity first, or move the cars one by one.`),
        h('p', { class: 'muted small' }, 'Each move is written to the car’s history.'),
        h('div', { class: 'actions' }, h('a', { class: 'btn', href: `#/storage/${l.id}` }, 'See the cars'), targets.length ? ok : null));
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        busy(ok, async () => {
          const r = await api.del(`/storage-locations/${l.id}?move_to=${sel.value}`);
          close();
          toast(`${r.moved} ${r.moved === 1 ? 'car' : 'cars'} moved to ${r.moved_to}; ${r.deleted} deleted`, 'success');
          await renderLocations();
        });
      });
      const { close } = openDialog(`Delete ${l.code}`, form);
    };

    // Each top-level spot followed by its sub-zones.
    const tops = locs.filter((l) => !l.parent_id);
    const rows = tops.flatMap((p) => {
      const kids = locs.filter((c) => c.parent_id === p.id).sort((a, b) => a.own_code.localeCompare(b.own_code, 'nb'));
      return [
        h('tr', { class: p.active ? '' : 'inactive' },
          h('td', { class: 'mono strong' }, p.code),
          h('td', {}, p.zone ?? ''),
          h('td', {}, p.description ?? ''),
          h('td', {}, p.child_count
            ? h('span', { class: 'muted', title: 'Sum of the sub-zones' }, p.total_capacity ? `${p.total_capacity} total` : 'No limit')
            : capacityInput(p)),
          h('td', {}, carsLink(p, p.total_count)),
          h('td', { class: 'row-actions' },
            p.active ? h('button', { class: 'link', type: 'button', onClick: () => subZoneDialog(p) }, '+ Sub-zone') : null,
            h('button', { class: 'link', type: 'button', onClick: () => rename(p) }, 'Rename'),
            h('button', { class: 'link', type: 'button', onClick: () => toggleActive(p) }, p.active ? 'Deactivate' : 'Activate'),
            admin ? h('button', { class: 'link danger', type: 'button', onClick: () => remove(p) }, 'Delete') : null)),
        ...kids.map((c) => h('tr', { class: `sub-row${c.active ? '' : ' inactive'}` },
          h('td', { class: 'mono' }, `↳ ${c.own_code}`),
          h('td', {}, ''),
          h('td', {}, c.description ?? ''),
          h('td', {}, capacityInput(c)),
          h('td', {}, carsLink(c, c.vehicle_count)),
          h('td', { class: 'row-actions' },
            h('button', { class: 'link', type: 'button', onClick: () => rename(c) }, 'Rename'),
            p.active ? h('button', { class: 'link', type: 'button', onClick: () => toggleActive(c) }, c.active ? 'Deactivate' : 'Activate') : null,
            admin ? h('button', { class: 'link danger', type: 'button', onClick: () => remove(c) }, 'Delete') : null))),
      ];
    });

    locBox.replaceChildren(h('section', { class: 'card' },
      h('h2', {}, `Storage spots (${tops.filter((l) => l.active).length} active)`),
      h('p', { class: 'muted small' }, 'Split a spot into sub-zones (rows, areas) with "+ Sub-zone"; cars are then placed in a sub-zone.'),
      locs.length
        ? h('div', { class: 'table-wrap' }, h('table', {},
          h('thead', {}, h('tr', {}, ['Code', 'Zone', 'Description', 'Capacity', 'Cars', ''].map((t) => h('th', {}, t)))),
          h('tbody', {}, rows)))
        : h('p', { class: 'empty' }, 'No storage spots yet.'),
      h('h3', {}, 'Add a spot'), single,
      h('h3', {}, 'Add a numbered range'), range));
  }
}

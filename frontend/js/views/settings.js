import { api, busy, fmtDate, h, openDialog, showError, toast } from '../ui.js';

export async function settingsView(el) {
  const staffBox = h('div');
  const locBox = h('div');
  const registryBox = h('div');
  const retentionBox = h('div');
  el.append(h('div', { class: 'page-head' }, h('h1', {}, 'Settings')), staffBox, locBox, registryBox, retentionBox);
  await Promise.all([renderStaff(), renderLocations(), renderRegistry(), renderRetention()]);

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
      h('p', { class: 'muted small' },
        'Change the periods with TRASH_DAYS and RETENTION_YEARS in the server’s .env file (RETENTION_YEARS=0 turns automatic deletion off).')));
  }

  async function renderRegistry() {
    const s = await api.get('/registry/status');
    registryBox.replaceChildren(h('section', { class: 'card' },
      h('h2', {}, 'Statens vegvesen sync'),
      s.configured
        ? h('p', {},
          `API key configured${s.key_hint ? ` (ending in …${s.key_hint})` : ''}. `,
          `Registered vehicles are re-synced every ${s.sync_days} days.`)
        : h('div', { class: 'notice warn' },
          'No API key configured. Set VEGVESEN_API_KEY in the server’s .env file (or the Portainer stack’s ',
          'environment variables) and redeploy.'),
      h('p', { class: 'muted small' },
        'To replace the key: change VEGVESEN_API_KEY on the server and redeploy (docker compose up -d, or ',
        '“Update the stack” in Portainer). No rebuild or code change needed.'),
      h('dl', { class: 'kv' },
        [['Synced OK', s.ok], ['Waiting', s.pending], ['Not found in registry', s.not_found], ['Errors', s.error],
          ['Due for sync now', s.due]].map(([k, val]) => [h('dt', {}, k), h('dd', {}, String(val))])),
      s.last_error ? h('p', { class: 'muted small' },
        `Latest error (${fmtDate(s.last_error.last_attempt_at)}): ${s.last_error.last_error}`) : null));
  }

  async function renderStaff() {
    const staff = await api.get('/staff?include_inactive=true');
    const name = h('input', { type: 'text', placeholder: 'Name', required: true, maxlength: 100 });
    const addBtn = h('button', { class: 'btn primary', type: 'submit' }, 'Add');
    const form = h('form', { class: 'inline-form' }, name, addBtn);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      busy(addBtn, async () => { await api.post('/staff', { name: name.value }); await renderStaff(); });
    });
    staffBox.replaceChildren(h('section', { class: 'card' },
      h('h2', {}, 'Staff / inspectors'),
      h('ul', { class: 'plain rows' }, staff.map((s) => h('li', { class: s.active ? '' : 'inactive' },
        h('span', {}, s.name, s.active ? '' : ' (inactive)'),
        h('button', {
          class: 'link', type: 'button',
          onClick: async () => {
            try { await api.patch(`/staff/${s.id}`, { active: !s.active }); await renderStaff(); } catch (e) { showError(e); }
          },
        }, s.active ? 'Deactivate' : 'Activate')))),
      form));
  }

  async function renderLocations() {
    const locs = await api.get('/storage-locations?include_inactive=true');

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
            h('button', { class: 'link', type: 'button', onClick: () => toggleActive(p) }, p.active ? 'Deactivate' : 'Activate'))),
        ...kids.map((c) => h('tr', { class: `sub-row${c.active ? '' : ' inactive'}` },
          h('td', { class: 'mono' }, `↳ ${c.own_code}`),
          h('td', {}, ''),
          h('td', {}, c.description ?? ''),
          h('td', {}, capacityInput(c)),
          h('td', {}, carsLink(c, c.vehicle_count)),
          h('td', { class: 'row-actions' },
            p.active ? h('button', { class: 'link', type: 'button', onClick: () => toggleActive(c) }, c.active ? 'Deactivate' : 'Activate') : null))),
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

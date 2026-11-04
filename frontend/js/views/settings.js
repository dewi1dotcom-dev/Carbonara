import { api, busy, h, showError, toast } from '../ui.js';

export async function settingsView(el) {
  const staffBox = h('div');
  const locBox = h('div');
  const registryBox = h('div');
  el.append(h('div', { class: 'page-head' }, h('h1', {}, 'Settings')), staffBox, locBox, registryBox);
  await Promise.all([renderStaff(), renderLocations(), renderRegistry()]);

  async function renderRegistry() {
    const s = await api.get('/registry/status');
    registryBox.replaceChildren(h('section', { class: 'card' },
      h('h2', {}, 'Statens vegvesen sync'),
      s.configured
        ? h('p', {}, `API key configured. Registered vehicles are re-synced every ${s.sync_days} days.`)
        : h('div', { class: 'notice warn' },
          'No API key configured. Set VEGVESEN_API_KEY in the server’s .env file and restart (docker compose up -d).'),
      h('dl', { class: 'kv' },
        [['Synced OK', s.ok], ['Waiting', s.pending], ['Not found in registry', s.not_found], ['Errors', s.error],
          ['Due for sync now', s.due]].map(([k, val]) => [h('dt', {}, k), h('dd', {}, String(val))])),
      s.last_error ? h('p', { class: 'muted small' },
        `Latest error (${new Date(s.last_error.last_attempt_at).toLocaleString()}): ${s.last_error.last_error}`) : null));
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
    const addBtn = h('button', { class: 'btn primary', type: 'submit' }, 'Add spot');
    const single = h('form', { class: 'inline-form wrap' }, code, zone, desc, addBtn);
    single.addEventListener('submit', (e) => {
      e.preventDefault();
      busy(addBtn, async () => {
        await api.post('/storage-locations', { code: code.value, zone: zone.value || null, description: desc.value || null });
        await renderLocations();
      });
    });

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

    locBox.replaceChildren(h('section', { class: 'card' },
      h('h2', {}, `Storage spots (${locs.filter((l) => l.active).length} active)`),
      locs.length
        ? h('div', { class: 'table-wrap' }, h('table', {},
          h('thead', {}, h('tr', {}, ['Code', 'Zone', 'Description', 'Occupied by', ''].map((t) => h('th', {}, t)))),
          h('tbody', {}, locs.map((l) => h('tr', { class: l.active ? '' : 'inactive' },
            h('td', { class: 'mono' }, l.code),
            h('td', {}, l.zone ?? ''),
            h('td', {}, l.description ?? ''),
            h('td', {}, l.occupied_by_vehicle_id
              ? h('a', { href: `#/vehicles/${l.occupied_by_vehicle_id}`, class: 'mono' }, l.occupied_by_vin)
              : h('span', { class: 'muted' }, 'free')),
            h('td', {}, h('button', {
              class: 'link', type: 'button',
              onClick: async () => {
                try { await api.patch(`/storage-locations/${l.id}`, { active: !l.active }); await renderLocations(); } catch (e) { showError(e); }
              },
            }, l.active ? 'Deactivate' : 'Activate')))))))
        : h('p', { class: 'empty' }, 'No storage spots yet.'),
      h('h3', {}, 'Add a spot'), single,
      h('h3', {}, 'Add a numbered range'), range));
  }
}

// The car's own photos (0.45.0; server: routers/vehicle_photos.py): copied from its finn.no ad by Carbonara
// Sidekick, or added here. The first one is the car's picture in lists until the arrival inspection has a
// right-side photo.
import { api, busy, h, openDialog, showError, toast } from '../ui.js';

const url = (p, variant = 'thumb') => `/api/vehicle-photos/${p.id}/${variant}`;

export function photosCard(v, photos, rerender) {
  const input = h('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true });
  const add = h('button', { class: 'btn', type: 'button', onClick: () => input.click() }, '📷 Add photos');
  input.addEventListener('change', () => busy(add, async () => {
    const files = [...input.files];
    for (const f of files) {
      const fd = new FormData();
      fd.append('file', f);
      await api.postForm(`/vehicles/${v.id}/photos`, fd);
    }
    input.value = '';
    toast(files.length === 1 ? 'Photo added' : `${files.length} photos added`, 'success');
    await rerender();
  }));
  return h('section', { class: 'card' },
    h('h2', {}, `Photos (${photos.length})`),
    photos.length
      ? h('div', { class: 'car-photos' }, photos.map((p, i) => h('button', {
        class: 'thumb', type: 'button', title: i === 0 ? 'The car’s picture in lists' : 'Open photo',
        onClick: () => photoDialog(p, i === 0, rerender),
      }, h('img', { src: url(p), alt: '', loading: 'lazy' }), i === 0 ? h('span', { class: 'badge first' }, '★') : null)))
      : h('p', { class: 'empty' }, 'No photos yet. Carbonara Sidekick can copy them from the car’s finn.no ad.'),
    h('div', { class: 'actions' }, add, input));
}

function photoDialog(p, first, rerender) {
  const act = (label, fn, cls = 'btn') => h('button', {
    class: cls, type: 'button',
    onClick: async () => { try { await fn(); } catch (e) { showError(e); } },
  }, label);
  const { close } = openDialog('Photo', h('div', { class: 'photo-view' },
    h('img', { src: url(p, 'display'), alt: '' }),
    h('div', { class: 'actions spread' },
      h('a', { href: url(p, 'original'), target: '_blank', rel: 'noopener', class: 'muted' }, 'Open original'),
      h('span', { class: 'row' },
        first ? null : act('★ Show first', async () => { await api.post(`/vehicle-photos/${p.id}/first`); close(); await rerender(); }),
        act('Delete', async () => {
          if (!confirm('Delete this photo?')) return;
          await api.del(`/vehicle-photos/${p.id}`);
          close();
          await rerender();
        }, 'btn danger')))), { wide: true });
}

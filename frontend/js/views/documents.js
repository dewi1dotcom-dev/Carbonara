// Documents per car: contracts, notes and other files (PDF, photos, Office files).
import { api, busy, fmtDate, h, openDialog, session, showError, toast } from '../ui.js';

const KIND_TEXT = { contract: 'Contract', note: 'Note', other: 'Other document' };
const KIND_ICON = { contract: '📝', note: '🗒', other: '📄' };
const ACCEPT = '.pdf,.jpg,.jpeg,.png,.webp,.heic,.heif,.doc,.docx,.xls,.xlsx,.odt,.ods,.txt,image/*,application/pdf';

const fmtSize = (n) => (n == null ? '' : n < 1024 * 1024
  ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} MB`);
const mayChange = (d) => !!(session.me?.is_admin || d.created_by === session.me?.id);

/** The Documents card on the vehicle page. docs = GET /vehicles/:id/documents. */
export function documentsCard(v, docs, rerender) {
  const rows = docs.map((d) => h('li', { class: 'doc-row' },
    h('div', { class: 'doc-main' },
      h('div', {}, h('strong', {}, `${KIND_ICON[d.kind]} ${d.title || KIND_TEXT[d.kind]}`),
        d.title ? h('span', { class: 'muted small' }, ` · ${KIND_TEXT[d.kind]}`) : null),
      d.has_file ? h('div', { class: 'small' },
        h('a', { href: `/api/documents/${d.id}/file`, target: '_blank', rel: 'noopener' }, d.original_name),
        h('span', { class: 'muted' }, ` · ${fmtSize(d.size_bytes)}`)) : null,
      d.body ? h('div', { class: 'doc-body' }, d.body) : null,
      h('div', { class: 'muted small' }, `Added ${fmtDate(d.created_at)}${d.created_by_name ? ` by ${d.created_by_name}` : ''}`),
      d.updated_at ? h('div', { class: 'muted small' },
        `Changed ${fmtDate(d.updated_at)}${d.updated_by_name ? ` by ${d.updated_by_name}` : ''}`) : null),
    mayChange(d) ? h('div', { class: 'row-actions' },
      h('button', { class: 'link', type: 'button', onClick: () => documentDialog(v, d, rerender) }, 'Edit'),
      h('button', {
        class: 'link danger', type: 'button',
        onClick: async () => {
          if (!confirm(`Delete "${d.title || d.original_name || KIND_TEXT[d.kind]}"? This can't be undone.`)) return;
          try {
            await api.del(`/documents/${d.id}`);
            toast('Document deleted', 'success');
            await rerender();
          } catch (e) { showError(e); }
        },
      }, 'Delete')) : null));
  return h('section', { class: 'card', id: 'documents-card' },
    h('div', { class: 'row spread-row' },
      h('h2', {}, `Documents (${docs.length})`),
      h('button', { class: 'btn', type: 'button', onClick: () => documentDialog(v, null, rerender) }, '+ Add document')),
    docs.length ? h('ul', { class: 'plain rows' }, rows)
      : h('p', { class: 'empty' }, 'No documents yet. Add contracts, notes or other files for this car.'));
}

/** Add (doc = null) or edit a document. A new one can have a file, a text, or both. */
export function documentDialog(v, doc, done) {
  const kind = h('select', { id: 'doc-kind' },
    Object.entries(KIND_TEXT).map(([k, t]) => h('option', { value: k }, t)));
  kind.value = doc?.kind || 'contract';
  const title = h('input', { type: 'text', id: 'doc-title', maxlength: 200, value: doc?.title || '', placeholder: 'E.g. Purchase contract' });
  const body = h('textarea', { id: 'doc-body', rows: 5, maxlength: 10000 });
  body.value = doc?.body || '';
  const file = doc ? null : h('input', { type: 'file', id: 'doc-file', accept: ACCEPT });
  const save = h('button', { class: 'btn primary', type: 'submit' }, 'Save');
  const form = h('form', {},
    h('div', { class: 'grid' },
      h('div', { class: 'field' }, h('label', { for: 'doc-kind' }, 'Type'), kind),
      h('div', { class: 'field' }, h('label', { for: 'doc-title' }, 'Title'), title)),
    file ? h('div', { class: 'field' }, h('label', { for: 'doc-file' }, 'File (PDF, photo, Word, Excel or text)'), file)
      : (doc.has_file ? h('p', { class: 'small' }, `File: ${doc.original_name}`) : null),
    h('div', { class: 'field' }, h('label', { for: 'doc-body' }, 'Text / note'), body),
    h('p', { class: 'muted small' }, doc ? 'The file itself can’t be replaced; delete the document and add it again.'
      : 'Add a file, write a text, or both. On a phone you can take a photo of a paper contract.'),
    h('div', { class: 'actions' }, save));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!doc && !file.files.length && !body.value.trim()) { showError(new Error('Add a file or write a text')); return; }
    busy(save, async () => {
      if (doc) {
        await api.patch(`/documents/${doc.id}`, { kind: kind.value, title: title.value, body: body.value });
      } else {
        const fd = new FormData();
        fd.append('kind', kind.value);
        fd.append('title', title.value);
        fd.append('body', body.value);
        if (file.files.length) fd.append('file', file.files[0]);
        await api.postForm(`/vehicles/${v.id}/documents`, fd);
      }
      close();
      toast('Document saved', 'success');
      await done();
    });
  });
  const { close } = openDialog(doc ? 'Edit document' : 'Add document', form);
}

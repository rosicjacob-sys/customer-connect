import React, { useCallback, useEffect, useState } from 'react';
import api from '../lib/api';
import { fmtWhen } from '../lib/util';
import { Empty, Loading, Modal, useConfirm, useToast } from '../components/ui';
import { PreviewModal, SendTestPanel, TokenReference, UnsubscribeWarning, downloadTemplateHtml } from '../components/email';

const STARTER_HTML = `<!DOCTYPE html>
<html>
<body style="margin:0;padding:24px;background:{{store_brand_color_light}};font-family:Arial,sans-serif;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;padding:28px;">
    {{moved_banner}}
    <p>Hi {{customer_name}},</p>
    <p>Your message here.</p>
    <p><a href="{{store_url}}" style="display:inline-block;background:{{store_brand_color}};color:{{store_brand_text_color}};padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:bold;">Shop now</a></p>
    <p style="font-size:12px;color:#888888;">{{store_name}} · <a href="{{unsubscribe_url}}" style="color:#888888;">Unsubscribe</a></p>
  </div>
</body>
</html>`;

function EditorModal({ template, storeGroup, stores, onClose, onSaved }) {
  const [name, setName] = useState(template?.name || '');
  const [subject, setSubject] = useState(template?.subject || '');
  const [html, setHtml] = useState(template?.html || STARTER_HTML);
  const [text, setText] = useState(template?.text || '');
  const [preview, setPreview] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Pasting a whole template into the untouched starter replaces it, rather
  // than leaving the starter's "Your message here." stacked on top.
  const onPaste = (e) => {
    if (html.trim() !== STARTER_HTML.trim()) return;
    e.preventDefault();
    setHtml(e.clipboardData.getData('text'));
  };

  const save = async () => {
    if (template?.html !== html && html.includes('<p>Your message here.</p>')) {
      return setError('The starter line "Your message here." is still in the HTML and would be sent. Replace it with your message.');
    }
    setSaving(true);
    setError('');
    try {
      const payload = { name, subject, html, text };
      onSaved(template ? await api.updateTemplate(template.id, payload) : await api.createTemplate({ ...payload, storeGroup }));
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  };

  return (
    <Modal title={template ? 'Edit template' : 'New template'} wide onClose={onClose} busy={saving} footer={<>
      <button type="button" className="btn" onClick={() => setPreview(true)} disabled={!html.trim()}>Preview</button>
      <span className="spacer" />
      <button type="button" className="btn" onClick={onClose} disabled={saving}>Cancel</button>
      <button type="button" className="btn btn-primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save template'}</button>
    </>}>
      {preview && <PreviewModal subject={subject} html={html} text={text} name={name} stores={stores} onClose={() => setPreview(false)} />}
      <div className="stack">
        <TokenReference />
        <label className="field"><span>Name</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Restock notice" autoFocus /></label>
        <label className="field"><span>Subject</span><input className="input" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="e.g. {{customer_name}}, your favourites are back" /></label>
        <label className="field"><span>HTML</span>
          <textarea className="textarea" rows={14} value={html} onChange={(e) => setHtml(e.target.value)} onPaste={onPaste} spellCheck={false} />
        </label>
        <UnsubscribeWarning html={html} />
        <label className="field"><span>Plain text (optional)</span>
          <textarea className="textarea" rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder="For mail apps that don't show HTML" />
        </label>
        <SendTestPanel subject={subject} html={html} text={text} name={name} stores={stores} />
        {error && <div className="error">{error}</div>}
      </div>
    </Modal>
  );
}

export default function Templates({ storeGroup, storeGroupName }) {
  const toast = useToast();
  const [confirm, confirmDialog] = useConfirm();
  const [templates, setTemplates] = useState(null);
  const [stores, setStores] = useState([]);
  const [editing, setEditing] = useState(null); // null | 'new' | template
  const [preview, setPreview] = useState(null);

  const load = useCallback(() => api.templates(storeGroup).then(setTemplates).catch((e) => { toast(e.message, { bad: true }); setTemplates([]); }), [storeGroup, toast]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { api.stores(storeGroup).then((s) => setStores(s.filter((x) => x.isActive))).catch(() => {}); }, [storeGroup]);

  const withFull = (fn) => async (t) => {
    try { fn(await api.template(t.id)); } catch (err) { toast(err.message, { bad: true }); }
  };
  const remove = async (t) => {
    if (!(await confirm({ title: `Delete "${t.name}"?`, message: 'Campaigns already made from it keep their own copy and are not affected.', confirmLabel: 'Delete', danger: true }))) return;
    try { await api.deleteTemplate(t.id); toast(`"${t.name}" deleted`); load(); } catch (err) { toast(err.message, { bad: true }); }
  };

  return (
    <main className="page page-narrow">
      {confirmDialog}
      {editing && <EditorModal template={editing === 'new' ? null : editing} storeGroup={storeGroup} stores={stores}
        onClose={() => setEditing(null)} onSaved={(t) => { setEditing(null); toast(`"${t.name}" saved`); load(); }} />}
      {preview && <PreviewModal {...preview} stores={stores} onClose={() => setPreview(null)} />}
      <div className="page-head">
        <h1>Templates</h1>
        <button type="button" className="btn btn-primary" onClick={() => setEditing('new')}>+ New template</button>
      </div>
      <div className="page-sub">
        Paste your own HTML; tokens like {'{{customer_name}}'} and {'{{store_brand_color}}'} are filled in per recipient.
        {storeGroupName ? ` Showing ${storeGroupName} templates and ones shared by every group.` : ''}
      </div>
      {!templates ? <Loading /> : templates.length === 0 ? (
        <Empty icon="🎨" title="No templates yet">
          <p>Start from the example, or paste HTML you already have.</p>
          <button type="button" className="btn btn-primary" onClick={() => setEditing('new')}>+ New template</button>
        </Empty>
      ) : (
        <div className="list">
          {templates.map((t) => (
            <div key={t.id} className="card row">
              <div className="grow" style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 700 }}>{t.name} {!t.store_group && storeGroup && <span className="badge">all groups</span>}</div>
                <div className="light ellipsis" style={{ fontSize: 12.5 }}>{t.subject}</div>
                <div className="hint">Updated {fmtWhen(t.updated_at)}</div>
              </div>
              <div className="row" style={{ gap: 6 }}>
                <button type="button" className="icon-btn" title="Preview" aria-label="Preview" onClick={() => withFull((f) => setPreview({ subject: f.subject, html: f.html, text: f.text, name: f.name }))(t)}>👁</button>
                <button type="button" className="icon-btn" title="Download HTML" aria-label="Download HTML" onClick={() => withFull((f) => downloadTemplateHtml(f.name, f.html))(t)}>⬇</button>
                <button type="button" className="icon-btn" title="Edit" aria-label="Edit" onClick={() => withFull(setEditing)(t)}>✎</button>
                <button type="button" className="icon-btn danger" title="Delete" aria-label="Delete" onClick={() => remove(t)}>🗑</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}

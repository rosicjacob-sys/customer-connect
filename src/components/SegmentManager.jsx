import React, { useMemo, useState } from 'react';
import api from '../lib/api';
import { Modal, useConfirm } from './ui';

// Create, edit or delete store segments ("PC", "ARL"). Lists only the stores
// in the current group; saving replaces just that group's memberships.
export default function SegmentManager({ stores, segments, storeGroup, onClose, onSaved }) {
  const [confirm, confirmDialog] = useConfirm();
  const [editingId, setEditingId] = useState(segments[0]?.id ?? 'new');
  const editing = segments.find((g) => g.id === editingId) || null;
  const [name, setName] = useState(editing?.name || '');
  const [picked, setPicked] = useState(new Set(editing?.storeIds || []));
  const [search, setSearch] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const startEdit = (id) => {
    const g = segments.find((x) => x.id === id) || null;
    setEditingId(g ? g.id : 'new');
    setName(g?.name || '');
    setPicked(new Set(g?.storeIds || []));
    setError('');
  };

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? stores.filter((s) => s.brandName.toLowerCase().includes(q) || s.domain.includes(q)) : stores;
  }, [stores, search]);

  const toggle = (id) => setPicked((prev) => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next; });
  const setShown = (on) => setPicked((prev) => { const next = new Set(prev); shown.forEach((s) => (on ? next.add(s.id) : next.delete(s.id))); return next; });

  const save = async () => {
    if (!name.trim()) return setError('Give the segment a name.');
    setSaving(true);
    setError('');
    try {
      const saved = await api.saveSegment({ id: editing?.id, name: name.trim(), storeIds: [...picked], storeGroup });
      await onSaved(saved.id);
      setEditingId(saved.id);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!editing || !(await confirm({ title: `Delete the "${editing.name}" segment?`, message: 'Its stores move to Others. No customers are deleted.', confirmLabel: 'Delete segment', danger: true }))) return;
    setSaving(true);
    try {
      await api.deleteSegment(editing.id);
      await onSaved(null);
      startEdit(segments.find((g) => g.id !== editing.id)?.id ?? 'new');
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title="Store segments" onClose={onClose} busy={saving} footer={<>
      {editing && <button type="button" className="btn btn-danger" disabled={saving} onClick={remove}>Delete segment</button>}
      <span className="spacer" />
      <button type="button" className="btn btn-primary" disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save segment'}</button>
    </>}>
      {confirmDialog}
      <div className="stack">
        <div className="row" style={{ gap: 6 }}>
          {segments.map((g) => (
            <button key={g.id} type="button" className={`btn btn-sm ${editingId === g.id ? 'btn-primary' : ''}`} onClick={() => startEdit(g.id)}>
              {g.name} ({g.storeIds.length})
            </button>
          ))}
          <button type="button" className={`btn btn-sm ${editingId === 'new' ? 'btn-primary' : ''}`} onClick={() => startEdit('new')}>+ New segment</button>
        </div>
        <label className="field"><span>Name</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. PC" /></label>
        <div className="row">
          <input className="input input-sm grow" placeholder="Search stores…" value={search} onChange={(e) => setSearch(e.target.value)} />
          <button type="button" className="btn btn-sm" onClick={() => setShown(true)}>Select shown</button>
          <button type="button" className="btn btn-sm" onClick={() => setShown(false)}>Clear shown</button>
        </div>
        <div className="hint">{picked.size} selected</div>
        <div className="list-box" style={{ maxHeight: 280 }}>
          {shown.length === 0 && <div className="empty" style={{ padding: 20 }}>No stores here yet.</div>}
          {shown.map((s) => (
            <label key={s.id}>
              <input type="checkbox" checked={picked.has(s.id)} onChange={() => toggle(s.id)} />
              <span>{s.brandName}</span><span className="hint">{s.domain}</span>
            </label>
          ))}
        </div>
        {error && <div className="error">{error}</div>}
      </div>
    </Modal>
  );
}

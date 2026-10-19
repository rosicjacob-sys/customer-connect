import React, { useCallback, useEffect, useMemo, useState } from 'react';
import api from '../lib/api';
import { n, plural } from '../lib/util';
import { Empty, Loading, Modal, useConfirm, useToast } from '../components/ui';
import SegmentManager from '../components/SegmentManager';

const BLANK = { brandName: '', domain: '', storeGroup: '', storeGroupName: '', country: '', brandColor: '', fromEmail: '', fromName: '', replyTo: '', isActive: true };

function StoreModal({ store, groups, defaultFrom, onClose, onSaved }) {
  const [form, setForm] = useState(() => ({ ...BLANK, ...(store || {}), brandColor: store?.brandColor || '', storeGroup: store?.storeGroupName || store?.storeGroup || '' }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  const save = async () => {
    setSaving(true);
    setError('');
    // The group box takes a name; an existing group is matched by name or key.
    const typed = form.storeGroup.trim();
    const match = groups.find((g) => g.name.toLowerCase() === typed.toLowerCase() || g.key === typed.toLowerCase());
    const payload = { ...form, storeGroup: match ? match.key : typed, storeGroupName: match ? match.name : typed };
    try {
      onSaved(store ? await api.updateStore(store.id, payload) : await api.addStore(payload));
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  };

  return (
    <Modal title={store ? `Edit ${store.brandName}` : 'Add a store'} onClose={onClose} busy={saving} footer={<>
      <button type="button" className="btn" onClick={onClose} disabled={saving}>Cancel</button>
      <button type="button" className="btn btn-primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
    </>}>
      <div className="stack">
        {store?.fromChatSupport && <div className="warn">Copied from Chat Support Pro. The next sync overwrites these details (except reply-to), so change them there.</div>}
        <div className="row">
          <label className="field"><span>Store name</span><input className="input" value={form.brandName} onChange={set('brandName')} placeholder="Toronto Peptides" autoFocus /></label>
          <label className="field"><span>Domain</span><input className="input" value={form.domain} onChange={set('domain')} placeholder="torontopeptides.shop" /></label>
        </div>
        {store && form.domain.trim().toLowerCase() !== store.domain && <div className="hint">Changing the domain moves this store's customers to the new domain.</div>}
        <div className="row">
          <label className="field"><span>Group</span>
            <input className="input" list="cc-groups" value={form.storeGroup} onChange={set('storeGroup')} placeholder="e.g. Peptides Group" />
            <datalist id="cc-groups">{groups.map((g) => <option key={g.key} value={g.name} />)}</datalist>
          </label>
          <label className="field" style={{ maxWidth: 120 }}><span>Country</span>
            <select className="select" value={form.country || ''} onChange={set('country')}><option value="">—</option><option value="CA">CA</option><option value="US">US</option></select>
          </label>
        </div>
        <div className="row">
          <label className="field" style={{ maxWidth: 170 }}><span>Brand colour</span>
            <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
              <input type="color" value={/^#[0-9a-f]{6}$/i.test(form.brandColor) ? form.brandColor : '#1a5632'} onChange={set('brandColor')} aria-label="Pick colour" style={{ width: 40, height: 36, border: 0, background: 'none', padding: 0 }} />
              <input className="input" value={form.brandColor} onChange={set('brandColor')} placeholder="#1A5632" />
            </div>
          </label>
          <label className="field"><span>Sender name</span><input className="input" value={form.fromName} onChange={set('fromName')} placeholder={form.brandName || defaultFrom?.name} /></label>
        </div>
        <label className="field"><span>Sender address</span>
          <input className="input" type="email" value={form.fromEmail} onChange={set('fromEmail')} placeholder={defaultFrom?.email} />
          <span className="hint">Its domain must be verified in Resend. Blank uses the default ({defaultFrom?.email}).</span>
        </label>
        <label className="field"><span>Reply-to (optional)</span><input className="input" type="email" value={form.replyTo} onChange={set('replyTo')} placeholder="support@yourstore.com" /></label>
        <label className="row" style={{ gap: 8 }}><input type="checkbox" checked={form.isActive} onChange={set('isActive')} /><span>Active (shown when building campaigns)</span></label>
        {error && <div className="error">{error}</div>}
      </div>
    </Modal>
  );
}

export default function Stores({ storeGroup, storeGroupName, groups, refreshGroups, status, user }) {
  const toast = useToast();
  const [confirm, confirmDialog] = useConfirm();
  const [stores, setStores] = useState(null);
  const [editing, setEditing] = useState(null);
  const [segments, setSegments] = useState(null);
  const [showSegments, setShowSegments] = useState(false);
  const [search, setSearch] = useState('');
  const [waiting, setWaiting] = useState([]);
  const [adding, setAdding] = useState(false);

  const load = useCallback(() => {
    api.stores(storeGroup).then(setStores).catch((e) => { toast(e.message, { bad: true }); setStores([]); });
    api.segments(storeGroup).then(setSegments).catch(() => {});
    api.waitingStores().then(setWaiting).catch(() => {});
  }, [storeGroup, toast]);

  // Customers came in (an order, a chat, a sync) for stores not set up yet.
  const addWaiting = async (list) => {
    setAdding(true);
    try {
      const g = groups.find((x) => x.key === storeGroup);
      const res = await api.addStores(list.map((w) => ({ domain: w.domain, brandName: w.store_name || w.domain })),
        g ? { storeGroup: g.key, storeGroupName: g.name } : {});
      toast(`Added ${plural(res.added.length, 'store')}; ${plural(res.customersLinked, 'customer')} linked. Set their colour, country and sender.`);
      load();
      refreshGroups();
    } catch (err) {
      toast(err.message, { bad: true });
    } finally {
      setAdding(false);
    }
  };
  useEffect(() => { load(); }, [load]);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return !stores ? [] : q ? stores.filter((s) => s.brandName.toLowerCase().includes(q) || s.domain.includes(q)) : stores;
  }, [stores, search]);

  const remove = async (s) => {
    if (!(await confirm({ title: `Delete ${s.brandName}?`, message: `Its ${n(s.customerCount)} customers stay on the list without a store, and can't be emailed until it's added back.`, confirmLabel: 'Delete store', danger: true }))) return;
    try { await api.deleteStore(s.id); toast(`${s.brandName} deleted`); load(); refreshGroups(); } catch (err) { toast(err.message, { bad: true }); }
  };

  const defaultFrom = { email: status?.defaultFromEmail, name: status?.defaultFromName };
  return (
    <main className="page">
      {confirmDialog}
      {editing && <StoreModal store={editing === 'new' ? null : editing} groups={groups} defaultFrom={defaultFrom} onClose={() => setEditing(null)}
        onSaved={(s) => { setEditing(null); toast(`${s.brandName} saved`); load(); refreshGroups(); }} />}
      {showSegments && segments && (
        <SegmentManager stores={stores || []} segments={segments.segments} storeGroup={storeGroup}
          onClose={() => setShowSegments(false)} onSaved={async () => { const s = await api.segments(storeGroup); setSegments(s); }} />
      )}
      <div className="page-head">
        <h1>Stores</h1>
        <button type="button" className="btn" onClick={() => setShowSegments(true)} disabled={!segments}>Segments{segments ? ` (${segments.segments.length})` : ''}</button>
        <button type="button" className="btn btn-primary" onClick={() => setEditing('new')}>+ Add store</button>
      </div>
      <div className="page-sub">
        Each store is a sender: its name, colour and address fill the emails its customers get.
        {status?.chatSupport?.configured && user.role === 'admin' && ' Stores from Chat Support Pro are copied over under Settings.'}
      </div>
      {waiting.length > 0 && (
        <div className="card" style={{ marginBottom: 16, background: 'var(--warning-soft)', borderColor: 'var(--warning-border)' }}>
          <div className="row" style={{ marginBottom: 6 }}>
            <div className="grow" style={{ fontWeight: 700 }}>
              {plural(waiting.reduce((a, w) => a + w.customers, 0), 'customer')} waiting for {waiting.length === 1 ? 'a store that isn\'t set up' : `${n(waiting.length)} stores that aren't set up`}
            </div>
            <button type="button" className="btn btn-sm btn-primary" disabled={adding} onClick={() => addWaiting(waiting)}>
              {adding ? 'Adding…' : waiting.length === 1 ? 'Add it' : `Add all ${n(waiting.length)}`}{storeGroupName ? ` to ${storeGroupName}` : ''}
            </button>
          </div>
          <div className="light" style={{ marginBottom: 8 }}>They came from orders, chats or a sync. They can't be emailed until their store exists.</div>
          <div className="row" style={{ gap: 6 }}>
            {waiting.slice(0, 30).map((w) => (
              <button key={w.domain} type="button" className="btn btn-sm" disabled={adding} title="Add this store" onClick={() => addWaiting([w])}>
                + {w.store_name || w.domain} <span className="hint">({n(w.customers)})</span>
              </button>
            ))}
          </div>
        </div>
      )}
      {!stores ? <Loading /> : stores.length === 0 ? (
        <Empty icon="🏬" title="No stores yet">
          <p>Add your stores{status?.chatSupport?.configured ? ', or copy them from Chat Support Pro under Settings' : ''}.</p>
          <button type="button" className="btn btn-primary" onClick={() => setEditing('new')}>+ Add store</button>
        </Empty>
      ) : (
        <>
          {stores.length > 8 && <input className="input" style={{ marginBottom: 12 }} placeholder="Search stores…" value={search} onChange={(e) => setSearch(e.target.value)} />}
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Store</th><th className="hide-sm">Group</th><th>Sender</th><th className="hide-sm">Customers</th><th /></tr></thead>
              <tbody>
                {shown.map((s) => (
                  <tr key={s.id} style={s.isActive ? undefined : { opacity: 0.55 }}>
                    <td>
                      <div className="row" style={{ gap: 8, flexWrap: 'nowrap' }}>
                        <span className="swatch" style={{ background: s.brandColor || '#1a5632' }} />
                        <div><strong>{s.brandName}</strong>{!s.isActive && <span className="badge" style={{ marginLeft: 6 }}>inactive</span>}
                          {s.fromChatSupport && <span className="badge badge-chat" style={{ marginLeft: 6 }}>CSP</span>}
                          <div className="hint">{s.domain}{s.country ? ` · ${s.country}` : ''}</div></div>
                      </div>
                    </td>
                    <td className="hide-sm light">{s.storeGroupName || '—'}</td>
                    <td className="light">{s.fromName || s.brandName}<div className="hint">{s.fromEmail || `${defaultFrom.email || ''} (default)`}</div></td>
                    <td className="hide-sm">{n(s.customerCount)}</td>
                    <td className="nowrap" style={{ textAlign: 'right' }}>
                      <button type="button" className="icon-btn" title="Edit" aria-label={`Edit ${s.brandName}`} onClick={() => setEditing(s)}>✎</button>{' '}
                      <button type="button" className="icon-btn danger" title="Delete" aria-label={`Delete ${s.brandName}`} onClick={() => remove(s)}>🗑</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </main>
  );
}

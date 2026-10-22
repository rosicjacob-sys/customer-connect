import React, { useCallback, useEffect, useMemo, useState } from 'react';
import api from '../lib/api';
import { n, plural } from '../lib/util';
import { Empty, Loading, Modal, useConfirm, useToast } from '../components/ui';
import { ChoiceModal, RowCheckbox, SelectionBar, ViewCheckbox, useSelection } from '../components/selection';
import SegmentManager from '../components/SegmentManager';

const BLANK = { brandName: '', domain: '', storeGroup: '', storeGroupName: '', country: '', brandColor: '', fromEmail: '', fromName: '', replyTo: '', isActive: true };

function StoreModal({ store, groups, defaultFrom, onClose, onSaved, onRuleRemoved }) {
  const toast = useToast();
  const [form, setForm] = useState(() => ({ ...BLANK, ...(store || {}), brandColor: store?.brandColor || '', storeGroup: store?.storeGroupName || store?.storeGroup || '' }));
  const [aliases, setAliases] = useState(store?.aliases || []);
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

  const removeRule = async (domain) => {
    try {
      await api.removeStoreRule(domain);
      setAliases((a) => a.filter((d) => d !== domain));
      toast(`New customers from ${domain} will wait for a store again. Customers already moved stay here.`);
      onRuleRemoved();
    } catch (err) { setError(err.message); }
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
        {aliases.length > 0 && (
          <div className="card" style={{ background: 'var(--surface-2)' }}>
            <div className="label" style={{ marginBottom: 4 }}>Also takes customers from</div>
            <div className="hint" style={{ marginBottom: 8 }}>Orders and chats from these domains go to this store. Removing one leaves the customers already moved here.</div>
            <div className="row" style={{ gap: 6 }}>
              {aliases.map((d) => (
                <span key={d} className="btn btn-sm" style={{ cursor: 'default' }}>
                  {d}<button type="button" className="link-btn" style={{ marginLeft: 6, textDecoration: 'none' }} aria-label={`Remove ${d}`} title="Stop sending this domain's new customers here" onClick={() => removeRule(d)}>✕</button>
                </span>
              ))}
            </div>
          </div>
        )}
        {error && <div className="error">{error}</div>}
      </div>
    </Modal>
  );
}

// Stores that customers came in for but aren't set up: tick them, then add
// them as stores or give them (and their customers) to an existing store.
function WaitingCard({ waiting, storeGroupName, busy, onAdd, onAssign }) {
  const [picked, setPicked] = useState(new Set());
  useEffect(() => { setPicked((p) => new Set([...p].filter((d) => waiting.some((w) => w.domain === d)))); }, [waiting]);
  const list = picked.size ? waiting.filter((w) => picked.has(w.domain)) : waiting;
  const which = picked.size ? `${n(picked.size)} selected` : waiting.length === 1 ? 'it' : `all ${n(waiting.length)}`;
  const toggle = (d) => setPicked((p) => { const s = new Set(p); s.has(d) ? s.delete(d) : s.add(d); return s; });
  return (
    <div className="card" style={{ marginBottom: 16, background: 'var(--warning-soft)', borderColor: 'var(--warning-border)' }}>
      <div className="row" style={{ marginBottom: 6 }}>
        <div className="grow" style={{ fontWeight: 700 }}>
          {plural(waiting.reduce((a, w) => a + w.customers, 0), 'customer')} waiting for {waiting.length === 1 ? 'a store that isn\'t set up' : `${n(waiting.length)} stores that aren't set up`}
        </div>
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => onAssign(list)}>Assign {which} to a store…</button>
        <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => onAdd(list)}>
          {busy ? 'Working…' : `Add ${which} as new store${list.length === 1 ? '' : 's'}`}{storeGroupName ? ` in ${storeGroupName}` : ''}
        </button>
      </div>
      <div className="light" style={{ marginBottom: 8 }}>
        They came from orders, chats or a sync, and can't be emailed until they have a store. Tick some to act on just those.
        {waiting.length > 1 && <> <button type="button" className="link-btn" onClick={() => setPicked(picked.size === waiting.length ? new Set() : new Set(waiting.map((w) => w.domain)))}>
          {picked.size === waiting.length ? 'Deselect all' : 'Select all'}</button></>}
      </div>
      <div className="row" style={{ gap: 6 }}>
        {waiting.slice(0, 60).map((w) => (
          <button key={w.domain} type="button" className={`btn btn-sm ${picked.has(w.domain) ? 'chip-on' : ''}`} aria-pressed={picked.has(w.domain)} title={w.domain} onClick={() => toggle(w.domain)}>
            {picked.has(w.domain) ? '✓ ' : ''}{w.store_name || w.domain} <span className="hint">({n(w.customers)})</span>
          </button>
        ))}
        {waiting.length > 60 && <span className="hint">and {n(waiting.length - 60)} more</span>}
      </div>
    </div>
  );
}

export default function Stores({ storeGroup, storeGroupName, groups, refreshGroups, status, user }) {
  const toast = useToast();
  const [confirm, confirmDialog] = useConfirm();
  const [stores, setStores] = useState(null);
  const [allStores, setAllStores] = useState([]);
  const [editing, setEditing] = useState(null);
  const [segments, setSegments] = useState(null);
  const [showSegments, setShowSegments] = useState(false);
  const [search, setSearch] = useState('');
  const [waiting, setWaiting] = useState([]);
  const [busy, setBusy] = useState(false);
  const [choice, setChoice] = useState(null); // a batch action waiting for its value
  const sel = useSelection(`${storeGroup}|${search}`);

  const load = useCallback(() => {
    api.stores(storeGroup).then(setStores).catch((e) => { toast(e.message, { bad: true }); setStores([]); });
    api.stores().then(setAllStores).catch(() => {});
    api.segments(storeGroup).then(setSegments).catch(() => {});
    api.waitingStores().then(setWaiting).catch(() => {});
  }, [storeGroup, toast]);
  useEffect(() => { load(); }, [load]);

  const addWaiting = async (list) => {
    setBusy(true);
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
      setBusy(false);
    }
  };

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return !stores ? [] : q ? stores.filter((s) => s.brandName.toLowerCase().includes(q) || s.domain.includes(q)) : stores;
  }, [stores, search]);
  const shownIds = shown.map((s) => s.id);
  const pickedStores = (stores || []).filter((s) => sel.isChecked(s.id));
  const which = plural(pickedStores.length, 'store');
  const fromCsp = pickedStores.filter((s) => s.fromChatSupport).length;
  const cspNote = (what) => (fromCsp
    ? ` ${fromCsp === pickedStores.length ? 'They come' : `${n(fromCsp)} of them come`} from Chat Support Pro: its next sync ${what}. Change those there instead.`
    : '');

  const storeOptions = allStores.map((s) => ({ value: String(s.id), label: `${s.brandName} (${s.domain})${s.storeGroupName ? ` · ${s.storeGroupName}` : ''}` }));

  const batch = async (action, extra = {}, done = (r) => `Updated ${plural(r.changed, 'store')}`) => {
    setBusy(true);
    try {
      const r = await api.storesBatch(pickedStores.map((s) => s.id), action, extra);
      toast(done(r));
      sel.clear();
      load();
      refreshGroups();
    } catch (err) {
      toast(err.message, { bad: true });
      throw err;
    } finally {
      setBusy(false);
    }
  };
  const ask = async (action, opts, extra, done) => {
    if (!(await confirm(opts))) return;
    batch(action, extra, done).catch(() => {});
  };

  const remove = async (s) => {
    if (!(await confirm({ title: `Delete ${s.brandName}?`, message: `Its ${n(s.customerCount)} customers stay on the list without a store, and can't be emailed until it's added back.`, confirmLabel: 'Delete store', danger: true }))) return;
    try { await api.deleteStore(s.id); toast(`${s.brandName} deleted`); load(); refreshGroups(); } catch (err) { toast(err.message, { bad: true }); }
  };

  const choiceModal = () => {
    if (!choice) return null;
    const close = () => setChoice(null);
    const common = { onClose: close };
    if (choice.kind === 'assign') {
      const list = choice.list;
      const count = list.reduce((a, w) => a + w.customers, 0);
      return (
        <ChoiceModal {...common} title={`Assign ${list.length === 1 ? (list[0].store_name || list[0].domain) : `${n(list.length)} stores`} to a store`}
          label="Store" options={storeOptions} confirmLabel="Assign"
          message={`Their ${plural(count, 'customer')} move to the store you pick and can be emailed as it. Later orders and chats from ${list.length === 1 ? list[0].domain : 'these domains'} go there too (you can undo that in the store's edit window).`}
          onConfirm={async (p) => {
            const r = await api.assignStores(list.map((w) => w.domain), Number(p.value));
            toast(`${plural(r.customersMoved, 'customer')} moved to ${r.store}`);
            close();
            load();
          }} />
      );
    }
    if (choice.kind === 'segment-add' || choice.kind === 'segment-remove') {
      const adding = choice.kind === 'segment-add';
      return (
        <ChoiceModal {...common} title={adding ? `Add ${which} to a segment` : `Remove ${which} from a segment`} label="Segment"
          options={(segments?.segments || []).map((g) => ({ value: String(g.id), label: g.name }))}
          allowNew={adding} newLabel="Or make a new segment" confirmLabel={adding ? 'Add' : 'Remove'}
          onConfirm={async (p) => {
            await batch(choice.kind, p.isNew ? { segmentName: p.value } : { segmentId: Number(p.value) },
              (r) => (adding ? `Added ${plural(r.changed, 'store')} to the segment` : `Removed ${plural(r.changed, 'store')} from the segment`));
            close();
          }} />
      );
    }
    if (choice.kind === 'group') {
      return (
        <ChoiceModal {...common} title={`Move ${which} to a group`} label="Group"
          options={[{ value: '__none', label: 'No group' }, ...groups.map((g) => ({ value: g.key, label: g.name }))]}
          allowNew newLabel="Or a new group" message={cspNote('sets their group back') || undefined}
          onConfirm={async (p) => {
            const g = groups.find((x) => x.key === p.value);
            const extra = p.isNew ? { storeGroup: p.value, storeGroupName: p.value } : p.value === '__none' ? { storeGroup: '' } : { storeGroup: g.key, storeGroupName: g.name };
            await batch('group', extra);
            close();
          }} />
      );
    }
    if (choice.kind === 'country') {
      return (
        <ChoiceModal {...common} title={`Set the country of ${which}`} label="Country"
          options={[{ value: 'CA', label: '🇨🇦 Canada' }, { value: 'US', label: '🇺🇸 USA' }, { value: '__none', label: 'No country' }]}
          message={cspNote('sets their country back') || undefined}
          onConfirm={async (p) => { await batch('country', { country: p.value === '__none' ? '' : p.value }); close(); }} />
      );
    }
    if (choice.kind === 'merge') {
      return (
        <ChoiceModal {...common} title={`Merge ${which}`} label="Keep this store" options={storeOptions} confirmLabel="Merge" danger
          message="Every selected store except the one you keep is deleted. Their customers move to the store you keep, and their domains become rules, so later orders and chats from them go there too. This can't be undone."
          onConfirm={async (p) => {
            await batch('merge', { targetId: Number(p.value) }, (r) => `Merged ${plural(r.changed, 'store')} into ${r.into}; ${plural(r.customersMoved, 'customer')} moved`);
            close();
          }} />
      );
    }
    return null;
  };

  const defaultFrom = { email: status?.defaultFromEmail, name: status?.defaultFromName };
  return (
    <main className="page">
      {confirmDialog}
      {choiceModal()}
      {editing && <StoreModal store={editing === 'new' ? null : editing} groups={groups} defaultFrom={defaultFrom} onClose={() => setEditing(null)}
        onRuleRemoved={load}
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
        <WaitingCard waiting={waiting} storeGroupName={storeGroupName} busy={busy}
          onAdd={addWaiting} onAssign={(list) => setChoice({ kind: 'assign', list })} />
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
              <thead><tr>
                <th className="check-cell"><ViewCheckbox sel={sel} ids={shownIds} label="Select all shown stores" /></th>
                <th>Store</th><th className="hide-sm">Group</th><th>Sender</th><th className="hide-sm">Customers</th><th />
              </tr></thead>
              <tbody>
                {shown.map((s) => (
                  <tr key={s.id} style={s.isActive ? undefined : { opacity: 0.55 }}>
                    <td className="check-cell"><RowCheckbox sel={sel} id={s.id} label={`Select ${s.brandName}`} /></td>
                    <td>
                      <div className="row" style={{ gap: 8, flexWrap: 'nowrap' }}>
                        <span className="swatch" style={{ background: s.brandColor || '#1a5632' }} />
                        <div><strong>{s.brandName}</strong>{!s.isActive && <span className="badge" style={{ marginLeft: 6 }}>inactive</span>}
                          {s.fromChatSupport && <span className="badge badge-chat" style={{ marginLeft: 6 }}>CSP</span>}
                          <div className="hint">{s.domain}{s.country ? ` · ${s.country}` : ''}{s.aliases.length ? ` · also ${s.aliases.length === 1 ? s.aliases[0] : `${n(s.aliases.length)} other domains`}` : ''}</div></div>
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
          <SelectionBar sel={sel} total={shown.length} viewIds={shownIds} noun={['store', 'stores']}>
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setChoice({ kind: 'segment-add' })}>Add to segment…</button>
            <button type="button" className="btn btn-sm" disabled={busy || !segments?.segments.length} onClick={() => setChoice({ kind: 'segment-remove' })}>Remove from segment…</button>
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setChoice({ kind: 'group' })}>Group…</button>
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setChoice({ kind: 'country' })}>Country…</button>
            <button type="button" className="btn btn-sm" disabled={busy}
              onClick={() => ask('activate', { title: `Activate ${which}?`, message: `They're offered again when building campaigns.${cspNote('may change this back')}`, confirmLabel: 'Activate' })}>Activate</button>
            <button type="button" className="btn btn-sm" disabled={busy}
              onClick={() => ask('deactivate', { title: `Deactivate ${which}?`, message: `They're hidden when building campaigns; their customers stay.${cspNote('may change this back')}`, confirmLabel: 'Deactivate' })}>Deactivate</button>
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setChoice({ kind: 'merge' })}>Merge into…</button>
            <button type="button" className="btn btn-sm btn-danger" disabled={busy}
              onClick={() => ask('delete', {
                title: `Delete ${which}?`, danger: true, confirmLabel: `Delete ${which}`,
                message: `Their ${plural(pickedStores.reduce((a, s) => a + (s.customerCount || 0), 0), 'customer')} stay on the list without a store, and can't be emailed until it's added back. To move them to another store, use Merge instead.${cspNote('adds them back')}`,
              }, {}, (r) => `Deleted ${plural(r.changed, 'store')}`)}>Delete</button>
          </SelectionBar>
        </>
      )}
    </main>
  );
}

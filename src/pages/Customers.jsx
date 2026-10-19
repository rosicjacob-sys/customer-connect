import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import api from '../lib/api';
import { n, plural, fmtWhen, fmtDay, downloadBlob, EMAIL_RE } from '../lib/util';
import { Empty, Loading, Modal, SOURCE_OPTIONS, SourceBadges, useConfirm, useToast } from '../components/ui';

const PAGE_SIZE = 50;
const SOURCE_NAME = { checkout: 'order', chat: 'chat', upload: 'upload', manual: 'added by hand' };

const CSV_COLUMNS = [
  ['email', 'Required'],
  ['store_url', 'Required. The store they bought from, e.g. ottawapeptides.com'],
  ['customer_name', 'Optional'],
  ['store_name', "Optional. Used if the store isn't set up yet"],
  ['phone', 'Optional, any format'],
  ['last_order_date', 'Optional, YYYY-MM-DD. Decides their latest store. Without it a row can add a new customer but never moves an existing one.'],
];

function csvOf(rows) {
  const cell = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return ['line,email,store_url,reason', ...rows.map((r) => [r.line, r.email, r.store, r.reason].map(cell).join(','))].join('\n');
}

// Upload a customer file: check it (nothing is saved), add any stores it
// names that aren't set up, then import.
function ImportModal({ onClose, onImported, groups }) {
  const toast = useToast();
  const [file, setFile] = useState(null);
  const [report, setReport] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [group, setGroup] = useState('');

  const run = async (apply) => {
    setBusy(apply ? 'import' : 'check');
    setError('');
    try {
      const res = await api.importCustomers(file, apply);
      setReport(res);
      if (apply) { setDone(true); onImported(); }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  };

  const addStores = async () => {
    setBusy('stores');
    try {
      const g = groups.find((x) => x.key === group);
      const res = await api.addStores(report.unknownStores.map((u) => ({ domain: u.domain, brandName: u.storeName || u.domain })),
        g ? { storeGroup: g.key, storeGroupName: g.name } : {});
      toast(`Added ${plural(res.added.length, 'store')}. Set their colour, country and sender on the Stores page.`);
      await run(false);
    } catch (err) {
      setError(err.message);
      setBusy('');
    }
  };

  const template = async () => {
    try { downloadBlob(await api.csvTemplate(), 'customer-connect-template.csv'); } catch (err) { setError(err.message); }
  };

  const r = report;
  const droppedTotal = r ? Object.values(r.dropped).reduce((a, b) => a + b, 0) : 0;
  return (
    <Modal title="Import customers" wide onClose={onClose} busy={!!busy} footer={<>
      <button type="button" className="btn" onClick={onClose} disabled={!!busy}>{done ? 'Close' : 'Cancel'}</button>
      {!done && !r && <button type="button" className="btn btn-primary" disabled={!file || !!busy} onClick={() => run(false)}>{busy ? 'Checking…' : 'Check file'}</button>}
      {!done && r && <button type="button" className="btn btn-primary" disabled={!!busy || !r.saved} onClick={() => run(true)}>{busy === 'import' ? 'Importing…' : `Import ${n(r.saved)} customers`}</button>}
    </>}>
      <div className="stack">
        <div className="card" style={{ background: 'var(--surface-2)' }}>
          <div className="row" style={{ marginBottom: 8 }}>
            <div className="label grow">File format: CSV or Excel, first row = these column names</div>
            <button type="button" className="btn btn-sm" onClick={template}>⬇ Download template</button>
          </div>
          <table className="table" style={{ background: 'transparent' }}><tbody>
            {CSV_COLUMNS.map(([c, d]) => <tr key={c}><td className="mono nowrap" style={{ width: 150 }}>{c}</td><td className="light">{d}</td></tr>)}
          </tbody></table>
          <div className="hint" style={{ marginTop: 8 }}>
            Every row is cleaned first: typos like gmail.con are fixed; test emails, made-up domains, and myshopify.com or checkout-portal
            store addresses are left out. One customer per email: if the file has someone at two stores, the latest order wins.
          </div>
        </div>

        <input type="file" accept=".csv,.xlsx,.xls" disabled={!!busy || done} aria-label="Customer file"
          onChange={(e) => { setFile(e.target.files?.[0] || null); setReport(null); setError(''); }} />

        {r && (
          <div className="card stack" style={{ gap: 8 }} role="status">
            <div><strong>{n(r.rows)}</strong> rows in the file{r.undated ? `, ${n(r.undated)} without a last_order_date` : ''}</div>
            {done
              ? <div style={{ fontSize: 15, color: 'var(--success-text)' }}>✓ Saved <strong>{n(r.saved)}</strong> customers: {n(r.added)} new, {n(r.updated)} already on the list{r.storeChanged ? `, ${n(r.storeChanged)} moved to a newer store` : ''}</div>
              : <div style={{ fontSize: 15 }}><strong>{n(r.saved)}</strong> customers will be saved: {n(r.added)} new, {n(r.updated)} already on the list{r.storeChanged ? ` (${n(r.storeChanged)} move to a newer store)` : ''}</div>}
            {r.unverified > 0 && <div className="warn">{n(r.unverified)} have an email domain that couldn't be checked right now. They're saved but left out of campaigns until it's confirmed (checked again every hour).</div>}
            {Object.keys(r.fixes).length > 0 && (
              <div className="light">Fixed: {Object.entries(r.fixes).map(([k, v]) => `${n(v)} × ${k}`).join(' · ')}</div>
            )}
            {droppedTotal > 0 && (
              <div>
                <strong>{n(droppedTotal)}</strong> rows not saved
                <ul style={{ margin: '2px 0 0', paddingLeft: 18 }}>{Object.entries(r.dropped).map(([k, v]) => <li key={k}>{n(v)} {k}</li>)}</ul>
                <button type="button" className="btn btn-sm" style={{ marginTop: 6 }}
                  onClick={() => downloadBlob(new Blob([csvOf(r.rejected)], { type: 'text/csv' }), 'rows-not-saved.csv')}>
                  ⬇ Download rows not saved
                </button>
              </div>
            )}
            {r.unknownStores.length > 0 && !done && (
              <div className="card" style={{ background: 'var(--warning-soft)', borderColor: 'var(--warning-border)' }}>
                <div style={{ fontWeight: 700, marginBottom: 6 }}>{r.unknownStores.length === 1 ? "1 store in this file isn't set up yet" : `${n(r.unknownStores.length)} stores in this file aren't set up yet`}</div>
                <div className="light" style={{ marginBottom: 8 }}>Their rows are left out until the store exists, so every customer has a sender, group, country and colour.</div>
                <ul style={{ margin: '0 0 10px', paddingLeft: 18, maxHeight: 140, overflowY: 'auto' }}>
                  {r.unknownStores.map((u) => <li key={u.domain}><strong>{u.storeName || u.domain}</strong> <span className="hint">{u.domain} · {n(u.count)} rows</span></li>)}
                </ul>
                <div className="row">
                  <select className="select input-sm" style={{ width: 'auto' }} value={group} onChange={(e) => setGroup(e.target.value)} aria-label="Group for the new stores">
                    <option value="">No group</option>
                    {groups.map((g) => <option key={g.key} value={g.key}>Group: {g.name}</option>)}
                  </select>
                  <button type="button" className="btn btn-primary btn-sm" disabled={!!busy} onClick={addStores}>
                    {busy === 'stores' ? 'Adding…' : r.unknownStores.length === 1 ? 'Add this store' : `Add these ${n(r.unknownStores.length)} stores`}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
        {error && <div className="error">{error}</div>}
      </div>
    </Modal>
  );
}

function CustomerModal({ customer, stores, onClose, onSaved }) {
  const [email, setEmail] = useState(customer?.email || '');
  const [name, setName] = useState(customer?.name || '');
  const [phone, setPhone] = useState(customer?.phone || '');
  const [storeId, setStoreId] = useState(customer?.store_id ? String(customer.store_id) : '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const moving = customer && storeId && Number(storeId) !== customer.store_id;
  const save = async () => {
    if (!EMAIL_RE.test(email.trim())) return setError('Enter a valid email.');
    if (!storeId) return setError('Pick the store this customer belongs to.');
    setSaving(true);
    setError('');
    try {
      onSaved(customer
        ? await api.updateCustomer(customer.id, { email: email.trim(), name, phone, storeId: Number(storeId) })
        : await api.addCustomer({ email: email.trim(), name, phone, storeId: Number(storeId) }));
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  };
  return (
    <Modal title={customer ? 'Edit customer' : 'Add a customer'} onClose={onClose} busy={saving} footer={<>
      <button type="button" className="btn" onClick={onClose} disabled={saving}>Cancel</button>
      <button type="button" className="btn btn-primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
    </>}>
      <div className="stack">
        <label className="field"><span>Email</span><input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus /></label>
        <div className="row">
          <label className="field"><span>Name</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Optional" /></label>
          <label className="field"><span>Phone</span><input className="input" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Optional" /></label>
        </div>
        <label className="field"><span>Store</span>
          <select className="select" value={storeId} onChange={(e) => setStoreId(e.target.value)}>
            <option value="">Choose…</option>
            {stores.map((s) => <option key={s.id} value={s.id}>{s.brandName} ({s.domain})</option>)}
          </select>
        </label>
        <div className="hint">
          {customer
            ? (moving ? 'Saving moves them to this store now; their old store stays in their history.' : 'A name typed here is kept even if a later import or sync has another.')
            : 'If this email is already a customer, they move to this store (it counts as their latest).'}
        </div>
        {error && <div className="error">{error}</div>}
      </div>
    </Modal>
  );
}

function HistoryModal({ customer, onClose }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => { api.customerHistory(customer.id).then(setRows).catch((e) => setError(e.message)); }, [customer.id]);
  return (
    <Modal title={`${customer.email}: stores`} onClose={onClose}>
      {error ? <div className="error">{error}</div> : !rows ? <Loading /> : (
        <div className="stack">
          <div className="hint">They get campaigns as their latest store. Every store they've been linked to is kept here.</div>
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Store</th><th>Last seen</th><th>From</th></tr></thead>
            <tbody>{rows.map((h) => (
              <tr key={h.store_domain}>
                <td><strong>{h.store_name}</strong>{h.current && <span className="badge badge-running" style={{ marginLeft: 6 }}>current</span>}
                  <div className="hint">{h.store_domain}{h.store_id ? '' : ' · not set up'}</div></td>
                <td className="light nowrap">{h.last_seen_at ? fmtDay(h.last_seen_at) : 'no date'}</td>
                <td className="light">{(h.sources || []).map((x) => SOURCE_NAME[x] || x).join(', ')}</td>
              </tr>
            ))}</tbody>
          </table></div>
        </div>
      )}
    </Modal>
  );
}

function CustomerList({ storeGroup, groups }) {
  const toast = useToast();
  const [confirm, confirmDialog] = useConfirm();
  const [data, setData] = useState(null);
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [sources, setSources] = useState('');
  const [country, setCountry] = useState('');
  const [status, setStatus] = useState('active');
  const [stores, setStores] = useState([]);
  const [editing, setEditing] = useState(null); // null | 'new' | customer
  const [history, setHistory] = useState(null);
  const [importing, setImporting] = useState(false);
  const debounce = useRef(null);

  useEffect(() => { api.stores(storeGroup).then(setStores).catch(() => {}); }, [storeGroup]);
  const filters = useMemo(() => ({ storeGroup, search: query, sources, country, status }), [storeGroup, query, sources, country, status]);
  const load = useCallback(async (p = 0) => {
    try {
      setData(await api.customers({ ...filters, limit: PAGE_SIZE, offset: p * PAGE_SIZE }));
      setPage(p);
    } catch (err) { toast(err.message, { bad: true }); }
  }, [filters, toast]);
  useEffect(() => { load(0); }, [load]);
  useEffect(() => () => clearTimeout(debounce.current), []);

  const onSearch = (v) => { setSearch(v); clearTimeout(debounce.current); debounce.current = setTimeout(() => setQuery(v.trim()), 300); };

  const act = async (c, action) => {
    try {
      if (action === 'delete') {
        if (!(await confirm({ title: `Remove ${c.email}?`, message: "They come off the list. A later import, sync or order can add them back; to make sure they're never emailed, unsubscribe them instead.", confirmLabel: 'Remove', danger: true }))) return;
        await api.deleteCustomer(c.id);
        toast(`${c.email} removed`);
      } else if (action === 'unsubscribe') {
        if (!(await confirm({ title: `Unsubscribe ${c.email}?`, message: 'They get no more campaigns from any store. You can undo this under Do not email.', confirmLabel: 'Unsubscribe' }))) return;
        await api.addUnsubscribe(c.email);
        toast(`${c.email} unsubscribed`);
      } else if (action === 'archive') {
        await api.archiveCustomer(c.id);
        toast(`${c.email} archived: left out of campaigns`);
      } else {
        await api.restoreCustomer(c.id);
        toast(`${c.email} restored`);
      }
      load(page);
    } catch (err) { toast(err.message, { bad: true }); }
  };

  const exportCsv = async () => {
    try { downloadBlob(await api.exportCustomers(filters), `customers-${new Date().toISOString().slice(0, 10)}.csv`); }
    catch (err) { toast(err.message, { bad: true }); }
  };

  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;
  return (
    <>
      {confirmDialog}
      {importing && <ImportModal groups={groups} onClose={() => setImporting(false)} onImported={() => load(0)} />}
      {history && <HistoryModal customer={history} onClose={() => setHistory(null)} />}
      {editing && <CustomerModal customer={editing === 'new' ? null : editing} stores={stores} onClose={() => setEditing(null)}
        onSaved={(c) => { setEditing(null); toast(c?.existed ? `${c.email} was already a customer: moved to this store` : 'Saved'); load(page); }} />}
      <div className="row" style={{ marginBottom: 12 }}>
        <input className="input grow" placeholder="Search name, email, phone or store…" value={search} onChange={(e) => onSearch(e.target.value)} />
        <select className="select input-sm" style={{ width: 'auto' }} value={sources} onChange={(e) => setSources(e.target.value)} aria-label="Source">
          {SOURCE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <select className="select input-sm" style={{ width: 'auto' }} value={country} onChange={(e) => setCountry(e.target.value)} aria-label="Country">
          <option value="">All countries</option><option value="CA">🇨🇦 Canada</option><option value="US">🇺🇸 USA</option>
        </select>
        <select className="select input-sm" style={{ width: 'auto' }} value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
          <option value="active">Active</option><option value="archived">Archived</option><option value="unverified">Unverified email</option>
          <option value="no_store">Store not set up</option><option value="all">Everyone</option>
        </select>
      </div>
      <div className="row" style={{ marginBottom: 12 }}>
        <span className="light">{data ? `${n(data.total)} customers` : 'Loading…'}
          {data && <> · 🇨🇦 {n(data.countsByCountry.CA)} · 🇺🇸 {n(data.countsByCountry.US)}{data.countsByCountry.unset ? ` · ${n(data.countsByCountry.unset)} no country` : ''}</>}</span>
        <span className="spacer" />
        <button type="button" className="btn btn-sm" onClick={exportCsv}>Export CSV</button>
        <button type="button" className="btn btn-sm" onClick={() => setEditing('new')}>+ Add customer</button>
        <button type="button" className="btn btn-sm btn-primary" onClick={() => setImporting(true)}>Import file</button>
      </div>
      {!data ? <Loading /> : data.rows.length === 0 ? (
        <Empty icon="📇" title={query ? 'No matches' : 'No customers here'}>
          {query ? `Nothing matches "${query}".` : 'Import a customer file, add customers by hand, or link Chat Support Pro and the checkout portal under Settings.'}
        </Empty>
      ) : (
        <>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Customer</th><th>Store</th><th className="hide-sm">Last order or chat</th><th /></tr></thead>
              <tbody>
                {data.rows.map((c) => (
                  <tr key={c.id} style={c.status ? { opacity: 0.6 } : undefined}>
                    <td style={{ minWidth: 220 }}>
                      <div className="row" style={{ gap: 6 }}><strong>{c.email}</strong><SourceBadges customer={c} />{c.status && <span className="badge">archived</span>}
                        {c.opted_out && <span className="badge badge-cancelled" title="Never emailed: see Do not email">{c.opted_out}</span>}</div>
                      <div className="hint">{[c.name, c.phone].filter(Boolean).join(' · ')}</div>
                    </td>
                    <td>
                      <div>{c.store_name}</div>
                      <div className="hint">
                        {c.store_id ? c.store_domain : `${c.store_domain} · store not set up`}
                        {c.store_count > 1 && <> · <button type="button" className="btn-ghost" style={{ border: 0, background: 'none', padding: 0, color: 'var(--primary-text)', cursor: 'pointer', fontSize: 12 }}
                          onClick={() => setHistory(c)}>{n(c.store_count)} stores</button></>}
                      </div>
                    </td>
                    <td className="hide-sm light nowrap">{c.last_seen_at ? <>{fmtDay(c.last_seen_at)}<div className="hint">{SOURCE_NAME[c.last_source] || ''}</div></> : '—'}</td>
                    <td className="nowrap" style={{ textAlign: 'right' }}>
                      <button type="button" className="icon-btn" title="Edit" aria-label={`Edit ${c.email}`} onClick={() => setEditing(c)}>✎</button>{' '}
                      {c.status
                        ? <button type="button" className="btn btn-sm" onClick={() => act(c, 'restore')}>Restore</button>
                        : <button type="button" className="btn btn-sm" title="Leave out of campaigns" onClick={() => act(c, 'archive')}>Archive</button>}{' '}
                      <button type="button" className="btn btn-sm" onClick={() => act(c, 'unsubscribe')}>Unsubscribe</button>{' '}
                      <button type="button" className="icon-btn danger" title="Remove" aria-label={`Remove ${c.email}`} onClick={() => act(c, 'delete')}>🗑</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {pages > 1 && (
            <div className="pager">
              <button type="button" className="btn btn-sm" disabled={page <= 0} onClick={() => load(page - 1)}>← Prev</button>
              <span>Page {page + 1} of {n(pages)}</span>
              <button type="button" className="btn btn-sm" disabled={page >= pages - 1} onClick={() => load(page + 1)}>Next →</button>
            </div>
          )}
        </>
      )}
    </>
  );
}

function SentHistory({ storeGroup }) {
  const toast = useToast();
  const [rows, setRows] = useState(null);
  const [search, setSearch] = useState('');
  const [checked, setChecked] = useState(new Set());
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api.sent({ storeGroup }).then((r) => { setRows(r); setChecked(new Set()); }).catch((e) => toast(e.message, { bad: true })), [storeGroup, toast]);
  useEffect(() => { load(); }, [load]);
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return !rows ? [] : q ? rows.filter((r) => r.email.includes(q) || (r.store_name || '').toLowerCase().includes(q) || r.store_domain.includes(q)) : rows;
  }, [rows, search]);
  const allChecked = shown.length > 0 && shown.every((r) => checked.has(r.id));
  const reset = async () => {
    setBusy(true);
    try {
      const { reset: count } = await api.resetSent([...checked]);
      toast(`Reset ${n(count)}: they can be included again`);
      load();
    } catch (err) { toast(err.message, { bad: true }); } finally { setBusy(false); }
  };
  return (
    <>
      <div className="page-sub" style={{ margin: '0 0 12px' }}>
        Who each store has emailed. Campaigns with "Leave out people this store has already emailed" skip them; resetting a row makes them eligible again.
      </div>
      <div className="row" style={{ marginBottom: 12 }}>
        <input className="input grow" placeholder="Search email or store…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <button type="button" className="btn btn-primary btn-sm" disabled={busy || !checked.size} onClick={reset}>↺ Reset {checked.size || ''} selected</button>
      </div>
      {!rows ? <Loading /> : rows.length === 0 ? <Empty icon="📭" title="Nothing sent yet" /> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr>
              <th style={{ width: 32 }}><input type="checkbox" aria-label="Select all" checked={allChecked}
                onChange={() => setChecked(allChecked ? new Set() : new Set(shown.map((r) => r.id)))} /></th>
              <th>Email</th><th>Store</th><th className="hide-sm">Campaign</th><th>Sent</th>
            </tr></thead>
            <tbody>
              {shown.slice(0, 1000).map((r) => (
                <tr key={r.id}>
                  <td><input type="checkbox" checked={checked.has(r.id)} aria-label={`Select ${r.email}`}
                    onChange={() => setChecked((p) => { const s = new Set(p); s.has(r.id) ? s.delete(r.id) : s.add(r.id); return s; })} /></td>
                  <td><strong>{r.email}</strong></td>
                  <td>{r.store_name || r.store_domain}<div className="hint">{r.store_domain}</div></td>
                  <td className="hide-sm light">{r.campaign_name || '—'}</td>
                  <td className="light nowrap">{fmtWhen(r.sent_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {shown.length > 1000 && <div className="hint" style={{ marginTop: 8 }}>Showing 1,000 of {n(shown.length)}. Search to narrow it down.</div>}
    </>
  );
}

const SOURCE_LABEL = { link: 'unsubscribe link', one_click: 'one-click (mail app)', manual: 'added by hand', chat_support: 'from Chat Support Pro' };

function DoNotEmail() {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [search, setSearch] = useState('');
  const [email, setEmail] = useState('');
  const [kind, setKind] = useState('unsubscribe');
  const [storeDomain, setStoreDomain] = useState('');
  const [reason, setReason] = useState('');
  const load = useCallback(() => api.optOuts(search.trim() || undefined).then(setData).catch((e) => toast(e.message, { bad: true })), [search, toast]);
  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); }, [load]);

  const add = async (e) => {
    e.preventDefault();
    try {
      if (kind === 'unsubscribe') await api.addUnsubscribe(email.trim());
      else await api.addBlock({ email: email.trim(), storeDomain: storeDomain.trim() || null, reason: reason.trim() || null });
      setEmail(''); setReason('');
      toast('Added');
      load();
    } catch (err) { toast(err.message, { bad: true }); }
  };
  const remove = async (fn, label) => {
    try { await fn(); toast(`${label} removed`); load(); } catch (err) { toast(err.message, { bad: true }); }
  };

  return (
    <div className="stack">
      <div className="page-sub" style={{ margin: 0 }}>
        Checked before every batch: these people are never emailed by any store, even if they're in a campaign that's already running or move to another store.
        People who bounced or complained before are also skipped automatically (Resend's suppression list).
      </div>
      <form className="card row" onSubmit={add}>
        <input className="input grow" type="email" placeholder="email@example.com" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <select className="select" style={{ width: 'auto' }} value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Kind">
          <option value="unsubscribe">Unsubscribe</option>
          <option value="block">Block</option>
        </select>
        {kind === 'block' && <>
          <input className="input" style={{ width: 200 }} placeholder="Where it came from (optional)" value={storeDomain} onChange={(e) => setStoreDomain(e.target.value)} />
          <input className="input" style={{ width: 180 }} placeholder="Reason (optional)" value={reason} onChange={(e) => setReason(e.target.value)} />
        </>}
        <button type="submit" className="btn btn-primary">Add</button>
      </form>
      <input className="input" placeholder="Search…" value={search} onChange={(e) => setSearch(e.target.value)} />
      {!data ? <Loading /> : (
        <div className="row" style={{ alignItems: 'flex-start' }}>
          <div className="grow" style={{ minWidth: 280 }}>
            <div className="card-title">Unsubscribed ({n(data.unsubscribes.length)})</div>
            <div className="table-wrap"><table className="table"><tbody>
              {data.unsubscribes.length === 0 && <tr><td className="muted">Nobody.</td></tr>}
              {data.unsubscribes.map((u) => (
                <tr key={u.id}>
                  <td><strong>{u.email}</strong><div className="hint">{SOURCE_LABEL[u.source] || u.source} · {fmtWhen(u.created_at)}</div></td>
                  <td style={{ textAlign: 'right' }}><button type="button" className="btn btn-sm" title="Only if they asked to be emailed again"
                    onClick={() => remove(() => api.removeUnsubscribe(u.id), u.email)}>Remove</button></td>
                </tr>
              ))}
            </tbody></table></div>
          </div>
          <div className="grow" style={{ minWidth: 280 }}>
            <div className="card-title">Blocked ({n(data.blocks.length)})</div>
            <div className="table-wrap"><table className="table"><tbody>
              {data.blocks.length === 0 && <tr><td className="muted">Nobody.</td></tr>}
              {data.blocks.map((b) => (
                <tr key={b.id}>
                  <td><strong>{b.email}</strong><div className="hint">{b.store_domain ? `blocked at ${b.store_domain}, applies everywhere` : 'every store'}{b.reason ? ` · ${b.reason}` : ''}</div></td>
                  <td style={{ textAlign: 'right' }}><button type="button" className="btn btn-sm" onClick={() => remove(() => api.removeBlock(b.id), b.email)}>Remove</button></td>
                </tr>
              ))}
            </tbody></table></div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function Customers({ storeGroup, groups }) {
  const [tab, setTab] = useState('list');
  return (
    <main className="page">
      <div className="page-head"><h1>Customers</h1></div>
      <div className="tabs" role="tablist">
        {[['list', 'Customers'], ['sent', 'Sent history'], ['optouts', 'Do not email']].map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>{label}</button>
        ))}
      </div>
      {tab === 'list' && <CustomerList storeGroup={storeGroup} groups={groups} />}
      {tab === 'sent' && <SentHistory storeGroup={storeGroup} />}
      {tab === 'optouts' && <DoNotEmail />}
    </main>
  );
}

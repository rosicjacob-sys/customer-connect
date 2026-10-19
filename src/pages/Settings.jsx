import React, { useCallback, useEffect, useState } from 'react';
import api from '../lib/api';
import { fmtWhen, n } from '../lib/util';
import { Loading, Modal, useToast } from '../components/ui';

function Outbox() {
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(null);
  const load = useCallback(() => api.outbox().then(setData).catch(() => {}), []);
  useEffect(() => { load(); }, [load]);
  if (!data?.dryRun) return null;
  return (
    <section className="card">
      {open && (
        <Modal title={open.subject} wide onClose={() => setOpen(null)}>
          <div className="hint" style={{ marginBottom: 8 }}>From {open.from} · to {open.to.join(', ')}{open.reply_to ? ` · reply-to ${open.reply_to}` : ''}</div>
          <div style={{ margin: '0 -20px' }}><iframe title="Message" className="preview-frame" sandbox="" srcDoc={open.html} /></div>
          <div className="hint mono" style={{ marginTop: 8, wordBreak: 'break-all' }}>List-Unsubscribe: {open.headers?.['List-Unsubscribe']}</div>
        </Modal>
      )}
      <div className="row"><div className="card-title grow" style={{ margin: 0 }}>Outbox (dry run)</div><button type="button" className="btn btn-sm" onClick={load}>Refresh</button></div>
      <div className="hint" style={{ margin: '4px 0 10px' }}>The last 100 emails built while dry run is on, exactly as they would have gone out. Cleared when the server restarts.</div>
      {data.messages.length === 0 ? <div className="muted">Nothing yet. Send a test or a campaign.</div> : (
        <div className="table-wrap"><table className="table">
          <thead><tr><th>To</th><th>Subject</th><th className="hide-sm">From</th><th className="hide-sm">When</th></tr></thead>
          <tbody>{data.messages.map((m) => (
            <tr key={m.id} style={{ cursor: 'pointer' }} onClick={() => setOpen(m)}>
              <td>{m.to.join(', ')}<div className="hint">{m.label}</div></td>
              <td className="ellipsis" style={{ maxWidth: 280 }}>{m.subject}</td>
              <td className="hide-sm light">{m.from}</td>
              <td className="hide-sm light nowrap">{fmtWhen(m.at)}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
    </section>
  );
}

function ChatSupportSync({ status, refreshStatus, refreshGroups }) {
  const toast = useToast();
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const cs = status?.chatSupport;
  const last = cs?.lastSync;
  const sync = async (full) => {
    setBusy(full ? 'full' : 'quick');
    setError('');
    try {
      const r = await api.syncChatSupport(full);
      toast(`Synced: ${n(r.customers.saved)} customers saved (${n(r.customers.added)} new, ${n(r.customers.storeChanged)} moved store)`);
      refreshStatus();
      refreshGroups();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  };
  return (
    <section className="card">
      <div className="card-title">Chat Support Pro</div>
      {!cs?.configured ? (
        <div className="light">
          Not linked. Set <span className="mono">CHAT_SUPPORT_DATABASE_URL</span> to Chat Support Pro's database (a read-only user is best) and restart.
          Its stores, customers (with the time of their last chat), unsubscribes and blacklist are then copied here automatically.
        </div>
      ) : (
        <div className="stack">
          <div className="light">
            Linked, read only. {cs.syncMinutes > 0 ? `New and changed customers are copied every ${cs.syncMinutes} minutes` : 'Automatic sync is off (CHAT_SUPPORT_SYNC_MINUTES=0)'}, each linked to the store
            of their latest chat. Unsubscribes and blacklisting there are also checked before every batch.
          </div>
          {last && (
            <div className="hint">
              Last sync {fmtWhen(last.at)}{last.full ? ' (everything)' : ' (changes only)'}: {n(last.customers.saved)} customers saved
              ({n(last.customers.added)} new, {n(last.customers.storeChanged)} moved store, {n(last.customers.notSaved)} not saved by the cleaning rules)
              · {n(last.stores.added)} stores added, {n(last.stores.updated)} updated · {n(last.optOuts.unsubscribes)} new unsubscribes · {n(last.optOuts.blocks)} new blocks
              {last.stores.conflicts?.length ? ` · skipped (domain taken): ${last.stores.conflicts.join(', ')}` : ''}
            </div>
          )}
          {error && <div className="error">{error}</div>}
          <div className="row">
            <button type="button" className="btn btn-primary" onClick={() => sync(false)} disabled={!!busy}>{busy === 'quick' ? 'Syncing…' : 'Sync now'}</button>
            <button type="button" className="btn" onClick={() => sync(true)} disabled={!!busy} title="Reads everything again, not just what changed">
              {busy === 'full' ? 'Syncing everything… (large lists take a few minutes)' : 'Full re-sync'}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function CheckoutPortal({ status }) {
  const cp = status?.checkoutPortal;
  const st = cp?.stats;
  return (
    <section className="card">
      <div className="card-title">Checkout portal</div>
      {!cp?.configured ? (
        <div className="light stack" style={{ gap: 6 }}>
          <div>Not linked. To receive every paid order's customer automatically:</div>
          <ol style={{ margin: 0, paddingLeft: 18 }}>
            <li>Make up a long random secret (e.g. <span className="mono">openssl rand -hex 32</span>).</li>
            <li>Here: set <span className="mono">CHECKOUT_PORTAL_SECRET</span> to it and restart.</li>
            <li>On the portal: set <span className="mono">CUSTOMER_CONNECT_URL={status?.appUrl}</span> and <span className="mono">CUSTOMER_CONNECT_SECRET</span> to the same secret, deploy the update, and run the backfill once for past orders.</li>
          </ol>
        </div>
      ) : (
        <div className="stack" style={{ gap: 6 }}>
          <div className="light">Linked. Each paid order's customer arrives within a minute, linked to the store they ordered from.</div>
          <div className="hint mono">{cp.endpoint}</div>
          {st ? (
            <div className="hint">
              Last order received {fmtWhen(st.lastAt)} · {n(st.orders)} orders received in total · {n(st.saved)} saved · {n(st.notSaved)} not saved by the cleaning rules
              {st.lastNotSaved?.length > 0 && <> (latest: {st.lastNotSaved.slice(0, 3).map((x) => `${x.order}: ${x.reason}`).join('; ')})</>}
            </div>
          ) : <div className="hint">Nothing received yet.</div>}
        </div>
      )}
    </section>
  );
}

function UserModal({ user, onClose, onSaved }) {
  const [form, setForm] = useState({ name: user?.name || '', email: user?.email || '', role: user?.role || 'editor', password: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const save = async () => {
    setSaving(true);
    setError('');
    try {
      onSaved(user
        ? await api.updateUser(user.id, { name: form.name, role: form.role, password: form.password || undefined })
        : await api.addUser(form));
    } catch (err) { setError(err.message); setSaving(false); }
  };
  return (
    <Modal title={user ? `Edit ${user.name}` : 'Add a user'} onClose={onClose} busy={saving} footer={<>
      <button type="button" className="btn" onClick={onClose} disabled={saving}>Cancel</button>
      <button type="button" className="btn btn-primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
    </>}>
      <div className="stack">
        <label className="field"><span>Name</span><input className="input" value={form.name} onChange={set('name')} autoFocus /></label>
        {!user && <label className="field"><span>Email</span><input className="input" type="email" value={form.email} onChange={set('email')} /></label>}
        <label className="field"><span>Role</span>
          <select className="select" value={form.role} onChange={set('role')}>
            <option value="editor">Editor: campaigns, customers, templates, stores</option>
            <option value="admin">Admin: all of that, plus users and the Chat Support Pro sync</option>
          </select>
        </label>
        <label className="field"><span>{user ? 'New password (leave blank to keep)' : 'Password'}</span>
          <input className="input" type="password" autoComplete="new-password" value={form.password} onChange={set('password')} placeholder="At least 8 characters" />
        </label>
        {error && <div className="error">{error}</div>}
      </div>
    </Modal>
  );
}

function Users({ me }) {
  const toast = useToast();
  const [users, setUsers] = useState(null);
  const [editing, setEditing] = useState(null);
  const load = useCallback(() => api.users().then(setUsers).catch((e) => toast(e.message, { bad: true })), [toast]);
  useEffect(() => { load(); }, [load]);
  const toggle = async (u) => {
    try { await api.updateUser(u.id, { isActive: !u.isActive }); toast(`${u.name} ${u.isActive ? 'deactivated' : 'reactivated'}`); load(); }
    catch (err) { toast(err.message, { bad: true }); }
  };
  return (
    <section className="card">
      {editing && <UserModal user={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); toast('Saved'); load(); }} />}
      <div className="row" style={{ marginBottom: 10 }}><div className="card-title grow" style={{ margin: 0 }}>Users</div>
        <button type="button" className="btn btn-sm btn-primary" onClick={() => setEditing('new')}>+ Add user</button></div>
      {!users ? <Loading /> : (
        <div className="table-wrap"><table className="table">
          <thead><tr><th>Name</th><th>Role</th><th className="hide-sm">Last sign-in</th><th /></tr></thead>
          <tbody>{users.map((u) => (
            <tr key={u.id} style={u.isActive ? undefined : { opacity: 0.55 }}>
              <td><strong>{u.name}</strong>{!u.isActive && <span className="badge" style={{ marginLeft: 6 }}>inactive</span>}<div className="hint">{u.email}</div></td>
              <td>{u.role}</td>
              <td className="hide-sm light">{fmtWhen(u.lastLoginAt)}</td>
              <td className="nowrap" style={{ textAlign: 'right' }}>
                <button type="button" className="btn btn-sm" onClick={() => setEditing(u)}>Edit</button>{' '}
                {u.id !== me.id && <button type="button" className="btn btn-sm" onClick={() => toggle(u)}>{u.isActive ? 'Deactivate' : 'Reactivate'}</button>}
              </td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
    </section>
  );
}

function ChangePassword() {
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [error, setError] = useState('');
  const submit = async (e) => {
    e.preventDefault();
    setError('');
    try { await api.changePassword(current, next); setCurrent(''); setNext(''); toast('Password changed'); }
    catch (err) { setError(err.message); }
  };
  return (
    <form className="card stack" onSubmit={submit}>
      <div className="card-title" style={{ margin: 0 }}>Your password</div>
      <div className="row">
        <label className="field"><span>Current password</span><input className="input" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required /></label>
        <label className="field"><span>New password</span><input className="input" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} minLength={8} required /></label>
      </div>
      {error && <div className="error">{error}</div>}
      <div><button type="submit" className="btn">Change password</button></div>
    </form>
  );
}

export default function Settings({ user, status, refreshStatus, refreshGroups }) {
  return (
    <main className="page page-narrow">
      <div className="page-head"><h1>Settings</h1></div>
      <div className="stack">
        <section className="card">
          <div className="card-title">Sending</div>
          {!status ? <Loading /> : (
            <div className="stack" style={{ gap: 6 }}>
              <div>Mode: <strong>{status.emailMode === 'live' ? 'Live, through Resend' : 'Dry run (nothing is sent)'}</strong></div>
              <div className="light">Default sender: {status.defaultFromName} &lt;{status.defaultFromEmail}&gt;, used for stores without their own address.</div>
              <div className="light">Unsubscribe links point to <span className="mono">{status.appUrl}/u</span>. Pace: one email every {status.sendDelayMs} ms.</div>
              <div className="light">New emails' domains {status.emailDomainCheck ? 'are checked for mail servers before saving' : 'are not checked (EMAIL_DOMAIN_CHECK=off)'}.</div>
              <div className="hint">These come from the server's environment settings (see .env.example).</div>
            </div>
          )}
        </section>
        <Outbox />
        {user.role === 'admin' && <ChatSupportSync status={status} refreshStatus={refreshStatus} refreshGroups={refreshGroups} />}
        <CheckoutPortal status={status} />
        {user.role === 'admin' && <Users me={user} />}
        <ChangePassword />
      </div>
    </main>
  );
}

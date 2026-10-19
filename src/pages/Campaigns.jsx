import React, { useCallback, useEffect, useState } from 'react';
import api from '../lib/api';
import { fmtWhen, fmtSpan, fmtInterval, n, TIMEZONES } from '../lib/util';
import { Empty, Loading, Modal, PaceHint, StatusBadge, useConfirm, useToast } from '../components/ui';
import { PreviewModal } from '../components/email';

const TERMINAL = ['completed', 'cancelled'];
const SKIP_REASONS = {
  unsubscribed: 'unsubscribed',
  blocked: 'on the blocklist',
  resend_suppressed: 'bounced or complained before',
  chat_support: 'opted out in Chat Support Pro',
  archived: 'archived after the campaign was made',
};

// When the campaign really ran: first and last email sent.
function timing(c) {
  if (!c.firstSentAt) {
    if (c.status === 'cancelled') return `Stopped ${fmtWhen(c.updatedAt)} before any email went out`;
    if (c.status === 'completed') return `Finished ${fmtWhen(c.updatedAt)} without sending`;
    return c.nextFireAt ? `Starts ${fmtWhen(c.nextFireAt)}` : null;
  }
  const end = c.status === 'completed' ? (c.lastSentAt || c.updatedAt) : c.status === 'cancelled' ? c.updatedAt : null;
  if (end) return `Started ${fmtWhen(c.firstSentAt)} · ${c.status === 'cancelled' ? 'Stopped' : 'Ended'} ${fmtWhen(end)} · ran ${fmtSpan(new Date(end) - new Date(c.firstSentAt))}`;
  return `Started ${fmtWhen(c.firstSentAt)} · ${c.status === 'paused' ? 'paused' : 'running'} for ${fmtSpan(Date.now() - new Date(c.firstSentAt))}`;
}

// A campaign that can still send: anything not stopped, plus a finished one
// with recipients left (moving its end time later picks it back up).
const canEdit = (c) => c.mode === 'scheduled' && c.status !== 'cancelled'
  && (c.status !== 'completed' || c.sentCount + c.failedCount + c.skippedCount < c.totalRecipients);

function EditModal({ campaign: c, onClose, onSaved }) {
  const [form, setForm] = useState({
    name: c.name,
    batchSize: String(c.batchSize),
    intervalValue: String(c.intervalMinutes % 60 === 0 ? c.intervalMinutes / 60 : c.intervalMinutes),
    intervalUnit: c.intervalMinutes % 60 === 0 ? 'hours' : 'minutes',
    nextAt: c.nextFireAtLocal || '',
    endAt: c.endAtLocal || '',
    sendLimit: c.sendLimit != null ? String(c.sendLimit) : '',
    windowStart: c.windowStart || '',
    windowEnd: c.windowEnd || '',
    timezone: c.timezone,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const intervalMinutes = form.intervalUnit === 'hours' ? Number(form.intervalValue) * 60 : Number(form.intervalValue);
  const tzOptions = TIMEZONES.some(([v]) => v === form.timezone) ? TIMEZONES : [[form.timezone, form.timezone], ...TIMEZONES];
  const started = c.sentCount + c.failedCount + c.skippedCount > 0;

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      const changes = {
        name: form.name, batchSize: Number(form.batchSize), intervalMinutes, timezone: form.timezone,
        endAt: form.endAt || null, sendLimit: form.sendLimit === '' ? null : Number(form.sendLimit),
        windowStart: form.windowStart || null, windowEnd: form.windowEnd || null,
      };
      // Only a changed "next send" pins the next batch; otherwise the server
      // works it out from the new settings.
      if (form.nextAt && form.nextAt !== (c.nextFireAtLocal || '')) changes.startAt = form.nextAt;
      onSaved(await api.updateCampaign(c.id, changes));
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  };

  return (
    <Modal title="Edit campaign" onClose={onClose} busy={saving} footer={<>
      <button type="button" className="btn" onClick={onClose} disabled={saving}>Cancel</button>
      <button type="button" className="btn btn-primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save changes'}</button>
    </>}>
      <div className="stack">
        <div className="hint">{n(c.sentCount)} of {n(c.totalRecipients)} sent so far. Changes apply from the next batch; nothing already sent goes out again.</div>
        <label className="field"><span>Name</span><input className="input" value={form.name} onChange={set('name')} /></label>
        <div className="row">
          <label className="field"><span>Batch size</span><input className="input" type="number" min="1" value={form.batchSize} onChange={set('batchSize')} /></label>
          <label className="field"><span>Every</span><input className="input" type="number" min="1" value={form.intervalValue} onChange={set('intervalValue')} /></label>
          <label className="field"><span>Unit</span>
            <select className="select" value={form.intervalUnit} onChange={set('intervalUnit')}><option value="minutes">Minutes</option><option value="hours">Hours</option></select>
          </label>
        </div>
        <label className="field"><span>Daily send limit</span>
          <input className="input" type="number" min="1" placeholder="No limit" value={form.sendLimit} onChange={set('sendLimit')} />
          <span className="hint">Most emails per day. Once reached it waits and carries on tomorrow.</span>
        </label>
        <div className="field"><span>Sending hours each day</span>
          <div className="row">
            <input className="input" style={{ flex: 1 }} type="time" value={form.windowStart} onChange={set('windowStart')} aria-label="Send from" />
            <span className="hint">to</span>
            <input className="input" style={{ flex: 1 }} type="time" value={form.windowEnd} onChange={set('windowEnd')} aria-label="Send until" />
          </div>
          <span className="hint">Leave both empty to send at any time of day.</span>
        </div>
        <div className="row">
          <label className="field"><span>{started ? 'Next batch at' : 'Start'}</span><input className="input" type="datetime-local" value={form.nextAt} onChange={set('nextAt')} /></label>
          <label className="field"><span>End (optional)</span><input className="input" type="datetime-local" value={form.endAt} onChange={set('endAt')} /></label>
        </div>
        <label className="field"><span>Timezone</span>
          <select className="select" value={form.timezone} onChange={set('timezone')}>{tzOptions.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          <span className="hint">The times above, the sending hours and the daily limit's midnight are all in this timezone.</span>
        </label>
        <PaceHint batchSize={form.batchSize} intervalMinutes={intervalMinutes} sendLimit={form.sendLimit} windowStart={form.windowStart} windowEnd={form.windowEnd} />
        {error && <div className="error">{error}</div>}
      </div>
    </Modal>
  );
}

function DetailModal({ id, onClose }) {
  const [d, setD] = useState(null);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState(false);
  useEffect(() => { api.campaign(id).then(setD).catch((e) => setError(e.message)); }, [id]);
  return (
    <Modal title={d ? d.name : 'Campaign'} wide onClose={onClose}>
      {error ? <div className="error">{error}</div> : !d ? <Loading /> : (
        <div className="stack">
          {preview && <PreviewModal subject={d.subject} html={d.html} text={d.text} name={d.name} onClose={() => setPreview(false)} />}
          <div className="row">
            <StatusBadge status={d.status} />
            <span className="light ellipsis grow">Subject: {d.subject}</span>
            <button type="button" className="btn btn-sm" onClick={() => setPreview(true)}>Preview email</button>
          </div>
          <div className="row" style={{ gap: 24 }}>
            {[['Sent', d.statusBreakdown.sent], ['Waiting', d.statusBreakdown.pending], ['Skipped', d.statusBreakdown.skipped], ['Failed', d.statusBreakdown.failed]].map(([label, v]) => (
              <div key={label}><div style={{ fontSize: 22, fontWeight: 800 }}>{n(v)}</div><div className="hint">{label}</div></div>
            ))}
          </div>
          {d.lastError && <div className="error">{d.lastError}</div>}
          {d.skipReasons.length > 0 && (
            <div>
              <div className="label">Skipped, never emailed</div>
              <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                {d.skipReasons.map((r) => <li key={r.reason}>{n(r.n)} {SKIP_REASONS[r.reason] || r.reason}</li>)}
              </ul>
            </div>
          )}
          {d.failures.length > 0 && (
            <div>
              <div className="label" style={{ marginBottom: 6 }}>Failed sends{d.failures.length === 100 ? ' (latest 100)' : ''}</div>
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>Email</th><th>Store</th><th>Error</th></tr></thead>
                  <tbody>{d.failures.map((f, i) => <tr key={i}><td>{f.email}</td><td>{f.store_name}</td><td className="light">{f.error}</td></tr>)}</tbody>
                </table>
              </div>
            </div>
          )}
          <div className="hint">Created by {d.createdBy || 'unknown'} on {fmtWhen(d.createdAt)}.</div>
        </div>
      )}
    </Modal>
  );
}

export default function Campaigns({ storeGroup, navigate }) {
  const toast = useToast();
  const [confirm, confirmDialog] = useConfirm();
  const [campaigns, setCampaigns] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [editing, setEditing] = useState(null);
  const [detailId, setDetailId] = useState(null);

  const load = useCallback(async () => {
    try { setCampaigns(await api.campaigns(storeGroup)); } catch (err) { toast(err.message, { bad: true }); setCampaigns((c) => c || []); }
  }, [storeGroup, toast]);
  useEffect(() => { load(); }, [load]);

  // Keep progress moving while anything is scheduled or sending.
  const active = campaigns?.some((c) => !TERMINAL.includes(c.status) && c.status !== 'paused');
  useEffect(() => {
    if (!active) return undefined;
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [active, load]);

  const act = async (c, action) => {
    if (action === 'cancel' && !(await confirm({
      title: `Stop "${c.name}"?`, message: 'Nobody else gets this campaign. You can\'t restart it, only delete it.', confirmLabel: 'Stop campaign', danger: true,
    }))) return;
    if (action === 'delete' && !(await confirm({ title: `Delete "${c.name}"?`, message: "Its history goes too. This can't be undone.", confirmLabel: 'Delete', danger: true }))) return;
    setBusyId(c.id);
    try {
      if (action === 'delete') await api.deleteCampaign(c.id);
      else await api.campaignAction(c.id, action);
      await load();
    } catch (err) {
      toast(err.message, { bad: true });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <main className="page">
      {confirmDialog}
      {editing && <EditModal campaign={editing} onClose={() => setEditing(null)} onSaved={(c) => { setEditing(null); toast(`"${c.name}" updated`); load(); }} />}
      {detailId && <DetailModal id={detailId} onClose={() => setDetailId(null)} />}
      <div className="page-head">
        <h1>Campaigns</h1>
        <button type="button" className="btn btn-primary" onClick={() => navigate('new')}>+ Create campaign</button>
      </div>
      {!campaigns ? <Loading text="Loading campaigns…" /> : campaigns.length === 0 ? (
        <Empty icon="📣" title="No campaigns yet">
          <p>Pick an audience, a template, and send now or on a schedule.</p>
          <button type="button" className="btn btn-primary" onClick={() => navigate('new')}>Create your first campaign</button>
        </Empty>
      ) : (
        <div className="list">
          {campaigns.map((c) => {
            const done = c.sentCount + c.failedCount + c.skippedCount;
            const pct = c.totalRecipients ? Math.round((done / c.totalRecipients) * 100) : 0;
            const live = !TERMINAL.includes(c.status);
            return (
              <div key={c.id} className="card">
                <div className="row" style={{ alignItems: 'flex-start' }}>
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="row" style={{ gap: 8 }}>
                      <button type="button" className="btn-ghost" style={{ border: 0, background: 'none', padding: 0, cursor: 'pointer', fontWeight: 700, fontSize: 15, color: 'var(--text)' }}
                        onClick={() => setDetailId(c.id)}>{c.name}</button>
                      <StatusBadge status={c.status} />
                      {c.sending && <span className="badge badge-running">sending now</span>}
                    </div>
                    {timing(c) && <div className="light" style={{ fontSize: 12.5, marginTop: 4 }}>{timing(c)}</div>}
                  </div>
                  <div className="row" style={{ gap: 6 }}>
                    <button className="btn btn-sm" type="button" onClick={() => setDetailId(c.id)}>Details</button>
                    {canEdit(c) && <button className="btn btn-sm" type="button" disabled={busyId === c.id} onClick={() => setEditing(c)}>Edit</button>}
                    {(c.status === 'scheduled' || c.status === 'running') && <button className="btn btn-sm" type="button" disabled={busyId === c.id} onClick={() => act(c, 'pause')}>Pause</button>}
                    {c.status === 'paused' && <button className="btn btn-sm" type="button" disabled={busyId === c.id} onClick={() => act(c, 'resume')}>Resume</button>}
                    {live && <button className="btn btn-sm" type="button" disabled={busyId === c.id} onClick={() => act(c, 'cancel')}>Stop</button>}
                    {!live && <button className="btn btn-sm btn-danger" type="button" disabled={busyId === c.id} onClick={() => act(c, 'delete')}>Delete</button>}
                  </div>
                </div>
                <div className="progress" style={{ marginTop: 12 }}><div style={{ width: `${pct}%` }} /></div>
                <div className="hint" style={{ marginTop: 8 }}>
                  {n(c.sentCount)} sent · {n(c.skippedCount)} skipped · {n(c.failedCount)} failed · {n(c.totalRecipients)} total
                  {c.mode === 'now' ? ' · sent straight away' : ` · ${n(c.batchSize)} every ${fmtInterval(c.intervalMinutes)} (${c.timezone})`}
                  {c.nextFireAt && live && c.status !== 'paused' && <> · next batch {fmtWhen(c.nextFireAt)}</>}
                  {c.endAt && live && <> · ends {fmtWhen(c.endAt)}</>}
                  {c.sendLimit != null && <> · up to {n(c.sendLimit)}/day</>}
                  {c.windowStart && <> · sends {c.windowStart}–{c.windowEnd}</>}
                </div>
                {c.lastError && live && <div className="warn" style={{ marginTop: 6 }}>{c.lastError}</div>}
              </div>
            );
          })}
        </div>
      )}
    </main>
  );
}

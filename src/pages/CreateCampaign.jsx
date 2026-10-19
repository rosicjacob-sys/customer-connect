import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import api from '../lib/api';
import { utmSlug } from '../lib/merge';
import { n, plural, TIMEZONES, fmtWhen, fmtInterval, recall, remember } from '../lib/util';
import { Loading, PaceHint, SourceBadges, useToast } from '../components/ui';
import { PreviewModal, SendTestPanel, TokenReference, UnsubscribeWarning } from '../components/email';
import SegmentManager from '../components/SegmentManager';

// The Create Campaign wizard: 1 Audience → 2 Template → 3 Send.
// Recipients are customers; the same email at two stores is two recipients
// (one email per store).

const SHOWN_ROWS = 500; // rows drawn in the list; selection still covers everyone

function localNowPlus(minutes) {
  const d = new Date(Date.now() + minutes * 60000);
  const pad = (v) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function CreateCampaign({ storeGroup, storeGroupName, navigate, status }) {
  const toast = useToast();
  const [step, setStep] = useState(1);

  // ── Step 1: Audience ──────────────────────────────────────────────────
  const [stores, setStores] = useState([]);
  const [segments, setSegments] = useState([]);
  const [otherStoreIds, setOtherStoreIds] = useState([]);
  const [mode, setMode] = useState('all'); // all | segment | specific
  const [segmentKey, setSegmentKey] = useState('');
  const [pickedStores, setPickedStores] = useState(new Set());
  const [storeSearch, setStoreSearch] = useState('');
  const [country, setCountry] = useState('');
  const [includeChat, setIncludeChat] = useState(false);
  const [skipEmailed, setSkipEmailed] = useState(false);
  const [audience, setAudience] = useState([]);
  const [suppressedCount, setSuppressedCount] = useState(0);
  const [loadingAudience, setLoadingAudience] = useState(false);
  const [audienceError, setAudienceError] = useState('');
  const [excluded, setExcluded] = useState(new Set());
  const [search, setSearch] = useState('');
  const [showSegments, setShowSegments] = useState(false);
  const loadSeq = useRef(0);

  useEffect(() => {
    api.stores(storeGroup).then((s) => setStores(s.filter((x) => x.isActive))).catch((e) => toast(e.message, { bad: true }));
  }, [storeGroup, toast]);

  const loadSegments = useCallback(async () => {
    const res = await api.segments(storeGroup).catch(() => null);
    if (res) { setSegments(res.segments); setOtherStoreIds(res.otherStoreIds); }
    return res;
  }, [storeGroup]);
  useEffect(() => { loadSegments(); }, [loadSegments]);

  // undefined = every store in scope; [] = nobody.
  const storeIds = useMemo(() => {
    if (mode === 'all') return undefined;
    if (mode === 'segment') {
      if (!segmentKey) return [];
      return segmentKey === 'others' ? otherStoreIds : segments.find((g) => String(g.id) === segmentKey)?.storeIds || [];
    }
    return [...pickedStores];
  }, [mode, segmentKey, segments, otherStoreIds, pickedStores]);

  const storeIdsKey = storeIds ? storeIds.join(',') : 'all';
  useEffect(() => {
    const seq = ++loadSeq.current;
    if (storeIds && storeIds.length === 0) { setAudience([]); setExcluded(new Set()); return; }
    setLoadingAudience(true);
    setAudienceError('');
    api.audience({
      storeGroup, storeIds, country,
      sources: includeChat ? undefined : 'checkout,upload,manual',
      skipAlreadyEmailed: skipEmailed ? 1 : undefined,
    }).then((res) => {
      if (seq !== loadSeq.current) return;
      setAudience(res.rows);
      setSuppressedCount(res.suppressedCount);
      setExcluded(new Set());
    }).catch((err) => {
      if (seq === loadSeq.current) { setAudience([]); setAudienceError(err.message); }
    }).finally(() => { if (seq === loadSeq.current) setLoadingAudience(false); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeGroup, storeIdsKey, country, includeChat, skipEmailed]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return audience;
    return audience.filter((r) => r.email.includes(q) || r.name.toLowerCase().includes(q)
      || (r.store_name || '').toLowerCase().includes(q) || r.store_domain.includes(q));
  }, [audience, search]);
  const selected = useMemo(() => audience.filter((r) => !excluded.has(r.id)), [audience, excluded]);
  const countryCounts = useMemo(() => audience.reduce((acc, r) => { acc[r.country || 'unset'] = (acc[r.country || 'unset'] || 0) + 1; return acc; }, {}), [audience]);

  const toggle = (id) => setExcluded((prev) => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next; });
  const setFiltered = (on) => setExcluded((prev) => { const next = new Set(prev); filtered.forEach((r) => (on ? next.delete(r.id) : next.add(r.id))); return next; });
  const shownStores = useMemo(() => {
    const q = storeSearch.trim().toLowerCase();
    return q ? stores.filter((s) => s.brandName.toLowerCase().includes(q) || s.domain.includes(q)) : stores;
  }, [stores, storeSearch]);

  // ── Step 2: Template ──────────────────────────────────────────────────
  const [templates, setTemplates] = useState(null);
  const [template, setTemplate] = useState(null); // full row incl. html
  const [preview, setPreview] = useState(null);
  const [draft, setDraft] = useState(null); // { name, subject, html, text } when writing a new one
  const [savingDraft, setSavingDraft] = useState(false);
  const [draftError, setDraftError] = useState('');

  const loadTemplates = useCallback(() => api.templates(storeGroup).then(setTemplates).catch(() => setTemplates([])), [storeGroup]);
  useEffect(() => { loadTemplates(); }, [loadTemplates]);

  const pickTemplate = async (t) => {
    try { setTemplate(await api.template(t.id)); } catch (err) { toast(err.message, { bad: true }); }
  };
  const saveDraft = async () => {
    setSavingDraft(true);
    setDraftError('');
    try {
      const saved = await api.createTemplate({ ...draft, storeGroup });
      setDraft(null);
      await loadTemplates();
      setTemplate(saved);
    } catch (err) {
      setDraftError(err.message);
    } finally {
      setSavingDraft(false);
    }
  };

  // ── Step 3: Send ──────────────────────────────────────────────────────
  const [delivery, setDelivery] = useState('now');
  const [name, setName] = useState('');
  const autoName = useRef('');
  useEffect(() => {
    // A name filled in from the template follows the template; a typed one stays.
    const t = (template?.name || '').trim();
    if (!t) return;
    setName((prev) => (prev.trim() && prev !== autoName.current ? prev : (autoName.current = t)));
  }, [template]);
  const [sendLimit, setSendLimit] = useState('');
  const [batchSize, setBatchSize] = useState(100);
  const [intervalValue, setIntervalValue] = useState(1);
  const [intervalUnit, setIntervalUnit] = useState('hours');
  const [startAt, setStartAt] = useState(() => localNowPlus(10));
  const [endAt, setEndAt] = useState('');
  const [windowStart, setWindowStart] = useState('');
  const [windowEnd, setWindowEnd] = useState('');
  const [timezone, setTimezone] = useState(() => recall('cc_timezone', Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York'));
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null);
  const [submitError, setSubmitError] = useState('');

  const limitNum = Math.floor(Number(sendLimit)) > 0 ? Math.floor(Number(sendLimit)) : null;
  const sendNowCount = limitNum ? Math.min(limitNum, selected.length) : selected.length;
  const campaignName = name.trim() || template?.name || `Campaign ${new Date().toLocaleDateString()}`;
  const intervalMinutes = intervalUnit === 'hours' ? intervalValue * 60 : intervalValue;
  const tzOptions = TIMEZONES.some(([v]) => v === timezone) ? TIMEZONES : [[timezone, timezone], ...TIMEZONES];

  const submit = async () => {
    setSubmitting(true);
    setSubmitError('');
    try {
      const body = {
        mode: delivery, name: campaignName, storeGroup,
        customerIds: selected.map((r) => r.id),
        templateId: template.id, subject: template.subject, html: template.html, text: template.text,
        sendLimit: limitNum,
        ...(delivery === 'scheduled' ? { batchSize, intervalMinutes, startAt, endAt: endAt || undefined, windowStart, windowEnd, timezone } : {}),
      };
      setResult(await api.createCampaign(body));
      remember('cc_timezone', timezone);
    } catch (err) {
      setSubmitError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  const canStep2 = selected.length > 0;
  const canStep3 = canStep2 && !!template;

  return (
    <main className="page page-narrow">
      {preview && <PreviewModal {...preview} stores={stores} onClose={() => setPreview(null)} />}
      {showSegments && (
        <SegmentManager stores={stores} segments={segments} storeGroup={storeGroup} onClose={() => setShowSegments(false)}
          onSaved={async (id) => { const res = await loadSegments(); if (mode === 'segment' && id && res) setSegmentKey(String(id)); }} />
      )}
      <div className="page-head">
        <h1>Create campaign</h1>
        <span className="badge">{storeGroupName ? `Group: ${storeGroupName}` : 'All groups'}</span>
      </div>
      <div className="steps">
        <button type="button" className={`step ${step === 1 ? 'active' : 'done'}`} onClick={() => !result && setStep(1)}>1. Audience</button>
        <button type="button" className={`step ${step === 2 ? 'active' : canStep2 ? 'done' : ''}`} disabled={!canStep2 || !!result} onClick={() => setStep(2)}>2. Template</button>
        <button type="button" className={`step ${step === 3 ? 'active' : canStep3 ? 'done' : ''}`} disabled={!canStep3} onClick={() => setStep(3)}>3. Send</button>
      </div>

      {step === 1 && (
        <div className="stack">
          <h3>Who should get this?</h3>
          <label className="check"><input type="radio" checked={mode === 'all'} onChange={() => setMode('all')} />
            <span>All customers{storeGroupName ? ` in ${storeGroupName}` : ''}</span></label>
          <label className="check"><input type="radio" checked={mode === 'segment'} onChange={() => setMode('segment')} />
            <span>A store segment</span>
            {mode === 'segment' && (
              <>
                <select className="select input-sm" style={{ width: 'auto' }} value={segmentKey} onChange={(e) => setSegmentKey(e.target.value)}>
                  <option value="">Choose a segment…</option>
                  {segments.map((g) => <option key={g.id} value={String(g.id)} disabled={!g.storeIds.length}>{g.name} ({plural(g.storeIds.length, 'store')})</option>)}
                  <option value="others" disabled={!otherStoreIds.length}>Others, in no segment ({plural(otherStoreIds.length, 'store')})</option>
                </select>
                <button type="button" className="btn btn-sm" onClick={(e) => { e.preventDefault(); setShowSegments(true); }}>Manage segments</button>
              </>
            )}
          </label>
          <label className="check"><input type="radio" checked={mode === 'specific'} onChange={() => setMode('specific')} /><span>Specific stores</span></label>
          {mode === 'specific' && (
            <div className="card">
              <div className="row" style={{ marginBottom: 8 }}>
                <input className="input input-sm grow" placeholder="Search stores…" value={storeSearch} onChange={(e) => setStoreSearch(e.target.value)} />
                <span className="hint">{plural(pickedStores.size, 'store')} picked</span>
              </div>
              <div className="list-box" style={{ maxHeight: 200 }}>
                {shownStores.map((s) => (
                  <label key={s.id}>
                    <input type="checkbox" checked={pickedStores.has(s.id)}
                      onChange={() => setPickedStores((prev) => { const next = new Set(prev); next.has(s.id) ? next.delete(s.id) : next.add(s.id); return next; })} />
                    <span>{s.brandName}</span><span className="hint">{s.domain}</span>
                  </label>
                ))}
                {!shownStores.length && <div className="empty" style={{ padding: 20 }}>No stores. Add them on the Stores page.</div>}
              </div>
            </div>
          )}

          <div className="row">
            <label className="label" htmlFor="cc-country">Country</label>
            <select id="cc-country" className="select input-sm" style={{ width: 'auto' }} value={country} onChange={(e) => setCountry(e.target.value)}>
              <option value="">All countries</option>
              <option value="CA">🇨🇦 Canada only</option>
              <option value="US">🇺🇸 USA only</option>
            </select>
            {!country && audience.length > 0 && <span className="hint">🇨🇦 {n(countryCounts.CA)} · 🇺🇸 {n(countryCounts.US)}{countryCounts.unset ? ` · ${n(countryCounts.unset)} unset` : ''}</span>}
          </div>
          <label className="check"><input type="checkbox" checked={includeChat} onChange={(e) => setIncludeChat(e.target.checked)} />
            <span>Also include customers who only chatted with us<div className="hint">Off by default: the audience is people who ordered through the checkout portal, people from uploaded files and people added by hand.</div></span></label>
          <label className="check"><input type="checkbox" checked={skipEmailed} onChange={(e) => setSkipEmailed(e.target.checked)} />
            <span>Leave out people this store has already emailed<div className="hint">Uses the sent history (Customers → Sent history), where rows can be reset.</div></span></label>

          <div className="row">
            <input className="input grow" placeholder="Search name, email or store…" value={search} onChange={(e) => setSearch(e.target.value)} />
            <button type="button" className="btn btn-sm" onClick={() => setFiltered(true)}>Select all shown</button>
            <button type="button" className="btn btn-sm" onClick={() => setFiltered(false)}>Clear shown</button>
          </div>
          {audienceError && <div className="error">{audienceError}</div>}
          <div className="list-box">
            {loadingAudience ? <Loading text="Loading audience…" /> : filtered.length === 0 ? (
              <div className="empty" style={{ padding: 30 }}>{audience.length ? 'Nobody matches that search.' : 'Nobody to email with these choices.'}</div>
            ) : filtered.slice(0, SHOWN_ROWS).map((r) => (
              <label key={r.id}>
                <input type="checkbox" checked={!excluded.has(r.id)} onChange={() => toggle(r.id)} />
                <span className="grow ellipsis" style={{ fontWeight: 600 }}>{r.email}{r.name ? <span className="hint"> · {r.name}</span> : null}</span>
                <span className="light ellipsis hide-sm" style={{ maxWidth: 200 }}>{r.store_name}</span>
                <SourceBadges customer={r} />
              </label>
            ))}
          </div>
          {filtered.length > SHOWN_ROWS && <div className="hint">Showing the first {n(SHOWN_ROWS)} of {n(filtered.length)}. Search to find someone; selection covers everyone.</div>}
          <div className="row">
            <strong>{n(selected.length)}</strong><span className="light">of {n(audience.length)} selected.</span>
            <span className="hint">One email per person, as their latest store. Unsubscribed, blocked and unverified addresses are already left out{suppressedCount ? `, and ${n(suppressedCount)} who bounced before` : ''}.</span>
            <span className="spacer" />
            <button type="button" className="btn btn-primary" disabled={!canStep2} onClick={() => setStep(2)}>Next: Template →</button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="stack">
          <h3>Pick a template</h3>
          {!templates ? <Loading /> : templates.length === 0 && !draft ? <div className="light">No saved templates in this group yet. Write one below.</div> : (
            <div className="list">
              {templates.map((t) => (
                <div key={t.id} className={`tmpl-card ${template?.id === t.id ? 'selected' : ''}`} role="button" tabIndex={0}
                  onClick={() => pickTemplate(t)} onKeyDown={(e) => e.key === 'Enter' && pickTemplate(t)}>
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 700 }}>{t.name}</div>
                    <div className="light ellipsis" style={{ fontSize: 12.5 }}>{t.subject}</div>
                  </div>
                  <button type="button" className="btn btn-sm" onClick={async (e) => { e.stopPropagation(); const full = await api.template(t.id); setPreview({ subject: full.subject, html: full.html, text: full.text, name: full.name }); }}>Preview</button>
                </div>
              ))}
            </div>
          )}
          {!draft ? (
            <div><button type="button" className="btn" onClick={() => setDraft({ name: '', subject: '', html: '', text: '' })}>+ New template</button></div>
          ) : (
            <div className="card stack">
              <div className="card-title" style={{ margin: 0 }}>New template</div>
              <TokenReference />
              <input className="input" placeholder="Template name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
              <input className="input" placeholder="Subject" value={draft.subject} onChange={(e) => setDraft({ ...draft, subject: e.target.value })} />
              <textarea className="textarea" rows={10} placeholder="Paste your HTML…" value={draft.html} onChange={(e) => setDraft({ ...draft, html: e.target.value })} />
              <UnsubscribeWarning html={draft.html} />
              <textarea className="textarea" rows={3} placeholder="Plain text (optional)" value={draft.text} onChange={(e) => setDraft({ ...draft, text: e.target.value })} />
              {draftError && <div className="error">{draftError}</div>}
              <div className="row">
                <button type="button" className="btn" onClick={() => setDraft(null)} disabled={savingDraft}>Cancel</button>
                <button type="button" className="btn" disabled={!draft.html.trim()} onClick={() => setPreview({ ...draft })}>Preview</button>
                <button type="button" className="btn btn-primary" onClick={saveDraft} disabled={savingDraft}>{savingDraft ? 'Saving…' : 'Save and use'}</button>
              </div>
            </div>
          )}
          <div className="row">
            <button type="button" className="btn" onClick={() => setStep(1)}>← Back</button>
            <span className="spacer" />
            <button type="button" className="btn btn-primary" disabled={!canStep3} onClick={() => setStep(3)}>Next: Send →</button>
          </div>
        </div>
      )}

      {step === 3 && template && (
        <div className="stack">
          <h3>Review and send</h3>
          <div className="row">
            <span><strong>{n(selected.length)}</strong> recipients · template <strong>{template.name}</strong></span>
            <button type="button" className="btn btn-sm" onClick={() => setPreview({ subject: template.subject, html: template.html, text: template.text, name: template.name, renderAs: selected[0] })}>Preview</button>
          </div>
          <div className="row" style={{ alignItems: 'flex-start' }}>
            <label className="field" style={{ flex: 2, minWidth: 220 }}><span>Campaign name</span>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. October thank-you" disabled={!!result} />
              <span className="hint">Tags every store link: <span className="mono">utm_campaign={utmSlug(campaignName) || 'untitled'}</span></span>
            </label>
            <label className="field" style={{ minWidth: 150 }}><span>Daily send limit</span>
              <input className="input" type="number" min="1" placeholder="No limit" value={sendLimit} onChange={(e) => setSendLimit(e.target.value)} disabled={!!result} />
              <span className="hint">{delivery === 'scheduled' ? 'Most per day; the rest go out on the following days.' : 'Send now: only the first N go out.'}</span>
            </label>
          </div>
          <SendTestPanel subject={template.subject} html={template.html} text={template.text} name={campaignName} stores={stores} renderAs={selected[0]} />

          <label className="check"><input type="radio" checked={delivery === 'now'} onChange={() => setDelivery('now')} disabled={!!result} />
            <span>Send now: {n(sendNowCount)} {sendNowCount === 1 ? 'email' : 'emails'} start going out straight away{limitNum && limitNum < selected.length ? ` (capped at ${n(limitNum)})` : ''}</span></label>
          <label className="check"><input type="radio" checked={delivery === 'scheduled'} onChange={() => setDelivery('scheduled')} disabled={!!result} />
            <span>Schedule: send in batches{limitNum ? `, up to ${n(limitNum)} a day until all ${n(selected.length)} are sent` : ''}</span></label>

          {delivery === 'scheduled' && (
            <div className="card stack">
              <div className="row">
                <label className="field"><span>Batch size</span><input className="input" type="number" min="1" value={batchSize} onChange={(e) => setBatchSize(Math.max(1, Number(e.target.value) || 1))} /></label>
                <label className="field"><span>Every</span><input className="input" type="number" min="1" value={intervalValue} onChange={(e) => setIntervalValue(Math.max(1, Number(e.target.value) || 1))} /></label>
                <label className="field"><span>Unit</span>
                  <select className="select" value={intervalUnit} onChange={(e) => setIntervalUnit(e.target.value)}><option value="minutes">Minutes</option><option value="hours">Hours</option></select>
                </label>
              </div>
              <div className="row">
                <label className="field"><span>Start</span><input className="input" type="datetime-local" value={startAt} onChange={(e) => setStartAt(e.target.value)} /></label>
                <label className="field"><span>End (optional)</span><input className="input" type="datetime-local" value={endAt} onChange={(e) => setEndAt(e.target.value)} /></label>
              </div>
              <div className="field"><span>Sending hours each day (optional)</span>
                <div className="row">
                  <input className="input" style={{ flex: 1 }} type="time" value={windowStart} onChange={(e) => setWindowStart(e.target.value)} aria-label="Send from" />
                  <span className="hint">to</span>
                  <input className="input" style={{ flex: 1 }} type="time" value={windowEnd} onChange={(e) => setWindowEnd(e.target.value)} aria-label="Send until" />
                </div>
                <span className="hint">Only sends between these times. Once the daily limit is reached it waits for tomorrow's hours.</span>
              </div>
              <label className="field"><span>Timezone</span>
                <select className="select" value={timezone} onChange={(e) => setTimezone(e.target.value)}>{tzOptions.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
              </label>
              <div className="light" style={{ fontSize: 13 }}>
                Sends {n(batchSize)} every {fmtInterval(intervalMinutes)}, starting {startAt.replace('T', ' ')}
                {endAt ? ` until ${endAt.replace('T', ' ')}` : ''}{windowStart && windowEnd ? `, only between ${windowStart} and ${windowEnd}` : ''} ({timezone}).
              </div>
              <PaceHint batchSize={batchSize} intervalMinutes={intervalMinutes} sendLimit={limitNum} windowStart={windowStart} windowEnd={windowEnd} />
            </div>
          )}

          {status?.emailMode === 'dry-run' && !result && <div className="warn">Dry run is on: nothing will actually be emailed. The messages appear under Settings → Outbox.</div>}
          {submitError && <div className="error">{submitError}</div>}
          {result ? (
            <div className="success">
              ✓ "{result.name}" {result.mode === 'now'
                ? `is sending to ${plural(result.totalRecipients, 'recipient')}. Progress shows on the Campaigns page; you can close this tab.`
                : `is scheduled: ${n(result.batchSize)} every ${fmtInterval(result.intervalMinutes)}, first batch ${fmtWhen(result.nextFireAt)}.`}
              <div style={{ marginTop: 10 }}><button type="button" className="btn btn-primary" onClick={() => navigate('campaigns')}>Go to Campaigns</button></div>
            </div>
          ) : (
            <div className="row">
              <button type="button" className="btn" onClick={() => setStep(2)} disabled={submitting}>← Back</button>
              <span className="spacer" />
              <button type="button" className="btn btn-primary" onClick={submit} disabled={submitting || !selected.length}>
                {submitting ? 'Working…' : delivery === 'now' ? `Send to ${n(sendNowCount)} now` : 'Schedule campaign'}
              </button>
            </div>
          )}
        </div>
      )}
    </main>
  );
}

import React, { useState } from 'react';
import api from '../lib/api';
import { renderPreview, TOKENS } from '../lib/merge';
import { EMAIL_RE, recall, remember, downloadBlob } from '../lib/util';
import { Modal } from './ui';

// Template pieces shared by the Templates page and the campaign wizard.

export function TokenReference({ open = false }) {
  return (
    <details className="token-ref" open={open}>
      <summary>Tokens you can use in the subject and HTML</summary>
      <div style={{ marginTop: 8 }}>
        {TOKENS.map(([token, desc]) => (
          <div key={token} className="token-row"><code>{token}</code><span className="light">{desc}</span></div>
        ))}
      </div>
      <div className="hint" style={{ marginTop: 8 }}>
        Promo emails to customer lists need a visible unsubscribe link (Canada's CASL, the US CAN-SPAM).
        Every email also carries a one-click unsubscribe header for Gmail and Yahoo.
      </div>
    </details>
  );
}

export function UnsubscribeWarning({ html }) {
  if (!html.trim() || html.includes('{{unsubscribe_url}}')) return null;
  return (
    <div className="warn">
      No {'{{unsubscribe_url}}'} link in this template. Fine for a one-to-one follow-up; promo emails to customer lists should include it.
    </div>
  );
}

// Saves the template's HTML as written, tokens included.
export function downloadTemplateHtml(name, html) {
  downloadBlob(new Blob([html || ''], { type: 'text/html;charset=utf-8' }),
    `${String(name || '').trim().replace(/[\\/:*?"<>|]+/g, '-') || 'template'}.html`);
}

const storeLabel = (st) => `${st.brandName} (${st.domain})`;

// Sends the content to one address as if it came from the chosen store, or
// rendered as a given recipient (renderAs) when the wizard passes one.
export function SendTestPanel({ subject, html, text, name, stores, renderAs }) {
  const [email, setEmail] = useState(() => recall('cc_test_email'));
  const [storeQuery, setStoreQuery] = useState(() => recall('cc_test_store'));
  const [sending, setSending] = useState(false);
  const [msg, setMsg] = useState(null);
  const store = stores.find((st) => storeLabel(st) === storeQuery) || null;

  const send = async () => {
    if (!EMAIL_RE.test(email.trim())) return setMsg({ ok: false, text: 'Enter a valid email address.' });
    if (!renderAs && !store) return setMsg({ ok: false, text: 'Pick the store this email should come from.' });
    if (!subject.trim() || !html.trim()) return setMsg({ ok: false, text: 'Add a subject and HTML first.' });
    setSending(true);
    setMsg(null);
    try {
      const res = await api.testSend({
        to: email.trim(), subject, html, text: text || undefined, campaignName: name || 'Test',
        ...(renderAs ? { customerId: renderAs.id } : { storeId: store.id }),
      });
      setMsg({ ok: true, text: `Sent to ${email.trim()} as ${res.storeName}.` });
      remember('cc_test_email', email.trim());
      if (!renderAs) remember('cc_test_store', storeQuery);
    } catch (err) {
      setMsg({ ok: false, text: err.message });
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="card" style={{ background: 'var(--surface-2)' }}>
      <div className="label" style={{ marginBottom: 8 }}>Send a test email</div>
      <div className="row">
        <input className="input input-sm grow" type="email" placeholder="you@example.com" value={email}
          onChange={(e) => { setEmail(e.target.value); setMsg(null); }} aria-label="Send the test to" />
        {!renderAs && (
          <>
            <input className="input input-sm grow" list="cc-test-stores" value={storeQuery}
              placeholder={stores.length ? 'From store (type to search)' : 'Add a store first'}
              onChange={(e) => { setStoreQuery(e.target.value); setMsg(null); }} aria-label="Send as store" />
            <datalist id="cc-test-stores">{stores.map((st) => <option key={st.id} value={storeLabel(st)} />)}</datalist>
          </>
        )}
        <button type="button" className="btn btn-primary btn-sm" onClick={send} disabled={sending}>{sending ? 'Sending…' : 'Send test'}</button>
      </div>
      <div className={msg ? '' : 'hint'} style={{ marginTop: 6, fontSize: 12, color: msg ? (msg.ok ? 'var(--success-text)' : 'var(--danger-text)') : undefined }}>
        {msg ? msg.text : renderAs
          ? `Rendered as ${renderAs.email} (${renderAs.store_name}): their store's name, colours, links and sender.`
          : "Uses the store's name, colours, links and sender address, like a real send."}
      </div>
    </div>
  );
}

export function PreviewModal({ subject, html, text, name, stores, onClose, renderAs }) {
  const preview = renderPreview(subject, html);
  return (
    <Modal title={preview.subject || '(no subject)'} wide onClose={onClose}
      headerExtra={<button type="button" className="btn btn-sm" onClick={() => downloadTemplateHtml(name, html)}>⬇ HTML</button>}>
      <div style={{ margin: '-16px -20px 0' }}>
        <iframe title="Email preview" className="preview-frame" sandbox="" srcDoc={preview.html} />
      </div>
      <div className="hint" style={{ margin: '10px 0 12px' }}>Shown with sample data. Real sends fill the tokens with each recipient's details.</div>
      {stores && <SendTestPanel subject={subject} html={html} text={text} name={name} stores={stores} renderAs={renderAs} />}
    </Modal>
  );
}

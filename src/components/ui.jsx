import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

// A dialog: Esc and a click outside close it unless `busy`.
export function Modal({ title, onClose, busy = false, wide = false, children, footer, headerExtra }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !busy) onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);
  return createPortal(
    <div className="backdrop" onMouseDown={() => !busy && onClose?.()}>
      <div className={`dialog ${wide ? 'dialog-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}
        onMouseDown={(e) => e.stopPropagation()}>
        <div className="dialog-head">
          <h3>{title}</h3>
          {headerExtra}
          <button type="button" className="icon-btn" onClick={onClose} disabled={busy} aria-label="Close">✕</button>
        </div>
        <div className="dialog-body">{children}</div>
        {footer && <div className="dialog-foot">{footer}</div>}
      </div>
    </div>,
    document.body
  );
}

// Promise-based confirm, a styled window.confirm:
//   const [confirm, confirmDialog] = useConfirm();
//   if (!(await confirm({ title: 'Delete?', danger: true }))) return;
export function useConfirm() {
  const [state, setState] = useState(null);
  const resolver = useRef(null);
  const confirm = useCallback((opts) => new Promise((resolve) => { resolver.current = resolve; setState(opts); }), []);
  const close = (result) => { resolver.current?.(result); resolver.current = null; setState(null); };
  const dialog = state && (
    <Modal title={state.title} onClose={() => close(false)} footer={<>
      <button type="button" className="btn" onClick={() => close(false)}>{state.cancelLabel || 'Cancel'}</button>
      <button type="button" autoFocus className={`btn ${state.danger ? 'btn-danger' : 'btn-primary'}`} onClick={() => close(true)}>
        {state.confirmLabel || 'Confirm'}
      </button>
    </>}>
      {state.message && <div className="light">{state.message}</div>}
    </Modal>
  );
  return [confirm, dialog];
}

const ToastContext = createContext(() => {});
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }) {
  const [toast, setToast] = useState(null);
  const timer = useRef(null);
  const show = useCallback((text, { bad = false } = {}) => {
    clearTimeout(timer.current);
    setToast({ text, bad });
    timer.current = setTimeout(() => setToast(null), bad ? 5000 : 3000);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <ToastContext.Provider value={show}>
      {children}
      {toast && <div className={`toast ${toast.bad ? 'bad' : ''}`} role="status">{toast.text}</div>}
    </ToastContext.Provider>
  );
}

export function Loading({ text = 'Loading…' }) {
  return <div className="empty"><div className="spinner" /><div>{text}</div></div>;
}

export function Empty({ icon, title, children }) {
  return (
    <div className="empty">
      {icon && <div className="big" aria-hidden="true">{icon}</div>}
      <div className="title">{title}</div>
      {children && <div>{children}</div>}
    </div>
  );
}

export const SOURCE_OPTIONS = [
  { value: '', label: 'All sources' },
  { value: 'checkout', label: 'Ordered (checkout portal)' },
  { value: 'upload', label: 'From an upload' },
  { value: 'manual', label: 'Added by hand' },
  { value: 'chat', label: 'Chatted with us' },
];

export function SourceBadges({ customer: c }) {
  return (
    <span className="badges">
      {c.from_checkout && <span className="badge badge-checkout" title="Ordered through the checkout portal">Order</span>}
      {c.from_upload && <span className="badge badge-upload" title="In an uploaded customer file">Upload</span>}
      {c.added_manually && <span className="badge badge-manual" title="Added by hand">Added</span>}
      {c.from_chat && <span className="badge badge-chat" title="Chatted with us in Chat Support Pro">Chat</span>}
      {c.email_check && c.email_check !== 'ok' && <span className="badge badge-paused" title="Its email domain couldn't be checked yet; left out of campaigns until it is">Unverified</span>}
    </span>
  );
}

export function StatusBadge({ status }) {
  const label = status === 'cancelled' ? 'stopped' : status;
  return <span className={`badge badge-${status}`}>{label}</span>;
}

function clockMinutes(v) {
  const m = /^(\d{2}):(\d{2})$/.exec(v || '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

// How many emails the batch size and interval can send in one day of
// sending hours, so a daily limit the pace can never reach is caught early.
export function PaceHint({ batchSize, intervalMinutes, sendLimit, windowStart, windowEnd }) {
  const batch = Number(batchSize) || 0;
  const every = Number(intervalMinutes) || 0;
  if (batch < 1 || every <= 0) return null;
  const s = clockMinutes(windowStart), e = clockMinutes(windowEnd);
  const windowMinutes = s != null && e != null && s !== e ? (e - s + 1440) % 1440 : 1440;
  const perDay = Math.ceil(windowMinutes / every) * batch;
  const hours = Math.round((windowMinutes / 60) * 10) / 10;
  const limit = Number(sendLimit) || null;
  if (limit && perDay < limit) {
    return (
      <div className="warn">
        At this pace only about {perDay.toLocaleString()} can go out in {hours} h of sending, below the daily limit of {limit.toLocaleString()}.
        Raise the batch size or send more often to reach it.
      </div>
    );
  }
  return (
    <div className="hint">
      Up to about {(limit ? Math.min(limit, perDay) : perDay).toLocaleString()} emails a day
      {limit ? ` (daily limit ${limit.toLocaleString()})` : ''} across {hours} h of sending.
    </div>
  );
}

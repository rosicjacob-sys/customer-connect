import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Modal } from './ui';
import { n } from '../lib/util';

// Ticked rows of a list. Either a set of ids, or "everyone matching the
// filters" (all pages) minus the ones unticked since. Cleared whenever
// `resetKey` changes (new filters, new group), so a selection never
// silently covers rows the person can't see any more.
export function useSelection(resetKey) {
  const [state, setState] = useState({ all: false, ids: new Set(), except: new Set() });
  const clear = useCallback(() => setState({ all: false, ids: new Set(), except: new Set() }), []);
  useEffect(() => { clear(); }, [resetKey, clear]);

  return useMemo(() => {
    const isChecked = (id) => (state.all ? !state.except.has(id) : state.ids.has(id));
    return {
      all: state.all,
      isChecked,
      toggle: (id) => setState((s) => {
        const key = s.all ? 'except' : 'ids';
        const next = new Set(s[key]);
        next.has(id) ? next.delete(id) : next.add(id);
        return { ...s, [key]: next };
      }),
      // Tick or untick every row in view.
      setMany: (ids, on) => setState((s) => {
        const key = s.all ? 'except' : 'ids';
        const next = new Set(s[key]);
        const add = s.all ? !on : on;
        ids.forEach((id) => (add ? next.add(id) : next.delete(id)));
        return { ...s, [key]: next };
      }),
      selectAllMatching: () => setState({ all: true, ids: new Set(), except: new Set() }),
      clear,
      count: (total) => (state.all ? Math.max(0, (total || 0) - state.except.size) : state.ids.size),
      ids: () => [...state.ids],
      // What the server's batch endpoints take.
      payload: (filters) => (state.all ? { all: true, filters, exceptIds: [...state.except] } : { ids: [...state.ids] }),
    };
  }, [state, clear]);
}

// The header checkbox: ticks or unticks every row in view.
export function ViewCheckbox({ sel, ids, label = 'Select all shown' }) {
  const ref = useRef(null);
  const checked = ids.length > 0 && ids.every(sel.isChecked);
  const some = !checked && ids.some(sel.isChecked);
  useEffect(() => { if (ref.current) ref.current.indeterminate = some; }, [some]);
  return <input ref={ref} type="checkbox" aria-label={label} checked={checked} disabled={!ids.length} onChange={() => sel.setMany(ids, !checked)} />;
}

export function RowCheckbox({ sel, id, label }) {
  return <input type="checkbox" aria-label={label} checked={sel.isChecked(id)} onChange={() => sel.toggle(id)} />;
}

// Shown while anything is ticked: how many, "select all matching" when the
// list has more pages than the one in view, and the page's actions.
export function SelectionBar({ sel, total, viewIds, noun = ['item', 'items'], children }) {
  const count = sel.count(total);
  if (!count) return null;
  const word = count === 1 ? noun[0] : noun[1];
  const viewAllTicked = viewIds?.length > 0 && viewIds.every(sel.isChecked);
  return (
    <div className="selbar" role="region" aria-label="Selected">
      <div className="selbar-count">
        <strong>{n(count)}</strong> {word} selected
        {!sel.all && total > (viewIds?.length || 0) && viewAllTicked && (
          <button type="button" className="link-btn" onClick={sel.selectAllMatching}>Select all {n(total)} matching</button>
        )}
        {sel.all && <span className="hint"> (every page matching your filters)</span>}
        <button type="button" className="link-btn" onClick={sel.clear}>Deselect all</button>
      </div>
      <div className="selbar-actions">{children}</div>
    </div>
  );
}

// Pick one value for a batch action: a store, a segment, a group, a country.
//   options: [{ value, label }]; allowNew: also accept a typed new name.
export function ChoiceModal({ title, label, options, allowNew = false, newLabel = 'Or a new one', message, confirmLabel = 'Apply', danger = false, onConfirm, onClose }) {
  const [value, setValue] = useState('');
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const picked = typed.trim() ? { isNew: true, value: typed.trim() } : value ? { isNew: false, value } : null;
  const go = async () => {
    setBusy(true);
    setError('');
    try { await onConfirm(picked); } catch (err) { setError(err.message); setBusy(false); }
  };
  return (
    <Modal title={title} onClose={onClose} busy={busy} footer={<>
      <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
      <button type="button" className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} onClick={go} disabled={busy || !picked}>{busy ? 'Working…' : confirmLabel}</button>
    </>}>
      <div className="stack">
        {message && <div className="light">{message}</div>}
        {options.length > 0 && (
          <label className="field"><span>{label}</span>
            <select className="select" value={value} onChange={(e) => { setValue(e.target.value); setTyped(''); }} autoFocus>
              <option value="">Choose…</option>
              {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </label>
        )}
        {allowNew && (
          <label className="field"><span>{newLabel}</span>
            <input className="input" value={typed} onChange={(e) => { setTyped(e.target.value); if (e.target.value) setValue(''); }} placeholder="Type a name" />
          </label>
        )}
        {error && <div className="error">{error}</div>}
      </div>
    </Modal>
  );
}

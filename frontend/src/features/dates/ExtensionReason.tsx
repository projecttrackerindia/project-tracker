import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { setExtensionReasonHandler, type ExtensionAsk } from '../../api/client';
import { CalmSheet } from '../../components/calm/CalmSheet';
import './extension.css';

/** Short reasons people pick most; one tap fills the field (still editable). */
export const QUICK_REASONS = ['Waiting on a dependency', 'Scope changed', 'Waiting on the client', 'Not enough people', 'Blocked by a bug'];

interface Ask { what: string; from?: string | null; to?: string | null; message?: string; resolve: (reason: string | null) => void }
const useAsk = create<{ ask: Ask | null; set: (a: Ask | null) => void }>((set) => ({ ask: null, set: (ask) => set({ ask }) }));

/**
 * Asks "Reason for extending" in the shared sheet and resolves with the reason, or null when cancelled. Use it before saving any change that
 * moves a start, due or end date later (pulling a date earlier needs no reason). Asks arriving while one is open wait their turn.
 */
let chain: Promise<unknown> = Promise.resolve();
export function askExtensionReason(o: { what?: string; from?: string | null; to?: string | null; message?: string } = {}): Promise<string | null> {
  const next = chain.then(() => new Promise<string | null>((resolve) => useAsk.getState().set({ what: o.what ?? 'date', from: o.from, to: o.to, message: o.message, resolve })));
  chain = next.catch(() => null);
  return next;
}

/** Whether moving `from` to `to` (yyyy-mm-dd) is an extension. A removed date counts only when `removalIsDelay`. */
export const isExtension = (from?: string | null, to?: string | null, removalIsDelay = false) =>
  !!from && (to ? to.slice(0, 10) > from.slice(0, 10) : removalIsDelay);

const fmt = (d?: string | null) => d ? new Date(`${d.slice(0, 10)}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : null;
const dateIn = (b: Record<string, unknown>) => {
  for (const k of ['dueDate', 'endDate', 'startDate', 'plannedEnd', 'plannedStart', 'date', 'due', 'start']) if (typeof b[k] === 'string') return b[k] as string;
  const c = Array.isArray(b.changes) ? (b.changes[0] as Record<string, unknown> | undefined) : undefined;
  return c ? (typeof c.dueDate === 'string' ? c.dueDate : typeof c.startDate === 'string' ? c.startDate : null) : null;
};
const whatOf = (a: ExtensionAsk) => {
  const m = /the (.+?) is moving later|the (.+?) are moving later/i.exec(a.message);
  return m?.[1] ?? m?.[2] ?? 'date';
};

/** Mounted once in the shell: the sheet, and the API client's handler for 422 DATE_EXTENSION_REASON_REQUIRED. */
export function ExtensionReasonHost() {
  const ask = useAsk((s) => s.ask);
  useEffect(() => {
    setExtensionReasonHandler((a) => askExtensionReason({ what: whatOf(a), to: dateIn(a.body) }));
    return () => setExtensionReasonHandler(null);
  }, []);
  return ask ? <ReasonSheet key={`${ask.what}:${ask.to ?? ''}`} ask={ask} /> : null;
}

function ReasonSheet({ ask }: { ask: Ask }) {
  const [text, setText] = useState('');
  const [open, setOpen] = useState(true);
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { window.setTimeout(() => field.current?.focus(), 60); }, []);
  const done = (r: string | null) => { setOpen(false); useAsk.getState().set(null); ask.resolve(r); };
  const ok = text.trim().length >= 3;
  const from = fmt(ask.from), to = fmt(ask.to);
  return (
    <CalmSheet open={open} onClose={() => done(null)} kind="bottom" width={520} title="Reason for extending"
      sub={<>Moving the {ask.what} later{from || to ? <> · {from && <s className="xr-from">{from}</s>}{from && to ? ' → ' : ''}{to && <b>{to}</b>}</> : null}. Everyone following it sees why.</>}>
      <form className="xr" data-testid="extension-reason" onSubmit={(e) => { e.preventDefault(); if (ok) done(text.trim()); }}>
        <div className="xr-chips" role="group" aria-label="Common reasons">
          {QUICK_REASONS.map((r) => <button key={r} type="button" className={text === r ? 'on' : ''} onClick={() => { setText(r); field.current?.focus(); }}>{r}</button>)}
        </div>
        <label className="xr-l" htmlFor="xr-text">Reason <span aria-hidden="true">(required)</span></label>
        <textarea id="xr-text" ref={field} className="xr-t" rows={3} maxLength={500} value={text} onChange={(e) => setText(e.target.value)} required
          placeholder="For example: the bank sandbox is late, so testing moves a week." aria-required="true"
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && ok) { e.preventDefault(); done(text.trim()); } }} />
        <div className="xr-foot">
          <button type="button" className="xr-cancel" onClick={() => done(null)}>Keep the date</button>
          <button type="submit" className="xr-go" disabled={!ok}>Extend date</button>
        </div>
      </form>
    </CalmSheet>
  );
}

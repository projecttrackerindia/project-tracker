import { useEffect, useRef, useState } from 'react';
import { CalmSheet } from '../../components/calm/CalmSheet';
import { QUICK_REASONS, useAsk, type Ask } from './ExtensionReason';
import './extension.css';

const fmt = (d?: string | null) => d ? new Date(`${d.slice(0, 10)}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : null;

/** The shared "Reason for extending" sheet (see ExtensionReason.tsx). */
export function ReasonSheet({ ask }: { ask: Ask }) {
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

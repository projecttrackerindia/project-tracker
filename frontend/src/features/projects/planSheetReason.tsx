import { useState } from 'react';
import { Modal } from '../../components/ui';
import { dm } from './planSheet';

const REASONS = ['Waiting on external', 'Scope changed', 'Capacity', 'Dependency late'];

/** Later due dates need one reason (kept with the date history), for the whole batch: a fill, a ripple or a paste. */
export function ReasonModal({ moves, onSave, onClose, title }: { moves: { key: string; from: string; to: string; days: number | null }[]; onSave: (reason: string, dependency: string) => void; onClose: () => void; title?: string }) {
  const [reason, setReason] = useState('');
  const [chip, setChip] = useState<string | null>(null);
  const [dep, setDep] = useState('');
  const full = [chip, reason.trim()].filter(Boolean).join(': ');
  return (
    <Modal title={title ?? (moves.length === 1 ? `Why is ${moves[0].key} moving?` : `Why are ${moves.length} due dates moving?`)} subtitle="Later due dates need a reason, kept with the date history." onClose={onClose} size="sm"
      onSubmit={(e) => { e.preventDefault(); if (full) onSave(full, dep.trim()); }}
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="submit" className="btn btn-primary" disabled={!full}>Save</button></>}>
      <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 12px', fontSize: 13, lineHeight: 1.7 }}>
        {moves.slice(0, 6).map((m) => <li key={m.key}><span style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 11.5, opacity: .7 }}>{m.key}</span> {dm(m.from)} → <b>{dm(m.to)}</b>{m.days ? <em style={{ color: 'var(--ds-warning, #f08c00)', fontStyle: 'normal', fontWeight: 600 }}> +{m.days}d</em> : null}</li>)}
        {moves.length > 6 && <li style={{ opacity: .6 }}>and {moves.length - 6} more</li>}
      </ul>
      <div role="group" aria-label="Common reasons" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
        {REASONS.map((x) => <button key={x} type="button" aria-pressed={chip === x} className={`chip ${chip === x ? 'on' : ''}`} onClick={() => setChip(chip === x ? null : x)}
          style={{ border: 0, borderRadius: 999, padding: '5px 11px', fontSize: 12.5, cursor: 'pointer', background: chip === x ? 'var(--ds-accent-soft, #e8f1fd)' : 'var(--ds-fill, rgba(0,0,0,.05))', color: chip === x ? 'var(--ds-accent, #0a84ff)' : 'inherit' }}>{x}</button>)}
      </div>
      <label className="field" style={{ display: 'block', marginBottom: 10 }}>Reason<textarea className="input" aria-label="Reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={480} placeholder="What changed?" style={{ width: '100%' }} /></label>
      <label className="field" style={{ display: 'block' }}>Waiting on (optional)<input className="input" aria-label="Waiting on" value={dep} onChange={(e) => setDep(e.target.value)} maxLength={300} style={{ width: '100%' }} /></label>
    </Modal>
  );
}

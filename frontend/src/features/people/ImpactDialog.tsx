import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ApiError } from '../../api/client';
import { workspaceApi } from '../../api/endpoints';
import type { ImpactRequest, PersonImpact } from '../../api/types';
import { Icon } from '../../components/Icon';
import { ErrorState, Modal, Spinner } from '../../components/ui';
import { PERMISSION_LABELS } from '../../lib/format';
import { toast } from '../../stores/ui';
import { MODULE_LEVEL } from './peopleData';

/** One person's change in plain words: "They will lose Edit on Documents (keeps View)". */
export function impactLines(p: PersonImpact, they = 'They'): string[] {
  if (p.losesWorkspace) return [`${they} will lose access to this workspace.`];
  const lines = p.modules.map((m) => m.to < m.from
    ? `${they} will lose ${MODULE_LEVEL[m.from]} on ${m.label}${m.to > 0 ? ` (keeps ${MODULE_LEVEL[m.to]})` : ''}.`
    : `${they} will gain ${MODULE_LEVEL[m.to]} on ${m.label}.`);
  const named = (keys: string[]) => keys.map((k) => PERMISSION_LABELS[k] ?? k).join(', ');
  if (p.lost.length) lines.push(`${they} will no longer be able to: ${named(p.lost)}.`);
  if (p.gained.length) lines.push(`${they} will be able to: ${named(p.gained)}.`);
  return lines;
}

/**
 * A change with its consequences shown before anything is saved: the server works out who gains and loses what (a dry run with the same
 * rules it enforces), the person confirms, and only then is the change made. A change the server would refuse (the last Admin) cannot be confirmed.
 */
export function ImpactDialog({ title, request, children, extra, confirmText = 'Confirm', danger, ready = true, onConfirm, onClose }: {
  title: string; request: ImpactRequest | null; children?: ReactNode; extra?: ReactNode; confirmText?: string; danger?: boolean;
  /** False while the form above has no valid choice yet. */
  ready?: boolean;
  onConfirm: () => Promise<unknown>; onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const preview = useQuery({
    queryKey: ['people-impact', request], queryFn: () => workspaceApi.impact(request!), enabled: !!request && ready, retry: false, staleTime: 0,
  });
  const p = preview.data;
  const go = async () => {
    setBusy(true);
    try { await onConfirm(); onClose(); }
    catch (e) { toast(e instanceof ApiError ? e.message : 'That change could not be saved.', 'error'); }
    finally { setBusy(false); }
  };
  const blocked = !!p?.blocked;

  return (
    <Modal title={title} onClose={onClose} size="sm"
      footer={<>
        <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button type="button" className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} data-testid="impact-confirm"
          disabled={busy || !ready || (!!request && (preview.isLoading || preview.isError)) || blocked} onClick={() => void go()}>
          {busy ? <Spinner /> : confirmText}
        </button>
      </>}>
      {children}
      <section className="pr-impact" aria-live="polite" data-testid="impact-preview">
        <h4><Icon name="eye" size={14} /> What will change</h4>
        {!request || !ready ? <p className="muted">Choose an option to see what changes.</p>
          : preview.isLoading ? <div className="pr-impact-loading"><Spinner /> Working out who is affected…</div>
          : preview.isError ? <ErrorState error={preview.error} retry={() => preview.refetch()} />
          : p && (
            <>
              {p.people.length === 0 && <p className="muted" data-testid="impact-none">Nobody gains or loses access.</p>}
              {p.people.map((x) => (
                <div key={x.userId} className="pr-impact-person">
                  <b>{x.name}</b>
                  <ul>{impactLines(x).map((l, i) => <li key={i} className={/lose|no longer/.test(l) ? 'lose' : 'gain'}>{l}</li>)}</ul>
                </div>
              ))}
              {p.warnings.map((w, i) => <p key={i} className={`pr-impact-warn${p.blocked ? ' blocked' : ''}`}><Icon name="alert" size={14} />{w}</p>)}
            </>
          )}
        {extra}
      </section>
    </Modal>
  );
}

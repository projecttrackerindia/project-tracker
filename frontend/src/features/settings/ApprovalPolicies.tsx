import { useEffect, useState } from 'react';
import { ApiError } from '../../api/client';
import { CalmCard } from '../../components/calm';
import { useWsQuery } from '../../lib/hooks';
import { useMembers } from '../people/peopleData';
import { toast } from '../../stores/ui';
import { approvalsApi, TYPES, type ApprovalPolicy, type ChainStepInput } from '../approvals/api';

const ROLES = ['Manager', 'Team lead', 'Admin', 'Owner'];

/** Approval policies (shot 56b): who signs off each kind of request, in order. Saves each type as it changes (Approvals API, #123). */
export function ApprovalPoliciesPane() {
  const q = useWsQuery(['approvals', 'policies'], approvalsApi.policies, { retry: false });
  const members = useMembers();
  const [draft, setDraft] = useState<ApprovalPolicy[]>([]);
  const [saved, setSaved] = useState(false);
  useEffect(() => { if (q.data) setDraft(q.data); }, [q.data]);

  const setSteps = async (p: ApprovalPolicy, steps: ChainStepInput[]) => {
    const prev = draft;
    setDraft((d) => d.map((x) => (x.type === p.type ? { ...x, steps, custom: true } : x))); setSaved(false);   // optimistic
    try { await approvalsApi.savePolicy(p.type, steps, p.expiryHours); setSaved(true); }
    catch (e) { setDraft(prev); toast(e instanceof ApiError ? e.errors[0]?.message ?? e.message : 'Could not save the policy.', 'error'); }
  };
  const name = (s: ChainStepInput) => (s.userId ? members.data?.find((m) => m.userId === s.userId)?.displayName ?? s.role : s.role);
  const label = (t: string) => TYPES.find((x) => x.id === t)?.label ?? t;

  return (
    <div className="cs-pane" data-testid="approval-policies">
      <header className="cs-head"><h1>Approval policies.<em>Who signs off, in order.</em></h1>{saved && <span className="cs-saved">✓ Saved</span>}</header>
      {q.isError && <CalmCard><p className="cs-note">The approval policies could not be loaded.</p></CalmCard>}
      {draft.map((p) => (
        <CalmCard key={p.type} className="cs-policy" title={label(p.type)} aside={p.custom ? 'Custom' : 'Default'}>
          <ol className="cs-chain">
            {p.steps.length === 0 && <li className="cs-note">No approval needed</li>}
            {p.steps.map((s, i) => (
              <li key={`${i}-${s.role}-${s.userId ?? ''}`}>
                <span className="cs-step">{i + 1}</span>{name(s)}
                <button type="button" className="cs-x" aria-label={`Remove ${name(s)}`} onClick={() => void setSteps(p, p.steps.filter((_, j) => j !== i))}>×</button>
              </li>
            ))}
          </ol>
          <label className="cs-add">
            <span className="sr-only">Add an approver for {label(p.type)}</span>
            <select value="" onChange={(e) => {
              const v = e.target.value; if (!v) return;
              const m = v.startsWith('person:') ? members.data?.find((x) => x.userId === v.slice(7)) : null;
              void setSteps(p, [...p.steps, m ? { role: m.displayName, userId: m.userId } : { role: v.slice(5) }]);
            }}>
              <option value="">+ Add a step</option>
              <optgroup label="By role">{ROLES.map((r) => <option key={r} value={`role:${r}`}>{r}</option>)}</optgroup>
              <optgroup label="A person">{(members.data ?? []).map((m) => <option key={m.userId} value={`person:${m.userId}`}>{m.displayName}</option>)}</optgroup>
            </select>
          </label>
        </CalmCard>
      ))}
    </div>
  );
}

import { useEffect, useState } from 'react';
import { ApiError, get, put } from '../../api/client';
import { CalmCard } from '../../components/calm';
import { useWsQuery } from '../../lib/hooks';
import { useMembers } from '../people/peopleData';
import { toast } from '../../stores/ui';

/**
 * Approval policies (shot 56b). The Approvals API is built in parallel (calm-flow); until it lands on calm-theme this pane is behind a flag
 * (VITE_APPROVAL_POLICIES=1, or localStorage "pt.flag.approvalPolicies" = "1") and speaks the agreed shape:
 *   GET/PUT /api/v1/approvals/policies → [{ type, steps: [{ role | personId, order }] }]
 */
export type ApprovalStep = { role?: string; personId?: string; order: number };
export type ApprovalPolicy = { type: string; steps: ApprovalStep[] };

export function approvalPoliciesEnabled() {
  if (import.meta.env.VITE_APPROVAL_POLICIES === '1') return true;
  try { return localStorage.getItem('pt.flag.approvalPolicies') === '1'; } catch { return false; }
}

const TYPES: { type: string; label: string; sub: string }[] = [
  { type: 'leave', label: 'Leave', sub: 'Time off and work from home' },
  { type: 'deploy', label: 'Deploy to production', sub: 'Release requests' },
  { type: 'expense', label: 'Expenses', sub: 'Claims and purchases' },
  { type: 'document', label: 'Documents', sub: 'Publishing to the library' },
  { type: 'access', label: 'Access', sub: 'Vault and permission requests' },
];
const ROLES = ['Manager', 'Team lead', 'Admin', 'Owner'];

export function ApprovalPoliciesPane() {
  const q = useWsQuery(['approvals', 'policies'], () => get<ApprovalPolicy[]>('/approvals/policies'), { retry: false });
  const members = useMembers();
  const [draft, setDraft] = useState<ApprovalPolicy[]>([]);
  const [saved, setSaved] = useState(false);
  useEffect(() => { if (q.data) setDraft(q.data); }, [q.data]);
  const missing = q.error instanceof ApiError && q.error.status === 404;

  const policy = (type: string) => draft.find((p) => p.type === type) ?? { type, steps: [] };
  const save = async (next: ApprovalPolicy[]) => {
    const prev = draft;
    setDraft(next); setSaved(false);   // optimistic
    try { await put('/approvals/policies', next); setSaved(true); }
    catch (e) { setDraft(prev); toast(e instanceof ApiError ? e.message : 'Could not save the policy.', 'error'); }
  };
  const setSteps = (type: string, steps: ApprovalStep[]) =>
    void save([...draft.filter((p) => p.type !== type), { type, steps: steps.map((s, i) => ({ ...s, order: i + 1 })) }]);
  const name = (s: ApprovalStep) => s.role ?? members.data?.find((m) => m.userId === s.personId)?.displayName ?? 'Someone';

  return (
    <div className="cs-pane" data-testid="approval-policies">
      <header className="cs-head"><h1>Approval policies.<em>Who signs off, in order.</em></h1>{saved && <span className="cs-saved">✓ Saved</span>}</header>
      {missing && <CalmCard><p className="cs-note">Approval policies switch on when the Approvals service is available in this workspace.</p></CalmCard>}
      {!missing && TYPES.map((t) => {
        const steps = [...policy(t.type).steps].sort((a, b) => a.order - b.order);
        return (
          <CalmCard key={t.type} className="cs-policy" title={t.label} aside={t.sub}>
            <ol className="cs-chain">
              {steps.length === 0 && <li className="cs-note">No approval needed</li>}
              {steps.map((s, i) => (
                <li key={`${i}-${s.role ?? s.personId}`}>
                  <span className="cs-step">{i + 1}</span>{name(s)}
                  <button type="button" className="cs-x" aria-label={`Remove ${name(s)}`} onClick={() => setSteps(t.type, steps.filter((_, j) => j !== i))}>×</button>
                </li>
              ))}
            </ol>
            <label className="cs-add">
              <span className="sr-only">Add an approver for {t.label}</span>
              <select value="" onChange={(e) => {
                const v = e.target.value; if (!v) return;
                setSteps(t.type, [...steps, v.startsWith('role:') ? { role: v.slice(5), order: 0 } : { personId: v.slice(7), order: 0 }]);
              }}>
                <option value="">+ Add a step</option>
                <optgroup label="By role">{ROLES.map((r) => <option key={r} value={`role:${r}`}>{r}</option>)}</optgroup>
                <optgroup label="A person">{(members.data ?? []).map((m) => <option key={m.userId} value={`person:${m.userId}`}>{m.displayName}</option>)}</optgroup>
              </select>
            </label>
          </CalmCard>
        );
      })}
    </div>
  );
}

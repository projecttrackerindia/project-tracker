import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Select } from '../../components/Select';
import { ApiError } from '../../api/client';
import { attachmentApi } from '../../api/endpoints';
import { projectApi } from '../../api/endpoints';
import { workspaceApi } from '../../api/endpoints';
import { CalmAvatar, CalmGo, CalmLink, CalmSheet } from '../../components/calm';
import { CalmPicker, type PickItem } from '../../components/calm/CalmPicker';
import { insightApi } from '../../api/endpoints.projects';
import { Icon } from '../../components/Icon';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { approvalsApi, TYPES, typeOf, type ApprovalLink, type ApprovalType, type ChainStepInput } from './api';
import type { ApprovalDraft } from './host';
import { TypeIcon } from './TypeIcon';
import './approvals.css';

function toLink(it: PickItem): ApprovalLink {
  const [kind, ...rest] = it.id.split(':'); const id = rest.join(':');
  if (kind === 'text') return { kind: 'item', label: it.label };
  const href = kind === 'project' ? `/projects/${id}` : null;
  return { kind, label: it.label, id, href };
}

const fmtDay = (iso?: string) => (iso ? new Date(`${iso}T00:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) : '');

/** A sensible title from the type's own fields, so the person never has to write one ("payments-api 2.4.0 to Production"). */
function titleFor(type: ApprovalType, p: Record<string, string>): string {
  const v = (k: string) => p[k]?.trim() ?? '';
  switch (type) {
    case 'Deployment': return [v('service') || 'Deploy', v('version'), v('environment') && `to ${v('environment').split('·')[0].trim()}`].filter(Boolean).join(' ');
    case 'ConfigChange': return v('setting') ? `${v('setting')}${v('to') ? ` to ${v('to')}` : ''}` : 'Configuration change';
    case 'ChangeRequest': return v('change') || 'Change request';
    case 'Incident': return v('fix') || v('incident') || 'Incident fix';
    case 'AttendanceCorrection': return `Attendance correction${v('day') ? ` · ${fmtDay(v('day'))}` : ''}`;
    case 'Leave': return `Leave${v('from') ? ` · ${fmtDay(v('from'))}${v('to') && v('to') !== v('from') ? ` – ${fmtDay(v('to'))}` : ''}` : ''}`;
    case 'Access': return v('resource') ? `${v('level') || 'Access'} access to ${v('resource')}` : 'Access request';
    case 'Expense': return [v('vendor') || 'Expense', v('amount')].filter(Boolean).join(' · ');
  }
}

function riskFor(type: ApprovalType, p: Record<string, string>): 'Low' | 'Medium' | 'High' {
  if (type === 'Incident') return 'High';
  if (type === 'Deployment') return /prod/i.test(p.environment ?? '') ? 'High' : 'Medium';
  if (type === 'ConfigChange' || type === 'Expense') return 'Medium';
  return 'Low';
}

/** Working days between two dates (Mon–Fri), for the leave line "3 working days". */
function workingDays(from?: string, to?: string) {
  if (!from) return 0;
  const a = new Date(`${from}T00:00:00`), b = new Date(`${to || from}T00:00:00`);
  let n = 0;
  for (let d = new Date(a); d <= b && n < 400; d.setDate(d.getDate() + 1)) if (d.getDay() % 6 !== 0) n++;
  return n;
}

/**
 * "Request approval": the type picker, the type's own fields on the left, and on the right the suggested chain (from the workspace's
 * policy, Settings › Approvals), an attachment and linked items. Approvers are told in Approvals and by e-mail.
 */
export function RequestSheet({ open, draft, onClose }: { open: boolean; draft: ApprovalDraft; onClose: () => void }) {
  return (
    <CalmSheet open={open} onClose={onClose} title="Request approval" width={840} label="Request approval">
      {open && <RequestForm key={JSON.stringify(draft)} draft={draft} onDone={onClose} />}
    </CalmSheet>
  );
}

function RequestForm({ draft, onDone }: { draft: ApprovalDraft; onDone: () => void }) {
  const wid = useWorkspaceId();
  const [type, setType] = useState<ApprovalType>(draft.type ?? 'Deployment');
  const [payload, setPayload] = useState<Record<string, string>>(draft.payload ?? {});
  const [links, setLinks] = useState<ApprovalLink[]>(draft.links ?? []);
  const [editChain, setEditChain] = useState(false);
  const [chain, setChain] = useState<ChainStepInput[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [project, setProject] = useState('');
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const t = typeOf(type);
  const preview = useWsQuery(['approvals', 'chain', type], () => approvalsApi.chain(type), { staleTime: 60_000 });
  const members = useWsQuery(['members'], () => workspaceApi.members(), { staleTime: 300_000, enabled: editChain });
  const projects = useWsQuery(['projects', 'pick'], () => projectApi.list({ pageSize: 100 }), { staleTime: 300_000 });
  const people = useMemo<PickItem[]>(() => (members.data ?? []).map((m) => ({ id: m.userId, label: m.displayName, sub: m.role ?? null })), [members.data]);
  const linkTop = useMemo<PickItem[]>(() => (projects.data?.items ?? []).slice(0, 4).map((p) => ({ id: `project:${p.id}`, label: p.name, sub: 'Project', dot: null })), [projects.data]);
  const searchLinks = async (q: string): Promise<PickItem[]> => {
    if (q.length < 2) return linkTop;
    const hits = await insightApi.search(q).then((r) => r.hits).catch(() => []);
    const found: PickItem[] = hits.slice(0, 12).map((h) => ({ id: `${h.type.toLowerCase()}:${h.id}`, label: h.title, sub: h.subtitle ?? h.type, keywords: q }));
    return [...found, { id: `text:${q}`, label: q, sub: 'Link as text', keywords: q }];
  };
  useEffect(() => { setChain(null); setEditChain(false); }, [type]);

  const steps = chain ?? preview.data?.steps.map((s) => ({ role: s.role, userId: s.approver.id })) ?? [];
  const names = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of preview.data?.steps ?? []) m.set(s.approver.id, s.approver.name);
    for (const x of members.data ?? []) m.set(x.userId, x.displayName);
    return m;
  }, [preview.data, members.data]);
  const set = (k: string, v: string) => setPayload((p) => ({ ...p, [k]: v }));
  const days = type === 'Leave' ? workingDays(payload.from, payload.to) : 0;

  const upload = async (file: File) => {
    if (!project) { toast('Choose the project the file belongs to first.', 'error'); return; }
    setUploading(true);
    try {
      const a = await attachmentApi.upload(project, file);
      setLinks((l) => [...l, { kind: 'file', label: a.fileName, id: a.id, href: `/projects/${project}?tab=files` }]);
    } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not upload the file.', 'error'); }
    finally { setUploading(false); }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const missing = t.fields.find((f) => !f.long && f.key !== 'to' && f.key !== 'cover' && !payload[f.key]?.trim());
    if (missing) { toast(`Add the ${missing.label.toLowerCase()}.`, 'error'); return; }
    setBusy(true);
    try {
      const made = await approvalsApi.create({
        type, title: draft.title ?? titleFor(type, payload), summary: draft.summary ?? null, payload, risk: riskFor(type, payload),
        impact: type === 'Deployment' ? payload.window || null : type === 'Incident' ? payload.impact || null : null,
        links, chain: chain ? chain.filter((s) => s.role.trim()) : null,
      });
      void invalidateWorkspace(wid, 'approvals');
      toast(`Sent to ${made.steps[0]?.approver.name ?? 'the approvers'}.`, 'success');
      onDone();
    } catch (err) { toast(err instanceof ApiError ? err.errors[0]?.message ?? err.message : 'Could not send the request.', 'error'); }
    finally { setBusy(false); }
  };

  return (
    <form className="apq" onSubmit={submit}>
      <div className="apq-lab">Type</div>
      <div className="apq-types" role="radiogroup" aria-label="Request type">
        {TYPES.map((x) => (
          <button key={x.id} type="button" role="radio" aria-checked={x.id === type} className={x.id === type ? 'on' : ''} onClick={() => setType(x.id)}>
            <TypeIcon type={x.id} size={15} />{x.label}
          </button>
        ))}
      </div>
      <div className="apq-grid">
        <div className="apq-col">
          {t.fields.map((f) => (
            <label key={f.key} className="apq-field">
              <span>{f.label}{f.key === 'to' && days > 0 ? ` · ${days} working day${days === 1 ? '' : 's'}` : ''}</span>
              {f.long
                ? <textarea value={payload[f.key] ?? ''} onChange={(e) => set(f.key, e.target.value)} placeholder={f.placeholder} rows={3} maxLength={1000} />
                : <input type={f.kind === 'date' ? 'date' : 'text'} value={payload[f.key] ?? ''} onChange={(e) => set(f.key, e.target.value)} placeholder={f.placeholder} maxLength={300} />}
            </label>
          ))}
        </div>
        <div className="apq-col">
          <div className="apq-lab">Approvers · suggested chain</div>
          {!editChain ? (
            <div className="ap-chain" aria-label="Approval chain">
              {steps.map((s, i) => (
                <ChainCell key={`${s.role}-${i}`} last={i === steps.length - 1} role={s.role} name={s.userId ? names.get(s.userId) ?? '' : 'Chosen when sent'} userId={s.userId} state="w" note="Will be asked" />
              ))}
              {preview.isLoading && <span className="ap-chain-wait">Finding approvers…</span>}
            </div>
          ) : (
            <div className="apq-edit">
              {steps.map((s, i) => (
                <div key={i} className="apq-edit-row">
                  <input aria-label={`Step ${i + 1} role`} value={s.role} maxLength={60} onChange={(e) => setChain(steps.map((x, j) => (j === i ? { ...x, role: e.target.value } : x)))} />
                  <CalmPicker label={`Step ${i + 1} approver`} testId={`apq-approver-${i}`} recentKey="approver" limit={4} placeholder="By role" allowClear
                    items={people} value={s.userId ?? null} onChange={(id) => setChain(steps.map((x, j) => (j === i ? { ...x, userId: id } : x)))} />
                  <button type="button" className="apq-x" aria-label={`Remove step ${i + 1}`} onClick={() => setChain(steps.filter((_, j) => j !== i))}><Icon name="close" size={12} /></button>
                </div>
              ))}
              {steps.length < 6 && <button type="button" className="ap-lk" onClick={() => setChain([...steps, { role: 'Approver', userId: null }])}>+ Add a step</button>}
            </div>
          )}
          <p className="apq-rule">
            {preview.data?.rule ?? 'Based on your team and the request type.'}{' '}
            <button type="button" className="ap-lk bl" onClick={() => setEditChain((v) => !v)}>{editChain ? 'Done' : 'Edit chain'}</button>
          </p>

          <div className="apq-lab">Attachment</div>
          <div className="apq-drop" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) void upload(f); }}>
            <Icon name="paperclip" size={16} />
            <span>{uploading ? 'Uploading…' : <>Drop a file or <button type="button" className="ap-lk bl" onClick={() => fileRef.current?.click()}>choose</button></>}</span>
            <small>{t.hint}</small>
            <Select aria-label="Project the file belongs to" value={project} onChange={(e) => setProject(e.target.value)}>
              <option value="">Keep it on project…</option>
              {(projects.data?.items ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
            <input ref={fileRef} type="file" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ''; }} />
          </div>

          <div className="apq-lab">Linked</div>
          <div className="apq-links">
            {links.map((l, i) => (
              <span key={`${l.label}-${i}`} className="ap-tag">{l.kind === 'file' && <Icon name="paperclip" size={11} />}{l.label}
                <button type="button" aria-label={`Remove ${l.label}`} onClick={() => setLinks(links.filter((_, j) => j !== i))}><Icon name="close" size={10} /></button>
              </span>
            ))}
            <CalmPicker label="Link an item" testId="apq-link" className="apq-link-pick" placeholder="+ Link" recentKey="approval-link" limit={4} value={null}
              items={linkTop} search={searchLinks} empty="Type a PR, ticket or task to link it."
              onChange={(_, it) => { if (it && !links.some((l) => l.label === it.label)) setLinks([...links, toLink(it)]); }} />
          </div>
        </div>
      </div>
      <div className="apq-foot">
        <CalmGo type="submit" disabled={busy}>{busy ? 'Sending…' : 'Send request'}</CalmGo>
        <CalmLink onClick={onDone}>Cancel</CalmLink>
        <span className="apq-note">Approvers are notified in Approvals and by email</span>
      </div>
    </form>
  );
}

/** One approver in a chain: avatar, role, name and where they stand. `state`: d done, n your turn / current, w waiting, r rejected. */
export function ChainCell({ role, name, userId, state, note, last }: { role: string; name: string; userId?: string | null; state: 'd' | 'n' | 'w' | 'r'; note: string; last?: boolean }) {
  return (
    <>
      <div className={`ap-cst ${state}`}>
        <CalmAvatar userId={userId} name={name} />
        <div><b>{role}</b><small>{name}{name ? ' · ' : ''}{note}</small></div>
      </div>
      {!last && <i className="ap-cln" aria-hidden="true" />}
    </>
  );
}

import { create, get, post, put } from '../../api/client';

export type ApprovalType = 'Deployment' | 'ConfigChange' | 'ChangeRequest' | 'Incident' | 'AttendanceCorrection' | 'Leave' | 'Access' | 'Expense';
export type ApprovalStatus = 'Pending' | 'Approved' | 'Rejected' | 'Withdrawn' | 'Expired';
export type ApprovalView = 'needs' | 'mine' | 'all' | 'history';
interface UserRef { id: string; name: string }

export interface ApprovalLink { kind: string; label: string; id?: string | null; href?: string | null }
export interface ApprovalStep { order: number; role: string; approver: UserRef; status: 'Waiting' | 'Pending' | 'Approved' | 'Rejected' | 'Skipped'; decidedAt: string | null; comment: string | null }
export interface ApprovalEvent { id: string; user: UserRef | null; action: 'Requested' | 'Approved' | 'Rejected' | 'Commented' | 'Withdrawn' | 'Expired'; step: number | null; comment: string | null; at: string }
export interface Approval {
  id: string; type: ApprovalType; title: string; summary: string | null; payload: Record<string, string>; risk: 'Low' | 'Medium' | 'High'; impact: string | null;
  links: ApprovalLink[]; requester: UserRef; status: ApprovalStatus; currentStep: number; steps: ApprovalStep[]; needsMe: boolean; mine: boolean;
  createdAt: string; expiresAt: string | null; decidedAt: string | null; outcome: string | null; events?: ApprovalEvent[] | null;
}
export interface ApprovalList {
  items: Approval[]; counts: { needsMe: number; mine: number; all: number; history: number };
  week: { approved: number; rejected: number; expired: number; medianMinutes: number | null };
  byType: Record<string, number>; expiringToday: number; elsewhere: { kind: string; label: string; count: number; href: string }[];
}
export interface ChainStepInput { role: string; userId?: string | null }
export interface ChainPreview { type: ApprovalType; steps: ApprovalStep[]; rule: string; custom: boolean }
export interface ApprovalPolicy { type: ApprovalType; steps: ChainStepInput[]; expiryHours: number | null; custom: boolean }
export interface NewApproval {
  type: ApprovalType; title: string; summary?: string | null; payload?: Record<string, string>; risk?: string; impact?: string | null;
  links?: ApprovalLink[]; chain?: ChainStepInput[] | null; expiresInHours?: number | null;
}
export type DecideAction = 'approve' | 'reject' | 'comment' | 'withdraw' | 'remind';

export const approvalsApi = {
  list: (view: ApprovalView, type?: string) => get<ApprovalList>('/approvals', { view, type: type || undefined }),
  counts: () => get<{ needsMe: number }>('/approvals/counts'),
  get: (id: string) => get<Approval>(`/approvals/${id}`),
  create: (b: NewApproval) => create<Approval>('/approvals', b),
  decide: (id: string, action: DecideAction, comment?: string | null) => post<Approval>(`/approvals/${id}/decide`, { action, comment: comment || null }),
  chain: (type: ApprovalType) => get<ChainPreview>('/approvals/chain', { type }),
  /** Settings › Approvals (the workspace's default chain per type). */
  policies: () => get<ApprovalPolicy[]>('/approvals/policies'),
  savePolicy: (type: ApprovalType, steps: ChainStepInput[], expiryHours?: number | null) => put<ApprovalPolicy>(`/approvals/policies/${type}`, { steps, expiryHours: expiryHours ?? null }),
};

/** The type's label, the icon path (24px stroke icons, as in the design) and the fields its request sheet asks for. */
export interface TypeField { key: string; label: string; placeholder: string; long?: boolean; kind?: 'date' | 'text' }
export const TYPES: { id: ApprovalType; label: string; icon: string; fields: TypeField[]; hint: string }[] = [
  { id: 'Deployment', label: 'Deployment', hint: 'Release notes, test report', icon: '<path d="M12 3c3 2 5 5.5 5 9.5L15 15H9l-2-2.5C7 8.5 9 5 12 3zM9 15l-2 4 3-1M15 15l2 4-3-1"/><circle cx="12" cy="9.5" r="1.6"/>',
    fields: [{ key: 'service', label: 'Service', placeholder: 'payments-api' }, { key: 'environment', label: 'Environment', placeholder: 'Production · ap-south-1' }, { key: 'version', label: 'Version', placeholder: '2.4.0' },
      { key: 'window', label: 'Window', placeholder: 'Today 15:00 – 15:30' }, { key: 'rollback', label: 'Rollback plan', placeholder: 'Re-deploy the previous version', long: true }] },
  { id: 'ConfigChange', label: 'Configuration change', hint: 'Diff or screenshot', icon: '<path d="M5 7h9M18 7h1M5 17h3M12 17h7"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
    fields: [{ key: 'setting', label: 'Setting', placeholder: 'Webhook timeout' }, { key: 'from', label: 'From', placeholder: '5s' }, { key: 'to', label: 'To', placeholder: '8s' },
      { key: 'environment', label: 'Environment', placeholder: 'staging → prod' }, { key: 'reason', label: 'Why', placeholder: 'Contoso retries time out', long: true }] },
  { id: 'ChangeRequest', label: 'Change request', hint: 'Optional', icon: '<path d="M5 8h12l-3-3M19 16H7l3 3"/>',
    fields: [{ key: 'change', label: 'Change', placeholder: 'Freeze main at 14:30' }, { key: 'scope', label: 'Scope', placeholder: 'Release 2.4' }, { key: 'reason', label: 'Why', placeholder: 'Cut is at 15:00', long: true }] },
  { id: 'Incident', label: 'Incident', hint: 'Logs, timeline', icon: '<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17h.01"/>',
    fields: [{ key: 'incident', label: 'Incident', placeholder: 'INC-219' }, { key: 'fix', label: 'Fix', placeholder: 'Hotfix for refund double-post' }, { key: 'impact', label: 'Customer impact', placeholder: 'Refunds posted twice', long: true }] },
  { id: 'AttendanceCorrection', label: 'Attendance correction', hint: 'Optional', icon: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    fields: [{ key: 'day', label: 'Day', placeholder: '', kind: 'date' }, { key: 'correction', label: 'Correction', placeholder: 'Check-in 09:05 (was missing)' }, { key: 'reason', label: 'Reason', placeholder: 'Badge reader offline', long: true }] },
  { id: 'Leave', label: 'Leave', hint: 'Optional', icon: '<path d="M4 20h16M12 20V9M7 9c0-3 2.2-5 5-5s5 2 5 5z"/>',
    fields: [{ key: 'from', label: 'From', placeholder: '', kind: 'date' }, { key: 'to', label: 'To', placeholder: '', kind: 'date' }, { key: 'kind', label: 'Type', placeholder: 'Annual leave' },
      { key: 'cover', label: 'Cover', placeholder: 'Who covers for you' }, { key: 'note', label: 'Note', placeholder: 'Family visit', long: true }] },
  { id: 'Access', label: 'Access request', hint: 'Optional', icon: '<circle cx="8" cy="14" r="4"/><path d="M11 11l8-8M16 6l2 2M14 8l2 2"/>',
    fields: [{ key: 'resource', label: 'Resource', placeholder: 'Helix warehouse' }, { key: 'level', label: 'Access', placeholder: 'Read' }, { key: 'duration', label: 'For how long', placeholder: '7 days' }, { key: 'reason', label: 'Why', placeholder: 'Backfill checks', long: true }] },
  { id: 'Expense', label: 'Expense', hint: 'Receipt or quote', icon: '<rect x="3.5" y="6" width="17" height="12" rx="2.5"/><path d="M3.5 10h17M7 14.5h3"/>',
    fields: [{ key: 'amount', label: 'Amount', placeholder: '₹12,400' }, { key: 'vendor', label: 'Vendor', placeholder: 'Design tool' }, { key: 'reason', label: 'Why', placeholder: 'Two more seats', long: true }] },
];
export const typeOf = (t: string) => TYPES.find((x) => x.id === t) ?? TYPES[2];

import { ApiError, del, get, post, put, uploadFile } from '../../api/client';

export interface VoiceSettings {
  enabled: boolean; agentName: string; companyName: string; languages: string[]; knowledge: string | null; requireVerification: boolean; verificationRule: string;
  transferNumber: string | null; workTypeId: string | null; storageKeyPattern: string; archiveConfigured: boolean; canManage: boolean; availableLanguages: Record<string, string>; speechConfigured?: boolean;
}

export type InputType = 'text' | 'digits' | 'date' | 'phone' | 'email' | 'last4';
export interface FlowInput { name: string; label: string; type: InputType; required: boolean; example?: string | null }
export interface FlowHeader { name: string; value: string }
export type StepType = 'verify' | 'branch' | 'chain';
export interface FlowStep {
  type: StepType; label?: string | null;
  path?: string | null; input?: string | null; compare?: 'exact' | 'digits' | 'last4' | 'date' | null;
  op?: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'empty' | 'notempty' | null; value?: string | null;
  action?: 'say' | 'ticket' | 'transfer' | 'stop' | null; text?: string | null; priority?: string | null;
  connector?: string | null; as?: string | null; args?: Record<string, string>;
}
export type FieldFormat = 'text' | 'inr' | 'number' | 'date' | 'datetime' | 'mask4' | 'yesno' | 'percent';
export interface FlowField { key: string; path: string; format: FieldFormat; label?: string | null }
export interface VoiceFlow {
  v: number; inputs: FlowInput[]; headers: FlowHeader[]; bodyTemplate?: string | null; requiresVerifiedCaller: boolean;
  steps: FlowStep[]; fields: FlowField[]; templates: Record<string, string>; samples: Record<string, string>;
}
export interface Connector {
  id: string; name: string; description: string; method: string; urlTemplate: string; headerName: string | null; hasSecret: boolean; enabled: boolean;
  placeholders: string[]; flow?: VoiceFlow | null; updatedAt?: string | null;
}
export interface ConnectorDraft { name: string; description: string; method: string; urlTemplate: string; headerName: string | null; secret?: string; enabled: boolean; flow: VoiceFlow | null }
export interface TraceRow { step: string; status: string; detail: string }
export interface ToolTest {
  ok: boolean; trace: TraceRow[]; raw: Record<string, string>; facts: Record<string, string>; say: string | null; action: string; actionText: string | null;
  verifiedNow: boolean | null; agentSees: string; error: string | null;
}
export interface Turn { role: 'agent' | 'caller' | 'tool'; text: string; at: string; tool?: string | null }
export interface Call {
  id: string; channel: string; direction: string; callerNumber: string | null; language: string; status: string; startedAt: string; endedAt: string | null; turns: Turn[];
  summary: string | null; workTaskId: string | null; ticketKey: string | null; verified: boolean; transferred: boolean; archiveKey: string | null;
}
export interface Reply { call: Call; say: string; ended: boolean; audio?: string | null; heard?: string | null; audioParts?: string[] | null; fillers?: { kind: 'ack' | 'hold'; audio: string }[] | null }
export interface CallItem { id: string; channel: string; callerNumber: string | null; language: string; status: string; startedAt: string; endedAt: string | null; summary: string | null; ticketKey: string | null; transferred: boolean }

export const voiceApi = {
  settings: () => get<VoiceSettings>('/voice/settings'),
  save: (b: Omit<VoiceSettings, 'archiveConfigured' | 'canManage' | 'availableLanguages' | 'speechConfigured'>) => put<VoiceSettings>('/voice/settings', b),
  connectors: () => get<Connector[]>('/voice/connectors'),
  saveConnector: (b: ConnectorDraft, id?: string) => (id ? put<Connector>(`/voice/connectors/${id}`, b) : post<Connector>('/voice/connectors', b)),
  testConnector: (b: { draft: ConnectorDraft; inputs: Record<string, string>; language: string; useSamples: boolean; callerVerified: boolean }, id?: string) =>
    post<ToolTest>(id ? `/voice/connectors/${id}/test` : '/voice/connectors/test', b),
  removeConnector: (id: string) => del(`/voice/connectors/${id}`),
  calls: () => get<CallItem[]>('/voice/calls'),
  call: (id: string) => get<Call>(`/voice/calls/${id}`),
  start: (b: { callerNumber?: string; language?: string; speak?: boolean }) => post<Reply>('/voice/calls/test', b),
  say: (id: string, text: string, speak = false) => post<Reply>(`/voice/calls/${id}/say`, { text, speak }),
  listen: (id: string, audio: File) => uploadFile<Reply>(`/voice/calls/${id}/listen`, audio),
  end: (id: string) => post<Call>(`/voice/calls/${id}/end`, {}),
};

export const errText = (e: unknown, f: string) => (e instanceof ApiError ? e.errors[0]?.message ?? e.message : f);

export const emptyFlow = (): VoiceFlow => ({ v: 1, inputs: [], headers: [], bodyTemplate: null, requiresVerifiedCaller: false, steps: [], fields: [], templates: {}, samples: {} });

/** Every value path in a sample answer ("main.loan.outstanding", "main.items[0].amount"), so paths are picked, not typed. */
export function samplePaths(alias: string, json: string | undefined, limit = 120): string[] {
  if (!json?.trim()) return [];
  let data: unknown;
  try { data = JSON.parse(json); } catch { return []; }
  const out: string[] = [];
  const walk = (v: unknown, p: string, depth: number) => {
    if (out.length >= limit || depth > 8) return;
    if (Array.isArray(v)) { if (v.length) walk(v[0], `${p}[0]`, depth + 1); return; }
    if (v && typeof v === 'object') { for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, `${p}.${k}`, depth + 1); return; }
    out.push(p);
  };
  walk(data, alias, 0);
  return out;
}

/** The value at a path in a sample, for showing next to the path picker. */
export function sampleValue(samples: Record<string, string>, path: string): string | undefined {
  const parts = path.match(/[A-Za-z0-9_-]+|\[-?\d+\]/g);
  if (!parts) return undefined;
  let node: unknown;
  try { node = JSON.parse(samples[parts[0]] ?? 'null'); } catch { return undefined; }
  for (const p of parts.slice(1)) {
    if (node == null) return undefined;
    if (p.startsWith('[')) { const arr = node as unknown[]; let i = Number(p.slice(1, -1)); if (!Array.isArray(arr)) return undefined; if (i < 0) i += arr.length; node = arr[i]; }
    else node = (node as Record<string, unknown>)[Object.keys(node as object).find((k) => k.toLowerCase() === p.toLowerCase()) ?? p];
  }
  return node === undefined ? undefined : typeof node === 'string' ? node : JSON.stringify(node);
}

/** Ready-made tools to start from: the common lending lookups. */
export const TOOL_TEMPLATES: { id: string; title: string; blurb: string; draft: () => ConnectorDraft }[] = [
  {
    id: 'loan', title: 'Loan details with identity check', blurb: 'Loan number + date of birth → balance and next EMI, only after the DOB matches.',
    draft: () => ({
      name: 'loan_details', description: 'The caller asks about their loan balance, next EMI date or amount.', method: 'GET',
      urlTemplate: 'https://api.yourcompany.in/loans/v1/{loanNumber}', headerName: 'client_id', enabled: true,
      flow: {
        ...emptyFlow(), requiresVerifiedCaller: true,
        inputs: [{ name: 'loanNumber', label: 'Loan number', type: 'digits', required: true, example: '1234567890' }, { name: 'dob', label: 'Date of birth', type: 'date', required: true, example: '12/04/1990' }],
        steps: [
          { type: 'verify', label: 'Date of birth matches', path: 'main.customer.dob', input: 'dob', compare: 'date', action: 'stop' },
          { type: 'branch', label: 'Overdue accounts', path: 'main.loan.status', op: 'eq', value: 'OVERDUE', action: 'say', text: 'I can see a payment is overdue on this loan.' },
        ],
        fields: [
          { key: 'loan', path: 'main.loan.number', format: 'mask4', label: 'loan number' },
          { key: 'balance', path: 'main.loan.outstanding', format: 'inr', label: 'outstanding balance' },
          { key: 'emiAmount', path: 'main.loan.emiAmount', format: 'inr', label: 'next EMI amount' },
          { key: 'emiDate', path: 'main.loan.nextDue', format: 'date', label: 'next EMI date' },
        ],
        templates: { en: 'For your loan {loan}, the outstanding balance is {balance}. Your next EMI of {emiAmount} is due on {emiDate}.' },
        samples: { main: JSON.stringify({ loan: { number: '1234567890', status: 'ACTIVE', outstanding: 124999.5, emiAmount: 4850, nextDue: '2026-11-05' }, customer: { name: 'Ravi Kumar', dob: '1990-04-12' } }, null, 2) },
      },
    }),
  },
  {
    id: 'payment', title: 'Payment status', blurb: 'Payment reference → whether it was received, the amount and date.',
    draft: () => ({
      name: 'payment_status', description: 'The caller wants to know whether a payment they made was received.', method: 'GET',
      urlTemplate: 'https://api.yourcompany.in/payments/v1/{reference}', headerName: 'client_id', enabled: true,
      flow: {
        ...emptyFlow(),
        inputs: [{ name: 'reference', label: 'Payment reference or UTR', type: 'text', required: true, example: '412345678901' }],
        steps: [{ type: 'branch', label: 'Not found', path: 'main.status', op: 'empty', action: 'ticket', text: 'Payment not found — check with finance', priority: 'High' }],
        fields: [
          { key: 'status', path: 'main.status', format: 'text', label: 'payment status' },
          { key: 'amount', path: 'main.amount', format: 'inr', label: 'amount' },
          { key: 'paidOn', path: 'main.receivedAt', format: 'date', label: 'date received' },
        ],
        templates: { en: 'That payment of {amount} is {status}, received on {paidOn}.' },
        samples: { main: JSON.stringify({ status: 'RECEIVED', amount: 4850, receivedAt: '2026-10-05T10:12:00Z' }, null, 2) },
      },
    }),
  },
  {
    id: 'blank', title: 'Start from scratch', blurb: 'Any API: you choose the inputs, logic and what the agent may say.',
    draft: () => ({ name: '', description: '', method: 'GET', urlTemplate: 'https://', headerName: 'client_id', enabled: true, flow: emptyFlow() }),
  },
];

import { get, put } from '../../../api/client';

export interface Trace {
  agent: string; version: string; correlationId: string; provider: string; model: string; startedAt: string;
  durationMs: number; contextMs: number; firstTokenMs: number | null; promptChars: number; toolDefinitions: number;
  outcome: string; errorCode: string | null; intent?: string | null; intentConfidence?: number | null; intentMs?: number | null;
  preparation?: { durationMs: number } | null;
  database?: { commands: number; durationMs: number; failedCommands: number } | null;
  actions?: { id: string; kind: string; status: string; durationMs: number | null; confirmationWaitMs: number | null; attempts: number }[] | null;
  models: { runtime?: { loadMs: number | null; promptEvalMs: number | null; generationMs: number | null; totalMs: number | null; queueMs?: number | null } | null; step: number; durationMs: number; inputTokens: number; outputTokens: number; stopReason: string; cacheReadTokens?: number }[];
  tools: { name: string; durationMs: number; succeeded: boolean; state: string }[];
}
export interface Run { id: string; createdAt: string; status: string; inputTokens: number; outputTokens: number; feedback: string | null; trace: Trace }
export interface Insights {
  timeline: { at: string; succeeded: number; failed: number; partial: number; awaiting: number; p50Ms: number; p95Ms: number }[];
  bucketUnit: 'hour' | 'day';
  latency: { label: string; upToMs: number; count: number }[];
  phases: { contextMs: number; routingMs: number; modelMs: number; toolMs: number; otherMs: number };
  tools: { name: string; calls: number; failures: number; averageMs: number }[];
  models: { model: string; runs: number; averageMs: number; inputTokens: number; outputTokens: number }[];
  feedbackUp: number; feedbackDown: number; cacheReadTokens: number; firstTokenP50Ms: number | null;
  actions: { kind: string; count: number; failed: number; confirmed: number }[];
}
export interface Tracker {
  agent: { id: string; name: string; version: string; enabled: boolean; provider: string; model: string; capabilities: string[]; maxToolCalls: number; timeoutSeconds: number };
  total: number; succeeded: number; failed: number; partial: number; awaitingConfirmation: number; averageMs: number; p95Ms: number;
  p50Ms: number; modelCalls: number; databaseCommands: number; inputTokens: number; outputTokens: number; sampleLimited: boolean; page: number; pageSize: number; runs: Run[];
  slowestPaths?: { intent: string; requests: number; failures: number; p50Ms: number; p95Ms: number; averageQueueMs: number | null; averageModelMs: number; averageToolMs: number }[];
  frequentErrors?: { code: string; count: number }[];
  insights?: Insights | null;
}
export interface Health { configured: boolean; reachable: boolean; modelAvailable: boolean; provider: string; model: string; queueDepth: number; errorCode: string | null; activeRequests?: number | null; maxConcurrentRequests?: number | null; maxQueuedRequests?: number | null; queueTimeoutSeconds?: number | null }
export interface Fleet {
  from: string; to: string;
  projectAgent: {
    projectsOn: number; readings: number; failedReadings: number; findings: number; approved: number; autoApplied: number; dismissed: number; pending: number; credits: number;
    averageDecisionHours: number | null; kinds: { kind: string; found: number; approved: number; dismissed: number; pending: number; auto: number }[];
    sources: { source: string; signals: number }[]; atLevel1: number; atLevel2: number; atLevel3: number; atLevel4: number;
  };
  meetings: { sessions: number; attended: number; failed: number; meetTranscripts: number; minutesSent: number; delegations: number; delegationsReported: number; captionLines: number };
  followUps: { commitments: number; kept: number; missed: number; moved: number; open: number; checkInsSent: number; answered: number; changeRequests: number };
  days: { day: string; readings: number; findings: number; decided: number; meetings: number }[];
  projects: { projectId: string; key: string; name: string; level: number; readings: number; findings: number; approved: number; dismissed: number; pending: number }[];
}

export const trackerApi = {
  list: (q: { page: number; status?: string; model?: string; intent?: string; from: string }) => get<Tracker>('/ai/tracker', q),
  fleet: (from: string) => get<Fleet>('/ai/tracker/fleet', { from }),
  health: () => get<Health>('/ai/tracker/health'),
  setEnabled: (enabled: boolean) => put('/ai/tracker/agent', { enabled }),
};

export const secs = (ms: number) => (ms >= 10_000 ? `${Math.round(ms / 1000)}s` : `${(ms / 1000).toFixed(1)}s`);
export const compact = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
export const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : null);
export const words = (s: string) => s.replaceAll('_', ' ');

/** Finding kinds, in the fixed categorical order (colour follows the kind, never its rank). */
export const KIND_ORDER = ['CreateTask', 'CreateActionItem', 'UpdateTask', 'Delay', 'Decision', 'Missed', 'Suggestion', 'CreateIssue', 'UpdateIssue'];
export const KIND_LABEL: Record<string, string> = {
  CreateTask: 'New tasks', CreateActionItem: 'Action items', UpdateTask: 'Task updates', Delay: 'Delays', Decision: 'Decisions', Missed: 'Missed points',
  Suggestion: 'Suggestions', CreateIssue: 'Tickets', UpdateIssue: 'Ticket updates',
};
export const SOURCE_LABEL: Record<string, string> = {
  ProjectMailbox: 'Project mailbox', PersonalMail: 'Members\' inboxes', Chat: 'Project chat', MeetingTranscript: 'Meet transcripts', LiveMeeting: 'Live bot',
  Manual: 'Pasted', Slack: 'Slack', WhatsApp: 'WhatsApp',
};

/** Outcome colours: the status colours, always shown with their names. */
export const STATUS = [
  { key: 'succeeded', label: 'Succeeded', color: 'var(--trk-good)' },
  { key: 'partial', label: 'Partial', color: 'var(--trk-warn)' },
  { key: 'awaiting', label: 'Awaiting approval', color: 'var(--trk-info)' },
  { key: 'failed', label: 'Failed or timed out', color: 'var(--trk-bad)' },
] as const;

export const series = (i: number) => `var(--trk-s${(i % 8) + 1})`;


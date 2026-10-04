export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const MONTHS_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const pad = (n: number) => String(n).padStart(2, '0');
export const toISODate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const todayISO = () => toISODate(new Date());
export const dateOffset = (days: number, from = new Date()) => { const d = new Date(from); d.setDate(d.getDate() + days); return toISODate(d); };
const parts = (iso: string) => iso.slice(0, 10).split('-').map(Number) as [number, number, number];

export function formatDate(iso?: string | null) {
  if (!iso) return '—';
  const [y, m, d] = parts(iso);
  return `${pad(d)} ${MONTHS[m - 1]} ${y}`;
}
export function formatDateShort(iso?: string | null) {
  if (!iso) return '—';
  const [, m, d] = parts(iso);
  return `${pad(d)} ${MONTHS[m - 1]}`;
}
export function formatDateTime(iso?: string | null) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function daysUntil(iso?: string | null) {
  if (!iso) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const [y, m, d] = parts(iso);
  return Math.round((new Date(y, m - 1, d).getTime() - today.getTime()) / 86400000);
}

/** Friendly relative due label: Today / Tomorrow / Yesterday / 3d overdue / 12 Oct. */
export function dueLabel(iso?: string | null) {
  const d = daysUntil(iso);
  if (d === null) return 'No date';
  if (d === 0) return 'Today';
  if (d === 1) return 'Tomorrow';
  if (d === -1) return 'Yesterday';
  if (d < 0) return `${Math.abs(d)}d overdue`;
  return formatDateShort(iso);
}

export function timeAgo(iso?: string | null) {
  if (!iso) return '';
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return formatDate(iso);
}

export const initials = (name?: string | null) =>
  String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';

export const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

/** "InProgress" -> "In Progress", "OnTrack" -> "On Track". */
export const labelize = (s: string) => s.replace(/([a-z])([A-Z])/g, '$1 $2');

/** The platform's default billing currency (the server sends the real one with every price; this is only the fallback). */
export const DEFAULT_CURRENCY = 'INR';

/** Whole amounts without decimals, others with two: ₹999, ₹1,199.50. Rupees use Indian digit grouping (₹1,00,000). */
export const formatMoney = (amount: number | null, currency = DEFAULT_CURRENCY) => {
  if (amount === null) return 'Custom';
  const digits = Number.isInteger(amount) ? 0 : 2;
  return new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : undefined, { style: 'currency', currency, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(amount);
};

/** Just the symbol of a currency (₹, $, €), for labelling an input. */
export const currencySymbol = (currency = DEFAULT_CURRENCY) =>
  new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : undefined, { style: 'currency', currency, maximumFractionDigits: 0 }).formatToParts(0).find((p) => p.type === 'currency')?.value ?? currency;

export const limitLabel = (n: number) => (n === -1 ? 'Unlimited' : n.toLocaleString());

export const FEATURE_LABELS: Record<string, string> = {
  PROJECT_LIMIT: 'Projects', TASK_LIMIT: 'Tasks', MAX_MEMBERS: 'Members', MAX_TEAMS: 'Teams',
  STORAGE_LIMIT_MB: 'File storage (MB)', MAX_FILE_SIZE_MB: 'Largest file (MB)',
  ACTIVITY_RETENTION_DAYS: 'Activity history (days)', ADVANCED_REPORTS: 'Advanced reports & workload',
  CUSTOM_WORKFLOWS: 'Custom task workflows', ADVANCED_PERMISSIONS: 'Advanced role permissions', AUDIT_LOG: 'Audit log',
  ADVANCED_SECURITY: 'Single sign-on, SCIM & security rules', RESOURCE_MANAGEMENT: 'Timesheet approval, capacity & budgets', SERVICE_LEVELS: 'Service levels (SLA)', REMINDER_ESCALATION: 'Reminder escalation for overdue work',
  AI_ASSISTANT: 'AI assistant', AI_MODEL_TIER: 'AI model level (1 Quick, 2 Standard, 3 Deep)', AI_MONTHLY_CREDITS: 'AI credits per month',
  AI_ATTACHMENTS: 'AI: read images & documents', AI_ACTIONS: 'AI: take actions & send reports',
  REMINDER_LIMIT: 'Open reminders per person', RECURRING_REMINDER_LIMIT: 'Repeating reminders per person',
};
export const PERMISSION_LABELS: Record<string, string> = {
  'org.manage': 'Manage organization', 'billing.manage': 'Manage billing', 'members.invite': 'Invite members', 'members.manage': 'Manage members & roles',
  'teams.manage': 'Manage teams', 'projects.create': 'Create projects', 'projects.edit': 'Edit projects', 'projects.delete': 'Delete projects',
  'workflow.manage': 'Manage workflows', 'projectgroups.manage': 'Manage project groups', 'labels.manage': 'Manage labels', 'tasks.create': 'Create tasks', 'tasks.edit': 'Edit tasks',
  'tasks.delete': 'Delete tasks', 'tasks.comment': 'Comment on tasks', 'reports.view': 'View reports', 'audit.view': 'View audit log', 'permissions.manage': 'Manage permissions', 'org.structure': 'Manage organization chart', 'access.manage': 'Manage job-role access',
};

export const PRIORITIES = ['Critical', 'High', 'Medium', 'Low'] as const;
export const PROJECT_STATUSES = ['Planning', 'Active', 'OnHold', 'Completed', 'Cancelled', 'Archived'] as const;
export const STAGE_STATUSES = ['Pending', 'InProgress', 'Completed', 'Delayed'] as const;
export const STATUS_CATEGORIES = ['Todo', 'Active', 'Done', 'Cancelled'] as const;
export const ROLES = ['Owner', 'Admin', 'Manager', 'Member', 'Guest'] as const;
export const LABEL_COLORS = ['#8b5cf6', '#38bdf8', '#34d399', '#fbbf24', '#fb7185', '#c084fc', '#f97316', '#94a3b8'];

/** "820 KB", "3.4 MB", "Unlimited" for -1. */
export function formatBytes(bytes: number) {
  if (bytes < 0) return 'Unlimited';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
  return `${value < 10 ? value.toFixed(1).replace(/\.0$/, '') : Math.round(value)} ${units[i]}`;
}

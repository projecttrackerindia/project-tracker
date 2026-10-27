import { addressOf, displayName } from '../mailbox/mailboxApi';
import type { MailMessage } from '../mailbox/mailboxApi';

/**
 * Mail's quick, local understanding of a message: tags and priority from cheap rules (no AI call per row), the natural-language search
 * parser, and the person's own mail state that has no server side yet (snoozed, archived, linked projects, drafts, scheduled sends).
 */

export type MailTag = 'needs-reply' | 'fyi' | 'invoice' | 'bank' | 'escalation';
export type MailPriority = 'high' | 'normal' | 'low';
export const TAG_LABEL: Record<MailTag, string> = { 'needs-reply': 'Needs reply', fyi: 'FYI', invoice: 'Invoice', bank: 'Bank partner', escalation: 'Escalation' };

const RE_INVOICE = /\b(invoice|bill(ing)?|payment due|proforma|gst|receipt|purchase order|remittance|statement of account)\b/i;
const RE_BANK = /\b(sbi|state bank|hdfc|icici|axis|kotak|yes ?bank|indusind|idfc|federal bank|canara|bank of baroda|pnb|union bank|bank|crif|cibil|experian|equifax|npci|nach|razorpay|cashfree|rbi)\b/i;
const RE_ESCALATE = /\b(escalat\w*|urgent|asap|critical|p1|sev ?1|outage|down|breach|immediately|overdue|deadline today)\b/i;
const RE_ASK = /\?|\b(please (confirm|share|review|advise|send|approve|revert|update|check)|can you|could you|kindly|awaiting your|let us know|let me know|need your)\b/i;
const RE_FYI = /\b(fyi|for your information|newsletter|no-?reply|do not reply|notification|digest|unsubscribe|webinar)\b/i;

export function classify(m: Pick<MailMessage, 'subject' | 'from' | 'body'>, folder: 'inbox' | 'sent' = 'inbox'): { tags: MailTag[]; priority: MailPriority } {
  const text = `${m.subject ?? ''}\n${(m.body ?? '').slice(0, 1500)}`;
  const who = `${m.from ?? ''}`;
  const tags: MailTag[] = [];
  const automated = RE_FYI.test(text) || /no-?reply|notifications?@|mailer-daemon/i.test(who);
  if (RE_ESCALATE.test(text)) tags.push('escalation');
  if (folder === 'inbox' && !automated && RE_ASK.test(text)) tags.push('needs-reply');
  if (RE_INVOICE.test(text)) tags.push('invoice');
  if (RE_BANK.test(`${who} ${text}`)) tags.push('bank');
  if (!tags.includes('needs-reply') && !tags.includes('escalation') && folder === 'inbox') tags.push('fyi');
  const priority: MailPriority = tags.includes('escalation') || (tags.includes('needs-reply') && tags.includes('bank')) ? 'high'
    : tags.includes('fyi') && tags.length === 1 ? 'low' : 'normal';
  return { tags, priority };
}

/** A two-line preview from the body (quoted history and signatures dropped). */
export function preview(body: string | null | undefined): string {
  if (!body) return '';
  const lines = body.split('\n');
  const out: string[] = [];
  for (const l of lines) {
    if (/^\s*>/.test(l) || /^On .+wrote:\s*$/.test(l.trim()) || /^--\s*$/.test(l)) break;
    if (l.trim()) out.push(l.trim());
    if (out.join(' ').length > 220) break;
  }
  return out.join(' ').slice(0, 220);
}

export interface MailSearch { from: string | null; about: string[]; since: number | null; until: number | null; unread: boolean; attachments: boolean; words: string[]; label: string | null }

const DAY = 86_400_000;
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/**
 * "mails from SBI about bulk payments last week" → from "sbi", about ["bulk payments"], since/until last week. Anything not understood is
 * kept as plain words that must all appear.
 */
export function parseSearch(input: string, now = new Date()): MailSearch {
  let s = ` ${input.toLowerCase().replace(/\s+/g, ' ').trim()} `;
  const out: MailSearch = { from: null, about: [], since: null, until: null, unread: false, attachments: false, words: [], label: null };
  const today = startOfDay(now);
  const take = (re: RegExp, fn: (m: RegExpExecArray) => void) => { const m = re.exec(s); if (m) { fn(m); s = s.replace(m[0], ' '); } };
  take(/\b(last|past) (\d{1,3}) days?\b/, (m) => { out.since = today - Number(m[2]) * DAY; });
  take(/\blast week\b/, () => { const dow = (new Date(today).getDay() + 6) % 7; const mon = today - dow * DAY; out.since = mon - 7 * DAY; out.until = mon; });
  take(/\bthis week\b/, () => { const dow = (new Date(today).getDay() + 6) % 7; out.since = today - dow * DAY; });
  take(/\blast month\b/, () => { const d = new Date(today); out.since = new Date(d.getFullYear(), d.getMonth() - 1, 1).getTime(); out.until = new Date(d.getFullYear(), d.getMonth(), 1).getTime(); });
  take(/\bthis month\b/, () => { const d = new Date(today); out.since = new Date(d.getFullYear(), d.getMonth(), 1).getTime(); });
  take(/\byesterday\b/, () => { out.since = today - DAY; out.until = today; });
  take(/\btoday\b/, () => { out.since = today; });
  take(/\bunread\b/, () => { out.unread = true; });
  take(/\b(with )?(attachments?|files?|pdfs?)\b/, () => { out.attachments = true; });
  take(/\bfrom ([^ ]+(?: [^ ]+)??)(?= about | regarding | on | re | with |$| )/, (m) => { out.from = m[1].trim(); });
  take(/\b(?:about|regarding|re|on) (.+?)\s*$/, (m) => { if (m[1].trim()) out.about.push(m[1].trim()); });
  take(/\b(invoices?|escalations?|needs reply|bank partners?)\b/, (m) => {
    const w = m[1];
    out.label = w.startsWith('invoice') ? 'invoice' : w.startsWith('escalation') ? 'escalation' : w.startsWith('bank') ? 'bank' : 'needs-reply';
  });
  out.words = s.replace(/\b(mails?|emails?|messages?|show|find|me|all|the|any|of|in|to|for)\b/g, ' ').split(' ').map((w) => w.trim()).filter((w) => w.length > 1);
  return out;
}

export function matchesSearch(m: MailMessage & { tags?: MailTag[] }, q: MailSearch): boolean {
  const at = m.date ? Date.parse(m.date) : 0;
  if (q.since !== null && at < q.since) return false;
  if (q.until !== null && at >= q.until) return false;
  if (q.unread && !m.unread) return false;
  if (q.attachments && !m.hasAttachments) return false;
  if (q.label && !(m.tags ?? []).includes(q.label as MailTag)) return false;
  const from = `${displayName(m.from)} ${addressOf(m.from)}`.toLowerCase();
  if (q.from && !from.includes(q.from)) return false;
  const hay = `${m.subject} ${m.from} ${m.to} ${m.body ?? ''}`.toLowerCase();
  for (const a of q.about) if (!a.split(' ').every((w) => hay.includes(w))) return false;
  for (const w of q.words) if (!hay.includes(w)) return false;
  return true;
}

/** What the server may filter on for IMAP accounts (one plain word or phrase); everything else is filtered here. */
export function serverQuery(q: MailSearch): string | undefined {
  return q.about[0] ?? q.from ?? (q.words[0] || undefined);
}

export function describeSearch(q: MailSearch): string[] {
  const out: string[] = [];
  if (q.from) out.push(`From “${q.from}”`);
  for (const a of q.about) out.push(`About “${a}”`);
  if (q.since !== null) out.push(q.until ? `${new Date(q.since).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })} – ${new Date(q.until - 1).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}` : `Since ${new Date(q.since).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}`);
  if (q.unread) out.push('Unread');
  if (q.attachments) out.push('With attachments');
  if (q.label) out.push(TAG_LABEL[q.label as MailTag]);
  for (const w of q.words) out.push(`“${w}”`);
  return out;
}

/** Days since a date, rounded down. */
export const daysSince = (iso: string | null, now = Date.now()) => (iso ? Math.floor((now - Date.parse(iso)) / DAY) : 0);

// ------------------------------------------------------------------ the person's own mail state (this browser)

export interface MailDraft { id: string; account: string; to: string; cc: string; subject: string; body: string; savedAt: string }
export interface ScheduledMail extends MailDraft { at: string; attachments?: { name: string; contentType: string; data: string }[] }
export interface MailLocal { snoozed: Record<string, string>; archived: string[]; projects: Record<string, string>; drafts: MailDraft[]; scheduled: ScheduledMail[] }

const EMPTY: MailLocal = { snoozed: {}, archived: [], projects: {}, drafts: [], scheduled: [] };
const key = (wid: string, uid: string) => `pt.mail.${wid}.${uid}`;

export function readLocal(wid: string, uid: string): MailLocal {
  try { const raw = localStorage.getItem(key(wid, uid)); return raw ? { ...EMPTY, ...JSON.parse(raw) as Partial<MailLocal> } : { ...EMPTY }; }
  catch { return { ...EMPTY }; }
}
export function writeLocal(wid: string, uid: string, v: MailLocal) {
  try { localStorage.setItem(key(wid, uid), JSON.stringify(v)); } catch { /* private window: only this visit */ }
  window.dispatchEvent(new CustomEvent('pt-mail-local'));
}

/** Ready-made openings for the composer. */
export const TEMPLATES: { id: string; label: string; subject: string; body: string }[] = [
  { id: 'ack', label: 'Acknowledge receipt', subject: 'Received — thank you', body: 'Hi,\n\nThank you, we have received this. We will review and get back to you by end of day.\n\nRegards,' },
  { id: 'follow', label: 'Polite follow-up', subject: 'Following up', body: 'Hi,\n\nJust following up on my earlier mail below. Could you share an update when you get a moment?\n\nThanks,' },
  { id: 'payment', label: 'Payment confirmation', subject: 'Payment confirmation', body: 'Hi,\n\nThis is to confirm that the payment has been processed. Please find the reference details below and confirm receipt.\n\nReference: \nAmount: \nDate: \n\nRegards,' },
  { id: 'uat', label: 'Request UAT access', subject: 'UAT access and IP whitelisting', body: 'Hi,\n\nCould you please share the UAT credentials and whitelist our IP range for the integration? Our planned test window is this week.\n\nThanks,' },
  { id: 'meeting', label: 'Propose a meeting', subject: 'Quick call to align', body: 'Hi,\n\nCan we set up a 30-minute call to align on the next steps? Please suggest a slot that works for you.\n\nThanks,' },
];

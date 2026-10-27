import { useEffect, useMemo, useState } from 'react';
import { useQueries } from '@tanstack/react-query';
import { invalidateWorkspace } from '../../lib/hooks';
import { useAuth, useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { useMailAccounts, type Account } from '../mailbox/MailParts';
import { mailboxApi, type MailFolder, type MailMessage } from '../mailbox/mailboxApi';
import { classify, preview, readLocal, writeLocal, type MailLocal, type MailPriority, type MailTag } from './mailSmart';

export type MailRow = MailMessage & { account: string; accountLabel: string; kind: Account['kind']; folder: MailFolder; key: string; tags: MailTag[]; priority: MailPriority; snippet: string };

/** The list query for one account and folder: shared by the Mail page and the sidebar's unread count. */
export const listKey = (wid: string | null, account: string, folder: MailFolder, q = '') => [wid, 'mailbox', 'list', account, folder, q];

/**
 * Every readable account's Inbox and Sent, merged and tagged. `enabled` lets the sidebar ask only for the inboxes (the unread count).
 */
export function useMailData(opts: { sent?: boolean; q?: string; enabled?: boolean } = {}) {
  const wid = useWorkspaceId();
  const { accounts, loading, google, ms, imap } = useMailAccounts(opts.enabled !== false);
  const readable = accounts.filter((a) => a.canRead);
  const folders: MailFolder[] = opts.sent ? ['inbox', 'sent'] : ['inbox'];
  const pairs = readable.flatMap((a) => folders.map((f) => ({ a, f })));
  const lists = useQueries({
    queries: pairs.map(({ a, f }) => ({
      queryKey: listKey(wid, a.key, f, a.kind === 'imap' ? opts.q ?? '' : ''),
      queryFn: ({ signal }: { signal: AbortSignal }) => mailboxApi.messages(a.key, f, null, a.kind === 'imap' ? opts.q || undefined : undefined, signal),
      staleTime: 60_000, refetchInterval: 120_000, retry: 1, enabled: opts.enabled !== false && !!wid,
    })),
  });
  const stamp = lists.map((l) => l.dataUpdatedAt).join(',');
  const rows = useMemo(() => {
    const out: MailRow[] = [];
    pairs.forEach(({ a, f }, i) => {
      for (const m of lists[i]?.data?.messages ?? []) {
        const c = classify(m, f);
        out.push({ ...m, account: a.key, accountLabel: a.label, kind: a.kind, folder: f, key: `${a.key}|${f}|${m.id}`, tags: c.tags, priority: c.priority, snippet: preview(m.body) });
      }
    });
    return out.sort((x, y) => (y.date ? Date.parse(y.date) : 0) - (x.date ? Date.parse(x.date) : 0));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stamp, pairs.map((p) => `${p.a.key}${p.f}`).join(',')]);
  const errors = pairs.map((p, i) => ({ account: p.a, error: lists[i]?.error })).filter((x) => x.error);
  return { accounts, readable, rows, loading: loading || lists.some((l) => l.isLoading), errors, google, ms, imap };
}

/** The person's local mail state (snoozed, archived, linked projects, drafts, scheduled), kept in step across the page and the sidebar. */
export function useMailLocal() {
  const wid = useWorkspaceId() ?? '';
  const uid = useAuth((s) => s.ctx?.user.id) ?? '';
  const [v, setV] = useState<MailLocal>(() => readLocal(wid, uid));
  useEffect(() => {
    setV(readLocal(wid, uid));
    const on = () => setV(readLocal(wid, uid));
    window.addEventListener('pt-mail-local', on);
    return () => window.removeEventListener('pt-mail-local', on);
  }, [wid, uid]);
  const update = (fn: (m: MailLocal) => MailLocal) => writeLocal(wid, uid, fn(readLocal(wid, uid)));
  return [v, update] as const;
}

/** Unread mail in every inbox (not archived or snoozed) for the sidebar badge; also sends scheduled mail that has come due. */
export function useMailUnread(enabled: boolean) {
  const data = useMailData({ enabled });
  const [local, update] = useMailLocal();
  useScheduledSender(enabled, update);
  if (!enabled) return 0;
  const now = Date.now();
  return data.rows.filter((r) => r.unread && !local.archived.includes(r.key) && !(local.snoozed[r.key] && Date.parse(local.snoozed[r.key]) > now)).length;
}

/** Scheduled sends live in this browser: each one goes out the first time Project Tracker is open after its time. */
function useScheduledSender(enabled: boolean, update: (fn: (m: MailLocal) => MailLocal) => void) {
  const wid = useWorkspaceId();
  const uid = useAuth((s) => s.ctx?.user.id) ?? '';
  useEffect(() => {
    if (!enabled || !wid || !uid) return;
    let running = false;
    const tick = async () => {
      if (running) return;
      running = true;
      const now = Date.now();
      for (const s of readLocal(wid, uid).scheduled.filter((x) => Date.parse(x.at) <= now)) {
        update((m) => ({ ...m, scheduled: m.scheduled.filter((x) => x.id !== s.id) }));
        try {
          await mailboxApi.send({ account: s.account, to: s.to, cc: s.cc, subject: s.subject, body: s.body, attachments: s.attachments, confirmed: true });
          toast(`Scheduled mail sent: ${s.subject || '(no subject)'}`);
          void invalidateWorkspace(wid, 'mailbox');
        } catch {
          update((m) => ({ ...m, drafts: [{ ...s, savedAt: new Date().toISOString() }, ...m.drafts] }));
          toast(`A scheduled mail could not be sent and is back in Drafts: ${s.subject || '(no subject)'}`, 'error');
        }
      }
      running = false;
    };
    void tick();
    const t = window.setInterval(() => void tick(), 60_000);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, wid, uid]);
}

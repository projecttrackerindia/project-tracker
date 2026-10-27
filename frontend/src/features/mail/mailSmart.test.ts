import { describe, expect, it } from 'vitest';
import { classify, matchesSearch, parseSearch, preview } from './mailSmart';

const msg = (o: Partial<{ subject: string; from: string; body: string; date: string; unread: boolean; hasAttachments: boolean }>) => ({
  id: '1', threadId: 't', subject: '', from: 'A <a@x.com>', to: 'me@x.com', cc: '', date: '2026-10-20T10:00:00Z', unread: false, hasAttachments: false, body: '', ...o,
});

describe('classify', () => {
  it('tags a bank escalation that asks for something as high priority', () => {
    const r = classify(msg({ subject: 'URGENT: bulk payment file rejected', from: 'SBI Ops <ops@sbi.co.in>', body: 'Can you please confirm the corrected file?' }));
    expect(r.tags).toEqual(expect.arrayContaining(['escalation', 'needs-reply', 'bank']));
    expect(r.priority).toBe('high');
  });
  it('treats newsletters as FYI, low priority', () => {
    const r = classify(msg({ subject: 'Weekly digest', from: 'no-reply@tool.com', body: 'Here is what happened. Unsubscribe' }));
    expect(r.tags).toEqual(['fyi']);
    expect(r.priority).toBe('low');
  });
  it('spots invoices', () => {
    expect(classify(msg({ subject: 'Invoice INV-204 for October' })).tags).toContain('invoice');
  });
});

describe('parseSearch', () => {
  const now = new Date(2026, 9, 28, 12); // Wed 28 Oct 2026
  it('reads "mails from SBI about bulk payments last week"', () => {
    const q = parseSearch('mails from SBI about bulk payments last week', now);
    expect(q.from).toBe('sbi');
    expect(q.about).toEqual(['bulk payments']);
    expect(new Date(q.since!).getDate()).toBe(19);
    expect(new Date(q.until!).getDate()).toBe(26);
    const hit = msg({ from: 'SBI Corporate <corp@sbi.co.in>', subject: 'Bulk payments batch 12', date: new Date(2026, 9, 21).toISOString() });
    expect(matchesSearch(hit, q)).toBe(true);
    expect(matchesSearch({ ...hit, date: new Date(2026, 9, 27).toISOString() }, q)).toBe(false);
    expect(matchesSearch({ ...hit, from: 'HDFC <x@hdfc.com>' }, q)).toBe(false);
  });
  it('understands unread and attachments', () => {
    const q = parseSearch('unread with attachments', now);
    expect(q.unread && q.attachments).toBe(true);
    expect(q.words).toEqual([]);
  });
});

describe('preview', () => {
  it('drops quoted history', () => {
    expect(preview('Hello there\n\nOn Mon, A wrote:\n> old')).toBe('Hello there');
  });
});

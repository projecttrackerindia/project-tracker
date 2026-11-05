import { useState, type FormEvent } from 'react';
import './quick.css';
import { useNavigate } from 'react-router-dom';
import type { AppNotification } from '../../../api/types';
import { toast } from '../../../stores/ui';
import { NEEDS_TEXT, OPENS, QUICK_LABEL, pressQuick, quickActionsFor, showsQuickActions, type QuickAction } from './quickActions';

/**
 * The buttons on an urgent in-app banner: at most two, the first one primary (Approve, Join, Done...). Reject and Reply ask for a few words
 * inline. Acting is instant: the banner closes at once and a short note confirms; a failure says so and leaves the notice in the inbox.
 */
export function QuickBannerActions({ n, onDone }: { n: AppNotification; onDone: () => void }) {
  const nav = useNavigate();
  const [asking, setAsking] = useState<QuickAction | null>(null);
  const [text, setText] = useState('');
  if (!showsQuickActions(n)) return null;
  const shown = quickActionsFor(n).filter((a) => a !== 'read' && a !== 'answer').slice(0, 2);
  if (!shown.length) return null;

  const act = async (a: QuickAction, words?: string) => {
    if (NEEDS_TEXT.has(a) && !words) { setAsking(a); return; }
    onDone();
    if (OPENS.has(a)) {
      void pressQuick(n.id, 'read').catch(() => undefined);
      const to = a === 'join' ? (n.joinLink ?? n.link) : n.link;
      if (to) { if (/^https?:/.test(to)) window.open(to, '_blank', 'noopener'); else nav(to); }
      return;
    }
    try {
      const r = await pressQuick(n.id, a, words);
      toast(r.message, 'success');
    } catch (e) { toast(e instanceof Error && e.message ? e.message : 'That did not go through. Open it to try again.', 'error'); }
  };
  const submit = (e: FormEvent) => { e.preventDefault(); e.stopPropagation(); const t = text.trim(); if (t && asking) void act(asking, t); };

  if (asking) {
    return (
      <form className="ncx-reply qa-ask" onSubmit={submit} data-testid="qa-ask">
        <input autoFocus value={text} onChange={(e) => setText(e.target.value)} maxLength={2000}
          placeholder={asking === 'reject' ? 'Reason for rejecting' : 'Reply…'} aria-label={asking === 'reject' ? 'Reason for rejecting' : 'Reply'}
          onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setAsking(null); } }} />
        <button type="submit" className={`ncx-btn${asking === 'reject' ? ' qa-danger' : ''}`} disabled={!text.trim()}>{QUICK_LABEL[asking]}</button>
      </form>
    );
  }
  // The primary action sits last (right), Apple-style: "Reject  [Approve]".
  const ordered = shown.length === 2 ? [shown[1], shown[0]] : shown;
  return (
    <div className="ncx-quick qa-row" data-testid="qa-row">
      {ordered.map((a) => (
        <button key={a} type="button" className={`ncx-btn${a === shown[0] ? ' primary' : ''}`} data-action={a} onClick={() => void act(a)}>{QUICK_LABEL[a]}</button>
      ))}
    </div>
  );
}

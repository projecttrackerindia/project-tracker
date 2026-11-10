import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { insightApi } from '../../api/endpoints';
import type { SearchHit } from '../../api/types';
import type { WorkChoice } from './TimeEntryEditor';

/**
 * Pick the work a block of time was spent on: type to search the tasks, issues and action items of EVERY project you can open (not only this
 * week's), or pick from what is already on your calendar and timesheet. Results are grouped by project key, the match is highlighted, and the
 * keyboard does everything (↑ ↓ Enter Esc). Shown as a plain field until it is focused, so the form stays as calm as before.
 */
const idOf = (c: Pick<WorkChoice, 'kind' | 'id'>) => `${c.kind}:${c.id}`;
const label = (c: WorkChoice) => `${c.key ? `${c.key} · ` : ''}${c.title}`;
const groupOf = (c: WorkChoice) => c.projectName ?? (c.key ? c.key.split('-')[0] : 'Other');

/** A search hit as a choice: tasks log time on the task, issues / action items / operational work log it on the work item. */
export function choiceFromHit(h: SearchHit): WorkChoice | null {
  const key = h.subtitle?.split(' · ')[0] ?? null;
  if (h.type === 'task') return { kind: 'task', id: h.id, key, title: h.title, projectName: null };
  if (h.type === 'issue' || h.type === 'action' || h.type === 'work') return { kind: 'work', id: h.id, key, title: h.title, projectName: null };
  return null;
}

function Marked({ text, q }: { text: string; q: string }) {
  const i = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (i < 0) return <>{text}</>;
  return <>{text.slice(0, i)}<mark>{text.slice(i, i + q.length)}</mark>{text.slice(i + q.length)}</>;
}

export function WorkPicker({ choices, value, onPick }: { choices: WorkChoice[]; value: WorkChoice | null; onPick: (c: WorkChoice) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [found, setFound] = useState<WorkChoice[]>([]);
  const [busy, setBusy] = useState(false);
  const [at, setAt] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const listId = useId();
  const term = q.trim();

  // Search the whole workspace once two letters are typed (waits a moment so typing stays smooth; an older answer never replaces a newer one).
  useEffect(() => {
    if (term.length < 2) { setFound([]); setBusy(false); return; }
    let live = true;
    setBusy(true);
    const t = setTimeout(() => {
      insightApi.search(term).then((r) => { if (live) setFound((r.hits ?? []).map(choiceFromHit).filter((c): c is WorkChoice => !!c)); })
        .catch(() => { if (live) setFound([]); }).finally(() => { if (live) setBusy(false); });
    }, 220);
    return () => { live = false; clearTimeout(t); };
  }, [term]);

  useEffect(() => {
    if (!open) return;
    const off = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', off);
    return () => document.removeEventListener('pointerdown', off);
  }, [open]);

  const rows = useMemo(() => {
    const k = term.toLowerCase();
    const mine = choices.filter((c) => !k || `${c.key ?? ''} ${c.title} ${c.projectName ?? ''}`.toLowerCase().includes(k));
    const seen = new Set(mine.map(idOf));
    const more = found.filter((c) => !seen.has(idOf(c)));
    return [
      ...(mine.length ? [{ head: k ? 'On your calendar and timesheet' : 'Suggested', items: mine.slice(0, 8) }] : []),
      ...(more.length ? [{ head: 'All projects', items: more }] : []),
    ];
  }, [choices, found, term]);
  const flat = rows.flatMap((r) => r.items);
  useEffect(() => setAt(0), [term, found]);

  const pick = (c: WorkChoice) => { onPick(c); setOpen(false); setQ(''); };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setAt((a) => Math.min(flat.length - 1, a + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setAt((a) => Math.max(0, a - 1)); }
    else if (e.key === 'Enter' && open && flat[at]) { e.preventDefault(); pick(flat[at]); }
    else if (e.key === 'Escape' && open) { e.preventDefault(); e.stopPropagation(); setOpen(false); setQ(''); }
  };

  return (
    <div className="wpk" ref={box}>
      <input className="ed-sel wpk-in" role="combobox" aria-expanded={open} aria-controls={listId} aria-label="Work item" autoComplete="off" spellCheck={false}
        placeholder={value ? label(value) : 'Search tasks in every project…'} value={open ? q : ''} data-testid="work-picker"
        onFocus={() => setOpen(true)} onChange={(e) => { setQ(e.target.value); setOpen(true); }} onKeyDown={onKey} />
      {!open && value && <span className="wpk-cur" aria-hidden="true" onClick={() => setOpen(true)}>{label(value)}</span>}
      {open && (
        <div className="wpk-pop" id={listId} role="listbox">
          {rows.map((g) => (
            <div key={g.head} className="wpk-g">
              <div className="wpk-h">{g.head}</div>
              {g.items.map((c) => {
                const i = flat.indexOf(c);
                const on = !!value && idOf(c) === idOf(value);
                return (
                  <button type="button" key={idOf(c)} role="option" aria-selected={on} className={`wpk-r${i === at ? ' hot' : ''}${on ? ' on' : ''}`}
                    onMouseEnter={() => setAt(i)} onClick={() => pick(c)}>
                    <span className="wpk-id">{c.key ?? groupOf(c)}</span>
                    <span className="wpk-t"><Marked text={c.title} q={term} /></span>
                    {c.projectName && <small>{c.projectName}</small>}
                    {on && <span className="wpk-ck" aria-hidden="true">✓</span>}
                  </button>
                );
              })}
            </div>
          ))}
          {!rows.length && <p className="wpk-none">{busy ? 'Searching every project…' : term.length < 2 ? 'Type two letters to search every project.' : `Nothing found for “${term}”.`}</p>}
          {!!rows.length && busy && <p className="wpk-none">Searching every project…</p>}
          <p className="wpk-hint">↑↓ to move · Enter to choose · Esc to close</p>
        </div>
      )}
    </div>
  );
}

import { useMemo, useRef, useState, type ReactNode } from 'react';
import type { SavedView } from '../../api/platformApi';
import { openPalette } from '../../components/paletteLink';
import type { SheetRow } from './portfolioApi';
import { addDays, dm, isOpen } from './planSheet';
import { DUE_LABEL, STATUS_KEYS, STATUS_LABEL, statusKey, type DueKey, type StatusKey, type Tok } from './planSheetQuery';
import { Av, Dot, Floating } from './planSheetParts';

/**
 * The Portfolio's one command field (design plansheet3–8), shared by every tab: typed tokens (owner, status, due, project, text), Aura's reading of a
 * sentence, People / Status / Dates / Projects suggestions, a live count and saved views. The tokens live in the address (?f=), so they stay when the
 * tab changes; each tab applies them to what it shows (tasks on the Plan sheet, projects on the Board and Timeline, people on Capacity).
 */
export function CommandField({ toks, setToks, text, setText, interpreted, count, total, filtering, people, projects, work, ctx, compact, views, activeView, defaultView, onApplyView, onSaveView, label, placeholder, countText }: {
  toks: Tok[]; setToks: (t: Tok[]) => void; text: string; setText: (t: string) => void; interpreted: Tok[]; count: number; total: number; filtering: boolean;
  people: { id: string; name: string }[]; projects: SheetRow[]; work: SheetRow[]; ctx: { today: string; me: string | null }; compact: boolean;
  views: SavedView[]; activeView: string | null; defaultView: string | null; onApplyView: (v: SavedView) => void; onSaveView: (name: string) => void;
  /** Per tab: the field's name and hint, and what the count says ("3 of 5 projects"). */ label?: string; placeholder?: string; countText?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [naming, setNaming] = useState<string | null>(null);
  const [custom, setCustom] = useState<{ from: string; to: string } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const word = text.trim().split(/\s+/).pop()?.toLowerCase() ?? '';
  const byOwner = useMemo(() => { const m = new Map<string, number>(); for (const r of work) if (r.ownerId && isOpen(r)) m.set(r.ownerId, (m.get(r.ownerId) ?? 0) + 1); return m; }, [work]);
  const ppl = useMemo(() => {
    const list = people.filter((p) => !toks.some((t) => t.kind === 'owner' && t.value === p.id));
    const hit = word.length >= 2 ? list.filter((p) => p.name.toLowerCase().split(/\s+/).some((w) => w.startsWith(word))) : [];
    return (hit.length ? hit : list.filter((p) => byOwner.has(p.id)).sort((a, b) => (byOwner.get(b.id) ?? 0) - (byOwner.get(a.id) ?? 0))).slice(0, hit.length ? 4 : 2);
  }, [people, toks, word, byOwner]);
  const statusCount = useMemo(() => { const m: Record<StatusKey, number> = { late: 0, risk: 0, prog: 0, todo: 0, done: 0 }; for (const r of work) m[statusKey(r)]++; return m; }, [work]);
  const [hi, setHi] = useState(0);
  const add = (t: Tok) => { setToks([...toks.filter((x) => !(x.kind === t.kind && x.value === t.value)), t]); setText(''); input.current?.focus(); };
  const has = (k: Tok['kind'], v: string) => [...toks, ...interpreted].some((t) => t.kind === k && t.value === v);
  const commit = () => { if (interpreted.length) { setToks([...toks, ...interpreted.filter((t) => !toks.some((x) => x.kind === t.kind && x.value === t.value))]); setText(''); } };
  const tokLabel = (t: Tok) => t.kind === 'text' ? <>{t.label}</> : <><span className="k">{t.kind} </span>{t.label}</>;
  const person = (id: string) => people.find((p) => p.id === id);
  return (
    <>
      <div ref={box} className={`ps3-cmd ${open ? 'focus' : ''}`} onMouseDown={(e) => { if (e.target === e.currentTarget) { e.preventDefault(); input.current?.focus(); } }}>
        <span className="ic" aria-hidden="true">⌕</span>
        {toks.map((t, i) => (
          <span key={`${t.kind}:${t.value}`} className="ps3-tok">{t.kind === 'owner' && t.value !== 'me' && <Av id={t.value} name={person(t.value)?.name} size={16} />}{tokLabel(t)}
            <button type="button" className="x" aria-label={`Remove ${t.kind} ${t.label}`} onClick={() => setToks(toks.filter((_, j) => j !== i))}>✕</button></span>
        ))}
        <input ref={input} aria-label={label ?? 'Filter, search or ask'} placeholder={toks.length ? '' : placeholder ?? (compact ? 'Filter or ask' : 'Filter, search or ask — try “late this week”')} value={text}
          onFocus={() => setOpen(true)} onChange={(e) => { setText(e.target.value); setHi(0); }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); if (interpreted.length) commit(); else if (ppl[hi]) add({ kind: 'owner', value: ppl[hi].id, label: ppl[hi].name }); }
            else if (e.key === 'Backspace' && !text && toks.length) setToks(toks.slice(0, -1));
            else if (e.key === 'ArrowDown') { e.preventDefault(); setHi((x) => Math.min(ppl.length - 1, x + 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((x) => Math.max(0, x - 1)); }
            else if (e.key === 'Escape') { setOpen(false); input.current?.blur(); }
          }} />
        <span className={`ps3-count ${filtering ? 'on' : ''}`} aria-live="polite">{countText ?? (compact ? (filtering ? count : total) : filtering ? `${count} of ${total} tasks` : `${total} tasks`)}</span>
        {!compact && <kbd role="button" tabIndex={-1} title="Commands (⌘K)" onMouseDown={(e) => { e.preventDefault(); openPalette(); }}>⌘K</kbd>}
      </div>
      {open && !compact && <div className="ps3-cmd-scrim" aria-hidden="true" />}
      {open && (
        <Floating anchor={box.current} onClose={() => { setOpen(false); setNaming(null); setCustom(null); }} width={compact ? 358 : 560} label="Filter suggestions" style={{ paddingBottom: 8 }}>
          {interpreted.length > 0 && <>
            <div style={{ display: 'flex', gap: 8, padding: '12px 14px 6px', alignItems: 'center', flexWrap: 'wrap' }}><span className="ps3-dim" style={{ fontSize: 12 }}>Aura read this as</span>
              {interpreted.map((t) => <button key={`${t.kind}:${t.value}`} type="button" className="ps3-tok aura" onClick={commit} title="Keep these filters (↵)">{tokLabel(t)}</button>)}</div>
            <div className="hr" />
          </>}
          {ppl.length > 0 && <><div className="ph">People</div>
            {ppl.map((p, i) => <button key={p.id} type="button" className={`it ${i === hi ? 'on' : ''}`} onMouseEnter={() => setHi(i)} onClick={() => add({ kind: 'owner', value: p.id, label: p.name })}>
              <Av id={p.id} name={p.name} /><span style={{ flex: 1 }}>{p.name}</span><span className="ps3-dim">{byOwner.get(p.id) ?? 0} task{byOwner.get(p.id) === 1 ? '' : 's'}</span>{i === hi && <span aria-hidden="true">↵</span>}</button>)}</>}
          <div className="ph">Status</div>
          <div className="row">{STATUS_KEYS.map((k) => <button key={k} type="button" className="ps3-tok" style={has('status', k) ? { boxShadow: '0 0 0 1px var(--p-blue)' } : undefined}
            onClick={() => add({ kind: 'status', value: k, label: STATUS_LABEL[k] })}><span className="ps3-st"><Dot k={k} />{STATUS_LABEL[k]}</span><span className="ps3-dim" style={{ fontWeight: 400 }}>{statusCount[k]}</span></button>)}</div>
          <div className="ph">Dates</div>
          <div className="row">{(['overdue', 'this-week', 'next-2-weeks', 'slipped'] as DueKey[]).map((k) => <button key={k} type="button" className={`ps3-qc ${has('due', k) ? 'on' : ''}`} onClick={() => add({ kind: 'due', value: k, label: DUE_LABEL[k] })}>{DUE_LABEL[k]}</button>)}
            <button type="button" className={`ps3-qc ${custom ? 'on' : ''}`} onClick={() => setCustom(custom ? null : { from: ctx.today, to: addDays(ctx.today, 14) })}>Custom…</button>
            {custom && <span className="ps3-save-view"><input type="date" aria-label="From" value={custom.from} onChange={(e) => setCustom({ ...custom, from: e.target.value })} style={{ width: 130 }} />
              <input type="date" aria-label="To" value={custom.to} onChange={(e) => setCustom({ ...custom, to: e.target.value })} style={{ width: 130 }} />
              <button type="button" className="ps3-qc pri" disabled={!custom.from || !custom.to || custom.to < custom.from} onClick={() => { add({ kind: 'due', value: `${custom.from}..${custom.to}`, label: `${dm(custom.from)} – ${dm(custom.to)}` }); setCustom(null); }}>Add</button></span>}</div>
          <div className="ph">Projects</div>
          <div className="row" style={{ paddingBottom: 8 }}>{projects.map((p) => <button key={p.id} type="button" className={`ps3-qc ${has('project', p.id) ? 'on' : ''}`} onClick={() => add({ kind: 'project', value: p.id, label: p.title })}>{p.title}</button>)}</div>
          <div className="hr" />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 14px 2px', flexWrap: 'wrap' }}><span className="ps3-dim" style={{ fontSize: 12 }}>Saved views</span>
            {views.length === 0 && <span className="ps3-dim" style={{ fontSize: 12 }}>none yet</span>}
            {views.slice(0, 6).map((v) => <button key={v.id} type="button" className={`ps3-qc ${activeView === v.id ? 'on' : ''}`} onClick={() => { onApplyView(v); setOpen(false); }}>{defaultView === v.id ? '★ ' : ''}{v.name}</button>)}
            <span className="ps3-sp" />
            {naming === null ? <button type="button" className="ps3-link" disabled={!filtering} title={filtering ? undefined : 'Add a filter first'} style={filtering ? undefined : { opacity: .5 }} onClick={() => setNaming('')}>＋ Save as view</button>
              : <form className="ps3-save-view" onSubmit={(e) => { e.preventDefault(); if (naming.trim()) { onSaveView(naming.trim()); setNaming(null); setOpen(false); } }}>
                <input autoFocus aria-label="Name for the view" placeholder="Name the view" value={naming} onChange={(e) => setNaming(e.target.value)} maxLength={80} />
                <button type="submit" className="ps3-qc pri" disabled={!naming.trim()}>Save</button></form>}
          </div>
        </Floating>
      )}
    </>
  );
}

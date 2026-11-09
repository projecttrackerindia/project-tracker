import { useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { projectApi } from '../../api/endpoints';
import type { ProjectDetail, Stage, Task } from '../../api/types';
import { CalmAv, CalmCard, CalmSheet } from '../../components/calm';
import { invalidateWorkspace } from '../../lib/hooks';
import { useIsMobile } from '../../lib/mobile';
import { queryClient, useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { StagesPane } from './ProjectEditPanel';
import { currentIndex, dm, errText, isClosed, loadHint, moveStageDate, ordered, StageOwnerSheet, stageBody } from './stagesKit';

const DAY = 86_400_000;
const toMs = (iso: string) => Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);
const toIso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const first = (n?: string | null) => (n ?? '').split(' ')[0];

/** The journey: a forecast line on the web (concept A), rings on a phone (concept C). */
export function JourneyForecast({ detail, tasks, canEdit }: { detail: ProjectDetail; tasks: Task[] | undefined; canEdit: boolean }) {
  const phone = useIsMobile();
  if (!detail.stages.length) return null;
  return phone ? <JourneyRings detail={detail} tasks={tasks} canEdit={canEdit} /> : <ForecastLine detail={detail} tasks={tasks} canEdit={canEdit} />;
}

function useRefresh(projectId: string) {
  const wid = useWorkspaceId();
  return (stages?: Stage[]) => {
    if (stages) queryClient.setQueryData<ProjectDetail>([wid, 'project', projectId], (d) => (d ? { ...d, stages } : d));
    void invalidateWorkspace(wid, 'project', projectId);
  };
}

/**
 * Concept A: "Go-live · Likely <date>" (amber when later than promised) and why; Now: the current stage, its owner and days left; one
 * timeline with the Today line, done fill to today, stages as quiet ticks (current bold), the promised ◆ and forecast ◆ with a dashed amber
 * gap; Aura's one fix with Do it. A stage opens a small popover (owner with load, date, Change owner, Move date, Make current); a stage's end
 * tick drags to move its date (days; later asks why).
 */
function ForecastLine({ detail, tasks, canEdit }: { detail: ProjectDetail; tasks: Task[] | undefined; canEdit: boolean }) {
  const p = detail.project;
  const f = detail.forecast;
  const stages = ordered(detail.stages);
  const cur = currentIndex(stages);
  const refresh = useRefresh(p.id);
  const bar = useRef<HTMLDivElement>(null);
  const [pop, setPop] = useState<string | null>(null);
  const [owning, setOwning] = useState<Stage | null>(null);
  const [drag, setDrag] = useState<{ id: string; ms: number } | null>(null);
  const [busy, setBusy] = useState(false);

  const today = toMs(todayIso());
  const dates = [p.startDate, ...stages.flatMap((s) => [s.plannedStart, s.plannedEnd]), f?.promised, f?.forecast, p.dueDate].filter(Boolean) as string[];
  const lo = Math.min(today, ...dates.map(toMs)), hi = Math.max(today + DAY, ...dates.map(toMs));
  const span = Math.max(DAY, hi - lo);
  const x = (ms: number) => `${((ms - lo) / span) * 100}%`;
  const ends = stages.map((s, i) => (drag?.id === s.id ? drag.ms : s.plannedEnd ? toMs(s.plannedEnd) : lo + (span * (i + 1)) / stages.length));
  const starts = stages.map((s, i) => (i === 0 ? (s.plannedStart ? toMs(s.plannedStart) : lo) : ends[i - 1]));
  const last = stages[stages.length - 1];
  const late = (f?.slipDays ?? 0) > 0;
  const curStage = cur >= 0 ? stages[cur] : null;
  const owner = curStage?.ownerTeamName ?? curStage?.owner?.name ?? null;
  const daysLeft = f?.daysLeft ?? null;

  const msAt = (clientX: number) => {
    const r = bar.current!.getBoundingClientRect();
    return Math.round((lo + ((clientX - r.left) / r.width) * span) / DAY) * DAY;
  };
  // Drag a stage's end tick: window listeners (not pointer capture), so a re-render mid-drag never loses it; snaps to days.
  const startDrag = (s: Stage) => (e: RPointerEvent) => {
    if (!canEdit || isClosed(s)) return;
    e.preventDefault();
    let ms = msAt(e.clientX);
    setDrag({ id: s.id, ms });
    const move = (ev: PointerEvent) => { ms = msAt(ev.clientX); setDrag({ id: s.id, ms }); };
    const up = async () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      setDrag(null);
      const to = toIso(ms);
      if (to === s.plannedEnd) return;
      const r = await moveStageDate(p.id, s, to);
      if (r) { refresh(r); toast(`${s.name} moved to ${dm(to)}.`); }
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };
  const makeCurrent = async (s: Stage) => {
    setPop(null);
    try { refresh(await projectApi.updateStage(p.id, s.id, stageBody(s, { status: 'InProgress' }))); toast(`${s.name} is now the current stage.`); }
    catch (e) { toast(errText(e, 'Could not make it current.'), 'error'); }
  };
  const doIt = async () => {
    if (!f?.suggestedOwner || !curStage || busy) return;
    setBusy(true);
    try {
      const r = await projectApi.reassignStage(p.id, curStage.id, { ownerId: f.suggestedOwner.id, moveOpenTasks: true });
      refresh(r.stages); toast(`${curStage.name} handed to ${first(f.suggestedOwner.name)}${r.movedTasks ? ` with ${r.movedTasks} open task${r.movedTasks === 1 ? '' : 's'}` : ''}.`);
    } catch (e) { toast(errText(e, 'Could not hand it over.'), 'error'); }
    finally { setBusy(false); }
  };

  return (
    <CalmCard className="jf" aria-label="Journey" data-testid="journey-forecast">
      <div className="jf-top">
        <div className="jf-head">
          <span className="jf-cap">{last?.name ?? 'Finish'}</span>
          <h2>{f?.forecast ? <>Likely <span className={late ? 'late' : ''}>{dm(f.forecast)}</span></> : 'No date yet'}</h2>
          <p>{f?.promised ? <>Promised {dm(f.promised)}{late ? <> · <span className="late">{f.slipDays} {f.slipDays === 1 ? 'day' : 'days'} late</span>{f.reason ? ` because ${f.reason}` : ''}</> : ' · on time'}</> : 'Set a due date or stage dates to get a forecast.'}</p>
        </div>
        {curStage && (
          <div className="jf-now">
            <span className="jf-cap">Now</span>
            <b>{curStage.name}</b>
            <span className="jf-who">{owner && <CalmAv name={owner} size={30} />}<span>{owner ? first(owner) : 'No owner'}{daysLeft != null ? ` · ${daysLeft >= 0 ? `${daysLeft} ${daysLeft === 1 ? 'day' : 'days'} left` : `${-daysLeft} days over`}` : ''}</span></span>
          </div>
        )}
      </div>
      <div className="jf-line" ref={bar} onDragStart={(e) => e.preventDefault()}>
        <span className="jf-rail" />
        <span className="jf-done" style={{ width: x(Math.min(Math.max(today, lo), hi)) }} />
        <span className="jf-today" style={{ left: x(today) }}><em>Today</em></span>
        {f?.promised && <span className="jf-dia promised" style={{ left: x(toMs(f.promised)) }}><em>{dm(f.promised)} ◆</em></span>}
        {late && f?.promised && f.forecast && <>
          <span className="jf-gap" style={{ left: x(toMs(f.promised)), width: `${((toMs(f.forecast) - toMs(f.promised)) / span) * 100}%` }} />
          <span className="jf-dia forecast" style={{ left: x(toMs(f.forecast)) }}><em>◆ {new Date(toMs(f.forecast)).getUTCDate()}</em></span>
        </>}
        {stages.map((s, i) => {
          const state = isClosed(s) ? 'done' : i === cur ? 'current' : 'next';
          return (
            <div key={s.id} className={`jf-seg ${state}`} style={{ left: x(starts[i]), width: `${Math.max(0, ((ends[i] - starts[i]) / span) * 100)}%` }}>
              <button type="button" className="jf-lab" onClick={() => setPop(pop === s.id ? null : s.id)} aria-expanded={pop === s.id} data-stage={s.name}>
                {state === 'done' ? '✓ ' : ''}{s.name}
              </button>
              <span className={`jf-tick${canEdit && state !== 'done' ? ' can' : ''}`} onPointerDown={startDrag(s)} title={canEdit ? `Drag to move ${s.name}` : undefined}
                aria-label={`${s.name} ends ${dm(drag?.id === s.id ? toIso(drag.ms) : s.plannedEnd)}`} role="slider" aria-valuetext={dm(s.plannedEnd)} tabIndex={-1} />
              {drag?.id === s.id && <span className="jf-drag">{dm(toIso(drag.ms))}</span>}
              {pop === s.id && <StagePopover stage={s} tasks={tasks} canEdit={canEdit} projectId={p.id} current={i === cur}
                onOwner={() => { setPop(null); setOwning(s); }} onCurrent={() => void makeCurrent(s)} onSaved={(r) => { refresh(r); setPop(null); }} onClose={() => setPop(null)} />}
            </div>
          );
        })}
      </div>
      {f?.suggestedOwner && curStage && (
        <div className="jf-aura" data-testid="journey-aura">
          <span><span className="jf-cap">Aura:</span> Give {curStage.name} to <b>{first(f.suggestedOwner.name)}</b> ({f.suggestedOwnerOpenTasks ? `${f.suggestedOwnerOpenTasks} open task${f.suggestedOwnerOpenTasks === 1 ? '' : 's'}` : 'free'}){f.suggestedForecast ? <> and {last?.name ?? 'the finish'} moves back to <b className="good">{dm(f.suggestedForecast)}</b></> : null}.</span>
          {canEdit && <button type="button" className="stg-go" onClick={() => void doIt()} disabled={busy}>Do it</button>}
        </div>
      )}
      <StageOwnerSheet projectId={p.id} stage={owning} tasks={tasks} onClose={() => setOwning(null)} onSaved={(r) => refresh(r)} />
    </CalmCard>
  );
}

function StagePopover({ stage, tasks, canEdit, projectId, current, onOwner, onCurrent, onSaved, onClose }: {
  stage: Stage; tasks: Task[] | undefined; canEdit: boolean; projectId: string; current: boolean; onOwner: () => void; onCurrent: () => void; onSaved: (s: Stage[]) => void; onClose: () => void;
}) {
  const who = stage.ownerTeamName ?? stage.owner?.name ?? null;
  const load = stage.owner ? loadHint(stage.owner.id, tasks) : null;
  const date = useRef<HTMLInputElement>(null);
  return (
    <div className="jf-pop" role="dialog" aria-label={stage.name} onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }} data-testid="stage-popover">
      <b>{stage.name}</b>
      <div className="jf-pop-row">{who ? <CalmAv name={who} size={28} /> : null}<span>{who ?? 'No owner'}{load ? <em className={`stg-hint ${load.tone}`}> · {load.label}</em> : null}</span></div>
      <div className="jf-pop-row quiet">{stage.plannedEnd ? `Due ${dm(stage.plannedEnd)}` : 'No date'}{isClosed(stage) ? ' · done' : ''}</div>
      {canEdit && <div className="jf-pop-acts">
        <button type="button" onClick={onOwner}>Change owner</button>
        <button type="button" onClick={() => { try { date.current?.showPicker?.(); } catch { date.current?.focus(); } }}>Move date</button>
        {!current && !isClosed(stage) && <button type="button" onClick={onCurrent}>Make current</button>}
        <input ref={date} type="date" className="jf-date" aria-label={`${stage.name} date`} value={stage.plannedEnd ?? ''}
          onChange={async (e) => { const r = await moveStageDate(projectId, stage, e.target.value || null); if (r) onSaved(r); }} />
      </div>}
    </div>
  );
}

/** A ring of `pct` percent at radius r. */
const Ring = ({ r, pct, cls }: { r: number; pct: number; cls: string }) => {
  const c = 2 * Math.PI * r;
  return <>
    <circle cx="60" cy="60" r={r} className={`jr-track ${cls}`} />
    <circle cx="60" cy="60" r={r} className={`jr-arc ${cls}`} strokeDasharray={`${(Math.min(100, Math.max(0, pct)) / 100) * c} ${c}`} transform="rotate(-90 60 60)" />
  </>;
};

/**
 * Concept C on a phone: three rings (Journey, Time used, Work done) with the current stage, its owner, days left and the forecast. Tapping
 * the card opens the stage list (owner chip → who owns it, date → picker, Move to next stage).
 */
function JourneyRings({ detail, tasks, canEdit }: { detail: ProjectDetail; tasks: Task[] | undefined; canEdit: boolean }) {
  const f = detail.forecast;
  const [open, setOpen] = useState(false);
  const stages = ordered(detail.stages);
  const cur = currentIndex(stages);
  const curStage = cur >= 0 ? stages[cur] : null;
  const owner = curStage?.ownerTeamName ?? curStage?.owner?.name ?? null;
  const late = (f?.slipDays ?? 0) > 0;
  const j = f?.journeyPct ?? Math.round((stages.filter(isClosed).length / stages.length) * 100);
  return (
    <>
      <button type="button" className="jr card" onClick={() => setOpen(true)} aria-label="Journey: open the stages" data-testid="journey-rings">
        <svg viewBox="0 0 120 120" className="jr-svg" aria-hidden="true">
          <Ring r={52} pct={j} cls="j" /><Ring r={39} pct={f?.timeUsedPct ?? 0} cls="t" /><Ring r={26} pct={f?.workDonePct ?? detail.project.progress} cls="w" />
        </svg>
        <span className="jr-text">
          <span className="jr-l j">Journey {j}% <small>· stage {f?.stageIndex ?? cur + 1} of {stages.length}</small></span>
          <span className="jr-l t">Time used {f?.timeUsedPct ?? 0}%</span>
          <span className="jr-l w">Work done {f?.workDonePct ?? detail.project.progress}%</span>
          {curStage && <span className="jr-now"><b>{curStage.name}</b> · {owner ? first(owner) : 'No owner'}{f?.daysLeft != null ? ` · ${f.daysLeft >= 0 ? `${f.daysLeft}d left` : `${-f.daysLeft}d over`}` : ''}</span>}
          {f?.forecast && <span className="jr-f">Likely <span className={late ? 'late' : ''}>{dm(f.forecast)}</span>{late && f.promised ? ` · promised ${dm(f.promised)}` : ''}</span>}
        </span>
      </button>
      <CalmSheet open={open} onClose={() => setOpen(false)} kind="bottom" title={detail.project.name} label="Stages">
        <div className="stg-pane"><StagesPane detail={detail} tasks={tasks} canEdit={canEdit} flash={() => {}} /></div>
      </CalmSheet>
    </>
  );
}

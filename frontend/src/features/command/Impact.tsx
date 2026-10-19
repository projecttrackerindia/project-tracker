import type { AgentImpact } from '../../api/types';
import { Icon } from '../../components/Icon';
import { formatDate } from '../../lib/format';

const DAY = 86_400_000;
const t = (iso: string) => new Date(`${iso}T00:00:00`).getTime();

/**
 * What a date change would move, drawn as a small timeline: one row per task, the old bar faint and the new one solid, the project's due
 * date as a line. Every row is labelled (key, owner, shift), so nothing depends on colour alone.
 */
export function ImpactView({ impact, compact }: { impact: AgentImpact; compact?: boolean }) {
  const rows = [
    { key: impact.key, title: impact.title, owner: null as string | null, oldDue: impact.oldDue, newDue: impact.newDue, shift: impact.slipDays, root: true },
    ...impact.moves.map((m) => ({ key: m.key, title: m.title, owner: m.owner, oldDue: m.oldDue, newDue: m.newDue, shift: m.shiftDays, root: false })),
  ].slice(0, compact ? 5 : 12);
  const dates = rows.flatMap((r) => [r.oldDue, r.newDue]).concat(impact.projectDue).filter((d): d is string => !!d).map(t);
  const min = Math.min(...dates) - DAY;
  const max = Math.max(...dates) + DAY;
  const span = Math.max(DAY * 3, max - min);
  const x = (iso: string) => `${((t(iso) - min) / span) * 100}%`;
  const tone = impact.level === 'high' ? 'danger' : impact.level === 'medium' ? 'warning' : 'success';
  const levelText = impact.level === 'high' ? 'Misses a date' : impact.level === 'medium' ? 'Moves other work' : impact.level === 'low' ? 'Only this task' : 'No change';

  return (
    <div className={`cmd-impact cmd-${tone}`}>
      <div className="cmd-impact-head">
        <span className="cmd-level"><Icon name={impact.level === 'high' ? 'alert' : impact.level === 'medium' ? 'layers' : 'checkCircle'} size={13} />{levelText}</span>
        {impact.projectSlipDays != null && impact.projectSlipDays > 0 && <span className="cmd-pill bad">Project +{impact.projectSlipDays}d</span>}
        {impact.moves.length > 0 && <span className="cmd-pill">{impact.moves.length} task{impact.moves.length === 1 ? '' : 's'} move</span>}
        {impact.projectDue && <span className="cmd-due-key"><i />Project due {formatDate(impact.projectDue)}</span>}
      </div>
      <p className="cmd-impact-summary">{impact.summary}</p>
      <div className="cmd-gantt" role="table" aria-label="Dates before and after">
        {rows.map((r) => (
          <div className="cmd-gantt-row" role="row" key={r.key}>
            <div className="cmd-gantt-label" role="cell">
              <b>{r.key}</b>{r.owner && <small>{r.owner.split(' ')[0]}</small>}
            </div>
            <div className="cmd-gantt-track" role="cell" title={`${r.key}: ${r.oldDue ? formatDate(r.oldDue) : 'no date'} → ${formatDate(r.newDue)}`}>
              {impact.projectDue && <i className="cmd-gantt-dueline" style={{ left: x(impact.projectDue) }} />}
              {r.oldDue && <i className="cmd-gantt-old" style={{ left: x(r.oldDue) }} />}
              {r.newDue && <i className={`cmd-gantt-new ${r.root ? 'root' : ''}`} style={{ left: x(r.newDue) }} />}
              {r.oldDue && r.newDue && r.oldDue !== r.newDue && (
                <i className="cmd-gantt-shift" style={{ left: r.oldDue < r.newDue ? x(r.oldDue) : x(r.newDue), width: `${(Math.abs(t(r.newDue) - t(r.oldDue)) / span) * 100}%` }} />
              )}
            </div>
            <div className="cmd-gantt-delta" role="cell">{r.shift > 0 ? `+${r.shift}d` : r.shift < 0 ? `${r.shift}d` : formatDate(r.newDue)}</div>
          </div>
        ))}
      </div>
      {!compact && impact.milestones.length > 0 && (
        <ul className="cmd-milestones">{impact.milestones.map((m) => <li key={m}><Icon name="flag" size={12} />{m}</li>)}</ul>
      )}
      {!compact && impact.people.length > 0 && <p className="cmd-impact-people"><Icon name="users" size={12} />Affects {impact.people.join(', ')}</p>}
    </div>
  );
}

import { Icon } from './Icon';
import { useTeamLens } from '../lib/teamLens';

/** "All teams" or one team: the dashboard, reports and Portfolio show that team's work. Shown only when there is a team to pick. */
export function TeamLensPicker({ compact }: { compact?: boolean }) {
  const { teams, teamId, setTeam, ready } = useTeamLens();
  if (!ready || teams.length === 0) return null;
  return (
    <label className={`lens-picker ${compact ? 'compact' : ''}`} title="Show the figures of one team, or of every team you can see">
      <Icon name="users" size={14} />
      <select aria-label="Team" value={teamId ?? ''} onChange={(e) => setTeam(e.target.value || null)}>
        <option value="">{teams.length > 1 ? 'All teams' : 'My team'}</option>
        {teams.length > 1 || teamId ? teams.map((t) => <option key={t.id} value={t.id}>{t.name} · {t.projects} project{t.projects === 1 ? '' : 's'}</option>) : null}
      </select>
    </label>
  );
}

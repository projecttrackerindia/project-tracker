import { useState } from 'react';
import { ApiError } from '../../api/client';
import { workspaceApi } from '../../api/endpoints';
import { ErrorState, PageLoader } from '../../components/ui';
import { useWsQuery } from '../../lib/hooks';
import { useCan } from '../../stores/auth';
import { toast } from '../../stores/ui';

/** Who sees which projects: the whole organization (the default), or each person's own teams plus the projects they own or were added to. */
export function ProjectVisibilityPanel() {
  const canManage = useCan('org.manage');
  const q = useWsQuery(['org', 'project-visibility'], workspaceApi.projectVisibility);
  const [busy, setBusy] = useState(false);
  if (q.isLoading) return <PageLoader />;
  if (q.isError || !q.data) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  const d = q.data;

  const choose = async (mode: 'organization' | 'teams') => {
    if (mode === d.mode || !canManage) return;
    setBusy(true);
    try { await workspaceApi.setProjectVisibility(mode); toast(mode === 'teams' ? 'People now see their own teams\' projects.' : 'Everyone sees every project again.'); void q.refetch(); }
    catch (e) { toast(e instanceof ApiError ? e.errors[0]?.message ?? e.message : 'Could not change who sees which projects.', 'error'); }
    finally { setBusy(false); }
  };

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="card-head"><div><h3>Who sees which projects</h3><p>Applies everywhere: projects, tasks, reports, search, chat, reminders and the AI assistant.</p></div></div>
      <div className="card-body">
        <div className="vis-options" role="radiogroup" aria-label="Who sees which projects">
          <button type="button" role="radio" aria-checked={d.mode === 'organization'} className={`vis-option ${d.mode === 'organization' ? 'on' : ''}`} disabled={!canManage || busy} onClick={() => choose('organization')}>
            <b>Everyone in the organization</b>
            <span>All members see all projects and their tasks. Guests only see the projects they were added to.</span>
          </button>
          <button type="button" role="radio" aria-checked={d.mode === 'teams'} className={`vis-option ${d.mode === 'teams' ? 'on' : ''}`} disabled={!canManage || busy} onClick={() => choose('teams')}>
            <b>Only their own teams</b>
            <span>A person sees the projects of the teams they belong to, plus the ones they own or were added to. Giving someone from another team a task shares that project with them. Owners and Admins see everything; any other role can be given "See every team's projects" in Access.</span>
          </button>
        </div>
        {d.mode === 'teams' && d.peopleWithoutTeam > 0 && (
          <div className="form-warn">{d.peopleWithoutTeam} {d.peopleWithoutTeam === 1 ? 'person is' : 'people are'} in no team, so they only see projects they own or were added to. Add them to a team under Teams.</div>
        )}
        {d.mode === 'teams' && d.teams === 0 && <div className="form-warn">There are no teams yet. Create teams and put people and projects in them so each team sees its own work.</div>}
        {!canManage && <p className="muted" style={{ marginTop: 8 }}>Only owners and admins can change this.</p>}
      </div>
    </div>
  );
}

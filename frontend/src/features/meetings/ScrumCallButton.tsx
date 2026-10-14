import { useState } from 'react';
import { projectApi } from '../../api/endpoints';
import { useWsQuery } from '../../lib/hooks';
import { useAuth } from '../../stores/auth';
import { Icon } from '../../components/Icon';
import { Modal, Field, ErrorState } from '../../components/ui';
import { ScheduleMeetingModal } from './GoogleMeetButton';

export function ScrumCallButton() {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [project, setProject] = useState<{ id: string; name: string } | null>(null);
  const me = useAuth(s => s.ctx!.user.id);
  const q = useWsQuery(['scrum-projects', search], () => projectApi.list({ q: search, pageSize: 50 }), { enabled: open });
  return <><button className="btn btn-primary" type="button" onClick={() => setOpen(true)}><Icon name="video" size={16} /> Scrum call</button>
    {open && !project && <Modal title="Schedule a scrum call" subtitle="Choose the project your team will discuss." onClose={() => setOpen(false)}>
      <Field label="Find a project"><input className="input" aria-label="Find a project" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search project names" /></Field>
      {q.isError ? <ErrorState error={q.error} retry={() => q.refetch()} /> : <div className="gm-picker">{q.data?.items.map(p => <button key={p.id} type="button" className="btn btn-ghost" onClick={() => setProject(p)}>{p.key} ? {p.name}</button>)}</div>}
      {q.isLoading && <p role="status">Loading projects...</p>}{!q.isLoading && q.data?.items.length === 0 && <p>No matching projects.</p>}
    </Modal>}
    {open && project && <ScheduleMeetingModal scrum projectId={project.id} projectName={project.name} organizerUserId={me} onClose={() => { setOpen(false); setProject(null); }} />}
  </>;
}

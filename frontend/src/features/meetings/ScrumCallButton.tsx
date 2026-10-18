import { useState } from 'react';
import { useAuth } from '../../stores/auth';
import { Icon } from '../../components/Icon';
import { ScheduleMeetingModal } from './GoogleMeetButton';

/**
 * The Calendar's "Scrum call": straight into the scheduling form, with the project as an optional field whose default is "No project",
 * so a daily stand-up can be set up for the team without first having to pick (or invent) a project for it.
 */
export function ScrumCallButton() {
  const [open, setOpen] = useState(false);
  const me = useAuth((s) => s.ctx!.user.id);
  return <>
    <button className="btn btn-primary" type="button" onClick={() => setOpen(true)}><Icon name="video" size={16} /> Scrum call</button>
    {open && <ScheduleMeetingModal scrum pickProject projectId={null} projectName={null} organizerUserId={me} onClose={() => setOpen(false)} />}
  </>;
}

import { useNavigate } from 'react-router-dom';
import { Icon, type IconName } from '../../components/Icon';
import { Sparkle } from '../ai/Assistant';

interface Step { icon: IconName; title: string; text: string; action: string; onClick: () => void; disabled?: boolean; ai?: boolean }

/**
 * What a brand-new person sees instead of a page of zeros: where to begin. Each step is one click; the page turns into the normal
 * dashboard on its own as soon as the first project exists.
 */
export function GettingStarted({ personal, ai, canCreateProject, onCreateProject }: { personal: boolean; ai: boolean; canCreateProject: boolean; onCreateProject: () => void }) {
  const nav = useNavigate();
  const steps: Step[] = [
    { icon: 'folder', title: 'Create your first project', text: 'Give it a name and a due date. Everything else already has a sensible default.', action: 'New project', onClick: onCreateProject, disabled: !canCreateProject },
    { icon: 'checkCircle', title: 'Add the first tasks', text: 'Break the project into tasks, assign them and set dates. You can drag them across the board as work moves.', action: 'Open projects', onClick: () => nav('/projects') },
    ...(!personal ? [{ icon: 'userPlus' as IconName, title: 'Bring your team in', text: 'Invite people by e-mail, or create their accounts yourself and share a temporary password.', action: 'Invite people', onClick: () => nav('/people/invitations') }] : []),
    ...(ai ? [{ icon: 'sparkle' as IconName, title: 'Ask the assistant', text: 'Describe the work in plain words, for example "plan a website relaunch for 30 November", and review what it proposes.', action: 'Open the assistant', onClick: () => nav('/ai'), ai: true }] : []),
  ];
  return (
    <div className="gs">
      <ol className="gs-steps">
        {steps.map((s, i) => (
          <li key={s.title} className="gs-step">
            <span className="gs-num">{i + 1}</span>
            <span className="gs-ico">{s.ai ? <Sparkle size={18} /> : <Icon name={s.icon} size={18} />}</span>
            <div className="gs-text"><b>{s.title}</b><span>{s.text}</span></div>
            <button type="button" className={`btn ${i === 0 ? 'btn-primary' : 'btn-soft'} btn-sm`} disabled={s.disabled} onClick={s.onClick}>{s.action}</button>
          </li>
        ))}
      </ol>
      <p className="gs-foot">Tip: press <kbd>Ctrl</kbd> + <kbd>K</kbd> any time to search or jump to a page.</p>
    </div>
  );
}

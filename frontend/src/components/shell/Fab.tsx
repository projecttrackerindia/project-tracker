import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Icon, type IconName } from '../Icon';
import { openNew } from '../v2/state';
import { openSchedule } from '../../features/meet/scheduleStore';
import { haptic, useIsMobile } from '../../lib/mobile';
import { useCan, useModule } from '../../stores/auth';
import { runCreate, type CreateKind } from './createHook';
import './shell.css';

interface Item { kind: CreateKind; label: string; icon: IconName; show: boolean; run: () => void }

/**
 * The floating + button (bottom right; above the tab bar on a phone). The + turns to × with the spring, the page blurs softly behind it,
 * and the menu offers New task, New project, Schedule meeting, New doc and Request approval, each opening the existing create flow (or a
 * page agent's sheet registered through createHook). Esc or a click outside closes it.
 */
export function Fab() {
  const [open, setOpen] = useState(false);
  const nav = useNavigate();
  const { pathname } = useLocation();
  const phone = useIsMobile();
  const root = useRef<HTMLDivElement>(null);
  const permProject = useCan('projects.create');
  const modProjects = useModule('projects');
  const canProject = permProject && modProjects >= 2;
  const docs = useModule('documents') > 0;
  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [open]);
  useEffect(() => { document.documentElement.classList.toggle('fab-open', open); return () => document.documentElement.classList.remove('fab-open'); }, [open]);
  // A conversation on a phone owns the bottom edge (its composer): no + there.
  if (phone && /^\/messages\/[^/]+/.test(pathname)) return null;
  const all: Item[] = [
    { kind: 'task', label: 'New task', icon: 'checkCircle', show: true, run: () => openNew(null) /* the sheet still understands the words (a task unless they say otherwise) */ },
    { kind: 'project', label: 'New project', icon: 'folder', show: canProject, run: () => nav('/work/projects?new=1') },
    { kind: 'meeting', label: 'Schedule meeting', icon: 'calendar', show: true, run: () => openSchedule() },
    { kind: 'doc', label: 'New doc', icon: 'layers', show: docs, run: () => openNew('doc') },
    { kind: 'approval', label: 'Request approval', icon: 'shield', show: true, run: () => nav('/approvals?new=1') },
  ];
  const items = all.filter((i) => i.show);
  const pick = (i: Item) => { setOpen(false); haptic(6); runCreate(i.kind, i.run); };
  return (
    <div ref={root} className={`shell-fab${open ? ' on' : ''}`} data-testid="fab">
      <div className="shell-fab-scrim" aria-hidden="true" onClick={() => setOpen(false)} />
      <div className="shell-fab-menu" role="menu" aria-label="Create" aria-hidden={!open}>
        {items.map((i, n) => (
          <button key={i.kind} type="button" role="menuitem" tabIndex={open ? 0 : -1} data-create={i.kind} style={{ '--i': items.length - 1 - n } as React.CSSProperties} onClick={() => pick(i)}>
            {i.label}<span><Icon name={i.icon} size={16} /></span>
          </button>
        ))}
      </div>
      <button type="button" className="shell-fab-btn" aria-label={open ? 'Close' : 'Create'} aria-expanded={open} aria-haspopup="menu" onClick={() => { haptic(6); setOpen((o) => !o); }}>
        <Icon name="plus" size={22} />
      </button>
    </div>
  );
}

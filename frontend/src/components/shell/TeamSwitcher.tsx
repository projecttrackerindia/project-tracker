import { useRef, useState, type ReactNode } from 'react';
import { Icon } from '../Icon';
import { Logo } from '../Logo';
import { Sheet } from '../Sheet';
import { Popover } from '../../lib/popover';
import { haptic, useIsMobile } from '../../lib/mobile';
import { useTeamLens } from '../../lib/teamLens';
import { useAuth } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { CreateOrganizationModal } from '../../layouts/parts';

const TONES = ['#7c5cff', '#2f7bff', '#0ea5e9', '#f59e0b', '#10b981', '#ef4444', '#ec4899', '#14b8a6'];
const tone = (s: string) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return TONES[h % TONES.length]; };
const Mark = ({ name }: { name: string }) => <span className="ts-mark" style={{ background: tone(name) }} aria-hidden="true">{name.trim()[0]?.toUpperCase() ?? '?'}</span>;

/**
 * The workspace control at the top left of the header (approved mockup header-options-2): the purple check logo, the workspace name with a
 * ▾, and "Role · Team" under it. A tap opens the team switcher: WORKSPACE (each with a ✓ on the current one) and TEAMS (only the teams this
 * person may pick; the server decides by role and membership). Choosing switches instantly. A sheet on a phone, a popover on desktop.
 */
export function TeamSwitcher({ compact = false }: { compact?: boolean }) {
  const ctx = useAuth((s) => s.ctx)!;
  const phone = useIsMobile();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const { team } = useTeamLens();
  const cur = ctx.current;
  const role = cur?.type === 'Personal' ? 'Personal' : cur?.role ?? '';
  const sub = [role, team?.name ?? (cur?.type === 'Personal' ? null : 'All teams')].filter(Boolean).join(' · ');
  return (
    <>
      <button ref={trigger} type="button" className={`ts-btn${compact ? ' compact' : ''}`} data-testid="team-switcher" aria-haspopup="dialog" aria-expanded={open}
        aria-label={`${cur?.name ?? 'Workspace'}, ${sub}. Switch workspace or team`} onClick={() => { haptic(); setOpen((o) => !o); }}>
        <span className="ts-logo"><Logo size={compact ? 28 : 34} /></span>
        <span className="ts-text"><b>{cur?.name ?? 'Workspace'}<span className={`ts-caret${open ? ' up' : ''}`} aria-hidden="true">▾</span></b><small>{sub}</small></span>
      </button>
      {open && (phone
        ? <Sheet title="Switch" onClose={() => setOpen(false)}><SwitchList onDone={() => setOpen(false)} /></Sheet>
        : <Popover open onClose={() => setOpen(false)} anchorRef={trigger} role="dialog" aria-label="Switch workspace or team" className="ts-pop" side="bottom" align="start" gap={8}>
            <SwitchList onDone={() => setOpen(false)} />
          </Popover>)}
    </>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return <section className="ts-group"><h4>{title}</h4><ul role="list">{children}</ul></section>;
}

export function SwitchList({ onDone }: { onDone: () => void }) {
  const ctx = useAuth((s) => s.ctx)!;
  const switchWorkspace = useAuth((s) => s.switchWorkspace);
  const { teams, teamId, setTeam, ready } = useTeamLens();
  const [creating, setCreating] = useState(false);
  const cur = ctx.current;
  const role = cur?.role ?? '';
  const pickWs = async (id: string) => {
    onDone();
    if (id === cur?.id) return;
    try { await switchWorkspace(id); } catch { toast('Could not switch workspace.', 'error'); }
  };
  const pickTeam = (id: string | null) => { haptic(); setTeam(id); onDone(); };
  return (
    <div className="ts-list" data-testid="team-switcher-sheet">
      <Group title="Workspace">
        {ctx.workspaces.map((w) => (
          <li key={w.id}><button type="button" className="ts-row" aria-current={w.id === cur?.id ? 'true' : undefined} onClick={() => void pickWs(w.id)}>
            <Mark name={w.name} /><span className="ts-row-t">{w.name}<small>{w.type === 'Personal' ? 'Personal' : w.role}</small></span>{w.id === cur?.id && <Icon name="tick" size={17} />}
          </button></li>
        ))}
        <li><button type="button" className="ts-row add" onClick={() => setCreating(true)}><span className="ts-mark ghost"><Icon name="plus" size={15} /></span><span className="ts-row-t">Create organization</span></button></li>
      </Group>
      {ready && teams.length > 0 && cur?.type !== 'Personal' && (
        <Group title="Teams">
          <li><button type="button" className="ts-row" aria-current={!teamId ? 'true' : undefined} onClick={() => pickTeam(null)}>
            <span className="ts-mark ghost"><Icon name="layers" size={15} /></span><span className="ts-row-t">All teams<small>Everything you can see</small></span>{!teamId && <Icon name="tick" size={17} />}
          </button></li>
          {teams.map((t) => (
            <li key={t.id}><button type="button" className="ts-row" aria-current={teamId === t.id ? 'true' : undefined} onClick={() => pickTeam(t.id)}>
              <Mark name={t.name} /><span className="ts-row-t">{t.name} · {role}<small>{t.projects} project{t.projects === 1 ? '' : 's'} · {t.members} {t.members === 1 ? 'person' : 'people'}</small></span>{teamId === t.id && <Icon name="tick" size={17} />}
            </button></li>
          ))}
        </Group>
      )}
      {creating && <CreateOrganizationModal onClose={() => { setCreating(false); onDone(); }} />}
    </div>
  );
}

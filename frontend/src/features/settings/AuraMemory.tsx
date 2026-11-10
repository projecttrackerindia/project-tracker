import { useState } from 'react';
import { ApiError } from '../../api/client';
import { CalmCard, CalmRow } from '../../components/calm';
import { Icon } from '../../components/Icon';
import { PageHead, PageLoader } from '../../components/ui';
import { timeAgo } from '../../lib/format';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';
import { aiWorkspaceApi, type AiMemory } from '../ai/aiApi';
import { groupMemories } from './auraMemoryGroups';
import './auraMemory.css';

const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.errors[0]?.message ?? e.message : fallback);

/** Who may remove a memory they can see but do not own, in a few words. */
const WHO_REMOVES: Record<AiMemory['scope'], string> = { Person: 'Only you', Team: 'Team lead or admin', Workspace: 'Admins' };

/**
 * Settings › Aura memory: everything Aura remembers about how this person, their teams and the workspace like to work - grouped by who it
 * belongs to, with delete on each line and "Forget everything". Aura saves a memory only from a card the person confirmed in the chat; this
 * page is where it is seen and removed. Owners and admins also decide here whether Aura remembers at all and whether workspace-wide notes are used.
 */
export function AuraMemory() {
  const wid = useWorkspaceId();
  const q = useWsQuery(['ai', 'memories'], aiWorkspaceApi.memories, { staleTime: 15_000 });
  const [busy, setBusy] = useState<string | null>(null);
  if (q.isLoading) return <PageLoader />;
  if (q.isError || !q.data) return <CalmCard><p className="mem-note">Aura’s memory could not be loaded. Try again in a moment.</p></CalmCard>;
  const { items, settings } = q.data;
  const groups = groupMemories(items);
  const mineCount = items.filter((m) => m.scope === 'Person').length;

  const run = async (key: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(key);
    try { await fn(); await invalidateWorkspace(wid, 'ai', 'memories'); toast(done); }
    catch (e) { toast(errText(e, 'Could not do that.'), 'error'); }
    finally { setBusy(null); }
  };
  const forgetEverything = async () => {
    const ok = await confirmDialog({ title: 'Forget everything?', message: `Aura will forget all ${mineCount} of your own memories. Team and workspace memories stay. This cannot be undone.`, confirmText: 'Forget everything', danger: true });
    if (ok) await run('all', () => aiWorkspaceApi.forgetAllMemories('person'), 'Aura has forgotten everything about you.');
  };
  const forgetWorkspace = async () => {
    const ok = await confirmDialog({ title: 'Forget the workspace’s memories?', message: 'Everyone in the workspace loses these notes. This cannot be undone.', confirmText: 'Forget them', danger: true });
    if (ok) await run('workspace', () => aiWorkspaceApi.forgetAllMemories('workspace'), 'Workspace memories forgotten.');
  };

  return (
    <div className="mem">
      <PageHead title="Aura memory" sub="What Aura remembers about how you and your teams like to work. You can see all of it and delete any of it.">
        {mineCount > 0 && <button type="button" className="btn btn-ghost btn-sm mem-danger" disabled={busy !== null} onClick={() => void forgetEverything()}>Forget everything</button>}
      </PageHead>
      {!settings.enabled && (
        <p className="mem-banner" role="status"><Icon name="lock" size={14} /> An admin switched Aura’s memory off for this workspace. Nothing below is being used or saved; you can still delete it.</p>
      )}
      <div className="mem-grid">
        <div className="mem-main">
          {groups.length === 0 ? (
            <CalmCard className="mem-empty">
              <span className="mem-orb" aria-hidden="true"><Icon name="sparkle" size={18} /></span>
              <p>Aura remembers nothing yet. Tell it “remember that I prefer short answers”, confirm the card, and it shows up here.</p>
            </CalmCard>
          ) : groups.map((g) => (
            <CalmCard key={g.key} variant="list" className="mem-group">
              <div className="mem-group-head">
                <span className="mem-ico" aria-hidden="true"><Icon name={g.icon} size={14} /></span>
                <h3>{g.label}</h3>
                <span className="mem-count">{g.items.length}</span>
                {g.forgetAll === 'workspace' && settings.canManage && <button type="button" className="mem-link" disabled={busy !== null} onClick={() => void forgetWorkspace()}>Forget all</button>}
              </div>
              {g.items.map((m) => (
                <CalmRow key={m.id} className="mem-row" title={m.text}
                  meta={`${m.source === 'Suggested' ? 'Aura suggested' : 'You asked'} · ${m.lastUsedAt ? `used ${timeAgo(m.lastUsedAt)}` : `saved ${timeAgo(m.createdAt)}`}`}
                  right={m.canDelete
                    ? <button type="button" className="mem-del" disabled={busy !== null} aria-label={`Forget: ${m.text}`} title="Forget this" onClick={() => void run(m.id, () => aiWorkspaceApi.forgetMemory(m.id), 'Forgotten.')}><Icon name="trash" size={15} /></button>
                    : <span className="mem-who" title="Who can remove it"><Icon name="lock" size={12} /> {WHO_REMOVES[m.scope]}</span>} />
              ))}
            </CalmCard>
          ))}
        </div>
        <aside className="mem-side">
          <CalmCard title="How it works" className="mem-how">
            <ul>
              <li><Icon name="check" size={14} /><span><b>You decide.</b> Aura saves a memory only when you confirm its card. It never saves on its own.</span></li>
              <li><Icon name="lock" size={14} /><span><b>Never sensitive.</b> Passwords, keys, card and ID numbers, health, immigration, religion and politics are refused.</span></li>
              <li><Icon name="eye" size={14} /><span><b>Seen by the right people.</b> Yours only by you, a team’s by its members, the workspace’s by everyone in it.</span></li>
            </ul>
          </CalmCard>
          {settings.canManage && (
            <CalmCard title="Workspace controls" className="mem-admin">
              <SwitchRow label="Aura can remember" sub="On by default. Off stops all memory being saved or used here." on={settings.enabled} busy={busy === 'enabled'}
                onChange={() => void run('enabled', () => aiWorkspaceApi.setMemorySettings({ enabled: !settings.enabled }), settings.enabled ? 'Aura’s memory is off.' : 'Aura’s memory is on.')} />
              <SwitchRow label="Workspace-wide memories" sub="Off until you turn it on. Lets admins save notes everyone’s Aura uses." on={settings.workspaceEnabled} busy={busy === 'workspace-switch'} disabled={!settings.enabled}
                onChange={() => void run('workspace-switch', () => aiWorkspaceApi.setMemorySettings({ workspaceEnabled: !settings.workspaceEnabled }), settings.workspaceEnabled ? 'Workspace memories are off.' : 'Workspace memories are on.')} />
            </CalmCard>
          )}
        </aside>
      </div>
    </div>
  );
}

function SwitchRow({ label, sub, on, busy, disabled, onChange }: { label: string; sub: string; on: boolean; busy: boolean; disabled?: boolean; onChange: () => void }) {
  return (
    <div className="mem-switch">
      <div><b>{label}</b><span>{sub}</span></div>
      <button type="button" className={`switch ${on ? 'on' : ''}`} role="switch" aria-checked={on} aria-label={label} disabled={busy || disabled} onClick={onChange} />
    </div>
  );
}

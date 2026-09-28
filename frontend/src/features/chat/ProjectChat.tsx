import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { chatApi } from '../../api/endpoints';
import { ApiError } from '../../api/client';
import type { ProjectChatUnread } from '../../api/types';
import { Icon } from '../../components/Icon';
import { PageLoader } from '../../components/ui';
import { useAuth, useWorkspaceId } from '../../stores/auth';
import { chatKeys } from './chatStore';
import { useProjectChat, type ProjectChatTarget } from './projectChatStore';
import { Thread } from './Thread';

// ------------------------------------------------------------------ what is open
export { useProjectChat };
type Target = ProjectChatTarget;

/** People who can chat: organization workspaces, not guests, not platform administrators (the same rule as the rest of chat). */
export function useChatEnabled() {
  return useAuth((s) => !!s.ctx?.current && s.ctx.current.type !== 'Personal' && s.ctx.current.role !== 'Guest' && !s.ctx.user.isPlatformAdmin);
}

/** Which projects have unread chat messages for me (and how many mention me), keyed by project. */
export function useProjectChatUnread(): Record<string, ProjectChatUnread> {
  const wid = useWorkspaceId();
  const on = useChatEnabled();
  const q = useQuery({ queryKey: chatKeys.projectUnread(wid ?? ''), queryFn: () => chatApi.projectUnread(), enabled: !!wid && on, refetchInterval: 90_000, staleTime: 30_000 });
  const out: Record<string, ProjectChatUnread> = {};
  for (const u of q.data ?? []) out[u.projectId] = u;
  return out;
}

// ------------------------------------------------------------------ the chat icon of a project
/**
 * The chat icon of a project. A number shows how many messages are unread; an @ (in the accent colour) means one of them mentions you.
 * `label` shows the word "Chat" beside the icon (the project page); without it, it is just the icon (project cards).
 */
export function ProjectChatButton({ projectId, name, label }: { projectId: string; name: string; label?: boolean }) {
  const enabled = useChatEnabled();
  const unread = useProjectChatUnread()[projectId];
  const openChat = useProjectChat((s) => s.openChat);
  if (!enabled) return null;
  const mentioned = (unread?.mentions ?? 0) > 0;
  const title = mentioned ? `Team chat: you were mentioned` : unread ? `Team chat: ${unread.unread} unread` : 'Team chat';
  return (
    <button type="button" className={`${label ? 'btn btn-ghost' : 'btn-icon'} pchat-btn ${mentioned ? 'mentioned' : ''}`} title={title}
      aria-label={`Open the ${name} team chat${unread ? `, ${mentioned ? 'you were mentioned' : `${unread.unread} unread`}` : ''}`}
      onClick={(e) => { e.stopPropagation(); openChat(projectId, name); }}
      onKeyDown={(e) => e.stopPropagation()}>
      <Icon name="message" size={label ? 16 : 17} />
      {label && <span>Chat</span>}
      {unread && <span className={`pchat-badge ${mentioned ? 'mention' : ''}`} aria-hidden="true">{mentioned ? '@' : unread.unread > 99 ? '99+' : unread.unread}</span>}
    </button>
  );
}

// ------------------------------------------------------------------ the slide-in panel
const SLIDE_MS = 260;

/** Mounted once for the whole app: slides the open project's chat in from the right, and back out when it is closed. */
export function ProjectChatHost() {
  const target = useProjectChat((s) => s.target);
  const close = useProjectChat((s) => s.close);
  const [shown, setShown] = useState<Target | null>(null);   // kept on screen while the panel slides out
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (target) {
      setShown(target);
      const raf = requestAnimationFrame(() => requestAnimationFrame(() => setOpen(true)));   // one frame off-screen first, so it slides in
      return () => cancelAnimationFrame(raf);
    }
    setOpen(false);
    const t = window.setTimeout(() => setShown(null), SLIDE_MS);
    return () => window.clearTimeout(t);
  }, [target]);

  useEffect(() => {
    if (!target) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented) close(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [target, close]);

  if (!shown) return null;
  return (
    <div className={`pchat-root ${open ? 'open' : ''}`}>
      <div className="pchat-backdrop" onClick={close} aria-hidden="true" />
      <aside className="pchat-panel" role="dialog" aria-label={`${shown.name} team chat`}>
        <PanelBody key={shown.projectId} target={shown} onClose={close} />
      </aside>
    </div>
  );
}

function PanelBody({ target, onClose }: { target: Target; onClose: () => void }) {
  const wid = useWorkspaceId()!;
  const q = useQuery({ queryKey: chatKeys.project(wid, target.projectId), queryFn: () => chatApi.openProject(target.projectId), staleTime: 30_000, retry: false });

  if (q.isLoading) return <div className="pchat-state"><PageLoader /></div>;
  if (q.isError || !q.data) {
    const denied = q.error instanceof ApiError && (q.error.status === 404 || q.error.status === 403);
    return (
      <div className="pchat-state">
        <Icon name="lock" size={28} />
        <h3>{denied ? 'This chat is not available to you' : 'The chat could not be opened'}</h3>
        <p>{denied ? 'Only the people working on the project, its owner, and the organization’s Owners, Admins and Managers can use its team chat.' : 'Please try again in a moment.'}</p>
        <div className="row" style={{ gap: 8 }}>
          {!denied && <button className="btn btn-ghost" onClick={() => void q.refetch()}>Try again</button>}
          <button className="btn btn-primary" onClick={onClose}>Close</button>
        </div>
      </div>
    );
  }
  return <Thread conversation={q.data} variant="panel" onBack={onClose} onClose={onClose} />;
}

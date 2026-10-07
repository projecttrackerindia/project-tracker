import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { chatApi, workspaceApi } from '../../api/endpoints';
import { ApiError } from '../../api/client';
import { Avatar, ErrorState, Modal, PageLoader } from '../../components/ui';
import { Icon } from '../../components/Icon';
import { toast } from '../../stores/ui';
import { formatDate } from '../../lib/format';

const ROLE_LABEL: Record<string, string> = { Owner: 'Owner', Admin: 'Admin', Manager: 'Manager', Member: 'Member', Guest: 'Guest' };

/**
 * Someone's profile card: photo, name, team(s) and job role, who they report to, how their work is going.
 * Editing is never done here - it only ever happens on the person's own Settings page.
 */
export function MemberProfileModal({ userId, onClose }: { userId: string; onClose: () => void }) {
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ['member-profile', userId], queryFn: () => workspaceApi.memberProfile(userId), staleTime: 30_000 });

  const message = async () => {
    try {
      const c = await chatApi.openDirect(userId);
      onClose();
      navigate(`/chat/${c.id}`);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Could not open the chat.', 'error');
    }
  };

  const p = q.data;
  return (
    <Modal size="sm" title={p?.displayName ?? 'Profile'} onClose={onClose}
      footer={p && (p.isMe
        ? <button className="btn btn-ghost" onClick={() => { onClose(); navigate('/account'); }}><Icon name="edit" size={14} /> Edit in Settings</button>
        : p.canMessage ? <button className="btn btn-primary" onClick={message}><Icon name="message" size={14} /> Message</button> : null)}>
      {q.isLoading && <PageLoader />}
      {q.isError && <ErrorState error={q.error} />}
      {p && (
        <div className="member-card">
          <div className="member-card-banner" style={p.jobRoleColor ? { background: `linear-gradient(135deg, ${p.jobRoleColor}, var(--accent))` } : undefined} />
          <div className="member-card-head">
            <Avatar name={p.displayName} size="lg" userId={p.userId} hasAvatar={p.hasAvatar} />
            <div>
              <h4>{p.displayName}</h4>
              <span className="member-card-sub">
                {p.jobRole ?? ROLE_LABEL[p.role]}
                {p.teams.length > 0 && ` · ${p.teams.map((t) => t.name).join(', ')}`}
              </span>
            </div>
          </div>
          {p.email && <div className="member-card-row"><Icon name="mail" size={14} /><a href={`mailto:${p.email}`}>{p.email}</a></div>}
          {p.reportsTo && <div className="member-card-row"><Icon name="user" size={14} /><span>Reports to {p.reportsTo.name}</span></div>}
          <div className="member-card-row"><Icon name="calendar" size={14} /><span>Joined {formatDate(p.joinedAt)}</span></div>
          <div className="member-card-stats">
            <div><b>{p.open}</b><small>Open</small></div>
            <div><b>{p.overdue}</b><small>Overdue</small></div>
            <div><b>{p.doneLast30Days}</b><small>Done (30d)</small></div>
            <div><b>{p.doneTotal}</b><small>Done total</small></div>
          </div>
        </div>
      )}
    </Modal>
  );
}

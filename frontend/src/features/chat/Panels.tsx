import { useEffect, useMemo, useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { chatApi } from '../../api/endpoints';
import { ApiError } from '../../api/client';
import type { ChatFile, ChatPerson, Conversation } from '../../api/types';
import { Icon } from '../../components/Icon';
import { Avatar, EmptyState, Field, Modal, PageLoader, Spinner, Tabs } from '../../components/ui';
import { formatDateTime } from '../../lib/format';
import { queryClient, useAuth, useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';
import { chatKeys, useChat } from './chatStore';
import { MemberProfileModal } from '../people/MemberProfileModal';

const errorText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

function usePeople() {
  const wid = useWorkspaceId()!;
  const seed = useChat((s) => s.seedOnline);
  return useQuery({
    queryKey: chatKeys.people(wid),
    queryFn: async () => { const list = await chatApi.people(); seed(list); return list; },
    staleTime: 60_000,
  });
}

/** A person with a presence dot: online comes from live events, falling back to what the server said when it was last asked. */
export function PersonAvatar({ name, userId, fallback, hasAvatar }: { name: string; userId: string; fallback: boolean; hasAvatar?: boolean }) {
  const online = useChat((s) => s.online[userId]) ?? fallback;
  return <span className="avatar-wrap"><Avatar name={name} size="sm" userId={userId} hasAvatar={hasAvatar} />{online && <i className="presence-dot" aria-label="Online" />}</span>;
}

// ------------------------------------------------------------------ people picker
function PeoplePicker({ people, multiple, selected, onToggle, onPick, emptyText }: {
  people: ChatPerson[]; multiple: boolean; selected: string[]; onToggle: (id: string) => void; onPick: (p: ChatPerson) => void; emptyText: string;
}) {
  const [q, setQ] = useState('');
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return needle ? people.filter((p) => p.name.toLowerCase().includes(needle) || p.email.toLowerCase().includes(needle)) : people;
  }, [people, q]);
  return (
    <div className="picker">
      <div className="search-box"><Icon name="search" size={15} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search people" aria-label="Search people" /></div>
      <ul className="picker-list">
        {shown.map((p) => {
          const on = selected.includes(p.userId);
          return (
            <li key={p.userId}>
              <button type="button" className={`picker-row ${on ? 'on' : ''}`} onClick={() => (multiple ? onToggle(p.userId) : onPick(p))} aria-pressed={multiple ? on : undefined}>
                <PersonAvatar name={p.name} userId={p.userId} fallback={p.online} hasAvatar={p.hasAvatar} />
                <span className="picker-text"><b>{p.name}</b><small>{p.email}</small></span>
                {multiple && <span className={`check ${on ? 'on' : ''}`}>{on && <Icon name="tick" size={12} />}</span>}
              </button>
            </li>
          );
        })}
        {shown.length === 0 && <li className="picker-empty">{people.length === 0 ? emptyText : 'Nobody matches your search.'}</li>}
      </ul>
    </div>
  );
}

// ------------------------------------------------------------------ start a conversation
export function NewChatModal({ onClose }: { onClose: () => void }) {
  const wid = useWorkspaceId()!;
  const navigate = useNavigate();
  const people = usePeople();
  const [tab, setTab] = useState<'direct' | 'group'>('direct');
  const [name, setName] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const done = (c: Conversation) => {
    queryClient.setQueryData<Conversation[]>(chatKeys.conversations(wid), (old) => [c, ...(old ?? []).filter((x) => x.id !== c.id)]);
    void queryClient.invalidateQueries({ queryKey: chatKeys.conversations(wid) });
    onClose();
    navigate(`/chat/${c.id}`);
  };
  const open = useMutation({ mutationFn: (userId: string) => chatApi.openDirect(userId), onSuccess: done, onError: (e) => toast(errorText(e, 'Could not open the chat.'), 'error') });
  const create = useMutation({
    mutationFn: () => chatApi.createGroup(name.trim(), picked),
    onSuccess: done,
    onError: (e) => setError(errorText(e, 'Could not create the group.')),
  });
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const chosen = (people.data ?? []).filter((p) => picked.includes(p.userId));

  return (
    <Modal title="New conversation" subtitle="Message one person, or start a group." onClose={onClose}
      onSubmit={(e) => { e.preventDefault(); if (tab === 'group' && name.trim().length >= 2 && picked.length > 0 && !create.isPending) { setError(null); create.mutate(); } }}
      footer={tab === 'group' ? (
        <>
          <button className="btn" type="button" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" type="submit" disabled={create.isPending || name.trim().length < 2 || picked.length === 0}>Create group{picked.length ? ` (${picked.length + 1})` : ''}</button>
        </>
      ) : undefined}>
      <Tabs tabs={[{ id: 'direct', label: 'Direct message', icon: 'user' }, { id: 'group', label: 'New group', icon: 'users' }]} value={tab} onChange={(t) => { setTab(t); setError(null); }} />
      <div style={{ marginTop: 14 }}>
        {people.isLoading && <PageLoader />}
        {people.isError && <p className="field-error">The list of people could not be loaded.</p>}
        {people.data && tab === 'group' && (
          <Field label="Group name" required error={error ?? undefined} hint="For example “Launch team” or “Design reviews”.">
            <input className="input" value={name} maxLength={60} onChange={(e) => { setName(e.target.value); setError(null); }} placeholder="Group name" />
          </Field>
        )}
        {people.data && tab === 'group' && chosen.length > 0 && (
          <div className="chat-chips">{chosen.map((p) => (
            <span className="chat-chip" key={p.userId}>{p.name}<button type="button" onClick={() => toggle(p.userId)} aria-label={`Remove ${p.name}`}><Icon name="close" size={11} /></button></span>
          ))}</div>
        )}
        {people.data && (
          <PeoplePicker people={people.data} multiple={tab === 'group'} selected={picked} onToggle={toggle}
            onPick={(p) => open.mutate(p.userId)} emptyText="There is nobody else in this workspace yet. Invite people from Members." />
        )}
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ add people to a group
function AddPeopleModal({ conversation, onClose }: { conversation: Conversation; onClose: () => void }) {
  const wid = useWorkspaceId()!;
  const people = usePeople();
  const [picked, setPicked] = useState<string[]>([]);
  const inGroup = new Set(conversation.members.map((m) => m.userId));
  const candidates = (people.data ?? []).filter((p) => !inGroup.has(p.userId));
  const add = useMutation({
    mutationFn: () => chatApi.addMembers(conversation.id, picked),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: chatKeys.conversations(wid) }); void queryClient.invalidateQueries({ queryKey: chatKeys.thread(wid, conversation.id) }); onClose(); },
    onError: (e) => toast(errorText(e, 'Could not add people.'), 'error'),
  });
  return (
    <Modal title="Add people" subtitle={`to ${conversation.name}. They see messages from now on, not earlier ones.`} onClose={onClose}
      onSubmit={(e) => { e.preventDefault(); if (picked.length) add.mutate(); }}
      footer={<><button className="btn" type="button" onClick={onClose}>Cancel</button><button className="btn btn-primary" type="submit" disabled={!picked.length || add.isPending}>Add{picked.length ? ` (${picked.length})` : ''}</button></>}>
      {people.isLoading ? <PageLoader /> : (
        <PeoplePicker people={candidates} multiple selected={picked} onToggle={(id) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]))}
          onPick={() => undefined} emptyText="Everyone in the workspace is already in this group." />
      )}
    </Modal>
  );
}

// ------------------------------------------------------------------ files shared in the open conversation
function fileSize(bytes: number) { return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`; }

function FilesRow({ file }: { file: ChatFile }) {
  const [busy, setBusy] = useState(false);
  const [thumb, setThumb] = useState<string | null>(null);
  useEffect(() => {
    if (!file.isImage) return;
    let live = true; let made: string | null = null;
    chatApi.fileUrl(file.id, true).then((u) => { made = u; if (live) setThumb(u); else URL.revokeObjectURL(u); }).catch(() => undefined);
    return () => { live = false; if (made) URL.revokeObjectURL(made); };
  }, [file.id, file.isImage]);
  const save = async () => {
    setBusy(true);
    try {
      const url = await chatApi.fileUrl(file.id);
      const a = document.createElement('a'); a.href = url; a.download = file.fileName; document.body.appendChild(a); a.click(); a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch { toast('Could not download the file.', 'error'); }
    finally { setBusy(false); }
  };
  return (
    <li className="chat-filerow">
      <span className="chat-filerow-icon">{thumb ? <img src={thumb} alt="" /> : <Icon name="paperclip" size={16} />}</span>
      <span className="chat-filerow-meta">
        <b title={file.fileName}>{file.fileName}</b>
        <small>{file.senderName} · {fileSize(file.sizeBytes)} · {formatDateTime(file.createdAt)}</small>
      </span>
      <button type="button" className="btn-icon" onClick={() => void save()} disabled={busy} aria-label={`Download ${file.fileName}`} title="Download">
        {busy ? <Spinner /> : <Icon name="download" size={15} />}
      </button>
    </li>
  );
}

export function FilesPanel({ conversation, onClose }: { conversation: Conversation; onClose: () => void }) {
  const wid = useWorkspaceId()!;
  const q = useInfiniteQuery({
    queryKey: chatKeys.files(wid, conversation.id),
    queryFn: ({ pageParam }: { pageParam?: string }) => chatApi.files(conversation.id, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (last.hasMore ? last.items[last.items.length - 1]?.createdAt : undefined),
  });
  const files = q.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <aside className="chat-info" aria-label="Files shared in this conversation">
      <div className="chat-info-head">
        <h3>Files</h3>
        <button className="btn-icon" onClick={onClose} aria-label="Close files"><Icon name="close" /></button>
      </div>
      <div className="chat-info-body">
        {q.isLoading && <PageLoader />}
        {q.isError && <div className="chat-note">Files could not be loaded. <button className="link-btn" onClick={() => void q.refetch()}>Try again</button></div>}
        {!q.isLoading && files.length === 0 && <EmptyState icon="paperclip" title="No files yet" text="Pictures and files sent in this conversation show up here." />}
        {files.length > 0 && <ul className="chat-filelist">{files.map((f) => <FilesRow key={f.id} file={f} />)}</ul>}
        {q.hasNextPage && <button className="btn btn-ghost btn-sm" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>{q.isFetchingNextPage ? <Spinner /> : 'Load more'}</button>}
      </div>
    </aside>
  );
}

// ------------------------------------------------------------------ details of the open conversation
export function InfoPanel({ conversation, onClose }: { conversation: Conversation; onClose: () => void }) {
  const wid = useWorkspaceId()!;
  const me = useAuth((s) => s.ctx!.user.id);
  const navigate = useNavigate();
  const online = useChat((s) => s.online);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState<string | null>(null);   // non-null while the group is being renamed
  const [viewProfile, setViewProfile] = useState<string | null>(null);
  const group = conversation.type === 'Group';

  const refresh = () => { void queryClient.invalidateQueries({ queryKey: chatKeys.conversations(wid) }); void queryClient.invalidateQueries({ queryKey: chatKeys.thread(wid, conversation.id) }); };
  const rename = useMutation({ mutationFn: (n: string) => chatApi.rename(conversation.id, n), onSuccess: () => { setName(null); refresh(); }, onError: (e) => toast(errorText(e, 'Could not rename the group.'), 'error') });
  const remove = useMutation({ mutationFn: (userId: string) => chatApi.removeMember(conversation.id, userId), onSuccess: refresh, onError: (e) => toast(errorText(e, 'Could not remove that person.'), 'error') });
  const mute = useMutation({
    mutationFn: (muted: boolean) => chatApi.mute(conversation.id, muted),
    onSuccess: () => { refresh(); void queryClient.invalidateQueries({ queryKey: chatKeys.unread(wid) }); },
    onError: (e) => toast(errorText(e, 'Could not change that.'), 'error'),
  });

  const leave = async () => {
    if (!(await confirmDialog({ title: 'Leave group', message: `You will stop receiving messages from “${conversation.name}” and it will disappear from your list.`, confirmText: 'Leave' }))) return;
    try {
      await chatApi.removeMember(conversation.id, me);
      queryClient.removeQueries({ queryKey: chatKeys.thread(wid, conversation.id) });
      void queryClient.invalidateQueries({ queryKey: chatKeys.conversations(wid) });
      navigate('/chat', { replace: true });
    } catch (e) { toast(errorText(e, 'Could not leave the group.'), 'error'); }
  };
  const kick = async (userId: string, who: string) => {
    if (await confirmDialog({ title: 'Remove from group', message: `${who} will no longer see this group.`, confirmText: 'Remove' })) remove.mutate(userId);
  };

  return (
    <aside className="chat-info" aria-label="Conversation details">
      <div className="chat-info-head">
        <h3>{group ? 'Group details' : 'Details'}</h3>
        <button className="btn-icon" onClick={onClose} aria-label="Close details"><Icon name="close" /></button>
      </div>

      <div className="chat-info-body">
        <div className="info-hero">
          {group ? <span className="avatar lg group-avatar"><Icon name="users" size={22} /></span>
            : conversation.otherUserId
              ? <button type="button" className="avatar-btn" onClick={() => setViewProfile(conversation.otherUserId)} aria-label={`${conversation.name}'s profile`}><Avatar name={conversation.name} size="lg" /></button>
              : <Avatar name={conversation.name} size="lg" />}
          {name === null ? (
            <>
              {conversation.otherUserId
                ? <button type="button" className="link-btn h4-link" onClick={() => setViewProfile(conversation.otherUserId)}><h4>{conversation.name}</h4></button>
                : <h4>{conversation.name}</h4>}
              {group && conversation.canManage && <button className="link-btn" onClick={() => setName(conversation.name)}>Rename group</button>}
            </>
          ) : (
            <form className="rename" onSubmit={(e) => { e.preventDefault(); if (name.trim().length >= 2) rename.mutate(name.trim()); }}>
              <input className="input" value={name} maxLength={60} autoFocus onFocus={(e) => e.target.select()} onChange={(e) => setName(e.target.value)} aria-label="Group name" />
              <button className="btn btn-primary btn-sm" type="submit" disabled={rename.isPending || name.trim().length < 2}>Save</button>
              <button className="btn btn-sm" type="button" onClick={() => setName(null)}>Cancel</button>
            </form>
          )}
        </div>

        <div className="switch-row">
          <span id="mute-label"><b>Mute notifications</b><small>No pop-ups, and no count in the menu.</small></span>
          <button type="button" className={`switch ${conversation.isMuted ? 'on' : ''}`} role="switch" aria-checked={conversation.isMuted}
            aria-labelledby="mute-label" disabled={mute.isPending} onClick={() => mute.mutate(!conversation.isMuted)} />
        </div>

        <div className="info-section">
          <div className="info-title">{group ? `Members · ${conversation.members.length}` : 'People'}{group && conversation.canManage && <button className="link-btn" onClick={() => setAdding(true)}><Icon name="plus" size={13} /> Add</button>}</div>
          <ul className="member-list">
            {conversation.members.map((m) => (
              <li key={m.userId}>
                <button type="button" className="member-row-btn" onClick={() => setViewProfile(m.userId)} aria-label={`${m.name}'s profile`}>
                  <PersonAvatar name={m.name} userId={m.userId} fallback={m.online} hasAvatar={m.hasAvatar} />
                  <span className="member-text"><b>{m.name}{m.userId === me && ' (you)'}</b><small>{(online[m.userId] ?? m.online) ? 'Active now' : 'Offline'}</small></span>
                </button>
                {m.role === 'Admin' && group && <span className="badge badge-neutral">Admin</span>}
                {group && conversation.canManage && m.userId !== me && (
                  <button className="btn-icon danger" onClick={() => void kick(m.userId, m.name)} aria-label={`Remove ${m.name}`} title="Remove"><Icon name="close" size={14} /></button>
                )}
              </li>
            ))}
          </ul>
        </div>

        {group && <button className="btn btn-danger-ghost" onClick={() => void leave()}><Icon name="logout" size={15} /> Leave group</button>}
        {!group && conversation.members.length < 2 && <EmptyState icon="user" title="Former member" text="This person is no longer in the conversation." />}
      </div>
      {adding && <AddPeopleModal conversation={conversation} onClose={() => setAdding(false)} />}
      {viewProfile && <MemberProfileModal userId={viewProfile} onClose={() => setViewProfile(null)} />}
    </aside>
  );
}

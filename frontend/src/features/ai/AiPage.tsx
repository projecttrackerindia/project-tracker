import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { Icon } from '../../components/Icon';
import { PageLoader } from '../../components/ui';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { timeAgo } from '../../lib/format';
import { useAuth, useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';
import { useAiStatus } from './Assistant';
import { aiWorkspaceApi, type AiFeedbackReason, askAi, type AiAction, type AiConversation, type AiMessage, type AiMode, type AiStreamEvent, type AiTier, type AiToolUse } from './aiApi';
import { Composer, DropOverlay, Hero, MessageView, Orb, PlanNotice, ModeSwitch, CreditMeter, Reasoning, RouteChip, ToolChips, ActionCard, hasFiles, tierName, withoutTrailer, type PendingFile, type Suggestion } from './AiParts';
import { saveFile } from '../../lib/native';
import { Markdown } from './Markdown';

/** What the page shows while an answer is being written. */
interface Live {
  text: string; reasoning: string; stage: 'routing' | 'thinking' | 'writing';
  tools: (AiToolUse & { id: string; state: 'running' | 'done' | 'failed' })[]; actions: AiAction[];
  route?: { tier: AiTier; reason: string; limited: boolean; wanted: AiTier; credits: number };
}

const extOf = (n: string) => n.split('.').pop()?.toLowerCase() ?? '';
const zone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'UTC'; } };

function settled(over: Partial<AiMessage>): AiMessage {
  return { id: `local-${Math.random().toString(36).slice(2)}`, role: 'assistant', content: '', reasoning: null, tier: null, model: null, routeReason: null, credits: 0,
    status: 'complete', tools: [], actions: [], attachments: [], createdAt: new Date().toISOString(), ...over };
}

// ------------------------------------------------------------------ the page

export function AiPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const loc = useLocation();
  const wid = useWorkspaceId();
  const firstName = useAuth((s) => s.ctx?.user.displayName?.split(' ')[0] ?? '');
  const status = useAiStatus();
  const usageQ = useWsQuery(['ai', 'usage'], aiWorkspaceApi.usage, { enabled: !!status?.enabled, staleTime: 20_000 });
  const listQ = useWsQuery(['ai', 'conversations'], aiWorkspaceApi.conversations, { enabled: !!status?.enabled });
  const startersQ = useWsQuery(['ai', 'starters'], aiWorkspaceApi.starters, { enabled: !!status?.enabled, staleTime: 60_000 });
  const insightsQ = useWsQuery(['ai', 'insights'], aiWorkspaceApi.insights, { enabled: !!status?.enabled, staleTime: 120_000 });
  const usage = usageQ.data;

  const [convId, setConvId] = useState<string | null>(id ?? null);
  const [messages, setMessages] = useState<AiMessage[]>([]);
  const [live, setLive] = useState<Live | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [mode, setMode] = useState<AiMode>('auto');
  const [text, setText] = useState('');
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [railOpen, setRailOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const actionLock = useRef(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const selfNav = useRef<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const dragDepth = useRef(0);
  const asked = useRef<number | string | null>(null);
  const filesRef = useRef<PendingFile[]>([]);
  filesRef.current = files;

  const canAttach = !!usage?.attachments;
  const canAct = !!usage?.actions;
  const refresh = useCallback(() => { void invalidateWorkspace(wid, 'ai'); }, [wid]);

  // ---- follow the address: a conversation opened from the list, a link, or a new chat
  useEffect(() => {
    if (selfNav.current && selfNav.current === id) { selfNav.current = null; return; }   // this conversation was just started here
    abort.current?.abort();
    setConvId(id ?? null); setError(null); setLive(null); setStreaming(false);
    if (!id) { setMessages([]); return; }
    let cancelled = false;
    aiWorkspaceApi.conversation(id).then((d) => { if (!cancelled) { setMessages(d.messages); stick.current = true; } })
      .catch(() => { if (!cancelled) { toast('That conversation is not available.', 'info'); nav('/ai', { replace: true }); } });
    return () => { cancelled = true; };
  }, [id, nav]);

  // a different workspace has different conversations
  const lastWid = useRef(wid);
  useEffect(() => {
    if (lastWid.current !== wid) { lastWid.current = wid; abort.current?.abort(); setMessages([]); setLive(null); setConvId(null); nav('/ai', { replace: true }); }
  }, [wid, nav]);

  useEffect(() => () => { abort.current?.abort(); filesRef.current.forEach((f) => f.previewUrl && URL.revokeObjectURL(f.previewUrl)); }, []);

  // keep the newest text in view, unless the person has scrolled up to read
  useEffect(() => { const el = scroller.current; if (el && stick.current) el.scrollTop = el.scrollHeight; }, [messages, live]);
  const onScroll = () => { const el = scroller.current; if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 140; };

  // ---- files
  const addFiles = (list: File[]) => {
    if (!usage || !canAttach) { toast('Reading files is not included in your plan.', 'info'); return; }
    let room = usage.maxFiles - filesRef.current.length;
    for (const file of list) {
      const ext = extOf(file.name);
      const image = /^(png|jpe?g|gif|webp)$/.test(ext);
      const limitMb = image ? usage.maxImageMb : usage.maxDocumentMb;
      if (room <= 0) { toast(`Attach up to ${usage.maxFiles} files to one question.`, 'warning'); break; }
      if (!usage.attachmentTypes.includes(ext)) { toast(`${file.name}: the assistant can read ${usage.attachmentTypes.map((x) => `.${x}`).join(', ')} files.`, 'warning'); continue; }
      if (file.size > limitMb * 1024 * 1024) { toast(`${file.name} is larger than ${limitMb} MB.`, 'warning'); continue; }
      room--;
      const localId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const pending: PendingFile = { localId, file, status: 'uploading', previewUrl: image ? URL.createObjectURL(file) : undefined };
      setFiles((p) => [...p, pending]);
      aiWorkspaceApi.upload(file)
        .then((attachment) => setFiles((p) => p.map((f) => (f.localId === localId ? { ...f, status: 'ready', attachment } : f))))
        .catch((e) => setFiles((p) => p.map((f) => (f.localId === localId ? { ...f, status: 'error', error: e instanceof ApiError ? e.message : 'Could not upload that file.' } : f))));
    }
  };
  const removeFile = (localId: string) => {
    const f = filesRef.current.find((x) => x.localId === localId);
    if (f?.previewUrl) URL.revokeObjectURL(f.previewUrl);
    if (f?.attachment) void aiWorkspaceApi.removeFile(f.attachment.id).catch(() => undefined);
    setFiles((p) => p.filter((x) => x.localId !== localId));
  };

  // ---- asking
  const send = async (raw: string, over?: { mode?: AiMode }) => {
    if (streaming) return;
    const q = raw.trim();
    const approving = /^(yes(?:[,!]?(?:\s+(?:please|send(?:\s+it)?|go ahead|confirm))*)?|confirm(?:\s+(?:it|sending the message|sending|send))?|send it|go ahead(?:\s+and send(?:\s+it)?)?)[.!]*$/i.test(q);
    const cancelling = /^(?:cancel (?:it|that|sending the message)|not now|dismiss)[.!]*$/i.test(q);
    const latestAnswer = [...messages].reverse().find((m) => m.role === 'assistant');
    const pending = latestAnswer?.actions.filter((a) => a.status === 'proposed') ?? [];
    const confirmation = (approving || cancelling) && latestAnswer && pending.length === 1
      ? { messageId: latestAnswer.id, actionId: pending[0].id, kind: pending[0].kind } : undefined;
    const ready = files.filter((f) => f.status === 'ready' && f.attachment);
    if (!q && ready.length === 0) return;
    const snapshot = files;
    const attachments = ready.map((f) => f.attachment!);
    const localId = `local-${Date.now()}`;
    setError(null);
    setMessages((m) => [...m, settled({ id: localId, role: 'user', content: q || 'Please look at the attached file.', attachments })]);
    setText(''); setFiles([]);
    setLive({ text: '', reasoning: '', stage: 'routing', tools: [], actions: [] });
    setStreaming(true); stick.current = true;
    const ac = new AbortController();
    abort.current = ac;

    const run: Live & { finished: boolean; failure?: { code: string; message: string } } = { text: '', reasoning: '', stage: 'routing', tools: [], actions: [], finished: false };
    let scheduled = false;
    const flush = () => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => { scheduled = false; if (!run.finished) setLive({ ...run, tools: [...run.tools], actions: [...run.actions] }); });
    };
    const onEvent = (e: AiStreamEvent) => {
      switch (e.name) {
        case 'started':
          setMessages((m) => m.map((x) => (x.id === localId ? { ...x, id: e.questionId } : x)));
          if (!convId) { selfNav.current = e.conversationId; setConvId(e.conversationId); nav(`/ai/${e.conversationId}`, { replace: true }); refresh(); }
          break;
        case 'route': run.route = { tier: e.tier, reason: e.reason, limited: e.limited, wanted: e.wanted, credits: e.credits }; run.stage = 'thinking'; flush(); break;
        case 'reasoning': if (run.reasoning.length < 12_000) run.reasoning += e.delta; flush(); break;
        case 'text': run.text += e.delta; run.stage = 'writing'; flush(); break;
        case 'tool': {
          const i = run.tools.findIndex((t) => t.id === e.id);
          const next = { id: e.id, name: e.tool, label: e.label, count: e.count, state: e.state };
          if (i >= 0) run.tools[i] = next; else run.tools.push(next);
          flush(); break;
        }
        case 'action': run.actions.push(e.action); flush(); break;
        case 'done':
          run.finished = true;
          setMessages((m) => [...m, e.message]);
          setLive(null);
          setStreaming(false);   // the answer is complete; the box is usable while the server tidies up a long conversation
          if (e.message.model === 'builtin-confirmation' && convId) {
            void aiWorkspaceApi.conversation(convId).then((d) => setMessages((ms) => ms.map((x) => {
              const saved = d.messages.find((y) => y.id === x.id);
              return saved ? { ...x, actions: saved.actions } : x;
            }))).catch(() => undefined);
          }
          break;
        case 'error': run.failure = { code: e.code, message: e.message }; break;
      }
    };

    try {
      await askAi(convId, { text: q, mode: over?.mode ?? mode, attachmentIds: attachments.map((a) => a.id), timeZone: zone(), confirmation }, onEvent, ac.signal);
    } catch (e) {
      if (!ac.signal.aborted) {
        if (e instanceof ApiError && !run.route) {
          // refused before anything was written: nothing was spent, so the question goes back into the box
          setMessages((m) => m.filter((x) => x.id !== localId));
          setText(raw); setFiles(snapshot);
          setError(e.message);
          run.finished = true; setLive(null);
        } else run.failure = { code: 'AI_FAILED', message: 'The connection was interrupted. Try again.' };
      }
    } finally {
      // Settle exactly once. Marking the run finished first also drops any animation frame still waiting to redraw the live answer.
      const alreadySettled = run.finished;
      run.finished = true;
      if (!alreadySettled) {
        const partial = run.text.trim();
        if (run.failure || partial || run.reasoning) {
          setMessages((m) => [...m, settled({
            content: partial || run.failure?.message || '', status: run.failure ? 'failed' : 'stopped', reasoning: run.reasoning || null,
            tier: run.route?.tier ?? null, routeReason: run.route?.reason ?? null, tools: run.tools, actions: run.actions,
          })]);
        }
        setLive(null);
      }
      if (abort.current === ac) { setStreaming(false); abort.current = null; }
      refresh();
    }
  };

  const rate = async (m: AiMessage, rating: 'up' | 'down' | 'none', reason?: AiFeedbackReason) => {
    const was = { feedback: m.feedback ?? null };
    setMessages((all) => all.map((x) => x.id === m.id ? { ...x, feedback: rating === 'none' ? null : rating } : x));
    try { await aiWorkspaceApi.feedback(m.id, rating, reason); if (reason === 'too_long' || reason === 'too_short') toast('Thanks. I will keep my answers ' + (reason === 'too_long' ? 'shorter.' : 'more detailed.')); }
    catch { setMessages((all) => all.map((x) => x.id === m.id ? { ...x, ...was } : x)); toast('Could not save that.', 'error'); }
  };

  const sendFromBox = () => void send(text);
  const stop = () => abort.current?.abort();

  // opened with a question already in hand (the command palette, "AI summary" on the portfolio)
  useEffect(() => {
    const state = loc.state as { ask?: string; ts?: number } | null;
    const ask = state?.ask;
    if (!ask || !usage || asked.current === (state?.ts ?? ask)) return;
    asked.current = state?.ts ?? ask;
    nav(loc.pathname, { replace: true, state: null });
    void send(ask);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loc.state, usage]);

  const pick = (s: Suggestion) => {
    if (s.attach) { toast('Use the paperclip to attach a file, then ask your question.', 'info'); return; }
    if (s.mode && usage?.tiers.find((t) => t.id === s.mode)?.allowed) setMode(s.mode);
    void send(s.prompt, { mode: s.mode && usage?.tiers.find((t) => t.id === s.mode)?.allowed ? s.mode : undefined });
  };

  // ---- suggestions the assistant made
  const refreshActionStates = () => {
    if (!convId) return;
    // Replacement confirmations can change older cards as well as the current card.
    void aiWorkspaceApi.conversation(convId).then((d) => setMessages((ms) => ms.map((x) => {
      const saved = d.messages.find((y) => y.id === x.id);
      return saved ? { ...x, actions: saved.actions } : x;
    }))).catch(() => undefined);
  };
  const act = async (m: AiMessage, a: AiAction, kind: 'confirm' | 'dismiss' | 'reconcile') => {
    if (actionLock.current) return;
    actionLock.current = true;
    setBusyAction(a.id);
    try {
      const res = await (kind === 'reconcile' ? aiWorkspaceApi.reconcile(m.id, a.id) : kind === 'confirm' ? aiWorkspaceApi.confirm(m.id, a.id) : aiWorkspaceApi.dismiss(m.id, a.id));
      setMessages((ms) => ms.map((x) => (x.id === m.id ? { ...x, actions: x.actions.map((y) => (y.id === a.id ? res : y)) } : x)));
      if (kind !== 'dismiss') {
        toast(res.status === 'done' ? 'Done.' : res.error ?? 'That could not be done.', res.status === 'done' ? 'success' : 'error');
        if (res.status === 'done') void invalidateWorkspace(wid);
        refreshActionStates();
      }
    } catch (e) { toast(e instanceof ApiError ? e.message : 'Something went wrong.', 'error'); }
    finally { actionLock.current = false; setBusyAction(null); }
  };

  const confirmAll = async (m: AiMessage) => {
    if (actionLock.current) return;
    actionLock.current = true;
    setBusyAction('all');
    try {
      const res = await aiWorkspaceApi.confirmAll(m.id);
      setMessages((ms) => ms.map((x) => (x.id === m.id ? { ...x, actions: x.actions.map((y) => res.find((r) => r.id === y.id) ?? y) } : x)));
      const failed = res.find((r) => r.status !== 'done');
      if (failed) toast(failed.error ?? 'One step could not be done, so the rest were not tried.', 'error'); else toast(`Done: ${res.length} changes made.`, 'success');
      void invalidateWorkspace(wid);
      refreshActionStates();
    } catch (e) { toast(e instanceof ApiError ? e.message : 'Something went wrong.', 'error'); }
    finally { actionLock.current = false; setBusyAction(null); }
  };

  const copy = (m: AiMessage) => { void navigator.clipboard?.writeText(m.content).then(() => toast('Copied.'), () => toast('Could not copy.', 'error')); };
  const download = (m: AiMessage) => {
    const title = (listQ.data?.find((c) => c.id === convId)?.title ?? 'assistant-answer').replace(/[^\w -]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'assistant-answer';
    void saveFile(new Blob([m.content], { type: 'text/markdown;charset=utf-8' }), `${title}.md`);
  };
  const regenerate = (index: number) => {
    const before = [...messages.slice(0, index)].reverse().find((x) => x.role === 'user');
    if (before) void send(before.content);
  };

  // ---- dropping files anywhere on the page
  const onDrag = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (e.type === 'dragenter') { dragDepth.current++; setDragging(true); }
    if (e.type === 'dragleave') { dragDepth.current = Math.max(0, dragDepth.current - 1); if (dragDepth.current === 0) setDragging(false); }
    if (e.type === 'drop') { dragDepth.current = 0; setDragging(false); addFiles(Array.from(e.dataTransfer.files)); }
  };

  const newChat = () => { abort.current?.abort(); setRailOpen(false); setMessages([]); setLive(null); setError(null); setConvId(null); nav('/ai'); };
  const title = convId ? listQ.data?.find((c) => c.id === convId)?.title ?? 'Conversation' : 'New conversation';
  const lastAssistant = [...messages].reverse().findIndex((m) => m.role === 'assistant');
  const lastAssistantIndex = lastAssistant < 0 ? -1 : messages.length - 1 - lastAssistant;

  // ---- not available here
  if (status === undefined) return <PageLoader />;
  if (!status.enabled) {
    return (
      <div className="ai-shell solo"><PlanNotice
        title={!status.configured ? 'The AI assistant is not set up' : !status.entitled ? 'AI is not part of your plan' : 'The AI assistant is switched off'}
        text={!status.configured ? 'An administrator needs to connect a model to this installation before the assistant can be used.'
          : !status.entitled ? 'Upgrade your plan to ask questions, analyse your projects and let the assistant prepare work for you.'
          : 'An owner or admin has switched the assistant off for this workspace. They can turn it back on in the workspace settings.'}
        to={!status.entitled ? '/settings/billing' : status.configured && !status.allowedHere ? '/settings' : undefined}
        action={!status.entitled ? 'See plans' : 'Open settings'} /></div>
    );
  }
  if (usage && usage.creditsLimit === 0 && !usage.unlimited) {
    return <div className="ai-shell solo"><PlanNotice title="No AI credits in your plan" text="Your plan includes the assistant but no monthly credits. Ask an administrator to add some, or upgrade." to="/settings/billing" action="See plans" /></div>;
  }

  const outOfCredits = !!usage && !usage.unlimited && usage.creditsLeft <= 0;

  return (
    <div className={`ai-shell ${railOpen ? 'rail-open' : ''}`} onDragEnter={onDrag} onDragOver={onDrag} onDragLeave={onDrag} onDrop={onDrag}>
      <Rail list={listQ.data ?? []} loading={listQ.isLoading} current={convId} onNew={newChat} onPick={(cid) => { setRailOpen(false); nav(`/ai/${cid}`); }}
        onChanged={refresh} onDeleted={(cid) => { refresh(); if (cid === convId) newChat(); }} />
      <div className="ai-rail-scrim" onClick={() => setRailOpen(false)} />

      <section className="ai-main">
        <div className="ai-aurora" aria-hidden="true" />
        <header className="ai-head">
          <button type="button" className="btn-icon ai-rail-toggle" aria-label="Conversations" onClick={() => setRailOpen(true)}><Icon name="menu" /></button>
          <div className="ai-head-title">
            <Orb size={30} busy={streaming} />
            <div><b>{title}</b><span>{streaming ? (live?.stage === 'writing' ? 'Writing…' : live?.route ? `${tierName(live.route.tier)} · thinking…` : 'Choosing how much thinking this needs…') : 'Ask, analyse, plan and get things done'}</span></div>
          </div>
          <ModeSwitch mode={mode} onChange={setMode} usage={usage} disabled={streaming} />
          <CreditMeter usage={usage} />
        </header>

        <div className="ai-scroll" ref={scroller} onScroll={onScroll}>
          {messages.length === 0 && !live ? (
            <Hero name={firstName} onPick={pick} onAsk={(p) => void send(p)} canAttach={canAttach} starters={startersQ.data?.starters} insights={insightsQ.data} />
          ) : (
            <div className="ai-thread" aria-live="polite" aria-busy={streaming}>
              {messages.map((m, i) => (
                <MessageView key={m.id} m={m} busyAction={busyAction} canEmail={canAct && !streaming} canRegenerate={!streaming && i === lastAssistantIndex}
                  onReconcile={(a) => void act(m, a, 'reconcile')} onConfirm={(a) => void act(m, a, 'confirm')} onDismiss={(a) => void act(m, a, 'dismiss')} onCopy={() => copy(m)} onDownload={() => download(m)}
                  onRegenerate={() => regenerate(i)} onEmail={() => void send('Email this answer to me as a report.')}
                  onFollowUp={(t) => void send(t)} onConfirmAll={() => void confirmAll(m)} onFeedback={(rating, reason) => void rate(m, rating, reason)} />
              ))}
              {live && <LiveAnswer live={live} />}
            </div>
          )}
        </div>

        {error && <div className="ai-banner" role="alert"><Icon name="alert" size={15} /><span>{error}</span><button type="button" aria-label="Dismiss" onClick={() => setError(null)}><Icon name="close" size={13} /></button></div>}
        <Composer value={text} onChange={setText} onSend={sendFromBox} onStop={stop} onFiles={addFiles} onRemoveFile={removeFile} files={files} streaming={streaming}
          canAttach={canAttach} usage={usage} mode={mode} disabledReason={outOfCredits ? 'This month\'s AI credits are used up. They renew on the 1st.' : null} />
        {dragging && <DropOverlay />}
      </section>
    </div>
  );
}

// ------------------------------------------------------------------ the answer being written

function LiveAnswer({ live }: { live: Live }) {
  return (
    <div className="ai-msg assistant live">
      <Orb size={30} busy />
      <div className="ai-body">
        <div className="ai-meta">
          <b>Assistant</b>
          {live.route ? <RouteChip tier={live.route.tier} reason={live.route.reason} credits={live.route.credits} limited={live.route.limited} wanted={live.route.wanted} /> : <span className="ai-routing">choosing how much thinking this needs…</span>}
        </div>
        {live.route?.limited && (
          <div className="ai-limit">This looked like it needed <b>{tierName(live.route.wanted)}</b>; your plan or remaining credits allow up to <b>{tierName(live.route.tier)}</b>. <Link to="/settings/billing">See plans</Link></div>
        )}
        {(live.reasoning || (live.route && live.route.tier !== 'quick' && !live.text)) && <Reasoning text={live.reasoning} live={!live.text} />}
        <ToolChips tools={live.tools} />
        {live.text ? <div className="ai-streaming"><Markdown text={withoutTrailer(live.text)} /><span className="ai-caret" /></div> : !live.reasoning && live.tools.length === 0 && <div className="ai-dots"><i /><i /><i /></div>}
        {live.actions.map((a) => <ActionCard key={a.id} action={a} busy onConfirm={() => undefined} onDismiss={() => undefined} />)}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ the conversation list

function bucket(c: AiConversation): string {
  const days = Math.floor((Date.now() - new Date(c.lastMessageAt).getTime()) / 86_400_000);
  return c.isPinned ? 'Pinned' : days < 1 ? 'Today' : days < 2 ? 'Yesterday' : days < 8 ? 'Previous 7 days' : 'Older';
}

function Rail({ list, loading, current, onNew, onPick, onChanged, onDeleted }: {
  list: AiConversation[]; loading: boolean; current: string | null; onNew: () => void; onPick: (id: string) => void; onChanged: () => void; onDeleted: (id: string) => void;
}) {
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const groups = useMemo(() => {
    const items = list.filter((c) => c.title.toLowerCase().includes(q.trim().toLowerCase()));
    const order = ['Pinned', 'Today', 'Yesterday', 'Previous 7 days', 'Older'];
    return order.map((name) => ({ name, items: items.filter((c) => bucket(c) === name) })).filter((g) => g.items.length > 0);
  }, [list, q]);

  const rename = async (c: AiConversation) => {
    const title = draft.trim();
    setEditing(null);
    if (!title || title === c.title) return;
    try { await aiWorkspaceApi.update(c.id, { title }); onChanged(); } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not rename it.', 'error'); }
  };
  const pin = async (c: AiConversation) => { try { await aiWorkspaceApi.update(c.id, { pinned: !c.isPinned }); onChanged(); } catch { toast('Could not pin it.', 'error'); } };
  const remove = async (c: AiConversation) => {
    if (!(await confirmDialog({ title: 'Delete this conversation?', message: 'What was said and any files are erased. This cannot be undone.', confirmText: 'Delete', danger: true }))) return;
    try { await aiWorkspaceApi.remove(c.id); onDeleted(c.id); } catch { toast('Could not delete it.', 'error'); }
  };

  return (
    <aside className="ai-rail" aria-label="Conversations">
      <button type="button" className="ai-new" onClick={onNew}><Icon name="plus" size={16} /> New chat</button>
      <label className="search-box"><Icon name="search" size={14} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search conversations" aria-label="Search conversations" /></label>
      <div className="ai-rail-list">
        {loading && <div className="ai-rail-empty">Loading…</div>}
        {!loading && list.length === 0 && <div className="ai-rail-empty">Your conversations will appear here.</div>}
        {!loading && list.length > 0 && groups.length === 0 && <div className="ai-rail-empty">Nothing matches.</div>}
        {groups.map((g) => (
          <div key={g.name} className="ai-rail-group">
            <h4>{g.name}</h4>
            {g.items.map((c) => (
              <div key={c.id} className={`ai-conv ${c.id === current ? 'active' : ''}`}>
                {editing === c.id
                  ? <input className="ai-conv-edit" autoFocus value={draft} maxLength={120} onChange={(e) => setDraft(e.target.value)} onBlur={() => void rename(c)}
                      onKeyDown={(e) => { if (e.key === 'Enter') void rename(c); if (e.key === 'Escape') setEditing(null); }} aria-label="Conversation title" />
                  : <button type="button" className="ai-conv-main" onClick={() => onPick(c.id)} title={c.title}>
                      <span>{c.title}</span><time>{timeAgo(c.lastMessageAt)}</time>
                    </button>}
                <span className="ai-conv-actions">
                  <button type="button" aria-label={c.isPinned ? 'Unpin' : 'Pin'} title={c.isPinned ? 'Unpin' : 'Pin'} className={c.isPinned ? 'on' : ''} onClick={() => void pin(c)}><Icon name="star" size={13} /></button>
                  <button type="button" aria-label="Rename" title="Rename" onClick={() => { setDraft(c.title); setEditing(c.id); }}><Icon name="edit" size={13} /></button>
                  <button type="button" aria-label="Delete" title="Delete" onClick={() => void remove(c)}><Icon name="trash" size={13} /></button>
                </span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </aside>
  );
}

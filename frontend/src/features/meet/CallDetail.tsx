import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Face } from '../../components/Face';
import { Icon } from '../../components/Icon';
import { ErrorState, PageLoader } from '../../components/ui';
import { AuraLine, CalmCard, CalmHero } from '../../components/calm';
import { useWsQuery } from '../../lib/hooks';
import { useAuth } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { callLink, callsApi, type Call, type CallNotes } from '../calls/callsApi';
import { StartCallModal } from '../calls/StartCall';
import { dayWord, hm } from './meetFormat';
import './meetings-calm.css';

const initials = (n: string) => n.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
const firstSentence = (s: string | null | undefined) => (s ? (/^(.{8,140}?[.!?])(\s|$)/.exec(s.trim())?.[1] ?? s.trim().slice(0, 140)) : null);
const kindWord = (c: Call) => (c.kind === 'adhoc' ? 'Ad-hoc call' : c.kind === 'chat' ? 'Chat call' : `${c.projectKey ?? 'Project'} call`);

/**
 * One call in Meetings (?call={id}): what the separate call page used to show after a call, and more. The hero says what it was (Aura's
 * summary when it took notes); the transcript can be searched; the side holds the summary, the action items, the details and links (the
 * project, the chat), and Share summary / Download. A missed call offers Call back; a call that is still on, Rejoin.
 */
export function CallDetail({ id }: { id: string }) {
  const navigate = useNavigate();
  const me = useAuth((s) => s.ctx?.user.id);
  const q = useWsQuery(['calls', id], () => callsApi.get(id), { refetchInterval: (query) => ((query.state.data as Call | undefined)?.status === 'live' ? 15_000 : false) });
  const notesQ = useWsQuery(['calls', id, 'notes'], () => callsApi.notes(id), { retry: false, refetchInterval: (query) => ((query.state.data as CallNotes | undefined)?.status === 'writing' ? 20_000 : false) });
  const [find, setFind] = useState('');
  const [calling, setCalling] = useState(false);
  const call = q.data;
  const notes = notesQ.data && Array.isArray(notesQ.data.transcript) ? notesQ.data : undefined;
  const lines = useMemo(() => {
    const all = notes?.transcript ?? [];
    const f = find.trim().toLowerCase();
    return f ? all.filter((l) => l.text.toLowerCase().includes(f) || l.speaker.toLowerCase().includes(f)) : all;
  }, [notes, find]);

  if (q.isLoading) return <div className="mz-page"><PageLoader /></div>;
  if (q.isError || !call) return <div className="mz-page"><ErrorState error={q.error} retry={() => void q.refetch()} /></div>;

  const joined = call.people.filter((p) => p.joinedAt);
  const mine = call.people.find((p) => p.userId === me);
  const missed = call.status === 'ended' && call.startedBy !== me && !!mine && !mine.joinedAt;
  const minutes = call.endedAt ? Math.max(1, Math.round((Date.parse(call.endedAt) - Date.parse(call.startedAt)) / 60_000)) : null;
  const names = (joined.length ? joined : call.people).map((p) => p.name);
  const summary = notes?.summary ?? null;
  const second = missed ? `Missed call from ${call.startedByName}.`
    : call.status === 'live' ? 'Still on. You can rejoin.'
      : firstSentence(summary) ?? `${minutes ?? 0} min with ${names.slice(0, 3).map((n) => n.split(' ')[0]).join(', ') || call.startedByName}.`;
  const live = call.status === 'live';
  const text = () => [
    `${call.title} · ${dayWord(call.startedAt)} ${hm(call.startedAt)}${call.endedAt ? `–${hm(call.endedAt)}` : ''}`,
    names.length ? `People: ${names.join(', ')}` : '',
    summary ? `\nSummary\n${summary}` : '',
    notes?.actions.length ? `\nActions\n${notes.actions.map((a, i) => `${i + 1}. ${a.task}${a.owner ? ` — ${a.owner}` : ''}${a.due ? ` (by ${a.due})` : ''}`).join('\n')}` : '',
  ].filter(Boolean).join('\n');
  const share = async () => {
    const body = text();
    try {
      if (navigator.share) await navigator.share({ title: call.title, text: body });
      else { await navigator.clipboard.writeText(body); toast('Summary copied. Paste it anywhere.', 'success'); }
    } catch { /* closed the share sheet */ }
  };
  const download = () => {
    const body = `${text()}\n\nTranscript\n${(notes?.transcript ?? []).map((l) => (l.speaker ? `${l.speaker}: ${l.text}` : l.text)).join('\n') || '(no transcript)'}\n`;
    const url = URL.createObjectURL(new Blob([body], { type: 'text/plain;charset=utf-8' }));
    const a = document.createElement('a'); a.href = url; a.download = `${call.title.replace(/[^\w -]+/g, '').trim() || 'call'}.txt`; a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  // The timeline of the call: one bar per thing said, its height from how much was said (there is no audio kept, only the words).
  const said = notes?.transcript ?? [];
  const bars = said.length ? Array.from({ length: 72 }, (_, i) => { const l = said[Math.floor((i / 72) * said.length)]; return Math.min(1, .3 + (l.text.length % 47) / 70 + .25 * Math.abs(Math.sin(i * 1.7))); }) : [];

  return (
    <div className="mz mz-page" data-testid="call-detail">
      <div className="mz-main">
        <nav className="mz-crumb" aria-label="Breadcrumb"><Link to="/meetings">Meetings</Link><span>›</span><Link to="/meetings?s=past">Past</Link><span>›</span><b>{call.title}</b></nav>
        <CalmHero title={`${missed ? call.startedByName : call.title}.`} second={second}
          action={live ? <button type="button" className="calm-go" onClick={() => navigate(callLink(call.id))} data-testid="call-rejoin"><Icon name="video" size={14} />Rejoin</button>
            : missed ? <button type="button" className="calm-go" onClick={() => setCalling(true)}><Icon name="phone" size={14} />Call back</button> : undefined} />
        <CalmCard className="mz-player" aria-label="Recording">
          <span className="mz-play" aria-hidden="true"><Icon name={live ? 'video' : 'play'} size={16} /></span>
          <div className="mz-wave">
            <div className="mz-bars" aria-hidden="true">{(bars.length ? bars : Array.from({ length: 48 }, () => .18)).map((h, i) => <i key={i} style={{ transform: `scaleY(${h})` }} />)}</div>
            <div className="mz-wave-l"><span>{hm(call.startedAt)}</span><span>{kindWord(call)} · {notes?.transcript.length ? 'transcript by Aura' : 'no recording kept'}{minutes ? ` · ${minutes} min` : ''}</span><span>{call.endedAt ? hm(call.endedAt) : 'live'}</span></div>
          </div>
        </CalmCard>
        <CalmCard className="mz-transcript" aria-label="Transcript">
          <div className="mz-tr-head"><span>Transcript · searchable</span>
            <label className="mz-find"><Icon name="search" size={13} /><input type="search" aria-label="Search the transcript" placeholder="Search" value={find} onChange={(e) => setFind(e.target.value)} /></label></div>
          {notesQ.isLoading ? <PageLoader /> : (notes?.transcript.length ?? 0) === 0 ? (
            <p className="mz-none" data-testid="call-no-transcript">{notes?.status === 'writing' ? 'Aura is writing up the call. The transcript shows here in a minute.'
              : call.agentEnabled ? 'Aura kept no words from this call.' : 'Aura was not in this call, so there is no transcript. Start a project call with the notetaker to get one.'}</p>
          ) : lines.length === 0 ? <p className="mz-none">Nothing said matches “{find}”.</p> : (
            <ol className="mz-lines">
              {lines.map((l, i) => (
                <li key={i}>
                  <Face byName name={l.speaker || '?'} className="mz-av sm" text={l.speaker ? initials(l.speaker) : '·'} />
                  <span className="mz-line"><b>{l.speaker || 'Someone'}</b><Mark text={l.text} find={find} /></span>
                </li>
              ))}
            </ol>
          )}
        </CalmCard>
      </div>
      <aside className="mz-side mz-detail-side">
        <CalmCard className="mz-card mz-sum">
          {summary ? <AuraLine text={summary} /> : <AuraLine text={notes?.status === 'writing' ? 'Aura is writing the summary…' : missed ? `${call.startedByName} called you${call.projectKey ? ` about ${call.projectKey}` : ''}.` : 'No summary: Aura was not asked along.'} />}
          <h4>Actions · {notes?.actions.length ?? 0}</h4>
          {(notes?.actions.length ?? 0) === 0 ? <p className="mz-none">No action items.</p> : (
            <ul className="mz-actions">
              {notes!.actions.map((a, i) => (
                <li key={i}><Face byName name={a.owner ?? '?'} className="mz-av sm" text={a.owner ? initials(a.owner) : '?'} /><span>{a.task}</span>{a.due && <em>{a.due}</em>}</li>
              ))}
            </ul>
          )}
          <h4>Details</h4>
          <dl className="mz-dl">
            <dt>Type</dt><dd>{kindWord(call)}</dd>
            <dt>When</dt><dd>{dayWord(call.startedAt)} {hm(call.startedAt)}{call.endedAt ? ` – ${hm(call.endedAt)}` : ' · live'}</dd>
            <dt>People</dt><dd>{names.join(', ') || '—'}</dd>
            {call.projectId && <><dt>Linked</dt><dd><Link to={`/work/projects/${call.projectId}`}>{call.projectKey ?? 'Project'}</Link></dd></>}
            {call.conversationId && <><dt>Chat</dt><dd><Link to={`/messages/${call.conversationId}`}>Open the chat</Link></dd></>}
            <dt>Started by</dt><dd>{call.startedByName}</dd>
          </dl>
          <div className="mz-foot">
            <button type="button" className="calm-go" onClick={() => void share()} data-testid="call-share">Share summary</button>
            <button type="button" className="calm-link" onClick={download} data-testid="call-download">Download</button>
          </div>
        </CalmCard>
      </aside>
      {calling && <StartCallModal people={[{ userId: call.startedBy, name: call.startedByName }]} agentAvailable={false} onClose={() => setCalling(false)} />}
    </div>
  );
}

function Mark({ text, find }: { text: string; find: string }) {
  const f = find.trim();
  if (!f) return <span>{text}</span>;
  const i = text.toLowerCase().indexOf(f.toLowerCase());
  if (i < 0) return <span>{text}</span>;
  return <span>{text.slice(0, i)}<mark>{text.slice(i, i + f.length)}</mark>{text.slice(i + f.length)}</span>;
}

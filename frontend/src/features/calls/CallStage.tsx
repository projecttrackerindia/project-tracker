import { createContext, useContext, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Track } from 'livekit-client';
import {
  Chat, ChatToggle, ConnectionQualityIndicator, ConnectionStateToast, DisconnectButton, GridLayout, LayoutContextProvider, MediaDeviceMenu, ParticipantTile,
  StartAudio, TrackToggle, VideoTrack, isTrackReference, useCreateLayoutContext, useEnsureTrackRef, useIsMuted, useLocalParticipant, useRoomContext, useTracks,
  type TrackReferenceOrPlaceholder,
} from '@livekit/components-react';
import { Icon } from '../../components/Icon';
import { initials } from '../../lib/format';
import { isAgent } from './callsApi';
import { REACTIONS, useCallSignals, type CallSignals } from './callSignals';

const hue = (name: string) => { let h = 0; for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
const canShare = typeof navigator !== 'undefined' && !!navigator.mediaDevices && 'getDisplayMedia' in navigator.mediaDevices;
const Signals = createContext<CallSignals | null>(null);

/**
 * The call itself, laid out the way people know from Google Meet: everyone in a grid of dark tiles (video when the camera is on, a coloured
 * circle with initials when it is off), a ring around whoever is speaking, a muted microphone shown by the name, the agent as its own tile
 * marked "Taking notes", a shared screen large with everyone in a strip beside it, and round controls along the bottom with a red hang-up.
 * Hands go up (in order, with the host able to lower them) and reactions float up the side, as in Meet.
 */
export function CallStage({ title, hostIdentity }: { title: string; hostIdentity: string | null }) {
  const signals = useCallSignals(hostIdentity);
  useScreenAwake();
  const layout = useCreateLayoutContext();
  const room = useRoomContext();
  // The screen tests look inside the room when they ask for it; nobody else does.
  useEffect(() => { try { if (localStorage.getItem('pt_call_debug') === '1') (window as unknown as { __ptRoom?: unknown }).__ptRoom = room; } catch { /* storage blocked */ } }, [room]);
  const tracks = useTracks(
    [{ source: Track.Source.Camera, withPlaceholder: true }, { source: Track.Source.ScreenShare, withPlaceholder: false }],
    { onlySubscribed: false },
  );
  // A shared screen takes the stage only while its picture is actually arriving (your own, or one you receive): a share that stopped
  // can linger as an empty listing for a moment, and must not leave a black stage behind.
  const shares = tracks.filter((t) => isTrackReference(t) && t.publication.source === Track.Source.ScreenShare && !t.publication.isMuted && !!t.publication.track
    && (t.participant.isLocal || t.publication.isSubscribed));
  // People first (you first among them), the agent last: it is there to listen.
  const people = useMemo(() => tracks.filter((t) => t.source === Track.Source.Camera)
    .sort((a, b) => Number(isAgent(a.participant.identity)) - Number(isAgent(b.participant.identity)) || Number(b.participant.isLocal) - Number(a.participant.isLocal)), [tracks]);
  const [showChat, setShowChat] = useState(false);
  return (
    <LayoutContextProvider value={layout} onWidgetChange={(s) => setShowChat(!!s.showChat)}>
      <Signals.Provider value={signals}>
      <div className={`cs${showChat ? ' with-chat' : ''}`} data-testid="call-stage">
        <div className="cs-main">
          {shares.length > 0 ? (
            <div className="cs-focus">
              <div className="cs-share"><ParticipantTile trackRef={shares[0]}><Tile /></ParticipantTile></div>
              <div className="cs-strip">{people.map((t) => <ParticipantTile key={`${t.participant.identity}:${t.source}`} trackRef={t}><Tile /></ParticipantTile>)}</div>
            </div>
          ) : (
            <GridLayout tracks={people} className="cs-grid"><ParticipantTile><Tile /></ParticipantTile></GridLayout>
          )}
          <Reactions />
          <Hands />
          <aside className="cs-chat" aria-label="Messages in this call" hidden={!showChat}><Chat /></aside>
        </div>
        <Controls title={title} />
        <ConnectionStateToast />
      </div>
      </Signals.Provider>
    </LayoutContextProvider>
  );
}

function Tile() {
  const ref = useEnsureTrackRef();
  const p = ref.participant;
  const name = p.name || p.identity;
  const agent = isAgent(p.identity);
  const share = ref.source === Track.Source.ScreenShare;
  const cameraOff = useIsMuted(ref as TrackReferenceOrPlaceholder);
  const micOff = useIsMuted({ participant: p, source: Track.Source.Microphone });
  const video = isTrackReference(ref) && !cameraOff;
  const signals = useContext(Signals);
  const handAt = signals?.hands.findIndex((h) => h.identity === p.identity) ?? -1;
  const lastReaction = signals?.reactions.filter((r) => r.identity === p.identity).at(-1);
  if (share && p.isLocal) return <YouArePresenting />;   // not your own screen inside your screen
  return (
    <>
      {video
        ? <VideoTrack trackRef={ref} className={share ? 'cs-video contain' : 'cs-video'} />
        : (
          <div className="cs-avatar-wrap" aria-hidden="true">
            {agent
              ? <span className="cs-avatar agent"><Icon name="sparkle" size={34} /></span>
              : <span className="cs-avatar" style={{ '--h': hue(name) } as CSSProperties}>{initials(name)}</span>}
          </div>
        )}
      {!share && handAt >= 0 && (
        <span className="cs-hand" data-testid="call-hand" title={`${name} raised a hand`} aria-label={`Hand raised${signals!.hands.length > 1 ? `, ${handAt + 1} in line` : ''}`}>
          <Icon name="hand" size={15} />{signals!.hands.length > 1 && <b>{handAt + 1}</b>}
        </span>
      )}
      {!share && lastReaction && <span key={lastReaction.id} className="cs-tile-react" aria-hidden="true">{lastReaction.emoji}</span>}
      {!share && !agent && micOff && <span className="cs-muted" title={`${name}'s microphone is off`} aria-label="Microphone off"><Icon name="micOff" size={14} /></span>}
      <div className="cs-name" data-testid={agent ? 'call-agent-tile' : undefined}>
        <span>{share ? `${p.isLocal ? 'You are' : `${name} is`} presenting` : `${name}${p.isLocal ? ' (You)' : ''}`}</span>
        {agent && <small><Icon name="sparkle" size={11} /> Taking notes</small>}
      </div>
      {!share && !agent && <ConnectionQualityIndicator className="cs-quality" />}
    </>
  );
}

function YouArePresenting() {
  const { localParticipant } = useLocalParticipant();
  return (
    <div className="cs-you-present" data-testid="call-you-present">
      <Icon name="present" size={30} />
      <b>You are presenting to everyone</b>
      <button type="button" className="cs-stop-present" onClick={() => void localParticipant.setScreenShareEnabled(false)}>Stop presenting</button>
    </div>
  );
}

/** Reactions float up the left of the call with the sender's name, then fade. */
function Reactions() {
  const signals = useContext(Signals);
  if (!signals?.reactions.length) return null;
  return (
    <div className="cs-reactions" aria-live="polite">
      {signals.reactions.map((r) => (
        <span key={r.id} className="cs-float" style={{ '--lane': r.lane } as CSSProperties} data-testid="call-reaction">
          <span className="emoji" aria-label={`${r.name} reacted`}>{r.emoji}</span><small>{r.name}</small>
        </span>
      ))}
    </div>
  );
}

/** Raised hands, in the order they went up. The host can lower them. */
function Hands() {
  const signals = useContext(Signals);
  const [open, setOpen] = useState(false);
  const hands = signals?.hands ?? [];
  useEffect(() => { if (!hands.length) setOpen(false); }, [hands.length]);
  if (!signals || !hands.length) return null;
  const first = hands[0];
  return (
    <div className={`cs-hands${open ? ' open' : ''}`} data-testid="call-hands">
      <button type="button" className="cs-hands-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="cs-hands-icon"><Icon name="hand" size={16} /></span>
        <span>{hands.length === 1 ? (first.mine ? 'Your hand is raised' : `${first.name} raised a hand`) : `${hands.length} raised hands`}</span>
        <Icon name={open ? 'chevronD' : 'chevronR'} size={14} />
      </button>
      {open && (
        <ol>
          {hands.map((h) => (
            <li key={h.identity}>
              <span>{h.name}</span>
              {(h.mine || signals.isHost) && <button type="button" onClick={() => (h.mine ? signals.lower() : signals.lowerOne(h.identity))}>Lower</button>}
            </li>
          ))}
        </ol>
      )}
      {signals.isHost && hands.length > 1 && <button type="button" className="cs-hands-all" onClick={signals.lowerAll}>Lower all</button>}
    </div>
  );
}

function ReactButton() {
  const signals = useContext(Signals);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', away); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', esc); };
  }, [open]);
  if (!signals) return null;
  return (
    <div className="cs-react" ref={box}>
      {open && (
        <div className="cs-react-bar" role="menu" aria-label="Send a reaction">
          {REACTIONS.map((e) => <button key={e} type="button" role="menuitem" onClick={() => signals.sendReaction(e)} aria-label={`React ${e}`}>{e}</button>)}
        </div>
      )}
      <button type="button" className={`cs-btn react${open ? ' on' : ''}`} aria-label="Send a reaction" title="Send a reaction" aria-expanded={open} onClick={() => setOpen((o) => !o)} data-testid="call-react">
        <Icon name="smile" size={20} />
      </button>
    </div>
  );
}

function HandButton() {
  const signals = useContext(Signals);
  if (!signals) return null;
  return (
    <button type="button" className={`cs-btn hand${signals.handUp ? ' on' : ''}`} aria-pressed={signals.handUp} data-testid="call-raise-hand"
      aria-label={signals.handUp ? 'Lower your hand' : 'Raise your hand'} title={signals.handUp ? 'Lower your hand' : 'Raise your hand'}
      onClick={() => (signals.handUp ? signals.lower() : signals.raise())}>
      <Icon name="hand" size={20} />
    </button>
  );
}

/** Keeps the screen on during the call (as Meet does): a phone or laptop going to sleep would drop it. Taken again when the page returns. */
function useScreenAwake() {
  useEffect(() => {
    type Lock = { release: () => Promise<void> };
    const wl = (navigator as unknown as { wakeLock?: { request: (t: 'screen') => Promise<Lock> } }).wakeLock;
    if (!wl) return;
    let lock: Lock | null = null, gone = false;
    const take = () => { if (document.visibilityState === 'visible' && !gone) wl.request('screen').then((l) => { if (gone) void l.release(); else lock = l; }).catch(() => {}); };
    take();
    document.addEventListener('visibilitychange', take);
    return () => { gone = true; document.removeEventListener('visibilitychange', take); void lock?.release().catch(() => {}); };
  }, []);
}

function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const t = window.setInterval(() => setNow(new Date()), 20_000); return () => window.clearInterval(t); }, []);
  return now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function Controls({ title }: { title: string }) {
  const time = useClock();
  return (
    <div className="cs-bar" role="toolbar" aria-label="Call controls">
      <div className="cs-bar-side cs-bar-left"><b>{time}</b><i aria-hidden="true" /><span>{title}</span></div>
      <div className="cs-bar-mid">
        <div className="cs-pair">
          <TrackToggle source={Track.Source.Microphone} showIcon={false} className="cs-btn" aria-label="Microphone" title="Turn the microphone on or off" data-testid="call-mic">
            <span className="on"><Icon name="mic" size={20} /></span><span className="off"><Icon name="micOff" size={20} /></span>
          </TrackToggle>
          <MediaDeviceMenu kind="audioinput" className="cs-menu" aria-label="Choose a microphone" title="Choose a microphone"><Icon name="chevronD" size={14} /></MediaDeviceMenu>
        </div>
        <div className="cs-pair">
          <TrackToggle source={Track.Source.Camera} showIcon={false} className="cs-btn" aria-label="Camera" title="Turn the camera on or off" data-testid="call-camera">
            <span className="on"><Icon name="video" size={20} /></span><span className="off"><Icon name="videoOff" size={20} /></span>
          </TrackToggle>
          <MediaDeviceMenu kind="videoinput" className="cs-menu" aria-label="Choose a camera" title="Choose a camera"><Icon name="chevronD" size={14} /></MediaDeviceMenu>
        </div>
        {canShare && (
          <TrackToggle source={Track.Source.ScreenShare} showIcon={false} className="cs-btn share" aria-label="Present your screen" title="Present your screen" captureOptions={{ audio: true, selfBrowserSurface: 'exclude' }}>
            <Icon name="present" size={20} />
          </TrackToggle>
        )}
        <HandButton />
        <ReactButton />
        <ChatToggle className="cs-btn chat" aria-label="Messages" title="Messages in this call" data-testid="call-chat"><Icon name="message" size={20} /></ChatToggle>
        <DisconnectButton className="cs-leave" aria-label="Leave the call" title="Leave the call" data-testid="call-leave"><Icon name="phoneOff" size={22} /></DisconnectButton>
      </div>
      <div className="cs-bar-side cs-bar-right"><StartAudio label="Turn on call audio" className="cs-start-audio" /></div>
    </div>
  );
}

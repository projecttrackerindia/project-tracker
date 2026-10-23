import type { HubConnection } from '@microsoft/signalr';
import type { Schema } from '@tiptap/pm/model';
import { prosemirrorJSONToYXmlFragment } from '@tiptap/y-tiptap';
import * as Y from 'yjs';
import { applyAwarenessUpdate, Awareness, encodeAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness';
import { liveConnection, onLiveConnected } from '../../live/bus';

export interface DocPeerInfo { connectionId: string; userId: string; name: string; color: string }
interface RoomInfo { peers: DocPeerInfo[]; leader: string | null }
interface JoinAnswer { canEdit: boolean; init?: boolean; updates?: string[]; room?: RoomInfo; color?: string; revision?: number }

const REMOTE = Symbol('remote');
const FIELD = 'default';
/** How long a newcomer waits for the first editor's text before starting from the saved text itself. */
const WAIT_FOR_TEXT_MS = 4000;

export function toB64(u: Uint8Array): string {
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}
export function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}

/** True when the shared text has nothing in it yet (no first editor has put the saved text in). */
const isEmpty = (doc: Y.Doc) => doc.getXmlFragment(FIELD).length === 0;

/**
 * Editing one page together through the app's live connection. The text is a Yjs document: every keystroke is a small update passed to the
 * others through the server (which remembers the history so a newcomer catches up), cursors travel as awareness updates. One editor - the
 * first in the room - saves for everyone, so autosave never fights itself; when they leave the next one takes over.
 */
export class DocCollab {
  readonly doc = new Y.Doc();
  readonly awareness: Awareness;
  peers: DocPeerInfo[] = [];
  color = '#2563eb';
  /** Joined and connected: changes reach the others now. */
  online = false;
  /** Still waiting for the first editor's text (typing is held back so two copies of the page are never merged). */
  waiting = false;
  private leaderId: string | null = null;
  private wasLeader = true;
  private conn: HubConnection | null = null;
  private detach: (() => void) | null = null;
  private stopReconnect: (() => void) | null = null;
  private listeners = new Set<() => void>();
  private savedListeners = new Set<(revision: number, by: string | null) => void>();
  private waitTimer: number | undefined;
  private destroyed = false;

  constructor(readonly documentId: string, private readonly schema: Schema, private readonly savedText: () => unknown, readonly me: { userId: string; name: string }) {
    this.awareness = new Awareness(this.doc);
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === REMOTE || !this.online) return;
      this.send('DocUpdate', toB64(update));
    });
    this.awareness.on('update', ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      if (origin === REMOTE || !this.online) return;
      const changed = [...added, ...updated, ...removed].filter((c) => c === this.doc.clientID);
      if (changed.length) this.send('DocAwareness', toB64(encodeAwarenessUpdate(this.awareness, changed)));
    });
  }

  /** The one who saves: the first editor in the room (or this one, alone or while the connection is down and it was saving before). */
  get isLeader() { return this.online ? this.leaderId === this.conn?.connectionId : this.wasLeader; }
  /** The other people editing now (one entry per person). */
  get others() {
    const seen = new Set<string>();
    return this.peers.filter((p) => p.connectionId !== this.conn?.connectionId && p.userId !== this.me.userId && !seen.has(p.userId) && (seen.add(p.userId), true));
  }

  subscribe(l: () => void) { this.listeners.add(l); return () => { this.listeners.delete(l); }; }
  onSaved(l: (revision: number, by: string | null) => void) { this.savedListeners.add(l); return () => { this.savedListeners.delete(l); }; }
  private emit() { this.listeners.forEach((l) => l()); }

  private send(method: string, payload: string) {
    const c = this.conn;
    if (c && String(c.state) === 'Connected') void c.invoke(method, this.documentId, payload).catch(() => { /* the next full sync on reconnect repairs it */ });
  }

  /** The leader saved revision N: the others take it as their own starting point (so their next save is not a conflict). */
  saved(revision: number) {
    const c = this.conn;
    if (this.online && c && String(c.state) === 'Connected') void c.invoke('DocSaved', this.documentId, revision).catch(() => { /* best effort */ });
  }

  /** Joins the page's room. False when live editing is not possible now (no connection, no right to edit): the page then edits on its own. */
  async start(): Promise<boolean> {
    this.stopReconnect ??= onLiveConnected(() => { if (!this.destroyed) void this.join(true); });
    return this.join(false);
  }

  private attach(c: HubConnection) {
    if (this.conn === c && this.detach) return;
    this.detach?.();
    this.conn = c;
    const mine = (e: { documentId: string }) => e.documentId === this.documentId;
    const onUpdate = (e: { documentId: string; update: string }) => {
      if (!mine(e)) return;
      Y.applyUpdate(this.doc, fromB64(e.update), REMOTE);
      if (this.waiting && !isEmpty(this.doc)) { this.waiting = false; window.clearTimeout(this.waitTimer); this.emit(); }
    };
    const onAware = (e: { documentId: string; update: string }) => { if (mine(e)) applyAwarenessUpdate(this.awareness, fromB64(e.update), REMOTE); };
    const onPeers = (e: { documentId: string; room: RoomInfo; left?: string }) => {
      if (!mine(e)) return;
      const before = new Set(this.peers.map((p) => p.connectionId));
      this.setRoom(e.room);
      if (e.left) {
        const gone = [...this.awareness.getStates().entries()].filter(([, st]) => (st as { conn?: string }).conn === e.left).map(([id]) => id);
        if (gone.length) removeAwarenessStates(this.awareness, gone, REMOTE);
      }
      // Someone new: they need to see where my cursor is now, not in 15 seconds.
      if (e.room.peers.some((p) => !before.has(p.connectionId))) this.send('DocAwareness', toB64(encodeAwarenessUpdate(this.awareness, [this.doc.clientID])));
    };
    const onCompact = (e: { documentId: string }) => { if (mine(e)) this.send('DocCompact', toB64(Y.encodeStateAsUpdate(this.doc))); };
    const onSaved = (e: { documentId: string; revision: number; by?: string | null }) => { if (mine(e)) this.savedListeners.forEach((l) => l(e.revision, e.by ?? null)); };
    c.on('docUpdate', onUpdate); c.on('docAwareness', onAware); c.on('docPeers', onPeers); c.on('docCompact', onCompact); c.on('docSaved', onSaved);
    const closed = () => { this.online = false; this.emit(); };
    c.onreconnecting(closed); c.onclose(closed);
    this.detach = () => { c.off('docUpdate', onUpdate); c.off('docAwareness', onAware); c.off('docPeers', onPeers); c.off('docCompact', onCompact); c.off('docSaved', onSaved); };
  }

  private setRoom(room: RoomInfo) {
    this.peers = room.peers;
    this.leaderId = room.leader;
    this.wasLeader = this.leaderId === this.conn?.connectionId;
    this.emit();
  }

  private async join(rejoin: boolean): Promise<boolean> {
    const c = liveConnection();
    if (!c || String(c.state) !== 'Connected' || this.destroyed) return false;
    this.attach(c);
    let answer: JoinAnswer | null = null;
    try { answer = await c.invoke<JoinAnswer | null>('DocJoin', this.documentId); } catch { answer = null; }
    if (this.destroyed) { if (answer?.canEdit) void c.invoke('DocLeave', this.documentId).catch(() => {}); return false; }
    if (!answer || !answer.canEdit) { this.online = false; if (!rejoin) { this.detach?.(); this.detach = null; } this.emit(); return false; }
    this.color = answer.color ?? this.color;
    this.awareness.setLocalStateField('conn', c.connectionId);
    for (const u of answer.updates ?? []) Y.applyUpdate(this.doc, fromB64(u), REMOTE);
    this.online = true;
    if (answer.room) this.setRoom(answer.room);
    if (!isEmpty(this.doc)) {
      // Back after a dropped connection (or a newcomer with the history): make sure the room has everything this copy has.
      this.send('DocUpdate', toB64(Y.encodeStateAsUpdate(this.doc)));
    } else if (answer.init) {
      this.seed();
    } else {
      // Someone else is starting the room right now: wait for their text rather than putting in a second copy of the page.
      this.waiting = true;
      window.clearTimeout(this.waitTimer);
      this.waitTimer = window.setTimeout(() => { if (this.waiting && isEmpty(this.doc)) this.seed(); this.waiting = false; this.emit(); }, WAIT_FOR_TEXT_MS);
    }
    this.send('DocAwareness', toB64(encodeAwarenessUpdate(this.awareness, [this.doc.clientID])));
    this.emit();
    return true;
  }

  /** The saved text becomes the shared text (sent to the room as the first update). */
  private seed() {
    const json = this.savedText();
    this.doc.transact(() => { prosemirrorJSONToYXmlFragment(this.schema, json, this.doc.getXmlFragment(FIELD)); });
  }

  /** Text for a page with no live connection: the saved text, put in before the editor opens. */
  seedOffline() { if (isEmpty(this.doc)) this.seed(); }

  destroy() {
    this.destroyed = true;
    window.clearTimeout(this.waitTimer);
    this.stopReconnect?.();
    const c = this.conn;
    if (this.online && c && String(c.state) === 'Connected') void c.invoke('DocLeave', this.documentId).catch(() => {});
    this.detach?.();
    this.online = false;
    this.awareness.destroy();
    this.listeners.clear(); this.savedListeners.clear();
  }
}

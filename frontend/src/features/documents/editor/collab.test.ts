import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { yXmlFragmentToProsemirrorJSON } from '@tiptap/y-tiptap';
import * as Y from 'yjs';

// The live connection the provider uses, swapped per test client (each editor has its own connection to the server).
const bus = vi.hoisted(() => ({ current: null as unknown, listeners: new Set<() => void>() }));
vi.mock('../../live/bus', () => ({
  liveConnection: () => bus.current,
  onLiveConnected: (l: () => void) => { bus.listeners.add(l); return () => bus.listeners.delete(l); },
}));
const { DocCollab } = await import('./collab');

/** The server's side, as DocumentCollab.cs does it: one room per page, its history, its people, the first one in leads. */
class FakeServer {
  rooms = new Map<string, { updates: string[]; initialized: boolean; peers: { id: string; userId: string; name: string; at: number }[] }>();
  conns = new Map<string, FakeConn>();
  seq = 0;
  room(doc: string) { let r = this.rooms.get(doc); if (!r) { r = { updates: [], initialized: false, peers: [] }; this.rooms.set(doc, r); } return r; }
  info(doc: string) { const r = this.room(doc); return { peers: r.peers.map((p) => ({ connectionId: p.id, userId: p.userId, name: p.name, color: '#123456' })), leader: r.peers[0]?.id ?? null }; }
  others(doc: string, from: string) { return this.room(doc).peers.filter((p) => p.id !== from).map((p) => this.conns.get(p.id)!); }
  call(c: FakeConn, method: string, args: unknown[]): unknown {
    const [doc, payload] = args as [string, string];
    const r = this.room(doc);
    switch (method) {
      case 'DocJoin': {
        const init = !r.initialized; r.initialized = true;
        const history = [...r.updates];
        r.peers.push({ id: c.connectionId, userId: c.userId, name: c.userId, at: ++this.seq });
        for (const o of this.others(doc, c.connectionId)) o.emit('docPeers', { documentId: doc, room: this.info(doc) });
        return { canEdit: true, init, updates: history, room: this.info(doc), color: '#123456', revision: 1 };
      }
      case 'DocUpdate':
        r.updates.push(payload);
        for (const o of this.others(doc, c.connectionId)) o.emit('docUpdate', { documentId: doc, update: payload });
        return null;
      case 'DocCompact': r.updates = [payload]; return null;
      case 'DocAwareness': for (const o of this.others(doc, c.connectionId)) o.emit('docAwareness', { documentId: doc, update: payload }); return null;
      case 'DocSaved': for (const o of this.others(doc, c.connectionId)) o.emit('docSaved', { documentId: doc, revision: payload, by: c.userId }); return null;
      case 'DocLeave': {
        r.peers = r.peers.filter((p) => p.id !== c.connectionId);
        if (!r.peers.length) this.rooms.delete(doc);
        else for (const o of this.others(doc, c.connectionId)) o.emit('docPeers', { documentId: doc, room: this.info(doc), left: c.connectionId });
        return null;
      }
    }
    return null;
  }
  restart() { this.rooms.clear(); }
}

class FakeConn {
  state = 'Connected';
  handlers = new Map<string, Set<(e: unknown) => void>>();
  constructor(private server: FakeServer, readonly connectionId: string, readonly userId: string) { server.conns.set(connectionId, this); }
  on(name: string, h: (e: unknown) => void) { (this.handlers.get(name) ?? this.handlers.set(name, new Set()).get(name)!).add(h); }
  off(name: string, h: (e: unknown) => void) { this.handlers.get(name)?.delete(h); }
  onreconnecting() {} onclose() {}
  emit(name: string, e: unknown) { this.handlers.get(name)?.forEach((h) => h(e)); }
  async invoke<T>(method: string, ...args: unknown[]): Promise<T> { return this.server.call(this, method, args) as T; }
}

const schema = getSchema([StarterKit]);
const saved = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Refunds take five days.' }] }] };
const text = (c: InstanceType<typeof DocCollab>) => JSON.stringify(yXmlFragmentToProsemirrorJSON(c.doc.getXmlFragment('default')));
const typeInto = (c: InstanceType<typeof DocCollab>, words: string) => {
  const para = c.doc.getXmlFragment('default').get(0) as Y.XmlElement;
  const t = para.get(0) as Y.XmlText;
  t.insert(t.length, words);
};

describe('editing a page together', () => {
  let server: FakeServer;
  const open: InstanceType<typeof DocCollab>[] = [];
  const join = async (conn: string, user: string) => {
    const c = new FakeConn(server, conn, user);
    bus.current = c;
    const collab = new DocCollab('page-1', schema, () => saved, { userId: user, name: user });
    open.push(collab);
    expect(await collab.start()).toBe(true);
    return collab;
  };
  beforeEach(() => { server = new FakeServer(); vi.stubGlobal('window', { setTimeout: (f: () => void, ms: number) => globalThis.setTimeout(f, ms), clearTimeout: (id: number) => globalThis.clearTimeout(id) }); });
  afterEach(() => { open.splice(0).forEach((c) => c.destroy()); bus.listeners.clear(); vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('starts from the saved text, and a newcomer catches up from the history', async () => {
    const a = await join('c1', 'asha');
    expect(text(a)).toContain('Refunds take five days.');
    typeInto(a, ' Weekends do not count.');
    const b = await join('c2', 'ravi');
    expect(text(b)).toBe(text(a));
    expect(text(b).match(/Refunds take five days/g)).toHaveLength(1);   // the saved text is put in once, not by every editor
  });

  it('passes every change to the others as it is typed', async () => {
    const a = await join('c1', 'asha');
    const b = await join('c2', 'ravi');
    typeInto(b, ' Ask finance.');
    expect(text(a)).toContain('Ask finance.');
    typeInto(a, ' Today.');
    expect(text(b)).toContain('Today.');
    expect(text(a)).toBe(text(b));
  });

  it('lets only the first editor save, and the next one takes over when they leave', async () => {
    const a = await join('c1', 'asha');
    const b = await join('c2', 'ravi');
    expect(a.isLeader).toBe(true);
    expect(b.isLeader).toBe(false);
    expect(a.others.map((p) => p.userId)).toEqual(['ravi']);
    const saves: number[] = [];
    b.onSaved((rev) => saves.push(rev));
    a.saved(7);
    expect(saves).toEqual([7]);
    a.destroy();
    expect(b.isLeader).toBe(true);
    expect(b.others).toEqual([]);
  });

  it('waits for the first editor rather than putting the page in twice', async () => {
    vi.useFakeTimers();
    // The room is started by someone whose text has not arrived yet.
    server.room('page-1').initialized = true;
    server.room('page-1').peers.push({ id: 'c0', userId: 'zoe', name: 'zoe', at: 0 });
    server.conns.set('c0', new FakeConn(server, 'c0', 'zoe'));
    const b = await join('c2', 'ravi');
    expect(b.waiting).toBe(true);
    // The first editor's text arrives: it is taken as it is.
    const first = new Y.Doc();
    const { prosemirrorJSONToYXmlFragment } = await import('@tiptap/y-tiptap');
    prosemirrorJSONToYXmlFragment(schema, saved, first.getXmlFragment('default'));
    server.conns.get('c2')!.emit('docUpdate', { documentId: 'page-1', update: btoa(String.fromCharCode(...Y.encodeStateAsUpdate(first))) });
    expect(b.waiting).toBe(false);
    vi.advanceTimersByTime(5000);
    expect(text(b).match(/Refunds take five days/g)).toHaveLength(1);
  });

  it('starts from the saved text itself when the first editor never sends theirs', async () => {
    vi.useFakeTimers();
    server.room('page-1').initialized = true;
    const b = await join('c2', 'ravi');
    expect(b.waiting).toBe(true);
    vi.advanceTimersByTime(4500);
    expect(b.waiting).toBe(false);
    expect(text(b)).toContain('Refunds take five days.');
  });

  it('keeps the history short: the leader sends the whole page when the server asks', async () => {
    const a = await join('c1', 'asha');
    for (let i = 0; i < 20; i++) typeInto(a, ` ${i}`);
    expect(server.room('page-1').updates.length).toBeGreaterThan(20);
    server.conns.get('c1')!.emit('docCompact', { documentId: 'page-1' });
    expect(server.room('page-1').updates).toHaveLength(1);
    const c = await join('c3', 'mira');
    expect(text(c)).toBe(text(a));
  });

  it('after the server restarts, an editor puts back what it has instead of the saved text', async () => {
    const a = await join('c1', 'asha');
    typeInto(a, ' Not saved yet.');
    server.restart();
    bus.current = server.conns.get('c1');
    bus.listeners.forEach((l) => l());   // reconnected
    await Promise.resolve(); await Promise.resolve();
    expect(text(a).match(/Refunds take five days/g)).toHaveLength(1);
    const b = await join('c2', 'ravi');
    expect(text(b)).toContain('Not saved yet.');
  });
});

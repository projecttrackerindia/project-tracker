import { useEffect, useState } from 'react';
import { Avatar } from '../../components/ui';
import { useAuth } from '../../stores/auth';
import { hubInvoke, onLiveConnected, onViewing } from './bus';

const ANNOUNCE_MS = 30_000;
const FORGET_MS = 75_000;

/** Keys as the server writes them: "task:<id without dashes>". */
const normal = (kind: string, id: string) => `${kind}:${id.replace(/-/g, '').toLowerCase()}`;

/**
 * Who else has this task (or work task) open right now. Each open copy announces itself to the others and answers newcomers; someone who
 * stops announcing (closed the tab, lost the connection) disappears after a little over a minute.
 */
export function useViewers(kind: 'task' | 'work', id: string | undefined) {
  const me = useAuth((s) => s.ctx?.user.id);
  const [viewers, setViewers] = useState<Record<string, { name: string; seen: number }>>({});
  useEffect(() => {
    if (!id) return;
    const key = normal(kind, id);
    setViewers({});
    const announce = () => hubInvoke('Watch', key);
    announce();
    const offConnected = onLiveConnected(announce);
    const off = onViewing((e) => {
      if (e.key !== key || e.userId === me) return;
      if (e.hello) hubInvoke('Here', key);   // a newcomer: tell them we are here too
      setViewers((v) => {
        const next = { ...v };
        if (e.on) next[e.userId] = { name: e.name ?? v[e.userId]?.name ?? 'Someone', seen: Date.now() };
        else delete next[e.userId];
        return next;
      });
    });
    const tick = window.setInterval(() => {
      hubInvoke('Here', key);
      setViewers((v) => Object.fromEntries(Object.entries(v).filter(([, x]) => Date.now() - x.seen < FORGET_MS)));
    }, ANNOUNCE_MS);
    return () => { off(); offConnected(); window.clearInterval(tick); hubInvoke('Unwatch', key); };
  }, [kind, id, me]);
  return Object.entries(viewers).map(([uid, v]) => ({ id: uid, name: v.name }));
}

/** "Also here": the faces of the other people looking at the same thing. */
export function Viewers({ kind, id }: { kind: 'task' | 'work'; id: string | undefined }) {
  const viewers = useViewers(kind, id);
  if (viewers.length === 0) return null;
  const names = viewers.map((v) => v.name);
  return (
    <div className="viewers" title={`Also viewing: ${names.join(', ')}`} aria-label={`Also viewing: ${names.join(', ')}`}>
      <span className="viewers-dot" />
      <div className="viewers-faces">{viewers.slice(0, 4).map((v) => <Avatar key={v.id} name={v.name} size="sm" />)}</div>
      <span className="viewers-text">{viewers.length === 1 ? `${names[0]} is here too` : `${viewers.length} others here`}</span>
    </div>
  );
}

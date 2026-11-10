import { SiriOrb } from './aura/SiriOrb';

/** The assistant's mark: the Aura ring (busy turns it fast). */
export function AgentMark({ size = 32, busy = false }: { size?: number; busy?: boolean; animated?: boolean }) {
  return <SiriOrb size={size} state={busy ? 'thinking' : 'idle'} className="agent-mark" />;
}

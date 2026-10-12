import './agentMark.css';

/** A circuit-framed A. Decorative motion never conveys status without accompanying text. */
export function AgentMark({ size = 32, busy = false, animated = false }: { size?: number; busy?: boolean; animated?: boolean }) {
  return <span className={`agent-mark ai-orb ${busy ? 'busy' : ''} ${animated ? 'animated' : ''}`} style={{ width: size, height: size }} aria-hidden="true">
    <svg viewBox="0 0 48 48" fill="none">
      <path className="agent-frame" d="M16 8h16l8 8v16l-8 8H16l-8-8V16l8-8Z" />
      <path className="agent-signal" d="M16 8h16l8 8v16l-8 8H16l-8-8V16l8-8Z" />
      <path className="agent-core" d="m17 31 7-15 7 15M20 26h8" />
      <path className="agent-ports" d="M4 24h4m32 0h4M24 4v4m0 32v4" />
    </svg>
  </span>;
}

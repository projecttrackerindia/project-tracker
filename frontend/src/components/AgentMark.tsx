import { useId } from 'react';
import './agentMark.css';

/** An original gradient ring. Decorative motion never conveys status without accompanying text. */
export function AgentMark({ size = 32, busy = false, animated = false }: { size?: number; busy?: boolean; animated?: boolean }) {
  const gradient = useId().replace(/:/g, '');
  return <span className={`agent-mark ai-orb ${busy ? 'busy' : ''} ${animated ? 'animated' : ''}`} style={{ width: size, height: size }} aria-hidden="true">
    <svg viewBox="0 0 48 48" fill="none">
      <defs><linearGradient id={gradient} x1="5" y1="8" x2="43" y2="40" gradientUnits="userSpaceOnUse"><stop stopColor="#14b8f5"/><stop offset=".48" stopColor="#5263ff"/><stop offset="1" stopColor="#ac4bde"/></linearGradient></defs>
      <circle className="agent-frame" cx="24" cy="24" r="17" />
      <path className="agent-core" stroke={`url(#${gradient})`} d="M24 6.5C34.1 6.5 42 13.8 42 24c0 8.9-6.2 17.5-17.1 17.5C14.6 41.5 6 34.9 6 24.5c0-9.6 7.2-18 18-18Z" />
      <circle className="agent-signal" cx="24" cy="24" r="17.5" stroke={`url(#${gradient})`} />
    </svg>
  </span>;
}

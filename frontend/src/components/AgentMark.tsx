import { useId } from 'react';
import './agentMark.css';

/** A continuous ribbon; motion is decorative and respects reduced-motion preferences. */
export function AgentMark({ size = 32, busy = false, animated = false }: { size?: number; busy?: boolean; animated?: boolean }) {
  const gradient = `agent-${useId().replace(/:/g, '')}`;
  return <span className={`agent-mark ai-orb ${busy ? 'busy' : ''} ${animated ? 'animated' : ''}`} style={{ width: size, height: size }} aria-hidden="true">
    <svg className="agent-ribbon" viewBox="0 0 48 48" fill="none">
      <defs><linearGradient id={gradient} x1="7" y1="8" x2="41" y2="40" gradientUnits="userSpaceOnUse"><stop stopColor="#20b8ef" /><stop offset=".48" stopColor="#4768f5" /><stop offset="1" stopColor="#8b5cf6" /></linearGradient></defs>
      <path d="M24 6C34 6 42 14 42 24S34 42 24 42 6 34 6 24 14 6 24 6Z" stroke={`url(#${gradient})`} strokeWidth="5" />
      <path className="agent-ribbon-light" d="M9 18C13 8 25 5 34 12" stroke="currentColor" strokeOpacity=".6" strokeWidth="2" strokeLinecap="round" />
    </svg>
  </span>;
}

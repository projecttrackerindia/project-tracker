import './agentMark.css';

/**
 * The Agent's identity: a luminous gradient ring around a dark glass core with a four-point spark.
 * `animated` slowly turns the ring and lets the spark breathe; `busy` speeds the ring up and sends a light
 * around it. Motion is decorative only - status is always also given in text - and stops entirely under
 * prefers-reduced-motion.
 */
export function AgentMark({ size = 32, busy = false, animated = false }: { size?: number; busy?: boolean; animated?: boolean }) {
  return <span className={`agent-mark ai-orb ${busy ? 'busy' : ''} ${animated ? 'animated' : ''}`} style={{ width: size, height: size }} aria-hidden="true">
    <span className="agent-glow" />
    <span className="agent-ring" />
    <span className="agent-disc" />
    <span className="agent-orbit" />
    <svg className="agent-spark" viewBox="0 0 48 48" fill="none">
      <path className="agent-star" d="M24 9c1.2 8.2 4.8 11.8 13 13-8.2 1.2-11.8 4.8-13 13-1.2-8.2-4.8-11.8-13-13 8.2-1.2 11.8-4.8 13-13Z" />
      <circle className="agent-dot" cx="35.5" cy="12.5" r="2.1" />
    </svg>
  </span>;
}

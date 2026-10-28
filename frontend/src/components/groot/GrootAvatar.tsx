import { useReducedMotion } from 'framer-motion';
import './groot.css';

export type GrootState = 'idle' | 'listening' | 'thinking' | 'working' | 'success' | 'error' | 'greeting';

const LABEL: Record<GrootState, string> = {
  idle: 'Groot', listening: 'Groot is listening', thinking: 'Groot is thinking', working: 'Groot is working on it',
  success: 'Groot finished', error: 'Groot ran into a problem', greeting: 'Groot says hello',
};

/**
 * Groot, the app's assistant, as a small friendly robot: a rounded white shell, a dark visor with glowing violet eyes, one antenna and two
 * stubby arms. Drawn in SVG and moved with CSS only (no Lottie), so it is crisp at any size and themable. The state is on `data-state`:
 * idle floats and blinks; listening widens the eyes and pulses the antenna; thinking looks around with orbiting dots; working moves the
 * arms inside a progress ring; success smiles, bounces and sparkles; error looks concerned; greeting waves. Reduced motion keeps every pose
 * but stops the movement.
 */
export function GrootAvatar({ state = 'idle', size = 40, className, title }: { state?: GrootState; size?: number; className?: string; title?: string }) {
  const still = useReducedMotion();
  return (
    <span className={`groot${still ? ' still' : ''}${className ? ` ${className}` : ''}`} data-state={state} style={{ width: size, height: size }}
      role="img" aria-label={title ?? LABEL[state]} data-testid="groot-avatar">
      <svg viewBox="0 0 120 120" width={size} height={size} aria-hidden="true" focusable="false">
        <defs>
          <radialGradient id="groot-shell" cx="38%" cy="28%" r="80%">
            <stop offset="0" stopColor="var(--gr-shell-hi)" />
            <stop offset="1" stopColor="var(--gr-shell)" />
          </radialGradient>
          <radialGradient id="groot-visor" cx="45%" cy="30%" r="85%">
            <stop offset="0" stopColor="#2a2350" />
            <stop offset="1" stopColor="#100c22" />
          </radialGradient>
        </defs>
        {/* working: a ring that fills around Groot */}
        <circle className="gr-ring-track" cx="60" cy="60" r="56" />
        <circle className="gr-ring" cx="60" cy="60" r="56" pathLength={100} />
        <g className="gr-float">
          {/* arms (behind the body), pivoting at the shoulder */}
          <g className="gr-arm gr-arm-l"><rect x="20" y="78" width="12" height="24" rx="6" /></g>
          <g className="gr-arm gr-arm-r"><rect x="88" y="78" width="12" height="24" rx="6" /></g>
          {/* body: a soft rounded bell with a chest light */}
          <path className="gr-shell" d="M38 82 C38 72 46 68 60 68 C74 68 82 72 82 82 L80 102 C79 110 71 114 60 114 C49 114 41 110 40 102 Z" />
          <circle className="gr-chest" cx="60" cy="90" r="3.2" />
          {/* antenna */}
          <line className="gr-stalk" x1="60" y1="16" x2="60" y2="8" />
          <circle className="gr-bulb" cx="60" cy="7" r="4" />
          {/* ears */}
          <rect className="gr-ear" x="14" y="36" width="8" height="18" rx="4" />
          <rect className="gr-ear" x="98" y="36" width="8" height="18" rx="4" />
          {/* head and visor */}
          <rect className="gr-shell" x="20" y="15" width="80" height="60" rx="28" />
          <rect x="28" y="23" width="64" height="44" rx="20" fill="url(#groot-visor)" />
          <g className="gr-face">
            <g className="gr-eyes">
              <rect className="gr-eye" x="42" y="37" width="9" height="12" rx="4.5" />
              <rect className="gr-eye" x="69" y="37" width="9" height="12" rx="4.5" />
            </g>
            {/* success: happy closed eyes */}
            <path className="gr-happy" d="M41 45 Q46.5 38 52 45 M68 45 Q73.5 38 79 45" />
            {/* error: worried brows */}
            <path className="gr-brows" d="M40 34 L51 37 M80 34 L69 37" />
            <path className="gr-mouth" d="M53 55 Q60 60 67 55" />
          </g>
        </g>
        {/* thinking: three dots orbiting the head */}
        <g className="gr-orbit"><circle cx="60" cy="4" r="3" /><circle cx="60" cy="4" r="2.4" /><circle cx="60" cy="4" r="1.8" /></g>
        {/* success: sparkles */}
        <g className="gr-sparks">
          <path d="M104 18 l2 5 5 2 -5 2 -2 5 -2 -5 -5 -2 5 -2z" />
          <path d="M14 70 l1.5 3.5 3.5 1.5 -3.5 1.5 -1.5 3.5 -1.5 -3.5 -3.5 -1.5 3.5 -1.5z" />
        </g>
      </svg>
    </span>
  );
}

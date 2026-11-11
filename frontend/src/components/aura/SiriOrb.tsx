import { useAuraMood } from './mood';
import type { AuraMood } from './auraEngine';

export type SiriOrbState = 'idle' | 'listening' | 'thinking';

/** Which of the three orb states an app mood maps to. */
export const orbStateOf = (m: AuraMood): SiriOrbState =>
  m === 'listen' || m === 'privacy' ? 'listening' : m === 'think' || m === 'work' ? 'thinking' : 'idle';

/**
 * The one Aura mark used everywhere (header, the Aura surface, panels, cards, buttons, notifications): a thin gradient ring, like Apple
 * Intelligence. CSS only (styles/calm.css): a conic gradient masked to a ring that turns with transform, so it costs no canvas or JS loop.
 * Three states: idle (slow turn), listening (faster, a soft pulse) and thinking (fast turn). Still under Reduce Motion. Without `state`
 * it follows the app's Aura mood.
 */
export function SiriOrb({ size, state, className = '', label }: { size?: number; state?: SiriOrbState; className?: string; label?: string }) {
  const mood = useAuraMood((s) => s.mood);
  const st = state ?? orbStateOf(mood);
  return (
    <span className={`siri-orb ${className}`.trim()} data-state={st} data-testid="siri-orb"
      style={size ? { width: size, height: size } : undefined}
      role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      <i />
    </span>
  );
}

/** The Aura ring, by its design name. */
export const AuraRing = SiriOrb;

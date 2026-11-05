import { useAuraMood } from './mood';
import type { AuraMood } from './auraEngine';

export type SiriOrbState = 'idle' | 'listening' | 'thinking';

/** Which of the three orb states an app mood maps to. */
export const orbStateOf = (m: AuraMood): SiriOrbState =>
  m === 'listen' || m === 'privacy' ? 'listening' : m === 'think' || m === 'work' ? 'thinking' : 'idle';

/**
 * The one Aura orb used everywhere (header, Aura search sheet, Aura lines on every page). CSS only: layered conic/radial gradients that
 * turn and breathe with transform and opacity, so it costs no canvas or JS loop. Three states: idle (slow drift), listening (faster, a
 * soft pulse) and thinking (fast swirl). Under Reduce Motion it is a still gradient. Without `state` it follows the app's Aura mood.
 */
export function SiriOrb({ size, state, className = '', label }: { size?: number; state?: SiriOrbState; className?: string; label?: string }) {
  const mood = useAuraMood((s) => s.mood);
  const st = state ?? orbStateOf(mood);
  return (
    <span className={`siri-orb ${className}`.trim()} data-state={st} data-testid="siri-orb"
      style={size ? { width: size, height: size } : undefined}
      role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      <i /><i />
    </span>
  );
}

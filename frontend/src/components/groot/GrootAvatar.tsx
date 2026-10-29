import type { AuraMood } from '../aura/auraEngine';
import { AuraOrb } from '../aura/AuraOrb';
import './groot.css';

/** The assistant's states as the older screens name them (kept for wire and code compatibility; the assistant is Aura now). */
export type GrootState = 'idle' | 'listening' | 'thinking' | 'working' | 'success' | 'error' | 'greeting';

const LABEL: Record<GrootState, string> = {
  idle: 'Aura', listening: 'Aura is listening', thinking: 'Aura is thinking', working: 'Aura is working on it',
  success: 'Aura finished', error: 'Aura ran into a problem', greeting: 'Aura says hello',
};
/** idle and greeting follow the app's mood (useAuraMood); the rest are the matching Aura moods. */
export const MOOD_OF: Record<GrootState, AuraMood | undefined> = {
  idle: undefined, greeting: undefined, listening: 'listen', thinking: 'think', working: 'work', success: 'happy', error: 'sad',
};

/**
 * Aura, the app's assistant, as a glowing orb (AuraOrb). Kept under its old name so every screen that showed the mascot shows the orb;
 * new code uses AuraAvatar or AuraOrb. The state is also on `data-state` for tests and styling.
 */
export function GrootAvatar({ state = 'idle', size = 40, className, title, mood }: { state?: GrootState; size?: number; className?: string; title?: string; mood?: AuraMood }) {
  return (
    <span className={`groot${className ? ` ${className}` : ''}`} data-state={state} style={{ width: size, height: size }} role="img" aria-label={title ?? LABEL[state]} data-testid="aura-avatar">
      <AuraOrb mood={mood ?? MOOD_OF[state]} size={size} label={null} />
    </span>
  );
}
export const AuraAvatar = GrootAvatar;
export type AuraState = GrootState;

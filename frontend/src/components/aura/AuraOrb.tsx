import { forwardRef, useImperativeHandle, useRef } from 'react';
import { AURA_MOODS, type AuraMood } from './auraEngine';
import { useAuraMood } from './mood';
import { orbStateOf } from './SiriOrb';
import './aura.css';

export interface AuraOrbHandle { kick: (v?: number) => void }

/**
 * Aura's mark under its older name: the thin gradient ring (SiriOrb), sized to `size`, in the state the mood maps to. Without a `mood` it
 * follows the app's mood. `kick` gives the ring one soft pulse (opacity only).
 */
export const AuraOrb = forwardRef<AuraOrbHandle, { mood?: AuraMood; size?: number; className?: string; label?: string | null; testId?: string }>(
  function AuraOrb({ mood, size = 28, className, label, testId = 'aura-orb' }, ref) {
    const app = useAuraMood((s) => s.mood);
    const m = mood ?? app;
    const el = useRef<HTMLSpanElement>(null);
    useImperativeHandle(ref, () => ({
      kick: () => { const e = el.current; if (!e) return; e.classList.remove('kick'); void e.offsetWidth; e.classList.add('kick'); },
    }), []);
    return (
      <span ref={el} className={`aura-orb siri-orb${className ? ` ${className}` : ''}`} data-mood={m} data-state={orbStateOf(m)} data-testid={testId} style={{ width: size, height: size }}
        role={label === null ? undefined : 'img'} aria-hidden={label === null ? true : undefined} aria-label={label === null ? undefined : label ?? `Aura · ${AURA_MOODS[m].name}`}>
        <i />
      </span>
    );
  },
);

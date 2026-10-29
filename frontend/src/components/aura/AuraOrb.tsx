import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { AURA_MOODS, AURA_SPHERE, AuraRenderer, addOrb, removeOrb, type AuraMood } from './auraEngine';
import { useAuraMood } from './mood';
import './aura.css';

export interface AuraOrbHandle { kick: (v?: number) => void }

/**
 * Aura as a glowing orb. `size` is the sphere's box in the layout; the canvas (glow and rings) spills past it without taking space.
 * Without a `mood` it follows the app's mood (useAuraMood). DPR aware; drawn by the shared loop only while visible.
 */
export const AuraOrb = forwardRef<AuraOrbHandle, { mood?: AuraMood; size?: number; className?: string; label?: string | null; testId?: string }>(
  function AuraOrb({ mood, size = 28, className, label, testId = 'aura-orb' }, ref) {
    const app = useAuraMood((s) => s.mood);
    const m = mood ?? app;
    const cv = useRef<HTMLCanvasElement>(null);
    const r = useRef<AuraRenderer | null>(null);
    const px = Math.round(size / AURA_SPHERE);
    useEffect(() => {
      const c = cv.current; if (!c) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      c.width = Math.round(px * dpr); c.height = Math.round(px * dpr);
      const o = new AuraRenderer(c, m);
      r.current = o; addOrb(o);
      return () => { removeOrb(o); r.current = null; };
    }, [px]); // eslint-disable-line react-hooks/exhaustive-deps
    useEffect(() => { r.current?.set(m); }, [m]);
    useImperativeHandle(ref, () => ({ kick: (v = 1) => r.current?.kick(v) }), []);
    const name = AURA_MOODS[m].name;
    return (
      <span className={`aura-orb${className ? ` ${className}` : ''}`} data-mood={m} data-testid={testId} style={{ width: size, height: size }}
        role={label === null ? undefined : 'img'} aria-hidden={label === null ? true : undefined} aria-label={label === null ? undefined : label ?? `Aura · ${name}`}>
        <canvas ref={cv} aria-hidden="true" style={{ width: px, height: px }} />
      </span>
    );
  },
);

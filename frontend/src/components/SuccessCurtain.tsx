import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useCelebration, type Celebration, type CelebrationKind } from '../stores/celebrate';

/** When the page underneath is swapped (curtain fully closed), and how long the curtain then takes to lift. */
const TIMING: Record<CelebrationKind, { handoff: number; exit: number }> = {
  signin: { handoff: 2400, exit: 700 },
  verified: { handoff: 2400, exit: 700 },
  register: { handoff: 2900, exit: 700 },
};
const REDUCED_TIMING = { handoff: 1400, exit: 250 };
/** Ignore skip clicks/keys for this long, so the Enter or click that submitted the form can't skip straight past it. */
const SKIP_AFTER_MS = 800;

interface Step { label: string; next?: boolean }

function content(c: Celebration): { eyebrow: string; greet: string; sub: string; steps: Step[] } {
  const name = c.name ? `, ${c.name}` : '';
  switch (c.kind) {
    case 'register':
      return {
        eyebrow: 'Account created',
        greet: `Welcome aboard${name}`,
        sub: c.detail ? `We've sent a verification link to ${c.detail}` : "We've sent you a verification link",
        steps: [{ label: 'Account created' }, { label: 'Verification link sent' }, { label: 'Confirm your email to activate', next: true }],
      };
    case 'verified':
      return {
        eyebrow: 'Two-step verification passed',
        greet: `Welcome back${name}`,
        sub: c.detail ? `Opening ${c.detail}` : 'Opening your workspace',
        steps: [{ label: 'Code accepted' }, { label: 'Workspace loaded' }, { label: 'Dashboard ready' }],
      };
    default:
      return {
        eyebrow: 'Signed in securely',
        greet: `Welcome back${name}`,
        sub: c.detail ? `Opening ${c.detail}` : 'Opening your workspace',
        steps: [{ label: 'Identity verified' }, { label: 'Workspace loaded' }, { label: 'Dashboard ready' }],
      };
  }
}

/** Small deterministic PRNG so the particle layout is pure (same every render for a given celebration). */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CONFETTI = ['#a78bfa', '#f0abfc', '#34d399', '#fbbf24', '#60a5fa', '#fb7185', '#ffffff'];

function Particles({ kind, seed }: { kind: CelebrationKind; seed: number }) {
  const bits = useMemo(() => {
    const r = rng(seed * 7919 + 17);
    if (kind === 'register') {
      return Array.from({ length: 56 }, (_, i) => {
        const a = (i / 56) * Math.PI * 2 + (r() - 0.5) * 0.6;
        const d = 130 + r() * 190;
        return {
          style: {
            '--x': `${Math.cos(a) * d}px`, '--y': `${Math.sin(a) * d * 0.75 - 70}px`, '--r': `${(r() * 2 - 1) * 540}deg`,
            '--fall': `${220 + r() * 160}px`, width: `${5 + r() * 5}px`, height: `${8 + r() * 8}px`,
            background: CONFETTI[i % CONFETTI.length], borderRadius: i % 4 === 0 ? '50%' : '2px',
            '--pd': `${Math.round(r() * 140)}ms`, '--dur': `${1500 + Math.round(r() * 700)}ms`,
          } as CSSProperties,
        };
      });
    }
    return Array.from({ length: 26 }, (_, i) => ({
      style: {
        '--a': `${i * (360 / 26) + (r() - 0.5) * 9}deg`, '--d': `${100 + r() * 90}px`,
        width: `${10 + r() * 14}px`, '--pd': `${Math.round(r() * 90)}ms`,
      } as CSSProperties,
    }));
  }, [kind, seed]);
  return (
    <div className={`sc-burst ${kind === 'register' ? 'confetti' : 'sparks'}`} aria-hidden="true">
      {bits.map((b, i) => <i key={i} style={b.style} />)}
    </div>
  );
}

function Curtain({ c }: { c: Celebration }) {
  const reduced = useMemo(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches, []);
  const timing = reduced ? REDUCED_TIMING : TIMING[c.kind];
  const [leaving, setLeaving] = useState(false);
  const handedOff = useRef(false);
  const mountedAt = useRef(0);
  const { eyebrow, greet, sub, steps } = content(c);

  const handoff = useCallback(() => {
    if (handedOff.current) return;
    handedOff.current = true;
    c.onHandoff();
    setLeaving(true);
  }, [c]);

  useEffect(() => {
    mountedAt.current = performance.now();
    const t = window.setTimeout(handoff, timing.handoff);
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === 'Enter' || e.key === 'Escape' || e.key === ' ') && performance.now() - mountedAt.current > SKIP_AFTER_MS) handoff();
    };
    window.addEventListener('keydown', onKey);
    return () => { window.clearTimeout(t); window.removeEventListener('keydown', onKey); };
  }, [handoff, timing.handoff]);

  useEffect(() => {
    if (!leaving) return;
    const t = window.setTimeout(() => useCelebration.getState().finish(c.id), timing.exit);
    return () => window.clearTimeout(t);
  }, [leaving, c.id, timing.exit]);

  const onClick = () => { if (performance.now() - mountedAt.current > SKIP_AFTER_MS) handoff(); };

  // The greeting animates word by word; the name (everything after the comma) gets the gradient treatment.
  const [lead, who] = greet.includes(',') ? [greet.slice(0, greet.indexOf(',') + 1), greet.slice(greet.indexOf(',') + 1).trim()] : [greet, ''];
  const words = [...lead.split(' ').map((w) => ({ w, name: false })), ...(who ? [{ w: who, name: true }] : [])];

  const style = {
    '--ox': `${c.origin?.x ?? window.innerWidth / 2}px`,
    '--oy': `${c.origin?.y ?? window.innerHeight / 2}px`,
    '--sc-fill': `${timing.handoff - 450}ms`,
  } as CSSProperties;

  return (
    <div className={`sc sc-${c.kind} ${leaving ? 'out' : ''}`} style={style} role="status" aria-live="polite" onClick={onClick}>
      <div className="sc-bg" aria-hidden="true">
        <span className="sc-aurora sc-aurora-1" />
        <span className="sc-aurora sc-aurora-2" />
        <span className="sc-stars" />
        <span className="sc-floor" />
      </div>

      <div className="sc-stage">
        <div className="sc-emblem" aria-hidden="true">
          <span className="sc-flash" />
          <span className="sc-halo" />
          <span className="sc-wave" /><span className="sc-wave sc-wave-2" /><span className="sc-wave sc-wave-3" />
          <svg className="sc-ring" viewBox="0 0 140 140">
            <defs>
              <linearGradient id="sc-ring-grad" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stopColor="#f0abfc" />
                <stop offset=".5" stopColor="#a78bfa" />
                <stop offset="1" stopColor="#60a5fa" />
              </linearGradient>
            </defs>
            <circle className="sc-ring-track" cx="70" cy="70" r="64" />
            <circle className="sc-ring-fill" cx="70" cy="70" r="64" pathLength={100} />
          </svg>
          <span className="sc-orbit"><i /></span>
          <span className="sc-orbit sc-orbit-2"><i /></span>
          <div className="sc-core">
            <svg viewBox="0 0 24 24" fill="none">
              <path d="M5 12.5l4.5 4.5L19 7.5" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" pathLength={1} />
            </svg>
          </div>
          {!reduced && <Particles kind={c.kind} seed={c.id} />}
        </div>

        <div className="sc-eyebrow"><span className="sc-eyebrow-dot" />{eyebrow}</div>
        <h2 className="sc-title">
          {words.map((x, i) => (
            <span key={i} className={`sc-word ${x.name ? 'sc-name' : ''}`} style={{ '--i': i } as CSSProperties}>{x.w}</span>
          ))}
        </h2>
        <p className="sc-sub">
          {sub}
          {c.kind !== 'register' && <span className="sc-ellipsis" aria-hidden="true"><i>.</i><i>.</i><i>.</i></span>}
        </p>

        <div className="sc-panel">
          <ol className="sc-steps">
            {steps.map((s, i) => (
              <li key={s.label} className={s.next ? 'next' : ''} style={{ '--i': i } as CSSProperties}>
                <span className="sc-step-icon">
                  <span className="sc-step-spin" />
                  <svg className="sc-step-check" viewBox="0 0 24 24" fill="none">
                    {s.next
                      ? <path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
                      : <path d="M5 12.5l4.5 4.5L19 7.5" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" />}
                  </svg>
                </span>
                {s.label}
              </li>
            ))}
          </ol>
          <span className="sc-progress" aria-hidden="true"><i /></span>
        </div>
      </div>
    </div>
  );
}

/** Mounted once at the app root; shows the current celebration, if any. */
export function SuccessCurtain() {
  const current = useCelebration((s) => s.current);
  if (!current) return null;
  return <Curtain key={current.id} c={current} />;
}

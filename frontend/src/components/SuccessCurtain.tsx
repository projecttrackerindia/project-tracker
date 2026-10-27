import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { queryClient } from '../stores/auth';
import { useCelebration, type Celebration } from '../stores/celebrate';

/** Never shorter than this, so a fast load doesn't flash the screen. */
const MIN_SHOW_MS = 600;
/** The page underneath is swapped this soon after the screen appears (it is fully opaque by then). */
const HANDOFF_MS = 220;
/** Give up waiting on the app and reveal it anyway. */
const MAX_WAIT_MS = 6000;
/** A new account has nothing to load: leave the message up long enough to read. */
const REGISTER_SHOW_MS = 2200;
const EXIT_MS = 420;
/** Shortest gap between two steps ticking, so they read as a sequence. */
const STEP_GAP_MS = 180;
/** No queries in flight for this long counts as settled. */
const SETTLE_MS = 120;
const REDUCED_EXIT_MS = 200;
/** Ignore skip clicks/keys for this long, so the Enter or click that submitted the form can't skip straight past it. */
const SKIP_AFTER_MS = 800;

interface Step { label: string; status: string; next?: boolean }

/** "NORTHWIND BUSINESS FINANCE LTD" -> "Northwind Business Finance Ltd"; names already in mixed case are left alone. */
export function normalCase(name: string): string {
  if (name !== name.toUpperCase() || name === name.toLowerCase()) return name;
  return name.toLowerCase().replace(/(^|[\s\-/(&])(\p{L})/gu, (_m, sep: string, ch: string) => sep + ch.toUpperCase());
}

function content(c: Celebration): { greet: string; sub: string; note?: string; steps: Step[] } {
  const name = c.name ? `, ${c.name}` : '';
  switch (c.kind) {
    case 'register':
      return {
        greet: `Welcome aboard${name}.`,
        sub: c.detail ? `We've sent a verification link to ${c.detail}` : "We've sent you a verification link",
        steps: [
          { label: 'Account', status: 'Account created' },
          { label: 'Link sent', status: 'Verification link sent' },
          { label: 'Confirm email', status: 'Confirm your email to activate', next: true },
        ],
      };
    default:
      return {
        greet: `Welcome back${name}.`,
        sub: c.detail ? `Opening ${normalCase(c.detail)}` : 'Opening your workspace',
        note: c.kind === 'verified' ? 'Two-step verification passed' : undefined,
        steps: [
          { label: 'Signed in', status: c.kind === 'verified' ? 'Signed in with two-step verification' : 'Signed in securely' },
          { label: 'Workspace', status: 'Workspace loaded' },
          { label: 'Today', status: 'Today is ready' },
        ],
      };
  }
}

/** Celebrations whose hand-off has already happened: a screen that is rebuilt for any reason must never navigate or play a second time. */
const handedOffIds = new Set<number>();

/** Calls `test` every frame until it is true (or `cancelled()`), then `done`. */
function waitFor(test: () => boolean, done: () => void, cancelled: () => boolean) {
  const tick = () => { if (cancelled()) return; if (test()) done(); else requestAnimationFrame(tick); };
  tick();
}

function Curtain({ c }: { c: Celebration }) {
  const reduced = useMemo(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches, []);
  const exitMs = reduced ? REDUCED_EXIT_MS : EXIT_MS;
  const again = handedOffIds.has(c.id);
  const [leaving, setLeaving] = useState(again);
  // How many steps are done: the first (signed in / account created) is true by the time this screen exists.
  const [done, setDone] = useState(1);
  const handedOff = useRef(again);
  const mountedAt = useRef(0);
  const { greet, sub, note, steps } = content(c);

  const handoff = useCallback(() => {
    if (handedOff.current) return;
    handedOff.current = true;
    handedOffIds.add(c.id);
    c.onHandoff();
  }, [c]);

  const finish = useCallback(() => { handoff(); setLeaving(true); }, [handoff]);

  useEffect(() => {
    mountedAt.current = performance.now();
    let off = false;
    const cancelled = () => off;
    const timers: number[] = [];
    const later = (fn: () => void, ms: number) => timers.push(window.setTimeout(fn, ms));
    const afterMin = (fn: () => void) => later(fn, Math.max(0, MIN_SHOW_MS - (performance.now() - mountedAt.current)));

    later(handoff, HANDOFF_MS);
    if (c.kind === 'register') {
      later(() => setDone(2), HANDOFF_MS + 120);
      later(finish, REGISTER_SHOW_MS);
    } else {
      // Bound to the real app: Workspace once the shell is up (the workspace context has loaded), Today once the page's
      // queries have started and settled. Each tick is at least STEP_GAP_MS after the last so the sequence reads.
      let lastTick = performance.now();
      const tick = (n: number, then?: () => void) => {
        later(() => { lastTick = performance.now(); setDone(n); then?.(); }, Math.max(0, STEP_GAP_MS - (performance.now() - lastTick)));
      };
      let quietSince = 0;
      const settled = () => {
        if (!document.querySelector('.main .content > *') || queryClient.isFetching() > 0) { quietSince = 0; return false; }
        quietSince ||= performance.now();
        return performance.now() - quietSince >= SETTLE_MS;
      };
      later(() => {
        waitFor(() => !!document.querySelector('.v2-shell, .m-main, .main'), () => tick(2, () => {
          waitFor(settled, () => tick(3, () => afterMin(() => later(finish, reduced ? 0 : 240))), cancelled);
        }), cancelled);
      }, HANDOFF_MS);
      later(finish, MAX_WAIT_MS);
    }

    const onKey = (e: KeyboardEvent) => {
      if ((e.key === 'Enter' || e.key === 'Escape' || e.key === ' ') && performance.now() - mountedAt.current > SKIP_AFTER_MS) finish();
    };
    window.addEventListener('keydown', onKey);
    return () => { off = true; timers.forEach((t) => window.clearTimeout(t)); window.removeEventListener('keydown', onKey); };
  }, [c.kind, handoff, finish, reduced]);

  useEffect(() => {
    if (!leaving) return;
    // The app shell plays its entrance (rail slides in, Today fades up) underneath the fade-out.
    const root = document.documentElement;
    if (!reduced && c.kind !== 'register') root.classList.add('sc-reveal');
    const t = window.setTimeout(() => useCelebration.getState().finish(c.id), exitMs);
    const t2 = window.setTimeout(() => root.classList.remove('sc-reveal'), exitMs + 500);
    return () => { window.clearTimeout(t); window.clearTimeout(t2); };
  }, [leaving, c.id, c.kind, exitMs, reduced]);

  const onClick = () => { if (performance.now() - mountedAt.current > SKIP_AFTER_MS) finish(); };
  const current = steps[Math.min(done, steps.length) - 1];

  return (
    <div className={`sc sc-${c.kind}${leaving ? ' out' : ''}`} onClick={onClick} data-step={done}>
      <div className="sc-stage">
        <div className="sc-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none"><path d="M6 12.5l4 4L18 8" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </div>
        <h2 className="sc-title">{greet}</h2>
        <p className="sc-sub">{sub}</p>
        {note && <p className="sc-note"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5l5 2v4c0 3.2-2.1 5.6-5 7-2.9-1.4-5-3.8-5-7v-4z" fill="currentColor" /></svg>{note}</p>}
        <ol className="sc-steps" aria-hidden="true">
          {steps.map((s, i) => (
            <li key={s.label} className={`${i < done ? 'done' : ''}${i === done ? ' now' : ''}${s.next ? ' next' : ''}`}>
              <span className="sc-dot">
                <svg viewBox="0 0 20 20" fill="none">
                  {s.next
                    ? <path d="M6 10h8M11 6.5l3.5 3.5-3.5 3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                    : <path d="M5.8 10.4l2.8 2.8 5.6-6" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" pathLength={1} />}
                </svg>
              </span>
              {s.label}
            </li>
          ))}
        </ol>
        <p className="sc-live" role="status" aria-live="polite">{current.status}</p>
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

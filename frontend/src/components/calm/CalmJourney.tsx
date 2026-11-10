import { isValidElement, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import './calm-kit.css';

export type CalmStepState = 'done' | 'current' | 'next';
export type CalmStep = {
  key: string;
  label: string;
  state: CalmStepState;
  /** A quiet line under the label (a date, "Awaiting sign-off"). */
  sub?: ReactNode;
  /** A small mark before the sub line (e.g. the signer's photo). */
  badge?: ReactNode;
  /** Anything after the labels (a visually hidden action button). */
  extra?: ReactNode;
  ariaLabel?: string;
  /** Extra classes for the step and for its dot (pages keep their own hooks). */
  className?: string;
  dotClassName?: string;
  data?: Record<`data-${string}`, string>;
};

/** Where step i's dot sits across the journey, in percent (the steps are equal columns). */
export const calmStepPos = (i: number, n: number) => (n > 0 ? ((i + 0.5) / n) * 100 : 50);

const textOf = (n: ReactNode): string => typeof n === 'string' || typeof n === 'number' ? String(n) : Array.isArray(n) ? n.map(textOf).join('')
  : isValidElement(n) ? textOf((n.props as { children?: ReactNode }).children) : '';
/**
 * The narrowest column that keeps every word whole: wide enough for the longest word of any label, for the line under it (owner · date,
 * never wrapped) and for a short label on one line. Longer labels wrap between words onto a second line, never inside a word.
 */
export const calmStepWidth = (steps: Pick<CalmStep, 'label' | 'sub' | 'state'>[]) =>
  Math.ceil(Math.max(96, ...steps.map((s) => {
    const cw = s.state === 'current' ? 8.2 : 7.6;
    const word = Math.max(0, ...s.label.split(/\s+/).map((w) => w.length)) * cw;
    return Math.max(word, Math.min(s.label.length * cw, 112), textOf(s.sub).length * 6.2) + 28;
  })));

/**
 * The journey: dots on one thin line. Done steps are filled in the project colour and the line is drawn up to the current step, which is
 * larger and haloed; later steps are hollow. Labels and the line under them (owner · date) stay on one line each and never break inside a
 * word: every column is as wide as the longest label needs. When the steps do not fit, the bar scrolls sideways with the current step
 * centred and the edges fading out.
 */
export function CalmJourney({ steps, color, className = '', scrollClassName = '', label = 'Journey', after }: {
  steps: CalmStep[]; color?: string | null; className?: string; scrollClassName?: string; label?: string; after?: ReactNode;
}) {
  const n = steps.length;
  const cur = steps.findIndex((s) => s.state === 'current');
  const lastDone = steps.reduce((k, s, i) => (s.state === 'done' ? i : k), -1);
  const reach = cur >= 0 ? cur : lastDone;
  const col = calmStepWidth(steps);
  const box = useRef<HTMLDivElement>(null);
  const [fade, setFade] = useState({ l: false, r: false });
  const edges = () => {
    const el = box.current; if (!el) return;
    const l = el.scrollLeft > 2, r = el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
    setFade((f) => (f.l === l && f.r === r ? f : { l, r }));
  };
  // Centre the current step (or the last done one) whenever the steps change or the bar is resized.
  useLayoutEffect(() => {
    const el = box.current; if (!el || reach < 0) { edges(); return; }
    const centre = () => {
      const target = (reach + 0.5) * (el.scrollWidth / Math.max(1, n)) - el.clientWidth / 2;
      el.scrollTo({ left: Math.max(0, Math.min(target, el.scrollWidth - el.clientWidth)), behavior: 'instant' as ScrollBehavior });
      edges();
    };
    centre();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(centre) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reach, n, col]);
  useEffect(() => { edges(); });
  const style = { '--n': Math.max(1, n), '--calm-step-w': `${col}px`, ...(color ? { '--calm-journey-c': color } : {}) } as CSSProperties;
  return (
    <div ref={box} onScroll={edges} className={`calm-journey ${fade.l ? 'fade-l' : ''} ${fade.r ? 'fade-r' : ''} ${scrollClassName}`.replace(/\s+/g, ' ').trim()} style={style} data-testid="calm-journey">
      <div className="calm-journey-in">
      <span className="calm-journey-rail" aria-hidden="true" />
      <span className="calm-journey-done" aria-hidden="true" style={{ width: reach > 0 ? `${(reach / n) * 100}%` : 0 }} />
      <ol className={className || undefined} aria-label={label}>
        {steps.map((s) => (
          <li key={s.key} className={`calm-step ${s.state === 'next' ? '' : s.state} ${s.className ?? ''}`.replace(/\s+/g, ' ').trim()}
            aria-current={s.state === 'current' ? 'step' : undefined} aria-label={s.ariaLabel} {...s.data}>
            <span className={`calm-step-dot ${s.dotClassName ?? ''}`.trim()} aria-hidden="true" />
            <b className="calm-step-label">{s.label}</b>
            {(s.sub != null || s.badge) && <small className="calm-step-sub">{s.badge && <span className="calm-step-av">{s.badge}</span>}{s.sub}</small>}
            {s.extra}
          </li>
        ))}
      </ol>
      </div>
      {after}
    </div>
  );
}

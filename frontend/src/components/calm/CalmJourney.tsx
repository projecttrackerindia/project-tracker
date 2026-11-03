import type { CSSProperties, ReactNode } from 'react';
import './calm-kit.css';

export type CalmStepState = 'done' | 'current' | 'next';
export type CalmStep = {
  key: string;
  label: string;
  state: CalmStepState;
  /** A quiet line under the label (a date, "Awaiting sign-off"). */
  sub?: ReactNode;
  /** Put inside the dot (e.g. the signer's photo); positioned at its lower right. */
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

/**
 * The journey: dots on one thin line. Done steps are filled in the project colour and the line is drawn up to the current step, which is
 * larger and haloed; later steps are hollow. Labels wrap onto two lines (never truncated to one), so long stage names read in full.
 * Scrolls sideways when there are more steps than fit (84px each at least).
 */
export function CalmJourney({ steps, color, className = '', scrollClassName = '', label = 'Journey', after }: {
  steps: CalmStep[]; color?: string | null; className?: string; scrollClassName?: string; label?: string; after?: ReactNode;
}) {
  const n = steps.length;
  const cur = steps.findIndex((s) => s.state === 'current');
  const lastDone = steps.reduce((k, s, i) => (s.state === 'done' ? i : k), -1);
  const reach = cur >= 0 ? cur : lastDone;
  const style = { '--n': Math.max(1, n), ...(color ? { '--calm-journey-c': color } : {}) } as CSSProperties;
  return (
    <div className={`calm-journey ${scrollClassName}`.trim()} style={style}>
      <div className="calm-journey-in">
      <span className="calm-journey-rail" aria-hidden="true" />
      <span className="calm-journey-done" aria-hidden="true" style={{ width: reach > 0 ? `${(reach / n) * 100}%` : 0 }} />
      <ol className={className || undefined} aria-label={label}>
        {steps.map((s) => (
          <li key={s.key} className={`calm-step ${s.state === 'next' ? '' : s.state} ${s.className ?? ''}`.replace(/\s+/g, ' ').trim()}
            aria-current={s.state === 'current' ? 'step' : undefined} aria-label={s.ariaLabel} {...s.data}>
            <span className={`calm-step-dot ${s.dotClassName ?? ''}`.trim()} aria-hidden="true">{s.badge && <span className="calm-step-av">{s.badge}</span>}</span>
            <b className="calm-step-label">{s.label}</b>
            {s.sub != null && <small className="calm-step-sub">{s.sub}</small>}
            {s.extra}
          </li>
        ))}
      </ol>
      </div>
      {after}
    </div>
  );
}

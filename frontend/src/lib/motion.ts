import type { Transition, Variants } from 'framer-motion';

/**
 * The app's one motion system. Every animated piece takes its timing from here (JS) or from the matching CSS variables in
 * styles/tokens.css (--motion-*, --ease-*). Motion is calm, quick and purposeful: transform and opacity only, no overshoot, no large
 * travel, nothing on data refresh. Everything steps aside for prefers-reduced-motion (MotionConfig reducedMotion="user" in the layout,
 * plus the global media query in styles/base.css).
 */

/** Durations in milliseconds. UI motion never runs longer than `sheet`. */
export const durationMs = { micro: 120, standard: 200, emphasised: 280, sheet: 340 } as const;
/** The same durations in seconds, for framer-motion. */
export const duration = {
  micro: durationMs.micro / 1000,
  standard: durationMs.standard / 1000,
  emphasised: durationMs.emphasised / 1000,
  sheet: durationMs.sheet / 1000,
} as const;

type Bezier = [number, number, number, number];
/** Easings: standard for things that move on screen, decelerate for things that enter, accelerate for things that leave. */
export const ease: { standard: Bezier; decelerate: Bezier; accelerate: Bezier } = {
  standard: [0.2, 0, 0, 1],
  decelerate: [0, 0, 0, 1],
  accelerate: [0.3, 0, 1, 1],
};
export const cssEase = (b: Bezier) => `cubic-bezier(${b.join(', ')})`;

/** The one spring: critically damped enough that it never visibly overshoots (damping ratio about 0.93). */
export const gentleSpring = { type: 'spring', stiffness: 420, damping: 38, mass: 1 } as const satisfies Transition;
/** No motion (reduced motion, or a value that should simply be there). */
export const instant: Transition = { duration: 0 };

export const t = {
  micro: { duration: duration.micro, ease: ease.standard } as Transition,
  standard: { duration: duration.standard, ease: ease.standard } as Transition,
  enter: { duration: duration.standard, ease: ease.decelerate } as Transition,
  exit: { duration: duration.micro, ease: ease.accelerate } as Transition,
  emphasised: { duration: duration.emphasised, ease: ease.decelerate } as Transition,
  sheet: { duration: duration.sheet, ease: ease.decelerate } as Transition,
  sheetExit: { duration: duration.standard, ease: ease.accelerate } as Transition,
  spring: gentleSpring as Transition,
};

/** List stagger: at most 30ms between items, and only the first few items stagger at all. */
export const STAGGER_S = 0.03;
export const STAGGER_CAP = 6;
export const staggerDelay = (i: number) => Math.min(Math.max(0, i), STAGGER_CAP - 1) * STAGGER_S;

/** Presets: spread into a motion element (`<motion.div {...presets.fadeScale} />`). */
export const presets = {
  fade: { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0, transition: t.exit }, transition: t.enter },
  fadeScale: { initial: { opacity: 0, scale: 0.98 }, animate: { opacity: 1, scale: 1 }, exit: { opacity: 0, scale: 0.98, transition: t.exit }, transition: t.enter },
  slideUp: { initial: { opacity: 0, y: 8 }, animate: { opacity: 1, y: 0 }, exit: { opacity: 0, y: 8, transition: t.exit }, transition: t.enter },
  sheet: { initial: { opacity: 0, y: 24 }, animate: { opacity: 1, y: 0 }, exit: { opacity: 0, y: 24, transition: t.sheetExit }, transition: t.sheet },
  /** A side panel: a short horizontal slide (never more than 24px). */
  panel: { initial: { opacity: 0, x: 24 }, animate: { opacity: 1, x: 0 }, exit: { opacity: 0, x: 24, transition: t.sheetExit }, transition: t.sheet },
} as const;
/** Shared-layout transitions (layout / layoutId): the gentle spring. */
export const sharedLayout: Transition = gentleSpring;

// ------------------------------------------------------------------ names kept for existing call sites
/** @deprecated use `t.spring`; every legacy spring is now the one gentle spring. */
export const spring = { snappy: gentleSpring as Transition, panel: gentleSpring as Transition, gentle: gentleSpring as Transition };
export const reveal: Transition = t.enter;
export const listStagger = STAGGER_S;

/** A list whose first few children stagger in (later ones arrive together with the sixth). */
export const listVariants: Variants = { hidden: {}, show: {} };
/** One list item: fades up 8px in; fades out (siblings close the gap through `layout`, no height animation). Pass the index as `custom`. */
export const itemVariants: Variants = {
  hidden: { opacity: 0, y: 8 },
  show: (i: number = 0) => ({ opacity: 1, y: 0, transition: { ...t.enter, delay: staggerDelay(i) } }),
  exit: { opacity: 0, transition: t.exit },
};
/** Page content on a route change. */
// Opacity only: a transform on the page wrapper would become the containing block for every position:fixed panel, sheet and composer inside it.
export const pageVariants: Variants = { hidden: { opacity: 0 }, show: { opacity: 1, transition: t.enter } };

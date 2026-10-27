import type { Transition, Variants } from 'framer-motion';

/**
 * The app's motion tokens. Every animated piece takes its timing from here, and every one of them steps aside for prefers-reduced-motion
 * (via useReducedMotion / MotionConfig reducedMotion="user" in the layout).
 */
export const spring = {
  snappy: { type: 'spring', stiffness: 420, damping: 34 } as Transition,
  panel: { type: 'spring', stiffness: 300, damping: 32 } as Transition,
  gentle: { type: 'spring', stiffness: 180, damping: 26 } as Transition,
};
export const reveal: Transition = { duration: 0.28, ease: [0.2, 0.8, 0.2, 1] };
export const listStagger = 0.03;

/** A list whose children stagger in. */
export const listVariants: Variants = { hidden: {}, show: { transition: { staggerChildren: listStagger } } };
/** One list item: fades up in, collapses out. */
export const itemVariants: Variants = {
  hidden: { opacity: 0, y: 6 },
  show: { opacity: 1, y: 0, transition: reveal },
  exit: { opacity: 0, height: 0, minHeight: 0, marginTop: 0, marginBottom: 0, paddingTop: 0, paddingBottom: 0, transition: { duration: 0.22, ease: [0.2, 0.8, 0.2, 1] } },
};
/** Page content on a route change. */
export const pageVariants: Variants = { hidden: { opacity: 0, y: 8 }, show: { opacity: 1, y: 0, transition: reveal } };

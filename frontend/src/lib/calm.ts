/**
 * The calm theme's tokens, for code that needs a value in JS (charts, canvas, inline styles). The CSS side is styles/calm.css (--calm-*),
 * which also maps the older --ds-* and app tokens onto these values, so existing components follow the theme without changes.
 * Motion is not repeated here: it is the one system in ./motion (re-exported below for convenience).
 */
export { duration, durationMs, ease, cssEase, gentleSpring, presets, t as transitions, staggerDelay } from './motion';

export type CalmMode = 'light' | 'dark';

/** Colours: one page tone with an ambient glow, frosted card surfaces without borders, three ink levels and one accent. */
export const calmColors = {
  light: {
    bg: '#f6f5f8', card: 'rgba(255,255,255,.78)', solid: '#ffffff', ink: '#1d1d1f', ink2: '#6e6e73', ink3: '#a1a1a6', fill: 'rgba(0,0,0,.05)',
    accent: '#0a84ff', accentText: '#0068d6', green: '#30b158', orange: '#e8890c', red: '#ff3b30',
  },
  dark: {
    bg: '#0d0d10', card: 'rgba(30,30,36,.72)', solid: '#1c1c21', ink: '#f5f5f7', ink2: '#9a9aa2', ink3: '#5f5f68', fill: 'rgba(255,255,255,.07)',
    accent: '#3a9bff', accentText: '#3a9bff', green: '#32d74b', orange: '#ff9f0a', red: '#ff453a',
  },
} as const;

/** Soft depth instead of lines. */
export const calmShadow = {
  light: '0 1px 2px rgba(0,0,0,.03), 0 12px 40px rgba(40,30,80,.08)',
  dark: '0 0 0 .5px rgba(255,255,255,.06), 0 16px 50px rgba(0,0,0,.45)',
  sheet: '0 30px 80px rgba(0,0,0,.18)',
} as const;

/** Project colours: only ever a dot or a ribbon, never a fill behind text. */
export const projectColors = ['#3b82f6', '#14b8a6', '#8b5cf6', '#f59e0b', '#f43f5e', '#22c55e', '#0ea5e9', '#ec4899'] as const;

/** A stable project colour for a key or id (the same project is always the same dot). */
export function projectColor(seed: string | null | undefined, explicit?: string | null): string {
  if (explicit) return explicit;
  let h = 0;
  for (const c of seed ?? '') h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return projectColors[h % projectColors.length];
}

/** Type scale (px). Display is the large light greeting ("Good afternoon, Ravi"); phone sizes in `phone`. */
export const calmType = {
  display: { size: 54, weight: 300, tracking: '-.035em', lineHeight: 1.08 },
  title: { size: 32, weight: 600, tracking: '-.025em', lineHeight: 1.18 },
  sheetTitle: { size: 24, weight: 600, tracking: '-.02em', lineHeight: 1.2 },
  body: { size: 15, weight: 400, lineHeight: 1.5 },
  row: { size: 14.5, weight: 400, lineHeight: 1.4 },
  label: { size: 12.5, weight: 500, lineHeight: 1.3 },
  phone: { display: 34, title: 23 },
} as const;

export const calmSpace = { 1: 4, 2: 8, 3: 12, 4: 16, 5: 22, 6: 28, 7: 40 } as const;
export const calmRadius = { row: 14, tile: 18, card: 22, pane: 24, hero: 28, pill: 999 } as const;

/** Pastel ribbon segment colours (today2.html): meeting, focus, light work, review, admin; past segments at 35% opacity. */
export const ribbonColors = { meet: '#14b8a6', focus: '#a78bfa', light: '#86d19a', review: '#fb7185', admin: '#fbbf24', pastOpacity: 0.35, now: '#ff3b30' } as const;

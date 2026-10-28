import { useLayoutEffect } from 'react';

export interface ScrollMotionOptions {
  /** Readers' view (the editor does not animate while text is being written; the Style panel's preview turns this on). */
  enabled: boolean;
  /** Page option: every top-level block without its own motion rises in. */
  animateSections: boolean;
  /** Page option: a transition marking each new section (h2). */
  transition: 'none' | 'line' | 'fade';
  /** The reader stopped motion on this page. */
  paused: boolean;
  /** Changes when the text is replaced (re-arm). */
  version?: unknown;
}

export const prefersReducedMotion = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/**
 * Blocks with motion (and, with "Animate sections on scroll", every top-level block) come in as they scroll into view. Only opacity and
 * transform animate (CSS transitions in motion.css); this adds `mo-in` when a block is first seen. Nothing is hidden unless the page is
 * armed, and it is never armed with prefers-reduced-motion, when paused, or for printing (print CSS shows everything as it is).
 */
export function useScrollMotion(root: HTMLElement | null, o: ScrollMotionOptions) {
  // Before paint, so a block that will rise in is not first shown in place for a frame.
  useLayoutEffect(() => {
    if (!root) return;
    const pm = root.querySelector<HTMLElement>('.ProseMirror');
    const off = () => { root.classList.remove('mo-armed', 'mo-t-line', 'mo-t-fade'); };
    if (!pm || !o.enabled || o.paused || prefersReducedMotion() || typeof IntersectionObserver === 'undefined') { off(); return; }
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) { e.target.classList.add('mo-in'); io.unobserve(e.target); }
    }, { threshold: 0.12, rootMargin: '0px 0px -6% 0px' });
    const arm = () => {
      for (const el of Array.from(pm.children) as HTMLElement[]) {
        const own = el.getAttribute('data-motion');
        if (o.animateSections && !own) el.classList.add('mo-auto');
        if (o.transition !== 'none' && el.tagName === 'H2') el.classList.add('mo-sec');
      }
      pm.querySelectorAll('[data-motion], .mo-auto, .mo-sec').forEach((el) => { if (!el.classList.contains('mo-in')) io.observe(el); });
    };
    arm();
    root.classList.add('mo-armed');
    if (o.transition !== 'none') root.classList.add(`mo-t-${o.transition}`);
    const mo = new MutationObserver(arm);
    mo.observe(pm, { childList: true });
    return () => {
      io.disconnect(); mo.disconnect(); off();
      pm.querySelectorAll('.mo-in, .mo-auto, .mo-sec').forEach((el) => el.classList.remove('mo-in', 'mo-auto', 'mo-sec'));
    };
  }, [root, o.enabled, o.animateSections, o.transition, o.paused, o.version]);
}

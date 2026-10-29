import { useEffect, type RefObject } from 'react';

/** Size the complete phone conversation to the visible viewport, including Safari's keyboard pan. */
export function useConversationViewport(enabled: boolean, shell: RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const element = shell.current;
    if (!enabled || !element) return;
    const viewport = window.visualViewport;
    let baseline = viewport?.height ?? window.innerHeight;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const editing = document.activeElement?.matches('input,textarea,[contenteditable="true"]') ?? false;
        const height = viewport?.height ?? window.innerHeight;
        if (!editing) baseline = height;
        element.style.setProperty('--conversation-viewport-height', `${height}px`);
        element.style.setProperty('--conversation-offset-top', `${viewport?.offsetTop ?? 0}px`);
        element.classList.toggle('keyboard-open', editing && Math.max(baseline, window.innerHeight) - height > 120);
      });
    };
    // The page itself never scrolls under a conversation: iOS would otherwise scroll <body> to "reveal" the focused box and leave
    // the composer floating in the middle of the screen.
    document.documentElement.classList.add('conv-lock');
    const unscroll = () => { if (window.scrollY || window.scrollX || document.documentElement.scrollTop || document.documentElement.scrollLeft) window.scrollTo(0, 0); };
    window.addEventListener('scroll', unscroll, { passive: true });
    const orient = () => { baseline = window.innerHeight; update(); };
    update();
    viewport?.addEventListener('resize', update); viewport?.addEventListener('scroll', update);
    window.addEventListener('resize', update); window.addEventListener('orientationchange', orient);
    document.addEventListener('focusin', update); document.addEventListener('focusout', update);
    return () => {
      cancelAnimationFrame(frame);
      document.documentElement.classList.remove('conv-lock'); window.removeEventListener('scroll', unscroll);
      viewport?.removeEventListener('resize', update); viewport?.removeEventListener('scroll', update);
      window.removeEventListener('resize', update); window.removeEventListener('orientationchange', orient);
      document.removeEventListener('focusin', update); document.removeEventListener('focusout', update);
      element.style.removeProperty('--conversation-viewport-height'); element.style.removeProperty('--conversation-offset-top'); element.classList.remove('keyboard-open');
    };
  }, [enabled, shell]);
}

import { useEffect, useRef } from 'react';
import { queryClient } from '../stores/auth';
import { haptic } from '../lib/mobile';
import { Icon } from './Icon';

const TRIGGER = 64;

/** Pull the page down from the top to refresh what is on screen, as in any phone app. Only reacts to a touch that starts at the very top. */
export function PullToRefresh() {
  const el = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let y0 = 0, pull = 0, active = false, busy = false;
    const ind = () => el.current;
    const show = (px: number) => {
      const e = ind(); if (!e) return;
      e.style.opacity = String(Math.min(1, px / 40));
      e.style.transform = `translate(-50%, ${px - 46}px)`;
      (e.firstElementChild as HTMLElement).style.transform = `rotate(${px * 5}deg)`;
    };
    const reset = () => { const e = ind(); if (!e) return; e.style.transition = 'transform .25s, opacity .25s'; e.style.opacity = '0'; e.style.transform = 'translate(-50%, -46px)'; setTimeout(() => { if (e) e.style.transition = ''; }, 260); };

    const start = (e: TouchEvent) => {
      if (busy || e.touches.length !== 1 || window.scrollY > 0) return;
      const el0 = e.target instanceof Element ? e.target : null;
      if (el0?.closest('.modal-overlay,.sheet-overlay,.cmdk-overlay,.ai-chat,.chat-thread,input,textarea,select')) return;   // a sheet, the search or a text field owns its own touches
      y0 = e.touches[0].clientY; pull = 0; active = true;
    };
    const moveTouch = (e: TouchEvent) => {
      if (!active) return;
      const dy = e.touches[0].clientY - y0;
      if (dy <= 0 || window.scrollY > 0) { if (pull > 0) reset(); active = false; pull = 0; return; }
      e.preventDefault();
      const next = Math.min(dy * 0.5, 96);
      if (pull < TRIGGER && next >= TRIGGER) haptic(10);   // the tick that says "let go now"
      pull = next; show(pull);
    };
    const end = async () => {
      if (!active) return; active = false;
      if (pull >= TRIGGER) {
        busy = true;
        const e = ind(); if (e) { e.classList.add('spin'); e.style.transform = 'translate(-50%, 18px)'; e.style.opacity = '1'; }
        await Promise.race([queryClient.invalidateQueries(), new Promise((r) => setTimeout(r, 4000))]).catch(() => undefined);
        await new Promise((r) => setTimeout(r, 250));
        e?.classList.remove('spin'); busy = false;
      }
      pull = 0; reset();
    };
    document.addEventListener('touchstart', start, { passive: true });
    document.addEventListener('touchmove', moveTouch, { passive: false });
    document.addEventListener('touchend', end);
    document.addEventListener('touchcancel', end);
    return () => { document.removeEventListener('touchstart', start); document.removeEventListener('touchmove', moveTouch); document.removeEventListener('touchend', end); document.removeEventListener('touchcancel', end); };
  }, []);

  return <div ref={el} className="ptr" aria-hidden="true"><span><Icon name="refresh" size={18} /></span></div>;
}

/**
 * Phone keyboards, app-wide. iOS Safari does not shrink the layout viewport when the on-screen keyboard opens; only the *visual*
 * viewport shrinks (and pans by offsetTop). So everything that must sit on the keyboard reads these CSS variables on <html>:
 *   --vvh   the visible height (visualViewport.height)
 *   --vvtop the visual viewport's pan from the top (visualViewport.offsetTop)
 *   --kb    how much of the layout viewport the keyboard covers (0 when closed)
 * and the class `kb-open` is set while an editable field is focused and the keyboard is up (the tab bar and the Ask bar hide then),
 * plus `composing` while the focus is in a message composer. Android Chrome with interactive-widget=resizes-content resizes the
 * layout viewport instead, which gives --kb = 0 and the same --vvh, so one set of rules works for both.
 */
const EDITABLE = 'input:not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]):not([type="range"]):not([type="file"]),textarea,select,[contenteditable="true"],[contenteditable=""]';

export function installKeyboardViewport() {
  if (typeof window === 'undefined') return;
  const root = document.documentElement;
  const vv = window.visualViewport;
  let baseline = Math.max(window.innerHeight, vv?.height ?? 0);
  let frame = 0;
  const apply = () => {
    const h = vv?.height ?? window.innerHeight;
    const top = vv?.offsetTop ?? 0;
    const active = document.activeElement as HTMLElement | null;
    const editing = !!active && active !== document.body && active.matches(EDITABLE);
    if (!editing) baseline = Math.max(window.innerHeight, h);
    const kb = Math.max(0, Math.round(window.innerHeight - h - top));
    root.style.setProperty('--vvh', `${Math.round(h)}px`);
    root.style.setProperty('--vvtop', `${Math.round(top)}px`);
    root.style.setProperty('--kb', `${kb}px`);
    const open = editing && baseline - h > 120;
    root.classList.toggle('kb-open', open);
    root.classList.toggle('composing', editing && !!active?.closest('.composer'));
  };
  const update = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(apply); };
  apply();
  vv?.addEventListener('resize', update); vv?.addEventListener('scroll', update);
  window.addEventListener('resize', update);
  window.addEventListener('orientationchange', () => { baseline = window.innerHeight; update(); });
  document.addEventListener('focusin', update); document.addEventListener('focusout', () => window.setTimeout(update, 60));
}

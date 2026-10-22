/**
 * Switching tabs must not move the screen. A shorter tab makes the page shorter, the browser pulls the scroll position back, and
 * everything jumps up or down. For every tab in the app (role="tab", the .tab buttons and the segmented controls): the page keeps at
 * least its current height while you stay on the screen, and the tab you clicked stays exactly where it was under your pointer.
 */
const TAB = '[role="tab"], .tab, .tabs > button, .ops-tabs button, [class*="-seg"] > button, [class*="-tabs"] > button';

export function installStableTabs(): () => void {
  let held: HTMLElement | null = null;
  let heldPath = location.pathname;
  const release = () => { if (held) held.style.minHeight = ''; held = null; };
  const onClick = (e: MouseEvent) => {
    if (location.pathname !== heldPath) { release(); heldPath = location.pathname; }
    const tab = (e.target as Element | null)?.closest?.(TAB) as HTMLElement | null;
    if (!tab || tab.closest('[role="dialog"], .modal, .sheet')) return;
    const content = (tab.closest('.content') ?? document.querySelector('.content')) as HTMLElement | null;
    if (!content) return;
    const before = tab.getBoundingClientRect().top;
    content.style.minHeight = `${Math.max(content.offsetHeight, parseFloat(content.style.minHeight) || 0)}px`;
    held = content; heldPath = location.pathname;
    // After the new tab has rendered, and again after late effects (lists that load, panels that scroll themselves): put the tab bar back.
    let userScrolled = false;
    const stop = () => { userScrolled = true; };
    for (const ev of ['wheel', 'touchmove', 'keydown'] as const) window.addEventListener(ev, stop, { once: true, passive: true });
    const restore = () => {
      if (!tab.isConnected || userScrolled) return;
      const delta = tab.getBoundingClientRect().top - before;
      if (Math.abs(delta) >= 1) window.scrollBy({ top: delta, behavior: 'instant' as ScrollBehavior });
    };
    requestAnimationFrame(() => requestAnimationFrame(restore));
    for (const ms of [80, 200, 450]) window.setTimeout(restore, ms);
  };
  const onRoute = () => { if (location.pathname !== heldPath) { release(); heldPath = location.pathname; } };
  document.addEventListener('click', onClick, true);
  window.addEventListener('popstate', onRoute);
  const timer = window.setInterval(onRoute, 700);   // also catches in-app navigation (history.pushState has no event)
  return () => { document.removeEventListener('click', onClick, true); window.removeEventListener('popstate', onRoute); window.clearInterval(timer); release(); };
}

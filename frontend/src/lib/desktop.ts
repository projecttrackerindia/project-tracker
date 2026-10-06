/**
 * The Windows, Mac and Linux app (a window around this same web app, downloaded from the website). Inside it the page becomes a desktop
 * workspace: the top bar is the window's title bar, and the window's buttons take their colors from the theme. In a browser this does nothing.
 */
type Bridge = { platform: string; setTitleBar: (bg: string, fg: string) => void };
const bridge = () => (window as unknown as { ptDesktop?: Bridge }).ptDesktop;

export const isDesktopApp = () => /ProjectTrackerDesktop\//.test(navigator.userAgent);

const hex = (css: string): string | null => {
  const m = css.match(/[\d.]+/g)?.map(Number);
  if (!m || m.length < 3) return null;
  return '#' + m.slice(0, 3).map((n) => Math.round(n).toString(16).padStart(2, '0')).join('');
};

function matchTitleBar() {
  const b = bridge();
  if (!b) return;
  const bar = document.querySelector('.topbar') ?? document.body;
  const bg = hex(getComputedStyle(bar).backgroundColor);
  const fg = hex(getComputedStyle(document.body).color);
  if (bg && fg) b.setTitleBar(bg, fg);
}

let started = false;
export function startDesktopApp() {
  if (started || !isDesktopApp()) return;
  started = true;
  const h = document.documentElement;
  h.classList.add('desktop-app', `desktop-${bridge()?.platform === 'win32' ? 'win' : bridge()?.platform === 'darwin' ? 'mac' : 'linux'}`);
  // The top bar appears after sign-in and the theme can change at any time: keep the title bar the same color.
  let pending = 0;
  const later = () => { window.clearTimeout(pending); pending = window.setTimeout(matchTitleBar, 120); };
  new MutationObserver(later).observe(h, { attributes: true, attributeFilter: ['data-theme', 'class'] });
  new MutationObserver(later).observe(document.body, { childList: true });
  window.addEventListener('load', later);
  later();
}

/**
 * The Windows, Mac and Linux app (a window around this same web app, downloaded from the website). On Windows the app has no system title
 * bar: its own top bar is the title bar and the minimize / maximize / close buttons are drawn here, over the page, so they match the theme.
 * In a browser this does nothing.
 */
type Bridge = { platform: string; attention?: (kind: 'normal' | 'urgent') => void; windowControl: (a: 'minimize' | 'maximize' | 'close') => void; onMaximizeChange: (cb: (maximized: boolean) => void) => void };
const bridge = () => (window as unknown as { ptDesktop?: Bridge }).ptDesktop;

/** Flash the taskbar button / bounce the dock icon (the desktop app only; it ignores this while its window is in front). */
export function desktopAttention(urgent: boolean) { try { bridge()?.attention?.(urgent ? 'urgent' : 'normal'); } catch { /* not in the desktop app */ } }

export const isDesktopApp = () => /ProjectTrackerDesktop\//.test(navigator.userAgent);

const ICONS = {
  minimize: '<svg viewBox="0 0 10 10" width="10" height="10"><path d="M1 5h8" stroke="currentColor" stroke-width="1" fill="none"/></svg>',
  maximize: '<svg viewBox="0 0 10 10" width="10" height="10"><rect x="1" y="1" width="8" height="8" stroke="currentColor" stroke-width="1" fill="none"/></svg>',
  restore: '<svg viewBox="0 0 10 10" width="10" height="10"><path d="M3 3V1h6v6H7M1 3h6v6H1z" stroke="currentColor" stroke-width="1" fill="none"/></svg>',
  close: '<svg viewBox="0 0 10 10" width="10" height="10"><path d="M1 1l8 8M9 1L1 9" stroke="currentColor" stroke-width="1" fill="none"/></svg>',
};

function addWindowButtons(b: Bridge) {
  // A strip along the top of every screen (the sign-in page has no top bar) that moves the window, and the three buttons on top of it.
  const drag = document.createElement('div');
  drag.id = 'pt-drag';
  const box = document.createElement('div');
  box.id = 'pt-winctl';
  box.innerHTML = (['minimize', 'maximize', 'close'] as const).map((a) => `<button type="button" data-a="${a}" aria-label="${a[0].toUpperCase() + a.slice(1)}" class="${a}">${a === 'maximize' ? ICONS.maximize : ICONS[a]}</button>`).join('');
  box.addEventListener('click', (e) => {
    const a = (e.target as HTMLElement).closest('button')?.getAttribute('data-a') as 'minimize' | 'maximize' | 'close' | null;
    if (a) b.windowControl(a);
  });
  box.addEventListener('dblclick', (e) => e.stopPropagation());
  document.body.append(drag, box);
  drag.addEventListener('dblclick', () => b.windowControl('maximize'));
  b.onMaximizeChange((max) => {
    const m = box.querySelector('.maximize');
    if (m) { m.innerHTML = max ? ICONS.restore : ICONS.maximize; m.setAttribute('aria-label', max ? 'Restore' : 'Maximize'); }
    document.documentElement.classList.toggle('desktop-maximized', max);
  });
}

let started = false;
export function startDesktopApp() {
  if (started || !isDesktopApp()) return;
  started = true;
  const b = bridge();
  const win = b?.platform === 'win32';
  document.documentElement.classList.add('desktop-app', `desktop-${win ? 'win' : b?.platform === 'darwin' ? 'mac' : 'linux'}`);
  if (win && b) {
    const add = () => { if (!document.getElementById('pt-winctl')) addWindowButtons(b); };
    if (document.body) add(); else window.addEventListener('DOMContentLoaded', add);
  }
}

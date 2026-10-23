/**
 * Keeps a screen out of screen sharing, screen recording and screenshots, where the platform allows it.
 *
 * - Windows app: the window is excluded from capture by the system (Teams, Zoom, Meet, OBS, Snipping Tool see black or nothing).
 * - Mac app: the window is marked as not shareable. Older capture (screenshots, many tools) sees black; some newer recorders built on
 *   ScreenCaptureKit can still see it, so it is reported as partial.
 * - Android app: the screen is marked secure: screenshots, recordings, casting and the recent-apps preview are black.
 * - A browser tab: no web page can do this. What the page can do (and the vault does) is never draw secret values, and cover itself
 *   whenever the window is not the one in use — the moment someone switches to their meeting app, the vault is hidden.
 *
 * Several screens can ask at once (counted), so one closing does not lift another's protection.
 */
import { isDesktopApp } from './desktop';

export type ShieldLevel = 'blocked' | 'partial' | 'none';
export interface ShieldInfo { level: ShieldLevel; where: 'windows' | 'mac' | 'linux' | 'android' | 'browser' }

type DesktopBridge = { platform?: string; protectContent?: (on: boolean) => void };
type CapPlugin = { set?: (o: { on: boolean }) => Promise<unknown> };
type Capacitor = { isNativePlatform?: () => boolean; getPlatform?: () => string; isPluginAvailable?: (n: string) => boolean; Plugins?: Record<string, unknown> };

const desktop = () => (window as unknown as { ptDesktop?: DesktopBridge }).ptDesktop;
const cap = () => (window as unknown as { Capacitor?: Capacitor }).Capacitor;
const androidShield = (): CapPlugin | null => {
  const c = cap();
  if (!c?.isNativePlatform?.() || c.getPlatform?.() !== 'android') return null;
  if (c.isPluginAvailable && !c.isPluginAvailable('ScreenShield')) return null;
  const p = c.Plugins?.ScreenShield as CapPlugin | undefined;
  return p?.set ? p : null;
};

export function screenShieldInfo(): ShieldInfo {
  const d = desktop();
  if (isDesktopApp() && d?.protectContent) {
    if (d.platform === 'win32') return { level: 'blocked', where: 'windows' };
    if (d.platform === 'darwin') return { level: 'partial', where: 'mac' };
    return { level: 'none', where: 'linux' };
  }
  if (androidShield()) return { level: 'blocked', where: 'android' };
  return { level: 'none', where: 'browser' };
}

let holds = 0;
function apply(on: boolean) {
  try { desktop()?.protectContent?.(on); } catch { /* not in the desktop app */ }
  const a = androidShield();
  if (a) void a.set!({ on }).catch(() => undefined);
}

/** Starts protecting the screen; call the returned function when the screen that asked is gone. */
export function holdScreenShield(): () => void {
  holds++;
  if (holds === 1) apply(true);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds = Math.max(0, holds - 1);
    if (holds === 0) apply(false);
  };
}

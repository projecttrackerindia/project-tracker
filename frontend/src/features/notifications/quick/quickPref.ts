/** One switch per device for buttons on notifications (banners and the desktop app). On by default. */
const KEY = 'pm.quickActions';
export function quickActionsOn(): boolean {
  try { return localStorage.getItem(KEY) !== 'off'; } catch { return true; }
}
export function setQuickActionsOn(on: boolean) {
  try { localStorage.setItem(KEY, on ? 'on' : 'off'); } catch { /* private window: stays on */ }
  try { (window as unknown as { ptDesktop?: { setQuickActions?: (v: boolean) => void } }).ptDesktop?.setQuickActions?.(on); } catch { /* not the desktop app */ }
}

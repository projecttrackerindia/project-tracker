import { shouldShow } from '../lib/appUpdate';
import { dismissUpdate, reloadForUpdate, useAppUpdate } from '../lib/updateWatch';
import { Icon } from './Icon';
import './updateBanner.css';

/**
 * "A new version is available": a small card at the bottom of the screen (above the tab bar on a phone) when the server has a newer build
 * than the one this tab is running. It never takes focus and never reloads on its own, so nothing being typed is lost.
 */
export function UpdateBanner() {
  const available = useAppUpdate((s) => s.available);
  const dismissed = useAppUpdate((s) => s.dismissed);
  const reloading = useAppUpdate((s) => s.reloading);
  if (!shouldShow(available, dismissed)) return null;
  return (
    <div className="upd-banner" role="status" aria-live="polite">
      <span className="upd-ico" aria-hidden="true"><Icon name="refresh" size={16} /></span>
      <div className="upd-text">
        <strong>A new version of Project Tracker is available.</strong>
        <span>Reload to get the latest improvements.</span>
      </div>
      <div className="upd-actions">
        <button type="button" className="upd-btn upd-later" onClick={dismissUpdate} disabled={reloading}>Later</button>
        <button type="button" className="upd-btn upd-reload" onClick={reloadForUpdate} disabled={reloading}>{reloading ? 'Reloading…' : 'Reload'}</button>
      </div>
    </div>
  );
}

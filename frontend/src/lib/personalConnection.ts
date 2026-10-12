import { isDesktopApp } from './desktop';
import { toast } from '../stores/ui';
import { useAuth } from '../stores/auth';

/** OAuth must start and finish in the same cookie jar. Electron opens provider pages externally. */
export function continueConnectionInBrowser(): boolean {
  if (!isDesktopApp()) return false;
  const bridge = (window as unknown as { ptDesktop?: { openConnectedAccounts?: (workspaceSlug?: string) => void } }).ptDesktop;
  if (bridge?.openConnectedAccounts) {
    bridge.openConnectedAccounts(useAuth.getState().ctx?.current?.slug);
    toast('Finish connecting in your browser. Sign in to Project Tracker there, then choose Connect. Return here and refresh the account status.', 'info');
  } else {
    toast('Open Project Tracker in your browser, sign in, and connect from My account → Connected accounts. This desktop version needs an update to open that page for you.', 'info');
  }
  return true;
}

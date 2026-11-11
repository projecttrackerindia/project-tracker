import { ApiError } from '../api/client';
import { toast } from '../stores/ui';

export const UNDO_MS = 10_000;

/**
 * Undo instead of "Are you sure?": the item is deleted straight away (the caller takes it off screen), and a toast offers Undo for 10 seconds.
 * Undo calls the restore endpoint (soft delete on the server) and then `onRestored` so the lists show it again.
 */
export async function deleteWithUndo(o: {
  what: string;
  remove: () => Promise<unknown>;
  restore: () => Promise<unknown>;
  onRemoved?: () => void;
  onRestored?: () => void;
  failText?: string;
}): Promise<boolean> {
  try { await o.remove(); }
  catch (e) { toast(e instanceof ApiError ? e.message : o.failText ?? `Could not delete the ${o.what.toLowerCase()}.`, 'error'); return false; }
  o.onRemoved?.();
  toast(`${o.what} deleted.`, 'info', {
    label: 'Undo', ms: UNDO_MS,
    onClick: () => {
      void o.restore().then(() => { toast(`${o.what} restored.`, 'success'); o.onRestored?.(); })
        .catch((e) => toast(e instanceof ApiError ? e.message : `Could not restore the ${o.what.toLowerCase()}.`, 'error'));
    },
  });
  return true;
}

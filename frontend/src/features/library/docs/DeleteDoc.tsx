import { ApiError } from '../../../api/client';
import { documentApi } from '../../../api/endpoints';
import { Icon } from '../../../components/Icon';
import { invalidateWorkspace } from '../../../lib/hooks';
import { useAuth, useCan, useWorkspaceId } from '../../../stores/auth';
import { confirmDialog, toast } from '../../../stores/ui';

/** Whether to offer Delete on a document in a list: its owner, or anyone who may delete documents. The server still decides. */
export function useCanDeleteDoc() {
  const me = useAuth((s) => s.ctx?.user.id ?? null);
  const any = useCan('docs.delete');
  return (ownerId?: string | null) => any || (!!me && ownerId === me);
}

/** Delete from a list row: asks once, deletes, and offers Undo (a deleted document is kept for 30 days). */
export function useDeleteDoc() {
  const wid = useWorkspaceId();
  return async (d: { id: string; title: string }) => {
    if (!(await confirmDialog({ title: 'Delete this document?', message: `“${d.title}” disappears for everyone. You can bring it back for 30 days.`, confirmText: 'Delete', danger: false }))) return;
    try {
      await documentApi.remove(d.id);
      void invalidateWorkspace(wid, 'documents');
      toast('Document deleted.', 'warning', {
        label: 'Undo',
        onClick: () => { documentApi.restore(d.id).then(() => invalidateWorkspace(wid, 'documents')).catch((e) => toast(e instanceof ApiError ? e.message : 'Could not bring it back.', 'error')); },
      });
    } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not delete.', 'error'); }
  };
}

export function DocTrash({ title, onDelete }: { title: string; onDelete: () => void }) {
  return (
    <button type="button" className="dx-trash" aria-label={`Delete ${title}`} title="Delete" onClick={(e) => { e.preventDefault(); e.stopPropagation(); onDelete(); }}>
      <Icon name="trash" size={15} />
    </button>
  );
}

import { ApiError } from '../../api/client';
import { projectApi, taskApi } from '../../api/endpoints';
import type { Task } from '../../api/types';
import { queryClient, useAuth } from '../../stores/auth';
import { alertDialog, toast } from '../../stores/ui';
import { invalidateWorkspace } from '../../lib/hooks';

/** The completion rules that get a popup, with its title. */
export const REFUSALS: Record<string, string> = {
  TASK_INCOMPLETE_CHILDREN: 'Task can’t be completed yet',
  STAGE_HAS_OPEN_TASKS: 'Stage can’t be completed yet',
  STAGE_HAS_OPEN_ISSUES: 'Stage can’t be completed yet',
  STAGE_PREVIOUS_INCOMPLETE: 'Previous Step Not Completed',
};

/**
 * Says why a task change was refused. The completion rules (finish the subtasks and checklist first, finish a stage's tasks first)
 * get a popup that has to be acknowledged; everything else is a toast.
 */
export function reportTaskError(e: unknown, fallback: string) {
  if (e instanceof ApiError && REFUSALS[e.code]) {
    void alertDialog({
      title: REFUSALS[e.code],
      message: e.errors[0]?.message ?? e.message,
    });
    return;
  }
  toast(e instanceof ApiError ? e.message : fallback, 'error');
}

/** Completes an open task (first Done status of its project) or reopens a finished one (first Todo status). */
export async function toggleTaskComplete(task: Task) {
  const wid = useAuth.getState().ctx?.current?.id;
  try {
    const detail = await queryClient.fetchQuery({ queryKey: [wid, 'project', task.projectId], queryFn: () => projectApi.get(task.projectId), staleTime: 60_000 });
    const done = task.statusCategory === 'Done';
    const target = detail.statuses.find((s) => s.category === (done ? 'Todo' : 'Done'));
    if (!target) { toast('This project has no matching status.', 'warning'); return; }
    await taskApi.move(task.id, { statusId: target.id });
    toast(done ? 'Task reopened.' : 'Task completed.');
    await invalidateWorkspace(wid);
  } catch (e) {
    reportTaskError(e, 'Could not update the task.');
  }
}

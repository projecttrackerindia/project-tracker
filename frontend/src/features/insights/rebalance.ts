import { useState } from 'react';
import { ApiError, post } from '../../api/client';
import { toast } from '../../stores/ui';

/**
 * Starts the AI workload review. Kept apart from InsightsPage so the Work and Capacity screens can offer it without downloading the
 * whole Insights page and its chart library.
 */
export function useRebalance(onStarted: (job: string) => void) {
  const [busy, setBusy] = useState(false);
  const rebalance = async () => {
    setBusy(true);
    try {
      const job = await post<{ id: string }>('/ai/operations/jobs', { kind: 'workload', title: 'Workload and capacity review', idempotencyKey: crypto.randomUUID() });
      toast('Started a workload review. It appears under Reports when ready.');
      onStarted(job.id);
    } catch (e) { toast(e instanceof ApiError ? e.errors[0]?.message ?? e.message : 'Could not start the review.', 'error'); }
    finally { setBusy(false); }
  };
  return { busy, rebalance };
}

import { useQuery } from '@tanstack/react-query';
import { platformApi } from '../api/endpoints';

/** The platform announcement (and a notice while changes are paused), for signed-in and signed-out visitors alike. */
export function PlatformBanner() {
  const q = useQuery({ queryKey: ['platform-status'], queryFn: platformApi.status, refetchInterval: 60_000, staleTime: 30_000, retry: false });
  const s = q.data;
  if (!s || (!s.announcement && !s.maintenanceMode)) return null;
  return (
    <div className={`platform-banner ${s.maintenanceMode ? 'danger' : s.announcementLevel}`} role="status">
      {s.maintenanceMode && <b>Maintenance in progress — you can read your data, but changes are paused. </b>}
      {s.announcement}
    </div>
  );
}

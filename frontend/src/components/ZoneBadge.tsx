import { useAppZone, zoneBadge, zoneCity, zoneOffsetLabel } from '../lib/zone';
import './zoneBadge.css';

/**
 * A small "IST" next to a day's title when the app shows the person's (or organization's) zone and this device is in another one, so
 * 9:30 on Your day or the Calendar is never read as this device's 9:30. Nothing when the two agree.
 */
export function ZoneBadge({ className = '' }: { className?: string }) {
  const zone = useAppZone();
  const label = zoneBadge(zone);
  if (!label) return null;
  return (
    <span className={`zone-badge ${className}`.trim()} data-testid="zone-badge" data-zone={zone}
      title={`Times are shown in ${zoneCity(zone)} time (${zoneOffsetLabel(zone)}), your time zone for scheduling.`}>
      {label}
    </span>
  );
}

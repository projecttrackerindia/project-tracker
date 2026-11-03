import { useId } from 'react';

/**
 * The ProjectTracker logo: the purple check in a rounded square (from the calm demo's SVG). Used in the sidebar, the collapsed rail, sign-in,
 * the splash screen and (as public/favicon.svg) the browser tab. Gradient ids are unique per instance so several logos can share a page.
 */
export function Logo({ size = 28, className = 'pt-logo', title }: { size?: number; className?: string; title?: string }) {
  const raw = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const g = `ptl${raw}`, h = `ptlh${raw}`;
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 64 64" role={title ? 'img' : undefined} aria-label={title} aria-hidden={title ? undefined : true}>
      <defs>
        <linearGradient id={g} x1="8" y1="4" x2="56" y2="60" gradientUnits="userSpaceOnUse"><stop offset="0" stopColor="#8b6cf6" /><stop offset=".55" stopColor="#a27cf8" /><stop offset="1" stopColor="#b996fb" /></linearGradient>
        <linearGradient id={h} x1="0" y1="0" x2="0" y2="64" gradientUnits="userSpaceOnUse"><stop offset="0" stopColor="#fff" stopOpacity=".28" /><stop offset=".5" stopColor="#fff" stopOpacity="0" /></linearGradient>
      </defs>
      <rect x="2" y="2" width="60" height="60" rx="16" fill={`url(#${g})`} />
      <rect x="2" y="2" width="60" height="60" rx="16" fill={`url(#${h})`} />
      <rect x="2.5" y="2.5" width="59" height="59" rx="15.5" fill="none" stroke="#fff" strokeOpacity=".35" />
      <path d="M20 34l8 8L43 24" fill="none" stroke="#fff" strokeWidth="5.6" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="44.5" cy="22.5" r="4.4" fill="#fff" />
    </svg>
  );
}

/** The brand name, one word. */
export const BRAND = 'ProjectTracker';

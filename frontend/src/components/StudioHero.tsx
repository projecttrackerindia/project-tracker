import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon';
import './studioHero.css';

/** Shared visual hierarchy for the enterprise studios. All counts come from their authorized APIs. */
export function StudioHero({ eyebrow, title, description, icon, children }: {
  eyebrow: string; title: string; description: string; icon: IconName; children?: ReactNode;
}) {
  return <header className="studio-hero">
    <div className="studio-hero-mark" aria-hidden="true"><span/><Icon name={icon}/></div>
    <div className="studio-hero-copy"><span className="studio-eyebrow">{eyebrow}</span><h1>{title}</h1><p>{description}</p></div>
    {children && <div className="studio-hero-actions">{children}</div>}
  </header>;
}

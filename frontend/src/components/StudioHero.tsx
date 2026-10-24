import type { ReactNode } from 'react';
import './studioHero.css';

/** A quiet page heading for a studio inside a section: its name, one line on what it is for, and its main actions. */
export function StudioHero({ title, description, children }: { title: string; description: string; children?: ReactNode }) {
  return <header className="studio-hero">
    <div className="studio-hero-copy"><h2>{title}</h2><p>{description}</p></div>
    {children && <div className="studio-hero-actions">{children}</div>}
  </header>;
}

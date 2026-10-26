import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Segmented } from '../ui';
import './v2.css';

/**
 * The segmented tabs at the top right of a place (v2: "one segmented tab control on the right"). A link that leaves the place is shown
 * after the tabs with ›, never as a tab.
 */
export function PlaceTabs<T extends string>({ label, options, value, onChange, link, children }: {
  label: string; options: readonly { id: T; label: ReactNode }[]; value: T; onChange: (t: T) => void; link?: { to: string; label: string }; children?: ReactNode;
}) {
  return (
    <div className="v2-place-tabs">
      {children}
      {options.length > 1 && <Segmented label={label} value={value} onChange={onChange} options={options} />}
      {link && <Link className="v2-place-link" to={link.to}>{link.label} ›</Link>}
    </div>
  );
}

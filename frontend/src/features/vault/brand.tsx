import { Icon, type IconName } from '../../components/Icon';
import type { VaultItemKind } from './api';

import { brandOf } from './brandColors';

/** The item's tile: its colour and letters, with a small mark for what kind of secret it is. */
const KIND_BADGE: Partial<Record<VaultItemKind, IconName>> = { ApiKey: 'key', Server: 'monitor', Database: 'database', Card: 'card', Note: 'note' };

export function BrandTile({ title, url, kind, size = 'md', pass = false }: { title: string; url?: string | null; kind: VaultItemKind; size?: 'md' | 'lg' | 'xl';
  /** Passwords-style: a gradient tile with one white letter (the first of its letters), no kind badge. */ pass?: boolean }) {
  const b = brandOf(title, url);
  const badge = pass ? undefined : KIND_BADGE[kind];
  return (
    <span className={`vlt-tile ${size}${pass ? ' pass' : b.text.length > 2 ? ' wide' : ''}`} style={{ ['--tile' as string]: b.color }} aria-hidden="true">
      <span className="vlt-tile-text">{pass ? b.text[0] : b.text}</span>
      {badge && <span className="vlt-tile-badge"><Icon name={badge} size={10} /></span>}
    </span>
  );
}

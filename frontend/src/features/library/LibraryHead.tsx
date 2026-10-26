import type { ReactNode } from 'react';
import { PageHead } from '../../components/ui';

/** The Library's page head: the blue context line, the big title, the Docs · Vault switch and the tab's own actions. */
export function LibraryHead({ eyebrow, eyebrowTone, switcher, children }: { eyebrow: ReactNode; eyebrowTone?: 'success' | 'warning' | 'danger'; switcher: ReactNode; children?: ReactNode }) {
  return <PageHead title="Library" eyebrow={eyebrow} eyebrowTone={eyebrowTone}>{switcher}{children}</PageHead>;
}

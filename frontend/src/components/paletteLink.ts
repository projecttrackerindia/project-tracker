import type { SearchHit } from '../api/types';

/**
 * The palette's small shared pieces, apart from the palette itself, so the top bar, the phone bar and the pages can open it or link a search
 * hit without downloading the palette (it loads the first time it opens: see PaletteLauncher in layouts/AppLayout.tsx).
 */
/** Where a search hit opens. Shared with the search box in the top bar. */
export function searchHitLink(h: Pick<SearchHit, 'type' | 'id' | 'projectId' | 'taskId'>): string {
  switch (h.type) {
    case 'file': return h.taskId ? `/work?item=${h.taskId}` : `/work/projects/${h.projectId}?tab=files`;
    case 'task': case 'comment': return `/work?item=${h.taskId}`;
    case 'issue': return `/work?item=${h.id}`;
    case 'action': return `/work?item=${h.id}`;
    case 'work': return `/work?item=${h.id}`;
    case 'project': return `/work/projects/${h.id}`;
    case 'page': return `/library/docs/${h.id}`;
    case 'team': return '/people/teams';
    case 'member': return '/people';
    case 'label': return '/settings/fields/labels';
    default: return '/work/projects';
  }
}
/** Opens the palette from anywhere (a top-bar button, a shortcut hint). */
export const openPalette = () => window.dispatchEvent(new Event('pm:palette'));

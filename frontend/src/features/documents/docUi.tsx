import type { CSSProperties } from 'react';
import { Icon, type IconName } from '../../components/Icon';
import type { DocumentItem, DocumentStatus, DocumentVisibility, LinkRelation, LinkTarget } from '../../api/types';
import { labelize } from '../../lib/format';

/** The icon names the server's built-in types use, mapped onto the app's own icon set. */
const TYPE_ICONS: Record<string, IconName> = {
  file: 'note', code: 'git', tool: 'settings', list: 'list', check: 'checkCircle', chart: 'chart', link: 'org', layers: 'layers', upload: 'upload',
  bolt: 'bolt', folder: 'folder', route: 'arrowRight', shield: 'shield', rocket: 'target', server: 'database',
};
export const typeIcon = (name: string): IconName => TYPE_ICONS[name] ?? 'note';

export function TypeChip({ doc, size = 34 }: { doc: Pick<DocumentItem, 'typeColor' | 'typeIcon' | 'typeName'>; size?: number }) {
  const style = { '--dc': doc.typeColor, width: size, height: size } as CSSProperties;
  return <span className="doc-chip" style={style} title={doc.typeName}><Icon name={typeIcon(doc.typeIcon)} size={Math.round(size * 0.52)} /></span>;
}

const STATUS_TONE: Record<DocumentStatus, string> = {
  Draft: 'badge-neutral', InReview: 'badge-info', ChangesRequested: 'badge-warning', Approved: 'badge-success', Published: 'badge-success', Archived: 'badge-neutral',
};
export const DocStatusBadge = ({ status }: { status: DocumentStatus }) => <span className={`badge ${STATUS_TONE[status]}`}><span className="dot" />{labelize(status)}</span>;

export const VISIBILITY: Record<DocumentVisibility, { label: string; hint: string; icon: IconName }> = {
  Project: { label: 'Project', hint: 'Everyone who can open the project', icon: 'folder' },
  Team: { label: 'Team', hint: 'Members of the chosen team', icon: 'users' },
  Organization: { label: 'Organization', hint: 'Every member of the workspace (not guests)', icon: 'building' },
  Private: { label: 'Only me', hint: 'You, and the organization’s owners and admins', icon: 'lock' },
};

export const RELATIONS: { value: LinkRelation; label: string; hint: string }[] = [
  { value: 'Describes', label: 'Describes', hint: 'This document explains it' },
  { value: 'Implements', label: 'Implemented by', hint: 'This work builds what the document asks for' },
  { value: 'Verifies', label: 'Verified by', hint: 'This work tests what the document asks for' },
  { value: 'References', label: 'References', hint: 'Related reading' },
  { value: 'DependsOn', label: 'Depends on', hint: 'This document relies on it' },
];
export const relationLabel = (r: LinkRelation) => RELATIONS.find((x) => x.value === r)?.label ?? r;

export const TARGET_LABEL: Record<LinkTarget, string> = { Project: 'Project', Task: 'Task', Issue: 'Issue', WorkItem: 'Work item', Sprint: 'Sprint' };

/** Where a linked item opens in the app. */
export function targetLink(type: LinkTarget, id: string, projectId: string | null): string {
  switch (type) {
    case 'Task': return projectId ? `/projects/${projectId}?task=${id}` : '/projects';
    case 'Issue': return projectId ? `/projects/${projectId}?tab=issues&issue=${id}` : '/projects';
    case 'WorkItem': return `/operations?task=${id}`;
    case 'Sprint': return projectId ? `/projects/${projectId}?tab=plan` : '/projects';
    default: return `/projects/${id}`;
  }
}

export const emptyDoc = '{"type":"doc","content":[{"type":"paragraph"}]}';

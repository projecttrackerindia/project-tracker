import type { CSSProperties } from 'react';
import { workspaceApi } from '../api/endpoints';
import { useWsQuery } from '../lib/hooks';
import { initials } from '../lib/format';
import { useAvatarUrl } from './ui';

/**
 * A person's face in any page's own avatar style: their uploaded photo when they have one (the shared, cached avatar lookup that
 * <Avatar> uses), their initials otherwise. The caller keeps its own class (size, colour, border); the photo fills it.
 * `byName`: when only a display name is known (meeting attendees, AI lists), the person is matched against the workspace members.
 */
export function Face({ userId, name, hasAvatar, byName = false, className = '', style, text, title }: {
  userId?: string | null; name?: string | null; hasAvatar?: boolean; byName?: boolean; className?: string; style?: CSSProperties; text?: string; title?: string;
}) {
  const lookup = !userId && byName && !!name;
  const members = useWsQuery(['members'], () => workspaceApi.members(), { staleTime: 5 * 60_000, retry: false, enabled: lookup });
  const key = name?.trim().toLowerCase();
  const id = userId ?? (lookup ? members.data?.find((m) => m.displayName.trim().toLowerCase() === key)?.userId : undefined);
  const url = useAvatarUrl(id ?? undefined, hasAvatar);
  return (
    <span className={`${className} face${url ? ' face-photo' : ''}`} style={style} title={title} aria-hidden="true" data-face={id ?? undefined}>
      {url ? <img className="face-img" src={url} alt="" /> : text ?? initials(name)}
    </span>
  );
}

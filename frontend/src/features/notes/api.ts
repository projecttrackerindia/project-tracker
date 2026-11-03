import { create, del, get, patch, put } from '../../api/client';

interface UserRef { id: string; name: string }
export type NoteSharing = 'private' | 'people' | 'workspace';
export type NoteView = 'all' | 'pinned' | 'shared' | 'meetings';

/** An inline reference inside a block: a person (@Tom) or a piece of work (#ATL-482). The server reads mentions from these. */
export type NoteRef =
  | { type: 'mention'; userId: string; label: string }
  | { type: 'link'; kind: string; id: string; label: string; href?: string | null };
export type BlockType = 'p' | 'h' | 'check' | 'image' | 'file';
export interface NoteBlock {
  id: string; type: BlockType; text: string; done?: boolean; refs?: NoteRef[];
  /** Images and attachments: the stored file (project attachments) and how to show it. */
  fileId?: string; name?: string; size?: number; projectId?: string;
}
export interface NoteLink { kind: string; id: string; label: string; href?: string | null }
export interface NoteSummary {
  id: string; title: string; snippet: string; folder: string | null; tags: string[]; pinned: boolean; sharing: NoteSharing; owner: UserRef;
  projectId: string | null; meetingId: string | null; mine: boolean; createdAt: string; updatedAt: string;
}
export interface Note extends Omit<NoteSummary, 'snippet'> { content: NoteBlock[]; sharedWith: UserRef[]; links: NoteLink[]; canEdit: boolean; editors: UserRef[] }
export interface NoteList {
  items: NoteSummary[]; counts: { all: number; pinned: number; shared: number; meetings: number };
  folders: { name: string; count: number; projectId: string | null }[]; tags: { tag: string; count: number }[];
}
export interface SaveNote {
  title?: string; content?: NoteBlock[]; folder?: string; tags?: string[]; pinned?: boolean; projectId?: string | null; meetingId?: string | null; links?: NoteLink[]; clearProject?: boolean;
}

export const notesApi = {
  list: (p: { view?: NoteView; folder?: string; tag?: string; q?: string }) => get<NoteList>('/notes', p),
  get: (id: string) => get<Note>(`/notes/${id}`),
  create: (b: SaveNote) => create<Note>('/notes', b),
  update: (id: string, b: SaveNote) => patch<Note>(`/notes/${id}`, b),
  share: (id: string, sharing: NoteSharing, userIds: string[] = []) => put<Note>(`/notes/${id}/sharing`, { sharing, userIds }),
  remove: (id: string) => del(`/notes/${id}`),
};

export const newBlock = (type: BlockType = 'p', text = ''): NoteBlock => ({ id: Math.random().toString(36).slice(2, 10), type, text });

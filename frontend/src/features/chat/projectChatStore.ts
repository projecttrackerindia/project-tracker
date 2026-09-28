import { create } from 'zustand';

export interface ProjectChatTarget { projectId: string; name: string }

interface ProjectChatState {
  /** The project whose team chat is open in the slide-in panel. */
  target: ProjectChatTarget | null;
  openChat: (projectId: string, name: string) => void;
  close: () => void;
}

export const useProjectChat = create<ProjectChatState>((set) => ({
  target: null,
  openChat: (projectId, name) => set({ target: { projectId, name } }),
  close: () => set({ target: null }),
}));

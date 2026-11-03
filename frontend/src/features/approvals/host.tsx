import { lazy, Suspense, useEffect, useId, useState } from 'react';
import { create } from 'zustand';
import type { ApprovalLink, ApprovalType } from './api';

/** What the request sheet opens with: a type, and (from Time, a task, a release) fields and links already filled in. */
export interface ApprovalDraft { type?: ApprovalType; payload?: Record<string, string>; links?: ApprovalLink[]; title?: string; summary?: string }

interface SheetState { draft: ApprovalDraft | null; host: string | null; open: (d?: ApprovalDraft) => void; close: () => void; claim: (id: string) => void; release: (id: string) => void }

export const useApprovalSheet = create<SheetState>((set, get) => ({
  draft: null, host: null,
  open: (d = {}) => set({ draft: d }),
  close: () => set({ draft: null }),
  claim: (id) => { if (!get().host) set({ host: id }); },
  release: (id) => { if (get().host === id) set({ host: null }); },
}));

/** Opens "Request approval" from anywhere (the + button, Time's "Request leave", a release). */
export const openApprovalRequest = (d?: ApprovalDraft) => useApprovalSheet.getState().open(d);

// The + button (shell) announces "new <kind>" as a window event; an approval request opens this sheet.
if (typeof window !== 'undefined') {
  window.addEventListener('pt:new', (e) => {
    const detail = (e as CustomEvent<{ kind?: string; type?: ApprovalType } | undefined>).detail;
    if (detail?.kind === 'approval') openApprovalRequest(detail.type ? { type: detail.type } : undefined);
  });
}

const RequestSheet = lazy(() => import('./RequestSheet').then((m) => ({ default: m.RequestSheet })));

/**
 * Mount anywhere (the shell, the Approvals page, Time): the first host mounted renders the sheet, the others stay empty, so the sheet
 * never opens twice. The sheet's code loads only when it is first opened.
 */
export function ApprovalRequestHost() {
  const id = useId();
  const host = useApprovalSheet((s) => s.host);
  const draft = useApprovalSheet((s) => s.draft);
  const claim = useApprovalSheet((s) => s.claim);
  const release = useApprovalSheet((s) => s.release);
  useEffect(() => { claim(id); return () => release(id); }, [id, claim, release]);
  useEffect(() => { if (!host) claim(id); }, [host, id, claim]);
  const [seen, setSeen] = useState(false);
  useEffect(() => { if (draft) setSeen(true); }, [draft]);
  if (host !== id || !seen) return null;
  return <Suspense fallback={null}><RequestSheet open={!!draft} draft={draft ?? {}} onClose={() => useApprovalSheet.getState().close()} /></Suspense>;
}

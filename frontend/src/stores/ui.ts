import { create } from 'zustand';

export type ToastType = 'success' | 'error' | 'warning' | 'info';
export interface ToastAction { label: string; onClick: () => void }
interface ToastItem { id: number; message: string; type: ToastType; action?: ToastAction }
interface ConfirmState { title: string; message: string; confirmText: string; danger: boolean; alertOnly?: boolean; resolve: (ok: boolean) => void }

type Theme = 'light' | 'dark';
const savedTheme = (): Theme => {
  try {
    const t = localStorage.getItem('pm_theme');
    if (t === 'light' || t === 'dark') return t;
  } catch { /* storage unavailable */ }
  // Light is the default for everyone who has not chosen otherwise (the computer's own dark setting is deliberately not followed).
  return 'light';
};

const THEME_COLOR: Record<Theme, string> = { light: '#7c3aed', dark: '#131c2a' };   // the browser's own toolbar colour on phones

/**
 * Switches the page between light and dark with a short cross-fade instead of a hard flash: the whole page fades where the
 * browser supports view transitions, otherwise every colour fades (the theme-fade class, see base.css).
 * Nothing animates for people who have asked for reduced motion.
 */
function applyTheme(theme: Theme) {
  const root = document.documentElement;
  if (root.getAttribute('data-theme') === theme) return;
  const apply = () => {
    root.setAttribute('data-theme', theme);
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[theme]);
  };
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { apply(); return; }
  const doc = document as unknown as { startViewTransition?: (update: () => void) => unknown };
  if (typeof doc.startViewTransition === 'function') { doc.startViewTransition(apply); return; }
  root.classList.add('theme-fade');
  apply();
  window.setTimeout(() => root.classList.remove('theme-fade'), 400);
}

interface UiState {
  theme: Theme;
  setTheme: (t: Theme) => void;
  toggleTheme: () => void;
  sidebarCollapsed: boolean;
  sidebarOpen: boolean;
  toggleSidebar: () => void;
  closeSidebar: () => void;
  toasts: ToastItem[];
  pushToast: (message: string, type: ToastType, action?: ToastAction) => void;
  dismissToast: (id: number) => void;
  confirm: ConfirmState | null;
  setConfirm: (c: ConfirmState | null) => void;
}

let toastId = 0;

export const useUi = create<UiState>((set, get) => ({
  theme: savedTheme(),
  setTheme: (theme) => {
    applyTheme(theme);
    try { localStorage.setItem('pm_theme', theme); } catch { /* ignore */ }
    set({ theme });
  },
  toggleTheme: () => get().setTheme(get().theme === 'dark' ? 'light' : 'dark'),
  sidebarCollapsed: false,
  sidebarOpen: false,
  toggleSidebar: () => {
    if (window.innerWidth <= 1024) set((s) => ({ sidebarOpen: !s.sidebarOpen }));
    else set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed }));
  },
  closeSidebar: () => set({ sidebarOpen: false }),
  toasts: [],
  pushToast: (message, type, action) => {
    const id = ++toastId;
    set((s) => ({ toasts: [...s.toasts, { id, message, type, action }] }));
    setTimeout(() => get().dismissToast(id), action ? 8000 : type === 'error' ? 5000 : 3200);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  confirm: null,
  setConfirm: (confirm) => set({ confirm }),
}));

export const toast = (message: string, type: ToastType = 'success', action?: ToastAction) => useUi.getState().pushToast(message, type, action);

/** A notice that only needs acknowledging (one OK button): for refusals the person has to read, which a toast would let slip by. */
export function alertDialog(opts: { title: string; message: string; okText?: string }): Promise<void> {
  return new Promise((resolve) =>
    useUi.getState().setConfirm({
      title: opts.title, message: opts.message, confirmText: opts.okText ?? 'OK', danger: false, alertOnly: true,
      resolve: () => { useUi.getState().setConfirm(null); resolve(); },
    }));
}

/** Promise-based confirmation modal; resolves false if dismissed. */
export function confirmDialog(opts: { title: string; message: string; confirmText?: string; danger?: boolean }): Promise<boolean> {
  return new Promise((resolve) =>
    useUi.getState().setConfirm({
      title: opts.title, message: opts.message, confirmText: opts.confirmText ?? 'Delete', danger: opts.danger ?? true,
      resolve: (ok) => { useUi.getState().setConfirm(null); resolve(ok); },
    }));
}

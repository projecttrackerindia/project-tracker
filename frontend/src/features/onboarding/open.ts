/** Opens the welcome tour from anywhere (the account menu, ⌘K, Settings) without loading its code first. */
export const OPEN_TOUR = 'pt:welcome-tour';
export const openTour = () => window.dispatchEvent(new Event(OPEN_TOUR));

/** What the tour remembers with the person's account (/me/ui/onboarding). */
export interface TourState { done?: boolean; step?: number; at?: string }

/**
 * Whether the tour opens by itself: only once, only for someone who has never finished or closed it, and only in a workspace that has
 * nothing in it yet (a brand-new workspace). Everyone else opens it from the account menu, ⌘K or Settings. Every input must be a clear
 * answer from the server; anything unknown keeps it closed.
 */
export function shouldAutoOpen(pref: TourState | null | undefined, sampleExists: unknown, projectTotal: unknown): boolean {
  if (pref !== null) return false;
  if (sampleExists !== false) return false;
  return projectTotal === 0;
}

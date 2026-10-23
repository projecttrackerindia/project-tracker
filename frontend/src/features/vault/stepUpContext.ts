import { createContext, useContext } from 'react';

export interface StepUpApi {
  /**
   * Runs a call that may need a fresh two-step check. With `ask`, the code is asked for first (when no check is fresh), so a refusal is
   * not recorded for nothing; otherwise the call is tried and, if the server says a check is needed, the code is asked for and it runs again.
   * Resolves to null when the person cancels.
   */
  run: <T>(fn: (token?: string) => Promise<T>, ask?: boolean) => Promise<T | null>;
  /** Forget the check (the vault locked itself, or the person locked it). */
  forget: () => void;
  fresh: () => boolean;
}

export const StepUpContext = createContext<StepUpApi | null>(null);
export const useStepUp = () => {
  const v = useContext(StepUpContext);
  if (!v) throw new Error('useStepUp outside StepUpProvider');
  return v;
};


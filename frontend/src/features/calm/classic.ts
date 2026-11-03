import { useSearchParams } from 'react-router-dom';

/**
 * The pages before the calm build stay reachable (every feature kept): `?classic=1` on Today, My work, Projects and a project opens the
 * earlier view of that page, and each calm page links to it from its ⋯ menu. A browser can also keep the earlier views on with
 * localStorage pt_classic_pages = '1' (the older UI checks use this).
 */
export function useClassic(): boolean {
  const [params] = useSearchParams();
  if (params.get('classic') === '1') return true;
  try { return localStorage.getItem('pt_classic_pages') === '1'; } catch { return false; }
}

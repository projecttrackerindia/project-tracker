/**
 * Likely duplicate projects: names that are the same once case, spaces and punctuation are ignored ("Darwin box Api" and "Darwin Box api",
 * "SBI-bulk payments" and "SBI bulk payments"). A group the workspace said is not a duplicate stays dismissed (remembered per workspace on
 * this device; nothing on the server stores it yet).
 */
export const nameKey = (name: string) => name.normalize('NFKD').toLowerCase().replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, '');

export function duplicateGroups<T extends { id: string; name: string }>(projects: readonly T[]): T[][] {
  const by = new Map<string, T[]>();
  for (const p of projects) {
    const k = nameKey(p.name);
    if (k.length < 3) continue;   // "QA" and "Q.A." are too short to call a duplicate
    by.set(k, [...(by.get(k) ?? []), p]);
  }
  return [...by.values()].filter((g) => g.length > 1);
}

/** The same group whatever order its projects come in: what a dismissal is remembered by. */
export const groupKey = (group: readonly { id: string }[]) => group.map((p) => p.id).sort().join('+');

const storeKey = (workspaceId: string) => `pm_not_duplicates:${workspaceId}`;
export function readDismissed(workspaceId: string | null | undefined): string[] {
  if (!workspaceId) return [];
  try { const v = JSON.parse(localStorage.getItem(storeKey(workspaceId)) ?? '[]'); return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []; }
  catch { return []; }
}
export function writeDismissed(workspaceId: string | null | undefined, keys: string[]) {
  if (!workspaceId) return;
  try { localStorage.setItem(storeKey(workspaceId), JSON.stringify(keys.slice(-200))); } catch { /* storage unavailable: it is asked again next time */ }
}

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A guard on how screens refresh after a save (docs/UI-RESPONSIVENESS.md).
 *
 * `invalidateWorkspace(wid)` with no family, and `invalidateQueries()` with no key, read EVERY open view of the workspace again after one
 * change: a card move or a field save then competes with a dozen unrelated requests, and an older read that lands late puts the old value
 * back on screen. The shared write layer (lib/optimistic.ts, lib/MutationSync.tsx) already refreshes exactly the views a change touches, so
 * a screen should either rely on it or name the family it changed. These counts are a ceiling: they may go down, never up. When you fix a
 * call, lower the number here.
 */
const CEILING = { workspaceWide: 50, noKey: 8 };

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

const count = (re: RegExp) => sources(join(process.cwd(), 'src')).reduce((n, f) => n + (readFileSync(f, 'utf8').match(re)?.length ?? 0), 0);

describe('coarse refreshes', () => {
  it('no new workspace-wide refresh after a save', () => {
    expect(count(/invalidateWorkspace\((wid|workspaceId|w)\)/g)).toBeLessThanOrEqual(CEILING.workspaceWide);
  });
  it('no new invalidateQueries() without a key', () => {
    expect(count(/invalidateQueries\(\)/g)).toBeLessThanOrEqual(CEILING.noKey);
  });
});

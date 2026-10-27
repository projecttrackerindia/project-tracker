/** Pure helpers for the Quality page (column headings, steps, evidence highlighting, the shared cause of failures), kept apart for tests. */
import type { TestRun } from '../../api/qualityApi';

const hm = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

/** A matrix column: "UAT 1.4 / running · 10:41", "PROD-like / queued", "DEV / #212". */
export function runHeading(r: TestRun): { top: string; sub: string } {
  if (r.status === 'Running') return { top: r.name, sub: `running${r.startedAt ? ` · ${hm(r.startedAt)}` : ''}` };
  const top = r.environment || r.name;
  if (r.status === 'Open') return { top, sub: 'queued' };
  return { top, sub: r.build ? `#${r.build.replace(/^#/, '')}` : r.environment ? r.name : new Date(r.completedAt ?? r.createdAt).toLocaleDateString([], { day: 'numeric', month: 'short' }) };
}

/** "Release 1.4" from a run called "UAT 1.4"; the run's name when it carries no version. */
export function releaseOf(name: string): string {
  const v = name.match(/\d+(?:\.\d+)+/)?.[0];
  return v ? `Release ${v}` : name;
}

/** Steps, one per line, without the "1." a writer may have typed. */
export const stepsOf = (steps: string | null | undefined) =>
  (steps ?? '').split('\n').map((s) => s.trim().replace(/^(\d+[.)]|[-*•])\s*/, '')).filter(Boolean);

/** Evidence lines in parts for the dark block: a "$ command" line grey, an HTTP error status red, JSON keys pink. */
export function evidenceLines(text: string): { t: string; k?: 'g' | 'r' | 'k' }[][] {
  return text.replace(/\r\n/g, '\n').split('\n').map((line) => {
    if (/^\s*\$/.test(line)) return [{ t: line, k: 'g' as const }];
    const http = line.match(/^(HTTP\/[\d.]+\s+)([45]\d\d\b.*)$/);
    if (http) return [{ t: http[1] }, { t: http[2], k: 'r' as const }];
    const parts: { t: string; k?: 'k' }[] = [];
    const re = /("[^"\n]*")(\s*:)/g;
    let last = 0, m: RegExpExecArray | null;
    while ((m = re.exec(line))) {
      if (m.index > last) parts.push({ t: line.slice(last, m.index) });
      parts.push({ t: m[1], k: 'k' }, { t: m[2] });
      last = m.index + m[0].length;
    }
    if (last < line.length) parts.push({ t: line.slice(last) });
    return parts.length ? parts : [{ t: '' }];
  });
}

/**
 * What every failure has in common, from what actually happened ("502 · CRIF token expired" on each → "the CRIF token"): the longest run of
 * words that appears in all of them, ignoring status codes and filler. Null when there is nothing shared or only one failure.
 */
export function commonCause(actuals: (string | null | undefined)[]): string | null {
  const texts = actuals.map((a) => (a ?? '').toLowerCase()).filter(Boolean);
  if (texts.length < 2 || texts.length !== actuals.length) return null;
  const words = (actuals[0] ?? '').split(/[^\p{L}\p{N}_-]+/u).filter(Boolean);
  const stop = new Set(['the', 'a', 'an', 'is', 'was', 'on', 'in', 'of', 'to', 'and', 'or', 'with', 'for', 'expired', 'failed', 'error', 'returns', 'returned']);
  let best: string[] = [];
  for (let i = 0; i < words.length; i++) {
    for (let j = i + 1; j <= words.length; j++) {
      const seq = words.slice(i, j);
      const phrase = seq.join(' ').toLowerCase();
      if (!texts.every((t) => t.includes(phrase))) break;
      const meaningful = seq.filter((w) => !stop.has(w.toLowerCase()) && !/^\d+$/.test(w));
      if (meaningful.length > 0 && seq.length > best.length) best = seq;
    }
  }
  while (best.length && (stop.has(best[best.length - 1].toLowerCase()) || /^\d+$/.test(best[best.length - 1]))) best = best.slice(0, -1);
  while (best.length && (stop.has(best[0].toLowerCase()) || /^\d+$/.test(best[0]))) best = best.slice(1);
  return best.length ? `the ${best.join(' ')}` : null;
}

/** Library's kinds: the segmented control (All · API docs · Specs · Runbooks · Tests), the list's chip and a cover's colour, from a document type code. */
export type KindFilter = 'all' | 'api' | 'spec' | 'runbook' | 'test';
export type Shelf = 'api' | 'brd' | 'spec' | 'runbook' | 'test' | 'other';

const SPEC = new Set(['TECH', 'FUNC', 'INTEG', 'ARCH', 'SECURITY', 'ENV']);
const RUNBOOK = new Set(['DEPLOY', 'OPS', 'PROCESS']);

export function shelfOf(code: string): Shelf {
  if (code === 'API') return 'api';
  if (code === 'BRD') return 'brd';
  if (SPEC.has(code)) return 'spec';
  if (RUNBOOK.has(code)) return 'runbook';
  if (code.startsWith('TEST_')) return 'test';
  return 'other';
}

/** BRDs are specs too in the filter. */
export function inFilter(code: string, f: KindFilter): boolean {
  if (f === 'all') return true;
  const s = shelfOf(code);
  return f === 'spec' ? s === 'spec' || s === 'brd' : s === f;
}

const CHIP: Record<string, string> = { PAGE: 'Guide', RELEASE: 'Notes', PROJECT: 'Doc', ARTIFACT: 'File' };
export function chipOf(code: string): string {
  const s = shelfOf(code);
  return s === 'api' ? 'API' : s === 'brd' ? 'BRD' : s === 'spec' ? 'Spec' : s === 'runbook' ? 'Runbook' : s === 'test' ? 'Test' : CHIP[code] ?? 'Doc';
}

/** A cover's eyebrow. */
export function coverLabel(code: string, typeName: string): string {
  const s = shelfOf(code);
  return s === 'api' ? 'API reference' : s === 'brd' ? 'BRD' : s === 'runbook' ? 'Runbook' : code === 'TEST_RESULTS' ? 'Test report' : code === 'TEST_PLAN' ? 'Test plan' : s === 'test' ? 'Test cases' : typeName.replace(/ documentation$/i, '');
}

export const KIND_FILTERS: { id: KindFilter; label: string }[] = [
  { id: 'all', label: 'All' }, { id: 'api', label: 'API docs' }, { id: 'spec', label: 'Specs' }, { id: 'runbook', label: 'Runbooks' }, { id: 'test', label: 'Tests' },
];

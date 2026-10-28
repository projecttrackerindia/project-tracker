/**
 * A page's look: a preset, its own CSS (checked and fenced in, see cssScope.ts), and how it moves. Stored with the page's text (the body's
 * `attrs.pageStyle`), so it is versioned, published and restored with it. Only the Style panel changes it (PUT /documents/{id}/style); the
 * server keeps it when the text is saved and drops any copy of it sent with the text.
 */
export const PRESETS = [
  { id: 'default', label: 'Default', hint: 'The Library look' },
  { id: 'editorial', label: 'Editorial', hint: 'Serif headings, generous reading width' },
  { id: 'product', label: 'Product', hint: 'Bold headings, cards for callouts and tables' },
  { id: 'minimal', label: 'Minimal', hint: 'Quiet, small headings, lots of air' },
  { id: 'dark-hero', label: 'Dark hero', hint: 'A dark banner opening the page' },
] as const;
export type PresetId = (typeof PRESETS)[number]['id'];

export const MOTIONS = [
  { id: 'none', label: 'None' }, { id: 'fade', label: 'Fade' }, { id: 'rise', label: 'Rise' },
  { id: 'scale', label: 'Scale' }, { id: 'slide', label: 'Slide' }, { id: 'stagger', label: 'Stagger children' },
] as const;
export type MotionId = (typeof MOTIONS)[number]['id'];
export const DELAYS = [0, 100, 200, 400] as const;
export const DURATIONS = [200, 400, 700] as const;
export const TRANSITIONS = [{ id: 'none', label: 'None' }, { id: 'line', label: 'Drawn line' }, { id: 'fade', label: 'Soft fade' }] as const;
export type TransitionId = (typeof TRANSITIONS)[number]['id'];

export interface PageStyle { preset: PresetId; css: string; animateSections: boolean; sectionTransition: TransitionId }
export const DEFAULT_STYLE: PageStyle = { preset: 'default', css: '', animateSections: false, sectionTransition: 'none' };

const isPreset = (v: unknown): v is PresetId => PRESETS.some((p) => p.id === v);
const isTransition = (v: unknown): v is TransitionId => TRANSITIONS.some((p) => p.id === v);
export const isMotion = (v: unknown): v is MotionId => MOTIONS.some((p) => p.id === v);

export function cleanStyle(raw: unknown): PageStyle {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    preset: isPreset(o.preset) ? o.preset : 'default',
    css: typeof o.css === 'string' ? o.css : '',
    animateSections: o.animateSections === true,
    sectionTransition: isTransition(o.sectionTransition) ? o.sectionTransition : 'none',
  };
}

/** The style kept with a body (editor JSON). */
export function styleOf(body: string | undefined | null): PageStyle {
  if (!body) return DEFAULT_STYLE;
  try { const d = JSON.parse(body) as { attrs?: { pageStyle?: unknown } }; return cleanStyle(d?.attrs?.pageStyle); } catch { return DEFAULT_STYLE; }
}

/** The body with this style put back on (the editor's own JSON never carries it). */
export function withStyle(body: string, style: PageStyle | null): string {
  try {
    const d = JSON.parse(body) as Record<string, unknown>;
    if (!style || isDefault(style)) { delete d.attrs; return JSON.stringify(d); }
    return JSON.stringify({ ...d, attrs: { ...(d.attrs as object), pageStyle: style } });
  } catch { return body; }
}

export const isDefault = (s: PageStyle) => s.preset === 'default' && !s.css.trim() && !s.animateSections && s.sectionTransition === 'none';
export const hasMotion = (s: PageStyle) => s.animateSections || s.sectionTransition !== 'none';

/** Workspace switches (Library settings): custom CSS and interactive embeds, both on unless an admin turned them off. */
export interface LibraryDesign { customCss: boolean; sandboxEmbeds: boolean; canManage: boolean }
export const DESIGN_DEFAULT: LibraryDesign = { customCss: true, sandboxEmbeds: true, canManage: false };

type Node = { type?: string; content?: Node[]; attrs?: Record<string, unknown> };
/**
 * "Make this page more visual": a look and motion picked from what the page holds (Groot's suggestion; nothing changes until applied).
 */
export function suggestVisual(body: string): { style: PageStyle; reasons: string[] } {
  let doc: Node = {};
  try { doc = JSON.parse(body) as Node; } catch { /* empty page */ }
  const count: Record<string, number> = {};
  const walk = (n: Node) => { if (n.type) count[n.type] = (count[n.type] ?? 0) + 1; n.content?.forEach(walk); };
  walk(doc);
  const tables = count.table ?? 0, code = count.codeBlock ?? 0, headings = count.heading ?? 0, callouts = count.callout ?? 0, paras = count.paragraph ?? 0;
  const reasons: string[] = [];
  let preset: PresetId = 'editorial';
  if (tables + code + callouts >= 2) { preset = 'product'; reasons.push(`${tables + code + callouts} tables, code blocks and callouts read best as cards`); }
  else if (headings <= 1 && paras <= 6) { preset = 'dark-hero'; reasons.push('A short page: a bold opening banner carries it'); }
  else reasons.push('Mostly prose: serif headings and a calm reading width');
  const animateSections = headings >= 2;
  if (animateSections) reasons.push(`${headings} sections rise in as you scroll`);
  const sectionTransition: TransitionId = headings >= 3 ? 'line' : 'none';
  if (sectionTransition === 'line') reasons.push('A drawn line marks each new section');
  return { style: { preset, css: '', animateSections, sectionTransition }, reasons };
}

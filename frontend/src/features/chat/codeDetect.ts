/**
 * Which parts of a chat message are code. People paste JSON payloads, stack traces, config and long tokens into chat; shown as
 * wrapped prose they turn into a wall of text (a huge green bubble), so those parts get a code block instead. Pure and small so it can
 * be tested without a DOM.
 */
export type Segment = { kind: 'text'; text: string; long?: boolean } | { kind: 'code'; text: string; lang?: string };

const FENCE_RE = /```([\w+#.-]*)[ \t]*\n?([\s\S]*?)```/g;
/** Prose longer than this (characters or lines) folds behind "Show more" too. */
export const LONG_TEXT_CHARS = 1200, LONG_TEXT_LINES = 20;

/** A JSON object or array, pretty-printed when it came as one long line. */
function asJson(t: string): string | null {
  if (!/^[[{]/.test(t) || !/[\]}]$/.test(t)) return null;
  try {
    const v: unknown = JSON.parse(t);
    if (typeof v !== 'object' || v === null) return null;
    return t.includes('\n') || t.length <= 80 ? t : JSON.stringify(v, null, 2);
  } catch { return null; }
}

/** Looks like code: several lines, most of them indented or ending/starting in code punctuation, or "key": value pairs. */
export function looksLikeCode(t: string): boolean {
  const lines = t.split('\n').filter((l) => l.trim());
  if (lines.length < 4) return false;
  const codey = lines.filter((l) => /^(\s{2,}|\t)/.test(l) || /[{}[\];(),=>]\s*$/.test(l.trim()) || /^\s*[}\])]/.test(l) || /^\s*"[^"]+"\s*:/.test(l)
    || /^\s*(const|let|var|function|def|class|import|export|return|if|for|while|public|private|SELECT|INSERT|UPDATE|<\/?[a-zA-Z])\b/.test(l)).length;
  return codey / lines.length >= 0.6;
}

/** One very long unbroken run (a token, base64, minified payload) that is not just a link. */
const longToken = (t: string) => t.length >= 200 && !/^https?:\/\/\S+$/.test(t) && (t.match(/\s/g)?.length ?? 0) / t.length < 0.02;

export function splitBody(body: string): Segment[] {
  if (body.includes('```')) {
    const out: Segment[] = [];
    let last = 0;
    for (const m of body.matchAll(FENCE_RE)) {
      const before = body.slice(last, m.index).replace(/\n$/, '');
      if (before.trim()) out.push({ kind: 'text', text: before });
      out.push({ kind: 'code', text: m[2].replace(/\n$/, ''), lang: m[1] || undefined });
      last = m.index! + m[0].length;
    }
    if (out.length) {
      const after = body.slice(last).replace(/^\n/, '');
      if (after.trim()) out.push({ kind: 'text', text: after });
      return out;
    }
  }
  const t = body.trim();
  const json = asJson(t);
  if (json) return [{ kind: 'code', text: json, lang: 'json' }];
  if (looksLikeCode(body) || longToken(t)) return [{ kind: 'code', text: body.replace(/^\n+|\s+$/g, '') }];
  const long = body.length > LONG_TEXT_CHARS || body.split('\n').length > LONG_TEXT_LINES;
  return [{ kind: 'text', text: body, long }];
}

/** The whole message is one code block (the bubble then only frames it). */
export const isCodeOnly = (body: string | null | undefined) => {
  if (!body) return false;
  const s = splitBody(body);
  return s.length === 1 && s[0].kind === 'code';
};

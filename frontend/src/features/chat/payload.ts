/**
 * Large payloads in Messages. A pasted JSON response, a log excerpt, an XML/CSV dump or simply a very long text is easier to read,
 * search and pass on as a file than as a wall of text in a bubble. These helpers decide when something is such a payload, name the file,
 * find and mask secrets in it, split a log into levels and compare two JSON documents. Pure (no DOM) so they can be tested.
 */
export type PayloadKind = 'json' | 'log' | 'xml' | 'csv' | 'text';

/** Plain text longer than this (characters or lines) is offered as a file. */
export const PAYLOAD_CHARS = 4000, PAYLOAD_LINES = 60;
/** JSON, logs, XML and CSV are offered as a file sooner: a short snippet stays a code block, anything bigger becomes a file. */
export const STRUCT_CHARS = 1200, STRUCT_LINES = 20;

export interface Payload { kind: PayloadKind; text: string; raw: string; bytes: number; lines: number }

export const KIND_LABEL: Record<PayloadKind, string> = { json: 'JSON', log: 'logs', xml: 'XML', csv: 'CSV', text: 'a long text' };
export const KIND_EXT: Record<PayloadKind, string> = { json: 'json', log: 'log', xml: 'xml', csv: 'csv', text: 'txt' };
export const KIND_MIME: Record<PayloadKind, string> = { json: 'application/json', log: 'text/plain', xml: 'application/xml', csv: 'text/csv', text: 'text/plain' };

const TS = /^\s*\[?(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}|\d{2}[-/]\d{2}[-/]\d{4}[ T]\d{2}:\d{2}|\d{2}:\d{2}:\d{2}[.,]\d{1,6}|[A-Z][a-z]{2} +\d{1,2} \d{2}:\d{2}:\d{2})/;
const LEVEL = /\b(FATAL|CRITICAL|ERROR|ERR|WARN|WARNING|INFO|DEBUG|TRACE)\b/;
const STACK = /^\s+at\s+\S|^\s*Caused by:|^\s*\.\.\. \d+ more|^[\w.$]+(Exception|Error)(:|$)|^Traceback \(most recent call last\)|^\s+File ".+", line \d+/;

export function parseJson(t: string): unknown {
  const s = t.trim();
  if (!/^[[{]/.test(s) || !/[\]}]$/.test(s)) return undefined;
  try { const v: unknown = JSON.parse(s); return typeof v === 'object' && v !== null ? v : undefined; } catch { return undefined; }
}

function looksLikeLog(lines: string[]): boolean {
  const real = lines.filter((l) => l.trim());
  if (real.length < 3) return false;
  const hits = real.filter((l) => TS.test(l) || STACK.test(l) || /^\s*\[?(FATAL|ERROR|WARN|WARNING|INFO|DEBUG|TRACE)\]?[\s:]/.test(l)).length;
  return hits / real.length >= 0.5;
}

function looksLikeXml(t: string): boolean {
  if (!/^<(\?xml|[A-Za-z][\w:.-]*)[\s>/]/.test(t) || !/>$/.test(t)) return false;
  return (t.match(/<\/[A-Za-z][\w:.-]*>|\/>/g)?.length ?? 0) >= 1;
}

function looksLikeCsv(lines: string[]): boolean {
  const real = lines.filter((l) => l.trim());
  if (real.length < 3) return false;
  for (const sep of [',', '\t', ';', '|']) {
    const n = (l: string) => l.split(sep).length - 1;
    const head = n(real[0]);
    if (head < 1) continue;
    if (real.filter((l) => n(l) === head).length / real.length >= 0.8 && !real.some((l) => /[{}]/.test(l[0] ?? ''))) return true;
  }
  return false;
}

/** What kind of text this is. */
export function kindOf(t: string): PayloadKind {
  const s = t.trim();
  if (parseJson(s) !== undefined) return 'json';
  if (looksLikeXml(s)) return 'xml';
  const lines = s.split('\n');
  if (looksLikeLog(lines)) return 'log';
  if (looksLikeCsv(lines)) return 'csv';
  return 'text';
}

/** JSON as people want to read it: indented (an already-indented document is kept as it came). */
export function prettyJson(t: string): string {
  const v = parseJson(t);
  if (v === undefined) return t;
  return t.trim().includes('\n') ? t.trim() : JSON.stringify(v, null, 2);
}

export const byteSize = (t: string) => new TextEncoder().encode(t).length;
export const lineCount = (t: string) => (t ? t.split('\n').length : 0);
export function sizeLabel(bytes: number) { return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} B`; }

/** The payload in this text, when it is big or structured enough to be better as a file; null for an ordinary message or a short snippet. */
export function detectPayload(input: string): Payload | null {
  const raw = input.replace(/\r\n?/g, '\n').replace(/^\n+|\s+$/g, '');
  if (!raw.trim()) return null;
  const kind = kindOf(raw);
  const text = kind === 'json' ? prettyJson(raw) : raw;
  const lines = lineCount(text);
  const big = raw.length > PAYLOAD_CHARS || lines > PAYLOAD_LINES;
  const structured = kind !== 'text' && (raw.length >= STRUCT_CHARS || lines >= STRUCT_LINES);
  if (!big && !structured) return null;
  return { kind, text, raw, bytes: byteSize(text), lines };
}

const pad = (n: number) => String(n).padStart(2, '0');
/** A short, file-safe form of the conversation or project name ("CRIF Integration" → "CRIF-Integration"). */
export function slug(name: string | null | undefined): string {
  const s = (name ?? '').replace(/^#/, '').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s.slice(0, 32).replace(/-+$/, '');
}

/** payload-CRIF-2026-10-27-1842.json, log-CRIF-….log, data-….csv, text-….txt */
export function payloadFileName(kind: PayloadKind, context: string | null | undefined, at: Date = new Date()): string {
  const prefix = kind === 'log' ? 'log' : kind === 'csv' ? 'data' : kind === 'text' ? 'text' : 'payload';
  const stamp = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}`;
  const s = slug(context);
  return `${prefix}${s ? `-${s}` : ''}-${stamp}.${KIND_EXT[kind]}`;
}

/** A name someone typed, made safe, keeping (or adding) the right extension. */
export function cleanFileName(name: string, kind: PayloadKind): string {
  const ext = KIND_EXT[kind];
  // eslint-disable-next-line no-control-regex -- control characters are exactly what a file name must not carry
  let n = name.trim().replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').replace(/\s+/g, ' ').slice(0, 120);
  if (!n || n === `.${ext}`) n = payloadFileName(kind, null);
  return /\.[A-Za-z0-9]{1,5}$/.test(n) ? n : `${n}.${ext}`;
}

/** The kind of a file by its name (and type), when it is one these views know. */
export function kindOfFile(fileName: string, contentType?: string): PayloadKind | null {
  const ext = /\.([A-Za-z0-9]+)$/.exec(fileName)?.[1]?.toLowerCase();
  if (ext === 'json' || ext === 'ndjson' || ext === 'har' || ext === 'geojson') return 'json';
  if (ext === 'log' || ext === 'out') return 'log';
  if (ext === 'xml' || ext === 'wsdl' || ext === 'xsd') return 'xml';
  if (ext === 'csv' || ext === 'tsv') return 'csv';
  if (ext === 'txt' || ext === 'text') return 'text';
  if (contentType === 'application/json') return 'json';
  if (contentType === 'application/xml' || contentType === 'text/xml') return 'xml';
  if (contentType === 'text/csv') return 'csv';
  return null;
}

// ---------------------------------------------------------------- secrets
const MASK = '••••••••';
const KEY_WORDS = 'password|passwd|pwd|passphrase|secret|client[_-]?secret|api[_-]?key|apikey|access[_-]?key|secret[_-]?key|private[_-]?key|token|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|session[_-]?id|x-api-key|cookie|set-cookie';
type Rule = { label: string; re: RegExp; keep: (m: string, ...g: string[]) => string };
const RULES: Rule[] = [
  { label: 'private key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, keep: () => `-----BEGIN PRIVATE KEY-----${MASK}-----END PRIVATE KEY-----` },
  // Authorization: Bearer abc… / "authorization": "Basic abc…"
  { label: 'Authorization header', re: /(["']?(?:proxy-)?authorization["']?\s*[:=]\s*["']?(?:(?:bearer|basic|token|digest|apikey)\s+)?)([^\s"',;}<]{4,})/gi, keep: (_m, a) => `${a}${MASK}` },
  // XML elements: <password>…</password>
  { label: 'password or token field', re: new RegExp(`(<([\\w:.-]*(?:${KEY_WORDS})[\\w.-]*)(?:\\s[^>]*)?>)([^<]{3,})(</\\2>)`, 'gi'), keep: (_m, a, _tag, _v, end) => `${a}${MASK}${end}` },
  // "password": "x", password=x, api_key: x (JSON, query strings, headers, .env, YAML)
  { label: 'password or token field', re: new RegExp(`((?:["'])?[\\w.-]*(?:${KEY_WORDS})(?:["'])?\\s*[:=]\\s*(?:["'])?)(?!null\\b|true\\b|false\\b|\\$\\{|<)([^\\s"',;&}<]{3,})`, 'gi'), keep: (_m, a) => `${a}${MASK}` },
  { label: 'JWT', re: /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{6,}/g, keep: () => MASK },
  { label: 'AWS access key', re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, keep: () => MASK },
  { label: 'API key', re: /\b(sk|pk|rk)_(live|test)_[0-9A-Za-z]{10,}\b|\bgh[pousr]_[0-9A-Za-z]{30,}\b|\bxox[abpr]-[0-9A-Za-z-]{10,}\b|\bAIza[0-9A-Za-z_-]{30,}\b/g, keep: () => MASK },
];

/** What looks like a secret in this text (header names, password/token fields, keys), each kind once. */
export function findSecrets(text: string): string[] {
  const found = new Set<string>();
  for (const r of RULES) { r.re.lastIndex = 0; if (r.re.test(text)) found.add(r.label); r.re.lastIndex = 0; }
  return [...found];
}

/** The text with every secret-looking value replaced by ••••••••; the field names stay so the shape still reads. */
export function maskSecrets(text: string): string {
  let out = text;
  for (const r of RULES) out = out.replace(r.re, (...args) => r.keep(...(args.slice(0, -2) as [string, ...string[]])));
  return out;
}

// ---------------------------------------------------------------- logs
export type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'other';
export interface LogLine { n: number; text: string; level: LogLevel }
const norm = (l: string): LogLevel => (/^(FATAL|CRITICAL|ERROR|ERR)$/.test(l) ? 'error' : /^WARN/.test(l) ? 'warn' : l === 'INFO' ? 'info' : 'debug');

/** Each line with its level; a stack trace or continuation line takes the level of the line it belongs to. */
export function parseLog(text: string): LogLine[] {
  let last: LogLevel = 'other';
  return text.split('\n').map((t, i) => {
    const m = LEVEL.exec(t.slice(0, 160));
    let level: LogLevel;
    if (m && (TS.test(t) || /^\s*\[?[A-Z]+\]?[\s:]/.test(t) || t.indexOf(m[1]) < 60)) level = norm(m[1]);
    else if (STACK.test(t)) level = last === 'other' ? 'error' : last;
    else if (/^\s/.test(t) && t.trim()) level = last;
    else level = TS.test(t) ? 'info' : 'other';
    last = level;
    return { n: i + 1, text: t, level };
  });
}

// ---------------------------------------------------------------- JSON paths and diff
const IDENT = /^[A-Za-z_$][\w$]*$/;
export const childPath = (parent: string, key: string | number) =>
  typeof key === 'number' ? `${parent}[${key}]` : IDENT.test(key) ? `${parent}.${key}` : `${parent}[${JSON.stringify(key)}]`;

export type JsonChange = { path: string; kind: 'added' | 'removed' | 'changed'; before?: unknown; after?: unknown };
/** Every place the second document differs from the first (by path), at most `limit` of them. */
export function diffJson(a: unknown, b: unknown, path = '$', out: JsonChange[] = [], limit = 500): JsonChange[] {
  if (out.length >= limit) return out;
  const obj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
  if (obj(a) && obj(b) && Array.isArray(a) === Array.isArray(b)) {
    const keys = Array.isArray(a) ? [...Array(Math.max(a.length, (b as unknown as unknown[]).length)).keys()] : [...new Set([...Object.keys(a), ...Object.keys(b)])];
    for (const k of keys) {
      const p = childPath(path, k);
      const inA = Array.isArray(a) ? (k as number) < a.length : Object.prototype.hasOwnProperty.call(a, k);
      const inB = Array.isArray(b) ? (k as number) < (b as unknown[]).length : Object.prototype.hasOwnProperty.call(b, k);
      const va = (a as Record<string | number, unknown>)[k], vb = (b as Record<string | number, unknown>)[k];
      if (inA && !inB) out.push({ path: p, kind: 'removed', before: va });
      else if (!inA && inB) out.push({ path: p, kind: 'added', after: vb });
      else diffJson(va, vb, p, out, limit);
      if (out.length >= limit) break;
    }
    return out;
  }
  if (JSON.stringify(a) !== JSON.stringify(b)) out.push({ path, kind: 'changed', before: a, after: b });
  return out;
}

/** A simple CSV reader (quoted fields, "" escapes) for the table view; the separator is the one the header uses most. */
export function parseCsv(text: string, maxRows = 500): string[][] {
  const first = text.split('\n', 1)[0];
  const sep = [',', '\t', ';', '|'].sort((x, y) => first.split(y).length - first.split(x).length)[0];
  const rows: string[][] = [];
  let row: string[] = [], cell = '', q = false;
  for (let i = 0; i < text.length && rows.length < maxRows; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; }
    else if (c === '"' && !cell) q = true;
    else if (c === sep) { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if ((cell || row.length) && rows.length < maxRows) { row.push(cell); rows.push(row); }
  return rows;
}

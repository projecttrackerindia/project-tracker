import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { chatApi } from '../../api/endpoints';
import type { ChatAttachment } from '../../api/types';
import { Icon } from '../../components/Icon';
import { Spinner } from '../../components/ui';
import { toast } from '../../stores/ui';
import { useAi, useAssistant } from '../ai/Assistant';
import {
  childPath, diffJson, findSecrets, KIND_EXT, KIND_LABEL, KIND_MIME, kindOf, kindOfFile, lineCount, maskSecrets, parseCsv, parseJson, parseLog,
  payloadFileName, prettyJson, sizeLabel, type JsonChange, type LogLevel, type PayloadKind,
} from './payload';
import '../../styles/payload.css';

/** Files bigger than this download but are not previewed (reading them would cost more than it helps). */
const PREVIEW_MAX_BYTES = 5 * 1024 * 1024;
const PREVIEW_LINES = 6;

const KIND_BADGE: Record<PayloadKind, string> = { json: '{ }', log: 'LOG', xml: '</>', csv: 'CSV', text: 'TXT' };
export function PayloadIcon({ kind }: { kind: PayloadKind }) {
  return <span className={`pl-icon k-${kind}`} aria-hidden="true">{KIND_BADGE[kind]}</span>;
}

// ---------------------------------------------------------------- syntax colouring (small and dependency-free)
const JSON_TOKEN = /("(?:[^"\\]|\\.)*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
const XML_TOKEN = /(<\/?)([\w:.-]+)|([\w:.-]+)(=)("[^"]*"|'[^']*')|(\/?>)|(<!--.*?-->)/g;
const LOG_TOKEN = /^(\s*\[?\d{4}-\d{2}-\d{2}[T ][\d:.,]+Z?\]?|\s*\[?\d{2}:\d{2}:\d{2}[.,]\d+\]?)|\b(FATAL|CRITICAL|ERROR|ERR|WARN(?:ING)?|INFO|DEBUG|TRACE)\b|("(?:[^"\\]|\\.)*")/g;

function tokens(line: string, re: RegExp, cls: (m: RegExpExecArray) => [string, string][]): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0, k = 0;
  re.lastIndex = 0;
  for (let m = re.exec(line); m; m = re.exec(line)) {
    if (m[0] === '') { re.lastIndex++; continue; }
    if (m.index > last) out.push(line.slice(last, m.index));
    for (const [text, c] of cls(m)) out.push(c ? <span key={k++} className={c}>{text}</span> : text);
    last = m.index + m[0].length;
  }
  if (last < line.length) out.push(line.slice(last));
  return out;
}

export function highlightLine(line: string, kind: PayloadKind): ReactNode {
  if (kind === 'json') return tokens(line, JSON_TOKEN, (m) => (m[1] ? (m[2] ? [[m[1], 'hl-key'], [m[2], '']] : [[m[1], 'hl-str']]) : m[3] ? [[m[3], 'hl-lit']] : [[m[4], 'hl-num']]));
  if (kind === 'xml') return tokens(line, XML_TOKEN, (m) => (m[2] ? [[m[1], 'hl-punc'], [m[2], 'hl-tag']] : m[3] ? [[m[3], 'hl-key'], [m[4], ''], [m[5], 'hl-str']] : m[6] ? [[m[6], 'hl-punc']] : [[m[7], 'hl-com']]));
  if (kind === 'log') return tokens(line, LOG_TOKEN, (m) => (m[1] ? [[m[1], 'hl-time']] : m[2] ? [[m[2], `hl-lvl l-${/^(FATAL|CRITICAL|ERROR|ERR)$/.test(m[2]) ? 'error' : /^WARN/.test(m[2]) ? 'warn' : m[2] === 'INFO' ? 'info' : 'debug'}`]] : [[m[3], 'hl-str']]));
  if (kind === 'csv') return line.split(',').flatMap((c, i) => (i ? [<span key={`s${i}`} className="hl-punc">,</span>, c] : [c]));
  return line;
}

function download(name: string, text: string, kind: PayloadKind) {
  const url = URL.createObjectURL(new Blob([text], { type: KIND_MIME[kind] }));
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
const copyText = (t: string, what = 'Copied.') => { void navigator.clipboard?.writeText(t).then(() => toast(what)).catch(() => toast('Could not copy.', 'error')); };

/** A few lines, coloured, with line numbers (the card preview and the raw view). */
function Lines({ lines, kind, from = 1, wrap = false, mark }: { lines: string[]; kind: PayloadKind; from?: number; wrap?: boolean; mark?: string }) {
  return (
    <pre className={`pl-lines${wrap ? ' wrap' : ''}`}>
      {lines.map((l, i) => (
        <div key={i} className={`pl-line${mark && l.toLowerCase().includes(mark) ? ' hit' : ''}`}><span className="pl-n" aria-hidden="true">{from + i}</span><code>{highlightLine(l, kind) || ' '}</code></div>
      ))}
    </pre>
  );
}

// ---------------------------------------------------------------- the suggestion above the composer
export interface PayloadDraft { kind: PayloadKind; text: string; raw: string; bytes: number; lines: number; name: string; secrets: string[]; mask: boolean; caption: string }

/** "This looks like JSON (12 KB, 340 lines) — send it as a file?" with the name to edit, the preview and the secrets warning. */
export function PayloadSuggestion({ draft, busy, canText, onChange, onFile, onText, onVault, onDismiss }: {
  draft: PayloadDraft; busy: boolean; canText: boolean;
  onChange: (d: PayloadDraft) => void; onFile: () => void; onText: () => void; onVault: () => void; onDismiss: () => void;
}) {
  const shown = draft.mask ? maskSecrets(draft.text) : draft.text;
  const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
  return (
    <div className="pl-suggest" role="region" aria-label="Send as a file?" data-testid="payload-suggest"
      onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || (e.target as HTMLElement).tagName === 'INPUT')) { e.preventDefault(); onFile(); } else if (e.key === 'Escape') { e.stopPropagation(); onDismiss(); } }}>
      <div className="pl-suggest-head">
        <PayloadIcon kind={draft.kind} />
        <p><b>This looks like {KIND_LABEL[draft.kind]}</b> ({sizeLabel(draft.bytes)}, {draft.lines.toLocaleString()} lines) — send it as a file?</p>
        <button type="button" className="btn-icon sm" onClick={onDismiss} aria-label="Discard the pasted text" title="Discard"><Icon name="close" size={13} /></button>
      </div>
      <label className="pl-name">
        <span>File name</span>
        <input value={draft.name} onChange={(e) => onChange({ ...draft, name: e.target.value })} aria-label="File name" spellCheck={false} />
      </label>
      <Lines lines={shown.split('\n').slice(0, PREVIEW_LINES)} kind={draft.kind} />
      {draft.secrets.length > 0 && (
        <div className="pl-secrets" role="alert">
          <Icon name="shield" size={14} />
          <span><b>Contains possible secrets</b> ({draft.secrets.join(', ')}).</span>
          <label><input type="checkbox" checked={draft.mask} onChange={(e) => onChange({ ...draft, mask: e.target.checked })} /> Mask them</label>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onVault}><Icon name="lock" size={13} />Send to Vault instead</button>
        </div>
      )}
      <div className="pl-suggest-foot">
        <span className="pl-hint">{draft.caption ? `Caption: “${draft.caption.slice(0, 60)}${draft.caption.length > 60 ? '…' : ''}”` : 'Text you type in the box goes with it as a caption.'}</span>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onText} disabled={busy || !canText} title={canText ? 'Send it in the message itself' : 'Too long for a message'}>Send as text</button>
        <button type="button" className="btn btn-primary btn-sm" onClick={onFile} disabled={busy} data-testid="payload-send-file">
          {busy ? <Spinner /> : <Icon name="paperclip" size={13} />}Send as file<kbd>{mac ? '⌘↵' : 'Ctrl+↵'}</kbd>
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- the file card in the thread
/** A payload file in a message: its kind, name, size and lines, the first lines coloured, and Download / Open / Copy. */
export function PayloadFileCard({ file, onDownload }: { file: ChatAttachment; onDownload: () => void }) {
  const kind = kindOfFile(file.fileName, file.contentType) ?? 'text';
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const tooBig = file.sizeBytes > PREVIEW_MAX_BYTES;
  useEffect(() => {
    if (tooBig) return;
    let live = true;
    chatApi.fileText(file.id).then((t) => { if (live) setText(t); }).catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [file.id, tooBig]);
  const shown = useMemo(() => (text === null ? null : kind === 'json' ? prettyJson(text) : text), [text, kind]);
  const preview = useMemo(() => (shown === null ? [] : maskSecrets(shown.split('\n').slice(0, PREVIEW_LINES).join('\n')).split('\n')), [shown]);
  return (
    <div className="pl-card" data-testid="payload-card">
      <div className="pl-card-head">
        <PayloadIcon kind={kind} />
        <span className="pl-card-meta"><b title={file.fileName}>{file.fileName}</b><em>{sizeLabel(file.sizeBytes)}{shown !== null ? ` · ${lineCount(shown).toLocaleString()} lines` : ''}</em></span>
      </div>
      {shown !== null ? <button type="button" className="pl-card-preview" onClick={() => setOpen(true)} aria-label={`Open ${file.fileName}`}><Lines lines={preview} kind={kind} /></button>
        : !tooBig && !failed ? <div className="pl-card-wait"><Spinner /></div>
        : <div className="pl-card-wait">{tooBig ? 'Too big to preview — download it.' : 'Preview not available.'}</div>}
      <div className="pl-card-actions">
        <button type="button" onClick={onDownload}><Icon name="download" size={13} />Download</button>
        <button type="button" onClick={() => setOpen(true)} disabled={shown === null} data-testid="payload-open"><Icon name="eye" size={13} />Open</button>
        <button type="button" onClick={() => shown !== null && copyText(shown)} disabled={shown === null}><Icon name="copy" size={13} />Copy</button>
      </div>
      {open && shown !== null && <PayloadViewer name={file.fileName} text={shown} kind={kind} bytes={file.sizeBytes} onClose={() => setOpen(false)} onDownload={onDownload} />}
    </div>
  );
}

/** For a long JSON/log message already in the history (sent as text before this existed): Open in the viewer, or Save as file. */
export function CodePayloadActions({ code, lang }: { code: string; lang?: string }) {
  const [open, setOpen] = useState(false);
  const kind: PayloadKind = lang === 'json' || parseJson(code) !== undefined ? 'json' : kindOf(code);
  const name = useMemo(() => payloadFileName(kind, 'message'), [kind]);
  const text = kind === 'json' ? prettyJson(code) : code;
  return (
    <>
      <button type="button" className="msg-code-copy" onClick={() => setOpen(true)} title="Open in the viewer"><Icon name="eye" size={13} />Open</button>
      <button type="button" className="msg-code-copy" onClick={() => download(name, text, kind)} title="Save it as a file"><Icon name="download" size={13} />Save as file</button>
      {open && <PayloadViewer name={name} text={text} kind={kind} bytes={new TextEncoder().encode(text).length} onClose={() => setOpen(false)} onDownload={() => download(name, text, kind)} />}
    </>
  );
}

// ---------------------------------------------------------------- the full-screen viewer
type JsonVal = unknown;
const isObj = (v: JsonVal): v is Record<string, JsonVal> => typeof v === 'object' && v !== null;

/** Paths whose subtree contains the query (so search opens just the branches that matter). */
function matchPaths(v: JsonVal, q: string, path = '$', key = '', out = new Set<string>()): boolean {
  let hit = !!q && key.toLowerCase().includes(q);
  if (isObj(v)) for (const [k, c] of Object.entries(v)) { if (matchPaths(c, q, childPath(path, Array.isArray(v) ? Number(k) : k), k, out)) hit = true; }
  else if (q && String(v).toLowerCase().includes(q)) hit = true;
  if (hit) out.add(path);
  return hit;
}

function JsonNode({ k, v, path, depth, q, hits, expandAll }: { k: string | number | null; v: JsonVal; path: string; depth: number; q: string; hits: Set<string>; expandAll: number }) {
  const [open, setOpen] = useState(depth < 2);
  const [limit, setLimit] = useState(200);
  useEffect(() => { if (expandAll) setOpen(expandAll > 0); }, [expandAll]);
  useEffect(() => { if (q && hits.has(path)) setOpen(true); }, [q, hits, path]);
  const keyHit = q && k !== null && String(k).toLowerCase().includes(q);
  const keyEl = k === null ? null : (
    <button type="button" className={`pl-jkey${keyHit ? ' hit' : ''}`} title={`Copy path ${path}`} onClick={() => copyText(path, `Copied ${path}`)}>
      {typeof k === 'number' ? k : JSON.stringify(k)}<span className="hl-punc">:</span>
    </button>
  );
  if (!isObj(v)) {
    const s = JSON.stringify(v);
    const c = typeof v === 'string' ? 'hl-str' : typeof v === 'number' ? 'hl-num' : 'hl-lit';
    return <div className="pl-jrow" style={{ paddingLeft: depth * 16 + 18 }}>{keyEl} <span className={`${c}${q && String(v).toLowerCase().includes(q) ? ' hit' : ''}`}>{s}</span></div>;
  }
  const entries = Object.entries(v);
  const arr = Array.isArray(v);
  return (
    <>
      <div className="pl-jrow" style={{ paddingLeft: depth * 16 }}>
        <button type="button" className="pl-jtoggle" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label={open ? 'Collapse' : 'Expand'}><Icon name={open ? 'chevronD' : 'chevronR'} size={12} /></button>
        {keyEl} <span className="hl-punc">{arr ? '[' : '{'}</span>{!open && <><button type="button" className="pl-jmore" onClick={() => setOpen(true)}>{entries.length} {arr ? (entries.length === 1 ? 'item' : 'items') : (entries.length === 1 ? 'key' : 'keys')}</button><span className="hl-punc">{arr ? ']' : '}'}</span></>}
      </div>
      {open && <>
        {entries.slice(0, limit).map(([ck, cv]) => { const p = childPath(path, arr ? Number(ck) : ck); return !q || hits.has(p) ? <JsonNode key={ck} k={arr ? Number(ck) : ck} v={cv} path={p} depth={depth + 1} q={q} hits={hits} expandAll={expandAll} /> : null; })}
        {entries.length > limit && <div className="pl-jrow" style={{ paddingLeft: (depth + 1) * 16 + 18 }}><button type="button" className="pl-jmore" onClick={() => setLimit((l) => l + 500)}>Show {Math.min(500, entries.length - limit)} more of {entries.length - limit}</button></div>}
        <div className="pl-jrow" style={{ paddingLeft: depth * 16 + 18 }}><span className="hl-punc">{arr ? ']' : '}'}</span></div>
      </>}
    </>
  );
}

const LEVELS: { id: LogLevel | 'all'; label: string }[] = [{ id: 'all', label: 'All' }, { id: 'error', label: 'Errors' }, { id: 'warn', label: 'Warnings' }, { id: 'info', label: 'Info' }, { id: 'debug', label: 'Debug' }];

function LogView({ text, q, wrap }: { text: string; q: string; wrap: boolean }) {
  const all = useMemo(() => parseLog(text), [text]);
  const [level, setLevel] = useState<LogLevel | 'all'>('all');
  const counts = useMemo(() => all.reduce<Record<string, number>>((c, l) => { c[l.level] = (c[l.level] ?? 0) + 1; return c; }, {}), [all]);
  const shown = all.filter((l) => (level === 'all' || l.level === level) && (!q || l.text.toLowerCase().includes(q))).slice(0, 5000);
  return (
    <>
      <div className="pl-levels" role="group" aria-label="Filter by level">
        {LEVELS.map((l) => (
          <button key={l.id} type="button" className={`pl-chip l-${l.id}${level === l.id ? ' on' : ''}`} aria-pressed={level === l.id} onClick={() => setLevel(l.id)}>
            {l.label}<em>{l.id === 'all' ? all.length : counts[l.id] ?? 0}</em>
          </button>
        ))}
      </div>
      <pre className={`pl-lines log${wrap ? ' wrap' : ''}`}>
        {shown.map((l) => <div key={l.n} className={`pl-line lv-${l.level}`}><span className="pl-n" aria-hidden="true">{l.n}</span><code>{highlightLine(l.text, 'log') || ' '}</code></div>)}
        {!shown.length && <div className="pl-empty">No lines match.</div>}
      </pre>
    </>
  );
}

function CsvTable({ text, q }: { text: string; q: string }) {
  const rows = useMemo(() => parseCsv(text), [text]);
  const [head, ...body] = rows;
  const shown = q ? body.filter((r) => r.some((c) => c.toLowerCase().includes(q))) : body;
  return (
    <div className="pl-table-wrap">
      <table className="pl-table">
        <thead><tr><th>#</th>{head?.map((h, i) => <th key={i}>{h}</th>)}</tr></thead>
        <tbody>{shown.map((r, i) => <tr key={i}><td className="pl-n">{body.indexOf(r) + 2}</td>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

function DiffPanel({ base, onClose }: { base: JsonVal; onClose: () => void }) {
  const [other, setOther] = useState('');
  const pick = useRef<HTMLInputElement>(null);
  const parsed = other.trim() ? parseJson(other) : undefined;
  const changes: JsonChange[] | null = parsed === undefined ? null : diffJson(base, parsed);
  const fmt = (v: unknown) => { const s = JSON.stringify(v); return s.length > 120 ? `${s.slice(0, 117)}…` : s; };
  return (
    <div className="pl-diff" data-testid="payload-diff">
      <div className="pl-diff-head">
        <b>Compare with another JSON</b>
        <input ref={pick} type="file" accept=".json,application/json" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void f.text().then(setOther); e.target.value = ''; }} />
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => pick.current?.click()}><Icon name="upload" size={13} />Choose a file</button>
        <button type="button" className="btn-icon sm" onClick={onClose} aria-label="Close compare"><Icon name="close" size={13} /></button>
      </div>
      <textarea value={other} onChange={(e) => setOther(e.target.value)} placeholder="Paste the other JSON here (e.g. the UAT response next to this production one)" aria-label="The other JSON" spellCheck={false} />
      {other.trim() && changes === null && <p className="pl-diff-note">That is not valid JSON yet.</p>}
      {changes && (changes.length === 0 ? <p className="pl-diff-note">They are the same.</p> : (
        <ul className="pl-diff-list">
          <li className="pl-diff-note">{changes.length}{changes.length >= 500 ? '+' : ''} {changes.length === 1 ? 'difference' : 'differences'}</li>
          {changes.map((c) => (
            <li key={`${c.kind}${c.path}`} className={`d-${c.kind}`}>
              <button type="button" className="pl-jkey" onClick={() => copyText(c.path, `Copied ${c.path}`)} title="Copy path">{c.path}</button>
              {c.kind === 'changed' ? <><del>{fmt(c.before)}</del> → <ins>{fmt(c.after)}</ins></> : c.kind === 'added' ? <ins>+ {fmt(c.after)}</ins> : <del>− {fmt(c.before)}</del>}
            </li>
          ))}
        </ul>
      ))}
    </div>
  );
}

/** Full screen: a JSON tree (collapse, expand, search, copy a path), a log view (levels, filter, line numbers, wrap), a CSV table, or the raw text. */
export function PayloadViewer({ name, text, kind, bytes, onClose, onDownload }: { name: string; text: string; kind: PayloadKind; bytes: number; onClose: () => void; onDownload: () => void }) {
  const secrets = useMemo(() => findSecrets(text), [text]);
  const [hide, setHide] = useState(true);
  const body = hide && secrets.length ? maskSecrets(text) : text;
  const json = useMemo(() => (kind === 'json' ? parseJson(body) : undefined), [kind, body]);
  const [mode, setMode] = useState<'tree' | 'table' | 'raw'>(kind === 'json' && json !== undefined ? 'tree' : kind === 'csv' ? 'table' : 'raw');
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const [wrap, setWrap] = useState(kind === 'log' || kind === 'text');
  const [expandAll, setExpandAll] = useState(0);
  const [diff, setDiff] = useState(false);
  const hits = useMemo(() => { const s = new Set<string>(); if (q && json !== undefined) matchPaths(json, q, '$', '', s); return s; }, [json, q]);
  const ai = useAi();
  const askAi = useAssistant((s) => s.ask);
  const search = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
      else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); search.current?.focus(); }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [onClose]);
  const lines = useMemo(() => body.split('\n'), [body]);
  const rawShown = q ? lines.map((l, i) => [l, i] as const).filter(([l]) => l.toLowerCase().includes(q)) : null;
  const ask = () => {
    const excerpt = maskSecrets(text).slice(0, 3000);
    onClose();
    askAi(`Explain this ${KIND_LABEL[kind]} payload (${name}): what it is, anything that looks wrong (errors, nulls, failed statuses), and what to check next.\n\n${excerpt}${text.length > 3000 ? '\n…(truncated)' : ''}`);
  };
  return createPortal(
    <div className="pl-viewer" role="dialog" aria-modal="true" aria-label={name} data-testid="payload-viewer">
      <header className="pl-vhead">
        <PayloadIcon kind={kind} />
        <div className="pl-vtitle"><b title={name}>{name}</b><em>{sizeLabel(bytes)} · {lines.length.toLocaleString()} lines · {KIND_EXT[kind].toUpperCase()}</em></div>
        <div className="pl-vtools">
          {kind === 'json' && json !== undefined && (
            <div className="pl-seg" role="tablist" aria-label="View">
              <button type="button" role="tab" aria-selected={mode === 'tree'} onClick={() => setMode('tree')}>Tree</button>
              <button type="button" role="tab" aria-selected={mode === 'raw'} onClick={() => setMode('raw')}>Raw</button>
            </div>
          )}
          {kind === 'csv' && (
            <div className="pl-seg" role="tablist" aria-label="View">
              <button type="button" role="tab" aria-selected={mode === 'table'} onClick={() => setMode('table')}>Table</button>
              <button type="button" role="tab" aria-selected={mode === 'raw'} onClick={() => setMode('raw')}>Raw</button>
            </div>
          )}
          <label className="pl-search"><Icon name="search" size={13} /><input ref={search} value={query} onChange={(e) => setQuery(e.target.value)} placeholder={mode === 'tree' ? 'Search keys and values' : 'Filter lines'} aria-label="Search" /></label>
          {mode === 'tree' && <>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setExpandAll((n) => Math.abs(n) + 1)}>Expand all</button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setExpandAll((n) => -(Math.abs(n) + 1))}>Collapse</button>
          </>}
          {mode !== 'tree' && mode !== 'table' && <button type="button" className={`btn btn-ghost btn-sm${wrap ? ' on' : ''}`} aria-pressed={wrap} onClick={() => setWrap((w) => !w)}>Wrap</button>}
          {kind === 'json' && json !== undefined && <button type="button" className={`btn btn-ghost btn-sm${diff ? ' on' : ''}`} aria-pressed={diff} onClick={() => setDiff((d) => !d)}>Compare</button>}
          {ai && <button type="button" className="btn btn-ghost btn-sm" onClick={ask}><Icon name="sparkle" size={13} />Ask AI</button>}
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => copyText(body)}><Icon name="copy" size={13} />Copy</button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onDownload}><Icon name="download" size={13} />Download</button>
          <button type="button" className="btn-icon" onClick={onClose} aria-label="Close the viewer"><Icon name="close" size={16} /></button>
        </div>
      </header>
      {secrets.length > 0 && (
        <div className="pl-secrets in-viewer"><Icon name="shield" size={14} /><span><b>Contains possible secrets</b> ({secrets.join(', ')}). {hide ? 'They are masked here.' : 'Shown in full.'}</span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setHide((h) => !h)}>{hide ? 'Reveal' : 'Mask'}</button></div>
      )}
      <div className="pl-vbody">
        {diff && json !== undefined && <DiffPanel base={json} onClose={() => setDiff(false)} />}
        <div className="pl-vmain">
          {mode === 'tree' && json !== undefined
            ? <div className="pl-tree" role="tree" aria-label="JSON">{q && !hits.size ? <div className="pl-empty">Nothing matches “{query}”.</div> : <JsonNode k={null} v={json} path="$" depth={0} q={q} hits={hits} expandAll={expandAll} />}<p className="pl-tip">Click a key to copy its path.</p></div>
            : kind === 'log' ? <LogView text={body} q={q} wrap={wrap} />
            : mode === 'table' ? <CsvTable text={body} q={q} />
            : rawShown ? (
              <pre className={`pl-lines${wrap ? ' wrap' : ''}`}>{rawShown.map(([l, i]) => <div key={i} className="pl-line hit"><span className="pl-n" aria-hidden="true">{i + 1}</span><code>{highlightLine(l, kind) || ' '}</code></div>)}{!rawShown.length && <div className="pl-empty">No lines match.</div>}</pre>
            ) : <Lines lines={lines.slice(0, 20000)} kind={kind} wrap={wrap} />}
        </div>
      </div>
    </div>,
    document.body,
  );
}

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Extension, mergeAttributes, Node, type Editor } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react';
import { fetchBlobUrl, fetchText } from '../../../api/client';
import { DocumentIdContext } from '../DocImage';
import { checkSandbox, clampHeight, frameAttrs, LIMITS, lottieMessage, sandboxMessage } from './sandbox';
import { cleanSvg, svgDataUrl } from './svgClean';
import { DELAYS, DURATIONS, MOTIONS, isMotion } from './pageStyle';
import './motion.css';

/** What the page tells its motion blocks: paused by the reader, and whether the workspace allows interactive embeds. */
export interface MotionState { paused: boolean; sandboxEnabled: boolean }
export const MotionContext = createContext<MotionState>({ paused: false, sandboxEnabled: true });

/** The block types that can move on scroll (top-level blocks and the motion blocks). */
export const MOTION_TYPES = ['paragraph', 'heading', 'blockquote', 'callout', 'codeBlock', 'table', 'bulletList', 'orderedList', 'taskList', 'docImage', 'details', 'horizontalRule',
  'motionLottie', 'motionSvg', 'motionVideo', 'sandboxEmbed'];

const reduced = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** Motion as attributes of a block: data-motion="rise" data-motion-delay="200" data-motion-duration="400". Stored as data, checked on the server. */
export const MotionAttrs = Extension.create({
  name: 'motionAttrs',
  addGlobalAttributes() {
    return [{
      types: MOTION_TYPES,
      attributes: {
        motion: { default: null, parseHTML: (el) => (isMotion(el.getAttribute('data-motion')) ? el.getAttribute('data-motion') : null),
          renderHTML: (a) => (a.motion && a.motion !== 'none' ? { 'data-motion': a.motion } : {}) },
        motionDelay: { default: 0, parseHTML: (el) => Number(el.getAttribute('data-motion-delay')) || 0,
          renderHTML: (a) => (a.motion && a.motion !== 'none' && a.motionDelay ? { 'data-motion-delay': String(a.motionDelay) } : {}) },
        motionDuration: { default: 400, parseHTML: (el) => Number(el.getAttribute('data-motion-duration')) || 400,
          renderHTML: (a) => (a.motion && a.motion !== 'none' && a.motionDuration !== 400 ? { 'data-motion-duration': String(a.motionDuration) } : {}) },
      },
    }];
  },
});

/** The wrapper of a motion block: its motion attributes, and the guard that keeps the page's own CSS out of it. */
const viewAttrs = ({ HTMLAttributes }: { HTMLAttributes: Record<string, unknown> }) => {
  const out: Record<string, string> = { 'data-embed-guard': '' };
  for (const k of ['data-motion', 'data-motion-delay', 'data-motion-duration']) if (HTMLAttributes[k] != null) out[k] = String(HTMLAttributes[k]);
  return out;
};

/** Sets the motion of the top-level block(s) the selection is in. */
export function setBlockMotion(editor: Editor, patch: { motion?: string; motionDelay?: number; motionDuration?: number }) {
  const { state } = editor;
  const { from, to } = state.selection;
  const tr = state.tr;
  state.doc.forEach((node, offset) => {
    const end = offset + node.nodeSize;
    const hit = from === to ? offset <= from && from <= end : end > from && offset < to;
    if (!hit || !node.type.spec.attrs || !('motion' in node.type.spec.attrs)) return;
    tr.setNodeMarkup(offset, undefined, { ...node.attrs, ...patch });
  });
  if (tr.docChanged) editor.view.dispatch(tr);
}

/** The motion of the block the selection starts in. */
export function blockMotionAt(editor: Editor): { motion: string; motionDelay: number; motionDuration: number } {
  const $from = editor.state.selection.$from;
  const top = $from.depth >= 1 ? $from.node(1) : editor.state.doc.nodeAt($from.pos);
  return { motion: String(top?.attrs.motion ?? 'none'), motionDelay: Number(top?.attrs.motionDelay ?? 0), motionDuration: Number(top?.attrs.motionDuration ?? 400) };
}

/** The Motion menu over a selected block (in the bar over selected text). */
export function MotionMenu({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const [m, setM] = useState(() => blockMotionAt(editor));
  const set = (patch: Partial<typeof m>) => { const next = { ...m, ...patch }; setM(next); setBlockMotion(editor, next); };
  return (
    <div className="mo-menu" role="dialog" aria-label="Motion of this block" onMouseDown={(e) => e.preventDefault()}>
      <div className="mo-menu-row" role="radiogroup" aria-label="Motion">
        {MOTIONS.map((x) => <button key={x.id} type="button" role="radio" aria-checked={m.motion === x.id} className={m.motion === x.id ? 'on' : ''} onClick={() => set({ motion: x.id })}>{x.label}</button>)}
      </div>
      <label>Delay <select value={m.motionDelay} onChange={(e) => set({ motionDelay: Number(e.target.value) })}>{DELAYS.map((d) => <option key={d} value={d}>{d === 0 ? 'None' : `${d} ms`}</option>)}</select></label>
      <label>Duration <select value={m.motionDuration} onChange={(e) => set({ motionDuration: Number(e.target.value) })}>{DURATIONS.map((d) => <option key={d} value={d}>{d === 200 ? 'Quick' : d === 400 ? 'Normal' : 'Slow'} · {d} ms</option>)}</select></label>
      <button type="button" className="mo-menu-done" onClick={onClose}>Done</button>
    </div>
  );
}

/** Loads something only once it is near the screen. */
function useNear(ref: React.RefObject<HTMLElement | null>) {
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || near) return;
    if (typeof IntersectionObserver === 'undefined') { setNear(true); return; }
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { setNear(true); io.disconnect(); } }, { rootMargin: '300px' });
    io.observe(el);
    return () => io.disconnect();
  }, [ref, near]);
  return near;
}

/** An image that a reader can stop: paused, its current frame is drawn once and shown instead (GIF, APNG, animated SVG). */
export function Freezable({ src, alt, paused, className }: { src: string; alt: string; paused: boolean; className?: string }) {
  const img = useRef<HTMLImageElement>(null);
  const [still, setStill] = useState<string | null>(null);
  useEffect(() => {
    if (!paused) { setStill(null); return; }
    const el = img.current;
    if (!el || !el.complete || !el.naturalWidth) return;
    try {
      const c = document.createElement('canvas'); c.width = el.naturalWidth; c.height = el.naturalHeight;
      c.getContext('2d')?.drawImage(el, 0, 0); setStill(c.toDataURL('image/png'));
    } catch { setStill(null); }
  }, [paused, src]);
  return (
    <>
      <img ref={img} src={src} alt={alt} draggable={false} className={className} hidden={!!still} />
      {still && <img src={still} alt={alt} draggable={false} className={className} data-frozen="" />}
    </>
  );
}

function Chrome({ kind, label, caption, editor, onCaption, onRemove, children, tools }: { kind: string; label: string; caption: string; editor: Editor; onCaption: (c: string) => void; onRemove: () => void; children: ReactNode; tools?: ReactNode }) {
  return (
    <NodeViewWrapper as="figure" className={`mo-block mo-${kind}`} contentEditable={false} data-kind={kind}>
      {editor.isEditable && (
        <div className="mo-tools">
          <span className="mo-kind">{label}</span>
          {tools}
          <button type="button" className="mo-x" aria-label={`Remove ${label.toLowerCase()}`} onClick={onRemove}>×</button>
        </div>
      )}
      {children}
      {editor.isEditable
        ? <input className="mo-cap-in" value={caption} maxLength={200} placeholder="Caption (shown in print and PDF too)" aria-label="Caption" onChange={(e) => onCaption(e.target.value)} />
        : caption ? <figcaption>{caption}</figcaption> : null}
    </NodeViewWrapper>
  );
}

// ---------------------------------------------------------------- Lottie

let playerText: Promise<string> | null = null;
/** The Lottie player (light build: no expressions), pinned in package.json, loaded only when a page shows an animation. */
const loadPlayer = () => (playerText ??= import('lottie-web/build/player/lottie_light.min.js?raw').then((m) => m.default));

/** A frame from /embed/sandbox.html that is sent its content once it says it is ready (only messages from that frame count). */
function SandboxFrame({ title, height, message, paused }: { title: string; height: number; message: () => Promise<unknown> | unknown; paused?: boolean }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const sent = useRef(false);
  const msgRef = useRef(message); msgRef.current = message;
  useEffect(() => {
    const onMsg = async (e: MessageEvent) => {
      if (!frame.current || e.source !== frame.current.contentWindow || (e.data as { kind?: string })?.kind !== 'pt-embed-ready' || sent.current) return;
      sent.current = true;
      const m = await msgRef.current();
      frame.current?.contentWindow?.postMessage(m, '*');
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, []);
  useEffect(() => { if (sent.current) frame.current?.contentWindow?.postMessage({ kind: 'pt-embed', mode: paused ? 'pause' : 'play' }, '*'); }, [paused]);
  const a = frameAttrs(title);
  return <iframe ref={frame} className="mo-frame" style={{ height }} {...a} />;
}

function LottieView({ node, editor, updateAttributes, deleteNode }: NodeViewProps) {
  const documentId = useContext(DocumentIdContext);
  const { paused } = useContext(MotionContext);
  const box = useRef<HTMLDivElement>(null);
  const near = useNear(box);
  const fileId = String(node.attrs.fileId ?? '');
  const height = clampHeight(node.attrs.height);
  const [error, setError] = useState<string | null>(null);
  const message = async () => {
    try {
      const [player, text] = await Promise.all([loadPlayer(), fetchText(`/documents/${documentId}/files/${fileId}/download`)]);
      return lottieMessage(player, JSON.parse(text), node.attrs.loop !== false, node.attrs.autoplay !== false && !reduced() && !paused);
    } catch { setError('This animation could not be loaded.'); return null; }
  };
  return (
    <Chrome kind="lottie" label="Lottie animation" caption={String(node.attrs.caption ?? '')} editor={editor} onCaption={(caption) => updateAttributes({ caption })} onRemove={deleteNode}
      tools={<>
        <label className="mo-tog"><input type="checkbox" checked={node.attrs.loop !== false} onChange={(e) => updateAttributes({ loop: e.target.checked })} /> Loop</label>
        <label className="mo-tog"><input type="checkbox" checked={node.attrs.autoplay !== false} onChange={(e) => updateAttributes({ autoplay: e.target.checked })} /> Play on its own</label>
      </>}>
      <div ref={box} className="mo-stage" style={{ height }}>
        {error ? <div className="mo-ph">{error}</div> : near && documentId && fileId ? <SandboxFrame title="Lottie animation" height={height} message={message} paused={paused} /> : <div className="mo-ph">Animation</div>}
      </div>
      <div className="mo-still" aria-hidden="true">Animation{node.attrs.caption ? ` · ${node.attrs.caption}` : ''} - open the page online to play it</div>
    </Chrome>
  );
}

export const MotionLottie = Node.create({
  name: 'motionLottie', group: 'block', atom: true, draggable: true,
  addAttributes() { return { fileId: { default: '' }, caption: { default: '' }, loop: { default: true }, autoplay: { default: true }, height: { default: 320 } }; },
  parseHTML() { return [{ tag: 'figure[data-motion-lottie]' }]; },
  renderHTML({ HTMLAttributes }) { return ['figure', mergeAttributes({ 'data-motion-lottie': '' }, { 'data-file-id': HTMLAttributes.fileId })]; },
  addNodeView() { return ReactNodeViewRenderer(LottieView, { attrs: viewAttrs }); },
});

// ---------------------------------------------------------------- animated SVG

function SvgView({ node, editor, updateAttributes, deleteNode }: NodeViewProps) {
  const { paused } = useContext(MotionContext);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const clean = cleanSvg(String(node.attrs.svg ?? ''));
  const apply = () => {
    const r = cleanSvg(draft);
    if (!r.ok) { setNote(r.error ?? 'This SVG could not be read.'); return; }
    updateAttributes({ svg: r.svg }); setEditing(false);
    setNote(r.removed ? `${r.removed} unsafe part${r.removed === 1 ? ' was' : 's were'} removed (scripts, links, event handlers).` : null);
  };
  return (
    <Chrome kind="svg" label="Animated SVG" caption={String(node.attrs.caption ?? '')} editor={editor} onCaption={(caption) => updateAttributes({ caption })} onRemove={deleteNode}
      tools={<button type="button" className="mo-tool" onClick={() => { setDraft(String(node.attrs.svg ?? '')); setEditing((v) => !v); }}>{editing ? 'Close code' : 'Edit SVG'}</button>}>
      {editing && (
        <div className="mo-code">
          <textarea value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={false} aria-label="SVG code" rows={8} />
          <div className="mo-code-act"><button type="button" className="btn btn-primary btn-sm" onClick={apply}>Apply</button></div>
        </div>
      )}
      {note && <p className="mo-note" role="status">{note}</p>}
      <div className="mo-stage mo-svg-stage">
        {clean.ok && clean.svg ? <Freezable src={svgDataUrl(clean.svg)} alt={String(node.attrs.caption || 'Animated picture')} paused={paused} /> : <div className="mo-ph">No picture yet</div>}
      </div>
    </Chrome>
  );
}

export const MotionSvg = Node.create({
  name: 'motionSvg', group: 'block', atom: true, draggable: true,
  addAttributes() { return { svg: { default: '' }, caption: { default: '' } }; },
  parseHTML() { return [{ tag: 'figure[data-motion-svg]' }]; },
  renderHTML() { return ['figure', { 'data-motion-svg': '' }]; },
  addNodeView() { return ReactNodeViewRenderer(SvgView, { attrs: viewAttrs }); },
});

// ---------------------------------------------------------------- video

function useFileUrl(documentId: string | null, fileId: string, on: boolean) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!documentId || !fileId || !on) return;
    const ac = new AbortController(); let made: string | null = null;
    fetchBlobUrl(`/documents/${documentId}/files/${fileId}/download`, ac.signal).then((u) => { made = u; setUrl(u); }).catch(() => setFailed(true));
    return () => { ac.abort(); if (made) URL.revokeObjectURL(made); };
  }, [documentId, fileId, on]);
  return { url, failed };
}

/** The editor's file picker for a motion block (set by the page). */
export const PickFileContext = createContext<((accept: string) => Promise<{ fileId: string; name: string } | null>) | null>(null);

function VideoView({ node, editor, updateAttributes, deleteNode }: NodeViewProps) {
  const documentId = useContext(DocumentIdContext);
  const pick = useContext(PickFileContext);
  const { paused } = useContext(MotionContext);
  const box = useRef<HTMLDivElement>(null);
  const near = useNear(box);
  const video = useRef<HTMLVideoElement>(null);
  const src = useFileUrl(documentId, String(node.attrs.fileId ?? ''), near);
  const poster = useFileUrl(documentId, String(node.attrs.posterId ?? ''), true);
  const auto = node.attrs.autoplay === true;
  useEffect(() => { const v = video.current; if (!v) return; if (paused) v.pause(); else if (auto && !reduced()) void v.play().catch(() => undefined); }, [paused, auto, src.url]);
  return (
    <Chrome kind="video" label="Video" caption={String(node.attrs.caption ?? '')} editor={editor} onCaption={(caption) => updateAttributes({ caption })} onRemove={deleteNode}
      tools={<>
        <label className="mo-tog"><input type="checkbox" checked={auto} onChange={(e) => updateAttributes({ autoplay: e.target.checked })} /> Muted loop, plays on its own</label>
        {pick && <button type="button" className="mo-tool" onClick={async () => { const f = await pick('image/png,image/jpeg,image/webp'); if (f) updateAttributes({ posterId: f.fileId }); }}>{node.attrs.posterId ? 'Change poster' : 'Add poster'}</button>}
      </>}>
      <div ref={box} className="mo-stage mo-video-stage">
        {src.failed ? <div className="mo-ph">This video could not be loaded.</div> : src.url ? (
          <video ref={video} src={src.url} poster={poster.url ?? undefined} muted={auto} loop={auto} autoPlay={auto && !paused && !reduced()} playsInline controls={!auto} preload="metadata" aria-label={String(node.attrs.caption || 'Video')} />
        ) : <div className="mo-ph">Video</div>}
      </div>
      <div className="mo-still" aria-hidden="true">
        {poster.url ? <img src={poster.url} alt="" /> : null}
        <span>Video{node.attrs.caption ? ` · ${node.attrs.caption}` : ''} - open the page online to play it</span>
      </div>
    </Chrome>
  );
}

export const MotionVideo = Node.create({
  name: 'motionVideo', group: 'block', atom: true, draggable: true,
  addAttributes() { return { fileId: { default: '' }, posterId: { default: '' }, caption: { default: '' }, autoplay: { default: false } }; },
  parseHTML() { return [{ tag: 'figure[data-motion-video]' }]; },
  renderHTML({ HTMLAttributes }) { return ['figure', mergeAttributes({ 'data-motion-video': '' }, { 'data-file-id': HTMLAttributes.fileId })]; },
  addNodeView() { return ReactNodeViewRenderer(VideoView, { attrs: viewAttrs }); },
});

// ---------------------------------------------------------------- interactive embed (sandbox)

export const STARTER = {
  html: '<div class="card">\n  <h3>Hello</h3>\n  <button id="b">Count: 0</button>\n</div>',
  css: '.card { font-family: system-ui; padding: 16px; border-radius: 12px; background: #f5f5f7; }\nbutton { font: inherit; padding: 6px 12px; }',
  js: "let n = 0;\ndocument.getElementById('b').onclick = (e) => { e.target.textContent = 'Count: ' + (++n); };",
};

function SandboxView({ node, editor, updateAttributes, deleteNode }: NodeViewProps) {
  const { paused, sandboxEnabled } = useContext(MotionContext);
  const box = useRef<HTMLDivElement>(null);
  const near = useNear(box);
  const [editing, setEditing] = useState(!node.attrs.html && !node.attrs.js && editor.isEditable);
  const [draft, setDraft] = useState({ html: String(node.attrs.html ?? ''), css: String(node.attrs.css ?? ''), js: String(node.attrs.js ?? '') });
  const [run, setRun] = useState(0);
  const height = clampHeight(node.attrs.height);
  const problems = checkSandbox(draft);
  const src = { html: String(node.attrs.html ?? ''), css: String(node.attrs.css ?? ''), js: String(node.attrs.js ?? '') };
  // Dragging the handle sets a new fixed height (saved when let go).
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const y0 = e.clientY, h0 = height; let h = h0;
    const stage = box.current;
    const move = (ev: PointerEvent) => { h = clampHeight(h0 + ev.clientY - y0); if (stage) stage.style.height = `${h}px`; };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); updateAttributes({ height: h }); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };
  return (
    <Chrome kind="sandbox" label="Interactive embed" caption={String(node.attrs.caption ?? '')} editor={editor} onCaption={(caption) => updateAttributes({ caption })} onRemove={deleteNode}
      tools={<button type="button" className="mo-tool" onClick={() => setEditing((v) => !v)}>{editing ? 'Close code' : 'Edit code'}</button>}>
      <div className="mo-embed-label" data-testid="embed-label"><span aria-hidden="true">⧉</span> Interactive embed <small>· runs in a sandbox, cut off from this app</small></div>
      {editing && editor.isEditable && (
        <div className="mo-code mo-code-3">
          {(['html', 'css', 'js'] as const).map((k) => (
            <label key={k}><span>{k === 'js' ? 'JavaScript' : k.toUpperCase()}</span>
              <textarea value={draft[k]} spellCheck={false} rows={7} aria-label={`Embed ${k}`} maxLength={LIMITS[k] + 1000} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} />
            </label>
          ))}
          {problems.length > 0 && <ul className="mo-errs" role="alert">{problems.map((p) => <li key={p}>{p}</li>)}</ul>}
          <div className="mo-code-act">
            {!draft.html && !draft.js && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setDraft(STARTER)}>Start from an example</button>}
            <button type="button" className="btn btn-primary btn-sm" disabled={problems.length > 0} onClick={() => { updateAttributes(draft); setRun((n) => n + 1); setEditing(false); }}>Run</button>
          </div>
        </div>
      )}
      <div ref={box} className="mo-stage mo-sandbox-stage" style={{ height }}>
        {!sandboxEnabled ? <div className="mo-ph">Interactive embeds are turned off in this workspace.</div>
          : paused ? <div className="mo-ph">Paused (motion is stopped on this page)</div>
          : near && (src.html || src.js) ? <SandboxFrame key={run} title={String(node.attrs.caption || 'Interactive embed')} height={height} message={() => sandboxMessage(src)} />
          : <div className="mo-ph">Interactive embed</div>}
      </div>
      {editor.isEditable && <div className="mo-resize" role="separator" aria-orientation="horizontal" aria-label="Drag to change the height" onPointerDown={startResize} />}
      <div className="mo-still" aria-hidden="true">Interactive embed{node.attrs.caption ? ` · ${node.attrs.caption}` : ''} - open online</div>
    </Chrome>
  );
}

export const SandboxEmbed = Node.create({
  name: 'sandboxEmbed', group: 'block', atom: true, draggable: true,
  addAttributes() { return { html: { default: '' }, css: { default: '' }, js: { default: '' }, height: { default: 320 }, caption: { default: '' } }; },
  parseHTML() { return [{ tag: 'figure[data-sandbox-embed]' }]; },
  renderHTML() { return ['figure', { 'data-sandbox-embed': '' }]; },
  addNodeView() { return ReactNodeViewRenderer(SandboxView, { attrs: viewAttrs }); },
});

export const motionExtensions = [MotionAttrs, MotionLottie, MotionSvg, MotionVideo, SandboxEmbed];

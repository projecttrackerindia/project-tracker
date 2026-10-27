import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Icon } from '../../components/Icon';
import { toast } from '../../stores/ui';
import { linkify, renderBody } from './chatFormat';
import { splitBody } from './codeDetect';
import { detectPayload } from './payload';
import { CodePayloadActions } from './PayloadViews';

const FOLD_PX = 320;

/** Content taller than ~320px folds, with "Show more" / "Show less" under it. */
function Fold({ children, className, label }: { children: ReactNode; className: string; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [tall, setTall] = useState(false);
  const [open, setOpen] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setTall(el.scrollHeight > FOLD_PX + 24);
    measure();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, []);
  return (
    <>
      <div ref={ref} className={`${className} ${tall && !open ? 'folded' : ''}`} style={tall && !open ? { maxHeight: FOLD_PX } : undefined}>{children}</div>
      {tall && <button type="button" className="msg-fold" aria-expanded={open} aria-label={`${open ? 'Show less' : 'Show more'} of this ${label}`} onClick={() => setOpen((v) => !v)}>
        {open ? 'Show less' : 'Show more'}</button>}
    </>
  );
}

/** A code block in a message: monospace on a neutral ground (also in my own bubbles), scrolls sideways, folds when tall, has Copy. */
export function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const copy = () => { void navigator.clipboard?.writeText(code).then(() => toast('Copied.')).catch(() => undefined); };
  // A payload sent as text before it could go as a file: it keeps its folded block, and can open in the viewer or be saved as a file.
  const big = useMemo(() => detectPayload(code) !== null, [code]);
  return (
    <div className="msg-code" data-lang={lang}>
      <div className="msg-code-head">
        <span>{lang ? lang.toUpperCase() : 'Code'}</span>
        <span className="msg-code-acts">
          {big && <CodePayloadActions code={code} lang={lang} />}
          <button type="button" className="msg-code-copy" onClick={copy} aria-label="Copy code" title="Copy"><Icon name="copy" size={13} />Copy</button>
        </span>
      </div>
      <Fold className="msg-code-body" label="code"><pre><code>{linkify(code)}</code></pre></Fold>
    </div>
  );
}

/** A message's text: prose with its formatting, mentions and links, and code (JSON, fenced, pasted code, long tokens) as code blocks. */
export function MessageBody({ body }: { body: string }) {
  const parts = useMemo(() => splitBody(body), [body]);
  return (
    <>
      {parts.map((p, i) => p.kind === 'code'
        ? <CodeBlock key={i} code={p.text} lang={p.lang} />
        : p.long ? <Fold key={i} className="msg-long" label="message">{renderBody(p.text)}</Fold> : <span key={i}>{renderBody(p.text)}</span>)}
    </>
  );
}

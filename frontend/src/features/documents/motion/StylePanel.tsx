import { useMemo, useState } from 'react';
import { Icon } from '../../../components/Icon';
import { checkCss, MAX_CSS } from './cssScope';
import { cleanStyle, PRESETS, suggestVisual, TRANSITIONS, type LibraryDesign, type PageStyle } from './pageStyle';

const CSS_HINT = `/* Only this page's text. Light and dark: */
h2 { color: var(--accent); }
:root { --accent: #4f46e5; }
@media (prefers-color-scheme: dark) {
  :root { --accent: #a5b4fc; }
}`;

/**
 * Style: how this page looks and moves (editors only). Changes show on the page at once; nothing is kept until Save, and the server checks
 * the CSS again before it is stored and records the change in the audit log.
 */
export function StylePanel({ value, body, design, saving, onPreview, onSave, onClose, previewMotion, onPreviewMotion, unavailable }: {
  value: PageStyle; body: string; design: LibraryDesign; saving: boolean;
  /** Why this document cannot carry a style (a file, or only tables): said in the panel instead of hiding the panel. */
  unavailable?: string;
  onPreview: (s: PageStyle) => void; onSave: (s: PageStyle) => void; onClose: () => void;
  previewMotion: boolean; onPreviewMotion: (on: boolean) => void;
}) {
  const [s, setS] = useState<PageStyle>(value);
  const [tab, setTab] = useState<'look' | 'css'>('look');
  const [idea, setIdea] = useState<ReturnType<typeof suggestVisual> | null>(null);
  const errors = useMemo(() => (design.customCss ? checkCss(s.css) : []), [s.css, design.customCss]);
  const set = (patch: Partial<PageStyle>) => { const next = cleanStyle({ ...s, ...patch }); setS(next); if (!checkCss(next.css).length || !design.customCss) onPreview(next); };
  const changed = JSON.stringify(s) !== JSON.stringify(value);
  return (
    <aside className="sp" role="dialog" aria-label="Page style" data-testid="style-panel">
      <header className="sp-head">
        <h2>Style</h2>
        <div className="sp-tabs" role="tablist" aria-label="Style">
          <button type="button" role="tab" aria-selected={tab === 'look'} onClick={() => setTab('look')}>Look &amp; motion</button>
          <button type="button" role="tab" aria-selected={tab === 'css'} onClick={() => setTab('css')}>Advanced CSS</button>
        </div>
        <button type="button" className="sp-x" aria-label="Close style" onClick={() => { onPreview(value); onClose(); }}><Icon name="close" size={16} /></button>
      </header>

      {unavailable ? (
        <div className="sp-body"><p className="sp-off" role="note" data-testid="style-unavailable">{unavailable}</p></div>
      ) : tab === 'look' ? (
        <div className="sp-body">
          <button type="button" className="sp-groot" onClick={() => setIdea(suggestVisual(body))}><Icon name="sparkle" size={14} /> Make this page more visual</button>
          {idea && (
            <div className="sp-idea" role="status" data-testid="groot-idea">
              <b>Aura suggests {PRESETS.find((p) => p.id === idea.style.preset)?.label}{idea.style.animateSections ? ' with sections that rise in' : ''}</b>
              <ul>{idea.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
              <div><button type="button" className="btn btn-primary btn-sm" onClick={() => { set({ ...idea.style, css: s.css }); setIdea(null); }}>Apply</button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setIdea(null)}>Not now</button></div>
            </div>
          )}
          <h3>Preset</h3>
          <div className="sp-presets" role="radiogroup" aria-label="Preset">
            {PRESETS.map((p) => (
              <button key={p.id} type="button" role="radio" aria-checked={s.preset === p.id} className={`sp-preset${s.preset === p.id ? ' on' : ''}`} data-preset={p.id} onClick={() => set({ preset: p.id })}>
                <span className="sp-swatch" aria-hidden="true"><i /><i /><i /></span>
                <b>{p.label}</b><small>{p.hint}</small>
              </button>
            ))}
          </div>
          <h3>Motion</h3>
          <label className="sp-switch"><input type="checkbox" checked={s.animateSections} onChange={(e) => set({ animateSections: e.target.checked })} />
            <span><b>Animate sections on scroll</b><small>Blocks rise in as readers reach them. Off for anyone who asks their device for less motion.</small></span></label>
          <div className="sp-field"><span>Between sections</span>
            <div className="sp-seg" role="radiogroup" aria-label="Section transition">
              {TRANSITIONS.map((t) => <button key={t.id} type="button" role="radio" aria-checked={s.sectionTransition === t.id} className={s.sectionTransition === t.id ? 'on' : ''} onClick={() => set({ sectionTransition: t.id })}>{t.label}</button>)}
            </div>
          </div>
          <p className="sp-tip">Give one block its own motion: select it and choose <b>Motion</b> in the bar over the selection.</p>
          <label className="sp-switch"><input type="checkbox" checked={previewMotion} onChange={(e) => onPreviewMotion(e.target.checked)} />
            <span><b>Preview as a reader</b><small>Plays the motion; the text is not editable while previewing.</small></span></label>
        </div>
      ) : (
        <div className="sp-body">
          {!design.customCss ? <p className="sp-off" role="note">Custom CSS is turned off for this workspace by an admin. Presets and motion still work.</p> : (
            <>
              <p className="sp-tip">Applies to this page's text only - never the app around it. No imports, addresses or fixed positioning. Up to 20 KB.</p>
              <textarea className={`sp-css${errors.length ? ' bad' : ''}`} value={s.css} onChange={(e) => set({ css: e.target.value })} spellCheck={false} placeholder={CSS_HINT}
                aria-label="Advanced CSS" aria-invalid={errors.length > 0} aria-describedby="sp-css-state" rows={16} />
              <div id="sp-css-state" className="sp-css-state">
                <span>{(s.css.length / 1000).toFixed(1)} / {MAX_CSS / 1000} KB</span>
                {errors.length === 0 ? <span className="ok">{s.css.trim() ? 'Looks good' : ''}</span> : null}
              </div>
              {errors.length > 0 && <ul className="sp-errs" role="alert" data-testid="css-errors">{errors.map((e, i) => <li key={i}><b>Line {e.line}</b> {e.message}</li>)}</ul>}
            </>
          )}
        </div>
      )}

      {!unavailable && <footer className="sp-foot">
        <button type="button" className="btn btn-ghost" onClick={() => { setS(value); onPreview(value); }} disabled={!changed}>Reset</button>
        <button type="button" className="btn btn-primary" disabled={!changed || errors.length > 0 || saving} onClick={() => onSave(s)}>{saving ? <span className="spinner" /> : null} Save style</button>
      </footer>}
    </aside>
  );
}

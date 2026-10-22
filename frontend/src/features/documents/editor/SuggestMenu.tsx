import { forwardRef, useEffect, useImperativeHandle, useState } from 'react';
import { ReactRenderer } from '@tiptap/react';
import type { SuggestionKeyDownProps, SuggestionProps } from '@tiptap/suggestion';

/** One choice in a pop-up list: the slash menu, @ people, # tasks or [[ pages. */
export interface SuggestItem { id: string; title: string; hint?: string; icon?: string; run?: () => void; [key: string]: unknown }

interface ListProps { items: SuggestItem[]; command: (item: SuggestItem) => void; empty: string }
export interface ListHandle { onKeyDown: (e: KeyboardEvent) => boolean }

/** The pop-up list under the caret: arrow keys move, Enter or Tab picks, Escape closes (handled by the suggestion plugin). */
const SuggestList = forwardRef<ListHandle, ListProps>(({ items, command, empty }, ref) => {
  const [at, setAt] = useState(0);
  useEffect(() => setAt(0), [items]);
  useImperativeHandle(ref, () => ({
    onKeyDown: (e) => {
      if (!items.length) return false;
      if (e.key === 'ArrowDown') { setAt((i) => (i + 1) % items.length); return true; }
      if (e.key === 'ArrowUp') { setAt((i) => (i - 1 + items.length) % items.length); return true; }
      if (e.key === 'Enter' || e.key === 'Tab') { command(items[at]); return true; }
      return false;
    },
  }), [items, at, command]);
  return (
    <div className="sgm" role="listbox" aria-label="Suggestions">
      {items.length === 0 ? <div className="sgm-empty">{empty}</div> : items.map((it, i) => (
        <button key={it.id} type="button" role="option" aria-selected={i === at} className={`sgm-item${i === at ? ' on' : ''}`}
          onMouseEnter={() => setAt(i)} onMouseDown={(e) => { e.preventDefault(); command(it); }}>
          {it.icon && <span className="sgm-icon" aria-hidden="true">{it.icon}</span>}
          <span className="sgm-text"><b>{it.title}</b>{it.hint && <small>{it.hint}</small>}</span>
        </button>
      ))}
    </div>
  );
});
SuggestList.displayName = 'SuggestList';

/** The render hooks a TipTap suggestion needs: mount the list in a floating box at the caret, follow it, and pass keys through. */
export function suggestRenderer(empty: string) {
  return () => {
    let view: ReactRenderer<ListHandle, ListProps> | null = null;
    let box: HTMLDivElement | null = null;
    const place = (p: SuggestionProps<SuggestItem>) => {
      const r = p.clientRect?.();
      if (!box || !r) return;
      const below = r.bottom + 6, height = box.offsetHeight || 280;
      const top = below + height > window.innerHeight - 8 ? Math.max(8, r.top - height - 6) : below;
      box.style.top = `${top}px`;
      box.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - 300))}px`;
    };
    return {
      onStart: (p: SuggestionProps<SuggestItem>) => {
        view = new ReactRenderer(SuggestList, { props: { items: p.items, command: p.command, empty }, editor: p.editor });
        box = document.createElement('div');
        box.className = 'sgm-box';
        box.appendChild(view.element);
        document.body.appendChild(box);
        place(p);
      },
      onUpdate: (p: SuggestionProps<SuggestItem>) => { view?.updateProps({ items: p.items, command: p.command, empty }); place(p); },
      onKeyDown: (p: SuggestionKeyDownProps) => {
        if (p.event.key === 'Escape') { box?.remove(); box = null; return true; }
        return view?.ref?.onKeyDown(p.event) ?? false;
      },
      onExit: () => { box?.remove(); box = null; view?.destroy(); view = null; },
    };
  };
}

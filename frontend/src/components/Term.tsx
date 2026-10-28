import type { ReactNode } from 'react';
import { GLOSSARY, type GlossaryKey } from '../lib/glossary';
import './term.css';

/**
 * A word with its definition from the one glossary (lib/glossary): a dotted underline and the definition in a bubble on hover and keyboard
 * focus. The bubble is drawn from the attribute (CSS ::after), so the word's own text stays exactly the word; screen readers get the
 * definition as the element's description. Children default to the term itself.
 */
export function Term({ k, children, className, focusable = true }: { k: GlossaryKey; children?: ReactNode; className?: string; focusable?: boolean }) {
  return (
    <span className={`term ${className ?? ''}`} tabIndex={focusable ? 0 : undefined} data-term={k} data-tip={GLOSSARY[k]} aria-description={GLOSSARY[k]}>
      {children ?? k}
    </span>
  );
}

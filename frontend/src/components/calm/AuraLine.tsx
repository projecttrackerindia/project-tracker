import type { ReactNode } from 'react';
import { SiriOrb } from '../aura/SiriOrb';
import './calm-kit.css';

/**
 * The single Aura sentence at the foot of a calm screen: the orb, one sentence, one action ("Nudge Sofia?"). Nothing renders without text,
 * so a page never shows an empty pill.
 */
export function AuraLine({ text, action, onAction, href, className = '' }: { text?: ReactNode; action?: ReactNode; onAction?: () => void; href?: string; className?: string }) {
  if (!text) return null;
  return (
    <div className={`aura-line ${className}`.trim()} role="note" aria-label="Aura">
      <SiriOrb className="calm-orb" />
      <span className="aura-line-text">{text}</span>
      {action && (href ? <a href={href}>{action}</a> : onAction ? <button type="button" onClick={onAction}>{action}</button> : null)}
    </div>
  );
}

/** The Aura orb on its own (16px, conic gradient). */
export function CalmOrb() { return <SiriOrb className="calm-orb" />; }

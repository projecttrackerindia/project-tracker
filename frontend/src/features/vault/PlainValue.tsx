import { Icon } from '../../components/Icon';
import { toast } from '../../stores/ui';
import type { FieldType } from './api';

const href = (u: string) => (/^https?:\/\//i.test(u) ? u : `https://${u}`);
const safeLink = (u: string) => { try { const p = new URL(href(u)); return p.protocol === 'https:' || p.protocol === 'http:'; } catch { return false; } };

/**
 * A field that is not secret, as the item shows it: a remark as a readable paragraph (line breaks kept), a link that opens in a new tab
 * (http and https only), anything else as one line — each with a copy button.
 */
export function PlainValue({ label, type, value }: { label: string; type: FieldType; value: string }) {
  const copy = <button type="button" className="btn-icon" aria-label={`Copy ${label}`} onClick={() => navigator.clipboard?.writeText(value).then(() => toast(`${label} copied.`))}><Icon name="copy" size={15} /></button>;
  if (type === 'remark') return <div className="vlt-field-row vlt-remark-row"><p className="vlt-field-value vlt-remark">{value}</p>{copy}</div>;
  if (type === 'url' && safeLink(value))
    return <div className="vlt-field-row"><a className="vlt-field-value vlt-link" href={href(value)} target="_blank" rel="noopener noreferrer nofollow" referrerPolicy="no-referrer">{value}</a>{copy}</div>;
  return <div className="vlt-field-row"><span className="vlt-field-value">{value}</span>{copy}</div>;
}

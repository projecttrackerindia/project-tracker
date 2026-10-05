import { useQuery } from '@tanstack/react-query';
import { consentApi } from '../../api/endpoints';
import { PageLoader } from '../../components/ui';
import { BrandMark } from '../../components/BrandMark';
import { usePageTitle } from '../../lib/title';

const TITLES: Record<string, string> = { tos: 'Terms of Service', privacy: 'Privacy Policy' };

/** Public page: the current Terms of Service or Privacy Policy, exactly as published to everyone who signs up. */
export function LegalPage({ type }: { type: 'tos' | 'privacy' }) {
  usePageTitle(TITLES[type]);
  const q = useQuery({ queryKey: ['consent', 'documents'], queryFn: consentApi.documents });
  const doc = q.data?.find((d) => d.type === type);
  return (
    <div className="sec-page">
      <header className="sec-top">
        <a href="/" className="sec-brand"><span className="sec-logo"><BrandMark size={18} /></span> Project Tracker</a>
        <nav style={{ display: 'flex', gap: 18 }}><a href="/security/">Security</a><a href="/login">Sign in</a></nav>
      </header>
      <section className="sec-hero" style={{ marginBottom: 20 }}>
        <h1>{doc?.title ?? TITLES[type]}</h1>
        {doc?.publishedAt && <p>Version {doc.version}, published {new Date(doc.publishedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })}</p>}
      </section>
      <article style={{ maxWidth: 760, margin: '0 auto' }}>
        {q.isLoading ? <PageLoader /> : doc ? <p style={{ whiteSpace: 'pre-wrap', lineHeight: 1.7 }}>{doc.body}</p> : <p className="muted">This document is not available right now.</p>}
      </article>
      <footer className="sec-foot">
        <a href="/terms">Terms of Service</a> · <a href="/privacy">Privacy Policy</a> · <a href="/security/">Security</a>
      </footer>
    </div>
  );
}

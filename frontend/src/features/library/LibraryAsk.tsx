import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { Spinner } from '../../components/ui';
import { docAiApi, type AskAnswer } from '../documents/docAi';
import { shelfOf } from './libraryKinds';

/** **bold** and `code` inside a line; [n] markers are left out (the sources are the cards under the answer). */
function inline(s: string): ReactNode[] {
  return s.replace(/\s?\[\d+\]/g, '').split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((p, i) =>
    p.startsWith('**') && p.endsWith('**') ? <b key={i}>{p.slice(2, -2)}</b> : p.startsWith('`') && p.endsWith('`') && p.length > 2 ? <code key={i}>{p.slice(1, -1)}</code> : p);
}

/** The answer's text: paragraphs, and code (fenced, or a run of lines that start with a code span) in a mono block. */
function AnswerText({ text }: { text: string }) {
  const out: ReactNode[] = [];
  const blocks = text.split(/```[\w-]*\n?/);
  blocks.forEach((b, bi) => {
    if (bi % 2 === 1) { out.push(<pre key={`c${bi}`} className="lb-hdr">{b.trim()}</pre>); return; }
    let mono: string[] = [];
    const flush = (k: string) => { if (mono.length) out.push(<pre key={k} className="lb-hdr">{mono.map((m, i) => { const [a, ...r] = m.split(/`\s*/).filter(Boolean); return <span key={i}>{a}{r.length ? <small> {r.join(' ').replace(/^[—:-]\s*/, '· ')}</small> : null}{'\n'}</span>; })}</pre>); mono = []; };
    b.split('\n').forEach((line, li) => {
      const l = line.trim().replace(/^[-*•]\s+/, '');
      if (!l) { flush(`m${bi}-${li}`); return; }
      if (/^`[^`]+`/.test(l)) { mono.push(l.replace(/\s?\[\d+\]/g, '')); return; }
      flush(`m${bi}-${li}`);
      out.push(<p key={`p${bi}-${li}`}>{inline(l)}</p>);
    });
    flush(`m${bi}-end`);
  });
  return <>{out}</>;
}

/**
 * Ask your docs: a question in the field, and the answer unfurls from it — read from the pages this person can open (the same AI ask as
 * DocTracker), with the documents it came from flying in underneath.
 */
export function AskDocs({ typeOf, onAsking, onQuery, onAsked, placeholder = 'Ask your docs', hero }: { typeOf: (documentId: string) => string | undefined; onAsking: (on: boolean) => void; onQuery?: (q: string) => void; onAsked?: (question: string | null) => void; placeholder?: string; hero?: boolean }) {
  const still = useReducedMotion();
  const [q, setQ] = useState('');
  const [asked, setAsked] = useState<string | null>(null);
  const [state, setState] = useState<{ busy: boolean; answer: AskAnswer | null; error: string | null }>({ busy: false, answer: null, error: null });
  useEffect(() => {
    if (!asked) return;
    let off = false;
    setState({ busy: true, answer: null, error: null });
    docAiApi.ask(asked).then((a) => { if (!off) setState({ busy: false, answer: a, error: null }); })
      .catch((e) => { if (!off) setState({ busy: false, answer: null, error: e instanceof ApiError ? e.message : 'The AI could not answer right now.' }); });
    return () => { off = true; };
  }, [asked]);
  useEffect(() => { onAsking(!!asked && state.busy); }, [asked, state.busy, onAsking]);
  useEffect(() => { onAsked?.(asked); }, [asked, onAsked]);
  const a = state.answer;
  const cites = a ? a.citations.filter((c, i, all) => all.findIndex((x) => x.documentId === c.documentId) === i).slice(0, 3) : [];
  const spring = still ? { duration: 0 } : { type: 'spring' as const, duration: 0.38, bounce: 0.12 };
  return (
    <div className={`lb-askwrap${hero ? ' hero' : ''}`}>
      <form className={`lb-q${asked ? ' on' : ''}`} role="search" onSubmit={(e) => { e.preventDefault(); const t = q.trim(); if (t.length >= 3) setAsked(t); }}>
        <span className="lb-orb" aria-hidden="true" />
        <input type="search" value={q} autoComplete="off" placeholder={placeholder} aria-label="Ask your docs"
          onChange={(e) => { setQ(e.target.value); onQuery?.(e.target.value); if (asked && e.target.value.trim() !== asked) setAsked(null); }} />
        {hero ? <button type="submit" className="lb-q-ask" disabled={q.trim().length < 3}>Ask</button> : <button type="submit" className="lb-q-go" aria-label="Ask" disabled={q.trim().length < 3}>↩</button>}
      </form>
      <AnimatePresence initial={false}>
        {asked && (
          <motion.section key={asked} className="lb-ans" aria-live="polite" aria-label="Answer from your docs"
            initial={still ? false : { clipPath: 'inset(0 0 100% 0 round 18px)', opacity: 0.6, scaleY: 0.97 }}
            animate={{ clipPath: 'inset(0 0 0% 0 round 18px)', opacity: 1, scaleY: 1 }}
            exit={still ? { opacity: 0 } : { clipPath: 'inset(0 0 100% 0 round 18px)', opacity: 0 }} transition={spring} style={{ transformOrigin: 'top center' }}>
            <motion.div initial={still ? false : { opacity: 0 }} animate={{ opacity: 1 }} transition={still ? { duration: 0 } : { duration: 0.2, delay: 0.12 }}>
              {state.busy ? <p className="lb-ans-busy"><Spinner /> Reading the pages you can open…</p>
                : state.error ? <p className="lb-ans-err" role="alert">{state.error}</p>
                  : a && (
                    <>
                      <AnswerText text={a.answer} />
                      {!a.found && <p className="lb-ans-note">Nothing in the pages you can open answers this.</p>}
                      {cites.length > 0 && (
                        <ul className="lb-cites" aria-label="Sources">
                          {cites.map((c, i) => (
                            <motion.li key={c.n} initial={still ? false : { opacity: 0, y: 26, scale: 0.8 }} animate={{ opacity: 1, y: 0, scale: 1 }}
                              transition={still ? { duration: 0 } : { type: 'spring', duration: 0.38, bounce: 0.15, delay: 0.18 + i * 0.06 }}>
                              <Link className="lb-cite" to={`/library/docs/${c.documentId}#b-${c.block}`} title={c.snippet}>
                                <span className={`lb-mc s-${shelfOf(typeOf(c.documentId) ?? '')}`} aria-hidden="true" />
                                <span><b>{c.title}</b><small>§ {c.key}</small></span>
                              </Link>
                            </motion.li>
                          ))}
                        </ul>
                      )}
                    </>
                  )}
            </motion.div>
          </motion.section>
        )}
      </AnimatePresence>
    </div>
  );
}

import { memo, useCallback, useEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiUrl } from '../../api/client';
import { authApi } from '../../api/endpoints';
import { startOutsideSignIn } from '../../lib/native';
import { SUPPORT_EMAIL, supportMailto } from '../../lib/support';
import { PROVIDER_ICON } from '../auth/AuthPages';
import '../../styles/brand-fonts.css';
import './landing.css';

/**
 * The public landing page: what someone signed out sees at "/" (and anyone at /welcome). Black and paper bands like a product film, with
 * three scroll-driven scenes (the app window rising flat, the statement lighting word by word, the pinned "Five places") and small looping
 * demos. Every person, project and number on it is a made-up example drawn with HTML and CSS. Motion is transform and opacity only, and
 * with "reduce motion" every scene shows its finished state.
 */

const reduceMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
const clamp = (v: number) => Math.max(0, Math.min(1, v));
/** How far through a tall scroll scene the page is, 0 at its top and 1 when its end reaches the bottom of the screen. */
function progress(el: Element) {
  const r = el.getBoundingClientRect(), span = r.height - window.innerHeight;
  return span > 0 ? clamp(-r.top / span) : (r.top < 0 ? 1 : 0);
}
function scrollToId(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  el.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'start' });
}
/** An in-page link: smooth scroll, and the address stays clean. */
function onAnchor(e: ReactMouseEvent<HTMLAnchorElement>, after?: () => void) {
  const href = e.currentTarget.getAttribute('href') ?? '';
  if (!href.startsWith('#')) return;
  e.preventDefault();
  after?.();
  scrollToId(href.slice(1) || 'lp-top');
}

const SECTIONS: [string, string][] = [['how', 'Overview'], ['places', 'Five places'], ['create', 'Create'], ['ai', 'AI'], ['portfolio', 'Portfolio'], ['trust', 'Privacy'], ['pricing', 'Pricing']];

// ------------------------------------------------------------------ nav
function Nav() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [open]);
  // The sheet sits outside the header: the header's blur would otherwise make it the sheet's frame instead of the screen.
  return (<>
    <header className="lp-nav"><div className="lp-wrap">
      <a className="lp-logo" href="#lp-top" onClick={(e) => onAnchor(e)}><i aria-hidden="true">✓</i>ProjectTracker</a>
      <nav aria-label="Sections">{SECTIONS.map(([id, label]) => <a key={id} href={`#${id}`} onClick={(e) => onAnchor(e)}>{label}</a>)}</nav>
      <div className="lp-nav-end">
        <Link className="lp-signin" to="/login">Sign in</Link>
        <Link className="lp-btn lp-btn-blue lp-nav-try" to="/signup">Try it free</Link>
        <button type="button" className="lp-menu-btn" aria-label={open ? 'Close menu' : 'Open menu'} aria-expanded={open} aria-controls="lp-menu" onClick={() => setOpen((v) => !v)}>
          <span aria-hidden="true" className={open ? 'lp-x' : ''}><i /><i /></span>
        </button>
      </div>
    </div></header>
    {open && <>
      <div className="lp-scrim" onClick={() => setOpen(false)} aria-hidden="true" />
      <div className="lp-sheet-menu" id="lp-menu" role="dialog" aria-label="Menu">
        <span className="lp-grab" aria-hidden="true" />
        <nav aria-label="Sections">{SECTIONS.map(([id, label]) => <a key={id} href={`#${id}`} onClick={(e) => onAnchor(e, () => setOpen(false))}>{label}<span aria-hidden="true">›</span></a>)}</nav>
        <div className="lp-sheet-cta">
          <Link className="lp-btn lp-btn-blue" to="/signup">Try it free</Link>
          <Link className="lp-btn lp-btn-ghost" to="/login">Sign in</Link>
        </div>
      </div>
    </>}
  </>);
}

// ------------------------------------------------------------------ hero
const BRIEFS = ['3 things need you. Checkout payments are failing — critical, due today.', 'KYC Refresh will land 3 weeks late unless the date moves. I can update the plan and tell the team.', 'Rohan holds most of the late work. Want me to suggest a rebalance?'];
const ROW_LABELS = ['Open room', 'Accept', 'Nudge Rohan', 'Submit'], ROW_DONE = ['Room open', 'Moved · team told', 'Rohan nudged', 'Submitted'];
const ASKS = ['Ask, find, or tell it what to do…', '“What slipped this week?”', '“Draft a reply to Meera”', '“Log 3h on KYC‑8”'];

const Hero = memo(function Hero() {
  return (
    <section className="lp-hero" aria-label="Introduction" data-lp="hero">
      <div className="lp-hero-stick">
        <div className="lp-aurora" aria-hidden="true"><i></i><i></i><i></i></div>
        <div className="lp-wrap lp-hero-copy" data-lp="copy">
          <p className="lp-eyebrow">Projects. Tickets. Conversations. One mind.</p>
          <h1>Work, <span>on autopilot.</span></h1>
          <p className="lp-lede">An assistant that reads everything your team is doing, tells you what matters, and handles the follow-up when you say yes.</p>
          <div className="lp-cta"><Link className="lp-btn lp-btn-blue" to="/signup">Try it free</Link><a className="lp-btn lp-btn-link" href="#how" onClick={(e) => onAnchor(e)}>See how it works ›</a></div>
        </div>
        <div className="lp-stage"><div className="lp-device" data-lp="device" role="img" aria-label="The Home screen: a morning briefing and four things that need you, all example data">
          <div className="lp-screen" aria-hidden="true">
            <div className="lp-s-rail"><b>+</b><span className="lp-on">Home</span><span>Work</span><span>Talk</span><span>Library</span><span>Insights</span></div>
            <div className="lp-s-main">
              <div className="lp-s-title">Good morning, Aisha.</div>
              <div className="lp-s-brief"><span className="lp-orb"></span><span data-lp="brief">{BRIEFS[0]}</span></div>
              <div data-lp="rows" style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <div className="lp-s-row"><span className="lp-pill lp-p-red">Ticket</span><span className="lp-grow"><b>OPS‑142 · Checkout payments failing</b><small>Critical · due today</small></span><span className="lp-act">Open room</span></div>
                <div className="lp-s-row"><span className="lp-pill lp-p-vio">Decision</span><span className="lp-grow"><b>Move “KYC Refresh” to 12 Dec?</b><small>Forecast · 2 tasks overdue</small></span><span className="lp-act">Accept</span></div>
                <div className="lp-s-row"><span className="lp-pill lp-p-amb">Overdue</span><span className="lp-grow"><b>LND‑31 · Partner bank timeout</b><small>Rohan · 9 days</small></span><span className="lp-act">Nudge Rohan</span></div>
                <div className="lp-s-row"><span className="lp-pill lp-p-blue">Approval</span><span className="lp-grow"><b>Timesheet · this week</b><small>Draft ready · 34h</small></span><span className="lp-act">Submit</span></div>
              </div>
              <div className="lp-s-ask"><span className="lp-orb"></span><span data-lp="ask">{ASKS[0]}</span></div>
            </div>
          </div>
        </div></div>
      </div>
    </section>
  );
});

// ------------------------------------------------------------------ words
const STATEMENT = 'Every morning it reads your projects, tickets, chats and calendar. It tells you the three things that matter. And when you say yes,';
const STATEMENT_AI = 'it does the follow‑up.';
const Words = memo(function Words() {
  const words: ReactNode[] = [];
  STATEMENT.split(' ').forEach((w, i) => { words.push(<span key={`w${i}`}>{w}</span>, ' '); });
  STATEMENT_AI.split(' ').forEach((w, i, a) => { words.push(<span key={`a${i}`} className="lp-ai">{w}</span>); if (i < a.length - 1) words.push(' '); });
  return (
    <section className="lp-words lp-white" id="how" aria-label="How it works" data-lp="words">
      <div className="lp-words-stick"><div className="lp-wrap"><p data-lp="statement">{words}</p></div></div>
    </section>
  );
});

// ------------------------------------------------------------------ how it thinks (static markup, driven by the scene script)
const Core = memo(function Core() {
  return (
  <section className="lp-core" aria-label="How it thinks">
  <div className="lp-wrap">
    <div className="lp-head lp-center lp-reveal" style={{ marginBottom: '56px' } as CSSProperties}><p className="lp-eyebrow">How it thinks</p><h2>Everything flows<br />to one mind.</h2><p>It reads what your team is doing, connects the dots, and hands you three things with the next step ready.</p></div>
    <div className="lp-cine lp-reveal" id="lp-cine" data-lp="cine" aria-label="Updates flow into the assistant, which writes a briefing you can act on in one tap">
      <div className="lp-lane" aria-hidden="true">
        <div className="lp-sc" data-i="0"><i style={{ background: '#30D158' } as CSSProperties}>C</i><div><b>Meera · Chat</b><span>Can you review the onboarding flow?</span></div></div>
        <div className="lp-sc" data-i="1"><i style={{ background: '#FF453A' } as CSSProperties}>T</i><div><b>OPS‑142 · Ticket</b><span>Checkout payments failing</span></div></div>
        <div className="lp-sc" data-i="2"><i style={{ background: '#FF6FB5' } as CSSProperties}>C</i><div><b>Calendar</b><span>Standup moved to 11:00</span></div></div>
        <div className="lp-sc" data-i="3"><i style={{ background: '#0A84FF' } as CSSProperties}>M</i><div><b>Bank partner · Mail</b><span>Timeout again on retries</span></div></div>
        <div className="lp-sc" data-i="4"><i style={{ background: '#FF9F0A' } as CSSProperties}>K</i><div><b>KYC‑8 · Task</b><span>2 tasks now overdue</span></div></div>
      </div>
      <div className="lp-mind" aria-hidden="true"><div className="lp-halo"></div><div className="lp-rim"></div><div className="lp-mind-in"><span className="lp-orb"></span><b id="lp-mindT">Listening</b><small id="lp-mindS">5 sources</small></div></div>
      <div className="lp-bcard" aria-hidden="true">
        <p className="lp-bk">✦ Your briefing</p>
        <div className="lp-bi" data-i="0"><em>1</em><div><b>Payments are failing</b><span>OPS‑142 is critical and due today.</span></div><s>Room opened</s></div>
        <div className="lp-bi" data-i="1"><em>2</em><div><b>Move KYC Refresh to 12 Dec?</b><span>2 tasks overdue at the current pace.</span></div><s>Moved · team told</s></div>
        <div className="lp-bi" data-i="2"><em>3</em><div><b>Review Meera's flow</b><span>She needs it before Thursday.</span></div><s>Added to Thursday</s></div>
        <p className="lp-more">+4 more waiting in your inbox</p>
        <div className="lp-bfoot"><span className="lp-hb">Handle all three</span><span className="lp-hd">✓ All three handled</span></div>
      </div>
    </div>
    <ol className="lp-phases" id="lp-phases"><li className="lp-on"><b>Listens</b><span>Chats, tickets, mail, meetings, calendars</span></li><li><b>Connects</b><span>Turns 128 updates into one story</span></li><li><b>Briefs you</b><span>Three things, each with a reason</span></li><li><b>Acts on yes</b><span>One tap and it's done, every step logged</span></li></ol>
  </div>
  </section>
  );
});

// ------------------------------------------------------------------ five places
const PLACES: [string, string][] = [
  ['Home', 'A briefing and one inbox for everything that needs you.'],
  ['Work', 'Tasks, issues and tickets in one list. Open any item beside it.'],
  ['Talk', 'Chat, mail and meetings together, each with a summary on top.'],
  ['Library', 'Docs you can ask questions of, and a sealed vault for secrets.'],
  ['Insights', 'Delivery, workload and time, with what stands out written for you.'],
];
const Five = memo(function Five() {
  const [on, setOn] = useState(0);
  const manual = useRef(-1);
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (reduceMotion()) return;
    let raf = 0;
    const tick = () => {
      raf = 0;
      const el = ref.current;
      if (!el || window.innerWidth <= 900) return;
      const fp = progress(el), idx = Math.min(4, Math.floor(fp * 5));
      if (manual.current < 0 || Math.abs(fp - (manual.current + .5) / 5) > .2) { manual.current = -1; setOn(idx); }
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(tick); };
    window.addEventListener('scroll', onScroll, { passive: true }); window.addEventListener('resize', onScroll); tick();
    return () => { window.removeEventListener('scroll', onScroll); window.removeEventListener('resize', onScroll); cancelAnimationFrame(raf); };
  }, []);
  const v = (i: number) => `lp-view${on === i ? ' lp-on' : ''}`;
  return (
    <section className="lp-five lp-paper" id="places" aria-label="Five places" ref={ref}>
      <div className="lp-five-stick"><div className="lp-wrap lp-five-grid">
        <div>
          <h2>Five places.<br />That's the whole app.</h2>
          <div className="lp-list" role="tablist" aria-label="The five places">
            {PLACES.map(([t, d], i) => (
              <button key={t} type="button" role="tab" aria-selected={on === i} className={on === i ? 'lp-on' : ''} onClick={() => { manual.current = i; setOn(i); }}><b>{t}</b><span>{d}</span></button>
            ))}
          </div>
        </div>
        <div className="lp-phone" aria-live="polite" data-lp="phone" data-on={PLACES[on][0]}>
          <div className={v(0)} aria-hidden={on !== 0}><span className="lp-v-eyebrow">Tuesday · briefing ready</span><h3>3 things need you.</h3><div className="lp-tile"><span className="lp-pill lp-p-red">Ticket</span><span className="lp-grow">Checkout payments failing</span></div><div className="lp-tile"><span className="lp-pill lp-p-vio">Decision</span><span className="lp-grow">Move KYC Refresh to 12 Dec?</span></div><div className="lp-tile"><span className="lp-pill" style={{ background: '#E3F5E8', color: '#1A7F37' }}>Mention</span><span className="lp-grow">Meera: “can you review the flow?”</span></div></div>
          <div className={v(1)} aria-hidden={on !== 1}><span className="lp-v-eyebrow">One list</span><h3>Work</h3><div className="lp-tile"><b className="lp-key">OPS‑142</b><span className="lp-grow">Checkout payments failing</span><span className="lp-late">Today</span></div><div className="lp-tile"><b className="lp-key">LND‑31</b><span className="lp-grow">Partner bank timeout</span><span className="lp-late">9d late</span></div><div className="lp-tile"><b className="lp-key">KYC‑8</b><span className="lp-grow">Re-verify dormant accounts</span><span>Fri</span></div><div className="lp-sum">✦ Rohan holds 5 open items. Move LND‑31 to Dev?</div></div>
          <div className={v(2)} aria-hidden={on !== 2}><span className="lp-v-eyebrow">Meera Iyer · Chat</span><h3>Talk</h3><div className="lp-sum">✦ Meera needs a review of the onboarding flow by Thursday.</div><div className="lp-bubble">Can you review the new onboarding flow?</div><div className="lp-bubble lp-me">Sure, Thursday works.</div><div className="lp-bubble">Perfect, thank you!</div></div>
          <div className={v(3)} aria-hidden={on !== 3}><span className="lp-v-eyebrow">Ask your docs</span><h3>Library</h3><div className="lp-tile" style={{ background: '#1D1D1F', color: '#F5F5F7' }}>✦ “Which headers does the payments API need?”</div><div className="lp-sum">It needs <b>Authorization</b> and <b>X‑Request‑Id</b>. The key is in the vault, so you never paste it.</div><div className="lp-tile"><span className="lp-pill lp-p-blue">API</span><span className="lp-grow">Payments API · v2</span></div><div className="lp-tile"><span className="lp-pill lp-p-vio">Design</span><span className="lp-grow">Onboarding architecture</span></div></div>
          <div className={v(4)} aria-hidden={on !== 4}><span className="lp-v-eyebrow">This quarter</span><h3>Insights</h3><div className="lp-kpis"><div><small>On track</small><b>12</b><em>+3</em></div><div><small>Late</small><b>2</b><em>−4</em></div><div><small>Avg. fix</small><b>1.8d</b><em>faster</em></div></div><div className="lp-spark"><svg viewBox="0 0 300 90" preserveAspectRatio="none" aria-hidden="true"><defs><linearGradient id="lp-sg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#0A84FF" stopOpacity=".25"></stop><stop offset="1" stopColor="#0A84FF" stopOpacity="0"></stop></linearGradient></defs><path className="lp-sa" d="M0 70 C40 66 60 72 90 58 S150 50 180 40 S240 26 300 14 L300 90 L0 90Z" fill="url(#lp-sg)"></path><path className="lp-sl" d="M0 70 C40 66 60 72 90 58 S150 50 180 40 S240 26 300 14" fill="none" stroke="#0A84FF" strokeWidth="2.5"></path><circle cx="300" cy="14" r="4" fill="#0A84FF"></circle></svg><span>Delivered per week · last 8 weeks</span></div><div className="lp-sum">✦ Delivery is up for the third week running. One team carries most of the late work.</div></div>
        </div>
      </div></div>
    </section>
  );
});

// ------------------------------------------------------------------ create
const EXAMPLES: [string, string, string, [string, string][]][] = [
  ['Checkout is down for card payments, critical, give it to Rohan', 'ticket', 'Checkout down for card payments', [['Priority', 'Critical'], ['Owner', 'Rohan'], ['Response', '1 hour']]],
  ['Add a retry test for the partner bank by Friday', 'task', 'Retry test for partner bank', [['Project', 'Lending'], ['Owner', 'Dev'], ['Due', 'Friday']]],
  ['Call with Meera and Dev tomorrow 3pm about onboarding', 'meeting', 'Onboarding review', [['When', 'Tomorrow · 3:00 pm'], ['With', 'Meera, Dev'], ['Notes', 'On']]],
  ['Save the sandbox API key and share it with Dev for two days', 'secret', 'Sandbox API key', [['Kind', 'API key'], ['Shared', 'Dev · 2 days']]],
  ['3 hours on KYC-8 today', 'time entry', 'KYC‑8 · dormant accounts', [['Hours', '3h'], ['Day', 'Today'], ['Billable', 'Yes']]],
];
const KINDS = ['Ticket', 'Task', 'Meeting', 'Secret', 'Time'];
const Create = memo(function Create() {
  const reduce = reduceMotion();
  const [cur, setCur] = useState(0);
  const [auto, setAuto] = useState(true);
  const [typed, setTyped] = useState(() => (reduce ? EXAMPLES[0][0].length : 0));
  const [chipsIn, setChipsIn] = useState(() => (reduce ? 9 : 0));
  const [visible, setVisible] = useState(false);
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = ref.current; if (!el || !('IntersectionObserver' in window)) { setVisible(true); return; }
    const io = new IntersectionObserver((es) => setVisible(es[0].isIntersecting), { threshold: .2 });
    io.observe(el); return () => io.disconnect();
  }, []);
  const e = EXAMPLES[cur];
  useEffect(() => {
    if (reduce) { setTyped(e[0].length); setChipsIn(9); return; }
    if (!visible) return;
    let t: number;
    if (typed < e[0].length) t = window.setTimeout(() => setTyped((k) => k + 1), 26);
    else if (chipsIn < e[3].length) t = window.setTimeout(() => setChipsIn((k) => k + 1), 130);
    else if (auto) t = window.setTimeout(() => { setCur((c) => (c + 1) % EXAMPLES.length); setTyped(0); setChipsIn(0); }, 3000);
    return () => window.clearTimeout(t!);
  }, [typed, chipsIn, cur, auto, visible, reduce, e]);
  return (
    <section className="lp-band lp-night" id="create" ref={ref}>
      <div className="lp-wrap">
        <div className="lp-head lp-center lp-reveal"><p className="lp-eyebrow">One “+ New”</p><h2>Say it.<br />It's done.</h2><p>Type it the way you'd say it to a colleague. It knows whether you mean a ticket, a task, a meeting or a secret, and fills in the rest.</p></div>
        <div className="lp-demo lp-reveal">
          <div className="lp-input"><span className="lp-sp" aria-hidden="true">✦</span><span data-lp="typed">{e[0].slice(0, typed)}</span><span className="lp-caret" aria-hidden="true"></span></div>
          <div className="lp-und" aria-live="polite"><span className="lp-k">✦ I understood this as a {e[1]}</span><span className="lp-t">{e[2]}</span>
            <div className="lp-chips">{e[3].map(([k, v], j) => <span key={`${cur}-${k}`} className={`lp-chip${j < chipsIn ? ' lp-in' : ''}`}><span>{k} </span>{v}</span>)}</div>
          </div>
        </div>
        <div className="lp-kinds" role="group" aria-label="Examples">
          {KINDS.map((k, i) => <button key={k} type="button" aria-pressed={cur === i} onClick={() => { setAuto(false); setCur(i); setTyped(reduce ? EXAMPLES[i][0].length : 0); setChipsIn(reduce ? 9 : 0); }}>{k}</button>)}
        </div>
      </div>
    </section>
  );
});

// ------------------------------------------------------------------ AI gallery and everyday moments (static loops in CSS)
const Gallery = memo(function Gallery() {
  return (
<section className="lp-band lp-paper" id="ai" style={{ paddingBottom: '90px' } as CSSProperties}>
  <div className="lp-wrap"><div className="lp-head lp-reveal"><p className="lp-eyebrow" style={{ color: 'var(--blue)' } as CSSProperties}>AI, everywhere you are</p><h2>Never a chatbot in a corner.</h2><p>It shows up on the screen you're already on, with one useful next step.</p></div></div>
  <div className="lp-gallery" id="lp-gallery">
    <article className="lp-g lp-reveal"><h3>The briefing</h3><p>What changed overnight and what needs you, with the reason for each.</p><div className="lp-demo-box lp-lv"><div className="lp-lv-brief"><span className="lp-orb"></span><span>Good morning. <b>3 things need you.</b></span></div><div className="lp-lv-line" style={{ '--i': '0' } as CSSProperties}>Payments failing · critical</div><div className="lp-lv-line" style={{ '--i': '1' } as CSSProperties}>Move KYC Refresh to 12 Dec?</div><div className="lp-lv-line" style={{ '--i': '2' } as CSSProperties}>Review Meera's flow</div></div></article>
    <article className="lp-g lp-dark lp-reveal"><h3>Ask bar</h3><p>Press ⌘K anywhere. It knows which project or ticket is open.</p><div className="lp-demo-box lp-lv"><div className="lp-lv-ask"><span className="lp-orb"></span><span className="lp-lv-type">Show Rohan's late work</span><kbd>⌘K</kbd></div><div className="lp-lv-res" style={{ '--i': '0' } as CSSProperties}><code>LND‑31</code> Partner bank timeout <em>9d</em></div><div className="lp-lv-res" style={{ '--i': '1' } as CSSProperties}><code>LND‑27</code> Retry policy docs <em>3d</em></div></div></article>
    <article className="lp-g lp-reveal"><h3>Inline nudges</h3><p>On a task or a thread, one suggestion and one tap.</p><div className="lp-demo-box lp-lv"><div className="lp-lv-msg">Meera · <span>here's the error I'm seeing</span><i className="lp-lv-img"></i></div><div className="lp-lv-nudge"><span>✦ Attach this to OPS‑142?</span><span className="lp-lv-btn"><span className="lp-a">Attach</span><span className="lp-b">✓ Attached</span></span></div></div></article>
    <article className="lp-g lp-reveal"><h3>Meeting notes</h3><p>Decisions and action items written up after every call, sent to everyone who joined.</p><div className="lp-demo-box lp-lv"><div className="lp-lv-rec"><i></i> Standup · 14 min · notes ready</div><div className="lp-lv-todo" style={{ '--i': '0' } as CSSProperties}><span className="lp-ck"></span>Rohan · retry logic by Friday</div><div className="lp-lv-todo" style={{ '--i': '1' } as CSSProperties}><span className="lp-ck"></span>Aisha · approve the new date</div><div className="lp-lv-todo" style={{ '--i': '2' } as CSSProperties}><span className="lp-ck"></span>Dev · update onboarding doc</div></div></article>
    <article className="lp-g lp-dark lp-reveal"><h3>Your week, drafted</h3><p>Time sheets filled from what you actually worked on. You check, then submit.</p><div className="lp-demo-box lp-lv"><div className="lp-lv-grid"><span>KYC‑8</span><i style={{ '--i': '0' } as CSSProperties}>3h</i><i style={{ '--i': '1' } as CSSProperties}>2h</i><i style={{ '--i': '2' } as CSSProperties}>4h</i><i style={{ '--i': '3' } as CSSProperties}>2h</i><span>OPS‑142</span><i style={{ '--i': '4' } as CSSProperties}>1h</i><i style={{ '--i': '5' } as CSSProperties}>3h</i><i style={{ '--i': '6' } as CSSProperties}>–</i><i style={{ '--i': '7' } as CSSProperties}>2h</i></div><div className="lp-lv-total"><b>34h</b> drafted · <span>Submit</span></div></div></article>
  </div>
  <div className="lp-gnav"><button type="button" aria-label="Previous" id="lp-gp">‹</button><button type="button" aria-label="Next" id="lp-gn">›</button></div>
</section>
  );
});
const Moments = memo(function Moments() {
  return (
<section className="lp-band lp-white" id="moments">
  <div className="lp-wrap">
    <div className="lp-head lp-reveal"><p className="lp-eyebrow" style={{ color: 'var(--blue)' } as CSSProperties}>Everyday moments</p><h2>Mail, meetings, reminders. Handled.</h2><p>The small things that eat a day, done in a line or a tap.</p></div>
    <div className="lp-mo-grid">
      <article className="lp-mo lp-reveal" aria-label="A long email thread becomes a summary with a drafted reply">
        <div className="lp-mo-txt"><h3>Mail, read for you.</h3><p>Long threads become three lines. A reply is drafted in your words, and you decide whether to send it.</p></div>
        <div className="lp-mo-ui lp-mail">
          <div className="lp-thread"><div className="lp-em" style={{ '--i': '0' } as CSSProperties}><b>Bank partner</b><span>Re: Retry timeouts on settlement</span></div><div className="lp-em" style={{ '--i': '1' } as CSSProperties}><b>Rohan</b><span>Re: Re: Retry timeouts…</span></div><div className="lp-em" style={{ '--i': '2' } as CSSProperties}><b>Bank partner</b><span>Re: Re: Re: logs attached</span></div><div className="lp-em" style={{ '--i': '3' } as CSSProperties}><b>Dev</b><span>Re: Re: Re: Re: patch ready?</span></div></div>
          <div className="lp-msum"><p className="lp-mk">✦ 14 emails in 3 lines</p><p>The bank's retries time out after 30s.</p><p>Rohan has a patch; Dev wants it in UAT first.</p><p>They're waiting on your go‑ahead.</p><div className="lp-draft"><span>Draft: “Go ahead in UAT today, prod Friday.”</span><em>Send</em></div></div>
        </div>
      </article>
      <article className="lp-mo lp-reveal" aria-label="A meeting request becomes three suggested times and a sent invite">
        <div className="lp-mo-txt"><h3>Meetings, booked in a sentence.</h3><p>Ask for time with anyone. It finds slots that work, sends the invite and writes the notes afterwards.</p></div>
        <div className="lp-mo-ui lp-sched">
          <div className="lp-ask"><span className="lp-orb"></span><span className="lp-ty">Find 30 min with Meera this week</span></div>
          <div className="lp-slots"><span style={{ '--i': '0' } as CSSProperties}>Wed 11:00</span><span className="lp-pick" style={{ '--i': '1' } as CSSProperties}>Thu 15:30</span><span style={{ '--i': '2' } as CSSProperties}>Fri 10:00</span></div>
          <div className="lp-sent"><b>✓ Invite sent · Thu 15:30</b><span>Meera accepted · notes will be written</span></div>
        </div>
      </article>
      <article className="lp-mo lp-reveal" aria-label="One escalating nudge replaces repeated reminders">
        <div className="lp-mo-txt"><h3>Reminders that don't nag.</h3><p>Say “remind me Friday 4pm.” When work slips, one nudge escalates only as far as it needs to.</p></div>
        <div className="lp-mo-ui lp-nudge">
          <div className="lp-old"><s>Reminder · due today</s><s>Reminder · 1 day overdue</s><s>Reminder · 3 days overdue</s><s>Reminder · 7 days overdue</s></div>
          <div className="lp-steps2"><div style={{ '--i': '0' } as CSSProperties}><i></i><b>Owner</b><span>Day 1 · gentle nudge</span></div><div style={{ '--i': '1' } as CSSProperties}><i></i><b>Lead</b><span>Day 3 · if still stuck</span></div><div style={{ '--i': '2' } as CSSProperties}><i></i><b>Manager</b><span>Day 5 · with context</span></div></div>
        </div>
      </article>
      <article className="lp-mo lp-reveal" aria-label="Notifications reach you in the app, email, WhatsApp or phone, respecting quiet hours">
        <div className="lp-mo-txt"><h3>Reaches you anywhere.</h3><p>App, email or WhatsApp, the way each person chooses. Quiet hours mean quiet.</p></div>
        <div className="lp-mo-ui lp-reach">
          <div className="lp-chs"><span className="lp-on">App</span><span className="lp-on">Email</span><span className="lp-on">WhatsApp</span><span>Phone</span></div>
          <div className="lp-qh"><span>Quiet hours</span><b>22:00 – 07:00</b><i className="lp-sw"></i></div>
          <div className="lp-toast"><span className="lp-orb"></span><div><b>OPS‑142 needs you</b><span>Payments failing · tap to open</span></div></div>
        </div>
      </article>
    </div>
  </div>
</section>
  );
});

// ------------------------------------------------------------------ portfolio
const SLIDES = [
  ['KYC Refresh', 'At risk', '#FF9F0A', 'rgba(255,159,10,.18)', '38%', '12 Dec', 'Rohan', '2 tasks overdue; at this pace it lands 3 weeks late.', 'Move the date to 12 Dec and tell 4 people', 'Accept new date'],
  ['Bank partner retries', 'Late', '#FF453A', 'rgba(255,69,58,.18)', '63%', '9 days late', 'Rohan', 'The partner\'s timeout is 30s; the patch is waiting for UAT.', 'Approve UAT today and production Friday', 'Approve plan'],
  ['Checkout v3', 'On track', '#30D158', 'rgba(48,209,88,.18)', '72%', '14 Nov', 'Aisha', 'Ahead by 2 days. Load test passed on Monday.', 'No decision needed. Celebrate the team', 'Send kudos'],
  ['Data warehouse', 'At risk', '#FF9F0A', 'rgba(255,159,10,.18)', '51%', '2 blockers', 'Dev', 'Waiting on access to two source systems.', 'Ask the platform lead to unblock access', 'Send request'],
];
const Portfolio = memo(function Portfolio() {
  const [view, setView] = useState<'board' | 'time' | 'present'>('board');
  const [i, setI] = useState(0);
  const p = SLIDES[i];
  return (
    <section className="lp-band lp-night" id="portfolio">
      <div className="lp-wrap">
        <div className="lp-head lp-reveal"><p className="lp-eyebrow">Portfolio</p><h2>Every project.<br />Ready for the room.</h2><p>One view of all your projects for the weekly review. Health, forecasts and the decisions that need making, written for you. Switch to Present and walk the team through it.</p></div>
        <div className="lp-pf lp-reveal">
          <div className="lp-pf-top">
            <div className="lp-pf-tabs" role="tablist" aria-label="Portfolio view">
              {([['board', 'Board'], ['time', 'Timeline'], ['present', 'Present']] as const).map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={view === k} onClick={() => setView(k)}>{l}</button>)}
            </div>
            <span className="lp-pf-asof">Example portfolio · 12 projects · as of this morning</span>
          </div>
          <div className="lp-pf-sum">
            <div><small>On track</small><b style={{ color: '#30D158' }}>7</b></div>
            <div><small>At risk</small><b style={{ color: '#FF9F0A' }}>3</b></div>
            <div><small>Late</small><b style={{ color: '#FF453A' }}>2</b></div>
            <div className="lp-pf-ai"><span className="lp-orb"></span><p><b>2 decisions this week.</b> KYC Refresh needs a new date, and Lending holds most of the late work.</p></div>
          </div>
          {view === 'board' && <div className="lp-pf-view lp-on">
        <div className="lp-pf-cols">
          <div className="lp-pf-col"><p className="lp-ch"><i style={{ background: '#30D158' } as CSSProperties}></i>On track</p>
            <div className="lp-pc"><b>Checkout v3</b><span>Payments · Aisha</span><div className="lp-pb"><i style={{ width: '72%', background: '#30D158' } as CSSProperties}></i></div><em>72% · ships 14 Nov</em></div>
            <div className="lp-pc"><b>Partner API</b><span>Platform · Dev</span><div className="lp-pb"><i style={{ width: '58%', background: '#30D158' } as CSSProperties}></i></div><em>58% · ships 2 Dec</em></div>
            <div className="lp-pc"><b>Mobile onboarding</b><span>Growth · Meera</span><div className="lp-pb"><i style={{ width: '44%', background: '#30D158' } as CSSProperties}></i></div><em>44% · ships 9 Dec</em></div></div>
          <div className="lp-pf-col"><p className="lp-ch"><i style={{ background: '#FF9F0A' } as CSSProperties}></i>At risk</p>
            <div className="lp-pc"><b>KYC Refresh</b><span>Compliance · Rohan</span><div className="lp-pb"><i style={{ width: '38%', background: '#FF9F0A' } as CSSProperties}></i></div><em>38% · forecast 12 Dec <s>21 Nov</s></em></div>
            <div className="lp-pc"><b>Data warehouse</b><span>Platform · Dev</span><div className="lp-pb"><i style={{ width: '51%', background: '#FF9F0A' } as CSSProperties}></i></div><em>51% · 2 blockers</em></div></div>
          <div className="lp-pf-col"><p className="lp-ch"><i style={{ background: '#FF453A' } as CSSProperties}></i>Late</p>
            <div className="lp-pc"><b>Bank partner retries</b><span>Lending · Rohan</span><div className="lp-pb"><i style={{ width: '63%', background: '#FF453A' } as CSSProperties}></i></div><em>9 days late</em></div>
            <div className="lp-pc lp-ai"><span className="lp-orb"></span><p>✦ Rohan owns 4 of the 5 late items. Move one to Dev?</p><span className="lp-mini-btn">Suggest a plan</span></div></div>
        </div>
          </div>}
          {view === 'time' && <div className="lp-pf-view lp-on">
        <div className="lp-tl">
          <div className="lp-tl-head"><span></span><span>Oct</span><span>Nov</span><span>Dec</span><span>Jan</span></div>
          <div className="lp-tl-row"><b>Checkout v3</b><div className="lp-tl-track"><i className="lp-bar lp-ok" style={{ left: '4%', width: '46%' } as CSSProperties}></i></div></div>
          <div className="lp-tl-row"><b>Partner API</b><div className="lp-tl-track"><i className="lp-bar lp-ok" style={{ left: '14%', width: '50%' } as CSSProperties}></i></div></div>
          <div className="lp-tl-row"><b>KYC Refresh</b><div className="lp-tl-track"><i className="lp-bar lp-pln" style={{ left: '8%', width: '44%' } as CSSProperties}></i><i className="lp-bar lp-risk" style={{ left: '8%', width: '62%' } as CSSProperties}></i></div></div>
          <div className="lp-tl-row"><b>Data warehouse</b><div className="lp-tl-track"><i className="lp-bar lp-risk" style={{ left: '20%', width: '48%' } as CSSProperties}></i></div></div>
          <div className="lp-tl-row"><b>Bank partner retries</b><div className="lp-tl-track"><i className="lp-bar lp-late" style={{ left: '0%', width: '34%' } as CSSProperties}></i></div></div>
          <div className="lp-tl-row"><b>Mobile onboarding</b><div className="lp-tl-track"><i className="lp-bar lp-ok" style={{ left: '22%', width: '46%' } as CSSProperties}></i></div></div>
          <div className="lp-tl-today" aria-hidden="true"><span>Today</span></div>
          <p className="lp-tl-key"><span><i className="lp-bar lp-ok"></i>On track</span><span><i className="lp-bar lp-risk"></i>Forecast</span><span><i className="lp-bar lp-pln"></i>Original plan</span><span><i className="lp-bar lp-late"></i>Late</span></p>
        </div>
          </div>}
          {view === 'present' && <div className="lp-pf-view lp-on">
            <div className="lp-slide">
              <div className="lp-sl-top"><span>{i + 1} / {SLIDES.length}</span><span className="lp-sl-dots">{SLIDES.map((_, j) => <i key={j} className={j === i ? 'lp-on' : ''}></i>)}</span></div>
              <div className="lp-sl-body" key={i}>
                <div><h3>{p[0]}</h3><span className="lp-sl-st" style={{ color: p[2], background: p[3] }}>{p[1]}</span>
                  <div className="lp-facts2"><div><small>Progress</small><b>{p[4]}</b></div><div><small>Forecast</small><b>{p[5]}</b></div><div><small>Owner</small><b>{p[6]}</b></div></div></div>
                <div className="lp-sl-dec"><span className="lp-k">✦ Decision</span><p>{p[7]}</p><p><b>{p[8]}</b></p><div className="lp-row"><span>{p[9]}</span><span>Discuss</span></div></div>
              </div>
              <div className="lp-sl-nav"><button type="button" aria-label="Previous project" onClick={() => setI((i + SLIDES.length - 1) % SLIDES.length)}>‹</button><button type="button" aria-label="Next project" onClick={() => setI((i + 1) % SLIDES.length)}>›</button></div>
            </div>
          </div>}
        </div>
        <p className="lp-pf-note lp-reveal">Share it as a link, export to PDF or slides, or have it sent to every owner on Monday morning.</p>
      </div>
    </section>
  );
});

const Counts = memo(function Counts() {
  return (
<section className="lp-band lp-white">
  <div className="lp-wrap lp-counts">
    <div className="lp-count lp-reveal"><b data-to="5">5</b><span>places for everything</span></div>
    <div className="lp-count lp-reveal"><b data-to="1">1</b><span>inbox for all you need to do</span></div>
    <div className="lp-count lp-reveal"><b data-to="0">0</b><span>people who can read your secrets but you</span></div>
  </div>
</section>
  );
});
const Trust = memo(function Trust() {
  return (
<section className="lp-band lp-night" id="trust">
  <div className="lp-wrap">
    <div className="lp-head lp-reveal"><p className="lp-eyebrow">Privacy by design</p><h2>Yours. Only yours.</h2><p>Built for teams who answer to auditors. You decide what the assistant can see and what it may do.</p></div>
    <div className="lp-trust">
      <article className="lp-vault lp-reveal" aria-label="A vault secret unlocking with a passkey, then sealing again">
        <div className="lp-vitem">
          <div className="lp-vhead"><span className="lp-vic">DB</span><div><b>Payments database</b><small>Production · shared with 2 people</small></div></div>
          <div className="lp-vfield"><small>Username</small><span>svc_payments</span></div>
          <div className="lp-vfield"><small>Password</small><span className="lp-vval" id="lp-vval">••••••••••••••</span><button type="button" className="lp-vbtn" id="lp-vbtn">Reveal</button></div>
          <div className="lp-vmeta"><span className="lp-cd" id="lp-cd"><svg viewBox="0 0 36 36" aria-hidden="true"><circle cx="18" cy="18" r="15" fill="none" stroke="rgba(255,255,255,.12)" strokeWidth="3"></circle><circle className="lp-cdr" cx="18" cy="18" r="15" fill="none" stroke="#30D158" strokeWidth="3" strokeLinecap="round" strokeDasharray="94.2" strokeDashoffset="0" transform="rotate(-90 18 18)"></circle></svg><em id="lp-cdn">10</em></span><span id="lp-vstate">Sealed. Only people you share with can open it.</span></div>
          <div className="lp-sheet" id="lp-sheet" aria-hidden="true">
            <div className="lp-fp" id="lp-fp"><svg viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M14 30c0-7 4-12 10-12s10 5 10 12"></path><path d="M18 34c0-6 2-10 6-10s6 4 6 10"></path><path d="M24 30v8"></path><path d="M10 24c1-9 7-15 14-15s13 6 14 15"></path></svg></div>
            <b id="lp-sheetT">Confirm with passkey</b><small id="lp-sheetS">Touch the sensor to continue</small>
          </div>
        </div>
      </article>
      <div className="lp-points">
        <div className="lp-point lp-reveal"><b>It only sees what you see.</b><span>The assistant works with your own permissions, never more.</span></div>
        <div className="lp-point lp-reveal"><b>It asks before it acts.</b><span>Choose Off, Suggest, Ask first or Auto for each kind of work.</span></div>
        <div className="lp-point lp-reveal"><b>Your data stays in your region.</b><span>Hosted close to you, with regular independent security reviews.</span></div>
      </div>
    </div>
  </div>
</section>
  );
});
const Tools = memo(function Tools() {
  return (
<section className="lp-band lp-paper" id="tools">
  <div className="lp-wrap">
    <div className="lp-head lp-center lp-reveal"><p className="lp-eyebrow" style={{ color: 'var(--blue)' } as CSSProperties}>Works with your tools</p><h2>Fits in. Nothing to rip out.</h2></div>
    <div className="lp-tools lp-reveal" aria-label="Integrations"><span>Slack</span><span>WhatsApp Business</span><span>Google Calendar</span><span>Outlook</span><span>Gmail</span><span>Any IMAP mail</span><span>GitHub</span><span>Azure DevOps</span><span>Google Meet</span><span>Microsoft Teams</span><span>Webhooks</span><span>REST API</span><span>Claude &amp; ChatGPT</span></div>
    <div className="lp-teams">
      <article className="lp-team lp-reveal"><p className="lp-tk">Operations</p><h3>Tickets with service levels.</h3><p>Every request gets an owner, a deadline and a nudge before it slips. Triage happens on its own.</p></article>
      <article className="lp-team lp-reveal"><p className="lp-tk">Lending &amp; finance</p><h3>Delivery you can show an auditor.</h3><p>Secrets in a sealed vault, every change on record, and dates that move only when someone agrees.</p></article>
      <article className="lp-team lp-reveal"><p className="lp-tk">Engineering &amp; support</p><h3>APIs documented while you build.</h3><p>Paste a request and get a documented endpoint. Docs answer questions, so people stop asking you.</p></article>
    </div>
  </div>
</section>
  );
});

// ------------------------------------------------------------------ pricing
interface PublicPricing { policy?: { annualDiscountPercent: number }; plans?: { code: string; priceMonthly: number | null; perSeat: boolean }[] }
const fmtInr = (n: number) => `₹${new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(n)}`;
const Pricing = memo(function Pricing() {
  const [yearly, setYearly] = useState(false);
  // Starting prices; the live price list replaces them when it answers.
  const q = useQuery({
    queryKey: ['public', 'pricing'], staleTime: 10 * 60_000, retry: false,
    queryFn: async () => { const r = await fetch(apiUrl('/public/pricing'), { headers: { Accept: 'application/json' } }); if (!r.ok) return null; const j = await r.json(); return (j.data ?? j) as PublicPricing; },
  });
  const annual = q.data?.policy?.annualDiscountPercent ?? 20;
  const unit = (code: string, fallback: number) => q.data?.plans?.find((p) => p.code === code)?.priceMonthly ?? fallback;
  const price = (code: string, fallback: number) => fmtInr(yearly ? Math.round(unit(code, fallback) * (100 - annual) / 100) : unit(code, fallback));
  const per = yearly ? 'per person / month, billed yearly' : 'per person / month';
  return (
    <section className="lp-band lp-white" id="pricing">
      <div className="lp-wrap">
        <div className="lp-head lp-center lp-reveal"><p className="lp-eyebrow" style={{ color: 'var(--blue)' }}>Pricing</p><h2>Start free. Pay per person.</h2><p>Every paid plan has a 14‑day trial for up to 5 people, no card needed.</p></div>
        <div className="lp-bill lp-reveal" role="group" aria-label="Billing period"><button type="button" aria-pressed={!yearly} onClick={() => setYearly(false)}>Monthly</button><button type="button" aria-pressed={yearly} onClick={() => setYearly(true)}>Yearly <em>save {annual}%</em></button></div>
        <div className="lp-plans">
          <article className="lp-plan lp-reveal"><h3>Free</h3><p className="lp-pr"><b>₹0</b><span>forever</span></p><p className="lp-pd">For one person getting organised.</p><ul><li>5 projects, 500 tasks</li><li>Reminders, calendar, timesheets</li><li>Up to 10 documents</li><li>Passkey sign‑in</li><li>Try the assistant and notetaker</li></ul><Link className="lp-btn lp-plan-btn" to="/signup">Start free</Link></article>
          <article className="lp-plan lp-reveal"><h3>Pro</h3><p className="lp-pr"><b data-price="PRO">{price('PRO', 449)}</b><span>{per}</span></p><p className="lp-pd">For teams running projects together.</p><ul><li>Unlimited projects, tasks and teams</li><li>Unlimited documents, 2,000 API endpoints</li><li>Meeting notetaker</li><li>Mobile and desktop apps</li><li>80 AI credits per person</li></ul><Link className="lp-btn lp-plan-btn" to="/signup?type=organization">Try Pro free</Link></article>
          <article className="lp-plan lp-best lp-reveal"><span className="lp-tag2">Most complete</span><h3>Business</h3><p className="lp-pr"><b data-price="BUSINESS">{price('BUSINESS', 999)}</b><span>{per}</span></p><p className="lp-pd">For teams with service levels and audits.</p><ul><li>Everything in Pro</li><li>Operations desk with service levels</li><li>AI employee for calls and WhatsApp</li><li>Vault with reveal timer and audit trail</li><li>Single sign‑on, audit log, API access</li><li>300 AI credits per person</li></ul><Link className="lp-btn lp-btn-blue lp-plan-btn" to="/signup?type=organization">Try Business free</Link></article>
          <article className="lp-plan lp-reveal"><h3>Enterprise</h3><p className="lp-pr"><b>Custom</b><span>to your contract</span></p><p className="lp-pd">For large organisations.</p><ul><li>Everything in Business</li><li>Unlimited members and storage</li><li>Shared AI pool</li><li>Your own phone and WhatsApp numbers</li><li>Priority onboarding, named contact</li></ul><a className="lp-btn lp-plan-btn" href={supportMailto('Enterprise plan')}>Talk to us</a></article>
        </div>
        <p className="lp-fine lp-reveal">Prices in Indian rupees, excluding GST. Team discounts apply automatically: 10% at 10+ people, 15% at 25+, 20% at 100+, and they stack with yearly billing up to 30% off. Pay by UPI, card or netbanking. <a href="/pricing/">Compare every plan ›</a></p>
      </div>
    </section>
  );
});

const Faq = memo(function Faq() {
  return (
<section className="lp-band lp-paper" id="faq">
  <div className="lp-wrap" style={{ maxWidth: '820px' } as CSSProperties}>
    <div className="lp-head lp-center lp-reveal" style={{ marginBottom: '36px' } as CSSProperties}><h2>Questions</h2></div>
    <div className="lp-faq">
      <details className="lp-reveal"><summary>What can the assistant see?</summary><p>Only what the person asking can already see. It uses your own permissions and never more, and you choose for each kind of work whether it may suggest, ask first, or act on its own.</p></details>
      <details className="lp-reveal"><summary>Why does the briefing show only three things?</summary><p>So you can read it in ten seconds. It picks the three most urgent, and everything else waits in your inbox, ranked.</p></details>
      <details className="lp-reveal"><summary>How long does setup take?</summary><p>Minutes. Invite your team, connect mail and calendar if you like, and your first briefing is ready the next morning.</p></details>
      <details className="lp-reveal"><summary>What happens when AI credits run out?</summary><p>The assistant pauses until credits renew on the 1st. Everything else keeps working as normal.</p></details>
      <details className="lp-reveal"><summary>Can I change plans or cancel?</summary><p>Yes, any time from Billing. Added seats take effect immediately and you're never charged twice for the same period.</p></details>
    </div>
  </div>
</section>
  );
});

// ------------------------------------------------------------------ final call to action: the existing sign-in and sign-up flows
function Final() {
  const navigate = useNavigate();
  const providers = useQuery({ queryKey: ['auth', 'providers'], queryFn: authApi.providers, staleTime: 5 * 60_000, retry: false });
  const has = (id: string) => providers.data?.providers.some((p) => p.id === id) ?? false;
  /** An outside sign-in this installation has set up starts right here; otherwise the sign-in page offers every option there is. */
  const outside = useCallback((id: 'google' | 'microsoft') => {
    if (has(id)) void startOutsideSignIn(apiUrl(`/auth/external/${id}/start?returnUrl=${encodeURIComponent('/')}`));
    else navigate('/login');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providers.data, navigate]);
  return (
    <section className="lp-final lp-white" id="start" aria-label="Get started">
      <div className="lp-wrap">
        <h2>Let the work<br />move itself.</h2>
        <p className="lp-final-sub">Bring your projects and your team. Your first briefing is ready the next morning.</p>
        <div className="lp-final-main">
          <Link className="lp-btn lp-btn-blue" to="/signup">Create account</Link>
          <Link className="lp-btn lp-btn-outline" to="/login">Sign in</Link>
        </div>
        <div className="lp-final-alt" aria-label="Other ways to sign in">
          <button type="button" className="lp-alt" onClick={() => outside('google')}>{PROVIDER_ICON.google}<span>Continue with Google</span></button>
          <button type="button" className="lp-alt" onClick={() => outside('microsoft')}>{PROVIDER_ICON.microsoft}<span>Continue with Microsoft</span></button>
          <Link className="lp-alt" to="/login?sso=1"><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16" /><path d="M16 9h2a2 2 0 0 1 2 2v10M2 21h20M8 7h4M8 11h4M8 15h4" /></svg><span>Single sign-on (SSO)</span></Link>
        </div>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="lp-foot"><div className="lp-wrap">
      <span>© 2026 ProjectTracker · All names and data shown are examples.</span>
      <nav aria-label="Legal and help"><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="/security/">Security</a><a href={supportMailto('Hello from the website')}>Contact {SUPPORT_EMAIL}</a></nav>
    </div></footer>
  );
}

// ------------------------------------------------------------------ the page and its scroll scenes
export default function LandingPage() {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = root.current!;
    const $ = <T extends Element = HTMLElement>(s: string) => el.querySelector<T>(s);
    const $$ = <T extends Element = HTMLElement>(s: string) => Array.from(el.querySelectorAll<T>(s));
    const reduce = reduceMotion();
    const timers: number[] = [], intervals: number[] = [], observers: IntersectionObserver[] = [], off: (() => void)[] = [];
    const later = (fn: () => void, ms: number) => { timers.push(window.setTimeout(fn, ms)); };
    const words = $$('[data-lp="statement"] span');
    const io = (target: Element, fn: (v: boolean) => void, threshold = 0) => {
      if (!('IntersectionObserver' in window)) { fn(true); return; }
      const o = new IntersectionObserver((es) => fn(es[0].isIntersecting), { threshold }); o.observe(target); observers.push(o);
    };

    // The finished state of every scene, for "reduce motion".
    if (reduce) {
      words.forEach((s) => s.classList.add('lp-lit'));
      const cine = $('[data-lp="cine"]');
      if (cine) { cine.className = 'lp-cine lp-reveal lp-p2'; $$('#lp-phases li').forEach((l, i) => l.classList.toggle('lp-on', i === 2)); }
      return;
    }

    // hero window rising flat, words lighting up
    const hero = $('[data-lp="hero"]')!, device = $('[data-lp="device"]')!, copy = $('[data-lp="copy"]')!, wordsSec = $('[data-lp="words"]')!;
    let raf = 0;
    const scene = () => {
      raf = 0;
      const p = progress(hero), t = clamp(p / .7);
      device.style.transform = `rotateX(${28 * (1 - t)}deg) scale(${.86 + .14 * t}) translateY(${-40 * t}px)`;
      copy.style.opacity = String(1 - clamp((p - .45) / .4));
      copy.style.transform = `translateY(${-60 * clamp(p / .9)}px) scale(${1 - .06 * clamp(p)})`;
      const lit = Math.round(progress(wordsSec) * 1.25 * words.length);
      words.forEach((s, i) => s.classList.toggle('lp-lit', i < lit));
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(scene); };
    window.addEventListener('scroll', onScroll, { passive: true }); window.addEventListener('resize', onScroll);
    off.push(() => { window.removeEventListener('scroll', onScroll); window.removeEventListener('resize', onScroll); cancelAnimationFrame(raf); });
    scene();

    // the briefing types itself, rows get handled one by one, the ask bar cycles
    const brief = $('[data-lp="brief"]')!;
    let bi = 0, heroOn = true;
    io(hero, (v) => { heroOn = v; });
    const typeBrief = () => {
      const s = BRIEFS[bi % BRIEFS.length]; let k = 0;
      brief.textContent = '';
      const tn = document.createTextNode(''), c = document.createElement('span'); c.className = 'lp-caret';
      brief.append(tn, c);
      const step = () => { k++; tn.nodeValue = s.slice(0, k); if (k < s.length) later(step, 22); else later(() => { bi++; typeBrief(); }, 3400); };
      step();
    };
    typeBrief();
    const rows = $$('[data-lp="rows"] .lp-s-row');
    let ri = 0;
    intervals.push(window.setInterval(() => {
      if (!heroOn) return;
      if (ri < rows.length) { rows[ri].classList.add('lp-done'); rows[ri].querySelector('.lp-act')!.textContent = `✓ ${ROW_DONE[ri]}`; ri++; }
      else { rows.forEach((r, i) => { r.classList.remove('lp-done'); r.querySelector('.lp-act')!.textContent = ROW_LABELS[i]; }); ri = 0; }
    }, 2200));
    const ask = $('[data-lp="ask"]')!; let ai = 0;
    intervals.push(window.setInterval(() => { if (heroOn) { ai = (ai + 1) % ASKS.length; ask.textContent = ASKS[ai]; } }, 2600));

    // how it thinks: sources flow into the orb, the briefing writes itself, then it is handled
    const cine = $('[data-lp="cine"]');
    if (cine) {
      const sc = $$('[data-lp="cine"] .lp-sc'), bis = $$('[data-lp="cine"] .lp-bi'), ph = $$('#lp-phases li');
      const T = $('#lp-mindT')!, S = $('#lp-mindS')!;
      let ctimers: number[] = [], playing = false;
      const at = (ms: number, fn: () => void) => { ctimers.push(window.setTimeout(fn, ms)); };
      const phase = (n: number) => { cine.className = `lp-cine lp-reveal lp-p${n}`; ph.forEach((l, i) => l.classList.toggle('lp-on', i === n)); };
      const cycle = () => {
        ctimers.forEach(clearTimeout); ctimers = [];
        sc.forEach((c) => { c.className = 'lp-sc lp-pre'; }); bis.forEach((b) => { b.className = 'lp-bi lp-pre'; });
        phase(0); T.textContent = 'Listening'; S.textContent = '5 sources';
        sc.forEach((c, i) => at(150 + i * 220, () => { c.className = 'lp-sc'; }));
        at(2600, () => { phase(1); T.textContent = 'Connecting'; S.textContent = '128 updates → 3 stories'; sc.forEach((c, i) => at(i * 160, () => { c.className = 'lp-sc lp-gone'; })); });
        at(5200, () => { phase(2); T.textContent = 'Briefing ready'; S.textContent = '3 things need you'; bis.forEach((b, i) => at(i * 380, () => { b.className = 'lp-bi'; })); });
        at(7800, () => { phase(3); T.textContent = 'Done'; S.textContent = 'Every step logged'; bis.forEach((b, i) => at(300 + i * 350, () => { b.className = 'lp-bi lp-done'; })); });
        at(11200, () => { if (playing) cycle(); });
      };
      io(cine, (v) => { if (v && !playing) { playing = true; cycle(); } else if (!v) playing = false; }, .35);
      off.push(() => ctimers.forEach(clearTimeout));
    }

    // the vault: passkey sheet, reveal for ten seconds, seal again
    const val = $('#lp-vval');
    if (val) {
      const btn = $('#lp-vbtn')!, sheet = $('#lp-sheet')!, fp = $('#lp-fp')!, st = $('#lp-sheetT')!, ss = $('#lp-sheetS')!, cd = $('#lp-cd')!, cdr = $<SVGCircleElement>('.lp-cdr')!, cdn = $('#lp-cdn')!, vs = $('#lp-vstate')!;
      let busy = false, vt: number[] = [];
      const vl = (fn: () => void, ms: number) => { vt.push(window.setTimeout(fn, ms)); };
      const seal = () => { val.textContent = '••••••••••••••'; btn.textContent = 'Reveal'; cd.classList.remove('lp-on'); vs.textContent = 'Sealed. Only people you share with can open it.'; busy = false; };
      const run = () => {
        if (busy) return; busy = true; vt.forEach(clearTimeout); vt = [];
        sheet.classList.add('lp-on'); fp.className = 'lp-fp'; st.textContent = 'Confirm with passkey'; ss.textContent = 'Touch the sensor to continue';
        vl(() => fp.classList.add('lp-scan'), 700);
        vl(() => { fp.className = 'lp-fp lp-ok'; st.textContent = 'Confirmed'; ss.textContent = 'Logged in the audit trail'; }, 1700);
        vl(() => {
          sheet.classList.remove('lp-on'); val.textContent = 'example‑Pa55‑only'; btn.textContent = 'Copy'; vs.textContent = 'Visible for 10 seconds. Clipboard clears itself.'; cd.classList.add('lp-on');
          let n = 10; cdn.textContent = String(n); cdr.style.strokeDashoffset = '0';
          const tick = () => { if (n <= 0) { seal(); return; } vl(() => { n--; cdn.textContent = String(n); cdr.style.strokeDashoffset = String(94.2 * (1 - n / 10)); tick(); }, 1000); };
          tick();
        }, 2500);
      };
      const click = () => { if (btn.textContent === 'Reveal') run(); };
      btn.addEventListener('click', click);
      io(val.closest('.lp-vitem')!, (v) => { if (v) run(); }, .6);
      intervals.push(window.setInterval(() => { const r = val.getBoundingClientRect(); if (r.top > 0 && r.bottom < window.innerHeight) run(); }, 16000));
      off.push(() => { btn.removeEventListener('click', click); vt.forEach(clearTimeout); });
    }

    // the gallery: arrows and a gentle tilt under the pointer
    const gal = $('#lp-gallery');
    const gp = $('#lp-gp'), gn = $('#lp-gn');
    const prev = () => gal?.scrollBy({ left: -400, behavior: 'smooth' }), next = () => gal?.scrollBy({ left: 400, behavior: 'smooth' });
    gp?.addEventListener('click', prev); gn?.addEventListener('click', next);
    off.push(() => { gp?.removeEventListener('click', prev); gn?.removeEventListener('click', next); });
    if (window.matchMedia('(hover: hover)').matches) {
      $$('.lp-g').forEach((c) => {
        c.classList.add('lp-tilt');
        const move = (e: PointerEvent) => { const r = c.getBoundingClientRect(), px = (e.clientX - r.left) / r.width - .5, py = (e.clientY - r.top) / r.height - .5; c.style.transform = `perspective(1200px) rotateY(${px * 4}deg) rotateX(${-py * 4}deg) translateY(-4px)`; };
        const leave = () => { c.style.transform = ''; };
        c.addEventListener('pointermove', move); c.addEventListener('pointerleave', leave);
        off.push(() => { c.removeEventListener('pointermove', move); c.removeEventListener('pointerleave', leave); });
      });
    }

    // reveal: visible at rest, lifts in when first scrolled to
    if ('IntersectionObserver' in window) {
      const els = $$('.lp-reveal'), vh = window.innerHeight;
      els.forEach((e) => { if (e.getBoundingClientRect().top > vh) e.classList.add('lp-pending'); });
      const ro = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.remove('lp-pending'); ro.unobserve(e.target); } }), { threshold: .15 });
      els.forEach((e) => ro.observe(e)); observers.push(ro);
    }

    return () => { timers.forEach(clearTimeout); intervals.forEach(clearInterval); observers.forEach((o) => o.disconnect()); off.forEach((f) => f()); };
  }, []);

  return (
    <div className="lp-root" ref={root}>
      <a className="lp-skip" href="#lp-top" onClick={(e) => onAnchor(e)}>Skip to content</a>
      <Nav />
      <main id="lp-top">
        <Hero />
        <Words />
        <Core />
        <Five />
        <Create />
        <Gallery />
        <Moments />
        <Portfolio />
        <Counts />
        <Trust />
        <Tools />
        <Pricing />
        <Faq />
        <Final />
      </main>
      <Footer />
    </div>
  );
}

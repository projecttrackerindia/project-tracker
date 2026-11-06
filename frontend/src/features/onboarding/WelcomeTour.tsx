import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { useQueryClient } from '@tanstack/react-query';
import { CalmSheet } from '../../components/calm';
import { Icon, type IconName } from '../../components/Icon';
import { Logo, BRAND } from '../../components/Logo';
import { del, get, post, put } from '../../api/client';
import { useAuth, useModule } from '../../stores/auth';
import { useMainNav, inRail } from '../../layouts/navigation';
import { gentleSpring } from '../../lib/motion';
import { toast } from '../../stores/ui';
import type { TourState } from './open';
import './welcome.css';

interface Sample { exists: boolean; projectId: string | null; name: string | null; tasks: number }

const STEPS = ['welcome', 'places', 'sample', 'done'] as const;
type Step = (typeof STEPS)[number];
const TINTS = ['#5856d6', '#34c759', '#0a84ff', '#ff9f0a', '#af52de'];

const save = (value: TourState) => put('/me/ui/onboarding', { value }).catch(() => { /* the tour may show again; nothing is lost */ });

/**
 * The welcome tour: four calm pages in one sheet (a centred card on a computer, a bottom sheet on a phone). What ProjectTracker is, where
 * things live (the person's own places, as their role sees them), a sample project to explore with (added and removed in one click), and
 * three things worth knowing. Where the person got to is saved with their account, so it never nags.
 */
export default function WelcomeTour({ onClose }: { onClose: () => void }) {
  const [i, setI] = useState(0);
  const [dir, setDir] = useState(1);
  const [hasSample, setHasSample] = useState(false);
  const name = useAuth((s) => s.ctx?.user.displayName?.split(' ')[0] ?? '');
  const step: Step = STEPS[i];
  const go = (n: number) => { setDir(n > i ? 1 : -1); setI(n); void save({ step: n }); };
  const finish = () => { void save({ done: true, step: i, at: new Date().toISOString() }); onClose(); };
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => { body.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus(); }, [i]);
  return (
    <CalmSheet open onClose={finish} kind="bottom" width={760} label="Welcome to ProjectTracker">
      <div className="wt" ref={body} data-step={step}>
        <AnimatePresence mode="wait" initial={false} custom={dir}>
          <motion.section key={step} className="wt-page" custom={dir}
            initial={{ opacity: 0, x: 28 * dir }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -28 * dir }} transition={gentleSpring}>
            {step === 'welcome' && <Welcome name={name} />}
            {step === 'places' && <Places />}
            {step === 'sample' && <SampleStep onDone={() => go(3)} onSample={setHasSample} />}
            {step === 'done' && <Done onFinish={finish} />}
          </motion.section>
        </AnimatePresence>
        <footer className="wt-foot">
          <div className="wt-dots" role="tablist" aria-label="Tour pages">
            {STEPS.map((s, n) => (
              <button key={s} type="button" role="tab" aria-selected={n === i} aria-label={`Page ${n + 1} of ${STEPS.length}`}
                className={n === i ? 'on' : ''} onClick={() => go(n)} />
            ))}
          </div>
          <div className="wt-acts">
            {i > 0 && step !== 'done' && <button type="button" className="wt-back" onClick={() => go(i - 1)}>Back</button>}
            {i === 0 && <button type="button" className="wt-back" onClick={finish}>Skip</button>}
            {step !== 'done' && step !== 'sample' && <button type="button" className="wt-go" data-autofocus onClick={() => go(i + 1)}>Continue</button>}
            {step === 'sample' && <button type="button" className="wt-back" onClick={() => go(3)}>{hasSample ? 'Continue' : 'Not now'}</button>}
          </div>
        </footer>
      </div>
    </CalmSheet>
  );
}

function Welcome({ name }: { name: string }) {
  const rows: { icon: IconName; tint: string; title: string; text: string }[] = [
    { icon: 'folder', tint: '#5856d6', title: 'Plan the work', text: 'Projects, tasks and timelines, with dates people can trust.' },
    { icon: 'message', tint: '#34c759', title: 'Work together', text: 'Messages, meetings and approvals sit beside the work they are about.' },
    { icon: 'sparkle', tint: '#af52de', title: 'Ask Aura', text: 'Search everything and get answers in one place. Press ⌘K any time.' },
  ];
  return (
    <>
      <motion.div className="wt-logo" initial={{ scale: 0.86, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={gentleSpring}><Logo size={64} /></motion.div>
      <h2 className="wt-title">Welcome{name ? `, ${name}` : ''}.<em>This is {BRAND}.</em></h2>
      <ul className="wt-feats">
        {rows.map((r, n) => (
          <motion.li key={r.title} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ ...gentleSpring, delay: 0.06 * (n + 1) }}>
            <span className="wt-ico" style={{ color: r.tint }}><Icon name={r.icon} size={26} /></span>
            <div><b>{r.title}</b><span>{r.text}</span></div>
          </motion.li>
        ))}
      </ul>
    </>
  );
}

function Places() {
  const places = useMainNav().flatMap((g) => g.items).filter(inRail).slice(0, 6);
  return (
    <>
      <h2 className="wt-title sm">Everything has one place.<em>Five places on the left; the tab bar on a phone.</em></h2>
      <ul className="wt-places">
        {places.map((p, n) => (
          <li key={p.id}>
            <span className="wt-tile" style={{ background: TINTS[n % TINTS.length] }}><Icon name={p.icon as IconName} size={18} /></span>
            <div><b>{p.label}</b><span>{p.hint}</span></div>
          </li>
        ))}
        <li>
          <span className="wt-tile plus"><Icon name="plus" size={18} /></span>
          <div><b>New</b><span>The + button adds a task, meeting, note or anything else, from any page.</span></div>
        </li>
      </ul>
    </>
  );
}

function SampleStep({ onDone, onSample }: { onDone: () => void; onSample: (v: boolean) => void }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const canAdd = useModule('projects') >= 2;
  const [sample, setSample] = useState<Sample | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { void get<Sample>('/onboarding/sample-project').then(setSample).catch(() => setSample({ exists: false, projectId: null, name: null, tasks: 0 })); }, []);
  const add = async () => {
    setBusy(true);
    try { const s = await post<Sample>('/onboarding/sample-project'); setSample(s); void qc.invalidateQueries(); }
    catch (e) { toast(e instanceof Error ? e.message : 'Could not add the sample project.', 'error'); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    setBusy(true);
    try { setSample(await del<Sample>('/onboarding/sample-project')); void qc.invalidateQueries(); toast('Sample project removed.'); }
    catch (e) { toast(e instanceof Error ? e.message : 'Could not remove the sample project.', 'error'); }
    finally { setBusy(false); }
  };
  const added = !!sample?.exists;
  useEffect(() => { onSample(added); }, [added, onSample]);
  return (
    <>
      <h2 className="wt-title sm">Try it with a sample project.<em>Explore freely, then remove it in one click.</em></h2>
      <div className={`wt-board ${added ? 'added' : ''}`} aria-hidden="true">
        {['To do', 'In progress', 'Done'].map((col, c) => (
          <div key={col} className="wt-col">
            <p>{col}</p>
            {Array.from({ length: c === 0 ? 3 : c === 1 ? 2 : 1 }).map((_, n) => (
              <motion.i key={n} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ ...gentleSpring, delay: 0.05 * (c * 3 + n) }}><b /><s /></motion.i>
            ))}
          </div>
        ))}
      </div>
      <ul className="wt-facts">
        <li><Icon name="checks" size={16} />Six tasks across to do, in progress and done</li>
        <li><Icon name="calendar" size={16} />Dates around today, so Timeline and Calendar fill in</li>
        <li><Icon name="undo" size={16} />Remove it any time, from here or Settings</li>
      </ul>
      <div className="wt-sample-acts">
        {!added && canAdd && <button type="button" className="wt-go" data-autofocus disabled={busy || !sample} onClick={() => void add()}>{busy ? 'Adding…' : 'Add sample project'}</button>}
        {added && (
          <>
            <span className="wt-added" role="status"><Icon name="check" size={14} />Added · {sample?.tasks} tasks</span>
            <button type="button" className="wt-go" data-autofocus onClick={() => { onDone(); if (sample?.projectId) nav(`/projects/${sample.projectId}`); }}>Open it</button>
            <button type="button" className="wt-link" disabled={busy} onClick={() => void remove()}>Remove</button>
          </>
        )}
        {!added && !canAdd && <p className="wt-note">Ask a workspace admin to add the sample project for everyone.</p>}
        {!added && <button type="button" className="wt-link" onClick={onDone}>Start empty</button>}
      </div>
      <p className="wt-note">Coming from Excel, Jira, Trello or Asana? Open a project’s ⋯ menu and choose Import tasks.</p>
    </>
  );
}

function Done({ onFinish }: { onFinish: () => void }) {
  const tips: { k: string; text: string }[] = [
    { k: '⌘K', text: 'Ask Aura or find anything' },
    { k: '+', text: 'Add a task, meeting or note' },
    { k: '⋯', text: 'Replay this tour from your account menu' },
  ];
  return (
    <>
      <motion.div className="wt-check" initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={gentleSpring}>
        <svg viewBox="0 0 52 52" width="64" height="64" aria-hidden="true">
          <circle cx="26" cy="26" r="25" fill="var(--calm-green, #34c759)" />
          <motion.path d="M15 27l7 7 15-16" fill="none" stroke="#fff" strokeWidth="4.4" strokeLinecap="round" strokeLinejoin="round"
            initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.34, delay: 0.12, ease: [0, 0, 0, 1] }} />
        </svg>
      </motion.div>
      <h2 className="wt-title">You’re all set.<em>Three things worth knowing.</em></h2>
      <ul className="wt-tips">{tips.map((t) => <li key={t.k}><kbd>{t.k}</kbd><span>{t.text}</span></li>)}</ul>
      <div className="wt-sample-acts"><button type="button" className="wt-go" data-autofocus onClick={onFinish}>Get started</button></div>
    </>
  );
}

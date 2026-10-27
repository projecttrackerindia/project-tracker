import { taskApi } from '../../api/endpoints';
import { invalidateWorkspace } from '../../lib/hooks';
import { useAuth } from '../../stores/auth';
import { toast } from '../../stores/ui';
import type { MadeTask } from '../chat/MessageExtras';

const reduced = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dueText = (d: string) => { const x = new Date(`${d}T00:00:00`); return `due ${x.toLocaleDateString('en-GB', { weekday: 'short' })} ${x.getDate()} ${MONTHS[x.getMonth()]}`; };

/**
 * "Make task" in Talk: the bubble's text lifts into a small task card (120 ms), flies along an arc to My Work in the sidebar (420 ms spring,
 * scale 1 → 0.4), the My Work badge bumps with "+1", and a toast offers Undo for 4 s (Undo deletes the task). With reduced motion only the
 * toast shows.
 */
export function flyToMyWork(from: Element | null, t: MadeTask) {
  const wid = useAuth.getState().ctx?.current?.id ?? null;
  const target = document.querySelector<HTMLElement>('.v2-side [data-place="work"]');
  const done = () => {
    void invalidateWorkspace(wid, 'dashboard');
    if (target && !reduced()) {
      const badge = target.querySelector<HTMLElement>('.v2-badge');
      badge?.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.2)' }, { transform: 'scale(1)' }], { duration: 180, easing: 'ease-out' });
      target.animate([{ background: 'rgba(255,149,0,.14)' }, { background: 'rgba(255,149,0,.14)', offset: .7 }, { background: 'transparent' }], { duration: 900 });
      const r = target.getBoundingClientRect();
      const plus = document.createElement('span');
      plus.className = 'talk-plus1'; plus.textContent = '+1';
      plus.style.left = `${r.right - 26}px`; plus.style.top = `${r.top - 6}px`;
      document.body.appendChild(plus);
      plus.animate([{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'translateY(0)', offset: .2 }, { opacity: 1, offset: .8 }, { opacity: 0, transform: 'translateY(-6px)' }], { duration: 1100 })
        .finished.finally(() => plus.remove());
    }
    const who = t.assigneeName ? ` · assigned to ${t.assigneeName.split(' ')[0]}` : '';
    undoToast(`Task added to My Work${who}`, () => {
      taskApi.remove(t.id).then(() => { void invalidateWorkspace(wid, 'dashboard'); toast('Task removed.', 'info'); })
        .catch(() => toast('Could not undo. Open My Work to remove it.', 'error'));
    });
  };
  if (!from || !target || reduced()) { done(); return; }

  const a = from.getBoundingClientRect(), b = target.getBoundingClientRect();
  const card = document.createElement('div');
  card.className = 'talk-fly';
  card.setAttribute('aria-hidden', 'true');
  const meta = [t.assigneeName, t.due ? dueText(t.due) : null, t.projectName].filter(Boolean).join(' · ');
  card.innerHTML = '<span class="talk-fly-chk"></span><div><b></b><small></small></div>';
  card.querySelector('b')!.textContent = t.title;
  card.querySelector('small')!.textContent = meta;
  card.style.left = `${a.left}px`; card.style.top = `${a.top}px`;
  document.body.appendChild(card);
  (from as HTMLElement).animate([{ opacity: 1 }, { opacity: .45 }, { opacity: 1 }], { duration: 700 });
  const dx = b.left + 12 - a.left, dy = b.top + b.height / 2 - a.top - 18;
  // Lift (0 → 22% ≈ 120 ms), then an arc: up and over towards the sidebar, shrinking to 0.4.
  const anim = card.animate([
    { transform: 'translate(0,0) scale(1) rotate(0deg)', opacity: 1, boxShadow: '0 1px 3px rgba(0,0,0,.1)' },
    { transform: 'translate(0,-8px) scale(.9) rotate(-4deg)', opacity: 1, offset: .22 },
    { transform: `translate(${dx * .55}px, ${dy * .45 - 60}px) scale(.65) rotate(-3deg)`, opacity: .95, offset: .6 },
    { transform: `translate(${dx}px, ${dy}px) scale(.4) rotate(0deg)`, opacity: .6 },
  ], { duration: 540, easing: 'cubic-bezier(.3,1.25,.5,1)', fill: 'forwards' });
  anim.finished.finally(() => { card.remove(); done(); });
}

/** A dark capsule centred over the open pane (or the window) with Undo, for 4 s; Escape or Undo closes it. */
export function undoToast(text: string, onUndo: () => void, anchor: Element | null = document.querySelector('.talk-pane'), above = 132) {
  document.querySelectorAll('.talk-toast').forEach((e) => e.remove());
  const el = document.createElement('div');
  el.className = 'talk-toast'; el.setAttribute('role', 'status'); el.setAttribute('aria-live', 'polite');
  el.innerHTML = '<span class="ok" aria-hidden="true">✓</span><span></span><button type="button">Undo</button>';
  el.children[1].textContent = text;
  const r = anchor?.getBoundingClientRect();
  el.style.left = `${r ? r.left + r.width / 2 : window.innerWidth / 2}px`;
  el.style.top = `${r ? Math.min(r.bottom, window.innerHeight) - above : window.innerHeight - 120}px`;
  document.body.appendChild(el);
  if (!reduced()) el.animate([{ opacity: 0, transform: 'translate(-50%, 8px)' }, { opacity: 1, transform: 'translate(-50%, 0)' }], { duration: 180, easing: 'ease-out' });
  const close = () => { window.clearTimeout(timer); el.remove(); };
  const timer = window.setTimeout(close, 4000);
  el.querySelector('button')!.addEventListener('click', () => { close(); onUndo(); });
}

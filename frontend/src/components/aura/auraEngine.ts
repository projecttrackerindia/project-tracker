/**
 * Aura, the assistant, drawn as a sphere of light with soft rings of energy (the spec: scratchpad groot/aura.html, class `Aura`, mood table
 * `M`). One renderer per canvas, one requestAnimationFrame loop for every orb on screen: an orb draws only while it is visible
 * (IntersectionObserver) and the tab is visible, and the loop stops when nothing needs drawing. Under Reduce Motion the light is near-still
 * and only its colour changes. The highlight leans toward the pointer, and toward the text caret while someone types in an Aura field.
 */

export type AuraMood =
  | 'calm' | 'listen' | 'think' | 'work' | 'happy' | 'celebrate' | 'warn' | 'sad'
  | 'morning' | 'evening' | 'focus' | 'privacy' | 'sleep' | 'alert' | 'offline';

export interface AuraMoodSpec { name: string; when: string; pal: [string, string, string, string]; spd: number; amp: number; glow: number; rings: number }

export const AURA_MOODS: Record<AuraMood, AuraMoodSpec> = {
  calm:      { name: 'Calm',       when: 'Any page, nothing happening',     pal: ['#2b2bd9', '#6a5cff', '#b56bff', '#7fe3ff'], spd: .35, amp: .10, glow: .55, rings: 4 },
  listen:    { name: 'Listening',  when: 'You are typing',                  pal: ['#1f6bff', '#38b6ff', '#8a7dff', '#c9f3ff'], spd: .8,  amp: .14, glow: .8,  rings: 5 },
  think:     { name: 'Thinking',   when: 'Planning the steps',              pal: ['#5b2bff', '#a64bff', '#ff5fd2', '#7fe3ff'], spd: 1.8, amp: .18, glow: .85, rings: 6 },
  work:      { name: 'Working',    when: 'Changing your work',              pal: ['#0aa5ff', '#15d6c2', '#6a5cff', '#e6fbff'], spd: 2.4, amp: .16, glow: .95, rings: 6 },
  happy:     { name: 'Done',       when: 'Task finished',                   pal: ['#14c98a', '#5ef0a8', '#ffd34d', '#e9fff4'], spd: 1.2, amp: .22, glow: 1,   rings: 6 },
  celebrate: { name: 'Celebrate',  when: 'Release shipped, week submitted', pal: ['#ff4fa3', '#ffb340', '#ffe66b', '#ffffff'], spd: 2,   amp: .28, glow: 1.1, rings: 7 },
  warn:      { name: 'Needs care', when: 'Overdue, conflict, error',        pal: ['#ff7a1a', '#ffb340', '#ff4d5e', '#fff1d6'], spd: .9,  amp: .12, glow: .85, rings: 4 },
  sad:       { name: 'Sorry',      when: 'Something failed',                pal: ['#3a4fbf', '#5a6fd6', '#8a8fb8', '#c8d0ff'], spd: .25, amp: .06, glow: .4,  rings: 3 },
  morning:   { name: 'Check-in',   when: 'Good morning',                    pal: ['#ff8a3d', '#ffc34d', '#ff6aa8', '#fff4d1'], spd: .7,  amp: .16, glow: .95, rings: 5 },
  evening:   { name: 'Check-out',  when: 'End of the day',                  pal: ['#3b2bb8', '#7a4dff', '#ff7ab8', '#ffd1e8'], spd: .3,  amp: .1,  glow: .6,  rings: 4 },
  focus:     { name: 'Focus',      when: 'Focus time running',              pal: ['#0e7c86', '#16b5a5', '#2a5bd7', '#c8fff6'], spd: .2,  amp: .05, glow: .5,  rings: 3 },
  privacy:   { name: 'Privacy',    when: 'Password field',                  pal: ['#5c6170', '#8a8f9e', '#b6bac6', '#e6e8ee'], spd: .15, amp: .03, glow: .25, rings: 2 },
  sleep:     { name: 'Resting',    when: 'Idle 2 minutes',                  pal: ['#1a1f5e', '#2b2f80', '#46407a', '#8088c0'], spd: .12, amp: .04, glow: .25, rings: 2 },
  alert:     { name: 'Heads up',   when: 'New mention or approval',         pal: ['#ff3b6b', '#ff6a3d', '#b56bff', '#ffe0ea'], spd: 1.6, amp: .2,  glow: 1,   rings: 5 },
  offline:   { name: 'Offline',    when: 'No connection',                   pal: ['#3a3a46', '#55556a', '#6c6c80', '#a0a0b4'], spd: .1,  amp: .02, glow: .2,  rings: 1 },
};
export const isAuraMood = (m: unknown): m is AuraMood => typeof m === 'string' && m in AURA_MOODS;

type RGB = [number, number, number];
const hex = (h: string): RGB => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as RGB;
const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const rgba = (c: RGB, a: number) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
interface State { pal: RGB[]; spd: number; amp: number; glow: number; rings: number }
const stateOf = (m: AuraMood): State => { const d = AURA_MOODS[m]; return { pal: d.pal.map(hex), spd: d.spd, amp: d.amp, glow: d.glow, rings: d.rings }; };

const reducedQuery = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
export const auraReduced = () => !!reducedQuery?.matches;

/** The canvas is larger than the orb's box (the glow and the rings spill past it): the sphere's diameter is this share of the canvas. */
export const AURA_SPHERE = 0.44;

export class AuraRenderer {
  readonly cv: HTMLCanvasElement;
  private x: CanvasRenderingContext2D | null;
  mood: AuraMood;
  private cur: State;
  private target: State;
  private t = Math.random() * 100;
  private pulse = 0;
  private lean: [number, number] = [0, 0];
  leanT: [number, number] = [0, 0];
  visible = false;
  /** Drawn once after a change even when not animating (reduced motion / first paint). */
  dirty = true;

  constructor(cv: HTMLCanvasElement, mood: AuraMood = 'calm') {
    this.cv = cv; this.x = cv.getContext('2d'); this.mood = mood;
    this.cur = stateOf(mood); this.target = stateOf(mood);
  }
  set(m: AuraMood, now = false) {
    if (m === this.mood && !now) return;
    this.mood = m; this.target = stateOf(m);
    if (now) this.cur = stateOf(m);
    this.dirty = true; wake();
  }
  kick(v = 1) { this.pulse = Math.min(1.5, this.pulse + v); this.dirty = true; wake(); }
  /** Whether the colours are still on their way to the mood's (Reduce Motion keeps drawing only until they arrive). */
  settling() { const a = this.cur, b = this.target; return Math.abs(a.glow - b.glow) > .01 || a.pal.some((p, i) => Math.abs(p[0] - b.pal[i][0]) + Math.abs(p[1] - b.pal[i][1]) + Math.abs(p[2] - b.pal[i][2]) > 2) || this.pulse > .02; }

  frame(dt: number, still: boolean) {
    const X = this.x; if (!X) return;
    const c = this.cur, g = this.target, k = 1 - Math.pow(.02, dt);
    c.pal = c.pal.map((p, i) => mix(p, g.pal[i], k));
    c.spd += (g.spd - c.spd) * k; c.amp += (g.amp - c.amp) * k; c.glow += (g.glow - c.glow) * k; c.rings += (g.rings - c.rings) * k;
    const spd = still ? .05 : c.spd, amp = still ? .02 : c.amp;
    this.t += dt * (.4 + spd * 1.6);
    this.pulse *= Math.pow(.08, dt);
    const lk = 1 - Math.pow(.01, dt);
    this.lean = [this.lean[0] + (this.leanT[0] - this.lean[0]) * lk, this.lean[1] + (this.leanT[1] - this.lean[1]) * lk];
    const W = this.cv.width, H = this.cv.height, t = this.t;
    const cx = W / 2 + this.lean[0] * W * .03, cy = H / 2 + this.lean[1] * H * .03, R = W * (AURA_SPHERE / 2) * (1 + this.pulse * .06);
    X.clearRect(0, 0, W, H);
    // outer glow
    const gr = X.createRadialGradient(cx, cy, R * .6, cx, cy, R * 2.25);
    gr.addColorStop(0, rgba(c.pal[0], .55 * c.glow)); gr.addColorStop(.45, rgba(c.pal[1], .18 * c.glow)); gr.addColorStop(1, 'rgba(0,0,0,0)');
    X.fillStyle = gr; X.fillRect(0, 0, W, H);
    X.globalCompositeOperation = 'lighter';
    // energy rings: wobbly ellipses, additive
    const n = Math.round(c.rings), blur = W * .03;
    for (let i = 0; i < n; i++) {
      const ph = i * 2.1 + t * (.6 + i * .13) * (i % 2 ? 1 : -1);
      const rr = R * (1.04 + .05 * Math.sin(t * 1.3 + i) + amp * .35 * Math.sin(t * .9 + i * 1.7) + this.pulse * .08);
      X.save(); X.translate(cx, cy); X.rotate(ph * .35); X.scale(1 + amp * Math.sin(t + i), 1 - amp * .8 * Math.cos(t * 1.1 + i));
      X.beginPath();
      for (let a = 0; a <= Math.PI * 2 + .01; a += Math.PI / 32) {
        const w = 1 + amp * .5 * Math.sin(a * 3 + t * 2 + i) + amp * .3 * Math.sin(a * 5 - t * 1.4);
        const px = Math.cos(a) * rr * w, py = Math.sin(a) * rr * w;
        if (a) X.lineTo(px, py); else X.moveTo(px, py);
      }
      const col = c.pal[(i % 3) + 1];
      X.strokeStyle = rgba(col, .22 + .1 * c.glow); X.lineWidth = W * .012 * (1 + .6 * Math.sin(t + i)); X.shadowColor = rgba(col, .9); X.shadowBlur = blur; X.stroke(); X.restore();
    }
    X.shadowBlur = 0; X.globalCompositeOperation = 'source-over';
    // sphere body
    X.save(); X.beginPath(); X.arc(cx, cy, R, 0, Math.PI * 2); X.clip();
    const b = X.createRadialGradient(cx - R * .2, cy - R * .25, R * .1, cx, cy, R * 1.05);
    b.addColorStop(0, rgba(c.pal[1], 1)); b.addColorStop(.7, rgba(c.pal[0], 1)); b.addColorStop(1, rgba(mix(c.pal[0], [10, 10, 40], .5), 1));
    X.fillStyle = b; X.fillRect(cx - R, cy - R, R * 2, R * 2);
    // inner liquid swirls
    X.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 3; i++) {
      const a = t * (.5 + i * .3) + i * 2.2, bx = cx + Math.cos(a) * R * .35, by = cy + Math.sin(a * 1.3) * R * .3, s = R * (.55 + .12 * Math.sin(t + i));
      const gg = X.createRadialGradient(bx, by, 0, bx, by, s); gg.addColorStop(0, rgba(c.pal[i + 1], .55)); gg.addColorStop(1, rgba(c.pal[i + 1], 0));
      X.fillStyle = gg; X.fillRect(cx - R, cy - R, R * 2, R * 2);
    }
    // crescent highlight that leans toward the pointer / caret
    X.globalCompositeOperation = 'source-over';
    const hx = cx - R * .25 + this.lean[0] * R * .25, hy = cy - R * .35 + this.lean[1] * R * .2;
    const h = X.createRadialGradient(hx, hy, 0, hx, hy, R * .75);
    h.addColorStop(0, 'rgba(255,255,255,.55)'); h.addColorStop(.35, rgba(c.pal[3], .25)); h.addColorStop(1, 'rgba(255,255,255,0)');
    X.fillStyle = h; X.fillRect(cx - R, cy - R, R * 2, R * 2);
    X.restore();
    // bright rim
    X.globalCompositeOperation = 'lighter'; X.beginPath(); X.arc(cx, cy, R * .985, 0, Math.PI * 2);
    X.strokeStyle = rgba(c.pal[3], .75 * Math.min(1, c.glow + .2)); X.lineWidth = W * .012; X.shadowColor = rgba(c.pal[3], 1); X.shadowBlur = W * .035; X.stroke();
    X.shadowBlur = 0; X.globalCompositeOperation = 'source-over';
    this.dirty = false;
  }
}

// ------------------------------------------------------------------ the shared loop
const orbs = new Set<AuraRenderer>();
let raf = 0, last = 0, lastStill = 0;
let io: IntersectionObserver | null = null;
const byCanvas = new WeakMap<Element, AuraRenderer>();
/** A point (client coordinates) the highlight leans toward instead of the pointer: the caret while typing in an Aura field. */
let caret: { x: number; y: number } | null = null;
let pointer: { x: number; y: number } | null = null;

function aim(o: AuraRenderer) {
  const p = caret ?? pointer;
  if (!p) return;
  const r = o.cv.getBoundingClientRect();
  if (!r.width) return;
  const dx = p.x - (r.left + r.width / 2), dy = p.y - (r.top + r.height / 2), d = Math.hypot(dx, dy) || 1, k = Math.min(1, d / 400);
  o.leanT = [dx / d * k, dy / d * k];
}

function loop(now: number) {
  raf = 0;
  const dt = Math.min(.05, (now - last) / 1000 || .016); last = now;
  if (typeof document !== 'undefined' && document.hidden) return;   // visibilitychange wakes it again
  const still = auraReduced();
  let more = false;
  // Reduce Motion: about 8 frames a second, and only while the colour is still changing.
  const throttled = still && now - lastStill < 120;
  for (const o of orbs) {
    if (!o.visible) continue;
    if (still) {
      if (o.dirty || o.settling()) { more = true; if (!throttled) { o.frame(throttled ? 0 : Math.max(dt, .12), true); } }
    } else { o.frame(dt, false); more = true; }
  }
  if (still && !throttled) lastStill = now;
  if (more) raf = requestAnimationFrame(loop);
}
export function wake() {
  if (raf || typeof window === 'undefined') return;
  last = performance.now();
  raf = requestAnimationFrame(loop);
}

let wired = false;
function wire() {
  if (wired || typeof window === 'undefined') return;
  wired = true;
  io = typeof IntersectionObserver !== 'undefined'
    ? new IntersectionObserver((es) => { for (const e of es) { const o = byCanvas.get(e.target); if (o) { o.visible = e.isIntersecting; if (o.visible) { o.dirty = true; wake(); } } } })
    : null;
  window.addEventListener('pointermove', (e) => { pointer = { x: e.clientX, y: e.clientY }; if (!caret) for (const o of orbs) if (o.visible) aim(o); }, { passive: true });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) wake(); });
  reducedQuery?.addEventListener?.('change', () => { for (const o of orbs) o.dirty = true; wake(); });
}

export function addOrb(o: AuraRenderer) {
  wire();
  orbs.add(o); byCanvas.set(o.cv, o);
  if (io) io.observe(o.cv); else o.visible = true;
  wake();
}
export function removeOrb(o: AuraRenderer) { orbs.delete(o); io?.unobserve(o.cv); }

/** Every visible orb pulses once (a key typed in an Aura field). */
export function kickAll(v = .35) { for (const o of orbs) if (o.visible) o.kick(v); }

/** Lean every orb toward the text caret of `input` (null: back to the pointer). */
export function followCaret(input: HTMLInputElement | HTMLTextAreaElement | null) {
  caret = input ? caretPoint(input) : null;
  for (const o of orbs) if (o.visible) aim(o);
  if (!input && !pointer) for (const o of orbs) o.leanT = [0, 0];
}

let measure: CanvasRenderingContext2D | null = null;
/** Where the caret is on screen, measured with the field's font (single-line fields; a textarea uses its last line roughly). */
export function caretPoint(input: HTMLInputElement | HTMLTextAreaElement): { x: number; y: number } {
  const r = input.getBoundingClientRect();
  const cs = getComputedStyle(input);
  measure ??= document.createElement('canvas').getContext('2d');
  const upto = input.value.slice(0, input.selectionStart ?? input.value.length);
  const line = upto.split('\n').pop() ?? '';
  let w = 0;
  if (measure) { measure.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`; w = measure.measureText(line).width; }
  const padL = parseFloat(cs.paddingLeft) || 0;
  return { x: Math.min(r.right, r.left + padL + w - input.scrollLeft), y: r.top + r.height / 2 };
}

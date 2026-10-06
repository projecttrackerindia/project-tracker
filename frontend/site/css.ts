/**
 * The look of the public website. One stylesheet, used two ways: as the whole style of the static pages, and (scoped under #site) for the
 * landing page inside index.html, so none of it can touch the app. Every class carries the pt- prefix. Motion is only decoration:
 * nothing is hidden without scripts, and prefers-reduced-motion switches all of it off.
 */

const FONT = '"PT Inter",system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif';

/** Loaded only when the page is shown (a hidden #site never fetches it). */
export const FONT_FACE = '@font-face{font-family:"PT Inter";font-style:normal;font-weight:100 900;font-display:swap;src:url("/fonts/inter-latin-wght-normal.woff2") format("woff2-variations");unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}';

const KEYFRAMES = `
@keyframes pt-drift-a{0%,100%{transform:translate3d(0,0,0) scale(1)}50%{transform:translate3d(7%,9%,0) scale(1.18)}}
@keyframes pt-drift-b{0%,100%{transform:translate3d(0,0,0) scale(1.1)}50%{transform:translate3d(-9%,6%,0) scale(.92)}}
@keyframes pt-drift-c{0%,100%{transform:translate3d(0,0,0)}50%{transform:translate3d(5%,-9%,0) scale(1.2)}}
@keyframes pt-up{from{opacity:0;transform:translateY(18px)}to{opacity:1;transform:none}}
@keyframes pt-grow{from{transform:scaleX(0)}to{transform:scaleX(1)}}
@keyframes pt-growy{from{transform:scaleY(0)}to{transform:scaleY(1)}}
@keyframes pt-float{0%,100%{transform:translateY(0)}50%{transform:translateY(-8px)}}
@keyframes pt-ping{0%{box-shadow:0 0 0 0 rgba(248,113,113,.55)}70%,100%{box-shadow:0 0 0 9px rgba(248,113,113,0)}}
@keyframes pt-blink{0%,100%{opacity:1}50%{opacity:.35}}
@keyframes pt-marquee{from{transform:translateX(0)}to{transform:translateX(-50%)}}
@keyframes pt-msg{from{opacity:0;transform:translateY(10px) scale(.97)}to{opacity:1;transform:none}}
@keyframes pt-seg{0%,40%{transform:translateX(0)}50%,90%{transform:translateX(100%)}100%{transform:translateX(0)}}
@keyframes pt-seg-l{0%,40%{color:#fff}50%,90%{color:var(--muted)}100%{color:#fff}}
@keyframes pt-seg-r{0%,40%{color:var(--muted)}50%,90%{color:#fff}100%{color:var(--muted)}}
@keyframes pt-note{from{opacity:0;transform:translateX(18px)}to{opacity:1;transform:none}}
@keyframes pt-shine{from{transform:translateX(-120%) skewX(-18deg)}to{transform:translateX(260%) skewX(-18deg)}}
@keyframes pt-hue{0%,100%{background-position:0 50%}50%{background-position:100% 50%}}
@keyframes pt-sg-island{0%{transform:translateY(-70px) scale(.6);opacity:0}6%,66%{transform:none;opacity:1}72%,100%{transform:translateY(-24px) scale(.9);opacity:0}}
@keyframes pt-sg-hit{0%,40%{background:rgba(255,255,255,.08);transform:none}46%{background:#7c3aed;transform:scale(.93)}52%,66%{background:#7c3aed;transform:none}100%{background:rgba(255,255,255,.08)}}
@keyframes pt-sg-w{0%,64%{opacity:1;transform:none}70%,96%{opacity:0;transform:translateY(-6px)}100%{opacity:1;transform:none}}
@keyframes pt-sg-d{0%,64%{opacity:0;transform:translateY(6px)}70%,96%{opacity:1;transform:none}100%{opacity:0;transform:translateY(6px)}}
@keyframes pt-sg-ring{0%{stroke-dashoffset:327}64%{stroke-dashoffset:60}70%,96%{stroke-dashoffset:0}100%{stroke-dashoffset:327}}
@keyframes pt-sg-pulse{0%{transform:scale(.6);opacity:.55}100%{transform:scale(1.5);opacity:0}}
@keyframes pt-sg-line{0%,8%{opacity:0;transform:translateY(8px)}16%,92%{opacity:1;transform:none}100%{opacity:0}}
@keyframes pt-prog{from{transform:scaleX(0)}to{transform:scaleX(1)}}
`;

const COMPONENTS = `
__ROOT__{--bg:#faf9ff;--surface:#fff;--surface-2:#f4f0ff;--text:#1b1630;--muted:#5d5878;--line:#e6e1f6;--brand:#7c3aed;--brand-soft:#f1eaff;--ok:#16a34a;--warn:#d97706;--bad:#dc2626;
  --ink:#0a0716;--ink-2:#120d25;--glass:rgba(255,255,255,.06);--glass-line:rgba(255,255,255,.13);--on-ink:#f5f2ff;--on-ink-2:#b9b2d8;
  --grad:linear-gradient(120deg,#a78bfa 0%,#f0abfc 45%,#67e8f9 100%);
  background:var(--bg);color:var(--text);font:16px/1.6 ${FONT};-webkit-font-smoothing:antialiased;font-feature-settings:"cv11","ss01"}
@media (prefers-color-scheme:dark){__ROOT__{--bg:#0d0a1b;--surface:#16122b;--surface-2:#1c1737;--text:#f3f0ff;--muted:#b4adcf;--line:#2b2547;--brand:#a78bfa;--brand-soft:#241d47}}
*{box-sizing:border-box}
a{color:var(--brand);text-decoration:none}a:hover{text-decoration:underline}
h1,h2,h3,h4,p,ul{margin:0}
@media (min-width:1600px){h1{font-size:clamp(68px,3.9vw,92px)}.lead{font-size:clamp(20px,1.25vw,24px)}.sub{font-size:clamp(18px,1.1vw,21px)}}
.wrap{max-width:2240px;margin:0 auto;padding:0 clamp(22px,3.4vw,88px)}
.progress{position:fixed;top:0;left:0;right:0;height:3px;background:var(--grad);transform-origin:left;transform:scaleX(0);z-index:30;display:none}
@supports (animation-timeline:scroll()){.progress{display:block;animation:pt-prog linear both;animation-timeline:scroll(root)}}

.top{position:sticky;top:0;z-index:20;background:rgba(10,7,22,.86);-webkit-backdrop-filter:blur(16px) saturate(1.4);backdrop-filter:blur(16px) saturate(1.4);border-bottom:1px solid var(--glass-line)}
.top .wrap{display:flex;align-items:center;gap:26px;height:66px}
.brand{display:inline-flex;align-items:center;gap:10px;font-weight:800;font-size:18px;color:var(--on-ink);letter-spacing:-.3px}.brand:hover{text-decoration:none}
.brand img{width:32px;height:32px;border-radius:9px;display:block}
.nav{display:flex;gap:4px;margin-left:6px}.nav a{padding:8px 13px;border-radius:99px;color:var(--on-ink-2);font-weight:600;font-size:14.5px;transition:background .2s,color .2s}
.nav a:hover,.nav a[aria-current]{color:#fff;background:var(--glass);text-decoration:none}
.actions{margin-left:auto;display:flex;align-items:center;gap:10px}
.btn{position:relative;overflow:hidden;display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:11px 20px;border-radius:12px;font-weight:700;font-size:15px;border:1px solid transparent;cursor:pointer;line-height:1.2;transition:transform .2s,box-shadow .25s,background .2s,border-color .2s}
.btn:hover{text-decoration:none;transform:translateY(-2px)}
.btn-primary{background:linear-gradient(135deg,#7c3aed,#a855f7 60%,#c084fc);color:#fff;box-shadow:0 8px 26px rgba(124,58,237,.45)}
.btn-primary:hover{box-shadow:0 12px 34px rgba(168,85,247,.6)}
.btn-primary::after{content:"";position:absolute;top:0;bottom:0;width:38%;left:0;background:linear-gradient(90deg,transparent,rgba(255,255,255,.4),transparent);transform:translateX(-120%) skewX(-18deg)}
.btn-primary:hover::after{animation:pt-shine .8s ease}
.btn-ghost{background:var(--surface);color:var(--text);border-color:var(--line)}.btn-ghost:hover{border-color:var(--brand)}
.btn-glass{background:var(--glass);color:var(--on-ink);border-color:var(--glass-line);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px)}.btn-glass:hover{background:rgba(255,255,255,.12)}
.btn-lg{padding:15px 28px;font-size:16px;border-radius:14px}

.dark{position:relative;isolation:isolate;overflow:hidden;background:var(--ink);color:var(--on-ink)}
.aurora{position:absolute;inset:0;z-index:-1;overflow:hidden}
.aurora i{position:absolute;border-radius:50%;filter:blur(70px);opacity:.55;will-change:transform}
.aurora i:nth-child(1){width:56vw;height:56vw;max-width:760px;max-height:760px;left:-12%;top:-30%;background:radial-gradient(circle,#7c3aed,transparent 65%);animation:pt-drift-a 18s ease-in-out infinite}
.aurora i:nth-child(2){width:48vw;height:48vw;max-width:640px;max-height:640px;right:-10%;top:-18%;background:radial-gradient(circle,#d946ef,transparent 65%);opacity:.38;animation:pt-drift-b 22s ease-in-out infinite}
.aurora i:nth-child(3){width:44vw;height:44vw;max-width:600px;max-height:600px;left:30%;bottom:-40%;background:radial-gradient(circle,#22d3ee,transparent 65%);opacity:.3;animation:pt-drift-c 26s ease-in-out infinite}
.gridbg{position:absolute;inset:0;z-index:-1;background-image:linear-gradient(rgba(255,255,255,.055) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.055) 1px,transparent 1px);background-size:56px 56px;-webkit-mask-image:radial-gradient(ellipse 70% 60% at 50% 30%,#000 30%,transparent 80%);mask-image:radial-gradient(ellipse 70% 60% at 50% 30%,#000 30%,transparent 80%)}

.hero{padding:150px 0 70px;margin-top:-67px}
.hero .wrap{display:grid;grid-template-columns:1.02fr .98fr;gap:clamp(40px,5vw,96px);align-items:center}
.kicker{display:inline-flex;align-items:center;gap:8px;padding:6px 14px 6px 8px;border-radius:99px;background:var(--glass);border:1px solid var(--glass-line);color:var(--on-ink);font-weight:600;font-size:13px;animation:pt-up .7s both}
.kicker b{background:linear-gradient(135deg,#7c3aed,#d946ef);color:#fff;border-radius:99px;padding:2px 9px;font-size:11.5px;letter-spacing:.3px}
h1{font-size:clamp(38px,5.6vw,68px);line-height:1.03;letter-spacing:-2px;margin:22px 0 18px;font-weight:800;animation:pt-up .8s .08s both}
.grad{background:var(--grad);background-size:220% 100%;-webkit-background-clip:text;background-clip:text;color:transparent;-webkit-text-fill-color:transparent;animation:pt-hue 9s ease-in-out infinite}
.lead{font-size:clamp(17px,2vw,20px);color:var(--on-ink-2);max-width:34em;animation:pt-up .8s .18s both}
.cta{display:flex;flex-wrap:wrap;gap:12px;margin-top:30px;animation:pt-up .8s .28s both}
.fine{margin-top:16px;font-size:14px;color:var(--on-ink-2);animation:pt-up .8s .36s both}

.demo{position:relative;background:linear-gradient(160deg,rgba(255,255,255,.1),rgba(255,255,255,.04));border:1px solid var(--glass-line);border-radius:22px;padding:18px;display:grid;gap:11px;-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);box-shadow:0 40px 90px rgba(0,0,0,.45),inset 0 1px 0 rgba(255,255,255,.12);animation:pt-up .9s .2s both}
.demo-head{display:flex;justify-content:space-between;align-items:center;font-size:14.5px}
.live{display:inline-flex;align-items:center;gap:7px;color:var(--on-ink-2);font-size:12.5px;font-weight:600}.live i{width:8px;height:8px;border-radius:50%;background:#34d399;animation:pt-blink 1.8s infinite}
.proj{display:grid;grid-template-columns:1fr auto;gap:6px 12px;padding:13px 14px;border-radius:14px;background:rgba(10,7,22,.5);border:1px solid var(--glass-line)}
.proj b{font-size:15px;color:#fff}.proj .meta{grid-column:1;font-size:12.5px;color:var(--on-ink-2)}
.chip{font-size:12px;font-weight:700;padding:3px 11px;border-radius:99px;align-self:start;white-space:nowrap;transition:background .3s,color .3s}
.chip.ok{background:#bbf7d0;color:#14532d}.chip.warn{background:#fde68a;color:#78350f}.chip.bad{background:#fecaca;color:#7f1d1d;animation:pt-ping 2.2s infinite}
.bar{grid-column:1/-1;height:7px;background:rgba(255,255,255,.1);border-radius:9px;overflow:hidden}
.bar i{display:block;height:100%;width:var(--w);transform-origin:left;background:linear-gradient(90deg,#8b5cf6,#d946ef,#22d3ee);border-radius:9px;animation:pt-grow 1.3s cubic-bezier(.2,.7,.2,1) .5s both}
.whatif{display:none;gap:10px;padding:14px;border-radius:14px;background:linear-gradient(135deg,rgba(124,58,237,.35),rgba(34,211,238,.14));border:1px solid rgba(167,139,250,.5)}
__JS__ .whatif{display:grid}
.whatif .q{font-size:13px;color:var(--on-ink-2)}
.whatif .row{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.step{width:34px;height:34px;border-radius:10px;border:1px solid var(--glass-line);background:var(--glass);color:#fff;font-size:19px;font-weight:700;cursor:pointer;line-height:1;transition:background .2s,transform .15s}
.step:hover{background:rgba(255,255,255,.18)}.step:active{transform:scale(.92)}
.whatif output{min-width:5.5ch;text-align:center;font-weight:800;font-size:17px;color:#fff}
.whatif .res{margin-left:auto;text-align:right;font-size:13.5px;color:var(--on-ink-2)}.whatif .res b{display:block;font-size:17px;color:#fff;transition:color .3s}
.whatif .res b.ok{color:#6ee7b7}.whatif .res b.bad{color:#fca5a5}
.small{font-size:12px;color:var(--on-ink-2);opacity:.85}

.marquee{position:relative;border-block:1px solid var(--glass-line);background:var(--ink);overflow:hidden;padding:18px 0}
.marquee::before,.marquee::after{content:"";position:absolute;top:0;bottom:0;width:90px;z-index:1;pointer-events:none}
.marquee::before{left:0;background:linear-gradient(90deg,var(--ink),transparent)}.marquee::after{right:0;background:linear-gradient(270deg,var(--ink),transparent)}
.marquee .track{display:flex;width:max-content;gap:14px;animation:pt-marquee 38s linear infinite}
.marquee:hover .track{animation-play-state:paused}
.marquee span{display:inline-flex;align-items:center;gap:9px;padding:8px 18px;border-radius:99px;border:1px solid var(--glass-line);background:var(--glass);color:var(--on-ink-2);font-weight:600;font-size:14px;white-space:nowrap}
.marquee span::before{content:"";width:6px;height:6px;border-radius:50%;background:var(--grad)}

section.block{padding:92px 0}
.eyebrow{color:var(--brand);font-weight:800;font-size:12.5px;letter-spacing:1.2px;text-transform:uppercase;margin-bottom:12px}
h2{font-size:clamp(28px,3.8vw,46px);line-height:1.1;letter-spacing:-1.2px;margin-bottom:14px;font-weight:800}
.sub{color:var(--muted);font-size:18px;margin-bottom:44px;max-width:38em}
.center{text-align:center}.center .sub{margin-inline:auto}

__JS__ [data-r]{opacity:0;transform:translateY(24px);transition:opacity .75s cubic-bezier(.2,.7,.2,1),transform .75s cubic-bezier(.2,.7,.2,1);transition-delay:var(--d,0s)}
__JS__ [data-r].in{opacity:1;transform:none}

.bento{display:grid;grid-template-columns:repeat(6,1fr);gap:16px}
.tile{position:relative;overflow:hidden;grid-column:span 2;background:var(--surface);border:1px solid var(--line);border-radius:22px;padding:24px;display:flex;flex-direction:column;gap:6px;transition:transform .3s,border-color .3s,box-shadow .3s}
.tile.w{grid-column:span 4}.tile.h{grid-row:span 2}
.tile::before{content:"";position:absolute;inset:0;background:radial-gradient(420px circle at var(--mx,50%) var(--my,0%),rgba(167,139,250,.2),transparent 60%);opacity:0;transition:opacity .3s;pointer-events:none}
.tile:hover{transform:translateY(-4px);border-color:rgba(167,139,250,.55);box-shadow:0 22px 50px rgba(124,58,237,.18)}.tile:hover::before{opacity:1}
.tile h3{font-size:19px;letter-spacing:-.3px}.tile p{color:var(--muted);font-size:15px}
.tile .vis{margin-top:auto;padding-top:18px}
.tag{display:inline-block;align-self:flex-start;padding:2px 10px;border-radius:99px;background:var(--brand-soft);color:var(--brand);font-weight:700;font-size:11.5px;margin-bottom:6px}

.rows{display:grid;gap:9px}
.r{display:grid;grid-template-columns:1fr auto;gap:5px 10px;padding:11px 13px;border-radius:12px;background:var(--surface-2);font-size:13.5px}
.r b{font-weight:700}.r .bar{background:var(--line)}
.chat{display:grid;gap:9px}
.msg{max-width:88%;padding:10px 14px;border-radius:16px;font-size:13.5px;line-height:1.45}
__JS__ .msg{opacity:0}
.in .msg,.msg.on{animation:pt-msg .5s cubic-bezier(.2,.7,.2,1) both;animation-delay:var(--md,0s)}
.msg.u{justify-self:end;background:linear-gradient(135deg,#7c3aed,#a855f7);color:#fff;border-bottom-right-radius:5px}
.msg.a{background:var(--surface-2);border-bottom-left-radius:5px}
.msg .act{display:inline-block;margin-top:7px;padding:4px 11px;border-radius:99px;background:var(--brand-soft);color:var(--brand);font-weight:700;font-size:12px}
.seg{position:relative;display:grid;grid-template-columns:1fr 1fr;padding:4px;border-radius:12px;background:var(--surface-2);font-size:13px;font-weight:700;text-align:center}
.seg::before{content:"";position:absolute;left:4px;top:4px;bottom:4px;width:calc(50% - 4px);border-radius:9px;background:linear-gradient(135deg,#7c3aed,#a855f7);animation:pt-seg 6s ease-in-out infinite}
.seg span{position:relative;padding:8px 6px}.seg span:first-child{color:#fff;animation:pt-seg-l 6s ease-in-out infinite}.seg span:last-child{color:var(--muted);animation:pt-seg-r 6s ease-in-out infinite}
.chips{display:flex;gap:7px;flex-wrap:wrap;margin-top:10px}.chips span{padding:4px 11px;border-radius:99px;background:var(--surface-2);font-size:12.5px;font-weight:600}
.notes{display:grid;gap:8px}
.note{display:flex;gap:10px;align-items:center;padding:10px 12px;border-radius:12px;background:var(--surface-2);font-size:13px}
__JS__ .note{opacity:0}
.in .note{animation:pt-note .55s cubic-bezier(.2,.7,.2,1) both;animation-delay:var(--md,0s)}
.note i{flex:none;width:30px;height:30px;border-radius:9px;background:var(--brand-soft);color:var(--brand);display:grid;place-items:center;font-style:normal;font-weight:800}
.cap{display:flex;align-items:flex-end;gap:10px;height:110px;padding-top:6px;border-bottom:1px dashed var(--line);position:relative}
.cap::after{content:"";position:absolute;left:0;right:0;top:34%;border-top:1px dashed rgba(220,38,38,.55)}
.cap i{flex:1;height:var(--h);border-radius:8px 8px 0 0;background:linear-gradient(180deg,#a78bfa,#7c3aed);transform-origin:bottom;animation:pt-growy 1s cubic-bezier(.2,.7,.2,1) both;animation-delay:var(--md,0s)}
.cap i.over{background:linear-gradient(180deg,#fda4af,#e11d48)}
.pills{display:flex;gap:8px;flex-wrap:wrap}.pills span{padding:6px 12px;border-radius:99px;border:1px solid var(--line);background:var(--surface-2);font-size:13px;font-weight:600}
.pills span::before{content:"✓ ";color:var(--ok);font-weight:800}

.steps{display:grid;grid-template-columns:repeat(3,1fr);gap:18px;counter-reset:s}
.stp{position:relative;padding:26px;border-radius:22px;background:var(--surface);border:1px solid var(--line)}
.stp::before{counter-increment:s;content:counter(s);display:grid;place-items:center;width:40px;height:40px;border-radius:12px;background:linear-gradient(135deg,#7c3aed,#d946ef);color:#fff;font-weight:800;margin-bottom:16px}
.stp h3{font-size:18px;margin-bottom:6px}.stp p{color:var(--muted);font-size:15px}

.vs{border:1px solid var(--line);border-radius:22px;overflow:hidden;background:var(--surface)}
.vs .hd,.vs .rw{display:grid;grid-template-columns:1.1fr 1fr 1.25fr;gap:0}
.vs .hd{background:var(--surface-2);font-weight:800;font-size:14px}
.vs .hd>div,.vs .rw>div{padding:16px 20px}
.vs .hd .us{background:linear-gradient(135deg,#7c3aed,#a855f7);color:#fff}
.vs .rw{border-top:1px solid var(--line);font-size:15px}.vs .rw>div:first-child{font-weight:700}
.vs .rw .no{color:var(--muted)}.vs .rw .no::before{content:"✕  ";color:var(--bad);font-weight:800}
.vs .rw .yes::before{content:"✓  ";color:var(--ok);font-weight:800}
.vs .rw .yes{background:linear-gradient(90deg,rgba(124,58,237,.07),transparent)}

.plans{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;align-items:stretch}
.plan{position:relative;display:flex;flex-direction:column;background:var(--surface);border:1px solid var(--line);border-radius:22px;padding:26px;transition:transform .3s,box-shadow .3s}
.plan:hover{transform:translateY(-5px);box-shadow:0 22px 50px rgba(124,58,237,.16)}
.plan.hot{border:1px solid transparent;background:linear-gradient(var(--surface),var(--surface)) padding-box,linear-gradient(135deg,#7c3aed,#d946ef,#22d3ee) border-box;box-shadow:0 22px 60px rgba(124,58,237,.25)}
.plan .badge{position:absolute;top:-12px;left:22px;background:linear-gradient(135deg,#7c3aed,#d946ef);color:#fff;font-size:12px;font-weight:800;padding:3px 13px;border-radius:99px}
.plan h3{font-size:19px}.plan .blurb{color:var(--muted);font-size:14.5px;margin:4px 0 14px;min-height:44px}
.price{font-size:40px;font-weight:800;letter-spacing:-1.5px;min-height:74px}.price small{display:block;margin-top:2px;font-size:14px;color:var(--muted);font-weight:600;letter-spacing:0}
.plan ul{list-style:none;padding:0;margin:18px 0 24px;display:grid;gap:10px;flex:1}.plan li{display:flex;gap:9px;font-size:14.5px}.plan li svg{flex:none;color:var(--ok);margin-top:3px}
.note2{color:var(--muted);font-size:14px;margin-top:24px}
.price .was{font-size:20px;font-weight:600;color:var(--muted);letter-spacing:0;margin-right:8px;text-decoration:line-through}
.ptotal{margin:2px 0 0;font-size:13.5px;color:var(--muted);min-height:20px}.ptotal b{color:var(--text)}
.calc{max-width:1100px;margin:0 auto 30px;padding:18px 22px;border:1px solid var(--line);border-radius:20px;background:var(--surface);box-shadow:0 14px 40px rgba(124,58,237,.08);display:grid;gap:14px}
.calc-row{display:flex;align-items:center;gap:16px;flex-wrap:wrap}.calc-l{width:64px;font-size:12px;letter-spacing:1.4px;text-transform:uppercase;font-weight:800;color:var(--muted)}
.seg2{display:inline-flex;padding:4px;border-radius:13px;background:var(--surface-2);border:1px solid var(--line)}
.seg2 button{border:0;background:transparent;color:var(--muted);font:inherit;font-weight:700;font-size:14px;padding:8px 16px;border-radius:10px;cursor:pointer;transition:background .2s,color .2s,box-shadow .2s}
.seg2 button.on{background:var(--surface);color:var(--text);box-shadow:0 6px 18px rgba(124,58,237,.18)}
.seg2 em{font-style:normal;margin-left:6px;padding:2px 8px;border-radius:99px;background:rgba(16,185,129,.16);color:var(--ok);font-size:12px;font-weight:800}
.calc input[type=range]{flex:1;min-width:180px;accent-color:#7c3aed;height:6px}
.calc output{min-width:44px;text-align:right;font-weight:800;font-size:20px;letter-spacing:-.5px}
.calc-note{margin:0;color:var(--muted);font-size:14px}
.offer-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
.offer{padding:26px;border:1px solid var(--line);border-radius:22px;background:var(--surface);transition:transform .3s,box-shadow .3s}
.offer:hover{transform:translateY(-4px);box-shadow:0 20px 46px rgba(124,58,237,.14)}
.offer.hot{border-color:transparent;background:linear-gradient(var(--surface),var(--surface)) padding-box,linear-gradient(135deg,#7c3aed,#d946ef,#22d3ee) border-box}
.offer-big{display:block;font-size:30px;font-weight:800;letter-spacing:-1px;background:linear-gradient(135deg,#7c3aed,#d946ef);-webkit-background-clip:text;background-clip:text;color:transparent}
.offer h3{margin:6px 0 8px;font-size:18px}.offer p{margin:0;color:var(--muted);font-size:15px}
.credit-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;max-width:1240px;margin:0 auto}
.cr{display:grid;gap:4px;padding:20px 22px;border:1px solid var(--line);border-radius:18px;background:var(--surface)}
.cr b{font-size:24px;letter-spacing:-.6px}.cr span{font-weight:800;color:var(--brand);font-size:13px;letter-spacing:1.2px;text-transform:uppercase}.cr em{font-style:normal;color:var(--muted);font-size:14.5px}
@media (max-width:980px){.offer-grid,.credit-grid{grid-template-columns:1fr}}

.matrix{border:1px solid var(--line);border-radius:22px;overflow:auto;background:var(--surface);margin-top:44px}
.matrix table{width:100%;border-collapse:collapse;min-width:720px;font-size:14.5px}
.matrix th,.matrix td{padding:13px 18px;text-align:center;border-top:1px solid var(--line)}
.matrix th:first-child,.matrix td:first-child{text-align:left}
.matrix thead th{position:sticky;top:0;background:var(--surface-2);font-size:14px;border-top:0}
.matrix thead th.hotc{background:linear-gradient(135deg,#7c3aed,#a855f7);color:#fff}
.matrix tr.grp td{background:var(--surface-2);font-weight:800;font-size:12.5px;letter-spacing:.8px;text-transform:uppercase;color:var(--brand);text-align:left}
.matrix td.yes{color:var(--ok);font-weight:800}.matrix td.no{color:var(--muted)}
.matrix td:nth-child(3){background:rgba(124,58,237,.05)}

.faq{max-width:1180px;margin:0 auto;display:grid;gap:12px}
.faq details{background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:0 22px;transition:border-color .2s,box-shadow .2s}
.faq details[open]{border-color:rgba(167,139,250,.6);box-shadow:0 14px 34px rgba(124,58,237,.12)}
.faq summary{cursor:pointer;list-style:none;padding:19px 0;font-weight:700;font-size:16.5px;display:flex;justify-content:space-between;gap:16px;align-items:center}
.faq summary::-webkit-details-marker{display:none}
.faq summary::after{content:"+";flex:none;width:28px;height:28px;border-radius:9px;background:var(--brand-soft);color:var(--brand);display:grid;place-items:center;font-size:19px;transition:transform .3s}
.faq details[open] summary::after{transform:rotate(45deg)}
.faq p{padding:0 0 20px;color:var(--muted);font-size:15.5px}

.band{position:relative;isolation:isolate;overflow:hidden;margin:20px 0 90px;border-radius:30px;padding:70px 28px;text-align:center;color:#fff;background:#0a0716}
.band .aurora i{opacity:.7}
.band h2{color:#fff}.band p{color:var(--on-ink-2);margin:0 auto 28px;max-width:34em;font-size:18px}

.page-head{padding:140px 0 64px;margin-top:-67px}
.page-head .eyebrow{color:#c4b5fd}
.page-head h1{margin-top:0;font-size:clamp(34px,5vw,58px);animation:pt-up .8s both}
.page-head .lead{animation:pt-up .8s .1s both}
.card{background:var(--surface);border:1px solid var(--line);border-radius:20px;padding:24px;position:relative;overflow:hidden;transition:transform .3s,border-color .3s,box-shadow .3s}
.card::before{content:"";position:absolute;inset:0;background:radial-gradient(420px circle at var(--mx,50%) var(--my,0%),rgba(167,139,250,.18),transparent 60%);opacity:0;transition:opacity .3s;pointer-events:none}
.card:hover{transform:translateY(-4px);border-color:rgba(167,139,250,.55);box-shadow:0 20px 46px rgba(124,58,237,.16)}.card:hover::before{opacity:1}
.card .ic{width:46px;height:46px;border-radius:13px;display:grid;place-items:center;background:var(--brand-soft);color:var(--brand);margin-bottom:14px}
.card h3{font-size:17.5px;letter-spacing:-.2px;margin-bottom:6px}.card p{color:var(--muted);font-size:15px}
.card ul{list-style:none;padding:0;margin-top:12px;display:grid;gap:9px}.card li{display:flex;gap:9px;color:var(--muted);font-size:15px}.card li svg{flex:none;color:var(--ok);margin-top:3px}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:18px}.two{grid-template-columns:repeat(2,1fr)}
.report{display:flex;gap:24px;align-items:center;justify-content:space-between;flex-wrap:wrap;background:var(--surface);border:1px solid var(--line);border-radius:20px;padding:28px;margin-top:20px}
.report h2{font-size:24px;margin:0 0 6px;letter-spacing:-.4px}.report p{color:var(--muted);max-width:44em}

footer{background:var(--ink);color:var(--on-ink-2);padding:56px 0 38px;font-size:14.5px}
footer .cols{display:grid;grid-template-columns:1.4fr repeat(3,1fr);gap:30px}footer h4{margin:0 0 12px;color:#fff;font-size:14px}
footer ul{list-style:none;margin:0;padding:0;display:grid;gap:9px}footer a{color:var(--on-ink-2)}footer a:hover{color:#fff}
footer .legal{margin-top:34px;padding-top:20px;border-top:1px solid var(--glass-line);display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}


/* sign in the way you unlock your phone */
.sg{display:grid;grid-template-columns:1fr 1.05fr;gap:48px;align-items:center;padding:44px;border-radius:30px;background:var(--surface);border:1px solid var(--line)}
.sg h2{font-size:clamp(26px,3.4vw,36px);letter-spacing:-.8px;margin-bottom:10px}
.sg-points{list-style:none;display:grid;gap:12px;margin:0 0 26px;padding:0}.sg-points li{display:flex;gap:10px;align-items:flex-start;color:var(--muted);font-size:15.5px}.sg-points b{color:var(--text)}
.sg-points svg{flex:none;margin-top:4px;color:var(--brand)}
.sg-stage{position:relative;min-height:360px;display:grid;place-items:center;border-radius:24px;background:radial-gradient(120% 90% at 20% 0%,rgba(167,139,250,.28),transparent 60%),var(--surface-2);overflow:hidden}
.sg-pc{width:min(64%,340px);border-radius:16px;background:#fff;color:#1b1630;box-shadow:0 24px 60px rgba(76,29,149,.22);overflow:hidden;margin-right:30%}
.sg-bar{display:flex;gap:6px;padding:10px 12px;background:#f3effd}.sg-bar i{width:9px;height:9px;border-radius:50%;background:#d6cdee}
.sg-body{display:grid;justify-items:center;gap:10px;padding:18px 18px 22px}.sg-body small{font-weight:700;font-size:13px;color:#5d5878}
.sg-ring{position:relative;width:112px;height:112px;display:grid;place-items:center}
.sg-ring svg{position:absolute;inset:0;transform:rotate(-90deg)}.sg-ring circle{fill:none;stroke:#efe9ff;stroke-width:6}
.sg-ring .go{stroke:#7c3aed;stroke-linecap:round;stroke-dasharray:327;stroke-dashoffset:0;animation:pt-sg-ring 9s ease-in-out infinite}
.sg-ring b{font-size:42px;letter-spacing:-1.5px;background:linear-gradient(135deg,#7c3aed,#ec4899);-webkit-background-clip:text;background-clip:text;color:transparent}
.sg-state{position:relative;height:22px;width:100%;text-align:center;font-size:13px;font-weight:650}
.sg-state span{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;gap:6px}
.sg-state .w{color:#5d5878;opacity:0;animation:pt-sg-w 9s ease-in-out infinite}.sg-state .d{color:#16a34a;animation:pt-sg-d 9s ease-in-out infinite}
.sg-phone{position:absolute;right:6%;top:50%;transform:translateY(-50%);width:min(34%,168px);aspect-ratio:9/16;border-radius:30px;background:#0b0a12;border:6px solid #1d1a33;box-shadow:0 26px 60px rgba(20,10,60,.4);overflow:hidden}
.sg-island{position:absolute;left:6px;right:6px;top:8px;padding:10px;border-radius:20px;background:#15122b;color:#f4f2ff;animation:pt-sg-island 9s ease-in-out infinite}
.sg-ih{display:flex;gap:8px;align-items:center;margin-bottom:9px}.sg-ih i{flex:none;width:20px;height:20px;border-radius:50%;background:linear-gradient(135deg,#7c3aed,#ec4899)}
.sg-ih span{display:grid;line-height:1.15;min-width:0}.sg-ih b{font-size:10.5px}.sg-ih small{font-size:9px;opacity:.65;white-space:nowrap}
.sg-nums{display:grid;grid-template-columns:repeat(3,1fr);gap:5px}.sg-nums span{display:grid;place-items:center;height:34px;border-radius:11px;background:rgba(255,255,255,.08);font-weight:800;font-size:15px;font-variant-numeric:tabular-nums}
.sg-nums .hit{background:#7c3aed;animation:pt-sg-hit 9s ease-in-out infinite}
.trio{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}.trio .tile{grid-column:auto}
.fp{position:relative;width:64px;height:64px;display:grid;place-items:center;border-radius:20px;background:var(--brand-soft);color:var(--brand)}
.fp i{position:absolute;inset:0;border-radius:20px;border:1.5px solid var(--brand);opacity:0;animation:pt-sg-pulse 2.6s ease-out infinite}.fp i:nth-child(2){animation-delay:.85s}.fp i:nth-child(3){animation-delay:1.7s}
.pills .pro{background:var(--brand-soft);border-color:transparent;color:var(--brand)}
.rq{display:grid;gap:8px;font-size:12.5px}.rq .l{display:flex;justify-content:space-between;gap:10px;align-items:center;padding:8px 11px;border-radius:12px;background:var(--surface-2);border:1px solid var(--line);opacity:1}
.rq code{font-weight:700;font-size:12px}.rq span{color:var(--ok);font-weight:650;text-align:right}
.rq .a{animation:pt-sg-line 7s ease-in-out infinite}.rq .b{animation:pt-sg-line 7s ease-in-out infinite;animation-delay:.9s}
@media (max-width:980px){.sg{grid-template-columns:1fr;padding:28px;gap:28px}.trio{grid-template-columns:1fr}}
@media (max-width:620px){.sg{padding:22px 18px}.sg-stage{min-height:340px}.sg-pc{width:66%;margin-right:28%}.sg-phone{right:4%;width:36%;border-width:5px;border-radius:24px}.sg-ring{width:92px;height:92px}.sg-ring b{font-size:34px}.sg-nums span{height:30px;font-size:13px}.sg-ih small{display:none}}

/* downloads */
.dl-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}
.dl{position:relative;display:flex;flex-direction:column;gap:6px;background:var(--surface);border:1px solid var(--line);border-radius:22px;padding:24px;transition:transform .3s,border-color .3s,box-shadow .3s}
.dl:hover{transform:translateY(-3px);border-color:rgba(167,139,250,.55);box-shadow:0 18px 44px rgba(124,58,237,.14)}
.dl .ic{width:52px;height:52px;border-radius:16px;display:grid;place-items:center;background:var(--brand-soft);color:var(--brand);margin-bottom:6px}
.dl h3{font-size:20px;letter-spacing:-.3px}.dl .dsub{color:var(--muted);font-size:14.5px}
.dl .rec{display:none;align-self:flex-start;padding:2px 10px;border-radius:99px;background:var(--brand);color:#fff;font-weight:700;font-size:11.5px}
.dl.mine{border-color:var(--brand);box-shadow:0 18px 44px rgba(124,58,237,.18)}.dl.mine .rec{display:inline-block}
.dl .dact{display:grid;gap:8px;margin:12px 0 6px}.dl .dact .btn{justify-content:center;text-align:center}
.dnote{margin-top:6px;border-top:1px solid var(--line);padding-top:10px;font-size:14px}.dnote summary{cursor:pointer;font-weight:650;color:var(--text);list-style:none}
.dnote summary::-webkit-details-marker{display:none}.dnote summary::after{content:" +";color:var(--brand);font-weight:800}.dnote[open] summary::after{content:" \\2212"}
.dnote p{color:var(--muted);margin:8px 0 0;line-height:1.55}.dnote code{font-size:12.5px;background:var(--surface-2);padding:1px 6px;border-radius:6px;word-break:break-all}
.dl-facts{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;margin:30px 0 8px}
.dl-facts>div{display:grid;gap:4px;padding:18px 20px;border-radius:18px;background:var(--surface-2);border:1px solid var(--line)}.dl-facts b{font-size:15.5px}.dl-facts span{color:var(--muted);font-size:14px}
@media (max-width:980px){.dl-grid,.dl-facts{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (max-width:620px){.dl-grid,.dl-facts{grid-template-columns:minmax(0,1fr)}}
@media (max-width:980px){.hero .wrap{grid-template-columns:1fr}.bento{grid-template-columns:repeat(2,1fr)}.tile,.tile.w{grid-column:span 2}.tile.h{grid-row:auto}
  .plans{grid-template-columns:repeat(2,1fr)}.grid{grid-template-columns:repeat(2,1fr)}.steps{grid-template-columns:1fr}.nav{display:none}footer .cols{grid-template-columns:1fr 1fr}}
@media (max-width:620px){.plans,.grid,.two{grid-template-columns:1fr}.bento{grid-template-columns:1fr}.tile,.tile.w{grid-column:auto}.actions .btn-glass{display:none}.top .wrap{gap:12px}
  .hero{padding:110px 0 44px}section.block{padding:64px 0}.vs .hd,.vs .rw{grid-template-columns:1fr}.vs .hd>div:nth-child(2),.vs .hd>div:nth-child(3){display:none}.vs .rw>div:first-child{padding-bottom:4px;color:var(--brand)}
  .whatif .res{margin-left:0;text-align:left}.band{padding:48px 20px}}
.sticky{display:none}
@media (max-width:620px){.sticky{display:flex;position:fixed;left:0;right:0;bottom:0;z-index:25;gap:10px;padding:10px 14px calc(10px + env(safe-area-inset-bottom,0px));background:rgba(10,7,22,.9);-webkit-backdrop-filter:blur(18px);backdrop-filter:blur(18px);border-top:1px solid var(--glass-line);transform:translateY(110%);transition:transform .35s cubic-bezier(.2,.9,.25,1)}
  .sticky.show{transform:none}.sticky .btn{flex:1;min-height:50px}footer{padding-bottom:calc(96px + env(safe-area-inset-bottom,0px))}}
footer .cols>*{min-width:0}footer a{overflow-wrap:anywhere}
@media (max-width:980px){footer .cols{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (max-width:480px){footer .cols{grid-template-columns:minmax(0,1fr)}}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}
  __JS__ [data-r]{opacity:1!important;transform:none!important}.msg,.note{opacity:1!important}}
`;

/** Gives every class in the stylesheet (and in the markup, see `scoped`) the pt- prefix. */
const prefix = (css: string) => css.replace(/\.([a-z][\w-]*)/g, '.pt-$1');

const sel = (s: string, landing: boolean) => {
  if (s.startsWith('__ROOT__')) return s.replace('__ROOT__', landing ? '#site' : ':root');
  if (s.startsWith('__JS__')) return landing ? `:root.pt-js #site${s.slice(6)}` : `:root.pt-js${s.slice(6)}`;
  return landing ? `#site ${s}` : s;
};

/** Puts every rule under #site (keyframes stay global; @media is walked). The stylesheet is simple enough that this needs no real parser. */
function scopeRules(css: string, landing: boolean): string {
  let out = '', i = 0;
  while (i < css.length) {
    const open = css.indexOf('{', i);
    if (open < 0) break;
    const head = css.slice(i, open).trim();
    let depth = 1, j = open + 1;
    while (j < css.length && depth > 0) { const c = css[j++]; if (c === '{') depth++; else if (c === '}') depth--; }
    const body = css.slice(open + 1, j - 1);
    if (head.startsWith('@keyframes')) out += `${head}{${body}}`;
    else if (head.startsWith('@')) out += `${head}{${scopeRules(body, landing)}}`;
    else out += `${head.split(',').map((s) => sel(s.trim(), landing)).join(',')}{${body}}`;
    i = j;
  }
  return out;
}

const compact = (css: string) => css.replace(/\s*\n\s*/g, '');
const built = (landing: boolean) => compact(prefix(KEYFRAMES)) + scopeRules(compact(prefix(COMPONENTS)), landing);

/** The whole style of a static page. */
export const pageCss = () => `${FONT_FACE}html{scroll-behavior:smooth}body{margin:0}${built(false)}`;
/** The landing page's style, for the <style> in index.html. */
export const landingCss = () => `${FONT_FACE}${built(true)}`;
/** Prefixes the classes of a piece of markup. */
export const scoped = (html: string) => html.replace(/class="([^"]+)"/g, (_m, c: string) => `class="${c.split(' ').map((x) => `pt-${x}`).join(' ')}"`);

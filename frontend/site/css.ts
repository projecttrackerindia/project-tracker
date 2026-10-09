/**
 * The look of the public website: light, airy and animated. One stylesheet, used two ways: as the whole style of the static pages, and
 * (scoped under #site) for the landing page inside index.html, so none of it can touch the app. Every class carries the pt- prefix.
 * Motion is only decoration: nothing is hidden without scripts, and prefers-reduced-motion switches all of it off.
 * Display type is Sora, text is Inter, both served from our own origin.
 */

const FONT = '"PT Inter",system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif';
const DISPLAY = '"PT Sora","PT Inter",system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif';
const UR = 'unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD';

/** Loaded only when the page is shown (a hidden #site never fetches it). */
export const FONT_FACE = `@font-face{font-family:"PT Inter";font-style:normal;font-weight:100 900;font-display:swap;src:url("/fonts/inter-latin-wght-normal.woff2") format("woff2-variations");${UR}}@font-face{font-family:"PT Sora";font-style:normal;font-weight:100 800;font-display:swap;src:url("/fonts/sora-latin-wght-normal.woff2") format("woff2-variations");${UR}}`;

const KEYFRAMES = `
@keyframes pt-drift-a{0%,100%{transform:translate3d(0,0,0) scale(1)}50%{transform:translate3d(7%,9%,0) scale(1.18)}}
@keyframes pt-drift-b{0%,100%{transform:translate3d(0,0,0) scale(1.1)}50%{transform:translate3d(-9%,6%,0) scale(.92)}}
@keyframes pt-drift-c{0%,100%{transform:translate3d(0,0,0)}50%{transform:translate3d(5%,-9%,0) scale(1.2)}}
@keyframes pt-up{from{opacity:0;transform:translateY(18px)}to{opacity:1;transform:none}}
@keyframes pt-pop{0%{opacity:0;transform:scale(.6)}70%{transform:scale(1.06)}100%{opacity:1;transform:none}}
@keyframes pt-grow{from{transform:scaleX(0)}to{transform:scaleX(1)}}
@keyframes pt-growy{from{transform:scaleY(0)}to{transform:scaleY(1)}}
@keyframes pt-float{0%,100%{transform:translateY(0) rotate(var(--r,0deg))}50%{transform:translateY(-10px) rotate(var(--r,0deg))}}
@keyframes pt-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-6px)}}
@keyframes pt-twinkle{0%,100%{transform:scale(.7) rotate(0);opacity:.55}50%{transform:scale(1.15) rotate(45deg);opacity:1}}
@keyframes pt-dash{to{stroke-dashoffset:-48}}
@keyframes pt-nudge{0%,100%{transform:translateX(-14%)}50%{transform:translateX(14%)}}
@keyframes pt-knob{0%,12%{transform:translateX(0)}44%,62%{transform:translateX(calc(var(--run) * 1))}94%,100%{transform:translateX(0)}}
@keyframes pt-ring{0%{stroke-dashoffset:var(--c)}60%,100%{stroke-dashoffset:var(--k)}}
@keyframes pt-ping{0%{box-shadow:0 0 0 0 rgba(239,68,68,.5)}70%,100%{box-shadow:0 0 0 10px rgba(239,68,68,0)}}
@keyframes pt-blink{0%,100%{opacity:1}50%{opacity:.35}}
@keyframes pt-marquee{from{transform:translateX(0)}to{transform:translateX(-50%)}}
@keyframes pt-msg{from{opacity:0;transform:translateY(10px) scale(.97)}to{opacity:1;transform:none}}
@keyframes pt-seg{0%,40%{transform:translateX(0)}50%,90%{transform:translateX(100%)}100%{transform:translateX(0)}}
@keyframes pt-seg-l{0%,40%{color:#fff}50%,90%{color:var(--muted)}100%{color:#fff}}
@keyframes pt-seg-r{0%,40%{color:var(--muted)}50%,90%{color:#fff}100%{color:var(--muted)}}
@keyframes pt-note{from{opacity:0;transform:translateX(18px)}to{opacity:1;transform:none}}
@keyframes pt-shine{from{transform:translateX(-120%) skewX(-18deg)}to{transform:translateX(260%) skewX(-18deg)}}
@keyframes pt-hue{0%,100%{background-position:0 50%}50%{background-position:100% 50%}}
@keyframes pt-spin{from{rotate:0deg}to{rotate:360deg}}
@keyframes pt-spin-rev{from{rotate:0deg}to{rotate:-360deg}}
@keyframes pt-draw{to{stroke-dashoffset:0}}
@keyframes pt-node{0%,100%{box-shadow:0 0 0 0 rgba(124,58,237,.35)}60%{box-shadow:0 0 0 14px rgba(124,58,237,0)}}
@keyframes pt-sg-island{0%{transform:translateY(-70px) scale(.6);opacity:0}6%,66%{transform:none;opacity:1}72%,100%{transform:translateY(-24px) scale(.9);opacity:0}}
@keyframes pt-sg-hit{0%,40%{background:rgba(255,255,255,.08);transform:none}46%{background:#7c3aed;transform:scale(.93)}52%,66%{background:#7c3aed;transform:none}100%{background:rgba(255,255,255,.08)}}
@keyframes pt-sg-w{0%,64%{opacity:1;transform:none}70%,96%{opacity:0;transform:translateY(-6px)}100%{opacity:1;transform:none}}
@keyframes pt-sg-d{0%,64%{opacity:0;transform:translateY(6px)}70%,96%{opacity:1;transform:none}100%{opacity:0;transform:translateY(6px)}}
@keyframes pt-sg-ring{0%{stroke-dashoffset:327}64%{stroke-dashoffset:60}70%,96%{stroke-dashoffset:0}100%{stroke-dashoffset:327}}
@keyframes pt-sg-pulse{0%{transform:scale(.6);opacity:.55}100%{transform:scale(1.5);opacity:0}}
@keyframes pt-sg-line{0%,8%{opacity:0;transform:translateY(8px)}16%,92%{opacity:1;transform:none}100%{opacity:0}}
@keyframes pt-prog{from{transform:scaleX(0)}to{transform:scaleX(1)}}
@keyframes pt-glow-pulse{0%,100%{opacity:.5}50%{opacity:1}}
@keyframes pt-tangle{0%{opacity:0}100%{opacity:1}}
@keyframes pt-flow{to{stroke-dashoffset:-36}}
`;

const COMPONENTS = `
__ROOT__{--bg:#fbfaff;--surface:#fff;--surface-a:rgba(255,255,255,.78);--surface-2:#f4f1ff;--text:#1c1938;--ink:#12102a;--muted:#625f7d;--line:#e9e5f8;--brand:#7c3aed;--brand-soft:#f1eaff;--ok:#16a34a;--warn:#d97706;--bad:#dc2626;--sky:#3b82f6;--cyan:#22d3ee;--pink:#ec4899;--amber:#ffc23d;
  --grad:linear-gradient(120deg,#7c3aed 0%,#3b82f6 55%,#22d3ee 100%);--glow:0 30px 70px -26px rgba(76,45,170,.35);--card:0 1px 0 rgba(255,255,255,.9) inset,0 18px 44px -18px rgba(54,38,122,.28),0 2px 6px rgba(54,38,122,.06);
  --ink-bg:#0e0b22;--on-ink:#f5f2ff;--on-ink-2:#b9b2d8;--glass-line:rgba(255,255,255,.14);--disp:${DISPLAY};
  background:var(--bg);color:var(--text);font:16px/1.6 ${FONT};-webkit-font-smoothing:antialiased;font-feature-settings:"cv11","ss01";color-scheme:light}
*{box-sizing:border-box}
a{color:var(--brand);text-decoration:none}a:hover{text-decoration:underline}
h1,h2,h3,h4,p,ul{margin:0}
.sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
h1,h2,h3,h4{font-family:var(--disp);color:var(--ink)}
.wrap{max-width:1320px;margin:0 auto;padding:0 clamp(20px,3.4vw,56px)}
.progress{position:fixed;top:0;left:0;right:0;height:3px;background:var(--grad);transform-origin:left;transform:scaleX(0);z-index:40;display:none}
@supports (animation-timeline:scroll()){.progress{display:block;animation:pt-prog linear both;animation-timeline:scroll(root)}}

/* ---- header: brand, a floating capsule of links, and the way in */
.top{position:sticky;top:0;z-index:30;padding:14px 0;transition:background .3s,box-shadow .3s,padding .3s,backdrop-filter .3s}
.top.scrolled{background:rgba(251,250,255,.82);-webkit-backdrop-filter:blur(18px) saturate(1.5);backdrop-filter:blur(18px) saturate(1.5);box-shadow:0 1px 0 var(--line);padding:9px 0}
.top .wrap{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:18px}
.brand{display:inline-flex;align-items:center;gap:10px;font:800 18px/1 var(--disp);color:var(--ink);letter-spacing:-.4px;justify-self:start}.brand:hover{text-decoration:none}
.brand .logo,.brand img{width:34px;height:34px;border-radius:10px;display:block;box-shadow:0 8px 20px -6px rgba(124,58,237,.6)}
.nav{display:flex;gap:2px;padding:5px;border-radius:99px;background:var(--surface-a);-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);box-shadow:var(--card);border:1px solid rgba(255,255,255,.7)}
.nav a{padding:8px 16px;border-radius:99px;color:var(--muted);font-weight:650;font-size:14.5px;transition:background .2s,color .2s,box-shadow .2s;white-space:nowrap}
.nav a:hover{color:var(--ink);text-decoration:none;background:rgba(124,58,237,.08)}
.nav a[aria-current]{color:var(--ink);background:#fff;box-shadow:0 4px 14px -4px rgba(54,38,122,.3)}
.actions{display:flex;align-items:center;gap:8px;justify-self:end}
.btn{position:relative;overflow:hidden;display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:11px 20px;border-radius:99px;font-weight:700;font-size:15px;border:1px solid transparent;cursor:pointer;line-height:1.2;font-family:inherit;transition:transform .2s,box-shadow .25s,background .2s,border-color .2s,color .2s}
.btn:hover{text-decoration:none;transform:translateY(-2px)}
.btn svg{flex:none;transition:transform .25s}.btn:hover svg{transform:translate(2px,-2px)}
.btn-primary{background:var(--ink);color:#fff;box-shadow:0 12px 28px -10px rgba(18,16,42,.7)}
.btn-primary:hover{box-shadow:0 16px 34px -10px rgba(18,16,42,.8);background:#1d1a3f}
.btn-primary::after{content:"";position:absolute;top:0;bottom:0;width:38%;left:0;background:linear-gradient(90deg,transparent,rgba(255,255,255,.28),transparent);transform:translateX(-120%) skewX(-18deg)}
.btn-primary:hover::after{animation:pt-shine .8s ease}
.btn-brand{background:linear-gradient(135deg,#7c3aed,#6366f1 60%,#3b82f6);color:#fff;box-shadow:0 14px 32px -10px rgba(99,70,241,.75)}
.btn-brand:hover{box-shadow:0 18px 38px -10px rgba(99,70,241,.9)}
.btn-ghost{background:var(--surface);color:var(--ink);border-color:var(--line)}.btn-ghost:hover{border-color:var(--brand);color:var(--brand)}
.btn-glass{background:transparent;color:var(--ink);border-color:transparent}.btn-glass:hover{background:rgba(124,58,237,.08);transform:none}
.btn-lg{padding:16px 30px;font-size:16px}

/* ---- soft light behind the heroes: blobs, a blueprint grid and crosshairs */
.dark{position:relative;isolation:isolate;overflow:hidden}
.aurora{position:absolute;inset:0;z-index:-2;overflow:hidden;pointer-events:none}
.aurora i{position:absolute;border-radius:50%;filter:blur(80px);will-change:transform}
.aurora i:nth-child(1){width:52vw;height:52vw;max-width:820px;max-height:820px;left:-14%;top:-30%;background:radial-gradient(circle,#ffd9b8,transparent 66%);opacity:.8;animation:pt-drift-a 20s ease-in-out infinite}
.aurora i:nth-child(2){width:50vw;height:50vw;max-width:780px;max-height:780px;right:-12%;top:-26%;background:radial-gradient(circle,#cdbcff,transparent 66%);opacity:.85;animation:pt-drift-b 24s ease-in-out infinite}
.aurora i:nth-child(3){width:46vw;height:46vw;max-width:700px;max-height:700px;left:28%;bottom:-46%;background:radial-gradient(circle,#bfe3ff,transparent 66%);opacity:.8;animation:pt-drift-c 28s ease-in-out infinite}
.aurora i:nth-child(4){width:30vw;height:30vw;max-width:460px;max-height:460px;right:16%;bottom:-24%;background:radial-gradient(circle,#ffc6e6,transparent 66%);opacity:.55;animation:pt-drift-b 22s ease-in-out infinite reverse}
.gridbg{position:absolute;inset:0;z-index:-1;pointer-events:none;background-image:linear-gradient(rgba(76,45,170,.07) 1px,transparent 1px),linear-gradient(90deg,rgba(76,45,170,.07) 1px,transparent 1px);background-size:64px 64px;background-position:center top;-webkit-mask-image:radial-gradient(ellipse 80% 70% at 50% 34%,#000 28%,transparent 78%);mask-image:radial-gradient(ellipse 80% 70% at 50% 34%,#000 28%,transparent 78%)}
.grain{display:none}
.cross{position:absolute;inset:0;z-index:-1;pointer-events:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www%2Ew3%2Eorg/2000/svg' width='256' height='256'%3E%3Cpath d='M128 118v20M118 128h20' stroke='%237c3aed' stroke-opacity='.35' stroke-width='1.4' stroke-linecap='round'/%3E%3C/svg%3E");background-size:256px 256px;background-position:center top;-webkit-mask-image:radial-gradient(ellipse 80% 60% at 50% 30%,#000 20%,transparent 78%);mask-image:radial-gradient(ellipse 80% 60% at 50% 30%,#000 20%,transparent 78%)}

/* ---- hero */
.hero{padding:0 0 40px;margin-top:-70px}
.hero .wrap{display:block;padding-top:128px;text-align:center}
.kicker{display:inline-flex;align-items:center;gap:8px;padding:6px 16px 6px 7px;border-radius:99px;background:var(--surface-a);border:1px solid rgba(255,255,255,.8);box-shadow:var(--card);color:var(--ink);font-weight:650;font-size:13.5px;animation:pt-up .7s both}
.kicker b{background:linear-gradient(135deg,#7c3aed,#3b82f6);color:#fff;border-radius:99px;padding:3px 11px;font-size:11.5px;letter-spacing:.4px}
.stage{position:relative;container-type:inline-size;max-width:1180px;margin:34px auto 0}
.hero h1{position:relative;z-index:1;margin:0;font:800 7.5cqw/1.06 var(--disp);letter-spacing:-.032em;color:var(--ink);text-align:center;animation:pt-up .9s .08s both}
@supports not (width:1cqw){.hero h1{font-size:clamp(34px,7.2vw,88px)}}
.ln{display:flex;align-items:center;justify-content:center;gap:.14em;white-space:nowrap;margin-bottom:.06em}
.grad{background:var(--grad);background-size:220% 100%;-webkit-background-clip:text;background-clip:text;color:transparent;-webkit-text-fill-color:transparent;animation:pt-hue 9s ease-in-out infinite}
/* the little controls inside the headline: every size is in em, so they scale with the words */
.tok{position:relative;display:inline-flex;flex:none;align-items:center;height:.98em;vertical-align:middle}
.tok-go{width:.98em;border-radius:50%;justify-content:center;background:radial-gradient(circle at 32% 26%,#8bf0a8,#34c26a 62%,#25a355);box-shadow:inset 0 -.05em .09em rgba(0,80,30,.28),inset 0 .04em .06em rgba(255,255,255,.55),0 .12em .28em -.1em rgba(37,163,85,.7)}
.tok-go svg{width:.5em;height:.5em;animation:pt-nudge 2.6s ease-in-out infinite}
.tok-bar{width:2.7em;border-radius:99px;background:linear-gradient(90deg,#2f6bff 0%,#5a5cff 46%,#c457e4 82%,#ff7ab6 100%);background-size:160% 100%;animation:pt-hue 7s ease-in-out infinite;box-shadow:inset 0 .05em .1em rgba(255,255,255,.35),0 .16em .34em -.14em rgba(76,70,255,.8)}
.tok-bar .knob{--run:-1.7em;position:absolute;right:.06em;top:50%;margin-top:-.4em;width:.8em;height:.8em;border-radius:50%;background:radial-gradient(circle at 35% 25%,#fff,#eef0ff 70%);box-shadow:0 .08em .2em rgba(20,20,80,.35);display:grid;place-items:center;animation:pt-knob 6.5s ease-in-out infinite}
.tok-bar .knob svg{position:absolute;inset:.06em;width:.68em;height:.68em;transform:rotate(-90deg)}
.tok-bar .knob circle{fill:none;stroke-width:3.2}
.tok-bar .knob .bg{stroke:#dfe3ff}.tok-bar .knob .fg{stroke:#4f46e5;stroke-linecap:round;--c:100;--k:30;stroke-dasharray:100;animation:pt-ring 6.5s ease-in-out infinite}
.tok-bar .knob b{position:relative;font:800 .2em/1 var(--disp);letter-spacing:0;color:#2b2a6b}
.tok-step{width:1.5em}
.tok-step .dot{width:.98em;height:.98em;border-radius:50%;background:radial-gradient(circle at 32% 26%,#ffe38a,#ffc23d 60%,#f5a30a);box-shadow:inset 0 -.05em .09em rgba(150,90,0,.3),inset 0 .04em .06em rgba(255,255,255,.6),0 .12em .28em -.1em rgba(245,163,10,.7)}
.tok-step .cap{position:absolute;left:.52em;top:50%;margin-top:-.25em;height:.5em;width:.96em;border-radius:99px;background:linear-gradient(180deg,#fff,#f1f1f8);box-shadow:0 .08em .24em rgba(40,30,90,.28),inset 0 -.03em .05em rgba(0,0,0,.05);display:grid;place-items:center;animation:pt-bob 3.4s ease-in-out infinite}
.tok-step .cap i{width:.3em;height:.05em;border-radius:3px;background:var(--ink)}
.tok-sw{width:2.05em;height:.72em;border-radius:99px;border:.06em solid var(--ink);background:#fff}
.tok-sw i{--run:1.12em;position:absolute;left:.1em;top:50%;margin-top:-.2em;width:.4em;height:.4em;border-radius:50%;background:radial-gradient(circle at 35% 28%,#8bf0a8,#2fbf68);box-shadow:0 .05em .12em rgba(30,120,70,.45);animation:pt-knob 5.4s ease-in-out infinite}
.tok-pair{width:1.9em}
.tok-pair .a,.tok-pair .b{position:absolute;top:0;width:.98em;height:.98em;border-radius:50%}
.tok-pair .a{left:0;background:radial-gradient(circle at 30% 24%,#d98bff,#8b5cf6 52%,#ff8a6b);box-shadow:0 .12em .28em -.1em rgba(139,92,246,.7)}
.tok-pair .b{right:0;background:radial-gradient(circle at 34% 26%,#cfe6ff,#8ec5ff 60%,#58a6ff);box-shadow:0 .12em .28em -.1em rgba(88,166,255,.7);mix-blend-mode:normal}
.tok-pair .k{position:absolute;left:50%;top:50%;margin:-.26em 0 0 -.5em;width:1em;height:.52em;border-radius:99px;background:linear-gradient(180deg,rgba(255,255,255,.96),rgba(240,240,250,.88));box-shadow:0 .08em .24em rgba(40,30,90,.26);display:grid;place-items:center}
.tok-pair .k b{display:grid;place-items:center;width:.62em;height:.34em;border-radius:.1em;background:#fff;box-shadow:0 .03em .08em rgba(0,0,0,.25),inset 0 -.03em 0 rgba(0,0,0,.08);font:700 .22em/1 var(--disp);letter-spacing:0;color:var(--ink)}
.wires{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible;z-index:2}
.wires path{fill:none;stroke:var(--ink);stroke-width:5;stroke-linecap:round;stroke-dasharray:14 11;animation:pt-dash 1.6s linear infinite}
.wires .end{fill:var(--sky)}.wires .end2{fill:var(--sky)}
.cur{position:absolute;z-index:3;display:flex;align-items:flex-start;gap:3px;font:700 13px/1 var(--disp);animation:pt-bob 3.6s ease-in-out infinite}
.cur svg{width:22px;height:22px;filter:drop-shadow(0 4px 6px rgba(20,20,60,.3))}
.cur span{margin-top:15px;padding:4px 9px;border-radius:99px;color:#fff;background:var(--sky);box-shadow:0 8px 16px -6px rgba(59,130,246,.7)}
.cur.g span{background:#22b56b;box-shadow:0 8px 16px -6px rgba(34,181,107,.7)}
.spark{position:absolute;z-index:0;width:clamp(18px,3.6cqw,44px);height:auto;animation:pt-twinkle 4s ease-in-out infinite;pointer-events:none}
.lead{position:relative;z-index:1;font-size:clamp(17px,1.6vw,21px);color:var(--muted);max-width:36em;margin:30px auto 0;animation:pt-up .8s .2s both}
.cta{position:relative;z-index:1;display:flex;flex-wrap:wrap;gap:14px;justify-content:center;align-items:center;margin-top:30px;animation:pt-up .8s .3s both}
.cta .link{font-weight:700;color:var(--ink);border-bottom:2px solid var(--ink);padding-bottom:1px}.cta .link:hover{text-decoration:none;color:var(--brand);border-color:var(--brand)}
.fine{margin-top:16px;font-size:13.5px;color:var(--muted);animation:pt-up .8s .36s both}

/* ---- the fan of live cards under the hero */
.fan{position:relative;max-width:1060px;height:420px;margin:56px auto 0;perspective:1400px;--px:0;--py:0}
.fan>*{position:absolute;transform:translate3d(calc(var(--px) * var(--dx,0px)),calc(var(--py) * var(--dy,0px)),0) rotate(var(--r,0deg));transition:transform .5s cubic-bezier(.2,.7,.2,1)}
.glass{background:var(--surface-a);-webkit-backdrop-filter:blur(18px) saturate(1.4);backdrop-filter:blur(18px) saturate(1.4);border:1px solid rgba(255,255,255,.85);box-shadow:var(--card);border-radius:22px}
.demo{left:50%;top:0;width:min(470px,86%);margin-left:max(-235px,-43%);padding:18px;display:grid;gap:11px;text-align:left;z-index:3;animation:pt-up .9s .35s both;--dx:-10px;--dy:-6px}
.demo::before{content:"";position:absolute;inset:-1px;border-radius:23px;padding:1.5px;background:linear-gradient(135deg,rgba(124,58,237,.55),rgba(59,130,246,.18) 45%,rgba(236,72,153,.5));-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask-composite:exclude;pointer-events:none}
.demo-head{display:flex;justify-content:space-between;align-items:center;font-size:14.5px;color:var(--ink)}
.live{display:inline-flex;align-items:center;gap:7px;color:var(--muted);font-size:12.5px;font-weight:600}.live i{width:8px;height:8px;border-radius:50%;background:#22c55e;animation:pt-blink 1.8s infinite}
.proj{display:grid;grid-template-columns:1fr auto;gap:6px 12px;padding:12px 14px;border-radius:14px;background:#fff;border:1px solid var(--line)}
.proj b{font-size:14.5px;color:var(--ink)}.proj .meta{grid-column:1;font-size:12.5px;color:var(--muted)}
.chip{font-size:12px;font-weight:700;padding:3px 11px;border-radius:99px;align-self:start;white-space:nowrap;transition:background .3s,color .3s}
.chip.ok{background:#d6f7e2;color:#14532d}.chip.warn{background:#fdecb4;color:#78350f}.chip.bad{background:#fdd8d8;color:#7f1d1d;animation:pt-ping 2.2s infinite}
.bar{grid-column:1/-1;height:7px;background:var(--surface-2);border-radius:9px;overflow:hidden}
.bar i{display:block;height:100%;width:var(--w);transform-origin:left;background:linear-gradient(90deg,#7c3aed,#3b82f6,#22d3ee);border-radius:9px;animation:pt-grow 1.3s cubic-bezier(.2,.7,.2,1) .6s both}
.whatif{display:none;gap:10px;padding:13px 14px;border-radius:14px;background:linear-gradient(135deg,#f3edff,#e9f3ff);border:1px solid #ddd2ff}
__JS__ .whatif{display:grid}
.whatif .q{font-size:13px;color:var(--muted)}.whatif .q b{color:var(--ink)}
.whatif .row{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.step{width:34px;height:34px;border-radius:10px;border:1px solid var(--line);background:#fff;color:var(--ink);font-size:19px;font-weight:700;cursor:pointer;line-height:1;transition:background .2s,transform .15s,box-shadow .2s;box-shadow:0 4px 10px -4px rgba(54,38,122,.25)}
.step:hover{background:var(--brand-soft)}.step:active{transform:scale(.92)}
.whatif output{min-width:5.5ch;text-align:center;font-weight:800;font-size:16px;color:var(--ink)}
.whatif .res{margin-left:auto;text-align:right;font-size:13px;color:var(--muted)}.whatif .res b{display:block;font-size:16px;color:var(--ink);transition:color .3s}
.whatif .res b.ok{color:var(--ok)}.whatif .res b.bad{color:var(--bad)}
.small{font-size:12px;color:var(--muted)}
.f-left{left:0;top:62px;width:290px;padding:16px;text-align:left;--r:-6deg;--dx:-26px;--dy:12px;z-index:2;animation:pt-up .9s .5s both}
.f-right{right:0;top:44px;width:290px;padding:16px;text-align:left;--r:5deg;--dx:26px;--dy:10px;z-index:2;animation:pt-up .9s .6s both}
.f-left h4,.f-right h4{font-size:13px;color:var(--muted);font-weight:700;letter-spacing:.2px;margin-bottom:10px;display:flex;align-items:center;gap:8px}
.f-left h4 i,.f-right h4 i{display:grid;place-items:center;width:24px;height:24px;border-radius:8px;background:var(--brand-soft);color:var(--brand);font-style:normal}
.rem{display:grid;gap:8px}
.rem div{display:flex;gap:10px;align-items:center;padding:9px 11px;border-radius:12px;background:#fff;border:1px solid var(--line);font-size:12.5px;font-weight:600;color:var(--ink)}
.rem div i{flex:none;width:26px;height:26px;border-radius:8px;display:grid;place-items:center;font-style:normal;font-weight:800;font-size:13px}
.rem .a i{background:#fde7e7;color:#dc2626}.rem .b i{background:#dff7e8;color:#16a34a}.rem .c i{background:#e8f0ff;color:#2563eb}
.rem small{display:block;font-weight:500;color:var(--muted);font-size:11.5px}
.bub{display:grid;gap:8px}
.bub p{padding:9px 12px;border-radius:14px;font-size:12.5px;line-height:1.45;max-width:92%}
.bub .u{justify-self:end;background:linear-gradient(135deg,#7c3aed,#6366f1);color:#fff;border-bottom-right-radius:4px}
.bub .a{background:#fff;border:1px solid var(--line);border-bottom-left-radius:4px;color:var(--ink)}
.bub .a em{display:inline-block;margin-top:6px;padding:3px 10px;border-radius:99px;background:var(--brand-soft);color:var(--brand);font-style:normal;font-weight:700;font-size:11.5px}
.f-pill{display:flex;align-items:center;gap:10px;padding:8px 16px 8px 8px;border-radius:99px;font-weight:650;font-size:13px;white-space:nowrap}
.f-pill.dk{left:2%;bottom:10px;background:var(--ink);color:#fff;box-shadow:0 18px 36px -14px rgba(18,16,42,.7);--r:-3deg;--dx:-36px;--dy:-14px;z-index:4;animation:pt-bob 4.6s ease-in-out infinite}
.f-pill.pu{right:3%;bottom:2px;background:linear-gradient(135deg,#8b5cf6,#6d28d9);color:#fff;box-shadow:0 18px 36px -14px rgba(109,40,217,.7);--r:3deg;--dx:34px;--dy:-10px;z-index:4;animation:pt-bob 5.2s ease-in-out infinite reverse}
.av{display:grid;place-items:center;flex:none;width:30px;height:30px;border-radius:50%;font:800 11px/1 var(--disp);color:#fff;background:linear-gradient(135deg,#f97316,#ec4899)}
.av.b{background:linear-gradient(135deg,#3b82f6,#22d3ee)}.av.c{background:linear-gradient(135deg,#8b5cf6,#ec4899)}
.f-pill small{display:block;font-weight:500;font-size:11px;opacity:.75}

/* ---- logos strip */
.marquee{position:relative;overflow:hidden;padding:20px 0;margin-top:6px}
.marquee::before,.marquee::after{content:"";position:absolute;top:0;bottom:0;width:110px;z-index:1;pointer-events:none}
.marquee::before{left:0;background:linear-gradient(90deg,var(--bg),transparent)}.marquee::after{right:0;background:linear-gradient(270deg,var(--bg),transparent)}
.marquee .track{display:flex;width:max-content;gap:14px;animation:pt-marquee 42s linear infinite}
.marquee:hover .track{animation-play-state:paused}
.marquee span{display:inline-flex;align-items:center;gap:9px;padding:9px 18px;border-radius:99px;border:1px solid var(--line);background:var(--surface);color:var(--muted);font-weight:650;font-size:14px;white-space:nowrap;box-shadow:0 6px 16px -10px rgba(54,38,122,.3)}
.marquee span::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--grad)}

section.block{padding:96px 0}
.eyebrow{color:var(--brand);font-weight:800;font-size:12.5px;letter-spacing:1.3px;text-transform:uppercase;margin-bottom:14px}
h2{font-size:clamp(30px,4.2vw,56px);line-height:1.06;letter-spacing:-.04em;margin-bottom:16px;font-weight:800}
.sub{color:var(--muted);font-size:clamp(16px,1.4vw,19px);margin-bottom:44px;max-width:38em}
.center{text-align:center}.center .sub{margin-inline:auto}

__JS__ [data-r]{opacity:0;transform:translateY(26px);transition:opacity .8s cubic-bezier(.2,.7,.2,1),transform .8s cubic-bezier(.2,.7,.2,1);transition-delay:var(--d,0s)}
__JS__ [data-r].in{opacity:1;transform:none}

/* ---- tangled tools, then one clear line */
.mess{display:grid;grid-template-columns:1.15fr 1fr;gap:20px;margin-top:8px}
.panel{position:relative;display:flex;flex-direction:column;overflow:hidden;border-radius:30px;background:var(--surface);border:1px solid var(--line);box-shadow:var(--card);padding:26px 26px 22px}
.panel h3{font-size:17px;letter-spacing:-.2px;margin-bottom:4px;display:flex;align-items:center;gap:10px}
.panel>p{color:var(--muted);font-size:14.5px;max-width:30em}
.panel .tg{display:inline-block;padding:2px 10px;border-radius:99px;font-weight:700;font-size:11.5px;background:#fdecec;color:#b91c1c}
.panel.us{background:linear-gradient(180deg,#fff,#f7f3ff);border-color:#ddd2ff}.panel.us .tg{background:#e4f7ec;color:#15803d}
.mess svg.art{display:block;width:100%;height:auto;margin:auto 0}
.tube{fill:none;stroke-linecap:round;stroke-linejoin:round}
.tube.base{stroke:#dedbed;stroke-width:22}.tube.hi{stroke:#fff;stroke-width:7;opacity:.9;transform:translate(-2px,-3px)}.tube.sh{stroke:#d9d6e8;stroke-width:22;transform:translate(3px,5px);opacity:.55}
__JS__ .tube.draw{stroke-dasharray:var(--len,2400);stroke-dashoffset:var(--len,2400)}
__JS__ .in .tube.draw{animation:pt-draw 2.4s cubic-bezier(.5,.1,.2,1) forwards}
.app{filter:drop-shadow(0 8px 14px rgba(40,30,90,.22))}
__JS__ .art .app,__JS__ .art .say{opacity:0}
.in .art .app,.in .art .say{animation:pt-pop .55s cubic-bezier(.2,.7,.2,1) both;animation-delay:var(--md,0s)}
.say rect{fill:#fff;stroke:#ece9f7}.say text{font-family:Inter,sans-serif;font-weight:600;font-size:12px;fill:#35324f}
.alert circle.core{fill:#ef4444}.alert circle.ring{fill:none;stroke:#ef4444;stroke-width:3;opacity:.55;transform-origin:center;transform-box:fill-box;animation:pt-sg-pulse 1.8s ease-out infinite}
.flowline{fill:none;stroke:url(#ptg);stroke-width:7;stroke-linecap:round}
.flowdash{fill:none;stroke:#fff;stroke-width:2.4;stroke-linecap:round;stroke-dasharray:6 12;animation:pt-flow 1.4s linear infinite;opacity:.9}
.okrow{display:flex;flex-wrap:wrap;gap:8px;margin-top:6px}.okrow span{display:inline-flex;gap:6px;align-items:center;padding:5px 12px;border-radius:99px;background:#fff;border:1px solid #ddd2ff;font-size:12.5px;font-weight:650;color:var(--ink)}
.okrow svg{color:var(--ok)}

/* ---- one workspace, in orbit */
.orbit-wrap{position:relative;margin-top:6px}
.orbit{position:relative;container-type:inline-size;width:100%;max-width:1120px;margin:0 auto;aspect-ratio:2/1;overflow:hidden}
.ring{position:absolute;left:50%;top:100%;aspect-ratio:1;border-radius:50%;border:1.5px solid #e4e0f4;translate:-50% -50%;animation:pt-spin var(--t,120s) linear infinite;animation-direction:var(--dir,normal)}
.ring.r1{width:92%;--t:150s}.ring.r2{width:68%;--t:120s;--dir:reverse;border-color:#d8d3ef}
.slot{position:absolute;inset:0;transform:rotate(var(--a))}
.slot .pos{position:absolute;left:50%;top:0;translate:-50% -50%}
.slot .spin{display:block;animation:pt-spin-rev var(--t,120s) linear infinite;animation-direction:var(--dir,normal)}
.slot .st{display:block;transform:rotate(calc(var(--a) * -1))}
.oc{display:inline-flex;align-items:center;gap:7px;padding:5px 12px 5px 6px;border-radius:99px;background:#fff;border:1px solid var(--line);box-shadow:0 10px 24px -12px rgba(54,38,122,.4);font-weight:650;font-size:clamp(9px,1.35cqw,15px);white-space:nowrap;color:var(--ink)}
.oc.sq{padding:0;width:clamp(30px,4.6cqw,54px);height:clamp(30px,4.6cqw,54px);border-radius:16%;justify-content:center;color:var(--brand)}
.oc.sq svg{width:46%;height:46%}
.oc.ok{background:#e8f9ef;border-color:#c9efd8;color:#15803d}
.oc.pu{background:#f1eaff;border-color:#ddd2ff;color:#6d28d9}
.oc .av{width:clamp(22px,3.2cqw,38px);height:clamp(22px,3.2cqw,38px);font-size:clamp(8px,1.1cqw,12px)}
.oc.round{padding:3px;border-radius:50%;box-shadow:0 0 0 4px rgba(255,255,255,.9),0 12px 26px -10px rgba(54,38,122,.5)}
.orbit-center{position:absolute;left:0;right:0;bottom:3%;text-align:center;z-index:2}
.stats{display:flex;justify-content:center;gap:clamp(22px,6cqw,84px);margin-bottom:20px}
.stats div{display:grid;gap:2px}.stats b{font:800 clamp(34px,6.2cqw,76px)/1 var(--disp);letter-spacing:-.05em;color:#14304a;background:linear-gradient(180deg,#14304a,#2f5a86);-webkit-background-clip:text;background-clip:text;color:transparent}
.stats span{color:var(--muted);font-size:clamp(11px,1.45cqw,16px);font-weight:600}
.orbit-title{font:700 clamp(18px,2.9cqw,34px)/1.2 var(--disp);letter-spacing:-.03em;color:#3c3a52;max-width:15em;margin:0 auto}
.tags{display:flex;flex-wrap:wrap;gap:10px;justify-content:center;margin-top:22px}
.tags span{display:inline-flex;align-items:center;gap:8px;padding:10px 16px;border-radius:12px;border:1px solid var(--line);background:#fff;font-weight:600;font-size:14px;color:var(--muted);box-shadow:0 8px 18px -12px rgba(54,38,122,.35);transition:transform .25s,color .25s,border-color .25s}
.tags span:hover{transform:translateY(-3px);color:var(--brand);border-color:#cdbcff}.tags svg{color:var(--brand)}

/* ---- feature tiles */
.bento{display:grid;grid-template-columns:repeat(6,1fr);gap:16px}
.tile{position:relative;overflow:hidden;grid-column:span 2;background:var(--surface);border:1px solid var(--line);border-radius:26px;padding:26px;display:flex;flex-direction:column;gap:6px;box-shadow:0 10px 30px -22px rgba(54,38,122,.4);transition:transform .35s cubic-bezier(.2,.7,.2,1),border-color .3s,box-shadow .3s}
.tile.w{grid-column:span 4}.tile.h{grid-row:span 2}
.tile::before{content:"";position:absolute;inset:0;background:radial-gradient(420px circle at var(--mx,50%) var(--my,0%),rgba(124,58,237,.12),transparent 60%);opacity:0;transition:opacity .3s;pointer-events:none}
.tile:hover{transform:translateY(-5px);border-color:#cdbcff;box-shadow:var(--glow)}.tile:hover::before{opacity:1}
.tile h3{font-size:20px;letter-spacing:-.03em}.tile p{color:var(--muted);font-size:15px}
.tile .vis{margin-top:auto;padding-top:18px}
.tag{display:inline-block;align-self:flex-start;padding:3px 11px;border-radius:99px;background:var(--brand-soft);color:var(--brand);font-weight:700;font-size:11.5px;margin-bottom:8px}
.rows{display:grid;gap:9px}
.r{display:grid;grid-template-columns:1fr auto;gap:5px 10px;padding:11px 13px;border-radius:14px;background:var(--surface-2);font-size:13.5px}
.r b{font-weight:700}.r .bar{background:#e4dffa}
.chat{display:grid;gap:9px}
.msg{max-width:88%;padding:10px 14px;border-radius:16px;font-size:13.5px;line-height:1.45}
__JS__ .msg{opacity:0}
.in .msg,.msg.on{animation:pt-msg .5s cubic-bezier(.2,.7,.2,1) both;animation-delay:var(--md,0s)}
.msg.u{justify-self:end;background:linear-gradient(135deg,#7c3aed,#6366f1);color:#fff;border-bottom-right-radius:5px}
.msg.a{background:var(--surface-2);border-bottom-left-radius:5px}
.msg .act{display:inline-block;margin-top:7px;padding:4px 11px;border-radius:99px;background:#fff;color:var(--brand);font-weight:700;font-size:12px}
.seg{position:relative;display:grid;grid-template-columns:1fr 1fr;padding:4px;border-radius:12px;background:var(--surface-2);font-size:13px;font-weight:700;text-align:center}
.seg::before{content:"";position:absolute;left:4px;top:4px;bottom:4px;width:calc(50% - 4px);border-radius:9px;background:linear-gradient(135deg,#7c3aed,#6366f1);animation:pt-seg 6s ease-in-out infinite}
.seg span{position:relative;padding:8px 6px}.seg span:first-child{color:#fff;animation:pt-seg-l 6s ease-in-out infinite}.seg span:last-child{color:var(--muted);animation:pt-seg-r 6s ease-in-out infinite}
.chips{display:flex;gap:7px;flex-wrap:wrap;margin-top:10px}.chips span{padding:4px 11px;border-radius:99px;background:var(--surface-2);font-size:12.5px;font-weight:600}
.notes{display:grid;gap:8px}
.note{display:flex;gap:10px;align-items:center;padding:10px 12px;border-radius:14px;background:var(--surface-2);font-size:13px}
__JS__ .note{opacity:0}
.in .note{animation:pt-note .55s cubic-bezier(.2,.7,.2,1) both;animation-delay:var(--md,0s)}
.note i{flex:none;width:30px;height:30px;border-radius:9px;background:#fff;color:var(--brand);display:grid;place-items:center;font-style:normal;font-weight:800}
.cap{display:flex;align-items:flex-end;gap:10px;height:110px;padding-top:6px;border-bottom:1px dashed var(--line);position:relative}
.cap::after{content:"";position:absolute;left:0;right:0;top:34%;border-top:1px dashed rgba(220,38,38,.5)}
.cap i{flex:1;height:var(--h);border-radius:8px 8px 0 0;background:linear-gradient(180deg,#a78bfa,#7c3aed);transform-origin:bottom;animation:pt-growy 1s cubic-bezier(.2,.7,.2,1) both;animation-delay:var(--md,0s)}
.cap i.over{background:linear-gradient(180deg,#fda4af,#e11d48)}
.pills{display:flex;gap:8px;flex-wrap:wrap}.pills span{padding:6px 12px;border-radius:99px;border:1px solid var(--line);background:var(--surface-2);font-size:13px;font-weight:600}
.chain{display:flex;align-items:center;justify-content:center;flex-wrap:wrap;gap:0;padding-top:4px}
.chain .ln2{flex:0 0 18px;height:2px;background:repeating-linear-gradient(90deg,#cfc8ee 0 4px,transparent 4px 8px)}
.chain .chip{flex:none;width:34px;height:34px;border-radius:10px;display:grid;place-items:center;background:var(--surface-2);color:var(--muted);border:1px solid var(--line)}
.chain .hub{flex:none;width:42px;height:42px;border-radius:50%;display:grid;place-items:center;background:linear-gradient(135deg,#7c3aed,#6366f1 60%,#22d3ee);color:#fff;box-shadow:0 10px 24px rgba(124,58,237,.35)}
.pills span::before{content:"✓ ";color:var(--ok);font-weight:800}

/* ---- a curved path with three stops */
.path{position:relative;isolation:isolate;container-type:inline-size;max-width:1120px;margin:30px auto 0;aspect-ratio:2.1/1}
.path svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible}
.path .curve{fill:none;stroke:url(#ptp);stroke-width:5;stroke-linecap:round;filter:drop-shadow(0 8px 10px rgba(124,58,237,.28))}
__JS__ .path .curve{stroke-dasharray:var(--len,1500);stroke-dashoffset:var(--len,1500)}
__JS__ .in .path .curve,__JS__ .path.in .curve{animation:pt-draw 2.6s cubic-bezier(.45,.1,.2,1) forwards}
.stop{position:absolute;width:min(30%,320px)}
.stop b.n{position:absolute;z-index:-1;font:800 clamp(80px,17cqw,200px)/.8 var(--disp);color:#f1effa;letter-spacing:-.06em;left:62%;top:-30%}
.stop h3{font-size:clamp(14px,1.7cqw,19px);letter-spacing:-.02em;margin-bottom:6px}.stop p{color:var(--muted);font-size:clamp(12px,1.35cqw,15px);line-height:1.55}
.node{position:absolute;translate:-50% -50%;width:clamp(26px,4.2cqw,46px);height:clamp(26px,4.2cqw,46px);border-radius:28%;background:#fff;box-shadow:0 12px 26px -8px rgba(54,38,122,.4);display:grid;place-items:center;animation:pt-node 2.8s ease-out infinite}
.node i{width:46%;height:46%;border-radius:50%;background:var(--grad)}
.s1{left:11%;top:68%}.s2{left:42%;top:52%}.s3{left:66%;top:6%}
.pathcopy{display:none}

/* ---- versus */
.vs{border:1px solid var(--line);border-radius:26px;overflow:hidden;background:var(--surface);box-shadow:var(--card)}
.vs .hd,.vs .rw{display:grid;grid-template-columns:1.1fr 1fr 1.25fr;gap:0}
.vs .hd{background:var(--surface-2);font-weight:800;font-size:14px}
.vs .hd>div,.vs .rw>div{padding:16px 22px}
.vs .hd .us{background:linear-gradient(135deg,#7c3aed,#6366f1);color:#fff}
.vs .rw{border-top:1px solid var(--line);font-size:15px}.vs .rw>div:first-child{font-weight:700}
.vs .rw .no{color:var(--muted)}.vs .rw .no::before{content:"✕  ";color:var(--bad);font-weight:800}
.vs .rw .yes::before{content:"✓  ";color:var(--ok);font-weight:800}
.vs .rw .yes{background:linear-gradient(90deg,rgba(124,58,237,.07),transparent)}

/* ---- the apps */
.apps{position:relative;overflow:hidden;border-radius:36px;padding:clamp(34px,5vw,64px) clamp(18px,3vw,44px);background:radial-gradient(120% 120% at 0% 0%,#ece4ff 0%,transparent 55%),radial-gradient(110% 120% at 100% 100%,#d9ecff 0%,transparent 55%),#fff;border:1px solid #e3dcfb;box-shadow:var(--glow)}
.apps::before{content:"";position:absolute;inset:0;background-image:linear-gradient(rgba(76,45,170,.06) 1px,transparent 1px),linear-gradient(90deg,rgba(76,45,170,.06) 1px,transparent 1px);background-size:48px 48px;-webkit-mask-image:radial-gradient(ellipse 70% 70% at 50% 40%,#000,transparent 80%);mask-image:radial-gradient(ellipse 70% 70% at 50% 40%,#000,transparent 80%);pointer-events:none}
.apps>*{position:relative}
.app-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px;margin-top:34px}
.get{position:relative;display:flex;flex-direction:column;align-items:center;gap:6px;text-align:center;padding:30px 18px 22px;border-radius:26px;background:var(--surface-a);-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);border:1px solid rgba(255,255,255,.9);box-shadow:var(--card);transition:transform .35s cubic-bezier(.2,.7,.2,1),box-shadow .3s}
.get:hover{transform:translateY(-8px) rotate(-.6deg);box-shadow:var(--glow)}
.get .logo2{display:grid;place-items:center;width:84px;height:84px;border-radius:26px;margin-bottom:10px;background:linear-gradient(160deg,#fff,#f1eefb);box-shadow:inset 0 -6px 12px rgba(76,45,170,.08),0 18px 34px -16px rgba(54,38,122,.5);color:var(--ink);transition:transform .4s cubic-bezier(.2,.7,.2,1)}
.get:hover .logo2{transform:scale(1.08) rotate(-4deg)}
.get .logo2 svg{width:44px;height:44px}
.get .logo2.win{color:#0a84ff}.get .logo2.droid{color:#2fbf6f}.get .logo2.as{background:linear-gradient(160deg,#35c0ff,#1572ff);color:#fff}
.get h3{font-size:19px;letter-spacing:-.03em}.get .gs{color:var(--muted);font-size:13.5px;min-height:20px}
.get .btn{margin-top:14px;width:100%}
.get .alt{margin-top:8px;font-size:12.5px;color:var(--muted)}.get .alt a{font-weight:650}
.get .rec{display:none;position:absolute;top:12px;right:12px;padding:2px 10px;border-radius:99px;background:var(--brand);color:#fff;font-weight:700;font-size:11px}
.get.mine{border-color:#cdbcff;box-shadow:var(--glow)}.get.mine .rec{display:inline-block}

/* ---- plans */
.plans{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;align-items:stretch}
.plan{position:relative;display:flex;flex-direction:column;background:var(--surface);border:1px solid var(--line);border-radius:26px;padding:26px;box-shadow:0 10px 30px -22px rgba(54,38,122,.4);transition:transform .35s cubic-bezier(.2,.7,.2,1),box-shadow .3s}
.plan:hover{transform:translateY(-6px);box-shadow:var(--glow)}
.plan.hot{border:1px solid transparent;background:linear-gradient(#fff,#fff) padding-box,linear-gradient(135deg,#7c3aed,#3b82f6,#22d3ee) border-box;box-shadow:var(--glow)}
.plan .badge{position:absolute;top:-12px;left:22px;background:linear-gradient(135deg,#7c3aed,#6366f1);color:#fff;font-size:12px;font-weight:800;padding:3px 13px;border-radius:99px}
.plan h3{font-size:20px}.plan .blurb{color:var(--muted);font-size:14.5px;margin:4px 0 14px;min-height:44px}
.price{font:800 40px/1.1 var(--disp);letter-spacing:-.05em;min-height:74px;color:var(--ink)}.price small{display:block;margin-top:2px;font:600 14px/1.3 Inter,sans-serif;color:var(--muted);letter-spacing:0}
.plan ul{list-style:none;padding:0;margin:18px 0 24px;display:grid;gap:10px;flex:1}.plan li{display:flex;gap:9px;font-size:14.5px}.plan li svg{flex:none;color:var(--ok);margin-top:3px}
.note2{color:var(--muted);font-size:14px;margin-top:24px}
.price .was{font-size:20px;font-weight:600;color:var(--muted);letter-spacing:0;margin-right:8px;text-decoration:line-through}
.ptotal{margin:2px 0 0;font-size:13.5px;color:var(--muted);min-height:20px}.ptotal b{color:var(--text)}
.calc{max-width:1100px;margin:0 auto 30px;padding:18px 22px;border:1px solid var(--line);border-radius:24px;background:var(--surface);box-shadow:var(--card);display:grid;gap:14px}
.calc-row{display:flex;align-items:center;gap:16px;flex-wrap:wrap}.calc-l{width:64px;font-size:12px;letter-spacing:1.4px;text-transform:uppercase;font-weight:800;color:var(--muted)}
.seg2{display:inline-flex;padding:4px;border-radius:99px;background:var(--surface-2);border:1px solid var(--line)}
.seg2 button{border:0;background:transparent;color:var(--muted);font:inherit;font-weight:700;font-size:14px;padding:8px 18px;border-radius:99px;cursor:pointer;transition:background .2s,color .2s,box-shadow .2s}
.seg2 button.on{background:#fff;color:var(--ink);box-shadow:0 6px 18px -6px rgba(54,38,122,.35)}
.seg2 em{font-style:normal;margin-left:6px;padding:2px 8px;border-radius:99px;background:rgba(16,185,129,.16);color:var(--ok);font-size:12px;font-weight:800}
.calc input[type=range]{flex:1;min-width:180px;accent-color:#7c3aed;height:6px}
.calc output{min-width:44px;text-align:right;font:800 20px var(--disp);letter-spacing:-.04em}
.calc-note{margin:0;color:var(--muted);font-size:14px}
.offer-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
.offer{padding:26px;border:1px solid var(--line);border-radius:26px;background:var(--surface);transition:transform .35s,box-shadow .3s}
.offer:hover{transform:translateY(-4px);box-shadow:var(--glow)}
.offer.hot{border-color:transparent;background:linear-gradient(#fff,#fff) padding-box,linear-gradient(135deg,#7c3aed,#3b82f6,#22d3ee) border-box}
.offer-big{display:block;font:800 30px var(--disp);letter-spacing:-.05em;background:linear-gradient(135deg,#7c3aed,#3b82f6);-webkit-background-clip:text;background-clip:text;color:transparent}
.offer h3{margin:6px 0 8px;font-size:18px}.offer p{margin:0;color:var(--muted);font-size:15px}
.credit-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;max-width:1240px;margin:0 auto}
.cr2,.cr{display:grid;gap:4px;padding:20px 22px;border:1px solid var(--line);border-radius:20px;background:var(--surface)}
.cr b{font:800 24px var(--disp);letter-spacing:-.04em}.cr span{font-weight:800;color:var(--brand);font-size:13px;letter-spacing:1.2px;text-transform:uppercase}.cr em{font-style:normal;color:var(--muted);font-size:14.5px}
.matrix{border:1px solid var(--line);border-radius:26px;overflow:auto;background:var(--surface);margin-top:44px;box-shadow:var(--card)}
.matrix table{width:100%;border-collapse:collapse;min-width:720px;font-size:14.5px}
.matrix th,.matrix td{padding:13px 18px;text-align:center;border-top:1px solid var(--line)}
.matrix th:first-child,.matrix td:first-child{text-align:left}
.matrix thead th{position:sticky;top:0;background:var(--surface-2);font-size:14px;border-top:0}
.matrix thead th.hotc{background:linear-gradient(135deg,#7c3aed,#6366f1);color:#fff}
.matrix tr.grp td{background:var(--surface-2);font-weight:800;font-size:12.5px;letter-spacing:.8px;text-transform:uppercase;color:var(--brand);text-align:left}
.matrix td.yes{color:var(--ok);font-weight:800}.matrix td.no{color:var(--muted)}
.matrix td:nth-child(3){background:rgba(124,58,237,.05)}
.faq{max-width:1100px;margin:0 auto;display:grid;gap:12px}
.faq details{background:var(--surface);border:1px solid var(--line);border-radius:20px;padding:0 24px;transition:border-color .2s,box-shadow .2s}
.faq details[open]{border-color:#cdbcff;box-shadow:var(--glow)}
.faq summary{cursor:pointer;list-style:none;padding:20px 0;font-weight:700;font-size:16.5px;display:flex;justify-content:space-between;gap:16px;align-items:center}
.faq summary::-webkit-details-marker{display:none}
.faq summary::after{content:"+";flex:none;width:30px;height:30px;border-radius:50%;background:var(--brand-soft);color:var(--brand);display:grid;place-items:center;font-size:19px;transition:transform .3s}
.faq details[open] summary::after{transform:rotate(45deg)}
.faq p{padding:0 0 20px;color:var(--muted);font-size:15.5px}

/* ---- the closing call, dark for contrast */
.band{position:relative;isolation:isolate;overflow:hidden;margin:20px 0 90px;border-radius:40px;padding:clamp(48px,7vw,96px) 28px;text-align:center;color:#fff;background:var(--ink-bg)}
.band .aurora i:nth-child(1){background:radial-gradient(circle,#7c3aed,transparent 66%);opacity:.7}.band .aurora i:nth-child(2){background:radial-gradient(circle,#d946ef,transparent 66%);opacity:.45}
.band .aurora i:nth-child(3){background:radial-gradient(circle,#22d3ee,transparent 66%);opacity:.4}.band .aurora i:nth-child(4){background:radial-gradient(circle,#3b82f6,transparent 66%);opacity:.4}
.band .gridbg{background-image:linear-gradient(rgba(255,255,255,.07) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.07) 1px,transparent 1px)}
.band h2{color:#fff}.band p{color:var(--on-ink-2);margin:0 auto 28px;max-width:34em;font-size:18px}
.band .btn-primary{background:#fff;color:var(--ink);box-shadow:0 14px 34px -10px rgba(255,255,255,.35)}.band .btn-primary:hover{background:#f4f0ff}

/* ---- inner pages */
.page-head{padding:0 0 70px;margin-top:-70px}
.page-head .wrap{padding-top:150px;text-align:center}
.page-head .eyebrow{display:inline-block;padding:6px 16px;border-radius:99px;background:var(--surface-a);border:1px solid rgba(255,255,255,.8);box-shadow:var(--card);color:var(--brand)}
.page-head h1{margin:6px auto 0;max-width:15em;font:800 clamp(34px,5.4vw,70px)/1.04 var(--disp);letter-spacing:-.045em;animation:pt-up .8s both}
.page-head .lead{animation:pt-up .8s .1s both;margin-top:22px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:26px;padding:26px;position:relative;overflow:hidden;box-shadow:0 10px 30px -22px rgba(54,38,122,.4);transition:transform .35s cubic-bezier(.2,.7,.2,1),border-color .3s,box-shadow .3s}
.card::before{content:"";position:absolute;inset:0;background:radial-gradient(420px circle at var(--mx,50%) var(--my,0%),rgba(124,58,237,.11),transparent 60%);opacity:0;transition:opacity .3s;pointer-events:none}
.card:hover{transform:translateY(-5px);border-color:#cdbcff;box-shadow:var(--glow)}.card:hover::before{opacity:1}
.card .ic{width:48px;height:48px;border-radius:15px;display:grid;place-items:center;background:linear-gradient(135deg,#7c3aed,#6366f1 55%,#22d3ee);color:#fff;margin-bottom:14px;box-shadow:0 12px 24px -8px rgba(99,70,241,.6)}
.card h3{font-size:18px;letter-spacing:-.03em;margin-bottom:6px}.card p{color:var(--muted);font-size:15px}
.card ul{list-style:none;padding:0;margin-top:12px;display:grid;gap:9px}.card li{display:flex;gap:9px;color:var(--muted);font-size:15px}.card li svg{flex:none;color:var(--ok);margin-top:3px}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:18px}.two{grid-template-columns:repeat(2,1fr)}
.report{display:flex;gap:24px;align-items:center;justify-content:space-between;flex-wrap:wrap;background:var(--surface);border:1px solid var(--line);border-radius:26px;padding:28px;margin-top:20px;box-shadow:var(--card)}
.report h2{font-size:26px;margin:0 0 6px;letter-spacing:-.04em}.report p{color:var(--muted);max-width:44em}

/* ---- footer */
footer{position:relative;overflow:hidden;background:#fff;border-top:1px solid var(--line);color:var(--muted);padding:60px 0 40px;font-size:14.5px}
footer::after{content:"Project Tracker";position:absolute;left:50%;bottom:-.28em;transform:translateX(-50%);font:800 clamp(44px,10.6vw,170px)/1 var(--disp);letter-spacing:-.06em;white-space:nowrap;background:linear-gradient(180deg,#efeafc,#fff 85%);-webkit-background-clip:text;background-clip:text;color:transparent;pointer-events:none}
footer .wrap{position:relative;z-index:1}
footer .cols{display:grid;grid-template-columns:1.4fr repeat(3,1fr);gap:30px}footer h4{margin:0 0 12px;color:var(--ink);font-size:14px}
footer ul{list-style:none;margin:0;padding:0;display:grid;gap:9px}footer a{color:var(--muted)}footer a:hover{color:var(--brand)}
footer .legal{margin-top:34px;padding-top:20px;border-top:1px solid var(--line);display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;padding-bottom:clamp(40px,8vw,120px)}
footer .brand{color:var(--ink)}

/* ---- sign in the way you unlock your phone */
.sg{display:grid;grid-template-columns:1fr 1.05fr;gap:48px;align-items:center;padding:clamp(24px,3.4vw,48px);border-radius:36px;background:var(--surface);border:1px solid var(--line);box-shadow:var(--card)}
.sg h2{font-size:clamp(26px,3.4vw,40px);letter-spacing:-.04em;margin-bottom:10px}
.sg-points{list-style:none;display:grid;gap:12px;margin:0 0 26px;padding:0}.sg-points li{display:flex;gap:10px;align-items:flex-start;color:var(--muted);font-size:15.5px}.sg-points b{color:var(--text)}
.sg-points svg{flex:none;margin-top:4px;color:var(--brand)}
.sg-stage{position:relative;min-height:360px;display:grid;place-items:center;border-radius:28px;background:radial-gradient(120% 90% at 20% 0%,rgba(167,139,250,.3),transparent 60%),radial-gradient(100% 90% at 100% 100%,rgba(125,211,252,.35),transparent 60%),var(--surface-2);overflow:hidden}
.sg-pc{width:min(64%,340px);border-radius:16px;background:#fff;color:#1b1630;box-shadow:0 24px 60px rgba(76,29,149,.22);overflow:hidden;margin-right:30%}
.sg-bar{display:flex;gap:6px;padding:10px 12px;background:#f3effd}.sg-bar i{width:9px;height:9px;border-radius:50%;background:#d6cdee}
.sg-body{display:grid;justify-items:center;gap:10px;padding:18px 18px 22px}.sg-body small{font-weight:700;font-size:13px;color:#5d5878}
.sg-ring{position:relative;width:112px;height:112px;display:grid;place-items:center}
.sg-ring svg{position:absolute;inset:0;transform:rotate(-90deg)}.sg-ring circle{fill:none;stroke:#efe9ff;stroke-width:6}
.sg-ring .go{stroke:#7c3aed;stroke-linecap:round;stroke-dasharray:327;stroke-dashoffset:0;animation:pt-sg-ring 9s ease-in-out infinite}
.sg-ring b{font:800 42px var(--disp);letter-spacing:-.06em;background:linear-gradient(135deg,#7c3aed,#ec4899);-webkit-background-clip:text;background-clip:text;color:transparent}
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
.fp{position:relative;width:64px;height:64px;display:grid;place-items:center;border-radius:22px;background:var(--brand-soft);color:var(--brand)}
.fp i{position:absolute;inset:0;border-radius:22px;border:1.5px solid var(--brand);opacity:0;animation:pt-sg-pulse 2.6s ease-out infinite}.fp i:nth-child(2){animation-delay:.85s}.fp i:nth-child(3){animation-delay:1.7s}
.pills .pro{background:var(--brand-soft);border-color:transparent;color:var(--brand)}
.rq{display:grid;gap:8px;font-size:12.5px}.rq .l{display:flex;justify-content:space-between;gap:10px;align-items:center;padding:8px 11px;border-radius:12px;background:var(--surface-2);border:1px solid var(--line)}
.rq code{font-weight:700;font-size:12px}.rq span{color:var(--ok);font-weight:650;text-align:right}
.rq .a{animation:pt-sg-line 7s ease-in-out infinite}.rq .b{animation:pt-sg-line 7s ease-in-out infinite;animation-delay:.9s}

/* ---- download page */
.dl-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}
.dl{position:relative;display:flex;flex-direction:column;gap:6px;background:var(--surface);border:1px solid var(--line);border-radius:26px;padding:26px;box-shadow:0 10px 30px -22px rgba(54,38,122,.4);transition:transform .35s cubic-bezier(.2,.7,.2,1),border-color .3s,box-shadow .3s;scroll-margin-top:100px}
.dl:hover{transform:translateY(-4px);border-color:#cdbcff;box-shadow:var(--glow)}
.dl .ic{width:60px;height:60px;border-radius:20px;display:grid;place-items:center;background:linear-gradient(160deg,#fff,#f1eefb);box-shadow:inset 0 -5px 10px rgba(76,45,170,.08),0 14px 26px -14px rgba(54,38,122,.5);color:var(--ink);margin-bottom:6px}
.dl .ic svg{width:32px;height:32px}.dl .ic.win{color:#0a84ff}.dl .ic.droid{color:#2fbf6f}.dl .ic.as{background:linear-gradient(160deg,#35c0ff,#1572ff);color:#fff}
.dl h3{font-size:20px;letter-spacing:-.03em}.dl .dsub{color:var(--muted);font-size:14.5px}
.dl .rec{display:none;align-self:flex-start;padding:2px 10px;border-radius:99px;background:var(--brand);color:#fff;font-weight:700;font-size:11.5px}
.dl.mine{border-color:var(--brand);box-shadow:var(--glow)}.dl.mine .rec{display:inline-block}
.dl .dact{display:grid;gap:8px;margin:12px 0 6px}.dl .dact .btn{justify-content:center;text-align:center}
.dnote{margin-top:6px;border-top:1px solid var(--line);padding-top:10px;font-size:14px}.dnote summary{cursor:pointer;font-weight:650;color:var(--text);list-style:none}
.dnote summary::-webkit-details-marker{display:none}.dnote summary::after{content:" +";color:var(--brand);font-weight:800}.dnote[open] summary::after{content:" \\2212"}
.dnote p{color:var(--muted);margin:8px 0 0;line-height:1.55}.dnote code{font-size:12.5px;background:var(--surface-2);padding:1px 6px;border-radius:6px;word-break:break-all}
.dl-facts{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;margin:30px 0 8px}
.dl-facts>div{display:grid;gap:4px;padding:18px 20px;border-radius:20px;background:var(--surface);border:1px solid var(--line)}.dl-facts b{font-size:15.5px}.dl-facts span{color:var(--muted);font-size:14px}

/* ---- responsive */
@media (max-width:1100px){.fan{height:390px}.f-left,.f-right{width:250px}}
@media (max-width:980px){
  .bento{grid-template-columns:repeat(2,1fr)}.tile,.tile.w{grid-column:span 2}.tile.h{grid-row:auto}
  .plans{grid-template-columns:repeat(2,1fr)}.grid{grid-template-columns:repeat(2,1fr)}footer .cols{grid-template-columns:repeat(2,minmax(0,1fr))}
  .offer-grid,.credit-grid{grid-template-columns:1fr}.sg{grid-template-columns:1fr;padding:28px;gap:28px}.trio{grid-template-columns:1fr}
  .dl-grid,.dl-facts{grid-template-columns:repeat(2,minmax(0,1fr))}.app-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.mess{grid-template-columns:1fr}
  .fan{height:auto;display:grid;gap:14px;max-width:560px}.fan>*{position:relative;left:auto;right:auto;top:auto;bottom:auto;width:auto;margin:0;transform:none;--r:0deg;animation:pt-up .8s both}.f-pill{display:none}.demo{width:auto;margin-left:0}
  .f-left,.f-right{width:auto}.demo{order:-1}
  .top .wrap{gap:12px}.nav a{padding:7px 12px;font-size:13.5px}
}
@media (max-width:760px){
  .top{padding:10px 0 4px}.top .wrap{grid-template-columns:1fr auto;row-gap:8px}.nav{order:3;grid-column:1/-1;overflow-x:auto;scrollbar-width:none;justify-content:flex-start}.nav::-webkit-scrollbar{display:none}
  .actions .btn-primary{display:none}.hero .wrap{padding-top:112px}
  .path{aspect-ratio:auto;display:grid;gap:30px;margin-top:10px;padding-left:34px;position:relative}.path svg,.node,.stop b.n{display:none}
  .path::before{content:"";position:absolute;left:11px;top:6px;bottom:6px;width:3px;border-radius:3px;background:linear-gradient(180deg,#7c3aed,#3b82f6,#22d3ee)}
  .stop{position:relative;left:auto!important;top:auto!important;width:auto}.stop::before{content:"";position:absolute;left:-30px;top:3px;width:17px;height:17px;border-radius:50%;background:#fff;border:4px solid var(--brand);box-shadow:0 0 0 5px rgba(124,58,237,.14)}
  .stop h3{font-size:18px}.stop p{font-size:15px}
}
@media (max-width:620px){
  .plans,.grid,.two,.dl-grid,.dl-facts{grid-template-columns:minmax(0,1fr)}.app-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.bento{grid-template-columns:1fr}
  .get{padding:20px 10px 16px}.get .logo2{width:62px;height:62px;border-radius:20px}.get .logo2 svg{width:32px;height:32px}.get h3{font-size:16px}.get .gs{font-size:12px;min-height:30px}.get .btn{padding:10px 8px;font-size:14px}.apps{padding:30px 14px}.tile,.tile.w{grid-column:auto}
  section.block{padding:64px 0}.vs .hd,.vs .rw{grid-template-columns:1fr}.vs .hd>div:nth-child(2),.vs .hd>div:nth-child(3){display:none}.vs .rw>div:first-child{padding-bottom:4px;color:var(--brand)}
  .whatif .res{margin-left:0;text-align:left}.band{padding:52px 20px;border-radius:30px}
  .sg{padding:22px 18px}.sg-stage{min-height:340px}.sg-pc{width:66%;margin-right:28%}.sg-phone{right:4%;width:36%;border-width:5px;border-radius:24px}.sg-ring{width:92px;height:92px}.sg-ring b{font-size:34px}.sg-nums span{height:30px;font-size:13px}.sg-ih small{display:none}
  .hero h1{font-size:11.4cqw}.tok-pair,.tok-sw,.tok-bar,.wires,.cur{display:none}.ln{gap:.12em}.kicker{font-size:12.5px;text-align:left}
  .orbit{aspect-ratio:1/.72}.ring .slot{display:none}.stats{gap:20px}.orbit-title{font-size:18px}
}
.sticky{display:none}
@media (max-width:620px){.sticky{display:flex;position:fixed;left:0;right:0;bottom:0;z-index:35;gap:10px;padding:10px 14px calc(10px + env(safe-area-inset-bottom,0px));background:rgba(251,250,255,.9);-webkit-backdrop-filter:blur(18px);backdrop-filter:blur(18px);border-top:1px solid var(--line);transform:translateY(110%);transition:transform .35s cubic-bezier(.2,.9,.25,1)}
  .sticky.show{transform:none}.sticky .btn{flex:1;min-height:50px}footer{padding-bottom:calc(30px + env(safe-area-inset-bottom,0px))}}
footer .cols>*{min-width:0}footer a{overflow-wrap:anywhere}
@media (max-width:480px){footer .cols{grid-template-columns:minmax(0,1fr)}.price{font-size:34px}}
@media (min-width:1600px){.wrap{max-width:1560px}.stage{max-width:1280px}}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}
  __JS__ [data-r]{opacity:1!important;transform:none!important}.msg,.note,.app,.say{opacity:1!important}__JS__ .tube.draw,__JS__ .path .curve{stroke-dashoffset:0!important}}
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

const compact = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s*\n\s*/g, '');
const built = (landing: boolean) => compact(prefix(KEYFRAMES)) + scopeRules(compact(prefix(COMPONENTS)), landing);

/** The whole style of a static page. */
export const pageCss = () => `${FONT_FACE}html{scroll-behavior:smooth}body{margin:0}${built(false)}`;
/** The landing page's style, for the <style> in index.html. */
export const landingCss = () => `${FONT_FACE}${built(true)}`;
/** Prefixes the classes of a piece of markup. */
export const scoped = (html: string) => html.replace(/class="([^"]+)"/g, (_m, c: string) => `class="${c.split(' ').map((x) => `pt-${x}`).join(' ')}"`);

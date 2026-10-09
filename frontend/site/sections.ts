/** The markup of the public pages, built from ./content.ts. Class names are written plainly; `scoped` (css.ts) adds the prefix. */
import { PATHS } from '../src/components/Icon';
import { COMPARE, DETAILS, DOWNLOAD_BASE, DOWNLOAD_FILES, FAQ, FEATURES, HOME, INTEGRATIONS, NAV, OFFERS, PAGES, PLANS, SECURITY, SITE, VERSUS, type DetailPage, type StaticPage } from './content';

export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const icon = (name: string, size = 22) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${(PATHS as Record<string, string>)[name] ?? ''}</svg>`;
const tick = icon('tick', 16);
const aurora = '<div class="aurora" aria-hidden="true"><i></i><i></i><i></i><i></i></div><div class="gridbg" aria-hidden="true"></div><div class="cross" aria-hidden="true"></div>';
const reveal = (i = 0) => `data-r style="--d:${(i * 0.07).toFixed(2)}s"`;
const arrowUp = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17L17 7M8 7h9v9"/></svg>';

const logoMark = (id: string) => `<svg class="logo" width="34" height="34" viewBox="0 0 32 32" aria-hidden="true"><defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7c3aed"/><stop offset=".55" stop-color="#6366f1"/><stop offset="1" stop-color="#3b82f6"/></linearGradient></defs><rect width="32" height="32" rx="9" fill="url(#${id})"/><path d="M7.3 16.7l5.3 5.3L18.7 13.3M18.7 13.3l4.3-4.8" stroke="#fff" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/><circle cx="24.4" cy="7.6" r="2.8" fill="#fff"/></svg>`;

export const header = (active = '') => `<div class="progress" aria-hidden="true"></div><header class="top"><div class="wrap">
<a class="brand" href="/" aria-label="${SITE.name} home">${logoMark('lg')}${SITE.name}</a>
<nav class="nav" aria-label="Main">${NAV.map((n) => `<a href="${n.href}"${n.href === active ? ' aria-current="page"' : ''}>${n.label}</a>`).join('')}</nav>
<div class="actions"><a class="btn btn-glass" href="/login">Sign in</a><a class="btn btn-primary" href="/register">Get started ${arrowUp}</a></div></div></header>`;

export const footer = () => `<footer><div class="wrap"><div class="cols">
<div><a class="brand" href="/">${logoMark('lg2')}${SITE.name}</a><p style="margin-top:14px;max-width:22em">${esc(SITE.tagline)}.</p></div>
<div><h4>Product</h4><ul>${NAV.map((n) => `<li><a href="${n.href}">${n.label}</a></li>`).join('')}${DETAILS.map((d) => `<li><a href="${d.path}">${esc(d.title.split(' | ')[0].replace(/ and /g, ' & '))}</a></li>`).join('')}</ul></div>
<div><h4>Account</h4><ul><li><a href="/login">Sign in</a></li><li><a href="/register">Create account</a></li></ul></div>
<div><h4>Legal</h4><ul><li><a href="/terms">Terms of Service</a></li><li><a href="/privacy">Privacy Policy</a></li><li><a href="/security/#report">Report a vulnerability</a></li><li><a href="mailto:${SITE.securityEmail}">${SITE.securityEmail}</a></li></ul></div>
</div><div class="legal"><span>© ${new Date().getFullYear()} ${SITE.name}</span><span>Made for teams that deliver.</span></div></div></footer>`;

const planCard = (p: (typeof PLANS)[number], i: number) => {
  const code = p.name.toUpperCase();
  return `<article class="plan${p.featured ? ' hot' : ''}" data-code="${code}"${p.unit ? ` data-unit="${p.unit}"` : ''} ${reveal(i)}>${p.featured ? '<span class="badge">Most popular</span>' : ''}
<h3>${p.name}</h3><div class="blurb">${esc(p.blurb)}</div>
<div class="price">${p.perUser ? `<s class="was" data-was="${code}" hidden></s>` : ''}<span data-price="${code}">${p.price}</span>${p.price === 'Custom' || p.price === '₹0' ? '' : ` <small data-per="${code}">${p.perUser ? '/ user / month' : '/ month'}</small>`}</div>
${p.perUser ? `<p class="ptotal" data-total="${code}">Per person, billed monthly</p>` : p.price === '₹0' ? '<p class="ptotal">Free for good</p>' : '<p class="ptotal">Priced to your contract</p>'}
<ul>${p.points.map((x) => `<li>${tick}<span>${esc(x)}</span></li>`).join('')}</ul>
<a class="btn ${p.featured ? 'btn-primary' : 'btn-ghost'}" href="${p.name === 'Enterprise' ? `mailto:${SITE.securityEmail.replace('security@', 'sales@')}?subject=Enterprise%20plan` : '/register'}">${esc(p.cta)}</a></article>`;
};
const plansNote = `<p class="note2">Pro and Business are priced per person per month, in Indian rupees, excluding GST; the price shown at checkout is the one that applies. Storage and AI credits are per person and shared by the whole team. A ${OFFERS.trialDays}-day trial of either plan needs no payment (up to ${OFFERS.trialPeople} people).</p>`;

/** Pick monthly or yearly and the number of people: every paid plan card below shows its own price for that choice. */
const calculator = () => `<div class="calc" ${reveal()}>
<div class="calc-row"><span class="calc-l">Billing</span><div class="seg2" role="group" aria-label="Billing period"><button type="button" class="on" data-period="monthly">Monthly</button><button type="button" data-period="yearly">Yearly <em>save ${OFFERS.annualPercent}%</em></button></div></div>
<div class="calc-row"><label class="calc-l" for="pt-seats">People</label><input id="pt-seats" type="range" min="1" max="200" value="5" data-seats aria-describedby="pt-calc-note"><output data-seats-out>5</output></div>
<p class="calc-note" id="pt-calc-note" data-calc-note>Slide to see what your team pays. Teams of ${OFFERS.volume[0].min}+ get a discount automatically.</p></div>`;

const offerQuote = (unit: number, seats: number, yearly: boolean) => {
  const vol = [...OFFERS.volume].reverse().find((t) => seats >= t.min)?.percent ?? 0;
  const total = Math.min(OFFERS.maxPercent, vol + (yearly ? OFFERS.annualPercent : 0));
  return { total, perSeat: Math.round(unit * (100 - total) / 100) };
};
const rupees = (n: number) => `₹${n.toLocaleString('en-IN')}`;

const offers = () => {
  const pro = PLANS.find((p) => p.name === 'Pro')!.unit!;
  const ex = offerQuote(pro, 25, true);
  return `<div class="offers"><div class="center" ${reveal()}><p class="eyebrow">Offers</p><h2>The more you commit, the less each person costs</h2></div><div style="height:26px"></div>
<div class="offer-grid">
<article class="offer" ${reveal(0)}><span class="offer-big">${OFFERS.annualPercent}% off</span><h3>Pay for a year</h3><p>Billed once a year instead of every month. Same plan, same features, about two and a half months free.</p></article>
<article class="offer" ${reveal(1)}><span class="offer-big">Up to ${OFFERS.volume[OFFERS.volume.length - 1].percent}% off</span><h3>Bigger teams</h3><p>${OFFERS.volume.map((t) => `${t.min}+ people: ${t.percent}%`).join(' · ')}. Applied automatically as your team grows.</p></article>
<article class="offer hot" ${reveal(2)}><span class="offer-big">Up to ${OFFERS.maxPercent}% off</span><h3>Both together</h3><p>For example 25 people on Pro, billed yearly: ${rupees(ex.perSeat)} per person a month instead of ${rupees(pro)}.</p></article>
</div></div>`;
};

/** What an AI credit buys, and what each plan brings per person. */
const credits = () => {
  const c = OFFERS.credits;
  return `<div class="credits" ${reveal()}><div class="center"><p class="eyebrow">AI credits</p><h2>Pay for the thinking you use</h2>
<p class="sub">Every answer costs credits by how much thinking it needs. Credits are per person, shared across the team and renewed on the 1st.</p></div><div style="height:26px"></div>
<div class="credit-grid">
<div class="cr"><b>${c.quick} credit</b><span>Quick</span><em>Look-ups and short answers: what is due, who owns it.</em></div>
<div class="cr"><b>${c.standard} credits</b><span>Standard</span><em>Summaries, reading a file, a plan for the week.</em></div>
<div class="cr"><b>${c.deep} credits</b><span>Deep</span><em>Root causes, forecasts and an executive brief. Business and above.</em></div>
</div>
<p class="note2 center">Pro brings 60 credits per person every month, about 15 standard answers. Business brings 200, about 50 standard answers or 10 deep analyses. When the pool is used up the assistant waits for the 1st; nothing else changes.</p></div>`;
};

const matrix = () => `<div class="matrix" ${reveal()}><table><thead><tr><th scope="col">Compare plans</th>${PLANS.map((p) => `<th scope="col"${p.featured ? ' class="hotc"' : ''}>${p.name}</th>`).join('')}</tr></thead><tbody>${COMPARE.map((g) =>
  `<tr class="grp"><td colspan="5">${esc(g.group)}</td></tr>${g.rows.map((r) => `<tr><td>${esc(r.label)}</td>${r.v.map((c) => `<td class="${c === '✓' ? 'yes' : c === '–' ? 'no' : ''}">${c === '–' ? '<span aria-label="Not included">–</span>' : esc(c)}</td>`).join('')}</tr>`).join('')}`).join('')}</tbody></table></div>`;

const faq = () => `<div class="faq">${FAQ.map((f, i) => `<details ${reveal(i)}><summary>${esc(f.q)}</summary><p>${esc(f.a)}</p></details>`).join('')}</div>`;

const featureCard = (f: { icon: string; title: string; text: string }, i: number) => `<article class="card" ${reveal(i % 3)}><div class="ic">${icon(f.icon)}</div><h3>${esc(f.title)}</h3><p>${esc(f.text)}</p></article>`;

const band = (title: string, text: string) => `<div class="wrap"><div class="band" ${reveal()}>${aurora}<h2>${esc(title)}</h2><p>${esc(text)}</p><a class="btn btn-primary btn-lg" href="/register">Create your free account</a></div></div>`;

// ---- the landing page

const demo = `<div class="demo glass" role="group" aria-label="Example portfolio" style="--dx:-10px;--dy:-6px">
<div class="demo-head"><b>Portfolio today</b><span class="live"><i></i>Live example</span></div>
<div class="proj"><b>Customer portal relaunch</b><span class="chip bad" data-chip>At risk</span><span class="meta" data-meta>Forecast 16 days late</span><div class="bar"><i style="--w:58%"></i></div></div>
<div class="proj"><b>Mobile app v2</b><span class="chip warn">Watch</span><span class="meta">Forecast 2 days late · 1 overdue task</span><div class="bar"><i style="--w:74%"></i></div></div>
<div class="proj"><b>Data migration</b><span class="chip ok">On track</span><span class="meta">Forecast on the planned date</span><div class="bar"><i style="--w:91%"></i></div></div>
<div class="whatif"><div class="q">What if we add people to <b>Customer portal relaunch</b>?</div>
<div class="row"><button type="button" class="step" data-step="-1" aria-label="Remove a person">−</button><output aria-live="polite">0 people</output><button type="button" class="step" data-step="1" aria-label="Add a person">+</button>
<div class="res"><b class="bad" data-res>Finishes in 56 days</b><span data-sub>16 days after the due date</span></div></div>
<div class="small">An example worked out the way the product does it: the pace of the last four weeks, with new people counted at 70%.</div></div></div>`;

const star = (cls: string, color: string, style: string) => `<svg class="spark ${cls}" style="${style}" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 0c.9 7.2 4.8 11.1 12 12-7.2.9-11.1 4.8-12 12-.9-7.2-4.8-11.1-12-12 7.2-.9 11.1-4.8 12-12z" fill="${color}"/></svg>`;
const sr = (t: string) => `<span class="sr">${t}</span>`;

/** The headline with small live controls inside it: every size is in em, so they grow and shrink with the words. */
const headline = `<div class="stage">
${star('', '#2fbf68', 'left:2%;top:-14%;animation-delay:.2s')}${star('', '#ffc23d', 'right:2%;top:-8%;animation-delay:1.2s')}${star('', '#3b82f6', 'left:10%;bottom:-24%;animation-delay:.7s')}${star('', '#8ec5ff', 'right:12%;bottom:-20%;animation-delay:1.8s')}
<h1><span class="ln">Plan the work${sr(',')}
<span class="tok tok-go" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="#12102a" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12h16M14 6l6 6-6 6"/></svg></span>
<span class="tok tok-bar" aria-hidden="true"><span class="knob"><svg viewBox="0 0 36 36"><circle class="bg" cx="18" cy="18" r="15.5" pathLength="100"/><circle class="fg" cx="18" cy="18" r="15.5" pathLength="100"/></svg><b>68%</b></span></span></span>
<span class="ln"><span class="tok tok-step" aria-hidden="true"><span class="dot"></span><span class="cap"><i></i></span></span>see risk early${sr(',')}
<span class="tok tok-sw" aria-hidden="true"><i></i></span></span>
<span class="ln"><span class="tok tok-pair" aria-hidden="true"><span class="a"></span><span class="b"></span><span class="k"><b>⌘K</b></span></span>ship <span class="grad">on time</span>${sr('.')}</span></h1>
<svg class="wires" viewBox="0 0 1180 300" preserveAspectRatio="none" aria-hidden="true">
<path d="M112 206 C112 262 122 268 176 268"/><path d="M1034 150 H1080 C1128 150 1122 86 1150 72"/>
<circle class="end" cx="112" cy="206" r="9"/><circle class="end2" cx="1030" cy="150" r="9"/></svg>
<span class="cur g" style="left:15.6%;top:84%" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M3 2l17 8-7.2 2.2L9.6 19z" fill="#22b56b" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg><span>Arun</span></span>
<span class="cur" style="left:96%;top:14%;animation-delay:.8s" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M3 2l17 8-7.2 2.2L9.6 19z" fill="#3b82f6" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg><span>Priya</span></span>
</div>`;

const fan = `<div class="fan" aria-hidden="false">
<aside class="f-left glass" aria-label="Reminders"><h4><i>${icon('bell', 14)}</i>Reminders</h4><div class="rem">
<div class="a"><i>!</i><span>Review the design<small>Due today · Priya M</small></span></div>
<div class="b"><i>✓</i><span>Daily briefing<small>9:00, in your working hours</small></span></div>
<div class="c"><i>↗</i><span>Release notes approved<small>Ready to publish</small></span></div></div></aside>
<aside class="f-right glass" aria-label="Assistant"><h4><i>${icon('sparkle', 14)}</i>Assistant</h4><div class="bub">
<p class="u">Which projects will miss their dates?</p>
<p class="a">Two are at risk. Customer portal relaunch is likely 16 days late.<br /><em>Review and confirm a fix</em></p></div></aside>
${demo}
<div class="f-pill dk glass"><span class="av">PM</span><span>Priya M<small>Owner · 6 tasks open</small></span></div>
<div class="f-pill pu"><span class="av b">${icon('calendar', 15)}</span><span>Sprint review<small>Today, 12:00</small></span></div>
</div>`;

const bento = `<div class="bento">
<article class="tile w" ${reveal(0)}><span class="tag">Portfolio</span><h3>See which projects will miss their dates, and why</h3><p>Every project ranked by risk with the reasons, and a forecast from the pace the team really works at.</p>
<div class="vis rows"><div class="r"><b>Customer portal relaunch</b><span class="chip bad">At risk</span><span>2 blocked tasks · date moved twice</span><div class="bar"><i style="--w:58%"></i></div></div>
<div class="r"><b>Mobile app v2</b><span class="chip warn">Watch</span><span>1 overdue task</span><div class="bar"><i style="--w:74%"></i></div></div></div></article>
<article class="tile h" ${reveal(1)}><span class="tag">Assistant</span><h3>Ask in plain words</h3><p>It answers from your own projects, and proposes changes you confirm.</p>
<div class="vis chat"><div class="msg u" style="--md:.2s">Which projects will miss their dates?</div>
<div class="msg a" style="--md:.9s">Two are at risk. Customer portal relaunch is likely 16 days late, with 2 blocked tasks.</div>
<div class="msg u" style="--md:1.7s">Get it back on track.</div>
<div class="msg a" style="--md:2.4s">I can move 3 tasks to people with room.<br /><span class="act">Review and confirm</span></div></div></article>
<article class="tile" ${reveal(2)}><span class="tag">Teams</span><h3>Teams that stay separate</h3><p>Open to everyone, or each team sees only its own work.</p>
<div class="vis"><div class="seg"><span>Everyone</span><span>Own teams</span></div><div class="chips"><span>Platform</span><span>Growth</span><span>Support</span></div></div></article>
<article class="tile" ${reveal(3)}><span class="tag">Capacity</span><h3>Share the work out</h3><p>Workload and weekly capacity per person.</p>
<div class="vis"><div class="cap" aria-hidden="true"><i style="--h:46%;--md:.1s"></i><i style="--h:72%;--md:.2s"></i><i style="--h:94%;--md:.3s" class="over"></i><i style="--h:58%;--md:.4s"></i><i style="--h:38%;--md:.5s"></i></div></div></article>
<article class="tile" ${reveal(4)}><span class="tag">Reminders</span><h3>Reminders on time</h3><p>In each person's own working hours, with Done and Snooze right there.</p>
<div class="vis notes"><div class="note" style="--md:.2s"><i>!</i>Review the design is due today</div><div class="note" style="--md:.8s"><i>✓</i>Daily briefing at 9:00</div></div></article>
<article class="tile" ${reveal(5)}><span class="tag">Security</span><h3>Built in, not bolted on</h3><p>Each organization's data is separate in the data layer itself.</p>
<div class="vis pills"><span>Passkeys</span><span>Two-step</span><span>SSO</span><span>Audit log</span></div></article>
<article class="tile" ${reveal(6)}><span class="tag">Connect</span><h3>Works with your tools</h3><p>GitHub, Azure DevOps, Slack, Teams, an API and signed webhooks.</p>
<div class="vis chain" aria-hidden="true">
<span class="chip">${icon('git', 16)}</span><i class="ln2"></i>
<span class="chip">${icon('message', 16)}</span><i class="ln2"></i>
<span class="hub">${icon('sparkle', 17)}</span><i class="ln2"></i>
<span class="chip">${icon('layers', 16)}</span><i class="ln2"></i>
<span class="chip">${icon('bolt', 16)}</span>
</div></article>
</div>`;

/** A smooth curve through the given points (Catmull-Rom turned into cubic curves). */
const smooth = (pts: [number, number][]) => {
  let d = `M${pts[0][0]} ${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] ?? p2;
    d += ` C${(p1[0] + (p2[0] - p0[0]) / 6).toFixed(1)} ${(p1[1] + (p2[1] - p0[1]) / 6).toFixed(1)} ${(p2[0] - (p3[0] - p1[0]) / 6).toFixed(1)} ${(p2[1] - (p3[1] - p1[1]) / 6).toFixed(1)} ${p2[0]} ${p2[1]}`;
  }
  return d;
};
const PATH_D = smooth([[0, 372], [157, 384], [330, 376], [504, 293], [660, 300], [818, 85], [960, 62], [1120, 70]]);
const steps = `<div class="path" data-r>
<svg viewBox="0 0 1120 533" preserveAspectRatio="none" aria-hidden="true"><defs><linearGradient id="ptp" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#22d3ee"/><stop offset=".5" stop-color="#6366f1"/><stop offset="1" stop-color="#ec4899"/></linearGradient></defs><path class="curve" pathLength="1" style="--len:1" d="${PATH_D}"/></svg>
<i class="node" style="left:14%;top:72%" aria-hidden="true"><i></i></i><i class="node" style="left:45%;top:55%" aria-hidden="true"><i></i></i><i class="node" style="left:73%;top:16%" aria-hidden="true"><i></i></i>
<div class="stop" style="left:5%;top:82%"><b class="n" aria-hidden="true">1</b><h3>Create your workspace</h3><p>Sign up free and name your organization. It takes a minute.</p></div>
<div class="stop" style="left:40%;top:66%"><b class="n" aria-hidden="true">2</b><h3>Bring in projects and people</h3><p>Add projects, invite your team and choose who sees what.</p></div>
<div class="stop" style="left:69%;top:26%"><b class="n" aria-hidden="true">3</b><h3>See risk before it costs you</h3><p>The portfolio shows what is slipping and what to do about it.</p></div></div>`;

const versus = `<div class="vs" ${reveal()}><div class="hd"><div>The same question</div><div>Spreadsheets and chat</div><div class="us">${SITE.name}</div></div>${VERSUS.map((v) =>
  `<div class="rw"><div>${esc(v.what)}</div><div class="no">${esc(v.without)}</div><div class="yes">${esc(v.with)}</div></div>`).join('')}</div>`;


// ---- sign in the way you unlock your phone: a looping scene, not a screenshot

const signin = `<div class="sg" ${reveal()}>
<div class="sg-copy"><p class="eyebrow">New</p><h2>Sign in the way you unlock your phone</h2>
<p class="sub" style="margin-bottom:22px">No password to type. Use a passkey, or approve the sign-in on the phone in your pocket.</p>
<ul class="sg-points"><li>${tick}<span><b>Passkeys</b> on every plan: fingerprint, face or screen lock, bound to this site.</span></li>
<li>${tick}<span><b>Approve on your phone</b>: pick the matching number, so an unexpected prompt is never approved by reflex.</span></li>
<li>${tick}<span><b>A real mobile app</b> from the Pro plan: install it on Android or iPhone, with alerts that reach you when it is closed.</span></li></ul>
<a class="btn btn-ghost" href="/features/mobile-and-sign-in/">How it works</a></div>
<div class="sg-stage" role="img" aria-label="A computer shows the number 47. A phone shows three numbers; tapping 47 signs the computer in.">
<div class="sg-pc"><div class="sg-bar"><i></i><i></i><i></i></div><div class="sg-body"><small>Check your phone</small>
<div class="sg-ring"><svg viewBox="0 0 120 120" aria-hidden="true"><circle cx="60" cy="60" r="52"/><circle class="go" cx="60" cy="60" r="52"/></svg><b>47</b></div>
<div class="sg-state"><span class="w">Waiting for approval…</span><span class="d">${tick} Signed in</span></div></div></div>
<div class="sg-phone"><div class="sg-island"><div class="sg-ih"><i></i><span><b>Sign-in request</b><small>Chrome on Windows</small></span></div>
<div class="sg-nums"><span>12</span><span class="hit">47</span><span>83</span></div></div></div></div></div>`;

const trio = `<div class="trio">
<article class="tile" ${reveal(0)}><span class="tag">Passkeys</span><h3>Nothing to type, nothing to steal</h3><p>Your device holds the key. A look-alike site gets nothing.</p>
<div class="vis"><div class="fp" aria-hidden="true"><i></i><i></i><i></i><svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M12 11v3a5 5 0 0 1-1.2 3.2M8 12a4 4 0 1 1 8 0v1.5c0 2-.4 3.8-1.4 5.5M5 12a7 7 0 0 1 14 0v1c0 1.7-.2 3.2-.6 4.6M12 15.5c0 1.6-.3 3-.9 4.2"/></svg></div></div></article>
<article class="tile" ${reveal(1)}><span class="tag">Mobile app</span><h3>Made for one hand</h3><p>Install it from the browser. Landscape, cards and alerts included.</p>
<div class="vis pills"><span>Android</span><span>iPhone</span><span>Desktop</span><span class="pro">Pro and above</span></div></article>
<article class="tile" ${reveal(2)}><span class="tag">Reliable API</span><h3>A retry never doubles the work</h3><p>Send an idempotency key and the second try gets the first answer.</p>
<div class="vis"><div class="rq" aria-hidden="true"><div class="l a"><code>POST /projects</code><span>201 created</span></div><div class="l b"><code>retry · same key</code><span>same answer, nothing added</span></div></div></div></article>
</div>`;

// ---- tangled tools, then one clear line

const TANGLE = 'M30 276 C90 96 250 66 282 176 C314 286 150 306 192 206 C234 106 404 96 424 206 C444 316 334 336 354 256 C374 176 560 136 612 96';
const appTile = (x: number, y: number, md: number, _f: string, glyph: string) => `<g class="app" style="--md:${md}s;transform-box:fill-box;transform-origin:center"><rect x="${x}" y="${y}" width="38" height="38" rx="11" fill="#fff"/><g transform="translate(${x + 7} ${y + 7})">${glyph}</g></g>`;
const bubble = (x: number, y: number, md: number, text: string, w: number) => `<g class="say" style="--md:${md}s;transform-box:fill-box;transform-origin:left bottom"><rect x="${x}" y="${y}" width="${w}" height="26" rx="13"/><text x="${x + 12}" y="${y + 17}">${text}</text></g>`;
const tangle = `<svg class="art" viewBox="0 0 640 360" role="img" aria-label="Five tools tangled together, with people asking where the latest update is">
<path class="tube sh" d="${TANGLE}"/><path class="tube base draw" pathLength="1" style="--len:1" d="${TANGLE}"/><path class="tube hi draw" pathLength="1" style="--len:1" d="${TANGLE}"/>
${appTile(48, 232, 0.5, '', '<rect width="24" height="24" rx="5" fill="#1fa463"/><path d="M6 7h12M6 12h12M6 17h12M12 7v10" stroke="#fff" stroke-width="1.6"/>')}
${appTile(262, 118, 0.7, '', '<path d="M3 5h18v11H9l-5 4V5z" fill="#7c3aed"/><circle cx="8" cy="10.5" r="1.4" fill="#fff"/><circle cx="12" cy="10.5" r="1.4" fill="#fff"/><circle cx="16" cy="10.5" r="1.4" fill="#fff"/>')}
${appTile(172, 186, 0.9, '', '<rect x="2" y="5" width="20" height="14" rx="3" fill="#ef4444"/><path d="M3 7l9 6 9-6" stroke="#fff" stroke-width="1.8" fill="none" stroke-linecap="round"/>')}
${appTile(404, 188, 1.1, '', '<path d="M5 2h9l5 5v15H5z" fill="#3b82f6"/><path d="M9 12h7M9 16h7" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/>')}
${appTile(336, 236, 1.3, '', '<rect x="3" y="3" width="18" height="18" rx="4" fill="#f59e0b"/><path d="M8 8v8M12 8v5M16 8v10" stroke="#fff" stroke-width="2" stroke-linecap="round"/>')}
${bubble(20, 188, 1.6, 'Where is the update?', 148)}${bubble(250, 76, 1.9, 'Which file is latest?', 142)}${bubble(396, 150, 2.2, 'Who owns this?', 112)}${bubble(446, 262, 2.5, 'Still on track?', 106)}
<g class="alert app" style="--md:2.7s;transform-box:fill-box;transform-origin:center"><circle class="ring" cx="590" cy="130" r="14"/><circle class="core" cx="590" cy="130" r="12"/><path d="M590 124v7M590 135v.5" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/></g></svg>`;

const FLOW_STOPS: [string, string][] = [['target', 'Projects'], ['checks', 'Tasks'], ['note', 'Documents'], ['message', 'Chat'], ['chart', 'Reports']];
const clean = `<svg class="art" viewBox="0 30 520 200" role="img" aria-label="Projects, tasks, documents, chat and reports on one clear line">
<defs><linearGradient id="ptg" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#7c3aed"/><stop offset=".55" stop-color="#3b82f6"/><stop offset="1" stop-color="#22d3ee"/></linearGradient></defs>
<path class="flowline" d="M40 150 H480"/><path class="flowdash" d="M40 150 H480"/>
${FLOW_STOPS.map(([ic, label], i) => { const x = 40 + i * 110; return `<g class="app" style="--md:${0.3 + i * 0.25}s;transform-box:fill-box;transform-origin:center"><rect x="${x - 26}" y="124" width="52" height="52" rx="16" fill="#fff"/><g transform="translate(${x - 12} ${150 - 12})" style="color:#6d28d9">${icon(ic, 24)}</g><text x="${x}" y="204" text-anchor="middle" font-family="Inter,sans-serif" font-weight="650" font-size="12.5" fill="#35324f">${label}</text></g>`; }).join('')}
<g class="app" style="--md:1.7s;transform-box:fill-box;transform-origin:center"><circle cx="260" cy="64" r="22" fill="#22c55e"/><path d="M250 64l7 7 13-14" stroke="#fff" stroke-width="3.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></g>
<text x="260" y="108" text-anchor="middle" font-family="Inter,sans-serif" font-weight="700" font-size="13" fill="#15803d">Everyone sees the same truth</text></svg>`;

const mess = `<div class="mess">
<article class="panel" ${reveal(0)}><h3><span class="tg">Without a tracker</span></h3><p>Updates live in five places. Nobody has the whole picture, and everyone asks.</p>${tangle}</article>
<article class="panel us" ${reveal(1)}><h3><span class="tg">With ${SITE.name}</span></h3><p>Projects, tasks, documents, chat and reports share one source of truth.</p>${clean}
<div class="okrow"><span>${tick}One status</span><span>${tick}One forecast</span><span>${tick}One audit trail</span></div></article></div>`;

// ---- one workspace, in orbit

const slot = (deg: number, inner: string) => `<div class="slot" style="--a:${deg}deg"><span class="pos"><span class="spin"><span class="st">${inner}</span></span></span></div>`;
const sq = (name: string) => `<span class="oc sq">${icon(name, 22)}</span>`;
const pill = (text: string, kind = '') => `<span class="oc ${kind}">${text}</span>`;
const person = (ini: string, cls = '') => `<span class="oc round"><span class="av ${cls}">${ini}</span></span>`;
const ring = (cls: string, chips: string[], offset: number) => `<div class="ring ${cls}">${chips.map((c, i) => slot(offset + (i * 360) / chips.length, c)).join('')}</div>`;
const orbit = `<div class="orbit-wrap" ${reveal()}><div class="orbit" role="img" aria-label="Projects, tasks, people and approvals orbiting one workspace">
${ring('r1', [sq('calendar'), pill(`${tick} Release approved`, 'ok'), person('PM'), sq('message'), pill('12 tasks done'), person('AS', 'b'), sq('shield'), pill('Forecast: on time', 'pu')], -70)}
${ring('r2', [person('KR', 'c'), pill('3 new comments'), sq('chart'), pill(`${tick} Risk: low`, 'ok'), person('SN'), sq('key'), pill('Sprint review 12:00', 'pu'), sq('bolt')], -40)}
<div class="orbit-center"><div class="stats"><div><b>3</b><span>AI speeds</span></div><div><b>5</b><span>apps and devices</span></div><div><b>₹0</b><span>free for one person</span></div></div>
<p class="orbit-title">Everything your delivery team touches, in one workspace</p></div></div>
<div class="tags">${[['kanban', 'Projects'], ['checks', 'Tasks'], ['note', 'Documents'], ['timer', 'Timesheets'], ['message', 'Chat'], ['chart', 'Reports'], ['sparkle', 'Assistant']].map(([i, t]) => `<span>${icon(i, 16)}${t}</span>`).join('')}</div></div>`;

// ---- the apps: a logo and one button each

const glyph = (body: string) => `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${body}</svg>`;
const LOGO = {
  windows: glyph('<path d="M3 4.9l7.7-1.1v7.3H3zM11.7 3.6L21 2.3v8.8h-9.3zM3 12.1h7.7v7.3L3 18.3zM11.7 12.1H21v8.8l-9.3-1.3z"/>'),
  apple: glyph('<path d="M16.4 12.7c0-2.3 1.9-3.4 2-3.5-1.1-1.6-2.8-1.8-3.4-1.8-1.4-.1-2.8.9-3.5.9-.7 0-1.8-.8-3-.8-1.5 0-3 .9-3.8 2.3-1.6 2.8-.4 7 1.2 9.3.8 1.1 1.7 2.4 2.9 2.3 1.2 0 1.6-.7 3-.7s1.8.7 3 .7c1.3 0 2-1.1 2.8-2.2.9-1.3 1.2-2.5 1.3-2.6-.1 0-2.5-.9-2.5-3.9zM14.1 5.8c.6-.8 1.1-1.9.9-3-1 .1-2.1.7-2.8 1.4-.6.7-1.1 1.8-1 2.9 1.1.1 2.2-.5 2.9-1.3z"/>'),
  android: glyph('<path d="M6.2 9.3a5.8 5.8 0 0 1 11.6 0zM8.7 5.2L7.4 3M15.3 5.2L16.6 3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" fill="none"/><path d="M6.2 9.3a5.8 5.8 0 0 1 11.6 0z"/><circle cx="9.4" cy="7.4" r=".8" fill="#fff"/><circle cx="14.6" cy="7.4" r=".8" fill="#fff"/><rect x="6.2" y="10.2" width="11.6" height="7.6" rx="1.6"/><rect x="3.3" y="10.2" width="2" height="6" rx="1"/><rect x="18.7" y="10.2" width="2" height="6" rx="1"/><rect x="8.6" y="17" width="2.1" height="4" rx="1"/><rect x="13.3" y="17" width="2.1" height="4" rx="1"/>'),
  appstore: glyph('<path d="M12 4.6L6.3 17.8M12 4.6l5.7 13.2M8.1 14.2h7.8" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" fill="none"/><path d="M5.2 19.2h4M14.8 19.2h4" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" fill="none"/>'),
};
const dlArrow = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11m-5-5l5 5 5-5M5 20h14"/></svg>';
const getTile = (os: string, logo: string, cls: string, name: string, sub: string, href: string, alt: string, i: number) =>
  `<article class="get" data-os="${os}" ${reveal(i)}><span class="rec">For your device</span><div class="logo2 ${cls}">${logo}</div><h3>${name}</h3><p class="gs">${sub}</p><a class="btn btn-primary" href="${href}">Download ${dlArrow}</a>${alt ? `<p class="alt">${alt}</p>` : ''}</article>`;
const apps = () => `<div class="apps" ${reveal()}><div class="center"><p class="eyebrow">Apps</p><h2>Take it everywhere</h2><p class="sub">Windows, Mac, iPhone and Android. Same account, same work, alerts that find you.</p></div>
<div class="app-grid">
${getTile('windows', LOGO.windows, 'win', 'Windows', 'Windows 10 and 11', dlLink(DOWNLOAD_FILES.windows), '', 0)}
${getTile('mac', LOGO.apple, '', 'macOS', 'Apple silicon and Intel', dlLink(DOWNLOAD_FILES.macArm), `Intel Mac? <a href="${dlLink(DOWNLOAD_FILES.macIntel)}">Download</a>`, 1)}
${getTile('ios', LOGO.appstore, 'as', 'iPhone and iPad', 'Add to your Home Screen', '/download/#iphone', '', 2)}
${getTile('android', LOGO.android, 'droid', 'Android', process.env.SITE_ANDROID_APK === '1' ? 'Android 7 or later' : 'Install from Chrome', process.env.SITE_ANDROID_APK === '1' ? dlLink(DOWNLOAD_FILES.android) : '/download/#android', '', 3)}
</div><p class="note2 center" style="margin-top:22px">Linux and the browser app are on the <a href="/download/"><strong>download page</strong></a>.</p></div>`;

const section = (inner: string, pad = true) => `<section class="block"${pad ? '' : ' style="padding-top:0"'}><div class="wrap">${inner}</div></section>`;
const heading = (eyebrow: string, title: string, sub = '') => `<div class="center" ${reveal()}><p class="eyebrow">${eyebrow}</p><h2>${title}</h2>${sub ? `<p class="sub">${sub}</p>` : ''}</div>`;

export function landing(): string {
  return `${header()}
<main>
<section class="dark hero">${aurora}<div class="wrap">
<span class="kicker"><b>New</b> Passkeys, phone sign-in and a mobile app</span>
${headline}
<p class="lead">${esc(HOME.lead)}</p>
<div class="cta"><a class="btn btn-primary btn-lg" href="/register">Start free ${arrowUp}</a><a class="link" href="/features/">See what it does</a></div>
<p class="fine">Start on the free plan and move up when your team grows.</p>
${fan}</div></section>
<div class="marquee" aria-label="Works with"><div class="track">${[...INTEGRATIONS, ...INTEGRATIONS].map((x) => `<span>${esc(x)}</span>`).join('')}</div></div>
${section(`${heading('Why teams switch', 'Your team\'s week, untangled', 'Every disconnected tool adds friction. Put the work, the people and the truth on one clear line.')}${mess}`)}
${section(`${heading('One workspace', 'From the first task to the portfolio review')}<div style="height:10px"></div>${orbit}`, false)}
${section(`${heading('Everything in one place', 'Planning, doing and reporting', 'One workspace for the whole delivery, so leaders see the truth without chasing updates.')}${bento}<p style="margin-top:26px;text-align:center"><a href="/features/"><strong>Explore every feature →</strong></a></p>`, false)}
${section(`${signin}<div style="height:18px"></div>${trio}`, false)}
${section(`${heading('Getting started', 'Up and running in minutes')}${steps}<p class="center" style="margin-top:30px"><a class="btn btn-brand btn-lg" href="/register">Create your workspace ${arrowUp}</a></p>`, false)}
${section(`${heading('Compare', 'Stop reconstructing the truth by hand', 'What changes when projects stop living in spreadsheets and chat.')}${versus}`, false)}
${section(apps(), false)}
${section(`${heading('Plans', 'Simple plans that grow with you', 'Free for one person. Pay per person from Pro, and less the more you commit.')}${calculator()}<div class="plans">${PLANS.map(planCard).join('')}</div>${plansNote}<p style="margin-top:10px"><a href="/pricing/"><strong>Compare every plan →</strong></a></p>`, false)}
${section(`${heading('Questions', 'Answers before you ask')}<div style="height:30px"></div>${faq()}`, false)}
${band('Bring your projects into one clear view', 'Create your workspace in a minute. Invite your team when you are ready.')}
</main>${footer()}<div class="sticky" aria-hidden="true"><a class="btn btn-glass" href="/login" tabindex="-1">Sign in</a><a class="btn btn-primary" href="/register" tabindex="-1">Start free</a></div>`;
}

// ---- the static pages

const pageHead = (p: StaticPage) => `<section class="dark page-head">${aurora}<div class="wrap"><p class="eyebrow">${esc(p.title.split(' | ')[0])}</p><h1>${esc(p.h1)}</h1><p class="lead">${esc(p.lead)}</p></div></section>`;

const detailBody = (d: DetailPage) => `<div class="wrap"><div class="grid two">${d.sections.map((x, i) => `<article class="card" ${reveal(i % 2)}><h3>${esc(x.title)}</h3><p>${esc(x.text)}</p><ul>${x.points.map((t) => `<li>${tick}<span>${esc(t)}</span></li>`).join('')}</ul></article>`).join('')}</div>
<div style="height:50px"></div>${band('Try it on your own projects', 'Start on the free plan and move up when your team grows.')}
<h2 style="margin-bottom:20px">Keep reading</h2><div class="grid">${d.related.map((r, i) => { const t = [...PAGES, ...DETAILS].find((x) => x.path === r)!; return `<article class="card" ${reveal(i)}><h3><a href="${t.path}">${esc(t.h1)}</a></h3><p>${esc(t.description)}</p></article>`; }).join('')}</div></div>`;


// ---- the download page

const dlLink = (file: string) => `${DOWNLOAD_BASE}/${file}`;
const osIcon = (d: string) => `<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const OS_ICONS = {
  windows: LOGO.windows,
  mac: LOGO.apple,
  linux: osIcon('<path d="M4 17l4-10 4 6 3-4 5 8z"/>'),
  android: LOGO.android,
  ios: LOGO.appstore,
  web: osIcon('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.2 3 14.8 0 18M12 3c-3 3.2-3 14.8 0 18"/>'),
};
const OS_CLASS: Record<string, string> = { windows: 'win', android: 'droid', ios: 'as' };
const OS_ID: Record<string, string> = { ios: 'iphone', web: 'browser' };

const dlCard = (os: string, icon: string, title: string, sub: string, actions: string, notes: string, i: number) =>
  `<article class="dl" id="${OS_ID[os] ?? os}" data-os="${os}" ${reveal(i % 3)}><div class="ic ${OS_CLASS[os] ?? ''}">${icon}</div><span class="rec">Recommended for your device</span><h3>${title}</h3><p class="dsub">${sub}</p><div class="dact">${actions}</div>${notes}</article>`;

const downloadBody = () => `<div class="wrap">
<div class="dl-grid">
${dlCard('windows', OS_ICONS.windows, 'Windows', 'Windows 10 and 11, 64-bit', `<a class="btn btn-primary" href="${dlLink(DOWNLOAD_FILES.windows)}">Download for Windows</a>`,
  '<details class="dnote"><summary>First time you open it</summary><p>Windows may say “Windows protected your PC”. This happens with every app that has not paid for a publisher certificate. Choose <b>More info</b>, then <b>Run anyway</b>.</p></details>', 0)}
${dlCard('mac', OS_ICONS.mac, 'macOS', 'macOS 11 or later', `<a class="btn btn-primary" href="${dlLink(DOWNLOAD_FILES.macArm)}">Apple silicon (M1 and later)</a><a class="btn btn-ghost" href="${dlLink(DOWNLOAD_FILES.macIntel)}">Intel Macs</a>`,
  '<details class="dnote"><summary>First time you open it</summary><p>Open the downloaded file and drag Project Tracker to Applications. If macOS says the app cannot be opened, <b>right-click it, choose Open</b>, then Open again. If it says the app is damaged, run <code>xattr -cr "/Applications/Project Tracker.app"</code> in Terminal once.</p></details>', 1)}
${dlCard('linux', OS_ICONS.linux, 'Linux', 'Most 64-bit distributions', `<a class="btn btn-primary" href="${dlLink(DOWNLOAD_FILES.linuxAppImage)}">AppImage</a><a class="btn btn-ghost" href="${dlLink(DOWNLOAD_FILES.linuxDeb)}">.deb (Ubuntu, Debian)</a>`,
  '<details class="dnote"><summary>How to run it</summary><p>AppImage: make it executable (<code>chmod +x ProjectTracker.AppImage</code>) and open it. Debian and Ubuntu: <code>sudo apt install ./ProjectTracker.deb</code>.</p></details>', 2)}
${process.env.SITE_ANDROID_APK === '1'
  ? `${dlCard('android', OS_ICONS.android, 'Android', 'Android 7 or later', `<a class="btn btn-primary" href="${dlLink(DOWNLOAD_FILES.android)}">Download the app (APK)</a>`,
  '<details class="dnote"><summary>How to install it</summary><p>Open the downloaded file. Android asks once to allow installs from your browser: allow it for this install only. Then sign in and turn on alerts in <b>Account, Mobile app</b>: reminders, mentions and sign-in requests reach you even when the app is closed.</p></details>', 3)}`
  : `${dlCard('android', OS_ICONS.android, 'Android', 'Android 7 or later', '<a class="btn btn-primary" href="/login">Open in Chrome</a>',
  '<details class="dnote" open><summary>Install it from Chrome</summary><p>Open the site in Chrome, tap the <b>menu</b> (three dots), then <b>Install app</b> (or <b>Add to Home screen</b>). It opens full-screen like an app, straight at sign-in, and can send alerts once you turn them on in <b>Account, Mobile app</b>.</p></details>', 3)}`}
${dlCard('ios', OS_ICONS.ios, 'iPhone and iPad', 'iOS 16.4 or later', '<a class="btn btn-primary" href="/login">Open in Safari</a>',
  '<details class="dnote" open><summary>Add it to your Home Screen</summary><p>In Safari tap <b>Share</b>, then <b>Add to Home Screen</b>. Open it from there to get full-screen use and alerts. Apple does not allow apps to be installed from a website, so this is the way to get it on an iPhone.</p></details>', 4)}
${dlCard('web', OS_ICONS.web, 'In your browser', 'Nothing to install', '<a class="btn btn-ghost" href="/login">Sign in</a>',
  '<details class="dnote"><summary>Install from Chrome or Edge</summary><p>On a computer, Chrome and Edge show an install icon in the address bar. The result looks and works like the desktop app.</p></details>', 5)}
</div>
<div class="dl-facts" ${reveal()}>
<div><b>Same account everywhere</b><span>Sign in with your password, a passkey, or by approving on your phone.</span></div>
<div><b>Alerts that find you</b><span>An unread count on the icon, and reminders even when the window is closed.</span></div>
<div><b>Stays up to date</b><span>The app is the live product, so new features arrive without reinstalling. The desktop app tells you when a new installer is out.</span></div>
</div>
<p class="note2" ${reveal()}>Each release lists a checksum for every file: <a href="${dlLink(DOWNLOAD_FILES.checksums)}">SHA256SUMS.txt</a>. These apps are not signed with a paid publisher certificate, which is why Windows and macOS ask you to confirm the first time. Questions? <a href="mailto:${SITE.securityEmail.replace('security@', 'support@')}">${SITE.securityEmail.replace('security@', 'support@')}</a></p>
<div style="height:30px"></div>${band('Start with a free account', 'Install the app on the devices you use. Your work is waiting on all of them.')}</div>`;

const bodies: Record<string, () => string> = {
  '/download/': downloadBody,
  '/features/': () => `<div class="wrap"><div class="grid">${FEATURES.map(featureCard).join('')}</div>
<h2 style="margin:64px 0 20px">Go deeper</h2><div class="grid">${DETAILS.map((d, i) => `<article class="card" ${reveal(i % 3)}><h3><a href="${d.path}">${esc(d.h1)}</a></h3><p>${esc(d.description)}</p></article>`).join('')}</div>
<div style="height:30px"></div>${band('See it with your own projects', 'The free plan has no time limit.')}</div>`,
  '/pricing/': () => `<div class="wrap">${calculator()}<div class="plans">${PLANS.map(planCard).join('')}</div>${plansNote}${offers()}<div style="height:40px"></div>${credits()}${matrix()}
<h2 class="center" style="margin:84px 0 28px">Questions about plans</h2>${faq()}<div style="height:50px"></div>${band('Start free today', 'Move up only when your team needs more.')}</div>`,
  '/security/': () => `<div class="wrap"><div class="grid">${SECURITY.map((p, i) => `<article class="card" ${reveal(i % 3)}><div class="ic">${icon(p.icon)}</div><h3>${esc(p.title)}</h3><ul>${p.points.map((x) => `<li>${tick}<span>${esc(x)}</span></li>`).join('')}</ul></article>`).join('')}</div>
<section class="report" id="report" ${reveal()}><div><h2>Report a vulnerability</h2><p>If you believe you have found a security problem, e-mail <a href="mailto:${SITE.securityEmail}">${SITE.securityEmail}</a> with the steps to reproduce it. We reply within two working days, keep you informed while we fix it, and credit you if you wish. Please do not access other customers' data, degrade the service or run automated scans against it while investigating.</p></div>
<a class="btn btn-primary" href="mailto:${SITE.securityEmail}?subject=Security%20report">Report a problem</a></section>
<p class="note2">Machine-readable contact: <a href="/.well-known/security.txt">/.well-known/security.txt</a></p></div>`,
  ...Object.fromEntries(DETAILS.map((d) => [d.path, () => detailBody(d)])),
};

export const staticMain = (p: StaticPage) => `${header(p.path)}<main>${pageHead(p)}<section class="block" style="padding-top:56px">${bodies[p.path]()}</section></main>${footer()}`;

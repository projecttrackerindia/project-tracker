/** The markup of the public pages, built from ./content.ts. Class names are written plainly; `scoped` (css.ts) adds the prefix. */
import { PATHS } from '../src/components/Icon';
import { COMPARE, DETAILS, DOWNLOAD_BASE, DOWNLOAD_FILES, FAQ, FEATURES, HOME, INTEGRATIONS, NAV, OFFERS, PAGES, PLANS, SECURITY, SITE, VERSUS, type DetailPage, type StaticPage } from './content';

export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const icon = (name: string, size = 22) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${(PATHS as Record<string, string>)[name] ?? ''}</svg>`;
const tick = icon('tick', 16);
const aurora = '<div class="aurora" aria-hidden="true"><i></i><i></i><i></i></div><div class="gridbg" aria-hidden="true"></div>';
const reveal = (i = 0) => `data-r style="--d:${(i * 0.07).toFixed(2)}s"`;

export const header = (active = '') => `<div class="progress" aria-hidden="true"></div><header class="top"><div class="wrap">
<a class="brand" href="/" aria-label="${SITE.name} home"><img src="/favicon-48x48.png" width="32" height="32" alt="" />${SITE.name}</a>
<nav class="nav" aria-label="Main">${NAV.map((n) => `<a href="${n.href}"${n.href === active ? ' aria-current="page"' : ''}>${n.label}</a>`).join('')}</nav>
<div class="actions"><a class="btn btn-glass" href="/login">Sign in</a><a class="btn btn-primary" href="/register">Get started</a></div></div></header>`;

export const footer = () => `<footer><div class="wrap"><div class="cols">
<div><a class="brand" href="/"><img src="/favicon-48x48.png" width="32" height="32" alt="" />${SITE.name}</a><p style="margin-top:12px;max-width:22em">${esc(SITE.tagline)}.</p></div>
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

const demo = `<div class="demo" role="group" aria-label="Example portfolio">
<div class="demo-head"><b>Portfolio today</b><span class="live"><i></i>Live example</span></div>
<div class="proj"><b>Customer portal relaunch</b><span class="chip bad" data-chip>At risk</span><span class="meta" data-meta>Forecast 16 days late</span><div class="bar"><i style="--w:58%"></i></div></div>
<div class="proj"><b>Mobile app v2</b><span class="chip warn">Watch</span><span class="meta">Forecast 2 days late · 1 overdue task</span><div class="bar"><i style="--w:74%"></i></div></div>
<div class="proj"><b>Data migration</b><span class="chip ok">On track</span><span class="meta">Forecast on the planned date</span><div class="bar"><i style="--w:91%"></i></div></div>
<div class="whatif"><div class="q">What if we add people to <b>Customer portal relaunch</b>?</div>
<div class="row"><button type="button" class="step" data-step="-1" aria-label="Remove a person">−</button><output aria-live="polite">0 people</output><button type="button" class="step" data-step="1" aria-label="Add a person">+</button>
<div class="res"><b class="bad" data-res>Finishes in 56 days</b><span data-sub>16 days after the due date</span></div></div>
<div class="small">An example worked out the way the product does it: the pace of the last four weeks, with new people counted at 70%.</div></div></div>`;

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
<div class="vis pills"><span>GitHub</span><span>Slack</span><span>Teams</span><span>API</span></div></article>
</div>`;

const steps = `<div class="steps">
<div class="stp" ${reveal(0)}><h3>Create your workspace</h3><p>Sign up free and name your organization. It takes a minute.</p></div>
<div class="stp" ${reveal(1)}><h3>Bring in projects and people</h3><p>Add projects, invite your team and choose who sees what.</p></div>
<div class="stp" ${reveal(2)}><h3>See risk before it costs you</h3><p>The portfolio shows what is slipping and what to do about it.</p></div></div>`;

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

const [h1a, ...h1rest] = HOME.h1.split('. ');

export function landing(): string {
  return `${header()}
<main>
<section class="dark hero">${aurora}<div class="wrap"><div>
<span class="kicker"><b>New</b> Passkeys, phone sign-in and a mobile app</span>
<h1>${esc(h1a)}. <span class="grad">${esc(h1rest.join('. '))}</span></h1>
<p class="lead">${esc(HOME.lead)}</p>
<div class="cta"><a class="btn btn-primary btn-lg" href="/register">Start free</a><a class="btn btn-glass btn-lg" href="/features/">See what it does</a></div>
<p class="fine">Start on the free plan and move up when your team grows.</p></div>${demo}</div></section>
<div class="dark marquee" aria-label="Works with"><div class="track">${[...INTEGRATIONS, ...INTEGRATIONS].map((x) => `<span>${esc(x)}</span>`).join('')}</div></div>
<section class="block"><div class="wrap"><div class="center" ${reveal()}><p class="eyebrow">Everything in one place</p><h2>From the first task to the portfolio review</h2>
<p class="sub">One workspace for planning, doing and reporting, so leaders see the truth without chasing updates.</p></div>${bento}
<p style="margin-top:26px;text-align:center"><a href="/features/"><strong>Explore every feature →</strong></a></p></div></section>
<section class="block" style="padding-top:0"><div class="wrap">${signin}<div style="height:18px"></div>${trio}</div></section>
<section class="block" style="padding-top:0"><div class="wrap"><div class="center" ${reveal()}><p class="eyebrow">Why teams switch</p><h2>Stop reconstructing the truth by hand</h2>
<p class="sub">What changes when projects stop living in spreadsheets and chat.</p></div>${versus}</div></section>
<section class="block" style="padding-top:0"><div class="wrap"><div class="center" ${reveal()}><p class="eyebrow">Getting started</p><h2>Up and running in minutes</h2></div><div style="height:30px"></div>${steps}</div></section>
<section class="block" style="padding-top:0"><div class="wrap"><div class="center" ${reveal()}><p class="eyebrow">Plans</p><h2>Simple plans that grow with you</h2>
<p class="sub">Free for one person. Pay per person from Pro, and less the more you commit.</p></div>
${calculator()}<div class="plans">${PLANS.map(planCard).join('')}</div>${plansNote}<p style="margin-top:10px"><a href="/pricing/"><strong>Compare every plan →</strong></a></p></div></section>
<section class="block" style="padding-top:0"><div class="wrap"><div class="center" ${reveal()}><p class="eyebrow">Questions</p><h2>Answers before you ask</h2></div><div style="height:30px"></div>${faq()}</div></section>
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
  windows: osIcon('<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>'),
  mac: osIcon('<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M2 20h20"/>'),
  linux: osIcon('<path d="M4 17l4-10 4 6 3-4 5 8z"/>'),
  android: osIcon('<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/>'),
  ios: osIcon('<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M10 5h4"/>'),
  web: osIcon('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.2 3 14.8 0 18M12 3c-3 3.2-3 14.8 0 18"/>'),
};

const dlCard = (os: string, icon: string, title: string, sub: string, actions: string, notes: string, i: number) =>
  `<article class="dl" data-os="${os}" ${reveal(i % 3)}><div class="ic">${icon}</div><span class="rec">Recommended for your device</span><h3>${title}</h3><p class="dsub">${sub}</p><div class="dact">${actions}</div>${notes}</article>`;

const downloadBody = () => `<div class="wrap">
<div class="dl-grid">
${dlCard('windows', OS_ICONS.windows, 'Windows', 'Windows 10 and 11, 64-bit', `<a class="btn btn-primary" href="${dlLink(DOWNLOAD_FILES.windows)}">Download for Windows</a>`,
  '<details class="dnote"><summary>First time you open it</summary><p>Windows may say “Windows protected your PC”. This happens with every app that has not paid for a publisher certificate. Choose <b>More info</b>, then <b>Run anyway</b>.</p></details>', 0)}
${dlCard('mac', OS_ICONS.mac, 'macOS', 'macOS 11 or later', `<a class="btn btn-primary" href="${dlLink(DOWNLOAD_FILES.macArm)}">Apple silicon (M1 and later)</a><a class="btn btn-ghost" href="${dlLink(DOWNLOAD_FILES.macIntel)}">Intel Macs</a>`,
  '<details class="dnote"><summary>First time you open it</summary><p>Open the downloaded file and drag Project Tracker to Applications. If macOS says the app cannot be opened, <b>right-click it, choose Open</b>, then Open again. If it says the app is damaged, run <code>xattr -cr "/Applications/Project Tracker.app"</code> in Terminal once.</p></details>', 1)}
${dlCard('linux', OS_ICONS.linux, 'Linux', 'Most 64-bit distributions', `<a class="btn btn-primary" href="${dlLink(DOWNLOAD_FILES.linuxAppImage)}">AppImage</a><a class="btn btn-ghost" href="${dlLink(DOWNLOAD_FILES.linuxDeb)}">.deb (Ubuntu, Debian)</a>`,
  '<details class="dnote"><summary>How to run it</summary><p>AppImage: make it executable (<code>chmod +x ProjectTracker.AppImage</code>) and open it. Debian and Ubuntu: <code>sudo apt install ./ProjectTracker.deb</code>.</p></details>', 2)}
${dlCard('android', OS_ICONS.android, 'Android', 'Android 7 or later', `<a class="btn btn-primary" href="${dlLink(DOWNLOAD_FILES.android)}">Download the app (APK)</a>`,
  '<details class="dnote"><summary>How to install it</summary><p>Open the downloaded file. Android asks once to allow installs from your browser: allow it for this install only. Then sign in and turn on alerts in <b>Account, Mobile app</b>: reminders, mentions and sign-in requests reach you even when the app is closed.</p></details>', 3)}
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

/** The markup of the public pages, built from ./content.ts. Class names are written plainly; `scoped` (css.ts) adds the prefix. */
import { PATHS } from '../src/components/Icon';
import { COMPARE, DETAILS, FAQ, FEATURES, HOME, INTEGRATIONS, NAV, PAGES, PLANS, SECURITY, SITE, VERSUS, type DetailPage, type StaticPage } from './content';

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

const planCard = (p: (typeof PLANS)[number], i: number) => `<article class="plan${p.featured ? ' hot' : ''}" ${reveal(i)}>${p.featured ? '<span class="badge">Most popular</span>' : ''}
<h3>${p.name}</h3><div class="blurb">${esc(p.blurb)}</div>
<div class="price"><span data-price="${p.name.toUpperCase()}">${p.price}</span>${p.price === 'Custom' || p.price === '₹0' ? '' : ` <small data-per="${p.name.toUpperCase()}">/ month</small>`}</div>
<ul>${p.points.map((x) => `<li>${tick}<span>${esc(x)}</span></li>`).join('')}</ul>
<a class="btn ${p.featured ? 'btn-primary' : 'btn-ghost'}" href="/register">${esc(p.cta)}</a></article>`;
const plansNote = '<p class="note2">Prices are per organization per month, in Indian rupees, and the price shown at checkout is the one that applies. Every plan starts from a free account, so you can look around first.</p>';

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
<div class="vis pills"><span>Two-step</span><span>SSO</span><span>Audit log</span><span>IP allowlist</span></div></article>
<article class="tile" ${reveal(6)}><span class="tag">Connect</span><h3>Works with your tools</h3><p>GitHub, Azure DevOps, Slack, Teams, an API and signed webhooks.</p>
<div class="vis pills"><span>GitHub</span><span>Slack</span><span>Teams</span><span>API</span></div></article>
</div>`;

const steps = `<div class="steps">
<div class="stp" ${reveal(0)}><h3>Create your workspace</h3><p>Sign up free and name your organization. It takes a minute.</p></div>
<div class="stp" ${reveal(1)}><h3>Bring in projects and people</h3><p>Add projects, invite your team and choose who sees what.</p></div>
<div class="stp" ${reveal(2)}><h3>See risk before it costs you</h3><p>The portfolio shows what is slipping and what to do about it.</p></div></div>`;

const versus = `<div class="vs" ${reveal()}><div class="hd"><div>The same question</div><div>Spreadsheets and chat</div><div class="us">${SITE.name}</div></div>${VERSUS.map((v) =>
  `<div class="rw"><div>${esc(v.what)}</div><div class="no">${esc(v.without)}</div><div class="yes">${esc(v.with)}</div></div>`).join('')}</div>`;

const [h1a, ...h1rest] = HOME.h1.split('. ');

export function landing(): string {
  return `${header()}
<main>
<section class="dark hero">${aurora}<div class="wrap"><div>
<span class="kicker"><b>New</b> Portfolio forecasts and what-if scenarios</span>
<h1>${esc(h1a)}. <span class="grad">${esc(h1rest.join('. '))}</span></h1>
<p class="lead">${esc(HOME.lead)}</p>
<div class="cta"><a class="btn btn-primary btn-lg" href="/register">Start free</a><a class="btn btn-glass btn-lg" href="/features/">See what it does</a></div>
<p class="fine">Start on the free plan and move up when your team grows.</p></div>${demo}</div></section>
<div class="dark marquee" aria-label="Works with"><div class="track">${[...INTEGRATIONS, ...INTEGRATIONS].map((x) => `<span>${esc(x)}</span>`).join('')}</div></div>
<section class="block"><div class="wrap"><div class="center" ${reveal()}><p class="eyebrow">Everything in one place</p><h2>From the first task to the portfolio review</h2>
<p class="sub">One workspace for planning, doing and reporting, so leaders see the truth without chasing updates.</p></div>${bento}
<p style="margin-top:26px;text-align:center"><a href="/features/"><strong>Explore every feature →</strong></a></p></div></section>
<section class="block" style="padding-top:0"><div class="wrap"><div class="center" ${reveal()}><p class="eyebrow">Why teams switch</p><h2>Stop reconstructing the truth by hand</h2>
<p class="sub">What changes when projects stop living in spreadsheets and chat.</p></div>${versus}</div></section>
<section class="block" style="padding-top:0"><div class="wrap"><div class="center" ${reveal()}><p class="eyebrow">Getting started</p><h2>Up and running in minutes</h2></div><div style="height:30px"></div>${steps}</div></section>
<section class="block" style="padding-top:0"><div class="wrap"><div class="center" ${reveal()}><p class="eyebrow">Plans</p><h2>Simple plans that grow with you</h2>
<p class="sub">Free for one person. Pro, Business and Enterprise add people, teams, reports and governance.</p></div>
<div class="plans">${PLANS.map(planCard).join('')}</div>${plansNote}<p style="margin-top:10px"><a href="/pricing/"><strong>Compare every plan →</strong></a></p></div></section>
<section class="block" style="padding-top:0"><div class="wrap"><div class="center" ${reveal()}><p class="eyebrow">Questions</p><h2>Answers before you ask</h2></div><div style="height:30px"></div>${faq()}</div></section>
${band('Bring your projects into one clear view', 'Create your workspace in a minute. Invite your team when you are ready.')}
</main>${footer()}`;
}

// ---- the static pages

const pageHead = (p: StaticPage) => `<section class="dark page-head">${aurora}<div class="wrap"><p class="eyebrow">${esc(p.title.split(' | ')[0])}</p><h1>${esc(p.h1)}</h1><p class="lead">${esc(p.lead)}</p></div></section>`;

const detailBody = (d: DetailPage) => `<div class="wrap"><div class="grid two">${d.sections.map((x, i) => `<article class="card" ${reveal(i % 2)}><h3>${esc(x.title)}</h3><p>${esc(x.text)}</p><ul>${x.points.map((t) => `<li>${tick}<span>${esc(t)}</span></li>`).join('')}</ul></article>`).join('')}</div>
<div style="height:50px"></div>${band('Try it on your own projects', 'Start on the free plan and move up when your team grows.')}
<h2 style="margin-bottom:20px">Keep reading</h2><div class="grid">${d.related.map((r, i) => { const t = [...PAGES, ...DETAILS].find((x) => x.path === r)!; return `<article class="card" ${reveal(i)}><h3><a href="${t.path}">${esc(t.h1)}</a></h3><p>${esc(t.description)}</p></article>`; }).join('')}</div></div>`;

const bodies: Record<string, () => string> = {
  '/features/': () => `<div class="wrap"><div class="grid">${FEATURES.map(featureCard).join('')}</div>
<h2 style="margin:64px 0 20px">Go deeper</h2><div class="grid">${DETAILS.map((d, i) => `<article class="card" ${reveal(i % 3)}><h3><a href="${d.path}">${esc(d.h1)}</a></h3><p>${esc(d.description)}</p></article>`).join('')}</div>
<div style="height:30px"></div>${band('See it with your own projects', 'The free plan has no time limit.')}</div>`,
  '/pricing/': () => `<div class="wrap"><div class="plans">${PLANS.map(planCard).join('')}</div>${plansNote}${matrix()}
<h2 class="center" style="margin:84px 0 28px">Questions about plans</h2>${faq()}<div style="height:50px"></div>${band('Start free today', 'Move up only when your team needs more.')}</div>`,
  '/security/': () => `<div class="wrap"><div class="grid">${SECURITY.map((p, i) => `<article class="card" ${reveal(i % 3)}><div class="ic">${icon(p.icon)}</div><h3>${esc(p.title)}</h3><ul>${p.points.map((x) => `<li>${tick}<span>${esc(x)}</span></li>`).join('')}</ul></article>`).join('')}</div>
<section class="report" id="report" ${reveal()}><div><h2>Report a vulnerability</h2><p>If you believe you have found a security problem, e-mail <a href="mailto:${SITE.securityEmail}">${SITE.securityEmail}</a> with the steps to reproduce it. We reply within two working days, keep you informed while we fix it, and credit you if you wish. Please do not access other customers' data, degrade the service or run automated scans against it while investigating.</p></div>
<a class="btn btn-primary" href="mailto:${SITE.securityEmail}?subject=Security%20report">Report a problem</a></section>
<p class="note2">Machine-readable contact: <a href="/.well-known/security.txt">/.well-known/security.txt</a></p></div>`,
  ...Object.fromEntries(DETAILS.map((d) => [d.path, () => detailBody(d)])),
};

export const staticMain = (p: StaticPage) => `${header(p.path)}<main>${pageHead(p)}<section class="block" style="padding-top:56px">${bodies[p.path]()}</section></main>${footer()}`;

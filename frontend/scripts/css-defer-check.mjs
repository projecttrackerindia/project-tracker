// Guards the late stylesheet (src/styles/late.css, loaded after the first paint by lib/lateStyles.ts): a rule moved there now comes after
// every first-screen stylesheet, so it would start beating a first-screen rule with the same selector that used to come after it. To keep
// the check strict, a selector written in a late file may appear in a first-screen file (main.tsx's imports) only if that file came
// BEFORE it in the original order (ORDER below, main.tsx's list before the split), or the pair is in SAFE with the reason.
// Exits 1 with the clashes. Run: node scripts/css-defer-check.mjs
import fs from 'node:fs';
import path from 'node:path';
import postcss from 'postcss';
const ORDER = ['tokens', 'base', 'components', 'layout', 'account', 'enterprise', 'advanced', 'chat', 'auth', 'celebrate', 'dark', 'ai', 'theme', 'org',
  'documents', 'documents-theme', 'reminders', 'alerts', 'notification-center', 'mobile', 'phone', 'desktop', 'phone-keyboard', 'professional',
  'futuristic', 'documents-studio', 'theme-pro', 'design-system', 'ds-auth', 'brand-fonts', 'landing-auth', 'calm'].map((n) => `${n}.css`);
// .bd-grid names two different things: the burndown chart's SVG grid lines (org.css: stroke) and a form grid (phone.css: layout).
const SAFE = new Set(['org.css|phone.css|.bd-grid']);
const core = [...fs.readFileSync('src/main.tsx', 'utf8').matchAll(/import '\.\/styles\/([^']+\.css)'/g)].map((m) => m[1]);
const late = [...fs.readFileSync('src/styles/late.css', 'utf8').matchAll(/@import '\.\/([^']+\.css)'/g)].map((m) => m[1]);
const sel = (name) => {
  const out = new Set();
  postcss.parse(fs.readFileSync(path.join('src/styles', name), 'utf8')).walkRules((r) => {
    if (r.parent?.type === 'atrule' && /keyframes/.test(r.parent.name)) return;
    for (const s of r.selectors) out.add(s.replace(/\s+/g, ' ').trim());
  });
  return out;
};
const coreSel = core.map((c) => [c, sel(c)]);
let bad = 0;
for (const l of late) {
  const hits = [];
  for (const s of sel(l)) for (const [c, cs] of coreSel) if (cs.has(s) && s !== ':root' && ORDER.indexOf(c) > ORDER.indexOf(l) && !SAFE.has(`${l}|${c}|${s}`)) hits.push(`${c}: ${s}`);
  bad += hits.length;
  console.log(`${l.padEnd(26)} ${hits.length ? hits.join(' | ') : 'ok'}`);
}
process.exit(bad ? 1 : 0);

// Fails when a CSS rule pairs colours that disappear in one of the two themes:
//  - color: var(--primary-text) without a solid var(--primary...) background (white on white in the light theme)
//  - white text on background: var(--primary) (--primary is a light tint in the dark theme; use --primary-fill)
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve('src'), bad = [];
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.css') ? [path.join(d, e.name)] : []);
for (const file of walk(root)) {
  const css = fs.readFileSync(file, 'utf8');
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const body = m[2], line = css.slice(0, m.index + m[1].length).split('\n').length;
    const color = body.match(/(?<![-\w])color\s*:\s*([^;]+)/)?.[1].trim();
    const bg = body.match(/background(?:-color)?\s*:\s*([^;]+)/)?.[1].trim() ?? '';
    if (!color) continue;
    if (color.includes('var(--primary-text)') && !/var\(--primary(-hover|-fill)?\)/.test(bg)) bad.push(`${path.relative(root, file)}:${line} ${m[1].trim().slice(-50)} - use color: var(--primary) on soft or surface backgrounds`);
    if (/^(#fff|#ffffff|white)(\s*!important)?$/i.test(color) && /var\(--primary\)/.test(bg)) bad.push(`${path.relative(root, file)}:${line} ${m[1].trim().slice(-50)} - white on --primary disappears in the dark theme; use background: var(--primary-fill)`);
  }
}
if (bad.length) { console.error(`Theme colour problems:\n${bad.join('\n')}`); process.exit(1); }
console.log('Theme colours OK');

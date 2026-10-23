// Image build step: writes nginx.conf with the app's Content-Security-Policy completed by the hashes of index.html's inline scripts.
//   node scripts/csp-nginx.mjs nginx.conf dist/index.html > nginx.generated.conf
import fs from 'node:fs';
import { fillAppCsp } from './lib/csp.mjs';

const [conf, index] = process.argv.slice(2);
const text = fs.readFileSync(conf, 'utf8');
const filled = fillAppCsp(text, fs.readFileSync(index, 'utf8'));
if (!/'sha256-/.test(filled)) throw new Error('No inline script hashes found in index.html');
process.stdout.write(text.replace(/(set \$app_csp ")[^"]+(";)/, (_m, a, b) => a + filled + b));

import { spawn } from 'node:child_process';

// Runs the synthetic UI checks one after another. When one fails, its name and the end of its output are printed as a GitHub
// annotation (the CI log itself is not always readable), and the run stops with a failure.
const checks = process.argv.slice(2);
for (const file of checks) {
  const started = Date.now();
  const out = [];
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [file], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    for (const s of [child.stdout, child.stderr]) s.on('data', (d) => { process.stdout.write(d); out.push(String(d)); });
    child.on('close', resolve);
  });
  if (code !== 0) {
    const tail = out.join('').split('\n').filter((l) => l.trim() && !/^\s+at /.test(l)).slice(-12).join(' | ').replace(/[\r\n%]/g, ' ').slice(0, 1500);
    console.log(`::error title=UI check failed: ${file}::${tail}`);
    process.exit(1);
  }
  console.log(`✓ ${file} (${Math.round((Date.now() - started) / 1000)} s)`);
}

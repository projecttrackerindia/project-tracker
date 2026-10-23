/**
 * The vault's browser-side helpers. Nothing here sends anything anywhere: the generator draws from the browser's cryptographic random source,
 * the strength meter is the same rule set the server applies when a password is saved, and the CSV reader turns another password manager's
 * export into rows without the file ever leaving the page except as the import request itself.
 */

// ------------------------------------------------------------------ strength (mirrors PasswordStrength on the server)

const COMMON = new Set(['password', 'passw0rd', 'admin', 'welcome', 'qwerty', 'letmein', 'iloveyou', 'monkey', 'dragon', 'football', 'sunshine', 'princess',
  'india', 'bharat', 'test', 'guest', 'root', 'changeme', 'secret', 'login', 'master', 'hello', 'abc', 'default', 'company']);
const ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm', '1234567890', 'abcdefghijklmnopqrstuvwxyz'];
const TRAILER = /(?:19|20)\d\d$|@?\d{1,4}[!@#$]*$/;

function runs(p: string, row: string) {
  let best = 0;
  for (let i = 0; i < p.length; i++)
    for (let len = 3; i + len <= p.length; len++) {
      const piece = p.slice(i, i + len);
      if (row.includes(piece) || row.includes([...piece].reverse().join(''))) best = Math.max(best, len); else break;
    }
  return best;
}

/** 0 (guessed at once) to 4 (strong). */
export function strength(password: string): number {
  const p = password ?? '';
  if (!p) return 0;
  const lower = /[a-z]/.test(p), upper = /[A-Z]/.test(p), digit = /\d/.test(p), other = /[^A-Za-z0-9]/.test(p);
  const classes = +lower + +upper + +digit + +other;
  const pool = (lower ? 26 : 0) + (upper ? 26 : 0) + (digit ? 10 : 0) + (other ? 33 : 0);
  const unique = new Set(p).size;
  let bits = p.length * Math.log2(Math.max(pool, 2)) * Math.min(1, unique / Math.max(p.length * 0.6, 1));
  const lowered = p.toLowerCase();
  const core = lowered.replace(TRAILER, '');
  if (COMMON.has(core) || [...COMMON].some((w) => core.includes(w) && core.length <= w.length + 4)) bits = Math.min(bits, 20);
  if (core.length > 0 && core.length < p.length && /^[a-z]+$/.test(core)) bits = Math.min(bits, core.length * 2.5 + 10);
  else if (/^[A-Za-z][a-z]*$/.test(p) && p.length <= 12) bits = Math.min(bits, p.length * 2.5);
  if (ROWS.some((r) => runs(lowered, r) >= 4)) bits -= 15;
  if (/(.)\1{3,}/.test(p)) bits -= 10;
  if (classes === 1) bits -= 8;
  if ((p.match(/[ .-]/g)?.length ?? 0) >= 3 && p.length >= 20) bits = Math.max(bits, 70);
  return bits < 28 ? 0 : bits < 36 ? 1 : bits < 50 ? 2 : bits < 64 ? 3 : 4;
}
export const STRENGTH_LABEL = ['Very weak', 'Weak', 'Fair', 'Good', 'Strong'];

// ------------------------------------------------------------------ generator

/** A uniform random integer below `max`, by rejection sampling (no modulo bias). */
export function randomBelow(max: number, rand: (a: Uint32Array<ArrayBuffer>) => unknown = (a) => crypto.getRandomValues(a)): number {
  if (max <= 0 || max > 2 ** 32) throw new RangeError('max');
  const limit = Math.floor(2 ** 32 / max) * max;
  const buf = new Uint32Array(1);
  for (;;) { rand(buf); if (buf[0] < limit) return buf[0] % max; }
}

const SETS = { lower: 'abcdefghijkmnopqrstuvwxyz', upper: 'ABCDEFGHJKLMNPQRSTUVWXYZ', digits: '23456789', symbols: '!@#$%^&*-_=+?' };
const WITH_AMBIGUOUS = { lower: SETS.lower + 'l', upper: SETS.upper + 'IO', digits: SETS.digits + '01' };
export interface GenOptions { length: number; upper: boolean; digits: boolean; symbols: boolean; avoidAmbiguous: boolean }

/** A random password with at least one character of every chosen kind, shuffled (Fisher-Yates with the same random source). */
export function generatePassword(o: GenOptions, rand?: (a: Uint32Array<ArrayBuffer>) => unknown): string {
  const length = Math.min(Math.max(Math.round(o.length), 8), 128);
  const pick = (s: string) => s[randomBelow(s.length, rand)];
  const sets = [o.avoidAmbiguous ? SETS.lower : WITH_AMBIGUOUS.lower];
  if (o.upper) sets.push(o.avoidAmbiguous ? SETS.upper : WITH_AMBIGUOUS.upper);
  if (o.digits) sets.push(o.avoidAmbiguous ? SETS.digits : WITH_AMBIGUOUS.digits);
  if (o.symbols) sets.push(SETS.symbols);
  const all = sets.join('');
  const out = sets.map(pick);
  while (out.length < length) out.push(pick(all));
  for (let i = out.length - 1; i > 0; i--) { const j = randomBelow(i + 1, rand); [out[i], out[j]] = [out[j], out[i]]; }
  return out.join('');
}

// A short list of common, easy-to-type English words (the passphrase strength comes from the number of words, not from secrecy of the list).
const WORDS = ('acid acorn actor adapt agent alarm album alert alley amber angle ankle apple april apron arena armor arrow atlas attic audio autumn avoid awake ' +
  'bacon badge bagel baker banjo barge basil basin batch beach beard bench berry bison blade blank blaze bloom board bonus boost booth bound brain brave bread brick ' +
  'brief brook brush cabin cable cacao camel canal candy canoe canon cargo carol cedar chalk charm chess chief chili chord cider cinema civic claim clerk cliff clock ' +
  'cloud coach cobra cocoa comet coral couch crane crate cream crisp crown cubic curry cycle daisy dance delta denim depot diary disco dodge donor dough draft drama ' +
  'dream drift drum eagle earth easel ebony elbow elder ember enjoy entry epoch equal error essay event exact fable fairy faith fancy feast fence ferry fever fiber ' +
  'field flame flask fleet flint flock flute focus forge forum fossil frame fresh frost fruit gauge genre ghost giant ginger glass globe glove grain grape graph ' +
  'grass gravy guava guide guild habit harbor harp haven hazel heart hedge helix heron hinge honey horse hotel humor hydra igloo image index ink input ivory jacket ' +
  'jelly jewel joint judge juice jumbo kayak kebab kettle khaki kiosk kite koala label lamp lance laser latch lemon lever light lilac linen llama lobby lotus lunar ' +
  'lyric magic mango manor maple march marsh medal melon mercy metal micro mint mocha model monk motor mural music nacho navy nectar noble north novel nutmeg oasis ' +
  'ocean olive omega onion opera orbit organ otter oven oxide paddle panda panel paper parade pasta patio peach pearl pedal penny pepper piano pilot pixel pizza ' +
  'plaza plume polar pony poppy porch prism pulse quail quartz queen quest quiet quilt radar radio raven razor relay ridge rival river robin rocket rodeo rose ' +
  'royal ruby rumba sable saddle saga salad salsa satin sauce scale scarf scout shell shore siren skate slate sleet smoke snack solar sonic spark spice spoon ' +
  'squad stamp steam stone storm sugar sunny swamp syrup table talon tango tapir tempo thorn thyme tiger toast token topaz torch tower trail tulip tundra tuner ' +
  'umbra uncle unity urban usher valve vapor vault velvet venue vinyl viola vivid vocal voter wafer wagon walnut water whale wheat widget willow wizard yacht ' +
  'yeast yodel zebra zesty zinc zone').split(' ');
export const WORD_COUNT = WORDS.length;

/** Words joined by a separator, one capitalised and a digit added, so it also passes "upper case and a number" rules. */
export function generatePassphrase(words: number, separator = '-', rand?: (a: Uint32Array<ArrayBuffer>) => unknown): string {
  const n = Math.min(Math.max(Math.round(words), 3), 12);
  const out = Array.from({ length: n }, () => WORDS[randomBelow(WORDS.length, rand)]);
  const cap = randomBelow(n, rand);
  out[cap] = out[cap][0].toUpperCase() + out[cap].slice(1);
  out[randomBelow(n, rand)] += String(randomBelow(10, rand));
  return out.join(separator);
}

// ------------------------------------------------------------------ CSV import

/** RFC 4180 CSV: quoted fields with commas, quotes ("") and new lines inside. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = '', quoted = false;
  const s = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((x) => x !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((x) => x !== '')) rows.push(row);
  return rows;
}

const COLUMNS: Record<'title' | 'url' | 'username' | 'password' | 'totp' | 'notes', string[]> = {
  title: ['name', 'title', 'account', 'item name'],
  url: ['url', 'login_uri', 'website', 'web site', 'uri', 'urls'],
  username: ['username', 'login_username', 'user name', 'login', 'email', 'user'],
  password: ['password', 'login_password', 'pass'],
  totp: ['totp', 'login_totp', 'otpauth', 'one-time password', 'otp'],
  notes: ['notes', 'note', 'extra', 'comments'],
};

/** Rows from a Bitwarden, 1Password, LastPass, Chrome, Edge or Firefox export (by their column names), plus what was found. */
export function readExport(text: string): { rows: { title: string | null; url: string | null; username: string | null; password: string | null; totp: string | null; notes: string | null }[]; source: string; columns: string[] } {
  const all = parseCsv(text);
  if (all.length < 2) return { rows: [], source: 'unknown', columns: [] };
  const head = all[0].map((h) => h.trim().toLowerCase());
  const index = Object.fromEntries(Object.entries(COLUMNS).map(([k, names]) => [k, head.findIndex((h) => names.includes(h))])) as Record<keyof typeof COLUMNS, number>;
  const source = head.includes('login_uri') ? 'Bitwarden' : head.includes('extra') && head.includes('grouping') ? 'LastPass' : head.includes('httprealm') ? 'Firefox'
    : head.join(',') === 'name,url,username,password' || head.includes('note') ? 'Chrome / Edge' : head.includes('otpauth') ? '1Password' : 'CSV';
  const cell = (r: string[], k: keyof typeof COLUMNS) => { const i = index[k]; const v = i >= 0 ? (r[i] ?? '').trim() : ''; return v === '' ? null : v; };
  const rows = all.slice(1).map((r) => ({ title: cell(r, 'title'), url: cell(r, 'url'), username: cell(r, 'username'), password: index.password >= 0 ? (r[index.password] ?? '') || null : null, totp: cell(r, 'totp'), notes: cell(r, 'notes') }))
    .filter((r) => r.password || r.notes);
  return { rows, source, columns: Object.entries(index).filter(([, i]) => i >= 0).map(([k]) => k) };
}

// ------------------------------------------------------------------ clipboard

let clearTimer: number | undefined;
let pending: { value: string; until: number; seconds: number } | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());
/** What is on the clipboard from the vault right now, and until when (for the countdown on screen). Never the value itself. */
export const clipboardWatch = {
  subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; },
  get: (): { until: number; seconds: number } | null => (pending ? { until: pending.until, seconds: pending.seconds } : null),
};
let snapshot: { until: number; seconds: number } | null = null;
export const clipboardSnapshot = () => { const p = clipboardWatch.get(); if (p?.until !== snapshot?.until) snapshot = p; return snapshot; };

async function clearIfOurs(value: string) {
  try {
    const now = await navigator.clipboard.readText().catch(() => value);
    if (now === value) await navigator.clipboard.writeText('');
  } catch { /* the page lost focus: nothing more can be done from here */ }
}

/**
 * Puts a value on the clipboard and clears it again after `seconds`, if it is still what we put there (when the browser lets us read it back;
 * otherwise it is cleared anyway, which is the safer mistake).
 */
export async function copySecret(value: string, seconds: number): Promise<boolean> {
  try { await navigator.clipboard.writeText(value); } catch { return false; }
  window.clearTimeout(clearTimer);
  const wait = Math.max(5, seconds);
  pending = { value, until: Date.now() + wait * 1000, seconds: wait };
  notify();
  clearTimer = window.setTimeout(async () => { const v = pending?.value ?? value; pending = null; notify(); await clearIfOurs(v); }, wait * 1000);
  return true;
}

/** Clears the clipboard now (the person is done with the value). */
export async function clearClipboardNow() {
  window.clearTimeout(clearTimer);
  const v = pending?.value;
  pending = null; notify();
  if (v !== undefined) await clearIfOurs(v);
}

/** A base32 setup key (letters A-Z and 2-7, spaces allowed) or an otpauth://totp address with a secret. */
export const looksLikeTotp = (v: string) => {
  const t = v.trim();
  if (!t) return true;
  if (/^otpauth:\/\/totp\//i.test(t)) return /[?&]secret=[A-Za-z2-7=]{16,}/i.test(t);
  return /^[A-Za-z2-7\s=-]{16,}$/.test(t);
};

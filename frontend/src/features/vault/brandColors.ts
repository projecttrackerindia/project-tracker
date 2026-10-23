/**
 * A colour and letters for each item, from its address and name — nothing is fetched (no favicon service learns which sites a team keeps
 * passwords for). Well-known services get their own colour; everything else a steady colour from its name. Letters only: no logos.
 */
const KNOWN: [RegExp, string, string][] = [
  [/(^|\.)aws\.amazon\.com$|(^|\.)amazonaws\.com$|^aws$/, 'aws', '#e8890c'],
  [/(^|\.)google\.com$|(^|\.)gmail\.com$|^google$|^gmail$/, 'G', '#3f7ee8'],
  [/(^|\.)github\.com$|^github$/, 'GH', '#2f3640'],
  [/(^|\.)gitlab\.com$|^gitlab$/, 'GL', '#e2622b'],
  [/(^|\.)azure\.com$|(^|\.)microsoft\.com$|(^|\.)office\.com$|(^|\.)live\.com$|^azure$|^microsoft$/, 'MS', '#0f6fc6'],
  [/(^|\.)slack\.com$|^slack$/, 'S', '#5b1f5e'],
  [/(^|\.)atlassian\.(com|net)$|^jira$/, 'J', '#1d5fd1'],
  [/(^|\.)zoho\.(com|in)$|^zoho$/, 'Z', '#d6302a'],
  [/(^|\.)razorpay\.com$|^razorpay$/, 'R', '#1d3a8a'],
  [/(^|\.)digitalocean\.com$|^digitalocean$/, 'DO', '#1f74e8'],
  [/(^|\.)cloudflare\.com$|^cloudflare$/, 'CF', '#e9781b'],
  [/(^|\.)stripe\.com$|^stripe$/, 'S', '#5b52e8'],
  [/(^|\.)figma\.com$|^figma$/, 'F', '#8a4fe0'],
  [/(^|\.)notion\.(so|com)$|^notion$/, 'N', '#33302e'],
  [/(^|\.)hdfcbank\.com$|^hdfc/, 'HD', '#0d4a8c'],
  [/(^|\.)icicibank\.com$|^icici/, 'IC', '#c9611a'],
  [/(^|\.)onlinesbi\.(sbi|com)$|(^|\.)sbi\.co\.in$|^sbi$/, 'SBI', '#25418f'],
  [/(^|\.)railway\.app$|^railway$/, 'RW', '#3b3f4a'],
  [/(^|\.)vercel\.com$|^vercel$/, 'V', '#2b2b2b'],
];

export function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try { return new URL(/^[a-z]+:\/\//i.test(url) ? url : `https://${url}`).hostname.replace(/^www\./, '').toLowerCase(); } catch { return null; }
}

function hash(s: string) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

function letters(title: string, host: string | null) {
  const words = title.replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
  const first = words[0] ?? host ?? '?';
  if (/^[A-Z0-9]{2,3}$/.test(first)) return first;                 // AWS, SBI, VPN
  if (words.length > 1 && !/^\d/.test(words[1])) return (words[0][0] + words[1][0]).toUpperCase();
  return first.slice(0, 2).replace(/^./, (c) => c.toUpperCase());
}

export function brandOf(title: string, url: string | null | undefined) {
  const host = hostOf(url);
  const key = (host ?? title).toLowerCase();
  const firstWord = title.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  const known = KNOWN.find(([re]) => (host && re.test(host)) || re.test(firstWord));
  if (known) return { text: known[1], color: known[2] };
  const hue = hash(key) % 360;
  return { text: letters(title, host), color: `hsl(${hue} 52% 44%)` };
}

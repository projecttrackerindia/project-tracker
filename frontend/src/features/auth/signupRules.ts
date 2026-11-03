/**
 * The sign-up field rules, mirrored from the server (backend SignupRules in SignupGuard.cs) so the form explains a problem inline before it
 * is sent. The server stays the authority: it also checks the email's domain can receive mail and the full disposable-domain list.
 */
export const NAME_MIN = 2, NAME_MAX = 60, ORG_MIN = 2, ORG_MAX = 100;

const NAME_SHAPE = /^[\p{L}\p{M}]+(?:[ '’-][\p{L}\p{M}]+)*$/u;
const LINK = /https?:|www\.|:\/\/|\.(?:com|net|org|in|io|xyz|ru|top|info|biz|co)\b|@/i;
const REPEATS = /(.)\1{3,}/u;
const ORG_REPEATS = /(.)\1{4,}/u;
const ORG_SHAPE = /^[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N} &.,'’()/+-]*$/u;
const EMAIL_SHAPE = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+(?:[A-Za-z]{2,63}|xn--[A-Za-z0-9-]{1,59})$/;

// The best-known throw-away inbox providers; the server holds the full list.
const DISPOSABLE = new Set([
  '10minutemail.com', 'guerrillamail.com', 'guerrillamail.net', 'sharklasers.com', 'mailinator.com', 'yopmail.com', 'yopmail.fr', 'tempmail.com',
  'temp-mail.org', 'temp-mail.io', 'trashmail.com', 'throwawaymail.com', 'getnada.com', 'maildrop.cc', 'dispostable.com', 'fakeinbox.com',
  'mailnesia.com', 'mohmal.com', 'mail.tm', 'emailondeck.com', 'tempmailo.com', '1secmail.com', 'burnermail.io', 'discard.email',
]);

export const cleanText = (v: string | null | undefined) => (v ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();

export function nameProblem(raw: string | null | undefined): string | null {
  const name = cleanText(raw);
  if (!name) return 'Enter your name.';
  if (name.length < NAME_MIN || name.length > NAME_MAX) return `Enter your name (${NAME_MIN} to ${NAME_MAX} characters).`;
  if (/\p{N}/u.test(name)) return 'A name cannot contain numbers.';
  if (LINK.test(name)) return 'A name cannot contain a web or email address.';
  if (!NAME_SHAPE.test(name)) return 'Use letters, spaces, apostrophes and hyphens only.';
  if (REPEATS.test(name.toLowerCase())) return 'That does not look like a real name.';
  if ((name.match(/\p{L}/gu) ?? []).length < 2) return 'Enter your name.';
  return null;
}

export function isDisposableDomain(domain: string): boolean {
  let d = domain.trim().replace(/\.$/, '').toLowerCase();
  while (d.includes('.')) {
    if (DISPOSABLE.has(d)) return true;
    d = d.slice(d.indexOf('.') + 1);
  }
  return false;
}

export function emailProblem(raw: string | null | undefined): string | null {
  const email = (raw ?? '').trim();
  if (!email) return 'Enter your email.';
  const at = email.lastIndexOf('@');
  if (email.length > 254 || at < 1 || at > 64 || !EMAIL_SHAPE.test(email)) return 'Enter a valid email address.';
  const domain = email.slice(at + 1).toLowerCase();
  if (domain.split('.').some((l) => l.length > 63)) return 'Enter a valid email address.';
  if (isDisposableDomain(domain)) return 'Use a permanent email address: disposable inboxes are not accepted.';
  return null;
}

export function organizationProblem(raw: string | null | undefined): string | null {
  const org = cleanText(raw);
  if (org.length < ORG_MIN || org.length > ORG_MAX) return `Enter your organisation's name (${ORG_MIN} to ${ORG_MAX} characters).`;
  if (LINK.test(org)) return 'An organisation name cannot contain a web or email address.';
  if (!ORG_SHAPE.test(org)) return "Use letters, numbers, spaces and & . , ' ( ) / + - only.";
  if ((org.match(/\p{L}/gu) ?? []).length < 2) return 'An organisation name needs at least two letters.';
  if (ORG_REPEATS.test(org.toLowerCase())) return 'That does not look like a real organisation name.';
  return null;
}

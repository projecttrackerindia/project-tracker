import { useQuery } from '@tanstack/react-query';
import { authApi } from '../../api/endpoints';
import type { PasswordPolicy } from '../../api/types';
import { Icon } from '../../components/Icon';

/** The platform's password rules. Public and the same for everyone, so cached globally rather than per workspace. */
export function usePasswordPolicy(): PasswordPolicy | undefined {
  return useQuery({ queryKey: ['password-policy'], queryFn: authApi.passwordPolicy, staleTime: 5 * 60_000 }).data;
}

interface Rule { id: string; label: string; met: (password: string) => boolean }

/** The requirements that can be ticked off while typing (same tests as the server's PasswordRules). */
export function policyRules(p: PasswordPolicy): Rule[] {
  const rules: Rule[] = [{ id: 'length', label: `At least ${p.minLength} characters`, met: (pw) => pw.length >= p.minLength }];
  // An uppercase or lowercase requirement already implies a letter, so don't list it twice.
  if (p.requireLetter && !p.requireUppercase && !p.requireLowercase) rules.push({ id: 'letter', label: 'A letter', met: (pw) => /\p{L}/u.test(pw) });
  if (p.requireUppercase) rules.push({ id: 'upper', label: 'An uppercase letter', met: (pw) => /\p{Lu}/u.test(pw) });
  if (p.requireLowercase) rules.push({ id: 'lower', label: 'A lowercase letter', met: (pw) => /\p{Ll}/u.test(pw) });
  if (p.requireDigit) rules.push({ id: 'digit', label: 'A number', met: (pw) => /\p{Nd}/u.test(pw) });
  if (p.requireSymbol) rules.push({ id: 'symbol', label: 'A symbol (such as ! # or ?)', met: (pw) => /[^\p{L}\p{Nd}]/u.test(pw) });
  return rules;
}

/**
 * What the browser can check before sending: length and character kinds. Whether a password is common, contains your name, or was
 * used before is decided by the server, whose message then appears under the field.
 */
export function passwordProblem(p: PasswordPolicy | undefined, password: string): string | null {
  if (password.length > 128) return 'Use at most 128 characters.';
  if (!p) return password.length >= 8 ? null : 'Use at least 8 characters.';
  const missing = policyRules(p).filter((r) => !r.met(password)).map((r) => r.label.charAt(0).toLowerCase() + r.label.slice(1));
  if (!missing.length) return null;
  const list = missing.length === 1 ? missing[0] : `${missing.slice(0, -1).join(', ')} and ${missing[missing.length - 1]}`;
  return `Use ${list}.`;
}

/**
 * A random password that satisfies the platform rules, for an administrator to hand to someone new. Uses the browser's secure
 * random source and leaves out look-alike characters (0/O, 1/l/I) so it survives being read out or retyped.
 */
export function generatePassword(p: PasswordPolicy | undefined): string {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ', lower = 'abcdefghijkmnopqrstuvwxyz', digits = '23456789', symbols = '@#*+=_-';
  const random = (n: number) => { // rejection sampling, so every character is equally likely
    const limit = 256 - (256 % n);
    const buf = new Uint8Array(1);
    for (;;) { crypto.getRandomValues(buf); if (buf[0] < limit) return buf[0] % n; }
  };
  const pick = (set: string) => set[random(set.length)];
  const chars = [pick(upper), pick(upper), pick(lower), pick(lower), pick(digits), pick(digits), pick(symbols)];
  const all = upper + lower + digits;
  const length = Math.min(64, Math.max(16, p?.minLength ?? 8));
  while (chars.length < length) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i--) { const j = random(i + 1); [chars[i], chars[j]] = [chars[j], chars[i]]; }
  return chars.join('');
}

/** Live list of the requirements, ticked as they are met. `showHistory` for changing an existing password. */
export function PasswordChecklist({ policy, password, showHistory = false }: { policy: PasswordPolicy | undefined; password: string; showHistory?: boolean }) {
  if (!policy) return null;
  const notes: string[] = [];
  if (policy.blockCommon) notes.push('not a commonly used password');
  if (policy.blockPersonalInfo) notes.push('not your name or email');
  if (showHistory && policy.historyCount > 0) notes.push(policy.historyCount === 1 ? 'different from your current password' : `not one of your last ${policy.historyCount} passwords`);
  return (
    <ul className="pw-rules" aria-label="Password requirements">
      {policyRules(policy).map((r) => {
        const ok = r.met(password);
        return (
          <li key={r.id} className={ok ? 'ok' : ''}>
            <span className="pw-mark" aria-hidden="true">{ok && <Icon name="tick" size={11} />}</span>
            {r.label}<span className="sr-only">{ok ? ' (done)' : ' (not yet)'}</span>
          </li>
        );
      })}
      {notes.length > 0 && <li className="pw-note">Also {notes.join(', ')}.</li>}
    </ul>
  );
}

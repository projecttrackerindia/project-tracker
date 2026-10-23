import { describe, expect, it } from 'vitest';
import { SETTINGS_INDEX, searchSettings, settingHref, visibleSettings } from './settingsIndex';

const all = SETTINGS_INDEX;
const top = (q: string) => searchSettings(q, all)[0]?.id;

describe('settings search', () => {
  it('finds the switch people mean by the words they use', () => {
    expect(top('MFA')).toBe('security.requireMfa');
    expect(top('2fa')).toBe('security.requireMfa');
    expect(top('logo')).toBe('workspace.logo');
    expect(top('Slack')).toBe('integrations.slack');
    expect(top('retention')?.startsWith('data.')).toBe(true);
    expect(top('ip whitelist')).toBe('security.ipAllowlist');
    expect(top('invoice')).toBe('billing.invoices');
    expect(top('time zone')).toBe('workspace.timeZone');
    expect(top('dark mode')).toBe('account.theme');
  });

  it('needs every word to match, and two letters at least', () => {
    expect(searchSettings('m', all)).toEqual([]);
    expect(searchSettings('logo zebra', all)).toEqual([]);
    expect(searchSettings('nothing like this', all)).toEqual([]);
  });

  it('jumps to the anchor of the setting, or to its own page', () => {
    const mfa = all.find((e) => e.id === 'security.requireMfa')!;
    expect(settingHref(mfa)).toBe('/settings/security#s-security.requireMfa');
    const theme = all.find((e) => e.id === 'account.theme')!;
    expect(settingHref(theme)).toBe('/account#s-account.theme');
  });

  it('only offers what the person may open; personal settings always', () => {
    const shown = visibleSettings([{ id: 'general' }], true);
    expect(shown.some((e) => e.section === 'security')).toBe(false);
    expect(shown.some((e) => e.id === 'workspace.logo')).toBe(true);
    expect(shown.some((e) => e.id === 'account.password')).toBe(true);
    expect(visibleSettings([], false).every((e) => e.personal)).toBe(true);
  });

  it('every anchor is unique', () => {
    expect(new Set(all.map((e) => e.id)).size).toBe(all.length);
    for (const e of all) expect(e.section !== null || !!e.to).toBe(true);
  });
});

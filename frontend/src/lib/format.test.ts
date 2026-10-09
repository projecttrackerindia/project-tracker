import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  formatDate, formatDateShort, formatDateTime, daysUntil, dueLabel, timeAgo,
  initials, clamp, labelize, formatMoney, currencySymbol, limitLabel, formatBytes, toISODate, dateOffset,
} from './format';

describe('formatDate', () => {
  it('reads an ISO date without shifting it across a timezone', () => {
    expect(formatDate('2026-03-05')).toBe('05 Mar 2026');
  });
  it('returns the placeholder for a missing or empty date', () => {
    expect(formatDate(null)).toBe('—');
    expect(formatDate(undefined)).toBe('—');
    expect(formatDate('')).toBe('—');
  });
});

describe('formatDateTime', () => {
  it('formats a valid timestamp and placeholders a missing or unparseable one', () => {
    expect(formatDateTime('2026-03-05T10:30:00.000Z')).not.toBe('—');
    expect(formatDateTime(null)).toBe('—');
    expect(formatDateTime('not a date')).toBe('—');
  });
});

describe('formatDateShort', () => {
  it('omits the year', () => {
    expect(formatDateShort('2026-12-25')).toBe('25 Dec');
  });
});

describe('daysUntil', () => {
  afterEach(() => vi.useRealTimers());

  it('is 0 for today, negative for the past, positive for the future', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 2, 10, 15, 0, 0));   // 10 Mar 2026, afternoon
    expect(daysUntil('2026-03-10')).toBe(0);
    expect(daysUntil('2026-03-07')).toBe(-3);
    expect(daysUntil('2026-03-15')).toBe(5);
  });
  it('is null with no date', () => {
    expect(daysUntil(null)).toBeNull();
  });
});

describe('dueLabel', () => {
  afterEach(() => vi.useRealTimers());

  it('names today, tomorrow, yesterday and overdue specially, and falls back to a short date', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 2, 10));
    expect(dueLabel('2026-03-10')).toBe('Today');
    expect(dueLabel('2026-03-11')).toBe('Tomorrow');
    expect(dueLabel('2026-03-09')).toBe('Yesterday');
    expect(dueLabel('2026-03-05')).toBe('5d overdue');
    expect(dueLabel('2026-03-20')).toBe('20 Mar');
    expect(dueLabel(null)).toBe('No date');
  });
});

describe('timeAgo', () => {
  afterEach(() => vi.useRealTimers());

  it('steps through minutes, hours, days, then a full date', () => {
    vi.useFakeTimers();
    const now = new Date('2026-03-10T12:00:00.000Z');
    vi.setSystemTime(now);
    expect(timeAgo(new Date(now.getTime() - 30_000).toISOString())).toBe('just now');
    expect(timeAgo(new Date(now.getTime() - 5 * 60_000).toISOString())).toBe('5m ago');
    expect(timeAgo(new Date(now.getTime() - 3 * 3600_000).toISOString())).toBe('3h ago');
    expect(timeAgo(new Date(now.getTime() - 2 * 86_400_000).toISOString())).toBe('2d ago');
    expect(timeAgo(new Date(now.getTime() - 30 * 86_400_000).toISOString())).toBe(formatDate(new Date(now.getTime() - 30 * 86_400_000).toISOString()));
  });
  it('is empty with no date', () => {
    expect(timeAgo(null)).toBe('');
  });
});

describe('initials', () => {
  it('takes the first letter of up to two words, uppercased', () => {
    expect(initials('Prasanna Krishna')).toBe('PK');
    expect(initials('Cher')).toBe('C');
    expect(initials('a b c d')).toBe('AB');
  });
  it('falls back to "?" with nothing to work with', () => {
    expect(initials(null)).toBe('?');
    expect(initials('')).toBe('?');
    expect(initials('   ')).toBe('?');
  });
});

describe('clamp', () => {
  it('keeps a value inside the range, and pins it at either edge', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-5, 0, 10)).toBe(0);
    expect(clamp(50, 0, 10)).toBe(10);
  });
});

describe('labelize', () => {
  it('splits PascalCase into words', () => {
    expect(labelize('InProgress')).toBe('In Progress');
    expect(labelize('OnTrack')).toBe('On Track');
    expect(labelize('Done')).toBe('Done');
  });
});

describe('formatMoney', () => {
  it('drops decimals for whole rupee amounts and keeps them otherwise', () => {
    expect(formatMoney(999)).toBe('₹999');
    expect(formatMoney(1199.5)).toBe('₹1,199.50');
  });
  it('groups Indian-style for INR (lakh, not thousand)', () => {
    expect(formatMoney(100000)).toBe('₹1,00,000');
  });
  it('is "Custom" for a null (ask-us) price', () => {
    expect(formatMoney(null)).toBe('Custom');
  });
});

describe('currencySymbol', () => {
  it('extracts just the symbol', () => {
    expect(currencySymbol('INR')).toBe('₹');
    expect(currencySymbol('USD')).toBe('$');
  });
});

describe('limitLabel', () => {
  it('shows -1 as Unlimited and otherwise a grouped number', () => {
    expect(limitLabel(-1)).toBe('Unlimited');
    expect(limitLabel(1000)).toBe('1,000');
    expect(limitLabel(0)).toBe('0');
  });
});

describe('formatBytes', () => {
  it('picks the right unit and trims a trailing .0', () => {
    expect(formatBytes(500)).toBe('500 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5 MB');
  });
  it('is Unlimited for a negative byte count (the plan-limit sentinel)', () => {
    expect(formatBytes(-1)).toBe('Unlimited');
  });
});

describe('toISODate / dateOffset', () => {
  it('round-trips a date and offsets by whole days', () => {
    const d = new Date(2026, 1, 28);   // 28 Feb 2026 (not a leap year)
    expect(toISODate(d)).toBe('2026-02-28');
    expect(dateOffset(1, d)).toBe('2026-03-01');
    expect(dateOffset(-1, d)).toBe('2026-02-27');
  });
});

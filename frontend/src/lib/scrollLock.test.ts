import { afterEach, describe, expect, it, vi } from 'vitest';

// A stand-in document: just the two elements whose overflow the locks change.
const body = { style: { overflow: '' } }, html = { style: { overflow: '' } };
vi.stubGlobal('document', { body, documentElement: html });
const { lockScroll, scrollLocks } = await import('./scrollLock');

afterEach(() => { body.style.overflow = ''; html.style.overflow = ''; });

describe('scroll locks', () => {
  it('keeps the page still until the last holder lets go, whatever order they close in', () => {
    const sheet = lockScroll('body');
    const dialog = lockScroll('body');
    expect(body.style.overflow).toBe('hidden');
    sheet();                                   // the sheet underneath closes first
    expect(body.style.overflow).toBe('hidden');
    dialog();
    expect(body.style.overflow).toBe('');      // never left stuck on "hidden"
    expect(scrollLocks().body).toBe(0);
  });

  it('ignores a second release and keeps html and body apart', () => {
    const a = lockScroll('html'), b = lockScroll('html');
    a(); a();
    expect(html.style.overflow).toBe('hidden');
    b();
    expect(html.style.overflow).toBe('');
    expect(body.style.overflow).toBe('');
  });
});

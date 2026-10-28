/**
 * A person's card theme: ten Apple-like mesh palettes. Everyone gets one picked deterministically from their user id; a person can choose
 * their own (saved at /me/ui/profile as { theme }, shown to others through the profile's `theme`). The same palette colours their
 * initials avatar in Messages so a person looks the same everywhere.
 */
export const PERSON_THEMES = ['indigo', 'sunset', 'ocean', 'mint', 'graphite', 'rose', 'aurora', 'sand', 'berry', 'sky'] as const;
export type PersonThemeId = (typeof PERSON_THEMES)[number];

type Palette = { label: string; a: string; b: string; c: string; d: string };
export const PALETTES: Record<PersonThemeId, Palette> = {
  indigo: { label: 'Indigo', a: '#5b5cf0', b: '#8b5cf6', c: '#c084fc', d: '#3730a3' },
  sunset: { label: 'Sunset', a: '#ff7a45', b: '#ff4f8b', c: '#ffc46b', d: '#d9366e' },
  ocean: { label: 'Ocean', a: '#0ea5b7', b: '#2563eb', c: '#5eead4', d: '#1e3a8a' },
  mint: { label: 'Mint', a: '#34d399', b: '#a3e635', c: '#99f6e4', d: '#0f766e' },
  graphite: { label: 'Graphite', a: '#4b5563', b: '#1f2937', c: '#9ca3af', d: '#111827' },
  rose: { label: 'Rose', a: '#fb7185', b: '#f472b6', c: '#fecdd3', d: '#be123c' },
  aurora: { label: 'Aurora', a: '#22d3ee', b: '#a855f7', c: '#4ade80', d: '#312e81' },
  sand: { label: 'Sand', a: '#d6a86c', b: '#b7794a', c: '#f3dfbf', d: '#7c5634' },
  berry: { label: 'Berry', a: '#9333ea', b: '#db2777', c: '#f0abfc', d: '#581c87' },
  sky: { label: 'Sky', a: '#38bdf8', b: '#6366f1', c: '#bae6fd', d: '#1d4ed8' },
};

export const isTheme = (t: unknown): t is PersonThemeId => typeof t === 'string' && (PERSON_THEMES as readonly string[]).includes(t);

/** The default theme of a person: a stable hash of their id (FNV-1a), so every device and every viewer sees the same one. */
export function defaultTheme(userId: string | null | undefined): PersonThemeId {
  let h = 0x811c9dc5;
  for (const ch of (userId ?? '').toLowerCase()) { h ^= ch.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return PERSON_THEMES[h % PERSON_THEMES.length];
}

export const themeOf = (userId: string | null | undefined, chosen?: string | null): PersonThemeId => (isTheme(chosen) ? chosen : defaultTheme(userId));

/** The banner artwork: layered radial blobs over a diagonal base (a "mesh"). */
export function meshOf(t: PersonThemeId) {
  const p = PALETTES[t];
  return `radial-gradient(120% 90% at 12% 18%, ${p.c} 0%, transparent 55%), radial-gradient(90% 120% at 88% 10%, ${p.b} 0%, transparent 60%), `
    + `radial-gradient(110% 110% at 70% 100%, ${p.d} 0%, transparent 62%), linear-gradient(135deg, ${p.a}, ${p.b})`;
}

/** The initials avatar background for a person. */
export const avatarBg = (t: PersonThemeId) => `linear-gradient(135deg, ${PALETTES[t].a}, ${PALETTES[t].b})`;

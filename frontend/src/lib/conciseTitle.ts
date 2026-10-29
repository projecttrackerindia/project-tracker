/** Longest title + New sends; anything longer is shortened and the full text goes into the description. */
export const TITLE_MAX = 120;

/**
 * A concise title from a long paragraph: drop a greeting ("Hi Team,"), take the first sentence, and cut it at a word to 120 characters.
 * The same rule as the server's GrootTitleService.FirstSentence, used when Aura (AI) is off or has not answered yet.
 */
export function conciseTitle(text: string): string {
  let t = text.replace(/\s+/g, ' ').trim();
  const rest = t.replace(/^\s*(hi|hello|hey|dear)\b[^,.!\n]{0,40}[,.!]\s*/i, '');
  if (rest) t = rest;
  const end = t.search(/[.!?]/);
  const s = (end > 0 ? t.slice(0, end) : t).trim();
  if (s.length <= TITLE_MAX) return s;
  const cut = s.slice(0, TITLE_MAX);
  const space = cut.lastIndexOf(' ');
  return `${(space > 60 ? cut.slice(0, space) : cut).replace(/[\s,;:-]+$/, '')}…`;
}

/** Whether the words are a paragraph rather than a title: too long, several sentences or lines. */
export const needsShortTitle = (text: string) => {
  const t = text.trim();
  return t.length > TITLE_MAX || /\n/.test(t) || (t.length > 60 && /[.!?]\s+\S/.test(t));
};

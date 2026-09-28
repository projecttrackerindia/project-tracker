import type { ReactNode } from 'react';
import { MONTHS } from '../../lib/format';
import { useAuth } from '../../stores/auth';

/** The API sends UTC times; read them as UTC even when the text has no "Z". */
export const utc = (iso: string) => new Date(/[zZ]|[+-]\d\d:\d\d$/.test(iso) ? iso : `${iso}Z`);

const pad = (n: number) => String(n).padStart(2, '0');
export const timeOf = (iso: string) => utc(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
export const dayKey = (iso: string) => { const d = utc(iso); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
const daysAgo = (iso: string) => Math.round((startOfDay(new Date()) - startOfDay(utc(iso))) / 86_400_000);

/** "Today", "Yesterday", "Monday", "12 Oct" or "12 Oct 2025": the heading above a day's messages. */
export function dayLabel(iso: string) {
  const n = daysAgo(iso), d = utc(iso);
  if (n === 0) return 'Today';
  if (n === 1) return 'Yesterday';
  if (n < 7) return d.toLocaleDateString(undefined, { weekday: 'long' });
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${d.getFullYear() === new Date().getFullYear() ? '' : ` ${d.getFullYear()}`}`;
}

/** The short time beside a conversation in the list: 14:05, Yesterday, Mon, 12 Oct. */
export function listTime(iso: string) {
  const n = daysAgo(iso), d = utc(iso);
  if (n === 0) return timeOf(iso);
  if (n === 1) return 'Yesterday';
  if (n < 7) return d.toLocaleDateString(undefined, { weekday: 'short' });
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

// A mention is stored in the message as @[Name](user id). It is shown as a highlighted @Name (and more strongly when it is you).
const MENTION_RE = /@\[([^\]\n]{1,100})\]\(([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\)/g;

/** A message body as plain words: mentions read "@Name". Used where the markup would be noise (reply previews, drafts). */
export const plainText = (body: string) => body.replace(MENTION_RE, '@$1');

/** Whether this message @mentions the given person. */
export const mentionsUser = (body: string, userId: string) => Array.from(body.matchAll(MENTION_RE)).some((m) => m[2].toLowerCase() === userId.toLowerCase());

const URL_RE = /(https?:\/\/[^\s<]+[^\s<.,;:!?)"'\]])/g;

/** Message text with web addresses turned into links (http and https only, opened safely in a new tab). */
export function linkify(text: string): ReactNode[] {
  return text.split(URL_RE).map((part, i) =>
    i % 2 === 1
      ? <a key={i} href={part} target="_blank" rel="noopener noreferrer nofollow">{part}</a>
      : part);
}

/** Plain text with its links and @mentions made visible. */
function renderPlain(text: string): ReactNode[] {
  const me = useAuth.getState().ctx?.user.id?.toLowerCase();
  const nodes: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(MENTION_RE)) {
    if (m.index! > last) nodes.push(...linkify(text.slice(last, m.index)));
    const self = m[2].toLowerCase() === me;
    nodes.push(<span key={`m${m.index}`} className={`mention ${self ? 'me' : ''}`} title={self ? 'You were mentioned' : undefined}>@{m[1]}</span>);
    last = m.index! + m[0].length;
  }
  if (last < text.length) nodes.push(...linkify(text.slice(last)));
  return nodes;
}

// **bold**, *italic*, __underline__ — a mark must hug its text (no space right inside it) and not sit inside a word, so "2 * 3 * 4" and
// "my__var__name" are left alone. Same rules as the server's preview stripping (ChatService.Snippet), so what is typed is what shows.
// Marks can nest (the composer can apply bold+italic+underline to the same text at once, e.g. "**__*text*__**"), so each match's
// inner text is parsed again rather than just linkified, letting combinations of marks resolve to the right combination of tags.
const FORMAT_RE = /(?<![\w*])\*\*(?=\S)([\s\S]+?)(?<=\S)\*\*(?![\w*])|(?<![\w_])__(?=\S)([\s\S]+?)(?<=\S)__(?![\w_])|(?<![\w*])\*(?=[^\s*])([^*\n]+?)(?<=[^\s*])\*(?![\w*])/g;

/** A message body with **bold**, *italic* and __underline__ turned into real formatting, and links made clickable throughout. */
export function renderBody(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0, key = 0;
  for (const m of text.matchAll(FORMAT_RE)) {
    if (m.index! > last) nodes.push(...renderPlain(text.slice(last, m.index)));
    if (m[1] !== undefined) nodes.push(<strong key={key++}>{renderBody(m[1])}</strong>);
    else if (m[2] !== undefined) nodes.push(<u key={key++}>{renderBody(m[2])}</u>);
    else nodes.push(<em key={key++}>{renderBody(m[3])}</em>);
    last = m.index! + m[0].length;
  }
  if (last < text.length) nodes.push(...renderPlain(text.slice(last)));
  return nodes;
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = (s: string) => escapeHtml(s).replace(/"/g, '&quot;');

/** The composer shows a mention as a chip (a piece that is deleted as a whole); this is its HTML. */
export const mentionChipHtml = (name: string, userId: string) =>
  `<span class="mention-chip" contenteditable="false" data-uid="${escapeAttr(userId)}" data-name="${escapeAttr(name)}">@${escapeHtml(name)}</span>`;

/** Escaped text with its @[Name](id) mentions turned into chips. */
function plainToHtml(text: string): string {
  let out = '', last = 0;
  for (const m of text.matchAll(MENTION_RE)) {
    out += escapeHtml(text.slice(last, m.index));
    out += mentionChipHtml(m[1], m[2]);
    last = m.index! + m[0].length;
  }
  return out + escapeHtml(text.slice(last));
}

/** The composer's rich-text box shows real formatting as you type (like Teams) rather than the raw marks, so a stored body
 *  needs converting to HTML once to seed it — when opening a message for editing, or restoring an unsent draft. */
export function markdownToHtml(text: string): string {
  let out = '';
  let last = 0;
  for (const m of text.matchAll(FORMAT_RE)) {
    if (m.index! > last) out += plainToHtml(text.slice(last, m.index));
    if (m[1] !== undefined) out += `<b>${markdownToHtml(m[1])}</b>`;
    else if (m[2] !== undefined) out += `<u>${markdownToHtml(m[2])}</u>`;
    else out += `<i>${markdownToHtml(m[3])}</i>`;
    last = m.index! + m[0].length;
  }
  if (last < text.length) out += plainToHtml(text.slice(last));
  return out.replace(/\n/g, '<br>');
}

const hasStyle = (el: HTMLElement, prop: 'fontWeight' | 'fontStyle' | 'textDecorationLine' | 'textDecoration', value: string) =>
  (el.style[prop] || '').toLowerCase().includes(value);

/** Walks one node of the composer's rich-text box back down to a plain-text body with light markup — the mirror image of
 *  markdownToHtml. Reads DOM structure (tag names, and inline styles as a fallback for browsers that mark up bold
 *  differently), not React state, since the box's content is edited by the browser directly (execCommand), not by React. */
function domToMarkdown(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return (node.textContent ?? '').replace(/\u00a0/g, ' ');
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  const el = node as HTMLElement;
  if (el.tagName === 'BR') return '\n';
  if (el.dataset.uid) return `@[${(el.dataset.name ?? '').replace(/[[\]()\r\n]/g, '')}](${el.dataset.uid})`;   // a mention chip
  let out = Array.from(el.childNodes).map(domToMarkdown).join('');
  if (!out) return el.tagName === 'DIV' || el.tagName === 'P' ? '\n' : '';
  const bold = el.tagName === 'B' || el.tagName === 'STRONG' || hasStyle(el, 'fontWeight', 'bold') || hasStyle(el, 'fontWeight', '700');
  const italic = el.tagName === 'I' || el.tagName === 'EM' || hasStyle(el, 'fontStyle', 'italic');
  const underline = el.tagName === 'U' || hasStyle(el, 'textDecorationLine', 'underline') || hasStyle(el, 'textDecoration', 'underline');
  if (bold) out = `**${out}**`;
  if (underline) out = `__${out}__`;
  if (italic) out = `*${out}*`;
  return el.tagName === 'DIV' || el.tagName === 'P' ? `${out}\n` : out;   // some browsers wrap each line in a block instead of using <br>
}

/** The composer's rich-text box, serialized back to the light-markup plain text the rest of the app stores. */
export function domToBody(root: HTMLElement): string {
  return Array.from(root.childNodes).map(domToMarkdown).join('').replace(/\n+$/, '');
}

/** A short, well-liked set covering the usual reactions — enough for a chat composer without pulling in an emoji-data package. */
export const COMMON_EMOJI = [
  '😀', '😂', '🤣', '😊', '😉', '😍', '😘', '😎', '🤔', '😅', '😢', '😭', '😡', '😱', '🥳', '😴',
  '👍', '👎', '👏', '🙏', '👋', '💪', '🤝', '✌️', '🤞', '👌', '🙌', '🤦', '🤷', '💯', '🔥', '✨',
  '❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '💔', '💕', '⭐', '🎉', '🎊', '🎂', '🚀', '✅', '❌',
];

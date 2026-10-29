/**
 * A conversation row's preview as Messages shows it: one readable line. Code, JSON and log payloads read "Code snippet", a file reads
 * "📎 name", a bare link reads as its domain; markup is stripped and whitespace collapsed. A leading "You: " / "Name: " is kept.
 */
const CODEY = [
  /^\s*```/m, /```/,
  /^\s*[[{]\s*("|\w+\s*[=:]|\[|\{|$)/,                       // JSON / object dumps: { "a": …, { payload=…, [ {
  /\b(?:org|com|java|javax|net)\.[a-z]+\.[a-z]+\.[\w.$]+/i,  // Java/Mule class names
  /\w+=\w+[.@]\w+/,                                          // key=value.dotted dumps
  /^\s*(?:at\s+[\w.$]+\(|Exception\b|Traceback\b|\w+(?:Error|Exception):)/m,
  /^\s*(?:<\?xml|<[a-z][\w-]*[\s>][\s\S]*<\/[a-z])/i,
  /^\s*(?:SELECT|INSERT|UPDATE|DELETE)\s.+\s(?:FROM|INTO|SET|WHERE)\s/i,
  /^\s*(?:const|let|var|function|import|export|def|class|public|private)\s+\w+/m,
];

function symbolHeavy(s: string) {
  const sym = (s.match(/[{}[\]<>=;"\\|$]/g) ?? []).length;
  return s.length >= 16 && sym / s.length > 0.12;
}

export function readablePreview(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  let prefix = '', body = raw;
  const m = /^(You|[^\s:{}[\]"=]{1,40}): ([\s\S]*)$/.exec(raw);
  if (m) { prefix = `${m[1]}: `; body = m[2]; }
  const file = /^Sent a file: (.+)$/s.exec(body.trim());
  if (file) return `${prefix}📎 ${file[1].trim()}`;
  if (CODEY.some((re) => re.test(body)) || symbolHeavy(body)) return `${prefix}Code snippet`;
  let text = body
    .replace(/<[^>]{1,200}>/g, ' ')                           // html tags
    .replace(/!?\[([^\]]*)\]\(([^)]*)\)/g, '$1')              // markdown links / images
    .replace(/@\[([^\]]+)\]\([^)]*\)/g, '@$1')                // mentions
    .replace(/(\*\*|__|~~|`)/g, '')
    .replace(/(^|\s)[*_](\S[^*_]*\S|\S)[*_](?=\s|$)/g, '$1$2')
    .replace(/^\s*(?:#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/\s+/g, ' ').trim();
  const url = /^(https?:\/\/)([^/\s?#]+)\S*$/i.exec(text);
  if (url) text = url[2].replace(/^www\./, '');
  else text = text.replace(/https?:\/\/([^/\s?#]+)\S*/gi, (_, host: string) => host.replace(/^www\./, ''));
  return `${prefix}${text}`;
}

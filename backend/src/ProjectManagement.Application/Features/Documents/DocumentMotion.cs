using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Documents;

public record PageStyleDto(string Preset, string Css, bool AnimateSections, string SectionTransition);
public record SavePageStyleRequest(int Revision, PageStyleDto? Style);
public record LibraryDesignDto(bool CustomCss, bool SandboxEmbeds, bool CanManage);
public record SaveLibraryDesignRequest(bool CustomCss, bool SandboxEmbeds);

/// <summary>
/// A page's own CSS, checked on the server before it is stored (the browser checks the same rules and also fences the CSS into the page with
/// <c>@scope</c>; see frontend motion/cssScope.ts). A strict allow-list: the CSS is parsed into rules, at-rules and declarations, and anything that
/// could load from elsewhere (@import, @font-face, url() other than a small data: image, image-set()), run (expression(), behavior, -moz-binding,
/// javascript:), or float over the app (position fixed/sticky, z-index above 10), or reach outside the page (selectors starting with a combinator,
/// :host) is refused with a message per problem. Backslash escapes and &lt; are refused outright so none of it can be spelled sideways.
/// </summary>
public static class PageCss
{
    public const int MaxChars = 20_000, MaxDataUrl = 12_000, MaxRules = 600;
    private static readonly Regex Prop = new(@"^(--[a-zA-Z0-9_-]{1,60}|-?[a-z][a-z0-9-]{0,60})$", RegexOptions.CultureInvariant);
    private static readonly Regex KeyframeName = new(@"^[a-zA-Z_][\w-]{0,40}$", RegexOptions.CultureInvariant);
    private static readonly Regex KeyframeStep = new(@"^(from|to|\d{1,3}(\.\d+)?%)(\s*,\s*(from|to|\d{1,3}(\.\d+)?%))*$", RegexOptions.CultureInvariant | RegexOptions.IgnoreCase);
    private static readonly Regex MediaPrelude = new(@"^[a-z0-9\s:().,\-/]+$", RegexOptions.CultureInvariant | RegexOptions.IgnoreCase);
    private static readonly Regex Theme = new(@"^\(\s*prefers-color-scheme\s*:\s*(dark|light)\s*\)$", RegexOptions.CultureInvariant | RegexOptions.IgnoreCase);
    private static readonly Regex Url = new(@"url\s*\(\s*(['""]?)([^'"")]*)\1\s*\)", RegexOptions.CultureInvariant | RegexOptions.IgnoreCase);
    private static readonly Regex UrlStart = new(@"url\s*\(", RegexOptions.CultureInvariant | RegexOptions.IgnoreCase);
    private static readonly Regex DataImage = new(@"^data:image/(png|jpeg|gif|webp);base64,[a-z0-9+/=\s]+$", RegexOptions.CultureInvariant | RegexOptions.IgnoreCase);
    private static readonly (Regex Re, string Message)[] Banned =
    [
        (new Regex(@"expression\s*\(", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant), "expression() is not allowed."),
        (new Regex(@"javascript\s*:", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant), "javascript: is not allowed."),
        (new Regex(@"vbscript\s*:", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant), "vbscript: is not allowed."),
        (new Regex(@"-moz-binding", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant), "-moz-binding is not allowed."),
        (new Regex(@"(^|[^a-z-])behavior\s*:", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant), "behavior is not allowed."),
        (new Regex(@"(-webkit-)?image-set\s*\(", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant), "image-set() is not allowed."),
        (new Regex(@"(^|[^a-z-])(src|image|element|-moz-element)\s*\(", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant), "Functions that load files are not allowed."),
    ];

    /// <summary>The problems in a page's CSS, each with its line ("" CSS has none). Empty = it may be stored.</summary>
    public static IReadOnlyList<string> Check(string? source)
    {
        var errors = new List<string>();
        if (string.IsNullOrWhiteSpace(source)) return errors;
        if (source.Length > MaxChars) { errors.Add($"The CSS is too long ({source.Length / 1000} KB): keep it under 20 KB."); return errors; }
        // Comments out, newlines kept.
        var sb = new StringBuilder(source.Length);
        for (var i = 0; i < source.Length;)
        {
            if (i + 1 < source.Length && source[i] == '/' && source[i + 1] == '*')
            {
                var end = source.IndexOf("*/", i + 2, StringComparison.Ordinal);
                if (end < 0) { errors.Add($"Line {LineOf(source, i)}: a /* comment is not closed."); return errors; }
                for (var k = i; k < end + 2; k++) sb.Append(source[k] == '\n' ? '\n' : ' ');
                i = end + 2;
            }
            else sb.Append(source[i++]);
        }
        var text = sb.ToString();
        var bs = text.IndexOf('\\'); if (bs >= 0) errors.Add($"Line {LineOf(text, bs)}: backslash escapes are not allowed.");
        var lt = text.IndexOf('<'); if (lt >= 0) errors.Add($"Line {LineOf(text, lt)}: < is not allowed in CSS.");
        var ctl = -1;
        for (var k = 0; k < text.Length && ctl < 0; k++) if ((text[k] < 32 && text[k] is not ('\n' or '\r' or '\t' or '\f')) || text[k] == '\u007f') ctl = k;
        if (ctl >= 0) errors.Add($"Line {LineOf(text, ctl)}: control characters are not allowed.");
        if (errors.Count > 0) return errors;
        var r = new Reader(text, errors);
        var rules = 0;
        Block(r, top: true, depth: 0, ref rules);
        return errors;
    }

    private static int LineOf(string s, int at) { var n = 1; for (var k = 0; k < at && k < s.Length; k++) if (s[k] == '\n') n++; return n; }

    private sealed class Reader(string s, List<string> errors)
    {
        public readonly string S = s;
        public int I;
        public void Err(string message, int? at = null) { if (errors.Count < 20) errors.Add($"Line {LineOf(S, at ?? I)}: {message}"); }
        public void Ws() { while (I < S.Length && char.IsWhiteSpace(S[I])) I++; }
        /// <summary>Up to one of <paramref name="stops"/> at depth 0 outside quotes; null at the end of the text.</summary>
        public string? Until(string stops)
        {
            var start = I; var depth = 0;
            while (I < S.Length)
            {
                var c = S[I];
                if (c is '"' or '\'')
                {
                    var q = c; I++;
                    while (I < S.Length && S[I] != q) { if (S[I] == '\n') { Err("a quoted text is not closed."); break; } I++; }
                    I++; continue;
                }
                if (c is '(' or '[') depth++;
                else if (c is ')' or ']' && depth > 0) depth--;
                else if (depth == 0 && stops.Contains(c)) return S[start..I];
                I++;
            }
            return null;
        }
        public void SkipBlock() { var depth = 1; while (I < S.Length && depth > 0) { var c = S[I++]; if (c == '{') depth++; else if (c == '}') depth--; } }
    }

    private static List<string> SplitTop(string s, char sep)
    {
        var outList = new List<string>(); int depth = 0, start = 0; var q = '\0';
        for (var i = 0; i < s.Length; i++)
        {
            var c = s[i];
            if (q != '\0') { if (c == q) q = '\0'; continue; }
            if (c is '"' or '\'') q = c;
            else if (c is '(' or '[') depth++;
            else if (c is ')' or ']') depth = Math.Max(0, depth - 1);
            else if (c == sep && depth == 0) { outList.Add(s[start..i]); start = i + 1; }
        }
        outList.Add(s[start..]);
        return outList;
    }

    private static void Block(Reader r, bool top, int depth, ref int rules)
    {
        while (true)
        {
            r.Ws();
            if (r.I >= r.S.Length) { if (!top) r.Err("a { is not closed."); return; }
            if (r.S[r.I] == '}') { if (top) { r.Err("an extra } with no {."); r.I++; continue; } r.I++; return; }
            if (++rules > MaxRules) { r.Err("too many rules."); r.I = r.S.Length; return; }
            var at = r.I;
            if (r.S[r.I] == '@')
            {
                var m = Regex.Match(r.S[r.I..], @"^@([a-zA-Z-]+)");
                var name = m.Success ? m.Groups[1].Value.ToLowerInvariant() : "";
                r.I += name.Length + 1;
                var prelude = r.Until("{;}");
                if (prelude is null || r.I >= r.S.Length || r.S[r.I] != '{') { r.Err($"@{(name.Length > 0 ? name : "?")} is not allowed.", at); if (r.I < r.S.Length && r.S[r.I] == ';') r.I++; continue; }
                r.I++;
                if (name == "media")
                {
                    var p = prelude.Trim();
                    var theme = Theme.IsMatch(p);
                    if (depth > 0) { r.Err("@media cannot be inside another @media.", at); r.SkipBlock(); continue; }
                    if (!theme && (!MediaPrelude.IsMatch(p) || p.Contains("url", StringComparison.OrdinalIgnoreCase) || p.Contains("prefers-color-scheme", StringComparison.OrdinalIgnoreCase)))
                    { r.Err("that @media condition is not allowed.", at); r.SkipBlock(); continue; }
                    Block(r, top: false, depth + 1, ref rules);
                }
                else if (name is "keyframes" or "-webkit-keyframes")
                {
                    if (!KeyframeName.IsMatch(prelude.Trim())) { r.Err("a @keyframes name may only hold letters, digits, - and _.", at); r.SkipBlock(); continue; }
                    if (!top) { r.Err("@keyframes must be at the top level.", at); r.SkipBlock(); continue; }
                    while (true)
                    {
                        r.Ws();
                        if (r.I >= r.S.Length) { r.Err("@keyframes is not closed.", at); break; }
                        if (r.S[r.I] == '}') { r.I++; break; }
                        var sAt = r.I;
                        var step = r.Until("{}");
                        if (step is null || r.S[r.I] != '{') { r.Err("a keyframe step could not be read.", sAt); r.SkipBlock(); break; }
                        r.I++;
                        if (!KeyframeStep.IsMatch(step.Trim())) r.Err("not a keyframe step (from, to or a %).", sAt);
                        var dAt = r.I; var body = r.Until("{}");
                        if (body is null || r.S[r.I] != '}') { r.Err("a keyframe step is not closed.", sAt); r.SkipBlock(); break; }
                        r.I++;
                        Declarations(r, body, dAt);
                    }
                }
                else { r.Err($"@{name} is not allowed.", at); r.SkipBlock(); }
                continue;
            }
            var sel = r.Until("{};");
            if (sel is null || r.S[r.I] != '{') { r.Err("expected { after the selector.", at); if (r.I < r.S.Length) r.I++; continue; }
            r.I++;
            var bodyAt = r.I;
            var decls = r.Until("{}");
            if (decls is null || r.S[r.I] != '}') { r.Err("a rule is not closed (or holds a { inside).", bodyAt); r.SkipBlock(); continue; }
            r.I++;
            Selectors(r, sel, at);
            Declarations(r, decls, bodyAt);
        }
    }

    private static void Selectors(Reader r, string prelude, int at)
    {
        var s = prelude.Trim();
        if (s.Length == 0) { r.Err("a rule has no selector.", at); return; }
        if (s.IndexOfAny(['{', '}', ';', '@', '<']) >= 0) { r.Err("that selector could not be read.", at); return; }
        foreach (var raw in SplitTop(s, ','))
        {
            var sel = Regex.Replace(raw.Trim(), @"\s+", " ");
            if (sel.Length == 0) { r.Err("an empty selector in a list.", at); return; }
            if (sel[0] is '>' or '+' or '~') { r.Err($"\"{sel}\" starts with a combinator: it would reach outside the page.", at); return; }
            if (Regex.IsMatch(sel, @":host|::slotted|::part|:global", RegexOptions.IgnoreCase)) { r.Err($"\"{sel}\" is not allowed.", at); return; }
            var root = Regex.Match(sel, @"^(:root|html|body|:scope)(?![\w-])", RegexOptions.IgnoreCase);
            var rest = root.Success ? sel[root.Length..] : sel;
            if (Regex.IsMatch(rest, @"(^|[\s>+~(,])(:root|html|body)(?![\w-])", RegexOptions.IgnoreCase) || rest.Contains(":scope", StringComparison.OrdinalIgnoreCase))
            { r.Err($"\"{raw.Trim()}\": :root, html, body and :scope can only start a selector.", at); return; }
        }
    }

    private static void Declarations(Reader r, string body, int offset)
    {
        foreach (var part in SplitTop(body, ';'))
        {
            if (part.Trim().Length == 0) continue;
            var at = offset + Math.Max(0, body.IndexOf(part, StringComparison.Ordinal));
            var colon = part.IndexOf(':');
            if (colon < 0) { r.Err("not a property: value.", at); continue; }
            var rawProp = part[..colon].Trim();
            var prop = rawProp.StartsWith("--", StringComparison.Ordinal) ? rawProp : rawProp.ToLowerInvariant();
            if (!Prop.IsMatch(prop)) { r.Err($"\"{(prop.Length > 40 ? prop[..40] : prop)}\" is not a property name.", at); continue; }
            if (prop is "behavior" or "-ms-behavior" or "-moz-binding") { r.Err($"{prop} is not allowed.", at); continue; }
            var v = part[(colon + 1)..].Trim();
            if (v.Length == 0) { r.Err($"\"{prop}\" has no value.", at); continue; }
            var bad = Banned.FirstOrDefault(b => b.Re.IsMatch(v));
            if (bad.Re is not null) { r.Err(bad.Message, at); continue; }
            var urls = Url.Matches(v);
            if (UrlStart.Matches(v).Count != urls.Count) { r.Err("url() could not be read.", at); continue; }
            var urlOk = true;
            foreach (Match u in urls)
            {
                if (prop == "content") { r.Err("url() is not allowed in content.", at); urlOk = false; break; }
                var target = u.Groups[2].Value.Trim();
                if (!DataImage.IsMatch(target)) { r.Err("url() may only hold a data:image (png, jpeg, gif or webp) - no addresses.", at); urlOk = false; break; }
                if (target.Length > MaxDataUrl) { r.Err("that data: image is too large (keep it under 12 KB).", at); urlOk = false; break; }
            }
            if (!urlOk) continue;
            if (prop == "position" && Regex.IsMatch(v, "fixed|sticky", RegexOptions.IgnoreCase)) { r.Err("position: fixed and sticky are not allowed.", at); continue; }
            if (prop == "z-index")
            {
                var z = Regex.Replace(v, @"\s*!important$", "", RegexOptions.IgnoreCase);
                if (Regex.IsMatch(z, @"^-?\d+$")) { if (long.TryParse(z, out var zi) && zi > 10 || z.TrimStart('-').Length > 9) r.Err("z-index can be at most 10.", at); }
                else if (!Regex.IsMatch(z, "^(auto|inherit|initial|unset|revert)$", RegexOptions.IgnoreCase)) r.Err("z-index must be a whole number up to 10.", at);
            }
        }
    }
}

/// <summary>
/// An animated SVG kept in a page, rebuilt from an allow-list (the same rules as frontend motion/svgClean.ts): known shapes, gradients, filters and
/// animation elements with plain attributes only. Scripts, foreignObject and everything else are dropped with what they hold; event handlers (on…),
/// links that leave the picture (href other than #id), javascript:/data: values and styles that load anything are removed. It is shown as an image.
/// </summary>
public static class MotionSvg
{
    public const int MaxChars = 150_000;
    private static readonly HashSet<string> Elements = ["svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "text", "tspan", "defs", "lineargradient", "radialgradient", "stop",
        "clippath", "mask", "pattern", "symbol", "use", "title", "desc", "animate", "animatetransform", "animatemotion", "mpath", "style", "filter", "fegaussianblur", "feoffset",
        "feblend", "fecolormatrix", "femerge", "femergenode", "feflood", "fecomposite", "fedropshadow", "marker"];
    private static readonly Dictionary<string, string> Canon = new()
    {
        ["lineargradient"] = "linearGradient", ["radialgradient"] = "radialGradient", ["clippath"] = "clipPath", ["animatetransform"] = "animateTransform", ["animatemotion"] = "animateMotion",
        ["fegaussianblur"] = "feGaussianBlur", ["feoffset"] = "feOffset", ["feblend"] = "feBlend", ["fecolormatrix"] = "feColorMatrix", ["femerge"] = "feMerge", ["femergenode"] = "feMergeNode",
        ["feflood"] = "feFlood", ["fecomposite"] = "feComposite", ["fedropshadow"] = "feDropShadow",
    };
    private static readonly Regex Name = new(@"^[a-zA-Z][a-zA-Z0-9:_-]{0,40}$", RegexOptions.CultureInvariant);
    private static readonly Regex AttrName = new(@"^[a-zA-Z][a-zA-Z0-9:_.-]{0,40}$", RegexOptions.CultureInvariant);
    private static readonly Regex BadValue = new(@"(javascript|vbscript|data)\s*:|expression\s*\(|@import|-moz-binding|behavior", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    private static readonly Regex UrlRef = new(@"url\s*\(\s*(['""]?)([^'"")]*)\1\s*\)", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    private static string C(string n) => Canon.TryGetValue(n, out var c) ? c : n;

    private static string Esc(string s) =>
        Regex.Replace(s, @"&(?!(amp|lt|gt|quot|apos|#\d{1,7}|#x[0-9a-fA-F]{1,6});)", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;").Replace("\"", "&quot;");

    private static string? CleanCss(string css)
    {
        if (css.Contains('\\') || css.Contains('<') || BadValue.IsMatch(css)) return null;
        var refs = UrlRef.Matches(css);
        if (Regex.Matches(css, @"url\s*\(", RegexOptions.IgnoreCase).Count != refs.Count) return null;
        foreach (Match m in refs) if (!m.Groups[2].Value.Trim().StartsWith('#')) return null;
        return css;
    }

    private static string? CleanAttr(string el, string name, string value)
    {
        var n = name.ToLowerInvariant();
        if (!AttrName.IsMatch(name) || n.StartsWith("on", StringComparison.Ordinal) || n is "srcdoc" or "formaction" or "src") return null;
        var v = value.Trim();
        var flat = new string(v.Where(ch => ch > ' ').ToArray());
        if (n is "href" or "xlink:href") return Regex.IsMatch(flat, @"^#[\w.-]{1,80}$") ? v : null;
        if (n == "style") return CleanCss(v);
        if (BadValue.IsMatch(flat)) return null;
        if (Regex.IsMatch(v, @"url\s*\(", RegexOptions.IgnoreCase) && !Regex.IsMatch(v, @"^url\(\s*['""]?#[\w.-]+['""]?\s*\)$", RegexOptions.IgnoreCase)) return null;
        if (el is "animate" or "set" or "animatetransform" or "animatemotion" && n == "attributename" && Regex.IsMatch(v, "href|^on|style", RegexOptions.IgnoreCase)) return null;
        if (n.StartsWith("xmlns", StringComparison.Ordinal) && n is not ("xmlns" or "xmlns:xlink")) return null;
        return v;
    }

    /// <summary>The cleaned picture, or null when it is not an SVG (or too large).</summary>
    public static string? Clean(string? input)
    {
        if (string.IsNullOrWhiteSpace(input) || input.Length > MaxChars) return null;
        var s = input.TrimStart('\uFEFF');
        var sb = new StringBuilder();
        var stack = new List<(string Name, bool Keep)>();
        int i = 0, skip = 0; var sawRoot = false;
        while (i < s.Length)
        {
            if (string.CompareOrdinal(s, i, "<!--", 0, 4) == 0) { var e = s.IndexOf("-->", i + 4, StringComparison.Ordinal); i = e < 0 ? s.Length : e + 3; continue; }
            if (string.CompareOrdinal(s, i, "<?", 0, 2) == 0) { var e = s.IndexOf("?>", i + 2, StringComparison.Ordinal); i = e < 0 ? s.Length : e + 2; continue; }
            if (string.CompareOrdinal(s, i, "<![CDATA[", 0, 9) == 0)
            {
                var e = s.IndexOf("]]>", i, StringComparison.Ordinal); var text = s[(i + 9)..(e < 0 ? s.Length : e)]; i = e < 0 ? s.Length : e + 3;
                if (skip == 0 && stack.Count > 0 && stack[^1].Name == "style" && CleanCss(text) is { } c1) sb.Append(Esc(c1));
                continue;
            }
            if (string.CompareOrdinal(s, i, "<!", 0, 2) == 0) { var e = s.IndexOf('>', i); i = e < 0 ? s.Length : e + 1; continue; }
            if (s[i] == '<')
            {
                var close = i + 1 < s.Length && s[i + 1] == '/';
                var j = i + (close ? 2 : 1);
                var nmStart = j;
                while (j < s.Length && !char.IsWhiteSpace(s[j]) && s[j] != '/' && s[j] != '>') j++;
                var nm = s[nmStart..j];
                var attrs = new List<(string, string)>();
                var selfClose = false;
                while (j < s.Length && s[j] != '>')
                {
                    if (char.IsWhiteSpace(s[j])) { j++; continue; }
                    if (s[j] == '/' && j + 1 < s.Length && s[j + 1] == '>') { selfClose = true; j++; continue; }
                    var anStart = j;
                    while (j < s.Length && !char.IsWhiteSpace(s[j]) && s[j] is not ('=' or '/' or '>')) j++;
                    if (j == anStart) { j++; continue; }
                    var an = s[anStart..j];
                    while (j < s.Length && char.IsWhiteSpace(s[j])) j++;
                    var av = "";
                    if (j < s.Length && s[j] == '=')
                    {
                        j++; while (j < s.Length && char.IsWhiteSpace(s[j])) j++;
                        if (j < s.Length && s[j] is '"' or '\'')
                        {
                            var q = s[j]; var e = s.IndexOf(q, j + 1);
                            av = s[(j + 1)..(e < 0 ? s.Length : e)]; j = e < 0 ? s.Length : e + 1;
                        }
                        else { var vs = j; while (j < s.Length && !char.IsWhiteSpace(s[j]) && s[j] != '>') j++; av = s[vs..j]; }
                    }
                    attrs.Add((an, av));
                }
                i = Math.Min(s.Length, j + 1);
                var name = nm.ToLowerInvariant();
                if (!Name.IsMatch(nm)) continue;
                if (close)
                {
                    var at = stack.FindLastIndex(x => x.Name == name);
                    if (at < 0) continue;
                    while (stack.Count > at)
                    {
                        var top = stack[^1]; stack.RemoveAt(stack.Count - 1);
                        if (!top.Keep) skip--; else if (skip == 0) sb.Append("</").Append(C(top.Name)).Append('>');
                    }
                    continue;
                }
                if (!sawRoot && name != "svg") return null;
                sawRoot = true;
                var keep = skip == 0 && Elements.Contains(name);
                if (keep)
                {
                    sb.Append('<').Append(C(name));
                    foreach (var (an, av) in attrs)
                        if (CleanAttr(name, an, av) is { } v) sb.Append(' ').Append(an).Append("=\"").Append(Esc(v)).Append('"');
                    if (name == "svg" && !attrs.Any(a => a.Item1.Equals("xmlns", StringComparison.OrdinalIgnoreCase))) sb.Append(" xmlns=\"http://www.w3.org/2000/svg\"");
                    sb.Append(selfClose ? "/>" : ">");
                }
                if (!selfClose) { stack.Add((name, keep)); if (!keep) skip++; }
                continue;
            }
            var next = s.IndexOf('<', i);
            var txt = s[i..(next < 0 ? s.Length : next)];
            i = next < 0 ? s.Length : next;
            if (skip > 0) continue;
            if (stack.Count > 0 && stack[^1].Name == "style") { if (CleanCss(txt) is { } c2) sb.Append(Esc(c2)); }
            else if (stack.Count > 0) sb.Append(Esc(txt));
        }
        while (stack.Count > 0) { var top = stack[^1]; stack.RemoveAt(stack.Count - 1); if (top.Keep && skip == 0) sb.Append("</").Append(C(top.Name)).Append('>'); else if (!top.Keep) skip--; }
        return sawRoot ? sb.ToString() : null;
    }
}

/// <summary>Motion in a page's rich text: the page's style kept on the body (<c>attrs.pageStyle</c>), block motion attributes and the motion blocks.</summary>
public static class MotionContent
{
    public static readonly HashSet<string> Presets = ["default", "editorial", "product", "minimal", "dark-hero"];
    public static readonly HashSet<string> Transitions = ["none", "line", "fade"];
    public static readonly HashSet<string> Motions = ["none", "fade", "rise", "scale", "slide", "stagger"];
    public static readonly int[] Delays = [0, 100, 200, 400];
    public static readonly int[] Durations = [200, 400, 700];
    public static readonly HashSet<string> EmbedTypes = ["motionLottie", "motionSvg", "motionVideo", "sandboxEmbed"];
    public const int MaxSandboxHtml = 40_000, MaxSandboxCss = 20_000, MaxSandboxJs = 40_000, MaxSandboxTotal = 80_000;

    /// <summary>A block's motion, kept only when it is one of the known choices.</summary>
    public static void CopyMotion(JsonNode? from, JsonObject attrs)
    {
        var motion = from?["motion"] is JsonValue mv && mv.TryGetValue<string>(out var m) && Motions.Contains(m) ? m : null;
        if (motion is null or "none") return;
        attrs["motion"] = motion;
        var delay = from?["motionDelay"] is JsonValue dv && dv.TryGetValue<int>(out var d) && Delays.Contains(d) ? d : 0;
        var duration = from?["motionDuration"] is JsonValue uv && uv.TryGetValue<int>(out var u) && Durations.Contains(u) ? u : 400;
        attrs["motionDelay"] = delay;
        attrs["motionDuration"] = duration;
    }

    /// <summary>The style on a stored body, or null.</summary>
    public static JsonObject? StyleOf(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return null;
        try { return JsonNode.Parse(json) is JsonObject o && o["attrs"]?["pageStyle"] is JsonObject s ? (JsonObject)s.DeepClone() : null; }
        catch (JsonException) { return null; }
    }

    /// <summary>The body with this style on it (null takes it off).</summary>
    public static string WithStyle(string json, JsonObject? style)
    {
        JsonObject o;
        try { o = JsonNode.Parse(json) as JsonObject ?? new JsonObject { ["type"] = "doc" }; }
        catch (JsonException) { return json; }
        o.Remove("attrs");
        if (style is not null) o["attrs"] = new JsonObject { ["pageStyle"] = style.DeepClone() };
        return o.ToJsonString();
    }

    /// <summary>Checks a requested style (presets and transitions by name, the CSS by <see cref="PageCss"/>) and returns it as stored, or null for the default look.</summary>
    public static JsonObject? CleanStyle(PageStyleDto? s, bool cssAllowed)
    {
        if (s is null) return null;
        var preset = Presets.Contains(s.Preset ?? "") ? s.Preset! : throw new ValidationException("style.preset", "Choose one of the presets.");
        var transition = Transitions.Contains(s.SectionTransition ?? "none") ? s.SectionTransition ?? "none" : throw new ValidationException("style.sectionTransition", "Choose None, Drawn line or Soft fade.");
        var css = (s.Css ?? "").Replace("\r\n", "\n");
        if (css.Trim().Length > 0 && !cssAllowed) throw new ValidationException("style.css", "Custom CSS is turned off for this workspace.");
        var problems = PageCss.Check(css);
        if (problems.Count > 0) throw new ValidationException("style.css", string.Join(" ", problems.Take(5)));
        if (preset == "default" && css.Trim().Length == 0 && !s.AnimateSections && transition == "none") return null;
        return new JsonObject { ["preset"] = preset, ["css"] = css.Trim().Length == 0 ? "" : css, ["animateSections"] = s.AnimateSections, ["sectionTransition"] = transition };
    }

    /// <summary>How many of each motion block a body holds.</summary>
    public static Dictionary<string, int> CountEmbeds(string? json)
    {
        var counts = new Dictionary<string, int>();
        if (string.IsNullOrWhiteSpace(json)) return counts;
        void Walk(JsonNode? n)
        {
            if (n is JsonObject o)
            {
                if (o["type"] is JsonValue tv && tv.TryGetValue<string>(out var t) && EmbedTypes.Contains(t)) counts[t] = counts.GetValueOrDefault(t) + 1;
                Walk(o["content"]);
            }
            else if (n is JsonArray a) foreach (var x in a) Walk(x);
        }
        try { Walk(JsonNode.Parse(json)); } catch (JsonException) { }
        return counts;
    }

    /// <summary>The kinds of motion block there are more of now than before (what was added).</summary>
    public static List<string> Added(string? before, string? after)
    {
        var b = CountEmbeds(before); var a = CountEmbeds(after);
        return a.Where(kv => kv.Value > b.GetValueOrDefault(kv.Key)).Select(kv => kv.Key).OrderBy(k => k).ToList();
    }

    public static string Clip(string? s, int max) { var v = s ?? ""; return v.Length > max ? v[..max] : v; }

    // ------------------------------------------------------------------ AI edits keep the motion

    /// <summary>How a motion block is shown to the model: an opaque <c>[[keep:N]]</c> line (with its still, for context), restored by <see cref="KeepBlocks"/>.</summary>
    private static readonly Regex KeepMark = new(@"\[\[keep:(\d{1,3})\]\]", RegexOptions.CultureInvariant);
    public const string KeepHint = "Motion blocks (animations, videos, interactive embeds) show as [[keep:N]] lines: leave each on its own line where it belongs; it is put back exactly as it was.";

    private static string TypeOf(JsonObject o) => o["type"] is JsonValue tv && tv.TryGetValue<string>(out var t) ? t : "";
    private static bool IsEmbed(JsonObject o) => EmbedTypes.Contains(TypeOf(o));

    /// <summary>A rich-text body as lines for the model, every top-level motion block as a <c>[[keep:N]]</c> placeholder in its place.</summary>
    public static List<string> LinesForAi(string? json)
    {
        var lines = new List<string>();
        if (string.IsNullOrWhiteSpace(json)) return lines;
        JsonNode? root;
        try { root = JsonNode.Parse(json); } catch (JsonException) { return lines; }
        var n = 0;
        foreach (var b in (root?["content"] as JsonArray ?? []).OfType<JsonObject>())
        {
            if (IsEmbed(b)) { lines.Add($"[[keep:{++n}]] {DocumentDiff.MotionStill(b)}"); continue; }
            lines.AddRange(DocumentDiff.TextLines(new JsonObject { ["type"] = "doc", ["content"] = new JsonArray(b.DeepClone()) }.ToJsonString()).Select(l => l.Text));
        }
        return lines;
    }

    /// <summary>
    /// An AI edit of a body, with what the model cannot write put back: every motion block of <paramref name="before"/> returns where the model
    /// left its <c>[[keep:N]]</c> line (or, if it dropped the line, at its old place), and a block's motion (rise, fade…) stays on the block of the
    /// same kind in the same order. Placeholder text never stays in the page. The page's style is kept by the save itself (see SaveSectionsAsync).
    /// </summary>
    public static string KeepBlocks(string? before, string after)
    {
        JsonObject? old = null;
        try { old = string.IsNullOrWhiteSpace(before) ? null : JsonNode.Parse(before) as JsonObject; } catch (JsonException) { }
        JsonObject next;
        try { if (JsonNode.Parse(after) is JsonObject parsed) next = parsed; else return after; } catch (JsonException) { return after; }
        var oldBlocks = (old?["content"] as JsonArray ?? []).OfType<JsonObject>().ToList();
        var embeds = oldBlocks.Select((b, i) => (Block: b, At: i)).Where(x => IsEmbed(x.Block)).ToList();
        var used = new bool[embeds.Count];
        var result = new List<JsonObject>();
        foreach (var b in (next["content"] as JsonArray ?? []).OfType<JsonObject>())
        {
            if (IsEmbed(b))
            {
                // Already there (an addition keeps the old blocks as they are).
                for (var k = 0; k < embeds.Count; k++) if (!used[k] && JsonNode.DeepEquals(embeds[k].Block, b)) { used[k] = true; break; }
                result.Add((JsonObject)b.DeepClone());
                continue;
            }
            var m = KeepMark.Match(PlainOf(b).Trim());
            if (TypeOf(b) == "paragraph" && m.Success && m.Index == 0)
            {
                var k = int.Parse(m.Groups[1].Value, System.Globalization.CultureInfo.InvariantCulture) - 1;
                if (k >= 0 && k < embeds.Count && !used[k]) { used[k] = true; result.Add((JsonObject)embeds[k].Block.DeepClone()); }
                continue;
            }
            var clean = (JsonObject)b.DeepClone();
            StripMarks(clean);
            result.Add(clean);
        }
        for (var k = 0; k < embeds.Count; k++)
            if (!used[k]) result.Insert(Math.Min(embeds[k].At, result.Count), (JsonObject)embeds[k].Block.DeepClone());

        // A block's own motion: the n-th paragraph (heading, list…) keeps the motion the n-th one had.
        foreach (var group in oldBlocks.Where(b => !IsEmbed(b)).GroupBy(TypeOf))
        {
            var mine = result.Where(b => !IsEmbed(b) && TypeOf(b) == group.Key).ToList();
            var i = 0;
            foreach (var ob in group)
            {
                if (i >= mine.Count) break;
                var target = mine[i++];
                if (ob["attrs"]?["motion"] is null || target["attrs"]?["motion"] is not null) continue;
                if (target["attrs"] is JsonObject attrs) CopyMotion(ob["attrs"], attrs);
                else { var fresh = new JsonObject(); CopyMotion(ob["attrs"], fresh); if (fresh.Count > 0) target["attrs"] = fresh; }
            }
        }
        next["content"] = new JsonArray(result.Select(b => (JsonNode)b).ToArray());
        return next.ToJsonString();
    }

    private static string PlainOf(JsonNode? n) => n switch
    {
        JsonObject o when TypeOf(o) == "text" => o["text"] is JsonValue v && v.TryGetValue<string>(out var t) ? t : "",
        JsonObject o => string.Concat((o["content"] as JsonArray ?? []).Select(PlainOf)),
        _ => "",
    };

    /// <summary>Takes stray <c>[[keep:N]]</c> marks out of the text (and text runs left empty).</summary>
    private static void StripMarks(JsonObject o)
    {
        if (o["content"] is not JsonArray kids) return;
        for (var i = kids.Count - 1; i >= 0; i--)
        {
            if (kids[i] is not JsonObject k) continue;
            if (TypeOf(k) == "text" && k["text"] is JsonValue v && v.TryGetValue<string>(out var t) && KeepMark.IsMatch(t))
            {
                var left = KeepMark.Replace(t, "");
                if (left.Trim().Length == 0) kids.RemoveAt(i); else k["text"] = left;
            }
            else StripMarks(k);
        }
    }
}

/// <summary>
/// The workspace's switches for page design (Library settings): custom CSS and interactive embeds, both on for editors by default. Kept as one small
/// platform setting per workspace ("doclib:{workspace}"), so there is nothing to migrate. Owners and admins change them; the change is audited.
/// </summary>
public class LibraryDesignService(IAppDbContext db, ICurrentContext ctx, AppClock clock, Recorder recorder)
{
    private static string Key(Guid tenantId) => $"doclib:{tenantId:N}";
    private (bool Css, bool Sandbox)? _cached;

    public async Task<(bool Css, bool Sandbox)> SwitchesAsync(CancellationToken ct = default)
    {
        if (_cached is { } c) return c;
        var tid = ctx.RequireTenantId();
        var key = Key(tid);
        var value = await db.PlatformSettings.AsNoTracking().Where(s => s.Key == key).Select(s => s.Value).FirstOrDefaultAsync(ct);
        var result = Parse(value);
        _cached = result;
        return result;
    }

    public static (bool Css, bool Sandbox) Parse(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return (true, true);
        try
        {
            var o = JsonNode.Parse(value) as JsonObject;
            return (o?["css"] is JsonValue a && a.TryGetValue<bool>(out var css) ? css : true, o?["sandbox"] is JsonValue b && b.TryGetValue<bool>(out var sb) ? sb : true);
        }
        catch (JsonException) { return (true, true); }
    }

    private bool CanManage => ctx.Role is TenantRole.Owner or TenantRole.Admin;

    public async Task<LibraryDesignDto> GetAsync(CancellationToken ct = default)
    {
        var (css, sandbox) = await SwitchesAsync(ct);
        return new LibraryDesignDto(css, sandbox, CanManage);
    }

    public async Task<LibraryDesignDto> SaveAsync(SaveLibraryDesignRequest req, CancellationToken ct = default)
    {
        if (!CanManage) throw new ForbiddenException("Only owners and admins can change page design settings.", "PERMISSION_DENIED");
        var tid = ctx.RequireTenantId();
        var key = Key(tid);
        var before = await SwitchesAsync(ct);
        var value = new JsonObject { ["css"] = req.CustomCss, ["sandbox"] = req.SandboxEmbeds }.ToJsonString();
        var row = await db.PlatformSettings.FirstOrDefaultAsync(s => s.Key == key, ct);
        if (row is null) db.PlatformSettings.Add(new PlatformSetting { Key = key, Value = value, CreatedAt = clock.Now, CreatedBy = ctx.UserId });
        else { row.Value = value; row.UpdatedAt = clock.Now; row.UpdatedBy = ctx.UserId; }
        recorder.Audit("document.design_settings_changed", "Workspace", tid, new { customCss = before.Css, sandboxEmbeds = before.Sandbox }, new { customCss = req.CustomCss, sandboxEmbeds = req.SandboxEmbeds });
        await db.SaveChangesAsync(ct);
        _cached = (req.CustomCss, req.SandboxEmbeds);
        return new LibraryDesignDto(req.CustomCss, req.SandboxEmbeds, true);
    }
}

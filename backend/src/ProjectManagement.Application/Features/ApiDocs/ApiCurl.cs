using System.Text;
using System.Text.RegularExpressions;
using ProjectManagement.Domain.Entities;

namespace ProjectManagement.Application.Features.ApiDocs;

/// <summary>
/// cURL commands pasted or uploaded as an import: each command becomes one endpoint (method, path, query, headers, body). Several commands can be
/// pasted together. Credentials never come along: the value of an authorization, cookie or key header, a -u login, and secret-looking query values are
/// dropped and the person is told, so a token pasted from a terminal does not end up in a document.
/// </summary>
public static partial class ApiCurl
{
    private static readonly HashSet<string> Verbs = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "TRACE"];
    private static readonly HashSet<string> SecretHeaders = new(StringComparer.OrdinalIgnoreCase) { "authorization", "proxy-authorization", "cookie", "x-api-key", "api-key", "apikey", "x-auth-token", "x-access-token", "x-csrf-token", "x-xsrf-token" };
    // flags that take a value we do not use
    private static readonly HashSet<string> SkipsValue = new(StringComparer.Ordinal) { "-o", "--output", "-A", "--user-agent", "-e", "--referer", "-b", "--cookie", "-c", "--cookie-jar", "-m", "--max-time", "--connect-timeout", "-w", "--write-out", "-x", "--proxy", "--cacert", "--cert", "--key", "-E", "--retry", "-T", "--upload-file", "--resolve", "--interface", "-K", "--config", "--proxy-user", "-U", "-Y", "-y", "--limit-rate", "--max-redirs", "--http-version", "--tlsv1.2", "--oauth2-bearer", "--aws-sigv4" };

    [GeneratedRegex(@"^\s*curl(\.exe)?\s", RegexOptions.IgnoreCase)] private static partial Regex Starts();
    [GeneratedRegex(@"^(\$\{?\w+\}?)")] private static partial Regex ShellVar();
    [GeneratedRegex(@"^(https?://[^/?#]+)", RegexOptions.IgnoreCase)] private static partial Regex Origin();
    [GeneratedRegex(@"token|secret|password|passwd|api[_-]?key|apikey|auth|signature|sig$", RegexOptions.IgnoreCase)] private static partial Regex SecretName();

    public static bool Looks(string text)
    {
        foreach (var raw in text.Split('\n'))
        {
            var l = raw.Trim();
            if (l.Length == 0 || l.StartsWith('#')) continue;
            return Starts().IsMatch(l + " ");   // the first real line decides
        }
        return false;
    }

    public static ParseResult Import(string text, string fallbackName)
    {
        var issues = new List<ImportIssue>();
        var endpoints = new List<ImportedEndpoint>(); var servers = new List<string>(); var seen = new HashSet<string>();
        var droppedSecret = false;
        foreach (var (line, command) in Split(text))
        {
            if (endpoints.Count >= ApiOpenApi.MaxEndpoints) { issues.Add(new ImportIssue("error", line, null, null, $"A file can describe at most {ApiOpenApi.MaxEndpoints:N0} endpoints; the rest were skipped.")); break; }
            try
            {
                var t = Tokens(command);
                string? method = null, url = null, body = null; var get = false; var head = false;
                var headers = new List<(string Name, string Value)>(); var bodies = new List<string>(); var json = false; var form = false;
                for (var i = 1; i < t.Count; i++)
                {
                    var a = t[i];
                    string? Next() => i + 1 < t.Count ? t[++i] : null;
                    string? Val(string longName, string shortName)   // --flag value, --flag=value, -Xvalue
                    {
                        if (a == longName || a == shortName) return Next();
                        if (a.StartsWith(longName + "=", StringComparison.Ordinal)) return a[(longName.Length + 1)..];
                        if (shortName.Length == 2 && a.StartsWith(shortName, StringComparison.Ordinal) && !a.StartsWith("--", StringComparison.Ordinal) && a.Length > 2) return a[2..];
                        return null;
                    }
                    if (a is "-G" or "--get") { get = true; continue; }
                    if (a is "-I" or "--head") { head = true; continue; }
                    if (a == "--url") { url = Next(); continue; }
                    if (Val("--request", "-X") is { } m) { method = m.ToUpperInvariant(); continue; }
                    if (Val("--header", "-H") is { } h) { var c = h.IndexOf(':'); if (c > 0) headers.Add((h[..c].Trim(), h[(c + 1)..].Trim())); continue; }
                    if (a.StartsWith("--json", StringComparison.Ordinal) && Val("--json", "--json") is { } j) { bodies.Add(j); json = true; continue; }
                    if (Val("--data-raw", "--data-raw") is { } dr) { bodies.Add(dr); continue; }
                    if (Val("--data-binary", "--data-binary") is { } db) { bodies.Add(db); continue; }
                    if (Val("--data-urlencode", "--data-urlencode") is { } du) { bodies.Add(du); form = true; continue; }
                    if (Val("--data-ascii", "--data-ascii") is { } da) { bodies.Add(da); continue; }
                    if (Val("--data", "-d") is { } d) { bodies.Add(d); continue; }
                    if (Val("--form", "-F") is { }) { form = true; issues.Add(new ImportIssue("warning", line, null, null, "A multipart form (-F) is noted as a form; list its fields by hand.")); continue; }
                    if (Val("--user", "-u") is { }) { droppedSecret = true; continue; }
                    if (SkipsValue.Contains(a)) { i++; continue; }
                    if (a.StartsWith('-')) continue;   // a switch with no value (-s, -k, -L, -i, -v, --compressed ...)
                    url ??= a;
                }
                if (string.IsNullOrWhiteSpace(url)) { issues.Add(new ImportIssue("warning", line, null, null, "A cURL command without an address was skipped.")); continue; }
                if (bodies.Count > 0 && !get) body = string.Join('&', bodies);
                method ??= head ? "HEAD" : body is not null ? "POST" : "GET";
                if (!Verbs.Contains(method)) { issues.Add(new ImportIssue("warning", line, null, null, $"The method {method} is not supported; skipped.")); continue; }

                url = ShellVar().Replace(url.Trim(), "");
                var origin = Origin().Match(url) is { Success: true } om ? om.Value : null;
                if (origin is not null && !servers.Contains(origin)) servers.Add(origin);
                var rest = origin is null ? url : url[origin.Length..];
                var hash = rest.IndexOf('#'); if (hash >= 0) rest = rest[..hash];
                var qs = ""; var qi = rest.IndexOf('?'); if (qi >= 0) { qs = rest[(qi + 1)..]; rest = rest[..qi]; }
                if (get && bodies.Count > 0) qs = qs.Length == 0 ? string.Join('&', bodies) : qs + "&" + string.Join('&', bodies);
                var path = ApiJson.NormalizePath(rest.Length == 0 ? "/" : rest);
                if (!seen.Add($"{method} {path}")) { issues.Add(new ImportIssue("warning", line, null, null, $"{method} {path} appears twice; the first one is kept.")); continue; }

                var details = new EndpointDetails();
                foreach (var pair in qs.Split('&', StringSplitOptions.RemoveEmptyEntries))
                {
                    var eq = pair.IndexOf('='); var name = Uri.UnescapeDataString((eq < 0 ? pair : pair[..eq]).Replace('+', ' ')); var value = eq < 0 ? null : Uri.UnescapeDataString(pair[(eq + 1)..].Replace('+', ' '));
                    if (name.Length == 0) continue;
                    if (value is not null && SecretName().IsMatch(name)) { value = null; droppedSecret = true; }
                    details.Parameters.Add(new ApiParam(name, "query", false, "string", null, value, null));
                }
                foreach (Match pm in PathParam().Matches(path)) details.Parameters.Add(new ApiParam(pm.Groups[1].Value, "path", true, "string", null, null, null));
                string? contentType = null;
                foreach (var (hn, hv) in headers)
                {
                    if (hn.Equals("content-type", StringComparison.OrdinalIgnoreCase)) { contentType = hv.Split(';')[0].Trim(); continue; }
                    if (hn.Equals("accept", StringComparison.OrdinalIgnoreCase) || hn.Equals("user-agent", StringComparison.OrdinalIgnoreCase)) continue;
                    var secret = SecretHeaders.Contains(hn);
                    if (secret) droppedSecret = true;
                    details.Parameters.Add(new ApiParam(hn, "header", secret, "string", null, secret ? null : hv, null));
                }
                if (body is not null)
                {
                    var trimmed = body.TrimStart();
                    contentType ??= json || trimmed.StartsWith('{') || trimmed.StartsWith('[') ? "application/json" : form || body.Contains('=') ? "application/x-www-form-urlencoded" : "text/plain";
                    details.RequestBody = new ApiBody(contentType, true, null, null, body.Length > ApiJson.MaxExampleChars ? body[..ApiJson.MaxExampleChars] : body);
                }
                details = ApiJson.Clean(details);
                endpoints.Add(new ImportedEndpoint(method, path, $"{method} {path}".Length > 300 ? $"{method} {path}"[..300] : $"{method} {path}", null, false, details));
            }
            catch (Exception e) when (e is not OutOfMemoryException) { issues.Add(new ImportIssue("error", line, null, null, $"A command was skipped ({e.Message})")); }
        }
        if (endpoints.Count == 0) { issues.Add(new ImportIssue("error", null, null, null, "No cURL command with an address was found.")); return new ParseResult(null, issues); }
        if (droppedSecret) issues.Add(new ImportIssue("warning", null, null, null, "Credentials (authorization, cookies, keys, logins) were left out. Check the body examples for secrets before you publish."));
        var host = servers.Count > 0 ? new Uri(servers[0]).Host : null;
        var title = host is null ? fallbackName : $"{host} API"; if (title.Length > 80) title = title[..80];
        return new ParseResult(new ImportedApi(title, null, null, ApiAuthScheme.None, servers.Take(20).ToList(), endpoints), issues);
    }

    [GeneratedRegex(@"\{([^{}/]+)\}")] private static partial Regex PathParam();

    /// <summary>One command per "curl" line group; a trailing backslash (or ^ on Windows) continues the command on the next line.</summary>
    private static IEnumerable<(int Line, string Command)> Split(string text)
    {
        var sb = new StringBuilder(); var start = 0; var n = 0;
        foreach (var raw in text.Replace("\r\n", "\n").Split('\n'))
        {
            n++;
            var line = raw.TrimEnd();
            if (sb.Length == 0 && !Starts().IsMatch(line + " ")) continue;   // comments, prompts, blank lines between commands
            if (sb.Length == 0) start = n;
            var cont = line.EndsWith('\\') || line.EndsWith('^');
            sb.Append(cont ? line[..^1] : line).Append(' ');
            if (!cont) { yield return (start, sb.ToString()); sb.Clear(); }
        }
        if (sb.Length > 0) yield return (start, sb.ToString());
    }

    /// <summary>Shell-style words: single quotes literal, double quotes with backslash escapes, $'...' with C escapes.</summary>
    private static List<string> Tokens(string s)
    {
        var res = new List<string>(); var cur = new StringBuilder(); var has = false;
        for (var i = 0; i < s.Length; i++)
        {
            var c = s[i];
            if (c == '\'' ) { has = true; i++; while (i < s.Length && s[i] != '\'') cur.Append(s[i++]); }
            else if (c == '$' && i + 1 < s.Length && s[i + 1] == '\'')
            {
                has = true; i += 2;
                while (i < s.Length && s[i] != '\'')
                {
                    if (s[i] == '\\' && i + 1 < s.Length) { i++; cur.Append(s[i] switch { 'n' => '\n', 't' => '\t', 'r' => '\r', _ => s[i] }); } else cur.Append(s[i]);
                    i++;
                }
            }
            else if (c == '"')
            {
                has = true; i++;
                while (i < s.Length && s[i] != '"') { if (s[i] == '\\' && i + 1 < s.Length && s[i + 1] is '"' or '\\' or '$' or '`') i++; cur.Append(s[i++]); }
            }
            else if (c == '\\' && i + 1 < s.Length) { has = true; cur.Append(s[++i]); }
            else if (char.IsWhiteSpace(c)) { if (has) { res.Add(cur.ToString()); cur.Clear(); has = false; } }
            else { has = true; cur.Append(c); }
        }
        if (has) res.Add(cur.ToString());
        return res;
    }
}

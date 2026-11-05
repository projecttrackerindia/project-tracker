using System.Text.Json.Nodes;
using ProjectManagement.Api.Logging;

namespace ProjectManagement.Tests;

/// <summary>The Sentry-compatible error reporter: DSN parsing, personal-data scrubbing, release tagging and "off when no DSN".</summary>
public class ErrorReporterTests
{
    private sealed class Capture : HttpMessageHandler
    {
        public readonly List<(Uri Uri, string Auth, string Body)> Sent = [];
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            Sent.Add((request.RequestUri!, request.Headers.TryGetValues("X-Sentry-Auth", out var a) ? string.Join("", a) : "",
                await request.Content!.ReadAsStringAsync(ct)));
            return new HttpResponseMessage(System.Net.HttpStatusCode.OK);
        }
    }

    [Theory]
    [InlineData("https://abc123@o1.ingest.sentry.io/42", "https://o1.ingest.sentry.io/api/42/envelope/", "abc123")]
    [InlineData("https://key:secret@errors.example.com:8443/glitch/7", "https://errors.example.com:8443/glitch/api/7/envelope/", "key")]
    public void Parses_sentry_style_dsns(string dsn, string envelope, string key)
    {
        var d = ErrorDsn.Parse(dsn)!;
        Assert.Equal(envelope, d.EnvelopeUri.ToString());
        Assert.Equal(key, d.PublicKey);
    }

    [Theory]
    [InlineData("")]
    [InlineData(null)]
    [InlineData("not a url")]
    [InlineData("https://o1.ingest.sentry.io/42")]
    [InlineData("ftp://k@host/1")]
    public void Bad_or_missing_dsn_means_off(string? dsn)
    {
        Assert.Null(ErrorDsn.Parse(dsn));
        Assert.False(new ErrorReporter(dsn, "abc", "production").Enabled);
    }

    [Fact]
    public void Scrubs_personal_data_and_secrets()
    {
        var s = ErrorScrubber.Scrub("User asha.k@example.com phone +91 98765 43210 password=hunter2 Bearer abcdefghijklmnop key pmk_live_1234567890 jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig");
        Assert.DoesNotContain("asha", s);
        Assert.DoesNotContain("98765", s);
        Assert.DoesNotContain("hunter2", s);
        Assert.DoesNotContain("abcdefghijklmnop", s);
        Assert.DoesNotContain("pmk_live", s);
        Assert.DoesNotContain("eyJhbGci", s);
        Assert.Contains("[email]", s);
        Assert.Equal("/api/v1/tasks/1b4e28ba-2fa1-11d2-883f-0016d3cca427", ErrorScrubber.ScrubPath("/api/v1/tasks/1b4e28ba-2fa1-11d2-883f-0016d3cca427?email=a@b.co"));
    }

    [Fact]
    public async Task Sends_an_envelope_with_release_environment_and_no_personal_data()
    {
        var handler = new Capture();
        var r = new ErrorReporter("https://pub@errors.example.com/9", "1a2b3c4", "Staging", handler);
        Exception ex;
        try { throw new InvalidOperationException("Could not save for ravi@example.com", new TimeoutException("db")); }
        catch (Exception e) { ex = e; }
        Assert.True(await r.CaptureAndSendAsync(ex, "Unhandled exception for POST /api/v1/tasks",
            new Dictionary<string, string?> { ["path"] = "/api/v1/tasks?token=abc", ["method"] = "POST" }));

        var (uri, auth, body) = Assert.Single(handler.Sent);
        Assert.Equal("https://errors.example.com/api/9/envelope/", uri.ToString());
        Assert.Contains("sentry_key=pub", auth);
        var lines = body.Split('\n', StringSplitOptions.RemoveEmptyEntries);
        Assert.Equal(3, lines.Length);
        Assert.Equal("event", JsonNode.Parse(lines[1])!["type"]!.GetValue<string>());
        var ev = JsonNode.Parse(lines[2])!;
        Assert.Equal("1a2b3c4", ev["release"]!.GetValue<string>());
        Assert.Equal("staging", ev["environment"]!.GetValue<string>());
        Assert.Equal("/api/v1/tasks", ev["tags"]!["path"]!.GetValue<string>());
        var values = ev["exception"]!["values"]!.AsArray();
        Assert.Equal(2, values.Count);
        Assert.Equal("System.InvalidOperationException", values[1]!["type"]!.GetValue<string>());   // outermost last
        Assert.DoesNotContain("ravi@", body);
        Assert.Null(ev["user"]);
        Assert.Null(ev["request"]);
    }

    [Fact]
    public async Task Rate_limits_and_stays_quiet_when_off()
    {
        var off = new ErrorReporter(null, null, null, new Capture());
        Assert.Null(off.Capture(new Exception("x"), "x"));
        Assert.False(await off.CaptureAndSendAsync(new Exception("x"), "x"));

        var handler = new Capture();
        var r = new ErrorReporter("https://pub@errors.example.com/9", null, null, handler);
        var ok = 0;
        for (var i = 0; i < ErrorReporter.PerMinute + 5; i++) if (await r.CaptureAndSendAsync(null, "boom " + i)) ok++;
        Assert.Equal(ErrorReporter.PerMinute, ok);
        Assert.Equal("dev", r.Release);
    }
}

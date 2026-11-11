using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Auth;
using ProjectManagement.Application.Features.Projects;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Platform;

/// <param name="Console">The last console errors the app saw (newest last).</param>
/// <param name="Network">The last failed requests (method, path, status), newest last.</param>
/// <param name="Screenshot">A PNG or JPEG data URL of the screen, or null when the person left it out.</param>
public record ProblemReportRequest(string? Message, string? Route, string? AppVersion, IReadOnlyList<string>? Console = null, IReadOnlyList<string>? Network = null,
    string? Screenshot = null, string? UserAgent = null);
public record ProblemReportReceipt(Guid Id, string Reference, bool Emailed);
public record ProblemReportDto(Guid Id, string Reference, UserRefDto? Reporter, string Message, string Route, string AppVersion, string? UserAgent,
    IReadOnlyList<string> Console, IReadOnlyList<string> Network, bool HasScreenshot, string Status, DateTime CreatedAt);

/// <summary>
/// "Report a problem": the person's words with the route, app version, device, the last console errors and failed requests, and (if they kept
/// it) a screenshot. Kept in the workspace (the screenshot in file storage under the workspace's own prefix), e-mailed to support, and
/// listed for the workspace's owners and admins. Secrets that slip into logs (tokens, passwords, keys) are masked before anything is kept.
/// </summary>
public partial class ProblemReportService(IAppDbContext db, ICurrentContext ctx, AppClock clock, IFileStorage storage, IEmailSender email, IConfiguration config,
    ILogger<ProblemReportService> log)
{
    public const int MaxScreenshotBytes = 4 * 1024 * 1024, MaxLines = 50, MaxLine = 500, PerHour = 10;

    [GeneratedRegex(@"(?i)(bearer\s+)[A-Za-z0-9\-._~+/]+=*|((?:token|password|passwd|secret|api[_-]?key|authorization)[""']?\s*[:=]\s*[""']?)(?!bearer\b)[^\s&""',;]+", RegexOptions.CultureInvariant)]
    private static partial Regex SecretPattern();

    /// <summary>Masks bearer tokens and key=value secrets.</summary>
    public static string Scrub(string text) => SecretPattern().Replace(text, m => m.Groups[1].Success ? $"{m.Groups[1].Value}•••" : $"{m.Groups[2].Value}•••");

    public static string ReferenceOf(Guid id) => $"PR-{id.ToString("N")[^6..].ToUpperInvariant()}";

    private static List<string> Tail(IReadOnlyList<string>? lines) =>
        (lines ?? []).Where(l => !string.IsNullOrWhiteSpace(l)).TakeLast(MaxLines).Select(l => Scrub(Text.Truncate(l.Trim(), MaxLine)!)).ToList();

    public async Task<ProblemReportReceipt> SubmitAsync(ProblemReportRequest req, CancellationToken ct = default)
    {
        var uid = ctx.RequireUserId();
        var tid = ctx.RequireTenantId();
        var message = (req.Message ?? "").Trim();
        if (message.Length == 0) throw new ValidationException("message", "Say what went wrong.");
        if (message.Length > 4000) throw new ValidationException("message", "Keep it under 4000 characters.");
        var now = clock.Now;
        if (await db.ProblemReports.CountAsync(r => r.UserId == uid && r.CreatedAt >= now.AddHours(-1), ct) >= PerHour)
            throw new AppException(429, "TOO_MANY_REPORTS", "Thanks, we have your reports. Try again in a little while.");

        byte[]? shot = null; string? ext = null;
        if (!string.IsNullOrEmpty(req.Screenshot))
        {
            var m = Regex.Match(req.Screenshot, @"^data:image/(png|jpeg);base64,(.+)$", RegexOptions.Singleline);
            if (!m.Success) throw new ValidationException("screenshot", "The screenshot must be a PNG or JPEG image.");
            try { shot = Convert.FromBase64String(m.Groups[2].Value); }
            catch (FormatException) { throw new ValidationException("screenshot", "The screenshot could not be read."); }
            if (shot.Length > MaxScreenshotBytes) throw new ValidationException("screenshot", "The screenshot is too large.");
            var png = shot.Length > 8 && shot[0] == 0x89 && shot[1] == 0x50 && shot[2] == 0x4E && shot[3] == 0x47;
            var jpg = shot.Length > 3 && shot[0] == 0xFF && shot[1] == 0xD8 && shot[2] == 0xFF;
            if (!png && !jpg) throw new ValidationException("screenshot", "The screenshot must be a PNG or JPEG image.");
            ext = png ? "png" : "jpg";
        }

        var console = Tail(req.Console);
        var network = Tail(req.Network);
        var row = new ProblemReport
        {
            TenantId = tid, UserId = uid, CreatedAt = now, CreatedBy = uid, Message = Scrub(message),
            Route = Scrub(Text.Truncate((req.Route ?? "").Trim(), 500)!), AppVersion = Text.Truncate((req.AppVersion ?? "").Trim(), 64)!,
            UserAgent = Text.Truncate(req.UserAgent?.Trim(), 500), ConsoleTail = JsonSerializer.Serialize(console), NetworkTail = JsonSerializer.Serialize(network),
        };
        if (shot is not null)
        {
            row.ScreenshotKey = $"{tid:N}/problem-reports/{row.Id:N}.{ext}";
            using var ms = new MemoryStream(shot);
            await storage.SaveAsync(row.ScreenshotKey, ms, ct);
        }
        db.ProblemReports.Add(row);
        await db.SaveChangesAsync(ct);

        var emailed = await EmailSupportAsync(row, console, network, ct);
        if (emailed) { row.EmailedAt = clock.Now; await db.SaveChangesAsync(ct); }
        return new ProblemReportReceipt(row.Id, ReferenceOf(row.Id), emailed);
    }

    private async Task<bool> EmailSupportAsync(ProblemReport r, List<string> console, List<string> network, CancellationToken ct)
    {
        try
        {
            var who = await db.Users.AsNoTracking().Where(u => u.Id == r.UserId).Select(u => new { u.DisplayName, u.Email }).FirstOrDefaultAsync(ct);
            var workspace = await db.Tenants.AsNoTracking().Where(t => t.Id == r.TenantId).Select(t => t.Name).FirstOrDefaultAsync(ct);
            var support = config["App:SupportEmail"] is { Length: > 3 } s && s.Contains('@') ? s.Trim() : EmailTemplates.SupportEmail;
            var reference = ReferenceOf(r.Id);
            var text = $"{who?.DisplayName} ({who?.Email}) in {workspace} reported a problem ({reference}).\n\n{r.Message}\n\nRoute: {r.Route}\nVersion: {r.AppVersion}\nDevice: {r.UserAgent}\n" +
                $"Screenshot: {(r.ScreenshotKey is null ? "not included" : "kept with the report")}\n\nConsole:\n{string.Join("\n", console)}\n\nFailed requests:\n{string.Join("\n", network)}";
            var html = EmailTemplates.Wrap($"Problem report {reference}", "Hello,", text, "Open the report", "/settings/general/problem-reports");
            await email.SendAsync(new EmailMessage(support, $"Problem report {reference}: {Text.Truncate(r.Message, 60)}", html, text, "support", ReplyTo: who?.Email), ct);
            return true;
        }
        catch (Exception ex) when (ex is not OperationCanceledException) { log.LogWarning(ex, "Problem report e-mail could not be sent"); return false; }
    }

    private bool IsAdmin => ctx.Role is TenantRole.Owner or TenantRole.Admin;

    /// <summary>The workspace's reports, newest first (owners and admins).</summary>
    public async Task<IReadOnlyList<ProblemReportDto>> ListAsync(CancellationToken ct = default)
    {
        if (!IsAdmin) throw new ForbiddenException("Only owners and admins can see problem reports.", "PERMISSION_DENIED");
        var rows = await db.ProblemReports.AsNoTracking().OrderByDescending(r => r.CreatedAt).Take(100).ToListAsync(ct);
        var ids = rows.Select(r => r.UserId).Distinct().ToList();
        var names = await db.Users.AsNoTracking().Where(u => ids.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);
        return rows.Select(r => new ProblemReportDto(r.Id, ReferenceOf(r.Id), new UserRefDto(r.UserId, names.GetValueOrDefault(r.UserId, "Someone")), r.Message, r.Route, r.AppVersion,
            r.UserAgent, Lines(r.ConsoleTail), Lines(r.NetworkTail), r.ScreenshotKey != null, r.Status, r.CreatedAt)).ToList();
    }

    public async Task<(Stream Content, string ContentType)> ScreenshotAsync(Guid id, CancellationToken ct = default)
    {
        if (!IsAdmin) throw new ForbiddenException("Only owners and admins can see problem reports.", "PERMISSION_DENIED");
        var key = await db.ProblemReports.AsNoTracking().Where(r => r.Id == id).Select(r => r.ScreenshotKey).FirstOrDefaultAsync(ct);
        if (key is null || !key.StartsWith($"{ctx.RequireTenantId():N}/", StringComparison.Ordinal)) throw new NotFoundException("Screenshot not found.");
        var stream = await storage.OpenReadAsync(key, ct) ?? throw new NotFoundException("Screenshot not found.");
        return (stream, key.EndsWith(".png", StringComparison.Ordinal) ? "image/png" : "image/jpeg");
    }

    public async Task SetStatusAsync(Guid id, string status, CancellationToken ct = default)
    {
        if (!IsAdmin) throw new ForbiddenException("Only owners and admins can change problem reports.", "PERMISSION_DENIED");
        var s = (status ?? "").Trim().ToLowerInvariant();
        if (s != "open" && s != "closed") throw new ValidationException("status", "Status is open or closed.");
        var row = await db.ProblemReports.FirstOrDefaultAsync(r => r.Id == id, ct) ?? throw new NotFoundException("Report not found.");
        row.Status = s; row.UpdatedAt = clock.Now; row.UpdatedBy = ctx.UserId;
        await db.SaveChangesAsync(ct);
    }

    private static IReadOnlyList<string> Lines(string json)
    {
        try { return JsonSerializer.Deserialize<List<string>>(json) ?? []; }
        catch (JsonException) { return []; }
    }
}

using System.Security.Cryptography;
using System.Text;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Sso;
using ProjectManagement.Application.Features.WorkItems;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Integrations;

/// <summary><see cref="Url"/> is the private address to paste into Outlook, Google Calendar or Apple Calendar (null when not set up).</summary>
public record CalendarFeedDto(bool Enabled, string? Url, DateTime? CreatedAt, DateTime? LastUsedAt);

/// <summary>
/// A private calendar subscription per person and workspace: an iCalendar (.ics) feed of the work assigned to them that has a due date -
/// project tasks, test issues, action items and operational work - as all-day events. Calendar apps fetch it by URL every few hours, so
/// due dates follow changes without anyone exporting anything. The token in the URL is the only key: keep it private, reset it if shared.
/// </summary>
public class CalendarFeedService(IAppDbContext db, ICurrentContext ctx, AppClock clock, Recorder recorder, ISecretProtector protector, IOptions<AppOptions> app)
{
    private const int PastDays = 60;
    private const int FutureDays = 400;

    public static string Hash(string token) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(token)));
    private string UrlOf(string token) => $"{PublicUrls.Api(app.Value)}/api/v1/calendar/feed/{token}.ics";

    public async Task<CalendarFeedDto> GetAsync(CancellationToken ct = default)
    {
        var uid = ctx.RequireUserId(); ctx.RequireTenantId();
        var feed = await db.CalendarFeeds.AsNoTracking().FirstOrDefaultAsync(f => f.UserId == uid, ct);
        return feed is null ? new CalendarFeedDto(false, null, null, null) : new CalendarFeedDto(true, UrlOf(protector.Unprotect(feed.TokenProtected)), feed.CreatedAt, feed.LastUsedAt);
    }

    /// <summary>Creates the feed, or gives it a new address (the old one stops working at once).</summary>
    public async Task<CalendarFeedDto> ResetAsync(CancellationToken ct = default)
    {
        var uid = ctx.RequireUserId(); var tid = ctx.RequireTenantId();
        var token = "cal_" + Convert.ToBase64String(RandomNumberGenerator.GetBytes(24)).Replace('+', 'a').Replace('/', 'b').TrimEnd('=');
        var feed = await db.CalendarFeeds.FirstOrDefaultAsync(f => f.UserId == uid, ct);
        if (feed is null) { feed = new CalendarFeed { TenantId = tid, UserId = uid, CreatedAt = clock.Now, CreatedBy = uid }; db.CalendarFeeds.Add(feed); }
        else { feed.CreatedAt = clock.Now; feed.LastUsedAt = null; }
        feed.TokenHash = Hash(token); feed.TokenProtected = protector.Protect(token); feed.Prefix = token[..8];
        recorder.Audit("calendar_feed.reset", "CalendarFeed", feed.Id);
        await db.SaveChangesAsync(ct);
        return new CalendarFeedDto(true, UrlOf(token), feed.CreatedAt, null);
    }

    public async Task DeleteAsync(CancellationToken ct = default)
    {
        var uid = ctx.RequireUserId(); ctx.RequireTenantId();
        var feed = await db.CalendarFeeds.FirstOrDefaultAsync(f => f.UserId == uid, ct);
        if (feed is null) return;
        db.CalendarFeeds.Remove(feed);
        recorder.Audit("calendar_feed.removed", "CalendarFeed", feed.Id);
        await db.SaveChangesAsync(ct);
    }

    /// <summary>
    /// The feed itself, for an anonymous request carrying the token. It is built as the feed's owner, with the access they have now: someone
    /// who left the workspace, or was disabled, gets nothing.
    /// </summary>
    public static async Task<string?> RenderAsync(IServiceProvider sp, string token, CancellationToken ct)
    {
        var db = sp.GetRequiredService<IAppDbContext>();
        var hash = Hash(token);
        var feed = await db.CalendarFeeds.IgnoreQueryFilters().FirstOrDefaultAsync(f => f.TokenHash == hash, ct);
        if (feed is null) return null;
        var member = await db.TenantMembers.IgnoreQueryFilters().AsNoTracking().FirstOrDefaultAsync(m => m.TenantId == feed.TenantId && m.UserId == feed.UserId, ct);
        var user = await db.Users.AsNoTracking().FirstOrDefaultAsync(u => u.Id == feed.UserId, ct);
        var tenant = await db.Tenants.AsNoTracking().FirstOrDefaultAsync(t => t.Id == feed.TenantId, ct);
        if (member is null || user is null || !user.IsActive || tenant is null || tenant.Status != TenantStatus.Active) return null;

        var cc = sp.GetRequiredService<CurrentContext>();
        cc.UserId = feed.UserId; cc.TenantId = feed.TenantId; cc.Role = member.Role; cc.WorkspaceType = tenant.Type; cc.IsPlatformAdmin = false;
        var clock = sp.GetRequiredService<AppClock>();
        var today = clock.Today;
        var items = await sp.GetRequiredService<WorkItemService>().ListAsync(
            new WorkItemQuery(Mine: true, OpenOnly: false, DueFrom: today.AddDays(-PastDays), DueTo: today.AddDays(FutureDays), Limit: 1000), WorkItemScope.Caller, ct);

        var web = PublicUrls.Web(sp.GetRequiredService<IOptions<AppOptions>>().Value);
        var now = clock.Now;
        var sb = new StringBuilder();
        void Line(string s)
        {
            // RFC 5545: lines of at most 75 octets, continued with a space.
            var bytes = Encoding.UTF8.GetBytes(s);
            if (bytes.Length <= 75) { sb.Append(s).Append("\r\n"); return; }
            var chunk = new StringBuilder();
            var first = true;
            foreach (var ch in s)
            {
                var limit = first ? 75 : 74;
                if (Encoding.UTF8.GetByteCount(chunk.ToString() + ch) > limit) { sb.Append(first ? "" : " ").Append(chunk).Append("\r\n"); chunk.Clear(); first = false; }
                chunk.Append(ch);
            }
            sb.Append(first ? "" : " ").Append(chunk).Append("\r\n");
        }
        static string Esc(string s) => s.Replace("\\", "\\\\").Replace(";", "\\;").Replace(",", "\\,").Replace("\r", "").Replace("\n", "\\n");

        Line("BEGIN:VCALENDAR");
        Line("VERSION:2.0");
        Line("PRODID:-//Project Tracker//Work calendar//EN");
        Line("CALSCALE:GREGORIAN");
        Line("METHOD:PUBLISH");
        Line($"X-WR-CALNAME:{Esc($"{tenant.Name} · my work")}");
        Line("X-PUBLISHED-TTL:PT1H");
        Line("REFRESH-INTERVAL;VALUE=DURATION:PT1H");
        foreach (var i in items.Where(i => i.DueDate is not null))
        {
            var due = i.DueDate!.Value;
            var done = i.Category is StatusCategory.Done or StatusCategory.Cancelled;
            var link = i.Kind switch
            {
                WorkItemKind.Task => $"{web}/projects/{i.ProjectId}?task={i.Id}",
                WorkItemKind.Issue => $"{web}/projects/{i.ProjectId}?tab=issues&issue={i.Id}",
                WorkItemKind.ActionItem => $"{web}/projects/{i.ProjectId}?tab=actions&action={i.Id}",
                _ => $"{web}/operations?task={i.Id}",
            };
            Line("BEGIN:VEVENT");
            Line($"UID:{i.Kind.ToString().ToLowerInvariant()}-{i.Id:N}@projecttracker");
            Line($"DTSTAMP:{now:yyyyMMdd'T'HHmmss'Z'}");
            Line($"DTSTART;VALUE=DATE:{due:yyyyMMdd}");
            Line($"DTEND;VALUE=DATE:{due.AddDays(1):yyyyMMdd}");
            Line($"SUMMARY:{Esc($"{(done ? "✓ " : "")}{i.Key} {i.Title}")}");
            Line($"DESCRIPTION:{Esc($"{i.Status} · {i.Priority} priority{(i.ProjectName is null ? "" : $" · {i.ProjectName}")}\n{link}")}");
            Line($"URL:{link}");
            Line($"CATEGORIES:{Esc(i.Kind == WorkItemKind.Operational ? "Operational work" : i.Kind.ToString())}");
            Line("TRANSP:TRANSPARENT");
            if (i.Category == StatusCategory.Cancelled) Line("STATUS:CANCELLED");
            Line("END:VEVENT");
        }
        Line("END:VCALENDAR");

        // Remember when the calendar app last fetched it (at most once an hour, to keep it cheap).
        if (feed.LastUsedAt is null || feed.LastUsedAt < now.AddHours(-1))
            await db.CalendarFeeds.IgnoreQueryFilters().Where(f => f.Id == feed.Id).ExecuteUpdateAsync(s => s.SetProperty(f => f.LastUsedAt, now), ct);
        return sb.ToString();
    }
}

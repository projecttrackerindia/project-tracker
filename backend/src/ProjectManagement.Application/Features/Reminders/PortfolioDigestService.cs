using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Features.Ai;
using ProjectManagement.Application.Features.Notifications;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Reminders;

/// <summary>
/// Every Monday morning (the person's own time, after their briefing time) the owners and admins of each organization get a short notice
/// of how the portfolio stands: which projects need attention and why. It is worked out by the same rules as the Portfolio page, as that
/// person (an owner or admin reaches every project of their organization, so nothing in it is outside their view), one notice per
/// person per week, and it follows each person's notification settings (in-app and e-mail by default, switch-off-able).
/// </summary>
public class PortfolioDigestService(IAppDbContext db, IServiceScopeFactory scopes, NotificationRouter router)
{
    private static long _last;

    public async Task<int> SendAsync(DateTime now, bool force = false, CancellationToken ct = default)
    {
        if (!force && now.Ticks - Interlocked.Read(ref _last) < TimeSpan.FromMinutes(5).Ticks) return 0;
        Interlocked.Exchange(ref _last, now.Ticks);

        var people = await (from m in db.TenantMembers.IgnoreQueryFilters().AsNoTracking()
                            join t in db.Tenants.IgnoreQueryFilters().AsNoTracking() on m.TenantId equals t.Id
                            join u in db.Users.IgnoreQueryFilters().AsNoTracking() on m.UserId equals u.Id
                            where (m.Role == TenantRole.Owner || m.Role == TenantRole.Admin) && !t.IsDeleted && t.Status == TenantStatus.Active
                                  && t.Type == WorkspaceType.Organization && u.IsActive && !u.IsPlatformAdmin
                            select new { m.TenantId, m.UserId, m.Role, u.TimeZone }).ToListAsync(ct);
        if (people.Count == 0) return 0;
        var settings = await db.ReminderSettings.AsNoTracking().Where(s => people.Select(p => p.UserId).Contains(s.UserId)).ToDictionaryAsync(s => s.UserId, ct);

        var sent = 0;
        foreach (var p in people)
        {
            var s = settings.GetValueOrDefault(p.UserId);
            if (s is { BriefingEnabled: false }) continue;
            var local = ZoneTime.ToLocal(now, ZoneTime.Find(p.TimeZone));
            if (local.DayOfWeek != DayOfWeek.Monday) continue;
            var at = TimeOnly.FromDateTime(local);
            var from = s?.BriefingTime ?? new ReminderSettings().BriefingTime;
            if (at < from || at > from.AddHours(3)) continue;       // not yet, or too late in the morning: skipped, not sent late
            var key = $"digest:{p.TenantId:N}:{p.UserId:N}:{DateOnly.FromDateTime(local):yyyyMMdd}";
            if (await db.Notifications.IgnoreQueryFilters().AnyAsync(n => n.DedupeKey == key, ct)) continue;

            PortfolioBriefDto brief;
            using (var scope = scopes.CreateScope())
            {
                var c = scope.ServiceProvider.GetRequiredService<CurrentContext>();
                c.TenantId = p.TenantId; c.UserId = p.UserId; c.Role = p.Role; c.WorkspaceType = WorkspaceType.Organization;   // an owner or admin: every project of the organization
                brief = await scope.ServiceProvider.GetRequiredService<AiPortfolio>().BriefAsync(null, ct);
            }
            if (brief.Projects == 0) continue;

            var concerns = brief.Ranked.Where(r => r.Score >= 2).Take(3).Select(r => $"{r.Name} ({r.Level}): {r.Reasons.FirstOrDefault() ?? "needs a look"}").ToList();
            var title = brief.AtRisk + brief.Delayed == 0
                ? $"Portfolio this week: all {brief.Projects} project{(brief.Projects == 1 ? "" : "s")} on track"
                : $"Portfolio this week: {brief.Delayed} delayed, {brief.AtRisk} at risk";
            var body = string.Join("\n", brief.Headlines.Take(2).Concat(concerns));
            var n = new Notification
            {
                TenantId = p.TenantId, UserId = p.UserId, Type = NotificationType.PortfolioDigest, CreatedAt = now, Link = "/portfolio",
                Title = title, Body = body.Length > 600 ? body[..600] : body, DedupeKey = key,
            };
            if (await router.ApplyAsync(n, ct)) { db.Notifications.Add(n); sent++; }
        }
        await db.SaveChangesAsync(ct);
        return sent;
    }
}

using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Reminders;

public record ReminderSuggestionDto(Guid Id, string Title, DateTime FireAt, string SourceKind, string? Link, string? Quote, DateTime CreatedAt);

/// <summary>
/// Reminders offered from what people said: a promise in a chat message or an email they sent, or an action item a meeting gave them.
/// Nothing is set without the person: each suggestion waits for one tap (it becomes an ordinary reminder) or a dismissal, and fades once its
/// time has passed. Offering never gets in the way of what triggered it: any failure is logged and ignored.
/// </summary>
public class ReminderSuggestionService(IAppDbContext db, ICurrentContext ctx, AppClock clock, ReminderService reminders, ILogger<ReminderSuggestionService> log)
{
    private const int MaxPending = 50;

    private async Task<(ReminderSettings Settings, string Zone)> PersonAsync(Guid userId, CancellationToken ct)
    {
        var settings = await db.ReminderSettings.AsNoTracking().FirstOrDefaultAsync(s => s.UserId == userId, ct) ?? new ReminderSettings { UserId = userId };
        var zone = await db.Users.AsNoTracking().Where(u => u.Id == userId).Select(u => u.TimeZone).FirstOrDefaultAsync(ct);
        return (settings, ZoneTime.IsKnown(zone) ? zone! : "UTC");
    }

    /// <summary>Offers reminders for the promises the signed-in person made in what they just wrote (chat message, email).</summary>
    public async Task<int> OfferFromTextAsync(string? text, string kind, string sourceKey, string? link, CancellationToken ct = default)
    {
        try
        {
            if (ctx.UserId is not { } me || ctx.TenantId is not { } tenant || string.IsNullOrWhiteSpace(text)) return 0;
            var (settings, zone) = await PersonAsync(me, ct);
            var tz = ZoneTime.Find(zone);
            var promises = PromiseDetector.Find(PromiseDetector.OwnWords(text), ZoneTime.ToLocal(clock.Now, tz), settings.DefaultTime);
            return await AddAsync(tenant, me, zone, promises, kind, sourceKey, link, ct);
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            log.LogWarning("Reminder suggestion from {Kind} not offered ({Error})", kind, e.GetType().Name);
            return 0;
        }
    }

    /// <summary>Offers a reminder to someone for work a meeting gave them, at <paramref name="localAt"/> (their wall-clock time).</summary>
    public async Task<int> OfferAtAsync(Guid tenantId, Guid userId, string task, DateTime localAt, string kind, string sourceKey, string? link, string? quote, CancellationToken ct = default)
    {
        try
        {
            var (_, zone) = await PersonAsync(userId, ct);
            if (localAt <= ZoneTime.ToLocal(clock.Now, ZoneTime.Find(zone))) return 0;
            var title = task.Trim().TrimEnd('.');
            if (title.Length < 3) return 0;
            if (title.Length > 120) title = title[..117] + "…";
            return await AddAsync(tenantId, userId, zone, [new Promise(char.ToUpperInvariant(title[0]) + title[1..], localAt, quote ?? task)], kind, sourceKey, link, ct);
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            log.LogWarning("Reminder suggestion from {Kind} not offered ({Error})", kind, e.GetType().Name);
            return 0;
        }
    }

    private async Task<int> AddAsync(Guid tenant, Guid user, string zone, IReadOnlyList<Promise> promises, string kind, string sourceKey, string? link, CancellationToken ct)
    {
        if (promises.Count == 0) return 0;
        var tz = ZoneTime.Find(zone);
        var pending = await db.ReminderSuggestions.CountAsync(s => s.UserId == user && s.State == "pending" && s.FireAtUtc > clock.Now, ct);
        var added = new List<ReminderSuggestion>();
        for (var i = 0; i < promises.Count && pending + added.Count < MaxPending; i++)
        {
            var p = promises[i];
            var key = $"{sourceKey}:{i}";
            if (key.Length > 120) key = key[..120];
            if (await db.ReminderSuggestions.AnyAsync(s => s.UserId == user && s.SourceKey == key, ct)) continue;
            var row = new ReminderSuggestion
            {
                TenantId = tenant, UserId = user, Title = p.Title, FireAtUtc = ZoneTime.ToUtc(p.LocalAt, tz), TimeZone = zone, LocalAt = ZoneTime.Write(p.LocalAt),
                SourceKind = kind, SourceKey = key, Link = link is { Length: <= 300 } ? link : null, Quote = p.Quote.Length > 300 ? p.Quote[..297] + "…" : p.Quote,
                CreatedAt = clock.Now, CreatedBy = ctx.UserId,
            };
            db.ReminderSuggestions.Add(row);
            added.Add(row);
        }
        if (added.Count == 0) return 0;
        try { await db.SaveChangesAsync(ct); }
        catch (DbUpdateException)
        {
            // The same message offered twice at once: the first one stands. Let go of these rows so later saves in this request are not affected.
            foreach (var row in added) db.ReminderSuggestions.Entry(row).State = EntityState.Detached;
            return 0;
        }
        return added.Count;
    }

    /// <summary>The person's suggestions still worth acting on, soonest first.</summary>
    public async Task<IReadOnlyList<ReminderSuggestionDto>> PendingAsync(CancellationToken ct = default)
    {
        var me = ctx.RequireUserId();
        var cutoff = clock.Now.AddHours(-1);
        return await db.ReminderSuggestions.AsNoTracking().Where(s => s.UserId == me && s.State == "pending" && s.FireAtUtc > cutoff)
            .OrderBy(s => s.FireAtUtc).Take(20)
            .Select(s => new ReminderSuggestionDto(s.Id, s.Title, s.FireAtUtc, s.SourceKind, s.Link, s.Quote, s.CreatedAt)).ToListAsync(ct);
    }

    /// <summary>Makes the suggestion a real reminder (its time, or in five minutes if that has just passed), with what was said as its note.</summary>
    public async Task<ReminderDto> AcceptAsync(Guid id, CancellationToken ct = default)
    {
        var me = ctx.RequireUserId();
        var s = await db.ReminderSuggestions.FirstOrDefaultAsync(x => x.Id == id && x.UserId == me, ct) ?? throw new NotFoundException("Suggestion not found.");
        if (s.State != "pending") throw new ConflictException(s.State == "accepted" ? "This reminder is already set." : "This suggestion was dismissed.", "SUGGESTION_DONE");
        var tz = ZoneTime.Find(s.TimeZone);
        var at = s.FireAtUtc > clock.Now.AddMinutes(1) ? s.LocalAt : ZoneTime.Write(ZoneTime.ToLocal(clock.Now.AddMinutes(5), tz));
        var note = s.Quote is { Length: > 0 } q ? $"You said: “{q}”" : null;
        var reminder = await reminders.CreateAsync(new SaveReminderRequest(s.Title, note, ReminderTarget.None, null, null, new ReminderWhen(at, s.TimeZone, null, null, null), false, true), ct);
        if (s.Link is { } link) await db.Reminders.Where(r => r.Id == reminder.Id).ExecuteUpdateAsync(x => x.SetProperty(r => r.Link, link), ct);
        s.State = "accepted"; s.ReminderId = reminder.Id; s.UpdatedAt = clock.Now; s.UpdatedBy = me;
        await db.SaveChangesAsync(ct);
        return reminder;
    }

    public async Task DismissAsync(Guid id, CancellationToken ct = default)
    {
        var me = ctx.RequireUserId();
        var s = await db.ReminderSuggestions.FirstOrDefaultAsync(x => x.Id == id && x.UserId == me, ct) ?? throw new NotFoundException("Suggestion not found.");
        if (s.State == "pending") { s.State = "dismissed"; s.UpdatedAt = clock.Now; s.UpdatedBy = me; await db.SaveChangesAsync(ct); }
    }
}

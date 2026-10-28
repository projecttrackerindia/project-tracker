using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Platform;

public record HolidayDto(Guid Id, DateOnly Date, string Name, string? Region);
public record AddHolidayRequest(DateOnly? Date, string? Name, string? Region);
/// <summary>Adds a ready list of holidays for a year. <see cref="Country"/>: IN (India) is the one available.</summary>
public record HolidayPresetRequest(string? Country, int? Year);
public record HolidayPresetResultDto(int Added, int AlreadyThere, IReadOnlyList<HolidayDto> Holidays);

/// <summary>
/// Public holidays of the workspace (Settings › Holidays): days nobody is expected to work, so Capacity counts them as days off for
/// everyone. Anyone may read the list; owners and admins keep it. An India preset fills in a year's national and widely observed
/// holidays (the central government's list), to be adjusted for the workspace's own state or offices.
/// </summary>
public class HolidayService(IAppDbContext db, ICurrentContext ctx, AppClock clock, Recorder recorder)
{
    public const int MaxPerYear = 60;

    private void RequireManage()
    {
        if (ctx.ViaApiKey) throw new ForbiddenException("API keys cannot change the holiday list.", "API_KEY_NOT_ALLOWED");
        if (ctx.Role is not (TenantRole.Owner or TenantRole.Admin)) throw new ForbiddenException("Only owners and admins can change the holiday list.", "PERMISSION_DENIED");
    }

    public async Task<IReadOnlyList<HolidayDto>> ListAsync(int? year, CancellationToken ct = default)
    {
        ctx.RequireTenantId();
        var y = year ?? clock.Today.Year;
        if (y is < 2000 or > 2100) throw new ValidationException("year", "Choose a year between 2000 and 2100.");
        var from = new DateOnly(y, 1, 1); var to = new DateOnly(y, 12, 31);
        return await db.Holidays.AsNoTracking().Where(h => h.Date >= from && h.Date <= to).OrderBy(h => h.Date).ThenBy(h => h.Name)
            .Select(h => new HolidayDto(h.Id, h.Date, h.Name, h.Region)).ToListAsync(ct);
    }

    public async Task<HolidayDto> AddAsync(AddHolidayRequest req, CancellationToken ct = default)
    {
        var tid = ctx.RequireTenantId(); RequireManage();
        var date = req.Date ?? throw new ValidationException("date", "Pick the date.");
        var name = (req.Name ?? "").Trim();
        if (name.Length == 0) throw new ValidationException("name", "Name the holiday.");
        if (name.Length > 120) throw new ValidationException("name", "Keep the name to 120 characters.");
        var region = string.IsNullOrWhiteSpace(req.Region) ? null : req.Region.Trim();
        if (region is { Length: > 60 }) throw new ValidationException("region", "Keep the region to 60 characters.");
        if (await db.Holidays.AnyAsync(h => h.Date == date && h.Name == name, ct)) throw new ConflictException("That holiday is already on the list.", "HOLIDAY_EXISTS");
        var from = new DateOnly(date.Year, 1, 1); var to = new DateOnly(date.Year, 12, 31);
        if (await db.Holidays.CountAsync(h => h.Date >= from && h.Date <= to, ct) >= MaxPerYear)
            throw new ValidationException("date", $"A year can have up to {MaxPerYear} holidays.");
        var row = new Holiday { TenantId = tid, Date = date, Name = name, Region = region, CreatedAt = clock.Now, CreatedBy = ctx.UserId };
        db.Holidays.Add(row);
        recorder.Audit("holiday.added", nameof(Holiday), row.Id, newValue: new { date, name, region });
        await db.SaveChangesAsync(ct);
        return new HolidayDto(row.Id, row.Date, row.Name, row.Region);
    }

    public async Task DeleteAsync(Guid id, CancellationToken ct = default)
    {
        ctx.RequireTenantId(); RequireManage();
        var row = await db.Holidays.FirstOrDefaultAsync(h => h.Id == id, ct) ?? throw new NotFoundException("Holiday not found.", "HOLIDAY_NOT_FOUND");
        db.Holidays.Remove(row);
        recorder.Audit("holiday.removed", nameof(Holiday), id, oldValue: new { row.Date, row.Name });
        await db.SaveChangesAsync(ct);
    }

    public async Task<HolidayPresetResultDto> AddPresetAsync(HolidayPresetRequest req, CancellationToken ct = default)
    {
        var tid = ctx.RequireTenantId(); RequireManage();
        var country = (req.Country ?? "IN").Trim().ToUpperInvariant();
        if (country != "IN") throw new ValidationException("country", "Only the India list is available.");
        var year = req.Year ?? clock.Today.Year;
        if (year is < 2000 or > 2100) throw new ValidationException("year", "Choose a year between 2000 and 2100.");
        var from = new DateOnly(year, 1, 1); var to = new DateOnly(year, 12, 31);
        var have = await db.Holidays.Where(h => h.Date >= from && h.Date <= to).Select(h => new { h.Date, h.Name }).ToListAsync(ct);
        var added = 0; var there = 0;
        foreach (var (date, name) in India(year))
        {
            if (have.Any(h => h.Date == date && h.Name == name)) { there++; continue; }
            db.Holidays.Add(new Holiday { TenantId = tid, Date = date, Name = name, CreatedAt = clock.Now, CreatedBy = ctx.UserId });
            added++;
        }
        recorder.Audit("holiday.preset_added", nameof(Holiday), null, newValue: new { country, year, added });
        await db.SaveChangesAsync(ct);
        return new HolidayPresetResultDto(added, there, await ListAsync(year, ct));
    }

    /// <summary>The days off in a window (any weekday or weekend), for capacity.</summary>
    public static async Task<HashSet<DateOnly>> DatesAsync(IAppDbContext db, DateOnly from, DateOnly to, CancellationToken ct) =>
        (await db.Holidays.AsNoTracking().Where(h => h.Date >= from && h.Date <= to).Select(h => h.Date).ToListAsync(ct)).ToHashSet();

    /// <summary>
    /// India: the three national holidays every year, and for the years listed the central government's gazetted festival holidays (their
    /// dates follow the lunar calendar, so they are listed per year). Other years get the national holidays only.
    /// </summary>
    public static IReadOnlyList<(DateOnly Date, string Name)> India(int year)
    {
        var list = new List<(DateOnly Date, string Name)>
        {
            (new DateOnly(year, 1, 26), "Republic Day"),
            (new DateOnly(year, 8, 15), "Independence Day"),
            (new DateOnly(year, 10, 2), "Gandhi Jayanti"),
            (new DateOnly(year, 12, 25), "Christmas"),
        };
        var festivals = year switch
        {
            2026 => new (int M, int D, string Name)[]
            {
                (3, 4, "Holi"), (3, 21, "Id-ul-Fitr"), (3, 26, "Ram Navami"), (3, 31, "Mahavir Jayanti"), (4, 3, "Good Friday"), (5, 1, "Buddha Purnima"),
                (5, 27, "Id-ul-Zuha (Bakrid)"), (6, 26, "Muharram"), (8, 26, "Milad-un-Nabi"), (9, 4, "Janmashtami"), (10, 20, "Dussehra"),
                (11, 8, "Diwali (Deepavali)"), (11, 24, "Guru Nanak Jayanti"),
            },
            2027 => new (int M, int D, string Name)[]
            {
                (3, 10, "Id-ul-Fitr"), (3, 22, "Holi"), (3, 26, "Good Friday"), (4, 15, "Ram Navami"), (4, 19, "Mahavir Jayanti"), (5, 17, "Id-ul-Zuha (Bakrid)"),
                (5, 20, "Buddha Purnima"), (6, 15, "Muharram"), (8, 15, "Milad-un-Nabi"), (8, 25, "Janmashtami"), (10, 9, "Dussehra"), (10, 29, "Diwali (Deepavali)"),
                (11, 14, "Guru Nanak Jayanti"),
            },
            _ => Array.Empty<(int M, int D, string Name)>(),
        };
        list.AddRange(festivals.Select(f => (new DateOnly(year, f.M, f.D), f.Name)));
        // Two festivals can share a date with a national holiday (Milad-un-Nabi on 15 August 2027): both are listed, they are one day off.
        return list.OrderBy(x => x.Date).ToList();
    }
}

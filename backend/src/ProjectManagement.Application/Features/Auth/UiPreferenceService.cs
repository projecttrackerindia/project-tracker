using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;

namespace ProjectManagement.Application.Features.Auth;

public record UiPreferenceDto(string Key, JsonElement? Value, DateTime? UpdatedAt);

/// <summary>A person's own app layout (the sidebar), saved with their account: the app reads it at start and writes it as they change it.</summary>
public class UiPreferenceService(IAppDbContext db, ICurrentContext ctx, AppClock clock)
{
    public static readonly string[] Keys = ["sidebar"];
    public const int MaxLength = 8000;

    private static string Check(string key)
    {
        var k = (key ?? "").Trim().ToLowerInvariant();
        if (!Keys.Contains(k)) throw new NotFoundException("No such layout.");
        return k;
    }

    public async Task<UiPreferenceDto> GetAsync(string key, CancellationToken ct = default)
    {
        var k = Check(key);
        var uid = ctx.RequireUserId();
        var row = await db.UserUiPreferences.AsNoTracking().FirstOrDefaultAsync(p => p.UserId == uid && p.Key == k, ct);
        if (row is null) return new UiPreferenceDto(k, null, null);
        using var doc = JsonDocument.Parse(row.Value);
        return new UiPreferenceDto(k, doc.RootElement.Clone(), row.UpdatedAt);
    }

    public async Task<UiPreferenceDto> SaveAsync(string key, JsonElement? value, CancellationToken ct = default)
    {
        var k = Check(key);
        var uid = ctx.RequireUserId();
        var row = await db.UserUiPreferences.FirstOrDefaultAsync(p => p.UserId == uid && p.Key == k, ct);
        if (value is null || value.Value.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined)
        {
            // Back to the default layout.
            if (row is not null) { db.UserUiPreferences.Remove(row); await db.SaveChangesAsync(ct); }
            return new UiPreferenceDto(k, null, null);
        }
        if (value.Value.ValueKind != JsonValueKind.Object) throw new ValidationException("value", "The layout must be an object.");
        var text = value.Value.GetRawText();
        if (text.Length > MaxLength) throw new ValidationException("value", $"The layout is too large ({MaxLength:N0} characters at most).");
        if (row is null)
        {
            row = new UserUiPreference { UserId = uid, Key = k };
            db.UserUiPreferences.Add(row);
        }
        row.Value = text; row.UpdatedAt = clock.Now;
        try { await db.SaveChangesAsync(ct); }
        catch (DbUpdateException)
        {
            // Two devices saved the first layout at the same moment: the other one's row is there now, so update it instead.
            db.UserUiPreferences.Entry(row).State = EntityState.Detached;
            await db.UserUiPreferences.Where(p => p.UserId == uid && p.Key == k)
                .ExecuteUpdateAsync(u => u.SetProperty(p => p.Value, text).SetProperty(p => p.UpdatedAt, clock.Now), ct);
        }
        return await GetAsync(k, ct);
    }
}

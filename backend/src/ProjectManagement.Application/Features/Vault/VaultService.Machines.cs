using System.Text;
using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Vault;

public record SaveMachineRequest(string? Repository, string? RefPattern, string? Environment, string? Label, string? StepUp);
public record VaultMachineDto(Guid Id, string Provider, string Repository, bool Pinned, string RefPattern, string? Environment, string Label, DateTime CreatedAt, DateTime? LastUsedAt,
    string? LastRun, string Audience, string Endpoint, IReadOnlyList<string> Variables);

/// <summary>
/// Machines (GitHub Actions workflows) allowed to read a guarded collection, from the side of the people who manage it. Adding one needs
/// a fresh two-step check: from then on that repository's runs on the chosen branches can read every value in the collection.
/// </summary>
public partial class VaultService
{
    public const int MaxMachinesPerCollection = 20;
    public static string MachineAudience(Guid tenant) => $"projecttracker-vault:{tenant}";

    private async Task<VaultCollection> MachineCollectionAsync(Guid collectionId, CancellationToken ct)
    {
        var (c, access) = await CollectionAsync(collectionId, VaultAccess.Manage, ct);
        _ = access;
        if (c.Sealed) throw new ConflictException("A sealed collection cannot be read by a machine: only people's own browsers hold its key. Use a guarded collection for pipeline secrets.", "VAULT_SEALED");
        if (c.Kind == VaultCollectionKind.Personal) throw new ValidationException("collection", "A personal vault cannot be read by a machine. Use a shared collection.");
        return c;
    }

    public async Task<IReadOnlyList<VaultMachineDto>> MachinesAsync(Guid collectionId, CancellationToken ct = default)
    {
        await RequireUseAsync(ct);
        var c = await MachineCollectionAsync(collectionId, ct);
        var rows = await db.VaultMachineBindings.AsNoTracking().Where(m => m.CollectionId == c.Id && m.DisabledAt == null).OrderBy(m => m.CreatedAt).ToListAsync(ct);
        var names = await VariableNamesAsync(c.Id, ct);
        return rows.Select(m => MachineDto(m, names)).ToList();
    }

    private VaultMachineDto MachineDto(VaultMachineBinding m, IReadOnlyList<string> names) =>
        new(m.Id, m.Provider, m.Repository, m.RepositoryId != null, m.RefPattern, m.Environment, m.Label, m.CreatedAt, m.LastUsedAt, m.LastRun, MachineAudience(m.TenantId),
            $"/api/v1/machine/github/{m.Id}/secrets", names);

    public async Task<VaultMachineDto> AddMachineAsync(Guid collectionId, SaveMachineRequest req, CancellationToken ct = default)
    {
        await RequireUseAsync(ct);
        var (tid, me) = Who();
        var c = await MachineCollectionAsync(collectionId, ct);
        if (!await stepUp.IsFreshAsync(me, req.StepUp, ct))
            throw new ForbiddenException("Confirm it is you first: this lets a pipeline read every value in the collection.", "STEP_UP_REQUIRED");
        var repo = (req.Repository ?? "").Trim().Trim('/');
        if (repo.StartsWith("https://github.com/", StringComparison.OrdinalIgnoreCase)) repo = repo[19..].Trim('/');
        if (!RepoForm().IsMatch(repo)) throw new ValidationException("repository", "Name the repository as owner/name, for example fivestar/payments-api.");
        var refPattern = string.IsNullOrWhiteSpace(req.RefPattern) ? "refs/heads/main" : req.RefPattern.Trim();
        if (!refPattern.StartsWith("refs/", StringComparison.Ordinal) && refPattern != "*") refPattern = "refs/heads/" + refPattern;
        if (!RefForm().IsMatch(refPattern)) throw new ValidationException("refPattern", "A branch or tag, like main, release/* or refs/tags/v*; or * for any.");
        var env = string.IsNullOrWhiteSpace(req.Environment) ? null : req.Environment.Trim();
        if (env is not null && !EnvForm().IsMatch(env)) throw new ValidationException("environment", "An environment name of letters, digits, spaces, dots, dashes and underscores.");
        if (await db.VaultMachineBindings.CountAsync(m => m.CollectionId == c.Id && m.DisabledAt == null, ct) >= MaxMachinesPerCollection)
            throw new ValidationException("repository", $"A collection can be read by at most {MaxMachinesPerCollection} pipelines.");
        var m = new VaultMachineBinding
        {
            TenantId = tid, CollectionId = c.Id, Repository = repo, RefPattern = refPattern, Environment = env, Label = Clip(req.Label, 80) ?? repo, CreatedAt = clock.Now, CreatedBy = me,
        };
        db.VaultMachineBindings.Add(m);
        recorder.Audit("vault.machine_added", "VaultCollection", c.Id, null, new { collection = c.Name, repository = repo, @ref = refPattern, environment = env });
        db.Activities.Add(new Activity { TenantId = tid, ActorId = me, Action = "vault.machine_added", EntityType = "VaultCollection", EntityId = c.Id,
            Summary = $"GitHub pipeline {repo} ({refPattern}) may read {c.Name}", CreatedAt = clock.Now });
        var who = await NameAsync(me, ct);
        foreach (var u in (await AccessByUserAsync(c, ct)).Where(x => x.Value == VaultAccess.Manage && x.Key != me).Select(x => x.Key))
            await notifications.AddAsync(u, NotificationType.Security, $"{who} let a pipeline read {c.Name}", $"{repo} on {refPattern}{(env is null ? "" : $", environment {env}")}.", $"/vault?c={c.Id}", ct: ct);
        await db.SaveChangesAsync(ct);
        return MachineDto(m, await VariableNamesAsync(c.Id, ct));
    }

    public async Task RemoveMachineAsync(Guid id, CancellationToken ct = default)
    {
        await RequireUseAsync(ct);
        var m = await db.VaultMachineBindings.FirstOrDefaultAsync(x => x.Id == id && x.DisabledAt == null, ct) ?? throw new NotFoundException("Not found.", "VAULT_NOT_FOUND");
        var c = await MachineCollectionAsync(m.CollectionId, ct);
        m.DisabledAt = clock.Now;
        recorder.Audit("vault.machine_removed", "VaultCollection", c.Id, null, new { collection = c.Name, repository = m.Repository });
        await db.SaveChangesAsync(ct);
    }

    [GeneratedRegex("^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})/[A-Za-z0-9._-]{1,100}$")] private static partial Regex RepoForm();
    [GeneratedRegex(@"^(\*|refs/(heads|tags)/[A-Za-z0-9._/*-]{1,180})$")] private static partial Regex RefForm();
    [GeneratedRegex(@"^[A-Za-z0-9._ -]{1,60}$")] private static partial Regex EnvForm();

    /// <summary>The names a pipeline gets, from what is in the collection now (no values).</summary>
    private async Task<IReadOnlyList<string>> VariableNamesAsync(Guid collectionId, CancellationToken ct)
    {
        var items = await db.VaultItems.AsNoTracking().Where(i => i.CollectionId == collectionId && i.DeletedAt == null && !i.Sealed && !i.Decoy)
            .Select(i => new { i.Title, i.Kind, i.FieldsJson }).ToListAsync(ct);
        return items.SelectMany(i => ReadDefs(i.FieldsJson).Where(d => d.Type != "totp").Select(d => EnvName(i.Title, i.Kind, d.Key))).Distinct().OrderBy(n => n, StringComparer.Ordinal).ToList();
    }

    /// <summary>
    /// An item's field as an environment variable: the item's name in capitals with underscores, then the field (STRIPE_API_KEY,
    /// PAYMENTS_DB_PASSWORD). An API key's own key field is just the item's name, so "Stripe secret key" gives STRIPE_SECRET_KEY.
    /// </summary>
    public static string EnvName(string title, VaultItemKind kind, string fieldKey)
    {
        static string Up(string s)
        {
            var sb = new StringBuilder();
            foreach (var ch in s.Normalize(NormalizationForm.FormKD))
            {
                if (System.Globalization.CharUnicodeInfo.GetUnicodeCategory(ch) == System.Globalization.UnicodeCategory.NonSpacingMark) continue;   // accents
                if (char.IsAsciiLetterOrDigit(ch)) sb.Append(char.ToUpperInvariant(ch));
                else if (char.IsLower(ch) || char.IsUpper(ch)) continue;      // letters outside A-Z (after removing accents): dropped
                else if (sb.Length > 0 && sb[^1] != '_') sb.Append('_');
            }
            return sb.ToString().Trim('_');
        }
        var name = Up(title);
        if (name.Length == 0 || char.IsAsciiDigit(name[0])) name = "SECRET_" + name;
        if (kind == VaultItemKind.ApiKey && fieldKey == "key") return name;
        // camelCase field keys (privateKey, connectionString) become PRIVATE_KEY, CONNECTION_STRING
        var field = Up(Regex.Replace(fieldKey, "([a-z0-9])([A-Z])", "$1_$2"));
        return field.Length == 0 ? name : $"{name}_{field}";
    }

    /// <summary>Every value in a guarded collection as variables, for a machine that proved who it is (see <see cref="MachineAccess"/>).</summary>
    internal async Task<IReadOnlyList<(string Name, string Value)>> MachineVariablesAsync(Guid tenant, Guid collectionId, CancellationToken ct)
    {
        var items = await db.VaultItems.IgnoreQueryFilters().AsNoTracking().Where(i => i.TenantId == tenant && i.CollectionId == collectionId && i.DeletedAt == null && !i.Sealed && !i.Decoy)
            .ToListAsync(ct);
        var vars = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var i in items.OrderBy(i => i.CreatedAt))
        {
            Dictionary<string, string> values;
            try { values = await crypto.OpenAsync(tenant, i.Id, i.Cipher, i.WrappedItemKey, i.KeyVersion, ct); }
            catch (Exception e) when (e is System.Security.Cryptography.CryptographicException or FormatException or InvalidOperationException or System.Text.Json.JsonException) { continue; }
            foreach (var d in ReadDefs(i.FieldsJson).Where(d => d.Type != "totp"))
                if (values.TryGetValue(d.Key, out var v) && !string.IsNullOrEmpty(v)) vars.TryAdd(EnvName(i.Title, i.Kind, d.Key), v);
        }
        return vars.Select(kv => (kv.Key, kv.Value)).ToList();
    }
}

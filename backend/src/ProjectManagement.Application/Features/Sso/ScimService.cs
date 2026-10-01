using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Auth;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Sso;

/// <summary>A SCIM error: rendered as a SCIM error document with this HTTP status and optional scimType.</summary>
public class ScimException(int status, string detail, string? scimType = null) : Exception(detail)
{
    public int Status { get; } = status;
    public string? ScimType { get; } = scimType;
}

/// <summary>
/// SCIM 2.0 (RFC 7643/7644) for an organization's identity provider: Users are the organization's members (deactivating or deleting one
/// removes them from the organization, never the account itself), Groups are its Teams. The request runs inside the organization the
/// bearer token belongs to. Only people on the organization's verified domains can be created or added, so provisioning cannot reach
/// accounts the organization does not own. Implements what Microsoft Entra ID, Okta and OneLogin use: eq filters, paging, PATCH.
/// </summary>
public partial class ScimService(IAppDbContext db, ICurrentContext ctx, AppClock clock, Recorder recorder, EntitlementService entitlements,
    WorkspaceProvisioner provisioner, IOptions<AppOptions> options)
{
    public const string UserSchema = "urn:ietf:params:scim:schemas:core:2.0:User";
    public const string GroupSchema = "urn:ietf:params:scim:schemas:core:2.0:Group";
    public const string ListSchema = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
    public const string PatchSchema = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
    private readonly string _base = PublicUrls.ScimBase(options.Value);
    private Guid Tenant => ctx.RequireTenantId();
    private string Provider => $"scim:{Tenant}";

    /// <summary>The organization a SCIM bearer token belongs to (revoked tokens and suspended organizations get nothing).</summary>
    public static async Task<Guid?> AuthenticateAsync(IAppDbContext db, string? bearer, DateTime now, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(bearer) || !bearer.StartsWith("scim_", StringComparison.Ordinal)) return null;
        var hash = ScimTokens.Hash(bearer.Trim());
        var token = await db.ScimTokens.FirstOrDefaultAsync(t => t.TokenHash == hash && t.RevokedAt == null, ct);
        if (token is null) return null;
        if (!await db.Tenants.AnyAsync(t => t.Id == token.TenantId && t.Status == TenantStatus.Active && t.Type == WorkspaceType.Organization, ct)) return null;
        if (token.LastUsedAt is null || now - token.LastUsedAt > TimeSpan.FromMinutes(1)) { token.LastUsedAt = now; await db.SaveChangesAsync(ct); }
        return token.TenantId;
    }

    // ---------------------------------------------------------------- discovery documents

    public JsonObject ServiceProviderConfig() => new()
    {
        ["schemas"] = new JsonArray("urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"),
        ["patch"] = new JsonObject { ["supported"] = true },
        ["bulk"] = new JsonObject { ["supported"] = false, ["maxOperations"] = 0, ["maxPayloadSize"] = 0 },
        ["filter"] = new JsonObject { ["supported"] = true, ["maxResults"] = 200 },
        ["changePassword"] = new JsonObject { ["supported"] = false },
        ["sort"] = new JsonObject { ["supported"] = false },
        ["etag"] = new JsonObject { ["supported"] = false },
        ["authenticationSchemes"] = new JsonArray(new JsonObject { ["type"] = "oauthbearertoken", ["name"] = "Bearer token", ["description"] = "A SCIM token from Workspace settings → Single sign-on." }),
        ["meta"] = new JsonObject { ["resourceType"] = "ServiceProviderConfig", ["location"] = $"{_base}/ServiceProviderConfig" },
    };

    public JsonObject ResourceTypes() => List([
        new JsonObject { ["schemas"] = new JsonArray("urn:ietf:params:scim:schemas:core:2.0:ResourceType"), ["id"] = "User", ["name"] = "User", ["endpoint"] = "/Users", ["schema"] = UserSchema },
        new JsonObject { ["schemas"] = new JsonArray("urn:ietf:params:scim:schemas:core:2.0:ResourceType"), ["id"] = "Group", ["name"] = "Group", ["endpoint"] = "/Groups", ["schema"] = GroupSchema },
    ], 2, 1);

    private static JsonObject List(IEnumerable<JsonObject> items, int total, int start)
    {
        var arr = new JsonArray();
        foreach (var i in items) arr.Add(i);
        return new JsonObject { ["schemas"] = new JsonArray(ListSchema), ["totalResults"] = total, ["startIndex"] = start, ["itemsPerPage"] = arr.Count, ["Resources"] = arr };
    }

    [GeneratedRegex("""^\s*([A-Za-z.]+)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$""", RegexOptions.IgnoreCase)]
    private static partial Regex EqFilter();

    private static (string Attr, string Value)? ParseFilter(string? filter)
    {
        if (string.IsNullOrWhiteSpace(filter)) return null;
        var m = EqFilter().Match(filter);
        if (!m.Success) throw new ScimException(400, "Only filters of the form 'attribute eq \"value\"' are supported.", "invalidFilter");
        return (m.Groups[1].Value.ToLowerInvariant(), m.Groups[2].Value.Replace("\\\"", "\""));
    }

    // ---------------------------------------------------------------- users

    private sealed record Person(User User, bool Active, string? ExternalId);

    /// <summary>Members of the organization, plus people it provisioned and later deactivated (shown with active=false).</summary>
    private IQueryable<Guid> InScope()
    {
        var tid = Tenant; var provider = Provider;
        return db.TenantMembers.Where(m => m.TenantId == tid).Select(m => m.UserId)
            .Union(db.UserLogins.Where(l => l.Provider == provider).Select(l => l.UserId));
    }

    private async Task<Person?> FindAsync(Guid id, CancellationToken ct)
    {
        if (!await InScope().AnyAsync(u => u == id, ct)) return null;
        var user = await db.Users.FirstOrDefaultAsync(u => u.Id == id, ct);
        if (user is null) return null;
        var tid = Tenant; var provider = Provider;
        var active = await db.TenantMembers.AnyAsync(m => m.TenantId == tid && m.UserId == id, ct);
        var external = await db.UserLogins.Where(l => l.Provider == provider && l.UserId == id).Select(l => l.Subject).FirstOrDefaultAsync(ct);
        return new Person(user, active, external == id.ToString() ? null : external);
    }

    private JsonObject UserResource(Person p)
    {
        var parts = p.User.DisplayName.Split(' ', 2, StringSplitOptions.RemoveEmptyEntries);
        var o = new JsonObject
        {
            ["schemas"] = new JsonArray(UserSchema),
            ["id"] = p.User.Id.ToString(),
            ["userName"] = p.User.Email,
            ["displayName"] = p.User.DisplayName,
            ["name"] = new JsonObject { ["formatted"] = p.User.DisplayName, ["givenName"] = parts.ElementAtOrDefault(0) ?? "", ["familyName"] = parts.ElementAtOrDefault(1) ?? "" },
            ["emails"] = new JsonArray(new JsonObject { ["value"] = p.User.Email, ["type"] = "work", ["primary"] = true }),
            ["active"] = p.Active,
            ["meta"] = new JsonObject
            {
                ["resourceType"] = "User", ["location"] = $"{_base}/Users/{p.User.Id}",
                ["created"] = p.User.CreatedAt.ToString("O"), ["lastModified"] = (p.User.UpdatedAt ?? p.User.CreatedAt).ToString("O"),
            },
        };
        if (p.ExternalId is not null) o["externalId"] = p.ExternalId;
        return o;
    }

    public async Task<JsonObject> ListUsersAsync(string? filter, int startIndex, int count, CancellationToken ct = default)
    {
        var f = ParseFilter(filter);
        var ids = InScope();
        var q = db.Users.Where(u => ids.Contains(u.Id));
        if (f is { } eq)
        {
            var provider = Provider;
            q = eq.Attr switch
            {
                "username" or "emails.value" or "emails" => q.Where(u => u.NormalizedEmail == Text.NormalizeEmail(eq.Value)),
                "externalid" => q.Where(u => db.UserLogins.Any(l => l.Provider == provider && l.Subject == eq.Value && l.UserId == u.Id)),
                "id" => Guid.TryParse(eq.Value, out var g) ? q.Where(u => u.Id == g) : q.Where(_ => false),
                "displayname" => q.Where(u => u.DisplayName == eq.Value),
                _ => throw new ScimException(400, $"Filtering on '{eq.Attr}' is not supported.", "invalidFilter"),
            };
        }
        var total = await q.CountAsync(ct);
        start(ref startIndex, ref count);
        var page = await q.OrderBy(u => u.CreatedAt).ThenBy(u => u.Id).Skip(startIndex - 1).Take(count).Select(u => u.Id).ToListAsync(ct);
        var people = new List<JsonObject>();
        foreach (var id in page) if (await FindAsync(id, ct) is { } p) people.Add(UserResource(p));
        return List(people, total, startIndex);

        static void start(ref int s, ref int c) { s = Math.Max(1, s); c = Math.Clamp(c <= 0 ? 100 : c, 0, 200); }
    }

    public async Task<JsonObject> GetUserAsync(Guid id, CancellationToken ct = default) =>
        UserResource(await FindAsync(id, ct) ?? throw new ScimException(404, "User not found."));

    private static string? Str(JsonNode? n) => n is JsonValue v && v.TryGetValue<string>(out var s) && !string.IsNullOrWhiteSpace(s) ? s.Trim() : null;
    private static bool? Bool(JsonNode? n) => n is JsonValue v ? (v.TryGetValue<bool>(out var b) ? b : v.TryGetValue<string>(out var s) && bool.TryParse(s, out var bs) ? bs : null) : null;

    private static string? EmailOf(JsonObject body)
    {
        var userName = Str(body["userName"]);
        if (userName?.Contains('@') == true) return userName;
        if (body["emails"] is JsonArray emails)
            return emails.OfType<JsonObject>().OrderByDescending(e => Bool(e["primary"]) == true).Select(e => Str(e["value"])).FirstOrDefault(v => v?.Contains('@') == true);
        return null;
    }

    private static string? NameOf(JsonObject body)
    {
        var display = Str(body["displayName"]);
        if (display is not null) return display;
        if (body["name"] is JsonObject n)
        {
            if (Str(n["formatted"]) is { } formatted) return formatted;
            var full = string.Join(' ', new[] { Str(n["givenName"]), Str(n["familyName"]) }.Where(x => x is not null));
            return full.Length > 0 ? full : null;
        }
        return null;
    }

    private async Task EnsureVerifiedDomainAsync(string email, CancellationToken ct)
    {
        var domain = SsoPolicy.DomainOf(email);
        var tid = Tenant;
        if (!await db.SsoDomains.AnyAsync(d => d.TenantId == tid && d.Domain == domain && d.VerifiedAt != null, ct))
            throw new ScimException(400, $"{email} is not on one of this organization's verified domains.", "invalidValue");
    }

    public async Task<(JsonObject Resource, bool Created)> CreateUserAsync(JsonObject body, CancellationToken ct = default)
    {
        var email = EmailOf(body) ?? throw new ScimException(400, "userName must be the person's email address.", "invalidValue");
        await EnsureVerifiedDomainAsync(email, ct);
        var tid = Tenant; var provider = Provider;
        var externalId = Str(body["externalId"]);
        var normalized = Text.NormalizeEmail(email);
        var user = await db.Users.FirstOrDefaultAsync(u => u.NormalizedEmail == normalized, ct);
        if (user is not null && await db.TenantMembers.AnyAsync(m => m.TenantId == tid && m.UserId == user.Id, ct))
            throw new ScimException(409, $"{email} is already a member of this organization.", "uniqueness");
        if (externalId is not null && await db.UserLogins.AnyAsync(l => l.Provider == provider && l.Subject == externalId && (user == null || l.UserId != user.Id), ct))
            throw new ScimException(409, "Another user already has this externalId.", "uniqueness");

        var name = NameOf(body) ?? email[..email.IndexOf('@')];
        if (user is null)
        {
            user = new User { Email = email, NormalizedEmail = normalized, DisplayName = Text.Truncate(name, 100)!, PasswordHash = PasswordHashes.None, EmailVerified = true, CreatedAt = clock.Now };
            db.Users.Add(user);
            await provisioner.CreateAsync("Personal Workspace", WorkspaceType.Personal, user.Id, null, $"{user.DisplayName} personal", ct);
        }
        var login = await db.UserLogins.FirstOrDefaultAsync(l => l.Provider == provider && l.UserId == user.Id, ct);
        if (login is null) db.UserLogins.Add(new UserLogin { UserId = user.Id, Provider = provider, Subject = externalId ?? user.Id.ToString(), Email = email, CreatedAt = clock.Now });
        else if (externalId is not null) login.Subject = externalId;
        if (Bool(body["active"]) != false) await AddMemberAsync(user, ct);
        recorder.Audit("scim.user_created", "User", user.Id, newValue: new { email }, tenantId: tid);
        await db.SaveChangesAsync(ct);
        return (await GetUserAsync(user.Id, ct), true);
    }

    private async Task AddMemberAsync(User user, CancellationToken ct)
    {
        var tid = Tenant;
        if (await db.TenantMembers.AnyAsync(m => m.TenantId == tid && m.UserId == user.Id, ct)) return;
        try { await entitlements.EnsureWithinLimitAsync(FeatureKeys.MaxMembers, await db.TenantMembers.CountAsync(m => m.TenantId == tid, ct), 1, ct); }
        catch (PlanLimitException) { throw new ScimException(403, "The organization has no free seats on its plan."); }
        var role = await db.SsoConnections.Where(c => c.TenantId == tid).Select(c => (TenantRole?)c.DefaultRole).FirstOrDefaultAsync(ct) ?? TenantRole.Member;
        db.TenantMembers.Add(new TenantMember { TenantId = tid, UserId = user.Id, Role = role, CreatedAt = clock.Now });
        recorder.Audit("member.provisioned", "TenantMember", user.Id, newValue: new { Via = "scim", Role = role.ToString() }, tenantId: tid);
    }

    /// <summary>Takes the person out of the organization (their account and other workspaces are untouched). The Owner cannot be removed.</summary>
    private async Task RemoveMemberAsync(Guid userId, CancellationToken ct)
    {
        var tid = Tenant;
        var member = await db.TenantMembers.FirstOrDefaultAsync(m => m.TenantId == tid && m.UserId == userId, ct);
        if (member is null) return;
        if (member.Role == TenantRole.Owner) throw new ScimException(400, "The organization's owner cannot be deactivated through provisioning.", "mutability");
        foreach (var report in await db.TenantMembers.Where(m => m.TenantId == tid && m.ReportsToUserId == userId).ToListAsync(ct)) report.ReportsToUserId = member.ReportsToUserId;
        db.ProjectMembers.RemoveRange(await db.ProjectMembers.Where(p => p.UserId == userId).ToListAsync(ct));
        db.TeamMembers.RemoveRange(await db.TeamMembers.Where(p => p.UserId == userId).ToListAsync(ct));
        db.TenantMembers.Remove(member);
        // Sessions signed in through this organization lose it at once (their next request no longer finds the membership).
        recorder.Audit("member.deprovisioned", "TenantMember", userId, newValue: new { Via = "scim" }, tenantId: tid);
    }

    private async Task<Person> ApplyAsync(Guid id, string? name, bool? active, CancellationToken ct)
    {
        var p = await FindAsync(id, ct) ?? throw new ScimException(404, "User not found.");
        if (name is not null && name != p.User.DisplayName) p.User.DisplayName = Text.Truncate(name, 100)!;
        if (active == true && !p.Active) await AddMemberAsync(p.User, ct);
        if (active == false && p.Active) await RemoveMemberAsync(id, ct);
        await db.SaveChangesAsync(ct);
        return (await FindAsync(id, ct))!;
    }

    public async Task<JsonObject> ReplaceUserAsync(Guid id, JsonObject body, CancellationToken ct = default) =>
        UserResource(await ApplyAsync(id, NameOf(body), Bool(body["active"]) ?? true, ct));

    /// <summary>PATCH as Entra ID and Okta send it: "replace active", "replace displayName / name.*", or a value object with those fields.</summary>
    public async Task<JsonObject> PatchUserAsync(Guid id, JsonObject body, CancellationToken ct = default)
    {
        string? name = null; bool? active = null; string? given = null, family = null;
        foreach (var op in Operations(body))
        {
            var kind = Str(op["op"])?.ToLowerInvariant();
            if (kind is not ("replace" or "add")) continue;
            var path = Str(op["path"])?.ToLowerInvariant();
            var value = op["value"];
            void Field(string p, JsonNode? v)
            {
                switch (p)
                {
                    case "active": active = Bool(v); break;
                    case "displayname": name = Str(v); break;
                    case "name.formatted": name = Str(v); break;
                    case "name.givenname": given = Str(v); break;
                    case "name.familyname": family = Str(v); break;
                    case "name" when v is JsonObject n: name = Str(n["formatted"]) ?? name; given = Str(n["givenName"]) ?? given; family = Str(n["familyName"]) ?? family; break;
                }
            }
            if (path is not null) Field(path, value);
            else if (value is JsonObject obj) foreach (var (k, v) in obj) Field(k.ToLowerInvariant(), v);
        }
        if (name is null && (given is not null || family is not null)) name = string.Join(' ', new[] { given, family }.Where(x => x is not null));
        return UserResource(await ApplyAsync(id, name, active, ct));
    }

    private static IEnumerable<JsonObject> Operations(JsonObject body) =>
        (body["Operations"] ?? body["operations"]) is JsonArray ops ? ops.OfType<JsonObject>() : throw new ScimException(400, "A PATCH request needs Operations.", "invalidSyntax");

    public async Task DeleteUserAsync(Guid id, CancellationToken ct = default)
    {
        if (await FindAsync(id, ct) is null) throw new ScimException(404, "User not found.");
        await RemoveMemberAsync(id, ct);
        var provider = Provider;
        db.UserLogins.RemoveRange(await db.UserLogins.Where(l => l.Provider == provider && l.UserId == id).ToListAsync(ct));
        await db.SaveChangesAsync(ct);
    }

    // ---------------------------------------------------------------- groups (= teams)

    private async Task<JsonObject> GroupResource(Team t, CancellationToken ct)
    {
        var members = await (from m in db.TeamMembers join u in db.Users on m.UserId equals u.Id where m.TeamId == t.Id select new { u.Id, u.DisplayName }).ToListAsync(ct);
        var arr = new JsonArray();
        foreach (var m in members) arr.Add(new JsonObject { ["value"] = m.Id.ToString(), ["display"] = m.DisplayName, ["$ref"] = $"{_base}/Users/{m.Id}" });
        return new JsonObject
        {
            ["schemas"] = new JsonArray(GroupSchema), ["id"] = t.Id.ToString(), ["displayName"] = t.Name, ["members"] = arr,
            ["meta"] = new JsonObject { ["resourceType"] = "Group", ["location"] = $"{_base}/Groups/{t.Id}", ["created"] = t.CreatedAt.ToString("O"), ["lastModified"] = (t.UpdatedAt ?? t.CreatedAt).ToString("O") },
        };
    }

    public async Task<JsonObject> ListGroupsAsync(string? filter, int startIndex, int count, CancellationToken ct = default)
    {
        var q = db.Teams.AsQueryable();
        if (ParseFilter(filter) is { } eq)
            q = eq.Attr switch
            {
                "displayname" => q.Where(t => t.Name == eq.Value),
                "id" => Guid.TryParse(eq.Value, out var g) ? q.Where(t => t.Id == g) : q.Where(_ => false),
                _ => throw new ScimException(400, $"Filtering on '{eq.Attr}' is not supported.", "invalidFilter"),
            };
        var total = await q.CountAsync(ct);
        startIndex = Math.Max(1, startIndex); count = Math.Clamp(count <= 0 ? 100 : count, 0, 200);
        var teams = await q.OrderBy(t => t.Name).Skip(startIndex - 1).Take(count).ToListAsync(ct);
        var items = new List<JsonObject>();
        foreach (var t in teams) items.Add(await GroupResource(t, ct));
        return List(items, total, startIndex);
    }

    public async Task<JsonObject> GetGroupAsync(Guid id, CancellationToken ct = default) =>
        await GroupResource(await db.Teams.FirstOrDefaultAsync(t => t.Id == id, ct) ?? throw new ScimException(404, "Group not found."), ct);

    private async Task<List<Guid>> MemberIdsAsync(JsonNode? members, CancellationToken ct)
    {
        var ids = (members as JsonArray)?.OfType<JsonObject>().Select(m => Guid.TryParse(Str(m["value"]), out var g) ? g : Guid.Empty).Where(g => g != Guid.Empty).ToList() ?? [];
        var tid = Tenant;
        var valid = await db.TenantMembers.Where(m => m.TenantId == tid && ids.Contains(m.UserId)).Select(m => m.UserId).ToListAsync(ct);
        return valid;
    }

    public async Task<JsonObject> CreateGroupAsync(JsonObject body, CancellationToken ct = default)
    {
        var name = Str(body["displayName"]) ?? throw new ScimException(400, "displayName is required.", "invalidValue");
        if (await db.Teams.AnyAsync(t => t.Name == name, ct)) throw new ScimException(409, "A team with this name already exists.", "uniqueness");
        try { await entitlements.EnsureWithinLimitAsync(FeatureKeys.MaxTeams, await db.Teams.CountAsync(ct), 1, ct); }
        catch (PlanLimitException) { throw new ScimException(403, "The organization's plan allows no more teams."); }
        var team = new Team { Name = Text.Truncate(name, 80)! };
        db.Teams.Add(team);
        foreach (var uid in await MemberIdsAsync(body["members"], ct)) db.TeamMembers.Add(new TeamMember { TeamId = team.Id, UserId = uid });
        recorder.Audit("scim.group_created", "Team", team.Id, newValue: new { name }, tenantId: Tenant);
        await db.SaveChangesAsync(ct);
        return await GetGroupAsync(team.Id, ct);
    }

    public async Task<JsonObject> ReplaceGroupAsync(Guid id, JsonObject body, CancellationToken ct = default)
    {
        var team = await db.Teams.FirstOrDefaultAsync(t => t.Id == id, ct) ?? throw new ScimException(404, "Group not found.");
        if (Str(body["displayName"]) is { } name) team.Name = Text.Truncate(name, 80)!;
        var wanted = await MemberIdsAsync(body["members"], ct);
        var current = await db.TeamMembers.Where(m => m.TeamId == id).ToListAsync(ct);
        db.TeamMembers.RemoveRange(current.Where(m => !wanted.Contains(m.UserId)));
        foreach (var uid in wanted.Where(u => current.All(m => m.UserId != u))) db.TeamMembers.Add(new TeamMember { TeamId = id, UserId = uid });
        await db.SaveChangesAsync(ct);
        return await GetGroupAsync(id, ct);
    }

    [GeneratedRegex("""^members\[value\s+eq\s+"([^"]+)"\]$""", RegexOptions.IgnoreCase)]
    private static partial Regex MemberPath();

    public async Task<JsonObject> PatchGroupAsync(Guid id, JsonObject body, CancellationToken ct = default)
    {
        var team = await db.Teams.FirstOrDefaultAsync(t => t.Id == id, ct) ?? throw new ScimException(404, "Group not found.");
        foreach (var op in Operations(body))
        {
            var kind = Str(op["op"])?.ToLowerInvariant();
            var path = Str(op["path"]);
            var value = op["value"];
            if (path is null && value is JsonObject obj && Str(obj["displayName"]) is { } dn) { team.Name = Text.Truncate(dn, 80)!; continue; }
            if (string.Equals(path, "displayName", StringComparison.OrdinalIgnoreCase) && Str(value) is { } n) { team.Name = Text.Truncate(n, 80)!; continue; }
            var single = path is null ? null : MemberPath().Match(path);
            if (kind == "remove" && single is { Success: true } && Guid.TryParse(single.Groups[1].Value, out var one))
                db.TeamMembers.RemoveRange(await db.TeamMembers.Where(m => m.TeamId == id && m.UserId == one).ToListAsync(ct));
            else if (string.Equals(path, "members", StringComparison.OrdinalIgnoreCase))
            {
                var ids = await MemberIdsAsync(value, ct);
                var current = await db.TeamMembers.Where(m => m.TeamId == id).ToListAsync(ct);
                if (kind == "add") foreach (var uid in ids.Where(u => current.All(m => m.UserId != u))) db.TeamMembers.Add(new TeamMember { TeamId = id, UserId = uid });
                else if (kind == "remove") db.TeamMembers.RemoveRange(value is null ? current : current.Where(m => ids.Contains(m.UserId)));
                else if (kind == "replace")
                {
                    db.TeamMembers.RemoveRange(current.Where(m => !ids.Contains(m.UserId)));
                    foreach (var uid in ids.Where(u => current.All(m => m.UserId != u))) db.TeamMembers.Add(new TeamMember { TeamId = id, UserId = uid });
                }
            }
        }
        await db.SaveChangesAsync(ct);
        return await GetGroupAsync(id, ct);
    }

    public async Task DeleteGroupAsync(Guid id, CancellationToken ct = default)
    {
        var team = await db.Teams.FirstOrDefaultAsync(t => t.Id == id, ct) ?? throw new ScimException(404, "Group not found.");
        foreach (var p in await db.Projects.Where(p => p.TeamId == id).ToListAsync(ct)) p.TeamId = null;   // projects stay, without a team
        db.TeamMembers.RemoveRange(await db.TeamMembers.Where(m => m.TeamId == id).ToListAsync(ct));
        db.Teams.Remove(team);
        recorder.Audit("scim.group_deleted", "Team", id, oldValue: new { team.Name }, tenantId: Tenant);
        await db.SaveChangesAsync(ct);
    }
}

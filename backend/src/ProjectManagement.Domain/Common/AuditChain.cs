using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using ProjectManagement.Domain.Entities;

namespace ProjectManagement.Domain.Common;

/// <summary>
/// How an audit row is fingerprinted. Each row's hash covers its own content and the previous row's hash, so changing or removing any row changes every
/// hash after it. The time is cut to the microsecond (what every database keeps) so a row hashes the same before and after it is stored.
/// </summary>
public static class AuditChain
{
    public const string Genesis = "";

    public static DateTime Normalize(DateTime at)
    {
        var utc = at.Kind == DateTimeKind.Local ? at.ToUniversalTime() : DateTime.SpecifyKind(at, DateTimeKind.Utc);
        return new DateTime(utc.Ticks - utc.Ticks % 10, DateTimeKind.Utc);
    }

    public static string Compute(AuditLog a, string prevHash)
    {
        var sb = new StringBuilder();
        sb.Append(prevHash).Append('\n').Append(a.TenantId).Append('\n').Append(a.Seq?.ToString(CultureInfo.InvariantCulture)).Append('\n').Append(a.UserId).Append('\n')
          .Append(a.Action).Append('\n').Append(a.EntityType).Append('\n').Append(a.EntityId).Append('\n').Append(a.OldValue).Append('\n').Append(a.NewValue).Append('\n')
          .Append(a.IpAddress).Append('\n').Append(a.UserAgent).Append('\n').Append(Normalize(a.CreatedAt).ToString("yyyy-MM-ddTHH:mm:ss.ffffffZ", CultureInfo.InvariantCulture));
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(sb.ToString()))).ToLowerInvariant();
    }
}
